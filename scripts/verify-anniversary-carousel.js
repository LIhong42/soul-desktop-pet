// scripts/verify-anniversary-carousel.js — guards the two numbers the
// 今日页's 纪念日 carousel shows, both of which are easy to get subtly
// wrong and hard to notice when they break:
//
//   1. days_until_next — whole days from today to the next occurrence of
//      (month, day). 0 means it is today, and the count must roll over to
//      next year the day AFTER the date, not on the date itself.
//
//   2. years_since — the "至今 N 年" age. It must be measured at the NEXT
//      occurrence, not today, so the number the user reads stays stable
//      for the whole year instead of flipping on the birthday itself.
//      A row with no origin year has no age at all (null, not 0).
//
// Usage: node scripts/verify-anniversary-carousel.js

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { nextImportantDateOccurrence } = require(path.join(ROOT, 'main', 'time_util.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push({ name, detail }); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// A midnight-normalized date, the shape the helper expects.
const day = (y, m, d) => new Date(y, m - 1, d);

// ---- 1. days_until_next --------------------------------------------------

console.log('\n[1] days_until_next counts to the next occurrence');

// A date that is today → 0 days, and it stays on THIS year.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5 }, day(2026, 11, 5));
  check('a date that is today is 0 days away', occ.daysUntilNext === 0, String(occ.daysUntilNext));
  check('a date that is today lands on this year', occ.nextDate.getFullYear() === 2026);
}

// The day before → 1 day, still this year.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5 }, day(2026, 11, 4));
  check('the day before is 1 day away', occ.daysUntilNext === 1, String(occ.daysUntilNext));
  check('the day before lands on this year', occ.nextDate.getFullYear() === 2026);
}

// The day after → it rolls over to NEXT year. The span is 364 days, not
// 365: the target is one day BEFORE the anniversary, so a full year's
// span minus the day already elapsed.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5 }, day(2026, 11, 6));
  check('the day after rolls to next year', occ.nextDate.getFullYear() === 2027, String(occ.nextDate.getFullYear()));
  check('the day after is 364 days away', occ.daysUntilNext === 364, String(occ.daysUntilNext));
}

// A year-end date. The rollover must not slip into January.
{
  const occ = nextImportantDateOccurrence({ month: 12, day: 25 }, day(2026, 12, 26));
  check('a late-December date rolls to next December', occ.nextDate.getFullYear() === 2027);
  check('a late-December date rolls to Dec 25', occ.nextDate.getMonth() === 11 && occ.nextDate.getDate() === 25);
}

// A long countdown.
{
  const occ = nextImportantDateOccurrence({ month: 12, day: 25 }, day(2026, 6, 1));
  check('a mid-year countdown is 207 days', occ.daysUntilNext === 207, String(occ.daysUntilNext));
}

// A leap-day birthday. Feb 29 doesn't exist in a common year, so the
// occurrence is clamped to Feb 28 rather than skipped or wrapped.
{
  const occ = nextImportantDateOccurrence({ month: 2, day: 29 }, day(2026, 1, 1));
  check('Feb 29 clamps to Feb 28 in a common year', occ.nextDate.getDate() === 28, String(occ.nextDate.getDate()));
  check('Feb 29 in a common year lands in February', occ.nextDate.getMonth() === 1, String(occ.nextDate.getMonth()));
  check('Feb 29 in a common year keeps this year', occ.nextDate.getFullYear() === 2026);
}
{
  const occ = nextImportantDateOccurrence({ month: 2, day: 29 }, day(2028, 1, 1));
  check('Feb 29 lands on Feb 29 in a leap year', occ.nextDate.getDate() === 29, String(occ.nextDate.getDate()));
}

// The count must be exact across a leap boundary. From 2028-03-01 the
// next occurrence is Feb 28, 2029 — the Feb 29 date clamps to Feb 28 in
// the common year, which is one day short of the full 365-day span.
{
  const occ = nextImportantDateOccurrence({ month: 2, day: 29 }, day(2028, 3, 1));
  check('after a leap day the count is 364', occ.daysUntilNext === 364, String(occ.daysUntilNext));
  check('after a leap day the date clamps to Feb 28', occ.nextDate.getMonth() === 1 && occ.nextDate.getDate() === 28,
    `${occ.nextDate.getMonth() + 1}-${occ.nextDate.getDate()}`);
}

// An out-of-range month/day must not throw — it clamps instead.
{
  let threw = null;
  let occ = null;
  try { occ = nextImportantDateOccurrence({ month: 13, day: 40 }, day(2026, 1, 1)); }
  catch (e) { threw = e; }
  check('an out-of-range month/day does not throw', threw === null, threw && threw.message);
  check('an out-of-range month/day still returns a count', occ && typeof occ.daysUntilNext === 'number');
}

// ---- 2. years_since ------------------------------------------------------

console.log('\n[2] years_since is the age as of today');

// The core case: a birthday recorded with its origin year, viewed BEFORE
// the date in the current year. The age is measured at the last
// anniversary that has already happened — so a 1990 birthday on Nov 5,
// viewed on Nov 1, 2026, reads 35: the last time it happened was
// Nov 5, 2025.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5, year: 1990 }, day(2026, 11, 1));
  check('the age before the date is the last year\'s', occ.yearsSince === 35, String(occ.yearsSince));
}

// Viewed ON the date: the anniversary is today, so the age ticks up.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5, year: 1990 }, day(2026, 11, 5));
  check('the age ticks up on the date itself', occ.yearsSince === 36, String(occ.yearsSince));
}

// Viewed AFTER the date: the age stays at what it became on the date. It
// must NOT jump to next year's age the day after — that is the "the
// number jumped overnight" bug.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5, year: 1990 }, day(2026, 11, 6));
  check('the age holds after the date', occ.yearsSince === 36, String(occ.yearsSince));
}

// The age must NOT flip mid-year: December and January of the same
// birthday year both read 36.
{
  const dec = nextImportantDateOccurrence({ month: 11, day: 5, year: 1990 }, day(2026, 12, 25));
  const jan = nextImportantDateOccurrence({ month: 11, day: 5, year: 1990 }, day(2027, 1, 5));
  check('the age stays 36 across the new year', dec.yearsSince === 36 && jan.yearsSince === 36,
    `${dec.yearsSince} / ${jan.yearsSince}`);
}

// And it must tick up exactly once a year, on the date.
{
  const before = nextImportantDateOccurrence({ month: 11, day: 5, year: 1990 }, day(2027, 11, 4));
  const on = nextImportantDateOccurrence({ month: 11, day: 5, year: 1990 }, day(2027, 11, 5));
  check('the age ticks up exactly on the date', before.yearsSince === 36 && on.yearsSince === 37,
    `${before.yearsSince} / ${on.yearsSince}`);
}

// A date whose month/day is EARLIER in the year than today: the last
// anniversary was this year, so the age reflects it. (Jan 5 viewed in
// December — the birthday already happened this year.)
{
  const occ = nextImportantDateOccurrence({ month: 1, day: 5, year: 1990 }, day(2026, 12, 25));
  check('a birthday earlier in the year counts this year', occ.yearsSince === 36, String(occ.yearsSince));
}

// A row with no origin year has no age — null, so the card omits the
// "至今 N 年" clause instead of printing "至今 0 年".
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5, year: null }, day(2026, 11, 1));
  check('a row without an origin year has no age', occ.yearsSince === null, String(occ.yearsSince));
}
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5 }, day(2026, 11, 1));
  check('a missing year field also has no age', occ.yearsSince === null, String(occ.yearsSince));
}

// An origin year in the future (a typo, or a birthday recorded before it
// happened) clamps to 0 rather than going negative.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5, year: 2030 }, day(2026, 11, 1));
  check('a future origin year clamps to 0', occ.yearsSince === 0, String(occ.yearsSince));
}

// A 忌日 (deceased date) recorded with its year — the age is the number
// of years since the person passed.
{
  const occ = nextImportantDateOccurrence({ month: 3, day: 2, year: 2015 }, day(2026, 3, 2));
  check('a 忌日 reads the years since', occ.yearsSince === 11, String(occ.yearsSince));
}

// ---- 3. days_since -------------------------------------------------------
//
// The "纪念日至今 N 天" clause. It counts the DAYS from the origin date
// to today, which is a different number from yearsSince: the years are
// rounded down to whole years, the days are exact.

console.log('\n[3] days_since is the exact day count from the origin date');

// The core case: an anniversary recorded with its origin date, viewed
// later. The day count is the exact distance between the two calendar
// days — no rounding, no anniversary resetting.
{
  const occ = nextImportantDateOccurrence({ month: 8, day: 16, year: 2019 }, day(2026, 11, 6));
  const expected = Math.round((day(2026, 11, 6) - day(2019, 8, 16)) / 86400000);
  check('the day count is the exact distance from the origin',
    occ.daysSince === expected, `${occ.daysSince} vs ${expected}`);
}

// The day count must NOT reset on the anniversary. A year later it is
// bigger by the days in between, even though yearsSince may have ticked
// up too.
{
  const before = nextImportantDateOccurrence({ month: 8, day: 16, year: 2019 }, day(2026, 8, 15));
  const on = nextImportantDateOccurrence({ month: 8, day: 16, year: 2019 }, day(2026, 8, 16));
  check('the day count does not reset on the anniversary',
    on.daysSince === before.daysSince + 1, `${before.daysSince} → ${on.daysSince}`);
}

// The origin day itself reads 0 days. That is a REAL state — the
// anniversary started today — and it is different from "no origin year",
// which is null.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 6, year: 2026 }, day(2026, 11, 6));
  check('an origin date of today reads 0 days', occ.daysSince === 0, String(occ.daysSince));
}

// A row with no origin year has no origin DATE either, so there is
// nothing to count from: null, not 0.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5, year: null }, day(2026, 11, 1));
  check('a row without an origin year has no day count', occ.daysSince === null, String(occ.daysSince));
}
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5 }, day(2026, 11, 1));
  check('a missing year field also has no day count', occ.daysSince === null, String(occ.daysSince));
}

// An origin year in the future has not happened yet — the count clamps
// at 0 rather than going negative.
{
  const occ = nextImportantDateOccurrence({ month: 11, day: 5, year: 2030 }, day(2026, 11, 1));
  check('a future origin date clamps to 0 days', occ.daysSince === 0, String(occ.daysSince));
}

// A leap-day origin is clamped to a real calendar day, the same way the
// occurrence is. 2021 is a common year, so Feb 29 lands on Feb 28.
{
  const occ = nextImportantDateOccurrence({ month: 2, day: 29, year: 2021 }, day(2026, 11, 6));
  const expected = Math.round((day(2026, 11, 6) - day(2021, 2, 28)) / 86400000);
  check('a leap-day origin clamps to Feb 28 in a common year',
    occ.daysSince === expected, `${occ.daysSince} vs ${expected}`);
}

// A leap-day origin in a leap year lands on Feb 29 itself.
{
  const occ = nextImportantDateOccurrence({ month: 2, day: 29, year: 2020 }, day(2026, 11, 6));
  const expected = Math.round((day(2026, 11, 6) - day(2020, 2, 29)) / 86400000);
  check('a leap-day origin lands on Feb 29 in a leap year',
    occ.daysSince === expected, `${occ.daysSince} vs ${expected}`);
}

// The count must be exact across a leap boundary: a 2020 origin counts
// the extra Feb 29 of 2024 along the way.
{
  const occ = nextImportantDateOccurrence({ month: 1, day: 1, year: 2020 }, day(2026, 1, 1));
  check('the day count is exact across a leap year', occ.daysSince === 2192, String(occ.daysSince));
}

// ---- Report --------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
