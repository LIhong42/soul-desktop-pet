// scripts/shot-card-stats.js — render the 打卡墙 (check-in wall) page in
// the REAL main window and save a PNG, so the page's visual design can be
// checked without a human driving the app.
//
// It uses the real preload + the real IPC handlers, so what lands in the
// PNG is what the user sees (the shared background artwork, the real
// drawn cards, the real completion verdicts).
//
// Usage: node scripts/run-electron.js scripts/shot-card-stats.js [outDir]

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
  : path.join(os.tmpdir(), 'soulpet-card-stats');

// The Monday of a week, as the app writes it.
function mondayOf(y, m, d) {
  const dt = new Date(y, m - 1, d);
  const day = (dt.getDay() + 6) % 7;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - day);
}
function weekKey(y, m, d) {
  const dt = mondayOf(y, m, d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-cardstats-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- seed ------------------------------------------------------------
  // Seven weeks of draws, so the grid has something to show, with a mix
  // of finished and unfinished weeks — a grid of all-filled squares
  // would not show what the page is for.
  //
  //   W1 — a photo, no text        → finished
  //   W2 — 40 characters, no photo → finished
  //   W3 — nothing                 → not finished
  //   W4 — 12 characters           → not finished
  //   W5 — a photo and text        → finished
  //   W6 — nothing                 → not finished
  //   W7 — 45 characters           → finished
  const now = db.nowStr();
  const weeks = [];
  for (let i = 0; i < 7; i++) weeks.push(weekKey(2026, 1, 5 + i * 7));

  const draws = weeks.map((wk, i) => db.createCardDraw({
    week_key: wk,
    card_no: i + 1,
    title: `第 ${i + 1} 周的卡：给自己做一顿饭`,
    requirement: '认真做一顿饭，摆盘，拍下来，写下今天想对自己说的话。',
    source: 'deck',
  }));

  const addEvent = (title, notes, content) => {
    const id = db.newId();
    db.run(
      `INSERT INTO memorial_events(id, kind, title, notes, content, occurred_at, created_at, updated_at)
       VALUES (?, 'card_draw', ?, ?, ?, ?, ?, ?)`,
      [id, title, notes || null, content || null, now, now, now]);
    return id;
  };
  const addPhoto = (eventId) => {
    db.run(
      `INSERT INTO memorial_event_photos(id, memorial_event_id, relative_path, created_at)
       VALUES (?, ?, ?, ?)`,
      [db.newId(), eventId, 'photos/x.jpg', now]);
  };

  // W1 — a photo, no text.
  const ev1 = addEvent('第一周：给自己做一顿饭', null, null);
  addPhoto(ev1);
  db.linkCardDraw(draws[0].id, ev1);

  // W2 — 40 characters of body.
  const ev2 = addEvent('第二周：给自己做一顿饭', null,
    JSON.stringify([{ type: 'text', text: '今天给自己做了一顿番茄炒蛋，配了米饭。一个人吃饭也认真摆盘，拍了照片。' }]));
  db.linkCardDraw(draws[1].id, ev2);

  // W4 — 12 characters: too thin to count.
  const ev4 = addEvent('第四周：给自己做一顿饭', '做了点吃的', null);
  db.linkCardDraw(draws[3].id, ev4);

  // W5 — a photo and text.
  const ev5 = addEvent('第五周：给自己做一顿饭', '做了一顿很认真的晚饭', null);
  addPhoto(ev5);
  db.linkCardDraw(draws[4].id, ev5);

  // W7 — 45 characters of body.
  const ev7 = addEvent('第七周：给自己做一顿饭', null,
    JSON.stringify([{ type: 'text', text: '这周做了面，擀面的时候特别用力，揉得手腕都酸了，但是成品很好吃。' }]));
  db.linkCardDraw(draws[6].id, ev7);

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

  // ---- the wall --------------------------------------------------------
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life/stats'; true`);
  await new Promise((r) => setTimeout(r, 1400));

  const shot = await winMain.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'card-stats.png'), shot.toPNG());
  console.log('wrote ' + path.join(OUT_DIR, 'card-stats.png'));

  // ---- the wall with a week's card on the table -------------------------
  // The card is what a click on the grid produces, so it is worth a shot
  // of its own.
  await winMain.webContents.executeJavaScript(`(() => {
    const cell = document.querySelector('.cl-stats-cell');
    if (cell) cell.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  const openShot = await winMain.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'card-stats-open.png'), openShot.toPNG());
  console.log('wrote ' + path.join(OUT_DIR, 'card-stats-open.png'));

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
