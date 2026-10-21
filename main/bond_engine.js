// main/bond_engine.js — Tier 1 + 2 of the pet intimacy system.
// Pure functions for the math, plus thin DB helpers (no I/O side effects
// beyond what's already in db.js).
//
//   • bond_strength        table: persistent pet affinity, value + tier (1..7)
//   • weekly_ritual        table: per-(pet, week) tallies of 10 dimensions
//
// Hardcoded tier thresholds + per-dim saturation caps live here so the
// formula has exactly one home and is testable in isolation.

const TIER_THRESHOLDS = [
  // value >= threshold  -> tier index+1
  // Sorted ascending; lower bound for tier 1 is always 0.
  { tier: 1, threshold: 0 },
  { tier: 2, threshold: 200 },
  { tier: 3, threshold: 600 },
  { tier: 4, threshold: 1500 },
  { tier: 5, threshold: 3500 },
  { tier: 6, threshold: 8000 },
  { tier: 7, threshold: 15000 },
];

const TIER_LABELS = {
  1: '陌生',
  2: '初识',
  3: '朋友',
  4: '挚友',
  5: '知己',
  6: '灵魂伴侣',
  7: '传说',
};

// (cap, weight) pairs. Caps prevent single-dimension inflation; weights
// pick what matters most for the user-visible "weekly progress" feeling.
const DIMENSION_FORMULA = [
  ['contact_reviewed',     20, 4],
  ['event_created',        10, 8],
  ['important_date_added',  5, 6],
  ['contact_added',         5, 5],
  ['contact_modified',     10, 2],
  ['avatar_uploaded',       3, 3],
  ['attribute_changed',     8, 2],
  ['memorial_recorded',     3, 10],
  ['reminder_completed',   30, 1],
  ['reminder_snoozed',     15, 0.3],
];

const WEEKLY_MAX = DIMENSION_FORMULA.reduce(
  (acc, [, cap, weight]) => acc + Math.min(cap, cap) * weight,
  0,
); // not used at runtime — keeps the saturation caps honest at read-time only.

// Returns the Monday-of-this-week date string in local time, YYYY-MM-DD.
function weekStart(d) {
  const now = d instanceof Date ? d : new Date();
  const dow = now.getDay();            // 0 (Sun) .. 6 (Sat)
  // Treat Monday as week start. Monday = 1.
  const diffToMon = (dow + 6) % 7;     // 0 if Monday, 6 if Sunday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMon);
  return fmtYMD(monday);
}

function fmtYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Per-dimension saturation: 0..1, capped.
function sat(v, cap) { return clamp(v, 0, cap) / cap; }

function computeWeeklyScore(row) {
  if (!row) return 0;
  let score = 0;
  for (const [k, cap, weight] of DIMENSION_FORMULA) {
    const v = parseInt(row[k], 10) || 0;
    score += sat(v, cap) * cap * weight;
  }
  // Allow over-saturated sums if a future dim adds more weight, but cap at 100.
  return clamp(Math.round(score), 0, 100);
}

function computeTier(value) {
  let t = 1;
  for (const { tier, threshold } of TIER_THRESHOLDS) {
    if (value >= threshold) t = tier;
  }
  return t;
}

function nextTierThreshold(value) {
  for (const { tier, threshold } of TIER_THRESHOLDS) {
    if (threshold > value) return { tier, threshold };
  }
  return null;
}

function tierLabel(tier) { return TIER_LABELS[tier] || TIER_LABELS[1]; }

// Returns integer bond-value delta for a settled week.
//   base       = sqrt(weekScore) * 10          (diminishing returns)
//   streak     = +5% per consecutive week (no upper cap)
//   skipDecay  = -40% if user missed 1 week; -60% total if missed >=2 weeks
function computeBondDelta(weeklyScore, streakWeeks, streakSkip) {
  const base = Math.sqrt(clamp(weeklyScore, 0, 100)) * 10;
  const streakBonus = 0.05 * Math.max(0, streakWeeks | 0);
  const skip = (streakSkip | 0);
  let dec = 0;
  if (skip >= 1) dec += 0.4;
  if (skip >= 2) dec += 0.2;  // total -0.6
  return Math.round(base * (1 + streakBonus) * (1 - dec));
}

// ---- DB-coupled helpers ----
// Each function takes a small db-shaped object { one, all, run, setSetting,
// getSetting, nowStr } so they're testable with a fake db in tests.

function ensureCurrentWeekRow(db, petId, nowStr) {
  const week = weekStart();
  const existing = db.one(
    'SELECT 1 FROM weekly_ritual WHERE pet_id = ? AND week_start = ?',
    [petId, week]
  );
  if (existing) return week;
  db.run(
    `INSERT INTO weekly_ritual(pet_id, week_start, last_touched_at)
     VALUES (?, ?, ?)`,
    [petId, week, nowStr()]
  );
  return week;
}

function incrementWeekDimension(db, petId, dim, by, nowStr) {
  const week = ensureCurrentWeekRow(db, petId, nowStr);
  // Whitelist protects against SQL injection via arbitrary dim key.
  const safeDim = DIMENSION_FORMULA.find(([k]) => k === dim);
  if (!safeDim) throw new Error(`unknown weekly dimension: ${dim}`);
  db.run(
    `UPDATE weekly_ritual
        SET ${safeDim[0]} = ${safeDim[0]} + ?, last_touched_at = ?
      WHERE pet_id = ? AND week_start = ?`,
    [by, nowStr(), petId, week]
  );
  // Mark "today we saw an event of certain types" flags so PetMood can
  // decide to show a "proud" bubble — these auto-decay at next weekly
  // rollover because we read them by petId only and the scheduler resets
  // them when the week flips.
  if (dim === 'event_created') {
    const cur = parseInt(db.getSetting(`today_event:${petId}`) || '0', 10) + by;
    db.setSetting(`today_event:${petId}`, String(cur));
  }
  if (dim === 'memorial_recorded') {
    db.setSetting(`today_memorial:${petId}`, '1');
  }
}

// Append a contact_id to the JSON list of "contacts reviewed this week".
// We cap the list length at 20 to keep the JSON tiny — dimensions are
// what's scored; the ids are only used for analytics in the /pets page
// later.
function logContactReviewed(db, petId, contactId, nowStr) {
  if (!petId || !contactId) return;
  const week = ensureCurrentWeekRow(db, petId, nowStr);
  const row = db.one(
    'SELECT reviewed_contacts FROM weekly_ritual WHERE pet_id = ? AND week_start = ?',
    [petId, week]
  );
  let list = [];
  try { list = JSON.parse(row?.reviewed_contacts || '[]'); } catch {}
  if (!Array.isArray(list)) list = [];
  if (list.includes(contactId)) return;
  list.push(contactId);
  if (list.length > 50) list = list.slice(-50);  // hard cap
  db.run(
    `UPDATE weekly_ritual
        SET reviewed_contacts = ?, last_touched_at = ?
      WHERE pet_id = ? AND week_start = ?`,
    [JSON.stringify(list), nowStr(), petId, week]
  );
  db.run(
    `UPDATE weekly_ritual
        SET contact_reviewed = contact_reviewed + 1
      WHERE pet_id = ? AND week_start = ?`,
    [petId, week]
  );
}

// Read a single row or null.
function readBondRow(db, petId) {
  if (!petId) return null;
  return db.one('SELECT * FROM bond_strength WHERE pet_id = ?', [petId]);
}

function ensureBondRow(db, petId, nowStr) {
  const cur = readBondRow(db, petId);
  if (cur) return cur;
  db.run(
    `INSERT INTO bond_strength(pet_id, value, tier, streak_weeks, updated_at)
     VALUES (?, 0, 1, 0, ?)`,
    [petId, nowStr()]
  );
  return readBondRow(db, petId);
}

// Compute tier for a row, but keep stored value untouched.
function recomputeTierFromValue(db, petId, nowStr) {
  const row = ensureBondRow(db, petId, nowStr);
  const newTier = computeTier(row.value);
  if (newTier !== row.tier) {
    db.run(
      `UPDATE bond_strength
          SET tier = ?, updated_at = ?
        WHERE pet_id = ?`,
      [newTier, nowStr(), petId]
    );
  }
  return newTier;
}

// Apply a single week's worth of points to bond_strength.
//   * Increments bond.value by computeBondDelta(score, streakWeeks, skip).
//   * Updates last_week_settled to `weekStart`.
//   * Recomputes tier.
//   * Sets streakWeeks based on consecutive settlements — we approximate
//     streakSkip by comparing last_week_settled's Monday to `prevWeekStart`.
function applyWeeklySettlement(db, petId, prevWeekStart, thisWeekStart, nowStr) {
  const row = ensureBondRow(db, petId, nowStr);
  const weekRow = db.one(
    'SELECT * FROM weekly_ritual WHERE pet_id = ? AND week_start = ?',
    [petId, prevWeekStart]
  );
  const score = computeWeeklyScore(weekRow);
  let streakSkip = 0;
  // Gap > 1 week of Monday difference == at least 1 skip.
  if (row.last_week_settled) {
    const prev = parseYMD(row.last_week_settled);
    const expectedPrev = addDays(parseYMD(prevWeekStart), -7);
    const msDay = 24 * 3600_000;
    const gap = Math.round((prev.getTime() - expectedPrev.getTime()) / msDay);
    if (gap >= 14) streakSkip = 2;
    else if (gap >= 7) streakSkip = 1;
    else streakSkip = 0;
  }
  const delta = computeBondDelta(score, row.streak_weeks | 0, streakSkip);
  const newValue = Math.max(0, (row.value | 0) + delta);
  const newTier = computeTier(newValue);
  const newStreak = streakSkip === 0 ? (row.streak_weeks | 0) + 1 : 0;
  db.run(
    `UPDATE bond_strength
        SET value = ?, tier = ?, streak_weeks = ?, last_week_settled = ?, updated_at = ?
      WHERE pet_id = ?`,
    [newValue, newTier, newStreak, thisWeekStart, nowStr(), petId]
  );
  return { score, delta, newValue, newTier, newStreak };
}

function parseYMD(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

// Lower bound of a tier: the bond value you need to be at least at that
// tier. Exposed on the snapshot so the renderer can draw a "progress to
// next tier" bar that starts at the *current* tier's floor rather than at
// zero — otherwise a tier-6 pet at 8001 would render a full bar.
function tierFloor(tier) {
  for (const t of TIER_THRESHOLDS) {
    if (t.tier === tier) return t.threshold;
  }
  return 0;
}

// Snapshot used by main renderer page + pet window. The
// `weekly_score` here is for the *current* week — already accumulated.
function getBondSnapshot(db, petId) {
  const row = readBondRow(db, petId);
  const week = weekStart();
  const weekRow = db.one(
    'SELECT * FROM weekly_ritual WHERE pet_id = ? AND week_start = ?',
    [petId, week]
  );
  const weeklyScore = computeWeeklyScore(weekRow);
  if (!row) {
    return {
      pet_id: petId,
      value: 0, tier: 1, tier_label: tierLabel(1), tier_floor: 0,
      streak_weeks: 0, last_week_settled: null,
      weekly_score: weeklyScore, weekly_max: 100,
      next_tier: { tier: 2, threshold: 200 },
    };
  }
  const tier = computeTier(row.value);
  return {
    pet_id: petId,
    value: row.value | 0,
    tier,
    tier_label: tierLabel(tier),
    tier_floor: tierFloor(tier),
    streak_weeks: row.streak_weeks | 0,
    last_week_settled: row.last_week_settled || null,
    weekly_score: weeklyScore,
    weekly_max: 100,
    next_tier: nextTierThreshold(row.value | 0),
  };
}

// Idempotent hook called from the 1s scheduler tick. If we are in a new
// week (last_week_settled < this Monday), settle last week forward. Safe
// to call every second.
function maybeRunWeeklySettlement(db, petId, nowStr) {
  if (!petId) return { settled: false };
  const row = ensureBondRow(db, petId, nowStr);
  const thisMon = weekStart();
  if (!row.last_week_settled) {
    // First ever settlement — just mark this Monday as the baseline; don't
    // credit an empty prior week.
    db.run(
      `UPDATE bond_strength
          SET last_week_settled = ?, updated_at = ?
        WHERE pet_id = ?`,
      [thisMon, nowStr(), petId]
    );
    return { settled: false, reason: 'first_run' };
  }
  if (row.last_week_settled === thisMon) return { settled: false, reason: 'already_settled' };
  // Settle every week between last_week_settled and this Monday (in case
  // the user was offline for a few).
  const last = parseYMD(row.last_week_settled);
  const target = parseYMD(thisMon);
  const oneDay = 24 * 3600_000;
  let settledThisCall = null;
  const weekCursor = new Date(last.getTime() + 7 * oneDay);
  while (weekCursor.getTime() <= target.getTime()) {
    const prevWeekStart = weekStart(new Date(weekCursor.getTime() - 7 * oneDay));
    const thisWeekStart = weekStart(weekCursor);
    const result = applyWeeklySettlement(
      db, petId, prevWeekStart, thisWeekStart, nowStr
    );
    settledThisCall = result;
    weekCursor.setDate(weekCursor.getDate() + 7);
  }
  // Also reset "today" mood flags — they were per-day, the new Monday
  // starts fresh.
  db.setSetting(`today_event:${petId}`, '0');
  db.setSetting(`today_memorial:${petId}`, '0');
  return settledThisCall
    ? { settled: true, ...settledThisCall }
    : { settled: false, reason: 'no_new_week' };
}

function getWeeklyBreakdown(db, petId) {
  const week = weekStart();
  const row = db.one(
    'SELECT * FROM weekly_ritual WHERE pet_id = ? AND week_start = ?',
    [petId, week]
  );
  const reviewed = (() => {
    try {
      const arr = JSON.parse(row?.reviewed_contacts || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  })();
  return {
    week_start: week,
    score: computeWeeklyScore(row),
    per_dimension: DIMENSION_FORMULA.map(([k, cap, weight]) => ({
      key: k,
      value: parseInt(row?.[k] || '0', 10),
      cap, weight,
      filled: sat(parseInt(row?.[k] || '0', 10), cap),
    })),
    reviewed_contacts: reviewed,
  };
}

module.exports = {
  TIER_THRESHOLDS, TIER_LABELS, DIMENSION_FORMULA,
  weekStart, fmtYMD, clamp, sat,
  computeWeeklyScore, computeTier, computeBondDelta,
  nextTierThreshold, tierLabel, tierFloor,
  ensureCurrentWeekRow, incrementWeekDimension, logContactReviewed,
  readBondRow, ensureBondRow, recomputeTierFromValue,
  applyWeeklySettlement, getBondSnapshot, getWeeklyBreakdown,
  maybeRunWeeklySettlement,
};
