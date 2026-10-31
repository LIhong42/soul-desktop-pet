// scripts/test-pet-resume.js — regression test for the "drag breaks after
// sleep" bug.
//
// THE BUG
// --------
// The pet drag is a two-party protocol: the renderer owns the gesture, the
// main process owns the window position. The renderer releases the main
// process's side by sending `pet:drag_end`.
//
// A system suspend breaks that guarantee. The `pointerup` that ends the
// gesture may never be delivered, and the renderer's own rescue paths
// (`blur` / `visibilitychange`) can fire before the OS restores the session
// — and their `endDrag()` early-returned when `pressing` was already false,
// so `pet:drag_end` was never sent.
//
// The main process then kept polling the cursor forever: the pet was glued
// to the pointer, and because the controller's drag mutex stayed held,
// `PetController.tick()` returned early forever and the pet's autonomous
// movement was dead for the rest of the session.
//
// THE FIX
// -------
//   * main/pet_resume.js listens for `resume` / `unlock-screen` and
//     unconditionally tears the drag down (releasing both the cursor poller
//     and the controller's drag mutex), re-asserts the window's visibility
//     and mouse state, and notifies the renderer over `pet:resume`.
//   * The renderer's `endDrag(force)` no longer skips the `pet:drag_end` IPC
//     on the forced path, so the main process always learns the gesture is
//     over.
//
// This test drives the REAL main-process handlers from main/ipc.js under a
// stubbed `electron` module, then fires the resume event and asserts that
// nothing is left stuck.
//
// Usage: node scripts/test-pet-resume.js

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Stub the `electron` module BEFORE main/ipc.js requires it.
// ---------------------------------------------------------------------------
const calls = {
  setPosition: [],
  dragging: [],
  paused: [],
  send: [],
  show: [],
  ignoreMouse: [],
  reload: [],
  recreate: [],
};

let cursor = { x: 500, y: 400 };
let windowPos = [100, 200];
let windowVisible = true;
// Set by test 12: make the window recreation fail.
let failRecreate = false;

const fakeWindow = {
  isDestroyed: () => false,
  getPosition: () => windowPos,
  getBounds: () => ({ x: windowPos[0], y: windowPos[1], width: 220, height: 220 }),
  setPosition: (x, y) => { calls.setPosition.push([x, y]); windowPos = [x, y]; },
  isVisible: () => windowVisible,
  show: () => { calls.show.push(true); windowVisible = true; },
  setIgnoreMouseEvents: (on) => { calls.ignoreMouse.push(on); },
  // The recovery restarts the pet's renderer — the "just restart the pet"
  // recovery. The window, its position and the main process all stay as
  // they are; only the page is rebuilt.
  reload: () => { calls.reload.push(true); },
  webContents: { send: (...a) => calls.send.push(a) },
  on: () => {},
  show: () => { calls.show.push(true); windowVisible = true; },
  focus: () => {},
  executeJavaScript: () => Promise.resolve(),
};

// The powerMonitor stub records listeners so the test can fire them.
const powerMonitor = {
  _listeners: new Map(),
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  },
  removeListener(event, fn) {
    const list = this._listeners.get(event) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  },
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
    // The data directory is the OS temp directory, NOT the repository: the
    // diagnostic log is written there, and a test must not leave files
    // behind in the working tree.
    getPath: () => require('os').tmpdir(),
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
  clamped: 0,
  setPaused: (ms) => { calls.paused.push(ms); },
  setDragging: (on) => { calls.dragging.push(on); },
  clampIntoView: () => { petController.clamped++; },
};

ipc.register({
  queue: { on: () => {}, activeCount: () => 0, activeHead: () => null },
  winMain: fakeWindow,
  winPet: fakeWindow,
  getWinPet: () => fakeWindow,
  // The wake recovery restarts the pet by recreating its window. The
  // recreation itself lives in main/main.js (it owns the window); here it
  // is just recorded.
  //
  // `failRecreate` makes the recreation throw, which is how test 12 checks
  // that a failed restart still leaves the pet with a working recovery
  // (a page reload) instead of nothing at all.
  recreatePetWindow: (reason) => {
    if (failRecreate) throw new Error('the pet window could not be recreated');
    calls.recreate.push(reason);
  },
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
// Tests
// ---------------------------------------------------------------------------
(async () => {

// ---------------------------------------------------------------------------
// Test 1 — the resume handler is actually wired up
// ---------------------------------------------------------------------------
console.log('\n[1] the resume handler is registered');
check('a "resume" listener was attached', (powerMonitor._listeners.get('resume') || []).length > 0);
check('an "unlock-screen" listener was attached', (powerMonitor._listeners.get('unlock-screen') || []).length > 0);

// The resume handler de-duplicates events within a short window (Electron 32
// emits `resume` twice — electron/electron#44252). Wait it out between the
// tests that each need a resume to be handled.
const RESUME_DEBOUNCE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitOutDebounce = () => sleep(RESUME_DEBOUNCE_MS + 100);

// ---------------------------------------------------------------------------
// Test 2 — THE REGRESSION: a drag interrupted by sleep must not stay stuck
// ---------------------------------------------------------------------------
console.log('\n[2] a drag interrupted by sleep is torn down on resume');
calls.dragging.length = 0;
calls.setPosition.length = 0;

// The user starts dragging the pet.
invoke('pet:drag_start', 100, 80);
eq('the drag took the controller mutex', calls.dragging[calls.dragging.length - 1], true);

// Let the poller tick a couple of times so we can prove it stops.
await sleep(60);
const pollsWhileDragging = calls.setPosition.length;
check('the poller was running during the drag', pollsWhileDragging > 0);

// The system suspends. The `pointerup` never arrives, so the renderer never
// sends `pet:drag_end`. The machine comes back.
cursor = { x: 900, y: 700 };
powerMonitor.emit('resume');

// The cursor poller must be dead — otherwise the pet is glued to the pointer.
const afterResume = calls.setPosition.length;
await sleep(120);
eq('the cursor poller stopped', calls.setPosition.length, afterResume);
check('the controller mutex was released',
  calls.dragging[calls.dragging.length - 1] === false,
  `last setDragging call was ${JSON.stringify(calls.dragging[calls.dragging.length - 1])}`);

// The renderer must have been told to forget its gesture.
const resumeSends = calls.send.filter((c) => c[0] === 'pet:resume');
eq('the renderer was notified over pet:resume', resumeSends.length, 1);

// The window state must have been re-asserted.
check('setIgnoreMouseEvents(false) was re-applied', calls.ignoreMouse.includes(false));
check('the pet was clamped back into view', petController.clamped > 0);

// The pet must be RESTARTED: after a sleep the pet can end up in a state
// where it cannot be dragged at all, and a fresh window is the one thing
// that is known to clear it.
//
// It is a full restart — the window is destroyed and created again — and
// not a reload of the page: the real machine's diagnostic log showed a
// reloaded renderer that kept receiving IPC while never receiving a
// single mouse event again. The window's position and the main process
// stay exactly where they were.
eq('the pet was restarted', calls.recreate.length, 1);
eq('the page was not merely reloaded', calls.reload.length, 0);

// ---------------------------------------------------------------------------
// Test 3 — the mutex is released even when the main process thought no
// drag was running (the renderer died with the gesture)
// ---------------------------------------------------------------------------
console.log('\n[3] the mutex is released even when no drag was in flight');
await waitOutDebounce();
calls.dragging.length = 0;
petController.clamped = 0;

// No drag_start at all — but the renderer may have died mid-gesture
// believing a drag was running, and the main process never learned.
powerMonitor.emit('resume');
eq('setDragging(false) was still called', calls.dragging[calls.dragging.length - 1], false);

// ---------------------------------------------------------------------------
// Test 4 — the duplicate `resume` event is de-duplicated
// ---------------------------------------------------------------------------
console.log('\n[4] the duplicate resume event is de-duplicated (electron/electron#44252)');
await waitOutDebounce();
calls.send.length = 0;
petController.clamped = 0;

// Electron 32 emits `resume` twice for a single sleep.
powerMonitor.emit('resume');
powerMonitor.emit('resume');
eq('the renderer was notified once', calls.send.filter((c) => c[0] === 'pet:resume').length, 1);
eq('the pet was clamped once', petController.clamped, 1);

// ---------------------------------------------------------------------------
// Test 5 — a drag started AFTER the resume works normally
// ---------------------------------------------------------------------------
console.log('\n[5] dragging still works after a resume');
calls.dragging.length = 0;
calls.setPosition.length = 0;

invoke('pet:drag_start', 100, 80);
eq('the new drag took the mutex', calls.dragging[calls.dragging.length - 1], true);
await new Promise((r) => setTimeout(r, 80));
check('the poller is running again', calls.setPosition.length > 0,
  `setPosition was called ${calls.setPosition.length} times`);

invoke('pet:drag_end');
eq('the normal end still releases the mutex', calls.dragging[calls.dragging.length - 1], false);

// ---------------------------------------------------------------------------
// Test 6 — `pet:get_position` reports the LIVE window position
// ---------------------------------------------------------------------------
console.log('\n[6] pet:get_position reports the live window position');
windowPos = [640, 480];
const pos = invoke('pet:get_position');
eq('x is the live window x', pos.x, 640);
eq('y is the live window y', pos.y, 480);

// ---------------------------------------------------------------------------
// Test 7 — the CLOCK-JUMP WATCHDOG.
//
// This is the safety net for the case the user actually hit: the machine
// sleeps, and the OS never delivers a `resume` event (Windows 11 Modern
// Standby freezes the process before the wake notification is dispatched,
// electron/electron#47739). Nothing in the process would know a sleep
// happened.
//
// The watchdog detects the sleep from the wall clock instead: timers do not
// replay the ticks missed during a sleep, but `Date.now()` jumps forward by
// the length of the sleep. So the first heartbeat after a freeze sees a gap
// far larger than the heartbeat interval.
//
// Here the freeze is simulated by moving the clock forward and letting the
// heartbeat tick.
// ---------------------------------------------------------------------------
console.log('\n[7] the clock-jump watchdog recovers a sleep the OS never announced');
await waitOutDebounce();
calls.send.length = 0;
petController.clamped = 0;
calls.dragging.length = 0;

// A drag is in flight when the machine sleeps.
invoke('pet:drag_start', 100, 80);
eq('the drag took the mutex before the sleep', calls.dragging[calls.dragging.length - 1], true);

// The machine sleeps for 10 minutes and no `resume` event is delivered.
// The wall clock jumps forward; the process was frozen meanwhile.
const realNow = Date.now;
let fakeNow = realNow();
Date.now = () => fakeNow;
fakeNow += 10 * 60 * 1000;

// Wait for the watchdog heartbeat (5 s interval) to observe the jump.
await sleep(6500);

// The watchdog must have torn the drag down and told the renderer.
check('the renderer was notified without any resume event',
  calls.send.filter((c) => c[0] === 'pet:resume').length >= 1,
  `pet:resume sends: ${calls.send.filter((c) => c[0] === 'pet:resume').length}`);
check('the controller mutex was released',
  calls.dragging[calls.dragging.length - 1] === false,
  `last setDragging call was ${JSON.stringify(calls.dragging[calls.dragging.length - 1])}`);

// The cursor poller must be dead too.
const afterWatchdog = calls.setPosition.length;
await sleep(120);
eq('the cursor poller stopped', calls.setPosition.length, afterWatchdog);

Date.now = realNow;

// ---------------------------------------------------------------------------
// Test 8 — the pet is restarted ONCE per wake.
//
// The same sleep can be reported more than once: the `resume` event and the
// clock-jump watchdog both notice it. The user should see the pet restart
// once per sleep, not once per report — the pet blinking twice for one
// wake looks like a glitch.
// ---------------------------------------------------------------------------
console.log('\n[8] the pet is restarted once per wake');
await waitOutDebounce();
calls.recreate.length = 0;

// Two wakes, far enough apart that the resume de-duplication does not
// swallow the second one, but close enough that the restart de-duplication
// does.
powerMonitor.emit('resume');
await waitOutDebounce();
powerMonitor.emit('resume');

eq('the pet was restarted once', calls.recreate.length, 1);

// ---------------------------------------------------------------------------
// Test 9 — the watchdog must NOT fire on a normal tick.
//
// The gap between two healthy heartbeats is already ~the heartbeat
// interval, so a threshold BELOW the interval would fire on every single
// tick — running the whole recovery (including `winPet.show()`, which
// briefly steals the z-order) every five seconds, forever.
//
// This test guards that threshold relationship.
// ---------------------------------------------------------------------------
console.log('\n[9] the watchdog does not fire on a normal heartbeat');
await waitOutDebounce();
calls.send.length = 0;

// Let a couple of healthy heartbeats pass with an untouched clock.
await sleep(11000);

eq('no recovery ran on a normal heartbeat',
  calls.send.filter((c) => c[0] === 'pet:resume').length, 0);

// ---------------------------------------------------------------------------
// Test 10 — THE REGRESSION: a drag start that arrives AFTER its own drag
// end must not start a drag.
//
// The renderer resolves the grab offset asynchronously, so the
// `pet:drag_start` it sends can be overtaken by the `pet:drag_end` of
// the same gesture — a quick flick is over before the reply comes back,
// and after a resume the main process can be slow to answer at all.
//
// The main process would then be left following the cursor with nothing
// to stop it: the pet is glued to the pointer (it cannot be dragged
// anywhere) and the controller's drag mutex stays held, so the pet never
// walks on its own again.
//
// The gesture id is what makes the two messages orderable, so this test
// drives the handlers in the wrong order and checks that the main
// process refuses the late start.
// ---------------------------------------------------------------------------
console.log('\n[10] a drag start that arrives after its end is refused');
calls.dragging.length = 0;
calls.setPosition.length = 0;

// The end overtakes the start — the order the renderer used to produce.
invoke('pet:drag_end', 7);
const accepted = invoke('pet:drag_start', 100, 80, 7);
eq('the late start was refused', accepted, false);

// Nothing may be left running.
await sleep(120);
eq('the cursor poller is not running', calls.setPosition.length, 0);
check('the controller mutex was not taken',
  calls.dragging.indexOf(true) === -1,
  `setDragging calls were ${JSON.stringify(calls.dragging)}`);

// ---------------------------------------------------------------------------
// Test 11 — a drag end for an OLDER gesture must not stop the drag that
// is running now.
//
// The messages of two overlapping gestures can be interleaved. A late end
// belonging to the older one must be ignored, or the pet would be left
// where the user put it while a newer drag is still in flight.
// ---------------------------------------------------------------------------
console.log('\n[11] a late end for an older gesture does not stop the live drag');
calls.dragging.length = 0;
calls.setPosition.length = 0;

invoke('pet:drag_start', 100, 80, 20);
eq('the drag took the controller mutex', calls.dragging[calls.dragging.length - 1], true);

// The end of an older gesture arrives late.
invoke('pet:drag_end', 19);
await sleep(60);
check('the live drag is still following the cursor', calls.setPosition.length > 0);
check('the controller mutex is still held',
  calls.dragging[calls.dragging.length - 1] === true);

// The real end stops it.
invoke('pet:drag_end', 20);
const afterEnd = calls.setPosition.length;
await sleep(120);
eq('the cursor poller stopped', calls.setPosition.length, afterEnd);
check('the controller mutex was released',
  calls.dragging[calls.dragging.length - 1] === false);

// ---------------------------------------------------------------------------
// Test 12 — a FAILED window recreation still leaves a recovery behind.
//
// The window restart is the last layer of the wake recovery, so it has to
// work when it can. But if the recreation itself throws (a native call that
// fails on a wedged display, for instance), the pet must not be left with
// NO recovery at all: the page reload is weaker than a new window, but it
// still rebuilds the pet's page, and something is better than nothing.
//
// The restart de-duplication (10 s) has to be waited out first, otherwise
// this resume is swallowed as a duplicate of the previous one.
// ---------------------------------------------------------------------------
console.log('\n[12] a failed window recreation falls back to a page reload');
await waitOutDebounce();
await sleep(10500);

calls.reload.length = 0;
calls.recreate.length = 0;
failRecreate = true;
powerMonitor.emit('resume');

eq('the page was reloaded as a fallback', calls.reload.length, 1);
eq('the window was not recreated', calls.recreate.length, 0);

failRecreate = false;

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
process.exit(0);

})();
