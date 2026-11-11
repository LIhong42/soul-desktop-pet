// scripts/test-card-stats-design.js — guards the 打卡墙 (check-in wall)
// page's design system.
//
// What this protects:
//
//   1. The page renders at all, and renders the three things it is for:
//      the summary tiles, the grid of weeks, and the detail list.
//
//   2. The GRID marks the finished weeks. This is the whole point of the
//      page — a run of filled squares IS the streak — so a grid that
//      renders every square the same way would look right and say
//      nothing. The test checks that a finished week and an unfinished
//      week are told apart by a real, measurable difference.
//
//   3. The numbers on the page agree with the data. The tiles are drawn
//      from the same summary the grid is drawn from, but a page that
//      shows 「已完成 3」 while the grid shows two filled squares would be
//      worse than no page at all.
//
//   4. The page wears the shared background artwork, like the 抽卡
//      page it belongs to.
//
//   5. The 抽卡 page links to it, and the link goes to a real route.
//
// It drives the REAL main window with the REAL preload and IPC handlers,
// because the failure would be in the seam between the renderer markup
// and the data behind it.
//
// Usage: node scripts/run-electron.js scripts/test-card-stats-design.js

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

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

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
  console.log('打卡墙 page design system test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-clstats-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();

  // -------------------------------------------------------------------------
  // Seed the database with five weeks of draws.
  //
  //   W1 — a photo, no text        → finished
  //   W2 — 40 characters, no photo → finished
  //   W3 — nothing                 → not finished
  //   W4 — 12 characters           → not finished
  //   W5 — a photo and text        → finished
  //
  // So three of the five are finished, and the streak at the newest end
  // is one (W5 is finished, W4 is not).
  //
  // The weeks are dated in the past so they cannot collide with the
  // current week — the test asserts on the CURRENT week's card elsewhere
  // and the two would fight over the same slot.
  // -------------------------------------------------------------------------
  const now = db.nowStr();
  const weeks = [];
  for (let i = 0; i < 5; i++) {
    weeks.push(weekKey(2026, 1, 5 + i * 7));
  }
  const draws = weeks.map((wk, i) => db.createCardDraw({
    week_key: wk,
    card_no: i + 1,
    title: `第 ${i + 1} 周的卡`,
    requirement: `第 ${i + 1} 周要做的事`,
    source: 'deck',
  }));

  const addEvent = (id, title, notes, content) => {
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

  const ev1 = addEvent(db.newId(), '第一周的回忆', null, null);
  addPhoto(ev1);
  db.linkCardDraw(draws[0].id, ev1);

  const ev2 = addEvent(db.newId(), '第二周的回忆', null,
    JSON.stringify([{ type: 'text', text: '字'.repeat(40) }]));
  db.linkCardDraw(draws[1].id, ev2);

  const ev4 = addEvent(db.newId(), '第四周的回忆', '字'.repeat(12), null);
  db.linkCardDraw(draws[3].id, ev4);

  const ev5 = addEvent(db.newId(), '第五周的回忆', '字'.repeat(50), null);
  addPhoto(ev5);
  db.linkCardDraw(draws[4].id, ev5);

  // -------------------------------------------------------------------------
  // The window
  // -------------------------------------------------------------------------
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

  // The PIN gate sets `display: none` on #app — the router mounts the page
  // underneath it, but a hidden element has NO LAYOUT, so every
  // getBoundingClientRect() would read 0×0. The gate is a renderer-side
  // `body.locked` class, so dropping it reveals the app.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  // -------------------------------------------------------------------------
  // Test 1 — the 抽卡 page links to the wall
  // -------------------------------------------------------------------------
  console.log('\n[1] the 抽卡 page links to the wall');
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life'; true`);
  await new Promise((r) => setTimeout(r, 1200));

  const link = await winMain.webContents.executeJavaScript(`(() => ({
    door: !!document.querySelector('.cl-checkin'),
    href: (document.querySelector('.cl-checkin') || {}).getAttribute
      ? (document.querySelector('.cl-checkin').getAttribute('href') || '') : '',
    title: (document.querySelector('.cl-checkin-title') || {}).textContent || '',
    sub: (document.querySelector('.cl-checkin-sub') || {}).textContent || '',
    // The door has to be laid out, not just present.
    width: document.querySelector('.cl-checkin')
      ? document.querySelector('.cl-checkin').getBoundingClientRect().width : 0,
  }))()`);
  check('the wall has a door on the 抽卡 page', link.door);
  check('the door links to the wall route', link.href === '#/card-life/stats', link.href);
  check('the door is named', link.title.trim() === '打卡墙', link.title);
  check('the door says how many weeks are on the wall',
    link.sub.includes('5'), link.sub);
  check('the door is laid out', link.width > 100, `width=${link.width}`);

  // -------------------------------------------------------------------------
  // Test 2 — the wall itself
  // -------------------------------------------------------------------------
  console.log('\n[2] the wall renders');
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life/stats'; true`);
  await new Promise((r) => setTimeout(r, 1400));

  const page = await winMain.webContents.executeJavaScript(`(() => ({
    page: !!document.querySelector('.cl-stats-page'),
    // The page wears the SAME paper stylesheet as the 抽卡 page.
    clPage: !!document.querySelector('.cl-page'),
    title: (document.querySelector('.cl-head h1') || {}).textContent || '',
    back: !!document.querySelector('.cl-stats-back'),
    backHref: (document.querySelector('.cl-stats-back') || {}).getAttribute
      ? (document.querySelector('.cl-stats-back').getAttribute('href') || '') : '',
    // The blocks.
    tiles: document.querySelectorAll('.cl-stats-tile').length,
    grid: !!document.querySelector('.cl-stats-grid'),
    cells: document.querySelectorAll('.cl-stats-cell').length,
    // The list of weeks is GONE — the grid is the index and the card is
    // the detail. Nothing may bring it back.
    list: !!document.querySelector('.cl-stats-list'),
    rows: document.querySelectorAll('.cl-stats-row').length,
    // The wall opens on the grid alone: no card on the table yet.
    card: !!document.querySelector('.cl-stats-card'),
    // The empty state must NOT be here — there are five weeks.
    empty: !!document.querySelector('.cl-stats-empty'),
    // The layout has to be real.
    appWidth: (document.getElementById('app') || {clientWidth: 0}).clientWidth,
    appHeight: (document.getElementById('app') || {clientHeight: 0}).clientHeight,
  }))()`);
  check('the wall page is rendered', page.page);
  check('the wall wears the 抽卡 page stylesheet', page.clPage);
  check('the title is 打卡墙', page.title.trim() === '打卡墙', page.title);
  check('the wall has a back link', page.back);
  check('the back link goes to the 抽卡 page', page.backHref === '#/card-life',
    page.backHref);
  check('the summary has four tiles', page.tiles === 4, `got ${page.tiles}`);
  check('the grid is rendered', page.grid);
  check('the grid has one square per week', page.cells === 5, `got ${page.cells}`);
  check('the week list is gone', !page.list && page.rows === 0,
    `list=${page.list} rows=${page.rows}`);
  check('the wall opens with no card on the table', !page.card);
  check('the empty state is not shown', !page.empty);
  check('the page is laid out, not hidden',
    page.appWidth > 0 && page.appHeight > 0,
    `#app is ${page.appWidth}x${page.appHeight}`);

  // -------------------------------------------------------------------------
  // Test 3 — the numbers agree with the data
  // -------------------------------------------------------------------------
  console.log('\n[3] the numbers agree with the data');
  const numbers = await winMain.webContents.executeJavaScript(`(() => {
    const tiles = Array.from(document.querySelectorAll('.cl-stats-tile')).map((t) => ({
      label: (t.querySelector('.cl-stats-tile-label') || {}).textContent || '',
      value: (t.querySelector('.cl-stats-tile-value b') || {}).textContent || '',
    }));
    return {
      tiles,
      done: document.querySelectorAll('.cl-stats-cell.done').length,
      notDone: document.querySelectorAll('.cl-stats-cell:not(.done)').length,
      // The newest week is the last one seeded (W5).
      firstCellDone: !!document.querySelector('.cl-stats-cell.done'),
      current: document.querySelectorAll('.cl-stats-cell.current').length,
    };
  })()`);

  const tileOf = (label) => {
    const t = numbers.tiles.find((x) => x.label.trim() === label);
    return t ? t.value : null;
  };
  check('the 已抽周数 tile says five', tileOf('已抽周数') === '5', String(tileOf('已抽周数')));
  check('the 完成 tile says three', tileOf('完成') === '3', String(tileOf('完成')));
  check('the 完成率 tile says 60', tileOf('完成率') === '60', String(tileOf('完成率')));
  check('the 连续完成 tile says one', tileOf('连续完成') === '1', String(tileOf('连续完成')));
  check('the grid fills three squares', numbers.done === 3, `got ${numbers.done}`);
  check('the grid leaves two empty', numbers.notDone === 2, `got ${numbers.notDone}`);
  check('exactly one square is marked as the current week', numbers.current === 1,
    `got ${numbers.current}`);

  // -------------------------------------------------------------------------
  // Test 4 — the grid REALLY tells the weeks apart
  // -------------------------------------------------------------------------
  //
  // This is the point of the page. A grid where every square looks the
  // same would pass every check above and be useless, so the finished
  // and the unfinished square are compared on their real computed style.
  console.log('\n[4] the grid tells finished weeks from unfinished ones');
  const grid = await winMain.webContents.executeJavaScript(`(() => {
    const done = document.querySelector('.cl-stats-cell.done');
    const notDone = document.querySelector('.cl-stats-cell:not(.done)');
    if (!done || !notDone) return null;
    const dcs = getComputedStyle(done);
    const ncs = getComputedStyle(notDone);
    const dBox = done.getBoundingClientRect();
    const nBox = notDone.getBoundingClientRect();
    return {
      // The finished square is filled with a GRADIENT, so the fill lives
      // in background-image — background-color would read as transparent
      // for both and the comparison would prove nothing.
      doneFill: dcs.backgroundImage,
      notFill: ncs.backgroundImage,
      doneBg: dcs.backgroundColor,
      notBg: ncs.backgroundColor,
      doneBorder: dcs.borderColor,
      notBorder: ncs.borderColor,
      doneW: dBox.width,
      doneH: dBox.height,
      notW: nBox.width,
      notH: nBox.height,
      // The check mark is only visible on a finished week.
      doneMark: getComputedStyle(done.querySelector('.cl-stats-cell-mark')).opacity,
      notMark: getComputedStyle(notDone.querySelector('.cl-stats-cell-mark')).opacity,
      // The grid is a grid: the squares are in rows, not one long line.
      columns: getComputedStyle(document.querySelector('.cl-stats-grid')).gridTemplateColumns,
      // The squares are squares.
      ratio: dBox.width / dBox.height,
      // Every square is the same size.
      sizes: Array.from(document.querySelectorAll('.cl-stats-cell'))
        .map((c) => Math.round(c.getBoundingClientRect().width)),
    };
  })()`);
  check('the grid has both kinds of square', !!grid);
  check('a finished square is painted and an unfinished one is not',
    /gradient/.test(grid.doneFill) && !/gradient/.test(grid.notFill),
    `${grid.doneFill} vs ${grid.notFill}`);
  check('the two squares have different edges',
    grid.doneBorder !== grid.notBorder, `${grid.doneBorder} vs ${grid.notBorder}`);
  check('the check mark shows on a finished week', Number(grid.doneMark) > 0.9,
    grid.doneMark);
  check('the check mark is hidden on an unfinished week', Number(grid.notMark) < 0.1,
    grid.notMark);
  check('the squares are square', Math.abs(grid.ratio - 1) < 0.1,
    `ratio=${grid.ratio}`);
  check('every square is the same width',
    new Set(grid.sizes).size === 1, JSON.stringify(grid.sizes));

  // The current week's square has to be marked as such — otherwise an
  // unfinished user cannot tell 「抽了还没写」 from 「压根没抽」.
  const current = await winMain.webContents.executeJavaScript(`(() => {
    const cur = document.querySelector('.cl-stats-cell.current');
    const other = document.querySelector('.cl-stats-cell:not(.current)');
    if (!cur || !other) return null;
    const ccs = getComputedStyle(cur);
    const ocs = getComputedStyle(other);
    return {
      outlineWidth: ccs.outlineWidth,
      outlineStyle: ccs.outlineStyle,
      otherOutline: ocs.outlineWidth,
    };
  })()`);
  check('the current week\'s square is marked',
    !!current && parseFloat(current.outlineWidth) >= 1 &&
    current.outlineStyle !== 'none',
    JSON.stringify(current));
  check('the other squares are not marked',
    !!current && parseFloat(current.otherOutline) === 0,
    JSON.stringify(current));

  // -------------------------------------------------------------------------
  // Test 5 — clicking a square puts that week's card on the table
  // -------------------------------------------------------------------------
  //
  // This is the page's whole interaction now. The grid is the index and
  // the card is the detail: click a square, and the card that was drawn
  // that week comes back, in the 抽卡 page's own style.
  console.log('\n[5] clicking a square puts the card on the table');
  await winMain.webContents.executeJavaScript(`(() => {
    // The newest week — W5, which has a photo AND text.
    const cell = document.querySelector('.cl-stats-cell');
    if (cell) cell.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const card = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.cl-stats-card');
    const note = el ? el.querySelector('.cl-card-note') : null;
    const btn = el ? el.querySelector('#cl-stats-record') : null;
    const cs = el ? getComputedStyle(el) : null;
    return {
      present: !!el,
      // The card must be the SAME card component as the 抽卡 page's.
      isClCard: !!(el && el.classList.contains('cl-card')),
      hasClip: !!(el && el.querySelector('.cl-card-clip')),
      hasBadge: !!(el && el.querySelector('.cl-card-badge')),
      hasTitle: !!(el && el.querySelector('.cl-card-title')),
      hasReq: !!(el && el.querySelector('.cl-card-req')),
      title: (el && el.querySelector('.cl-card-title') || {}).textContent || '',
      note: note ? note.textContent : '',
      btn: !!btn,
      btnText: btn ? btn.textContent.trim() : '',
      // The card has to be laid out, not collapsed.
      width: el ? el.getBoundingClientRect().width : 0,
      bg: cs ? cs.backgroundColor : '',
      border: cs ? cs.borderTopWidth : '',
      // The picked square is marked.
      openSquares: document.querySelectorAll('.cl-stats-cell.open').length,
    };
  })()`);
  check('clicking a square puts a card on the table', card.present);
  check('the card IS the 抽卡 page\'s card component', card.isClCard);
  check('the card has the paperclip', card.hasClip);
  check('the card has the badge', card.hasBadge);
  check('the card has a title', card.hasTitle);
  check('the card has the requirement', card.hasReq);
  check('the card shows the card that was drawn', card.title.includes('第 5 周的卡'),
    card.title);
  check('the card is laid out', card.width > 200, `width=${card.width}`);
  check('the card is a paper surface', card.bg !== 'rgba(0, 0, 0, 0)', card.bg);
  check('the card has a border', parseFloat(card.border) > 0, card.border);
  // The note says why the week counts, in the same vocabulary as the
  // 抽卡 page's own note.
  check('the card says how many characters there are', /字/.test(card.note), card.note);
  check('the card says how many photos there are', /照片/.test(card.note), card.note);
  check('the card offers the entry', card.btn);
  check('the button says it opens the entry', card.btnText.includes('查看这篇回忆'),
    card.btnText);
  check('the picked square is marked', card.openSquares === 1,
    `got ${card.openSquares}`);

  // Clicking a square with no entry shows the card and offers to write
  // it up — the card is not a museum piece.
  await winMain.webContents.executeJavaScript(`(() => {
    // W3 has no entry at all: it is the third square from the top.
    const cells = document.querySelectorAll('.cl-stats-cell');
    const empty = cells[2];
    if (empty) empty.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const emptyCard = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.cl-stats-card');
    const btn = el ? el.querySelector('#cl-stats-record') : null;
    return {
      title: (el && el.querySelector('.cl-card-title') || {}).textContent || '',
      btnText: btn ? btn.textContent.trim() : '',
      note: el && el.querySelector('.cl-card-note')
        ? el.querySelector('.cl-card-note').textContent : '',
    };
  })()`);
  check('a week with no entry shows its card too',
    emptyCard.title.includes('第 3 周的卡'), emptyCard.title);
  check('an unwritten week offers to be written',
    emptyCard.btnText.includes('记录这一张'), emptyCard.btnText);
  check('an unwritten week says it has no entry',
    /还没有写回忆记录/.test(emptyCard.note), emptyCard.note);

  // Clicking the same square again closes the card.
  await winMain.webContents.executeJavaScript(`(() => {
    const cells = document.querySelectorAll('.cl-stats-cell');
    if (cells[2]) cells[2].click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const closed = await winMain.webContents.executeJavaScript(`(() => ({
    card: !!document.querySelector('.cl-stats-card'),
    open: document.querySelectorAll('.cl-stats-cell.open').length,
  }))()`);
  check('clicking the same square closes the card', !closed.card);
  check('no square is marked any more', closed.open === 0, `got ${closed.open}`);

  // -------------------------------------------------------------------------
  // Test 6 — the wall wears the artwork
  // -------------------------------------------------------------------------
  console.log('\n[6] the wall wears the background artwork');
  const bg = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.content');
    return {
      hasClass: el.classList.contains('page-bg'),
      noArt: el.classList.contains('no-art'),
      image: el.style.getPropertyValue('--page-bg-image'),
      computed: getComputedStyle(el).backgroundImage,
    };
  })()`);
  check('the content container has the page-bg class', bg.hasClass);
  check('the wall is not in the no-art state', !bg.noArt);
  check('the background image is set', !!bg.image, bg.image);
  check('the computed background carries the image',
    bg.computed.includes('file://'), bg.computed);

  // -------------------------------------------------------------------------
  // Test 7 — the 抽卡 page still works
  // -------------------------------------------------------------------------
  //
  // The wall was added to a page that already had a design test. This
  // checks that adding the door did not disturb the page.
  console.log('\n[7] the 抽卡 page still works');
  await winMain.webContents.executeJavaScript(`location.hash = '#/events/memorial'; true`);
  await new Promise((r) => setTimeout(r, 300));
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life'; true`);
  await new Promise((r) => setTimeout(r, 1000));

  const back = await winMain.webContents.executeJavaScript(`(() => ({
    page: !!document.querySelector('.cl-page'),
    rules: !!document.querySelector('.cl-rules-card'),
    custom: !!document.querySelector('.cl-custom'),
    door: !!document.querySelector('.cl-checkin'),
    // The design stylesheet is still loaded.
    sheet: (() => {
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      const cl = links.find((l) => (l.getAttribute('href') || '').includes('card_life.css'));
      return cl && cl.sheet ? cl.sheet.cssRules.length : 0;
    })(),
  }))()`);
  check('the 抽卡 page still renders', back.page);
  check('the rules card is still there', back.rules);
  check('the own-cards block is still there', back.custom);
  check('the door is still there', back.door);
  check('card_life.css still parsed', back.sheet > 100, `rules=${back.sheet}`);

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  }

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(failures.length ? 1 : 0);
}).catch((e) => {
  console.error('test crashed:', e);
  app.exit(1);
});
