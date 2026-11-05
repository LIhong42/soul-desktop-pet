// main/lunar.js — lunar↔solar helpers backed by lunar-javascript.
// Lazy-loaded so the library is only required when a feature actually uses it.
//
// lunar-javascript's API quirk: it uses `Lunar.fromYmd(year, month, day)` to
// build a lunar date, where `year` is the *solar* year the lunar date falls
// in (NOT the Chinese lunar year — those usually coincide but a lunar date
// in early January can belong to the prior lunar year). The returned
// instance's `.getSolar()` gives the actual solar Date.

let _lib = null;
function lib() {
  if (!_lib) {
    _lib = require('lunar-javascript');
  }
  return _lib;
}

// Find the next solar Date on or after `fromDate` whose lunar (month, day)
// matches. We iterate solar years and ask "given lunar (year, month, day),
// what's the solar date?" — picking the first result that lands strictly
// after `fromDate` (with a 60-second margin to match the existing
// nextYearlyAt convention).
//
// Non-leap semantics: we never pass `isLeapMonth=true` to Lunar.fromYmd.
// Lunar birthdays in a leap month conventionally roll to the non-leap
// month, and most users will not need the leap-month distinction.
//
// Returns null if no occurrence is found within ~5 years (should never
// happen for valid (1-12, 1-30) inputs).
function nextSolarDateForLunar(lunarMonth, lunarDay, fromDate) {
  if (!lunarMonth || !lunarDay) return null;
  const { Lunar } = lib();
  const startYear = fromDate.getFullYear();
  for (let i = 0; i < 6; i++) {
    const year = startYear + i;
    let solar;
    try {
      const lun = Lunar.fromYmd(year, lunarMonth, lunarDay);
      solar = lun.getSolar();
    } catch (e) {
      // (month, day) doesn't exist in this year — try next year.
      continue;
    }
    const cand = new Date(
      solar.getYear(),
      solar.getMonth() - 1,
      solar.getDay(),
      0, 0, 0, 0
    );
    if (cand.getTime() > fromDate.getTime() + 60_000) return cand;
  }
  return null;
}

// Validate a (lunarMonth, lunarDay) pair across multiple years. A pair is
// considered valid if it exists in at least one year within a small probe
// window. This catches obviously-bad inputs (month 0/13, day 0/31) without
// over-rejecting pairs that only fail in specific years.
function validateLunar(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(m) || m < 1 || m > 12) {
    return { ok: false, reason: '农历月份必须在 1–12 之间' };
  }
  if (!Number.isFinite(d) || d < 1 || d > 30) {
    return { ok: false, reason: '农历日期必须在 1–30 之间' };
  }
  const { Lunar } = lib();
  for (const year of [2000, 2001, 2020, 2024, 2025]) {
    try {
      const lun = Lunar.fromYmd(year, m, d);
      // Touch getSolar() to confirm the conversion succeeded (some library
      // versions return a stub object instead of throwing on bad inputs).
      lun.getSolar().getYear();
      return { ok: true };
    } catch (e) {
      // try next probe year
    }
  }
  return { ok: false, reason: '该农历日期不存在' };
}

// Compute the solar YYYY-MM-DD for a given lunar (year, month, day).
// `year` is the *solar* year the lunar date falls in (see file header).
// Returns null on failure (out of range, day doesn't exist, etc.).
function lunarToSolarYmd(lunarYear, lunarMonth, lunarDay) {
  const { Lunar } = lib();
  try {
    const lun = Lunar.fromYmd(lunarYear, lunarMonth, lunarDay);
    const solar = lun.getSolar();
    const pad = (n) => String(n).padStart(2, '0');
    return `${solar.getYear()}-${pad(solar.getMonth())}-${pad(solar.getDay())}`;
  } catch (e) {
    return null;
  }
}

// The lunar date of a solar date, as { year, month, day }.
//
// The lunar *year* is what "how many years has this been" counts for a
// lunar anniversary: a 农历 birthday recurs on the same lunar date every
// year, and the number of lunar years since the origin is what the user
// means by "至今 N 年" — even though the solar date of that lunar day
// shifts by a month or so from year to year.
//
// `year` here is the Chinese lunar year proper (which is what
// `.getYear()` returns), NOT the solar year the lunar date falls in.
function solarToLunar(date) {
  const { Solar } = lib();
  try {
    const lunar = Solar.fromYmd(
      date.getFullYear(), date.getMonth() + 1, date.getDate()
    ).getLunar();
    return {
      year: lunar.getYear(),
      month: lunar.getMonth(),
      day: lunar.getDay(),
    };
  } catch (e) {
    return null;
  }
}

// The occurrence of a lunar (month, day) that is NEXT relative to
// `today` — the same day-or-after rule the solar anniversaries use —
// plus how many lunar years have passed since the origin.
//
// `originLunarYear` is the lunar year the anniversary was first
// observed. Without it there is no "since" number, and the card shows
// the countdown alone.
//
// The "since" count is measured at the LAST occurrence on or before
// today, exactly like the solar rule: the number ticks up ON the
// anniversary and then holds for the rest of the lunar year. It never
// jumps in the middle of the night.
//
// Returns null when the lunar date can't be resolved.
function nextLunarOccurrence(lunarMonth, lunarDay, originLunarYear, today) {
  if (!lunarMonth || !lunarDay) return null;
  const { Lunar } = lib();

  // The most recent occurrence on or before today. Candidates are the
  // same lunar date in this solar year and in the previous one — the
  // lunar date of a solar day can fall in either.
  const thisLunar = solarToLunar(today);
  let lastOccurrence = null;
  for (const solarYear of [today.getFullYear(), today.getFullYear() - 1]) {
    let solar;
    try {
      solar = Lunar.fromYmd(solarYear, lunarMonth, lunarDay).getSolar();
    } catch (e) {
      continue;
    }
    const cand = new Date(
      solar.getYear(), solar.getMonth() - 1, solar.getDay(), 0, 0, 0, 0
    );
    if (cand.getTime() <= today.getTime() && cand.getTime() > 0) {
      if (!lastOccurrence || cand.getTime() > lastOccurrence.getTime()) {
        lastOccurrence = cand;
      }
    }
  }

  let yearsSince = null;
  if (originLunarYear && lastOccurrence) {
    const occLunar = solarToLunar(lastOccurrence);
    if (occLunar) {
      yearsSince = Math.max(0, occLunar.year - originLunarYear);
    }
  }

  // The NEXT occurrence — on or after today.
  const next = nextSolarDateForLunar(lunarMonth, lunarDay, new Date(
    today.getFullYear(), today.getMonth(), today.getDate() - 1, 0, 0, 0, 0
  ));
  if (!next) return null;
  const daysUntilNext = Math.round(
    (next.getTime() - today.getTime()) / (24 * 3600 * 1000)
  );

  return { nextDate: next, daysUntilNext, yearsSince };
}

module.exports = {
  nextSolarDateForLunar,
  validateLunar,
  lunarToSolarYmd,
  solarToLunar,
  nextLunarOccurrence,
};
