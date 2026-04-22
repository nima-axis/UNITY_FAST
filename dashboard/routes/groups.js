'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../../src/database');
const { requireAuth } = require('./auth');

let _getSock = null;
function setSock(fn) { _getSock = fn; }

// ── List groups ───────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const sock = _getSock?.();
    if (!sock) return res.json({ groups: [] });
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({
      id:      g.id,
      name:    g.subject,
      members: g.participants.length,
      admins:  g.participants.filter(p => p.admin).length,
      created: g.creation,
    }));
    res.json({ groups: list });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Get group settings ────────────────────────────────────────
router.get('/:jid', requireAuth, async (req, res) => {
  try {
    const group = await db.getGroup(decodeURIComponent(req.params.jid));
    res.json({ group });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Update group settings ─────────────────────────────────────
router.post('/:jid/settings', requireAuth, async (req, res) => {
  try {
    const group = await db.getGroup(decodeURIComponent(req.params.jid));
    Object.assign(group.settings, req.body);
    await group.save();
    res.json({ success: true, settings: group.settings });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Get group members ─────────────────────────────────────────
router.get('/:jid/members', requireAuth, async (req, res) => {
  try {
    const sock = _getSock?.();
    if (!sock) return res.json({ members: [] });
    const meta = await sock.groupMetadata(decodeURIComponent(req.params.jid));
    const members = meta.participants.map(p => ({
      id:    p.id,
      admin: p.admin || null,
    }));
    res.json({ members });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Kick member ───────────────────────────────────────────────
router.post('/:jid/kick', requireAuth, async (req, res) => {
  try {
    const sock   = _getSock?.();
    const { target } = req.body;
    if (!sock || !target) return res.json({ error: 'Missing data' });
    await sock.groupParticipantsUpdate(
      decodeURIComponent(req.params.jid),
      [target],
      'remove'
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Promote member ────────────────────────────────────────────
router.post('/:jid/promote', requireAuth, async (req, res) => {
  try {
    const sock   = _getSock?.();
    const { target } = req.body;
    if (!sock || !target) return res.json({ error: 'Missing data' });
    await sock.groupParticipantsUpdate(
      decodeURIComponent(req.params.jid),
      [target],
      'promote'
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Demote member ─────────────────────────────────────────────
router.post('/:jid/demote', requireAuth, async (req, res) => {
  try {
    const sock   = _getSock?.();
    const { target } = req.body;
    if (!sock || !target) return res.json({ error: 'Missing data' });
    await sock.groupParticipantsUpdate(
      decodeURIComponent(req.params.jid),
      [target],
      'demote'
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Send message to group ─────────────────────────────────────
router.post('/:jid/send', requireAuth, async (req, res) => {
  try {
    const sock = _getSock?.();
    const { message } = req.body;
    if (!sock || !message) return res.json({ error: 'Missing data' });
    const cfg = require('../../config');
    await sock.sendMessage(
      decodeURIComponent(req.params.jid),
      { text: `${message}\n\n${cfg.footer}` }
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Get group rules ───────────────────────────────────────────
router.get('/:jid/rules', requireAuth, async (req, res) => {
  try {
    const group = await db.getGroup(decodeURIComponent(req.params.jid));
    res.json({ rules: group.rules || [] });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Update group rules ────────────────────────────────────────
router.post('/:jid/rules', requireAuth, async (req, res) => {
  try {
    const { rules } = req.body;
    const group = await db.getGroup(decodeURIComponent(req.params.jid));
    group.rules = rules;
    await group.save();
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

module.exports = { router, setSock };