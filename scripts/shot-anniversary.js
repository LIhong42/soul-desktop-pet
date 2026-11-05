// scripts/shot-anniversary.js — renders the 今日 page's 纪念日 carousel
// with seeded data and captures a PNG, so the carousel's layout can be
// checked without opening the app by hand.
//
// It also asserts the things a screenshot can't show: that the carousel
// really rotates, that the cards carry the right facts, and that the
// empty state renders when there are no dates.
//
// Usage: node scripts/run-electron.js scripts/shot-anniversary.js [outDir]

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const todayBackground = require(path.join(ROOT, 'main', 'today_background.js'));

const OUT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'soulpet-anniversary');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push({ name, detail }); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-anniv-shot-'));
  await db.open(path.join(dir, 'test.sqlite'));
  todayBackground.invalidate();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- Seed a contact with several important dates ----------------------
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ts = db.nowStr();

  const mkContact = (name) => {
    const id = db.newId();
    db.run('INSERT INTO contacts(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [id, name, ts, ts]);
    return id;
  };
  const mkDate = (cid, label, month, day, year, kind) => {
    db.run(
      `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                   remind_time, advance_days, remind_enabled,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [db.newId(), cid, label, day, month, year, kind, '09:00', 7, 1, ts, ts]
    );
  };

  const c1 = mkContact('妈妈');
  const c2 = mkContact('爸爸');
  const c3 = mkContact('小雨');
  const inDays = (n) => {
    const d = new Date(today.getTime() + n * 86400000);
    return [d.getMonth() + 1, d.getDate()];
  };
  const [m1, d1] = inDays(0);
  const [m2, d2] = inDays(12);
  const [m3, d3] = inDays(40);
  const [m4, d4] = inDays(75);
  const [m5, d5] = inDays(120);

  mkDate(c1, '生日', m1, d1, 1990, 'birthday');
  mkDate(c2, '忌日', m2, d2, 2015, 'deceased_date');
  mkDate(c3, '结婚纪念日', m3, d3, 2018, 'anniversary');
  mkDate(c1, '认识纪念日', m4, d4, 2012, 'anniversary');
  mkDate(c2, '入职', m5, d5, null, 'custom');

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

  const rendererErrors = [];
  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) rendererErrors.push(message);
  });

  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 1600));

  // ---- Assertions on the rendered carousel -------------------------------
  console.log('\n[1] the carousel renders');

  const shot1 = await winMain.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#today-anniv');
    const cards = Array.from(document.querySelectorAll('.today-anniv-card'));
    return {
      hasRoot: !!root,
      cardCount: cards.length,
      texts: cards.map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
      dotCount: document.querySelectorAll('.today-anniv-dot').length,
      // Every card must be a single line — the strip is built around one
      // line per card, so a wrapped card is a layout bug.
      allSingleLine: cards.every((c) => c.getBoundingClientRect().height < 70),
    };
  })()`);

  check('the carousel is rendered', shot1.hasRoot === true);
  check('every important date got a card', shot1.cardCount === 5, String(shot1.cardCount));
  check('there is a dot per card', shot1.dotCount === 5, String(shot1.dotCount));
  check('every card is a single line', shot1.allSingleLine === true);

  // The first card's text must carry the contact, the type, the age and
  // the countdown — the four facts the card exists to show.
  const first = shot1.texts[0] || '';
  console.log('       first card reads: ' + first);
  check('a card names the contact', /的|妈妈|爸爸|小雨/.test(first), first);
  check('a card carries a countdown', /今天|明天|还有 \d+ 天/.test(first), first);

  // At least one card must show the age. The date that is today has an
  // origin year, so its card carries "至今 N 年".
  const withAge = shot1.texts.filter((t) => /至今 \d+ 年/.test(t));
  check('a card shows the years since', withAge.length >= 1, JSON.stringify(shot1.texts));

  // The card with no origin year must NOT claim an age.
  const noYearCard = shot1.texts.find((t) => t.includes('入职'));
  check('a date without an origin year shows no age',
    noYearCard && !/至今/.test(noYearCard), noYearCard);

  // "至今 0 年" is technically true and completely useless, so a date
  // whose origin year IS this year gets no age clause either.
  const zeroAge = shot1.texts.filter((t) => /至今 0 年/.test(t));
  check('no card claims "至今 0 年"', zeroAge.length === 0, JSON.stringify(zeroAge));

  // The clauses are joined by a single middot with one space on each
  // side. The card's markup is a flex row, so stray whitespace between
  // the elements would show up as a double gap.
  const gaps = shot1.texts.filter((t) => /\s{2,}/.test(t));
  check('no card has a double space in its line', gaps.length === 0, JSON.stringify(gaps));

  // ---- The rotation ------------------------------------------------------
  console.log('\n[2] the carousel rotates');

  const startLeft = await winMain.webContents.executeJavaScript(
    `document.querySelector('#today-anniv-track').scrollLeft`);
  // The rotation interval is 5 s; wait past one tick.
  await new Promise((r) => setTimeout(r, 6200));
  const afterLeft = await winMain.webContents.executeJavaScript(
    `document.querySelector('#today-anniv-track').scrollLeft`);

  check('the strip advanced on its own', afterLeft > startLeft,
    `${startLeft} → ${afterLeft}`);

  const activeDot = await winMain.webContents.executeJavaScript(`(() => {
    const dots = Array.from(document.querySelectorAll('.today-anniv-dot'));
    return dots.findIndex((d) => d.classList.contains('active'));
  })()`);
  check('a dot marks the current card', activeDot >= 0, String(activeDot));

  // ---- A manual scroll re-syncs the rotation -----------------------------
  // If the user drags the strip by hand, the rotation has to continue
  // from where they left it. Without a re-sync the next tick would jump
  // back to a stale card, undoing the user's scroll.
  console.log('\n[2b] a manual scroll re-syncs the rotation');

  // Scroll to the LAST card by hand (not through the app's own goTo).
  // The last card is the hard case: its snap position used to sit past
  // the end of the scroll range, so it could never reach the left edge.
  //
  // A wheel event is dispatched first, because that is what tells the
  // carousel the strip is being driven by hand. The rotation's own
  // scrolling never produces one.
  //
  // The pointer is put over the strip as well, which pauses the
  // rotation. Without that the carousel can tick over to the next card
  // between the scroll and the read-back, and the check would be a
  // race rather than an assertion.
  const manual = await winMain.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#today-anniv');
    const track = document.querySelector('#today-anniv-track');
    const cards = Array.from(document.querySelectorAll('.today-anniv-card'));
    const target = cards[cards.length - 1];
    const want = target.offsetLeft - track.offsetLeft;
    root.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    track.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 120, deltaX: 0, bubbles: true, cancelable: true,
    }));
    // behavior 'instant' — 'auto' resolves to the CSS scroll-behavior,
    // which is 'smooth', so the scroll would animate and the position
    // would not have settled by the time it is read back.
    track.scrollTo({ left: want, behavior: 'instant' });
    return { left: track.scrollLeft, want, cardCount: cards.length };
  })()`);
  await new Promise((r) => setTimeout(r, 250));

  // The rotation resumes on its own a moment after the user lets go, so
  // it can tick over to the next card at any time. The dot is therefore
  // polled for the value the scroll put there, rather than read once at
  // a fixed moment — a single read would be a race with the 5 s tick.
  let afterManual = null;
  for (let i = 0; i < 20; i++) {
    afterManual = await winMain.webContents.executeJavaScript(`(() => {
      const dots = Array.from(document.querySelectorAll('.today-anniv-dot'));
      const track = document.querySelector('#today-anniv-track');
      const cards = Array.from(document.querySelectorAll('.today-anniv-card'));
      const last = cards[cards.length - 1];
      const lastLeft = last.getBoundingClientRect().left
                      - track.getBoundingClientRect().left;
      return {
        activeIndex: dots.findIndex((d) => d.classList.contains('active')),
        left: track.scrollLeft,
        maxScroll: track.scrollWidth - track.clientWidth,
        lastOffset: last.offsetLeft - track.offsetLeft,
        // How far the last card is from the strip's left edge. It should
        // be flush (within the strip's scroll padding) once it has been
        // scrolled to.
        lastLeft,
      };
    })()`);
    if (afterManual.activeIndex === 4) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('       wanted scrollLeft=' + manual.want + ' got=' + manual.left +
    ' lastLeft=' + afterManual.lastLeft + ' activeDot=' + afterManual.activeIndex);

  check('the manual scroll moved the strip', manual.left > 0, String(manual.left));
  // The last card has to be able to reach the left edge, or it can never
  // be read in full. The strip's own `scroll-padding-left` keeps the
  // card a few pixels off the edge, so "flush" means within that padding.
  check('the last card can reach the left edge',
    afterManual.lastLeft >= 0 && afterManual.lastLeft < 8, String(afterManual.lastLeft));
  check('the dot follows the manual scroll',
    afterManual.activeIndex === 4, String(afterManual.activeIndex));

  // The rotation must not treat the user's scroll as a reason to stop.
  // The strip has to keep advancing past the card the user dragged to.
  // The pointer is taken off the strip first, which lets the rotation
  // run again, and the wait polls rather than sleeping a fixed time so
  // the check does not depend on where the 5 s tick happens to fall.
  await winMain.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#today-anniv');
    root.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    return true;
  })()`);
  const beforeTick = afterManual.left;
  let afterTick = beforeTick;
  for (let i = 0; i < 14 && afterTick === beforeTick; i++) {
    await new Promise((r) => setTimeout(r, 600));
    afterTick = await winMain.webContents.executeJavaScript(
      `document.querySelector('#today-anniv-track').scrollLeft`);
  }
  check('the rotation continues after a manual scroll',
    afterTick !== beforeTick, `${beforeTick} → ${afterTick}`);

  // ---- The empty state ---------------------------------------------------
  console.log('\n[3] the empty state');

  db.run('DELETE FROM contacts');
  // Re-render the page. Assigning the SAME hash does not fire a
  // `hashchange`, so the router would never re-run the page's render and
  // the old cards would still be on screen — the page has to be left and
  // re-entered for the fetch to happen again.
  await winMain.webContents.executeJavaScript(`location.hash = '#/contacts'; true`);
  await new Promise((r) => setTimeout(r, 700));
  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 1400));

  const empty = await winMain.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#today-anniv');
    const emptyBox = document.querySelector('.today-empty');
    return {
      hasRoot: !!root,
      cardCount: document.querySelectorAll('.today-anniv-card').length,
      emptyText: emptyBox ? emptyBox.textContent.replace(/\\s+/g, ' ').trim() : '',
      // The page must still render its other sections.
      hasReminderSection: !!document.querySelector('.today-section'),
    };
  })()`);

  check('no carousel is rendered when there are no dates', empty.hasRoot === false);
  check('no cards are rendered', empty.cardCount === 0, String(empty.cardCount));
  check('an empty-state message is shown', empty.emptyText.includes('纪念日'), empty.emptyText);
  check('the rest of the page still renders', empty.hasReminderSection === true);

  // ---- Screenshots -------------------------------------------------------
  // Re-seed and capture, so the PNG shows the populated carousel. The
  // `DELETE FROM contacts` above removed every contact, so all three
  // have to be recreated before their dates can be inserted again.
  for (const [cid, name] of [[c1, '妈妈'], [c2, '爸爸'], [c3, '小雨']]) {
    db.run('INSERT INTO contacts(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [cid, name, ts, ts]);
  }
  mkDate(c1, '生日', m1, d1, 1990, 'birthday');
  mkDate(c2, '忌日', m2, d2, 2015, 'deceased_date');
  mkDate(c3, '结婚纪念日', m3, d3, 2018, 'anniversary');
  mkDate(c1, '认识纪念日', m4, d4, 2012, 'anniversary');
  mkDate(c2, '入职', m5, d5, null, 'custom');

  await winMain.webContents.executeJavaScript(`location.hash = '#/contacts'; true`);
  await new Promise((r) => setTimeout(r, 700));
  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 1600));

  const shot = await winMain.webContents.capturePage();
  const file = path.join(OUT_DIR, 'today-anniversary.png');
  fs.writeFileSync(file, shot.toPNG());
  console.log('\nwrote ' + file);

  check('the renderer logged no errors', rendererErrors.length === 0,
    rendererErrors.slice(0, 3).join(' | '));

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    app.exit(1);
  }
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
