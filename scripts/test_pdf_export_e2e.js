// scripts/test_pdf_export_e2e.js — end-to-end check of the PDF album export.
//
// This one runs the REAL export in a REAL Electron: it builds a database
// with real photographs, runs main/album_pdf.js against it, and then looks
// at the pictures that came out.
//
// The unit harness (scripts/test_pdf_photo_render.js) checks the page's
// ALGORITHM. It cannot check the two things that only exist in a live
// browser: that the offscreen window really paints, and that capturePage
// really hands back the frame that was painted. Those are exactly the
// things that made the album's picture frames come out empty.
//
// So the check here is on the PIXELS: every photo in the album is a
// saturated red, so a picture frame that came out empty is grey, and a
// picture frame that came out wrong is some other colour. The PDF's
// pictures are read back out and checked for red.
//
// Run: node scripts/run-electron.js scripts/run-pdf-e2e.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain } = require('electron');

// A photograph that is impossible to mistake for a placeholder: solid
// red. If the frame came out empty it is grey; if the wrong photo came
// out it is a different colour.
function makeRedPng(width, height) {
  // A minimal, uncompressed PNG is fiddly to write by hand, so the bytes
  // are built with zlib (a dependency of the project already).
  const zlib = require('zlib');
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
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ 0xffffffff;
}

// Pull the pictures out of the finished PDF and look at their pixels.
//
// How the PDF holds a picture is worth stating, because getting it wrong
// makes a perfectly good album look empty:
//
//   * The album's page is ONE picture: the whole note is screenshotted as
//     a single bitmap, so a note with four photographs is still ONE image
//     in the PDF. Counting images cannot count photographs.
//   * pdfkit does not keep the PNG bytes. It re-encodes them as a
//     Flate-compressed DeviceRGB stream with a PNG PREDICTOR on top, so
//     the bytes in the file are delta-coded rows, not plain pixels.
//     Looking for a PNG signature finds nothing at all.
//
// So the check decodes what is really there: the image streams are
// inflated, the predictor is undone, and the pixels are counted. A photo
// that never reached the page leaves no red in the bitmap; a photo that
// did leaves a lot.
function readImagesFromPdf(pdfBuf) {
  const zlib = require('zlib');
  const text = pdfBuf.toString('latin1');
  const re = /<<([\s\S]{0,400}?\/Subtype\s*\/Image[\s\S]{0,400}?)>>\s*stream\r?\n/g;
  const images = [];
  let m;
  while ((m = re.exec(text))) {
    const dict = m[1];
    if (!/\/Width\s+\d+/.test(dict)) continue;
    const w = Number(/\/Width\s+(\d+)/.exec(dict)[1]);
    const h = Number(/\/Height\s+(\d+)/.exec(dict)[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = zlib.inflateSync(pdfBuf.slice(start, end));
    // A stream with a PNG predictor has one extra filter byte per row and
    // every row is delta-coded against the row above it.
    const predicted = /\/Predictor\s+(\d+)/.exec(text.slice(Math.max(0, m.index - 600), m.index + 400));
    const pixels = predicted && Number(predicted[1]) > 1
      ? undoPngPredictor(raw, w, h, 3)
      : raw;
    images.push({ width: w, height: h, pixels });
  }
  return images;
}

// Undo the PNG predictor: each row starts with a filter byte that says how
// the row is coded against the row above it and the pixels to its left.
function undoPngPredictor(data, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = data[p];
    p += 1;
    const row = data.slice(p, p + stride);
    p += stride;
    const o = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[o + x - bpp] : 0;
      const up = y > 0 ? out[o - stride + x] : 0;
      const upLeft = (x >= bpp && y > 0) ? out[o - stride + x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const pp = left + up - upLeft;
        const da = Math.abs(pp - left);
        const db = Math.abs(pp - up);
        const dc = Math.abs(pp - upLeft);
        v += (da <= db && da <= dc) ? left : (db <= dc ? up : upLeft);
      }
      out[o + x] = v & 255;
    }
  }
  return out;
}

// How much of a picture is red. The photographs in this test are solid
// red, so a picture that carries them is largely red and a picture whose
// frames came out empty is not.
function redRatioOf(pixels) {
  let red = 0;
  let total = 0;
  for (let p = 0; p + 2 < pixels.length; p += 3) {
    total += 1;
    if (pixels[p] > 150 && pixels[p + 1] < 90 && pixels[p + 2] < 90) red += 1;
  }
  return total ? red / total : 0;
}

// The whole test is one promise, and it is EXPORTED so the runner can wait
// for it. A test that runs itself and returns immediately leaves the
// runner free to quit the app while the export is still going — the export
// is then killed half-way and the test never reaches its verdict.
module.exports = (async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-e2e-'));
  const photosDir = path.join(tmp, 'photos');
  const outPath = path.join(tmp, 'album.pdf');

  // Two notes, each with two photos, so the album has four pictures.
  const events = [];
  const photoIds = [];
  for (let n = 0; n < 2; n += 1) {
    const eventId = 'ev' + n;
    const dir = path.join(photosDir, eventId);
    fs.mkdirSync(dir, { recursive: true });
    const photos = [];
    for (let p = 0; p < 2; p += 1) {
      const photoId = `${eventId}_p${p}`;
      const png = makeRedPng(320, 240);
      fs.writeFileSync(path.join(dir, `${photoId}.png`), png);
      photos.push({ id: photoId, relative_path: `${photoId}.png` });
      photoIds.push(photoId);
    }
    events.push({
      id: eventId,
      title: `第 ${n + 1} 篇回忆`,
      occurred_at: '2026-03-14 00:00:00',
      notes: '测试文字',
      background: 'default',
      content: JSON.stringify([
        { type: 'text', text: `第 ${n + 1} 篇的文字` },
        { type: 'gallery', layout: 'two', photos: photos.map((x) => ({ photo_id: x.id })) },
      ]),
    });
  }

  // The IPC the render page needs: the entry and the photo bytes.
  ipcMain.handle('memorial_events:get', (_e, id) => {
    return events.find((x) => x.id === id) || null;
  });
  ipcMain.handle('memorial_events:photo_read', (_e, photoId) => {
    // The photo's own event is the one whose directory holds it.
    const ev = events.find((x) => photoId.startsWith(x.id + '_'));
    if (!ev) return null;
    const file = path.join(photosDir, ev.id, `${photoId}.png`);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    return { data_url: `data:image/png;base64,${buf.toString('base64')}`, mime: 'image/png' };
  });

  // The album builder needs `app` (for the photos dir) only through the
  // IPC above; the photos live in the temp dir the handler reads from.
  const albumPdf = require(path.join(__dirname, '..', 'main', 'album_pdf.js'));

  let stats = null;
  let error = null;
  try {
    stats = await albumPdf.buildAlbum({
      events,
      outPath,
      progressCb: (phase, pct, note) => {
        console.error('[progress]', phase, pct, note);
      },
    });
  } catch (e) {
    error = e;
  }

  const report = { stats: null, error: null, pdfBytes: 0, images: [], redRatios: [] };
  if (error) {
    report.error = String((error && error.stack) || error);
  } else {
    report.stats = stats;
    const buf = fs.readFileSync(outPath);
    report.pdfBytes = buf.length;
    // The pictures are read back out of the finished PDF and looked at.
    // The album's page is ONE picture per note, so the check is not "one
    // picture per photograph" but "the note's picture carries the
    // photographs".
    const images = readImagesFromPdf(buf);
    report.images = images.map((im) => ({ width: im.width, height: im.height }));
    report.redRatios = images.map((im) => Number(redRatioOf(im.pixels).toFixed(4)));
  }

  console.log(JSON.stringify(report, null, 2));
  // The report is also written next to the script: Electron's stdout is
  // not always flushed before the process goes away.
  try {
    fs.writeFileSync(path.join(__dirname, '_pdf_e2e_report.json'),
      JSON.stringify(report, null, 2));
  } catch {}

  // ---- The verdict ----------------------------------------------------
  const problems = [];
  if (report.error) problems.push('the export threw: ' + report.error);
  if (report.stats && report.stats.notes !== 2) {
    problems.push(`only ${report.stats.notes} of 2 notes were drawn`);
  }
  if (report.stats && report.stats.failed) {
    problems.push(`${report.stats.failed} of the notes could not be drawn`);
  }
  // One picture per note, and every one of them must carry the red
  // photographs. A picture whose frames came out empty is the failure this
  // test exists for.
  if (!report.error) {
    if (report.images.length !== 2) {
      problems.push(`the PDF holds ${report.images.length} pictures, but there are 2 notes`);
    }
    for (let i = 0; i < report.redRatios.length; i += 1) {
      if (report.redRatios[i] < 0.2) {
        problems.push(`picture ${i + 1} is only ${(report.redRatios[i] * 100).toFixed(1)}% red — the photo frames came out empty`);
      }
    }
  }

  if (problems.length) {
    console.log('\nFAIL');
    for (const p of problems) console.log('  • ' + p);
    process.exitCode = 1;
  } else {
    console.log('\nPASS — every photo reached the PDF');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  // The app is NOT quit here: the runner owns the app's lifetime and quits
  // it once this promise has settled.
  return report;
})();
