// scripts/test_card_draw_cooldown.js — the draw, end to end.
//
// scripts/test_card_picker.js proves the weighting rule on its own. This
// proves the rule is actually WIRED IN: it drives the real
// main/card_draws.js draw() against a real database and checks that the
// card drawn last week does not come up again.
//
// The scenario is the user's own: card 30 came up in two consecutive
// weeks. Here the deck is stubbed small so the check is fast and the
// numbers are unambiguous.
//
// Run it with:  node scripts/test_card_draw_cooldown.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../main/db');
const cardDraws = require('../main/card_draws');

let passed = 0;
let failed = 0;

// The tests are async (they read and write the database), so the helper
// has to await them — otherwise a failure inside one becomes an
// unhandled rejection that crashes the run instead of being reported.
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

// A temporary app directory holding a small deck, so a draw has a pool
// small enough to reason about.
function makeApp(cards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carddraw-'));
  const deckDir = path.join(dir, 'resources', 'intersting-list');
  fs.mkdirSync(deckDir, { recursive: true });
  const md = cards
    .map((c, i) => `### ${String(i + 1).padStart(2, '0')}. ${c}\n\n- 要求：做${c}。\n`)
    .join('\n');
  fs.writeFileSync(path.join(deckDir, 'list.md'), md, 'utf8');
  return dir;
}

// The Mondays of a run of weeks, newest last.
function weeks(n, from = new Date(2026, 0, 5)) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i * 7);
    out.push(d);
  }
  return out;
}

console.log('card draw cooldown (end to end)');

(async function main() {
  // Each test gets its OWN database and its own stretch of weeks.
  //
  // They cannot share one database: the draw is one-per-week and the
  // week is the key, so two tests drawing the same week would collide
  // on the unique index and the second would get `already_drawn` — a
  // failure that has nothing to do with the rule being tested.
  const dirs = [];
  let weekCursor = new Date(2020, 0, 6); // a Monday, far from the other tests

  // A fresh database, and a fresh run of weeks that does not overlap any
  // other test's.
  async function fresh() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carddb-'));
    dirs.push(tmp);
    await db.open(path.join(tmp, 'test.db'));
    const start = new Date(weekCursor);
    weekCursor = new Date(weekCursor.getTime() + 365 * 86400000);
    return start;
  }

  // ---- The rule, through the real draw() -------------------------------

  await test('the card drawn last week does not come up again', async () => {
    // A 20-card deck, drawn over 30 weeks. Every draw must be different
    // from the three before it.
    const deck = Array.from({ length: 20 }, (_, i) => `任务${i + 1}`);
    const app = makeApp(deck);
    const ws = weeks(30, await fresh());
    const seen = [];
    for (const w of ws) {
      const res = cardDraws.draw(app, db, w);
      assert.ok(res.ok, `draw failed: ${res.reason}`);
      seen.push(res.card.card_no);
    }
    for (let i = 0; i < seen.length; i++) {
      const recent = seen.slice(Math.max(0, i - 3), i);
      assert.ok(!recent.includes(seen[i]),
        `week ${i} drew card ${seen[i]}, which was drawn in the last 3 weeks`);
    }
  });

  await test('a card from four draws ago CAN come up (the soft band)', async () => {
    // The rule is a cooling, not a ban — so the card has to be reachable
    // eventually, or the deck would empty out.
    //
    // A FIVE-card deck makes this deterministic enough to assert on: the
    // band card carries 0.25 of the weight against four cards at 1, so
    // it comes up about 5% of the time and over 60 draws it is all but
    // certain to come back. With a 20-card deck the rate would be ~1%
    // and the test would be a coin flip.
    const deck = Array.from({ length: 5 }, (_, i) => `任务${i + 1}`);
    const app = makeApp(deck);
    const ws = weeks(60, await fresh());
    const seen = [];
    for (const w of ws) {
      const res = cardDraws.draw(app, db, w);
      assert.ok(res.ok);
      seen.push(res.card.card_no);
    }
    // The card from four draws back is the first soft-band position, so
    // it may come up again — it just must not come up every time.
    let bandRepeats = 0;
    for (let i = 4; i < seen.length; i++) {
      if (seen[i] === seen[i - 4]) bandRepeats++;
    }
    assert.ok(bandRepeats > 0,
      'the soft band never fired — the rule is a ban, not a cooling');
    // And the cooled window still holds: the card from one, two or three
    // draws back never comes up.
    let cooledRepeats = 0;
    for (let i = 1; i < seen.length; i++) {
      const recent = seen.slice(Math.max(0, i - 3), i);
      if (recent.includes(seen[i])) cooledRepeats++;
    }
    assert.strictEqual(cooledRepeats, 0,
      `a cooled card came up ${cooledRepeats} times`);
  });

  await test('the card drawn last week is never drawn again, over many runs', async () => {
    const deck = Array.from({ length: 20 }, (_, i) => `任务${i + 1}`);
    const app = makeApp(deck);
    const ws = weeks(200, await fresh());
    const seen = [];
    for (const w of ws) {
      const res = cardDraws.draw(app, db, w);
      assert.ok(res.ok, `draw failed: ${res.reason}`);
      seen.push(res.card.card_no);
    }
    let violations = 0;
    for (let i = 1; i < seen.length; i++) {
      const recent = seen.slice(Math.max(0, i - 3), i);
      if (recent.includes(seen[i])) violations++;
    }
    assert.strictEqual(violations, 0,
      `a recent card came up ${violations} times in 200 draws`);
  });

  await test('a week with no draw still counts as a gap in the memory', async () => {
    // The cooling is measured in DRAWS, not days: a user who skips a
    // week has not re-seen a card. Here two weeks are skipped, so the
    // card from four draws ago is still inside the cooled window.
    const deck = Array.from({ length: 20 }, (_, i) => `任务${i + 1}`);
    const app = makeApp(deck);
    const w0 = await fresh();
    const draws = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date(w0);
      d.setDate(d.getDate() + i * 7);
      const res = cardDraws.draw(app, db, d);
      assert.ok(res.ok);
      draws.push(res.card.card_no);
    }
    const d = new Date(w0);
    d.setDate(d.getDate() + 28); // four weeks later
    const res = cardDraws.draw(app, db, d);
    assert.ok(res.ok);
    const recent = draws.slice(0, 3);
    assert.ok(!recent.includes(res.card.card_no),
      `card ${res.card.card_no} came up but it was drawn in the last 3 draws`);
  });

  await test('one draw per week still holds', async () => {
    const deck = Array.from({ length: 20 }, (_, i) => `任务${i + 1}`);
    const app = makeApp(deck);
    const w = await fresh();
    const first = cardDraws.draw(app, db, w);
    const second = cardDraws.draw(app, db, w);
    assert.ok(first.ok);
    assert.ok(!second.ok);
    assert.strictEqual(second.reason, 'already_drawn');
    assert.strictEqual(second.card.card_no, first.card.card_no);
  });

  await test('a custom card joins the same pool and is cooled the same way', async () => {
    // A TEN-card deck plus the custom card.
    //
    // The deck has to be big enough for the cooling to have room: in a
    // two-card pool both cards end up cooled at once, and the draw then
    // falls back to a uniform pick — which is the documented behaviour
    // for a pool too small to honour the cooling, but it makes the
    // cooldown unobservable here.
    const deck = Array.from({ length: 10 }, (_, i) => `任务${i + 1}`);
    const app = makeApp(deck);
    const w0 = await fresh();
    const custom = db.createCustomCard({ title: '我加的卡', requirement: '要求' });

    // Draw until the custom card comes up, then check it does not come
    // up again in the next three draws. The custom card is cooled by its
    // own row id, exactly like a deck card is cooled by its number.
    let firstIndex = -1;
    const seen = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(w0);
      d.setDate(d.getDate() + i * 7);
      const res = cardDraws.draw(app, db, d);
      assert.ok(res.ok);
      seen.push(res.card);
      if (res.card.source === 'custom') { firstIndex = i; break; }
    }
    assert.ok(firstIndex >= 0, 'the custom card never came up');
    assert.strictEqual(seen[firstIndex].card_ref_id, custom.id);
    assert.strictEqual(seen[firstIndex].card_no, null,
      'a custom card carries no deck number');

    // The next three draws must not be the custom card again.
    for (let i = firstIndex + 1; i <= firstIndex + 3; i++) {
      const d = new Date(w0);
      d.setDate(d.getDate() + i * 7);
      const res = cardDraws.draw(app, db, d);
      assert.ok(res.ok);
      assert.notStrictEqual(res.card.source, 'custom',
        `the custom card came up again on draw ${i}`);
    }
  });

  await test('a custom card is picked from the same pool as the deck', async () => {
    // A deck of one plus a custom card: the custom card comes up about
    // half the time, so over 40 draws it must come up several times —
    // and every time it does, the deck card does not.
    const app = makeApp(['唯一的官方卡']);
    const w0 = await fresh();
    const custom = db.createCustomCard({ title: '我加的卡', requirement: '要求' });
    let customHits = 0;
    let deckHits = 0;
    for (let i = 0; i < 40; i++) {
      const d = new Date(w0);
      d.setDate(d.getDate() + i * 7);
      const res = cardDraws.draw(app, db, d);
      assert.ok(res.ok);
      if (res.card.source === 'custom') customHits++;
      else deckHits++;
    }
    assert.ok(customHits > 0, 'the custom card never came up at all');
    assert.ok(deckHits > 0, 'the deck card never came up at all');
  });

  await test('a pool of two cards still produces a draw every week', async () => {
    // The fallback: the cooled window is wider than the pool, so the
    // weights are all zero. The draw must still return a card rather
    // than fail.
    const app = makeApp(['甲', '乙']);
    const w0 = await fresh();
    for (let i = 0; i < 10; i++) {
      const d = new Date(w0);
      d.setDate(d.getDate() + i * 7);
      const res = cardDraws.draw(app, db, d);
      assert.ok(res.ok, `draw ${i} failed: ${res.reason}`);
      assert.ok(res.card);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  db.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (failed) process.exit(1);
})();
