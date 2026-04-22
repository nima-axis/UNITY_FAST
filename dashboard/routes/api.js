'use strict';
const express  = require('express');
const router   = express.Router();
const cfg      = require('../../config');
const db       = require('../../src/database');
const { requireAuth } = require('./auth');

let _getSock = null;
function setSock(fn) { _getSock = fn; }

// ── Status ────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const sock = _getSock?.();
    const { plugins } = require('../../src/handlers/messageHandler');
    const mem    = process.memoryUsage();
    const uptime = process.uptime();
    res.json({
      online:      !!sock?.user,
      botNumber:   sock?.user?.id?.split(':')[0] || 'N/A',
      botName:     cfg.botName,
      uptime:      Math.floor(uptime),
      uptimeStr:   `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`,
      ram:         (mem.rss/1024/1024).toFixed(1),
      heap:        (mem.heapUsed/1024/1024).toFixed(1),
      commands:    plugins.size,
      nodeVersion: process.version,
      timestamp:   new Date().toISOString(),
    });
  } catch (e) {
    res.json({ online: false, error: e.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const days   = parseInt(req.query.days) || 7;
    const stats  = await db.getStats(days);
    const users  = await db.User.countDocuments();
    const groups = await db.Group.countDocuments();
    res.json({ stats, users, groups });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Plugins ───────────────────────────────────────────────────
router.get('/plugins', requireAuth, (req, res) => {
  try {
    const { plugins } = require('../../src/handlers/messageHandler');
    const list = [...plugins.entries()].map(([cmd, plugin]) => ({
      command:   cmd,
      ownerOnly: !!plugin.ownerOnly,
      adminOnly: !!plugin.adminOnly,
      groupOnly: !!plugin.groupOnly,
    }));
    res.json({ plugins: list, total: plugins.size });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Audit log ─────────────────────────────────────────────────
router.get('/audit', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs  = await db.Audit
      .find()
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    res.json({ logs });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Users ─────────────────────────────────────────────────────
router.get('/users', requireAuth, async (req, res) => {
  try {
    const users = await db.User
      .find()
      .sort({ totalCommands: -1 })
      .limit(100)
      .lean();
    res.json({ users });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Ban user ──────────────────────────────────────────────────
router.post('/users/:jid/ban', requireAuth, async (req, res) => {
  try {
    await db.banUser(decodeURIComponent(req.params.jid));
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Unban user ────────────────────────────────────────────────
router.post('/users/:jid/unban', requireAuth, async (req, res) => {
  try {
    await db.unbanUser(decodeURIComponent(req.params.jid));
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Broadcast ─────────────────────────────────────────────────
router.post('/broadcast', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.json({ error: 'No message' });
    const sock = _getSock?.();
    if (!sock) return res.json({ error: 'Bot offline' });
    const groups = await sock.groupFetchAllParticipating();
    let sent = 0;
    for (const [jid] of Object.entries(groups)) {
      await sock.sendMessage(jid, {
        text: `📢 *Broadcast*\n\n${message}\n\n${cfg.footer}`
      }).catch(() => {});
      sent++;
      await new Promise(r => setTimeout(r, 800));
    }
    res.json({ success: true, sent });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Restart ───────────────────────────────────────────────────
router.post('/restart', requireAuth, (req, res) => {
  res.json({ success: true });
  setTimeout(() => process.exit(1), 1000);
});

// ── Backup ────────────────────────────────────────────────────
router.get('/backup', requireAuth, async (req, res) => {
  try {
    const users  = await db.User.find().lean();
    const groups = await db.Group.find().lean();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition',
      `attachment; filename=unity_backup_${Date.now()}.json`);
    res.json({
      version:   '1.0.0',
      timestamp: new Date().toISOString(),
      users,
      groups,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Restore ───────────────────────────────────────────────────
router.post('/restore', requireAuth, async (req, res) => {
  try {
    const { users, groups } = req.body;
    if (users?.length) {
      for (const u of users) {
        await db.User.findOneAndUpdate(
          { jid: u.jid }, u, { upsert: true }
        );
      }
    }
    if (groups?.length) {
      for (const g of groups) {
        await db.Group.findOneAndUpdate(
          { jid: g.jid }, g, { upsert: true }
        );
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

module.exports = { router, setSock };