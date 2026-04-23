'use strict';
const cfg = require('../../config');
const db = require('./index');
const fs = require('fs-extra');

// ── Group metadata cache (TTL: 60s) ──────────────────────────
const _metaCache = new Map();
const META_TTL = 60_000;
async function getCachedMeta(sock, jid) {
  const now = Date.now();
  const cached = _metaCache.get(jid);
  if (cached && (now - cached.ts) < META_TTL) return cached.data;
  const data = await sock.groupMetadata(jid);
  _metaCache.set(jid, { ts: now, data });
  return data;
}

// ── Get message body ──────────────────────────────────────────
function getBody(msg) {
  const m = msg.message;
  if (!m) return '';

  // interactiveResponseMessage — quick_reply button tap (Baileys v7)
  if (m.interactiveResponseMessage) {
    try {
      const nfr = m.interactiveResponseMessage?.nativeFlowResponseMessage;
      if (nfr?.paramsJson) {
        const parsed = JSON.parse(nfr.paramsJson);
        if (parsed?.id) return parsed.id;
      }
    } catch {}
    return m.interactiveResponseMessage?.body?.text || '';
  }

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

// ── Get quoted message ────────────────────────────────────────
function getQuoted(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  return {
    message: ctx.quotedMessage,
    sender:  ctx.participant || ctx.remoteJid,
    key: {
      remoteJid:   msg.key.remoteJid,
      fromMe:      ctx.participant === msg.key.remoteJid,
      id:          ctx.stanzaId,
      participant: ctx.participant,
    },
    type: Object.keys(ctx.quotedMessage)[0],
    body:
      ctx.quotedMessage.conversation ||
      ctx.quotedMessage.extendedTextMessage?.text ||
      ctx.quotedMessage.imageMessage?.caption ||
      ctx.quotedMessage.videoMessage?.caption || '',
  };
}

// ── Main parser ───────────────────────────────────────────────
async function parseMessage(sock, msg) {
  try {
    if (!msg.message) return null;

    const jid = msg.key.remoteJid;
    if (!jid) return null;

    if (jid === 'status@broadcast') return null;

    const isGroup = jid.endsWith('@g.us');
    const rawSender = isGroup
      ? (msg.key.participant || msg.participant || '')
      : jid;

    if (!rawSender) return null;

    // Normalise: strip device suffix (e.g. "94771234567:12@s.whatsapp.net" → "94771234567@s.whatsapp.net")
    // Without this, group messages with a device suffix produce a wrong senderNum
    // ("9477123456712" instead of "94771234567"), breaking isSessionOwner comparison
    // and db.getUser lookups for JadiBot session owners.
    const sender = rawSender.replace(/:\d+@/, '@');

    const senderNum = sender.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/[^0-9]/g, '');
    // sessionOwner = phone number of the person who paired this jadibot session
    const sessionOwner = sock.sessionOwner || 'config';
    const isSessionOwner = sessionOwner !== 'config' && senderNum === sessionOwner.replace(/[^0-9]/g, '');
    const isOwner = cfg.isOwnerNumber(senderNum) || msg.key.fromMe || isSessionOwner;

    const selfJid = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
    const isSelfChat = !isGroup && (jid === selfJid || msg.key.fromMe);

    const channel3Jid = cfg.channel3 || process.env.CHANNEL_JID_3 || '';
    const isFromChannel3 = channel3Jid && jid === channel3Jid;

    let isPaired = false;
    try {
      const user = await db.getUser(sender);
      isPaired = !!user?.isPaired;
    } catch (e) {}

    let category = 'normal';
    if (isOwner) {
      category = 'creator';
    } else if (isPaired && isSelfChat) {
      category = 'owner';
    } else if (isPaired) {
      category = 'pair';
    }

    if (msg.key.fromMe && !cfg.isDev && !isOwner) return null;

    const body   = getBody(msg);
    const prefix = cfg.prefixes.find(p => body.startsWith(p));
    const isCmd  = !!prefix;

    const msgType = Object.keys(msg.message || {})[0];

    // ── Button tap flag — interactiveResponseMessage + legacy types
    const isButtonTap = (
      msgType === 'interactiveResponseMessage' ||
      msgType === 'buttonsResponseMessage'     ||
      msgType === 'listResponseMessage'        ||
      msgType === 'templateButtonReplyMessage'
    );

    let command = '', args = [], text = '';

    if (isCmd) {
      const content = body.slice(prefix.length).trim();
      command = content.split(/\s+/)[0].toLowerCase();
      args    = content.split(/\s+/).slice(1);
      text    = args.join(' ');
    } else if (isButtonTap && body) {
      // ── Button tap without prefix (e.g. vdl_1, vdl_2, vdl_3) ──
      // Quick-reply button IDs like "vdl_1" have no dot prefix.
      // Treat the raw ID as a command so plugins can handle it.
      // If ID starts with a known prefix (e.g. ".menu"), strip it.
      const btnBody = body.trim();
      const btnPrefix = cfg.prefixes.find(p => btnBody.startsWith(p));
      if (btnPrefix) {
        const content = btnBody.slice(btnPrefix.length).trim();
        command = content.split(/\s+/)[0].toLowerCase();
        args    = content.split(/\s+/).slice(1);
        text    = args.join(' ');
      } else {
        // No prefix — use body directly as command (e.g. "vdl_1")
        command = btnBody.split(/\s+/)[0].toLowerCase();
        args    = btnBody.split(/\s+/).slice(1);
        text    = args.join(' ');
      }
      // Override isCmd so messageHandler processes it as a command
      // We reassign via the local var below; isButtonTap remains true
    }

    let isGroupAdmin = false;
    let isBotAdmin   = false;

    if (isGroup) {
      try {
        const meta  = await getCachedMeta(sock, jid);
        const botId = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
        isGroupAdmin = meta.participants.some(p =>
          p.id === sender &&
          (p.admin === 'admin' || p.admin === 'superadmin')
        );
        isBotAdmin = meta.participants.some(p =>
          p.id === botId &&
          (p.admin === 'admin' || p.admin === 'superadmin')
        );
      } catch (e) {}
    }

    const isMedia = [
      'imageMessage', 'videoMessage', 'audioMessage',
      'documentMessage', 'stickerMessage',
    ].includes(msgType);

    const quoted = getQuoted(msg);

    async function reply(text, opts = {}) {
      // ── Status reply: use contextInfo instead of quoted ──────
      const isStatusCtx = msg?.key?.remoteJid === 'status@broadcast' ||
        msg?.message?.extendedTextMessage?.contextInfo?.remoteJid === 'status@broadcast';
      if (isStatusCtx) {
        const statusSender = msg.key?.participant || msg.key?.remoteJid || sender;
        return sock.sendMessage(jid, {
          text,
          contextInfo: {
            remoteJid: 'status@broadcast',
            fromMe: false,
            participant: statusSender,
            stanzaId: msg.key?.id,
            quotedMessage: msg.message,
          },
          ...opts,
        });
      }
      return sock.sendMessage(jid, { text, ...opts }, { quoted: msg });
    }

    async function replyWithThumb(text) {
      const thumbPath = './src/media/unity_thumb.jpg';
      if (fs.existsSync(thumbPath)) {
        const thumb = await fs.readFile(thumbPath);
        return sock.sendMessage(jid, { image: thumb, caption: text }, { quoted: msg });
      }
      return reply(text);
    }

    async function react(emoji) {
      return sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
    }

    async function replyAutoDelete(text, footer = cfg.footer) {
      const secs = cfg.limits.autoDeleteSecs;
      const interval = 30;

      function secsToText(s) {
        if (s <= 0) return '🗑️ *Deleting...*';
        const mn = Math.floor(s / 60), r = s % 60;
        if (mn > 0 && r > 0) return `⏱️ *Deletes in ${mn}m ${r}s*`;
        if (mn > 0) return `⏱️ *Deletes in ${mn} minutes*`;
        return `⏱️ *Deletes in ${r} seconds*`;
      }

      const sent = await sock.sendMessage(
        jid,
        { text: `${text}\n${secsToText(secs)}\n${footer}`, _noImage: true },
        { quoted: msg }
      );

      if (!sent?.key) return sent;

      sock.sendMessage(jid, { delete: msg.key }).catch(() => {});

      let remaining = secs;
      const timer = setInterval(async () => {
        remaining -= interval;
        if (remaining <= 0) {
          clearInterval(timer);
          sock.sendMessage(jid, { delete: sent.key }).catch(() => {});
          return;
        }
        sock.sendMessage(jid, {
          text: `${text}\n${secsToText(remaining)}\n${footer}`,
          edit: sent.key,
        }).catch(() => {});
      }, interval * 1000);

      setTimeout(() => {
        clearInterval(timer);
        sock.sendMessage(jid, { delete: sent.key }).catch(() => {});
      }, (secs + 10) * 1000);

      return sent;
    }

    async function sendAudio(buffer, ptt = false) {
      return sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt }, { quoted: msg });
    }

    async function sendVideo(buffer, caption = '') {
      return sock.sendMessage(jid, { video: buffer, caption }, { quoted: msg });
    }

    async function sendImage(buffer, caption = '') {
      return sock.sendMessage(jid, { image: buffer, caption }, { quoted: msg });
    }

    async function sendSticker(buffer) {
      return sock.sendMessage(jid, { sticker: buffer });
    }

    return {
      key:             msg.key,
      jid,
      chat:            jid,
      sender,
      senderNum,
      pushName:        msg.pushName || 'User',
      isGroup,
      isGroupAdmin,
      isBotAdmin,
      isOwner,
      isPaired,
      isSelfChat,
      isFromChannel3,
      sessionOwner,
      category,
      isCmd:           isCmd || (isButtonTap && !!command), // button taps with command treated as cmd
      isButtonTap,
      command,
      args,
      text,
      prefix,
      body,
      msg,
      msgType,
      message:         msg.message,
      isMedia,
      quoted,
      footer:          cfg.footer,
      reply,
      replyWithThumb,
      react,
      replyAutoDelete,
      sendAudio,
      sendVideo,
      sendImage,
      sendSticker,
    };

  } catch (e) {
    return null;
  }
}

module.exports = { parseMessage };
