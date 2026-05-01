'use strict';
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const cfg   = require('../../config');
const { getT } = require('../lang');

const MENU_DIR      = path.join(__dirname, '../../database/menucards');

// Ensure menucards directory exists
if (!fs.existsSync(MENU_DIR)) fs.mkdirSync(MENU_DIR, { recursive: true });

// ── Local media images (shuffle these instead of downloading) ──────────────
const MEDIA_DIR = path.join(__dirname, '../media');
const LOCAL_MENU_IMAGES = [
  path.join(MEDIA_DIR, 'unity_banner_1.jpg'),
  path.join(MEDIA_DIR, 'unity_banner_2.jpg'),
  path.join(MEDIA_DIR, 'unity_thumb.jpg'),
].filter(p => fs.existsSync(p));

// Shuffle array helper (Fisher-Yates)
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build a shuffled pool large enough for all 15 sections
// e.g. 3 images × 5 = 15 slots, all shuffled
let _imgPool = [];
function getLocalImagePath(index) {
  if (LOCAL_MENU_IMAGES.length === 0) return null;
  if (_imgPool.length === 0) {
    // Refill: repeat images until we have enough, then shuffle
    const repeats = Math.ceil(15 / LOCAL_MENU_IMAGES.length);
    const full = [];
    for (let r = 0; r < repeats; r++) full.push(...LOCAL_MENU_IMAGES);
    _imgPool = shuffleArray(full);
  }
  return _imgPool[index % _imgPool.length];
}

/** refreshMenuImages is now a no-op — images come from local media folder */
async function refreshMenuImages() {
  const results = [];
  for (let i = 1; i <= 15; i++) {
    const imgPath = getLocalImagePath(i - 1);
    results.push({ section: i, success: !!imgPath, file: imgPath ? path.basename(imgPath) : 'missing' });
  }
  return results;
}

// ── Section definitions

// ── Section definitions (uses string keys for i18n) ──────────
const SECTIONS = [
  { file: 'menu_01.jpg', icon: '🤖', titleKey: 'imenu_title_bot',     cmd: 'botmenu',      labelKey: 'imenu_open_bot',     cmds: ['alive','bot','ping','runtime','speed','block','unblock','settings','setprefix','setname','setbio','setppbot','setownerdp','delownerdp','botmode','groupmode','inboxmode','privatemode','publicmode'] },
  { file: 'menu_02.jpg', icon: '👥', titleKey: 'imenu_title_group',   cmd: 'groupmenu',    labelKey: 'imenu_open_group',   cmds: ['tagall', 'hidetag', 'add', 'kick', 'promote', 'demote', 'welcome', 'setname', 'setdesc', 'grouplink', 'glink', 'warn', 'warnings', 'resetwarn', 'ban', 'unban', 'mute', 'unmute', 'unwarn', 'remove', 'everyone', 'tgall', 'tgna', 'tagnotadmin', 'tag', 'del', 'delete', 'ginfo', 'resetlink', 'newlink', 'poll', 'pin', 'unpin', 'disappearing', 'topmembers', 'topmsg', 'approve', 'acceptreq', 'reject', 'rejectreq', 'viewreq', 'joinrequests', 'addmember', 'removeall', 'kickall', 'kickme', 'leavegroup', 'setsubject', 'setdescription', 'invitelink', 'link', 'tagadmin', 'tgadmin', 'opentime', 'closetime', 'open', 'close', 'rules', 'setrules', 'faq', 'setfaq', 'copygc', 'linkgc', 'revoke', 'membercount', 'members', 'kickinactive', 'setkeyword', 'addkeyword', 'delkeyword', 'antitag', 'staff'] },
  { file: 'menu_03.jpg', icon: '📥', titleKey: 'imenu_title_dl',      cmd: 'downloadmenu', labelKey: 'imenu_open_dl',      cmds: ['song', 'mp3', 'play', 'tiktok', 'mp4', 'video', 'filmdownload', 'instagram', 'facebook', 'twitter', 'twdl', 'mediafire', 'mfire', 'ig', 'fb', 'gdrive', 'gdrive2', 'googledrive', 'downurl', 'down', 'dlurl', 'apk', 'apkdl', 'rw', 'wallpaper', 'wall', 'randomwall', 'ytmp3', 'tomp3', 'toaudio', 'tovn', 'tovoice', 'aivoice', 'vai', 'voicex', 'voiceai', 'ytmp4', 'ytvideo', 'vid', 'ytsong', 'song2', 'play2', 'play3', 'ttdl', 'tt', 'ttmp4', 'ttsearch', 'pinsearch', 'pinterest', 'fdl', 'fdownload', 'movie', 'cinesubz', 'sinhalafilm', 'sinhalamovie'] },
  { file: 'menu_04.jpg', icon: '🤖', titleKey: 'imenu_title_ai',      cmd: 'aimenu',       labelKey: 'imenu_open_ai',      cmds: ['ai', 'gpt', 'llama3', 'chatai', 'clearai', 'imagine', 'flux', 'sora', 'gemini', 'openai', 'chatgpt', 'gpt3', 'gpt5', 'deepseek', 'deep', 'seekai', 'mistral', 'unity', 'resetai', 'gimage', 'googleimage', 'wiki', 'wikipedia', 'whatsappstalk', 'wastalk', 'githubstalk', 'github', 'github2', 'imdb', 'cricket', 'ytstalk', 'ytinfo', 'xstalk', 'twitterstalk', 'twtstalk', 'tiktokstalk', 'tstalk', 'ttstalk', 'npm', 'npmsearch', 'npminfo', 'srepo', 'repo', 'source'] },
  { file: 'menu_05.jpg', staticUrl: 'https://qu.ax/x/3Qgql.jpg', icon: '🎨', titleKey: 'imenu_title_sticker', cmd: 'stickermenu',  labelKey: 'imenu_open_sticker', cmds: ['sticker', 'attp', 'crop', 'take', 'emojimix', 'rmbg', 'blur', 'remini', 'toimg', 's', 'stiker', 'stickerfit', 'stickercrop', 'stickertoimg', 'removebg', 'nobg', 'rvo', 'viewonce', 'vv', 'retrive', 'revealvo', 'invert', 'negative', 'grayscale', 'resize', 'compress', 'colorize', 'circle', 'square', 'imgpdf', 'topdf', 'toqr', 'imagetolink', 'imgtolink', 'imglink'] },
  { file: 'menu_06.jpg', icon: '😂', titleKey: 'imenu_title_fun',     cmd: 'funmenu',      labelKey: 'imenu_open_fun',     cmds: ['joke', 'quote', 'fact', 'meme', 'flirt', 'compliment', 'insult', 'wasted', 'hack', 'ship', 'confess', 'confession', 'fakescreenshot', 'fakechat', 'afk', 'delafk', 'joke2', 'comrade', 'namecard', 'character', 'oogway', 'tweet', 'ytcomment', 'triggered', 'spam', 'fakenumber', 'fakeno', 'genfake', 'simp', 'stupid', 'goodnight', 'shayari', 'roseday', 'chatcount', 'nokia', 'nokiamsg', 'jail', 'wanted', 'chuck', 'chucknorris', 'advice', 'activity', 'bored', 'uselessfact', 'kanye', 'catfact', 'catpic', 'dogpic', 'foxpic'] },
  { file: 'menu_07.jpg', icon: '🛠️', titleKey: 'imenu_title_tools',   cmd: 'toolsmenu',    labelKey: 'imenu_open_tools',   cmds: ['tts', 'tr', 'qr', 'qrlink', 'ping', 'runtime', 'calc', 'weather', 'shorturl', 'jid', 'privacy', 'texttospeech', 'translate', 'toqr', 'calculate', 'bmi', 'age', 'pass', 'password', 'ascii', 'fancy', 'styletext', 'morse', 'unmorse', 'binary', 'unbinary', 'mirror', 'reverse', 'zalgo', 'glitch', 'bold', 'italic', 'mono', 'flip', 'sinhalafont', 'uppercase', 'lowercase', 'snake', 'camel', 'logo', 'textlogo', 'url', 'country', 'countryinfo', 'nation', 'simdata', 'siminfo', 'checknum', 'checkwa', 'wacheck', 'wavalidate', 'wanumber', 'numinfo', 'exchange', 'convert', 'crypto', 'cryptoprice', 'colorinfo', 'numfact', 'screenshot', 'ss'] },
  { file: 'menu_08.jpg', icon: '🎌', titleKey: 'imenu_title_anime',   cmd: 'animemenu',    labelKey: 'imenu_open_anime',   cmds: ['animeinfo','manga','dragonball','dbz'] },
  { file: 'menu_09.jpg', icon: '🎮', titleKey: 'imenu_title_games',   cmd: 'gamemenu',     labelKey: 'imenu_open_games',   cmds: ['ttt', 'hangman', 'trivia', 'truth', 'dare', 'slots', 'slot', 'riddle', 'eightball', 'calc', 'blackjack', 'bj', 'bjhit', 'bjstand', 'guess', 'answer', 'tictactoe', 'tttmove', 'snake'] },
  { file: 'menu_10.jpg', icon: '🛡️', titleKey: 'imenu_title_protection', cmd: 'protectionmenu', labelKey: 'imenu_open_protection', cmds: ['antilink', 'antispam', 'antidelete', 'anticall', 'antitoxic', 'antiforward', 'antiraid', 'flooddetect', 'badwords', 'addbadword', 'delbadword', 'antibadword', 'badword', 'slowmode', 'captcha', 'pmblocker', 'pmblock', 'setwelcome', 'goodbye', 'setgoodbye', 'moroccoblock', 'autoblock'] },
  { file: 'menu_11.jpg', icon: '⚡', titleKey: 'imenu_title_auto',    cmd: 'automenu',     labelKey: 'imenu_open_auto',    cmds: ['autoread', 'autoreact', 'setreactemojis', 'autopresence', 'setpresencetype', 'autovoice', 'addautovoice', 'listautovoice', 'delautovoice', 'autostickerreply', 'addautosticker', 'listautosticker', 'delautosticker', 'autoreply', 'addautoreply', 'listautoreply', 'delautoreply', 'autoapprove', 'autobio', 'autoonline', 'autorecording', 'autostatus', 'autostatusreact', 'statusemoji'] },
  { file: 'menu_12.jpg', icon: '📡', titleKey: 'imenu_title_channel', cmd: 'channelmenu',  labelKey: 'imenu_open_channel', cmds: ['chpost', 'channelpost', 'chaudio', 'chvideo', 'chschedule', 'channelschedule', 'chdel', 'channeldel', 'chstats', 'channelstats', 'chdesc', 'channeldesc', 'chname', 'channelname', 'chlist', 'channellist', 'chpromo', 'channelpromo', 'setmychannel', 'chr', 'creact', 'cid', 'channelreact', 'reactchannel', 'followchannel', 'boost', 'view', 'forwardall', 'fwdall', 'fwdg', 'fwdgroup', 'massdm', 'msg', 'schedule', 'forward', 'upsw', 'readsw', 'statuslist', 'statusreact', 'statusview', 'savestatus', 'dlstatus', 'autostatus', 'autostatusreact', 'statusemoji', 'wastatus', 'wstatus', 'broadcast', 'bc'] },
  { file: 'menu_13.jpg', icon: '🇱🇰', titleKey: 'imenu_title_srilanka', cmd: 'srilankmenu', labelKey: 'imenu_open_srilanka', cmds: ['news', 'adarana', 'esana', 'esananews', 'lyrics', 'lyric', 'sinhalalyrics', 'wthr', 'holiday', 'holidays', 'cinema', 'define', 'dict', 'dictionary', 'meaning', 'sinhaladict'] },
  { file: 'menu_14.jpg', icon: '📊', titleKey: 'imenu_title_stats',   cmd: 'statsmenu',   labelKey: 'imenu_open_stats',   cmds: ['mystats', 'rank', 'leaderboard', 'topcmds', 'botstats', 'botinfo', 'groupstats', 'screenshot', 'ss', 'cinfo', 'staff', 'status', 'presence', 'setonline', 'settyping', 'setrecording', 'runtime', 'version', 'cmds', 'help', 'owner', 'sysinfo', 'dbstats'] },
  { file: 'menu_15.jpg', icon: '🌐', titleKey: 'imenu_title_apis',    cmd: 'apismenu',    labelKey: 'imenu_open_apis',    cmds: ['recipe', 'cocktail', 'drink', 'nasa', 'apod', 'book', 'openlibrary', 'onthisday', 'histday', 'nba', 'nbascore', 'phonespec', 'exchange', 'convert', 'crypto', 'cryptoprice', 'colorinfo', 'numfact', 'catfact', 'catpic', 'dogpic', 'foxpic', 'chuck', 'advice', 'activity', 'uselessfact', 'kanye', 'animeinfo', 'manga', 'dragonball', 'dbz'] },
];

function buildCardBody(sec, idx, total, date, time, tr) {
  const cmdLines = sec.cmds.map(c => `› .${c}`).join('\n');
  return (
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${sec.icon} *${tr(sec.titleKey)}*\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${cmdLines}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${tr('imenu_tap')} ${sec.icon}\n` +
    `📅 ${date}  🕐 ${time}  |  ${idx + 1}/${total}`
  );
}

function getNow(tz = 'Asia/Colombo') {
  try {
    const now  = new Date();
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    return { date, time };
  } catch {
    const d = new Date();
    return {
      date: d.toLocaleDateString('en-GB'),
      time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
    };
  }
}

module.exports = {
  refreshMenuImages,
  commands: ['imenu', 'menu2', 'imrefresh'],
  ownerOnly: true,

  async run({ sock, m }) {
    const chat     = m.chat;

    // ── .imrefresh — force redownload all menu images ─────────
    if (m.command === 'imrefresh') {
      await m.reply('🔄 Refreshing menu images... please wait.');
      try {
        const results = await refreshMenuImages();
        const ok  = results.filter(r => r.success).length;
        const fail = results.length - ok;
        const imgList = LOCAL_MENU_IMAGES.map(p => `✅ ${path.basename(p)}`).join('\n');
        await m.reply(
          `✅ *Local Menu Images Ready*\n\n` +
          `📂 Using ${LOCAL_MENU_IMAGES.length} local image(s):\n${imgList}\n\n` +
          `🔀 Shuffled across all 15 sections\n` +
          `🚀 No internet download needed\n\n` +
          `Run *.imenu* to see the menu.`
        );
      } catch (e) {
        await m.reply(`❌ Refresh failed: ${e.message}`);
      }
      return;
    }

    const prefix   = cfg.prefix   || '.';
    const botName  = cfg.botName  || 'UNITY-MD';
    const timezone = cfg.timezone || 'Asia/Colombo';
    const userName = m.pushName   || 'User';
    const { date, time } = getNow(timezone);
    const total = SECTIONS.length;

    // ── Load translator for current session language (en/si/ta) ──
    const tr = await getT(m.sessionOwner);

    // ── Time-based greeting ───────────────────────────────────
    const hour = new Date().getHours();
    const greeting = hour < 12
      ? tr('menu_greeting_morn')
      : hour < 17
        ? tr('menu_greeting_aft')
        : tr('menu_greeting_eve');

    try { await sock.sendMessage(chat, { delete: m.key }); } catch {}

    try {
      const {
        generateWAMessageFromContent,
        prepareWAMessageMedia,
        proto,
      } = require('@whiskeysockets/baileys');

      // ── Build carousel cards (one per section) ────────────────
      const cards = [];

      for (let i = 0; i < SECTIONS.length; i++) {
        const sec = SECTIONS[i];

        let imgBuf;

        // ── Use shuffled local media image (no internet download needed) ──
        const _localImg = getLocalImagePath(i);
        if (_localImg && fs.existsSync(_localImg)) {
          imgBuf = fs.readFileSync(_localImg);
        } else {
          // Final fallback: menucards directory (if manually placed)
          const imgPath = path.join(MENU_DIR, sec.file);
          if (fs.existsSync(imgPath)) {
            imgBuf = fs.readFileSync(imgPath);
          }
        }

        if (!imgBuf) {
          console.warn(`[imenu] No image available for section ${i + 1} (${sec.file})`);
          continue;
        }

        // Upload image to WhatsApp CDN
        let media;
        try {
          media = await prepareWAMessageMedia(
            { image: imgBuf },
            { upload: sock.waUploadToServer }
          );
        } catch (uploadErr) {
          console.error(`[imenu] Upload failed for ${sec.file}:`, uploadErr.message);
          continue;
        }

        const card = proto.Message.InteractiveMessage.create({
          header: proto.Message.InteractiveMessage.Header.create({
            hasMediaAttachment: true,
            imageMessage: media.imageMessage,
          }),
          body: proto.Message.InteractiveMessage.Body.create({
            text: buildCardBody(sec, i, total, date, time, tr),
          }),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [{
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: tr(sec.labelKey),
                id: `${prefix}${sec.cmd}`,
              }),
            }],
          }),
        });

        cards.push(card);
      }

      if (cards.length === 0) {
        // Local images missing — log warning (no download attempted)
        console.warn('[imenu] No local images found in src/media/. Add unity_banner_1.jpg, unity_banner_2.jpg or unity_thumb.jpg');
        return await m.reply(tr('imenu_no_imgs'));
      }

      // ── Carousel cover text ───────────────────────────────────
      const headerText =
        `╔══════════════════════╗\n` +
        `║   🧲 *${botName} Menu*   ║\n` +
        `╚══════════════════════╝\n\n` +
        `${greeting}, *${userName}*!\n` +
        `📅 ${tr('imenu_date_lbl')} ${date}  🕐 ${tr('imenu_time_lbl')} ${time}\n\n` +
        `${tr('imenu_swipe')}`;

      // ── Send as side-scroll carousel ──────────────────────────
      const carouselMsg = await generateWAMessageFromContent(chat, {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
            interactiveMessage: proto.Message.InteractiveMessage.create({
              body: proto.Message.InteractiveMessage.Body.create({ text: headerText }),
              footer: proto.Message.InteractiveMessage.Footer.create({ text: `® UNITY TEAM | ${botName}` }),
              header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
              carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({ cards }),
            }),
          },
        },
      }, {});

      await sock.relayMessage(carouselMsg.key.remoteJid, carouselMsg.message, {
        messageId: carouselMsg.key.id,
        additionalNodes: [{
          tag: 'biz',
          attrs: {},
          content: [{
            tag: 'interactive',
            attrs: { type: 'native_flow', v: '1' },
            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
          }],
        }],
      });

    } catch (e) {
      console.error('[imenu] Carousel error:', e);
      // ── Fallback: individual image messages ───────────────────
      try {
        for (let i = 0; i < SECTIONS.length; i++) {
          const sec = SECTIONS[i];
          let _fbBuf;
          if (sec.staticUrl) {
            try {
              const _fetch = require('node-fetch');
              _fbBuf = Buffer.from(await (await _fetch(sec.staticUrl)).arrayBuffer());
            } catch {}
          }
          if (!_fbBuf && sec.staticSrc && fs.existsSync(sec.staticSrc)) {
            _fbBuf = fs.readFileSync(sec.staticSrc);
          }
          if (!_fbBuf) {
            const imgPath = path.join(MENU_DIR, sec.file);
            if (!fs.existsSync(imgPath)) continue;
            _fbBuf = fs.readFileSync(imgPath);
          }
          await new Promise(r => setTimeout(r, 300));
          await sock.sendMessage(chat, {
            image: _fbBuf,
            caption: buildCardBody(sec, i, SECTIONS.length, date, time, tr),
          });
        }
      } catch (fallbackErr) {
        await m.reply(`❌ ${fallbackErr.message}`);
      }
    }
  },
};

// ── Auto-reload on file change ──────────────────────────────
const _fs   = require('fs');
const _file = require.resolve(__filename);
_fs.watchFile(_file, () => {
  _fs.unwatchFile(_file);
  delete require.cache[_file];
  require(_file);
});
