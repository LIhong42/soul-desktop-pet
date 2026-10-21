// main/cozy_engine.js — Tier 3 of the pet intimacy system.
//
// "Cozy" = 0..100 number that decays over time of inactivity and refills
// when the user plays with the pet (single-click pet, double-click pat,
// right-click feed/play/sleep/cuddle). Cozy does NOT convert into Bond;
// it only nudges PetMood.
//
// Storage lives entirely in the `cozy_state` and `play_log` tables, no
// in-memory state, so restarts don't lose ground.

// Interaction deltas and cooldowns. These actions are deliberately NOT
// gated on bond tier — every one of them is available from the right-click
// menu on a fresh pet. The bond ladder still exists as long-term progression
// (tier label + 亲密度 + 传说之舞), it just no longer withholds the basic
// ways to play with the pet.
const COZY_DELTAS = {
  pet:    { delta:  4, cooldownMs:   8_000 },
  pat:    { delta:  8, cooldownMs:  10_000 },
  feed:   { delta: 12, cooldownMs:  30_000 },
  play:   { delta:  6, cooldownMs:  60_000 },
  sleep:  { delta:  3, cooldownMs:  60_000 },
  cuddle: { delta: 15, cooldownMs: 300_000 },
};

// Hour-based decay buckets. Tracks give `--decay per second`; the
// `applyDecayTick` decides which bucket applies based on
// `now - last_decay_at`.
//
// Decay is expressed as *points lost per whole hour away*, not per second.
// The scheduler ticks once a second, so a per-second rate would need a
// fractional `value` to accumulate correctly — and `cozy_state.value` is an
// INTEGER column, so the stored value can only move in 1-point steps. A
// per-second rate quantized to integers therefore loses up to a full point
// every tick (the -0.3/hour intent behaved as ~-1/sec, draining a full bar
// in under an hour). Counting *completed hours* instead makes every step an
// exact integer decrement, so the stored value always matches the intended
// rate with no truncation drift.
const DECAY_PER_HOUR = [
  { afterHours: 72, perHour: 1 },      // slow bleed; the floor stops it anyway
  { afterHours: 24, perHour: 2 },
  { afterHours: 6,  perHour: 1 },
  { afterHours: 0,  perHour: 0.3 },
];

// Points lost per completed hour of being away, for the current bucket.
// Fractional rates round *up* so a slow bucket still registers a visible
// drop each hour instead of rounding to zero. The slowest bucket keeps a
// non-zero rate on purpose: a 0 there would freeze decay entirely past 72h,
// leaving a pet that wandered off at 60h stranded well above the floor
// instead of settling into it.
function decayPerHour(lonelyHours) {
  for (const b of DECAY_PER_HOUR) {
    if (lonelyHours >= b.afterHours) return b.perHour;
  }
  return 0;
}

// Floor that idle decay stops at. This MUST stay below the two negative
// mood thresholds in pet_mood.js — `sad` fires at cozy < 10 and
// `depressed` at cozy < 20 (with 48h+ absence). A floor of 20 made both
// states mathematically unreachable: decay bottomed out at 20 and was then
// clamped there forever, so the pet could never look genuinely unhappy.
// At 5 a pet left alone long enough still reaches the <10 "sad" band.
const DECAY_LOW_FLOOR = 5;

// ---- DB-coupled helpers ----

function readCozy(db, petId) {
  if (!petId) return null;
  return db.one('SELECT * FROM cozy_state WHERE pet_id = ?', [petId]);
}

function ensureCozy(db, petId, nowStr, nowMs) {
  const cur = readCozy(db, petId);
  if (cur) return cur;
  const now = nowMs || Date.now();
  db.run(
    `INSERT INTO cozy_state(
        pet_id, value, last_play_at, last_decay_at,
        today_day, today_peak, today_interactions, updated_at
     ) VALUES (?, 40, 0, ?, ?, 40, '{}', ?)`,
    [petId, now, todayDateStr(new Date(now)), nowStr()]
  );
  return readCozy(db, petId);
}

function todayDateStr(d) { return bondFmtYMD(d); }
function bondFmtYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Roll the today_* fields forward when the local date changes. Called
// before each read or decay tick.
function rollDayIfNeeded(db, petId, nowStr, nowMs) {
  const row = ensureCozy(db, petId, nowStr, nowMs);
  const today = todayDateStr(new Date(nowMs || Date.now()));
  if (row.today_day === today) return row;
  db.run(
    `UPDATE cozy_state
        SET today_day = ?, today_peak = ?, today_interactions = '{}', updated_at = ?
      WHERE pet_id = ?`,
    [today, row.value, nowStr(), petId]
  );
  return readCozy(db, petId);
}

// Apply decay for the elapsed time since last_decay_at. Idempotent — calling
// it 100x in 1s produces the same result as calling it once after 100s.
function applyDecayTick(db, petId, nowStr, nowMs) {
  const row = rollDayIfNeeded(db, petId, nowStr, nowMs);
  if (!row) return null;
  const now = nowMs || Date.now();
  // last_decay_at may be a big-int (Date.now() in modern browsers is
  // ~1.7e12); use Number() instead of `| 0` so a stored value > 2^31
  // doesn't wrap to negative and produce a 50-year decay delta.
  const last = Number(row.last_decay_at) || now;
  // Charge decay per *whole elapsed hour*, never for a partial one. This is
  // what makes the rate hourly in practice: a session that's 59 minutes old
  // has decayed 0, and only crosses to 1 at the one-hour mark.
  const hoursElapsed = Math.floor(Math.max(0, now - last) / 3_600_000);
  if (hoursElapsed <= 0) {
    // Less than a full hour since the last charge. Return WITHOUT touching
    // last_decay_at so the partial hour keeps accumulating against the same
    // anchor — advancing it here would silently discard the remainder and
    // the pet would never decay at all.
    return readCozy(db, petId);
  }
  const current = row.value | 0;
  // Accumulate the whole elapsed span hour by hour, re-evaluating the
  // bucket each hour against how long the pet had been away *at that
  // point*. Charging a single rate for the full span would be wrong at the
  // boundary: a pet away 120h would pick the ">=72h → 0" bucket from the
  // total and never decay, instead of having bled down to the floor.
  const awayHoursAt = row.last_play_at
    ? (last - row.last_play_at) / 3_600_000
    : 0;
  let newValue = current;
  for (let h = 0; h < hoursElapsed; h++) {
    const rate = decayPerHour(awayHoursAt + h);
    if (rate <= 0) break;              // clamped bucket — stop, floor holds
    newValue = Math.max(DECAY_LOW_FLOOR, newValue - Math.max(1, Math.ceil(rate)));
    if (newValue <= DECAY_LOW_FLOOR) break;  // nothing left to bleed
  }
  // Never *raise* the value as a side effect of decay — the old code did
  // this via Math.max(value, FLOOR) in the clamped branch, which turned a
  // long absence into a free refill for a pet sitting below 20.
  newValue = Math.min(newValue, current);
  db.run(
    `UPDATE cozy_state
        SET value = ?, last_decay_at = ?, updated_at = ?
      WHERE pet_id = ?`,
    [newValue | 0, now, nowStr(), petId]
  );
  return readCozy(db, petId);
}

// User-triggered interaction. Returns:
//   {
//     accepted: boolean,   // true if delta applied
//     silent:   boolean,   // true if cooldown hit
//     newValue: number,    // 0..100 after delta (or before if silent)
//     delta:    number,
//     particle: string|null, // '❤️' | '🍖' | '🧶' | '💤' | null
//     oneShotMs: number,   // petController.triggerOneShot ms
//     variant:  'default' | 'pat',  // v1 manifest keys
//   }
function applyInteraction(db, petId, action, opts, nowStr, nowMs) {
  const cfg = COZY_DELTAS[action];
  if (!cfg) return { accepted: false, reason: 'unknown_action' };
  const now = nowMs || Date.now();
  const row = rollDayIfNeeded(db, petId, nowStr, now);
  // Cooldown lookup from play_log (cheap: index on pet_id+ts).
  const last = db.one(
    `SELECT ts, silent FROM play_log
      WHERE pet_id = ? AND action = ?
      ORDER BY ts DESC LIMIT 1`,
    [petId, action]
  );
  if (last && (now - Number(last.ts)) < cfg.cooldownMs) {
    logPlay(db, petId, action, 0, 1, now);
    return { accepted: false, silent: true, reason: 'cooldown', newValue: row.value | 0 };
  }
  const before = row.value | 0;
  const after = clamp(before + cfg.delta, 0, 100);
  // Update today_interactions count
  let interactions = {};
  try { interactions = JSON.parse(row.today_interactions || '{}'); } catch {}
  interactions[action] = (interactions[action] | 0) + 1;
  db.run(
    `UPDATE cozy_state
        SET value = ?, last_play_at = ?, last_decay_at = ?,
            today_peak = MAX(today_peak, ?),
            today_interactions = ?, updated_at = ?
      WHERE pet_id = ?`,
    [after, now, now, after, JSON.stringify(interactions), nowStr(), petId]
  );
  logPlay(db, petId, action, cfg.delta, 0, now);
  return {
    accepted: true,
    silent: false,
    newValue: after,
    delta: cfg.delta,
    particle: actionParticle(action),
    oneShotMs: actionOneShotMs(action),
    variant: actionVariant(action),
  };
}

function logPlay(db, petId, action, delta, silent, now) {
  try {
    // Use Math.trunc instead of `| 0` so timestamps > 2^31 (i.e. all
    // modern Date.now() values ~1.7e12) survive intact. `| 0` truncates
    // to a 32-bit signed int and wraps large values into negatives,
    // which would silently break the cooldown check (since `last.ts`
    // ends up negative and (now - last) is then huge).
    db.run(
      `INSERT INTO play_log(pet_id, ts, action, cozy_delta, silent)
       VALUES (?, ?, ?, ?, ?)`,
      [petId, Math.trunc(now), action, Math.trunc(delta), Math.trunc(silent)]
    );
  } catch (e) { /* table not yet created -> skip; bond migration handles it */ }
}

function actionParticle(action) {
  switch (action) {
    case 'pet':
    case 'pat':   return '❤️';
    case 'feed':  return '🍖';
    case 'play':  return '🧶';
    case 'sleep': return '💤';
    case 'cuddle':return '💕';
    default:      return null;
  }
}

function actionOneShotMs(action) {
  switch (action) {
    case 'pet':   return 1500;
    case 'pat':   return 2000;
    case 'feed':  return 2500;
    case 'play':  return 3000;
    case 'sleep': return 4000;
    case 'cuddle':return 6000;
    default:      return 1500;
  }
}

// v1 manifest only declares `default`/`walking`/`reminder`/`pat`. Other
// action keys map to `default` so the renderer falls back to the idle
// variant while CSS filters express the difference via PetMood.
function actionVariant(action) {
  if (action === 'pat') return 'pat';
  return 'default';
}

function getSnapshot(db, petId) {
  const row = readCozy(db, petId);
  if (!row) {
    return {
      pet_id: petId, value: 40, last_play_at: 0,
      today_peak: 40, today_interactions: {},
      lonely_hours: 0,
    };
  }
  const lonelyMs = row.last_play_at ? (Date.now() - row.last_play_at) : 0;
  const lonelyHours = lonelyMs > 0 ? lonelyMs / 3_600_000 : 0;
  let interactions = {};
  try { interactions = JSON.parse(row.today_interactions || '{}'); } catch {}
  return {
    pet_id: petId,
    value: row.value | 0,
    last_play_at: row.last_play_at | 0,
    today_day: row.today_day || '',
    today_peak: row.today_peak | 0,
    today_interactions: interactions,
    lonely_hours: lonelyHours,
  };
}

module.exports = {
  COZY_DELTAS, DECAY_LOW_FLOOR, DECAY_PER_HOUR,
  decayPerHour,
  ensureCozy, rollDayIfNeeded, applyDecayTick,
  applyInteraction,
  getSnapshot,
};
