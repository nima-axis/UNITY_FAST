'use strict';
const strings = require('./strings');
const db = require('../commands/index');

// ── Per-session in-memory lang cache ─────────────────────────
// Map<sessionId, { lang, time }>
const _cache = new Map();
const CACHE_TTL = 10_000; // 10 seconds

async function getLang(sessionId = 'config') {
  const now = Date.now();
  const cached = _cache.get(sessionId);
  if (cached && (now - cached.time) < CACHE_TTL) return cached.lang;
  try {
    const botCfg = await db.getBotConfig(sessionId);
    const lang = botCfg?.lang || 'en';
    _cache.set(sessionId, { lang, time: now });
    return lang;
  } catch {}
  return 'en';
}

// Call this after saving lang to DB so cache refreshes immediately
function setLangCache(lang, sessionId = 'config') {
  _cache.set(sessionId, { lang, time: Date.now() });
}

function t(key, lang = 'en') {
  const entry = strings[key];
  if (!entry) return key;
  if (entry[lang] !== undefined && entry[lang] !== '') return entry[lang];
  return entry['en'] || key;
}

async function getT(sessionId = 'config') {
  const lang = await getLang(sessionId);
  return (key) => t(key, lang);
}

module.exports = { t, getLang, getT, setLangCache };
