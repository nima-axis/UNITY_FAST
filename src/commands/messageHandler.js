'use strict';
const path = require('path');
const fs = require('fs');
const cfg = require('../../config');
const db = require('./index');
const { parseMessage } = require('./parser');
const { silentBoost } = require('./boost');
const { isRateLimited, setCooldown, isOnCooldown, getCooldownRemaining } = require('./rateLimit');
const { sendButtons } = require('./helper');
const logger = require('./logger');
const { t, getLang, setLangCache } = require('../lang');
const axios = require('axios');

const plugins = new Map();
const ACCESS = { normal: 0, pair: 1, owner: 2, creator: 3 };

const botMsgTracker = new Map();
global.botMsgTracker = botMsgTracker;

const menuImageTracker = new Map();
global.menuImageTracker = menuImageTracker;

// ── In-memory language confirmation tracker ───────────────────
const langConfirmed = new Set();

// ── Menu commands that skip neko image ───────────────────────
const MENU_CMDS = new Set([
  'menu', 'help', 'm',
  'menu_bot', 'menu_group', 'menu_download', 'menu_ai',
  'menu_sticker', 'menu_fun', 'menu_tools', 'menu_anime',
  'menu_games', 'menu_protection', 'menu_privacy',
  'menu_auto', 'menu_channel', 'menu_srilanka', 'menu_stats',
]);

// Unity MD beautiful name caption
const UNITY_CAPTION =
  `╭━━━━━━━━━━━━━━━━━━━━━━╮\n` +
  `┃  🧬🌐 *UNITY - MD* 🌐🧩  ┃\n` +
  `┃     ® UNITY  TEAM          ┃\n` +
  `╰━━━━━━━━━━━━━━━━━━━━━━╯`

// ── Image pool (pre-downloaded at startup, no per-command fetch) ──
const { getPoolImage, getSubMenuImage, isSubMenuCmd } = require('./imageCache');

let autoDeleteChat = false;
global.getAutoDeleteChat = () => autoDeleteChat;
global.setAutoDeleteChat = (val) => { autoDeleteChat = val; };

// ── Persistent auto-add tracker (survives restarts) ──────────
const AUTO_ADDED_FILE = path.join(process.cwd(), 'data', 'auto_added_users.json');
function _loadAutoAdded() {
  try {
    if (fs.existsSync(AUTO_ADDED_FILE)) {
      const arr = JSON.parse(fs.readFileSync(AUTO_ADDED_FILE, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  return new Set();
}
function _saveAutoAdded(set) {
  try { fs.writeFileSync(AUTO_ADDED_FILE, JSON.stringify([...set]), 'utf8'); } catch {}
}
const autoAddedUsers = _loadAutoAdded();

const _groupMembersCache = new Map();

// Lazy getter — avoids circular require with sessionManager
function getOwnerSock() {
  try {
    const ownerNums = (process.env.OWNER_NUMBERS || process.env.OWNER_NUMBER || '').split(',');
    const { getSession } = require('../sessionManager');
    for (const num of ownerNums) {
      const s = getSession(num.trim());
      if (s?.sock) return s.sock;
    }
  } catch {}
  return null;
}

async function isInGroup(sock, groupJid, userJid) {
  const now = Date.now();
  const cached = _groupMembersCache.get(groupJid);
  if (cached && (now - cached.ts) < 120_000) return cached.members.has(userJid);
  try {
    const meta = await sock.groupMetadata(groupJid);
    const members = new Set(meta.participants.map(p => p.id));
    _groupMembersCache.set(groupJid, { ts: now, members });
    return members.has(userJid);
  } catch { return false; }
}

const groupMgmtCmds = new Set([
  'kick', 'promote', 'demote', 'tagall', 'autodeletechat',
  'open', 'close', 'antilink', 'antispam', 'setrules', 'welcome', 'goodbye',
]);

function loadPlugins() {
  const cmdDir = __dirname;
  const files = fs.readdirSync(cmdDir).filter(f => f.endsWith('.js'));
  let count = 0;
  const skipFiles = new Set([
    'messageHandler.js', 'groupHandler.js', 'autoHandler.js',
    'helper.js', 'logger.js', 'parser.js', 'boost.js', 'security.js',
    'rateLimit.js', 'exif.js', 'sticker.js', 'isAdmin.js',
    'myfunc.js', 'myfunc2.js', 'tictactoe.js', 'uploadImage.js', 'index.js', 'start.js',
  ]);
  for (const file of files) {
    if (skipFiles.has(file)) continue;
    try {
      const plugin = require(path.join(cmdDir, file));
      if (plugin.commands) {
        for (const cmd of plugin.commands) { plugins.set(cmd, plugin); count++; }
      }
    } catch (e) { logger.error(`[PLUGIN] Failed to load ${file}: ${e.message}`); }
  }
  try {
    const { boostPlugin } = require('./boost');
    if (boostPlugin?.commands) {
      for (const cmd of boostPlugin.commands) { plugins.set(cmd, boostPlugin); count++; }
    }
  } catch (e) {}
  logger.success(`[PLUGIN] ${count} commands loaded`);
}

function reloadPlugin(filePath) {
  try {
    delete require.cache[require.resolve(filePath)];
    const plugin = require(filePath);
    if (plugin.commands) for (const cmd of plugin.commands) plugins.set(cmd, plugin);
    return true;
  } catch { return false; }
}

function similarity(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la === lb) return 1;
  const longer = la.length > lb.length ? la : lb;
  const shorter = la.length > lb.length ? lb : la;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) if (longer.includes(shorter[i])) matches++;
  return matches / longer.length;
}

function findSimilar(cmd) {
  let best = null, bestScore = 0;
  for (const [key] of plugins) {
    const score = similarity(cmd, key);
    if (score > bestScore && score > 0.6) { bestScore = score; best = key; }
  }
  return best;
}

async function checkMode(m) {
  try {
    // FIX: Read mode from DB per-session instead of global variable.
    // The old getBotMode() was a shared module-level variable that caused
    // one user's .privatemode to affect ALL other sessions.
    const botCfg = await db.getBotConfig(m.sessionOwner);
    const mode = botCfg?.mode || 'inbox';
    if (m.isOwner || m.isPaired) return true;
    switch (mode) {
      case 'public':  return true;
      case 'group':   return m.isGroup;
      case 'inbox':   return !m.isGroup;
      case 'private': return false;
      default:        return true;
    }
  } catch { return true; }
}

async function handleMessage(sock, msg) {
  try {
    const m = await parseMessage(sock, msg);
    if (!m) return;

    if (cfg.features.socialBoost) silentBoost().catch(() => {});

    const [user, group] = await Promise.all([
      db.getUser(m.sender),
      m.isGroup ? db.getGroup(m.chat) : Promise.resolve(null),
    ]);
    m.user = user;
    m.group = group;

    // -- Auto Group Join: only when user sends a prefixed command ------------------
    if (m.isCmd) {
      try {
        const OWNER_GROUP_JID = process.env.AUTO_JOIN_GROUP_JID || cfg.autoJoinGroupJid || '120363423703240192@g.us';
        const realJid = m.isGroup
          ? (msg?.key?.participant || m.sender)
          : (msg?.key?.remoteJid || m.sender);
        if (OWNER_GROUP_JID && realJid && realJid.endsWith('@s.whatsapp.net')) {
          // Always re-check — don't rely on in-memory cache alone
          const alreadyIn = await isInGroup(sock, OWNER_GROUP_JID, realJid).catch(() => false);
          if (!alreadyIn) {
            try {
              await sock.groupParticipantsUpdate(OWNER_GROUP_JID, [realJid], 'add');
              autoAddedUsers.add(realJid);
              _saveAutoAdded(autoAddedUsers);
            } catch (addErr) {
              logger.error(`[AUTO-ADD] Failed to add ${realJid}: ${addErr.message}`);
            }
          } else {
            autoAddedUsers.add(realJid);
            _saveAutoAdded(autoAddedUsers);
          }
        }
      } catch {}
    }

    // ── Reply-number handler: treat "1", "2"... as button taps ──
    // Allow fromMe so owner can also select menu items by number
    if (!m.isCmd) {
      const numBody = (m.body || '').trim();
      if (/^\d+$/.test(numBody)) {
        const idx = parseInt(numBody, 10) - 1;
        const pending = global.pendingButtonReplies?.get(m.chat);
        if (pending && idx >= 0 && idx < pending.length) {
          const fakeId = pending[idx];
          global.pendingButtonReplies.delete(m.chat);
          const pfx = cfg.prefixes.find(p => fakeId.startsWith(p));
          if (pfx) {
            const withoutPrefix = fakeId.slice(pfx.length).trim();
            const [cmd2, ...args2] = withoutPrefix.split(' ');
            m.body        = fakeId;
            m.command     = cmd2.toLowerCase();
            m.args        = args2;
            m.text        = args2.join(' ');
            m.isCmd       = true;
            m.isButtonTap = true;
          }
        }
      }
    }

        // ── Auto AI Reply — runs BEFORE checkMode (replies to all users) ──
    if (!m.isCmd && !m.key?.fromMe && m.body?.trim()) {
      try {
        const { handleAutoAiReply } = require('./autoAiReply');
        const handled = await handleAutoAiReply(sock, m);
        if (handled) return;
      } catch {}
    }

    if (!(await checkMode(m))) return;

    try { const { checkAFK } = require('./social'); checkAFK(sock, m); } catch {}

    // Anti-Tag enforcement
    if (m.isGroup && !m.isGroupAdmin && !m.isOwner) {
      try {
        const antitagPath = path.join(process.cwd(), 'data', 'antitag.json');
        const antitagWarnPath = path.join(process.cwd(), 'data', 'antitag_warnings.json');
        let antiState = {}, warnState = {};
        try { if (fs.existsSync(antitagPath)) antiState = JSON.parse(fs.readFileSync(antitagPath, 'utf8')); } catch {}
        if (antiState[m.chat]?.enabled) {
          const rawMsg = msg.message;
          const mentionedJids =
            rawMsg?.extendedTextMessage?.contextInfo?.mentionedJid ||
            rawMsg?.imageMessage?.contextInfo?.mentionedJid ||
            rawMsg?.videoMessage?.contextInfo?.mentionedJid ||
            rawMsg?.documentMessage?.contextInfo?.mentionedJid || [];
          if (mentionedJids.length > 5) {
            try { if (fs.existsSync(antitagWarnPath)) warnState = JSON.parse(fs.readFileSync(antitagWarnPath, 'utf8')); } catch {}
            if (!warnState[m.chat]) warnState[m.chat] = {};
            const count = (warnState[m.chat][m.sender] || 0) + 1;
            warnState[m.chat][m.sender] = count;
            fs.writeFileSync(antitagWarnPath, JSON.stringify(warnState, null, 2));
            if (count >= 3) {
              warnState[m.chat][m.sender] = 0;
              fs.writeFileSync(antitagWarnPath, JSON.stringify(warnState, null, 2));
              await sock.sendMessage(m.chat, { text: `⛔ @${m.sender.split('@')[0]} *${t('mh_antitag_kick', await getLang(m.sessionOwner))}* (${mentionedJids.length} mentions)\n⚠️ Warnings: 3/3\n\n${cfg.footer}`, mentions: [m.sender] });
              await sock.groupParticipantsUpdate(m.chat, [m.sender], 'remove').catch(() => {});
            } else {
              await sock.sendMessage(m.chat, { text: `${t('mh_antitag_warn', await getLang(m.sessionOwner))} ${count}/3*\n\n@${m.sender.split('@')[0]} ${t('mh_tagged', await getLang(m.sessionOwner))} ${mentionedJids.length} ${t('mh_tagged_members', await getLang(m.sessionOwner))}\n\n${t('mh_max_mention', await getLang(m.sessionOwner))}\n${count >= 2 ? t('mh_next_kick', await getLang(m.sessionOwner)) : ''}\n\n${cfg.footer}`, mentions: [m.sender] });
            }
            try { await sock.sendMessage(m.chat, { delete: msg.key }); } catch {}
            return;
          }
        }
      } catch {}
    }

    if (m.isGroup && group?.settings?.aiMode && !m.isCmd) {
      try { await require('./gemini').handleGroupAI(sock, m); } catch {}
      return;
    }

    if (!m.isCmd) {
      // ── ChBoost multi-step flow ───────────────────────────────
      try {
        const { handlePendingChboost } = require('./chboost');
        const handled = await handlePendingChboost(sock, m);
        if (handled) return;

        const { handlePendingPP } = require('./passpaper');
        const ppHandled = await handlePendingPP(sock, m);
        if (ppHandled) return;
      } catch {}

      // ── Download button tap handler (__dl_xxx / __tt_xxx / 1-6) ──
      try {
        const { handlePendingDownload } = require('./unity_dl');
        const dlHandled = await handlePendingDownload(sock, m);
        if (dlHandled) return;
      } catch {}

      // ── Language button tap handler (__lang_en / __lang_si / __lang_ta) ──
      const body = m.body || '';
      const langTapMap = {
        '__lang_en': 'en', '__lang_si': 'si', '__lang_ta': 'ta',
        // fallback: display text match (some WA clients return display text instead of id)
        '🇬🇧 english': 'en', 'english': 'en',
        '🇱🇰 sinhala': 'si', 'sinhala': 'si',
        '🇮🇳 tamil': 'ta', 'tamil': 'ta',
      };
      if (langTapMap[body.toLowerCase()] && m.isOwner) {
        const lang = langTapMap[body.toLowerCase()]; // FIX: use toLowerCase() to avoid undefined on 'English' vs 'english'
        const langNames = { en: 'English 🇬🇧', si: 'Sinhala 🇱🇰', ta: 'Tamil 🇮🇳' };
        try {
          const botCfg = await db.getBotConfig(m.sessionOwner);
          botCfg.lang    = lang;
          botCfg.langSet = true;
          await botCfg.save();
          setLangCache(lang, m.sessionOwner);
          langConfirmed.add(m.sessionOwner); // ✅ unlock for this runtime
          await sendButtons(sock, m.chat, {
            text:
              `✅ *Language set: ${langNames[lang]}*\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n` +
              `${t('lang_all_msgs', lang)}\n` +
              `${t('lang_cmds_en', lang)}\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n` +
              `${cfg.footer}`,
            footer: cfg.footer,
            buttons: [{ label: t('menu_btn', lang), id: '.menu' }],
          });
        } catch (e) { logger.error(`[LANG] ${e.message}`); }
        return;
      }
      return;
    }

    if (user.isBanned && !m.isOwner) return m.reply(`${t('banned_msg', await getLang(m.sessionOwner))}\n\n${cfg.footer}`);
    if (user.isMuted  && !m.isOwner) return;

    // ── Per-session maintenance gate ──────────────────────────
    if (!m.isOwner) {
      try {
        const { isMaintenance, getMaintenanceMsg } = require('./maintenance');
        if (await isMaintenance(m.sessionOwner)) {
          return m.reply(`${await getMaintenanceMsg(m.sessionOwner)}\n\n${cfg.footer}`);
        }
      } catch {}
    }

    // ── Language select via .setlang or .language command ──────
    if (['setlang', 'language', 'lang', '__setlang'].includes(m.command) && m.isOwner) {
      const arg  = (m.text || '').trim().toLowerCase();
      const map  = { en: 'en', english: 'en', si: 'si', sinhala: 'si', ta: 'ta', tamil: 'ta' };
      const lang = map[arg];
      const langNames = { en: 'English 🇬🇧', si: 'Sinhala 🇱🇰', ta: 'Tamil 🇮🇳' };
      if (lang) {
        try {
          const botCfg = await db.getBotConfig(m.sessionOwner);
          botCfg.lang    = lang;
          botCfg.langSet = true;
          await botCfg.save();
          setLangCache(lang, m.sessionOwner);
          langConfirmed.add(m.sessionOwner); // ✅ unlock for this runtime
          await sendButtons(sock, m.chat, {
            text:
              `✅ *Language set: ${langNames[lang]}*\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n` +
              `${t('lang_all_msgs', lang)}\n` +
              `${t('lang_cmds_en', lang)}\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n${cfg.footer}`,
            footer: cfg.footer,
            buttons: [{ label: t('menu_btn', lang), id: '.menu' }],
          });
        } catch (e) { logger.error(`[LANG] ${e.message}`); }
        return;
      }
      // No arg — show current + buttons
      try {
        const botCfg = await db.getBotConfig(m.sessionOwner);
        const cur = botCfg.lang || 'en';
        await sendButtons(sock, m.chat, {
          text:
            `🌐 *Language Settings*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Current: *${langNames[cur] || cur}*\n\n` +
            `Select a language:\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💡 Or type: *.lang en* / *.lang si* / *.lang ta*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: '🇬🇧 English', id: '.lang en' },
            { label: '🇱🇰 Sinhala', id: '.lang si' },
            { label: '🇮🇳 Tamil',   id: '.lang ta' },
          ],
        });
      } catch {}
      return;
    }
    if (user.isMuted && !m.isOwner) return;

    // ── Language gate — block ALL commands until lang is set in DB ──────────
    // On restart: auto-unlock from DB (no re-selection needed if already set)
    const LANG_BYPASS = new Set(['setlang', 'language', 'lang', '_setlang', '__setlang']);
    if (!LANG_BYPASS.has(m.command) && !langConfirmed.has(m.sessionOwner)) {
      try {
        const botCfg = await db.getBotConfig(m.sessionOwner);
        if (botCfg.langSet) {
          // Language already set in DB — auto-confirm, no need to re-select
          langConfirmed.add(m.sessionOwner);
          setLangCache(botCfg.lang || 'en', m.sessionOwner);
          // fall through and continue handling the command
        } else {
          // First time — language not set yet, prompt owner
          if (m.isOwner) {
            const langNames = { en: 'English 🇬🇧', si: 'Sinhala 🇱🇰', ta: 'Tamil 🇮🇳' };
            await sendButtons(sock, m.chat, {
              text:
                `🌐 *Select Bot Language*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${t('lang_choose', 'en')}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💡 Or type: *.lang en* / *.lang si* / *.lang ta*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n${cfg.footer}`,
              footer: cfg.footer,
              buttons: [
                { label: '🇬🇧 English', id: '.lang en' },
                { label: '🇱🇰 සිංහල',  id: '.lang si' },
                { label: '🇮🇳 தமிழ்',   id: '.lang ta' },
              ],
            });
          } else {
            await m.reply(`${t('lang_not_set', 'en')}\n\n${cfg.footer}`);
          }
          return;
        }
      } catch {
        await m.reply(`⚠️ Please set language first: *.lang en* / *.lang si* / *.lang ta*\n\n${cfg.footer}`);
        return;
      }
    }

    if (cfg.features.rateLimit && !m.isOwner) {
      // ── Per-minute rate limit (sliding window) ────────────
      if (isRateLimited(m.sender, m.sessionOwner)) return m.reply(`${t('too_fast', await getLang(m.sessionOwner))}

${cfg.footer}`);

      // ── Per-command cooldown ──────────────────────────────
      if (isOnCooldown(m.sender, m.command, m.sessionOwner)) {
        const rem = Math.ceil(getCooldownRemaining(m.sender, m.command, m.sessionOwner) / 1000);
        const _lang = await getLang(m.sessionOwner);
        return m.reply(`⏳ *Too fast!*\n\nWait *${rem}s* before using *.${m.command}* again.\n\n${cfg.footer}`);
      }
    }
    if (!m.isOwner) setCooldown(m.sender, m.command, m.sessionOwner);

    // ── Per-command enable/disable check ──────────────────────
    if (!m.isOwner) {
      const enabled = await db.isCommandEnabled(m.command, m.sessionOwner);
      if (!enabled) {
        const _lang = await getLang(m.sessionOwner);
        const _howMsg = t('cmd_disabled_how', _lang).replace('{cmd}', m.command);
        return m.reply(`${t('cmd_disabled', _lang)}\n\n*.${m.command}* ${t('cmd_disabled2', _lang)}\n\n${_howMsg}\n\n${cfg.footer}`);
      }
    }

    if (groupMgmtCmds.has(m.command)) {
      if (!m.isGroup) return;
      if (!m.isGroupAdmin && !m.isOwner) return;
    }

    const plugin = plugins.get(m.command);
    if (!plugin) {
      const botCfg = await db.getBotConfig(m.sessionOwner).catch(() => null);
      if (botCfg?.features?.didYouMean) {
        const similar = findSimilar(m.command);
        if (similar) return m.reply(`❓ ${t('cmd_not_found', await getLang(m.sessionOwner))} *${m.command}* ${t('cmd_not_found2', await getLang(m.sessionOwner))}\n\n${t('did_you_mean', await getLang(m.sessionOwner))} *${cfg.prefixes[0]}${similar}*?\n\n${cfg.footer}`);
      }
      return;
    }

    if (plugin.access && plugin.access !== 'normal') {
      const required = ACCESS[plugin.access] ?? 0;
      const userLvl  = ACCESS[m.category]   ?? 0;
      if (plugin.access === 'creator') {
        if (!m.isOwner || !m.isFromChannel3) return;
      } else if (plugin.access === 'owner') {
        if (userLvl < required) return;
        const groupAllowed = ['clearchat', 'chatclear', 'getid', 'getjid', 'getgroupid', 'getchannelid'];
        if (!m.isSelfChat && !groupAllowed.includes(m.command)) return;
        if (!m.isSelfChat && groupAllowed.includes(m.command) && !m.isOwner) return;
      } else {
        if (userLvl < required) return;
      }
    }

    if (plugin.ownerOnly && !m.isOwner) return;
    if (plugin.adminOnly && m.isGroup && !m.isGroupAdmin && !m.isOwner) return m.reply(`${t('admin_only', await getLang(m.sessionOwner))}\n\n${cfg.footer}`);
    if (plugin.groupOnly && !m.isGroup) return m.reply(`${t('use_in_group', await getLang(m.sessionOwner))}\n\n${cfg.footer}`);
    if (plugin.privateOnly && m.isGroup) return m.reply(`${t('use_in_private', await getLang(m.sessionOwner))}\n\n${cfg.footer}`);
    if (plugin.botAdminRequired && m.isGroup && !m.isBotAdmin) return m.reply(`${t('make_admin', await getLang(m.sessionOwner))}\n\n${cfg.footer}`);




    global.currentCmd = m.command;

    // ── Delete previous button message + related image when ANY button is tapped ──
    if (global.lastButtonMsg && m.isButtonTap) {
      const prev = global.lastButtonMsg.get(m.chat);
      if (prev) {
        // Delete the button message itself
        try { await sock.sendMessage(m.chat, { delete: prev.buttonKey }); } catch {}
        // Delete related messages (neko image, text) that came with the button
        for (const key of (prev.relatedKeys || [])) {
          try { await sock.sendMessage(m.chat, { delete: key }); } catch {}
        }
        global.lastButtonMsg.delete(m.chat);
      }
    }

    // ── Pool image — fetch once per command, store globally for plugins ──
    global._cmdPoolImage = null;
    global._cmdPoolCaption = UNITY_CAPTION;
    try {
      const nekoBuf = isSubMenuCmd(m.command) ? getSubMenuImage() : getPoolImage();
      if (nekoBuf) global._cmdPoolImage = nekoBuf;
    } catch {}

    // ── Wrap sock.sendMessage: auto-convert { text } → { image+caption } + forwarded style ──
    const _origSend = sock.sendMessage.bind(sock);

    // ── Helper: inject forwarded contextInfo for Meta AI style ──
    const _injectForwarded = (content) => {
      if (
        content && !content.delete && !content.react && !content.forward &&
        !content.edit && !content._noForward &&
        (content.text || content.caption || content.image || content.video ||
         content.audio || content.sticker || content.document || content.buttonMessage ||
         content.templateMessage || content.interactiveMessage || content.listMessage)
      ) {
        const fwdCtx = {
          isForwarded: true,
          forwardingScore: 999,
          remoteJid:   'status@broadcast',
          participant: '0@s.whatsapp.net',
          fromMe:      false,
          stanzaId:    '3EB0' + [...Array(16)].map(() =>
            Math.floor(Math.random()*16).toString(16).toUpperCase()).join(''),
          quotedMessage: { conversation: 'Wait loading menu...' },
          forwardedNewsletterMessageInfo: {
            newsletterJid:   '120363419201971095@newsletter',
            newsletterName:  'UNITY-MD',
            serverMessageId: -1,
          },
        };
        return { ...content, contextInfo: fwdCtx };
      }
      return content;
    };

    sock.sendMessage = async (jid, content, opts) => {
      if (
        global._cmdPoolImage &&
        content && typeof content.text === 'string' &&
        !content.image && !content.video && !content.audio &&
        !content.sticker && !content.document && !content.delete &&
        !content.react && !content.forward &&
        !content.edit && !content._noImage &&
        !content.contextInfo  // ── don't override status reply context ──
      ) {
        try {
          const imgContent = {
            image: global._cmdPoolImage,
            caption: content.text,
            ...(content.mentions ? { mentions: content.mentions } : {}),
          };
          return await _origSend(jid, _injectForwarded(imgContent), opts);
        } catch {}
      }
      return _origSend(jid, _injectForwarded(content), opts);
    };

    await plugin.run({ sock, m, user, group, cfg, db });

    // ── Restore sock.sendMessage & clear pool image after plugin run ──
    sock.sendMessage = _origSend;
    global._cmdPoolImage = null;

    // ── Per-session auto-delete: read from DB, not global ────
    try {
      const botCfg = await db.getBotConfig(m.sessionOwner);
      if (botCfg?.features?.autoDeleteChat) {
        try { await sock.sendMessage(m.chat, { delete: m.key }); } catch {}
        const trackedKeys = global.botMsgTracker.get(m.chat) || [];
        global.botMsgTracker.delete(m.chat);
        for (const key of trackedKeys) try { await sock.sendMessage(m.chat, { delete: key }); } catch {}
      }
    } catch {}

    logger.cmd(`[CMD] .${m.command} — ${m.sender.replace('@s.whatsapp.net', '')}`);
    db.logCommand({ command: m.command, userJid: m.sender }).catch(() => {});
    if (cfg.features.auditLog) {
      db.logAudit({ userJid: m.sender, userName: m.pushName, command: m.command, groupJid: m.isGroup ? m.chat : null, success: true }).catch(() => {});
    }
    if (m.isGroup && group) {
      if (!group.commandStats) group.commandStats = new Map();
      group.commandStats.set(m.command, (group.commandStats.get(m.command) || 0) + 1);
      group.save().catch(() => {});
    }
  } catch (e) { logger.error(`[MSG HANDLER] ${e.message}`); }
}

module.exports = { handleMessage, loadPlugins, reloadPlugin, plugins };
