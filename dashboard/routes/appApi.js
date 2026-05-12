'use strict';
/**
 * UNITY-MD — Mobile App API
 * Auth: simple APP_SECRET header (set APP_SECRET in Railway env)
 * Header: x-app-secret: <APP_SECRET>
 */

const express = require('express');
const router  = express.Router();

function getSM() { return require('../../src/sessionManager'); }

// ── Simple secret auth ────────────────────────────────────────
// Set APP_SECRET in Railway environment variables.
// Flutter app sends: headers: { 'x-app-secret': '<value>' }
const APP_SECRET = 'unity_md_2025_@secret#key';

function appAuth(req, res, next) {
  const provided = req.headers['x-app-secret'] || '';
  if (provided !== APP_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  req.appUser = { uid: 'app', email: '', name: 'app' };
  next();
}

function normalizePhone(phone) { return phone.replace(/[^0-9]/g, ''); }
function buildUserId(uid, phone) { return `${uid}:${phone}`; }

// ── POST /api/app/register ────────────────────────────────────
router.post('/register', appAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 7 || cleanPhone.length > 15)
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });

    const userId = buildUserId(req.appUser.uid, cleanPhone);
    const sm = getSM();

    const existing = sm.getSession(userId);
    if (existing?.status === sm.STATUS.CONNECTED) {
      return res.json({ ok: true, status: 'connected', userId, phone: cleanPhone });
    }

    const sess = await sm.startSession(userId);
    let waited = 0;
    while (!sess.pairCode && sess.status !== sm.STATUS.CONNECTED
           && sess.status !== sm.STATUS.ERROR && waited < 30000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    if (sess.status === sm.STATUS.CONNECTED)
      return res.json({ ok: true, status: 'connected', userId, phone: cleanPhone });
    if (sess.pairCode)
      return res.json({ ok: true, status: 'pairing', userId, phone: cleanPhone, pairCode: sess.pairCode });

    return res.status(500).json({ ok: false, error: 'Could not get pair code. Try again.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/app/status/:uid ──────────────────────────────────
router.get('/status/:uid', appAuth, async (req, res) => {
  try {
    const sm   = getSM();
    const sess = sm.getSession(req.params.uid);
    if (!sess) return res.json({ ok: true, status: 'disconnected' });
    res.json({ ok: true, status: sess.status, pairCode: sess.pairCode || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/app/reconnect ───────────────────────────────────
router.post('/reconnect', appAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const userId = buildUserId(req.appUser.uid, normalizePhone(phone));
    const sm     = getSM();

    const existing = sm.getSession(userId);
    if (existing?.status === sm.STATUS.CONNECTED)
      return res.json({ ok: true, status: 'connected', userId });

    await sm.startSession(userId);
    let waited = 0;
    while (waited < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
      const s = sm.getSession(userId);
      if (s?.status === sm.STATUS.CONNECTED)
        return res.json({ ok: true, status: 'connected', userId });
      if (s?.pairCode)
        return res.json({ ok: true, status: 'pairing', userId, pairCode: s.pairCode });
    }

    const s = sm.getSession(userId);
    res.json({ ok: true, status: s?.status || 'connecting', userId });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/app/disconnect ──────────────────────────────────
router.post('/disconnect', appAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
    const userId = buildUserId(req.appUser.uid, normalizePhone(phone));
    await getSM().stopSession(userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/app/bot/info/:phone ──────────────────────────────
router.get('/bot/info/:phone', appAuth, async (req, res) => {
  try {
    const cleanPhone = normalizePhone(req.params.phone);
    const userId     = buildUserId(req.appUser.uid, cleanPhone);
    const sm         = getSM();
    const sess       = sm.getSession(userId);

    let cmdCount = 0;
    try { const { plugins } = require('../../src/commands/messageHandler');
          cmdCount = Object.keys(plugins || {}).length; } catch {}

    if (!sess) return res.json({ ok: true, status: 'disconnected', phone: cleanPhone,
      uptime: null, commandCount: cmdCount });

    const uptime = sess.connectedAt
      ? Math.floor((Date.now() - new Date(sess.connectedAt).getTime()) / 1000) : null;

    res.json({ ok: true, status: sess.status, phone: cleanPhone,
      uptime, commandCount: cmdCount, connectedAt: sess.connectedAt });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/app/ping ─────────────────────────────────────────
router.get('/ping', (_, res) => res.json({ ok: true, server: 'UNITY-MD', ts: Date.now() }));

// ── POST /api/app/restart ─────────────────────────────────────
// App restart button → bot reconnects → startup msg + audio fires
router.post('/restart', appAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const userId = buildUserId(req.appUser.uid, normalizePhone(phone));
    const sm     = getSM();

    // Stop existing session then restart — triggers connection.open → startup msg
    await sm.stopSession(userId).catch(() => {});
    setTimeout(() => sm.startSession(userId).catch(() => {}), 2000);

    res.json({ ok: true, message: 'Bot restarting...' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════
// APP CHAT — VIRTUAL CHANNEL
// ───────────────────────────────────────────────────────────────
// No WhatsApp group. Bot processes commands in a virtual DM.
// sock.sendMessage is intercepted for ownerJid while _appChatActive.
// All bot replies → chatStore → app polls and shows them.
// ═══════════════════════════════════════════════════════════════

const chatStore = new Map();   // phone → [ {id, fromMe, text, type, ts} ]
const CHAT_MAX  = 200;

function chatPush(phone, msg) {
  if (!chatStore.has(phone)) chatStore.set(phone, []);
  const arr = chatStore.get(phone);
  arr.push(msg);
  if (arr.length > CHAT_MAX) arr.splice(0, arr.length - CHAT_MAX);
}

// ── Wrap sock.sendMessage once per session ────────────────────
// When sock._appChatActive = true, replies to ownerJid go to chatStore
// instead of (or in addition to) WhatsApp.
function _wrapSockForAppChat(sock, cleanPhone) {
  if (sock._appChatWrapped) return;
  sock._appChatWrapped = true;
  sock._appChatPhone   = cleanPhone;

  const _orig = sock.sendMessage.bind(sock);

  sock.sendMessage = async (jid, content, opts) => {
    const ownerJid = `${cleanPhone}@s.whatsapp.net`;

    if (jid === ownerJid && sock._appChatActive) {
      // ── Intercept: extract readable content ─────────────────
      let text = content.text || content.caption || '';
      let type = 'text';

      if (content.image)    { type = 'image';    text = text || '[📷 Image]'; }
      if (content.audio)    { type = 'audio';    text = text || '[🎙 Voice Note]'; }
      if (content.video)    { type = 'video';    text = text || '[🎬 Video]'; }
      if (content.sticker)  { type = 'sticker';  text = '[🎭 Sticker]'; }
      if (content.document) { type = 'document';
        text = text || `[📄 ${content.fileName || 'Document'}]`; }

      // Buttons / interactive → flatten to text list
      const btns = content.buttons || content.templateButtons || [];
      if (btns.length) {
        const btnLines = btns
          .map(b => `▸ ${b.buttonText?.displayText || b.displayText || ''}`)
          .filter(Boolean).join('\n');
        text = [content.text || content.caption || '', btnLines]
          .filter(Boolean).join('\n\n');
      }

      // List messages
      if (content.list) {
        const rows = (content.list.sections || []).flatMap(s => s.rows || []);
        const rowLines = rows.map(r => `▸ ${r.title}`).join('\n');
        text = [
          content.list.title || '',
          content.list.description || '',
          rowLines,
        ].filter(Boolean).join('\n');
      }

      chatPush(cleanPhone, {
        id:     `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        fromMe: false,
        text:   text || '[Message]',
        type,
        ts:     Date.now(),
      });

      // Return fake key so bot code doesn't throw
      return { key: { id: `fakebot_${Date.now()}`, fromMe: true, remoteJid: jid } };
    }

    // Not an app-chat reply — send normally via WhatsApp
    return _orig(jid, content, opts);
  };
}

// ── POST /api/app/chat/setup ──────────────────────────────────
// Sets up virtual channel (no group creation needed)
router.post('/chat/setup', appAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const cleanPhone = normalizePhone(phone);
    const { getSession } = require('../../src/sessionManager');
    const userId  = buildUserId(req.appUser.uid, cleanPhone);
    const session = getSession(userId);
    const sock    = session?.sock;
    if (!sock) return res.status(503).json({ ok: false, error: 'Bot not connected' });

    _wrapSockForAppChat(sock, cleanPhone);

    res.json({ ok: true, jid: `${cleanPhone}@s.whatsapp.net` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/app/chat/jid/:phone ──────────────────────────────
// Returns ownerJid if bot is connected (virtual channel is always ready)
router.get('/chat/jid/:phone', appAuth, async (req, res) => {
  try {
    const cleanPhone = normalizePhone(req.params.phone);
    const { getSession } = require('../../src/sessionManager');
    const userId  = buildUserId(req.appUser.uid, cleanPhone);
    const session = getSession(userId);

    if (!session?.sock) return res.json({ ok: true, jid: null });

    // Ensure sock is wrapped on every connect/reconnect
    _wrapSockForAppChat(session.sock, cleanPhone);

    res.json({ ok: true, jid: `${cleanPhone}@s.whatsapp.net` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/app/chat/send ───────────────────────────────────
// User sends text or command → bot processes → reply intercepted to chatStore
router.post('/chat/send', appAuth, async (req, res) => {
  try {
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone + text required' });

    const cleanPhone = normalizePhone(phone);
    const { getSession } = require('../../src/sessionManager');
    const userId  = buildUserId(req.appUser.uid, cleanPhone);
    const session = getSession(userId);
    const sock    = session?.sock;
    if (!sock) return res.status(503).json({ ok: false, error: 'Bot not connected' });

    _wrapSockForAppChat(sock, cleanPhone);

    const ownerJid = `${cleanPhone}@s.whatsapp.net`;
    const msgId    = `APP_${Date.now()}`;

    // ① Save user's outgoing bubble immediately
    chatPush(cleanPhone, {
      id:     msgId,
      fromMe: true,
      text,
      type:   'text',
      ts:     Date.now(),
    });

    // ② Activate intercept — bot replies to ownerJid go to chatStore
    sock._appChatActive = true;

    // ③ Emit fake DM message from ownerJid (not a group)
    //    parser sees: fromMe=false, remoteJid=ownerJid, no participant
    //    → isOwner=true, isGroup=false → command runs with owner perms
    //    → m.reply() calls sock.sendMessage(ownerJid, ...) → intercepted ✅
    sock.ev.emit('messages.upsert', {
      messages: [{
        key: {
          fromMe:      false,
          remoteJid:   ownerJid,
          id:          msgId,
          // no participant — this is a DM not a group
        },
        message:          { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName:         'App',
      }],
      type: 'notify',
    });

    // ④ Clear intercept flag after 10s (command should have replied by then)
    setTimeout(() => { try { sock._appChatActive = false; } catch (_) {} }, 10000);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/app/chat/messages/:phone ─────────────────────────
router.get('/chat/messages/:phone', appAuth, async (req, res) => {
  try {
    const cleanPhone = normalizePhone(req.params.phone);
    const messages   = chatStore.get(cleanPhone) || [];
    res.json({ ok: true, messages });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
