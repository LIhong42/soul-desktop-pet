// main/reminder_cleanup.js — auto-delete finished, one-shot reminders.
//
// The 提醒 page used to accumulate every reminder the user ever made. A
// "只一次" reminder that fired and was handled stays in the table forever,
// so the list slowly fills with rows that can never fire again ("测试 —
// 一次", "人大投票 — 一次"). This module prunes them.
//
// The rule the user asked for:
//
//   已完成超过一天，且今后不会再进行提醒的事件 → 从数据库删除
//
// Two conditions, both required:
//
//   1. 完成超过一天 — the reminder finished more than 24 hours ago.
//
//   2. 今后不会再进行提醒 — it will never fire again.
//
// Which rows satisfy (2)?
//
//   - `one_time` reminders that have already fired. The scheduler flips
//     them to `active = 0` with `next_fire_at = NULL` when they fire
//     (main/scheduler.js), and nothing re-arms them — `computeNextFireEvent`
//     returns null for a one_time whose remind_date is in the past. So a
//     fired one_time can never nag again.
//
//   - `remind = 0` rows (提醒关闭). These never fire at all. But they were
//     never "完成" either — the user may simply have muted one for a while
//     and want it back later. Deleting them would silently destroy a
//     record the user still owns, so they are NOT pruned. They are also
//     what makes the rule "完成" meaningful: a row that never completed
//     cannot be "完成超过一天".
//
// Every periodic kind (daily / weekly / every_n_days / monthly / yearly)
// is excluded — it will fire again by definition.
//
// Which rows satisfy (1)?
//
//   The completion timestamp is `last_fired_at`, the moment the scheduler
//   fired the reminder. The "more than one day" window is measured as
//   ELAPSED TIME — the reminder must have finished at least 24 hours ago.
//
//   Elapsed time, not calendar days, because the cleanup runs at an
//   arbitrary moment of the day: a rule keyed on "the completion day is
//   before today" would sweep a reminder that fired yesterday at 23:00
//   only an hour later, which is not "超过一天" by any reading. Keyed on
//   the elapsed 24 hours, a reminder always survives at least a full day
//   after it fired, and a reminder that fired at 09:00 yesterday is swept
//   at 09:00 today — which is exactly when a day has actually passed.
//
//   A reminder that fired today is always kept: the user may still be
//   looking at it on the 今日 page, and deleting it out from under them
//   would be surprising.
//
// The `reminder_acks` rows and the live reminder queue entries that
// reference a pruned event are cleaned up too, so no dangling source_id
// can resurrect a nag for an event that no longer exists.

const db = require('./db');

// How many days a completed reminder must have been finished before it is
// pruned. One day, per the user's rule.
const RETENTION_DAYS = 1;

const DAY_MS = 24 * 3600 * 1000;

// The repeat kinds that WILL fire again. A row with one of these is never
// pruned, no matter how long ago it last fired.
const PERIODIC_KINDS = new Set(['daily', 'weekly', 'every_n_days', 'monthly', 'yearly']);

// Format a Date as 'YYYY-MM-DD HH:MM:SS' — the format the DB stores
// timestamps in, and the format the comparisons use.
function fmtStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Whether an event row is a candidate for auto-deletion.
//
// Pure: takes the row and a `now` (Date) so the rule can be tested without
// a database or a wall clock.
//
// Returns true when the row has completed AND can never fire again AND
// finished at least RETENTION_DAYS days ago.
function isPrunableEvent(ev, now) {
  if (!ev) return false;

  // Only a row that actually reminds is eligible. A muted row (remind = 0)
  // never completed, so "完成超过一天" is not true of it.
  if (!ev.remind) return false;

  // A periodic reminder will fire again — never prunable.
  if (PERIODIC_KINDS.has(ev.remind_kind)) return false;

  // A one_time that has not fired yet (active = 1, still has a
  // next_fire_at) is pending, not completed.
  //
  // The scheduler's post-fire state for a one_time is: active = 0,
  // next_fire_at = NULL, last_fired_at = <the fire time>. We key on
  // `last_fired_at` being present, because that is the field that
  // actually records WHEN the reminder completed.
  if (!ev.last_fired_at) return false;

  // A RE-ARMED one_time. The user can edit a finished reminder and give
  // it a new future date — `events:update` sets active = 1 and
  // recomputes next_fire_at, but leaves the old last_fired_at in place.
  // Such a row WILL fire again, so it must not be pruned even though its
  // last_fired_at is old. The presence of a future next_fire_at is what
  // marks it as pending rather than finished.
  if (ev.next_fire_at) {
    const next = parseStamp(ev.next_fire_at);
    if (next && next.getTime() > now.getTime()) return false;
  }

  // A row with a repeat kind we don't recognise (e.g. 'none', or a kind
  // from a newer build) might still fire — don't guess.
  if (ev.remind_kind && ev.remind_kind !== 'one_time') return false;

  // "完成超过一天": at least RETENTION_DAYS whole days of elapsed time.
  const done = parseStamp(ev.last_fired_at);
  if (!done) return false;
  const ageMs = now.getTime() - done.getTime();
  if (ageMs < RETENTION_DAYS * DAY_MS) return false;

  return true;
}

// Parse a 'YYYY-MM-DD HH:MM:SS' stamp into a local Date.
//
// Returns null for anything malformed — an unparseable timestamp means we
// cannot tell when the reminder completed, and a row we cannot read is a
// row we keep.
function parseStamp(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// The candidate rows: finished one_time reminders, oldest first.
//
// The SQL is a coarse pre-filter (kind + a timestamp cutoff); the exact
// rule lives in isPrunableEvent, which re-checks every row. That keeps
// one source of truth for the rule.
//
// The `next_fire_at` condition excludes re-armed rows at the SQL level
// too: a row with a future fire time is scheduled, not finished.
function findPrunableEvents(now) {
  const cutoff = fmtStamp(new Date(now.getTime() - RETENTION_DAYS * DAY_MS));
  return db.all(
    `SELECT * FROM events
      WHERE remind = 1
        AND remind_kind = 'one_time'
        AND last_fired_at IS NOT NULL
        AND last_fired_at <= ?
        AND (next_fire_at IS NULL OR next_fire_at <= ?)
      ORDER BY last_fired_at ASC`,
    [cutoff, fmtStamp(now)]
  ).filter((ev) => isPrunableEvent(ev, now));
}

// Delete the finished one_time reminders that are older than the retention
// window.
//
// `queue` is the live ReminderQueue — its entries for the deleted events
// are dropped so the pet stops nagging about an event that no longer
// exists. It is optional so this can run without a queue (tests, or the
// scheduler before the queue exists).
//
// Returns a summary: { deleted, ids, skipped }.
//
// `skipped` counts rows the SQL selected but the pure rule rejected.
// It should always be 0 — the SQL and the rule describe the same
// condition — but we count it rather than assume, so a drift between the
// two shows up in the log instead of silently deleting the wrong rows.
function pruneCompletedReminders({ queue, now } = {}) {
  if (!db.get()) return { deleted: 0, ids: [], skipped: 0 };

  const at = now || new Date();
  const candidates = findPrunableEvents(at);
  if (candidates.length === 0) return { deleted: 0, ids: [], skipped: 0 };

  const ids = [];
  let skipped = 0;
  for (const ev of candidates) {
    if (!isPrunableEvent(ev, at)) { skipped++; continue; }
    ids.push(ev.id);
  }
  if (ids.length === 0) return { deleted: 0, ids: [], skipped };

  const placeholders = ids.map(() => '?').join(',');

  // Side tables first, so a crash mid-flight leaves no dangling rows.
  // `search_index` and `reminder_acks` are not FK-linked to events, so
  // they have to be removed by hand — the same cleanup the bulk-delete
  // IPC handler does (main/ipc.js).
  db.run(
    `DELETE FROM search_index WHERE kind = 'event' AND ref_id IN (${placeholders})`,
    ids
  );
  db.run(
    `DELETE FROM reminder_acks WHERE source = 'event' AND source_id IN (${placeholders})`,
    ids
  );

  // Drop the live queue entries so the pet doesn't keep nagging about an
  // event that no longer exists.
  if (queue && typeof queue.remove === 'function') {
    for (const id of ids) queue.remove('event', id);
  }

  db.run(`DELETE FROM events WHERE id IN (${placeholders})`, ids);

  return { deleted: ids.length, ids, skipped };
}

module.exports = {
  RETENTION_DAYS,
  PERIODIC_KINDS,
  isPrunableEvent,
  findPrunableEvents,
  pruneCompletedReminders,
};
