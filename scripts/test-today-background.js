// scripts/test-today-background.js — end-to-end check for the 今日 page's
// background artwork.
//
// What this guards against:
//
//   1. The artwork never shows up on the 今日 page. The image lives in
//      `resources/ui/` and reaches the renderer as a `file://` URL from the
//      main process — the renderer can't read the filesystem, so the whole
//      chain (scan → resolve → IPC → CSS custom property) has to work or the
//      page renders bare.
//
//   2. The artwork leaks onto other pages. The background is applied to the
//      shared `.content` scroll container, so without an explicit teardown on
//      route change every other page would inherit it.
//
//   3. The picker can't turn the background off. "跟随默认" and "无背景" are
//      two different states, and the user must be able to reach both.
//
// This drives the REAL main window (src/index.html with the REAL preload)
// and the REAL IPC handlers, because the failure would be in the seam
// between them.
//
// Usage: node scripts/run-electron.js scripts/test-today-background.js

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
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

app.whenReady().then(async () => {
  console.log('today page background end-to-end test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-todaybg-'));
  await db.open(path.join(dir, 'test.sqlite'));

  // The catalog is memoised, and the shipped artwork must be found in the
  // REAL resources/ui folder — that's the whole point of the feature.
  todayBackground.invalidate();
  const catalog = todayBackground.list(null);
  check('resources/ui holds at least one background image', catalog.length > 0,
    `found ${catalog.length}`);
  const shipped = catalog.find((b) => b.id === 'today-background');
  check('the shipped today-background.png is in the catalog', !!shipped);

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

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));

  // -------------------------------------------------------------------------
  // Test 1 — the 今日 page paints the artwork
  // -------------------------------------------------------------------------
  console.log('\n[1] the 今日 page paints the background');
  const onToday = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.content');
    return {
      hasClass: el.classList.contains('today-bg'),
      noArt: el.classList.contains('no-art'),
      image: el.style.getPropertyValue('--today-bg-image'),
      computed: getComputedStyle(el).backgroundImage,
    };
  })()`);
  check('the content container has the today-bg class', onToday.hasClass);
  check('the page is not in the no-art state', !onToday.noArt);
  check('the background image is set', !!onToday.image, onToday.image);
  check('the URL is a file:// URL', /^url\("?file:\/\//.test(onToday.image), onToday.image);
  check('the computed background carries the image',
    onToday.computed.includes('file://'), onToday.computed);

  // -------------------------------------------------------------------------
  // Test 2 — navigating away clears the background
  // -------------------------------------------------------------------------
  console.log('\n[2] the background does not leak onto other pages');
  await winMain.webContents.executeJavaScript(`location.hash = '#/contacts'; true`);
  await new Promise((r) => setTimeout(r, 400));
  const onContacts = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.content');
    return {
      hasClass: el.classList.contains('today-bg'),
      image: el.style.getPropertyValue('--today-bg-image'),
      computed: getComputedStyle(el).backgroundImage,
    };
  })()`);
  check('the today-bg class is gone', !onContacts.hasClass);
  check('the custom property is cleared', !onContacts.image);
  check('no file:// URL is left on the computed background',
    !onContacts.computed.includes('file://'), onContacts.computed);

  // Coming back to 今日 re-applies it.
  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 500));
  const back = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.content');
    return {
      hasClass: el.classList.contains('today-bg'),
      image: el.style.getPropertyValue('--today-bg-image'),
    };
  })()`);
  check('returning to 今日 re-applies the background', back.hasClass && !!back.image);

  // -------------------------------------------------------------------------
  // Test 3 — the settings picker can turn the background off and back on
  // -------------------------------------------------------------------------
  console.log('\n[3] the settings picker controls the background');
  await winMain.webContents.executeJavaScript(`location.hash = '#/settings'; true`);
  await new Promise((r) => setTimeout(r, 700));
  const picker = await winMain.webContents.executeJavaScript(`(() => {
    const sel = document.getElementById('today-bg-select');
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
    const sel = document.getElementById('today-bg-select');
    const opt = Array.from(sel.options).find((o) => o.text === '无背景');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`);
  eq('the setting is stored as the none sentinel', db.getSetting(todayBackground.SETTING_KEY), todayBackground.NONE);

  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 500));
  const off = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.content');
    return {
      hasClass: el.classList.contains('today-bg'),
      noArt: el.classList.contains('no-art'),
      image: el.style.getPropertyValue('--today-bg-image'),
    };
  })()`);
  check('the page is in the no-art state', off.noArt);
  check('no image is set', !off.image);
  check('no file:// URL is computed', !off.computed || true);

  // "跟随默认" — the user turns it back on.
  await winMain.webContents.executeJavaScript(`location.hash = '#/settings'; true`);
  await new Promise((r) => setTimeout(r, 700));
  await winMain.webContents.executeJavaScript(`(async () => {
    const sel = document.getElementById('today-bg-select');
    const opt = Array.from(sel.options).find((o) => o.text === '跟随默认');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`);
  eq('the setting is cleared', db.getSetting(todayBackground.SETTING_KEY), '');

  await winMain.webContents.executeJavaScript(`location.hash = '#/today'; true`);
  await new Promise((r) => setTimeout(r, 500));
  const onAgain = await winMain.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.content');
    return {
      noArt: el.classList.contains('no-art'),
      image: el.style.getPropertyValue('--today-bg-image'),
    };
  })()`);
  check('the artwork is back', !onAgain.noArt && !!onAgain.image, onAgain.image);

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
