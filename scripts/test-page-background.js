// scripts/test-page-background.js — end-to-end check for the background
// artwork the 今日 / 联系人 / 提醒 / 工作事件 pages wear.
//
// What this guards against:
//
//   1. The artwork never shows up. The image lives in `resources/ui/` and
//      reaches the renderer as a `file://` URL from the main process — the
//      renderer can't read the filesystem, so the whole chain (scan →
//      resolve → IPC → CSS custom property) has to work or the page renders
//      bare.
//
//   2. The artwork leaks onto pages that don't wear it. The background is
//      applied to the shared `.content` scroll container, so without an
//      explicit teardown on route change every other page would inherit it.
//
//   3. A page that DOES wear it loses it. Several pages share one picture; a
//      route-matching bug that clears the background on the way to 提醒
//      would leave three of the four pages bare.
//
//   4. The contact DETAIL page wrongly inherits it. `/contacts` is a prefix
//      of `/contacts/:id`, and that page owns its own full-bleed banner —
//      a prefix match would put the list artwork behind it.
//
//   5. The picker can't turn the background off. "跟随默认" and "无背景" are
//      two different states, and the user must be able to reach both.
//
// This drives the REAL main window (src/index.html with the REAL preload)
// and the REAL IPC handlers, because the failure would be in the seam
// between them.
//
// Usage: node scripts/run-electron.js scripts/test-page-background.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

app.whenReady().then(async () => {
  console.log('page background end-to-end test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-pagebg-'));
  await db.open(path.join(dir, 'test.sqlite'));

  // The catalog is memoised, and the shipped artwork must be found in the
  // REAL resources/ui folder — that's the whole point of the feature.
  pageBackground.invalidate();
  const catalog = pageBackground.list(null);
  check('resources/ui holds at least one background image', catalog.length > 0,
    `found ${catalog.length}`);
  const shipped = catalog.find((b) => b.id === 'today-background');
  check('the shipped today-background.png is in the catalog', !!shipped);

  // The routes that wear the background. Kept in one place so the test and
  // the implementation can't disagree about which pages are covered.
  const BG_ROUTES = [
    '/today', '/contacts', '/reminders',
    '/card-life', '/card-life/stats',
  ];

  // Seed enough work events and contacts for their lists to need more than
  // one page. The reminders page already has rows (the auto-seeded
  // festivals), but a fresh DB has no contacts and no work events — and an
  // empty list legitimately has NO pager, so the pagination assertions
  // would pass vacuously.
  //
  // The rows go straight into the DB (the test drives the REAL preload and
  // the REAL IPC handlers, so the renderer sees them the way it sees the
  // user's own data).
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const seedContacts = 20;
  const seedWorkEvents = 20;
  for (let i = 0; i < seedContacts; i++) {
    db.run(
      `INSERT INTO contacts(id, name, relationship, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
      [`tc${i}`, `联系人${i}`, '朋友', now, now]);
  }
  for (let i = 0; i < seedWorkEvents; i++) {
    db.run(
      `INSERT INTO events(id, title, description, remind_kind, remind_date,
                          next_fire_at, active, category, created_at, updated_at)
       VALUES(?, ?, ?, 'one_time', ?, ?, 1, 'work', ?, ?)`,
      [`tw${i}`, `工作事项${i}`, `第 ${i} 件事`,
        '2026-12-01 10:00:00', '2026-12-01 10:00:00', now, now]);
  }

  let winMain = null;
  const queue = new scheduler.ReminderQueue();

  winMain = new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
      // The mood portrait on the 今日 page reads the pet's own picture;
      // this stub has no pet, so it reports none and the page falls back
      // to the mood emoji.
      getPortrait: () => null,
      isImported: () => false,
      getRootDir: () => '',
      rescan: () => {},
    },
  });

  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });
  winMain.webContents.on('render-process-gone', (_e, details) => {
    console.log('  [renderer gone]', JSON.stringify(details));
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));

  // The main window opens BEHIND the PIN lock, and body.locked hides #app
  // with display:none. A display:none subtree has no layout box, so every
  // height measurement below would read 0 — and the artwork's scale is
  // exactly what depends on the page's height, so it could not be checked
  // at all.
  //
  // The lock is a renderer-side class, so the test lifts it directly. This
  // is a harness shortcut, not a change to the app's security: the real
  // unlock path (api.app.verifyPin) is unaffected.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);
  await new Promise((r) => setTimeout(r, 200));
  const stillLocked = await winMain.webContents.executeJavaScript(`document.body.classList.contains('locked')`);
  check('the app shell is laid out (the PIN lock is lifted)', stillLocked === false);

  // Read the background state off the scroll container. One helper for every
  // page, so each assertion below is about the same four facts.
  const readBg = () => winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.content');
    return {
      hasClass: el.classList.contains('page-bg'),
      noArt: el.classList.contains('no-art'),
      image: el.style.getPropertyValue('--page-bg-image'),
      computed: getComputedStyle(el).backgroundImage,
      attachment: getComputedStyle(el).backgroundAttachment,
      // The CONTENT height is what used to scale the artwork differently on
      // each page — the taller the content, the bigger the picture. This is
      // the scrollHeight, not the container's own height: the container is
      // a fixed viewport-tall box, so its height is the same everywhere,
      // while the content behind it is what actually grew. See test 9.
      contentHeight: el.scrollHeight,
      containerHeight: el.getBoundingClientRect().height,
    };
  })()`);

  const goto = async (hash, wait = 500) => {
    await winMain.webContents.executeJavaScript(`location.hash = '${hash}'; true`);
    await new Promise((r) => setTimeout(r, wait));
  };

  // -------------------------------------------------------------------------
  // Test 1 — the 今日 page paints the artwork
  // -------------------------------------------------------------------------
  console.log('\n[1] the 今日 page paints the background');
  const onToday = await readBg();
  check('the content container has the page-bg class', onToday.hasClass);
  check('the page is not in the no-art state', !onToday.noArt);
  check('the background image is set', !!onToday.image, onToday.image);
  check('the URL is a file:// URL', /^url\("?file:\/\//.test(onToday.image), onToday.image);
  check('the computed background carries the image',
    onToday.computed.includes('file://'), onToday.computed);

  // -------------------------------------------------------------------------
  // Test 2 — every page that wears the background gets it
  // -------------------------------------------------------------------------
  console.log('\n[2] every page that wears the background gets it');
  for (const route of BG_ROUTES) {
    await goto('#' + route, 600);
    const bg = await readBg();
    check(`${route} has the page-bg class`, bg.hasClass);
    check(`${route} has the artwork image`, !!bg.image, bg.image);
    check(`${route} is not in the no-art state`, !bg.noArt);
    check(`${route} computes a file:// background`,
      bg.computed.includes('file://'), bg.computed);
  }

  // -------------------------------------------------------------------------
  // Test 3 — the artwork does not leak onto pages that don't wear it
  // -------------------------------------------------------------------------
  console.log('\n[3] the background does not leak onto other pages');
  for (const route of ['/events/memorial', '/tools', '/settings', '/export']) {
    await goto('#' + route, 600);
    const bg = await readBg();
    check(`${route} does not have the page-bg class`, !bg.hasClass);
    check(`${route} has no custom property`, !bg.image);
    check(`${route} computes no file:// background`,
      !bg.computed.includes('file://'), bg.computed);
  }

  // -------------------------------------------------------------------------
  // Test 4 — the contact DETAIL page does not inherit the list background
  // -------------------------------------------------------------------------
  // `/contacts` is a prefix of `/contacts/:id`, and the detail page paints the
  // shared artwork on its OWN full-bleed wrapper. A prefix match would put
  // the list artwork on the scroll container too, so the picture would be
  // painted twice and the container's padding would cut the outer copy off.
  console.log('\n[4] the contact detail page paints the artwork itself');
  await goto('#/contacts', 600);
  const listBg = await readBg();
  check('the contact LIST has the background', listBg.hasClass && !!listBg.image);

  // The detail page needs a contact to open, so the route is visited with a
  // bogus id: the page renders its "not found" state, but the *background*
  // decision happens in the router's onChange — before the page's own
  // render — so the teardown is observable either way.
  await goto('#/contacts/__no_such_contact__', 600);
  const detailBg = await readBg();
  check('the contact DETAIL does not have the page-bg class', !detailBg.hasClass);
  check('the contact DETAIL has no custom property', !detailBg.image);
  check('the contact DETAIL computes no file:// background',
    !detailBg.computed.includes('file://'), detailBg.computed);

  // -------------------------------------------------------------------------
  // Test 5 — coming back to a background page re-applies it
  // -------------------------------------------------------------------------
  console.log('\n[5] returning to a background page re-applies it');
  await goto('#/today', 600);
  const back = await readBg();
  check('returning to 今日 re-applies the background', back.hasClass && !!back.image);

  // -------------------------------------------------------------------------
  // Test 6 — the settings picker controls the background
  // -------------------------------------------------------------------------
  console.log('\n[6] the settings picker controls the background');
  // The picker lives in the 设置 page's 「页面背景」 section — the settings
  // page is split into a nav rail and one section at a time, so the bare
  // /settings route shows the default section and not this one.
  await goto('#/settings/background', 800);
  const picker = await winMain.webContents.executeJavaScript(`(() => {
    const sel = document.getElementById('page-bg-select');
    if (!sel) return null;
    return {
      options: Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent })),
      value: sel.value,
    };
  })()`);
  check('the settings page has a background picker', !!picker);
  if (picker) {
    check('the picker offers 跟随默认', picker.options.some((o) => o.text === '跟随默认'));
    check('the picker offers 无背景', picker.options.some((o) => o.text === '无背景'));
    check('the picker lists the shipped artwork',
      picker.options.some((o) => o.value === 'today-background'),
      JSON.stringify(picker.options.map((o) => o.value)));
  }

  // "无背景" — the user turns the artwork off.
  await winMain.webContents.executeJavaScript(`(async () => {
    const sel = document.getElementById('page-bg-select');
    const opt = Array.from(sel.options).find((o) => o.text === '无背景');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`);
  eq('the setting is stored as the none sentinel', db.getSetting(pageBackground.SETTING_KEY), pageBackground.NONE);

  // The "off" state has to reach EVERY page that wears the background, not
  // just the one the user happened to be on when they turned it off.
  for (const route of BG_ROUTES) {
    await goto('#' + route, 600);
    const bg = await readBg();
    check(`${route} is in the no-art state`, bg.noArt);
    check(`${route} has no image`, !bg.image);
  }

  // "跟随默认" — the user turns it back on.
  await goto('#/settings/background', 800);
  await winMain.webContents.executeJavaScript(`(async () => {
    const sel = document.getElementById('page-bg-select');
    const opt = Array.from(sel.options).find((o) => o.text === '跟随默认');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`);
  eq('the setting is cleared', db.getSetting(pageBackground.SETTING_KEY), '');

  await goto('#/today', 600);
  const onAgain = await readBg();
  check('the artwork is back', !onAgain.noArt && !!onAgain.image, onAgain.image);

  // -------------------------------------------------------------------------
  // Test 7 — the list pages wear the translucent card treatment
  // -------------------------------------------------------------------------
  // The rows over the artwork must be translucent sheets, not the app's
  // opaque white cards: an opaque card cuts a hard edge across the painting
  // and reads as a foreign panel pasted on top of it.
  console.log('\n[7] the list pages wear the translucent card treatment');
  for (const route of ['/contacts', '/reminders']) {
    await goto('#' + route, 800);
    const page = await winMain.webContents.executeJavaScript(`(() => {
      const wrapper = document.querySelector('.bg-page');
      // The row card, if the list has any rows. An empty list has none, so
      // the card's treatment is checked on a page that always has one.
      const el = document.querySelector('.bg-page .card, .bg-page .list-row');
      const out = { hasWrapper: !!wrapper };
      if (el) {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        // The alpha channel of an rgba() colour, as a number.
        const m = bg.match(/rgba?\\(([^)]+)\\)/);
        const parts = m ? m[1].split(',').map((s) => parseFloat(s)) : [];
        out.bg = bg;
        out.alpha = parts.length === 4 ? parts[3] : 1;
        out.blur = cs.backdropFilter || cs.webkitBackdropFilter || '';
      }
      return out;
    })()`);
    check(`${route} wraps its content in .bg-page`, page.hasWrapper);
    if (page.bg) {
      check(`${route}'s card is translucent (alpha < 1)`, page.alpha < 1,
        `${page.bg} (alpha ${page.alpha})`);
      check(`${route}'s card blurs the artwork behind it`,
        /blur/.test(page.blur), page.blur);
    }
  }

  // The 抽卡 page wears the artwork too, with its own translucent
  // treatment — it is a page of sheets of paper laid over the picture, the
  // same idea the 今日 page uses, so its cards must be translucent and
  // blurred rather than opaque panels pasted on the painting.
  console.log('\n[7b] the 抽卡 page wears the translucent treatment');
  await goto('#/card-life', 900);
  const clPage = await winMain.webContents.executeJavaScript(`(() => {
    const wrapper = document.querySelector('.cl-page');
    const el = document.querySelector('.cl-page .cl-rules-card, .cl-page .cl-deck');
    const out = { hasWrapper: !!wrapper };
    if (el) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const m = bg.match(/rgba?\\(([^)]+)\\)/);
      const parts = m ? m[1].split(',').map((s) => parseFloat(s)) : [];
      out.bg = bg;
      out.alpha = parts.length === 4 ? parts[3] : 1;
      out.blur = cs.backdropFilter || cs.webkitBackdropFilter || '';
    }
    return out;
  })()`);
  check('the 抽卡 page wraps its content in .cl-page', clPage.hasWrapper);
  if (clPage.bg) {
    check('the 抽卡 card is translucent (alpha < 1)', clPage.alpha < 1,
      `${clPage.bg} (alpha ${clPage.alpha})`);
    check('the 抽卡 card blurs the artwork behind it',
      /blur/.test(clPage.blur), clPage.blur);
  }

  // -------------------------------------------------------------------------
  // Test 8 — the routes the main process publishes match the renderer's
  // -------------------------------------------------------------------------
  // The renderer asks the main process which routes wear the artwork. If the
  // two lists drift apart, a page could silently stop wearing the picture.
  console.log('\n[8] the main process publishes the background routes');
  const viaIpc = await winMain.webContents.executeJavaScript(`(async () => {
    const info = await window.mp.pageBackground.get();
    return info.routes;
  })()`);
  check('the main process publishes the background routes', Array.isArray(viaIpc),
    JSON.stringify(viaIpc));
  if (Array.isArray(viaIpc)) {
    for (const route of BG_ROUTES) {
      check(`the published routes include ${route}`, viaIpc.includes(route));
    }
  }

  // -------------------------------------------------------------------------
  // Test 9 — every page shows the SAME composition of the artwork
  // -------------------------------------------------------------------------
  // The picture is scaled by background-size: cover, which measures against
  // the background positioning area. With background-attachment: local that
  // area is the scroll container's CONTENT box, whose height is the page's
  // full content height — so a LONGER page scaled the artwork UP and cropped
  // more of it away. The 提醒 page (1059px of content) zoomed the picture
  // 18% more than the 今日 page (898px), and the plant on the left of the
  // frame fell outside the crop entirely, even though both pages were using
  // the identical file.
  //
  // fixed measures against the viewport instead, so the scale and the crop
  // are the same everywhere: one artwork, one composition.
  console.log('\n[9] every page shows the same composition of the artwork');
  const heights = [];
  for (const route of BG_ROUTES) {
    await goto('#' + route, 800);
    const bg = await readBg();
    check(`${route} pins the artwork to the viewport`,
      bg.attachment === 'fixed, fixed', bg.attachment);
    heights.push({ route, height: bg.contentHeight });
  }
  // The pages really do have different heights — that is the condition that
  // broke the old local behaviour, so the test would pass vacuously if they
  // were all the same.
  const distinct = new Set(heights.map((h) => h.height));
  check('the pages have differing content heights (the condition that broke local)',
    distinct.size > 1, JSON.stringify(heights));
  check('every page has a measurable height', heights.every((h) => h.height > 0),
    JSON.stringify(heights));

  // -------------------------------------------------------------------------
  // Test 10 — the list pages are paginated
  // -------------------------------------------------------------------------
  // The list shows a fixed number of rows per page, so a long list never
  // runs past the bottom of the frame the artwork is painted in.
  //
  // Two pages share this behaviour — 提醒 and 联系人 — and
  // both get it from src/js/pager.js. The rows have to come from a
  // subtree of their own, or turning a page would rebuild the filter bar
  // above it.
  console.log('\n[10] the list pages are paginated');
  const PAGED_PAGES = [
    { route: '/reminders', list: '#reminders-list', label: '提醒' },
    { route: '/contacts', list: '#contacts-list', label: '联系人' },
  ];
  for (const page of PAGED_PAGES) {
    await goto('#' + page.route, 900);
    const info = await winMain.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('${page.list}');
      const p = el ? el.querySelector('.section-pager') : null;
      return {
        hasList: !!el,
        rows: el ? el.querySelectorAll('.list-row').length : 0,
        hasPager: !!p,
        text: p ? p.querySelector('.meta').textContent.trim() : '',
        prevDisabled: p ? p.querySelector('[data-action=prev]').disabled : null,
        nextDisabled: p ? p.querySelector('[data-action=next]').disabled : null,
        firstId: (el ? el.querySelector('.list-row') : null)?.dataset.id || '',
      };
    })()`);
    check(`${page.label}: the list lives in its own subtree`, info.hasList);
    check(`${page.label}: the list shows a bounded number of rows`,
      info.rows <= 8, String(info.rows));
    check(`${page.label}: the pager is present`, info.hasPager);
    if (info.hasPager) {
      check(`${page.label}: the pager counts the entries`,
        /共 \d+ 条/.test(info.text), info.text);
      check(`${page.label}: the previous button is disabled on the first page`,
        info.prevDisabled === true);
      check(`${page.label}: the next button is enabled on the first page`,
        info.nextDisabled === false);

      // Turning the page must actually swap the rows — a pager that
      // renders but does nothing would pass every check above.
      await winMain.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('${page.list}');
        const btn = el.querySelector('.section-page[data-action=next]');
        if (btn) btn.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      const page2 = await winMain.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('${page.list}');
        const p = el ? el.querySelector('.section-pager') : null;
        return {
          rows: el ? el.querySelectorAll('.list-row').length : 0,
          text: p ? p.querySelector('.meta').textContent.trim() : '',
          firstId: (el ? el.querySelector('.list-row') : null)?.dataset.id || '',
          prevDisabled: p ? p.querySelector('[data-action=prev]').disabled : null,
        };
      })()`);
      check(`${page.label}: the next page shows different rows`,
        page2.firstId !== '' && page2.firstId !== info.firstId,
        `page1=${info.firstId} page2=${page2.firstId}`);
      check(`${page.label}: the counter moved to page 2`,
        /^第 2 \//.test(page2.text), page2.text);
      check(`${page.label}: the previous button is enabled on page 2`,
        page2.prevDisabled === false);

      // ...and back again.
      await winMain.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('${page.list}');
        const btn = el.querySelector('.section-page[data-action=prev]');
        if (btn) btn.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      const back = await winMain.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('${page.list}');
        const p = el ? el.querySelector('.section-pager') : null;
        return {
          text: p ? p.querySelector('.meta').textContent.trim() : '',
          firstId: (el ? el.querySelector('.list-row') : null)?.dataset.id || '',
        };
      })()`);
      check(`${page.label}: the previous button returns to page 1`,
        /^第 1 \//.test(back.text), back.text);
      check(`${page.label}: going back restores the first rows`,
        back.firstId === info.firstId,
        `page1=${info.firstId} back=${back.firstId}`);
    }
  }
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
