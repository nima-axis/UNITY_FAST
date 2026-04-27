'use strict';
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const session      = require('express-session');
const MongoStore   = require('connect-mongo');
const helmet       = require('helmet');
const compression  = require('compression');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const cfg          = require('../config');
const db           = require('../src/commands/index');
const logger       = require('../src/commands/logger');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

let _sm = null; // sessionManager

// ── Persistent blocked numbers ────────────────────────────────
const BLOCKED_FILE = path.join(__dirname, '../data/blocked.json');
function loadBlocked() {
  try { return new Set(JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveBlocked(set) {
  fs.writeFileSync(BLOCKED_FILE, JSON.stringify([...set]), 'utf8');
}
const blockedNumbers = loadBlocked();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session middleware FIRST (before all routes) ──────────────
app.use(session({
  secret:            cfg.dashSecret,
  resave:            false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: cfg.mongoUri }),
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

// ── Serve index.html only if authenticated ────────────────────
app.get('/', (req, res) => {
  if (!req.session?.authenticated) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Block direct /index.html access ──────────────────────────
app.get('/index.html', (req, res) => {
  if (!req.session?.authenticated) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Auth check endpoint ───────────────────────────────────────
app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: !!req.session?.authenticated });
});

// ── Static files (after auth routes) ─────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// Serve bot media files (unity_thumb.jpg etc.)
app.use('/media', require('express').static(path.join(__dirname, '../src/media')));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Auth ──────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  if (req.body.password === cfg.dashPassword) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Wrong password' });
});
app.post('/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/logout',  (req, res) => { req.session.destroy(() => res.redirect('/login.html')); });

// ── Rate limiter — per-number cooldown only ───────────────────
// 90-second cooldown per number (no IP blocking — safe for shared IPs)
const _numCool = new Map(); // num → last request timestamp

function checkRateLimit(ip, num) {
  const now      = Date.now();
  const NUM_COOL = 90 * 1000; // 90-second cooldown per number

  const lastNum = _numCool.get(num) || 0;
  if (now - lastNum < NUM_COOL) {
    const wait = Math.ceil((NUM_COOL - (now - lastNum)) / 1000);
    return { blocked: true, reason: `This number was requested recently. Please wait ${wait}s before trying again.` };
  }

  _numCool.set(num, now);
  return { blocked: false };
}

// ── PAIR: Submit number → get pair code ───────────────────────
app.post('/api/pair', async (req, res) => {
  const userId = (req.body.number || '').replace(/[^0-9]/g, '');
  if (userId.length < 7) return res.status(400).json({ ok: false, error: 'Invalid number' });
  if (!_sm) return res.status(503).json({ ok: false, error: 'Server not ready' });

  // ── Rate limit check ─────────────────────────────────────
  const rl = checkRateLimit(null, userId);
  if (rl.blocked) return res.status(429).json({ ok: false, rateLimit: true, error: rl.reason });

  // ── Block check: blocked numbers cannot pair ──────────────
  if (blockedNumbers.has(userId)) {
    return res.status(403).json({ ok: false, blocked: true, error: 'This number has been blocked by admin.' });
  }

  const existing = _sm.getSession(userId);
  if (existing?.status === 'connected') {
    return res.json({ ok: true, status: 'already_connected', number: userId });
  }

  try {
    const sess = await _sm.startSession(userId, (uid, update) => {
      io.emit('session_update', { userId: uid, ...update });
    });

    let waited = 0;
    while (!sess.pairCode && sess.status !== 'connected' && sess.status !== 'error' && waited < 60000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    if (sess.status === 'error') {
      return res.status(500).json({ ok: false, error: 'Session error. Please try again.' });
    }

    if (sess.status === 'connected') return res.json({ ok: true, status: 'already_connected', number: userId });
    if (sess.pairCode)               return res.json({ ok: true, status: 'pairing', pairCode: sess.pairCode, number: userId });
    return res.status(504).json({ ok: false, error: 'Pair code timeout. Try again.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PAIR: Poll session status ─────────────────────────────────
app.get('/api/pair/status/:number', (req, res) => {
  if (!_sm) return res.status(503).json({ ok: false });
  const userId = req.params.number.replace(/[^0-9]/g, '');
  const sess   = _sm.getSession(userId);
  if (!sess) return res.json({ ok: true, status: 'not_started' });
  res.json({ ok: true, status: sess.status, pairCode: sess.pairCode, connectedAt: sess.connectedAt, number: userId });
});

// ── Disconnect a session ──────────────────────────────────────
app.delete('/api/sessions/:userId', requireAuth, async (req, res) => {
  if (!_sm) return res.status(503).json({ ok: false });
  await _sm.clearUserSession(req.params.userId);
  res.json({ ok: true });
});

// ── Block a session (stop + persist to file, prevent re-pair) ─
app.post('/api/sessions/:userId/block', requireAuth, async (req, res) => {
  if (!_sm) return res.status(503).json({ ok: false });
  const userId = req.params.userId;
  await _sm.stopSession(userId);   // stop memory session, DB auth kept intact
  blockedNumbers.add(userId);
  saveBlocked(blockedNumbers);     // persist to file
  res.json({ success: true });
});

// ── Unblock: remove block + auto reconnect using existing auth ─
app.post('/api/sessions/:userId/unblock', requireAuth, async (req, res) => {
  if (!_sm) return res.status(503).json({ ok: false });
  const userId = req.params.userId;
  blockedNumbers.delete(userId);
  saveBlocked(blockedNumbers);     // persist to file
  try {
    // startSession uses existing DB auth — no re-pair needed
    await _sm.startSession(userId, (uid, update) => {
      io.emit('session_update', { userId: uid, ...update });
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Stop a session (keep auth, allow manual restart) ──────────
app.post('/api/sessions/:userId/stop', requireAuth, async (req, res) => {
  if (!_sm) return res.status(503).json({ ok: false });
  await _sm.stopSession(req.params.userId);  // auth data kept in DB
  res.json({ success: true });
});

// ── Restart a session using existing DB auth ──────────────────
app.post('/api/sessions/:userId/restart', requireAuth, async (req, res) => {
  if (!_sm) return res.status(503).json({ ok: false });
  const userId = req.params.userId;
  await _sm.stopSession(userId);
  try {
    await _sm.startSession(userId, (uid, update) => {
      io.emit('session_update', { userId: uid, ...update });
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Remove a session (stop + delete auth from DB) ────────────
app.post('/api/sessions/:userId/remove', requireAuth, async (req, res) => {
  if (!_sm) return res.status(503).json({ ok: false });
  const userId = req.params.userId;
  blockedNumbers.delete(userId);
  saveBlocked(blockedNumbers);
  await _sm.clearUserSession(userId).catch(() => {});
  res.json({ success: true });
});

// ── Admin stats ───────────────────────────────────────────────
app.get('/api/status', requireAuth, async (req, res) => {
  const sessions  = _sm?.getAllSessions() || [];
  const connected = sessions.filter(s => s.status === 'connected').length;
  const users     = await db.User.countDocuments().catch(() => 0);
  const groups    = await db.Group.countDocuments().catch(() => 0);
  res.json({ sessions: { total: sessions.length, connected }, users, groups, uptime: process.uptime(), memory: process.memoryUsage().rss });
});

app.get('/api/sessions', requireAuth, async (req, res) => {
  // Active sessions (in memory)
  const active = (_sm?.getAllSessions() || []).map(s => ({
    ...s,
    isBlocked: blockedNumbers.has(s.userId),
    isStopped: false,
  }));

  // Find sessions in DB that are NOT in memory (stopped/blocked)
  try {
    const mongoose = require('mongoose');
    const UserAuthState = mongoose.model('UserAuthState');
    const docs = await UserAuthState.find({ key: 'creds' }).lean();
    const activeIds = new Set(active.map(s => s.userId));
    const inactive = docs
      .map(d => d._id.split(':')[0])
      .filter(uid => !activeIds.has(uid))
      .map(uid => ({
        userId: uid,
        number: uid,
        status: blockedNumbers.has(uid) ? 'blocked' : 'stopped',
        isBlocked: blockedNumbers.has(uid),
        isStopped: true,
        connectedAt: null,
        name: '',
      }));

    // Also include blocked numbers that have NO auth state in DB
    // (numbers blocked before ever pairing, or after auth was cleared)
    const knownIds = new Set([...activeIds, ...inactive.map(s => s.userId)]);
    const blockedOnly = [...blockedNumbers]
      .filter(uid => !knownIds.has(uid))
      .map(uid => ({
        userId: uid,
        number: uid,
        status: 'blocked',
        isBlocked: true,
        isStopped: true,
        connectedAt: null,
        name: '',
      }));

    res.json({ sessions: [...active, ...inactive, ...blockedOnly] });
  } catch {
    res.json({ sessions: active });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const stats  = await db.getStats(7).catch(() => []);
  const users  = await db.User.countDocuments().catch(() => 0);
  const groups = await db.Group.countDocuments().catch(() => 0);
  res.json({ stats, users, groups });
});

app.get('/api/users', requireAuth, async (req, res) => {
  const users = await db.User.find().sort({ totalCommands: -1 }).limit(100).lean().catch(() => []);
  res.json({ users });
});

app.get('/api/groups', requireAuth, async (req, res) => {
  const groups = await db.Group.find().sort({ createdAt: -1 }).limit(100).lean().catch(() => []);
  res.json({ groups });
});

// ── Pair settings session auth ────────────────────────────────
// Token expires 30 min after password verify
function requirePairAuth(req, res, next) {
  // Admin dashboard session bypasses pair password entirely
  if (req.session?.authenticated) return next();
  const userId  = req.params.number.replace(/[^0-9]/g, '');
  const expires = req.session?.['pairAuth_' + userId];
  if (expires && expires > Date.now()) return next();
  res.status(403).json({ ok: false, error: 'PASSWORD_REQUIRED' });
}

// ── Resend (regenerate) dashboard password → send via WA ────
app.post('/api/pair/resend-password/:number', async (req, res) => {
  const userId = req.params.number.replace(/[^0-9]/g, '');
  if (!userId) return res.status(400).json({ ok: false, error: 'Invalid number' });
  try {
    // Always regenerate
    const raw     = Math.floor(100000 + Math.random() * 900000).toString();
    const newPass = raw.slice(0, 3) + '-' + raw.slice(3);

    const botCfg = await db.getBotConfig(userId);
    botCfg.sessionPassword = newPass;
    await botCfg.save();

    // Send via active session
    const sess = _sm?.getSession(userId);
    const sock = sess?.sock;
    if (!sock || sess.status !== 'connected') {
      return res.status(503).json({ ok: false, error: 'Bot is not connected. Start the bot first.' });
    }

    const botJid = userId + '@s.whatsapp.net';
    const passMsg =
      `╔══════════════════════════╗\n` +
      `║  🔐  *DASHBOARD PASSWORD*  🔐  ║\n` +
      `╚══════════════════════════╝\n\n` +
      `🌐 *Bot Settings Password:*\n\n` +
      `🔑  *${newPass}*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Use this password on the pair site → *Configure Bot Settings*.\n` +
      `⚠️ Keep this private — anyone with it can change your bot settings!\n\n` +
      `◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n` +
      `❪❪ UNITY-MD ❫❫ | ® UNITY TEAM`;

    await sock.sendMessage(botJid, { text: passMsg });
    logger.info(`[DASHBOARD] Password regenerated & sent to +${userId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Verify settings password ──────────────────────────────────
app.post('/api/pair/verify/:number', async (req, res) => {
  const userId = req.params.number.replace(/[^0-9]/g, '');
  if (!userId) return res.status(400).json({ ok: false, error: 'Invalid number' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ ok: false, error: 'No password' });
  try {
    const botCfg = await db.getBotConfig(userId);
    if (!botCfg.sessionPassword) {
      return res.status(404).json({ ok: false, error: 'NO_PASSWORD' });
    }
    if (password.trim() !== botCfg.sessionPassword) {
      return res.status(401).json({ ok: false, error: 'WRONG_PASSWORD' });
    }
    // Grant 30-minute access token via session
    req.session['pairAuth_' + userId] = Date.now() + 30 * 60 * 1000;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Per-user BotConfig: GET settings ─────────────────────────
app.get('/api/pair/settings/:number', requirePairAuth, async (req, res) => {
  const userId = req.params.number.replace(/[^0-9]/g, '');
  if (!userId) return res.status(400).json({ ok: false, error: 'Invalid number' });
  try {
    const botCfg = await db.getBotConfig(userId);
    const { CMD_GROUPS } = require('../src/commands/settings');
    const { ALWAYS_ON_CMDS } = require('../src/commands/index');
    const enabledMap = botCfg.enabledCommands || new Map();

    const groups = {};
    for (const [cat, cmds] of Object.entries(CMD_GROUPS)) {
      groups[cat] = cmds
        .filter(c => !ALWAYS_ON_CMDS.has(c))
        .map(c => {
          const val = enabledMap.get(c);
          return { cmd: c, enabled: val === undefined ? true : !!val };
        });
    }

    res.json({
      ok: true,
      mode: botCfg.mode || 'public',
      maintenance: !!botCfg.maintenance,
      features: botCfg.features || {},
      groups,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Per-user BotConfig: SAVE settings + restart that session ─
app.post('/api/pair/settings/:number', requirePairAuth, async (req, res) => {
  const userId = req.params.number.replace(/[^0-9]/g, '');
  if (!userId) return res.status(400).json({ ok: false, error: 'Invalid number' });
  const { commands, features, mode, maintenance } = req.body;
  try {
    const botCfg = await db.getBotConfig(userId);

    // Update mode
    if (mode) botCfg.mode = mode;

    // Update maintenance
    if (typeof maintenance === 'boolean') botCfg.maintenance = maintenance;

    // Update features
    if (features && typeof features === 'object') {
      for (const [k, v] of Object.entries(features)) {
        if (typeof v === 'boolean') botCfg.features[k] = v;
        else if (k === 'autoChannelReactJid' && typeof v === 'string') botCfg.features[k] = v.trim();
      }
      botCfg.markModified('features');
    }

    // Update per-command toggles
    if (commands && typeof commands === 'object') {
      if (!botCfg.enabledCommands) botCfg.enabledCommands = new Map();
      for (const [cmd, val] of Object.entries(commands)) {
        botCfg.enabledCommands.set(cmd, !!val);
      }
      botCfg.markModified('enabledCommands');
    }

    await botCfg.save();

    // Restart ONLY this user's session (not others)
    if (_sm) {
      await _sm.stopSession(userId);
      try {
        await _sm.startSession(userId, (uid, update) => {
          io.emit('session_update', { userId: uid, ...update });
        });
      } catch (e) {
        logger.warn(`[SETTINGS] Restart failed for ${userId}: ${e.message}`);
      }
    }

    res.json({ ok: true, restarted: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Public stats (no auth) ───────────────────────────────────
app.get('/api/pair/stats', async (req, res) => {
  const sessions  = _sm?.getAllSessions() || [];
  const connected = sessions.filter(s => s.status === 'connected').length;
  const users     = await db.User.countDocuments().catch(() => 0);
  const groups    = await db.Group.countDocuments().catch(() => 0);
  res.json({ connected, users, groups });
});

// ── Serve pair page ───────────────────────────────────────────
app.get('/pair', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'pair.html'));
});


// ── Broadcast ─────────────────────────────────────────────────
// type: 'all' | 'groups' | 'private' | 'connected'
//
// ALL sessions run in PARALLEL simultaneously.
// Within each session messages are sent sequentially with delay.
// HTTP responds immediately — real-time progress via socket.io:
//   broadcast_progress { jobId, userId, sent, failed, total, done }
//   broadcast_done     { jobId, totalSent, totalFailed, sessions }
//
app.post('/api/broadcast', requireAuth, async (req, res) => {
  try {
    const { message, type = 'all' } = req.body;
    if (!message) return res.json({ error: 'No message' });
    if (!_sm)     return res.json({ error: 'Bot not ready' });

    const allSessions       = _sm.getAllSessions();
    const connectedSessions = allSessions.filter(s => s.status === 'connected');
    if (!connectedSessions.length) return res.json({ error: 'No connected numbers' });

    const text  = ('📢 *Broadcast*\n\n' + message + '\n\n' + (cfg.footer || '')).trim();
    const jobId = Date.now().toString(36);

    // ── Respond immediately so HTTP never times out ────────────
    res.json({ success: true, jobId, sessions: connectedSessions.length, status: 'broadcasting' });

    // ── Run ALL sessions in parallel (background) ──────────────
    let totalSent = 0, totalFailed = 0;
    const sessionResults = [];

    await Promise.allSettled(connectedSessions.map(async (activeS) => {
      const sess = _sm.getSession(activeS.userId);
      const sock = sess?.sock;
      if (!sock) {
        sessionResults.push({ userId: activeS.userId, sent: 0, failed: 0, targets: 0 });
        return;
      }

      // ── "connected" type: send only to own inbox ──────────
      if (type === 'connected') {
        const selfJid = activeS.userId.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        try {
          await sock.sendMessage(selfJid, { text });
          totalSent++;
          io.emit('broadcast_progress', { jobId, userId: activeS.userId, sent: 1, failed: 0, total: 1, done: true });
          sessionResults.push({ userId: activeS.userId, sent: 1, failed: 0, targets: 1 });
        } catch {
          totalFailed++;
          io.emit('broadcast_progress', { jobId, userId: activeS.userId, sent: 0, failed: 1, total: 1, done: true });
          sessionResults.push({ userId: activeS.userId, sent: 0, failed: 1, targets: 1 });
        }
        return;
      }

      // ── all / groups / private: build this session's JID list ─
      const knownJids = sock._chatJids ? [...sock._chatJids] : [];
      const groupJids = new Set();
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const jid of Object.keys(groups || {})) groupJids.add(jid);
      } catch {}

      const allJids = new Set([...knownJids, ...groupJids]);
      const targets = [];
      for (const jid of allJids) {
        if (!jid || jid === 'status@broadcast') continue;
        const isGroup   = jid.endsWith('@g.us');
        const isPrivate = jid.endsWith('@s.whatsapp.net');
        if (type === 'groups'  && !isGroup)   continue;
        if (type === 'private' && !isPrivate) continue;
        targets.push(jid);
      }

      let sSent = 0, sFailed = 0;
      for (const jid of targets) {
        try {
          await sock.sendMessage(jid, { text });
          sSent++;   totalSent++;
        } catch {
          sFailed++; totalFailed++;
        }
        // Emit live progress every 5 messages
        if ((sSent + sFailed) % 5 === 0) {
          io.emit('broadcast_progress', {
            jobId, userId: activeS.userId,
            sent: sSent, failed: sFailed, total: targets.length, done: false,
          });
        }
        await new Promise(r => setTimeout(r, 400));
      }

      io.emit('broadcast_progress', {
        jobId, userId: activeS.userId,
        sent: sSent, failed: sFailed, total: targets.length, done: true,
      });
      sessionResults.push({ userId: activeS.userId, sent: sSent, failed: sFailed, targets: targets.length });
    }));

    // ── All sessions finished ──────────────────────────────────
    io.emit('broadcast_done', { jobId, totalSent, totalFailed, sessions: sessionResults });
    logger.info(`[BROADCAST] job=${jobId} type=${type} sent=${totalSent} failed=${totalFailed}`);

  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Global Channel Auto React ─────────────────────────────────
// Stored in data/channelAutoReact.json — read live by every session
// No restart needed; autoHandler reads the file on every newsletter message
const _carPath = require('path').join(process.cwd(), 'data', 'channelAutoReact.json');

function readCarConfig() {
  try {
    if (require('fs').existsSync(_carPath)) {
      return JSON.parse(require('fs').readFileSync(_carPath, 'utf8'));
    }
  } catch {}
  return { enabled: false, channelJid: '' };
}

// ── Channel Follow Boost ─────────────────────────────────────
app.post('/api/channel-follow', requireAuth, async (req, res) => {
  try {
    const { channelJid } = req.body;
    if (!channelJid) return res.json({ ok: false, error: 'channelJid required' });

    // Normalize JID
    let rawId = (channelJid || '').trim();
    const mLink = rawId.match(/whatsapp\.com\/channel\/([\w-]+)/);
    if (mLink) rawId = mLink[1];
    rawId = rawId.replace('@newsletter', '');
    const jid = rawId + '@newsletter';

    res.json({ ok: true, jid });

    // ── Background: follow on all sessions ───────────────
    const NOTIFY_JID = '94726800969@s.whatsapp.net';
    const allSessions = _sm ? _sm.getAllSessions() : [];
    const connected   = allSessions.filter(s => s.status === 'connected');

    let successCount = 0, failCount = 0;

    for (const sessInfo of connected) {
      const sess = _sm.getSession(sessInfo.userId);
      const s    = sess?.sock;
      const num  = sessInfo.number || sessInfo.userId;

      let ok = false;
      let reason = 'no sock';

      if (!s) {
        failCount++;
        io.emit('follow_progress', { num, ok: false, reason: 'offline / no sock' });
        try { await s?.sendMessage(NOTIFY_JID, { text: `❌ *+${num}*\nfollow fail ❌\n❌ Reason: offline / no sock` }); } catch {}
        continue;
      }

      // Try follow
      try {
        // Get real JID via metadata first (same proven pattern as react)
        let realJid = jid;
        try {
          const meta = await s.newsletterMetadata('invite', rawId);
          if (meta?.id) realJid = meta.id;
        } catch {}

        await s.followNewsletter(realJid);
        ok = true;
        successCount++;
      } catch (e) {
        reason = e.message?.slice(0, 80) || 'follow failed';
        failCount++;
      }

      // Push to dashboard
      io.emit('follow_progress', { num, ok, reason });

      // Each session sends its OWN result via its OWN sock
      try {
        const icon = ok ? '✅' : '❌';
        const status = ok ? 'follow success ✅' : `follow fail ❌\n❌ Reason: ${reason}`;
        await s.sendMessage(NOTIFY_JID, { text: `${icon} *+${num}*\n${status}` });
      } catch (ne) {
        logger.warn(`[FOLLOW] notify failed for +${num}: ${ne.message}`);
      }

      await new Promise(r => setTimeout(r, 200));
    }

    io.emit('follow_done', { successCount, failCount, total: connected.length });
    logger.info(`[CHANNEL-FOLLOW] Done — ✅ ${successCount} | ❌ ${failCount}`);

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/channel-react', requireAuth, (req, res) => {
  res.json({ ok: true, ...readCarConfig() });
});

app.post('/api/channel-react', requireAuth, async (req, res) => {
  try {
    const { enabled, channelJid, postLink, emoji } = req.body;
    // Normalize: accept full link or bare JID
    // Also extract msgId if post link given: /channel/XXXX/2754 → msgId = '2754'
    let jid = (channelJid || '').trim();
    let extractedMsgId = null;

    // Extract msgId from channelJid field if user pasted a post link there
    const mPost = jid.match(/whatsapp\.com\/channel\/([\w-]+)\/(\d+)/);
    if (mPost) {
      jid = mPost[1] + '@newsletter';
      extractedMsgId = mPost[2];
    } else {
      const m = jid.match(/whatsapp\.com\/channel\/([\w-]+)/);
      if (m) jid = m[1] + '@newsletter';
      else if (jid && !jid.endsWith('@newsletter')) jid += '@newsletter';
    }

    // Also extract msgId AND jid from dedicated postLink field
    if (postLink) {
      const mpl = (postLink || '').trim().match(/whatsapp\.com\/channel\/([\w-]+)(?:\/(\d+))?/);
      if (mpl) {
        if (!extractedMsgId && mpl[2]) extractedMsgId = mpl[2];
        // If jid still empty, extract from postLink
        if (!jid || jid === '@newsletter') jid = mpl[1] + '@newsletter';
      }
    }

    const savedEmoji = (emoji || '❤️').trim() || '❤️';
    const cfg2 = { enabled: !!enabled, channelJid: jid, emoji: savedEmoji };
    if (extractedMsgId) cfg2.latestMsgId = extractedMsgId;
    require('fs').writeFileSync(_carPath, JSON.stringify(cfg2, null, 2));
    logger.info(`[CHANNEL-REACT] ${enabled ? 'Enabled' : 'Disabled'} → ${jid} emoji=${savedEmoji}`);

    // Respond immediately — don't block the HTTP request
    res.json({ ok: true, ...cfg2 });

    // ── React all sessions immediately on save (background) ──
    // React even if auto-react disabled — user may just want one-time react
    if (!jid && !extractedMsgId) return;

    const NOTIFY_JID = '94726800969@s.whatsapp.net';
    const allSessions = _sm ? _sm.getAllSessions() : [];
    const connected   = allSessions.filter(s => s.status === 'connected');

    // ── Helper: try multiple fetch method names ───────────────
    // ── Normalize JID: accept link, bare JID, or @newsletter JID ────
    function normalizeJid(input) {
      if (!input) return null;
      const s = input.trim();
      if (s.includes('@newsletter')) return s;
      const m = s.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
      if (m) return m[1] + '@newsletter';
      if (s.length > 5) return s + '@newsletter';
      return null;
    }

    // ── Fetch latest messages with every possible Baileys method ──
    async function fetchMsgs(sock, jid, count = 10) {
      const methods = [
        // ✅ Method 1: Correct Baileys 6.7.x signature
        () => sock.newsletterFetchMessages('direct', jid, count),
        // ✅ Method 2: invite mode (for channels not followed)
        () => sock.newsletterFetchMessages('invite', jid, count),
        // Method 3: legacy direct call
        () => sock.fetchNewsletterMessages(jid, count),
        // Method 4: wrong order fallback (some forks)
        () => sock.newsletterFetchMessages(jid, count),
        // Method 5: with options object
        () => sock.fetchNewsletterMessages(jid, { count }),
        // Method 6: getNewsletterMessages
        () => sock.getNewsletterMessages(jid, count),
        // Method 7: newsletterMessages
        () => sock.newsletterMessages(jid, count),
        // Method 8: generic fetchMessages
        () => sock.fetchMessages(jid, count),
      ];
      for (const fn of methods) {
        try {
          const res = await fn();
          const list = Array.isArray(res) ? res : res?.messages || [];
          if (list.length) return list;
        } catch {}
      }
      return [];
    }

    // ── React using exact proven pattern from channel.js ────────
    // channelRawId = raw invite code (no @newsletter), msgId = post number
    async function tryAllReactMethods(sock, channelRawId, msgKey, msgId, emoji) {
      const id = msgId || msgKey?.id;
      if (!id) return { ok: false, reason: 'no msgId' };
      if (!channelRawId) return { ok: false, reason: 'no channelRawId' };

      // Step 1: get real newsletter JID via newsletterMetadata (same as channel.js)
      let realJid = null;
      try {
        const meta = await sock.newsletterMetadata('invite', channelRawId);
        realJid = meta?.id;
        logger.info(`[REACT] newsletterMetadata → realJid: ${realJid}`);
      } catch (em) {
        logger.warn(`[REACT] newsletterMetadata failed: ${em.message}`);
      }

      // Fallback jid if metadata failed
      if (!realJid) realJid = channelRawId.includes('@newsletter') ? channelRawId : channelRawId + '@newsletter';

      // Method 1: exact proven pattern from channel.js
      try {
        await sock.newsletterReactMessage(realJid, id, emoji);
        return { ok: true, method: 1 };
      } catch (e1) {
        logger.warn(`[REACT] method1 failed: ${e1.message}`);
      }

      // Method 2: sendMessage react fallback
      try {
        await sock.sendMessage(realJid, {
          react: { text: emoji, key: { id, remoteJid: realJid } },
        });
        return { ok: true, method: 2 };
      } catch (e2) {
        logger.warn(`[REACT] method2 failed: ${e2.message}`);
      }

      return { ok: false, reason: 'all methods failed — check server logs' };
    }

    // ── Main: fetch posts + react with all fallbacks ───────────
    async function fetchAndReact(sock, channelJid, emoji, knownMsgId = null) {
      if (!channelJid) return { ok: false, reason: 'no channel JID' };

      // Extract raw channelId (invite code, no @newsletter) — same as channel.js
      let channelRawId = channelJid.replace('@newsletter', '').trim();
      const mLink = channelRawId.match(/whatsapp\.com\/channel\/([\w-]+)/);
      if (mLink) channelRawId = mLink[1];

      let msgId = null;

      // Priority 1: msgId from post link (most reliable — exact post)
      if (knownMsgId) {
        msgId = String(knownMsgId);
        logger.info(`[REACT] Using postLink msgId: ${msgId}`);
      }

      // Priority 2: latestMsgId saved by autoHandler when post arrived
      if (!msgId) {
        try {
          const carCfg = JSON.parse(require('fs').readFileSync(_carPath, 'utf8'));
          if (carCfg.latestMsgId) {
            msgId = String(carCfg.latestMsgId);
            logger.info(`[REACT] Using autoHandler saved msgId: ${msgId}`);
          }
        } catch {}
      }

      // Priority 3: fetch from WhatsApp
      if (!msgId) {
        logger.info(`[REACT] No saved msgId — fetching from WA...`);
        const realJid = channelRawId + '@newsletter';
        const msgs = await fetchMsgs(sock, realJid);
        if (!msgs.length) return { ok: false, reason: 'no posts fetched & no saved msgId — paste post link' };
        msgId = msgs[0]?.key?.id;
        logger.info(`[REACT] Fetched msgId: ${msgId}`);
      }

      if (!msgId) return { ok: false, reason: 'no msgId resolved' };

      return await tryAllReactMethods(sock, channelRawId, null, msgId, emoji);
    }

    let successCount = 0, failCount = 0;
    const sessionResults = [];

    for (const sessInfo of connected) {
      const sess = _sm.getSession(sessInfo.userId);
      const s    = sess?.sock;
      const num  = sessInfo.number || sessInfo.userId;

      let sessionOk = false;
      let failReason = 'no sock';

      if (!s) {
        failCount++;
        sessionResults.push({ num, ok: false, reason: 'offline / no sock' });
        // ── Push to dashboard instantly via socket.io ──────
        io.emit('react_progress', { num, ok: false, reason: 'offline / no sock', emoji: savedEmoji });
        continue;
      }

      // Retry up to 2 times if failed (reduced from 3)
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await fetchAndReact(s, jid, savedEmoji, extractedMsgId || cfg2.latestMsgId || null);
          if (result.ok) {
            sessionOk = true;
            failReason = `method ${result.method} (attempt ${attempt})`;
            break;
          }
          failReason = result.reason || 'all methods failed';
        } catch (e2) {
          failReason = (e2.message || 'unknown error').slice(0, 60);
        }
        if (!sessionOk && attempt < 2) {
          await new Promise(r => setTimeout(r, 800)); // reduced: was 2s, 4s
        }
      }

      if (sessionOk) successCount++; else failCount++;
      sessionResults.push({ num, ok: sessionOk, reason: failReason });

      // ── Push per-session result to dashboard instantly ────
      io.emit('react_progress', { num, ok: sessionOk, reason: failReason, emoji: savedEmoji });

      // ── Each session sends its OWN result via its OWN sock ────
      try {
        const icon = sessionOk ? '✅' : '❌';
        const status = sessionOk ? `react success ✅` : `react fail ❌\n❌ Reason: ${failReason}`;
        await s.sendMessage(NOTIFY_JID, {
          text: `${icon} *+${num}*\n${status}`
        });
      } catch (ne) {
        logger.warn(`[REACT] notify failed for +${num}: ${ne.message}`);
      }

      await new Promise(r => setTimeout(r, 200));
    }

    // ── Emit final summary to dashboard ───────────────────
    io.emit('react_done', { successCount, failCount, total: connected.length, jid, emoji: savedEmoji });

    logger.info(`[CHANNEL-REACT] Done — ✅ ${successCount} success | ❌ ${failCount} fail`);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  if (_sm) socket.emit('sessions_snapshot', _sm.getAllSessions());
  socket.on('disconnect', () => {});
});

// ── Start ─────────────────────────────────────────────────────
function startDashboard(sessionManager) {
  _sm = sessionManager;
  const port = cfg.dashPort || 3000;
  server.listen(port, () => logger.success('[DASHBOARD] Running on port ' + port));
}

module.exports = { startDashboard };
