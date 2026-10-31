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
  const record = (channel, args, gesture, results) => {
    calls.push({ channel, args, gesture });
    // Every invoke resolves; `pet:drag_start` resolves truthy so the
    // renderer takes the 'main' ownership branch.
    //
    // `results` is a queue of answers for `pet:drag_start`: the main
    // process answers `false` when it refuses the id as a replay.
    if (results && results.length) return Promise.resolve(results.shift());
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
      // The gesture id travels with both drag messages — it is what lets
      // the main process recognise a message that belongs to a gesture it
      // has already finished.
      dragStart: (dx, dy, gestureId) => (opts.hangDragStart
        // A takeover whose reply never arrives — the main process froze
        // across a suspend and the answer was lost.
        ? new Promise(() => {})
        : record('drag_start', [dx, dy], gestureId, opts.dragStartResults)),
      dragEnd: (gestureId) => record('drag_end', [], gestureId),
      // The main process's gesture-id high-water mark. The renderer offsets
      // its own ids by it, so they stay unique across a reload.
      //
      // `opts.gestureBases` hands out a different mark on every call, which
      // is how a test models "the first fetch failed and the retry got the
      // real one".
      gestureBase: () => Promise.resolve(
        opts.gestureBases && opts.gestureBases.length
          ? opts.gestureBases.shift()
          : (opts.gestureBase || 0)),
      setPaused: (ms) => record('set_paused', [ms]),
      // The diagnostic log. The renderer writes the census of every
      // gesture here — how many moves each family produced — which is what
      // tells "the pointer pipeline died mid-gesture" apart from "the user
      // did not move the mouse".
      diag: (entry) => record('diag', [entry]),
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
//
// `x`/`y` are the CLIENT coordinates — the pointer's position inside the
// pet window. `sx`/`sy` are the SCREEN coordinates — its position on the
// desktop. They default to the same values, which is what a browser
// reports for a window parked at the desktop's origin.
//
// They are separate parameters because the two spaces can disagree after
// a system suspend: the OS may have moved the window while the machine
// was asleep, so the pointer's screen coordinates and the window's
// position no longer line up. A test that has to model that has to be
// able to say "the client coordinates are right and the screen ones are
// stale" — see test 9.
function pointer(win, type, { x, y, sx, sy, id = 1, button = 0 }) {
  const ev = new win.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  });
  Object.defineProperty(ev, 'pointerId', { value: id });
  Object.defineProperty(ev, 'screenX', { value: sx === undefined ? x : sx });
  Object.defineProperty(ev, 'screenY', { value: sy === undefined ? y : sy });
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

  check('the drag class is removed', !sprite.classList.contains('dragging'));

  // A stray move afterwards must not move the pet.
  const before = calls.filter((c) => c.channel === 'move_by').length;
  window.dispatchEvent(pointer(window, 'pointermove', { x: 500, y: 500 }));
  const after = calls.filter((c) => c.channel === 'move_by').length;
  eq('no stray move_by after the reset', after, before);

  // The end is deferred until the in-flight `drag_start` has gone out —
  // the main process must never see the end before the start.
  return new Promise((resolve) => setTimeout(() => {
    const ended = calls.filter((c) => c.channel === 'drag_end');
    eq('drag_end was reported', ended.length, 1);
    resolve();
  }, 20));
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

  check('the drag class is removed', !sprite.classList.contains('dragging'));

  // The end waits for the in-flight start, so it cannot overtake it.
  return new Promise((resolve) => setTimeout(() => {
    const ended = calls.filter((c) => c.channel === 'drag_end');
    eq('drag_end was reported', ended.length, 1);
    resolve();
  }, 20));
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
    const ended = calls.filter((c) => c.channel === 'drag_end');
    eq('drag_end was reported to the main process', ended.length, 1);
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
// Test 9 — the grab offset comes from the window-relative press.
//
// The main process places the window with `window = cursor - offset`, so
// the offset it needs is "where inside the window is the cursor" — the
// press's CLIENT coordinates, straight from the event.
//
// It used to be derived from the screen coordinates instead
// (`e.screenX - window.screenX`), which drags the window's position on
// the desktop into the measurement. After a system suspend the two can
// disagree — the OS may have moved the window while the machine was
// asleep — and the offset then describes a point that is not on the pet.
//
// So this test puts the window somewhere the screen coordinates do not
// describe, and asserts that the offset still describes the grab point.
// ---------------------------------------------------------------------------
function testGrabOffsetIsWindowRelative() {
  console.log('\n[9] the grab offset is the window-relative press');
  const { window, calls, setLivePos } = bootPet();
  const sprite = spriteOf(window);

  // The window really sits at (500, 400) on the desktop — but the
  // renderer's screen coordinates are stale and say the pointer is at
  // screen (600, 450), which would put the grab 100 px to the right of
  // where the window actually is.
  setLivePos(500, 400);

  // The press: 100 px right of and 50 px below the window's top-left.
  sprite.dispatchEvent(pointer(window, 'pointerdown', {
    x: 100, y: 50, sx: 600, sy: 450,
  }));
  window.dispatchEvent(pointer(window, 'pointermove', {
    x: 120, y: 70, sx: 620, sy: 470,
  }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started', started.length, 1);
    // The offset is the press's position inside the window — (100, 50).
    // It is NOT the position of the move that crossed the threshold
    // (120, 70) — see test 21 — and it does not depend on where the
    // window is on the desktop at all.
    eq('the offset is the grab point inside the window',
      JSON.stringify(started[0].args), JSON.stringify([100, 50]));
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 10 — the drag needs nothing from the main process to be measured.
//
// The offset used to be resolved through an IPC round-trip to the main
// process (to learn where the window is). That put a whole async hop —
// and a whole class of failure — between the press and the drag. The
// measurement is now local, so a main process that cannot answer still
// gets a working drag.
// ---------------------------------------------------------------------------
function testGrabOffsetNeedsNoMainProcessLookup() {
  console.log('\n[10] the grab offset needs no lookup on the main process');
  const { window, calls } = bootPet({ noGetPosition: true });
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started', started.length, 1);
    eq('the offset is the grab point inside the window',
      JSON.stringify(started[0].args), JSON.stringify([100, 100]));
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
  check('the drag class was removed', !sprite.classList.contains('dragging'));

  // And the pet must be draggable again.
  s.dispatchEvent(pointer(window, 'pointerdown', { x: 300, y: 300, id: 2 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 340, y: 350, id: 2 }));
  return new Promise((resolve) => setTimeout(() => {
    const ended = calls.filter((c) => c.channel === 'drag_end');
    eq('the stale gesture was ended', ended.length, 1);
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

  // And the pet is draggable again.
  s.dispatchEvent(pointer(window, 'pointerdown', { x: 200, y: 200, id: 10 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 240, y: 240, id: 10 }));
  return new Promise((resolve) => setTimeout(() => {
    const ended = calls.filter((c) => c.channel === 'drag_end');
    eq('drag_end was reported', ended.length, 1);
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
// Test 19 — THE REGRESSION: the drag end must never overtake the drag
// start.
//
// The renderer resolves the grab offset asynchronously (it asks the main
// process where the window is), so the `pet:drag_start` it sends can be
// overtaken by the `pet:drag_end` of the same gesture — a quick flick
// (press, move, release) is over before the reply comes back, and after a
// resume the main process can be slow to answer at all.
//
// The main process then ends up following the cursor with nothing left to
// stop it: the pet is glued to the pointer (it cannot be dragged
// anywhere) and the controller's drag mutex stays held, so the pet never
// walks on its own again. The right-click menu keeps working, because it
// does not go through the drag protocol at all — which is what made the
// symptom look so odd.
//
// This is the bug the user reported: the pet is draggable at startup and
// stops being draggable after the machine sleeps and wakes, because the
// first drag after the wake is the one that gets wedged.
// ---------------------------------------------------------------------------
function testDragEndNeverOvertakesDragStart() {
  console.log('\n[19] the drag end never overtakes the drag start');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  // Press, cross the 4 px threshold and release — all in one tick, so the
  // position lookup has not answered yet.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 120, y: 130 }));

  return new Promise((resolve) => setTimeout(() => {
    const order = calls
      .filter((c) => c.channel === 'drag_start' || c.channel === 'drag_end')
      .map((c) => c.channel);
    const startIdx = order.indexOf('drag_start');
    const endIdx = order.indexOf('drag_end');
    check('the drag started', startIdx >= 0);
    check('the drag ended', endIdx >= 0);
    check('the start was sent before the end',
      startIdx >= 0 && endIdx >= 0 && startIdx < endIdx,
      `order was ${JSON.stringify(order)}`);
    resolve();
  }, 30));
}

// ---------------------------------------------------------------------------
// Test 20 — every drag message carries the id of its gesture.
//
// The id is what lets the main process recognise a message that belongs to
// a gesture it has already finished — the safety net behind the ordering
// fix in test 19.
// ---------------------------------------------------------------------------
function testGestureIdTravelsWithTheDragMessages() {
  console.log('\n[20] every drag message carries its gesture id');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 120, y: 130 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    const ended = calls.filter((c) => c.channel === 'drag_end');
    check('the start carries a gesture id',
      started.length === 1 && typeof started[0].gesture === 'number' && started[0].gesture > 0);
    check('the end carries the same gesture id',
      ended.length === 1 && ended[0].gesture === started[0].gesture);

    // A second gesture gets a HIGHER id, so the main process can order
    // the messages it receives.
    sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 300, y: 300 }));
    window.dispatchEvent(pointer(window, 'pointermove', { x: 320, y: 330 }));
    window.dispatchEvent(pointer(window, 'pointerup', { x: 320, y: 330 }));
    setTimeout(() => {
      const started2 = calls.filter((c) => c.channel === 'drag_start');
      check('the next gesture gets a higher id',
        started2.length === 2 && started2[1].gesture > started2[0].gesture);
      resolve();
    }, 30);
  }, 30));
}

// ---------------------------------------------------------------------------
// Test 21 — THE REAL-WORLD REGRESSION: the grab offset is measured from the
// PRESS, not from the move that crossed the drag threshold.
//
// The main process positions the window with `window = cursor - offset`, so
// whatever the offset folds in is movement the pet refuses to make.
//
// The threshold is only 4 px, so normally the offset is a few pixels out and
// the pet merely lags a touch behind the cursor. After a resume it is not:
// the renderer is slow to hand over pointer events, so the first move it
// delivers already carries everything the mouse did while it was stalled.
// Measuring the offset from that move made the offset swallow the WHOLE
// movement, the pet stayed exactly where it was, and the drag looked dead.
//
// This is the bug the user reported: the pet is freely draggable at
// startup, and cannot be dragged at all after the machine sleeps and wakes.
// ---------------------------------------------------------------------------
function testGrabOffsetComesFromThePress() {
  console.log('\n[21] the grab offset is measured from the press');
  const { window, calls, setLivePos } = bootPet();
  const sprite = spriteOf(window);

  setLivePos(500, 400);

  // The press — where the user grabbed the pet, 100 px right of and 50 px
  // below the window's top-left.
  sprite.dispatchEvent(pointer(window, 'pointerdown', {
    x: 100, y: 50, sx: 600, sy: 450,
  }));
  // The renderer was stalled across the sleep. The first move it delivers
  // arrives with everything the mouse did while it was stalled: 200 px
  // away, in one go.
  window.dispatchEvent(pointer(window, 'pointermove', {
    x: 300, y: 250, sx: 800, sy: 650,
  }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started', started.length, 1);
    // The offset has to describe where the pet was GRABBED, so the stalled
    // movement is still movement the pet makes: (100, 50).
    eq('the offset describes the grab point, not the stalled position',
      JSON.stringify(started[0].args), JSON.stringify([100, 50]));
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 22 — a grab point outside the pet window is rejected.
//
// A measurement that does not describe a point inside the window means the
// measurement and the window disagree about where they are. Dragging with
// such an offset would fling the pet across the screen, so the pet is
// grabbed by its centre instead.
// ---------------------------------------------------------------------------
function testOffsetOutsideTheWindowIsRejected() {
  console.log('\n[22] a grab point outside the window is rejected');
  const { window, calls, setLivePos } = bootPet();
  const sprite = spriteOf(window);

  setLivePos(0, 0);
  // A grab point that cannot be inside the window.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 5000, y: 4000 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 5020, y: 4020 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started', started.length, 1);
    const [dx, dy] = started[0].args;
    check('the offset points inside the pet window',
      dx >= 0 && dx <= window.innerWidth && dy >= 0 && dy <= window.innerHeight,
      `offset = [${dx}, ${dy}], window = ${window.innerWidth}x${window.innerHeight}`);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 23 — the drag threshold is measured in the window's coordinates.
//
// The threshold only has to answer "has the pointer moved far enough to
// count as a drag?". It is measured in the window's own coordinates so
// that a stale screen coordinate cannot stall the drag: after a system
// suspend the renderer may deliver pointer events whose screen
// coordinates no longer track the pointer, and a threshold measured
// there would never be crossed — the pet would simply not be draggable.
// ---------------------------------------------------------------------------
function testThresholdIgnoresStaleScreenCoordinates() {
  console.log('\n[23] the drag threshold does not depend on the screen coordinates');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  // The press. The screen coordinates are stale from here on — they stay
  // exactly where the press was, whatever the pointer does.
  sprite.dispatchEvent(pointer(window, 'pointerdown', {
    x: 100, y: 100, sx: 600, sy: 450,
  }));
  // The pointer moves 40 px inside the window. The screen coordinates say
  // it did not move at all.
  window.dispatchEvent(pointer(window, 'pointermove', {
    x: 140, y: 130, sx: 600, sy: 450,
  }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started even though the screen coordinates did not move', started.length, 1);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 24 — a takeover that is never answered falls back to the renderer.
//
// `pet:drag_start` is a round-trip to the main process. If the reply is
// lost — the main process can be frozen across a system suspend — the
// renderer must not wait for it forever: it does not own the window
// position while the takeover is pending, so the pet would not move at
// all. After the timeout the renderer drives the window itself.
// ---------------------------------------------------------------------------
function testLostTakeoverFallsBackToTheRenderer() {
  console.log('\n[24] a takeover that is never answered falls back to the renderer');
  const { window, calls } = bootPet({ hangDragStart: true });
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));

  // The takeover timeout is 400 ms; wait past it and then move again.
  return new Promise((resolve) => setTimeout(() => {
    window.dispatchEvent(pointer(window, 'pointermove', { x: 140, y: 160 }));
    setTimeout(() => {
      const moved = calls.filter((c) => c.channel === 'move_by');
      check('the renderer moved the window itself', moved.length > 0,
        `move_by calls = ${moved.length}`);
      resolve();
    }, 20);
  }, 500));
}

// ---------------------------------------------------------------------------
// Test 25 — the press and the move can come from DIFFERENT pointer devices.
//
// This is the wedge the old code created. A system suspend tears the
// pointer device down and the OS brings it back as a new one, so the press
// carries the OLD id and the first move carries the NEW one.
//
// The old code tore the gesture down on the first foreign event, so the
// press was always killed by the move that followed it — the pet could not
// be dragged at all, which is exactly what the user reported.
//
// The gesture now follows the pointer that is actually moving, as long as
// the pet has not started moving yet.
// ---------------------------------------------------------------------------
function testForeignPointerBeforeTheThresholdRebinds() {
  console.log('\n[25] a foreign pointer before the threshold rebinds the gesture');
  const { window, calls, capture } = bootPet();
  const sprite = spriteOf(window);

  // The press, on the pre-sleep mouse.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100, id: 1 }));
  eq('the pre-sleep pointer is captured', capture.has(1), true);

  // The machine sleeps. On wake the mouse is a NEW device with id 2, and
  // the very first move already carries it. The gesture has not crossed the
  // threshold yet, so it has to rebind instead of tearing down.
  window.dispatchEvent(pointer(window, 'pointermove', { x: 140, y: 160, id: 2 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started on the new pointer', started.length, 1);
    eq('the grab offset is still the press point',
      JSON.stringify(started[0] && started[0].args), JSON.stringify([100, 100]));
    check('the sprite is being dragged', sprite.classList.contains('dragging'));
    eq('the dead pointer is no longer captured', capture.has(1), false);
    eq('the new pointer is captured', capture.has(2), true);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 26 — the local fallback measures the movement in the window's own
// coordinates.
//
// The fallback runs when the main process refuses the takeover or never
// answers it. The window then does NOT follow the pointer, so the pointer's
// movement inside the window IS its movement on the screen.
//
// The screen coordinates cannot be used for it: after a system suspend
// they can be stale, and a stale delta moves the pet by nothing at all —
// which is the very symptom being chased.
// ---------------------------------------------------------------------------
function testLocalFallbackIgnoresStaleScreenCoordinates() {
  console.log('\n[26] the local fallback does not depend on the screen coordinates');
  const { window, calls } = bootPet({ hangDragStart: true });
  const sprite = spriteOf(window);

  // The press. The screen coordinates are stale from here on.
  sprite.dispatchEvent(pointer(window, 'pointerdown', {
    x: 100, y: 100, sx: 600, sy: 450,
  }));
  window.dispatchEvent(pointer(window, 'pointermove', {
    x: 140, y: 160, sx: 600, sy: 450,
  }));

  // The takeover timeout is 400 ms; wait past it, then move again.
  return new Promise((resolve) => setTimeout(() => {
    window.dispatchEvent(pointer(window, 'pointermove', {
      x: 180, y: 220, sx: 600, sy: 450,
    }));
    setTimeout(() => {
      const moved = calls.filter((c) => c.channel === 'move_by');
      eq('the window was moved once', moved.length, 1);
      // The delta is measured from the press: 180-100, 220-100.
      eq('the delta is the movement inside the window',
        JSON.stringify(moved[0] && moved[0].args), JSON.stringify([80, 120]));
      resolve();
    }, 20);
  }, 500));
}

// ---------------------------------------------------------------------------
// Test 27 — THE REAL-WORLD REGRESSION: after a system suspend the POINTER
// events can stop arriving altogether, while the MOUSE events keep coming.
//
// The symptom the user reported is exactly this: the pet cannot be dragged
// (the drag was built on pointer events) but the right-click menu still
// works (a `contextmenu` DOM event — a mouse event) and a click still plays
// the pet's action (a `click` DOM event — also a mouse event).
//
// Chromium's pointer events are built from the raw input by a factory that
// needs a REGISTERED pointer device; the legacy mouse events are built
// straight from the raw mouse input and need no device. A suspend tears the
// pointer device down and the OS brings it back as a new one, and the
// device registry can end up not knowing about it — so the raw input
// produces mouse events but no pointer events.
//
// So the drag has to work on the mouse events too. This test drives the
// gesture with NOTHING but mouse events — exactly what the renderer would
// see in that state.
// ---------------------------------------------------------------------------
function testMouseEventsCanDriveTheDrag() {
  console.log('\n[27] a drag driven by mouse events alone works');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  // No pointer event at all — this is the state after the suspend.
  sprite.dispatchEvent(pointer(window, 'mousedown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'mousemove', { x: 120, y: 130 }));
  window.dispatchEvent(pointer(window, 'mouseup', { x: 120, y: 130 }));

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
// Test 28 — the two families never fight over the same press.
//
// In a healthy browser the pointer events always win: `pointerdown` is
// dispatched before the compatibility mouse events, and the sprite's
// `pointerdown` handler calls `preventDefault()`, which suppresses the
// compatibility `mousedown` altogether. A `mousedown` that arrives while a
// gesture is live must therefore be ignored — not start a second gesture.
// ---------------------------------------------------------------------------
function testMouseDownDoesNotStartASecondGesture() {
  console.log('\n[28] a mousedown during a live gesture does not start a second one');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  // The compatibility mouse event of the SAME physical press.
  sprite.dispatchEvent(pointer(window, 'mousedown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 120, y: 130 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 120, y: 130 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('drag_start was reported once', started.length, 1);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 29 — a mouse gesture that loses its release must not stay open.
//
// The legacy mouse events have no pointer capture, so a `mouseup` that
// happens outside the window is never delivered. Without a safety net the
// gesture would stay open forever: `pressing` would remain true, the next
// press would be swallowed by that guard, and the pet could never be
// dragged again — the very symptom this whole fallback exists to cure.
//
// The cursor leaving the window is the signal that the release was lost.
// ---------------------------------------------------------------------------
function testMouseGestureClosesWhenTheCursorLeavesTheWindow() {
  console.log('\n[29] a mouse gesture closes when the cursor leaves the window');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'mousedown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'mouseleave', { x: 400, y: 400 }));

  return new Promise((resolve) => setTimeout(() => {
    const ended = calls.filter((c) => c.channel === 'drag_end');
    check('the gesture was closed', ended.length >= 1,
      `drag_end count = ${ended.length}`);

    // The real point: the NEXT press must still work.
    sprite.dispatchEvent(pointer(window, 'mousedown', { x: 100, y: 100 }));
    window.dispatchEvent(pointer(window, 'mousemove', { x: 140, y: 160 }));
    window.dispatchEvent(pointer(window, 'mouseup', { x: 140, y: 160 }));

    setTimeout(() => {
      const started = calls.filter((c) => c.channel === 'drag_start');
      check('the next press still starts a drag', started.length >= 1,
        `drag_start count = ${started.length}`);
      resolve();
    }, 20);
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 30 — a `mouseout` inside the window must NOT end the gesture.
//
// The `mouseout` listener is the safety net for a lost release, but it must
// not be over-eager: the pointer moving from the sprite to another element
// of the same window produces a `mouseout` with a `relatedTarget`, and that
// is not the pointer leaving. Ending the gesture there would break every
// ordinary drag.
// ---------------------------------------------------------------------------
function testMouseOutInsideTheWindowKeepsTheGesture() {
  console.log('\n[30] a mouseout inside the window keeps the gesture alive');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'mousedown', { x: 100, y: 100 }));

  // The pointer moved to another element of the same window.
  const out = pointer(window, 'mouseout', { x: 100, y: 100 });
  Object.defineProperty(out, 'relatedTarget', { value: window.document.body });
  sprite.dispatchEvent(out);

  window.dispatchEvent(pointer(window, 'mousemove', { x: 140, y: 160 }));
  window.dispatchEvent(pointer(window, 'mouseup', { x: 140, y: 160 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('drag_start was reported once', started.length, 1);
    const ended = calls.filter((c) => c.channel === 'drag_end');
    eq('drag_end was reported once', ended.length, 1);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 31 — a press on the transparent margin around the pet still drags.
//
// The pet sprite is 165 px wide inside a 216 px window, and the artwork
// inside it is narrower still. A press that landed anywhere near the
// visible pet but outside the sprite's box used to do NOTHING AT ALL —
// no gesture, no drag, no feedback.
//
// The real machine's diagnostic log caught exactly that: a `pointerdown`
// at clientX 210, where the sprite ends at 190, hitting `BODY` and
// producing a grab that silently went nowhere.
//
// The whole window is the drag target now.
// ---------------------------------------------------------------------------
function testPressOutsideTheSpriteStillDrags() {
  console.log('\n[31] a press on the transparent margin still drags the pet');
  const { window, calls } = bootPet();
  const body = window.document.body;

  // The press lands on the BODY, not on the sprite — exactly what the
  // diagnostic log recorded after the wake.
  body.dispatchEvent(pointer(window, 'pointerdown', { x: 210, y: 261 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 240, y: 280 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 240, y: 280 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('drag_start was reported once', started.length, 1);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 32 — a press on the reminder bubble does not start a drag.
//
// The bubble is the one place the user has to be able to CLICK: clicking
// it closes the reminder. Now that the whole window drags, it has to be
// excluded explicitly, or a click on the bubble would start a drag and
// swallow the click.
// ---------------------------------------------------------------------------
function testPressOnTheBubbleDoesNotStartADrag() {
  console.log('\n[32] a press on the reminder bubble does not start a drag');
  const { window, calls } = bootPet();
  const bubble = window.document.getElementById('pet-bubble');
  bubble.classList.remove('hidden');

  bubble.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 40 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 140, y: 60 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 140, y: 60 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('no drag was started', started.length, 0);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 33 — a stale pointer gesture must not block the mouse fallback.
//
// The scenario: the pointer device dies across a suspend. The press that
// came before the sleep started a pointer gesture whose `pointerup` never
// arrived, so the gesture is still open. The pointer events are now dead,
// so the user's next press arrives as a MOUSE event — and if that press
// were swallowed, the pet could never be dragged again for the rest of
// the session.
//
// The mouse press takes over: the stale pointer gesture is torn down and
// the mouse gesture drives the drag.
// ---------------------------------------------------------------------------
function testStalePointerGestureDoesNotBlockTheMouseFallback() {
  console.log('\n[33] a stale pointer gesture does not block the mouse fallback');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  // A pointer press whose release never arrives (the device died).
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));

  // The user's next press — a mouse event, somewhere else, later.
  window.dispatchEvent(pointer(window, 'mousedown', { x: 160, y: 170 }));
  window.dispatchEvent(pointer(window, 'mousemove', { x: 190, y: 200 }));
  window.dispatchEvent(pointer(window, 'mouseup', { x: 190, y: 200 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the mouse gesture took over', started.length, 1);
    const ended = calls.filter((c) => c.channel === 'drag_end');
    check('the stale pointer gesture was torn down', ended.length >= 1,
      `drag_end count = ${ended.length}`);
    resolve();
  }, 20));
}

// ---------------------------------------------------------------------------
// Test 34 — a refused gesture id is retried with a fresh base.
//
// The main process refuses a start whose id it has already seen. When the
// renderer hands out an id below the main process's high-water mark — the
// base fetch failed, or the renderer reloaded — every drag is refused.
//
// Dropping to the window-local fallback instead looks exactly like "the
// pet cannot be dragged": the local fallback can only move the pet inside
// its own 216 px window. So the renderer re-reads the base and tries
// again.
// ---------------------------------------------------------------------------
function testRefusedGestureIdIsRetried() {
  console.log('\n[34] a refused gesture id is retried with a fresh base');
  const bases = [0, 5];
  const results = [false, true];
  const { window, calls } = bootPet({
    gestureBases: bases,
    dragStartResults: results,
  });
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 130, y: 150 }));

  // The button is still held: the retry only makes sense while the
  // gesture is alive — a gesture that has already ended needs no start.
  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the start was sent twice', started.length, 2);
    if (started.length === 2) {
      const first = started[0].gesture;
      const second = started[1].gesture;
      check('the retry used a higher id', second > first,
        `first id ${first}, second id ${second}`);
      window.dispatchEvent(pointer(window, 'pointerup', { x: 130, y: 150 }));
      setTimeout(() => {
        const ended = calls.filter((c) => c.channel === 'drag_end');
        const lastEnd = ended[ended.length - 1];
        check('the end names the id the main process accepted',
          lastEnd && lastEnd.gesture === second,
          `end id ${lastEnd && lastEnd.gesture}, accepted id ${second}`);
        resolve();
      }, 20);
    } else {
      resolve();
    }
  }, 40));
}

// ---------------------------------------------------------------------------
// Test 35 — the mouse family takes over a gesture whose pointer moves
// never arrive.
//
// THE CASE
// --------
// After a system suspend the pointer pipeline can die in the MIDDLE of a
// gesture: the press arrives as a pointer event (the device was alive at
// that moment), and the movement arrives as mouse events (the device is
// gone by then).
//
// The family gate used to throw that movement away — the gesture was owned
// by the pointer family, so every mouse move was ignored. The result was
// the worst kind of failure: the press was registered, the release was
// registered, and the pet never moved. From the outside that is
// indistinguishable from "the user did not drag".
//
// The handover fixes it, and it is safe because it only happens while the
// pet has not started moving: the grab point is the same either way, so
// switching cannot make the pet jump.
// ---------------------------------------------------------------------------
function testMouseFamilyTakesOverAPointerPress() {
  console.log('\n[35] the mouse family takes over a pointer press whose moves never arrive');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  // The press — the pointer device was still alive.
  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));

  // The movement — but the pointer device is gone, so it comes as mouse
  // events.
  window.dispatchEvent(pointer(window, 'mousemove', { x: 160, y: 170 }));

  return new Promise((resolve) => setTimeout(() => {
    const started = calls.filter((c) => c.channel === 'drag_start');
    eq('the drag started anyway', started.length, 1);
    const switches = calls.filter((c) => c.channel === 'diag'
      && c.args[0] && c.args[0].kind === 'family_switch');
    eq('the handover was recorded', switches.length, 1);
    if (switches.length) {
      eq('it handed over from the pointer family', switches[0].args[0].from, 'pointer');
      eq('it handed over to the mouse family', switches[0].args[0].to, 'mouse');
    }
    window.dispatchEvent(pointer(window, 'pointerup', { x: 160, y: 170 }));
    setTimeout(() => {
      const ended = calls.filter((c) => c.channel === 'drag_end');
      check('the gesture was closed', ended.length >= 1, `drag_end count = ${ended.length}`);
      resolve();
    }, 20);
  }, 40));
}

// ---------------------------------------------------------------------------
// Test 36 — the compatibility mouse echo does not steal the gesture.
//
// A browser that dispatches both families synthesises a `mousemove` next to
// every `pointermove`: the same position, in the same task. If the
// handover treated that echo as a genuine mouse move, it would take the
// gesture away from the pointer family in a perfectly healthy browser —
// and the gesture would end up being driven by the family that has no
// pointer capture, so a release outside the window would be lost.
//
// The echo is recognised by its position and its moment, exactly like the
// compatibility `mousedown` is.
// ---------------------------------------------------------------------------
function testCompatMouseEchoDoesNotStealTheGesture() {
  console.log('\n[36] the compatibility mouse echo does not steal the gesture');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  // The pointer move crosses the threshold — the pointer family owns the
  // gesture from here.
  window.dispatchEvent(pointer(window, 'pointermove', { x: 130, y: 150 }));
  // The browser's echo of that very move: same position, same moment.
  window.dispatchEvent(pointer(window, 'mousemove', { x: 130, y: 150 }));

  return new Promise((resolve) => setTimeout(() => {
    const switches = calls.filter((c) => c.channel === 'diag'
      && c.args[0] && c.args[0].kind === 'family_switch');
    eq('the gesture was not handed over', switches.length, 0);
    window.dispatchEvent(pointer(window, 'pointerup', { x: 130, y: 150 }));
    setTimeout(() => {
      const ends = calls.filter((c) => c.channel === 'diag'
        && c.args[0] && c.args[0].kind === 'drag_end');
      const last = ends[ends.length - 1];
      check('the gesture ended in the pointer family',
        last && last.args[0].family === 'pointer',
        last && last.args[0].family ? `family ${last.args[0].family}` : 'no drag_end record');
      resolve();
    }, 20);
  }, 40));
}

// ---------------------------------------------------------------------------
// Test 37 — the census: how many moves each family produced.
//
// The log has to be able to answer "did the moves arrive at all, and which
// family carried them?". Without the census the losing family was
// invisible, and the two failures that look identical from the outside
// ("the pointer pipeline died" and "the user did not move the mouse")
// could not be told apart.
// ---------------------------------------------------------------------------
function testTheCensusCountsBothFamilies() {
  console.log('\n[37] the census counts the moves of both families');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 130, y: 150 }));
  window.dispatchEvent(pointer(window, 'pointermove', { x: 140, y: 160 }));
  window.dispatchEvent(pointer(window, 'pointerup', { x: 140, y: 160 }));

  return new Promise((resolve) => setTimeout(() => {
    const ends = calls.filter((c) => c.channel === 'diag'
      && c.args[0] && c.args[0].kind === 'drag_end');
    const last = ends[ends.length - 1];
    check('the gesture was recorded', !!last);
    if (last) {
      eq('the pointer family delivered both moves', last.args[0].pointerMoves, 2);
      eq('the mouse family delivered none', last.args[0].mouseMoves, 0);
    }
    resolve();
  }, 30));
}

// ---------------------------------------------------------------------------
// Test 38 — the pet does not walk away while it is being grabbed.
//
// The autonomous walk used to be paused only once the drag had actually
// started. Between the press and the threshold the walk carried on, so the
// pet could slide out from under the cursor — the user's moves then landed
// on the desktop, and the pet looked like it could not be dragged.
//
// The walk is now paused on the press.
// ---------------------------------------------------------------------------
function testTheWalkIsPausedOnThePress() {
  console.log('\n[38] the pet stops walking while it is being grabbed');
  const { window, calls } = bootPet();
  const sprite = spriteOf(window);

  sprite.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 100 }));

  const paused = calls.filter((c) => c.channel === 'set_paused');
  check('the pet was paused on the press', paused.length >= 1,
    `set_paused count = ${paused.length}`);
  // The drag itself has not started yet — no movement has happened.
  const started = calls.filter((c) => c.channel === 'drag_start');
  eq('no drag was started', started.length, 0);
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
  await testGrabOffsetIsWindowRelative();
  await testGrabOffsetNeedsNoMainProcessLookup();
  await testNewPointerIdAfterSleepRecovers();
  await testClickAfterSleepRecovers();
  testCaptureIsReleasedOnForcedTeardown();
  await testLostPointerCaptureEndsGesture();
  await testClickClosesReminder();
  await testClickWithoutReminderDoesNothing();
  await testBubbleClickClosesReminder();
  await testDragEndNeverOvertakesDragStart();
  await testGestureIdTravelsWithTheDragMessages();
  await testGrabOffsetComesFromThePress();
  await testOffsetOutsideTheWindowIsRejected();
  await testThresholdIgnoresStaleScreenCoordinates();
  await testLostTakeoverFallsBackToTheRenderer();
  await testForeignPointerBeforeTheThresholdRebinds();
  await testLocalFallbackIgnoresStaleScreenCoordinates();
  await testMouseEventsCanDriveTheDrag();
  await testMouseDownDoesNotStartASecondGesture();
  await testMouseGestureClosesWhenTheCursorLeavesTheWindow();
  await testMouseOutInsideTheWindowKeepsTheGesture();
  await testPressOutsideTheSpriteStillDrags();
  await testPressOnTheBubbleDoesNotStartADrag();
  await testMouseFamilyTakesOverAPointerPress();
  await testCompatMouseEchoDoesNotStealTheGesture();
  await testTheCensusCountsBothFamilies();
  testTheWalkIsPausedOnThePress();
  await testStalePointerGestureDoesNotBlockTheMouseFallback();
  await testRefusedGestureIdIsRetried();

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
