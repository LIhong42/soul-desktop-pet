// src/js/file_image.js — 挑下来的图片怎么在页面里显示。
//
// 主窗口的 CSP 是 `img-src 'self' data: file:` —— blob: URL 会被当场拒绝
// （「Refused to load the image 'blob:…'」），图片就是一张裂图。所以挑下来
// 的文件读成 data URL 再交给 <img>。
//
// 文件本身没有搬家：它还在 input.files 里，保存的时候照旧上传。这一步只是
// 给用户看一眼。

// 一个挑好的文件 → data URL（读不出来时是 null）。
export function fileToDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// 常见的图片后缀 —— 浏览器有时给不出类型（file.type 是空的），这时按后缀认。
const IMAGE_MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// 一个挑好的文件是不是图片。
export function isImageFile(file) {
  if (!file) return false;
  if (String(file.type || '').startsWith('image/')) return true;
  return Boolean(IMAGE_MIME_BY_EXT[fileExt(file.name)]);
}

// 文件的 mime —— 浏览器知道就用浏览器的，不知道就按后缀猜。
//
// 空着的 mime 会让照片表里的那一行没有类型，导出时的解码要多绕一次；
// 按后缀猜出来的类型省掉这一绕。
export function imageMimeForFile(file) {
  if (!file) return '';
  const type = String(file.type || '');
  if (type.startsWith('image/')) return type;
  return IMAGE_MIME_BY_EXT[fileExt(file.name)] || '';
}
