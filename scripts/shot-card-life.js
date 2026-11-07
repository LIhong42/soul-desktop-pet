// scripts/shot-card-life.js — render the 抽卡人生 page in the REAL main
// window and save a PNG, so the page's visual design can be checked without
// a human driving the app.
//
// It uses the real preload + the real IPC handlers, so what lands in the
// PNG is what the user sees (the shared background artwork, the real card
// deck, the real drawn card).
//
// Usage: node scripts/run-electron.js scripts/shot-card-life.js [outDir]

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));
const cardDraws = require(path.join(ROOT, 'main', 'card_draws.js'));

const OUT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'soulpet-card-life');

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-cardlife-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- seed ------------------------------------------------------------
  // One card the user added, so the shot exercises the "我的专属卡片"
  // block rather than showing it empty.
  db.createCustomCard({
    title: '给三个月后的自己写一封信',
    requirement: '写下现在的想法，留给未来的自己',
  });

  const winMain = new BrowserWindow({
    width: 1440,
    height: 980,
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

  // ---- the EMPTY state ------------------------------------------------
  // The deck, before anything has been drawn this week.
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life'; true`);
  await new Promise((r) => setTimeout(r, 1400));

  const emptyShot = await winMain.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'card-life-empty.png'), emptyShot.toPNG());
  console.log('wrote ' + path.join(OUT_DIR, 'card-life-empty.png'));

  // ---- the drawn-card state -------------------------------------------
  // A draw for THIS week, so the shot shows the big challenge card rather
  // than the empty deck.
  //
  // The draw happens AFTER the empty shot, because the two states live in
  // the same database and the page reads the week's draw from it — a draw
  // made first would make both shots show the same card. (The database
  // has no "undo the draw" call, and adding one to production code just
  // to take a screenshot is not worth it.)
  //
  // The card is seeded rather than drawn at random, so the shot shows the
  // same card every time it is taken — a random draw could land on the
  // user's own card, which reads 「我的专属卡片」 instead of a number.
  const deckCard = cardDraws.readDeck(null).cards[0];
  db.createCardDraw({
    week_key: cardDraws.weekKey(new Date()),
    card_no: deckCard.no,
    title: deckCard.title,
    requirement: deckCard.requirement,
    source: 'deck',
  });
  console.log(`drew: ${deckCard.title}`);

  // The page has to be re-rendered to pick the new card up: it asks the
  // main process for the state once, when it is routed to.
  await winMain.webContents.executeJavaScript(
    `location.hash = '#/events/memorial'; true`);
  await new Promise((r) => setTimeout(r, 300));
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life'; true`);
  await new Promise((r) => setTimeout(r, 1400));

  const shot = await winMain.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'card-life.png'), shot.toPNG());
  console.log('wrote ' + path.join(OUT_DIR, 'card-life.png'));

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
