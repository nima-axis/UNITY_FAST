'use strict';
/**
 * UNITY-MD — Mobile App API
 * ─────────────────────────────────────────────────────────────
 * Flutter app ට specific endpoints.
 * Firebase Google Sign-in ලෙ authenticate කරනවා.
 *
 * Endpoints:
 *   POST /api/app/register      → phone number register + pair code get
 *   GET  /api/app/status/:uid   → session status check
 *   POST /api/app/reconnect     → existing session reconnect (no re-pair)
 *   POST /api/app/disconnect    → session stop
 *   GET  /api/app/bot/info/:uid → bot info (name, commands count, uptime)
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');

// ── Lazy-load sessionManager (avoids circular deps) ───────────
function getSM() {
  return require('../../src/sessionManager');
}

// ── Firebase token verify ─────────────────────────────────────
// Verifies Google Sign-In ID token from Flutter app.
// Returns { uid, email, name } or throws.
async function verifyFirebaseToken(idToken) {
  if (!idToken) throw new Error('No token provided');

  // Use Firebase REST API to verify token
  const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
  if (!FIREBASE_PROJECT_ID) {
    // Dev mode: skip verification, extract uid from token payload
    // (DO NOT use in production)
    try {
      const payload = JSON.parse(
        Buffer.from(idToken.split('.')[1], 'base64').toString()
      );
      return { uid: payload.sub || payload.user_id, email: payload.email, name: payload.name };
    } catch {
      throw new Error('Invalid token (dev mode)');
    }
  }

  // Production: verify via Google tokeninfo endpoint
  const resp = await axios.get(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`,
    { timeout: 8000 }
  );
  const data = resp.data;
  if (data.aud !== process.env.FIREBASE_CLIENT_ID) {
    throw new Error('Token audience mismatch');
  }
  return {
    uid:   data.sub,
    email: data.email,
    name:  data.name,
  };
}

// ── Auth middleware ───────────────────────────────────────────
// Expects: Authorization: Bearer <firebase_id_token>
async function appAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const user = await verifyFirebaseToken(token);
    req.appUser = user; // { uid, email, name }
    next();
  } catch (e) {
    res.status(401).json({ ok: false, error: 'Unauthorized: ' + e.message });
  }
}

// ── Helper: normalize phone number ───────────────────────────
function normalizePhone(phone) {
  return phone.replace(/[^0-9]/g, '');
}

// ── Helper: build session userId ─────────────────────────────
// Format: firebaseUID:phoneNumber
// This links one Firebase account to one WhatsApp number.
function buildUserId(uid, phone) {
  return `${uid}:${phone}`;
}

// ─────────────────────────────────────────────────────────────
// POST /api/app/register
// Body: { phone: "94771234567" }
// Headers: Authorization: Bearer <firebase_token>
//
// First time: starts session + returns pair code
// Already paired: returns connected status
// ─────────────────────────────────────────────────────────────
router.post('/register', appAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 7 || cleanPhone.length > 15) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }

    const { uid, email, name } = req.appUser;
    const userId = buildUserId(uid, cleanPhone);

    const sm = getSM();

    // Check if already connected
    const existing = sm.getSession(userId);
    if (existing?.status === sm.STATUS.CONNECTED) {
      return res.json({
        ok: true,
        status: 'connected',
        userId,
        phone: cleanPhone,
        message: 'Bot already active',
      });
    }

    // Start session
    const sess = await sm.startSession(userId);

    // Wait for pair code (max 30s)
    let waited = 0;
    while (
      !sess.pairCode &&
      sess.status !== sm.STATUS.CONNECTED &&
      sess.status !== sm.STATUS.ERROR &&
      waited < 30000
    ) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    if (sess.status === sm.STATUS.CONNECTED) {
      return res.json({
        ok: true,
        status: 'connected',
        userId,
        phone: cleanPhone,
        message: 'Bot connected!',
      });
    }

    if (sess.pairCode) {
      return res.json({
        ok: true,
        status: 'pairing',
        userId,
        phone: cleanPhone,
        pairCode: sess.pairCode,
        message: 'Enter this code in WhatsApp → Linked Devices',
      });
    }

    return res.status(500).json({
      ok: false,
      status: sess.status,
      error: 'Could not get pair code. Try again.',
    });

  } catch (e) {
    console.error('[APP API] /register error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/app/status/:uid
// Check current session status for a userId
// ─────────────────────────────────────────────────────────────
router.get('/status/:uid', appAuth, async (req, res) => {
  try {
    const userId = req.params.uid;

    // Security: uid must belong to authenticated user
    if (!userId.startsWith(req.appUser.uid + ':')) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const sm   = getSM();
    const sess = sm.getSession(userId);

    if (!sess) {
      return res.json({
        ok: true,
        status: 'disconnected',
        userId,
        message: 'No active session',
      });
    }

    return res.json({
      ok: true,
      status: sess.status,
      userId,
      pairCode:    sess.pairCode || null,
      connectedAt: sess.connectedAt || null,
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/app/reconnect
// Body: { userId: "uid:phone" }
// Reconnects existing session without re-pairing.
// Used on app open when session was previously saved.
// ─────────────────────────────────────────────────────────────
router.post('/reconnect', appAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

    // Security check
    if (!userId.startsWith(req.appUser.uid + ':')) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const sm   = getSM();
    const sess = sm.getSession(userId);

    // Already connected
    if (sess?.status === sm.STATUS.CONNECTED) {
      return res.json({
        ok: true,
        status: 'connected',
        userId,
        message: 'Already connected',
      });
    }

    // Try to restore from DB (no re-pair needed if creds saved)
    await sm.startSession(userId);

    // Wait a bit to see if it connects from saved creds
    let waited = 0;
    while (waited < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
      const s = sm.getSession(userId);
      if (s?.status === sm.STATUS.CONNECTED) {
        return res.json({
          ok: true,
          status: 'connected',
          userId,
          message: 'Reconnected successfully',
        });
      }
      if (s?.pairCode) {
        // Needs re-pair (e.g. WhatsApp logged out)
        return res.json({
          ok: true,
          status: 'pairing',
          userId,
          pairCode: s.pairCode,
          message: 'WhatsApp session expired. Please re-pair.',
        });
      }
    }

    const s = sm.getSession(userId);
    return res.json({
      ok: true,
      status: s?.status || 'connecting',
      userId,
      message: 'Connecting...',
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/app/disconnect
// Body: { userId: "uid:phone" }
// Stops bot session.
// ─────────────────────────────────────────────────────────────
router.post('/disconnect', appAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

    if (!userId.startsWith(req.appUser.uid + ':')) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const sm = getSM();
    await sm.stopSession(userId);

    res.json({ ok: true, message: 'Bot disconnected' });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/app/bot/info/:uid
// Returns bot info: status, uptime, phone, commands count
// ─────────────────────────────────────────────────────────────
router.get('/bot/info/:uid', appAuth, async (req, res) => {
  try {
    const userId = req.params.uid;

    if (!userId.startsWith(req.appUser.uid + ':')) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const sm   = getSM();
    const sess = sm.getSession(userId);

    let cmdCount = 0;
    try {
      const { plugins } = require('../src/commands/messageHandler');
      cmdCount = Object.keys(plugins || {}).length;
    } catch {}

    const phone = userId.split(':')[1] || '';

    if (!sess) {
      return res.json({
        ok: true,
        status: 'disconnected',
        phone,
        uptime: null,
        commandCount: cmdCount,
      });
    }

    const uptime = sess.connectedAt
      ? Math.floor((Date.now() - new Date(sess.connectedAt).getTime()) / 1000)
      : null;

    res.json({
      ok: true,
      status: sess.status,
      phone,
      uptime,           // seconds
      commandCount: cmdCount,
      connectedAt: sess.connectedAt,
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/app/ping
// Health check — no auth needed
// ─────────────────────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ ok: true, server: 'UNITY-MD', ts: Date.now() });
});

module.exports = router;
