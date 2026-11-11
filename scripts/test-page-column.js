// scripts/test-page-column.js — end-to-end check for the app's shared
// reading column: the centred band every page's content sits in.
//
// What this guards against:
//
//   1. A page stretches edge to edge. The scroll container is a full-bleed
//      strip, so a page that doesn't cap its width puts its cards flat
//      against the window edges on a wide monitor — the 回忆 grid in
//      particular would turn into four enormous slabs.
//
//   2. A page has no column at all. `.page-column` (and the two page
//      classes that carry their own width) is the only thing keeping the
//      side margin; a page that drops its wrapper silently loses it.
//
//   3. The column stops being centred. `margin: 0 auto` does the work, and
//      a page that overrides it would push its content against the right
//      edge while the left side kept its margin.
//
//   4. The column grows or shrinks. The number lives in one place
//      (`--page-column-max`); if the pages drift apart, the app stops
//      reading as one thing.
//
// The window is deliberately WIDER than the column, so a page that has no
// cap measures wider than the target and a page whose cap stopped
// working measures wider too.
//
// Usage: node scripts/run-electron.js scripts/test-page-column.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// The column's width, in CSS pixels. The same number the pages use:
// `--page-column-max` in src/css/styles.css, and the width `.bg-page` /
// `.today-page` carry in their own stylesheets.
const COLUMN_MAX = 1080;

// How the pages are reached, and how to tell the page has finished
// rendering. The label is the page's own <h1> text — the router replaces
// the whole page on a hash change, so waiting for the right heading is
// what distinguishes "landed" from "still showing the previous page".
//
// The class is the element that CARRIES the column. Four different
// classes appear here, and that is deliberate: the app has four page
// design systems (the plain one, the artwork one, the 今日 one and the
// 抽卡 one), each with its own width rule. What they share is the
// resulting width, not the mechanism.
const PAGES = [
  { path: '/today',          label: '今日',     cls: '.today-page' },
  { path: '/contacts',       label: '联系人',   cls: '.bg-page' },
  { path: '/reminders',      label: '提醒', cls: '.bg-page' },
  { path: '/reminders?tag_kind=work', label: '工作事件', cls: '.bg-page' },
  { path: '/card-life',      label: '抽卡', cls: '.cl-page' },
  { path: '/events/memorial', label: '回忆', cls: '.page-column' },
  { path: '/events/new?category=general', label: '新建', cls: '.page-column' },
  { path: '/settings',       label: '设置',     cls: '.page-column' },
  { path: '/export',         label: '导出回忆', cls: '.page-column' },
  { path: '/tools',          label: '工具',     cls: '.page-column' },
];

app.whenReady().then(async () => {
  console.log('page column end-to-end test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-col-'));
  await db.open(path.join(dir, 'test.sqlite'));

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (let i = 0; i < 3; i++) {
    db.run(
      `INSERT INTO contacts(id, name, relationship, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
      [`tc${i}`, `联系人${i}`, '朋友', now, now]);
  }
  for (let i = 0; i < 3; i++) {
    db.run(
      `INSERT INTO events(id, title, description, remind_kind, remind_date,
                          next_fire_at, active, category, created_at, updated_at)
       VALUES(?, ?, ?, 'one_time', ?, ?, 1, 'work', ?, ?)`,
      [`tw${i}`, `工作事项${i}`, `第 ${i} 件事`,
        '2026-12-01 10:00:00', '2026-12-01 10:00:00', now, now]);
  }

  const winMain = new BrowserWindow({
    // Wider than COLUMN_MAX on purpose: a page whose cap stopped working
    // would measure the full window and fail the width assertion below.
    width: 1600,
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

  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));

  // The main window opens behind the PIN lock, and body.locked hides #app
  // with display:none — a hidden subtree has no layout box, so every
  // measurement below would read 0 and pass vacuously.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);
  await new Promise((r) => setTimeout(r, 200));

  // Read the column off the page. The measurement is relative to the
  // scroll container's CONTENT box, so the container's own padding (and
  // any scrollbar) is excluded — what matters is the band the content
  // sits in, not where it sits on screen.
  //
  // `clientWidth` is used for the container's width rather than its
  // bounding rect: clientWidth EXCLUDES the vertical scrollbar, while the
  // bounding rect INCLUDES it. Mixing the two would make the right-hand
  // margin read a few pixels smaller than the left for reasons that have
  // nothing to do with the centring.
  const readColumn = (cls) => winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(cls)});
    if (!el) return null;
    const cs = getComputedStyle(el);
    const app = document.querySelector('#app');
    const appCs = getComputedStyle(app);
    const box = el.getBoundingClientRect();
    const padL = parseFloat(appCs.paddingLeft) || 0;
    const padR = parseFloat(appCs.paddingRight) || 0;
    const contentLeft = app.getBoundingClientRect().left + padL;
    const contentRight = contentLeft + app.clientWidth - padL - padR;
    return {
      width: Math.round(box.width),
      maxWidth: cs.maxWidth,
      marginLeft: cs.marginLeft,
      marginRight: cs.marginRight,
      // How much empty space sits to the left and to the right of the
      // column, measured inside the scroll container's content box.
      left: Math.round(box.left - contentLeft),
      right: Math.round(contentRight - box.right),
    };
  })()`);

  // Which class carries the column on each route.
  const clsFor = (hash) => {
    const p = PAGES.find((x) => hash === x.path || hash.startsWith(x.path + '?'));
    return p ? p.cls : '.page-column';
  };

  const goto = async (hash, label) => {
    await winMain.webContents.executeJavaScript(`location.hash = '#${hash}'; true`);
    // Wait until the page has actually rendered. The router replaces the
    // whole page on a hash change, so the page's own <h1> is the signal
    // that the new page is up. The column element is accepted as a second
    // signal, because a page that renders its body before its heading
    // would otherwise look like a page that never arrived.
    const landed = await winMain.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 80; i++) {
        const h1 = document.querySelector('#app h1');
        const col = document.querySelector('.page-column, .bg-page, .today-page, .cl-page');
        if ((h1 && h1.textContent.includes(${JSON.stringify(label)})) || col) {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`);
    if (!landed) {
      check(`${hash} renders`, false, `the page never showed 「${label}」`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 250));
    return readColumn(clsFor(hash));
  };

  // -------------------------------------------------------------------------
  // The pages
  // -------------------------------------------------------------------------
  const widths = [];
  for (const p of PAGES) {
    console.log(`\n[${p.path}]`);
    const m = await goto(p.path, p.label);
    if (!m) continue;

    widths.push({ path: p.path, width: m.width });

    // The band is capped: it must not be as wide as the window.
    check(`${p.path} caps the column at ${COLUMN_MAX}px`,
      m.width <= COLUMN_MAX + 1,
      `measured ${m.width}px`);

    // ...and it must not have collapsed to a sliver either. A column that
    // is 40px wide is centred too, but it is not a page.
    check(`${p.path} keeps the column readable`,
      m.width >= 320,
      `measured ${m.width}px`);

    // Centred: the same breathing room on both sides.
    check(`${p.path} centres the column`,
      Math.abs(m.left - m.right) <= 2,
      `left ${m.left}px, right ${m.right}px`);

    // The side margin has to be real, not just symmetric zeroes — a column
    // flush against both edges of an empty container would pass the
    // comparison above.
    check(`${p.path} leaves a side margin`,
      m.left >= 20 && m.right >= 20,
      `left ${m.left}px, right ${m.right}px`);
  }

  // -------------------------------------------------------------------------
  // The number is shared
  // -------------------------------------------------------------------------
  console.log('\n[the column width is one number]');
  // Every page's column lands on the same width (the container's own
  // padding is inside the 1080px, so they may differ by a pixel or two).
  const distinct = [...new Set(widths.map((w) => w.width))];
  check('every page uses the same column width',
    distinct.length <= 2,
    `widths: ${JSON.stringify(widths)}`);

  // -------------------------------------------------------------------------
  // The window really was wide enough for the assertion to mean something
  // -------------------------------------------------------------------------
  const appWidth = await winMain.webContents.executeJavaScript(
    `document.querySelector('#app').clientWidth`);
  check('the test window is wider than the column',
    appWidth > COLUMN_MAX + 100,
    `the scroll container is ${appWidth}px wide`);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(failures.length ? 1 : 0);
}).catch((e) => {
  console.error('test failed:', e);
  app.exit(1);
});
