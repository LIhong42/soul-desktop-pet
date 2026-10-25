#!/usr/bin/env node
// scripts/verify-cutout.js — verify the background-removal algorithm.
//
// The cutout algorithm is subtle and gets re-tuned whenever a new pet pack
// shows up, so it needs a repeatable check rather than eyeballing output.
//
//   node scripts/verify-cutout.js              # synthetic cases + real art
//   node scripts/verify-cutout.js --synthetic  # synthetic cases only (fast)
//   node scripts/verify-cutout.js --art        # real art only
//   node scripts/verify-cutout.js --frames 3   # how many real frames to check
//   node scripts/verify-cutout.js --out DIR    # write checkerboard composites here
//
// The synthetic cases are the regression net: they encode the two failure
// modes the algorithm exists to prevent.
//
//   1. A dark blob on a dark backdrop separated by a bright ring. A
//      colour-threshold cut eats the blob (both are nearly black); the
//      cost-ceiling cut must not.
//
//   2. The same ring with a one-pixel gap. The blob is then reachable from
//      the border, so the connectivity rule alone *would* eat it. The hole
//      repair pass must put it back.
//
// The real-art pass runs the shipped pet frames through the pipeline and
// asserts that the character's dark costume survives.
//
// Exits non-zero if any check fails, so it can be wired into CI later.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const cut = require(path.join(ROOT, 'main', 'png_border_cutout.js'));
const bottleneck = require(path.join(ROOT, 'main', 'png_bottleneck_flood.js'));

const RED = (s) => '\x1b[31m' + s + '\x1b[0m';
const GRN = (s) => '\x1b[32m' + s + '\x1b[0m';
const YLW = (s) => '\x1b[33m' + s + '\x1b[0m';
const DIM = (s) => '\x1b[2m' + s + '\x1b[0m';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const numArg = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};

const onlySynthetic = has('--synthetic');
const onlyArt = has('--art');
const frameCount = numArg('--frames', 6);
const outDirIdx = argv.indexOf('--out');
const outDir = outDirIdx >= 0 && outDirIdx + 1 < argv.length ? argv[outDirIdx + 1] : null;

let failures = 0;
let checks = 0;

function assert(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`${GRN('✓')} ${label}${detail ? DIM('  ' + detail) : ''}`);
  } else {
    failures += 1;
    console.log(`${RED('✗')} ${label}${detail ? '  ' + detail : ''}`);
  }
}

function section(title) {
  console.log('');
  console.log(YLW(`── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`));
}

// --------------------------------------------------------------------------
// Synthetic image builder
// --------------------------------------------------------------------------

// Build an RGBA buffer from a per-pixel callback.
function makeImage(width, height, fn) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const c = fn(x, y);
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = c.length > 3 ? c[3] : 255;
    }
  }
  return rgba;
}

// Count pixels that are fully transparent.
function transparentCount(rgba) {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) n += 1;
  return n;
}

// Count pixels in a rect that are fully transparent.
function transparentInRect(rgba, width, x0, y0, x1, y1) {
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] === 0) n += 1;
    }
  }
  return n;
}

// --------------------------------------------------------------------------
// Synthetic cases
// --------------------------------------------------------------------------

function runSynthetic() {
  section('synthetic cases');

  const W = 120;
  const H = 120;

  // -- Case 1: dark blob on a dark backdrop, separated by a bright ring ----
  //
  // The blob (RGB 18,14,26) is only ~18/255 from the black backdrop. A
  // colour threshold wide enough to see the anti-aliased fringe also sees
  // the blob. The cost ceiling must stop at the bright ring instead.
  {
    const ring = { x0: 30, y0: 30, x1: 90, y1: 90 };
    const rgba = makeImage(W, H, (x, y) => {
      const inRing = x >= ring.x0 && x < ring.x1 && y >= ring.y0 && y < ring.y1
        && (x < ring.x0 + 2 || x >= ring.x1 - 2 || y < ring.y0 + 2 || y >= ring.y1 - 2);
      const inBlob = x >= ring.x0 + 2 && x < ring.x1 - 2 && y >= ring.y0 + 2 && y < ring.y1 - 2;
      if (inRing) return [235, 235, 235];
      if (inBlob) return [18, 14, 26];
      return [0, 0, 0];
    });

    const stats = cut.runCutoutPipeline(rgba, W, H, { ceiling: 0.12, softness: 0 });
    const blobArea = (ring.x1 - 2 - (ring.x0 + 2)) * (ring.y1 - 2 - (ring.y0 + 2));
    const eaten = transparentInRect(rgba, W, ring.x0 + 3, ring.y0 + 3, ring.x1 - 3, ring.y1 - 3);
    assert(
      'dark blob behind a bright ring survives the cut',
      eaten < blobArea * 0.02,
      `${eaten}/${blobArea} interior pixels deleted`,
    );
    assert(
      'the black backdrop around the ring is removed',
      stats.transparentPixels > W * H * 0.5,
      `transparent ${(stats.transparentPixels / (W * H) * 100).toFixed(1)}%`,
    );
  }

  // -- Case 2: same ring with a 1px gap -> the hole repair must fix it ----
  {
    const ring = { x0: 30, y0: 30, x1: 90, y1: 90 };
    const gapX = 60;
    const rgba = makeImage(W, H, (x, y) => {
      const onRingEdge = x >= ring.x0 && x < ring.x1 && y >= ring.y0 && y < ring.y1
        && (x < ring.x0 + 2 || x >= ring.x1 - 2 || y < ring.y0 + 2 || y >= ring.y1 - 2);
      // Break the bottom of the ring in two places so the interior is
      // reachable from the border.
      const gap = y >= ring.y1 - 2 && y < ring.y1
        && ((x >= gapX && x < gapX + 3) || (x >= gapX + 20 && x < gapX + 23));
      if (onRingEdge && !gap) return [235, 235, 235];
      const inBlob = x >= ring.x0 + 2 && x < ring.x1 - 2 && y >= ring.y0 + 2 && y < ring.y1 - 2;
      if (inBlob) return [18, 14, 26];
      return [0, 0, 0];
    });

    const stats = cut.runCutoutPipeline(rgba, W, H, { ceiling: 0.12, softness: 0 });
    const blobArea = (ring.x1 - 2 - (ring.x0 + 2)) * (ring.y1 - 2 - (ring.y0 + 2));
    const eaten = transparentInRect(rgba, W, ring.x0 + 3, ring.y0 + 3, ring.x1 - 3, ring.y1 - 3);
    assert(
      'a ring with a gap does not leave a hole in the character',
      eaten < blobArea * 0.02,
      `${eaten}/${blobArea} interior pixels deleted, repaired ${stats.repairedPixels}`,
    );
    // The cost ceiling should stop at the ring even where the ring has a
    // gap, so the repair pass should have nothing to do. If it *does* fire,
    // that is still correct — the hole repair is the backstop — but it
    // means the flood got through, which is worth knowing.
    assert(
      'the gap in the ring does not let the flood into the character',
      stats.repairedPixels === 0,
      stats.repairedPixels === 0
        ? 'the flood never crossed the broken ring'
        : `the hole repair had to close ${stats.repairedPixels} px`,
    );
  }

  // -- Case 3: a fully white image is entirely background -------------------
  {
    const rgba = makeImage(40, 40, () => [255, 255, 255]);
    const stats = cut.runCutoutPipeline(rgba, 40, 40, { ceiling: 0.12 });
    assert(
      'a flat white image is fully transparent',
      stats.transparentPixels === 40 * 40,
      `${stats.transparentPixels}/${40 * 40} transparent`,
    );
  }

  // -- Case 4: a gradient backdrop is refused, not eaten through ------------
  //
  // The backdrop estimate is a *median over the perimeter band*, so on a
  // left-to-right gradient it lands mid-ramp. The far end of the ramp is
  // then far from the estimate, which makes the whole border expensive —
  // and the flood cannot start.
  //
  // Refusing is the correct outcome. A colour threshold would have blindly
  // removed everything within 32 of black, punching holes in whatever
  // happened to be dark. The cost ceiling says "I cannot prove this is
  // background" and leaves the image alone.
  {
    const rgba = makeImage(80, 80, (x, y) => {
      const v = Math.round((x / 79) * 120);
      return [v, v, v];
    });
    let refused = false;
    let stats = null;
    try {
      stats = cut.runCutoutPipeline(rgba, 80, 80, { ceiling: 0.12 });
    } catch (err) {
      refused = !!(err && err.noBackground);
    }
    assert(
      'a gradient backdrop is refused rather than cut through',
      refused || (stats && stats.transparentPixels < 80 * 80 * 0.5),
      refused ? 'reported "no background found"' : `transparent ${((stats.transparentPixels / (80 * 80)) * 100).toFixed(1)}%`,
    );
  }

  // -- Case 5: a bright inner detail stays opaque --------------------------
  //
  // The character's white shirt sits deep inside the silhouette, far from
  // the cut. The defringe pass must not touch it.
  {
    const rgba = makeImage(100, 100, (x, y) => {
      const dx = x - 50;
      const dy = y - 50;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 20) return [250, 250, 250];
      if (d < 26) return [0, 0, 0];
      return [0, 0, 0];
    });
    cut.runCutoutPipeline(rgba, 100, 100, { ceiling: 0.12, softness: 0 });
    let bright = 0;
    for (let y = 40; y < 60; y += 1) {
      for (let x = 40; x < 60; x += 1) {
        const o = (y * 100 + x) * 4;
        if (rgba[o] > 240 && rgba[o + 3] === 255) bright += 1;
      }
    }
    assert(
      'a bright detail inside the character is left alone',
      bright > 300,
      `${bright} bright opaque pixels kept`,
    );
  }
}

// --------------------------------------------------------------------------
// Real art
// --------------------------------------------------------------------------

function ffmpegPath() {
  const { getFfmpegPath } = require(path.join(ROOT, 'main', 'video_frame_split.js'));
  return getFfmpegPath();
}

function runFfmpeg(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 400)}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function decodePng(file) {
  const meta = await runFfmpeg(['-hide_banner', '-i', file]);
  return null; // not used; kept for symmetry
}

async function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-i', file]);
    let s = '';
    child.stderr.on('data', (d) => { s += d; });
    child.on('close', () => {
      const m = /Video:.*?(\d+)x(\d+)/.exec(s);
      if (!m) { reject(new Error(`cannot probe ${file}`)); return; }
      resolve({ width: +m[1], height: +m[2] });
    });
  });
}

async function decodeRaw(file, width, height) {
  return runFfmpeg(
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  );
}

// The "dangerous" pixels: the ones a colour threshold of ~32 would delete
// even though they belong to the character. We approximate them as the
// The pixels the *old* colour-threshold algorithm deleted.
//
// This is the regression set. The old algorithm removed every pixel within
// a colour distance of the backdrop that was connected to the image
// border. On dark-on-dark artwork that set includes the character's own
// black costume, which is what produced the "holes in the character"
// bug.
//
// Measuring the new algorithm against this set is a direct measurement of
// the fix: the new algorithm must *keep* the costume pixels the old one
// deleted, without keeping so much that the background survives.
//
// Returns { mask, total }.
function oldAlgorithmMask(rgba, width, height, bg, threshold = 32) {
  const n = width * height;
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const cheb = Math.max(
      Math.abs(rgba[o] - bg[0]),
      Math.abs(rgba[o + 1] - bg[1]),
      Math.abs(rgba[o + 2] - bg[2]),
    );
    if (cheb <= threshold) cand[i] = 1;
  }

  // Label the 8-connected components of the candidate set and keep the
  // ones that touch the image border.
  const labels = new Int32Array(n).fill(-1);
  const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
  const stack = new Int32Array(n);
  let next = 0;
  for (let seed = 0; seed < n; seed += 1) {
    if (labels[seed] !== -1 || !cand[seed]) continue;
    const l = next;
    next += 1;
    let sp = 0;
    stack[sp] = seed;
    sp += 1;
    labels[seed] = l;
    while (sp > 0) {
      const i = stack[sp - 1];
      sp -= 1;
      const x = i % width;
      const y = (i - x) / width;
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NX[k];
        const ny = y + NY[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (labels[ni] !== -1 || !cand[ni]) continue;
        labels[ni] = l;
        stack[sp] = ni;
        sp += 1;
      }
    }
  }

  const borderLabels = new Set();
  for (let x = 0; x < width; x += 1) {
    borderLabels.add(labels[x]);
    borderLabels.add(labels[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y += 1) {
    borderLabels.add(labels[y * width]);
    borderLabels.add(labels[y * width + width - 1]);
  }

  const mask = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    if (labels[i] >= 0 && borderLabels.has(labels[i])) { mask[i] = 1; total += 1; }
  }
  return { mask, total };
}

function collectArtFiles() {
  const petRoot = path.join(ROOT, 'resources', 'pets', 'default');
  const files = [];
  for (const dir of fs.readdirSync(petRoot)) {
    const full = path.join(petRoot, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.toLowerCase().endsWith('.png')) files.push(path.join(full, f));
    }
  }
  files.sort();
  // Spread the sample across the pack so we cover different poses.
  const picked = [];
  const step = Math.max(1, Math.floor(files.length / frameCount));
  for (let i = 0; i < files.length && picked.length < frameCount; i += step) {
    picked.push(files[i]);
  }
  return { picked, total: files.length };
}

async function runArt() {
  section('real art');

  const { picked, total } = collectArtFiles();
  if (!picked.length) {
    console.log(YLW('  no pet frames found — skipping'));
    return;
  }
  console.log(DIM(`  ${picked.length} of ${total} frames`));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cutout-'));
  const rows = [];

  for (const file of picked) {
    const { width, height } = await probe(file);
    const rgba = await decodeRaw(file, width, height);
    const bg = cut.estimateBorderColor(rgba, width, height);

    // What the old colour-threshold algorithm deleted.
    const old = oldAlgorithmMask(rgba, width, height, bg);

    const copy = Buffer.from(rgba);
    const stats = cut.runCutoutPipeline(copy, width, height, {
      ceiling: bottleneck.DEFAULT_CEIL,
      softness: 0,
    });

    // Of everything the old algorithm deleted, how much does the new one
    // delete as well? The old deletion set is mostly genuine background
    // plus the character's black costume, so this number says "how much
    // costume did we fail to rescue".
    let bothDeleted = 0;
    for (let i = 0; i < old.mask.length; i += 1) {
      if (old.mask[i] && copy[i * 4 + 3] === 0) bothDeleted += 1;
    }
    const stillGonePct = old.total ? (bothDeleted / old.total) * 100 : 0;

    // And the inverse: of the new algorithm's deletions, how many did the
    // old algorithm *not* delete? Those are pixels the new one removes
    // that the old one kept — should be near zero, or the new algorithm
    // is eating something it shouldn't.
    let newOnly = 0;
    for (let i = 0; i < old.mask.length; i += 1) {
      if (!old.mask[i] && copy[i * 4 + 3] === 0) newOnly += 1;
    }

    rows.push({
      name: path.basename(file),
      width,
      height,
      bg: (stats.transparentPixels / (width * height)) * 100,
      stillGonePct,
      newOnly,
      defringed: stats.defringedPixels,
      repaired: stats.repairedPixels,
    });

    // Write a checkerboard composite for eyeballing.
    if (outDir) {
      await writeComposite(rgba, copy, width, height, path.join(outDir, `cutout-${path.basename(file)}`));
    }
  }

  console.log('');
  console.log(DIM('  frame                        size        bg%   still-gone%  new-only    defringed    repaired'));
  for (const r of rows) {
    console.log(
      `  ${r.name.slice(0, 26).padEnd(26)}  ${`${r.width}x${r.height}`.padEnd(11)}  `
      + `${r.bg.toFixed(1).padStart(5)}   ${r.stillGonePct.toFixed(2).padStart(8)}   `
      + `${String(r.newOnly).padStart(8)}  ${String(r.defringed).padStart(9)}  ${String(r.repaired).padStart(9)}`,
    );
  }
  console.log(DIM('  still-gone% = share of the OLD algorithm\'s deletions the new one also deletes'));
  console.log(DIM('               (the costume the old one destroyed and the new one rescued)'));
  console.log(DIM('  new-only   = pixels the new one deletes that the old one kept (should be ~0)'));

  // The old algorithm's deletion set is the *background* plus the black
  // costume. The new algorithm must delete nearly all of the background.
  // The "still-gone" share therefore has to be well under 100%: the gap is
  // the costume the new algorithm rescued.
  const worstStillGone = Math.max(...rows.map((r) => r.stillGonePct));
  assert(
    'the new algorithm rescues the character\'s dark costume',
    worstStillGone < 99,
    `worst frame still deletes ${worstStillGone.toFixed(2)}% of the old algorithm\'s set`,
  );
  assert(
    'the new algorithm does not delete anything the old one kept',
    rows.every((r) => r.newOnly / (r.width * r.height) < 0.005),
    `worst frame adds ${Math.max(...rows.map((r) => r.newOnly))} px of new deletions`,
  );
  assert(
    'every frame gets a usable cut',
    rows.every((r) => r.bg > 20),
    `minimum background coverage ${Math.min(...rows.map((r) => r.bg)).toFixed(1)}%`,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// Checkerboard composite — makes leftover backgrounds and halos obvious.
// --------------------------------------------------------------------------
async function writeComposite(original, cutBuf, width, height, outBase) {
  const cell = 16;
  const comp = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const checker = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) === 0 ? 210 : 120;
      const a = cutBuf[o + 3] / 255;
      comp[o] = Math.round(cutBuf[o] * a + checker * (1 - a));
      comp[o + 1] = Math.round(cutBuf[o + 1] * a + checker * (1 - a));
      comp[o + 2] = Math.round(cutBuf[o + 2] * a + checker * (1 - a));
      comp[o + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const tmp = `${outBase}.tmp.png`;
  await runFfmpeg(
    ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0',
      '-c:v', 'png', '-pix_fmt', 'rgba', tmp],
    { input: comp },
  );
  fs.renameSync(tmp, `${outBase}.png`);
}

// --------------------------------------------------------------------------

(async () => {
  console.log(YLW('verify-cutout — background removal algorithm'));
  if (!onlyArt) runSynthetic();
  if (!onlySynthetic) await runArt();

  console.log('');
  if (failures) {
    console.log(RED(`${failures} of ${checks} checks FAILED`));
    process.exit(1);
  }
  console.log(GRN(`all ${checks} checks passed`));
})().catch((err) => {
  console.error(RED('verify-cutout crashed:'), err && err.stack ? err.stack : err);
  process.exit(1);
});
