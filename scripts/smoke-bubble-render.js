#!/usr/bin/env node
// scripts/smoke-bubble-render.js — renderer checks for the 文本框 artwork path.
//
// Drives the real showContextBubble / clearActionBubbleIfMine from src/js/pet.js
// inside jsdom, against the real pet.html markup, and asserts the DOM the pet
// window would actually paint. This is the half of the feature the main-process
// smoke tests can't reach: that a payload with a `box` produces an <img> +
// centred text, and that a payload without one falls back to the CSS bubble.
//
// Usage: node scripts/smoke-bubble-render.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let passed = 0;
function check(name, fn) {
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

// Build a window with pet.html's markup plus a stub for the preload bridge
// (`M`), which pet.js talks to at load time. Registering the real pet.js means
// the functions under test are the shipped ones, not a reimplementation.
function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'pet.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // pet.js reads the preload bridge as `window.mp` (main/preload.js
  // contextBridge), and captures it in a module-level `M` at load.
  const handlers = new Map();
  window.mp = {
    on: (ch, fn) => { handlers.set(ch, fn); },
    pet: {
      actionEnded: () => {},
      setPaused: () => {},
      moveBy: () => {},
      getActionsCfg: () => Promise.resolve({}),
      // pet.js replays the action on every action-changed; without this the
      // animator logs a resolveFrames failure and the noise drowns the real
      // assertions. One frame is enough — nothing here inspects the sprite.
      resolveFrames: () => Promise.resolve(['file:///frame.png']),
      // pet.js re-reads position/size at init; returning a minimal state
      // keeps that from logging a caught TypeError on every boot.
      getState: () => Promise.resolve({
        petId: 'x', action: 'default', x: 0, y: 0, spriteW: 100, spriteH: 100,
      }),
    },
    settings: { get: () => Promise.resolve(null) },
  };
  // jsdom implements neither of these, and pet.js calls them at load.
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'pet.js'), 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: 'pet.js' });

  const doc = window.document;
  const bubble = doc.getElementById('pet-text-bubble');
  const art = doc.getElementById('pet-bubble-art');
  const text = doc.getElementById('pet-bubble-text');

  // The two functions pet.js needs to expose for this check. They're module
  // internals, so reach them through a handler the file already wires: the
  // bubble-changed channel *is* showContextBubble.
  const paint = (payload) => handlers.get('pet:bubble-changed')(payload);

  return {
    window, doc, bubble, art, text, paint, handlers,
    close: () => window.close(),
  };
}

// Boot with a faked layout, so the measured path in applyArtGeometry runs
// instead of the no-layout estimate. jsdom reports 0 for every box, which is
// the right default for "no layout" but would mean the wrapping behaviour —
// which depends entirely on the rendered height — is never exercised.
//
// `measure(text)` returns the {width, height} the browser would have produced
// for the given string. The default models the bubble actually wrapping: a
// 13px CJK glyph is ~13px wide, the text node has 28px of horizontal padding,
// and each line is ART_LINE_H (20px) tall.
function bootWithLayout(measure, boxId = '1') {
  const w = boot();
  const text = w.text;
  text.getBoundingClientRect = () => {
    const m = measure(text.textContent || '');
    return { width: m.width, height: m.height, top: 0, left: 0, right: m.width, bottom: m.height };
  };
  // applyArtGeometry measures the text's *natural* width through a Range, not
  // through the node's box — the node is stretched to the grid track, so its own
  // width always reads as the full bubble and can't tell a two-character line
  // from a sixteen-character one. jsdom has no Range, so the real measurement
  // path would silently fall through to the no-layout estimate and the wrapping
  // behaviour this harness exists to exercise would never run.
  //
  // The stub models what a browser reports: one rect per laid-out line, each the
  // width of that line's text. `measure` supplies the height (line count), and
  // the width of the longest line is derived from the text the same way the
  // browser would — 13px per CJK glyph, with the line broken at whatever
  // `measure` says the box holds.
  w.doc.createRange = () => ({
    selectNodeContents() {},
    getClientRects() {
      const s = text.textContent || '';
      const h = measure(s).height;
      const lines = Math.max(1, Math.round(h / 20));
      // One rect per line, so the widest line sets the natural width — which is
      // exactly what a wrapped block reports.
      const rects = [];
      for (let i = 0; i < lines; i++) {
        const n = wrappedWidth(s, lines, i);
        rects.push({ width: n, height: 20, top: i * 20, left: 0, right: n, bottom: i * 20 + 20 });
      }
      return rects;
    },
  });

  // Width of line `i` of `s` when it has been wrapped into `lines` lines.
  //
  // Lines are filled greedily, the way a browser breaks CJK text — every line
  // but the last holds the same number of characters, and only the remainder
  // spills onto the final line. Deriving this from `lines` (rather than assuming
  // a fixed capacity) is what lets the harness model wrapping as a feedback
  // loop: the wider box the code picks admits fewer lines, and the line width
  // the Range reports shrinks with it. A hard-coded capacity per paint would
  // instead let the stub contradict whatever width the code had just chosen.
  const wrappedWidth = (s, lines, i) => {
    const chars = [...s].length;
    const perLine = Math.max(1, Math.ceil(chars / lines));
    return Math.max(0, Math.min(perLine, chars - i * perLine)) * 13;
  };
  const paintWithBox = (payload) => w.paint({
    durationMs: 100, kind: 'action',
    box: require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, boxId),
    ...payload,
  });
  return { ...w, paint: paintWithBox };
}

// The bubble starts hidden; a payload with no text clears it and clears the art.
console.log('\n[默认] 无文本框时的默认气泡');

check('the markup has the text node and the art node', () => {
  const w = boot();
  try {
    assert.ok(w.text, 'expected #pet-bubble-text');
    assert.ok(w.art, 'expected #pet-bubble-art');
    assert.ok(w.bubble.contains(w.text), 'text must live inside the bubble');
    assert.ok(w.bubble.contains(w.art), 'the artwork must live inside the bubble');
  } finally { w.close(); }
});

check('a plain payload paints text and no artwork', () => {
  const w = boot();
  try {
    w.paint({ text: '嗨', kind: 'action', durationMs: 100 });
    assert.strictEqual(w.text.textContent, '嗨');
    assert.ok(!w.bubble.classList.contains('hidden'), 'must be visible');
    assert.ok(!w.bubble.classList.contains('has-art'), 'must NOT be in artwork mode');
    assert.strictEqual(w.art.getAttribute('src'), null, 'no src without a box');
  } finally { w.close(); }
});

console.log('\n[文本框] 带文本框的载荷');

// The real payloads main/pet_text_boxes.resolve produces, including the
// measured geometry. Using the real thing rather than a hand-written stub is
// what keeps these checks honest about the crop/scale contract.
const BOXES = {
  '3': require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '3'),
  '1': require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '1'),
  '2': require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '2'),
  '5': require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '5'),
};

check('a box switches the bubble into artwork mode', () => {
  const w = boot();
  try {
    w.paint({ text: '好香呀', kind: 'action', durationMs: 100, box: BOXES['3'] });
    assert.ok(w.bubble.classList.contains('has-art'), 'expected has-art');
    assert.strictEqual(w.bubble.dataset.box, '3', 'data-box records the choice');
    assert.ok(w.art.getAttribute('src').endsWith('3.png'));
    assert.strictEqual(w.text.textContent, '好香呀', 'the text is unchanged');
  } finally { w.close(); }
});

check('artwork mode does not clobber the kind (accent still applies)', () => {
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'meal', durationMs: 100, box: BOXES['1'] });
    assert.strictEqual(w.bubble.dataset.kind, 'meal', 'data-kind must survive the box switch');
  } finally { w.close(); }
});

check('switching box mid-stream updates the artwork', () => {
  const w = boot();
  try {
    w.paint({ text: 'a', kind: 'action', durationMs: 100, box: BOXES['1'] });
    w.paint({ text: 'b', kind: 'action', durationMs: 100, box: BOXES['2'] });
    assert.strictEqual(w.bubble.dataset.box, '2');
    assert.ok(w.art.getAttribute('src').endsWith('2.png'));
  } finally { w.close(); }
});

check('going back to no box drops the artwork entirely', () => {
  // Otherwise the previous bubble's image would stay up around the new text,
  // and the bubble would keep the artwork's fixed square geometry.
  const w = boot();
  try {
    w.paint({ text: 'a', kind: 'action', durationMs: 100, box: BOXES['3'] });
    w.paint({ text: 'b', kind: 'action', durationMs: 100, box: null });
    assert.ok(!w.bubble.classList.contains('has-art'), 'must leave artwork mode');
    assert.strictEqual(w.bubble.dataset.box, '', 'data-box cleared');
    assert.strictEqual(w.art.getAttribute('src'), null, 'src cleared (releases the bitmap)');
    assert.strictEqual(w.text.textContent, 'b');
  } finally { w.close(); }
});

console.log('\n[裁切] 去掉画布四周的透明边');

// The crop: the visible drawing must land exactly on the element box, because
// the text centres on that box. Anything less and the text ends up somewhere
// other than the middle of the drawn bubble — which is what "the text is bunched
// in the corner" looked like.
//
// These replace checks that asserted a percentage offset and a single `--art-scale`.
// Both were wrong: a percentage resolves against the *box* while the measurement is
// a fraction of the *canvas*, and one uniform scale cannot fill a box whose aspect
// differs from the drawing's. Per-axis pixel sizing is what makes it exact.

/** Where the visible drawing lands, in the box's own coordinates. */
function drawnSpan(w, g, boxW, boxH) {
  const visW = (100 - g.left - g.right) / 100;
  const visH = (100 - g.top - g.bottom) / 100;
  const canvasW = Number(w.bubble.style.getPropertyValue('--art-w').replace('px', ''));
  const canvasH = Number(w.bubble.style.getPropertyValue('--art-h').replace('px', ''));
  const offX = Number(w.bubble.style.getPropertyValue('--art-left').replace('px', ''));
  const offY = Number(w.bubble.style.getPropertyValue('--art-top').replace('px', ''));
  const vx = (g.left / 100) * canvasW;
  const vy = (g.top / 100) * canvasH;
  return {
    x0: offX + vx, x1: offX + vx + visW * canvasW,
    y0: offY + vy, y1: offY + vy + visH * canvasH,
    boxW, boxH,
  };
}

check('the drawn bubble covers the element box exactly', () => {
  // The box and the drawn bubble must be the same rectangle — that is the whole
  // premise of artwork mode. Verified on every shipped box, because a crop that
  // is right for one image is not automatically right for another.
  for (const id of Object.keys(BOXES)) {
    const g = BOXES[id].geom;
    const w = boot();
    try {
      w.paint({ text: 'x', kind: 'action', durationMs: 100, box: BOXES[id] });
      const bw = parseFloat(w.bubble.style.width);
      const bh = parseFloat(w.bubble.style.height);
      if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0) continue;
      const s = drawnSpan(w, g, bw, bh);
      assert.ok(Math.abs(s.x0) < 0.5 && Math.abs(s.x1 - bw) < 0.5,
        `box ${id}: drawing spans x ${s.x0.toFixed(1)}..${s.x1.toFixed(1)}, expected 0..${bw.toFixed(1)}`);
      assert.ok(Math.abs(s.y0) < 0.5 && Math.abs(s.y1 - bh) < 0.5,
        `box ${id}: drawing spans y ${s.y0.toFixed(1)}..${s.y1.toFixed(1)}, expected 0..${bh.toFixed(1)}`);
    } finally { w.close(); }
  }
});

check('the crop offsets come from the measured geometry, in pixels', () => {
  // A percentage here would resolve against the box, but `left`/`top` are fractions
  // of the *canvas*. The two are unrelated quantities once the box is sized from the
  // text and the canvas from the artwork, so the offset has to be computed in the
  // canvas's own pixels — which is what setArtScale does.
  const g = BOXES['3'].geom;
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'action', durationMs: 100, box: BOXES['3'] });
    const offX = Number(w.bubble.style.getPropertyValue('--art-left').replace('px', ''));
    const canvasW = Number(w.bubble.style.getPropertyValue('--art-w').replace('px', ''));
    assert.ok(Number.isFinite(offX) && offX < 0, `expected a negative px offset, got ${offX}`);
    assert.ok(Math.abs(offX - -(g.left / 100) * canvasW) < 0.5,
      `left offset ${offX} != -(left% of canvas) ${(-(g.left / 100) * canvasW).toFixed(2)}`);
  } finally { w.close(); }
});

check('the two axes are scaled independently', () => {
  // The box follows the *interior* aspect (3.png: 1.729) while the drawing has its
  // own (1.646), so one uniform factor cannot fill both axes. 5.png is the extreme
  // case — its interior is 3.38:1 against a 2.45:1 drawing.
  for (const id of Object.keys(BOXES)) {
    const g = BOXES[id].geom;
    const w = boot();
    try {
      w.paint({ text: 'x', kind: 'action', durationMs: 100, box: BOXES[id] });
      const bw = parseFloat(w.bubble.style.width);
      const bh = parseFloat(w.bubble.style.height);
      if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0) continue;
      const canvasW = Number(w.bubble.style.getPropertyValue('--art-w').replace('px', ''));
      const canvasH = Number(w.bubble.style.getPropertyValue('--art-h').replace('px', ''));
      const wantW = bw / ((100 - g.left - g.right) / 100);
      const wantH = bh / ((100 - g.top - g.bottom) / 100);
      assert.ok(Math.abs(canvasW - wantW) < 0.5,
        `box ${id}: canvas ${canvasW} should be ${wantW.toFixed(2)} wide`);
      assert.ok(Math.abs(canvasH - wantH) < 0.5,
        `box ${id}: canvas ${canvasH} should be ${wantH.toFixed(2)} tall`);
      // Overscan, or the transparent margin would show inside the box.
      assert.ok(canvasW > bw && canvasH > bh,
        `box ${id}: the canvas must be larger than the box to be cropped`);
    } finally { w.close(); }
  }
});

console.log('\n[等比缩放] 尺寸随文字变化');

check('the bubble is sized from the text, not a fixed square', () => {
  const w = boot();
  try {
    w.paint({ text: '嗨', kind: 'action', durationMs: 100, box: BOXES['3'] });
    const shortW = w.bubble.style.width;
    assert.ok(shortW, 'expected an explicit width');
    // jsdom reports 0 width, so the documented fallback applies; either way the
    // element must carry a concrete size rather than the old fixed 168px.
    assert.ok(!/168px/.test(shortW), `must not be the old fixed size: ${shortW}`);
  } finally { w.close(); }
});

check('every line leaves clearance for the frame decoration', () => {
  // A line sized to exactly fill the interior puts its outermost glyphs hard
  // against the drawn frame — 0px of clearance — and that is precisely where
  // several of these drawings carry decoration (5.png's end-caps, 7.png's lace
  // trim), so the text overlapped the artwork.
  //
  // The interior measurement stops at the first non-white pixel, i.e. at the
  // frame stroke itself, so "fits the interior" and "fits inside the decoration"
  // are different widths. ART_LINE_SLACK buys the difference, in characters.
  //
  // What has to hold is not "the box is N px wider than the ink" but "a line
  // laid out at this box's width still has the slack beside it". Those differ:
  // once the text wraps, the widest *line* is shorter than the whole string, and
  // comparing against the whole string is what silently reintroduces the
  // collision. So the check re-derives the wrap at the final width and asks for
  // clearance around the resulting full line.
  //
  // The stub feeds the chosen width back in as the next paint's capacity, which
  // is what makes this a loop rather than a fixed guess: a box too narrow to
  // hold its line plus slack reports more lines, the code grows it, and the
  // widths are re-derived until they agree.
  const CHAR_W = 13, PAD = 28, LINE_H = 20, SLACK_MIN = 20;
  const capacityAt = (boxW) => Math.max(1, Math.floor((boxW - PAD - SLACK_MIN) / CHAR_W));

  // Every shipped box, and every length from one character to four full lines'
  // worth. A handful of hand-picked strings would only prove the cases someone
  // thought of — the failure mode here is arithmetic on the width cap, and that
  // bites at particular lengths (just under, and well over, ART_MAX_W), which is
  // exactly what a sweep finds and a spot-check misses.
  for (const boxId of ['1', '2', '3', '4', '5', '6', '7']) {
    let boxW = 120;
    const measure = (s) => {
      const lines = Math.max(1, Math.ceil([...s].length / capacityAt(boxW)));
      return { width: 0, height: lines * LINE_H };   // width comes from the Range
    };
    const w = bootWithLayout(measure, boxId);
    try {
      for (let n = 1; n <= 40; n++) {
        w.paint({ text: '字'.repeat(n) });
        const width = parseFloat(w.bubble.style.width);
        // Re-wrap at the width the code actually chose, with the slack reserved.
        const capacity = capacityAt(width);
        const lines = Math.max(1, Math.ceil(n / capacity));
        const widest = Math.min(capacity, n) * CHAR_W;
        const slack = width - PAD - widest;
        assert.ok(slack >= SLACK_MIN,
          `box ${boxId}, ${n} chars: ${width}px box, ${lines} line(s) of up to ` +
          `${capacity} chars, leaves only ${slack.toFixed(0)}px clearance around a ${widest}px line`);
        boxW = width;
      }
    } finally { w.close(); }
  }
});

check('the height follows the measured aspect ratio, or the text if taller', () => {
  // 3.png is 1.646:1, so a 132px-wide single-line bubble is ~80px tall. A
  // wrapped line legitimately makes it taller than its own aspect would give —
  // that is the whole point of growing on wrap — so the assertion is one-sided:
  // the box may exceed the aspect height, but never fall below it.
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'action', durationMs: 100, box: BOXES['3'] });
    const width = parseFloat(w.bubble.style.width);
    const height = parseFloat(w.bubble.style.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0) {
      // Sized to the **interior** aspect, not the drawing's: the text lives in
      // the white area, which is 5–38% wider than the drawing (its wings, tails
      // and lace take up space the text can't use), so the interior-derived
      // height is legitimately shorter than `width / aspect`. Using the drawing
      // here is what left the text sitting high with empty space beneath it.
      const interiorH = width / BOXES['3'].geom.ia;
      assert.ok(height >= interiorH - 1,
        `the box must be at least the interior's own height (${interiorH.toFixed(1)}), got ${height}`);
    }
  } finally { w.close(); }
});

check('a one-line bubble at the interior aspect is still reachable', () => {
  // The counterpart to the check above: the aspect is not abandoned, only
  // exceeded when the text needs the room. A short line with a wide bubble
  // should still come out at the interior's proportions — which is the shape
  // the text is laid into, not the drawing's.
  const g = BOXES['3'].geom;
  const w = bootWithLayout(() => ({ width: 16, height: 1 }), '3');
  try {
    w.paint({ text: '嗨' });
    const width = parseFloat(w.bubble.style.width);
    const height = parseFloat(w.bubble.style.height);
    const ratio = width / height;
    assert.ok(Math.abs(ratio - g.ia) < 0.05,
      `expected ~${g.ia}, got ${ratio.toFixed(2)}`);
  } finally { w.close(); }
});

check('a stale size is cleared when the box is dropped', () => {
  // Otherwise the next box-less line would inherit the previous box's size —
  // reintroducing the fixed-size behaviour this replaced.
  const w = boot();
  try {
    w.paint({ text: 'a', kind: 'action', durationMs: 100, box: BOXES['3'] });
    w.paint({ text: 'b', kind: 'action', durationMs: 100, box: null });
    assert.strictEqual(w.bubble.style.width, '', 'inline width must be cleared');
    assert.strictEqual(w.bubble.style.height, '', 'inline height must be cleared');
    assert.strictEqual(w.bubble.style.getPropertyValue('--art-scale'), '',
      'the crop variables must be cleared too');
  } finally { w.close(); }
});

console.log('\n[换行] 多行文字时文本框加高');

check('a wrapped line makes the bubble taller, not clipped', () => {
  // The bug in the screenshot: a two-line line was centred as a block inside a
  // bubble sized for one line, so the text spilled past the white area. Height
  // has to follow the rendered text, not just the width.
  const measure = (s) => {
    const lines = Math.max(1, Math.ceil(s.length / 8));
    return { width: Math.min(240, 28 + 13 * Math.min(s.length, 8)), height: lines * 20 };
  };
  const w = bootWithLayout(measure, '3');
  try {
    w.paint({ text: '午后酒店' });
    const oneLine = parseFloat(w.bubble.style.height);
    w.paint({ text: '午后酒店天吃撒' });
    const twoLines = parseFloat(w.bubble.style.height);
    assert.ok(twoLines > oneLine,
      `a wrapped line must grow the bubble: ${oneLine} -> ${twoLines}`);
  } finally { w.close(); }
});

check('the bubble is never shorter than its text', () => {
  // The invariant behind the wrap fix: whatever the text measures, the bubble
  // has to be at least that tall plus its padding, or the last line is cut off.
  const measure = (s) => ({ width: 28 + 13 * Math.min(s.length, 8), height: Math.ceil(s.length / 8) * 20 });
  const w = bootWithLayout(measure, '5');
  try {
    for (const s of ['嗨', '午后酒店', '午后酒店天吃撒', '这是一句很长很长的提示文字内容']) {
      w.paint({ text: s });
      const h = parseFloat(w.bubble.style.height);
      const need = measure(s).height + 4;
      assert.ok(h >= need, `"${s}": bubble ${h}px is shorter than its ${need}px of text`);
    }
  } finally { w.close(); }
});

check('a single-line bubble still keeps its aspect ratio', () => {
  // Growing on wrap must not quietly change the shape of the common case: with
  // one short line the bubble should still be the measured 3.png proportion.
  const w = bootWithLayout(() => ({ width: 120, height: 20 }), '3');
  try {
    w.paint({ text: '嗨' });
    const ratio = parseFloat(w.bubble.style.width) / parseFloat(w.bubble.style.height);
    const g = require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '3').geom;
    // The drawn bubble is 1.646:1, but the box must be at least as tall as the
    // text, so a short line can make it taller than its own aspect would give.
    assert.ok(ratio <= g.aspect + 0.15,
      `single-line bubble should not be wider than the drawing allows: ${ratio.toFixed(2)} vs ${g.aspect}`);
  } finally { w.close(); }
});

check('the vertical offset tracks the bubble height, not the width', () => {
  // The regression behind "wrapped text sits high": dx/dy are fractions of the
  // drawing's own width and height respectively. Scaling both by the width only
  // worked while the drawings were near-square; once wrapping made the box
  // taller than wide, the vertical correction came out too small.
  const measure = (s) => ({ width: 28 + 13 * Math.min(s.length, 8), height: Math.ceil(s.length / 8) * 20 });
  const g = require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '1').geom;
  const w = bootWithLayout(measure, '1');
  try {
    w.paint({ text: '嗨' });
    const h = parseFloat(w.bubble.style.height);
    const dy = Math.abs(parseFloat(w.bubble.style.getPropertyValue('--text-dy')));
    assert.ok(Math.abs(dy - Math.abs(g.dy) * h) < 0.5,
      `--text-dy should be dy × height (${(Math.abs(g.dy) * h).toFixed(2)}), got ${dy}`);
  } finally { w.close(); }
});

check('the horizontal offset is still measured against the width', () => {
  // The other half of the same fix: growing the height must not drag the
  // sideways correction along with it.
  const measure = (s) => ({ width: 28 + 13 * Math.min(s.length, 8), height: Math.ceil(s.length / 8) * 20 });
  const g = require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '1').geom;
  const w = bootWithLayout(measure, '1');
  try {
    w.paint({ text: '嗨' });
    const bw = parseFloat(w.bubble.style.width);
    const dx = Math.abs(parseFloat(w.bubble.style.getPropertyValue('--text-dx')));
    assert.ok(Math.abs(dx - Math.abs(g.dx) * bw) < 0.5,
      `--text-dx should be dx × width (${(Math.abs(g.dx) * bw).toFixed(2)}), got ${dx}`);
  } finally { w.close(); }
});

check('the no-layout estimate is self-consistent (a short line is one line)', () => {
  // Regression guard on the estimate path. It derived the line count by
  // re-dividing the bubble's outer width by a glyph width — but that width
  // includes the text node's padding, so a 4-character line was "estimated"
  // as 5 lines and the bubble was built twice as tall as needed. The estimate
  // only runs without layout, so this shows up in headless checks rather than
  // on screen; it must still not be nonsense.
  const w = boot();
  try {
    w.paint({ text: '午后酒店', kind: 'action', durationMs: 100, box: BOXES['1'] });
    const width = parseFloat(w.bubble.style.width);
    const height = parseFloat(w.bubble.style.height);
    const g = BOXES['1'].geom;
    // Four characters at the interior aspect is a small, single-line bubble — not
    // a tall one. Allow generous slack for the clamp at ART_MIN_W.
    assert.ok(height <= width / g.ia + 24,
      `a 4-character line should be about one line tall, got ${width}x${height}`);
  } finally { w.close(); }
});

check('the estimate grows the bubble only by the interior aspect or by wrapping', () => {
  // Same guard as above, stated as the invariant that actually holds: height is
  // either the interior's own height for this width, or taller because the text
  // genuinely wrapped. A jump beyond both means the line count is wrong.
  //
  // (Height *does* rise as the text widens — a wider bubble is a taller drawn
  // bubble — so comparing successive heights directly would flag correct
  // behaviour. The ceiling below is per-width, not absolute.)
  const g = BOXES['1'].geom;
  const w = boot();
  try {
    for (const s of ['嗨', '午后酒店', '午后酒店天吃撒', '这是一句很长很长的提示文字']) {
      w.paint({ text: s, kind: 'action', durationMs: 100, box: BOXES['1'] });
      const width = parseFloat(w.bubble.style.width);
      const height = parseFloat(w.bubble.style.height);
      const interiorH = width / g.ia;
      assert.ok(height >= interiorH - 1, `"${s}": shorter than the interior (${height} < ${interiorH.toFixed(1)})`);
      // One wrap at most for these strings; more than that is over-counting.
      assert.ok(height <= interiorH + 2 * 20 + 8,
        `"${s}": ${height}px is far taller than a ${interiorH.toFixed(1)}px interior allows`);
    }
  } finally { w.close(); }
});

check('a box with no geom still renders rather than throwing', () => {
  // Art with no measured row (a PNG added without re-running the measurement
  // script) resolves with the fallback geometry; a payload missing `geom`
  // entirely must degrade instead of breaking the bubble.
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'action', durationMs: 100, box: { id: '9', url: 'file:///x/9.png' } });
    assert.ok(w.bubble.classList.contains('has-art'), 'still shows the artwork');
    assert.strictEqual(w.text.textContent, 'x');
  } finally { w.close(); }
});

console.log('\n[居中] 文字对准白色内区，而不是整个图形');

check('the text is shifted onto the white interior, not the drawing centre', () => {
  // The bug this fixes: the drawing's bounds include its decoration, so
  // centring text on them put it high in the white area (1.png hangs bat wings
  // above the bubble and a cross below it). The measured interior offset has
  // to reach the DOM, or the text stays visibly off-centre.
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'action', durationMs: 100, box: BOXES['1'] });
    const dy = w.bubble.style.getPropertyValue('--text-dy');
    const dx = w.bubble.style.getPropertyValue('--text-dx');
    assert.ok(dy, 'expected a vertical interior offset');
    // 1.png's interior sits above the drawing's centre, so the correction
    // must be negative — this is a real measurement, not a token one.
    assert.ok(parseFloat(dy) < 0, `expected 1.png's dy to be negative, got ${dy}`);
    assert.ok(dx !== '', 'the horizontal offset must be written too, even when 0');
  } finally { w.close(); }
});

check('the offset scales with the bubble, so it stays put as the text grows', () => {
  // The correction is measured as a *fraction* of the drawing, and the drawing
  // scales with the text. If it were a fixed pixel value it would be right for
  // a short line and wrong for a long one.
  //
  // This is asserted with a text height held constant, so the vertical
  // correction tracks the width change on its own. (When the text also wraps,
  // the height moves too — that case is covered by "the vertical offset tracks
  // the bubble height, not the width".)
  const measure = (s) => ({ width: 28 + 13 * Math.min(s.length, 8), height: 20 });
  const shortRun = bootWithLayout(measure, '1');
  const longRun = bootWithLayout(measure, '1');
  try {
    shortRun.paint({ text: '嗨' });          // 1 char  -> 88px floor
    longRun.paint({ text: '午后酒店天吃撒' }); // 7 chars -> 119px, past the floor
    const s = Math.abs(parseFloat(shortRun.bubble.style.getPropertyValue('--text-dx')));
    const l = Math.abs(parseFloat(longRun.bubble.style.getPropertyValue('--text-dx')));
    assert.ok(Number.isFinite(s) && Number.isFinite(l), 'both offsets must be numeric');
    const sw = parseFloat(shortRun.bubble.style.width);
    const lw = parseFloat(longRun.bubble.style.width);
    assert.ok(lw > sw, `fixture: expected a wider bubble, got ${sw} vs ${lw}`);
    assert.ok(l > s, `expected a wider line to shift further: ${s} vs ${l}`);
    // Same drawing, same correction — so the ratio must match the width ratio.
    if (sw > 0 && lw > 0) {
      const bySize = l / s;
      const byWidth = lw / sw;
      assert.ok(Math.abs(bySize - byWidth) < 0.35,
        `offset should track width: ${bySize.toFixed(2)} vs ${byWidth.toFixed(2)}`);
    }
  } finally { shortRun.close(); longRun.close(); }
});

check('a centred box needs no offset, and none is invented', () => {
  // 3.png is symmetric, so its measured offset is 0. Writing a fake non-zero
  // correction here would be worse than writing nothing.
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'action', durationMs: 100, box: BOXES['3'] });
    const dy = parseFloat(w.bubble.style.getPropertyValue('--text-dy'));
    assert.strictEqual(dy, 0, `expected 3.png's dy to be 0, got ${dy}`);
  } finally { w.close(); }
});

check('the offset is cleared along with the artwork', () => {
  // The correction is measured per-box. A leftover value would shift the next
  // box's text by an amount meant for a different drawing.
  const w = boot();
  try {
    w.paint({ text: 'a', kind: 'action', durationMs: 100, box: BOXES['1'] });
    w.paint({ text: 'b', kind: 'action', durationMs: 100, box: null });
    assert.strictEqual(w.bubble.style.getPropertyValue('--text-dy'), '', '--text-dy must be cleared');
    assert.strictEqual(w.bubble.style.getPropertyValue('--text-dx'), '', '--text-dx must be cleared');
  } finally { w.close(); }
});

check('switching boxes replaces the offset rather than adding to it', () => {
  // setProperty, not append: two bubbles in a row must not sum their shifts.
  // Box 6 is the one to switch *to* — it carries the largest measured `dy`, so a
  // leftover shift from a previous box would be impossible to miss.
  const box6 = require(path.join(ROOT, 'main', 'pet_text_boxes.js')).resolve(null, '6');
  const w = boot();
  try {
    w.paint({ text: 'a', kind: 'action', durationMs: 100, box: BOXES['1'] });
    const first = parseFloat(w.bubble.style.getPropertyValue('--text-dy'));
    w.paint({ text: 'b', kind: 'action', durationMs: 100, box: box6 });
    const second = parseFloat(w.bubble.style.getPropertyValue('--text-dy'));
    // `dy` is a fraction of the drawing's *height*, so it scales with the height
    // — not the width, which is what this used to assert. The two coincide only
    // while a box happens to be square; once a wrapped line makes it tall, the
    // width-based expectation is wrong by exactly that ratio. It read as passing
    // only because every shipped box measured `dy` near zero.
    const expected = box6.geom.dy * parseFloat(w.bubble.style.height);
    assert.ok(Math.abs(second - expected) < 0.5,
      `expected box 6's own offset (~${expected.toFixed(2)}), got ${second} (after ${first})`);
    assert.notStrictEqual(first, second, 'the two boxes must not share an offset');
    // 6.png's interior measures as horizontally centred, so its correct `dx` is
    // 0 — asserted here so a future measurement regression (a row-scan latching
    // onto a wing again, which is what produced the old -0.0117) is caught.
    const dx = parseFloat(w.bubble.style.getPropertyValue('--text-dx'));
    assert.ok(Math.abs(dx) < 0.5,
      `expected 6.png's dx to measure ~0, got ${dx}`);
  } finally { w.close(); }
});

check('a box with no measured offset still centres (0, not NaN)', () => {
  // Unmeasured art resolves with the fallback geometry, where dx/dy are 0.
  // A missing field must not become `undefined * width` written into CSS.
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'action', durationMs: 100, box: { id: '9', url: 'file:///x/9.png', geom: {} } });
    const dy = w.bubble.style.getPropertyValue('--text-dy');
    assert.ok(!dy.includes('NaN'), `offset must not be NaN, got ${dy}`);
    assert.strictEqual(parseFloat(dy), 0);
  } finally { w.close(); }
});

check('an unresolvable box ({} or no url) falls back to the CSS bubble', () => {
  // main/pet_text_boxes.resolve returns null for these, but a payload can
  // still arrive malformed; the renderer must not paint a src-less image.
  for (const box of [null, undefined, {}, { id: '9' }, { url: '' }]) {
    const w = boot();
    try {
      w.paint({ text: 'x', kind: 'action', durationMs: 100, box });
      assert.ok(!w.bubble.classList.contains('has-art'), `expected fallback for ${JSON.stringify(box)}`);
      assert.strictEqual(w.art.getAttribute('src'), null);
    } finally { w.close(); }
  }
});

check('re-sending the same box does not rewrite src', () => {
  // The rule engine re-asserts its text every second. Rewriting src would
  // restart the image decode and flicker the artwork on each tick.
  const w = boot();
  try {
    const url = BOXES['3'].url;
    w.paint({ text: 'x', kind: 'meal', durationMs: 100, box: BOXES['3'] });
    let writes = 0;
    Object.defineProperty(w.art, 'src', {
      configurable: true,
      set() { writes++; },
      get() { return url; },
    });
    w.paint({ text: 'x', kind: 'meal', durationMs: 100, box: BOXES['3'] });
    assert.strictEqual(writes, 0, 'an identical src must not be reassigned');
  } finally { w.close(); }
});

console.log('\n[清除] 清空时移除文本框');

check('a clear payload removes the artwork and hides the bubble', () => {
  const w = boot();
  try {
    w.paint({ text: 'x', kind: 'meal', durationMs: 100, box: BOXES['3'] });
    w.paint({ text: null, kind: null, rule: null, box: null });
    assert.ok(w.bubble.classList.contains('hidden'), 'must be hidden');
    assert.ok(!w.bubble.classList.contains('has-art'), 'artwork mode must be left');
    assert.strictEqual(w.art.getAttribute('src'), null, 'artwork src must be released');
    assert.strictEqual(w.bubble.dataset.box, '');
  } finally { w.close(); }
});

check('an action line routed through action-changed keeps its box', () => {
  // The other producer: the controller sends { text, box } on
  // pet:action-changed, and pet.js forwards the box into the same painter.
  const w = boot();
  try {
    w.handlers.get('pet:action-changed')({
      petId: 'x', action: 'default', direction: 'right',
      text: '好香呀', box: BOXES['5'],
    });
    assert.ok(w.bubble.classList.contains('has-art'), 'action-changed must honour the box');
    assert.ok(w.art.getAttribute('src').endsWith('5.png'));
    assert.strictEqual(w.text.textContent, '好香呀');
    assert.strictEqual(w.bubble.dataset.kind, 'action');
  } finally { w.close(); }
});

check('a silent action (text: null) does not strand the artwork', () => {
  const w = boot();
  try {
    w.handlers.get('pet:action-changed')({
      petId: 'x', action: 'default', direction: 'right',
      text: '好香呀', box: BOXES['5'],
    });
    w.handlers.get('pet:action-changed')({ petId: 'x', action: 'default', text: null });
    assert.ok(!w.bubble.classList.contains('has-art'), 'artwork must be cleared');
    assert.strictEqual(w.art.getAttribute('src'), null);
  } finally { w.close(); }
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);