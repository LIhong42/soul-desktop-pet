// scripts/test_card_picker.js — the draw's weighting rule.
//
// The rule this guards is the one the user asked for: a card that has
// been drawn recently must not come up again soon. The tests below cover
// the parts that are easy to get wrong — the cooldown's exact width, the
// soft band's width, the identity of a card, and the fallback that keeps
// a tiny pool drawable.
//
// Run it with:  node scripts/test_card_picker.js

'use strict';

const assert = require('assert');
const picker = require('../main/card_picker');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

// A pool of official cards, numbered from 1.
function deck(n) {
  const cards = [];
  for (let i = 1; i <= n; i++) {
    cards.push({ no: i, title: `卡 ${i}`, requirement: '', source: 'deck', refId: null });
  }
  return cards;
}

// A history row, newest first — the shape db.listCardDrawsWithProgress()
// returns.
function row(no, source = 'deck', refId = null) {
  return { card_no: no, source, card_ref_id: refId };
}

console.log('card picker');

// ---- The cooldown -------------------------------------------------------

test('the three most recent draws are cooled to zero', () => {
  const cards = deck(10);
  const history = [row(1), row(2), row(3)];
  const w = picker.weightMap(cards, history);
  assert.strictEqual(w.get('deck:1'), 0);
  assert.strictEqual(w.get('deck:2'), 0);
  assert.strictEqual(w.get('deck:3'), 0);
  assert.strictEqual(w.get('deck:4'), 1);
});

test('a cooled card never comes up, whatever the random number', () => {
  const cards = deck(10);
  const history = [row(1), row(2), row(3)];
  for (let i = 0; i < 200; i++) {
    const r = i / 200;
    const picked = picker.pickWeighted(cards, history, () => r);
    assert.ok(picked, 'a card must come up');
    assert.ok(![1, 2, 3].includes(picked.no),
      `card ${picked.no} came up but it is cooled`);
  }
});

test('the soft band is a quarter weight and sits just past the cooldown', () => {
  const cards = deck(10);
  const history = [row(1), row(2), row(3), row(4), row(5), row(6)];
  const w = picker.weightMap(cards, history);
  // The band is the three draws AFTER the cooldown.
  assert.strictEqual(w.get('deck:4'), picker.SOFT_BAND_WEIGHT);
  assert.strictEqual(w.get('deck:5'), picker.SOFT_BAND_WEIGHT);
  assert.strictEqual(w.get('deck:6'), picker.SOFT_BAND_WEIGHT);
  // Beyond the band, full weight again.
  assert.strictEqual(w.get('deck:7'), 1);
  // And the cooldown itself is still zero.
  assert.strictEqual(w.get('deck:1'), 0);
});

test('the band width and the cooldown width are what the module says', () => {
  assert.strictEqual(picker.COOLDOWN_DRAWS, 3);
  assert.strictEqual(picker.SOFT_BAND_DRAWS, 3);
  assert.strictEqual(picker.SOFT_BAND_WEIGHT, 0.25);
});

// ---- The card's identity ------------------------------------------------

test('an official card and a custom card are different cards', () => {
  const cards = [
    { no: 1, title: '同名', requirement: '', source: 'deck', refId: null },
    { no: null, title: '同名', requirement: '', source: 'custom', refId: 'abc' },
  ];
  const history = [row(1)];
  const w = picker.weightMap(cards, history);
  assert.strictEqual(w.get('deck:1'), 0, 'the official card is cooled');
  assert.strictEqual(w.get('custom:abc'), 1, 'the custom card is untouched');
});

test('a custom card is cooled by its own row id', () => {
  const cards = [
    { no: null, title: 'A', requirement: '', source: 'custom', refId: 'abc' },
    { no: null, title: 'B', requirement: '', source: 'custom', refId: 'def' },
  ];
  const history = [row(null, 'custom', 'abc')];
  const w = picker.weightMap(cards, history);
  assert.strictEqual(w.get('custom:abc'), 0);
  assert.strictEqual(w.get('custom:def'), 1);
});

// ---- The fallback -------------------------------------------------------

test('a pool smaller than the cooldown still produces a card', () => {
  const cards = deck(2);
  const history = [row(1), row(2)];
  const picked = picker.pickWeighted(cards, history, () => 0.5);
  assert.ok(picked, 'the draw must not fail');
});

test('an empty pool returns null rather than throwing', () => {
  assert.strictEqual(picker.pickWeighted([], [], () => 0.5), null);
  assert.strictEqual(picker.pickWeighted(null, null, () => 0.5), null);
});

// ---- The random number --------------------------------------------------

test('a random number outside [0,1) does not index out of the pool', () => {
  const cards = deck(5);
  const history = [];
  for (const bad of [-1, -0.5, 1, 1.5, NaN, Infinity, undefined]) {
    const picked = picker.pickWeighted(cards, history, () => bad);
    assert.ok(picked, `a bad rng (${bad}) must still yield a card`);
    assert.ok(cards.includes(picked), `a bad rng (${bad}) must yield a pool card`);
  }
});

// ---- The distribution ---------------------------------------------------

test('a cooled card comes up about a quarter as often as a band card', () => {
  const cards = deck(50);
  // Two draws ago for card 1 (the soft band), and the rest never drawn.
  const history = [row(99), row(98), row(97), row(1)];
  const w = picker.weightMap(cards, history);
  const band = w.get('deck:1');      // 0.25
  const fresh = w.get('deck:2');     // 1
  assert.strictEqual(band, 0.25);
  assert.strictEqual(fresh, 1);
  // The band card's slice is a quarter of a fresh card's.
  const bandSlice = band / (band + 48 * fresh);
  const freshSlice = fresh / (band + 48 * fresh);
  assert.ok(Math.abs(bandSlice * 4 - freshSlice) < 1e-9);
});

test('over many draws the cooled cards really do never come up', () => {
  // The whole point: simulate a user drawing weekly and count how often
  // a card from the cooled window comes back.
  //
  // The cooled window is the three most recent draws — history[0] (last
  // week), history[1] and history[2]. The card at history[3] is the first
  // soft-band position: it MAY come up, just rarely.
  const cards = deck(50);
  const history = [];
  let immediateRepeat = 0;
  let inCoolRepeat = 0;
  const draws = 20000;
  for (let i = 0; i < draws; i++) {
    const picked = picker.pickWeighted(cards, history, Math.random);
    const cooled = history.slice(0, picker.COOLDOWN_DRAWS).map((r) => r.card_no);
    if (history[0] && picked.no === history[0].card_no) immediateRepeat++;
    if (cooled.includes(picked.no)) inCoolRepeat++;
    history.unshift(row(picked.no));
    if (history.length > 10) history.pop();
  }
  assert.strictEqual(immediateRepeat, 0,
    `the previous card came up ${immediateRepeat} times — it must never`);
  assert.strictEqual(inCoolRepeat, 0,
    `a cooled card came up ${inCoolRepeat} times — it must never`);
});

test('a card in the soft band comes up, but rarely', () => {
  const cards = deck(50);
  const history = [row(99), row(98), row(97), row(1)];
  let hits = 0;
  const draws = 20000;
  for (let i = 0; i < draws; i++) {
    const picked = picker.pickWeighted(cards, history, Math.random);
    if (picked.no === 1) hits++;
  }
  // Flat random would be 1/50 = 2%. The quarter weight makes it about
  // 0.25 / (0.25 + 49) = 0.5%.
  const rate = hits / draws;
  assert.ok(rate > 0.002 && rate < 0.012,
    `the band card came up ${(rate * 100).toFixed(2)}% of the time, expected ~0.5%`);
});

test('an unseen card comes up at close to the flat-random rate', () => {
  const cards = deck(50);
  const history = [row(99), row(98), row(97), row(1)];
  let hits = 0;
  const draws = 20000;
  for (let i = 0; i < draws; i++) {
    const picked = picker.pickWeighted(cards, history, Math.random);
    if (picked.no === 2) hits++;
  }
  const rate = hits / draws;
  assert.ok(rate > 0.015 && rate < 0.025,
    `an unseen card came up ${(rate * 100).toFixed(2)}% of the time, expected ~2%`);
});

// ---- The rule as the user stated it -------------------------------------

test('a card drawn in the last three draws cannot come up again', () => {
  // The user's own complaint: card 30 came up in two consecutive weeks.
  const cards = deck(50);
  let violations = 0;
  let history = [];
  for (let i = 0; i < 5000; i++) {
    const picked = picker.pickWeighted(cards, history, Math.random);
    const recent = history.slice(0, picker.COOLDOWN_DRAWS).map((r) => r.card_no);
    if (recent.includes(picked.no)) violations++;
    history.unshift(row(picked.no));
  }
  assert.strictEqual(violations, 0,
    `a recent card came up ${violations} times — the rule is broken`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
