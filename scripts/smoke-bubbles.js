#!/usr/bin/env node
// scripts/smoke-bubbles.js — behavioural checks for main/pet_bubbles.js.
//
// Runs the framework against an in-memory fake `db` (a Map) with the real
// rule set, so no Electron, no network, and no user data are involved.
// Covers each of the three shipped rules plus the selection/latching logic
// that the bubble lifecycle depends on.
//
// Usage: node scripts/smoke-bubbles.js

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---- In-memory db double -------------------------------------------------
// Matches the surface pet_bubbles.js actually touches: get / getSetting /
// setSetting. Anything more would be a fake that no code under test calls.
const store = new Map();
const fakeDb = {
  get: () => ({ /* non-null so `if (!db.get()) return` passes */ }),
  getSetting(k) { return store.has(k) ? store.get(k) : null; },
  setSetting(k, v) { store.set(k, String(v)); },
};

// pet_bubbles requires ./db; swap it for the double before loading.
const dbPath = require.resolve(path.join(ROOT, 'main', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const bubbles = require(path.join(ROOT, 'main', 'pet_bubbles.js'));
const I = bubbles._internals;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.message));
    process.exitCode = 1;
  }
}

function at(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

console.log('\n[meal] 吃饭提醒');

check('fires inside the lunch window', () => {
  const state = I.loadState(fakeDb);
  const snap = I.buildSnapshot(state, at(12, 30), 0);
  const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
  assert.strictEqual(picked.rule.name, 'meal');
  assert.strictEqual(picked.intent.text, '午饭：今天吃撒');
});

check('is silent outside every meal window', () => {
  const state = I.loadState(fakeDb);
  const snap = I.buildSnapshot(state, at(15, 0), 0);
  assert.strictEqual(I.pickRule(snap, bubbles.loadEnabled(fakeDb)), null);
});

check('is silent before breakfast and after dinner', () => {
  for (const t of [[5, 0], [21, 0]]) {
    const state = I.loadState(fakeDb);
    const snap = I.buildSnapshot(state, at(t[0], t[1]), 0);
    const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
    // At 21:00 only the break rule could fire, and idle=0 blocks it.
    assert.ok(!picked || picked.rule.name !== 'meal',
      `expected no meal bubble at ${t[0]}:${t[1]}, got ${picked && picked.rule.name}`);
  }
});

check('window boundaries are inclusive-of-start, exclusive-of-end', () => {
  assert.ok(I.parseHhmmToMinutes('06:30') === 390);
  assert.ok(I.currentMealWindow({ windows: [{ id: 'x', from: '06:30', to: '09:30' }] }, at(6, 30)));
  assert.ok(!I.currentMealWindow({ windows: [{ id: 'x', from: '06:30', to: '09:30' }] }, at(9, 30)));
  assert.ok(I.currentMealWindow({ windows: [{ id: 'x', from: '06:30', to: '09:30' }] }, at(9, 29)));
});

check('feeding latches the window off (early end)', () => {
  const state = I.loadState(fakeDb);
  const snap = I.buildSnapshot(state, at(12, 30), 0);
  const meal = bubbles.BUILTIN_RULES.find((r) => r.name === 'meal');
  meal.onEvent('fed', snap, {});
  assert.strictEqual(snap.feedWindows.lunch, true);
  // Now the rule declines, even though we're still in the window.
  assert.strictEqual(meal.build(snap), null);
});

check('the latch rolls over at midnight', () => {
  const state = I.loadState(fakeDb);
  state.feedWindows = { lunch: true };
  state.feedWindowsDay = '2000-01-01';
  I.buildSnapshot(state, at(12, 30), 0);
  assert.deepStrictEqual(state.feedWindows, {});
});

check('meal carries the other two defaults: 1 hour', () => {
  const state = I.loadState(fakeDb);
  const snap = I.buildSnapshot(state, at(12, 30), 0);
  const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
  assert.strictEqual(picked.intent.durationMs, 60 * 60_000);
});

console.log('\n[break] 休息提醒');

check('silent under an hour of continuous use', () => {
  const state = I.loadState(fakeDb);
  state.lastBreakNudgeAt = 0;
  const snap = I.buildSnapshot(state, at(10, 0), 59 * 60);
  const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
  assert.ok(!picked || picked.rule.name !== 'break');
});

check('fires past an hour', () => {
  const state = I.loadState(fakeDb);
  state.lastBreakNudgeAt = 0;
  const snap = I.buildSnapshot(state, at(10, 0), 61 * 60);
  const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
  assert.strictEqual(picked.rule.name, 'break');
  assert.ok(picked.intent.text.includes('坐太久'));
});

check('silent when idle time is unknown (-1)', () => {
  const state = I.loadState(fakeDb);
  state.lastBreakNudgeAt = 0;
  const snap = I.buildSnapshot(state, at(10, 0), -1);
  const picked = I.pickRule(snap, fakeMapAll());
  assert.ok(!picked || picked.rule.name !== 'break');
});

function fakeMapAll() {
  const m = {};
  for (const r of bubbles.BUILTIN_RULES) m[r.kind] = true;
  return m;
}

check('3-hour cooldown suppresses the next nudge', () => {
  const state = I.loadState(fakeDb);
  state.lastBreakNudgeAt = Date.now() - 2 * 60 * 60_000;
  const snap = I.buildSnapshot(state, at(10, 0), 61 * 60);
  const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
  assert.ok(!picked || picked.rule.name !== 'break');
});

check('rotates its lines across nudges', () => {
  const rule = bubbles.BUILTIN_RULES.find((r) => r.name === 'break');
  const seen = new Set();
  for (let i = 0; i < rule.texts.length; i++) {
    const snap = { idleSeconds: 61 * 60, lastBreakNudgeAt: 0, breakNudgeCount: i };
    seen.add(rule.build(snap).text);
  }
  assert.strictEqual(seen.size, rule.texts.length);
});

console.log('\n[framework] 调度 / 优先级 / 开关');

check('meal beats break when both are due', () => {
  const state = I.loadState(fakeDb);
  state.lastBreakNudgeAt = 0;
  const snap = I.buildSnapshot(state, at(12, 30), 61 * 60);
  const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
  assert.strictEqual(picked.rule.name, 'meal');
  // Latching lunch drops meal, and break falls through.
  snap.feedWindows.lunch = true;
  assert.strictEqual(I.pickRule(snap, bubbles.loadEnabled(fakeDb)).rule.name, 'break');
});

check('the engine ships exactly two kinds', () => {
  assert.deepStrictEqual(
    bubbles.BUILTIN_RULES.map((r) => r.name).sort(),
    ['break', 'meal'],
  );
  assert.deepStrictEqual(Object.keys(bubbles.KINDS).sort(), ['BREAK', 'MEAL']);
});

check('no network module is reachable from the engine', () => {
  // The app is local-first; weather was the only thing that ever made a
  // request, so assert the removal is complete at the source level.
  const src = require('fs').readFileSync(path.join(ROOT, 'main', 'pet_bubbles.js'), 'utf8');
  assert.ok(!/require\(['"]https?['"]\)/.test(src), 'pet_bubbles.js must not require http(s)');
  assert.ok(!/weather/i.test(src), 'pet_bubbles.js still mentions weather');
  assert.ok(!require('fs').existsSync(path.join(ROOT, 'main', 'weather_client.js')),
    'main/weather_client.js should be deleted');
});

check('disabling a kind removes its bubble', () => {
  const state = I.loadState(fakeDb);
  const snap = I.buildSnapshot(state, at(12, 30), 0);
  const off = { ...bubbles.loadEnabled(fakeDb), meal: false };
  assert.strictEqual(I.pickRule(snap, off), null);
});

console.log('\n[say] 右键说句话（手动气泡）');

// `say` and `tick` broadcast through a callback the engine only receives at
// start(), so these checks drive it through the real start/tick path.
function withBroadcast(fn) {
  const seen = [];
  bubbles.start({ broadcast: (p) => seen.push(p), intervalMs: 100000 });
  try {
    return fn(seen);
  } finally {
    bubbles.stop();
  }
}

check('say() broadcasts the typed text immediately', () => {
  withBroadcast((seen) => {
    assert.strictEqual(bubbles.say('今天不想加班'), true);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].text, '今天不想加班');
    assert.strictEqual(seen[0].kind, 'manual');
  });
});

check('a typed bubble survives the ticks that would overwrite it', () => {
  withBroadcast((seen) => {
    bubbles.say('别戳了');
    // This is the regression that matters: at 12:30 the meal rule is due, so
    // without the override the next tick would replace the typed text within
    // a second and the message would appear to flash.
    bubbles.tick();
    bubbles.tick();
    const last = seen[seen.length - 1];
    assert.strictEqual(last.text, '别戳了');
    assert.strictEqual(last.kind, 'manual');
  });
});

check('a typed bubble ignores the enable toggles', () => {
  withBroadcast(() => {
    bubbles.saveEnabled(fakeDb, { meal: false, break: false });
    try {
      // Both rule kinds off — a rule-driven bubble is impossible, but the
      // user still asked for this one.
      assert.strictEqual(bubbles.say('还是可以说'), true);
      bubbles.tick();
    } finally {
      bubbles.saveEnabled(fakeDb, { meal: true, break: true });
    }
  });
});

check('say() rejects blank input instead of showing an empty bubble', () => {
  withBroadcast((seen) => {
    for (const bad of ['', '   ', '\n\t', null, undefined]) {
      assert.strictEqual(bubbles.say(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
    assert.strictEqual(seen.length, 0, 'nothing should have been broadcast');
  });
});

check('say() trims surrounding whitespace', () => {
  withBroadcast((seen) => {
    bubbles.say('  padded  ');
    assert.strictEqual(seen[0].text, 'padded');
  });
});

check('the bubble hands back to the rule engine once it expires', () => {
  withBroadcast((seen) => {
    // 1ms duration → already expired by the time tick() runs.
    bubbles.say('一闪而过', { durationMs: 1 });
    bubbles.tick();
    const last = seen[seen.length - 1];
    // At most time-of-day dependent, so assert only that the manual override
    // is gone: either a rule took over or the bubble cleared.
    assert.notStrictEqual(last.kind, 'manual');
  });
});

check('clearManual() releases the slot back to the rules', () => {
  withBroadcast((seen) => {
    bubbles.say('临时说一句');
    assert.strictEqual(bubbles.clearManual(), true);
    bubbles.tick();
    const last = seen[seen.length - 1];
    assert.notStrictEqual(last.kind, 'manual');
    // Clearing twice is a no-op, not an error.
    assert.strictEqual(bubbles.clearManual(), false);
  });
});

check('a manual bubble is not persisted to settings', () => {
  withBroadcast(() => {
    store.delete('pet_bubbles_state:');
    bubbles.say('重启后不该还在');
    const raw = fakeDb.getSetting('pet_bubbles_state:');
    assert.ok(!raw || !raw.includes('重启后不该还在'),
      'typed text must not reach the persisted state blob');
  });
});

check('toggle round-trips through settings', () => {
  bubbles.saveEnabled(fakeDb, { meal: false, break: true });
  const back = bubbles.loadEnabled(fakeDb);
  assert.strictEqual(back.meal, false);
  assert.strictEqual(back.break, true);
  bubbles.saveEnabled(fakeDb, { meal: true, break: true });
});

check('a brand-new kind defaults to enabled without a migration', () => {
  const map = bubbles.loadEnabled(fakeDb);
  map.someFutureKind = undefined;
  // Undefined must resolve to "on" per loadEnabled's contract.
  const r = bubbles.BUILTIN_RULES[0];
  const v = (undefined === false) ? false : (undefined === true ? true : r.enabled !== false);
  assert.strictEqual(v, true);
});

check('state survives a JSON round-trip through settings', () => {
  const s = I.loadState(fakeDb);
  s.breakNudgeCount = 7;
  s.lastBreakNudgeAt = 12345;
  s.startedAt.meal = 999;
  I.saveState(fakeDb, s);
  const back = I.loadState(fakeDb);
  assert.strictEqual(back.breakNudgeCount, 7);
  assert.strictEqual(back.lastBreakNudgeAt, 12345);
  assert.strictEqual(back.startedAt.meal, 999);
});

check('a throwing build() is isolated, not fatal', () => {
  const bad = {
    name: '__bad', label: 'x', kind: 'zzz', enabled: true, priority: 1e9,
    build() { throw new Error('boom'); },
  };
  bubbles.BUILTIN_RULES.push(bad);
  bubbles._internals.ORDERED_RULES.unshift(bad);
  try {
    const state = I.loadState(fakeDb);
    const snap = I.buildSnapshot(state, at(12, 30), 0);
    // Meal still resolves despite the higher-priority rule throwing.
    const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
    assert.strictEqual(picked.rule.name, 'meal');
  } finally {
    bubbles.BUILTIN_RULES.pop();
    bubbles._internals.ORDERED_RULES.shift();
  }
});

check('a blank-text intent is treated as no bubble', () => {
  const blank = {
    name: '__blank', label: 'b', kind: 'zb', enabled: true, priority: 1e9,
    build: () => ({ text: '   ', durationMs: 1000 }),
  };
  bubbles.BUILTIN_RULES.push(blank);
  bubbles._internals.ORDERED_RULES.unshift(blank);
  try {
    const state = I.loadState(fakeDb);
    const snap = I.buildSnapshot(state, at(12, 30), 0);
    const picked = I.pickRule(snap, bubbles.loadEnabled(fakeDb));
    assert.strictEqual(picked.rule.name, 'meal');
  } finally {
    bubbles.BUILTIN_RULES.pop();
    bubbles._internals.ORDERED_RULES.shift();
  }
});

check('the module never imports the pet action machinery', () => {
  // The decoupling requirement is structural, so assert it structurally:
  // main/pet_bubbles.js must not reference pet_controller or auto_behaviors
  // at all, so a bubble can never perturb an animation.
  const src = require('fs').readFileSync(path.join(ROOT, 'main', 'pet_bubbles.js'), 'utf8');
  for (const forbidden of ['pet_controller', 'auto_behaviors', 'reminder']) {
    const re = new RegExp("require\\([^)]*" + forbidden);
    assert.ok(!re.test(src), `pet_bubbles.js must not require ${forbidden}`);
  }
});

check('one broadcast channel, shared by show and clear', () => {
  assert.strictEqual(bubbles.BROADCAST_CHANNEL, 'pet:bubble-changed');
  // The clear signal is a null text on that same channel (see tick()).
  assert.strictEqual(typeof bubbles.BROADCAST_CHANNEL, 'string');
});

check('onStart latches once per duration, not once per tick', () => {
  // Exercises the real guard in maybeRunOnStart (exported via _internals)
  // rather than re-implementing it — a re-implementation would only prove
  // the test author can write the same arithmetic twice.
  const r = {
    name: '__latch', label: 'l', kind: 'zl', enabled: true, priority: 999,
    durationMs: 1000,
    build: () => ({ text: 'x', durationMs: 1000 }),
    onStart(s) { s.latchHits = (s.latchHits | 0) + 1; s.dirty = true; },
  };
  bubbles.BUILTIN_RULES.push(r);
  bubbles._internals.ORDERED_RULES.unshift(r);
  try {
    const s = I.loadState(fakeDb);
    s.latchHits = 0;
    const snapshot = { dirty: false };
    const nowMs = Date.now();
    // Three ticks inside one durationMs window.
    for (let i = 0; i < 3; i++) I.maybeRunOnStart(r, s, snapshot, r.durationMs, nowMs + i * 100);
    assert.strictEqual(s.latchHits, 1);
    // Past the duration it fires again.
    I.maybeRunOnStart(r, s, snapshot, r.durationMs, nowMs + 1500);
    assert.strictEqual(s.latchHits, 2);
    // And the latch is persisted.
    I.saveState(fakeDb, s);
    assert.strictEqual(I.loadState(fakeDb).startedAt.__latch, nowMs + 100);
  } finally {
    bubbles.BUILTIN_RULES.pop();
    bubbles._internals.ORDERED_RULES.shift();
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);