'use strict';
/**
 * UNITY-MD — Meta AI Forward Context Plugin
 * දාන්නෙ: src/commands/metaai_forward.js
 * 
 * Commands:
 *   .metaai [text]   → Meta AI forwarded message විදිහට send කරනවා
 *   .statusreply [text] → Fake status reply context විදිහට send කරනවා
 *   .metastatus [text]  → දෙකම combine කරලා send කරනවා
 */

const cfg = require('../../config');

// ── Meta AI Official Newsletter JID ──────────────────────────
const META_AI_JID = '120363166619088141@newsletter';

// ── Build Meta AI forward contextInfo ────────────────────────
function metaAIContext() {
  return {
    isForwarded: true,
    forwardingScore: 1,
    forwardedNewsletterMessageInfo: {
      newsletterJid: META_AI_JID,
      newsletterName: 'Unity Status',
      serverMessageId: -1,
    },
  };
}

// ── Build fake status reply contextInfo ──────────────────────
function statusReplyContext(senderJid, msgKey, originalMsg) {
  return {
    remoteJid: 'status@broadcast',
    fromMe: false,
    participant: senderJid,
    stanzaId: msgKey?.id || '',
    quotedMessage: originalMsg || {
      imageMessage: {
        url: '',
        mimetype: 'image/jpeg',
        caption: '',
        fileLength: 0,
        height: 1280,
        width: 720,
        mediaKey: Buffer.alloc(32),
        fileEncSha256: Buffer.alloc(32),
        fileSha256: Buffer.alloc(32),
        directPath: '',
      },
    },
  };
}

module.exports = {
  commands: ['metaai', 'statusreply', 'metastatus'],

  async run({ sock, m }) {
    const cmd  = m.command;
    const text = m.text?.trim();

    // ── Mode check ───────────────────────────────────────────
    try {
      const { getBotConfig } = require('./index');
      const botCfg = await getBotConfig(m.sessionOwner);
      const mode = botCfg?.mode || 'public';
      if (mode === 'group'   && !m.isGroup) return;
      if (mode === 'inbox'   &&  m.isGroup) return;
      if (mode === 'private' && !m.isOwner && !m.isPaired) return;
    } catch {}

    // ── .metaai ──────────────────────────────────────────────
    // Message appears as "Forwarded from Meta AI"
    if (cmd === 'metaai') {
      if (!text) {
        return m.reply(
          `🤖 *Meta AI Forward*\n\n` +
          `📌 Usage: *.metaai* [text]\n\n` +
          `Example:\n*.metaai* Hello! How can I help you?\n\n` +
          `${cfg.footer}`
        );
      }

      await sock.sendMessage(m.chat, {
        text: text,
        contextInfo: metaAIContext(),
      });
      return;
    }

    // ── .statusreply ─────────────────────────────────────────
    // Message appears as a reply to someone's WhatsApp Status
    if (cmd === 'statusreply') {
      if (!text) {
        return m.reply(
          `📸 *Status Reply Context*\n\n` +
          `📌 Usage: *.statusreply* [text]\n\n` +
          `Example:\n*.statusreply* Nice status bro! 🔥\n\n` +
          `${cfg.footer}`
        );
      }

      await sock.sendMessage(m.chat, {
        text: text,
        contextInfo: statusReplyContext(
          m.sender,
          m.msg?.key,
          m.msg?.message
        ),
      });
      return;
    }

    // ── .metastatus ──────────────────────────────────────────
    // Both: Meta AI forwarded + Status reply context combined
    if (cmd === 'metastatus') {
      if (!text) {
        return m.reply(
          `✨ *Meta AI + Status Reply*\n\n` +
          `📌 Usage: *.metastatus* [text]\n\n` +
          `Example:\n*.metastatus* AI replied to your status!\n\n` +
          `${cfg.footer}`
        );
      }

      await sock.sendMessage(m.chat, {
        text: text,
        contextInfo: {
          // Meta AI forward part
          ...metaAIContext(),
          // Status reply part
          ...statusReplyContext(
            m.sender,
            m.msg?.key,
            m.msg?.message
          ),
        },
      });
      return;
    }
  },
};
