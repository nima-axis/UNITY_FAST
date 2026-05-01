'use strict';
/**
 * UNITY-MD — Telegram Notification Helper
 * Sends push notifications to a fixed owner Telegram chat ID.
 * Uses native `https` — zero extra dependencies, no import cycle.
 *
 * Bot token : TG_PAIR_BOT_TOKEN  (same pair bot)
 * Target ID : OWNER_TG_NOTIFY_ID (default: 7752365037)
 */

const https = require('https');

// Owner's Telegram chat ID — hardcoded fallback, overridable via config.env
const OWNER_TG_ID = process.env.OWNER_TG_NOTIFY_ID || '7752365037';

/**
 * Send an HTML-formatted message to the owner's Telegram chat.
 * Silent fail — never throws, never blocks bot startup.
 *
 * @param {string} html      - HTML text to send
 * @param {string} [chatId]  - override recipient (default: OWNER_TG_ID)
 */
async function tgNotify(html, chatId = OWNER_TG_ID) {
  const token = process.env.TG_PAIR_BOT_TOKEN;
  if (!token || !chatId) return;

  const body = JSON.stringify({
    chat_id:                  chatId,
    text:                     html,
    parse_mode:               'HTML',
    disable_web_page_preview: true,
    disable_notification:     false,
  });

  await new Promise((resolve) => {
    try {
      const urlObj = new URL(`https://api.telegram.org/bot${token}/sendMessage`);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          path:     urlObj.pathname,
          method:   'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => { res.resume(); resolve(); }
      );
      req.on('error', resolve);          // silent fail
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    } catch {
      resolve();
    }
  });
}

module.exports = { tgNotify, OWNER_TG_ID };
