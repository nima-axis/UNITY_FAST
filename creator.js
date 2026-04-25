'use strict';
const cfg = require('../../config');
const db = require('./index');
const logger = require('./logger');

module.exports = {
  commands: [
    'globalbc', 'globalmaintenance', 'globalunmaintenance',
    'globalban', 'globalunban',
    'topusers', 'activeusers', 'newusers',
    'kill', 'restart',
    'dbstats', 'sysinfo',
  ],

  access: 'creator',
  description: 'Creator only commands — Channel 3 only',

  async run({ sock, m, db: database }) {
    const cmd  = m.command;
    const text = m.text?.trim();
    const args = m.args;

    const getTarget = () => {
      const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (mentions.length) return mentions[0];
      if (m.quoted?.sender) return m.quoted.sender;
      if (args[0]) return args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      return null;
    };

    // ── Global broadcast (all paired users YOU chat) ───────────
    if (cmd === 'globalbc') {
      if (!text) return m.reply(
        `📌 *Usage:* .globalbc [message]\n\n` +
        `Sends to all paired users' personal chat.\n\n` +
        `${cfg.footer}`
      );

      await m.reply(`📢 *Broadcasting to all users...*`);

      const pairedUsers = await db.User.find({ isPaired: true }).lean();
      let sent = 0, failed = 0;

      for (const user of pairedUsers) {
        try {
          await sock.sendMessage(user.jid, {
            text:
              `📢 *UNITY-MD Announcement*\n\n` +
              `${text}\n\n` +
              `${cfg.footer}`,
          });
          sent++;
          await new Promise(r => setTimeout(r, 500));
        } catch (e) { failed++; }
      }

      return m.reply(
        `✅ *Global Broadcast Done!*\n\n` +
        `📤 Sent: ${sent}\n` +
        `❌ Failed: ${failed}\n` +
        `👥 Total: ${pairedUsers.length}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Global maintenance ON ─────────────────────────────────
    if (cmd === 'globalmaintenance') {
      const botCfg = await db.getBotConfig();
      botCfg.maintenance = true;
      await botCfg.save();

      // Notify all paired users
      const pairedUsers = await db.User.find({ isPaired: true }).lean();
      for (const user of pairedUsers) {
        try {
          await sock.sendMessage(user.jid, {
            text:
              `🔧 *UNITY-MD Maintenance*\n\n` +
              `Bot is under maintenance.\n` +
              `We'll be back shortly! ⏳\n\n` +
              `${cfg.footer}`,
          });
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {}
      }

      return m.reply(`🔧 *Maintenance Mode ON*\n\nAll users notified.\n\n${cfg.footer}`);
    }

    // ── Global maintenance OFF ────────────────────────────────
    if (cmd === 'globalunmaintenance') {
      const botCfg = await db.getBotConfig();
      botCfg.maintenance = false;
      await botCfg.save();

      const pairedUsers = await db.User.find({ isPaired: true }).lean();
      for (const user of pairedUsers) {
        try {
          await sock.sendMessage(user.jid, {
            text:
              `✅ *UNITY-MD is Back!*\n\n` +
              `Maintenance complete.\n` +
              `Bot is fully operational! 🚀\n\n` +
              `${cfg.footer}`,
          });
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {}
      }

      return m.reply(`✅ *Maintenance Mode OFF*\n\nAll users notified.\n\n${cfg.footer}`);
    }

    // ── Global ban ────────────────────────────────────────────
    if (cmd === 'globalban') {
      const target = getTarget();
      if (!target) return m.reply(`📌 Usage: .globalban @user\n\n${cfg.footer}`);
      await db.User.updateOne(
        { jid: target },
        { $set: { isBanned: true, isPaired: false } },
        { upsert: true }
      );
      logger.warn(`[CREATOR] Global ban: ${target}`);
      return m.reply(
        `🚫 *Global Banned!*\n\n` +
        `👤 +${target.replace('@s.whatsapp.net', '')}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Global unban ──────────────────────────────────────────
    if (cmd === 'globalunban') {
      const target = getTarget();
      if (!target) return m.reply(`📌 Usage: .globalunban @user\n\n${cfg.footer}`);
      await db.User.updateOne(
        { jid: target },
        { $set: { isBanned: false } }
      );
      return m.reply(
        `✅ *Global Unbanned!*\n\n` +
        `👤 +${target.replace('@s.whatsapp.net', '')}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Top users ─────────────────────────────────────────────
    if (cmd === 'topusers') {
      const users = await db.User
        .find({ totalCommands: { $gt: 0 } })
        .sort({ totalCommands: -1 })
        .limit(10)
        .lean();

      if (!users.length) return m.reply(`📊 No data yet.\n\n${cfg.footer}`);

      const list = users.map((u, i) => {
        const num = u.jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        const paired = u.isPaired ? '🔗' : '👤';
        return `${i + 1}. ${paired} +${num} — ${u.totalCommands} cmds`;
      }).join('\n');

      return m.reply(
        `📊 *Top 10 Users*\n\n${list}\n\n${cfg.footer}`
      );
    }

    // ── Active users (last 24h) ───────────────────────────────
    if (cmd === 'activeusers') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const count = await db.User.countDocuments({
        lastCommand: { $gte: since },
      });
      const paired = await db.User.countDocuments({ isPaired: true });
      const total  = await db.User.countDocuments();

      return m.reply(
        `📊 *User Stats*\n\n` +
        `⚡ Active (24h): ${count}\n` +
        `🔗 Paired: ${paired}\n` +
        `👥 Total: ${total}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── New users today ───────────────────────────────────────
    if (cmd === 'newusers') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const count = await db.User.countDocuments({
        createdAt: { $gte: today },
      });
      const paired = await db.User.countDocuments({
        createdAt: { $gte: today },
        isPaired: true,
      });

      return m.reply(
        `📊 *New Users Today*\n\n` +
        `👥 Total new: ${count}\n` +
        `🔗 Paired today: ${paired}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── DB stats ──────────────────────────────────────────────
    if (cmd === 'dbstats') {
      const users   = await db.User.countDocuments();
      const paired  = await db.User.countDocuments({ isPaired: true });
      const banned  = await db.User.countDocuments({ isBanned: true });
      const groups  = await db.Group.countDocuments();
      const audits  = await db.Audit?.countDocuments() || 0;

      return m.reply(
        `🗄️ *Database Stats*\n\n` +
        `👥 Users: ${users}\n` +
        `🔗 Paired: ${paired}\n` +
        `🚫 Banned: ${banned}\n` +
        `👥 Groups: ${groups}\n` +
        `📋 Audit logs: ${audits}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Sys info ──────────────────────────────────────────────
    if (cmd === 'sysinfo') {
      const os  = require('os');
      const mem = process.memoryUsage();
      const u   = process.uptime();
      const { plugins } = require('./messageHandler');

      return m.reply(
        `🖥️ *System Info*\n\n` +
        `⏱️ Uptime: ${Math.floor(u/3600)}h ${Math.floor((u%3600)/60)}m\n` +
        `💾 RAM: ${(mem.rss/1024/1024).toFixed(1)} MB\n` +
        `🧠 Heap: ${(mem.heapUsed/1024/1024).toFixed(1)}/${(mem.heapTotal/1024/1024).toFixed(1)} MB\n` +
        `🖥️ OS: ${os.platform()} ${os.arch()}\n` +
        `📦 Node: ${process.version}\n` +
        `🔢 Commands: ${plugins.size}+\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Kill ──────────────────────────────────────────────────
    if (cmd === 'kill') {
      await m.reply(`💀 *UNITY-MD shutting down...*\n\n${cfg.footer}`);
      logger.warn('[CREATOR] Kill command executed');
      process.exit(0);
    }

    // ── Restart ───────────────────────────────────────────────
    if (cmd === 'restart') {
      const fs = require('fs-extra');
      const os = require('os');
      const restartMsg =
        `╔═══════════════════════╗\n` +
        `║   🔄  UNITY-MD  🧩    ║\n` +
        `║  ───────────────────  ║\n` +
        `║  ♻️  RESTARTING BOT ♻️  ║\n` +
        `╚═══════════════════════╝\n\n` +
        `🟡 *Bot is restarting...*\n\n` +
        `┌─────────────────────\n` +
        `│ 💾 *RAM:* ${(process.memoryUsage().rss/1024/1024).toFixed(1)} MB\n` +
        `│ 🖥️ *OS:* ${os.platform()} ${os.arch()}\n` +
        `│ 📅 *Time:* ${new Date().toLocaleString('en-LK', { timeZone: cfg.timezone })}\n` +
        `└─────────────────────\n\n` +
        `⚡ _Back online in a few seconds!_\n\n` +
        `${cfg.footer}`;
      const thumbPath = './src/media/unity_thumb.jpg';
      if (fs.existsSync(thumbPath)) {
        const thumb = await fs.readFile(thumbPath);
        await m.sock.sendMessage(m.jid, { image: thumb, caption: restartMsg }, { quoted: m.msg }).catch(() => {});
      } else {
        await m.reply(restartMsg);
      }
      // ── Send voice note before restarting ──────────────────
      await m.sock.sendMessage(m.jid, {
        audio: { url: 'https://www.image2url.com/r2/default/audio/1776957022770-98aea04d-2005-48b7-8bec-cc060ae20da9.mp3' },
        mimetype: 'audio/mp4',
        ptt: true,
      }).catch(() => {});
      // ── YouTube subscribe button ───────────────────────────
      const { sendUrlButtons } = require('./helper');
      await sendUrlButtons(m.sock, m.jid, {
        text: `🎬 *Subscribe to our YouTube channel!*\n\nStay updated with latest tutorials & updates from *UNITY TEAM* 🧲`,
        footer: cfg.footer,
        buttons: [{ label: '▶️ Subscribe on YouTube', url: 'https://www.youtube.com/@team_astral_yt' }],
      }).catch(() => {});
      logger.warn('[CREATOR] Restart command executed');
      setTimeout(() => process.exit(1), 1500);
    }
  },
};
