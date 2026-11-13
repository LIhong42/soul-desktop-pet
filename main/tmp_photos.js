// main/tmp_photos.js — 照片墙「临时导入」的照片。
//
// 照片墙可以导入系统里的照片，但它们不属于任何一篇回忆 —— 它们只是这一面
// 墙的素材。所以它们不进数据库，也不进回忆的照片目录，而是放在
// <appData>/SoulDesktopPet/tmp-photos/ 下：
//
//   1. 导入时写进来（导出时按原图分辨率画进格子）；
//   2. 导出完成后删掉（这面墙的 PNG 已经拿到手了）；
//   3. 万一应用崩了 —— 下次启动时扫一遍，残骸不能一直躺着。
//
// 文件名就是照片的 id（<uuid><后缀>），原文件名只留在渲染进程里（那里
// 还要拿它做标签）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 扩展名 —— 按 mime 猜，猜不到就看原文件的后缀。
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/tiff': '.tif',
};

// id 的形状 —— 渲染进程会把 id 传回来读文件/删文件，所以它只能是
// 「字母数字下划线连字符 + 一个后缀」，别的（路径分隔符、..）一律拒绝。
const ID_RE = /^[A-Za-z0-9_-]{6,64}(\.[A-Za-z0-9]{1,8})?$/;

// 临时照片的目录。
function tmpDir(appData) {
  return path.join(appData, 'SoulDesktopPet', 'tmp-photos');
}

function ensureDir(appData) {
  const dir = tmpDir(appData);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// id → 文件路径。id 不合法（或文件不在）时是 null。
function fileOf(appData, id) {
  const name = String(id || '');
  if (!ID_RE.test(name)) return null;
  const file = path.join(tmpDir(appData), name);
  // 双保险：拼出来的路径必须还在临时目录里。
  if (path.dirname(file) !== tmpDir(appData)) return null;
  if (!fs.existsSync(file)) return null;
  return file;
}

// 存一张临时照片。返回 { id, mime, size }。
function save({ appData, filename, mime, bytes }) {
  if (!bytes || !bytes.byteLength) throw new Error('photo bytes required');
  const dir = ensureDir(appData);
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  let ext = EXT_BY_MIME[type] || '';
  if (!ext) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || ''));
    ext = m ? '.' + m[1].toLowerCase() : '.bin';
  }
  const id = crypto.randomUUID() + ext;
  const buf = Buffer.from(bytes);
  fs.writeFileSync(path.join(dir, id), buf);
  return { id, mime: type || null, size: buf.length };
}

// 读一张临时照片的原始字节。读不出来是 null。
function read({ appData, id }) {
  const file = fileOf(appData, id);
  if (!file) return null;
  try {
    return fs.readFileSync(file);
  } catch (e) {
    console.error('tmp photo read failed:', e && e.message);
    return null;
  }
}

// 删一张临时照片。
function remove({ appData, id }) {
  const file = fileOf(appData, id);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    console.error('tmp photo remove failed:', e && e.message);
    return false;
  }
}

// 清空临时目录 —— 导出之后的清理，以及应用启动时的扫尾。
// 返回删掉了几张。
function clear({ appData }) {
  const dir = tmpDir(appData);
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return 0;
  }
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(dir, name));
      n += 1;
    } catch (e) { /* 删不掉的就留着 —— 下次启动再扫 */ }
  }
  return n;
}

module.exports = {
  save,
  read,
  remove,
  clear,
  fileOf,
  tmpDir,
};
