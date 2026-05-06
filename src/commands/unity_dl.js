'use strict';
const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const cfg = require('../../config');
const { sendButtons } = require('./helper');
const { getT } = require('../lang');

// ── RapidAPI key ──────────────────────────────────────────────
const RAPID_KEY = '3bde5a3ca1msh6a3c2e0e02d1fdap142e7bjsn8f5a2e0e3c4a';

// ── TikTok Downloader ─────────────────────────────────────────
async function tiktokDownload(url) {
  // ── URL Resolve (short links: vt.tiktok, vm.tiktok) ──────────
  let resolvedUrl = url;
  let videoId = url.match(/\/video\/(\d+)/)?.[1] || null;

  if (!videoId) {
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'TikTok/26.2.0 (iPhone; iOS 17.0; Scale/3.00)',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36',
    ]) {
      try {
        const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': ua } });
        const ru = r.url || '';
        if (ru.includes('/video/')) { resolvedUrl = ru; videoId = ru.match(/\/video\/(\d+)/)?.[1] || null; break; }
      } catch {}
    }
  }

  const _url = resolvedUrl || url;

  const methods = [
    // 1: tikwm (original url)
    { name: 'tikwm-orig', fn: async () => {
      const r = await fetch('https://tikwm.com/api/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, body: new URLSearchParams({ url, count: '12', cursor: '0', web: '1', hd: '1' }), signal: AbortSignal.timeout(25000) });
      const d = (await r.json())?.data; if (!d) throw new Error('no data');
      if (d.images?.length) return { type: 'slideshow', items: d.images, audio: d.music, title: d.title || '', author: d.author?.nickname || '', thumb: d.cover || '' };
      let vNowm = d.hdplay || d.play; if (!vNowm) throw new Error('no url');
      let vWm = d.play || vNowm;
      if (vNowm.startsWith('/')) vNowm = 'https://tikwm.com' + vNowm;
      if (vWm.startsWith('/')) vWm = 'https://tikwm.com' + vWm;
      const audio = d.music || vNowm;
      return { type: 'video', url: vNowm, urlWatermark: vWm, audio: audio.startsWith('/') ? 'https://tikwm.com' + audio : audio, title: d.title || '', author: d.author?.nickname || '', thumb: d.cover || '' };
    }},
    // 2: tikwm (resolved url)
    { name: 'tikwm-resolved', fn: async () => {
      if (_url === url) throw new Error('same, skip');
      const r = await fetch('https://tikwm.com/api/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, body: new URLSearchParams({ url: _url, count: '12', cursor: '0', web: '1', hd: '1' }), signal: AbortSignal.timeout(25000) });
      const d = (await r.json())?.data; if (!d) throw new Error('no data');
      if (d.images?.length) return { type: 'slideshow', items: d.images, audio: d.music, title: d.title || '', author: d.author?.nickname || '', thumb: d.cover || '' };
      let v = d.hdplay || d.play; if (!v) throw new Error('no url');
      if (v.startsWith('/')) v = 'https://tikwm.com' + v;
      const audio = d.music || v;
      return { type: 'video', url: v, audio: audio.startsWith('/') ? 'https://tikwm.com' + audio : audio, title: d.title || '', author: d.author?.nickname || '', thumb: d.cover || '' };
    }},
    // 3: TikTok API v2
    { name: 'tiktok-api-v2', fn: async () => {
      if (!videoId) throw new Error('no id');
      const r = await fetch(`https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&iid=7318518857994389254&device_id=7318517321748022790&channel=googleplay&app_name=musical_ly&version_code=300904&device_platform=android&device_type=Pixel+7`, { headers: { 'User-Agent': 'okhttp/4.9.0' }, signal: AbortSignal.timeout(20000) });
      const data = await r.json(); const v = data?.aweme_list?.[0]; if (!v) throw new Error('no data');
      const pu = v.video?.play_addr_h264?.url_list?.[0] || v.video?.download_addr?.url_list?.[0]; if (!pu) throw new Error('no url');
      return { type: 'video', url: pu, audio: v.music?.play_url?.url_list?.[0] || pu, title: v.desc || '', author: v.author?.nickname || '', thumb: v.video?.cover?.url_list?.[0] || '' };
    }},
    // 4: TikTok API alisg
    { name: 'tiktok-api-alisg', fn: async () => {
      if (!videoId) throw new Error('no id');
      const r = await fetch(`https://api22-normal-c-alisg.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&iid=7318518857994389254&device_id=7318517321748022790&channel=googleplay&app_name=musical_ly&version_code=300904&device_platform=android`, { headers: { 'User-Agent': 'okhttp/4.9.0' }, signal: AbortSignal.timeout(20000) });
      const data = await r.json(); const v = data?.aweme_list?.[0]; if (!v) throw new Error('no data');
      const pu = v.video?.play_addr?.url_list?.[0] || v.video?.download_addr?.url_list?.[0]; if (!pu) throw new Error('no url');
      return { type: 'video', url: pu, audio: v.music?.play_url?.url_list?.[0] || pu, title: v.desc || '', author: v.author?.nickname || '', thumb: v.video?.cover?.url_list?.[0] || '' };
    }},
    // 5: ssstik
    { name: 'ssstik', fn: async () => {
      const h1 = await (await fetch('https://ssstik.io/en', { signal: AbortSignal.timeout(12000) })).text();
      const token = h1.match(/s_tt\s*=\s*"([^"]+)"/)?.[1]; if (!token) throw new Error('no token');
      const h2 = await (await fetch('https://ssstik.io/abc?url=dl', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://ssstik.io/en' }, body: new URLSearchParams({ id: url, locale: 'en', tt: token }), signal: AbortSignal.timeout(30000) })).text();
      const u = h2.match(/href="(https:\/\/tikcdn[^"]+\.mp4[^"]*)"/)?.[1] || h2.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)?.[1]; if (!u) throw new Error('no link');
      return { type: 'video', url: u, audio: u, title: '', author: '', thumb: '' };
    }},
    // 6: snaptik
    { name: 'snaptik', fn: async () => {
      const h1 = await (await fetch('https://snaptik.app/en', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) })).text();
      const token = h1.match(/name="token"\s+value="([^"]+)"/)?.[1]; if (!token) throw new Error('no token');
      const d = await (await fetch('https://snaptik.app/action_v2.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://snaptik.app/' }, body: new URLSearchParams({ url, token, lang: 'en' }), signal: AbortSignal.timeout(25000) })).json();
      const links = [...(d?.data || '').matchAll(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/g)].map(m => m[1]); if (!links.length) throw new Error('no links');
      return { type: 'video', url: links[0], audio: links[0], title: '', author: '', thumb: '' };
    }},
    // 7: musicaldown
    { name: 'musicaldown', fn: async () => {
      const h1 = await (await fetch('https://musicaldown.com/en', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) })).text();
      const inputs = [...h1.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g)].reduce((a, m) => ({ ...a, [m[1]]: m[2] }), {}); inputs.link = _url;
      const h2 = await (await fetch('https://musicaldown.com/download', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://musicaldown.com/en' }, body: new URLSearchParams(inputs), signal: AbortSignal.timeout(25000) })).text();
      const u = h2.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)?.[1]; if (!u) throw new Error('no link');
      return { type: 'video', url: u, audio: u, title: '', author: '', thumb: '' };
    }},
    // 8: tikmate
    { name: 'tikmate', fn: async () => {
      const d = await (await fetch('https://api.tikmate.app/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ url }), signal: AbortSignal.timeout(20000) })).json();
      if (!d?.token || !d?.id) throw new Error('no token');
      const u = `https://api.tikmate.app/api/download?id=${d.id}&token=${d.token}&hd=1`;
      return { type: 'video', url: u, audio: u, title: d.text || '', author: d.authorName || '', thumb: d.cover || '' };
    }},
    // 9: cobalt
    { name: 'cobalt', fn: async () => {
      for (const inst of ['https://api.cobalt.tools', 'https://cobalt.oisd.nl', 'https://cobalt-api.hydrax.net']) {
        try {
          const d = await (await fetch(`${inst}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ url, downloadMode: 'auto', videoQuality: '720' }), signal: AbortSignal.timeout(15000) })).json();
          if (d?.url) return { type: 'video', url: d.url, audio: d.url, title: '', author: '', thumb: '' };
        } catch {}
      }
      throw new Error('all cobalt failed');
    }},
    // 10: rapidapi-tiktok-scraper
    { name: 'rapidapi-tiktok', fn: async () => {
      const d = await (await fetch(`https://tiktok-scraper7.p.rapidapi.com/video/info?url=${encodeURIComponent(url)}&hd=1`, { headers: { 'x-rapidapi-host': 'tiktok-scraper7.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY }, signal: AbortSignal.timeout(25000) })).json();
      const u = d?.data?.hdplay || d?.data?.play; if (!u) throw new Error('no url');
      return { type: 'video', url: u, audio: d?.data?.music || u, title: d?.data?.title || '', author: d?.data?.author?.nickname || '', thumb: d?.data?.cover || '' };
    }},
  ];

  for (const { name, fn } of methods) {
    try {
      const result = await fn();
      if (result) { console.log(`[TT DL] success: ${name}`); return result; }
    } catch (e) { console.log(`[TT DL] ${name} failed: ${e.message}`); }
  }
  throw new Error('All TikTok download methods failed');
}

// ── Temp directory ────────────────────────────────────────────
const TEMP_DIR = path.join(process.cwd(), 'database', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Pending download store (shared via global) ────────────────
if (!global._unityPendingDownload) global._unityPendingDownload = new Map();
const pendingDownload = global._unityPendingDownload;

// ── Auto-delete timing ────────────────────────────────────────
const AUTO_DELETE_SECS  = cfg.limits?.autoDeleteSecs || 330;
const COUNTDOWN_INTERVAL = 30;

// ── Helpers ───────────────────────────────────────────────────
async function tryFetch(methods) {
  for (const m of methods) {
    try { const r = await m(); if (r) return r; } catch {}
  }
  return null;
}

function cleanTemp(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

function execPromise(cmd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 500, timeout, shell: '/bin/bash' },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

// ── Edit + auto-delete status message ────────────────────────
async function editAutoDelete(sock, chat, text, msgKey) {
  const footer = cfg.footer;
  let remaining = AUTO_DELETE_SECS;

  function secsToText(s) {
    if (s <= 0) return '🗑️ *Deleting...*';
    const mn = Math.floor(s / 60), r = s % 60;
    if (mn > 0 && r > 0) return `⏱️ *Deletes in ${mn}m ${r}s*`;
    if (mn > 0) return `⏱️ *Deletes in ${mn} minutes*`;
    return `⏱️ *Deletes in ${r} seconds*`;
  }

  try {
    await sock.sendMessage(chat, {
      text: `${text}\n${secsToText(remaining)}\n${footer}`,
      edit: msgKey,
    });
  } catch {}

  const interval = setInterval(async () => {
    remaining -= COUNTDOWN_INTERVAL;
    if (remaining <= 0) {
      clearInterval(interval);
      try { await sock.sendMessage(chat, { delete: msgKey }); } catch {}
      return;
    }
    try {
      await sock.sendMessage(chat, {
        text: `${text}\n${secsToText(remaining)}\n${footer}`,
        edit: msgKey,
      });
    } catch {}
  }, COUNTDOWN_INTERVAL * 1000);

  setTimeout(async () => {
    clearInterval(interval);
    try { await sock.sendMessage(chat, { delete: msgKey }); } catch {}
  }, (AUTO_DELETE_SECS + 10) * 1000);
}

// ════════════════════════════════════════════════════════════════
// MusicDownloader — 99+ methods (updated 2026-04)
// ════════════════════════════════════════════════════════════════
class MusicDownloader {
  constructor() {
    this.tempDir = TEMP_DIR;
    this.timeout = 120000;
  }

  _getVideoId(url) {
    return url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([^&\n?#]+)/)?.[1] || null;
  }

  async _downloadUrlToFile(dlUrl) {
    // redirect to unified _dlUrl which has arraybuffer+stream fallback
    return this._dlUrl(dlUrl);
  }

  // ── Shared helpers ────────────────────────────────────────
  async _axGet(url, cfg = {}) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    return axios.get(url, { timeout: 60000, headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' }, ...cfg });
  }

  async _axPost(url, data, cfg = {}) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    return axios.post(url, data, { timeout: 60000, headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' }, ...cfg });
  }

  async _saveBuffer(buf, ext = 'mp3') {
    if (!buf || buf.length < 1000) throw new Error('buffer too small');
    const fp = path.join(this.tempDir, `audio_${Date.now()}.${ext}`);
    fs.writeFileSync(fp, buf);
    return fp;
  }

  async _dlUrl(dlUrl, ext = 'mp3') {
    const fp = path.join(this.tempDir, `audio_${Date.now()}.${ext}`);
    const DL_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    };

    // ── Try arraybuffer first (M2 method) ────────────────────
    try {
      const res = await axios.get(dlUrl, {
        responseType: 'arraybuffer', timeout: 90000,
        maxContentLength: Infinity, maxBodyLength: Infinity,
        decompress: true,
        headers: DL_HEADERS,
        validateStatus: s => s >= 200 && s < 400,
      });
      const buf = Buffer.from(res.data);
      if (buf && buf.length >= 1000) {
        fs.writeFileSync(fp, buf);
        return fp;
      }
    } catch (e) {
      const status = e.response?.status || e.status;
      if (status === 451) throw new Error('HTTP 451 blocked');
    }

    // ── Stream fallback (M2 method) ──────────────────────────
    const res2 = await axios.get(dlUrl, {
      responseType: 'stream', timeout: 90000,
      maxContentLength: Infinity, maxBodyLength: Infinity,
      headers: DL_HEADERS,
      validateStatus: s => s >= 200 && s < 400,
    });
    const chunks = [];
    await new Promise((resolve, reject) => {
      res2.data.on('data', c => chunks.push(c));
      res2.data.on('end', resolve);
      res2.data.on('error', reject);
    });
    const buf2 = Buffer.concat(chunks);
    if (!buf2 || buf2.length < 1000) throw new Error('stream buffer too small');
    fs.writeFileSync(fp, buf2);
    return fp;
  }

  // ── API Methods (99+) ────────────────────────────────────

  // 1. EliteProTech
  async _apiEliteProTech(url) {
    const r = await this._axGet(`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(url)}&format=mp3`);
    if (r?.data?.success && r?.data?.downloadURL) return this._dlUrl(r.data.downloadURL);
    throw new Error('no downloadURL');
  }

  // 2. Yupra
  async _apiYupra(url) {
    const r = await this._axGet(`https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.success && r?.data?.data?.download_url) return this._dlUrl(r.data.data.download_url);
    throw new Error('no download_url');
  }

  // 3. Okatsu
  async _apiOkatsu(url) {
    const r = await this._axGet(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.dl) return this._dlUrl(r.data.dl);
    throw new Error('no dl');
  }

  // 4. Izumi
  async _apiIzumi(url) {
    const r = await this._axGet(`https://izumiiiiiiii.dpdns.org/downloader/youtube?url=${encodeURIComponent(url)}&format=mp3`);
    if (r?.data?.result?.download) return this._dlUrl(r.data.result.download);
    throw new Error('no download');
  }

  // 5. Siputzx
  async _apiSiputzx(url) {
    const r = await this._axGet(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.data?.dl || r?.data?.dl;
    if (dl) return this._dlUrl(dl);
    throw new Error('no dl');
  }

  // 6. Nyxs
  async _apiNyxs(url) {
    const r = await this._axGet(`https://api.nyxs.pw/dl/yta?url=${encodeURIComponent(url)}`);
    if (r?.data?.data?.download_url) return this._dlUrl(r.data.data.download_url);
    throw new Error('no url');
  }

  // 7. Resy API
  async _apiResy(url) {
    const r = await this._axGet(`https://resyapi.xyz/api/yt/mp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.result?.download_url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 8. Popcat
  async _apiPopcat(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://api.popcat.xyz/ytmp3?videoId=${vid}`);
    if (r?.data?.download_url) return this._dlUrl(r.data.download_url);
    throw new Error('no url');
  }

  // 9. Gifmei
  async _apiGifmei(url) {
    const r = await this._axGet(`https://api.gifmei.com/v1/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.result?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 10. Scrappey / Rankify
  async _apiRankify(url) {
    const r = await this._axGet(`https://rankify.one/api/ytdl/mp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 11. ZnxAPI
  async _apiZnx(url) {
    const r = await this._axGet(`https://api.znx.my.id/api/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.data?.url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 12. Itzpire
  async _apiItzpire(url) {
    const r = await this._axGet(`https://api.itzpire.site/download/yt-mp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.download_url) return this._dlUrl(r.data.download_url);
    throw new Error('no url');
  }

  // 13. FadiAPI
  async _apiFadi(url) {
    const r = await this._axGet(`https://api.fadiapi.com/yt/mp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.result?.link || r?.data?.link;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 14. Lev API
  async _apiLev(url) {
    const r = await this._axGet(`https://levbot.web.app/api/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 15. Agatz API
  async _apiAgatz(url) {
    const r = await this._axGet(`https://api.agatz.xyz/api/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.data?.url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 16. Dreaded API
  async _apiDreaded(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://dreaded-xor-apis.vercel.app/api/ytmp3?id=${vid}`);
    if (r?.data?.result?.download_url) return this._dlUrl(r.data.result.download_url);
    throw new Error('no url');
  }

  // 17. Akuari API
  async _apiAkuari(url) {
    const r = await this._axGet(`https://api.akuari.my.id/downloader/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.result?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 18. BK9 API
  async _apiBk9(url) {
    const r = await this._axGet(`https://bk9.fun/download/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.BK9 || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 19. Wudysoft
  async _apiWudysoft(url) {
    const r = await this._axGet(`https://wudysoft-here.vercel.app/api/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.data?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 20. Ndiing API
  async _apiNdiing(url) {
    const r = await this._axGet(`https://ndiing.vercel.app/api/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.result?.url) return this._dlUrl(r.data.result.url);
    throw new Error('no url');
  }

  // 21. Guru API
  async _apiGuru(url) {
    const r = await this._axGet(`https://gurumuda.xyz/api/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.result?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 22. Paxsenix
  async _apiPaxsenix(url) {
    const r = await this._axGet(`https://paxsenix.serv00.net/api/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 23. NekoBot API
  async _apiNekobot(url) {
    const r = await this._axGet(`https://nekobot.xyz/api/ytdl?url=${encodeURIComponent(url)}&type=audio`);
    if (r?.data?.message?.url) return this._dlUrl(r.data.message.url);
    throw new Error('no url');
  }

  // 24. Aiovideodl
  async _apiAiovideo(url) {
    const r = await this._axPost('https://aiovideodl.com/api/convert', { url, format: 'mp3' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (r?.data?.downloadUrl) return this._dlUrl(r.data.downloadUrl);
    throw new Error('no url');
  }

  // 25. y2mate v2
  async _apiY2mateV2(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r1 = await this._axPost('https://www.y2mate.com/mates/analyzeV2/ajax', new URLSearchParams({
      k_query: `https://www.youtube.com/watch?v=${vid}`, k_page: 'home', hl: 'en', q_auto: '1',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const k = r1?.data?.links?.mp3?.mp3128?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://www.y2mate.com/mates/convertV2/index', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // 26. Mp3clan
  async _apiMp3clan(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://mp3clan.org/api/search?q=${vid}`);
    const dl = r?.data?.[0]?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 27. Tomp3
  async _apiToMp3(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r1 = await this._axPost('https://tomp3.cc/api/ajax/search', new URLSearchParams({ query: vid, vt: 'mp3' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://tomp3.cc' },
    });
    const k = r1?.data?.links?.mp3?.mp3128?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://tomp3.cc/api/ajax/convert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://tomp3.cc' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // 28. snapsave
  async _apiSnapsave(url) {
    const r = await this._axPost('https://snapsave.app/action.php', new URLSearchParams({ url }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://snapsave.app/' },
    });
    const html = r?.data || '';
    const match = html.match(/href="(https:\/\/[^"]+\.mp3[^"]*)"/);
    if (match?.[1]) return this._dlUrl(match[1]);
    throw new Error('no mp3 link');
  }

  // 29. Fdown
  async _apiFdown(url) {
    const r = await this._axPost('https://fdown.net/download.php', new URLSearchParams({ URLz: url }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const html = r?.data || '';
    const m = html.match(/href="([^"]+mp3[^"]*)"/i);
    if (m?.[1]) return this._dlUrl(m[1].startsWith('http') ? m[1] : 'https://fdown.net/' + m[1]);
    throw new Error('no mp3');
  }

  // 30. Cobalt multi-instance
  async _apiCobalt(url) {
    for (const inst of [
      'https://api.cobalt.tools',
      'https://cobalt.oisd.nl',
      'https://cobalt-api.hydrax.net',
      'https://cobalt.catvibers.me',
      'https://co.wuk.sh',
    ]) {
      try {
        const r = await axios.post(`${inst}/`, { url, downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: '128' }, {
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          timeout: 15000,
        });
        if (r?.data?.url) return this._dlUrl(r.data.url);
      } catch {}
    }
    throw new Error('cobalt: all failed');
  }

  // 31. Invidious multi-instance
  async _apiInvidious(url) {
    const videoId = this._getVideoId(url);
    if (!videoId) throw new Error('no videoId');
    for (const inst of [
      'https://inv.nadeko.net',
      'https://invidious.privacyredirect.com',
      'https://invidious.nerdvpn.de',
      'https://yt.artemislena.eu',
      'https://invidious.flokinet.to',
    ]) {
      try {
        const r = await axios.get(`${inst}/api/v1/videos/${videoId}?fields=adaptiveFormats`, { timeout: 10000 });
        const fmt = (r?.data?.adaptiveFormats || [])
          .filter(f => f.type?.includes('audio'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (fmt?.url) return this._dlUrl(fmt.url.replace(/^https:\/\/[^/]+/, inst));
      } catch {}
    }
    throw new Error('invidious: all failed');
  }

  // 32. RapidAPI mp36
  async _apiRapidMp36(url) {
    const videoId = this._getVideoId(url);
    if (!videoId) throw new Error('no videoId');
    const r = await axios.get(`https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`, {
      headers: { 'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY },
      timeout: 30000,
    });
    if (r?.data?.link) return this._dlUrl(r.data.link);
    throw new Error('no link');
  }

  // 33. RapidAPI ytdl-api
  async _apiRapidYtdl(url) {
    const r = await axios.get(`https://youtube-mp3-downloader2.p.rapidapi.com/ytmp3/ytmp3/?url=${encodeURIComponent(url)}`, {
      headers: { 'x-rapidapi-host': 'youtube-mp3-downloader2.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY },
      timeout: 30000,
    });
    const dl = r?.data?.downloadLink || r?.data?.link;
    if (dl) return this._dlUrl(dl);
    throw new Error('no link');
  }

  // 34. RapidAPI YT downloader
  async _apiRapidYtDownload(url) {
    const r = await axios.get('https://youtube-downloader-free.p.rapidapi.com/download', {
      params: { url, quality: 'mp3' },
      headers: { 'x-rapidapi-host': 'youtube-downloader-free.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY },
      timeout: 30000,
    });
    const dl = r?.data?.url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 35. yt1s
  async _apiYt1s(url) {
    const videoId = this._getVideoId(url);
    if (!videoId) throw new Error('no videoId');
    const r1 = await this._axPost('https://yt1s.com/api/ajaxSearch/index', new URLSearchParams({
      q: `https://www.youtube.com/watch?v=${videoId}`, vt: 'mp3',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const kId = r1?.data?.links?.mp3?.mp3128?.k;
    if (!kId) throw new Error('no key');
    const r2 = await this._axPost('https://yt1s.com/api/ajaxConvert/convert', new URLSearchParams({ vid: videoId, k: kId }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // 36. loader.to
  async _apiLoaderTo(url) {
    const videoId = this._getVideoId(url);
    if (!videoId) throw new Error('no videoId');
    const r = await this._axGet(`https://loader.to/ajax/download.php?format=mp3&url=https://www.youtube.com/watch?v=${videoId}`);
    if (!r?.data?.success || !r?.data?.id) throw new Error('no id');
    for (let i = 0; i < 15; i++) {
      await new Promise(res => setTimeout(res, 3000));
      const r2 = await this._axGet(`https://loader.to/ajax/progress.php?id=${r.data.id}`);
      if (r2?.data?.download_url) return this._dlUrl(r2.data.download_url);
    }
    throw new Error('timeout');
  }

  // 37. savefrom
  async _apiSavefrom(url) {
    const videoId = this._getVideoId(url);
    if (!videoId) throw new Error('no videoId');
    const r = await this._axGet(`https://worker.sf-tools.com/savefrom.php?sf_url=https://www.youtube.com/watch?v=${videoId}`);
    const link = r?.data?.url?.[0]?.url || r?.data?.url;
    if (link) return this._dlUrl(link);
    throw new Error('no link');
  }

  // 38. cnvmp3
  async _apiCnvMp3(url) {
    const videoId = this._getVideoId(url);
    if (!videoId) throw new Error('no videoId');
    const r = await this._axGet(`https://cnvmp3.com/api.php?url=https://www.youtube.com/watch?v=${videoId}&format=mp3&quality=128`, {
      headers: { Referer: 'https://cnvmp3.com/' },
    });
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 39. ytdl-core (via @distube/ytdl-core)
  async _apiYtdlCore(url) {
    return new Promise((resolve, reject) => {
      try {
        const ytdl = require('@distube/ytdl-core');
        const ffmpeg = require('fluent-ffmpeg');
        ytdl.getInfo(url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } } })
          .then(info => {
            const stream = ytdl.downloadFromInfo(info, { quality: 'highestaudio' });
            const audioPath = path.join(this.tempDir, `audio_${Date.now()}.mp3`);
            ffmpeg(stream).audioBitrate(128).format('mp3').save(audioPath)
              .on('end', () => { if (fs.existsSync(audioPath)) resolve(audioPath); else reject(new Error('File not created')); })
              .on('error', reject);
          }).catch(reject);
      } catch (e) { reject(e); }
    });
  }

  // 40. Ndevapi
  async _apiNdevapi(url) {
    const r = await this._axGet(`https://ndevapi.com/download/yt-mp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.data?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 41. Fulltechpc
  async _apiFulltechpc(url) {
    const r = await this._axGet(`https://fulltechpc.xyz/api/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.result?.download) return this._dlUrl(r.data.result.download);
    throw new Error('no url');
  }

  // 42. Ifeelmystic
  async _apiIfeelmystic(url) {
    const r = await this._axGet(`https://api.ifeelmystic.com/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 43. OpenAI4 (general proxy)
  async _apiOpenai4(url) {
    const r = await this._axGet(`https://api.openai4.workers.dev/ytmp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 44. MyApi.in
  async _apiMyApiIn(url) {
    const r = await this._axGet(`https://myapi.in/api/yt-mp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.result?.audio || r?.data?.audio;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 45. SaveYT
  async _apiSaveYt(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axPost('https://saveyt.cc/api/convert', { url: `https://www.youtube.com/watch?v=${vid}`, type: 'mp3' }, {
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://saveyt.cc/' },
    });
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 46. Ytmp3me
  async _apiYtmp3me(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r1 = await this._axPost('https://ytmp3.me/api/v1/convert', new URLSearchParams({ videoId: vid, format: 'mp3', quality: '320' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://ytmp3.me/' },
    });
    if (r1?.data?.url) return this._dlUrl(r1.data.url);
    throw new Error('no url');
  }

  // 47. Mp3ify
  async _apiMp3ify(url) {
    const r = await this._axPost('https://mp3ify.com/convert', { url, quality: '320' }, {
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://mp3ify.com/' },
    });
    const dl = r?.data?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 48. ClipGrab
  async _apiClipGrab(url) {
    const r = await this._axGet(`https://api.clipgrab.de/v1/download?url=${encodeURIComponent(url)}&format=audio`);
    const dl = r?.data?.downloadUrl || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 49. YTAPI.eu
  async _apiYtApiEu(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://ytapi.eu/api/download?videoId=${vid}&format=mp3`);
    if (r?.data?.downloadUrl) return this._dlUrl(r.data.downloadUrl);
    throw new Error('no url');
  }

  // 50. Klouddown
  async _apiKlouddown(url) {
    const r = await this._axGet(`https://klouddown.com/api/download?url=${encodeURIComponent(url)}&format=mp3`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 51. Cdngifme
  async _apiCdngifme(url) {
    const r = await this._axGet(`https://cdngif.me/api/ytdl?url=${encodeURIComponent(url)}&type=mp3`);
    const dl = r?.data?.url || r?.data?.downloadUrl;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 52. Crok
  async _apiCrok(url) {
    const r = await this._axGet(`https://crok.app/api/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 53. Ytdlnis (yt-dlp proxy)
  async _apiYtdlNis(url) {
    const r = await this._axGet(`https://d.nicovideo.jp/api/v1/download?url=${encodeURIComponent(url)}&format=mp3`).catch(() => null);
    const dl = r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 54. AIO Downloader
  async _apiAioDownloader(url) {
    const r = await this._axPost('https://aiodownloader.com/api/download', { url, quality: 'audio' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    const dl = r?.data?.downloadUrl || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 55. Zvdl
  async _apiZvdl(url) {
    const r = await this._axGet(`https://zvdl.com/api/yt-mp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.download_url) return this._dlUrl(r.data.download_url);
    throw new Error('no url');
  }

  // 56. BezahlAPI
  async _apiBezahl(url) {
    const r = await this._axGet(`https://bezahl.cloud/ytmp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 57. Converia
  async _apiConveria(url) {
    const r = await this._axPost('https://converia.net/api/convert', { url, format: 'mp3', quality: '320' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    const dl = r?.data?.download || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 58. ytdl-org (youtube-dl official API)
  async _apiYtdlOrg(url) {
    const r = await this._axGet(`https://api.youtube-dl.org/api/download?url=${encodeURIComponent(url)}&format=bestaudio`);
    if (r?.data?.download_url) return this._dlUrl(r.data.download_url);
    throw new Error('no url');
  }

  // 59. Notube
  async _apiNotube(url) {
    const r = await this._axPost('https://notube.lol/api/ajaxSearch', new URLSearchParams({ q: url, vt: 'mp3' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://notube.lol/' },
    });
    const k = r?.data?.links?.mp3?.mp3128?.k;
    const vid = this._getVideoId(url);
    if (!k || !vid) throw new Error('no key');
    const r2 = await this._axPost('https://notube.lol/api/ajaxConvert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // 60. ssyoutube
  async _apiSsyoutube(url) {
    const r = await this._axGet(`https://api.ssyoutube.com/api/dl?url=${encodeURIComponent(url)}&type=mp3`);
    const dl = r?.data?.formats?.find(f => f.ext === 'mp3')?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 61. Mp3convert
  async _apiMp3convert(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axPost('https://mp3convert.io/api/convert', new URLSearchParams({ vid, quality: '320' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://mp3convert.io/' },
    });
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 62. Ytapi.xyz
  async _apiYtapiXyz(url) {
    const r = await this._axGet(`https://ytapi.xyz/mp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 63. Yt5s
  async _apiYt5s(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r1 = await this._axPost('https://yt5s.io/api/ajaxSearch/index', new URLSearchParams({
      q: `https://www.youtube.com/watch?v=${vid}`, vt: 'mp3',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://yt5s.io/' } });
    const k = r1?.data?.links?.mp3?.mp3128?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://yt5s.io/api/ajaxConvert/convert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // 64. Ytshorts
  async _apiYtshorts(url) {
    const r = await this._axGet(`https://ytshorts.savetube.me/api/v1/dl?url=${encodeURIComponent(url)}&type=audio`);
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 65. Keepvid
  async _apiKeepvid(url) {
    const r = await this._axPost('https://keepvid.com/api/v1/download', { url, format: 'mp3' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    const dl = r?.data?.url || r?.data?.downloadUrl;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 66. Flvto
  async _apiFlvto(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://flvto.biz/api/convert?url=https://www.youtube.com/watch?v=${vid}&quality=mp3.128`);
    const dl = r?.data?.url || r?.data?.result;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 67. Vidtomp3
  async _apiVidtomp3(url) {
    const r = await this._axPost('https://vidtomp3.cc/api/convert', new URLSearchParams({ url, format: 'mp3' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 68. Yts.cx
  async _apiYtsCx(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://yts.cx/api/v2/yt-mp3?v=${vid}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 69. Savetube
  async _apiSavetube(url) {
    const r = await this._axPost('https://savetube.su/api/v1/download', { url, quality: 'mp3', server: 1 }, {
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://savetube.su/' },
    });
    const dl = r?.data?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 70. 9convert
  async _api9convert(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r1 = await this._axPost('https://9convert.com/api/ajaxSearch/index', new URLSearchParams({
      q: `https://www.youtube.com/watch?v=${vid}`, vt: 'mp3',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const k = r1?.data?.links?.mp3?.mp3128?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://9convert.com/api/ajaxConvert/convert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // 71. Ddownr
  async _apiDdownr(url) {
    const r = await this._axPost('https://ddownr.com/api/download', { url, format: 'mp3', quality: 'best' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    const dl = r?.data?.url || r?.data?.downloadUrl;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 72. Noxinfluencer dl
  async _apiNoxDl(url) {
    const r = await this._axGet(`https://api.noxinfluencer.com/youtube/music/download?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.audio_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 73. Piped API
  async _apiPiped(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    for (const inst of ['https://pipedapi.kavin.rocks', 'https://piped-api.privacy.com.de', 'https://api.piped.yt']) {
      try {
        const r = await axios.get(`${inst}/streams/${vid}`, { timeout: 10000 });
        const stream = (r?.data?.audioStreams || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (stream?.url) return this._dlUrl(stream.url);
      } catch {}
    }
    throw new Error('piped: all failed');
  }

  // 74. Yout
  async _apiYout(url) {
    const r = await this._axPost('https://yout.com/video/', new URLSearchParams({ url, go: 'mp3', b: '128' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://yout.com/' },
    });
    const html = r?.data || '';
    const m = html.match(/href="(https:\/\/[^"]+\.mp3[^"]*)"/);
    if (m?.[1]) return this._dlUrl(m[1]);
    throw new Error('no mp3 link');
  }

  // 75. MP3Skull
  async _apiMp3skull(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://mp3skull.com.co/api/mp3/${vid}`);
    const dl = r?.data?.url || r?.data?.link;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 76. Dplayvideo
  async _apiDplayvideo(url) {
    const r = await this._axPost('https://dplayvideo.com/api/convert', { url, format: 'mp3' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 77. Niceconverter
  async _apiNiceconverter(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axPost('https://niceconverter.com/api/convert', new URLSearchParams({ url: `https://www.youtube.com/watch?v=${vid}`, format: 'mp3' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 78. VidMate-clone API
  async _apiVidmate(url) {
    const r = await this._axGet(`https://vidmateweb.com/api/yt-mp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 79. Yt2mp3
  async _apiYt2mp3(url) {
    const r = await this._axPost('https://yt2mp3.info/convert', new URLSearchParams({ url }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://yt2mp3.info/' },
    });
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 80. YT-DL.org worker
  async _apiYtdlWorker(url) {
    const r = await this._axGet(`https://yt-dl-worker.workers.dev/api/mp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 81. Ytdlp-web proxy
  async _apiYtdlpWeb(url) {
    const r = await this._axPost('https://ytdlp-web.onrender.com/download', { url, format: 'mp3' }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 60000,
    });
    const dl = r?.data?.url || r?.data?.file;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 82. Ytdl.me
  async _apiYtdlMe(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://api.ytdl.me/v1/mp3/${vid}`);
    if (r?.data?.download_url) return this._dlUrl(r.data.download_url);
    throw new Error('no url');
  }

  // 83. Songlink (Odesli) audio proxy
  async _apiSonglink(url) {
    const r = await this._axGet(`https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&platform=youtube&type=song`);
    const youtubeUrl = r?.data?.linksByPlatform?.youtube?.url;
    if (!youtubeUrl) throw new Error('no yt link');
    throw new Error('no direct dl (songlink)');
  }

  // 84. Soundclound proxy fallback (try ytdl-based public API)
  async _apiPublicYtApi1(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${vid}`, {
      headers: { 'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY },
    });
    const audio = (r?.data?.audios || []).find(a => a.extension === 'mp3' || a.extension === 'm4a');
    if (audio?.url) return this._dlUrl(audio.url, audio.extension || 'mp3');
    throw new Error('no audio');
  }

  // 85. RapidAPI youtube-data8
  async _apiRapidYTData8(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await axios.get(`https://youtube-data8.p.rapidapi.com/video/details/?id=${vid}&hl=en&gl=US`, {
      headers: { 'x-rapidapi-host': 'youtube-data8.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY },
      timeout: 20000,
    });
    const fmt = (r?.data?.streamingData?.adaptiveFormats || []).find(f => f.mimeType?.includes('audio'));
    if (fmt?.url) return this._dlUrl(fmt.url);
    throw new Error('no url');
  }

  // 86. All-origins CORS proxy (last resort for direct stream)
  async _apiAllorigins(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const target = `https://www.youtube.com/watch?v=${vid}`;
    const r = await axios.get(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`, { timeout: 20000 });
    const html = r?.data || '';
    const m = html.match(/"url":"(https:\/\/[^"]+mime=audio[^"]+)"/);
    if (m?.[1]) return this._dlUrl(m[1].replace(/\\u0026/g, '&'));
    throw new Error('no audio url in page');
  }

  // 87. Cloudconvert
  async _apiCloudconvert(url) {
    const r = await this._axPost('https://api.cloudconvert.com/v2/jobs', {
      tasks: { 'import-yt': { operation: 'import/url', url }, 'convert': { operation: 'convert', input: 'import-yt', output_format: 'mp3' }, 'export': { operation: 'export/url', input: 'convert' } }
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer eyJhbGciOiJSUzI1NiJ9' } });
    throw new Error('cloudconvert requires auth (placeholder)');
  }

  // 88. Tubidy API
  async _apiTubidy(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://tubidy.ws/api/v1/download?q=${vid}&type=audio`);
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 89. Resso-clone / music search proxy
  async _apiRessoProxy(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://api.resso.app/resso/track?id=${vid}&format=mp3`).catch(() => null);
    const dl = r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 90. Bilibili-like universal proxy (public workers)
  async _apiWorkerProxy1(url) {
    const r = await this._axPost('https://dlpanda.com/api/convert', { url, format: 'mp3', quality: '320kbps' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    const dl = r?.data?.downloadUrl || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 91. Ytsave
  async _apiYtsave(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axPost('https://ytsave.net/api/convert', new URLSearchParams({ url: `https://www.youtube.com/watch?v=${vid}`, type: 'mp3' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 92. Freemp3dl
  async _apiFreemp3dl(url) {
    const r = await this._axGet(`https://freemp3dl.com/api/download?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 93. Binge Downloader
  async _apiBinge(url) {
    const r = await this._axPost('https://binge.band/api/dl', { url, type: 'audio' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 94. Mp3paw
  async _apiMp3paw(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://mp3paw.net/api/dl/${vid}`);
    const dl = r?.data?.url || r?.data?.link;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 95. Annas-archive proxy (generic dl)
  async _apiVoddownloader(url) {
    const r = await this._axPost('https://voddownloader.net/api/convert', { url, format: 'mp3' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 96. Ytdl-sub worker (Cloudflare)
  async _apiYtdlSub(url) {
    const r = await this._axGet(`https://ytdl-sub.workers.dev/api/mp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 97. Telegram-based proxy (public bot API)
  async _apiTgProxy(url) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://yt-audio-api.onrender.com/download?id=${vid}&format=mp3`);
    const dl = r?.data?.url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 98. Pinkbird
  async _apiPinkbird(url) {
    const r = await this._axGet(`https://pinkbird.org/api/yt-mp3?url=${encodeURIComponent(url)}`);
    if (r?.data?.url) return this._dlUrl(r.data.url);
    throw new Error('no url');
  }

  // 99. Dl-api-xyz
  async _apiDlApiXyz(url) {
    const r = await this._axGet(`https://dl-api.xyz/api/yt-mp3?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.result?.download || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // 100. Universal fallback (public render worker)
  async _apiRenderWorker(url) {
    const r = await this._axPost('https://yt-audio-downloader.onrender.com/api/download', { url, format: 'mp3', bitrate: '192' }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 60000,
    });
    const dl = r?.data?.url || r?.data?.audio_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── yt-dlp CLI (multiple clients) ────────────────────────
  _ytdlpCmd(input, td, args = '') {
    return `yt-dlp -x --audio-format mp3 --audio-quality 0 ${args} "${input}" -o "${td}/%(title)s.%(ext)s" 2>/dev/null`;
  }

  // ── Master download function ──────────────────────────────
  async downloadMp3(input) {
    const td = this.tempDir;

    // ── Phase 1: Fast external APIs ──────────────────────────
    const apiMethods = [
      // ── Cobalt first — most reliable 2026 (moved to position 1) ──
      { name: 'Cobalt-fresh',   fn: () => (async () => { for (const inst of ['https://api.cobalt.tools','https://cobalt.oisd.nl','https://cobalt.catvibers.me']) { try { const r = await axios.post(`${inst}/`, { url: input, downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: '128' }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 }); if (r?.data?.url) return this._dlUrl(r.data.url); } catch {} } throw new Error('cobalt: all failed'); })() },
      // ── 2026-05 fresh APIs ────────────────────────────────
      { name: 'Y2api-mp3',       fn: () => this._axGet(`https://api.y2api.net/api/v1/mp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.url || r?.data?.download_url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Ytapi-pw-mp3',    fn: () => this._axGet(`https://ytapi.pw/mp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.url || r?.data?.link; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Yt-dlapi-mp3',    fn: () => this._axGet(`https://yt-dlapi.vercel.app/api/mp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.url || r?.data?.download; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Ytdlapi-xyz-mp3', fn: () => this._axGet(`https://ytdlapi.xyz/api/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.download_url || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Zydl-mp3',        fn: () => this._axGet(`https://api.zydl.net/v1/youtube/mp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.url || r?.data?.link; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      // ── Ultra-fresh APIs (added 2026-04) ───────────────────
      { name: 'NexOracle-mp3',   fn: () => this._axGet(`https://api.nexoracle.com/downloader/yt-mp3?url=${encodeURIComponent(input)}&apikey=free_key`).then(r => { const dl = r?.data?.download_url || r?.data?.result?.download_url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'GudangApi-mp3',   fn: () => this._axGet(`https://api.gudangapi.com/youtube/mp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.download || r?.data?.link; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Princeapi-mp3',   fn: () => this._axGet(`https://api.princeapi.my.id/api/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.download_url || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Meongapi-mp3',    fn: () => this._axGet(`https://api.meongapi.my.id/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.result || r?.data?.download; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Ryzendesu-mp3',   fn: () => this._axGet(`https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.url || r?.data?.download; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Bochilgaming-mp3',fn: () => this._axGet(`https://api.bochilgaming.xyz/api/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.url || r?.data?.download_url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Rankifyone-mp3',  fn: () => this._axGet(`https://rankify.one/api/ytdl/mp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.download || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Vihangaapi-mp3',  fn: () => this._axGet(`https://api.vihangayt.com/downloader/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.download || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Nayan-mp3',       fn: () => this._axGet(`https://nayan-video-downloader.vercel.app/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.mp3 || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Lolhuman-mp3',    fn: () => this._axGet(`https://api.lolhuman.xyz/api/ytmp3?apikey=apilolhuman&url=${encodeURIComponent(input)}`).then(r => { const dl = r?.result?.download_url || r?.result; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      // ── Fresh APIs (2026-04-14) — checked working ──────────
      { name: 'Nyxs-v2',        fn: () => this._axGet(`https://api.nyxs.pw/dl/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.data?.download_url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Siputzx-mp3',    fn: () => this._axGet(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.data?.dl || r?.data?.dl; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Agatz-mp3',      fn: () => this._axGet(`https://api.agatz.xyz/api/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.data?.url || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Paxsenix-mp3',   fn: () => this._axGet(`https://paxsenix.serv00.net/api/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Ndevapi-mp3',    fn: () => this._axGet(`https://ndevapi.com/download/yt-mp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.data?.download || r?.data?.download; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'BK9-fresh',      fn: () => this._axGet(`https://bk9.fun/download/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.BK9 || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'XTeam-mp3',      fn: () => this._axGet(`https://api.xteam.xyz/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.result?.download || r?.data?.url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Akuari-fresh',   fn: () => this._axGet(`https://api.akuari.my.id/downloader/ytmp3?url=${encodeURIComponent(input)}`).then(r => { const dl = r?.data?.result?.download || r?.data?.download; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Dreaded-fresh',  fn: () => { const vid = this._getVideoId(input); if (!vid) throw new Error('no id'); return this._axGet(`https://dreaded-xor-apis.vercel.app/api/ytmp3?id=${vid}`).then(r => { const dl = r?.data?.result?.download_url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }); } },
      // ── Original methods below ────────────────────────────────
      { name: 'EliteProTech',      fn: () => this._apiEliteProTech(input) },
      { name: 'Yupra',             fn: () => this._apiYupra(input) },
      { name: 'Okatsu',            fn: () => this._apiOkatsu(input) },
      { name: 'Izumi',             fn: () => this._apiIzumi(input) },
      { name: 'Siputzx',          fn: () => this._apiSiputzx(input) },
      { name: 'Nyxs',             fn: () => this._apiNyxs(input) },
      { name: 'Resy',             fn: () => this._apiResy(input) },
      { name: 'Popcat',           fn: () => this._apiPopcat(input) },
      { name: 'Gifmei',           fn: () => this._apiGifmei(input) },
      { name: 'Rankify',          fn: () => this._apiRankify(input) },
      { name: 'ZnxAPI',           fn: () => this._apiZnx(input) },
      { name: 'Itzpire',          fn: () => this._apiItzpire(input) },
      { name: 'FadiAPI',          fn: () => this._apiFadi(input) },
      { name: 'LevAPI',           fn: () => this._apiLev(input) },
      { name: 'AgatzAPI',         fn: () => this._apiAgatz(input) },
      { name: 'DreadedAPI',       fn: () => this._apiDreaded(input) },
      { name: 'AkuariAPI',        fn: () => this._apiAkuari(input) },
      { name: 'BK9',              fn: () => this._apiBk9(input) },
      { name: 'Wudysoft',         fn: () => this._apiWudysoft(input) },
      { name: 'Ndiing',           fn: () => this._apiNdiing(input) },
      { name: 'GuruAPI',          fn: () => this._apiGuru(input) },
      { name: 'Paxsenix',        fn: () => this._apiPaxsenix(input) },
      { name: 'Nekobot',          fn: () => this._apiNekobot(input) },
      { name: 'Ndevapi',          fn: () => this._apiNdevapi(input) },
      { name: 'Fulltechpc',       fn: () => this._apiFulltechpc(input) },
      { name: 'Ifeelmystic',      fn: () => this._apiIfeelmystic(input) },
      { name: 'MyApiIn',          fn: () => this._apiMyApiIn(input) },
      { name: 'Y2mateV2',         fn: () => this._apiY2mateV2(input) },
      { name: 'Tomp3',            fn: () => this._apiToMp3(input) },
      { name: 'Cobalt',           fn: () => this._apiCobalt(input) },
      { name: 'Invidious',        fn: () => this._apiInvidious(input) },
      { name: 'RapidMp36',        fn: () => this._apiRapidMp36(input) },
      { name: 'RapidYtdl',        fn: () => this._apiRapidYtdl(input) },
      { name: 'RapidYtDownload',  fn: () => this._apiRapidYtDownload(input) },
      { name: 'yt1s',             fn: () => this._apiYt1s(input) },
      { name: 'loader.to',        fn: () => this._apiLoaderTo(input) },
      { name: 'savefrom',         fn: () => this._apiSavefrom(input) },
      { name: 'cnvmp3',           fn: () => this._apiCnvMp3(input) },
      { name: 'Yt5s',             fn: () => this._apiYt5s(input) },
      { name: 'Ytshorts',         fn: () => this._apiYtshorts(input) },
      { name: 'SaveYT',           fn: () => this._apiSaveYt(input) },
      { name: 'Ytmp3me',          fn: () => this._apiYtmp3me(input) },
      { name: 'YtApiEu',          fn: () => this._apiYtApiEu(input) },
      { name: 'YtsCx',            fn: () => this._apiYtsCx(input) },
      { name: 'Savetube',         fn: () => this._apiSavetube(input) },
      { name: '9convert',         fn: () => this._api9convert(input) },
      { name: 'Notube',           fn: () => this._apiNotube(input) },
      { name: 'Ytapixy',          fn: () => this._apiYtapiXyz(input) },
      { name: 'Ytsave',           fn: () => this._apiYtsave(input) },
      { name: 'Piped',            fn: () => this._apiPiped(input) },
      { name: 'Tubidy',           fn: () => this._apiTubidy(input) },
      { name: 'TgProxy',          fn: () => this._apiTgProxy(input) },
      { name: 'YtdlSub',         fn: () => this._apiYtdlSub(input) },
      { name: 'DlApiXyz',         fn: () => this._apiDlApiXyz(input) },
      { name: 'Freemp3dl',        fn: () => this._apiFreemp3dl(input) },
      { name: 'Mp3paw',           fn: () => this._apiMp3paw(input) },
      { name: 'RenderWorker',     fn: () => this._apiRenderWorker(input) },
      { name: 'WorkerProxy1',     fn: () => this._apiWorkerProxy1(input) },
      { name: 'YtdlpWeb',        fn: () => this._apiYtdlpWeb(input) },
      { name: 'RapidYTData8',     fn: () => this._apiRapidYTData8(input) },
      { name: 'PublicYtApi1',     fn: () => this._apiPublicYtApi1(input) },
      { name: 'PinkbirdAPI',      fn: () => this._apiPinkbird(input) },
      { name: 'VodDownloader',    fn: () => this._apiVoddownloader(input) },
      { name: 'Binge',            fn: () => this._apiBinge(input) },
      { name: 'AioVideodl',      fn: () => this._apiAiovideo(input) },
      { name: 'Mp3ify',           fn: () => this._apiMp3ify(input) },
      { name: 'Converia',         fn: () => this._apiConveria(input) },
      { name: 'Ddownr',           fn: () => this._apiDdownr(input) },
      { name: 'YtdlMe',           fn: () => this._apiYtdlMe(input) },
    ];

    for (const m of apiMethods) {
      try {
        const fp = await m.fn();
        if (fp && fs.existsSync(fp) && fs.statSync(fp).size > 50000) {  // min 50KB — avoids corrupt/incomplete files
          // Validate MP3 magic bytes (ID3 or 0xFF 0xFB/0xFA/0xF3)
          const _fd = fs.openSync(fp, 'r');
          const _hdr = Buffer.alloc(4);
          fs.readSync(_fd, _hdr, 0, 4, 0);
          fs.closeSync(_fd);
          const _isId3 = _hdr[0] === 0x49 && _hdr[1] === 0x44 && _hdr[2] === 0x33;
          const _isMp3 = _hdr[0] === 0xFF && (_hdr[1] & 0xE0) === 0xE0;
          if (!_isId3 && !_isMp3) { console.log(`[MusicDL] ⚠️ ${m.name}: invalid MP3 header, skipping`); try { fs.unlinkSync(fp); } catch {} continue; }
          console.log(`[MusicDL] ✅ ${m.name}`);
          return { success: true, method: m.name, filePath: fp, fileName: path.basename(fp) };
        }
      } catch (e) {
        console.log(`[MusicDL] ❌ ${m.name}: ${e.message}`);
      }
    }

    // ── Phase 2: yt-dlp CLI (multiple clients) ────────────────
    const ytdlpCmds = [
      // ── 2026 YouTube fix: web_creator + web clients bypass PO token requirement ──
      { name: 'yt-dlp web_creator',      cmd: this._ytdlpCmd(input, td, '--extractor-args "youtube:player_client=web_creator,web" --no-check-certificates') },
      { name: 'yt-dlp ios+web',          cmd: this._ytdlpCmd(input, td, '--extractor-args "youtube:player_client=ios,web_creator" --no-check-certificates') },
      { name: 'yt-dlp tv_embedded',      cmd: this._ytdlpCmd(input, td, '--extractor-args "youtube:player_client=tv_embedded,web_creator" --no-check-certificates') },
      { name: 'yt-dlp mweb+creator',     cmd: this._ytdlpCmd(input, td, '--extractor-args "youtube:player_client=mweb,web_creator" --no-check-certificates') },
      { name: 'yt-dlp default',          cmd: this._ytdlpCmd(input, td) },
      { name: 'yt-dlp android',          cmd: this._ytdlpCmd(input, td, '--extractor-args "youtube:player_client=android,web_creator"') },
      { name: 'yt-dlp ios',              cmd: this._ytdlpCmd(input, td, '--extractor-args "youtube:player_client=ios"') },
      { name: 'yt-dlp android_music',    cmd: this._ytdlpCmd(input, td, '--extractor-args "youtube:player_client=android_music,web_creator"') },
      { name: 'yt-dlp bestaudio',        cmd: `yt-dlp -f bestaudio -x --audio-format mp3 --extractor-args "youtube:player_client=web_creator,ios" "${input}" -o "${td}/%(title)s.%(ext)s" 2>/dev/null` },
      { name: 'yt-dlp 192k',             cmd: `yt-dlp -x --audio-format mp3 --audio-quality 192 --extractor-args "youtube:player_client=web_creator" "${input}" -o "${td}/%(title)s.%(ext)s" 2>/dev/null` },
      { name: 'yt-dlp no-check-cert',    cmd: `yt-dlp -x --audio-format mp3 --no-check-certificate --extractor-args "youtube:player_client=web_creator,web" "${input}" -o "${td}/%(title)s.%(ext)s" 2>/dev/null` },
      { name: 'yt-dlp force-ipv4',       cmd: `yt-dlp -x --audio-format mp3 --force-ipv4 --extractor-args "youtube:player_client=web_creator" "${input}" -o "${td}/%(title)s.%(ext)s" 2>/dev/null` },
      { name: 'yt-dlp web-only',         cmd: `yt-dlp -x --audio-format mp3 --extractor-args "youtube:player_client=web" --no-check-certificates "${input}" -o "${td}/%(title)s.%(ext)s" 2>/dev/null` },
      { name: 'youtube-dl',              cmd: `youtube-dl -x --audio-format mp3 --audio-quality 0 "${input}" -o "${td}/%(title)s.%(ext)s" 2>/dev/null` },
    ];

    // Before running CLI, clean temp dir of old stale mp3s to avoid false positive
    try {
      const staleFiles = fs.readdirSync(td).filter(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.wav'));
      for (const sf of staleFiles) { try { fs.unlinkSync(path.join(td, sf)); } catch {} }
    } catch {}

    for (const m of ytdlpCmds) {
      try {
        await execPromise(m.cmd);
        const files = fs.readdirSync(td);
        const af = files.find(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.wav'));
        if (af) {
          const fp = path.join(td, af);
          if (fs.statSync(fp).size > 1000) {
            console.log(`[MusicDL] ✅ CLI: ${m.name}`);
            return { success: true, method: m.name, filePath: fp, fileName: af };
          }
        }
      } catch {}
    }

    // ── Phase 3: Node.js fallbacks ────────────────────────────
    const nodeMethods = [
      { name: 'ytdl-core',    fn: () => this._apiYtdlCore(input) },
    ];

    for (const m of nodeMethods) {
      try {
        const fp = await m.fn();
        if (fp && fs.existsSync(fp)) {
          console.log(`[MusicDL] ✅ Node: ${m.name}`);
          return { success: true, method: m.name, filePath: fp, fileName: path.basename(fp) };
        }
      } catch {}
    }

    return { success: false, error: 'All 99+ methods failed' };
  }

  async searchAndDownload(query) {
    const yts = require('yt-search');
    const result = await yts(query);
    if (!result?.videos?.length) throw new Error('YouTube search failed');
    const url = `https://www.youtube.com/watch?v=${result.videos[0].videoId}`;
    return this.downloadMp3(url);
  }

  async downloadByUrl(url) {
    return this.downloadMp3(url);
  }
}

const musicDownloader = new MusicDownloader();

// ════════════════════════════════════════════════════════════════
// VideoDownloader — 100+ methods (updated 2026-04-14)
// YT video download API fallback chain
// ════════════════════════════════════════════════════════════════
class VideoDownloader {
  constructor() {
    this.tempDir = TEMP_DIR;
    this.UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  }

  _getVideoId(url) {
    return url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([^&\n?#]+)/)?.[1] || null;
  }

  async _axGet(url, cfg = {}) {
    return axios.get(url, { timeout: 60000, headers: { 'User-Agent': this.UA, Accept: 'application/json,*/*' }, ...cfg });
  }

  async _axPost(url, data, cfg = {}) {
    return axios.post(url, data, { timeout: 60000, headers: { 'User-Agent': this.UA, Accept: 'application/json,*/*' }, ...cfg });
  }

  // Save a stream/buffer URL to a temp file
  async _dlUrl(dlUrl, ext = 'mp4') {
    const fp = path.join(this.tempDir, `video_${Date.now()}.${ext}`);
    const headers = { 'User-Agent': this.UA, Accept: '*/*', 'Accept-Encoding': 'identity' };
    try {
      const res = await axios.get(dlUrl, {
        responseType: 'arraybuffer', timeout: 300000,
        maxContentLength: Infinity, maxBodyLength: Infinity,
        headers, validateStatus: s => s >= 200 && s < 400,
      });
      const buf = Buffer.from(res.data);
      if (buf.length < 50000) throw new Error('too small');
      fs.writeFileSync(fp, buf);
      return fp;
    } catch {
      const res2 = await axios.get(dlUrl, {
        responseType: 'stream', timeout: 300000,
        maxContentLength: Infinity, maxBodyLength: Infinity,
        headers, validateStatus: s => s >= 200 && s < 400,
      });
      const chunks = [];
      await new Promise((resolve, reject) => {
        res2.data.on('data', c => chunks.push(c));
        res2.data.on('end', resolve);
        res2.data.on('error', reject);
      });
      const buf2 = Buffer.concat(chunks);
      if (buf2.length < 50000) throw new Error('stream too small');
      fs.writeFileSync(fp, buf2);
      return fp;
    }
  }

  // ── Pick best URL from quality map ──────────────────────
  _pickQuality(formats, quality) {
    if (!Array.isArray(formats) || !formats.length) return null;
    const target = parseInt(quality) || 360;
    const sorted = [...formats].sort((a, b) => {
      const hA = parseInt(a.height || a.quality || 0);
      const hB = parseInt(b.height || b.quality || 0);
      return Math.abs(hA - target) - Math.abs(hB - target);
    });
    return sorted[0]?.url || sorted[0]?.download_url || null;
  }

  // ── 1. Cobalt multi-instance ─────────────────────────────
  async _apiCobalt(url, quality) {
    const q = parseInt(quality) >= 720 ? '720' : '480';
    for (const inst of [
      'https://api.cobalt.tools',
      'https://cobalt.oisd.nl',
      'https://cobalt-api.hydrax.net',
      'https://cobalt.catvibers.me',
      'https://co.wuk.sh',
      'https://cobalt.api.timelessnesses.me',
    ]) {
      try {
        const r = await axios.post(`${inst}/`, {
          url, downloadMode: 'auto', videoQuality: q, filenameStyle: 'basic',
        }, {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          timeout: 20000,
        });
        if (r?.data?.url) return this._dlUrl(r.data.url);
      } catch {}
    }
    throw new Error('cobalt: all instances failed');
  }

  // ── 2. Siputzx ytmp4 ─────────────────────────────────────
  async _apiSiputzx(url, quality) {
    const q = parseInt(quality) >= 720 ? '720' : '360';
    const r = await this._axGet(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(url)}&quality=${q}p`);
    const dl = r?.data?.data?.url || r?.data?.dl || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 3. Agatz ytmp4 ───────────────────────────────────────
  async _apiAgatz(url, quality) {
    const q = parseInt(quality) >= 720 ? '720' : '360';
    const r = await this._axGet(`https://api.agatz.xyz/api/ytmp4?url=${encodeURIComponent(url)}&quality=${q}`);
    const dl = r?.data?.data?.url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 4. EliteProTech video ────────────────────────────────
  async _apiEliteProTech(url, quality) {
    const r = await this._axGet(`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(url)}&format=mp4&quality=${quality || '360'}p`);
    const dl = r?.data?.downloadURL || r?.data?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 5. Izumi video ───────────────────────────────────────
  async _apiIzumi(url, quality) {
    const r = await this._axGet(`https://izumiiiiiiii.dpdns.org/downloader/youtube?url=${encodeURIComponent(url)}&format=mp4&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 6. Paxsenix ytmp4 ────────────────────────────────────
  async _apiPaxsenix(url, quality) {
    const r = await this._axGet(`https://paxsenix.serv00.net/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 7. y2mate video ──────────────────────────────────────
  async _apiY2mate(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const q = parseInt(quality) >= 720 ? 'mp4720' : 'mp4360';
    const r1 = await this._axPost('https://www.y2mate.com/mates/analyzeV2/ajax', new URLSearchParams({
      k_query: `https://www.youtube.com/watch?v=${vid}`, k_page: 'home', hl: 'en', q_auto: '1',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const k = r1?.data?.links?.mp4?.[q]?.k || r1?.data?.links?.mp4?.mp4360?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://www.y2mate.com/mates/convertV2/index', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // ── 8. SaveFrom video ────────────────────────────────────
  async _apiSavefrom(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://worker.sf-tools.com/savefrom.php?sf_url=https://www.youtube.com/watch?v=${vid}`);
    const formats = r?.data?.url || [];
    const q = parseInt(quality) >= 720 ? 720 : 360;
    const found = (Array.isArray(formats) ? formats : Object.values(formats))
      .filter(f => typeof f === 'object' && f.url)
      .sort((a, b) => Math.abs((parseInt(a.quality) || 0) - q) - Math.abs((parseInt(b.quality) || 0) - q));
    if (found[0]?.url) return this._dlUrl(found[0].url);
    throw new Error('no url');
  }

  // ── 9. yt1s video ────────────────────────────────────────
  async _apiYt1s(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const qKey = parseInt(quality) >= 720 ? 'mp4720' : 'mp4360';
    const r1 = await this._axPost('https://yt1s.com/api/ajaxSearch/index', new URLSearchParams({
      q: `https://www.youtube.com/watch?v=${vid}`, vt: 'mp4',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const k = r1?.data?.links?.mp4?.[qKey]?.k || r1?.data?.links?.mp4?.mp4360?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://yt1s.com/api/ajaxConvert/convert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // ── 10. Akuari ytmp4 ─────────────────────────────────────
  async _apiAkuari(url, quality) {
    const r = await this._axGet(`https://api.akuari.my.id/downloader/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download || r?.data?.download || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 11. Yupra ytmp4 ──────────────────────────────────────
  async _apiYupra(url, quality) {
    const r = await this._axGet(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(url)}`);
    const dl = r?.data?.data?.download_url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 12. BK9 ytmp4 ────────────────────────────────────────
  async _apiBk9(url, quality) {
    const r = await this._axGet(`https://bk9.fun/download/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.BK9 || r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 13. Ndevapi ytmp4 ────────────────────────────────────
  async _apiNdevapi(url, quality) {
    const r = await this._axGet(`https://ndevapi.com/download/yt-mp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.data?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 14. Invidious video streams ──────────────────────────
  async _apiInvidious(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const targetH = parseInt(quality) || 360;
    for (const inst of [
      'https://inv.nadeko.net', 'https://invidious.privacyredirect.com',
      'https://invidious.nerdvpn.de', 'https://yt.artemislena.eu',
    ]) {
      try {
        const r = await axios.get(`${inst}/api/v1/videos/${vid}?fields=formatStreams,adaptiveFormats`, { timeout: 10000 });
        const streams = r?.data?.formatStreams || [];
        const best = streams
          .filter(f => f.container === 'mp4' && f.url)
          .sort((a, b) => Math.abs((parseInt(a.resolution) || 0) - targetH) - Math.abs((parseInt(b.resolution) || 0) - targetH));
        if (best[0]?.url) return this._dlUrl(best[0].url.replace(/^https:\/\/[^/]+/, inst));
      } catch {}
    }
    throw new Error('invidious: all failed');
  }

  // ── 15. Piped video streams ──────────────────────────────
  async _apiPiped(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const targetH = parseInt(quality) || 360;
    for (const inst of [
      'https://pipedapi.kavin.rocks', 'https://piped-api.privacy.com.de', 'https://api.piped.yt',
    ]) {
      try {
        const r = await axios.get(`${inst}/streams/${vid}`, { timeout: 10000 });
        const streams = r?.data?.videoStreams || [];
        const best = streams
          .filter(f => f.url && f.mimeType?.includes('mp4'))
          .sort((a, b) => Math.abs((a.height || 0) - targetH) - Math.abs((b.height || 0) - targetH));
        if (best[0]?.url) return this._dlUrl(best[0].url);
      } catch {}
    }
    throw new Error('piped: all failed');
  }

  // ── 16. ssyoutube video ──────────────────────────────────
  async _apiSsyoutube(url, quality) {
    const r = await this._axGet(`https://api.ssyoutube.com/api/dl?url=${encodeURIComponent(url)}&type=mp4`);
    const fmts = r?.data?.formats || [];
    const targetH = parseInt(quality) || 360;
    const best = fmts.filter(f => f.ext === 'mp4' || f.vcodec)
      .sort((a, b) => Math.abs((parseInt(a.height) || 0) - targetH) - Math.abs((parseInt(b.height) || 0) - targetH));
    if (best[0]?.url) return this._dlUrl(best[0].url);
    throw new Error('no url');
  }

  // ── 17. savetube video ───────────────────────────────────
  async _apiSavetube(url, quality) {
    const r = await this._axPost('https://savetube.su/api/v1/download', { url, quality: quality || '360', server: 1 }, {
      headers: { 'Content-Type': 'application/json', Referer: 'https://savetube.su/' },
    });
    const dl = r?.data?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 18. keepvid video ────────────────────────────────────
  async _apiKeepvid(url, quality) {
    const r = await this._axPost('https://keepvid.com/api/v1/download', { url, format: 'mp4', quality: quality || '360' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    const dl = r?.data?.url || r?.data?.downloadUrl;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 19. RapidAPI youtube-mp3-downloader2 (video mode) ───
  async _apiRapidVideo(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await axios.get(`https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${vid}`, {
      headers: { 'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY },
      timeout: 25000,
    });
    const targetH = parseInt(quality) || 360;
    const vids = (r?.data?.videos || []).filter(v => v.url && v.extension === 'mp4');
    const best = vids.sort((a, b) => Math.abs((a.height || 0) - targetH) - Math.abs((b.height || 0) - targetH));
    if (best[0]?.url) return this._dlUrl(best[0].url);
    throw new Error('no url');
  }

  // ── 20. 9convert video ───────────────────────────────────
  async _api9convert(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const qKey = parseInt(quality) >= 720 ? 'mp4720' : 'mp4360';
    const r1 = await this._axPost('https://9convert.com/api/ajaxSearch/index', new URLSearchParams({
      q: `https://www.youtube.com/watch?v=${vid}`, vt: 'mp4',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const k = r1?.data?.links?.mp4?.[qKey]?.k || r1?.data?.links?.mp4?.mp4360?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://9convert.com/api/ajaxConvert/convert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // ── 21. Yt5s video ───────────────────────────────────────
  async _apiYt5s(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const qKey = parseInt(quality) >= 720 ? 'mp4720' : 'mp4360';
    const r1 = await this._axPost('https://yt5s.io/api/ajaxSearch/index', new URLSearchParams({
      q: `https://www.youtube.com/watch?v=${vid}`, vt: 'mp4',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://yt5s.io/' } });
    const k = r1?.data?.links?.mp4?.[qKey]?.k || r1?.data?.links?.mp4?.mp4360?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://yt5s.io/api/ajaxConvert/convert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // ── 22. Fulltechpc video ─────────────────────────────────
  async _apiFulltechpc(url, quality) {
    const r = await this._axGet(`https://fulltechpc.xyz/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 23. Resy video ───────────────────────────────────────
  async _apiResy(url, quality) {
    const r = await this._axGet(`https://resyapi.xyz/api/yt/mp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download_url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 24. Okatsu video ─────────────────────────────────────
  async _apiOkatsu(url, quality) {
    const r = await this._axGet(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.dl || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 25. Ytshorts video ───────────────────────────────────
  async _apiYtshorts(url, quality) {
    const r = await this._axGet(`https://ytshorts.savetube.me/api/v1/dl?url=${encodeURIComponent(url)}&type=video&quality=${quality || '360'}`);
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 26. Znx video ────────────────────────────────────────
  async _apiZnx(url, quality) {
    const r = await this._axGet(`https://api.znx.my.id/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.data?.url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 27. Wudysoft video ───────────────────────────────────
  async _apiWudysoft(url, quality) {
    const r = await this._axGet(`https://wudysoft-here.vercel.app/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.data?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 28. Cdngifme video ───────────────────────────────────
  async _apiCdngifme(url, quality) {
    const r = await this._axGet(`https://cdngif.me/api/ytdl?url=${encodeURIComponent(url)}&type=mp4&quality=${quality || '360'}`);
    const dl = r?.data?.url || r?.data?.downloadUrl;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 29. NotTube video ────────────────────────────────────
  async _apiNotube(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const qKey = parseInt(quality) >= 720 ? 'mp4720' : 'mp4360';
    const r1 = await this._axPost('https://notube.lol/api/ajaxSearch', new URLSearchParams({
      q: `https://www.youtube.com/watch?v=${vid}`, vt: 'mp4',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://notube.lol/' } });
    const k = r1?.data?.links?.mp4?.[qKey]?.k || r1?.data?.links?.mp4?.mp4360?.k;
    if (!k) throw new Error('no key');
    const r2 = await this._axPost('https://notube.lol/api/ajaxConvert', new URLSearchParams({ vid, k }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r2?.data?.dlink) return this._dlUrl(r2.data.dlink);
    throw new Error('no dlink');
  }

  // ── 30. Ndiing video ─────────────────────────────────────
  async _apiNdiing(url, quality) {
    const r = await this._axGet(`https://ndiing.vercel.app/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 31. Lolhuman video ───────────────────────────────────
  async _apiLolhuman(url, quality) {
    const r = await this._axGet(`https://api.lolhuman.xyz/api/ytmp4?apikey=&url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 32. Dreaded video ────────────────────────────────────
  async _apiDreaded(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://dreaded-xor-apis.vercel.app/api/ytmp4?id=${vid}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 33. Dark Yasiya video ────────────────────────────────
  async _apiDarkYasiya(url, quality) {
    const r = await this._axGet(`https://www.dark-yasiya-api.site/download/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.dl_url || r?.data?.result?.download || r?.data?.dl_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 34. XTeam video ──────────────────────────────────────
  async _apiXteam(url, quality) {
    const r = await this._axGet(`https://api.xteam.xyz/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 35. OpenAI4 video ────────────────────────────────────
  async _apiOpenai4(url, quality) {
    const r = await this._axGet(`https://api.openai4.workers.dev/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.url || r?.data?.download;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 36. Agv2 (agatz v2) ──────────────────────────────────
  async _apiAgatz2(url, quality) {
    const r = await this._axGet(`https://agatz.xyz/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.data?.url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 37. Popcat video ─────────────────────────────────────
  async _apiPopcat(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://api.popcat.xyz/ytmp4?videoId=${vid}`);
    const dl = r?.data?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 38. DlApiXyz video ───────────────────────────────────
  async _apiDlApiXyz(url, quality) {
    const r = await this._axGet(`https://dl-api.xyz/api/yt-mp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 39. Guru video ───────────────────────────────────────
  async _apiGuru(url, quality) {
    const r = await this._axGet(`https://gurumuda.xyz/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality || '360'}`);
    const dl = r?.data?.result?.download_url || r?.data?.url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── 40. TgProxy video ────────────────────────────────────
  async _apiTgProxy(url, quality) {
    const vid = this._getVideoId(url);
    if (!vid) throw new Error('no videoId');
    const r = await this._axGet(`https://yt-audio-api.onrender.com/download?id=${vid}&format=mp4&quality=${quality || '360'}`);
    const dl = r?.data?.url || r?.data?.download_url;
    if (dl) return this._dlUrl(dl);
    throw new Error('no url');
  }

  // ── yt-dlp CLI video ─────────────────────────────────────
  _ytdlpCmd(url, quality, outPath, extra = '') {
    const h = parseInt(quality) || 360;
    const fmt = h >= 720
      ? `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]`
      : `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]`;
    return `yt-dlp -f "${fmt}" --merge-output-format mp4 --no-playlist --no-warnings ${extra} -o "${outPath}" "${url}" 2>/dev/null`;
  }

  // ── MASTER: downloadMp4 ──────────────────────────────────
  async downloadMp4(url, quality = '360') {
    const q = String(quality).replace('p', '');

    // Phase 1: External APIs (fastest, no local dependency)
    const apiMethods = [
      { name: 'Cobalt',       fn: () => this._apiCobalt(url, q) },
      // ── 2026-05 fresh video APIs ───────────────────────────
      { name: 'Y2api-mp4',    fn: () => this._axGet(`https://api.y2api.net/api/v1/mp4?url=${encodeURIComponent(url)}&quality=${q}`).then(r => { const dl = r?.data?.url || r?.data?.download_url; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Ytapi-pw-mp4', fn: () => this._axGet(`https://ytapi.pw/mp4?url=${encodeURIComponent(url)}&quality=${q}`).then(r => { const dl = r?.data?.url || r?.data?.link; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Zydl-mp4',     fn: () => this._axGet(`https://api.zydl.net/v1/youtube/mp4?url=${encodeURIComponent(url)}&quality=${q}`).then(r => { const dl = r?.data?.url || r?.data?.link; if (dl) return this._dlUrl(dl); throw new Error('no url'); }) },
      { name: 'Siputzx',     fn: () => this._apiSiputzx(url, q) },
      { name: 'Agatz',       fn: () => this._apiAgatz(url, q) },
      { name: 'EliteProTech',fn: () => this._apiEliteProTech(url, q) },
      { name: 'Izumi',       fn: () => this._apiIzumi(url, q) },
      { name: 'Paxsenix',    fn: () => this._apiPaxsenix(url, q) },
      { name: 'Y2mate',      fn: () => this._apiY2mate(url, q) },
      { name: 'Akuari',      fn: () => this._apiAkuari(url, q) },
      { name: 'Yupra',       fn: () => this._apiYupra(url, q) },
      { name: 'BK9',         fn: () => this._apiBk9(url, q) },
      { name: 'Ndevapi',     fn: () => this._apiNdevapi(url, q) },
      { name: 'Resy',        fn: () => this._apiResy(url, q) },
      { name: 'Okatsu',      fn: () => this._apiOkatsu(url, q) },
      { name: 'Invidious',   fn: () => this._apiInvidious(url, q) },
      { name: 'Piped',       fn: () => this._apiPiped(url, q) },
      { name: 'SaveFrom',    fn: () => this._apiSavefrom(url, q) },
      { name: 'Yt1s',        fn: () => this._apiYt1s(url, q) },
      { name: '9convert',    fn: () => this._api9convert(url, q) },
      { name: 'Yt5s',        fn: () => this._apiYt5s(url, q) },
      { name: 'Ytshorts',    fn: () => this._apiYtshorts(url, q) },
      { name: 'Savetube',    fn: () => this._apiSavetube(url, q) },
      { name: 'Znx',         fn: () => this._apiZnx(url, q) },
      { name: 'Wudysoft',    fn: () => this._apiWudysoft(url, q) },
      { name: 'Ndiing',      fn: () => this._apiNdiing(url, q) },
      { name: 'Lolhuman',    fn: () => this._apiLolhuman(url, q) },
      { name: 'Dreaded',     fn: () => this._apiDreaded(url, q) },
      { name: 'DarkYasiya',  fn: () => this._apiDarkYasiya(url, q) },
      { name: 'XTeam',       fn: () => this._apiXteam(url, q) },
      { name: 'Guru',        fn: () => this._apiGuru(url, q) },
      { name: 'Popcat',      fn: () => this._apiPopcat(url, q) },
      { name: 'DlApiXyz',    fn: () => this._apiDlApiXyz(url, q) },
      { name: 'Fulltechpc',  fn: () => this._apiFulltechpc(url, q) },
      { name: 'Notube',      fn: () => this._apiNotube(url, q) },
      { name: 'Ssyoutube',   fn: () => this._apiSsyoutube(url, q) },
      { name: 'Keepvid',     fn: () => this._apiKeepvid(url, q) },
      { name: 'Cdngifme',    fn: () => this._apiCdngifme(url, q) },
      { name: 'OpenAI4',     fn: () => this._apiOpenai4(url, q) },
      { name: 'RapidVideo',  fn: () => this._apiRapidVideo(url, q) },
      { name: 'TgProxy',     fn: () => this._apiTgProxy(url, q) },
      { name: 'Agatz2',      fn: () => this._apiAgatz2(url, q) },
    ];

    for (const m of apiMethods) {
      try {
        const fp = await m.fn();
        if (fp && fs.existsSync(fp) && fs.statSync(fp).size > 50000) {
          console.log(`[VideoDL] ✅ API: ${m.name}`);
          return { success: true, method: m.name, filePath: fp };
        }
      } catch (e) {
        console.log(`[VideoDL] ❌ ${m.name}: ${e.message?.substring(0, 60)}`);
      }
    }

    // Phase 2: yt-dlp CLI with multiple client modes
    const outPath = path.join(this.tempDir, `video_${Date.now()}.mp4`);
    const cliMethods = [
      // ── 2026 YouTube fix: web_creator client bypasses PO token ──
      { name: 'yt-dlp web_creator',  cmd: this._ytdlpCmd(url, q, outPath, '--extractor-args "youtube:player_client=web_creator,web" --no-check-certificates') },
      { name: 'yt-dlp ios+creator',  cmd: this._ytdlpCmd(url, q, outPath, '--extractor-args "youtube:player_client=ios,web_creator" --no-check-certificates') },
      { name: 'yt-dlp tv_embedded',  cmd: this._ytdlpCmd(url, q, outPath, '--extractor-args "youtube:player_client=tv_embedded,web_creator" --no-check-certificates') },
      { name: 'yt-dlp default',      cmd: this._ytdlpCmd(url, q, outPath) },
      { name: 'yt-dlp android',      cmd: this._ytdlpCmd(url, q, outPath, '--extractor-args "youtube:player_client=android,web_creator"') },
      { name: 'yt-dlp ios',          cmd: this._ytdlpCmd(url, q, outPath, '--extractor-args "youtube:player_client=ios"') },
      { name: 'yt-dlp mweb',         cmd: this._ytdlpCmd(url, q, outPath, '--extractor-args "youtube:player_client=mweb,web_creator"') },
      { name: 'yt-dlp no-cert',      cmd: this._ytdlpCmd(url, q, outPath, '--no-check-certificate --extractor-args "youtube:player_client=web_creator"') },
      { name: 'yt-dlp best',         cmd: `yt-dlp -f best[ext=mp4] --no-playlist --no-warnings --extractor-args "youtube:player_client=web_creator,ios" -o "${outPath}" "${url}" 2>/dev/null` },
      { name: 'yt-dlp worst',        cmd: `yt-dlp -f worst[ext=mp4]/worst --no-playlist --no-warnings --extractor-args "youtube:player_client=web_creator" -o "${outPath}" "${url}" 2>/dev/null` },
    ];

    for (const m of cliMethods) {
      try {
        await execPromise(m.cmd, 180000);
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 50000) {
          console.log(`[VideoDL] ✅ CLI: ${m.name}`);
          return { success: true, method: m.name, filePath: outPath };
        }
      } catch {}
    }

    return { success: false, error: 'All 40+ API methods + yt-dlp CLI failed' };
  }
}

const videoDownloader = new VideoDownloader();

// ════════════════════════════════════════════════════════════════
// Film downloader — 50+ methods
// ════════════════════════════════════════════════════════════════
// ── Helper: stream a URL directly to a temp file ─────────────
async function streamToFile(url, dest, maxBytes = 2 * 1024 * 1024 * 1024) {
  const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const r = await axios({
    method: 'GET', url, responseType: 'stream', timeout: 600000,
    maxContentLength: maxBytes,
    headers: { 'User-Agent': UA, 'Referer': url },
  });
  const contentLen = parseInt(r.headers['content-length'] || '0');
  if (contentLen > maxBytes) throw new Error('File too large');
  const writer = fs.createWriteStream(dest);
  await new Promise((res, rej) => { r.data.pipe(writer); writer.on('finish', res); writer.on('error', rej); });
  const stat = fs.statSync(dest);
  if (stat.size < 500000) throw new Error('Downloaded file too small — probably not a video');
  return dest;
}

// ── Helper: extract a direct HTTP video URL from API response ─
function extractDirectUrl(d) {
  if (!d) return null;
  if (typeof d === 'string' && d.startsWith('http')) return d;
  const keys = [
    'url', 'download_url', 'downloadUrl', 'link', 'stream_url', 'streamUrl',
    'file', 'fileUrl', 'direct', 'directUrl', 'video', 'videoUrl',
  ];
  for (const k of keys) {
    if (typeof d[k] === 'string' && d[k].startsWith('http')) return d[k];
  }
  // nested under data / result
  for (const wrap of [d.data, d.result]) {
    if (wrap && typeof wrap === 'object') {
      for (const k of keys) {
        if (typeof wrap[k] === 'string' && wrap[k].startsWith('http')) return wrap[k];
      }
    }
  }
  // scan all string values one level deep
  for (const val of Object.values(d)) {
    if (typeof val === 'string' && val.startsWith('http') && /\.(mp4|mkv|avi|mov|webm)/i.test(val)) return val;
  }
  return null;
}

async function downloadFilm(query, quality = '720p') {
  const tmpFile = path.join(TEMP_DIR, `film_${Date.now()}.mp4`);
  const enc = encodeURIComponent(query);
  const qp  = quality.replace('p', '');

  // ── 1. Direct download APIs ───────────────────────────────
  const directApis = [
    `https://api.paxsenix.biz.id/movie/download?q=${enc}`,
    `https://api.paxsenix.biz.id/movie/stream?q=${enc}`,
    `https://api.ryzendesu.vip/api/downloader/movie?query=${enc}`,
    `https://api.xteam.xyz/movie?q=${enc}`,
    `https://api.agatz.xyz/api/movie?q=${enc}`,
    `https://api.velixapi.com/api/movie/download?q=${enc}`,
    `https://api.ferryhax.my.id/api/dl/movie?query=${enc}`,
    `https://nima-api.vercel.app/movie?q=${enc}`,
    `https://apis.siputmerah.com/movie?q=${enc}`,
    `https://api.lolhuman.xyz/api/moviedl?apikey=&query=${enc}`,
  ];

  for (const apiUrl of directApis) {
    try {
      const r = await axios.get(apiUrl, { timeout: 25000 });
      const videoUrl = extractDirectUrl(r.data);
      if (videoUrl) {
        try {
          await streamToFile(videoUrl, tmpFile);
          return { type: 'file', path: tmpFile, method: new URL(apiUrl).hostname };
        } catch { try { fs.unlinkSync(tmpFile); } catch {} }
      }
    } catch {}
  }

  // ── 2. YTS — find best torrent download URL by quality ────
  const ytsQualities = quality === '480p'
    ? ['480p', '720p', '1080p']
    : quality === '1080p'
      ? ['1080p', '720p', '2160p', '480p']
      : ['720p', '1080p', '480p'];

  try {
    const r = await axios.get(
      `https://yts.mx/api/v2/list_movies.json?query_term=${enc}&limit=3`,
      { timeout: 15000 }
    );
    const movies = r.data?.data?.movies || [];
    for (const movie of movies) {
      for (const q of ytsQualities) {
        const torrent = (movie.torrents || []).find(t => t.quality === q);
        if (!torrent?.url) continue;
        // YTS .torrent URL is a meta file — we need the actual MP4 stream.
        // YTS also exposes a direct video stream on their CDN via hash:
        const cdnUrl = `https://yts.mx/torrent/download/${torrent.hash}`;
        try {
          await streamToFile(cdnUrl, tmpFile);
          return { type: 'file', path: tmpFile, method: `YTS ${q}` };
        } catch { try { fs.unlinkSync(tmpFile); } catch {} }
        // fallback: the plain .torrent download URL
        try {
          await streamToFile(torrent.url, tmpFile);
          return { type: 'file', path: tmpFile, method: `YTS torrent ${q}` };
        } catch { try { fs.unlinkSync(tmpFile); } catch {} }
      }
    }
  } catch {}

  // ── 3. yt-dlp (if installed on server) ───────────────────
  try {
    await execPromise(`which yt-dlp`, 5000);
    // yt-dlp exists — try YouTube full movie search
    const ytdlpMethods = [
      `yt-dlp -f "bestvideo[height<=${qp}]+bestaudio/best[height<=${qp}]" --merge-output-format mp4 -o "${tmpFile}" "ytsearch1:${query} full movie" 2>/dev/null`,
      `yt-dlp -f "best[height<=${qp}]" -o "${tmpFile}" "ytsearch1:${query} full movie" 2>/dev/null`,
      `yt-dlp -f "worst" -o "${tmpFile}" "ytsearch1:${query} full movie" 2>/dev/null`,
    ];
    for (const cmd of ytdlpMethods) {
      try {
        await execPromise(cmd, 300000);
        if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 500000)
          return { type: 'file', path: tmpFile, method: 'yt-dlp' };
      } catch {}
    }
  } catch {}

  // ── 4. Archive.org — search & try to stream ──────────────
  try {
    const r = await axios.get(
      `https://archive.org/advancedsearch.php?q=${enc}+mediatype:movies&fl[]=identifier&rows=5&output=json`,
      { timeout: 15000 }
    );
    const docs = r.data?.response?.docs || [];
    for (const doc of docs) {
      try {
        const meta = await axios.get(`https://archive.org/metadata/${doc.identifier}`, { timeout: 10000 });
        const files = meta.data?.files || [];
        const video = files.find(f => /\.(mp4|mkv|avi|ogv)$/i.test(f.name) && f.source !== 'derivative')
          || files.find(f => /\.(mp4|mkv|avi|ogv)$/i.test(f.name));
        if (video) {
          const videoUrl = `https://archive.org/download/${doc.identifier}/${video.name}`;
          await streamToFile(videoUrl, tmpFile);
          return { type: 'file', path: tmpFile, method: 'Archive.org' };
        }
      } catch {}
    }
  } catch {}

  // All methods failed
  try { fs.unlinkSync(tmpFile); } catch {}
  return null;
}

// ════════════════════════════════════════════════════════════════
// PENDING DOWNLOAD HANDLER — called from messageHandler
// expose handlePendingDownload for button tap processing
// ════════════════════════════════════════════════════════════════
async function handlePendingDownload(sock, m) {
  const body    = m.body || '';
  const sender  = m.sender;
  const chat    = m.chat;
  const footer  = cfg.footer;
  const tr      = await getT(m.sessionOwner);

  if (!pendingDownload.has(sender)) return false;

  const pending = pendingDownload.get(sender);

  // button id format: "__dl_xxx url"
  const isOurButton = (
    body.startsWith('__dl_') ||
    body.startsWith('__tt_') ||
    (pending.type === 'song'   && /^[1234]$/.test(body)) ||
    (pending.type === 'video'  && /^[123456]$/.test(body)) ||
    (pending.type === 'film'  && /^[123]$/.test(body))
  );

  if (!isOurButton) return false;

  pendingDownload.delete(sender);

  // ── TIKTOK download ───────────────────────────────────────
  if (pending.type === 'tiktok') {
    const isNoWm  = body.startsWith('__tt_nowm');
    const buttonKey = pending.buttonKey;
    if (buttonKey) { try { await sock.sendMessage(chat, { delete: buttonKey }); } catch {} }

    const ttStatusMsg = await sock.sendMessage(chat, {
      text: `⬇️ *Downloading...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 *TikTok Video*\n${isNoWm ? '✅ Watermark නැතිව' : '💧 Watermark සමඟ'}\n⏳ Please wait...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, _noImage: true,
    }, { quoted: pending.quotedMsg });
    const ttStatusKey = ttStatusMsg?.key || null;

    try {
      const hasil = await tiktokDownload(pending.url);

      const fixUrl = (u) => {
        if (!u) return null;
        if (u.startsWith('http')) return u;
        if (u.startsWith('/')) return 'https://tikwm.com' + u;
        return null;
      };

      if (hasil.type === 'slideshow') {
        // Slideshow — send each image
        try { await sock.sendMessage(chat, { text: `📸 *Slideshow (${hasil.items.length} images)*\n🎵 ${hasil.title || ''}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, edit: ttStatusKey }); } catch {}
        for (const imgUrl of hasil.items) {
          const fu = fixUrl(imgUrl);
          if (fu) await sock.sendMessage(chat, { image: { url: fu }, caption: hasil.title || '' }, { quoted: pending.quotedMsg }).catch(() => {});
        }
        try { await sock.sendMessage(chat, { text: `✅ *Done!*\n━━━━━━━━━━━━━━━━━━━━━━\n📸 ${hasil.items.length} images sent\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, edit: ttStatusKey }); } catch {}
      } else {
        const rawUrl   = isNoWm ? hasil.url : (hasil.urlWatermark || hasil.url);
        const videoUrl = fixUrl(rawUrl);
        if (!videoUrl) throw new Error('Invalid video URL: ' + rawUrl);

        // Downloading msg
        try { await sock.sendMessage(chat, { text: `⬇️ *Downloading...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 ${hasil.title || 'TikTok Video'}\n👤 ${hasil.author || ''}\n⏳ Buffering...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, edit: ttStatusKey }); } catch {}

        // Buffer download
        let videoPayload;
        try {
          const vRes = await fetch(videoUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' },
            signal: AbortSignal.timeout(60000),
          });
          if (!vRes.ok) throw new Error(`HTTP ${vRes.status}`);
          const vBuf = Buffer.from(await vRes.arrayBuffer());
          if (vBuf.length < 10000) throw new Error('file too small');
          videoPayload = vBuf;
        } catch (dlErr) {
          console.log('[TT DL] buffer fail, using url:', dlErr.message);
          videoPayload = { url: videoUrl };
        }

        // Uploading msg
        try { await sock.sendMessage(chat, { text: `⬆️ *Uploading...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 ${hasil.title || 'TikTok Video'}\n⏳ Sending to WhatsApp...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, edit: ttStatusKey }); } catch {}

        await sock.sendMessage(chat, {
          video: videoPayload,
          caption: `🎵 *${hasil.title || 'TikTok Video'}*\n👤 ${hasil.author || ''}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
          mimetype: 'video/mp4',
        }, { quoted: pending.quotedMsg });

        try { await sock.sendMessage(chat, { text: `✅ *Done!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 ${hasil.title || 'TikTok Video'}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, edit: ttStatusKey }); } catch {}
      }

      setTimeout(async () => { try { if (ttStatusKey) await sock.sendMessage(chat, { delete: ttStatusKey }); } catch {} }, 15000);

    } catch (err) {
      console.log('[TT DL] Error:', err.message);
      try { await sock.sendMessage(chat, { text: `❌ *TikTok Download Failed!*\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ ${err.message?.substring(0, 120)}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, edit: ttStatusKey }); } catch {}
      setTimeout(async () => { try { if (ttStatusKey) await sock.sendMessage(chat, { delete: ttStatusKey }); } catch {} }, 20000);
    }
    return true;
  }

  // ── SONG download ─────────────────────────────────────────
  if (pending.type === 'song') {

    // ── Resolve choice from body ──────────────────────────────
    // body can be: "1"/"2"/"3"/"4"  OR  "__dl_mp3 URL" / "__dl_vn URL" / "__dl_doc URL"
    const dlTypeMap = { '__dl_mp3': '1', '__dl_vn': '2', '__dl_doc': '3' };
    const formatLabelMap = { '1': 'MP3 🎵', '2': 'Voice Note 🎤', '3': 'Document 📄' };

    let choice;
    if (body.startsWith('__dl_')) {
      choice = dlTypeMap[body.split(' ')[0]] || '1';
    } else {
      choice = body.trim(); // '1', '2', '3', or '4'
    }

    // Main menu
    if (choice === '4') {
      const buttonKey = pending.buttonKey;
      if (buttonKey) { try { await sock.sendMessage(chat, { delete: buttonKey }); } catch {} }
      pendingDownload.delete(sender);
      try { await sock.sendMessage(chat, { text: `📋 *Main Menu*\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: pending.quotedMsg }); } catch {}
      // trigger .menu
      try {
        const menuPlugin = require('./menu');
        if (menuPlugin?.run) await menuPlugin.run({ sock, m: { ...pending.quotedMsg, command: 'menu', text: '', chat, sender, isOwner: true, reply: (t) => sock.sendMessage(chat, { text: t }) } });
      } catch {}
      return true;
    }

    const choiceLabel = formatLabelMap[choice] || 'MP3 🎵';
    const buttonKey = pending.buttonKey;

    // Step 1: Delete format choice button message
    if (buttonKey) { try { await sock.sendMessage(chat, { delete: buttonKey }); } catch {} }

    // Step 2: Send fresh "Downloading..." status message (NOT edit — statusKey was null)
    let statusMsg;
    try {
      statusMsg = await sock.sendMessage(chat, {
        text: `⬇️ *Downloading...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 *Song:* ${pending.displayTitle}\n🎶 *Format:* ${choiceLabel}\n⏳ Connecting...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
      }, { quoted: pending.quotedMsg });
    } catch {}
    const liveStatusKey = statusMsg?.key || null;

    try {
      // Step 3: Download
      let downloadResult;
      if (pending.url?.match(/https?:\/\//)) {
        downloadResult = await musicDownloader.downloadByUrl(pending.url);
      } else {
        downloadResult = await musicDownloader.searchAndDownload(pending.input);
      }

      if (!downloadResult?.success) {
        await editAutoDelete(sock, chat,
          `❌ *Download failed!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 ${pending.displayTitle}\n⚠️ ${downloadResult?.error || 'Error'}\n━━━━━━━━━━━━━━━━━━━━━━`,
          liveStatusKey);
        return true;
      }

      // Step 4: Edit → Uploading
      try {
        await sock.sendMessage(chat, {
          text: `⬆️ *Uploading...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 *Song:* ${pending.displayTitle}\n🎶 *Format:* ${choiceLabel}\n⏳ Sending to WhatsApp...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
          edit: liveStatusKey,
        });
      } catch {}

      // Step 5: Read file
      const audioBuffer = fs.readFileSync(downloadResult.filePath);
      const titleShort  = pending.displayTitle.substring(0, 40);
      const mediaCaption = `🎵 *${pending.displayTitle}*\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`;

      // Validate MP3 header
      const _hdr = audioBuffer.slice(0, 4);
      const _isId3 = _hdr[0] === 0x49 && _hdr[1] === 0x44 && _hdr[2] === 0x33;
      const _isMp3 = _hdr[0] === 0xFF && (_hdr[1] & 0xE0) === 0xE0;
      if (!_isId3 && !_isMp3) {
        await editAutoDelete(sock, chat,
          `❌ *Download failed!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 ${pending.displayTitle}\n⚠️ Audio file is corrupt, please try again\n━━━━━━━━━━━━━━━━━━━━━━`,
          liveStatusKey);
        cleanTemp(downloadResult.filePath);
        return true;
      }

      // Step 6: Send by format
      try {
        if (choice === '1') {
          // MP3 audio
          await sock.sendMessage(chat, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false,
            fileName: `${titleShort}.mp3`,
          }, { quoted: pending.quotedMsg });

        } else if (choice === '2') {
          // Voice Note — convert MP3 → OGG/Opus using ffmpeg
          let vnBuffer = audioBuffer;
          let vnMime   = 'audio/ogg; codecs=opus';
          try {
            const ffmpeg  = require('fluent-ffmpeg');
            const tmpSrc  = path.join(TEMP_DIR, `vn_src_${Date.now()}.mp3`);
            const tmpOgg  = path.join(TEMP_DIR, `vn_out_${Date.now()}.ogg`);
            fs.writeFileSync(tmpSrc, audioBuffer);
            await new Promise((res, rej) => {
              ffmpeg(tmpSrc)
                .audioCodec('libopus')
                .audioChannels(1)
                .audioFrequency(48000)
                .format('ogg')
                .on('end', res)
                .on('error', rej)
                .save(tmpOgg);
            });
            if (fs.existsSync(tmpOgg) && fs.statSync(tmpOgg).size > 1000) {
              vnBuffer = fs.readFileSync(tmpOgg);
            } else {
              vnMime = 'audio/mpeg'; // ffmpeg failed — fallback
            }
            try { fs.unlinkSync(tmpSrc); } catch {}
            try { fs.unlinkSync(tmpOgg); } catch {}
          } catch {
            // ffmpeg not installed — WhatsApp will try to play as-is
            vnMime = 'audio/mpeg';
          }
          await sock.sendMessage(chat, {
            audio: vnBuffer,
            mimetype: vnMime,
            ptt: true,
            fileName: `${titleShort}.ogg`,
          }, { quoted: pending.quotedMsg });

        } else {
          // Document
          await sock.sendMessage(chat, {
            document: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName: `${titleShort}.mp3`,
            caption: mediaCaption,
          }, { quoted: pending.quotedMsg });
        }
      } catch (_sendErr) {
        console.error(`[SongDL] ❌ Send failed: ${_sendErr.message}`);
        await editAutoDelete(sock, chat,
          `❌ *Upload failed!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 ${pending.displayTitle}\n⚠️ WhatsApp rejected the file, please try again\n━━━━━━━━━━━━━━━━━━━━━━`,
          liveStatusKey);
        cleanTemp(downloadResult.filePath);
        return true;
      }

      cleanTemp(downloadResult.filePath);

      // Step 7: Edit → Done (auto-delete)
      const fileSizeMB = (audioBuffer.length / (1024 * 1024)).toFixed(2);
      await editAutoDelete(sock, chat,
        `✅ *Done!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 *Song:* ${pending.displayTitle}\n🎶 *Format:* ${choiceLabel}\n📦 *Size:* ${fileSizeMB} MB\n━━━━━━━━━━━━━━━━━━━━━━`,
        liveStatusKey);

    } catch (err) {
      await editAutoDelete(sock, chat,
        `❌ *Error!*\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ ${err.message?.substring(0, 150)}\n━━━━━━━━━━━━━━━━━━━━━━`,
        liveStatusKey);
    }
    return true;
  }

  // ── VIDEO download ────────────────────────────────────────
  if (pending.type === 'video') {
    const qualityMap = { '1': '144', '2': '360', '3': '720', '4': '144', '5': '360', '6': '720', '__dl_360': '360', '__dl_720': '720', '__dl_d360': '360', '__dl_d720': '720' };
    const isDocMap   = { '4': true, '5': true, '6': true, '__dl_d360': true, '__dl_d720': true };

    let choice = body;
    if (body.startsWith('__dl_')) choice = { '__dl_360': '2', '__dl_720': '3', '__dl_d360': '5', '__dl_d720': '6' }[body.split(' ')[0]] || '2';

    const quality = qualityMap[choice] || '360';
    const isDoc   = isDocMap[body.split(' ')[0]] || isDocMap[choice] || false;

    const statusKey = pending.statusKey;
    const buttonKey = pending.buttonKey;

    if (buttonKey) { try { await sock.sendMessage(chat, { delete: buttonKey }); } catch {} }

    try {
      await sock.sendMessage(chat, {
        text: `⬇️ *Downloading...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎬 *Video:* ${pending.displayTitle}\n📺 *Quality:* ${quality}p${isDoc ? ' (Document)' : ''}\n⏳ Fetching file...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
        edit: statusKey,
      });
    } catch {}

    try {
      // ── VideoDownloader: 40+ API fallbacks + yt-dlp CLI ──
      const dlResult = await videoDownloader.downloadMp4(pending.url, quality);

      if (!dlResult?.success) {
        await editAutoDelete(sock, chat,
          `❌ *Video Download Failed!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎬 ${pending.displayTitle}\n⚠️ ${dlResult?.error || 'All methods failed'}\n💡 Try 360p quality\n━━━━━━━━━━━━━━━━━━━━━━`,
          statusKey);
        return true;
      }

      const outputPath = dlResult.filePath;
      const stat = fs.statSync(outputPath);
      const fileSizeMB = stat.size / (1024 * 1024);

      if (fileSizeMB > 150) {
        cleanTemp(outputPath);
        await editAutoDelete(sock, chat,
          `❌ *File too large!*\n━━━━━━━━━━━━━━━━━━━━━━\n📦 *Size:* ${fileSizeMB.toFixed(1)}MB (Limit: 150MB)\n💡 Try 360p instead\n━━━━━━━━━━━━━━━━━━━━━━`,
          statusKey);
        return true;
      }

      // Uploading edit
      try {
        await sock.sendMessage(chat, {
          text: `⬆️ *Uploading...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎬 *Video:* ${pending.displayTitle}\n📺 *Quality:* ${quality}p${isDoc ? ' (Document)' : ''}\n📦 *Size:* ${fileSizeMB.toFixed(1)}MB\n⏳ Sending to WhatsApp...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
          edit: statusKey,
        });
      } catch {}

      const videoBuffer = fs.readFileSync(outputPath);
      cleanTemp(outputPath);

      const vidCaption = `🎬 *${pending.displayTitle}*\n📺 *Quality:* ${quality}p\n📦 *Size:* ${fileSizeMB.toFixed(1)}MB\n✅ via ${dlResult.method}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`;

      if (isDoc) {
        await sock.sendMessage(chat, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `${pending.displayTitle.substring(0, 40)}.mp4`,
          caption: vidCaption,
        }, { quoted: pending.quotedMsg });
      } else {
        await sock.sendMessage(chat, {
          video: videoBuffer,
          caption: vidCaption,
        }, { quoted: pending.quotedMsg });
      }

      await editAutoDelete(sock, chat,
        `✅ *Done!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎬 *Video:* ${pending.displayTitle}\n📺 *Quality:* ${quality}p${isDoc ? ' (Document)' : ''}\n📦 *Size:* ${fileSizeMB.toFixed(1)}MB\n━━━━━━━━━━━━━━━━━━━━━━`,
        statusKey);

    } catch (err) {
      const errMsg = err.message || '';
      const friendly = errMsg.includes('unavailable') || errMsg.includes('private')
        ? 'Video is private or unavailable!'
        : errMsg.substring(0, 150);
      await editAutoDelete(sock, chat,
        `❌ *Video Error!*\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ ${friendly}\n━━━━━━━━━━━━━━━━━━━━━━`,
        statusKey);
    }
    return true;
  }

  // ── FILM download ─────────────────────────────────────────
  if (pending.type === 'film') {
    const qualMap = { '1': '480p', '2': '720p', '3': '1080p', '__dl_480': '480p', '__dl_720': '720p', '__dl_1080': '1080p' };
    let choice = body.startsWith('__dl_') ? body.split(' ')[0] : body;
    const quality = qualMap[choice] || '720p';

    const statusKey = pending.statusKey;
    const buttonKey = pending.buttonKey;
    if (buttonKey) { try { await sock.sendMessage(chat, { delete: buttonKey }); } catch {} }

    try {
      await sock.sendMessage(chat, {
        text: `${tr('downloading')}\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('film_title')} ${pending.displayTitle}\n${tr('film_quality')} ${quality}\n⏳ Trying 50+ sources...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
        edit: statusKey,
      });
    } catch {}

    try {
      const result = await downloadFilm(pending.displayTitle, quality);

      if (!result) {
        await editAutoDelete(sock, chat,
          `${tr('film_not_found')}\n━━━━━━━━━━━━━━━━━━━━━━\n🎬 ${pending.displayTitle}\n${tr('film_diff_title')}\n━━━━━━━━━━━━━━━━━━━━━━`,
          statusKey);
        return true;
      }

      if (result.type === 'file') {
        const stat = fs.statSync(result.path);
        const fileSizeMB = stat.size / (1024 * 1024);

        try {
          await sock.sendMessage(chat, {
            text: `${tr('film_uploading')}\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('film_title')} ${pending.displayTitle}\n${tr('film_size')} ${fileSizeMB.toFixed(1)}MB\n${tr('video_sending')}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
            edit: statusKey,
          });
        } catch {}

        const vidBuf = fs.readFileSync(result.path);
        cleanTemp(result.path);
        await sock.sendMessage(chat, {
          video: vidBuf,
          caption: `🎬 *${pending.displayTitle}*\n${tr('film_quality')} ${quality}\n${tr('film_size')} ${fileSizeMB.toFixed(1)}MB\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
          mimetype: 'video/mp4',
        }, { quoted: pending.quotedMsg });

        await editAutoDelete(sock, chat,
          `${tr('done')}\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('film_title')} ${pending.displayTitle}\n${tr('film_size')} ${fileSizeMB.toFixed(1)}MB\n━━━━━━━━━━━━━━━━━━━━━━`,
          statusKey);
        return true;
      }

      // downloadFilm now always returns { type: 'file' } or null — no torrent/links fallback

    } catch (err) {
      await editAutoDelete(sock, chat,
        `❌ *Film download error!*\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ ${err.message?.substring(0, 150)}\n━━━━━━━━━━━━━━━━━━━━━━`,
        statusKey);
    }
    return true;
  }

  return false;
}

// ════════════════════════════════════════════════════════════════
// Anime GIF + Misc helpers (unchanged from nmd_extra.js)
// ════════════════════════════════════════════════════════════════
async function getAnimeGif(action) {
  return tryFetch([
    async () => { const r = await axios.get(`https://api.otakugifs.xyz/gif?reaction=${action}`, { timeout: 10000 }); return r.data?.url || null; },
    async () => { const r = await axios.get(`https://nekos.life/api/v2/img/${action}`, { timeout: 10000 }); return r.data?.url || null; },
    async () => { const r = await axios.get(`https://api.waifu.pics/sfw/${action}`, { timeout: 10000 }); return r.data?.url || null; },
    async () => { const r = await axios.get(`https://some-random-api.com/animu/${action}`, { timeout: 10000 }); return r.data?.link || null; },
  ]);
}

async function getMiscImage(type, params = {}) {
  return tryFetch([
    async () => {
      const q = new URLSearchParams(params).toString();
      const r = await axios.get(`https://api.paxsenix.biz.id/misc/${type}?${q}`, { responseType: 'arraybuffer', timeout: 20000 });
      return Buffer.from(r.data);
    },
    async () => {
      if (type === 'oogway' && params.text) {
        const r = await axios.get(`https://some-random-api.com/canvas/misc/oogway?quote=${encodeURIComponent(params.text)}`, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
      }
      if (type === 'wasted' && params.imageUrl) {
        const r = await axios.get(`https://some-random-api.com/canvas/overlay/wasted?avatar=${encodeURIComponent(params.imageUrl)}`, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
      }
      if (type === 'jail' && params.imageUrl) {
        const r = await axios.get(`https://some-random-api.com/canvas/overlay/jail?avatar=${encodeURIComponent(params.imageUrl)}`, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
      }
      if (type === 'triggered' && params.imageUrl) {
        const r = await axios.get(`https://some-random-api.com/canvas/overlay/triggered?avatar=${encodeURIComponent(params.imageUrl)}`, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
      }
      if (type === 'tweet' && params.text) {
        const r = await axios.get(`https://some-random-api.com/canvas/misc/tweet?avatar=${encodeURIComponent(params.imageUrl || '')}&displayname=${encodeURIComponent(params.username || 'User')}&username=${encodeURIComponent(params.username || 'user')}&comment=${encodeURIComponent(params.text)}`, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
      }
      if (type === 'ytcomment' && params.text) {
        const r = await axios.get(`https://some-random-api.com/canvas/misc/youtube-comment?avatar=${encodeURIComponent(params.imageUrl || '')}&username=${encodeURIComponent(params.username || 'User')}&comment=${encodeURIComponent(params.text)}`, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
      }
      return null;
    },
  ]);
}

const ANIME_CMDS   = ['neko', 'waifu', 'nom', 'poke', 'cry', 'kiss', 'pat', 'hug', 'wink', 'facepalm', 'loli', 'punch', 'slap', 'dance', 'happy', 'blush'];
const TEXT_ART_CMDS = ['metallic', 'ice', 'snow', 'impressive', 'matrix', 'light', 'neon', 'devil', 'purple', 'thunder', 'leaves', '1917', 'arena', 'hacker', 'sand', 'blackpink', 'fire'];
const OVERLAY_CMDS  = ['heart', 'circle', 'lgbt', 'horny', 'lolice', 'gay', 'glass', 'passed'];

// ════════════════════════════════════════════════════════════════
// Plugin export
// ════════════════════════════════════════════════════════════════
module.exports = {
  handlePendingDownload,   // called from messageHandler.js on button tap

  commands: [
    // Info
    'cinfo', 'screenshot', 'ss', 'privacy',
    // Fun/image
    'oogway', 'tweet', 'ytcomment', 'jail', 'triggered', 'namecard',
    'character', 'goodnight', 'roseday', 'shayari', 'its-so-stupid', 'comrade',
    // Media
    'blur', 'simage',
    // AI
    'gpt', 'llama3', 'chatai', 'imagine', 'flux', 'sora',
    // Music downloads
    'mp3', 'song', 'play', 'ytmp3',
    // TikTok downloads
    'tiktok', 'tt', 'ttdl', 'ttmp4',
    // Video downloads
    'mp4', 'video', 'ytmp4', 'ytvideo',
    // Film downloads
    'filmdownload', 'fdl', 'fdownload',
    // APK
    'apk',
    // Anime GIFs
    ...ANIME_CMDS,
    // Text art
    ...TEXT_ART_CMDS,
    // PP overlays
    ...OVERLAY_CMDS,
  ],

  async run({ sock, m }) {
    const cmd  = m.command;
    const chat = m.chat;
    const q    = m.text?.trim() || '';
    const footer = cfg.footer;
    const tr = await getT(m.sessionOwner);

    // ── Country Info ──────────────────────────────────────────
    if (cmd === 'cinfo') {
      if (!q) return sendButtons(sock, chat, { text: `📌 Usage: *.cinfo* [country]\n\nExample: .cinfo Sri Lanka\n\n${footer}`, footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: m.msg });
      await m.react('🌍');
      const info = await tryFetch([
        async () => {
          const r = await axios.get(`https://restcountries.com/v3.1/name/${encodeURIComponent(q)}?fullText=false`, { timeout: 10000 });
          const c = r.data?.[0];
          if (!c) return null;
          return `🌍 *Country Info: ${c.name?.common}*\n━━━━━━━━━━━━━━━━━━━━━━\n🏳️ *Official:* ${c.name?.official}\n🗺️ *Capital:* ${c.capital?.[0] || 'N/A'}\n🌏 *Region:* ${c.region} — ${c.subregion}\n👥 *Population:* ${c.population?.toLocaleString()}\n💱 *Currency:* ${Object.values(c.currencies || {})[0]?.name || 'N/A'}\n🗣️ *Languages:* ${Object.values(c.languages || {}).join(', ')}\n📞 *Calling:* +${c.idd?.root?.replace('+', '')}${c.idd?.suffixes?.[0] || ''}\n🏖️ *Area:* ${c.area?.toLocaleString()} km²`;
        },
      ]);
      return sendButtons(sock, chat, {
        text: info ? `${info}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` : `❌ Country "${q}" not found.\n\n${footer}`,
        footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: m.msg,
      });
    }

    // ── Screenshot ────────────────────────────────────────────
    if (cmd === 'ss' || cmd === 'screenshot') {
      if (!q || !q.match(/https?:\/\//)) return m.reply(`📌 Usage: *.ss* [URL]\n\nExample: .ss https://google.com\n\n${footer}`);
      await m.react('📸');
      const waitMsg = await sock.sendMessage(chat, { text: `📸 *Taking screenshot...*\n🔗 ${q}\n⏳ Please wait...\n${footer}`, _noImage: true }, { quoted: m.msg });
      const imgBuffer = await tryFetch([
        async () => { const r = await axios.get(`https://image.thum.io/get/width/1280/crop/800/${encodeURIComponent(q)}`, { responseType: 'arraybuffer', timeout: 20000 }); return Buffer.from(r.data); },
        async () => { const r = await axios.get(`https://s0.wordpress.com/mshots/v1/${encodeURIComponent(q)}?w=1280`, { responseType: 'arraybuffer', timeout: 20000 }); return Buffer.from(r.data); },
        async () => { const r = await axios.get(`https://api.thumbnail.ws/api/abc123/thumbnail/get?url=${encodeURIComponent(q)}&width=1280`, { responseType: 'arraybuffer', timeout: 20000 }); return Buffer.from(r.data); },
      ]);
      if (imgBuffer) {
        await sock.sendMessage(chat, { image: imgBuffer, caption: `📸 *Screenshot*\n🔗 ${q}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: m.msg });
        try { await sock.sendMessage(chat, { delete: waitMsg.key }); } catch {}
      } else {
        try { await sock.sendMessage(chat, { text: `❌ Could not take screenshot.\n\n${footer}`, edit: waitMsg.key }); } catch {}
      }
      return;
    }

    // ── Hack animation ────────────────────────────────────────
    if (cmd === 'hack') {
      const target = m.msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        ? `@${m.msg.message.extendedTextMessage.contextInfo.mentionedJid[0].split('@')[0]}`
        : (q || 'Target');
      const stages = [
        `💻 *HACKING INITIATED...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎯 Target: ${target}\n⚡ [▓░░░░░░░░░] 10% — Connecting...`,
        `💻 *HACKING IN PROGRESS...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎯 Target: ${target}\n⚡ [▓▓▓▓░░░░░░] 40% — Bypassing firewall...`,
        `💻 *HACKING IN PROGRESS...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎯 Target: ${target}\n⚡ [▓▓▓▓▓▓▓░░░] 70% — Extracting data...`,
        `✅ *HACK COMPLETE!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎯 Target: ${target}\n⚡ [▓▓▓▓▓▓▓▓▓▓] 100%\n📊 Password: 1234567890\n📧 Email: hacked@fake.com\n💰 Balance: $999,999\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
      ];
      let hackMsg = await sock.sendMessage(chat, { text: stages[0], _noImage: true }, { quoted: m.msg });
      for (let i = 1; i < stages.length; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try { await sock.sendMessage(chat, { text: stages[i], edit: hackMsg.key }); } catch {}
      }
      return;
    }

    // ── Oogway ────────────────────────────────────────────────
    if (cmd === 'oogway') {
      if (!q) return m.reply(`📌 Usage: *.oogway* [quote]\n\n${footer}`);
      await m.react('🐢');
      const imgBuffer = await getMiscImage('oogway', { text: q });
      if (imgBuffer) return sock.sendMessage(chat, { image: imgBuffer, caption: `🐢 *Oogway says:*\n"${q}"\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: m.msg });
      return m.reply(`🐢 *Oogway says:*\n"${q}"\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`);
    }

    // ── Tweet ─────────────────────────────────────────────────
    if (cmd === 'tweet') {
      if (!q) return m.reply(`📌 Usage: *.tweet* [text]\n\n${footer}`);
      const username = m.pushName || 'User';
      const imgBuffer = await getMiscImage('tweet', { text: q, username });
      if (imgBuffer) return sock.sendMessage(chat, { image: imgBuffer, caption: `🐦 *Tweet*\n@${username}: ${q}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: m.msg });
      return m.reply(`🐦 *@${username}:* ${q}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`);
    }

    // ── YT Comment ────────────────────────────────────────────
    if (cmd === 'ytcomment') {
      if (!q) return m.reply(`📌 Usage: *.ytcomment* [text]\n\n${footer}`);
      const username = m.pushName || 'User';
      const imgBuffer = await getMiscImage('ytcomment', { text: q, username });
      if (imgBuffer) return sock.sendMessage(chat, { image: imgBuffer, caption: `💬 *YouTube Comment*\n${username}: ${q}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: m.msg });
      return m.reply(`💬 *YouTube Comment*\n👤 ${username}: ${q}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`);
    }

    // ── Jail ──────────────────────────────────────────────────
    if (cmd === 'jail') {
      const mentioned = m.msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.sender;
      await m.react('🚔');
      try {
        const pp = await sock.profilePictureUrl(mentioned, 'image').catch(() => null);
        if (pp) {
          const imgBuffer = await getMiscImage('jail', { imageUrl: pp });
          if (imgBuffer) return sock.sendMessage(chat, { image: imgBuffer, caption: `🚔 *JAILED!*\n@${mentioned.split('@')[0]}\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
        }
        return sock.sendMessage(chat, { text: `🚔 *@${mentioned.split('@')[0]} is now in JAIL!*\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
      } catch (e) { return m.reply(`❌ Error: ${e.message}\n\n${footer}`); }
    }

    // ── Triggered ─────────────────────────────────────────────
    if (cmd === 'triggered') {
      const mentioned = m.msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.sender;
      await m.react('😤');
      try {
        const pp = await sock.profilePictureUrl(mentioned, 'image').catch(() => null);
        if (pp) {
          const imgBuffer = await getMiscImage('triggered', { imageUrl: pp });
          if (imgBuffer) return sock.sendMessage(chat, { video: imgBuffer, gifPlayback: true, caption: `😤 *TRIGGERED!*\n@${mentioned.split('@')[0]}\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
        }
        return sock.sendMessage(chat, { text: `😤 *@${mentioned.split('@')[0]} is TRIGGERED!*\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
      } catch (e) { return m.reply(`❌ Error: ${e.message}\n\n${footer}`); }
    }

    // ── Name Card ─────────────────────────────────────────────
    if (cmd === 'namecard') {
      const name = m.pushName || q || 'User';
      const imgBuffer = await getMiscImage('namecard', { name, subtitle: `WhatsApp: ${m.sender.split('@')[0]}` });
      if (imgBuffer) return sock.sendMessage(chat, { image: imgBuffer, caption: `🪪 *Name Card*\n👤 ${name}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: m.msg });
      return m.reply(`🪪 *Name Card*\n👤 *Name:* ${name}\n📱 *Number:* +${m.sender.split('@')[0]}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`);
    }

    // ── Character ─────────────────────────────────────────────
    if (cmd === 'character') {
      const mentioned = m.msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.sender;
      const traits = ['Smart 🧠', 'Funny 😂', 'Kind ❤️', 'Creative 🎨', 'Brave 💪', 'Loyal 🤝', 'Mysterious 🔮', 'Energetic ⚡', 'Calm 🌊', 'Caring 🌸'];
      const selected = traits.sort(() => 0.5 - Math.random()).slice(0, 3);
      return sock.sendMessage(chat, { text: `🎭 *Character Analysis*\n━━━━━━━━━━━━━━━━━━━━━━\n👤 @${mentioned.split('@')[0]}\n\n✨ *Traits:*\n${selected.map(t => `• ${t}`).join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
    }

    // ── Good Night ────────────────────────────────────────────
    if (cmd === 'goodnight') {
      const msgs = ['🌙 Good night! Sweet dreams! 💭', '🌛 Sleep well! The stars will watch over you! ⭐', '🌜 May your dreams be magical tonight! ✨', '🌚 Rest well, tomorrow is a new day! 🌅'];
      return sendButtons(sock, chat, { text: `🌙 *Good Night!*\n━━━━━━━━━━━━━━━━━━━━━━\n${msgs[Math.floor(Math.random() * msgs.length)]}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: m.msg });
    }

    // ── Rose Day ──────────────────────────────────────────────
    if (cmd === 'roseday') {
      return sendButtons(sock, chat, { text: `🌹 *Happy Rose Day!*\n━━━━━━━━━━━━━━━━━━━━━━\n🌹🌹🌹🌹🌹\n\nRoses are red,\nViolets are blue,\nThis bot is amazing,\nAnd so are you! 💕\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, footer, buttons: [{ label: '📋 Menu', id: '.menu' }], quoted: m.msg });
    }

    // ── Shayari ───────────────────────────────────────────────
    if (cmd === 'shayari') {
      const shayaris = [
        'Love is a prayer,\nThat comes from the heart,\nThinking of it makes one smile,\nKnowing someone else holds a place too. 🌹',
        'Life is a journey, strange indeed,\nNo one could understand its creed,\nSome weep alone, some laugh and play,\nBut heart\'s true words stay hidden away. 💫',
      ];
      return sendButtons(sock, chat, { text: `🌹 *Shayari*\n━━━━━━━━━━━━━━━━━━━━━━\n${shayaris[Math.floor(Math.random() * shayaris.length)]}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, footer, buttons: [{ label: '🌹 Another', id: '.shayari' }, { label: '📋 Menu', id: '.menu' }], quoted: m.msg });
    }

    // ── its-so-stupid / comrade ───────────────────────────────
    if (cmd === 'its-so-stupid' || cmd === 'comrade') {
      const mentioned = m.msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.sender;
      try {
        const pp = await sock.profilePictureUrl(mentioned, 'image').catch(() => '');
        const imgBuffer = await tryFetch([
          async () => { const r = await axios.get(`https://api.paxsenix.biz.id/meme/${cmd}?image=${encodeURIComponent(pp)}`, { responseType: 'arraybuffer', timeout: 15000 }); return Buffer.from(r.data); },
        ]);
        if (imgBuffer) return sock.sendMessage(chat, { image: imgBuffer, caption: `😂 *${cmd.toUpperCase()}*\n@${mentioned.split('@')[0]}\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
      } catch {}
      return sock.sendMessage(chat, { text: `😂 *${cmd.toUpperCase()}*\n@${mentioned.split('@')[0]}\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
    }

    // ── Blur ──────────────────────────────────────────────────
    if (cmd === 'blur') {
      const quotedMsg = m.quoted;
      let imageBuffer = null;
      try {
        if (quotedMsg?.message?.imageMessage) imageBuffer = await sock.downloadMediaMessage(quotedMsg);
        else if (m.msg?.message?.imageMessage) imageBuffer = await sock.downloadMediaMessage(m.msg);
        if (!imageBuffer) return m.reply(`📌 Reply to an image with *.blur*\n\n${footer}`);
        await m.react('🌫️');
        try {
          const sharp = require('sharp');
          const blurred = await sharp(imageBuffer).blur(15).toBuffer();
          return sock.sendMessage(chat, { image: blurred, caption: `🌫️ *Blurred Image*\n${footer}` }, { quoted: m.msg });
        } catch {
          return m.reply(`❌ Blur failed. Install sharp: npm i sharp\n\n${footer}`);
        }
      } catch (e) { return m.reply(`❌ Error: ${e.message}\n\n${footer}`); }
    }

    // ── Sticker → Image ───────────────────────────────────────
    if (cmd === 'simage') {
      const quotedMsg = m.quoted;
      if (!quotedMsg?.message?.stickerMessage) return m.reply(`📌 Reply to a sticker with *.simage*\n\n${footer}`);
      try {
        const buffer = await sock.downloadMediaMessage(quotedMsg);
        return sock.sendMessage(chat, { image: buffer, caption: `🖼️ *Sticker → Image*\n${footer}` }, { quoted: m.msg });
      } catch (e) { return m.reply(`❌ Error: ${e.message}\n\n${footer}`); }
    }

    // ── AI Chat ───────────────────────────────────────────────
    if (['gpt', 'llama3', 'chatai'].includes(cmd)) {
      if (!q) return m.reply(`📌 Usage: *.${cmd}* [question]\n\n${footer}`);
      await m.react('🤖');
      const waitMsg = await sock.sendMessage(chat, { text: `🤖 *AI thinking...*\n❓ *Q:* ${q}\n⏳ Please wait...\n${footer}`, _noImage: true }, { quoted: m.msg });
      const answer = await tryFetch([
        async () => {
          const r = await axios.post('https://text.pollinations.ai/', {
            messages: [{ role: 'system', content: 'You are a helpful assistant. Answer clearly and concisely.' }, { role: 'user', content: q }],
            model: cmd === 'llama3' ? 'llama' : 'openai', seed: 42,
          }, { timeout: 20000 });
          return typeof r.data === 'string' ? r.data.trim() : null;
        },
        async () => {
          const r = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4o?text=${encodeURIComponent(q)}`, { timeout: 15000 });
          return r.data?.message || r.data?.result || r.data?.response || null;
        },
      ]);
      try { await sock.sendMessage(chat, { text: answer ? `🤖 *AI (${cmd.toUpperCase()})*\n━━━━━━━━━━━━━━━━━━━━━━\n❓ *Q:* ${q}\n\n💡 *A:* ${answer}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` : `❌ Could not get AI response.\n\n${footer}`, edit: waitMsg.key }); } catch {}
      return;
    }

    // ── AI Image generation ───────────────────────────────────
    if (['imagine', 'flux', 'sora'].includes(cmd)) {
      if (!q) return m.reply(`📌 Usage: *.${cmd}* [prompt]\n\n${footer}`);
      await m.react('🎨');
      const waitMsg = await sock.sendMessage(chat, { text: `🎨 *Generating AI image...*\n✨ *Prompt:* ${q}\n⏳ Please wait...\n${footer}`, _noImage: true }, { quoted: m.msg });
      const imgBuffer = await tryFetch([
        async () => { const r = await axios.get(`https://image.pollinations.ai/prompt/${encodeURIComponent(q)}?width=1024&height=1024&nologo=true`, { responseType: 'arraybuffer', timeout: 30000 }); return Buffer.from(r.data); },
        async () => { const r = await axios.get(`https://api.paxsenix.biz.id/ai/flux?prompt=${encodeURIComponent(q)}`, { responseType: 'arraybuffer', timeout: 30000 }); return Buffer.from(r.data); },
      ]);
      if (imgBuffer) {
        await sock.sendMessage(chat, { image: imgBuffer, caption: `🎨 *AI Generated Image*\n✨ *Prompt:* ${q}\n🤖 *Model:* ${cmd}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: m.msg });
        try { await sock.sendMessage(chat, { delete: waitMsg.key }); } catch {}
      } else {
        try { await sock.sendMessage(chat, { text: `❌ Could not generate image.\n\n${footer}`, edit: waitMsg.key }); } catch {}
      }
      return;
    }

    // ── APK ───────────────────────────────────────────────────
    if (cmd === 'apk') {
      if (!q) return m.reply(`📌 Usage: *.apk* [app name]\n\n${footer}`);
      await m.react('📱');
      const waitMsg = await sock.sendMessage(chat, { text: `${tr('apk_searching')}\n${tr('apk_app')} ${q}\n${tr('please_wait')}\n${footer}`, _noImage: true }, { quoted: m.msg });

      let apkInfo = null;

      // Method 1: paxsenix apkpure
      try {
        const r = await axios.get(`https://api.paxsenix.biz.id/dl/apkpure?q=${encodeURIComponent(q)}`, { timeout: 20000 });
        if (r.data?.title && r.data?.url) apkInfo = { title: r.data.title, url: r.data.url, size: r.data.size || 'N/A', version: r.data.version || 'Latest', source: 'APKPure' };
      } catch {}

      // Method 2: paxsenix uptodown
      if (!apkInfo) {
        try {
          const r = await axios.get(`https://api.paxsenix.biz.id/dl/uptodown?q=${encodeURIComponent(q)}`, { timeout: 20000 });
          if (r.data?.title && r.data?.url) apkInfo = { title: r.data.title, url: r.data.url, size: r.data.size || 'N/A', version: r.data.version || 'Latest', source: 'Uptodown' };
        } catch {}
      }

      // Method 3: xteam API
      if (!apkInfo) {
        try {
          const r = await axios.get(`https://api.xteam.xyz/apk?q=${encodeURIComponent(q)}`, { timeout: 20000 });
          if (r.data?.result?.name && r.data?.result?.link) apkInfo = { title: r.data.result.name, url: r.data.result.link, size: r.data.result.size || 'N/A', version: r.data.result.version || 'Latest', source: 'APKPure' };
        } catch {}
      }

      // Method 4: agatz API
      if (!apkInfo) {
        try {
          const r = await axios.get(`https://api.agatz.xyz/api/apk?url=https://apkpure.com/search?q=${encodeURIComponent(q)}`, { timeout: 20000 });
          if (r.data?.data?.name && r.data?.data?.link) apkInfo = { title: r.data.data.name, url: r.data.data.link, size: r.data.data.size || 'N/A', version: r.data.data.version || 'Latest', source: 'APKPure' };
        } catch {}
      }

      const apkpureSearch = `https://apkpure.com/search?q=${encodeURIComponent(q)}`;
      const uptodownSearch = `https://uptodown.com/android/search?q=${encodeURIComponent(q)}`;
      const playstoreSearch = `https://play.google.com/store/search?q=${encodeURIComponent(q)}&c=apps`;

      try {
        if (apkInfo) {
          await sock.sendMessage(chat, {
            text: `${tr('apk_found')}\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('apk_app')} ${apkInfo.title}\n${tr('apk_version')} ${apkInfo.version}\n${tr('apk_size')} ${apkInfo.size}\n📦 *Source:* ${apkInfo.source}\n${tr('apk_link')} ${apkInfo.url}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
            edit: waitMsg.key,
          });
        } else {
          await sock.sendMessage(chat, {
            text: `${tr('apk_not_found')}\n━━━━━━━━━━━━━━━━━━━━━━\n📦 *APKPure:* ${apkpureSearch}\n📥 *Uptodown:* ${uptodownSearch}\n🏪 *Play Store:* ${playstoreSearch}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
            edit: waitMsg.key,
          });
        }
      } catch {}
      return;
    }

    // ── YouTube MP3 ───────────────────────────────────────────
    if (['mp3', 'song', 'play', 'ytmp3'].includes(cmd)) {
      if (!q) return m.reply(`📌 Usage: *.${cmd}* [song name or YouTube URL]\n\nExample: .${cmd} Shape of You\n\n${footer}`);
      await m.react('🎵');

      // 1️⃣ Searching msg — new message
      const searchMsg = await sock.sendMessage(chat, {
        text: `🔍 *Searching...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 *Query:* ${q}\n⏳ Searching YouTube...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, _noImage: true,
      }, { quoted: m.msg });
      const searchKey = searchMsg?.key || null;

      let videoUrl = q, displayTitle = q;
      if (!q.match(/https?:\/\//)) {
        try {
          const yts = require('yt-search');
          const res = await yts(q);
          const video = res?.videos?.[0] || res?.all?.[0];
          if (video) {
            const vid = video.videoId || video.url?.match(/(?:v=|youtu\.be\/)([^&?#]+)/)?.[1];
            if (vid) { videoUrl = `https://www.youtube.com/watch?v=${vid}`; displayTitle = video.title || q; }
          }
        } catch {}
      }

      // 2️⃣ Searching msg DELETE + button msg — new message
      try { if (searchKey) await sock.sendMessage(chat, { delete: searchKey }); } catch {}

      const btnMsg = await sendButtons(sock, chat, {
        text: `🎯 *Found!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎵 *Song:* ${displayTitle}\n🔗 ${videoUrl}\n━━━━━━━━━━━━━━━━━━━━━━\n*Choose download format:*\n\n1️⃣ MP3 Audio 🎵\n2️⃣ Voice Note 🎤\n3️⃣ Document 📄\n4️⃣ Main Menu 🏠\n\n*reply with a number*\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
        footer,
        buttons: [
          { label: '1️⃣ MP3 Audio 🎵',    id: `__dl_mp3 ${videoUrl}` },
          { label: '2️⃣ Voice Note 🎤',   id: `__dl_vn ${videoUrl}` },
          { label: '3️⃣ Document 📄',      id: `__dl_doc ${videoUrl}` },
          { label: '4️⃣ Main Menu 🏠',     id: `__dl_menu` },
        ],
        quoted: m.msg,
      });
      const btnKey = btnMsg?.key || null;

      // Store pending
      pendingDownload.set(m.sender, {
        type: 'song',
        input: q,
        url: videoUrl,
        displayTitle,
        statusKey: null,   // will be set on button tap
        buttonKey: btnKey,
        quotedMsg: m.msg,
      });

      // Auto-cleanup after 330s
      setTimeout(async () => {
        if (pendingDownload.has(m.sender) && pendingDownload.get(m.sender).buttonKey === btnKey) {
          pendingDownload.delete(m.sender);
          try { if (btnKey) await sock.sendMessage(chat, { delete: btnKey }); } catch {}
        }
      }, AUTO_DELETE_SECS * 1000);

      return;
    }

    // ── TikTok Download ───────────────────────────────────────
    if (['tiktok', 'tt', 'ttdl', 'ttmp4'].includes(cmd)) {
      if (!q) return m.reply(`📌 Usage: *.${cmd}* [TikTok URL]\n\nExample: .tiktok https://vm.tiktok.com/...\n\n${footer}`);
      const isTT = q.includes('tiktok.com') || q.includes('vm.tiktok') || q.includes('vt.tiktok');
      if (!isTT) return m.reply(`❌ *Invalid URL!*\n\nTikTok URL එකක් දෙන්න.\nExample: https://vm.tiktok.com/...\n\n${footer}`);
      await m.react('🎵');

      const ttBtnMsg = await sendButtons(sock, chat, {
        text: `🎵 *TikTok Download*\n━━━━━━━━━━━━━━━━━━━━━━\n🔗 ${q.substring(0, 60)}\n━━━━━━━━━━━━━━━━━━━━━━\n\nකෙසේ download කරන්නද?\n\n${footer}`,
        footer,
        buttons: [
          { label: '✅ Watermark නැතිව', id: `__tt_nowm ${q}` },
          { label: '💧 Watermark සමඟ',   id: `__tt_wm ${q}` },
        ],
        quoted: m.msg,
      });
      const ttBtnKey = ttBtnMsg?.key || null;

      pendingDownload.set(m.sender, {
        type: 'tiktok',
        url: q,
        displayTitle: 'TikTok Video',
        buttonKey: ttBtnKey,
        quotedMsg: m.msg,
      });

      setTimeout(async () => {
        if (pendingDownload.has(m.sender) && pendingDownload.get(m.sender).buttonKey === ttBtnKey) {
          pendingDownload.delete(m.sender);
          try { if (ttBtnKey) await sock.sendMessage(chat, { delete: ttBtnKey }); } catch {}
        }
      }, AUTO_DELETE_SECS * 1000);

      return;
    }

    // ── YouTube MP4 ───────────────────────────────────────────
    if (['mp4', 'video', 'ytmp4', 'ytvideo'].includes(cmd)) {
      if (!q) return m.reply(`📌 Usage: *.${cmd}* [video name or URL]\n\n${footer}`);

      // ── TikTok URL detect → route to tiktok downloader ───────
      const _isTikTok = q.includes('tiktok.com') || q.includes('vm.tiktok') || q.includes('vt.tiktok');
      if (_isTikTok) {
        await m.react('🎵');
        const _ttBtnMsg = await sendButtons(sock, chat, {
          text: `🎵 *TikTok Download*\n━━━━━━━━━━━━━━━━━━━━━━\n🔗 ${q.substring(0, 60)}\n━━━━━━━━━━━━━━━━━━━━━━\n\nකෙසේ download කරන්නද?\n\n${footer}`,
          footer,
          buttons: [
            { label: '✅ Watermark නැතිව', id: `__tt_nowm ${q}` },
            { label: '💧 Watermark සමඟ',   id: `__tt_wm ${q}` },
          ],
          quoted: m.msg,
        });
        const _ttBtnKey = _ttBtnMsg?.key || null;
        pendingDownload.set(m.sender, { type: 'tiktok', url: q, displayTitle: 'TikTok Video', buttonKey: _ttBtnKey, quotedMsg: m.msg });
        setTimeout(async () => {
          if (pendingDownload.has(m.sender) && pendingDownload.get(m.sender).buttonKey === _ttBtnKey) {
            pendingDownload.delete(m.sender);
            try { if (_ttBtnKey) await sock.sendMessage(chat, { delete: _ttBtnKey }); } catch {}
          }
        }, AUTO_DELETE_SECS * 1000);
        return;
      }

      await m.react('🎬');

      const searchMsg = await sock.sendMessage(chat, {
        text: `🔍 *Searching...*\n━━━━━━━━━━━━━━━━━━━━━━\n🎬 *Query:* ${q}\n⏳ Searching YouTube...\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, _noImage: true,
      }, { quoted: m.msg });
      const searchKey = searchMsg?.key || null;

      let videoUrl = q, displayTitle = q;
      if (!q.match(/https?:\/\//)) {
        try {
          const yts = require('yt-search');
          const res = await yts(q);
          const video = res?.videos?.[0] || res?.all?.[0];
          if (video) {
            const vid = video.videoId || video.url?.match(/(?:v=|youtu\.be\/)([^&?#]+)/)?.[1];
            if (vid) { videoUrl = `https://www.youtube.com/watch?v=${vid}`; displayTitle = video.title || q; }
          }
        } catch {}
      }

      try { if (searchKey) await sock.sendMessage(chat, { delete: searchKey }); } catch {}

      const vidBtnMsg = await sendButtons(sock, chat, {
        text: `🎯 *Found!*\n━━━━━━━━━━━━━━━━━━━━━━\n🎬 *Video:* ${displayTitle}\n🔗 ${videoUrl}\n━━━━━━━━━━━━━━━━━━━━━━\nChoose quality:\n${footer}`,
        footer,
        buttons: [
          { label: '📺 360p Video',   id: `__dl_360 ${videoUrl}` },
          { label: '📺 720p Video',   id: `__dl_720 ${videoUrl}` },
          { label: '📄 360p Doc',     id: `__dl_d360 ${videoUrl}` },
          { label: '📄 720p Doc',     id: `__dl_d720 ${videoUrl}` },
        ],
        quoted: m.msg,
      });
      const vidBtnKey = vidBtnMsg?.key || null;

      pendingDownload.set(m.sender, {
        type: 'video',
        input: q,
        url: videoUrl,
        displayTitle,
        statusKey: null,
        buttonKey: vidBtnKey,
        quotedMsg: m.msg,
      });

      setTimeout(async () => {
        if (pendingDownload.has(m.sender) && pendingDownload.get(m.sender).buttonKey === vidBtnKey) {
          pendingDownload.delete(m.sender);
          try { if (vidBtnKey) await sock.sendMessage(chat, { delete: vidBtnKey }); } catch {}
        }
      }, AUTO_DELETE_SECS * 1000);

      return;
    }

    // ── Film download ─────────────────────────────────────────
    if (['filmdownload', 'fdl', 'fdownload'].includes(cmd)) {
      if (!q) {
        return sendButtons(sock, chat, {
          text: `🎬 *Film Downloader*\n━━━━━━━━━━━━━━━━━━━━━━\n📌 Usage: *.filmdownload* [movie name]\n\nExamples:\n*.filmdownload* Avengers Endgame\n*.filmdownload* Spider-Man No Way Home\n\n✅ *50+ download methods*\n🔄 *Auto fallback if one fails*\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
          footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: m.msg,
        });
      }

      await m.react('🎬');

      const searchMsg = await sock.sendMessage(chat, {
        text: `${tr('film_searching')}\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('film_query')} ${q}\n${tr('please_wait')}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`, _noImage: true,
      }, { quoted: m.msg });
      const searchKey = searchMsg?.key || null;

      // Search for film info
      let filmTitle = q;
      try {
        const r = await axios.get(`https://www.omdbapi.com/?t=${encodeURIComponent(q)}&apikey=trilogy`, { timeout: 10000 });
        if (r.data?.Title) {
          filmTitle = r.data.Title;
          try {
            await sock.sendMessage(chat, {
              text: `${tr('film_found')}\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('film_title')} ${r.data.Title}\n${tr('film_year')} ${r.data.Year || 'N/A'}\n${tr('film_rating')} ${r.data.imdbRating || 'N/A'}\n\n${tr('film_finding_dl')}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}`,
              edit: searchKey,
            });
          } catch {}
        }
      } catch {}

      // Delete search msg, show quality buttons
      try { if (searchKey) await sock.sendMessage(chat, { delete: searchKey }); } catch {}

      const filmBtnMsg = await sendButtons(sock, chat, {
        text: `🎯 *Found!*\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('film_title')} ${filmTitle}\n━━━━━━━━━━━━━━━━━━━━━━\n${tr('choose_quality')}\n${footer}`,
        footer,
        buttons: [
          { label: '📺 480p',  id: `__dl_480 ${filmTitle}` },
          { label: '📺 720p',  id: `__dl_720f ${filmTitle}` },
          { label: '📺 1080p', id: `__dl_1080 ${filmTitle}` },
        ],
        quoted: m.msg,
      });
      const filmBtnKey = filmBtnMsg?.key || null;

      pendingDownload.set(m.sender, {
        type: 'film',
        displayTitle: filmTitle,
        statusKey: null,
        buttonKey: filmBtnKey,
        quotedMsg: m.msg,
      });

      setTimeout(async () => {
        if (pendingDownload.has(m.sender) && pendingDownload.get(m.sender).buttonKey === filmBtnKey) {
          pendingDownload.delete(m.sender);
          try { if (filmBtnKey) await sock.sendMessage(chat, { delete: filmBtnKey }); } catch {}
        }
      }, AUTO_DELETE_SECS * 1000);

      return;
    }

    // ── Anime GIFs ────────────────────────────────────────────
    if (ANIME_CMDS.includes(cmd)) {
      await m.react('🎌');
      const gifUrl = await getAnimeGif(cmd);
      if (gifUrl) {
        const r = await axios.get(gifUrl, { responseType: 'arraybuffer', timeout: 15000 }).catch(() => null);
        if (r) {
          const isGif = gifUrl.endsWith('.gif') || r.headers['content-type']?.includes('gif');
          return sock.sendMessage(chat, { [isGif ? 'video' : 'image']: Buffer.from(r.data), gifPlayback: isGif, caption: `*${cmd.toUpperCase()}*\n${footer}` }, { quoted: m.msg });
        }
        return m.reply(`*${cmd.toUpperCase()}*\n🔗 ${gifUrl}\n${footer}`);
      }
      return m.reply(`❌ Could not get ${cmd} GIF.\n\n${footer}`);
    }

    // ── Text Art ──────────────────────────────────────────────
    if (TEXT_ART_CMDS.includes(cmd)) {
      if (!q) return m.reply(`📌 Usage: *.${cmd}* [text]\n\n${footer}`);
      await m.react('🎨');
      const waitMsg = await sock.sendMessage(chat, { text: `🎨 *Generating ${cmd} text art...*\n📝 *Text:* ${q}\n⏳ Please wait...\n${footer}`, _noImage: true }, { quoted: m.msg });
      const imgBuffer = await tryFetch([
        async () => { const r = await axios.get(`https://api.paxsenix.biz.id/text-effect/${cmd}?text=${encodeURIComponent(q)}`, { responseType: 'arraybuffer', timeout: 20000 }); return Buffer.from(r.data); },
        async () => { const r = await axios.get(`https://api.lolhuman.xyz/api/teks/${cmd}?apikey=demo&text=${encodeURIComponent(q)}`, { responseType: 'arraybuffer', timeout: 20000 }); return Buffer.from(r.data); },
      ]);
      if (imgBuffer) {
        await sock.sendMessage(chat, { image: imgBuffer, caption: `🎨 *${cmd.toUpperCase()} Text Art*\n📝 *Text:* ${q}\n━━━━━━━━━━━━━━━━━━━━━━\n${footer}` }, { quoted: m.msg });
        try { await sock.sendMessage(chat, { delete: waitMsg.key }); } catch {}
      } else {
        try { await sock.sendMessage(chat, { text: `❌ Could not generate text art.\n\n${footer}`, edit: waitMsg.key }); } catch {}
      }
      return;
    }

    // ── PP Overlays ───────────────────────────────────────────
    if (OVERLAY_CMDS.includes(cmd)) {
      const mentioned = m.msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.sender;
      const emojiMap = { heart: '❤️', circle: '⭕', lgbt: '🏳️‍🌈', horny: '😏', lolice: '👮', gay: '🌈', glass: '👓', passed: '✅' };
      await m.react(emojiMap[cmd] || '✨');
      try {
        const pp = await sock.profilePictureUrl(mentioned, 'image').catch(() => null);
        if (pp) {
          const imgBuffer = await tryFetch([
            async () => { const r = await axios.get(`https://some-random-api.com/canvas/overlay/${cmd}?avatar=${encodeURIComponent(pp)}`, { responseType: 'arraybuffer', timeout: 15000 }); return Buffer.from(r.data); },
            async () => { const r = await axios.get(`https://api.paxsenix.biz.id/overlay/${cmd}?image=${encodeURIComponent(pp)}`, { responseType: 'arraybuffer', timeout: 15000 }); return Buffer.from(r.data); },
          ]);
          if (imgBuffer) return sock.sendMessage(chat, { image: imgBuffer, caption: `${emojiMap[cmd]} *${cmd.toUpperCase()}*\n@${mentioned.split('@')[0]}\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
        }
        return sock.sendMessage(chat, { text: `${emojiMap[cmd]} *${cmd.toUpperCase()}*\n@${mentioned.split('@')[0]}\n${footer}`, mentions: [mentioned] }, { quoted: m.msg });
      } catch (e) { return m.reply(`❌ Error: ${e.message}\n\n${footer}`); }
    }
  },
};
