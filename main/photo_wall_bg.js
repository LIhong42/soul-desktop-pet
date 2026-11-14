// main/photo_wall_bg.js — 照片墙的背景图库。
//
// ---------------------------------------------------------------------------
// 资源怎么摆
// ---------------------------------------------------------------------------
// `resources/photo_wall_background/` 下面每个子目录是一个**画幅**，目录名
// 写成「宽-高」（比如 `1-1`、`16-9`）。目录里的每一张图片都是那个画幅下
// 的一张背景候选，同一个画幅下可以有任意多张（1.png、2.png……）。
//
// 画幅名和日记封面的画幅是一套（16:9 / 4:3 / 1:1 / 3:4 / 9:16），所以
// `1-1` 就是 `1:1` 画幅。照片墙选了哪个画幅，就到哪个目录里找背景。
//
// 目录是空的（还没做这一档的背景）就当没有背景 —— 照片墙照旧画在白底上。
//
// ---------------------------------------------------------------------------
// 为什么图片要走 IPC
// ---------------------------------------------------------------------------
// 渲染进程读不了文件系统，而主窗口的 CSP 是 `img-src 'self' data: file:`
// —— 所以本地图片必须跨过 IPC 边界才能到渲染进程，和页面背景
// （main/ui_artwork.js）、桌宠立绘是同一套路。
//
// 图片有两条路过去，各有各的用处：
//
//   list()  → 每张图的 `file://` URL（诊断、<img> 预览用）
//   read()  → 图片的**字节**（真正画进画布时用这个）
//
// 画进画布必须走字节：从 file:// 加载的页面里画一张 file:// 的图会把画布
// 弄脏（opaque origin），随后 `toBlob()` 抛 SecurityError —— 导出的照片墙
// 会一个像素都拿不到。字节过去以后由渲染进程用 createImageBitmap 解，
// 画布干干净净。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const artworkScan = require('./artwork_scan');

// 只有 PNG 是背景 —— 背景图要带透明通道的话，PNG 是最省事的一种。
const ACCEPTED_EXT = '.png';

// 扫描结果缓存。`null` ⇒ 还没扫过。
//
// 资源目录在运行时是静态的，每次渲染都去 stat 一遍是白费力气。
let cache = null;

/**
 * 背景图库在磁盘上的位置。
 *
 * `appPath` 是应用根目录（`main/` 的上一级），和 pet_registry 找
 * `resources/pets` 的方式一致。
 */
function bgDir(appPath) {
  return path.join(appPath || path.join(__dirname, '..'), 'resources', 'photo_wall_background');
}

/**
 * 目录名（`1-1`）→ 画幅 id（`1:1`）。
 *
 * 目录名里只有一个连字符，两边都是整数才是合法的画幅名。认不出来的目录
 * 直接跳过 —— 它要么是还没做背景的画幅，要么是用户随手放的东西，两种都不
 * 该让照片墙报错。
 */
function folderToRatio(folder) {
  const m = /^(\d+)-(\d+)$/.exec(String(folder || '').trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  return `${w}:${h}`;
}

/**
 * 画幅 id（`1:1`）→ 目录名（`1-1`）。
 */
function ratioToFolder(ratioId) {
  const m = /^(\d+):(\d+)$/.exec(String(ratioId || '').trim());
  if (!m) return null;
  return `${Number(m[1])}-${Number(m[2])}`;
}

/**
 * 列出所有画幅的背景图。
 *
 * 返回 `{ '1:1': [{ id, file, url, label }], '4:3': [...] }` —— 键是画幅 id，
 * 值是这个画幅下的背景候选。没有背景的画幅不出现在结果里。
 *
 * 每个画幅内按文件名排序（数字优先：2 在 10 前面），所以候选的顺序在不同
 * 机器上是一样的 —— 用户的「第一张」不会因为文件系统的顺序而变。
 */
function list(appPath) {
  if (cache) return cache;

  const dir = bgDir(appPath);
  let folders = [];
  try {
    folders = fs.readdirSync(dir);
  } catch {
    // 整个目录都没有 —— 这是一个不带背景资源也能正常跑的应用。
    cache = {};
    return cache;
  }

  const out = {};
  for (const folder of folders) {
    const ratioId = folderToRatio(folder);
    if (!ratioId) continue;
    const abs = path.join(dir, folder);
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch { continue; }

    // 每个子目录扫一遍 —— 「什么算一张图片、行的形状、怎么排序」这些规则
    // 和页面背景共用（见 main/artwork_scan.js）。
    const rows = artworkScan.listFiles(abs, ACCEPTED_EXT);
    if (!rows.length) continue;
    out[ratioId] = rows;
  }

  cache = out;
  return cache;
}

/**
 * 某个画幅下的背景候选。
 *
 * 没有这一档的背景时返回空数组（不是 null）—— 调用方可以直接遍历。
 */
function forRatio(appPath, ratioId) {
  const all = list(appPath);
  const folder = ratioToFolder(ratioId);
  if (!folder) return [];
  const key = folderToRatio(folder);
  return all[key] || [];
}

/**
 * 读一张背景的原始字节。
 *
 * 渲染进程画背景用的是 `createImageBitmap`，它要的是**字节**而不是
 * `file://` URL —— 从 `file://` 页面里画一张 `file://` 的图会把画布弄脏，
 * `toBlob()` 就会抛 SecurityError，导出的 PNG 一个像素都拿不到。
 * 字节过来以后由渲染进程自己解成 bitmap，画布干干净净。
 *
 * 找不到时返回 null。
 */
function read(appPath, ratioId, bgId) {
  const id = String(bgId == null ? '' : bgId).trim();
  if (!id) return null;
  const folder = ratioToFolder(ratioId);
  if (!folder) return null;
  const hit = forRatio(appPath, ratioId).find((b) => b.id === id);
  if (!hit) return null;
  try {
    return fs.readFileSync(path.join(bgDir(appPath), folder, hit.file));
  } catch (e) {
    console.error('photo wall background read failed:', e && e.message);
    return null;
  }
}

module.exports = {
  ACCEPTED_EXT,
  bgDir,
  folderToRatio,
  ratioToFolder,
  list,
  forRatio,
  read,
};
