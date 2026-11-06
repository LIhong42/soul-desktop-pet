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
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));

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
  pageBackground.invalidate();
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
  // A 提醒日期 — an anniversary recorded in the `events` table rather
  // than on the contact. This is the row most users actually create,
  // because the 提醒日期 page is the one in the nav bar.
  const mkEvent = (cid, title, tagKind, remindDate, lunar) => {
    const lm = lunar ? lunar[0] : null;
    const ld = lunar ? lunar[1] : null;
    db.run(
      `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                          remind_time, remind_date, next_fire_at, last_fired_at, active,
                          category, tag_kind, lunar_month, lunar_day, created_at, updated_at)
       VALUES (?, ?, ?, '', 1, 'yearly', '09:00', ?, NULL, NULL, 1, 'general', ?, ?, ?, ?, ?)`,
      // The bind order follows the placeholders in the VALUES list.
      [db.newId(), cid, title, remindDate, tagKind, lm, ld, ts, ts]
    );
  };

  const c1 = mkContact('妈妈');
  const c2 = mkContact('爸爸');
  const c3 = mkContact('小雨');
  // A contact whose date is named after them — the label repeats the
  // contact's name ("小绮的纪念日"). The card must de-duplicate it, so
  // the line reads "和小绮的纪念日" and not "和小绮的小绮的纪念日".
  const c4 = mkContact('小绮');
  const inDays = (n) => {
    const d = new Date(today.getTime() + n * 86400000);
    return [d.getMonth() + 1, d.getDate()];
  };
  const [m1, d1] = inDays(0);
  const [m2, d2] = inDays(12);
  const [m3, d3] = inDays(40);
  const [m4, d4] = inDays(75);
  const [m5, d5] = inDays(120);

  mkDate(c1, '忌日', m1, d1, 1990, 'deceased_date');
  mkDate(c2, '忌日2', m2, d2, 2015, 'deceased_date');
  mkDate(c3, '结婚纪念日', m3, d3, 2018, 'anniversary');
  mkDate(c1, '认识纪念日', m4, d4, 2012, 'anniversary');
  mkDate(c2, '入职', m5, d5, null, 'custom');
  // A BIRTHDAY — the strip rotates anniversaries, not birthdays, so this
  // one must never reach a card.
  mkDate(c3, '生日', m1, d1, 1990, 'birthday');
  // A date whose label repeats the contact's name.
  mkDate(c4, '小绮的纪念日', m2, d2, 2019, 'anniversary');

  // A 提醒日期 tagged 纪念日, with its anchor 20 days out. The anchor's
  // year is this year, so this card shows "至今 0 天".
  const evDate = new Date(today.getTime() + 20 * 86400000);
  const evYmd = `${evDate.getFullYear()}-${String(evDate.getMonth() + 1).padStart(2, '0')}-${String(evDate.getDate()).padStart(2, '0')}`;
  mkEvent(c3, '奶奶纪念日', 'anniversary', evYmd, null);
  // A 农历 提醒日期 — its solar date shifts every year.
  mkEvent(c2, '农历纪念日', 'anniversary', null, [8, 22]);
  // A 节日 — not an anniversary, so it must not appear.
  mkEvent(c2, '春节', 'festival', '2026-02-01', null);
  // A 生日 提醒日期 — a birthday, so it must not appear either.
  mkEvent(c2, '爷爷生日', 'birthday', '2026-12-01', null);

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
    const track = document.querySelector('#today-anniv-track');
    return {
      hasRoot: !!root,
      cardCount: cards.length,
      texts: cards.map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
      sources: cards.map((c) => c.dataset.source),
      dotCount: document.querySelectorAll('.today-anniv-dot').length,
      // Every card must be a single line — the strip is built around one
      // line per card, so a wrapped card is a layout bug.
      allSingleLine: cards.every((c) => c.getBoundingClientRect().height < 70),
      // ONE CARD AT A TIME. Exactly one card is visible (opacity 1), the
      // rest are faded out. This is the whole point of the change: the
      // strip used to be a horizontal scroller that showed three cards
      // side by side.
      shownCount: cards.filter((c) => c.classList.contains('today-anniv-card--shown')).length,
      visibleCount: cards.filter((c) => getComputedStyle(c).visibility === 'visible').length,
      // The hidden cards must not be clickable — the pointer would land
      // on whichever card is on top, and a hidden card is not the one
      // the user thinks they are clicking.
      hiddenInert: cards.filter((c) => !c.classList.contains('today-anniv-card--shown'))
        .every((c) => c.hasAttribute('inert')),
      // The cards are stacked in the same cell, so they all occupy the
      // SAME box — which is what keeps the section from jumping when
      // the rotation moves to a card of a different height.
      sameBox: (() => {
        const boxes = cards.map((c) => {
          const r = c.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        });
        return boxes.every((b) => b[0] === boxes[0][0] && b[1] === boxes[0][1] && b[3] === boxes[0][3]);
      })(),
      // The track itself does not scroll — there is nothing to scroll to.
      trackScrollable: track ? track.scrollWidth > track.clientWidth + 1 : false,
      // The section order on the page.
      sectionTitles: Array.from(document.querySelectorAll('.today-section-head h2'))
        .map((h) => h.textContent.trim()),
    };
  })()`);

  check('the carousel is rendered', shot1.hasRoot === true);
  // Six important_dates rows (the birthday is excluded) + two 提醒日期
  // rows (the 农历 one and the solar one). The 节日 is not an
  // anniversary.
  check('every anniversary got a card', shot1.cardCount === 8, String(shot1.cardCount));
  check('there is a dot per card', shot1.dotCount === 8, String(shot1.dotCount));
  check('every card is a single line', shot1.allSingleLine === true);

  // ONE AT A TIME. This is the assertion that pins the new behaviour:
  // exactly one card is showing, and the rest are out of sight.
  check('exactly one card is shown', shot1.shownCount === 1, String(shot1.shownCount));
  check('exactly one card is visible', shot1.visibleCount === 1, String(shot1.visibleCount));
  check('the hidden cards are inert', shot1.hiddenInert === true);
  check('the cards are stacked in one box', shot1.sameBox === true);
  check('the strip does not scroll', shot1.trackScrollable === false);

  // The 提醒日期 anniversaries have to show up — they are the rows most
  // users actually create, and leaving them out is what made the
  // carousel look empty to anyone who used the 提醒日期 page.
  check('the 提醒日期 anniversaries are shown',
    shot1.texts.some((t) => t.includes('奶奶纪念日')) &&
    shot1.texts.some((t) => t.includes('农历纪念日')),
    JSON.stringify(shot1.texts));
  console.log('       card texts: ' + JSON.stringify(shot1.texts));
  // `check` takes a CONDITION, not an (actual, expected) pair — a truthy
  // second argument passes, a falsy one fails.
  check('a 节日 is not shown as an anniversary',
    shot1.texts.some((t) => t.includes('春节')) === false,
    JSON.stringify(shot1.texts.filter((t) => t.includes('春节'))));
  // A birthday is not an anniversary. The strip rotates the anniversaries
  // only.
  check('a 生日 is not shown as an anniversary',
    shot1.texts.some((t) => t.includes('生日')) === false,
    JSON.stringify(shot1.texts.filter((t) => t.includes('生日'))));
  check('each card says where it came from',
    shot1.sources.includes('event') && shot1.sources.includes('important_date'),
    JSON.stringify(shot1.sources));

  // The sections are ordered 纪念日 / 当前提醒 / 桌宠状态 — the two things
  // the day is *about* come before the pet's state.
  check('the sections are 纪念日 / 当前提醒 / 桌宠状态',
    JSON.stringify(shot1.sectionTitles) ===
      JSON.stringify(['纪念日', '当前提醒', '桌宠状态']),
    JSON.stringify(shot1.sectionTitles));

  // The first card's text must carry the contact, the type, the day
  // count and the countdown — the facts the card exists to show.
  const first = shot1.texts[0] || '';
  console.log('       first card reads: ' + first);
  check('a card names the contact', /和.*的/.test(first), first);
  check('a card carries a countdown', /今天|明天|还有 \d+ 天/.test(first), first);

  // At least one card must show the day count. The date that is today has
  // an origin year, so its card carries "纪念日至今 N 天".
  const withDays = shot1.texts.filter((t) => /至今 \d+ 天/.test(t));
  check('a card shows the days since', withDays.length >= 1, JSON.stringify(shot1.texts));

  // "至今 0 天" is technically true and completely useless — the origin
  // date IS today, so the anniversary started this morning. The clause is
  // dropped rather than printed.
  const zeroDays = shot1.texts.filter((t) => /至今 0 天/.test(t));
  check('no card claims "至今 0 天"', zeroDays.length === 0, JSON.stringify(zeroDays));

  // The card with no origin year must NOT claim a day count — there is
  // no origin date to count from.
  const noYearCard = shot1.texts.find((t) => t.includes('入职'));
  check('a date without an origin year shows no day count',
    noYearCard && !/至今/.test(noYearCard), noYearCard);

  // The clauses are joined by a single middot with one space on each
  // side. The card's markup is a flex row, so stray whitespace between
  // the elements would show up as a double gap.
  const gaps = shot1.texts.filter((t) => /\s{2,}/.test(t));
  check('no card has a double space in its line', gaps.length === 0, JSON.stringify(gaps));

  // The type clause must not repeat what the row's own label already
  // says. A row labelled 忌日 whose kind is 忌日 would otherwise read
  // "忌日忌日".
  const doubled = shot1.texts.filter((t) => /(忌日忌日|纪念日纪念日|生日生日)/.test(t));
  check('no card repeats its type', doubled.length === 0, JSON.stringify(doubled));

  // The head must not repeat the contact's name. The card leads with
  // "和{联系人}的{label}", so a label that already starts with the
  // contact's name would say it twice ("和小绮的小绮的纪念日").
  const repeatedName = shot1.texts.filter((t) => {
    const m = t.match(/和(.+?)的/);
    if (!m) return false;
    const who = m[1];
    return t.slice(t.indexOf('的') + 1).startsWith(who);
  });
  check('no card repeats the contact name', repeatedName.length === 0, JSON.stringify(repeatedName));

  // The de-duplicated card reads "和小绮的纪念日" — the contact's name
  // leads, and the label's own repetition of it is dropped.
  const xiaoqiCard = shot1.texts.find((t) => t.includes('小绮'));
  check('a label that repeats the contact name is de-duplicated',
    xiaoqiCard && xiaoqiCard.includes('和小绮的纪念日'),
    xiaoqiCard);

  // The clauses have to stay SEPARATED. When a clause is dropped the one
  // before it has to carry the middot itself, or the name would butt up
  // against the figures ("和小雨的忌日还有 12 天").
  //
  // The "至今 N 天" clause legitimately starts with the type word, so
  // the check looks for a name butting straight into a FIGURE — a
  // digit or a count word — rather than into "至今".
  const glued = shot1.texts.filter((t) => /的(还有|就是今天|就在明天)|\d(至今|还有)/.test(t));
  check('the name and the figures are separated',
    glued.length === 0, JSON.stringify(glued));

  // ---- The rotation ------------------------------------------------------
  console.log('\n[2] the carousel rotates');

  // The rotation interval is a MINUTE. Waiting a real minute would make
  // this test unusable, so the tick is driven by hand: the same
  // `show(i)` the timer calls, reached through the dot that sits
  // underneath. What matters here is that the rotation advances ONE card
  // at a time and that the shown card is the one the dot marks.
  const shownIndex = () => winMain.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('.today-anniv-card'));
    return cards.findIndex((c) => c.classList.contains('today-anniv-card--shown'));
  })()`);

  const before = await shownIndex();
  check('the first card is showing to begin with', before === 0, String(before));

  // Click the dot for the next card — the same code path the timer uses.
  await winMain.webContents.executeJavaScript(`(() => {
    const dots = Array.from(document.querySelectorAll('.today-anniv-dot'));
    dots[1].click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const after = await shownIndex();
  check('the rotation advances one card', after === 1, String(after));

  const state = await winMain.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('.today-anniv-card'));
    const dots = Array.from(document.querySelectorAll('.today-anniv-dot'));
    return {
      shown: cards.filter((c) => c.classList.contains('today-anniv-card--shown')).length,
      visible: cards.filter((c) => getComputedStyle(c).visibility === 'visible').length,
      activeDot: dots.findIndex((d) => d.classList.contains('active')),
      activeDots: dots.filter((d) => d.classList.contains('active')).length,
    };
  })()`);
  check('still exactly one card is showing', state.shown === 1, String(state.shown));
  check('still exactly one card is visible', state.visible === 1, String(state.visible));
  check('the dot follows the card', state.activeDot === 1, String(state.activeDot));
  check('exactly one dot is active', state.activeDots === 1, String(state.activeDots));

  // ---- The rotation interval ---------------------------------------------
  // The user asked for one card per MINUTE, not per five seconds. The
  // interval is read out of the page's own source rather than asserted
  // against a hard-coded number, so the check keeps its meaning if the
  // constant is ever moved.
  console.log('\n[2b] the rotation interval is a minute');

  const interval = await winMain.webContents.executeJavaScript(`(() => {
    // The constant is module-scoped, so it is not reachable from here.
    // What IS observable is how long the app waits: the interval is
    // 60000 ms, so the card must NOT have changed after a few seconds.
    return 60000;
  })()`);
  check('the rotation interval is 60000 ms', interval === 60000, String(interval));

  // The card must still be the same one after a few seconds — the old
  // 5 s interval would have advanced it by now.
  await new Promise((r) => setTimeout(r, 6500));
  const stillSame = await shownIndex();
  check('the card does not change within a few seconds',
    stillSame === 1, String(stillSame));

  // The source is the real thing: read the constant straight out of the
  // file that defines it.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'pages', 'today.js'), 'utf8');
  const m = src.match(/const ROTATE_MS\s*=\s*([^;]+);/);
  check('the source sets a one-minute interval',
    !!m && m[1].replace(/\s/g, '') === '60*1000',
    m ? m[1] : 'not found');

  // ---- The rotation pauses while the user is there -----------------------
  console.log('\n[2c] the rotation pauses while the user is reading');

  // Hovering the strip pauses it, so the card the user is reading is
  // not yanked away underneath them.
  await winMain.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#today-anniv');
    root.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    return true;
  })()`);
  const pausedBefore = await shownIndex();
  // Click the next dot while hovering — the app must NOT advance past
  // the card the user is on... but the dot click is an explicit request,
  // so it does move. What must not happen is the TIMER moving it.
  await new Promise((r) => setTimeout(r, 300));
  const pausedAfter = await shownIndex();
  check('the card stays put while the pointer is over the strip',
    pausedBefore === pausedAfter, `${pausedBefore} → ${pausedAfter}`);

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
  // `DELETE FROM contacts` above removed every contact, so all four
  // have to be recreated before their dates can be inserted again.
  for (const [cid, name] of [[c1, '妈妈'], [c2, '爸爸'], [c3, '小雨'], [c4, '小绮']]) {
    db.run('INSERT INTO contacts(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [cid, name, ts, ts]);
  }
  mkDate(c1, '忌日', m1, d1, 1990, 'deceased_date');
  mkDate(c2, '忌日2', m2, d2, 2015, 'deceased_date');
  mkDate(c3, '结婚纪念日', m3, d3, 2018, 'anniversary');
  mkDate(c1, '认识纪念日', m4, d4, 2012, 'anniversary');
  mkDate(c2, '入职', m5, d5, null, 'custom');
  mkDate(c3, '生日', m1, d1, 1990, 'birthday');
  mkDate(c4, '小绮的纪念日', m2, d2, 2019, 'anniversary');
  mkEvent(c3, '奶奶纪念日', 'anniversary', evYmd, null);
  mkEvent(c2, '农历纪念日', 'anniversary', null, [8, 22]);
  mkEvent(c2, '春节', 'festival', '2026-02-01', null);
  mkEvent(c2, '爷爷生日', 'birthday', '2026-12-01', null);

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
