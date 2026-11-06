// scripts/shot-today.js — render the 今日 page in the REAL main window and
// save a PNG, so the page's visual design can be checked without a human
// driving the app.
//
// It uses the real preload + the real IPC handlers, so what lands in the
// PNG is what the user sees (same background artwork, same pet status
// numbers, same reminder rows).
//
// Usage: node scripts/run-electron.js scripts/shot-today.js [outFile]

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));
const { PetRegistry } = require(path.join(ROOT, 'main', 'pet_registry.js'));

const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'today-shot.png');

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-shot-'));
  await db.open(path.join(dir, 'test.sqlite'));

  pageBackground.invalidate();

  // The REAL pet registry, so the 今日 page's mood portrait shows the
  // user's actual pet sprite instead of the mood-emoji fallback. A stub
  // registry would silently render the fallback and the shot would not
  // show what the app really looks like.
  const petRegistry = new PetRegistry();
  await petRegistry.init({ appPath: ROOT, userDataPath: path.join(dir, 'userdata') });

  const winMain = new BrowserWindow({
    width: 1280,
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
    petRegistry,
  });

  // Seed a few reminder rows so the shot exercises the LIST styling, not
  // just the empty state. The rows go straight into the events table with
  // today's date — that is what `reminders:list_today_view` filters on.
  // This has to happen BEFORE the window loads, because the 今日 page reads
  // the list during its first render.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = `${todayDate} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  const rows = [
    { id: 'shot-1', title: '给妈妈打个电话', desc: '问问她最近身体怎么样', kind: 'one_time', cat: 'general', tag: null },
    { id: 'shot-2', title: '爸爸的生日', desc: '提前订好蛋糕', kind: 'yearly', cat: 'general', tag: 'birthday' },
    { id: 'shot-3', title: '季度汇报材料', desc: '整理这一季度的项目进展', kind: 'one_time', cat: 'work', tag: null },
    { id: 'shot-4', title: '结婚纪念日', desc: '准备一份小惊喜', kind: 'yearly', cat: 'general', tag: 'anniversary' },
  ];
  for (const r of rows) {
    db.run(
      `INSERT INTO events (id, title, description, remind, remind_kind, remind_date,
                           next_fire_at, last_fired_at, active, category, tag_kind,
                           created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [r.id, r.title, r.desc, r.kind, todayDate, now, now, r.cat, r.tag, now, now]
    );
  }

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // The main window is PIN-locked on open (src/js/auth.js). The lock is a
  // renderer-side `body.locked` class, so dropping it reveals the app —
  // the screenshot is about the 今日 page's design, not about the gate.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  // The router lands on 今日 by default, but be explicit so the shot is
  // never of a stale page.
  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 1200));

  const shot = await winMain.webContents.capturePage();
  fs.writeFileSync(OUT, shot.toPNG());
  console.log('wrote ' + OUT);

  // The same page in a wide window. The 今日 page caps its reading column,
  // so a wide shot is where that cap has to be visible — a shot at the
  // default width can't tell a capped column from a full-bleed one.
  const WIDE = path.join(path.dirname(OUT), 'today-wide.png');
  winMain.setSize(2000, 900);
  await new Promise((r) => setTimeout(r, 900));
  const wideShot = await winMain.webContents.capturePage();
  fs.writeFileSync(WIDE, wideShot.toPNG());
  console.log('wrote ' + WIDE);

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
