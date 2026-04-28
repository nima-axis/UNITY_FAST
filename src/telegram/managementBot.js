'use strict';
/**
 * UNITY-MD — Telegram Management Bot
 * Token: TG_MGMT_BOT_TOKEN
 *
 * Commands:
 *   /ping                         — latency check
 *   /runtime                      — bot uptime
 *   /which                        — connected WA session count
 *   /react <link>, <link>, ...    — react to WA channel posts (all sessions)
 */

const TelegramBot = require('node-telegram-bot-api');
const logger      = require('../commands/logger');

let bot = null;

// ── Admin gate ────────────────────────────────────────────────
// TG_ADMIN_IDS = "123456789,987654321" (optional)
// If empty → open to all (bot is private by token anyway)
const _adminIds = (process.env.TG_ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAdmin(msg) {
  if (!_adminIds.length) return true;
  return _adminIds.includes(String(msg.from?.id));
}

// ── Uptime formatter ──────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Parse WA channel post links ───────────────────────────────
// Supports:
//   https://whatsapp.com/channel/INVITE_CODE/12345
//   https://whatsapp.com/channel/INVITE_CODE
// Returns: { inviteCode, msgId } or null
function parsePostLink(raw) {
  const s = (raw || '').trim().replace(/['"]/g, '');
  // With post ID
  const m1 = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)\/(\d+)/i);
  if (m1) return { inviteCode: m1[1], msgId: m1[2] };
  // Without post ID (channel link only)
  const m2 = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (m2) return { inviteCode: m2[1], msgId: null };
  return null;
}

// ── React to a single post across all connected sessions ──────
// Returns: { successCount, failCount, total, skippedReason }
async function reactToPost(inviteCode, msgId, emoji = '❤️') {
  const sm = global.unitySessionManager;
  if (!sm) return { successCount: 0, failCount: 0, total: 0, skippedReason: 'Session manager not ready' };

  const allSessions = sm.getAllSessions();
  const connected   = allSessions.filter(s => s.status === 'connected');

  if (!connected.length) return { successCount: 0, failCount: 0, total: 0, skippedReason: 'No connected sessions' };

  let successCount = 0, failCount = 0;

  for (const sessInfo of connected) {
    const sess = sm.getSession(sessInfo.userId);
    const sock = sess?.sock;
    if (!sock) { failCount++; continue; }

    let reactMsgId = msgId;

    try {
      // Step 1: Resolve real newsletter JID
      let realJid = null;
      try {
        const meta = await sock.newsletterMetadata('invite', inviteCode);
        realJid = meta?.id;
      } catch {}
      if (!realJid) realJid = inviteCode + '@newsletter';

      // Step 2: If no msgId, fetch latest post
      if (!reactMsgId) {
        try {
          const msgs = await sock.newsletterFetchMessages('direct', realJid, 5);
          const list = Array.isArray(msgs) ? msgs : msgs?.messages || [];
          if (list.length) reactMsgId = list[0]?.key?.id;
        } catch {}

        // Fallback: invite mode fetch
        if (!reactMsgId) {
          try {
            const msgs2 = await sock.newsletterFetchMessages('invite', inviteCode, 5);
            const list2 = Array.isArray(msgs2) ? msgs2 : msgs2?.messages || [];
            if (list2.length) reactMsgId = list2[0]?.key?.id;
          } catch {}
        }
      }

      if (!reactMsgId) { failCount++; continue; }

      // Step 3: React — method 1: newsletterReactMessage
      let reacted = false;
      try {
        await sock.newsletterReactMessage(realJid, reactMsgId, emoji);
        reacted = true;
      } catch (e1) {
        // Method 2: sendMessage react fallback
        try {
          await sock.sendMessage(realJid, {
            react: { text: emoji, key: { id: reactMsgId, remoteJid: realJid } },
          });
          reacted = true;
        } catch {}
      }

      if (reacted) successCount++;
      else failCount++;

    } catch (e) {
      logger.warn(`[TG-MGMT] React error for ${sessInfo.userId}: ${e.message}`);
      failCount++;
    }

    // Throttle between sessions
    await new Promise(r => setTimeout(r, 250));
  }

  return { successCount, failCount, total: connected.length };
}

// ── Start bot ─────────────────────────────────────────────────
function start() {
  const TOKEN = process.env.TG_MGMT_BOT_TOKEN;
  if (!TOKEN) {
    logger.warn('[TG-MGMT] TG_MGMT_BOT_TOKEN not set — management bot disabled');
    return;
  }

  bot = new TelegramBot(TOKEN, { polling: true });
  bot.on('polling_error', err => logger.error(`[TG-MGMT] Polling error: ${err.message}`));

  // ── /ping ─────────────────────────────────────────────────
  bot.onText(/^\/ping(@\S+)?$/, async (msg) => {
    if (!isAdmin(msg)) return;
    const t = Date.now();
    const sent = await bot.sendMessage(msg.chat.id, '🏓 Pinging...');
    const latency = Date.now() - t;
    bot.editMessageText(
      `🏓 *Pong!*\n\n⚡ Latency: \`${latency}ms\``,
      { chat_id: msg.chat.id, message_id: sent.message_id, parse_mode: 'Markdown' }
    );
  });

  // ── /runtime ──────────────────────────────────────────────
  bot.onText(/^\/runtime(@\S+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    const uptime = formatUptime(Math.floor(process.uptime()));
    const mem    = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    bot.sendMessage(msg.chat.id,
      `⏱ *Bot Runtime*\n\n` +
      `🕐 Uptime: \`${uptime}\`\n` +
      `💾 RAM: \`${mem} MB\`\n` +
      `🟢 Node: \`${process.version}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /which ────────────────────────────────────────────────
  bot.onText(/^\/which(@\S+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    const sm = global.unitySessionManager;
    if (!sm) return bot.sendMessage(msg.chat.id, '❌ Session manager not ready.');

    const all       = sm.getAllSessions();
    const connected = all.filter(s => s.status === 'connected');
    const pairing   = all.filter(s => s.status === 'pairing');
    const others    = all.filter(s => s.status !== 'connected' && s.status !== 'pairing');

    const lines = connected.map((s, i) =>
      `${i + 1}. \`+${s.number || s.userId}\` ${s.name ? `(${s.name})` : ''}`
    ).join('\n') || '_None_';

    bot.sendMessage(msg.chat.id,
      `📱 *Connected Sessions*\n\n` +
      `🟢 Connected: *${connected.length}*\n` +
      `🔄 Pairing: *${pairing.length}*\n` +
      `⚫ Other: *${others.length}*\n` +
      `📊 Total: *${all.length}*\n\n` +
      `*Numbers:*\n${lines}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /react <link1>, <link2>, ... ──────────────────────────
  // Format: /react https://whatsapp.com/channel/XXX/123, https://...
  // Emoji: defaults to BOOST_EMOJI env (❤️)
  bot.onText(/^\/react(@\S+)?\s+([\s\S]+)$/, async (msg, match) => {
    if (!isAdmin(msg)) return;

    const raw   = (match[2] || '').trim();
    const emoji = process.env.BOOST_EMOJI || '❤️';

    // Split by comma, filter valid links
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    const links = parts
      .map(p => ({ raw: p, parsed: parsePostLink(p) }))
      .filter(x => x.parsed !== null);

    if (!links.length) {
      return bot.sendMessage(msg.chat.id,
        `❌ No valid post links found.\n\nFormat:\n\`/react https://whatsapp.com/channel/XXX/123\`\n\nMultiple:\n\`/react link1, link2, link3\``,
        { parse_mode: 'Markdown' }
      );
    }

    const sm = global.unitySessionManager;
    if (!sm) return bot.sendMessage(msg.chat.id, '❌ Session manager not ready.');

    const connected = sm.getAllSessions().filter(s => s.status === 'connected');
    if (!connected.length) {
      return bot.sendMessage(msg.chat.id, '❌ No connected WA sessions.');
    }

    const statusMsg = await bot.sendMessage(msg.chat.id,
      `${emoji} *React Boost Starting...*\n\n` +
      `📋 Posts: *${links.length}*\n` +
      `📱 Sessions: *${connected.length}*\n\n` +
      `⏳ Processing...`,
      { parse_mode: 'Markdown' }
    );

    const results = [];

    for (let i = 0; i < links.length; i++) {
      const { inviteCode, msgId } = links[i].parsed;
      const label = `Post ${i + 1}`;

      logger.info(`[TG-MGMT] Reacting to ${label} — inviteCode=${inviteCode} msgId=${msgId}`);

      const r = await reactToPost(inviteCode, msgId, emoji);

      if (r.skippedReason) {
        results.push(`${label}: ⚠️ ${r.skippedReason}`);
      } else {
        results.push(`${label}: ✅ ${r.successCount}/${r.total} • ❌ ${r.failCount}`);
      }

      // Update status message after each post
      await bot.editMessageText(
        `${emoji} *React Boost*\n\n` +
        `📋 Posts: *${links.length}* (done: ${i + 1})\n` +
        `📱 Sessions: *${connected.length}*\n\n` +
        results.map(l => `• ${l}`).join('\n'),
        { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});

      // Small delay between posts
      if (i < links.length - 1) await new Promise(r => setTimeout(r, 600));
    }

    // Final update
    const totalSuccess = results.filter(l => l.includes('✅')).length;
    bot.editMessageText(
      `${emoji} *React Boost Complete!*\n\n` +
      `📋 Posts: *${links.length}*\n` +
      `📱 Sessions: *${connected.length}*\n` +
      `✅ Success: *${totalSuccess}/${links.length} posts*\n\n` +
      results.map(l => `• ${l}`).join('\n'),
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});

    logger.info(`[TG-MGMT] React boost done — ${links.length} posts, ${connected.length} sessions`);
  });

  // ── /react with no args ───────────────────────────────────
  bot.onText(/^\/react(@\S+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    bot.sendMessage(msg.chat.id,
      `ℹ️ *Usage*\n\n` +
      `Single post:\n\`/react https://whatsapp.com/channel/XXX/123\`\n\n` +
      `Multiple posts:\n\`/react link1, link2, link3\``,
      { parse_mode: 'Markdown' }
    );
  });

  logger.info('[TG-MGMT] Management bot started ✅');
}

module.exports = { start };
