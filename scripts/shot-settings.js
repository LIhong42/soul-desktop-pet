// scripts/shot-settings.js — render the settings page's sections to PNGs,
// so the nav-rail layout can be checked visually.
//
// Usage: node scripts/run-electron.js scripts/shot-settings.js [outDir]
//
// The page is now split into a nav rail and one panel, so a screenshot of
// "/settings" alone only shows the default section. This captures a few
// sections — the busiest ones — plus the narrow-window fallback, where the
// rail becomes a horizontal strip above the panel.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));

const OUT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'soulpet-settings-shot');

// The sections worth looking at: the default one, the densest one (角色动作
// has the trigger table + the loop list + the effect bindings), and the
// narrowest content one.
const SHOTS = [
  { hash: '/settings/pet',       name: 'settings-pet' },
  { hash: '/settings/actions',   name: 'settings-actions' },
  { hash: '/settings/texts',     name: 'settings-texts' },
  { hash: '/settings/bubbles',   name: 'settings-bubbles' },
  { hash: '/settings/startup',   name: 'settings-startup' },
  { hash: '/settings/wake',      name: 'settings-wake' },
  { hash: '/settings/background', name: 'settings-background' },
  { hash: '/settings/update',    name: 'settings-update' },
  { hash: '/settings/backup',    name: 'settings-backup' },
  { hash: '/settings/pin',       name: 'settings-pin' },
  { hash: '/settings/about',     name: 'settings-about' },
];

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-settings-shot-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const winMain = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const queue = new scheduler.ReminderQueue();
  ipc.register({
    queue,
    winMain,
    winPet: null,
    setPetState: () => {},
    getPetState: () => false,
    setActiveReminder: () => {},
    broadcastPetState: () => {},
    petController: null,
    petRegistry: {
      list: () => [],
      getManifest: () => null,
      resolveFrames: () => ({ frames: [], variantHint: '', loop: true }),
      getPortrait: () => null,
      isImported: () => false,
      getRootDir: () => '',
      rescan: () => {},
    },
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });

  for (const s of SHOTS) {
    await winMain.webContents.executeJavaScript(`location.hash = '#${s.hash}'; true`);
    await new Promise((r) => setTimeout(r, 1400));
    const file = path.join(OUT_DIR, `${s.name}.png`);
    const shot = await winMain.webContents.capturePage();
    fs.writeFileSync(file, shot.toPNG());
    console.log(`wrote ${file}`);
  }

  // The narrow-window fallback: the rail turns into a horizontal strip of
  // chips above the panel.
  winMain.setSize(760, 900);
  await new Promise((r) => setTimeout(r, 600));
  await winMain.webContents.executeJavaScript(`location.hash = '#/settings/pet'; true`);
  await new Promise((r) => setTimeout(r, 1200));
  const narrow = path.join(OUT_DIR, 'settings-narrow.png');
  const shot = await winMain.webContents.capturePage();
  fs.writeFileSync(narrow, shot.toPNG());
  console.log(`wrote ${narrow}`);

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
