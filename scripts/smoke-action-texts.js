#!/usr/bin/env node
// scripts/smoke-action-texts.js — behavioural checks for
// main/pet_action_texts.js (动作 → 文本绑定).
//
// Covers the three properties the feature actually promises:
//   1. an action with no bound text never speaks;
//   2. an action with N bound texts picks one of them at random;
//   3. "不展示文本" is always a candidate, so a bound action still goes
//      silent some of the time;
//   4. the 吃饭提醒 / 休息提醒 line is plugged into `default` for exactly
//      as long as that bubble is up (动态插拔).
//
// Usage: node scripts/smoke-action-texts.js

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const store = new Map();
const fakeDb = {
  get: () => ({}),
  getSetting(k) { return store.has(k) ? store.get(k) : null; },
  setSetting(k, v) { store.set(k, String(v)); },
};

const texts = require(path.join(ROOT, 'main', 'pet_action_texts.js'));

let passed = 0;
function check(name, fn) {
  texts.clearRuntime();
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

console.log('\n[defaults] 默认不绑定任何文本');

check('an unbound action is always silent', () => {
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(texts.pickText('default', {}), null);
  }
});

check('an unknown action is silent even when other actions are bound', () => {
  const saved = { default: ['你好'] };
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(texts.pickText('sleep', saved), null);
  }
});

check('an empty pool collapses to exactly one candidate', () => {
  assert.deepStrictEqual(texts.candidatesFor('nothing', {}), [null]);
});

console.log('\n[pick] 随机选择');

check('a bound action draws from its lines', () => {
  const saved = { dance: ['跳的真好看', '再来一个'] };
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(texts.pickText('dance', saved));
  // Both lines show up across a few hundred draws, and silence does too
  // (2 lines + 1 silent candidate ⇒ ~1/3 of draws are silent).
  assert.ok(seen.has('跳的真好看'), 'expected the first line to be picked at least once');
  assert.ok(seen.has('再来一个'), 'expected the second line to be picked at least once');
  assert.ok(seen.has(null), '"不展示文本" must remain a possible outcome');
});

check('all three candidates are equally likely', () => {
  // Pin the sampler so the arithmetic is exact rather than statistical.
  const saved = { pet: ['a', 'b'] };
  const pool = texts.candidatesFor('pet', saved);
  assert.strictEqual(pool.length, 3, '2 lines + the silent option');
  assert.strictEqual(texts.pickText('pet', saved, () => 0), 'a');
  assert.strictEqual(texts.pickText('pet', saved, () => 0.4), 'b');
  assert.strictEqual(texts.pickText('pet', saved, () => 0.9), null);
});

check('an out-of-range sample clamps to the last candidate', () => {
  const saved = { pet: ['a'] };
  assert.strictEqual(texts.pickText('pet', saved, () => 0.999999), null);
  assert.strictEqual(texts.pickText('pet', saved, () => -1), 'a');
});

console.log('\n[config] 读写与清洗');

check('texts round-trip through the settings table', () => {
  texts.saveConfig(fakeDb, 'vup', { texts: { default: ['嗨'], dance: ['转圈圈', '真棒'] } });
  const back = texts.loadConfig(fakeDb, 'vup');
  assert.deepStrictEqual(back.texts.default, ['嗨']);
  assert.deepStrictEqual(back.texts.dance, ['转圈圈', '真棒']);
});

check('configs are per-pet', () => {
  texts.saveConfig(fakeDb, 'vup', { texts: { default: ['A'] } });
  texts.saveConfig(fakeDb, 'other', { texts: { default: ['B'] } });
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'vup').texts.default, ['A']);
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'other').texts.default, ['B']);
});

check('blank lines, non-strings and duplicates are dropped', () => {
  const clean = texts.normalizeTexts({
    dance: ['  a  ', 'a', '', '   ', 42, null, 'b'],
    '': ['orphan'],
  });
  assert.deepStrictEqual(clean, { dance: ['a', 'b'] });
});

check('a list that empties out loses its key entirely', () => {
  const clean = texts.normalizeTexts({ dance: ['', '  '] });
  assert.deepStrictEqual(clean, {}, 'an all-blank list must not persist as []');
});

check('a corrupt row degrades to "no bindings"', () => {
  fakeDb.setSetting('pet_action_texts:broken', '{not json');
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'broken').texts, {});
});

check('a missing pet id yields an empty config', () => {
  assert.deepStrictEqual(texts.loadConfig(fakeDb, null).texts, {});
  assert.strictEqual(texts.saveConfig(fakeDb, null, { texts: { a: ['x'] } }), false);
});

console.log('\n[cache] 读缓存');

check('save is visible to the next read without an explicit invalidate', () => {
  texts.invalidate();
  texts.saveConfig(fakeDb, 'cached', { texts: { default: ['第一版'] } });
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'cached').texts.default, ['第一版']);
  // Second save over the first — the cache must not serve the stale value.
  texts.saveConfig(fakeDb, 'cached', { texts: { default: ['第二版'] } });
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'cached').texts.default, ['第二版']);
});

check('invalidate() picks up a row written behind the cache\'s back', () => {
  // This is the backup-restore path: the DB file is swapped wholesale, so
  // the memoised blob is from the *previous* database. This is the
  // regression that would otherwise make the pet keep saying text the
  // user deleted before the import.
  texts.invalidate();
  texts.saveConfig(fakeDb, 'restored', { texts: { default: ['旧的'] } });
  texts.loadConfig(fakeDb, 'restored');           // warm the cache
  fakeDb.setSetting('pet_action_texts:restored', JSON.stringify({ texts: { default: ['新的'] } }));
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'restored').texts.default, ['旧的'],
    'pre-invalidate read is expected to be stale — that is why invalidate exists');
  texts.invalidate('restored');
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'restored').texts.default, ['新的'],
    'invalidate must drop the memoised blob');
});

check('invalidate() with no id clears every pet', () => {
  texts.saveConfig(fakeDb, 'p1', { texts: { default: ['1'] } });
  texts.saveConfig(fakeDb, 'p2', { texts: { default: ['2'] } });
  fakeDb.setSetting('pet_action_texts:p1', JSON.stringify({ texts: { default: ['x1'] } }));
  fakeDb.setSetting('pet_action_texts:p2', JSON.stringify({ texts: { default: ['x2'] } }));
  texts.invalidate();
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'p1').texts.default, ['x1']);
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'p2').texts.default, ['x2']);
});

console.log('\n[动态插拔] 提醒文本动态插拔');

check('an enqueued line joins the pool it was plugged into', () => {
  texts.enqueueRuntime('default', '午饭：今天吃撒', 60_000);
  const saved = {};
  assert.ok(texts.pickText('default', saved, () => 0), 'the plugged line should be reachable');
  assert.deepStrictEqual(texts.listRuntime('default').map((r) => r.text), ['午饭：今天吃撒']);
});

check('a plugged line does NOT persist into the saved config', () => {
  texts.enqueueRuntime('default', '临时提醒', 60_000);
  texts.saveConfig(fakeDb, 'vup', { texts: { default: ['我自己的'] } });
  const stored = fakeDb.getSetting('pet_action_texts:vup');
  assert.ok(!stored.includes('临时提醒'), 'a rule line must never reach disk');
  assert.ok(stored.includes('我自己的'), "the user's own line must persist");
});

check('dequeuing removes it again (the bubble ended)', () => {
  texts.enqueueRuntime('default', '午饭：今天吃撒', 60_000);
  assert.strictEqual(texts.dequeueRuntime('default', '午饭：今天吃撒'), true);
  assert.deepStrictEqual(texts.listRuntime('default'), []);
  // With nothing bound and nothing plugged, the pet is silent again.
  assert.strictEqual(texts.pickText('default', {}), null);
});

check('dequeue is idempotent', () => {
  texts.enqueueRuntime('default', 'x', 60_000);
  assert.strictEqual(texts.dequeueRuntime('default', 'x'), true);
  assert.strictEqual(texts.dequeueRuntime('default', 'x'), false);
});

check('re-enqueueing the same line refreshes instead of duplicating', () => {
  texts.enqueueRuntime('default', '坐太久了', 60_000);
  assert.strictEqual(texts.enqueueRuntime('default', '坐太久了', 60_000), false);
  assert.strictEqual(texts.listRuntime('default').length, 1);
});

check('the same line on two actions stays independent', () => {
  texts.enqueueRuntime('default', '提醒', 60_000);
  texts.enqueueRuntime('dance', '提醒', 60_000);
  texts.dequeueRuntime('default', '提醒');
  assert.deepStrictEqual(texts.listRuntime('default'), []);
  assert.strictEqual(texts.listRuntime('dance').length, 1,
    'dequeuing one action must not yank the other');
});

check('blank enqueues are rejected', () => {
  assert.strictEqual(texts.enqueueRuntime('default', '', 60_000), false);
  assert.strictEqual(texts.enqueueRuntime('', 'x', 60_000), false);
  assert.strictEqual(texts.enqueueRuntime(null, null, 60_000), false);
  assert.deepStrictEqual(texts.listRuntime(), []);
});

check('an expired entry is pruned on read', () => {
  // -1ms ttl ⇒ already expired. Uses the real clock rather than a fake so
  // the test can't drift if the implementation ever caches Date.now().
  texts.enqueueRuntime('default', '过期', -1);
  assert.deepStrictEqual(texts.listRuntime('default'), []);
});

check('runtime lines are listed ahead of the user\'s own', () => {
  texts.enqueueRuntime('default', '插播', 60_000);
  const pool = texts.candidatesFor('default', { default: ['自绑'] });
  assert.deepStrictEqual(pool, ['插播', '自绑', null]);
});

console.log('\n[rows] 设置页行数据');

check('rows cover the pet\'s own variants plus saved orphans', () => {
  texts.saveConfig(fakeDb, 'vup', { texts: { dancing: ['转圈圈'] } });
  const rows = texts.describeActions(fakeDb, 'vup', { variants: ['default', 'walking'] });
  const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
  assert.strictEqual(byAction.default.label, 'default', 'a variant shows its raw key');
  assert.strictEqual(byAction.walking.group, 'variant');
  assert.deepStrictEqual(byAction.dancing.texts, ['转圈圈'], 'a saved action keeps its row');
});

check('user interactions get no row', () => {
  // 单击桌宠 / 右击菜单 · 喂食 are things the USER does, not things the pet
  // performs, so they must never show up as bindable actions — even if a
  // caller hands their ids over (which is the regression this guards: the
  // settings card used to render exactly these rows).
  texts.saveConfig(fakeDb, 'vup', { texts: { default: ['嗨'] } });
  const rows = texts.describeActions(fakeDb, 'vup', {
    variants: ['default'],
    triggers: [{ id: 'click', label: '单击桌宠' }],
    bindings: [{ id: 'feed', label: '右击菜单 · 喂食' }],
    labels: { click: '单击桌宠', feed: '右击菜单 · 喂食' },
  });
  const actions = rows.map((r) => r.action);
  assert.ok(!actions.includes('click'), '单击桌宠 must not be bindable');
  assert.ok(!actions.includes('feed'), '右击菜单 · 喂食 must not be bindable');
  assert.ok(rows.every((r) => r.group === 'variant'), 'every row is a pet variant');
});

check('an action is listed once even if it also has a saved binding', () => {
  texts.saveConfig(fakeDb, 'vup', { texts: { default: ['自绑'] } });
  const rows = texts.describeActions(fakeDb, 'vup', { variants: ['default'] });
  assert.strictEqual(rows.filter((r) => r.action === 'default').length, 1);
});

check('a binding for a variant this pet lacks still gets a row', () => {
  // The user bound text to `dancing` on a pet that HAS it, then switched to
  // one that doesn't. Dropping the row would silently lose their text.
  texts.saveConfig(fakeDb, 'vup', { texts: { dancing: ['转圈圈'] } });
  const rows = texts.describeActions(fakeDb, 'vup', { variants: ['default'] });
  const row = rows.find((r) => r.action === 'dancing');
  assert.ok(row, 'expected a row for the saved-but-absent action');
  assert.deepStrictEqual(row.texts, ['转圈圈']);
});

check('rows surface the currently plugged runtime lines', () => {
  texts.enqueueRuntime('default', '午饭：今天吃撒', 60_000);
  const rows = texts.describeActions(fakeDb, 'vup', { variants: ['default'] });
  const row = rows.find((r) => r.action === 'default');
  assert.deepStrictEqual(row.runtime.map((r) => r.text), ['午饭：今天吃撒']);
});

check('runtime entries are scoped per action', () => {
  texts.enqueueRuntime('default', 'a', 60_000);
  texts.enqueueRuntime('dance', 'b', 60_000);
  assert.deepStrictEqual(texts.listRuntime('dance').map((r) => r.text), ['b']);
  assert.deepStrictEqual(texts.listRuntime('default').map((r) => r.text), ['a']);
});

console.log('\n[文本框] 每个动作的文本框选择');

check('boxes round-trip alongside texts', () => {
  texts.saveConfig(fakeDb, 'boxy', { texts: { dance: ['a'] }, boxes: { dance: '3' } });
  const back = texts.loadConfig(fakeDb, 'boxy');
  assert.deepStrictEqual(back.texts.dance, ['a'], 'lines survive');
  assert.deepStrictEqual(back.boxes, { dance: '3' }, 'box survives');
});

check('an empty box choice is dropped, not stored as ""', () => {
  // "默认" and "never set" must be the same state, so a box map never carries
  // a blank value the picker would have to special-case.
  texts.saveConfig(fakeDb, 'emptybox', { texts: {}, boxes: { dance: '', other: '   ' } });
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'emptybox').boxes, {});
});

check('box ids are trimmed and non-strings rejected', () => {
  assert.deepStrictEqual(texts.normalizeBoxes({ a: '  3  ', b: 42, c: null, d: '  ' }), { a: '3' });
});

check('a box survives for a variant the current pet lacks', () => {
  // Same promise as for lines: the choice was made on a machine that had the
  // PNG, so switching pets must not silently drop it.
  texts.saveConfig(fakeDb, 'switcher', { texts: {}, boxes: { dancing: '5' } });
  const rows = texts.describeActions(fakeDb, 'switcher', { variants: ['default'] });
  assert.strictEqual(rows.find((r) => r.action === 'dancing').box, '5');
});

check('an action with a box but no lines still gets a row', () => {
  // Otherwise the box would be unreachable from the UI — set only by
  // hand-editing the DB.
  texts.saveConfig(fakeDb, 'boxonly', { texts: {}, boxes: { solo: '2' } });
  const rows = texts.describeActions(fakeDb, 'boxonly', { variants: ['default'] });
  const row = rows.find((r) => r.action === 'solo');
  assert.ok(row, 'expected a row for a box-only action');
  assert.strictEqual(row.box, '2');
});

check('every row carries a box string, defaulting to ""', () => {
  texts.saveConfig(fakeDb, 'norowbox', { texts: { default: ['x'] } });
  const rows = texts.describeActions(fakeDb, 'norowbox', { variants: ['default', 'walking'] });
  assert.ok(rows.every((r) => typeof r.box === 'string'),
    'the UI binds a <select> straight to this, so it must never be undefined');
  assert.strictEqual(rows.find((r) => r.action === 'walking').box, '');
});

check('a corrupt row degrades to no boxes', () => {
  fakeDb.setSetting('pet_action_texts:boxbroken', '{not json');
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'boxbroken').boxes, {});
});

check('the box map is per-pet', () => {
  texts.saveConfig(fakeDb, 'bp1', { texts: {}, boxes: { default: '1' } });
  texts.saveConfig(fakeDb, 'bp2', { texts: {}, boxes: { default: '2' } });
  assert.strictEqual(texts.loadConfig(fakeDb, 'bp1').boxes.default, '1');
  assert.strictEqual(texts.loadConfig(fakeDb, 'bp2').boxes.default, '2');
});

check('an invalid config object yields empty boxes', () => {
  texts.saveConfig(fakeDb, 'nope', null);
  assert.deepStrictEqual(texts.loadConfig(fakeDb, 'nope').boxes, {});
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);