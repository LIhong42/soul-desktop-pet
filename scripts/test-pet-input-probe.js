// scripts/test-pet-input-probe.js — regression test for the "the pet
// cannot be dragged after a sleep" last-resort recovery.
//
// THE PROBLEM
// -----------
// After a system suspend the pet window can be ALIVE AND DEAF at the same
// time: it still answers IPC (it replies to `pet:resume`, so it looks
// perfectly healthy) while not a single mouse event ever reaches it.
//
// The cause is Chromium's pointer-device registry. A pointer event is
// built by `PointerEventFactory`, which needs a registered pointer
// DEVICE; the legacy mouse events are built straight from the raw mouse
// input and need no device. A suspend tears the device down, the OS brings
// it back as a new one, and the browser process's registry can end up not
// knowing about it.
//
// The registry lives in the BROWSER PROCESS and is shared by every window,
// so nothing inside the running app can repair it: a new window inherits
// it, a page reload certainly does. The only cure is a NEW PROCESS.
//
// THE FIX
// -------
// On every wake the app kills its process and starts a new one
// (main/app_relaunch.js, wired up in main/ipc.js). There is no setting
// for it: the user does not get to choose, because the in-process recovery
// does not cure every case — on the real machine (2026-10-31) the pet was
// still undraggable after a wake WITH a live input path.
//
// This file keeps the name it has always had, but the probe it used to
// test is gone: with the restart unconditional there is nothing to probe.
//
// Usage: node scripts/test-pet-input-probe.js

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The wiring in main/ipc.js
// ---------------------------------------------------------------------------
const calls = {
  relaunch: [],
  exit: [],
  send: [],
  recreate: [],
};

const fakeWindow = {
  isDestroyed: () => false,
  getPosition: () => [100, 200],
  getBounds: () => ({ x: 100, y: 200, width: 220, height: 220 }),
  setPosition: () => {},
  isVisible: () => true,
  show: () => {},
  setIgnoreMouseEvents: () => {},
  reload: () => {},
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
    getPath: () => require('os').tmpdir(),
    isPackaged: false,
    on: () => {},
    getName: () => 'SoulDesktopPet',
    getVersion: () => '0.1.0',
    getLocale: () => 'zh-CN',
    whenReady: () => Promise.resolve(),
    quit: () => {},
    relaunch: (opts) => { calls.relaunch.push(opts); },
    exit: (code) => { calls.exit.push(code); },
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  dialog: {},
  shell: {},
  powerMonitor,
  BrowserWindow: class {},
};

// The wake recovery de-duplicates its restarts: one sleep is reported
// several times (the `resume` event, the `unlock-screen` event and the
// clock-jump watchdog all fire for it), so a restart is suppressed for ten
// seconds (main/ipc.js, on the monotonic clock) — and main/pet_resume.js
// swallows the duplicate `resume` events themselves after two seconds (on
// the wall clock).
//
// The tests trigger several wakes in a row, so both clocks are moved
// forward instead of waiting.
let clockOffset = 0;
const realPerformanceNow = performance.now.bind(performance);
const realDateNow = Date.now.bind(Date);
try {
  performance.now = () => realPerformanceNow() + clockOffset;
  Date.now = () => realDateNow() + clockOffset;
} catch (e) { /* the clock cannot be moved — the test just gets slower */ }
const skipDebounce = () => { clockOffset += 20000; };

const dbStub = {
  getSetting: () => undefined,
  setSetting: () => {},
  save: () => {},
  // The bubble scheduler in main/pet_bubbles.js runs on a timer and reads
  // the bubbles table through `db.get()`. The stub only has to answer it
  // — the test is about the wake recovery, not about the bubbles.
  get: () => null,
};

// Patch the module loader: 'electron' and './db' both get a stub.
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
const dbPath = require.resolve(path.join(ROOT, 'main', 'db.js'));
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: dbStub,
};

const ipc = require(path.join(ROOT, 'main', 'ipc.js'));

ipc.register({
  queue: { on: () => {}, activeCount: () => 0, activeHead: () => null },
  winMain: fakeWindow,
  winPet: fakeWindow,
  getWinPet: () => fakeWindow,
  recreatePetWindow: (reason) => { calls.recreate.push(reason); },
  setPetState: () => {},
  getPetState: () => false,
  setActiveReminder: () => {},
  broadcastPetState: () => {},
  petController: {
    setPaused: () => {},
    setDragging: () => {},
    clampIntoView: () => {},
  },
  petRegistry: null,
});

async function testWiring() {
  console.log('\n[1] the wake restarts the app');
  calls.relaunch.length = 0;
  calls.exit.length = 0;
  skipDebounce();
  powerMonitor.emit('resume');
  await sleep(20);
  eq('the app was relaunched', calls.relaunch.length, 1);
  eq('the old process was ended', calls.exit.length, 1);
  eq('the exit code is 0', calls.exit[0], 0);
  check('the relaunch kept the launch arguments',
    calls.relaunch[0] && Array.isArray(calls.relaunch[0].args),
    JSON.stringify(calls.relaunch[0]));

  console.log('\n[2] the wake restarts the app again — there is no setting');
  // The setting that used to choose between 'always', 'auto' and 'off' is
  // gone. The database is stubbed, so a stored value cannot change the
  // behaviour: the restart is unconditional.
  calls.relaunch.length = 0;
  calls.exit.length = 0;
  skipDebounce();
  powerMonitor.emit('resume');
  await sleep(20);
  eq('the app was relaunched', calls.relaunch.length, 1);
  eq('the old process was ended', calls.exit.length, 1);
}

(async () => {
  console.log('app relaunch on wake regression tests');
  await testWiring();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
})();
