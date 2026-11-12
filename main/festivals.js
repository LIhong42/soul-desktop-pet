// main/festivals.js — built-in festival catalog for the events "节日" tag.
//
// Each festival is a meaningful day the user might want to be reminded of
// even though it is not a public holiday in China. Solar dates are stored as
// (month, day); for floating festivals (e.g. Father's Day = 3rd Sunday of
// June) the entry is marked `floating: 'nth-weekday'` and resolved at
// runtime against `now`.

// Static (fixed solar date) festivals.
const STATIC_FESTIVALS = [
  { code: 'teachers_day',     label: '教师节',       month:  9, day: 10 },
  { code: 'valentines_day',   label: '情人节',       month:  2, day: 14 },
  { code: 'white_day',        label: '白色情人节',   month:  3, day: 14 },
  { code: 'christmas',        label: '圣诞节',       month: 12, day: 25 },
  { code: 'halloween',        label: '万圣节',       month: 10, day: 31 },
  { code: 'april_fools',      label: '愚人节',       month:  4, day:  1 },
  { code: 'tanabata_lunar',   label: '七夕（农历）', month:  0, day:  0, lunar: true, lunar_month: 7, lunar_day: 7 },
];

// Floating (computed) festivals. Resolved against a Date `now` to produce
// the next occurrence. `floating` shape: { nth: 1..5, weekday: 0..6 (Sun=0) }.
const FLOATING_FESTIVALS = [
  { code: 'fathers_day',  label: '父亲节', floating: { nth: 3, weekday: 0 }, month:  6 }, // 3rd Sunday of June
  { code: 'mothers_day',  label: '母亲节', floating: { nth: 2, weekday: 0 }, month:  5 }, // 2nd Sunday of May
  { code: 'thanksgiving', label: '感恩节', floating: { nth: 4, weekday: 4 }, month: 11 }, // 4th Thursday of November
];

// Find the nth occurrence of `weekday` in `month` (1-12) of `year`. e.g.
// 3rd Sunday of June 2025 → June 15.
function nthWeekdayOfMonth(year, month /* 1-12 */, nth /* 1..5 */, weekday /* 0..6 Sun=0 */) {
  const first = new Date(year, month - 1, 1);
  const firstWeekday = first.getDay();
  // Day of month of the first `weekday` occurrence.
  const firstOccur = 1 + ((7 + weekday - firstWeekday) % 7);
  return firstOccur + (nth - 1) * 7;
}

// Get the solar month/day for a floating festival on or after `now`.
function nextFloatingDate(festival, now) {
  const { month, floating } = festival;
  const startYear = now.getFullYear();
  for (let y = startYear; y <= startYear + 1; y++) {
    const day = nthWeekdayOfMonth(y, month, floating.nth, floating.weekday);
    const cand = new Date(y, month - 1, day, 0, 0, 0, 0);
    if (cand.getTime() > now.getTime() + 60_000) return cand;
  }
  return null;
}

// Return the list of built-in festivals with code + label. Used by the
// renderer to populate the 标签 dropdown when 类型 === 'festival'.
function listFestivals() {
  const out = [];
  for (const f of STATIC_FESTIVALS) {
    out.push({ code: f.code, label: f.label });
  }
  for (const f of FLOATING_FESTIVALS) {
    out.push({ code: f.code, label: f.label });
  }
  return out;
}

// Given a festival code + a base "now", return the next solar (month, day)
// on which the festival falls. Used by computeNextFireEvent when the user
// picks a festival as the event's 标签.
//
// Returns null for unknown codes.
function nextFestivalSolar(code, now) {
  const staticMatch = STATIC_FESTIVALS.find((f) => f.code === code);
  if (staticMatch) {
    if (staticMatch.lunar) {
      // Defer to lunar computation. Imported lazily to avoid a circular
      // require between festivals.js and lunar.js.
      const { nextSolarDateForLunar } = require('./lunar');
      const solar = nextSolarDateForLunar(staticMatch.lunar_month, staticMatch.lunar_day, now);
      if (!solar) return null;
      return { month: solar.getMonth() + 1, day: solar.getDate(), year: solar.getFullYear() };
    }
    const startYear = now.getFullYear();
    for (let y = startYear; y <= startYear + 1; y++) {
      const cand = new Date(y, staticMatch.month - 1, staticMatch.day, 0, 0, 0, 0);
      if (cand.getTime() > now.getTime() + 60_000) {
        return { month: staticMatch.month, day: staticMatch.day, year: y };
      }
    }
    return null;
  }
  const floatingMatch = FLOATING_FESTIVALS.find((f) => f.code === code);
  if (floatingMatch) {
    const cand = nextFloatingDate(floatingMatch, now);
    if (!cand) return null;
    return { month: cand.getMonth() + 1, day: cand.getDate(), year: cand.getFullYear() };
  }
  return null;
}

// Resolve a festival code back to a human label, or null if unknown.
function festivalLabel(code) {
  for (const f of STATIC_FESTIVALS) if (f.code === code) return f.label;
  for (const f of FLOATING_FESTIVALS) if (f.code === code) return f.label;
  return null;
}

module.exports = {
  listFestivals,
  nextFestivalSolar,
  festivalLabel,
};
