'use strict';
const { getT } = require('../lang');
const axios    = require('axios');
const path     = require('path');
const cfg      = require('../../config');
const { sendButtons } = require('./helper');

// ══════════════════════════════════════════════════════
// UNITY DOWNLOADS EXTRA
// Ported from Lara-3V (rebranded) plugins: dl-download, dl-fb, dl-url, dl-wallpaper
// Adds: twitter, mediafire, instagram, facebook, gdrive, direct-url, apk, wallpaper
// ══════════════════════════════════════════════════════

module.exports = {
  commands: [
    // Twitter
    'twitter', 'twdl', 'tweet',
    // MediaFire
    'mediafire', 'mfire',
    // Instagram
    'ig', 'instagram',
    // Facebook
    'facebook', 'fb',
    // GDrive
    'gdrive', 'gdrive2', 'googledrive',
    // Direct URL
    'downurl', 'down', 'dlurl',
    // APK
    'apk',
    // Wallpaper
    'rw', 'wallpaper', 'wall',
  ],

  async run({ sock, m }) {
    const tr = await getT(m.sessionOwner);
    const cmd  = m.command;
    const chat = m.chat;
    const msg  = m.msg;
    const q    = m.text?.trim();

    // ── TWITTER / TWDL / TWEET ────────────────────────
    if (['twitter', 'twdl', 'tweet'].includes(cmd)) {
      if (!q || !q.startsWith('https://')) {
        return sendButtons(sock, chat, {
          text: `🐦 *Twitter Video Downloader*\n\n*Usage:* .twdl <twitter link>\n\n*Example:* .twdl https://twitter.com/...\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const res  = await axios.get(`https://www.dark-yasiya-api.site/download/twitter?url=${encodeURIComponent(q)}`, { timeout: 30000 });
        const data = res.data;

        if (!data?.status || !data?.result) {
          await m.react('❌');
          return m.reply(`${tr('dl_twitter_fail')}\n\n${cfg.footer}`);
        }

        const { desc, thumb, video_sd, video_hd } = data.result;

        await sock.sendMessage(chat, {
          image: { url: thumb },
          caption: `🐦 *Twitter Downloader*\n\n📝 *${desc || 'Twitter Video'}*\n\n*Reply with:*\n*1* — SD Video\n*2* — HD Video\n*3* — Audio (MP3)\n\n${cfg.footer}`,
        }, { quoted: msg });

        await m.react('✅');

        // Listen for reply selection
        const listener = sock.ev.on('messages.upsert', async (upsert) => {
          const reply = upsert.messages[0];
          if (!reply?.message) return;
          const repText = reply.message?.conversation || reply.message?.extendedTextMessage?.text;
          const replyJid = reply.key.remoteJid;
          if (replyJid !== chat) return;
          if (repText === '1') {
            await sock.sendMessage(chat, { video: { url: video_sd }, caption: `*SD Video*\n\n${cfg.footer}` }, { quoted: reply });
            sock.ev.off('messages.upsert', listener);
          } else if (repText === '2') {
            await sock.sendMessage(chat, { video: { url: video_hd }, caption: `*HD Video*\n\n${cfg.footer}` }, { quoted: reply });
            sock.ev.off('messages.upsert', listener);
          } else if (repText === '3') {
            await sock.sendMessage(chat, { audio: { url: video_sd }, mimetype: 'audio/mpeg' }, { quoted: reply });
            sock.ev.off('messages.upsert', listener);
          }
        });
        setTimeout(() => sock.ev.off('messages.upsert', listener), 120000);
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Twitter download error: ${e.message}\n\n${cfg.footer}`);
      }
    }

    // ── MEDIAFIRE ─────────────────────────────────────
    if (['mediafire', 'mfire'].includes(cmd)) {
      if (!q) {
        return sendButtons(sock, chat, {
          text: `📦 *MediaFire Downloader*\n\n*Usage:* .mediafire <link>\n\n*Example:* .mediafire https://www.mediafire.com/...\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');

      // ── 10+ API fallback chain ─────────────────────────
      const mfApis = [
        // 1. Dark Yasiya
        async () => {
          const r = await axios.get(`https://www.dark-yasiya-api.site/download/mfire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.result || r.data;
          if (!d?.download_url) throw new Error('no download_url');
          return { url: d.download_url, name: d.name, size: d.size, type: d.fileType };
        },
        // 2. Siputzx
        async () => {
          const r = await axios.get(`https://api.siputzx.my.id/api/d/mfire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.data || r.data;
          const url = d?.download_url || d?.dl || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 3. Agatz
        async () => {
          const r = await axios.get(`https://api.agatz.xyz/api/mediafire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.data || r.data;
          const url = d?.download_url || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 4. Paxsenix
        async () => {
          const r = await axios.get(`https://paxsenix.serv00.net/api/mediafire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.result || r.data;
          const url = d?.download_url || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 5. Ndevapi
        async () => {
          const r = await axios.get(`https://ndevapi.com/download/mediafire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.data || r.data;
          const url = d?.download_url || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 6. XTeam
        async () => {
          const r = await axios.get(`https://api.xteam.xyz/mediafire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.result || r.data;
          const url = d?.download_url || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 7. BK9
        async () => {
          const r = await axios.get(`https://bk9.fun/download/mediafire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.BK9 || r.data?.data || r.data;
          const url = d?.download_url || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 8. Akuari
        async () => {
          const r = await axios.get(`https://api.akuari.my.id/downloader/mediafire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.result || r.data?.data || r.data;
          const url = d?.download_url || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 9. Ryzendesu
        async () => {
          const r = await axios.get(`https://api.ryzendesu.vip/api/downloader/mediafire?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const d = r.data?.data || r.data;
          const url = d?.download_url || d?.url;
          if (!url) throw new Error('no url');
          return { url, name: d?.filename || d?.name, size: d?.size };
        },
        // 10. Direct scrape (extract download link from MediaFire page)
        async () => {
          const r = await axios.get(q, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 20000,
          });
          const html = r?.data || '';
          const dlMatch = html.match(/href="(https:\/\/download\d*\.mediafire\.com\/[^"]+)"/);
          if (!dlMatch?.[1]) throw new Error('no direct link found');
          const nameMatch = html.match(/<div class="filename">([^<]+)<\/div>/);
          const sizeMatch = html.match(/<div class="file-size">([^<]+)<\/div>/);
          return {
            url: dlMatch[1],
            name: nameMatch?.[1]?.trim() || 'MediaFire_File',
            size: sizeMatch?.[1]?.trim() || 'Unknown',
          };
        },
      ];

      let mfResult = null;
      for (const [i, fn] of mfApis.entries()) {
        try {
          mfResult = await fn();
          if (mfResult?.url) { console.log(`[MF DL] method ${i + 1} OK`); break; }
        } catch (e) { console.log(`[MF DL] method ${i + 1} failed: ${e.message}`); }
      }

      if (!mfResult?.url) {
        await m.react('❌');
        return m.reply(`${tr('dl_mediafire_fail')}\n\n${cfg.footer}`);
      }

      await m.react('⬆️');
      await sock.sendMessage(chat, {
        document: { url: mfResult.url },
        mimetype: mfResult.type || 'application/octet-stream',
        fileName: mfResult.name || 'MediaFire_File',
        caption: `📦 *MediaFire Download*\n\n📄 *File:* ${mfResult.name || 'Unknown'}\n💾 *Size:* ${mfResult.size || 'Unknown'}\n\n${cfg.footer}`,
      }, { quoted: msg });
      await m.react('✅');
    }

    // ── INSTAGRAM ─────────────────────────────────────
    if (['ig', 'instagram'].includes(cmd)) {
      if (!q || !q.startsWith('https://')) {
        return sendButtons(sock, chat, {
          text: `📸 *Instagram Downloader*\n\n*Usage:* .ig <instagram link>\n\n*Example:* .ig https://www.instagram.com/p/...\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');

      // ── Normalize helpers ──────────────────────────────
      const igExtract = (d) => {
        if (!d) return null;
        // Normalize to array of { url, type }
        const raw = d?.result || d?.data || d?.medias || d;
        const arr = Array.isArray(raw) ? raw : [raw];
        const items = [];
        for (const item of arr) {
          const url = item?.url || item?.video || item?.image || item?.download_url || item?.src;
          if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;
          const isVideo = item?.type === 'video' || item?.media_type === 1 ||
            url.includes('.mp4') || url.includes('video');
          items.push({ url, isVideo });
        }
        return items.length ? items : null;
      };

      // ── 10+ API fallback chain ─────────────────────────
      const igApis = [
        // 1. Dark Yasiya
        async () => {
          const r = await axios.get(`https://www.dark-yasiya-api.site/download/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          if (!r.data?.status || !r.data?.result) throw new Error('no result');
          return igExtract(r.data);
        },
        // 2. Siputzx
        async () => {
          const r = await axios.get(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.data || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 3. Agatz
        async () => {
          const r = await axios.get(`https://api.agatz.xyz/api/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.data || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 4. Paxsenix
        async () => {
          const r = await axios.get(`https://paxsenix.serv00.net/api/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.result || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 5. Ndevapi
        async () => {
          const r = await axios.get(`https://ndevapi.com/download/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.data || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 6. XTeam
        async () => {
          const r = await axios.get(`https://api.xteam.xyz/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.result || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 7. Ryzendesu
        async () => {
          const r = await axios.get(`https://api.ryzendesu.vip/api/downloader/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.data || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 8. BK9
        async () => {
          const r = await axios.get(`https://bk9.fun/download/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.BK9 || r.data?.data || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 9. Akuari
        async () => {
          const r = await axios.get(`https://api.akuari.my.id/downloader/instagram?url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.result || r.data?.data || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 10. Cobalt (video only)
        async () => {
          for (const inst of ['https://api.cobalt.tools', 'https://cobalt.oisd.nl', 'https://cobalt.catvibers.me']) {
            try {
              const r = await axios.post(`${inst}/`, { url: q, downloadMode: 'auto' }, {
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000,
              });
              if (r?.data?.url) return [{ url: r.data.url, isVideo: true }];
            } catch {}
          }
          throw new Error('cobalt: all failed');
        },
        // 11. Lolhuman
        async () => {
          const r = await axios.get(`https://api.lolhuman.xyz/api/instagram?apikey=&url=${encodeURIComponent(q)}`, { timeout: 25000 });
          const items = igExtract(r.data?.result || r.data);
          if (!items) throw new Error('no result');
          return items;
        },
        // 12. SaveInsta scrape
        async () => {
          const r = await axios.post('https://saveinsta.app/api/ajaxSearch', new URLSearchParams({ q }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://saveinsta.app/' },
            timeout: 20000,
          });
          const urls = [...(r?.data?.data || '').matchAll(/href="(https:\/\/[^"]+\.(?:mp4|jpg|jpeg|png)[^"]*)"/g)]
            .map(m => m[1]);
          if (!urls.length) throw new Error('no urls');
          return urls.map(url => ({ url, isVideo: url.includes('.mp4') }));
        },
      ];

      let igMedia = null;
      for (const [i, fn] of igApis.entries()) {
        try {
          igMedia = await fn();
          if (igMedia?.length) { console.log(`[IG DL] method ${i + 1} OK`); break; }
        } catch (e) { console.log(`[IG DL] method ${i + 1} failed: ${e.message}`); }
      }

      if (!igMedia?.length) {
        await m.react('❌');
        return m.reply(`${tr('dl_insta_fail')}\n\n${cfg.footer}`);
      }

      await m.react('⬆️');
      for (const item of igMedia.slice(0, 10)) {
        if (!item?.url) continue;
        if (item.isVideo) {
          await sock.sendMessage(chat, { video: { url: item.url }, caption: `📸 *Instagram*\n\n${cfg.footer}` }, { quoted: msg }).catch(() => {});
        } else {
          await sock.sendMessage(chat, { image: { url: item.url }, caption: `📸 *Instagram*\n\n${cfg.footer}` }, { quoted: msg }).catch(() => {});
        }
      }
      await m.react('✅');
    }

    // ── FACEBOOK ──────────────────────────────────────
    if (['facebook', 'fb'].includes(cmd)) {
      if (!q || !q.startsWith('https://')) {
        return sendButtons(sock, chat, {
          text: `📘 *Facebook Video Downloader*\n\n*Usage:* .fb <facebook link>\n\n*Example:* .fb https://www.facebook.com/...\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      await m.react('⏳');

      const FB_UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

      // ── Step 1: Resolve share/reel links + try direct CDN ──
      let fbUrl = q;

      const tryResolveFb = async (inputUrl) => {
        const mbasicUrl = inputUrl.replace('www.facebook.com', 'mbasic.facebook.com').replace('m.facebook.com', 'mbasic.facebook.com');
        for (const tryUrl of [mbasicUrl, inputUrl]) {
          try {
            const res = await axios.get(tryUrl, {
              maxRedirects: 10, timeout: 12000,
              headers: {
                'User-Agent': FB_UA,
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
              },
              validateStatus: () => true,
            });
            const finalUrl = res?.request?.res?.responseUrl || res?.request?.responseURL || tryUrl;
            if (finalUrl && finalUrl.includes('facebook.com') && finalUrl !== q) {
              fbUrl = finalUrl.split('?')[0];
              console.log('[FB DL] Resolved ->', fbUrl.substring(0, 80));
            }
            const html = typeof res?.data === 'string' ? res.data : '';
            if (!html) continue;
            // mbasic direct video href
            const directVid = html.match(/href="(https:\/\/video\.xx\.fbcdn\.net[^"]+)"/)?.[1]
              || html.match(/href="(https:\/\/[^"]*fbcdn\.net\/v\/[^"]+)"/)?.[1];
            if (directVid) return { directUrl: directVid.replace(/&amp;/g, '&') };
            // og:video / playable_url
            const ogVid = html.match(/property="og:video:secure_url"[^>]*content="([^"]+)"/)?.[1]
              || html.match(/property="og:video"[^>]*content="([^"]+)"/)?.[1]
              || html.match(/"playable_url_quality_hd":"([^"]+)"/)?.[1]
              || html.match(/"playable_url":"([^"]+)"/)?.[1];
            if (ogVid && (ogVid.includes('fbcdn') || ogVid.includes('.mp4'))) {
              return { directUrl: ogVid.replace(/&amp;/g, '&').replace(/\\/g, '') };
            }
          } catch (e) {
            console.log('[FB DL] resolve try failed:', e.message?.substring(0, 50));
          }
        }
        return null;
      };

      const directResult = await tryResolveFb(q);
      if (directResult?.directUrl) {
        console.log('[FB DL] Direct CDN send');
        try {
          await sock.sendMessage(chat, {
            video: { url: directResult.directUrl },
            caption: `📘 *Facebook Video*\n\n${cfg.footer}`,
          }, { quoted: msg });
          return m.react('✅');
        } catch (e) {
          console.log('[FB DL] Direct send failed, trying APIs:', e.message?.substring(0, 50));
        }
      }

      // ── Step 2: Multi-API fallback ─────────────────────────
      const enc = encodeURIComponent(fbUrl);


      const fbApis = [
        // 1. Cobalt (multiple instances, updated 2026 body)
        async () => {
          const instances = ['https://api.cobalt.tools', 'https://cobalt.oisd.nl', 'https://cobalt.catvibers.me', 'https://co.wuk.sh'];
          for (const inst of instances) {
            try {
              const r = await axios.post(`${inst}/`, {
                url: fbUrl, videoQuality: '720', downloadMode: 'auto', filenameStyle: 'pretty',
              }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 15000 });
              const vUrl = r?.data?.url || r?.data?.tunnel;
              if (vUrl) return { sd: vUrl, hd: vUrl, title: 'Facebook Video', thumbnail: null };
            } catch {}
          }
          throw new Error('cobalt: all instances failed');
        },

        // 2. SaveVid
        async () => {
          const r = await axios.post('https://savevid.net/api/ajaxSearch', new URLSearchParams({ q: fbUrl, lang: 'en' }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://savevid.net/', 'User-Agent': FB_UA },
            timeout: 20000,
          });
          const html = r?.data?.data || '';
          const hd = html.match(/href="(https:[^"]+)"[^>]*>[^<]*HD/)?.[1];
          const sd = html.match(/href="(https:[^"]+)"[^>]*>[^<]*SD/)?.[1] || html.match(/href="(https:[^"]+\.mp4[^"]*)"/)?.[1];
          const url = hd || sd;
          if (!url) throw new Error('no url');
          return { sd: url, hd: hd || url, title: 'Facebook Video', thumbnail: null };
        },

        // 3. Snapsave
        async () => {
          const r = await axios.post('https://snapsave.app/action.php', new URLSearchParams({ url: fbUrl }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://snapsave.app/', 'User-Agent': FB_UA, 'Origin': 'https://snapsave.app' },
            timeout: 20000,
          });
          const html = r?.data || '';
          const hd = html.match(/href="(https:\/\/video[^"]+\.mp4[^"]*)"/)?.[1];
          const sd = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)?.[1];
          const url = hd || sd;
          if (!url) throw new Error('no url');
          return { sd: url, hd: hd || url, title: 'Facebook Video', thumbnail: null };
        },

        // 4. Getfvid
        async () => {
          const r = await axios.post('https://www.getfvid.com/downloader', new URLSearchParams({ url: fbUrl }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.getfvid.com/', 'User-Agent': FB_UA },
            timeout: 20000,
          });
          const html = r?.data || '';
          const hd = html.match(/href="(https:\/\/[^"]+)"[^>]*>HD/)?.[1];
          const sd = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)?.[1];
          const url = hd || sd;
          if (!url) throw new Error('no url');
          return { sd: url, hd: hd || url, title: 'Facebook Video', thumbnail: null };
        },

        // 5. Fdown.net
        async () => {
          const r = await axios.post('https://fdown.net/download.php', new URLSearchParams({ URLz: fbUrl }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://fdown.net/', 'User-Agent': FB_UA },
            timeout: 20000,
          });
          const html = r?.data || '';
          const hd = html.match(/id="hdlink"[^>]*href="([^"]+)"/)?.[1];
          const sd = html.match(/id="sdlink"[^>]*href="([^"]+)"/)?.[1] || html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)?.[1];
          const url = hd || sd;
          if (!url) throw new Error('no url');
          return { sd: url, hd: hd || url, title: 'Facebook Video', thumbnail: null };
        },

        // 6. SaveFrom worker
        async () => {
          const r = await axios.get(`https://worker.sf-tools.com/savefrom.php?sf_url=${enc}&lang=en`, {
            headers: { 'User-Agent': FB_UA, 'Referer': 'https://en.savefrom.net/' },
            timeout: 20000,
          });
          const d = r?.data;
          const links = d?.[0]?.url || [];
          const hd = links.find(l => l?.type?.includes('mp4') && parseInt(l?.id) >= 720)?.url;
          const sd = links.find(l => l?.type?.includes('mp4'))?.url;
          const url = hd || sd;
          if (!url) throw new Error('no url');
          return { sd: url, hd: hd || url, title: d?.[0]?.title || 'Facebook Video', thumbnail: d?.[0]?.thumb || null };
        },

        // 7. SnapTik (fb support)
        async () => {
          const r = await axios.post('https://snaptik.app/action2.php', new URLSearchParams({ url: fbUrl, lang: 'en' }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://snaptik.app/', 'User-Agent': FB_UA },
            timeout: 20000,
          });
          const html = r?.data?.data || r?.data || '';
          const url = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)?.[1];
          if (!url) throw new Error('no url');
          return { sd: url, hd: url, title: 'Facebook Video', thumbnail: null };
        },

        // 8. LocoDownloader
        async () => {
          const r = await axios.post('https://locodownloader.com/api/single/autolink', new URLSearchParams({ url: fbUrl }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://locodownloader.com/', 'User-Agent': FB_UA },
            timeout: 20000,
          });
          const links = r?.data?.data?.links || r?.data?.links || [];
          const hd = links.find(l => l.quality === 'HD' || l.label?.includes('HD'))?.url;
          const sd = links.find(l => l.quality === 'SD')?.url || links[0]?.url;
          if (!sd) throw new Error('no url');
          return { sd, hd: hd || sd, title: r?.data?.data?.title || 'Facebook Video', thumbnail: r?.data?.data?.thumbnail || null };
        },
      ];

      const apiNames = ['Cobalt', 'SaveVid', 'Snapsave', 'Getfvid', 'Fdown', 'SaveFrom', 'SnapTik', 'LocoDownloader'];
      let fbData = null;
      let usedApi = 'unknown';

      for (let i = 0; i < fbApis.length; i++) {
        try {
          const result = await fbApis[i]();
          if (result?.sd || result?.hd) {
            fbData = result;
            usedApi = apiNames[i] || `API${i + 1}`;
            console.log(`[FB DL] ✅ ${usedApi}`);
            break;
          }
        } catch (e) {
          console.log(`[FB DL] ❌ ${apiNames[i] || `API${i + 1}`}: ${e.message?.substring(0, 80)}`);
        }
      }

      if (!fbData?.sd && !fbData?.hd) {
        await m.react('❌');
        return m.reply(`❌ Facebook video download failed. Please check the link or try again later.\n\n${cfg.footer}`);
      }

      const { sd, hd, title, thumbnail } = fbData;

      try {
        if (thumbnail) {
          await sock.sendMessage(chat, {
            image: { url: thumbnail },
            caption: `📘 *Facebook Downloader*\n\n📝 *${title || 'Facebook Video'}*\n✅ Found via ${usedApi}\n\n*Reply with:*\n*1.1* — SD Video\n*1.2* — HD Video\n*2.1* — Audio\n*2.2* — Document\n*2.3* — Voice\n\n${cfg.footer}`,
          }, { quoted: msg });
        } else {
          throw new Error('no thumbnail');
        }
      } catch {
        await sock.sendMessage(chat, {
          text: `📘 *Facebook Downloader*\n\n📝 *${title || 'Facebook Video'}*\n✅ Found via ${usedApi}\n\n*Reply with:*\n*1.1* — SD Video\n*1.2* — HD Video\n*2.1* — Audio\n\n${cfg.footer}`,
        }, { quoted: msg });
      }
      await m.react('✅');

      const listener = sock.ev.on('messages.upsert', async (upsert) => {
        const reply = upsert.messages[0];
        if (!reply?.message) return;
        const repText = reply.message?.conversation || reply.message?.extendedTextMessage?.text;
        const replyJid = reply.key.remoteJid;
        if (replyJid !== chat) return;
        if (repText === '1.1') {
          await sock.sendMessage(chat, { video: { url: sd }, caption: `*SD Video*\n\n${cfg.footer}` }, { quoted: reply });
          sock.ev.off('messages.upsert', listener);
        } else if (repText === '1.2') {
          await sock.sendMessage(chat, { video: { url: hd || sd }, caption: `*HD Video*\n\n${cfg.footer}` }, { quoted: reply });
          sock.ev.off('messages.upsert', listener);
        } else if (repText === '2.1') {
          await sock.sendMessage(chat, { audio: { url: sd }, mimetype: 'audio/mpeg' }, { quoted: reply });
          sock.ev.off('messages.upsert', listener);
        } else if (repText === '2.2') {
          await sock.sendMessage(chat, { document: { url: sd }, mimetype: 'video/mp4', fileName: 'FB_Video.mp4', caption: cfg.footer }, { quoted: reply });
          sock.ev.off('messages.upsert', listener);
        } else if (repText === '2.3') {
          try {
            const _ax = require('axios');
            const _ar = await _ax.get(sd, { responseType: 'arraybuffer', timeout: 20000 });
            await sock.sendMessage(chat, { audio: Buffer.from(_ar.data), mimetype: 'audio/mpeg', ptt: true }, { quoted: reply });
          } catch {
            await sock.sendMessage(chat, { audio: { url: sd }, mimetype: 'audio/mpeg', ptt: true }, { quoted: reply });
          }
          sock.ev.off('messages.upsert', listener);
        }
      });
      setTimeout(() => sock.ev.off('messages.upsert', listener), 120000);
    }

    // ── GDRIVE ────────────────────────────────────────
    if (['gdrive', 'gdrive2', 'googledrive'].includes(cmd)) {
      if (!q || !q.startsWith('https://')) {
        return sendButtons(sock, chat, {
          text: `📂 *Google Drive Downloader*\n\n*Usage:* .gdrive <drive link>\n\n*Example:* .gdrive https://drive.google.com/...\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const res  = await axios.get(`https://api.fgmods.xyz/api/downloader/gdrive?url=${encodeURIComponent(q)}&apikey=mnp3grlZ`, { timeout: 30000 });
        const data = res.data;

        if (!data?.result?.download) {
          await m.react('❌');
          return m.reply(`❌ Failed to get GDrive download link. Please check the link.\n\n${cfg.footer}`);
        }

        await m.react('⬆️');
        await sock.sendMessage(chat, {
          document: { url: data.result.download },
          mimetype: data.result.mimeType || 'application/octet-stream',
          fileName: data.result.name || 'GDrive_File',
          caption: `📂 *Google Drive Download*\n\n📄 *${data.result.name || 'File'}*\n\n${cfg.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ GDrive error: ${e.message}\n\n${cfg.footer}`);
      }
    }

    // ── DIRECT URL DOWNLOAD ───────────────────────────
    if (['downurl', 'down', 'dlurl'].includes(cmd)) {
      if (!q) {
        return sendButtons(sock, chat, {
          text: `📁 *Direct URL Downloader*\n\n*Usage:* .down <direct link>\n\n*Example:* .down https://example.com/file.pdf\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }

      const urlMatch = /^(https?:\/\/[^\s]+)/i;
      if (!urlMatch.test(q.trim())) {
        return m.reply(`❌ Invalid URL. Please provide a valid https:// link.\n\n${cfg.footer}`);
      }

      await m.react('⬇️');
      try {
        const headRes    = await axios.head(q.trim(), { timeout: 15000 });
        const headers    = headRes.headers;
        const mimeType   = headers['content-type'] || 'application/octet-stream';
        const dispHeader = headers['content-disposition'] || '';
        let fileName = 'Downloaded_File';

        if (dispHeader.includes('filename=')) {
          fileName = dispHeader.split('filename=')[1].replaceAll('"', '').trim();
        } else {
          fileName = path.basename(new URL(q.trim()).pathname) || 'Downloaded_File';
        }

        await m.react('⬆️');
        await sock.sendMessage(chat, {
          document: { url: q.trim() },
          mimetype: mimeType,
          fileName,
          caption: `📁 *File Downloaded*\n\n📄 ${fileName}\n\n${cfg.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ Download failed!\n\n${e.message || e}\n\n${cfg.footer}`);
      }
    }

    // ── APK DOWNLOADER ────────────────────────────────
    if (cmd === 'apk') {
      if (!q) {
        return sendButtons(sock, chat, {
          text: `📱 *APK Downloader*\n\n*Usage:* .apk <app name>\n\n*Example:* .apk WhatsApp\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⬇️');
      try {
        const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=1`;
        const res    = await axios.get(apiUrl, { timeout: 30000 });
        const data   = res.data;
        const app    = data?.datalist?.list?.[0];

        if (!app) {
          await m.react('❌');
          return m.reply(`❌ App not found on Aptoide.\n\n${cfg.footer}`);
        }

        const sizeMB    = (app.size / 1000000).toFixed(2);
        const dlUrl     = app.file?.path_alt;
        const caption   = `📱 *APK Downloader*\n\n🏷️ *Name:* ${app.name}\n💾 *Size:* ${sizeMB} MB\n📦 *Package:* ${app.package}\n📆 *Updated:* ${app.updated}\n👤 *Developer:* ${app.developer?.name}\n\n${cfg.footer}`;

        await m.react('⬆️');
        await sock.sendMessage(chat, {
          document: { url: dlUrl },
          fileName: app.name,
          mimetype: 'application/vnd.android.package-archive',
          caption,
        }, { quoted: msg });
        await m.react('✅');
      } catch (e) {
        await m.react('❌');
        return m.reply(`❌ APK error: ${e.message}\n\n${cfg.footer}`);
      }
    }

    // ── WALLPAPER ─────────────────────────────────────
    if (['rw', 'wallpaper', 'wall'].includes(cmd)) {
      if (!q) {
        return sendButtons(sock, chat, {
          text: `🖼️ *Wallpaper Download*\n\n*Usage:* .wallpaper <search term>\n\n*Example:* .wallpaper nature\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
      await m.react('⏳');
      try {
        const res  = await axios.get(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(q)}&client_id=WaOiSXvJ3mPFKHjSqCGMHD7bsGGJ9-Nmi5p8gqU3bpg`, { timeout: 20000 });
        const data = res.data;
        const url  = data?.urls?.full || data?.urls?.regular;

        if (!url) {
          await m.react('❌');
          return m.reply(`❌ No wallpaper found for "${q}".\n\n${cfg.footer}`);
        }

        await sock.sendMessage(chat, {
          image: { url },
          caption: `🖼️ *Wallpaper* — ${q}\n\n${cfg.footer}`,
        }, { quoted: msg });
        await m.react('✅');
      } catch {
        // Fallback to Pexels-like free API
        try {
          const res  = await axios.get(`https://api.allorigins.win/get?url=${encodeURIComponent(`https://source.unsplash.com/1920x1080/?${q}`)}`, { timeout: 20000 });
          await sock.sendMessage(chat, {
            image: { url: `https://source.unsplash.com/1920x1080/?${encodeURIComponent(q)}` },
            caption: `🖼️ *Wallpaper* — ${q}\n\n${cfg.footer}`,
          }, { quoted: msg });
          await m.react('✅');
        } catch (e2) {
          await m.react('❌');
          return m.reply(`❌ Wallpaper error: ${e2.message}\n\n${cfg.footer}`);
        }
      }
    }
  },
};
