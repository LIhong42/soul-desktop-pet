// scripts/test-diary-editor.js — proves the diary editor works end to end.
//
// Covers the four things that make the diary feature what it is:
//
//   1. The six background styles exist and are well-formed (an id, a
//      header color, a page background, and three accent dots).
//   2. The editor renders a title, a body, and the six style tiles, and
//      picking a tile repaints the writing surface.
//   3. Text and images interleave: inserting a picture at the caret
//      splits the text block, and the saved document keeps that order.
//   4. There is NO tag logic — no tag dialog, no tag column, no tag
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
    show: false,
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
    return {
      list: m.DIARY_THEMES.map(t => ({
        id: t.id, name: t.name, hasHeader: !!t.headerBg, hasBg: !!t.bg,
        dots: t.dots.length, hasText: !!t.text,
      })),
      unknown: m.getDiaryTheme('nope').id,
      known: m.getDiaryTheme('shadow').id,
    };
  `);
  check('there are six background styles', themes.list.length, 6);
  checkTrue('every style has a header color, a page background and a text color',
    themes.list.every(t => t.hasHeader && t.hasBg && t.hasText));
  checkTrue('every style carries exactly three accent dots',
    themes.list.every(t => t.dots === 3));
  check('the style ids are the six from the reference',
    themes.list.map(t => t.id),
    ['light', 'dark', 'shiro', 'shadow', 'helena', 'poonam']);
  check('an unknown style id falls back to the default', themes.unknown, 'light');
  check('a known style id resolves to itself', themes.known, 'shadow');

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
      hasSave: !!document.getElementById('save'),
      textBlocks: document.querySelectorAll('.diary-block-text').length,
      tiles: tiles.length,
      changed: beforeBg !== afterBg,
      header: afterHeader,
      selectedCount: document.querySelectorAll('.diary-theme-tile.selected').length,
      contactCards: document.querySelectorAll('.contact-pick').length,
      pageBg: getComputedStyle(page).backgroundImage,
    };
  `);
  checkTrue('the editor renders a title field', editorResult.hasTitle);
  checkTrue('the editor renders the block container', editorResult.hasBlocks);
  checkTrue('the editor renders the photo file input', editorResult.hasFileInput);
  checkTrue('the editor renders a save button', editorResult.hasSave);
  checkTrue('the editor starts with one text block', editorResult.textBlocks >= 1);
  check('the style picker shows all six tiles', editorResult.tiles, 6);
  checkTrue('picking a style repaints the writing surface', editorResult.changed);
  check('the Shadow style writes its header color', editorResult.header, '#6b5636');
  check('exactly one tile is marked selected', editorResult.selectedCount, 1);
  check('the contact picker lists the contacts', editorResult.contactCards, 2);
  checkTrue('the page background paints with the chosen gradient',
    editorResult.pageBg && editorResult.pageBg.includes('gradient'));

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
      hasImage: !!document.querySelector('.diary-block-image'),
      content: row && row.content,
      notes: row && row.notes,
      title: row && row.title,
      background: row && row.background,
      navigated: location.hash,
    };
  `);
  check('the document interleaves text and image blocks',
    mixResult.order, ['text', 'image', 'text']);
  checkTrue('the image block is rendered', mixResult.hasImage);
  // The caret was placed after 6 characters, so the split falls there.
  check('the text before the caret stays above the image',
    mixResult.textBefore, '在防波堤上坐');
  check('the text after the caret moves below the image',
    mixResult.textAfter, '到天黑，看远处的灯一盏一盏亮起来。');
  check('the saved document keeps the block order',
    mixResult.content.map(b => b.type), ['text', 'image', 'text']);
  check('the saved document keeps the text before the image',
    mixResult.content[0].text, '在防波堤上坐');
  check('the saved document keeps the text after the image',
    mixResult.content[2].text, '到天黑，看远处的灯一盏一盏亮起来。');
  checkTrue('the saved document references an image',
    mixResult.content[1] && mixResult.content[1].type === 'image' && !!mixResult.content[1].photo_id);
  check('the plain text is mirrored into notes for search',
    mixResult.notes,
    '在防波堤上坐\n\n到天黑，看远处的灯一盏一盏亮起来。');
  check('the title is saved', mixResult.title, '第一次去海边');
  check('the chosen background is saved', mixResult.background, 'shadow');
  checkTrue('the editor navigates away after saving',
    !!mixResult.navigated && mixResult.navigated.length > 1);

  // ---- 4. No tag logic anywhere ---------------------------------------
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
    };
  `);
  checkTrue('the editor has no tag dialog', !noTagResult.editorHasTagDialog);
  checkTrue('the editor has no tag card', !noTagResult.editorHasTagCard);
  checkTrue('the editor mentions no tag UI at all', !noTagResult.editorHasTagButton);
  checkTrue('the list has no 类型 filter', !noTagResult.listHasTagFilter);
  // The kind badge (第一次/其他) is all that remains — no 生日/纪念日/节日.
  check('the rows carry only the kind badge, no type tag',
    noTagResult.rowTags.filter(t => ['生日', '纪念日', '节日', '未分类'].includes(t)), []);
  check('the list rows still show the background swatch', noTagResult.swatches, 1);

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
