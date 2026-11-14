// scripts/test_photo_wall_state.js — 照片墙的「编辑状态」和「导出历史」。
//
// 这两样都存在主进程里（main/photo_wall_state.js、main/photo_wall_history.js），
// 存的是数据库的 settings 表。这里用一个假数据库跑它们 —— 假数据库只实现
// settings 那几个方法（get / set / run / nowStr），存内存里。
//
// 检查的是三件事：
//
//   1. 存档按「用了哪几篇回忆」分 —— 同一组回忆存了再取，回来的还是那份；
//      换一组回忆，取到的是另一份（或者没有）。
//   2. 存档坏了（不是 JSON、版本不对、transform 里的数不是数）不该把页面
//      带崩 —— 应该当成「没有存档」。
//   3. 历史：记一条进去就有了；删掉一条就没了；清空就没了。
//
// Run: node scripts/test_photo_wall_state.js

'use strict';

const assert = require('assert');
const stateMod = require('../main/photo_wall_state.js');
const historyMod = require('../main/photo_wall_history.js');

// ---- 假数据库 --------------------------------------------------------------

// 只实现 settings 表要用的那几个方法。存内存里 —— 这个测试不碰真的数据库。
function fakeDb() {
  const rows = new Map();
  return {
    rows,
    getSetting(key) {
      return rows.has(key) ? rows.get(key) : null;
    },
    setSetting(key, value) {
      rows.set(key, String(value));
    },
    run(sql, params) {
      // 只用到 DELETE FROM settings WHERE key = ?
      if (/DELETE\s+FROM\s+settings/i.test(sql)) {
        rows.delete(params[0]);
        return;
      }
      throw new Error('fakeDb.run: unexpected SQL: ' + sql);
    },
    nowStr() {
      return '2026-11-14 12:00:00';
    },
  };
}

// 一份存档。
function sampleState(over) {
  return Object.assign({
    eventIds: ['ev1', 'ev2'],
    shapeId: 'heart',
    sizeId: 'g8',
    ratioId: '4:3',
    transform: { scale: 0.8, dx: 0.1, dy: -0.05 },
    bgId: '1.png',
    cells: [
      { index: 0, photoId: 'p1', cover: { ratio: '4:3', x: 0.5, y: 0.5, zoom: 1 } },
      { index: 1, photoId: 'p2', cover: null },
    ],
  }, over || {});
}

// ---- 状态 -------------------------------------------------------------------

function testRoundTrip() {
  const db = fakeDb();
  const ids = ['ev1', 'ev2'];

  // 存之前没有存档。
  assert.strictEqual(stateMod.loadState(db, ids), null, '新库不该有存档');

  stateMod.saveState(db, ids, sampleState());

  const got = stateMod.loadState(db, ids);
  assert.ok(got, '存完应该读得回来');
  assert.strictEqual(got.shapeId, 'heart');
  assert.strictEqual(got.sizeId, 'g8');
  assert.strictEqual(got.ratioId, '4:3');
  assert.strictEqual(got.bgId, '1.png');
  assert.strictEqual(got.transform.scale, 0.8);
  assert.strictEqual(got.transform.dx, 0.1);
  assert.strictEqual(got.transform.dy, -0.05);
  assert.strictEqual(got.cells.length, 2);
  assert.strictEqual(got.cells[0].photoId, 'p1');
  assert.strictEqual(got.cells[0].cover.zoom, 1);
  assert.strictEqual(got.cells[1].photoId, 'p2');
  assert.strictEqual(got.cells[1].cover, null);
}

function testKeyedByEventSet() {
  const db = fakeDb();
  stateMod.saveState(db, ['ev1', 'ev2'], sampleState({ sizeId: 'g8' }));
  stateMod.saveState(db, ['ev3'], sampleState({ sizeId: 'g12' }));

  // 同一组回忆 -> 同一份。
  assert.strictEqual(stateMod.loadState(db, ['ev1', 'ev2']).sizeId, 'g8');
  // 顺序不同也是同一组（用户重新勾选时顺序常常不一样）。
  assert.strictEqual(stateMod.loadState(db, ['ev2', 'ev1']).sizeId, 'g8');
  // 换一组回忆 -> 另一份。
  assert.strictEqual(stateMod.loadState(db, ['ev3']).sizeId, 'g12');
  // 没存过的那组 -> 没有存档。
  assert.strictEqual(stateMod.loadState(db, ['ev9']), null);
  // 一组也不能空 —— 空 ids 不对应任何一面墙。
  assert.strictEqual(stateMod.loadState(db, []), null);
}

function testCorruptIsIgnored() {
  const db = fakeDb();
  const ids = ['ev1'];

  // 不是 JSON。
  db.setSetting(stateMod.KEY_PREFIX + stateMod.wallKey(ids), 'not json at all');
  assert.strictEqual(stateMod.loadState(db, ids), null, '存坏的存档该当成没有');

  // 版本不对（老版本的结构）。
  db.setSetting(stateMod.KEY_PREFIX + stateMod.wallKey(ids),
    JSON.stringify({ version: 999, shapeId: 'heart' }));
  assert.strictEqual(stateMod.loadState(db, ids), null, '版本不对的存档该当成没有');

  // transform 里的数不是数（形状会飞到画布外面去）—— 整个 transform 丢掉，
  // 但这份存档的其余部分还是好的，所以读得回来。
  db.setSetting(stateMod.KEY_PREFIX + stateMod.wallKey(ids), JSON.stringify({
    version: stateMod.STATE_VERSION,
    shapeId: 'heart', sizeId: 'g8', ratioId: '1:1',
    transform: { scale: 'big', dx: null, dy: 0 },
    cells: [],
  }));
  const ok = stateMod.loadState(db, ids);
  assert.ok(ok, 'transform 坏了不该把整份存档丢掉');
  assert.strictEqual(ok.transform, null, '坏掉的 transform 该被丢掉');
}

function testClear() {
  const db = fakeDb();
  const ids = ['ev1', 'ev2'];
  stateMod.saveState(db, ids, sampleState());
  assert.ok(stateMod.loadState(db, ids));
  assert.strictEqual(stateMod.clearState(db, ids), true);
  assert.strictEqual(stateMod.loadState(db, ids), null, '清掉之后不该还有存档');
  // 另一组不受影响。
  stateMod.saveState(db, ['ev3'], sampleState());
  stateMod.clearState(db, ids);
  assert.ok(stateMod.loadState(db, ['ev3']), '清一组不该动到另一组');
}

// ---- 历史 -------------------------------------------------------------------

function testHistory() {
  const db = fakeDb();
  assert.deepStrictEqual(historyMod.listEntries(db), [], '新库不该有历史');

  const entry = historyMod.addEntry(db, {
    exportedAt: '2026-11-14 10:00:00',
    path: '/tmp/wall.png',
    width: 2560, height: 1920, photoCount: 12,
    shapeId: 'heart', sizeId: 'g8', ratioId: '4:3',
    snapshot: sampleState(),
  });
  assert.ok(entry && entry.id, '记进去的那条该有 id');

  const list = historyMod.listEntries(db);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].path, '/tmp/wall.png');
  assert.strictEqual(list[0].width, 2560);
  assert.strictEqual(list[0].photoCount, 12);
  // 快照要留着 —— 「按这版再导」靠它。
  assert.ok(list[0].snapshot, '快照该留着');
  assert.strictEqual(list[0].snapshot.sizeId, 'g8');

  // 再记一条 —— 最新的在最前面。
  historyMod.addEntry(db, { path: '/tmp/wall2.png', width: 100, height: 100 });
  const list2 = historyMod.listEntries(db);
  assert.strictEqual(list2.length, 2);
  assert.strictEqual(list2[0].path, '/tmp/wall2.png', '最新的该在最前面');
  assert.strictEqual(list2[1].path, '/tmp/wall.png');

  // 删掉一条。
  const afterRemove = historyMod.removeEntry(db, list2[0].id);
  assert.strictEqual(afterRemove.length, 1);
  assert.strictEqual(afterRemove[0].path, '/tmp/wall.png');

  // 删一条不存在的 —— 列表不动，也不报错。
  const afterMiss = historyMod.removeEntry(db, 'nope');
  assert.strictEqual(afterMiss.length, 1);

  // 清空。
  historyMod.clearEntries(db);
  assert.deepStrictEqual(historyMod.listEntries(db), []);
}

function testHistoryCap() {
  const db = fakeDb();
  // 记的次数比上限还多 —— 旧的丢掉，只留最近的。
  const total = historyMod.MAX_ENTRIES + 5;
  for (let i = 0; i < total; i += 1) {
    historyMod.addEntry(db, { path: `/tmp/wall-${i}.png`, width: 1, height: 1 });
  }
  const list = historyMod.listEntries(db);
  assert.strictEqual(list.length, historyMod.MAX_ENTRIES, '历史不该无限长');
  // 最新的一条还在。
  assert.strictEqual(list[0].path, `/tmp/wall-${total - 1}.png`);
}

// ---- 跑起来 -----------------------------------------------------------------

const tests = [
  ['存档存了能取回来', testRoundTrip],
  ['存档按哪几篇回忆分', testKeyedByEventSet],
  ['存坏的存档当成没有', testCorruptIsIgnored],
  ['清掉存档', testClear],
  ['导出历史', testHistory],
  ['导出历史有上限', testHistoryCap],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    console.error('  ✗ ' + name);
    console.error('    ' + ((e && e.stack) || e));
  }
}

if (failed) {
  console.error(`\n${failed} / ${tests.length} 个检查没过`);
  process.exitCode = 1;
} else {
  console.log(`\n全部 ${tests.length} 个检查通过`);
}
