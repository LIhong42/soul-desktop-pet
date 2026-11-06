// scripts/shot-pages.js — render several pages of the real main window to
// PNGs, so a change to shared CSS (the top bar, the cards) can be checked
// across the app instead of only on the page that was edited.
//
// Usage: node scripts/run-electron.js scripts/shot-pages.js [outDir]

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
  : path.join(os.tmpdir(), 'soulpet-pages');

const PAGES = ['/contacts', '/events/work', '/events/memorial', '/settings'];

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-pages-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const winMain = new BrowserWindow({
    width: 1280,
    height: 860,
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
      // The mood portrait on the 今日 page reads the pet's own picture;
      // this stub has no pet, so it reports none and the page falls back
      // to the mood emoji.
      getPortrait: () => null,
      isImported: () => false,
      getRootDir: () => '',
      rescan: () => {},
    },
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  // Surface renderer-side console errors — a page that renders an error
  // box instead of its content is invisible in a screenshot.
  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });

  for (const p of PAGES) {
    // Navigate directly, the way a user clicking the nav link would. Do
    // NOT route through an unknown sentinel hash: the router's
    // unknown-route fallback redirects to /today, and that redirect races
    // with the page being captured — the page's own render then finds an
    // empty DOM and throws.
    await winMain.webContents.executeJavaScript(`location.hash = '#${p}'; true`);
    await new Promise((r) => setTimeout(r, 1400));
    const landed = await winMain.webContents.executeJavaScript(`location.hash`);
    const name = p.replace(/\//g, '-').replace(/^-/, '') || 'root';
    const file = path.join(OUT_DIR, `${name}.png`);
    const shot = await winMain.webContents.capturePage();
    fs.writeFileSync(file, shot.toPNG());
    console.log(`wrote ${file}  (hash=${landed})`);
  }

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
