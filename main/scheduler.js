// main/scheduler.js — periodic scan, fires due reminders, drives pet state.
//
// Also owns the 1s "bond pipeline" tick that:
//   * advances cozy decay
//   * computes PetMood
//   * fires autonomous pet behaviors (clingy_walk, weekend_greet, …)
//   * settles missed weeks
//   * broadcasts mood changes to both windows
const db = require('./db');
const petInteractions = require('./pet_interactions');
const petMood = require('./pet_mood');
const autoBehaviors = require('./auto_behaviors');
const { computeNextFireEvent, parseDateTime,
        importantDateOccurrence, fmtDateTime } = require('./time_util');

const TICK_MS = 20_000;

class ReminderQueue {
  constructor() {
    this.items = [];
    this.listeners = new Set();
    // The calendar day (YYYY-MM-DD) this queue's contents belong to.
    // `rollDay` uses it to rebuild the queue at the day boundary so every
    // source gets at most one nag per day.
    this.dayStamp = null;
  }
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() {
    // Total count and active count diverge once a user clicks "完成" — the
    // dismissed item stays in the queue so the 今日 page can still show it,
    // but it should not contribute to the pet nag count.
    const payload = { count: this.items.length, active_count: this.activeCount() };
    for (const cb of this.listeners) cb(payload);
  }
  // Rebuild the queue when the calendar day changes.
  //
  // The queue used to live until the app closed, which meant two things
  // went wrong. First, a reminder that was already handled kept its slot
  // forever. Second - and worse - `pushIfNew` refuses to add a source it
  // already holds, so the *next* day's reminder for that source never
  // fired at all. Rolling the queue at the day boundary gives every
  // source exactly one nag per day: today's items are re-derived from the
  // DB by the scan below, and yesterday's are dropped.
  //
  // Returns true when the queue was actually rebuilt.
  rollDay(dayStr) {
    if (this.dayStamp === dayStr) return false;
    this.dayStamp = dayStr;
    const had = this.items.length > 0;
    this.items = [];
    if (had) this.emit();
    return had;
  }
  pushIfNew(r) {
    const exists = this.items.some((x) => x.source === r.source && x.source_id === r.source_id);
    if (exists) return false;
    // Normalize: every queue item carries a dismissed_for_today flag so
    // callers can distinguish "已停止催但仍记录" from "尚未处理".
    if (typeof r.dismissed_for_today !== 'boolean') r.dismissed_for_today = false;
    this.items.push(r);
    this.emit();
    return true;
  }
  list() { return [...this.items]; }
  head() { return this.items[0] || null; }
  len() { return this.items.length; }
  isEmpty() { return this.items.length === 0; }
  // ---- Active (not-dismissed) helpers ----
  // Pet state and "current nag head" only consider non-dismissed items. The
  // 今日 page reads `list()` directly so it can render both states.
  activeItems() { return this.items.filter((r) => !r.dismissed_for_today); }
  activeCount() { return this.activeItems().length; }
  activeHead() { return this.activeItems()[0] || null; }
  isActiveEmpty() { return this.activeItems().length === 0; }
  // Mark a queue item as "completed for today" without removing it. Returns
  // the item that was updated, or null if no matching item was in the queue.
  // Idempotent: a second call on an already-dismissed item is a no-op (no
  // emit), so duplicate renderer clicks don't churn the UI.
  dismissForToday(source, sourceId) {
    const item = this.items.find((r) => r.source === source && r.source_id === sourceId);
    if (!item) return null;
    if (item.dismissed_for_today) return item;
    item.dismissed_for_today = true;
    this.emit();
    return item;
  }
  remove(source, sourceId) {
    const i = this.items.findIndex((r) => r.source === source && r.source_id === sourceId);
    if (i === -1) return null;
    const [removed] = this.items.splice(i, 1);
    this.emit();
    return removed;
  }
  clear() { this.items = []; this.emit(); }
}

let timer = null;

function start({ queue, getPetState, setPetState, setActiveReminder, petController }) {
  function tick() {
    try {
      scanAndFire({ queue, getPetState, setPetState, setActiveReminder, petController });
    } catch (e) {
      console.error('scheduler error:', e);
    }
  }
  setTimeout(tick, 1_500);
  timer = setInterval(tick, TICK_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function scanAndFire({ queue, getPetState, setPetState, setActiveReminder, petController }) {
  if (!db.get()) return;
  const now = new Date();
  const now_str = db.nowStr();
  const fired = [];

  // Roll the queue at the day boundary before anything else. Every source
  // gets at most one nag per calendar day, and the items below re-derive
  // today's set from the DB. See ReminderQueue.rollDay for why this is
  // load-bearing rather than cosmetic.
  queue.rollDay(now_str.slice(0, 10));

  // --- Events with due next_fire_at ---
  const due_events = db.all(
    `SELECT * FROM events
     WHERE active = 1 AND remind = 1 AND next_fire_at IS NOT NULL
     ORDER BY next_fire_at ASC`
  );

  for (const ev of due_events) {
    const nf = parseDateTime(ev.next_fire_at);
    if (!nf) continue;
    if (nf.getTime() > now.getTime() + 30_000) continue;

    const ack = db.one(
      `SELECT next_fire_at FROM reminder_acks
       WHERE source='event' AND source_id=?
       ORDER BY id DESC LIMIT 1`,
      [ev.id]
    );
    if (ack && ack.next_fire_at) {
      const nfAck = parseDateTime(ack.next_fire_at);
      if (nfAck && nfAck.getTime() > now.getTime()) {
        db.run('UPDATE events SET next_fire_at = ? WHERE id = ?', [ack.next_fire_at, ev.id]);
        continue;
      }
    }

    let contactName = null;
    if (ev.contact_id) {
      const c = db.one('SELECT name FROM contacts WHERE id = ?', [ev.contact_id]);
      if (c && c.name) contactName = c.name;
    }

    fired.push({
      source: 'event',
      source_id: ev.id,
      title: ev.title,
      description: ev.description || null,
      contact_id: ev.contact_id,
      contact_name: contactName,
      next_fire_at: ev.next_fire_at,
      // Category is carried through to the renderer so the 今日 page can
      // link back to /events/:id?category=<this> and open the matching edit
      // form (general / work / memorial) instead of guessing.
      category: ev.category,
      kind: 'event',
      remind_kind: ev.remind_kind,
      dismissed_for_today: false,
    });

    const next = computeNextFireEvent(ev, now);
    if (ev.remind_kind === 'one_time') {
      db.run('UPDATE events SET active = 0, last_fired_at = ?, next_fire_at = NULL WHERE id = ?',
        [db.nowStr(), ev.id]);
    } else {
      db.run('UPDATE events SET last_fired_at = ?, next_fire_at = ? WHERE id = ?',
        [db.nowStr(), next ? require('./time_util').fmtDateTime(next) : null, ev.id]);
    }
  }

  // --- Important dates inside their advance window ---
  //
  // An important date (birthday / anniversary / 忌日 / …) is anchored to a
  // month + day that recurs every year. The user asked for these to start
  // nagging a week ahead, so the match is no longer "the date is today" but
  // "today falls inside the advance window of the next occurrence".
  //
  // The window is inclusive of the day itself: with advance_days = 7 the
  // date fires on D-7, D-6, … D-1 and then again on D (days_left = 0).
  // Each of those days is a separate nag — the queue rolls over at
  // midnight (rollDay above), so a source is pushed at most once per day.
  //
  // `remind_enabled = 0` rows are skipped entirely: the user kept the
  // record but opted out of the nagging.
  const id_rows = db.all('SELECT * FROM important_dates WHERE remind_enabled = 1');

  for (const d of id_rows) {
    const occ = importantDateOccurrence(d, now);
    // Outside the advance window — nothing to nag about yet.
    if (!occ) continue;

    // A snooze pushes the next fire time forward; the ack row records it
    // in `next_fire_at`. While that time is still in the future, the date
    // stays quiet.
    //
    // A plain "完成" writes next_fire_at = NULL, so it does NOT suppress
    // the nag here — that suppression comes from the per-day ack check
    // further down (which looks at acked_at's date prefix). That's what
    // makes each day of the advance window an independent nag: dismissing
    // it today still lets tomorrow nag again.
    const ack = db.one(
      `SELECT next_fire_at FROM reminder_acks
       WHERE source='important_date' AND source_id=?
       ORDER BY id DESC LIMIT 1`,
      [d.id]
    );
    if (ack && ack.next_fire_at) {
      const nfAck = parseDateTime(ack.next_fire_at);
      if (nfAck && nfAck.getTime() > now.getTime()) continue;
    }

    let contactName = null;
    const c = db.one('SELECT name FROM contacts WHERE id = ?', [d.contact_id]);
    if (c && c.name) contactName = c.name;

    let titleStr = d.label;
    if (d.year) {
      const age = now.getFullYear() - d.year;
      if (age > 0) titleStr = `${d.label} · ${age}岁`;
    }

    fired.push({
      source: 'important_date',
      source_id: d.id,
      title: titleStr,
      description: null,
      contact_id: d.contact_id,
      contact_name: contactName,
      next_fire_at: now_str,
      kind: d.kind,
      remind_kind: null,
      category: null,
      dismissed_for_today: false,
      // How many days until the date itself (0 = it is today). The renderer
      // and the pet bubble turn this into "还有 N 天".
      days_left: occ.days_left,
      advance_days: occ.advance_days,
      // The date we're counting down to, as YYYY-MM-DD.
      target_date: fmtDateTime(occ.target).slice(0, 10),
    });
  }

  for (const r of fired) {
    if (queue.pushIfNew(r)) {
      // Re-hydrate the dismissed-for-today state from reminder_acks so that
      // a soft "完成" survives an Electron quit-then-restart. We only look
      // at acks stamped today — older acks (one_time events that already
      // fired once, periodic ones that fired yesterday) shouldn't suppress
      // today's nag, since the user would have seen those reminders
      // complete in past sessions and the new day should re-prompt.
      const todayPrefix = now_str.slice(0, 10); // YYYY-MM-DD
      const ackToday = db.one(
        `SELECT acked_at FROM reminder_acks
          WHERE source=? AND source_id=? AND acked_at LIKE ?
          ORDER BY id DESC LIMIT 1`,
        [r.source, r.source_id, `${todayPrefix}%`]
      );
      if (ackToday) {
        queue.dismissForToday(r.source, r.source_id);
      }
    }
  }

  // Use the active (non-dismissed) subset to drive pet state — dismissed
  // items must NOT keep the pet in REMINDER mode, even though they remain
  // visible on the 今日 page so the user can review what they finished.
  const activeLen = queue.activeCount();
  if (activeLen > 0 && !getPetState()) {
    setPetState(true);
    setActiveReminder(queue.activeHead());
    if (petController && petController.setReminding) petController.setReminding(true);
  } else if (activeLen > 0) {
    setActiveReminder(queue.activeHead());
    if (petController && petController.setReminding) petController.setReminding(true);
  } else if (getPetState()) {
    setPetState(false);
    setActiveReminder(null);
    if (petController && petController.setReminding) petController.setReminding(false);
  }
}

module.exports = { start, stop, ReminderQueue, startBondPipeline, stopBondPipeline, scanAndFire };

// ---- Bond pipeline (1s tick) ----
// Started by main.js after the windows + petController are ready. Stops
// independently of the 20s reminder scan so the two timers never block
// each other.
let moodTimer = null;
let lastMoodEmitted = null;

// Change-detector for the value-gated `pet:status-changed` broadcast. Holds
// a compact signature of the last-pushed snapshot so the 1s tick can stay
// silent while nothing is actually moving.
let lastStatusEmitted = null;

// The subset of bond + cozy the renderer needs to repaint the 今日 page's
// 桌宠状态 panel. Shared by both broadcast channels so the two payloads
// can't drift apart.
function statusFields(bondSnap, cozySnap) {
  return {
    bond_tier: bondSnap.tier,
    bond_value: bondSnap.value,
    tier_label: bondSnap.tier_label,
    tier_floor: bondSnap.tier_floor,
    week_score: bondSnap.weekly_score,
    next_tier: bondSnap.next_tier,
    cozy: cozySnap.value,
    cozy_today_peak: cozySnap.today_peak,
    cozy_today_interactions: cozySnap.today_interactions,
    lonely_hours: Math.round((cozySnap.lonely_hours | 0) * 10) / 10,
  };
}

// Round lonely_hours to whole hours so slow decay doesn't re-broadcast on
// every sub-hour step; the UI only renders whole hours anyway.
function statusSignature(bondSnap, cozySnap, mood) {
  return [
    mood,
    bondSnap.tier,
    bondSnap.value,
    bondSnap.weekly_score,
    bondSnap.streak_weeks,
    cozySnap.value,
    Math.floor(cozySnap.lonely_hours | 0),
  ].join('|');
}

// Send to whichever windows still exist. Both channels are advisory — the
// renderer treats a missing window as "no listener" rather than an error.
function pushStatus(winPet, winMain, channel, payload) {
  if (winPet && !winPet.isDestroyed()) winPet.webContents.send(channel, payload);
  if (winMain && !winMain.isDestroyed()) winMain.webContents.send(channel, payload);
}

function startBondPipeline({ petController, winPet, winMain, petRegistry }) {
  if (moodTimer) return;
  moodTimer = setInterval(() => {
    try {
      const petId = db.getSetting('pet_id') || (petController && petController.petId);
      if (!petId) return;
      // 1) advance cozy decay (idempotent)
      petInteractions.getCozySnapshot(db, petId);  // ensures row + rollDay
      // Decay is applied by an explicit tick function in cozy_engine — we
      // just call into it through the interactions wrapper. To keep pet
      // decoupled from the engine module path here, we manually import
      // cozy_engine and run the tick.
      const cozyEngine = require('./cozy_engine');
      cozyEngine.applyDecayTick(db, petId, db.nowStr.bind(db));

      // 2) snapshot bond + cozy
      const bondSnap = petInteractions.getBondSnapshot(db, petId);
      const cozySnap = petInteractions.getCozySnapshot(db, petId);

      // 3) sync tier onto the controller
      if (petController && typeof petController.setBondTier === 'function') {
        petController.setBondTier(bondSnap.tier);
      }

      // 3b) sync the user's idle-loop variant list onto the controller so
      // pets with a "default + greet + pat" config actually rotate through
      // those variants while idle (instead of always replaying 'default').
      // The settings page IPC also pushes this directly, so this tick is
      // mostly a safety net for the "user edited settings, then closed and
      // reopened the main window" case where the IPC handler isn't on the
      // path. setLoopVariants short-circuits when the list is unchanged.
      const petActionsConfig = require('./pet_actions_config');
      const loopCfg = petActionsConfig.loadConfig(db, petId);
      const loopFiltered = petActionsConfig.filterAgainstManifest(
        loopCfg, petRegistry, petId,
      );
      if (petController && typeof petController.setLoopVariants === 'function') {
        petController.setLoopVariants(loopFiltered.loop_variants);
      }

      // 4) compute mood
      const now = new Date();
      const activeReminders = (typeof queue !== 'undefined' && queue && queue.activeCount)
        ? queue.activeCount()
        : (petController && petController._reminderOn ? 1 : 0);
      const mood = petInteractions.computeMood(
        db,
        petMood.computeMood,
        activeReminders,
        petId,
      );

      // 5) auto behaviors
      const auto = autoBehaviors.evaluate(db, petId, {
        tier: bondSnap.tier,
        cozy: cozySnap.value,
        dow: now.getDay(),
        hour: now.getHours(),
      });
      if (auto && petController && petController.triggerOneShot) {
        petController.triggerOneShot(auto.variant, auto.oneShotMs);
        autoBehaviors.markTriggered(db, petId, auto.name, Date.now());
      }

      // 6) broadcast if mood changed
      if (mood.mood !== lastMoodEmitted) {
        lastMoodEmitted = mood.mood;
        pushStatus(winPet, winMain, 'pet:mood-changed', Object.assign({}, mood, statusFields(bondSnap, cozySnap)));
      }

      // 6b) broadcast the numeric status whenever it actually changes.
      // The mood-changed broadcast above only fires on a mood-id flip, but
      // the cozy/bond numbers move on their own schedule: a cozy action
      // (喂食 +12 舒适度) or the decay tick changes them while the mood id
      // stays 'content'. Without this second, value-gated push the 今日
      // page would show a stale 舒适度/亲密度 until the user re-navigated.
      // Gate on the values (not the clock) so this stays quiet at rest.
      const sig = statusSignature(bondSnap, cozySnap, mood.mood);
      if (sig !== lastStatusEmitted) {
        lastStatusEmitted = sig;
        pushStatus(winPet, winMain, 'pet:status-changed', Object.assign({ mood: mood.mood }, statusFields(bondSnap, cozySnap)));
      }

      // 7) daily settlement check
      petInteractions.runSettlementIfDue(db, db.nowStr.bind(db), petId);
    } catch (e) {
      console.error('[bond pipeline]', e && e.message ? e.message : e);
    }
  }, 1000);
}

function stopBondPipeline() {
  if (moodTimer) { clearInterval(moodTimer); moodTimer = null; }
  lastMoodEmitted = null;
  lastStatusEmitted = null;
}