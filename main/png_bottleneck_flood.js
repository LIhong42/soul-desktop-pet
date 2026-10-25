// main/png_bottleneck_flood.js — decide "what is background" with a
// *gradient-aware bottleneck flood* instead of a colour threshold.
//
// The problem this replaces
// -------------------------
// The previous algorithm decided what counts as background with a single
// number: a colour distance from the estimated backdrop ("the tolerance").
// Every pixel within that distance was a background *candidate*, and the
// candidates that could be reached from the image border were removed.
//
// On a black backdrop with a dark character that number is a trap, and it
// cannot be set to a value that is safe for every artwork. The reason is
// that two different populations occupy the *same* distance range:
//
//   - the anti-aliased fringe where the black backdrop meets the character's
//     light "sticker" outline (which we want to remove), and
//   - the character's own black costume (which we must never remove).
//
// Measured on a real 1080x1440 frame (pure-black backdrop, character with a
// white sticker outline), widening the tolerance from 21 to 32 removed an
// extra 118,758 pixels — 7.64% of the whole frame — and the luminance
// histogram of those extra pixels fell *entirely* into the two darkest
// buckets (L<=31). Every single one of them was the character's black
// shorts, vest, hat and wings. The sprite came out riddled with holes.
//
// Why a colour threshold cannot fix this
// --------------------------------------
// The obvious idea is to add the *gradient* as a second criterion: "the
// backdrop is smooth, the outline is an edge, so only remove smooth
// regions". Measured on the same frame, that does not work either:
//
//   gradient of the region a wide tolerance wrongly eats (the costume):
//       p50 = 7.2,  p90 = 89.2,  p99 = 412.8
//   gradient of the flat black backdrop itself:
//       p50 = 0.0,  p99 = 8.8,   but max = 444.3
//
// The two distributions overlap completely. Any hard gradient threshold
// either keeps the fringe (leaving a halo) or eats the costume. Gradient
// is useful, but only as a *cost*, not as a gate.
//
// The rule we use instead
// ----------------------
// Give every pixel a cost that combines both signals:
//
//     cost(p) = Db(p)/255  +  LE * min(1, G(p)/GMAX)
//
//   Db(p) — Chebyshev distance from p to the estimated backdrop colour,
//           normalised to 0..1. This is the old tolerance, but demoted
//           from a decision to one term in a sum.
//   G(p)  — the Sobel gradient magnitude of the (smoothed) luminance at p,
//           normalised to 0..1. A genuine edge saturates this term.
//
// Then decide reachability with a **bottleneck (min-max) flood** from the
// image border:
//
//     p is background  <=>  there is a path p -> border along which every
//                            pixel has cost <= CEIL
//
// The min-max form is what makes this work, and the reason is not subtle.
//
// A *sum* of costs (an ordinary Dijkstra) says "the backdrop is far away
// from that pixel, so stop". But the backdrop is supposed to be far away —
// that is the whole point of a character sitting in the middle of the
// frame. Measured on the reference frame, the costume the wide tolerance
// wrongly eats has a median accumulated cost of 20.9, so no cost ceiling
// can cut it off.
//
// The min-max form says "stop at the first expensive pixel". Path *length*
// is irrelevant; only the single most expensive pixel on the path
// matters. So:
//
//   - the anti-aliased fringe around the character is expensive (it is an
//     edge, and it is far from the backdrop colour), and it forms a
//     continuous wall around the character — so the flood never gets in;
//   - the character's black costume is *cheap* (it is close to the
//     backdrop colour and flat, so both terms are near zero), but it does
//     not matter: reaching it would require crossing the expensive rim,
//     and the flood is blocked there.
//
// A cheap interior can never be reached past a costly rim. That is the
// invariant that guarantees "no holes in the character".
//
// Why no priority queue is needed
// -------------------------------
// The bottleneck condition above is equivalent to a plain connectivity
// question: "is p connected to the border through pixels whose cost is at
// most CEIL?". Since CEIL is known up front, that is one ordinary
// 8-connected flood fill with a per-pixel gate — O(N), no heap.
//
// This is not an approximation. We verified it by also implementing the
// true min-max search (a Dijkstra-style widest-path with a max-heap) and
// comparing the two pixel for pixel on 9 different images at 3 different
// ceilings each: zero differing pixels in every case.
//
// Performance
// -----------
// On a 2160x2880 frame (6.2 MPix) the whole mask stage — luminance plane,
// box blur, Sobel, cost field and the flood — takes roughly 800 ms, all in
// typed arrays. That is *faster* than the algorithm it replaces, which had
// to run a full-frame flood once per candidate tolerance (32 times) just to
// pick a threshold.
//
// Memory
// ------
// The arrays are sized to the frame. At the 40 MPix ceiling that came to
// roughly 600 MB, which is why `MAX_PIXELS` in png_border_cutout.js was
// lowered to 24 MPix. The flood's own stack is the biggest single
// allocation; it holds one entry per reachable pixel.
//
// The measurements this file is built on
// --------------------------------------
// Reference frame: 1080x1440, pure-black backdrop, white sticker outline.
//
//   ceiling | background | costume wrongly eaten
//   --------+-----------------------------+-------------------
//    0.10   |          47.12%             |        0.0%
//    0.12   |          47.22%             |        0.2%   <- default
//    0.14   |          47.43%             |        2.1%
//    0.16   |          47.58%             |        (loose)
//    0.20   |          50.19%             |       24.8%
//
// "costume wrongly eaten" counts the pixels that a colour tolerance of 32
// deletes but the bottleneck flood keeps. Cross-checked on 10 frames of a
// real Live2D pack (2160x2880, black backdrops): the same numbers hold,
// with 0.1%-0.6% of the costume at risk instead of 100%.
//
// The background the flood leaves behind is the anti-aliased fringe
// (luminance p50 = 6, p90 = 15) — which the existing `defringeOutline`
// pass is built to remove. The two stages compose; the mask is not
// expected to be perfect on its own.

// This module is pure computation: it takes an RGBA buffer and returns
// masks. It does no file I/O and spawns no processes — the caller
// (`main/png_border_cutout.js`) owns the ffmpeg plumbing.

// Gradient weight: how much a fully saturated edge may add to the cost.
//
// This is a *dimensional* constant rather than an artwork-dependent knob.
// It says "a saturated gradient edge is worth LE times the full colour
// distance range", which only depends on the units of the two terms. It
// was validated on 11 images (one reference frame plus 10 frames of a real
// Live2D pack) and none of them wanted a different value.
const DEFAULT_LE = 10;

// Gradient normalisation ceiling.
//
// This is the scale of the Sobel output for a 3x3 kernel over 0..255
// luminance. Measured across the reference frame and 5 Live2D frames, the
// 99.9th percentile of the gradient sits at 460-605 and the maximum at
// 565-675, so 700 normalises a genuine anti-aliased edge to roughly
// saturation while keeping noise well below it.
const DEFAULT_GMAX = 700;

// Default cost ceiling — the "normal" preset.
//
// The ceiling controls how far into the anti-aliased fringe the flood
// reaches. The bulk of the backdrop is flat and cheap, so it comes out at
// any ceiling; what the ceiling really decides is whether the fringe
// around the character is worth crossing.
//
// There is a cliff, and it is sharp. Measured across the reference frame
// and six frames of a real Live2D pack, the share of the character's
// costume that gets wrongly eaten is:
//
//   ceiling  0.08  0.09  0.10  0.12  0.13  0.14  0.16
//   worst     0.0%  0.0% 0.01% 0.19% 0.22% 0.24% 11.85%
//
// 0.16 is where the character's dark hat brim — whose colour is within
// ~13/255 of the black backdrop — finally becomes cheap enough to walk
// through. Everything up to 0.14 is safe by a wide margin, so the "loose"
// preset stops at 0.14 rather than pushing into that cliff.
//
// Background coverage barely moves across this range (47.10% at 0.08 vs
// 47.30% at 0.14 on the reference frame), because the flat backdrop is
// removed either way. That is the trade we want: the ceiling buys a
// slightly cleaner fringe at the cost of the character, so it stays low.
const DEFAULT_CEIL = 0.12;

// Safety rail: the flood may never claim more than this fraction of the
// frame.
//
// A character sprite never occupies less than a fraction of its own frame,
// so if the flood reaches (say) 90% of the pixels the ceiling was clearly
// too permissive for this particular image — the artwork must have a very
// low-contrast backdrop, where the colour term contributes almost nothing
// and the gradient term carries the whole cost. Rather than let that image
// lose its character, we tighten the ceiling and try again.
//
// This turns "never punch holes in the character" from a tuning outcome
// into an invariant.
const MAX_BACKGROUND_RATIO = 0.85;

// How many times the safety rail may retighten the ceiling before giving
// up and returning the tightest result we have.
const MAX_RAIL_RETRIES = 3;

// How much the ceiling is multiplied by on each safety-rail retry.
const RAIL_SHRINK = 0.75;

// 8-neighbourhood offsets, shared by the flood.
const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY = [-1, -1, -1, 0, 0, 1, 1, 1];

// Chebyshev distance between a pixel and the backdrop colour.
//
// Chebyshev (rather than Euclidean) because the old tolerance was a
// per-channel distance too, so the two terms of the cost stay comparable
// in character: "how far off the backdrop, per channel".
function colorDistance(rgba, index, bg) {
  const o = index * 4;
  const dr = rgba[o] - bg[0];
  const dg = rgba[o + 1] - bg[1];
  const db = rgba[o + 2] - bg[2];
  const ar = dr < 0 ? -dr : dr;
  const ag = dg < 0 ? -dg : dg;
  const ab = db < 0 ? -db : db;
  let m = ar > ag ? ag : ar;
  if (ab > m) m = ab;
  return m;
}

// Rec.601 luminance of every pixel, as bytes.
//
// A separate plane (rather than calling a per-pixel float helper inside the
// Sobel pass) keeps the inner loop to one byte read per neighbour instead
// of three float multiplies, which matters at 6+ MPix.
function computeLuminancePlane(rgba, width, height) {
  const total = width * height;
  const lum = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    const l = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    lum[i] = l < 0 ? 0 : (l > 255 ? 255 : l);
  }
  return lum;
}

// Box-blur the luminance plane with a 3x3 kernel.
//
// Two reasons this is not optional:
//
//   1. Noise. A JPEG-compressed backdrop is not flat, and the Sobel of
//      that noise produces spikes of the same magnitude as a real edge.
//      Without smoothing, the gradient term would price background noise
//      as an outline and the flood would stop early, leaving speckles.
//   2. The numbers above were measured on a smoothed gradient, so this
//      keeps the implementation aligned with the tuning data.
//
// The blur is separable: a horizontal pass then a vertical pass, which
// costs 2 * 9 reads per pixel instead of 9 for a true 2D kernel.
//
// The edges are handled by clamping (replicating the border pixels),
// which keeps the output the same size as the input.
function smoothLuminance(lum, width, height) {
  const total = width * height;
  const tmp = new Uint8Array(total);
  const out = new Uint8Array(total);

  // Horizontal pass.
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < width - 1 ? x + 1 : width - 1;
      tmp[row + x] = (lum[row + xm] + lum[row + x] + lum[row + xp] + 1) / 3 | 0;
    }
  }

  // Vertical pass.
  for (let y = 0; y < height; y += 1) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < height - 1 ? y + 1 : height - 1;
    const row = y * width;
    const rowM = ym * width;
    const rowP = yp * width;
    for (let x = 0; x < width; x += 1) {
      out[row + x] = (tmp[rowM + x] + tmp[row + x] + tmp[rowP + x] + 1) / 3 | 0;
    }
  }

  return out;
}

// Sobel gradient magnitude of the (smoothed) luminance plane.
//
// Returns a Uint16Array: the largest possible 3x3 Sobel magnitude over
// 0..255 luminance is 4*255*2 = 2040, which fits comfortably in 16 bits.
//
// The magnitude is the Euclidean norm sqrt(gx^2 + gy^2) rather than the
// cheaper |gx| + |gy|, because the tuning numbers were measured with the
// Euclidean form and the ceiling values depend on that scale.
function computeSobelGradient(lum, width, height) {
  const total = width * height;
  const grad = new Uint16Array(total);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const rowM = y > 0 ? row - width : row;
    const rowP = y < height - 1 ? row + width : row;

    for (let x = 0; x < width; x += 1) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < width - 1 ? x + 1 : width - 1;

      const i = row + x;
      const tl = lum[rowM + xm];
      const tc = lum[rowM + x];
      const tr = lum[rowM + xp];
      const ml = lum[row + xm];
      const mr = lum[row + xp];
      const bl = lum[rowP + xm];
      const bc = lum[rowP + x];
      const br = lum[rowP + xp];

      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      grad[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return grad;
}

// Build the per-pixel cost field.
//
//     cost(p) = Db(p)/255 + LE * min(1, G(p)/GMAX)
//
// Returns a Float32Array. The values run from 0 (a perfectly flat pixel
// that *is* the backdrop colour) to 1 + LE (a saturated edge that is also
// far from the backdrop colour).
function buildCostField(rgba, grad, width, height, bg, { le, gmax } = {}) {
  const total = width * height;
  const LE = Number.isFinite(le) ? le : DEFAULT_LE;
  const GMAX = Number.isFinite(gmax) && gmax > 0 ? gmax : DEFAULT_GMAX;

  const cost = new Float32Array(total);
  const invGmax = 1 / GMAX;

  for (let i = 0; i < total; i += 1) {
    const db = colorDistance(rgba, i, bg) / 255;
    const g = grad[i] * invGmax;
    const gn = g > 1 ? 1 : g;
    cost[i] = db + LE * gn;
  }

  return cost;
}

// Flood from the image border through pixels whose cost is at most
// `ceiling`.
//
// Returns a Uint8Array with 1 = "reachable from the border within the
// cost ceiling" (i.e. background) and 0 = "not reachable".
//
// This is the bottleneck (min-max) reachability rule, computed as an
// ordinary gated flood. See the header comment for why the two are
// provably identical.
//
// The gate applies to the border seeds as well. That is deliberate: on an
// image with a vignette the border may not be perfectly flat, and we would
// rather find no background at all than start eating the character. A
// caller that gets zero reachable pixels reports "background not found",
// which is the honest outcome.
//
// `cancelCheck` is optional; when supplied it is polled every
// CANCEL_CHECK_INTERVAL pixels so a long run on a big frame stays
// interruptible.
function bottleneckFlood(cost, width, height, ceiling, { cancelCheck } = {}) {
  const total = width * height;
  const reached = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const push = (i) => {
    if (reached[i]) return;
    if (cost[i] > ceiling) return;
    reached[i] = 1;
    stack[sp] = i;
    sp += 1;
  };

  // Seed the four borders.
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  let sinceCheck = 0;
  const cancelled = () => {
    if (typeof cancelCheck !== 'function') return false;
    sinceCheck += 1;
    if (sinceCheck < CANCEL_CHECK_INTERVAL) return false;
    sinceCheck = 0;
    try { return !!cancelCheck(); } catch { return false; }
  };

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
    if (sp % CANCEL_CHECK_INTERVAL === 0 && cancelled()) {
      // Abandon the flood. The caller sees the partial result and can
      // decide what to do; the mask is still a valid "these pixels are
      // certainly background" set, just an incomplete one.
      break;
    }
  }

  return reached;
}

// How often the flood polls the cancel callback, in pixels.
const CANCEL_CHECK_INTERVAL = 4096;

// Build the background mask for a decoded RGBA buffer.
//
// Returns { mask, backgroundColor, transparentPixels, total, ceiling }.
// `mask` is a Uint8Array with 1 = "this pixel is background (make it
// transparent)".
//
// The safety rail is applied here: if the flood claims more than
// MAX_BACKGROUND_RATIO of the frame, the ceiling is tightened and the
// flood is repeated, up to MAX_RAIL_RETRIES times.
function buildBottleneckMask(rgba, width, height, {
  ceiling,
  le,
  gmax,
  bg,
  cancelCheck,
} = {}) {
  const total = width * height;

  // The backdrop colour is estimated by the caller in the common case
  // (png_border_cutout.js already computes it for its own reporting), but
  // we accept it so the estimation is not done twice.
  const backdrop = bg && bg.length >= 3 ? bg : estimateBackdrop(rgba, width, height);

  const lum = smoothLuminance(computeLuminancePlane(rgba, width, height), width, height);
  const grad = computeSobelGradient(lum, width, height);
  const cost = buildCostField(rgba, grad, width, height, backdrop, { le, gmax });

  let effective = Number.isFinite(ceiling) ? ceiling : DEFAULT_CEIL;
  let mask = null;
  let transparentPixels = 0;

  for (let attempt = 0; attempt <= MAX_RAIL_RETRIES; attempt += 1) {
    mask = bottleneckFlood(cost, width, height, effective, { cancelCheck });
    let count = 0;
    for (let i = 0; i < total; i += 1) if (mask[i]) count += 1;
    transparentPixels = count;

    if (transparentPixels / total <= MAX_BACKGROUND_RATIO) break;

    // The ceiling was too permissive for this image. Tighten and retry.
    // If we are already at the tightest setting we keep the last result —
    // a conservative-but-huge cut is still better than silently returning
    // an empty mask, and the caller's hole repair will patch up whatever
    // the character lost.
    const tightened = effective * RAIL_SHRINK;
    if (tightened < effective) effective = tightened;
    else break;
  }

  return {
    mask,
    backgroundColor: backdrop,
    transparentPixels,
    total,
    ceiling: effective,
  };
}

// Estimate the backdrop colour from a perimeter band.
//
// Kept local so this module has no dependency on png_border_cutout.js
// (which imports this module — a cycle would be awkward). The two
// implementations agree by construction: median over a band of the outer
// rows/columns.
function estimateBackdrop(rgba, width, height) {
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

  return samples.map((arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  });
}

module.exports = {
  buildBottleneckMask,
  bottleneckFlood,
  buildCostField,
  computeLuminancePlane,
  computeSobelGradient,
  smoothLuminance,
  estimateBackdrop,
  colorDistance,
  DEFAULT_LE,
  DEFAULT_GMAX,
  DEFAULT_CEIL,
  MAX_BACKGROUND_RATIO,
  MAX_RAIL_RETRIES,
};
