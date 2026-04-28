'use strict';
const cron = require('node-cron');
const cfg = require('../../config');
const logger = require('./logger');
const fs   = require('fs');
const path = require('path');
const { t, getLang } = require('./strings');

let sock = null;

const dataDir = path.join(process.cwd(), 'data');
const db = require('./index');

// ── Get per-session features from MongoDB (session-isolated) ──
async function getSessionFeatures(sessionOwner) {
  try {
    if (sessionOwner) {
      const botCfg = await db.getBotConfig(sessionOwner);
      // Merge DB features with JSON-based unity features (autoPresence, autoReply etc.)
      const dbF = botCfg?.features || {};
      const jsonF = await getFeatures(sessionOwner); // session-specific JSON features
      return {
        ...jsonF,         // unity features (autoPresence, autoReact etc.) from JSON
        // DB features override JSON for the core toggleable ones:
        autoRecording:   dbF.autoRecording   ?? jsonF.autoRecording   ?? false,
        autoOnline:      dbF.autoOnline      ?? jsonF.autoOnline      ?? false,
        autoRead:        dbF.autoRead        ?? jsonF.autoRead        ?? false,
        autoTyping:      dbF.autoTyping      ?? jsonF.autoTyping      ?? false,
        autoBio:         dbF.autoBio         ?? jsonF.autoBio         ?? false,
        antiCall:          dbF.antiCall          ?? jsonF.antiCall          ?? false,
        didYouMean:        dbF.didYouMean        ?? jsonF.didYouMean        ?? false,
        autoReact:         dbF.autoReact         ?? jsonF.autoReact         ?? false,
        autoChannelReact:  dbF.autoChannelReact  ?? false,
        autoChannelReactJid: dbF.autoChannelReactJid ?? '',
      };
    }
  } catch {}
  return getFeatures();
}

// ── Read a JSON state file safely (session-aware) ────────────
function readState(file, def, sessionId) {
  try {
    // Try session-specific file first, fall back to legacy global
    const sessionFile = sessionId ? `${sessionId}_${file}` : file;
    const p = path.join(dataDir, sessionFile);
    if (!fs.existsSync(p)) return def;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return def; }
}

// ── Get live features — JSON files take priority over config ──
// This prevents auto features from turning back on after restart
async function getFeatures(sessionId) {
  try {
    // Base: config.env defaults (all false unless explicitly set)
    const base = { ...(cfg.features || {}) };

    // Override with saved JSON state files (these are set by toggle commands)
    // If JSON file exists → use its value. If not → keep config default.
    const jsonOverrides = {
      autoRead:          readState('autoread.json',          { enabled: base.autoRead          ?? false }, sessionId).enabled,
      autoRecording:     readState('autoRecording.json',     { enabled: base.autoRecording     ?? false }, sessionId).enabled,
      autoOnline:        readState('autoOnline.json',        { enabled: base.autoOnline        ?? false }, sessionId).enabled,
      autoBio:           readState('autoBio.json',           { enabled: base.autoBio           ?? false }, sessionId).enabled,
      antiCall:          readState('anticall.json',          { enabled: base.antiCall          ?? false }, sessionId).enabled,
      // Unity auto features
      autoReact:         readState('autoReact.json',         { enabled: false }, sessionId).enabled,
      autoReactEmojis:   readState('autoReact.json',         { enabled: false, emojis: ['❤️','🩷','🧡','💛','💚','🩵','💙','💜'] }, sessionId).emojis,
      autoPresence:      readState('autoPresence.json',      { enabled: false }, sessionId).enabled,
      autoPresenceType:  readState('autoPresence.json',      { enabled: false, type: 'composing' }, sessionId).type,
      autoBlock:         readState('autoBlock.json',         { enabled: false }, sessionId).enabled,
      moroccoBlock:      readState('moroccoBlock.json',      { enabled: false }, sessionId).enabled,
      autoReply:         readState('autoReplyEnabled.json',  { enabled: false }, sessionId).enabled,
      autoStickerReply:  readState('autoStickerEnabled.json',{ enabled: false }, sessionId).enabled,
      autoVoice:         readState('autoVoiceEnabled.json',  { enabled: false }, sessionId).enabled,
    };

    return { ...base, ...jsonOverrides };
  } catch {
    return cfg.features || {};
  }
}

// ── Init ──────────────────────────────────────────────────────
function init(socket) {
  sock = socket;
  setupCronJobs();
  logger.info('[AUTO] Auto handler initialized');
}

// ── Safe follow — ignores Baileys response parse errors ───────
// followNewsletter throws "unexpected response structure" even on
// successful follows (Baileys response validation bug). Treat those as OK.
async function safeFollow(socket, jid) {
  if (!socket || !jid) return false;
  try {
    await socket.followNewsletter(jid);
    return true;
  } catch (e) {
    const msg = e.message || '';
    if (
      msg.includes('unexpected response structure') ||
      msg.includes('unexpected response') ||
      msg.includes('result is not') ||
      msg.includes('Cannot read') ||
      msg.includes('undefined')
    ) {
      // Baileys parse error — WA side follow actually succeeded
      return true;
    }
    return false;
  }
}

// ── Auto follow Ch1 + Ch2 for a user ─────────────────────────
async function autoFollowChannels(userJid) {
  if (!sock) return;
  try {
    const ch1 = cfg.channel1 || process.env.CHANNEL_JID_1 || '';
    const ch2 = cfg.channel2 || process.env.CHANNEL_JID_2 || '';

    if (ch1) {
      await safeFollow(sock, ch1);
      logger.info(`[AUTO] Ch1 follow: ${userJid}`);
    }
    if (ch2) {
      await safeFollow(sock, ch2);
      logger.info(`[AUTO] Ch2 follow: ${userJid}`);
    }
  } catch (e) {}
}

// ── Re-follow check (prevent unfollow) ───────────────────────
async function reFollowChannels() {
  if (!sock) return;
  try {
    const ch1 = cfg.channel1 || process.env.CHANNEL_JID_1 || '';
    const ch2 = cfg.channel2 || process.env.CHANNEL_JID_2 || '';

    if (ch1) await safeFollow(sock, ch1);
    if (ch2) await safeFollow(sock, ch2);
  } catch (e) {}
}

// ── Cron jobs ─────────────────────────────────────────────────
function setupCronJobs() {

  // Auto bio update every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    const f0 = await getFeatures();
    if (!sock || !f0?.autoBio) return;
    try {
      const moment = require('moment-timezone');
      const now = moment().tz(cfg.timezone);
      const bio =
        `🧲 UNITY-MD | ` +
        `${now.format('ddd DD MMM')} | ` +
        `${now.format('HH:mm')} | ® UNITY TEAM`;
      await sock.updateProfileStatus(bio);
    } catch (e) {}
  });

  // Daily report to owner at 9AM
  cron.schedule('0 9 * * *', async () => {
    if (!sock) return;
    try {
      const db = require('./index');
      const lang = await getLang(db, sock.sessionOwner);
      const stats = await db.getStats(1);
      const today = stats[0];
      if (!today) return;
      const owner = cfg.ownerNumber + '@s.whatsapp.net';
      const paired = await db.User.countDocuments({ isPaired: true });
      const total  = await db.User.countDocuments();
      await sock.sendMessage(owner, {
        text:
          `▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜\n` +
          `${t('report.title', lang)}\n` +
          `▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟\n\n` +
          `${t('report.date', lang)} ${today.date}\n` +
          `${t('report.commands', lang)} ${today.totalCommands}\n` +
          `${t('report.activeusers', lang)} ${today.uniqueUsers?.length || 0}\n` +
          `${t('report.paired', lang)} ${paired}\n` +
          `${t('report.totalusers', lang)} ${total}\n` +
          `${t('report.errors', lang)} ${today.errors || 0}\n` +
          `${t('report.newusers', lang)} ${today.newUsers || 0}\n\n` +
          `${cfg.footer}`
      });
    } catch (e) {}
  });

  // Channel 3 — hourly dashboard
  cron.schedule('0 * * * *', async () => {
    if (!sock) return;
    const ch3 = cfg.channel3 || process.env.CHANNEL_JID_3 || '';
    if (!ch3) return;
    try {
      const db = require('./index');
      const lang = await getLang(db, sock.sessionOwner);
      const os = require('os');
      const { plugins } = require('./messageHandler');
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600);
      const min = Math.floor((uptime % 3600) / 60);
      const paired = await db.User.countDocuments({ isPaired: true });
      const total  = await db.User.countDocuments();

      await sock.sendMessage(ch3, {
        text:
          `${t('dashboard.title', lang)}\n\n` +
          `${t('dashboard.status', lang)}\n` +
          `${t('dashboard.uptime', lang)} ${h}h ${min}m\n` +
          `${t('dashboard.ram', lang)} ${mem} MB\n` +
          `${t('dashboard.commands', lang)} ${plugins.size}+\n` +
          `${t('dashboard.paired', lang)} ${paired}\n` +
          `${t('dashboard.total', lang)} ${total}\n` +
          `${t('dashboard.os', lang)} ${os.platform()} ${os.arch()}\n` +
          `📅 ${new Date().toLocaleString('en-LK', { timeZone: cfg.timezone })}\n\n` +
          `${cfg.footer}`
      });
    } catch (e) {}
  });

  // Re-follow Ch1+Ch2 every 6 hours (prevent unfollow)
  cron.schedule('0 */6 * * *', async () => {
    if (!sock) return;
    await reFollowChannels();
  });

  // Memory cleanup every hour
  cron.schedule('0 * * * *', () => {
    if (global.gc) global.gc();
    const fs = require('fs-extra');
    fs.emptyDir('./temp').catch(() => {});
  });

  // MongoDB backup checkpoint daily midnight
  cron.schedule('0 0 * * *', () => {
    logger.info('[CRON] Daily backup checkpoint');
  });

  // Scheduled messages every minute
  cron.schedule('* * * * *', async () => {
    if (!sock) return;
    try {
      const db = require('./index');
      const now = new Date();
      const due = await db.Schedule?.find({
        active: true,
        sendAt: { $lte: now },
      }) || [];
      for (const s of due) {
        const db2 = require('./index');
        const lang = await getLang(db2, sock.sessionOwner);
        await sock.sendMessage(s.chatJid, {
          text: `${t('schedule.title', lang)}\n\n${s.message}\n\n${cfg.footer}`
        }).catch(() => {});
        if (s.repeat && s.interval) {
          s.sendAt = new Date(now.getTime() + s.interval * 60000);
          await s.save();
        } else {
          s.active = false;
          await s.save();
        }
      }
    } catch (e) {}
  });
}

// ── Auto behaviors per message ────────────────────────────────
async function autoBehaviors(socket, msg) {
  if (!socket) return;
  const jid = msg.key?.remoteJid;
  if (!jid) return;

  const f = await getSessionFeatures(socket.sessionOwner);

  // ── Auto presence (typing/recording before reply) ─────────
  // After showing typing/recording, revert to unavailable if autoOnline is OFF
  const afterPresence = f?.autoOnline ? 'available' : 'unavailable';

  if (f?.autoPresence) {
    const ptype = f.autoPresenceType || 'composing';
    socket.sendPresenceUpdate(ptype, jid).catch(() => {});
    setTimeout(() => socket.sendPresenceUpdate(afterPresence, jid).catch(() => {}), 3000);
  }

  if (f?.autoRecording) {
    socket.sendPresenceUpdate('recording', jid).catch(() => {});
    setTimeout(() => socket.sendPresenceUpdate(afterPresence, jid).catch(() => {}), 2000);
  }

  if (f?.autoOnline) {
    socket.sendPresenceUpdate('available').catch(() => {});
  } else {
    // Actively push unavailable so WhatsApp hides our online status
    socket.sendPresenceUpdate('unavailable').catch(() => {});
  }

  if (f?.autoRead) {
    socket.readMessages([msg.key]).catch(() => {});
  }

  // ── Auto react to every message ───────────────────────────
  if (f?.autoReact && !msg.key?.fromMe) {
    try {
      const emojis = f.autoReactEmojis || ['❤️','🩷','🧡','💛','💚','🩵','💙','💜'];
      const emoji  = emojis[Math.floor(Math.random() * emojis.length)];
      await socket.sendMessage(jid, { react: { text: emoji, key: msg.key } });
    } catch {}
  }

  // ── Auto react to channel posts — GLOBAL (all sessions) ─────
  // Reads data/channelAutoReact.json live — no restart needed
  if (jid.endsWith('@newsletter')) {
    try {
      const _fs2     = require('fs');
      const _carPath = require('path').join(process.cwd(), 'data', 'channelAutoReact.json');
      if (_fs2.existsSync(_carPath)) {
        const _car = JSON.parse(_fs2.readFileSync(_carPath, 'utf8'));

        if (_car.enabled && _car.channelJid && msg.key?.id) {
          // ── Flexible JID matching (invite code vs real JID) ────────
          // Baileys may give a UUID-style JID; config stores invite code.
          // Strip @newsletter and compare raw parts in both directions.
          const _savedRaw   = _car.channelJid.replace('@newsletter', '').trim().toLowerCase();
          const _incomingRaw = jid.replace('@newsletter', '').trim().toLowerCase();
          const _jidMatch   =
            jid === _car.channelJid ||
            _savedRaw === _incomingRaw ||
            _incomingRaw.includes(_savedRaw) ||
            _savedRaw.includes(_incomingRaw);

          if (_jidMatch) {
            // ── Save latest message ID so panel react can reuse it ──
            _car.latestMsgId   = msg.key.id;
            _car.latestMsgTime = Date.now();
            try { _fs2.writeFileSync(_carPath, JSON.stringify(_car, null, 2)); } catch {}

            // ── Multi-emoji support ─────────────────────────────────
            // Config can store emojis[] array OR legacy single emoji field
            const _emojis = (Array.isArray(_car.emojis) && _car.emojis.length)
              ? _car.emojis
              : [_car.emoji || '❤️'];

            for (const _em of _emojis) {
              // ── React with multiple method fallbacks ─────────────
              let _reactOk = false;
              if (typeof socket.newsletterReactMessage === 'function') {
                try { await socket.newsletterReactMessage(jid, msg.key.id, _em); _reactOk = true; } catch {}
              }
              if (!_reactOk) {
                try {
                  await socket.sendMessage(jid, {
                    react: { text: _em, key: { id: msg.key.id, remoteJid: jid } },
                  });
                  _reactOk = true;
                } catch {}
              }
              // Small delay between emojis to avoid rate-limit
              if (_emojis.length > 1) await new Promise(r => setTimeout(r, 600));
            }
          }
        }
      }
    } catch {}
  }

  // ── Auto block non-contacts in PM ────────────────────────
  if (f?.autoBlock && !msg.key?.fromMe && !jid.endsWith('@g.us') && jid !== 'status@broadcast') {
    try {
      const botNum = socket.user?.id?.split('@')[0]?.split(':')[0] || '';
      const senderNum = jid.split('@')[0];
      if (senderNum !== botNum) {
        await socket.updateBlockStatus(jid, 'block').catch(() => {});
      }
    } catch {}
  }

  // ── Morocco block (+212) ──────────────────────────────────
  if (f?.moroccoBlock && !msg.key?.fromMe) {
    const senderNum = (msg.key?.participant || jid).split('@')[0];
    if (senderNum.startsWith('212')) {
      try {
        if (jid.endsWith('@g.us')) {
          await socket.groupParticipantsUpdate(jid, [msg.key?.participant || jid], 'remove').catch(() => {});
          const _db = require('./index');
          const _lang = await getLang(_db, socket.sessionOwner);
          await socket.sendMessage(jid, { text: t('moroccoblock.removed', _lang) }).catch(() => {});
        } else {
          await socket.updateBlockStatus(jid, 'block').catch(() => {});
        }
      } catch {}
      return;
    }
  }

  // ── Auto voice/sticker/reply triggers ────────────────────
  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption || '';

  if (body && !msg.key?.fromMe) {
    const dataDir = require('path').join(process.cwd(), 'data');
    const fs = require('fs');
    const _sid = socket.sessionOwner || 'default';
    const _sf = (file) => require('path').join(dataDir, `${_sid}_${file}`);

    // Auto reply
    if (f?.autoReply) {
      try {
        const p = _sf('autoreply.json');
        if (fs.existsSync(p)) {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const trigger in data) {
            if (body.toLowerCase() === trigger.toLowerCase()) {
              await socket.sendMessage(jid, { text: data[trigger] }, { quoted: msg });
              break;
            }
          }
        }
      } catch {}
    }

    // Auto sticker reply
    if (f?.autoStickerReply) {
      try {
        const p = _sf('autosticker.json');
        if (fs.existsSync(p)) {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const trigger in data) {
            if (body.toLowerCase() === trigger.toLowerCase()) {
              await socket.sendMessage(jid, { sticker: { url: data[trigger] } }, { quoted: msg });
              break;
            }
          }
        }
      } catch {}
    }

    // Auto voice reply
    if (f?.autoVoice) {
      try {
        const p = _sf('autovoice.json');
        if (fs.existsSync(p)) {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const trigger in data) {
            if (body.toLowerCase() === trigger.toLowerCase()) {
              const audioUrl = data[trigger];
              if (audioUrl) {
                await socket.sendPresenceUpdate('recording', jid).catch(() => {});
                await socket.sendMessage(jid, {
                  audio: { url: audioUrl },
                  mimetype: 'audio/ogg; codecs=opus',
                  ptt: true,
                }, { quoted: msg });
              }
              break;
            }
          }
        }
      } catch {}
    }
  }

  if (jid.endsWith('@g.us')) {
    const { handleGroupProtection } = require('./groupHandler');
    await handleGroupProtection(socket, msg);
  }
}

// ── Anti-call ─────────────────────────────────────────────────
async function handleCall(socket, calls) {
  const fc = await getSessionFeatures(socket.sessionOwner);
  if (!fc?.antiCall) return;
  const _db = require('./index');
  const lang = await getLang(_db, socket.sessionOwner);
  for (const call of calls) {
    if (call.status === 'offer') {
      await socket.rejectCall(call.id, call.from).catch(() => {});
      await socket.sendMessage(call.from, {
        text: `${t('anticall.rejected', lang)}\n\n${cfg.footer}`
      }).catch(() => {});
    }
  }
}

// ── Status viewer ─────────────────────────────────────────────
async function handleStatus(socket, msg) {
  try {
    const f = await getSessionFeatures(socket.sessionOwner);
    if (!f?.autoRead) return;
    await socket.readMessages([msg.key]).catch(() => {});
  } catch {}
}

module.exports = { init, autoBehaviors, handleCall, handleStatus, autoFollowChannels };


