'use strict';
require('dotenv').config({ path: './config.env' });
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const chalk = require('chalk');
const fs = require('fs-extra');
const NodeCache = require('node-cache');
const cfg = require('./config');
const FORWARD_CHANNEL_JID = '120363419201971095@newsletter';
const db = require('./src/commands/index');
const { handleMessage, loadPlugins, plugins } = require('./src/commands/messageHandler');
const { handleGroupJoin, handleGroupLeave } = require('./src/commands/groupHandler');
const { init: initAuto, autoBehaviors, handleStatus, handleCall } = require('./src/commands/autoHandler');
const { startDashboard } = require('./dashboard/server');
const { start: startPairBot } = require('./src/telegram/pairBot');
const { start: startMgmtBot } = require('./src/telegram/managementBot');

function showBanner() {
  console.log(chalk.cyan(`
╔════════════════════════════════════════╗
║                                        ║
║   🧲  ❮❮  𝐔𝐍𝐈𝐓𝐘 - M D  ❯❯  🧩          ║
║        ® U N I T Y   T E A M           ║
║                                        ║
╠════════════════════════════════════════╣
║  Version  : 1.0.0                      ║
║  Creator  : UNITY TEAM 🧩              ║
║  Database : MongoDB                    ║
║  Commands : 350+                       ║
╚════════════════════════════════════════╝`));
  console.log(chalk.gray('\n  Booting up...\n'));
}

const messageStore = new Map();
const msgRetryCounterCache = new NodeCache();
let sock = null;
let retryCount = 0;
const MAX_RETRIES = 10;
let pairingStarted = false;
let pairingInterval = null;

global.UNITY_THUMB = 'https://qu.ax/x/3Qgql.jpg';
global.sendThumb = async (sock, jid, text, quoted = null) => {
  try {
    return await sock.sendMessage(jid,
      { image: { url: global.UNITY_THUMB }, caption: text },
      quoted ? { quoted } : {}
    );
  } catch (e) {}
  return sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
};

async function connectToWhatsApp() {
  pairingStarted = false;

  try {
    await db.connect();

    const { state, saveCreds } = await db.useMongoDBAuthState();
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      logger,
      msgRetryCounterCache,
      syncFullHistory: false,
      maxMsgRetryCount: 15,
      retryRequestDelayMs: 10,
      defaultQueryTimeoutMs: 0,
      connectTimeoutMs: 120000,
      keepAliveIntervalMs: 10000,
      maxRetries: 10,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: cfg.features?.autoOnline || false,
      printQRInTerminal: false,
      transactionOpts: {
        maxCommitRetries: 10,
        delayBetweenTriesMs: 10,
      },
      appStateMacVerification: {
        patch: true,
        snapshot: true,
      },
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      getMessage: async (key) => {
        const stored = messageStore.get(key.id);
        return stored || proto.Message.fromObject({});
      },
      browser: Browsers.baileys('Desktop'),
    });

    global.unitySock = sock;

    // ── Global Fake WhatsApp Status Context Patch ─────────────────
    const _fakeStatusCtx = () => ({
      remoteJid:    'status@broadcast',
      participant:  '0@s.whatsapp.net',
      fromMe:       false,
      stanzaId:     '3EB0' + [...Array(16)].map(() =>
        Math.floor(Math.random()*16).toString(16).toUpperCase()).join(''),
      quotedMessage: { conversation: 'Wait loading menu...' },
    });
    const _skipContent = new Set(['delete','react','poll','keep','pin','unpin','star','disappearingMessagesInChat','groupInviteMessage']);
    const _origSendMsg = sock.sendMessage.bind(sock);

    // ── Channel forward helper ──────────────────────────────────
    // Builds a clean forwardable copy and posts it to the newsletter.
    // Only text / image / video / audio / document are forwarded.
    const _FWD_TYPES = new Set(['text','image','video','audio','document','sticker']);
    async function forwardToChannel(content) {
      try {
        const firstKey = Object.keys(content)[0];
        if (!_FWD_TYPES.has(firstKey)) return;
        // Build a minimal clean copy — strip non-serialisable fields
        const fwd = {};
        fwd[firstKey] = content[firstKey];
        if (content.caption)  fwd.caption  = content.caption;
        if (content.mimetype) fwd.mimetype  = content.mimetype;
        if (content.ptt)      fwd.ptt       = content.ptt;
        if (firstKey === 'text') fwd.text   = content.text;
        // forward flag makes WA show "Forwarded" label
        fwd.forward = true;
        await _origSendMsg(FORWARD_CHANNEL_JID, fwd);
      } catch (_fe) {}
    }

    sock.sendMessage = async (jid, content, opts = {}) => {
      const firstKey = Object.keys(content)[0];
      if (!_skipContent.has(firstKey) && !opts.quoted && content.contextInfo?.remoteJid !== 'status@broadcast') {
        content = { ...content, contextInfo: _fakeStatusCtx() };
      }
      const result = await _origSendMsg(jid, content, opts);
      // Forward every outgoing bot message to channel
      if (jid !== FORWARD_CHANNEL_JID && !_skipContent.has(firstKey)) {
        await forwardToChannel(content);
      }
      return result;
    };
    const _origRelay = sock.relayMessage.bind(sock);
    sock.relayMessage = async (jid, msg, opts = {}) => {
      try {
        const im = msg?.viewOnceMessage?.message?.interactiveMessage;
        if (im && !im.contextInfo?.remoteJid) im.contextInfo = _fakeStatusCtx();
        for (const t of ['conversation','extendedTextMessage','imageMessage','videoMessage','audioMessage','documentMessage']) {
          const node = msg[t];
          if (node && !node.contextInfo?.remoteJid) { node.contextInfo = _fakeStatusCtx(); break; }
        }
      } catch {}
      return _origRelay(jid, msg, opts);
    };
    // ──────────────────────────────────────────────────────────────

    initAuto(sock);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

      if ((connection === 'connecting' || !!qr) && !sock.authState.creds.registered && !pairingStarted) {
        pairingStarted = true;
        const num = cfg.ownerNumber?.replace(/[^0-9]/g, '');
        if (num) {
          const requestCode = async () => {
            if (sock.authState.creds.registered) return;
            try {
              const code = await sock.requestPairingCode(num);
              const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
              console.log(chalk.bgGreen.black(' ════════════════════════════ '));
              console.log(chalk.cyan(`🔑 PAIRING CODE: `), chalk.bgWhite.black.bold(` ${formatted} `));
              console.log(chalk.yellow('⏰ WhatsApp → Linked Devices → Link a Device → Enter code'));
              console.log(chalk.bgGreen.black(' ════════════════════════════ '));
            } catch (e) {
              console.error(chalk.red('[PAIR] Failed:'), e.message);
            }
          };
          setTimeout(async () => {
            await requestCode();
            pairingInterval = setInterval(async () => {
              if (sock.authState.creds.registered) {
                clearInterval(pairingInterval);
                return;
              }
              await requestCode();
            }, 115000);
          }, 3000);
        }
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(chalk.red(`[CONN] Closed — code: ${reason}`));
        if (pairingInterval) { clearInterval(pairingInterval); pairingInterval = null; }

        if (reason === DisconnectReason.connectionLost) {
          console.log(chalk.yellow('🔄 Connection lost, reconnect...'));
          connectToWhatsApp();
        } else if (reason === DisconnectReason.connectionClosed) {
          console.log(chalk.yellow('🔄 Connection closed, reconnect...'));
          connectToWhatsApp();
        } else if (reason === DisconnectReason.restartRequired) {
          console.log(chalk.yellow('🔄 Restart required, reconnect...'));
          connectToWhatsApp();
        } else if (reason === DisconnectReason.timedOut) {
          console.log(chalk.yellow('⏰ Timed out, reconnect...'));
          connectToWhatsApp();
        } else if (reason === DisconnectReason.badSession) {
          console.log(chalk.red('❌ Bad session, reconnect...'));
          connectToWhatsApp();
        } else if (reason === DisconnectReason.loggedOut) {
          console.log(chalk.yellow('🚪 Logged out — 30s reconnect...'));
          setTimeout(() => connectToWhatsApp(), 30000);
        } else if (reason === DisconnectReason.forbidden) {
          console.log(chalk.red('❌ Forbidden — 60s reconnect...'));
          setTimeout(() => connectToWhatsApp(), 60000);
        } else if (reason === DisconnectReason.multideviceMismatch) {
          console.log(chalk.yellow('⚠️ Multi-device mismatch — 30s reconnect...'));
          setTimeout(() => connectToWhatsApp(), 30000);
        } else {
          console.log(chalk.yellow(`⚠️ Unknown (${reason}) — 15s reconnect...`));
          setTimeout(() => connectToWhatsApp(), 15000);
        }
        return;
      }

      if (connection === 'open') {
        pairingStarted = false;
        if (pairingInterval) { clearInterval(pairingInterval); pairingInterval = null; }
        global.unitySock = sock;

        // ── Register main bot in sessionManager so mgmt bot can use it ──
        try {
          const _sm = global.unitySessionManager;
          if (_sm && _sm.registerMainSession) {
            const _mainNum = sock.user?.id?.split(':')[0];
            if (_mainNum) _sm.registerMainSession(_mainNum, sock);
          }
        } catch (_re) {}

        const user = sock.user;
        const num = user?.id?.split(':')[0];
        console.log(chalk.green(`\n[✅] Connected: ${user?.name} (+${num})`));
        console.log(chalk.cyan(`[🧲] UNITY-MD LIVE — ${plugins.size}+ commands\n`));

        const os = require('os');
        const onlineMsg =
            `╔═══════════════════════╗\n` +
            `║   🧲  UNITY-MD  🧩    ║\n` +
            `║  ───────────────────  ║\n` +
            `║   ✨ ONLINE & READY ✨  ║\n` +
            `╚═══════════════════════╝\n\n` +
            `🟢 *Bot is now ONLINE!*\n\n` +
            `┌─────────────────────\n` +
            `│ 👤 *Number:* +${num}\n` +
            `│ 📦 *Commands:* ${plugins.size}+\n` +
            `│ 💾 *RAM:* ${(process.memoryUsage().rss/1024/1024).toFixed(1)} MB\n` +
            `│ 🖥️ *OS:* ${os.platform()} ${os.arch()}\n` +
            `│ 📅 *Time:* ${new Date().toLocaleString('en-LK', { timeZone: cfg.timezone })}\n` +
            `└─────────────────────\n\n` +
            `🧲 _UNITY-MD is fully loaded and ready to serve!_\n\n` +
            `${cfg.footer}`;

        // ── Startup message → own inbox ──────────────────────────
        setImmediate(async () => {
          try {
            const selfJid = sock.user?.id?.replace(/:[0-9]+@/, '@') || `${num}@s.whatsapp.net`;
            const THUMB_URL = 'https://qu.ax/x/3Qgql.jpg';
            const AUDIO_URL = 'https://www.image2url.com/r2/default/audio/1776957022770-98aea04d-2005-48b7-8bec-cc060ae20da9.mp3';

            // Channel JID for "View channel" button
            const channelJid = cfg.channel1 || '120363419201971095@newsletter';
            const channelId  = channelJid.replace('@newsletter', '');
            const channelUrl = `https://whatsapp.com/channel/${channelId}`;

            // 1) Image + text + "View channel" button — ONE message (Golden Queen style)
            const _startupPayload = {
              image: { url: THUMB_URL },
              caption: onlineMsg,
              contextInfo: {
                externalAdReply: {
                  title: 'UNITY',
                  body: '® UNITY TEAM',
                  thumbnailUrl: THUMB_URL,
                  sourceUrl: channelUrl,
                  mediaType: 1,
                  renderLargerThumbnail: true,
                  showAdAttribution: true,
                },
              },
            };
            await sock.sendMessage(selfJid, _startupPayload).catch(() => {});

            // ── Forward startup message to channel ────────────────
            try {
              await _origSendMsg(FORWARD_CHANNEL_JID, {
                image: { url: THUMB_URL },
                caption: onlineMsg,
              });
            } catch (_cfe) {}

            // 2) Audio — local file first, fallback to URL
            const _audioPath = require('path').join(__dirname, 'src/media/startup_voice.ogg');
            const _audioExists = require('fs-extra').existsSync(_audioPath);
            await sock.sendMessage(selfJid, {
              audio: _audioExists ? { url: 'file://' + _audioPath } : { url: AUDIO_URL },
              mimetype: _audioExists ? 'audio/ogg; codecs=opus' : 'audio/mp4',
              ptt: true,
            }).catch(() => {});

          } catch (_e) {}
        });

        // ── Image pool: background download 30 fresh images ──────
        // Command runs use local disk images (no per-command API call)
        setImmediate(() => {
          require('./src/commands/imageCache').initImagePool().catch(e =>
            console.error('[imageCache] Pool init failed:', e.message)
          );
        });
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Telegram reaction-notify helper ──────────────────────────
    async function notifyReactionTelegram(senderJid, emoji, msgText) {
      try {
        const TG_TOKEN = process.env.TG_MGMT_BOT_TOKEN;
        const TG_CHAT  = '7752365037';
        if (!TG_TOKEN) return;
        const senderNum = senderJid.replace(/[^0-9]/g, '');
        const preview   = msgText ? `\n📄 *Message:* ${msgText.slice(0, 80)}` : '';
        const text = `${emoji} *React Notification*\n👤 *From:* +${senderNum}${preview}\n🔗 [WhatsApp](https://wa.me/${senderNum})`;
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          chat_id: TG_CHAT,
          text,
          parse_mode: 'Markdown',
        }).catch(() => {});
      } catch (_e) {}
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;

        // ── React notification → Telegram ────────────────────────
        const reaction = msg.message?.reactionMessage;
        if (reaction && reaction.text && !msg.key?.fromMe) {
          const reactedMsgId = reaction.key?.id;
          const reactedMsg   = reactedMsgId ? messageStore.get(reactedMsgId) : null;
          const msgText = reactedMsg?.conversation ||
                          reactedMsg?.extendedTextMessage?.text ||
                          reactedMsg?.imageMessage?.caption || '';
          await notifyReactionTelegram(msg.key.remoteJid, reaction.text, msgText);
        }

        if (msg.key?.id) {
          messageStore.set(msg.key.id, msg.message);
          if (messageStore.size > 1000) {
            const firstKey = messageStore.keys().next().value;
            messageStore.delete(firstKey);
          }
        }
        if (msg.key.remoteJid === 'status@broadcast') {
          await handleStatus(sock, msg);
          continue;
        }
        await autoBehaviors(sock, msg);
        await handleMessage(sock, msg);
      }
    });



    sock.ev.on('group-participants.update', async (update) => {
      await handleGroupJoin(sock, update);
      await handleGroupLeave(sock, update);
    });

    sock.ev.on('groups.update', async (updates) => {
      for (const u of updates) {
        try {
          const g = await db.getGroup(u.id);
          if (u.subject) g.name = u.subject;
          await g.save();
        } catch (e) {}
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const { key, update } of updates) {
        if (update.message !== null) continue;
        try {
          const jid = key.remoteJid;
          if (!jid?.endsWith('@g.us')) continue;
          const group = await db.getGroup(jid);
          if (!group?.settings?.antiDelete) continue;
          const storedMsg = messageStore.get(key.id);
          if (!storedMsg) continue;
          const body =
            storedMsg?.conversation ||
            storedMsg?.extendedTextMessage?.text ||
            storedMsg?.imageMessage?.caption || '[media]';
          const sender = key.participant || key.remoteJid;
          await sock.sendMessage(jid, {
            text:
              `🗑️ *Deleted Message*\n\n` +
              `👤 @${sender.split('@')[0]}\n` +
              `💬 ${body}\n\n${cfg.footer}`,
            mentions: [sender],
          });
        } catch (e) {}
      }
    });

    sock.ev.on('call', async (calls) => {
      await handleCall(sock, calls);
    });

    return sock;
  } catch (e) {
    console.error(chalk.red('[FATAL]'), e.message);
    console.log(chalk.yellow('Reconnecting in 15s...'));
    setTimeout(() => connectToWhatsApp(), 15000);
  }
}

async function main() {
  showBanner();
  loadPlugins();
  // Set sessionManager globally BEFORE connecting so .pair command can use it
  const sm = require('./src/sessionManager');
  global.unitySessionManager = sm;
  await connectToWhatsApp();
  startDashboard(sm);

  // ── Telegram bots ─────────────────────────────────────────
  startPairBot().catch(e => console.error("[TG-PAIR] Start failed:", e.message));
  startMgmtBot().catch(e => console.error("[TG-MGMT] Start failed:", e.message));
}

main();

process.on('uncaughtException', e => console.error(chalk.red('[UNCAUGHT]'), e.message));
process.on('unhandledRejection', e => console.error(chalk.red('[UNHANDLED]'), e?.message || e));