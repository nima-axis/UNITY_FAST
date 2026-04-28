'use strict';
/**
 * UNITY-MD — Telegram Pair Bot
 * Follows the exact same flow as jadibot.js (.pair command)
 * Token: TG_PAIR_BOT_TOKEN
 */

const TelegramBot = require('node-telegram-bot-api');
const cfg         = require('../../config');
const db          = require('../commands/index');
const logger      = require('../commands/logger');

let bot = null;

// ── One active pair request per number ───────────────────────
const _inProgress = new Set();

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Poll session for pair code (same as jadibot — 60s) ───────
async function waitForPairCode(sess, timeoutMs = 60000) {
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    if (sess.pairCode)               return { result: 'code',      pairCode: sess.pairCode };
    if (sess.status === 'connected') return { result: 'connected' };
    if (sess.status === 'error')     return { result: 'error' };
    await wait(500);
    elapsed += 500;
  }
  return { result: 'timeout' };
}

// ── Message templates (mirroring jadibot style) ───────────────
const HEADER =
  `▛▀▀▀▀▀▀▀▀▀▀▀▀▀▜\n` +
  `◤◢ 🧲 𝙐𝙉𝙄𝙏𝙔-𝙈𝘿 ◤◢\n` +
  `▙▄▄▄▄▄▄▄▄▄▄▄▄▄▟`;

function msgGenerating(num) {
  return (
    `${HEADER}\n\n` +
    `⏳ *Generating pair code...*\n\n` +
    `📞 Number: *+${num}*\n` +
    `Please wait...\n\n` +
    `${cfg.footer}`
  );
}

function msgReady(num, code) {
  return (
    `${HEADER}\n\n` +
    `✅ *Pairing Code Ready!*\n\n` +
    `📞 Number: *+${num}*\n` +
    `🔑 Code: *${code}*\n\n` +
    `📌 *Steps:*\n` +
    `1. Open WhatsApp\n` +
    `2. Settings → Linked Devices\n` +
    `3. Link a Device\n` +
    `4. Enter code: *${code}*\n\n` +
    `⏱️ Expires in 60 seconds.\n\n` +
    `${cfg.footer}`
  );
}

function msgUsage() {
  return (
    `▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜\n` +
    `◤◢ 🔗 𝙋𝘼𝙄𝙍 𝙔𝙊𝙐𝙍 𝘽𝙊𝙏 ◤◢\n` +
    `▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟\n\n` +
    `📌 *Usage:* /pair [your number]\n` +
    `Example: */pair 94771234567*\n\n` +
    `*Steps:*\n` +
    `1️⃣ Use /pair [number] (include country code)\n` +
    `2️⃣ Get pairing code\n` +
    `3️⃣ WhatsApp → Settings\n` +
    `4️⃣ Linked Devices → Link Device\n` +
    `5️⃣ Enter the code ✅\n\n` +
    `${cfg.footer}`
  );
}

function msgAlreadyConnected(num) {
  return `✅ *+${num} is already connected!*\n\n${cfg.footer}`;
}

function msgTimeout(num) {
  return (
    `❌ *Pair code timeout!*\n` +
    `Please try again: /pair ${num}\n\n` +
    `${cfg.footer}`
  );
}

function msgError(err) {
  return (
    `❌ *Pairing failed!*\n\n` +
    `${err}\n\n` +
    `◉ Check the number (include country code)\n` +
    `◉ The number must have WhatsApp\n` +
    `◉ Try again in 60s\n\n` +
    `${cfg.footer}`
  );
}

function msgInProgress(num) {
  return `⏳ A pairing request for *+${num}* is already in progress. Please wait...`;
}

// ── Start bot ─────────────────────────────────────────────────
function start() {
  const TOKEN = process.env.TG_PAIR_BOT_TOKEN;
  if (!TOKEN) {
    logger.warn('[TG-PAIR] TG_PAIR_BOT_TOKEN not set — pair bot disabled');
    return;
  }

  bot = new TelegramBot(TOKEN, { polling: true });
  bot.on('polling_error', err => logger.error(`[TG-PAIR] Polling error: ${err.message}`));

  // ── /start ────────────────────────────────────────────────
  bot.onText(/^\/start(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, msgUsage(), { parse_mode: 'Markdown' });
  });

  // ── /pair <number> ────────────────────────────────────────
  bot.onText(/^\/pair(?:@\S+)?\s+(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const number = (match[1] || '').replace(/[^0-9]/g, '');

    if (number.length < 7) {
      return bot.sendMessage(chatId, msgUsage(), { parse_mode: 'Markdown' });
    }

    if (_inProgress.has(number)) {
      return bot.sendMessage(chatId, msgInProgress(number), { parse_mode: 'Markdown' });
    }

    // Session manager
    let sm = global.unitySessionManager;
    if (!sm) {
      try { sm = require('../sessionManager'); global.unitySessionManager = sm; } catch (_e) {}
    }
    if (!sm) {
      return bot.sendMessage(chatId,
        `❌ *Session manager not ready. Try again shortly.*\n\n${cfg.footer}`,
        { parse_mode: 'Markdown' }
      );
    }

    // Already connected?
    const existing = sm.getSession(number);
    if (existing?.status === 'connected') {
      return bot.sendMessage(chatId, msgAlreadyConnected(number), { parse_mode: 'Markdown' });
    }

    _inProgress.add(number);

    // Send "Generating..." — will be edited to "Ready!" like jadibot
    const sentMsg = await bot.sendMessage(chatId, msgGenerating(number), { parse_mode: 'Markdown' });

    try {
      const sess    = await sm.startSession(number, () => {});
      const outcome = await waitForPairCode(sess);

      if (outcome.result === 'connected') {
        await bot.editMessageText(msgAlreadyConnected(number), {
          chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown',
        });
        return;
      }

      if (outcome.result === 'code') {
        const code    = outcome.pairCode;
        const userJid = number + '@s.whatsapp.net';

        // Same post-pair actions as jadibot
        await db.setPaired(userJid, true).catch(() => {});
        try {
          const { autoFollowChannels } = require('./autoHandler');
          await autoFollowChannels(userJid);
        } catch (_e) {}

        // Edit "Generating..." → "Pairing Code Ready!" (mirrors jadibot edit)
        await bot.editMessageText(msgReady(number, code), {
          chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown',
        }).catch(() => {});

        // Code alone — easy to copy (mirrors jadibot's final sendMessage)
        await bot.sendMessage(chatId, `\`${code}\``, { parse_mode: 'Markdown' });
        return;
      }

      if (outcome.result === 'timeout') {
        await bot.editMessageText(msgTimeout(number), {
          chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown',
        });
        return;
      }

      // error
      await bot.editMessageText(msgError('Session error'), {
        chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown',
      });

    } catch (e) {
      logger.error(`[TG-PAIR] startSession error for ${number}: ${e.message}`);
      await bot.editMessageText(msgError(e.message), {
        chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown',
      }).catch(() => {});
    } finally {
      _inProgress.delete(number);
    }
  });

  // ── /pair with no argument ────────────────────────────────
  bot.onText(/^\/pair(@\S+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, msgUsage(), { parse_mode: 'Markdown' });
  });

  logger.info('[TG-PAIR] Pair bot started ✅');
}

module.exports = { start };
