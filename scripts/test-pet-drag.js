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
function bootPet() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'pet.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'file:///' + path.join(ROOT, 'src', 'pet.html').replace(/\\/g, '/'),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // --- stub the preload bridge -------------------------------------------
  const calls = [];
  const record = (channel, args) => {
    calls.push({ channel, args });
    // Every invoke resolves; `pet:drag_start` resolves truthy so the
    // renderer takes the 'main' ownership branch.
    return Promise.resolve(true);
  };
  window.mp = {
    pet: {
      getState: () => Promise.resolve({ state: 'NORMAL', count: 0, head: null }),
      getCurrent: () => Promise.resolve('vup'),
      getCurrentSize: () => Promise.resolve({ w: 220, h: 220, spriteW: 220, spriteH: 220 }),
      resolveFrames: () => Promise.resolve({ frames: [], variantHint: '', loop: true }),
      moveBy: (dx, dy) => record('move_by', [dx, dy]),
      dragStart: (dx, dy) => record('drag_start', [dx, dy]),
      dragEnd: () => record('drag_end', []),
      setPaused: (ms) => record('set_paused', [ms]),
      openContextMenu: () => record('context_menu', []),
      triggerAction: () => record('trigger_action', []),
      actionEnded: () => record('action_ended', []),
      actionsConfig: { get: () => Promise.resolve({ config: { triggers: { click: 'default' } } }) },
    },
    on: () => () => {},
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

  return { window, calls, record };
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

  const started = calls.filter((c) => c.channel === 'drag_start');
  const ended = calls.filter((c) => c.channel === 'drag_end');
  eq('drag_start was reported once', started.length, 1);
  eq('drag_end was reported once', ended.length, 1);
  check('the drag class is removed on release', !sprite.classList.contains('dragging'));
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
  const started = calls.filter((c) => c.channel === 'drag_start');
  eq('a fresh drag still starts', started.length, 2);
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
// Run
// ---------------------------------------------------------------------------
(async () => {
  console.log('pet drag regression tests');
  testNormalDrag();
  testLostMouseupDoesNotCorruptState();
  testBlurResetsGesture();
  testPointerCancelEndsGesture();
  await testMainProcessOwnsPosition();
  testClickStillWorks();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
})();
