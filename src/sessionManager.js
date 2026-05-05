'use strict';
/**
 * UNITY-MD — Multi-User Session Manager
 * Handles 99999+ independent WhatsApp sessions
 * Each user gets their own Baileys socket + MongoDB auth state
 */

// ── Suppress noisy Baileys crypto errors from flooding logs ───
const _origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() || '';
  if (s.includes('Bad MAC') || s.includes('Session error') || s.includes('verifyMAC')) return true;
  return _origStderr(chunk, ...args);
};
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
  const msg = args.map(a => (typeof a === 'string' ? a : a?.message || '')).join(' ');
  if (msg.includes('Bad MAC') || msg.includes('Session error') || msg.includes('verifyMAC')) return;
  _origConsoleError(...args);
};

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
} = require('@whiskeysockets/baileys');
const { Boom }     = require('@hapi/boom');
const pino         = require('pino');
const NodeCache    = require('node-cache');
const mongoose     = require('mongoose');
const cfg          = require('../config');
const db           = require('./commands/index');
const { handleMessage, loadPlugins, plugins } = require('./commands/messageHandler');
const { handleGroupJoin, handleGroupLeave }   = require('./commands/groupHandler');
const { autoBehaviors, handleStatus, handleCall } = require('./commands/autoHandler');

const { tgNotify } = require('./telegram/notify');
// clearAllChatsOnStartup removed — was auto-running on every startup and deleting chats unintentionally
const logger       = require('./commands/logger');

// ── Safe newsletter follow — treats Baileys response parse errors as success ──
async function _safeFollow(sock, jid) {
  if (!sock || !jid) return false;
  try {
    await sock.followNewsletter(jid);
    return true;
  } catch (e) {
    const _m = e.message || '';
    if (
      _m.includes('unexpected response structure') ||
      _m.includes('unexpected response') ||
      _m.includes('result is not') ||
      _m.includes('Cannot read') ||
      _m.includes('undefined')
    ) {
      return true; // WA follow succeeded, Baileys just failed to parse response
    }
    return false;
  }
}



// ── Per-user AuthState Schema ─────────────────────────────────
const userAuthSchema = new mongoose.Schema({
  _id:    { type: String },          // userId (phone number)
  key:    { type: String },          // auth key name
  data:   { type: mongoose.Schema.Types.Mixed },
}, { versionKey: false });

const UserAuthState = mongoose.models.UserAuthState ||
  mongoose.model('UserAuthState', userAuthSchema);

// ── Session registry ──────────────────────────────────────────
// Map<userId, { sock, status, connectedAt, retries, msgStore }>
const sessions = new Map();

const STATUS = {
  CONNECTING:  'connecting',
  CONNECTED:   'connected',
  DISCONNECTED:'disconnected',
  PAIRING:     'pairing',
  ERROR:       'error',
};

// ── Per-user MongoDB auth state ───────────────────────────────
async function getUserAuthState(userId) {
  const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');

  const docId = (key) => `${userId}:${key}`;

  const writeData = async (data, key) => {
    await UserAuthState.findByIdAndUpdate(
      docId(key),
      { _id: docId(key), key, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) },
      { upsert: true }
    );
  };

  const readData = async (key) => {
    try {
      const doc = await UserAuthState.findById(docId(key)).lean();
      return doc ? JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver) : null;
    } catch { return null; }
  };

  const removeData = async (key) => {
    await UserAuthState.deleteOne({ _id: docId(key) });
  };

  const creds = await readData('creds') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          // Batch read all keys at once instead of individual queries
          const docIds = ids.map(id => `${userId}:${type}-${id}`);
          try {
            const docs = await UserAuthState.find({ _id: { $in: docIds } }).lean();
            const docMap = {};
            for (const d of docs) docMap[d._id] = d;
            for (const id of ids) {
              const doc = docMap[`${userId}:${type}-${id}`];
              if (!doc) { result[id] = undefined; continue; }
              let value = JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              result[id] = value;
            }
          } catch {
            // fallback: individual reads
            await Promise.all(ids.map(async (id) => {
              result[id] = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && result[id]) {
                result[id] = proto.Message.AppStateSyncKeyData.fromObject(result[id]);
              }
            }));
          }
          return result;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key   = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
}

// ── Create / start a session for a user ──────────────────────
async function startSession(userId, onUpdate) {
  // Don't double-start
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    if (existing.status === STATUS.CONNECTED || existing.status === STATUS.PAIRING) {
      return existing;
    }
  }

  const session = {
    userId,
    sock:       null,
    status:     STATUS.CONNECTING,
    pairCode:   null,
    connectedAt:null,
    retries:    0,
    msgStore:   new Map(),
    retryCache: new NodeCache(),
  };
  sessions.set(userId, session);

  async function connect() {
    try {
      const { state, saveCreds } = await getUserAuthState(userId);
      // Fallback version if network request fails (e.g. Railway restrictions)
      let version;
      try {
        const vResult = await fetchLatestBaileysVersion();
        version = vResult.version;
      } catch (e) {
        logger.warn(`[SESSION] fetchLatestBaileysVersion failed, using fallback: ${e.message}`);
        version = [2, 3000, 1015901307]; // stable fallback version
      }
      const silentLogger         = pino({ level: 'silent' });

      const sock = makeWASocket({
        version,
        logger: silentLogger,
        msgRetryCounterCache: session.retryCache,

        // ── KEY FIX: false prevents Signal prekey storm on connect ──
        // true causes bot to negotiate Signal sessions for EVERY chat at once
        // → "Closing open session in favor of incoming prekey bundle" flood
        syncFullHistory:       false,

        maxMsgRetryCount:      2,           // fewer retries = less prekey churn
        connectTimeoutMs:      60000,        // longer timeout = stable connect
        keepAliveIntervalMs:   20000,        // more frequent keepalive
        retryRequestDelayMs:   500,          // slightly slower retry = less flood
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect:   false,
        printQRInTerminal:     false,
        fireInitQueries:       true,
        emitOwnEvents:         false,

        auth: {
          creds: state.creds,
          keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
        },

        // ── KEY FIX: return undefined (not empty proto) for unknown msgs ──
        // Returning empty proto tells Baileys the message exists → no retry
        // Returning undefined tells Baileys to request retry from sender (correct)
        getMessage: async (key) => {
          const stored = session.msgStore.get(key.id);
          return stored || undefined;
        },

        browser: ['Ubuntu', 'Chrome', '130.0.0'],
      });

      session.sock = sock;
      sock.sessionOwner = userId; // per-session isolation
      sock._chatJids   = new Set(); // all known chat JIDs
      sock._lastMsgMap = {};        // jid -> { key, messageTimestamp }

      // ── Polyfill: sock.downloadMediaMessage ───────────────
      // Many plugins call sock.downloadMediaMessage(msg) but Baileys
      // removed this method — it's now a standalone import.
      // Patching it here fixes all plugins at once.
      // NOTE: reuploadRequest intentionally omitted — sock.updateMediaMessage
      // triggers config.getConfigFromSocket internally which causes crashes.
      {
        const { downloadMediaMessage: _dlMedia } = require('@whiskeysockets/baileys');
        sock.downloadMediaMessage = (msg) => _dlMedia(msg, 'buffer', {}, {
          logger: {
            info: () => {}, error: () => {}, warn: () => {},
            child: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
            debug: () => {},
          },
        });
      }

      // ── Track chat JIDs from every possible event ──────────
      const trackJid = (jid) => {
        if (jid && typeof jid === 'string' && !jid.endsWith('@broadcast')) {
          sock._chatJids.add(jid);
        }
      };
      sock.ev.on('chats.set', ({ chats }) => {
        sock._chatList = chats || [];
        for (const c of (chats || [])) {
          trackJid(c.id);
          const msgs = c.messages || [];
          if (msgs.length > 0) {
            const lm = msgs[msgs.length - 1];
            if (lm?.key) sock._lastMsgMap[c.id] = { key: lm.key, messageTimestamp: lm.messageTimestamp };
          }
        }
      });
      sock.ev.on('chats.upsert', (newChats) => {
        for (const c of (newChats || [])) trackJid(c.id);
      });
      sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of (messages || [])) {
          const jid = msg?.key?.remoteJid;
          trackJid(jid);
          if (jid && msg?.messageTimestamp) {
            sock._lastMsgMap[jid] = { key: msg.key, messageTimestamp: msg.messageTimestamp };
          }
        }
      });
      sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of (contacts || [])) trackJid(c.id);
      });

      // ── Connection events ──────────────────────────────────
      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

        // Generate pair code when connecting + not yet registered
        if ((connection === 'connecting' || !!qr) && !sock.authState.creds.registered && !session.pairCode) {
          session.status = STATUS.PAIRING;
          if (onUpdate) onUpdate(userId, { status: STATUS.PAIRING });
          // Small delay to let socket stabilize before requesting pair code
          setTimeout(async () => {
            if (sock.authState.creds.registered || session.pairCode) return;
            try {
              const cleanNum = userId.replace(/[^0-9]/g, '');
              const code = await sock.requestPairingCode(cleanNum);
              session.pairCode = code?.match(/.{1,4}/g)?.join('-') || code;
              logger.info(`[SESSION] Pair code for ${userId}: ${session.pairCode}`);
              if (onUpdate) onUpdate(userId, { status: STATUS.PAIRING, pairCode: session.pairCode });
            } catch (e) {
              logger.error(`[SESSION] Pair code error for ${userId}: ${e.message}`);
              // Retry once after 5 seconds
              setTimeout(async () => {
                if (sock.authState.creds.registered || session.pairCode) return;
                try {
                  const cleanNum = userId.replace(/[^0-9]/g, '');
                  const code = await sock.requestPairingCode(cleanNum);
                  session.pairCode = code?.match(/.{1,4}/g)?.join('-') || code;
                  if (onUpdate) onUpdate(userId, { status: STATUS.PAIRING, pairCode: session.pairCode });
                } catch (e2) {
                  logger.error(`[SESSION] Pair code retry failed for ${userId}: ${e2.message}`);
                }
              }, 5000);
            }
          }, 3000);
        }

        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
          session.status = STATUS.DISCONNECTED;
          if (onUpdate) onUpdate(userId, { status: STATUS.DISCONNECTED, reason });

          // If this was a manual stop/restart, do NOT clear auth — just exit
          if (session._manualStop) {
            logger.info(`[SESSION] ${userId} closed intentionally — auth preserved`);
            return;
          }

          const noRetry = [
            DisconnectReason.loggedOut,
            DisconnectReason.forbidden,
            // NOTE: badSession removed — Railway restarts cause false badSession codes.
            // Only truly permanent disconnects should clear auth.
          ];

          if (noRetry.includes(reason)) {
            logger.warn(`[SESSION] ${userId} logged out/forbidden — clearing session`);
            await clearUserSession(userId);
            if (onUpdate) onUpdate(userId, { status: STATUS.ERROR, reason });
          } else {
            // ── Always retry — never give up on a paired session ──
            // WA stays linked even if bot disconnects temporarily.
            // Cap at 120s between retries after first 10 attempts.
            session.retries++;
            const delay = session.retries <= 10
              ? Math.min(5000 + session.retries * 8000, 90000)
              : 120000; // retry every 2 min indefinitely
            logger.info(`[SESSION] ${userId} reconnecting in ${Math.round(delay/1000)}s (retry ${session.retries})`);
            setTimeout(() => connect(), delay);
          }
        }

        if (connection === 'open') {
          session.status     = STATUS.CONNECTED;
          session.pairCode   = null;
          session.connectedAt= new Date();
          session.retries    = 0;
          logger.success(`[SESSION] ${userId} connected ✅`);
          if (onUpdate) onUpdate(userId, { status: STATUS.CONNECTED, number: userId });

          // ── Mode is now read from DB per-session in checkMode() ─
          // setBotMode() was removed because it set a global variable
          // that caused all sessions to share the same mode.

          // ── Auto join group + startup msg — ONCE ONLY per session ──
          if (!session.startupDone) {
            session.startupDone = true;
            setTimeout(async () => {
              const moment = require('moment-timezone');
              const now = moment().tz(cfg.timezone || 'Asia/Colombo');
              // Use sock.user?.id to get the real JID (avoids :XX suffix issues)
              const rawBotJid = sock.user?.id || (userId + '@s.whatsapp.net');
              const botJid = rawBotJid.includes('@') ? rawBotJid.replace(/:\d+@/, '@') : rawBotJid + '@s.whatsapp.net';

              // ── DB Stats for startup ───────────────────────────────
              let _totalUsers = 0, _pairedUsers = 0, _bannedUsers = 0, _totalGroups = 0, _activeToday = 0;
              try {
                const _since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
                [_totalUsers, _pairedUsers, _bannedUsers, _totalGroups, _activeToday] = await Promise.all([
                  db.User.countDocuments(),
                  db.User.countDocuments({ isPaired: true }),
                  db.User.countDocuments({ isBanned: true }),
                  db.Group.countDocuments(),
                  db.User.countDocuments({ lastCommand: { $gte: _since24h } }),
                ]);
              } catch (e) {}

              const _uptime = process.uptime();
              const _uptimeStr = _uptime < 60
                ? `${Math.floor(_uptime)}s`
                : _uptime < 3600
                  ? `${Math.floor(_uptime / 60)}m ${Math.floor(_uptime % 60)}s`
                  : `${Math.floor(_uptime / 3600)}h ${Math.floor((_uptime % 3600) / 60)}m`;
              const _mem = process.memoryUsage();
              const _ramMB = (_mem.rss / 1024 / 1024).toFixed(1);
              const _heapMB = (_mem.heapUsed / 1024 / 1024).toFixed(1);
              const _ramPct = Math.min(Math.round((_mem.rss / 1024 / 1024) / 512 * 10), 10);
              const _bar = (n, t) => '█'.repeat(n) + '░'.repeat(t - n);

              const startupMsg =
                `┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  🧲  *UNITY-MD ACTIVATED*  🧩  ┃\n` +
                `┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                `╭──────────────────────────╮\n` +
                `│  📡  *CONNECTION INFO*\n` +
                `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                `│  👤  *Number :*  +${userId}\n` +
                `│  📅  *Date   :*  ${now.format('ddd, DD MMM YYYY')}\n` +
                `│  🕐  *Time   :*  ${now.format('HH:mm:ss')} (SL)\n` +
                `│  ⏱️  *Uptime :*  ${_uptimeStr}\n` +
                `╰──────────────────────────╯\n\n` +
                `╭──────────────────────────╮\n` +
                `│  💻  *SYSTEM STATUS*\n` +
                `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                `│  🧠  *RAM :*  ${_ramMB} MB\n` +
                `│  ▕${_bar(_ramPct, 10)}▏  ${_ramPct * 10}%\n` +
                `│  📦  *Heap:*  ${_heapMB} MB\n` +
                `│  ⚙️  *Node:*  ${process.version}\n` +
                `│  📲  *Cmds:*  ${plugins.size}+\n` +
                `╰──────────────────────────╯\n\n` +
                `╭──────────────────────────╮\n` +
                `│  🗄️  *DATABASE*\n` +
                `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                `│  👥  *Total Users  :*  ${_totalUsers}\n` +
                `│  🔗  *Paired       :*  ${_pairedUsers}\n` +
                `│  ⚡  *Active (24h) :*  ${_activeToday}\n` +
                `│  🚫  *Banned       :*  ${_bannedUsers}\n` +
                `│  👥  *Groups       :*  ${_totalGroups}\n` +
                `╰──────────────────────────╯\n\n` +
                `╭──────────────────────────╮\n` +
                `│  ✅  *STATUS*\n` +
                `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                `│  🟢  Bot is *ONLINE* & ready\n` +
                `│  🔑  Prefix: *.* or */\n` +
                `│  💡  Type *.menu* for commands\n` +
                `╰──────────────────────────╯\n\n` +
                `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n` +
                `❪❪ UNITY-MD ❫❫ | ® UNITY TEAM`;

              // ── STEP 1: Follow channel ──────────────────────────────
              {
                const _fOk = await _safeFollow(sock, '120363419201971095@newsletter');
                if (_fOk) logger.info(`[SESSION] ${userId} followed channel`);
                else logger.warn(`[SESSION] ${userId} channel follow failed`);
              }

              // ── STEP 2: Join group ──────────────────────────────────
              let groupJid = process.env.AUTO_JOIN_GROUP_JID || '';
              const groupLink = process.env.AUTO_JOIN_GROUP_LINK || '';
              if (groupLink) {
                try {
                  const code = groupLink.split('/').pop()?.split('?')[0];
                  if (code) {
                    // ── groupGetInviteInfo FIRST (fails if bot already joined) ──
                    if (!groupJid) {
                      const info = await sock.groupGetInviteInfo(code).catch(() => null);
                      if (info?.id) {
                        groupJid = info.id;
                      }
                    }

                    // ── Join (ok to fail if already member) ──────────────────
                    await sock.groupAcceptInvite(code).catch(() => {});

                    // ── Fallback: scan joined groups if JID still unknown ─────
                    if (!groupJid) {
                      try {
                        const joined = await sock.groupFetchAllParticipating();
                        // Match by invite code in group invite URL
                        for (const [jid, meta] of Object.entries(joined || {})) {
                          try {
                            const inv = await sock.groupInviteCode(jid).catch(() => null);
                            if (inv && inv === code) { groupJid = jid; break; }
                          } catch {}
                        }
                      } catch {}
                    }

                    if (groupJid) {
                      // Global හා env ට save — messageHandler auto-add ට use වෙනවා
                      global.autoJoinGroupJid = groupJid;
                      process.env.AUTO_JOIN_GROUP_JID = groupJid;
                      logger.info(`[SESSION] ${userId} group JID resolved: ${groupJid}`);
                    } else {
                      logger.warn(`[SESSION] Could not resolve group JID from link`);
                    }
                  }
                } catch (e) {
                  logger.warn(`[SESSION] Group join failed: ${e.message}`);
                }
              }
              // groupLink නැතිව direct JID set කරලා ඇත්නම් global ට දාන්න
              if (groupJid && !global.autoJoinGroupJid) {
                global.autoJoinGroupJid = groupJid;
              }

              // ── STEP 3: Startup OR Restart message ─────────────────
              // langSet=true  → bot was active before → RESTART message
              // langSet=false → first time            → ACTIVATION + lang select
              try {
                const db     = require('./commands/index');
                const botCfg = await db.getBotConfig(userId);

                if (botCfg.langSet) {
                  // ══════════════════════════════════════════════
                  //  🔄  RESTART MESSAGE  (previously active bot)
                  // ══════════════════════════════════════════════
                  const uptime   = process.uptime();
                  const uptimeStr = uptime < 60
                    ? `${Math.floor(uptime)}s`
                    : uptime < 3600
                      ? `${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`
                      : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

                  const bar  = (n, total, fill = '█', empty = '░') =>
                    fill.repeat(n) + empty.repeat(total - n);
                  const mem  = process.memoryUsage();
                  const ramMB = (mem.rss / 1024 / 1024).toFixed(1);
                  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
                  const ramPct   = Math.min(Math.round((mem.rss / 1024 / 1024) / 512 * 10), 10);
                  const ramBar   = bar(ramPct, 10);

                  // ── DB Stats ──────────────────────────────────────
                  let rTotalUsers = 0, rPairedUsers = 0, rBannedUsers = 0, rTotalGroups = 0, rActiveToday = 0;
                  try {
                    const rSince24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
                    [rTotalUsers, rPairedUsers, rBannedUsers, rTotalGroups, rActiveToday] = await Promise.all([
                      db.User.countDocuments(),
                      db.User.countDocuments({ isPaired: true }),
                      db.User.countDocuments({ isBanned: true }),
                      db.Group.countDocuments(),
                      db.User.countDocuments({ lastCommand: { $gte: rSince24h } }),
                    ]);
                  } catch (e) {}

                  const restartMsg =
                    `┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                    `┃  🔄  *UNITY-MD RESTARTED*  🔄  ┃\n` +
                    `┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                    `╭──────────────────────────╮\n` +
                    `│  📡  *CONNECTION INFO*\n` +
                    `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                    `│  👤  *Number :*  +${userId}\n` +
                    `│  📅  *Date   :*  ${now.format('ddd, DD MMM YYYY')}\n` +
                    `│  🕐  *Time   :*  ${now.format('HH:mm:ss')} (SL)\n` +
                    `│  ⏱️  *Uptime :*  ${uptimeStr}\n` +
                    `╰──────────────────────────╯\n\n` +
                    `╭──────────────────────────╮\n` +
                    `│  💻  *SYSTEM STATUS*\n` +
                    `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                    `│  🧠  *RAM :*  ${ramMB} MB\n` +
                    `│  ▕${ramBar}▏  ${ramPct * 10}%\n` +
                    `│  📦  *Heap:*  ${heapMB} MB\n` +
                    `│  ⚙️  *Node:*  ${process.version}\n` +
                    `│  📲  *Cmds:*  ${plugins.size}+\n` +
                    `╰──────────────────────────╯\n\n` +
                    `╭──────────────────────────╮\n` +
                    `│  🗄️  *DATABASE*\n` +
                    `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                    `│  👥  *Total Users  :*  ${rTotalUsers}\n` +
                    `│  🔗  *Paired       :*  ${rPairedUsers}\n` +
                    `│  ⚡  *Active (24h) :*  ${rActiveToday}\n` +
                    `│  🚫  *Banned       :*  ${rBannedUsers}\n` +
                    `│  👥  *Groups       :*  ${rTotalGroups}\n` +
                    `╰──────────────────────────╯\n\n` +
                    `╭──────────────────────────╮\n` +
                    `│  ✅  *STATUS*\n` +
                    `│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
                    `│  🟢  Bot is *ONLINE* & ready\n` +
                    `│  🔑  Prefix: *.* or */\n` +
                    `│  💡  Type *.menu* for commands\n` +
                    `╰──────────────────────────╯\n\n` +
                    `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n` +
                    `❪❪ UNITY-MD ❫❫ | ® UNITY TEAM`;

                  // ── TG Notify only on restart (no WhatsApp inbox message/voice) ──
                  logger.info(`[SESSION] Restart detected for +${userId} — sending TG notify only`);
                  {
                    const _upSec = process.uptime();
                    const _upStr = _upSec < 60
                      ? `${Math.floor(_upSec)}s`
                      : _upSec < 3600
                        ? `${Math.floor(_upSec / 60)}m ${Math.floor(_upSec % 60)}s`
                        : `${Math.floor(_upSec / 3600)}h ${Math.floor((_upSec % 3600) / 60)}m`;
                    const _mem    = process.memoryUsage();
                    const _ramMB  = (_mem.rss / 1024 / 1024).toFixed(1);
                    const _heapMB = (_mem.heapUsed / 1024 / 1024).toFixed(1);
                    const _ramPct = Math.min(Math.round((_mem.rss / 1024 / 1024) / 512 * 100), 100);
                    const _bar    = (n, t) => '█'.repeat(Math.round(n/10)) + '░'.repeat(t - Math.round(n/10));
                    const _ramBar = _bar(_ramPct, 10);

                    // DB stats
                    let _tUsers = 0, _tPaired = 0, _tBanned = 0, _tGroups = 0, _tActive = 0;
                    try {
                      const _since = new Date(Date.now() - 24 * 60 * 60 * 1000);
                      [_tUsers, _tPaired, _tBanned, _tGroups, _tActive] = await Promise.all([
                        db.User.countDocuments(),
                        db.User.countDocuments({ isPaired: true }),
                        db.User.countDocuments({ isBanned: true }),
                        db.Group.countDocuments(),
                        db.User.countDocuments({ lastCommand: { $gte: _since } }),
                      ]);
                    } catch (_e) {}

                    const _tgRestartMsg =
                      `🔄 <b>UNITY-MD — BOT RESTARTED ✅</b>\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                      `📡 <b>CONNECTION INFO</b>\n` +
                      `├ 📱 <b>Number:</b> <code>+${userId}</code>\n` +
                      `├ 📅 <b>Date:</b> ${now.format('ddd, DD MMM YYYY')}\n` +
                      `├ 🕐 <b>Time:</b> ${now.format('HH:mm:ss')} (SL)\n` +
                      `└ ⏱️ <b>Uptime:</b> ${_upStr}\n\n` +
                      `💻 <b>SYSTEM STATUS</b>\n` +
                      `├ 🧠 <b>RAM:</b> ${_ramMB} MB\n` +
                      `├ ▕${_ramBar}▏ ${_ramPct}%\n` +
                      `├ 📦 <b>Heap:</b> ${_heapMB} MB\n` +
                      `├ ⚙️ <b>Node:</b> ${process.version}\n` +
                      `└ 📲 <b>Cmds:</b> ${plugins ? plugins.size : '?'}+\n\n` +
                      `🗄️ <b>DATABASE</b>\n` +
                      `├ 👥 <b>Total Users:</b> ${_tUsers}\n` +
                      `├ 🔗 <b>Paired:</b> ${_tPaired}\n` +
                      `├ ⚡ <b>Active (24h):</b> ${_tActive}\n` +
                      `├ 🚫 <b>Banned:</b> ${_tBanned}\n` +
                      `└ 👥 <b>Groups:</b> ${_tGroups}\n\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                      `<i>❪❪ UNITY-MD ❫❫ | ® UNITY TEAM</i>`;
                    tgNotify(_tgRestartMsg).catch(() => {});
                  }

                } else {
                  // ══════════════════════════════════════════════
                  //  🧲  FIRST-TIME ACTIVATION MESSAGE
                  // ══════════════════════════════════════════════
                  const _THUMB = 'https://i.ibb.co/W4zwVktH/1777104289725.jpg';
                  const _AUDIO = 'https://files.catbox.moe/zmkssv.mp3';
                  const _sCh = '120363419201971095@newsletter';
                  const _sUrl = `https://whatsapp.com/channel/120363419201971095`;

                  // 1) Image + startup text — forwarded from channel style
                  await sock.sendMessage(botJid, {
                    image: { url: _THUMB },
                    caption: startupMsg,
                    contextInfo: {
                    isForwarded: true,
                    forwardingScore: 1,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid:   '120363419201971095@newsletter',
                      newsletterName:  'UNITY-MD',
                      serverMessageId: -1,
                    },
                  },
                  }).catch(() => sock.sendMessage(botJid, { text: startupMsg }).catch(() => {}));

                  // 2) Audio — local OGG Opus file (WhatsApp PTT format)
                  try {
                    const fs   = require('fs');
                    const path = require('path');
                    const audioBuffer = fs.readFileSync(
                      path.join(__dirname, 'media', 'startup_voice.ogg')
                    );
                    await sock.sendMessage(botJid, {
                      audio: audioBuffer,
                      mimetype: 'audio/ogg; codecs=opus',
                      ptt: true,
                    });
                  } catch (e) {
                    logger.warn(`[SESSION] Audio send failed: ${e.message}`);
                  }

                  // 3) Follow newsletter
                  await _safeFollow(sock, _sCh);

                  logger.info(`[SESSION] Startup message sent to own inbox (+${userId})`);

                  // ── TG Notify: first-time activation ─────────────────────
                  {
                    const _mem  = process.memoryUsage();
                    const _ram  = (_mem.rss / 1024 / 1024).toFixed(1);
                    const _tgStartMsg =
                      `🟢 <b>UNITY-MD — NEW BOT CONNECTED! ✅</b>\n` +
                      `━━━━━━━━━━━━━━━━━━━━\n` +
                      `📱 <b>Number:</b> <code>+${userId}</code>\n` +
                      `🧠 <b>RAM:</b> ${_ram} MB\n` +
                      `⚙️ <b>Node:</b> ${process.version}\n` +
                      `📅 <b>Date:</b> ${now.format('DD/MM/YYYY HH:mm:ss')} (SL)\n` +
                      `━━━━━━━━━━━━━━━━━━━━\n` +
                      `💡 First-time activation — language select sent.\n` +
                      `<i>❪❪ UNITY-MD ❫❫ | ® UNITY TEAM</i>`;
                    tgNotify(_tgStartMsg).catch(() => {});
                  }

                  // Lang select (first time only)
                  await new Promise(r => setTimeout(r, 3000));
                  const { sendButtons } = require('./commands/helper');
                  await sendButtons(sock, botJid, {
                    text:
                      `╔══════════════════════════╗\n` +
                      `║  🌐  *LANGUAGE SELECT*  🌐  ║\n` +
                      `╚══════════════════════════╝\n\n` +
                      `🌍 Select your bot language:\n` +
                      `භාෂාව තෝරන්න:\n` +
                      `மொழியை தேர்ந்தெடுக்கவும்:\n\n` +
                      `⚠️ *All commands are blocked until you select a language!*\n\n` +
                      `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n` +
                      `❪❪ UNITY-MD ❫❫ | ® UNITY TEAM`,
                    footer: `❪❪ UNITY-MD ❫❫ | ® UNITY TEAM`,
                    buttons: [
                      { label: '🇬🇧 English', id: '.__setlang en' },
                      { label: '🇱🇰 සිංහල',  id: '.__setlang si' },
                      { label: '🇱🇰 தமிழ்',   id: '.__setlang ta' },
                    ],
                  });
                  logger.info(`[SESSION] Language select sent to ${userId}`);
                }
              } catch (e) {
                logger.warn(`[SESSION] Startup/restart message failed: ${e.message}`);
              }
            }, 5000);
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // ── Messages ───────────────────────────────────────────
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (!msg.message) continue;
          if (msg.key?.id) {
            session.msgStore.set(msg.key.id, msg.message);
            if (session.msgStore.size > 2000) {
              const firstKey = session.msgStore.keys().next().value;
              session.msgStore.delete(firstKey);
            }
          }

          // ── Antidelete: catch "delete for everyone" (protocolMessage REVOKE) ──
          const proto = msg.message?.protocolMessage;
          if (proto?.type === 0 && proto?.key) {
            try {
              const fs = require('fs');
              const path = require('path');
              const dataDir = path.join(process.cwd(), 'data');
              const sid = sock.sessionOwner || 'default';
              const stateFile = path.join(dataDir, `${sid}_antidelete.json`);
              const fallbackFile = path.join(dataDir, 'antidelete.json');
              let state = { enabled: true };
              try {
                const sf = fs.existsSync(stateFile) ? stateFile : fallbackFile;
                if (fs.existsSync(sf)) state = JSON.parse(fs.readFileSync(sf, 'utf8'));
              } catch {}

              if (state.enabled) {
                const deletedKey  = proto.key;
                const chatJid     = msg.key.remoteJid || '';

                // Skip status@broadcast deletes — those are handled by handleStatus
                if (chatJid === 'status@broadcast') continue;

                const isGroupChat = chatJid.endsWith('@g.us');
                const storedMsg   = session.msgStore.get(deletedKey.id);
                const botJid      = sock.user?.id?.replace(/:\d+@/, '@') || '';

                if (botJid) {
                  // DM: key.participant is always null in Baileys DM events.
                  // Use proto.key.fromMe to detect who deleted the message.
                  let deleterJid;
                  if (isGroupChat) {
                    deleterJid = msg.key.participant || chatJid;
                  } else {
                    deleterJid = proto.key.fromMe ? (sock.user?.id || chatJid) : chatJid;
                  }

                  const deleterNum = deleterJid.split('@')[0].split(':')[0];
                  const chatNum    = chatJid.split('@')[0].split(':')[0];
                  const chatLabel  = isGroupChat ? `Group: ${chatJid}` : `DM: +${chatNum}`;

                  let notifyText =
                    `🗑️ *Antidelete Alert*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `👤 *Deleted by:* +${deleterNum}\n` +
                    `📍 *Chat:* ${chatLabel}\n` +
                    `🕐 *Time:* ${new Date().toLocaleString('en-LK', { timeZone: 'Asia/Colombo' })}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n`;

                  if (storedMsg) {
                    // Forward the original deleted message content
                    const textContent =
                      storedMsg.conversation ||
                      storedMsg.extendedTextMessage?.text ||
                      storedMsg.imageMessage?.caption ||
                      storedMsg.videoMessage?.caption ||
                      '';

                    if (textContent) notifyText += `💬 *Message:* ${textContent}\n━━━━━━━━━━━━━━━━━━━━━━\n`;

                    await sock.sendMessage(botJid, { text: notifyText }).catch(() => {});

                    // Try forwarding media if present
                    const mediaTypes = ['imageMessage','videoMessage','audioMessage','stickerMessage','documentMessage'];
                    for (const mtype of mediaTypes) {
                      if (storedMsg[mtype]) {
                        try {
                          await sock.sendMessage(botJid, {
                            forward: { key: deletedKey, message: storedMsg },
                          }).catch(() => {});
                        } catch {}
                        break;
                      }
                    }
                  } else {
                    notifyText += `⚠️ _Message content not cached_\n━━━━━━━━━━━━━━━━━━━━━━\n`;
                    await sock.sendMessage(botJid, { text: notifyText }).catch(() => {});
                  }
                }
              }
            } catch {}
            continue; // don't pass protocol messages to handleMessage
          }

          if (msg.key.remoteJid === 'status@broadcast') {
            await handleStatus(sock, msg).catch(() => {});
            continue;
          }
          await autoBehaviors(sock, msg).catch(() => {});
          await handleMessage(sock, msg).catch(() => {});
        }
      });



      sock.ev.on('group-participants.update', async (update) => {
        await handleGroupJoin(sock, update).catch(() => {});
        await handleGroupLeave(sock, update).catch(() => {});
      });

      sock.ev.on('call', async (calls) => {
        await handleCall(sock, calls).catch(() => {});
      });

    } catch (e) {
      logger.error(`[SESSION] ${userId} connect error: ${e.message}`);
      session.status = STATUS.ERROR;
      if (onUpdate) onUpdate(userId, { status: STATUS.ERROR, error: e.message });
    }
  }

  await connect();
  return session;
}

// ── Stop a session ────────────────────────────────────────────
async function stopSession(userId) {
  const session = sessions.get(userId);
  if (!session) return;
  // Flag tells the disconnect handler NOT to clear auth — this is intentional
  session._manualStop = true;
  try {
    session.sock?.end?.();
    session.sock?.ws?.close?.();
  } catch {}
  sessions.delete(userId);
  logger.info(`[SESSION] ${userId} stopped`);
}

// ── Clear auth state from DB ──────────────────────────────────
async function clearUserSession(userId) {
  await stopSession(userId);
  await UserAuthState.deleteMany({ _id: new RegExp(`^${userId}:`) });
  logger.info(`[SESSION] ${userId} auth cleared`);
}

// ── Get session info ──────────────────────────────────────────
function getSession(userId) {
  return sessions.get(userId) || null;
}

function getAllSessions() {
  const result = [];
  for (const [userId, s] of sessions) {
    result.push({
      userId,
      status:      s.status,
      connectedAt: s.connectedAt,
      number:      s.sock?.user?.id?.split(':')[0] || userId,
      name:        s.sock?.user?.name || '',
    });
  }
  return result;
}

// ── Restore all active sessions on boot ──────────────────────
async function restoreActiveSessions(onUpdate) {
  // Find all unique userIds that have saved creds
  const docs = await UserAuthState.find({ key: 'creds' }).lean();
  let restored = 0;
  for (const doc of docs) {
    const userId = doc._id.split(':')[0];
    if (!sessions.has(userId)) {
      await startSession(userId, onUpdate).catch(() => {});
      restored++;
    }
  }
  logger.info(`[SESSION] Restored ${restored} sessions from DB`);
  return restored;
}

module.exports = {
  startSession,
  stopSession,
  clearUserSession,
  getSession,
  getAllSessions,
  restoreActiveSessions,
  STATUS,
  UserAuthState,
};
