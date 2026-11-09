// scripts/test-contact-design.js — guards the 联系人详情页 design system.
//
// What this protects:
//
//   1. The page opts into its own scoped stylesheet. If `.cd-page` (or
//      contact.css itself) disappears, the page silently falls back to the
//      app's generic look — the exact regression this file exists to catch,
//      because nothing else fails when it happens.
//
//   2. The artwork actually reaches the page. The artwork lives in
//      `resources/ui/` and arrives as a `file://` URL, which is handed to
//      CSS through the `--cd-banner-image` custom property. If the IPC
//      handler, the preload bridge or the renderer plumbing breaks, the
//      page falls back to a flat cream wash and NOTHING reports an
//      error — the page still looks like a page.
//
//   3. The page wears the SHARED background. The whole page and the
//      今日 page show the same picture, so changing the background in 设置
//      changes it everywhere. If the page went back to its own artwork, the
//      two would drift apart again.
//
//   4. The design CSS really applies (computed styles, not just the
//      presence of the stylesheet): the paper background, the rounded card,
//      the orange bar beside a section title, the date chip.
//
//   5. Nothing leaks. The contact styles are scoped under `.cd-page`, so
//      visiting another page must leave no trace of them.
//
// It drives the REAL main window with the REAL preload and IPC handlers,
// because the failure would be in the seam between the renderer markup and
// the CSS that styles it.
//
// Usage: node scripts/run-electron.js scripts/test-contact-design.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fileURLToPath } = require('url');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));
const uiArtwork = require(path.join(ROOT, 'main', 'ui_artwork.js'));
const { PetRegistry } = require(path.join(ROOT, 'main', 'pet_registry.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

app.whenReady().then(async () => {
  console.log('联系人详情页 design system test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-cd-design-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();

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

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  // The PIN gate hides #app — a hidden element has no layout, so every
  // bounding-box assertion below would read 0×0 and pass vacuously.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  // ---- Seed one contact with one of everything the page shows --------
  const now = db.nowStr();
  const contactId = db.newId();
  db.run(
    `INSERT INTO contacts(id, name, relationship, icon_kind, likes_json, taboos_json,
                          gifts_json, listed, created_at, updated_at)
     VALUES (?, ?, ?, 'heart', '[]', '[]', '[]', 1, ?, ?)`,
    [contactId, '小绮', '女朋友', now, now]
  );
  db.run(
    `INSERT INTO contact_attributes(id, contact_id, kind, description, event, created_at, updated_at)
     VALUES (?, ?, 'like', ?, '2025-11-20', ?, ?)`,
    [db.newId(), contactId, '喜欢抹茶甜点', now, now]
  );
  db.run(
    `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                  remind_time, advance_days, remind_enabled, created_at, updated_at)
     VALUES (?, ?, '生日', 1, 3, 1998, 'birthday', '09:00', 7, 1, ?, ?)`,
    [db.newId(), contactId, now, now]
  );
  const memorialId = db.newId();
  db.run(
    `INSERT INTO memorial_events(id, kind, title, place, food, outfit, activities,
                                  notes, occurred_at, created_at, updated_at)
     VALUES (?, 'first_time', '第一次一起看海', '青岛', '海鲜', ?, '看海、吹风',
             '那天的风很大，但她笑得很开心。', '2025-10-31 17:55:00', ?, ?)`,
    [memorialId, '浅蓝连衣裙', now, now]
  );
  db.run(
    `INSERT INTO memorial_event_contacts(memorial_event_id, contact_id, created_at)
     VALUES (?, ?, ?)`,
    [memorialId, contactId, now]
  );

  await winMain.webContents.executeJavaScript(`location.hash = '#/contacts/${contactId}'; true`);
  // The artwork is a 1.6 MB PNG decoded off a file:// URL — give it the
  // same time the shot script gives it, so the first paint is the real one.
  await new Promise((r) => setTimeout(r, 3000));

  // -------------------------------------------------------------------------
  // Test 1 — the design stylesheet is loaded
  // -------------------------------------------------------------------------
  console.log('\n[1] the design stylesheet is loaded');
  const sheet = await winMain.webContents.executeJavaScript(`(() => {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const contact = links.find((l) => (l.getAttribute('href') || '').includes('contact.css'));
    return {
      hasContactLink: !!contact,
      // A stylesheet that 404s still appears in the DOM, so check that the
      // sheet actually parsed — cssRules is only populated when it loaded.
      ruleCount: contact && contact.sheet ? contact.sheet.cssRules.length : 0,
      // contact.css must come AFTER styles.css, or the page's own rules
      // would lose the specificity fight against the global primitives.
      order: links.map((l) => l.getAttribute('href') || ''),
    };
  })()`);
  check('the page links the contact.css stylesheet', sheet.hasContactLink);
  check('contact.css parsed into rules', sheet.ruleCount > 20, `ruleCount=${sheet.ruleCount}`);
  const stylesIdx = sheet.order.findIndex((h) => h.includes('styles.css'));
  const contactIdx = sheet.order.findIndex((h) => h.includes('contact.css'));
  check('contact.css is loaded after styles.css',
    stylesIdx >= 0 && contactIdx > stylesIdx,
    sheet.order.join(' | '));

  // -------------------------------------------------------------------------
  // Test 2 — the page renders the scoped markup
  // -------------------------------------------------------------------------
  console.log('\n[2] the page renders the scoped markup');
  const markup = await winMain.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.cd-page');
    const banner = document.querySelector('.cd-banner');
    const cs = (el) => el ? getComputedStyle(el) : null;
    const pageCs = cs(page);
    const bannerCs = cs(banner);
    return {
      page: !!page,
      appWidth: (document.getElementById('app') || { clientWidth: 0 }).clientWidth,
      appHeight: (document.getElementById('app') || { clientHeight: 0 }).clientHeight,
      banner: !!banner,
      pageClass: page ? page.className : '',
      // The artwork arrives as a file:// URL in a custom property. It is set
      // INLINE on the PAGE (the page is reused for every contact), so it is
      // read off the page wrapper, not off the banner.
      bannerVar: page
        ? getComputedStyle(page).getPropertyValue('--cd-banner-image').trim()
        : '',
      pageBg: pageCs ? pageCs.backgroundImage : '',
      pageAttachment: pageCs ? pageCs.backgroundAttachment : '',
      // The banner carries a local wash of its own, but NOT the artwork.
      bannerBg: bannerCs ? bannerCs.backgroundImage : '',
      avatar: !!document.querySelector('.cd-avatar'),
      editPill: !!document.querySelector('.cd-edit-pill'),
      editPillText: (document.querySelector('.cd-edit-pill') || {}).textContent || '',
      tabbar: !!document.querySelector('.cd-tabbar'),
      tabs: Array.from(document.querySelectorAll('.cd-tab')).map((t) => t.textContent.trim()),
      back: !!document.querySelector('.cd-back'),
      body: !!document.getElementById('cd-body'),
      sectionTitles: Array.from(document.querySelectorAll('#cd-body .section-header h2'))
        .map((h) => h.textContent.trim()),
      cards: document.querySelectorAll('#cd-body .card').length,
      chips: document.querySelectorAll('#cd-body .time-chip').length,
    };
  })()`);
  check('the page wrapper carries .cd-page', markup.page);
  check('the page is laid out, not hidden',
    markup.appWidth > 0 && markup.appHeight > 0,
    `#app is ${markup.appWidth}x${markup.appHeight}`);
  check('the banner is rendered', markup.banner);
  check('the page is not in the no-art fallback state',
    !markup.pageClass.includes('no-art'), markup.pageClass);
  check('the avatar tile is rendered', markup.avatar);
  check('the 编辑基本信息 pill is rendered', markup.editPill);
  check('the 编辑基本信息 pill is labelled',
    markup.editPillText.includes('编辑基本信息'), markup.editPillText);
  check('the tab bar is rendered', markup.tabbar);
  check('the four tabs are rendered',
    markup.tabs.length === 4, JSON.stringify(markup.tabs));
  check('the 返回 control is rendered', markup.back);
  check('the page body is rendered', markup.body);
  check('the overview shows 重要日期 and 回忆事件',
    markup.sectionTitles.includes('重要日期') && markup.sectionTitles.includes('回忆事件'),
    JSON.stringify(markup.sectionTitles));
  check('the overview has cards', markup.cards > 0, `got ${markup.cards}`);
  check('the rows carry a date chip', markup.chips > 0, `got ${markup.chips}`);

  // -------------------------------------------------------------------------
  // Test 3 — the artwork really reaches the page
  // -------------------------------------------------------------------------
  console.log('\n[3] the page artwork reaches the page');
  // The browser normalises a custom property that holds a url() into
  // `url("file:///…")`, so the file:// check looks INSIDE the value.
  check('the page carries the artwork URL',
    /file:\/\/\//.test(markup.bannerVar), markup.bannerVar || '(empty)');
  // The page wears the SHARED background — the same picture the 今日 page
  // wears — so the two must name the same file.
  const shared = pageBackground.active(null, db);
  check('the main process resolves the shared background', !!shared.current,
    JSON.stringify(shared.current));
  const sharedUrl = shared.current ? shared.current.url : '';
  check('the page wears the shared background',
    !!sharedUrl && markup.bannerVar.includes(sharedUrl),
    `page=${markup.bannerVar || '(empty)'} shared=${sharedUrl || '(none)'}`);
  // The computed background is the WASH over the artwork — two layers, so
  // the image must be one of them.
  check('the computed page background carries the artwork',
    markup.pageBg.includes('url(') && !!sharedUrl && markup.pageBg.includes(sharedUrl),
    markup.pageBg || '(none)');
  // The artwork is pinned to the VIEWPORT, so this page shows the same
  // composition of the picture as every other page that wears it.
  check('the page pins the artwork to the viewport',
    markup.pageAttachment === 'fixed, fixed', markup.pageAttachment);
  // The banner carries a local wash of its own but NOT the artwork — the
  // page behind it is what shows the picture, so the banner must not
  // paint it a second time (that would double-expose the picture).
  check('the banner does not paint the artwork a second time',
    !markup.bannerBg.includes('url(') || !markup.bannerBg.includes(sharedUrl),
    markup.bannerBg || '(none)');

  // The artwork must be reachable from the main process too — that is where
  // the file:// URL comes from. If the file is missing, the renderer would
  // show a broken (flat) page with no error anywhere.
  check('the shared background is a file:// URL',
    /^file:\/\//.test(sharedUrl), sharedUrl || 'n/a');
  check('the shared background file exists on disk',
    !!sharedUrl && fs.existsSync(fileURLToPath(sharedUrl)), sharedUrl || 'n/a');
  // And it is a real PNG the renderer can decode — a truncated file would
  // leave a bare page with no error anywhere.
  const decoded = await winMain.webContents.executeJavaScript(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
    img.src = ${JSON.stringify(sharedUrl)};
  })`);
  check('the page artwork decodes in the renderer',
    decoded.ok && decoded.w > 0, JSON.stringify(decoded));

  // -------------------------------------------------------------------------
  // Test 4 — the design CSS applies (computed styles, not just markup)
  // -------------------------------------------------------------------------
  console.log('\n[4] the design CSS applies to the rendered page');
  const computed = await winMain.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.cd-page');
    const card = document.querySelector('#cd-body .card');
    const h2 = document.querySelector('#cd-body .section-header h2');
    const chip = document.querySelector('#cd-body .time-chip');
    const icon = document.querySelector('#cd-body .cat-icon');
    const back = document.querySelector('.cd-back');
    const backIcon = document.querySelector('.cd-back .icon-arrow-left');
    const tab = document.querySelector('.cd-tab');
    const cs = (el) => el ? getComputedStyle(el) : null;
    const pageCs = cs(page);
    const cardCs = cs(card);
    const chipCs = cs(chip);
    const iconCs = cs(icon);
    const backCs = cs(back);
    const backIconCs = cs(backIcon);
    const tabCs = cs(tab);
    // The accent bar is a pseudo-element on the title, so it is read off
    // the ELEMENT — getComputedStyle wants an element, not a style object.
    const barCs = h2 ? getComputedStyle(h2, '::before') : null;
    // The alpha channel of an rgba() colour, as a number.
    const alphaOf = (c) => {
      const m = (c || '').match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const parts = m[1].split(',').map((s) => parseFloat(s));
      return parts.length === 4 ? parts[3] : 1;
    };
    return {
      cardBg: cardCs ? cardCs.backgroundColor : '',
      cardAlpha: cardCs ? alphaOf(cardCs.backgroundColor) : null,
      cardBlur: cardCs ? (cardCs.backdropFilter || cardCs.webkitBackdropFilter || '') : '',
      cardRadius: cardCs ? cardCs.borderRadius : '',
      cardShadow: cardCs ? cardCs.boxShadow : '',
      barColor: barCs ? barCs.backgroundColor : '',
      barWidth: barCs ? barCs.width : '',
      chipBg: chipCs ? chipCs.backgroundColor : '',
      chipRadius: chipCs ? chipCs.borderRadius : '',
      iconWidth: iconCs ? iconCs.width : '',
      iconRadius: iconCs ? iconCs.borderRadius : '',
      // The 返回 control shares the tab row with the tabs, so it must not
      // read as a smaller stray caption beside them.
      backFontSize: backCs ? backCs.fontSize : '',
      backIconSize: backIconCs ? backIconCs.width : '',
      tabFontSize: tabCs ? tabCs.fontSize : '',
      // The page must be FULL BLEED: it pulls itself out of the scroll
      // container's padding so the artwork reaches the window's edges.
      pageMarginLeft: pageCs ? pageCs.marginLeft : '',
      pageMarginTop: pageCs ? pageCs.marginTop : '',
    };
  })()`);
  // The cards are sheets of translucent paper laid over the artwork — an
  // opaque card would cut a hard edge across the picture.
  check('the cards are translucent (alpha < 1)',
    computed.cardAlpha !== null && computed.cardAlpha < 1,
    `${computed.cardBg} (alpha ${computed.cardAlpha})`);
  check('the cards blur the artwork behind them',
    /blur/.test(computed.cardBlur), computed.cardBlur);
  check('the cards use the large rounded radius',
    parseFloat(computed.cardRadius) >= 16, computed.cardRadius);
  check('the cards carry a soft shadow',
    computed.cardShadow && computed.cardShadow !== 'none', computed.cardShadow);
  check('the section title has the orange accent bar',
    computed.barColor.includes('233, 171, 133'), computed.barColor);
  check('the accent bar is a thin rule',
    parseFloat(computed.barWidth) <= 8, computed.barWidth);
  check('the date chip is tinted',
    computed.chipBg.includes('251, 230, 216'), computed.chipBg);
  check('the date chip is a pill',
    parseFloat(computed.chipRadius) >= 8, computed.chipRadius);
  check('the icon tile is the larger design tile',
    parseFloat(computed.iconWidth) >= 40, computed.iconWidth);
  check('the icon tile is rounded',
    parseFloat(computed.iconRadius) >= 10, computed.iconRadius);
  // The 返回 control shares the tab row with the tabs. It used to be set at
  // 13px — smaller than the 15px tabs — and read as a stray caption rather
  // than as a control, so the label must be at least as large as the tabs.
  check('the 返回 control is not smaller than the tabs',
    parseFloat(computed.backFontSize) >= parseFloat(computed.tabFontSize),
    `back ${computed.backFontSize} vs tab ${computed.tabFontSize}`);
  check('the 返回 chevron is scaled to the label',
    parseFloat(computed.backIconSize) >= 16, computed.backIconSize);
  // The page pulls itself out of the scroll container's padding, so the
  // artwork is edge to edge rather than floating in a padded box.
  check('the page is full bleed (negative margins)',
    parseFloat(computed.pageMarginLeft) < 0 && parseFloat(computed.pageMarginTop) < 0,
    `margin ${computed.pageMarginTop} ${computed.pageMarginLeft}`);

  // -------------------------------------------------------------------------
  // Test 5 — the artwork does not leak onto other pages
  // -------------------------------------------------------------------------
  console.log('\n[5] the artwork does not leak onto other pages');
  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 1200));
  const other = await winMain.webContents.executeJavaScript(`(() => ({
    page: !!document.querySelector('.cd-page'),
    banner: !!document.querySelector('.cd-banner'),
    bannerVar: getComputedStyle(document.documentElement)
      .getPropertyValue('--cd-banner-image').trim(),
  }))()`);
  check('the contact stylesheet does not leak onto 今日', !other.page);
  check('the banner markup is gone on 今日', !other.banner);
  check('no banner artwork is left on 今日', !other.bannerVar, other.bannerVar || '(empty)');

  // The shared page-background picker offers EVERY image in resources/ui —
  // there is no image claimed by one page any more, because the contact
  // detail page's header wears the same picture as everyone else.
  const todayIds = pageBackground.list(null).map((b) => b.id);
  check('the background picker offers the shipped artwork',
    todayIds.includes('today-background'), JSON.stringify(todayIds));
  check('the background picker offers every image in the folder',
    todayIds.length === uiArtwork.list(null).length,
    `${todayIds.length} vs ${uiArtwork.list(null).length}`);
  check('the background picker is not empty',
    todayIds.length > 0, JSON.stringify(todayIds));

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
