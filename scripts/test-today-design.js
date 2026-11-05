// scripts/test-today-design.js — guards the 今日 page's design system.
//
// What this protects:
//
//   1. The page opts into its own scoped stylesheet. If `.today-page` (or
//      the `.today-*` class names) disappears, the page silently falls back
//      to the app's generic look — the exact regression this file exists to
//      catch, because nothing else fails when it happens.
//
//   2. The live-update path still finds its hooks. `applyStatus` repaints
//      the mood / bond / 陪伴状态 panels in place from `pet:status-changed`
//      pushes; it locates them by `data-bind` attributes. If a rename
//      breaks one of those, the numbers silently freeze while the rest of
//      the page keeps updating — invisible in a screenshot, obvious to a
//      user.
//
//   3. The stylesheet is actually loaded. A <link> that 404s (a moved
//      file, a bad path) leaves the page unstyled but reports no error.
//
// It drives the REAL main window with the REAL preload and IPC handlers,
// because the failure would be in the seam between the renderer markup and
// the CSS that styles it.
//
// Usage: node scripts/run-electron.js scripts/test-today-design.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const todayBackground = require(path.join(ROOT, 'main', 'today_background.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

app.whenReady().then(async () => {
  console.log('今日 page design system test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-design-'));
  await db.open(path.join(dir, 'test.sqlite'));
  todayBackground.invalidate();

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
      isImported: () => false,
      getRootDir: () => '',
      rescan: () => {},
    },
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // The PIN gate hides #app, but the router still mounts underneath it.
  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 1000));

  // -------------------------------------------------------------------------
  // Test 1 — the design stylesheet is loaded and applied
  // -------------------------------------------------------------------------
  console.log('\n[1] the design stylesheet is loaded');
  const sheet = await winMain.webContents.executeJavaScript(`(() => {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const today = links.find((l) => (l.getAttribute('href') || '').includes('today.css'));
    return {
      count: links.length,
      hasTodayLink: !!today,
      // A stylesheet that 404s still appears in the DOM, so check that the
      // sheet actually parsed — the cssRules list is only populated when
      // the file loaded.
      ruleCount: today && today.sheet ? today.sheet.cssRules.length : 0,
    };
  })()`);
  check('the page links the today.css stylesheet', sheet.hasTodayLink);
  check('today.css parsed into rules', sheet.ruleCount > 20, `ruleCount=${sheet.ruleCount}`);

  // -------------------------------------------------------------------------
  // Test 2 — the page uses the scoped design classes
  // -------------------------------------------------------------------------
  console.log('\n[2] the page renders the scoped markup');
  const markup = await winMain.webContents.executeJavaScript(`(() => ({
    page: !!document.querySelector('.today-page'),
    hero: !!document.querySelector('.today-hero-title'),
    statusGrid: !!document.querySelector('.today-status-grid'),
    moodCard: !!document.querySelector('.today-mood-card'),
    moodPortrait: !!document.querySelector('.today-mood-portrait'),
    bondCard: !!document.querySelector('.today-bond-card'),
    tierPill: !!document.querySelector('.today-tier-pill'),
    bondNumber: !!document.querySelector('.today-bond-number b'),
    companionStats: document.querySelectorAll('.today-companion-cell').length,
    companionIcon: !!document.querySelector('.today-companion-icon'),
    sectionHeads: document.querySelectorAll('.today-section-head').length,
    weekday: (document.querySelector('.today-hero-weekday') || {}).textContent || '',
    heroDate: (document.querySelector('.today-hero-date') || {}).textContent || '',
  }))()`);
  check('the page wrapper carries .today-page', markup.page);
  check('the date header is rendered', markup.hero);
  check('the weekday is shown beside the date',
    /^星期[日一二三四五六]$/.test(markup.weekday.trim()),
    `got "${markup.weekday}"`);
  check('the weekday is a sibling of the date, not inside it',
    markup.heroDate.trim().startsWith('今日 ·') &&
      !markup.heroDate.includes('星期'),
    `got "${markup.heroDate}"`);
  check('the 桌宠状态 grid is rendered', markup.statusGrid);
  check('the mood panel is rendered', markup.moodCard);
  check('the mood portrait is rendered', markup.moodPortrait);
  check('the bond panel is rendered', markup.bondCard);
  check('the tier pill is rendered', markup.tierPill);
  check('the big 亲密度 number is rendered', markup.bondNumber);
  check('the 陪伴状态 panel has three columns', markup.companionStats === 3,
    `got ${markup.companionStats}`);
  check('the 陪伴状态 icon chips are rendered', markup.companionIcon);
  check('both section headings are rendered', markup.sectionHeads === 2,
    `got ${markup.sectionHeads}`);

  // -------------------------------------------------------------------------
  // Test 3 — the design CSS actually applies (computed styles, not just
  //           the presence of the stylesheet)
  // -------------------------------------------------------------------------
  console.log('\n[3] the design CSS applies to the rendered page');
  const computed = await winMain.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.today-mood-card');
    const page = document.querySelector('.today-page');
    const num = document.querySelector('.today-bond-number b');
    const date = document.querySelector('.today-hero-date');
    const weekday = document.querySelector('.today-hero-weekday');
    const cs = (el) => el ? getComputedStyle(el) : null;
    const cardCs = cs(card);
    const pageCs = cs(page);
    const dateCs = cs(date);
    const weekdayCs = cs(weekday);
    return {
      radius: cardCs.borderRadius,
      cardBg: cardCs.backgroundColor,
      pageColor: pageCs.color,
      numSize: cs(num).fontSize,
      numWeight: cs(num).fontWeight,
      maxWidth: pageCs.maxWidth,
      marginLeft: pageCs.marginLeft,
      // The page must not be wider than its column — that is the whole
      // point of the cap. Read it off the live layout, not the stylesheet.
      pageWidth: page.getBoundingClientRect().width,
      viewportWidth: document.getElementById('app').clientWidth,
      // The weekday is typeset like the date — same size, weight and ink.
      weekdaySize: weekdayCs.fontSize,
      weekdayWeight: weekdayCs.fontWeight,
      weekdayColor: weekdayCs.color,
      weekdayBg: weekdayCs.backgroundColor,
      dateSize: dateCs.fontSize,
      dateWeight: dateCs.fontWeight,
      dateColor: dateCs.color,
    };
  })()`);
  check('the mood card uses the large rounded radius', parseFloat(computed.radius) >= 18,
    computed.radius);
  check('the mood card uses the warm paper background',
    computed.cardBg.includes('253') || computed.cardBg.includes('255'),
    computed.cardBg);
  check('the page ink is the warm near-black',
    computed.pageColor.includes('61') || computed.pageColor.includes('49'),
    computed.pageColor);
  check('the 亲密度 number is display-sized', parseFloat(computed.numSize) >= 36,
    computed.numSize);
  check('the 亲密度 number is bold', parseInt(computed.numWeight, 10) >= 700,
    computed.numWeight);
  check('the reading column is capped', parseFloat(computed.maxWidth) > 0 &&
    parseFloat(computed.maxWidth) <= 1200, computed.maxWidth);
  check('the reading column is centered',
    computed.marginLeft === 'auto' || computed.marginLeft === '0px',
    computed.marginLeft);
  check('the page does not stretch past its column',
    computed.pageWidth <= parseFloat(computed.maxWidth) + 1,
    `page=${computed.pageWidth} max=${computed.maxWidth}`);
  check('the weekday is set in the date\'s type',
    computed.weekdaySize === computed.dateSize &&
      computed.weekdayWeight === computed.dateWeight &&
      computed.weekdayColor === computed.dateColor,
    `weekday=${computed.weekdaySize}/${computed.weekdayWeight}/${computed.weekdayColor} ` +
    `date=${computed.dateSize}/${computed.dateWeight}/${computed.dateColor}`);
  check('the weekday is not a chip',
    computed.weekdayBg === 'rgba(0, 0, 0, 0)' ||
      computed.weekdayBg === 'transparent',
    computed.weekdayBg);

  // -------------------------------------------------------------------------
  // Test 4 — the live-update hooks are still wired
  // -------------------------------------------------------------------------
  console.log('\n[4] the live-update hooks are wired');
  const hooks = await winMain.webContents.executeJavaScript(`(() => {
    const host = document.getElementById('pet-status');
    const q = (n) => host && host.querySelector('[data-bind="' + n + '"]');
    return {
      host: !!host,
      moodIcon: !!q('mood-icon'),
      moodLabel: !!q('mood-label'),
      moodNote: !!q('mood-note'),
      tierBadge: !!q('tier-badge'),
      tierLabel: !!q('tier-label'),
      bondValue: !!q('bond-value'),
      bondFill: !!q('bond-fill'),
      bondNote: !!q('bond-note'),
      cozyValue: !!q('cozy-value'),
      cozyFill: !!q('cozy-fill'),
      streak: !!q('streak'),
      lonely: !!q('lonely'),
      todayActions: !!q('today-actions'),
      moodCard: !!host.querySelector('.today-mood-card[data-mood]'),
    };
  })()`);
  check('the status host is present', hooks.host);
  check('the mood card carries data-mood', hooks.moodCard);
  for (const key of ['moodIcon', 'moodLabel', 'moodNote', 'tierBadge', 'tierLabel',
                     'bondValue', 'bondFill', 'bondNote', 'cozyValue', 'cozyFill',
                     'streak', 'lonely', 'todayActions']) {
    check(`the ${key} hook is present`, hooks[key]);
  }

  // -------------------------------------------------------------------------
  // Test 5 — a status push actually repaints the page
  // -------------------------------------------------------------------------
  console.log('\n[5] a status push repaints the page in place');
  const before = await winMain.webContents.executeJavaScript(`(() => {
    const q = (n) => document.querySelector('#pet-status [data-bind="' + n + '"]');
    return {
      bondValue: q('bond-value').textContent.trim(),
      moodLabel: q('mood-label').textContent.trim(),
      streak: q('streak').textContent.trim(),
    };
  })()`);

  // Push a status the page has never rendered, so any change proves the
  // repaint path ran rather than the values merely matching. The push
  // comes from the MAIN process on the same channel the pet controller
  // uses, so it exercises the real preload → api.on → applyStatus path.
  winMain.webContents.send('pet:status-changed', {
    mood: 'festive',
    bond_tier: 3,
    tier_label: '朋友',
    tier_floor: 50,
    bond_value: 123,
    next_tier: { tier: 4, threshold: 200 },
    week_score: 60,
    streak_weeks: 7,
    cozy: 88,
    lonely_hours: 3,
  });
  await new Promise((r) => setTimeout(r, 400));

  const after = await winMain.webContents.executeJavaScript(`(() => {
    const q = (n) => document.querySelector('#pet-status [data-bind="' + n + '"]');
    return {
      bondValue: q('bond-value').textContent.trim(),
      moodLabel: q('mood-label').textContent.trim(),
      streak: q('streak').textContent.trim(),
      cozyValue: q('cozy-value').textContent.trim(),
      lonely: q('lonely').textContent.trim(),
    };
  })()`);

  check('the 亲密度 number was repainted', after.bondValue === '123', after.bondValue);
  check('the mood label was repainted', after.moodLabel === '很开心', after.moodLabel);
  check('the streak was repainted', after.streak === '7', after.streak);
  check('the 舒适度 was repainted', after.cozyValue === '88', after.cozyValue);
  check('the loneliness note was repainted', after.lonely.includes('3'), after.lonely);

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(failures.length ? 1 : 0);
}).catch((e) => {
  console.error('test crashed:', e);
  app.exit(1);
});
