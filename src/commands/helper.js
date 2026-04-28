'use strict';
const cfg = require('../../config');
const fs = require('fs-extra');

// ── Fake WhatsApp Status Reply Context ──────────────────────────
function fakeStatusCtx() {
  return {
    remoteJid: 'status@broadcast',
    participant: '0@s.whatsapp.net',
    fromMe: false,
    stanzaId: '3EB0' + [...Array(16)].map(() =>
      Math.floor(Math.random()*16).toString(16).toUpperCase()).join(''),
    quotedMessage: { conversation: 'Wait loading menu...' },
  };
}
// fakeStatusCtx used internally by sendButtons

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getUptime() {
  return formatDuration(process.uptime());
}

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cleanJid(jid) {
  return jid?.replace('@s.whatsapp.net', '')
    .replace('@g.us', '')
    .replace(/[^0-9]/g, '') || '';
}

function jidToNum(jid) {
  return jid?.split('@')[0]?.split(':')[0] || '';
}

function isUrl(text) {
  return /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/.test(text);
}

function isPhoneNumber(text) {
  return /^[0-9]{7,15}$/.test(text.replace(/[\s+\-()]/g, ''));
}

function truncate(text, max = 100) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

const FANCY_STYLES = {
  bold: str => str.split('').map(c => {
    const code = c.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(code + 120211);
    if (code >= 97 && code <= 122) return String.fromCodePoint(code + 120205);
    if (code >= 48 && code <= 57) return String.fromCodePoint(code + 120734);
    return c;
  }).join(''),

  italic: str => str.split('').map(c => {
    const code = c.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(code + 120263);
    if (code >= 97 && code <= 122) return String.fromCodePoint(code + 120257);
    return c;
  }).join(''),

  mono: str => str.split('').map(c => {
    const code = c.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(code + 120367);
    if (code >= 97 && code <= 122) return String.fromCodePoint(code + 120361);
    if (code >= 48 && code <= 57) return String.fromCodePoint(code + 120774);
    return c;
  }).join(''),

  circle: str => str.split('').map(c => {
    const code = c.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(code + 9333);
    if (code >= 97 && code <= 122) return String.fromCodePoint(code + 9327);
    if (code >= 49 && code <= 57) return String.fromCodePoint(code + 9263);
    if (code === 48) return '⓪';
    return c;
  }).join(''),

  square: str => str.split('').map(c => {
    const code = c.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(code + 127215);
    if (code >= 97 && code <= 122) return String.fromCodePoint(code + 127247);
    return c;
  }).join(''),

  flip: str => {
    const map = {
      a:'ɐ', b:'q', c:'ɔ', d:'p', e:'ǝ', f:'ɟ', g:'ƃ', h:'ɥ',
      i:'ᴉ', j:'ɾ', k:'ʞ', l:'l', m:'ɯ', n:'u', o:'o', p:'d',
      q:'b', r:'ɹ', s:'s', t:'ʇ', u:'n', v:'ʌ', w:'ʍ', x:'x',
      y:'ʎ', z:'z',
    };
    return str.toLowerCase().split('').map(c => map[c] || c).reverse().join('');
  },

  morse: str => {
    const map = {
      a:'.-',  b:'-...', c:'-.-.', d:'-..', e:'.',
      f:'..-.', g:'--.', h:'....', i:'..', j:'.---',
      k:'-.-',  l:'.-..', m:'--', n:'-.', o:'---',
      p:'.--.', q:'--.-', r:'.-.', s:'...', t:'-',
      u:'..-',  v:'...-', w:'.--', x:'-..-', y:'-.--',
      z:'--..',
    };
    return str.toLowerCase().split('').map(c => map[c] || (c === ' ' ? '/' : c)).join(' ');
  },

  binary: str => str.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' '),

  mirror: str => str.split('').reverse().join(''),

  zalgo: str => {
    const up = ['̍','̎','̄','̅','̿','̑','̆','̐','͒','͗','͑','̇','̈','̊','͂','̓','̈','͊','͋','͌','̃','̂','̌','͐','̀','́','̋','̏','̒','̓','̔','̽','̉','ͣ','ͤ','ͥ','ͦ','ͧ','ͨ','ͩ','ͪ','ͫ','ͬ','ͭ','ͮ','ͯ','̾','͛','͆','̚'];
    const down = ['̖','̗','̘','̙','̜','̝','̞','̟','̠','̤','̥','̦','̩','̪','̫','̬','̭','̮','̯','̰','̱','̲','̳','̹','̺','̻','̼','ͅ','͇','͈','͉','͍','͎','͓','͔','͕','͖','͙','͚','̣'];
    return str.split('').map(c => {
      if (c === ' ') return c;
      let r = c;
      for (let i = 0; i < randomInt(1, 4); i++) r += random(up);
      for (let i = 0; i < randomInt(1, 3); i++) r += random(down);
      return r;
    }).join('');
  },

  glitch: str => {
    const glitchChars = ['̴','̵','̶','̷','̸','̡','̢','͜','͝','͞','͟','͠'];
    return str.split('').map(c => c + (Math.random() > 0.5 ? random(glitchChars) : '')).join('');
  },
};

function fancyText(style, text) {
  return FANCY_STYLES[style]?.(text) || text;
}

function sinhalaBold(text) {
  return `*${text}*`;
}

function menuBox(title, items) {
  const line = '═'.repeat(30);
  const top = `╔${line}╗`;
  const mid = `╠${line}╣`;
  const bot = `╚${line}╝`;
  const center = (str, width = 30) => {
    const pad = Math.max(0, width - str.length);
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return `║${' '.repeat(left)}${str}${' '.repeat(right)}║`;
  };
  let out = `${top}\n${center(title)}\n${mid}\n`;
  for (const item of items) out += `║ ${item.padEnd(28)} ║\n`;
  out += bot;
  return out;
}

function tmpFile(ext = 'tmp') {
  fs.ensureDirSync('./temp');
  return `./temp/unity_${Date.now()}_${randomInt(1000, 9999)}.${ext}`;
}

// ── Interactive Buttons (Baileys v7 native flow) ──────────────
async function sendButtons(sock, jid, { text, footer = '', buttons = [], quoted = null }) {
  // ── Auto-append Menu button if not already present ──────────
  const hasMenu = buttons.some(b => b.id === '.menu' || b.label === '📋 Menu');
  if (!hasMenu) {
    buttons = [...buttons, { label: '📋 Menu', id: '.menu' }];
  }

  // ── Store reply-number mapping ───────────────────────────────
  if (!global.pendingButtonReplies) global.pendingButtonReplies = new Map();
  global.pendingButtonReplies.set(jid, buttons.map(b => b.id));

  // ── Build plain text with numbered list ──────────────────────
  const numberedLines = buttons.map((b, i) => `  *${i + 1}.* ${b.label}`).join('\n');
  const fullText = `${text}\n\n${numberedLines}\n\n_\u21a9 reply with a number_` +
    (footer ? `\n\n${footer}` : '');

  // ── Send as plain text message ───────────────────────────────
  const sendOpts = quoted ? { quoted } : {};
  const msg = await sock.sendMessage(jid, { text: fullText }, sendOpts);

  // ── Track for auto-delete ─────────────────────────────────────
  if (msg?.key && global.botMsgTracker && global.currentCmd) {
    const menuCmds = ['menu','help','m','menu_ai','menu_media','menu_tools',
      'menu_texttools','menu_fun','menu_games','menu_srilanka','menu_group',
      'menu_protection','menu_stats','settings','botmode',
      'publicmode','groupmode','inboxmode','privatemode',
      'autorecording','autoonline',
      'autoread','autotyping','autobio','anticall','didyoumean'];
    if (!menuCmds.includes(global.currentCmd)) {
      const chatJid = msg.key.remoteJid;
      const existing = global.botMsgTracker.get(chatJid) || [];
      existing.push(msg.key);
      global.botMsgTracker.set(chatJid, existing);
    }
  }

  return msg;
}


// ── sendUrlButtons: plain text fallback (URL buttons not supported) ──────────
async function sendUrlButtons(sock, jid, { text, footer = '', buttons = [], quoted = null }) {
  const lines = buttons.map((b, i) => `  *${i + 1}.* ${b.label}\n     ${b.url}`).join('\n');
  const fullText = `${text}\n\n${lines}` + (footer ? `\n\n${footer}` : '');
  const sendOpts = quoted ? { quoted } : {};
  return sock.sendMessage(jid, { text: fullText }, sendOpts);
}


module.exports = {
  formatBytes, formatDuration, getUptime,
  random, randomInt, sleep,
  cleanJid, jidToNum,
  isUrl, isPhoneNumber, truncate,
  getGreeting, fancyText, sinhalaBold,
  menuBox, tmpFile,
  sendButtons, sendUrlButtons,
  FANCY_STYLES,
};