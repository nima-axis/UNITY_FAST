'use strict';
const express = require('express');
const router  = express.Router();
const cfg     = require('../../config');

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === cfg.dashPassword) {
    req.session.authenticated = true;
    req.session.loginTime = Date.now();
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

router.get('/check', (req, res) => {
  res.json({
    authenticated: !!req.session?.authenticated,
    loginTime: req.session?.loginTime,
  });
});

module.exports = { router, requireAuth };