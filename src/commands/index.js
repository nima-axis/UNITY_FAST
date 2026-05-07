'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

let connected = false;

async function connect() {
  if (connected) return;
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(cfg.mongoUri, {
        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 15000,
        maxPoolSize: 5,
        minPoolSize: 1,
      });
      connected = true;
      console.log('\x1b[32m[DB]\x1b[0m MongoDB connected ✅');
      return;
    } catch (e) {
      console.error(`\x1b[31m[DB]\x1b[0m MongoDB failed (attempt ${attempt}/${MAX_RETRIES}):`, e.message);
      if (attempt === MAX_RETRIES) {
        console.error('\x1b[31m[DB]\x1b[0m All retries failed. Check MONGODB_URI in Railway variables.');
        process.exit(1);
      }
      // Wait before retry: 5s, 10s, 20s, 30s
      const delay = Math.min(5000 * attempt, 30000);
      console.log(`\x1b[33m[DB]\x1b[0m Retrying in ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── User Schema ───────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  jid:            { type: String, required: true, unique: true },
  name:           String,
  category:       { type: String, default: 'normal', enum: ['normal', 'pair', 'owner', 'creator'] },
  isOwner:        { type: Boolean, default: false },
  isSubAdmin:     { type: Boolean, default: false },
  isBanned:       { type: Boolean, default: false },
  isMuted:        { type: Boolean, default: false },
  isPaired:       { type: Boolean, default: false },
  pairedAt:       Date,
  warns:          { type: Number, default: 0 },
  warnReasons:    [String],
  coins:          { type: Number, default: 0 },
  xp:             { type: Number, default: 0 },
  level:          { type: Number, default: 1 },
  streak:         { type: Number, default: 0 },
  lastSeen:       Date,
  lastCommand:    Date,
  totalCommands:  { type: Number, default: 0 },
  badges:         [String],
  achievements:   [String],
  afk:            { type: Boolean, default: false },
  afkReason:      String,
  commandHistory: [{ cmd: String, at: Date }],
  personalPrefix: String,
  personalLang:   { type: String, default: 'en' },
  personalName:   String,
  createdAt:      { type: Date, default: Date.now },
});

// ── Group Schema ──────────────────────────────────────────────
const groupSchema = new mongoose.Schema({
  jid:  { type: String, required: true, unique: true },
  name: String,
  settings: {
    antiLink:      { type: Boolean, default: false },
    antiSpam:      { type: Boolean, default: false },
    antiDelete:    { type: Boolean, default: false },
    antiForward:   { type: Boolean, default: false },
    antiRaid:      { type: Boolean, default: false },
    antiToxic:     { type: Boolean, default: false },
    antiCall:      { type: Boolean, default: false },
    floodDetect:   { type: Boolean, default: false },
    slowMode:      { type: Boolean, default: false },
    slowModeDelay: { type: Number,  default: 5 },
    captcha:       { type: Boolean, default: false },
    muteAll:       { type: Boolean, default: false },
    disappearing:  { type: Number,  default: 0 },
    lang:          { type: String,  default: 'en' },
    aiMode:        { type: Boolean, default: false },
  },
  rules:        [String],
  faq:          [{ q: String, a: String }],
  keywords:     [{ trigger: String, reply: String }],
  bannedWords:  [String],
  warnCount:    { type: Map, of: Number },
  commandStats: { type: Map, of: Number },
  createdAt:    { type: Date, default: Date.now },
});

// ── Stats Schema ──────────────────────────────────────────────
const statsSchema = new mongoose.Schema({
  date:          { type: String, required: true, unique: true },
  totalCommands: { type: Number, default: 0 },
  uniqueUsers:   [String],
  topCommands:   { type: Map, of: Number },
  errorCount:    { type: Number, default: 0 },
  newUsers:      { type: Number, default: 0 },
});

// ── Audit Schema ──────────────────────────────────────────────
const auditSchema = new mongoose.Schema({
  userJid:   String,
  userName:  String,
  command:   String,
  groupJid:  String,
  success:   Boolean,
  error:     String,
  at:        { type: Date, default: Date.now },
});

// ── JadiBot Schema ────────────────────────────────────────────
const jadibotSchema = new mongoose.Schema({
  ownerJid: { type: String, required: true, unique: true },
  sessions: [{ sessionId: String, createdAt: Date }],
  active:   { type: Boolean, default: false },
  createdAt:{ type: Date, default: Date.now },
});

// ── Schedule Schema ───────────────────────────────────────────
const scheduleSchema = new mongoose.Schema({
  chat:      String,
  message:   String,
  media:     String,
  mediaType: String,
  at:        Date,
  repeat:    String,
  active:    { type: Boolean, default: true },
  createdBy: String,
  createdAt: { type: Date, default: Date.now },
});

// ── AuthState Schema ──────────────────────────────────────────
const authStateSchema = new mongoose.Schema({
  _id:  String,
  data: mongoose.Schema.Types.Mixed,
}, { versionKey: false });

// ── BotConfig Schema ──────────────────────────────────────────
// enabledCommands: Map<commandName, boolean>
// ALL commands default OFF except core system commands (menu/alive/ping/help/settings)
// ALL auto features default OFF
const botConfigSchema = new mongoose.Schema({
  _id:         { type: String, default: 'config' },
  mode:        { type: String, default: 'inbox' },
  prefix:      String,
  lang:        { type: String, default: 'en' },
  langSet:     { type: Boolean, default: false },
  maintenance: { type: Boolean, default: false },
  features: {
    autoRecording:   { type: Boolean, default: false },
    autoOnline:      { type: Boolean, default: false },
    autoRead:        { type: Boolean, default: false },
    autoTyping:      { type: Boolean, default: false },
    autoBio:         { type: Boolean, default: true },
    didYouMean:      { type: Boolean, default: false },
    antiCall:        { type: Boolean, default: false },
    autoDeleteChat:  { type: Boolean, default: false },
    autoStatusView:  { type: Boolean, default: false },
    autoStatusReact: { type: Boolean, default: false },
    autoStatusReactEmoji: { type: String, default: '❤️' },
    statusDlEnabled: { type: Boolean, default: true },
  maintenanceMsg:  { type: String,  default: '🔧 UNITY-MD is under maintenance. Back soon!' },
  },
  // Per-command toggle map  (commandName → boolean)
  // Commands missing from the map = disabled
  enabledCommands: { type: Map, of: Boolean, default: () => new Map() },
  // Dashboard settings password (auto-generated on first connect, sent via WA)
  sessionPassword: { type: String, default: null },
  // Channel boost active tasks
  boostTasks: [{
    link:      String,
    emoji:     String,
    startedAt: Date,
    endsAt:    Date,
    active:    { type: Boolean, default: true },
  }],
  // First ever deployment time — set once, never overwritten on restarts
  firstBootAt: { type: Date, default: null },
}, { versionKey: false });

// ── Models ────────────────────────────────────────────────────
const User      = mongoose.model('User',      userSchema);
const Group     = mongoose.model('Group',     groupSchema);
const Stats     = mongoose.model('Stats',     statsSchema);
const Audit     = mongoose.model('Audit',     auditSchema);
const JadiBot   = mongoose.model('JadiBot',   jadibotSchema);
const Schedule  = mongoose.model('Schedule',  scheduleSchema);
const AuthState = mongoose.model('AuthState', authStateSchema);
const BotConfig = mongoose.model('BotConfig', botConfigSchema);

// ── Commands that are ALWAYS on regardless of toggle ──────────
// These are system-level commands the owner always needs
const ALWAYS_ON_CMDS = new Set([
  'menu', 'm', 'alive', 'ping', 'help',
  'settings', 'botmode',
  'publicmode', 'groupmode', 'inboxmode', 'privatemode',
  'autorecording', 'autoonline',
  'autoread', 'autotyping', 'autobio', 'didyoumean', 'anticall',
  'setlang', 'setprefix', 'language', 'lang',
  'mysettings', 'myprefix', 'mylang', 'myname', 'myreset',
  'getid', 'getjid', 'getgroupid', 'getchannelid',
  'pair', 'unpair',
  'maintenance', 'maintain',
  'addowner', 'delowner', 'listowner',
  'addsubadmin', 'delsubadmin',
  'version', 'restart', 'kill', 'clearcache',
  'clearchat', 'chatclear', 'auditlog',
  'cmds', 'cmdson', 'cmdsoff', 'cmdtoggle',
  '_setlang',
  'save', 'send',
]);

// ── Database Functions ────────────────────────────────────────
async function getUser(jid) {
  try {
    return await User.findOneAndUpdate(
      { jid },
      { $setOnInsert: { jid } },
      { upsert: true, new: true }
    );
  } catch {
    // DB temporarily unavailable — return minimal fallback so commands still run
    return { jid, isBanned: false, isMuted: false, isOwner: false, isPaired: false, category: 'normal', coins: 0, xp: 0, level: 1, warns: 0 };
  }
}

async function getGroup(jid) {
  try {
    return await Group.findOneAndUpdate(
      { jid },
      { $setOnInsert: { jid } },
      { upsert: true, new: true }
    );
  } catch {
    return { jid, settings: {} };
  }
}

async function getBotConfig(sessionId = 'config') {
  return BotConfig.findByIdAndUpdate(
    sessionId,
    { $setOnInsert: { _id: sessionId } },
    { upsert: true, new: true }
  );
}

// Set firstBootAt only if it has never been set before (survives restarts/updates)
async function setFirstBootTime(sessionId = 'config') {
  await BotConfig.findByIdAndUpdate(
    sessionId,
    [
      {
        $set: {
          firstBootAt: {
            $cond: [{ $eq: ['$firstBootAt', null] }, new Date(), '$firstBootAt'],
          },
        },
      },
    ],
    { upsert: true }
  );
}

// Check if a command is enabled
async function isCommandEnabled(commandName, sessionId = 'config') {
  if (ALWAYS_ON_CMDS.has(commandName)) return true;
  try {
    const botCfg = await getBotConfig(sessionId);
    const map = botCfg.enabledCommands;
    if (!map) return true;
    const val = map.get(commandName);
    if (val === undefined) return true; // not explicitly set = enabled
    return val === true;
  } catch {
    return true;
  }
}

// Toggle a command on/off — returns new value
async function toggleCommand(commandName, value, sessionId = 'config') {
  const botCfg = await getBotConfig(sessionId);
  if (!botCfg.enabledCommands) botCfg.enabledCommands = new Map();
  botCfg.enabledCommands.set(commandName, value);
  botCfg.markModified('enabledCommands');
  await botCfg.save();
  return value;
}

async function logCommand({ command, userJid }) {
  const today = new Date().toISOString().split('T')[0];
  await Stats.findOneAndUpdate(
    { date: today },
    {
      $inc: { totalCommands: 1, [`topCommands.${command}`]: 1 },
      $addToSet: { uniqueUsers: userJid },
    },
    { upsert: true }
  ).catch(() => {});
}

async function logAudit({ userJid, userName, command, groupJid, success, error }) {
  await Audit.create({ userJid, userName, command, groupJid, success, error }).catch(() => {});
}

// ── setPaired — mark user as paired/unpaired ──────────────────
async function setPaired(jid, value = true) {
  return User.findOneAndUpdate(
    { jid },
    { $set: { isPaired: value, pairedAt: value ? new Date() : null } },
    { upsert: true, new: true }
  );
}

// ── warnUser — increment warn count, return new total ─────────
async function warnUser(jid, reason = '') {
  const user = await User.findOneAndUpdate(
    { jid },
    {
      $inc: { warns: 1 },
      $push: { warnReasons: reason },
    },
    { upsert: true, new: true }
  );
  return user.warns;
}

// ── resetWarns — reset warn count ────────────────────────────
async function resetWarns(jid) {
  return User.findOneAndUpdate(
    { jid },
    { $set: { warns: 0, warnReasons: [] } },
    { upsert: true, new: true }
  );
}

// ── getStats — get stats for last N days ─────────────────────
async function getStats(days = 1) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return Stats.find({ date: { $in: dates } }).sort({ date: -1 });
}

module.exports = {
  connect,
  User, Group, Stats, Audit, JadiBot, Schedule, AuthState, BotConfig,
  getUser, getGroup, getBotConfig,
  isCommandEnabled, toggleCommand,
  ALWAYS_ON_CMDS,
  logCommand, logAudit,
  // ── newly added ──────────────────────────────────────────────
  setPaired,
  warnUser,
  resetWarns,
  getStats,
  setFirstBootTime,
};
