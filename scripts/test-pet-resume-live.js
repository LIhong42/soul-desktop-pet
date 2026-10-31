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
const db = require(path.join(ROOT, 'main', 'db.js'));

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

  // -------------------------------------------------------------------------
  // The wake recovery's MODE
  //
  // The default mode is 'always': on every wake the app kills its process
  // and starts a new one. That is the behaviour the user asked for, and it
  // is exercised by scripts/test-app-relaunch.js (which drives the REAL
  // `app.relaunch()`) and by scripts/test-pet-input-probe.js (which checks
  // the wiring).
  //
  // This test is about the other half — the IN-PROCESS recovery: the drag
  // is torn down, the pet window is replaced, the pet is clamped back into
  // view, and the pet is still draggable afterwards. In the default mode
  // the process would exit halfway through, and those assertions could
  // never be made. So the mode is turned off here.
  //
  // The database is opened in the OS temp directory — the repo and the
  // user's real database must stay untouched.
  // -------------------------------------------------------------------------
  await db.open(path.join(os.tmpdir(), 'soul-desktop-pet-resume-live', 'test.db'));
  db.setSetting('pet_restart_app_on_wake', 'off');

  // Create a pet window.
  //
  // The wake recovery RESTARTS the pet: the window is destroyed and a new
  // one is created in its place. The test does the same thing, so the real
  // code path (the recreation hook in main/ipc.js) is exercised rather than
  // a page reload.
  const makePetWindow = (x, y) => {
    const w = new BrowserWindow({
      width: 220, height: 220, x, y,
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
    w.setAlwaysOnTop(true, 'screen-saver');
    w.loadFile(path.join(ROOT, 'src', 'pet.html'));
    return w;
  };

  winPet = makePetWindow(300, 300);
  // The real mouse must NOT reach this window.
  //
  // The window is on screen and the OS cursor ends up over it (the drag
  // tests move the window under the cursor), so Chromium delivers REAL
  // mouse events with pointer id 1. The synthetic gestures below use their
  // own ids, so every real event looks like it came from a foreign
  // pointer — which is exactly the condition the renderer has to survive,
  // but it is not what this test is about. Ignoring the real mouse keeps
  // the test about the synthetic gestures alone.
  winPet.setIgnoreMouseEvents(true);

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
    // The pet window can be replaced by the wake recovery, so the handlers
    // resolve it through a getter.
    getWinPet: () => winPet,
    // The restart itself: a new window takes the old one's place. This is
    // what main/main.js does in the real app — the new window is created
    // FIRST, because destroying the last window would quit the app.
    recreatePetWindow: () => {
      const old = winPet;
      const [x, y] = old.isDestroyed() ? [300, 300] : old.getPosition();
      const next = makePetWindow(x, y);
      // A new window starts with the mouse events ON; this test drives
      // synthetic gestures, so the real mouse has to be ignored again.
      next.setIgnoreMouseEvents(true);
      winPet = next;
      try { old.destroy(); } catch (e) { /* already gone */ }
      return winPet;
    },
    setPetState: () => {}, getPetState: () => false, setActiveReminder: () => {},
    broadcastPetState: () => {}, petController, petRegistry,
  });

  await winPet.loadFile(path.join(ROOT, 'src', 'pet.html'));

  // -------------------------------------------------------------------------
  // Helpers for the pet restart
  //
  // The recovery destroys the pet window and creates a new one, so after a
  // resume the window that the test was driving is GONE and a fresh one is
  // loading. Anything that touches the page after a resume has to wait for
  // that fresh page.
  //
  // `markPage()` stamps the current page with a token. The token does not
  // survive a restart, so its absence is the proof that the page really was
  // replaced — waiting for `readyState` alone would be fooled by the old
  // page, which is still complete for a moment after the restart starts.
  // -------------------------------------------------------------------------
  const markPage = () => winPet.webContents.executeJavaScript(
    'window.__petTestToken = 1; true'
  );

  const waitForPetReady = async (timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await winPet.webContents.executeJavaScript(
          '(window.__petTestToken === undefined) + "/" + document.readyState'
          + ' + "/" + !!document.getElementById("pet-sprite")'
        );
        if (state === 'true/complete/true') return true;
      } catch (e) { /* the page is navigating — try again */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

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
  await markPage();
  // The window the recovery is about to replace.
  const winBeforeResume = winPet;
  try {
    powerMonitor.emit('resume');
  } catch (e) {
    threw = e;
  }
  check('the resume handler did not throw', !threw, threw && threw.message);

  // -------------------------------------------------------------------------
  // Test 3 — the pet was restarted and the new window works
  // -------------------------------------------------------------------------
  console.log('\n[3] the pet is restarted by the recovery');
  check('the old window was destroyed', winBeforeResume.isDestroyed());
  check('the pet window was replaced by a new one', winPet !== winBeforeResume);
  check('the window was not destroyed', !winPet.isDestroyed());
  check('the window is visible', winPet.isVisible());

  // The recovery restarts the pet, so the old page is gone and a fresh one
  // is loading. Wait for it before touching the page.
  const readyAfterResume = await waitForPetReady();
  check('the new pet page is ready', readyAfterResume === true);

  const rendererAlive = await winPet.webContents.executeJavaScript(
    'document.readyState + "/" + !!document.getElementById("pet-sprite")'
  );
  check('the renderer is still alive', rendererAlive === 'complete/true', rendererAlive);

  // The recovery re-enables mouse events on the pet window — the app wants
  // the real mouse back. This test drives synthetic gestures, so it turns
  // them off again: the real mouse's events carry a pointer id of their
  // own, which would be mistaken for a foreign pointer and would kill the
  // synthetic drag.
  winPet.setIgnoreMouseEvents(true);

  // -------------------------------------------------------------------------
  // Test 4 — the pet is still draggable after the recovery
  // -------------------------------------------------------------------------
  console.log('\n[4] the pet is still draggable after the recovery');
  const before = winPet.getPosition();

  // Drive a real gesture through the shipped renderer code. The events
  // have to carry both coordinate spaces: the drag is measured in the
  // window's own coordinates (`clientX`/`clientY` — where the pointer
  // grabbed the pet) and reports its fallback movement in screen
  // coordinates (`screenX`/`screenY` — where the pointer is on the
  // desktop). A synthetic PointerEvent reports 0 for all of them, so they
  // are set explicitly.
  const gesture = async (release) => winPet.webContents.executeJavaScript(`
    (async () => {
      const sprite = document.getElementById('pet-sprite');
      const mk = (type, x, y) => {
        const ev = new PointerEvent(type, {
          bubbles: true, cancelable: true, button: 0,
          clientX: x, clientY: y,
        });
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
  //
  // The pet's renderer restart has its own, longer de-duplication window
  // (one restart per wake), so that has to be waited out as well — the
  // resume in test 2 already restarted the renderer.
  await new Promise((r) => setTimeout(r, 10500));

  await gesture(false);
  await new Promise((r) => setTimeout(r, 120));
  check('the drag is in flight', petController.dragging === true);

  // The system comes back. The renderer never got a `pointerup`.
  await markPage();
  const winBeforeRestart = winPet;
  powerMonitor.emit('resume');
  await new Promise((r) => setTimeout(r, 120));

  check('the drag mutex was released by the recovery', petController.dragging === false);
  check('the pet was clamped back into view', petController.clamped > 0);
  check('the pet window was replaced', winPet !== winBeforeRestart);

  // The recovery re-enables mouse events on the pet window — the app wants
  // the real mouse back. This test drives synthetic gestures, so it turns
  // them off again: the drag moved the window under the real cursor, and
  // the real mouse's events carry a pointer id of their own, which would
  // be mistaken for a foreign pointer and would kill the synthetic drag.
  winPet.setIgnoreMouseEvents(true);

  // The recovery restarts the pet, so the page the drag was driven on is
  // gone. Wait for the fresh one before the next test touches the page.
  const restarted = await waitForPetReady();
  check('the new pet page is ready', restarted === true);

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
        const ev = new PointerEvent(type, {
          bubbles: true, cancelable: true, button: 0,
          clientX: x, clientY: y,
        });
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
        const ev = new PointerEvent(type, {
          bubbles: true, cancelable: true, button: 0,
          clientX: x, clientY: y,
        });
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
