// scripts/test-pet-drag-live.js — drives the REAL running app's pet window
// through a full drag gesture and checks that the window actually followed
// the cursor.
//
// This is the closest thing to a manual test that can run unattended: it
// builds the same window the app builds, loads the same renderer, and runs
// the same IPC handlers.
//
// The main process positions the pet window by polling the OS cursor
// (`screen.getCursorScreenPoint()`), so the test drives that cursor itself.
// Without it the pet has nothing to follow and the test could not tell a
// working drag from a broken one.
//
// It also simulates the sequence the user reported as broken:
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let winPet = null;
const petController = { dragging: false, setDragging(on) { this.dragging = !!on; } };
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

// The cursor the main process polls while a drag is running.
const cursor = { x: 0, y: 0 };

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

  // The main process follows the OS cursor, so the test hands it one.
  screen.getCursorScreenPoint = () => ({ x: cursor.x, y: cursor.y });

  // The pet renderer (src/js/pet.js) runs in a real renderer, so the
  // gesture below is handled by the shipped code, not a copy.
  //
  // The events have to carry BOTH coordinate spaces, because the drag uses
  // both: the grab offset is the press's CLIENT coordinates (where the
  // pointer is inside the window), and the fallback movement path uses the
  // SCREEN ones (where the pointer is on the desktop). A synthetic
  // PointerEvent reports 0 for all of them, so they are defined explicitly.
  //
  // `client` is the pointer's position inside the probe window. It starts
  // at the middle of the sprite and travels with the cursor.
  const client = { x: 200, y: 150 };
  const down = (x, y) => probe.webContents.executeJavaScript(`
    (() => {
      const sprite = document.getElementById('pet-sprite');
      const ev = new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: ${client.x}, clientY: ${client.y},
      });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      Object.defineProperty(ev, 'screenX', { value: ${x} });
      Object.defineProperty(ev, 'screenY', { value: ${y} });
      sprite.dispatchEvent(ev);
      return true;
    })()
  `);
  const move = (x, y) => probe.webContents.executeJavaScript(`
    (() => {
      const ev = new PointerEvent('pointermove', {
        bubbles: true, cancelable: true,
        clientX: ${client.x}, clientY: ${client.y},
      });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      Object.defineProperty(ev, 'screenX', { value: ${x} });
      Object.defineProperty(ev, 'screenY', { value: ${y} });
      window.dispatchEvent(ev);
      return true;
    })()
  `);
  const up = (x, y) => probe.webContents.executeJavaScript(`
    (() => {
      const ev = new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0,
        clientX: ${client.x}, clientY: ${client.y},
      });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      Object.defineProperty(ev, 'screenX', { value: ${x} });
      Object.defineProperty(ev, 'screenY', { value: ${y} });
      window.dispatchEvent(ev);
      return true;
    })()
  `);
  const isDragging = () => probe.webContents.executeJavaScript(
    `document.getElementById('pet-sprite').classList.contains('dragging')`
  );

  // A full gesture. The cursor follows the pointer, step by step, because
  // that is what the main process polls. The client position travels with
  // it, by the same distance — that is what a real pointer does.
  //
  // `draggingDuring` is read while the button is still down, `draggingAfter`
  // once it is released — the release clears the class, so the two are read
  // at different moments on purpose.
  const gesture = async (opts) => {
    const dx = opts.x1 - opts.x0;
    const dy = opts.y1 - opts.y0;
    cursor.x = opts.x0; cursor.y = opts.y0;
    // The grab point inside the window — the same point the user would
    // press on the real pet.
    client.x = opts.offX; client.y = opts.offY;
    await down(opts.x0, opts.y0);
    await sleep(40);
    cursor.x = opts.x1; cursor.y = opts.y1;
    client.x = opts.offX + dx; client.y = opts.offY + dy;
    await move(opts.x1, opts.y1);
    await sleep(80);
    const draggingDuring = await isDragging();
    if (opts.release !== false) {
      await up(opts.x1, opts.y1);
      await sleep(120);
    }
    const draggingAfter = await isDragging();
    return { draggingDuring, draggingAfter };
  };

  // Where the user would press to grab the pet: the middle of the sprite,
  // in SCREEN coordinates — plus the same point measured INSIDE the pet
  // window.
  //
  // The second number matters: the grab offset the renderer measures is the
  // press's position inside the window, and the main process places the
  // window at `cursor - offset`. If the offset does not describe the real
  // grab point, the window jumps when the drag starts and the test would
  // measure that jump instead of the drag.
  const grabPoint = async () => {
    const [wx, wy] = winPet.getPosition();
    const r = JSON.parse(await winPet.webContents.executeJavaScript(`
      (() => {
        const b = document.getElementById('pet-sprite').getBoundingClientRect();
        return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height });
      })()
    `));
    return {
      x: wx + r.x + r.w / 2, y: wy + r.y + r.h / 2,
      offX: r.x + r.w / 2, offY: r.y + r.h / 2,
    };
  };

  // -------------------------------------------------------------------------
  // Test 1 — a normal drag leaves no residue
  // -------------------------------------------------------------------------
  console.log('\n[1] a normal drag ends cleanly');
  const g = await grabPoint();
  const r1 = await gesture({ x0: g.x, y0: g.y, x1: g.x + 40, y1: g.y + 40, offX: g.offX, offY: g.offY, release: true });
  eq('the drag was recognised', r1.draggingDuring, true);
  eq('the sprite is not left in the dragging state', r1.draggingAfter, false);
  eq('the drag mutex was released', petController.dragging, false);

  // -------------------------------------------------------------------------
  // Test 2 — THE REPORTED BUG: the pointerup is lost, then the pointer
  // comes back over the pet. Nothing must move.
  // -------------------------------------------------------------------------
  console.log('\n[2] a lost pointerup does not corrupt the gesture');
  // Start a drag and release the button while the pointer is outside the
  // window — so the pointerup is never delivered. `release: false`.
  await gesture({ x0: g.x, y0: g.y, x1: g.x + 30, y1: g.y + 30, offX: g.offX, offY: g.offY, release: false });
  // The app loses the foreground (the user switched to another program).
  await probe.webContents.executeJavaScript(`window.dispatchEvent(new Event('blur'))`);
  await sleep(150);
  // Baseline AFTER the drag has settled: the window legitimately moved
  // during the drag itself, and the poller is still running. What must not
  // happen is a *further* jump when the pointer comes back over the pet.
  const before = winPet.getPosition();
  eq('the drag mutex was released by the teardown', petController.dragging, false);
  // The pointer comes back over the pet.
  cursor.x = g.x + 200; cursor.y = g.y + 200;
  client.x = 200 + 200; client.y = 150 + 200;
  await move(g.x + 200, g.y + 200);
  await sleep(120);
  const after = winPet.getPosition();
  eq('the pet did not teleport', JSON.stringify(after), JSON.stringify(before));

  // -------------------------------------------------------------------------
  // Test 3 — and the pet is still draggable afterwards, and it follows the
  // cursor by exactly the distance the pointer travelled.
  // -------------------------------------------------------------------------
  console.log('\n[3] the pet is still draggable afterwards');
  const g3 = await grabPoint();
  const posBefore = winPet.getPosition();
  const r3 = await gesture({ x0: g3.x, y0: g3.y, x1: g3.x + 50, y1: g3.y + 50, offX: g3.offX, offY: g3.offY, release: true });
  eq('the drag was recognised', r3.draggingDuring, true);
  eq('the sprite released cleanly', r3.draggingAfter, false);
  const posAfter = winPet.getPosition();
  // The window is placed so the grabbed point stays under the cursor, so it
  // has to have moved by exactly the distance the pointer travelled.
  eq('the window followed the cursor',
    JSON.stringify([posAfter[0] - posBefore[0], posAfter[1] - posBefore[1]]),
    JSON.stringify([50, 50]));
  check('the position is finite',
    Number.isFinite(posAfter[0]) && Number.isFinite(posAfter[1]),
    `position = ${JSON.stringify(posAfter)}`);

  // -------------------------------------------------------------------------
  // Test 4 — a single large pointer jump still drags the pet the whole way.
  //
  // This is the shape of the post-resume stall. After a sleep the renderer
  // is slow to hand over pointer events, so the first move it delivers
  // already carries everything the mouse did while it was stalled — the
  // whole movement arrives in one go.
  //
  // The grab offset used to be measured from that move, and the main
  // process cancels the offset out again (`window = cursor - offset`), so
  // the offset swallowed the movement and the pet sat still: the drag was
  // dead. The offset has to be measured from the PRESS.
  // -------------------------------------------------------------------------
  console.log('\n[4] a single large pointer jump drags the pet the whole way');
  const g4 = await grabPoint();
  const pos4Before = winPet.getPosition();
  const r4 = await gesture({ x0: g4.x, y0: g4.y, x1: g4.x + 300, y1: g4.y + 200, offX: g4.offX, offY: g4.offY, release: true });
  eq('the drag was recognised', r4.draggingDuring, true);
  const pos4After = winPet.getPosition();
  eq('the pet travelled the whole distance',
    JSON.stringify([pos4After[0] - pos4Before[0], pos4After[1] - pos4Before[1]]),
    JSON.stringify([300, 200]));

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
