// main/image_bg_remove.js — turn an image's background transparent.
//
// Why not just `colorkey` (which main/png_colorkey.js used to do):
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
//   2. Each pixel gets a *cost* combining how far its colour is from the
//      estimated backdrop and how strong an edge it sits on. The
//      background is the set of pixels that can be reached from the image
//      border without passing through a pixel above the cost ceiling.
//   3. The alpha channel is written, the cut edge optionally feathered,
//      and the white "sticker" outline stripped.
//   4. ffmpeg re-encodes the buffer as an RGBA PNG.
//
// ffmpeg's PNG *encoder* does write the alpha channel (we verified with
// `-pix_fmt rgba`), so no separate PNG chunk writer is needed.
//
// The core algorithm lives in `main/png_border_cutout.js` +
// `main/png_bottleneck_flood.js`, shared with the zip importer so both
// paths cut backgrounds out identically. The background-removal *tool*
// and the *importer* used to disagree — the importer used a flat colorkey
// that ate the character's black parts, while the tool used a flood fill
// that needed a perfectly sealed outline. Both now use the same
// cost-ceiling rule, so a frame cut by the tool and the same frame cut
// during a zip import come out identical.
//
// Why a cost ceiling instead of a colour tolerance
// -------------------------------------------------
// A single colour tolerance cannot serve both a flat black backdrop and a
// noisy one, and picking a "safe" wide one is actively harmful. Measured
// on a real 1080x1440 frame (black backdrop, character with a white
// sticker outline), widening the tolerance from 21 to 32 deleted an extra
// 118,758 pixels — 7.64% of the frame — and every one of them was in the
// character's own black costume.
//
// The cost formulation fixes that. The gradient term prices the
// anti-aliased fringe around the character as expensive, so the flood
// stops at the fringe; the character's black costume is flat and close to
// the backdrop colour, so it is *cheap* — but reaching it would mean
// crossing that expensive rim, which the ceiling forbids.
//
// Keeping a bit too much is much less damaging than erasing the
// character, and that is the direction the cost formulation errs in.

const { getFfmpegPath } = require('./video_frame_split');
// The ffmpeg plumbing and the cutout algorithm both live in
// main/png_border_cutout.js so this tool and the zip importer cut
// backgrounds out in exactly the same way. Only the ffmpeg runners are
// re-exported here, because this tool drives them directly.
const {
  cutoutToPng,
  estimateBorderColor,
  MAX_PIXELS,
  _internal,
} = require('./png_border_cutout');
const { runFfmpeg, probeSize } = _internal;

// Cut-strength presets exposed to the UI.
//
// The number is a *cost ceiling* (0-1), not a colour distance. It caps how
// expensive a pixel may be and still count as "walkable background".
//
// The values are not arbitrary. Measured on a real frame, sweeping the
// ceiling shows a sharp cliff:
//
//   ceiling  0.08  0.09  0.10  0.12  0.13  0.14  0.16
//   worst     0.0%  0.0% 0.01% 0.19% 0.22% 0.24% 11.85%
//
// (the "worst" column is the share of the character's dark costume that
// gets deleted). At 0.16 the character's dark hat brim — only ~13/255 away
// from pure black — becomes cheap enough to walk through, and 11.85% of
// the frame is eaten. The presets therefore stop at 0.14.
const TOLERANCE_PRESETS = {
  strict: 0.09,
  normal: 0.12,
  loose: 0.14,
};

function toleranceFor(name) {
  const key = String(name || 'normal').toLowerCase();
  return Object.prototype.hasOwnProperty.call(TOLERANCE_PRESETS, key)
    ? TOLERANCE_PRESETS[key]
    : TOLERANCE_PRESETS.normal;
}

// Estimate the background color from the outer perimeter of the image.
//
// Kept as a named export for backwards compatibility; the implementation
// now lives in png_border_cutout.js and samples a perimeter *band*
// (not just the four corners), so a vignette or a character pixel
// touching the edge cannot drag the estimate off the true backdrop.
function estimateBackground(rgba, width, height) {
  return estimateBorderColor(rgba, width, height);
}

// Main entry point.
//
//   inputPath   — absolute path to the source image
//   outPath     — absolute path the RGBA PNG is written to
//   tolerance   — 0-1 cost ceiling, see TOLERANCE_PRESETS
//   softness    — 0-4, edge feathering ring count
//   progressCb  — ({ phase, percent, note }) => void
//   cancelCheck — () => boolean
//
// This is a thin wrapper over `cutoutToPng` in main/png_border_cutout.js.
// It used to re-implement the whole pipeline; having two copies of the
// same steps is exactly how the tool and the zip importer drifted apart in
// the first place.
function removeBackground({ inputPath, outPath, tolerance, softness, progressCb, cancelCheck }) {
  const ceiling = Number.isFinite(tolerance) ? tolerance : toleranceFor(null);
  return cutoutToPng({
    inputPath,
    outPath,
    ceiling,
    softness,
    repair: true,
    defringe: true,
    progressCb,
    cancelCheck,
  });
}

module.exports = {
  removeBackground,
  probeSize,
  estimateBackground,
  toleranceFor,
  TOLERANCE_PRESETS,
  MAX_PIXELS,
  getFfmpegPath,
  // Exported for future callers that need the raw ffmpeg runner.
  _internal: { runFfmpeg },
};
