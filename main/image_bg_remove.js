// main/image_bg_remove.js — turn an image's background transparent.
//
// Why not just `colorkey` (which main/png_colorkey.js already uses):
// colorkey makes *every* pixel matching the key color transparent,
// everywhere in the frame. The images this tool is built for are line-art
// speech bubbles whose **interior is the same white as the background** —
// a flat colorkey punches an opaque hole straight through the middle of
// the object. What we actually want is "transparent everywhere OUTSIDE
// the object's outline", and that is a connectivity question, not a
// color question: only the background regions that can be *reached from
// the image border* without crossing the outline count as background.
//
// So the pipeline is:
//
//   1. ffmpeg decodes the source to a raw RGBA buffer on stdout
//      (`-f rawvideo -pix_fmt rgba -`). Works for png/jpg/bmp/webp alike
//      with no extra npm dependency — ffmpeg-static is already a
//      dependency (used by album_video.js and video_frame_split.js).
//   2. We estimate the background color from the four corners and run a
//      4-connected flood fill from the border inward. Anything reached is
//      background; anything not reached is the object (interior white
//      included, because the outline blocks the fill).
//   3. Optionally feather the hard cut into a soft edge, so anti-aliased
//      pixels around the outline blend instead of showing a gray halo
//      when the PNG is composited over a non-white desktop.
//   4. ffmpeg re-encodes the buffer as an RGBA PNG.
//
// ffmpeg's PNG *encoder* does write the alpha channel (we verified with
// `-pix_fmt rgba`), so no separate PNG chunk writer is needed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getFfmpegPath } = require('./video_frame_split');

// Cap the accepted pixel count. 40 MPix * 4 bytes ≈ 160 MB of RGBA plus
// the stack array (4 bytes/px) — roughly 320 MB peak. Bigger than that
// and the flood fill risks pushing a 32-bit machine into swap, so we
// refuse rather than hang. 40 MPix covers a 6000x6000 image.
const MAX_PIXELS = 40 * 1000 * 1000;

// Keep stderr for error messages only; ffmpeg is chatty at default loglevel.
const MAX_STDERR_BYTES = 8 * 1024;

// Tolerance presets exposed to the UI. `tolerance` is a per-channel
// 0-255 distance from the estimated background color — higher catches
// noisier/compressed backgrounds and soft drop-shadows, lower is
// stricter for images with a clean flat backdrop.
const TOLERANCE_PRESETS = {
  strict: 12,
  normal: 32,
  loose: 64,
};

function toleranceFor(name) {
  const key = String(name || 'normal').toLowerCase();
  return Object.prototype.hasOwnProperty.call(TOLERANCE_PRESETS, key)
    ? TOLERANCE_PRESETS[key]
    : TOLERANCE_PRESETS.normal;
}

function runFfmpeg(args, { input, cancelCheck } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), args, {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    const out = [];
    const stderrChunks = [];
    let stderrBytes = 0;
    let settled = false;
    let killed = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };

    if (typeof cancelCheck === 'function' && typeof child.stdin?.destroy === 'function') {
      // Poll so a long decode can be interrupted. ffmpeg's decode of a
      // single still is usually sub-second, but a 40 MPix source plus a
      // PNG re-encode can run long enough for the user to want out.
      const poll = setInterval(() => {
        try {
          if (!cancelCheck() || !killed) return;
        } catch { return; }
        killed = true;
        clearInterval(poll);
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      }, 250);
      if (typeof poll.unref === 'function') poll.unref();
      child.on('close', () => clearInterval(poll));
    }

    if (input) {
      child.stdin.on('error', () => { /* child died first; 'close' owns the verdict */ });
      child.stdin.end(input);
    }

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      finish(new Error(`ffmpeg 启动失败：${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (killed || signal === 'SIGTERM' || signal === 'SIGKILL') {
        const e = new Error('cancelled');
        e.killed = true;
        finish(e);
        return;
      }
      if (code !== 0) {
        const tail = Buffer.concat(stderrChunks).toString('utf8').trim();
        finish(new Error(`ffmpeg 退出码 ${code}${tail ? '：' + tail : ''}`));
        return;
      }
      finish(null, Buffer.concat(out));
    });
  });
}

// Read the frame dimensions out of ffmpeg's banner. We don't need (and
// avoid) ffprobe — it isn't bundled with ffmpeg-static, and the banner is
// reliable enough for the still-image formats this tool accepts.
async function probeSize(inputPath) {
  const child = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const chunks = [];
  let settled = false;
  return new Promise((resolve, reject) => {
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`ffmpeg 启动失败：${err.message}`));
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      const m = /Video:.*?(\d+)x(\d+)/.exec(text);
      if (!m) return reject(new Error('无法识别图片尺寸，请确认文件是有效的图片'));
      resolve({ width: Number(m[1]), height: Number(m[2]) });
    });
  });
}

// Median of the four corner pixels, per channel. Median (not mean) so a
// single corner that happens to overlap the object or a corner shadow
// can't drag the estimate off the true background color.
function estimateBackground(rgba, width, height) {
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  const per = [[], [], []];
  for (const [x, y] of points) {
    const o = (y * width + x) * 4;
    per[0].push(rgba[o]);
    per[1].push(rgba[o + 1]);
    per[2].push(rgba[o + 2]);
  }
  return per.map((chan) => {
    chan.sort((a, b) => a - b);
    return chan[chan.length >> 1];
  });
}

// Grow `mask` (1 = solid) by `rounds` pixels of 4-connected dilation.
//
// This is what makes ornate line-art work. A hand-drawn border is usually
// a *thin decorative stroke*, not a sealed wall: the example frames have a
// chamfered corner where the stroke, the outer margin and the inner panel
// are joined by a few pixels of white. A plain flood fill walks straight
// through that channel and erases the whole interior.
//
// Dilating the artwork by a few pixels closes channels narrower than 2r+1
// while leaving details wider than 2r+1 untouched — so a 2px-wide gap gets
// sealed but a 12px-wide cross keeps its shape.
function dilateSolid(mask, width, height, rounds) {
  let cur = mask;
  for (let p = 0; p < rounds; p += 1) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const i = row + x;
        if (cur[i]) { next[i] = 1; continue; }
        if (
          (x > 0 && cur[i - 1]) ||
          (x < width - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - width]) ||
          (y < height - 1 && cur[i + width])
        ) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// Classify every pixel as background (1) or artwork (0), then seal the
// artwork with `seal` pixels of dilation and flood the complement inward
// from the border. Returns a Uint8Array where 1 = background.
//
// Two stages, deliberately:
//
//   1. `solid[i] = 1` means "not background colour". Near-white
//      anti-aliased pixels on the stroke edge land here, which is what we
//      want — they become part of the barrier rather than a pinhole.
//   2. Dilation widens that barrier so thin decorative strokes close the
//      gaps a hand-drawn frame leaves at its chamfered corners.
//
// Without step 2 this function erases the interior of the gothic frames
// that motivated it; see dilateSolid().
function floodBackground(rgba, width, height, bg, tolerance, seal) {
  const total = width * height;

  const br = bg[0];
  const bgc = bg[1];
  const bb = bg[2];

  // Chebyshev distance in RGB. For a near-gray backdrop this behaves
  // like a perceptual threshold; it's also cheap (no sqrt, no divide).
  const solid = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    const dr = rgba[o] - br;
    const dg = rgba[o + 1] - bgc;
    const db = rgba[o + 2] - bb;
    const ar = dr < 0 ? -dr : dr;
    const ag = dg < 0 ? -dg : dg;
    const ab = db < 0 ? -db : db;
    let m = ar > ag ? ar : ag;
    const ab2 = ab > m ? ab : m;
    solid[i] = ab2 <= tolerance ? 0 : 1;
  }

  const blocked = seal > 0 ? dilateSolid(solid, width, height, seal) : solid;

  const mask = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;
  let filled = 0;

  const push = (idx) => {
    if (mask[idx] || blocked[idx]) return;
    mask[idx] = 1;
    stack[sp] = idx;
    sp += 1;
    filled += 1;
  };

  // Seed from all four borders. A border pixel already covered by the
  // object simply doesn't seed, which is correct.
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (sp > 0) {
    sp -= 1;
    const idx = stack[sp];
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }

  return { mask, filled, solid, blocked };
}

// How many pixels of dilation to apply before filling.
//
// The signal we're looking for is a step change in `filled`. As the
// barrier widens, the fill shrinks smoothly by roughly the object's own
// perimeter (a few thousand pixels per step on a 2048px image). The one
// exception is the radius at which the last channel through a decorative
// outline closes: there, the entire interior suddenly becomes unreachable
// and `filled` collapses by orders of magnitude more than a normal step.
//
// So: walk the radii, and take the first step whose drop is far larger
// than the routine per-step erosion. That radius is where the object
// became sealed. Stopping there — rather than continuing to MAX_SEAL —
// keeps thin artwork (crosses, daggers, tapered blades) from being eroded
// for no benefit.
const MAX_SEAL = 12;

// A "sealing" step is one that reclaims at least this many times the
// median step. On the gothic frames the sealing step moves ~1.1M pixels
// against a ~5.4K routine step (≈200×), while image 1's soft drop shadow
// erodes gradually with no sealing step at all and falls through to the
// floor below.
const SEAL_JUMP_RATIO = 20;

// If no step ever looks like a seal, back off to a radius that just
// covers anti-aliasing noise (3px) rather than MAX_SEAL — over-dilating
// without cause is what turned image 1's black outline white.
const DEFAULT_SEAL = 3;

function chooseSeal(rgba, width, height, bg, tolerance) {
  const deltas = [];
  const counts = [];
  let prev = null;
  for (let seal = 0; seal <= MAX_SEAL; seal += 1) {
    const { filled } = floodBackground(rgba, width, height, bg, tolerance, seal);
    if (prev !== null) deltas.push({ seal, drop: prev - filled });
    counts.push(filled);
    prev = filled;
  }
  if (deltas.length === 0) return { seal: 0, filled: counts[0] };

  // Median step: the routine erosion. Robust against the one huge step.
  const sorted = deltas.map((d) => d.drop).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];

  for (const d of deltas) {
    if (d.drop > Math.max(median * SEAL_JUMP_RATIO, 1000)) {
      return { seal: d.seal, filled: counts[d.seal] };
    }
  }
  return { seal: DEFAULT_SEAL, filled: counts[DEFAULT_SEAL] };
}

// Walk the boundary between the transparent region and the object, and
// give the first ring of still-opaque pixels a partial alpha. Without
// this the cut is binary and the anti-aliased fringe that was baked into
// the source (blend of outline and background) stays at alpha 255 — which
// reads as a light halo when the sprite is drawn over a dark desktop.
//
// `softness` is how far in from the edge the ramp reaches; 1 means only
// the outermost ring of object pixels fades, 2 reaches two rings in.
function featherEdge(rgba, mask, width, height, softness) {
  const rings = Math.max(0, Math.min(4, Math.round(softness)));
  if (rings === 0) return;

  const total = width * height;
  // alpha[i] = 255 for opaque, 0 for background. We mutate a copy of
  // the mask into a coverage value so each ring sees the previous ring's
  // partial coverage.
  const cover = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) cover[i] = mask[i] ? 0 : 255;

  for (let ring = 1; ring <= rings; ring += 1) {
    // How opaque this ring's pixels should be: ring 1 keeps most of its
    // alpha, the outermost ring fades the most.
    const floor = Math.round((255 * (rings - ring + 1)) / (rings + 1));
    const snapshot = cover.slice();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (cover[i] <= floor) continue;
        // Does this pixel touch a more-transparent neighbor?
        let touches = false;
        if (x > 0 && snapshot[i - 1] < cover[i]) touches = true;
        else if (x < width - 1 && snapshot[i + 1] < cover[i]) touches = true;
        else if (y > 0 && snapshot[i - width] < cover[i]) touches = true;
        else if (y < height - 1 && snapshot[i + width] < cover[i]) touches = true;
        if (touches) cover[i] = floor;
      }
    }
  }

  for (let i = 0; i < total; i += 1) rgba[i * 4 + 3] = cover[i];
}

// Main entry point.
//
//   inputPath   — absolute path to the source image
//   outPath     — absolute path the RGBA PNG is written to
//   tolerance   — 0-255, see TOLERANCE_PRESETS
//   softness    — 0-4, edge feathering ring count
//   progressCb  — ({ phase, percent, note }) => void
//   cancelCheck — () => boolean
function removeBackground({ inputPath, outPath, tolerance, softness, progressCb, cancelCheck }) {
  return (async () => {
    const progress = (phase, percent, note) => {
      try {
        if (typeof progressCb === 'function') progressCb({ phase, percent, note: note || null });
      } catch (e) {
        console.error('[image_bg_remove] progressCb threw:', e);
      }
    };

    const cancelled = () => {
      try { return !!(cancelCheck && cancelCheck()); } catch { return false; }
    };

    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new Error('图片文件不存在');
    }

    progress('probing', 0, '正在读取图片');
    const { width, height } = await probeSize(inputPath);
    if (width <= 0 || height <= 0) throw new Error('图片尺寸无效');
    if (width * height > MAX_PIXELS) {
      throw new Error(
        `图片太大（${width}×${height}），请先缩小到 ${Math.floor(MAX_PIXELS / 1000 / 1000)} 百万像素以内`,
      );
    }
    if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

    progress('decoding', 5, '正在解码');
    const rgba = await runFfmpeg(
      ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { cancelCheck },
    );
    const expect = width * height * 4;
    if (!rgba || rgba.length !== expect) {
      throw new Error(`解码结果异常（${rgba ? rgba.length : 0} / ${expect} 字节）`);
    }
    if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

    progress('analyzing', 35, '正在识别背景');
    const tol = Number.isFinite(tolerance) ? Math.max(0, Math.min(255, tolerance)) : TOLERANCE_PRESETS.normal;
    const bg = estimateBackground(rgba, width, height);
    // Pick the smallest barrier radius that fully seals the object, then do
    // one final fill with it. chooseSeal re-fills internally at each radius,
    // so this is O(seal) passes — cheap next to the ffmpeg decode/encode.
    const { seal } = chooseSeal(rgba, width, height, bg, tol);
    const { mask, filled } = floodBackground(rgba, width, height, bg, tol, seal);

    // Nothing filled means the image is uniformly non-background (e.g. the
    // whole frame is one object on a transparent-ish canvas, or our
    // tolerance was set absurdly low). Surfacing this beats silently
    // returning the input unchanged, which looks like the tool is broken.
    if (filled === 0) {
      throw new Error('未识别到背景：请确认背景与主体颜色差异明显，必要时放宽「容差」');
    }
    if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

    for (let i = 0; i < width * height; i += 1) {
      rgba[i * 4 + 3] = mask[i] ? 0 : 255;
    }
    if (softness > 0) featherEdge(rgba, mask, width, height, softness);

    progress('encoding', 70, '正在导出 PNG');
    if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

    // Encode through a temp file next to the destination, then rename.
    // Windows ffmpeg won't emit PNG to a pipe, so this needs a real path
    // (same constraint documented in png_colorkey.js). Renaming last
    // means a failed encode never clobbers an existing file.
    const dir = path.dirname(outPath);
    const tmpPath = path.join(dir, `.bgremove-${crypto.randomBytes(6).toString('hex')}.png`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      await runFfmpeg(
        ['-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0',
          '-c:v', 'png', '-pix_fmt', 'rgba', tmpPath],
        { input: rgba, cancelCheck },
      );
      if (cancelled()) {
        try { fs.unlinkSync(tmpPath); } catch {}
        const e = new Error('cancelled'); e.killed = true; throw e;
      }
      fs.renameSync(tmpPath, outPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }

    const transparentRatio = filled / (width * height);
    progress('done', 100, `已完成，透明区域 ${(transparentRatio * 100).toFixed(1)}%`);
    return {
      width,
      height,
      transparentRatio,
      backgroundColor: bg,
      seal,
      bytes: fs.statSync(outPath).size,
    };
  })();
}

module.exports = {
  removeBackground,
  probeSize,
  estimateBackground,
  floodBackground,
  dilateSolid,
  chooseSeal,
  toleranceFor,
  TOLERANCE_PRESETS,
  MAX_PIXELS,
  getFfmpegPath,
  // Exported for tests / scratch validation.
  _internal: { runFfmpeg },
};