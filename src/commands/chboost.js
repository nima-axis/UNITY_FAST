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

function parseInviteCode(input) {
  if (!input) return null;
  const m = input.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : null;
}

// ── Follow: newsletter → IQ (original format) → invite accept ─
async function directFollow(sock, channelJid, inviteCode) {
  // 1. Native method
  if (typeof sock.followNewsletter === 'function') {
    try {
      await sock.followNewsletter(channelJid);
      return;
    } catch {}
  }

  // 2. IQ stanza — correct Baileys format (to = channelJid)
  try {
    await sock.query({
      tag: 'iq',
      attrs: { to: channelJid, type: 'set', xmlns: 'w:newsletter' },
      content: [{ tag: 'follow', attrs: {} }],
    });
    return;
  } catch {}

  // 3. Fallback: newsletter invite accept via direct link code
  if (inviteCode) {
    await sock.query({
      tag: 'iq',
      attrs: { to: channelJid, type: 'set', xmlns: 'w:newsletter' },
      content: [{ tag: 'accept_invite', attrs: { code: inviteCode } }],
    });
    return;
  }

  throw new Error('All follow methods failed');
}

// ── Boost across all sessions ─────────────────────────────────
async function runBoost(ownerSock, chatJid, targetChannel, inviteCode) {
  const { getAllSessions, getSession } = require('../sessionManager');
  const all = getAllSessions();

  let successCount = 0;
  let failCount    = 0;
  const sessionList = [];

  for (const sessionInfo of all) {
    if (sessionInfo.status !== 'connected') {
      sessionList.push(`⏭️ +${sessionInfo.number} (offline)`);
      continue;
    }
    const s = getSession(sessionInfo.userId)?.sock;
    if (!s) continue;
    try {
      await directFollow(s, targetChannel, inviteCode);
      successCount++;
      sessionList.push(`✅ +${sessionInfo.number}`);
    } catch (e) {
      failCount++;
      sessionList.push(`❌ +${sessionInfo.number} — ${(e.message || '').slice(0, 55)}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (all.length === 0) {
    try {
      await directFollow(ownerSock, targetChannel, inviteCode);
      successCount = 1;
    } catch (e) {
      failCount = 1;
      sessionList.push(`❌ owner — ${(e.message || '').slice(0, 55)}`);
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
      `📊 *Total:* ${all.length || 1} session(s)` +
      `${listText}\n\n` +
      `${cfg.footer}`,
    _noImage: true,
  });
}

// ── Pending handler ───────────────────────────────────────────
async function handlePendingChboost(sock, m) {
  const state = pendingChboost.get(m.sender);
  if (!state) return false;

  const body = (m.body || '').replace(/[\u200B-\u200D\uFEFF\r\n]/g, '').trim();

  // Step: waiting for password
  if (state.step === 'awaiting_password') {
    try { await sock.sendMessage(m.chat, { delete: m.key }); } catch {}

    if (body !== CHBOOST_PASSWORD) {
      pendingChboost.delete(m.sender);
      await sock.sendMessage(state.chatJid, {
        text: `❌ *Wrong password!*\n\nTry *.chboost <link>* again.\n\n${cfg.footer}`,
        _noImage: true,
      });
      return true;
    }

    pendingChboost.delete(m.sender);
    await m.react('⏳');
    await sock.sendMessage(state.chatJid, {
      text:
        `⏳ *Boosting channel...*\n\n` +
        `📢 Channel: \`${state.channelJid}\`\n` +
        `🔄 Running across all sessions...\n\n` +
        `${cfg.footer}`,
      _noImage: true,
    });
    await runBoost(sock, state.chatJid, state.channelJid, state.inviteCode);
    return true;
  }

  return false;
}

module.exports = {
  commands: ['chboost'],
  ownerOnly: false,

  async run({ sock, m }) {
    if (pendingChboost.has(m.sender)) pendingChboost.delete(m.sender);

    const rawText = (m.text || '').replace(/[\u200B-\u200D\uFEFF\r\n]/g, '').trim();
    const channelJid = parseChannelJid(rawText);
    const inviteCode = parseInviteCode(rawText);

    if (!channelJid) {
      return m.reply(
        `📢 *Channel Boost*\n\n` +
        `Usage: *.chboost* https://whatsapp.com/channel/xxx\n\n` +
        `${cfg.footer}`
      );
    }

    // Check if password also inline
    const withoutLink = rawText
      .replace(/https?:\/\/whatsapp\.com\/channel\/[a-zA-Z0-9_-]+/i, '')
      .replace(/[a-zA-Z0-9_-]+@newsletter/, '')
      .trim();

    if (withoutLink === CHBOOST_PASSWORD) {
      // One-shot with password
      await m.react('⏳');
      await sock.sendMessage(m.chat, {
        text:
          `⏳ *Boosting channel...*\n\n` +
          `📢 Channel: \`${channelJid}\`\n` +
          `🔄 Running across all sessions...\n\n` +
          `${cfg.footer}`,
        _noImage: true,
      }, { quoted: m.msg });
      await runBoost(sock, m.chat, channelJid, inviteCode);
      return;
    }

    // Ask for password
    pendingChboost.set(m.sender, {
      step: 'awaiting_password',
      channelJid,
      inviteCode,
      chatJid: m.chat,
    });
    await m.react('🔒');
    await sock.sendMessage(m.chat, {
      text:
        `🔒 *Password Required*\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📢 Channel: \`${channelJid}\`\n\n` +
        `Enter boost password:\n\n` +
        `⚠️ _Password message will be auto-deleted_\n\n` +
        `${cfg.footer}`,
      _noImage: true,
    }, { quoted: m.msg });
  },

  handlePendingChboost,
};
