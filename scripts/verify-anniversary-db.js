// scripts/verify-anniversary-db.js — exercises the 今日页's 纪念日
// carousel query against a real database.
//
// The renderer never sees the `important_dates` table directly: the
// `important_dates:list_all` IPC handler joins contacts in and computes
// the two day counts the card shows. This test runs that exact query
// against a throwaway database with a known set of rows, so a mistake in
// the JOIN (a dropped contact, a missing column) or in the day-count
// decoration is caught here rather than showing up as a blank card.
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
  const { nextImportantDateOccurrence } = require('../main/time_util.js');

  await db.open(path.join(tmpDir, 'test.sqlite'));

  // ---- Fixtures ----------------------------------------------------------
  console.log('\n== 准备数据 ==');

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // A contact with two dates, and another with one. The dates are placed
  // relative to today so the day counts are deterministic.
  const mk = (name) => {
    const id = db.newId();
    const ts = db.nowStr();
    db.run(
      `INSERT INTO contacts(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [id, name, ts, ts]
    );
    return id;
  };
  const mkDate = (contactId, label, month, day, year, kind, remindEnabled = 1) => {
    const id = db.newId();
    const ts = db.nowStr();
    db.run(
      `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                   remind_time, advance_days, remind_enabled,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, contactId, label, day, month, year, kind, '09:00', 7, remindEnabled, ts, ts]
    );
    return id;
  };

  const c1 = mk('妈妈');
  const c2 = mk('爸爸');

  // A date that is TODAY.
  const todayDate = mkDate(c1, '生日', today.getMonth() + 1, today.getDate(), 1990, 'birthday');
  // A date 40 days out.
  const future = new Date(today.getTime() + 40 * 86400000);
  mkDate(c1, '结婚纪念日', future.getMonth() + 1, future.getDate(), 2018, 'anniversary');
  // A date on the SAME contact that is already past this year.
  const past = new Date(today.getTime() - 10 * 86400000);
  mkDate(c2, '忌日', past.getMonth() + 1, past.getDate(), 2015, 'deceased_date');
  // A date with NO origin year — no age to report.
  const noYear = new Date(today.getTime() + 100 * 86400000);
  mkDate(c2, '入职', noYear.getMonth() + 1, noYear.getDate(), null, 'custom');
  // A date whose reminder is switched OFF — it must still be listed.
  const muted = new Date(today.getTime() + 5 * 86400000);
  mkDate(c2, '结婚', muted.getMonth() + 1, muted.getDate(), 2010, 'anniversary', 0);

  // ---- The query ---------------------------------------------------------
  //
  // This is the exact SQL + decoration the `important_dates:list_all` IPC
  // handler runs. It is duplicated here on purpose: the handler lives
  // inside main/ipc.js, which pulls in Electron and cannot be required
  // from a plain node script.
  console.log('\n== 列表查询 ==');

  const listAll = () => {
    const t = new Date();
    const day0 = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const rows = db.all(
      `SELECT d.*, c.name AS contact_name
         FROM important_dates d
         LEFT JOIN contacts c ON c.id = d.contact_id
        ORDER BY d.month, d.day`
    );
    return rows.map((row) => {
      const occ = nextImportantDateOccurrence(row, day0);
      return {
        id: row.id,
        contact_id: row.contact_id,
        contact_name: row.contact_name || null,
        label: row.label,
        kind: row.kind,
        month: row.month,
        day: row.day,
        year: row.year || null,
        remind_enabled: !!row.remind_enabled,
        years_since: row.year ? occ.yearsSince : null,
        days_until_next: occ.daysUntilNext,
        next_date: occ.nextDate,
      };
    });
  };

  const all = listAll();
  check('every important date is listed', all.length, 5);

  const byLabel = (label) => all.find((r) => r.label === label);

  // The contact name rides along, joined from the contacts table.
  check('the contact name is joined in', byLabel('生日').contact_name, '妈妈');
  check('the second contact name is joined in', byLabel('忌日').contact_name, '爸爸');

  // The date that is today.
  const todayRow = byLabel('生日');
  check('a date that is today counts 0 days', todayRow.days_until_next, 0);
  check('a date that is today has an age', typeof todayRow.years_since, 'number');

  // The date 40 days out.
  const futureRow = byLabel('结婚纪念日');
  check('a future date counts its days', futureRow.days_until_next, 40);

  // The date that already passed this year — it rolls over to next year.
  const pastRow = byLabel('忌日');
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

  // The ordering is by month then day, so the strip reads as a calendar
  // year rather than in insertion order.
  const monthDays = all.map((r) => r.month * 100 + r.day);
  const sorted = [...monthDays].sort((a, b) => a - b);
  check('the rows come back in calendar order',
    JSON.stringify(monthDays), JSON.stringify(sorted));

  // ---- A contact with no dates -------------------------------------------
  console.log('\n== 边界情况 ==');

  const lonely = mk('没有日期的联系人');
  check('a contact with no dates adds no rows', listAll().length, 5);
  checkTrue('the contact with no dates still exists', !!db.one('SELECT id FROM contacts WHERE id = ?', [lonely]));

  // ---- Deleting a contact cascades its dates ----------------------------
  db.run('DELETE FROM contacts WHERE id = ?', [c2]);
  const afterDelete = listAll();
  check('deleting a contact removes its dates', afterDelete.length, 2);
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
