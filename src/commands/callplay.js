'use strict';
/**
 * UNITY-MD — .playsong / .playaudio / .playvideo commands
 * ─────────────────────────────────────────────────────────────
 * Owner-only commands. Silently ignored for non-owners.
 *
 * .playsong / .playaudio
 *   Reply to an audio/voice msg  →  sends to sender (or given number)
 *   .playsong 947XXXXXXX         →  sends to that number
 *
 * .playvideo
 *   Reply to a video msg         →  sends to sender (or given number)
 *   .playvideo 947XXXXXXX        →  sends to that number
 *
 * Flow (all via message-edit on the status bubble):
 *   📞 Calling...
 *   → edit → 🎵 Playing audio... / 🎬 Playing video...
 *   → edit → ✅ Done!
 * ─────────────────────────────────────────────────────────────
 */

const cfg         = require('../../config');
const fs          = require('fs-extra');
const { exec }    = require('child_process');
const { tmpFile } = require('./helper');
const { getLang } = require('../lang');

// ── Delay helper ──────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── Localised strings ─────────────────────────────────────────
const STR = {
  owner_only: {
    en: '👑 *Owner only command.*',
    si: '👑 *Owner විතරයි.*',
    ta: '👑 *Owner மட்டும்.*',
  },
  no_media_audio: {
    en: 'Reply to an *audio / voice message* with this command.',
    si: 'Audio / voice message එකක් *reply* කරල command ගහන්න.',
    ta: 'Audio / voice message-ஐ *reply* செய்து command கொடுங்கள்.',
  },
  no_media_video: {
    en: 'Reply to a *video message* with this command.',
    si: 'Video message එකක් *reply* කරල command ගහන්න.',
    ta: 'Video message-ஐ *reply* செய்து command கொடுங்கள்.',
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
  calling: {
    en: '📞 *Calling...*',
    si: '📞 *Call කරනවා...*',
    ta: '📞 *Call செய்கிறது...*',
  },
  playing_audio: {
    en: '🎵 *Playing audio...*',
    si: '🎵 *Audio play කරනවා...*',
    ta: '🎵 *Audio play செய்கிறது...*',
  },
  playing_video: {
    en: '🎬 *Playing video...*',
    si: '🎬 *Video play කරනවා...*',
    ta: '🎬 *Video play செய்கிறது...*',
  },
  done_audio: {
    en: '✅ *Audio play done!*',
    si: '✅ *Audio play ඉවරයි!*',
    ta: '✅ *Audio play முடிந்தது!*',
  },
  done_video: {
    en: '✅ *Video play done!*',
    si: '✅ *Video play ඉවරයි!*',
    ta: '✅ *Video play முடிந்தது!*',
  },
  error: {
    en: '❌ *Failed:*',
    si: '❌ *බැරි වුණා:*',
    ta: '❌ *தோல்வி:*',
  },
  you_are_owner: {
    en: '👑 You are the owner.',
    si: '👑 ඔයා owner.',
    ta: '👑 நீங்கள் owner.',
  },
};

function s(key, lang) {
  return STR[key]?.[lang] || STR[key]?.['en'] || key;
}

// ── Resolve target JID ────────────────────────────────────────
function resolveTarget(m) {
  if (m.args?.[0]) {
    const num = m.args[0].replace(/[^0-9]/g, '');
    if (num.length >= 7) return num + '@s.whatsapp.net';
  }
  return m.sender;
}

// ── Download quoted / own media ───────────────────────────────
async function downloadMedia(sock, m, allowedTypes) {
  const quoted = m.quoted;
  if (quoted) {
    const qMsg = quoted.message;
    for (const type of allowedTypes) {
      if (qMsg?.[type]) {
        const buf = await sock.downloadMediaMessage({ message: qMsg, key: quoted.key });
        return { buf, type };
      }
    }
  }
  for (const type of allowedTypes) {
    if (m.message?.[type]) {
      const buf = await sock.downloadMediaMessage(m.msg);
      return { buf, type };
    }
  }
  return null;
}

// ── ffmpeg: any audio → mp3 ───────────────────────────────────
function toMp3(src) {
  const out = tmpFile('mp3');
  return new Promise((res, rej) =>
    exec(`ffmpeg -y -i "${src}" -vn -ar 44100 -ac 2 -b:a 128k "${out}" 2>/dev/null`,
      (e) => (e ? rej(e) : res(out)))
  );
}

// ── ffmpeg: any video → mp4 ───────────────────────────────────
function toMp4(src) {
  const out = tmpFile('mp4');
  return new Promise((res, rej) =>
    exec(`ffmpeg -y -i "${src}" -c:v libx264 -c:a aac -movflags +faststart "${out}" 2>/dev/null`,
      (e) => (e ? rej(e) : res(out)))
  );
}

// ─────────────────────────────────────────────────────────────
// MODULE
// ─────────────────────────────────────────────────────────────
module.exports = {
  commands: ['playsong', 'playaudio', 'playvideo'],
  description: 'Owner only: call target & play audio/video',

  async run({ sock, m }) {
    const cmd     = m.command;
    const isVideo = cmd === 'playvideo';
    const lang    = await getLang(m.sessionOwner);

    // ── 1. Owner check — silent skip for non-owners ───────────
    if (!m.isOwner) return;

    const target    = resolveTarget(m);
    const targetNum = target.split('@')[0];
    const isSelf    = target === m.sender;

    // ── 2. Media download ─────────────────────────────────────
    const allowedTypes = isVideo
      ? ['videoMessage', 'documentMessage']
      : ['audioMessage', 'documentMessage', 'videoMessage'];

    const media = await downloadMedia(sock, m, allowedTypes);

    if (!media) {
      await m.react('❌');
      const hint = isVideo ? s('no_media_video', lang) : s('no_media_audio', lang);
      return m.reply(
        `📌 *Usage:* *.${cmd}*\n\n` +
        `${hint}\n\n` +
        `*${s('example', lang)}:*\n` +
        `➤ Reply to ${isVideo ? 'video' : 'audio/voice'} msg → \`.${cmd}\`\n` +
        `➤ ${s('diff_number', lang)}: \`.${cmd} 947XXXXXXX\`\n\n` +
        cfg.footer
      );
    }

    // ── 3. Send initial status message: "Calling..." ──────────
    const statusMsg = await sock.sendMessage(m.chat, {
      text:
        `${s('calling', lang)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 *To:* +${targetNum}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        cfg.footer,
    });
    const statusKey = statusMsg?.key;

    // ── Helper: edit the status bubble ────────────────────────
    const editStatus = async (text) => {
      try {
        await sock.sendMessage(m.chat, { text, edit: statusKey });
      } catch {}
    };

    // ── 4. Save raw temp ──────────────────────────────────────
    const rawExt  = isVideo ? 'mp4' : 'mp3';
    const tempRaw = tmpFile(rawExt);
    await fs.writeFile(tempRaw, media.buf);
    let tempConverted = null;

    try {
      // ── 5. Try WhatsApp call (best effort) ────────────────
      let callId = null;
      try {
        if (typeof sock.call === 'function') {
          const res = await Promise.race([
            sock.call([target], { video: isVideo }),
            delay(6000).then(() => null),
          ]);
          callId = res?.id || res?.[0]?.id || null;
        }
      } catch {}

      // ── 6. Edit → "Playing..." ────────────────────────────
      await delay(1500);
      const playingText = isVideo ? s('playing_video', lang) : s('playing_audio', lang);
      await editStatus(
        `${playingText}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 *To:* +${targetNum}\n` +
        (isSelf ? `👑 ${s('you_are_owner', lang)}\n` : '') +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        cfg.footer
      );

      // ── 7. Convert + send media ───────────────────────────
      let sendBuf;
      try {
        if (isVideo) {
          tempConverted = await toMp4(tempRaw);
        } else {
          tempConverted = await toMp3(tempRaw);
        }
        sendBuf = await fs.readFile(tempConverted);
      } catch {
        sendBuf = media.buf;
      }

      if (isVideo) {
        await sock.sendMessage(target, {
          video: sendBuf,
          caption: `🎬 *Video Play* — UNITY-MD\n\n${cfg.footer}`,
          gifPlayback: false,
        });
      } else {
        await sock.sendMessage(target, {
          audio: sendBuf,
          mimetype: 'audio/mpeg',
          ptt: true,
        });
      }

      // ── 8. End call if we got a callId ────────────────────
      if (callId) {
        try {
          if (typeof sock.rejectCall === 'function') {
            await sock.rejectCall(callId, target);
          }
        } catch {}
      }

      // ── 9. Edit → "Done!" ─────────────────────────────────
      await delay(1000);
      const doneText = isVideo ? s('done_video', lang) : s('done_audio', lang);
      await editStatus(
        `${doneText}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 *To:* +${targetNum}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        cfg.footer
      );

      await m.react('✅');

    } catch (e) {
      await m.react('❌');
      await editStatus(
        `${s('error', lang)} ${e.message?.substring(0, 120)}\n\n${cfg.footer}`
      );
    } finally {
      await fs.remove(tempRaw).catch(() => {});
      if (tempConverted) await fs.remove(tempConverted).catch(() => {});
    }
  },
};
