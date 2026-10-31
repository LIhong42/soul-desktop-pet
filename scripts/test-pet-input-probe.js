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
//   * main/pet_input_probe.js watches the OS cursor (which the main
//     process can read whether or not the renderer can) against the
//     renderer's own "input is alive" report. The cursor moved, it is
//     sitting on the pet, and the pet has seen nothing → the input path
//     is dead.
//   * main/app_relaunch.js then kills this process and starts a new one.
//   * main/ipc.js wires the two together and honours the
//     `pet_restart_app_on_wake` setting: 'auto' (default), 'always' or
//     'off'.
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
// Part 1 — the probe itself
// ---------------------------------------------------------------------------
const { createInputProbe } = require(path.join(ROOT, 'main', 'pet_input_probe.js'));

// A pet window at (100, 200), 220 × 220.
const PET_BOUNDS = { x: 100, y: 200, width: 220, height: 220 };

function makeProbe(overrides = {}) {
  const state = {
    cursor: { x: 0, y: 0 },
    alive: false,
    dead: 0,
    aliveSeen: 0,
    logs: [],
    win: { isDestroyed: () => false, getBounds: () => PET_BOUNDS },
  };
  const probe = createInputProbe(Object.assign({
    getWindow: () => state.win,
    getCursor: () => state.cursor,
    hasInputAlive: () => state.alive,
    log: (entry) => state.logs.push(entry),
    onDead: () => { state.dead++; },
    onAlive: () => { state.aliveSeen++; },
    intervalMs: 10,
    strikes: 3,
    timeoutMs: 5000,
  }, overrides));
  return { probe, state };
}

async function testProbe() {
  console.log('\n[1] a renderer that reports back is left alone');
  {
    const { probe, state } = makeProbe();
    state.cursor = { x: 150, y: 250 };   // inside the pet
    probe.start('resume');
    await sleep(30);
    state.alive = true;                  // the renderer proves it is alive
    await sleep(60);
    eq('the input path was not declared dead', state.dead, 0);
    check('the probe stopped', !probe.isRunning());
  }

  console.log('\n[2] a cursor that never moves proves nothing');
  {
    const { probe, state } = makeProbe();
    state.cursor = { x: 150, y: 250 };   // inside the pet, but it never moves
    probe.start('resume');
    await sleep(120);
    eq('the input path was not declared dead', state.dead, 0);
    check('the probe is still watching', probe.isRunning());
    probe.stop();
  }

  console.log('\n[3] a cursor that moves on the DESKTOP proves nothing');
  {
    const { probe, state } = makeProbe();
    state.cursor = { x: 900, y: 700 };   // far away from the pet
    probe.start('resume');
    await sleep(30);
    state.cursor = { x: 950, y: 720 };   // it moved — but not over the pet
    await sleep(120);
    eq('the input path was not declared dead', state.dead, 0);
    probe.stop();
  }

  console.log('\n[4] a cursor that moves ON the pet, with no answer, is dead');
  {
    const { probe, state } = makeProbe();
    state.cursor = { x: 150, y: 250 };
    probe.start('resume');
    await sleep(30);
    state.cursor = { x: 160, y: 260 };   // it moved, and it is on the pet
    await sleep(200);
    eq('the input path was declared dead', state.dead, 1);
    check('the probe stopped', !probe.isRunning());
    check('the death was logged', state.logs.some((l) => l.kind === 'input_probe_dead'),
      JSON.stringify(state.logs.map((l) => l.kind)));
  }

  console.log('\n[5] a probe that finds nothing gives up on its own');
  {
    const { probe, state } = makeProbe({ timeoutMs: 60 });
    state.cursor = { x: 900, y: 700 };
    probe.start('resume');
    await sleep(150);
    eq('the input path was not declared dead', state.dead, 0);
    check('the probe stopped', !probe.isRunning());
  }

  console.log('\n[6] a pet window that is gone ends the probe');
  {
    const { probe, state } = makeProbe();
    probe.start('resume');
    await sleep(20);
    state.win = { isDestroyed: () => true, getBounds: () => PET_BOUNDS };
    await sleep(60);
    eq('the input path was not declared dead', state.dead, 0);
    check('the probe stopped', !probe.isRunning());
  }
}

// ---------------------------------------------------------------------------
// Part 2 — the wiring in main/ipc.js
// ---------------------------------------------------------------------------
const calls = {
  relaunch: [],
  exit: [],
  send: [],
  recreate: [],
};

let cursor = { x: 500, y: 400 };
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

// The setting under test. The stubbed db answers with it.
let restartOnWake = 'auto';

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
  getSetting: (key) => (key === 'pet_restart_app_on_wake' ? restartOnWake : undefined),
  setSetting: () => {},
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

const handlers = electronStub.ipcMain._handlers;
const invoke = (channel, ...args) => handlers.get(channel)(null, ...args);

async function testWiring() {
  console.log('\n[7] the renderer can report that input is alive');
  check('the pet:input_alive handler is registered', handlers.has('pet:input_alive'));
  const ok = await invoke('pet:input_alive');
  eq('the handler answers', ok, true);

  console.log('\n[8] "always" restarts the app on every wake');
  restartOnWake = 'always';
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

  console.log('\n[9] "off" never restarts the app');
  restartOnWake = 'off';
  calls.relaunch.length = 0;
  calls.exit.length = 0;
  skipDebounce();
  powerMonitor.emit('resume');
  await sleep(20);
  eq('the app was not relaunched', calls.relaunch.length, 0);
  eq('the process was not ended', calls.exit.length, 0);

  console.log('\n[10] "auto" waits for the probe instead of restarting at once');
  restartOnWake = 'auto';
  calls.relaunch.length = 0;
  calls.exit.length = 0;
  skipDebounce();
  powerMonitor.emit('resume');
  await sleep(20);
  eq('the app was not relaunched yet', calls.relaunch.length, 0);
  eq('the process was not ended', calls.exit.length, 0);

  console.log('\n[11] an unset setting falls back to restarting the app');
  // The setting has never been written (a fresh install), so the default
  // applies. The default is the blunt one: the in-process recovery does
  // not cure every case, and a fresh process is the only state that is
  // known to work.
  restartOnWake = undefined;
  calls.relaunch.length = 0;
  calls.exit.length = 0;
  skipDebounce();
  powerMonitor.emit('resume');
  await sleep(20);
  eq('the app was relaunched', calls.relaunch.length, 1);
  eq('the old process was ended', calls.exit.length, 1);
}

(async () => {
  console.log('pet input probe / app relaunch regression tests');
  await testProbe();
  await testWiring();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
})();
