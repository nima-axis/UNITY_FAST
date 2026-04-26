'use strict';
/**
 * UNITY-MD — Image Pool Cache (Local Banner Edition)
 * ──────────────────────────────────────────────────────────────────────────
 * src/media/ folder ලෙස images 3ක් serve කරනවා:
 *
 *   unity_banner_1.jpg  ← Main rotation (image 1 - collage)
 *   unity_banner_2.jpg  ← Main rotation (image 2 - day scene)
 *   unity_submenu.jpg   ← Sub menu commands විතරක් (image 3 - night scene)
 *
 * getPoolImage()    → banner_1 / banner_2 alternating (every other message)
 * getSubMenuImage() → unity_submenu.jpg (sub menu commands)
 *
 * Network calls / external APIs — කිසිම දෙයක් නෑ.
 * ──────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const fs   = require('fs-extra');

const MEDIA_DIR = path.join(__dirname, '../../src/media');

// ── Image paths ──────────────────────────────────────────────
const BANNER_IMAGES = [
  path.join(MEDIA_DIR, 'unity_banner_1.jpg'),
  path.join(MEDIA_DIR, 'unity_banner_2.jpg'),
];
const SUBMENU_IMAGE = path.join(MEDIA_DIR, 'unity_submenu.jpg');

// ── Sub menu command list ────────────────────────────────────
const SUB_MENU_CMDS = new Set([
  'menu_bot', 'menu_group', 'menu_download', 'menu_ai',
  'menu_sticker', 'menu_fun', 'menu_tools', 'menu_anime',
  'menu_games', 'menu_protection', 'menu_privacy',
  'menu_auto', 'menu_channel', 'menu_srilanka', 'menu_stats',
]);

// ── Internal state ───────────────────────────────────────────
let cursor = 0;

// ── Helpers ──────────────────────────────────────────────────
function isValidJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 2000
    && buf[0] === 0xFF && buf[1] === 0xD8;
}

function readImage(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return isValidJpeg(buf) ? buf : null;
  } catch { return null; }
}

// ── Public API ───────────────────────────────────────────────

/**
 * initImagePool()
 * Bot start / restart වෙද්දි call කරන්න — validates local files.
 */
async function initImagePool() {
  console.log('[imageCache] Loading Unity banner images from src/media/...');
  let found = 0;
  for (const p of [...BANNER_IMAGES, SUBMENU_IMAGE]) {
    const buf = readImage(p);
    if (buf) {
      console.log(`[imageCache]  OK: ${path.basename(p)} (${buf.length} bytes)`);
      found++;
    } else {
      console.warn(`[imageCache]  Missing/invalid: ${path.basename(p)}`);
    }
  }
  cursor = 0;
  console.log(`[imageCache] Ready — ${found}/3 images available`);
}

/**
 * getPoolImage()
 * Main rotation: unity_banner_1.jpg ↔ unity_banner_2.jpg alternating.
 */
function getPoolImage() {
  for (let i = 0; i < BANNER_IMAGES.length; i++) {
    const idx = (cursor + i) % BANNER_IMAGES.length;
    const buf = readImage(BANNER_IMAGES[idx]);
    if (buf) {
      cursor = (idx + 1) % BANNER_IMAGES.length;
      return buf;
    }
  }
  console.warn('[imageCache] Both banner images unavailable');
  return null;
}

/**
 * getSubMenuImage()
 * Sub menu commands විතරයි — unity_submenu.jpg.
 * Fallback: getPoolImage() (banner rotation).
 */
function getSubMenuImage() {
  const buf = readImage(SUBMENU_IMAGE);
  if (buf) return buf;
  console.warn('[imageCache] Submenu image unavailable, using banner fallback');
  return getPoolImage();
}

/**
 * isSubMenuCmd(cmd)
 * messageHandler ලෙස command check කරන්න.
 */
function isSubMenuCmd(cmd) {
  return SUB_MENU_CMDS.has(cmd);
}

/** isPoolReady() */
function isPoolReady() {
  return [...BANNER_IMAGES, SUBMENU_IMAGE].some(p => readImage(p) !== null);
}

module.exports = { initImagePool, getPoolImage, getSubMenuImage, isSubMenuCmd, isPoolReady };
