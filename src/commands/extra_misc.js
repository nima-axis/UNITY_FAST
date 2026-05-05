'use strict';
const { getT } = require('../lang');
const axios = require('axios');
const fetch = require('node-fetch');
const cfg = require('../../config');
const { sendButtons } = require('./helper');

// ── Clear ALL chats (uses sock._chatList populated at startup) ──
async function clearAllChatsOnStartup(sock) {
  return new Promise((resolve) => {
    sock.ev.once('chats.set', async ({ chats }) => {
      let cleared = 0, failed = 0;
      for (const chat of chats) {
        try {
          await sock.chatModify(
            { delete: true, lastMessages: chat.messages?.slice(0, 1) },
            chat.id
          );
          cleared++;
          await new Promise(r => setTimeout(r, 250));
        } catch { failed++; }
      }
      console.log(`[UNITY-MD] Startup clear: ✅ ${cleared} | ❌ ${failed}`);
      resolve({ cleared, failed });
    });
  });
}

// ── Manually clear all chats via command ──
async function nukeAllChats(sock) {
  const jids = [...(sock._chatJids || [])];
  if (jids.length === 0) {
    throw new Error('JID list empty. Bot restart කරලා ටිකක් wait කරලා retry කරන්න.');
  }

  let cleared = 0, failed = 0;
  const errors = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (const jid of jids) {
    // Build lastMessages — use real one if available, else construct with current timestamp
    const lm = sock._lastMsgMap?.[jid];
    const lastMessages = lm
      ? [{ key: lm.key, messageTimestamp: lm.messageTimestamp }]
      : [{ key: { remoteJid: jid, id: 'DELETE', fromMe: true }, messageTimestamp: nowSec }];

    let ok = false;

    // Primary: DELETE chat entirely (removes from list + all messages)
    try {
      await sock.chatModify({ delete: true, lastMessages }, jid);
      ok = true;
    } catch (e1) {
      // Fallback: delete with empty lastMessages
      try {
        await sock.chatModify({ delete: true, lastMessages: [] }, jid);
        ok = true;
      } catch (e2) {
        errors.push(`${jid.split('@')[0]}: ${e2.message?.slice(0, 40)}`);
      }
    }

    if (ok) cleared++;
    else failed++;

    await new Promise(r => setTimeout(r, 200));
  }

  return { cleared, failed, total: jids.length, errors: errors.slice(0, 3) };
}

module.exports = {
  commands: [
    'lyrics', 'lyric',
    'weather', 'wthr',
    'alive', 'status',
    'staff',
    'simp', 'stupid', 'goodnight',
    'shayari', 'roseday',
    'url', 'shorturl',
    'topmembers2',
    'clearallchats', 'nukechats',
    'chatcount',
    // ── UNITY misc features ───────────────────────────────────
    'presence', 'setonline', 'settyping', 'setrecording',
    'fakenumber', 'fakeno', 'genfake',
    'spam',
    'cinfo', 'countryinfo',
    'npmsearch', 'npminfo',
    'tiktok', 'ttsearch', 'ttdl',
    'pinterest', 'pinsearch',
    'channelreact', 'reactchannel',
    'repo', 'source', 'github2', 'git', 'github',
    'logo', 'textlogo',
    'ytsong', 'song2', 'play2', 'play3',
    'ytvideo', 'video', 'vid',
    'ytsearch2', 'yts2',
  ],

  async run({ sock, m }) {
    const tr = await getT(m.sessionOwner);
    const cmd = m.command;
    const chat = m.chat;
    const msg = m.msg;
    const text = m.text?.trim();

    // ── ALIVE ──────────────────────────────────────────────────
    if (cmd === 'alive' || cmd === 'status') {
      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600);
      const min = Math.floor((uptime % 3600) / 60);
      const s = Math.floor(uptime % 60);
      return sendButtons(sock, chat, {
        text:
          `▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜\n` +
          `◤◢ 🧲 𝙐𝙉𝙄𝙏𝙔-𝙈𝘿 🧩 ◤◢\n` +
          `▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟\n\n` +
          `✅ *Bot is Online!*\n` +
          `⏱️ *Uptime:* ${h}h ${min}m ${s}s\n` +
          `👑 *Owner:* ${cfg.ownerName}\n\n` +
          `${cfg.footer}`,
        footer: cfg.footer,
        buttons: [
          { label: '📋 Menu', id: '.menu' },
          { label: '🏓 Ping', id: '.ping' },
        ],
        quoted: msg,
      });
    }

    // ── LYRICS ─────────────────────────────────────────────────
    if (cmd === 'lyrics' || cmd === 'lyric') {
      if (!text) {
        return sendButtons(sock, chat, {
          text: `📌 Usage: *.lyrics* [song name]\n\nExample: *.lyrics* Blinding Lights\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(text.split(' ').slice(0, 2).join('/'))}/${encodeURIComponent(text.split(' ').slice(2).join(' ') || text)}`, { timeout: 15000 });
        const data = await res.json();
        if (!data.lyrics) throw new Error('Not found');
        const shortened = data.lyrics.length > 2000 ? data.lyrics.slice(0, 2000) + '...' : data.lyrics;
        await m.react('✅');
        return sendButtons(sock, chat, {
          text: `🎵 *Lyrics: ${text}*\n\n${shortened}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      } catch {
        try {
          const res2 = await axios.get(`https://some-random-api.com/lyrics?title=${encodeURIComponent(text)}`, { timeout: 15000 });
          const shortened = (res2.data.lyrics || '').length > 2000 ? res2.data.lyrics.slice(0, 2000) + '...' : res2.data.lyrics;
          await m.react('✅');
          return sendButtons(sock, chat, {
            text: `🎵 *${res2.data.title || text}*\n🎤 *${res2.data.author || ''}*\n\n${shortened}\n\n${cfg.footer}`,
            footer: cfg.footer,
            buttons: [{ label: '📋 Menu', id: '.menu' }],
            quoted: msg,
          });
        } catch {
          await m.react('❌');
          return m.reply(`❌ Lyrics not found for *${text}*!\n\n${cfg.footer}`);
        }
      }
    }

    // ── WEATHER ────────────────────────────────────────────────
    if (cmd === 'weather' || cmd === 'wthr') {
      if (!text) {
        return sendButtons(sock, chat, {
          text: `📌 Usage: *.weather* [city]\n\nExample: *.weather* Colombo\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const apiKey = '4902c0f2550f58298ad4146a92b65e10';
        const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(text)}&appid=${apiKey}&units=metric`, { timeout: 15000 });
        const w = res.data;
        const emoji = w.weather[0].main === 'Rain' ? '🌧️' : w.weather[0].main === 'Clear' ? '☀️' : w.weather[0].main === 'Clouds' ? '☁️' : '🌡️';
        await m.react('✅');
        return sendButtons(sock, chat, {
          text:
            `${emoji} *Weather in ${w.name}, ${w.sys.country}*\n\n` +
            `🌡️ *Temperature:* ${w.main.temp}°C\n` +
            `🤔 *Feels like:* ${w.main.feels_like}°C\n` +
            `💧 *Humidity:* ${w.main.humidity}%\n` +
            `💨 *Wind:* ${w.wind.speed} m/s\n` +
            `☁️ *Condition:* ${w.weather[0].description}\n\n` +
            `${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '🔄 Refresh', id: `.weather ${text}` }],
          quoted: msg,
        });
      } catch {
        await m.react('❌');
        return m.reply(`❌ Could not fetch weather for *${text}*!\n\n${cfg.footer}`);
      }
    }

    // ── SIMP ───────────────────────────────────────────────────
    if (cmd === 'simp') {
      const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const repliedParticipant = msg?.message?.extendedTextMessage?.contextInfo?.participant;
      const target = mentioned[0] || repliedParticipant || m.sender;
      const percent = Math.floor(Math.random() * 101);
      const bar = '█'.repeat(Math.ceil(percent / 10)) + '░'.repeat(10 - Math.ceil(percent / 10));
      return sock.sendMessage(chat, {
        text: `😍 *SIMP METER*\n\n@${target.split('@')[0]}\n\n[${bar}] ${percent}%\n\n${percent > 70 ? '💘 Major simp detected!' : percent > 40 ? '😅 Mild simp energy' : '😎 Not simping!'}\n\n${cfg.footer}`,
        mentions: [target],
      }, { quoted: msg });
    }

    // ── STUPID ─────────────────────────────────────────────────
    if (cmd === 'stupid') {
      const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const repliedParticipant = msg?.message?.extendedTextMessage?.contextInfo?.participant;
      const target = mentioned[0] || repliedParticipant || m.sender;
      const percent = Math.floor(Math.random() * 101);
      const bar = '█'.repeat(Math.ceil(percent / 10)) + '░'.repeat(10 - Math.ceil(percent / 10));
      return sock.sendMessage(chat, {
        text: `🤪 *STUPID METER*\n\n@${target.split('@')[0]}\n\n[${bar}] ${percent}%\n\n${percent > 70 ? '💀 Certified stupid!' : percent > 40 ? '😬 Kinda dumb ngl' : '🧠 Actually pretty smart!'}\n\n${cfg.footer}`,
        mentions: [target],
      }, { quoted: msg });
    }

    // ── GOODNIGHT ──────────────────────────────────────────────
    if (cmd === 'goodnight') {
      const msgs = [
        "🌙 Goodnight! Sweet dreams! 💤",
        "😴 Time to rest! Goodnight everyone! 🌟",
        "🌛 Goodnight! May you have beautiful dreams! 🦋",
        "💤 Rest well! Goodnight! 🌙",
        "⭐ Goodnight! Tomorrow will be better! 🌈",
      ];
      return sendButtons(sock, chat, {
        text: msgs[Math.floor(Math.random() * msgs.length)] + `\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
    }

    // ── SHAYARI ────────────────────────────────────────────────
    if (cmd === 'shayari') {
      await m.react('💝');
      try {
        const res = await fetch('https://shizoapi.onrender.com/api/texts/shayari?apikey=shizo', { timeout: 10000 });
        const json = await res.json();
        await m.react('✅');
        return sendButtons(sock, chat, {
          text: `💝 *Shayari*\n\n${json.result}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '💝 Another', id: '.shayari' }],
          quoted: msg,
        });
      } catch {
        await m.react('❌');
        return m.reply(`${tr('err_failed')}\n\n${cfg.footer}`);
      }
    }

    // ── ROSEDAY ────────────────────────────────────────────────
    if (cmd === 'roseday') {
      const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const target = mentioned[0];
      if (!target) {
        return sendButtons(sock, chat, {
          text: `📌 Usage: *.roseday* @user\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      return sock.sendMessage(chat, {
        text: `🌹 *Happy Rose Day!*\n\n@${target.split('@')[0]}, here's a rose for you! 🌹🌹🌹\n\nSent with love! 💕\n\n${cfg.footer}`,
        mentions: [target],
      }, { quoted: msg });
    }

    // ── URL SHORTENER ─────────────────────────────────────────
    if (cmd === 'url' || cmd === 'shorturl') {
      if (!text || !text.startsWith('http')) {
        return sendButtons(sock, chat, {
          text: `📌 Usage: *.url* [link]\n\nExample: *.url* https://example.com\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text)}`, { timeout: 15000 });
        await m.react('✅');
        return sendButtons(sock, chat, {
          text: `🔗 *URL Shortened!*\n\n📎 *Original:* ${text}\n🔗 *Short:* ${res.data}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      } catch {
        await m.react('❌');
        return m.reply(`❌ Failed to shorten URL!\n\n${cfg.footer}`);
      }
    }

    // ── STAFF ──────────────────────────────────────────────────
    if (cmd === 'staff') {
      return sendButtons(sock, chat, {
        text:
          `👑 *BOT STAFF*\n\n` +
          `┌──────────────\n` +
          `│ 👑 Owner: ${cfg.ownerName}\n` +
          `│ 🤖 Bot: ${cfg.botName || 'UNITY-MD'}\n` +
          `└──────────────\n\n` +
          `${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
    }

    // ── CHAT COUNT DEBUG ───────────────────────────────────────
    if (cmd === 'chatcount') {
      if (!m.isOwner) return m.reply(`❌ Owner only command!\n\n${cfg.footer}`);
      const count = sock._chatJids?.size || 0;
      const lmCount = Object.keys(sock._lastMsgMap || {}).length;
      return m.reply(
        `📊 *Chat Tracker Debug*\n\n` +
        `📋 Known JIDs: ${count}\n` +
        `💬 With last msg: ${lmCount}\n\n` +
        `JIDs (first 10):\n${[...(sock._chatJids || [])].slice(0, 10).map(j => `• ${j}`).join('\n') || 'none'}\n\n${cfg.footer}`
      );
    }

    // ── CLEAR ALL CHATS ────────────────────────────────────────
    if (cmd === 'clearallchats' || cmd === 'nukechats') {
      if (!m.isOwner) return m.reply(`❌ Owner only command!\n\n${cfg.footer}`);

      await m.react('🧹');
      try {
        // Clear only the current chat
        const nowSec = Math.floor(Date.now() / 1000);
        const lm = sock._lastMsgMap?.[chat];
        const lastMessages = lm
          ? [{ key: lm.key, messageTimestamp: lm.messageTimestamp }]
          : [{ key: { remoteJid: chat, id: 'DELETE', fromMe: true }, messageTimestamp: nowSec }];

        try {
          await sock.chatModify({ delete: true, lastMessages }, chat);
        } catch {
          await sock.chatModify({ delete: true, lastMessages: [] }, chat);
        }

        await m.react('✅');
        return m.reply(`🧹 *Chat cleared!*\n\n${cfg.footer}`);
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ *Failed:* ${e.message}\n\n${cfg.footer}`);
      }
    }
  },

  nukeAllChats,
};

// ══════════════════════════════════════════════════════════════
// PATCH: UNITY misc features appended to run() via monkey-patch
// ══════════════════════════════════════════════════════════════
// NOTE: The features below are injected via the module's run patch
// in messageHandler — OR — placed here as a separate export merged
// at load time. We use a self-contained second module export that
// messageHandler will pick up because it scans all commands arrays.

const cfg2  = require('../../config');
const { sendButtons: sendButtons2 } = require('./helper');

const _unityExtra = {
  commands: [
    'presence', 'setonline', 'settyping', 'setrecording',
    'fakenumber', 'fakeno', 'genfake',
    'spam',
    'cinfo', 'countryinfo',
    'npmsearch', 'npminfo',
    'tiktok', 'ttsearch', 'ttdl',
    'pinterest', 'pinsearch',
    'channelreact', 'reactchannel',
    'repo', 'source', 'github2', 'git', 'github',
    'logo', 'textlogo',
    'ytsong', 'song2', 'play2', 'play3',
    'ytvideo', 'video', 'vid',
    'ytsearch2', 'yts2',
  ],

  async run({ sock, m }) {
    const cmd  = m.command;
    const chat = m.chat;
    const msg  = m.msg;
    const q    = m.text?.trim();

    // ── PRESENCE (set bot online/typing/recording) ────────────
    if (['presence','setonline','settyping','setrecording'].includes(cmd)) {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg2.footer}`);
      let type = 'available';
      if (cmd === 'settyping'    || q === 'typing'    || q === 'composing')  type = 'composing';
      if (cmd === 'setrecording' || q === 'recording')                        type = 'recording';
      if (q === 'unavailable'    || q === 'offline')                          type = 'unavailable';
      await sock.sendPresenceUpdate(type, chat).catch(() => {});
      return sendButtons2(sock, chat, {
        text: `⚡ *Presence set to:* \`${type}\`\n\n${cfg2.footer}`,
        footer: cfg2.footer,
        buttons: [
          { label: '⌨️ Typing',   id: '.settyping' },
          { label: '🎙️ Recording', id: '.setrecording' },
          { label: '🟢 Online',    id: '.setonline' },
        ],
        quoted: msg,
      });
    }

    // ── FAKE NUMBER GENERATOR ─────────────────────────────────
    if (['fakenumber','fakeno','genfake'].includes(cmd)) {
      const countryCode = q || '94';
      const fakePart    = Math.floor(Math.random() * 9000000000 + 1000000000);
      const fakeNum     = `+${countryCode}${fakePart}`.slice(0, 13);
      const fakeEmail   = `user${Math.floor(Math.random()*99999)}@gmail.com`;
      const fakeNames   = ['Ashan Fernando','Kasun Perera','Nimasha Silva','Dinusha Jayawardena','Lahiru Bandara','Sithum Jayasuriya'];
      const fakeName    = fakeNames[Math.floor(Math.random() * fakeNames.length)];
      return sendButtons2(sock, chat, {
        text: `🎭 *Fake Number Generator*\n\n👤 *Name:* ${fakeName}\n📱 *Number:* \`${fakeNum}\`\n📧 *Email:* \`${fakeEmail}\`\n\n> For educational use only\n\n${cfg2.footer}`,
        footer: cfg2.footer,
        buttons: [
          { label: '🔄 Generate Again', id: `.fakenumber ${countryCode}` },
          { label: '📋 Menu',           id: '.menu' },
        ],
        quoted: msg,
      });
    }

    // ── SPAM TOOL (owner only) ────────────────────────────────
    if (cmd === 'spam') {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg2.footer}`);
      const parts  = q?.split(' ');
      const count  = parseInt(parts?.[0]);
      const spamMsg = parts?.slice(1).join(' ');
      if (!count || count < 1 || count > 20 || !spamMsg) {
        return sendButtons2(sock, chat, {
          text: `📌 *SPAM TOOL*\n\n*.spam* [count 1-20] [message]\n\nExample: .spam 5 Hello!\n\n⚠️ Use responsibly\n\n${cfg2.footer}`,
          footer: cfg2.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      for (let i = 0; i < Math.min(count, 20); i++) {
        await sock.sendMessage(chat, { text: spamMsg }, { quoted: msg });
        await new Promise(r => setTimeout(r, 500));
      }
      return;
    }

    // ── COUNTRY INFO ──────────────────────────────────────────
    if (cmd === 'cinfo' || cmd === 'countryinfo') {
      if (!q) {
        return sendButtons2(sock, chat, {
          text: `📌 *COUNTRY INFO*\n\nUsage: *.cinfo* [country name]\n\nExample: .cinfo Sri Lanka\n\n${cfg2.footer}`,
          footer: cfg2.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const res  = await axios.get(`https://restcountries.com/v3.1/name/${encodeURIComponent(q)}`, { timeout: 15000 });
        const c    = res.data[0];
        const curr = Object.values(c.currencies || {})[0];
        const lang = Object.values(c.languages || {}).join(', ');
        const text =
          `🌍 *Country Info*\n\n` +
          `🏳️ *Name:* ${c.name?.common}\n` +
          `🗺️ *Official:* ${c.name?.official}\n` +
          `🌐 *Region:* ${c.region} › ${c.subregion || '—'}\n` +
          `🏙️ *Capital:* ${c.capital?.[0] || '—'}\n` +
          `👥 *Population:* ${(c.population || 0).toLocaleString()}\n` +
          `💰 *Currency:* ${curr?.name || '—'} (${curr?.symbol || '—'})\n` +
          `🗣️ *Languages:* ${lang || '—'}\n` +
          `🕐 *Timezone:* ${c.timezones?.[0] || '—'}\n` +
          `📞 *Calling Code:* +${(c.idd?.root || '') + (c.idd?.suffixes?.[0] || '')}\n` +
          `🌐 *TLD:* ${c.tld?.[0] || '—'}\n\n` +
          `${cfg2.footer}`;
        await m.react('✅');
        return sendButtons2(sock, chat, {
          text,
          footer: cfg2.footer,
          buttons: [
            { label: '🔍 Search Again', id: '.cinfo' },
            { label: '📋 Menu',         id: '.menu' },
          ],
          quoted: msg,
        });
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Country not found: "${q}"\n\n${cfg2.footer}`);
      }
    }

    // ── NPM SEARCH ────────────────────────────────────────────
    if (cmd === 'npmsearch' || cmd === 'npminfo') {
      if (!q) return m.reply(`📌 Usage: *.npmsearch* [package name]\n\nExample: .npmsearch axios\n\n${cfg2.footer}`);
      await m.react('⏳');
      try {
        const res  = await axios.get(`https://registry.npmjs.org/${encodeURIComponent(q)}`, { timeout: 15000 });
        const pkg  = res.data;
        const ver  = pkg['dist-tags']?.latest;
        const info = pkg.versions?.[ver];
        const text =
          `📦 *NPM Package Info*\n\n` +
          `🏷️ *Name:* ${pkg.name}\n` +
          `📝 *Description:* ${pkg.description || '—'}\n` +
          `📌 *Latest:* v${ver}\n` +
          `👤 *Author:* ${typeof pkg.author === 'object' ? pkg.author?.name : pkg.author || '—'}\n` +
          `🔗 *Homepage:* ${pkg.homepage || '—'}\n` +
          `📜 *License:* ${info?.license || pkg.license || '—'}\n` +
          `⬇️ *Install:* \`npm i ${pkg.name}\`\n\n` +
          `${cfg2.footer}`;
        await m.react('✅');
        return sendButtons2(sock, chat, {
          text,
          footer: cfg2.footer,
          buttons: [
            { label: '🔗 NPM Page', id: `.npmsearch ${pkg.name}` },
            { label: '📋 Menu',     id: '.menu' },
          ],
          quoted: msg,
        });
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Package not found: "${q}"\n\n${cfg2.footer}`);
      }
    }

    // ── TIKTOK SEARCH / DOWNLOAD ──────────────────────────────
    if (['tiktok','ttsearch','ttdl'].includes(cmd)) {
      if (!q) {
        return sendButtons2(sock, chat, {
          text: `🎵 *TikTok*\n\n*.tiktok* [search query] — Search\n*.ttdl* [tiktok url] — Download video\n*.ttmp3* [tiktok url] — Audio only\n\n${cfg2.footer}`,
          footer: cfg2.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');

      // ── Helper: TikTok Download (multi-method fallback) ──────
      async function ttDownload(url) {
        const enc = encodeURIComponent(url);

        // Method 1: tikwm.com
        try {
          const r = await axios.post('https://www.tikwm.com/api/', `url=${enc}&count=12&cursor=0&web=1&hd=1`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000,
          });
          const d = r.data?.data;
          if (d?.play) return { title: d.title || 'TikTok Video', videoUrl: d.hdplay || d.play, audioUrl: d.music, cover: d.cover, author: d.author?.nickname || '—', likes: d.digg_count || 0 };
        } catch {}

        // Method 2: tiklydown
        try {
          const r = await axios.get(`https://api.tiklydown.eu.org/api/download/v3?url=${enc}`, { timeout: 20000 });
          const d = r.data;
          if (d?.video?.noWatermark) return { title: d.title || 'TikTok Video', videoUrl: d.video.noWatermark, audioUrl: d.music?.play_url, cover: d.cover, author: d.author?.name || '—', likes: d.stats?.likeCount || 0 };
        } catch {}

        // Method 3: ttsave
        try {
          const r = await axios.get(`https://ttsave.app/download?id=${enc}&lang=en`, { timeout: 20000 });
          const d = r.data;
          const vUrl = d?.data?.links?.find(l => l.label?.includes('No Watermark'))?.link;
          if (vUrl) return { title: d.data?.title || 'TikTok Video', videoUrl: vUrl, audioUrl: null, cover: d.data?.cover, author: d.data?.author || '—', likes: 0 };
        } catch {}

        // Method 4: savetik
        try {
          const r = await axios.get(`https://savetik.co/api/ajaxSearch`, {
            params: { q: url, lang: 'en' },
            timeout: 20000,
          });
          const d = r.data;
          if (d?.status === 'ok') {
            const match = d.data?.match(/href="(https:\/\/[^"]+no_watermark[^"]+)"/);
            if (match) return { title: 'TikTok Video', videoUrl: match[1], audioUrl: null, cover: null, author: '—', likes: 0 };
          }
        } catch {}

        throw new Error('All download methods failed');
      }

      // ── Helper: TikTok Search (multi-method fallback) ────────
      async function ttSearch(query) {
        const enc = encodeURIComponent(query);

        // Method 1: tikwm search
        try {
          const r = await axios.get(`https://www.tikwm.com/api/feed/search?keywords=${enc}&count=5&cursor=0&web=1`, { timeout: 20000 });
          const items = r.data?.data?.videos;
          if (items?.length) {
            return items.slice(0, 3).map(v => ({
              title: v.title || 'TikTok Video',
              author: v.author?.nickname || '—',
              likes: v.digg_count || 0,
              views: v.play_count || 0,
              url: `https://www.tiktok.com/@${v.author?.unique_id}/video/${v.video_id}`,
              cover: v.cover,
            }));
          }
        } catch {}

        // Method 2: tiktok oembedding via rapidapi-style
        try {
          const r = await axios.get(`https://scraptik.p.rapidapi.com/search?keyword=${enc}&count=5`, {
            headers: {
              'X-RapidAPI-Key': 'SIGN-UP-FOR-KEY',
              'X-RapidAPI-Host': 'scraptik.p.rapidapi.com',
            },
            timeout: 15000,
          });
          const items = r.data?.aweme_list;
          if (items?.length) {
            return items.slice(0, 3).map(v => ({
              title: v.desc || 'TikTok Video',
              author: v.author?.nickname || '—',
              likes: v.statistics?.digg_count || 0,
              views: v.statistics?.play_count || 0,
              url: `https://www.tiktok.com/@${v.author?.unique_id}/video/${v.aweme_id}`,
              cover: null,
            }));
          }
        } catch {}

        // Method 3: dark-yasiya fallback (original, may or may not work)
        try {
          const r = await axios.get(`https://www.dark-yasiya-api.site/search/tiktok?query=${enc}`, { timeout: 15000 });
          const items = r.data?.result;
          if (items?.length) {
            return items.slice(0, 3).map(v => ({
              title: v.title || 'TikTok Video',
              author: v.author || '—',
              likes: v.like_count || 0,
              views: v.view_count || 0,
              url: v.url,
              cover: null,
            }));
          }
        } catch {}

        throw new Error('All search methods failed');
      }

      try {
        if (q.startsWith('https://')) {
          // ── DOWNLOAD ──────────────────────────────────────────
          const { title, videoUrl, audioUrl, author, likes } = await ttDownload(q);
          await sock.sendMessage(chat, {
            video: { url: videoUrl },
            caption: `🎵 *${title}*\n👤 ${author}\n❤️ ${likes.toLocaleString()}\n\n${cfg2.footer}`,
          }, { quoted: msg });
          await m.react('✅');
        } else {
          // ── SEARCH ────────────────────────────────────────────
          const results = await ttSearch(q);
          const top = results[0];
          const otherLinks = results.slice(1).map((r, i) => `\n${i + 2}. ${r.title?.slice(0, 40)} — ${r.url}`).join('');
          return sendButtons2(sock, chat, {
            text: `🎵 *TikTok Search* — "${q}"\n\n📌 *${top.title}*\n👤 *Author:* ${top.author}\n❤️ *Likes:* ${top.likes.toLocaleString()}\n▶️ *Views:* ${top.views.toLocaleString()}\n\n${otherLinks ? `*More results:*${otherLinks}\n\n` : ''}*.ttdl* ${top.url}\n\n${cfg2.footer}`,
            footer: cfg2.footer,
            buttons: [
              { label: '⬇️ Download #1', id: `.ttdl ${top.url}` },
              { label: '📋 Menu',         id: '.menu' },
            ],
            quoted: msg,
          });
        }
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ TikTok error: ${e.message}\n\n💡 Try a different URL or keyword.\n\n${cfg2.footer}`);
      }
    }

    // ── PINTEREST SEARCH ──────────────────────────────────────
    if (cmd === 'pinterest' || cmd === 'pinsearch') {
      if (!q) return m.reply(`📌 Usage: *.pinterest* [search term]\n\nExample: .pinterest anime girl\n\n${cfg2.footer}`);
      await m.react('⏳');
      try {
        const res  = await axios.get(`https://allstars-apis.vercel.app/pinterest?search=${encodeURIComponent(q)}`, { timeout: 20000 });
        const data = res.data;
        const imgs = data?.data;
        if (!imgs || !imgs.length) throw new Error('No results');

        const shuffled = imgs.sort(() => Math.random() - 0.5).slice(0, 6);
        for (const url of shuffled) {
          await sock.sendMessage(chat, {
            image: { url },
            caption: `🖼️ *Pinterest* — ${q}\n\n${cfg2.footer}`,
          }).catch(() => {});
        }
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Pinterest error: ${e.message}\n\n${cfg2.footer}`);
      }
    }

    // ── CHANNEL REACT ─────────────────────────────────────────
    if (cmd === 'channelreact' || cmd === 'reactchannel') {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg2.footer}`);
      if (!q) {
        return sendButtons2(sock, chat, {
          text: `📌 *CHANNEL REACT*\n\nUsage: *.channelreact* [emoji] [channel_jid]\n\nExample: .channelreact ❤️\n\n${cfg2.footer}`,
          footer: cfg2.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      try {
        const parts = q.split(' ');
        const emoji = parts[0];
        const channelJid = parts[1] || cfg2.channel1 || '';
        if (!channelJid) return m.reply(`❌ No channel JID provided or configured.\n\n${cfg2.footer}`);

        const ctxMsg = msg?.message?.extendedTextMessage?.contextInfo;
        const replyKey = ctxMsg?.stanzaId ? {
          remoteJid: channelJid,
          fromMe: false,
          id: ctxMsg.stanzaId,
          participant: ctxMsg.participant,
        } : null;

        if (replyKey) {
          await sock.sendMessage(channelJid, { react: { text: emoji, key: replyKey } });
          return m.reply(`✅ Reacted with ${emoji}!\n\n${cfg2.footer}`);
        }
        return m.reply(`📌 Reply to a channel message with *.channelreact* ${emoji}\n\n${cfg2.footer}`);
      } catch (e) {
        return m.reply(`❌ Error: ${e.message}\n\n${cfg2.footer}`);
      }
    }

    // ── REPO INFO ─────────────────────────────────────────────
    if (['repo','source','github2','git','github'].includes(cmd)) {
      // ── 1. Resolve pair URL from config (auto-detects Railway/Render/custom) ──
      const pairUrl = cfg2.pairUrl || null;

      // ── 2. Resolve sender's real phone number (handles @s.whatsapp.net & @lid) ──
      let senderPhone = '';
      const senderJid = !m.isGroup ? (m.chat || '') : (m.sender || '');
      const senderIsLid = senderJid.endsWith('@lid');
      if (senderJid.endsWith('@s.whatsapp.net')) {
        senderPhone = senderJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
      } else if (senderJid.endsWith('@lid')) {
        const contact = sock.store?.contacts?.[senderJid];
        const resolved = contact?.phoneJid || contact?.id || '';
        if (resolved.endsWith('@s.whatsapp.net')) {
          senderPhone = resolved.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
        }
      }
      // NOTE: m.senderNum fallback intentionally removed — for @lid JIDs
      // senderNum contains LID digits (not a real phone), so no fallback here.

      // ── 3. Build pair info line & buttons ───────────────────
      let pairInfoLine = '';
      const repoButtons = [];

      if (pairUrl) {
        pairInfoLine = `🌐 *Pair Link:*\n   ${pairUrl}\n`;
        repoButtons.push({ label: '🌐 Open Pair Page', url: pairUrl });
      } else {
        pairInfoLine = `🔗 *Pair:* Use *.pair <your number>* in this chat\n`;
      }
      // Only show 1-tap button if JID is real phone (@s.whatsapp.net), not @lid
      if (senderPhone && !senderIsLid) {
        repoButtons.push({ label: '⚡ Pair Now (1-tap)', id: `.pair ${senderPhone}` });
      } else if (senderIsLid) {
        repoButtons.push({ label: '🔗 Pair (type your number)', id: `.pair` });
      }
      repoButtons.push({ label: '📋 Menu', id: '.menu' });

      // ── 4. Send reply ────────────────────────────────────────
      const repoText =
        `╭━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `┃  🧲🌐 *UNITY - MD* 🌐🧩  ┃\n` +
        `┃      ® UNITY  TEAM         ┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `📦 *Bot:* UNITY-MD\n` +
        `👨‍💻 *Creator:* UNITY TEAM\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🔌 *HOW TO PAIR YOUR BOT*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        pairInfoLine +
        (senderPhone && !senderIsLid
          ? `📱 *Your Number:* +${senderPhone}\n   _(tap ⚡ Pair Now to connect instantly)_\n`
          : `📱 *Your Number:* Type *.pair 947XXXXXXXX* (with country code)\n`) +
        `\n` +
        `📢 *Support:* ${cfg2.channel1 ? 'Follow our Channel' : 'Contact owner'}\n\n` +
        `${cfg2.footer}`;

      // ── Set unity_thumb.jpg at top of pair/repo message ──────
      const _prevPoolImg = global._cmdPoolImage;
      try {
        const _p = require('path');
        const _fs2 = require('fs-extra');
        const thumbPath = _p.join(__dirname, '../media/unity_thumb.jpg');
        if (_fs2.existsSync(thumbPath)) {
          global._cmdPoolImage = { stream: _fs2.createReadStream(thumbPath) };
        } else {
          global._cmdPoolImage = { url: 'https://raw.githubusercontent.com/nima-axis/UNITY_FAST/refs/heads/main/src/media/unity_thumb.jpg' };
        }
      } catch { global._cmdPoolImage = null; }
      const _repoResult = await sendButtons2(sock, chat, {
        text: repoText,
        footer: cfg2.footer,
        buttons: repoButtons,
        quoted: msg,
      });
      global._cmdPoolImage = _prevPoolImg;
      return _repoResult;
    }

    // ── LOGO GENERATOR ────────────────────────────────────────
    if (cmd === 'logo' || cmd === 'textlogo') {
      if (!q) {
        return sendButtons2(sock, chat, {
          text: `📌 *LOGO GENERATOR*\n\nUsage: *.logo* [text]\n\nExample: .logo UNITY MD\n\n${cfg2.footer}`,
          footer: cfg2.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const encodedText = encodeURIComponent(q);
        const logoApis = [
          `https://api.popcat.xyz/texttospeech?text=${encodedText}`,
          `https://api.aggelos-007.xyz/textart?text=${encodedText}&type=block`,
          `https://api.siputzx.my.id/api/logo/neon?text=${encodedText}&color=blue`,
        ];
        // Try logo API — use flamingtext style
        const logoUrl = `https://flamingtext.com/net-fu/proxy_form.cgi?imageoutput=true&script=crafts-logo&text=${encodedText}&doScale=true&scaleWidth=800&scaleHeight=400`;
        const res = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 20000 });
        await sock.sendMessage(chat, {
          image: Buffer.from(res.data),
          caption: `🎨 *Logo:* ${q}\n\n${cfg2.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Logo generation failed: ${e.message}\n\n${cfg2.footer}`);
      }
    }

    // ── YOUTUBE SONG (song2/play2/play3) ──────────────────────
    if (['ytsong','song2','play2','play3'].includes(cmd)) {
      if (!q) {
        return sendButtons2(sock, chat, {
          text: `📌 *YT SONG DOWNLOADER*\n\nUsage: *.song2* [title or URL]\n\nExample: .song2 Shape of You\n\n${cfg2.footer}`,
          footer: cfg2.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const yts = require('yt-search');
        const res = await yts(q);
        const vid = res?.videos?.[0];
        if (!vid) throw new Error('No results found');

        const ytUrl = `https://www.youtube.com/watch?v=${vid.videoId}`;
        const dlRes = await axios.get(
          `https://apis-keith.vercel.app/download/dlmp3?url=${encodeURIComponent(ytUrl)}`,
          { timeout: 60000 }
        );
        const dlUrl = dlRes.data?.result?.download_url || dlRes.data?.result?.downloadUrl;
        if (!dlUrl) throw new Error('Download URL not found');

        await m.react('⬆️');
        await sock.sendMessage(chat, {
          audio: { url: dlUrl },
          mimetype: 'audio/mpeg',
          contextInfo: {
            externalAdReply: {
              title: vid.title,
              body: `${vid.author.name} • ${vid.timestamp}`,
              mediaType: 1,
              sourceUrl: ytUrl,
              thumbnailUrl: vid.thumbnail,
              renderLargerThumbnail: true,
              showAdAttribution: true,
            },
          },
        }, { quoted: msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Song download failed: ${e.message}\n\n${cfg2.footer}`);
      }
    }

    // ── YOUTUBE VIDEO ─────────────────────────────────────────
    if (['ytvideo','video','vid'].includes(cmd)) {
      if (!q) {
        return sendButtons2(sock, chat, {
          text: `📌 *YT VIDEO DOWNLOADER*\n\n*.video* [title or URL]\n\nReply with quality:\n*1* — 144p  *2* — 240p  *3* — 360p  *4* — 480p  *5* — 720p\n\n${cfg2.footer}`,
          footer: cfg2.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const yts = require('yt-search');
        const res = await yts(q);
        const vid = res?.videos?.[0];
        if (!vid) throw new Error('No results found');

        const ytUrl = `https://www.youtube.com/watch?v=${vid.videoId}`;
        const qualityApis = {
          '144p': `https://minisave.vercel.app/api/ytmp4_v2?url=${encodeURIComponent(ytUrl)}&quality=144`,
          '240p': `https://minisave.vercel.app/api/ytmp4_v2?url=${encodeURIComponent(ytUrl)}&quality=240`,
          '360p': `https://minisave.vercel.app/api/ytmp4_v2?url=${encodeURIComponent(ytUrl)}&quality=360`,
          '480p': `https://minisave.vercel.app/api/ytmp4_v2?url=${encodeURIComponent(ytUrl)}&quality=480`,
          '720p': `https://minisave.vercel.app/api/ytmp4_v2?url=${encodeURIComponent(ytUrl)}&quality=720`,
        };

        const sentMsg = await sock.sendMessage(chat, {
          image: { url: vid.thumbnail },
          caption:
            `🎬 *${vid.title}*\n` +
            `👤 *${vid.author.name}*\n` +
            `⏱️ ${vid.timestamp}\n` +
            `👁️ ${vid.views?.toLocaleString?.() || '—'}\n\n` +
            `*Reply with quality:*\n*1* — 144p  *2* — 240p  *3* — 360p\n*4* — 480p  *5* — 720p\n\n` +
            `${cfg2.footer}`,
        }, { quoted: msg });

        const sentId = sentMsg?.key?.id;

        const listener = sock.ev.on('messages.upsert', async (upsert) => {
          const reply = upsert.messages[0];
          if (!reply?.message) return;
          const repText  = reply.message?.conversation || reply.message?.extendedTextMessage?.text;
          const repCtx   = reply.message?.extendedTextMessage?.contextInfo?.stanzaId;
          const replyJid = reply.key.remoteJid;
          if (replyJid !== chat || repCtx !== sentId) return;

          const qualMap = { '1': '144p', '2': '240p', '3': '360p', '4': '480p', '5': '720p' };
          const quality = qualMap[repText?.trim()];
          if (!quality) return;

          sock.ev.off('messages.upsert', listener);
          await sock.sendMessage(chat, { react: { text: '⏳', key: reply.key } });

          try {
            const { data } = await axios.get(qualityApis[quality], { timeout: 60000 });
            const dlUrl    = data?.result?.download_url || data?.result?.downloadUrl || data?.download_url;
            if (!dlUrl) throw new Error('No download URL');

            await sock.sendMessage(chat, {
              video: { url: dlUrl },
              mimetype: 'video/mp4',
              caption: `🎬 *${vid.title}* — ${quality}\n\n${cfg2.footer}`,
            }, { quoted: reply });
            await sock.sendMessage(chat, { react: { text: '✅', key: reply.key } });
          } catch (e2) {
            await sock.sendMessage(chat, { react: { text: '❌', key: reply.key } });
            await sock.sendMessage(chat, { text: `❌ Failed for ${quality}: ${e2.message}\n\n${cfg2.footer}` }, { quoted: reply });
          }
        });

        setTimeout(() => sock.ev.off('messages.upsert', listener), 120000);
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Video search failed: ${e.message}\n\n${cfg2.footer}`);
      }
    }

    // ── YOUTUBE SEARCH ────────────────────────────────────────
    if (cmd === 'ytsearch2' || cmd === 'yts2') {
      if (!q) return m.reply(`📌 Usage: *.yts2* [search query]\n\n${cfg2.footer}`);
      await m.react('⏳');
      try {
        const yts  = require('yt-search');
        const res  = await yts(q);
        const vids = res?.videos?.slice(0, 5);
        if (!vids?.length) throw new Error('No results');

        let text = `🔍 *YouTube Search Results*\n\n`;
        vids.forEach((v, i) => {
          text += `*${i+1}.* ${v.title}\n📺 ${v.author.name}  ⏱️ ${v.timestamp}\n🔗 ${v.url}\n\n`;
        });
        text += cfg2.footer;

        return sendButtons2(sock, chat, {
          text,
          footer: cfg2.footer,
          buttons: [
            { label: '⬇️ Download #1', id: `.song2 ${vids[0].url}` },
            { label: '📋 Menu',        id: '.menu' },
          ],
          quoted: msg,
        });
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Search failed: ${e.message}\n\n${cfg2.footer}`);
      }
    }
  },
};

// Register unity extra commands so messageHandler can find them
if (typeof module._unityExtraRegistered === 'undefined') {
  module._unityExtraRegistered = true;
  const _origExports = module.exports;
  // Merge commands
  _origExports.commands = [...(_origExports.commands || []), ..._unityExtra.commands];
  const _origRun = _origExports.run?.bind(_origExports);
  _origExports.run = async function (ctx) {
    if (_unityExtra.commands.includes(ctx.m?.command)) {
      return _unityExtra.run(ctx);
    }
    return _origRun?.(ctx);
  };
}
