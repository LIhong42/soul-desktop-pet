// scripts/verify-anniversary-db.js — exercises the 今日页's 纪念日
// carousel query against a real database.
//
// The renderer never sees the `important_dates` or `events` tables
// directly: the `important_dates:list_all` IPC handler calls
// main/anniversaries.js, which gathers the rows and computes the two day
// counts the card shows. This test runs that exact module against a
// throwaway database with a known set of rows, so a mistake in the JOIN
// (a dropped contact, a missing column), in the merge, or in the
// day-count decoration is caught here rather than showing up as a blank
// card.
//
// Run: node scripts/verify-anniversary-db.js

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-anniv-db-'));

async function main() {
  const db = require('../main/db.js');
  const { listAnniversaries } = require('../main/anniversaries.js');

  await db.open(path.join(tmpDir, 'test.sqlite'));

  // ---- Fixtures ----------------------------------------------------------
  console.log('\n== 准备数据 ==');

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ts = db.nowStr();

  // A contact with two dates, and another with one. The dates are placed
  // relative to today so the day counts are deterministic.
  const mk = (name) => {
    const id = db.newId();
    db.run(
      `INSERT INTO contacts(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [id, name, ts, ts]
    );
    return id;
  };
  const mkDate = (contactId, label, month, day, year, kind, remindEnabled = 1) => {
    const id = db.newId();
    db.run(
      `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                   remind_time, advance_days, remind_enabled,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, contactId, label, day, month, year, kind, '09:00', 7, remindEnabled, ts, ts]
    );
    return id;
  };
  // A 提醒日期 row — an event in the `events` table, tagged as an
  // anniversary. `cal` picks solar (remind_date) or lunar.
  const mkEvent = (contactId, title, tagKind, cal, anchor, remind = 1) => {
    const id = db.newId();
    let remindDate = null, lm = null, ld = null;
    if (cal === 'solar') remindDate = anchor;
    else { lm = anchor[0]; ld = anchor[1]; }
    db.run(
      `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                          remind_time, remind_date, next_fire_at, last_fired_at, active,
                          category, tag_kind, lunar_month, lunar_day, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'yearly', '09:00', ?, NULL, NULL, 1, 'general', ?, ?, ?, ?, ?)`,
      // The bind order follows the placeholders in the VALUES list:
      // id, contact_id, title, description, remind, remind_date, tag_kind,
      // lunar_month, lunar_day, created_at, updated_at.
      [id, contactId, title, '', remind, remindDate, tagKind, lm, ld, ts, ts]
    );
    return id;
  };

  const c1 = mk('妈妈');
  const c2 = mk('爸爸');

  // A date that is TODAY — a 忌日, so it counts toward the strip.
  const todayDate = mkDate(c1, '忌日', today.getMonth() + 1, today.getDate(), 1990, 'deceased_date');
  // A date 40 days out.
  const future = new Date(today.getTime() + 40 * 86400000);
  mkDate(c1, '结婚纪念日', future.getMonth() + 1, future.getDate(), 2018, 'anniversary');
  // A date on the SAME contact that is already past this year.
  const past = new Date(today.getTime() - 10 * 86400000);
  mkDate(c2, '忌日2', past.getMonth() + 1, past.getDate(), 2015, 'deceased_date');
  // A date with NO origin year — no age to report.
  const noYear = new Date(today.getTime() + 100 * 86400000);
  mkDate(c2, '入职', noYear.getMonth() + 1, noYear.getDate(), null, 'custom');
  // A date whose reminder is switched OFF — it must still be listed.
  const muted = new Date(today.getTime() + 5 * 86400000);
  mkDate(c2, '结婚', muted.getMonth() + 1, muted.getDate(), 2010, 'anniversary', 0);
  // A BIRTHDAY — the strip rotates anniversaries, not birthdays, so this
  // one must not show up.
  mkDate(c2, '生日', today.getMonth() + 1, today.getDate(), 1995, 'birthday');

  // A 提醒日期 tagged 纪念日 — the kind of row that used to be invisible
  // to the carousel. Its anchor is 12 days out, in 2026 (this year).
  const evSoon = new Date(today.getTime() + 12 * 86400000);
  const evSolar = mkEvent(c1, '爸爸纪念日', 'anniversary', 'solar',
    `${evSoon.getFullYear()}-${String(evSoon.getMonth() + 1).padStart(2, '0')}-${String(evSoon.getDate()).padStart(2, '0')}`);
  // A 提醒日期 tagged 纪念日 with a LUNAR anchor.
  const evLunar = mkEvent(c2, '农历纪念日', 'anniversary', 'lunar', [8, 22]);
  // A 提醒日期 tagged 节日 — NOT an anniversary, so it must not show up.
  const evFestival = mkEvent(c2, '春节', 'festival', 'solar', '2026-02-01');
  // A 提醒日期 with no tag at all — also not an anniversary.
  const evPlain = mkEvent(c2, '普通提醒', null, 'solar', '2026-05-01');
  // A 提醒日期 tagged 生日 — a birthday, not an anniversary.
  const evBirthday = mkEvent(c1, '奶奶生日', 'birthday', 'solar', '2026-12-01');
  // A one-off 提醒日期 tagged 纪念日 — not yearly, so not an anniversary.
  const evOneTime = db.newId();
  db.run(
    `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                        remind_time, remind_date, next_fire_at, last_fired_at, active,
                        category, tag_kind, created_at, updated_at)
     VALUES (?, ?, ?, '', 1, 'one_time', '09:00', ?, NULL, NULL, 1, 'general', 'anniversary', ?, ?)`,
    [evOneTime, c2, '一次性纪念日', '2026-07-01', ts, ts]
  );

  // ---- The query ---------------------------------------------------------
  console.log('\n== 列表查询 ==');

  const listAll = () => listAnniversaries(db);
  const all = listAll();

  // Five important_dates rows (the birthday is excluded) + two event
  // rows. The festival, the untagged, the birthday and the one-off rows
  // are not anniversaries.
  check('every anniversary is listed', all.length, 7);

  const byLabel = (label) => all.find((r) => r.label === label);

  // The contact name rides along, joined from the contacts table.
  check('the contact name is joined in', byLabel('忌日').contact_name, '妈妈');
  check('the second contact name is joined in', byLabel('忌日2').contact_name, '爸爸');

  // The date that is today.
  const todayRow = byLabel('忌日');
  check('a date that is today counts 0 days', todayRow.days_until_next, 0);
  check('a date that is today has an age', typeof todayRow.years_since, 'number');

  // The date 40 days out.
  const futureRow = byLabel('结婚纪念日');
  check('a future date counts its days', futureRow.days_until_next, 40);

  // The date that already passed this year — it rolls over to next year.
  const pastRow = byLabel('忌日2');
  check('a past date rolls to next year',
    new Date(pastRow.next_date).getFullYear(), today.getFullYear() + 1);
  check('a past date still has a positive countdown', pastRow.days_until_next > 300, true);

  // The date with no origin year.
  const noYearRow = byLabel('入职');
  check('a row without an origin year has no age', noYearRow.years_since, null);
  check('a row without an origin year still counts days', noYearRow.days_until_next, 100);

  // The date whose reminder is off — it must still appear in the carousel.
  const mutedRow = byLabel('结婚');
  check('a row with reminders off is still listed', !!mutedRow, true);
  check('a row with reminders off keeps its remind_enabled flag', mutedRow.remind_enabled, false);
  check('a row with reminders off still counts days', mutedRow.days_until_next, 5);

  // ---- The 提醒日期 side --------------------------------------------------
  console.log('\n== 提醒日期里的纪念日 ==');

  const evRow = byLabel('爸爸纪念日');
  checkTrue('a 提醒日期 tagged 纪念日 is listed', !!evRow);
  check('it says where it came from', evRow.source, 'event');
  check('its contact name is joined in', evRow.contact_name, '妈妈');
  check('its tag becomes the card kind', evRow.kind, 'anniversary');
  check('it counts its days', evRow.days_until_next, 12);
  check('its anchor year is the origin year', evRow.year, evSoon.getFullYear());

  const lunarRow = byLabel('农历纪念日');
  checkTrue('a 农历 提醒日期 is listed', !!lunarRow);
  check('it is marked as a lunar date', lunarRow.calendar, 'lunar');
  check('it keeps its lunar month', lunarRow.month, 8);
  check('it keeps its lunar day', lunarRow.day, 22);
  check('a lunar date has no origin year', lunarRow.year, null);
  check('a lunar date has no age to report', lunarRow.years_since, null);
  checkTrue('a lunar date still counts its days',
    typeof lunarRow.days_until_next === 'number' && lunarRow.days_until_next >= 0,
    String(lunarRow.days_until_next));

  // The rows that are NOT anniversaries.
  check('a 节日 is not an anniversary', !!byLabel('春节'), false);
  check('an untagged 提醒日期 is not an anniversary', !!byLabel('普通提醒'), false);
  check('a one-off 提醒日期 is not an anniversary', !!byLabel('一次性纪念日'), false);

  // ---- Birthdays are not in the strip ------------------------------------
  console.log('\n== 生日不进轮播 ==');

  // The strip rotates the ANNIVERSARIES. A birthday is its own kind of
  // thing — it has its own place (the 当前提醒 panel surfaces it on the
  // day, and the contact's detail page lists it) — so it must not take
  // a slot in the strip.
  check('a birthday date is not in the list', !!byLabel('生日'), false);
  check('a 提醒日期 tagged 生日 is not in the list', !!byLabel('奶奶生日'), false);
  checkTrue('no row in the list is a birthday',
    all.every((r) => r.kind !== 'birthday'),
    all.map((r) => `${r.label}:${r.kind}`).join(','));

  // ---- The ordering ------------------------------------------------------
  console.log('\n== 排序 ==');

  // Soonest first — the carousel leads with whatever is next.
  const counts = all.map((r) => r.days_until_next);
  check('the rows come back soonest-first',
    JSON.stringify(counts), JSON.stringify([...counts].sort((a, b) => a - b)));

  // ---- A contact with no dates -------------------------------------------
  console.log('\n== 边界情况 ==');

  const lonely = mk('没有日期的联系人');
  check('a contact with no dates adds no rows', listAll().length, 7);
  checkTrue('the contact with no dates still exists', !!db.one('SELECT id FROM contacts WHERE id = ?', [lonely]));

  // ---- Deleting a contact cascades its dates ----------------------------
  db.run('DELETE FROM contacts WHERE id = ?', [c2]);
  const afterDelete = listAll();
  // 妈妈's two dates + 妈妈's 纪念日 event survive; 爸爸's 忌日2, 结婚,
  // 入职, the lunar event and the one-off all go with him.
  check('deleting a contact removes its dates', afterDelete.length, 3);
  checkTrue('the surviving dates keep their contact name',
    afterDelete.every((r) => r.contact_name === '妈妈'),
    afterDelete.map((r) => r.contact_name).join(','));

  // ---- The empty case ----------------------------------------------------
  db.run('DELETE FROM contacts WHERE id = ?', [c1]);
  check('with no contacts the list is empty', listAll().length, 0);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
