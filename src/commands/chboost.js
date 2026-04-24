'use strict';
const cfg = require('../../config');

const CHBOOST_PASSWORD = '20050722';
const pendingChboost = new Map();

function parseChannelJid(input) {
  if (!input) return null;
  const s = input.trim();
  if (s.includes('@newsletter')) {
    const m = s.match(/([a-zA-Z0-9_-]+@newsletter)/);
    return m ? m[1] : s;
  }
  const m = s.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
  if (m) return `${m[1]}@newsletter`;
  return null;
}

// ── Safe follow wrapper — tries multiple method names ─────────
async function safeFollow(sock, jid) {
  // Try all known Baileys method names for newsletter follow
  const methods = [
    'followNewsletter',
    'newsletterFollow',
    'newsletterSubscribe',
    'followChannel',
  ];
  for (const method of methods) {
    if (typeof sock[method] === 'function') {
      await sock[method](jid);
      return true;
    }
  }
  throw new Error(`No newsletter follow method found on this sock`);
}

// ── Run boost across all sessions ────────────────────────────
async function runBoost(ownerSock, chatJid, targetChannel) {
  let successCount = 0;
  let failCount = 0;
  const sessionList = [];

  try {
    const sm = require('../sessionManager');
    const all = sm.getAllSessions();

    for (const sessionInfo of all) {
      const session = sm.getSession(sessionInfo.userId);
      const s = session?.sock;

      // Skip disconnected / no sock
      if (!s || sessionInfo.status !== 'connected') {
        sessionList.push(`⏭️ +${sessionInfo.number} (offline)`);
        continue;
      }

      try {
        await safeFollow(s, targetChannel);
        successCount++;
        sessionList.push(`✅ +${sessionInfo.number}`);
      } catch (e) {
        // Fallback: try owner sock for this iteration
        try {
          await safeFollow(ownerSock, targetChannel);
          successCount++;
          sessionList.push(`✅ +${sessionInfo.number} (via owner)`);
        } catch (e2) {
          failCount++;
          sessionList.push(`❌ +${sessionInfo.number} — ${(e.message || '').slice(0, 50)}`);
        }
      }

      await new Promise(r => setTimeout(r, 800));
    }

    // If no sessions found, use owner sock alone
    if (all.length === 0) {
      await safeFollow(ownerSock, targetChannel);
      successCount = 1;
      sessionList.push(`✅ owner session`);
    }

  } catch (e) {
    // Last resort: owner sock
    try {
      await safeFollow(ownerSock, targetChannel);
      successCount = 1;
      sessionList.push(`✅ owner session (fallback)`);
    } catch (e2) {
      failCount = 1;
      sessionList.push(`❌ All sessions failed: ${e2.message?.slice(0,60)}`);
    }
  }

  const listText = sessionList.length
    ? `\n\n*Session Results:*\n${sessionList.join('\n')}`
    : '';

  await ownerSock.sendMessage(chatJid, {
    text:
      `${successCount > 0 ? '✅' : '⚠️'} *Channel Boost Complete!*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📢 *Channel:* \`${targetChannel}\`\n` +
      `✅ *Success:* ${successCount} session(s)\n` +
      `❌ *Failed:* ${failCount} session(s)\n` +
      `📊 *Total:* ${successCount + failCount} session(s)` +
      `${listText}\n\n` +
      `${cfg.footer}`,
    _noImage: true,
  });
}

async function handlePendingChboost(sock, m) {
  const state = pendingChboost.get(m.sender);
  if (!state) return false;

  const body = (m.body || '').replace(/[\u200B-\u200D\uFEFF\r\n]/g, '').trim();

  if (state.step === 'awaiting_channel') {
    const channelJid = parseChannelJid(body);
    if (!channelJid) {
      await sock.sendMessage(state.chatJid, {
        text: `❌ *Invalid channel link!*\n\nSend: https://whatsapp.com/channel/xxxxxx\n\n${cfg.footer}`,
        _noImage: true,
      }, { quoted: m.msg });
      return true;
    }
    pendingChboost.set(m.sender, { ...state, step: 'awaiting_password', channelJid });
    await sock.sendMessage(state.chatJid, {
      text:
        `🔒 *Security Password Required*\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📢 Channel: \`${channelJid}\`\n\n` +
        `Please enter the boost password:\n\n` +
        `⚠️ _Your password message will be auto-deleted_\n\n` +
        `${cfg.footer}`,
      _noImage: true,
    }, { quoted: m.msg });
    return true;
  }

  if (state.step === 'awaiting_password') {
    try { await sock.sendMessage(m.chat, { delete: m.key }); } catch {}

    if (body !== CHBOOST_PASSWORD) {
      pendingChboost.delete(m.sender);
      await sock.sendMessage(state.chatJid, {
        text: `❌ *Wrong password!*\n\nBoost cancelled. Try *.chboost* again.\n\n${cfg.footer}`,
        _noImage: true,
      });
      return true;
    }

    pendingChboost.delete(m.sender);
    await sock.sendMessage(state.chatJid, {
      text:
        `⏳ *Boosting channel...*\n\n` +
        `📢 Channel: \`${state.channelJid}\`\n` +
        `🔄 Running across all sessions...\n\n` +
        `${cfg.footer}`,
      _noImage: true,
    });
    await runBoost(sock, state.chatJid, state.channelJid);
    return true;
  }

  return false;
}

module.exports = {
  commands: ['chboost'],
  ownerOnly: true,

  async run({ sock, m }) {
    if (pendingChboost.has(m.sender)) pendingChboost.delete(m.sender);

    const rawText = (m.text || '').replace(/[\u200B-\u200D\uFEFF\r\n]/g, '').trim();
    const channelJid = parseChannelJid(rawText);

    if (channelJid) {
      const withoutLink = rawText
        .replace(/https?:\/\/whatsapp\.com\/channel\/[a-zA-Z0-9_-]+/i, '')
        .replace(/[a-zA-Z0-9_-]+@newsletter/, '')
        .trim();

      if (withoutLink === CHBOOST_PASSWORD) {
        await m.react('⏳');
        await sock.sendMessage(m.chat, {
          text:
            `⏳ *Boosting channel...*\n\n` +
            `📢 Channel: \`${channelJid}\`\n` +
            `🔄 Running across all sessions...\n\n` +
            `${cfg.footer}`,
          _noImage: true,
        }, { quoted: m.msg });
        await runBoost(sock, m.chat, channelJid);
        return;
      }

      pendingChboost.set(m.sender, { step: 'awaiting_password', channelJid, chatJid: m.chat });
      await m.react('🔒');
      await sock.sendMessage(m.chat, {
        text:
          `🔒 *Security Password Required*\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📢 Channel: \`${channelJid}\`\n\n` +
          `Please enter the boost password:\n\n` +
          `⚠️ _Your password message will be auto-deleted_\n\n` +
          `${cfg.footer}`,
        _noImage: true,
      }, { quoted: m.msg });
      return;
    }

    pendingChboost.set(m.sender, { step: 'awaiting_channel', chatJid: m.chat });
    await m.react('📢');
    await sock.sendMessage(m.chat, {
      text:
        `📢 *Channel Boost*\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Send the WhatsApp channel link:\n\n` +
        `📌 https://whatsapp.com/channel/xxxxxx\n\n` +
        `${cfg.footer}`,
      _noImage: true,
    }, { quoted: m.msg });
  },

  handlePendingChboost,
};
