'use strict';
const { getT } = require('../lang');
const cron = require('node-cron');
const cfg = require('../../config');
const logger = require('./logger');

let _sock = null;

// ── Init ──────────────────────────────────────────────────────
function initBoost(sock) {
  _sock = sock;
  startReFollowCron();
  logger.info('[BOOST] Social boost system initialized');
}

// ── Extract JID from WA channel link ─────────────────────────
function extractChannelJID(link) {
  // https://whatsapp.com/channel/xxxxx → JID
  // Already a JID (contains @newsletter) → return as is
  if (link?.includes('@newsletter')) return link;
  const match = link?.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
  if (match) return `${match[1]}@newsletter`;
  return null;
}

// ── Follow channel ────────────────────────────────────────────
async function followChannel(jid) {
  if (!_sock || !jid) return false;
  try {
    await _sock.followNewsletter(jid);
    return true;
  } catch (e) {
    return false;
  }
}

// ── Unfollow detect + re-follow ───────────────────────────────
async function ensureFollowed() {
  if (!_sock) return;
  const channels = [cfg.channel1, cfg.channel2].filter(Boolean);
  for (const ch of channels) {
    try {
      await _sock.followNewsletter(ch);
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── React to latest channel post ──────────────────────────────
async function reactChannel(jid, emoji = '❤️') {
  if (!_sock || !jid) return false;
  try {
    // Correct Baileys 6.7.x signature: newsletterFetchMessages('direct', jid, count)
    const msgs = await _sock.newsletterFetchMessages('direct', jid, 5);
    if (!msgs?.length) return false;
    const latest = msgs[0];
    // Correct newsletter react method
    await _sock.newsletterReactMessage(jid, latest.key.id, emoji);
    return true;
  } catch (e) {
    return false;
  }
}

// ── View channel posts ─────────────────────────────────────────
async function viewChannel(jid) {
  if (!_sock || !jid) return false;
  try {
    // Correct Baileys 6.7.x signature
    const msgs = await _sock.newsletterFetchMessages('direct', jid, 5);
    if (!msgs?.length) return false;
    const keys = msgs.map(m => m.key);
    await _sock.readMessages(keys);
    return true;
  } catch (e) {
    return false;
  }
}

// ── Silent background boost (every command) ───────────────────
let lastBoost = 0;
const BOOST_THROTTLE = 10000; // max once per 10 seconds

async function silentBoost() {
  if (!_sock) return;
  const now = Date.now();
  if (now - lastBoost < BOOST_THROTTLE) return;
  lastBoost = now;

  const channels = [cfg.channel1, cfg.channel2].filter(Boolean);
  for (const ch of channels) {
    followChannel(ch).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Cron: re-follow every 6 hours ─────────────────────────────
function startReFollowCron() {
  cron.schedule('0 */6 * * *', async () => {
    await ensureFollowed();
    logger.info('[BOOST] Re-follow check completed');
  });
}

// ── Manual boost command ──────────────────────────────────────
async function manualBoost(sock, chatJid, targetLink, type = 'boost') {
  const jid = extractChannelJID(targetLink);

  if (!jid) {
    return {
      success: false,
      msg: `❌ Invalid WhatsApp channel link.\n\nFormat: https://whatsapp.com/channel/xxxxx`
    };
  }

  try {
    if (type === 'boost') {
      await followChannel(jid);
      return {
        success: true,
        msg:
          `✅ *Boost activated!*\n\n` +
          `📢 Channel followed successfully\n` +
          `🔗 JID: ${jid}\n\n` +
          `${cfg.footer}`
      };
    }

    if (type === 'react') {
      const emoji = cfg.social?.boostEmoji || '❤️';
      await reactChannel(jid, emoji);
      return {
        success: true,
        msg:
          `✅ *React sent!*\n\n` +
          `${emoji} Reacted to latest post\n` +
          `🔗 Channel: ${jid}\n\n` +
          `${cfg.footer}`
      };
    }

    if (type === 'view') {
      await viewChannel(jid);
      return {
        success: true,
        msg:
          `✅ *Views added!*\n\n` +
          `👁️ Viewed latest posts\n` +
          `🔗 Channel: ${jid}\n\n` +
          `${cfg.footer}`
      };
    }

  } catch (e) {
    return {
      success: false,
      msg: `❌ Boost failed: ${e.message}\n\n${cfg.footer}`
    };
  }
}

// ── Boost commands plugin ─────────────────────────────────────
const boostPlugin = {
  commands: ['boost', 'react', 'view', 'followchannel'],
  ownerOnly: true,

  async run({ sock, m }) {
    const tr = await getT(m.sessionOwner);
    const cmd = m.command;
    const input = m.text?.trim();

    if (!input) {
      return m.reply(
        `📲 *UNITY-MD Boost System*\n\n` +
        `📌 *Commands:*\n\n` +
        `*.boost* [WA channel link]\n` +
        `  → Auto follow channel\n\n` +
        `*.react* [WA channel link]\n` +
        `  → React to latest post\n\n` +
        `*.view* [WA channel link]\n` +
        `  → View latest posts\n\n` +
        `*.followchannel* — Re-follow ch1 & ch2\n\n` +
        `📌 *Example:*\n` +
        `*.boost* https://whatsapp.com/channel/xxx\n\n` +
        `${cfg.footer}`
      );
    }

    // Re-follow configured channels
    if (cmd === 'followchannel') {
      await m.react('⏳');
      await ensureFollowed();
      await m.react('✅');
      return m.reply(
        `✅ *Channels re-followed!*\n\n` +
        `📢 Channel 1: ${cfg.channel1 ? '✅' : '❌ Not configured'}\n` +
        `📢 Channel 2: ${cfg.channel2 ? '✅' : '❌ Not configured'}\n\n` +
        `${cfg.footer}`
      );
    }

    await m.react('⏳');
    const result = await manualBoost(sock, m.chat, input, cmd);
    await m.react(result.success ? '✅' : '❌');
    return m.reply(result.msg);
  },
};

module.exports = {
  initBoost,
  silentBoost,
  ensureFollowed,
  followChannel,
  reactChannel,
  viewChannel,
  extractChannelJID,
  manualBoost,
  boostPlugin,
};