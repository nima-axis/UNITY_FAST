'use strict';
/**
 * UNITY-MD — .audioplay / .videoplay commands
 * ──────────────────────────────────────────────────────────────
 * .audioplay  — bot connects and makes a voice call to the sender,
 *               playing the quoted / attached audio file during the call.
 *               Call is automatically cut when audio ends.
 *               Works in groups or inbox for any user.
 *
 * .videoplay  — same, but via video call.
 *
 * Usage:
 *   .audioplay              (reply to audio — calls the sender)
 *   .audioplay 94XXXXXXXXX  (calls a specific number)
 *   .videoplay              (reply to video — video calls the sender)
 *   .videoplay 94XXXXXXXXX
 * ──────────────────────────────────────────────────────────────
 */

const cfg  = require('../../config');
const fs   = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { tmpFile } = require('./helper');
const { getLang } = require('../lang');

// ── Localised strings ─────────────────────────────────────────
const STR = {
  usage_audio: {
    en: 'Reply to an audio / voice message with *.audioplay*',
    si: 'Audio / voice message එකක් reply කරල *.audioplay* ගහන්න',
    ta: 'ஒரு audio / voice message-ஐ reply செய்து *.audioplay* கொடுங்கள்',
  },
  usage_video: {
    en: 'Reply to a video message with *.videoplay*',
    si: 'Video message එකක් reply කරල *.videoplay* ගහන්න',
    ta: 'ஒரு video message-ஐ reply செய்து *.videoplay* கொடுங்கள்',
  },
  calling: {
    en: 'Call incoming...',
    si: 'Call ගෙනෙනවා...',
    ta: 'Call வருகிறது...',
  },
  media_ready: {
    en: 'Media ready ✅',
    si: 'Media සූදානමි ✅',
    ta: 'Media தயார் ✅',
  },
  no_call_api_video: {
    en: 'Call streaming not supported — sent video via message.',
    si: 'Call streaming support නෑ — message හරහා video send කළා.',
    ta: 'Call streaming ஆதரிக்கப்படவில்லை — message மூலம் video அனுப்பப்பட்டது.',
  },
  no_call_api_audio: {
    en: 'Call streaming not supported — sent audio as voice note.',
    si: 'Call streaming support නෑ — audio voice note හරහා send කළා.',
    ta: 'Call streaming ஆதரிக்கப்படவில்லை — audio voice note ஆக அனுப்பப்பட்டது.',
  },
  stream_not_supported: {
    en: 'Stream API not supported — file sent as message.',
    si: 'Stream API support නෑ — file message හරහා send කළා.',
    ta: 'Stream API ஆதரிக்கப்படவில்லை — file message ஆக அனுப்பப்பட்டது.',
  },
  call_done: {
    en: 'Call complete!',
    si: 'Call ඉවරයි!',
    ta: 'Call முடிந்தது!',
  },
  play_done: {
    en: 'Play complete!',
    si: 'Play ඉවරයි!',
    ta: 'Play முடிந்தது!',
  },
  video_play_done: {
    en: 'Video Play complete!',
    si: 'Video Play ඉවරයි!',
    ta: 'Video Play முடிந்தது!',
  },
  audio_play_done: {
    en: 'Audio Play complete!',
    si: 'Audio Play ඉවරයි!',
    ta: 'Audio Play முடிந்தது!',
  },
  no_call_fallback_caption: {
    en: '🎬 *Video Play*\n\nCall streaming not supported — sent via message.',
    si: '🎬 *Video Play*\n\nCall streaming support නෑ, message හරහා video send කළා.',
    ta: '🎬 *Video Play*\n\nCall streaming ஆதரிக்கப்படவில்லை, message மூலம் அனுப்பப்பட்டது.',
  },
  stream_fallback_video: {
    en: '🎬 *Video* — stream API not supported, sent as message.',
    si: '🎬 *Video* — stream API support නෑ, message හරහා.',
    ta: '🎬 *Video* — stream API ஆதரிக்கப்படவில்லை, message மூலம்.',
  },
  example: {
    en: 'Example',
    si: 'උදාහරණ',
    ta: 'எடுத்துக்காட்டு',
  },
  diff_number: {
    en: 'Different number',
    si: 'වෙනත් number',
    ta: 'வேறு number',
  },
};

// ── Helper: get localised string ──────────────────────────────
function s(key, lang) {
  const entry = STR[key];
  if (!entry) return key;
  return entry[lang] || entry['en'] || key;
}

// ── Utility: resolve target JID ──────────────────────────────
function resolveTarget(m) {
  if (m.args[0]) {
    const num = m.args[0].replace(/[^0-9]/g, '');
    if (num.length >= 7) return num + '@s.whatsapp.net';
  }
  return m.sender;
}

// ── Utility: download quoted / attached media ─────────────────
async function downloadMedia(sock, m, allowedTypes) {
  const quoted = m.quoted;
  if (quoted) {
    const qMsg = quoted.message;
    for (const type of allowedTypes) {
      if (qMsg?.[type]) {
        const buf = await sock.downloadMediaMessage(
          { message: qMsg, key: quoted.key }
        );
        return { buf, type };
      }
    }
  }
  const ownMsg = m.message;
  for (const type of allowedTypes) {
    if (ownMsg?.[type]) {
      const buf = await sock.downloadMediaMessage(m.msg);
      return { buf, type };
    }
  }
  return null;
}

// ── Utility: make a WhatsApp call (voice or video) ─────────────
async function makeCall(sock, targetJid, isVideo = false) {
  try {
    if (typeof sock.call === 'function') {
      const callResult = await sock.call([targetJid], { video: isVideo });
      return callResult?.id || callResult?.[0]?.id || null;
    }
    const callId = require('crypto').randomBytes(8).toString('hex').toUpperCase();
    await sock.relayMessage(targetJid, {
      call: { callKey: Buffer.from(callId, 'hex') }
    }, {});
    return callId;
  } catch (e) {
    return null;
  }
}

// ── Utility: reject / end a call ─────────────────────────────
async function endCall(sock, targetJid, callId) {
  try {
    if (callId && typeof sock.rejectCall === 'function') {
      await sock.rejectCall(callId, targetJid);
    }
  } catch {}
}

// ── Utility: stream audio buffer into a call via ffmpeg pipe ──
async function streamAudioToCall(sock, targetJid, callId, audioBuf, ext) {
  if (typeof sock.sendCallAudio === 'function') {
    try {
      await sock.sendCallAudio(callId, targetJid, audioBuf);
      return true;
    } catch {}
  }
  return false;
}

// ── Utility: get audio duration in seconds via ffprobe ────────
function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      (err, stdout) => {
        const dur = parseFloat(stdout?.trim());
        resolve(isNaN(dur) ? 30 : dur);
      }
    );
  });
}

// ── Utility: convert any audio to opus (WhatsApp call format) ──
async function toOpus(inputPath) {
  const outPath = tmpFile('opus');
  return new Promise((resolve, reject) => {
    exec(
      `ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 64k -ar 48000 -ac 1 "${outPath}"`,
      (err) => {
        if (err) reject(err);
        else resolve(outPath);
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────
// MAIN MODULE
// ─────────────────────────────────────────────────────────────
module.exports = {
  commands: ['audioplay', 'videoplay'],
  description: 'Make a voice/video call and play audio/video to the recipient',

  async run({ sock, m }) {
    const cmd     = m.command;
    const isVideo = cmd === 'videoplay';
    const target  = resolveTarget(m);
    const targetNum = target.split('@')[0];

    // Get current bot language
    const sessionId = m.sessionId || 'config';
    const lang = await getLang(sessionId);

    // ── 1. Download the media file ────────────────────────────
    await m.react('⏳');

    const allowedTypes = isVideo
      ? ['videoMessage', 'documentMessage']
      : ['audioMessage', 'documentMessage', 'videoMessage'];

    const media = await downloadMedia(sock, m, allowedTypes);

    if (!media) {
      await m.react('❌');
      const hint = isVideo ? s('usage_video', lang) : s('usage_audio', lang);
      return m.reply(
        `📌 *Usage:* *.${cmd}*\n\n` +
        `${hint}\n\n` +
        `*${s('example', lang)}:*\n` +
        `➤ Reply to a voice/audio message with \`.${cmd}\`\n` +
        `➤ ${s('diff_number', lang)}: \`.${cmd} 94XXXXXXXXX\`\n\n` +
        `${cfg.footer}`
      );
    }

    // ── 2. Save media to temp file ────────────────────────────
    const ext = isVideo ? 'mp4' : 'mp3';
    const tempInput = tmpFile(ext);
    await fs.writeFile(tempInput, media.buf);

    try {
      // ── 3. Initiate the call ──────────────────────────────
      await m.reply(
        `📞 *${isVideo ? 'Video' : 'Voice'} Call* — ${s('calling', lang)}\n\n` +
        `📱 Number: +${targetNum}\n` +
        `🎵 ${s('media_ready', lang)}\n\n` +
        `${cfg.footer}`
      );

      const callId = await makeCall(sock, target, isVideo);

      if (!callId) {
        // ── Fallback: native call not supported ─────────────
        await m.react('⚠️');

        if (isVideo) {
          await sock.sendMessage(target, {
            video: media.buf,
            caption: s('no_call_fallback_caption', lang) + `\n\n${cfg.footer}`,
            gifPlayback: false,
          });
        } else {
          await sock.sendMessage(target, {
            audio: media.buf,
            mimetype: 'audio/mp4',
            ptt: true,
          });
          await sock.sendMessage(m.chat, {
            text:
              `⚠️ *Call streaming not supported*\n\n` +
              `${s('no_call_api_audio', lang)}\n` +
              `+${targetNum}\n\n` +
              `${cfg.footer}`,
          });
        }

        await fs.remove(tempInput).catch(() => {});
        return;
      }

      // ── 4. Try to stream audio into the call ──────────────
      await m.react('📞');

      // Wait 3s for recipient to answer
      await new Promise(r => setTimeout(r, 3000));

      const duration = await getAudioDuration(tempInput);

      let streamFile = tempInput;
      if (!isVideo) {
        try {
          streamFile = await toOpus(tempInput);
        } catch { streamFile = tempInput; }
      }

      const streamBuf = await fs.readFile(streamFile);
      const streamed  = await streamAudioToCall(sock, target, callId, streamBuf, ext);

      if (!streamed) {
        await new Promise(r => setTimeout(r, Math.min(duration * 1000, 180000)));
        await endCall(sock, target, callId);

        if (isVideo) {
          await sock.sendMessage(target, {
            video: media.buf,
            caption: s('stream_fallback_video', lang) + `\n\n${cfg.footer}`,
          });
        } else {
          await sock.sendMessage(target, {
            audio: media.buf,
            mimetype: 'audio/mp4',
            ptt: true,
          });
        }

        await m.reply(
          `✅ *${s('call_done', lang)}*\n\n` +
          `📞 +${targetNum}\n` +
          `⏱️ Duration: ${Math.round(duration)}s\n` +
          `⚠️ ${s('stream_not_supported', lang)}\n\n` +
          `${cfg.footer}`
        );
      } else {
        await new Promise(r => setTimeout(r, Math.min(duration * 1000 + 1000, 180000)));
        await endCall(sock, target, callId);

        await m.react('✅');
        await m.reply(
          `✅ *${isVideo ? s('video_play_done', lang) : s('audio_play_done', lang)}*\n\n` +
          `📞 +${targetNum}\n` +
          `⏱️ Duration: ${Math.round(duration)}s\n\n` +
          `${cfg.footer}`
        );
      }

    } catch (e) {
      await m.react('❌');
      await m.reply(`❌ *Error:* ${e.message}\n\n${cfg.footer}`);
    } finally {
      await fs.remove(tempInput).catch(() => {});
    }
  },
};
