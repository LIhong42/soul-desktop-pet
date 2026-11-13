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
  return makePng(width, height, 220, 20, 20);
}

// A picture in a colour of its own — the imported one is blue, so "did the
// imported picture reach the wall" is a question about the pixels.
function makePng(width, height, r, g, b) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0; // filter: none
    at += 1;
    for (let x = 0; x < width; x += 1) {
      raw[at] = r; at += 1;
      raw[at] = g; at += 1;
      raw[at] = b; at += 1;
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

// The app's own CSP, read from src/index.html.
//
// The harness page MUST carry it: the real window loads src/index.html, and
// a CSP rule the page does not have (the wall export draws the original
// bytes through a blob: URL) is invisible to a harness without one — the
// test would pass while the app showed an empty wall.
function appCsp() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  if (!m) throw new Error('src/index.html has no Content-Security-Policy');
  return m[1];
}

// The page that hosts the wall. It is the project's own page module, loaded
// on its own — the whole app (with its pet, its reminders and its PIN
// lock) is not what is being tested here.
//
// The page's script is a FILE, not an inline block: the app's CSP says
// `script-src 'self'`, so an inline module would be refused and the page
// would never start.
function writeHarnessPage(dir, ids) {
  const script = `import { start } from '${pathToFileURL(path.join(ROOT, 'src', 'js', 'router.js')).href}';
import '${pathToFileURL(path.join(ROOT, 'src', 'js', 'pages', 'photo_wall.js')).href}';
location.hash = '#/photo-wall?ids=${ids.join(',')}';
start();
`;
  fs.writeFileSync(path.join(dir, 'wall-harness.js'), script, 'utf8');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${appCsp()}"/>
<link rel="stylesheet" href="${pathToFileURL(path.join(ROOT, 'src', 'css', 'styles.css')).href}"/>
</head>
<body>
<div id="app"></div>
<script type="module" src="wall-harness.js"></script>
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
  // they have to be the real thing. The temporary photo store is the real
  // one too (main/tmp_photos.js): the imported photos have to land on
  // disk and be deleted again, exactly like they do in the app.
  const photoThumb = require(path.join(ROOT, 'main', 'photo_thumb.js'));
  const tmpPhotos = require(path.join(ROOT, 'main', 'tmp_photos.js'));
  // An upload into a memory — the import must NOT do this. The handler
  // exists so that a regression shows up as a recorded call.
  const memoryUploads = [];
  const findPhoto = (photoId) => {
    for (const ev of events) {
      const row = ev.photos.find((p) => p.id === photoId);
      if (row) return { ev, row };
    }
    return null;
  };
  const photoPath = (ev, row) => path.join(photosDir, ev.id, path.basename(row.relative_path));
  ipcMain.handle('memorial_events:get', (_e, id) => events.find((x) => x.id === id) || null);
  ipcMain.handle('memorial_events:photos_upload', (_e, eventId, input) => {
    memoryUploads.push({ eventId, filename: input && input.filename });
    throw new Error('the wall must not upload into a memory');
  });
  ipcMain.handle('memorial_events:photo_thumb', async (_e, photoId) => {
    const hit = findPhoto(photoId);
    if (!hit) return null;
    return await photoThumb.getThumb({
      photoId,
      sourcePath: photoPath(hit.ev, hit.row),
      appData: app.getPath('appData'),
    });
  });
  ipcMain.handle('memorial_events:photo_bytes', (_e, photoId) => {
    const hit = findPhoto(photoId);
    if (!hit) return null;
    const file = photoPath(hit.ev, hit.row);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  });
  ipcMain.handle('memorial_events:photo_read', (_e, photoId) => {
    const hit = findPhoto(photoId);
    if (!hit) return null;
    const file = photoPath(hit.ev, hit.row);
    if (!fs.existsSync(file)) return null;
    const mime = hit.row.mime || 'image/png';
    return { data_url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`, mime };
  });
  // The temporary store the imported photos live in.
  ipcMain.handle('tmp_photos:save', (_e, input) => tmpPhotos.save({
    appData: app.getPath('appData'),
    filename: input && input.filename,
    mime: input && input.mime,
    bytes: input && input.bytes,
  }));
  ipcMain.handle('tmp_photos:thumb', async (_e, id) => {
    const file = tmpPhotos.fileOf(app.getPath('appData'), id);
    if (!file) return null;
    return await photoThumb.getThumb({
      photoId: id,
      sourcePath: file,
      appData: app.getPath('appData'),
    });
  });
  ipcMain.handle('tmp_photos:read', (_e, id) =>
    tmpPhotos.read({ appData: app.getPath('appData'), id }));
  ipcMain.handle('tmp_photos:remove', (_e, id) => {
    const done = tmpPhotos.remove({ appData: app.getPath('appData'), id });
    photoThumb.removeThumb(id, app.getPath('appData'));
    return done;
  });
  ipcMain.handle('tmp_photos:clear', () =>
    tmpPhotos.clear({ appData: app.getPath('appData') }));

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
      const n = await win.webContents.executeJavaScript(`(() => {
        const cv = document.getElementById('wall-canvas');
        if (!cv || !cv.style.width) return 0;
        const note = document.getElementById('wall-template-note');
        if (note && note.textContent.includes('正在读取')) return 0;
        return cv.width;
      })()`);
      return n > 0 ? n : null;
    }, 20000);
    report.canvasWidth = ready;

    // What the wall looks like: the canvas is one piece, so the questions
    // are about the pixels — how much red is on it, and is the corner
    // (outside the shape) still white?
    report.preview = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let red = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total += 1;
        if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
      }
      const corner = [d[0], d[1], d[2]];
      const bottomRight = (() => {
        const i = ((cv.height - 1) * cv.width + (cv.width - 1)) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      })();
      return {
        width: cv.width,
        height: cv.height,
        redRatio: Number((total ? red / total : 0).toFixed(4)),
        corner: corner,
        bottomRight: bottomRight,
        cssWidth: parseFloat(cv.style.width) || 0,
        cssHeight: parseFloat(cv.style.height) || 0,
        stageWidth: cv.parentElement ? cv.parentElement.clientWidth : 0,
        windowWidth: window.innerWidth,
        note: document.getElementById('wall-template-note')
          ? document.getElementById('wall-template-note').textContent : '',
      };
    })()`);

    // Clicking a cell picks it — the side panel then offers that cell's
    // photo (the top-left cell always carries the first picture).
    await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      const r = cv.getBoundingClientRect();
      cv.dispatchEvent(new MouseEvent('click', {
        clientX: r.left + r.width * 0.2,
        clientY: r.top + r.height * 0.15,
        bubbles: true,
      }));
    })()`);
    report.selection = await win.webContents.executeJavaScript(`(() => ({
      hasCoverBtn: !!document.getElementById('wall-cover-btn'),
      hasRemoveBtn: !!document.getElementById('wall-remove-btn'),
    }))()`);

    // Import a picture from the system — the way a user does when the
    // notes have no photos left for the wall.
    //
    // The file goes into the picker of the page (CDP sets the files of a
    // file input), so the page really reads the file and really stores
    // it. The wall still has free cells, so the imported picture lands on
    // one of them.
    const importFile = path.join(tmp, 'imported-blue.png');
    fs.writeFileSync(importFile, makePng(260, 200, 30, 90, 220));
    win.webContents.debugger.attach('1.3');
    const doc = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const inputNode = await win.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '#wall-import-input',
    });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [importFile],
      nodeId: inputNode.nodeId,
    });
    win.webContents.debugger.detach();
    // The page counts its own photos — the note says how many there are.
    const imported = await waitFor(async () => {
      const n = await win.webContents.executeJavaScript(`(() => {
        const note = document.getElementById('wall-template-note');
        if (!note) return 0;
        const m = /照片 (\\d+) 张/.exec(note.textContent);
        return m ? Number(m[1]) : 0;
      })()`);
      return n >= 5 ? n : null;
    }, 20000);
    report.importedPhotos = imported;
    // It went into the temporary store, not into a memory.
    report.memoryUploads = memoryUploads;
    const tmpDir = tmpPhotos.tmpDir(app.getPath('appData'));
    report.tmpFilesDuringImport = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    // The imported picture is blue: is it on the wall?
    report.blueOnWall = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      if (!cv) return 0;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let blue = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 90 && d[i + 1] < 120 && d[i + 2] > 140) blue += 1;
      }
      return blue;
    })()`);

    // Export it.
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-export-btn").click()');
    const written = await waitFor(() => (fs.existsSync(outPath) ? outPath : null), 30000);
    report.exported = !!written;
    // The export is done → the temporary photos are deleted (they were only
    // material for this wall, and they belong to no memory).
    await waitFor(() => {
      const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
      return files.length === 0;
    }, 10000);
    report.tmpFilesAfterExport = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    // Their cached thumbnails go with them.
    const thumbDir = path.join(app.getPath('appData'), 'SoulDesktopPet', 'thumbs');
    const thumbFiles = fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir) : [];
    const tmpIds = (report.tmpFilesDuringImport || []).map((x) => path.basename(x, path.extname(x)));
    report.tmpThumbsLeft = thumbFiles.filter((f) => tmpIds.some((i) => i && f.startsWith(i)));
    // The layout after the export — the export re-renders the page, so the
    // wall must not come out a different size than it went in.
    report.after = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      return {
        width: cv ? cv.width : 0,
        height: cv ? cv.height : 0,
        cssWidth: cv ? parseFloat(cv.style.width) : 0,
      };
    })()`);

    if (written) {
      // The PNG that came out is read back and looked at: its size, how much
      // of it is red, and how far the shape keeps away from the edges.
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
        let red = 0, total = 0, blue = 0;
        // The shape's box: everything that is not the white background.
        let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
        for (let y = 0; y < cv.height; y += 1) {
          for (let x = 0; x < cv.width; x += 1) {
            const i = (y * cv.width + x) * 4;
            total += 1;
            if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
            if (d[i] < 90 && d[i + 1] < 120 && d[i + 2] > 140) blue += 1;
            if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        const r4 = (n) => Number(n.toFixed(4));
        return {
          width: img.naturalWidth,
          height: img.naturalHeight,
          redRatio: r4(total ? red / total : 0),
          blueRatio: r4(total ? blue / total : 0),
          bytes: ${JSON.stringify(fs.statSync(outPath).size)},
          // How much white the shape keeps between itself and each edge,
          // as a share of that edge's length.
          margin: {
            left: r4(cv.width ? minX / cv.width : 0),
            right: r4(cv.width ? (cv.width - 1 - maxX) / cv.width : 0),
            top: r4(cv.height ? minY / cv.height : 0),
            bottom: r4(cv.height ? (cv.height - 1 - maxY) / cv.height : 0),
          },
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

    // Import once more and leave the page WITHOUT exporting: the temporary
    // photos are cleaned up on the way out too.
    const importFile2 = path.join(tmp, 'imported-green.png');
    fs.writeFileSync(importFile2, makePng(200, 200, 20, 160, 40));
    win.webContents.debugger.attach('1.3');
    const doc2 = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const inputNode2 = await win.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: doc2.root.nodeId,
      selector: '#wall-import-input',
    });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [importFile2],
      nodeId: inputNode2.nodeId,
    });
    win.webContents.debugger.detach();
    await waitFor(async () => {
      const n = await win.webContents.executeJavaScript(`(() => {
        const note = document.getElementById('wall-template-note');
        if (!note) return 0;
        const m = /照片 (\\d+) 张/.exec(note.textContent);
        return m ? Number(m[1]) : 0;
      })()`);
      return n >= 5 ? n : null;
    }, 20000);
    report.tmpFilesBeforeLeave = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    await win.webContents.executeJavaScript(`location.hash = '#/elsewhere'`);
    await waitFor(() => {
      const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
      return files.length === 0;
    }, 10000);
    report.tmpFilesAfterLeave = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];

    report.errors = errors;
    // The wall is one canvas now: the pictures are on it, the shape clips
    // them (so the corner of the canvas stays white), and the export comes
    // out as a PNG of the same shape. The shape also keeps away from the
    // edges — a heart pasted onto the border looks cut off.
    const margin = (report.png && report.png.margin) || {};
    report.ok = !!report.exported
      && report.selection && report.selection.hasCoverBtn
      && report.preview && report.preview.redRatio > 0.05
      && report.preview.corner[0] > 200
      && report.preview.bottomRight[0] > 200
      && report.png && report.png.redRatio > 0.05
      && report.png.width > 200 && report.png.height > 200
      && margin.left > 0.03 && margin.right > 0.03
      && margin.top > 0.03 && margin.bottom > 0.03
      // The imported picture: it was stored in the temp directory (not in
      // a memory), it is on the wall, and it is in the exported PNG.
      // After the export it is gone again.
      && report.importedPhotos === 5
      && report.memoryUploads && report.memoryUploads.length === 0
      && report.tmpFilesDuringImport && report.tmpFilesDuringImport.length === 1
      && report.blueOnWall > 0
      && report.png && report.png.blueRatio > 0.0005
      && report.tmpFilesAfterExport && report.tmpFilesAfterExport.length === 0
      && report.tmpThumbsLeft && report.tmpThumbsLeft.length === 0
      // Leaving the page without exporting cleans up as well.
      && report.tmpFilesBeforeLeave && report.tmpFilesBeforeLeave.length === 1
      && report.tmpFilesAfterLeave && report.tmpFilesAfterLeave.length === 0
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
