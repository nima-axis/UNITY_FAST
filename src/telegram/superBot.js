'use strict';
/**
 * FAST-BOT — Telegram Super Bot
 * Token env: TG_SUPER_BOT_TOKEN
 *
 * Combines: Pair Bot + Management Bot + Downloader
 *
 * Commands:
 *   /start               — Main panel
 *   /pair <number>       — Pair a WhatsApp number
 *   /ping                — Latency check
 *   /runtime             — Uptime & memory
 *   /sessions / /which   — Connected WA sessions
 *   /send <number> <msg> — Send WA message via session
 *   /yt   <url>          — YouTube MP4 download
 *   /mp3  <url>          — YouTube MP3 download
 *   /tt   <url>          — TikTok download (no watermark)
 *   /ig   <url>          — Instagram reel/video/photo
 *   /fb   <url>          — Facebook video
 *   /dl   <url>          — Auto-detect & download
 */

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const fs          = require('fs');
const path        = require('path');
// ✅ Fixed: correct path from src/telegram/ to src/commands/logger
const logger      = require('../commands/logger');
const db          = require('../commands/index');

let bot = null;

// ── Helpers ───────────────────────────────────────────────────
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Admin gate ────────────────────────────────────────────────
const _adminIds = (process.env.TG_ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(from) {
  if (!_adminIds.length) return true;
  return _adminIds.includes(String(from && from.id ? from.id : from));
}

// ── Temp dir ──────────────────────────────────────────────────
const TEMP_DIR = path.join(process.cwd(), 'database', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function cleanTemp(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
}

// ── Session manager accessor ──────────────────────────────────
async function getSM(ms = 30000) {
  let sm = global.unitySessionManager;
  const end = Date.now() + ms;
  while (!sm && Date.now() < end) {
    await wait(1000);
    sm = global.unitySessionManager;
  }
  return sm || null;
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1 — PAIR (ported from pairBot.js)
// ═══════════════════════════════════════════════════════════════
const _inProgress = new Set();

async function waitForPairCode(sess, timeoutMs = 60000) {
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    if (sess.pairCode)               return { result: 'code', pairCode: sess.pairCode };
    if (sess.status === 'connected') return { result: 'connected' };
    if (sess.status === 'error')     return { result: 'error' };
    await wait(500);
    elapsed += 500;
  }
  return { result: 'timeout' };
}

async function doPair(chatId, number, editMsgId = null) {
  // Already in progress?
  if (_inProgress.has(number)) {
    const txt  = '<b>⏳ Already Processing...</b>\n\nA pairing request for <code>+' + number + '</code>\nis currently in progress.\n\nPlease wait for it to complete.';
    const opts = { parse_mode: 'HTML' };
    return editMsgId
      ? bot.editMessageText(txt, { chat_id: chatId, message_id: editMsgId, ...opts }).catch(() => {})
      : bot.sendMessage(chatId, txt, opts);
  }

  // Get session manager
  let sm = global.unitySessionManager;
  if (!sm) {
    try { sm = require('../sessionManager'); global.unitySessionManager = sm; } catch (_e) {}
  }
  if (!sm) {
    const txt  = '❌ <b>Session manager not ready.</b>\nPlease try again in a moment.';
    const opts = { parse_mode: 'HTML' };
    return editMsgId
      ? bot.editMessageText(txt, { chat_id: chatId, message_id: editMsgId, ...opts }).catch(() => {})
      : bot.sendMessage(chatId, txt, opts);
  }

  // Already connected?
  const existing = sm.getSession(number);
  if (existing?.status === 'connected') {
    const opts = { parse_mode: 'HTML', reply_markup: KB_BACK };
    return editMsgId
      ? bot.editMessageText(msgAlreadyLinked(number), { chat_id: chatId, message_id: editMsgId, ...opts }).catch(() => {})
      : bot.sendMessage(chatId, msgAlreadyLinked(number), opts);
  }

  _inProgress.add(number);

  // Show generating message
  let sentMsg;
  if (editMsgId) {
    await bot.editMessageText(msgGenerating(number), {
      chat_id: chatId, message_id: editMsgId, parse_mode: 'HTML',
    }).catch(() => {});
    sentMsg = { message_id: editMsgId };
  } else {
    sentMsg = await bot.sendMessage(chatId, msgGenerating(number), { parse_mode: 'HTML' });
  }

  const upd = (text, kb) => bot.editMessageText(text, {
    chat_id: chatId,
    message_id: sentMsg.message_id,
    parse_mode: 'HTML',
    ...(kb ? { reply_markup: kb } : {}),
  }).catch(() => {});

  try {
    const sess    = await sm.startSession(number, () => {});
    const outcome = await waitForPairCode(sess);

    if (outcome.result === 'connected') {
      await upd(msgAlreadyLinked(number), KB_BACK);
      return;
    }

    if (outcome.result === 'code') {
      // ✅ Same as original pairBot.js — mark as paired in DB
      const userJid = number + '@s.whatsapp.net';
      await db.setPaired(userJid, true).catch(() => {});
      try {
        const { autoFollowChannels } = require('./autoHandler');
        await autoFollowChannels(userJid);
      } catch (_e) {}
      await upd(msgCodeReady(number, outcome.pairCode), KB_BACK);
      return;
    }

    if (outcome.result === 'timeout') {
      await upd(msgTimeout(number), kbRetry(number));
      return;
    }

    await upd(msgPairError('Session error'), kbRetry(number));

  } catch (e) {
    logger.error('[TG-SUPER] startSession error for ' + number + ': ' + e.message);
    await upd(msgPairError(e.message), kbRetry(number));
  } finally {
    _inProgress.delete(number);
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 2 — DOWNLOADS
// ═══════════════════════════════════════════════════════════════
function detectPlatform(url) {
  if (/youtu\.be|youtube\.com/i.test(url))              return 'youtube';
  if (/tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url))  return 'tiktok';
  if (/instagram\.com/i.test(url))                      return 'instagram';
  if (/facebook\.com|fb\.com|fb\.watch/i.test(url))     return 'facebook';
  return null;
}

function extractYtId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function axGet(url, opts = {}) {
  const r = await axios.get(url, { timeout: 25000, ...opts });
  return r.data;
}

async function ytMp3(url) {
  const vid  = extractYtId(url);
  const tries = [
    async () => {
      const d = await axGet(`https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(url)}`);
      const u = d?.result?.dl_url || d?.dl_url || d?.data?.dl_url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.result?.title || d?.title || 'YouTube Audio' };
    },
    async () => {
      const d = await axGet(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`);
      const u = d?.data?.url || d?.url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.data?.title || 'YouTube Audio' };
    },
    async () => {
      const d = await axGet(`https://api.znx.my.id/api/ytmp3?url=${encodeURIComponent(url)}`);
      const u = d?.result?.link || d?.dl_url || d?.url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.result?.title || 'YouTube Audio' };
    },
    async () => {
      if (!vid) throw new Error('no id');
      const d = await axGet(`https://api.popcat.xyz/ytmp3?videoId=${vid}`);
      const u = d?.dl_url || d?.url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.title || 'YouTube Audio' };
    },
    async () => {
      const d = await axGet(`https://bk9.fun/download/ytmp3?url=${encodeURIComponent(url)}`);
      const u = d?.BK9?.dl_url || d?.dl_url || d?.url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.BK9?.title || 'YouTube Audio' };
    },
  ];
  for (const fn of tries) { try { const r = await fn(); if (r) return r; } catch (_) {} }
  throw new Error('All YouTube MP3 methods failed');
}

async function ytMp4(url) {
  const vid  = extractYtId(url);
  const tries = [
    async () => {
      const d = await axGet(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(url)}`);
      const u = d?.result?.dl_url || d?.dl_url || d?.data?.dl_url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.result?.title || d?.title || 'YouTube Video', quality: d?.result?.quality || '720p' };
    },
    async () => {
      const d = await axGet(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(url)}`);
      const u = d?.data?.url || d?.url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.data?.title || 'YouTube Video', quality: '720p' };
    },
    async () => {
      const d = await axGet(`https://api.znx.my.id/api/ytmp4?url=${encodeURIComponent(url)}`);
      const u = d?.result?.link || d?.dl_url || d?.url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.result?.title || 'YouTube Video', quality: '720p' };
    },
    async () => {
      if (!vid) throw new Error('no id');
      const d = await axGet(`https://api.popcat.xyz/ytmp4?videoId=${vid}`);
      const u = d?.dl_url || d?.url;
      if (!u) throw new Error('no url');
      return { url: u, title: d?.title || 'YouTube Video', quality: '720p' };
    },
    async () => {
      for (const host of ['https://api.cobalt.tools', 'https://cobalt.oisd.nl', 'https://cobalt-api.hydrax.net']) {
        try {
          const d = await axios.post(host + '/', { url, downloadMode: 'auto', videoQuality: '720' },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 20000 }).then(r => r.data);
          if (d?.url) return { url: d.url, title: 'YouTube Video', quality: '720p' };
        } catch (_) {}
      }
      throw new Error('cobalt all failed');
    },
  ];
  for (const fn of tries) { try { const r = await fn(); if (r) return r; } catch (_) {} }
  throw new Error('All YouTube MP4 methods failed');
}

async function tiktokDl(url) {
  const tries = [
    async () => {
      const r = await axios.post('https://tikwm.com/api/',
        new URLSearchParams({ url, count: '12', cursor: '0', web: '1', hd: '1' }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 });
      const d = r.data?.data;
      if (!d) throw new Error('no data');
      let v = d.hdplay || d.play;
      if (!v) throw new Error('no url');
      if (v.startsWith('/')) v = 'https://tikwm.com' + v;
      let audio = d.music || v;
      if (audio.startsWith('/')) audio = 'https://tikwm.com' + audio;
      return { url: v, audio, title: d.title || '', author: d.author?.nickname || '' };
    },
    async () => {
      const d = await axGet(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`);
      const v = d?.data?.mp4 || d?.data?.play || d?.url;
      if (!v) throw new Error('no url');
      return { url: v, audio: v, title: d?.data?.title || '', author: '' };
    },
    async () => {
      for (const host of ['https://api.cobalt.tools', 'https://cobalt.oisd.nl']) {
        try {
          const d = await axios.post(host + '/', { url, downloadMode: 'auto', videoQuality: '720' },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 20000 }).then(r => r.data);
          if (d?.url) return { url: d.url, audio: d.url, title: 'TikTok Video', author: '' };
        } catch (_) {}
      }
      throw new Error('cobalt all failed');
    },
  ];
  for (const fn of tries) { try { const r = await fn(); if (r) return r; } catch (_) {} }
  throw new Error('All TikTok methods failed');
}

async function igDl(url) {
  const tries = [
    async () => {
      const d = await axGet(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`);
      const item = d?.data?.[0];
      const v = item?.url || d?.url;
      if (!v) throw new Error('no url');
      return { url: v, type: item?.type === 'image' ? 'image' : 'video' };
    },
    async () => {
      const d = await axGet(`https://api.znx.my.id/api/igdl?url=${encodeURIComponent(url)}`);
      const v = d?.result?.[0]?.url || d?.url;
      if (!v) throw new Error('no url');
      return { url: v, type: 'video' };
    },
    async () => {
      for (const host of ['https://api.cobalt.tools', 'https://cobalt.oisd.nl']) {
        try {
          const d = await axios.post(host + '/', { url, downloadMode: 'auto', videoQuality: '720' },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 20000 }).then(r => r.data);
          if (d?.url) return { url: d.url, type: 'video' };
        } catch (_) {}
      }
      throw new Error('cobalt all failed');
    },
  ];
  for (const fn of tries) { try { const r = await fn(); if (r) return r; } catch (_) {} }
  throw new Error('All Instagram methods failed');
}

async function fbDl(url) {
  const tries = [
    async () => {
      const d = await axGet(`https://api.siputzx.my.id/api/d/fb?url=${encodeURIComponent(url)}`);
      const v = d?.data?.hd || d?.data?.sd || d?.url;
      if (!v) throw new Error('no url');
      return { url: v };
    },
    async () => {
      const d = await axGet(`https://api.znx.my.id/api/fb?url=${encodeURIComponent(url)}`);
      const v = d?.result?.hd || d?.result?.sd || d?.url;
      if (!v) throw new Error('no url');
      return { url: v };
    },
    async () => {
      for (const host of ['https://api.cobalt.tools', 'https://cobalt.oisd.nl']) {
        try {
          const d = await axios.post(host + '/', { url, downloadMode: 'auto', videoQuality: '720' },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 20000 }).then(r => r.data);
          if (d?.url) return { url: d.url };
        } catch (_) {}
      }
      throw new Error('cobalt all failed');
    },
  ];
  for (const fn of tries) { try { const r = await fn(); if (r) return r; } catch (_) {} }
  throw new Error('All Facebook methods failed');
}

// ── Send media to Telegram ────────────────────────────────────
const TG_MAX = 48 * 1024 * 1024;

async function streamToFile(url, dest) {
  const r = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  return new Promise((res, rej) => {
    const ws = fs.createWriteStream(dest);
    r.data.pipe(ws);
    ws.on('finish', () => res(dest));
    ws.on('error', rej);
  });
}

async function sendMedia(chatId, mediaUrl, type, caption) {
  // Try direct URL send first
  try {
    if (type === 'audio') await bot.sendAudio(chatId, mediaUrl, { caption, parse_mode: 'HTML' });
    else                  await bot.sendVideo(chatId, mediaUrl, { caption, parse_mode: 'HTML', supports_streaming: true });
    return { ok: true };
  } catch (_) {}

  // Download then upload
  const ext  = type === 'audio' ? '.mp3' : '.mp4';
  const dest = path.join(TEMP_DIR, 'tg_' + Date.now() + ext);
  try {
    await streamToFile(mediaUrl, dest);
    if (fs.statSync(dest).size > TG_MAX) { cleanTemp(dest); return { ok: false, reason: 'too_large' }; }
    if (type === 'audio') await bot.sendAudio(chatId, fs.createReadStream(dest), { caption, parse_mode: 'HTML' });
    else                  await bot.sendVideo(chatId, fs.createReadStream(dest), { caption, parse_mode: 'HTML', supports_streaming: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    cleanTemp(dest);
  }
}

async function handleDownload(chatId, url, platform, format) {
  const st  = await bot.sendMessage(chatId, '⏳ <b>Downloading...</b>', { parse_mode: 'HTML' });
  const upd = text => bot.editMessageText(text, { chat_id: chatId, message_id: st.message_id, parse_mode: 'HTML' }).catch(() => {});

  try {
    if (platform === 'youtube' && format === 'mp3') {
      await upd('🎵 <b>Fetching YouTube audio...</b>');
      const d   = await ytMp3(url);
      const cap = '🎵 <b>' + (d.title || 'YouTube Audio') + '</b>\n\n📥 <i>FAST-BOT</i>';
      await bot.deleteMessage(chatId, st.message_id).catch(() => {});
      const r = await sendMedia(chatId, d.url, 'audio', cap);
      if (!r.ok) await bot.sendMessage(chatId, cap + '\n\n🔗 <a href="' + d.url + '">Download Link</a>', { parse_mode: 'HTML' });

    } else if (platform === 'youtube') {
      await upd('🎬 <b>Fetching YouTube video...</b>');
      const d   = await ytMp4(url);
      const cap = '🎬 <b>' + (d.title || 'YouTube Video') + '</b>  [' + (d.quality || '720p') + ']\n\n📥 <i>FAST-BOT</i>';
      await bot.deleteMessage(chatId, st.message_id).catch(() => {});
      const r = await sendMedia(chatId, d.url, 'video', cap);
      if (!r.ok) await bot.sendMessage(chatId, cap + '\n\n🔗 <a href="' + d.url + '">Download Link</a>', { parse_mode: 'HTML' });

    } else if (platform === 'tiktok') {
      await upd('📱 <b>Fetching TikTok video...</b>');
      const d   = await tiktokDl(url);
      const cap = '📱 <b>' + (d.title || 'TikTok Video') + '</b>' + (d.author ? '\n👤 @' + d.author : '') + '\n\n📥 <i>FAST-BOT</i>';
      await bot.deleteMessage(chatId, st.message_id).catch(() => {});
      const r = await sendMedia(chatId, d.url, 'video', cap);
      if (!r.ok) await bot.sendMessage(chatId, cap + '\n\n🔗 <a href="' + d.url + '">Download Link</a>', { parse_mode: 'HTML' });

    } else if (platform === 'instagram') {
      await upd('📸 <b>Fetching Instagram media...</b>');
      const d   = await igDl(url);
      const cap = '📸 <b>Instagram ' + (d.type === 'image' ? 'Photo' : 'Video') + '</b>\n\n📥 <i>FAST-BOT</i>';
      await bot.deleteMessage(chatId, st.message_id).catch(() => {});
      if (d.type === 'image') {
        try { await bot.sendPhoto(chatId, d.url, { caption: cap, parse_mode: 'HTML' }); }
        catch (_) { await bot.sendMessage(chatId, cap + '\n\n🔗 <a href="' + d.url + '">Download Link</a>', { parse_mode: 'HTML' }); }
      } else {
        const r = await sendMedia(chatId, d.url, 'video', cap);
        if (!r.ok) await bot.sendMessage(chatId, cap + '\n\n🔗 <a href="' + d.url + '">Download Link</a>', { parse_mode: 'HTML' });
      }

    } else if (platform === 'facebook') {
      await upd('📘 <b>Fetching Facebook video...</b>');
      const d   = await fbDl(url);
      const cap = '📘 <b>Facebook Video</b>\n\n📥 <i>FAST-BOT</i>';
      await bot.deleteMessage(chatId, st.message_id).catch(() => {});
      const r = await sendMedia(chatId, d.url, 'video', cap);
      if (!r.ok) await bot.sendMessage(chatId, cap + '\n\n🔗 <a href="' + d.url + '">Download Link</a>', { parse_mode: 'HTML' });
    }

  } catch (e) {
    logger.error('[TG-SUPER] dl error: ' + e.message);
    await upd('❌ <b>Download Failed</b>\n<code>' + e.message.slice(0, 200) + '</code>').catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 3 — KEYBOARDS
// ═══════════════════════════════════════════════════════════════
const KB_MAIN = {
  inline_keyboard: [
    [
      { text: '🔗 Pair WA Number', callback_data: 'pair_home'    },
      { text: '📱 Sessions',       callback_data: 'cmd_sessions' },
    ],
    [
      { text: '🏓 Ping',           callback_data: 'cmd_ping'    },
      { text: '⏱ Runtime',         callback_data: 'cmd_runtime' },
    ],
    [
      { text: '📥 Download Help',  callback_data: 'help_dl'   },
      { text: '💬 Send WA Msg',    callback_data: 'help_send' },
    ],
  ],
};

const KB_BACK = {
  inline_keyboard: [[{ text: '🏠 Main Panel', callback_data: 'home' }]],
};

const KB_PAIR_HOME = {
  inline_keyboard: [
    [{ text: '📖 How to Pair', callback_data: 'pair_help' }],
    [{ text: '🏠 Main Panel',  callback_data: 'home'      }],
  ],
};

function kbRetry(num) {
  return {
    inline_keyboard: [[
      { text: '🔄 Try Again', callback_data: 'retry_' + num },
      { text: '🏠 Home',      callback_data: 'home'         },
    ]],
  };
}

// ═══════════════════════════════════════════════════════════════
// SECTION 4 — MESSAGE TEMPLATES
// ═══════════════════════════════════════════════════════════════
function msgMain(name) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║   🤖  FAST-BOT      ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '👋 Hey <b>' + (name || 'there') + '</b>!\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>What I can do:</b>\n\n' +
    '  🔗 Pair WhatsApp numbers\n' +
    '  📱 Manage connected sessions\n' +
    '  📥 Download YouTube / TikTok / IG / FB\n' +
    '  💬 Send messages to WhatsApp\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n\n' +
    '<i>Use buttons or commands below 👇</i>'
  );
}

function msgPairHome(name) {
  return (
    '<b>╔══════════════════╗</b>\n' +
    '<b>║  🔗  PAIR WA NUMBER  ║</b>\n' +
    '<b>╚══════════════════╝</b>\n\n' +
    '👋 Hey <b>' + (name || 'there') + '</b>!\n\n' +
    '📌 Send your WhatsApp number:\n' +
    '   <code>/pair 94771234567</code>\n\n' +
    '   <i>(country code + number, no + or spaces)</i>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '📖 Tap <b>How to Pair</b> for the full guide.'
  );
}

function msgPairHelp() {
  return (
    '<b>╔══════════════════╗</b>\n' +
    '<b>║   📖  HOW TO PAIR    ║</b>\n' +
    '<b>╚══════════════════╝</b>\n\n' +
    '<b>Step 1</b> — Send your number:\n' +
    '   <code>/pair 94771234567</code>\n' +
    '   <i>(country code + number, no spaces or +)</i>\n\n' +
    '<b>Step 2</b> — You will receive a pairing code\n\n' +
    '<b>Step 3</b> — Open WhatsApp:\n' +
    '   ⚙️ Settings → 📱 Linked Devices\n' +
    '   ➕ Link a Device → 🔢 Enter code\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '⚠️ Code expires in <b>60 seconds</b>'
  );
}

function msgGenerating(num) {
  return (
    '<b>╔══════════════════╗</b>\n' +
    '<b>║  ⏳  GENERATING CODE  ║</b>\n' +
    '<b>╚══════════════════╝</b>\n\n' +
    '📞 Number: <code>+' + num + '</code>\n\n' +
    '🔄 <b>Creating your pairing code...</b>\n' +
    '<i>This may take a few seconds.</i>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '⏱ Please wait, do not close this chat.'
  );
}

function msgCodeReady(num, code) {
  return (
    '<b>╔══════════════════╗</b>\n' +
    '<b>║  ✅  CODE IS READY!  ║</b>\n' +
    '<b>╚══════════════════╝</b>\n\n' +
    '📞 Number: <code>+' + num + '</code>\n' +
    '🔑 Your Code:\n\n' +
    '<code>' + code + '</code>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>📲 Enter this code in WhatsApp:</b>\n\n' +
    '   1️⃣ Open <b>WhatsApp</b>\n' +
    '   2️⃣ Tap <b>Settings</b> ⚙️\n' +
    '   3️⃣ <b>Linked Devices</b> → <b>Link a Device</b>\n' +
    '   4️⃣ Enter the code above 👆\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '⏱ <b>Expires in 60 seconds!</b>\n' +
    '<i>Tap the code above to copy it.</i>'
  );
}

function msgAlreadyLinked(num) {
  return (
    '<b>╔══════════════════╗</b>\n' +
    '<b>║  🎉  ALREADY LINKED!  ║</b>\n' +
    '<b>╚══════════════════╝</b>\n\n' +
    '✅ <code>+' + num + '</code> is already connected!\n\n' +
    'Your WhatsApp is linked and ready.\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '💬 Go chat — FAST-BOT is active!'
  );
}

function msgTimeout(num) {
  return (
    '<b>╔══════════════════╗</b>\n' +
    '<b>║  ⏰  CODE EXPIRED!   ║</b>\n' +
    '<b>╚══════════════════╝</b>\n\n' +
    '❌ The pairing code for <code>+' + num + '</code>\n' +
    '   expired before being entered.\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '💡 Tap <b>Try Again</b> to get a new code.\n' +
    '   You have 60s to enter it in WhatsApp.'
  );
}

function msgPairError(err) {
  return (
    '<b>╔══════════════════╗</b>\n' +
    '<b>║   ❌  PAIRING FAILED  ║</b>\n' +
    '<b>╚══════════════════╝</b>\n\n' +
    'Something went wrong during pairing.\n\n' +
    '<b>Reason:</b> <code>' + (err || 'Unknown error') + '</code>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>Check:</b>\n' +
    '   ◉ Number includes country code\n' +
    '   ◉ Number has active WhatsApp\n' +
    '   ◉ Number is not already linked\n\n' +
    '💡 Tap <b>Try Again</b> or wait 60s.'
  );
}

function msgPing(lat) {
  const q = lat < 200 ? '🟢 <b>Excellent</b>' : lat < 500 ? '🟡 <b>Good</b>' : '🔴 <b>Slow</b>';
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║    🏓  PONG!         ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '⚡ Latency: <code>' + lat + 'ms</code>\n\n' +
    q + ' — ' + (lat < 200 ? 'bot is flying!' : lat < 500 ? 'running smoothly.' : 'check your network.')
  );
}

function msgRuntime() {
  const up   = formatUptime(Math.floor(process.uptime()));
  const mem  = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  const heap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  ⏱  BOT RUNTIME     ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '🕐 Uptime:  <code>' + up + '</code>\n' +
    '💾 RAM:     <code>' + mem + ' MB</code>\n' +
    '📦 Heap:    <code>' + heap + ' MB</code>\n' +
    '🟢 Node.js: <code>' + process.version + '</code>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<i>FAST-BOT is running strong 💪</i>'
  );
}

function msgSessions(total, connected, pairing, others, lines) {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  📱  WA SESSIONS    ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '🟢 Connected: <b>' + connected + '</b>\n' +
    '🔄 Pairing:   <b>' + pairing + '</b>\n' +
    '⚫ Other:     <b>' + others + '</b>\n' +
    '📊 Total:     <b>' + total + '</b>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '<b>Connected Numbers:</b>\n' +
    lines +
    '\n━━━━━━━━━━━━━━━━━━━━━'
  );
}

function msgDlHelp() {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  📥  DOWNLOADER     ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '<b>YouTube:</b>\n' +
    '  <code>/yt &lt;url&gt;</code>  — MP4 video\n' +
    '  <code>/mp3 &lt;url&gt;</code> — MP3 audio\n\n' +
    '<b>TikTok:</b>\n' +
    '  <code>/tt &lt;url&gt;</code>  — No watermark video\n\n' +
    '<b>Instagram:</b>\n' +
    '  <code>/ig &lt;url&gt;</code>  — Reel / Photo / Video\n\n' +
    '<b>Facebook:</b>\n' +
    '  <code>/fb &lt;url&gt;</code>  — Video\n\n' +
    '<b>Auto-detect:</b>\n' +
    '  <code>/dl &lt;url&gt;</code>  — Any supported link\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '⚠️ Max file size: <b>50MB</b>\n' +
    '💡 Larger files sent as download link.'
  );
}

function msgSendHelp() {
  return (
    '<b>╔═══════════════════╗</b>\n' +
    '<b>║  💬  SEND WA MSG    ║</b>\n' +
    '<b>╚═══════════════════╝</b>\n\n' +
    '<b>Format:</b>\n' +
    '<code>/send &lt;number&gt; &lt;message&gt;</code>\n\n' +
    '<b>Example:</b>\n' +
    '<code>/send 94771234567 Hello from FAST Bot!</code>\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    '💡 Uses the first connected WA session.\n' +
    '📞 Include country code in the number.'
  );
}

// ═══════════════════════════════════════════════════════════════
// SECTION 5 — BOT START
// ═══════════════════════════════════════════════════════════════
function start() {
  const TOKEN = process.env.TG_SUPER_BOT_TOKEN;
  if (!TOKEN) {
    logger.warn('[TG-SUPER] TG_SUPER_BOT_TOKEN not set — super bot disabled');
    return;
  }

  bot = new TelegramBot(TOKEN, { polling: true });
  bot.on('polling_error', err => logger.error('[TG-SUPER] Polling error: ' + err.message));

  // /start
  bot.onText(/^\/start(@\S+)?$/, (msg) => {
    const name = msg.from && msg.from.first_name ? msg.from.first_name : 'there';
    bot.sendMessage(msg.chat.id, msgMain(name), { parse_mode: 'HTML', reply_markup: KB_MAIN });
  });

  // /help
  bot.onText(/^\/help(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, msgDlHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  // ── PAIR ────────────────────────────────────────────────────
  bot.onText(/^\/pair(?:@\S+)?\s+(.+)$/, async (msg, match) => {
    const num = (match[1] || '').replace(/[^0-9]/g, '');
    if (num.length < 7) return bot.sendMessage(msg.chat.id, msgPairHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
    await doPair(msg.chat.id, num);
  });

  bot.onText(/^\/pair(@\S+)?$/, (msg) => {
    const name = msg.from && msg.from.first_name ? msg.from.first_name : 'there';
    bot.sendMessage(msg.chat.id, msgPairHome(name), { parse_mode: 'HTML', reply_markup: KB_PAIR_HOME });
  });

  // ── MANAGEMENT (admin only) ──────────────────────────────────
  bot.onText(/^\/ping(@\S+)?$/, async (msg) => {
    if (!isAdmin(msg.from)) return;
    const t    = Date.now();
    const sent = await bot.sendMessage(msg.chat.id, '🏓 <i>Pinging...</i>', { parse_mode: 'HTML' });
    bot.editMessageText(msgPing(Date.now() - t), {
      chat_id: msg.chat.id, message_id: sent.message_id, parse_mode: 'HTML', reply_markup: KB_BACK,
    });
  });

  bot.onText(/^\/runtime(@\S+)?$/, (msg) => {
    if (!isAdmin(msg.from)) return;
    bot.sendMessage(msg.chat.id, msgRuntime(), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  bot.onText(/^\/(sessions|which)(@\S+)?$/, async (msg) => {
    if (!isAdmin(msg.from)) return;
    const sm = await getSM(30000);
    if (!sm) return bot.sendMessage(msg.chat.id, '❌ Session manager not ready. Try again in a moment.', { parse_mode: 'HTML' });
    const all   = sm.getAllSessions();
    const conn  = all.filter(s => s.status === 'connected');
    const pair  = all.filter(s => s.status === 'pairing');
    const other = all.filter(s => s.status !== 'connected' && s.status !== 'pairing');
    const lines = conn.length
      ? conn.map((s, i) => (i + 1) + '. <code>+' + (s.number || s.userId) + '</code>' + (s.name ? '  (' + s.name + ')' : '')).join('\n')
      : '<i>None connected</i>';
    bot.sendMessage(msg.chat.id, msgSessions(all.length, conn.length, pair.length, other.length, lines), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  bot.onText(/^\/send(?:@\S+)?\s+(\d+)\s+([\s\S]+)$/, async (msg, match) => {
    if (!isAdmin(msg.from)) return;
    const number = match[1].trim();
    const text   = match[2].trim();
    if (number.length < 7 || !text) return bot.sendMessage(msg.chat.id, msgSendHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });

    const sm = await getSM(8000);
    if (!sm) return bot.sendMessage(msg.chat.id, '❌ <b>Session manager not ready.</b>', { parse_mode: 'HTML' });
    const sessions = sm.getAllSessions().filter(s => s.status === 'connected');
    if (!sessions.length) return bot.sendMessage(msg.chat.id, '❌ <b>No connected sessions.</b>', { parse_mode: 'HTML' });

    const sess = sm.getSession(sessions[0].userId);
    const sock = sess && sess.sock;
    if (!sock) return bot.sendMessage(msg.chat.id, '❌ <b>Session socket not ready.</b>', { parse_mode: 'HTML' });

    try {
      await sock.sendMessage(number.replace(/\D/g, '') + '@s.whatsapp.net', { text });
      bot.sendMessage(msg.chat.id,
        '✅ <b>Message Sent!</b>\n\n📞 To: <code>+' + number + '</code>\n💬 <i>' + text.slice(0, 100) + '</i>',
        { parse_mode: 'HTML', reply_markup: KB_BACK }
      );
    } catch (e) {
      bot.sendMessage(msg.chat.id, '❌ <b>Failed:</b> <code>' + e.message + '</code>', { parse_mode: 'HTML' });
    }
  });

  bot.onText(/^\/send(@\S+)?$/, (msg) => {
    if (!isAdmin(msg.from)) return;
    bot.sendMessage(msg.chat.id, msgSendHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  // ── DOWNLOADS ────────────────────────────────────────────────
  bot.onText(/^\/yt(?:@\S+)?\s+(https?:\/\/\S+)$/, async (msg, match) => {
    await handleDownload(msg.chat.id, match[1].trim(), 'youtube', 'mp4');
  });
  bot.onText(/^\/yt(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, '📌 Usage: <code>/yt &lt;youtube_url&gt;</code>', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/mp3(?:@\S+)?\s+(https?:\/\/\S+)$/, async (msg, match) => {
    await handleDownload(msg.chat.id, match[1].trim(), 'youtube', 'mp3');
  });
  bot.onText(/^\/mp3(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, '📌 Usage: <code>/mp3 &lt;youtube_url&gt;</code>', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/tt(?:@\S+)?\s+(https?:\/\/\S+)$/, async (msg, match) => {
    await handleDownload(msg.chat.id, match[1].trim(), 'tiktok', 'video');
  });
  bot.onText(/^\/tt(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, '📌 Usage: <code>/tt &lt;tiktok_url&gt;</code>', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/ig(?:@\S+)?\s+(https?:\/\/\S+)$/, async (msg, match) => {
    await handleDownload(msg.chat.id, match[1].trim(), 'instagram', 'video');
  });
  bot.onText(/^\/ig(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, '📌 Usage: <code>/ig &lt;instagram_url&gt;</code>', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/fb(?:@\S+)?\s+(https?:\/\/\S+)$/, async (msg, match) => {
    await handleDownload(msg.chat.id, match[1].trim(), 'facebook', 'video');
  });
  bot.onText(/^\/fb(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, '📌 Usage: <code>/fb &lt;facebook_url&gt;</code>', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/dl(?:@\S+)?\s+(https?:\/\/\S+)$/, async (msg, match) => {
    const url      = match[1].trim();
    const platform = detectPlatform(url);
    if (!platform) {
      return bot.sendMessage(msg.chat.id,
        '❌ <b>Unsupported URL</b>\n\nUse: <code>/yt</code>  <code>/mp3</code>  <code>/tt</code>  <code>/ig</code>  <code>/fb</code>',
        { parse_mode: 'HTML' }
      );
    }
    await handleDownload(msg.chat.id, url, platform, 'video');
  });
  bot.onText(/^\/dl(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, msgDlHelp(), { parse_mode: 'HTML', reply_markup: KB_BACK });
  });

  // ── INLINE BUTTONS ───────────────────────────────────────────
  bot.on('callback_query', async (cb) => {
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const msgId  = cb.message && cb.message.message_id;
    const data   = cb.data || '';
    await bot.answerCallbackQuery(cb.id).catch(() => {});

    const edit = (text, kb) => bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'HTML',
      reply_markup: kb || KB_BACK,
    }).catch(() => {});

    // ── Public buttons ─────────────────────────────────────────
    if (data === 'home') {
      const name = cb.from && cb.from.first_name ? cb.from.first_name : 'there';
      return edit(msgMain(name), KB_MAIN);
    }
    if (data === 'pair_home') {
      const name = cb.from && cb.from.first_name ? cb.from.first_name : 'there';
      return edit(msgPairHome(name), KB_PAIR_HOME);
    }
    if (data === 'pair_help')        return edit(msgPairHelp());
    if (data.startsWith('retry_'))   return doPair(chatId, data.replace('retry_', ''), msgId);
    if (data === 'help_dl')          return edit(msgDlHelp());
    if (data === 'help_send')        return edit(msgSendHelp());

    // ── Admin-only buttons ─────────────────────────────────────
    if (!isAdmin(cb.from)) return;

    if (data === 'cmd_ping') {
      const t = Date.now();
      await edit('🏓 <i>Pinging...</i>');
      return edit(msgPing(Date.now() - t));
    }
    if (data === 'cmd_runtime') return edit(msgRuntime());
    if (data === 'cmd_sessions') {
      const sm = await getSM(8000);
      if (!sm) return edit('❌ Session manager not ready. Try again in a moment.');
      const all   = sm.getAllSessions();
      const conn  = all.filter(s => s.status === 'connected');
      const pair  = all.filter(s => s.status === 'pairing');
      const other = all.filter(s => s.status !== 'connected' && s.status !== 'pairing');
      const lines = conn.length
        ? conn.map((s, i) => (i + 1) + '. <code>+' + (s.number || s.userId) + '</code>' + (s.name ? '  (' + s.name + ')' : '')).join('\n')
        : '<i>None connected</i>';
      return edit(msgSessions(all.length, conn.length, pair.length, other.length, lines));
    }
  });

  logger.info('[TG-SUPER] Super bot started ✅  (Pair + Mgmt + Downloader)');
}

module.exports = { start };
