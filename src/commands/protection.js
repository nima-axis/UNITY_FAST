'use strict';
const { getT } = require('../lang');
const fs = require('fs');
const path = require('path');
const cfg = require('../../config');
const db = require('./index');
const { sendButtons } = require('./helper');

const dataDir = path.join(process.cwd(), 'data');
function ensureDir() { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); }
function readJson(file, def, sid) { ensureDir(); const sf = sid ? `${sid}_${file}` : file; const p = path.join(dataDir, sf); if (!fs.existsSync(p)) { fs.writeFileSync(p, JSON.stringify(def)); return def; } try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return def; } }
function writeJson(file, data, sid) { ensureDir(); const sf = sid ? `${sid}_${file}` : file; fs.writeFileSync(path.join(dataDir, sf), JSON.stringify(data,null,2)); }

module.exports = {
  commands: [
    'antilink', 'antispam',
    'antidelete',
    'anticall',
    'antitoxic', 'antiforward',
    'antiraid', 'flooddetect',
    'badwords', 'addbadword', 'delbadword',
    'antibadword', 'badword',
    'slowmode', 'captcha',
    'welcome', 'setwelcome',
    'goodbye', 'setgoodbye',
    'pmblocker', 'pmblock',
    'autoread',
  ],

  groupOnly: false,

  async run({ sock, m }) {
    const sid = m.sessionOwner || 'default';
    const tr = await getT(m.sessionOwner);
    const cmd  = m.command;
    const text = m.text?.trim();
    const chat = m.chat;
    const msg  = m.msg;
    const isAdmin = m.isGroupAdmin || m.isOwner;

    const toggleButtons = (label, stateKey, file) => {
      const state = readJson(file, {}, sid);
      const groupState = state[chat] || { enabled: false };
      return sendButtons(sock, chat, {
        text: `${label} is *${groupState.enabled ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [
          { label: groupState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.${cmd} ${groupState.enabled ? 'off' : 'on'}` },
          { label: '📋 Menu', id: '.menu' },
        ],
        quoted: msg,
      });
    };

    // ── ANTILINK ──────────────────────────────────────────────
    if (cmd === 'antilink') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!isAdmin) return m.reply(`🔒 Admins only!\n\n${cfg.footer}`);
      const s = m.group?.settings;
      if (!s) return m.reply(`❌ Group not found.\n\n${cfg.footer}`);
      const sub = text?.toLowerCase();
      if (!sub) {
        return sendButtons(sock, chat, {
          text: `🔗 *ANTILINK*\n\nStatus: *${s.antiLink ? 'ON ✅' : 'OFF ❌'}*\n\n*.antilink on/off* — Toggle\n*.antilink set delete/kick/warn* — Set action\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: s.antiLink ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.antilink ${s.antiLink ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'on') { s.antiLink = true; await m.group.save(); return sendButtons(sock, chat, { text: `🔗 Antilink *ON ✅*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '🔴 Turn OFF', id: '.antilink off' }], quoted: msg }); }
      if (sub === 'off') { s.antiLink = false; await m.group.save(); return sendButtons(sock, chat, { text: `🔗 Antilink *OFF ❌*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: '🟢 Turn ON', id: '.antilink on' }], quoted: msg }); }
      if (sub.startsWith('set')) {
        const action = text.split(' ')[1]?.toLowerCase();
        if (!['delete','kick','warn'].includes(action)) return m.reply(`📌 Usage: *.antilink set delete/kick/warn*\n\n${cfg.footer}`);
        s.antiLinkAction = action; await m.group.save();
        return m.reply(`✅ Antilink action set to *${action}*!\n\n${cfg.footer}`);
      }
    }

    // ── ANTISPAM ──────────────────────────────────────────────
    if (cmd === 'antispam') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!isAdmin) return m.reply(`🔒 Admins only!\n\n${cfg.footer}`);
      const s = m.group?.settings; if (!s) return m.reply(`❌ Group not found.\n\n${cfg.footer}`);
      const sub = text?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `🚫 *ANTISPAM*\n\nStatus: *${s.antiSpam ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: s.antiSpam ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.antispam ${s.antiSpam ? 'off' : 'on'}` }], quoted: msg });
      const enable = sub === 'on'; s.antiSpam = enable; await m.group.save();
      return sendButtons(sock, chat, { text: `🚫 Antispam *${enable ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: enable ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.antispam ${enable ? 'off' : 'on'}` }], quoted: msg });
    }

    // ── ANTIDELETE ────────────────────────────────────────────
    if (cmd === 'antidelete') {
      if (!isAdmin && !m.isOwner) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('antidelete.json', { enabled: true }, sid);
      const sub = text?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `🗑️ *ANTIDELETE*\n\nStatus: *${state.enabled ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.antidelete ${state.enabled ? 'off' : 'on'}` }], quoted: msg });
      const enable = sub === 'on'; writeJson('antidelete.json', { enabled: enable }, sid);
      return sendButtons(sock, chat, { text: `🗑️ Antidelete *${enable ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: enable ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.antidelete ${enable ? 'off' : 'on'}` }], quoted: msg });
    }

    // ── ANTICALL ──────────────────────────────────────────────
    if (cmd === 'anticall') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('anticall.json', { enabled: false }, sid);
      const sub = text?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `📞 *ANTICALL*\n\nStatus: *${state.enabled ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.anticall ${state.enabled ? 'off' : 'on'}` }], quoted: msg });
      const enable = sub === 'on'; writeJson('anticall.json', { enabled: enable }, sid);
      return sendButtons(sock, chat, { text: `📞 Anticall *${enable ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: enable ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.anticall ${enable ? 'off' : 'on'}` }], quoted: msg });
    }

    // ── ANTIBADWORD ───────────────────────────────────────────
    if (cmd === 'antibadword' || cmd === 'badword' || cmd === 'badwords' || cmd === 'addbadword' || cmd === 'delbadword') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!isAdmin) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('antibadword.json', {}, sid);
      const groupState = state[chat] || { enabled: false, words: [] };
      const sub = (cmd === 'addbadword') ? 'add' : (cmd === 'delbadword') ? 'remove' : text?.split(' ')[0]?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `🤬 *ANTIBADWORD*\n\nStatus: *${groupState.enabled ? 'ON ✅' : 'OFF ❌'}*\nWords: ${groupState.words.length>0?groupState.words.join(', '):'None'}\n\n*.badword on/off* — Toggle\n*.badword add* [word] — Add\n*.badword remove* [word] — Remove\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: groupState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.badword ${groupState.enabled ? 'off' : 'on'}` }], quoted: msg });
      if (sub === 'on' || sub === 'off') { groupState.enabled = sub==='on'; state[chat]=groupState; writeJson('antibadword.json',state, sid); return sendButtons(sock, chat, { text: `🤬 Antibadword *${sub==='on'?'ON ✅':'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: sub==='on'?'🔴 Turn OFF':'🟢 Turn ON', id: `.badword ${sub==='on'?'off':'on'}` }], quoted: msg }); }
      if (sub === 'add') { const word = (cmd==='addbadword'?text:text?.slice(4))?.trim()?.toLowerCase(); if (!word) return m.reply(`📌 Usage: *.badword add* [word]\n\n${cfg.footer}`); if (!groupState.words.includes(word)) groupState.words.push(word); state[chat]=groupState; writeJson('antibadword.json',state, sid); return m.reply(`✅ Added *${word}*!\n\n${cfg.footer}`); }
      if (sub === 'remove') { const word = (cmd==='delbadword'?text:text?.slice(7))?.trim()?.toLowerCase(); groupState.words=groupState.words.filter(w=>w!==word); state[chat]=groupState; writeJson('antibadword.json',state, sid); return m.reply(`✅ Removed *${word}*!\n\n${cfg.footer}`); }
    }

    // ── WELCOME ───────────────────────────────────────────────
    if (cmd === 'welcome' || cmd === 'setwelcome') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!isAdmin) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('welcome.json', {}, sid);
      const groupState = state[chat] || { enabled: false, message: '' };
      const sub = text?.split(' ')[0]?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `👋 *WELCOME*\n\nStatus: *${groupState.enabled ? 'ON ✅' : 'OFF ❌'}*\nMessage: ${groupState.message||'Default'}\n\n*.welcome on/off* — Toggle\n*.welcome set* [msg] — Custom (use {user}, {group})\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: groupState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.welcome ${groupState.enabled ? 'off' : 'on'}` }], quoted: msg });
      if (sub === 'on' || sub === 'off') { groupState.enabled = sub==='on'; state[chat]=groupState; writeJson('welcome.json',state, sid); return sendButtons(sock, chat, { text: `👋 Welcome *${sub==='on'?'ON ✅':'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: sub==='on'?'🔴 Turn OFF':'🟢 Turn ON', id: `.welcome ${sub==='on'?'off':'on'}` }], quoted: msg }); }
      if (sub === 'set') { const newMsg = text.slice(4).trim(); if (!newMsg) return m.reply(`📌 Usage: *.welcome set* [message]\n\nVariables: {user} {group} {description}\n\n${cfg.footer}`); groupState.message=newMsg; state[chat]=groupState; writeJson('welcome.json',state, sid); return m.reply(`✅ Welcome message updated!\n\n${cfg.footer}`); }
    }

    // ── GOODBYE ───────────────────────────────────────────────
    if (cmd === 'goodbye' || cmd === 'setgoodbye') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!isAdmin) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('goodbye.json', {}, sid);
      const groupState = state[chat] || { enabled: false, message: '' };
      const sub = text?.split(' ')[0]?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `👋 *GOODBYE*\n\nStatus: *${groupState.enabled ? 'ON ✅' : 'OFF ❌'}*\nMessage: ${groupState.message||'Default'}\n\n*.goodbye on/off* — Toggle\n*.goodbye set* [msg] — Custom\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: groupState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.goodbye ${groupState.enabled ? 'off' : 'on'}` }], quoted: msg });
      if (sub === 'on' || sub === 'off') { groupState.enabled = sub==='on'; state[chat]=groupState; writeJson('goodbye.json',state, sid); return sendButtons(sock, chat, { text: `👋 Goodbye *${sub==='on'?'ON ✅':'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: sub==='on'?'🔴 Turn OFF':'🟢 Turn ON', id: `.goodbye ${sub==='on'?'off':'on'}` }], quoted: msg }); }
      if (sub === 'set') { const newMsg = text.slice(4).trim(); if (!newMsg) return m.reply(`📌 Usage: *.goodbye set* [message]\n\n${cfg.footer}`); groupState.message=newMsg; state[chat]=groupState; writeJson('goodbye.json',state, sid); return m.reply(`✅ Goodbye message updated!\n\n${cfg.footer}`); }
    }

    // ── PMBLOCKER ─────────────────────────────────────────────
    if (cmd === 'pmblocker' || cmd === 'pmblock') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('pmblocker.json', { enabled: false, message: '⚠️ PM blocked.' }, sid);
      const sub = text?.split(' ')[0]?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `📩 *PM BLOCKER*\n\nStatus: *${state.enabled ? 'ON ✅' : 'OFF ❌'}*\nMessage: ${state.message}\n\n*.pmblocker on/off* — Toggle\n*.pmblocker setmsg* [text] — Set message\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.pmblocker ${state.enabled ? 'off' : 'on'}` }], quoted: msg });
      if (sub === 'setmsg') { const newMsg = text.slice(7).trim(); if (!newMsg) return m.reply(`📌 Usage: *.pmblocker setmsg* [message]\n\n${cfg.footer}`); writeJson('pmblocker.json', {...state, message: newMsg}, sid); return m.reply(`✅ Message updated!\n\n${cfg.footer}`); }
      const enable = sub === 'on'; writeJson('pmblocker.json', {...state, enabled: enable}, sid);
      return sendButtons(sock, chat, { text: `📩 PM Blocker *${enable ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: enable ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.pmblocker ${enable ? 'off' : 'on'}` }], quoted: msg });
    }

    // ── AUTOREAD ──────────────────────────────────────────────
    if (cmd === 'autoread') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('autoread.json', { enabled: false }, sid);
      const sub = text?.toLowerCase();
      if (!sub || sub === 'status') return sendButtons(sock, chat, { text: `📖 *AUTO READ*\n\nStatus: *${state.enabled ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.autoread ${state.enabled ? 'off' : 'on'}` }], quoted: msg });
      const enable = sub === 'on'; writeJson('autoread.json', { enabled: enable }, sid);
      return sendButtons(sock, chat, { text: `📖 Auto Read *${enable ? 'ON ✅' : 'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: enable ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.autoread ${enable ? 'off' : 'on'}` }], quoted: msg });
    }

    // ── OTHER PROTECTIONS ─────────────────────────────────────
    if (['antitoxic','antiforward','antiraid','flooddetect','slowmode','captcha'].includes(cmd)) {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!isAdmin) return m.reply(`🔒 Admins only!\n\n${cfg.footer}`);
      const s = m.group?.settings; if (!s) return m.reply(`❌ Group not found.\n\n${cfg.footer}`);
      const keyMap = { antitoxic:'antiToxic', antiforward:'antiForward', antiraid:'antiRaid', flooddetect:'floodDetect', slowmode:'slowMode', captcha:'captcha' };
      const key = keyMap[cmd]; const sub2 = text?.toLowerCase();
      const cur = s[key];
      if (!sub2) return sendButtons(sock, chat, { text: `🛡️ *${cmd.toUpperCase()}*\n\nStatus: *${cur ? 'ON ✅' : 'OFF ❌'}*\n\n*.${cmd} on/off*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: cur ? '🔴 Turn OFF' : '🟢 Turn ON', id: `.${cmd} ${cur ? 'off' : 'on'}` }], quoted: msg });
      s[key] = sub2 === 'on'; await m.group.save();
      return sendButtons(sock, chat, { text: `🛡️ ${cmd.toUpperCase()} *${sub2==='on'?'ON ✅':'OFF ❌'}*\n\n${cfg.footer}`, footer: cfg.footer, buttons: [{ label: sub2==='on'?'🔴 Turn OFF':'🟢 Turn ON', id: `.${cmd} ${sub2==='on'?'off':'on'}` }], quoted: msg });
    }
  },
};
