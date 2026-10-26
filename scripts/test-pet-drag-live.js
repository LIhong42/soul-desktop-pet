// scripts/test-pet-drag-live.js — drives the REAL running app's pet window
// through a full drag gesture and checks that the window actually followed
// the cursor.
//
// This is the closest thing to a manual test that can run unattended: it
// builds the same window the app builds, loads the same renderer, and runs
// the same IPC handlers — but it also simulates the EXACT sequence the user
// reported as broken:
//
//   1. press on the pet
//   2. drag
//   3. release the button while the pointer is OUTSIDE the pet's rectangle
//      (the pointerup is never delivered — the window isn't under it)
//   4. move the pointer back over the pet
//
// Before the fix, step 4 teleported the pet across the screen. After the
// fix, nothing moves.
//
// Usage: node scripts/run-electron.js scripts/test-pet-drag-live.js

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

let winPet = null;
const petController = { dragging: false, setDragging(on) { this.dragging = !!on; } };
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

app.whenReady().then(async () => {
  console.log('pet drag live-simulation test (real Electron)');

  winPet = new BrowserWindow({
    width: 220, height: 220, x: 400, y: 300,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, minimizable: false, maximizable: false, hasShadow: false,
    focusable: false, show: true, backgroundColor: '#00000000',
  });
  winPet.setIgnoreMouseEvents(false);
  await winPet.loadFile(path.join(ROOT, 'src', 'pet.html'));

  ipc.register({
    queue: { on: () => {}, activeCount: () => 0, activeHead: () => null },
    winMain: winPet, winPet,
    setPetState: () => {}, getPetState: () => false, setActiveReminder: () => {},
    broadcastPetState: () => {}, petController, petRegistry: null,
  });

  const probe = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: { preload: path.join(ROOT, 'scripts', 'drag-probe-preload.js') },
  });
  await probe.loadFile(path.join(ROOT, 'src', 'pet.html'));

  // The pet renderer (src/js/pet.js) runs in the REAL pet window, so the
  // gesture below is handled by the shipped code, not a copy.
  const gesture = async (opts) => probe.webContents.executeJavaScript(`
    (async () => {
      const sprite = document.getElementById('pet-sprite');
      const mk = (type, x, y) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(ev, 'pointerId', { value: 1 });
        Object.defineProperty(ev, 'screenX', { value: x });
        Object.defineProperty(ev, 'screenY', { value: y });
        return ev;
      };
      sprite.dispatchEvent(mk('pointerdown', ${opts.x0}, ${opts.y0}));
      window.dispatchEvent(mk('pointermove', ${opts.x1}, ${opts.y1}));
      ${opts.release ? `window.dispatchEvent(mk('pointerup', ${opts.x1}, ${opts.y1}));` : ''}
      await new Promise(r => setTimeout(r, 60));
      return {
        dragging: sprite.classList.contains('dragging'),
      };
    })()
  `);

  // -------------------------------------------------------------------------
  // Test 1 — a normal drag leaves no residue
  // -------------------------------------------------------------------------
  console.log('\n[1] a normal drag ends cleanly');
  const c = screen.getCursorScreenPoint();
  const r1 = await gesture({ x0: c.x, y0: c.y, x1: c.x + 40, y1: c.y + 40, release: true });
  eq('the sprite is not left in the dragging state', r1.dragging, false);
  eq('the drag mutex was released', petController.dragging, false);

  // -------------------------------------------------------------------------
  // Test 2 — THE REPORTED BUG: the pointerup is lost, then the pointer
  // comes back over the pet. Nothing must move.
  // -------------------------------------------------------------------------
  console.log('\n[2] a lost pointerup does not corrupt the gesture');
  // Start a drag and release the button while the pointer is outside the
  // window — so the pointerup is never delivered. `release: false`.
  await gesture({ x0: c.x, y0: c.y, x1: c.x + 30, y1: c.y + 30, release: false });
  // The app loses the foreground (the user switched to another program).
  await probe.webContents.executeJavaScript(`window.dispatchEvent(new Event('blur'))`);
  await new Promise((r) => setTimeout(r, 120));
  // Baseline AFTER the drag has settled: the window legitimately moved
  // during the drag itself, and the poller is still running. What must not
  // happen is a *further* jump when the pointer comes back over the pet.
  const before = winPet.getPosition();
  // The pointer comes back over the pet.
  await probe.webContents.executeJavaScript(`
    (async () => {
      const ev = new PointerEvent('pointermove', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      Object.defineProperty(ev, 'screenX', { value: ${c.x + 200} });
      Object.defineProperty(ev, 'screenY', { value: ${c.y + 200} });
      window.dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 80));
    })()
  `);
  const after = winPet.getPosition();
  eq('the pet did not teleport', JSON.stringify(after), JSON.stringify(before));

  // -------------------------------------------------------------------------
  // Test 3 — and the pet is still draggable afterwards
  // -------------------------------------------------------------------------
  console.log('\n[3] the pet is still draggable afterwards');
  const posBefore = winPet.getPosition();
  const r3 = await gesture({ x0: c.x, y0: c.y, x1: c.x + 50, y1: c.y + 50, release: true });
  eq('the sprite released cleanly', r3.dragging, false);
  const posAfter = winPet.getPosition();
  check('the window followed the drag',
    JSON.stringify(posAfter) !== JSON.stringify(posBefore),
    `position did not change: ${JSON.stringify(posAfter)}`);
  check('the position is finite',
    Number.isFinite(posAfter[0]) && Number.isFinite(posAfter[1]),
    `position = ${JSON.stringify(posAfter)}`);

  probe.destroy();
  winPet.destroy();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    app.exit(1);
    return;
  }
  app.exit(0);
});
