// main/album_pdf.js — PDF 回忆相册生成器。
//
// 一页 PDF = 一篇回忆笔记。
//
// 旧的做法是「一页一张图」：照片铺满整页，回忆编辑页上的排版全部丢掉 ——
// 用户写的段落、图组的排布、图片的大小比例，全都没有了。现在每一页放的是
// 一整篇笔记：笔记里的文字板块和图片板块，按用户在编辑页排好的顺序，
// 整体等比缩放到一页 PDF 上。
//
// 排版本身不是在这里重画一遍 —— 那会变成第二套规则，跟编辑页慢慢走样。
// 笔记由一个离屏渲染窗口用真正的浏览器排出来：同一份 CSS、同一批模块
// （diary_layout / diary_cover / diary_themes）、同一套板块类名。所以导出
// 出来的页面就是编辑页的页面，不是它的模仿品。主进程把它截图下来，按
// 同一个比例缩放放进 PDF。
//
// 流水线：
//   离屏窗口渲染一篇笔记 → capturePage() 拿到位图 → 等比缩放 → 贴进一页 A4
//
// 缩放只有一个系数：位图按 min(页宽/图宽, 页高/图高) 整体缩放，居中放。
// 一个系数意味着笔记的长宽比不会变 —— 文字不会被拉扁，图不会被压扁，
// 每一页笔记和编辑页上看到的完全一致。

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { BrowserWindow, ipcMain } = require('electron');
const PDFDocument = require('pdfkit');

// ---- 页面尺寸 -------------------------------------------------------------

const PAGE = {
  a4Portrait:  { w: 595.28, h: 841.89 },
};

// PDF 页面四周留的白边（pt）。笔记在白边中间落位，四周是纸。
const PAGE_MARGIN = 36;

// 笔记在浏览器里的排版宽度（CSS px）。所有笔记用同一个宽度排版，PDF 里
// 的缩放才有可比性 —— 一段话和三段话会落在同样宽的版面上。
const NOTE_WIDTH = 560;

// 离屏窗口的尺寸上限。窗口本身不显示，只是排版台；它只要比笔记宽就行。
const RENDER_WINDOW = { width: NOTE_WIDTH + 120, height: 900 };

// How long the compositor is given to commit the frame the page has just
// painted, before the bitmap is taken. Long enough to be safe, short
// enough not to slow the album down: it is a handful of frames.
const PAINT_SETTLE_MS = 60;

// How long the page may take to answer "I have painted" before the
// screenshot is taken anyway. A page that never answers costs one note
// its freshness, not the whole album.
const PAINT_WAIT_MS = 5000;

// How long the render window is given to settle before it is destroyed.
// Destroying it while the renderer is still busy leaves the main process
// unable to turn its event loop, and the export hangs at the end.
const WINDOW_SETTLE_MS = 300;

// ---- 中文字体 -------------------------------------------------------------

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

// ---- 离屏渲染窗口 ---------------------------------------------------------

// 渲染窗口的生命周期由 buildAlbum 管：它在这期间一直活着，一篇一篇笔记
// 排过去。窗口不显示（show: false），但它必须真的加载出来 —— 一个
// 从没显示过的窗口在某些平台上不会渲染，capturePage 会拿到一张空白图。
//
// The window's own lifetime belongs to buildAlbum: it stays alive for the
// whole run, one note after another. It is never shown, but it does have
// to LOAD — a window that was never shown does not paint on every
// platform, and capturePage() would hand back a blank bitmap.
let renderWin = null;

async function ensureRenderWindow() {
  if (renderWin && !renderWin.isDestroyed()) return renderWin;
  renderWin = new BrowserWindow({
    width: RENDER_WINDOW.width,
    height: RENDER_WINDOW.height,
    // The window is never on screen, but it does have to PAINT: the
    // screenshot is taken from the compositor, and a compositor that has
    // not been asked for a frame hands back the LAST frame it committed —
    // which, right after a note is drawn, is the previous note's frame
    // with the photos still missing.
    //
    // The paint is asked for from the page side (the page says when it
    // has painted, and the capture follows), NOT with
    // `paintWhenInitiallyHidden`: that option stops the window from
    // loading its page at all on Windows — the load fails with
    // ERR_FAILED, the page never runs, and every note comes out empty.
    show: false,
    // The window paints nothing the user ever sees, so it needs no
    // chrome, no menu and no paint on screen.
    webPreferences: {
      preload: path.join(__dirname, 'preload_pdf_page.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The page is a measuring bench — it must be allowed to run its own
      // scripts and paint without a visible window.
      backgroundThrottling: false,
    },
  });
  // The page's own console is forwarded to the main process log: a page
  // that fails to load would otherwise fail silently, and the export
  // would just time out with nothing to show for it.
  //
  // webContents' console-message carries (event, level, message, line,
  // sourceId) — the level is a number, 0 (verbose) to 3 (error).
  renderWin.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.error('[pdf_page]', String(message), '@', sourceId + ':' + line);
  });
  renderWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[pdf_page] load failed:', code, desc, url);
  });
  renderWin.webContents.on('preload-error', (_e, file, err) => {
    console.error('[pdf_page] preload failed:', file, err && err.message);
  });
  // The listener is bound BEFORE the page loads. The page announces
  // itself the moment its module runs, which can be before loadURL()
  // resolves — a listener registered afterwards would miss it.
  const ready = waitForPageReady(renderWin);
  // The page's URL is built by Node's own converter, and the page is
  // loaded from that URL.
  //
  // Neither of the obvious ways works on Windows:
  //
  //   'file://' + path  →  'file://c:/Users/…', where the drive letter
  //                        lands in the URL's HOST slot; Chromium refuses
  //                        the load with ERR_FAILED.
  //   loadFile(path)    →  for a NORMALISED absolute path it builds
  //                        'file:///c:\Users\…' — backslashes and all —
  //                        and the load fails the same way.
  //
  // `pathToFileURL` writes the third slash and escapes the path, and
  // `loadURL` takes the URL as it is. The page loads, the notes are
  // drawn, and the album is no longer a stack of empty pages.
  const pageUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'pdf_page.html')).href;
  await renderWin.loadURL(pageUrl);
  await ready;
  // The menu is removed AFTER the page has loaded.
  //
  // `removeMenu()` before the load aborts the pending navigation: Chromium
  // cancels the request and the load fails with ERR_FAILED, so the page
  // never runs, every note fails, and the album comes out with nothing
  // but empty pages. Taking the menu away once the page is up costs
  // nothing — the window is hidden anyway.
  try { renderWin.removeMenu(); } catch {}
  return renderWin;
}

// Close the render window.
//
// The window is given a moment to settle first. Destroying it right after
// a screenshot leaves the renderer still busy, and the main process then
// cannot turn its event loop — the PDF's file stream never gets its
// 'finish' event, and the export hangs at "收尾中" with the file already
// written to disk.
async function closeRenderWindow() {
  if (renderWin && !renderWin.isDestroyed()) {
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SETTLE_MS));
    try { renderWin.destroy(); } catch {}
  }
  renderWin = null;
}

// Take a screenshot of a FRESH frame.
//
// `capturePage()` hands back the last frame the COMPOSITOR committed — it
// is not a synchronous render of the page. Right after the page has drawn
// a note, that frame can still be the previous note's, or the new note
// with its photographs not yet in it. The screenshot then goes into the
// PDF with empty picture frames, which is exactly what the album used to
// show now and then.
//
// Two things make the frame fresh:
//
//   1. The page is asked to paint again and to say when it has. The page
//      answers only after a `requestAnimationFrame` has run, so the
//      browser has been asked for a new frame.
//   2. `capturePage` is given a moment to pick that frame up. The
//      compositor hands the frame over asynchronously, so a capture
//      issued in the same tick as the paint can still be one frame
//      behind.
//
// A window that cannot be painted at all (destroyed mid-export) falls
// back to a plain capture, so a broken window costs a blank page rather
// than a failed export.
function captureFresh(win, rect) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // The page never answered: capture whatever there is rather than
      // failing the whole album over one note.
      try {
        win.webContents.capturePage(rect).then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    }, PAINT_WAIT_MS);

    const onIpc = (event) => {
      if (event.sender !== win.webContents) return;
      cleanup();
      // The page has painted. Give the compositor a moment to commit the
      // frame before the bitmap is asked for.
      setTimeout(() => {
        try {
          win.webContents.capturePage(rect).then(resolve, reject);
        } catch (e) {
          reject(e);
        }
      }, PAINT_SETTLE_MS);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener('export:pdf_page_painted', onIpc);
    };
    ipcMain.on('export:pdf_page_painted', onIpc);
    win.webContents.send('export:pdf_page_paint');
  });
}

// The page announces itself when its module has loaded and the listener
// is bound. Asking before that point would send a request into a window
// that has no listener yet, and the answer would never come.
//
// The page talks to the main process with `ipcRenderer.send`, which lands
// on `ipcMain` — NOT on `webContents.on('ipc')`. That event belongs to
// <webview> guests (`sendToHost`), and a normal page's messages never
// reach it.
//
// The listener is scoped to the render window's own webContents: the
// channels are global, so without the check a message from another window
// would be taken for this one's answer.
function waitForPageReady(win) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('pdf page did not become ready'));
    }, 20000);
    const onIpc = (event) => {
      if (event.sender !== win.webContents) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener('export:pdf_page_ready', onIpc);
    };
    ipcMain.on('export:pdf_page_ready', onIpc);
  });
}

// Ask the page to draw one note and wait for the answer.
//
// The page answers on a separate channel, because the drawing takes as
// long as it takes — it is not a synchronous call. The answer carries the
// note's box inside the window, which is what the PDF needs to scale it.
//
// A note taller than the window is cut off by the window, not by the
// note, so the window is grown to the note's height and the page is
// asked to draw it again in the taller space. The loop runs until the
// note fits — a note that grows the window is drawn once more, and once
// more if it still does not fit.
function renderNoteInPage(win, eventId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('pdf page render timed out'));
    }, 60000);

    const onIpc = (event, result) => {
      if (event.sender !== win.webContents) return;
      // A reply from a draw that has been overtaken by a newer one is
      // not an answer — the newer one is still on its way.
      if (result && result.reason === 'stale') return;
      if (result && result.ok && result.height > windowHeight(win, result.viewportHeight)) {
        // The note is taller than the window: grow the window to hold
        // it, and let the page draw it again in the new space.
        win.setContentSize(RENDER_WINDOW.width, result.height);
        win.webContents.send('export:pdf_page_render', { eventId, width: NOTE_WIDTH });
        return;
      }
      cleanup();
      resolve(result || { ok: false, reason: 'no_reply' });
    };
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener('export:pdf_page_reply', onIpc);
    };
    ipcMain.on('export:pdf_page_reply', onIpc);
    win.webContents.send('export:pdf_page_render', { eventId, width: NOTE_WIDTH });
  });
}

// The window's inner height, in CSS pixels.
//
// `getContentSize` is the frame's inner size, which is what the page's
// viewport is — but on Windows it can lag one round-trip behind a
// `setContentSize`, so the height the page itself reports is preferred
// when it is available.
function windowHeight(win, reported) {
  if (typeof reported === 'number' && reported > 0) return reported;
  return win.getContentSize()[1];
}

// ---- main entry -----------------------------------------------------------

// Build the PDF 回忆相册.
//
//   options: {
//     events:   MemorialEventRowWithPhotos[]
//     outPath:  string
//     progressCb: (phase, percent, note?) => void
//   }
//
// Returns: { pages, events, photos, notes, failed, bytes, font, heicSkipped }
async function buildAlbum(options) {
  const { events, outPath, progressCb = () => {} } = options || {};
  if (!Array.isArray(events)) throw new Error('buildAlbum: events required');
  if (!outPath) throw new Error('buildAlbum: outPath required');

  const safeProgress = (phase, percent, note) => {
    try { progressCb(phase, Math.max(0, Math.min(100, percent)), note); } catch {}
  };
  safeProgress('preparing', 0);

  // The document.
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
  let notesRendered = 0;
  let failed = 0;

  try {
    // The cover comes first, then one page per note.
    renderCover(doc, events);
    pages += 1;

    // The render window is opened once and reused for every note: it is
    // the expensive part, and one window keeps one page's photo cache
    // warm for the notes that share a picture.
    const win = await ensureRenderWindow();

    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      const note = await renderNoteInPage(win, ev.id);
      if (!note || !note.ok || !note.width || !note.height) {
        failed += 1;
        console.error('[album_pdf] could not draw the entry', ev.id, note && note.reason);
        // A note that could not be drawn still gets a page — an empty one
        // with its title — so the album keeps one page per entry and the
        // order of the entries never shifts.
        renderEmptyNote(doc, ev, i, events.length);
        pages += 1;
        safeProgress('encoding', 5 + 85 * ((i + 1) / Math.max(1, events.length)),
          `第 ${i + 1} / ${events.length} 篇`);
        continue;
      }

      // Capture ONLY the note's box, not the whole window. The window is
      // a measuring bench and is wider and taller than the note; the
      // parts around the note are not part of the page, and including
      // them would shrink the note and change its proportions.
      //
      // The frame is asked for FRESH, not for whatever is on screen: the
      // page has just drawn a note, and the compositor may still be
      // holding the PREVIOUS note's frame. A capture taken then shows
      // the previous note — or the same note with its photos still
      // missing, because the pictures were swapped in after the last
      // committed frame.
      const shot = await captureFresh(win, {
        x: note.x, y: note.y, width: note.width, height: note.height,
      });
      const png = shot.toPNG();
      // The bitmap's own size, not the size the page reported: the
      // capture comes back at the screen's pixel density, and the scale
      // below is computed from what is actually on the page.
      const size = shot.getSize();

      doc.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
      pages += 1;
      // The ONE scale factor: the note is scaled as a whole, so its
      // proportions are the ones the editor drew it with.
      const boxW = PAGE.a4Portrait.w - PAGE_MARGIN * 2;
      const boxH = PAGE.a4Portrait.h - PAGE_MARGIN * 2;
      const scale = Math.min(boxW / size.width, boxH / size.height);
      const drawW = size.width * scale;
      const drawH = size.height * scale;
      const x = (PAGE.a4Portrait.w - drawW) / 2;
      const y = (PAGE.a4Portrait.h - drawH) / 2;
      doc.image(png, x, y, { width: drawW, height: drawH });
      notesRendered += 1;
      photosRendered += countPhotosOf(ev);

      safeProgress('encoding', 5 + 85 * ((i + 1) / Math.max(1, events.length)),
        `第 ${i + 1} / ${events.length} 篇`);
    }
  } finally {
    await closeRenderWindow();
  }

  safeProgress('finalizing', 92);

  // The stream's end is waited for with the listener ALREADY attached.
  //
  // `doc.end()` flushes what is left; a small album can be written out
  // entirely in that flush, and the 'finish' event then fires BEFORE a
  // listener added afterwards would exist — the wait would never end and
  // the export would hang with the progress bar stuck at "收尾中".
  const finished = new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
  doc.end();
  await finished;

  const bytes = fs.statSync(outPath).size;
  safeProgress('done', 100);
  return {
    pages,
    events: events.length,
    photos: photosRendered,
    notes: notesRendered,
    failed,
    bytes,
    font: fontState,
    heicSkipped: 0,
  };
}

// How many pictures a note carries. The count is only for the progress
// line and the cover — the pictures themselves are drawn by the render
// page, which reads the document with the editor's own parser.
//
// A note written before the mixed editor existed stores its pictures as
// single `image` blocks; those count as one picture each, the same way
// the editor reads them as one-picture galleries.
function countPhotosOf(ev) {
  let n = 0;
  const blocks = parseContentBlocks(ev.content);
  for (const b of blocks) {
    if (b.type === 'gallery' && Array.isArray(b.photos)) n += b.photos.length;
    else if (b.type === 'image' && b.photo_id) n += 1;
  }
  return n;
}

// The stored document, read with the same rules the renderer uses.
//
// The renderer parses the document itself; this copy only counts the
// pictures, so it stays a light reader — an unparseable document simply
// counts no pictures.
function parseContentBlocks(content) {
  if (!content) return [];
  let parsed = content;
  if (typeof content === 'string') {
    try { parsed = JSON.parse(content); } catch (e) { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((b) => b && typeof b === 'object');
}

// ---- 封面 -----------------------------------------------------------------

function renderCover(doc, events) {
  const BRAND = '#f4a8a0';
  const TEXT = '#2a2a2a';
  const MUTED = '#8a8478';
  const w = PAGE.a4Portrait.w;
  const h = PAGE.a4Portrait.h;

  doc.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
  doc.rect(0, 0, w, 24).fill(BRAND);
  doc.rect(0, h - 24, w, 24).fill(BRAND);
  doc.fillColor(TEXT).fontSize(40)
     .text('回忆相册', 0, h * 0.30, { width: w, align: 'center' });
  let totalPhotos = 0;
  for (const ev of events) totalPhotos += countPhotosOf(ev);
  doc.moveDown(1.5).fontSize(14).fillColor(MUTED)
     .text(`${events.length} 篇回忆 · ${totalPhotos} 张照片`, { width: w, align: 'center' });
  if (events.length) {
    const earliest = fmtDateOnly(events[0].occurred_at);
    const latest = fmtDateOnly(events[events.length - 1].occurred_at);
    doc.moveDown(0.5).text(`时间跨度：${earliest} → ${latest}`, { width: w, align: 'center' });
  }
  doc.moveDown(0.5).text(`生成于 ${fmtDateOnly(new Date().toISOString())}`, { width: w, align: 'center' });
}

// A note that could not be drawn still gets its page: the title and the
// date, so the reader can see which entry it was and the album keeps one
// page per entry.
function renderEmptyNote(doc, ev, index, total) {
  const w = PAGE.a4Portrait.w;
  const h = PAGE.a4Portrait.h;
  doc.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
  doc.fillColor('#2a2a2a').fontSize(20)
     .text(ev.title || '(无标题)', PAGE_MARGIN, PAGE_MARGIN, { width: w - PAGE_MARGIN * 2, align: 'center' });
  doc.moveDown(0.5).fontSize(11).fillColor('#8a8478')
     .text(fmtDateOnly(ev.occurred_at), PAGE_MARGIN, doc.y, { width: w - PAGE_MARGIN * 2, align: 'center' });
  doc.fontSize(10).fillColor('#8a8478')
     .text('（这篇回忆的内容无法排入 PDF）', PAGE_MARGIN, h / 2, { width: w - PAGE_MARGIN * 2, align: 'center' });
  doc.fontSize(9).fillColor('#8a8478')
     .text(`第 ${index + 1} / ${total} 篇`, PAGE_MARGIN, h - PAGE_MARGIN - 12,
       { width: w - PAGE_MARGIN * 2, align: 'center' });
}

module.exports = { buildAlbum };
