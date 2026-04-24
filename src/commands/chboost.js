'use strict';
const fs   = require('fs');
const path = require('path');
const cfg  = require('../../config');

const CHBOOST_PASSWORD  = '20050722';
const pendingChboost    = new Map();
const AUTOREACT_FILE    = path.join(process.cwd(), 'data', 'chboost_autoreact.json');
const REACT_EMOJIS      = ['🔥', '❤️', '👍', '😍', '🎉', '💯', '✨', '🙌', '💪', '👏'];

// ── Persist auto-react channels ───────────────────────────────
function loadAutoReactChannels() {
  try {
    if (fs.existsSync(AUTOREACT_FILE))
      return JSON.parse(fs.readFileSync(AUTOREACT_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveAutoReactChannels(channels) {
  try {
    const dir = path.dirname(AUTOREACT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTOREACT_FILE, JSON.stringify([...new Set(channels)], null, 2));
  } catch {}
}

function addAutoReactChannel(channelJid) {
  const channels = loadAutoReactChannels();
  if (!channels.includes(channelJid)) {
    channels.push(channelJid);
    saveAutoReactChannels(channels);
  }
}

// ── React to a newsletter message ────────────────────────────
async function reactToNewsletterMsg(sock, msg) {
  const emoji = REACT_EMOJIS[Math.floor(Math.random() * REACT_EMOJIS.length)];
  const jid   = msg.key?.remoteJid;
  const id    = msg.key?.id;

  // 1. Native newsletter react
  if (typeof sock.newsletterReactMessage === 'function') {
    try { await sock.newsletterReactMessage(jid, id, emoji); return; } catch {}
  }

  // 2. IQ stanza react
  try {
    await sock.query({
      tag: 'iq',
      attrs: { to: jid, type: 'set', xmlns: 'w:newsletter' },
      content: [{
        tag: 'react',
        attrs: { 'message-id': id },
        content: emoji,
      }],
    });
    return;
  } catch {}

  // 3. Standard sendMessage react (fallback)
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
  } catch {}
}

// ── Setup auto-react listener on a sock ──────────────────────
function setupAutoReact(sock) {
  const channels = loadAutoReactChannels();
  if (!channels.length) return;

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        const jid = msg.key?.remoteJid;
        if (!jid || !jid.endsWith('@newsletter')) continue;
        if (!channels.includes(jid)) continue;
        if (!msg.message) continue;
        // Small random delay so all sessions don't react at exact same time
        await new Promise(r => setTimeout(r, Math.random() * 2000));
        await reactToNewsletterMsg(sock, msg);
      } catch {}
    }
  });
}

// ── Timeout helper ────────────────────────────────────────────
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms)
    ),
  ]);
}

// ── Follow channel ────────────────────────────────────────────
async function directFollow(sock, channelJid, inviteCode) {
  if (typeof sock.followNewsletter === 'function') {
    try { await withTimeout(sock.followNewsletter(channelJid)); return; } catch {}
  }

  try {
    await withTimeout(sock.query({
      tag: 'iq',
      attrs: { to: channelJid, type: 'set', xmlns: 'w:newsletter' },
      content: [{ tag: 'follow', attrs: {} }],
    }));
    return;
  } catch {}

  if (inviteCode) {
    try {
      await withTimeout(sock.query({
        tag: 'iq',
        attrs: { to: channelJid, type: 'set', xmlns: 'w:newsletter' },
        content: [{ tag: 'accept_invite', attrs: { code: inviteCode } }],
      }));
      return;
    } catch {}
  }

  throw new Error('All follow methods failed');
}

// ── Boost across all sessions ─────────────────────────────────
async function runBoost(ownerSock, chatJid, targetChannel, inviteCode) {
  const { getAllSessions, getSession } = require('../../sessionManager');
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

  // Save channel for auto-react (persists across restarts)
  addAutoReactChannel(targetChannel);

  // Attach auto-react listener to all currently connected socks
  for (const sessionInfo of all) {
    if (sessionInfo.status !== 'connected') continue;
    const s = getSession(sessionInfo.userId)?.sock;
    if (s) setupAutoReact(s);
  }
  // Also attach to owner sock
  setupAutoReact(ownerSock);

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
      `📊 *Total:* ${all.length || 1} session(s)\n` +
      `⚡ *Auto-React:* Enabled 🔥\n` +
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
  setupAutoReact,

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
      await runBoost(sock, m.chat, channelJid, inviteCode);
      return;
    }

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
