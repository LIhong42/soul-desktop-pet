// main/album_pdf.js — PDF photo-book generator for memorial events.
//
// Pipeline: pdfkit's streaming PDFDocument → fs.createWriteStream(out).
//
// buildAlbum({ events, outPath, progressCb }) writes a cover page, one
// title page per event, one page per photo, and a closing index.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const PDFDocument = require('pdfkit');

// ---- Page geometry ---------------------------------------------------------

const PAGE = {
  a4Portrait:  { w: 595.28, h: 841.89 },
  a4Landscape: { w: 841.89, h: 595.28 },
};

// ---- Font resolution ------------------------------------------------------

function pickCjkFontPath() {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push('C:\\Windows\\Fonts\\simhei.ttf');
    candidates.push('C:\\Windows\\Fonts\\simfang.ttf');
    candidates.push('C:\\Windows\\Fonts\\STKAITI.TTF');
    candidates.push('C:\\Windows\\Fonts\\NotoSansSC-VF.ttf');
    candidates.push('C:\\Windows\\Fonts\\msyh.ttc');
  } else if (process.platform === 'darwin') {
    candidates.push('/System/Library/Fonts/PingFang.ttc');
    candidates.push('/System/Library/Fonts/STHeiti Medium.ttc');
    candidates.push('/Library/Fonts/Songti.ttc');
  } else {
    candidates.push('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc');
    candidates.push('/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc');
    candidates.push('/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc');
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function fmtDateOnly(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function shortText(s, max = 200) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---- photo resolution -----------------------------------------------------

const photoRoot = () => path.join(app.getPath('appData'), 'SoulDesktopPet', 'photos');

function resolvePhoto(p) {
  // The PDF IPC layer pre-fills p.full_path. Defensive recompute in case
  // it doesn't have it.
  if (p.full_path) return p.full_path;
  const ext = path.extname(String(p.relative_path || '')).toLowerCase();
  return path.join(photoRoot(), p._event_id || p.eventId || '', path.basename(p.relative_path || ''));
}

// Is this row a picture? A movie and a sound live in the same table as
// the pictures, and pdfkit can only open an image — a video row would
// throw inside openImage(). The mime column is the authority; the
// extension is the fallback for a row that never had one.
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);

function isPicture(p) {
  if (!p) return false;
  if (p.mime) return String(p.mime).toLowerCase().startsWith('image/');
  return IMAGE_EXT.has(path.extname(String(p.relative_path || '')).toLowerCase());
}

function isEmbeddablePhoto(p) {
  if (!p) return false;
  if (!isPicture(p)) return false;
  if (p._is_heic || p._is_heif) return false;
  if (p.mime && /heic|heif/i.test(p.mime)) return false;
  const fp = resolvePhoto(p);
  try { return fs.existsSync(fp); } catch { return false; }
}

// ---- main entry -----------------------------------------------------------

// Build a PDF photo book.
//
//   options: {
//     events:   MemorialEventRowWithPhotos[]
//     outPath:  string
//     progressCb: (phase, percent, note?) => void
//   }
//
// Returns: { pages, events, photos, bytes, font, heicSkipped }
async function buildAlbum(options) {
  const { events, outPath, progressCb = () => {} } = options || {};
  if (!Array.isArray(events)) throw new Error('buildAlbum: events required');
  if (!outPath) throw new Error('buildAlbum: outPath required');

  const safeProgress = (phase, percent, note) => {
    try { progressCb(phase, Math.max(0, Math.min(100, percent)), note); } catch {}
  };
  safeProgress('preparing', 0);

  // Resolve photo paths upfront so the encoding loop is cheap.
  let heicSkipped = 0;
  for (const ev of events) {
    ev.photos = Array.isArray(ev.photos) ? ev.photos : [];
    ev.photos.forEach((p) => {
      const ext = path.extname(String(p.relative_path || '')).toLowerCase();
      p._is_heic = ext === '.heic' || ext === '.heif';
      if (p.mime && /heic|heif/i.test(p.mime)) p._is_heic = true;
      if (p._is_heic) heicSkipped += 1;
      // Stamp event id BEFORE resolving full_path so resolvePhoto() can
      // place the file under the correct event folder.
      p._event_id = ev.id;
      p.full_path = resolvePhoto(p);
    });
    ev.photos.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  }

  // Set up the document.
  const doc = new PDFDocument({
    autoFirstPage: false,
    info: {
      Title: 'SoulDesktopPet 回忆相册',
      Author: 'SoulDesktopPet',
      Producer: 'SoulDesktopPet / pdfkit',
      CreationDate: new Date(),
    },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  let fontState = 'fallback';
  const cjkFont = pickCjkFontPath();
  if (cjkFont) {
    try {
      doc.registerFont('CJK', cjkFont);
      doc.font('CJK');
      fontState = 'cjk';
    } catch (e) {
      console.error('[album_pdf] registerFont failed:', e);
      fontState = 'fallback';
    }
  }
  if (fontState === 'fallback') doc.font('Helvetica');

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const fileStream = fs.createWriteStream(outPath);
  doc.pipe(fileStream);

  let pages = 0;
  let photosRendered = 0;
  const totalEvents = events.length;

  // Cover + per-event title page + 1 photo per page
  const r = await renderAlbum({
    doc, events, totalEvents, onPage: () => { pages += 1; },
    onPhoto: () => { photosRendered += 1; safeProgress('encoding', 5 + 80 * Math.min(1, photosRendered / Math.max(1, countAllEmbeddable(events))), `已嵌入 ${photosRendered} 张`); },
  });
  heicSkipped = r.heicSkipped;

  safeProgress('finalizing', 90);
  doc.end();

  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  const bytes = fs.statSync(outPath).size;
  safeProgress('done', 100);
  return {
    pages,
    events: events.length,
    photos: photosRendered,
    bytes,
    font: fontState,
    heicSkipped,
  };
}

function countAllEmbeddable(events) {
  let n = 0;
  for (const ev of events) {
    for (const p of (ev.photos || [])) {
      if (isEmbeddablePhoto(p)) n += 1;
    }
  }
  return n;
}

// ---- Page rendering ---------------------------------------------------------

async function renderAlbum({ doc, events, totalEvents, onPage, onPhoto }) {
  const BRAND = '#f4a8a0';
  const BRAND_DARK = '#d97757';
  const TEXT = '#2a2a2a';
  const MUTED = '#8a8478';
  const BG_BEIGE = '#f8f7f3';

  let heicSkipped = 0;
  // ---- Cover page ----
  doc.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
  onPage();
  doc.rect(0, 0, PAGE.a4Portrait.w, 24).fill(BRAND);
  doc.rect(0, PAGE.a4Portrait.h - 24, PAGE.a4Portrait.w, 24).fill(BRAND);
  doc.fillColor(TEXT).fontSize(40)
     .text('回忆相册', 0, PAGE.a4Portrait.h * 0.30, {
       width: PAGE.a4Portrait.w, align: 'center',
     });
  let totalPhotos = 0;
  for (const ev of events) for (const p of (ev.photos || [])) {
    if (isEmbeddablePhoto(p)) totalPhotos += 1;
    else if (p._is_heic) heicSkipped += 1;
  }
  doc.moveDown(1.5).fontSize(14).fillColor(MUTED)
     .text(`${totalEvents} 个事件 · ${totalPhotos} 张照片`,
       { width: PAGE.a4Portrait.w, align: 'center' });
  if (events.length) {
    const earliest = fmtDateOnly(events[0].occurred_at);
    const latest = fmtDateOnly(events[events.length - 1].occurred_at);
    doc.moveDown(0.5).text(`时间跨度：${earliest} → ${latest}`,
      { width: PAGE.a4Portrait.w, align: 'center' });
  }
  doc.moveDown(0.5).text(`生成于 ${fmtDateOnly(new Date().toISOString())}`,
    { width: PAGE.a4Portrait.w, align: 'center' });

  // ---- Per event ----
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    const embeddable = (ev.photos || []).filter((p) => isEmbeddablePhoto(p));
    const evTitle = ev.title || '(无标题)';
    const evDate = fmtDateOnly(ev.occurred_at);
    const evContacts = Array.isArray(ev.contact_names) && ev.contact_names.length
      ? ev.contact_names.join('、') : '独立事件';

    // Title card
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
    onPage();
    const w = PAGE.a4Landscape.w, h = PAGE.a4Landscape.h;
    doc.rect(0, 0, w, h).fill(BG_BEIGE);
    doc.rect(0, 0, 12, h).fill(BRAND);
    doc.fillColor(TEXT).fontSize(32)
       .text(evTitle, 48, 80, { width: w - 96, align: 'center' });
    doc.moveDown(0.5).fontSize(14).fillColor(MUTED)
       .text(`${evDate}  ·  ${evContacts}`, 48, doc.y, { width: w - 96, align: 'center' });
    const detailLines = [
      ['地点', ev.place], ['食物', ev.food], ['穿搭', ev.outfit],
      ['活动', ev.activities], ['笔记', ev.notes],
    ].filter(([_, v]) => v && String(v).trim());
    if (detailLines.length) {
      doc.moveDown(1.2);
      let cursorY = doc.y;
      for (const [k, v] of detailLines) {
        doc.fillColor(BRAND_DARK).fontSize(11).text(k, 100, cursorY, { width: 60 });
        doc.fillColor(TEXT).fontSize(11).text(shortText(v, 120), 170, cursorY,
          { width: w - 220 });
        cursorY = doc.y + 6;
      }
    }
    doc.moveTo(48, h - 48).lineTo(w - 48, h - 48).strokeColor(BRAND).lineWidth(1).stroke();
    doc.fontSize(9).fillColor(MUTED)
       .text(`第 ${i + 1} / ${totalEvents} 个事件 · 共 ${ev.photos.length} 张照片（${embeddable.length} 张可嵌入）`,
         48, h - 40, { width: w - 96, align: 'center' });

    // Per-photo pages
    for (let j = 0; j < ev.photos.length; j += 1) {
      const p = ev.photos[j];
      if (!isEmbeddablePhoto(p)) continue;
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
      onPage();
      const pw = PAGE.a4Landscape.w, ph = PAGE.a4Landscape.h;
      doc.rect(0, 0, pw, ph).fill(BG_BEIGE);
      try {
        doc.image(p.full_path, 40, 30, {
          fit: [pw - 80, ph - 90], align: 'center', valign: 'center',
        });
      } catch (e) {
        doc.fillColor(MUTED).fontSize(12)
           .text('（图片加载失败）', 40, ph / 2 - 12, { width: pw - 80, align: 'center' });
      }
      const caption = `${p.original_name || path.basename(p.full_path)}  ·  第 ${j + 1} / ${ev.photos.length} 张  ·  来自《${evTitle}》`;
      doc.fontSize(9).fillColor(MUTED)
         .text(shortText(caption, 200), 40, ph - 32, { width: pw - 80, align: 'center' });
      onPhoto();
    }
  }

  // ---- Index ----
  doc.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
  onPage();
  doc.rect(0, 0, PAGE.a4Portrait.w, 18).fill(BRAND);
  doc.fillColor(TEXT).fontSize(22)
     .text('目录', 0, 60, { width: PAGE.a4Portrait.w, align: 'center' });
  doc.moveDown(1.5);
  doc.fontSize(11);
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    const idx = `${String(i + 1).padStart(2, '0')}.`;
    const title = ev.title || '(无标题)';
    const date = fmtDateOnly(ev.occurred_at);
    const contacts = Array.isArray(ev.contact_names) && ev.contact_names.length
      ? ev.contact_names.join('、') : '独立事件';
    const line = `${idx}  ${title}  —  ${date}  ·  ${contacts}  ·  ${ev.photos.length} 张照片`;
    doc.fillColor(TEXT).text(shortText(line, 80), { width: PAGE.a4Portrait.w - 72, align: 'left' });
    doc.moveDown(0.3);
  }
  doc.moveDown(2);
  doc.fontSize(10).fillColor(MUTED)
     .text(`由 SoulDesktopPet 制作于 ${fmtDateOnly(new Date().toISOString())}`,
       0, PAGE.a4Portrait.h - 80, { width: PAGE.a4Portrait.w, align: 'center' });
  doc.text(`共 ${totalEvents} 个事件 / ${totalPhotos} 张照片`,
    0, PAGE.a4Portrait.h - 60, { width: PAGE.a4Portrait.w, align: 'center' });

  return { heicSkipped };
}

module.exports = { buildAlbum };
