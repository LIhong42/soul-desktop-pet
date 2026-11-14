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

// A pointer gesture on the wall's canvas: press, move, release.
//
// The shape is dragged with POINTER events (not mouse ones), so this has to
// dispatch PointerEvents — a MouseEvent would never move the shape and the
// test would pass while the feature was broken.
function pointerGesture(win, from, to, steps) {
  const n = steps || 6;
  return win.webContents.executeJavaScript(`(() => {
    const cv = document.getElementById('wall-canvas');
    if (!cv) return false;
    const r = cv.getBoundingClientRect();
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 1,
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + x,
      clientY: r.top + y,
    });
    const x0 = ${JSON.stringify(from[0])}, y0 = ${JSON.stringify(from[1])};
    const x1 = ${JSON.stringify(to[0])}, y1 = ${JSON.stringify(to[1])};
    cv.dispatchEvent(mk('pointerdown', x0, y0));
    for (let i = 1; i <= ${n}; i += 1) {
      const k = i / ${n};
      cv.dispatchEvent(mk('pointermove', x0 + (x1 - x0) * k, y0 + (y1 - y0) * k));
    }
    cv.dispatchEvent(mk('pointerup', x1, y1));
    return true;
  })()`);
}

// Where the wall's shape sits on the canvas — measured from the PIXELS.
//
// The wall's outline is the only thing on the canvas that is not white (the
// shape has its own fill, and the photos are red), so the bounding box of
// everything non-white IS the shape's box. Measuring it this way means the
// test never has to know how the page stores the shape — it asks what was
// actually drawn.
//
// The result is in CANVAS pixels (the canvas' own pixel grid), so the caller
// has to convert to CSS pixels before using it as a gesture target.
function shapeBox(win) {
  return win.webContents.executeJavaScript(`(() => {
    const cv = document.getElementById('wall-canvas');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
    for (let y = 0; y < cv.height; y += 1) {
      for (let x = 0; x < cv.width; x += 1) {
        const i = (y * cv.width + x) * 4;
        // White = outside the shape (the background is not white in this
        // phase of the test, so the shape's own fill counts as non-white).
        if (d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return {
      minX, minY, maxX, maxY,
      width: cv.width,
      height: cv.height,
      cssScale: parseFloat(cv.style.width) / cv.width,
    };
  })()`);
}

// The shape's centre, in PERCENTAGES of the canvas — the same measure the
// page's centre-position boxes use.
//
// It is read from the page's own inputs (which the page keeps in sync with
// the shape) and cross-checked against the pixels: a box that says 30 while
// the shape sits at 50 would be a lie, and the test has to catch that.
//
// The pixel side measures the shape's **right edge**, not the middle of its
// bounding box: the shape can hang off the canvas (that is allowed — only
// its centre has to stay on), and a clipped box has a middle that is not
// the shape's middle. The right edge is not clipped when the shape moves
// LEFT, which is the direction this test moves it in.
function shapeCentre(win) {
  return win.webContents.executeJavaScript(`(() => {
    const cv = document.getElementById('wall-canvas');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
    for (let y = 0; y < cv.height; y += 1) {
      for (let x = 0; x < cv.width; x += 1) {
        const i = (y * cv.width + x) * 4;
        if (d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return {
      // From the pixels: the shape's right edge, as a percentage. The
      // centre sits half the shape's width to the left of it.
      rightEdge: (maxX / cv.width) * 100,
      topEdge: (minY / cv.height) * 100,
      bottomEdge: (maxY / cv.height) * 100,
      // From the page's inputs: what it says the centre is.
      inputX: document.getElementById('wall-shape-cx')
        ? Number(document.getElementById('wall-shape-cx').value) : null,
      inputY: document.getElementById('wall-shape-cy')
        ? Number(document.getElementById('wall-shape-cy').value) : null,
    };
  })()`);
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
// An uncaught error in the page is printed with its stack, so a failure
// points at the line that threw.
window.addEventListener('error', (e) => {
  console.error('UNCAUGHT ' + (e.error && e.error.stack ? e.error.stack : e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  console.error('UNHANDLED ' + (r && r.stack ? r.stack : String(r)));
});
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
  // The background catalog is the REAL one (main/photo_wall_bg.js): the page
  // has to find the art and read its bytes exactly the way the app does.
  const photoWallBg = require(path.join(ROOT, 'main', 'photo_wall_bg.js'));
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

  // The background catalog: the real scanner, and the real byte reader.
  ipcMain.handle('photo_wall_bg:list', () => photoWallBg.list(null));
  ipcMain.handle('photo_wall_bg:read', (_e, payload) =>
    photoWallBg.read(null, payload && payload.ratioId, payload && payload.id));

  // The wall's edit state and its export history — the REAL modules, on a
  // fake database (the settings table in memory).
  //
  // The real modules are the point: the test wants to know whether the
  // renderer saves what it should and reads it back, and the saving/reading
  // rules live in these two files.
  const photoWallState = require(path.join(ROOT, 'main', 'photo_wall_state.js'));
  const photoWallHistory = require(path.join(ROOT, 'main', 'photo_wall_history.js'));
  const settingsRows = new Map();
  const fakeDb = {
    getSetting: (key) => (settingsRows.has(key) ? settingsRows.get(key) : null),
    setSetting: (key, value) => { settingsRows.set(key, String(value)); },
    run: (sql, params) => {
      if (/DELETE\s+FROM\s+settings/i.test(sql)) { settingsRows.delete(params[0]); return; }
      throw new Error('fakeDb.run: unexpected SQL: ' + sql);
    },
    nowStr: () => new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  ipcMain.handle('photo_wall_state:get', (_e, payload) =>
    photoWallState.loadState(fakeDb, payload && payload.eventIds));
  ipcMain.handle('photo_wall_state:save', (_e, payload) =>
    photoWallState.saveState(fakeDb, payload && payload.eventIds, payload && payload.state));
  ipcMain.handle('photo_wall_state:clear', (_e, payload) =>
    photoWallState.clearState(fakeDb, payload && payload.eventIds));
  ipcMain.handle('photo_wall_history:list', () => photoWallHistory.listEntries(fakeDb));
  ipcMain.handle('photo_wall_history:add', (_e, payload) =>
    photoWallHistory.addEntry(fakeDb, payload || {}));
  ipcMain.handle('photo_wall_history:remove', (_e, payload) =>
    photoWallHistory.removeEntry(fakeDb, payload && payload.id));
  ipcMain.handle('photo_wall_history:clear', () => photoWallHistory.clearEntries(fakeDb));

  const outPath = path.join(tmp, 'wall.png');
  // The exports go to a different file each time, so the second export (the
  // one WITH the background) does not overwrite the first one (the baseline
  // without a background).
  let exportTarget = outPath;
  const exportMetas = [];
  ipcMain.handle('export:photo_wall', (_e, payload) => {
    const bytes = payload && payload.bytes;
    if (!bytes || !bytes.byteLength) throw new Error('没有可导出的照片墙数据');
    fs.writeFileSync(exportTarget, Buffer.from(bytes));
    // The real handler records the export in the history; the harness does
    // the same so the history the page shows is the one the app would show.
    exportMetas.push(payload.meta || null);
    const meta = payload.meta || {};
    const entry = photoWallHistory.addEntry(fakeDb, {
      exportedAt: fakeDb.nowStr(),
      path: exportTarget,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      photoCount: Number(meta.photoCount) || 0,
      shapeId: meta.shapeId || '',
      sizeId: meta.sizeId || '',
      ratioId: meta.ratioId || '',
      snapshot: meta.snapshot || null,
    });
    return { path: exportTarget, bytes: bytes.byteLength, entry };
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
    //
    // "willReadFrequently" is a performance HINT that Chromium prints when
    // the test reads the canvas pixels back a lot — and reading the pixels
    // back is exactly what this test is for. It is not a defect.
    if (level >= 2
      && !/Security Warning/.test(message)
      && !/willReadFrequently/.test(message)) errors.push(message);
  });
  // An uncaught error in the page — with its stack, so a failure points at
  // the line that threw rather than just at the message.
  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push('render process gone: ' + JSON.stringify(details));
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

    // ---- adjusting the shape ------------------------------------------------
    //
    // The system ships a default shape; the user may drag it (to move it) and
    // drag its corner handles (to scale it proportionally).
    //
    // What is checked here, in order:
    //
    //   1. the shape's box on the canvas, measured from the pixels;
    //   2. a DRAG of the shape moves it — the box shifts;
    //   3. a DRAG of a corner handle scales it — the box grows/shrinks, and
    //      the aspect stays the same (a proportional scale);
    //   4. the reset button puts it back where it started.
    //
    // The pixels are the only trustworthy witness here: a transform that
    // only moved some internal state would leave the drawing untouched, and
    // a test that looked at the state would happily call that a pass.
    const box0 = await shapeBox(win);
    report.shapeBox0 = box0;

    // The canvas' CSS pixels per canvas pixel — the gesture works in CSS
    // pixels (the page reads clientX/clientY).
    const cssScale = box0 ? box0.cssScale : 1;
    // Where to grab the shape: an EMPTY cell inside it.
    //
    // The page moves the shape when you press an empty cell of it, and
    // drags the PHOTO when you press a cell that has one (that is the
    // older feature, and it has to keep working). So the gesture has to
    // start on an empty cell — the test asks the page where one is.
    const aim = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      // The empty cells are the ones with the shape's own fill. Scan the
      // canvas for a pixel of that fill — it is the only thing on the wall
      // that is neither a photo nor white.
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const at = (x, y) => {
        const i = (y * cv.width + x) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      };
      for (let y = 2; y < cv.height - 2; y += 2) {
        for (let x = 2; x < cv.width - 2; x += 2) {
          const [r0, g0, b0] = at(x, y);
          // The shape's fill (#efe9e0) — and it must NOT be a photo.
          if (Math.abs(r0 - 0xef) < 8 && Math.abs(g0 - 0xe9) < 8 && Math.abs(b0 - 0xe0) < 8) {
            return {
              x: (x / cv.width) * r.width,
              y: (y / cv.height) * r.height,
            };
          }
        }
      }
      return null;
    })()`);
    report.shapeGrabPoint = aim;

    // (2) Drag the shape to the right.
    if (aim) {
      await pointerGesture(win, [aim.x, aim.y], [aim.x + 60, aim.y], 6);
      await waitFor(async () => {
        const b = await shapeBox(win);
        return b && b.minX > box0.minX + 10 ? b : null;
      }, 8000);
    }
    const box1 = await shapeBox(win);
    report.shapeBox1 = box1;
    report.shapeMoved = !!(box0 && box1 && box1.minX > box0.minX + 5);

    // (3) Scale it with the bottom-right handle. The handle sits on the
    // corner of the shape's box, so the gesture starts right there.
    const handle = box1 ? {
      x: box1.maxX * cssScale,
      y: box1.maxY * cssScale,
    } : null;
    if (handle) {
      // Pull the handle away from the centre — the shape grows.
      await pointerGesture(win, [handle.x, handle.y], [handle.x + 50, handle.y + 50], 6);
      await waitFor(async () => {
        const b = await shapeBox(win);
        return b && b.maxX > box1.maxX + 10 ? b : null;
      }, 8000);
    }
    const box2 = await shapeBox(win);
    report.shapeBox2 = box2;
    report.shapeScaled = !!(box1 && box2 && box2.maxX > box1.maxX + 5);
    // A proportional scale keeps the shape's own aspect: the width and the
    // height grow by the same factor.
    report.shapeScaleRatio = (box1 && box2 && box1.maxX > box1.minX && box1.maxY > box1.minY)
      ? Number((((box2.maxX - box2.minX) / (box1.maxX - box1.minX))
        / ((box2.maxY - box2.minY) / (box1.maxY - box1.minY))).toFixed(3))
      : null;

    // (4) The reset button puts the shape back.
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-shape-reset-btn").click()');
    await waitFor(async () => {
      const b = await shapeBox(win);
      return b && Math.abs(b.minX - box0.minX) < 4 && Math.abs(b.maxX - box0.maxX) < 4 ? b : null;
    }, 8000);
    const box3 = await shapeBox(win);
    report.shapeBox3 = box3;
    report.shapeReset = !!(box0 && box3
      && Math.abs(box3.minX - box0.minX) < 6 && Math.abs(box3.maxX - box0.maxX) < 6);

    // (5) The shape's centre can be set BY NUMBER.
    //
    // Dragging the shape fights with dragging the photos (both start with a
    // press on the canvas), so the position is also set numerically: type
    // the percentages and the shape goes there. That is the reliable way to
    // place the shape against a background.
    //
    // The check is on the PIXELS: the shape's box has to move the way the
    // numbers said, by the right amount and in the right direction.
    const centreBefore = await shapeCentre(win);
    report.centreBefore = centreBefore;
    await win.webContents.executeJavaScript(`(() => {
      const cx = document.getElementById('wall-shape-cx');
      const cy = document.getElementById('wall-shape-cy');
      if (!cx || !cy) return;
      cx.value = '30';
      cy.value = '40';
      cx.dispatchEvent(new Event('change', { bubbles: true }));
      cy.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const c = await shapeCentre(win);
      return c && c.inputX === 30 && c.inputY === 40 ? c : null;
    }, 8000);
    const centreAfter = await shapeCentre(win);
    report.centreAfter = centreAfter;
    // The page accepted the numbers: its inputs say what was asked for.
    report.centreSet = !!(centreAfter
      && Math.abs(centreAfter.inputX - 30) < 0.01
      && Math.abs(centreAfter.inputY - 40) < 0.01);
    // The numbers in the boxes are the shape's real centre (not the ones
    // that were typed in).
    report.centreInputs = await win.webContents.executeJavaScript(`(() => ({
      cx: document.getElementById('wall-shape-cx') ? document.getElementById('wall-shape-cx').value : null,
      cy: document.getElementById('wall-shape-cy') ? document.getElementById('wall-shape-cy').value : null,
    }))()`);
    // The boxes kept what was asked for — the clamp did NOT pull the shape
    // back to some other place (it only keeps the centre on the canvas).
    report.centreKeptNumbers = !!(report.centreInputs
      && report.centreInputs.cx === '30' && report.centreInputs.cy === '40');
    // And the shape really MOVED on the canvas, by the amount the numbers
    // asked for.
    //
    // The centre moved 20% of the canvas to the left, so the shape's RIGHT
    // edge — the part of it that is not hanging off the canvas — moved 20%
    // to the left too.
    report.centreMovedShape = !!(centreBefore && centreAfter
      && Math.abs((centreBefore.rightEdge - centreAfter.rightEdge) - 20) < 1.5);
    // The shape went UP too: 40% instead of 50% means the whole shape is
    // 10% higher. The BOTTOM edge is the one to measure — the top of the
    // shape hangs off the canvas here, and a clipped edge cannot show the
    // movement.
    report.centreMovedUp = !!(centreBefore && centreAfter
      && Math.abs((centreBefore.bottomEdge - centreAfter.bottomEdge) - 10) < 1.5);
    // The shape's SIZE did not change (only its place did).
    //
    // The shape hangs off the canvas on the left and the top at 30/40, so
    // its visible box cannot be measured there. Nudge it to 55/45 — where
    // it is entirely on the canvas — and compare with the box it had at
    // 50/50 (also entirely on the canvas). Both are unclipped, so the
    // comparison is a real measurement of the shape's size.
    await win.webContents.executeJavaScript(`(() => {
      const cx = document.getElementById('wall-shape-cx');
      const cy = document.getElementById('wall-shape-cy');
      if (!cx || !cy) return;
      cx.value = '55';
      cy.value = '45';
      cx.dispatchEvent(new Event('change', { bubbles: true }));
      cy.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const c = await shapeCentre(win);
      return c && c.inputX === 55 && c.inputY === 45 ? c : null;
    }, 8000);
    const sizeAfter = await shapeBox(win);
    report.shapeBox4 = sizeAfter;
    // box3 is the shape's box at 50/50 — the reference for the size.
    report.centreKeptSize = !!(box3 && sizeAfter
      && Math.abs((sizeAfter.maxY - sizeAfter.minY) - (box3.maxY - box3.minY)) < 8
      && Math.abs((sizeAfter.maxX - sizeAfter.minX) - (box3.maxX - box3.minX)) < 8);
    // And it really did move 5% to the right and 5% up.
    //
    // The box is in CANVAS pixels, so 5% of the canvas is 5% of the box's
    // width (horizontal) and height (vertical).
    report.centreNudged = !!(box3 && sizeAfter
      && Math.abs((sizeAfter.maxX - box3.maxX) - box3.width * 0.05) < 4
      && Math.abs((box3.maxY - sizeAfter.maxY) - box3.height * 0.05) < 4);

    // Putting it back to the middle.
    await win.webContents.executeJavaScript(`(() => {
      const cx = document.getElementById('wall-shape-cx');
      const cy = document.getElementById('wall-shape-cy');
      if (!cx || !cy) return;
      cx.value = '50';
      cy.value = '50';
      cx.dispatchEvent(new Event('change', { bubbles: true }));
      cy.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const c = await shapeCentre(win);
      return c && c.inputX === 50 && c.inputY === 50 ? c : null;
    }, 8000);
    const centreBack = await shapeCentre(win);
    report.centreBack = centreBack;
    report.centreRestored = !!(centreBack
      && Math.abs(centreBack.inputX - 50) < 0.01
      && Math.abs(centreBack.inputY - 50) < 0.01
      && Math.abs(centreBack.rightEdge - centreBefore.rightEdge) < 1.5);
    // The boxes show the shape's real centre after the restore.
    report.centreInputsAfter = await win.webContents.executeJavaScript(`(() => ({
      cx: document.getElementById('wall-shape-cx') ? document.getElementById('wall-shape-cx').value : null,
      cy: document.getElementById('wall-shape-cy') ? document.getElementById('wall-shape-cy').value : null,
    }))()`);

    // (5) The two gestures must not fight each other.
    //
    // The shape moves when you press an EMPTY cell of it, and a PHOTO is
    // dragged when you press a cell that has one. Adding the shape's
    // gestures must not have broken the photo drag that was there before.
    //
    // So: find a cell that has a photo, drag it to another cell, and check
    // that the photo changed places — and that the shape did NOT move.
    report.photoDrag = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      // The cells with a photo are the red ones.
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const isRed = (x, y) => {
        const i = (y * cv.width + x) * 4;
        return d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90;
      };
      const find = (want) => {
        for (let y = 4; y < cv.height - 4; y += 3) {
          for (let x = 4; x < cv.width - 4; x += 3) {
            if (isRed(x, y) === want) return { x, y };
          }
        }
        return null;
      };
      const src = find(true);
      const dst = find(false);
      if (!src || !dst) return { skipped: true };
      const toCss = (p) => ({
        x: (p.x / cv.width) * r.width,
        y: (p.y / cv.height) * r.height,
      });
      return { src: toCss(src), dst: toCss(dst) };
    })()`);

    if (report.photoDrag && !report.photoDrag.skipped) {
      // The shape's box BEFORE the photo drag — the reference for "the photo
      // drag did not move the shape".
      const beforeDrag = await shapeBox(win);
      // The HTML5 drag-and-drop is driven by the browser's own drag events,
      // so this one is a DataTransfer-based gesture, not a pointer one.
      await win.webContents.executeJavaScript(`(() => {
        const cv = document.getElementById('wall-canvas');
        const r = cv.getBoundingClientRect();
        const src = ${JSON.stringify(report.photoDrag.src)};
        const dst = ${JSON.stringify(report.photoDrag.dst)};
        const dt = new DataTransfer();
        const fire = (type, x, y) => {
          const ev = new DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: r.left + x, clientY: r.top + y,
          });
          cv.dispatchEvent(ev);
        };
        fire('dragstart', src.x, src.y);
        fire('dragover', dst.x, dst.y);
        fire('drop', dst.x, dst.y);
        fire('dragend', dst.x, dst.y);
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      // The shape stayed put, and the red area moved towards the target.
      const afterDrag = await shapeBox(win);
      report.photoDragKeptShape = !!(afterDrag && beforeDrag
        && Math.abs(afterDrag.minX - beforeDrag.minX) < 6
        && Math.abs(afterDrag.maxX - beforeDrag.maxX) < 6);
      const moved = await win.webContents.executeJavaScript(`(() => {
        const cv = document.getElementById('wall-canvas');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let red = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
        }
        return red;
      })()`);
      report.photoDragRed = moved;
      report.photoDragWorked = moved > 0;
    }

    // The scale slider and the percentage next to it follow the transform.
    report.scaleUi = await win.webContents.executeJavaScript(`(() => ({
      value: document.getElementById('wall-scale') ? document.getElementById('wall-scale').value : null,
      label: document.getElementById('wall-scale-value')
        ? document.getElementById('wall-scale-value').textContent : null,
    }))()`);

    // The wall must still be a wall: the shape's fill is there, the photos
    // are on it, and the corner outside the shape is still white.
    report.afterAdjust = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let red = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total += 1;
        if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
      }
      return {
        redRatio: Number((total ? red / total : 0).toFixed(4)),
        corner: [d[0], d[1], d[2]],
      };
    })()`);

    // ---- the export carries the adjustment ----------------------------------
    //
    // The editor's canvas and the exported PNG are drawn by the same code —
    // but only if the adjustment is part of the geometry both of them use.
    // A transform that stayed in the page's state would leave the exported
    // PNG with the OLD shape, and the user would get a wall they never
    // designed.
    //
    // So: shrink the shape with the slider, export, and compare WHERE the
    // shape sits in the PNG with where it sits on the screen. Both are
    // measured from the pixels, and both are given as a share of their own
    // canvas — the two canvases have different sizes.
    await win.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('wall-scale');
      if (!r) return;
      r.value = '70';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const v = await win.webContents.executeJavaScript(
        'document.getElementById("wall-scale-value").textContent');
      return v === '70%' ? v : null;
    }, 8000);
    const shrunkBox = await shapeBox(win);
    report.shrunkBox = shrunkBox;
    // Where the shape sits on the screen, as a share of the canvas — the
    // same measure the exported PNG gets, so the two can be compared.
    report.shrunkScreenBox = shrunkBox ? {
      left: Number((shrunkBox.minX / shrunkBox.width).toFixed(4)),
      right: Number(((shrunkBox.width - 1 - shrunkBox.maxX) / shrunkBox.width).toFixed(4)),
      top: Number((shrunkBox.minY / shrunkBox.height).toFixed(4)),
      bottom: Number(((shrunkBox.height - 1 - shrunkBox.maxY) / shrunkBox.height).toFixed(4)),
    } : null;

    const adjustedOut = path.join(tmp, 'wall-adjusted.png');
    const savedTarget = exportTarget;
    exportTarget = adjustedOut;
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-export-btn").click()');
    const adjustedWritten = await waitFor(
      () => (fs.existsSync(adjustedOut) && fs.statSync(adjustedOut).size > 0 ? adjustedOut : null),
      30000);
    exportTarget = savedTarget;
    report.adjustedExported = !!adjustedWritten;
    if (adjustedWritten) {
      const adjDataUrl = 'data:image/png;base64,'
        + fs.readFileSync(adjustedOut).toString('base64');
      report.adjustedPng = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(adjDataUrl)};
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        // The shape is everything that is not white.
        let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
        let red = 0;
        for (let y = 0; y < cv.height; y += 1) {
          for (let x = 0; x < cv.width; x += 1) {
            const i = (y * cv.width + x) * 4;
            if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
            if (d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        const r4 = (n) => Number(n.toFixed(4));
        return {
          width: cv.width,
          height: cv.height,
          redRatio: r4(red / (cv.width * cv.height)),
          // Where the shape sits, as a share of the canvas — the same way
          // the screen's box is measured, so the two can be compared.
          box: {
            left: r4(minX / cv.width),
            right: r4((cv.width - 1 - maxX) / cv.width),
            top: r4(minY / cv.height),
            bottom: r4((cv.height - 1 - maxY) / cv.height),
          },
        };
      })()`);
    }

    // Put the shape back to normal before the rest of the test.
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-shape-reset-btn").click()');

    // ---- the background ----------------------------------------------------
    //
    // The background art lives in `resources/photo_wall_background/<宽-高>/`
    // — one folder per canvas ratio. The wall's canvas ratio decides which
    // folder is used, and the wall is painted ON TOP of it, opaquely.
    //
    // The pictures of this test are 4:3 and 3:4 — neither of those ratios
    // ships art yet, so the ratio is switched to 1:1 (which does) to
    // exercise the feature. A ratio WITHOUT art has to fall back to "no
    // background" — that is checked here too, before the switch.
    report.bgPickerNoArt = await win.webContents.executeJavaScript(`(() => {
      const sel = document.getElementById('wall-bg');
      if (!sel) return null;
      return {
        options: Array.from(sel.options).map((o) => o.value),
        note: document.getElementById('wall-bg-note')
          ? document.getElementById('wall-bg-note').textContent : '',
        ratio: document.getElementById('wall-ratio')
          ? document.getElementById('wall-ratio').value : '',
      };
    })()`);

    // The background is exercised after the first export (so that export
    // stays the clean baseline for the shape's margins) — see below.

    // (6) The drag works on a WIDE canvas too.
    //
    // The canvas' screen pixels are square, but the template's coordinates
    // are not (its width is the ratio, its height is 1). So the pointer's
    // position has to be converted on each axis separately — get that
    // wrong and the shape cannot be grabbed at all on a 16:9 canvas,
    // while it works fine on a square one.
    //
    // So: switch to 16:9, grab the shape, drag it, and check it moved.
    await win.webContents.executeJavaScript(`(() => {
      const ratio = document.getElementById('wall-ratio');
      if (!ratio) return;
      ratio.value = '16:9';
      ratio.dispatchEvent(new Event('change'));
    })()`);
    await waitFor(async () => {
      const v = await win.webContents.executeJavaScript(
        'document.getElementById("wall-ratio").value');
      return v === '16:9' ? v : null;
    }, 8000);
    await new Promise((r) => setTimeout(r, 600));

    const wideBox0 = await shapeBox(win);
    // An empty spot inside the shape, in CSS pixels.
    const wideAim = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let y = 2; y < cv.height - 2; y += 2) {
        for (let x = 2; x < cv.width - 2; x += 2) {
          const i = (y * cv.width + x) * 4;
          if (Math.abs(d[i] - 0xef) < 8 && Math.abs(d[i + 1] - 0xe9) < 8 && Math.abs(d[i + 2] - 0xe0) < 8) {
            return { x: (x / cv.width) * r.width, y: (y / cv.height) * r.height };
          }
        }
      }
      return null;
    })()`);
    report.wideAim = wideAim;
    if (wideAim) {
      await pointerGesture(win, [wideAim.x, wideAim.y], [wideAim.x + 70, wideAim.y], 6);
      await waitFor(async () => {
        const b = await shapeBox(win);
        return b && wideBox0 && b.minX > wideBox0.minX + 10 ? b : null;
      }, 8000);
    }
    const wideBox1 = await shapeBox(win);
    report.wideBox0 = wideBox0;
    report.wideBox1 = wideBox1;
    report.wideDragMoved = !!(wideBox0 && wideBox1 && wideBox1.minX > wideBox0.minX + 5);

    // Back to a square canvas for the rest of the test, and put the shape
    // back where it started — the drag above moved it, and the export that
    // follows measures the shape's margin from the canvas' edges.
    await win.webContents.executeJavaScript(`(() => {
      const ratio = document.getElementById('wall-ratio');
      if (!ratio) return;
      ratio.value = '1:1';
      ratio.dispatchEvent(new Event('change'));
    })()`);
    await waitFor(async () => {
      const v = await win.webContents.executeJavaScript(
        'document.getElementById("wall-ratio").value');
      return v === '1:1' ? v : null;
    }, 8000);
    await new Promise((r) => setTimeout(r, 600));
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-shape-reset-btn").click()');
    await new Promise((r) => setTimeout(r, 400));

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

    // ---- export WITH a background -----------------------------------------
    //
    // The second export carries the background art. This is the check that
    // matters: a canvas painted with a `file://` image is tainted, and
    // `toBlob()` on a tainted canvas throws SecurityError — so an export
    // that comes out at all is proof that the page drew the background
    // from BYTES (createImageBitmap) rather than from a file:// URL.
    //
    // The art is picked by the corner pixel: the corner is outside the
    // shape, so with no background it is white, and with one it is the
    // background's own colour.
    const bgOutPath = path.join(tmp, 'wall-with-bg.png');
    const bgPicked = await win.webContents.executeJavaScript(`(async () => {
      // Switch the canvas to 1:1 — the ratio that ships background art.
      // (The ratio change re-picks the grid and re-renders the page.)
      const ratio = document.getElementById('wall-ratio');
      if (ratio) {
        ratio.value = '1:1';
        ratio.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 800));
      }
      // The picker of the new ratio.
      const picker = document.getElementById('wall-bg');
      if (!picker) return null;
      const opt = Array.from(picker.options).find((o) => o.value);
      if (!opt) return { noArt: true };
      picker.value = opt.value;
      picker.dispatchEvent(new Event('change'));
      // Wait for the page to have the bitmap and to have drawn it.
      const started = Date.now();
      while (Date.now() - started < 20000) {
        await new Promise((r) => setTimeout(r, 120));
        const cv = document.getElementById('wall-canvas');
        if (!cv || !cv.width) continue;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        // White means "no background drawn yet".
        if (d[0] < 250 || d[1] < 250 || d[2] < 250) {
          return {
            id: opt.value,
            corner: [d[0], d[1], d[2]],
            options: Array.from(picker.options).map((o) => o.value),
            note: document.getElementById('wall-bg-note')
              ? document.getElementById('wall-bg-note').textContent : '',
          };
        }
      }
      return { id: opt.value, corner: null };
    })()`);
    report.bgPicked = bgPicked;

    // The wall sits ON TOP of the background and is opaque: the middle of
    // the canvas is the shape's own colour, never the background's.
    report.bgUnderShape = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      if (!cv) return null;
      const ctx = cv.getContext('2d');
      const mid = ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
      return { centre: [mid[0], mid[1], mid[2]] };
    })()`);

    if (bgPicked && bgPicked.corner) {
      exportTarget = bgOutPath;
      await win.webContents.executeJavaScript(
        'document.getElementById("wall-export-btn").click()');
      const bgWritten = await waitFor(
        () => (fs.existsSync(bgOutPath) && fs.statSync(bgOutPath).size > 0 ? bgOutPath : null),
        30000);
      report.bgExported = !!bgWritten;
      if (bgWritten) {
        // Read the exported PNG back and look at its corner: the art has to
        // be in the file, not just on the screen.
        const bgDataUrl = 'data:image/png;base64,'
          + fs.readFileSync(bgOutPath).toString('base64');
        report.bgPng = await win.webContents.executeJavaScript(`(async () => {
          const img = new Image();
          img.src = ${JSON.stringify(bgDataUrl)};
          await img.decode();
          const cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
          const corner = [d[0], d[1], d[2]];
          const mid = ctx.getImageData(
            Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
          let red = 0, total = 0;
          for (let i = 0; i < d.length; i += 4) {
            total += 1;
            if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
          }
          const r4 = (n) => Number(n.toFixed(4));
          return {
            width: img.naturalWidth,
            height: img.naturalHeight,
            corner: corner,
            centre: [mid[0], mid[1], mid[2]],
            redRatio: r4(total ? red / total : 0),
            bytes: ${JSON.stringify(fs.statSync(bgOutPath).size)},
          };
        })()`);
      }
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

    // A second picture: the shape moved off the centre and shrunk, so the
    // adjustment can be LOOKED at and not only measured.
    try {
      await win.webContents.executeJavaScript(`(() => {
        const cx = document.getElementById('wall-shape-cx');
        const cy = document.getElementById('wall-shape-cy');
        const scale = document.getElementById('wall-scale');
        if (cx) { cx.value = '38'; cx.dispatchEvent(new Event('change', { bubbles: true })); }
        if (cy) { cy.value = '42'; cy.dispatchEvent(new Event('change', { bubbles: true })); }
        if (scale) { scale.value = '75'; scale.dispatchEvent(new Event('input', { bubbles: true })); }
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      const shot2 = await win.webContents.capturePage();
      const shotPath2 = path.join(tmp, 'wall-adjusted-page.png');
      fs.writeFileSync(shotPath2, shot2.toPNG());
      report.screenshotAdjusted = shotPath2;
      // Put it back.
      await win.webContents.executeJavaScript(
        'document.getElementById("wall-shape-reset-btn").click()');
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      report.screenshotAdjustedError = String(e && e.message);
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

    // ---- the edits survive leaving the page --------------------------------
    //
    // The whole point of the state saving: the user edits the wall (moves the
    // shape, picks a grid, swaps two photos, changes a cover), goes to another
    // page, and comes back. The wall must be AS IT WAS — not back at the
    // default.
    //
    // The check is on the WALL, not on the page's inputs: the inputs could
    // show numbers while the canvas shows something else. So the shape's
    // position and size are measured from the PIXELS, exactly like the rest
    // of this test does.
    const ids = events.map((e) => e.id);
    const wallUrl = '#/photo-wall?ids=' + ids.join(',');

    // Wait until the wall page is mounted and has drawn.
    //
    // The check is the wall's own note (it says "正在读取照片…" while the
    // photos are loading) — NOT the canvas' width: the canvas of the
    // PREVIOUS visit is still in the DOM for a moment, so a width check
    // would pass before the new page had even started.
    const waitForWall = async () => {
      const n = await waitFor(async () => {
        const s = await win.webContents.executeJavaScript(`(() => {
          const cv = document.getElementById('wall-canvas');
          const note = document.getElementById('wall-template-note');
          if (!cv || !cv.width) return 0;
          if (note && note.textContent.includes('正在读取')) return 0;
          return cv.width;
        })()`);
        return s > 0 ? s : null;
      }, 20000);
      return n;
    };

    // Edit the wall: a grid of its own, the shape moved and scaled.
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(wallUrl)}`);
    await waitForWall();

    await win.webContents.executeJavaScript(`(() => {
      const size = document.getElementById('wall-size');
      const cx = document.getElementById('wall-shape-cx');
      const cy = document.getElementById('wall-shape-cy');
      const scale = document.getElementById('wall-scale');
      if (size) { size.value = 'g9'; size.dispatchEvent(new Event('change', { bubbles: true })); }
      if (cx) { cx.value = '44'; cx.dispatchEvent(new Event('change', { bubbles: true })); }
      if (cy) { cy.value = '46'; cy.dispatchEvent(new Event('change', { bubbles: true })); }
      if (scale) { scale.value = '85'; scale.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`);
    await new Promise((r) => setTimeout(r, 1200));

    // The shape's box on the canvas, measured from the pixels — the
    // reference for "the wall came back the same".
    const editedBox = await shapeBox(win);
    report.editedBox = editedBox;
    report.editedUi = await win.webContents.executeJavaScript(`(() => ({
      size: document.getElementById('wall-size') ? document.getElementById('wall-size').value : null,
      cx: document.getElementById('wall-shape-cx') ? document.getElementById('wall-shape-cx').value : null,
      cy: document.getElementById('wall-shape-cy') ? document.getElementById('wall-shape-cy').value : null,
      scale: document.getElementById('wall-scale') ? document.getElementById('wall-scale').value : null,
    }))()`);
    // The photos on the wall, in the order the cells hold them — the
    // reference for "the photos are where they were".
    report.editedCells = await win.webContents.executeJavaScript(`(() => {
      // The page keeps its cells in the module's state; read them through the
      // canvas' pixels instead: the red pixels are the photos, in cell order.
      const cv = document.getElementById('wall-canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
      }
      return { red };
    })()`);

    // Leave the page — to another page, exactly like the user's "go to the
    // tools page and come back".
    await win.webContents.executeJavaScript(`location.hash = '#/elsewhere'`);
    await new Promise((r) => setTimeout(r, 700));

    // Come back.
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(wallUrl)}`);
    await waitForWall();
    await new Promise((r) => setTimeout(r, 900));

    // The wall came back the way it was.
    const restoredBox = await shapeBox(win);
    report.restoredBox = restoredBox;
    report.restoredUi = await win.webContents.executeJavaScript(`(() => ({
      size: document.getElementById('wall-size') ? document.getElementById('wall-size').value : null,
      cx: document.getElementById('wall-shape-cx') ? document.getElementById('wall-shape-cx').value : null,
      cy: document.getElementById('wall-shape-cy') ? document.getElementById('wall-shape-cy').value : null,
      scale: document.getElementById('wall-scale') ? document.getElementById('wall-scale').value : null,
      restoredNote: document.getElementById('wall-restored-note')
        ? document.getElementById('wall-restored-note').textContent : '',
    }))()`);
    report.restoredCells = await win.webContents.executeJavaScript(`(() => {
      const cv = document.getElementById('wall-canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
      }
      return { red };
    })()`);
    // The grid is the one that was picked (g9), the shape is where it was put
    // (44 / 46) and the size it was given (85%).
    report.stateRestoredUi = !!(report.restoredUi
      && report.restoredUi.size === 'g9'
      && report.restoredUi.cx === '44'
      && report.restoredUi.cy === '46'
      && report.restoredUi.scale === '85');
    // And the shape really is where it was — measured from the pixels.
    report.stateRestoredPixels = !!(editedBox && restoredBox
      && Math.abs(restoredBox.minX - editedBox.minX) < 6
      && Math.abs(restoredBox.maxX - editedBox.maxX) < 6
      && Math.abs(restoredBox.minY - editedBox.minY) < 6
      && Math.abs(restoredBox.maxY - editedBox.maxY) < 6);
    // The photos are still on the wall (not an empty wall).
    report.stateRestoredPhotos = !!(report.restoredCells && report.restoredCells.red > 0);

    // ---- the export history ------------------------------------------------
    //
    // Every export is recorded, with the wall as it was at that moment — so
    // the user can export the same arrangement again.
    report.historyBefore = await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('wall-history');
      return box ? box.querySelectorAll('.wall-history-item').length : -1;
    })()`);
    // Export once more — this one lands in the history.
    const histOut = path.join(tmp, 'wall-history-entry.png');
    exportTarget = histOut;
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-export-btn").click()');
    const histWritten = await waitFor(
      () => (fs.existsSync(histOut) && fs.statSync(histOut).size > 0 ? histOut : null),
      30000);
    exportTarget = outPath;
    report.historyExported = !!histWritten;
    await new Promise((r) => setTimeout(r, 800));
    report.historyAfter = await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('wall-history');
      const items = box ? box.querySelectorAll('.wall-history-item') : [];
      return {
        count: items.length,
        first: items.length ? items[0].textContent.replace(/\\s+/g, ' ').trim() : '',
        hasLoad: !!(items[0] && items[0].querySelector('[data-history-act="load"]')),
        hasRemove: !!(items[0] && items[0].querySelector('[data-history-act="remove"]')),
      };
    })()`);
    // The export carried the wall's state along, so the history can restore
    // that arrangement.
    report.exportMeta = exportMetas.length ? exportMetas[exportMetas.length - 1] : null;
    report.exportMetaHasSnapshot = !!(report.exportMeta
      && report.exportMeta.snapshot
      && Array.isArray(report.exportMeta.snapshot.cells));
    report.exportMetaHasSize = !!(report.exportMeta && report.exportMeta.sizeId === 'g9');

    // ---- 「载入编辑」：把那一版摆回墙上，接着改 --------------------------
    //
    // 这才是用户要的：从历史里挑一版，**当底稿继续改**，改完再导出。
    //
    // 先把墙上的摆法改成**另一版**（不然载入回来的就是同一版，看不出是
    // 不是真的换了），再从历史里载入之前那一版。
    await win.webContents.executeJavaScript(`(() => {
      const scale = document.getElementById('wall-scale');
      if (scale) { scale.value = '60'; scale.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    report.beforeLoadScale = await win.webContents.executeJavaScript(
      'document.getElementById("wall-scale").value');

    // 载入历史里的那一版（前面导出的那次 —— 缩放 85%）。
    report.loadResult = await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('[data-history-act="load"]');
      if (!btn) return { skipped: true };
      btn.click();
      return { clicked: true };
    })()`);
    await new Promise((r) => setTimeout(r, 1000));
    report.loadedUi = await win.webContents.executeJavaScript(`(() => ({
      size: document.getElementById('wall-size') ? document.getElementById('wall-size').value : null,
      cx: document.getElementById('wall-shape-cx') ? document.getElementById('wall-shape-cx').value : null,
      scale: document.getElementById('wall-scale') ? document.getElementById('wall-scale').value : null,
      // 界面上标着「墙上就是这一版」。
      badge: !!(document.querySelector('.wall-history-badge')),
      loadedRow: !!document.querySelector('.wall-history-item-loaded'),
      // 载入了以后，那个按钮变成「撤销载入」。
      hasUnload: !!document.querySelector('[data-history-act="unload"]'),
    }))()`);
    // 那一版真的摆回来了（形状回到 85%，网格还是 g9）。
    report.loadWorked = !!(report.loadedUi
      && report.loadedUi.size === 'g9'
      && report.loadedUi.cx === '44'
      && report.loadedUi.scale === '85');
    report.loadMarked = !!(report.loadedUi
      && report.loadedUi.badge && report.loadedUi.loadedRow && report.loadedUi.hasUnload);

    // ---- 载入之后还能接着改，改完还能导出 --------------------------------
    //
    // 这是用户要的核心：载入不是终点，载入之后就是**可编辑的底稿**。
    report.editAfterLoad = await win.webContents.executeJavaScript(`(() => {
      const cx = document.getElementById('wall-shape-cx');
      if (!cx) return { skipped: true };
      cx.value = '62';
      cx.dispatchEvent(new Event('change', { bubbles: true }));
      return { edited: true };
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    report.editedAfterLoadUi = await win.webContents.executeJavaScript(`(() => ({
      cx: document.getElementById('wall-shape-cx') ? document.getElementById('wall-shape-cx').value : null,
      scale: document.getElementById('wall-scale') ? document.getElementById('wall-scale').value : null,
      // 改过之后，标记还在 —— 但写的是「正在改这一版」（不再是「已载入这一版」）。
      badge: document.querySelector('.wall-history-badge')
        ? document.querySelector('.wall-history-badge').textContent : '',
      // 「撤销载入」还在 —— 随时能回到载入前那一版。
      hasUnload: !!document.querySelector('[data-history-act="unload"]'),
    }))()`);
    report.editAfterLoadWorked = !!(report.editedAfterLoadUi
      && report.editedAfterLoadUi.cx === '62'
      && report.editedAfterLoadUi.scale === '85');
    report.editAfterLoadKeepsDraft = !!(report.editedAfterLoadUi
      && report.editedAfterLoadUi.badge.indexOf('正在改') >= 0
      && report.editedAfterLoadUi.hasUnload);

    // 改完再导出一次 —— 导出的是**改过之后**的那一版。
    const editedOut = path.join(tmp, 'wall-edited-after-load.png');
    const savedExportTarget = exportTarget;
    exportTarget = editedOut;
    await win.webContents.executeJavaScript(
      'document.getElementById("wall-export-btn").click()');
    const editedWritten = await waitFor(
      () => (fs.existsSync(editedOut) && fs.statSync(editedOut).size > 0 ? editedOut : null),
      30000);
    exportTarget = savedExportTarget;
    report.exportAfterLoad = !!editedWritten;
    // 导出的那一次带的是**改过之后**的状态（中心 62，不是载入时的 44）。
    const lastMeta = exportMetas.length ? exportMetas[exportMetas.length - 1] : null;
    report.exportAfterLoadMeta = lastMeta
      && lastMeta.snapshot
      && lastMeta.snapshot.transform
      ? Number(lastMeta.snapshot.transform.dx) : null;
    report.exportAfterLoadHasEdits = !!(
      lastMeta && lastMeta.snapshot && lastMeta.snapshot.cells
      && Array.isArray(lastMeta.snapshot.cells)
    );
    await new Promise((r) => setTimeout(r, 800));

    // ---- 「撤销载入」：回到载入之前那一版 ---------------------------------
    //
    // 载入**不能**把用户原来摆的那一版弄丢 —— 载入之前摆的是 60%。
    report.unloadResult = await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('[data-history-act="unload"]');
      if (!btn) return { skipped: true };
      btn.click();
      return { clicked: true };
    })()`);
    await new Promise((r) => setTimeout(r, 1000));
    report.unloadedUi = await win.webContents.executeJavaScript(`(() => ({
      scale: document.getElementById('wall-scale') ? document.getElementById('wall-scale').value : null,
      cx: document.getElementById('wall-shape-cx') ? document.getElementById('wall-shape-cx').value : null,
      badge: !!document.querySelector('.wall-history-badge'),
    }))()`);
    // 撤销之后回到的是**载入之前**的那一版（60%，中心 50 —— 载入前摆的
    // 那一版被拍下来了，撤销就是把它摆回去）。
    report.unloadWorked = !!(report.unloadedUi
      && report.unloadedUi.scale === '60'
      && !report.unloadedUi.badge);

    // Removing a history entry takes it off the list.
    report.historyRemove = await win.webContents.executeJavaScript(`(() => {
      const before = document.querySelectorAll('.wall-history-item').length;
      const btn = document.querySelector('[data-history-act="remove"]');
      if (!btn) return { skipped: true };
      btn.click();
      return { before };
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    report.historyCountAfterRemove = await win.webContents.executeJavaScript(
      'document.querySelectorAll(".wall-history-item").length');

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
      // The shape can be adjusted: dragged (it moves), scaled by its
      // corner handle (it grows, and it grows PROPORTIONALLY — the width
      // and the height grow by the same factor), and put back with the
      // reset button. The wall still looks like a wall afterwards.
      && report.shapeMoved
      && report.shapeScaled
      && report.shapeScaleRatio && report.shapeScaleRatio > 0.9
      && report.shapeScaleRatio < 1.1
      && report.shapeReset
      // The shape's centre can be set by NUMBER: the shape goes where the
      // numbers say (both the page's inputs and the drawn pixels agree),
      // and it moves the right way on the canvas.
      && report.centreSet
      && report.centreKeptNumbers
      && report.centreMovedShape
      && report.centreKeptSize
      && report.centreNudged
      && report.centreMovedUp
      && report.centreRestored
      && report.centreInputsAfter && report.centreInputsAfter.cx === '50'
      && report.centreInputsAfter && report.centreInputsAfter.cy === '50'
      // The drag works on a wide canvas as well — the pointer's position
      // has to be converted on each axis separately.
      && report.wideDragMoved
      // The photo drag still works, and it does NOT drag the shape along.
      && report.photoDrag && !report.photoDrag.skipped
      && report.photoDragWorked
      && report.photoDragKeptShape
      && report.scaleUi && report.scaleUi.value === '100'
      && report.scaleUi && report.scaleUi.label === '100%'
      && report.afterAdjust && report.afterAdjust.redRatio > 0.05
      && report.afterAdjust && report.afterAdjust.corner[0] > 200
      // The exported PNG carries the adjustment too: the shape sits in the
      // same place in the PNG as it does on the screen (both measured as a
      // share of their own canvas), and it is SMALLER than the default one
      // (the slider was at 70%).
      && report.adjustedExported
      && report.adjustedPng && report.adjustedPng.redRatio > 0.02
      && report.shrunkScreenBox && report.adjustedPng
      && Math.abs(report.adjustedPng.box.left - report.shrunkScreenBox.left) < 0.02
      && Math.abs(report.adjustedPng.box.right - report.shrunkScreenBox.right) < 0.02
      && Math.abs(report.adjustedPng.box.top - report.shrunkScreenBox.top) < 0.02
      && Math.abs(report.adjustedPng.box.bottom - report.shrunkScreenBox.bottom) < 0.02
      // A shape shrunk to 70% keeps a bigger margin than the default one
      // (the default leaves 5%).
      && report.adjustedPng.box.top > 0.05
      && report.adjustedPng.box.bottom > 0.05
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
      // The background: a ratio WITHOUT art falls back to "no background"
      // (the picker offers nothing else), the ratio WITH art offers its
      // pictures, picking one paints it in the corner (outside the shape),
      // the wall stays opaque on top of it, and the art survives into the
      // exported PNG.
      && report.bgPickerNoArt && report.bgPickerNoArt.options.length === 1
      && report.bgPickerNoArt.options[0] === ''
      && report.bgPicked && report.bgPicked.corner
      && report.bgPicked.options && report.bgPicked.options.length >= 2
      && report.bgPicked.options[0] === ''
      && report.bgPicked.corner[0] < 250
      && report.bgUnderShape && report.bgUnderShape.centre
      && report.bgExported
      && report.bgPng && report.bgPng.corner[0] < 250
      && report.bgPng && report.bgPng.redRatio > 0.01
      // The edits survive leaving the page: the grid, the shape's place and
      // its size all come back, and the wall really is drawn the same way
      // (measured from the pixels, not from the inputs).
      && report.stateRestoredUi
      && report.stateRestoredPixels
      && report.stateRestoredPhotos
      // The export history: the export is recorded, the entry carries the
      // wall's state along, and the entry can be LOADED onto the wall.
      && report.historyExported
      && report.historyAfter && report.historyAfter.count >= 1
      && report.historyAfter.hasLoad
      && report.historyAfter.hasRemove
      && report.exportMetaHasSnapshot
      && report.exportMetaHasSize
      // 「载入编辑」puts that version back on the wall and MARKS it as the
      // one on the wall.
      && report.loadWorked
      && report.loadMarked
      // And it is a DRAFT: the user can go on editing it, and what they
      // export afterwards is the edited version.
      && report.editAfterLoadWorked
      && report.editAfterLoadKeepsDraft
      && report.exportAfterLoad
      && report.exportAfterLoadHasEdits
      // Loading did NOT throw away what was on the wall before — 「撤销载入」
      // brings it back.
      && report.unloadWorked
      && report.historyRemove && !report.historyRemove.skipped
      && report.historyCountAfterRemove < report.historyRemove.before
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
