'use strict';
const { t, getLang  } = require('../lang');
const axios = require('axios');
const QRCode = require('qrcode');
const { translate } = require('google-translate-api-x');
const cfg = require('../../config');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { tmpFile, sendButtons } = require('./helper');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');
const { downloadMediaMessage, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const webp = require('node-webpmux');
const crypto = require('crypto');

// ── uploadImage helper ─────────────────────────────────────────
async function uploadImage(buffer) {
  const FileType = require('file-type');
  const FormData = require('form-data');
  const fileType = await FileType.fromBuffer(buffer);
  const { ext, mime } = fileType || { ext: 'png', mime: 'image/png' };
  const tmpDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tempFile = path.join(tmpDir, `upload_${Date.now()}.${ext}`);
  fs.writeFileSync(tempFile, buffer);
  const form = new FormData();
  form.append('files[]', fs.createReadStream(tempFile));
  try {
    const res = await fetch('https://qu.ax/upload.php', { method: 'POST', body: form, headers: form.getHeaders(), timeout: 30000 });
    fs.unlinkSync(tempFile);
    const result = await res.json();
    if (result?.success) return result.files[0].url;
  } catch {}
  try {
    const form2 = new FormData();
    form2.append('file', buffer, { filename: `upload.${ext}`, contentType: mime });
    const res2 = await fetch('https://telegra.ph/upload', { method: 'POST', body: form2, timeout: 30000 });
    const img = await res2.json();
    if (img[0]?.src) return 'https://telegra.ph' + img[0].src;
  } catch {}
  throw new Error('Image upload failed');
}

// ── makeWebpSticker helper ────────────────────────────────────
async function makeWebpSticker(sock, m, square = false) {
  const chat = m.chat;
  const msg = m.msg;
  let targetMessage = msg;
  if (msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
    const qi = msg.message.extendedTextMessage.contextInfo;
    targetMessage = { key: { remoteJid: chat, id: qi.stanzaId, participant: qi.participant }, message: qi.quotedMessage };
  }
  const mediaMessage = targetMessage?.message?.imageMessage || targetMessage?.message?.videoMessage || targetMessage?.message?.documentMessage || targetMessage?.message?.stickerMessage;
  if (!mediaMessage) {
    return sendButtons(sock, chat, {
      text: `📌 *STICKER*\n\nSend or reply to an image/video with *.s*\n\n${cfg.footer}`,
      footer: cfg.footer,
      buttons: [{ label: '📋 Menu', id: '.menu' }],
      quoted: msg,
    });
  }
  await m.react('⏳');
  try {
    const mediaBuffer = await downloadMediaMessage(targetMessage, 'buffer', {}, { logger: undefined, reuploadRequest: sock.updateMediaMessage });
    if (!mediaBuffer) throw new Error('Download failed');
    const tmpDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tempInput = path.join(tmpDir, `stk_in_${Date.now()}`);
    const tempOutput = path.join(tmpDir, `stk_out_${Date.now()}.webp`);
    fs.writeFileSync(tempInput, mediaBuffer);
    const isAnimated = mediaMessage.mimetype?.includes('gif') || mediaMessage.mimetype?.includes('video') || mediaMessage.seconds > 0;
    const scaleFilter = square
      ? 'scale=512:512,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000'
      : 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';
    const ffmpegCmd = isAnimated
      ? `ffmpeg -i "${tempInput}" -vf "${scaleFilter},fps=15" -c:v libwebp -preset default -loop 0 -vsync 0 -pix_fmt yuva420p -quality 75 -compression_level 6 "${tempOutput}"`
      : `ffmpeg -i "${tempInput}" -vf "${scaleFilter}" -c:v libwebp -preset default -loop 0 -vsync 0 -pix_fmt yuva420p -quality 75 -compression_level 6 "${tempOutput}"`;
    await new Promise((resolve, reject) => { exec(ffmpegCmd, (e) => e ? reject(e) : resolve()); });
    const img = new webp.Image();
    await img.load(fs.readFileSync(tempOutput));
    const json = { 'sticker-pack-id': crypto.randomBytes(32).toString('hex'), 'sticker-pack-name': cfg.botName || 'UNITY-MD', 'sticker-pack-publisher': cfg.ownerName || 'UNITY TEAM', 'emojis': ['🤖'] };
    const exifAttr = Buffer.from([0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,0x01,0x00,0x41,0x57,0x07,0x00,0x00,0x00,0x00,0x00,0x16,0x00,0x00,0x00]);
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const exif = Buffer.concat([exifAttr, jsonBuffer]);
    exif.writeUIntLE(jsonBuffer.length, 14, 4);
    img.exif = exif;
    const finalBuffer = await img.save(null);
    await sock.sendMessage(chat, { sticker: finalBuffer }, { quoted: msg });
    await m.react('✅');
    try { fs.unlinkSync(tempInput); } catch {}
    try { fs.unlinkSync(tempOutput); } catch {}
  } catch (e) {
    await m.react('❌');
    return m.reply(`❌ Sticker failed: ${e.message}\n\n${cfg.footer}`);
  }
}

module.exports = {
  commands: [
    'tts', 'texttospeech',
    'tr', 'translate',
    'qr', 'toqr', 'qrlink',
    'ping', 'speed',
    'runtime',
    'calc', 'calculate',
    'bmi',
    'age',
    'pass', 'password',
    'ascii',
    'tomp3', 'toaudio', 'tovn', 'tovoice',
    // ── Sticker commands ──
    'sticker', 'stiker', 's',
    'stickerfit', 'crop', 'stickercrop',
    'attp',
    'take',
    // ── Image tools ──
    'removebg', 'rmbg',
    'remini',
    'emojimix',
    // ── View once ──
    'rvo', 'viewonce', 'vv', 'retrive',
    // ── Misc tools ──
    'url', 'shorturl',
    'weather', 'wthr',
    'lyrics', 'lyric',
    'alive',
    'owner',
    // ── New from 5993-95 ──
    'colorize', 'color', 'restore',
    'country', 'countryinfo', 'nation',
    'simdata', 'checknum', 'siminfo', 'numinfo',
    'wacheck', 'wavalidate', 'checkwa', 'wanumber',
    'block', 'unblock',
    'forwardall', 'fwdall', 'fwdgroup', 'fwdg',
    'msg',
    'aivoice', 'vai', 'voicex', 'voiceai',
    'rw', 'randomwall', 'wallpaper',
    'srepo',
    'npm',
    'ytstalk', 'ytinfo',
    'xstalk', 'twitterstalk', 'twtstalk',
    'tiktokstalk', 'tstalk', 'ttstalk',
  ],

  async run({ sock, m }) {
    const lang = await getLang(m.sessionOwner);
    const cmd  = m.command;
    const text = m.text?.trim();
    const chat = m.chat;
    const msg  = m.msg;

    // ── PING ──────────────────────────────────────────────────
    if (cmd === 'ping' || cmd === 'speed') {
      const start = Date.now();
      const sent  = await m.reply(t('tool_pinging',lang), { _noImage: true });
      const ms    = Date.now() - start;
      const pongText = `🏓 *Pong!*\n\n⚡ Speed: *${ms}ms*\n✅ Status: Online\n\n${cfg.footer}`;
      // Guard: edit only works in real WhatsApp — skip if sent.key is undefined
      if (sent?.key) {
        return sock.sendMessage(chat, {
          text: pongText,
          edit: sent.key,
        });
      } else {
        return m.reply(pongText, { _noImage: true });
      }
    }

    // ── RUNTIME ───────────────────────────────────────────────
    if (cmd === 'runtime') {
      const u   = process.uptime();
      const h   = Math.floor(u / 3600);
      const min = Math.floor((u % 3600) / 60);
      const s   = Math.floor(u % 60);
      return sendButtons(sock, chat, {
        text: `⏱️ *Runtime:* ${h}h ${min}m ${s}s\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
    }

    // ── ALIVE ─────────────────────────────────────────────────
    if (cmd === 'alive') {
      const u   = process.uptime();
      const h   = Math.floor(u / 3600);
      const min = Math.floor((u % 3600) / 60);
      const s   = Math.floor(u % 60);
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
        buttons: [{ label: t('btn_menu',lang), id: '.menu' }, { label: t('btn_ping',lang), id: '.ping' }],
        quoted: msg,
      });
    }

    // ── OWNER INFO (public — anyone can use) ──────────────────
    if (cmd === 'owner') {
      const CREATOR_1 = cfg.creatorNumber1 || '94726800969';
      const CREATOR_2 = cfg.creatorNumber2 || '94789525799';
      const botNum    = (sock?.user?.id || '').split('@')[0].split(':')[0];
      return sendButtons(sock, chat, {
        text:
          `👑 *UNITY-MD Owner Info*\n\n` +
          `🛠️ *Creator 1:*\n` +
          `📞 wa.me/${CREATOR_1}\n\n` +
          `🛠️ *Creator 2:*\n` +
          `📞 wa.me/${CREATOR_2}\n\n` +
          `🤖 *Bot Number:*\n` +
          `📞 wa.me/${botNum}\n\n` +
          `${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: t('btn_menu', lang), id: '.menu' }],
        quoted: msg,
      });
    }

    // ── TTS ───────────────────────────────────────────────────
    if (cmd === 'tts' || cmd === 'texttospeech') {
      if (!text) return sendButtons(sock, chat, {
        text: `📌 Usage: *.tts* [text]\nLanguage: *.tts* [si] text\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
      await m.react('⏳');
      try {
        const langMatch = text.match(/^\[([a-z]{2})\]\s*/);
        const lang      = langMatch?.[1] || 'en';
        const cleanText = text.replace(/^\[[a-z]{2}\]\s*/, '');
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=${lang}&client=tw-ob`;
        const buf = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => Buffer.from(r.data));
        await m.react('✅');
        return sock.sendMessage(chat, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ TTS failed: ${e.message}\n\n${cfg.footer}`);
      }
    }

    // ── TRANSLATE ─────────────────────────────────────────────
    if (cmd === 'tr' || cmd === 'translate') {
      if (!text) return sendButtons(sock, chat, {
        text: `📌 Usage: *.tr* [lang] [text]\nExample: *.tr* si Hello World\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
      await m.react('⏳');
      try {
        const parts = text.split(' ');
        const toLang = parts[0].length <= 3 ? parts.shift() : 'en';
        const toTranslate = parts.join(' ') || m.quoted?.body;
        if (!toTranslate) return m.reply(`📌 Provide text!\n\n${cfg.footer}`);
        const result = await translate(toTranslate, { to: toLang });
        await m.react('✅');
        return sendButtons(sock, chat, {
          text: `🌐 *Translation*\n\n📝 From: ${result.from.language.iso}\n🌍 To: ${toLang}\n\n${result.text}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Failed: ${e.message}\n\n${cfg.footer}`);
      }
    }

    // ── QR ────────────────────────────────────────────────────
    if (cmd === 'qr' || cmd === 'toqr') {
      if (!text) return m.reply(`📌 Usage: *.qr* [text or URL]\n\n${cfg.footer}`);
      await m.react('⏳');
      try {
        const buf = await QRCode.toBuffer(text, { errorCorrectionLevel: 'H', width: 512 });
        await m.react('✅');
        return sock.sendMessage(chat, { image: buf, caption: `📱 *QR Code*\n\n📝 ${text.slice(0, 50)}\n\n${cfg.footer}` }, { quoted: msg });
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ QR failed: ${e.message}\n\n${cfg.footer}`);
      }
    }

    // ── QRLINK ────────────────────────────────────────────────
    if (cmd === 'qrlink') {
      if (!text) return m.reply(`📌 Usage: *.qrlink* [link or text]\nGenerates a QR code and gives you a direct image link.\n\n${cfg.footer}`);
      await m.react('⏳');
      try {
        const buf = await QRCode.toBuffer(text, { errorCorrectionLevel: 'H', width: 512 });
        // Upload QR image and get direct link
        const qrUrl = await uploadImage(buf);
        await sock.sendMessage(chat, {
          image: buf,
          caption: `📱 *QR Code*\n\n📝 *Content:* ${text.slice(0, 80)}\n\n🔗 *Direct QR Link:*\n${qrUrl}\n\n${cfg.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ QR Link failed: ${e.message}\n\n${cfg.footer}`);
      }
      return;
    }

    // ── STICKER ───────────────────────────────────────────────
    if (['sticker', 'stiker', 's'].includes(cmd)) return makeWebpSticker(sock, m, false);
    if (['stickerfit', 'crop', 'stickercrop'].includes(cmd)) return makeWebpSticker(sock, m, true);

    // ── ATTP ──────────────────────────────────────────────────
    if (cmd === 'attp') {
      if (!text) return sendButtons(sock, chat, {
        text: `📌 Usage: *.attp* [text]\nExample: *.attp* Hello World\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
      await m.react('⏳');
      try {
        const tmpDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        // ── Method 1: Single-step direct animated WebP (no MP4 intermediate) ──
        const fontPath = process.platform === 'win32'
          ? 'C:/Windows/Fonts/arialbd.ttf'
          : (() => {
              const candidates = [
                '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf',        // Alpine (ttf-dejavu pkg)
                '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',   // Ubuntu/Debian
                '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
                '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
                '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
                '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
              ];
              return candidates.find(p => fs.existsSync(p)) || null;  // null = use built-in
            })();

        const safeText = text
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/,/g, '\\,')
          .replace(/'/g, "\\'")
          .replace(/\[/g, '\\[')
          .replace(/\]/g, '\\]')
          .replace(/%/g, '\\%');

        // fontfile only if font exists — otherwise ffmpeg uses built-in font
        const safeFontPath = (fontPath && process.platform === 'win32')
          ? fontPath.replace(/\\/g, '/').replace(':', '\\:')
          : fontPath;
        const fontPart = safeFontPath ? `fontfile='${safeFontPath}':` : '';

        const cycle = 0.3;
        const dur   = 1.8;
        const base  = `${fontPart}text='${safeText}':borderw=2:bordercolor=black@0.6:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2`;
        const drawRed   = `drawtext=${base}:fontcolor=red:enable='lt(mod(t\\,${cycle})\\,0.1)'`;
        const drawBlue  = `drawtext=${base}:fontcolor=blue:enable='between(mod(t\\,${cycle})\\,0.1\\,0.2)'`;
        const drawGreen = `drawtext=${base}:fontcolor=green:enable='gte(mod(t\\,${cycle})\\,0.2)'`;

        const webpOutput = path.join(tmpDir, `attp_${Date.now()}.webp`);
        let directOk = false;
        try {
          await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', [
              '-y',
              '-f', 'lavfi',
              '-i', `color=c=black:s=512x512:d=${dur}:r=20`,
              '-vf', `${drawRed},${drawBlue},${drawGreen}`,
              '-c:v', 'libwebp',
              '-preset', 'default',
              '-loop', '0',
              '-vsync', '0',
              '-pix_fmt', 'yuv420p',
              '-quality', '80',
              '-compression_level', '6',
              '-t', String(dur),
              webpOutput,
            ]);
            const errs = [];
            ff.stderr.on('data', e => errs.push(e));
            ff.on('error', reject);
            ff.on('close', code => {
              if (code === 0) resolve();
              else reject(new Error(Buffer.concat(errs).toString() || `ffmpeg failed: ${code}`));
            });
          });

          // Send raw WebP directly — skip EXIF injection (prevents animated WebP corruption)
          const rawWebp = fs.readFileSync(webpOutput);
          await sock.sendMessage(chat, { sticker: rawWebp }, { quoted: msg });
          await m.react('✅');
          directOk = true;
        } catch (directErr) {
          console.error('[ATTP] Direct WebP method failed:', directErr.message);
        } finally {
          try { fs.unlinkSync(webpOutput); } catch {}
        }

        if (directOk) return;

        // ── Method 2: External API fallback chain ──
        const fetchFn = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
        const encoded = encodeURIComponent(text);
        const atttpApis = [
          { url: `https://api.xteam.xyz/attp?text=${encoded}`,              type: 'buffer' },
          { url: `https://api.siputzx.my.id/api/s/attp?text=${encoded}`,    type: 'buffer' },
          { url: `https://api.akuari.my.id/sticker/attp?text=${encoded}`,   type: 'buffer' },
          { url: `https://bk9.fun/sticker/attp?text=${encoded}`,            type: 'buffer' },
          { url: `https://api.agatz.xyz/api/attp?text=${encoded}`,          type: 'buffer' },
          { url: `https://api.itzpire.site/attp?text=${encoded}`,           type: 'buffer' },
          { url: `https://api.princeapi.my.id/api/attp?text=${encoded}`,    type: 'buffer' },
          { url: `https://api.nyxs.pw/sticker/attp?text=${encoded}`,        type: 'buffer' },
          { url: `https://api.rankify.one/api/sticker/attp?text=${encoded}`,type: 'buffer' },
          { url: `https://api.ndevapi.com/sticker/attp?text=${encoded}`,    type: 'buffer' },
          { url: `https://api.bochilgaming.xyz/api/attp?text=${encoded}`,   type: 'json', key: 'url' },
          { url: `https://api.meongapi.my.id/attp?text=${encoded}`,         type: 'json', key: 'result' },
        ];
        for (const api of atttpApis) {
          try {
            const r = await (await fetchFn)(api.url, { timeout: 15000 });
            if (!r.ok) continue;
            let buf;
            if (api.type === 'json') {
              const j = await r.json();
              const dlUrl = j?.[api.key] || j?.data?.[api.key];
              if (!dlUrl) continue;
              const r2 = await (await fetchFn)(dlUrl, { timeout: 15000 });
              if (!r2.ok) continue;
              buf = Buffer.from(await r2.arrayBuffer());
            } else {
              buf = Buffer.from(await r.arrayBuffer());
            }
            if (buf.length < 500) continue;
            await sock.sendMessage(chat, { sticker: buf }, { quoted: msg });
            await m.react('✅');
            return;
          } catch { continue; }
        }
        throw new Error('All attp methods failed');
      } catch (e) {
        await m.react('❌');
        return m.reply(`${tr('media_attp_fail')}\n\n${cfg.footer}`);
      }
      return;
    }

    // ── TAKE ──────────────────────────────────────────────────
    if (cmd === 'take') {
      const quotedMessage = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quotedMessage?.stickerMessage) return sendButtons(sock, chat, {
        text: `📌 *TAKE STICKER*\n\nReply to a sticker with *.take* [packname]\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
      const packname = text || cfg.botName || 'UNITY-MD';
      await m.react('⏳');
      try {
        const stickerBuffer = await downloadMediaMessage(
          { key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMessage, messageType: 'stickerMessage' },
          'buffer', {}, { logger: console, reuploadRequest: sock.updateMediaMessage }
        );
        if (!stickerBuffer) throw new Error('Download failed');
        const img3 = new webp.Image();
        await img3.load(stickerBuffer);
        const json3 = { 'sticker-pack-id': crypto.randomBytes(32).toString('hex'), 'sticker-pack-name': packname, 'sticker-pack-publisher': cfg.ownerName || 'UNITY TEAM', 'emojis': ['🤖'] };
        const ea3 = Buffer.from([0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,0x01,0x00,0x41,0x57,0x07,0x00,0x00,0x00,0x00,0x00,0x16,0x00,0x00,0x00]);
        const jb3 = Buffer.from(JSON.stringify(json3), 'utf8');
        const ex3 = Buffer.concat([ea3, jb3]);
        ex3.writeUIntLE(jb3.length, 14, 4);
        img3.exif = ex3;
        await sock.sendMessage(chat, { sticker: await img3.save(null) }, { quoted: msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`${tr('media_take_fail')}\n\n${cfg.footer}`);
      }
      return;
    }

    // ── EMOJIMIX ──────────────────────────────────────────────
    if (cmd === 'emojimix') {
      if (!text || !text.includes('+')) return sendButtons(sock, chat, {
        text: `📌 Usage: *.emojimix* 😎+🥰\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '📋 Menu', id: '.menu' }],
        quoted: msg,
      });
      const [e1, e2] = text.split('+').map(e => e.trim());
      await m.react('⏳');
      try {
        const url = `https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(e1)}_${encodeURIComponent(e2)}`;
        const res = await fetch(url, { timeout: 15000 });
        const data = await res.json();
        if (!data.results?.length) { await m.react('❌'); return m.reply(`❌ Cannot mix these emojis!\n\n${cfg.footer}`); }
        const imageUrl = data.results[0].url;
        const tmpDir2 = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tmpDir2)) fs.mkdirSync(tmpDir2, { recursive: true });
        const efile = path.join(tmpDir2, `emoji_${Date.now()}.png`);
        const efile2 = path.join(tmpDir2, `emoji_s_${Date.now()}.webp`);
        const imgRes = await fetch(imageUrl, { timeout: 15000 });
        fs.writeFileSync(efile, await imgRes.buffer());
        await new Promise((resolve, reject) => {
          exec(`ffmpeg -i "${efile}" -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" "${efile2}"`, (e) => e ? reject(e) : resolve());
        });
        const imgE = new webp.Image();
        await imgE.load(fs.readFileSync(efile2));
        const jsonE = { 'sticker-pack-id': crypto.randomBytes(32).toString('hex'), 'sticker-pack-name': cfg.botName || 'UNITY-MD', 'emojis': [e1, e2] };
        const eaE = Buffer.from([0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,0x01,0x00,0x41,0x57,0x07,0x00,0x00,0x00,0x00,0x00,0x16,0x00,0x00,0x00]);
        const jbE = Buffer.from(JSON.stringify(jsonE), 'utf8');
        const exE = Buffer.concat([eaE, jbE]);
        exE.writeUIntLE(jbE.length, 14, 4);
        imgE.exif = exE;
        await sock.sendMessage(chat, { sticker: await imgE.save(null) }, { quoted: msg });
        await m.react('✅');
        try { fs.unlinkSync(efile); fs.unlinkSync(efile2); } catch {}
      } catch { await m.react('❌'); return m.reply(`❌ Emojimix failed!\n\n${cfg.footer}`); }
      return;
    }

    // ── REMOVEBG ──────────────────────────────────────────────
    if (cmd === 'removebg' || cmd === 'rmbg') {
      await m.react('⏳');
      try {
        let imageUrl = null;
        const quoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quoted?.imageMessage) {
          const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          imageUrl = await uploadImage(Buffer.concat(chunks));
        } else if (msg?.message?.imageMessage) {
          const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          imageUrl = await uploadImage(Buffer.concat(chunks));
        }
        if (!imageUrl) { await m.react('❌'); return sendButtons(sock, chat, { text: `📌 Send or reply to an image with *.removebg*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg }); }
        const apiRes = await axios.get(`https://api.princetechn.com/api/tools/removebg?apikey=prince_tech_api_azfsbshfb&url=${encodeURIComponent(imageUrl)}`, { responseType: 'arraybuffer', timeout: 60000 });
        await sock.sendMessage(chat, { image: Buffer.from(apiRes.data), caption: `✅ *Background Removed!*\n\n${cfg.footer}` }, { quoted: msg });
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ Remove BG failed!\n\n${cfg.footer}`); }
      return;
    }

    // ── REMINI ────────────────────────────────────────────────
    if (cmd === 'remini') {
      await m.react('⏳');
      try {
        let imageUrl = null;
        const quoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quoted?.imageMessage) {
          const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          imageUrl = await uploadImage(Buffer.concat(chunks));
        } else if (msg?.message?.imageMessage) {
          const stream = await downloadContentFromMessage(msg.message.imageImage, 'image');
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          imageUrl = await uploadImage(Buffer.concat(chunks));
        }
        if (!imageUrl) { await m.react('❌'); return sendButtons(sock, chat, { text: `📌 Send or reply to an image with *.remini*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg }); }
        const apiRes = await axios.get(`https://api.princetechn.com/api/tools/remini?apikey=prince_tech_api_azfsbshfb&url=${encodeURIComponent(imageUrl)}`, { responseType: 'arraybuffer', timeout: 60000 });
        await sock.sendMessage(chat, { image: Buffer.from(apiRes.data), caption: `✨ *AI Enhanced!*\n\n${cfg.footer}` }, { quoted: msg });
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ Remini failed!\n\n${cfg.footer}`); }
      return;
    }

    // ── VIEW ONCE ─────────────────────────────────────────────
    if (cmd === 'rvo' || cmd === 'viewonce' || cmd === 'vv' || cmd === 'retrive') {
      const quoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quoted?.imageMessage?.viewOnce) {
        await m.react('⏳');
        const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
        let buf = Buffer.from([]); for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        await sock.sendMessage(chat, { image: buf, caption: quoted.imageMessage.caption || '' }, { quoted: msg });
        return m.react('✅');
      } else if (quoted?.videoMessage?.viewOnce) {
        await m.react('⏳');
        const stream = await downloadContentFromMessage(quoted.videoMessage, 'video');
        let buf = Buffer.from([]); for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        await sock.sendMessage(chat, { video: buf, caption: quoted.videoMessage.caption || '' }, { quoted: msg });
        return m.react('✅');
      }
      return sendButtons(sock, chat, { text: `📌 Reply to a view-once message with *.rvo*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
    }

    // ── URL SHORTENER ─────────────────────────────────────────
    if (cmd === 'url' || cmd === 'shorturl') {
      if (!text || !text.startsWith('http')) return sendButtons(sock, chat, { text: `📌 Usage: *.url* [link]\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
      await m.react('⏳');
      try {
        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text)}`, { timeout: 15000 });
        await m.react('✅');
        return sendButtons(sock, chat, { text: `🔗 *Shortened!*\n\n📎 ${text}\n🔗 ${res.data}\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
      } catch { await m.react('❌'); return m.reply(`${tr('err_failed')}\n\n${cfg.footer}`); }
    }

    // ── WEATHER ───────────────────────────────────────────────
    if (cmd === 'weather' || cmd === 'wthr') {
      if (!text) return sendButtons(sock, chat, { text: `📌 Usage: *.weather* [city]\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
      await m.react('⏳');
      try {
        const apiKey = '4902c0f2550f58298ad4146a92b65e10';
        const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(text)}&appid=${apiKey}&units=metric`, { timeout: 15000 });
        const w = res.data;
        await m.react('✅');
        return sendButtons(sock, chat, {
          text: `🌡️ *Weather in ${w.name}*\n\n🌡️ Temp: ${w.main.temp}°C\n🤔 Feels: ${w.main.feels_like}°C\n💧 Humidity: ${w.main.humidity}%\n💨 Wind: ${w.wind.speed} m/s\n☁️ ${w.weather[0].description}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '🔄 Refresh', id: `.weather ${text}` }],
          quoted: msg,
        });
      } catch { await m.react('❌'); return m.reply(`❌ City not found!\n\n${cfg.footer}`); }
    }

    // ── LYRICS ────────────────────────────────────────────────
    if (cmd === 'lyrics' || cmd === 'lyric') {
      if (!text) return sendButtons(sock, chat, { text: `📌 Usage: *.lyrics* [song name]\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
      await m.react('⏳');
      try {
        const res = await axios.get(`https://some-random-api.com/lyrics?title=${encodeURIComponent(text)}`, { timeout: 15000 });
        const lyr = (res.data.lyrics || '').length > 3000 ? res.data.lyrics.slice(0, 3000) + '...' : res.data.lyrics;
        await m.react('✅');
        return sendButtons(sock, chat, {
          text: `🎵 *${res.data.title || text}*\n🎤 ${res.data.author || ''}\n\n${lyr}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      } catch { await m.react('❌'); return m.reply(`❌ Lyrics not found for *${text}*!\n\n${cfg.footer}`); }
    }

    // ── CALC ──────────────────────────────────────────────────
    if (cmd === 'calc' || cmd === 'calculate') {
      if (!text) return m.reply(`📌 Usage: *.calc* [expression]\n\n${cfg.footer}`);
      try {
        const result = Function('"use strict"; return (' + text + ')')();
        return sendButtons(sock, chat, { text: `🔢 *Calculator*\n\n📝 ${text}\n✅ = *${result}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
      } catch { return m.reply(`❌ Invalid expression!\n\n${cfg.footer}`); }
    }

    // ── BMI ───────────────────────────────────────────────────
    if (cmd === 'bmi') {
      if (!text) return m.reply(`📌 Usage: *.bmi* [weight kg] [height cm]\n\n${cfg.footer}`);
      const [w, h] = text.split(/\s+/).map(Number);
      if (!w || !h) return m.reply(`❌ Example: *.bmi* 70 175\n\n${cfg.footer}`);
      const bmi = (w / ((h / 100) ** 2)).toFixed(2);
      const cat = bmi < 18.5 ? '🔵 Underweight' : bmi < 25 ? '🟢 Normal' : bmi < 30 ? '🟡 Overweight' : '🔴 Obese';
      return sendButtons(sock, chat, { text: `⚖️ *BMI*\n\n👤 Weight: ${w}kg\n📏 Height: ${h}cm\n📊 BMI: *${bmi}*\n🏷️ ${cat}\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
    }

    // ── AGE ───────────────────────────────────────────────────
    if (cmd === 'age') {
      if (!text) return m.reply(`📌 Usage: *.age* [DD/MM/YYYY]\n\n${cfg.footer}`);
      const [d, mo, y] = text.split(/[\/\-]/).map(Number);
      const birth = new Date(y, mo - 1, d);
      const years = Math.floor((new Date() - birth) / (365.25 * 24 * 60 * 60 * 1000));
      if (isNaN(years) || years < 0 || years > 150) return m.reply(`${tr('tool_invalid_date')}\n\n${cfg.footer}`);
      return sendButtons(sock, chat, { text: `${t('tool_age_result',lang)} ${years} years old\n📅 Birthday: ${d}/${mo}/${y}\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: msg });
    }

    // ── PASSWORD ──────────────────────────────────────────────
    if (cmd === 'pass' || cmd === 'password') {
      const len = Math.min(parseInt(text) || 12, 32);
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
      let pass = '';
      for (let i = 0; i < len; i++) pass += chars[Math.floor(Math.random() * chars.length)];
      return sendButtons(sock, chat, { text: `🔑 *Password*\n\n\`${pass}\`\n\n📊 Length: ${len}\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '🔄 Generate New', id: `.pass ${len}` }], quoted: msg });
    }

    // ── ASCII ─────────────────────────────────────────────────
    if (cmd === 'ascii') {
      if (!text) return m.reply(`📌 Usage: *.ascii* [text]\n\n${cfg.footer}`);
      try {
        const r = await axios.get(`https://artii.herokuapp.com/make?text=${encodeURIComponent(text)}&font=standard`, { timeout: 10000 });
        return m.reply(`\`\`\`${r.data}\`\`\`\n\n${cfg.footer}`);
      } catch { return m.reply(`📝 *${text.toUpperCase()}*\n\n${cfg.footer}`); }
    }

    // ── TOMP3/TOVOICE ─────────────────────────────────────────
    if (['tomp3', 'toaudio', 'tovn', 'tovoice'].includes(cmd)) {
      const quotedMsg = m.quoted?.message;
      const ownMsg    = m.message;
      const audio =
        quotedMsg?.audioMessage || quotedMsg?.videoMessage ||
        ownMsg?.audioMessage   || ownMsg?.videoMessage;
      if (!audio) return m.reply(`📌 Video/audio reply කරලා *.tomp3* දෙන්න\n\n${cfg.footer}`);
      await m.react('⏳');
      try {
        const targetMsg = (ownMsg?.audioMessage || ownMsg?.videoMessage)
          ? m.msg
          : { message: quotedMsg, key: m.quoted.key };
        const buf = await sock.downloadMediaMessage(targetMsg);
        await m.react('✅');
        const isPtt = ['tovn', 'tovoice'].includes(cmd);
        return sock.sendMessage(chat, {
          audio:    buf,
          mimetype: isPtt ? 'audio/ogg; codecs=opus' : 'audio/mp4',
          ptt:      isPtt,
        }, { quoted: msg });
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Failed: ${e.message}\n\n${cfg.footer}`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // NEW COMMANDS FROM 5993-95 BOT
    // ═══════════════════════════════════════════════════════════

    // ── COLORIZE ─────────────────────────────────────────────
    if (cmd === 'colorize' || cmd === 'color' || cmd === 'restore') {
      const imgMsg = m.quoted?.message?.imageMessage || m.message?.imageMessage;
      let imageUrl = text;
      if (imgMsg) {
        try {
          const buf = await sock.downloadMediaMessage(
            imgMsg === m.message?.imageMessage ? m.msg : { message: m.quoted.message, key: m.quoted.key }
          );
          imageUrl = await uploadImage(buf);
        } catch {}
      }
      if (!imageUrl) return m.reply(`🎨 Usage: *.colorize* <image_url> or send/reply an image\n\n${cfg.footer}`);
      await m.react('⏳');
      try {
        const res = await axios.get(
          `https://api.mrfrankofc.gleeze.com/api/tools/colorize?url=${encodeURIComponent(imageUrl)}`,
          { responseType: 'arraybuffer', timeout: 30000 }
        );
        await sock.sendMessage(chat, { image: Buffer.from(res.data), caption: `🖼️ *Colorized Image*\n\n${cfg.footer}` }, { quoted: msg });
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ Colorize failed!\n\n${cfg.footer}`); }
      return;
    }

    // ── COUNTRY INFO ─────────────────────────────────────────
    if (cmd === 'country' || cmd === 'countryinfo' || cmd === 'nation') {
      if (!text) return m.reply(`🌍 Usage: *.country* [name]\nExample: *.country Sri Lanka*\n\n${cfg.footer}`);
      await m.react('🌍');
      try {
        const res = await axios.get(
          `https://api.mrfrankofc.gleeze.com/api/tools/countryInfo?name=${encodeURIComponent(text)}`,
          { timeout: 15000 }
        );
        if (!res.data?.status || !res.data?.data) return m.reply(`❌ No info found for "${text}"\n\n${cfg.footer}`);
        const c = res.data.data;
        const caption =
          `🌍 *${c.name}*\n━━━━━━━━━━━━━━━━━━━━━\n` +
          `🏛️ *Capital:* ${c.capital}\n` +
          `📍 *Continent:* ${c.continent?.name} ${c.continent?.emoji || ''}\n` +
          `📞 *Phone Code:* ${c.phoneCode}\n` +
          `💰 *Currency:* ${c.currency}\n` +
          `🗺️ *Area:* ${c.area?.squareKilometers?.toLocaleString()} km²\n` +
          `🌐 *TLD:* ${c.internetTLD}\n` +
          `🦎 *Famous For:* ${c.famousFor}\n` +
          `🌎 *Languages:* ${(c.languages?.native || []).join(', ')}\n` +
          `🗺️ *Maps:* ${c.googleMapsLink}\n\n${cfg.footer}`;
        await sock.sendMessage(chat, { image: { url: c.flag }, caption }, { quoted: msg });
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ Failed to get country info!\n\n${cfg.footer}`); }
      return;
    }

    // ── SIMDATA ──────────────────────────────────────────────
    if (['simdata', 'checknum', 'siminfo', 'numinfo'].includes(cmd)) {
      if (!text) return m.reply(`📱 Usage: *.simdata* [phone number]\nExample: *.simdata 03427582213*\n\n${cfg.footer}`);
      await m.react('⏳');
      try {
        let number = text.replace(/[^0-9]/g, '');
        if (number.startsWith('92')) number = '0' + number.substring(2);
        if (!number.startsWith('0') || number.length !== 11)
          return m.reply(`❌ Invalid Pakistani number format.\nUse: 03xxxxxxxxx\n\n${cfg.footer}`);
        const res = await axios.get(`https://fam-official.serv00.net/api/database.php?number=${number}`, { timeout: 30000 });
        if (!res.data?.success || !res.data?.data?.length)
          return m.reply(`❌ No data found for this number.\n\n${cfg.footer}`);
        let msg2 = `📱 *SIM DATA*\n\n📞 *Number:* ${number}\n\n`;
        res.data.data.forEach((e, i) => {
          msg2 += `━━━ *Result ${i+1}* ━━━\n`;
          if (e.name?.trim())    msg2 += `👤 *Name:* ${e.name}\n`;
          if (e.cnic?.trim())    msg2 += `🪪 *CNIC:* ${e.cnic}\n`;
          if (e.address?.trim()) msg2 += `📍 *Address:* ${e.address}\n`;
          msg2 += '\n';
        });
        await m.reply(msg2 + cfg.footer);
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ SIM data lookup failed!\n\n${cfg.footer}`); }
      return;
    }

    // ── WA CHECK ─────────────────────────────────────────────
    if (['wacheck', 'wavalidate', 'checkwa', 'wanumber'].includes(cmd)) {
      if (!text) return m.reply(`📱 Usage: *.wacheck* [number]\nExample: *.wacheck 94771234567*\n\n${cfg.footer}`);
      await m.react('🔍');
      try {
        const phoneNumber = text.replace(/[+\s\-()\u200B]/g, '');
        const [result] = await sock.onWhatsApp(phoneNumber + '@s.whatsapp.net').catch(() => []);
        const hasWA = result?.exists || false;
        await m.reply(
          `📱 *WhatsApp Check*\n━━━━━━━━━━━━━━━━━━━━━\n` +
          `🔢 *Number:* +${phoneNumber}\n` +
          `${hasWA ? '✅ *Status:* WhatsApp Account Exists' : '❌ *Status:* No WhatsApp Account'}\n` +
          `${hasWA ? `📋 *JID:* ${result.jid}` : ''}\n\n${cfg.footer}`
        );
        await m.react(hasWA ? '✅' : '❌');
      } catch { await m.react('❌'); return m.reply(`${tr('tool_check_fail')}\n\n${cfg.footer}`); }
      return;
    }

    // ── BLOCK / UNBLOCK ──────────────────────────────────────
    if (cmd === 'block' || cmd === 'unblock') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only2')}\n\n${cfg.footer}`);
      const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        || msg?.message?.extendedTextMessage?.contextInfo?.participant;
      const targetJid = mentioned
        || (text ? text.replace(/[+\s\-@]/g, '') + '@s.whatsapp.net' : null);
      if (!targetJid) return m.reply(`📌 Reply/mention a user with *.${cmd}*\n\n${cfg.footer}`);
      try {
        await sock.updateBlockStatus(targetJid, cmd === 'block' ? 'block' : 'unblock');
        await m.reply(
          `${cmd === 'block' ? '🚫' : '🔓'} *User ${cmd === 'block' ? 'Blocked' : 'Unblocked'}!*\n` +
          `👤 @${targetJid.split('@')[0]}\n\n${cfg.footer}`
        );
        await m.react(cmd === 'block' ? '🚫' : '✅');
      } catch (e) { return m.reply(`❌ Failed: ${e.message}\n\n${cfg.footer}`); }
      return;
    }

    // ── FORWARDALL / FWDGROUP ────────────────────────────────
    if (['forwardall', 'fwdall', 'fwdgroup', 'fwdg'].includes(cmd)) {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only2')}\n\n${cfg.footer}`);
      if (!m.quoted) return m.reply(`📌 Reply to a message with *.${cmd}*\n\n${cfg.footer}`);
      const isGroupFwd = cmd === 'fwdgroup' || cmd === 'fwdg';
      await m.reply(`📢 *Fetching groups...*`);
      const groups = await sock.groupFetchAllParticipating();
      const jids = Object.keys(groups);
      if (!jids.length) return m.reply(`❌ No groups found!\n\n${cfg.footer}`);
      await m.reply(`📤 *Forwarding to ${jids.length} groups...*`);
      let sent = 0, failed = 0;
      for (const jid of jids) {
        try {
          await sock.sendMessage(jid, { forward: { key: m.quoted.key, message: m.quoted.message } });
          sent++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 2000));
      }
      return m.reply(`✅ *Forward complete!*\n\n📤 Sent: ${sent}\n❌ Failed: ${failed}\n\n${cfg.footer}`);
    }

    // ── MSG REPEAT ───────────────────────────────────────────
    if (cmd === 'msg') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only2')}\n\n${cfg.footer}`);
      if (!text?.includes(',')) return m.reply(`📌 Format: *.msg* text,count\nExample: *.msg* Hello,5\n\n${cfg.footer}`);
      const [message, countStr] = text.split(',');
      const count = parseInt(countStr?.trim());
      if (isNaN(count) || count < 1 || count > 100) return m.reply(`${tr('tool_count_range')}\n\n${cfg.footer}`);
      for (let i = 0; i < count; i++) {
        await sock.sendMessage(chat, { text: message.trim() });
        if (i < count - 1) await new Promise(r => setTimeout(r, 500));
      }
      return;
    }

    // ── AI VOICE ─────────────────────────────────────────────
    if (['aivoice', 'vai', 'voicex', 'voiceai'].includes(cmd)) {
      if (!text) return m.reply(`📌 Usage: *.aivoice* [text]\n\n${cfg.footer}`);
      await m.react('⏳');
      const voiceModels = [
        { n:'1', name:'Hatsune Miku',   model:'miku' },
        { n:'2', name:'Nahida',         model:'nahida' },
        { n:'3', name:'Nami',           model:'nami' },
        { n:'4', name:'Ana (Female)',   model:'ana' },
        { n:'5', name:'Optimus Prime',  model:'optimus_prime' },
        { n:'6', name:'Goku',           model:'goku' },
        { n:'7', name:'Taylor Swift',   model:'taylor_swift' },
        { n:'8', name:'Elon Musk',      model:'elon_musk' },
        { n:'9', name:'Mickey Mouse',   model:'mickey_mouse' },
        { n:'10', name:'Eminem',        model:'eminem' },
      ];
      const menuText = `🎙️ *AI VOICE MODELS*\n━━━━━━━━━━━━━━━━━━━━━\n` +
        voiceModels.map(v => `*${v.n}.* ${v.name}`).join('\n') +
        `\n━━━━━━━━━━━━━━━━━━━━━\n📌 Reply with a number to select voice for:\n"${text}"`;
      const sentMsg = await sock.sendMessage(chat, { text: menuText }, { quoted: msg });
      let active = true;
      const timer = setTimeout(() => { active = false; }, 120000);
      const handler = async (upsert) => {
        if (!active) return;
        const inc = upsert.messages?.[0];
        if (!inc?.message) return;
        const ctx = inc.message?.extendedTextMessage?.contextInfo;
        if (ctx?.stanzaId !== sentMsg.key.id) return;
        if (inc.key.remoteJid !== chat) return;
        clearTimeout(timer); active = false;
        sock.ev.off('messages.upsert', handler);
        const choice = (inc.message.conversation || inc.message.extendedTextMessage?.text || '').trim();
        const vm = voiceModels.find(v => v.n === choice);
        if (!vm) return m.reply(`❌ Invalid option!\n\n${cfg.footer}`);
        await m.react('⬇️');
        try {
          const res = await axios.get(
            `https://api.agatz.xyz/api/voiceover?text=${encodeURIComponent(text)}&model=${vm.model}`,
            { timeout: 30000 }
          );
          if (res.data?.status === 200) {
            await sock.sendMessage(chat, { audio: { url: res.data.data.oss_url }, mimetype: 'audio/mpeg' }, { quoted: inc });
            await m.react('✅');
          } else { m.reply(`❌ Voice generation failed!\n\n${cfg.footer}`); }
        } catch { m.reply(`❌ Error generating voice!\n\n${cfg.footer}`); }
      };
      sock.ev.on('messages.upsert', handler);
      return;
    }

    // ── RANDOM WALLPAPER ─────────────────────────────────────
    if (['rw', 'randomwall', 'wallpaper'].includes(cmd)) {
      const query = text || 'nature';
      await m.react('🌌');
      try {
        const res = await axios.get(
          `https://pikabotzapi.vercel.app/random/randomwall/?apikey=anya-md&query=${encodeURIComponent(query)}`,
          { timeout: 15000 }
        );
        if (res.data?.status && res.data?.imgUrl) {
          await sock.sendMessage(chat, {
            image: { url: res.data.imgUrl },
            caption: `🌌 *Wallpaper: ${query}*\n\n${cfg.footer}`,
          }, { quoted: msg });
          await m.react('✅');
        } else { await m.react('❌'); return m.reply(`❌ No wallpaper found for "${query}"\n\n${cfg.footer}`); }
      } catch { await m.react('❌'); return m.reply(`❌ Wallpaper fetch failed!\n\n${cfg.footer}`); }
      return;
    }

    // ── GITHUB REPO SEARCH ───────────────────────────────────
    if (cmd === 'srepo') {
      if (!text) return m.reply(`📌 Usage: *.srepo* owner/repo\nExample: *.srepo* WhiskeySockets/Baileys\n\n${cfg.footer}`);
      await m.react('🔍');
      try {
        const res = await axios.get(`https://api.github.com/repos/${text}`, { timeout: 15000 });
        const d = res.data;
        return m.reply(
          `📁 *GitHub Repo Info*\n━━━━━━━━━━━━━━━━━━━━━\n` +
          `📌 *Name:* ${d.name}\n` +
          `📝 *Description:* ${d.description || 'N/A'}\n` +
          `⭐ *Stars:* ${d.stargazers_count?.toLocaleString()}\n` +
          `🍴 *Forks:* ${d.forks_count?.toLocaleString()}\n` +
          `👤 *Owner:* ${d.owner?.login}\n` +
          `📅 *Created:* ${new Date(d.created_at).toLocaleDateString()}\n` +
          `🔗 *URL:* ${d.html_url}\n\n${cfg.footer}`
        );
      } catch { await m.react('❌'); return m.reply(`❌ Repo not found: ${text}\n\n${cfg.footer}`); }
    }

    // ── NPM SEARCH ───────────────────────────────────────────
    if (cmd === 'npm') {
      if (!text) return m.reply(`📌 Usage: *.npm* [package-name]\n\n${cfg.footer}`);
      await m.react('📦');
      try {
        const res = await axios.get(`https://registry.npmjs.org/${encodeURIComponent(text)}`, { timeout: 15000 });
        const d = res.data;
        const latest = d['dist-tags']?.latest;
        return m.reply(
          `📦 *NPM Package: ${d.name}*\n━━━━━━━━━━━━━━━━━━━━━\n` +
          `📄 *Description:* ${d.description || 'N/A'}\n` +
          `🏷️ *Latest Version:* ${latest}\n` +
          `🪪 *License:* ${d.license || 'N/A'}\n` +
          `📦 *Downloads:* ${d.repository?.url || 'N/A'}\n` +
          `🔗 *URL:* https://npmjs.com/package/${text}\n\n${cfg.footer}`
        );
      } catch { await m.react('❌'); return m.reply(`❌ Package "${text}" not found!\n\n${cfg.footer}`); }
    }

    // ── YOUTUBE STALK ────────────────────────────────────────
    if (cmd === 'ytstalk' || cmd === 'ytinfo') {
      if (!text) return m.reply(`📌 Usage: *.ytstalk* [channel username/ID]\n\n${cfg.footer}`);
      await m.react('🔍');
      try {
        const res = await axios.get(
          `https://delirius-apiofc.vercel.app/tools/ytstalk?channel=${encodeURIComponent(text)}`,
          { timeout: 15000 }
        );
        if (!res.data?.status || !res.data?.data) return m.reply(`❌ Channel not found!\n\n${cfg.footer}`);
        const yt = res.data.data;
        await sock.sendMessage(chat, {
          image: { url: yt.avatar },
          caption:
            `🎬 *YouTube Channel Info*\n━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *Username:* ${yt.username}\n` +
            `📊 *Subscribers:* ${yt.subscriber_count}\n` +
            `🎥 *Videos:* ${yt.video_count}\n` +
            `🔗 *Channel:* ${yt.channel}\n\n${cfg.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ Failed to fetch channel info!\n\n${cfg.footer}`); }
      return;
    }

    // ── TWITTER/X STALK ──────────────────────────────────────
    if (['xstalk', 'twitterstalk', 'twtstalk'].includes(cmd)) {
      if (!text) return m.reply(`📌 Usage: *.xstalk* [@username]\n\n${cfg.footer}`);
      await m.react('🔍');
      try {
        const username = text.replace('@', '');
        const res = await axios.get(
          `https://delirius-apiofc.vercel.app/tools/xstalk?username=${encodeURIComponent(username)}`,
          { timeout: 15000 }
        );
        if (!res.data?.status || !res.data?.data) return m.reply(`❌ User not found!\n\n${cfg.footer}`);
        const u = res.data.data;
        await sock.sendMessage(chat, {
          image: { url: u.avatar },
          caption:
            `🐦 *Twitter/X Profile*\n━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *Name:* ${u.name}\n` +
            `🔹 *Username:* @${u.username}\n` +
            `✔️ *Verified:* ${u.verified ? '✅' : '❌'}\n` +
            `👥 *Followers:* ${u.followers_count}\n` +
            `👤 *Following:* ${u.following_count}\n` +
            `📝 *Tweets:* ${u.tweets_count}\n` +
            `📅 *Joined:* ${u.created}\n` +
            `🔗 *Profile:* ${u.url}\n\n${cfg.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ Failed to fetch profile!\n\n${cfg.footer}`); }
      return;
    }

    // ── TIKTOK STALK ─────────────────────────────────────────
    if (['tiktokstalk', 'tstalk', 'ttstalk'].includes(cmd)) {
      if (!text) return m.reply(`📌 Usage: *.tiktokstalk* [username]\nExample: *.tiktokstalk mrbeast*\n\n${cfg.footer}`);
      await m.react('📱');
      try {
        const res = await axios.get(
          `https://api.siputzx.my.id/api/stalk/tiktok?username=${encodeURIComponent(text)}`,
          { timeout: 15000 }
        );
        if (!res.data?.status) return m.reply(`❌ User not found!\n\n${cfg.footer}`);
        const user = res.data.data?.user;
        const stats = res.data.data?.stats;
        await sock.sendMessage(chat, {
          image: { url: user.avatarLarger },
          caption:
            `🎭 *TikTok Profile*\n━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *Username:* @${user.uniqueId}\n` +
            `📛 *Nickname:* ${user.nickname}\n` +
            `✅ *Verified:* ${user.verified ? 'Yes ✅' : 'No ❌'}\n` +
            `📍 *Region:* ${user.region}\n` +
            `📝 *Bio:* ${user.signature || 'N/A'}\n` +
            `👥 *Followers:* ${stats.followerCount?.toLocaleString()}\n` +
            `👤 *Following:* ${stats.followingCount?.toLocaleString()}\n` +
            `❤️ *Likes:* ${stats.heartCount?.toLocaleString()}\n` +
            `🎥 *Videos:* ${stats.videoCount?.toLocaleString()}\n` +
            `🔒 *Private:* ${user.privateAccount ? 'Yes' : 'No'}\n` +
            `🔗 https://tiktok.com/@${user.uniqueId}\n\n${cfg.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch { await m.react('❌'); return m.reply(`❌ Failed to fetch TikTok profile!\n\n${cfg.footer}`); }
      return;
    }
  },
};
