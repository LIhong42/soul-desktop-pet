// scripts/test-pet-drag-main.js — regression test for the main-process
// drag handlers in main/ipc.js.
//
// The bug this guards against: `screen.getCursorScreenPoint()` returns a
// Point OBJECT ({x, y}), not an array. Destructuring it as
// `const [x, y] = screen.getCursorScreenPoint()` throws
// "object is not iterable", which killed the whole drag handler and left
// the pet frozen under the cursor.
//
// This loads main/ipc.js under a stubbed `electron` module so the real
// handlers are exercised, then drives them through the same IPC channel
// names the renderer uses.
//
// Usage: node scripts/test-pet-drag-main.js

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Stub the `electron` module BEFORE main/ipc.js requires it.
// ---------------------------------------------------------------------------
const calls = { setPosition: [], send: [] };

const fakeWindow = {
  isDestroyed: () => false,
  getPosition: () => [100, 200],
  getBounds: () => ({ x: 100, y: 200, width: 220, height: 220 }),
  setPosition: (x, y) => { calls.setPosition.push([x, y]); },
  webContents: { send: (...a) => calls.send.push(a) },
  on: () => {},
  show: () => {},
  focus: () => {},
  executeJavaScript: () => Promise.resolve(),
};

const electronStub = {
  ipcMain: {
    // channel -> handler
    _handlers: new Map(),
    handle(channel, fn) { this._handlers.set(channel, fn); },
    removeHandler(channel) { this._handlers.delete(channel); },
  },
  app: {
    getPath: () => ROOT,
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
  // The important bit: a Point OBJECT, exactly as Electron returns it.
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayMatching: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
  },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  dialog: {},
  shell: {},
  powerMonitor: {},
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
// Assertions
// ---------------------------------------------------------------------------
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
// Load main/ipc.js and register the handlers
// ---------------------------------------------------------------------------
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

const petController = {
  setPaused: (ms) => { calls.setPaused = ms; },
  setDragging: (on) => { calls.dragging = on; },
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
const invoke = (channel, ...args) => handlers.get(channel)(null, ...args);

// ---------------------------------------------------------------------------
// Test 1 — drag_start must place the window under the cursor
// ---------------------------------------------------------------------------
console.log('\n[1] drag_start positions the window under the cursor');
calls.setPosition.length = 0;
const ok = invoke('pet:drag_start', 100, 80);
eq('the handler returned true', ok, true);
eq('setPosition was called once', calls.setPosition.length, 1);
// Cursor is (500,400); grab offset is (100,80) → window goes to (400,320).
eq('the window landed at the expected spot',
  JSON.stringify(calls.setPosition[0]), JSON.stringify([400, 320]));
eq('the controller took the drag mutex', calls.dragging, true);

// ---------------------------------------------------------------------------
// Test 2 — the poller keeps following the cursor
// ---------------------------------------------------------------------------
console.log('\n2] the poller keeps the window under the cursor');
calls.setPosition.length = 0;
// Let the 16 ms poller tick a couple of times.
setTimeout(() => {
  check('the poller moved the window', calls.setPosition.length > 0,
    `setPosition was called ${calls.setPosition.length} times`);
  eq('the poller used the same offset',
    JSON.stringify(calls.setPosition[0]), JSON.stringify([400, 320]));

  // -------------------------------------------------------------------------
  // Test 3 — drag_end releases the mutex
  // -------------------------------------------------------------------------
  console.log('\n[3] drag_end releases the drag mutex');
  invoke('pet:drag_end');
  eq('the mutex was released', calls.dragging, false);

  // The poller must be stopped — no further movement after the drag ended.
  const afterEnd = calls.setPosition.length;
  setTimeout(() => {
    eq('the poller stopped', calls.setPosition.length, afterEnd);

    // ---------------------------------------------------------------------
    // Test 4 — drag_start survives a missing / garbage offset
    // ---------------------------------------------------------------------
    console.log('\n[4] drag_start copes with a missing offset');
    calls.setPosition.length = 0;
    invoke('pet:drag_start', undefined, undefined);
    check('the window was still positioned', calls.setPosition.length > 0);
    // Fallback: offset = cursor - window position = (500-100, 400-200) = (400,200)
    // → new window position = (500-400, 400-200) = (100, 200) = unchanged.
    eq('the window stayed where it was',
      JSON.stringify(calls.setPosition[0]), JSON.stringify([100, 200]));
    invoke('pet:drag_end');

    // ---------------------------------------------------------------------
    // Test 5 — move_by still clamps to the work area
    // ---------------------------------------------------------------------
    console.log('\n[5] move_by clamps to the work area');
    calls.setPosition.length = 0;
    invoke('pet:move_by', 100000, 100000);
    const [mx, my] = calls.setPosition[0];
    eq('x is clamped to the right edge', mx, 1920 - 220);
    eq('y is clamped to the bottom edge', my, 1040 - 220);

    // ---------------------------------------------------------------------
    // Test 6 — a bad delta must not throw
    // ---------------------------------------------------------------------
    console.log('\n[6] move_by with a non-numeric delta does not throw');
    calls.setPosition.length = 0;
    let threw = false;
    try { invoke('pet:move_by', undefined, undefined); } catch { threw = true; }
    check('the handler did not throw', !threw);

    // ---------------------------------------------------------------------
    // Test 7 — the position handed to setPosition must be an INTEGER
    // ---------------------------------------------------------------------
    //
    // `setPosition` throws "conversion failure" on a fractional coordinate,
    // which takes down the whole drag handler. The grab offset the renderer
    // measures is routinely fractional (and on a HiDPI display the cursor
    // and the window are in different units to begin with), so this is the
    // case that actually bites in the field.
    console.log('\n[7] setPosition always receives integer coordinates');
    calls.setPosition.length = 0;
    invoke('pet:drag_start', 40.5, 60.25);
    invoke('pet:drag_end');
    check('the drag started', calls.setPosition.length > 0);
    for (const [x, y] of calls.setPosition) {
      check(`x is an integer (${x})`, Number.isInteger(x));
      check(`y is an integer (${y})`, Number.isInteger(y));
    }

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
    process.exit(0);
  }, 80);
}, 80);
