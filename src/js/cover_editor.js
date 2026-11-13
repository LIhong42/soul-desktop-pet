// src/js/cover_editor.js — 共用的封面编辑器。
//
// 记忆编辑页和照片墙都要让用户「挑一个位置」：拖动取景框、滚轮缩放、
// 换画幅。这一段 UI 两边共用，所以放在这里 —— 页面只管把图片和封面递
// 进来，把用户存好的封面接走。
//
// 元素只有一份：同一个页面里再开一张照片，就是把图片和取景框的数值
// 换掉。

'use strict';

import {
  COVER_RATIOS,
  DEFAULT_COVER_RATIO,
  coverRect,
  defaultCover,
  normalizeCover,
} from './diary_cover.js';
import { escapeHtml } from './api.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

let coverEl = null;
let coverState = null;

// 打开封面编辑器。
//
//   url       —— 图片的地址（data URL 或 file: URL）
//   name      —— 标题上显示的名字
//   cover     —— 现在的封面；没有就给默认的
//   picW/H    —— 图片自己的尺寸（知道就不用等解码）
//   lockRatio —— 锁死画幅：照片墙的格子形状是定好的，取景框只能跟着它
//   onSave    —— 用户存好封面时的回调
export function openCoverEditor(opts) {
  const o = opts || {};
  const el = ensureCoverEl();
  const start = normalizeCover(o.cover) || defaultCoverFor(o.picW, o.picH, o.lockRatio);
  const state = {
    url: o.url,
    name: o.name || '',
    cover: { ratio: start.ratio, x: start.x, y: start.y, zoom: start.zoom },
    picW: o.picW || 0,
    picH: o.picH || 0,
    lockRatio: o.lockRatio || null,
    onSave: typeof o.onSave === 'function' ? o.onSave : null,
  };

  const img = el.querySelector('.cover-editor-img');
  el.querySelector('.cover-editor-title').textContent = state.name;
  img.alt = state.name;
  img.src = o.url || '';
  el.classList.add('open');

  // 画幅按钮：锁死的时候只留一个。
  renderRatioButtons(el, state);

  const onLoad = () => {
    state.picW = img.naturalWidth || state.picW;
    state.picH = img.naturalHeight || state.picH;
    // 图片是后来才解出来的：尺寸知道了，默认的取景框才算得出来。
    if (!normalizeCover(o.cover) && state.picW && state.picH) {
      state.cover = defaultCoverFor(state.picW, state.picH, state.lockRatio);
    }
    renderCoverEditor(el, state);
  };
  if (img.complete && img.naturalWidth) onLoad();
  else {
    img.addEventListener('load', onLoad, { once: true });
    // 字节可能已经在缓存里，图片也可能早就在了，不会再有 load 事件。
    setTimeout(onLoad, 0);
  }

  // 拖动和滚轮只绑一次 —— 元素只建一次，它们动的是当前打开的这张图。
  if (!coverEl.dataset.dragBound) {
    coverEl.dataset.dragBound = '1';
    bindCoverDrag(coverEl);
  }
  renderCoverEditor(el, state);
}

export function closeCoverEditor() {
  if (!coverEl) return;
  coverEl.classList.remove('open');
  coverState = null;
}

// 一张照片在没有自己封面时的默认取景框。
function defaultCoverFor(picW, picH, lockRatio) {
  if (lockRatio) return { ratio: lockRatio, x: 0.5, y: 0.5, zoom: 1 };
  if (picW > 0 && picH > 0) return defaultCover(picW, picH);
  return { ratio: DEFAULT_COVER_RATIO, x: 0.5, y: 0.5, zoom: 1 };
}

// 画一遍编辑器的 DOM。
function ensureCoverEl() {
  if (coverEl) return coverEl;
  coverEl = document.createElement('div');
  coverEl.id = 'cover-editor';
  coverEl.className = 'cover-editor';
  coverEl.innerHTML = `
    <div class="cover-editor-card">
      <div class="cover-editor-head">
        <span class="cover-editor-title"></span>
        <button type="button" class="cover-editor-x" title="关闭">✕</button>
      </div>
      <div class="cover-editor-stage">
        <img class="cover-editor-img" alt=""/>
        <div class="cover-editor-frame"></div>
      </div>
      <div class="cover-editor-foot">
        <div class="cover-editor-ratios"></div>
        <div class="cover-editor-actions">
          <button type="button" class="btn cover-editor-reset">重置</button>
          <button type="button" class="btn cover-editor-cancel">取消</button>
          <button type="button" class="btn primary cover-editor-save">保存封面</button>
        </div>
      </div>
      <div class="cover-editor-hint">拖动取景框移动画面 · 滚轮缩放 · 取景框只在原图有富余的方向上移动</div>
    </div>
  `;
  document.body.appendChild(coverEl);

  coverEl.addEventListener('click', (e) => {
    if (e.target === coverEl) closeCoverEditor();
  });
  coverEl.querySelector('.cover-editor-x').onclick = () => closeCoverEditor();
  coverEl.querySelector('.cover-editor-cancel').onclick = () => closeCoverEditor();
  coverEl.querySelector('.cover-editor-save').onclick = () => saveCoverEditor();
  coverEl.querySelector('.cover-editor-reset').onclick = () => resetCoverEditor();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && coverEl.classList.contains('open')) closeCoverEditor();
  });
  return coverEl;
}

// 画幅按钮 —— 一个比例一个按钮，按钮上写比例本身，名字只是悬停提示。
function renderRatioButtons(el, state) {
  const ratios = el.querySelector('.cover-editor-ratios');
  const list = state.lockRatio
    ? COVER_RATIOS.filter((r) => r.id === state.lockRatio)
    : COVER_RATIOS;
  ratios.innerHTML = list.map((r) => `
    <button type="button" class="cover-editor-ratio" data-ratio="${escapeHtml(r.id)}"
            title="${escapeHtml(r.name)}">${escapeHtml(r.id)}</button>
  `).join('');
}

// 画编辑器：取景框落在图片上，画幅按钮标出当前用的那一个。
function renderCoverEditor(el, state) {
  coverState = state;
  const img = el.querySelector('.cover-editor-img');
  const frame = el.querySelector('.cover-editor-frame');
  const stage = el.querySelector('.cover-editor-stage');
  // 图片自己的尺寸。还没解出来的图片没有尺寸 —— 先摆一个占位的形状，
  // 让取景框有东西可落。
  const picW = state.picW || img.naturalWidth || 800;
  const picH = state.picH || img.naturalHeight || 600;

  // 图片在台子里按比例缩放，画得越大越好挑 —— 用户是在挑照片的一部分。
  const stageRect = stage.getBoundingClientRect();
  const scale = Math.min(stageRect.width / picW, stageRect.height / picH) || 1;
  const dispW = picW * scale;
  const dispH = picH * scale;
  img.style.width = dispW + 'px';
  img.style.height = dispH + 'px';

  // 台子是定位的上下文；图片在台子里居中。
  const rect = coverRect(picW, picH, state.cover);
  frame.style.width = rect.width * scale + 'px';
  frame.style.height = rect.height * scale + 'px';
  frame.style.left = (stage.clientWidth - dispW) / 2 + rect.left * scale + 'px';
  frame.style.top = (stage.clientHeight - dispH) / 2 + rect.top * scale + 'px';

  for (const btn of el.querySelectorAll('.cover-editor-ratio')) {
    btn.classList.toggle('selected', btn.dataset.ratio === state.cover.ratio);
  }
}

// 拖动取景框。图片不动，动的是框。
//
// 跟着指针走的是框的左上角 —— 用户推的是框本身，不是框的中心。存下来的
// 封面记的是框的中心，所以每次移动之后要把角换算回中心。
function bindCoverDrag(el) {
  const frame = el.querySelector('.cover-editor-frame');
  const stage = el.querySelector('.cover-editor-stage');
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onDown = (e) => {
    const state = coverState;
    if (!state) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = coverRect(state.picW || 800, state.picH || 600, state.cover);
    startLeft = rect.left;
    startTop = rect.top;
    frame.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onMove = (e) => {
    const state = coverState;
    if (!dragging || !state) return;
    const img = el.querySelector('.cover-editor-img');
    const dispW = img.offsetWidth || 1;
    const dispH = img.offsetHeight || 1;
    const picW = state.picW || 800;
    const picH = state.picH || 600;
    const rect = coverRect(picW, picH, state.cover);
    const left = startLeft + (e.clientX - startX) / dispW * picW;
    const top = startTop + (e.clientY - startY) / dispH * picH;
    state.cover.x = (left + rect.width / 2) / picW;
    state.cover.y = (top + rect.height / 2) / picH;
    renderCoverEditor(el, state);
  };

  const onUp = () => {
    dragging = false;
    frame.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  frame.addEventListener('pointerdown', onDown);

  // 滚轮围着框的中心缩放。
  const onWheel = (e) => {
    const state = coverState;
    if (!state) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    state.cover.zoom = clampNum(state.cover.zoom * (dir > 0 ? 1.1 : 1 / 1.1),
      state.cover.zoom, MIN_ZOOM, MAX_ZOOM);
    renderCoverEditor(el, state);
  };
  stage.addEventListener('wheel', onWheel, { passive: false });

  // 画幅按钮：换形状时框的中心不动 —— 图片停在用户放的地方。
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.cover-editor-ratio');
    if (!btn) return;
    const state = coverState;
    if (!state) return;
    state.cover.ratio = btn.dataset.ratio;
    renderCoverEditor(el, state);
  });
}

// 取景框回到默认的样子。
function resetCoverEditor() {
  const el = coverEl;
  const state = coverState;
  if (!el || !state) return;
  state.cover = defaultCoverFor(state.picW, state.picH, state.lockRatio);
  renderCoverEditor(el, state);
}

// 把取景框交还给调用的人。
function saveCoverEditor() {
  const el = coverEl;
  const state = coverState;
  if (!el || !state) return;
  const cover = normalizeCover(state.cover);
  if (state.onSave) state.onSave(cover);
  closeCoverEditor();
}

function clampNum(v, fallback, min, max) {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
