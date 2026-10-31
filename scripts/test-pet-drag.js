// scripts/test-pet-drag.js — regression test for the pet drag state machine.
//
// The bug this guards against: the pet window is `focusable: false` and only
// ~220 px across, so a `mouseup` that happens outside that rectangle never
// reaches the renderer. The old implementation left its `pressing` flag stuck
// true forever, and every later mouse move inside the window then computed
// its delta against a stale baseline — teleporting the pet across the screen
// and leaving it permanently undraggable.
//
// This drives the real src/js/pet.js drag code under jsdom with a stubbed
// `window.mp` bridge, so it exercises the actual event handlers rather than a
// re-implementation of them.
//
// Usage: node scripts/test-pet-drag.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Tiny assertion helpers
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Boot the pet renderer under jsdom
// ---------------------------------------------------------------------------
// Every jsdom window created by `bootPet`, so they can be closed when the
// suite finishes.
//
// Closing matters: the renderer starts a watchdog `setInterval`, and jsdom
// windows keep their timers alive. Without closing them the Node process
// never exits and the test run hangs until it is killed.
// ---------------------------------------------------------------------------
const bootedWindows = [];

function bootPet(opts = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'pet.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'file:///' + path.join(ROOT, 'src', 'pet.html').replace(/\\/g, '/'),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  bootedWindows.push(dom);

  // --- stub the preload bridge -------------------------------------------
  const calls = [];
  // The main process's channel subscriptions, so a test can push one.
  const channels = new Map();
  const record = (channel, args) => {
    calls.push({ channel, args });
    // Every invoke resolves; `pet:drag_start` resolves truthy so the
    // renderer takes the 'main' ownership branch.
    return Promise.resolve(true);
  };
  // The live window position the main process would report. Defaults to
  // (0,0) so it matches the pinned `window.screenX/Y` below — meaning the
  // grab offset is the same either way unless a test overrides it.
  let livePos = { x: 0, y: 0 };
  // The pet's live state. A test passes `opts.petState` to boot the
  // renderer as if a reminder were pending.
  const petState = opts.petState || { state: 'NORMAL', count: 0, head: null };
  window.mp = {
    pet: {
      getState: () => Promise.resolve(petState),
      getCurrent: () => Promise.resolve('vup'),
      getCurrentSize: () => Promise.resolve({ w: 220, h: 220, spriteW: 220, spriteH: 220 }),
      resolveFrames: () => Promise.resolve({ frames: [], variantHint: '', loop: true }),
      // The authoritative window position. A test can move it to simulate
      // the OS having moved the window across a suspend.
      getPosition: () => (opts.noGetPosition
        ? undefined
        : Promise.resolve({ x: livePos.x, y: livePos.y })),
      moveBy: (dx, dy) => record('move_by', [dx, dy]),
      dragStart: (dx, dy) => record('drag_start', [dx, dy]),
      dragEnd: () => record('drag_end', []),
      setPaused: (ms) => record('set_paused', [ms]),
      openContextMenu: () => record('context_menu', []),
      triggerAction: () => record('trigger_action', []),
      actionEnded: () => record('action_ended', []),
      actionsConfig: { get: () => Promise.resolve({ config: { triggers: { click: 'default' } } }) },
    },
    on: (channel, cb) => {
      if (!channels.has(channel)) channels.set(channel, []);
      channels.get(channel).push(cb);
      return () => {};
    },
    // 关闭提醒 — the pet window's way of acknowledging the reminder it is
    // nagging about.
    reminders: {
      completeForToday: (source, id) => record('complete_for_today', [source, id]),
    },
    app: { quit: () => {} },
  };

  // `window.screenX/Y` are the window's position on the desktop. jsdom
  // reports 0, which is a valid value for the maths, but pin it so the
  // test asserts against known numbers.
  Object.defineProperty(window, 'screenX', { value: 0, writable: true, configurable: true });
  Object.defineProperty(window, 'screenY', { value: 0, writable: true, configurable: true });
  Object.defineProperty(window, 'screen', {
    value: { X: 0, Y: 0, width: 1920, height: 1080 },
    writable: true, configurable: true,
  });

  // Run the real pet.js. It is a plain script (no modules), so evaluating
  // it in the jsdom window context wires up the real handlers.
  const code = fs.readFileSync(path.join(ROOT, 'src', 'js', 'pet.js'), 'utf8');
  window.eval(code);

  // Install the pointer-capture stand-in AFTER pet.js has run, because
  // pet.js grabs the sprite element and the capture API is called on it
  // during the gesture (not at load time), so ordering does not matter for
  // the handlers — only the sprite needs the methods.
  const sprite = window.document.getElementById('pet-sprite');
  const capture = installPointerCapture(sprite);

  // Push a main-process channel message into the renderer.
  const emit = (channel, payload) => {
    for (const cb of (channels.get(channel) || [])) cb(payload);
  };
  // Move the window position the main process reports.
  const setLivePos = (x, y) => { livePos = { x, y }; };

  return { window, calls, record, emit, setLivePos, sprite, capture };
}

// A minimal PointerEvent-ish object. jsdom has no PointerEvent, so build
// one from MouseEvent and add the pointer fields the code reads.
function pointer(win, type, { x, y, id = 1, button = 0 }) {
  const ev = new win.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  });
  Object.defineProperty(ev, 'pointerId', { value: id });
  Object.defineProperty(ev, 'screenX', { value: x });
  Object.defineProperty(ev, 'screenY', { value: y });
  return ev;
}

// Give the sprite a working pointer-capture implementation.
//
// jsdom does not implement the Pointer Events capture API at all, so
// `setPointerCapture` / `releasePointerCapture` / `hasPointerCapture` are
// missing and the renderer's capture handling cannot be exercised. This
// installs a faithful-enough stand-in: it records which pointer ids are
// captured and fires `lostpointercapture` when a capture is released.
//
// `sprite` is exposed on the returned handle so a test can assert on the
// capture state.
function installPointerCapture(sprite) {
  const captured = new Set();
  sprite.setPointerCapture = (id) => { captured.add(id); };
  sprite.releasePointerCapture = (id) => {
    if (!captured.has(id)) return;
    captured.delete(id);
    // The real browser fires `lostpointercapture` on the element that held
    // the capture. Dispatch it on the sprite so the window-level listener
    // in pet.js sees it (the event bubbles).
    try {
      const ev = new sprite.ownerDocument.defaultView.MouseEvent('lostpointercapture', { bubbles: true });
      Object.defineProperty(ev, 'pointerId', { value: id });
      sprite.dispatchEvent(ev);
    } catch (e) { /* jsdom quirk */ }
  };
  sprite.hasPointerCapture = (id) => captured.has(id);
  return {
    captured,
    has: (id) => captured.has(id),
    ids: () => Array.from(captured),
    // Revoke the capture the way the platform would, WITHOUT a pointerup.
    release: (id) => sprite.releasePointerCapture(id),
  };
}

const spriteOf = (win) => win.document.getElementById('pet-sprite');

// ---------------------------------------------------------------------------
// Test 1 — a normal drag reports a start and an end
// ---------------------------------------------------------------------------
function testNormalDrag() {
  console.log('\n[1] normal drag starts and ends');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  // Cross the 4 px threshold.
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 120, y: 130 }));

  // `drag_start` is reported after the renderer resolves the window's live
  // position, so it lands a tick later than the pointer events.
  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    const ended = calls.filter((c) => c.channel === 'drag_end');
    eq('drag_start was reported once', started.length, 1);
    eq('drag_end was reported once', ended.length, 1);
    check('the drag class is removed on release', !sprite.classList.contains('dragging'));
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 2 — THE REGRESSION: a mouseup that never arrives must not corrupt
// the state machine.
//
// This is the reported bug: drag the pet, release the button while the
// cursor is outside the pet's 220 px rectangle, then move the mouse over
// the pet again. Before the fix, `pressing` stayed true and the pet
// teleported across the screen.
// ---------------------------------------------------------------------------
function testLostMouseupDoesNotCorruptState() {
  console.log('\n[2] a lost mouseup must not corrupt the drag state');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  // Start a drag and move it.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));

  // The user releases the button OUTSIDE the window. In a real Electron
  // window this event is never delivered — the window is not under the
  // cursor any more. Model that by simply not dispatching `pointerup`.
  //
  // In practice the gesture is then rescued by one of the foreground-loss
  // handlers (`blur` / `visibilitychange`), which fire when the user
  // switches to another application.
  window.dispatchEvent(new window.Event('blur'));

  // Now the user moves the mouse over the pet again — as happens when they
  // go back to work in another application. Before the fix this fired a
  // `move_by` with a delta computed against a stale baseline.
  const before = calls.filter((c) => c.channel === 'move_by').length;
  window.dispatchEvent(pointer(window, 'pointermove', { x: 400, y: 400 }));
  const after = calls.filter((c) => c.channel === 'move_by').length;

  eq('no stray move_by is emitted while the gesture is stale', after, before);

  // And a fresh drag works normally afterwards.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 140, y: 160 }));
  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('a fresh drag still starts', started.length, 2);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 3 — blur / visibilitychange rescue the gesture
// ---------------------------------------------------------------------------
function testBlurResetsGesture() {
  console.log('\n[3] losing the foreground resets the gesture');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));

  // The app is backgrounded — `blur` fires.
  window.dispatchEvent(new window.Event('blur'));

  const ended = calls.filter((c) => c.channel === 'drag_end');
  eq('drag_end was reported', ended.length, 1);
  check('the drag class is removed', !sprite.classList.contains('dragging'));

  // A stray move afterwards must not move the pet.
  const before = calls.filter((c) => c.channel === 'move_by').length;
  window.dispatchEvent(pointer(window, 'pointermove', { x: 500, y: 500 }));
  const after = calls.filter((c) => c.channel === 'move_by').length;
  eq('no stray move_by after the reset', after, before);
}

// ---------------------------------------------------------------------------
// Test 4 — pointercancel also ends the gesture
// ---------------------------------------------------------------------------
function testPointerCancelEndsGesture() {
  console.log('\n[4] pointercancel ends the gesture');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));
  window.dispatchEvent(pointer(window, 'pointercancel', { x: 120, y: 130 }));

  const ended = calls.filter((c) => c.channel === 'drag_end');
  eq('drag_end was reported', ended.length, 1);
  check('the drag class is removed', !sprite.classList.contains('dragging'));
}

// ---------------------------------------------------------------------------
// Test 5 — the main process owns the position once the takeover lands, so
// the renderer must not also apply a delta (the two would compound).
// ---------------------------------------------------------------------------
function testMainProcessOwnsPosition() {
  console.log('\n[5] the main process owns the window position during a drag');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));

  // Let the drag_start IPC promise settle, so ownership flips to 'main'.
  return new Promise((resolve) => setTimeout(() => {
    window.dispatchEvent(pointer(window, 'pointermove', { x: 160, y: 200 }));
    const moveBys = calls.filter((c) => c.channel === 'move_by');
    eq('the renderer reports no move_by while the main process drives', moveBys.length, 0);
    resolve();
  }, 10));
}

// ---------------------------------------------------------------------------
// Test 6 — a click (no drag) still reaches the click handler
// ---------------------------------------------------------------------------
function testClickStillWorks() {
  console.log('\n[6] a plain click still fires the configured action');
  const { window } = bootPet();
  const sprite = spriteOf(window);
  let clicked = 0;
  sprite.addEventListener('click', () => { clicked++; });

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  // Below the threshold — a click, not a drag.
  window.dispatchEvent(pointer(window, 'pointermove', { x: 101, y: 101 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 101, y: 101 }));
  sprite.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  eq('the click event reached the sprite', clicked, 1);
}

// ---------------------------------------------------------------------------
// Test 7 — THE RESUME REGRESSION: a suspend that swallows the `pointerup`
// must not leave the renderer in a state where the pet is undraggable.
//
// This is the reported bug: after the computer sleeps and wakes up, the pet
// can no longer be dragged.
//
// During the sleep the `pointerup` never arrives, so the renderer's
// `pressing` flag stays true. The main process tells the renderer about the
// resume over the `pet:resume` channel; the renderer must reset its gesture
// state and tell the main process the drag is over.
// ---------------------------------------------------------------------------
function testResumeResetsGesture() {
  console.log('\n[7] a resume resets a gesture the sleep swallowed');
  const { window, calls, emit } = bootPet();
  const sprite = spriteOf(window);

  // The user presses and drags — but the machine sleeps before they let go.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));
  // No `pointerup` — it happened while the machine was asleep.

  // The main process announces the resume.
  emit('pet:resume');

  const ended = calls.filter((c) => c.channel === 'drag_end');
  eq('drag_end was reported to the main process', ended.length, 1);
  check('the drag class is removed', !sprite.classList.contains('dragging'));

  // A stray mouse move afterwards must NOT move the pet: the gesture is over.
  const before = calls.filter((c) => c.channel === 'move_by').length;
  window.dispatchEvent(pointer(window, 'pointermove', { x: 400, y: 400 }));
  const after = calls.filter((c) => c.channel === 'move_by').length;
  eq('no stray move_by after the resume', after, before);

  // And a fresh drag works normally afterwards.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 140, y: 160 }));
  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('a fresh drag still starts', started.length, 2);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 8 — the resume reports the drag end even when the renderer never
// started a gesture.
//
// The main process's `pet:drag_end` handler is idempotent, so sending it
// unconditionally is safe — and it is the only way to guarantee the main
// process releases its drag mutex when the renderer lost the gesture.
// ---------------------------------------------------------------------------
function testResumeAlwaysEndsDrag() {
  console.log('\n[8] a resume always tells the main process the drag is over');
  const { window, calls, emit } = bootPet();

  // No gesture in progress at all — the renderer may have lost it during
  // the suspend.
  emit('pet:resume');

  const ended = calls.filter((c) => c.channel === 'drag_end');
  eq('drag_end was reported anyway', ended.length, 1);
}

// ---------------------------------------------------------------------------
// Test 11 — a resume is NOT a click.
//
// The resume path reuses `endDrag`, but it must not run the click side
// effects: waking the machine up would otherwise dismiss a pending
// reminder bubble the user never acknowledged.
// ---------------------------------------------------------------------------
function testResumeIsNotAClick() {
  console.log('\n[11] a resume does not run the click side effects');
  const { window, calls, emit } = bootPet();

  emit('pet:resume');

  const paused = calls.filter((c) => c.channel === 'set_paused');
  eq('no pause was requested', paused.length, 0);
}

// ---------------------------------------------------------------------------
// Test 9 — the grab offset uses the main process's live window position.
//
// `window.screenX` can be stale after a suspend/resume (the OS may have
// moved the window). The offset must be measured against the position the
// main process reports, otherwise the pet jumps when the drag starts.
// ---------------------------------------------------------------------------
function testGrabOffsetUsesLivePosition() {
  console.log('\n[9] the grab offset is measured against the live window position');
  const { window, calls, setLivePos } = bootPet();
  const sprite = spriteOf(window);

  // The OS moved the window while the machine was asleep. The renderer's
  // own `window.screenX` is stale at 0; the main process reports 500.
  setLivePos(500, 400);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 600, y: 450 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 620, y: 470 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started', started.length, 1);
    // Offset = pointer - live window position = (620-500, 470-400).
    eq('the offset used the live position',
      JSON.stringify(started[0].args), JSON.stringify([120, 70]));
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 10 — a main process without `getPosition` still works.
//
// Older main processes don't expose the live position. The renderer must
// fall back to `window.screenX` rather than break the drag.
// ---------------------------------------------------------------------------
function testGrabOffsetFallback() {
  console.log('\n[10] the grab offset falls back when the live position is unavailable');
  const { window, calls } = bootPet({ noGetPosition: true });
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started', started.length, 1);
    // Fallback offset = pointer - window.screenX/Y = (120-0, 130-0).
    eq('the offset used the fallback',
      JSON.stringify(started[0].args), JSON.stringify([120, 130]));
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 12 — THE REAL-WORLD REGRESSION: after a real sleep the pointer
// device is re-created, so the new mouse reports a DIFFERENT pointer id.
// The old code ignored every event whose id did not match the captured one,
// which wedged the pet permanently.
//
// This is the bug the user reported: the pet is draggable at startup, and
// permanently undraggable after the machine sleeps and wakes.
// ---------------------------------------------------------------------------
function testNewPointerIdAfterSleepRecovers() {
  console.log('\n[12] a new pointer id (the mouse after a sleep) recovers the drag');
  const { window, calls, sprite } = bootPet();
  const s = spriteOf(window);

  // The user presses the pet. Pointer id 1 — the pre-sleep mouse.
  s.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100, id: 1 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130, id: 1 }));

  // The machine sleeps. On wake the mouse is a NEW device with id 2.
  // The old `pointerup` never arrives — it happened while we were asleep.
  window.dispatchEvent(pointer(window, 'pointermove', { x: 200, y: 220, id: 2 }));

  // The stale gesture must have been torn down, not silently ignored.
  const ended = calls.filter((c) => c.channel === 'drag_end');
  eq('the stale gesture was ended', ended.length, 1);
  check('the drag class was removed', !sprite.classList.contains('dragging'));

  // And the pet must be draggable again.
  s.dispatchEvent(pointer(window, 'pointerdown', { x: 300, y: 300, id: 2 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 340, y: 350, id: 2 }));
  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('a fresh drag starts after the pointer id changed', started.length, 2);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 13 — the same, but the user CLICKS instead of moving the mouse.
//
// A click produces no `pointermove` at all, so the self-heal in the
// move handler cannot fire. The `pointerdown` handler resets the gesture
// unconditionally, so the pet must still be draggable.
// ---------------------------------------------------------------------------
function testClickAfterSleepRecovers() {
  console.log('\n[13] a click after a sleep (no pointermove) still drags');
  const { window, calls } = bootPet();
  const s = spriteOf(window);

  // Pre-sleep gesture, pointer id 1. No pointerup — the machine slept.
  s.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100, id: 1 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130, id: 1 }));

  // Wake: a click on the sprite with the new pointer id 2.
  s.dispatchEvent(pointer(window, 'pointerdown', { x: 140, y: 150, id: 2 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 180, y: 190, id: 2 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    check('the drag started on the new pointer', started.length >= 1);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 14 — the pointer capture must be released when a gesture ends.
//
// A stale capture on the sprite keeps Chromium routing that pointer's
// events to the sprite, which is part of why the pet stops responding.
// The forced teardown path must release it too — the old code only
// released the capture inside the `pointerup` handler, so a gesture torn
// down any other way left the capture in place.
// ---------------------------------------------------------------------------
function testCaptureIsReleasedOnForcedTeardown() {
  console.log('\n[14] the pointer capture is released when the gesture is torn down');
  const { window, emit, capture } = bootPet();
  const s = spriteOf(window);

  s.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100, id: 7 }));
  eq('the capture is held during the gesture', capture.has(7), true);

  // Force the teardown (this is what the resume path does).
  emit('pet:resume');

  eq('the capture was released', capture.has(7), false);
}

// ---------------------------------------------------------------------------
// Test 15 — a `lostpointercapture` without a `pointerup` ends the gesture.
//
// The browser fires this when it revokes the capture, or when the pointer
// device is torn down by a system suspend. Without a listener for it, the
// gesture stays `pressing = true` with a dangling pointer id.
// ---------------------------------------------------------------------------
function testLostPointerCaptureEndsGesture() {
  console.log('\n[15] a lostpointercapture ends the gesture');
  const { window, calls, capture } = bootPet();
  const s = spriteOf(window);

  s.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100, id: 9 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130, id: 9 }));

  // The capture is revoked by the platform (no pointerup).
  capture.release(9);

  const ended = calls.filter((c) => c.channel === 'drag_end');
  eq('drag_end was reported', ended.length, 1);

  // And the pet is draggable again.
  s.dispatchEvent(pointer(window, 'pointerdown', { x: 200, y: 200, id: 10 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 240, y: 240, id: 10 }));
  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    check('a fresh drag still starts', started.length >= 1);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 16 — a click on the pet closes the reminder it is nagging about.
//
// The bug this guards against: the click used to hide the pet's speech
// bubble and nothing else. The badge kept counting, the sprite kept
// shaking and the top-bar pill kept reading 桌宠提醒 — a reminder with no
// way to be turned off. The click now completes the reminder for today,
// which is the same soft-dismiss the main window's 完成 button performs.
//
// It also pins down that the click side effects actually RUN: releasing
// the pointer capture fires `lostpointercapture`, which used to tear the
// gesture down a second time and swallow them.
// ---------------------------------------------------------------------------
function testClickClosesReminder() {
  console.log('\n[16] a click on the pet closes the reminder');
  const { window, calls } = bootPet({
    petState: {
      state: 'REMINDER',
      count: 1,
      head: {
        title: '刘杰的生日',
        source: 'event',
        source_id: 7,
        contact_name: '小绮',
      },
    },
  });
  const sprite = spriteOf(window);

  // Let the renderer's init read the state and paint the badge/bubble.
  return new Promise((resolve) => setTimeout(() => {
    const badge = window.document.getElementById('pet-badge');
    const bubble = window.document.getElementById('pet-bubble');
    check('the badge is showing', !badge.classList.contains('hidden'));
    check('the bubble is showing', !bubble.classList.contains('hidden'));

    sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
    window.dispatchEvent(pointer(window, 'pointerup', { x: 100, y: 100 }));

    setTimeout(() => {
      const done = calls.filter((c) => c.channel === 'complete_for_today');
      eq('the reminder was completed', done.length, 1);
      eq('with the right source and id',
        JSON.stringify(done[0] ? done[0].args : null),
        JSON.stringify(['event', 7]));
      check('the badge is gone', badge.classList.contains('hidden'));
      check('the bubble is gone', bubble.classList.contains('hidden'));
      resolve();
    }, 20);
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 17 — a click on the pet with nothing pending changes nothing.
//
// The dismissal must not fire a "complete" for a reminder that does not
// exist — that would write a stray ack row for a bogus source.
// ---------------------------------------------------------------------------
function testClickWithoutReminderDoesNothing() {
  console.log('\n[17] a click with no pending reminder completes nothing');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 100, y: 100 }));

  return new Promise((resolve) => setTimeout(() => {
    const done = calls.filter((c) => c.channel === 'complete_for_today');
    eq('nothing was completed', done.length, 0);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 18 — clicking the speech bubble closes the reminder too.
//
// The bubble is the explicit "close this" target: it is a separate element
// from the sprite, so it must dismiss without also firing the pet's click
// reaction.
// ---------------------------------------------------------------------------
function testBubbleClickClosesReminder() {
  console.log('\n[18] clicking the bubble closes the reminder');
  const { window, calls } = bootPet({
    petState: {
      state: 'REMINDER',
      count: 1,
      head: { title: '刘杰的生日', source: 'important_date', source_id: 12 },
    },
  });

  return new Promise((resolve) => setTimeout(() => {
    const bubble = window.document.getElementById('pet-bubble');
    bubble.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    setTimeout(() => {
      const done = calls.filter((c) => c.channel === 'complete_for_today');
      eq('the reminder was completed', done.length, 1);
      eq('with the right source and id',
        JSON.stringify(done[0] ? done[0].args : null),
        JSON.stringify(['important_date', 12]));
      resolve();
    }, 20);
  }, 20));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  console.log('pet drag regression tests');
  await testNormalDrag();
  await testLostMouseupDoesNotCorruptState();
  testBlurResetsGesture();
  testPointerCancelEndsGesture();
  await testMainProcessOwnsPosition();
  testClickStillWorks();
  await testResumeResetsGesture();
  testResumeAlwaysEndsDrag();
  testResumeIsNotAClick();
  await testGrabOffsetUsesLivePosition();
  await testGrabOffsetFallback();
  await testNewPointerIdAfterSleepRecovers();
  await testClickAfterSleepRecovers();
  testCaptureIsReleasedOnForcedTeardown();
  await testLostPointerCaptureEndsGesture();
  await testClickClosesReminder();
  await testClickWithoutReminderDoesNothing();
  await testBubbleClickClosesReminder();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  // Tear the jsdom windows down so their timers stop holding the event
  // loop open — otherwise this script never exits.
  for (const dom of bootedWindows) {
    try { dom.window.close(); } catch {}
  }
  if (failures.length) process.exit(1);
})();
