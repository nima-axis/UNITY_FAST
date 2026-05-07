'use strict';
/**
 * UNITY-MD — .audioplay / .videoplay commands
 * ──────────────────────────────────────────────────────────────
 * .audioplay  — bot connect කරල sender ට voice call එකක් ගෙනවිත්
 *               quoted / attached audio file එක call එකේදී play කරනවා.
 *               Audio ඉවර වූ විට call automatically cut වෙනවා.
 *               Group හෝ inbox — ඕනෑම user කෙනෙකුට.
 *
 * .videoplay  — ඒ වගේමයි, video call හරහා.
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
const { exec } = require('child_process');
const { tmpFile } = require('./helper');

// ── Silent logger ─────────────────────────────────────────────
const silentLogger = {
  info: () => {}, debug: () => {}, trace: () => {},
  error: () => {}, warn: () => {},
};
silentLogger.child = () => silentLogger;

// ── Utility: resolve target JID ──────────────────────────────
// Group: call the person who sent the command (m.sender = individual JID)
// Inbox: call that same person
// Explicit number arg: use that number
function resolveTarget(m) {
  if (m.args[0]) {
    const num = m.args[0].replace(/[^0-9]/g, '');
    if (num.length >= 7) return num + '@s.whatsapp.net';
  }
  // m.sender is always the individual JID regardless of group/inbox
  return m.sender;
}

// ── Utility: download quoted / attached media ─────────────────
async function downloadMedia(m, allowedTypes) {
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');

  // Method 1: m.quoted (project's quoted wrapper)
  const quoted = m.quoted;
  if (quoted) {
    const qMsg = quoted.message;
    for (const type of allowedTypes) {
      if (qMsg?.[type]) {
        try {
          const buf = await downloadMediaMessage(
            { message: qMsg, key: quoted.key },
            'buffer', {}, { logger: silentLogger }
          );
          if (buf) return { buf, type };
        } catch {}
      }
    }
  }

  // Method 2: contextInfo quotedMessage (raw Baileys)
  const ctx = m.msg?.message?.extendedTextMessage?.contextInfo;
  if (ctx?.quotedMessage) {
    const qMsg = ctx.quotedMessage;
    for (const type of allowedTypes) {
      if (qMsg?.[type]) {
        try {
          const buf = await downloadMediaMessage(
            { message: qMsg, key: { remoteJid: m.chat, id: ctx.stanzaId, participant: ctx.participant } },
            'buffer', {}, { logger: silentLogger }
          );
          if (buf) return { buf, type };
        } catch {}
      }
    }
  }

  // Method 3: own message media
  const ownMsg = m.msg?.message || m.message;
  for (const type of allowedTypes) {
    if (ownMsg?.[type]) {
      try {
        const buf = await downloadMediaMessage(
          m.msg, 'buffer', {}, { logger: silentLogger }
        );
        if (buf) return { buf, type };
      } catch {}
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
  } catch {
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

// ── Utility: stream audio into call ──────────────────────────
async function streamAudioToCall(sock, targetJid, callId, audioBuf) {
  if (typeof sock.sendCallAudio === 'function') {
    try {
      await sock.sendCallAudio(callId, targetJid, audioBuf);
      return true;
    } catch {}
  }
  return false;
}

// ── Utility: get audio duration via ffprobe ───────────────────
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

// ── Utility: convert audio to opus ───────────────────────────
async function toOpus(inputPath) {
  const outPath = tmpFile('opus');
  return new Promise((resolve, reject) => {
    exec(
      `ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 64k -ar 48000 -ac 1 "${outPath}"`,
      (err) => { if (err) reject(err); else resolve(outPath); }
    );
  });
}

// ─────────────────────────────────────────────────────────────
// MAIN MODULE
// ─────────────────────────────────────────────────────────────
module.exports = {
  commands: ['audioplay', 'videoplay'],
  // No access restriction — any user in group or inbox can use this
  description: 'Voice / video call eka hadala audio/video play karanna',

  async run({ sock, m }) {
    const cmd     = m.command;
    const isVideo = cmd === 'videoplay';
    const target  = resolveTarget(m);
    const targetNum = target.split('@')[0];

    // ── 1. Download the media file ────────────────────────────
    await m.react('⏳');

    const allowedTypes = isVideo
      ? ['videoMessage', 'documentMessage']
      : ['audioMessage', 'documentMessage', 'videoMessage'];

    const media = await downloadMedia(m, allowedTypes);

    if (!media) {
      await m.react('❌');
      const hint = isVideo
        ? 'video message එකක් reply කරන්න'
        : 'audio/voice message එකක් reply කරන්න';
      return m.reply(
        `📌 *Usage:* *.${cmd}*\n\n` +
        `${hint} *.${cmd}* command ගහන්න.\n\n` +
        `*Example:*\n` +
        `➤ Voice/audio message reply කරල \`.${cmd}\`\n` +
        `➤ Specific number: \`.${cmd} 94XXXXXXXXX\`\n\n` +
        `${cfg.footer}`
      );
    }

    // ── 2. Save media to temp file ────────────────────────────
    const ext = isVideo ? 'mp4' : 'mp3';
    const tempInput = tmpFile(ext);
    await fs.writeFile(tempInput, media.buf);

    try {
      // ── 3. Notify and make call ───────────────────────────
      await m.reply(
        `📞 *${isVideo ? 'Video' : 'Voice'} Call* ගෙනෙනවා...\n\n` +
        `📱 Number: +${targetNum}\n` +
        `🎵 Media ready ✅\n\n` +
        `${cfg.footer}`
      );

      const callId = await makeCall(sock, target, isVideo);

      if (!callId) {
        // Fallback: send as message
        await m.react('⚠️');
        if (isVideo) {
          await sock.sendMessage(target, {
            video: media.buf,
            caption: `🎬 *Video Play*\n\nCall streaming supported නෑ, message හරහා.\n\n${cfg.footer}`,
            gifPlayback: false,
          });
        } else {
          await sock.sendMessage(target, { audio: media.buf, mimetype: 'audio/mp4', ptt: true });
          await sock.sendMessage(m.chat, {
            text: `⚠️ *Call streaming support නෑ*\n\n+${targetNum} ට audio voice note හරහා send කළා.\n\n${cfg.footer}`,
          });
        }
        await fs.remove(tempInput).catch(() => {});
        return;
      }

      // ── 4. Stream audio into call ─────────────────────────
      await m.react('📞');
      await new Promise(r => setTimeout(r, 3000)); // wait for answer

      const duration = await getAudioDuration(tempInput);

      let streamFile = tempInput;
      if (!isVideo) {
        try { streamFile = await toOpus(tempInput); } catch { streamFile = tempInput; }
      }

      const streamBuf = await fs.readFile(streamFile);
      const streamed  = await streamAudioToCall(sock, target, callId, streamBuf);

      // Wait for duration then hang up
      await new Promise(r => setTimeout(r, Math.min(duration * 1000 + 1000, 180000)));
      await endCall(sock, target, callId);

      if (!streamed) {
        // sendCallAudio not available — also send as message
        if (isVideo) {
          await sock.sendMessage(target, {
            video: media.buf,
            caption: `🎬 *Video* — call play supported නෑ, message හරහා.\n\n${cfg.footer}`,
          });
        } else {
          await sock.sendMessage(target, { audio: media.buf, mimetype: 'audio/mp4', ptt: true });
        }
      }

      await m.react('✅');
      await m.reply(
        `✅ *${isVideo ? 'Video' : 'Audio'} Play ඉවරයි!*\n\n` +
        `📞 +${targetNum}\n` +
        `⏱️ Duration: ${Math.round(duration)}s\n\n` +
        `${cfg.footer}`
      );

    } catch (e) {
      await m.react('❌');
      await m.reply(`❌ *Error:* ${e.message}\n\n${cfg.footer}`);
    } finally {
      await fs.remove(tempInput).catch(() => {});
    }
  },
};
