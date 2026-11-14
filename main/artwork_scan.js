// main/artwork_scan.js — 扫描资源目录里的图片，共用的那几行。
//
// ---------------------------------------------------------------------------
// 这是什么
// ---------------------------------------------------------------------------
// 应用里有两处「扫描一个目录、把里面的图片列出来」的地方：
//
//   main/ui_artwork.js      —— resources/ui/ 里的页面背景（一层）
//   main/photo_wall_bg.js   —— resources/photo_wall_background/ 里的照片墙
//                              背景（一层子目录，按画幅分组）
//
// 两边要做的事是一样的：只看 .png，跳过不是文件的东西，把文件名变成 id，
// 把磁盘位置变成 file:// URL，然后按 id 排序（数字优先：2 在 10 前面）。
//
// 排序必须是稳定的 —— readdir 的顺序取决于文件系统，用户看到的「第一张」
// 不该在两台机器上不一样。
//
// 抽出来是为了让两边的规则不会各走各的：以后改一处，另一处跟着改。
//
// 它只管「一个目录里的若干张图片」。目录本身怎么组织（平铺还是分组）由
// 调用方决定 —— 这一层不猜。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * 列出目录里的图片。
 *
 * 返回 `[{ id, file, url, label }]`，按 id 排序。
 *
 *   dir       —— 要扫的目录
 *   ext       —— 接受的扩展名（含点，小写）
 *   accept    —— 可选：拿到文件名后的额外判断，返回 false 就跳过这一张
 *
 * 目录不存在（这一版安装没带这份资源）不算错 —— 返回空数组。少一张背景
 * 不该让整个应用起不来。
 */
function listFiles(dir, ext, accept) {
  const wanted = String(ext || '.png').toLowerCase();

  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const rows = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(wanted)) continue;
    const abs = path.join(dir, name);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch { continue; }
    const id = path.basename(name, path.extname(name));
    if (!id) continue;
    if (accept && !accept(id, name)) continue;
    rows.push({
      id,
      file: name,
      // 和页面背景同一套编码方式：中文文件名不百分号编码的话 <img> 会静
      // 默地加载失败。
      url: pathToFileURL(abs).href,
      // 名字就是标签 —— 编一个别的名字就意味着图片改名时要改第二处。
      label: id,
    });
  }

  return sortById(rows);
}

/**
 * 按 id 排序：数字优先（2 在 10 前面），然后是按名字排。
 */
function sortById(rows) {
  return rows.sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;      // numeric ids first, then named ones
    if (bNum) return 1;
    return a.id.localeCompare(b.id);
  });
}

module.exports = {
  listFiles,
  sortById,
};
