// scripts/verify-card-progress.js — checks the 抽卡人生 打卡墙's rules.
//
// The 打卡墙 answers a question the 抽卡人生 page used to leave open: of
// the weeks you have drawn, how many did you actually write down?
//
// This script checks the two things that answer depends on:
//
//   1. The COMPLETION RULE — a week counts as finished when its
//      回忆记录 has a photo, or more than 30 characters of text (the
//      content document plus the five text fields).
//   2. The STATISTICS — the totals, the completion rate, the current
//      streak and the longest streak.
//
// It opens a real database, writes real rows, and reads them back
// through the same join the page uses (db.listCardDrawsWithProgress),
// so the rules are checked against the data as it is actually stored.
//
// Run: node scripts/verify-card-progress.js

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

// A throwaway directory for the test database, so the user's real one is
// never touched.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-card-progress-'));

// The Monday of a week, as the app writes it.
function mondayOf(y, m, d) {
  const dt = new Date(y, m - 1, d);
  const day = (dt.getDay() + 6) % 7;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - day);
}
function weekKey(y, m, d) {
  const dt = mondayOf(y, m, d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

async function main() {
  const cardProgress = require('../main/card_progress.js');
  const db = require('../main/db.js');

  // ---- The rule, on its own ----------------------------------------------
  console.log('\n== 完成判定 ==');

  // A row as the join returns it: no event at all.
  const bare = { photo_count: 0, event_id: null, event_content: null };
  check('a week with no entry is not finished', cardProgress.evaluate(bare).done, false);

  // An entry with a photo and no text.
  const withPhoto = {
    photo_count: 1, event_id: 'e1', event_content: null, event_notes: null,
  };
  check('a week with a photo is finished', cardProgress.evaluate(withPhoto).done, true);
  check('the photo is reported', cardProgress.evaluate(withPhoto).hasPhoto, true);

  // An entry with exactly 30 characters: NOT enough (the rule is "more
  // than 30").
  const thirty = {
    photo_count: 0, event_id: 'e2',
    event_content: JSON.stringify([{ type: 'text', text: 'x'.repeat(30) }]),
  };
  check('30 characters is not enough', cardProgress.evaluate(thirty).done, false);
  check('the 30 characters are counted', cardProgress.evaluate(thirty).textLength, 30);

  // 31 characters: enough.
  const thirtyOne = {
    photo_count: 0, event_id: 'e3',
    event_content: JSON.stringify([{ type: 'text', text: 'x'.repeat(31) }]),
  };
  check('31 characters is enough', cardProgress.evaluate(thirtyOne).done, true);

  // The five fields count towards the total.
  const fields = {
    photo_count: 0, event_id: 'e4',
    event_notes: '一二三四五',        // 5
    event_place: '一二三四五',        // 5
    event_food: '一二三四五',         // 5
    event_outfit: '一二三四五',       // 5
    event_activities: '一二三四五',   // 5
  };
  check('the five fields are counted', cardProgress.evaluate(fields).textLength, 25);
  check('25 characters is not enough', cardProgress.evaluate(fields).done, false);

  // The content document and the fields add up together.
  const mixed = {
    photo_count: 0, event_id: 'e5',
    event_content: JSON.stringify([{ type: 'text', text: 'x'.repeat(20) }]),
    event_notes: 'y'.repeat(20),
  };
  check('the document and the fields add up', cardProgress.evaluate(mixed).textLength, 40);
  check('the sum is enough', cardProgress.evaluate(mixed).done, true);

  // A gallery block carries no text — the photo in it is counted as a
  // photo, not as characters.
  const gallery = {
    photo_count: 0, event_id: 'e6',
    event_content: JSON.stringify([
      { type: 'text', text: 'x'.repeat(10) },
      { type: 'gallery', layout: 'one', photos: [{ photo_id: 'p1' }] },
    ]),
  };
  check('a gallery block adds no text', cardProgress.evaluate(gallery).textLength, 10);

  // A malformed document must not throw — it counts as no text.
  const broken = { photo_count: 0, event_id: 'e7', event_content: '{not json' };
  check('a broken document counts as no text', cardProgress.evaluate(broken).textLength, 0);
  check('a broken document does not finish the week',
    cardProgress.evaluate(broken).done, false);

  // An entry that is only whitespace is not text.
  const blank = {
    photo_count: 0, event_id: 'e8',
    event_content: JSON.stringify([{ type: 'text', text: '   ' }]),
  };
  check('whitespace is not text', cardProgress.evaluate(blank).textLength, 0);

  // ---- The streak, on its own --------------------------------------------
  console.log('\n== 连续完成 ==');

  const e = (weekKeyStr, done) => ({ weekKey: weekKeyStr, done });
  const wk = (n) => weekKey(2026, 1, 5 + n * 7);

  check('an empty history has no streak', cardProgress.currentStreak([]), 0);
  check('one finished week is a streak of one',
    cardProgress.currentStreak([e(wk(0), true)]), 1);
  check('an unfinished newest week does not start a streak',
    cardProgress.currentStreak([e(wk(0), false)]), 0);
  check('three finished weeks in a row',
    cardProgress.currentStreak([e(wk(0), true), e(wk(1), true), e(wk(2), true)]), 3);
  check('the streak stops at an unfinished week',
    cardProgress.currentStreak([e(wk(0), true), e(wk(1), false), e(wk(2), true)]), 1);
  // A gap in the weeks breaks the streak: two weeks that are not
  // adjacent are not consecutive. The newest week still counts on its
  // own — the gap only stops the chain from reaching further back.
  check('a gap in the weeks stops the streak reaching back',
    cardProgress.currentStreak([e(wk(0), true), e(wk(2), true)]), 1);
  // The current week being unfinished does not erase the run before it.
  check('an unfinished current week keeps the run before it',
    cardProgress.currentStreak([e(wk(0), false), e(wk(1), true), e(wk(2), true)]), 2);
  // An unfinished current week also does not join two runs that are
  // separated by a gap.
  check('an unfinished current week does not bridge a gap',
    cardProgress.currentStreak([e(wk(0), false), e(wk(2), true)]), 0);

  check('the longest run is found anywhere in the history',
    cardProgress.longestStreak([
      e(wk(0), true), e(wk(1), false), e(wk(2), true), e(wk(3), true), e(wk(4), true),
    ]), 3);

  // The week adjacency test itself.
  check('two consecutive Mondays are adjacent',
    cardProgress.adjacentWeeks('2026-01-05', '2026-01-12'), true);
  check('two Mondays two weeks apart are not',
    cardProgress.adjacentWeeks('2026-01-05', '2026-01-19'), false);
  check('a malformed week key is not adjacent',
    cardProgress.adjacentWeeks('2026-01-05', 'nonsense'), false);
  check('an impossible date is rejected',
    cardProgress.parseWeekKey('2026-02-30'), null);
  check('a real date is accepted',
    !!cardProgress.parseWeekKey('2026-02-28'), true);

  // ---- Against a real database -------------------------------------------
  console.log('\n== 真实数据库 ==');
  await db.open(path.join(tmpDir, 'progress.sqlite'));

  const now = db.nowStr();

  // Five weeks of draws, back to back.
  const weeks = [];
  for (let i = 0; i < 5; i++) {
    weeks.push(weekKey(2026, 1, 5 + i * 7));
  }

  // W1: a photo, no text — finished.
  // W2: 40 characters, no photo — finished.
  // W3: nothing — not finished.
  // W4: 12 characters — not finished.
  // W5: a photo and text — finished.
  const draws = weeks.map((wk2) => db.createCardDraw({
    week_key: wk2,
    card_no: 1,
    title: `第 ${wk2} 周的卡`,
    requirement: '做点什么',
    source: 'deck',
  }));

  // W1 — one photo.
  const ev1 = db.newId();
  db.run(
    `INSERT INTO memorial_events(id, kind, title, notes, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ev1, 'card_draw', '第一周', '', now, now, now]);
  db.run(
    `INSERT INTO memorial_event_photos(id, memorial_event_id, relative_path, created_at)
     VALUES (?, ?, ?, ?)`,
    [db.newId(), ev1, 'photos/a.jpg', now]);
  db.linkCardDraw(draws[0].id, ev1);

  // W2 — 40 characters in the content document.
  const ev2 = db.newId();
  db.run(
    `INSERT INTO memorial_events(id, kind, title, content, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ev2, 'card_draw', '第二周',
     JSON.stringify([{ type: 'text', text: '字'.repeat(40) }]), now, now, now]);
  db.linkCardDraw(draws[1].id, ev2);

  // W4 — 12 characters: too short.
  const ev4 = db.newId();
  db.run(
    `INSERT INTO memorial_events(id, kind, title, notes, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ev4, 'card_draw', '第四周', '字'.repeat(12), now, now, now]);
  db.linkCardDraw(draws[3].id, ev4);

  // W5 — a photo and text.
  const ev5 = db.newId();
  db.run(
    `INSERT INTO memorial_events(id, kind, title, notes, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ev5, 'card_draw', '第五周', '字'.repeat(50), now, now, now]);
  db.run(
    `INSERT INTO memorial_event_photos(id, memorial_event_id, relative_path, created_at)
     VALUES (?, ?, ?, ?)`,
    [db.newId(), ev5, 'photos/b.jpg', now]);
  db.linkCardDraw(draws[4].id, ev5);

  const rows = db.listCardDrawsWithProgress(200);
  check('every draw is listed', rows.length, 5);
  checkTrue('the join brings the photo count along',
    rows.some((r) => Number(r.photo_count) === 1),
    JSON.stringify(rows.map((r) => r.photo_count)));

  const sum = cardProgress.summary(rows);
  check('five weeks were drawn', sum.weeks, 5);
  check('three of them were finished', sum.done, 3);
  check('two are still waiting', sum.pending, 2);
  check('the completion rate is 60%', sum.rate, 60);
  // W5 and W4: W5 is finished, W4 is not — so the streak is 1.
  check('the current streak is one', sum.streak, 1);
  // The longest run: W5 (done), W4 (not), W3 (not), W2 (done), W1 (done)
  // — so the longest run is 2 (W1 and W2).
  check('the longest streak is two', sum.best, 2);
  check('the first week is reported', sum.firstWeek, weeks[0]);
  check('the last week is reported', sum.lastWeek, weeks[4]);

  // The entries are newest first, and each carries its own state.
  check('the entries are newest first', sum.entries[0].weekKey, weeks[4]);
  check('the newest week is finished', sum.entries[0].done, true);
  check('the third week is not finished', sum.entries[2].done, false);
  check('the fourth week is not finished', sum.entries[3].done, false);
  check('the fifth week is finished', sum.entries[4].done, true);
  check('the photo count is carried', sum.entries[0].photoCount, 1);
  check('the text length is carried', sum.entries[1].textLength, 40);
  check('the threshold is reported', sum.threshold, 30);

  // A draw whose event was DELETED must still be on the wall — it is
  // simply not finished. (The link is not a foreign key, so the id
  // survives the deletion.)
  db.run('DELETE FROM memorial_events WHERE id = ?', [ev4]);
  const afterDelete = cardProgress.summary(db.listCardDrawsWithProgress(200));
  check('the draw survives the deletion of its entry', afterDelete.weeks, 5);
  check('the orphaned draw is not finished',
    afterDelete.entries.find((x) => x.weekKey === weeks[3]).done, false);
  check('the totals follow', afterDelete.done, 3);
  // The draw still HOLDS the deleted entry's id, but the wall must not
  // hand that id out — a card that says 「查看这篇回忆」 and then leads to
  // an editor that says 「这篇回忆不存在」 is worse than a card that
  // simply offers to write it.
  check('the orphaned draw reports no entry',
    afterDelete.entries.find((x) => x.weekKey === weeks[3]).memorialEventId, null);
  // The weeks that still have their entry are untouched.
  check('the surviving entries keep their id',
    afterDelete.entries.find((x) => x.weekKey === weeks[4]).memorialEventId, ev5);

  db.close();

  // ---- Cleanup -------------------------------------------------------------
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-card-progress crashed:', e);
  process.exit(1);
});
