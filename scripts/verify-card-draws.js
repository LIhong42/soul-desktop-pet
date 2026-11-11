// scripts/verify-card-draws.js — checks the 抽卡 feature's rules.
//
// The feature has three moving parts:
//
//   * the DECK — `resources/intersting-list/list.md`, parsed into cards;
//   * the WEEKLY RULE — one draw per week (the week starts on Monday);
//   * the 分类 — a memorial event can be filed as 抽卡事件 (card_draw),
//     which means the `kind` column's CHECK has to allow it.
//
// This script opens a real database and checks that:
//
//   1. The deck parses: every card has a number, a title and a
//      requirement.
//   2. The week key is the Monday of the week.
//   3. A fresh schema carries the card_draws table and the widened
//      `kind` CHECK.
//   4. The v4 migration widens the CHECK on an OLD database (the upgrade
//      path for existing users) and keeps every row.
//   5. A memorial event can be filed as 抽卡事件.
//   6. One draw per week: the second draw in the same week returns the
//      card that is already there.
//
// Run: node scripts/verify-card-draws.js

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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-card-draws-'));

async function main() {
  const cardDraws = require('../main/card_draws.js');

  // ---- The deck ----------------------------------------------------------
  console.log('\n== 卡库 ==');
  const deck = cardDraws.readDeck(null);
  checkTrue('the deck reads', !deck.error, deck.error);
  // The deck grows as the user adds cards, so the count is not written
  // down here — what matters is that the parser finds EVERY card in the
  // file, in the file's order, so the headings in the file are the
  // expectation.
  const deckText = fs.readFileSync(cardDraws.deckPath(null), 'utf8');
  const headings = deckText.match(/^###[ \t]*\d+\..*$/gm) || [];
  const headingCount = headings.length;
  const headingNos = headings.map((h) => Number(/^###[ \t]*(\d+)\./.exec(h)[1]));
  check('the deck parses every card in the file', deck.cards.length, headingCount);
  check('the deck keeps the file\'s order',
    deck.cards.map((c) => c.no), headingNos);
  checkTrue('the deck is not empty', headingCount > 0, `got ${headingCount}`);
  checkTrue('every card has a number', deck.cards.every((c) => Number.isFinite(c.no)));
  checkTrue('every card has a title', deck.cards.every((c) => c.title && c.title.length));
  checkTrue('every card has a requirement', deck.cards.every((c) => c.requirement && c.requirement.length));
  check('the first card is the one in the file', deck.cards[0].title,
    '给一个曾经重要、如今失联的人写一封信');
  check('the first card keeps its requirement', deck.cards[0].requirement,
    '给看到题目第一个想到的人写一封信。');
  // The fourteenth card's requirement line has no bullet in the file — the
  // parser has to cope with that.
  check('a requirement without a bullet still parses', deck.cards[13].requirement,
    '理论和实践结合，学成之后主动向朋友和家人展示');
  // The last card is the last one in the file.
  const lastCard = deck.cards[deck.cards.length - 1];
  checkTrue('the last card has a title', !!(lastCard && lastCard.title));

  // ---- The week ----------------------------------------------------------
  console.log('\n== 每周一次 ==');
  // 2026-11-07 is a Saturday; its week starts on Monday the 2nd.
  check('the week key is the Monday', cardDraws.weekKey(new Date(2026, 10, 7)), '2026-11-02');
  check('a Sunday belongs to the week that started on the Monday',
    cardDraws.weekKey(new Date(2026, 10, 8)), '2026-11-02');
  check('the following Monday starts a new week',
    cardDraws.weekKey(new Date(2026, 10, 9)), '2026-11-09');
  check('the week label ends on the Sunday',
    cardDraws.weekEndKey(new Date(2026, 10, 7)), '2026-11-08');

  // ---- A fresh database --------------------------------------------------
  console.log('\n== 新建数据库 ==');
  const db = require('../main/db.js');
  const freshPath = path.join(tmpDir, 'fresh.sqlite');
  await db.open(freshPath);

  const kindSql = db.one(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='memorial_events'");
  checkTrue('the kind column allows card_draw',
    kindSql && String(kindSql.sql).includes("'card_draw'"));
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r) => r.name);
  checkTrue('the card_draws table exists', tables.includes('card_draws'));

  // ---- 抽卡事件 as a 分类 --------------------------------------------------
  console.log('\n== 抽卡事件分类 ==');
  const memId = db.newId();
  const now = db.nowStr();
  db.run(
    `INSERT INTO memorial_events(id, kind, title, notes, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [memId, 'card_draw', '抽到的一张卡', '要求正文', now, now, now]);
  const memRow = db.getMemorialEvent(memId);
  check('the entry is filed as 抽卡事件', memRow && memRow.kind, 'card_draw');
  const byKind = db.listMemorialEvents({ kind: 'card_draw' });
  checkTrue('the list filters by 抽卡事件',
    byKind.length === 1 && byKind[0].id === memId);

  // ---- The draw ----------------------------------------------------------
  console.log('\n== 抽卡 ==');
  const fixedNow = new Date(2026, 10, 7, 10, 0, 0);
  const first = cardDraws.draw(null, db, fixedNow);
  checkTrue('the first draw succeeds', first.ok, first.reason);
  checkTrue('the drawn card has a title', !!(first.card && first.card.title));
  checkTrue('the drawn card belongs to the week', first.card.week_key, '2026-11-02');

  const second = cardDraws.draw(null, db, fixedNow);
  check('the second draw in the same week does not draw again', second.ok, false);
  check('the second draw says why', second.reason, 'already_drawn');
  check('the second draw returns the same card', second.card.id, first.card.id);

  const nextWeek = cardDraws.draw(null, db, new Date(2026, 10, 9, 10, 0, 0));
  checkTrue('the next week draws again', nextWeek.ok, nextWeek.reason);
  check('the next card belongs to the next week', nextWeek.card.week_key, '2026-11-09');

  const state = cardDraws.state(null, db, fixedNow);
  check('the state reports this week\'s card', state.card.id, first.card.id);
  checkTrue('the state lists the history', state.history.length >= 2);
  // The 打卡墙's door says how many weeks have been drawn IN TOTAL. The
  // history list above is capped at a year, so this count is a separate
  // number — and it must be the whole history, not the capped list.
  check('the state counts every draw', state.totalDraws, db.countCardDraws());
  checkTrue('the count is the whole history', state.totalDraws >= 2,
    `got ${state.totalDraws}`);
  // Every history row carries the completion verdict, so the page's
  // 「已记录」 badge and the 打卡墙's squares cannot disagree.
  checkTrue('every history row carries the verdict',
    state.history.every((h) => typeof h.done === 'boolean'));
  check('a card with no entry is not done', state.history[0].done, false);

  // ---- Linking the card to the entry -------------------------------------
  console.log('\n== 记录 ==');
  const linked = db.linkCardDraw(first.card.id, memId);
  check('the card points at the entry', linked.memorial_event_id, memId);
  checkTrue('the card records when it was written', !!linked.recorded_at);

  // The verdict follows the link — and it follows the RULE, not just
  // the link. The entry linked here holds a four-character body, which
  // is under the threshold, so the week is NOT finished even though an
  // entry exists.
  const afterLink = cardDraws.state(null, db, fixedNow);
  const linkedRow = afterLink.history.find((h) => h.id === first.card.id);
  check('a card with a too-thin entry is not done', linkedRow.done, false);
  check('the card still has the entry', linkedRow.memorial_event_id, memId);

  // ---- The cards the user adds -------------------------------------------
  console.log('\n== 自己添加的卡片 ==');
  const mine = db.createCustomCard({
    title: '给三个月后的自己写一封信',
    requirement: '写完封起来，三个月后再拆开。',
  });
  checkTrue('the custom card is stored', !!(mine && mine.id));
  check('the custom card keeps its title', mine.title, '给三个月后的自己写一封信');
  const customList = db.listCustomCards();
  check('the custom card is listed', customList.length, 1);

  // The pool a draw picks from holds both kinds of card.
  const pool = cardDraws.readPool(null, db);
  check('the pool holds the whole official deck',
    pool.cards.filter((c) => c.source === 'deck').length, deck.cards.length);
  check('the pool holds the custom card', pool.cards.filter((c) => c.source === 'custom').length, 1);
  const pooled = pool.cards.find((c) => c.source === 'custom');
  check('the custom card is in the pool with its own id', pooled.refId, mine.id);
  check('the custom card has no number', pooled.no, null);

  // A draw can come up with the user's own card. The pick is random, so
  // the randomness is pinned for this one draw: the custom card sits at
  // the end of the pool, so the highest possible random value picks it.
  const origRandom = Math.random;
  Math.random = () => 0.999999;
  const customPick = cardDraws.draw(null, db, new Date(2027, 0, 4, 10, 0, 0));
  Math.random = origRandom;
  check('a draw can come up with the user\'s own card', customPick.card.source, 'custom');
  check('the drawn custom card points at the card it came from',
    customPick.card.card_ref_id, mine.id);
  check('the drawn custom card keeps its title', customPick.card.title, mine.title);

  // The official deck is still drawable: the lowest random value picks
  // the first card of the deck.
  Math.random = () => 0;
  const deckPick = cardDraws.draw(null, db, new Date(2027, 0, 11, 10, 0, 0));
  Math.random = origRandom;
  check('a draw can still come up with an official card', deckPick.card.source, 'deck');
  check('the drawn official card keeps its number', deckPick.card.card_no, 1);

  // Deleting a custom card does not rewrite the cards already drawn.
  const customDraw = db.listCardDraws(200).find((d) => d.source === 'custom');
  checkTrue('the drawn custom card is remembered', !!(customDraw && customDraw.card_ref_id));
  checkTrue('the custom card can be deleted', db.deleteCustomCard(mine.id) === true);
  check('the custom card is gone', db.listCustomCards().length, 0);
  const afterDelete = db.getCardDraw(customDraw.id);
  check('the drawn card keeps its copy of the title', afterDelete.title, customDraw.title);
  check('the drawn card keeps its copy of the requirement', afterDelete.requirement, customDraw.requirement);
  check('deleting the custom card twice is a no-op', db.deleteCustomCard(mine.id), false);

  db.close();

  // ---- The upgrade path --------------------------------------------------
  console.log('\n== 旧数据库升级 ==');
  // A database written before 抽卡事件 existed: the `kind` CHECK only knows
  // two values, and there is no card_draws table at all.
  const legacyPath = path.join(tmpDir, 'legacy.sqlite');
  const SQL = await initSqlJs();
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
      background  TEXT,
      content     TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE memorial_event_contacts (
      memorial_event_id TEXT NOT NULL REFERENCES memorial_events(id) ON DELETE CASCADE,
      contact_id        TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (memorial_event_id, contact_id)
    );
    CREATE TABLE memorial_event_photos (
      id                TEXT PRIMARY KEY,
      memorial_event_id TEXT NOT NULL REFERENCES memorial_events(id) ON DELETE CASCADE,
      relative_path     TEXT NOT NULL,
      original_name     TEXT,
      mime              TEXT,
      size_bytes        INTEGER,
      created_at        TEXT NOT NULL
    );
    INSERT INTO memorial_events(id, kind, title, notes, occurred_at, created_at, updated_at)
      VALUES ('old1', 'other', '旧的一篇', '旧正文', '2024-01-01 10:00:00', '2024-01-01 10:00:00', '2024-01-01 10:00:00');
  `);
  const legacyBytes = legacy.export();
  legacy.close();
  fs.writeFileSync(legacyPath, Buffer.from(legacyBytes));

  const db2 = require('../main/db.js');
  await db2.open(legacyPath);
  const kindSql2 = db2.one(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='memorial_events'");
  checkTrue('the migration widens the kind column',
    kindSql2 && String(kindSql2.sql).includes("'card_draw'"));
  const oldRow = db2.getMemorialEvent('old1');
  check('the existing entry survives the migration', oldRow && oldRow.title, '旧的一篇');
  check('the existing entry keeps its body', oldRow && oldRow.notes, '旧正文');
  const tables2 = db2.all("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r) => r.name);
  checkTrue('the migration creates the card_draws table', tables2.includes('card_draws'));
  // The child tables keep their foreign keys: the rebuilt table has the
  // same name, so the references still resolve.
  const childSql = db2.one(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='memorial_event_contacts'");
  checkTrue('the child tables still reference memorial_events',
    childSql && String(childSql.sql).includes('REFERENCES memorial_events'));
  db2.close();

  // ---- The upgrade path from a build that had the deck already ----------
  console.log('\n== 旧卡库的升级 ==');
  // A database written by a build that already had the card_draws table,
  // but before the user's own cards existed: the table has no `source` and
  // no `card_ref_id` column.
  const oldDeckPath = path.join(tmpDir, 'old-deck.sqlite');
  const oldDeck = new SQL.Database();
  oldDeck.run(`
    CREATE TABLE card_draws (
      id                TEXT PRIMARY KEY,
      week_key          TEXT NOT NULL,
      card_no           INTEGER,
      title             TEXT NOT NULL,
      requirement       TEXT,
      drawn_at          TEXT NOT NULL,
      recorded_at       TEXT,
      memorial_event_id TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_card_draws_week ON card_draws(week_key);
    INSERT INTO card_draws(id, week_key, card_no, title, requirement,
                           drawn_at, created_at)
      VALUES ('d1', '2026-11-02', 30, '看一部经典电影', '和家人朋友看一部经典电影',
              '2026-11-07 10:00:00', '2026-11-07 10:00:00');
  `);
  const oldDeckBytes = oldDeck.export();
  oldDeck.close();
  fs.writeFileSync(oldDeckPath, Buffer.from(oldDeckBytes));

  const db3 = require('../main/db.js');
  await db3.open(oldDeckPath);
  const drawCols = db3.all('PRAGMA table_info(card_draws)').map((c) => c.name);
  checkTrue('the migration adds the source column', drawCols.includes('source'));
  checkTrue('the migration adds the card_ref_id column', drawCols.includes('card_ref_id'));
  const oldDraw = db3.getCardDraw('d1');
  check('the drawn card survives the migration', oldDraw && oldDraw.title, '看一部经典电影');
  check('an old drawn card reads as an official card', oldDraw.source, 'deck');
  const customTables = db3.all("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r) => r.name);
  checkTrue('the migration creates the custom_cards table',
    customTables.includes('custom_cards'));
  db3.close();

  // ---- Cleanup -----------------------------------------------------------
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-card-draws crashed:', e);
  process.exit(1);
});
