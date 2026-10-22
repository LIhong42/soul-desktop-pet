#!/usr/bin/env node
// scripts/preview-textbox-picker.js — build a STATIC preview of the 文本框 picker.
//
// No vm, no eval, no app code executed: this only does string math to emit the
// same markup renderTextBoxSelect() produces, using the real GEOMETRY table
// (copied from main/pet_text_boxes.js) so the thumbnails crop exactly as they
// do in the app. The real src/css/styles.css is inlined.
//
// The point is to let headless Chrome screenshot the picker without booting
// Electron — the settings card is renderer-side only, so markup + CSS is all
// the visual surface it has.
//
// Usage: node scripts/preview-textbox-picker.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-textbox-preview.html');

const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'styles.css'), 'utf8');

// The PNGs are addressed absolutely: the preview page is written to the repo
// root but rendered from wherever headless Chrome is pointed, so a relative
// path silently 404s and every thumbnail renders as bare text — which looks
// exactly like the crop being broken.
const BOX_URL = (id) => 'file:///' + path.join(ROOT, 'resources', 'text_boxes', `${id}.png`)
  .replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');

// id, and the measured geometry from main/pet_text_boxes.js.
const BOXES = [
  ['1', 18.95, 26.76, 8.84, 25.00, 1.497, -0.0093, -0.0173],
  ['2',  8.64, 26.27, 8.06, 26.90, 1.779, -0.0002,  0.0024],
  ['3',  8.25, 24.12, 8.25, 25.15, 1.646,  0,       0],
  ['4', 11.38, 29.20, 11.33, 29.25, 1.860,  0.0034, -0.0081],
  ['5',  4.59, 32.67, 4.59, 30.32, 2.454,  0,      -0.0103],
  ['6', 11.47, 25.29, 11.47, 24.80, 1.544,  0,       0.0105],
  ['7',  6.20, 27.59, 6.20, 23.97, 1.808,  0,      -0.0173],
];

// Same arithmetic as renderTextBoxThumb in settings.js.
function thumb(id, l, t, r, b, aspect) {
  // Mirrors renderTextBoxThumb: fit the whole drawing, scaling each axis by its
  // own visible fraction, taking the tighter of the two, and scaling the crop
  // offsets by the same factors (they resolve against the frame, not the canvas).
  const visW = 100 - l - r;
  const visH = 100 - t - b;
  const kW = (100 / visW) * 100;
  const kH = (100 / visH) * 100;
  const k = Math.min(kW, kH) * 0.94;
  const offX = (l * kW) / 100;
  const offY = (t * kH) / 100;
  const w = Math.min(100, 62 * aspect);
  return `<span class="action-texts-thumb" style="--prev-w:${k}%;--prev-wv:${kW}%;--prev-wh:${kH}%;--prev-left:${offX}%;--prev-top:${offY}%;--thumb-w:${w}%;--thumb-ar:${aspect}">
      <img alt="" src="${BOX_URL(id)}">
    </span>`;
}

const DEFAULT_THUMB = `<span class="action-texts-thumb action-texts-thumb-default"></span>`;

function cell(id, label, inner, on) {
  return `<button type="button" class="action-texts-cell${on ? ' is-on' : ''}">
      ${inner}<span class="action-texts-cell-name">${label}</span>
    </button>`;
}

function picker(label, selected, open) {
  const chosen = BOXES.find((b) => b[0] === selected);
  const name = chosen ? chosen[0] : (selected ? `${selected}（当前不可用）` : '默认');
  const cells = [
    cell('', '默认', DEFAULT_THUMB, selected === ''),
    ...BOXES.map(([id, l, t, r, b, a]) => cell(id, id, thumb(id, l, t, r, b, a), id === selected)),
  ].join('');
  // Mirrors renderTextBoxSelect: no artwork on the collapsed trigger, `hidden`
  // on the panel, `data-open` on the wrap while it is open.
  return `<div class="rowline">
      <span class="lab">${label}</span>
      <span class="action-texts-boxwrap"${open ? ' data-open' : ''}>
        <button type="button" class="action-texts-box" aria-expanded="${open}">
          <span class="action-texts-box-name">${name}</span>
          <span class="action-texts-box-caret">▾</span>
        </button>
        <span class="action-texts-panel" role="listbox"${open ? '' : ' hidden'}>${cells}</span>
      </span>
    </div>`;
}

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>文本框 picker preview</title>
<style>${css}
  body { padding: 24px; background: var(--bg); }
  .stage { width: 560px; }
  .shell { border: 1px solid var(--border); border-radius: 12px; padding: 18px; background: #fff; }
  .shell h3 { margin: 0 0 14px; font-size: 13px; color: var(--muted); font-weight: 600; }
  /* Two picker rows with room between them, so an open panel overlapping the
     row below is visible rather than implied. */
  .rowline { display: flex; align-items: center; gap: 10px; margin: 26px 0; }
  .lab { font-size: 13px; color: var(--text); width: 118px; flex: none; }
  /* --zoom: blow the grid up so a couple of pixels of text offset is actually
     judgeable by eye. Off by default; the caller opts in. */
  ${process.env.ZOOM ? `
  .action-texts-panel { transform: scale(1.9); transform-origin: top left; }
  .stage { width: 1100px; }` : ''}
</style></head>
<body><div class="stage"><div class="shell">
  <h3>只有一个下拉框展开，其余收起</h3>
  ${picker('提醒气泡', '5', false)}
  ${picker('动作 default', '3', true)}
  ${picker('动作 dancing', '', false)}
</div></div></body></html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(OUT);