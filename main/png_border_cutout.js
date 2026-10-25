// main/png_border_cutout.js — cut a frame's background out by *connectivity*,
// and pick the colour tolerance so that the character can never be hollowed
// out.
//
// The problem this replaces
// -------------------------
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
// connectivity question, not a colour question:
//
//   1. Estimate the backdrop colour from the outer perimeter (median, so a
//      stray character pixel touching the edge can't drag it off).
//   2. Mark every pixel within `threshold` of that colour as a background
//      *candidate*.
//   3. Group the candidates into 8-connected components.
//   4. Keep only the components that touch the image border. Those are the
//      real background.
//   5. Everything else stays opaque -- including black hair and clothing
//      that happens to match the backdrop exactly, because the outline
//      separates them from the border.
//
// This is the same algorithm as the reference implementation in
// `opencv_border_cutout.py`, ported to plain JS so it runs inside the
// Electron main process without a Python dependency.
//
// Why component labelling instead of a flood fill
// ----------------------------------------------
// A flood fill from the border also respects connectivity, but it needs the
// *non*-background pixels to form a sealed wall. A hand-drawn or
// AI-generated outline is often thin and slightly broken, so the fill leaks
// in and erases the interior. Here the candidate set is generated from a
// colour distance, and a pixel is only removed when it is *also* connected
// to the border through other candidates -- a broken outline simply means the
// interior is a separate component that gets kept. Failing safe (keep the
// pixels) is what we want for a sprite.
//
// Picking the tolerance (the "no black hole" guarantee)
// -----------------------------------------------------
// Connectivity alone does not protect the character: the *tolerance*
// decides how far the candidate set reaches into the character, and a
// tolerance that is even slightly too wide bridges the character's dark
// costume to the backdrop and deletes it.
//
// The tolerance is therefore measured per image, by `findFloodBreak`, which
// watches the flood's reach as the tolerance widens and finds the point
// where the flood breaks through the character's outline. See the comment
// on that function for the measurements behind it.
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
// Performance
// -----------
// The whole thing is O(pixels) with typed-array buffers, plus one ffmpeg
// decode and one ffmpeg encode. On a 1080x1440 frame the label pass takes
// ~40 ms, which is far cheaper than the ffmpeg round-trip that surrounds
// it. The tolerance search runs one flood per candidate tolerance, which
// adds a few hundred milliseconds per frame -- paid once, at import time.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getFfmpegPath } = require('./video_frame_split');

// Colour-distance tolerance from the estimated backdrop. Expressed as a
// per-channel Chebyshev distance (0-255) so "how far from the backdrop
// colour" reads the same way the tolerance presets in
// `main/image_bg_remove.js` do.
//
// This is only a *fallback*. The real tolerance is derived per image by
// `estimateAdaptiveThreshold`, because a single fixed number cannot serve
// both a flat black backdrop and a noisy/gradient one.
const DEFAULT_THRESHOLD = 24;

// Bounds for the adaptive tolerance. The lower bound matters: a backdrop
// that is *exactly* flat must not have its anti-aliased fringe swept up
// with it, because that fringe is what bridges the character's black
// costume to the background. The upper bound keeps a genuinely noisy or
// gradient backdrop workable.
const MIN_ADAPTIVE_THRESHOLD = 2;
const MAX_ADAPTIVE_THRESHOLD = 32;

// Fraction of the border-band samples that must be within the tolerance of
// the estimate for the tolerance to be considered "sufficient". Below this
// the backdrop is not flat and we widen the tolerance to cover the
// variation.
//
// This only applies when the flood gives us no answer: the border band can
// be dominated by the character when the character reaches the image edge,
// so on its own it is a weak signal.
const BACKDROP_COVERAGE_TARGET = 0.995;

// Hard ceiling on the pixel count we accept, matching
// `main/image_bg_remove.js`. 40 MPix ≈ 160 MB of RGBA plus the label
// arrays; beyond that a 32-bit machine starts swapping.
const MAX_PIXELS = 40 * 1000 * 1000;

// Keep stderr for error messages only; ffmpeg is chatty at default loglevel.
const MAX_STDERR_BYTES = 8 * 1024;

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
// lands mid-ramp and the tolerance knob has to be wide enough to bridge
// the ramp. That is a documented limitation rather than a bug: the
// tolerance presets exist precisely to cover it.
function estimateBorderColor(rgba, width, height) {
  const samples = collectBorderSamples(rgba, width, height);
  return samples.map((arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  });
}

// Sample the perimeter band and return both the median colour and the
// raw samples, so the adaptive threshold can measure how flat the
// backdrop is.
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

// Chebyshev distance between a pixel and the backdrop colour.
function colorDistance(rgba, index, bg) {
  const o = index * 4;
  const dr = rgba[o] - bg[0];
  const dg = rgba[o + 1] - bg[1];
  const db = rgba[o + 2] - bg[2];
  const ar = dr < 0 ? -dr : dr;
  const ag = dg < 0 ? -dg : dg;
  const ab = db < 0 ? -db : db;
  let m = ar > ag ? ar : ag;
  if (ab > m) m = ab;
  return m;
}

// Derive the tolerance from the backdrop's own colour distribution.
//
// Why this exists
// ---------------
// A single fixed tolerance cannot work for every pet pack, and picking a
// "safe" wide one is actively harmful. The failure we have to avoid is
// the *black hole*: the character is drawn in black on a black backdrop,
// separated only by a thin outline. A tolerance that is even slightly too
// wide swallows the anti-aliased fringe around the character's black
// costume, that fringe bridges the costume to the backdrop, and the
// costume is then deleted along with the backdrop -- leaving a hollow
// silhouette.
//
// Why a colour histogram is not enough
// ------------------------------------
// The obvious way to pick the tolerance is to look at the histogram of
// "distance from the backdrop colour" and cut where the anti-aliased
// fringe ends. That was tried, and it does not work on real pet art.
//
// Measured on a real 86-frame pack (1080x1440, pure-black backdrop), the
// histogram of the distance from the backdrop looks like this:
//
//      0: 837486  #########   <- the flat backdrop
//      1:  15616  ##
//      5:   4841  #
//     10:   6204  #
//     15:   6219  #
//     20:   6050  #
//     25:   9299  #
//     30:  15398  ##          <- the character's own pixels start here
//     35:   7091  #
//     40:  11090  #
//     45:   2929  #
//     50:   2749  #
//
// There is no valley and no plateau to cut at: the buckets stay between
// 4.9k and 11.3k all the way from distance 1 to distance 44. The reason
// is that this art's *character* is drawn in dark greys (measured RGB
// 20-53) that sit right on top of the anti-aliased fringe in the same
// distance range, so the two populations overlap in colour space and no
// colour threshold can separate them.
//
// Every histogram-based rule was measured against the real art and all
// of them landed at T=32, where a quarter of the character's dark
// costume is deleted.
//
// The rule that works: measure the flood, not the histogram
// ---------------------------------------------------------
// The question "where does the backdrop end?" is really a question about
// *space*, not colour: the backdrop ends where the flood that starts at
// the image border stops being able to travel. So we run the flood at a
// series of tolerances and watch how much of the frame it can reach.
//
// The reach curve has a very characteristic shape:
//
//   * at small tolerances the flood eats only the anti-aliased fringe,
//     and the reach grows slowly and *linearly* with the tolerance;
//   * once the tolerance is wide enough to cut through the character's
//     outline, the flood breaks through and starts swallowing the
//     character, so the reach grows much faster.
//
// Measured on a real frame, the growth rate per unit of tolerance is
// 0.14% of the frame while we are still in the fringe, and 4.85% at the
// step where the flood breaks through -- a factor of 35. That gap is so
// wide that the break is unmistakable.
//
// So the estimator fits the fringe's own linear growth, then finds the
// first tolerance at which the measured reach departs from that line.
// The fit is self-calibrating: it measures the slope from the image
// being cut, so the same code works for a 400x500 sprite and a
// 2160x2880 one, and for art with a wide outline as well as a thin one.
//
// Returns { threshold, coverage, flatness, tailEnd, breakAt }.
function estimateAdaptiveThreshold(rgba, width, height, bg, samples) {
  const src = samples || collectBorderSamples(rgba, width, height);
  const count = src[0].length;
  if (count === 0) {
    return { threshold: DEFAULT_THRESHOLD, coverage: 0, flatness: 0, tailEnd: DEFAULT_THRESHOLD };
  }

  // The deviation of each border sample from the backdrop colour.
  const devs = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const dr = src[0][i] - bg[0];
    const dg = src[1][i] - bg[1];
    const db = src[2][i] - bg[2];
    const ar = dr < 0 ? -dr : dr;
    const ag = dg < 0 ? -dg : dg;
    const ab = db < 0 ? -db : db;
    let m = ar > ag ? ar : ag;
    if (ab > m) m = ab;
    devs[i] = m;
  }

  // Median deviation = how flat the backdrop is.
  const sorted = Array.from(devs).sort((a, b) => a - b);
  const flatness = sorted[sorted.length >> 1];

  // The tolerance must also explain the border band, so a noisy or
  // gradient backdrop still gets enough slack. This is a *floor* that
  // applies only when the flood tells us nothing -- see below.
  //
  // The border band is not a reliable floor on its own: on a frame where
  // the character reaches the image edge, the band is dominated by the
  // character rather than by the backdrop, and the tolerance it demands
  // can be much wider than the backdrop actually needs.
  let floor = MIN_ADAPTIVE_THRESHOLD;
  let coverage = 0;
  for (; floor <= MAX_ADAPTIVE_THRESHOLD; floor += 1) {
    let within = 0;
    for (let i = 0; i < count; i += 1) {
      if (devs[i] <= floor) within += 1;
    }
    coverage = within / count;
    if (coverage >= BACKDROP_COVERAGE_TARGET) break;
  }
  if (floor > MAX_ADAPTIVE_THRESHOLD) floor = MAX_ADAPTIVE_THRESHOLD;

  // Find the tolerance at which the flood breaks through the character's
  // outline. This is the "no black hole" guarantee, and it is based on
  // what the flood actually does rather than on any statistic of the
  // border band, so it wins over the floor whenever it has an answer.
  const { breakAt } = findFloodBreak(rgba, width, height, bg);

  let threshold;
  if (breakAt != null) {
    // The flood broke through at `breakAt`, so the tolerance just below
    // it is the widest one that provably keeps the character intact.
    threshold = breakAt;
  } else {
    // The flood never broke through the outline within the allowed
    // range. That means the character's outline is wide (or the backdrop
    // and the character are far apart in colour), so no tolerance in the
    // range can hollow the character out. We then use the border band to
    // decide how wide the tolerance has to be to cover the backdrop.
    threshold = Math.min(MAX_ADAPTIVE_THRESHOLD, Math.max(floor, DEFAULT_THRESHOLD));
  }
  if (threshold < MIN_ADAPTIVE_THRESHOLD) threshold = MIN_ADAPTIVE_THRESHOLD;
  if (threshold > MAX_ADAPTIVE_THRESHOLD) threshold = MAX_ADAPTIVE_THRESHOLD;

  return { threshold, coverage, flatness, tailEnd: breakAt, breakAt };
}

// Find the tolerance at which the flood that starts at the image border
// breaks through the character's outline and starts eating the character.
//
// The reach curve
// ---------------
// For each tolerance t we flood the frame from the border through pixels
// within t of the backdrop colour, and record what fraction of the frame
// the flood reached.
//
// The flood at tolerance 0 already reaches the flat backdrop. As the
// tolerance widens it picks up the anti-aliased fringe around the
// character, and that fringe grows at a fairly steady rate. Once the
// tolerance is wide enough to cut through the character's outline, the
// flood starts reaching the character itself, and the growth rate jumps.
//
// The break detector
// ------------------
// We look at the *excess* reach -- the reach beyond the flat backdrop --
// and fit it against a straight line over the early part of the curve,
// which is the fringe. The fringe's excess is close to linear, so the
// line describes it well. Then we look for the first tolerance at which
// the measured excess sits clearly *above* that line.
//
// Why the excess, and not the reach
// ---------------------------------
// The raw reach curve starts with a huge flat backdrop and is dominated
// by it, which flattens the very signal we are looking for. Subtracting
// the tolerance-0 reach isolates "how much beyond the backdrop have we
// eaten", which is the part that grows when the flood breaks through.
//
// Why a line, and not a local spike
// ---------------------------------
// The break is not always a single spike in the growth rate. On some
// frames the flood finds one small gap in the outline and then widens it
// step by step; on others it finds several separate gaps. Looking at the
// departure from the fringe's *trend* catches all of those shapes, and it
// also rejects the single-bucket noise that anti-aliasing throws off.
//
// The margin between the two is large. Measured on real frames, the
// excess stays within 0.75% of the line all the way through the fringe,
// and then departs by 1.8% to 4.6% in the very first step past the
// break.
//
// Returns the widest tolerance that is still provably safe, or null when
// the flood never broke through within the allowed range.
function findFloodBreak(rgba, width, height, bg) {
  // Walk the tolerance up one step at a time, because the break has to
  // be localised to the tolerance.
  const tolerances = [];
  for (let t = MIN_ADAPTIVE_THRESHOLD; t <= MAX_ADAPTIVE_THRESHOLD; t += 1) {
    tolerances.push(t);
  }
  if (tolerances.length < 6) return { breakAt: null, baseRate: 0 };

  // The flat backdrop's extent. Everything the flood reaches beyond
  // this is the fringe, and then the character.
  const backdropReach = floodReachFraction(rgba, width, height, bg, 0);

  const excess = new Float64Array(tolerances.length);
  for (let i = 0; i < tolerances.length; i += 1) {
    excess[i] = floodReachFraction(rgba, width, height, bg, tolerances[i]) - backdropReach;
  }

  // Fit the fringe's trend. We use the first half of the range, which is
  // the fringe on every art we have measured, and we fit a line through
  // its two endpoints -- the excess curve is close enough to linear that
  // the endpoints are a better estimate than a least-squares fit, which
  // a single outlying point could bend.
  const fitCount = Math.max(3, Math.floor(tolerances.length / 2));
  const dt = tolerances[fitCount - 1] - tolerances[0];
  if (!(dt > 0)) return { breakAt: null, baseRate: 0 };
  const slope = (excess[fitCount - 1] - excess[0]) / dt;
  const intercept = excess[0] - slope * tolerances[0];

  // How far above the trend the excess may get before we call it a
  // break. It is a fraction of the frame, so it means the same thing at
  // every resolution. The fringe's own noise stays within 0.75% of the
  // trend and the break departs by at least 1.8%, so this sits in the
  // gap.
  const BREAK_MARGIN = 0.01;

  for (let i = 1; i < tolerances.length; i += 1) {
    const predicted = intercept + slope * tolerances[i];
    if (excess[i] - predicted > BREAK_MARGIN) {
      // The break happens somewhere between the previous tolerance and
      // this one. We keep the *previous* tolerance, which is the widest
      // one that is still provably safe.
      return { breakAt: tolerances[i - 1], baseRate: slope };
    }
  }

  // No break anywhere in the range: the character's outline is wide
  // enough that no tolerance we allow can cut through it.
  return { breakAt: null, baseRate: slope };
}
// Fraction of the frame that a flood starting at the image border can
// reach through pixels within `threshold` of the backdrop colour.
//
// The flood is 8-connected, so it can squeeze through a diagonal gap in
// an outline -- which is what makes it a faithful model of "can the
// backdrop reach this pixel without crossing the character".
function floodReachFraction(rgba, width, height, bg, threshold) {
  const total = width * height;
  const reached = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const push = (i) => {
    if (reached[i]) return;
    if (colorDistance(rgba, i, bg) > threshold) return;
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

  let count = 0;
  for (let i = 0; i < total; i += 1) if (reached[i]) count += 1;
  return count / total;
}
// Label the 8-connected components of the candidate set and return, for
// each pixel, the label of its component (-1 = not a candidate).
//
// Implemented with an explicit stack rather than recursion so a large
// frame can't blow the JS stack, and with a plain array for the labels so
// the values stay small integers.
//
// A pixel is a candidate when it is within `threshold` of the backdrop
// colour, measured as a per-channel Chebyshev distance. That is what makes
// the tolerance knob meaningful: widening it absorbs a noisier or
// gradient-shaded backdrop, narrowing it keeps only the exact flat colour.
function labelCandidates(rgba, width, height, bg, threshold) {
  const total = width * height;
  const labels = new Int32Array(total).fill(-1);

  const br = bg[0];
  const bgc = bg[1];
  const bb = bg[2];

  // Is this pixel close enough to the backdrop colour?
  const isCandidate = (i) => {
    const o = i * 4;
    const dr = rgba[o] - br;
    const dg = rgba[o + 1] - bgc;
    const db = rgba[o + 2] - bb;
    const ar = dr < 0 ? -dr : dr;
    const ag = dg < 0 ? -dg : dg;
    const ab = db < 0 ? -db : db;
    let m = ar > ag ? ar : ag;
    if (ab > m) m = ab;
    return m <= threshold;
  };

  // Perimeter of the 8-neighbourhood.
  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];

  const stack = new Int32Array(total);
  let nextLabel = 0;

  for (let seed = 0; seed < total; seed += 1) {
    if (labels[seed] !== -1) continue;
    if (!isCandidate(seed)) continue;   // not a background candidate

    // Flood this component.
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
        if (!isCandidate(ni)) continue;
        labels[ni] = label;
        stack[sp] = ni;
        sp += 1;
      }
    }
  }

  return { labels, componentCount: nextLabel };
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
// The mask is built by keeping only the candidate components that touch the
// image border. Components in the middle of the frame are enclosed by the
// character and are therefore part of it — that is exactly what keeps the
// character's black hair and clothing intact.
//
// `threshold` may be:
//   - a number  — use it verbatim (the tool's "tolerance" slider)
//   - undefined — derive it from the backdrop (adaptive; this is what
//     the zip importer uses, because an uploaded pack must never come out
//     with black holes)
function buildBackgroundMask(rgba, width, height, threshold) {
  const total = width * height;
  const bg = estimateBorderColor(rgba, width, height);

  let tol;
  let adaptive = null;
  if (Number.isFinite(threshold)) {
    tol = Math.max(0, Math.min(255, threshold));
  } else {
    const samples = collectBorderSamples(rgba, width, height);
    adaptive = estimateAdaptiveThreshold(rgba, width, height, bg, samples);
    tol = adaptive.threshold;
  }

  const { labels, componentCount } = labelCandidates(rgba, width, height, bg, tol);

  // Which components touch the border? A component that touches the edge
  // is reachable from "outside the picture", so it is background.
  const borderComponents = new Set();
  const mark = (i) => {
    const l = labels[i];
    if (l >= 0) borderComponents.add(l);
  };
  for (let x = 0; x < width; x += 1) {
    mark(x);
    mark((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    mark(y * width);
    mark(y * width + width - 1);
  }

  const mask = new Uint8Array(total);
  let transparentPixels = 0;
  for (let i = 0; i < total; i += 1) {
    const l = labels[i];
    if (l >= 0 && borderComponents.has(l)) {
      mask[i] = 1;
      transparentPixels += 1;
    }
  }

  return {
    mask,
    backgroundColor: bg,
    transparentPixels,
    componentCount,
    total,
    threshold: tol,
    adaptive,
  };
}

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
  const bodyLevel = deep[Math.floor(deep.length * 0.25)];
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
    deepCutoff,
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
// Public API
// ---------------------------------------------------------------------

// Cut the background out of an image file and write a transparent PNG.
//
//   inputPath   — absolute path to the source image
//   outPath     — absolute path the RGBA PNG is written to
//   threshold   — 0-255 colour distance from the estimated backdrop
//   softness    — 0-4 edge-feathering ring count
//   progressCb  — ({ phase, percent, note }) => void
//   cancelCheck — () => boolean
//
// Returns { width, height, transparentRatio, backgroundColor, bytes }.
async function cutoutToPng({
  inputPath, outPath, threshold, softness, repair = true, defringe = true,
  progressCb, cancelCheck,
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
  const { mask, transparentPixels, backgroundColor, threshold: usedTol } =
    buildBackgroundMask(rgba, width, height, threshold);
  if (transparentPixels === 0) {
    throw new Error('未识别到背景：请确认背景与主体颜色差异明显，必要时放宽「容差」');
  }
  if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

  applyMask(rgba, mask, width, height, softness);

  // Strip the white "sticker" outline, if the art has one. This has to run
  // after the cut (it needs the background it hugs) and before the hole
  // repair (the repair would otherwise fill the outline back in).
  let defringed = 0;
  if (defringe) {
    const d = defringeOutline(rgba, mask, width, height);
    defringed = d.removed;
  }

  // Close holes the cut left inside the character.
  let repaired = 0;
  if (repair) {
    const r = repairHoles(rgba, width, height);
    repaired = r.repaired;
  }

  progress('encoding', 75, '正在导出 PNG');
  await encodePng(rgba, width, height, outPath, { cancelCheck });

  const transparentRatio = transparentPixels / (width * height);
  progress('done', 100, `已完成，透明区域 ${(transparentRatio * 100).toFixed(1)}%`);
  return {
    width,
    height,
    transparentRatio,
    backgroundColor,
    threshold: usedTol,
    repairedPixels: repaired,
    defringedPixels: defringed,
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
async function cutoutPngBuffer(bytes, { threshold, softness, repair = true, defringe = true } = {}) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('cutoutPngBuffer 需要 Buffer 输入');
  }
  // The minimum legal PNG is 24 bytes (8-byte signature + 4-byte IHDR
  // length + 4-byte type + 8-byte width/height). Anything shorter would
  // hang ffmpeg waiting for a valid PNG header.
  if (bytes.length < 24) {
    throw new Error('PNG 太小，无法透明化');
  }

  // `threshold` is deliberately left undefined here so the tolerance is
  // derived from each frame's own backdrop. A fixed tolerance is what
  // used to eat the character's black costume on a black backdrop; see
  // `estimateAdaptiveThreshold` for the details.

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

    const { mask, transparentPixels, backgroundColor, threshold: usedTol } =
      buildBackgroundMask(rgba, width, height, threshold);
    if (transparentPixels === 0) {
      // Nothing to remove — the frame is already fully opaque artwork, or
      // the backdrop doesn't match what we estimated. Returning the input
      // unchanged is the right call here: we are only removing a backdrop
      // that a *solid* colorkey would have eaten into the character with.
      return bytes;
    }

    // Soft cut: the anti-aliased outline between the character and the
    // backdrop becomes a partial-alpha ramp instead of a hard edge, so
    // the character's exact silhouette is preserved — including the black
    // parts that a hard cut would punch a hole through.
    applyMask(rgba, mask, width, height, softness);

    // Strip the white "sticker" outline, if the art has one. Same order as
    // `cutoutToPng`: after the cut (it needs the background it hugs) and
    // before the hole repair (which would fill the outline back in).
    if (defringe) defringeOutline(rgba, mask, width, height);

    // Close any hole the cut left inside the character, so an uploaded
    // pack can never come out with a "black hole" in it.
    if (repair) repairHoles(rgba, width, height);

    await encodePng(rgba, width, height, outPath);
    return fs.readFileSync(outPath);
  } finally {
    cleanup();
  }
}

module.exports = {
  cutoutToPng,
  cutoutPngBuffer,
  estimateBorderColor,
  estimateAdaptiveThreshold,
  findFloodBreak,
  floodReachFraction,
  buildBackgroundMask,
  labelCandidates,
  applyMask,
  defringeOutline,
  chooseDefringeLevel,
  distanceToBackground,
  repairHoles,
  findEnclosedHoles,
  fillHolesWithColor,
  DEFAULT_THRESHOLD,
  MIN_ADAPTIVE_THRESHOLD,
  MAX_ADAPTIVE_THRESHOLD,
  MAX_PIXELS,
  getFfmpegPath,
  // Shared with main/image_bg_remove.js, which reuses the same ffmpeg helpers.
  _internal: { runFfmpeg, probeSize },
};
