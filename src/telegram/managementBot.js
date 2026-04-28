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

let bot = null;

const NOTIFY_JID = '94726800969@s.whatsapp.net';

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
    for (let i = 0; i < 5; i++) {
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
      try { await sock.sendMessage(NOTIFY_JID, { text: '❌ *+' + num + '*\nreact fail\nReason: could not resolve post' }); } catch {}
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
      try {
        await sock.sendMessage(NOTIFY_JID, {
          text: '✅ *+' + num + '*\nreact success\n' + assignedEmoji + ' *Reacted*\n📢 Post: ' + target.msgId,
        });
      } catch (ne) { logger.warn('[TG-MGMT] WA notify failed for +' + num + ': ' + ne.message); }
    } else {
      failCount++;
      if (onProgress) onProgress({ num, ok: false, reason: result.reason || 'failed' });
      try {
        await sock.sendMessage(NOTIFY_JID, {
          text: '❌ *+' + num + '*\nreact fail\nReason: ' + (result.reason || 'unknown'),
        });
      } catch {}
    }

    await new Promise(r => setTimeout(r, 250));
  }

  return { successCount, failCount, total: connected.length };
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
    '📲 Result sent to WA after each session.'
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
    '<i>All done! Result sent to WA. 🎉</i>'
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
      for (let i = 0; i < 10; i++) {
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
      for (let i = 0; i < 10; i++) {
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
  });

  logger.info('[TG-MGMT] Management bot started ✅');
}

module.exports = { start };
