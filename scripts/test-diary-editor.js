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
  checkTrue('every style has a header color, a text color and two body bands',
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
      insertImageButtons: document.querySelectorAll('.diary-block-bar [data-act="insert-image"]').length,
      hasSave: !!document.getElementById('save'),
      textBlocks: document.querySelectorAll('.diary-block-text').length,
      tiles: tiles.length,
      changed: beforeBg !== afterBg,
      header: afterHeader,
      selectedCount: document.querySelectorAll('.diary-theme-tile.selected').length,
      contactCards: document.querySelectorAll('.contact-pick').length,
      pageBg: getComputedStyle(page).backgroundImage,
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
      // The page body is painted in two horizontal layers (the header
      // bar is a separate element on top). The computed background-image
      // lists one gradient per layer.
      bgLayers: getComputedStyle(page).backgroundImage.split('gradient(').length - 1,
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
  check('the only "插入图片" button is the per-block one',
    editorResult.insertImageButtons, 1);
  checkTrue('the editor renders a save button', editorResult.hasSave);
  checkTrue('the editor starts with one text block', editorResult.textBlocks >= 1);
  check('the style picker shows all six tiles', editorResult.tiles, 6);
  checkTrue('picking a style repaints the writing surface', editorResult.changed);
  check('the Shadow style writes its header color', editorResult.header, '#77613b');
  check('exactly one tile is marked selected', editorResult.selectedCount, 1);
  check('the contact picker lists the contacts', editorResult.contactCards, 2);
  checkTrue('the page background paints with the chosen gradient',
    editorResult.pageBg && editorResult.pageBg.includes('gradient'));
  check('the page body is painted in two background layers', editorResult.bgLayers, 2);
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

    // Simulate the user clicking 「插入图片」 on that block and picking a
    // file. The editor splits the block at the caret.
    const bar = document.querySelector('.diary-block-bar');
    const insertBtn = bar.querySelector('[data-act="insert-image"]');
    // The button opens the file picker. We can't drive a native picker
    // from the test, so we stub the click method to fire the change
    // handler with a synthetic file instead — the same path the real
    // picker takes.
    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const file = new File([new Uint8Array([1,2,3])], 'sunset.jpg', { type: 'image/jpeg' });
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };

    insertBtn.click();
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

  // ---- 4. Multi-image: many photos, a layout, and per-photo sizes -----
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
    document.querySelector('.diary-block-bar [data-act="insert-image"]').click();
    await new Promise(r => setTimeout(r, 120));

    const gallery = document.querySelector('.diary-block-gallery');
    const items = Array.from(document.querySelectorAll('.diary-gallery-item'));
    const widthBefore = items.map(i => i.style.width);
    const layoutButtons = Array.from(gallery.querySelectorAll('[data-layout]'));

    // Switch the arrangement to 「双图」.
    const twoBtn = layoutButtons.find(b => b.dataset.layout === 'two');
    twoBtn.click();
    await new Promise(r => setTimeout(r, 20));
    const widthAfterLayout = items.map(i => i.style.width);

    // Select the second photo and shrink it with the 「小」 preset.
    items[1].click();
    gallery.querySelector('[data-size="small"]').click();
    await new Promise(r => setTimeout(r, 20));
    const widthAfterSize = items.map(i => i.style.width);

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

    return {
      galleryCount: document.querySelectorAll('.diary-block-gallery').length,
      itemCount: items.length,
      layoutButtonIds: layoutButtons.map(b => b.dataset.layout),
      widthBefore: widthBefore.map(frac),
      widthAfterLayout: widthAfterLayout.map(frac),
      widthAfterSize: widthAfterSize.map(frac),
      widthAfterDrag: widthAfterDrag.map(frac),
      selectedLayout: gallery.querySelector('[data-layout].selected')
        ? gallery.querySelector('[data-layout].selected').dataset.layout : null,
      savedLayout: galleryBlock && galleryBlock.layout,
      savedPhotos: galleryBlock && galleryBlock.photos,
      notes: row && row.notes,
    };
  `);
  check('the three picked files share one gallery', multiResult.galleryCount, 1);
  check('the gallery shows all three photos', multiResult.itemCount, 3);
  check('the gallery offers four layouts',
    multiResult.layoutButtonIds, ['one', 'two', 'three', 'grid']);
  check('the chosen layout is marked', multiResult.selectedLayout, 'two');
  check('the 双图 layout puts two photos on a row',
    multiResult.widthAfterLayout[0], 0.5);
  check('the 小 preset shrinks only the selected photo',
    multiResult.widthAfterSize[1], 0.32);
  check('the 小 preset leaves the other photos alone',
    multiResult.widthAfterSize[0], multiResult.widthAfterLayout[0]);
  checkTrue('dragging the handle makes the photo bigger',
    multiResult.widthAfterDrag[0] !== multiResult.widthAfterSize[0]);
  check('the saved gallery keeps the chosen layout', multiResult.savedLayout, 'two');
  check('the saved gallery keeps all three photos',
    multiResult.savedPhotos && multiResult.savedPhotos.length, 3);
  checkTrue('the saved gallery keeps the resized photo\'s width',
    multiResult.savedPhotos && typeof multiResult.savedPhotos[0].width === 'number' &&
    multiResult.savedPhotos[0].width > 0.5);
  checkTrue('the saved gallery keeps the shrunk photo\'s width',
    multiResult.savedPhotos && Math.abs(multiResult.savedPhotos[1].width - 0.32) < 0.001);
  checkTrue('a photo that still follows the layout stores no width',
    multiResult.savedPhotos && multiResult.savedPhotos[2].width === undefined);
  check('the plain text is still mirrored into notes',
    multiResult.notes, '那天拍了很多张。');

  // ---- 5. The photos in a gallery can be put in any order --------------
  console.log('\n== 图组内的顺序 ==');
  const orderResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

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
    document.querySelector('.diary-block-bar [data-act="insert-image"]').click();
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

    // The toolbar moves the selected photo one step as well.
    const selectedBefore = gallery.querySelector('.diary-gallery-item.selected');
    const selectedId = selectedBefore ? selectedBefore.dataset.photoId : null;
    gallery.querySelector('[data-act="photo-right"]').click();
    await new Promise(r => setTimeout(r, 20));
    const afterButton = order();

    // Mark each photo with its own size, so the saved document shows
    // which photo is where.
    const sizes = ['small', 'mid', 'big'];
    const now = Array.from(gallery.querySelectorAll('.diary-gallery-item'));
    now.forEach((el, i) => {
      el.click();
      gallery.querySelector('[data-size="' + sizes[i] + '"]').click();
    });
    await new Promise(r => setTimeout(r, 20));

    document.getElementById('diary-title').value = '换了顺序的一篇';
    document.getElementById('diary-occurred').value = '2026-05-03T10:30';
    document.getElementById('save').click();
    await new Promise(r => setTimeout(r, 250));

    const rows = Object.values(window.__testRows.all());
    const row = rows[rows.length - 1];
    const block = row.content.find(b => b.type === 'gallery');

    return {
      before,
      afterDrag,
      afterButton,
      selectedId,
      savedPhotos: block && block.photos,
    };
  `);
  check('the gallery starts in the order the photos were picked',
    orderResult.before.length, 3);
  check('dragging a photo onto another one swaps them',
    orderResult.afterDrag,
    [orderResult.before[1], orderResult.before[0], orderResult.before[2]]);
  check('the dragged photo is the selected one',
    orderResult.selectedId, orderResult.before[0]);
  check('the ▶ button moves the selected photo one step back',
    orderResult.afterButton,
    [orderResult.before[1], orderResult.before[2], orderResult.before[0]]);
  check('the saved document keeps the new order',
    orderResult.savedPhotos && orderResult.savedPhotos.map(p => p.width),
    [0.32, 0.6, 1]);

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
    document.querySelector('.diary-block-bar [data-act="insert-image"]').click();
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
    document.querySelector('.diary-block-bar [data-act="insert-image"]').click();
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

  // ---- 8. No tag logic anywhere ---------------------------------------
  console.log('\n== 标签逻辑已移除 ==');
  const noTagResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));
    const editorHtml = document.getElementById('app').innerHTML;

    await window.__list.render([], {});
    await new Promise(r => setTimeout(r, 80));
    const listHtml = document.getElementById('app').innerHTML;

    // The only .tag on a row is the 第一次/其他 kind badge, which is the
    // memorial event's original type — not the removed tag system.
    const rowTags = Array.from(document.querySelectorAll('.memorial-row .tag'))
      .map(el => el.textContent.trim());

    return {
      editorHasTagDialog: !!document.querySelector('.diary-tag-modal'),
      editorHasTagCard: !!document.getElementById('diary-current-tag'),
      editorHasTagButton: /插入标签|添加标签|标签/.test(editorHtml),
      listHasTagFilter: !!document.getElementById('filter-tag-kind'),
      rowTags,
      tagWordsInEditor: (editorHtml.match(/标签/g) || []).length,
      tagWordsInList: (listHtml.match(/filter-tag-kind/g) || []).length,
      swatches: document.querySelectorAll('.mr-bg-swatch').length,
      rows: document.querySelectorAll('.memorial-row').length,
    };
  `);
  checkTrue('the editor has no tag dialog', !noTagResult.editorHasTagDialog);
  checkTrue('the editor has no tag card', !noTagResult.editorHasTagCard);
  checkTrue('the editor mentions no tag UI at all', !noTagResult.editorHasTagButton);
  checkTrue('the list has no 类型 filter', !noTagResult.listHasTagFilter);
  // The kind badge (第一次/其他) is all that remains — no 生日/纪念日/节日.
  check('the rows carry only the kind badge, no type tag',
    noTagResult.rowTags.filter(t => ['生日', '纪念日', '节日', '未分类'].includes(t)), []);
  check('every list row still shows the background swatch',
    noTagResult.swatches, noTagResult.rows);

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
