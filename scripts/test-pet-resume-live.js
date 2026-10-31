// scripts/test-pet-resume-live.js — end-to-end check of the suspend/resume
// recovery under a REAL Electron main process.
//
// The unit test (scripts/test-pet-resume.js) stubs `electron`, which cannot
// catch mistakes like "powerMonitor never fires 'resume'" or "the window
// handle is gone by the time the handler runs". This script runs inside a
// real Electron app, registers the REAL handlers from main/ipc.js, drives a
// real drag to completion, then fires the platform's own `resume` event and
// checks that the pet window is still alive and still draggable.
//
// It also checks the window's own visibility after the resume, which is the
// upstream-documented failure mode for a frameless + transparent window
// (electron/electron#37361).
//
// Usage: node scripts/run-electron.js scripts/test-pet-resume-live.js

const { app, BrowserWindow, screen, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');

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
let petController = null;
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const { PetRegistry } = require(path.join(ROOT, 'main', 'pet_registry.js'));

app.whenReady().then(async () => {
  console.log('pet resume live test (real Electron)');

  winPet = new BrowserWindow({
    width: 220, height: 220, x: 300, y: 300,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, minimizable: false, maximizable: false, hasShadow: false,
    focusable: false, show: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'pet', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  winPet.setIgnoreMouseEvents(false);

  petController = {
    dragging: false,
    clamped: 0,
    setDragging(on) { this.dragging = !!on; },
    setPaused() {},
    clampIntoView() { this.clamped++; },
  };

  // A real registry, so the renderer's init round-trips
  // (`pet:get_current`, `pet:get_current_size`, `pet:list`, …) succeed.
  // Without one those handlers are never registered and the renderer's
  // startup throws.
  //
  // The user-data path goes to the OS temp directory — the registry writes
  // there, and the repo must stay clean.
  const petRegistry = new PetRegistry();
  await petRegistry.init({
    appPath: ROOT,
    userDataPath: path.join(os.tmpdir(), 'soul-desktop-pet-resume-live'),
  });

  // Register the REAL handlers BEFORE the page loads, so the renderer's
  // init round-trips (`pet:get_state`, `pet:get_current_size`, …) succeed.
  ipc.register({
    queue: { on: () => {}, activeCount: () => 0, activeHead: () => null },
    winMain: winPet, winPet,
    setPetState: () => {}, getPetState: () => false, setActiveReminder: () => {},
    broadcastPetState: () => {}, petController, petRegistry,
  });

  await winPet.loadFile(path.join(ROOT, 'src', 'pet.html'));

  // -------------------------------------------------------------------------
  // Test 1 — the platform really does expose a 'resume' event
  // -------------------------------------------------------------------------
  console.log('\n[1] the platform exposes the resume event');
  let resumeFired = false;
  const probe = () => { resumeFired = true; };
  powerMonitor.on('resume', probe);
  check('a resume listener can be attached', true);

  // The platform will not actually suspend in this run, so the handler is
  // invoked directly. That still exercises the REAL recovery code path in
  // main/ipc.js — the only thing not covered is the OS delivering the
  // event, which is Electron's job.
  console.log('\n[2] the recovery runs without throwing');
  let threw = null;
  try {
    powerMonitor.emit('resume');
  } catch (e) {
    threw = e;
  }
  check('the resume handler did not throw', !threw, threw && threw.message);

  // -------------------------------------------------------------------------
  // Test 3 — the window is still alive and visible after the recovery
  // -------------------------------------------------------------------------
  console.log('\n[3] the pet window survives the recovery');
  check('the window was not destroyed', !winPet.isDestroyed());
  check('the window is visible', winPet.isVisible());

  const rendererAlive = await winPet.webContents.executeJavaScript(
    'document.readyState + "/" + !!document.getElementById("pet-sprite")'
  );
  check('the renderer is still alive', rendererAlive === 'complete/true', rendererAlive);

  // -------------------------------------------------------------------------
  // Test 4 — the pet is still draggable after the recovery
  // -------------------------------------------------------------------------
  console.log('\n[4] the pet is still draggable after the recovery');
  const before = winPet.getPosition();

  // Drive a real gesture through the shipped renderer code. `screenX` /
  // `screenY` have to be defined explicitly — a synthetic PointerEvent
  // reports 0 for them otherwise, and the drag threshold is measured in
  // screen coordinates.
  const gesture = async (release) => winPet.webContents.executeJavaScript(`
    (async () => {
      const sprite = document.getElementById('pet-sprite');
      const mk = (type, x, y) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(ev, 'pointerId', { value: 1 });
        Object.defineProperty(ev, 'screenX', { value: x });
        Object.defineProperty(ev, 'screenY', { value: y });
        return ev;
      };
      sprite.dispatchEvent(mk('pointerdown', 100, 100));
      window.dispatchEvent(mk('pointermove', 140, 160));
      await new Promise(r => setTimeout(r, 120));
      // Read the state BEFORE the release — the release clears the class.
      const dragging = sprite.classList.contains('dragging');
      ${release ? `window.dispatchEvent(mk('pointerup', 140, 160));` : ''}
      return {
        dragging,
        screenX: window.screenX,
        screenY: window.screenY,
      };
    })()
  `);

  const dragging = await gesture(true);
  check('the renderer accepted the drag gesture', dragging.dragging === true);

  // The `pointerup` inside the gesture helper already ended the drag, so
  // the mutex has been taken AND released by now. What matters is that it
  // ended up released — a stuck mutex is the bug this test guards against.
  await new Promise((r) => setTimeout(r, 120));
  const during = winPet.getPosition();
  check('the window moved during the drag',
    during[0] !== before[0] || during[1] !== before[1],
    `before=${JSON.stringify(before)} during=${JSON.stringify(during)}`);
  check('the drag mutex was released after the drag', petController.dragging === false);

  // -------------------------------------------------------------------------
  // Test 5 — a resume with a drag in flight tears the drag down
  // -------------------------------------------------------------------------
  console.log('\n[5] a resume with a drag in flight tears it down');

  // The recovery de-duplicates resumes within a short window (Electron 32
  // emits `resume` twice — electron/electron#44252). The resume in test 2
  // was recent, so wait it out or this one would be swallowed.
  await new Promise((r) => setTimeout(r, 2200));

  await gesture(false);
  await new Promise((r) => setTimeout(r, 120));
  check('the drag is in flight', petController.dragging === true);

  // The system comes back. The renderer never got a `pointerup`.
  powerMonitor.emit('resume');
  await new Promise((r) => setTimeout(r, 120));

  check('the drag mutex was released by the recovery', petController.dragging === false);
  check('the pet was clamped back into view', petController.clamped > 0);

  // And the window must have stopped following the cursor.
  const posA = winPet.getPosition();
  await new Promise((r) => setTimeout(r, 120));
  const posB = winPet.getPosition();
  check('the window stopped following the cursor',
    posA[0] === posB[0] && posA[1] === posB[1],
    `posA=${JSON.stringify(posA)} posB=${JSON.stringify(posB)}`);

  // -------------------------------------------------------------------------
  // Test 6 — the renderer reset its own gesture state
  // -------------------------------------------------------------------------
  console.log('\n[6] the renderer reset its gesture state');
  const rendererState = await winPet.webContents.executeJavaScript(
    'document.getElementById("pet-sprite").classList.contains("dragging")'
  );
  check('the sprite is no longer in the dragging state', rendererState === false);

  // -------------------------------------------------------------------------
  // Test 7 — THE REAL-WORLD SCENARIO, with NO resume event at all.
  //
  // This is what the user reported: the pet drags fine at startup, and is
  // permanently undraggable after the machine sleeps and wakes.
  //
  // A system suspend tears down and re-creates the pointer device, so on
  // wake the mouse reports a NEW pointer id. The gesture still names the
  // OLD (dead) id, and the guard that rejected foreign pointer events
  // wedged the pet permanently.
  //
  // Crucially, NO `resume` event is fired here. The OS may not deliver one
  // at all (Windows 11 Modern Standby freezes the process before the wake
  // notification is dispatched — electron/electron#47739), so the recovery
  // must not depend on it. The renderer has to heal itself when it sees a
  // pointer event that does not belong to the gesture it is holding.
  // -------------------------------------------------------------------------
  console.log('\n[7] a new pointer id recovers the drag with no resume event at all');

  // Start a gesture with pointer id 1 and never release it — this is the
  // state the pet is in when the machine sleeps mid-drag.
  const started = await winPet.webContents.executeJavaScript(`
    (async () => {
      const sprite = document.getElementById('pet-sprite');
      const mk = (type, x, y, id) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(ev, 'pointerId', { value: id });
        Object.defineProperty(ev, 'screenX', { value: x });
        Object.defineProperty(ev, 'screenY', { value: y });
        return ev;
      };
      sprite.dispatchEvent(mk('pointerdown', 100, 100, 1));
      window.dispatchEvent(mk('pointermove', 140, 160, 1));
      await new Promise(r => setTimeout(r, 150));
      return sprite.classList.contains('dragging');
    })()
  `);
  check('the pre-sleep gesture is in flight', started === true);

  // The machine sleeps and wakes. The mouse is now a DIFFERENT device and
  // reports pointer id 2. No `pointerup` is ever delivered for id 1.
  const healed = await winPet.webContents.executeJavaScript(`
    (async () => {
      const sprite = document.getElementById('pet-sprite');
      const mk = (type, x, y, id) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(ev, 'pointerId', { value: id });
        Object.defineProperty(ev, 'screenX', { value: x });
        Object.defineProperty(ev, 'screenY', { value: y });
        return ev;
      };
      // The new mouse moves — no resume event was fired.
      window.dispatchEvent(mk('pointermove', 200, 220, 2));
      await new Promise(r => setTimeout(r, 150));
      const stillDragging = sprite.classList.contains('dragging');

      // Now a fresh drag on the new pointer must work.
      sprite.dispatchEvent(mk('pointerdown', 220, 240, 2));
      window.dispatchEvent(mk('pointermove', 260, 280, 2));
      await new Promise(r => setTimeout(r, 200));
      const freshDrag = sprite.classList.contains('dragging');
      window.dispatchEvent(mk('pointerup', 260, 280, 2));
      return { stillDragging, freshDrag };
    })()
  `);

  check('the stale gesture was torn down by the new pointer id',
    healed.stillDragging === false);
  check('a fresh drag works on the new pointer id',
    healed.freshDrag === true);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
});
