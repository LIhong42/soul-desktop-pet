// main/png_alpha.js — decide whether a PNG already carries transparency.
//
// Why this exists
// ---------------
// The pet zip importer runs every incoming frame through a background
// cutout (`main/png_border_cutout.js`) so a pack that ships flat black
// backdrops lands on the desktop without a square border around the
// character.
//
// That cutout is only meaningful for *opaque* artwork. A pack whose
// frames are already transparent PNGs (the usual way to ship a sprite
// sheet) has nothing to cut away: the backdrop is already gone. Running
// the cutout on such a frame is not just wasted work — it is actively
// harmful, because the algorithm estimates the "backdrop colour" from
// the image perimeter. On a transparent frame the perimeter is mostly
// alpha-0 pixels whose RGB is undefined/zero, so the estimate lands on
// black, and the flood then starts eating the character's own dark
// pixels from the edges inward.
//
// So the importer asks this module first: "is this frame already
// transparent?" If yes, the frame is passed through untouched.
//
// How the check works
// -------------------
// The PNG format stores the pixel format in the IHDR chunk:
//
//   offset 24 : bit depth      (1/2/4/8/16)
//   offset 25 : colour type    (0=grey, 2=RGB, 3=palette, 4=grey+alpha,
//                              6=RGBA)
//   offset 26 : compression
//   offset 27 : filter
//   offset 28 : interlace
//
// A colour type of 4 or 6 means the file *can* carry an alpha channel.
// That is necessary but not sufficient: a PNG can declare an alpha
// channel and still be fully opaque (every pixel alpha = 255), and a
// palette PNG (colour type 3) can carry per-palette-entry transparency
// in its tRNS chunk without declaring an alpha channel at all.
//
// So the cheap header check is only the first gate. When the header says
// "has an alpha channel", we ask ffmpeg for two statistics of the alpha
// plane:
//
//   format=rgba,extractplanes=a,signalstats,metadata=print
//
// `extractplanes=a` pulls out the alpha channel as its own greyscale
// plane and `signalstats` reports, per frame:
//
//   YMIN — the most transparent pixel (255 = every pixel fully opaque)
//   YAVG — the mean alpha over the whole frame
//
// Both are needed, because neither alone tells us what we want to know:
//
//   * YMIN alone cannot distinguish "a real cut-out sprite" from "one
//     stray semi-transparent pixel": both report YMIN = 0.
//   * YAVG alone cannot distinguish "mostly transparent" from
//     "partially transparent": a sprite with a soft edge everywhere
//     averages out too.
//
// Together they do: a frame with real transparency has a low YMIN *and*
// a YAVG well below 255, while a frame with a lone stray pixel keeps a
// YAVG of 254.
//
// Doing it this way rather than decoding the frame to a raw RGBA buffer
// matters for the import path: the buffer for a 1080x1440 frame is
// ~6 MB of pixel data copied out of ffmpeg and then scanned in JS,
// while the alpha-plane statistics are computed inside ffmpeg and cost
// a couple of integers over the pipe.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getFfmpegPath } = require('./video_frame_split');

// 8-byte PNG signature + IHDR (length + type + 13 bytes of data) = 33
// bytes minimum before any chunk payload.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG colour types that carry a per-pixel alpha channel.
const COLOR_TYPE_GRAY_ALPHA = 4;
const COLOR_TYPE_RGBA = 6;
const COLOR_TYPE_PALETTE = 3;

// How transparent a frame has to be before we call it "already
// transparent" and skip the cutout.
//
// Two conditions, both required:
//
//   * the frame contains at least one essentially transparent pixel
//     (`maxMinAlpha`), so a fully opaque frame with a stray artifact
//     never qualifies;
//   * the frame's *mean* alpha is low enough (`maxMeanAlpha`) that the
//     transparency is a real region rather than a handful of pixels.
//
// The mean-alpha limit is the meaningful one. A frame that is 5%
// transparent has a mean alpha of 242 and still qualifies; a frame with
// one stray transparent pixel has a mean alpha of 254 and does not.
//
// The thresholds are deliberately lenient about *how* transparent a
// sprite is, and strict about *whether* it is transparent at all: the
// cutout is a no-op on an opaque frame, so being wrong in that
// direction is harmless, while being wrong the other way (cutting an
// already-cut sprite) damages the artwork.
const maxMinAlpha = 2;      // the most transparent pixel must be ≤ this
const maxMeanAlpha = 250;   // the frame's mean alpha must be ≤ this

// Read the PNG header without decoding the pixels.
//
// Returns { colorType, bitDepth, hasAlphaChannel, paletteTransparency }.
//
// `hasAlphaChannel` — the colour type declares a per-pixel alpha
//   channel (types 4 and 6).
// `paletteTransparency` — the file uses a palette (type 3) and carries
//   a tRNS chunk, so palette entries can be transparent.
//
// Throws when the buffer is not a PNG.
function readPngHeader(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length < 33) throw new Error('PNG 太短');
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是 PNG');

  // IHDR must be the first chunk: 4-byte length, 4-byte type, then data.
  if (bytes.readUInt32BE(8) !== 13) throw new Error('PNG 头部异常');
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 缺少 IHDR');

  const bitDepth = bytes.readUInt8(24);
  const colorType = bytes.readUInt8(25);
  const interlace = bytes.readUInt8(28);

  // Scan the chunk list for tRNS. We only need it for palette images,
  // but the scan is cheap and bounded by the header we already hold.
  let paletteTransparency = false;
  if (colorType === COLOR_TYPE_PALETTE) {
    paletteTransparency = hasTrnsChunk(bytes);
  }

  return {
    bitDepth,
    colorType,
    interlace,
    hasAlphaChannel: colorType === COLOR_TYPE_GRAY_ALPHA || colorType === COLOR_TYPE_RGBA,
    paletteTransparency,
  };
}

// Walk the PNG chunk list looking for a tRNS chunk.
//
// The chunk layout is: 4-byte length, 4-byte type, payload, 4-byte
// CRC. We step over each chunk by its declared length.
function hasTrnsChunk(bytes) {
  let offset = 8;   // past the signature
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'tRNS') return true;
    // IEND ends the file. Anything past it is not a chunk.
    if (type === 'IEND') return false;
    const next = offset + 8 + length + 4;   // length + type + payload + CRC
    if (next <= offset) return false;        // guard against a bogus length
    offset = next;
  }
  return false;
}

// Ask ffmpeg for the alpha plane's statistics.
//
// The bytes have to land on disk first because Windows ffmpeg refuses to
// read an image from `pipe:0` (it tries to open a literal file named
// "pipe:0"). The temp file is removed on every exit path.
//
// Returns { minAlpha, meanAlpha } — the most transparent pixel and the
// frame's mean alpha (both 0-255), or null when ffmpeg could not produce
// the statistics.
function probeAlphaStats(bytes) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(8).toString('hex');
    const inPath = path.join(os.tmpdir(), `alpha-in-${nonce}.png`);

    const cleanup = () => {
      try { fs.unlinkSync(inPath); } catch {}
    };

    let child;
    try {
      fs.writeFileSync(inPath, bytes);
    } catch (err) {
      reject(new Error(`写入临时 PNG 失败：${err.message}`));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err); else resolve(value);
    };

    try {
      child = spawn(getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-i', inPath,
        '-vf', 'format=rgba,extractplanes=a,signalstats,metadata=print:file=-',
        '-f', 'null', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(new Error(`ffmpeg 启动失败：${err.message}`));
      return;
    }

    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => finish(new Error(`ffmpeg 启动失败：${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = Buffer.concat(stderrChunks).toString('utf8').trim();
        finish(new Error(`ffmpeg 退出码 ${code}${tail ? '：' + tail : ''}`));
        return;
      }
      const text = Buffer.concat(stdoutChunks).toString('utf8');
      // The metadata filter prints one block per frame. A PNG is a
      // single frame, but we scan every block anyway and take the
      // extremes, so the code stays correct if the filter is reused on
      // a multi-frame input.
      let minAlpha = null;
      let meanAlpha = null;
      for (const m of text.matchAll(/signalstats\.YMIN=(-?\d+)/g)) {
        const v = Number(m[1]);
        if (!Number.isFinite(v)) continue;
        minAlpha = minAlpha == null ? v : Math.min(minAlpha, v);
      }
      for (const m of text.matchAll(/signalstats\.YAVG=(-?\d+)/g)) {
        const v = Number(m[1]);
        if (!Number.isFinite(v)) continue;
        meanAlpha = meanAlpha == null ? v : Math.min(meanAlpha, v);
      }
      finish(null, { minAlpha, meanAlpha });
    });
  });
}

// Measure how much of the frame is actually transparent.
//
// Returns { minAlpha, meanAlpha, hasTransparency, transparent }.
//
// `minAlpha` is the smallest alpha value found in the frame (255 = every
// pixel fully opaque, 0 = at least one fully transparent pixel).
// `meanAlpha` is the frame's average alpha.
// `hasTransparency` is true when any pixel is not fully opaque.
// `transparent` is the verdict the importer uses.
//
// Throws when the file is not a readable PNG at all — callers treat that
// as "not transparent" so the normal cutout path runs and reports its
// own error.
async function measureTransparency(bytes) {
  const header = readPngHeader(bytes);
  if (!header.hasAlphaChannel && !header.paletteTransparency) {
    // No alpha channel at all — opaque by definition, no need to decode.
    return {
      minAlpha: 255,
      meanAlpha: 255,
      hasTransparency: false,
      transparent: false,
      header,
    };
  }

  const stats = await probeAlphaStats(bytes);
  if (stats.minAlpha == null || stats.meanAlpha == null) {
    throw new Error('无法读取图片的透明通道');
  }

  const { minAlpha, meanAlpha } = stats;
  return {
    minAlpha,
    meanAlpha,
    hasTransparency: minAlpha < 255,
    // A real cut-out sprite has an essentially transparent pixel *and*
    // a mean alpha low enough that the transparency covers a meaningful
    // share of the frame. A frame with one stray semi-transparent
    // pixel keeps a mean alpha of ~254 and does not qualify.
    transparent: minAlpha <= maxMinAlpha && meanAlpha <= maxMeanAlpha,
    header,
  };
}

// Is this PNG "already transparent" — i.e. should the importer skip the
// background cutout for it?
//
// Returns { transparent: boolean, reason: string, ...stats }.
//
// `reason` is one of:
//   'opaque'       — no alpha channel at all; the cutout is needed.
//   'too-opaque'   — alpha channel present but the frame is (almost)
//                    fully opaque; the cutout is needed.
//   'transparent'  — the frame is already a cut-out sprite; skip.
//   'unreadable'   — not a PNG we can parse; let the cutout path report it.
//   'undecodable'  — declares an alpha channel but ffmpeg could not
//                    measure it; let the cutout path handle it.
//
// Never throws: a frame we cannot classify is treated as "not
// transparent", which routes it through the cutout exactly as before.
async function isTransparentPng(bytes) {
  let header;
  try {
    header = readPngHeader(bytes);
  } catch {
    return {
      transparent: false,
      reason: 'unreadable',
      minAlpha: 255,
      meanAlpha: 255,
      hasTransparency: false,
    };
  }

  if (!header.hasAlphaChannel && !header.paletteTransparency) {
    return {
      transparent: false,
      reason: 'opaque',
      minAlpha: 255,
      meanAlpha: 255,
      hasTransparency: false,
      header,
    };
  }

  try {
    const stats = await measureTransparency(bytes);
    return {
      ...stats,
      transparent: stats.transparent,
      reason: stats.transparent ? 'transparent' : 'too-opaque',
    };
  } catch (err) {
    // The frame declares an alpha channel but will not decode. We cannot
    // prove it is transparent, so we let the cutout path handle it (and
    // report the decode failure in its own error message).
    return {
      transparent: false,
      reason: 'undecodable',
      minAlpha: 255,
      meanAlpha: 255,
      hasTransparency: false,
      header,
      error: err,
    };
  }
}

module.exports = {
  isTransparentPng,
  measureTransparency,
  readPngHeader,
  hasTrnsChunk,
};
