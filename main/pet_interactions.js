// main/pet_interactions.js — Aggregator module for all bond/tracker
// operations. Both the IPC handlers in `main/ipc.js` and the 1s scheduler
// tick call into here so we have one canonical place that turns an event
// into (bond dimension bump + cozy mutation + today-flag set).
//
// All three engines (bond_engine, cozy_engine, pet_mood) are small; this
// file only orchestrates their write paths.

const bond = require('./bond_engine');
const cozy = require('./cozy_engine');

// ---- Main tracker (called from IPC handlers) ----
//
// Pass a `kind` string from this set:
//   contact_added | contact_modified | event_created
//   important_date_added | avatar_uploaded | attribute_changed
//   memorial_recorded | reminder_completed | reminder_snoozed
function trackActivity(db, kind, nowStr, petId) {
  const currentPet = petId || db.getSetting('pet_id');
  if (!currentPet) return;
  try {
    bond.incrementWeekDimension(db, currentPet, kind, 1, nowStr);
  } catch (e) {
    console.error('[bond] trackActivity failed:', kind, e.message);
  }
}

function logContactReviewed(db, contactId, nowStr, petId) {
  const currentPet = petId || db.getSetting('pet_id');
  if (!currentPet || !contactId) return;
  try {
    bond.logContactReviewed(db, currentPet, contactId, nowStr);
  } catch (e) {
    console.error('[bond] logContactReviewed failed:', e.message);
  }
}

// ---- Bond snapshot helper that reads everything in one go ----
function getBondSnapshot(db, petId) {
  const currentPet = petId || db.getSetting('pet_id');
  return bond.getBondSnapshot(db, currentPet);
}

function getWeeklyBreakdown(db, petId) {
  const currentPet = petId || db.getSetting('pet_id');
  return bond.getWeeklyBreakdown(db, currentPet);
}

// ---- Cozy interaction (called from `bond:pet|pat|feed|play|sleep|cuddle` IPC) ----
//
// `opts.bondTier` is passed in so cozy_engine can skip tier-locked actions
// without a roundtrip to bond_engine.
function applyCozyInteraction(db, action, opts, nowStr, petId) {
  const currentPet = petId || db.getSetting('pet_id');
  const tier = opts && opts.bondTier;
  return cozy.applyInteraction(
    db,
    currentPet,
    action,
    { bondTier: tier },
    nowStr,
  );
}

function getCozySnapshot(db, petId) {
  const currentPet = petId || db.getSetting('pet_id');
  return cozy.getSnapshot(db, currentPet);
}

// ---- Mood ---(called from the 1s scheduler tick). Wraps
// `pet_mood.computeMood` so the ipc layer doesn't import pet_mood directly.
//
// `activeReminderCount` comes from `scheduler.queue.activeCount()`; if we
// don't have it we pass 0.
function computeMood(db, petMoodFn, activeReminderCount, petId) {
  const snap = bond.getBondSnapshot(db, petId || db.getSetting('pet_id'));
  const cozySnap = cozy.getSnapshot(db, petId || db.getSetting('pet_id'));
  const lonelyHours = cozySnap.lonely_hours | 0;
  const dow = new Date().getDay();
  return petMoodFn({
    bond_tier: snap.tier,
    week_score: snap.weekly_score,
    cozy: cozySnap.value,
    lonely_hours: lonelyHours,
    active_reminders: activeReminderCount | 0,
    is_weekend: dow === 0 || dow === 6,
    new_event_today: !!parseInt(db.getSetting(`today_event:${petId || db.getSetting('pet_id')}`) || '0', 10),
    new_memorial_today: db.getSetting(`today_memorial:${petId || db.getSetting('pet_id')}`) === '1',
  });
}

// ---- Daily settlement hook ----
function runSettlementIfDue(db, nowStr, petId) {
  const currentPet = petId || db.getSetting('pet_id');
  return bond.maybeRunSettlement(db, currentPet, nowStr);
}

// ---- Celebrate hook ----
// Sets the "new_event_today" flag so the next mood tick resolves to
// `proud`, and bumps the event_created dimension by 1 (a small reward
// for hitting the celebration trigger). Capped via the dimension
// saturation in computeWeeklyScore, so spamming celebrate doesn't
// inflate the bond tier.
function celebrate(db, petId, nowStr) {
  const currentPet = petId || db.getSetting('pet_id');
  if (!currentPet) return;
  const stamp = (nowStr && nowStr()) || new Date().toISOString();
  bond.incrementWeekDimension(db, currentPet, 'event_created', 1, nowStr);
  db.setSetting(`today_event:${currentPet}`, '1');
  return { ok: true, at: stamp };
}

module.exports = {
  trackActivity,
  logContactReviewed,
  getBondSnapshot,
  getWeeklyBreakdown,
  applyCozyInteraction,
  getCozySnapshot,
  computeMood,
  runSettlementIfDue,
  celebrate,
};
