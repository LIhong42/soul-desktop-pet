// src/js/pages/photo_wall.js — /photo-wall page
//
// 照片墙：把选中的几篇回忆里的照片拼成一块形状（心形）。
//
// 画法（规则在 src/js/photo_wall_layout.js，编辑器和导出共用一套）：
//
//   1. 画布的长宽比 = 照片的长宽比（格子画幅）；
//   2. 形状用函数画在画布正中，四周留出一圈白边（画布的 5%）；
//   3. 画布按 n×n 的网格线切开，只有「有一块落进形状里」的格子摆照片；
//   4. 照片再被形状裁一刀 —— 整面墙的轮廓就是形状本身。
//
// 照片数决定网格密度：照片少用稀网格（6×6），照片多用密网格。
//
// 自动的部分：按照片张数和照片的画幅挑网格密度。
//
// 手动的部分：换照片、删照片、给某个格子改封面、把照片拖到别的格子。
//
// 墙上摆的不是原图，是照片的等比封面 —— 默认用回忆笔记里给这张照片设的
// 封面；封面画幅和格子不一样时按笔记的默认裁法重裁一遍（从照片中心往
// 外长，长到有一条边碰到照片的边为止）。

import { api, escapeHtml, toast } from '../api.js';
import { isImageFile, imageMimeForFile } from '../file_image.js';
import { register } from '../router.js';
import { parseDiaryContent } from '../diary_layout.js';
import { coverRect } from '../diary_cover.js';
import { openCoverEditor } from '../cover_editor.js';
import {
  SHAPES, WALL_SIZES, WALL_RATIOS,
  buildTemplate, pickTemplate, dominantRatio, resolveCellCover, photoDefaultRatio,
  wallGeometry, cellRect, exportCanvasWidth,
} from '../photo_wall_layout.js';

const state = {
  eventIds: [],
  events: [],
  photos: [],        // { photoId, name, eventId, eventTitle, cover, w, h, url, img }
  photoById: new Map(),
  template: null,
  cells: [],         // { index, col, row, photoId, cover }
  selected: -1,
  hover: -1,
  loading: false,
  exporting: false,
  importing: false,
  status: '',
};

// 窗口大小变了，画布要跟着重新算宽度。监听器只留一个（换页时换掉）。
let resizeHandler = null;

// 离开这一页的监听器 —— 只留一个（换页时换掉）。
let leaveHandler = null;

async function mount(_args, params) {
  // 上一轮留下的临时照片（换了一组回忆又进来）—— 先清掉，它们是上一轮
  // 的素材，不该跟着这面墙走。
  await dropTmpPhotos();
  const raw = (params && params.ids) || '';
  state.eventIds = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  state.events = [];
  state.photos = [];
  state.photoById = new Map();
  state.cells = [];
  state.template = null;
  state.selected = -1;
  state.hover = -1;
  state.exporting = false;
  state.importing = false;
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
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  resizeHandler = () => {
    if (!document.getElementById('wall-canvas')) return;
    drawWall();
  };
  window.addEventListener('resize', resizeHandler);
  // 离开这一页：临时照片用完就删（导出了，或者干脆没导出）。
  if (leaveHandler) window.removeEventListener('hashchange', leaveHandler);
  leaveHandler = () => {
    if ((location.hash || '').startsWith('#/photo-wall')) return;
    window.removeEventListener('hashchange', leaveHandler);
    leaveHandler = null;
    dropTmpPhotos();
  };
  window.addEventListener('hashchange', leaveHandler);
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
    // 照片表里的 mime —— 笔记里排好的照片也要从这儿拿（导出时解码原图要
    // 知道它是什么格式）。
    const mimes = new Map();
    for (const row of ev.photos || []) {
      if (row && row.id && row.mime) mimes.set(row.id, row.mime);
    }
    for (const block of parseDiaryContent(ev.content)) {
      if (block.type !== 'gallery') continue;
      for (const p of block.photos || []) {
        if (!p.photo_id || seen.has(p.photo_id)) continue;
        seen.add(p.photo_id);
        photos.push({
          photoId: p.photo_id, name: '', eventId: ev.id, eventTitle: ev.title || '',
          cover: p.cover || null, mime: mimes.get(p.photo_id) || '',
        });
      }
    }
    for (const row of ev.photos || []) {
      if (!row || seen.has(row.id)) continue;
      if (!isImage(row)) continue;
      seen.add(row.id);
      photos.push({
        photoId: row.id, name: row.original_name || '', eventId: ev.id,
        eventTitle: ev.title || '', cover: null, mime: row.mime || '',
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

// 自动挑一套模板：按照片张数和用户给照片设的封面画幅。
function autoPick() {
  const ratios = state.photos.map((p) => (
    p.cover && p.cover.ratio ? p.cover.ratio : photoDefaultRatio(p.w, p.h)
  ));
  const want = dominantRatio(ratios);
  const shapeId = state.template ? state.template.shapeId : SHAPES[0].id;
  state.template = pickTemplate(shapeId, state.photos.length, want);
  buildCells();
}

// 换模板（形状 / 网格 / 画幅）之后重排格子。
//
// 照片按顺序重新填进去；用户改过的封面跟着照片走 —— 换了网格照片还是那
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
  state.hover = -1;
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
        <p class="meta">把回忆里的照片拼成一块形状。画布的长宽比跟照片一样，照片摆进格子不用裁；形状画在画布正中、四周留一圈白边，只有落进形状里的格子才摆照片，照片再被形状裁一刀 —— 整面墙的轮廓就是形状。</p>
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
            <label>网格</label>
            <select id="wall-size">${sizeOptions()}</select>
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
            <div class="wall-stage" id="wall-stage">
              <canvas id="wall-canvas" draggable="true"></canvas>
              <canvas id="wall-overlay"></canvas>
            </div>
          </div>
          <p class="meta" id="wall-status">${escapeHtml(state.status)}</p>
          <p class="meta">点一个格子就能换照片、删照片、改封面；把照片从侧栏拖到墙上可以换位置。</p>
        </div>

        <div class="card wall-side">
          <h2>选中的格子</h2>
          <div id="wall-selected"></div>
          <h3>还没上墙的照片</h3>
          <div class="wall-tray" id="wall-tray"></div>
          <h3>临时导入</h3>
          <div class="wall-import">
            <button type="button" class="btn" id="wall-import-btn"${state.importing ? ' disabled' : ''}>${state.importing ? '导入中…' : '导入照片'}</button>
            <input type="file" id="wall-import-input" accept="image/*" multiple hidden/>
          </div>
          <p class="meta">回忆里的照片不够摆满这面墙时，可以从系统里再导入几张。导入的照片<b>不属于任何一篇回忆</b>，只存在临时目录里 —— 导出完成后自动删除。</p>
        </div>
      </div>

      <div class="card">
        <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center;">
          <button type="button" class="btn primary" id="wall-export-btn"${state.exporting || !t || used === 0 ? ' disabled' : ''}>导出照片墙 (PNG)</button>
          <span class="meta">${used} 张已上墙 · 共 ${state.photos.length} 张</span>
        </div>
        <p class="meta" style="margin-top:8px;">导出的是一块完整的 PNG：白色底，照片按原始分辨率裁切，形状之外的地方留白。</p>
      </div>
    </div>
  `;

  wire();
  drawWall();
  renderSide();
  renderTray();
}

// 网格下拉：每一档都标上它能装多少格 —— 照片数决定选哪一档。
function sizeOptions() {
  const t = state.template;
  const shapeId = t ? t.shapeId : SHAPES[0].id;
  const ratioId = t ? t.ratioId : '1:1';
  return WALL_SIZES.map((s) => {
    const cap = buildTemplate(shapeId, s.id, ratioId).capacity;
    const on = t && t.sizeId === s.id ? ' selected' : '';
    return `<option value="${s.id}"${on}>${s.name}（${cap} 格）</option>`;
  }).join('');
}

function templateNote() {
  const t = state.template;
  if (!t) return state.loading ? '正在读取照片…' : '还没有可用的照片。';
  const shape = SHAPES.find((s) => s.id === t.shapeId);
  const ratio = WALL_RATIOS.find((r) => r.id === t.ratioId);
  return `当前：${shape ? shape.name : t.shapeId} · ${t.sizeName} 网格 · ${ratio ? ratio.id : t.ratioId}（${ratio ? ratio.name : ''}） · `
    + `画布 ${t.ratio.toFixed(2)}:1 · 共 ${t.capacity} 个格子，照片 ${state.photos.length} 张。`;
}

// ---- 画布 ------------------------------------------------------------------

// 形状的底色 —— 空着的格子是它，墙的轮廓因此看得见。
const SHAPE_FILL = '#efe9e0';

// 把墙画出来：白底 + 形状 + 照片 + 网格线。
//
// 形状是画布正中最大那一个（整圈轮廓按比例放进去，一点不裁掉）。照片
// 先铺进格子，再被形状裁一刀 —— 于是墙的轮廓就是形状。
function drawWall() {
  const canvas = document.getElementById('wall-canvas');
  const overlay = document.getElementById('wall-overlay');
  const t = state.template;
  if (!canvas || !overlay || !t) return;
  const stage = canvas.parentElement;
  const avail = Math.max(240, (stage ? stage.clientWidth : 720) - 4);
  let cssW = avail;
  let cssH = cssW / t.ratio;
  // 太高的墙会把页面撑得很长 —— 顶到窗口的六成就够了。
  const maxH = Math.max(240, Math.floor(window.innerHeight * 0.62));
  if (cssH > maxH) { cssH = maxH; cssW = cssH * t.ratio; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(cssW * dpr));
  const H = Math.max(1, Math.round(cssH * dpr));

  canvas.width = W;
  canvas.height = H;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  overlay.width = W;
  overlay.height = H;
  overlay.style.width = cssW + 'px';
  overlay.style.height = cssH + 'px';

  paintBase(canvas.getContext('2d'), W, H);
  paintOverlay();
}

function paintBase(ctx, W, H) {
  const t = state.template;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (!t) return;
  const geo = wallGeometry(t, H);
  const path = shapePath(geo.shape);

  // 形状的底：一层淡色，让人看得见形状（空着的格子就是它）。
  ctx.save();
  ctx.fillStyle = SHAPE_FILL;
  ctx.fill(path);
  ctx.restore();

  // 照片 + 网格线（都被形状裁住）。
  ctx.save();
  ctx.clip(path);
  for (const cell of state.cells) {
    const p = cell.photoId ? state.photoById.get(cell.photoId) : null;
    if (!p || !p.img || !p.img.naturalWidth) continue;
    const r = cellRect(geo, cell);
    const picW = p.w || p.img.naturalWidth;
    const picH = p.h || p.img.naturalHeight;
    const rect = coverRect(picW, picH, cellCover(cell));
    ctx.drawImage(p.img, rect.left, rect.top, rect.width, rect.height,
      r.x, r.y, r.w, r.h);
  }
  drawGridLines(ctx, geo, W, H);
  ctx.restore();
}

// 网格线：照片之间那条缝 —— 没有它，一整面墙看过去是一张大图。
function drawGridLines(ctx, geo, W, H) {
  const t = state.template;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = Math.max(1, H / 500);
  ctx.beginPath();
  for (let i = 1; i < t.n; i += 1) {
    const x = geo.x(i);
    const y = geo.y(i);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();
}

// 选中 / 悬停的格子画在另一层画布上 —— 换选中格子时不用重画整面墙。
function paintOverlay() {
  const overlay = document.getElementById('wall-overlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const t = state.template;
  if (!t) return;
  const geo = wallGeometry(t, overlay.height);
  const width = Math.max(2, overlay.height / 260);
  const mark = (index, color) => {
    const cell = state.cells[index];
    if (!cell) return;
    const r = cellRect(geo, cell);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(r.x + width / 2, r.y + width / 2, r.w - width, r.h - width);
  };
  if (state.hover >= 0 && state.hover !== state.selected) mark(state.hover, 'rgba(40, 35, 30, 0.45)');
  if (state.selected >= 0) mark(state.selected, '#d97757');
}

function shapePath(points) {
  const path = new Path2D();
  if (!points.length) return path;
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x, points[i].y);
  path.closePath();
  return path;
}

// 画布上的位置 → 格子（画布的坐标：宽 = 画幅，高 = 1）。
function cellAt(clientX, clientY) {
  const canvas = document.getElementById('wall-canvas');
  const t = state.template;
  if (!canvas || !t) return -1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.height) return -1;
  const x = (clientX - rect.left) / rect.height;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || y < 0 || x > t.ratio || y > 1) return -1;
  const col = Math.floor((x * t.n) / t.ratio);
  const row = Math.floor(y * t.n);
  for (const cell of t.cells) {
    if (cell.col === col && cell.row === row) return cell.index;
  }
  return -1;
}

// ---- 交互 ------------------------------------------------------------------

function wire() {
  const shapeSel = document.getElementById('wall-shape');
  if (shapeSel) {
    shapeSel.onchange = () => {
      // 换形状：按同样的照片数和画幅重新挑一个网格。
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
      // 换画幅：画布的长宽比变了，格子数也跟着变 —— 重新挑一档网格。
      state.template = pickTemplate(state.template.shapeId, state.photos.length, ratioSel.value);
      buildCells();
      render();
    };
  }
  const autoBtn = document.getElementById('wall-auto-btn');
  if (autoBtn) autoBtn.onclick = () => { autoPick(); render(); };

  const canvas = document.getElementById('wall-canvas');
  if (canvas) wireCanvas(canvas);

  const tray = document.getElementById('wall-tray');
  if (tray) wireTray(tray);

  const exportBtn = document.getElementById('wall-export-btn');
  if (exportBtn) exportBtn.onclick = doExport;

  wireImport();
}

// 导入用的控件：一个挑文件的按钮。
function wireImport() {
  const btn = document.getElementById('wall-import-btn');
  const input = document.getElementById('wall-import-input');
  if (btn && input) {
    btn.onclick = () => input.click();
    input.onchange = onImportFiles;
  }
}

function wireCanvas(canvas) {
  canvas.addEventListener('click', (e) => {
    state.selected = cellAt(e.clientX, e.clientY);
    renderSide();
    paintOverlay();
  });

  // 把墙上的照片拖到别的格子 —— 换位置。
  canvas.addEventListener('dragstart', (e) => {
    const index = cellAt(e.clientX, e.clientY);
    const cell = index >= 0 ? state.cells[index] : null;
    if (!cell || !cell.photoId) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', JSON.stringify({
      kind: 'cell', index: cell.index,
    }));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(dragGhost(state.photoById.get(cell.photoId)), 8, 8);
  });

  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const index = cellAt(e.clientX, e.clientY);
    if (index !== state.hover) {
      state.hover = index;
      paintOverlay();
    }
  });

  canvas.addEventListener('dragleave', () => {
    state.hover = -1;
    paintOverlay();
  });

  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const index = cellAt(e.clientX, e.clientY);
    state.hover = -1;
    const payload = readDrag(e);
    if (!payload || index < 0) { paintOverlay(); return; }
    if (payload.kind === 'cell') {
      if (payload.index !== index) swapCells(payload.index, index);
    } else if (payload.kind === 'tray') {
      assignPhoto(index, payload.photoId);
    }
    render();
  });
}

// 拖动时的影子：一张小小的照片 —— 别把整面墙拖在鼠标底下。
let ghostEl = null;

function dragGhost(photo) {
  if (!ghostEl) {
    ghostEl = document.createElement('canvas');
    ghostEl.width = 56;
    ghostEl.height = 56;
    ghostEl.style.position = 'fixed';
    ghostEl.style.left = '-9999px';
    ghostEl.style.top = '0';
    document.body.appendChild(ghostEl);
  }
  const ctx = ghostEl.getContext('2d');
  ctx.clearRect(0, 0, 56, 56);
  if (photo && photo.img && photo.img.naturalWidth) {
    const img = photo.img;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 56, 56);
  }
  return ghostEl;
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

// ---- 侧栏 ------------------------------------------------------------------

// 侧栏：选中的格子。
function renderSide() {
  const box = document.getElementById('wall-selected');
  if (!box) return;
  const cell = state.selected >= 0 ? state.cells[state.selected] : null;
  if (!cell || !cell.photoId) {
    box.innerHTML = '<p class="meta">点墙上的一个格子，就能换照片、删照片、改封面。</p>';
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

// ---- 导入照片 --------------------------------------------------------------

// 导入：把系统里的照片传进这面墙。
//
// 导入的照片**不属于任何一篇回忆** —— 它们只是这一面墙的素材。所以它们
// 不进数据库，也不进回忆的照片目录，而是写进临时目录（main/tmp_photos.js）：
// 导出时按原图分辨率画进格子，导出完成（或离开这一页）时删掉。
//
// 跟回忆编辑页的「插入图片」是同一套做法：挑文件 → 存进临时目录 → 照片进
// 列表；只是存的地方不一样 —— 这里不落到任何一篇回忆里。
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

async function onImportFiles(e) {
  const input = e.target;
  const files = Array.from(input.files || []);
  // 清掉选中的文件：连续挑同一张图两次也要能再挑一次。
  input.value = '';
  if (!files.length) return;

  const images = files.filter(isImageFile);
  if (!images.length) { toast('挑的文件里没有图片'); return; }

  state.importing = true;
  render();
  let ok = 0;
  let fail = 0;
  for (const file of images) {
    setStatus(`正在导入 ${ok + fail + 1} / ${images.length}…`);
    if (file.size > MAX_IMPORT_BYTES) {
      console.warn('import photo too large', file.name, file.size);
      fail += 1;
      continue;
    }
    try {
      const bytes = await file.arrayBuffer();
      const row = await api.tmpPhotos.save({
        filename: file.name,
        mime: imageMimeForFile(file),
        bytes,
      });
      const p = await adoptPhoto(row, file.name);
      if (!p) { fail += 1; continue; }
      state.photos.push(p);
      state.photoById.set(p.photoId, p);
      ok += 1;
    } catch (err) {
      console.error('import photo failed', err);
      fail += 1;
    }
  }
  state.importing = false;
  setStatus('');
  // 导入的照片先补进空着的格子；墙满了就留在下面的列表里，由用户摆。
  fillFreeCells();
  render();
  if (ok && fail) toast(`已导入 ${ok} 张，${fail} 张失败`);
  else if (ok) toast(`已导入 ${ok} 张临时照片`);
  else toast('导入失败');
  // 格子不够放的时候说一声 —— 换一档更密的网格才能全摆上去。
  if (ok && state.template && state.photos.length > state.template.capacity) {
    toast('照片比格子多 —— 在「网格」里换一档更密的就能全摆上');
  }
}

// 一张刚导入的照片 → 墙上的一张照片（跟读回来的照片一个样）。
async function adoptPhoto(row, name) {
  const p = {
    photoId: `tmp:${row.id}`,
    tmpId: row.id,
    name: name || '',
    eventId: '',
    eventTitle: '临时导入',
    cover: null,
    mime: row.mime || '',
  };
  try {
    const thumb = await api.tmpPhotos.thumb(row.id);
    if (thumb) {
      p.url = thumb.data_url;
      p.w = thumb.width;
      p.h = thumb.height;
    }
  } catch (e) {
    console.error('imported photo thumb failed', row.id, e);
  }
  // 读不出来（文件坏了、格式 ffmpeg 处理不了）就别上墙 —— 空格子更让人
  // 困惑，而且导出时它也画不上。
  if (!p.url) {
    api.tmpPhotos.remove(row.id).catch(() => {});
    return null;
  }
  const img = await loadImage(p.url);
  if (img) {
    p.img = img;
    if (!p.w || !p.h) { p.w = img.naturalWidth; p.h = img.naturalHeight; }
  }
  return p;
}

// 临时照片用完就删 —— 它们不属于任何一篇回忆，也不该留在磁盘上。
//
// 删掉之后它们也从墙上撤下来：墙上摆的每一张照片都还在（临时照片已经
// 不在了，留着就是空格子）。
async function dropTmpPhotos() {
  const tmp = state.photos.filter((p) => p.tmpId);
  if (!tmp.length) return;
  for (const p of tmp) {
    try { await api.tmpPhotos.remove(p.tmpId); } catch (e) { /* 删不掉就留着 */ }
    state.photoById.delete(p.photoId);
    for (const c of state.cells) {
      if (c.photoId === p.photoId) { c.photoId = null; c.cover = null; }
    }
  }
  state.photos = state.photos.filter((p) => !p.tmpId);
}

// 还没上墙的照片补进空格子 —— 墙上的摆法不动，只填空位。
function fillFreeCells() {
  const used = new Set(state.cells.filter((c) => c.photoId).map((c) => c.photoId));
  const free = state.cells.filter((c) => !c.photoId);
  if (!free.length) return;
  const waiting = state.photos.filter((p) => !used.has(p.photoId));
  for (let i = 0; i < free.length && i < waiting.length; i += 1) {
    free[i].photoId = waiting[i].photoId;
  }
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
  const W = exportCanvasWidth(t.n);
  const H = Math.round(W / t.ratio);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const geo = wallGeometry(t, H);
  const path = shapePath(geo.shape);
  // 形状的底 —— 空着的格子是它，墙的轮廓因此看得见。
  ctx.fillStyle = SHAPE_FILL;
  ctx.fill(path);
  const filled = state.cells.filter((c) => c.photoId);

  state.exporting = true;
  const btn = document.getElementById('wall-export-btn');
  if (btn) btn.disabled = true;
  let done = 0;
  let failed = 0;
  try {
    ctx.save();
    ctx.clip(path);
    for (const cell of filled) {
      setStatus(`正在绘制 ${++done} / ${filled.length}…`);
      const ok = await drawExportCell(ctx, geo, cell, cellCover(cell));
      if (!ok) failed++;
    }
    drawGridLines(ctx, geo, W, H);
    ctx.restore();

    setStatus('正在生成 PNG…');
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('生成 PNG 失败');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const r = await api.export_.photoWall({ bytes });
    if (r && r.canceled) {
      // 用户自己取消了保存 —— 临时照片留着（也许还要再导一次）。
      setStatus('');
      return;
    }
    // 导出完成：临时照片用完就删 —— 它们不属于任何一篇回忆，也不该留在
    // 磁盘上。墙上它们的位置也空出来（照片已经不在了）。
    const tmpCount = state.photos.filter((p) => p.tmpId).length;
    await dropTmpPhotos();
    const mb = (r && r.bytes ? (r.bytes / 1024 / 1024).toFixed(1) : '?');
    const failedTxt = failed ? ` · ${failed} 张没画上` : '';
    const tmpTxt = tmpCount ? ` · ${tmpCount} 张临时照片已清理` : '';
    toast(`照片墙已导出：${W}×${H} · ${filled.length} 张照片${failedTxt}${tmpTxt} · ${mb} MB`);
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e));
  }
  state.exporting = false;
  setStatus('');
  render();
}

// 把一张照片画进导出用的画布。
async function drawExportCell(ctx, geo, cell, cover) {
  const p = state.photoById.get(cell.photoId);
  if (!p) return false;
  let bytes = null;
  try {
    // 临时导入的照片在临时目录里，回忆里的照片在数据库里 —— 两条路。
    bytes = p.tmpId
      ? await api.tmpPhotos.read(p.tmpId)
      : await api.memorialEvents.photos.bytes(cell.photoId);
  } catch (e) {
    console.error('read export bytes failed', cell.photoId, e);
    return false;
  }
  if (!bytes || !bytes.byteLength) return false;
  const bmp = await decodePhoto(bytes, p ? p.mime : '');
  if (!bmp) return false;
  try {
    const rect = coverRect(bmp.width, bmp.height, cover);
    const r = cellRect(geo, cell);
    ctx.drawImage(bmp, rect.left, rect.top, rect.width, rect.height,
      r.x, r.y, r.w, r.h);
    return true;
  } catch (e) {
    console.error('draw export cell failed', cell.photoId, e);
    return false;
  } finally {
    // 解码出来的是一整张原图 —— 画完就放掉，别把显存占着。
    if (typeof bmp.close === 'function') bmp.close();
  }
}

// 解码一张照片的原始字节。
//
// 不用「blob: URL + <img>」：主窗口的 CSP 是 `img-src 'self' data: file:`，
// blob: 会被当场拒绝（「Refused to load the image 'blob:…'」），图片永远
// 加载不出来 —— 导出的墙于是只剩一块形状的底色。createImageBitmap 直接吃
// Blob，不经过 URL，也就绕开了 CSP 这条路。
//
// 类型对不上时（mime 记错了）再试一次没有类型的 Blob，让浏览器自己认。
async function decodePhoto(bytes, mime) {
  let last = null;
  const tries = mime ? [{ type: mime }, {}] : [{}];
  for (const opts of tries) {
    try {
      return await createImageBitmap(new Blob([bytes], opts));
    } catch (e) {
      last = e;
    }
  }
  console.error('decode photo failed', last);
  return null;
}

function setStatus(text) {
  state.status = text || '';
  const el = document.getElementById('wall-status');
  if (el) el.textContent = state.status;
}

register('/photo-wall', mount);
