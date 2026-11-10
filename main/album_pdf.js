// main/album_pdf.js — PDF photo-book generator for memorial events.
//
// Pipeline: pdfkit's streaming PDFDocument → fs.createWriteStream(out).
//
// Two operating modes:
//   1. LAYOUT MODE (new): buildAlbum({ events, layout, outPath, progressCb })
//      where layout is an AlbumLayout (themeId + pages with slot content).
//      Renders the user-edited design. Themes vary by color palette + font
//      size + weight; per-slot pan/zoom is honored via pdfkit
//      save → rect().clip() → image() → restore.
//
//   2. LEGACY MODE: buildAlbum({ events, outPath, progressCb }) without
//      a layout. Falls back to the original 1-photo-per-page behavior for
//      backward compatibility with the simple "导出相册 (PDF)" button.
//
// Slot coordinates are 0..100 normalized (page-relative) — same units the
// renderer uses. The PDF renderer multiplies by page-dimensions-in-pt.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const PDFDocument = require('pdfkit');

// ---- Theme + layout (must mirror src/js/album_layouts.js) -----------------
//
// We re-declare the same data the renderer uses, in CommonJS form, so the
// main process doesn't depend on the renderer's ES module loader. The two
// are kept in lockstep by hand. If you change album_layouts.js, change here
// too.

const PAGE = {
  a4Portrait:  { w: 595.28, h: 841.89 },
  a4Landscape: { w: 841.89, h: 595.28 },
};

const THEMES = {
  classic: {
    id: 'classic', name: '经典', coverLayout: 'centered',
    cssVar: { bg:'#ffffff', surface:'#f8f7f3', text:'#2a2a2a', muted:'#8a8478',
              accent:'#f4a8a0', accentDark:'#d97757', ribbon:'#f4a8a0' },
    size:  { title: 28, body: 12, caption: 11 },
    weight:{ title: 'bold', body: 'normal', caption: 'normal' },
    pageShape: 'landscape', lineGap: 2, showRibbon: false, cornerRadius: 0,
  },
  film: {
    id: 'film', name: '胶片', coverLayout: 'corner-ribbon',
    cssVar: { bg:'#f5efe2', surface:'#ece4d0', text:'#3a2e1f', muted:'#8a7a5e',
              accent:'#c9a574', accentDark:'#8a6a3a', ribbon:'#c9a574' },
    size:  { title: 26, body: 12, caption: 10 },
    weight:{ title: 'bold', body: 'normal', caption: 'normal' },
    pageShape: 'landscape', lineGap: 3, showRibbon: true, cornerRadius: 0,
  },
  magazine: {
    id: 'magazine', name: '杂志', coverLayout: 'split',
    cssVar: { bg:'#ffffff', surface:'#f3f3f3', text:'#111111', muted:'#666666',
              accent:'#1a1a1a', accentDark:'#000000', ribbon:'#1a1a1a' },
    size:  { title: 40, body: 12, caption: 11 },
    weight:{ title: 'bold', body: 'normal', caption: 'normal' },
    pageShape: 'landscape', lineGap: 1, showRibbon: false, cornerRadius: 0,
  },
  warm: {
    id: 'warm', name: '暖阳', coverLayout: 'centered',
    cssVar: { bg:'#fff4e6', surface:'#ffe8d1', text:'#5a3a1a', muted:'#b08868',
              accent:'#d97757', accentDark:'#a85530', ribbon:'#d97757' },
    size:  { title: 30, body: 13, caption: 11 },
    weight:{ title: 'bold', body: 'normal', caption: 'italic' },
    pageShape: 'landscape', lineGap: 3, showRibbon: false, cornerRadius: 8,
  },
  dark: {
    id: 'dark', name: '暗夜', coverLayout: 'centered',
    cssVar: { bg:'#1a1a1a', surface:'#262626', text:'#f0e6dd', muted:'#9a8f80',
              accent:'#e8b89a', accentDark:'#c89070', ribbon:'#e8b89a' },
    size:  { title: 28, body: 12, caption: 11 },
    weight:{ title: 'bold', body: 'normal', caption: 'normal' },
    pageShape: 'landscape', lineGap: 2, showRibbon: true, cornerRadius: 0,
  },
};

// Each template's slots: [x, y, w, h, type] in 0..100
const LAYOUT_TEMPLATES = {
  'single-full': {
    name: '满版单图', orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 100, h: 78, padding: 0 },
      { type: 'caption', x: 0,  y: 78, w: 100, h: 22, padding: 4 },
    ],
  },
  'big-top-text-bottom': {
    name: '大图+底注', orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 4,  y: 4,  w: 92, h: 72, padding: 0 },
      { type: 'title',   x: 4,  y: 76, w: 92, h: 8,  padding: 1 },
      { type: 'caption', x: 4,  y: 84, w: 92, h: 12, padding: 1 },
    ],
  },
  'split-h-text-bottom': {
    name: '左右分栏+底注', orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 50, h: 80, padding: 0 },
      { type: 'photo',   x: 50, y: 0,  w: 50, h: 80, padding: 0 },
      { type: 'caption', x: 0,  y: 80, w: 100,h: 20, padding: 4 },
    ],
  },
  'three-grid-text': {
    name: '三宫格+底注', orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 50, h: 40, padding: 0 },
      { type: 'photo',   x: 50, y: 0,  w: 50, h: 40, padding: 0 },
      { type: 'photo',   x: 0,  y: 40, w: 100,h: 40, padding: 0 },
      { type: 'caption', x: 0,  y: 80, w: 100,h: 20, padding: 4 },
    ],
  },
  'one-photo-side-cap': {
    name: '侧图侧文', orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 60, h: 100, padding: 0 },
      { type: 'title',   x: 62, y: 6,  w: 34, h: 14,  padding: 2 },
      { type: 'caption', x: 62, y: 22, w: 34, h: 72,  padding: 2 },
    ],
  },
};

function getTheme(id) {
  return THEMES[id] || THEMES.classic;
}
function getTemplate(id) {
  return LAYOUT_TEMPLATES[id] || LAYOUT_TEMPLATES['single-full'];
}

function getPageDims(pageShape) {
  if (pageShape === 'portrait') return PAGE.a4Portrait;
  return PAGE.a4Landscape;
}

// Same math as src/js/album_layouts.js slotRect.
function slotRect(slot, pw, ph) {
  const pad = slot.padding || 0;
  return {
    x: (slot.x / 100) * pw + (pad / 100) * pw,
    y: (slot.y / 100) * ph + (pad / 100) * ph,
    w: (slot.w / 100) * pw - 2 * (pad / 100) * pw,
    h: (slot.h / 100) * ph - 2 * (pad / 100) * ph,
  };
}

// Pan/zoom math — mirrors src/js/album_layouts.js computePhotoDrawRect.
function computePhotoDrawRect(slotRectPx, srcW, srcH, transform) {
  const tx = transform && transform.x != null ? transform.x : 50;
  const ty = transform && transform.y != null ? transform.y : 50;
  const zoom = transform && transform.zoom != null ? transform.zoom : 1;
  const safeZoom = Math.max(0.1, Math.min(4, zoom));
  const baseScale = Math.max(slotRectPx.w / srcW, slotRectPx.h / srcH);
  const scale = baseScale * safeZoom;
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const cx = slotRectPx.x + (slotRectPx.w - drawW) / 2;
  const cy = slotRectPx.y + (slotRectPx.h - drawH) / 2;
  const offX = cx + (tx - 50) / 100 * slotRectPx.w;
  const offY = cy + (ty - 50) / 100 * slotRectPx.h;
  return { x: offX, y: offY, width: drawW, height: drawH };
}

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
  // the renderer-built layout doesn't have it.
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

// ---- photo index by id ----------------------------------------------------
//
// Build a lookup Map<photoId, photo> from the events array so the renderer
// can reference photos by id only (no full_path needed in the layout JSON).

function indexPhotos(events) {
  const m = new Map();
  for (const ev of events) {
    for (const p of (ev.photos || [])) {
      m.set(p.id, p);
    }
  }
  return m;
}

// ---- main entry -----------------------------------------------------------

// Build a PDF photo book.
//
//   options: {
//     events:   MemorialEventRowWithPhotos[]
//     layout?:  AlbumLayout (themeId + pages[])  -- if missing, legacy mode
//     outPath:  string
//     progressCb: (phase, percent, note?) => void
//   }
//
// Returns: { pages, events, photos, bytes, font, heicSkipped, mode }
async function buildAlbum(options) {
  const { events, layout, outPath, progressCb = () => {} } = options || {};
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
  const photoIndex = indexPhotos(events);

  // Set up the document.
  const doc = new PDFDocument({
    autoFirstPage: false,
    info: {
      Title: layout ? `SoulDesktopPet 回忆相册` : 'SoulDesktopPet 回忆相册',
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
  const mode = layout ? 'layout' : 'legacy';

  // ---- Choose mode ----
  if (layout) {
    const r = await renderLayoutMode({
      doc, layout, events, photoIndex, heicSkipped,
      onPage: () => { pages += 1; },
      onPhoto: () => { photosRendered += 1; safeProgress('encoding', countProgress(photosRendered, layout), `已嵌入 ${photosRendered} 张`); },
      safeProgress,
    });
    heicSkipped = r.heicSkipped;
  } else {
    // Legacy mode: cover + per-event title page + 1 photo per page
    const r = await renderLegacyMode({
      doc, events, totalEvents, onPage: () => { pages += 1; },
      onPhoto: () => { photosRendered += 1; safeProgress('encoding', 5 + 80 * Math.min(1, photosRendered / Math.max(1, countAllEmbeddable(events))), `已嵌入 ${photosRendered} 张`); },
    });
    heicSkipped = r.heicSkipped;
  }

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
    mode,
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

function countProgress(n, layout) {
  // We don't know the exact photo count without walking the layout; use a
  // rough count of photo slots that carry a photoId.
  let total = 0;
  for (const p of (layout && layout.pages) || []) {
    for (const s of (p.slots || [])) {
      if (s.type === 'photo' && s.photoId) total += 1;
    }
  }
  if (total === 0) return 95;
  return 5 + 80 * Math.min(1, n / total);
}

// ---- LAYOUT MODE -----------------------------------------------------------

async function renderLayoutMode({ doc, layout, events, photoIndex, heicSkipped, onPage, onPhoto, safeProgress }) {
  const theme = getTheme(layout.themeId);
  const cover = layout.cover || { title: '回忆相册', subtitle: '', showStats: true };
  const pageDims = getPageDims(theme.pageShape);

  // ---- Cover page ----
  renderCover(doc, cover, theme, events, pageDims);
  onPage();

  const totalPages = (layout.pages || []).length;
  for (let i = 0; i < totalPages; i += 1) {
    const page = layout.pages[i];
    const template = getTemplate(page.templateId);
    // Add a fresh page; landscape by default (theme.pageShape)
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
    onPage();
    // Background
    doc.rect(0, 0, pageDims.w, pageDims.h).fill(theme.cssVar.bg);
    // Ribbon (theme-driven)
    if (theme.showRibbon) {
      doc.rect(0, 0, 8, pageDims.h).fill(theme.cssVar.ribbon);
    }
    // Walk slots in template order
    for (let sIdx = 0; sIdx < template.slots.length; sIdx += 1) {
      const tSlot = template.slots[sIdx];
      // Find the matching content slot from the page (the renderer may have
      // produced them in a different order, so match by stored _slotTemplate
      // coords when present, else by index into same-typed slots).
      const content = findContentForTemplateSlot(page, tSlot, sIdx);
      const r = slotRect(tSlot, pageDims.w, pageDims.h);
      if (tSlot.type === 'photo') {
        if (content && content.photoId && photoIndex.has(content.photoId)) {
          const photo = photoIndex.get(content.photoId);
          if (isEmbeddablePhoto(photo)) {
            renderPhotoSlot(doc, photo, r, content.transform || { x: 50, y: 50, zoom: 1 });
            onPhoto();
          } else {
            // Photo exists but can't be embedded (HEIC or missing file).
            // Render a placeholder so the page still has a recognizable
            // photo area instead of going blank.
            renderPhotoPlaceholder(doc, r, theme, photo);
          }
        } else {
          // Empty photo slot — render a dashed border to show the place
          doc.save();
          doc.lineWidth(0.5).strokeColor(theme.cssVar.muted).dash(2, { space: 2 });
          doc.rect(r.x, r.y, r.w, r.h).stroke();
          doc.undash();
          doc.restore();
          doc.fillColor(theme.cssVar.muted).fontSize(theme.size.caption)
             .text('(空)', r.x, r.y + r.h / 2 - 6, { width: r.w, align: 'center' });
        }
      } else {
        const text = (content && content.text) || '';
        const textOffset = (content && content.textOffset) || { x: 0, y: 0 };
        const fontScale = (content && typeof content.fontScale === 'number') ? content.fontScale : 1;
        const textAlign = (content && content.textAlign) || (tSlot.type === 'title' ? 'center' : 'left');
        if (text) renderTextSlot(doc, text, r, theme, tSlot.type, textOffset, fontScale, textAlign, {
          color: content.color,
          bold: content.bold === true,
          italic: content.italic === true,
        });
      }
    }
    // ---- Free-form text boxes (PPT-style floating frames). Drawn after
    // every template slot so they sit on top of photos AND on top of
    // template text. Stored in pt units — same as the editor.
    const fts = Array.isArray(page.freeTexts) ? page.freeTexts : [];
    for (let f = 0; f < fts.length; f += 1) {
      renderFreeTextBox(doc, fts[f], pageDims);
    }
    // Page footer (small caption)
    doc.fontSize(8).fillColor(theme.cssVar.muted)
       .text(`第 ${i + 1} / ${totalPages} 页`, 0, pageDims.h - 16, {
         width: pageDims.w, align: 'center',
       });
  }

  return { heicSkipped };
}

function findContentForTemplateSlot(page, tSlot, idx) {
  // Preferred: match by stored coords (renderer sets _slotTemplate)
  if (page && page.slots) {
    for (const s of page.slots) {
      if (s._slotTemplate
          && s._slotTemplate.x === tSlot.x
          && s._slotTemplate.y === tSlot.y
          && s._slotTemplate.w === tSlot.w
          && s._slotTemplate.h === tSlot.h) {
        return s;
      }
    }
    // Fallback: pick the first slot of this type that we haven't used yet
    // (best-effort for layouts that didn't carry _slotTemplate).
    return page.slots.find((s) => s.type === tSlot.type) || null;
  }
  return null;
}

function renderCover(doc, cover, theme, events, pageDims) {
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
  doc.rect(0, 0, pageDims.w, pageDims.h).fill(theme.cssVar.bg);
  if (theme.showRibbon) {
    doc.rect(0, 0, 8, pageDims.h).fill(theme.cssVar.ribbon);
  }
  const totalEvents = events.length;
  let totalPhotos = 0;
  for (const ev of events) {
    for (const p of (ev.photos || [])) {
      if (isEmbeddablePhoto(p)) totalPhotos += 1;
    }
  }
  const title = cover.title || '回忆相册';
  const subtitle = cover.subtitle || '';
  const layout = theme.coverLayout;
  const cx = pageDims.w / 2;
  if (layout === 'split') {
    // Magazine split: title on left, accent block on right
    doc.rect(pageDims.w / 2, 0, pageDims.w / 2, pageDims.h).fill(theme.cssVar.accent);
    doc.fillColor(theme.cssVar.text).fontSize(theme.size.title)
       .text(shortText(title, 30), 0, pageDims.h * 0.40, { width: pageDims.w / 2, align: 'center' });
    doc.fontSize(theme.size.body).fillColor(theme.cssVar.muted)
       .text(shortText(subtitle, 40), 0, pageDims.h * 0.40 + 40, { width: pageDims.w / 2, align: 'center' });
    if (cover.showStats && totalEvents > 0) {
      doc.fontSize(theme.size.body)
         .text(`${totalEvents} 个事件 · ${totalPhotos} 张照片`,
           0, pageDims.h * 0.40 + 64, { width: pageDims.w / 2, align: 'center' });
    }
  } else if (layout === 'corner-ribbon') {
    // Ribbon + centered title
    doc.fillColor(theme.cssVar.text).fontSize(theme.size.title)
       .text(shortText(title, 30), 0, pageDims.h * 0.32, { width: pageDims.w, align: 'center' });
    if (subtitle) {
      doc.fontSize(theme.size.body).fillColor(theme.cssVar.muted)
         .text(shortText(subtitle, 50), 0, pageDims.h * 0.32 + 36, { width: pageDims.w, align: 'center' });
    }
    if (cover.showStats && totalEvents > 0) {
      doc.fontSize(theme.size.body)
         .text(`${totalEvents} 个事件 · ${totalPhotos} 张照片`,
           0, pageDims.h * 0.32 + 60, { width: pageDims.w, align: 'center' });
    }
  } else {
    // Centered (default)
    doc.fillColor(theme.cssVar.text).fontSize(theme.size.title)
       .text(shortText(title, 30), 0, pageDims.h * 0.36, { width: pageDims.w, align: 'center' });
    if (subtitle) {
      doc.fontSize(theme.size.body).fillColor(theme.cssVar.muted)
         .text(shortText(subtitle, 50), 0, pageDims.h * 0.36 + 40, { width: pageDims.w, align: 'center' });
    }
    if (cover.showStats && totalEvents > 0) {
      doc.fontSize(theme.size.body)
         .text(`${totalEvents} 个事件 · ${totalPhotos} 张照片`,
           0, pageDims.h * 0.36 + 64, { width: pageDims.w, align: 'center' });
    }
  }
  doc.fontSize(8).fillColor(theme.cssVar.muted)
     .text(`生成于 ${fmtDateOnly(new Date().toISOString())}`,
       0, pageDims.h - 24, { width: pageDims.w, align: 'center' });
}

// ---- Photo slot rendering with pan/zoom -----------------------------------

function renderPhotoSlot(doc, photo, slotRectPx, transform) {
  // Open the image to read natural dimensions and respect EXIF orientation.
  // pdfkit's image() handles orientation internally if we feed it the file
  // path, but we need the post-orientation width/height for our pan/zoom
  // math. openImage does that and is idempotent.
  let img;
  try {
    img = doc.openImage(photo.full_path);
  } catch (e) {
    console.error('[album_pdf] openImage failed:', photo.full_path, e);
    doc.fillColor('#999').fontSize(10)
       .text('（图片加载失败）', slotRectPx.x, slotRectPx.y + slotRectPx.h / 2 - 6,
         { width: slotRectPx.w, align: 'center' });
    return;
  }
  const srcW = img.width;
  const srcH = img.height;
  const dRect = computePhotoDrawRect(slotRectPx, srcW, srcH, transform);
  // Cover-style baseline ensures zoom=1 fills the slot. Edge cases: if
  // srcW or srcH is 0 (corrupt), fall back to slot rect directly.
  if (!srcW || !srcH) {
    try {
      doc.image(photo.full_path, slotRectPx.x, slotRectPx.y, {
        width: slotRectPx.w, height: slotRectPx.h, cover: [slotRectPx.w, slotRectPx.h],
      });
    } catch {}
    return;
  }
  doc.save();
  // Clip to the slot viewport
  doc.rect(slotRectPx.x, slotRectPx.y, slotRectPx.w, slotRectPx.h).clip();
  try {
    doc.image(photo.full_path, dRect.x, dRect.y, {
      width: dRect.width, height: dRect.height,
    });
  } catch (e) {
    console.error('[album_pdf] image() failed:', photo.full_path, e && e.message);
  }
  doc.restore();
}

function renderPhotoPlaceholder(doc, r, theme, photo) {
  // Dashed border + small note explaining why this slot is empty
  doc.save();
  doc.lineWidth(0.5).strokeColor(theme.cssVar.muted).dash(2, { space: 2 });
  doc.rect(r.x, r.y, r.w, r.h).stroke();
  doc.undash();
  doc.restore();
  let note = '（照片缺失）';
  if (photo && (photo._is_heic || (photo.mime && /heic|heif/i.test(photo.mime)))) {
    note = '（HEIC 格式暂不支持嵌入）';
  }
  doc.fillColor(theme.cssVar.muted).fontSize(theme.size.caption)
     .text(note, r.x, r.y + r.h / 2 - 6, { width: r.w, align: 'center' });
}

function renderTextSlot(doc, text, r, theme, slotType, textOffset, fontScale, textAlign, opts) {
  // Backwards compatible: callers that don't pass opts get the original
  // (size + color + weight by slot type, no per-slot color/bold/italic).
  const o = opts || {};
  // Pick size + weight by slot type
  let size, weight, color;
  if (slotType === 'title') {
    size = theme.size.title;
    weight = theme.weight.title;
    color = theme.cssVar.text;
  } else {
    size = theme.size.caption;
    weight = theme.weight.caption;
    color = theme.cssVar.text;
  }
  // Per-slot font scale (user-controlled via the inspector slider).
  // Defaults to 1.0 so existing layouts render unchanged.
  const scale = (typeof fontScale === 'number' && fontScale > 0) ? fontScale : 1;
  // Per-slot overrides: color > theme, bold === true ? bold : theme, italic
  const useColor = (typeof o.color === 'string' && o.color) ? o.color : color;
  const useBold  = (o.bold === true) ? true : (weight === 'bold');
  const useItalic = (o.italic === true);
  doc.fillColor(useColor);
  doc.fontSize(size * scale);
  // pickFont picks a registered family based on text content (CJK vs
  // Latin). CJK bold is a known limitation — no variant registered.
  const family = pickFont(doc, text, useBold ? 'bold' : 'normal', useItalic);
  try { doc.font(family); } catch (e) { /* fall through to whatever font was current */ }
  const align = textAlign || (slotType === 'title' ? 'center' : 'left');
  // Apply user-controlled text offset (in pt) on top of the slot rect.
  // textOffset.x/y are signed values, typically in the range -r.w .. r.w
  // and -r.h .. r.h.
  const offX = (textOffset && textOffset.x) || 0;
  const offY = (textOffset && textOffset.y) || 0;
  // pdfkit's text() will wrap by default; we constrain via width.
  doc.text(shortText(text, 400), r.x + offX, r.y + offY, {
    width: r.w,
    height: r.h,
    align,
    lineGap: theme.lineGap,
    ellipsis: true,
  });
}

// ---- Free-form text box (PPT-style floating frame) -----------------------
//
// Coordinates are in pt; matches the editor (px = pt * scale) 1:1. We
// always save/restore the graphics state so any local font / color /
// lineWidth change is contained.
//
// CJK bold note: pdfkit cannot swap CJK font variants at runtime
// (we register one CJK family in buildAlbum). When the user enables
// bold on a CJK-containing text, we still set the size with a small
// visual boost and accept that the typeface stays regular. This is a
// known limitation; see pickFont() below.

function isCjkChar(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  // CJK Unified Ideographs + extensions + Hiragana/Katakana + Hangul
  return (c >= 0x4E00 && c <= 0x9FFF)
      || (c >= 0x3400 && c <= 0x4DBF)
      || (c >= 0x3040 && c <= 0x30FF)
      || (c >= 0xAC00 && c <= 0xD7AF)
      || (c >= 0x3000 && c <= 0x303F)
      || (c >= 0xFF00 && c <= 0xFFEF);
}

function textHasCjk(s) {
  if (!s) return false;
  for (let i = 0; i < s.length; i += 1) {
    if (isCjkChar(s[i])) return true;
  }
  return false;
}

// Pick the best font for the given text. Returns a pdfkit-registered
// family name. If the registered families include a CJK family and
// the text contains CJK, we use the CJK family (bold/italic are
// best-effort — pdfkit has no CJK bold variant).
function pickFont(doc, text, weight = 'normal', italic = false) {
  const cjkAvailable = doc._fontFamilies && doc._fontFamilies.CJK;
  if (cjkAvailable && textHasCjk(text)) {
    return 'CJK';
  }
  if (weight === 'bold' && italic) return 'Helvetica-BoldOblique';
  if (weight === 'bold') return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function renderFreeTextBox(doc, ft, pageDims) {
  if (!ft || !ft.text) return;
  // Clamp geometry defensively; the editor should keep things in range
  // but we don't trust user-saved JSON.
  const x = Math.max(0, Number(ft.x) || 0);
  const y = Math.max(0, Number(ft.y) || 0);
  const w = Math.max(20, Number(ft.w) || 200);
  const h = Math.max(20, Number(ft.h) || 60);
  const pad = Math.max(0, Math.min(20, Number(ft.padding) || 0));
  const fontSize = Math.max(6, Math.min(96, Number(ft.fontSize) || 12));
  doc.save();

  // Background fill (optional)
  if (ft.backgroundColor) {
    try {
      doc.fillColor(ft.backgroundColor).rect(x, y, w, h).fill();
    } catch (e) { /* ignore bad color */ }
  }

  // Border (optional, only when both color and width > 0)
  if (ft.borderColor && Number(ft.borderWidth) > 0) {
    try {
      doc.lineWidth(Number(ft.borderWidth))
         .strokeColor(ft.borderColor)
         .rect(x, y, w, h)
         .stroke();
    } catch (e) { /* ignore */ }
  }

  // Text
  const family = pickFont(doc, ft.text, ft.fontWeight, ft.fontStyle);
  try { doc.font(family); } catch (e) { doc.font('Helvetica'); }
  const textColor = ft.color || '#2a2a2a';
  try { doc.fillColor(textColor); } catch (e) { doc.fillColor('#2a2a2a'); }
  doc.fontSize(fontSize);
  // text() wraps by width; ellipsis truncates overflow
  doc.text(String(ft.text), x + pad, y + pad, {
    width:  w - 2 * pad,
    height: h - 2 * pad,
    align:  ft.textAlign || 'left',
    lineGap: 1,
    ellipsis: true,
  });
  doc.restore();
}

// ---- LEGACY MODE -----------------------------------------------------------

async function renderLegacyMode({ doc, events, totalEvents, onPage, onPhoto }) {
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
