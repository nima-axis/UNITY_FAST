'use strict';
const { getT } = require('../lang');
const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const cfg = require('../../config');
const { sendButtons } = require('./helper');

const dataDir = path.join(process.cwd(), 'data');

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function readJson(file, def, sessionId, sid) {
  ensureDir();
  // Session-prefixed file first, then legacy global file
  const sessionFile = sessionId ? `${sessionId}_${file}` : file;
  const p = path.join(dataDir, sessionFile);
  if (!fs.existsSync(p)) { fs.writeFileSync(p, JSON.stringify(def)); return def; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

function writeJson(file, data, sessionId, sid) {
  ensureDir();
  const sessionFile = sessionId ? `${sessionId}_${file}` : file;
  fs.writeFileSync(path.join(dataDir, sessionFile), JSON.stringify(data, null, 2));
}

// ── Antidelete store ──────────────────────────────────────────
const messageStore = new Map();

module.exports = {
  commands: [
    'anticall', 'antidelete', 'pmblocker', 'pmblock',
    'antibadword', 'badword',
    'welcome', 'setwelcome', 'goodbye', 'setgoodbye',
    'autoread',
    // ── Unity auto features ───────────────────────────────────
    'autoreact', 'setreactemojis',
    'autopresence', 'setpresencetype',
    'autoblock',
    'autovoice', 'addautovoice', 'listautovoice', 'delautovoice',
    'autostickerreply', 'addautosticker', 'listautosticker', 'delautosticker',
    'autoreply', 'addautoreply', 'listautoreply', 'delautoreply',
    'moroccoblock',
  ],

  async run({ sock, m }) {
    const tr = await getT(m.sessionOwner);
    const sid = m.sessionOwner || 'default'; // session ID for per-user file isolation
    const cmd = m.command;
    const chat = m.chat;
    const msg = m.msg;
    const text = m.text?.trim();

    // ── ANTICALL ──────────────────────────────────────────────
    if (cmd === 'anticall') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('anticall.json', { enabled: false }, sid);
      const sub = text?.toLowerCase();
      if (!sub || !['on', 'off', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *ANTICALL*\n\n*.anticall on* — Block calls\n*.anticall off* — Allow calls\n*.anticall status* — Current status\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.anticall ${state.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') {
        return sendButtons(sock, chat, {
          text: `📞 *Anticall:* ${state.enabled ? '✅ ON' : '❌ OFF'}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.anticall ${state.enabled ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      const enable = sub === 'on';
      writeJson('anticall.json', { enabled: enable }, sid);
      return sendButtons(sock, chat, {
        text: `📞 *Anticall* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.anticall ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── ANTIDELETE ────────────────────────────────────────────
    if (cmd === 'antidelete') {
      if (!m.isOwner && !m.isGroupAdmin) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('antidelete.json', { enabled: true }, sid);
      const sub = text?.toLowerCase();
      if (!sub || !['on', 'off', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *ANTIDELETE*\n\n*.antidelete on* — Reveal deleted messages\n*.antidelete off* — Disable\n*.antidelete status* — Check status\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.antidelete ${state.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') {
        return sendButtons(sock, chat, {
          text: `🗑️ *Antidelete:* ${state.enabled ? '✅ ON' : '❌ OFF'}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.antidelete ${state.enabled ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      const enable = sub === 'on';
      writeJson('antidelete.json', { enabled: enable }, sid);
      return sendButtons(sock, chat, {
        text: `🗑️ *Antidelete* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.antidelete ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── PMBLOCKER ─────────────────────────────────────────────
    if (cmd === 'pmblocker' || cmd === 'pmblock') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('pmblocker.json', { enabled: false, message: '⚠️ PM blocked. Contact owner in group.' }, sid);
      const sub = text?.split(' ')[0]?.toLowerCase();
      if (!sub || !['on', 'off', 'status', 'setmsg'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *PM BLOCKER*\n\n*.pmblocker on/off* — Toggle\n*.pmblocker status* — Check\n*.pmblocker setmsg* [text] — Set message\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.pmblocker ${state.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') {
        return sendButtons(sock, chat, {
          text: `📩 *PM Blocker:* ${state.enabled ? '✅ ON' : '❌ OFF'}\n📝 *Message:* ${state.message}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.pmblocker ${state.enabled ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      if (sub === 'setmsg') {
        const newMsg = text.slice(7).trim();
        if (!newMsg) return m.reply(`📌 Usage: *.pmblocker setmsg* [message]\n\n${cfg.footer}`);
        writeJson('pmblocker.json', { ...state, message: newMsg }, sid);
        return m.reply(`✅ PM blocker message updated!\n\n${cfg.footer}`);
      }
      const enable = sub === 'on';
      writeJson('pmblocker.json', { ...state, enabled: enable }, sid);
      return sendButtons(sock, chat, {
        text: `📩 *PM Blocker* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.pmblocker ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── ANTIBADWORD ───────────────────────────────────────────
    if (cmd === 'antibadword' || cmd === 'badword') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!m.isGroupAdmin && !m.isOwner) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('antibadword.json', {}, sid);
      const groupState = state[chat] || { enabled: false, words: [] };
      const sub = text?.split(' ')[0]?.toLowerCase();
      if (!sub || !['on', 'off', 'add', 'remove', 'list', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *ANTIBADWORD*\n\n*.badword on* — Enable\n*.badword off* — Disable\n*.badword add* [word] — Add word\n*.badword remove* [word] — Remove word\n*.badword list* — Show words\n\nStatus: *${groupState.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${groupState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.badword ${groupState.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'on' || sub === 'off') {
        groupState.enabled = sub === 'on';
        state[chat] = groupState;
        writeJson('antibadword.json', state, sid);
        return sendButtons(sock, chat, {
          text: `🤬 *Antibadword* ${sub === 'on' ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${sub === 'on' ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.badword ${sub === 'on' ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      if (sub === 'add') {
        const word = text.slice(4).trim().toLowerCase();
        if (!word) return m.reply(`📌 Usage: *.badword add* [word]\n\n${cfg.footer}`);
        if (!groupState.words.includes(word)) groupState.words.push(word);
        state[chat] = groupState;
        writeJson('antibadword.json', state, sid);
        return m.reply(`✅ Added *${word}* to bad words list!\n\n${cfg.footer}`);
      }
      if (sub === 'remove') {
        const word = text.slice(7).trim().toLowerCase();
        groupState.words = groupState.words.filter(w => w !== word);
        state[chat] = groupState;
        writeJson('antibadword.json', state, sid);
        return m.reply(`✅ Removed *${word}* from bad words list!\n\n${cfg.footer}`);
      }
      if (sub === 'list' || sub === 'status') {
        return sendButtons(sock, chat, {
          text: `🤬 *Bad Words List*\n\nStatus: *${groupState.enabled ? 'ON' : 'OFF'}*\nWords: ${groupState.words.length > 0 ? groupState.words.map(w => `\`${w}\``).join(', ') : 'None'}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }
    }

    // ── WELCOME ───────────────────────────────────────────────
    if (cmd === 'welcome' || cmd === 'setwelcome') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!m.isGroupAdmin && !m.isOwner) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('welcome.json', {}, sid);
      const groupState = state[chat] || { enabled: false, message: '' };
      const sub = text?.split(' ')[0]?.toLowerCase();

      if (!sub || !['on', 'off', 'set', 'reset', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *WELCOME*\n\n*.welcome on* — Enable\n*.welcome off* — Disable\n*.welcome set* [msg] — Custom message (use {user}, {group})\n*.welcome status* — Check\n\nStatus: *${groupState.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${groupState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.welcome ${groupState.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'on' || sub === 'off') {
        groupState.enabled = sub === 'on';
        state[chat] = groupState;
        writeJson('welcome.json', state, sid);
        return sendButtons(sock, chat, {
          text: `👋 *Welcome* ${sub === 'on' ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${sub === 'on' ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.welcome ${sub === 'on' ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      if (sub === 'set') {
        const newMsg = text.slice(4).trim();
        if (!newMsg) return m.reply(`📌 Usage: *.welcome set* [message]\n\nVariables: {user} {group} {description}\n\n${cfg.footer}`);
        groupState.message = newMsg;
        state[chat] = groupState;
        writeJson('welcome.json', state, sid);
        return m.reply(`✅ Welcome message updated!\n\n${cfg.footer}`);
      }
      if (sub === 'status') {
        return m.reply(`👋 *Welcome:* ${groupState.enabled ? '✅ ON' : '❌ OFF'}\n📝 *Message:* ${groupState.message || 'Default'}\n\n${cfg.footer}`);
      }
      if (sub === 'reset') {
        groupState.message = '';
        state[chat] = groupState;
        writeJson('welcome.json', state, sid);
        return m.reply(`✅ Welcome message reset to default!\n\n${cfg.footer}`);
      }
    }

    // ── GOODBYE ───────────────────────────────────────────────
    if (cmd === 'goodbye' || cmd === 'setgoodbye') {
      if (!m.isGroup) return m.reply(`${tr('err_group_only')}\n\n${cfg.footer}`);
      if (!m.isGroupAdmin && !m.isOwner) return m.reply(`${tr('err_admins_only')}\n\n${cfg.footer}`);
      const state = readJson('goodbye.json', {}, sid);
      const groupState = state[chat] || { enabled: false, message: '' };
      const sub = text?.split(' ')[0]?.toLowerCase();

      if (!sub || !['on', 'off', 'set', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *GOODBYE*\n\n*.goodbye on* — Enable\n*.goodbye off* — Disable\n*.goodbye set* [msg] — Custom message (use {user}, {group})\n*.goodbye status* — Check\n\nStatus: *${groupState.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${groupState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.goodbye ${groupState.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'on' || sub === 'off') {
        groupState.enabled = sub === 'on';
        state[chat] = groupState;
        writeJson('goodbye.json', state, sid);
        return sendButtons(sock, chat, {
          text: `👋 *Goodbye* ${sub === 'on' ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${sub === 'on' ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.goodbye ${sub === 'on' ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      if (sub === 'set') {
        const newMsg = text.slice(4).trim();
        if (!newMsg) return m.reply(`📌 Usage: *.goodbye set* [message]\n\nVariables: {user} {group}\n\n${cfg.footer}`);
        groupState.message = newMsg;
        state[chat] = groupState;
        writeJson('goodbye.json', state, sid);
        return m.reply(`✅ Goodbye message updated!\n\n${cfg.footer}`);
      }
      if (sub === 'status') {
        return m.reply(`👋 *Goodbye:* ${groupState.enabled ? '✅ ON' : '❌ OFF'}\n📝 *Message:* ${groupState.message || 'Default'}\n\n${cfg.footer}`);
      }
    }

    // ── AUTOREAD ──────────────────────────────────────────────
    if (cmd === 'autoread') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('autoread.json', { enabled: false }, sid);
      const sub = text?.toLowerCase();
      if (!sub || !['on', 'off', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *AUTO READ*\n\n*.autoread on* — Auto read messages\n*.autoread off* — Disable\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoread ${state.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') return m.reply(`📖 *Auto Read:* ${state.enabled ? '✅ ON' : '❌ OFF'}\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('autoread.json', { enabled: enable }, sid);
      return sendButtons(sock, chat, {
        text: `📖 *Auto Read* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoread ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ══════════════════════════════════════════════════════════
    // UNITY AUTO FEATURES
    // ══════════════════════════════════════════════════════════

    // ── AUTO REACT ────────────────────────────────────────────
    if (cmd === 'autoreact') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('autoReact.json', { enabled: false, emojis: ['❤️','🩷','🧡','💛','💚','🩵','💙','💜'] }, sid);
      const sub   = text?.toLowerCase();
      if (!sub || !['on', 'off', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *AUTO REACT*\n\n*.autoreact on* — React to every message\n*.autoreact off* — Disable\n*.setreactemojis* [e1,e2,...] — Custom emojis\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*\nEmojis: ${state.emojis.join(' ')}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoreact ${state.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') return m.reply(`⚡ *Auto React:* ${state.enabled ? '✅ ON' : '❌ OFF'}\nEmojis: ${state.emojis.join(' ')}\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('autoReact.json', { ...state, enabled: enable }, sid);
      cfg.features.autoReact = enable;
      return sendButtons(sock, chat, {
        text: `⚡ *Auto React* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoreact ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    if (cmd === 'setreactemojis') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      if (!text) return m.reply(`📌 Usage: *.setreactemojis* ❤️,🩷,💙\n\n${cfg.footer}`);
      const emojis = text.split(',').map(e => e.trim()).filter(Boolean);
      const state  = readJson('autoReact.json', { enabled: false }, sid);
      writeJson('autoReact.json', { ...state, emojis }, sid);
      cfg.features.autoReactEmojis = emojis;
      return m.reply(`✅ React emojis updated: ${emojis.join(' ')}\n\n${cfg.footer}`);
    }

    // ── AUTO PRESENCE ─────────────────────────────────────────
    if (cmd === 'autopresence') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('autoPresence.json', { enabled: false, type: 'composing' }, sid);
      const sub   = text?.toLowerCase();
      if (!sub || !['on', 'off', 'status', 'composing', 'recording', 'available', 'unavailable'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *AUTO PRESENCE*\n\n*.autopresence on* — Enable\n*.autopresence off* — Disable\n*.autopresence composing* — Show typing\n*.autopresence recording* — Show recording\n*.autopresence available* — Show online\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*  Type: *${state.type}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autopresence ${state.enabled ? 'off' : 'on'}` },
            { label: '⌨️ Typing',   id: '.autopresence composing' },
            { label: '🎙️ Recording', id: '.autopresence recording' },
          ],
          quoted: msg,
        });
      }
      if (['composing','recording','available','unavailable'].includes(sub)) {
        writeJson('autoPresence.json', { ...state, type: sub }, sid);
        cfg.features.autoPresenceType = sub;
        return m.reply(`✅ Presence type set to *${sub}*\n\n${cfg.footer}`);
      }
      if (sub === 'status') return m.reply(`⚡ *Auto Presence:* ${state.enabled ? '✅ ON' : '❌ OFF'}\nType: *${state.type}*\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('autoPresence.json', { ...state, enabled: enable }, sid);
      cfg.features.autoPresence = enable;
      return sendButtons(sock, chat, {
        text: `⚡ *Auto Presence* ${enable ? '✅ Enabled' : '❌ Disabled'}\nType: *${state.type}*\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autopresence ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── AUTO BLOCK ────────────────────────────────────────────
    if (cmd === 'autoblock') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('autoBlock.json', { enabled: false }, sid);
      const sub   = text?.toLowerCase();
      if (!sub || !['on', 'off', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *AUTO BLOCK*\n\n*.autoblock on* — Block non-contacts in PM\n*.autoblock off* — Disable\n\n⚠️ Use with care!\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoblock ${state.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') return m.reply(`🚫 *Auto Block:* ${state.enabled ? '✅ ON' : '❌ OFF'}\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('autoBlock.json', { enabled: enable }, sid);
      cfg.features.autoBlock = enable;
      return sendButtons(sock, chat, {
        text: `🚫 *Auto Block* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoblock ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── MOROCCO BLOCK ─────────────────────────────────────────
    if (cmd === 'moroccoblock') {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('moroccoBlock.json', { enabled: false }, sid);
      const sub   = text?.toLowerCase();
      if (!sub || !['on', 'off', 'status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *MOROCCO BLOCK*\n\n*.moroccoblock on* — Block/remove +212 numbers\n*.moroccoblock off* — Disable\n\nStatus: *${state.enabled ? 'ON' : 'OFF'}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${state.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.moroccoblock ${state.enabled ? 'off' : 'on'}` },
            { label: '📋 Menu', id: '.menu' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') return m.reply(`🇲🇦 *Morocco Block:* ${state.enabled ? '✅ ON' : '❌ OFF'}\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('moroccoBlock.json', { enabled: enable }, sid);
      cfg.features.moroccoBlock = enable;
      return sendButtons(sock, chat, {
        text: `🇲🇦 *Morocco Block* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.moroccoblock ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── AUTO REPLY (text triggers) ────────────────────────────
    if (['autoreply', 'addautoreply', 'listautoreply', 'delautoreply'].includes(cmd)) {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state   = readJson('autoreply.json', {}, sid);
      const sub     = cmd === 'autoreply' ? text?.split(' ')[0]?.toLowerCase() : cmd.replace('autoreply','').replace('auto','');

      if (cmd === 'addautoreply') {
        // .addautoreply trigger | response
        const parts = text?.split('|');
        if (!parts || parts.length < 2) return m.reply(`📌 Usage: *.addautoreply* trigger | response\n\nExample: .addautoreply hello | Hello there! 👋\n\n${cfg.footer}`);
        const trigger  = parts[0].trim().toLowerCase();
        const response = parts.slice(1).join('|').trim();
        state[trigger] = response;
        writeJson('autoreply.json', state, sid);
        cfg.features.autoReply = true;
        return m.reply(`✅ Auto reply added!\n\n🔑 *Trigger:* _${trigger}_\n💬 *Reply:* _${response}_\n\n${cfg.footer}`);
      }

      if (cmd === 'listautoreply') {
        const entries = Object.entries(state);
        if (entries.length === 0) return m.reply(`📭 No auto replies set.\n\nUse *.addautoreply* trigger | reply\n\n${cfg.footer}`);
        const list = entries.map(([k, v], i) => `*${i+1}.* _${k}_ → _${v}_`).join('\n');
        return sendButtons(sock, chat, {
          text: `📋 *Auto Reply List* (${entries.length})\n\n${list}\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: '📋 Menu', id: '.menu' }],
          quoted: msg,
        });
      }

      if (cmd === 'delautoreply') {
        if (!text) return m.reply(`📌 Usage: *.delautoreply* [trigger]\n\n${cfg.footer}`);
        const key = text.toLowerCase().trim();
        if (!state[key]) return m.reply(`❌ Trigger _${key}_ not found!\n\n${cfg.footer}`);
        delete state[key];
        writeJson('autoreply.json', state, sid);
        return m.reply(`✅ Deleted auto reply for _${key}_\n\n${cfg.footer}`);
      }

      // .autoreply on/off/status
      const arState = readJson('autoReplyEnabled.json', { enabled: false }, sid);
      if (!sub || !['on','off','status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *AUTO REPLY*\n\n*.autoreply on* — Enable text triggers\n*.autoreply off* — Disable\n*.addautoreply* trigger | reply — Add trigger\n*.listautoreply* — List all\n*.delautoreply* trigger — Delete\n\nStatus: *${arState.enabled ? 'ON' : 'OFF'}*\nTriggers: *${Object.keys(state).length}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [
            { label: `${arState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoreply ${arState.enabled ? 'off' : 'on'}` },
            { label: '📋 List', id: '.listautoreply' },
          ],
          quoted: msg,
        });
      }
      if (sub === 'status') return m.reply(`💬 *Auto Reply:* ${arState.enabled ? '✅ ON' : '❌ OFF'}\nTriggers: *${Object.keys(state).length}*\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('autoReplyEnabled.json', { enabled: enable }, sid);
      cfg.features.autoReply = enable;
      return sendButtons(sock, chat, {
        text: `💬 *Auto Reply* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autoreply ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── AUTO STICKER REPLY ────────────────────────────────────
    if (['autostickerreply', 'addautosticker', 'listautosticker', 'delautosticker'].includes(cmd)) {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('autosticker.json', {}, sid);

      if (cmd === 'addautosticker') {
        const parts = text?.split('|');
        if (!parts || parts.length < 2) return m.reply(`📌 Usage: *.addautosticker* trigger | sticker_url\n\n${cfg.footer}`);
        const trigger = parts[0].trim().toLowerCase();
        const url     = parts[1].trim();
        state[trigger] = url;
        writeJson('autosticker.json', state, sid);
        return m.reply(`✅ Auto sticker added!\n🔑 *Trigger:* _${trigger}_\n\n${cfg.footer}`);
      }

      if (cmd === 'listautosticker') {
        const entries = Object.entries(state);
        if (entries.length === 0) return m.reply(`📭 No auto stickers set.\n\n${cfg.footer}`);
        const list = entries.map(([k], i) => `*${i+1}.* _${k}_`).join('\n');
        return m.reply(`🎭 *Auto Sticker Triggers* (${entries.length})\n\n${list}\n\n${cfg.footer}`);
      }

      if (cmd === 'delautosticker') {
        if (!text) return m.reply(`📌 Usage: *.delautosticker* [trigger]\n\n${cfg.footer}`);
        delete state[text.toLowerCase().trim()];
        writeJson('autosticker.json', state, sid);
        return m.reply(`✅ Deleted!\n\n${cfg.footer}`);
      }

      const asState = readJson('autoStickerEnabled.json', { enabled: false }, sid);
      const sub     = text?.toLowerCase();
      if (!sub || !['on','off','status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *AUTO STICKER REPLY*\n\n*.autostickerreply on/off*\n*.addautosticker* trigger | url\n*.listautosticker*\n*.delautosticker* trigger\n\nStatus: *${asState.enabled ? 'ON' : 'OFF'}*  Triggers: *${Object.keys(state).length}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${asState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autostickerreply ${asState.enabled ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      if (sub === 'status') return m.reply(`🎭 *Auto Sticker:* ${asState.enabled ? '✅ ON' : '❌ OFF'}\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('autoStickerEnabled.json', { enabled: enable }, sid);
      cfg.features.autoStickerReply = enable;
      return sendButtons(sock, chat, {
        text: `🎭 *Auto Sticker Reply* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autostickerreply ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }

    // ── AUTO VOICE ────────────────────────────────────────────
    if (['autovoice', 'addautovoice', 'listautovoice', 'delautovoice'].includes(cmd)) {
      if (!m.isOwner) return m.reply(`${tr('err_owner_only')}\n\n${cfg.footer}`);
      const state = readJson('autovoice.json', {}, sid);

      if (cmd === 'addautovoice') {
        const parts = text?.split('|');
        if (!parts || parts.length < 2) return m.reply(`📌 Usage: *.addautovoice* trigger | audio_url\n\n${cfg.footer}`);
        const trigger = parts[0].trim().toLowerCase();
        const url     = parts[1].trim();
        state[trigger] = url;
        writeJson('autovoice.json', state, sid);
        return m.reply(`✅ Auto voice added!\n🔑 *Trigger:* _${trigger}_\n\n${cfg.footer}`);
      }

      if (cmd === 'listautovoice') {
        const entries = Object.entries(state);
        if (entries.length === 0) return m.reply(`📭 No auto voices set.\n\n${cfg.footer}`);
        const list = entries.map(([k], i) => `*${i+1}.* _${k}_`).join('\n');
        return m.reply(`🎤 *Auto Voice Triggers* (${entries.length})\n\n${list}\n\n${cfg.footer}`);
      }

      if (cmd === 'delautovoice') {
        if (!text) return m.reply(`📌 Usage: *.delautovoice* [trigger]\n\n${cfg.footer}`);
        delete state[text.toLowerCase().trim()];
        writeJson('autovoice.json', state, sid);
        return m.reply(`✅ Deleted!\n\n${cfg.footer}`);
      }

      const avState = readJson('autoVoiceEnabled.json', { enabled: false }, sid);
      const sub     = text?.toLowerCase();
      if (!sub || !['on','off','status'].includes(sub)) {
        return sendButtons(sock, chat, {
          text: `📌 *AUTO VOICE REPLY*\n\n*.autovoice on/off*\n*.addautovoice* trigger | audio_url\n*.listautovoice*\n*.delautovoice* trigger\n\nStatus: *${avState.enabled ? 'ON' : 'OFF'}*  Triggers: *${Object.keys(state).length}*\n\n${cfg.footer}`,
          footer: cfg.footer,
          buttons: [{ label: `${avState.enabled ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autovoice ${avState.enabled ? 'off' : 'on'}` }],
          quoted: msg,
        });
      }
      if (sub === 'status') return m.reply(`🎤 *Auto Voice:* ${avState.enabled ? '✅ ON' : '❌ OFF'}\n\n${cfg.footer}`);
      const enable = sub === 'on';
      writeJson('autoVoiceEnabled.json', { enabled: enable }, sid);
      cfg.features.autoVoice = enable;
      return sendButtons(sock, chat, {
        text: `🎤 *Auto Voice Reply* ${enable ? '✅ Enabled' : '❌ Disabled'}\n\n${cfg.footer}`,
        footer: cfg.footer,
        buttons: [{ label: `${enable ? '🔴 Turn OFF' : '🟢 Turn ON'}`, id: `.autovoice ${enable ? 'off' : 'on'}` }],
        quoted: msg,
      });
    }
  },
};
