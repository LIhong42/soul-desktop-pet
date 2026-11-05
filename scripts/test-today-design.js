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
const { PetRegistry } = require(path.join(ROOT, 'main', 'pet_registry.js'));

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

  // The REAL pet registry, so the 今日 page's mood portrait shows the
  // user's actual pet sprite. A stub would make the portrait silently
  // fall back to the mood emoji, and the portrait assertions below would
  // then be testing the fallback instead of the real thing.
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

  // The PIN gate sets `display: none` on #app — the router mounts the page
  // underneath it, but a hidden element has NO LAYOUT, so every
  // getBoundingClientRect() would read 0×0 and every "is this card the
  // right size" assertion would pass vacuously. The gate is a
  // renderer-side `body.locked` class, so dropping it reveals the app.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);
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
    // The app root's own size — see the layout guard below.
    appWidth: (document.getElementById('app') || {clientWidth: 0}).clientWidth,
    appHeight: (document.getElementById('app') || {clientHeight: 0}).clientHeight,
    hero: !!document.querySelector('.today-hero-title'),
    statusGrid: !!document.querySelector('.today-status-grid'),
    moodCard: !!document.querySelector('.today-mood-card'),
    moodPortrait: !!document.querySelector('.today-mood-portrait'),
    bondCard: !!document.querySelector('.today-bond-card'),
    tierPill: !!document.querySelector('.today-tier-pill'),
    bondNumber: !!document.querySelector('.today-bond-number b'),
    companionStats: document.querySelectorAll('.today-companion-cell').length,
    // The 陪伴状态 columns are plain stats now — the tinted icon chips that
    // used to lead each column were removed as part of the page's icon
    // cleanup, so the test asserts they stay gone.
    companionIcon: !!document.querySelector('.today-companion-icon'),
    sectionHeads: document.querySelectorAll('.today-section-head').length,
    weekday: (document.querySelector('.today-hero-weekday') || {}).textContent || '',
    heroDate: (document.querySelector('.today-hero-date') || {}).textContent || '',
    // The page's icon budget. Only the pet's mood portrait and the
    // per-reminder category chip may carry a glyph — the decorative
    // heading / panel / stat icons are gone, and this is what keeps
    // them from creeping back in.
    decorativeIcons: document.querySelectorAll(
      '.today-hero-emoji, .today-section-emoji, .today-panel-emoji, .today-companion-icon'
    ).length,
    moodGlyph: (document.querySelector('.today-mood-portrait') || {}).textContent || '',
    // The mood portrait is the pet's OWN picture (the first frame of its
    // default variant), not a mood emoji. The <img> must be present and
    // must actually have loaded — a broken src would leave the portrait
    // empty.
    portraitImg: (() => {
      const img = document.querySelector('.today-mood-portrait img.today-mood-image');
      if (!img) return null;
      return { src: img.getAttribute('src') || '', loaded: img.naturalWidth > 0 };
    })(),
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
  check('the 陪伴状态 columns have no icon chips', !markup.companionIcon);
  check('both section headings are rendered', markup.sectionHeads === 2,
    `got ${markup.sectionHeads}`);
  // The page must actually be LAID OUT. Every size assertion below reads a
  // bounding box, and a hidden element (the PIN gate sets `display: none`
  // on #app) has a box of 0×0 — which would make all of them pass
  // vacuously while proving nothing. So the layout is checked up front.
  check('the page is laid out, not hidden',
    markup.appWidth > 0 && markup.appHeight > 0,
    `#app is ${markup.appWidth}x${markup.appHeight}`);
  // The icon budget: the decorative icons are gone, but the mood portrait
  // keeps its glyph — that one carries meaning (the pet's mood), it isn't
  // decoration.
  check('no decorative icons are rendered', markup.decorativeIcons === 0,
    `got ${markup.decorativeIcons}`);
  // The portrait shows the pet's own picture rather than the mood emoji.
  check('the mood portrait shows the pet\'s own picture',
    !!markup.portraitImg, 'no .today-mood-image in the portrait');
  check('the portrait picture is a file:// URL',
    !!markup.portraitImg && /^file:\/\//.test(markup.portraitImg.src),
    markup.portraitImg ? markup.portraitImg.src : 'n/a');
  // `naturalWidth > 0` means the browser actually decoded the PNG — a
  // broken or missing file would leave the disc empty while the <img>
  // element still exists.
  check('the portrait picture actually loaded',
    !!markup.portraitImg && markup.portraitImg.loaded,
    markup.portraitImg ? `src=${markup.portraitImg.src}` : 'n/a');

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
      // The gutter on each side of the reading column. Centring means the
      // two gutters are EQUAL — the computed margin-left is a resolved
      // pixel value (the "auto" keyword is gone once the style is
      // computed), so the keyword cannot be checked directly.
      //
      // Both gutters are measured against the app's CONTENT box. The app
      // container is a scroll container, so its border box is WIDER than
      // its content box by the scrollbar's width — measuring the right
      // gutter against the border box would report a false asymmetry of
      // exactly the scrollbar width.
      gutterLeft: (() => {
        const app = document.getElementById('app');
        const cs = getComputedStyle(app);
        const left = app.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
        return page.getBoundingClientRect().left - left;
      })(),
      gutterRight: (() => {
        const app = document.getElementById('app');
        const cs = getComputedStyle(app);
        // clientWidth excludes the scrollbar; the content box's right
        // edge sits at the padding edge, inside the scrollbar.
        const right = app.getBoundingClientRect().left + app.clientWidth -
          parseFloat(cs.paddingRight);
        return right - page.getBoundingClientRect().right;
      })(),
      // The weekday is typeset like the date — same size, weight and ink.
      weekdaySize: weekdayCs.fontSize,
      weekdayWeight: weekdayCs.fontWeight,
      weekdayColor: weekdayCs.color,
      weekdayBg: weekdayCs.backgroundColor,
      dateSize: dateCs.fontSize,
      dateWeight: dateCs.fontWeight,
      dateColor: dateCs.color,
      // The card is a translucent sheet laid over the artwork, not an
      // opaque rectangle pasted on top of it. Read the alpha off the
      // computed background so a regression to an opaque card is caught.
      // An rgb() colour has no alpha component — that means fully opaque.
      cardAlpha: (() => {
        const bg = cardCs.backgroundColor;
        const m = /rgba?\(([^)]*)\)/.exec(bg);
        if (!m) return 1;
        const parts = m[1].split(',').map((s) => parseFloat(s));
        return parts.length === 4 ? parts[3] : 1;
      })(),
      cardBlur: cardCs.backdropFilter || cardCs.webkitBackdropFilter || '',
      listBlur: (() => {
        const el = document.querySelector('.today-reminders');
        const c = el ? getComputedStyle(el) : null;
        return c ? (c.backdropFilter || c.webkitBackdropFilter || '') : '';
      })(),
      // The portrait is the CHARACTER and nothing else — no disc, no tint,
      // no ring behind it. The picture's own transparent PNG is the whole
      // portrait, so the element behind it must stay fully transparent.
      portraitBg: (() => {
        const el = document.querySelector('.today-mood-portrait');
        const c = el ? getComputedStyle(el) : null;
        return c ? c.backgroundColor : '';
      })(),
      portraitBgImage: (() => {
        const el = document.querySelector('.today-mood-portrait');
        const c = el ? getComputedStyle(el) : null;
        return c ? (c.backgroundImage || 'none') : 'none';
      })(),
      portraitRadius: (() => {
        const el = document.querySelector('.today-mood-portrait');
        const c = el ? getComputedStyle(el) : null;
        return c ? c.borderRadius : '';
      })(),
      // The picture must FIT, not cover — "cover" crops a tall sprite to a
      // square and cuts the character's own silhouette into shape.
      portraitFit: (() => {
        const img = document.querySelector('.today-mood-portrait img.today-mood-image');
        const c = img ? getComputedStyle(img) : null;
        return c ? c.objectFit : '';
      })(),
      portraitBox: (() => {
        const el = document.querySelector('.today-mood-portrait');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })(),
      // The picture is drawn at its natural aspect ratio inside the box.
      //
      // The <img> ELEMENT's rect is the box, not the drawn picture — with
      // object-fit: contain the sprite is scaled to fit INSIDE that box and
      // the surplus is transparent padding. So the drawn size has to be
      // computed the way the browser computes it: scale the natural size
      // down until both axes fit, then check that the result still fits
      // inside the box and keeps the natural ratio.
      portraitDrawn: (() => {
        const img = document.querySelector('.today-mood-portrait img.today-mood-image');
        const el = document.querySelector('.today-mood-portrait');
        if (!img || !el || !img.naturalWidth) return null;
        const ir = img.getBoundingClientRect();
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        const scale = Math.min(ir.width / nw, ir.height / nh);
        const dw = nw * scale;
        const dh = nh * scale;
        return {
          // The size the sprite is actually painted at.
          drawnW: Math.round(dw),
          drawnH: Math.round(dh),
          boxW: Math.round(ir.width),
          boxH: Math.round(ir.height),
          ratio: dw / dh,
          naturalRatio: nw / nh,
          // The picture must FIT INSIDE the box — nothing is cropped off.
          overflows: dw > ir.width + 1 || dh > ir.height + 1,
          // And it must not be squeezed: the painted size keeps the
          // natural ratio, so the character is not distorted.
          stretched: Math.abs((dw / dh) - (nw / nh)) > 0.02,
        };
      })(),
    };
  })()`);
  check('the mood card uses the large rounded radius', parseFloat(computed.radius) >= 18,
    computed.radius);
  check('the mood card uses the warm paper background',
    computed.cardBg.includes('253') || computed.cardBg.includes('255'),
    computed.cardBg);
  // The card must stay translucent — an opaque card cuts a hard edge
  // across the artwork and reads as a pasted-on UI panel.
  check('the mood card is translucent', computed.cardAlpha < 1,
    `alpha=${computed.cardAlpha} bg=${computed.cardBg}`);
  check('the mood card blurs the artwork behind it',
    /blur/.test(computed.cardBlur), computed.cardBlur);
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
    Math.abs(computed.gutterLeft - computed.gutterRight) <= 2,
    `left=${Math.round(computed.gutterLeft)} right=${Math.round(computed.gutterRight)} ` +
    `marginLeft=${computed.marginLeft}`);
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

  // ---- the portrait itself ----
  // The portrait is the CHARACTER alone: no disc, no tint, no ring. A
  // painted disc behind the picture would repaint the artwork the user
  // installed, which is exactly what the portrait is supposed to show.
  check('the portrait has no painted disc behind it',
    computed.portraitBg === 'rgba(0, 0, 0, 0)' ||
      computed.portraitBg === 'transparent',
    computed.portraitBg);
  check('the portrait has no gradient behind it',
    computed.portraitBgImage === 'none', computed.portraitBgImage);
  check('the portrait is not a circle',
    computed.portraitRadius === '0px' || computed.portraitRadius === '',
    computed.portraitRadius);
  // The picture must FIT rather than cover — "cover" crops a tall sprite
  // to a square and cuts the character's silhouette into shape.
  check('the portrait picture fits instead of covering',
    computed.portraitFit === 'contain', computed.portraitFit);
  check('the portrait box is taller than it is wide',
    !!computed.portraitBox && computed.portraitBox.h > computed.portraitBox.w,
    computed.portraitBox ? `${computed.portraitBox.w}x${computed.portraitBox.h}` : 'n/a');
  // The whole character is visible: the painted picture fits inside the
  // box, so nothing is cropped off the top, the bottom or the sides.
  check('the whole character fits inside the portrait box',
    !!computed.portraitDrawn && !computed.portraitDrawn.overflows,
    computed.portraitDrawn
      ? `drawn=${computed.portraitDrawn.drawnW}x${computed.portraitDrawn.drawnH} ` +
        `box=${computed.portraitDrawn.boxW}x${computed.portraitDrawn.boxH}`
      : 'n/a');
  // And it is not squeezed: the painted picture keeps the sprite's own
  // aspect ratio, so the character is not distorted.
  check('the portrait picture is not stretched',
    !!computed.portraitDrawn && !computed.portraitDrawn.stretched,
    computed.portraitDrawn
      ? `drawn=${computed.portraitDrawn.ratio.toFixed(3)} natural=${computed.portraitDrawn.naturalRatio.toFixed(3)}`
      : 'n/a');
  // The character must actually be BIG enough to read as a portrait — a
  // picture scaled down to a stamp is as useless as a cropped one.
  check('the character is drawn large enough to see',
    !!computed.portraitDrawn && computed.portraitDrawn.drawnH >= 100,
    computed.portraitDrawn
      ? `drawn=${computed.portraitDrawn.drawnW}x${computed.portraitDrawn.drawnH}`
      : 'n/a');

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
  // Test 6 — switching the active pet swaps the portrait
  // -------------------------------------------------------------------------
  console.log('\n[6] a pet switch swaps the mood portrait');
  const portraitBefore = await winMain.webContents.executeJavaScript(`(() => {
    const img = document.querySelector('#pet-status .today-mood-image');
    return img ? img.getAttribute('src') : '';
  })()`);

  // Switch to the OTHER installed pet, then fire the same event the main
  // process fires on a pet switch. The portrait must end up pointing at the
  // new pet's sprite — and it must be a DIFFERENT file, or the handler
  // didn't actually re-fetch anything.
  //
  // The "other" pet is picked by comparing each pet's OWN resolved
  // portrait against the one currently on the page — not by matching the
  // pet's id against the URL, because a pet's id can be a substring of
  // its own file path (the built-in pet's id is "VioletMoon-default"
  // while its folder is "default").
  const pets = petRegistry.list();
  const other = pets.find((p) => petRegistry.getPortrait(p.id) !== portraitBefore);
  if (!other) {
    console.log('  --   no second pet with a distinct portrait; skipping the swap check');
  } else {
    db.setSetting('pet_id', other.id);
    winMain.webContents.send('pet:pet-changed', { petId: other.id });
    await new Promise((r) => setTimeout(r, 700));

    const portraitAfter = await winMain.webContents.executeJavaScript(`(() => {
      const img = document.querySelector('#pet-status .today-mood-image');
      return img ? img.getAttribute('src') : '';
    })()`);

    check('the portrait still shows a picture after the switch',
      portraitAfter.startsWith('file://'), portraitAfter || '(no image)');
    check('the portrait points at the NEW pet',
      portraitAfter === petRegistry.getPortrait(other.id),
      `after=${portraitAfter} expected=${petRegistry.getPortrait(other.id)}`);
  }

  // -------------------------------------------------------------------------
  // Test 7 — the mood is carried by the portrait's BRIGHTNESS
  // -------------------------------------------------------------------------
  console.log('\n[7] the mood is expressed by the portrait\'s brightness');
  // The picture keeps its own colours in every mood; only the light on it
  // changes. So the test reads the computed `filter` for a happy mood and
  // a sad one and checks that the brightness differs, that the sad pet is
  // the dimmer one, and that neither one is tinted by a hue.
  const moodFilter = await winMain.webContents.executeJavaScript(`(async () => {
    const el = document.querySelector('#pet-status .today-mood-portrait');
    const card = document.querySelector('#pet-status .today-mood-card');
    if (!el || !card) return null;
    const read = async (mood) => {
      card.setAttribute('data-mood', mood);
      // Force a style recalc so the new filter is reflected immediately.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return getComputedStyle(el).filter || '';
    };
    const happy = await read('festive');
    const sad = await read('sad');
    const neutral = await read('content');
    return { happy, sad, neutral };
  })()`);

  const brightnessOf = (f) => {
    const m = /brightness\(\s*([\d.]+)/.exec(f || '');
    return m ? parseFloat(m[1]) : null;
  };
  check('the portrait filter can be read', !!moodFilter);
  if (moodFilter) {
    const bHappy = brightnessOf(moodFilter.happy);
    const bSad = brightnessOf(moodFilter.sad);
    const bNeutral = brightnessOf(moodFilter.neutral);
    check('a happy mood brightens the portrait', bHappy !== null && bHappy >= 1,
      moodFilter.happy);
    check('a sad mood dims the portrait', bSad !== null && bSad < 1,
      moodFilter.sad);
    check('a sad pet is dimmer than a happy one',
      bHappy !== null && bSad !== null && bSad < bHappy,
      `sad=${bSad} happy=${bHappy}`);
    check('a neutral mood sits between the two',
      bNeutral !== null && bSad < bNeutral && bNeutral < bHappy,
      `sad=${bSad} neutral=${bNeutral} happy=${bHappy}`);
    // No hue filter — the artwork keeps its own colours.
    check('the portrait filter carries no hue tint',
      !/hue-rotate|sepia/.test(moodFilter.happy + moodFilter.sad),
      `${moodFilter.happy} | ${moodFilter.sad}`);
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
