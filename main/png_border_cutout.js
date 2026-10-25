// main/png_border_cutout.js — the shared cutout pipeline: decide what is
// background, cut it out, strip the "sticker" outline, and repair any hole
// the cut left behind.
//
// The problem this solves
// -----------------------
// The zip importer used to run every incoming PNG through ffmpeg's
// `colorkey=0x000000:0.1:0.0`. A colorkey makes **every** pixel close to
// the key colour transparent, *anywhere in the frame*. Pet frames ripped
// from a Live2D preview page sit on a near-black backdrop, and the
// character usually has black hair, black clothing and black outlines too.
// A flat colorkey therefore punches holes straight through the character:
// the silhouette survives but its dark parts vanish, leaving a ragged,
// half-erased sprite.
//
// The rule we actually want
// ------------------------
// Only the background counts as background if you can *walk to it from the
// outside of the image* without crossing the character. That is a
// connectivity question, not a colour question — but connectivity alone is
// not enough either, because how far the flood may travel depends on how
// the pixels are priced.
//
// So each pixel gets a *cost* that combines two signals:
//
//   - how far its colour is from the estimated backdrop, and
//   - how strong an edge it sits on.
//
// and the background is the set of pixels that can be reached from the
// image border without ever passing through a pixel above a cost ceiling.
// See `main/png_bottleneck_flood.js` for the full derivation and the
// measurements behind it.
//
// Why a cost instead of a colour threshold
// -----------------------------------------
// The previous version picked a single colour distance ("the tolerance")
// and removed every pixel within it that was connected to the border.
//
// On dark-on-dark artwork that number cannot be set safely. Measured on a
// real 1080x1440 frame (black backdrop, character with a white sticker
// outline), widening the tolerance from 21 to 32 deleted an extra 118,758
// pixels — 7.64% of the frame — and every one of them was in the two
// darkest luminance buckets, i.e. the character's own black costume. The
// sprite came out riddled with holes.
//
// The cost formulation fixes that because the gradient term prices the
// anti-aliased fringe around the character as expensive, so the flood
// stops there, while the character's black costume — which is flat and
// close to the backdrop colour, and therefore *cheap* — is never reached
// because getting to it would mean crossing that expensive rim.
//
// Removing the "sticker" outline
// ------------------------------
// Live2D art is often exported with a bright stroke around the character.
// Left behind it reads as a white halo over the desktop, so `defringeOutline`
// strips it.
//
// It cannot be done by brightness. The stroke's dark anti-aliased ramp
// covers exactly the same luminance range as the character's black
// costume -- on the reference sprite the ramp runs 19..135 while the
// costume sits at 24..60 -- so a global threshold either leaves the halo
// or eats the costume.
//
// It is done by *geometry* instead. Two facts separate the stroke from the
// character:
//
//   1. The stroke hugs the cut. It is the narrow bright band in the
//      outermost depth ring, and it *peaks and falls again* as its far
//      ramp comes back down. A character that is simply bright at its
//      edge does the opposite -- it stays bright deep inside -- and is
//      therefore left alone.
//   2. The character's own white areas (hair, shirt, skin) are enclosed
//      by the costume, hundreds of pixels deep, so they never reach the
//      cut and are never part of the stroke.
//
// With the bright band located, the dark ramp around it is taken along:
// the outer ramp by flooding in from the background (the bright band is a
// wall, so the flood cannot reach the character behind it), and the inner
// seam by taking the dark pixels that touch the band and that the
// background flood could not reach.
//
// The pipeline
// ------------
// Every entry point runs the same six steps, in this order:
//
//   1. buildBottleneckMask — background = cheaply reachable from the edge
//   2. applyMask         — write the alpha channel, feather the cut
//   3. defringeOutline   — strip the white sticker stroke
//   4. expandBoundary    — grow the cut outward to swallow the dark rim
//   5. repairHoles       — close holes the cut left inside the character
//   6. removeSpecks      — drop the isolated small leftover blobs
//
// The order is load-bearing. The defringe has to run *after* the cut
// (it needs the background it hugs) and *before* the repair (the repair
// would otherwise fill the stroke straight back in). The expansion has
// to run *after* the defringe, because the defringe measures the
// stroke by its distance from the cut — a cut that had already grown
// into the stroke band would shift that measurement and leave the
// halo behind.
//
// The last two steps
// ------------------
// Two artefacts survive the cut itself:
//
//   - The dark rim. The flood stops at the first pixel it cannot walk
//     through, which on real artwork is the anti-aliased fringe where
//     the backdrop blends into the character's edge. On a dark backdrop
//     that fringe is *black*, and it shows up as a halo following the
//     silhouette. `expandBoundary` grows the transparent region a few
//     pixels outward to swallow it — gated on darkness, so it eats the
//     rim and stops at the character's own material.
//
//   - The black dots. A handful of isolated pixels of the backdrop can
//     survive the cut when they happen to sit behind a thin strand of
//     the character's line art. `removeSpecks` labels the connected
//     components of what the cut kept and makes every component that
//     is both small and disconnected from the body transparent.
//
// Performance
// -----------
// The whole thing is O(pixels) with typed-array buffers, plus one ffmpeg
// decode and one ffmpeg encode. This is *faster* than the version it
// replaces, which had to run a full-frame flood once per candidate
// tolerance (32 times) just to pick that tolerance.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getFfmpegPath } = require('./video_frame_split');
const {
  buildBottleneckMask,
  colorDistance,
  computeLuminancePlane,
  computeSobelGradient,
  smoothLuminance,
  DEFAULT_CEIL,
} = require('./png_bottleneck_flood');

// Hard ceiling on the pixel count we accept, matching
// `main/image_bg_remove.js`.
//
// This was lowered from 40 MPix because the cost field adds a Float32Array
// and a Float32Array of path costs on top of the RGBA buffer: at 40 MPix
// the pipeline peaks around 600 MB, which a 32-bit-ish Electron main
// process starts swapping on. At 24 MPix the peak is roughly 360 MB.
//
// 24 MPix is still generous: the reference artwork is 1.5 MPix and a
// 2160x2880 Live2D frame is 6.2 MPix.
const MAX_PIXELS = 24 * 1000 * 1000;

// Keep stderr for error messages only; ffmpeg is chatty at default loglevel.
const MAX_STDERR_BYTES = 8 * 1024;

// How far the transparent region is grown outward, in pixels, to swallow
// the dark anti-aliased fringe that the flood leaves behind.
//
// Five pixels is enough to cover the fringe on the artwork this tool is
// built for: the fringe is a 2-4 px blend between the backdrop and the
// character's edge, so 5 px reaches past it with a pixel or two to spare.
//
// It is an absolute pixel count rather than a ratio, because the fringe
// is a property of the *rendering* (a blend between two colours), not of
// the artwork's size — it stays a handful of pixels wide whether the
// frame is 200 px or 4000 px across.
const DEFAULT_EXPAND_PX = 5;

// How far a pixel may be from the backdrop colour and still be swallowed
// by the boundary expansion, in 0..255 units.
//
// This is the gate that makes the expansion safe. The rim left behind by
// the flood is a *blend* of the backdrop and the character's edge, so it
// sits close to the backdrop colour; the character's own material does
// not.
//
// Measured on a real 432x576 frame, the kept pixels at depth 1-2 from
// the cut (the rim) are pure black, depth 3 is the blend (median
// luminance 32) and the character's own body starts at depth 5. Their
// distance to the backdrop runs 0-56 for the rim and from 67 upward for
// the character, so 60 separates them.
//
// The value is deliberately close to the old colour tolerance of 32 that
// this algorithm replaced: it is used the same way (a per-channel
// distance from the backdrop) but over a 5 px band instead of over the
// whole frame, and *only* where the flood already decided the pixel was
// nearly background. It cannot reach the character's interior, because
// the interior is more than 5 px away from the cut.
const DEFAULT_EXPAND_TOLERANCE = 60;

// How far a pixel may be from the backdrop colour and still count as
// speck material, in 0..255 units.
//
// A speck is leftover *background*, so it is judged against the backdrop
// colour exactly like the cut itself judges the background. The value is
// the same one the expansion uses, so a pixel that the expansion would
// have removed is also a pixel the speck pass can recognise.
const DEFAULT_SPECK_TOLERANCE = 60;

// The highest Sobel gradient a speck pixel may sit on.
//
// This is the separator between "a leftover blob of background" and
// "the character's own dark detail". A speck is flat material — the
// gradient is near zero because the whole patch has the same colour. A
// pupil, a button or a strand of hair sits on strong edges.
//
// The threshold is well below a real edge (a saturated anti-aliased
// edge reaches 460-675) and above the noise of a flat patch (which
// measures under 30).
const DEFAULT_SPECK_MAX_GRADIENT = 120;

// ---------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------

// Run ffmpeg with the given args, optionally feeding it `input` on stdin.
// Resolves with the collected stdout buffer (empty when `input` is given).
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

    if (typeof cancelCheck === 'function') {
      const poll = setInterval(() => {
        let done = false;
        try { done = !!cancelCheck(); } catch { return; }
        if (!done || killed) return;
        killed = true;
        clearInterval(poll);
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      }, 250);
      if (typeof poll.unref === 'function') poll.unref();
      child.on('close', () => clearInterval(poll));
    }

    if (input) {
      // The child may die before we finish writing; ignore the EPIPE.
      child.stdin.on('error', () => {});
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
function probeSize(inputPath) {
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

// ---------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------

// Estimate the backdrop colour from the outer perimeter of the image.
//
// A *perimeter band* (not just the four corners) is sampled and the median
// is taken per channel.
//
// The band matters: the four corners alone are too few, and an
// AI-generated frame often carries a vignette or a drop shadow that
// darkens the corners while the true backdrop sits a few pixels in.
//
// The median matters even more, because the alternative statistics both
// pick the wrong colour on a real pet frame:
//
//   - the *mode* is the character's colour whenever the character touches
//     the edge, which is the opposite of what we want;
//   - the *mean* is dragged toward the character the same way.
//
// The median sits between the two: as long as most perimeter pixels are
// backdrop — which holds for the frames this tool is built for, because
// the character is inset from the frame edge — it lands squarely on the
// backdrop colour.
//
// For a backdrop that is a gradient rather than a flat colour, the median
// lands mid-ramp and the cost ceiling has to be wide enough to bridge the
// ramp. That is a documented limitation rather than a bug: the strength
// presets exist precisely to cover it.
function estimateBorderColor(rgba, width, height) {
  const samples = collectBorderSamples(rgba, width, height);
  return samples.map((arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  });
}

// Sample the perimeter band and return the raw per-channel samples.
//
// The band is the same one `estimateBorderColor` uses: a few rows/columns
// hugging the image edge.
function collectBorderSamples(rgba, width, height) {
  const band = Math.max(1, Math.min(8, Math.round(Math.min(width, height) * 0.01)));
  const samples = [[], [], []];

  const push = (x, y) => {
    const o = (y * width + x) * 4;
    samples[0].push(rgba[o]);
    samples[1].push(rgba[o + 1]);
    samples[2].push(rgba[o + 2]);
  };

  for (let y = 0; y < band; y += 1) {
    for (let x = 0; x < width; x += 1) {
      push(x, y);
      push(x, height - 1 - y);
    }
  }
  for (let x = 0; x < band; x += 1) {
    for (let y = 0; y < height; y += 1) {
      push(x, y);
      push(width - 1 - x, y);
    }
  }

  return samples;
}

// Repair the mask so the character can never end up hollow.
//
// A "black hole" is a transparent region that is *enclosed* by opaque
// character pixels. It is not a hole in the geometric sense — the region
// is genuinely connected to the backdrop through a gap in the outline —
// but visually it reads as a hole punched into the character, because the
// backdrop behind it shows through.
//
// The mask we get from the connectivity rule cannot tell those apart on
// its own: a region reachable from the border *through the gap* is
// background by the rule, even though it sits in the middle of the
// character's body.
//
// So we add a second pass, and this is the part that guarantees the
// "no black holes" requirement:
//
//   1. Take the opaque region (the character) and look at its outer
//      silhouette.
//   2. Any transparent region that lies *inside* that silhouette and is
//      surrounded on all sides by opaque pixels is a hole. Fill it back
//      in.
//
// The silhouette is computed by filling the character mask's interior:
// we flood the *background* inward from the border, and anything the
// flood cannot reach that is still transparent is enclosed. That is
// exactly the set of holes.
//
// The trade-off: a hole we fill back in keeps a patch of the original
// backdrop. On a black backdrop that patch is black — which is the
// "black hole" the user sees. Filling it in with the surrounding
// character's colour instead is what `fillHolesWithColor` does, and is
// strictly better.
//
// We only fill holes that are *small enough to be a costume detail* —
// a hole bigger than `maxHoleArea` is far more likely to be a genuine
// gap in the artwork (the space between two wings, say) than a piece of
// eaten costume, and filling that would glue the character into a blob.
// The size limit is relative to the frame so it scales with resolution.
function findEnclosedHoles(mask, width, height) {
  const total = width * height;

  // Flood the background (mask === 1) from the border. Everything marked
  // as background that we can reach is "outside"; the rest of the
  // background is enclosed.
  const reached = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const push = (i) => {
    if (mask[i] !== 1 || reached[i]) return;
    reached[i] = 1;
    stack[sp] = i;
    sp += 1;
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];

  while (sp > 0) {
    sp -= 1;
    const idx = stack[sp];
    const x = idx % width;
    const y = (idx - x) / width;
    for (let k = 0; k < 8; k += 1) {
      const nx = x + NX[k];
      const ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      push(ny * width + nx);
    }
  }

  // Background pixels we could not reach are enclosed.
  const holes = new Uint8Array(total);
  let holeCount = 0;
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1 && !reached[i]) {
      holes[i] = 1;
      holeCount += 1;
    }
  }

  return { holes, holeCount, reached };
}

// Fill a hole with the colour of the character pixels around it.
//
// The fill colour is the median of the opaque pixels immediately
// surrounding the hole. Using the median (not the mean) means a
// surrounding region that mixes, say, a black sleeve and a white shirt
// still produces a sensible in-between colour rather than a smear.
//
// `rgba` is modified in place: the hole's alpha is set to 255 and its
// RGB is set to the fill colour.
function fillHolesWithColor(rgba, holeMask, width, height) {
  const total = width * height;
  let filled = 0;

  for (let i = 0; i < total; i += 1) {
    if (!holeMask[i]) continue;
    const x = i % width;
    const y = (i - x) / width;

    // Gather the opaque neighbours (4-neighbourhood is enough and keeps
    // the fill consistent along an edge).
    const rs = [];
    const gs = [];
    const bs = [];
    const consider = (ni) => {
      if (ni < 0 || ni >= total) return;
      if (holeMask[ni]) return;
      const no = ni * 4;
      if (rgba[no + 3] === 0) return;
      rs.push(rgba[no]);
      gs.push(rgba[no + 1]);
      bs.push(rgba[no + 2]);
    };
    if (x > 0) consider(i - 1);
    if (x < width - 1) consider(i + 1);
    if (y > 0) consider(i - width);
    if (y < height - 1) consider(i + width);

    const o = i * 4;
    if (rs.length) {
      rs.sort((a, b) => a - b);
      gs.sort((a, b) => a - b);
      bs.sort((a, b) => a - b);
      rgba[o] = rs[rs.length >> 1];
      rgba[o + 1] = gs[gs.length >> 1];
      rgba[o + 2] = bs[bs.length >> 1];
    }
    rgba[o + 3] = 255;
    filled += 1;
  }

  return filled;
}

// Compute the transparent mask for a decoded RGBA buffer.
//
// Returns { mask, backgroundColor, transparentPixels, total } where mask is
// a Uint8Array with 1 = "this pixel is background (make it transparent)".
//
// Remove the black holes a cut can leave behind.
//
// After the mask is applied, some regions that are visually *inside* the
// character may have been made transparent, because the character's
// outline had a gap and the connectivity rule treated the region as
// reachable from the border. The result is a hole in the character —
// literally a "black hole" when the backdrop is black.
//
// This function finds those regions and closes them.
//
// `maxHoleRatio` is the largest hole we are willing to close, as a
// fraction of the frame area. A hole below the limit is almost certainly
// a piece of eaten costume; a hole above it is more likely a genuine gap
// in the artwork (the gap between two wings, the space under a hat
// brim), and closing that would weld the character into a blob.
//
// Returns { repaired, skipped } — the number of pixels closed and the
// number left alone.
function repairHoles(rgba, width, height, maxHoleRatio = 0.02) {
  const total = width * height;
  // A pixel counts as background only when it is *fully* transparent. The
  // soft cut leaves the anti-aliased ramp partially transparent, and
  // those pixels are legitimately part of the character's edge — treating
  // them as background would make the hole detector see through the
  // outline.
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) mask[i] = rgba[i * 4 + 3] === 0 ? 1 : 0;

  const { holes, holeCount } = findEnclosedHoles(mask, width, height);
  if (holeCount === 0) return { repaired: 0, skipped: 0, holes: 0 };

  const maxHolePixels = Math.max(64, Math.round(total * maxHoleRatio));

  // Split the holes into individual blobs so each one can be judged on
  // its own size. A hole blob that is too large is left alone.
  const { labels, componentCount } = labelBlobs(holes, width, height);
  let repaired = 0;
  let skipped = 0;
  const repairMask = new Uint8Array(total);

  for (let l = 0; l < componentCount; l += 1) {
    let size = 0;
    for (let i = 0; i < total; i += 1) if (labels[i] === l) size += 1;
    if (size > maxHolePixels) {
      skipped += size;
      continue;
    }
    for (let i = 0; i < total; i += 1) if (labels[i] === l) repairMask[i] = 1;
    repaired += size;
  }

  if (repaired > 0) fillHolesWithColor(rgba, repairMask, width, height);

  return { repaired, skipped, holes: holeCount };
}

// Label the 8-connected components of a binary mask.
//
// Same contract as `labelCandidates` but the mask is already binary, so
// the colour test is not repeated for every pixel.
function labelBlobs(binary, width, height) {
  const total = width * height;
  const labels = new Int32Array(total).fill(-1);
  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
  const stack = new Int32Array(total);
  let nextLabel = 0;

  for (let seed = 0; seed < total; seed += 1) {
    if (labels[seed] !== -1) continue;
    if (!binary[seed]) continue;
    const label = nextLabel;
    nextLabel += 1;
    let sp = 0;
    stack[sp] = seed;
    sp += 1;
    labels[seed] = label;
    while (sp > 0) {
      sp -= 1;
      const idx = stack[sp];
      const x = idx % width;
      const y = (idx - x) / width;
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NX[k];
        const ny = y + NY[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (labels[ni] !== -1) continue;
        if (!binary[ni]) continue;
        labels[ni] = label;
        stack[sp] = ni;
        sp += 1;
      }
    }
  }

  return { labels, componentCount: nextLabel };
}

// ---------------------------------------------------------------------
// Defringe: remove the white "sticker" outline
// ---------------------------------------------------------------------
//
// The problem
// -----------
// A lot of Live2D pet art is exported as a *sticker*: the character is
// drawn on a flat backdrop with a bright outline stroke around it, so the
// sprite reads well on any background. When we cut the backdrop away, that
// outline stroke stays behind and shows up as a white halo.
//
// Measured on a real 1080x1440 frame (black backdrop, white sticker
// outline), a horizontal scan across the character's silhouette reads:
//
//   bg(0) 19 38 64 97 135 182 227 243 255 254 254 252 249 242 179 | 60 26 24 ...
//   ^ background   ^------ the outline stroke (24 px wide) -------^  ^ body
//
// The stroke is 24 px wide and reaches near-white, so no colour threshold
// can remove it: the body's own dark pixels (24-60) overlap the stroke's
// dark ramp (19-135) exactly. Measured on the same frame, the luminance
// histogram has no valley between the two populations.
//
// Why the connectivity rule does not save us
// -----------------------------------------
// The stroke sits *between* the background and the character, so it is
// part of the "kept" region by the connectivity rule — and the white hair
// and shirt, which must survive, look exactly like it.
//
// The separator is geometry, not colour
// ------------------------------------
// Two measurements make the stroke separable:
//
//   1. DISTANCE. The stroke is a *layer*: it lies within ~16 px of the
//      removed background. The character's white hair and shirt are deep
//      inside, enclosed by dark clothing, hundreds of pixels away.
//      Measured on the real frame, the median luminance by distance from
//      the background rises 25 -> 204 over depths 1-7, peaks at 208, and
//      falls back to 55, 42, 36 by depth 11 — the stroke is depths 1..11,
//      the body is everything deeper.
//
//   2. CONNECTIVITY. A bright region that reaches depth 1 is touching the
//      background, so it is outline. A bright region that does not reach
//      depth 1 is enclosed, so it is the character's hair, shirt or skin.
//
// The rule
// --------
//   fringe = kept pixels that
//     (a) are bright enough to be part of the stroke,
//     (b) lie within `maxDepth` of the removed background, and
//     (c) belong to a bright connected component that reaches the
//         background-adjacent band (depth 1).
//
// Plus a second pass that takes the stroke's *dark ramp* with it: the
// pixels between the background and the bright stroke core. That flood
// only ever moves toward the background, so it can never eat into the
// character.
//
// `level` is the brightness that separates the stroke from the body. It is
// derived per image from the luminance profile: the stroke's median
// luminance at its peak depth is far above the body's median, and the
// level is placed between them.

// Luminance of a pixel (Rec. 601).
function luminance(rgba, index) {
  const o = index * 4;
  return 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
}

// Distance in pixels from every pixel to the nearest background pixel.
//
// `mask` is 1 for "background" (transparent) and 0 for "kept". A plain
// BFS over the whole image; the background is the seed set, so a kept
// pixel's distance is exactly how far it is from the cut.
function distanceToBackground(mask, width, height) {
  const total = width * height;
  const dist = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1) {
      dist[i] = 0;
      queue[tail] = i;
      tail += 1;
    }
  }

  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
  while (head < tail) {
    const i = queue[head];
    head += 1;
    const next = dist[i] + 1;
    const x = i % width;
    const y = (i - x) / width;
    for (let k = 0; k < 8; k += 1) {
      const nx = x + NX[k];
      const ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (dist[ni] !== -1) continue;
      dist[ni] = next;
      queue[tail] = ni;
      tail += 1;
    }
  }
  return dist;
}

// Measure how dark the character's own material is.
//
// It is measured from the *deepest* kept pixels — the far interior of
// the character, whatever the sprite's size — and it is a *low*
// quantile rather than the median.
//
// The quantile is the important part. The interior of a character is
// mostly dark costume, but it can contain a large bright region (a
// white shirt, a white face, white hair). A median over the interior
// is then pulled up by that region, the "body" ends up brighter than
// the stroke, the comparison inverts, and the defringe bails out
// silently — the halo stays. A low quantile lands on the costume
// instead, which is the material the level actually has to protect.
//
// Returns null when there is too little interior to measure.
function measureBodyLevel(rgba, mask, width, height, dist) {
  const total = width * height;

  const kept = [];
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1) continue;
    const d = dist[i];
    if (d < 0) continue;
    kept.push(d);
  }
  if (kept.length < 256) return null;
  kept.sort((a, b) => a - b);
  const deepCutoff = kept[Math.floor(kept.length * 0.9)];

  const deep = [];
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1) continue;
    const d = dist[i];
    if (d >= deepCutoff) deep.push(luminance(rgba, i));
  }
  if (deep.length < 64) return null;
  deep.sort((a, b) => a - b);
  // The 25th percentile of the interior: the costume, not the accents.
  return deep[Math.floor(deep.length * 0.25)];
}

// Pick the brightness that separates the outline stroke from the body.
//
// The stroke raises the *median* luminance of the outer ring well above
// the body's. We take the median luminance at the depth where the outer
// ring is brightest (the stroke's crest) and the median luminance deep
// inside (the body), and place the level between them.
//
// The level is deliberately close to the body rather than in the middle of
// the gap. A level in the middle of the gap leaves the stroke's dark
// ramp (which is what reads as a halo) behind; a level near the body
// takes the whole ramp with it. The body is protected by the other
// conditions — the depth cap and the connectivity test — not by the
// level, so the level can sit low.
//
// Returns null when there is no stroke to remove.
function chooseDefringeLevel(rgba, mask, width, height, dist) {
  const total = width * height;
  // How deep the stroke's crest may sit. A stroke thick enough to reach
  // past this is not an outline any more — it is the character's own
  // white area, which the connectivity test would protect anyway.
  const maxDepth = 48;

  // Median luminance per depth, over the kept pixels.
  const buckets = [];
  for (let d = 0; d <= maxDepth + 1; d += 1) buckets.push([]);
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1) continue;
    const d = dist[i];
    if (d < 0 || d > maxDepth) continue;
    buckets[d].push(luminance(rgba, i));
  }

  const medianOf = (arr) => {
    if (!arr.length) return null;
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };

  // The body's level: how dark the character's own material is.
  const bodyLevel = measureBodyLevel(rgba, mask, width, height, dist);
  if (bodyLevel === null) return null;

  // The stroke's crest: the brightest median in the outer ring.
  let crest = null;
  let crestDepth = -1;
  for (let d = 1; d <= maxDepth; d += 1) {
    if (buckets[d].length < 64) continue;
    const med = medianOf(buckets[d]);
    if (med === null) continue;
    if (crest === null || med > crest) {
      crest = med;
      crestDepth = d;
    }
  }

  // No stroke: the outer ring is no brighter than the body. Leave the
  // image alone rather than risk eating the character.
  if (crest === null || crest - bodyLevel < 20) return null;

  // Is the bright band a *stroke*, or is it the character's own bright
  // body reaching the cut?
  //
  // A stroke is a narrow band: its brightness rises to a crest and then
  // falls away again as the ramp on the far side of the stroke comes
  // back down. A character's own bright body does the opposite — it is
  // bright right up to the cut and stays bright deep inside, so the
  // profile never comes back down.
  //
  // Without this test a bright character (a white body on a dark
  // backdrop, say) looks exactly like a stroke, and the defringe would
  // erase the character's body.
  //
  // The test is the drop after the crest: the median luminance further
  // in has to fall back to (or below) the body's level. A stroke's far
  // ramp does that; a solid bright body does not.
  let innerMedian = null;
  for (let d = crestDepth + 4; d <= Math.min(maxDepth, crestDepth + 24); d += 1) {
    if (buckets[d].length < 64) continue;
    const med = medianOf(buckets[d]);
    if (med === null) continue;
    if (innerMedian === null || med < innerMedian) innerMedian = med;
  }
  if (innerMedian === null || innerMedian > bodyLevel + 20) return null;

  // A tenth of the way up from the body. Measured on a real frame this
  // removes the stroke's dark ramp as well as its bright core, and a
  // sweep over the level showed nothing above the body is lost: the
  // depth cap and the connectivity test are what protect the character.
  const level = bodyLevel + (crest - bodyLevel) / 10;
  return {
    level: Math.max(8, Math.min(200, level)),
    bodyLevel,
    crest,
    crestDepth,
  };
}

// Remove the outline stroke.
//
// Returns { removed } — the number of pixels made transparent. The mask
// is expected to already describe the cut (1 = background).
//
// `maxDepth` bounds how far from the background a stroke pixel may sit.
// It is a *starting* bound: the measured crest of the stroke can push it
// further, so a thick stroke is not missed on a small canvas.
function defringeOutline(rgba, mask, width, height, { maxDepth } = {}) {
  const total = width * height;
  // The stroke's thickness scales with the artwork, so the starting depth
  // cap scales with the image. 1.8% of the short side measured 18 px on a
  // 1080x1440 frame, whose stroke was 24 px wide at its thickest.
  const baseDepth = Math.max(6, Math.min(64, Math.round(maxDepth
    || Math.min(width, height) * 0.018)));

  const dist = distanceToBackground(mask, width, height);
  const tuning = chooseDefringeLevel(rgba, mask, width, height, dist);
  if (!tuning) return { removed: 0, level: null };

  // The stroke's crest was measured at `crestDepth`. The stroke's whole
  // band reaches at least that far in, and its dark ramp sits just
  // outside the crest — so the cap has to cover the crest plus a margin.
  // Without this, a stroke thicker than the image-scaled cap would be
  // cut off halfway and leave a bright rim behind.
  const depth = Math.max(baseDepth, Math.min(64, (tuning.crestDepth || 0) * 2 + 4));

  // The bright candidate set: bright enough, and close to the cut.
  const bright = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1) continue;
    const d = dist[i];
    if (d < 1 || d > depth) continue;
    if (luminance(rgba, i) >= tuning.level) bright[i] = 1;
  }

  // Label the bright components. A component that reaches the *outer*
  // region is the outline stroke; one that does not is enclosed by the
  // character and must survive.
  //
  // "Reaches depth 1" would be the obvious test, but the stroke's
  // outermost ring is the anti-aliased ramp, which is dimmer than the
  // level and therefore not in the bright set at all — the stroke's
  // bright core starts a few pixels further in. Testing for depth 1
  // therefore rejects every stroke whose ramp is dark, and the defringe
  // silently does nothing. The outer region is a small band whose
  // width is the ramp's own thickness, measured from the image's own
  // depth profile rather than guessed.
  const { labels, componentCount } = labelBlobs(bright, width, height);
  const outlineComponents = new Set();
  const outerBand = Math.max(2, Math.round((tuning.crestDepth || 4) * 0.5));
  for (let i = 0; i < total; i += 1) {
    if (dist[i] <= outerBand && labels[i] >= 0) outlineComponents.add(labels[i]);
  }
  if (outlineComponents.size === 0) return { removed: 0, level: tuning.level };

  const fringe = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (labels[i] >= 0 && outlineComponents.has(labels[i])) fringe[i] = 1;
  }

  // Take the stroke's dark outer ramp with it.
  //
  // The stroke is a bright core with a dark anti-aliased ramp on either
  // side. The *outer* ramp — the one between the core and the backdrop —
  // is what reads as a halo over the desktop, so it has to go as well.
  //
  // The inner ramp (between the core and the character) is left alone.
  // It is a blend of the stroke and the character's own colours, both of
  // which stay, so leaving it is invisible; removing it would mean
  // biting into the character.
  //
  // The outer ramp is found by flooding *from the background* into the
  // dark pixels that are not bright enough to be part of the core. The
  // background is known exactly, so this flood cannot guess: it reaches
  // the ramp and stops there, because the bright core is a wall it
  // cannot cross and the character is on the far side of that wall.
  //
  // A distance-from-the-background cannot make the same distinction.
  // Near a corner the background is *farther* than the character's edge,
  // so a depth rule either strands the corner pixels (leaving a bright
  // notch) or reaches past the character (eating the costume).
  //
  // Flooding from the background has neither problem: the core blocks
  // it on one side and the background bounds it on the other.
  const isCore = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (labels[i] >= 0 && outlineComponents.has(labels[i])) isCore[i] = 1;
  }

  // The ramp's outer boundary is the background itself, so the flood
  // starts there. It may only enter dark pixels: a bright pixel is
  // either the core (a wall) or the character's own bright material.
  //
  // The flood is also bounded by *depth*. The backdrop of a dark-on-dark
  // sprite is itself dark, so without a bound the flood walks straight
  // through the background, through the dark ramp, and — wherever the
  // stroke does not completely close around the character — straight
  // into the character's black costume. The stroke only spans the outer
  // band, so the flood is not allowed past the stroke's own depth.
  const fromBackground = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < total; i += 1) {
    if (mask[i] !== 1) continue;
    fromBackground[i] = 0;
    queue[tail] = i;
    tail += 1;
  }
  // The stroke's outer ramp lies outside its crest, so it is bounded by
  // the crest's depth. A small margin covers the ramp's own thickness.
  const rampDepth = Math.max(2, (tuning.crestDepth || 4) + 2);
  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
  while (head < tail) {
    const i = queue[head];
    head += 1;
    const x = i % width;
    const y = (i - x) / width;
    for (let k = 0; k < 8; k += 1) {
      const nx = x + NX[k];
      const ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (fromBackground[ni] !== -1) continue;
      if (mask[ni] === 1) continue;
      // Only the dark ramp may be entered. The bright core is a wall —
      // the flood stops there and never reaches the character behind
      // it — and the character's own bright areas are off limits.
      if (luminance(rgba, ni) >= tuning.level) continue;
      // And the flood stays inside the stroke's own band.
      if (dist[ni] > rampDepth) continue;
      fromBackground[ni] = fromBackground[i] + 1;
      queue[tail] = ni;
      tail += 1;
    }
  }

  // Everything the flood reached is the stroke's outer ramp.
  for (let i = 0; i < total; i += 1) {
    if (fromBackground[i] > 0 && !isCore[i]) fringe[i] = 1;
  }

  // The *inner* ramp: the dark seam between the core and the character.
  //
  // It is the one part of the stroke the background flood cannot reach —
  // the core is a wall between it and the backdrop. So it is found by
  // taking the dark pixels that sit directly against the core and that
  // the flood did *not* reach. One ring is enough: the seam is the
  // anti-aliased blend of the stroke and the character, one pixel wide.
  //
  // Taking only one ring is what keeps the character safe. Two rings
  // would already bite into the costume at the corners, where the
  // character comes closest to the stroke.
  const NX2 = NX;
  const NY2 = NY;
  for (let i = 0; i < total; i += 1) {
    if (fringe[i] || fromBackground[i] > 0) continue;
    if (luminance(rgba, i) >= tuning.level) continue;
    const x = i % width;
    const y = (i - x) / width;
    let touchesCore = false;
    for (let k = 0; k < 8; k += 1) {
      const nx = x + NX2[k];
      const ny = y + NY2[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (isCore[ny * width + nx]) { touchesCore = true; break; }
    }
    if (touchesCore) fringe[i] = 1;
  }

  let removed = 0;
  for (let i = 0; i < total; i += 1) {
    if (!fringe[i]) continue;
    rgba[i * 4 + 3] = 0;
    removed += 1;
  }

  return {
    removed,
    level: tuning.level,
    bodyLevel: tuning.bodyLevel,
    crest: tuning.crest,
    crestDepth: tuning.crestDepth,
    depth,
  };
}

// Write the alpha channel into the RGBA buffer according to the mask, and
// optionally soften the cut edge.
//
// `softness` is the number of rings of still-opaque pixels adjacent to the
// transparent region that get a partial alpha. Without it the cut is
// binary and the anti-aliased fringe that was baked into the source (a
// blend of the outline and the backdrop) stays fully opaque, which reads
// as a light halo when the sprite is drawn over a dark desktop.
function applyMask(rgba, mask, width, height, softness) {
  const total = width * height;
  const rings = Math.max(0, Math.min(4, Math.round(softness || 0)));

  // coverage[i]: 0 = fully transparent, 255 = fully opaque.
  const coverage = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) coverage[i] = mask[i] ? 0 : 255;

  for (let ring = 1; ring <= rings; ring += 1) {
    // Ring 1 keeps the most alpha, the outermost ring fades the most.
    const floor = Math.round((255 * (rings - ring + 1)) / (rings + 1));
    const snapshot = coverage.slice();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (coverage[i] <= floor) continue;
        // Does this pixel touch a more-transparent neighbour?
        let touches = false;
        if (x > 0 && snapshot[i - 1] < coverage[i]) touches = true;
        else if (x < width - 1 && snapshot[i + 1] < coverage[i]) touches = true;
        else if (y > 0 && snapshot[i - width] < coverage[i]) touches = true;
        else if (y < height - 1 && snapshot[i + width] < coverage[i]) touches = true;
        if (touches) coverage[i] = floor;
      }
    }
  }

  for (let i = 0; i < total; i += 1) rgba[i * 4 + 3] = coverage[i];
}

// ---------------------------------------------------------------------
// Speck removal: the "small black dots" left behind by the cut
// ---------------------------------------------------------------------
//
// The problem
// -----------
// The flood stops at the first pixel it cannot walk through, so any
// *small* region of the backdrop that happens to be enclosed by
// expensive pixels — or that sits behind a thin strand of the
// character's dark line art — survives the cut and shows up as a
// little black dot on the sprite.
//
// These are the classic leftovers of a magic-wand style cut: a
// handful of isolated dark pixels, a couple of pixels wide, scattered
// over the character's outline.
//
// The rule
// --------
// A speck is a small region of pixels that still look like *backdrop*
// but that the cut kept. Two things define it:
//
//   (a) its colour is close to the backdrop colour, and
//   (b) it is small.
//
// Condition (a) is what makes this safe and condition (b) is what
// makes it useful.
//
// On colour alone the rule would be catastrophic — a character with a
// black costume on a black backdrop is *entirely* backdrop-coloured,
// and a threshold would delete the whole sprite. The area limit is
// what prevents that: the costume is large, and a speck is small by
// definition.
//
// The subtlety is that a speck is often *not* a separate connected
// component. A 3x3 black dot inside the character's face is
// 8-connected to the pixels around it, so a component labelling finds
// nothing. The speck is detected by its *colour* and its *size*, not
// by its connectivity.
//
// But a colour test alone would also delete a 3x3 patch of the
// character's own dark line art — a pupil, an eye, a button. Those are
// indistinguishable from a speck by colour and size alone.
//
// The separator is the same one the rest of the pipeline uses: the
// *gradient*. A speck is flat backdrop-coloured material; a pupil is
// the middle of a drawing, so it sits on a strong edge and is
// surrounded by detail. A speck's neighbourhood is uniform.
//
// So the rule is: a kept pixel is a speck candidate when it is close
// to the backdrop colour *and* flat. The candidates are then grouped
// into blobs, and a blob qualifies only if it is small.
//
// The size limit is what keeps this safe. A component that is part of
// the character — a thin antenna, a stray hair, a sword tip — is
// disconnected from the body too, but it is usually *long*, so it
// clears the area limit. A speck is small in area by definition.
//
// The limit is absolute (in pixels) rather than a ratio, because a
// speck's size is a property of the *noise*, not of the artwork: it
// is the same handful of pixels whether the frame is 200x200 or
// 4000x4000. It is scaled mildly by the frame's short side so that a
// 4K frame does not sprout dots that a 200px frame would not have.
//
// The order matters
// -----------------
// This runs *after* the cut and *after* the hole repair. The hole
// repair closes transparent regions that are enclosed by the
// character; a speck is the opposite — it is a background-coloured
// region that the cut kept — so the two passes cannot fight. But the
// speck pass has to run after the repair, because the repair may
// turn a speck-sized region of the *background* into an opaque patch,
// and that patch is then a speck we want gone.
//
// Returns { removed, components } — the number of pixels made
// transparent and the number of speck components that were found.
function removeSpecks(rgba, width, height, { maxArea, bg, tolerance } = {}) {
  const total = width * height;
  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];

  // Without a backdrop colour there is no way to tell a speck from the
  // character's own material, so nothing is removed.
  const backdrop = bg && bg.length >= 3 ? bg : null;
  if (!backdrop) return { removed: 0, components: 0, skipped: 'no-backdrop' };

  // The colour tolerance, in 0..255 units. A speck is background
  // material, so it is judged by the same yardstick as the rest of the
  // pipeline.
  const limit = Number.isFinite(tolerance)
    ? Math.max(0, tolerance)
    : DEFAULT_SPECK_TOLERANCE;

  // The size limit. The default is small enough that only noise
  // qualifies, and it scales gently with the frame so a big frame
  // tolerates a slightly bigger dot.
  const shortSide = Math.min(width, height);
  const areaLimit = Number.isFinite(maxArea)
    ? Math.max(1, Math.round(maxArea))
    : Math.max(16, Math.round(shortSide * 0.02));

  // The candidate set: kept pixels that are close to the backdrop
  // colour.
  //
  // The gradient is *not* tested here. A 3x3 speck sitting on a
  // bright character has a gradient of 520 on its eight boundary
  // pixels and 0 only in its centre, so a per-pixel gradient gate
  // would keep the speck and remove only its middle — leaving a ring
  // of eight black pixels, which is worse than the original dot.
  //
  // The gradient is measured on the blob as a whole instead, below.
  const candidate = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (rgba[i * 4 + 3] === 0) continue;
    if (colorDistance(rgba, i, backdrop) > limit) continue;
    candidate[i] = 1;
  }

  // Group the candidates into blobs and keep the small ones.
  const { labels, componentCount } = labelBlobs(candidate, width, height);
  if (componentCount === 0) return { removed: 0, components: 0, limit: areaLimit };

  const sizes = new Int32Array(componentCount);
  for (let i = 0; i < total; i += 1) {
    const l = labels[i];
    if (l >= 0) sizes[l] += 1;
  }

  // Is a blob a speck or the character's own dark detail?
  //
  // A speck is flat material — a patch of backdrop colour that the cut
  // happened to keep. The character's own dark detail (a pupil, a
  // button, a strand of hair) is part of a *drawing*: it has strong
  // edges around it, and it is surrounded by detail.
  //
  // The test is therefore on the blob's *interior* — the pixels whose
  // whole neighbourhood is inside the blob. A speck big enough to have
  // an interior is a flat patch, so its interior gradient is low. A
  // pupil is 3x3 and has no interior at all, so the test cannot
  // condemn it — the area limit handles that case, and the detail
  // around it is what makes it survive.
  //
  // Measured on a real frame, a speck's interior gradient is under 30
  // while a saturated edge runs 460-675.
  const lum = smoothLuminance(computeLuminancePlane(rgba, width, height), width, height);
  const grad = computeSobelGradient(lum, width, height);

  const speck = new Uint8Array(total);
  let removed = 0;
  let components = 0;

  for (let l = 0; l < componentCount; l += 1) {
    if (sizes[l] > areaLimit) continue;

    // Collect the blob's interior pixels and their gradient.
    let interior = 0;
    let gradientSum = 0;
    for (let i = 0; i < total; i += 1) {
      if (labels[i] !== l) continue;
      const x = i % width;
      const y = (i - x) / width;
      // Is the whole 8-neighbourhood inside the blob?
      let enclosed = true;
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NX[k];
        const ny = y + NY[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) { enclosed = false; break; }
        if (labels[ny * width + nx] !== l) { enclosed = false; break; }
      }
      if (!enclosed) continue;
      interior += 1;
      gradientSum += grad[i];
    }

    // A blob with no interior is 1-2 px across: too small to be worth
    // judging, and small enough to be a speck by definition.
    // A blob with an interior has to be flat to count.
    if (interior > 0 && gradientSum / interior > DEFAULT_SPECK_MAX_GRADIENT) continue;

    for (let i = 0; i < total; i += 1) {
      if (labels[i] !== l) continue;
      speck[i] = 1;
      removed += 1;
    }
    components += 1;
  }

  if (removed > 0) {
    for (let i = 0; i < total; i += 1) {
      if (speck[i]) rgba[i * 4 + 3] = 0;
    }
  }

  return { removed, components, limit: areaLimit };
}

// ---------------------------------------------------------------------
// Boundary expansion: eat the dark rim left around the character
// ---------------------------------------------------------------------
//
// The tolerance
// -------------
// The expansion's colour gate is derived from the cost ceiling the cut
// was made with, so that the two knobs stay consistent: a "strict" cut
// gets a strict expansion, a "loose" cut gets a loose one.
//
// The cost field's colour term is `Db/255` and its gradient term is
// `LE * G/GMAX`. A ceiling of 0.12 therefore admits a colour distance
// of up to 0.12*255 = 31 on flat pixels, plus whatever the gradient
// allows on edges. The expansion has no gradient term — it only looks
// at the colour — so it uses a slightly wider tolerance to cover the
// blend ramp the flood stopped short of.
//
// The mapping is linear from the ceiling's colour allowance up to the
// measured default, which keeps "strict" at roughly half of "loose".
function expandToleranceFor(ceiling) {
  const c = Number.isFinite(ceiling) ? ceiling : DEFAULT_CEIL;
  // 0.09 (strict) -> 45, 0.12 (normal) -> 60, 0.14 (loose) -> 70.
  const scaled = (c - 0.09) / (0.14 - 0.09);
  return Math.round(
    Math.max(20, Math.min(80, 45 + scaled * (DEFAULT_EXPAND_TOLERANCE - 45))),
  );
}

// The problem
// -----------
// The flood stops at the first pixel it cannot walk through, which on
// real artwork is the *anti-aliased fringe* — the band where the
// backdrop blends into the character's edge. That band survives the
// cut, and on a dark backdrop it is a dark rim: a black halo that
// follows the character's silhouette.
//
// It is a real artefact and not a rounding error. Measured on a real
// 432x576 frame, the pixels the cut *keeps* right at the boundary are:
//
//   depth 1-2   luminance 0        — pure black
//   depth 3-4   luminance 22..161  — the blend ramp
//   depth 5+    luminance 200+      — the character's own body
//
// So the sprite comes out wearing a black outline the artwork never
// had.
//
// The fix
// -------
// Grow the transparent region outward by a few pixels so the fringe
// is swallowed too.
//
// But growing it *unconditionally* is destructive: 5 px of the
// character would be eaten along its entire silhouette, which on a
// 432x576 sprite is a visible dent in every limb and facial feature.
//
// Why a per-pixel colour gate is not enough
// ------------------------------------------
// The obvious gate is "remove pixels close to the backdrop colour".
// It does not work, and the measurement says why.
//
// On the reference frame the kept pixels at depth 3 and 4 — the
// ambiguous band, half blend and half body — have these distances to
// the backdrop:
//
//   depth 3   p10=0  p25=0  p50=34  p75=76  p90=127
//   depth 4   p10=0  p25=0  p50=33  p75=57  p90=103
//
// Half of each band is at distance 0 and half is at 100+. No single
// threshold separates them: pick 60 and you keep half the blend;
// pick 20 and you keep half the character's edge. The blend and the
// body *overlap completely* in colour, because a blend between black
// and a bright body passes through every colour in between.
//
// The rule that does work
// -----------------------
// The flood already made the right call; it just stopped a little
// early, and the reason it stopped is the *gradient* term.
//
// The cost of a pixel is `Db/255 + LE * min(1, G/GMAX)`. The rim is
// expensive almost entirely because of its gradient — it is the band
// where the backdrop meets the character, so it is an edge by
// definition. Its *colour* term is nearly zero.
//
// So the expansion re-runs the same connectivity question with the
// gradient term switched off: flood outward from the already-known
// background, through pixels whose **colour alone** is close enough to
// the backdrop, and no further than `expand` pixels.
//
// Two things make this safe:
//
//   1. The colour gate. The character's own material is not close to
//      the backdrop colour, so the flood cannot walk into it. On the
//      reference frame the body's edge sits at distance 67+ while the
//      rim sits at 0-56.
//
//   2. Connectivity. The flood starts from the background and stops at
//      the first pixel that fails the colour test. Even where a blend
//      pixel is dark enough to pass the test, the flood has to *reach*
//      it through other passing pixels. The character's edge is
//      bright, so it forms a wall the flood never crosses. This is
//      the same invariant that protects the character in the original
//      cut, applied with a weaker gate.
//
// The `expand` radius bounds the damage if the wall is broken
// somewhere: at most `expand` pixels of the character can be lost per
// boundary, rather than the whole costume.
//
// Returns { removed } — the number of pixels that were added to the
// transparent region.
function expandBoundary(rgba, mask, width, height, { expand, bg, tolerance } = {}) {
  const total = width * height;
  const reach = Number.isFinite(expand)
    ? Math.max(0, Math.round(expand))
    : DEFAULT_EXPAND_PX;
  if (reach <= 0) return { removed: 0, reach: 0 };

  // Without a backdrop colour there is no gate, so nothing is expanded.
  const backdrop = bg && bg.length >= 3 ? bg : null;
  if (!backdrop) return { removed: 0, reach, skipped: 'no-backdrop' };

  // The colour tolerance, in 0..255 units.
  const limit = Number.isFinite(tolerance)
    ? Math.max(0, tolerance)
    : DEFAULT_EXPAND_TOLERANCE;

  // Distance from every pixel to the nearest already-transparent pixel.
  //
  // The transparent region is the seed set, so a kept pixel's distance
  // is exactly how far it sits from the cut. A pixel at distance d is
  // within the expansion radius when d <= reach.
  const dist = distanceToBackground(mask, width, height);

  // Flood outward from the background through pixels that are close to
  // the backdrop colour, up to `reach` pixels deep.
  //
  // The background itself is the seed set, so the flood starts exactly
  // where the original cut stopped.
  const reached = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const push = (i) => {
    if (reached[i]) return;
    if (mask[i] === 1) { reached[i] = 1; stack[sp] = i; sp += 1; return; }
    // The colour gate: how much backdrop is still in this pixel.
    if (colorDistance(rgba, i, backdrop) > limit) return;
    // The radius: never walk further than `reach` from the cut.
    if (dist[i] > reach) return;
    reached[i] = 1;
    stack[sp] = i;
    sp += 1;
  };

  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1) { reached[i] = 1; stack[sp] = i; sp += 1; }
  }

  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
  while (sp > 0) {
    sp -= 1;
    const idx = stack[sp];
    const x = idx % width;
    const y = (idx - x) / width;
    for (let k = 0; k < 8; k += 1) {
      const nx = x + NX[k];
      const ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      push(ny * width + nx);
    }
  }

  let removed = 0;
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 1) continue;
    if (!reached[i]) continue;
    mask[i] = 1;
    removed += 1;
  }

  return { removed, reach, tolerance: limit };
}

// Encode an RGBA buffer to a PNG file.
//
// ffmpeg's PNG encoder does write the alpha channel, so no separate PNG
// chunk writer is needed. Windows ffmpeg won't emit PNG to a pipe, so this
// needs a real path — same constraint documented in png_colorkey.js.
// Renaming the temp file last means a failed encode never clobbers an
// existing file.
async function encodePng(rgba, width, height, outPath, { cancelCheck } = {}) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.cutout-${crypto.randomBytes(6).toString('hex')}.png`);
  try {
    await runFfmpeg(
      ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0',
        '-c:v', 'png', '-pix_fmt', 'rgba', tmpPath],
      { input: rgba, cancelCheck },
    );
    if (typeof cancelCheck === 'function' && cancelCheck()) {
      try { fs.unlinkSync(tmpPath); } catch {}
      const e = new Error('cancelled');
      e.killed = true;
      throw e;
    }
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------
// The shared cutout pipeline
// ---------------------------------------------------------------------

// Run the whole cutout on an RGBA buffer.
//
//   rgba       — RGBA bytes, modified in place (the alpha channel is written)
//   width/height — image dimensions
//   ceiling    — cost ceiling, 0..1. See `main/png_bottleneck_flood.js`.
//                Omit to use the default ("normal" preset).
//   softness   — 0..4 edge-feathering ring count
//   repair     — close holes the cut left inside the character
//   defringe   — strip the white "sticker" outline
//   expand     — grow the cut outward to swallow the dark rim (px)
//   speck      — remove isolated small leftover blobs
//   cancelCheck— () => boolean, polled between the heavy steps
//
// The six steps run in a fixed order, and the order is load-bearing:
//
//   1. buildBottleneckMask — decide what is background. The background is
//      the set of pixels that can be walked to from the image edge without
//      passing through a pixel whose cost exceeds the ceiling.
//
//   2. applyMask — write the alpha channel and feather the cut.
//
//   3. defringeOutline — strip the white "sticker" stroke. It has to run
//      *after* the cut, because it works by looking at the bright band
//      that hugs the cut, and *before* the repair, because the repair
//      would otherwise fill the stroke straight back in.
//
//   4. expandBoundary — grow the cut outward by a few pixels so the dark
//      anti-aliased rim the flood left behind is swallowed. It has to run
//      *after* the defringe: the defringe locates the stroke by its
//      distance from the cut, so if the cut had already grown into the
//      stroke band, the stroke would be found at the wrong depth and the
//      halo would survive.
//
//   5. repairHoles — close the transparent regions that sit *inside* the
//      character's silhouette, so the character can never come out
//      hollow.
//
//   6. removeSpecks — make the isolated small leftover blobs transparent.
//      It runs last, because the repair above may turn a speck-sized
//      patch of background into an opaque blob, and that blob is exactly
//      the kind of speck this pass exists to remove.
//
// Returns the mask plus the statistics both entry points report.
function runCutoutPipeline(rgba, width, height, {
  ceiling, softness = 0, repair = true, defringe = true,
  expand = DEFAULT_EXPAND_PX, speck = true, cancelCheck,
} = {}) {
  const cancelled = () => {
    try { return !!(cancelCheck && cancelCheck()); } catch { return false; }
  };

  const usedCeiling = Number.isFinite(ceiling) ? ceiling : DEFAULT_CEIL;

  const { mask, transparentPixels, backgroundColor, ceiling: effectiveCeiling } =
    buildBottleneckMask(rgba, width, height, { ceiling: usedCeiling, cancelCheck });
  if (transparentPixels === 0) {
    const err = new Error('未识别到背景：请确认背景与主体颜色差异明显，必要时放宽「切割强度」');
    err.noBackground = true;
    throw err;
  }
  if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

  // Soft cut: the anti-aliased outline between the character and the
  // backdrop becomes a partial-alpha ramp instead of a hard edge, so the
  // character's exact silhouette is preserved.
  applyMask(rgba, mask, width, height, softness);

  let defringed = 0;
  if (defringe) {
    const d = defringeOutline(rgba, mask, width, height);
    defringed = d.removed;
  }
  if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

  // Grow the cut outward so the dark anti-aliased rim around the
  // character is swallowed instead of showing up as a black halo.
  //
  // The gate is the distance to the backdrop colour, and it is derived
  // from the ceiling the cut was made with so the two agree: a tighter
  // cut means a tighter expansion.
  let expanded = 0;
  if (expand > 0) {
    const e = expandBoundary(rgba, mask, width, height, {
      expand,
      bg: backgroundColor,
      tolerance: expandToleranceFor(effectiveCeiling),
    });
    expanded = e.removed;
    // The mask changed, so the alpha channel has to be rewritten — the
    // expansion only moved the *mask*, not the pixels.
    if (expanded > 0) applyMask(rgba, mask, width, height, softness);
  }
  if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

  let repaired = 0;
  if (repair) {
    const r = repairHoles(rgba, width, height);
    repaired = r.repaired;
  }

  let specked = 0;
  let speckComponents = 0;
  if (speck) {
    const s = removeSpecks(rgba, width, height, {
      bg: backgroundColor,
      tolerance: expandToleranceFor(effectiveCeiling),
    });
    specked = s.removed;
    speckComponents = s.components;
  }

  return {
    mask,
    backgroundColor,
    transparentPixels,
    total: width * height,
    ceiling: effectiveCeiling,
    requestedCeiling: usedCeiling,
    repairedPixels: repaired,
    defringedPixels: defringed,
    expandedPixels: expanded,
    speckedPixels: specked,
    speckComponents,
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

// Cut the background out of an image file and write a transparent PNG.
//
//   inputPath   — absolute path to the source image
//   outPath     — absolute path the RGBA PNG is written to
//   ceiling     — 0..1 cost ceiling; omit for the default ("normal") preset
//   softness    — 0-4 edge-feathering ring count
//   progressCb  — ({ phase, percent, note }) => void
//   cancelCheck — () => boolean
//
// Returns { width, height, transparentRatio, backgroundColor, bytes }.
async function cutoutToPng({
  inputPath, outPath, ceiling, softness, repair = true, defringe = true,
  expand = DEFAULT_EXPAND_PX, speck = true, progressCb, cancelCheck,
}) {
  const progress = (phase, percent, note) => {
    try {
      if (typeof progressCb === 'function') progressCb({ phase, percent, note: note || null });
    } catch (e) {
      console.error('[png_border_cutout] progressCb threw:', e);
    }
  };
  const cancelled = () => {
    try { return !!(cancelCheck && cancelCheck()); } catch { return false; }
  };

  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('图片文件不存在');

  progress('probing', 0, '正在读取图片');
  const { width, height } = await probeSize(inputPath);
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效');
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `图片太大（${width}×${height}），请先缩小到 ${Math.floor(MAX_PIXELS / 1000 / 1000)} 百万像素以内`,
    );
  }
  if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

  progress('decoding', 10, '正在解码');
  const rgba = await runFfmpeg(
    ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { cancelCheck },
  );
  const expect = width * height * 4;
  if (!rgba || rgba.length !== expect) {
    throw new Error(`解码结果异常（${rgba ? rgba.length : 0} / ${expect} 字节）`);
  }
  if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

  progress('analyzing', 45, '正在识别背景');
  const stats = runCutoutPipeline(rgba, width, height, {
    ceiling, softness, repair, defringe, expand, speck, cancelCheck,
  });
  if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

  progress('encoding', 75, '正在导出 PNG');
  await encodePng(rgba, width, height, outPath, { cancelCheck });

  const transparentRatio = stats.transparentPixels / (width * height);
  progress('done', 100, `已完成，透明区域 ${(transparentRatio * 100).toFixed(1)}%`);
  return {
    width,
    height,
    transparentRatio,
    backgroundColor: stats.backgroundColor,
    ceiling: stats.ceiling,
    requestedCeiling: stats.requestedCeiling,
    repairedPixels: stats.repairedPixels,
    defringedPixels: stats.defringedPixels,
    expandedPixels: stats.expandedPixels,
    speckedPixels: stats.speckedPixels,
    bytes: fs.statSync(outPath).size,
  };
}

// Cut the background out of a PNG *already in memory* and return the
// transparent PNG bytes.
//
// This is the entry point the zip importer uses: the frames come straight
// out of the archive, so there is no file on disk to decode from and no
// reason to write an intermediate file either. The bytes are staged to a
// temp file only because Windows ffmpeg will not read an image from
// `pipe:0`.
async function cutoutPngBuffer(bytes, {
  ceiling, softness, repair = true, defringe = true,
  expand = DEFAULT_EXPAND_PX, speck = true,
} = {}) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('cutoutPngBuffer 需要 Buffer 输入');
  }
  // The minimum legal PNG is 24 bytes (8-byte signature + 4-byte IHDR
  // length + 4-byte type + 8-byte width/height). Anything shorter would
  // hang ffmpeg waiting for a valid PNG header.
  if (bytes.length < 24) {
    throw new Error('PNG 太小，无法透明化');
  }

  // `ceiling` is deliberately left undefined here so every frame is cut
  // with the default ("normal") preset. The cost-ceiling formulation is
  // what makes that safe: a fixed *colour* tolerance is what used to eat
  // the character's black costume on a black backdrop, while a fixed cost
  // ceiling cannot reach past the character's outline.

  const nonce = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `cutout-in-${nonce}.png`);
  const outPath = path.join(tmpDir, `cutout-out-${nonce}.png`);

  const cleanup = () => {
    try { fs.unlinkSync(inPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
  };

  try {
    fs.writeFileSync(inPath, bytes);
  } catch (err) {
    throw new Error(`写入临时 PNG 失败：${err.message}`);
  }

  try {
    const { width, height } = await probeSize(inPath);
    if (width <= 0 || height <= 0) throw new Error('图片尺寸无效');
    if (width * height > MAX_PIXELS) {
      throw new Error(
        `图片太大（${width}×${height}），请先缩小到 ${Math.floor(MAX_PIXELS / 1000 / 1000)} 百万像素以内`,
      );
    }

    const rgba = await runFfmpeg(
      ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    );
    const expect = width * height * 4;
    if (!rgba || rgba.length !== expect) {
      throw new Error(`解码结果异常（${rgba ? rgba.length : 0} / ${expect} 字节）`);
    }

    let stats;
    try {
      stats = runCutoutPipeline(rgba, width, height, {
        ceiling, softness, repair, defringe, expand, speck,
      });
    } catch (err) {
      if (err && err.noBackground) {
        // Nothing to remove — the frame is already fully opaque artwork, or
        // the backdrop doesn't match what we estimated. Returning the input
        // unchanged is the right call here: we are only removing a backdrop
        // that a *solid* colorkey would have eaten into the character with.
        return bytes;
      }
      throw err;
    }

    await encodePng(rgba, width, height, outPath);
    return fs.readFileSync(outPath);
  } finally {
    cleanup();
  }
}

module.exports = {
  cutoutToPng,
  cutoutPngBuffer,
  runCutoutPipeline,
  estimateBorderColor,
  collectBorderSamples,
  applyMask,
  defringeOutline,
  chooseDefringeLevel,
  measureBodyLevel,
  distanceToBackground,
  expandBoundary,
  expandToleranceFor,
  removeSpecks,
  repairHoles,
  findEnclosedHoles,
  fillHolesWithColor,
  MAX_PIXELS,
  DEFAULT_EXPAND_PX,
  DEFAULT_EXPAND_TOLERANCE,
  getFfmpegPath,
  // Shared with main/image_bg_remove.js, which reuses the same ffmpeg helpers.
  _internal: { runFfmpeg, probeSize },
};
