#!/usr/bin/env node
// scripts/smoke-image-bg-remove.js — behavioural checks for main/image_bg_remove.js.
//
// Two layers:
//   1. Pure algorithm checks against synthetic RGBA buffers we build in
//      memory. These are the cases that actually matter — most importantly
//      that an interior region sharing the background colour SURVIVES, which
//      is the whole reason this module exists instead of a flat colorkey.
//   2. One end-to-end run through ffmpeg on a generated PNG, proving the
//      decode → flood → encode pipeline writes a real RGBA PNG.
//
// No Electron, no network, no user data.
//
// Usage: node scripts/smoke-image-bg-remove.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const mod = require(path.join(ROOT, 'main', 'image_bg_remove.js'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.message));
    process.exitCode = 1;
  }
}

// Build an RGBA buffer from a function (x, y) => [r, g, b].
function makeBuffer(w, h, fn) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  return buf;
}

// --- 1. estimateBackground ------------------------------------------------

console.log('\n[estimate] background colour from corners');

check('takes the median corner, ignoring one outlier corner', () => {
  // Three corners white, one corner black (object overlaps a corner).
  // Median must land on white, not be dragged toward black.
  const w = 4, h = 4;
  const buf = makeBuffer(w, h, (x, y) => {
    if (x === w - 1 && y === h - 1) return [0, 0, 0];
    return [255, 255, 255];
  });
  assert.deepStrictEqual(mod.estimateBackground(buf, w, h), [255, 255, 255]);
});

check('picks up a non-white backdrop', () => {
  const w = 4, h = 4;
  const buf = makeBuffer(w, h, () => [254, 254, 254]);
  assert.deepStrictEqual(mod.estimateBackground(buf, w, h), [254, 254, 254]);
});

// --- 2. floodBackground ---------------------------------------------------

console.log('\n[flood] border connectivity');

check('marks a uniform image entirely as background', () => {
  const w = 16, h = 16;
  const buf = makeBuffer(w, h, () => [255, 255, 255]);
  const { mask, filled } = mod.floodBackground(buf, w, h, [255, 255, 255], 8);
  assert.strictEqual(filled, w * h);
  assert.ok(mask.every((v) => v === 1));
});

check('an interior region of the SAME colour survives (the colorkey case)', () => {
  // A black-outlined box sitting on a white backdrop, interior the same
  // white as the backdrop. A flat colorkey would hollow out the middle;
  // the flood must not. Note the white margin — the fill needs at least
  // one border pixel it can actually reach.
  const w = 40, h = 40;
  const buf = makeBuffer(w, h, (x, y) => {
    const onOutline = (x >= 8 && x < 32 && (y === 8 || y === 31)) ||
                      (y >= 8 && y < 32 && (x === 8 || x === 31));
    return onOutline ? [0, 0, 0] : [255, 255, 255];
  });
  const { mask } = mod.floodBackground(buf, w, h, [255, 255, 255], 8);
  assert.strictEqual(mask[0], 1, 'corner should be background');
  assert.strictEqual(mask[20 * w + 20], 0, 'interior should NOT be background');
  assert.strictEqual(mask[8 * w + 20], 0, 'the outline itself survives');
  // Every pixel strictly inside the outline stays opaque.
  for (let y = 9; y < 31; y += 1) {
    for (let x = 9; x < 31; x += 1) {
      assert.strictEqual(mask[y * w + x], 0, `interior (${x},${y}) was erased`);
    }
  }
});

check('a soft shadow gradient is absorbed up to the tolerance', () => {
  // Background fading from white at the left edge to mid-grey against a
  // black object at the right. A loose tolerance absorbs the whole ramp;
  // a tight one stops early. That difference is the knob the UI exposes.
  const w = 60, h = 30;
  const buf = makeBuffer(w, h, (x) => {
    if (x > 50) return [0, 0, 0];              // object
    const v = 255 - Math.floor(x * 3);         // white at the left edge → ~105 at x=50
    return [v, v, v];
  });
  const loose = mod.floodBackground(buf, w, h, [255, 255, 255], 64);
  const strict = mod.floodBackground(buf, w, h, [255, 255, 255], 1);
  assert.ok(loose.filled > strict.filled, 'looser tolerance should absorb more shadow');
  assert.strictEqual(loose.mask[0], 1, 'white corner is background');
  assert.strictEqual(loose.mask[10 * w + 55], 0, 'object stays opaque');
});

check('tolerance 0 still marks an exact-colour backdrop', () => {
  const w = 8, h = 8;
  const buf = makeBuffer(w, h, (x, y) => (x === 4 && y === 4 ? [1, 2, 3] : [200, 200, 200]));
  const { mask } = mod.floodBackground(buf, w, h, [200, 200, 200], 0);
  assert.strictEqual(mask[0], 1);
  assert.strictEqual(mask[4 * w + 4], 0);
});

check('tolerance is Chebyshev, so a channel outlier blocks the fill', () => {
  const w = 4, h = 1;
  // Pixel 1 differs from bg by 40 in the blue channel only.
  const buf = makeBuffer(w, h, (x) => (x === 1 ? [255, 255, 215] : [255, 255, 255]));
  const { mask } = mod.floodBackground(buf, w, h, [255, 255, 255], 32);
  assert.strictEqual(mask[0], 1);
  assert.strictEqual(mask[1], 0, '40-off blue should exceed a 32 tolerance');
  assert.strictEqual(mask[2], 1, 'fill continues past the barrier');
});

// --- 3. the decorative-outline leak --------------------------------------

console.log('\n[seal] thin decorative outlines');

check('an interior reachable through a narrow channel is rescued by sealing', () => {
  // Reproduces the gothic-frame bug: a thin stroke outlines the object but
  // a 3px channel at the corner joins the interior to the outer margin, so
  // an un-sealed flood erases the whole panel.
  const w = 60, h = 60;
  const buf = makeBuffer(w, h, (x, y) => {
    const inStroke = (x >= 10 && x < 50 && (y === 10 || y === 49)) ||
                     (y >= 10 && y < 50 && (x === 10 || x === 49));
    // Open the bottom-right corner: drop the stroke for x in 46..49.
    if (inStroke && x >= 46 && y >= 46) return [255, 255, 255];
    return inStroke ? [0, 0, 0] : [255, 255, 255];
  });
  const bg = [255, 255, 255];
  const interior = 30 * w + 30;

  const unsealed = mod.floodBackground(buf, w, h, bg, 8, 0);
  assert.strictEqual(unsealed.mask[interior], 1, 'precondition: un-sealed fill leaks in');

  const sealed = mod.floodBackground(buf, w, h, bg, 8, 3);
  assert.strictEqual(sealed.mask[interior], 0, 'sealing should rescue the interior');
});

check('sealing leaves artwork wider than the seal radius intact', () => {
  // A 9px-wide bar must survive a 3px seal; only gaps narrower than 7px
  // get closed.
  const w = 40, h = 40;
  const buf = makeBuffer(w, h, (x, y) => {
    const inBar = x >= 10 && x < 19 && y >= 5 && y < 35;
    return inBar ? [0, 0, 0] : [255, 255, 255];
  });
  const { mask } = mod.floodBackground(buf, w, h, [255, 255, 255], 8, 3);
  assert.strictEqual(mask[20 * w + 14], 0, 'bar centre must stay opaque');
});

check('chooseSeal finds the sealing radius', () => {
  // Same 3px-corner-channel frame; the correct radius is small.
  const w = 60, h = 60;
  const buf = makeBuffer(w, h, (x, y) => {
    const inStroke = (x >= 10 && x < 50 && (y === 10 || y === 49)) ||
                     (y >= 10 && y < 50 && (x === 10 || x === 49));
    if (inStroke && x >= 46 && y >= 46) return [255, 255, 255];
    return inStroke ? [0, 0, 0] : [255, 255, 255];
  });
  const { seal } = mod.chooseSeal(buf, w, h, [255, 255, 255], 8);
  assert.ok(seal > 0 && seal <= 8, `seal should be small, got ${seal}`);
  assert.strictEqual(seal, 3, `expected the 3px channel to need a 3px seal, got ${seal}`);
});

check('chooseSeal falls back to the default when there is no channel', () => {
  // A solidly-sealed object: every radius gives the same fill, so we must
  // NOT ratchet up to MAX_SEAL (that would erode thin artwork).
  const w = 60, h = 60;
  const buf = makeBuffer(w, h, (x, y) => {
    const inStroke = (x >= 10 && x < 50 && (y === 10 || y === 49)) ||
                     (y >= 10 && y < 50 && (x === 10 || x === 49));
    return inStroke ? [0, 0, 0] : [255, 255, 255];
  });
  const { seal } = mod.chooseSeal(buf, w, h, [255, 255, 255], 8);
  assert.strictEqual(seal, 3, `expected the no-leak fallback, got ${seal}`);
});

// --- 4. toleranceFor ------------------------------------------------------

console.log('\n[presets] tolerance names');

check('maps known names, falls back to normal', () => {
  assert.strictEqual(mod.toleranceFor('strict'), mod.TOLERANCE_PRESETS.strict);
  assert.strictEqual(mod.toleranceFor('loose'), mod.TOLERANCE_PRESETS.loose);
  assert.strictEqual(mod.toleranceFor('nonsense'), mod.TOLERANCE_PRESETS.normal);
  assert.strictEqual(mod.toleranceFor(undefined), mod.TOLERANCE_PRESETS.normal);
});

check('presets are ordered strict < normal < loose', () => {
  const t = mod.TOLERANCE_PRESETS;
  assert.ok(t.strict < t.normal && t.normal < t.loose);
});

// --- 5. end-to-end through ffmpeg ---------------------------------------
//
// This one is async, so it runs after the synchronous checks instead of
// going through check(). Build a fixture PNG (white field with a black
// bar through the middle), run the real pipeline, then decode the result
// and assert on the actual alpha channel.

async function e2e() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgremove-smoke-'));
  const src = path.join(tmp, 'src.png');
  const dst = path.join(tmp, 'out.png');
  try {
    const w = 64, h = 64;
    const raw = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 4;
        const inBar = x > 20 && x < 44 && y > 20 && y < 44;
        const v = inBar ? 0 : 255;
        raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; raw[o + 3] = 255;
      }
    }
    const ff = mod.getFfmpegPath();
    const enc = spawnSync(ff, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0',
      '-c:v', 'png', '-pix_fmt', 'rgba', src,
    ], { input: raw });
    assert.strictEqual(enc.status, 0, 'fixture encode failed');

    const out = await mod.removeBackground({
      inputPath: src, outPath: dst,
      tolerance: mod.toleranceFor('normal'),
      softness: 0,
    });

    assert.strictEqual(out.width, 64);
    assert.strictEqual(out.height, 64);
    assert.ok(fs.existsSync(dst), 'output PNG missing');
    assert.ok(out.transparentRatio > 0.2 && out.transparentRatio < 0.9,
      `unexpected transparent ratio ${out.transparentRatio}`);

    // Decode the result and confirm the alpha channel is real.
    const dec = spawnSync(ff, [
      '-hide_banner', '-loglevel', 'error', '-i', dst,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ], { maxBuffer: 1024 * 1024 * 64 });
    assert.strictEqual(dec.status, 0, 'result decode failed');
    const px = dec.stdout;
    assert.strictEqual(px.length, w * h * 4);
    const alphaAt = (x, y) => px[((y * w + x) * 4) + 3];
    assert.strictEqual(alphaAt(1, 1), 0, 'corner should be transparent');
    assert.strictEqual(alphaAt(32, 32), 255, 'bar interior should be opaque');
    assert.strictEqual(alphaAt(10, 32), 0, 'outside the bar should be transparent');

    passed += 1;
    console.log('  ✓ writes a transparent PNG with a real alpha channel');
  } catch (e) {
    console.error('  ✗ writes a transparent PNG with a real alpha channel');
    console.error('    ' + (e && e.message));
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n[e2e] decode → flood → encode');
e2e().then(() => {
  console.log(`\n${passed} check(s) passed.`);
});