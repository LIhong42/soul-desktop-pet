// scripts/test-pet-drag-order.js — integration test for the pet drag
// protocol.
//
// THE BUG
// --------
// The pet drag is a two-party protocol: the renderer owns the gesture, the
// main process owns the window position. The renderer resolves the grab
// offset asynchronously (`pet:get_position`) before it can send
// `pet:drag_start` — so the start is issued from a promise callback, while
// `pet:drag_end` is sent synchronously from the pointerup handler.
//
// Whenever the main process is slow to answer, the end overtakes the start.
// The main process then processed them in that order and ended up with
// `petDrag.active === true` and the controller's drag mutex held: the pet
// was glued to the mouse cursor (it could not be picked up anywhere) and
// `PetController.tick()` returned early forever, so the pet never walked on
// its own again. The right-click menu kept working because it never goes
// through the drag protocol.
//
// A machine that just woke up from sleep is exactly the "slow main process"
// case: the IPC round-trip balloons, and the very first drag after the wake
// hits the race.
//
// THE FIX
// -------
//   * The renderer always sends the start, and defers the end onto the
//     start's promise, so the two can never be inverted.
//   * Both messages carry a monotonically increasing gesture id, so the
//     main process can recognise a message belonging to a gesture it has
//     already finished.
//
// This test wires the REAL renderer (src/js/pet.js under jsdom) to the REAL
// main-process handlers (main/ipc.js under a stubbed `electron`), with an
// artificially slow position lookup — so it exercises both halves of the
// protocol together instead of mocking one of them away.
//
// Usage: node scripts/test-pet-drag-order.js

const fs = require('fs');
const path = require('path');
const Module = require('module');
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
// Stub the `electron` module BEFORE main/ipc.js requires it.
// ---------------------------------------------------------------------------
const calls = {
  setPosition: [],
  dragging: [],
  paused: [],
  send: [],
};

let cursor = { x: 500, y: 400 };
let windowPos = [100, 200];
// How long the main process takes to answer the position lookup. A slow
// answer is what a machine that just woke up from sleep looks like.
let lookupDelayMs = 0;

const fakeWindow = {
  isDestroyed: () => false,
  getPosition: () => windowPos,
  getBounds: () => ({ x: windowPos[0], y: windowPos[1], width: 220, height: 220 }),
  setPosition: (x, y) => { calls.setPosition.push([x, y]); windowPos = [x, y]; },
  isVisible: () => true,
  show: () => {},
  setIgnoreMouseEvents: () => {},
  webContents: { send: (...a) => calls.send.push(a) },
  on: () => {},
  focus: () => {},
  executeJavaScript: () => Promise.resolve(),
};

const powerMonitor = {
  _listeners: new Map(),
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  },
  removeListener() { return this; },
  getSystemIdleTime: () => 0,
  emit(event) {
    for (const fn of (this._listeners.get(event) || []).slice()) fn();
  },
};

const electronStub = {
  ipcMain: {
    _handlers: new Map(),
    handle(channel, fn) { this._handlers.set(channel, fn); },
    removeHandler(channel) { this._handlers.delete(channel); },
  },
  app: {
    // 'appData' stays inside the repo so a test run cannot touch the real
    // user data; 'userData' (where the diagnostics log lives) goes to the
    // OS temp directory, so a test run leaves no file behind in the
    // repository.
    getPath: (name) => (name === 'userData'
      ? path.join(require('os').tmpdir(), 'soul-desktop-pet-test')
      : ROOT),
    isPackaged: false,
    on: () => {},
    getName: () => 'SoulDesktopPet',
    getVersion: () => '0.1.0',
    getLocale: () => 'zh-CN',
    whenReady: () => Promise.resolve(),
    quit: () => {},
    relaunch: () => {},
    exit: () => {},
  },
  screen: {
    getCursorScreenPoint: () => ({ x: cursor.x, y: cursor.y }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  dialog: {},
  shell: {},
  powerMonitor,
  BrowserWindow: class {},
};

// Patch the module loader so `require('electron')` returns our stub.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: electronStub,
};

// ---------------------------------------------------------------------------
// Load the real main-process handlers
// ---------------------------------------------------------------------------
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

const petController = {
  clamped: 0,
  setPaused: (ms) => { calls.paused.push(ms); },
  setDragging: (on) => { calls.dragging.push(on); },
  clampIntoView: () => { petController.clamped++; },
};

ipc.register({
  queue: { on: () => {}, activeCount: () => 0, activeHead: () => null },
  winMain: fakeWindow,
  winPet: fakeWindow,
  setPetState: () => {},
  getPetState: () => false,
  setActiveReminder: () => {},
  broadcastPetState: () => {},
  petController,
  petRegistry: null,
});

const handlers = electronStub.ipcMain._handlers;

// ---------------------------------------------------------------------------
// Boot the real renderer and bridge it to the real handlers.
// ---------------------------------------------------------------------------
const bootedWindows = [];

function bootPet() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'pet.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'file:///' + path.join(ROOT, 'src', 'pet.html').replace(/\\/g, '/'),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  bootedWindows.push(dom);

  // Every message the renderer sends, in the order it sends it.
  const wire = [];

  window.mp = {
    pet: {
      getState: () => Promise.resolve({ state: 'NORMAL', count: 0, head: null }),
      getCurrent: () => Promise.resolve('vup'),
      getCurrentSize: () => Promise.resolve({ w: 220, h: 220, spriteW: 220, spriteH: 220 }),
      resolveFrames: () => Promise.resolve({ frames: [], variantHint: '', loop: true }),
      getPosition: () => new Promise((res) => {
        setTimeout(() => res({ x: windowPos[0], y: windowPos[1] }), lookupDelayMs);
      }),
      moveBy: (dx, dy) => { wire.push('move_by'); return handlers.get('pet:move_by')(null, dx, dy); },
      dragStart: (dx, dy, gestureId) => {
        wire.push(`drag_start:${gestureId}`);
        return handlers.get('pet:drag_start')(null, dx, dy, gestureId);
      },
      dragEnd: (gestureId) => {
        wire.push(`drag_end:${gestureId}`);
        return handlers.get('pet:drag_end')(null, gestureId);
      },
      gestureBase: () => handlers.get('pet:gesture_base')(null),
      setPaused: (ms) => { wire.push('set_paused'); return handlers.get('pet:set_paused')(null, ms); },
      openContextMenu: () => Promise.resolve(true),
      triggerAction: () => Promise.resolve(true),
      actionEnded: () => Promise.resolve(true),
      actionsConfig: { get: () => Promise.resolve({ config: { triggers: { click: 'default' } } }) },
    },
    on: () => () => {},
    reminders: { completeForToday: () => Promise.resolve(true) },
    app: { quit: () => {} },
  };

  Object.defineProperty(window, 'screenX', { value: 0, writable: true, configurable: true });
  Object.defineProperty(window, 'screenY', { value: 0, writable: true, configurable: true });
  Object.defineProperty(window, 'screen', { value: { X: 0, Y: 0, width: 1920, height: 1080 }, writable: true, configurable: true });

  const sprite = window.document.getElementById('pet-sprite');
  sprite.setPointerCapture = () => {};
  sprite.releasePointerCapture = () => {};
  sprite.hasPointerCapture = () => false;

  window.eval(fs.readFileSync(path.join(ROOT, 'src', 'js', 'pet.js'), 'utf8'));

  return { window, sprite, wire };
}

function pointer(window, type, { x, y, id = 1, button = 0 }) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(ev, 'pointerId', { value: id });
  Object.defineProperty(ev, 'screenX', { value: x });
  Object.defineProperty(ev, 'screenY', { value: y });
  return ev;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
(async () => {

// ---------------------------------------------------------------------------
// Test 1 — THE REGRESSION: a flick on a slow main process must not leave
// the pet glued to the cursor.
//
// The renderer releases the pet before the main process has answered the
// grab-offset lookup, so the end would overtake the start. The main process
// must end up idle, not following the cursor forever.
// ---------------------------------------------------------------------------
console.log('\n[1] a flick on a slow main process leaves the pet draggable');
lookupDelayMs = 120;   // the machine just woke up from sleep
calls.dragging.length = 0;
calls.setPosition.length = 0;

const flick = bootPet();

// The user grabs the pet and flicks it: press, move, release.
flick.sprite.dispatchEvent(pointer(flick.window, 'pointerdown', { x: 100, y: 100 }));
flick.window.dispatchEvent(pointer(flick.window, 'pointermove', { x: 260, y: 180 }));
flick.window.dispatchEvent(pointer(flick.window, 'pointerup', { x: 260, y: 180 }));
await sleep(400);

const dragMessages = flick.wire.filter((m) => m.startsWith('drag_'));
const startIdx = flick.wire.findIndex((m) => m.startsWith('drag_start'));
const endIdx = flick.wire.findIndex((m) => m.startsWith('drag_end'));

console.log(`     the renderer sent: ${dragMessages.join('  →  ')}`);
check('the drag start was sent before the drag end',
  startIdx >= 0 && endIdx >= 0 && startIdx < endIdx,
  `start index ${startIdx}, end index ${endIdx}`);

// If the main process were still following the cursor, moving the mouse
// would drag the pet along.
const beforeMove = calls.setPosition.length;
cursor = { x: 1200, y: 900 };
await sleep(200);
eq('the pet is NOT glued to the cursor', calls.setPosition.length - beforeMove, 0);
check('the controller drag mutex was released',
  calls.dragging[calls.dragging.length - 1] === false,
  `the last setDragging call was ${JSON.stringify(calls.dragging[calls.dragging.length - 1])}`);

// ---------------------------------------------------------------------------
// Test 2 — the same flick must still MOVE the pet.
//
// The fix defers the end, but the start is always sent — otherwise a quick
// flick would not move the pet at all.
// ---------------------------------------------------------------------------
console.log('\n[2] the flick still moves the pet');
const movedBy = calls.setPosition.length;
check('the pet was repositioned during the flick', movedBy > 0,
  `setPosition was called ${movedBy} times`);

// ---------------------------------------------------------------------------
// Test 3 — a drag that is still in flight still works.
//
// The slow main process must not prevent the pet from following the cursor
// while the button is held.
// ---------------------------------------------------------------------------
console.log('\n[3] a held drag still follows the cursor');
calls.dragging.length = 0;
calls.setPosition.length = 0;

const held = bootPet();
held.sprite.dispatchEvent(pointer(held.window, 'pointerdown', { x: 100, y: 100 }));
held.window.dispatchEvent(pointer(held.window, 'pointermove', { x: 300, y: 200 }));
// Let the lookup resolve and the start reach the main process.
await sleep(300);

cursor = { x: 700, y: 600 };
await sleep(120);
check('the pet followed the cursor', calls.setPosition.length > 0,
  `setPosition was called ${calls.setPosition.length} times`);
check('the controller drag mutex was taken',
  calls.dragging[calls.dragging.length - 1] === true);

held.window.dispatchEvent(pointer(held.window, 'pointerup', { x: 300, y: 200 }));
await sleep(300);
const afterEnd = calls.setPosition.length;
await sleep(120);
eq('the poller stopped after the release', calls.setPosition.length, afterEnd);
check('the controller drag mutex was released',
  calls.dragging[calls.dragging.length - 1] === false);

// ---------------------------------------------------------------------------
// Test 4 — a RELOADED renderer still gets working drags.
//
// The main process keeps a high-water mark of the gesture ids it has seen
// and refuses a start whose id it has already seen. The renderer counts its
// gestures from 1, so a fresh renderer has to be handed the main process's
// current mark — otherwise its first drag would be refused as a replay and
// the pet would be undraggable until the app was restarted.
//
// Booting a second renderer here simulates that reload: it starts its own
// count at 1, so its gesture id only stays unique if the base was handed
// over.
// ---------------------------------------------------------------------------
console.log('\n[4] a reloaded renderer still gets working drags');
calls.dragging.length = 0;
calls.setPosition.length = 0;

const firstGestureId = Number(flick.wire.find((m) => m.startsWith('drag_start')).split(':')[1]);

const second = bootPet();
second.sprite.dispatchEvent(pointer(second.window, 'pointerdown', { x: 100, y: 100 }));
second.window.dispatchEvent(pointer(second.window, 'pointermove', { x: 260, y: 180 }));
second.window.dispatchEvent(pointer(second.window, 'pointerup', { x: 260, y: 180 }));
await sleep(400);

const secondStart = second.wire.find((m) => m.startsWith('drag_start'));
const secondEnd = second.wire.find((m) => m.startsWith('drag_end'));
check('the second gesture was started', !!secondStart, `messages: ${second.wire.join(', ')}`);
check('the second gesture was ended', !!secondEnd);
if (secondStart && secondEnd) {
  const gStart = Number(secondStart.split(':')[1]);
  const gEnd = Number(secondEnd.split(':')[1]);
  check('the second gesture carries a gesture id', Number.isFinite(gStart) && gStart > 0,
    `gesture id was ${gStart}`);
  eq('the end carries the same gesture id', gEnd, gStart);
  check('the reloaded renderer did not reuse an old gesture id',
    gStart > firstGestureId,
    `the first renderer used ${firstGestureId}, the reloaded one used ${gStart}`);
}

const beforeSecondMove = calls.setPosition.length;
cursor = { x: 100, y: 100 };
await sleep(200);
eq('the pet is not glued to the cursor after the second gesture',
  calls.setPosition.length - beforeSecondMove, 0);

// The drag of the reloaded renderer must have been ACCEPTED — a refused
// start would leave the main process idle, which the check above cannot
// tell apart from a clean teardown.
check('the reloaded renderer actually dragged the pet',
  calls.dragging.indexOf(true) !== -1,
  `the setDragging calls were ${JSON.stringify(calls.dragging)}`);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const dom of bootedWindows) dom.window.close();
if (failures.length) {
  for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
process.exit(0);

})();
