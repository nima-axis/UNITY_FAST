'use strict';
const { getT } = require('../lang');
const cfg = require('../../config');
const db = require('./index');

// Status viewer list store
const statusViewers = new Map(); // jid -> [{ sender, time }]

module.exports = {
  commands: [
    'readsw', 'statuslist', 'upsw',
    'statusreact', 'statusview',
    'bc', 'broadcast',
    'schedule', 'forward',
    'wastatus', 'wstatus',
    'autoapprove',
    // ── New status commands (2026 new methods) ──
    'savestatus', 'dlstatus', 'statusemoji',
    'autostatus', 'autostatusreact',
  ],

  async run({ sock, m }) {
    const tr = await getT(m.sessionOwner);
    const cmd = m.command;
    const text = m.text?.trim();
    const chat = m.chat;

    // ══════════════════════════════════════════════════════════════
    // ── NEW: Auto Status View toggle ─────────────────────────────
    // ══════════════════════════════════════════════════════════════
    if (cmd === 'autostatus') {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg.footer}`);
      const botCfg = await db.getBotConfig(m.sessionOwner);
      botCfg.features = botCfg.features || {};
      const arg = (text || '').toLowerCase();
      if (arg === 'on' || arg === 'off') {
        botCfg.features.autoStatusView = arg === 'on';
        await botCfg.save();
        return m.reply(
          `👁️ *Auto Status View: ${arg === 'on' ? '✅ ON' : '❌ OFF'}*\n\n` +
          `Bot will ${arg === 'on' ? 'now automatically view' : 'no longer view'} contacts\' statuses.\n\n` +
          `${cfg.footer}`
        );
      }
      const cur = botCfg.features.autoStatusView ? '✅ ON' : '❌ OFF';
      return m.reply(
        `👁️ *Auto Status View: ${cur}*\n\n` +
        `📌 Usage:\n` +
        `*.autostatus on* — Enable\n` +
        `*.autostatus off* — Disable\n\n` +
        `${cfg.footer}`
      );
    }

    // ── NEW: Auto Status React toggle ─────────────────────────────
    if (cmd === 'autostatusreact') {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg.footer}`);
      const botCfg = await db.getBotConfig(m.sessionOwner);
      botCfg.features = botCfg.features || {};
      const arg = (text || '').toLowerCase();
      if (arg === 'on' || arg === 'off') {
        botCfg.features.autoStatusReact = arg === 'on';
        await botCfg.save();
        const emoji = botCfg.features.autoStatusReactEmoji || '❤️';
        return m.reply(
          `❤️ *Auto Status React: ${arg === 'on' ? '✅ ON' : '❌ OFF'}*\n\n` +
          `React emoji: *${emoji}*\n` +
          `💡 Change emoji: *.statusemoji [emoji]*\n\n` +
          `${cfg.footer}`
        );
      }
      const cur = botCfg.features.autoStatusReact ? '✅ ON' : '❌ OFF';
      const emoji = botCfg.features.autoStatusReactEmoji || '❤️';
      return m.reply(
        `❤️ *Auto Status React: ${cur}*\n` +
        `React emoji: *${emoji}*\n\n` +
        `📌 Usage:\n` +
        `*.autostatusreact on* — Enable\n` +
        `*.autostatusreact off* — Disable\n` +
        `*.statusemoji [emoji]* — Change emoji\n\n` +
        `${cfg.footer}`
      );
    }

    // ── NEW: Set status react emoji ───────────────────────────────
    if (cmd === 'statusemoji') {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg.footer}`);
      if (!text) return m.reply(
        `💡 Usage: *.statusemoji* [emoji]\n` +
        `Example: *.statusemoji* 🔥\n\n` +
        `${cfg.footer}`
      );
      const botCfg = await db.getBotConfig(m.sessionOwner);
      botCfg.features = botCfg.features || {};
      botCfg.features.autoStatusReactEmoji = text.trim();
      await botCfg.save();
      return m.reply(
        `✅ *Status React Emoji set to: ${text.trim()}*\n\n` +
        `Enable auto react: *.autostatusreact on*\n\n` +
        `${cfg.footer}`
      );
    }

    // ── NEW: Save / Download latest received status ───────────────
    if (cmd === 'savestatus' || cmd === 'dlstatus') {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg.footer}`);

      // First, make sure autoStatusView is enabled so statuses are captured
      const botCfg = await db.getBotConfig(m.sessionOwner);
      const viewEnabled = botCfg.features?.autoStatusView || botCfg.features?.autoRead;
      if (!viewEnabled) {
        return m.reply(
          `⚠️ *Status View not enabled!*\n\n` +
          `Enable first:\n` +
          `*.autostatus on*\n\n` +
          `After enabling, wait for contacts to post statuses. ` +
          `Then use *.savestatus* to download.\n\n` +
          `${cfg.footer}`
        );
      }

      let { getRecentStatuses } = require('./autoHandler');
      const recents = getRecentStatuses(m.sessionOwner);

      // Filter media-only statuses
      const mediaStatuses = recents.filter(s => s.hasMedia);

      if (!mediaStatuses.length) {
        // Show all statuses even if no media
        if (!recents.length) {
          return m.reply(
            `📭 *No statuses received yet.*\n\n` +
            `Make sure *.autostatus on* is enabled and contacts post statuses.\n\n` +
            `${cfg.footer}`
          );
        }
        return m.reply(
          `📋 *Recent statuses (text only):*\n\n` +
          recents.slice(0, 5).map((s, i) => {
            const from = s.key.participant?.split('@')[0] || 'unknown';
            const ago  = Math.round((Date.now() - s.time) / 60000);
            return `${i + 1}. +${from} — ${s.type} — ${ago}m ago`;
          }).join('\n') +
          `\n\n📌 No media statuses in recent list.\n\n${cfg.footer}`
        );
      }

      // Download the latest media status
      const latest = mediaStatuses[0];
      await m.react('⬇️');
      try {
        const from = latest.key.participant?.split('@')[0] || 'unknown';
        const buf  = await sock.downloadMediaMessage(latest.msg);
        if (!buf || !buf.length) throw new Error('Empty buffer');

        const isVideo = latest.type === 'videoMessage';
        const isAudio = latest.type === 'audioMessage';

        if (isVideo) {
          await sock.sendMessage(chat, {
            video:    buf,
            mimetype: 'video/mp4',
            fileName: `status_${from}.mp4`,
            caption:
              `🎬 *Status Video*\n` +
              `👤 From: +${from}\n` +
              `⏰ ${new Date(latest.time).toLocaleString('en-LK')}\n\n` +
              `${cfg.footer}`,
          }, { quoted: m.msg });
        } else if (isAudio) {
          await sock.sendMessage(chat, {
            audio:    buf,
            mimetype: 'audio/mp4',
            ptt:      false,
          }, { quoted: m.msg });
        } else {
          // Image (default)
          const captionText = latest.msg.message?.imageMessage?.caption || '';
          await sock.sendMessage(chat, {
            image:   buf,
            caption:
              `🖼️ *Status Image*\n` +
              `👤 From: +${from}\n` +
              `⏰ ${new Date(latest.time).toLocaleString('en-LK')}\n` +
              (captionText ? `💬 ${captionText}\n` : '') +
              `\n${cfg.footer}`,
          }, { quoted: m.msg });
        }
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(
          `❌ *Failed to download status.*\n` +
          `Error: ${e.message}\n\n` +
          `The status may have expired or media is unavailable.\n\n` +
          `${cfg.footer}`
        );
      }
      return;
    }

    // ── NEW: Manual statusreact (react to a quoted/last status) ───
    if (cmd === 'statusreact') {
      if (!m.isOwner) return m.reply(`❌ Owner only!\n\n${cfg.footer}`);

      let { getRecentStatuses } = require('./autoHandler');
      const recents = getRecentStatuses(m.sessionOwner);
      if (!recents.length) {
        return m.reply(
          `📭 *No statuses in memory.*\n\n` +
          `Enable *.autostatus on* and wait for contacts to post.\n\n` +
          `${cfg.footer}`
        );
      }

      const emoji  = text || '❤️';
      const latest = recents[0];

      // Try react using new Baileys v7 method
      let reacted = false;
      try {
        await sock.sendMessage('status@broadcast', {
          react: { text: emoji, key: latest.key },
        }, { statusJidList: [latest.key.participant || latest.key.remoteJid] });
        reacted = true;
      } catch (_e1) {}

      // Fallback: sendMessage with react to remoteJid
      if (!reacted) {
        try {
          await sock.sendMessage(latest.key.remoteJid, {
            react: { text: emoji, key: latest.key },
          });
          reacted = true;
        } catch (_e2) {}
      }

      const from = latest.key.participant?.split('@')[0] || 'unknown';
      if (reacted) {
        return m.reply(
          `${emoji} *Reacted to status!*\n` +
          `👤 From: +${from}\n\n` +
          `${cfg.footer}`
        );
      }
      return m.reply(`❌ Could not react to status.\n\n${cfg.footer}`);
    }

    // ── Read status ───────────────────────────────────────────
    if (cmd === 'readsw') {
      const list = statusViewers.get('list') || [];
      if (!list.length) {
        return m.reply(
          `👁️ *Status Viewer*\n\n` +
          `No status views recorded yet.\n\n` +
          `${cfg.footer}`
        );
      }
      const text2 = list.slice(0, 20)
        .map((v, i) =>
          `${i + 1}. +${v.sender.replace('@s.whatsapp.net', '')}\n` +
          `   ⏰ ${new Date(v.time).toLocaleTimeString('en-LK')}`
        ).join('\n');
      return m.reply(
        `👁️ *Status Viewers (${list.length})*\n\n` +
        `${text2}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Status list ───────────────────────────────────────────
    if (cmd === 'statuslist') {
      const list = statusViewers.get('list') || [];
      return m.reply(
        `📊 *Status Stats*\n\n` +
        `👁️ Total views: ${list.length}\n` +
        `📅 Today: ${list.filter(v =>
          new Date(v.time).toDateString() === new Date().toDateString()
        ).length}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Post to status ────────────────────────────────────────
    if (cmd === 'upsw') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only2')}\n\n${cfg.footer}`);

      const img = m.quoted?.message?.imageMessage || m.message?.imageMessage;
      const vid = m.quoted?.message?.videoMessage || m.message?.videoMessage;

      if (img) {
        const buf = await sock.downloadMediaMessage(
          img === m.message?.imageMessage
            ? m.msg
            : { message: m.quoted.message, key: m.quoted.key }
        );
        await sock.sendMessage('status@broadcast', {
          image: buf,
          caption: text || '',
        }, { statusJidList: [] });
        return m.reply(`${tr('status_img_posted')}\n\n${cfg.footer}`);
      }

      if (vid) {
        const buf = await sock.downloadMediaMessage(
          vid === m.message?.videoMessage
            ? m.msg
            : { message: m.quoted.message, key: m.quoted.key }
        );
        await sock.sendMessage('status@broadcast', {
          video: buf,
          caption: text || '',
        }, { statusJidList: [] });
        return m.reply(`${tr('status_vid_posted')}\n\n${cfg.footer}`);
      }

      if (text) {
        await sock.sendMessage('status@broadcast', { text });
        return m.reply(`✅ *Text posted to status!*\n\n${cfg.footer}`);
      }

      return m.reply(
        `📌 Usage: *.upsw* [text] or send/reply media\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Broadcast ─────────────────────────────────────────────
    if (cmd === 'bc' || cmd === 'broadcast') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only2')}\n\n${cfg.footer}`);
      if (!text) return m.reply(
        `📌 Usage: *.bc* [message]\n\n${cfg.footer}`
      );

      await m.reply(`📢 *Broadcasting...*`);
      const groups = await sock.groupFetchAllParticipating();
      let sent = 0, failed = 0;

      for (const [jid] of Object.entries(groups)) {
        try {
          await sock.sendMessage(jid, {
            text:
              `📢 *Broadcast*\n\n` +
              `${text}\n\n` +
              `${cfg.footer}`
          });
          sent++;
        } catch (e) {
          failed++;
        }
        await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 2000)));
      }

      return m.reply(
        `✅ *Broadcast complete!*\n\n` +
        `📤 Sent: ${sent}\n` +
        `❌ Failed: ${failed}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Schedule message ──────────────────────────────────────
    if (cmd === 'schedule') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only2')}\n\n${cfg.footer}`);
      if (!text) return m.reply(
        `📌 Usage: *.schedule* [minutes] | [message]\n` +
        `Example: *.schedule* 30 | Hello everyone!\n\n` +
        `${cfg.footer}`
      );

      const parts = text.split('|');
      if (parts.length < 2) return m.reply(
        `📌 Format: *.schedule* [minutes] | [message]\n\n${cfg.footer}`
      );

      const mins = parseInt(parts[0].trim());
      const msg = parts.slice(1).join('|').trim();

      if (isNaN(mins) || mins < 1) return m.reply(
        `❌ Invalid time. Use minutes (e.g. 30)\n\n${cfg.footer}`
      );

      setTimeout(async () => {
        await sock.sendMessage(chat, {
          text: `⏰ *Scheduled Message*\n\n${msg}\n\n${cfg.footer}`
        });
      }, mins * 60 * 1000);

      return m.reply(
        `✅ *Message scheduled!*\n\n` +
        `⏰ Will send in: ${mins} minute(s)\n` +
        `💬 Message: ${msg.slice(0, 50)}${msg.length > 50 ? '...' : ''}\n\n` +
        `${cfg.footer}`
      );
    }

    // ── Forward ───────────────────────────────────────────────
    if (cmd === 'forward') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only2')}\n\n${cfg.footer}`);
      if (!m.quoted) return m.reply(
        `📌 Reply a message with *.forward* [group JID or all]\n\n${cfg.footer}`
      );

      const target = text?.trim();
      if (!target) return m.reply(
        `📌 Usage: *.forward* [JID or "all"]\n\n${cfg.footer}`
      );

      if (target === 'all') {
        const groups = await sock.groupFetchAllParticipating();
        let sent = 0;
        for (const [jid] of Object.entries(groups)) {
          await sock.sendMessage(jid, {
            forward: { key: m.quoted.key, message: m.quoted.message }
          }).catch(() => {});
          sent++;
          await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
        }
        return m.reply(`✅ *Forwarded to ${sent} groups!*\n\n${cfg.footer}`);
      }

      await sock.sendMessage(target, {
        forward: { key: m.quoted.key, message: m.quoted.message }
      });
      return m.reply(`✅ *Forwarded!*\n\n${cfg.footer}`);
    }

    // ── WA Status Video Downloader ────────────────────────────
    if (cmd === 'wastatus' || cmd === 'wstatus') {
      const yts = require('yt-search');
      const categories = {
        islam:      ['islamic whatsapp status short','quran status video 30 sec','islamic reminder status','allah status video short','naat status video'],
        sad:        ['sad whatsapp status','sad song status 30 sec','broken heart status','emotional sad status','sad shayari status'],
        song:       ['hindi song whatsapp status','punjabi song status 30 sec','bollywood status video','romantic song status','new song status'],
        motivation: ['motivation whatsapp status','motivational quotes status','success motivation status short','gym motivation status','never give up status'],
        love:       ['love whatsapp status','romantic status video 30 sec','couple status video','love song status'],
        funny:      ['funny whatsapp status','comedy status video short','funny video status','memes status video'],
        attitude:   ['attitude whatsapp status','attitude status video','boy attitude status','girl attitude status'],
        friendship: ['friendship whatsapp status','friends status video','dosti status','best friend status'],
        nature:     ['nature whatsapp status','beautiful nature status','rain status video','sunset status video'],
      };
      const catEmojis = { islam:'🕌', sad:'😢', song:'🎵', motivation:'💪', love:'❤️', funny:'😂', attitude:'😎', friendship:'👬', nature:'🌿' };

      if (!text) {
        const catList = Object.keys(categories).map((c, i) => `${i+1}. *${c.toUpperCase()}*`).join('\n');
        return m.reply(`📱 *WHATSAPP STATUS DOWNLOADER*\n━━━━━━━━━━━━━━━━━━━━━\n\n📂 *Available Categories:*\n\n${catList}\n\n━━━━━━━━━━━━━━━━━━━━━\n📌 Usage: *.wastatus* <category>\n\n${cfg.footer}`);
      }
      const category = text.toLowerCase().trim();
      if (!categories[category]) {
        const catList = Object.keys(categories).map((c,i) => `${i+1}. *${c.toUpperCase()}*`).join('\n');
        return m.reply(`❌ *Invalid Category!*\n\n📂 *Available:*\n${catList}\n\n${cfg.footer}`);
      }
      await m.react('🔍');
      try {
        const queries = categories[category];
        const randomQuery = queries[Math.floor(Math.random() * queries.length)];
        const search = await yts(randomQuery);
        if (!search.videos?.length) return m.reply(`❌ No videos found!\n\n${cfg.footer}`);
        const short = search.videos.filter(v => v.seconds <= 60 && v.seconds >= 5);
        const pool = short.length ? short : search.videos.slice(0, 15);
        const vi = pool[Math.floor(Math.random() * Math.min(10, pool.length))];
        const emoji = catEmojis[category] || '📱';
        await sock.sendMessage(chat, {
          image: { url: vi.thumbnail },
          caption: `${emoji} *WHATSAPP STATUS*\n━━━━━━━━━━━━━━━━━━━━━\n\n🎬 *${vi.title}*\n⏰ *Duration:* ${vi.timestamp}\n👁️ *Views:* ${vi.views}\n📁 *Category:* ${category.toUpperCase()}\n\n⏳ *Downloading...*\n\n${cfg.footer}`,
        }, { quoted: m.msg });
        await m.react('⬇️');
        const res = await require('axios').get(
          `https://api.giftedtech.co.ke/api/download/dlmp4?apikey=gifted&url=${encodeURIComponent(vi.url)}`,
          { timeout: 30000 }
        );
        if (!res.data?.success || !res.data?.result?.download_url) {
          await m.react('❌');
          return m.reply(`❌ Download link fetch failed!\n\n${cfg.footer}`);
        }
        await sock.sendMessage(chat, {
          video: { url: res.data.result.download_url },
          mimetype: 'video/mp4',
          fileName: `${category}_status.mp4`,
          caption: `${emoji} *${category.toUpperCase()} STATUS*\n━━━━━━━━━━━━━━━━━━━━━\n🎬 *${res.data.result.title || vi.title}*\n📊 *Quality:* ${res.data.result.quality || '480p'}\n✅ *Done!*\n\n${cfg.footer}`,
        }, { quoted: m.msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`⚠️ Error: ${e.message}\n\n${cfg.footer}`);
      }
      return;
    }

    // ── Auto Approve Group Join Requests ──────────────────────
    if (cmd === 'autoapprove') {
      if (!m.isGroup) return m.reply(`❌ *Use this in a group!*\n\n${cfg.footer}`);

      global._autoApproveGroups = global._autoApproveGroups || {};
      const action = text?.toLowerCase();

      if (action === 'on') {
        global._autoApproveGroups[chat] = true;
        if (!global._autoApproveInterval) {
          global._autoApproveInterval = setInterval(async () => {
            for (const gid in global._autoApproveGroups) {
              if (!global._autoApproveGroups[gid]) continue;
              try {
                const requests = await sock.groupRequestParticipantsList(gid);
                if (requests?.length > 0) {
                  await sock.groupRequestParticipantsUpdate(gid, requests.map(u => u.jid), 'approve');
                }
              } catch (e) {
                if (e.message?.includes('not-authorized') || e.message?.includes('forbidden')) {
                  delete global._autoApproveGroups[gid];
                }
              }
            }
          }, 5000);
        }
        try {
          const pending = await sock.groupRequestParticipantsList(chat);
          if (pending?.length > 0) {
            await sock.groupRequestParticipantsUpdate(chat, pending.map(u => u.jid), 'approve');
            return m.reply(`✅ *Auto-Approve ENABLED*\n\n🔄 Approved ${pending.length} pending request(s).\n📌 New requests will be auto-approved.\n\n${cfg.footer}`);
          }
        } catch {}
        return m.reply(`✅ *Auto-Approve ENABLED*\n\n📌 New join requests will be auto-approved.\n\n${cfg.footer}`);

      } else if (action === 'off') {
        delete global._autoApproveGroups[chat];
        return m.reply(`❌ *Auto-Approve DISABLED*\n\n📌 Join requests require manual approval.\n\n${cfg.footer}`);

      } else {
        const isOn = !!(global._autoApproveGroups[chat]);
        return m.reply(`⚙️ *Auto-Approve: ${isOn ? '✅ ON' : '❌ OFF'}*\n\n💡 *.autoapprove on* — Enable\n💡 *.autoapprove off* — Disable\n\n${cfg.footer}`);
      }
    }
  },

  // Called from autoHandler when status received
  recordStatusView(senderJid) {
    const list = statusViewers.get('list') || [];
    list.unshift({ sender: senderJid, time: Date.now() });
    statusViewers.set('list', list.slice(0, 100));
  },
};