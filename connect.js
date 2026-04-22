'use strict';
/**
 * UNITY-MD — Multi-User Entry Point
 * Boots DB, restores sessions, starts dashboard
 */
require('dotenv').config({ path: './config.env' });

const chalk   = require('chalk');
const cfg     = require('./config');
const db      = require('./src/commands/index');
const { loadPlugins, plugins } = require('./src/commands/messageHandler');
const { restoreActiveSessions, STATUS } = require('./src/sessionManager');
const { startDashboard } = require('./dashboard/server');

function showBanner() {
  console.log(chalk.cyan(`
╔════════════════════════════════════════╗
║                                        ║
║   🧲  ❮❮  𝐔𝐍𝐈𝐓𝐘 - M D  ❯❯  🧩          ║
║        ® U N I T Y   T E A M           ║
║                                        ║
╠════════════════════════════════════════╣
║  Mode    : Multi-User (99999+)         ║
║  Version : 2.0.0                       ║
║  DB      : MongoDB                     ║
╚════════════════════════════════════════╝`));
  console.log(chalk.gray('\n  Booting up...\n'));
}

function onSessionUpdate(userId, update) {
  const icons = {
    connecting:   chalk.yellow('🔄'),
    connected:    chalk.green('✅'),
    pairing:      chalk.yellow('🔑'),
    disconnected: chalk.red('❌'),
    error:        chalk.red('💥'),
  };
  const icon = icons[update.status] || '•';
  if (update.pairCode) {
    console.log(chalk.cyan(icon + ' [' + userId + '] Pair Code: ') + chalk.bgWhite.black.bold(' ' + update.pairCode + ' '));
  } else {
    console.log(icon + ' [' + userId + '] ' + update.status);
  }
}

async function main() {
  showBanner();
  loadPlugins();
  console.log(chalk.cyan('[🧲] ' + plugins.size + ' commands loaded'));

  await db.connect();

  const count = await restoreActiveSessions(onSessionUpdate);
  console.log(chalk.green('\n[✅] ' + count + ' sessions restored'));

  const sessionManager = require('./src/sessionManager');
  startDashboard(sessionManager);

  console.log(chalk.green('\n[🚀] UNITY-MD Multi-User running!\n'));

  // Auto-fetch menu images in background
  const { refreshMenuImages } = require('./src/commands/imenu');
  const _fs = require('fs'), _path = require('path');
  const _menuDir = _path.join(__dirname, 'database/menucards');
  let _missing = false;
  for (let _i = 1; _i <= 14; _i++) {
    if (!_fs.existsSync(_path.join(_menuDir, `menu_${String(_i).padStart(2,'0')}.jpg`))) { _missing = true; break; }
  }
  if (_missing) {
    console.log(chalk.yellow('[🖼️] Menu images missing — fetching in background...'));
    setImmediate(async () => {
      const _res = await refreshMenuImages();
      const _ok = _res.filter(r => r.success).length;
      console.log(chalk.green(`[🖼️] Menu images ready: ${_ok}/14`));
    });
  } else {
    console.log(chalk.green('[🖼️] All menu images cached ✅'));
  }
}

main().catch(e => {
  console.error(chalk.red('[FATAL]'), e.message);
  process.exit(1);
});

process.on('uncaughtException',  e => console.error(chalk.red('[UNCAUGHT]'),  e.message));
process.on('unhandledRejection', e => console.error(chalk.red('[UNHANDLED]'), e?.message || e));
