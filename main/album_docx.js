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
// buildAlbum({ events, outPath, progressCb }) 先输出一页封面，然后每篇
// 回忆一页：顶端是标题行，中间是这篇回忆的文字板块和图片板块，底端是
// 日期行。图片板块照着回忆编辑页的图组排布摆开，每张照片都单独链回它
// 在磁盘上的原图。

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { app } = require('electron');
const {
  parseDiaryContent, photoWidthPx, galleryRows, photoFrame, coverRatioValue,
} = require('./diary_content');

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
// （解包走的是它的读取路径），只是不参与生成。

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
    // 方向 5..8 表示旋转了 90°，宽高互换。PDF 那条路径靠 pdfkit 自动
    // 处理，这里必须自己换算，否则竖拍照片在 Word 里会躺着显示。
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

// 相册的配色（标题 / 正文 / 弱化文字 / 强调色）。
const THEME = {
  cssVar: { bg: '#ffffff', text: '#2a2a2a', muted: '#8a8478', accent: '#d97757' },
};

class DocxBuilder {
  constructor(theme) {
    this.theme = theme || THEME;
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
    // 图片自己的编号也跟着走 —— Word 里的图片用 docPr id 互相区分，
    // 那个编号跟包里的文件名是两回事，但同一个数字用两处最省心。
    return { relId: id, mediaName: name, docPrId: this._imgSeq };
  }

  // ---- 外部链接 ----

  // 一条指向包外文件的链接。TargetMode="External" 让 Word 把它当成
  // 外部目标，而不是包里的一个部件。
  //
  // 照片用它：导出的相册里每一张照片都指向它在磁盘上的原图，读者点
  // 一下就能打开原图，而不是只能看着导出件里的那一份压缩图。
  addExternalRel(url) {
    const id = `rId${this._nextRelId++}`;
    this.rels.push({
      id,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
      target: url,
      mode: 'External',
    });
    return id;
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

  // 一条色带 —— 回忆卡片那两条横条（标题行 / 日期行）。
  //
  // 色带是一张只有一格的表格：单元格的底色铺满整行的宽度，文字在格
  // 子里缩进一点。用段落底纹（w:shd）也能上色，但那段底纹跟着文字的
  // 高度走，文字一多色带就长高，跟编辑页那条固定高度的横条不像。
  //
  // 单元格的上下边距给 0，横向给一点 —— 横条的高度由文字的行高定，
  // 横向留白让文字不贴着色带的边。
  bandRow(text, { fill, color, size = 12, bold = true, align = 'left', padPt = 5 } = {}) {
    const fillHex = fill ? String(fill).replace('#', '').toUpperCase() : 'FFFFFF';
    const colorHex = color ? String(color).replace('#', '').toUpperCase() : '000000';
    const rPr = [];
    if (bold) rPr.push('<w:b/>');
    rPr.push(`<w:color w:val="${esc(colorHex)}"/>`);
    if (size) rPr.push(`<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>`);
    const runs = String(text == null ? '' : text)
      .split(/\r?\n/)
      .map((line, i) => (i > 0 ? '<w:br/>' : '') + (line ? `<w:t xml:space="preserve">${esc(line)}</w:t>` : ''))
      .join('');
    const pad = Math.round(padPt * PT_TO_TWIP);
    this.body.push(
      '<w:tbl><w:tblPr>'
      + '<w:tblW w:w="5000" w:type="pct"/>'
      + '<w:tblLayout w:type="fixed"/>'
      + '<w:tblBorders>'
      + '<w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
      + '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
      + '<w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
      + '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
      + '<w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
      + '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
      + '</w:tblBorders>'
      + '<w:tblCellMar>'
      + `<w:top w:w="0" w:type="dxa"/><w:left w:w="${pad}" w:type="dxa"/>`
      + `<w:bottom w:w="0" w:type="dxa"/><w:right w:w="${pad}" w:type="dxa"/>`
      + '</w:tblCellMar>'
      + '</w:tblPr><w:tblGrid><w:gridCol w:w="9638"/></w:tblGrid>'
      + '<w:tr><w:tc><w:tcPr>'
      + `<w:shd w:val="clear" w:color="auto" w:fill="${esc(fillHex)}"/>`
      + '<w:vAlign w:val="center"/>'
      + '</w:tcPr>'
      + `<w:p><w:pPr><w:jc w:val="${align}"/>`
      + '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>'
      + '<w:ind w:left="0" w:right="0"/>'
      + '</w:pPr>'
      + `<w:r><w:rPr>${rPr.join('')}</w:rPr>${runs}</w:r></w:p>`
      + '</w:tc></w:tr></w:tbl>'
    );
    // 表格后紧跟一个空段落，否则相邻表格在 Word 里会粘在一起。
    this.body.push('<w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>');
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
  image(relId, drawW, drawH, srcW, srcH, alt = '', docPrId = 0, crop = null) {
    this.body.push(
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60"/></w:pPr>'
      + '<w:r>' + this._drawingXml(relId, drawW, drawH, alt, docPrId, crop) + '</w:r></w:p>'
    );
    return true;
  }

  // 一张「点得开」的图片：图片本身是包里的字节，外面套一个指向原图
  // 的链接。读者点一下这张图，Word 打开的是它在磁盘上的原图。
  //
  // 链接不能套在 drawing 外面一层 paragraph 上 —— 那样点在图片中间的
  // 空白处不会触发。链接要包住整个 run，图片落在链接里面，点击才算
  // 落在链接上。
  linkedImage(relId, linkRelId, drawW, drawH, alt = '', docPrId = 0, crop = null) {
    this.body.push(
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60"/></w:pPr>'
      + `<w:hyperlink r:id="${linkRelId}" w:history="1">`
      + '<w:r>' + this._drawingXml(relId, drawW, drawH, alt, docPrId, crop) + '</w:r>'
      + '</w:hyperlink>'
      + '</w:p>'
    );
    return true;
  }

  // drawing 本身的 XML。图片和链接图片共用这一段，所以两张图在 Word
  // 里是同一种东西，只是一个带链接一个不带。
  //
  // crop 是照片被裁掉的比例（0-1，四条边各一个）。编辑页里照片是裁进
  // 一个固定形状的画框的，Word 里没有「画框」，但有 a:srcRect —— 裁
  // 出照片的一块矩形，摆在同样形状的格子里，出来的就是编辑页那个样子。
  _drawingXml(relId, drawW, drawH, alt = '', docPrId = 0, crop = null) {
    const cx = Math.max(1, Math.round(drawW * PT_TO_EMU));
    const cy = Math.max(1, Math.round(drawH * PT_TO_EMU));
    // Word 用 docPr id 区分包里的图片。这个 id 必须全篇唯一，所以它
    // 取的是图片自己的编号，而不是另起一个计数器。
    const id = docPrId || (++this._imgSeq);
    const descr = esc(alt || '照片');
    // srcRect 的四个数是「切掉的比例」，单位是千分之一。切不掉的一边
    // 写 0 —— 四个 0 表示不裁。
    const srcRect = crop
      ? '<a:srcRect'
        + ` l="${Math.round(crop.l * 100000)}"`
        + ` t="${Math.round(crop.t * 100000)}"`
        + ` r="${Math.round(crop.r * 100000)}"`
        + ` b="${Math.round(crop.b * 100000)}"/>`
      : '';
    return '<w:drawing>'
      + '<wp:inline distT="0" distB="0" distL="0" distR="0">'
      + `<wp:extent cx="${cx}" cy="${cy}"/>`
      + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
      + `<wp:docPr id="${id}" name="Picture ${id}" descr="${descr}"/>`
      + '<wp:cNvGraphicFramePr>'
      + '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>'
      + '</wp:cNvGraphicFramePr>'
      + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:nvPicPr>'
      + `<pic:cNvPr id="${id}" name="Picture ${id}" descr="${descr}"/>`
      + '<pic:cNvPicPr/>'
      + '</pic:nvPicPr>'
      + '<pic:blipFill>'
      + `<a:blip r:embed="${relId}"/>`
      + srcRect
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
      + '</w:drawing>';
  }

  // ---- 表格 ----
  //
  // 用于排版。cellWidths 是各列的百分比数组。
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
        + `Target="${esc(r.target)}"`
        // 外链必须带 TargetMode="External"，否则 Word 会把它当成包内
        // 的一个部件去找，结果是打不开。
        + (r.mode ? ` TargetMode="${r.mode}"` : '')
        + '/>'
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
//
// cover 是这张照片在编辑页里的画框（形状 + 位置）。有画框时，照片被
// 裁进那个形状 —— 和编辑页一样，格子里不会出现空洞。没有画框时，照片
// 按自己的形状摆着。
function registerImage(doc, photo, maxW, maxH, cover = null) {
  const ext = imageExtFor(photo);
  if (!ext) return null;
  const fp = resolvePhoto(photo);
  let buf;
  try { buf = fs.readFileSync(fp); } catch { return null; }
  if (!buf || !buf.length) return null;
  const size = sniffImageSize(buf);
  const srcW = size && size.width ? size.width : 4;
  const srcH = size && size.height ? size.height : 3;

  // 画框的形状，以及照片被裁掉的比例。
  const frame = photoFrame(srcW, srcH, cover);
  const frameAr = frame.ratio;

  // 画框的宽度就是格子宽度，高度按画框自己的形状算 —— 照片最后被裁成
  // 画框那个形状，所以画框和照片的关系始终是等比的。
  //
  // maxH 是这一行的高度，用来兜住「比同行别的照片高」的画框：那一张
  // 按比例缩到装得下为止。
  let drawW = maxW;
  let drawH = drawW / frameAr;
  if (maxH > 0 && drawH > maxH) {
    drawH = maxH;
    drawW = drawH * frameAr;
  }

  const { relId, mediaName, docPrId } = doc.addImageRel(ext);
  // 字节直接挂在 media 记录上，打包时按顺序读，避免两张数组失步。
  doc.media[doc.media.length - 1].buf = buf;
  return {
    relId, mediaName, docPrId, buf, srcW, srcH,
    drawW, drawH, crop: frame.crop,
  };
}

// ---- 排版常量 ------------------------------------------------------------

// A4 纵向正文宽度（pt）：595.28 - 2×56.7pt(2cm) ≈ 482
const CONTENT_W = 482;
// 表格单元格左右各留的边距（twip）。照片要摆在格子里面，就得先减掉它。
const CELL_MARGIN_TWIP = 60;
const CELL_PADDING_PT = (CELL_MARGIN_TWIP * 2) / PT_TO_TWIP;

// ---- main entry -----------------------------------------------------------

// Build a Word (.docx) 回忆相册.
//
//   options: {
//     events:   MemorialEventRowWithPhotos[]
//     outPath:  string
//     progressCb: (phase, percent, note?) => void
//   }
//
// Returns: { pages, events, photos, bytes, heicSkipped }
async function buildAlbum(options) {
  const { events, outPath, progressCb = () => {} } = options || {};
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

  const theme = THEME;
  const doc = new DocxBuilder(theme);

  let photosRendered = 0;
  const onPhoto = () => {
    photosRendered += 1;
    safeProgress('encoding', 5 + 80 * Math.min(1, photosRendered / Math.max(1, totalEmbeddable(events))),
      `已嵌入 ${photosRendered} 张`);
  };

  renderAlbum(doc, events, theme, onPhoto);

  safeProgress('finalizing', 92);

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  doc.write(outPath);

  const bytes = fs.statSync(outPath).size;
  safeProgress('done', 100);
  return {
    // 封面一页，每篇回忆一页。
    pages: events.length + 1,
    events: events.length,
    notes: events.length,
    photos: photosRendered,
    bytes,
    heicSkipped,
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

// ---- 照片网格 -------------------------------------------------------------
//
// 照片网格的排布已经并进 renderGallery —— 图组按编辑页的份额排，网格
// 只是图组的一种排版，不再单独画一遍。

function heicNote(p) {
  if (p && (p._is_heic || (p.mime && /heic|heif/i.test(p.mime)))) {
    return '（HEIC 暂不支持）';
  }
  return '（照片缺失）';
}

function photoAlt(p) {
  return p.original_name || path.basename(String(p.relative_path || '照片'));
}

// ---- 正文渲染 ------------------------------------------------------------
//
// 一篇回忆一篇Word 页，版式照着回忆编辑页重排：
//
//   ┌─────────────────────────┐
//   │ 标题（标题行）            │  ← 顶端的色带
//   ├─────────────────────────┤
//   │ 文字板块 / 图片板块        │  ← 中间的内容
//   ├─────────────────────────┤
//   │ 2026-03-14（日期行）       │  ← 底端的色带
//   └─────────────────────────┘
//
// 版式不是照抄编辑页的像素，而是把编辑页的排版「翻译」成 Word 原生元素
// —— 段落、表格、图片。翻译用的对应表在 main/diary_content.js 里：一张
// 照片在图组里占多宽、一行放几张，跟编辑页用的是同一套数。

function renderAlbum(doc, events, theme, onPhoto) {
  // 封面
  renderCover(doc, { title: '回忆相册', subtitle: '', showStats: true }, theme, events);

  for (let i = 0; i < events.length; i += 1) {
    renderNotePage(doc, events[i], theme, onPhoto);
    // 一篇一篇分开，翻页时不会两篇挤在一起。
    if (i < events.length - 1) doc.pageBreak();
  }
}

// 一篇回忆。
//
// 每一篇从标题行开始，到日期行结束。中间是这篇回忆的板块：文字板块
// 是一段段正文，图片板块是照着编辑页的图组排布摆开的一组照片 —— 每张
// 照片都单独链回它在磁盘上的原图，点得开。
function renderNotePage(doc, ev, theme, onPhoto) {
  const c = theme.cssVar;
  const blocks = noteBlocks(ev);

  // 标题行
  doc.bandRow(ev.title || '(无标题)', {
    fill: c.accent, color: '#ffffff', size: 15, bold: true, align: 'left',
  });

  // 中间的内容
  let photos = 0;
  if (!blocks.length) {
    doc.para('（这篇回忆还没有内容）', { color: c.muted, size: 10, italic: true });
  }
  for (const b of blocks) {
    if (b.type === 'text') {
      const text = (b.text || '').trim();
      if (!text) continue;
      doc.para(text, { size: 11, spacingAfter: 8, spacingBefore: 0 });
      continue;
    }
    if (b.type === 'gallery') {
      photos += renderGallery(doc, b, theme, onPhoto, ev);
    }
    // 视频和音频在纸面上没有位置 —— 和 PDF 那边的处理一样，跳过。
  }
  if (!photos) {
    // 这篇回忆的照片一张都没进文档 —— 说清楚是哪一种：照片在，只是
    // Word 吃不了（HEIC），还是这篇回忆压根没有照片。
    const total = (ev.photos || []).length;
    const unembeddable = (ev.photos || []).filter((p) => !isEmbeddablePhoto(p)).length;
    if (unembeddable > 0) {
      doc.para(`（这篇回忆有 ${unembeddable} 张照片暂不支持嵌入）`, {
        color: c.muted, size: 10, italic: true,
      });
    } else if (total === 0) {
      doc.para('（这篇回忆还没有照片）', { color: c.muted, size: 10, italic: true });
    }
  }

  // 日期行
  doc.bandRow(fmtDateOnly(ev.occurred_at), {
    fill: c.muted, color: '#ffffff', size: 10, bold: true, align: 'right',
  });
}

// 一篇回忆的板块。
//
// 写在混合编辑器之前的回忆没有板块，只有 `notes` 那一段文字 —— 它按一
// 个文字板块读进来，和编辑页的读法一样。
function noteBlocks(ev) {
  const blocks = parseDiaryContent(ev.content);
  if (blocks.length) return blocks;
  const legacy = (ev.notes || '').trim();
  return legacy ? [{ type: 'text', text: legacy }] : [];
}

// 一行照片的高度。
//
// 编辑页里一行照片是齐顶的：每个画框按自己的形状长出来 —— 宽的那张矮
// 一点，窄的那张高一点 —— 一行的高度由最高的那张定，矮的那些从顶上排
// 下来，底下不齐。
//
// 所以这一行的高度取「最高」：谁都不该为了迁就同行而被压扁。
function rowHeightFor(row, widths) {
  let h = 0;
  for (let i = 0; i < row.length; i += 1) {
    const cover = row[i].cover || null;
    // 画框的形状：有自己的画框就是画框的形状。
    const ar = cover && cover.ratio ? coverRatioValue(cover.ratio) : 1;
    const cellH = widths[i] / (ar || 1);
    if (cellH > h) h = cellH;
  }
  return h || (widths[0] || 0);
}

// 一个图组。
//
// 图组在编辑页里是一行 flex：每张照片占自己那一份宽度，行放不下就换行。
// 这里用同样的数算出同样的行，再用一张无边框表格把每一行摆出来 ——
// 每张照片在自己的格子里，格子宽度就是它在图组里占的那一份。
//
// 返回放进文档的照片数。
function renderGallery(doc, block, theme, onPhoto, ev) {
  const c = theme.cssVar;
  const photoById = new Map();
  for (const p of (ev.photos || [])) photoById.set(String(p.id), p);

  const items = (block.photos || []).map((p) => ({
    spec: p,
    photo: photoById.get(String(p.photo_id)) || null,
  }));
  if (!items.length) return 0;

  // 图组的可用宽度就是正文宽度；换行按编辑页的算法算。
  const rows = galleryRows(items.map((it) => it.spec), block.layout, CONTENT_W);
  let placed = 0;

  for (const row of rows) {
    // 每一行的格子宽度：这一行里每张照片自己的份额。
    const widths = row.map((spec) => photoWidthPx(spec, block.layout, CONTENT_W));
    const rowTotal = widths.reduce((a, b) => a + b, 0);
    // 表格的列宽是百分比的，所以要把这一行的宽度换成百分比。
    const pct = widths.map((w) => (w / rowTotal) * 100);

    // 同一行里的照片一样高 —— 编辑页里它们共用一个高度（flex 行按最
    // 高的那个算），所以这一行的格子也是那个高度。
    const rowH = rowHeightFor(row, widths);

    doc.tableStart(pct);
    for (let i = 0; i < row.length; i += 1) {
      const it = items.find((x) => x.spec === row[i]);
      // 照片摆在格子里面，所以宽度要减掉格子的左右边距。
      const cellW = Math.max(1, widths[i] - CELL_PADDING_PT);
      let embedded = false;
      const xml = doc.captureCell(() => {
        const photo = it && it.photo;
        if (!photo || !isEmbeddablePhoto(photo)) {
          doc.para(heicNote(photo), { align: 'center', color: c.muted, size: 9, italic: true });
          return;
        }
        // 画框的形状来自这篇回忆里的画框设置 —— 编辑页就是照它裁的，
        // Word 这边也照它裁，两边才是同一个样子。
        const img = registerImage(doc, photo, cellW, rowH, it.spec.cover || null);
        if (!img) {
          doc.para('（图片加载失败）', { align: 'center', color: c.muted, size: 9 });
          return;
        }
        // 每张照片都单独链回原图：读者点一下这张照片，Word 打开的是它
        // 在磁盘上的那一张，而不是只能看着导出件里的这一份。
        const linkRelId = doc.addExternalRel(photoLinkTarget(photo));
        doc.linkedImage(img.relId, linkRelId, img.drawW, img.drawH,
          photoAlt(photo), img.docPrId, img.crop);
        embedded = true;
        onPhoto();
      });
      doc.tableCell(xml, { vAlign: 'top' });
      if (embedded) placed += 1;
    }
    doc.tableEnd();
  }
  return placed;
}

// 一张照片的链接目标：它在磁盘上的原图。
//
// Word 的外部链接要写成文件 URI。路径里的反斜杠要换成正斜杠，其余
// 的字符按 URI 的规矩转义。
function photoLinkTarget(photo) {
  const fp = resolvePhoto(photo);
  try {
    return require('url').pathToFileURL(fp).href;
  } catch (e) {
    return fp;
  }
}

module.exports = { buildAlbum };