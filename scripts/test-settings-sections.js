// scripts/test-settings-sections.js — proves the 设置 page is split into a
// section nav + one visible panel.
//
// The page used to be one long column of a dozen cards, which meant it grew
// without bound and the settings people touch daily were buried in the
// middle. Now the left rail lists every section and the right panel shows
// only the selected one.
//
// What this guards against:
//
//   1. The nav rail is missing or empty. Without it the page is the old
//      long scroll again, just with the sections still stacked.
//
//   2. More than one section's content is on screen. The whole point is
//      that only the selected section is shown — a leftover card from
//      another section would mean the page still grows.
//
//   3. The rail and the panel overlap. The rail is a fixed-width column
//      and the panel has to sit beside it, not under it.
//
//   4. Clicking a nav entry doesn't switch the section. The links are
//      real hash links, so the router has to pick them up.
//
//   5. The page has no side margin. The whole thing sits in the app's
//      shared `.page-column`, so the settings page keeps the same margin
//      as every other page.
//
// Run: node scripts/run-electron.js scripts/test-settings-sections.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const evalIn = (win, code) =>
  win.webContents.executeJavaScript(
    `(async () => { try { ${code} } catch (e) { return { __threw: String(e && e.stack || e) }; } })()`, true);

app.whenReady().then(async () => {
  console.log('settings sections end-to-end test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-settings-'));
  await db.open(path.join(dir, 'test.sqlite'));

  const winMain = new BrowserWindow({
    width: 1600, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
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

  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));

  // The main window opens behind the PIN lock; body.locked hides #app, and a
  // hidden subtree has no layout box, so every measurement below would read
  // 0 and pass vacuously.
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);
  await new Promise((r) => setTimeout(r, 200));

  // Land on the settings page and wait for the nav rail to appear.
  await winMain.webContents.executeJavaScript(`location.hash = '#/settings'; true`);
  const landed = await evalIn(winMain, `
    for (let i = 0; i < 80; i++) {
      const nav = document.querySelector('.settings-nav');
      const item = document.querySelector('.settings-nav-item');
      if (nav && item) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  `);
  check('the settings page shows a nav rail', landed === true);
  if (landed !== true) {
    console.log(`\\n${pass} passed, ${fail} failed`);
    try { db.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(1);
    return;
  }
  await new Promise((r) => setTimeout(r, 300));

  // -------------------------------------------------------------------------
  // The rail lists every section
  // -------------------------------------------------------------------------
  const navInfo = await evalIn(winMain, `
    const items = [...document.querySelectorAll('.settings-nav-item')];
    const rail = document.querySelector('.settings-nav');
    const panel = document.querySelector('.settings-panel');
    const railBox = rail.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    return {
      count: items.length,
      labels: items.map((a) => a.textContent.trim()),
      hrefs: items.map((a) => a.getAttribute('href')),
      activeCount: items.filter((a) => a.classList.contains('is-active')).length,
      activeLabel: (items.find((a) => a.classList.contains('is-active')) || {}).textContent || '',
      railRight: Math.round(railBox.right),
      panelLeft: Math.round(panelBox.left),
      railWidth: Math.round(railBox.width),
      panelWidth: Math.round(panelBox.width),
    };
  `);

  console.log(`\\n[the rail]`);
  check('the rail lists every section', navInfo.count >= 8, `${navInfo.count} entries`);
  check('every entry has a label', navInfo.labels.every((l) => l.length > 0), JSON.stringify(navInfo.labels));
  check('every entry links to a settings route',
    navInfo.hrefs.every((h) => /^#\/settings\/[a-z-]+$/.test(h)), JSON.stringify(navInfo.hrefs));
  check('exactly one entry is active', navInfo.activeCount === 1, `${navInfo.activeCount} active`);

  // -------------------------------------------------------------------------
  // The rail and the panel sit side by side
  // -------------------------------------------------------------------------
  console.log(`\\n[the layout]`);
  check('the rail is narrower than the panel',
    navInfo.railWidth < navInfo.panelWidth,
    `rail ${navInfo.railWidth}px, panel ${navInfo.panelWidth}px`);
  check('the panel starts to the right of the rail',
    navInfo.panelLeft >= navInfo.railRight - 1,
    `rail right ${navInfo.railRight}px, panel left ${navInfo.panelLeft}px`);

  // The page keeps the app's shared reading column, so the settings page has
  // the same side margin as every other page.
  const column = await evalIn(winMain, `
    const app = document.querySelector('#app');
    const appCs = getComputedStyle(app);
    const col = document.querySelector('.page-column');
    const box = col.getBoundingClientRect();
    const padL = parseFloat(appCs.paddingLeft) || 0;
    const contentLeft = app.getBoundingClientRect().left + padL;
    const contentRight = contentLeft + app.clientWidth - padL - (parseFloat(appCs.paddingRight) || 0);
    return {
      width: Math.round(box.width),
      left: Math.round(box.left - contentLeft),
      right: Math.round(contentRight - box.right),
    };
  `);
  check('the page keeps the shared reading column',
    column.width <= 1081 && column.width >= 320, `measured ${column.width}px`);
  check('the page keeps a side margin',
    column.left >= 20 && column.right >= 20,
    `left ${column.left}px, right ${column.right}px`);

  // -------------------------------------------------------------------------
  // Only the selected section is on screen
  // -------------------------------------------------------------------------
  // Each section is identified by the control that only it owns. Looking for
  // one control per section and counting how many are present is how we know
  // a second section's content leaked onto the page.
  console.log(`\\n[one section at a time]`);

  const SECTIONS = [
    { key: 'pet',        marker: '#pet-species' },
    { key: 'startup',    marker: '#app-autostart' },
    { key: 'wake',       marker: 'input[name="pet-restart-on-wake"]' },
    { key: 'background', marker: '#page-bg-select' },
    { key: 'backup',     marker: '#export-backup' },
    { key: 'pin',        marker: '#pin-change' },
    { key: 'about',      marker: '#quit-app' },
  ];

  const countMarkers = (markers) => evalIn(winMain, `
    const found = {};
    for (const sel of ${JSON.stringify(markers)}) {
      found[sel] = document.querySelectorAll(sel).length;
    }
    return found;
  `);

  // On the default section, none of the other sections' controls are present.
  const onPet = await countMarkers(SECTIONS.map((s) => s.marker));
  const leaked = SECTIONS.filter((s) => s.key !== 'pet' && onPet[s.marker] > 0);
  check('the default section shows only its own controls',
    leaked.length === 0,
    leaked.map((s) => `${s.key}: ${s.marker}×${onPet[s.marker]}`).join(', '));
  check('the default section shows its own control',
    onPet['#pet-species'] === 1, `#pet-species×${onPet['#pet-species']}`);

  // -------------------------------------------------------------------------
  // Clicking a rail entry switches the section
  // -------------------------------------------------------------------------
  console.log(`\\n[switching sections]`);
  for (const s of SECTIONS) {
    await winMain.webContents.executeJavaScript(
      `location.hash = '#/settings/${s.key}'; true`);
    // Wait for the panel to repaint with this section's control.
    const ok = await evalIn(winMain, `
      for (let i = 0; i < 80; i++) {
        if (document.querySelector(${JSON.stringify(s.marker)})) {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    `);
    check(`${s.key} shows its own control`, ok === true);

    const after = await countMarkers(SECTIONS.map((x) => x.marker));
    const strays = SECTIONS.filter((x) => x.key !== s.key && after[x.marker] > 0);
    check(`${s.key} hides every other section's controls`,
      strays.length === 0,
      strays.map((x) => `${x.key}: ${x.marker}×${after[x.marker]}`).join(', '));

    const active = await evalIn(winMain, `
      const a = document.querySelector('.settings-nav-item.is-active');
      return a ? a.getAttribute('href') : null;
    `);
    check(`${s.key} is the active entry in the rail`,
      active === `#/settings/${s.key}`, `active is ${active}`);
  }

  // -------------------------------------------------------------------------
  // An unknown section falls back to the default one
  // -------------------------------------------------------------------------
  console.log(`\\n[an unknown section]`);
  await winMain.webContents.executeJavaScript(`location.hash = '#/settings/nope'; true`);
  await new Promise((r) => setTimeout(r, 600));
  const fallback = await evalIn(winMain, `
    const a = document.querySelector('.settings-nav-item.is-active');
    return {
      active: a ? a.getAttribute('href') : null,
      hasPet: !!document.querySelector('#pet-species'),
    };
  `);
  check('an unknown section falls back to the default one',
    fallback.active === '#/settings/pet' && fallback.hasPet,
    JSON.stringify(fallback));

  console.log(`\\n${pass} passed, ${fail} failed`);
  if (fail) console.log('  (some checks failed)');

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('test failed:', e);
  app.exit(1);
});
