'use strict';
require('dotenv').config({ path: './config.env' });
const crypto = require('crypto');

// ── AES-256 Encryption ────────────────────────────────────────
const MASTER_KEY = crypto.createHash('sha256')
  .update('UNITY_MD_ULTRA_SECRET_2025_UNITY_TEAM').digest();
const IV = crypto.createHash('md5')
  .update('UNITY_MD_IV_2025').digest();

function encrypt(data) {
  if (!data) return '';
  const c = crypto.createCipheriv('aes-256-cbc', MASTER_KEY, IV);
  return c.update(String(data), 'utf8', 'hex') + c.final('hex');
}

function decrypt(data) {
  if (!data) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', MASTER_KEY, IV);
    return d.update(data, 'hex', 'utf8') + d.final('utf8');
  } catch (e) {
    return '';
  }
}

function hash(data) {
  return crypto.createHash('sha256').update(String(data)).digest('hex');
}

function verify(enc, h) {
  return hash(enc) === h;
}

// ── Owner numbers list (multiple owners) ─────────────────────
const _ownerNumbers = (process.env.OWNER_NUMBERS || process.env.OWNER_NUMBER || '94726800969')
  .split(',')
  .map(n => n.replace(/[^0-9]/g, ''))
  .filter(Boolean);

// ── Encrypt sensitive fields ──────────────────────────────────
const _e = {
  owner:      encrypt(process.env.OWNER_NUMBER   || '94726800969'),
  ownerName:  encrypt(process.env.OWNER_NAME     || 'UNITY TEAM'),
  botName:    encrypt(process.env.BOT_NAME       || 'UNITY-MD'),
  footer:     encrypt(process.env.BOT_FOOTER     || '❮❮ 𝐔𝐍𝐈𝐓𝐘-MD ❯❯ | ® UNITY TEAM'),
  mongoUri:   encrypt(process.env.MONGODB_URI    || 'mongodb+srv://unity-free:unity-free@unity-free.pc6vkvw.mongodb.net/?appName=unity-free'),
  gemini:     encrypt(process.env.GEMINI_API_KEY || 'AIzaSyBfxTr3luTa_e1rOutz_ZdN44eJeI2CdoE'),
  sessionId:  encrypt(process.env.SESSION_ID     || 'UNITY-MD_'),
  dashSecret: encrypt(process.env.DASHBOARD_SECRET   || 'unity_secret'),
  dashPass:   encrypt(process.env.DASHBOARD_PASSWORD || 'unity@admin123'),
  ch1:        encrypt(process.env.CHANNEL_JID_1  || '120363419201971095@newsletter'),
  ch2:        encrypt(process.env.CHANNEL_JID_2  || '120363419201971095@newsletter'),
  ch3:        encrypt(process.env.CHANNEL_JID_3  || '120363419201971095@newsletter'),
};

// ── Integrity hashes ──────────────────────────────────────────
const _h = Object.fromEntries(
  Object.entries(_e).map(([k, v]) => [k, hash(v)])
);

function get(key) {
  if (!verify(_e[key], _h[key])) {
    throw new Error(`Config integrity check failed: ${key}`);
  }
  return decrypt(_e[key]);
}

// ── Export config ─────────────────────────────────────────────
module.exports = {
  // Identity
  get botName()    { return get('botName'); },
  get footer()     { return get('footer'); },
  get ownerNumber(){ return get('owner'); },
  get ownerName()  { return get('ownerName'); },

  // Multiple owners list
  get ownerNumbers() { return _ownerNumbers; },
  isOwnerNumber(num) {
    const n = String(num).replace(/[^0-9]/g, '');
    return _ownerNumbers.includes(n);
  },

  // Database
  get mongoUri()   { return get('mongoUri'); },
  get sessionId()  { return get('sessionId'); },

  // APIs
  get geminiApiKey(){ return get('gemini'); },
  get tmdbApiKey() { return process.env.TMDB_API_KEY || ''; },

  // Channels
  get channel1()   { return get('ch1'); },
  get channel2()   { return get('ch2'); },
  get channel3()   { return get('ch3'); },

  // Social
  social: {
    boostEmoji: process.env.BOOST_EMOJI || '❤️',
  },

  // Dashboard
  get dashSecret() { return get('dashSecret'); },
  get dashPassword(){ return get('dashPass'); },
  dashPort: parseInt(process.env.DASHBOARD_PORT || '3000'),

  // ── Pair URL (auto-detect deployment platform, or manual override) ──
  get pairUrl() {
    // 1. Manual override always wins
    if (process.env.PAIR_URL && process.env.PAIR_URL.trim()) {
      const u = process.env.PAIR_URL.trim().replace(/\/+$/, '');
      return u.endsWith('/pair') ? u : u + '/pair';
    }
    // 2. Railway
    const railway = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '';
    if (railway) return `https://${railway.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/pair`;
    // 3. Render
    const render = process.env.RENDER_EXTERNAL_URL || '';
    if (render) return `${render.replace(/\/+$/, '')}/pair`;
    // 4. Generic
    const generic = process.env.PUBLIC_URL || process.env.APP_URL || '';
    if (generic) return `${generic.replace(/\/+$/, '')}/pair`;
    // 5. Not deployed / local — return null
    return null;
  },

  // Prefixes
  prefixes: [
    process.env.BOT_PREFIX   || '.',
    process.env.BOT_PREFIX_2 || '/',
  ],

  // Feature toggles — ALL auto features default OFF (use === 'true' pattern only)
  features: {
    security2fa:        process.env.ENABLE_SECURITY_2FA       === 'true',
    rateLimit:          process.env.ENABLE_RATE_LIMIT         !== 'false',
    auditLog:           process.env.ENABLE_AUDIT_LOG          !== 'false',
    antiRaid:           process.env.ENABLE_ANTI_RAID          !== 'false',
    linkDetector:       process.env.ENABLE_LINK_DETECTOR      !== 'false',
    sessionEncryption:  process.env.ENABLE_SESSION_ENCRYPTION !== 'false',
    ipDetection:        process.env.ENABLE_IP_DETECTION       === 'true',
    socialBoost:        process.env.ENABLE_SOCIAL_BOOST       !== 'false',
    autoBio:            process.env.ENABLE_AUTO_BIO           === 'true',
    autoRecording:      process.env.ENABLE_AUTO_RECORDING     === 'true',
    autoOnline:         process.env.ENABLE_AUTO_ONLINE        === 'true',
    antiCall:           process.env.ENABLE_ANTI_CALL          === 'true',
    autoRead:           process.env.ENABLE_AUTO_READ          === 'true',

    // ── Lara auto features ──────────────────────────────────
    autoReact:          process.env.ENABLE_AUTO_REACT          === 'true',
    autoReactEmojis:    (process.env.AUTO_REACT_EMOJIS         || '❤️,🩷,🧡,💛,💚,🩵,💙,💜').split(','),
    autoPresence:       process.env.ENABLE_AUTO_PRESENCE       === 'true',
    autoPresenceType:   process.env.AUTO_PRESENCE_TYPE         || 'composing',
    autoBlock:          process.env.ENABLE_AUTO_BLOCK          === 'true',
    autoVoice:          process.env.ENABLE_AUTO_VOICE          === 'true',
    autoStickerReply:   process.env.ENABLE_AUTO_STICKER_REPLY  === 'true',
    autoReply:          process.env.ENABLE_AUTO_REPLY          === 'true',
    moroccoBlock:       process.env.ENABLE_MOROCCO_BLOCK       === 'true',
  },

  // Limits
  limits: {
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20'),
    cooldownMs:         parseInt(process.env.COMMAND_COOLDOWN_MS   || '1000'),
    warnLimit:          parseInt(process.env.WARN_LIMIT            || '3'),
    autoDeleteSecs:     parseInt(process.env.AUTO_DELETE_SECS      || '330'),
  },

  // Misc
  timezone: process.env.TIMEZONE  || 'Asia/Colombo',
  isDev:    process.env.NODE_ENV  !== 'production',
};
