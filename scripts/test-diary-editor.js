// scripts/test-diary-editor.js — proves the diary editor works end to end.
//
// Covers the five things that make the diary feature what it is:
//
//   1. The six background styles exist and are well-formed (an id, a
//      header color, a page background, and three accent dots).
//   2. The editor renders a title, a body, and the six style tiles, and
//      picking a tile repaints the writing surface.
//   3. Text and images interleave: inserting a picture puts it after
//      the text block and leaves the text whole — the paragraph is
//      never cut in two — and the saved document keeps that order.
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

// The 保存 button opens the metadata dialog (the time, the cast, the
// first-time flag). The test drives it the way the user does: press 保存,
// fill the dialog in, press 确认保存.
window.__meta = {
  // Any dialog left over from an earlier step would be picked up by the
  // next querySelector, so a stale one is dismissed first.
  async open() {
    document.querySelectorAll('.diary-meta-modal-backdrop').forEach(el => el.remove());
    document.getElementById('save').click();
    // The dialog is built synchronously, but the save handler awaits the
    // contact list before it opens — give it a tick.
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector('.diary-meta-modal-backdrop');
      if (el) return el;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('the metadata dialog did not open');
  },
  // Press 保存 twice in a row: the second press must not open a second
  // dialog on top of the first one.
  async openTwice() {
    document.querySelectorAll('.diary-meta-modal-backdrop').forEach(el => el.remove());
    const save = document.getElementById('save');
    save.click();
    save.click();
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector('.diary-meta-modal-backdrop');
      if (el) break;
      await new Promise(r => setTimeout(r, 25));
    }
    // Wait for the second press to have had its chance to open a dialog.
    await new Promise(r => setTimeout(r, 250));
    return {
      dialogs: document.querySelectorAll('.diary-meta-modal-backdrop').length,
      open: window.__editor.isMetaDialogOpen(),
    };
  },
  async confirm(occurredAt, kind, contactIds) {
    const el = await window.__meta.open();
    if (occurredAt) el.querySelector('[data-role="occurred"]').value = occurredAt;
    if (kind) {
      const radio = el.querySelector('input[name="diary-meta-kind"][value="' + kind + '"]');
      if (radio) radio.checked = true;
    }
    for (const id of (contactIds || [])) {
      const pick = el.querySelector('.contact-pick[data-id="' + id + '"]');
      if (pick) pick.click();
    }
    el.querySelector('[data-act="confirm"]').click();
    await new Promise(r => setTimeout(r, 250));
    return true;
  },
};

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

    // The six styles live in a POPOVER: they are hidden until the
    // collapsed button is pressed.
    const pop = document.getElementById('diary-theme-pop');
    const toggle = document.getElementById('diary-theme-toggle');
    const popHiddenAtStart = !!pop && pop.hidden;

    // Press the button: the popover opens.
    if (toggle) toggle.click();
    await new Promise(r => setTimeout(r, 20));
    const popOpenAfterToggle = !!pop && !pop.hidden;

    const shadowTile = Array.from(tiles).find(t => t.dataset.themeId === 'shadow');
    shadowTile.click();
    await new Promise(r => setTimeout(r, 20));
    const afterBg = page.style.getPropertyValue('--diary-bg');
    const afterHeader = page.style.getPropertyValue('--diary-header-bg');
    // Picking a style closes the popover again.
    const popClosedAfterPick = !!pop && pop.hidden;

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
      // The collapsed button and its popover.
      hasToggle: !!toggle,
      popHiddenAtStart,
      popOpenAfterToggle,
      popClosedAfterPick,
      // The button carries the style in use: its miniature is painted in
      // the chosen style's colors, and its label names the style.
      thumbHeader: (toggle && toggle.querySelector('.diary-theme-thumb'))
        ? toggle.querySelector('.diary-theme-thumb').style.getPropertyValue('--theme-header')
        : '',
      toggleLabel: (document.getElementById('diary-theme-current') || {}).textContent || '',
      // The metadata (the date, the cast, the first-time flag) is NOT on
      // the page any more: it is asked for in the 保存 dialog. The writing
      // surface holds the title and the text, and nothing else.
      dateInSide: !!document.querySelector('.diary-side #diary-occurred'),
      dateOnPage: !!document.querySelector('.diary-page #diary-occurred'),
      dateAnywhere: !!document.getElementById('diary-occurred'),
      contactsInSide: !!document.querySelector('.diary-side #diary-contact-picker'),
      sideCards: document.querySelectorAll('.diary-side .diary-side-card').length,
      // The editing guide: every control of the document lives in a
      // right-click menu, so the side panel has to say so.
      helpCard: !!document.querySelector('.diary-side .diary-help-card'),
      helpHeading: (document.querySelector('.diary-side .diary-help-card h2') || {}).textContent || '',
      helpItems: Array.from(
        document.querySelectorAll('.diary-side .diary-help-list li')
      ).map(li => li.textContent.trim()),
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
  checkTrue('the styles are collapsed into one button', editorResult.hasToggle);
  checkTrue('the popover starts closed', editorResult.popHiddenAtStart);
  checkTrue('pressing the button opens the popover', editorResult.popOpenAfterToggle);
  checkTrue('picking a style closes the popover', editorResult.popClosedAfterPick);
  check('the button names the style in use', editorResult.toggleLabel, 'Shadow');
  check('the button previews the style in use', editorResult.thumbHeader, '#77613b');
  checkTrue('picking a style repaints the writing surface', editorResult.changed);
  check('the Shadow style writes its header color', editorResult.header, '#77613b');
  check('exactly one tile is marked selected', editorResult.selectedCount, 1);
  // The contact picker is not on the page — it lives in the 保存 dialog.
  check('the page carries no contact picker', editorResult.contactCards, 0);
  checkTrue('the page background paints with the chosen color',
    editorResult.pageBg && editorResult.pageBg !== 'rgba(0, 0, 0, 0)');
  check('the page is three separate layers: header, body, decoration',
    editorResult.layers, [true, true, true]);
  checkTrue('every layer paints its own background color',
    editorResult.layerBgs.every(c => c && c !== 'rgba(0, 0, 0, 0)'));
  check('the picker preview shows the two bands', editorResult.previewBands, 2);
  checkTrue('the date field is not in the side panel', !editorResult.dateInSide);
  checkTrue('the Tackbox page shows no date', !editorResult.dateOnPage);
  checkTrue('the date field is nowhere on the page', !editorResult.dateAnywhere);
  checkTrue('the contact picker is not in the side panel', !editorResult.contactsInSide);
  check('the side panel has the style card and the guide', editorResult.sideCards, 2);
  checkTrue('the editing guide is in the side panel', editorResult.helpCard);
  check('the guide is headed 编辑规则', editorResult.helpHeading, '编辑规则');
  // The guide has to name the gestures the menus answer to, or it is
  // no guide at all.
  checkTrue('the guide names the right-click gestures',
    editorResult.helpItems.some(t => t.includes('右键文字'))
    && editorResult.helpItems.some(t => t.includes('右键图组')));
  checkTrue('the guide names the drag gestures',
    editorResult.helpItems.some(t => t.includes('拖动图片'))
    && editorResult.helpItems.some(t => t.includes('右下角')));

  // ---- 3. Text and images interleave ---------------------------------
  console.log('\n== 图文混排 ==');
  const mixResult = await evalIn(win, `
    // Type into the first text block and put the caret in the middle.
    // The caret position must NOT matter: the picture goes after the
    // whole text block, so the paragraph is never cut in two.
    const ta = document.querySelector('.diary-block-text');
    ta.value = '在防波堤上坐到天黑，看远处的灯一盏一盏亮起来。';
    ta.focus();
    ta.setSelectionRange(6, 6);
    ta.dispatchEvent(new Event('input'));

    // Simulate the user right-clicking that block and picking
    // 「插入图片」, then picking a file. The editor drops the gallery
    // after the block and leaves the text whole.
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
    // The press on 保存 opens the metadata dialog: the time, the cast and
    // the first-time flag are asked for there, not on the page.
    const dialog = await window.__meta.open();
    const dialogState = {
      opened: !!dialog,
      hasTime: !!(dialog && dialog.querySelector('[data-role="occurred"]')),
      hasKind: !!(dialog && dialog.querySelector('input[name="diary-meta-kind"]')),
      contactCards: dialog ? dialog.querySelectorAll('.contact-pick').length : 0,
    };
    dialog.querySelector('[data-role="occurred"]').value = '2026-05-01T10:30';
    // Mark it as the first time, and pick one of the contacts.
    const firstRadio = dialog.querySelector('input[name="diary-meta-kind"][value="first_time"]');
    if (firstRadio) firstRadio.checked = true;
    const pick = dialog.querySelector('.contact-pick[data-id="c1"]');
    if (pick) pick.click();
    dialog.querySelector('[data-act="confirm"]').click();
    await new Promise(r => setTimeout(r, 250));

    const rows = Object.values(window.__testRows.all());
    const row = rows[0];

    return {
      order,
      blockCount: blocks.length,
      textWhole: blocks[0] && blocks[0].querySelector('.diary-block-text').value,
      hasGallery: !!document.querySelector('.diary-block-gallery'),
      galleryItems: document.querySelectorAll('.diary-gallery-item').length,
      content: row && row.content,
      notes: row && row.notes,
      title: row && row.title,
      background: row && row.background,
      dialogState,
      kind: row && row.kind,
      occurredAt: row && row.occurred_at,
      contactIds: row && row.contact_ids,
      navigated: location.hash,
    };
  `);
  check('the picture lands after the text block',
    mixResult.order, ['text', 'gallery']);
  check('the picture did not add a second text block',
    mixResult.blockCount, 2);
  checkTrue('the gallery block is rendered', mixResult.hasGallery);
  check('the gallery holds the one picked photo', mixResult.galleryItems, 1);
  // The caret was in the middle of the paragraph, and that must not
  // matter: the text block stays one whole piece.
  check('the text block is not cut in two by the picture',
    mixResult.textWhole, '在防波堤上坐到天黑，看远处的灯一盏一盏亮起来。');
  check('the saved document keeps the block order',
    mixResult.content.map(b => b.type), ['text', 'gallery']);
  check('the saved document keeps the whole text',
    mixResult.content[0].text, '在防波堤上坐到天黑，看远处的灯一盏一盏亮起来。');
  checkTrue('the saved document references a gallery of photos',
    mixResult.content[1] && mixResult.content[1].type === 'gallery' &&
    mixResult.content[1].photos.length === 1 && !!mixResult.content[1].photos[0].photo_id);
  check('a one-photo gallery uses the single layout',
    mixResult.content[1].layout, 'one');
  check('the plain text is mirrored into notes for search',
    mixResult.notes,
    '在防波堤上坐到天黑，看远处的灯一盏一盏亮起来。');
  check('the title is saved', mixResult.title, '第一次去海边');
  check('the chosen background is saved', mixResult.background, 'shadow');
  // The 保存 dialog asks for the metadata the page no longer carries.
  checkTrue('the save button opens the metadata dialog', mixResult.dialogState.opened);
  checkTrue('the dialog asks for the time', mixResult.dialogState.hasTime);
  checkTrue('the dialog asks whether this was the first time', mixResult.dialogState.hasKind);
  check('the dialog lists the contacts', mixResult.dialogState.contactCards, 2);
  check('the time chosen in the dialog is saved', mixResult.occurredAt, '2026-05-01 10:30:00');
  check('the first-time flag is saved', mixResult.kind, 'first_time');
  check('the contacts picked in the dialog are saved', mixResult.contactIds, ['c1']);
  checkTrue('the editor navigates away after saving',
    !!mixResult.navigated && mixResult.navigated.length > 1);

  // ---- 3a. Video and audio --------------------------------------------
  //
  // The document holds three kinds of thing now: words, pictures, and
  // media. A movie and a sound are inserted from the text block's
  // right-click menu, land AFTER the whole text block (the paragraph is
  // never cut in two), and are written into the saved document as
  // blocks of their own.
  console.log('\n== 视频与音频 ==');
  const mediaResult = await evalIn(win, `
    window.__testRows.clear();
    window.__testUploads.clear();

    // The previous section saved an entry, which navigated away and
    // replaced the page. Draw the editor again before driving it.
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '那天她唱了一首歌。';
    ta.focus();
    ta.dispatchEvent(new Event('input'));

    // The media picker is a SEPARATE input from the picture one — it
    // accepts movies and sounds, not images.
    const mediaInput = document.getElementById('diary-media');
    const hasMediaInput = !!mediaInput;
    const mediaAccept = mediaInput ? mediaInput.getAttribute('accept') : '';

    // Stub the picker: the click fires the change handler with a
    // synthetic file, the same path the real picker takes.
    let pickedKind = 'video';
    mediaInput.click = () => {
      const file = pickedKind === 'video'
        ? new File([new Uint8Array([1,2,3])], 'clip.mp4', { type: 'video/mp4' })
        : new File([new Uint8Array([4,5,6])], 'song.mp3', { type: 'audio/mpeg' });
      Object.defineProperty(mediaInput, 'files', { value: [file], configurable: true });
      mediaInput.dispatchEvent(new Event('change'));
    };

    // Right-click the text block and pick 「插入视频」.
    window.__menu.open(ta);
    const menuActs = window.__menu.items().map(i => i.act);
    window.__menu.click('[data-ctx-act="insert-video"]');
    await new Promise(r => setTimeout(r, 80));

    const afterVideo = Array.from(document.querySelectorAll('.diary-block'))
      .map(b => b.dataset.blockType);
    const videoPlayer = document.querySelector('.diary-block-video video');

    // Now the sound, right-clicking the same block again.
    pickedKind = 'audio';
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-audio"]');
    await new Promise(r => setTimeout(r, 80));

    const afterAudio = Array.from(document.querySelectorAll('.diary-block'))
      .map(b => b.dataset.blockType);
    const audioPlayer = document.querySelector('.diary-block-audio audio');

    // The text is read BEFORE the save: saving navigates away and the
    // page is replaced.
    const textWhole = document.querySelector('.diary-block-text')
      ? document.querySelector('.diary-block-text').value : null;

    // Save and look at the stored document.
    document.getElementById('diary-title').value = '有视频的一篇';
    await window.__meta.confirm('2026-05-03T10:30', 'other', []);
    await new Promise(r => setTimeout(r, 120));

    const rows = Object.values(window.__testRows.all());
    const row = rows[rows.length - 1];
    const uploads = window.__testUploads.all();

    return {
      hasMediaInput, mediaAccept, menuActs,
      afterVideo, afterAudio,
      hasVideoPlayer: !!videoPlayer,
      hasAudioPlayer: !!audioPlayer,
      videoHasControls: !!(videoPlayer && videoPlayer.controls),
      audioHasControls: !!(audioPlayer && audioPlayer.controls),
      textWhole,
      content: row && row.content,
      uploadCount: uploads.length,
      uploadMimes: uploads.map(u => u.mime),
      uploadNames: uploads.map(u => u.original_name),
    };
  `);
  checkTrue('the page has a media picker of its own', mediaResult.hasMediaInput);
  checkTrue('the media picker takes movies and sounds',
    (mediaResult.mediaAccept || '').includes('video') &&
    (mediaResult.mediaAccept || '').includes('audio'));
  checkTrue('the text menu offers 插入视频 and 插入音频',
    mediaResult.menuActs.includes('insert-video') &&
    mediaResult.menuActs.includes('insert-audio'));
  // The media goes AFTER the whole text block, the same rule a picture
  // follows: the paragraph is never cut in two.
  check('the video lands after the text block',
    mediaResult.afterVideo, ['text', 'video']);
  check('the sound lands after the text block too',
    mediaResult.afterAudio, ['text', 'video', 'audio']);
  checkTrue('the video is a player', mediaResult.hasVideoPlayer);
  checkTrue('the sound is a player', mediaResult.hasAudioPlayer);
  checkTrue('the video has its own controls', mediaResult.videoHasControls);
  checkTrue('the sound has its own controls', mediaResult.audioHasControls);
  check('the text block is not cut in two by the media',
    mediaResult.textWhole, '那天她唱了一首歌。');
  // The saved document names the media blocks and nothing else.
  check('the saved document keeps the block order',
    mediaResult.content.map(b => b.type), ['text', 'video', 'audio']);
  checkTrue('the saved document references the movie',
    mediaResult.content[1] && mediaResult.content[1].type === 'video' &&
    !!mediaResult.content[1].media_id);
  checkTrue('the saved document references the sound',
    mediaResult.content[2] && mediaResult.content[2].type === 'audio' &&
    !!mediaResult.content[2].media_id);
  // Both files went up, and each kept its own type.
  check('both media files were uploaded', mediaResult.uploadCount, 2);
  check('the uploads kept their types',
    mediaResult.uploadMimes.sort(), ['audio/mpeg', 'video/mp4']);
  check('the uploads kept their names',
    mediaResult.uploadNames.sort(), ['clip.mp4', 'song.mp3']);

  // ---- 3c. The media's own menu ----------------------------------------
  //
  // A movie and a sound are things on the page, so they carry the same
  // menu the pictures carry: the insertions above and below, the ways to
  // put another file in, and the commands that act on the file itself.
  //
  // The media also has to PLAY. A file the user has just picked is still
  // in the browser's hands, so the player is pointed at a blob: URL —
  // that is what makes the movie play before it is saved.
  console.log('\n== 媒体的右键菜单 ==');
  const mediaMenuResult = await evalIn(win, `
    window.__testRows.clear();
    window.__testUploads.clear();

    // The previous section saved an entry, which navigated away and
    // replaced the page. Draw the editor again before driving it.
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '那天她唱了一首歌。';
    ta.focus();
    ta.dispatchEvent(new Event('input'));

    const mediaInput = document.getElementById('diary-media');
    mediaInput.click = () => {
      const file = new File([new Uint8Array([1,2,3])], 'clip.mp4', { type: 'video/mp4' });
      Object.defineProperty(mediaInput, 'files', { value: [file], configurable: true });
      mediaInput.dispatchEvent(new Event('change'));
    };

    // Put a movie on the page.
    window.__menu.open(ta);
    window.__menu.click('[data-ctx-act="insert-video"]');
    await new Promise(r => setTimeout(r, 120));

    const videoWrap = document.querySelector('.diary-block-video');
    const player = videoWrap ? videoWrap.querySelector('video') : null;
    // A picked file has no url on disk yet — the player is pointed at a
    // blob: URL so the movie plays straight away.
    const src = player ? (player.getAttribute('src') || '') : '';
    const isBlob = src.startsWith('blob:');

    // The blob actually points at the picked bytes: a blob url that
    // resolves must be able to read the file back.
    let blobReadable = false;
    if (isBlob) {
      try {
        const fetched = await fetch(src);
        blobReadable = fetched.ok && (await fetched.arrayBuffer()).byteLength === 3;
      } catch (e) { blobReadable = false; }
    }

    // And the browser accepts the picked file AS MEDIA. The picked file
    // here is three bytes of nonsense, so it cannot really decode — the
    // real playback check lives in the real-backend test, which has a
    // real movie to play.
    const blobAsMedia = player
      ? player.canPlayType('video/mp4')
      : '';

    // Right-click the movie.
    const menuActs = window.__menu.open(videoWrap).map(i => i.act);
    const menuLabels = window.__menu.items().map(i => i.label);

    // 「↓ 下方插入文字」 puts a text block under the movie.
    window.__menu.click('[data-ctx-act="media-insert-after"]');
    await new Promise(r => setTimeout(r, 60));
    const afterText = Array.from(document.querySelectorAll('.diary-block'))
      .map(b => b.dataset.blockType);

    // 「↑ 上方插入文字」 puts one above it. The page was redrawn, so the
    // movie is looked up again — the old node is off the page.
    window.__menu.open(document.querySelector('.diary-block-video'));
    window.__menu.click('[data-ctx-act="media-insert-before"]');
    await new Promise(r => setTimeout(r, 60));
    const afterTextBoth = Array.from(document.querySelectorAll('.diary-block'))
      .map(b => b.dataset.blockType);

    return {
      hasVideo: !!videoWrap,
      src, isBlob, blobReadable, blobAsMedia,
      menuActs, menuLabels,
      afterText, afterTextBoth,
    };
  `);
  checkTrue('the movie is on the page', mediaMenuResult.hasVideo);
  // The player points at the picked file, so the movie plays before it
  // is saved.
  checkTrue('the player is pointed at the picked file', mediaMenuResult.isBlob,
    mediaMenuResult.src);
  checkTrue('the picked file is readable through that url', mediaMenuResult.blobReadable);
  checkTrue('the browser accepts the picked file as media',
    !!mediaMenuResult.blobAsMedia, String(mediaMenuResult.blobAsMedia));
  // The menu carries the same insertions the pictures carry.
  checkTrue('the media menu offers to insert a picture',
    mediaMenuResult.menuActs.includes('media-insert-image'));
  checkTrue('the media menu offers to insert a movie',
    mediaMenuResult.menuActs.includes('media-insert-video'));
  checkTrue('the media menu offers to insert a sound',
    mediaMenuResult.menuActs.includes('media-insert-audio'));
  checkTrue('the media menu offers a text block above',
    mediaMenuResult.menuActs.includes('media-insert-before'));
  checkTrue('the media menu offers a text block below',
    mediaMenuResult.menuActs.includes('media-insert-after'));
  checkTrue('the media menu offers to play and to copy the link',
    mediaMenuResult.menuActs.includes('media-play') &&
    mediaMenuResult.menuActs.includes('media-copy-link'));
  checkTrue('the media menu offers to remove the media',
    mediaMenuResult.menuActs.includes('media-remove'));
  checkTrue('the media menu says 「↑ 上方插入文字」',
    mediaMenuResult.menuLabels.includes('↑ 上方插入文字'));
  checkTrue('the media menu says 「↓ 下方插入文字」',
    mediaMenuResult.menuLabels.includes('↓ 下方插入文字'));
  // The text block lands under the movie, then above it.
  check('a text block can be inserted below the media',
    mediaMenuResult.afterText, ['text', 'video', 'text']);
  check('a text block can be inserted above the media',
    mediaMenuResult.afterTextBoth, ['text', 'text', 'video', 'text']);

  // ---- 3b. The 保存 dialog --------------------------------------------
  //
  // The metadata the page no longer carries — the time, the cast and the
  // first-time flag — is asked for in a dialog. Editing an existing entry
  // must open the dialog PREFILLED with what the entry already says, and
  // dismissing the dialog must write nothing.
  console.log('\n== 保存对话框 ==');
  const dialogResult = await evalIn(win, `
    window.__testRows.clear();
    window.__testRows.seed('ed-1', {
      id: 'ed-1',
      kind: 'first_time',
      title: '改过的那篇',
      occurred_at: '2026-04-01 09:15:00',
      background: 'light',
      notes: '一段旧正文',
      contact_ids: ['c2'],
      content: JSON.stringify([{ type: 'text', text: '一段旧正文' }]),
      photos: [],
    });

    // Open the existing entry.
    await window.__editor.render({ id: 'ed-1' }, {});
    await new Promise(r => setTimeout(r, 120));

    const dialog = await window.__meta.open();
    const prefill = {
      title: document.getElementById('diary-title').value,
      occurred: dialog.querySelector('[data-role="occurred"]').value,
      kind: dialog.querySelector('input[name="diary-meta-kind"]:checked')?.value,
      selected: Array.from(dialog.querySelectorAll('.contact-pick.selected'))
        .map(el => el.dataset.id),
      count: dialog.querySelector('[data-role="count"]').textContent.trim(),
    };

    // Dismiss the dialog — nothing may be written.
    const before = Object.keys(window.__testRows.all()).length;
    dialog.querySelector('[data-act="cancel"]').click();
    await new Promise(r => setTimeout(r, 150));
    const after = Object.keys(window.__testRows.all()).length;
    const stillOpen = !!document.querySelector('.diary-meta-modal-backdrop');

    // The time is required: an empty time keeps the dialog open.
    const dialog2 = await window.__meta.open();
    dialog2.querySelector('[data-role="occurred"]').value = '';
    dialog2.querySelector('[data-act="confirm"]').click();
    await new Promise(r => setTimeout(r, 120));
    const keptOpen = !!document.querySelector('.diary-meta-modal-backdrop');
    // Close it for real so the next test starts clean.
    const dialog3 = document.querySelector('.diary-meta-modal-backdrop');
    if (dialog3) dialog3.querySelector('[data-act="cancel"]').click();
    await new Promise(r => setTimeout(r, 120));

    // A second press on 保存 while the dialog is up must not stack a
    // second dialog on top of the first one.
    const twice = await window.__meta.openTwice();
    const dialog4 = document.querySelector('.diary-meta-modal-backdrop');
    if (dialog4) dialog4.querySelector('[data-act="cancel"]').click();
    await new Promise(r => setTimeout(r, 120));

    return { prefill, rowsBefore: before, rowsAfter: after, stillOpen,
             keptOpen, dialogsLeft: document.querySelectorAll('.diary-meta-modal-backdrop').length,
             twice };
  `);
  check('the dialog opens with the entry\'s title on the page',
    dialogResult.prefill.title, '改过的那篇');
  check('the dialog is prefilled with the entry\'s time',
    dialogResult.prefill.occurred, '2026-04-01T09:15');
  check('the dialog is prefilled with the entry\'s first-time flag',
    dialogResult.prefill.kind, 'first_time');
  check('the dialog is prefilled with the entry\'s contacts',
    dialogResult.prefill.selected, ['c2']);
  check('the dialog counts the selected contacts',
    dialogResult.prefill.count, '已选 1 人');
  check('dismissing the dialog writes nothing',
    dialogResult.rowsAfter, dialogResult.rowsBefore);
  checkTrue('dismissing the dialog closes it', !dialogResult.stillOpen);
  checkTrue('an empty time keeps the dialog open', dialogResult.keptOpen);
  check('no dialog is left on the page', dialogResult.dialogsLeft, 0);
  check('a second press on 保存 does not open a second dialog',
    dialogResult.twice.dialogs, 1);
  checkTrue('the guard knows the dialog is open', dialogResult.twice.open);

  // ---- 3c. The dialog's typography ------------------------------------
  //
  // The app's global `label` rule is a 12px muted caption with a top
  // margin — wrong for this dialog, where the radios are CHOICES and have
  // to read as content. The dialog sets its own type scale, and the
  // removed hint lines must not leave their spacing behind.
  console.log('\n== 对话框排版 ==');
  const typeResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 120));
    // The editor refuses to save an empty entry, so the dialog is only
    // reachable once there is something to save.
    document.getElementById('diary-title').value = '排版检查';
    const dialog = await window.__meta.open();

    const px = (el, prop) => el ? Math.round(parseFloat(getComputedStyle(el)[prop])) : null;
    const label = dialog.querySelector('.diary-meta-label');
    const radio = dialog.querySelector('.diary-meta-radio');
    const radioText = radio && radio.querySelector('span');
    const name = dialog.querySelector('.contact-pick-name');
    const count = dialog.querySelector('[data-role="count"]');
    const input = dialog.querySelector('[data-role="occurred"]');

    // The three labels of the dialog.
    const labels = Array.from(dialog.querySelectorAll('.diary-meta-label'))
      .map(el => el.textContent.trim());
    // The hint lines are gone — they only repeated what the control said.
    const metas = Array.from(dialog.querySelectorAll('.meta')).map(el => el.textContent.trim());

    // The measurements have to be taken while the dialog is still on the
    // page: a detached element has no computed style and no geometry.
    const measured = {
      labelSize: px(label, 'fontSize'),
      labelColor: getComputedStyle(label).color,
      radioSize: px(radioText, 'fontSize'),
      radioColor: getComputedStyle(radioText).color,
      // The radio label must sit INLINE with its radio, not on its own line.
      // The display value is blockified to flex because the label is a flex
      // item, so the real check is geometric: the radio and its text
      // share a row.
      radioDisplay: getComputedStyle(radio).display,
      radioAlign: getComputedStyle(radio).alignItems,
      radioSameLine: (() => {
        const box = radio.getBoundingClientRect();
        const radioInput = radio.querySelector('input').getBoundingClientRect();
        const span = radio.querySelector('span').getBoundingClientRect();
        return Math.abs(radioInput.top - span.top) < radioInput.height / 2
          && radioInput.right <= span.left + 1;
      })(),
      nameSize: px(name, 'fontSize'),
      countSize: px(count, 'fontSize'),
      inputSize: px(input, 'fontSize'),
      // The label and its control are close together — the global rule's
      // 10px top margin used to push them apart.
      labelGap: Math.round(
        input.getBoundingClientRect().top - label.getBoundingClientRect().bottom),
    };

    // Close it so the next test starts from a clean page.
    dialog.querySelector('[data-act="cancel"]').click();
    await new Promise(r => setTimeout(r, 120));

    return Object.assign({ labels, metas }, measured);
  `);
  check('the dialog asks three questions', typeResult.labels,
    ['事件发生时间', '是否第一次', '关联联系人']);
  if (typeResult && typeResult.__threw) console.log('  (threw)', typeResult.__threw);
  check('the dialog has no hint lines left', typeResult.metas, []);
  check('a question is a 13px caption', typeResult.labelSize, 13);
  check('a radio choice is 14px — content, not a caption', typeResult.radioSize, 14);
  check('a radio choice is not muted', typeResult.radioColor, 'rgb(42, 42, 42)');
  check('a radio label sits inline with its radio', typeResult.radioDisplay, 'flex');
  checkTrue('the radio and its text share one row', typeResult.radioSameLine);
  check('a radio label is centred on its radio', typeResult.radioAlign, 'center');
  check('a contact name is 14px', typeResult.nameSize, 14);
  check('the running count is 12px', typeResult.countSize, 12);
  check('the time input is 14px', typeResult.inputSize, 14);
  checkTrue('a question sits right above its control',
    typeResult.labelGap >= 0 && typeResult.labelGap <= 12,
    'gap was ' + typeResult.labelGap);

  // ---- 4. Multi-image: many photos, a layout, and a dragged size -----
  console.log('\n== 多图与排版 ==');
  const multiResult = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '那天拍了很多张。';
    ta.focus();
    // The caret goes to the end, so the note stays one paragraph.
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
    await window.__meta.confirm('2026-05-02T10:30', 'other', []);

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
    await window.__meta.confirm('2026-05-03T10:30', 'other', []);

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
    ['insert-image', 'insert-video', 'insert-audio', 'delete-block']
      .every(a => menuResult.afterPress.acts.includes(a)), true);
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
        { type: 'video', media_id: 'mv1' },
        { type: 'text', text: '到天黑，看远处的灯一盏一盏亮起来。' },
        { type: 'audio', media_id: 'ma1' },
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
      // bottom — so the sheet keeps the editor's three layers. The strip
      // itself carries the date ALONE; the rest of the facts wait for
      // the pointer and live in the ghost.
      metaInFoot: document.querySelector('.memorial-card-foot')
        .textContent.trim(),
      ghost: !!document.querySelector('.memorial-card-ghost'),
      ghostText: document.querySelector('.memorial-card-ghost')
        ? document.querySelector('.memorial-card-ghost').textContent.trim()
        : '',
      ghostOpacity: document.querySelector('.memorial-card-ghost')
        ? getComputedStyle(document.querySelector('.memorial-card-ghost')).opacity
        : '',
      metaRows: document.querySelectorAll('.memorial-card-meta').length,
      footBg: getComputedStyle(document.querySelector('.memorial-card-foot'))
        .backgroundColor,
      // The date is set in the title bar's own type, so the strip reads
      // as a second line of the title rather than as a footnote.
      footFontSize: getComputedStyle(
        document.querySelector('.memorial-card-foot')).fontSize,
      footFontWeight: getComputedStyle(
        document.querySelector('.memorial-card-foot')).fontWeight,
      titleFontSize: getComputedStyle(
        document.querySelector('.memorial-card-header')).fontSize,
      titleFontWeight: getComputedStyle(
        document.querySelector('.memorial-card-header')).fontWeight,
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
      // A movie and a sound inside the card are MARKS, not live players:
      // the card is a thumbnail, and a player at that scale would be a
      // speck of controls pulling the whole file into the list page.
      mediaMarks: Array.from(document.querySelectorAll('.memorial-card-media'))
        .map(el => el.dataset.mediaKind),
      hasVideoPlayer: !!document.querySelector('.memorial-card-video video'),
      hasAudioPlayer: !!document.querySelector('.memorial-card-audio audio'),
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
    ['memorial-card-header', 'memorial-card-body', 'memorial-card-foot',
     'memorial-card-ghost']);
  check('the card shows the entry title', cardResult.title, '第一次去海边');
  check('the card paints the entry\'s own background style',
    cardResult.sheetVar, '#77613b');
  checkTrue('the header bar has a height', cardResult.headerBg > 0);
  // The document's blocks keep their order: text, gallery, video, text,
  // audio, gallery.
  check('the card keeps the document\'s block order',
    cardResult.blocks,
    ['memorial-card-text', 'memorial-card-gallery',
     'memorial-card-media memorial-card-video',
     'memorial-card-text',
     'memorial-card-media memorial-card-audio',
     'memorial-card-gallery']);
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
  // The strip carries the date ALONE. It is the one fact a reader scans
  // a card for, so it is the one fact that stays on the page at rest.
  check('the strip shows the date and nothing else',
    cardResult.metaInFoot, '2026-05-01');
  // The date is set in the title bar's own type, so the strip reads as a
  // second line of the title rather than as a footnote in a smaller voice.
  check('the date is set like the title',
    [cardResult.footFontSize, cardResult.footFontWeight],
    [cardResult.titleFontSize, cardResult.titleFontWeight]);
  // The rest of the facts wait for the pointer and ride in the ghost.
  check('the card has a hovering ghost', cardResult.ghost, true);
  checkTrue('the ghost names the contacts and the kind',
    cardResult.ghostText.includes('小明 等 2 人')
    && cardResult.ghostText.includes('其他'));
  check('the ghost is invisible until the pointer arrives',
    cardResult.ghostOpacity, '0');
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
  // A movie and a sound inside the card are marks, not live players: the
  // card is a thumbnail, and a player at that scale would be a speck of
  // controls that pulled the whole file into the list page.
  check('the card marks the movie and the sound',
    cardResult.mediaMarks, ['video', 'audio']);
  checkTrue('the card carries no live player',
    !cardResult.hasVideoPlayer && !cardResult.hasAudioPlayer);

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

  // ---- 13. The filter bar ------------------------------------------------
  //
  // The list is filtered by three independent axes — 时间 / 联系人 / 类型
  // — which compose with the free-text search box. All four are applied
  // client-side over the cached rows, so a change is instant.
  console.log('\n== 回忆事件筛选 ==');
  const filterResult = await evalIn(win, `
    window.__testRows.clear();
    // Three entries, one per axis, so each filter has something to
    // single out. The dates are relative to today so the 时间 buckets
    // pick them apart.
    const today = new Date();
    const ymd = (d) => d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
    const daysAgo = (n) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      d.setDate(d.getDate() - n);
      return ymd(d) + ' 10:00:00';
    };
    const longAgo = (today.getFullYear() - 3) + '-03-15 10:00:00';

    window.__testRows.seed('f-recent', {
      id: 'f-recent', kind: 'first_time', title: '最近的一次',
      occurred_at: daysAgo(2), background: 'light',
      contact_ids: ['c1'], contact_names: ['小明'], photo_count: 0,
      notes: '',
    });
    window.__testRows.seed('f-old', {
      id: 'f-old', kind: 'other', title: '很久以前',
      occurred_at: longAgo, background: 'light',
      contact_ids: ['c2'], contact_names: ['小红'], photo_count: 0,
      notes: '',
    });
    window.__testRows.seed('f-middle', {
      id: 'f-middle', kind: 'other', title: '中间的一次',
      occurred_at: daysAgo(60), background: 'light',
      contact_ids: ['c1'], contact_names: ['小明'], photo_count: 0,
      notes: '',
    });

    await window.__list.render([], {});
    await new Promise(r => setTimeout(r, 150));

    const titles = () => Array.from(document.querySelectorAll('.memorial-card-title'))
      .map(el => el.textContent.trim());

    // The bar is there, with its three dropdowns.
    const bar = {
      hasBar: !!document.querySelector('.memorial-filters'),
      selects: Array.from(document.querySelectorAll('.memorial-filters select'))
        .map(el => el.id),
      labels: Array.from(document.querySelectorAll('.memorial-filter-label'))
        .map(el => el.textContent.trim()),
      timeOptions: Array.from(
        document.querySelector('#memorial-filter-time').options).map(o => o.value),
      contactOptions: Array.from(
        document.querySelector('#memorial-filter-contact').options).map(o => o.value),
      kindOptions: Array.from(
        document.querySelector('#memorial-filter-kind').options).map(o => o.value),
      resetHidden: document.getElementById('memorial-filter-reset').style.display,
      all: titles(),
    };

    // 时间: 最近 30 天 keeps only the recent entry.
    const timeSel = document.getElementById('memorial-filter-time');
    timeSel.value = '30d';
    timeSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    bar.byTime = titles();
    bar.timeMeta = document.getElementById('memorial-filter-meta').textContent.trim();
    bar.resetShown = document.getElementById('memorial-filter-reset').style.display;

    // 联系人: 小明 keeps the two entries that name them.
    const contactSel = document.getElementById('memorial-filter-contact');
    contactSel.value = 'c1';
    contactSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    bar.byTimeAndContact = titles();

    // 类型: 是第一次 keeps only the first-time entry.
    const kindSel = document.getElementById('memorial-filter-kind');
    kindSel.value = 'first_time';
    kindSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    bar.byAll = titles();

    // The URL carries the whole filter state, so the view can be shared.
    bar.hash = location.hash;

    // 重置筛选 puts every dropdown back to 不限.
    document.getElementById('memorial-filter-reset').click();
    await new Promise(r => setTimeout(r, 60));
    bar.afterReset = titles();
    bar.afterResetValues = {
      time: document.getElementById('memorial-filter-time').value,
      contact: document.getElementById('memorial-filter-contact').value,
      kind: document.getElementById('memorial-filter-kind').value,
    };
    bar.afterResetHash = location.hash;

    // A filter that matches nothing says so, and says how many it hid.
    // The only first-time entry belongs to 小明, so "是第一次" + "小红"
    // is a combination no entry can satisfy.
    kindSel.value = 'first_time';
    kindSel.dispatchEvent(new Event('change', { bubbles: true }));
    contactSel.value = 'c2';
    contactSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    bar.emptyText = document.querySelector('#memorial-list .empty')
      ? document.querySelector('#memorial-list .empty').textContent.trim() : '';
    bar.emptyCount = document.querySelectorAll('.memorial-card').length;

    return bar;
  `);

  checkTrue('the filter bar is on the page', filterResult.hasBar);
  check('the bar carries three dropdowns', filterResult.selects,
    ['memorial-filter-time', 'memorial-filter-contact', 'memorial-filter-kind']);
  check('the dropdowns are labelled', filterResult.labels,
    ['时间', '联系人', '类型']);
  check('the 时间 dropdown offers the buckets', filterResult.timeOptions,
    ['', '7d', '30d', '90d', '365d', 'this_year', 'last_year', 'older']);
  check('the 联系人 dropdown lists the contacts', filterResult.contactOptions,
    ['', 'c1', 'c2']);
  check('the 类型 dropdown offers both kinds', filterResult.kindOptions,
    ['', 'first_time', 'other']);
  check('the reset button is hidden while nothing is filtered',
    filterResult.resetHidden, 'none');
  check('all three entries are listed to begin with', filterResult.all.length, 3);

  check('时间: 最近 30 天 keeps only the recent entry',
    filterResult.byTime, ['最近的一次']);
  check('the filter bar counts what it kept',
    filterResult.timeMeta, '1 / 3 条');
  checkTrue('the reset button appears once a filter is on',
    filterResult.resetShown !== 'none');
  check('时间 ∩ 联系人 keeps the two 小明 entries',
    filterResult.byTimeAndContact.length, 1);
  checkTrue('时间 ∩ 联系人 ∩ 类型 leaves only the first-time entry',
    filterResult.byAll.length === 1
    && filterResult.byAll[0] === '最近的一次');
  checkTrue('the URL carries the filter state',
    /time=30d/.test(filterResult.hash)
    && /contact=c1/.test(filterResult.hash)
    && /kind=first_time/.test(filterResult.hash));
  check('重置筛选 restores every dropdown', filterResult.afterResetValues,
    { time: '', contact: '', kind: '' });
  check('重置筛选 restores the full list', filterResult.afterReset.length, 3);
  checkTrue('重置筛选 clears the URL parameters',
    !/time=|contact=|kind=/.test(filterResult.afterResetHash));
  checkTrue('an empty result says so',
    /没有符合筛选条件/.test(filterResult.emptyText));
  check('an empty result shows no cards', filterResult.emptyCount, 0);

  // ---- 14. The toolbar ---------------------------------------------------
  //
  // The header, the search pill and the filter strip are one warm panel.
  // The test pins the SHAPE of that panel — the group that holds the
  // three controls, the pill around the search field, the icon slots and
  // the hairline dividers — so a later change that quietly drops one of
  // them shows up here rather than as a surprise screenshot.
  console.log('\n== 回忆事件工具栏 ==');
  const toolbarResult = await evalIn(win, `
    window.__testRows.clear();
    window.__testRows.seed('tb-1', {
      id: 'tb-1', kind: 'first_time', title: '一条回忆',
      occurred_at: '2026-05-01 10:00:00', background: 'light',
      contact_ids: ['c1'], contact_names: ['小明'], photo_count: 0,
      notes: '正文',
    });
    await window.__list.render([], {});
    await new Promise(r => setTimeout(r, 150));

    const q = (sel) => document.querySelector(sel);
    const cs = (sel, prop) => {
      const el = q(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };

    // The panel holds all three controls.
    const panel = q('#memorial-toolbar');
    const panelBox = panel.getBoundingClientRect();
    const head = q('.memorial-toolbar-head').getBoundingClientRect();
    const search = q('.memorial-search').getBoundingClientRect();
    const strip = q('.memorial-filters').getBoundingClientRect();

    // The search field is a pill with the icon inside it, not an input
    // flanked by two buttons.
    const field = q('.memorial-search-field');
    const fieldBox = field.getBoundingClientRect();
    const iconBox = q('.memorial-search-icon').getBoundingClientRect();
    const inputBox = q('#memorial-q').getBoundingClientRect();

    // The three dropdown groups are separated by hairlines.
    const groups = Array.from(document.querySelectorAll('.memorial-filter'));

    // The clear button is hidden while the search is empty, so type
    // something first and let the list repaint — a hidden button has no
    // box to measure.
    const input = q('#memorial-q');
    input.value = '一条';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const clearRect = q('#memorial-clear').getBoundingClientRect();

    return {
      hasPanel: !!panel,
      panelBg: cs('#memorial-toolbar', 'backgroundColor'),
      panelRadius: cs('#memorial-toolbar', 'borderRadius'),
      // The three controls stack down the panel, in order.
      stacked: head.bottom <= search.top + 1 && search.bottom <= strip.top + 1,
      // And they all live INSIDE the panel.
      inside: head.top >= panelBox.top - 1
        && strip.bottom <= panelBox.bottom + 1,

      fieldRadius: cs('.memorial-search-field', 'borderRadius'),
      fieldBg: cs('.memorial-search-field', 'backgroundColor'),
      hasIcon: !!q('.memorial-search-icon'),
      // The icon sits inside the field, to the left of the input.
      iconInside: iconBox.left >= fieldBox.left - 1
        && iconBox.right <= inputBox.left + 1,
      // The clear button is inside the pill too.
      clearInside: clearRect.left >= fieldBox.left - 1
        && clearRect.right <= fieldBox.right + 1,
      // The native WebKit cancel button is suppressed, so the pill has
      // exactly one clear affordance.
      clearIsRound: cs('#memorial-clear', 'borderRadius'),

      hasFunnel: !!q('.memorial-filter-funnel'),
      leadText: q('.memorial-filter-lead')
        ? q('.memorial-filter-lead').textContent.trim() : '',
      groupCount: groups.length,
      // Every group but the first carries the hairline divider.
      dividers: groups.slice(1).map(g =>
        getComputedStyle(g, '::before').width),

      // The title carries its doodle.
      hasArt: !!q('.memorial-title-art'),
      artWidth: q('.memorial-title-art')
        ? Math.round(q('.memorial-title-art').getBoundingClientRect().width) : 0,
      titleText: q('.memorial-title')
        ? q('.memorial-title').textContent.trim() : '',
    };
  `);

  checkTrue('the toolbar panel is on the page', toolbarResult.hasPanel);
  checkTrue('the panel is painted in the warm peach tone',
    /rgb\(253, 242, 234\)/.test(toolbarResult.panelBg));
  check('the panel is a rounded card', toolbarResult.panelRadius, '18px');
  checkTrue('the three controls stack in order', toolbarResult.stacked);
  checkTrue('all three controls live inside the panel', toolbarResult.inside);

  check('the search field is a pill', toolbarResult.fieldRadius, '999px');
  checkTrue('the search field is white', toolbarResult.fieldBg.includes('255, 255, 255'));
  checkTrue('the search field carries its magnifier', toolbarResult.hasIcon);
  checkTrue('the magnifier rides inside the field', toolbarResult.iconInside);
  checkTrue('the clear button rides inside the field', toolbarResult.clearInside);
  checkTrue('the clear button is a round chip',
    toolbarResult.clearIsRound === '50%');

  checkTrue('the filter strip carries its funnel', toolbarResult.hasFunnel);
  check('the strip leads with 筛选条件', toolbarResult.leadText, '筛选条件');
  check('the strip carries three filter groups', toolbarResult.groupCount, 3);
  checkTrue('the groups are divided by hairlines',
    toolbarResult.dividers.every((w) => w === '1px'));

  checkTrue('the title carries its doodle', toolbarResult.hasArt);
  checkTrue('the doodle has width', toolbarResult.artWidth > 40);
  checkTrue('the title still reads 回忆事件',
    /回忆事件/.test(toolbarResult.titleText));

  // ---- 15. The bulk-select round trip ------------------------------------
  //
  // Entering select mode repaints the list subtree, and the bulk toolbar
  // is part of that subtree — so the 「退出选择」 button the user clicks is
  // a NEW node, with none of the handlers the old one had. Binding the
  // toolbar only at mount time left the button dead.
  //
  // This walks the whole round trip and checks that select mode can
  // actually be entered AND left.
  console.log('\n== 回忆事件批量选择 ==');
  const bulkResult = await evalIn(win, `
    const q = (sel) => document.querySelector(sel);
    const state = { };

    // Enter select mode through the 「批量删除」 link.
    q('[data-bulk-enter]').click();
    await new Promise(r => setTimeout(r, 250));
    state.toolbarShown = !!q('[data-bulk-toolbar]');
    state.checkboxShown = !!q('.bulk-row-check');

    // The exit button must be LIVE — a bound handler, not just a node.
    const exit = q('[data-bulk-exit]');
    state.exitExists = !!exit;
    state.exitHasHandler = !!(exit && exit.onclick);

    // ...and clicking it must actually leave select mode.
    if (exit) exit.click();
    await new Promise(r => setTimeout(r, 250));
    state.toolbarGone = !q('[data-bulk-toolbar]');
    state.checkboxGone = !q('.bulk-row-check');
    // The title row must come back intact.
    state.artBack = !!q('.memorial-title-art');
    state.exportBack = !!q('#open-export');
    state.newBack = !!q('#new-event');
    state.bulkLinkBack = !!q('[data-bulk-enter]');
    state.headClass = q('#page-header') ? q('#page-header').className : '';
    state.cards = document.querySelectorAll('.memorial-card').length;
    return state;
  `);

  checkTrue('select mode shows the bulk toolbar', bulkResult.toolbarShown);
  checkTrue('select mode puts a checkbox on each card', bulkResult.checkboxShown);
  checkTrue('the exit button is on the page', bulkResult.exitExists);
  checkTrue('the exit button is wired to a handler', bulkResult.exitHasHandler);
  checkTrue('leaving select mode takes the toolbar away', bulkResult.toolbarGone);
  checkTrue('leaving select mode takes the checkboxes away', bulkResult.checkboxGone);
  checkTrue('the title doodle comes back', bulkResult.artBack);
  checkTrue('the export button comes back', bulkResult.exportBack);
  checkTrue('the new button comes back', bulkResult.newBack);
  checkTrue('the bulk entry link comes back', bulkResult.bulkLinkBack);
  check('the title row keeps its class', bulkResult.headClass,
    'memorial-toolbar-head');
  check('the cards survive the round trip', bulkResult.cards, 1);

  // ---- 16. A link to a memory that is gone -----------------------------
  //
  // The 抽卡人生 page and the 打卡墙 both link to a 回忆记录 by its id.
  // That entry can be deleted, and the link can be stale. The editor used
  // to answer with a dead end — 「这篇回忆不存在或已被删除。」 — which left
  // the user with no way to write the memory the link was asking for.
  //
  // Now the editor writes a NEW entry instead, pre-filled from the card
  // the link carries, and links it back to that card when it is saved.
  console.log('\n== 回忆不存在时改写 ==');
  const missingResult = await evalIn(win, `
    window.__testRows.clear();
    window.__testCards.clear();
    window.__testCards.seed('draw-7', {
      id: 'draw-7',
      week_key: '2026-01-05',
      card_no: 7,
      title: '给一个曾经重要、如今失联的人写一封信',
      requirement: '写完寄出去，或者至少写完。',
      source: 'deck',
    });

    // The link names an entry that is not there.
    await window.__editor.render({ id: 'gone-1' }, { draw: 'draw-7' });
    await new Promise(r => setTimeout(r, 120));

    const q = (sel) => document.querySelector(sel);
    const banner = q('.diary-missing-banner');
    return {
      // The page is a working editor, not an error message.
      isEditor: !!q('#diary-page'),
      title: (q('#diary-title') || {}).value || '',
      hasBlocks: !!q('#diary-blocks'),
      canSave: !!q('#save'),
      // A missing entry has nothing to delete.
      hasDelete: !!q('#del'),
      // The banner says what happened.
      banner: !!banner,
      bannerText: banner ? banner.textContent.replace(/\\s+/g, ' ').trim() : '',
      // The card the link named pre-fills the page, so the user is
      // writing THAT card's memory and not a blank page.
      bodyText: (q('.diary-block-text') || {}).value || '',
      // The back link still goes somewhere sensible.
      back: (q('.back-link') || {}).getAttribute ? q('.back-link').getAttribute('href') : '',
    };
  `);

  checkTrue('a missing entry still opens the editor', missingResult.isEditor);
  checkTrue('the editor has a body', missingResult.hasBlocks);
  checkTrue('the editor can be saved', missingResult.canSave);
  checkTrue('a missing entry offers no delete button', !missingResult.hasDelete);
  checkTrue('the page says the memory is gone', missingResult.banner);
  checkTrue('the banner explains it',
    /已经不在了|重新写/.test(missingResult.bannerText), missingResult.bannerText);
  checkTrue('the card pre-fills the title',
    /写一封信/.test(missingResult.title), missingResult.title);
  checkTrue('the card pre-fills the body',
    /寄出去/.test(missingResult.bodyText), missingResult.bodyText);
  checkTrue('the back link still works', missingResult.back.startsWith('#'),
    missingResult.back);

  // And saving it must CREATE the entry rather than fail on the missing
  // id — the whole point is that the user can write it. And it must be
  // linked BACK to the card, so the wall's square turns to finished.
  const missingSave = await evalIn(win, `
    window.__testRows.clear();
    window.__testCards.clear();
    window.__testCards.clearLinks();
    window.__testCards.seed('draw-8', {
      id: 'draw-8',
      week_key: '2026-01-12',
      card_no: 8,
      title: '给自己做一顿饭',
      requirement: '认真做一顿饭，摆盘，拍下来。',
      source: 'deck',
    });
    await window.__editor.render({ id: 'gone-2' }, { draw: 'draw-8' });
    await new Promise(r => setTimeout(r, 120));

    const before = Object.keys(window.__testRows.all()).length;
    // The meta dialog asks for the time; fill it and confirm.
    document.getElementById('save').click();
    await new Promise(r => setTimeout(r, 200));
    const dialog = document.querySelector('.diary-meta-modal-backdrop');
    if (dialog) {
      const occ = dialog.querySelector('[data-role="occurred"]');
      if (occ && !occ.value) occ.value = '2026-04-01 09:15:00';
      dialog.querySelector('[data-act="confirm"]').click();
      await new Promise(r => setTimeout(r, 250));
    }
    const rows = window.__testRows.all();
    const ids = Object.keys(rows);
    return {
      before,
      after: ids.length,
      // The new entry must exist, and it must NOT be the id the link
      // named — that row is gone.
      ids,
      titles: ids.map(id => rows[id].title),
      notes: ids.map(id => rows[id].notes),
      notTheOldId: !ids.includes('gone-2'),
      // The card must point at the new entry.
      links: window.__testCards.links(),
    };
  `);

  check('a missing entry creates a new one when saved',
    missingSave.after === missingSave.before + 1,
    `before=${missingSave.before} after=${missingSave.after}`);
  checkTrue('the new entry is not the id the link named',
    missingSave.notTheOldId, JSON.stringify(missingSave.ids));
  checkTrue('the new entry carries the title that was typed',
    missingSave.titles.includes('给自己做一顿饭'),
    JSON.stringify(missingSave.titles));
  checkTrue('the new entry carries the card\'s requirement',
    missingSave.notes.includes('摆盘'),
    JSON.stringify(missingSave.notes));
  check('the new entry is linked back to the card', missingSave.links.length, 1);
  checkTrue('the link points at the card that was clicked',
    missingSave.links.length && missingSave.links[0].id === 'draw-8',
    JSON.stringify(missingSave.links));
  checkTrue('the link points at the new entry',
    missingSave.links.length && missingSave.ids.includes(missingSave.links[0].eventId),
    JSON.stringify(missingSave.links));

  // ---- 17. The card wall is paginated ------------------------------------
  //
  // The wall shows six cards at a time and reaches the rest through the
  // shared pager. The page index is VIEW state, not URL state — it is not
  // in the hash, so paging never pollutes the history — and any change to
  // what the list holds (a search, a filter, a reset) takes the user back
  // to the first page, so narrowing the list can never strand them on a
  // page that no longer exists.
  console.log('\n== 回忆事件分页 ==');
  const pagerResult = await evalIn(win, `
    window.__testRows.clear();
    for (let i = 1; i <= 14; i++) {
      window.__testRows.seed('pg-' + i, {
        id: 'pg-' + i, kind: 'other', title: '第' + i + '条',
        occurred_at: '2026-05-0' + ((i % 9) + 1) + ' 10:00:00',
        background: 'light', contact_ids: ['c1'],
        contact_names: ['小明'], photo_count: 0, notes: '正文' + i,
      });
    }

    await window.__list.render([], {});
    await new Promise(r => setTimeout(r, 150));

    const q = (sel) => document.querySelector(sel);
    const titles = () => Array.from(document.querySelectorAll('.memorial-card-title'))
      .map(el => el.textContent.trim());
    const pagerText = () => {
      const m = q('.memorial-pager .meta');
      return m ? m.textContent.trim() : '';
    };

    const first = {
      cards: document.querySelectorAll('.memorial-card').length,
      titles: titles(),
      pager: pagerText(),
      hasPrev: !!q('.memorial-pager [data-action="prev"]'),
      prevDisabled: !!(q('.memorial-pager [data-action="prev"]') || {}).disabled,
      nextDisabled: !!(q('.memorial-pager [data-action="next"]') || {}).disabled,
    };

    // Next page: the wall moves on, and the previous button wakes up.
    q('.memorial-pager [data-action="next"]').click();
    await new Promise(r => setTimeout(r, 150));
    const second = {
      cards: document.querySelectorAll('.memorial-card').length,
      titles: titles(),
      pager: pagerText(),
      prevDisabled: !!(q('.memorial-pager [data-action="prev"]') || {}).disabled,
      nextDisabled: !!(q('.memorial-pager [data-action="next"]') || {}).disabled,
    };

    // The last page holds the remainder — fourteen cards over six to a
    // page is 6 / 6 / 2.
    q('.memorial-pager [data-action="next"]').click();
    await new Promise(r => setTimeout(r, 150));
    const third = {
      cards: document.querySelectorAll('.memorial-card').length,
      pager: pagerText(),
      nextDisabled: !!(q('.memorial-pager [data-action="next"]') || {}).disabled,
    };

    // A search narrows the list — it must take the user back to the
    // first page, not leave them on the last page of a longer list.
    const input = q('#memorial-q');
    input.value = '第1条';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const afterSearch = {
      cards: document.querySelectorAll('.memorial-card').length,
      pager: pagerText(),
      // One card matches — a single page, so there is no pager at all.
      hasPager: !!q('.memorial-pager .meta'),
    };

    // And clearing it brings the whole wall back, starting at page one.
    q('#memorial-clear').click();
    await new Promise(r => setTimeout(r, 250));
    const afterClear = {
      cards: document.querySelectorAll('.memorial-card').length,
      pager: pagerText(),
      titles: titles(),
    };

    return { first, second, third, afterSearch, afterClear };
  `);

  check('the wall shows six cards on a page', pagerResult.first.cards, 6);
  check('the pager counts every card, not just the page',
    pagerResult.first.pager, '第 1 / 3 页 · 共 14 条');
  checkTrue('the first page cannot go back', pagerResult.first.prevDisabled);
  checkTrue('the first page can go forward', !pagerResult.first.nextDisabled);

  check('the second page also holds six cards', pagerResult.second.cards, 6);
  check('the second page is the second one', pagerResult.second.pager,
    '第 2 / 3 页 · 共 14 条');
  checkTrue('the second page can go back', !pagerResult.second.prevDisabled);
  checkTrue('the pages hold different cards',
    pagerResult.first.titles[0] !== pagerResult.second.titles[0],
    JSON.stringify([pagerResult.first.titles, pagerResult.second.titles]));

  check('the last page holds the remainder', pagerResult.third.cards, 2);
  check('the last page is the last one', pagerResult.third.pager,
    '第 3 / 3 页 · 共 14 条');
  checkTrue('the last page cannot go forward', pagerResult.third.nextDisabled);

  check('a search narrows the wall', pagerResult.afterSearch.cards, 1);
  checkTrue('a search that fits on one page shows no pager',
    !pagerResult.afterSearch.hasPager, pagerResult.afterSearch.pager);

  check('clearing the search brings the whole wall back',
    pagerResult.afterClear.cards, 6);
  check('clearing the search goes back to the first page',
    pagerResult.afterClear.pager, '第 1 / 3 页 · 共 14 条');

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
