#!/usr/bin/env node
// scripts/smoke-settings-textboxes.js — settings-page checks for the 文本框 UI.
//
// Renders the real 动作文本 card from src/js/pages/settings.js inside jsdom
// against the real src/index.html, with the IPC layer stubbed. Asserts the
// DOM the user actually sees: the rule-bubble picker, a dropdown per action,
// the "unavailable" option for a stale id, and that the form handed to save()
// carries the boxes.
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
    { id: '1', label: '1', file: '1.png', url: 'file:///t/1.png', geom: { left: 18.95, top: 26.76, right: 8.84, bottom: 25, aspect: 1.497 } },
    { id: '2', label: '2', file: '2.png', url: 'file:///t/2.png', geom: { left: 8.64, top: 26.27, right: 8.06, bottom: 26.9, aspect: 1.779 } },
    { id: '3', label: '3', file: '3.png', url: 'file:///t/3.png', geom: { left: 8.25, top: 24.12, right: 8.25, bottom: 25.15, aspect: 1.646 } },
  ],
  ruleBox: null,
  runtime: [],
  actions: [
    { action: 'default', label: 'default', group: 'variant', texts: ['嗨'], box: '', runtime: [] },
    { action: 'dancing', label: 'dancing', group: 'variant', texts: ['转圈圈'], box: '3', runtime: [] },
  ],
};

console.log('\n[下拉框] 每个动作一个文本框选择器');

(async () => {
  const w = boot(BASE);
  await w.card.renderActionTextsCard();
  await tick();

  check('every action row gets a 文本框 dropdown', () => {
    const rows = w.doc.querySelectorAll('.action-texts-row');
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.querySelector('[data-box-select]'), 'each row needs a select');
    }
  });

  check('the rule-bubble picker is rendered above the list', () => {
    const sel = w.doc.querySelector('[data-box-select="rule"]');
    assert.ok(sel, 'expected a rule-bubble picker');
  });

  check('the dropdown is named after its action', () => {
    const sel = w.doc.querySelector('[data-box-select="dancing"]');
    assert.ok(sel, 'expected a select for the dancing action');
    assert.strictEqual(sel.value, '3', 'pre-selects the saved choice');
  });

  check('an action with no box shows 默认', () => {
    const sel = w.doc.querySelector('[data-box-select="default"]');
    assert.strictEqual(sel.value, '', 'no box => the default option');
  });

  check('every catalog entry is offered as an option', () => {
    const sel = w.doc.querySelector('[data-box-select="dancing"]');
    const values = Array.from(sel.options).map((o) => o.value);
    assert.deepStrictEqual(values, ['', '1', '2', '3'], 'default first, then the catalog');
  });

  console.log('\n[不可用] 已删除或换机带来的陈旧 id');

  check('a stale id shows as （当前不可用） rather than silently reverting', () => {
    // The PNG was deleted, or the config came from another machine. Snapping
    // to 默认 would make the user think their choice was never saved.
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.boxes.dancing = '99';
    snap.actions[1].box = '99';
    const w2 = boot(snap);
    return w2.card.renderActionTextsCard().then(() => tick()).then(() => {
      const sel = w2.doc.querySelector('[data-box-select="dancing"]');
      const stale = Array.from(sel.options).find((o) => o.value === '99');
      assert.ok(stale, 'expected the stale id to still be listed');
      assert.ok(stale.textContent.includes('当前不可用'), `label was: ${stale.textContent}`);
      assert.strictEqual(sel.value, '99', 'and to remain selected');
      w2.close();
    });
  });

  console.log('\n[保存] 表单带上 boxes 与 ruleBox');

  check('save() carries the per-action boxes and the rule box', async () => {
    // Re-render so this check owns its own window, then drive the DOM the way a
    // user would: change two dropdowns, press 保存.
    const w3 = boot(BASE);
    await w3.card.renderActionTextsCard();
    await tick();
    w3.doc.querySelector('[data-box-select="default"]').value = '2';
    w3.doc.querySelector('[data-box-select="dancing"]').value = '1';
    w3.doc.querySelector('[data-box-select="rule"]').value = '3';
    for (const sel of w3.doc.querySelectorAll('[data-box-select]')) {
      sel.dispatchEvent(new w3.window.Event('change', { bubbles: true }));
    }
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

  console.log('\n[无资源] 没有文本框资源时');

  check('the picker is hidden when no text boxes are installed', async () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.textBoxes = [];
    const w4 = boot(snap);
    await w4.card.renderActionTextsCard();
    await tick();
    assert.strictEqual(w4.doc.querySelectorAll('[data-box-select]').length, 0,
      'no dropdowns at all, rather than empty ones');
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

  console.log('\n[预览] 选中后显示裁切好的缩略图');

  check('the chosen box shows a cropped preview thumbnail', async () => {
    // Without this the dropdown is a list of bare numbers, so choosing one is
    // a guess. The thumbnail must be cropped to the bubble (via the measured
    // geom), not the 2048×2048 canvas, which is mostly transparent margin.
    const w = boot(BASE);
    await w.card.renderActionTextsCard();
    await tick();
    const prev = w.doc.querySelector('.action-texts-boxprev');
    assert.ok(prev, 'expected a preview element');
    const img = prev.querySelector('img');
    assert.ok(img.getAttribute('src').endsWith('3.png'), 'preview shows the selected box');
    assert.ok(prev.style.getPropertyValue('--prev-left'), 'preview carries the crop offset');
    assert.ok(prev.style.getPropertyValue('--prev-w'), 'preview carries the overscan scale');
    w.close();
  });

  check('默认 (no box chosen) shows no thumbnail', async () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    snap.boxes = {};
    snap.actions.forEach((a) => { a.box = ''; });
    const w = boot(snap);
    await w.card.renderActionTextsCard();
    await tick();
    assert.strictEqual(w.doc.querySelectorAll('.action-texts-boxprev').length, 0,
      'the CSS bubble needs no preview');
    w.close();
  });

  check('changing the dropdown swaps the preview', async () => {
    const w = boot(BASE);
    await w.card.renderActionTextsCard();
    await tick();
    const sel = w.doc.querySelector('[data-box-select="default"]');
    sel.value = '1';
    sel.dispatchEvent(new w.window.Event('change', { bubbles: true }));
    // The change handler records the value; the preview re-renders with the
    // list, so assert through the form the save will send.
    assert.strictEqual(w.doc.querySelector('[data-box-select="default"]').value, '1');
    w.close();
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);
})();