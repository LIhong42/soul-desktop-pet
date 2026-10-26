// main/time_util.js — pure functions for next-fire computation

const DEFAULT_REMIND_TIME = '09:00';
const { nextSolarDateForLunar } = require('./lunar');

// How many days before a date an "advance" reminder starts firing.
// `null` on a row means "use this default" — the important-date rows get
// a week of lead time, the plain event rows keep firing on the day itself.
const DEFAULT_ADVANCE_DAYS = 7;

function parseHhmm(s) {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

function formatHhmm(t) {
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}

function fmtDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseDateTime(s) {
  if (!s) return null;
  // "YYYY-MM-DD HH:MM:SS"
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function lastDayOfMonth(year, month /* 1-12 */) {
  return new Date(year, month, 0).getDate();
}

function nextYearlyAt(now, day, month, time) {
  let year = now.getFullYear();
  // Try up to 5 years forward
  for (let i = 0; i < 5; i++) {
    const ld = lastDayOfMonth(year, month);
    const actualDay = Math.min(day, ld);
    const cand = new Date(year, month - 1, actualDay, time.h, time.m, 0, 0);
    if (cand.getTime() > now.getTime() + 60_000) {
      return cand;
    }
    year += 1;
  }
  return null;
}

function nextMonthlyAt(now, time, dayHint) {
  const day = dayHint || now.getDate();
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-12
  for (let i = 0; i < 60; i++) {
    const ld = lastDayOfMonth(year, month);
    const actualDay = Math.min(day, ld);
    const cand = new Date(year, month - 1, actualDay, time.h, time.m, 0, 0);
    if (cand.getTime() > now.getTime() + 60_000) {
      return cand;
    }
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anchor-based occurrences (每周 / 每 N 天)
// ---------------------------------------------------------------------------
//
// The monthly/yearly helpers above walk the calendar forward looking for a
// slot. The two new repeat kinds need something different: a fixed stride
// measured in days from a user-chosen anchor date.
//
// The anchor matters. If we computed "next occurrence = last fired + N days",
// every save/re-save would shift the schedule (the anchor would become
// "whenever we last recalculated"), and the user's "every 3 days" would
// silently drift over the months. So the anchor is always `remind_date`,
// and the next occurrence is the first anchor+k*N that lands in the future.

const DAY_MS = 24 * 3600 * 1000;

// The first occurrence at or after `now` on the "anchor + k*strideDays"
// grid, at the given wall-clock time.
//
// The +60_000 tolerance matches the rest of this module: a reminder whose
// time is "right now" should still count as pending rather than being
// pushed a whole stride forward.
function nextOccurrenceFromAnchor(anchorDate, strideDays, time, now) {
  const n = Math.max(1, Math.floor(Number(strideDays) || 1));
  let cand = new Date(
    anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(),
    time.h, time.m, 0, 0
  );
  if (cand.getTime() <= now.getTime() + 60_000) {
    // How many whole strides have already elapsed since the anchor? Using
    // floor division on the elapsed day count (rather than iterating) keeps
    // this O(1) even for an anchor years in the past.
    const elapsedDays = Math.floor((now.getTime() - cand.getTime()) / DAY_MS);
    const jumps = Math.floor(elapsedDays / n) + 1;
    cand = new Date(cand.getTime() + jumps * n * DAY_MS);
  }
  return cand;
}

// The anchor date a repeat kind should count from. Falls back to today so a
// row that was created without an explicit date still has a sane schedule.
function anchorFor(ev, now) {
  const d = ev.remind_date ? parseDate(ev.remind_date) : null;
  return d || new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ---------------------------------------------------------------------------
// Important-date occurrences (the "start a week early" window)
// ---------------------------------------------------------------------------
//
// An important date (birthday / anniversary / …) is anchored to a month +
// day that recurs every year. With `advance_days = 7` the reminder should
// fire once per day for the seven days leading up to it, and then on the
// day itself.
//
// Returns the occurrence that covers `now`, or null when `now` falls
// outside the reminder window. Each entry carries `days_left` — the number
// of days until the date itself (0 = it is today) — which is what the UI
// shows as "还有 N 天".
//
// Note the yearly rollover: a date in late December starts its advance
// window in late December, not in January of the *next* year. We find the
// next occurrence of the month/day, then step backwards by advance_days
// from there.
function importantDateOccurrence(d, now) {
  const advance = normalizeAdvanceDays(d.advance_days);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // The next occurrence of (month, day) on or after today. Feb 29 only
  // exists in leap years — clamp to the last day of the month so a
  // Feb-29 birthday still reminds on Feb 28 in common years.
  let target = clampToMonth(now.getFullYear(), d.month, d.day);
  if (target.getTime() < today.getTime()) {
    target = clampToMonth(now.getFullYear() + 1, d.month, d.day);
  }

  // The first day of the advance window.
  const windowStart = new Date(target.getTime() - advance * DAY_MS);
  if (today.getTime() < windowStart.getTime()) return null;

  // days_left: whole days between today and the target.
  const daysLeft = Math.round((target.getTime() - today.getTime()) / DAY_MS);
  return {
    target,
    windowStart,
    days_left: daysLeft,
    advance_days: advance,
  };
}

// Clamp a (month, day) to a real date in `year`. Feb 29 → Feb 28 in
// non-leap years, Apr 31 → Apr 30, etc.
function clampToMonth(year, month, day) {
  const m = Math.min(12, Math.max(1, month | 0));
  const last = lastDayOfMonth(year, m);
  const d = Math.min(Math.max(1, day | 0), last);
  return new Date(year, m - 1, d);
}

// Normalize an advance_days value: null/absent → the 7-day default,
// negative → 0, and anything absurd is clamped to a year.
function normalizeAdvanceDays(v) {
  if (v == null || v === '') return DEFAULT_ADVANCE_DAYS;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 365);
}

function computeNextFireEvent(ev, now) {
  if (!ev.remind || !ev.active) return null;
  const kind = ev.remind_kind;
  const timeStr = ev.remind_time || DEFAULT_REMIND_TIME;
  const time = parseHhmm(timeStr);
  if (!time) return null;

  // If next_fire_at is already set and in the future, keep it
  if (ev.next_fire_at) {
    const nf = parseDateTime(ev.next_fire_at);
    if (nf && nf.getTime() > now.getTime() + 60_000) return nf;
  }

  let cand = null;
  if (kind === 'one_time') {
    if (!ev.remind_date) return null;
    const d = parseDate(ev.remind_date);
    if (!d) return null;
    cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.h, time.m, 0, 0);
    if (cand.getTime() <= now.getTime()) return null;
  } else if (kind === 'daily') {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.h, time.m, 0, 0);
    if (today.getTime() <= now.getTime() + 60_000) {
      cand = new Date(today.getTime() + 24 * 3600 * 1000);
    } else {
      cand = today;
    }
  } else if (kind === 'weekly') {
    // Every 7 days counted from the anchor date — NOT from "the weekday of
    // the anchor". A user who anchors on a Tuesday gets a Tuesday reminder
    // every week; one who anchors on Sunday gets Sundays.
    cand = nextOccurrenceFromAnchor(anchorFor(ev, now), 7, time, now);
  } else if (kind === 'every_n_days') {
    const n = Math.max(1, Math.floor(Number(ev.interval_days) || 1));
    cand = nextOccurrenceFromAnchor(anchorFor(ev, now), n, time, now);
  } else if (kind === 'monthly') {
    const dayHint = ev.remind_date ? (parseDate(ev.remind_date) || {}).getDate?.() : undefined;
    cand = nextMonthlyAt(now, time, dayHint);
  } else if (kind === 'yearly') {
    // Lunar yearly: fire on the next solar date matching (lunar_month,
    // lunar_day). The solar equivalent shifts year-to-year, so this
    // branch always recomputes from scratch. The early-return guard above
    // only fires when the *cached* next_fire_at is still in the future —
    // between fires we reuse it (it's already correct for this year).
    if (ev.lunar_month && ev.lunar_day) {
      const solar = nextSolarDateForLunar(ev.lunar_month, ev.lunar_day, now);
      if (!solar) return null;
      cand = new Date(
        solar.getFullYear(), solar.getMonth(), solar.getDate(),
        time.h, time.m, 0, 0
      );
    } else {
      let day = 1, month = now.getMonth() + 1;
      if (ev.remind_date) {
        const d = parseDate(ev.remind_date);
        if (d) { day = d.getDate(); month = d.getMonth() + 1; }
      }
      cand = nextYearlyAt(now, day, month, time);
    }
  } else {
    return null;
  }
  return cand;
}

module.exports = {
  DEFAULT_REMIND_TIME,
  DEFAULT_ADVANCE_DAYS,
  DAY_MS,
  parseHhmm,
  formatHhmm,
  fmtDateTime,
  parseDateTime,
  parseDate,
  computeNextFireEvent,
  nextOccurrenceFromAnchor,
  importantDateOccurrence,
  normalizeAdvanceDays,
};