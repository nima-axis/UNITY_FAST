'use strict';
/**
 * UNITY-MD — Telegram Management Bot
 * Token: TG_MGMT_BOT_TOKEN
 *
 * Commands:
 *   /start                                — control panel
 *   /ping                                 — latency check
 *   /runtime                              — uptime & memory
 *   /which                                — connected WA sessions
 *   /react (emoji...) link, link, ...     — react boost channel posts
 *
 * React format:
 *   /react (❣️😍💘) https://whatsapp.com/channel/XXX/2789
 *   /react (❤️) link1, link2, link3
 */

const TelegramBot = require('node-telegram-bot-api');
const logger      = require('../commands/logger');
const path        = require('path');
const fs          = require('fs');
const db          = require('../commands/index');

let bot = null;

// ── Notify via Telegram instead of WhatsApp ───────────────────
const TG_NOTIFY_ID = '7752365037';
async function tgNotify(text) {
  try {
    if (bot) await bot.sendMessage(TG_NOTIFY_ID, text, { parse_mode: 'HTML' });
  } catch (_e) {}
}

// ═══════════════════════════════════════════════════════════════
// ── /edit — Super Owner Panel constants & helpers ────────────
// ═══════════════════════════════════════════════════════════════
const EDIT_OWNERS   = new Set(['7752365037', '6794311904']);
const EDIT_PASSWORD = 'pn2026';
const _BLOCKED_FILE = path.join(__dirname, '../../data/blocked.json');

function _loadBlocked() {
  try { return new Set(JSON.parse(fs.readFileSync(_BLOCKED_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function _saveBlocked(set) {
  try { fs.writeFileSync(_BLOCKED_FILE, JSON.stringify([...set]), 'utf8'); } catch (e) {
    logger.warn('[TG-MGMT] saveBlocked failed: ' + e.message);
  }
}
// Per-chat state for /edit flow
const editState = new Map();

// ── Admin gate ────────────────────────────────────────────────
const _adminIds = (process.env.TG_ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(msg) {
  if (!_adminIds.length) return true;
  return _adminIds.includes(String(msg.from && msg.from.id ? msg.from.id : msg.from));
}

// ── Uptime formatter ──────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

// ── Parse emojis from "(❣️😍💘💝❤️‍🔥)" ─────────────────────────
function parseEmojiBlock(raw) {
  const m = raw.match(/^\(([^)]+)\)/);
  if (!m) return null;
  const block = m[1].trim();
  // Split by grapheme clusters using Intl.Segmenter (Node 16+)
  try {
    const seg = new Intl.Segmenter();
    return [...seg.segment(block)]
      .map(s => s.segment.trim())
      .filter(s => s.length > 0);
  } catch {
    // Fallback: split on zero-width boundaries — handles most cases
    return [...block].filter(c => c.trim().length > 0);
  }
}

// ── Parse WA channel post links ───────────────────────────────
function parsePostLink(raw) {
  const s = (raw || '').trim().replace(/['"]/g, '');
  const m1 = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)\/(\d+)/i);
  if (m1) return { inviteCode: m1[1], msgId: m1[2] };
  const m2 = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (m2) return { inviteCode: m2[1], msgId: null };
  return null;
}

// ── Proven react logic (ported from dashboard/server.js) ──────

// Fetch newsletter messages — try direct then legacy
async function fetchMsgs(sock, jid, count) {
  count = count || 10;
  const fullJid = jid.includes('@newsletter') ? jid : jid + '@newsletter';
  try {
    const res = await sock.newsletterFetchMessages('direct', fullJid, count);
    const list = Array.isArray(res) ? res : (res && res.messages) || [];
    if (list.length) return list;
  } catch (e1) { logger.warn('[TG-MGMT] fetchMsgs direct failed: ' + e1.message); }
  try {
    const res = await sock.fetchNewsletterMessages(fullJid, count);
    const list = Array.isArray(res) ? res : (res && res.messages) || [];
    if (list.length) return list;
  } catch {}
  return [];
}

// Resolve msgId + realJid for a given channel + optional known msgId
async function resolveMsgTarget(sock, channelJid, knownMsgId) {
  if (!channelJid) return { ok: false, reason: 'no channel JID' };

  let channelRawId = channelJid.replace('@newsletter', '').trim();
  const mLink = channelRawId.match(/whatsapp\.com\/channel\/([\w-]+)/);
  if (mLink) channelRawId = mLink[1];

  let msgId = null;

  // Priority 1: explicit msgId from post link
  if (knownMsgId) {
    msgId = String(knownMsgId);
  }

  // Priority 2: fetch latest post from WA
  if (!msgId) {
    const realJid = channelRawId + '@newsletter';
    let msgs = await fetchMsgs(sock, realJid);

    // If empty, follow channel first then retry
    if (!msgs.length) {
      try {
        const followMethods = ['followNewsletter', 'newsletterFollow', 'newsletterSubscribe', 'followChannel'];
        for (const fm of followMethods) {
          if (typeof sock[fm] === 'function') { await sock[fm](realJid); break; }
        }
        await new Promise(r => setTimeout(r, 1200));
      } catch (fe) { logger.warn('[TG-MGMT] Follow before fetch failed: ' + fe.message); }
      msgs = await fetchMsgs(sock, realJid);
    }

    // Last resort: invite mode
    if (!msgs.length) {
      try {
        const res = await sock.newsletterFetchMessages('invite', channelRawId, 5);
        const list = Array.isArray(res) ? res : (res && res.messages) || [];
        if (list.length) msgs = list;
      } catch {}
    }

    if (msgs.length) {
      msgId = msgs[0] && msgs[0].key && msgs[0].key.id;
    }
  }

  if (!msgId) return { ok: false, reason: 'no posts fetched — paste post link with message ID' };

  // Resolve real newsletter JID
  let realJid = null;
  try {
    const meta = await sock.newsletterMetadata('invite', channelRawId);
    realJid = meta && meta.id;
  } catch {}
  if (!realJid) realJid = channelRawId + '@newsletter';

  return { ok: true, msgId, channelRawId, realJid };
}

// React a single emoji to a resolved target
async function reactOneEmoji(sock, target, emoji) {
  const msgId   = target.msgId;
  const realJid = target.realJid;
  try {
    await sock.newsletterReactMessage(realJid, msgId, emoji);
    return { ok: true, method: 1 };
  } catch (e1) {
    logger.warn('[TG-MGMT] react method1(' + emoji + ') failed: ' + e1.message);
  }
  try {
    await sock.sendMessage(realJid, {
      react: { text: emoji, key: { id: msgId, remoteJid: realJid } },
    });
    return { ok: true, method: 2 };
  } catch (e2) {
    logger.warn('[TG-MGMT] react method2(' + emoji + ') failed: ' + e2.message);
  }
  return { ok: false, reason: 'all react methods failed' };
}

// React to a post across all sessions with multi-emoji round-robin
async function reactAllSessions(inviteCode, msgId, emojis, onProgress) {
  let sm = global.unitySessionManager;
  if (!sm) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      sm = global.unitySessionManager;
      if (sm) break;
    }
  }
  if (!sm) return { successCount: 0, failCount: 0, total: 0, skippedReason: 'Session manager not ready' };

  const connected = sm.getAllSessions().filter(s => s.status === 'connected');
  if (!connected.length) return { successCount: 0, failCount: 0, total: 0, skippedReason: 'No connected sessions' };

  let successCount = 0, failCount = 0;

  for (let i = 0; i < connected.length; i++) {
    const sessInfo = connected[i];
    const sess     = sm.getSession(sessInfo.userId);
    const sock     = sess && sess.sock;
    const num      = sessInfo.number || sessInfo.userId;

    if (!sock) {
      failCount++;
      if (onProgress) onProgress({ num, ok: false, reason: 'offline / no sock' });
      continue;
    }

    // Resolve target (retry once)
    let target = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const resolved = await resolveMsgTarget(sock, inviteCode + '@newsletter', msgId);
      if (resolved.ok) { target = resolved; break; }
      if (attempt < 2) await new Promise(r => setTimeout(r, 800));
    }

    if (!target) {
      failCount++;
      if (onProgress) onProgress({ num, ok: false, reason: 'could not resolve post' });
      // Notify via WA
      tgNotify('❌ <b>+' + num + '</b>\nreact fail\nReason: could not resolve post').catch(()=>{});
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    // Assign emoji — round-robin across sessions
    const assignedEmoji = emojis.length > 1
      ? emojis[i % emojis.length]
      : emojis[0];

    const result = await reactOneEmoji(sock, target, assignedEmoji);

    if (result.ok) {
      successCount++;
      if (onProgress) onProgress({ num, ok: true, emoji: assignedEmoji });
      // Notify via WA
      tgNotify('✅ <b>+' + num + '</b>\nreact success\n' + assignedEmoji + ' Reacted\n📢 Post: ' + target.msgId).catch(()=>{});
    } else {
      failCount++;
      if (onProgress) onProgress({ num, ok: false, reason: result.reason || 'failed' });
      tgNotify('❌ <b>+' + num + '</b>\nreact fail\nReason: ' + (result.reason || 'unknown')).catch(()=>{});
    }

    await new Promise(r => setTimeout(r, 250));
  }

  return { successCount, failCount, total: connected.length };
}

// ── Extract JID from link or raw JID ──────────────────────────
function extractFollowJID(input) {
  if (!input) return null;
  const s = input.trim().replace(/['"]/g, '');
  // Already a JID
  if (s.includes('@newsletter')) return s;
  // Invite link → channelId@newsletter
  const m = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1] + '@newsletter';
  return null;
}

// ── Follow channel across all sessions ────────────────────────
// Baileys throws "unexpected response structure" even on successful follows.
// Treat those parse-level errors as success; only real errors (auth, connection) are failures.
//
// IMPORTANT: followNewsletter needs the *real* newsletter JID (e.g. 120363xxx@newsletter),
// NOT the invite-code-as-JID (0029xxx@newsletter).  Resolve via newsletterMetadata first,
// exactly the same way dashboard/server.js does it.
async function safeFollowSock(sock, jid) {
  if (!sock || !jid) return false;

  // Resolve real JID from invite code
  let realJid = jid;
  const rawCode = jid.replace('@newsletter', '');
  try {
    const meta = await sock.newsletterMetadata('invite', rawCode);
    if (meta && meta.id) {
      realJid = meta.id;
      logger.info('[TG-MGMT] resolved JID: ' + rawCode + ' -> ' + realJid);
    }
  } catch (_) {
    // fallback: try jid mode
    try {
      const meta2 = await sock.newsletterMetadata('jid', jid);
      if (meta2 && meta2.id) realJid = meta2.id;
    } catch (_2) {}
    // if both fail, proceed with original jid
  }

  const methods = ['followNewsletter', 'newsletterFollow', 'newsletterSubscribe', 'followChannel'];
  for (const fn of methods) {
    if (typeof sock[fn] !== 'function') continue;
    try {
      await sock[fn](realJid);
      return true;
    } catch (e) {
      const msg = (e.message || '').toLowerCase();
      if (
        msg.includes('unexpected response structure') ||
        msg.includes('unexpected response') ||
        msg.includes('result is not') ||
        msg.includes('cannot read') ||
        msg.includes('undefined')
      ) {
        // WA-side follow succeeded; Baileys just failed to parse the ack
        return true;
      }
      logger.warn('[TG-MGMT] safeFollowSock ' + fn + ' failed: ' + e.message);
    }
  }
  return false;
}

async function followAllSessions(jid) {
  let sm = global.unitySessionManager;
  if (!sm) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      sm = global.unitySessionManager;
      if (sm) break;
    }
  }
  if (!sm) return { successCount: 0, failCount: 0, total: 0, skippedReason: 'Session manager not ready' };

  const connected = sm.getAllSessions().filter(s => s.status === 'connected');
  if (!connected.length) return { successCount: 0, failCount: 0, total: 0, skippedReason: 'No connected sessions' };

  let successCount = 0, failCount = 0;
  const lines = [];

  for (const sessInfo of connected) {
    const sess = sm.getSession(sessInfo.userId);
    const sock = sess && sess.sock;
    const num  = sessInfo.number || sessInfo.userId;

    if (!sock) {
      failCount++;
      lines.push('❌ +' + num + ' — offline');
      continue;
    }

    const ok = await safeFollowSock(sock, jid);

    if (ok) {
      successCount++;
      lines.push('✅ +' + num + ' — followed');
      tgNotify('✅ <b>+' + num + '</b>\nfollow success\n🔗 ' + jid).catch(() => {});
    } else {
      failCount++;
      lines.push('❌ +' + num + ' — failed');
      tgNotify('❌ <b>+' + num + '</b>\nfollow fail\n🔗 ' + jid).catch(() => {});
    }

    await new Promise(r => setTimeout(r, 300));
  }

  return { successCount, failCount, total: connected.length, lines };
}

// ── Keyboards ─────────────────────────────────────────────────
const KB_PANEL = {
  inline_keyboard: [
    [
      { text: '🏓 Ping',       callback_data: 'cmd_ping'     },
      { text: '⏱ Runtime',    callback_data: 'cmd_runtime'  },
    ],
    [
      { text: '📱 Sessions',   callback_data: 'cmd_which'    },
    ],
    [
      { text: '❤️ React Help', callback_data: 'cmd_reacthelp' },
      { text: '📢 Follow Help', callback_data: 'cmd_followhelp' },
    ],
  ],
};

const KB_BACK = {
  inline_keyboard: [[{ text: '🏠 Control Panel', callback_data: 'home' }]],
};

// ── Message templates ─────────────────────────────────────────
function msgPanel(name) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ⚙️  UNITY-MD MGMT  ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '👋 Welcome, <b>' + (name || 'Admin') + '</b>!\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>Available Commands:</b>\n\n' +
    '  🏓 /ping — Latency check\n' +
    '  ⏱ /runtime — Uptime &amp; memory\n' +
    '  📱 /which — Connected sessions\n' +
    '  ❤️ /react — React boost\n' +
    '  📢 /follow — Follow boost\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n\n' +
    '<i>Use buttons below for quick access 👇</i>'
  );
}
function msgPing(latency) {
  const q = latency < 200 ? '🟢 <b>Excellent</b>' : latency < 500 ? '🟡 <b>Good</b>' : '🔴 <b>Slow</b>';
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║    🏓  PONG!         ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '⚡ Latency: <code>' + latency + 'ms</code>\n\n' +
    q + ' — ' + (latency < 200 ? 'bot is flying!' : latency < 500 ? 'running smoothly.' : 'check your network.')
  );
}
function msgRuntime() {
  const uptime = formatUptime(Math.floor(process.uptime()));
  const mem    = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  const heap   = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ⏱  BOT RUNTIME     ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '🕐 Uptime:  <code>' + uptime + '</code>\n' +
    '💾 RAM:     <code>' + mem + ' MB</code>\n' +
    '📦 Heap:    <code>' + heap + ' MB</code>\n' +
    '🟢 Node.js: <code>' + process.version + '</code>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<i>UNITY-MD is running strong 💪</i>'
  );
}
function msgSessions(connected, pairing, others, all, lines) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  📱  WA SESSIONS    ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '🟢 Connected: <b>' + connected + '</b>\n' +
    '🔄 Pairing:   <b>' + pairing + '</b>\n' +
    '⚫ Other:     <b>' + others + '</b>\n' +
    '📊 Total:     <b>' + all + '</b>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>Connected Numbers:</b>\n' +
    lines +
    '\n━━━━━━━━━━━━━━━━━━━━━'
  );
}
function msgReactHelp() {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ❤️  REACT BOOST    ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '<b>Format:</b>\n' +
    '<code>/react (emojis) link</code>\n\n' +
    '<b>Single post:</b>\n' +
    '<code>/react (❤️) https://whatsapp.com/channel/XXX/123</code>\n\n' +
    '<b>Multi-emoji:</b>\n' +
    '<code>/react (❣️😍💘💝❤️\u200d🔥) link</code>\n\n' +
    '<b>Multiple posts:</b>\n' +
    '<code>/react (❤️) link1, link2, link3</code>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '💡 Each session gets one emoji (round-robin).\n' +
    '📲 Result sent to Telegram after each session.'
  );
}
function msgReactStart(emojiStr, postCount, sessCount) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ' + emojiStr + '  REACT BOOST     ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '📋 Posts:    <b>' + postCount + '</b>\n' +
    '📱 Sessions: <b>' + sessCount + '</b>\n' +
    '🎯 Emojis:   ' + emojiStr + '\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '⏳ <b>Reacting...</b>\n' +
    '<i>Sending via all connected sessions.</i>'
  );
}
function msgReactProgress(emojiStr, total, done, sessCount, results) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ' + emojiStr + '  REACT BOOST     ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '📋 Posts:    <b>' + done + '/' + total + '</b>\n' +
    '📱 Sessions: <b>' + sessCount + '</b>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>Results:</b>\n' +
    results.map(function(l) { return '  • ' + l; }).join('\n')
  );
}
function msgReactDone(emojiStr, total, sessCount, success, results) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ✅  BOOST COMPLETE! ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '📋 Posts:      <b>' + total + '</b>\n' +
    '📱 Sessions:   <b>' + sessCount + '</b>\n' +
    '✅ Successful: <b>' + success + '/' + total + ' posts</b>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>Breakdown:</b>\n' +
    results.map(function(l) { return '  • ' + l; }).join('\n') +
    '\n━━━━━━━━━━━━━━━━━━━━━\n' +
    '<i>All done! Result sent to Telegram. 🎉</i>'
  );
}

function msgFollowHelp() {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  📢  FOLLOW BOOST   ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '<b>Format:</b>\n' +
    '<code>/follow channel_link_or_jid</code>\n\n' +
    '<b>By invite link:</b>\n' +
    '<code>/follow https://whatsapp.com/channel/XXX</code>\n\n' +
    '<b>By JID:</b>\n' +
    '<code>/follow 1234567890abcdef@newsletter</code>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '💡 All connected sessions will follow the channel.\n' +
    '📲 Result sent to Telegram after each session.'
  );
}
function msgFollowStart(jid, sessCount) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  📢  FOLLOW BOOST   ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '🔗 JID:      <code>' + jid + '</code>\n' +
    '📱 Sessions: <b>' + sessCount + '</b>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '⏳ <b>Following...</b>\n' +
    '<i>Sending via all connected sessions.</i>'
  );
}
function msgFollowDone(jid, total, success, lines) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ✅  FOLLOW COMPLETE! ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '🔗 JID:        <code>' + jid + '</code>\n' +
    '📱 Sessions:   <b>' + total + '</b>\n' +
    '✅ Successful: <b>' + success + '/' + total + '</b>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>Breakdown:</b>\n' +
    lines.map(function(l) { return '  • ' + l; }).join('\n') +
    '\n━━━━━━━━━━━━━━━━━━━━━\n' +
    '<i>All done! 🎉</i>'
  );
}

// ── Start bot ─────────────────────────────────────────────────
function start() {
  const TOKEN = process.env.TG_MGMT_BOT_TOKEN;
  if (!TOKEN) {
    logger.warn('[TG-MGMT] TG_MGMT_BOT_TOKEN not set — management bot disabled');
    return;
  }

  bot = new TelegramBot(TOKEN, { polling: true });
  bot.on('polling_error', err => logger.error('[TG-MGMT] Polling error: ' + err.message));

  // /start
  bot.onText(/^\/start(@\S+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    const name = msg.from && msg.from.first_name ? msg.from.first_name : 'Admin';
    bot.sendMessage(msg.chat.id, msgPanel(name), { parse_mode: 'HTML', reply_markup: KB_PANEL });
  });

  // /ping
  bot.onText(/^\/ping(@\S+)?$/, async (msg) => {
    if (!isAdmin(msg)) return;
    const t    = Date.now();
    const sent = await bot.sendMessage(msg.chat.id, '🏓 <i>Pinging...</i>', { parse_mode: 'HTML' });
    const latency = Date.now() - t;
    bot.editMessageText(msgPing(latency), {
      chat_id: msg.chat.id, message_id: sent.message_id, parse_mode: 'HTML', reply_markup: KB_BACK,
    });
  });

  // /runtime
  bot.onText(/^\/runtime(@\S+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    bot.sendMessage(msg.chat.id, msgRuntime(), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  // /which
  bot.onText(/^\/which(@\S+)?$/, async (msg) => {
    if (!isAdmin(msg)) return;
    let sm = global.unitySessionManager;
    if (!sm) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        sm = global.unitySessionManager;
        if (sm) break;
      }
    }
    if (!sm) return bot.sendMessage(msg.chat.id, '❌ Session manager not ready. Try again in a moment.', { parse_mode: 'HTML' });
    const all       = sm.getAllSessions();
    const connected = all.filter(s => s.status === 'connected');
    const pairing   = all.filter(s => s.status === 'pairing');
    const others    = all.filter(s => s.status !== 'connected' && s.status !== 'pairing');
    const lines = connected.length
      ? connected.map(function(s, i) {
          return (i + 1) + '. <code>+' + (s.number || s.userId) + '</code>' + (s.name ? '  (' + s.name + ')' : '');
        }).join('\n')
      : '<i>None connected</i>';
    bot.sendMessage(msg.chat.id,
      msgSessions(connected.length, pairing.length, others.length, all.length, lines),
      { parse_mode: 'HTML', reply_markup: KB_BACK }
    );
  });

  // /react (emojis) link1, link2, ...
  // Matches: /react (anything) rest
  bot.onText(/^\/react(?:@\S+)?\s+\(([^)]*)\)\s*([\s\S]*)$/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;

    // Parse emojis
    const emojiBlock = (match[1] || '').trim();
    let emojis = [];
    try {
      const seg = new Intl.Segmenter();
      emojis = [...seg.segment(emojiBlock)]
        .map(s => s.segment.trim())
        .filter(s => s.length > 0);
    } catch {
      emojis = [...emojiBlock].filter(c => c.trim().length > 0);
    }
    if (!emojis.length) emojis = ['❤️'];

    // Parse links
    const linksRaw = (match[2] || '').trim();
    const links = linksRaw.split(',')
      .map(s => s.trim()).filter(Boolean)
      .map(p => ({ raw: p, parsed: parsePostLink(p) }))
      .filter(x => x.parsed !== null);

    if (!links.length) {
      return bot.sendMessage(chatId, msgReactHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
    }

    let sm = global.unitySessionManager;
    if (!sm) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        sm = global.unitySessionManager;
        if (sm) break;
      }
    }
    if (!sm) return bot.sendMessage(chatId, '❌ Session manager not ready. Try again in a moment.', { parse_mode: 'HTML' });

    const connected = sm.getAllSessions().filter(s => s.status === 'connected');
    if (!connected.length) {
      return bot.sendMessage(chatId,
        '<b>❌ No Connected Sessions</b>\n\nNo WhatsApp sessions are connected.\nPlease link at least one number first.',
        { parse_mode: 'HTML', reply_markup: KB_BACK }
      );
    }

    const emojiStr = emojis.join('');
    const statusMsg = await bot.sendMessage(chatId,
      msgReactStart(emojiStr, links.length, connected.length),
      { parse_mode: 'HTML' }
    );

    const postResults = [];

    for (let i = 0; i < links.length; i++) {
      const { inviteCode, msgId } = links[i].parsed;
      const label = 'Post ' + (i + 1);

      logger.info('[TG-MGMT] Reacting to ' + label + ' — ' + inviteCode + '/' + msgId);

      const r = await reactAllSessions(inviteCode, msgId, emojis, null);

      if (r.skippedReason) {
        postResults.push(label + ': ⚠️ ' + r.skippedReason);
      } else {
        postResults.push(label + ': ✅ ' + r.successCount + '/' + r.total + '  ❌ ' + r.failCount);
      }

      await bot.editMessageText(
        msgReactProgress(emojiStr, links.length, i + 1, connected.length, postResults),
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
      ).catch(() => {});

      if (i < links.length - 1) await new Promise(r => setTimeout(r, 600));
    }

    const totalSuccess = postResults.filter(l => l.includes('✅')).length;
    bot.editMessageText(
      msgReactDone(emojiStr, links.length, connected.length, totalSuccess, postResults),
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: KB_BACK }
    ).catch(() => {});

    logger.info('[TG-MGMT] React done — ' + links.length + ' posts, ' + connected.length + ' sessions');
  });

  // /react no args or wrong format
  bot.onText(/^\/react(@\S+)?(\s+[^(].*)?$/, (msg, match) => {
    if (!isAdmin(msg)) return;
    // Only show help if there's no parenthesis block (wrong format)
    const text = msg.text || '';
    if (text.match(/^\/react(?:@\S+)?\s+\([^)]*\)/)) return; // handled above
    bot.sendMessage(msg.chat.id, msgReactHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  // /follow channel_link_or_jid
  bot.onText(/^\/follow(?:@\S+)?\s+([\s\S]+)$/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const input  = (match[1] || '').trim();

    const jid = extractFollowJID(input);
    if (!jid) {
      return bot.sendMessage(chatId, msgFollowHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
    }

    let sm = global.unitySessionManager;
    if (!sm) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        sm = global.unitySessionManager;
        if (sm) break;
      }
    }
    if (!sm) return bot.sendMessage(chatId, '❌ Session manager not ready. Try again in a moment.', { parse_mode: 'HTML' });

    const connected = sm.getAllSessions().filter(s => s.status === 'connected');
    if (!connected.length) {
      return bot.sendMessage(chatId,
        '<b>❌ No Connected Sessions</b>\n\nNo WhatsApp sessions are connected.\nPlease link at least one number first.',
        { parse_mode: 'HTML', reply_markup: KB_BACK }
      );
    }

    const statusMsg = await bot.sendMessage(chatId,
      msgFollowStart(jid, connected.length),
      { parse_mode: 'HTML' }
    );

    const result = await followAllSessions(jid);

    bot.editMessageText(
      msgFollowDone(jid, result.total, result.successCount, result.lines || []),
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: KB_BACK }
    ).catch(() => {});

    logger.info('[TG-MGMT] Follow done — ' + result.successCount + '/' + result.total + ' sessions for ' + jid);
  });

  // /follow no args
  bot.onText(/^\/follow(@\S+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    bot.sendMessage(msg.chat.id, msgFollowHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  // Inline button callbacks
  bot.on('callback_query', async (cb) => {
    if (!isAdmin(cb)) return;
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const msgId  = cb.message && cb.message.message_id;
    const data   = cb.data || '';
    await bot.answerCallbackQuery(cb.id).catch(() => {});

    if (data === 'home') {
      const name = cb.from && cb.from.first_name ? cb.from.first_name : 'Admin';
      await bot.editMessageText(msgPanel(name), {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: KB_PANEL,
      }).catch(() => {});
      return;
    }
    if (data === 'cmd_ping') {
      const t = Date.now();
      await bot.editMessageText('🏓 <i>Pinging...</i>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(() => {});
      const latency = Date.now() - t;
      await bot.editMessageText(msgPing(latency), {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: KB_BACK,
      }).catch(() => {});
      return;
    }
    if (data === 'cmd_runtime') {
      await bot.editMessageText(msgRuntime(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: KB_BACK,
      }).catch(() => {});
      return;
    }
    if (data === 'cmd_which') {
      let sm = global.unitySessionManager;
      if (!sm) {
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 1000));
          sm = global.unitySessionManager;
          if (sm) break;
        }
      }
      if (!sm) {
        await bot.editMessageText('❌ Session manager not ready. Try again in a moment.', {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: KB_BACK,
        }).catch(() => {});
        return;
      }
      const all       = sm.getAllSessions();
      const connected = all.filter(s => s.status === 'connected');
      const pairing   = all.filter(s => s.status === 'pairing');
      const others    = all.filter(s => s.status !== 'connected' && s.status !== 'pairing');
      const lines = connected.length
        ? connected.map(function(s, i) {
            return (i + 1) + '. <code>+' + (s.number || s.userId) + '</code>' + (s.name ? '  (' + s.name + ')' : '');
          }).join('\n')
        : '<i>None connected</i>';
      await bot.editMessageText(
        msgSessions(connected.length, pairing.length, others.length, all.length, lines),
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: KB_BACK }
      ).catch(() => {});
      return;
    }
    if (data === 'cmd_reacthelp') {
      await bot.editMessageText(msgReactHelp(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: KB_BACK,
      }).catch(() => {});
      return;
    }
    if (data === 'cmd_followhelp') {
      await bot.editMessageText(msgFollowHelp(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: KB_BACK,
      }).catch(() => {});
      return;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ── /edit — Super Owner Session Manager ─────────────────────
  // ═══════════════════════════════════════════════════════════════

  // ── Message templates ────────────────────────────────────────
  function msgEditAskPw() {
    return (
      '<b>╔═══════════════════╗</b>\n' +
      '<b>║  🔐  SUPER PANEL   ║</b>\n' +
      '<b>╚═══════════════════╝</b>\n\n' +
      '🔑 Enter the password to continue:\n\n' +
      '<i>Type the password and send it.</i>'
    );
  }

  function msgEditSessions(sessions) {
    const lines = sessions.length
      ? sessions.map((s, i) =>
          (i + 1) + '. <code>+' + (s.number || s.userId) + '</code>' +
          '  ' + (s.status === 'connected' ? '🟢' : '🔴') + ' <i>' + s.status + '</i>' +
          (s.isBlocked ? '  🚫' : '')
        ).join('\n')
      : '<i>No sessions found</i>';
    return (
      '<b>╔═══════════════════╗</b>\n' +
      '<b>║  📱  SELECT SESSION ║</b>\n' +
      '<b>╚═══════════════════╝</b>\n\n' +
      lines + '\n\n' +
      '<i>Tap a session to manage it 👇</i>'
    );
  }

  function kbEditSessions(sessions) {
    const rows = sessions.map(s => [{
      text: '+' + (s.number || s.userId) +
            '  ' + (s.status === 'connected' ? '🟢' : '🔴') +
            (s.isBlocked ? '🚫' : ''),
      callback_data: 'edit_sess:' + s.userId,
    }]);
    rows.push([{ text: '🏠 Main Panel', callback_data: 'home' }]);
    return { inline_keyboard: rows };
  }

  function msgEditActions(num, status, isBlocked) {
    return (
      '<b>╔═══════════════════╗</b>\n' +
      '<b>║  ⚙️  MANAGE SESSION ║</b>\n' +
      '<b>╚═══════════════════╝</b>\n\n' +
      '📱 Number: <code>+' + num + '</code>\n' +
      '📊 Status: ' + (status === 'connected' ? '🟢 Connected' : '🔴 ' + status) + '\n' +
      (isBlocked ? '🚫 Blocked: Yes\n' : '') +
      '\n<i>Select an action:</i>'
    );
  }

  function kbEditActions(userId, isBlocked, status) {
    return {
      inline_keyboard: [
        [
          { text: '▶️ Start',   callback_data: 'edit_start:'   + userId },
          { text: '⏹ Stop',    callback_data: 'edit_stop:'    + userId },
        ],
        [
          { text: '🔄 Restart', callback_data: 'edit_restart:' + userId },
        ],
        [
          isBlocked
            ? { text: '✅ Unblock', callback_data: 'edit_unblock:' + userId }
            : { text: '🚫 Block',   callback_data: 'edit_block:'   + userId },
          { text: '🗑 Delete',  callback_data: 'edit_delete:' + userId },
        ],
        [
          { text: '⚙️ Settings', callback_data: 'edit_settings:' + userId },
        ],
        [
          { text: '◀️ Sessions', callback_data: 'edit_back_sessions' },
          { text: '🏠 Home',     callback_data: 'home' },
        ],
      ],
    };
  }

  function msgEditSettings(num, mode, maintenance) {
    return (
      '<b>╔═══════════════════╗</b>\n' +
      '<b>║  ⚙️  BOT SETTINGS  ║</b>\n' +
      '<b>╚═══════════════════╝</b>\n\n' +
      '📱 Session: <code>+' + num + '</code>\n\n' +
      '🌐 Mode:        <b>' + (mode.charAt(0).toUpperCase() + mode.slice(1)) + '</b>\n' +
      '🔧 Maintenance: <b>' + (maintenance ? '🔴 ON' : '🟢 OFF') + '</b>\n\n' +
      '<i>Tap a button to toggle:</i>'
    );
  }

  function kbEditSettings(userId, mode, maintenance) {
    const modes    = ['public', 'private', 'owner'];
    const nextMode = modes[(modes.indexOf(mode) + 1) % modes.length];
    return {
      inline_keyboard: [
        [{
          text: '🌐 Mode: ' + mode + '  →  ' + nextMode,
          callback_data: 'edit_setmode:' + userId + ':' + nextMode,
        }],
        [
          maintenance
            ? { text: '🔧 Maintenance: ON  → turn OFF', callback_data: 'edit_setmaint:' + userId + ':0' }
            : { text: '🔧 Maintenance: OFF → turn ON',  callback_data: 'edit_setmaint:' + userId + ':1' },
        ],
        [
          { text: '◀️ Back',  callback_data: 'edit_sess:' + userId },
          { text: '🏠 Home',  callback_data: 'home' },
        ],
      ],
    };
  }

  // ── Helper: send/edit session list ───────────────────────────
  async function _sendEditSessions(chatId, msgId) {
    const sm = global.unitySessionManager;
    let sessions = sm ? sm.getAllSessions() : [];
    const blocked = _loadBlocked();
    sessions = sessions.map(s => ({ ...s, isBlocked: blocked.has(s.userId) }));
    // Also list blocked numbers not currently in memory
    for (const uid of blocked) {
      if (!sessions.find(s => s.userId === uid)) {
        sessions.push({ userId: uid, number: uid, status: 'blocked', isBlocked: true });
      }
    }
    const text = msgEditSessions(sessions);
    const kb   = kbEditSessions(sessions);
    if (msgId) {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb,
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  // ── /edit command ────────────────────────────────────────────
  bot.onText(/^\/edit(@\S+)?$/, async (msg) => {
    const fromId = String(msg.from && msg.from.id ? msg.from.id : '');
    const chatId = msg.chat.id;
    if (!EDIT_OWNERS.has(fromId)) {
      return bot.sendMessage(chatId, '🔒 <b>Access Denied</b>', { parse_mode: 'HTML' });
    }
    editState.set(chatId, { stage: 'await_pw' });
    await bot.sendMessage(chatId, msgEditAskPw(), { parse_mode: 'HTML' });
  });

  // ── Password input listener ──────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state  = editState.get(chatId);
    if (!state) return;
    if (!msg.text || msg.text.startsWith('/')) return;
    const fromId = String(msg.from && msg.from.id ? msg.from.id : '');
    if (!EDIT_OWNERS.has(fromId)) return;

    if (state.stage === 'await_pw') {
      if (msg.text.trim() !== EDIT_PASSWORD) {
        editState.delete(chatId);
        return bot.sendMessage(chatId, '❌ <b>Wrong password. Access denied.</b>', { parse_mode: 'HTML' });
      }
      editState.set(chatId, { stage: 'pick_session' });
      await _sendEditSessions(chatId, null);
    }
  });

  // ── /edit callback_query handler ─────────────────────────────
  bot.on('callback_query', async (cb) => {
    const data   = cb.data || '';
    if (!data.startsWith('edit_')) return;

    const fromId = String(cb.from && cb.from.id ? cb.from.id : '');
    if (!EDIT_OWNERS.has(fromId)) {
      return bot.answerCallbackQuery(cb.id, { text: '🔒 Access denied' }).catch(() => {});
    }

    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const msgId  = cb.message && cb.message.message_id;
    await bot.answerCallbackQuery(cb.id).catch(() => {});

    // ── Back to session list ─────────────────────────────────
    if (data === 'edit_back_sessions') {
      await _sendEditSessions(chatId, msgId);
      return;
    }

    // ── Select session → show action menu ───────────────────
    if (data.startsWith('edit_sess:')) {
      const userId  = data.slice('edit_sess:'.length);
      const sm      = global.unitySessionManager;
      const sessInfo = sm ? sm.getAllSessions().find(s => s.userId === userId) : null;
      const blocked  = _loadBlocked();
      const num      = sessInfo ? (sessInfo.number || userId) : userId;
      const status   = sessInfo ? sessInfo.status : (blocked.has(userId) ? 'blocked' : 'stopped');
      const isBlocked = blocked.has(userId);
      await bot.editMessageText(
        msgEditActions(num, status, isBlocked),
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kbEditActions(userId, isBlocked, status) }
      ).catch(() => {});
      return;
    }

    // ── Stop ─────────────────────────────────────────────────
    if (data.startsWith('edit_stop:')) {
      const userId = data.slice('edit_stop:'.length);
      const sm = global.unitySessionManager;
      if (sm) await sm.stopSession(userId).catch(() => {});
      await bot.editMessageText(
        '⏹ <b>Session stopped</b>\n\n📱 <code>+' + userId + '</code>',
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'edit_sess:' + userId }]] } }
      ).catch(() => {});
      return;
    }

    // ── Start ────────────────────────────────────────────────
    if (data.startsWith('edit_start:')) {
      const userId = data.slice('edit_start:'.length);
      const sm = global.unitySessionManager;
      try {
        if (sm) await sm.startSession(userId, () => {});
        await bot.editMessageText(
          '▶️ <b>Session starting...</b>\n\n📱 <code>+' + userId + '</code>',
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'edit_sess:' + userId }]] } }
        ).catch(() => {});
      } catch (e) {
        await bot.editMessageText(
          '❌ <b>Start failed:</b>\n' + e.message,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'edit_sess:' + userId }]] } }
        ).catch(() => {});
      }
      return;
    }

    // ── Restart ──────────────────────────────────────────────
    if (data.startsWith('edit_restart:')) {
      const userId = data.slice('edit_restart:'.length);
      const sm = global.unitySessionManager;
      try {
        if (sm) {
          await sm.stopSession(userId).catch(() => {});
          await new Promise(r => setTimeout(r, 800));
          await sm.startSession(userId, () => {});
        }
        await bot.editMessageText(
          '🔄 <b>Session restarting...</b>\n\n📱 <code>+' + userId + '</code>',
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'edit_sess:' + userId }]] } }
        ).catch(() => {});
      } catch (e) {
        await bot.editMessageText(
          '❌ <b>Restart failed:</b>\n' + e.message,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'edit_sess:' + userId }]] } }
        ).catch(() => {});
      }
      return;
    }

    // ── Block ────────────────────────────────────────────────
    if (data.startsWith('edit_block:')) {
      const userId = data.slice('edit_block:'.length);
      const sm = global.unitySessionManager;
      if (sm) await sm.stopSession(userId).catch(() => {});
      const bl = _loadBlocked(); bl.add(userId); _saveBlocked(bl);
      await bot.editMessageText(
        '🚫 <b>Session blocked</b>\n\n📱 <code>+' + userId + '</code>\n\nSession stopped &amp; blocked from reconnecting.',
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: kbEditActions(userId, true, 'blocked') }
      ).catch(() => {});
      return;
    }

    // ── Unblock ──────────────────────────────────────────────
    if (data.startsWith('edit_unblock:')) {
      const userId = data.slice('edit_unblock:'.length);
      const bl = _loadBlocked(); bl.delete(userId); _saveBlocked(bl);
      const sm = global.unitySessionManager;
      try { if (sm) await sm.startSession(userId, () => {}); } catch {}
      await bot.editMessageText(
        '✅ <b>Session unblocked &amp; starting</b>\n\n📱 <code>+' + userId + '</code>',
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: kbEditActions(userId, false, 'connecting') }
      ).catch(() => {});
      return;
    }

    // ── Delete (confirm) ─────────────────────────────────────
    if (data.startsWith('edit_delete:') && !data.startsWith('edit_delete_confirm:')) {
      const userId = data.slice('edit_delete:'.length);
      await bot.editMessageText(
        '⚠️ <b>Delete Session?</b>\n\n📱 <code>+' + userId + '</code>\n\n' +
        'This will <b>permanently remove all auth data</b> from the database.\n' +
        'The number will need to re-pair. This cannot be undone!\n\n' +
        'Are you sure?',
        {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [
              { text: '✅ Yes, Delete',  callback_data: 'edit_delete_confirm:' + userId },
              { text: '❌ Cancel',       callback_data: 'edit_sess:' + userId },
            ],
          ]},
        }
      ).catch(() => {});
      return;
    }

    // ── Delete confirmed ─────────────────────────────────────
    if (data.startsWith('edit_delete_confirm:')) {
      const userId = data.slice('edit_delete_confirm:'.length);
      const sm = global.unitySessionManager;
      if (sm) await sm.clearUserSession(userId).catch(() => {});
      const bl = _loadBlocked(); bl.delete(userId); _saveBlocked(bl);
      await bot.editMessageText(
        '🗑 <b>Session deleted</b>\n\n📱 <code>+' + userId + '</code>\n\nAll auth data removed from DB.',
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Sessions', callback_data: 'edit_back_sessions' }]] } }
      ).catch(() => {});
      return;
    }

    // ── Settings: show ───────────────────────────────────────
    if (data.startsWith('edit_settings:')) {
      const userId   = data.slice('edit_settings:'.length);
      const sm       = global.unitySessionManager;
      const sessInfo = sm ? sm.getAllSessions().find(s => s.userId === userId) : null;
      const num      = sessInfo ? (sessInfo.number || userId) : userId;
      try {
        const cfg   = await db.getBotConfig(userId);
        const mode  = cfg.mode || 'public';
        const maint = !!cfg.maintenance;
        await bot.editMessageText(msgEditSettings(num, mode, maint), {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: kbEditSettings(userId, mode, maint),
        }).catch(() => {});
      } catch (e) {
        await bot.editMessageText('❌ <b>Failed to load settings:</b>\n' + e.message, {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'edit_sess:' + userId }]] },
        }).catch(() => {});
      }
      return;
    }

    // ── Settings: toggle mode ────────────────────────────────
    if (data.startsWith('edit_setmode:')) {
      const parts   = data.slice('edit_setmode:'.length).split(':');
      const userId  = parts[0];
      const newMode = parts[1];
      const sm      = global.unitySessionManager;
      const sessInfo = sm ? sm.getAllSessions().find(s => s.userId === userId) : null;
      const num     = sessInfo ? (sessInfo.number || userId) : userId;
      try {
        const cfg = await db.getBotConfig(userId);
        cfg.mode  = newMode;
        await cfg.save();
        const maint = !!cfg.maintenance;
        await bot.editMessageText(msgEditSettings(num, newMode, maint), {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: kbEditSettings(userId, newMode, maint),
        }).catch(() => {});
      } catch (e) {
        logger.warn('[TG-MGMT] setmode failed: ' + e.message);
      }
      return;
    }

    // ── Settings: toggle maintenance ─────────────────────────
    if (data.startsWith('edit_setmaint:')) {
      const parts    = data.slice('edit_setmaint:'.length).split(':');
      const userId   = parts[0];
      const newMaint = parts[1] === '1';
      const sm       = global.unitySessionManager;
      const sessInfo = sm ? sm.getAllSessions().find(s => s.userId === userId) : null;
      const num      = sessInfo ? (sessInfo.number || userId) : userId;
      try {
        const cfg         = await db.getBotConfig(userId);
        cfg.maintenance   = newMaint;
        await cfg.save();
        const mode = cfg.mode || 'public';
        await bot.editMessageText(msgEditSettings(num, mode, newMaint), {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: kbEditSettings(userId, mode, newMaint),
        }).catch(() => {});
      } catch (e) {
        logger.warn('[TG-MGMT] setmaint failed: ' + e.message);
      }
      return;
    }
  });

  logger.info('[TG-MGMT] Management bot started ✅');
}

module.exports = { start };
