// main/album_docx.js — Word (.docx) 回忆相册生成器。
//
// 一个 .docx 就是一个 ZIP 包，里面装了一组 OOXML 部件。这里用项目
// 已有的 adm-zip 直接拼这些部件，不引入 docx 之类的额外依赖。
//
// 包结构（最小可用集）：
//   [Content_Types].xml      —— 每个部件的 MIME 声明
//   _rels/.rels              —— 包级关系，指向 word/document.xml
//   docProps/core.xml        —— 标题 / 作者 / 生成时间
//   docProps/app.xml         —— 应用名
//   word/document.xml        —— 正文（我们真正要写的东西）
//   word/_rels/document.xml.rels —— 正文里图片 / 超链接的关系
//   word/media/imageN.ext    —— 照片字节，原样打包
//   word/styles.xml          —— 标题 / 正文的样式定义
//
// 两个模式：
//   1. LAYOUT MODE：buildAlbum({ events, layout, outPath, progressCb })
//      复用相册编辑器（src/js/pages/album_editor.js）产出的 AlbumLayout，
//      按页面顺序输出：每页一个小节，槽位里的照片内嵌，标题 / 说明
//      作为段落。
//   2. LEGACY MODE：buildAlbum({ events, outPath, progressCb }) 不带
//      layout —— 按事件分章节，字段 + 照片网格，和 PDF 的 legacy 模式
//      对应，供「导出相册 (Word)」按钮直接使用。
//
// 与 PDF 的关键差异：Word 没有「画布」概念，槽位坐标（0..100 归一化）
// 只能映射成表格来近似还原版式。所以 layout 模式下用一张两列的
// 无边框表格承载槽位：照片槽放图片，文本槽放段落。

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { app } = require('electron');

// 注意：这里刻意不用 adm-zip 来「写」docx。
//
// .docx 是 OPC 包，Word 的 OPC 读取器比普通 zip 工具严格得多。adm-zip
// 写出来的 zip 有两处会让 Word 直接报「Word 在试图打开文件时遇到错误」
// 并拒绝打开（正文为空）：
//
//   1. version-made-by 字段是 0x0a14 —— 高字节 10 = OS/2 NTFS 主机。
//      Word 自己写的包这里是 0x002d（FAT/MS-DOS）。主机字段决定
//      external_attr 里那 16 位「Unix 权限位」是否被解释，NTFS 主机
//      会让 Word 把条目当成带 Unix mode 的文件处理，判定为非法包。
//   2. external_attr = 0x81a40000，高 16 位是 Unix mode 0100644。
//      Word 自己写的包这里是 0。
//
// 另外 adm-zip 会把条目重排，_rels/.rels 排在 [Content_Types].xml 前面；
// OPC 约定 [Content_Types].xml 必须是包里的第一个条目。
//
// 所以下面自己拼 zip 字节，字段对齐 Word 的写法。adm-zip 仍可用于读取
// （测试脚本就在用），只是不参与生成。

// CRC-32（与 zip 使用的多项式一致），表延迟构建。
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 把 [{ name, data }] 打包成 zip 字节。data 可以是 string 或 Buffer。
// 元数据刻意与 Word 产出的包保持一致（见上方注释）。
function buildZipBytes(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    // 图片已经是压缩格式（JPEG/PNG），再 deflate 一遍几乎不省空间，
    // 白白拖慢导出，所以用 store(0)；XML 部件才走 deflate(8)。
    const alreadyCompressed = /\.(png|jpe?g|gif|bmp|tiff?)$/i.test(f.name);
    const method = alreadyCompressed ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data, { level: 6 }) : data;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);  // local file header signature
    lh.writeUInt16LE(20, 4);           // version needed to extract
    lh.writeUInt16LE(0, 6);            // general purpose flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);           // mod time (0 = 00:00:00)
    lh.writeUInt16LE(0x21, 12);        // mod date (0x21 = 1980-01-01)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra field length
    localParts.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);  // central directory signature
    // version made by：低字节版本 + 高字节主机。0x002d = 版本 45 / FAT，
    // 这是 Word 自己写出来的值，必须照抄（见文件头注释）。
    ch.writeUInt16LE(0x002d, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra field length
    ch.writeUInt16LE(0, 32);           // file comment length
    ch.writeUInt16LE(0, 34);           // disk number start
    ch.writeUInt16LE(0, 36);           // internal file attributes
    ch.writeUInt32LE(0, 38);           // external file attributes = 0
    ch.writeUInt32LE(offset, 42);      // relative offset of local header
    centralParts.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // end of central directory
  eocd.writeUInt16LE(0, 4);            // this disk
  eocd.writeUInt16LE(0, 6);            // disk with central directory
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);           // comment length
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---- 主题（与 src/js/album_layouts.js、main/album_pdf.js 保持一致）------

const THEMES = {
  classic: { id: 'classic', cssVar: { bg: '#ffffff', text: '#2a2a2a', muted: '#8a8478', accent: '#d97757' } },
  film:    { id: 'film',    cssVar: { bg: '#f5efe2', text: '#3a2e1f', muted: '#8a7a5e', accent: '#8a6a3a' } },
  magazine:{ id: 'magazine',cssVar: { bg: '#ffffff', text: '#111111', muted: '#666666', accent: '#000000' } },
  warm:    { id: 'warm',    cssVar: { bg: '#fff4e6', text: '#5a3a1a', muted: '#b08868', accent: '#a85530' } },
  dark:    { id: 'dark',    cssVar: { bg: '#1a1a1a', text: '#f0e6dd', muted: '#9a8f80', accent: '#c89070' } },
};

const LAYOUT_TEMPLATES = {
  'single-full': {
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 100, h: 78 },
      { type: 'caption', x: 0,  y: 78, w: 100, h: 22 },
    ],
  },
  'big-top-text-bottom': {
    slots: [
      { type: 'photo',   x: 4,  y: 4,  w: 92, h: 72 },
      { type: 'title',   x: 4,  y: 76, w: 92, h: 8 },
      { type: 'caption', x: 4,  y: 84, w: 92, h: 12 },
    ],
  },
  'split-h-text-bottom': {
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 50, h: 80 },
      { type: 'photo',   x: 50, y: 0,  w: 50, h: 80 },
      { type: 'caption', x: 0,  y: 80, w: 100,h: 20 },
    ],
  },
  'three-grid-text': {
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 50, h: 40 },
      { type: 'photo',   x: 50, y: 0,  w: 50, h: 40 },
      { type: 'photo',   x: 0,  y: 40, w: 100,h: 40 },
      { type: 'caption', x: 0,  y: 80, w: 100,h: 20 },
    ],
  },
  'one-photo-side-cap': {
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 60, h: 100 },
      { type: 'title',   x: 62, y: 6,  w: 34, h: 14 },
      { type: 'caption', x: 62, y: 22, w: 34, h: 72 },
    ],
  },
};

function getTheme(id) {
  return THEMES[id] || THEMES.classic;
}
function getTemplate(id) {
  return LAYOUT_TEMPLATES[id] || LAYOUT_TEMPLATES['single-full'];
}

// ---- 照片解析（与 main/album_pdf.js 相同的规则）--------------------------

const photoRoot = () => path.join(app.getPath('appData'), 'SoulDesktopPet', 'photos');

function resolvePhoto(p) {
  if (p.full_path) return p.full_path;
  const ext = path.extname(String(p.relative_path || '')).toLowerCase();
  return path.join(photoRoot(), p._event_id || p.eventId || '', path.basename(p.relative_path || ''));
}

// Word 能吃的图片格式。HEIC 是 PDF 那边的老问题：pdfkit 打不开，Word
// 同样打不开，所以两种格式都在这里直接跳过。
const WORD_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff']);

function imageExtFor(p) {
  const raw = path.extname(String(p.relative_path || '')).toLowerCase();
  if (WORD_IMAGE_EXT.has(raw)) return raw === '.jpeg' ? '.jpg' : raw;
  // relative_path 缺失时退回实际文件名的扩展名。
  const fromPath = path.extname(String(resolvePhoto(p) || '')).toLowerCase();
  if (WORD_IMAGE_EXT.has(fromPath)) return fromPath === '.jpeg' ? '.jpg' : fromPath;
  return null;
}

function isEmbeddablePhoto(p) {
  if (!p) return false;
  if (p._is_heic || p._is_heif) return false;
  if (p.mime && /heic|heif/i.test(p.mime)) return false;
  if (!imageExtFor(p)) return false;
  const fp = resolvePhoto(p);
  try { return fs.existsSync(fp); } catch { return false; }
}

// ---- 图片自然尺寸 --------------------------------------------------------
//
// Word 的 <w:drawing> 需要 EMU 单位的显示尺寸，并且必须写出图片真实的
// 宽高比，否则 Word 会自己拉伸。这里手写一个轻量的尺寸嗅探器，只认识
// 常见格式的 header，够用且不引依赖（pdfkit 的 openImage 我们拿不到
// —— 它要一个 PDFDocument 实例，代价太大）。
//
// 返回 { width, height }（像素），失败时返回 null。

function sniffImageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: 8 字节签名 + IHDR
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), orientation: 1 };
  }
  // GIF: 'GIF8' + LE 宽高
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), orientation: 1 };
  }
  // BMP: 'BM' + LE 宽高
  if (buf.toString('ascii', 0, 2) === 'BM') {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), orientation: 1 };
  }
  // JPEG: 逐段扫描，先找 SOF0..SOF15 拿宽高，再顺路找 APP1 里的 EXIF 方向
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let sof = null;
    let orientation = 1;
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      // 填充字节
      if (marker === 0xff) { i += 1; continue; }
      // 无负载长度的标记
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (!sof) {
        const isSof = marker >= 0xc0 && marker <= 0xcf
          && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          sof = { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
      }
      // APP1 (EXIF) 总在 SOF 之前，所以顺序扫描一次就能同时拿到两者。
      if (marker === 0xe1 && orientation === 1) {
        const o = readExifOrientation(buf, i + 4, len - 2);
        if (o) orientation = o;
      }
      i += 2 + len;
    }
    if (!sof) return null;
    // 方向 5..8 表示旋转了 90°，宽高互换（与 src/js/album_layouts.js
    // 的 applyExifOrientation 一致）。PDF 那条路径靠 pdfkit 自动处理，
    // 这里必须自己换算，否则竖拍照片在 Word 里会躺着显示。
    const swapped = orientation >= 5 && orientation <= 8;
    return swapped
      ? { width: sof.height, height: sof.width, orientation }
      : { width: sof.width, height: sof.height, orientation };
  }
  // TIFF：Word 基本不认，跳过。
  return null;
}

// EXIF APP1 里读 Orientation（tag 0x0112）。找到就返回 1..8，否则 null。
function readExifOrientation(buf, start, len) {
  if (start + 4 > buf.length) return null;
  // "Exif\0\0"
  if (buf.toString('ascii', start, start + 4) !== 'Exif') return null;
  let p = start + 6;
  const tiff = buf.toString('ascii', p, p + 2);
  const le = tiff === 'II';
  if (!le && tiff !== 'MM') return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = p + u32(p + 4);
  if (ifd + 2 > buf.length) return null;
  const count = u16(ifd);
  for (let k = 0; k < count; k += 1) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > buf.length) return null;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return (v >= 1 && v <= 8) ? v : null;
    }
  }
  return null;
}

// pt → EMU（1pt = 12700 EMU）
const PT_TO_EMU = 12700;
// 排版网格：Word 用缇（twip），1pt = 20 twip
const PT_TO_TWIP = 20;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ---- XML 工具 ------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符会让 Word 报「文件已损坏」
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function shortText(s, max = 200) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function fmtDateOnly(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

// ---- 文档构件 ------------------------------------------------------------

class DocxBuilder {
  constructor(theme) {
    this.theme = theme || getTheme('classic');
    this.body = [];
    this.rels = [];        // { id, type, target, mode? }
    this.media = [];       // { name, ext, buffer }
    this._relSeq = 0;
    this._imgSeq = 0;
    // 图片 id 从 1 开始；rId 从 2 起，rId1 留给 styles.xml。
    this._nextRelId = 2;
  }

  // ---- relationships ----

  addImageRel(ext) {
    const id = `rId${this._nextRelId++}`;
    // imageExtFor() 返回带前导点的扩展名，这里去掉再拼，避免出现
    // "image1..jpg" 这种双点文件名（部分 Word 版本会拒绝加载）。
    const bare = String(ext).replace(/^\./, '');
    const name = `image${++this._imgSeq}.${bare}`;
    this.rels.push({
      id,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
      target: `media/${name}`,
    });
    this.media.push({ name, ext });
    return { relId: id, mediaName: name };
  }

  // ---- 段落 ----

  // opts: { style, size (pt), bold, italic, color (hex w/o #), align,
  //         spacingBefore, spacingAfter, font }
  para(text, opts = {}) {
    const o = opts;
    const pPr = [];
    if (o.style) pPr.push(`<w:pStyle w:val="${esc(o.style)}"/>`);
    if (o.align) pPr.push(`<w:jc w:val="${o.align}"/>`);
    const spacing = [];
    if (o.spacingBefore != null) spacing.push(`w:before="${Math.round(o.spacingBefore * PT_TO_TWIP)}"`);
    if (o.spacingAfter != null) spacing.push(`w:after="${Math.round(o.spacingAfter * PT_TO_TWIP)}"`);
    if (spacing.length) pPr.push(`<w:spacing ${spacing.join(' ')}/>`);
    const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';

    // 默认字体走 styles.xml 的 docDefaults；这里只在显式指定时覆盖。
    const rPr = [];
    if (o.font) rPr.push(`<w:rFonts w:ascii="${esc(o.font)}" w:hAnsi="${esc(o.font)}" w:eastAsia="${esc(o.font)}" w:cs="${esc(o.font)}"/>`);
    if (o.bold) rPr.push('<w:b/>');
    if (o.italic) rPr.push('<w:i/>');
    let color = o.color;
    if (color) color = String(color).replace('#', '').toUpperCase();
    if (color) rPr.push(`<w:color w:val="${esc(color)}"/>`);
    if (o.size) rPr.push(`<w:sz w:val="${Math.round(o.size * 2)}"/><w:szCs w:val="${Math.round(o.size * 2)}"/>`);
    const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';

    const runs = Array.isArray(text)
      // 多段文本：[{ text, bold?, italic?, color?, size? }, ...]
      ? text.map((seg) => this._run(seg.text, {
        ...opts, ...seg,
      })).join('')
      : this._run(text, o);
    this.body.push(`<w:p>${pPrXml}${runs}</w:p>`);
  }

  _run(text, o = {}) {
    if (text == null || text === '') return '';
    // 保留换行 —— Word 用 <w:br/> 表示段内换行
    const lines = String(text).split(/\r?\n/);
    const pieces = [];
    lines.forEach((line, i) => {
      if (i > 0) pieces.push('<w:br/>');
      if (line !== '') {
        pieces.push(`<w:t xml:space="preserve">${esc(line)}</w:t>`);
      }
    });
    if (!pieces.length) return '';
    const rPr = [];
    if (o.font) rPr.push(`<w:rFonts w:ascii="${esc(o.font)}" w:hAnsi="${esc(o.font)}" w:eastAsia="${esc(o.font)}" w:cs="${esc(o.font)}"/>`);
    if (o.bold) rPr.push('<w:b/>');
    if (o.italic) rPr.push('<w:i/>');
    let color = o.color;
    if (color) color = String(color).replace('#', '').toUpperCase();
    if (color) rPr.push(`<w:color w:val="${esc(color)}"/>`);
    if (o.size) rPr.push(`<w:sz w:val="${Math.round(o.size * 2)}"/><w:szCs w:val="${Math.round(o.size * 2)}"/>`);
    const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
    return `<w:r>${rPrXml}${pieces.join('')}</w:r>`;
  }

  // 空段落（占位 / 分节）
  spacer(pts = 8) {
    this.body.push(`<w:p><w:pPr><w:spacing w:after="${Math.round(pts * PT_TO_TWIP)}"/></w:pPr></w:p>`);
  }

  // 分页符
  pageBreak() {
    this.body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  }

  // ---- 图片 ----
  //
  // drawW/drawH 是目标显示尺寸（pt），srcW/srcH 是原图像素。
  // 用一个 paragraph 包住 inline drawing —— 这是 Word 图片最常见的
  // 形态，兼容 Word / WPS / LibreOffice / Google Docs。
  //
  // 返回 true 表示已写入；false 表示图片字节不可用。
  image(relId, drawW, drawH, srcW, srcH, alt = '') {
    const cx = Math.max(1, Math.round(drawW * PT_TO_EMU));
    const cy = Math.max(1, Math.round(drawH * PT_TO_EMU));
    const docPrId = ++this._imgSeq + 1000; // 与 media 序号错开，避免撞号
    const descr = esc(alt || '照片');
    this.body.push(
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60"/></w:pPr>'
      + '<w:r><w:drawing>'
      + '<wp:inline distT="0" distB="0" distL="0" distR="0">'
      + `<wp:extent cx="${cx}" cy="${cy}"/>`
      + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
      + `<wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${descr}"/>`
      + '<wp:cNvGraphicFramePr>'
      + '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>'
      + '</wp:cNvGraphicFramePr>'
      + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:nvPicPr>'
      + `<pic:cNvPr id="${docPrId}" name="Picture ${docPrId}" descr="${descr}"/>`
      + '<pic:cNvPicPr/>'
      + '</pic:nvPicPr>'
      + '<pic:blipFill>'
      + `<a:blip r:embed="${relId}"/>`
      + '<a:stretch><a:fillRect/></a:stretch>'
      + '</pic:blipFill>'
      + '<pic:spPr>'
      + `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
      + '</pic:spPr>'
      + '</pic:pic>'
      + '</a:graphicData>'
      + '</a:graphic>'
      + '</wp:inline>'
      + '</w:drawing></w:r></w:p>'
    );
    return true;
  }

  // ---- 表格 ----
  //
  // 用于还原 layout 的槽位排版。cellWidths 是各列的百分比数组。
  // borders: false → 无边框（只用做隐形布局），true → 细灰框。
  tableStart(cellWidths, { borders = false } = {}) {
    // tblW w:type="pct" 的单位是 1/50 百分点（100% = 5000，不是 100）。
    // gridCol 用 twip，A4 正文宽约 9638twip，所以 1% ≈ 96twip。
    const pctTotal = Math.round(cellWidths.reduce((a, b) => a + b, 0) * 50);
    const cols = cellWidths
      .map((w) => `<w:gridCol w:w="${Math.round(w * 96)}"/>`)
      .join('');
    const b = borders
      ? '<w:tblBorders>'
        + '<w:top w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>'
        + '<w:left w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>'
        + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>'
        + '<w:right w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>'
        + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>'
        + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>'
        + '</w:tblBorders>'
      : '<w:tblBorders>'
        + '<w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        + '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        + '<w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        + '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        + '<w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        + '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        + '</w:tblBorders>';
    this.body.push(
      '<w:tbl><w:tblPr>'
      + `<w:tblW w:w="${pctTotal}" w:type="pct"/>`
      + '<w:tblLayout w:type="fixed"/>'
      + b
      + '<w:tblCellMar>'
      + '<w:top w:w="40" w:type="dxa"/><w:left w:w="60" w:type="dxa"/>'
      + '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="60" w:type="dxa"/>'
      + '</w:tblCellMar>'
      + `</w:tblPr><w:tblGrid>${cols}</w:tblGrid>`
    );
    // CT_Tbl 的子元素是 w:tr，w:tc 必须包在 w:tr 里。
    // 少一层 w:tr 会让 Word 直接判定整个文档损坏（打不开、内容空白）。
    this._tblCols = cellWidths.length;
    this._tblRowOpen = false;
    this._tblCellsInRow = 0;
  }

  // 显式开始新的一行
  tableRow() {
    this.tableRowEnd();
    this.body.push('<w:tr>');
    this._tblRowOpen = true;
    this._tblCellsInRow = 0;
  }

  // 结束当前行（如果没有开着的行则什么都不做）
  tableRowEnd() {
    if (!this._tblRowOpen) return;
    this.body.push('</w:tr>');
    this._tblRowOpen = false;
    this._tblCellsInRow = 0;
  }

  tableCell(contentXml, { span = 1, vAlign = 'center' } = {}) {
    // 还没开行就先开一行；每写满一行的单元格就自动收尾。
    if (!this._tblRowOpen) {
      this.body.push('<w:tr>');
      this._tblRowOpen = true;
      this._tblCellsInRow = 0;
    }
    this.body.push(
      '<w:tc><w:tcPr>'
      + (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '')
      + `<w:vAlign w:val="${vAlign}"/>`
      + '</w:tcPr>'
      + (contentXml || '<w:p/>')
      + '</w:tc>'
    );
    this._tblCellsInRow += span;
    if (this._tblCols && this._tblCellsInRow >= this._tblCols) {
      this.tableRowEnd();
    }
  }

  // 临时抓取 body 追加的内容，转成表格单元格里的 XML
  captureCell(fn) {
    const mark = this.body.length;
    fn();
    const xml = this.body.splice(mark).join('');
    // 表格单元格必须至少含一个段落；图片已经在 fn 里 push 了段落。
    return xml || '<w:p/>';
  }

  tableEnd() {
    this.tableRowEnd();
    this.body.push('</w:tbl>');
    // 表格后紧跟一个空段落，否则相邻表格在 Word 里会粘在一起。
    this.body.push('<w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>');
  }

  // ---- 输出 ----

  documentXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document '
      + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
      + 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
      + '<w:body>'
      + this.body.join('')
      + '<w:sectPr>'
      + '<w:pgSz w:w="11906" w:h="16838"/>'   // A4 纵向
      + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" '
      + 'w:header="851" w:footer="992" w:gutter="0"/>'
      + '</w:sectPr>'
      + '</w:body></w:document>';
  }

  documentRelsXml() {
    const rels = [
      '<Relationship Id="rId1" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
      + 'Target="styles.xml"/>',
      ...this.rels.map((r) => (
        `<Relationship Id="${r.id}" `
        + `Type="${r.type}" `
        + `Target="${r.target}"/>`
      )),
    ];
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + rels.join('')
      + '</Relationships>';
  }

  contentTypesXml() {
    // 图片类型按实际打包的扩展名去重声明。
    const extTypes = {
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
    };
    const exts = new Set(this.media.map((m) => m.ext));
    const imgDefaults = Array.from(exts)
      // Extension 属性不带前导点 —— OOXML 要求写成 "png" 而不是 ".png"。
      .map((e) => `<Default Extension="${e.replace(/^\./, '')}" ContentType="${extTypes[e] || 'application/octet-stream'}"/>`)
      .join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + imgDefaults
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>';
  }

  rootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
      + 'Target="word/document.xml"/>'
      + '<Relationship Id="rId2" '
      + 'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
      + 'Target="docProps/core.xml"/>'
      + '<Relationship Id="rId3" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
      + 'Target="docProps/app.xml"/>'
      + '</Relationships>';
  }

  // ECMA-376 的 CT_Style 是一个有序的 xsd:sequence，子元素顺序必须严格
  // 照写：
  //
  //   name, aliases, basedOn, next, link, autoRedefine, hidden,
  //   uiPriority, semiHidden, unhideWhenUsed, qFormat, locked, ...,
  //   rsid, pPr, rPr, tblPr, trPr, tcPr, tblStylePr
  //
  // 顺序写错时 Word 不会报「第 N 行有问题」，而是直接拒绝整个文件：
  // 「Word 在试图打开文件时遇到错误」/「文件似乎已经损坏」。
  // 这个坑非常隐蔽 —— XML 是良构的，所有部件都存在，只有 Word 的严格
  // schema 校验才会发现。
  stylesXml() {
    const c = this.theme.cssVar;
    // Word 的 w:val 用无 '#' 的大写十六进制。主题表里两种写法都有，
    // 统一成大写，避免同一份文档里出现大小写混排的颜色值。
    const hex = (v, fallback) => (v ? String(v).replace('#', '') : fallback).toUpperCase();
    const accent = hex(c.accent, 'D97757');
    const text = hex(c.text, '2A2A2A');
    const muted = hex(c.muted, '8A8478');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:docDefaults><w:rPrDefault><w:rPr>'
      // 明确指定 eastAsia 字体，否则中文在部分 Word 版本里会掉回宋体。
      + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑" w:cs="Calibri"/>'
      + '<w:sz w:val="22"/><w:szCs w:val="22"/>'
      + '</w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
      + '</w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
      + `<w:name w:val="Normal"/><w:qFormat/>`
      + `<w:rPr><w:color w:val="${text}"/></w:rPr>`
      + '</w:style>'
      // 文档大标题
      + '<w:style w:type="paragraph" w:styleId="Title">'
      + '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>'
      + '<w:pPr><w:spacing w:before="0" w:after="120"/><w:jc w:val="center"/></w:pPr>'
      + `<w:rPr><w:b/><w:color w:val="${text}"/><w:sz w:val="72"/><w:szCs w:val="72"/></w:rPr>`
      + '</w:style>'
      // 章节标题（每个事件 / 每一页）
      + '<w:style w:type="paragraph" w:styleId="Heading1">'
      + '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>'
      + '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>'
      + `<w:rPr><w:b/><w:color w:val="${accent}"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>`
      + '</w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading2">'
      + '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>'
      + '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>'
      + `<w:rPr><w:b/><w:color w:val="${text}"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>`
      + '</w:style>'
      // 图片说明 / 次要信息
      + '<w:style w:type="paragraph" w:styleId="Caption">'
      + '<w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/>'
      + '<w:pPr><w:spacing w:before="40" w:after="120"/><w:jc w:val="center"/></w:pPr>'
      + `<w:rPr><w:i/><w:color w:val="${muted}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>`
      + '</w:style>'
      + '</w:styles>';
  }

  corePropsXml(title) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<cp:coreProperties '
      + 'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" '
      + 'xmlns:dcterms="http://purl.org/dc/terms/" '
      + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${esc(title || '回忆相册')}</dc:title>`
      + '<dc:creator>SoulDesktopPet</dc:creator>'
      + '<cp:lastModifiedBy>SoulDesktopPet</cp:lastModifiedBy>'
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
      + `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
      + '</cp:coreProperties>';
  }

  appPropsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
      + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
      + '<Application>SoulDesktopPet</Application>'
      + '<Company>SoulDesktopPet</Company>'
      + '</Properties>';
  }

  // 打包成 docx。图片字节挂在 this.media[i].buf 上。
  //
  // 条目顺序是刻意的：OPC 约定 [Content_Types].xml 必须是包里的第一个
  // 条目，Word 的读取器依赖它来发现其余部件的类型。
  write(outPath) {
    const files = [
      { name: '[Content_Types].xml', data: this.contentTypesXml() },
      { name: '_rels/.rels', data: this.rootRelsXml() },
      { name: 'word/document.xml', data: this.documentXml() },
      { name: 'word/_rels/document.xml.rels', data: this.documentRelsXml() },
      { name: 'word/styles.xml', data: this.stylesXml() },
      { name: 'docProps/core.xml', data: this.corePropsXml() },
      { name: 'docProps/app.xml', data: this.appPropsXml() },
    ];
    for (const m of this.media) {
      if (!m.buf) continue;
      files.push({ name: `word/media/${m.name}`, data: m.buf });
    }
    fs.writeFileSync(outPath, buildZipBytes(files));
  }
}

// ---- 图片嵌入 ------------------------------------------------------------
//
// 读取字节 + 嗅探尺寸，返回 { relId, buf, srcW, srcH } 或 null。
// registerImage 必须是同步的（段落 XML 立刻需要 relId），所以这里同步
// 读文件 —— 单张照片通常几百 KB，本地读足够快。

function registerImage(doc, photo, maxW, maxH) {
  const ext = imageExtFor(photo);
  if (!ext) return null;
  const fp = resolvePhoto(photo);
  let buf;
  try { buf = fs.readFileSync(fp); } catch { return null; }
  if (!buf || !buf.length) return null;
  const size = sniffImageSize(buf);
  const srcW = size && size.width ? size.width : 4;
  const srcH = size && size.height ? size.height : 3;
  // 等比缩到目标框内
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const { relId, mediaName } = doc.addImageRel(ext);
  // 字节直接挂在 media 记录上，打包时按顺序读，避免两张数组失步。
  doc.media[doc.media.length - 1].buf = buf;
  return { relId, mediaName, buf, srcW, srcH, drawW, drawH };
}

// ---- 排版常量 ------------------------------------------------------------

// A4 纵向正文宽度（pt）：595.28 - 2×56.7pt(2cm) ≈ 482
const CONTENT_W = 482;
// legacy 模式照片网格：两列
const GRID_COLS = 2;
const GRID_GAP_PT = 8;
const GRID_CELL_W = (CONTENT_W - GRID_GAP_PT * (GRID_COLS - 1)) / GRID_COLS;

// ---- main entry -----------------------------------------------------------

// Build a Word (.docx) 回忆相册.
//
//   options: {
//     events:   MemorialEventRowWithPhotos[]
//     layout?:  AlbumLayout (themeId + pages[])  -- if missing, legacy mode
//     outPath:  string
//     progressCb: (phase, percent, note?) => void
//   }
//
// Returns: { pages, events, photos, bytes, heicSkipped, mode }
async function buildAlbum(options) {
  const { events, layout, outPath, progressCb = () => {} } = options || {};
  if (!Array.isArray(events)) throw new Error('buildAlbum: events required');
  if (!outPath) throw new Error('buildAlbum: outPath required');

  const safeProgress = (phase, percent, note) => {
    try { progressCb(phase, Math.max(0, Math.min(100, percent)), note); } catch {}
  };
  safeProgress('preparing', 0);

  // 解析照片路径 + 统计 HEIC，跟 PDF 那边的处理保持一致。
  let heicSkipped = 0;
  for (const ev of events) {
    ev.photos = Array.isArray(ev.photos) ? ev.photos : [];
    ev.photos.forEach((p) => {
      const ext = path.extname(String(p.relative_path || '')).toLowerCase();
      p._is_heic = ext === '.heic' || ext === '.heif';
      if (p.mime && /heic|heif/i.test(p.mime)) p._is_heic = true;
      if (p._is_heic) heicSkipped += 1;
      p._event_id = ev.id;
      p.full_path = resolvePhoto(p);
    });
    ev.photos.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  }

  const photoIndex = new Map();
  for (const ev of events) {
    for (const p of (ev.photos || [])) photoIndex.set(p.id, p);
  }

  const theme = layout ? getTheme(layout.themeId) : getTheme('classic');
  const doc = new DocxBuilder(theme);

  const mode = layout ? 'layout' : 'legacy';
  let photosRendered = 0;
  const onPhoto = () => {
    photosRendered += 1;
    safeProgress('encoding', 5 + 80 * Math.min(1, photosRendered / Math.max(1, totalEmbeddable(events))),
      `已嵌入 ${photosRendered} 张`);
  };

  if (layout) renderLayoutMode(doc, layout, theme, photoIndex, onPhoto, events);
  else renderLegacyMode(doc, events, theme, onPhoto);

  safeProgress('finalizing', 92);

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  doc.write(outPath);

  const bytes = fs.statSync(outPath).size;
  safeProgress('done', 100);
  return {
    pages: layout ? (layout.pages || []).length + 1 : events.length + 1,
    events: events.length,
    photos: photosRendered,
    bytes,
    heicSkipped,
    mode,
  };
}

function totalEmbeddable(events) {
  let n = 0;
  for (const ev of events) {
    for (const p of (ev.photos || [])) if (isEmbeddablePhoto(p)) n += 1;
  }
  return n;
}

// ---- 封面 ----------------------------------------------------------------

function renderCover(doc, cover, theme, events) {
  const c = theme.cssVar;
  const totalEvents = events.length;
  let totalPhotos = 0;
  for (const ev of events) {
    for (const p of (ev.photos || [])) if (isEmbeddablePhoto(p)) totalPhotos += 1;
  }
  doc.spacer(90);
  doc.para(cover.title || '回忆相册', { style: 'Title' });
  const subtitle = cover.subtitle || '';
  if (subtitle) {
    doc.para(shortText(subtitle, 60), { align: 'center', color: c.muted, size: 12 });
  }
  if (cover.showStats !== false && totalEvents > 0) {
    doc.para(`${totalEvents} 个事件 · ${totalPhotos} 张照片`, {
      align: 'center', color: c.muted, size: 11,
    });
  }
  doc.spacer(20);
  doc.para(`生成于 ${fmtDateOnly(new Date().toISOString())}`, {
    align: 'center', color: c.muted, size: 9,
  });
  doc.pageBreak();
}

// ---- 照片网格（legacy 模式）---------------------------------------------
//
// 按 GRID_COLS 列排照片网格。用无边框表格，宽度按单元格均分。

function renderPhotoGrid(doc, photos, theme, onPhoto, captionFor) {
  const c = theme.cssVar;
  const cellW = GRID_CELL_W;
  const rows = Math.ceil(photos.length / GRID_COLS);
  for (let r = 0; r < rows; r += 1) {
    doc.tableStart(new Array(GRID_COLS).fill(100 / GRID_COLS));
    for (let col = 0; col < GRID_COLS; col += 1) {
      const p = photos[r * GRID_COLS + col];
      const xml = doc.captureCell(() => {
        if (!p) { doc.para('', {}); return; }
        if (!isEmbeddablePhoto(p)) {
          doc.para(heicNote(p), { align: 'center', color: c.muted, size: 9, italic: true });
          return;
        }
        const img = registerImage(doc, p, cellW, cellW);
        if (!img) {
          doc.para('（图片加载失败）', { align: 'center', color: c.muted, size: 9 });
          return;
        }
        doc.image(img.relId, img.drawW, img.drawH, img.srcW, img.srcH, photoAlt(p));
        onPhoto();
      });
      doc.tableCell(xml);
    }
    doc.tableEnd();
    // 网格下方的说明
    const first = photos[r * GRID_COLS];
    if (first && captionFor) {
      doc.para(captionFor(first, r), { style: 'Caption' });
    }
  }
}

function heicNote(p) {
  if (p && (p._is_heic || (p.mime && /heic|heif/i.test(p.mime)))) {
    return '（HEIC 暂不支持）';
  }
  return '（照片缺失）';
}

function photoAlt(p) {
  return p.original_name || path.basename(String(p.relative_path || '照片'));
}

// ---- LEGACY MODE ---------------------------------------------------------

function renderLegacyMode(doc, events, theme, onPhoto) {
  const c = theme.cssVar;

  // 封面
  renderCover(doc, { title: '回忆相册', subtitle: '', showStats: true }, theme, events);

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    const evTitle = ev.title || '(无标题)';
    const evDate = fmtDateOnly(ev.occurred_at);
    const contacts = Array.isArray(ev.contact_names) && ev.contact_names.length
      ? ev.contact_names.join('、') : '独立事件';

    doc.para(evTitle, { style: 'Heading1' });
    const subParts = [evDate, contacts].filter(Boolean).join('  ·  ');
    if (subParts) doc.para(subParts, { color: c.muted, size: 10 });

    // 字段表（地点 / 食物 / 穿搭 / 活动 / 笔记）
    const details = [
      ['地点', ev.place], ['食物', ev.food], ['穿搭', ev.outfit],
      ['活动', ev.activities], ['笔记', ev.notes],
    ].filter(([, v]) => v && String(v).trim());
    if (details.length) {
      doc.tableStart([16, 84], { borders: true });
      for (const [k, v] of details) {
        const kXml = doc.captureCell(() => doc.para(k, { bold: true, color: c.accent, size: 10 }));
        doc.tableCell(kXml, { vAlign: 'top' });
        const vXml = doc.captureCell(() => doc.para(shortText(v, 400), { size: 10 }));
        doc.tableCell(vXml, { vAlign: 'top' });
      }
      doc.tableEnd();
    }

    const embeddable = (ev.photos || []).filter((p) => isEmbeddablePhoto(p));
    if (embeddable.length === 0) {
      const skipped = (ev.photos || []).length;
      doc.para(skipped > 0
        ? `（本事件 ${skipped} 张照片暂不支持嵌入）`
        : '（本事件暂无照片）', { color: c.muted, size: 10, italic: true });
    } else {
      renderPhotoGrid(doc, embeddable, theme, onPhoto,
        (p) => shortText(p.original_name || path.basename(String(p.relative_path || '')), 120));
    }
    doc.spacer(6);
  }
}

// ---- LAYOUT MODE ---------------------------------------------------------
//
// Word 没有绝对定位画布，用「每页一个 2 列表格」来还原槽位结构：
//   - 模板槽位按 y 排序，同一行的槽位放同一行的单元格
//   - photo 槽 → 单元格内嵌图（按槽位宽高比算显示尺寸）
//   - title / caption 槽 → 单元格内放段落
//   - freeTexts 浮动文本框 → 该页表格下方依次追加段落

function renderLayoutMode(doc, layout, theme, photoIndex, onPhoto, events) {
  const c = theme.cssVar;
  const cover = layout.cover || { title: '回忆相册', subtitle: '', showStats: true };
  renderCover(doc, cover, theme, events || []);

  const pages = Array.isArray(layout.pages) ? layout.pages : [];
  const totalPages = pages.length;

  for (let i = 0; i < totalPages; i += 1) {
    const page = pages[i];
    const template = getTemplate(page.templateId);

    doc.para(`第 ${i + 1} / ${totalPages} 页`, { style: 'Heading2', color: c.muted });
    // 细分隔
    doc.para('', { color: c.muted, size: 6 });

    // 槽位按 type 分组：照片槽先排（图片），文本槽在后。
    // 复刻版式的核心：把 photo 槽按 template 顺序取出，逐行放进 2 列表格。
    // claimed 记录本页已被占用的 content 槽，避免同一个槽被两个
    // template 槽重复引用（照片就会在文档里出现两次）。
    const claimed = new Set();
    const photoSlots = template.slots
      .map((tSlot, idx) => ({ tSlot, idx, content: findContent(page, tSlot, idx, claimed) }))
      .filter((x) => x.tSlot.type === 'photo');

    if (photoSlots.length === 0) {
      // 没有照片槽（理论上不会发生），只输出文本。
    } else if (photoSlots.length === 1) {
      const { tSlot, content } = photoSlots[0];
      // 满版单图：整宽渲染
      const cellXml = doc.captureCell(() => renderSlotCell(doc, tSlot, content, theme, photoIndex, onPhoto, CONTENT_W));
      doc.tableStart([100]);
      doc.tableCell(cellXml);
      doc.tableEnd();
    } else {
      // 多图：按 template 里的行分组（y 相同 = 同一行）。
      const rows = groupSlotsByRow(photoSlots);
      for (const row of rows) {
        const cols = row.length;
        doc.tableStart(new Array(cols).fill(100 / cols));
        for (const { tSlot, content } of row) {
          const cellXml = doc.captureCell(() => renderSlotCell(doc, tSlot, content, theme, photoIndex, onPhoto, CONTENT_W / cols));
          doc.tableCell(cellXml);
        }
        doc.tableEnd();
      }
    }

    // 文本槽（title / caption）
    for (let tIdx = 0; tIdx < template.slots.length; tIdx += 1) {
      const tSlot = template.slots[tIdx];
      if (tSlot.type === 'photo') continue;
      const content = findContent(page, tSlot, tIdx, claimed);
      const text = (content && content.text) || '';
      if (text) renderTextSlot(doc, text, tSlot, content, theme);
    }

    // 浮动文本框
    const fts = Array.isArray(page.freeTexts) ? page.freeTexts : [];
    for (const ft of fts) {
      if (!ft || !ft.text) continue;
      doc.para(shortText(String(ft.text), 400), {
        color: ft.color || c.text,
        size: clamp(Number(ft.fontSize) || 12, 6, 48),
        bold: ft.fontWeight === 'bold',
        italic: ft.fontStyle === 'italic',
        align: ft.textAlign || 'left',
      });
    }

    if (i < totalPages - 1) doc.pageBreak();
  }
}

// 把 template 的 photo 槽按 y 坐标聚成行（同一 y = 同一表格行）。
function groupSlotsByRow(slotList) {
  const sorted = slotList.slice().sort((a, b) => (a.tSlot.y - b.tSlot.y) || (a.tSlot.x - b.tSlot.x));
  const rows = [];
  let cur = null;
  let curY = null;
  for (const s of sorted) {
    if (curY == null || Math.abs(s.tSlot.y - curY) > 0.01) {
      cur = [];
      rows.push(cur);
      curY = s.tSlot.y;
    }
    cur.push(s);
  }
  return rows;
}

function renderSlotCell(doc, tSlot, content, theme, photoIndex, onPhoto, cellW) {
  const c = theme.cssVar;
  if (!content || !content.photoId || !photoIndex.has(content.photoId)) {
    // 空槽或缺图 → 虚线感的提示文字。
    doc.para('（空位）', { align: 'center', color: c.muted, size: 9, italic: true });
    return;
  }
  const photo = photoIndex.get(content.photoId);
  if (!isEmbeddablePhoto(photo)) {
    doc.para(heicNote(photo), { align: 'center', color: c.muted, size: 9, italic: true });
    return;
  }
  // 槽位宽高比决定图片显示框。
  const slotAspect = (tSlot.w / tSlot.h) || 1;
  const boxH = cellW / slotAspect;
  const img = registerImage(doc, photo, cellW, boxH);
  if (!img) {
    doc.para('（图片加载失败）', { align: 'center', color: c.muted, size: 9 });
    return;
  }
  doc.image(img.relId, img.drawW, img.drawH, img.srcW, img.srcH, photoAlt(photo));
  onPhoto();
}

function renderTextSlot(doc, text, tSlot, content, theme) {
  const c = theme.cssVar;
  const isTitle = tSlot.type === 'title';
  let color = c.text;
  if (content && typeof content.color === 'string' && content.color) color = content.color;
  const scale = (content && typeof content.fontScale === 'number' && content.fontScale > 0)
    ? content.fontScale : 1;
  const baseSize = isTitle ? 18 : 11;
  doc.para(shortText(text, 400), {
    align: (content && content.textAlign) || (isTitle ? 'center' : 'left'),
    color,
    size: clamp(baseSize * scale, 6, 48),
    bold: content ? content.bold === true : isTitle,
    italic: content ? content.italic === true : false,
    spacingBefore: 4,
    spacingAfter: 6,
  });
}

// 匹配 layout 的槽位内容和 template 槽位。
//
// 首选按 _slotTemplate 坐标精确匹配（编辑器正常产出的布局都有）。对
// 坐标缺失的老布局，退化成「按类型取第 n 个」——这里的 n 是该类型槽位
// 在 template 中的出现序号，且只在该类型槽位总数不超过实际内容数量时
// 才回退。否则同一个 photoId 会被多个槽位重复引用，同一张照片在文档
// 里出现好几次。
function findContent(page, tSlot, idx, claimed) {
  if (!page || !page.slots) return null;
  for (const s of page.slots) {
    if (s._slotTemplate
      && s._slotTemplate.x === tSlot.x
      && s._slotTemplate.y === tSlot.y
      && s._slotTemplate.w === tSlot.w
      && s._slotTemplate.h === tSlot.h) {
      if (claimed) claimed.add(s);
      return s;
    }
  }
  // 回退：同类型里第一个还没被占用的。
  const used = claimed || new Set();
  const candidate = page.slots.find((s) => s.type === tSlot.type && !used.has(s)) || null;
  if (candidate) used.add(candidate);
  return candidate;
}

module.exports = { buildAlbum };