// scripts/test-card-life-design.js — guards the 抽卡人生 page's design
// system.
//
// What this protects:
//
//   1. The page opts into its own scoped stylesheet. If `.cl-page` (or the
//      `.cl-*` class names) disappears, the page silently falls back to the
//      app's generic look — the exact regression this file exists to
//      catch, because nothing else fails when it happens.
//
//   2. The page wears the shared background artwork. The 抽卡人生 page was
//      given `today-background.png` as its backdrop, and its cards are
//      translucent sheets over that picture. A regression to opaque cards
//      would turn the page back into "white boxes pasted on a painting",
//      and a regression in the route list would leave the page bare.
//
//   3. The stylesheet is actually loaded. A <link> that 404s (a moved
//      file, a bad path) leaves the page unstyled but reports no error.
//
// It drives the REAL main window with the REAL preload and IPC handlers,
// because the failure would be in the seam between the renderer markup and
// the CSS that styles it.
//
// Usage: node scripts/run-electron.js scripts/test-card-life-design.js

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
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

app.whenReady().then(async () => {
  console.log('抽卡人生 page design system test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-cldesign-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();

  // One card the user added, so the page's own-cards block has content and
  // the assertions below can check the real markup rather than the empty
  // state.
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

  // The PIN gate sets `display: none` on #app — the router mounts the page
  // underneath it, but a hidden element has NO LAYOUT, so every
  // getBoundingClientRect() would read 0×0 and every size assertion would
  // pass vacuously. The gate is a renderer-side `body.locked` class, so
  // dropping it reveals the app.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  // -------------------------------------------------------------------------
  // Test 1 — the design stylesheet is loaded
  // -------------------------------------------------------------------------
  console.log('\n[1] the design stylesheet is loaded');
  const sheet = await winMain.webContents.executeJavaScript(`(() => {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const cl = links.find((l) => (l.getAttribute('href') || '').includes('card_life.css'));
    return {
      hasLink: !!cl,
      // A stylesheet that 404s still appears in the DOM, so check that the
      // sheet actually parsed — the cssRules list is only populated when
      // the file loaded.
      ruleCount: cl && cl.sheet ? cl.sheet.cssRules.length : 0,
    };
  })()`);
  check('the page links the card_life.css stylesheet', sheet.hasLink);
  check('card_life.css parsed into rules', sheet.ruleCount > 40, `ruleCount=${sheet.ruleCount}`);

  // -------------------------------------------------------------------------
  // Test 2 — the EMPTY state (nothing drawn yet)
  // -------------------------------------------------------------------------
  console.log('\n[2] the empty state renders the deck');
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life'; true`);
  await new Promise((r) => setTimeout(r, 1200));

  const empty = await winMain.webContents.executeJavaScript(`(() => ({
    page: !!document.querySelector('.cl-page'),
    deck: !!document.querySelector('.cl-deck'),
    deckStack: document.querySelectorAll('.cl-deck-card').length,
    drawBtn: !!document.getElementById('cl-draw'),
    // The app root's own size — see the layout guard below.
    appWidth: (document.getElementById('app') || {clientWidth: 0}).clientWidth,
    appHeight: (document.getElementById('app') || {clientHeight: 0}).clientHeight,
    // The rules card is ALWAYS on the page — it is the note that says how
    // the game works, so the user never has to guess why the button says
    // 「抽一张卡」 and why it only works once a week.
    rules: !!document.querySelector('.cl-rules-card'),
    ruleItems: document.querySelectorAll('.cl-rules-list li').length,
    ruleTitles: Array.from(document.querySelectorAll('.cl-rule-title'))
      .map((t) => t.textContent.trim()),
  }))()`);
  check('the page wrapper carries .cl-page', empty.page);
  check('the deck is rendered before anything is drawn', empty.deck);
  check('the deck is a stack of three cards', empty.deckStack === 3,
    `got ${empty.deckStack}`);
  check('the draw button is rendered', empty.drawBtn);
  check('the rules card is rendered', empty.rules);
  check('the rules card lists three rules', empty.ruleItems === 3,
    `got ${empty.ruleItems}`);
  check('the rules are the three the game has',
    JSON.stringify(empty.ruleTitles) === JSON.stringify([
      '每周只能抽取一张卡', '官方卡片与自定义卡片混合', '完成后记录回忆',
    ]),
    JSON.stringify(empty.ruleTitles));
  // The page must actually be LAID OUT. Every size assertion below reads a
  // bounding box, and a hidden element (the PIN gate sets `display: none`
  // on #app) has a box of 0×0 — which would make all of them pass
  // vacuously while proving nothing. So the layout is checked up front.
  check('the page is laid out, not hidden',
    empty.appWidth > 0 && empty.appHeight > 0,
    `#app is ${empty.appWidth}x${empty.appHeight}`);

  // -------------------------------------------------------------------------
  // Test 3 — the page wears the background artwork
  // -------------------------------------------------------------------------
  console.log('\n[3] the page wears the background artwork');
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
  check('the page is not in the no-art state', !bg.noArt);
  check('the background image is set', !!bg.image, bg.image);
  check('the computed background carries the image',
    bg.computed.includes('file://'), bg.computed);
  check('the artwork is the shipped today-background.png',
    /today-background/.test(bg.image), bg.image);

  // -------------------------------------------------------------------------
  // Test 4 — the drawn card
  // -------------------------------------------------------------------------
  console.log('\n[4] the drawn card renders');
  // A draw for THIS week, then reload the page so it picks the card up.
  //
  // The draw is seeded rather than made with cardDraws.draw(), because a
  // real draw picks at RANDOM from the whole pool — official deck and the
  // user's own cards together — so it could land on the user's own card
  // 2% of the time. That card has no number in the official deck, so the
  // counter reads 「我的专属卡片」 instead of 「本周第 N 号卡片」 and the
  // assertions below would fail at random. Seeding the draw with a known
  // card from the deck makes the test deterministic.
  const deck = cardDraws.readDeck(null);
  check('the official deck has cards', deck.cards.length > 0,
    `${deck.cards.length} cards`);
  const deckCard = deck.cards[0];
  db.createCardDraw({
    week_key: cardDraws.weekKey(new Date()),
    card_no: deckCard.no,
    title: deckCard.title,
    requirement: deckCard.requirement,
    source: 'deck',
  });
  await winMain.webContents.executeJavaScript(
    `location.hash = '#/events/memorial'; true`);
  await new Promise((r) => setTimeout(r, 300));
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life'; true`);
  await new Promise((r) => setTimeout(r, 1200));

  const card = await winMain.webContents.executeJavaScript(`(() => ({
    card: !!document.querySelector('.cl-card'),
    deck: !!document.querySelector('.cl-deck'),
    badge: (document.querySelector('.cl-card-badge') || {}).textContent || '',
    clip: !!document.querySelector('.cl-card-clip'),
    counter: (document.querySelector('.cl-card-no') || {}).textContent || '',
    number: (document.querySelector('.cl-card-no b') || {}).textContent || '',
    title: (document.querySelector('.cl-card-title') || {}).textContent || '',
    req: (document.querySelector('.cl-card-req') || {}).textContent || '',
    actions: document.querySelectorAll('.cl-actions .btn').length,
    recordBtn: !!document.getElementById('cl-record'),
    note: (document.querySelector('.cl-card-note') || {}).textContent || '',
  }))()`);
  check('the drawn card replaces the deck', card.card && !card.deck);
  check('the card carries the 本周挑战 badge', card.badge.includes('本周挑战'),
    card.badge);
  check('the card carries the paperclip', card.clip);
  check('the card shows its number in the deck', /本周第/.test(card.counter),
    card.counter);
  check('the number is set apart from the words',
    card.number !== '' && Number(card.number) > 0, card.number);
  check('the card shows a title', card.title.trim().length > 0, card.title);
  check('the card shows its requirement', card.req.trim().length > 0, card.req);
  check('the card offers both actions', card.actions === 2, `got ${card.actions}`);
  check('the 记录这一张 button is present', card.recordBtn);
  check('the card states the week is drawn', card.note.includes('已抽取'),
    card.note);

  // -------------------------------------------------------------------------
  // Test 5 — the design CSS applies to the drawn card
  // -------------------------------------------------------------------------
  console.log('\n[5] the design CSS applies');
  const computed = await winMain.webContents.executeJavaScript(`(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const cardCs = cs('.cl-card');
    const rulesCs = cs('.cl-rules-card');
    const pageCs = cs('.cl-page');
    const titleCs = cs('.cl-card-title');
    const numCs = cs('.cl-card-no b');
    const badgeCs = cs('.cl-card-badge');
    return {
      cardBg: cardCs.backgroundColor,
      cardRadius: cardCs.borderRadius,
      cardBlur: cardCs.backdropFilter || cardCs.webkitBackdropFilter || '',
      rulesBg: rulesCs.backgroundColor,
      rulesBorder: rulesCs.borderStyle,
      pageColor: pageCs.color,
      maxWidth: pageCs.maxWidth,
      titleSize: titleCs.fontSize,
      titleWeight: titleCs.fontWeight,
      numSize: numCs.fontSize,
      badgeRadius: badgeCs.borderRadius,
      badgeBg: badgeCs.backgroundColor,
      // The two cards sit side by side, not stacked: the rules card is
      // BESIDE the drawn card, on the same row.
      cardTop: document.querySelector('.cl-card').getBoundingClientRect().top,
      rulesTop: document.querySelector('.cl-rules-card').getBoundingClientRect().top,
      cardLeft: document.querySelector('.cl-card').getBoundingClientRect().left,
      rulesLeft: document.querySelector('.cl-rules-card').getBoundingClientRect().left,
    };
  })()`);

  // The card is a translucent sheet laid over the artwork, not an opaque
  // rectangle pasted on top of it.
  const alphaOf = (bg) => {
    const m = /rgba?\(([^)]*)\)/.exec(bg || '');
    if (!m) return 1;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return parts.length === 4 ? parts[3] : 1;
  };
  check('the drawn card is translucent', alphaOf(computed.cardBg) < 1,
    `${computed.cardBg} (alpha ${alphaOf(computed.cardBg)})`);
  check('the drawn card blurs the artwork behind it',
    /blur/.test(computed.cardBlur), computed.cardBlur);
  check('the rules card is translucent too', alphaOf(computed.rulesBg) < 1,
    `${computed.rulesBg} (alpha ${alphaOf(computed.rulesBg)})`);
  check('the rules card has a dashed edge', computed.rulesBorder === 'dashed',
    computed.rulesBorder);
  check('the cards use the large rounded radius', parseFloat(computed.cardRadius) >= 18,
    computed.cardRadius);
  check('the badge is a pill', parseFloat(computed.badgeRadius) >= 999,
    computed.badgeRadius);
  check('the page ink is the warm near-black',
    computed.pageColor.includes('61') || computed.pageColor.includes('49'),
    computed.pageColor);
  check('the card title is display-sized', parseFloat(computed.titleSize) >= 24,
    computed.titleSize);
  check('the card title is bold', parseInt(computed.titleWeight, 10) >= 700,
    computed.titleWeight);
  check('the card number is larger than the words around it',
    parseFloat(computed.numSize) >= 20, computed.numSize);
  check('the reading column is capped', parseFloat(computed.maxWidth) > 0 &&
    parseFloat(computed.maxWidth) <= 1200, computed.maxWidth);
  // The two cards sit on the SAME row: their tops line up and the rules
  // card is to the RIGHT of the drawn one.
  check('the rules card sits beside the drawn card',
    Math.abs(computed.cardTop - computed.rulesTop) < 4,
    `cardTop=${computed.cardTop} rulesTop=${computed.rulesTop}`);
  check('the rules card is to the right of the drawn card',
    computed.rulesLeft > computed.cardLeft,
    `cardLeft=${computed.cardLeft} rulesLeft=${computed.rulesLeft}`);

  // -------------------------------------------------------------------------
  // Test 6 — the user's own cards
  // -------------------------------------------------------------------------
  console.log('\n[6] the own-cards block renders');
  const own = await winMain.webContents.executeJavaScript(`(() => ({
    section: !!document.querySelector('.cl-custom'),
    preview: document.querySelectorAll('.cl-custom-card').length,
    previewTitle: (document.querySelector('.cl-custom-card .cl-custom-title') || {}).textContent || '',
    // The add slot is GONE: the dashed frame that held the button is
    // gone, and the button itself lives under the list now.
    addSlot: !!document.getElementById('cl-add-slot'),
    addBtn: !!document.getElementById('cl-custom-add'),
    // The add form is HIDDEN until the button is clicked — the page's
    // default state is the list, not a form.
    form: !!document.getElementById('cl-custom-form'),
    // The duplicate 「已添加的卡片」 list is GONE: the cards are listed
    // once, under 我的专属卡片.
    addedSection: document.querySelectorAll('.cl-custom-row').length,
    addedHeading: Array.from(document.querySelectorAll('.cl-custom h2'))
      .some((h) => h.textContent.includes('已添加的卡片')),
    // Each card carries its own delete button.
    delBtns: document.querySelectorAll('.cl-custom-del').length,
    previewDelBtns: document.querySelectorAll('.cl-custom-del--preview').length,
  }))()`);
  check('the own-cards section is rendered', own.section);
  check('the own card is listed', own.preview === 1, `got ${own.preview}`);
  check('the list shows the card\'s title',
    own.previewTitle.includes('三个月'), own.previewTitle);
  check('the add slot is gone', !own.addSlot);
  check('the add button is rendered', own.addBtn);
  check('the add form is hidden until asked for', !own.form);
  check('the duplicate 已添加的卡片 list is gone', !own.addedHeading);
  check('no leftover rows from the old table', own.addedSection === 0,
    `got ${own.addedSection}`);
  check('the card carries a delete button', own.previewDelBtns === 1,
    `got ${own.previewDelBtns}`);
  check('every card can be deleted', own.delBtns === own.preview,
    `got ${own.delBtns}`);

  // -------------------------------------------------------------------------
  // Test 7 — clicking the add button opens the form
  // -------------------------------------------------------------------------
  console.log('\n[7] the add button opens the form');
  await winMain.webContents.executeJavaScript(`(() => {
    document.getElementById('cl-custom-add').click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const opened = await winMain.webContents.executeJavaScript(`(() => ({
    form: !!document.getElementById('cl-custom-form'),
    title: !!document.getElementById('cl-custom-title'),
    req: !!document.getElementById('cl-custom-req'),
    submit: !!document.getElementById('cl-custom-submit'),
    cancel: !!document.getElementById('cl-custom-cancel'),
  }))()`);
  check('the add form opened', opened.form);
  check('the form has a title field', opened.title);
  check('the form has a requirement field', opened.req);
  check('the form has a submit button', opened.submit);
  // The 「添加卡片」 button is replaced by the form, so without a cancel
  // button the form would be a one-way door.
  check('the form can be cancelled', opened.cancel);

  // -------------------------------------------------------------------------
  // Test 8 — the 记录这一张 button goes to the diary editor
  // -------------------------------------------------------------------------
  console.log('\n[8] the record button opens the diary editor');
  const before = await winMain.webContents.executeJavaScript(`location.hash`);
  await winMain.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('cl-record');
    if (btn) btn.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const after = await winMain.webContents.executeJavaScript(`location.hash`);
  check('the record button navigates to the diary editor',
    after.startsWith('#/diary/new?draw='), `before=${before} after=${after}`);

  // -------------------------------------------------------------------------
  // Test 9 — the list is paginated
  // -------------------------------------------------------------------------
  //
  // The 我的专属卡片 list shows a fixed number of cards per page, with
  // the app's shared pager underneath. A card is never hidden: it is one
  // click of 「下一页」 away, and every card carries its own delete
  // button, so any card can be deleted from any page.
  console.log('\n[9] the own-cards list is paginated');
  // Five more cards, so there are six in total — more than one page.
  for (let i = 0; i < 5; i++) {
    db.createCustomCard({
      title: `第 ${i + 2} 张卡`,
      requirement: `第 ${i + 2} 张卡的要求`,
    });
  }
  await winMain.webContents.executeJavaScript(
    `location.hash = '#/events/memorial'; true`);
  await new Promise((r) => setTimeout(r, 300));
  await winMain.webContents.executeJavaScript(`location.hash = '#/card-life'; true`);
  await new Promise((r) => setTimeout(r, 1000));

  const first = await winMain.webContents.executeJavaScript(`(() => ({
    listed: document.querySelectorAll('.cl-custom-card').length,
    pager: !!document.querySelector('.cl-custom #cl-custom-pager .section-page'),
    counter: (document.querySelector('.cl-custom .section-pager .meta') || {}).textContent || '',
    nextDisabled: !!document.querySelector('.cl-custom .section-page[data-action="next"]')
      && document.querySelector('.cl-custom .section-page[data-action="next"]').disabled,
    prevDisabled: !!document.querySelector('.cl-custom .section-page[data-action="prev"]')
      && document.querySelector('.cl-custom .section-page[data-action="prev"]').disabled,
    titles: Array.from(document.querySelectorAll('.cl-custom-card .cl-custom-title'))
      .map((t) => t.textContent.trim()),
    // The count chip reports the TRUE total, not the shown count.
    count: (document.querySelector('.cl-custom .cl-count') || {}).textContent || '',
  }))()`);
  check('one page shows a fixed number of cards', first.listed === 3,
    `got ${first.listed}`);
  check('the pager is rendered', first.pager);
  check('the pager counts the pages', /第\s*1\s*\/\s*2\s*页/.test(first.counter),
    first.counter);
  check('the pager counts the cards', first.counter.includes('6'), first.counter);
  check('the count chip reports the true total', first.count.includes('6'),
    first.count);
  check('the previous button is disabled on the first page', first.prevDisabled);
  check('the next button is enabled', !first.nextDisabled);

  // Turn the page. The cards that were not on the first page must now be
  // there — nothing is hidden, only paged.
  await winMain.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.cl-custom .section-page[data-action="next"]');
    if (btn) btn.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  const second = await winMain.webContents.executeJavaScript(`(() => ({
    listed: document.querySelectorAll('.cl-custom-card').length,
    counter: (document.querySelector('.cl-custom .section-pager .meta') || {}).textContent || '',
    titles: Array.from(document.querySelectorAll('.cl-custom-card .cl-custom-title'))
      .map((t) => t.textContent.trim()),
    nextDisabled: !!document.querySelector('.cl-custom .section-page[data-action="next"]')
      && document.querySelector('.cl-custom .section-page[data-action="next"]').disabled,
    prevDisabled: !!document.querySelector('.cl-custom .section-page[data-action="prev"]')
      && document.querySelector('.cl-custom .section-page[data-action="prev"]').disabled,
    // Every card on this page can be deleted too.
    delBtns: document.querySelectorAll('.cl-custom-card .cl-custom-del').length,
  }))()`);
  check('the second page shows the remaining cards', second.listed === 3,
    `got ${second.listed}`);
  check('the pager moved to the second page',
    /第\s*2\s*\/\s*2\s*页/.test(second.counter), second.counter);
  check('the second page shows DIFFERENT cards',
    second.titles.join() !== first.titles.join(),
    `${JSON.stringify(first.titles)} vs ${JSON.stringify(second.titles)}`);
  check('the next button is disabled on the last page', second.nextDisabled);
  check('the previous button is enabled', !second.prevDisabled);
  check('the cards on the second page can be deleted too',
    second.delBtns === second.listed, `got ${second.delBtns}`);

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
