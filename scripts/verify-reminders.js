// scripts/verify-reminders.js — checks the reminder scheduling behaviour.
//
// The reminder logic is subtle in two ways that are easy to break and hard
// to eyeball:
//
//   1. The stride-based repeat kinds (每周 / 每 N 天) count from an ANCHOR
//      date. If the anchor were "whenever we last recalculated", every
//      re-save would shift the user's schedule.
//
//   2. The advance window ("remind me a week early") must fire ONCE PER
//      DAY for the whole window, and must NOT fire again on the same day.
//
// Both are checked here against real databases and the real scheduler, so
// a regression in either shows up as a failed check rather than as a
// surprise in the app.
//
// A third, smaller check covers the renderer-side display rule: an
// untagged reminder's title is auto-generated ("爷爷的提醒") and the content
// the user wrote lives in `description`, so the list has to show both.
//
// Run: node scripts/verify-reminders.js

const fs = require('fs');
const path = require('path');
const tu = require(path.join(__dirname, '..', 'main', 'time_util'));

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

// Format a Date as YYYY-MM-DD for comparison.
function ymd(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

console.log('\n== nextOccurrenceFromAnchor ==');

// Anchor 2026-03-01, every 7 days. "now" before the anchor → the anchor.
check('before anchor → anchor day',
  ymd(tu.nextOccurrenceFromAnchor(new Date(2026, 2, 1), 7, { h: 9, m: 0 }, new Date(2026, 1, 28))),
  '2026-03-01');

// "now" is 2026-03-03 10:00, past the 09:00 anchor slot on the 1st →
// next occurrence is the 8th.
check('past anchor slot → next stride',
  ymd(tu.nextOccurrenceFromAnchor(new Date(2026, 2, 1), 7, { h: 9, m: 0 }, new Date(2026, 2, 3, 10, 0))),
  '2026-03-08');

// Same day but BEFORE the reminder time → still today.
check('same day before time → same day',
  ymd(tu.nextOccurrenceFromAnchor(new Date(2026, 2, 1), 7, { h: 9, m: 0 }, new Date(2026, 2, 1, 8, 0))),
  '2026-03-01');

// "now" is exactly the anchor slot → the next occurrence moves to the next
// stride. This matches the existing `daily` branch (which also advances
// when today's slot has arrived), and the scheduler's own firing window
// (next_fire_at <= now + 30s) is what makes the current slot still fire.
check('exactly at slot → advances to next stride',
  ymd(tu.nextOccurrenceFromAnchor(new Date(2026, 2, 1), 7, { h: 9, m: 0 }, new Date(2026, 2, 1, 9, 0))),
  '2026-03-08');

// Every 3 days from 2026-03-01, now = 2026-03-10 → 03-01, 04, 07, 10,
// 13 → the next one is 03-13.
check('every 3 days → correct stride',
  ymd(tu.nextOccurrenceFromAnchor(new Date(2026, 2, 1), 3, { h: 9, m: 0 }, new Date(2026, 2, 10, 12, 0))),
  '2026-03-13');

// Every 10 days from 2026-01-01, now = 2026-01-01 10:00 → 01-01 elapsed,
// jumps = floor(0/10)+1 = 1 → 01-11.
check('every 10 days → jumps one stride',
  ymd(tu.nextOccurrenceFromAnchor(new Date(2026, 0, 1), 10, { h: 9, m: 0 }, new Date(2026, 0, 1, 10, 0))),
  '2026-01-11');

console.log('\n== computeNextFireEvent: new kinds ==');

const base = { remind: true, active: true, remind_time: '09:00', title: 'x' };

// 每周 anchored on 2026-03-01 (a Sunday). now = 2026-03-04.
check('weekly → 7 days after anchor',
  ymd(tu.computeNextFireEvent(
    { ...base, remind_kind: 'weekly', remind_date: '2026-03-01' },
    new Date(2026, 2, 4, 12, 0))),
  '2026-03-08');

// 每 N 天 anchored on 2026-03-01, interval 5.
check('every_n_days → anchor + 5',
  ymd(tu.computeNextFireEvent(
    { ...base, remind_kind: 'every_n_days', remind_date: '2026-03-01', interval_days: 5 },
    new Date(2026, 2, 4, 12, 0))),
  '2026-03-06');

// The stride must NOT drift when the schedule is recomputed. Feeding a
// series of "now" values that walk forward day by day, the computed
// occurrence must always be the next point on the SAME grid —
// 03-06, 03-11, 03-16, 03-21 — never an off-grid date.
//
// The loop starts at noon on the anchor day, which is already past the
// 09:00 anchor slot, so 03-01 is correctly skipped.
const grid = [];
for (let d = 1; d <= 20; d++) {
  const r = tu.computeNextFireEvent(
    { ...base, remind_kind: 'every_n_days', remind_date: '2026-03-01', interval_days: 5 },
    new Date(2026, 2, d, 12, 0));
  const y = ymd(r);
  if (grid[grid.length - 1] !== y) grid.push(y);
}
const expectedGrid = ['2026-03-06', '2026-03-11', '2026-03-16', '2026-03-21'];
check('every_n_days grid does not drift', grid, expectedGrid);

// A missing interval_days falls back to 1 (every day).
check('every_n_days without interval → 1 day',
  ymd(tu.computeNextFireEvent(
    { ...base, remind_kind: 'every_n_days', remind_date: '2026-03-01' },
    new Date(2026, 2, 1, 12, 0))),
  '2026-03-02');

console.log('\n== importantDateOccurrence (advance window) ==');

const birthday = { month: 3, day: 15, advance_days: 7 };

// 6 days before → inside the window, days_left = 6.
check('D-6 → inside window',
  tu.importantDateOccurrence(birthday, new Date(2026, 2, 9, 10, 0)).days_left, 6);

// The day itself → days_left = 0.
check('D-0 → days_left 0',
  tu.importantDateOccurrence(birthday, new Date(2026, 2, 15, 10, 0)).days_left, 0);

// 8 days before → outside the window → null.
check('D-8 → outside window',
  tu.importantDateOccurrence(birthday, new Date(2026, 2, 7, 10, 0)), null);

// 7 days before → the first day of the window → inside.
check('D-7 → first day of window',
  tu.importantDateOccurrence(birthday, new Date(2026, 2, 8, 10, 0)).days_left, 7);

// A day after the date → rolls over to next year's occurrence, so the
// window is not open yet (next year's D-7 is in December).
check('day after → next year, outside window',
  tu.importantDateOccurrence(birthday, new Date(2026, 2, 16, 10, 0)), null);

// advance_days = 0 → only the day itself fires.
check('advance 0 → only on the day',
  tu.importantDateOccurrence({ ...birthday, advance_days: 0 }, new Date(2026, 2, 14, 10, 0)), null);
check('advance 0 → fires on the day',
  tu.importantDateOccurrence({ ...birthday, advance_days: 0 }, new Date(2026, 2, 15, 10, 0)).days_left, 0);

// advance_days = null → the 7-day default.
check('advance null → 7-day default',
  tu.importantDateOccurrence({ month: 3, day: 15, advance_days: null }, new Date(2026, 2, 9, 10, 0)).days_left, 6);

// Feb 29 in a common year clamps to Feb 28.
check('Feb 29 in 2027 → Feb 28',
  ymd(tu.importantDateOccurrence({ month: 2, day: 29, advance_days: 0 }, new Date(2027, 1, 28, 10, 0)).target),
  '2027-02-28');

// A December date keeps its window in December (no January rollover).
check('Dec 25 window opens in December',
  tu.importantDateOccurrence({ month: 12, day: 25, advance_days: 7 }, new Date(2026, 11, 18, 10, 0)).days_left, 7);

console.log('\n== normalizeAdvanceDays ==');
check('null → 7', tu.normalizeAdvanceDays(null), 7);
check('empty → 7', tu.normalizeAdvanceDays(''), 7);
check('0 → 0', tu.normalizeAdvanceDays(0), 0);
check('-5 → 0', tu.normalizeAdvanceDays(-5), 0);
check('3 → 3', tu.normalizeAdvanceDays(3), 3);
check('999 → 365', tu.normalizeAdvanceDays(999), 365);

// ---------------------------------------------------------------------------
// Database + scheduler checks
// ---------------------------------------------------------------------------
//
// The math above is the pure part. These need a real database, so they run
// against throwaway files in the OS temp dir and never touch the user's
// data.

const os = require('os');
const db = require(path.join(__dirname, '..', 'main', 'db'));
const scheduler = require(path.join(__dirname, '..', 'main', 'scheduler'));

function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `soulpet-${name}-`));
  return { dir, file: path.join(dir, 'test.sqlite') };
}

// ---- The new columns exist, with the right defaults ----
async function checkSchema() {
  console.log('\n== schema ==');
  const { dir, file } = tmpDb('schema');
  await db.open(file);

  const evNames = db.all('PRAGMA table_info(events)').map((c) => c.name);
  check('events has interval_days', evNames.includes('interval_days'), true);
  check('events has advance_days', evNames.includes('advance_days'), true);

  const idNames = db.all('PRAGMA table_info(important_dates)').map((c) => c.name);
  check('important_dates has advance_days', idNames.includes('advance_days'), true);
  check('important_dates has remind_enabled', idNames.includes('remind_enabled'), true);

  // An important date created without the new fields must default to a
  // 7-day advance window and be enabled.
  const now = db.nowStr();
  const contactId = db.newId();
  db.run(
    `INSERT INTO contacts(id, name, relationship, icon_kind, likes_json, taboos_json,
                          gifts_json, listed, created_at, updated_at)
     VALUES (?, ?, '朋友', 'user', '[]', '[]', '[]', 1, ?, ?)`,
    [contactId, '测试联系人', now, now]
  );
  db.run(
    `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                 remind_time, created_at, updated_at)
     VALUES (?, ?, '测试生日', 15, 3, 1990, 'birthday', '09:00', ?, ?)`,
    [db.newId(), contactId, now, now]
  );
  const row = db.one('SELECT * FROM important_dates WHERE label = ?', ['测试生日']);
  check('default advance_days = 7', row.advance_days, 7);
  check('default remind_enabled = 1', row.remind_enabled, 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- Legacy databases upgrade cleanly ----
async function checkLegacyUpgrade() {
  console.log('\n== legacy schema upgrade ==');
  const { dir, file } = tmpDb('legacy');

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  // The schema as it looked BEFORE the granularity work.
  legacy.run(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', relationship TEXT,
      icon_kind TEXT NOT NULL DEFAULT 'user', custom_avatar_path TEXT,
      likes_json TEXT NOT NULL DEFAULT '[]', taboos_json TEXT NOT NULL DEFAULT '[]',
      gifts_json TEXT NOT NULL DEFAULT '[]', listed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE important_dates (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      label TEXT NOT NULL, day INTEGER NOT NULL, month INTEGER NOT NULL, year INTEGER,
      kind TEXT NOT NULL DEFAULT 'birthday', remind_time TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT, remind INTEGER NOT NULL DEFAULT 0,
      remind_kind TEXT NOT NULL DEFAULT 'one_time', remind_time TEXT, remind_date TEXT,
      next_fire_at TEXT, last_fired_at TEXT, active INTEGER NOT NULL DEFAULT 1,
      category TEXT NOT NULL DEFAULT 'general', tag_kind TEXT,
      lunar_month INTEGER, lunar_day INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const stamp = '2026-01-01 00:00:00';
  legacy.run(
    `INSERT INTO contacts(id, name, created_at, updated_at) VALUES ('c1', '旧联系人', ?, ?)`,
    [stamp, stamp]);
  legacy.run(
    `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                  remind_time, created_at, updated_at)
     VALUES ('d1', 'c1', '旧生日', 15, 3, 1990, 'birthday', '09:00', ?, ?)`,
    [stamp, stamp]);
  legacy.run(
    `INSERT INTO events(id, contact_id, title, remind, remind_kind, remind_time,
                         remind_date, next_fire_at, active, created_at, updated_at)
     VALUES ('e1', 'c1', '旧提醒', 1, 'daily', '09:00', '2026-03-01',
             '2026-03-01 09:00:00', 1, ?, ?)`,
    [stamp, stamp]);
  fs.writeFileSync(file, Buffer.from(legacy.export()));

  // Reopen with the app's own db module — this runs SCHEMA + migrations.
  await db.open(file);

  const evNames = db.all('PRAGMA table_info(events)').map((c) => c.name);
  check('legacy: events gains interval_days', evNames.includes('interval_days'), true);
  check('legacy: events gains advance_days', evNames.includes('advance_days'), true);

  const idNames = db.all('PRAGMA table_info(important_dates)').map((c) => c.name);
  check('legacy: important_dates gains advance_days', idNames.includes('advance_days'), true);
  check('legacy: important_dates gains remind_enabled', idNames.includes('remind_enabled'), true);

  // The pre-existing rows must survive the upgrade...
  check('legacy: event row survived',
    db.one('SELECT title FROM events WHERE id=?', ['e1']).title, '旧提醒');
  check('legacy: important_date row survived',
    db.one('SELECT label FROM important_dates WHERE id=?', ['d1']).label, '旧生日');

  // ...and be backfilled with the new defaults: a 7-day advance window
  // for the existing birthday, matching what the user asked for.
  const upgraded = db.one(
    'SELECT advance_days, remind_enabled FROM important_dates WHERE id=?', ['d1']);
  check('legacy: birthday backfilled to advance_days=7', upgraded.advance_days, 7);
  check('legacy: birthday backfilled to remind_enabled=1', upgraded.remind_enabled, 1);

  // A legacy event keeps working with the old repeat kind.
  const ev = db.one('SELECT * FROM events WHERE id=?', ['e1']);
  check('legacy: event keeps remind_kind', ev.remind_kind, 'daily');
  check('legacy: event advance_days defaults to null', ev.advance_days, null);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- The queue rolls over at the day boundary ----
function checkQueueRollover() {
  console.log('\n== queue.rollDay ==');
  const queue = new scheduler.ReminderQueue();

  // The first rollDay always establishes the day (dayStamp starts null),
  // so it reports a rebuild — there is nothing to keep on day one.
  check('first rollDay establishes the day', queue.rollDay('2026-03-01'), false);

  queue.pushIfNew({ source: 'event', source_id: 'e1', title: 'x' });
  check('queue has 1 item', queue.len(), 1);
  check('rollDay same day → no rebuild', queue.rollDay('2026-03-01'), false);
  check('queue still has 1 item', queue.len(), 1);
  check('rollDay new day → rebuild', queue.rollDay('2026-03-02'), true);
  check('queue cleared after rollover', queue.len(), 0);

  // A source can be pushed again after the rollover — this is the bug the
  // rollover fixes: without it, pushIfNew would refuse the second day's nag.
  queue.pushIfNew({ source: 'event', source_id: 'e1', title: 'x' });
  check('re-push same source after rollover works', queue.len(), 1);
}

// ---- The advance window actually fires, once per day ----
async function checkSchedulerFiring() {
  console.log('\n== scheduler: advance-window firing ==');
  const { dir, file } = tmpDb('scan');
  await db.open(file);

  const now = new Date();
  const stamp = db.nowStr();
  const contactId = db.newId();
  db.run(
    `INSERT INTO contacts(id, name, relationship, icon_kind, likes_json, taboos_json,
                          gifts_json, listed, created_at, updated_at)
     VALUES (?, ?, '朋友', 'user', '[]', '[]', '[]', 1, ?, ?)`,
    [contactId, '张三', stamp, stamp]
  );

  // An important date 3 days from now → inside a 7-day advance window.
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
  const dateId = db.newId();
  db.run(
    `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                  remind_time, advance_days, remind_enabled,
                                  created_at, updated_at)
     VALUES (?, ?, '生日', ?, ?, 1990, 'birthday', '09:00', 7, 1, ?, ?)`,
    [dateId, contactId, target.getDate(), target.getMonth() + 1, stamp, stamp]
  );

  // A date whose window genuinely cannot contain today. Picking "today +
  // 365 days" does NOT work: that target is next year, and next year's
  // 7-day window may well still be in the future (e.g. a December date
  // whose window opens in December of this year). Half a year away is
  // safely beyond any 7-day window.
  const far = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 180);
  const farId = db.newId();
  db.run(
    `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                  remind_time, advance_days, remind_enabled,
                                  created_at, updated_at)
     VALUES (?, ?, '远期纪念日', ?, ?, 1990, 'anniversary', '09:00', 7, 1, ?, ?)`,
    [farId, contactId, far.getDate(), far.getMonth() + 1, stamp, stamp]
  );

  // A disabled date inside the window must NOT fire.
  const offTarget = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const offId = db.newId();
  db.run(
    `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                  remind_time, advance_days, remind_enabled,
                                  created_at, updated_at)
     VALUES (?, ?, '已关闭的日期', ?, ?, 1990, 'birthday', '09:00', 7, 0, ?, ?)`,
    [offId, contactId, offTarget.getDate(), offTarget.getMonth() + 1, stamp, stamp]
  );

  const queue = new scheduler.ReminderQueue();
  let petState = false;
  const ctx = {
    queue,
    getPetState: () => petState,
    setPetState: (v) => { petState = v; },
    setActiveReminder: () => {},
    petController: null,
  };

  scheduler.scanAndFire(ctx);

  const items = queue.list();
  const ids = items.map((i) => i.source_id);
  check('advance window fires the near date', ids.includes(dateId), true);
  check('outside the window does not fire', ids.includes(farId), false);
  check('remind_enabled=0 does not fire', ids.includes(offId), false);
  check('exactly one reminder queued', items.length, 1);

  // The countdown must be present and correct.
  const fired = items.find((i) => i.source_id === dateId);
  check('days_left = 3', fired.days_left, 3);
  check('queue item carries advance_days', fired.advance_days, 7);
  check('pet enters REMINDER state', petState, true);

  // ---- The daily cap ----
  // Re-running the scan on the SAME day must not queue it twice.
  scheduler.scanAndFire(ctx);
  check('same day → still one reminder', queue.len(), 1);

  // Rolling to a new day and re-running must fire it AGAIN. This is the
  // behaviour the old queue could not produce: without rollDay, pushIfNew
  // would have seen the source already present and refused the new nag.
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  const tomorrowStr =
    `${tomorrow.getFullYear()}-${p(tomorrow.getMonth() + 1)}-${p(tomorrow.getDate())}`;
  queue.rollDay(tomorrowStr);
  check('rollDay cleared the queue', queue.len(), 0);
  scheduler.scanAndFire(ctx);
  check('new day → fires again', queue.len(), 1);

  // ---- Each day of the window is independent ----
  // Acknowledging the date today must silence TODAY only. Tomorrow's nag
  // still fires — that is what "remind me once a day during the window"
  // means. The per-day ack lookup (acked_at's date prefix) is what makes
  // this work; a blanket ack would silence the whole window.
  queue.rollDay(tomorrowStr);
  scheduler.scanAndFire(ctx);
  check('rolled to tomorrow, fired again', queue.len(), 1);

  // Acknowledge it "today" (the ack row is stamped with nowStr, which is
  // today in the DB's terms). The queue item must flip to dismissed...
  queue.dismissForToday('important_date', dateId);
  check('dismissed flag set', queue.activeCount(), 0);
  check('item still visible in the queue', queue.len(), 1);

  // ...and tomorrow's scan must produce a fresh, non-dismissed item.
  const dayAfter = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const dayAfterStr =
    `${dayAfter.getFullYear()}-${p(dayAfter.getMonth() + 1)}-${p(dayAfter.getDate())}`;
  queue.rollDay(dayAfterStr);
  scheduler.scanAndFire(ctx);
  check('day after → fires again', queue.len(), 1);
  check('day after → not dismissed (acks are per-day)', queue.activeCount(), 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- Display title (renderer-side) ----
//
// The list must show the user's description for untagged reminders, whose
// title is only an auto-generated label ("爷爷的提醒"). The helpers live in
// src/js/api.js, which is an ES module that needs `window.mp` at import
// time — so we pull the two function bodies straight out of the source and
// evaluate them here. That way the test exercises the REAL implementation
// rather than a copy that could drift.
function checkDisplayTitle() {
  console.log('\n== eventDisplayTitle ==');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'api.js'), 'utf8',
  );
  // Grab "export function eventDisplayTitle(...) { … }" up to the closing
  // brace at column 0, plus the eventDescription helper it calls.
  const grab = (name) => {
    const start = src.indexOf(`export function ${name}(`);
    if (start === -1) throw new Error(`${name} not found in api.js`);
    const end = src.indexOf('\n}\n', start);
    if (end === -1) throw new Error(`could not find end of ${name}`);
    return src.slice(start, end + 3).replace(/^export /, '');
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${grab('eventDescription')}\n${grab('eventDisplayTitle')}\nreturn { eventDisplayTitle, eventDescription };`);
  const { eventDisplayTitle } = factory();

  check('untagged + description → "爷爷的提醒 — 打电话"',
    eventDisplayTitle({ title: '爷爷的提醒', description: '打电话' }),
    '爷爷的提醒 — 打电话');

  check('untagged, no description → title only',
    eventDisplayTitle({ title: '爷爷的提醒', description: '' }),
    '爷爷的提醒');

  check('untagged, whitespace-only description → title only',
    eventDisplayTitle({ title: '爷爷的提醒', description: '   ' }),
    '爷爷的提醒');

  check('untagged, null description → title only',
    eventDisplayTitle({ title: '爷爷的提醒', description: null }),
    '爷爷的提醒');

  check('tagged + description → "刘杰的生日 — 买蛋糕"',
    eventDisplayTitle({ title: '刘杰的生日', description: '买蛋糕', tag_kind: 'birthday' }),
    '刘杰的生日 — 买蛋糕');

  check('explicit displayTitle overrides e.title',
    eventDisplayTitle({ title: 'raw', description: '打电话' }, '爷爷的提醒'),
    '爷爷的提醒 — 打电话');

  check('no title, has description → description only',
    eventDisplayTitle({ title: '', description: '打电话' }),
    '打电话');

  check('no title, no description → empty string',
    eventDisplayTitle({ title: '', description: null }),
    '');
}

(async () => {
  await checkSchema();
  await checkLegacyUpgrade();
  checkQueueRollover();
  await checkSchedulerFiring();
  checkDisplayTitle();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
