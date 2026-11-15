// main/card_picker.js — which card a draw may come up.
//
// The original draw was a flat `Math.random()` over the whole pool: every
// card — one drawn last week, one drawn three years ago, one never drawn at
// all — carried exactly the same weight. With a 50-card deck that makes a
// repeat within ten draws a 62% certainty, and the repeat lands on a card
// the user has just written up.
//
// This module replaces that with a WEIGHTED draw:
//
//   * the three most recently drawn cards are COOLED — weight zero, they
//     cannot come up again;
//   * the three before those carry a quarter of the weight, so a card can
//     come back eventually, just not soon;
//   * everything else is untouched.
//
// The distinction the user cares about is "recently", so the memory is
// measured in DRAWS, not days: the pool is drawn once a week, and a user
// who skips two weeks has not "re-done" a card.
//
// The cooling applies to every drawn card, finished or not. A card the
// user never wrote down is just as spent as one they finished — either
// way they have seen it, and putting it straight back in front of them
// is the thing this module exists to prevent.
//
// ---------------------------------------------------------------------------
// Why the weights are a cost, not a filter
// ---------------------------------------------------------------------------
// A hard filter ("never draw these three again") is the obvious version and
// it breaks on a small pool: with three cards drawn from a deck of three,
// the filter leaves nothing and the draw has to fail. The weights here
// instead make a cooled card merely unlikely, and `pickWeighted` falls back
// to the plain uniform draw when every weight has decayed to nothing. So
// the deck can be exhausted down to its last card without the draw ever
// breaking.
//
// The weights are also a gradient rather than a cliff, so the user cannot
// learn "cards 1-3 are banned, card 4 always comes up" and play around
// the rule — the decay is a soft signal, not a published schedule.

'use strict';

// How many of the most recent draws are cooled to zero.
//
// Three is the default because a card that comes back after two or three
// weeks feels like the deck is broken, while a card that comes back after
// a couple of months reads as the deck being large — which, with fifty
// cards, it is.
const COOLDOWN_DRAWS = 3;

// How many of the draws after the cooldown still carry a reduced weight,
// and what that weight is.
//
// The band is 3 wide and the weight is a quarter: a card in this band can
// come up, but it is four times less likely than a card nobody has seen.
const SOFT_BAND_DRAWS = 3;
const SOFT_BAND_WEIGHT = 0.25;

// The identity of a card, for the purpose of remembering it.
//
// A card is identified by where it came from AND which one it is:
// an official card by its number, a custom card by its row id. A deck card
// and a custom card that happen to share a title are different cards, and
// a custom card that has been deleted and re-added is a different card
// from the one the history refers to.
function cardKey(card) {
  if (!card) return '';
  if (card.source === 'custom') {
    return `custom:${card.refId == null ? '' : card.refId}`;
  }
  return `deck:${card.no == null ? '' : card.no}`;
}

// The key of a row from the `card_draws` table.
//
// The row carries `source` / `card_ref_id` / `card_no` in the same shape
// the pool's cards do, so the same function serves both sides.
function rowKey(row) {
  if (!row) return '';
  if (row.source === 'custom') {
    return `custom:${row.card_ref_id == null ? '' : row.card_ref_id}`;
  }
  return `deck:${row.card_no == null ? '' : row.card_no}`;
}

// The weight of a card, given the draws that came before it.
//
// `history` is the list of previous draws, NEWEST FIRST — the order
// `db.listCardDrawsWithProgress()` already returns.
//
// Returns a number: 0 for a cooled card, 0.25 for one in the soft band,
// 1 for everything else. A card that is not in the history at all has no
// entry, and the caller leaves its weight at 1.
function weightFor(cardKeyValue, history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = 0; i < list.length; i++) {
    if (rowKey(list[i]) !== cardKeyValue) continue;
    // Position 0 is the previous draw, position 1 the one before it, and
    // so on — so `i` is exactly "how many draws ago this was".
    if (i < COOLDOWN_DRAWS) return 0;
    if (i < COOLDOWN_DRAWS + SOFT_BAND_DRAWS) return SOFT_BAND_WEIGHT;
    return 1;
  }
  return 1;
}

// The weights of every card in the pool, as a map from card key to weight.
function weightMap(cards, history) {
  const map = new Map();
  for (const c of cards || []) {
    map.set(cardKey(c), weightFor(cardKey(c), history));
  }
  return map;
}

// Pick one card out of the pool, by weight.
//
// `rng` is injectable so the choice can be driven from a test. It returns
// a number in [0, 1), the way `Math.random` does.
//
// The draw is a single pass over the pool: the total weight is worked
// out, a point in it is chosen, and the card whose slice contains that
// point is the one that comes up. A card with weight zero occupies no
// slice at all, which is what makes the cooldown absolute.
//
// If every weight is zero — a pool smaller than the cooldown band — the
// uniform draw takes over, so a draw always produces a card.
function pickWeighted(cards, history, rng = Math.random) {
  const pool = Array.isArray(cards) ? cards : [];
  if (!pool.length) return null;

  const weights = weightMap(pool, history);
  let total = 0;
  for (const c of pool) total += weights.get(cardKey(c)) || 0;

  // Every card is cooled away. Rather than fail the draw, fall back to a
  // plain uniform pick: the deck is too small to honour the cooldown, and
  // a card is better than no card.
  if (!(total > 0)) {
    return pool[Math.floor(clamp01(rng()) * pool.length)];
  }

  let point = clamp01(rng()) * total;
  for (const c of pool) {
    const w = weights.get(cardKey(c)) || 0;
    if (!(w > 0)) continue;
    point -= w;
    if (point < 0) return c;
  }
  // Floating point can leave the point just above the total after the
  // last subtraction — the last card with a weight takes it.
  for (let i = pool.length - 1; i >= 0; i--) {
    const w = weights.get(cardKey(pool[i])) || 0;
    if (w > 0) return pool[i];
  }
  return pool[0];
}

// Keep a random number inside [0, 1).
//
// A test's rng, or a very unlucky Math.random, may hand back a number
// outside the range — and a negative one would index the pool from the
// end. Clamping keeps the draw total.
function clamp01(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n >= 1) return 0.999999999;
  return n;
}

module.exports = {
  COOLDOWN_DRAWS,
  SOFT_BAND_DRAWS,
  SOFT_BAND_WEIGHT,
  cardKey,
  rowKey,
  weightFor,
  weightMap,
  pickWeighted,
};
