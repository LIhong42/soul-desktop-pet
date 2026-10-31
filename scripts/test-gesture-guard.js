// scripts/test-gesture-guard.js — regression test for the shared pointer
// gesture guard.
//
// Why this matters: a pointer gesture is a latch — set on `pointerdown`,
// cleared on `pointerup`. If the `pointerup` never arrives, the latch stays
// set and the feature is wedged for the rest of the session.
//
// The `pointerup` goes missing when:
//   * the machine sleeps (the OS re-creates the pointer device, so the
//     browser never delivers an `pointerup` for the old pointer id), or
//   * the button is released outside the application window.
//
// The pet window had exactly this bug: after a sleep it could not be
// dragged again. The album editor had the same shape in five gestures —
// and in one of them (the photo drag) a stale drag would commit a real
// photo swap on the user's next unrelated click.
//
// The guard treats "an event from a different pointer id" as proof that the
// gesture is dead, and tears it down.
//
// Usage: node scripts/test-gesture-guard.js

const path = require('path');

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

// The guard is an ES module (the app's renderer scripts are modules), so it
// is loaded through a tiny transform: rewrite `export function` to a
// CommonJS assignment and evaluate it.
const fs = require('fs');
function loadGuard() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'gesture_guard.js'), 'utf8');
  // `export function createGestureGuard(...)` → `function createGestureGuard(...)`
  // plus a CommonJS export at the end.
  const body = src.replace(/export\s+function\s+createGestureGuard/g, 'function createGestureGuard')
    + '\nmodule.exports.createGestureGuard = createGestureGuard;';
  const module_ = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', body)(module_, module_.exports);
  return module_.exports.createGestureGuard;
}
const createGestureGuard = loadGuard();

// ---------------------------------------------------------------------------
// Test 1 — a normal gesture ends on its own pointer's `pointerup`
// ---------------------------------------------------------------------------
function testNormalEnd() {
  console.log('\n[1] a normal gesture ends on its own pointerup');
  let ended = 0, cancelled = 0;
  const guard = createGestureGuard({
    onEnd: () => { ended++; },
    onCancel: () => { cancelled++; },
  });

  guard.begin(1);
  check('the gesture is active', guard.isActive() === true);
  eq('a move from the same pointer is accepted', guard.move({ pointerId: 1 }), true);

  eq('the pointerup ended the gesture', guard.end({ pointerId: 1 }), true);
  eq('onEnd was called', ended, 1);
  eq('onCancel was not called', cancelled, 0);
  check('the gesture is no longer active', guard.isActive() === false);
}

// ---------------------------------------------------------------------------
// Test 2 — THE REGRESSION: a move from a different pointer id means the
// gesture is dead.
//
// This is the post-suspend case: the machine slept, the OS re-created the
// pointer device, and the mouse now reports a new pointer id.
// ---------------------------------------------------------------------------
function testForeignPointerCancels() {
  console.log('\n[2] a move from a different pointer cancels the gesture');
  let ended = 0, cancelled = 0;
  const guard = createGestureGuard({
    onEnd: () => { ended++; },
    onCancel: () => { cancelled++; },
  });

  guard.begin(1);
  // The mouse is a new device now.
  eq('the foreign move is rejected', guard.move({ pointerId: 2 }), false);
  eq('onCancel was called', cancelled, 1);
  eq('onEnd was NOT called', ended, 0);
  check('the gesture is no longer active', guard.isActive() === false);

  // And the next gesture works normally.
  guard.begin(2);
  eq('a new gesture can start', guard.move({ pointerId: 2 }), true);
  guard.end({ pointerId: 2 });
}

// ---------------------------------------------------------------------------
// Test 3 — a `pointerup` from a foreign pointer must NOT commit.
//
// This is the data-corruption case in the album editor: the drag is stale,
// and committing would swap a photo into a slot the user never dropped it
// on.
// ---------------------------------------------------------------------------
function testForeignPointerUpDoesNotCommit() {
  console.log('\n[3] a foreign pointerup cancels instead of committing');
  let ended = 0, cancelled = 0;
  const guard = createGestureGuard({
    onEnd: () => { ended++; },
    onCancel: () => { cancelled++; },
  });

  guard.begin(1);
  eq('the foreign pointerup did NOT end the gesture', guard.end({ pointerId: 7 }), false);
  eq('onEnd (the commit path) was NOT called', ended, 0);
  eq('onCancel was called', cancelled, 1);
  check('the gesture is no longer active', guard.isActive() === false);
}

// ---------------------------------------------------------------------------
// Test 4 — `pointercancel` from the platform cancels the gesture
// ---------------------------------------------------------------------------
function testPlatformCancel() {
  console.log('\n[4] a platform pointercancel cancels the gesture');
  let ended = 0, cancelled = 0;
  const guard = createGestureGuard({
    onEnd: () => { ended++; },
    onCancel: () => { cancelled++; },
  });

  guard.begin(1);
  eq('the cancel was handled', guard.cancel({ pointerId: 1 }), true);
  eq('onCancel was called', cancelled, 1);
  eq('onEnd was NOT called', ended, 0);
  check('the gesture is no longer active', guard.isActive() === false);
}

// ---------------------------------------------------------------------------
// Test 5 — starting a new gesture cancels the previous one
//
// Without this, the previous gesture's listeners and CSS classes would be
// orphaned.
// ---------------------------------------------------------------------------
function testBeginCancelsPrevious() {
  console.log('\n[5] beginning a new gesture cancels the previous one');
  let cancelled = 0;
  const guard = createGestureGuard({
    onEnd: () => {},
    onCancel: () => { cancelled++; },
  });

  guard.begin(1);
  guard.begin(2);
  eq('the previous gesture was cancelled', cancelled, 1);
  check('the new gesture is active', guard.isActive() === true);
  eq('the new pointer owns the gesture', guard.move({ pointerId: 2 }), true);
}

// ---------------------------------------------------------------------------
// Test 6 — with no gesture in flight, events are inert
// ---------------------------------------------------------------------------
function testNoGestureInFlight() {
  console.log('\n[6] events with no gesture in flight are inert');
  let ended = 0, cancelled = 0;
  const guard = createGestureGuard({
    onEnd: () => { ended++; },
    onCancel: () => { cancelled++; },
  });

  check('no gesture is active', guard.isActive() === false);
  eq('a move is ignored', guard.move({ pointerId: 1 }), false);
  eq('a pointerup is ignored', guard.end({ pointerId: 1 }), false);
  eq('a cancel is ignored', guard.cancel({ pointerId: 1 }), false);
  eq('nothing was ended', ended, 0);
  eq('nothing was cancelled', cancelled, 0);
}

// ---------------------------------------------------------------------------
// Test 7 — a handler that throws does not break the guard
//
// A teardown handler that throws (e.g. it touches a DOM node that is gone)
// must not leave the guard holding a stale pointer id — that would wedge
// every later gesture.
// ---------------------------------------------------------------------------
function testThrowingHandlerStillClears() {
  console.log('\n[7] a throwing teardown handler still clears the guard');
  const guard = createGestureGuard({
    onEnd: () => { throw new Error('boom'); },
    onCancel: () => { throw new Error('boom'); },
  });

  guard.begin(1);
  try { guard.end({ pointerId: 1 }); } catch (e) { /* the guard swallows it */ }
  check('the gesture was cleared despite the throw', guard.isActive() === false);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log('gesture guard regression tests');
testNormalEnd();
testForeignPointerCancels();
testForeignPointerUpDoesNotCommit();
testPlatformCancel();
testBeginCancelsPrevious();
testNoGestureInFlight();
testThrowingHandlerStillClears();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
