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
  makeCacheableSignalKeyStore,
  proto,
  Browsers,
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
// clearAllChatsOnStartup removed — was auto-running on every startup and deleting chats unintentionally
const logger       = require('./commands/logger');
const { t, getLang } = require('./src/commands/strings');
const _fs   = require('fs');
const _path = require('path');

// ── In-memory feature state cache (avoids disk read per message) ──
// Map<userId, { antidelete, autoread, ... }>
const _featureCache = new Map();
const _DATA_DIR = _path.join(process.cwd(), 'data');

function _readFeatureCache(userId) {
  if (_featureCache.has(userId)) return _featureCache.get(userId);
  const cache = {};
  _featureCache.set(userId, cache);
  return cache;
}

// Call this to invalidate cache when settings change
function invalidateFeatureCache(userId) {
  _featureCache.delete(userId);
}

// Read antidelete state (cached, refreshes every 30s per session)
function _getAntiDeleteState(userId) {
  const cache = _readFeatureCache(userId);
  const now = Date.now();
  if (cache._adLoaded && (now - cache._adTime) < 30000) return cache._ad;
  // Read fresh
  try {
    const stateFile = _path.join(_DATA_DIR, `${userId}_antidelete.json`);
    const fallback  = _path.join(_DATA_DIR, 'antidelete.json');
    const sf = _fs.existsSync(stateFile) ? stateFile : (_fs.existsSync(fallback) ? fallback : null);
    cache._ad = sf ? JSON.parse(_fs.readFileSync(sf, 'utf8')) : { enabled: false };
  } catch { cache._ad = { enabled: false }; }
  cache._adLoaded = true;
  cache._adTime   = now;
  return cache._ad;
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
  // Don't double-start connected sessions
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    if (existing.status === STATUS.CONNECTED) {
      return existing;
    }
    // Bug 1 fix: PAIRING session = expired code risk.
    // Close existing socket + clear session so a fresh code is generated.
    if (existing.status === STATUS.PAIRING) {
      logger.info(`[SESSION] ${userId} PAIRING session detected — closing for fresh code`);
      try {
        existing._manualStop = true;
        existing.sock?.end?.();
        existing.sock?.ws?.close?.();
      } catch {}
      sessions.delete(userId);
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
      // ── DO NOT call fetchLatestBaileysVersion() ───────────────────────
      // Official Baileys 2026 docs: "It is NOT recommended to set the latest
      // version on your socket every time you connect, as you may face
      // incompatibility." Library uses its own tested default — leave it alone.
      const silentLogger = pino({ level: 'silent' });

      const sock = makeWASocket({
        logger: silentLogger,
        msgRetryCounterCache: session.retryCache,

        // ── KEY FIX: false prevents Signal prekey storm on connect ──
        // true causes bot to negotiate Signal sessions for EVERY chat at once
        // → "Closing open session in favor of incoming prekey bundle" flood
        syncFullHistory:       false,

        maxMsgRetryCount:      2,           // fewer retries = less prekey churn
        connectTimeoutMs:      60000,        // longer timeout = stable connect
        keepAliveIntervalMs:   20000,        // more frequent keepalive
        retryRequestDelayMs:   250,          // faster retry response
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect:   false,
        printQRInTerminal:     false,
        fireInitQueries:       true,
        emitOwnEvents:         false,
        // ── Railway speed tuning ──────────────────────────────
        // Reduce per-session heartbeat frequency (14 sessions × 20s = heavy)
        keepAliveIntervalMs:   45000,
        connectTimeoutMs:      40000,
        // Limit Signal session retries to reduce CPU spikes
        transactionOpts:       { maxCommitRetries: 1, delayBetweenTriesMs: 10 },

        auth: {
          creds: state.creds,
          keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
        },

        getMessage: async (key) => {
          const stored = session.msgStore.get(key.id);
          return stored || proto.Message.fromObject({});
        },

        // Dynamic browser:
        //   - Not yet paired  → macOS Google Chrome  (official Baileys 2026 docs:
        //     "set a valid/logical browser config e.g. Browsers.macOS('Google Chrome'),
        //      otherwise the pair will fail")
        //   - Already paired  → Ubuntu Chrome (desktop, full features + status react)
        browser: state.creds.registered
          ? Browsers.ubuntu('Chrome')
          : Browsers.macOS('Google Chrome'),
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

        // ── Pair code request ─────────────────────────────────────────────
        // Trigger ONLY on !!qr — at this moment the WA WebSocket handshake
        // is COMPLETE and the server is ready. 'connecting' + setTimeout was
        // unreliable: handshake takes 2-4s, fixed delays race and silently
        // throw "Connection Closed", producing a code WA never accepts.
        // When !!qr fires, socket is open — call requestPairingCode directly.
        // If it fails, next qr event fires in ~20s and auto-retries.
        if (!!qr && !sock.authState.creds.registered && !session.pairCode && !session._pairingInProgress) {
          session._pairingInProgress = true;
          session.status = STATUS.PAIRING;
          if (onUpdate) onUpdate(userId, { status: STATUS.PAIRING });
          const cleanNum = userId.replace(/[^0-9]/g, '');
          try {
            const code = await sock.requestPairingCode(cleanNum);
            session.pairCode = code?.match(/.{1,4}/g)?.join('-') || code;
            session._pairingInProgress = false;
            logger.info(`[SESSION] Pair code for ${userId}: ${session.pairCode}`);
            if (onUpdate) onUpdate(userId, { status: STATUS.PAIRING, pairCode: session.pairCode });
          } catch (e) {
            session._pairingInProgress = false;
            // Auto-retry: next !!qr event (~20s) will call this block again
            logger.warn(`[SESSION] Pair code request failed for ${userId}: ${e.message} — auto-retry on next qr`);
          }
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

          // ── 515 restartRequired: normal post-pairing WA handshake ────────
          // After entering the pair code, WA forces a disconnect with 515 so
          // the socket can reconnect with freshly-saved credentials.
          // Reconnect must be IMMEDIATE — any delay causes the notification
          // to expire before the new socket opens.
          if (reason === DisconnectReason.restartRequired) {
            logger.info(`[SESSION] ${userId} restart required (515) — reconnecting immediately`);
            session.pairCode = null; // clear stale code
            setImmediate(() => connect());
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
              const rawBotJid = sock.user?.id || (userId + '@s.whatsapp.net');
              const botJid = rawBotJid.includes('@') ? rawBotJid.replace(/:\d+@/, '@') : rawBotJid + '@s.whatsapp.net';

              // ── Resolve language BEFORE building any text ──────────
              const lang = await getLang(db, sock.sessionOwner);

              const startupMsg =
                `╔══════════════════════════╗\n` +
                `║  ${t('startup.activated', lang)}  ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${t('startup.connected', lang)} +${userId}\n` +
                `${t('startup.date', lang)} ${now.format('ddd, DD MMM YYYY')}\n` +
                `${t('startup.time', lang)} ${now.format('HH:mm')} (SL)\n\n` +
                `${t('startup.active', lang)}\n` +
                `${t('startup.commands', lang)} ${plugins.size}+\n` +
                `${t('startup.prefix', lang)}\n\n` +
                `${t('startup.typemenu', lang)}\n\n` +
                `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n` +
                `❪❪ UNITY-MD ❫❫ | ® UNITY TEAM`;

              // ── STEP 1: Follow channel ──────────────────────────────
              const channelUrl = process.env.AUTO_JOIN_CHANNEL || '';
              if (channelUrl) {
                try {
                  let channelJid = '';
                  if (channelUrl.includes('@newsletter')) {
                    channelJid = channelUrl;
                  } else {
                    const match = channelUrl.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
                    if (match) channelJid = `${match[1]}@newsletter`;
                  }
                  if (channelJid) {
                    await sock.followNewsletter(channelJid);
                    logger.info(`[SESSION] ${userId} followed channel`);
                  }
                } catch (e) {
                  logger.warn(`[SESSION] Channel follow failed: ${e.message}`);
                }
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

              // ── STEP 3: Send startup message → this session's own inbox only ──────
              // Each bot sends only to its OWN number (Message yourself),
              // so every person gets only their own bot's notification.
              try {
                await sock.sendMessage(botJid, { text: startupMsg });
                logger.info(`[SESSION] Startup message sent to own inbox (+${userId})`);
              } catch (e) {
                logger.error(`[SESSION] Startup message failed: ${e.message}`);
              }

              // ── Image pool: background-download neko images for commands ──
              setImmediate(() => {
                require('./commands/imageCache').initImagePool().catch(e =>
                  logger.warn(`[SESSION] imageCache init failed: ${e.message}`)
                );
              });

              // ── STEP 4: Language select (first time only) ───────────
              try {
                const botCfg = await db.getBotConfig();
                if (!botCfg.langSet) {
                  // Send language select to bot's own number (owner)
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
                logger.warn(`[SESSION] Language select send failed: ${e.message}`);
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
              const sid = sock.sessionOwner || 'default';
              const state = _getAntiDeleteState(sid);

              if (state.enabled) {
                const deletedKey  = proto.key;
                const deleterJid  = msg.key.participant || msg.key.remoteJid || '';
                const chatJid     = msg.key.remoteJid || '';
                const storedMsg   = session.msgStore.get(deletedKey.id);
                const botJid      = sock.user?.id?.replace(/:\d+@/, '@') || '';

                if (botJid) {
                  const deleterNum = deleterJid.split('@')[0];
                  const chatLabel  = chatJid.endsWith('@g.us') ? `Group: ${chatJid}` : `DM: +${chatJid.split('@')[0]}`;
                  const adLang = await getLang(db, sock.sessionOwner);

                  let notifyText =
                    `${t('antidelete.title', adLang)}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `${t('antidelete.deletedby', adLang)} +${deleterNum}\n` +
                    `${t('antidelete.chat', adLang)} ${chatLabel}\n` +
                    `${t('antidelete.time', adLang)} ${new Date().toLocaleString('en-LK', { timeZone: 'Asia/Colombo' })}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n`;

                  if (storedMsg) {
                    // Forward the original deleted message content
                    const textContent =
                      storedMsg.conversation ||
                      storedMsg.extendedTextMessage?.text ||
                      storedMsg.imageMessage?.caption ||
                      storedMsg.videoMessage?.caption ||
                      '';

                    if (textContent) notifyText += `${t('antidelete.message', adLang)} ${textContent}\n━━━━━━━━━━━━━━━━━━━━━━\n`;

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
                    notifyText += `${t('antidelete.notcached', adLang)}\n━━━━━━━━━━━━━━━━━━━━━━\n`;
                    await sock.sendMessage(botJid, { text: notifyText }).catch(() => {});
                  }
                }
              }
            } catch {}
            continue; // don't pass protocol messages to handleMessage
          }

          if (msg.key.remoteJid === 'status@broadcast') {
            // Non-blocking status handling — don't block the message loop
            setImmediate(() => handleStatus(sock, msg).catch(() => {}));
            continue;
          }
          // ── Non-blocking parallel dispatch ────────────────────────────
          // setImmediate yields to the event loop so the next message /
          // session can be processed immediately — not after awaiting both handlers.
          // autoBehaviors (auto-react, auto-block) and handleMessage (commands)
          // are independent so they run in parallel via Promise.all.
          const _m = msg, _s = sock;
          setImmediate(() => {
            Promise.all([
              autoBehaviors(_s, _m),
              handleMessage(_s, _m),
            ]).catch(() => {});
          });
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
  invalidateFeatureCache,
};
