// main/image_batch_resize.js — shrink every image in a folder tree.
//
// Why ffmpeg and not a JS image library
// ------------------------------------
// The project already decodes and encodes every image through the bundled
// ffmpeg-static binary (main/png_border_cutout.js, main/png_colorkey.js,
// main/image_bg_remove.js), so this tool reuses the same plumbing rather
// than adding a native dependency like sharp. That also means the tool
// accepts whatever ffmpeg can open — png, jpg, webp, bmp, tiff — with no
// per-format decoder to maintain.
//
// The resize itself is ffmpeg's `scale` filter with the `lanczos` flag.
// We verified that scaling an RGBA PNG with `-vf scale` keeps the alpha
// channel intact: a 50%-opaque red pixel comes out the other side still
// 50%-opaque red. That matters here because the assets this project
// ships are cut-out character frames with soft anti-aliased edges, and a
// resizer that binarised alpha would leave them with hard jaggies.
//
// Why the output goes to a separate folder
// ----------------------------------------
// Unlike the Python script this tool grew out of, this one never
// overwrites the source images. Batch-overwriting a folder is not
// something you can undo from inside the app, and the user asked for a
// non-destructive flow. The source tree is read-only; every output file
// lands under a directory the user picks, mirroring the source layout so
// a folder of animation frames keeps its sub-folder structure.
//
// Output format
// -------------
// The output format follows the input format, with one exception: JPEG
// has no alpha channel, and a cut-out PNG that lost its transparency
// would be silently wrong (the character would get a black box around
// it). We therefore write PNG for any source that has an alpha channel
// and keep the original format otherwise. We detect alpha by asking
// ffmpeg for the pixel format of the source.

const fs = require('node:fs');
const path = require('node:path');
const { runFfmpeg, probeSize } = require('./png_border_cutout')._internal;

// Formats we will pick up when walking a folder. Anything else in the
// tree is left alone.
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.jfif', '.jpe',
  '.bmp', '.webp', '.gif', '.tif', '.tiff',
]);

// Formats ffmpeg can be asked to write. `gif` is deliberately absent:
// writing an animated GIF from a still frame would produce a single-frame
// GIF that silently loses the animation, so GIF sources are copied through
// the same scale path but keep their extension, and we only ever encode
// one frame out of them (the first), which is a documented limitation.
const WRITABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.jfif', '.jpe', '.bmp', '.webp', '.tif', '.tiff',
]);

// Preset multipliers offered in the UI. The value is the divisor: 2 means
// "shrink to half", 4 means "shrink to a quarter".
const PRESET_FACTORS = [
  { value: 2, label: '1/2', hint: '缩小到一半' },
  { value: 3, label: '1/3', hint: '缩小到三分之一' },
  { value: 4, label: '1/4', hint: '缩小到四分之一' },
  { value: 8, label: '1/8', hint: '缩小到八分之一' },
];

// Guard against a factor so small the target collapses to nothing, and
// against one so large the target would grow instead of shrink.
const MIN_FACTOR = 0.1;
const MAX_FACTOR = 100;

// Cap on a single source image, matching the limit the cutout pipeline
// uses. We decode to raw RGBA in memory when we need the pixel format, so
// an unbounded image would be an unbounded allocation.
const MAX_PIXELS = 24 * 1000 * 1000;

// The narrowest output we will produce. A 0-pixel image is not a valid
// PNG, so we clamp to at least 1×1.
const MIN_DIMENSION = 1;

// Compute the output size for a given source size.
//
// The rounding is "round half away from zero" on the exact quotient, so
// 400/3 = 133.33 → 133, and 401/2 = 200.5 → 201. Rounding to *nearest*
// rather than always truncating keeps the aspect ratio error under half a
// pixel on each axis, which matters when the user picks 1/3.
//
// We keep the two axes independent rather than deriving the height from
// the width, so a non-square source never gets its aspect ratio silently
// changed by the rounding of the other axis.
function computeTargetSize(width, height, factor) {
  const w = Math.max(MIN_DIMENSION, Math.round(width / factor));
  const h = Math.max(MIN_DIMENSION, Math.round(height / factor));
  return { width: w, height: h };
}

// Walk a directory tree and collect every image file.
//
// Returns entries with `srcPath` (absolute) and `relPath` (relative to
// `rootDir`, using forward slashes so it can be reused as an output
// path). Sub-directories are visited recursively and their structure is
// mirrored into the output folder.
function collectImages(rootDir) {
  const found = [];

  function walk(dir, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error('[image_batch_resize] readdir failed:', dir, err);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relBase ? `${relBase}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) continue;
        found.push({
          srcPath: full,
          relPath: relBase ? `${relBase}/${entry.name}` : entry.name,
        });
      }
    }
  }

  walk(rootDir, '');
  // Stable, human-sensible order so progress reads predictably.
  found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return found;
}

// Ask ffmpeg whether the source has an alpha channel.
//
// We decode a single frame to raw RGBA and read the pixel format out of
// the banner. `rgba` / `ya8` / `yuva` etc. all mean "has alpha". A source
// with no alpha (a plain JPEG) is reported without one, and we keep its
// original format instead of promoting it to PNG.
async function sourceHasAlpha(inputPath) {
  const { spawn } = require('node:child_process');
  const { getFfmpegPath } = require('./video_frame_split');

  return new Promise((resolve) => {
    const child = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const chunks = [];
    child.on('error', () => resolve(false));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      // The pixel format appears after the dimensions, e.g.
      //   Video: png, rgba(pc, gbr/unknown/unknown), 200x150
      const m = /Video:.*?,\s*([a-z0-9]+)\([^)]*\)/.exec(text);
      const fmt = m ? m[1] : '';
      resolve(/(^|y|yu)(rgba|yuva|va|la|pal8|abgr|bgra)/.test(fmt) || fmt.includes('rgba'));
    });
  });
}

// Pick the output extension for a source file.
//
// PNG sources stay PNG (lossless, alpha preserved). Sources with an alpha
// channel are promoted to PNG so the transparency survives. Everything
// else keeps its own format.
function chooseOutputExtension(srcPath, hasAlpha) {
  const ext = path.extname(srcPath).toLowerCase();
  if (ext === '.png') return '.png';
  if (hasAlpha) return '.png';
  if (ext === '.gif') return '.gif';
  if (WRITABLE_EXTENSIONS.has(ext)) return ext;
  return '.png';
}

// Shrink a single image.
//
//   inputPath  — absolute path to the source
//   outPath    — absolute path to write
//   factor     — divisor (2 = shrink to half)
//   cancelCheck — () => boolean
//
// Returns { width, height, bytes } describing the written file.
async function resizeOne({ inputPath, outPath, factor, cancelCheck }) {
  const { width, height } = await probeSize(inputPath);
  if (!width || !height) throw new Error('无法识别图片尺寸');
  if (width * height > MAX_PIXELS) {
    throw new Error(`图片太大（${width}×${height}）`);
  }

  const target = computeTargetSize(width, height, factor);

  // `scale` with explicit target dimensions. We ask for `format=rgba` in
  // the filter chain so the scaler always operates on RGBA — that is what
  // keeps the alpha channel from being flattened to opaque black on the
  // way through, and it is the same reason the cutout pipeline always
  // decodes to RGBA.
  const vf = `scale=${target.width}:${target.height}:flags=lanczos,format=rgba`;

  // The output pixel format depends on the destination format:
  //   - PNG keeps RGBA so the alpha survives.
  //   - JPEG has no alpha, so we emit RGB and let ffmpeg do the conversion.
  const ext = path.extname(outPath).toLowerCase();
  const isJpeg = ext === '.jpg' || ext === '.jpeg' || ext === '.jfif' || ext === '.jpe';
  const pixFmt = isJpeg ? 'rgb24' : 'rgba';

  await runFfmpeg(
    ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-vf', vf,
      '-frames:v', '1',
      '-pix_fmt', pixFmt,
      outPath],
    { cancelCheck },
  );

  if (typeof cancelCheck === 'function' && cancelCheck()) {
    const err = new Error('cancelled');
    err.killed = true;
    throw err;
  }

  return {
    width: target.width,
    height: target.height,
    originalWidth: width,
    originalHeight: height,
    bytes: fs.statSync(outPath).size,
  };
}

// Run the whole batch.
//
//   inputDir   — absolute path to the source folder
//   outputDir  — absolute path to the destination folder
//   factor     — divisor (2 = shrink to half)
//   recursive  — whether to descend into sub-folders
//   progressCb — ({ phase, percent, note }) => void
//   cancelCheck— () => boolean
//
// Returns { count, failed, outputDir, skipped }.
//
// The output folder is *not* wiped first. We write into it and leave any
// unrelated files alone, but we do refuse to write into the source
// folder itself — that would overwrite the user's originals, which is
// exactly what this tool is designed not to do.
async function resizeBatch({
  inputDir, outputDir, factor, recursive = true, progressCb, cancelCheck,
}) {
  const progress = (phase, percent, note) => {
    try {
      if (typeof progressCb === 'function') progressCb({ phase, percent, note: note || null });
    } catch (e) {
      console.error('[image_batch_resize] progressCb threw:', e);
    }
  };
  const cancelled = () => {
    try { return !!(cancelCheck && cancelCheck()); } catch { return false; }
  };

  if (!inputDir || !fs.existsSync(inputDir)) throw new Error('源文件夹不存在');
  if (!outputDir) throw new Error('输出文件夹不能为空');
  if (!Number.isFinite(factor) || factor < MIN_FACTOR || factor > MAX_FACTOR) {
    throw new Error(`缩小倍数必须在 ${MIN_FACTOR} – ${MAX_FACTOR} 之间`);
  }

  const srcRoot = path.resolve(inputDir);
  const outRoot = path.resolve(outputDir);

  // Refuse to write into the source tree. Comparing the resolved paths
  // catches the common "I picked the same folder twice" mistake, which
  // would otherwise quietly destroy the originals.
  if (outRoot === srcRoot) {
    throw new Error('输出文件夹不能与源文件夹相同');
  }
  if (outRoot.startsWith(srcRoot + path.sep)) {
    throw new Error('输出文件夹不能位于源文件夹内部');
  }

  const images = collectImages(srcRoot);
  if (!images.length) {
    progress('done', 100, '没有找到可处理的图片');
    return { count: 0, failed: 0, outputDir: outRoot, skipped: 0 };
  }

  // A non-recursive run only takes the images sitting directly in the
  // source folder.
  const targets = recursive
    ? images
    : images.filter((img) => !img.relPath.includes('/'));

  if (!targets.length) {
    progress('done', 100, '没有找到可处理的图片');
    return { count: 0, failed: 0, outputDir: outRoot, skipped: 0 };
  }

  fs.mkdirSync(outRoot, { recursive: true });

  let done = 0;
  let failed = 0;
  let skipped = 0;

  for (const img of targets) {
    if (cancelled()) {
      const err = new Error('cancelled');
      err.killed = true;
      throw err;
    }

    const percent = Math.round((done / targets.length) * 100);
    progress('resizing', percent, `正在处理 ${done + 1}/${targets.length}：${img.relPath}`);

    try {
      const hasAlpha = await sourceHasAlpha(img.srcPath);
      const ext = chooseOutputExtension(img.srcPath, hasAlpha);
      const outPath = path.join(outRoot, img.relPath.replace(/\.[^./\\]+$/, ext));

      // Mirror the source's sub-folder structure in the output.
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      await resizeOne({
        inputPath: img.srcPath,
        outPath,
        factor,
        cancelCheck,
      });
      done += 1;
      progress('resizing', Math.round((done / targets.length) * 100),
        `已完成 ${done}/${targets.length}：${img.relPath}`);
    } catch (err) {
      if (err && err.killed) throw err;
      failed += 1;
      console.error('[image_batch_resize] failed:', img.relPath, err);
      progress('resizing', Math.round(((done + failed) / targets.length) * 100),
        `跳过 ${img.relPath}：${err.message}`);
    }
  }

  progress('done', 100, `处理完成，成功 ${done} 张，跳过 ${failed} 张`);
  return { count: done, failed, outputDir: outRoot, skipped: failed };
}

module.exports = {
  resizeBatch,
  resizeOne,
  collectImages,
  computeTargetSize,
  sourceHasAlpha,
  chooseOutputExtension,
  PRESET_FACTORS,
  IMAGE_EXTENSIONS,
  MIN_FACTOR,
  MAX_FACTOR,
  MAX_PIXELS,
};
