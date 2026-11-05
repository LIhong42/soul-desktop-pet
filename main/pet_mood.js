// main/pet_mood.js — Tier 4 of the pet intimacy system.
//
// Pure decision tree that turns the pet's 舒适度 (cozy) into a single
// "dominant mood" + UI hints. The renderer uses `mood` to drive CSS
// filters and `variant` to ask the main process for a different sprite
// set; the auto-trigger ends up as a one-shot variant.
//
// The mood is now driven by the cozy score ALONE. It used to mix in the
// weekly ritual score, the bond tier, the weekend flag and "did the user
// do something noteworthy today" — which made the mood a five-way blend
// that the user could not act on. Cozy is the one number the user moves
// directly (摸 / 喂 / 玩 / 抱), so the mood now mirrors it one-to-one:
// what the pet feels IS how comfortable it is.
//
// The other inputs are still accepted (callers pass the whole snapshot)
// but are no longer read, so a caller doesn't have to be changed to match.
//
// This module is intentionally side-effect-free. It does not touch the DB
// and does not broadcast — `scheduler.js` does that on a 1s tick.

// The mood ladder, purely as a function of the cozy score.
//
//   cozy >= 70  → happy_clingy   黏人      暖洋洋,想一直待在你身边
//   cozy >= 40  → content        平静      状态不错
//   cozy >= 20  → missing_you    想你陪    有点想你了,还想再靠近一点
//   cozy >= 10  → sad            难过      舒适度见底了
//   cozy <  10  → depressed      有点低落  好久没人陪它了
//
// The thresholds are the ones the old tree used for its cozy-driven
// branches, so the mood a user sees for a given cozy score stays the one
// they already know — only the *reason* the mood changed has narrowed.
const MOOD_LADDER = [
  { min: 70, mood: 'happy_clingy', bubble: '来贴贴~' },
  { min: 40, mood: 'content',      bubble: null },
  { min: 20, mood: 'missing_you',  bubble: '有点想你了，还想再靠近一点' },
  { min: 10, mood: 'sad',          bubble: '舒适度见底了，喂点东西就好' },
  { min: -1, mood: 'depressed',    bubble: '好久没人陪它了，去摸摸它吧' },
];

function moodForCozy(cozy) {
  for (const rung of MOOD_LADDER) {
    if (cozy >= rung.min) return rung;
  }
  // MOOD_LADDER's last rung has min = -1, so this is unreachable for any
  // clamped cozy. Kept so a future edit to the ladder can't return null.
  return MOOD_LADDER[MOOD_LADDER.length - 1];
}

function computeMood(input) {
  const cozy = clampNum(input && input.cozy, 0, 100);
  const rung = moodForCozy(cozy);
  return {
    mood: rung.mood,
    variant: 'default',
    bubble: rung.bubble,
    autoTrigger: rung.mood === 'happy_clingy' ? 'clingy_walk' : null,
    cssClass: rung.mood,
  };
}

function clampNum(v, lo, hi) {
  const x = Number(v);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

module.exports = { computeMood, MOOD_LADDER, moodForCozy };
