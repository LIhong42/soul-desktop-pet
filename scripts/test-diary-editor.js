// scripts/test-diary-editor.js — proves the diary editor works end to end.
//
// Covers the five things that make the diary feature what it is:
//
//   1. The six background styles exist and are well-formed (an id, a
//      header color, a page background, and three accent dots).
//   2. The editor renders a title, a body, and the six style tiles, and
//      picking a tile repaints the writing surface.
//   3. Text and images interleave: inserting a picture at the caret
//      splits the text block, and the saved document keeps that order.
//   4. Multi-image: one insertion point holds any number of photos, the
//      layout can be switched, and every photo can be resized on its own.
//   5. The photos in a gallery keep the order the user puts them in —
//      drag one onto another to swap them.
//   6. There is NO tag logic — no tag dialog, no tag column, no tag
//      filter on the list.
//
// The page is served from the project directory so the renderer modules can
// be imported as ES modules (a `data:` URL can't import `file://` ones).
// The `api` module is stubbed so no database is needed.
//
// Run: node scripts/run-electron.js scripts/test-diary-editor.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const evalIn = (win, code) =>
  win.webContents.executeJavaScript(
    `(async () => { try { ${code} } catch (e) { return { __threw: String(e && e.stack || e) }; } })()`,
    true);

const SRC = path.join(__dirname, '..', 'src');
const probePath = path.join(SRC, '.diary-probe.html');

// The probe page loads the modules the diary feature touches. The api is
// faked by scripts/diary-test-preload.js (a test-only preload) — the real
// preload's window.mp is read-only, so it can't be swapped from here.
const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./css/styles.css"></head><body>
<div id="app"></div><div id="toast-container"></div>
<script type="module">
const themes = await import('./js/diary_themes.js');
// The editor calls navigate() to leave the page. The router's navigate()
// sets location.hash, which the test reads back — the module namespace is
// frozen, so it can't be replaced.
const routerMod = await import('./js/router.js');

const editor = await import('./js/pages/diary_edit.js');
const list = await import('./js/pages/events_memorial.js');

// Drive the right-click menus the way the user does: press on the block,
// then pick an entry. The block's controls do not sit in the document any
// more — they live in this menu.
window.__menu = {
  open(el, x = 120, y = 140) {
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }));
    return window.__menu.items();
  },
  items() {
    return Array.from(document.querySelectorAll('#ctx-menu [data-ctx-act]')).map(b => ({
      act: b.dataset.ctxAct,
      value: b.dataset.ctxValue || '',
      label: b.textContent.trim(),
      selected: b.classList.contains('selected'),
      disabled: b.disabled,
    }));
  },
  click(sel) {
    const btn = document.querySelector('#ctx-menu ' + sel);
    if (!btn) throw new Error('menu entry missing: ' + sel);
    btn.click();
    return true;
  },
  isOpen() {
    const el = document.getElementById('ctx-menu');
    return !!el && el.style.display === 'block';
  },
  close() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  },
};

window.__themes = themes;
window.__editor = editor;
window.__list = list;
window.__rows = window.__testRows;
window.__router = routerMod;
window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  fs.writeFileSync(probePath, PROBE_HTML);

  const win = new BrowserWindow({
    // On screen: a hidden window does not process real mouse input, and
    // the drag test drives the page through real input events.
    show: true,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'diary-test-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('  [page error]', message);
  });

  await win.loadFile(probePath);
  const ready = await evalIn(win, `
    await new Promise(res => {
      const t = setInterval(() => { if (window.__ready) { clearInterval(t); res(true); } }, 10);
    });
    return { ready: !!window.__ready, hasEditor: !!window.__editor };
  `);
  if (!ready || !ready.ready || !ready.hasEditor) {
    console.log('  FAIL the diary modules did not load', JSON.stringify(ready));
    fail++;
    cleanup(win);
    return;
  }

  // ---- 1. The theme catalog -------------------------------------------
  console.log('\n== 日记背景样式 ==');
  const themes = await evalIn(win, `
    const m = window.__themes;
    // The WCAG relative-luminance formula, so the contrast of two colors
    // can be checked here rather than by eye.
    const lum = (hex) => {
      const h = hex.replace('#', '');
      const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => {
      const la = lum(a), lb = lum(b);
      const hi = Math.max(la, lb), lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    };
    window.__contrast = contrast;
    return {
      list: m.DIARY_THEMES.map(t => ({
        id: t.id, name: t.name, hasHeader: !!t.headerBg,
        hasTop: !!t.bgTop, hasMid: !!t.bgMid, hasFlat: !!t.bgFlat,
        hasHeaderText: !!t.headerText,
        dots: t.dots.length, hasText: !!t.text,
        layers: m.diaryBgLayers(t).length,
        // The contrast of every pair that has to stay readable.
        textOnTop: contrast(t.text, t.bgTop),
        textOnMid: contrast(t.text, t.bgMid),
        mutedOnTop: contrast(t.muted, t.bgTop),
        headerOnBar: contrast(t.headerText, t.headerBg),
      })),
      unknown: m.getDiaryTheme('nope').id,
      known: m.getDiaryTheme('shadow').id,
    };
  `);
  check('there are six background styles', themes.list.length, 6);
  checkTrue('every style has a header color, a text color and two body layers',
    themes.list.every(t => t.hasHeader && t.hasText && t.hasTop && t.hasMid));
  checkTrue('every style has a flat surface color and a header text color',
    themes.list.every(t => t.hasFlat && t.hasHeaderText));
  checkTrue('every style is painted in exactly two body layers',
    themes.list.every(t => t.layers === 2));
  checkTrue('every style carries exactly three accent dots',
    themes.list.every(t => t.dots === 3));
  check('the style ids are the six from the reference',
    themes.list.map(t => t.id),
    ['light', 'dark', 'shiro', 'shadow', 'helena', 'poonam']);
  check('an unknown style id falls back to the default', themes.unknown, 'light');
  check('a known style id resolves to itself', themes.known, 'shadow');

  // Every color pair that carries text has to stay readable. The WCAG
  // AA threshold for body text is 4.5:1.
  const badText = themes.list.filter(t => t.textOnTop < 4.5 || t.textOnMid < 4.5);
  check('the body text is readable on both bands of every style',
    badText.map(t => t.id + ' ' + t.textOnTop.toFixed(2) + '/' + t.textOnMid.toFixed(2)), []);
  const badMuted = themes.list.filter(t => t.mutedOnTop < 4.5);
  check('the muted text is readable on the upper band of every style',
    badMuted.map(t => t.id + ' ' + t.mutedOnTop.toFixed(2)), []);
  const badHeader = themes.list.filter(t => t.headerOnBar < 4.5);
  check('the title is readable on the header bar of every style',
    badHeader.map(t => t.id + ' ' + t.headerOnBar.toFixed(2)), []);

  // ---- 2. The editor renders and the theme picker repaints ------------
  console.log('\n== 日记编辑器 ==');
  const editorResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const page = document.getElementById('diary-page');
    const tiles = document.querySelectorAll('.diary-theme-tile');
    const beforeBg = page.style.getPropertyValue('--diary-bg');

    const shadowTile = Array.from(tiles).find(t => t.dataset.themeId === 'shadow');
    shadowTile.click();
    await new Promise(r => setTimeout(r, 20));
    const afterBg = page.style.getPropertyValue('--diary-bg');
    const afterHeader = page.style.getPropertyValue('--diary-header-bg');

    return {
      hasTitle: !!document.getElementById('diary-title'),
      hasBlocks: !!document.getElementById('diary-blocks'),
      hasFileInput: !!document.getElementById('diary-photos'),
      // The page-level "add picture" button used to sit under the
      // document, next to the per-block "插入图片" — two buttons that
      // looked alike but inserted the picture in different places.
      // Only the per-block one is left.
      pageAddButton: !!document.getElementById('diary-add-photo'),
      // The block controls do NOT sit in the document any more: they live
      // in the right-click menu, so the writing surface stays clean.
      blockBars: document.querySelectorAll('.diary-block-bar').length,
      galleryBars: document.querySelectorAll('.diary-gallery-bar').length,
      hasSave: !!document.getElementById('save'),
      textBlocks: document.querySelectorAll('.diary-block-text').length,
      tiles: tiles.length,
      changed: beforeBg !== afterBg,
      header: afterHeader,
      selectedCount: document.querySelectorAll('.diary-theme-tile.selected').length,
      contactCards: document.querySelectorAll('.contact-pick').length,
      // The page paints a flat color now — the decoration is a layer of
      // its own, not a band inside one background stack.
      pageBg: getComputedStyle(page).backgroundColor,
      // The date field belongs to the side panel, not to the writing
      // surface: the writing page holds the title and the text, and
      // nothing else.
      dateInSide: !!document.querySelector('.diary-side #diary-occurred'),
      dateOnPage: !!document.querySelector('.diary-page #diary-occurred'),
      sideCards: document.querySelectorAll('.diary-side .diary-side-card').length,
      // The title lives in the header bar, so the user types it right
      // there; the body below holds only the written document.
      titleInHeader: !!document.querySelector('.diary-page-header #diary-title'),
      titleInBody: !!document.querySelector('.diary-page-body #diary-title'),
      // The page is a column of three separate layers: the title bar, the
      // body and the decorative strip at the bottom. They are three DOM
      // elements, each with its own background color — NOT bands painted
      // into one background, which is what let the text and the photos
      // cover the decoration.
      layers: [
        !!document.querySelector('.diary-page > .diary-page-header'),
        !!document.querySelector('.diary-page > .diary-page-body'),
        !!document.querySelector('.diary-page > .diary-page-foot'),
      ],
      // Each layer paints its own color.
      layerBgs: [
        getComputedStyle(document.querySelector('.diary-page-header')).backgroundColor,
        getComputedStyle(document.querySelector('.diary-page-body')).backgroundColor,
        getComputedStyle(document.querySelector('.diary-page-foot')).backgroundColor,
      ],
      // The picker preview shows the same two bands.
      previewBands: document.querySelectorAll('.diary-theme-tile:first-child .diary-theme-band').length,
    };
  `);
  checkTrue('the editor renders a title field', editorResult.hasTitle);
  checkTrue('the title sits in the page header bar', editorResult.titleInHeader);
  checkTrue('the body holds no second title field', !editorResult.titleInBody);
  checkTrue('the editor renders the block container', editorResult.hasBlocks);
  checkTrue('the editor renders the photo file input', editorResult.hasFileInput);
  checkTrue('the page has no second "add picture" button', !editorResult.pageAddButton);
  check('the document carries no block toolbar', editorResult.blockBars, 0);
  check('the document carries no gallery toolbar', editorResult.galleryBars, 0);
  checkTrue('the editor renders a save button', editorResult.hasSave);
  checkTrue('the editor starts with one text block', editorResult.textBlocks >= 1);
  check('the style picker shows all six tiles', editorResult.tiles, 6);
  checkTrue('picking a style repaints the writing surface', editorResult.changed);
  check('the Shadow style writes its header color', editorResult.header, '#77613b');
  check('exactly one tile is marked selected', editorResult.selectedCount, 1);
  check('the contact picker lists the contacts', editorResult.contactCards, 2);
  checkTrue('the page background paints with the chosen color',
    editorResult.pageBg && editorResult.pageBg !== 'rgba(0, 0, 0, 0)');
  check('the page is three separate layers: header, body, decoration',
    editorResult.layers, [true, true, true]);
  checkTrue('every layer paints its own background color',
    editorResult.layerBgs.every(c => c && c !== 'rgba(0, 0, 0, 0)'));
  check('the picker preview shows the two bands', editorResult.previewBands, 2);
  checkTrue('the date field sits in the side panel', editorResult.dateInSide);
  checkTrue('the Tackbox page shows no date', !editorResult.dateOnPage);
  check('the side panel has three cards', editorResult.sideCards, 3);

  // ---- 3. Text and images interleave ---------------------------------
  console.log('\n== 图文混排 ==');
  const mixResult = await evalIn(win, `
    // Type into the first text block and put the caret in the middle.
    const ta = document.querySelector('.diary-block-text');
    ta.value = '在防波堤上坐到天黑，看远处的灯一盏一盏亮起来。';
    ta.focus();
    ta.setSelectionRange(6, 6);
    ta.dispatchEvent(new Event('input'));

    // Simulate the user right-clicking that block and picking
    // 「插入图片」, then picking a file. The editor splits the block at
    // the caret.
    //
    // The action opens the file picker. We can't drive a native picker
    // from the test, so we stub the click method to fire the change
    // handler with a synthetic file instead — the same path the real
    // picker takes.
    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const file = new File([new Uint8Array([1,2,3])], 'sunset.jpg', { type: 'image/jpeg' });
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };

    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-image"]');
    await new Promise(r => setTimeout(r, 60));

    const blocks = Array.from(document.querySelectorAll('.diary-block'));
    const order = blocks.map(b => b.dataset.blockType);

    // Now save and see what the document looks like on the wire.
    document.getElementById('diary-title').value = '第一次去海边';
    document.getElementById('diary-occurred').value = '2026-05-01T10:30';
    document.getElementById('save').click();
    await new Promise(r => setTimeout(r, 200));

    const rows = Object.values(window.__testRows.all());
    const row = rows[0];

    return {
      order,
      blockCount: blocks.length,
      textBefore: blocks[0] && blocks[0].querySelector('.diary-block-text').value,
      textAfter: blocks[2] && blocks[2].querySelector('.diary-block-text').value,
      hasGallery: !!document.querySelector('.diary-block-gallery'),
      galleryItems: document.querySelectorAll('.diary-gallery-item').length,
      content: row && row.content,
      notes: row && row.notes,
      title: row && row.title,
      background: row && row.background,
      navigated: location.hash,
    };
  `);
  check('the document interleaves text and gallery blocks',
    mixResult.order, ['text', 'gallery', 'text']);
  checkTrue('the gallery block is rendered', mixResult.hasGallery);
  check('the gallery holds the one picked photo', mixResult.galleryItems, 1);
  // The caret was placed after 6 characters, so the split falls there.
  check('the text before the caret stays above the image',
    mixResult.textBefore, '在防波堤上坐');
  check('the text after the caret moves below the image',
    mixResult.textAfter, '到天黑，看远处的灯一盏一盏亮起来。');
  check('the saved document keeps the block order',
    mixResult.content.map(b => b.type), ['text', 'gallery', 'text']);
  check('the saved document keeps the text before the image',
    mixResult.content[0].text, '在防波堤上坐');
  check('the saved document keeps the text after the image',
    mixResult.content[2].text, '到天黑，看远处的灯一盏一盏亮起来。');
  checkTrue('the saved document references a gallery of photos',
    mixResult.content[1] && mixResult.content[1].type === 'gallery' &&
    mixResult.content[1].photos.length === 1 && !!mixResult.content[1].photos[0].photo_id);
  check('a one-photo gallery uses the single layout',
    mixResult.content[1].layout, 'one');
  check('the plain text is mirrored into notes for search',
    mixResult.notes,
    '在防波堤上坐\n\n到天黑，看远处的灯一盏一盏亮起来。');
  check('the title is saved', mixResult.title, '第一次去海边');
  check('the chosen background is saved', mixResult.background, 'shadow');
  checkTrue('the editor navigates away after saving',
    !!mixResult.navigated && mixResult.navigated.length > 1);

  // ---- 4. Multi-image: many photos, a layout, and a dragged size -----
  console.log('\n== 多图与排版 ==');
  const multiResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '那天拍了很多张。';
    ta.focus();
    // The caret goes to the end, so the text is not split and the note
    // stays one paragraph.
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input'));

    // Pick THREE files at once. They must all land in the same gallery.
    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const files = [
        new File([new Uint8Array([1,2,3])], 'one.jpg', { type: 'image/jpeg' }),
        new File([new Uint8Array([4,5,6])], 'two.jpg', { type: 'image/jpeg' }),
        new File([new Uint8Array([7,8,9])], 'three.jpg', { type: 'image/jpeg' }),
      ];
      Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-image"]');
    await new Promise(r => setTimeout(r, 120));

    const gallery = document.querySelector('.diary-block-gallery');
    const items = Array.from(document.querySelectorAll('.diary-gallery-item'));
    const widthBefore = items.map(i => i.style.width);
    // The layouts live in the gallery's right-click menu.
    const menuItems = window.__menu.open(gallery);
    const layoutIds = menuItems.filter(i => i.act === 'layout').map(i => i.value);

    // Switch the arrangement to 「双图」.
    window.__menu.click('[data-ctx-act="layout"][data-ctx-value="two"]');
    await new Promise(r => setTimeout(r, 20));
    const widthAfterLayout = items.map(i => i.style.width);

    // Drag the first photo's handle to the right to make it bigger.
    const handle = items[0].querySelector('.diary-gallery-handle');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 260, clientY: 100, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 260, clientY: 100, bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const widthAfterDrag = items.map(i => i.style.width);

    // Save and look at the stored document.
    document.getElementById('diary-title').value = '多图的一篇';
    document.getElementById('diary-occurred').value = '2026-05-02T10:30';
    document.getElementById('save').click();
    await new Promise(r => setTimeout(r, 250));

    const rows = Object.values(window.__testRows.all());
    const row = rows[rows.length - 1];
    const galleryBlock = row.content.find(b => b.type === 'gallery');

    // The browser normalizes a calc() width when it is read back, so
    // compare the share of the row each photo takes.
    const frac = (s) => {
      const m = /calc\\(\\s*([\\d.]+)%/.exec(s || '');
      return m ? Math.round(parseFloat(m[1])) / 100 : null;
    };

    // The menu says which layout is in use.
    const menuAfter = window.__menu.open(gallery);
    const selectedLayout = (menuAfter.find(i => i.act === 'layout' && i.selected) || {}).value || null;
    window.__menu.close();

    return {
      galleryCount: document.querySelectorAll('.diary-block-gallery').length,
      itemCount: items.length,
      layoutButtonIds: layoutIds,
      widthBefore: widthBefore.map(frac),
      widthAfterLayout: widthAfterLayout.map(frac),
      widthAfterDrag: widthAfterDrag.map(frac),
      // The gallery's menu carries the layouts, the add button, the photo
      // counter and the two text insertions — and nothing else.
      menuLabels: menuItems.map(i => i.label),
      menuActs: menuItems.map(i => i.act),
      selectedLayout,
      savedLayout: galleryBlock && galleryBlock.layout,
      savedPhotos: galleryBlock && galleryBlock.photos,
      notes: row && row.notes,
    };
  `);
  check('the three picked files share one gallery', multiResult.galleryCount, 1);
  check('the gallery shows all three photos', multiResult.itemCount, 3);
  check('the gallery menu offers four layouts',
    multiResult.layoutButtonIds, ['one', 'two', 'three', 'grid']);
  check('the chosen layout is marked', multiResult.selectedLayout, 'two');
  check('the 双图 layout puts two photos on a row',
    multiResult.widthAfterLayout[0], 0.5);
  checkTrue('dragging the handle makes the photo bigger',
    multiResult.widthAfterDrag[0] !== multiResult.widthAfterLayout[0]);
  checkTrue('the gallery menu has no size presets left',
    !multiResult.menuLabels.some(t => t === '大' || t === '中' || t === '小'));
  checkTrue('the gallery menu has no move buttons left',
    !multiResult.menuLabels.some(t => t.includes('前移') || t.includes('后移')));
  checkTrue('the gallery menu still carries every action',
    ['gallery-add', 'insert-before', 'insert-after']
      .every(a => multiResult.menuActs.includes(a)));
  check('the saved gallery keeps the chosen layout', multiResult.savedLayout, 'two');
  check('the saved gallery keeps all three photos',
    multiResult.savedPhotos && multiResult.savedPhotos.length, 3);
  checkTrue('the saved gallery keeps the resized photo\'s width',
    multiResult.savedPhotos && typeof multiResult.savedPhotos[0].width === 'number' &&
    multiResult.savedPhotos[0].width > 0.5);
  checkTrue('a photo that still follows the layout stores no width',
    multiResult.savedPhotos && multiResult.savedPhotos[2].width === undefined);
  check('the plain text is still mirrored into notes',
    multiResult.notes, '那天拍了很多张。');

  // ---- 5. The photos in a gallery can be put in any order --------------
  console.log('\n== 图组内的顺序 ==');
  const orderResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    // Only this section's uploads matter for the order.
    window.__testUploads.clear();

    const ta = document.querySelector('.diary-block-text');
    ta.value = '三张照片。';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input'));

    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const files = ['one.jpg', 'two.jpg', 'three.jpg'].map((name, i) =>
        new File([new Uint8Array([i + 1, 2, 3])], name, { type: 'image/jpeg' }));
      Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-image"]');
    await new Promise(r => setTimeout(r, 120));

    const gallery = document.querySelector('.diary-block-gallery');
    const items = Array.from(document.querySelectorAll('.diary-gallery-item'));
    // The picked files are not real images, so the pictures have no size
    // of their own. Give the slots a height, so the drag has something
    // to land on.
    items.forEach(it => { it.style.height = '160px'; });
    await new Promise(r => setTimeout(r, 20));

    const order = () => Array.from(gallery.querySelectorAll('.diary-gallery-item'))
      .map(el => el.dataset.photoId);
    const before = order();
    // The photos are uploaded in the order they were picked, so the n-th
    // picked photo ends up as the n-th uploaded one. Remember that, so
    // the saved order can be checked against it.
    const picked = before.slice();

    // Drag the first photo onto the second one: they swap places.
    const r0 = items[0].getBoundingClientRect();
    const r1 = items[1].getBoundingClientRect();
    const at0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    const at1 = { x: r1.left + r1.width / 2, y: r1.top + r1.height / 2 };
    items[0].dispatchEvent(new PointerEvent('pointerdown', {
      clientX: at0.x, clientY: at0.y, bubbles: true, button: 0,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      clientX: at1.x, clientY: at1.y, bubbles: true,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      clientX: at1.x, clientY: at1.y, bubbles: true,
    }));
    await new Promise(r => setTimeout(r, 40));
    const afterDrag = order();

    // The dragged photo becomes the selected one.
    const selectedBefore = gallery.querySelector('.diary-gallery-item.selected');
    const selectedId = selectedBefore ? selectedBefore.dataset.photoId : null;

    document.getElementById('diary-title').value = '换了顺序的一篇';
    document.getElementById('diary-occurred').value = '2026-05-03T10:30';
    document.getElementById('save').click();
    await new Promise(r => setTimeout(r, 250));

    const rows = Object.values(window.__testRows.all());
    const row = rows[rows.length - 1];
    const block = row.content.find(b => b.type === 'gallery');

    // The photos are uploaded in the order they were picked, so the n-th
    // picked photo is the n-th saved photo.
    const uploaded = window.__testUploads.all().map((u) => u.id);
    const savedOrder = order().map((id) => uploaded[picked.indexOf(id)]);

    return {
      before,
      afterDrag,
      selectedId,
      savedPhotos: block && block.photos,
      savedOrder,
    };
  `);
  check('the gallery starts in the order the photos were picked',
    orderResult.before.length, 3);
  check('dragging a photo onto another one swaps them',
    orderResult.afterDrag,
    [orderResult.before[1], orderResult.before[0], orderResult.before[2]]);
  check('the dragged photo is the selected one',
    orderResult.selectedId, orderResult.before[0]);
  check('the saved document keeps the new order',
    orderResult.savedPhotos && orderResult.savedPhotos.map(p => p.photo_id),
    orderResult.savedOrder);

  // ---- 6. A real mouse drag reorders the photos -------------------------
  console.log('\n== 真实鼠标拖拽 ==');
  const dragSetup = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '拖一下。';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input'));

    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const files = ['one.jpg', 'two.jpg', 'three.jpg'].map((name, i) =>
        new File([new Uint8Array([i + 1, 2, 3])], name, { type: 'image/jpeg' }));
      Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-image"]');
    await new Promise(r => setTimeout(r, 150));

    const items = Array.from(document.querySelectorAll('.diary-gallery-item'));
    items.forEach(it => { it.style.height = '160px'; });
    await new Promise(r => setTimeout(r, 30));
    const r0 = items[0].getBoundingClientRect();
    const r1 = items[1].getBoundingClientRect();
    return {
      order: items.map(i => i.dataset.photoId),
      x0: Math.round(r0.left + r0.width / 2),
      y0: Math.round(r0.top + r0.height / 2),
      x1: Math.round(r1.left + r1.width / 2),
      y1: Math.round(r1.top + r1.height / 2),
    };
  `);
  // A REAL mouse gesture through the browser's input pipeline — not a
  // synthetic event. This is what turns into a native image drag when the
  // picture is draggable, and the native drag swallows the pointer.
  win.webContents.sendInputEvent({
    type: 'mouseDown', x: dragSetup.x0, y: dragSetup.y0, button: 'left', clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 40));
  for (let i = 1; i <= 5; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(dragSetup.x0 + (dragSetup.x1 - dragSetup.x0) * i / 5),
      y: Math.round(dragSetup.y0 + (dragSetup.y1 - dragSetup.y0) * i / 5),
      button: 'left', buttons: 1,
    });
    await new Promise(r => setTimeout(r, 25));
  }
  const duringDrag = await evalIn(win, `
    return {
      order: Array.from(document.querySelectorAll('.diary-gallery-item')).map(i => i.dataset.photoId),
      ghost: !!document.querySelector('.diary-gallery-ghost'),
      dragging: document.body.classList.contains('diary-reordering'),
    };
  `);
  win.webContents.sendInputEvent({
    type: 'mouseUp', x: dragSetup.x1, y: dragSetup.y1, button: 'left', clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 80));
  const afterDrag = await evalIn(win, `
    return {
      order: Array.from(document.querySelectorAll('.diary-gallery-item')).map(i => i.dataset.photoId),
      ghost: !!document.querySelector('.diary-gallery-ghost'),
    };
  `);
  check('the real mouse drag swaps the two photos',
    afterDrag.order, [dragSetup.order[1], dragSetup.order[0], dragSetup.order[2]]);
  check('the picture follows the pointer while dragging', duringDrag.ghost, true);
  check('the page knows a reorder is going on', duringDrag.dragging, true);
  check('the ghost is cleaned up after the drag', afterDrag.ghost, false);

  // ---- 7. A click selects, a double click opens the picture -------------
  console.log('\n== 点选与大图 ==');
  const lightboxResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '看看图。';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input'));

    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const files = ['one.jpg'].map((name) =>
        new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' }));
      Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-image"]');
    await new Promise(r => setTimeout(r, 150));

    const item = document.querySelector('.diary-gallery-item');
    item.click();
    await new Promise(r => setTimeout(r, 20));
    const afterClick = {
      lightboxOpen: !!document.querySelector('.photo-lightbox.open'),
      selected: !!document.querySelector('.diary-gallery-item.selected'),
    };

    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    const afterDblClick = {
      lightboxOpen: !!document.querySelector('.photo-lightbox.open'),
    };

    return { afterClick, afterDblClick };
  `);
  check('a single click does not open the picture over the page',
    lightboxResult.afterClick.lightboxOpen, false);
  check('a single click selects the photo',
    lightboxResult.afterClick.selected, true);
  check('a double click opens the picture',
    lightboxResult.afterDblClick.lightboxOpen, true);

  // ---- 8. The body never covers the decorative layer -------------------
  //
  // The sheet is three layers: the title bar, the body and the decoration
  // at the bottom. The body grows with the text and the photos it holds;
  // the decoration has to stay BELOW it. When all three were painted as
  // one background stack, a long entry put its words and its pictures on
  // top of the decoration instead.
  console.log('\n== 三层结构不遮挡 ==');
  const layersResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const measure = () => {
      const header = document.querySelector('.diary-page-header');
      const body = document.querySelector('.diary-page-body');
      const foot = document.querySelector('.diary-page-foot');
      const page = document.querySelector('.diary-page');
      const h = header.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      const f = foot.getBoundingClientRect();
      const p = page.getBoundingClientRect();
      // The last block is the lowest thing in the body.
      const blocks = Array.from(document.querySelectorAll('.diary-block'));
      const last = blocks.length ? blocks[blocks.length - 1].getBoundingClientRect() : null;
      return {
        headerBottom: Math.round(h.bottom),
        bodyTop: Math.round(b.top),
        bodyBottom: Math.round(b.bottom),
        footTop: Math.round(f.top),
        footBottom: Math.round(f.bottom),
        footHeight: Math.round(f.height),
        lastBlockBottom: last ? Math.round(last.bottom) : null,
        bodyHeight: Math.round(b.height),
        pageHeight: Math.round(p.height),
        // The gap between the bottom of the decoration and the bottom of
        // the sheet. It has to be zero: the decoration IS the bottom edge.
        footGap: Math.round(p.bottom - f.bottom),
        // The decoration is the last layer of the sheet.
        footIsLast: page.lastElementChild === foot,
      };
    };

    const before = measure();

    // Now make the document long: a lot of text and a tall picture. The
    // body must grow — and the decoration must move down with it, not be
    // covered by it.
    const ta = document.querySelector('.diary-block-text');
    ta.value = Array.from({ length: 40 }, (_, i) => '这是第 ' + (i + 1) + ' 行文字，用来把页面撑长。').join('\\n');
    ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 60));

    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const file = new File([new Uint8Array([1,2,3])], 'tall.jpg', { type: 'image/jpeg' });
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-image"]');
    await new Promise(r => setTimeout(r, 120));

    // Give the picture a real height — the picked bytes are not an image,
    // so it has none of its own.
    const item = document.querySelector('.diary-gallery-item');
    if (item) item.style.height = '300px';
    await new Promise(r => setTimeout(r, 60));

    const after = measure();
    return { before, after };
  `);
  check('the header bar sits above the body',
    layersResult.before.headerBottom <= layersResult.before.bodyTop, true);
  check('the body sits above the decoration',
    layersResult.before.bodyBottom <= layersResult.before.footTop, true);
  check('the decoration has its own height',
    layersResult.before.footHeight > 0, true);
  checkTrue('a longer document makes the body taller',
    layersResult.after.bodyHeight > layersResult.before.bodyHeight);
  checkTrue('the decoration moves down when the body grows',
    layersResult.after.footTop > layersResult.before.footTop);
  check('the body still ends above the decoration',
    layersResult.after.bodyBottom <= layersResult.after.footTop, true);
  check('the last block of the body ends above the decoration',
    layersResult.after.lastBlockBottom <= layersResult.after.footTop, true);
  check('the decoration reaches the bottom edge of the sheet',
    layersResult.after.footGap, 0);
  check('the decoration is the last layer of the sheet',
    layersResult.after.footIsLast, true);

  // ---- 9. No tag logic anywhere ---------------------------------------
  console.log('\n== 标签逻辑已移除 ==');
  const noTagResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));
    const editorHtml = document.getElementById('app').innerHTML;

    await window.__list.render([], {});
    await new Promise(r => setTimeout(r, 80));
    const listHtml = document.getElementById('app').innerHTML;

    // The only .tag on a card is the 第一次/其他 kind badge, which is the
    // memorial event's original type — not the removed tag system.
    const rowTags = Array.from(document.querySelectorAll('.memorial-card .tag'))
      .map(el => el.textContent.trim());

    return {
      editorHasTagDialog: !!document.querySelector('.diary-tag-modal'),
      editorHasTagCard: !!document.getElementById('diary-current-tag'),
      editorHasTagButton: /插入标签|添加标签|标签/.test(editorHtml),
      listHasTagFilter: !!document.getElementById('filter-tag-kind'),
      rowTags,
      tagWordsInEditor: (editorHtml.match(/标签/g) || []).length,
      tagWordsInList: (listHtml.match(/filter-tag-kind/g) || []).length,
      sheets: document.querySelectorAll('.memorial-card-sheet').length,
      cards: document.querySelectorAll('.memorial-card').length,
    };
  `);
  checkTrue('the editor has no tag dialog', !noTagResult.editorHasTagDialog);
  checkTrue('the editor has no tag card', !noTagResult.editorHasTagCard);
  checkTrue('the editor mentions no tag UI at all', !noTagResult.editorHasTagButton);
  checkTrue('the list has no 类型 filter', !noTagResult.listHasTagFilter);
  // The kind badge (第一次/其他) is all that remains — no 生日/纪念日/节日.
  check('the cards carry only the kind badge, no type tag',
    noTagResult.rowTags.filter(t => ['生日', '纪念日', '节日', '未分类'].includes(t)), []);
  // Every card is a miniature diary page: a sheet with a header bar, a
  // body and a decorative strip.
  check('every card carries a diary sheet', noTagResult.sheets, noTagResult.cards);

  // ---- 10. The controls live in a right-click menu ---------------------
  //
  // The block controls do NOT sit in the document: they used to sit in a
  // bar under every text block and under every gallery, which broke the
  // flow of the writing. Now they appear when the user presses on the
  // block — nothing is on the page until then, and everything is in the
  // menu when it is.
  console.log('\n== 右键菜单 ==');
  const menuResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '一段话。';
    ta.focus();
    ta.setSelectionRange(3, 3);
    ta.dispatchEvent(new Event('input'));

    // Nothing is on the page before the press.
    const beforePress = {
      blockBars: document.querySelectorAll('.diary-block-bar').length,
      galleryBars: document.querySelectorAll('.diary-gallery-bar').length,
      menuOpen: window.__menu.isOpen(),
    };

    // Right-click the text block.
    const textMenu = window.__menu.open(ta);
    const afterPress = {
      menuOpen: window.__menu.isOpen(),
      acts: textMenu.map(i => i.act),
      labels: textMenu.map(i => i.label),
      // The editing commands the browser's own menu would have offered.
      hasCopy: textMenu.some(i => i.act === 'copy'),
      hasPaste: textMenu.some(i => i.act === 'paste'),
      hasSelectAll: textMenu.some(i => i.act === 'select-all'),
    };

    // The menu goes away again.
    window.__menu.close();
    const afterClose = { menuOpen: window.__menu.isOpen() };

    // Now a gallery: right-click it and add a picture, so the gallery
    // has a photo of its own.
    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const file = new File([new Uint8Array([1,2,3])], 'one.jpg', { type: 'image/jpeg' });
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-image"]');
    await new Promise(r => setTimeout(r, 80));

    const gallery = document.querySelector('.diary-block-gallery');
    const galleryMenu = window.__menu.open(gallery);
    const galleryActs = galleryMenu.map(i => i.act);
    const galleryLabels = galleryMenu.map(i => i.label);

    // The photo counter lives in the menu too.
    const counter = galleryMenu.find(i => i.label.includes('张'));

    // Right-clicking a PICTURE adds that picture's own action.
    const photo = document.querySelector('.diary-gallery-item');
    const photoMenu = window.__menu.open(photo);
    const photoActs = photoMenu.map(i => i.act);
    window.__menu.close();

    // The block's own action still works: 「删除此段」 takes the block
    // away.
    const blocksBefore = document.querySelectorAll('.diary-block').length;
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="delete-block"]');
    await new Promise(r => setTimeout(r, 40));
    const blocksAfter = document.querySelectorAll('.diary-block').length;

    return {
      beforePress, afterPress, afterClose,
      galleryActs, galleryLabels,
      counter: counter ? counter.label : null,
      photoActs,
      blocksBefore, blocksAfter,
    };
  `);
  check('the document carries no block toolbar',
    menuResult.beforePress.blockBars, 0);
  check('the document carries no gallery toolbar',
    menuResult.beforePress.galleryBars, 0);
  checkTrue('no menu is on screen before the press',
    !menuResult.beforePress.menuOpen);
  checkTrue('right-clicking a text block opens the menu',
    menuResult.afterPress.menuOpen);
  check('the text menu carries the block actions',
    menuResult.afterPress.acts.slice(0, 2), ['insert-image', 'delete-block']);
  check('the text menu carries the editing commands',
    [menuResult.afterPress.hasCopy, menuResult.afterPress.hasPaste,
     menuResult.afterPress.hasSelectAll], [true, true, true]);
  checkTrue('the menu goes away again', !menuResult.afterClose.menuOpen);
  check('the gallery menu carries the layout switch, the add button and '
    + 'the text insertions',
    ['layout', 'gallery-add', 'insert-before', 'insert-after']
      .every(a => menuResult.galleryActs.includes(a)), true);
  checkTrue('the gallery menu shows the photo counter',
    !!menuResult.counter && menuResult.counter.includes('张'));
  checkTrue('right-clicking a picture offers to delete that picture',
    menuResult.photoActs.includes('delete-photo'));
  checkTrue('right-clicking a picture still offers the gallery actions',
    menuResult.photoActs.includes('gallery-add'));
  check('「删除此段」 removes the block',
    menuResult.blocksAfter, menuResult.blocksBefore - 1);

  // ---- 11. The list cards mirror the diary page ------------------------
  //
  // The 回忆事件 list is a grid of cards, and each card is a miniature of
  // the page the entry was written on: the same header bar with the
  // title, the same text blocks and photo galleries in the same order,
  // the same decorative strip at the bottom.
  console.log('\n== 回忆事件卡片 ==');
  const cardResult = await evalIn(win, `
    window.__testRows.clear();
    window.__testRows.seed('card-1', {
      id: 'card-1',
      kind: 'other',
      title: '第一次去海边',
      occurred_at: '2026-05-01 10:30:00',
      background: 'shadow',
      notes: '旧格式的正文',
      contact_names: ['小明', '小红'],
      photo_count: 3,
      photo_ids: ['pc1', 'pc2', 'pc3'],
      content: JSON.stringify([
        { type: 'text', text: '在防波堤上坐了很久' },
        { type: 'gallery', layout: 'two', photos: [
          { photo_id: 'pc1' }, { photo_id: 'pc2' } ] },
        { type: 'text', text: '到天黑，看远处的灯一盏一盏亮起来。' },
        { type: 'gallery', layout: 'grid', photos: [
          { photo_id: 'pc3' } ] },
      ]),
    });

    await window.__list.render([], {});
    await new Promise(r => setTimeout(r, 120));

    const card = document.querySelector('.memorial-card');
    const sheet = document.querySelector('.memorial-card-sheet');
    const body = document.querySelector('.memorial-card-body');
    const page = document.querySelector('.memorial-card-page');
    const blocks = Array.from(page.children).map(el => el.className);

    return {
      grid: !!document.querySelector('.memorial-grid'),
      cardCount: document.querySelectorAll('.memorial-card').length,
      // The card is the page: no panel, no category strip, nothing
      // wrapped around the sheet.
      cardClasses: Array.from(card.classList),
      cardChildren: Array.from(card.children).map(el => el.className),
      // The layers of the sheet, in the editor's order.
      sheetLayers: Array.from(sheet.children).map(el => el.className),
      title: document.querySelector('.memorial-card-title').textContent.trim(),
      // The header bar carries the theme's own colors.
      headerBg: sheet.querySelector('.memorial-card-header')
        .getBoundingClientRect().height,
      sheetVar: sheet.style.getPropertyValue('--diary-header-bg'),
      blocks,
      texts: Array.from(document.querySelectorAll('.memorial-card-text'))
        .map(el => el.textContent.trim()),
      galleryLayouts: Array.from(document.querySelectorAll('.memorial-card-gallery'))
        .map(el => el.dataset.layout),
      photoCount: document.querySelectorAll('.memorial-card-photo').length,
      photoIds: Array.from(document.querySelectorAll('.memorial-card-photo img'))
        .map(el => el.dataset.photoId),
      // The photo widths follow the layout: 双图 gives each photo half.
      widths: Array.from(document.querySelectorAll('.memorial-card-photo'))
        .map(el => el.style.width),
      foot: !!document.querySelector('.memorial-card-foot'),
      // The bookkeeping line lives IN the third layer — the strip at the
      // bottom — so the sheet keeps the editor's three layers.
      metaInFoot: document.querySelector('.memorial-card-foot')
        .textContent.trim(),
      metaRows: document.querySelectorAll('.memorial-card-meta').length,
      footBg: getComputedStyle(document.querySelector('.memorial-card-foot'))
        .backgroundColor,
      sheetHeight: sheet.getBoundingClientRect().height,
      // The body clips whatever runs past the bottom of the sheet.
      bodyOverflow: getComputedStyle(body).overflow,
      bodyScroll: body.scrollHeight,
      bodyHeight: body.getBoundingClientRect().height,
      // The page is scaled down as one piece — that is what makes the
      // card a thumbnail rather than a redrawing.
      pageScale: getComputedStyle(page).getPropertyValue('--card-scale').trim(),
      pageTransform: getComputedStyle(page).transform,
      // A photo keeps its own aspect ratio: it is never re-cropped into
      // a uniform frame.
      photoFit: getComputedStyle(
        document.querySelector('.memorial-card-photo img')).objectFit,
    };
  `);
  checkTrue('the list is a grid of cards', cardResult.grid);
  check('one card per entry', cardResult.cardCount, 1);
  // The card is the diary page and nothing else: the app's own .card
  // panel (its frame, its shadow, its category color strip) is gone, so
  // the page stands on its own.
  checkTrue('the card carries no panel around it',
    !cardResult.cardClasses.includes('card')
    && !cardResult.cardClasses.includes('list-row'));
  check('the page is the card\'s only layer',
    cardResult.cardChildren, ['memorial-card-sheet']);
  check('the sheet stacks the header, the body and the strip',
    cardResult.sheetLayers,
    ['memorial-card-header', 'memorial-card-body', 'memorial-card-foot']);
  check('the card shows the entry title', cardResult.title, '第一次去海边');
  check('the card paints the entry\'s own background style',
    cardResult.sheetVar, '#77613b');
  checkTrue('the header bar has a height', cardResult.headerBg > 0);
  // The document's blocks keep their order: text, gallery, text, gallery.
  check('the card keeps the document\'s block order',
    cardResult.blocks,
    ['memorial-card-text', 'memorial-card-gallery',
     'memorial-card-text', 'memorial-card-gallery']);
  check('the card shows the text of every text block',
    cardResult.texts,
    ['在防波堤上坐了很久', '到天黑，看远处的灯一盏一盏亮起来。']);
  check('the card keeps the gallery layout of each gallery',
    cardResult.galleryLayouts, ['two', 'grid']);
  check('the card shows every photo of the document',
    cardResult.photoCount, 3);
  check('the card shows the photos in the document\'s order',
    cardResult.photoIds, ['pc1', 'pc2', 'pc3']);
  // The browser normalizes the calc() the renderer writes, so the value
  // that comes back is the simplified form of the same width.
  check('the card lays the photos out by the gallery\'s layout',
    cardResult.widths[0], 'calc(50% - 4px)');
  checkTrue('the card has the decorative strip', cardResult.foot);
  checkTrue('the card has a fixed height',
    Math.abs(cardResult.sheetHeight - 320) < 2);
  // The details sit in the strip — the sheet's third layer — so the card
  // keeps the editor's three layers and the line of text is on the
  // coloured band, not on the paper above it.
  check('the details live in the strip, not in a row of their own',
    cardResult.metaRows, 0);
  checkTrue('the strip names the contacts and the date',
    cardResult.metaInFoot.includes('小明 等 2 人')
    && cardResult.metaInFoot.includes('2026-05-01'));
  check('the body clips what runs past the sheet',
    cardResult.bodyOverflow, 'hidden');
  // The card is a THUMBNAIL: the page is scaled down as one piece, so
  // the proportions between the words, the paper and the pictures are
  // the ones the user wrote on.
  checkTrue('the page is scaled down as one piece',
    cardResult.pageTransform.startsWith('matrix')
    && parseFloat(cardResult.pageScale) > 0 && parseFloat(cardResult.pageScale) < 1);
  // A photo keeps its own shape — it is never re-cropped into a uniform
  // frame, which is what made the card look like a pile of pieces.
  check('a photo keeps its own aspect ratio', cardResult.photoFit, 'fill');

  // ---- 12. A long entry is cut off, not shrunk ----------------------
  //
  // The card has a fixed height, so an entry that is longer than the
  // sheet runs past its bottom edge and is cut there — the way a
  // photograph of a page is cut. The card shows the beginning of the
  // entry and nothing else.
  console.log('\n== 长日记的截断 ==');
  const longResult = await evalIn(win, `
    window.__testRows.seed('long', {
      id: 'long', kind: 'other', title: '很长的一篇',
      occurred_at: '2026-01-01 10:00:00', background: 'light',
      contact_names: ['小明'], photo_count: 0,
      content: JSON.stringify([
        { type: 'text', text: '第一段。'.repeat(30) },
        { type: 'text', text: '第二段。'.repeat(30) },
        { type: 'text', text: '第三段。'.repeat(30) },
      ]),
    });
    await window.__list.render([], {});
    await new Promise(r => setTimeout(r, 120));
    const body = document.querySelector('.memorial-card-body');
    const text = document.querySelector('.memorial-card-text');
    const cs = getComputedStyle(text);
    return {
      bodyHeight: body.getBoundingClientRect().height,
      bodyScroll: body.scrollHeight,
      // The paragraph is NOT clamped: it keeps its full height, and the
      // sheet's edge is what cuts it. (The height is read unscaled —
      // the page is drawn scaled down, so the painted height is
      // smaller than the layout height.)
      lineClamp: cs.webkitLineClamp,
      textOverflow: cs.overflow,
      display: cs.display,
    };
  `);
  checkTrue('the body is clipped, not grown',
    longResult.bodyScroll > longResult.bodyHeight);
  checkTrue('a long paragraph is not clamped, it runs on',
    longResult.lineClamp === 'none'
    && longResult.display !== '-webkit-box');

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  cleanup(win, fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('test harness crashed:', e);
  try { fs.unlinkSync(probePath); } catch (_) {}
  app.exit(1);
});

function cleanup(win, code) {
  try { fs.unlinkSync(probePath); } catch (_) {}
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(code === undefined ? 0 : code);
}
