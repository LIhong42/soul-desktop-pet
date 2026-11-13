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
