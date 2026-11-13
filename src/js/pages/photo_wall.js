// src/js/pages/photo_wall.js — /photo-wall page
//
// 照片墙：把选中的几篇回忆里的照片拼成一块形状（心形）。
//
// 进来的路：导出页选好回忆 → 「导出照片墙 (PNG)」→ 这一页。
//
// 自动的部分：按照片张数和用户给照片设的封面画幅，挑一个最合适的形状模
// 板（形状 × 5 个尺寸 × 5 种画幅 = 25 种预制的填充方式），照片按顺序填
// 进格子里。
//
// 手动的部分：换照片、删照片、给某个格子改封面、把照片拖到别的位置。
//
// 墙上摆的不是原图，是照片的等比封面 —— 默认用回忆笔记里给这张照片设的
// 封面；封面画幅和格子不一样时按笔记的默认裁法重裁一遍（从照片中心往
// 外长，长到有一条边碰到照片的边为止）。

import { api, escapeHtml, toast } from '../api.js';
import { register } from '../router.js';
import { parseDiaryContent } from '../diary_layout.js';
import { coverRect } from '../diary_cover.js';
import { openCoverEditor } from '../cover_editor.js';
import {
  SHAPES, WALL_SIZES, WALL_RATIOS,
  buildTemplate, pickTemplate, dominantRatio, resolveCellCover, photoDefaultRatio,
  wallGeometry, exportCellWidth,
} from '../photo_wall_layout.js';

const state = {
  eventIds: [],
  events: [],
  photos: [],        // { photoId, name, eventId, eventTitle, cover, w, h, url, img }
  photoById: new Map(),
  template: null,
  cells: [],         // { index, col, row, photoId, cover }
  selected: -1,
  loading: false,
  exporting: false,
  status: '',
};

async function mount(_args, params) {
  const raw = (params && params.ids) || '';
  state.eventIds = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  state.events = [];
  state.photos = [];
  state.photoById = new Map();
  state.cells = [];
  state.template = null;
  state.selected = -1;
  state.exporting = false;
  state.status = '';
  if (state.eventIds.length === 0) {
    render();
    return;
  }
  state.loading = true;
  render();
  await loadPhotos();
  state.loading = false;
  autoPick();
  render();
}

// ---- 照片 ------------------------------------------------------------------

// 把选中的几篇回忆里的照片收齐。
//
// 笔记里排好的照片先来（笔记的顺序和封面都在笔记里），照片表里有、笔记
// 里没排的也收进来 —— 用户可能上传了照片还没插进笔记。
async function loadPhotos() {
  const photos = [];
  for (const id of state.eventIds) {
    let ev = null;
    try {
      ev = await api.memorialEvents.get(id);
    } catch (e) {
      console.error('load event failed', id, e);
    }
    if (!ev) continue;
    state.events.push({ id: ev.id, title: ev.title || '(无标题)' });
    const seen = new Set();
    for (const block of parseDiaryContent(ev.content)) {
      if (block.type !== 'gallery') continue;
      for (const p of block.photos || []) {
        if (!p.photo_id || seen.has(p.photo_id)) continue;
        seen.add(p.photo_id);
        photos.push({
          photoId: p.photo_id, name: '', eventId: ev.id, eventTitle: ev.title || '',
          cover: p.cover || null,
        });
      }
    }
    for (const row of ev.photos || []) {
      if (!row || seen.has(row.id)) continue;
      if (!isImage(row)) continue;
      seen.add(row.id);
      photos.push({
        photoId: row.id, name: row.original_name || '', eventId: ev.id,
        eventTitle: ev.title || '', cover: null,
      });
    }
  }

  // 缩略图：墙上一次摆上百张，原图会把页面拖垮。
  //
  // 一张读不出来（文件没了、格式 ffmpeg 处理不了）不该把整面墙拖垮 ——
  // 这一张跳过就好。
  for (const p of photos) {
    try {
      const thumb = await api.memorialEvents.photos.thumb(p.photoId);
      if (thumb) {
        p.url = thumb.data_url;
        p.w = thumb.width;
        p.h = thumb.height;
      } else {
        const rawImg = await api.memorialEvents.photos.read(p.photoId);
        if (rawImg) p.url = rawImg.data_url;
      }
    } catch (e) {
      console.error('photo thumb failed', p.photoId, e);
    }
  }
  // 图片解码完，格子才知道怎么裁。
  await Promise.all(photos.map(async (p) => {
    if (!p.url) return;
    const img = await loadImage(p.url);
    if (!img) return;
    p.img = img;
    if (!p.w || !p.h) { p.w = img.naturalWidth; p.h = img.naturalHeight; }
  }));

  state.photos = photos;
  for (const p of photos) state.photoById.set(p.photoId, p);
}

function isImage(row) {
  return String(row.mime || '').startsWith('image/');
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---- 模板 ------------------------------------------------------------------

// 自动挑一个形状模板：按照片张数和用户给照片设的封面画幅。
function autoPick() {
  const ratios = state.photos.map((p) => (
    p.cover && p.cover.ratio ? p.cover.ratio : photoDefaultRatio(p.w, p.h)
  ));
  const want = dominantRatio(ratios);
  const shapeId = state.template ? state.template.shapeId : SHAPES[0].id;
  state.template = pickTemplate(shapeId, state.photos.length, want);
  buildCells();
}

// 换模板（形状 / 尺寸 / 画幅）之后重排格子。
//
// 照片按顺序重新填进去；用户改过的封面跟着照片走 —— 换了尺寸照片还是那
// 张，封面也还是那张照片的封面。
function buildCells() {
  const t = state.template;
  if (!t) { state.cells = []; return; }
  const oldCover = new Map();
  for (const c of state.cells) {
    if (c.photoId && c.cover) oldCover.set(c.photoId, c.cover);
  }
  const cells = t.cells.map((c) => ({
    index: c.index, col: c.col, row: c.row,
    photoId: null, cover: null,
  }));
  let n = 0;
  for (const p of state.photos) {
    if (n >= cells.length) break;
    cells[n].photoId = p.photoId;
    n++;
  }
  for (const c of cells) {
    if (!c.photoId) continue;
    const old = oldCover.get(c.photoId);
    if (old) c.cover = { ratio: t.ratioId, x: old.x, y: old.y, zoom: old.zoom };
  }
  state.cells = cells;
  state.selected = -1;
}

// 一个格子上摆的照片的封面。
//
// 用户在墙上改过的封面优先；否则用笔记里的封面 —— 画幅和格子一样就用，
// 不一样就按笔记的默认裁法重裁。
function cellCover(cell) {
  const p = state.photoById.get(cell.photoId);
  if (cell.cover) return cell.cover;
  return resolveCellCover(p ? p.cover : null, state.template.ratioId, p ? p.w : 0, p ? p.h : 0);
}

// ---- 渲染 ------------------------------------------------------------------

function render() {
  const app = document.getElementById('app');
  const t = state.template;
  const used = state.cells.filter((c) => c.photoId).length;

  app.innerHTML = `
    <div class="page-column">
      <div class="wall-head">
        <a class="wall-back" href="#/export">← 返回导出页</a>
        <h1>照片墙</h1>
        <p class="meta">把回忆里的照片拼成一块形状。墙上摆的是照片的等比封面 —— 默认用笔记里设的封面，画幅不一样时按笔记的默认裁法重裁。</p>
      </div>

      <div class="card">
        <h2>形状模板</h2>
        <div class="form-row">
          <div class="field">
            <label>形状</label>
            <select id="wall-shape">
              ${SHAPES.map((s) => `<option value="${escapeHtml(s.id)}"${t && t.shapeId === s.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>尺寸</label>
            <select id="wall-size">
              ${WALL_SIZES.map((s) => `<option value="${escapeHtml(s.id)}"${t && t.sizeId === s.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>格子画幅</label>
            <select id="wall-ratio">
              ${WALL_RATIOS.map((r) => `<option value="${escapeHtml(r.id)}"${t && t.ratioId === r.id ? ' selected' : ''}>${escapeHtml(r.id)} ${escapeHtml(r.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>&nbsp;</label>
            <button type="button" class="btn" id="wall-auto-btn">重新自动匹配</button>
          </div>
        </div>
        <p class="meta" id="wall-template-note">${templateNote()}</p>
      </div>

      <div class="wall-layout">
        <div class="card wall-stage-card">
          <div class="wall-scroll">
            <div class="wall-grid" id="wall-grid"></div>
          </div>
          <p class="meta" id="wall-status">${escapeHtml(state.status)}</p>
        </div>

        <div class="card wall-side">
          <h2>选中的格子</h2>
          <div id="wall-selected"></div>
          <h3>还没上墙的照片</h3>
          <div class="wall-tray" id="wall-tray"></div>
        </div>
      </div>

      <div class="card">
        <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center;">
          <button type="button" class="btn primary" id="wall-export-btn"${state.exporting || !t || used === 0 ? ' disabled' : ''}>导出照片墙 (PNG)</button>
          <span class="meta">${used} 张已上墙 · 共 ${state.photos.length} 张</span>
        </div>
        <p class="meta" style="margin-top:8px;">导出的是一块完整的 PNG：白色底，格子之间留一条缝。照片按原始分辨率裁切，和编辑器里看到的一致。</p>
      </div>
    </div>
  `;

  wire();
  drawWall();
  renderSide();
  renderTray();
}

function templateNote() {
  const t = state.template;
  if (!t) return state.loading ? '正在读取照片…' : '还没有可用的照片。';
  const shape = SHAPES.find((s) => s.id === t.shapeId);
  const ratio = WALL_RATIOS.find((r) => r.id === t.ratioId);
  const size = WALL_SIZES.find((s) => s.id === t.sizeId);
  return `当前：${shape ? shape.name : t.shapeId} · ${size ? size.name : t.sizeId} · ${ratio ? ratio.id : t.ratioId}（${ratio ? ratio.name : ''}） · `
    + `${t.cols} 列 ${t.rows} 行 · 共 ${t.capacity} 个格子，照片 ${state.photos.length} 张。`;
}

// 把格子摆出来。
function drawWall() {
  const grid = document.getElementById('wall-grid');
  const t = state.template;
  if (!grid || !t) return;
  const avail = Math.max(240, (grid.parentElement ? grid.parentElement.clientWidth : 720) - 24);
  // 格子之间的缝是格子的 1.5%，所以能摆下的格子比宽度除以列数略少。
  const cellW = Math.max(24, Math.floor(avail / (t.cols + 0.015 * (t.cols - 1))));
  const geo = wallGeometry(t, cellW);
  grid.style.width = geo.width + 'px';
  grid.style.height = geo.height + 'px';
  grid.innerHTML = '';
  for (const cell of state.cells) {
    const el = document.createElement('div');
    el.className = 'wall-cell';
    if (state.selected === cell.index) el.classList.add('selected');
    el.dataset.cell = String(cell.index);
    el.style.left = geo.x(cell.col) + 'px';
    el.style.top = geo.y(cell.row) + 'px';
    el.style.width = geo.cellW + 'px';
    el.style.height = geo.cellH + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = geo.cellW;
    canvas.height = geo.cellH;
    el.appendChild(canvas);
    const photo = cell.photoId ? state.photoById.get(cell.photoId) : null;
    if (photo) {
      el.classList.add('filled');
      el.draggable = true;
    }
    grid.appendChild(el);
    drawCell(canvas, photo, cellCover(cell));
  }
}

// 画一个格子：把照片的封面那一块画进格子里。
function drawCell(canvas, photo, cover) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!photo || !photo.img || !photo.img.naturalWidth) return;
  const picW = photo.w || photo.img.naturalWidth;
  const picH = photo.h || photo.img.naturalHeight;
  const rect = coverRect(picW, picH, cover);
  ctx.drawImage(photo.img, rect.left, rect.top, rect.width, rect.height,
    0, 0, canvas.width, canvas.height);
}

// 侧栏：选中的格子。
function renderSide() {
  const box = document.getElementById('wall-selected');
  if (!box) return;
  const cell = state.selected >= 0 ? state.cells[state.selected] : null;
  if (!cell || !cell.photoId) {
    box.innerHTML = '<p class="meta">点一个格子，就能换照片、删照片、改封面。</p>';
    return;
  }
  const p = state.photoById.get(cell.photoId);
  const cover = cellCover(cell);
  box.innerHTML = `
    <div class="wall-side-photo">
      <img src="${escapeHtml(p.url || '')}" alt=""/>
      <div class="wall-side-meta">
        <div class="wall-side-name">${escapeHtml(p.name || p.eventTitle || '照片')}</div>
        <div class="meta">${escapeHtml(p.eventTitle || '')} · 画幅 ${escapeHtml(cover.ratio)}</div>
      </div>
    </div>
    <div class="row" style="gap:6px; flex-wrap:wrap; margin-top:8px;">
      <button type="button" class="btn" id="wall-cover-btn">设置封面</button>
      <button type="button" class="btn" id="wall-replace-btn">替换照片</button>
      <button type="button" class="btn" id="wall-remove-btn">删除照片</button>
    </div>
  `;
  const coverBtn = document.getElementById('wall-cover-btn');
  if (coverBtn) coverBtn.onclick = openCoverForCell;
  const replaceBtn = document.getElementById('wall-replace-btn');
  if (replaceBtn) replaceBtn.onclick = openPhotoPicker;
  const removeBtn = document.getElementById('wall-remove-btn');
  if (removeBtn) removeBtn.onclick = () => {
    cell.photoId = null;
    cell.cover = null;
    render();
  };
}

// 侧栏：还没上墙的照片。
function renderTray() {
  const tray = document.getElementById('wall-tray');
  if (!tray) return;
  const used = new Set(state.cells.filter((c) => c.photoId).map((c) => c.photoId));
  const unused = state.photos.filter((p) => !used.has(p.photoId));
  if (unused.length === 0) {
    tray.innerHTML = '<p class="meta">照片都摆上墙了。</p>';
    return;
  }
  tray.innerHTML = unused.map((p) => `
    <div class="wall-tray-item" draggable="true" data-photo-id="${escapeHtml(p.photoId)}">
      <img src="${escapeHtml(p.url || '')}" alt=""/>
      <span>${escapeHtml(p.name || p.eventTitle || '照片')}</span>
    </div>
  `).join('');
  tray.querySelectorAll('.wall-tray-item').forEach((el) => {
    el.onclick = () => {
      // 点一下就上墙：先补空格；墙上满了就换掉选中的那个。
      const free = state.cells.find((c) => !c.photoId);
      const target = state.selected >= 0 ? state.cells[state.selected] : null;
      const cell = free || target;
      if (!cell) return;
      assignPhoto(cell.index, el.dataset.photoId);
      render();
    };
  });
}

// ---- 交互 ------------------------------------------------------------------

function wire() {
  const shapeSel = document.getElementById('wall-shape');
  if (shapeSel) {
    shapeSel.onchange = () => {
      // 换形状：按同样的照片数和画幅重新挑一个尺寸。
      const ratio = state.template ? state.template.ratioId : '1:1';
      state.template = pickTemplate(shapeSel.value, state.photos.length, ratio);
      buildCells();
      render();
    };
  }
  const sizeSel = document.getElementById('wall-size');
  if (sizeSel) {
    sizeSel.onchange = () => {
      state.template = buildTemplate(state.template.shapeId, sizeSel.value, state.template.ratioId);
      buildCells();
      render();
    };
  }
  const ratioSel = document.getElementById('wall-ratio');
  if (ratioSel) {
    ratioSel.onchange = () => {
      state.template = buildTemplate(state.template.shapeId, state.template.sizeId, ratioSel.value);
      buildCells();
      render();
    };
  }
  const autoBtn = document.getElementById('wall-auto-btn');
  if (autoBtn) autoBtn.onclick = () => { autoPick(); render(); };

  const grid = document.getElementById('wall-grid');
  if (grid) wireGrid(grid);

  const tray = document.getElementById('wall-tray');
  if (tray) wireTray(tray);

  const exportBtn = document.getElementById('wall-export-btn');
  if (exportBtn) exportBtn.onclick = doExport;
}

// 标出选中的格子（不用重画整面墙）。
function markSelection() {
  const grid = document.getElementById('wall-grid');
  if (!grid) return;
  grid.querySelectorAll('.wall-cell').forEach((el) => {
    el.classList.toggle('selected', Number(el.dataset.cell) === state.selected);
  });
}

function wireGrid(grid) {
  grid.addEventListener('click', (e) => {
    const el = e.target.closest('.wall-cell');
    if (!el) return;
    state.selected = Number(el.dataset.cell);
    markSelection();
    renderSide();
  });

  grid.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.wall-cell');
    if (!el) return;
    const cell = state.cells[Number(el.dataset.cell)];
    if (!cell || !cell.photoId) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', JSON.stringify({
      kind: 'cell', index: cell.index, photoId: cell.photoId,
    }));
    e.dataTransfer.effectAllowed = 'move';
  });

  grid.addEventListener('dragover', (e) => {
    const el = e.target.closest('.wall-cell');
    if (!el) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });

  grid.addEventListener('dragleave', (e) => {
    const el = e.target.closest('.wall-cell');
    if (el) el.classList.remove('drop-target');
  });

  grid.addEventListener('drop', (e) => {
    const el = e.target.closest('.wall-cell');
    if (!el) return;
    e.preventDefault();
    el.classList.remove('drop-target');
    const payload = readDrag(e);
    if (!payload) return;
    const index = Number(el.dataset.cell);
    if (payload.kind === 'cell') {
      if (payload.index === index) return;
      swapCells(payload.index, index);
    } else if (payload.kind === 'tray') {
      assignPhoto(index, payload.photoId);
    }
    render();
  });
}

function wireTray(tray) {
  tray.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.wall-tray-item');
    if (!el) return;
    e.dataTransfer.setData('text/plain', JSON.stringify({
      kind: 'tray', photoId: el.dataset.photoId,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  });

  // 把墙上的照片拖回这一栏 = 从墙上拿下来。
  tray.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tray.classList.add('drop-target');
  });

  tray.addEventListener('dragleave', () => tray.classList.remove('drop-target'));

  tray.addEventListener('drop', (e) => {
    e.preventDefault();
    tray.classList.remove('drop-target');
    const payload = readDrag(e);
    if (!payload || payload.kind !== 'cell') return;
    const cell = state.cells[payload.index];
    if (!cell) return;
    cell.photoId = null;
    cell.cover = null;
    render();
  });
}

function readDrag(e) {
  try {
    const raw = e.dataTransfer.getData('text/plain');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// 两张照片换位置。
function swapCells(a, b) {
  const ca = state.cells[a];
  const cb = state.cells[b];
  if (!ca || !cb) return;
  const pid = ca.photoId; ca.photoId = cb.photoId; cb.photoId = pid;
  const cov = ca.cover; ca.cover = cb.cover; cb.cover = cov;
}

// 一张照片只能占一个格子。
function assignPhoto(index, photoId) {
  const cell = state.cells[index];
  if (!cell) return;
  for (const c of state.cells) {
    if (c !== cell && c.photoId === photoId) { c.photoId = null; c.cover = null; }
  }
  cell.photoId = photoId;
  cell.cover = null;
}

// 给某个格子改封面 —— 和笔记里那套编辑器是同一个（src/js/cover_editor.js）。
// 格子的画幅是模板定的，所以取景框锁在这个画幅上。
function openCoverForCell() {
  const cell = state.selected >= 0 ? state.cells[state.selected] : null;
  if (!cell || !cell.photoId) return;
  const p = state.photoById.get(cell.photoId);
  if (!p) return;
  openCoverEditor({
    url: p.url,
    name: p.name || p.eventTitle || '照片',
    cover: cellCover(cell),
    picW: p.w,
    picH: p.h,
    lockRatio: state.template.ratioId,
    onSave: (cover) => {
      cell.cover = cover;
      render();
    },
  });
}

// 换照片：列出所有照片挑一张。
function openPhotoPicker() {
  const cell = state.selected >= 0 ? state.cells[state.selected] : null;
  if (!cell) return;
  const overlay = document.createElement('div');
  overlay.className = 'wall-picker';
  overlay.innerHTML = `
    <div class="wall-picker-card">
      <div class="wall-picker-head">
        <span>换一张照片</span>
        <button type="button" class="wall-picker-x">✕</button>
      </div>
      <div class="wall-picker-grid"></div>
    </div>
  `;
  const grid = overlay.querySelector('.wall-picker-grid');
  grid.innerHTML = state.photos.map((p) => `
    <div class="wall-picker-item" data-photo-id="${escapeHtml(p.photoId)}">
      <img src="${escapeHtml(p.url || '')}" alt=""/>
      <span>${escapeHtml(p.name || p.eventTitle || '照片')}</span>
    </div>
  `).join('');
  const close = () => overlay.remove();
  grid.querySelectorAll('.wall-picker-item').forEach((el) => {
    el.onclick = () => {
      assignPhoto(cell.index, el.dataset.photoId);
      close();
      render();
    };
  });
  overlay.querySelector('.wall-picker-x').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.body.appendChild(overlay);
}

// ---- 导出 ------------------------------------------------------------------

async function doExport() {
  if (state.exporting || !state.template) return;
  const t = state.template;
  const geo = wallGeometry(t, exportCellWidth(t.cols));
  const canvas = document.createElement('canvas');
  canvas.width = geo.width;
  canvas.height = geo.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const filled = state.cells.filter((c) => c.photoId);
  state.exporting = true;
  const btn = document.getElementById('wall-export-btn');
  if (btn) btn.disabled = true;
  let done = 0;
  let failed = 0;
  try {
    for (const cell of filled) {
      setStatus(`正在绘制 ${++done} / ${filled.length}…`);
      const ok = await drawExportCell(ctx, geo, cell, cellCover(cell));
      if (!ok) failed++;
    }
    setStatus('正在生成 PNG…');
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('生成 PNG 失败');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const r = await api.export_.photoWall({ bytes });
    if (r && r.canceled) {
      setStatus('');
      return;
    }
    const mb = (r && r.bytes ? (r.bytes / 1024 / 1024).toFixed(1) : '?');
    const failedTxt = failed ? ` · ${failed} 张没画上` : '';
    toast(`照片墙已导出：${canvas.width}×${canvas.height} · ${filled.length} 张照片${failedTxt} · ${mb} MB`);
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e));
  }
  state.exporting = false;
  setStatus('');
  render();
}

// 把一张照片画进导出用的画布。
async function drawExportCell(ctx, geo, cell, cover) {
  let bytes = null;
  try {
    bytes = await api.memorialEvents.photos.bytes(cell.photoId);
  } catch (e) {
    console.error('read export bytes failed', cell.photoId, e);
    return false;
  }
  if (!bytes || !bytes.byteLength) return false;
  const url = URL.createObjectURL(new Blob([bytes]));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const rect = coverRect(img.naturalWidth, img.naturalHeight, cover);
    ctx.drawImage(img, rect.left, rect.top, rect.width, rect.height,
      geo.x(cell.col), geo.y(cell.row), geo.cellW, geo.cellH);
    return true;
  } catch (e) {
    console.error('draw export cell failed', cell.photoId, e);
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function setStatus(text) {
  state.status = text || '';
  const el = document.getElementById('wall-status');
  if (el) el.textContent = state.status;
}

register('/photo-wall', mount);
