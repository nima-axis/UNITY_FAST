'use strict';
const cfg = require('../../config');
const db = require('./index');
const { sendButtons } = require('./helper');
const { t, getLang, setLangCache } = require('../lang');

let currentMode = 'public';
function getBotMode() { return currentMode; }
function setBotMode(mode) { currentMode = mode; }

const settingsButtonKeys = new Map();
async function deleteSettingsButtons(sock, chat) {
  const keys = settingsButtonKeys.get(chat);
  if (!keys) return;
  settingsButtonKeys.delete(chat);
  for (const key of keys) try { await sock.sendMessage(chat, { delete: key }); } catch {}
}

// All toggleable commands grouped by category
const CMD_GROUPS = {
  'AI & Search': [
    'ai', 'gemini', 'clearai', 'stopai', 'gpt', 'llama3', 'chatai', 'imagine', 'flux', 'sora',
    'wiki', 'gimage', 'imdb', 'github', 'wastalk', 'cricket',
    // unity AI
    'openai', 'chatgpt', 'deepseek', 'mistral', 'unity', 'bot',
  ],
  'Media Tools': [
    'sticker', 's', 'attp', 'take', 'emojimix', 'rmbg', 'remini', 'rvo', 'toimg',
    'compress', 'resize', 'topdf', 'getpp', 'poll', 'quoted', 'react', 'pin', 'unpin', 'disappearing', 'blur',
    // unity image effects
    'grey', 'gray', 'invert', 'jail', 'wanted', 'nokia', 'imgad', 'imgjoke',
  ],
  'Downloads': [
    'mp3', 'song', 'play', 'ytmp3', 'mp4', 'ytmp4', 'ytvideo', 'apk', 'filmdownload', 'film', 'movie', 'cinesubz',
    // unity downloads
    'twitter', 'twdl', 'mediafire', 'mfire', 'ig', 'instagram', 'facebook', 'fb',
    'gdrive', 'googledrive', 'downurl', 'down', 'wallpaper', 'rw',
    'song2', 'play2', 'play3', 'ytsong', 'video', 'vid', 'ytvideo',
    'tiktok', 'ttdl', 'pinterest',
  ],
  'Text Tools': [
    'tts', 'tr', 'qr', 'calc', 'bmi', 'age', 'pass', 'ascii', 'tomp3', 'tovoice',
    'shorturl', 'url', 'fancy', 'bold', 'italic', 'mono', 'morse', 'binary',
    'reverse', 'mirror', 'zalgo', 'glitch', 'uppercase', 'lowercase', 'snake', 'camel', 'flip', 'sinhalafont',
    // unity text tools
    'fakenumber', 'fakeno', 'logo', 'textlogo', 'npmsearch', 'countryinfo',
  ],
  'Fun': [
    'joke', 'quote', 'fact', 'flirt', 'compliment', 'insult', 'meme', '8ball', 'ship', 'wasted',
    'simp', 'stupid', 'shayari', 'roseday', 'goodnight', 'afk', 'confess', 'fakechat', 'hack',
    'character', 'oogway', 'tweet', 'ytcomment', 'jail', 'triggered', 'namecard', 'its-so-stupid', 'comrade',
    'spam',
  ],
  'Anime': ['neko', 'waifu', 'nom', 'poke', 'cry', 'kiss', 'pat', 'hug', 'wink', 'facepalm', 'loli', 'punch', 'slap', 'dance', 'happy', 'blush'],
  'Text Art': ['metallic', 'ice', 'snow', 'impressive', 'matrix', 'light', 'neon', 'devil', 'purple', 'thunder', 'leaves', '1917', 'arena', 'hacker', 'sand', 'blackpink', 'fire'],
  'Image Effects': ['heart', 'circle', 'lgbt', 'horny', 'lolice', 'gay', 'glass', 'passed'],
  'Games': ['ttt', 'blackjack', 'hangman', 'trivia', 'truth', 'dare', 'slots', 'riddle'],
  'Group Mgmt': [
    'kick', 'promote', 'demote', 'add', 'tagall', 'warn', 'mute', 'ban', 'open', 'close',
    'setdesc', 'setsubject', 'rules', 'members', 'kickinactive', 'groupinfo', 'topmembers',
    // unity group
    'approve', 'acceptreq', 'reject', 'rejectreq', 'viewreq', 'joinrequests',
    'addmember', 'removeall', 'kickall', 'kickme', 'leavegroup',
    'setname', 'setdescription', 'grouplink', 'glink', 'invitelink', 'link',
    'tagadmin', 'tgadmin', 'opentime', 'closetime', 'joingroup', 'joininvite',
  ],
  'Protection': [
    'antitag', 'antilink', 'antispam', 'antidelete', 'anticall', 'antitoxic', 'antiforward',
    'antiraid', 'flooddetect', 'badwords', 'addbadword', 'slowmode', 'captcha', 'pmblocker', 'welcome', 'goodbye',
  ],
  'Auto Systems': [
    // Unity
    'autoread',
    // unity auto features
    'autoreact', 'setreactemojis',
    'autopresence', 'setpresencetype',
    'autoblock', 'moroccoblock',
    'autovoice', 'addautovoice', 'listautovoice', 'delautovoice',
    'autostickerreply', 'addautosticker', 'listautosticker', 'delautosticker',
    'autoreply', 'addautoreply', 'listautoreply', 'delautoreply',
    'autoaireply', 'clearaichat',
    // Status (2026 new methods)
    'autostatus', 'autostatusreact', 'statusemoji',
  ],
  'Sri Lanka': ['news', 'esana', 'cinesubz', 'cinema', 'define', 'sinhaladict', 'weather', 'holiday', 'lyrics'],
  'Info & Stats': [
    'jid', 'cinfo', 'privacy', 'groupinfo', 'staff', 'mystats', 'rank', 'leaderboard',
    'topcmds', 'botstats', 'botinfo', 'groupstats', 'speed', 'runtime', 'screenshot', 'ss',
    // unity info
    'repo', 'source', 'channelreact', 'presence', 'ytsearch2', 'yts2',
  ],
};

module.exports = {
  commands: [
    'settings', 'botmode',
    'publicmode', 'groupmode', 'inboxmode', 'privatemode',
    'autorecording', 'autoonline',
    'autoread', 'autotyping', 'autobio', 'didyoumean', 'anticall', 'autodeletechat',
    'autostatus', 'autostatusreact',
    'setlang', 'setprefix',
    'mysettings', 'myprefix', 'mylang', 'myname', 'myreset',
    'getid', 'getjid', 'getgroupid', 'getchannelid',
    // Command toggle panel
    'cmds', 'cmdson', 'cmdsoff', 'cmdtoggle',
  ],

  access: 'owner',
  description: 'Bot settings and command toggles',

  CMD_GROUPS,
  getBotMode,
  setBotMode,

  async run({ sock, m }) {
    const lang = await getLang(m.sessionOwner);
    const cmd    = m.command;
    const text   = m.text?.trim();
    const sender = m.sender;
    const chat   = m.chat;

    const personalCmds = ['mysettings', 'myprefix', 'mylang', 'myname', 'myreset'];
    if (personalCmds.includes(cmd)) {
      if (!m.isPaired && !m.isOwner) return;
    }

    if (['getid', 'getjid', 'getgroupid', 'getchannelid'].includes(cmd)) {
      const type = chat.endsWith('@g.us') ? '👥 Group' : chat.endsWith('@newsletter') ? '📢 Channel' : '👤 Private Chat';
      const quotedJid = m.quoted?.sender || null;
      let reply = `🆔 *JID / ID Info*\n\n*Type:* ${type}\n*Chat JID:* \`${chat}\`\n*Your JID:* \`${sender}\`\n`;
      if (quotedJid) reply += `*Quoted User JID:* \`${quotedJid}\`\n`;
      reply += `\n${cfg.footer}`;
      return m.reply(reply);
    }

    // ── Command toggle panel ──────────────────────────────────
    if (cmd === 'cmds') {
      try { await sock.sendMessage(chat, { delete: m.key }); } catch {}
      await deleteSettingsButtons(sock, chat);

      const botCfg = await db.getBotConfig(m.sessionOwner);
      const map = botCfg.enabledCommands || new Map();

      const groupNames = Object.keys(CMD_GROUPS);
      const statusLines = groupNames.map(g => {
        const cmds = CMD_GROUPS[g];
        const onCount = cmds.filter(c => map.get(c) === true).length;
        return `${onCount === cmds.length ? '✅' : onCount === 0 ? '❌' : '🔶'} *${g}* (${onCount}/${cmds.length} on)`;
      }).join('\n');

      const infoText =
        `▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜\n` +
        `◤◢ 🎛️ 𝘾𝙊𝙈𝙈𝘼𝙉𝘿 𝙏𝙊𝙂𝙂𝙇𝙀𝙎 ◤◢\n` +
        `▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟\n\n` +
        `${statusLines}\n\n` +
        `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n` +
        `Usage:\n` +
        `.cmdson all — Enable ALL\n` +
        `.cmdsoff all — Disable ALL\n` +
        `.cmdson <name> — Enable one\n` +
        `.cmdsoff <name> — Disable one\n` +
        `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢`;

      const keys = [];

      // Build all buttons in one flat array
      const allButtons = [
        { label: `✅ ${t('btn_enable_all',lang).replace('✅ ','')}`, id: '.cmdson all' },
        { label: `❌ ${t('btn_disable_all',lang).replace('❌ ','')}`, id: '.cmdsoff all' },
        { label: t('btn_settings',lang), id: '.settings' },
        ...groupNames.map(g => {
          const cmds = CMD_GROUPS[g];
          const onCount = cmds.filter(c => map.get(c) === true).length;
          const emoji = onCount === cmds.length ? '✅' : onCount === 0 ? '❌' : '🔶';
          return { label: `${emoji} ${g}`, id: `.cmdtoggle ${g}` };
        }),
      ];

      const r0 = await sendButtons(sock, chat, {
        text: infoText,
        footer: cfg.footer,
        buttons: allButtons,
      });
      if (r0?.key) keys.push(r0.key);

      if (keys.length) settingsButtonKeys.set(chat, keys);
      return;
    }

    // ── cmdtoggle <GroupName> — show individual cmds in that group ──
    if (cmd === 'cmdtoggle') {
      try { await sock.sendMessage(chat, { delete: m.key }); } catch {}
      await deleteSettingsButtons(sock, chat);
      const groupName = text;
      const cmds = CMD_GROUPS[groupName];
      if (!cmds) return m.reply(`❌ Unknown group: *${groupName}*\n\n${cfg.footer}`);

      const botCfg = await db.getBotConfig(m.sessionOwner);
      const map = botCfg.enabledCommands || new Map();

      const keys = [];

      // All buttons in a single message
      const allCmdButtons = [
        { label: `✅ ${t('btn_enable_all',lang).replace('✅ ','')}`, id: `.cmdson group:${groupName}` },
        { label: `❌ ${t('btn_disable_all',lang).replace('❌ ','')}`, id: `.cmdsoff group:${groupName}` },
        { label: t('btn_back',lang), id: '.cmds' },
        ...cmds.map(c => {
          const on = map.get(c) === true;
          return { label: `${on ? '✅' : '❌'} .${c}`, id: `.cmdtoggle1 ${c}` };
        }),
      ];

      const r0 = await sendButtons(sock, chat, {
        text: `🎛️ *${groupName} Commands*
Tap to toggle each command:`,
        footer: cfg.footer,
        buttons: allCmdButtons,
      });
      if (r0?.key) keys.push(r0.key);
      if (keys.length) settingsButtonKeys.set(chat, keys);
      return;
    }

    // ── cmdtoggle1 <cmd> — toggle single command ──
    if (cmd === 'cmdtoggle1') {
      try { await sock.sendMessage(chat, { delete: m.key }); } catch {}
      await deleteSettingsButtons(sock, chat);
      const target = text;
      if (!target) return;
      const botCfg = await db.getBotConfig(m.sessionOwner);
      const map = botCfg.enabledCommands || new Map();
      const current = map.get(target) === true;
      await db.toggleCommand(target, !current, m.sessionOwner);
      const r = await sendButtons(sock, chat, {
        text: `${!current ? '✅' : '❌'} *.${target}* is now *${!current ? 'ENABLED' : 'DISABLED'}*\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [
          { label: `${!current ? '❌ '+t('btn_disable',lang).replace('❌ ','') : '✅ '+t('btn_enable',lang).replace('✅ ','')} .${target}`, id: `.cmdtoggle1 ${target}` },
          { label: '⬅️ Back', id: '.cmds' },
        ],
      });
      if (r?.key) settingsButtonKeys.set(chat, [r.key]);
      return;
    }

    // ── cmdson / cmdsoff ──────────────────────────────────────
    if (cmd === 'cmdson' || cmd === 'cmdsoff') {
      try { await sock.sendMessage(chat, { delete: m.key }); } catch {}
      await deleteSettingsButtons(sock, chat);
      const val = cmd === 'cmdson';
      const arg = text || '';

      let affected = [];
      if (arg === 'all') {
        for (const cmds of Object.values(CMD_GROUPS)) affected.push(...cmds);
      } else if (arg.startsWith('group:')) {
        const gName = arg.replace('group:', '');
        affected = CMD_GROUPS[gName] || [];
      } else if (arg) {
        affected = [arg];
      }

      for (const c of affected) await db.toggleCommand(c, val, m.sessionOwner);

      const r = await sendButtons(sock, chat, {
        text: `${val ? '✅' : '❌'} *${affected.length} command(s) ${val ? 'enabled' : 'disabled'}*\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [
          { label: t('btn_cmd_panel',lang), id: '.cmds' },
          { label: '⚙️ Settings', id: '.settings' },
        ],
      });
      if (r?.key) settingsButtonKeys.set(chat, [r.key]);
      return;
    }

    // ── Main settings panel ───────────────────────────────────
    if (cmd === 'settings') {
      try { await sock.sendMessage(chat, { delete: m.key }); } catch {}
      await deleteSettingsButtons(sock, chat);

      const botCfg = await db.getBotConfig(m.sessionOwner);
      const mode = botCfg?.mode || 'public'; // FIX: always from DB, not global currentMode
      const f = botCfg?.features || {};
      const modeEmoji = { public: '🌐', group: '👥', inbox: '💬', private: '🔒' };

      const settingsText =
        `▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜\n` +
        `◤◢ ⚙️ 𝙐𝙉𝙄𝙏𝙔-𝙈𝘿 𝙎𝙀𝙏𝙏𝙄𝙉𝙂𝙎 ◤◢\n` +
        `▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟\n\n` +
        `🤖 *Bot Mode:* ${modeEmoji[mode] || '🌐'} ${mode.toUpperCase()}\n\n` +
        `*${t('set_auto_features',lang)}*\n` +
        `${f.autoRecording ? '✅' : '❌'} 🎙️ Auto Recording\n` +
        `${f.autoOnline ? '✅' : '❌'} 🟢 Auto Online\n` +
        `${f.autoRead ? '✅' : '❌'} 👁️ Auto Read\n` +
        `${f.autoTyping ? '✅' : '❌'} ⌨️ Auto Typing\n` +
        `${f.autoBio ? '✅' : '❌'} 📝 Auto Bio\n` +
        `${f.antiCall ? '✅' : '❌'} 📵 Anti Call\n` +
        `${f.autoDeleteChat ? '✅' : '❌'} 🗑️ Auto Delete Chat\n` +
        `${f.autoStatusView ? '✅' : '❌'} 👁️ Auto Status View\n` +
        `${f.autoStatusReact ? '✅' : '❌'} ❤️ Auto Status React [${f.autoStatusReactEmoji || '❤️'}]\n\n` +
        `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n® 𝙐𝙉𝙄𝙏𝙔 𝙏𝙀𝘼𝙈\n◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢`;

      const keys = [];
      const r1 = await sendButtons(sock, chat, {
        text: settingsText,
        footer: cfg.footer,
        buttons: [
          // Bot Mode
          { label: `${t('mode_public_btn',lang)}${mode==='public'?' ✅':''}`, id: '.publicmode' },
          { label: `${t('mode_group_btn',lang)}${mode==='group'?' ✅':''}`, id: '.groupmode' },
          { label: `${t('mode_inbox_btn',lang)}${mode==='inbox'?' ✅':''}`, id: '.inboxmode' },
          { label: `${t('mode_private_btn',lang)}${mode==='private'?' ✅':''}`, id: '.privatemode' },
          // Toggle Auto Features
          { label: `${f.autoRecording?'✅':'❌'} ${t('feat_recording',lang)}`, id: '.autorecording' },
          { label: `${f.autoOnline?'✅':'❌'} ${t('feat_online',lang)}`, id: '.autoonline' },
          { label: `${f.autoRead?'✅':'❌'} ${t('feat_autoread',lang)}`, id: '.autoread' },
          { label: `${f.autoTyping?'✅':'❌'} ${t('feat_autotyping',lang)}`, id: '.autotyping' },
          { label: `${f.autoBio?'✅':'❌'} ${t('feat_autobio',lang)}`, id: '.autobio' },
          { label: `${f.antiCall?'✅':'❌'} ${t('feat_anticall',lang)}`, id: '.anticall' },
          // Other
          { label: `${f.autoDeleteChat?'✅':'❌'} 🗑️ Auto Delete Chat`, id: '.autodeletechat' },
          { label: `${f.autoStatusView?'✅':'❌'} 👁️ Status View`, id: '.autostatus' },
          { label: `${f.autoStatusReact?'✅':'❌'} ❤️ Status React`, id: '.autostatusreact' },
          { label: `${f.didYouMean?'✅':'❌'} ${t('feat_didyoumean',lang)}`, id: '.didyoumean' },
          { label: t('feat_cmd_toggles',lang), id: '.cmds' },
        ],
      });
      if (r1?.key) keys.push(r1.key);

      if (keys.length) settingsButtonKeys.set(chat, keys);
      return;
    }

    // ── Bot mode change ───────────────────────────────────────
    const modeCommands = {
      publicmode:  { mode: 'public',  emoji: '🌐', get label(){return t('mode_public_btn',lang);}, get desc(){return t('mode_desc_public',lang);} },
      groupmode:   { mode: 'group',   emoji: '👥', get label(){return t('mode_group_btn',lang);}, get desc(){return t('mode_desc_group',lang);} },
      inboxmode:   { mode: 'inbox',   emoji: '💬', get label(){return t('mode_inbox_btn',lang);}, get desc(){return t('mode_desc_inbox',lang);} },
      privatemode: { mode: 'private', emoji: '🔒', get label(){return t('mode_private_btn',lang);}, get desc(){return t('mode_desc_private',lang);} },
    };
    if (modeCommands[cmd]) {
      try { await sock.sendMessage(chat, { delete: m.key }); } catch {}
      await deleteSettingsButtons(sock, chat);
      const { mode, emoji, label, desc } = modeCommands[cmd];
      // FIX: Do NOT call setBotMode() — that was a global variable shared across
      // ALL sessions causing one user's .privatemode to affect everyone else.
      // We only save to the DB which is already per-session via m.sessionOwner.
      const botCfg = await db.getBotConfig(m.sessionOwner);
      botCfg.mode = mode;
      await botCfg.save();
      const r = await sendButtons(sock, chat, {
        text: `${emoji} *${label} ON*\n\n✅ ${desc}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: '⚙️ Settings', id: '.settings' }],
      });
      if (r?.key) settingsButtonKeys.set(chat, [r.key]);
      return;
    }

    // ── Auto features toggle ──────────────────────────────────
    const autoMap = {
      autorecording:   { key: 'autoRecording',  file: 'autoRecording.json',   get label(){return t('feat_recording',lang);} },
      autoonline:      { key: 'autoOnline',      file: 'autoOnline.json',      get label(){return t('feat_online',lang);} },
      autoread:        { key: 'autoRead',        file: 'autoread.json',        get label(){return t('feat_autoread',lang);} },
      autotyping:      { key: 'autoTyping',      file: 'autoTyping.json',      get label(){return t('feat_autotyping',lang);} },
      autobio:         { key: 'autoBio',         file: 'autoBio.json',         get label(){return t('feat_autobio',lang);} },
      anticall:        { key: 'antiCall',        file: 'anticall.json',        get label(){return t('feat_anticall',lang);} },
      didyoumean:      { key: 'didYouMean',      file: null, get label(){return t('feat_didyoumean',lang);} },
      autodeletechat:  { key: 'autoDeleteChat',  file: null, get label(){return '🗑️ Auto Delete Chat';} },
      autostatus:  { key: 'autoStatusView',  file: null, get label(){return '👁️ Auto Status View';} },
      autostatusreact: { key: 'autoStatusReact', file: null, get label(){return '❤️ Auto Status React';} },
    };
    if (autoMap[cmd]) {
      try { await sock.sendMessage(chat, { delete: m.key }); } catch {}
      await deleteSettingsButtons(sock, chat);
      const { key, label, file } = autoMap[cmd];
      const botCfg = await db.getBotConfig(m.sessionOwner);
      botCfg.features = botCfg.features || {};

      // ── Support: .autoonline / .autoonline on / .autoonline off ──
      const arg = (m.text || '').trim().toLowerCase();
      let currentVal = !!botCfg.features[key];
      let newVal;
      if (arg === 'on') {
        newVal = true;
      } else if (arg === 'off') {
        newVal = false;
      } else {
        // no arg = show current status, do NOT toggle
        const curStatus = currentVal ? '✅ ON' : '❌ OFF';
        const r = await sendButtons(sock, chat, {
          text: `${label}: *${curStatus}*\n\n${t('use_on_off',lang) || 'Use *.'+cmd+' on* or *.'+cmd+' off* to change.'}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `✅ ON`,  id: `.${cmd} on`  },
            { label: `❌ OFF`, id: `.${cmd} off` },
            { label: '📋 Menu', id: '.menu' },
          ],
        });
        if (r?.key) settingsButtonKeys.set(chat, [r.key]);
        return;
      }

      botCfg.features[key] = newVal;
      await botCfg.save();
      const status = newVal ? '✅ ON' : '❌ OFF';

      // ── Save to session-prefixed JSON file so it persists across restarts ────
      if (file) {
        try {
          const _dataDir = require('path').join(process.cwd(), 'data');
          if (!require('fs').existsSync(_dataDir)) require('fs').mkdirSync(_dataDir, { recursive: true });
          const _sessionFile = `${m.sessionOwner || 'default'}_${file}`;
          require('fs').writeFileSync(
            require('path').join(_dataDir, _sessionFile),
            JSON.stringify({ enabled: newVal }, null, 2)
          );
        } catch (_) {}
      }

      // ── Immediately update presence when autoOnline is toggled ──
      if (key === 'autoOnline') {
        try {
          await sock.sendPresenceUpdate(newVal ? 'available' : 'unavailable');
        } catch (_) {}
      }
      const r = await sendButtons(sock, chat, {
        text: `${label}: *${status}*\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [
          { label: `✅ ON`,  id: `.${cmd} on`  },
          { label: `❌ OFF`, id: `.${cmd} off` },
          { label: '📋 Menu', id: '.menu' },
        ],
      });
      if (r?.key) settingsButtonKeys.set(chat, [r.key]);
      return;
    }

    if (cmd === 'botmode') {
      const modeEmoji = { public: '🌐', group: '👥', inbox: '💬', private: '🔒' };
      const botCfg2 = await db.getBotConfig(m.sessionOwner);
      const currentSessionMode = botCfg2?.mode || 'public';
      const r = await sendButtons(sock, chat, {
        text: `🤖 *Current Mode:* ${modeEmoji[currentSessionMode]} *${currentSessionMode.toUpperCase()}*\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [
          { label: t('mode_public_btn',lang), id: '.publicmode' },
          { label: t('mode_group_btn',lang), id: '.groupmode' },
          { label: t('mode_inbox_btn',lang), id: '.inboxmode' },
          { label: t('mode_private_btn',lang), id: '.privatemode' },
        ],
      });
      if (r?.key) settingsButtonKeys.set(chat, [r.key]);
      return;
    }

    if (cmd === 'setprefix') {
      if (!text) return m.reply(`📌 Usage: *.setprefix* [prefix]\n\n${cfg.footer}`);
      const botCfg = await db.getBotConfig(m.sessionOwner);
      botCfg.prefix = text;
      await botCfg.save();
      return m.reply(`✅ *Prefix set to:* ${text}\n\n${cfg.footer}`);
    }

    if (cmd === 'setlang') {
      if (!text) return m.reply(`📌 Usage: *.setlang* [en/si/ta]\n\n${cfg.footer}`);
      const lang = text.toLowerCase();
      if (!['en', 'si', 'ta'].includes(lang)) return m.reply(`❌ Supported: *en*, *si*, or *ta*\n\n${cfg.footer}`);
      const botCfg = await db.getBotConfig(m.sessionOwner);
      botCfg.lang    = lang;
      botCfg.langSet = true;
      await botCfg.save();
      setLangCache(lang, m.sessionOwner);
      const langName = lang === 'en' ? '🇬🇧 English' : lang === 'si' ? '🇱🇰 සිංහල' : '🇱🇰 தமிழ்';
      return m.reply(`✅ *Bot language:* ${langName}\n\n${cfg.footer}`);
    }

    if (cmd === 'mysettings') {
      const user = await db.getUser(sender);
      return m.reply(
        `▛▀▀▀▀▀▀▀▀▀▀▀▀▜\n◤◢ ⚙️ 𝙈𝙔 𝙎𝙀𝙏𝙏𝙄𝙉𝙂𝙎 ◤◢\n▙▄▄▄▄▄▄▄▄▄▄▄▄▟\n\n` +
        `🔤 Prefix: ${user.personalPrefix || cfg.prefixes[0]}\n` +
        `🌐 Language: ${user.personalLang || 'en'}\n` +
        `📛 Bot name: ${user.personalName || cfg.botName}\n` +
        `🔗 Paired: ${user.isPaired ? '✅' : '❌'}\n\n${cfg.footer}`
      );
    }
    if (cmd === 'myprefix') {
      if (!text) return m.reply(`📌 Usage: *.myprefix* [prefix]\n\n${cfg.footer}`);
      const user = await db.getUser(sender); user.personalPrefix = text; await user.save();
      return m.reply(`✅ *Your prefix:* ${text}\n\n${cfg.footer}`);
    }
    if (cmd === 'mylang') {
      if (!text) return m.reply(`📌 Usage: *.mylang* [en/si]\n\n${cfg.footer}`);
      const user = await db.getUser(sender); user.personalLang = text.toLowerCase(); await user.save();
      return m.reply(`✅ *Your language:* ${text}\n\n${cfg.footer}`);
    }
    if (cmd === 'myname') {
      if (!text) return m.reply(`📌 Usage: *.myname* [name]\n\n${cfg.footer}`);
      const user = await db.getUser(sender); user.personalName = text; await user.save();
      return m.reply(`✅ *Bot name (for you):* ${text}\n\n${cfg.footer}`);
    }
    if (cmd === 'myreset') {
      const user = await db.getUser(sender);
      user.personalPrefix = undefined; user.personalLang = 'en'; user.personalName = undefined;
      await user.save();
      return m.reply(`✅ *Personal settings reset!*\n\n${cfg.footer}`);
    }
  },
};
