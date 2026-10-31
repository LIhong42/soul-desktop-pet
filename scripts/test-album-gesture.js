// scripts/test-album-gesture.js — end-to-end check that the album editor's
// drag gestures survive a lost `pointerup`.
//
// The bug this guards against is the same one the pet window had: a
// system suspend re-creates the pointer device, so the browser never
// delivers a `pointerup` for the pointer that started the drag. The drag
// latch stays set, and the album editor's photo drag then commits a REAL
// photo swap on the user's next unrelated click — the photo silently
// jumps into a slot it was never dropped on.
//
// The album editor is an ES module that imports several siblings, so it is
// loaded in a real renderer (a file:// page with a module script) rather
// than under jsdom.
//
// The test is purely BEHAVIORAL: it reads the rendered DOM (each photo
// slot carries `data-photo-id`) rather than the editor's internal state,
// so nothing has to be exported for testing.
//
// Usage: node scripts/run-electron.js scripts/test-album-gesture.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A tiny page that imports the album editor as a module and exposes it on
// `window` so the test can drive it.
//
// The page lives INSIDE the repo (not the temp directory) because the
// album editor imports its siblings by relative path — a page outside the
// repo could not resolve them.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>album gesture test</title></head>
<body><div id="host" style="width:900px;height:700px"></div>
<script type="module">
  import { mountEditor, destroyEditor } from './src/js/pages/album_editor.js';
  window.__album = { mountEditor, destroyEditor };
  window.__albumReady = true;
  window.__albumError = null;
</script>
</body></html>`;

const pagePath = path.join(ROOT, '.album-gesture-test.html');
fs.writeFileSync(pagePath, PAGE, 'utf8');

// Helpers injected into the renderer.
const HELPERS = `
  const mk = (type, x, y, id) => {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(ev, 'pointerId', { value: id });
    return ev;
  };
  // The rendered layout, read from the DOM. Each photo slot carries the
  // photo id it holds, so this is the user-visible truth.
  const readSlots = () => Array.from(document.querySelectorAll('[data-slot-idx][data-slot-type="photo"]'))
    .map(el => {
      const img = el.querySelector('[data-photo-id]');
      return img ? img.getAttribute('data-photo-id') : null;
    });
  const firstPhotoSlot = () => document.querySelector('[data-slot-idx][data-slot-type="photo"]');
`;

app.whenReady().then(async () => {
  console.log('album editor gesture test (real Electron)');

  // The album editor's init round-trips through the preload bridge. These
  // handlers are the minimum the editor needs to mount; the real ones live
  // in main/ipc.js and need the whole app around them.
  ipcMain.handle('pet:list', () => []);
  ipcMain.handle('pet:list_installed', () => []);
  ipcMain.handle('pet:get_state', () => ({ state: 'NORMAL', count: 0, head: null }));
  ipcMain.handle('album:list', () => []);
  // The photo bytes and metadata. Without these the photo slots render
  // EMPTY, and an empty slot has no drag to start — the test would be
  // exercising nothing.
  ipcMain.handle('memorial_events:photo_read', () => 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  ipcMain.handle('memorial_events:photo_meta', () => ({ width: 100, height: 100, mime: 'image/gif' }));

  const win = new BrowserWindow({
    width: 1000, height: 800, show: false,
    webPreferences: {
      // The album editor imports src/js/api.js, which needs the real
      // preload bridge (`window.mp`) — without it the module throws
      // "Preload bridge missing" at import time.
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Surface the renderer's own errors — a module that fails to evaluate
  // would otherwise just leave `window.__albumReady` undefined.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });

  await win.loadFile(pagePath);
  // Wait for the module to evaluate.
  for (let i = 0; i < 60; i++) {
    const ready = await win.webContents.executeJavaScript('!!window.__albumReady').catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const loaded = await win.webContents.executeJavaScript('!!window.__albumReady');
  check('the album editor module loaded', loaded === true);

  // Mount the editor with synthetic events carrying photos.
  //
  // Each event gets MULTIPLE photos: the page template is chosen by photo
  // count, and a one-photo event yields the `single-full` template, which
  // has exactly one photo slot. The slot→slot drag needs a SOURCE slot and
  // a TARGET slot to be meaningful.
  const mounted = await win.webContents.executeJavaScript(`(() => {
    const mkEvent = (id, n) => ({
      id,
      title: 'Event ' + id,
      occurred_at: '2024-01-0' + n,
      photos: Array.from({ length: n }, (_, i) => ({
        id: id + '_p' + i,
        full_path: 'x' + id + '_' + i + '.jpg',
        mime: 'image/jpeg',
      })),
    });
    const events = [];
    for (let i = 1; i <= 4; i++) events.push(mkEvent('e' + i, 4));
    try {
      window.__album.mountEditor({
        container: document.getElementById('host'),
        events,
        onBack: () => {},
        onExport: () => {},
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  })()`);
  check('the album editor mounted', mounted.ok === true, mounted.error);

  // Wait for the canvas to render.
  await new Promise((r) => setTimeout(r, 800));

  const info = await win.webContents.executeJavaScript(`(() => {
    ${HELPERS}
    return {
      hasCanvas: !!document.querySelector('#album-canvas'),
      photoSlots: readSlots().length,
      filled: readSlots().filter(Boolean).length,
    };
  })()`);
  check('the canvas rendered', info.hasCanvas === true);
  check('the canvas has photo slots', info.photoSlots > 0, `photoSlots=${info.photoSlots}`);
  check('some slots hold photos', info.filled > 0, `filled=${info.filled}`);

  // -------------------------------------------------------------------------
  // Test 1 — a drag that loses its `pointerup` must NOT commit anything
  // when the next (foreign-pointer) interaction arrives.
  //
  // This is the data-corruption case. The photo drag's `pointerup` never
  // arrives (post-suspend), so the drag stays live; then a click from the
  // NEW pointer must not swap a photo.
  // -------------------------------------------------------------------------
  console.log('\n[1] a stale photo drag cannot commit a swap');

  const before = await win.webContents.executeJavaScript(`(() => {
    ${HELPERS}
    return JSON.stringify(readSlots());
  })()`);

  // Start a photo drag on the canvas and then abandon it (no pointerup).
  //
  // The slot→slot drag needs Alt (or Meta / middle button) — a plain drag
  // pans the photo inside its slot instead. See onCanvasSlotPointerDown.
  //
  // The drag is moved ONTO a second photo slot, so the drop target is
  // recorded. That is what makes the corruption possible: with a drop
  // target set, a later `pointerup` commits a real photo swap.
  const abandoned = await win.webContents.executeJavaScript(`(() => {
    ${HELPERS}
    const slots = Array.from(document.querySelectorAll('[data-slot-idx][data-slot-type="photo"]'));
    if (slots.length < 2) return { started: false, reason: 'need 2 slots, got ' + slots.length };
    const from = slots[0], to = slots[1];
    const rf = from.getBoundingClientRect();
    const rt = to.getBoundingClientRect();
    const x = rf.left + rf.width / 2, y = rf.top + rf.height / 2;
    const tx = rt.left + rt.width / 2, ty = rt.top + rt.height / 2;
    const ev = mk('pointerdown', x, y, 1);
    Object.defineProperty(ev, 'altKey', { value: true });
    from.dispatchEvent(ev);
    // Move onto the target slot so the drop target is recorded.
    //
    // The move is dispatched ON the target slot (not on window): the drop
    // target is found via e.target.closest('[data-slot-idx]'), so the
    // event needs a real target element. The window-level listener still
    // receives it — it bubbles.
    to.dispatchEvent(mk('pointermove', tx, ty, 1));
    const ghostCount = document.querySelectorAll('.album-drag-ghost').length;
    const dropTargetMarked = document.querySelectorAll('.album-slot.is-drop-target').length;
    return { started: true, ghostCount, dropTargetMarked };
  })()`);
  check('a photo drag could be started', abandoned.started === true, abandoned.reason);
  check('the drag ghost element was created', abandoned.ghostCount === 1,
    `ghostCount=${abandoned.ghostCount}`);
  check('a drop target was recorded', abandoned.dropTargetMarked === 1,
    `dropTargetMarked=${abandoned.dropTargetMarked}`);

  // Now the machine sleeps. The mouse is a NEW device (pointer id 2).
  // The user's next click arrives — it must NOT commit anything.
  const after = await win.webContents.executeJavaScript(`(() => {
    ${HELPERS}
    const canvas = document.querySelector('#album-canvas');
    // The new mouse moves — the guard must tear the stale drag down.
    window.dispatchEvent(mk('pointermove', 400, 400, 2));
    // The new mouse clicks on the canvas — must not commit anything.
    canvas.dispatchEvent(mk('pointerup', 400, 400, 2));
    canvas.dispatchEvent(mk('pointerdown', 400, 400, 2));
    canvas.dispatchEvent(mk('pointerup', 400, 400, 2));
    return {
      slots: JSON.stringify(readSlots()),
      ghostCount: document.querySelectorAll('.album-drag-ghost').length,
    };
  })()`);

  eq('the layout was NOT modified by the stale drag', after.slots, before);
  eq('the drag ghost element was cleaned up', after.ghostCount, 0);

  // -------------------------------------------------------------------------
  // Test 2 — a NORMAL drag still works (the fix must not break dragging)
  // -------------------------------------------------------------------------
  console.log('\n[2] a normal photo drag still commits');
  const normal = await win.webContents.executeJavaScript(`(() => {
    ${HELPERS}
    const slot = firstPhotoSlot();
    const r = slot.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = mk('pointerdown', x, y, 1);
    Object.defineProperty(ev, 'altKey', { value: true });
    slot.dispatchEvent(ev);
    window.dispatchEvent(mk('pointermove', x + 20, y + 20, 1));
    const ghostDuringDrag = document.querySelectorAll('.album-drag-ghost').length;
    window.dispatchEvent(mk('pointerup', x + 20, y + 20, 1));
    return {
      ghostDuringDrag,
      ghostAfter: document.querySelectorAll('.album-drag-ghost').length,
    };
  })()`);
  check('the ghost was shown during the normal drag', normal.ghostDuringDrag === 1);
  check('the ghost was removed on pointerup', normal.ghostAfter === 0);

  // -------------------------------------------------------------------------
  // Test 3 — a drag onto ANOTHER slot actually swaps the two photos
  //
  // This is the user-visible promise of the album editor's photo drag, and
  // it was broken for the whole life of the feature: `onCanvasPointerMove`
  // called a `moveDragGhost()` that never existed, the ReferenceError threw
  // out of the handler on EVERY pointermove, and so the drop target was
  // never resolved — the swap never committed.
  //
  // The test reads the rendered DOM, so it checks what the user actually
  // sees, not the editor's internals.
  // -------------------------------------------------------------------------
  console.log('\n[3] a drag onto another slot swaps the photos');
  const swap = await win.webContents.executeJavaScript(`(() => {
    ${HELPERS}
    const slots = Array.from(document.querySelectorAll('[data-slot-idx][data-slot-type="photo"]'));
    if (slots.length < 2) return { ok: false, reason: 'need 2 slots' };
    const from = slots[0], to = slots[1];
    const beforeSlots = readSlots();
    const rf = from.getBoundingClientRect(), rt = to.getBoundingClientRect();
    const x = rf.left + rf.width / 2, y = rf.top + rf.height / 2;
    const tx = rt.left + rt.width / 2, ty = rt.top + rt.height / 2;
    const ev = mk('pointerdown', x, y, 1);
    Object.defineProperty(ev, 'altKey', { value: true });
    from.dispatchEvent(ev);
    to.dispatchEvent(mk('pointermove', tx, ty, 1));
    const marked = document.querySelectorAll('.album-slot.is-drop-target').length;
    to.dispatchEvent(mk('pointerup', tx, ty, 1));
    const afterSlots = readSlots();
    return {
      ok: true,
      marked,
      before: JSON.stringify(beforeSlots),
      after: JSON.stringify(afterSlots),
      swapped: beforeSlots[0] === afterSlots[1] && beforeSlots[1] === afterSlots[0],
    };
  })()`);
  check('the drop target was highlighted during the drag', swap.marked === 1,
    `marked=${swap.marked}`);
  check('the two photos swapped places', swap.swapped === true,
    `before=${swap.before} after=${swap.after}`);

  // -------------------------------------------------------------------------
  // Test 4 — the editor still tears down cleanly
  // -------------------------------------------------------------------------
  console.log('\n[4] the editor tears down cleanly');
  const destroyed = await win.webContents.executeJavaScript(`(() => {
    try {
      window.__album.destroyEditor();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  })()`);
  check('destroyEditor did not throw', destroyed.ok === true, destroyed.error);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  try { fs.unlinkSync(pagePath); } catch {}
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
});
