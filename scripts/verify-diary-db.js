// scripts/verify-diary-db.js — checks the diary feature's database layer.
//
// The diary editor persists two things on a memorial event:
//
//   background — the chosen background style id
//   content    — the mixed text/image document (a JSON array of blocks)
//
// This script opens a real database and checks that:
//
//   1. The schema carries both columns on a fresh install.
//   2. The v3 migration adds them to an OLD database that lacks them
//      (the upgrade path for existing users), and drops the retired
//      `tag_kind` column.
//   3. The mixed document round-trips.
//   4. The export query still works (it selects explicit columns).
//
// Run: node scripts/verify-diary-db.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

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

// A throwaway directory for the test database. db.open() takes an explicit
// path, so the tests never touch the user's real database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-diary-db-'));

async function main() {
  const db = require('../main/db.js');

  console.log('\n== 新建数据库 ==');
  const freshPath = path.join(tmpDir, 'fresh.sqlite');
  await db.open(freshPath);
  const cols = db.all('PRAGMA table_info(memorial_events)');
  const names = cols.map((c) => c.name);
  checkTrue('a fresh schema has the background column', names.includes('background'));
  checkTrue('a fresh schema has the content column', names.includes('content'));
  checkTrue('a fresh schema has no tag_kind column', !names.includes('tag_kind'));

  // ---- Round-trip a diary entry through the DB layer ------------------
  console.log('\n== 保存与读取 ==');
  const id = db.newId();
  const now = db.nowStr();
  const content = JSON.stringify([
    { type: 'text', text: '海风很大，浪声一直没停。' },
    { type: 'image', photo_id: 'p1' },
    { type: 'text', text: '我们在防波堤上坐到天黑。' },
  ]);
  db.run(
    `INSERT INTO memorial_events(id, kind, title, place, food, outfit,
       activities, notes, occurred_at, background, content,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'other', '第一次去海边', null, null, null, null,
     '海风很大，浪声一直没停。\n\n我们在防波堤上坐到天黑。', '2026-05-01 10:30:00', 'shadow',
     content, now, now]
  );
  const row = db.getMemorialEvent(id);
  check('the background is stored', row.background, 'shadow');
  check('the body is stored in notes', row.notes, '海风很大，浪声一直没停。\n\n我们在防波堤上坐到天黑。');
  check('the mixed document is stored', JSON.parse(row.content), [
    { type: 'text', text: '海风很大，浪声一直没停。' },
    { type: 'image', photo_id: 'p1' },
    { type: 'text', text: '我们在防波堤上坐到天黑。' },
  ]);

  // ---- The export query still works ------------------------------------
  console.log('\n== 导出查询 ==');
  const exported = db.listMemorialEventsForExport({});
  checkTrue('the export query returns the entry', exported.length === 1);
  checkTrue('the export query carries the background',
    exported.every((r) => 'background' in r));
  checkTrue('the export query carries the content',
    exported.every((r) => 'content' in r));

  db.close();

  // ---- The upgrade path ------------------------------------------------
  console.log('\n== 旧数据库升级 ==');
  // Build a database with the PRE-v3 memorial_events shape, then let the
  // migration run over it.
  const SQL = await initSqlJs();
  const legacyPath = path.join(tmpDir, 'legacy.sqlite');
  const legacy = new SQL.Database();
  legacy.run(`
    CREATE TABLE memorial_events (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('first_time','other')),
      title       TEXT NOT NULL,
      place       TEXT,
      food        TEXT,
      outfit      TEXT,
      activities  TEXT,
      notes       TEXT,
      occurred_at TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    INSERT INTO memorial_events(id, kind, title, notes, occurred_at, created_at, updated_at)
      VALUES ('old1', 'other', '旧的一篇', '旧正文', '2024-01-01 10:00:00', '2024-01-01 10:00:00', '2024-01-01 10:00:00');
  `);
  const bytes = legacy.export();
  legacy.close();
  fs.writeFileSync(legacyPath, Buffer.from(bytes));

  // Point the db module at the legacy file and open it. The migration
  // runs on open, so the legacy shape gets the new columns.
  const db2 = require('../main/db.js');
  await db2.open(legacyPath);
  const cols2 = db2.all('PRAGMA table_info(memorial_events)').map((c) => c.name);
  checkTrue('the migration adds the background column', cols2.includes('background'));
  checkTrue('the migration adds the content column', cols2.includes('content'));
  const oldRow = db2.getMemorialEvent('old1');
  check('the existing entry survives the migration', oldRow && oldRow.title, '旧的一篇');
  check('the existing entry keeps its body', oldRow && oldRow.notes, '旧正文');
  check('the existing entry gets a null background', oldRow && oldRow.background, null);
  check('the existing entry gets a null document', oldRow && oldRow.content, null);
  db2.close();

  // ---- The upgrade path from the tagged version ------------------------
  console.log('\n== 带标签的旧数据库升级 ==');
  // A database written by the version that had the tag column. The
  // migration must drop the column and keep the rows.
  const taggedPath = path.join(tmpDir, 'tagged.sqlite');
  const tagged = new SQL.Database();
  tagged.run(`
    CREATE TABLE memorial_events (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('first_time','other')),
      title       TEXT NOT NULL,
      place       TEXT,
      food        TEXT,
      outfit      TEXT,
      activities  TEXT,
      notes       TEXT,
      occurred_at TEXT NOT NULL,
      background  TEXT,
      tag_kind    TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    INSERT INTO memorial_events(id, kind, title, notes, occurred_at, background, tag_kind, created_at, updated_at)
      VALUES ('t1', 'other', '带标签的一篇', '正文', '2024-06-01 10:00:00', 'shadow', 'anniversary', '2024-06-01 10:00:00', '2024-06-01 10:00:00');
  `);
  const taggedBytes = tagged.export();
  tagged.close();
  fs.writeFileSync(taggedPath, Buffer.from(taggedBytes));

  const db3 = require('../main/db.js');
  await db3.open(taggedPath);
  const cols3 = db3.all('PRAGMA table_info(memorial_events)').map((c) => c.name);
  checkTrue('the migration drops the retired tag_kind column', !cols3.includes('tag_kind'));
  checkTrue('the migration keeps the background column', cols3.includes('background'));
  checkTrue('the migration adds the content column', cols3.includes('content'));
  const taggedRow = db3.getMemorialEvent('t1');
  check('the tagged entry survives the migration', taggedRow && taggedRow.title, '带标签的一篇');
  check('the tagged entry keeps its body', taggedRow && taggedRow.notes, '正文');
  check('the tagged entry keeps its background', taggedRow && taggedRow.background, 'shadow');
  db3.close();

  // ---- Cleanup ---------------------------------------------------------
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-diary-db crashed:', e);
  process.exit(1);
});
