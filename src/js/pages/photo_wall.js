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
// 手动的部分：换照片、删照片、给某个格子改封面、把照片拖到别的格子，
// 以及**调整形状**（拖形状挪位置、拖角上的手柄等比缩放）。
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
  DEFAULT_SHAPE_TRANSFORM, SHAPE_SCALE_MIN, SHAPE_SCALE_MAX,
  normalizeTransform, clampTransform, getShape,
  transformFromCenter, centerFromTransform, basePlace,
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
  // 形状的调整：位置 + 等比缩放。见「调整形状」一节。
  transform: { ...DEFAULT_SHAPE_TRANSFORM },
  // 正在拖形状（移动 / 缩放）—— 拖的过程中不重排 DOM，只重画画布。
  dragging: null,    // { kind: 'move' | 'scale', ... }
  // 背景：画布底图。见「背景」小节。
  bgCatalog: {},     // { '1:1': [{ id, url, ... }] } —— 按画幅分组
  bgId: '',          // 当前选中的背景 id（空串 = 无背景）
  bgImg: null,       // 当前背景的 ImageBitmap，没有则为 null
  bgToken: 0,        // 读背景图的代号 —— 用来作废过期的读图请求
};

// 窗口大小变了，画布要跟着重新算宽度。监听器只留一个（换页时换掉）。
let resizeHandler = null;

// 离开这一页的监听器 —— 只留一个（换页时换掉）。
let leaveHandler = null;

// 刚刚拖过形状 —— 拖完的那一次点击不算「选格子」（手一松就点，容易误点）。
let justDragged = false;

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
  state.transform = { ...DEFAULT_SHAPE_TRANSFORM };
  state.dragging = null;
  state.bgId = '';
  // 上一轮留下的 bitmap（换了一组回忆又进来）—— 先放掉，别攒着占显存。
  state.bgToken = (state.bgToken || 0) + 1;
  releaseBackground();
  if (state.eventIds.length === 0) {
    render();
    return;
  }
  state.loading = true;
  render();
  await Promise.all([loadPhotos(), loadBackgrounds()]);
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
    // 背景的 bitmap 占着显存 —— 离开这一页就放掉（正在读的那次也作废）。
    state.bgToken = (state.bgToken || 0) + 1;
    releaseBackground();
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

// ---- 背景 ------------------------------------------------------------------
//
// 画布的底图。资源在 `resources/photo_wall_background/<宽-高>/*.png`：一个
// 子目录 = 一个画幅，目录名写成「宽-高」（`1-1` 就是 1:1 画幅），里面的每
// 张 PNG 都是这一档画幅下的一张背景候选。
//
// 换画幅就换目录：当前画幅的那个目录里没有图，就退回「无背景」—— 墙照旧
// 画在白底上，不会因为缺资源而报错。
//
// 背景画在画布的最底下，照片墙整个盖在上面（形状的底色是不透明的，所以墙
// 的轮廓之外才是背景露出来的地方）。

// 读背景图库。读不到就当没有背景 —— 这一步失败不该拦住整个页面。
async function loadBackgrounds() {
  try {
    const catalog = await api.photoWallBg.list();
    state.bgCatalog = (catalog && typeof catalog === 'object') ? catalog : {};
  } catch (e) {
    console.error('load photo wall backgrounds failed', e);
    state.bgCatalog = {};
  }
}

// 当前画幅下的背景候选。
function bgOptions() {
  const t = state.template;
  if (!t) return [];
  return state.bgCatalog[t.ratioId] || [];
}

// 选中一张背景（或者「无背景」）。
//
// 换了画幅以后原来那张可能已经不在候选里了 —— 这时候退回无背景，而不是
// 拿一张不对画幅的图硬贴上去。
async function selectBackground(bgId) {
  const opts = bgOptions();
  const hit = opts.find((o) => o.id === bgId) || null;
  state.bgId = hit ? hit.id : '';
  await reloadBackground();
  render();
}

// 把当前选中的背景读进内存（还没读就读，读不出来就退回无背景）。
//
// 换画幅之后同一个 id 指的是另一张图 —— 所以读图这一步每次都要重新做，
// 不能靠缓存 id。
//
// 读图是异步的（字节从主进程过来），所以这里带一个「代号」：读图的这会儿
// 里用户可能又换了画幅或者又挑了另一张 —— 那一次读回来的是过期的东西，
// 不能往画布上放。代号对不上就把它扔掉。
async function reloadBackground() {
  const token = (state.bgToken = (state.bgToken || 0) + 1);
  if (!state.bgId || !state.template) {
    releaseBackground();
    return;
  }
  const hit = bgOptions().find((o) => o.id === state.bgId);
  if (!hit) {
    state.bgId = '';
    releaseBackground();
    return;
  }
  const bmp = await loadBackgroundBitmap(hit);
  if (token !== state.bgToken) {
    // 有人抢先了（又换了一次）—— 这张读回来的图已经过期，放掉它。
    if (bmp && typeof bmp.close === 'function') {
      try { bmp.close(); } catch (e) { /* 已经关过了 */ }
    }
    return;
  }
  if (!bmp) {
    // 图读不出来（文件没了、格式不对）—— 当成没有背景。
    state.bgId = '';
    releaseBackground();
    return;
  }
  releaseBackground();
  state.bgImg = bmp;
}

// 读一张背景图，解成 bitmap。
//
// 不用 `<img src="file://…">` 再 drawImage：主窗口是从 file:// 加载的，
// 从这样的页面里画一张 file:// 的图会把画布弄脏（opaque origin），随后
// `toBlob()` 抛 SecurityError —— 导出的 PNG 会一个像素都拿不到。
//
// 字节从主进程过来（IPC），用 createImageBitmap 解：它直接吃 Blob，不经
// 过 URL，也不弄脏画布。跟导出照片时解原图是同一个办法。
async function loadBackgroundBitmap(bg) {
  try {
    const bytes = await api.photoWallBg.read({ ratioId: state.template.ratioId, id: bg.id });
    if (!bytes || !bytes.byteLength) return null;
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    return bmp;
  } catch (e) {
    console.error('load background failed', bg && bg.id, e);
    return null;
  }
}

// 换画幅之后重新对一下背景。
//
// 背景是按画幅分目录的：新画幅那个目录里可能没有原来那张，也可能有一张同
// 名同 id 的（不同画幅各有 1.png 是很正常的）—— 但那是**另一张图**，得重
// 新读。所以这里只保留 id，图片交给调用方重新加载。
//
// 新画幅的候选里没有这一张，就退回无背景。
function syncBackground() {
  // 画幅变了 —— 正在读的那张图已经不对了，让它作废。
  state.bgToken = (state.bgToken || 0) + 1;
  const opts = bgOptions();
  const still = opts.find((o) => o.id === state.bgId);
  if (!still) {
    state.bgId = '';
    releaseBackground();
    return;
  }
  // 同一个 id，但已经换了一张图 —— 丢掉旧的 bitmap，重新读。
  releaseBackground();
}

// 放掉当前背景的 bitmap。
//
// ImageBitmap 占了显存，不用了就得 close —— 否则翻几次背景就攒下一堆。
function releaseBackground() {
  const img = state.bgImg;
  state.bgImg = null;
  if (img && typeof img.close === 'function') {
    try { img.close(); } catch (e) { /* 已经关过了 */ }
  }
}

// 背景画在画布上的位置：铺满整个画布，等比放大裁掉多出来的那一边
// （`cover`）—— 所以背景的边永远被画布切掉，不会露白。
function paintBackground(ctx, W, H) {
  const img = state.bgImg;
  if (!img || !img.width) return;
  const scale = Math.max(W / img.width, H / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  try {
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } catch (e) {
    console.error('paint background failed', e);
  }
}

// ---- 模板 ------------------------------------------------------------------

// 自动挑一套模板：按照片张数和用户给照片设的封面画幅。
function autoPick() {
  const ratios = state.photos.map((p) => (
    p.cover && p.cover.ratio ? p.cover.ratio : photoDefaultRatio(p.w, p.h)
  ));
  const want = dominantRatio(ratios);
  const shapeId = state.template ? state.template.shapeId : SHAPES[0].id;
  state.template = pickTemplate(shapeId, state.photos.length, want, state.transform);
  buildCells();
  // 自动匹配会改画幅 —— 背景是按画幅分目录的，得重新对一下。
  syncBackground();
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
        <p class="meta">把回忆里的照片拼成一块形状。画布的长宽比跟照片一样，照片摆进格子不用裁；形状画在画布正中、四周留一圈白边，只有落进形状里的格子才摆照片，照片再被形状裁一刀 —— 整面墙的轮廓就是形状。画布底下还能铺一张背景图，照片墙整个盖在上面。</p>
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
        <div class="form-row">
          <div class="field">
            <label>背景</label>
            <select id="wall-bg">${bgOptionsHtml()}</select>
          </div>
          <div class="field" style="flex:1; min-width:240px;">
            <label>&nbsp;</label>
            <p class="meta" id="wall-bg-note">${bgNote()}</p>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>形状大小</label>
            <div class="wall-scale-row">
              <input type="range" id="wall-scale" min="${Math.round(SHAPE_SCALE_MIN * 100)}" max="${Math.round(SHAPE_SCALE_MAX * 100)}" step="1" value="${Math.round(state.transform.scale * 100)}"/>
              <span class="wall-scale-value" id="wall-scale-value">${Math.round(state.transform.scale * 100)}%</span>
            </div>
          </div>
          <div class="field">
            <label>&nbsp;</label>
            <button type="button" class="btn" id="wall-shape-reset-btn">重置形状位置和大小</button>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>形状中心位置</label>
            <div class="wall-scale-row">
              <span class="meta wall-pos-label">横向</span>
              <input type="number" id="wall-shape-cx" class="wall-pos-input" min="0" max="100" step="1" value="${Math.round(shapeCenter().x)}" title="形状中心离画布左边的百分比"/>
              <span class="meta">%</span>
              <span class="meta wall-pos-label">纵向</span>
              <input type="number" id="wall-shape-cy" class="wall-pos-input" min="0" max="100" step="1" value="${Math.round(shapeCenter().y)}" title="形状中心离画布上边的百分比"/>
              <span class="meta">%</span>
            </div>
          </div>
          <div class="field" style="flex:1; min-width:240px;">
            <label>&nbsp;</label>
            <p class="meta">50% / 50% 就是画布正中。也可以直接在画布上拖动形状来挪位置。</p>
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
          <p class="meta">也可以直接调整形状：按住形状里<b>空着的格子</b>拖动可以挪位置，拖<b>四个角上的手柄</b>可以等比缩放；位置也可以<b>直接填数字</b>（上面的「形状中心位置」，50% 就是正中）。</p>
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
        <p class="meta" style="margin-top:8px;">导出的是一块完整的 PNG：照片按原始分辨率裁切，照片墙整个盖在背景上（不透明），形状之外露出来的是背景（没选背景时是白底）。</p>
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
    const cap = buildTemplate(shapeId, s.id, ratioId, state.transform).capacity;
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

// 背景下拉：先是「无背景」，然后是当前画幅下的候选。
function bgOptionsHtml() {
  const opts = bgOptions();
  const none = `<option value=""${state.bgId ? '' : ' selected'}>无背景</option>`;
  return none + opts.map((o) => (
    `<option value="${escapeHtml(o.id)}"${state.bgId === o.id ? ' selected' : ''}>${escapeHtml(o.label || o.id)}</option>`
  )).join('');
}

// 背景这一行下面的一句话：说清楚为什么没有背景可选。
function bgNote() {
  const t = state.template;
  if (!t) return '';
  const opts = bgOptions();
  if (!opts.length) {
    return `这一档画幅（${t.ratioId}）没有背景资源 —— 用无背景模式，照片墙画在白底上。`;
  }
  return `背景铺在画布底下，照片墙整个盖在上面（不透明），露出来的部分是背景。`;
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

// 拖动形状的时候重画底画布 —— 尺寸不变，只把内容重画一遍。
function paintBaseNow() {
  const canvas = document.getElementById('wall-canvas');
  if (!canvas || !canvas.width) return;
  paintBase(canvas.getContext('2d'), canvas.width, canvas.height);
}

function paintBase(ctx, W, H) {
  const t = state.template;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // 背景铺在最底下（铺满整个画布）。形状和照片随后整个盖在它上面。
  paintBackground(ctx, W, H);
  if (!t) return;
  const geo = wallGeometry(t, H);
  const path = shapePath(geo.shape);

  // 形状的底：一层淡色，让人看得见形状（空着的格子就是它）。
  //
  // 这一层是不透明的 —— 墙整个盖在背景上，形状之外才是背景露出来的地方。
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
  paintHandles(ctx, geo);
}

// 四个角的缩放手柄 —— 画在轮廓的包围盒四角上。
//
// 手柄是给用户看的：按住它拖，形状就等比缩放。
//
// geo.bounds 和 handlePoints 给的都是**设备像素**（画布按 dpr 放大过），
// 而这里画的也是同一块画布 —— 所以不用再换算。
function paintHandles(ctx, geo) {
  const b = geo.bounds;
  if (!Number.isFinite(b.minX)) return;
  // 手柄的大小按画布缩放：缩略图上也抓得住，又不至于盖住整面墙。
  const size = Math.max(8, Math.min(HANDLE_SIZE * 2, geo.scale / 30));
  const half = size / 2;
  ctx.save();
  for (const h of handlePoints(geo)) {
    // 白底 + 深色的边 —— 什么背景上都看得清。
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#d97757';
    ctx.lineWidth = Math.max(1.5, geo.scale / 300);
    ctx.beginPath();
    ctx.rect(h.x - half, h.y - half, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
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
//
// 横竖分开换算：画布的屏幕像素是方的，而模板坐标的宽是画幅、高是 1 ——
// x 要除以画布的**宽**再乘画幅，y 除以画布的**高**。
function cellAt(clientX, clientY) {
  const canvas = document.getElementById('wall-canvas');
  const t = state.template;
  if (!canvas || !t) return -1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.height || !rect.width) return -1;
  const x = (clientX - rect.left) / rect.width * t.ratio;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || y < 0 || x > t.ratio || y > 1) return -1;
  const col = Math.floor((x * t.n) / t.ratio);
  const row = Math.floor(y * t.n);
  for (const cell of t.cells) {
    if (cell.col === col && cell.row === row) return cell.index;
  }
  return -1;
}

// ---- 调整形状 --------------------------------------------------------------
//
// 系统给的是默认形状：摆在画布正中，占满留白以后能占的最大面积。有时候背
// 景和形状对不上 —— 形状该往边上挪一挪，或者该小一点。所以形状可以被
// 用户拖着改。
//
// 两种手势：
//
//   拖形状本身   → 挪位置
//   拖角上的手柄 → 等比缩放（形状的长宽比不变，心形放大以后还是心形）
//
// 调整完以后，格子要按**调整过后的形状**重排 —— 哪些格子还落进形状里，
// 就重新算一遍，照片按顺序重新填进去（和换网格时的做法一样）。
//
// 拖动过程中不重排 DOM（那太贵），只重画画布；手一松才重排格子。

// 手柄的边长（像素）—— 按画布大小缩放，缩略图上也能抓住。
const HANDLE_SIZE = 12;

// 抓着多近算抓住了手柄（像素）—— 比手柄本身大一点，好抓。
const HANDLE_GRAB = 16;

// 画布坐标（宽 = ratio、高 = 1）里的手柄位置 —— 四个角。
//
// 手柄跟着形状走：形状挪了、缩了，手柄跟着走。
function handlePoints(geo) {
  const b = geo.bounds;
  return [
    { id: 'nw', x: b.minX, y: b.minY },
    { id: 'ne', x: b.maxX, y: b.minY },
    { id: 'se', x: b.maxX, y: b.maxY },
    { id: 'sw', x: b.minX, y: b.maxY },
  ];
}

// 屏幕坐标（像素）→ 画布坐标（宽 = ratio、高 = 1）。
//
// 横竖要分开换算：模板空间的**宽是 ratio、高是 1**，而画布的屏幕像素是
// 方的 —— x 按画布的宽走，y 按画布的高走。
//
// 之前 x 也除了画布的高：正方形的画布（1:1）看不出来，宽画布（16:9）上
// x 会偏一大截，于是「指针在不在形状里」判错，形状根本拖不动。
function toCanvasPoint(clientX, clientY) {
  const canvas = document.getElementById('wall-canvas');
  const t = state.template;
  if (!canvas || !t) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.height || !rect.width) return null;
  return {
    x: (clientX - rect.left) / rect.width * t.ratio,
    y: (clientY - rect.top) / rect.height,
  };
}

// 指针落在哪个手柄上 —— 落在就返回它的 id，否则 null。
//
// 返回的 pxX / pxY 是手柄在**屏幕**上的位置（CSS 像素）—— 缩放的时候
// 手柄跟手，就靠它。
//
// 手柄的位置来自 wallGeometry —— 那是**设备像素**（画布按 dpr 放大过），
// 所以要除掉 dpr 才是屏幕上的 CSS 像素。
function handleAt(clientX, clientY) {
  const canvas = document.getElementById('wall-canvas');
  const t = state.template;
  if (!canvas || !t) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.height) return null;
  const dpr = window.devicePixelRatio || 1;
  const geo = wallGeometry(t, rect.height * dpr);
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  for (const h of handlePoints(geo)) {
    const hx = h.x / dpr;
    const hy = h.y / dpr;
    if (Math.abs(px - hx) <= HANDLE_GRAB && Math.abs(py - hy) <= HANDLE_GRAB) {
      return { id: h.id, pxX: rect.left + hx, pxY: rect.top + hy };
    }
  }
  return null;
}

// 指针在不在形状里面 —— 在形状里按下就意味着「挪形状」。
//
// 判据用的是轮廓点：点在多边形里就算在形状内。这里用的是「射线法」的
// 简化版 —— 从点往右边数轮廓的边，奇数条就在里面。
function insideShape(pt) {
  const t = state.template;
  if (!t || !pt) return false;
  const pts = t.outline;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > pt.y) !== (b.y > pt.y)) {
      const x = a.x + ((pt.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (pt.x < x) inside = !inside;
    }
  }
  return inside;
}

// 应用一份调整：形状变了，格子按新形状重排，照片重新填进去。
function applyTransform(next) {
  state.transform = normalizeTransform(next);
  if (!state.template) return;
  // 挪动不能把形状整个拖出画布 —— 拖出去就找不回来了。
  state.transform = clampTransform(
    state.transform,
    state.template.ratio,
    baseOutline(),
  );
  state.template = buildTemplate(
    state.template.shapeId,
    state.template.sizeId,
    state.template.ratioId,
    state.transform,
  );
  buildCells();
  syncScaleUi();
  render();
  syncCenterUi();
}

// 百分数夹在 0 ~ 100。
function clampPercent(n) {
  return Math.max(0, Math.min(100, n));
}

// 没挪没缩的那份轮廓 —— 挪动的余地按它算。
//
// 每次都重新算（而不是存起来）：形状模板换了、画幅换了以后，「没调过的形状」
// 也不一样了，存起来会过期。
function baseOutline() {
  const t = state.template;
  if (!t) return [];
  const base = buildTemplate(t.shapeId, t.sizeId, t.ratioId, DEFAULT_SHAPE_TRANSFORM);
  return base.outline;
}

// 滑块和它旁边的数字 —— 跟着当前调整走。
function syncScaleUi() {
  const range = document.getElementById('wall-scale');
  if (range) range.value = String(Math.round(state.transform.scale * 100));
  const label = document.getElementById('wall-scale-value');
  if (label) label.textContent = `${Math.round(state.transform.scale * 100)}%`;
}

// 形状中心在画布里的位置（百分之几）—— 输入框里显示的就是它。
//
// 用的是**调整之后**的轮廓的中心：用户看到心形在哪儿，数字就是哪儿。
function shapeCenter() {
  const t = state.template;
  if (!t) return { x: 50, y: 50 };
  const c = centerFromTransform(
    state.transform,
    basePlace(getShape(t.shapeId), t.ratio),
    t.outline,
    t.ratio,
  );
  return { x: c.x, y: c.y };
}

// 两个输入框（横向 / 纵向）—— 跟着当前调整走。
function syncCenterUi() {
  const c = shapeCenter();
  const cx = document.getElementById('wall-shape-cx');
  if (cx && document.activeElement !== cx) cx.value = String(Math.round(c.x));
  const cy = document.getElementById('wall-shape-cy');
  if (cy && document.activeElement !== cy) cy.value = String(Math.round(c.y));
}

// 按输入框里的中心位置重摆形状。
//
// 中心位置 → 位移，交给 applyTransform 收尾（它会夹住画布边界）。
function setShapeCenter(cx, cy) {
  const t = state.template;
  if (!t) return;
  const shape = getShape(t.shapeId);
  const place = basePlace(shape, t.ratio);
  const next = transformFromCenter(cx, cy, state.transform.scale, place, t.ratio);
  applyTransform(next);
}

// 拖动：记下手势的起点和形状当时的框。
//
// 「起点」记两遍 —— 一遍在屏幕坐标（算手柄跟不跟手），一遍在画布坐标
// （算形状挪了多少）。
//
// 缩放还要记下形状中心在**屏幕**上的位置：手柄离中心多远，形状就多大
// —— 中心不动，手柄跟手。
function beginDrag(e, kind, extra) {
  const canvas = document.getElementById('wall-canvas');
  if (!canvas) return;
  const t = state.template;
  if (!t) return;
  const rect = canvas.getBoundingClientRect();
  const geo = wallGeometry(t, rect.height * (window.devicePixelRatio || 1));
  const dpr = window.devicePixelRatio || 1;
  // 形状中心在屏幕上的位置（CSS 像素）—— 缩放的尺子。
  //
  // geo.bounds 是设备像素（画布按 dpr 放大过），除掉 dpr 才是屏幕像素。
  const centreX = rect.left + geo.bounds.cx / dpr;
  const centreY = rect.top + geo.bounds.cy / dpr;
  state.dragging = {
    kind,
    startClient: { x: e.clientX, y: e.clientY },
    startTransform: { ...state.transform },
    startBounds: { ...geo.bounds },
    // 没挪没缩的那份轮廓 —— 挪动的余地按它算（形状越小能挪的范围反而越
    // 大，没道理）。
    baseOutline: baseOutline(),
    // 形状中心在屏幕上的位置（CSS 像素）—— 缩放的尺子。
    centreClient: { x: centreX, y: centreY },
    // 起手时手柄离中心的距离（屏幕像素）—— 缩放的尺子的起点。
    startDist: extra && extra.handle
      ? Math.hypot(e.clientX - centreX, e.clientY - centreY)
      : 0,
  };
  canvas.classList.add(kind === 'scale' ? 'wall-scale-mode' : 'wall-move-mode');
  // 抓住画布 —— 指针拖到画布外面也不松手。
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器没有 */ }
}

// 拖动中：算出新的调整，**只重画画布**（格子等手松了再重排）。
function moveDrag(e) {
  const d = state.dragging;
  const t = state.template;
  if (!d || !t) return;
  if (d.kind === 'move') {
    // 挪动：按画布单位算位移。
    //
    // 横竖分开换算：模板空间的宽是 ratio、高是 1，所以 x 的位移要除以画布
    // 的**宽**再乘 ratio，y 除以画布的**高**。用同一个数换算横竖，宽画布
    // 上形状会跑得不对。
    const rect = document.getElementById('wall-canvas').getBoundingClientRect();
    const dx = (e.clientX - d.startClient.x) / rect.width * t.ratio;
    const dy = (e.clientY - d.startClient.y) / rect.height;
    state.transform = clampTransform({
      scale: d.startTransform.scale,
      dx: d.startTransform.dx + dx,
      dy: d.startTransform.dy + dy,
    }, t.ratio, d.baseOutline);
    redrawTransform();
    return;
  }
  // 缩放：手柄离形状中心的距离变了多少倍，形状就放大多少倍。
  //
  // 抓住哪个角，就用那个角和形状中心的距离当尺子 —— 形状中心不动，
  // 手柄跟手（这是图形编辑器里最常见的手感）。
  if (!(d.startDist > 0)) return;
  const nowDist = Math.hypot(
    e.clientX - d.centreClient.x,
    e.clientY - d.centreClient.y,
  );
  const startDist = Math.hypot(
    d.startClient.x - d.centreClient.x,
    d.startClient.y - d.centreClient.y,
  );
  if (!(startDist > 0)) return;
  const factor = nowDist / startDist;
  const scale = Math.min(SHAPE_SCALE_MAX, Math.max(SHAPE_SCALE_MIN, d.startTransform.scale * factor));
  state.transform = normalizeTransform({
    scale,
    dx: d.startTransform.dx,
    dy: d.startTransform.dy,
  });
  redrawTransform();
}

// 拖动中重画：形状的轮廓和格子都按新的调整画一遍（不重排 DOM）。
//
// 格子也得跟着重算 —— 形状挪了以后，哪些格子还落进形状里变了。但重排会
// 把照片挪来挪去，拖动的时候那样会闪。所以这里只是**重画**当前的格子
// （格子集合不变），手松开时再真的重排。
function redrawTransform() {
  const t = state.template;
  if (!t) return;
  // 用新的调整重算形状和格子，但先不换掉 state.cells（照片不闪）。
  const next = buildTemplate(t.shapeId, t.sizeId, t.ratioId, state.transform);
  state.template = next;
  paintBaseNow();
  paintOverlay();
  syncScaleUi();
  syncCenterUi();
}

// 拖动结束：真的重排格子，照片按顺序重新填进去。
function endDrag() {
  const d = state.dragging;
  state.dragging = null;
  const canvas = document.getElementById('wall-canvas');
  if (canvas) canvas.classList.remove('wall-scale-mode', 'wall-move-mode');
  if (!d) return;
  applyTransform(state.transform);
}

// ---- 交互 ------------------------------------------------------------------

function wire() {
  const shapeSel = document.getElementById('wall-shape');
  if (shapeSel) {
    shapeSel.onchange = () => {
      // 换形状：按同样的照片数和画幅重新挑一个网格。
      const ratio = state.template ? state.template.ratioId : '1:1';
      state.template = pickTemplate(shapeSel.value, state.photos.length, ratio, state.transform);
      buildCells();
      render();
    };
  }
  const sizeSel = document.getElementById('wall-size');
  if (sizeSel) {
    sizeSel.onchange = () => {
      state.template = buildTemplate(state.template.shapeId, sizeSel.value, state.template.ratioId, state.transform);
      buildCells();
      render();
    };
  }
  const ratioSel = document.getElementById('wall-ratio');
  if (ratioSel) {
    ratioSel.onchange = async () => {
      // 换画幅：画布的长宽比变了，格子数也跟着变 —— 重新挑一档网格。
      state.template = pickTemplate(state.template.shapeId, state.photos.length, ratioSel.value, state.transform);
      buildCells();
      // 背景是按画幅分的目录 —— 换画幅就换一批候选，同名的那张也是另一张
      // 图，所以要重新读一次。
      syncBackground();
      await reloadBackground();
      render();
    };
  }
  const autoBtn = document.getElementById('wall-auto-btn');
  if (autoBtn) autoBtn.onclick = async () => {
    autoPick();
    // 自动匹配可能改了画幅 —— 背景要重新读。
    await reloadBackground();
    render();
  };
  const resetShapeBtn = document.getElementById('wall-shape-reset-btn');
  if (resetShapeBtn) resetShapeBtn.onclick = () => {
    state.transform = { ...DEFAULT_SHAPE_TRANSFORM };
    applyTransform();
  };
  const scaleRange = document.getElementById('wall-scale');
  if (scaleRange) {
    scaleRange.oninput = () => {
      // 滑块只改大小 —— 位置不动。
      applyTransform({ ...state.transform, scale: Number(scaleRange.value) / 100 });
    };
  }
  // 中心位置的两个输入框 —— 填数字就把形状摆到那儿去。
  //
  // 用 onchange 而不是 oninput：一边打字一边重画，输入到一半的数（比如
  // 「1」想打成「15」）会把形状甩到奇怪的地方。填完、回车或失焦才生效。
  const cxInput = document.getElementById('wall-shape-cx');
  const cyInput = document.getElementById('wall-shape-cy');
  const applyCenterInputs = () => {
    const cx = Number(cxInput ? cxInput.value : NaN);
    const cy = Number(cyInput ? cyInput.value : NaN);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
    setShapeCenter(clampPercent(cx), clampPercent(cy));
  };
  if (cxInput) cxInput.onchange = applyCenterInputs;
  if (cyInput) cyInput.onchange = applyCenterInputs;

  const bgSel = document.getElementById('wall-bg');
  if (bgSel) bgSel.onchange = () => { selectBackground(bgSel.value); };

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
    // 刚刚拖过形状的话，这一次点击不算「选格子」—— 手一松就想点格子，
    // 结果点中的却是刚挪走的位置，会让人莫名其妙。
    if (justDragged) { justDragged = false; return; }
    state.selected = cellAt(e.clientX, e.clientY);
    renderSide();
    paintOverlay();
  });

  // ---- 调整形状：拖动 ----
  //
  // 手柄优先：抓着角上的小方块是缩放，抓着形状本身是挪位置。
  //
  // 用 pointer 事件而不是 mouse —— 触屏也能用（电子墨水屏的笔也行）。
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const handle = handleAt(e.clientX, e.clientY);
    if (handle) {
      beginDrag(e, 'scale', { handle });
      e.preventDefault();
      return;
    }
    // 形状里面才算是「挪形状」—— 形状外面按下去是选格子。
    const pt = toCanvasPoint(e.clientX, e.clientY);
    if (!pt || !insideShape(pt)) return;
    // 但格子里**有照片**时按下去是拖照片（原有的功能）—— 挪形状得从
    // 空着的格子（形状的底色）下手，否则两个手势打架。
    const index = cellAt(e.clientX, e.clientY);
    const cell = index >= 0 ? state.cells[index] : null;
    if (cell && cell.photoId) return;
    beginDrag(e, 'move');
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.dragging) {
      // 没在拖的时候：指针在手柄上就换个光标，让用户知道这里能抓。
      const handle = handleAt(e.clientX, e.clientY);
      if (handle) {
        canvas.classList.add('wall-handle-hover');
        canvas.classList.remove('wall-shape-hover');
      } else {
        canvas.classList.remove('wall-handle-hover');
        const pt = toCanvasPoint(e.clientX, e.clientY);
        canvas.classList.toggle('wall-shape-hover', !!(pt && insideShape(pt)));
      }
      return;
    }
    moveDrag(e);
    e.preventDefault();
  });

  const stopDrag = (e) => {
    if (!state.dragging) return;
    justDragged = true;
    endDrag();
    if (e && e.pointerId != null) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 没有抓到 */ }
    }
  };
  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);

  // 把墙上的照片拖到别的格子 —— 换位置。
  canvas.addEventListener('dragstart', (e) => {
    // 在形状上拖动 = 挪形状 —— 别让浏览器把照片也拖起来。
    if (state.dragging) { e.preventDefault(); return; }
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
  // 背景铺在最底下 —— 和编辑器里看到的是同一张图（只是分辨率不同）。
  paintBackground(ctx, W, H);

  const geo = wallGeometry(t, H);
  const path = shapePath(geo.shape);
  // 形状的底 —— 空着的格子是它，墙的轮廓因此看得见。
  // 不透明：墙整个盖在背景上。
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
