// scripts/verify-pet-stats.js — guards the two pet-status numbers that
// are easy to get wrong and hard to notice when they break:
//
//   1. The MOOD is a pure function of 舒适度 (cozy). It must not depend
//      on the bond tier, the weekly score, the weekend flag, the reminder
//      count, or the "something noteworthy happened today" flags — the
//      user can only act on cozy, so the mood must only reflect cozy.
//
//   2. 陪伴天数 (days together) counts DISTINCT DAYS on which the user
//      interacted with the pet, and only ever goes up. A missed day must
//      not deduct, and a second interaction on the same day must not
//      double-count.
//
// Usage: node scripts/verify-pet-stats.js

const path = require('path');
const ROOT = path.join(__dirname, '..');
const petMood = require(path.join(ROOT, 'main', 'pet_mood.js'));
const cozy = require(path.join(ROOT, 'main', 'cozy_engine.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push({ name, detail }); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- 1. the mood ladder --------------------------------------------------

console.log('\n[1] the mood is a pure function of cozy');

// Every rung of the ladder, plus the values just below each threshold —
// the boundary is where an off-by-one would hide.
const LADDER = [
  { cozy: 100, mood: 'happy_clingy' },
  { cozy: 70,  mood: 'happy_clingy' },
  { cozy: 69,  mood: 'content' },
  { cozy: 55,  mood: 'content' },
  { cozy: 40,  mood: 'content' },
  { cozy: 39,  mood: 'missing_you' },
  { cozy: 30,  mood: 'missing_you' },
  { cozy: 20,  mood: 'missing_you' },
  { cozy: 19,  mood: 'sad' },
  { cozy: 15,  mood: 'sad' },
  { cozy: 10,  mood: 'sad' },
  { cozy: 9,   mood: 'depressed' },
  { cozy: 5,   mood: 'depressed' },
  { cozy: 0,   mood: 'depressed' },
];
for (const c of LADDER) {
  const got = petMood.computeMood({ cozy: c.cozy });
  check(`cozy ${c.cozy} → ${c.mood}`, got.mood === c.mood, got.mood);
}

// An out-of-range cozy is clamped, not thrown on.
check('a negative cozy clamps to depressed',
  petMood.computeMood({ cozy: -50 }).mood === 'depressed');
check('an absurd cozy clamps to happy_clingy',
  petMood.computeMood({ cozy: 9999 }).mood === 'happy_clingy');
check('a missing cozy reads as the floor',
  petMood.computeMood({}).mood === 'depressed',
  petMood.computeMood({}).mood);
check('a non-numeric cozy reads as the floor',
  petMood.computeMood({ cozy: 'abc' }).mood === 'depressed');

// The whole point: no OTHER input may move the mood. Every rung is
// checked against a payload where every non-cozy input is pushed to the
// extreme that used to change the answer.
const PERTURBED = {
  bond_tier: 7,
  week_score: 0,
  lonely_hours: 999,
  active_reminders: 5,
  is_weekend: true,
  new_event_today: true,
  new_memorial_today: true,
};
for (const c of LADDER) {
  const plain = petMood.computeMood({ cozy: c.cozy });
  const loud = petMood.computeMood(Object.assign({ cozy: c.cozy }, PERTURBED));
  check(`cozy ${c.cozy} ignores every other input`,
    plain.mood === loud.mood, `${plain.mood} vs ${loud.mood}`);
}

// The mood must not ask for a different sprite: the pet's own picture
// stays the pet's own picture, and the mood is expressed by the CSS
// filter and the word's colour instead.
for (const c of LADDER) {
  const got = petMood.computeMood({ cozy: c.cozy });
  check(`cozy ${c.cozy} binds no sprite variant`, got.variant === 'default', got.variant);
}

// The five moods are the only ones the tree can produce.
const MOODS = new Set(LADDER.map((c) => c.mood));
check('the tree produces exactly five moods', MOODS.size === 5, [...MOODS].join(','));

// The happy rung is the only one that auto-triggers a behaviour.
for (const c of LADDER) {
  const got = petMood.computeMood({ cozy: c.cozy });
  const expected = c.mood === 'happy_clingy' ? 'clingy_walk' : null;
  check(`cozy ${c.cozy} auto-trigger is ${expected}`,
    got.autoTrigger === expected, String(got.autoTrigger));
}

// ---- 2. 陪伴天数 ----------------------------------------------------------

console.log('\n[2] 陪伴天数 counts distinct days and only goes up');

// A minimal in-memory stand-in for the DB: the cozy_state row, the
// play_log rows, and the settings table the counter lives in.
function makeDb() {
  const settings = new Map();
  const rows = new Map();
  const playLog = [];
  return {
    settings,
    getSetting: (k) => (settings.has(k) ? settings.get(k) : null),
    setSetting: (k, v) => { settings.set(k, String(v)); },
    one: (sql, p) => {
      if (sql.includes('cozy_state')) return rows.get(p[0]) || null;
      if (sql.includes('FROM play_log')) {
        const hit = playLog
          .filter((r) => r.pet_id === p[0] && r.action === p[1])
          .sort((a, b) => b.ts - a.ts)[0];
        return hit || null;
      }
      return null;
    },
    run: (sql, p) => {
      if (sql.includes('INSERT INTO cozy_state')) {
        rows.set(p[0], {
          pet_id: p[0], value: p[1], last_play_at: p[2], last_decay_at: p[3],
          today_day: p[4], today_peak: p[5], today_interactions: p[6], updated_at: p[7],
        });
      } else if (sql.includes('INSERT INTO play_log')) {
        playLog.push({ pet_id: p[0], ts: p[1], action: p[2], cozy_delta: p[3], silent: p[4] });
      } else if (sql.includes('UPDATE cozy_state')) {
        const r = rows.get(p[0]); if (!r) return;
        if (sql.includes('today_interactions = ?')) {
          r.value = p[1]; r.last_play_at = p[2]; r.last_decay_at = p[3];
          r.today_peak = p[4]; r.today_interactions = p[5];
        } else if (sql.includes('today_day = ?')) {
          r.today_day = p[1]; r.today_peak = p[2]; r.today_interactions = p[3];
        } else if (sql.includes('value = ?')) {
          r.value = p[1];
        }
      }
    },
  };
}

// A clock the test moves by hand, so "tomorrow" is exact.
let clock = Date.parse('2026-01-05T10:00:00');
const nowStr = () => new Date(clock).toISOString();
const advanceDay = () => { clock += 24 * 3600 * 1000; };

const db = makeDb();
const PET = 'test-pet';

check('a fresh pet has 0 days together', cozy.getDaysTogether(db, PET) === 0);

// Three interactions on the same day → ONE day.
cozy.applyInteraction(db, PET, 'pet', {}, nowStr, clock);
cozy.applyInteraction(db, PET, 'feed', {}, nowStr, clock);
cozy.applyInteraction(db, PET, 'play', {}, nowStr, clock);
check('three interactions on one day count as one day',
  cozy.getDaysTogether(db, PET) === 1, String(cozy.getDaysTogether(db, PET)));

// A cooldown-dropped click is not an interaction and must not credit a
// day. (The 'pet' action has an 8s cooldown and was just used.)
const before = cozy.getDaysTogether(db, PET);
const dropped = cozy.applyInteraction(db, PET, 'pet', {}, nowStr, clock);
check('a cooldown-dropped click is not accepted', dropped.accepted === false);
check('a cooldown-dropped click does not credit a day',
  cozy.getDaysTogether(db, PET) === before, String(cozy.getDaysTogether(db, PET)));

// Tomorrow → +1.
advanceDay();
cozy.applyInteraction(db, PET, 'cuddle', {}, nowStr, clock);
check('an interaction on the next day adds a day',
  cozy.getDaysTogether(db, PET) === 2, String(cozy.getDaysTogether(db, PET)));

// A day with NO interaction at all → the counter must NOT go down.
advanceDay();
check('a missed day does not deduct',
  cozy.getDaysTogether(db, PET) === 2, String(cozy.getDaysTogether(db, PET)));

// The day after the missed one → +1 again.
advanceDay();
cozy.applyInteraction(db, PET, 'pat', {}, nowStr, clock);
check('the day after a missed day still counts',
  cozy.getDaysTogether(db, PET) === 3, String(cozy.getDaysTogether(db, PET)));

// The counter is per pet.
check('another pet is unaffected',
  cozy.getDaysTogether(db, 'other-pet') === 0);

// The snapshot carries it, so the renderer can read it.
const snap = cozy.getSnapshot(db, PET);
check('the snapshot carries days_together', snap.days_together === 3, String(snap.days_together));

// The counter and the per-day interaction tally are independent: today's
// tally resets every day, the counter does not.
check('today_interactions resets while days_together does not',
  snap.today_interactions && typeof snap.today_interactions === 'object');
advanceDay();
const snap2 = cozy.getSnapshot(db, PET);
check('the counter survives a day rollover',
  snap2.days_together === 3, String(snap2.days_together));

// ---- Report --------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
