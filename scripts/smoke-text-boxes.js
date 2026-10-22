#!/usr/bin/env node
// scripts/smoke-text-boxes.js — behavioural checks for the 文本框 catalog
// (main/pet_text_boxes.js).
//
// Covers the four properties the feature relies on:
//   1. the shipped resources/text_boxes PNGs are all discovered, as file://
//      URLs the pet window's CSP is allowed to load;
//   2. a missing folder is not an error — an install without art simply has
//      no options;
//   3. an id that no longer resolves degrades to the CSS bubble rather than to
//      a broken <img>;
//   4. the list order is stable, so "the one I picked" is unambiguous.
//
// Usage: node scripts/smoke-text-boxes.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const boxes = require(path.join(ROOT, 'main', 'pet_text_boxes.js'));

let passed = 0;
function check(name, fn) {
  boxes.invalidate();
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.message));
    process.exitCode = 1;
  }
}

// A throwaway resources tree, so the "missing folder" and "only .png" cases
// can be exercised without touching the shipped art.
function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tbox-'));
  const dir = path.join(root, 'resources', 'text_boxes');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  try { return fn(root); }
  finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    boxes.invalidate();
  }
}

console.log('\n[catalog] 扫描 resources/text_boxes');

check('every shipped PNG is discovered', () => {
  const list = boxes.list(null);
  assert.ok(list.length > 0, 'expected the shipped art to be found');
  const ids = list.map((b) => b.id);
  assert.ok(!ids.includes(''), 'a file named ".png" has no usable id');
  assert.strictEqual(new Set(ids).size, ids.length, 'ids must be unique');
});

check('entries carry a file:// URL the renderer can load', () => {
  // The pet window runs `img-src 'self' file: data:` and loads frames as
  // file:// URLs already; a text box that wasn't a file:// URL would fail to
  // load silently and show an empty bubble.
  for (const b of boxes.list(null)) {
    assert.ok(b.url.startsWith('file://'), `${b.id}: expected a file:// url, got ${b.url}`);
    assert.ok(b.file.toLowerCase().endsWith('.png'));
    assert.ok(b.label, 'the dropdown needs a label to render');
  }
});

check('the list is ordered numerically, not lexicographically', () => {
  // readdir order is filesystem-dependent, and "10" sorting before "3" would
  // make the dropdown look different on a different machine.
  withTree({ '1.png': 'a', '2.png': 'a', '10.png': 'a', '3.png': 'a' }, (root) => {
    assert.deepStrictEqual(
      boxes.list(root).map((b) => b.id), ['1', '2', '3', '10'],
      'expected numeric order',
    );
  });
});

check('non-numeric ids sort after numeric ones, alphabetically', () => {
  withTree({ 'cloud.png': 'a', '2.png': 'a', 'apple.png': 'a' }, (root) => {
    assert.deepStrictEqual(boxes.list(root).map((b) => b.id), ['2', 'apple', 'cloud']);
  });
});

check('the order is stable across repeated scans', () => {
  const first = boxes.list(null).map((b) => b.id);
  boxes.invalidate();
  assert.deepStrictEqual(boxes.list(null).map((b) => b.id), first);
});

console.log('\n[filtering] 只接受 png');

check('non-PNG files are ignored', () => {
  withTree({
    '1.png': 'a',
    'notes.txt': 'a',
    'design.psd': 'a',
    '.DS_Store': 'a',
  }, (root) => {
    assert.deepStrictEqual(boxes.list(root).map((b) => b.id), ['1']);
  });
});

check('an uppercase .PNG is still accepted', () => {
  // A screenshot tool on Windows emits .PNG; silently dropping those would
  // make a folder look broken for no visible reason.
  withTree({ '1.PNG': 'a', '2.png': 'a' }, (root) => {
    assert.deepStrictEqual(boxes.list(root).map((b) => b.id), ['1', '2']);
  });
});

check('a directory named .png is not offered as a choice', () => {
  // Would otherwise surface as an option whose <img> 404s.
  withTree({ '1.png': 'a' }, (root) => {
    fs.mkdirSync(path.join(root, 'resources', 'text_boxes', '2.png'));
    assert.deepStrictEqual(boxes.list(root).map((b) => b.id), ['1']);
  });
});

console.log('\n[缺失] 目录或文件缺失');

check('a missing folder yields no options instead of throwing', () => {
  // A build without text boxes must still run: every action stays on the CSS
  // default bubble.
  assert.deepStrictEqual(boxes.list('/definitely/not/here'), []);
});

check('a missing folder still resolves nothing', () => {
  assert.strictEqual(boxes.resolve('/definitely/not/here', '1'), null);
});

check('an empty folder is a valid, empty catalog', () => {
  withTree({}, (root) => assert.deepStrictEqual(boxes.list(root), []));
});

console.log('\n[resolve] 解析与降级');

check('a known id resolves to { id, url }', () => {
  withTree({ '3.png': 'a' }, (root) => {
    const hit = boxes.resolve(root, '3');
    assert.ok(hit, 'expected a hit');
    assert.strictEqual(hit.id, '3');
    assert.ok(hit.url.startsWith('file://'));
  });
});

check('an unknown id degrades to null (CSS bubble), not a broken URL', () => {
  // The real case: the config was written on a machine that had the PNG, or
  // the file has since been deleted. Either way the pet must keep talking.
  assert.strictEqual(boxes.resolve(null, '99'), null);
});

check('an empty id is the default, not a lookup for ""', () => {
  assert.strictEqual(boxes.resolve(null, ''), null);
  assert.strictEqual(boxes.resolve(null, '   '), null);
  assert.strictEqual(boxes.resolve(null, null), null);
  assert.strictEqual(boxes.resolve(null, undefined), null);
});

check('isKnown distinguishes a real box from the default', () => {
  withTree({ '3.png': 'a' }, (root) => {
    assert.strictEqual(boxes.isKnown(root, '3'), true);
    assert.strictEqual(boxes.isKnown(root, '9'), false);
    assert.strictEqual(boxes.isKnown(root, ''), false, 'the default is not "known"');
    assert.strictEqual(boxes.isKnown(root, null), false);
  });
});

check('a filename stem is used as the id, not the whole name', () => {
  withTree({ 'my-cloud-box.png': 'a' }, (root) => {
    assert.deepStrictEqual(boxes.list(root).map((b) => b.id), ['my-cloud-box']);
    assert.ok(boxes.resolve(root, 'my-cloud-box'), 'ids must be selectable by stem');
  });
});

console.log('\n[cache] 扫描结果缓存');

check('invalidate() picks up a file added after the first scan', () => {
  // The dev loop: add a PNG while the app runs, re-open /settings, see it.
  withTree({ '1.png': 'a' }, (root) => {
    assert.strictEqual(boxes.list(root).length, 1);
    fs.writeFileSync(path.join(root, 'resources', 'text_boxes', '2.png'), 'a');
    assert.strictEqual(boxes.list(root).length, 1, 'cached until invalidated');
    boxes.invalidate();
    assert.strictEqual(boxes.list(root).length, 2, 'invalidate must force a rescan');
  });
});

check('a cache hit returns the same array (callers must not mutate it)', () => {
  const a = boxes.list(null);
  const b = boxes.list(null);
  assert.strictEqual(a, b, 'the memoised array is handed back, not a copy');
});

console.log('\n[geometry] 裁切画布四周的透明边');

check('resolve() carries the measured geometry', () => {
  // The renderer needs these to crop the canvas margin and set the bubble's
  // height; without them the bubble either floats away from the pet (un-cropped
  // margin) or gets squashed into a square.
  const hit = boxes.resolve(null, '3');
  assert.ok(hit.geom, 'expected geom');
  const g = hit.geom;
  for (const k of ['left', 'top', 'right', 'bottom', 'aspect']) {
    assert.strictEqual(typeof g[k], 'number', `${k} must be a number`);
  }
  assert.ok(g.left >= 0 && g.right >= 0 && g.top >= 0 && g.bottom >= 0,
    'margins must be non-negative percentages');
  assert.ok(g.left + g.right < 100 && g.top + g.bottom < 100,
    'the visible bubble must occupy some of the canvas');
});

check('the margins leave a usable visible area on every shipped box', () => {
  // A box whose visible fraction is tiny would need an enormous scale and come
  // out blurry/blocky; this guards against a mis-cropped measurement.
  for (const b of boxes.list(null)) {
    const g = boxes.resolve(null, b.id).geom;
    const visW = 100 - g.left - g.right;
    const visH = 100 - g.top - g.bottom;
    assert.ok(visW > 60 && visH > 30,
      `${b.id}: visible area ${visW.toFixed(1)}%×${visH.toFixed(1)}% is too small to be a bubble`);
  }
});

check('the aspect ratio matches each drawing, not a fixed square', () => {
  // 5.png is a very wide banner and 1.png is much squarer. Using one number
  // for both is what made the wide bubbles look stretched.
  const wide = boxes.resolve(null, '5').geom.aspect;
  const narrow = boxes.resolve(null, '1').geom.aspect;
  assert.ok(wide > narrow + 0.5,
    `expected 5.png to be markedly wider than 1.png, got ${wide} vs ${narrow}`);
  assert.ok(wide > 2 && narrow < 2, 'sanity: one banner, one squarer bubble');
});

check('the bottoms are all well above the canvas edge', () => {
  // This is the reported bug: a large bottom margin is invisible padding that
  // pushes the bubble up and away from the pet.
  for (const b of boxes.list(null)) {
    const g = boxes.resolve(null, b.id).geom;
    assert.ok(g.bottom > 15,
      `${b.id}: ${g.bottom}% bottom margin is the float-too-high problem`);
  }
});

check('an unmeasured id falls back rather than failing', () => {
  const g = boxes.geometryFor('99');
  assert.ok(g && typeof g.aspect === 'number', 'expected fallback geometry');
  assert.ok(boxes.resolve(null, '99') === null, 'an unknown id still resolves to null');
});

check('the measured table covers every shipped box', () => {
  // Otherwise an unmeasured file would silently use the fallback and sit
  // slightly wrong — worth a loud failure so a new PNG gets measured.
  for (const b of boxes.list(null)) {
    assert.ok(boxes.GEOMETRY[b.id],
      `${b.id} has no entry in GEOMETRY — run scripts/measure-text-boxes.js`);
  }
});

check('every box carries a finite text offset', () => {
  // dx/dy drive the visible centring of the text, so a missing or NaN field
  // would shift the text by an arbitrary amount rather than degrade.
  for (const b of boxes.list(null)) {
    const g = boxes.GEOMETRY[b.id];
    assert.ok(Number.isFinite(g.dx), `${b.id} has no finite dx`);
    assert.ok(Number.isFinite(g.dy), `${b.id} has no finite dy`);
    assert.ok(Math.abs(g.dx) < 0.25 && Math.abs(g.dy) < 0.25,
      `${b.id} offset (${g.dx}, ${g.dy}) is too large to be a centring correction`);
  }
});

check('no box is offset by more than its own asymmetry warrants', () => {
  // The measured interior search can latch onto decoration rather than the
  // bubble (7.png once came back claiming a 28px sideways shift, because the
  // search found a wing). A centring correction should never be a large
  // fraction of the bubble — that is the signature of a bad measurement rather
  // than a real asymmetry.
  for (const b of boxes.list(null)) {
    const g = boxes.GEOMETRY[b.id];
    const drift = Math.max(Math.abs(g.dx), Math.abs(g.dy));
    assert.ok(drift <= 0.05,
      `${b.id} drifts by ${(drift * 100).toFixed(1)}% — re-run the measurement; ` +
      'the interior is probably decoration, not the bubble');
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);