// scripts/test-pet-drag-e2e.js — end-to-end check of the pet drag under a
// REAL Electron main process.
//
// The unit tests stub the `electron` module, which cannot catch mistakes
// like "getCursorScreenPoint() returns a Point object, not an array" or
// "setPosition() throws on a fractional coordinate" — those only show up
// against the real API. This script runs inside a real Electron app and
// drives the REAL handlers from main/ipc.js, with a real BrowserWindow
// shaped like the pet window (transparent, focusable: false, ~220 px).
//
// It does not move the OS cursor — Electron's `screen.getCursorScreenPoint()`
// is read-only. Instead the grab offset is varied and the resulting window
// position is checked, which is what the drag maths actually depends on.
//
// Usage: node scripts/run-electron.js scripts/test-pet-drag-e2e.js

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

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

// ---------------------------------------------------------------------------
// A stand-in for the pet window: same size, same flags. The REAL handlers
// come from main/ipc.js — this file deliberately does not re-implement them,
// because a copy would not catch a bug in the shipped code.
// ---------------------------------------------------------------------------
let winPet = null;
let petController = null;
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

app.whenReady().then(async () => {
  console.log('pet drag end-to-end test (real Electron)');

  winPet = new BrowserWindow({
    width: 220,
    height: 220,
    x: 300,
    y: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: true,
    backgroundColor: '#00000000',
  });
  await winPet.loadFile(path.join(ROOT, 'src', 'pet.html'));

  petController = { dragging: false, setDragging(on) { this.dragging = !!on; } };

  // Register the REAL IPC handlers from main/ipc.js against this window.
  ipc.register({
    queue: { on: () => {}, activeCount: () => 0, activeHead: () => null },
    winMain: winPet,
    winPet,
    setPetState: () => {},
    getPetState: () => false,
    setActiveReminder: () => {},
    broadcastPetState: () => {},
    petController,
    petRegistry: null,
  });

  // -------------------------------------------------------------------------
  // Test 1 — the real getCursorScreenPoint() shape
  // -------------------------------------------------------------------------
  console.log('\n[1] screen.getCursorScreenPoint() returns a Point object');
  const cursor = screen.getCursorScreenPoint();
  check('it is an object', cursor && typeof cursor === 'object');
  check('it has numeric x', typeof cursor.x === 'number', `x = ${cursor.x}`);
  check('it has numeric y', typeof cursor.y === 'number', `y = ${cursor.y}`);
  check('it is NOT iterable as an array',
    typeof cursor[Symbol.iterator] !== 'function',
    'array destructuring of this value would throw "object is not iterable"');

  // -------------------------------------------------------------------------
  // Test 2 — drag_start places the window under the cursor
  // -------------------------------------------------------------------------
  console.log('\n[2] drag_start positions the window under the cursor');
  const grabDX = 40, grabDY = 60;
  // ipcMain has no public "call this handler" API, so go through a
  // renderer instead — that also proves the whole IPC path works.
  const probe = new BrowserWindow({
    width: 300, height: 200, show: false,
    webPreferences: { preload: path.join(ROOT, 'scripts', 'drag-probe-preload.js') },
  });
  await probe.loadFile(path.join(ROOT, 'src', 'pet.html'));
  const result = await probe.webContents.executeJavaScript(
    `(async () => {
       const r = await window.mp.pet.dragStart(${grabDX}, ${grabDY});
       return { r };
     })()`
  );
  eq('drag_start returned true', result.r, true);

  // Read the cursor and the window position as close together as possible:
  // the poller is still running, so the real cursor may have drifted a
  // pixel or two between the two reads. A couple of px of slack absorbs
  // that without hiding a real error (which would be off by the grab
  // offset — tens of pixels).
  //
  // The expected position is CLAMPED to the work area, exactly as the real
  // handler does: near the bottom of the screen the window cannot follow
  // the cursor all the way, because its bottom edge would leave the work
  // area. Computing the clamped expectation here means the test asserts
  // the real behaviour rather than the un-clamped ideal.
  const [px, py] = winPet.getPosition();
  const now = screen.getCursorScreenPoint();
  const b = winPet.getBounds();
  const disp = screen.getDisplayMatching({ x: now.x - grabDX, y: now.y - grabDY, width: b.width, height: b.height })
    || screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const expX = Math.max(wa.x, Math.min(wa.x + wa.width - b.width, now.x - grabDX));
  const expY = Math.max(wa.y, Math.min(wa.y + wa.height - b.height, now.y - grabDY));
  check('the window x followed the cursor',
    Math.abs(px - expX) <= 3,
    `window x = ${px}, expected ≈ ${expX}`);
  check('the window y followed the cursor',
    Math.abs(py - expY) <= 3,
    `window y = ${py}, expected ≈ ${expY}`);
  check('the drag mutex was taken', petController.dragging === true);

  // -------------------------------------------------------------------------
  // Test 3 — drag_end releases the mutex and stops the poller
  // -------------------------------------------------------------------------
  console.log('\n[3] drag_end releases the mutex and stops the poller');
  await probe.webContents.executeJavaScript(`window.mp.pet.dragEnd()`);
  eq('the drag mutex was released', petController.dragging, false);

  const settled = winPet.getPosition();
  await new Promise((r) => setTimeout(r, 120));
  const after = winPet.getPosition();
  eq('the window stopped moving', JSON.stringify(after), JSON.stringify(settled));

  // -------------------------------------------------------------------------
  // Test 4 — the renderer can drag the pet through the real IPC path
  // -------------------------------------------------------------------------
  console.log('\n[4] the renderer drags the pet through the real IPC path');
  const dragResult = await probe.webContents.executeJavaScript(`
    (async () => {
      const sprite = document.getElementById('pet-sprite');
      const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
      Object.defineProperty(down, 'pointerId', { value: 1 });
      Object.defineProperty(down, 'screenX', { value: ${cursor.x} });
      Object.defineProperty(down, 'screenY', { value: ${cursor.y} });
      sprite.dispatchEvent(down);
      const move = new PointerEvent('pointermove', { bubbles: true, cancelable: true });
      Object.defineProperty(move, 'pointerId', { value: 1 });
      Object.defineProperty(move, 'screenX', { value: ${cursor.x} });
      Object.defineProperty(move, 'screenY', { value: ${cursor.y} + 30 });
      window.dispatchEvent(move);
      await new Promise(r => setTimeout(r, 80));
      const up = new PointerEvent('pointerup', { bubbles: true, cancelable: true });
      Object.defineProperty(up, 'pointerId', { value: 1 });
      Object.defineProperty(up, 'screenX', { value: ${cursor.x} });
      Object.defineProperty(up, 'screenY', { value: ${cursor.y} + 30 });
      window.dispatchEvent(up);
      await new Promise(r => setTimeout(r, 60));
      return { dragging: document.getElementById('pet-sprite').classList.contains('dragging') };
    })()
  `);
  eq('the renderer finished the drag cleanly', dragResult.dragging, false);
  eq('the mutex was released after the renderer drag', petController.dragging, false);

  // -------------------------------------------------------------------------
  // Test 5 — a fractional grab offset must not break the drag
  // -------------------------------------------------------------------------
  //
  // `setPosition` throws "conversion failure" on a fractional coordinate.
  // The grab offset the renderer measures is routinely fractional, so the
  // handler has to round before handing the value over — otherwise the whole
  // drag dies on the first frame.
  console.log('\n[5] a fractional grab offset does not break the drag');
  const fracResult = await probe.webContents.executeJavaScript(`
    (async () => {
      try {
        const r = await window.mp.pet.dragStart(40.5, 60.25);
        await new Promise(r => setTimeout(r, 80));
        await window.mp.pet.dragEnd();
        return { ok: true, r };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    })()
  `);
  check('the fractional drag did not throw', fracResult.ok === true, fracResult.error);
  eq('drag_start still succeeded', fracResult.r, true);

  // -------------------------------------------------------------------------
  // Test 6 — a drag driven by MOUSE events alone
  //
  // After a system suspend, Chromium can stop delivering the POINTER events
  // to the renderer while the legacy MOUSE events keep coming — the pointer
  // events are built from the raw input by a factory that needs a
  // registered pointer DEVICE, and a suspend re-creates that device. The
  // symptom the user reported is exactly that: the pet cannot be dragged,
  // but the right-click menu (a mouse event) still works.
  //
  // So the drag has to work on the mouse events too. This drives the whole
  // gesture with mouse events only — no pointer event at all.
  // -------------------------------------------------------------------------
  console.log('\n[6] a drag driven by mouse events alone works');
  const mouseDrag = await probe.webContents.executeJavaScript(`
    (async () => {
      const sprite = document.getElementById('pet-sprite');
      const mk = (type, x, y) => new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
      });
      sprite.dispatchEvent(mk('mousedown', 100, 100));
      window.dispatchEvent(mk('mousemove', 140, 160));
      await new Promise(r => setTimeout(r, 80));
      const dragging = sprite.classList.contains('dragging');
      window.dispatchEvent(mk('mouseup', 140, 160));
      await new Promise(r => setTimeout(r, 60));
      return { dragging, ended: !sprite.classList.contains('dragging') };
    })()
  `);
  check('the mouse gesture started a drag', mouseDrag.dragging === true);
  check('the mouse gesture ended cleanly', mouseDrag.ended === true);
  eq('the mutex was released after the mouse drag', petController.dragging, false);

  probe.destroy();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    app.exit(1);
    return;
  }
  app.exit(0);
});
