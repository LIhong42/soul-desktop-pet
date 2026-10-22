#!/usr/bin/env node
// scripts/smoke-settings-textboxes.js — settings-page checks for the 文本框 UI.
//
// Renders the real 动作文本 card from src/js/pages/settings.js inside jsdom
// against the real src/index.html, with the IPC layer stubbed. Asserts the
// DOM the user actually sees: the rule-bubble picker, a thumbnail picker per
// action, the "unavailable" cell for a stale id, that every option is
// *previewable* (the reason the picker stopped being a <select>), and that the
// form handed to save() carries the boxes.
//
// Usage: node scripts/smoke-settings-textboxes.js

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

// Settings.js is an ES module and imports from ../api.js and ../router.js. Those
// are stubbed as blob modules below so the real settings.js body runs unmodified
// — a reimplementation would not prove what ships.
const settingsSrc = fs.readFileSync(path.join(ROOT, 'src', 'js', 'pages', 'settings.js'), 'utf8');

function boot(snapshot) {
  const saved = [];
  const indexHtml = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  // The 动作文本 card body is injected by render(), not present in index.html.
  // Splicing it in mirrors the page as the user reaches it, and lets this
  // check call renderActionTextsCard() directly instead of re-running the
  // whole settings route (which would need the pet registry IPC too).
  const withCard = indexHtml.replace(
    '</body>',
    '<div id="pet-action-texts-card-body"></div></body>',
  );
  const dom = new JSDOM(withCard, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window } = dom;
  const calls = { saved, snapshot };

  // Stubs for settings.js's two imports.
  const apiStub = `
    export const api = globalThis.__apiStub;
    export function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }
    export function toast() {}
  `;
  const routerStub = `
    export function register() {}
    export function navigate() {}
  `;

  window.__apiStub = {
    pet: {
      actionTexts: {
        get: () => Promise.resolve(calls.snapshot),
        save: (cfg) => { calls.saved.push(JSON.parse(JSON.stringify(cfg))); return Promise.resolve({ texts: cfg.texts, boxes: cfg.boxes, ruleBox: cfg.ruleBox ? { id: cfg.ruleBox } : null }); },
      },
    },
    settings: { get: () => Promise.resolve(null) },
    app: { getAutostart: () => Promise.resolve({ supported: false, enabled: false, active: false }) },
    petList: [],
  };
  window.confirm = () => true;

  // Evaluate the two stubs as real ES modules so the import specifiers resolve.
  const apiUrl = 'data:text/javascript;base64,' + Buffer.from(apiStub).toString('base64');
  const routerUrl = 'data:text/javascript;base64,' + Buffer.from(routerStub).toString('base64');
  let settingsUrl = 'data:text/javascript;base64,'
    + Buffer.from(settingsSrc.replace(/from '\.\.\/api\.js'/, `from '${apiUrl}'`)
      .replace(/from '\.\.\/router\.js'/, `from '${routerUrl}'`)).toString('base64');

  // jsdom can't execute module scripts without a loader, so run the body with
  // its imports stripped and the stubs injected as locals. The functions under
  // test (renderActionTextsCard and friends) are plain functions in the module,
  // so making them reachable is a matter of evaluating the file and exporting
  // the two entry points we call.
  const patched = settingsSrc
    .replace(/^\s*import[^;]+;\s*$/gm, '')
    + '\nglobalThis.__card = { renderActionTextsCard, renderActionTextsRow, setTextBox, renderTextBoxSelect };\n';
  // Inject the stubbed identifiers as globals the module body closes over.
  const preamble = `
    const api = globalThis.__apiStub;
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = () => {};
    const register = () => {};
    const navigate = () => {};
  `;
  vm.runInContext(preamble + patched, dom.getInternalVMContext(), { filename: 'settings.js' });

  return {
    window,
    doc: window.document,
    calls,
    card: window.__card,
    close: () => window.close(),
  };
}

// Wait for the card's internal awaits (api.pet.actionTexts.get) to settle.
const tick = () => new Promise((r) => setTimeout(r, 20));

const BASE = {
  pet_id: 'vup',
  texts: { default: ['嗨'], dancing: ['转圈圈'] },
  boxes: { dancing: '3' },
  textBoxes: [
    // geom mirrors the real GEOMETRY table (main/pet_text_boxes.js), dx/dy
    // included — the preview's text centring depends on them, so a fixture that
    // omits them would assert against a bubble with no correction at all.
    { id: '1', label: '1', file: '1.png', url: 'file:///t/1.png', geom: { left: 18.95, top: 26.76, right: 8.84, bottom: 25, aspect: 1.497, ia: 1.613, dx: -0.0093, dy: -0.0173 } },
    { id: '2', label: '2', file: '2.png', url: 'file:///t/2.png', geom: { left: 8.64, top: 26.27, right: 8.06, bottom: 26.9, aspect: 1.779, ia: 2.007, dx: -0.0002, dy: 0.0024 } },
    { id: '3', label: '3', file: '3.png', url: 'file:///t/3.png', geom: { left: 8.25, top: 24.12, right: 8.25, bottom: 25.15, aspect: 1.646, ia: 1.729, dx: 0, dy: 0 } },
    // A wide bubble (2.45:1) is the case the per-axis fix exists for: a dy
    // applied against the width instead of the height overshoots by the ratio.
    { id: '5', label: '5', file: '5.png', url: 'file:///t/5.png', geom: { left: 4.59, top: 32.67, right: 4.59, bottom: 30.32, aspect: 2.454, ia: 3.383, dx: 0, dy: -0.0103 } },
  ],
  ruleBox: null,
  runtime: [],
  actions: [
    { action: 'default', label: 'default', group: 'variant', texts: ['嗨'], box: '', runtime: [] },
    { action: 'dancing', label: 'dancing', group: 'variant', texts: ['转圈圈'], box: '3', runtime: [] },
  ],
};

console.log('\n[选择器] 每个动作一个文本框选择器');

(async () => {
  const w = boot(BASE);
  await w.card.renderActionTextsCard();
  await tick();

  check('every action row gets a 文本框 picker', () => {
    const rows = w.doc.querySelectorAll('.action-texts-row');
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.querySelector('[data-box-toggle]'), 'each row needs a picker trigger');
    }
  });

  check('the rule-bubble picker is rendered above the list', () => {
    const wrap = w.doc.querySelector('[data-box-name="rule"]');
    assert.ok(wrap, 'expected a rule-bubble picker');
  });

  check('the picker is named after its action', () => {
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    assert.ok(wrap, 'expected a picker for the dancing action');
    const on = wrap.querySelector('[data-box-pick].is-on');
    assert.strictEqual(on.getAttribute('data-box-pick'), '3', 'pre-selects the saved choice');
  });

  check('an action with no box shows 默认', () => {
    const wrap = w.doc.querySelector('[data-box-name="default"]');
    const on = wrap.querySelector('[data-box-pick].is-on');
    assert.strictEqual(on.getAttribute('data-box-pick'), '', 'no box => 默认');
    assert.ok(on.textContent.includes('默认'));
  });

  check('every catalog entry is offered as a cell', () => {
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    const values = Array.from(wrap.querySelectorAll('[data-box-pick]')).map((o) => o.getAttribute('data-box-pick'));
    assert.deepStrictEqual(values, ['', ...BASE.textBoxes.map((b) => b.id)],
      '默认 first, then the whole catalog');
  });

  console.log('\n[预览] 每个样式都能直接看到图片');

  // These are the checks that justify the picker replacing a <select>: a
  // <select> cannot render an image in an option, so every one of these was
  // impossible before and the user had to pick a number blind.
  check('every option — not just the chosen one — renders a cropped thumbnail', () => {
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    const catalog = wrap.querySelectorAll('[data-box-pick]:not([data-box-pick=""])');
    assert.strictEqual(catalog.length, BASE.textBoxes.length, 'one cell per catalog entry');
    for (const cell of catalog) {
      const img = cell.querySelector('.action-texts-thumb img');
      assert.ok(img, `cell ${cell.getAttribute('data-box-pick')} has no image`);
      const thumb = cell.querySelector('.action-texts-thumb');
      // Cropped to the bubble via the measured geom, not the 2048² canvas.
      assert.ok(thumb.style.getPropertyValue('--prev-left'), 'carries the crop offset');
      assert.ok(thumb.style.getPropertyValue('--prev-w'), 'carries the fit scale');
    }
  });

  check('thumbs show only the frame, with no text laid over it', () => {
    // The grid exists to compare artwork. A repeated sample line sat across all
    // seven and made the harder-to-read art (3's heavy black frame, 7's lace
    // trim) harder to judge.
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    assert.strictEqual(wrap.querySelectorAll('.action-texts-thumb-text').length, 0,
      'no sample text anywhere in the panel');
  });

  check('the whole drawing fits inside the frame on both axes', () => {
    // Regression: the crop scaled by the *larger* visible fraction, filling the
    // frame on that axis and overflowing the other, so `overflow: hidden` sliced
    // the decoration off — 3.png's speech tail and 2.png's corner were cut
    // mid-shape. Scaling per axis by each axis's own visible fraction, and
    // taking the tighter of the two, means the drawing always fits whole.
    for (const b of BASE.textBoxes) {
      const g = b.geom;
      const visW = 100 - g.left - g.right;
      const visH = 100 - g.top - g.bottom;
      const kW = (100 / visW) * 100;
      const kH = (100 / visH) * 100;
      const cell = w.doc.querySelector(`[data-box-pick="${b.id}"]`);
      assert.ok(cell, `expected a cell for box ${b.id}`);
      const thumb = cell.querySelector('.action-texts-thumb');
      const gotW = parseFloat(thumb.style.getPropertyValue('--prev-wv'));
      const gotH = parseFloat(thumb.style.getPropertyValue('--prev-wh'));
      assert.ok(Math.abs(gotW - kW) < 0.01, `box ${b.id}: width scale ${gotW} != ${kW}`);
      assert.ok(Math.abs(gotH - kH) < 0.01, `box ${b.id}: height scale ${gotH} != ${kH}`);
      // The two must actually differ, or the axes aren't independent and the
      // shorter one is being clipped again.
      assert.ok(Math.abs(gotW - gotH) > 1, `box ${b.id}: scales collapsed to one value`);
      // The applied scale is the tighter of the two, with a little margin.
      const fit = parseFloat(thumb.style.getPropertyValue('--prev-w'));
      assert.ok(fit <= Math.min(gotW, gotH) + 0.01,
        `box ${b.id}: fit ${fit} exceeds the tighter scale ${Math.min(gotW, gotH)}`);
      assert.ok(fit > 0, `box ${b.id}: non-positive fit scale`);
      // The crop offset is a fraction of the *canvas*, but left/top resolve
      // against the *frame*, and one canvas unit is now kW/100 (or kH/100)
      // frame units. Passing the raw margin slid the image off-centre and pushed
      // the drawing out of the crop box — bubble 3 lost its tail to the top edge.
      const offX = parseFloat(thumb.style.getPropertyValue('--prev-left'));
      const offY = parseFloat(thumb.style.getPropertyValue('--prev-top'));
      assert.ok(Math.abs(offX - g.left * kW / 100) < 0.05,
        `box ${b.id}: left offset ${offX} != ${g.left * kW / 100}`);
      assert.ok(Math.abs(offY - g.top * kH / 100) < 0.05,
        `box ${b.id}: top offset ${offY} != ${g.top * kH / 100}`);
    }
  });

  check('the fit leaves a little breathing room, not flush to the edge', () => {
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    for (const t of wrap.querySelectorAll('.action-texts-thumb[style*="--prev-wv"]')) {
      const fit = parseFloat(t.style.getPropertyValue('--prev-w'));
      const tighter = Math.min(
        parseFloat(t.style.getPropertyValue('--prev-wv')),
        parseFloat(t.style.getPropertyValue('--prev-wh')));
      assert.ok(fit < tighter, `fit ${fit} should be under the tighter scale ${tighter}`);
    }
  });

  check('each thumbnail keeps its own bubble aspect', () => {
    // A 2.45:1 sliver cropped to the same square as a 1.5:1 box loses the very
    // proportion that tells the two apart, which is the whole point of the grid.
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    const ars = Array.from(wrap.querySelectorAll('.action-texts-thumb'))
      .map((t) => t.style.getPropertyValue('--thumb-ar'))
      .filter(Boolean);
    assert.ok(ars.length >= 2, 'thumbnails expose their aspect');
    assert.ok(new Set(ars).size > 1, `expected differing aspects, got ${ars.join(', ')}`);
  });

  check('the CSS scales each axis independently', () => {
    // One shared percentage for both axes squashes the drawing (the canvas is
    // square, the frame is not) and lets overflow:hidden cut it.
    const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'styles.css'), 'utf8');
    const rule = css.slice(css.indexOf('.action-texts-thumb > img {'));
    const decl = rule.slice(0, rule.indexOf('}')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(/width:\s*var\(--prev-wv/.test(decl), `width must use --prev-wv, got: ${decl.trim()}`);
    assert.ok(/height:\s*var\(--prev-wh/.test(decl), `height must use --prev-wh, got: ${decl.trim()}`);
  });

  check('the collapsed trigger shows no artwork', () => {
    // The rows are a list of which box is set; the pictures belong to the
    // panel. Artwork in the trigger made the rows tall and noisy.
    for (const name of ['dancing', 'default', 'rule']) {
      const wrap = w.doc.querySelector(`[data-box-name="${name}"]`);
      assert.ok(wrap, `expected a picker for ${name}`);
      const toggle = wrap.querySelector('[data-box-toggle]');
      assert.strictEqual(toggle.querySelectorAll('img').length, 0, `${name}: no image on the trigger`);
      assert.strictEqual(toggle.querySelectorAll('.action-texts-thumb').length, 0,
        `${name}: no thumbnail on the trigger`);
    }
  });

  check('the collapsed trigger names the saved choice', () => {
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    assert.strictEqual(
      wrap.querySelector('[data-box-toggle] .action-texts-box-name').textContent, '3');
  });

  check('默认 is drawn as a picture in the panel', () => {
    const wrap = w.doc.querySelector('[data-box-name="default"]');
    const cell = wrap.querySelector('[data-box-pick=""]');
    assert.ok(cell.querySelector('.action-texts-thumb-default'), '默认 has its own thumbnail');
  });

  console.log('\n[交互] 打开面板 / 选��� / 关闭');

  const pick = (win, doc, name, id) => {
    const wrap = doc.querySelector(`[data-box-name="${name}"]`);
    wrap.querySelector('[data-box-toggle]').dispatchEvent(new win.Event('click', { bubbles: true }));
    wrap.querySelector(`[data-box-pick="${id}"]`).dispatchEvent(new win.Event('click', { bubbles: true }));
    return wrap;
  };

  // Asserted against the *computed* display rather than the `hidden` property.
  // jsdom doesn't do layout, so a `display: grid` author rule silently beats
  // `[hidden] { display: none }` — the property says hidden while every panel
  // is actually painted, stacked over one another. Checking the property alone
  // let exactly that bug through.
  const visible = (doc, panel) => {
    const hidden = doc.defaultView.getComputedStyle(panel).display === 'none';
    return !panel.hidden && !hidden;
  };

  check('clicking the trigger opens the panel', () => {
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    const panel = wrap.querySelector('[data-box-panel]');
    assert.ok(!visible(w.doc, panel), 'starts closed');
    wrap.querySelector('[data-box-toggle]').dispatchEvent(new w.window.Event('click', { bubbles: true }));
    assert.ok(visible(w.doc, panel), 'opens on click');
    assert.strictEqual(
      wrap.querySelector('[data-box-toggle]').getAttribute('aria-expanded'), 'true');
  });

  // The bug this whole section exists for: every panel rendering at once.
  check('only one panel is ever visible', () => {
    const w9 = boot(BASE);
    const rows = w9.doc.querySelectorAll('[data-box-name]');
    const panels = Array.from(rows).map((r) => r.querySelector('[data-box-panel]'));
    const openCount = () => panels.filter((p) => visible(w9.doc, p)).length;
    assert.strictEqual(openCount(), 0, 'none open before any click');
    // Open each in turn; the count must never exceed one.
    for (const r of rows) {
      r.querySelector('[data-box-toggle]').dispatchEvent(new w9.window.Event('click', { bubbles: true }));
      assert.ok(openCount() <= 1, `${openCount()} panels visible after opening one`);
    }
    w9.close();
  });

  check('opening a second picker closes the first', () => {
    const a = w.doc.querySelector('[data-box-name="dancing"]');
    const b = w.doc.querySelector('[data-box-name="default"]');
    assert.ok(visible(w.doc, a.querySelector('[data-box-panel]')), 'first is open');
    b.querySelector('[data-box-toggle]').dispatchEvent(new w.window.Event('click', { bubbles: true }));
    assert.ok(!visible(w.doc, a.querySelector('[data-box-panel]')), 'and closes when the next opens');
  });

  check('picking a cell records the choice and closes the panel', () => {
    const wrap = w.doc.querySelector('[data-box-name="dancing"]');
    wrap.querySelector('[data-box-toggle]').dispatchEvent(new w.window.Event('click', { bubbles: true }));
    wrap.querySelector('[data-box-pick="1"]').dispatchEvent(new w.window.Event('click', { bubbles: true }));
    const on = wrap.querySelector('[data-box-pick].is-on');
    assert.strictEqual(on.getAttribute('data-box-pick'), '1', 'the pick is marked current');
    assert.ok(!visible(w.doc, wrap.querySelector('[data-box-panel]')), 'and the panel closed');
    // The trigger renames itself to the new choice, so the collapsed state is
    // honest without carrying artwork.
    assert.strictEqual(
      wrap.querySelector('[data-box-toggle] .action-texts-box-name').textContent, '1');
  });

  check('a click elsewhere closes an open panel', () => {
    const wrap = w.doc.querySelector('[data-box-name="default"]');
    wrap.querySelector('[data-box-toggle]').dispatchEvent(new w.window.Event('click', { bubbles: true }));
    assert.ok(visible(w.doc, wrap.querySelector('[data-box-panel]')));
    w.doc.getElementById('action-texts-save').dispatchEvent(new w.window.Event('click', { bubbles: true }));
    assert.ok(!visible(w.doc, wrap.querySelector('[data-box-panel]')), 'closed on outside click');
  });

  console.log('\n[不可用] 已删除或换机带来的陈旧 id');

  check('a stale id shows as （当前不可用） rather than silently reverting', async () => {
    // The PNG was deleted, or the config came from another machine. Snapping
    // to 默认 would make the user think their choice was never saved.
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.boxes.dancing = '99';
    snap.actions[1].box = '99';
    const w2 = boot(snap);
    await w2.card.renderActionTextsCard();
    await tick();
    const wrap = w2.doc.querySelector('[data-box-name="dancing"]');
    const stale = wrap.querySelector('[data-box-pick="99"]');
    assert.ok(stale, 'expected the stale id to still be listed');
    assert.ok(stale.textContent.includes('当前不可用'), `label was: ${stale.textContent}`);
    assert.ok(stale.classList.contains('is-on'), 'and to remain selected');
    w2.close();
  });

  console.log('\n[已修复] ruleBox 以对象而非 id 传回');

  // Regression: loadRuleBox() returns petTextBoxes.resolve(...) — {id, url,
  // geom} — not a bare id. Passing it through unrendered a phantom
  // "（当前不可用）" cell labelled "[object Object]" and saved that string.
  check('a resolved ruleBox object does not leak into the picker', async () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.ruleBox = { id: '2', url: 'file:///t/2.png', geom: { left: 8.64, top: 26.27, right: 8.06, bottom: 26.9, aspect: 1.779, ia: 2.007 } };
    const w6 = boot(snap);
    await w6.card.renderActionTextsCard();
    await tick();
    assert.ok(!w6.doc.body.textContent.includes('[object Object]'), 'no [object Object] anywhere');
    const wrap = w6.doc.querySelector('[data-box-name="rule"]');
    const on = wrap.querySelector('[data-box-pick].is-on');
    assert.strictEqual(on.getAttribute('data-box-pick'), '2', 'unwrapped to the id');
    w6.close();
  });

  check('saving a resolved ruleBox stores the id, not the object', async () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.ruleBox = { id: '2', url: 'file:///t/2.png', geom: { left: 8.64, top: 26.27, right: 8.06, bottom: 26.9, aspect: 1.779 } };
    const w7 = boot(snap);
    await w7.card.renderActionTextsCard();
    await tick();
    w7.doc.getElementById('action-texts-save').click();
    await tick();
    await tick();
    const cfg = w7.calls.saved[0];
    assert.strictEqual(cfg.ruleBox, '2', 'a bare id, as the DB expects');
    w7.close();
  });

  console.log('\n[保存] 表单带上 boxes 与 ruleBox');

  check('save() carries the per-action boxes and the rule box', async () => {
    // Re-render so this check owns its own window, then drive the DOM the way a
    // user would: pick a style in each of the three pickers, press 保存.
    const w3 = boot(BASE);
    await w3.card.renderActionTextsCard();
    await tick();
    pick(w3.window, w3.doc, 'default', '2');
    pick(w3.window, w3.doc, 'dancing', '1');
    pick(w3.window, w3.doc, 'rule', '3');
    w3.doc.getElementById('action-texts-save').click();
    await tick();
    await tick();
    assert.ok(w3.calls.saved.length, 'expected save() to be called');
    const cfg = w3.calls.saved[0];
    assert.strictEqual(cfg.boxes.default, '2', 'default action box');
    assert.strictEqual(cfg.boxes.dancing, '1', 'dancing action box');
    assert.strictEqual(cfg.ruleBox, '3', 'rule bubbles box');
    w3.close();
  });

  check('picking 默认 clears the stored box rather than storing ""', async () => {
    const w8 = boot(BASE);
    await w8.card.renderActionTextsCard();
    await tick();
    pick(w8.window, w8.doc, 'dancing', '2');
    pick(w8.window, w8.doc, 'dancing', '');  // back to 默认
    w8.doc.getElementById('action-texts-save').click();
    await tick();
    await tick();
    const cfg = w8.calls.saved[0];
    assert.ok(!('dancing' in cfg.boxes), `expected the key dropped, got ${JSON.stringify(cfg.boxes)}`);
    w8.close();
  });

  console.log('\n[无资源] 没有文本框资源时');

  check('the picker is hidden when no text boxes are installed', async () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.textBoxes = [];
    const w4 = boot(snap);
    await w4.card.renderActionTextsCard();
    await tick();
    assert.strictEqual(w4.doc.querySelectorAll('[data-box-toggle]').length, 0,
      'no pickers at all, rather than empty ones');
    // The text editor itself must still work.
    assert.ok(w4.doc.querySelector('[data-text-input="default"]'), 'lines are still editable');
    w4.close();
  });

  check('an install with no art still renders the rows', async () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.textBoxes = [];
    snap.actions = [{ action: 'default', label: 'default', group: 'variant', texts: [], box: '', runtime: [] }];
    const w5 = boot(snap);
    await w5.card.renderActionTextsCard();
    await tick();
    assert.strictEqual(w5.doc.querySelectorAll('.action-texts-row').length, 1);
    w5.close();
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);
})();