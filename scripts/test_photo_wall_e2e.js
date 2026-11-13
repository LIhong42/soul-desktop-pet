// scripts/test_photo_wall_e2e.js — end-to-end check of the photo wall.
//
// The wall has three parts, and two of them only exist in a real browser:
// the cover maths (pure, and checked on its own) and the drawing of the
// covers into the cells and into the exported PNG.
//
// So this runs the REAL page in a REAL Electron: it builds a small set of
// photographs, opens /photo-wall with them, and then looks at the pixels —
// first in the cells of the page, then in the PNG the export produced.
//
// The photographs are solid red. A cell that came out empty is white, and a
// cell that came out wrong is some other colour — so "is there red in the
// right place" is a question about the actual bytes, not about the code
// having run.
//
// Run: node scripts/run-electron.js scripts/run-photo-wall-e2e.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { app, ipcMain, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

// ---- solid red pictures ----------------------------------------------------

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ 0xffffffff;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

// A picture that cannot be mistaken for a placeholder: solid red.
function makeRedPng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0; // filter: none
    at += 1;
    for (let x = 0; x < width; x += 1) {
      raw[at] = 220; at += 1; // R
      raw[at] = 20; at += 1;  // G
      raw[at] = 20; at += 1;  // B
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- helpers ---------------------------------------------------------------

async function waitFor(fn, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { /* not there yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// The page that hosts the wall. It is the project's own page module, loaded
// on its own — the whole app (with its pet, its reminders and its PIN
// lock) is not what is being tested here.
function writeHarnessPage(dir, ids) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<link rel="stylesheet" href="${pathToFileURL(path.join(ROOT, 'src', 'css', 'styles.css')).href}"/>
</head>
<body>
<div id="app"></div>
<script type="module">
  import { start } from '${pathToFileURL(path.join(ROOT, 'src', 'js', 'router.js')).href}';
  import '${pathToFileURL(path.join(ROOT, 'src', 'js', 'pages', 'photo_wall.js')).href}';
  location.hash = '#/photo-wall?ids=${ids.join(',')}';
  start();
</script>
</body>
</html>`;
  const file = path.join(dir, 'wall-harness.html');
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

module.exports = (async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-e2e-'));
  // The app's photos live in <appData>/SoulDesktopPet/photos — the same
  // place the real app keeps them.
  app.setPath('appData', tmp);
  app.setPath('userData', path.join(tmp, 'userData'));
  const photosDir = path.join(tmp, 'SoulDesktopPet', 'photos');

  // Two notes, two photos each, of different shapes — so the cover maths
  // has something to chew on.
  const events = [];
  let photoCount = 0;
  for (let n = 0; n < 2; n += 1) {
    const eventId = 'ev' + n;
    const dir = path.join(photosDir, eventId);
    fs.mkdirSync(dir, { recursive: true });
    const photos = [];
    for (let p = 0; p < 2; p += 1) {
      const photoId = `${eventId}_p${p}`;
      const wide = (n + p) % 2 === 0;
      fs.writeFileSync(path.join(dir, `${photoId}.png`), makeRedPng(wide ? 320 : 200, wide ? 240 : 300));
      photos.push({ photo_id: photoId });
      photoCount += 1;
    }
    events.push({
      id: eventId,
      title: `第 ${n + 1} 篇回忆`,
      occurred_at: '2026-03-14 00:00:00',
      content: JSON.stringify([
        { type: 'text', text: `第 ${n + 1} 篇的文字` },
        { type: 'gallery', layout: 'two', photos },
      ]),
      photos: photos.map((x) => ({
        id: x.photo_id,
        relative_path: `${x.photo_id}.png`,
        original_name: `${x.photo_id}.png`,
        mime: 'image/png',
      })),
    });
  }

  // The IPC the wall page needs. The thumbnail handler is the REAL one
  // (main/photo_thumb.js) — the thumbnails are what the page draws, so
  // they have to be the real thing.
  const photoThumb = require(path.join(ROOT, 'main', 'photo_thumb.js'));
  ipcMain.handle('memorial_events:get', (_e, id) => events.find((x) => x.id === id) || null);
  ipcMain.handle('memorial_events:photo_thumb', async (_e, photoId) => {
    const ev = events.find((x) => x.photos.some((p) => p.id === photoId));
    if (!ev) return null;
    return await photoThumb.getThumb({
      photoId,
      sourcePath: path.join(photosDir, ev.id, `${photoId}.png`),
      appData: app.getPath('appData'),
    });
  });
  ipcMain.handle('memorial_events:photo_bytes', (_e, photoId) => {
    const ev = events.find((x) => x.photos.some((p) => p.id === photoId));
    if (!ev) return null;
    const file = path.join(photosDir, ev.id, `${photoId}.png`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  });

  const outPath = path.join(tmp, 'wall.png');
  ipcMain.handle('export:photo_wall', (_e, payload) => {
    const bytes = payload && payload.bytes;
    if (!bytes || !bytes.byteLength) throw new Error('没有可导出的照片墙数据');
    fs.writeFileSync(outPath, Buffer.from(bytes));
    return { path: outPath, bytes: bytes.byteLength };
  });

  const errors = [];
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    // The harness page has no CSP of its own, so Electron prints its
    // security warning into the console. It says nothing about the wall.
    if (level >= 2 && !/Security Warning/.test(message)) errors.push(message);
  });

  const report = { photos: photoCount, ok: false };
  try {
    const page = writeHarnessPage(tmp, events.map((e) => e.id));
    await win.loadFile(page);

    // The wall draws itself once the photos are in.
    const ready = await waitFor(async () => {
      const n = await win.webContents.executeJavaScript(
        'document.querySelectorAll(".wall-cell").length');
      return n > 0 ? n : null;
    }, 20000);
    report.cells = ready;

    // What the cells look like: how many of them carry a picture, and how
    // much red is in each of them.
    report.preview = await win.webContents.executeJavaScript(`(() => {
      const cells = [...document.querySelectorAll('.wall-cell')];
      const out = { total: cells.length, filled: 0, redRatios: [], empty: 0 };
      for (const el of cells) {
        const cv = el.querySelector('canvas');
        if (!cv) continue;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let red = 0, total = 0;
        for (let i = 0; i < d.length; i += 4) {
          total += 1;
          if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
        }
        const ratio = total ? red / total : 0;
        if (ratio > 0.5) { out.filled += 1; out.redRatios.push(Number(ratio.toFixed(3))); }
        else out.empty += 1;
      }
      const grid = document.querySelector('.wall-grid');
      out.gridWidth = grid ? parseFloat(grid.style.width) : 0;
      out.gridHeight = grid ? parseFloat(grid.style.height) : 0;
      out.scrollWidth = grid ? grid.parentElement.clientWidth : 0;
      out.windowWidth = window.innerWidth;
      out.columnWidth = document.querySelector('.page-column')
        ? document.querySelector('.page-column').clientWidth : 0;
      const cell = document.querySelector('.wall-cell');
      out.cellWidth = cell ? cell.offsetWidth : 0;
      return out;
    })()`);

    // Export it.
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-export-btn").click()');
    const written = await waitFor(() => (fs.existsSync(outPath) ? outPath : null), 30000);
    report.exported = !!written;
    // The layout after the export — the export re-renders the page, so the
    // wall must not come out a different size than it went in.
    report.after = await win.webContents.executeJavaScript(`(() => {
      const grid = document.querySelector('.wall-grid');
      const cell = document.querySelector('.wall-cell');
      return {
        gridWidth: grid ? parseFloat(grid.style.width) : 0,
        cellWidth: cell ? cell.offsetWidth : 0,
        scrollWidth: grid ? grid.parentElement.clientWidth : 0,
      };
    })()`);

    if (written) {
      // The PNG that came out is read back and looked at: its size, and
      // how much of it is red.
      const dataUrl = 'data:image/png;base64,' + fs.readFileSync(outPath).toString('base64');
      report.png = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let red = 0, total = 0;
        for (let i = 0; i < d.length; i += 4) {
          total += 1;
          if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
        }
        return {
          width: img.naturalWidth,
          height: img.naturalHeight,
          redRatio: Number((total ? red / total : 0).toFixed(4)),
          bytes: ${JSON.stringify(fs.statSync(outPath).size)},
        };
      })()`);
    }

    // A picture of the page, so the wall can be looked at rather than
    // only measured.
    try {
      const shot = await win.webContents.capturePage();
      const shotPath = path.join(tmp, 'wall-page.png');
      fs.writeFileSync(shotPath, shot.toPNG());
      report.screenshot = shotPath;
    } catch (e) {
      report.screenshotError = String(e && e.message);
    }

    report.errors = errors;
    report.ok = !!report.exported
      && report.preview && report.preview.filled === report.photos
      && report.preview.empty === report.preview.total - report.photos
      && report.png && report.png.redRatio > 0.05
      && report.png.width > 200 && report.png.height > 200
      && errors.length === 0;
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.errors = errors;
  }

  console.log(JSON.stringify(report, null, 2));
  const reportPath = path.join(__dirname, '_photo_wall_e2e_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  if (!report.ok) process.exitCode = 1;
})();
