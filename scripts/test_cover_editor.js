// scripts/test_cover_editor.js — checks the shared cover editor.
//
// The cover editor used to live inside the diary editor page. It is now a
// module of its own (src/js/cover_editor.js) that the diary editor AND the
// photo wall both open, so this check is about the module: that it builds
// its DOM, that it shows the picture, that it locks the shape when the
// caller asks it to, and that 保存 hands the cover back.
//
// Run: node scripts/test_cover_editor.js

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.Image = dom.window.Image;
// api.js only checks that the bridge is there when it is imported.
window.mp = {};

(async () => {
  const { openCoverEditor } = await import('../src/js/cover_editor.js');
  const report = { ok: false, checks: {} };

  // A picture that is not really a picture is fine — the editor only needs
  // the size, and the size is handed over.
  const saved = [];
  openCoverEditor({
    url: 'data:image/png;base64,',
    name: '测试照片',
    cover: { ratio: '16:9', x: 0.4, y: 0.6, zoom: 2 },
    picW: 800,
    picH: 600,
    onSave: (cover) => saved.push(cover),
  });

  const el = document.getElementById('cover-editor');
  report.checks.opened = !!(el && el.classList.contains('open'));
  report.checks.title = el ? el.querySelector('.cover-editor-title').textContent : '';
  report.checks.ratioButtons = el ? el.querySelectorAll('.cover-editor-ratio').length : 0;
  report.checks.framePlaced = el
    ? (el.querySelector('.cover-editor-frame').style.width !== '')
    : false;

  // 保存 hands the cover back.
  el.querySelector('.cover-editor-save').click();
  report.checks.saved = saved.length === 1 && saved[0].ratio === '16:9'
    && saved[0].zoom === 2 && Math.abs(saved[0].x - 0.4) < 1e-6;

  // A locked shape: the wall's cells have a shape of their own, so the
  // frame may not wander off it.
  openCoverEditor({
    url: 'data:image/png;base64,',
    name: '锁形状',
    cover: null,
    picW: 800,
    picH: 600,
    lockRatio: '1:1',
    onSave: (cover) => saved.push(cover),
  });
  const ratios = [...document.querySelectorAll('.cover-editor-ratio')];
  report.checks.lockedRatioButtons = ratios.length === 1
    && ratios[0].dataset.ratio === '1:1';
  // 重置 puts the frame back to the locked shape, centred.
  document.querySelector('.cover-editor-reset').click();
  document.querySelector('.cover-editor-save').click();
  const last = saved[saved.length - 1];
  report.checks.lockedReset = !!last && last.ratio === '1:1'
    && last.x === 0.5 && last.y === 0.5 && last.zoom === 1;

  // 取消 closes without saving.
  const before = saved.length;
  openCoverEditor({ url: 'data:image/png;base64,', name: '取消', picW: 10, picH: 10, onSave: () => {} });
  document.querySelector('.cover-editor-cancel').click();
  report.checks.cancel = saved.length === before
    && !document.getElementById('cover-editor').classList.contains('open');

  report.ok = report.checks.opened
    && report.checks.title === '测试照片'
    && report.checks.ratioButtons === 5
    && report.checks.framePlaced
    && report.checks.saved
    && report.checks.lockedRatioButtons
    && report.checks.lockedReset
    && report.checks.cancel;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
})();
