// main/photo_thumb.js — 照片的缩略图。
//
// 照片墙上可能有上百张照片，编辑器里每一张都要摆出来。编辑器要的是缩略
// 图 —— 原图一兆好几兆，一百张就是几百兆，页面会被拖垮。
//
// 缩略图用 ffmpeg 生成：项目里所有图片处理都走它（main/png_border_cutout.js
// 那一套），不额外引入 sharp 之类的原生依赖。
//
// 缩略图落在照片目录之外（<appData>/SoulDesktopPet/thumbs），免得备份的
// 时候跟着原图复制一遍。照片上传之后就不会再改，所以按 photo_id 缓存是
// 安全的。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runFfmpeg, probeSize } = require('./png_border_cutout')._internal;

// 缩略图的最长边。
const THUMB_MAX = 512;

// 缩略图目录。
function thumbDir(appData) {
  return path.join(appData, 'SoulDesktopPet', 'thumbs');
}

// 一张 PNG 有没有透明通道：看文件头第 26 个字节（颜色类型 4 / 6）。
// 有透明通道的存成 PNG —— 存成 JPEG 会把透明的地方变成黑的。
function pngHasAlpha(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(26);
    fs.readSync(fd, buf, 0, 26, 0);
    fs.closeSync(fd);
    const isPng = buf.length === 26 && buf.slice(1, 4).toString('latin1') === 'PNG';
    if (!isPng) return false;
    const colorType = buf[25];
    return colorType === 4 || colorType === 6;
  } catch {
    return false;
  }
}

// 缩略图。
//
//   photoId     —— 照片的行 id，用来做缓存的名字
//   sourcePath  —— 原图在磁盘上的位置
//   appData     —— 用户数据目录
//
// 返回 { data_url, width, height }，或者 null（原图不在、或者 ffmpeg
// 处理不了这张图 —— 调用方自己决定怎么办）。
async function getThumb({ photoId, sourcePath, appData }) {
  if (!photoId || !sourcePath || !fs.existsSync(sourcePath)) return null;
  const ext = pngHasAlpha(sourcePath) ? '.png' : '.jpg';
  const outPath = path.join(thumbDir(appData), `${photoId}${ext}`);
  try {
    if (!fs.existsSync(outPath)) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      // `scale` 的第一个参数取原宽和 512 里小的那个 —— 比 512 小的图不该
      // 放大。第二个参数 -2 表示高度按比例算并取偶数。
      const vf = `scale='min(${THUMB_MAX},iw)':-2:flags=lanczos`;
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', sourcePath,
        '-vf', vf,
        '-frames:v', '1',
        '-q:v', '4',
        outPath,
      ]);
    }
    const size = await probeSize(outPath);
    const buf = fs.readFileSync(outPath);
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return {
      data_url: `data:${mime};base64,${buf.toString('base64')}`,
      width: size.width,
      height: size.height,
    };
  } catch (e) {
    console.error('photo thumb failed:', e && e.message);
    return null;
  }
}

module.exports = {
  getThumb,
  thumbDir,
  THUMB_MAX,
};
