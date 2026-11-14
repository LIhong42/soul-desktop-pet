// scripts/test_photo_wall_ipc.js — 照片墙的存档和历史，走**真的** IPC。
//
// scripts/test_photo_wall_state.js 测的是那两个模块的规则；这个测的是**接线**：
// 主进程真的注册了那几个通道吗？渲染进程真的能通过 preload 调到吗？
// 存的真的进了数据库吗（存完把数据库整个读回来看看）？
//
// 跑的是真的 main/db.js（真的 SQLite 文件，真的 settings 表）和真的
// preload.js —— 数据目录指向一个临时目录，不碰用户自己的数据库。
//
// Run: node scripts/run-electron.js scripts/run-photo-wall-ipc.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

// ---- 真的 IPC 处理器 --------------------------------------------------------
//
// 这几个通道的处理逻辑跟 main/ipc.js 里的一模一样 —— 抄过来是因为
// main/ipc.js 的 register() 需要整个应用（桌宠、提醒队列、PIN 门禁），
// 撑不起一个测试。这里只留照片墙要用的那几个通道，用的是**真的**模块。
function registerWallIpc(db) {
  const photoWallState = require(path.join(ROOT, 'main', 'photo_wall_state.js'));
  const photoWallHistory = require(path.join(ROOT, 'main', 'photo_wall_history.js'));

  ipcMain.handle('photo_wall_state:get', (_e, payload = {}) =>
    photoWallState.loadState(db, payload && payload.eventIds));
  ipcMain.handle('photo_wall_state:save', (_e, payload = {}) =>
    photoWallState.saveState(db, payload && payload.eventIds, payload && payload.state));
  ipcMain.handle('photo_wall_state:clear', (_e, payload = {}) =>
    photoWallState.clearState(db, payload && payload.eventIds));

  ipcMain.handle('photo_wall_history:list', () => photoWallHistory.listEntries(db));
  ipcMain.handle('photo_wall_history:add', (_e, payload = {}) =>
    photoWallHistory.addEntry(db, payload || {}));
  ipcMain.handle('photo_wall_history:remove', (_e, payload = {}) =>
    photoWallHistory.removeEntry(db, payload && payload.id));
  ipcMain.handle('photo_wall_history:clear', () => photoWallHistory.clearEntries(db));

  return { photoWallState, photoWallHistory };
}

// 主进程里的导出处理器 —— 跟 main/ipc.js 里的一样，只是把「保存对话框」
// 换成了直接写文件（测试里没有对话框）。
function registerExportIpc(db, outPath, photoWallHistory) {
  ipcMain.handle('export:photo_wall', async (_e, payload = {}) => {
    const bytes = payload && payload.bytes;
    if (!bytes || !bytes.byteLength) throw new Error('没有可导出的照片墙数据');
    fs.writeFileSync(outPath, Buffer.from(bytes));
    const meta = payload.meta || {};
    const entry = photoWallHistory.addEntry(db, {
      exportedAt: db.nowStr(),
      path: outPath,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      photoCount: Number(meta.photoCount) || 0,
      shapeId: meta.shapeId || '',
      sizeId: meta.sizeId || '',
      ratioId: meta.ratioId || '',
      snapshot: meta.snapshot || null,
    });
    return { path: outPath, bytes: bytes.byteLength, entry };
  });
}

const report = { ok: false };

module.exports = (async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-ipc-'));
  // 数据目录指向临时目录 —— 不碰用户自己的数据库。
  app.setPath('appData', tmp);
  app.setPath('userData', path.join(tmp, 'userData'));

  const db = require(path.join(ROOT, 'main', 'db.js'));
  const dbPath = path.join(tmp, 'SoulDesktopPet', 'soul-desktop-pet.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  await db.open(dbPath);

  const { photoWallHistory } = registerWallIpc(db);
  const outPath = path.join(tmp, 'wall.png');
  registerExportIpc(db, outPath, photoWallHistory);

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    // The harness page carries no CSP of its own, so Electron prints its
    // security warning into the console. It says nothing about the wall.
    if (level >= 2 && !/Security Warning/.test(message)) errors.push(message);
  });

  try {
    // 一个最小的页面 —— 只用 preload 的桥。
    const page = path.join(tmp, 'ipc-page.html');
    fs.writeFileSync(page, `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body><div id="app"></div>
<script type="module" src="./ipc-page.js"></script></body></html>`, 'utf8');
    fs.writeFileSync(path.join(tmp, 'ipc-page.js'), `
      window.mpTest = {};
      window.mpTest.save = (ids, state) => window.mp.photoWallState.save({ eventIds: ids, state });
      window.mpTest.get = (ids) => window.mp.photoWallState.get({ eventIds: ids });
      window.mpTest.clear = (ids) => window.mp.photoWallState.clear({ eventIds: ids });
      window.mpTest.histAdd = (e) => window.mp.photoWallHistory.add(e);
      window.mpTest.histList = () => window.mp.photoWallHistory.list();
      window.mpTest.histRemove = (id) => window.mp.photoWallHistory.remove({ id });
      window.mpTest.histClear = () => window.mp.photoWallHistory.clear();
      window.mpTest.exportWall = (bytes, meta) => window.mp.export_.photoWall({ bytes, meta });
      window.mpTest.ready = true;
    `, 'utf8');
    await win.loadFile(page);
    await new Promise((r) => setTimeout(r, 600));

    const call = (fn, ...args) => win.webContents.executeJavaScript(
      `window.mpTest.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`);

    // ---- 存档：存 → 取 → 真的在数据库里 ---------------------------------
    const ids = ['ev1', 'ev2'];
    const snap = {
      eventIds: ids,
      shapeId: 'heart',
      sizeId: 'g11',
      ratioId: '16:9',
      transform: { scale: 0.77, dx: 0.03, dy: -0.02 },
      bgId: 'bg-1.png',
      cells: [
        { index: 0, photoId: 'p1', cover: { ratio: '16:9', x: 0.4, y: 0.6, zoom: 1.2 } },
        { index: 1, photoId: 'p2', cover: null },
      ],
    };
    await call('save', ids, snap);
    const got = await call('get', ids);
    report.savedThroughIpc = !!(got
      && got.sizeId === 'g11'
      && got.ratioId === '16:9'
      && got.bgId === 'bg-1.png'
      && got.transform && got.transform.scale === 0.77
      && got.cells.length === 2
      && got.cells[0].cover && got.cells[0].cover.zoom === 1.2);

    // 真的写进数据库了吗？把 settings 表整个读出来看。
    const row = db.one(
      'SELECT value FROM settings WHERE key LIKE ?',
      ['photo_wall_state_%']
    );
    report.storedInDb = !!(row && String(row.value).includes('"sizeId":"g11"'));

    // 换一组回忆 —— 取不到那一份。
    const other = await call('get', ['ev3']);
    report.otherSelectionEmpty = other === null;

    // 清掉 —— 真的没了。
    await call('clear', ids);
    report.cleared = (await call('get', ids)) === null;
    report.rowGone = !db.one('SELECT value FROM settings WHERE key LIKE ?', ['photo_wall_state_%']);

    // ---- 历史：导出 → 记一条 → 列出来 → 删掉 -----------------------------
    // 真的字节 —— 走 IPC 过去还是 Uint8Array（主进程看的是 byteLength）。
    const r = await win.webContents.executeJavaScript(`(async () => {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      return window.mp.export_.photoWall({
        bytes,
        meta: {
          width: 2880, height: 1620, photoCount: 7,
          shapeId: 'heart', sizeId: 'g11', ratioId: '16:9',
          snapshot: ${JSON.stringify(snap)},
        },
      });
    })()`);
    report.exported = !!(r && r.path === outPath && fs.existsSync(outPath));
    report.exportRecorded = !!(r && r.entry && r.entry.id);

    const list = await call('histList');
    report.historyListed = !!(Array.isArray(list) && list.length === 1);
    report.historyHasSnapshot = !!(list && list[0] && list[0].snapshot
      && list[0].snapshot.sizeId === 'g11');
    report.historyMeta = !!(list && list[0]
      && list[0].width === 2880 && list[0].height === 1620 && list[0].photoCount === 7);

    // 删掉一条。
    const afterRemove = await call('histRemove', list[0].id);
    report.historyRemoved = Array.isArray(afterRemove) && afterRemove.length === 0;

    // 全清。
    await call('histAdd', { path: '/tmp/x.png' });
    await call('histClear');
    report.historyCleared = (await call('histList')).length === 0;

    report.errors = errors;
    report.ok = report.savedThroughIpc
      && report.storedInDb
      && report.otherSelectionEmpty
      && report.cleared
      && report.rowGone
      && report.exported
      && report.exportRecorded
      && report.historyListed
      && report.historyHasSnapshot
      && report.historyMeta
      && report.historyRemoved
      && report.historyCleared
      && errors.length === 0;
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.errors = errors;
  }

  console.log(JSON.stringify(report, null, 2));
  const reportPath = path.join(__dirname, '_photo_wall_ipc_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  if (!report.ok) process.exitCode = 1;
})();
