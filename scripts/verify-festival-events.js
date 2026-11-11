// scripts/verify-festival-events.js — checks the 节日 (festival) event type.
//
// The festival type is unusual: a festival row stores the festival CODE as
// its TITLE (the server rejects a festival row whose title is not a
// built-in code), and it fires on the festival's OWN date rather than on
// a date the user typed.
//
// Three things can go wrong, and each of them is silent:
//
//   1. The fire date is taken from the form's date field instead of the
//      festival code — the reminder then fires on the wrong day.
//   2. The festival code leaks into a row that is no longer a festival
//      (the user switched 类型 away from 节日) — the list then shows a
//      raw code like "fathers_day" as the row's title.
//   3. A festival row is created with a repeat kind that fires once and
//      never again, so it never reminds on the festival again.
//
// Run: node scripts/verify-festival-events.js

const fs = require('fs');
const path = require('path');

const db = require(path.join(__dirname, '..', 'main', 'db'));
const tu = require(path.join(__dirname, '..', 'main', 'time_util'));
const { listFestivals, festivalLabel } = require(path.join(__dirname, '..', 'main', 'festivals'));

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`);
  }
}

function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), `soulpet-${name}-`));
  return { dir, file: path.join(dir, 'test.sqlite') };
}

function ymd(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The rows the app seeds on a fresh install: one per built-in festival,
// tagged 'festival' with the code as the title and a yearly repeat.
console.log('\n== the catalog ==');

const catalog = listFestivals();
checkTrue('the catalog is not empty', catalog.length > 0, `got ${catalog.length}`);
checkTrue('every entry has a code and a label',
  catalog.every((f) => f.code && f.label));
check('the codes are unique',
  catalog.length, new Set(catalog.map((f) => f.code)).size);
check('a code resolves back to its label',
  festivalLabel('fathers_day'), '父亲节');
check('an unknown code resolves to null',
  festivalLabel('not_a_festival'), null);

console.log('\n== a festival row fires on the festival date ==');

// The seeded rows carry the code as the title and a yearly repeat. The
// fire date must come from the code — the seed stores the festival's next
// date in remind_date, but a row whose remind_date was edited by hand (or
// that was created from the form with a date the user typed) must still
// fire on the festival's own day.
const festivals = listFestivals();
const christmas = festivals.find((f) => f.code === 'christmas');

check('圣诞节 is in the catalog', !!christmas, true);

const base = {
  remind: true, active: true, remind_time: '09:00',
  remind_kind: 'yearly', title: 'christmas', tag_kind: 'festival',
};

// The form's date is deliberately a different day.
check('the festival date wins over the form date',
  ymd(tu.computeNextFireEvent(
    { ...base, remind_date: '2026-03-01' },
    new Date(2026, 2, 1, 12, 0))),
  '2026-12-25');

check('a festival with no remind_date still fires',
  ymd(tu.computeNextFireEvent(
    { ...base, remind_date: null },
    new Date(2026, 2, 1, 12, 0))),
  '2026-12-25');

// Every catalog entry must resolve to a date in the coming year.
const unresolved = festivals.filter((f) => {
  const next = tu.computeNextFireEvent(
    { ...base, title: f.code, remind_date: null },
    new Date(2026, 2, 1, 12, 0));
  return !next;
});
check('every catalog entry resolves to a fire date', unresolved.map((f) => f.code), []);

console.log('\n== the seeded rows ==');

async function checkSeed() {
  const { file } = tmpDb('festivals');
  await db.open(file);

  // The seed runs on open. Every catalog entry should have a row.
  const rows = db.all(
    `SELECT title, tag_kind, remind_kind, remind_date, next_fire_at
       FROM events WHERE tag_kind = 'festival'`);
  check('the seed created one row per festival', rows.length, catalog.length);

  const withFire = rows.filter((r) => r.next_fire_at);
  check('every seeded festival has a fire date',
    withFire.length, rows.length);

  // The seeded rows must all point at their own festival's date.
  //
  // The reference "now" has to be the same one the seed used, or the two
  // sides disagree for the wrong reason: the seed resolves each festival
  // from the CURRENT date, so a festival whose 2026 date has already
  // passed is seeded with its 2027 date — while a recomputation from an
  // earlier "now" would land on the 2026 one. Both are correct; they are
  // answers to different questions.
  const seededNow = new Date();
  const wrong = rows.filter((r) => {
    const next = tu.computeNextFireEvent(
      { ...base, title: r.title, remind_date: r.remind_date },
      seededNow);
    return ymd(next) !== r.next_fire_at.slice(0, 10);
  });
  check('every seeded festival fires on its own date',
    wrong.map((r) => r.title), []);
}

console.log('\n== a festival row is not prunable by the auto-cleanup ==');

async function checkCleanup() {
  const reminderCleanup = require(path.join(__dirname, '..', 'main', 'reminder_cleanup'));
  // A festival row repeats every year, so it must never be swept by the
  // "completed more than a day ago" cleanup.
  const ev = {
    remind: 1,
    remind_kind: 'yearly',
    tag_kind: 'festival',
    title: 'christmas',
    last_fired_at: '2020-12-25 09:00:00',
    next_fire_at: '2026-12-25 09:00:00',
  };
  check('a yearly festival is not prunable',
    reminderCleanup.isPrunableEvent(ev, new Date(2026, 2, 15, 12, 0)),
    false);
}

(async () => {
  await checkSeed();
  await checkCleanup();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
