// scripts/verify-reminder-cleanup.js — checks the auto-delete of finished reminders.
//
// The rule the user asked for:
//
//   已完成超过一天，且今后不会再进行提醒的事件 → 从数据库删除
//
// That is two conditions, and the interesting part is how easy it is to
// delete the WRONG rows. A reminder that will fire again must survive; a
// reminder that finished today must survive (the user may still be
// looking at it); a muted row must survive (the user may re-enable it).
//
// These checks run against real throwaway databases in the OS temp dir —
// they never touch the user's data.
//
// Run: node scripts/verify-reminder-cleanup.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require(path.join(__dirname, '..', 'main', 'db'));
const cleanup = require(path.join(__dirname, '..', 'main', 'reminder_cleanup'));
const scheduler = require(path.join(__dirname, '..', 'main', 'scheduler'));

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

function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `soulpet-cleanup-${name}-`));
  return { dir, file: path.join(dir, 'test.sqlite') };
}

const pad = (n) => String(n).padStart(2, '0');
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysAgo(n, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}
// A 'YYYY-MM-DD HH:MM:SS' stamp for a day N days ago. The DB stores
// timestamps in this format, and the rule reads the day off the prefix.
function stampDaysAgo(n) {
  return `${ymd(daysAgo(n))} 09:00:00`;
}

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------
console.log('\n== isPrunableEvent ==');

// The reference "now" for the pure checks. A fixed instant (not the wall
// clock) so the boundary cases are exact.
const NOW = new Date(2026, 2, 15, 12, 0, 0); // 2026-03-15 12:00:00

// A stamp N hours before NOW.
function stampHoursAgo(h) {
  const d = new Date(NOW.getTime() - h * 3600 * 1000);
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// A one_time that fired two days ago → prunable.
check('one_time fired 2 days ago → prunable',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 0,
    last_fired_at: stampHoursAgo(48),
  }, NOW), true);

// A one_time that fired TODAY → kept. The user may still be looking at it.
check('one_time fired today → kept',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 0,
    last_fired_at: stampHoursAgo(3),
  }, NOW), false);

// Just under 24 hours → kept. The rule is "超过一天" — MORE than a day.
check('one_time fired 23 hours ago → kept',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 0,
    last_fired_at: stampHoursAgo(23),
  }, NOW), false);

// Exactly 24 hours → prunable. A full day has passed.
check('one_time fired exactly 24 hours ago → prunable',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 0,
    last_fired_at: stampHoursAgo(24),
  }, NOW), true);

// Just over 24 hours → prunable.
check('one_time fired 25 hours ago → prunable',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 0,
    last_fired_at: stampHoursAgo(25),
  }, NOW), true);

// Every periodic kind → kept, because it will fire again.
for (const kind of ['daily', 'weekly', 'every_n_days', 'monthly', 'yearly']) {
  check(`${kind} → kept (fires again)`,
    cleanup.isPrunableEvent({
      remind: 1, remind_kind: kind, active: 1,
      last_fired_at: stampHoursAgo(24 * 5),
    }, NOW), false);
}

// A muted row (提醒关闭) → kept. It never completed, and the user may
// re-enable it later — deleting it would destroy a record they still own.
check('remind=0 → kept (never completed)',
  cleanup.isPrunableEvent({
    remind: 0, remind_kind: 'one_time', active: 1, last_fired_at: null,
  }, NOW), false);

// A one_time that has NOT fired yet → kept.
check('one_time not yet fired → kept',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 1, last_fired_at: null,
  }, NOW), false);

// An unknown repeat kind → kept. We don't guess: a kind from a newer
// build might still fire.
check('unknown remind_kind → kept',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'quarterly', active: 0,
    last_fired_at: stampHoursAgo(24 * 9),
  }, NOW), false);

// A malformed last_fired_at → kept (we can't read the completion time).
check('malformed last_fired_at → kept',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 0, last_fired_at: 'not-a-date',
  }, NOW), false);

// A RE-ARMED one_time → kept. The user edited a finished reminder and
// gave it a new future date: `events:update` sets active = 1 and
// recomputes next_fire_at but leaves the OLD last_fired_at in place. Such
// a row will fire again, so it must survive.
check('re-armed one_time (future next_fire_at) → kept',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 1,
    last_fired_at: stampHoursAgo(24 * 5),
    next_fire_at: '2099-01-01 09:00:00',
  }, NOW), false);

// A one_time whose next_fire_at is in the PAST is still finished — the
// scheduler clears next_fire_at when it fires, so a stale past value
// means the row was edited but never re-armed to a future slot.
check('one_time with a past next_fire_at → prunable',
  cleanup.isPrunableEvent({
    remind: 1, remind_kind: 'one_time', active: 0,
    last_fired_at: stampHoursAgo(24 * 5),
    next_fire_at: '2020-01-01 09:00:00',
  }, NOW), true);

// ---------------------------------------------------------------------------
// The database behaviour
// ---------------------------------------------------------------------------
async function checkDbBehaviour() {
  console.log('\n== pruneCompletedReminders (database) ==');
  const { dir, file } = tmpDb('prune');
  await db.open(file);

  const now = db.nowStr();
  const contactId = db.newId();
  db.run(
    `INSERT INTO contacts(id, name, relationship, icon_kind, likes_json, taboos_json,
                          gifts_json, listed, created_at, updated_at)
     VALUES (?, ?, '朋友', 'user', '[]', '[]', '[]', 1, ?, ?)`,
    [contactId, '张三', now, now]
  );

  const insertEvent = (title, over) => {
    const id = db.newId();
    const row = {
      id, contact_id: contactId, title,
      description: null,
      remind: 1,
      remind_kind: 'one_time',
      remind_time: '09:00',
      remind_date: '2026-01-01',
      next_fire_at: null,
      last_fired_at: null,
      active: 0,
      category: 'general',
      tag_kind: null,
      lunar_month: null,
      lunar_day: null,
      interval_days: null,
      advance_days: null,
      created_at: now,
      updated_at: now,
      ...over,
    };
    db.run(
      `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                          remind_time, remind_date, next_fire_at, last_fired_at, active,
                          category, tag_kind, lunar_month, lunar_day,
                          interval_days, advance_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.contact_id, row.title, row.description, row.remind, row.remind_kind,
       row.remind_time, row.remind_date, row.next_fire_at, row.last_fired_at, row.active,
       row.category, row.tag_kind, row.lunar_month, row.lunar_day,
       row.interval_days, row.advance_days, row.created_at, row.updated_at]
    );
    return id;
  };

  // A stamp N hours before the real "now". The rule is elapsed-time
  // based, so the offsets are in hours rather than in calendar days.
  const hoursAgo = (h) => {
    const d = new Date(Date.now() - h * 3600 * 1000);
    return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const oldOneTime = insertEvent('两天前的单次', { last_fired_at: hoursAgo(48) });
  // 23 hours ago: less than a day, so it survives now — but a day from now
  // it will be 47 hours old and go.
  const yesterdayOneTime = insertEvent('昨天完成的单次', { last_fired_at: hoursAgo(23) });
  const todayOneTime = insertEvent('今天完成的单次', { last_fired_at: hoursAgo(3) });
  const dailyEvent = insertEvent('每天的提醒', {
    remind_kind: 'daily', active: 1, last_fired_at: hoursAgo(24 * 5),
  });
  const mutedEvent = insertEvent('已关闭提醒的提醒', {
    remind: 0, remind_kind: 'one_time', active: 1, last_fired_at: null,
  });
  const pendingEvent = insertEvent('还没到的一次性', {
    active: 1, last_fired_at: null, next_fire_at: '2099-01-01 09:00:00',
  });
  // A one_time that already fired, but which the user then EDITED to a
  // future date. `events:update` re-arms it (active = 1, next_fire_at
  // recomputed) but leaves the old last_fired_at in place — so the row
  // LOOKS old while actually being scheduled again.
  const reArmedEvent = insertEvent('改期后的一次性', {
    active: 1, last_fired_at: hoursAgo(48), next_fire_at: '2099-01-01 09:00:00',
  });

  // Side rows for the event that will be pruned — they must go too.
  db.upsertSearch('event', oldOneTime, '两天前的单次');
  db.run(
    `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
     VALUES ('event', ?, ?, NULL)`,
    [oldOneTime, hoursAgo(48)]
  );
  db.run(
    `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
     VALUES ('event', ?, ?, NULL)`,
    [todayOneTime, hoursAgo(3)]
  );

  const exists = (id) => !!db.one('SELECT id FROM events WHERE id = ?', [id]);

  // ---- Run the cleanup with a live queue ----
  const queue = new scheduler.ReminderQueue();
  // The old one_time is still sitting in the live queue (it fired days ago
  // and was never dismissed). The cleanup must drop it.
  queue.pushIfNew({ source: 'event', source_id: oldOneTime, title: '两天前的单次' });
  queue.pushIfNew({ source: 'event', source_id: todayOneTime, title: '今天完成的单次' });
  check('queue starts with 2 items', queue.len(), 2);

  const res = cleanup.pruneCompletedReminders({ queue });
  check('exactly one event deleted', res.deleted, 1);
  check('no row was skipped by the rule', res.skipped, 0);
  check('the deleted id is the old one_time', res.ids, [oldOneTime]);

  check('old one_time is gone', exists(oldOneTime), false);
  check('yesterday one_time survives', exists(yesterdayOneTime), true);
  check('today one_time survives', exists(todayOneTime), true);
  check('daily survives', exists(dailyEvent), true);
  check('muted row survives', exists(mutedEvent), true);
  check('pending one_time survives', exists(pendingEvent), true);
  check('re-armed one_time survives', exists(reArmedEvent), true);

  // The side rows must be gone for the deleted event...
  check('search_index row pruned',
    db.one('SELECT id FROM search_index WHERE kind = ? AND ref_id = ?', ['event', oldOneTime]), null);
  check('reminder_ack pruned',
    db.one('SELECT id FROM reminder_acks WHERE source = ? AND source_id = ?', ['event', oldOneTime]), null);
  // ...and kept for the surviving ones.
  check('reminder_ack of a surviving event kept',
    !!db.one('SELECT id FROM reminder_acks WHERE source = ? AND source_id = ?', ['event', todayOneTime]), true);

  // The live queue entry for the deleted event must be dropped, and the
  // one for the surviving event must stay.
  check('queue entry for deleted event removed', queue.len(), 1);
  check('queue keeps the surviving event',
    queue.list()[0].source_id, todayOneTime);

  // ---- Running it again is a no-op ----
  const res2 = cleanup.pruneCompletedReminders({ queue });
  check('second run deletes nothing', res2.deleted, 0);

  // ---- The "now" override lets us test the day boundary ----
  //
  // A day later, the "yesterday" one_time (25 hours old) and the "today"
  // one_time (3 hours old) are BOTH older than 24 hours, so both go.
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const res3 = cleanup.pruneCompletedReminders({ queue, now: tomorrow });
  check('tomorrow: yesterday + today one_times are prunable', res3.deleted, 2);
  check('tomorrow: daily still survives', exists(dailyEvent), true);
  check('tomorrow: muted still survives', exists(mutedEvent), true);
  check('tomorrow: pending still survives', exists(pendingEvent), true);
  check('tomorrow: re-armed still survives', exists(reArmedEvent), true);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The scheduler runs the cleanup once per day
// ---------------------------------------------------------------------------
async function checkSchedulerIntegration() {
  console.log('\n== scheduler integration ==');
  const { dir, file } = tmpDb('sched');
  await db.open(file);

  const now = db.nowStr();
  const id = db.newId();
  const twoDaysAgo = (() => {
    const d = new Date(Date.now() - 48 * 3600 * 1000);
    return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  })();
  db.run(
    `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                        remind_time, remind_date, next_fire_at, last_fired_at, active,
                        category, tag_kind, lunar_month, lunar_day,
                        interval_days, advance_days, created_at, updated_at)
     VALUES (?, NULL, '待清理的单次', NULL, 1, 'one_time', '09:00', '2026-01-01',
             NULL, ?, 0, 'general', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [id, twoDaysAgo, now, now]
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
  check('the scan auto-deleted the finished reminder',
    !!db.one('SELECT id FROM events WHERE id = ?', [id]), false);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await checkDbBehaviour();
  await checkSchedulerIntegration();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
