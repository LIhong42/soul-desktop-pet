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
//   2. We estimate the background color from the outer perimeter and
//      label the 8-connected components of the background-colored
//      pixels. Only the components that touch the image border are
//      removed; anything enclosed by the outline stays opaque.
//   3. Optionally feather the hard cut into a soft edge, so anti-aliased
//      pixels around the outline blend instead of showing a gray halo
//      when the PNG is composited over a non-white desktop.
//   4. ffmpeg re-encodes the buffer as an RGBA PNG.
//
// ffmpeg's PNG *encoder* does write the alpha channel (we verified with
// `-pix_fmt rgba`), so no separate PNG chunk writer is needed.
//
// The core algorithm lives in `main/png_border_cutout.js`, shared with the
// zip importer so both paths cut backgrounds out identically. The
// background-removal *tool* and the *importer* used to disagree — the
// importer used a flat colorkey that ate the character's black parts,
// while the tool used a flood fill that needed a perfectly sealed
// outline. Both now use the same connectivity rule.
//
// Why connected components instead of a flood fill
// -------------------------------------------------
// A flood fill needs the object's outline to form a *sealed* wall. A
// hand-drawn or AI-generated outline is often thin and slightly broken,
// so the fill leaks in and erases the interior; the previous version
// worked around that with a `chooseSeal` heuristic that dilated the
// artwork until the leak stopped (and, when the heuristic misfired,
// eroded thin artwork instead). Labelling components fails safe: a broken
// outline merely leaves the interior as its own component, which is
// *kept*. Keeping a bit too much is much less damaging than erasing the
// character.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getFfmpegPath } = require('./video_frame_split');
// The ffmpeg plumbing and the cutout algorithm both live in
// main/png_border_cutout.js so this tool and the zip importer cut
// backgrounds out in exactly the same way. Only the ffmpeg runners are
// re-exported here, because this tool drives them directly.
const {
  estimateBorderColor,
  buildBackgroundMask,
  applyMask,
  defringeOutline,
  repairHoles,
  MAX_PIXELS,
  _internal,
} = require('./png_border_cutout');
const { runFfmpeg, probeSize } = _internal;

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

// Estimate the background color from the outer perimeter of the image.
//
// Kept as a named export for backwards compatibility; the implementation
// now lives in png_border_cutout.js and samples a perimeter *band*
// (not just the four corners), so a vignette or a character pixel
// touching the edge cannot drag the estimate off the true backdrop.
function estimateBackground(rgba, width, height) {
  return estimateBorderColor(rgba, width, height);
}

// Build the background mask for a decoded RGBA buffer.
//
// Returns { mask, transparentPixels } where mask is a Uint8Array with
// 1 = "this pixel is background (make it transparent)". Only the
// background-colored components that touch the image border are marked,
// so an enclosed region sharing the backdrop color survives.
function buildMask(rgba, width, height, tolerance) {
  const { mask, transparentPixels, backgroundColor } = buildBackgroundMask(
    rgba, width, height, tolerance,
  );
  return { mask, transparentPixels, backgroundColor };
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
  applyMask(rgba, mask, width, height, softness);
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
    // Label the background-colored components and keep only the ones that
    // touch the image border. Enclosed regions — including ones that share
    // the backdrop color exactly — survive.
    const { mask, transparentPixels, backgroundColor } = buildMask(rgba, width, height, tol);

    // Nothing found means the image is uniformly non-background (e.g. the
    // whole frame is one object on a transparent-ish canvas, or our
    // tolerance was set absurdly low). Surfacing this beats silently
    // returning the input unchanged, which looks like the tool is broken.
    if (transparentPixels === 0) {
      throw new Error('未识别到背景：请确认背景与主体颜色差异明显，必要时放宽「容差」');
    }
    if (cancelled()) { const e = new Error('cancelled'); e.killed = true; throw e; }

    // Set the alpha channel, then optionally soften the cut edge.
    applyMask(rgba, mask, width, height, softness);

    // Strip the white "sticker" outline, if the art has one. A lot of
    // Live2D art is exported with a bright outline stroke around the
    // character; left behind, it reads as a white halo over the desktop.
    // This has to run before the hole repair, or the repair would fill the
    // outline straight back in.
    const defringed = defringeOutline(rgba, mask, width, height);

    // Close holes the cut left inside the character.
    const repaired = repairHoles(rgba, width, height);

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

    const transparentRatio = transparentPixels / (width * height);
    progress('done', 100, `已完成，透明区域 ${(transparentRatio * 100).toFixed(1)}%`);
    return {
      width,
      height,
      transparentRatio,
      backgroundColor,
      defringedPixels: defringed.removed,
      repairedPixels: repaired.repaired,
      bytes: fs.statSync(outPath).size,
    };
  })();
}

module.exports = {
  removeBackground,
  probeSize,
  estimateBackground,
  buildMask,
  featherEdge,
  toleranceFor,
  TOLERANCE_PRESETS,
  MAX_PIXELS,
  getFfmpegPath,
  // Exported for future callers that need the raw ffmpeg runner.
  _internal: { runFfmpeg },
};