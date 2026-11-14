// src/js/photo_wall_layout.js — 照片墙的形状模板与网格计算。
//
// 一张照片墙由三样东西决定：
//
//   形状（心形……）—— 轮廓长什么样
//   网格（n×n）    —— 画布被切成多少份
//   画幅（5 种）    —— 照片自己的宽高比
//
// 画法（编辑器和导出用的是同一套）：
//
//   1. 画布的长宽比 = 画幅 = 照片的长宽比；
//   2. 形状用函数画在画布正中，四周留出一圈白边（画布的 5%），占满留白
//      之后能占的最大面积（一点不裁掉）；
//   3. 画布按 n×n 的网格线切开，只有「有一块落进形状里」的格子摆照片；
//   4. 照片再被形状裁一刀 —— 于是整面墙的轮廓就是形状本身。
//
// 因为网格是正方的（n 列 n 行），每格的长宽比 = 画布的长宽比 = 照片的
// 长宽比，照片铺进格子时既不拉伸也不多裁。
//
// 照片数决定网格密度：小数量用稀网格（6×6），大数量用密网格。
//
// 系统给的是默认形状，但用户可以**调整**它：拖动位置、拖角上手柄等比缩放
// （见「形状的调整」一节）。调整算在第 2 步里 —— 格子落不落进形状，
// 用的就是调整过后的形状，所以照片和轮廓永远对得上。
//
// 这个文件是纯计算，不碰 DOM —— 导出时算格子、编辑时画格子，用的是同一
// 套规则。加一个新形状只要往 SHAPES 里加一条：一圈轮廓点。

'use strict';

import { COVER_RATIOS, ratioValue, closestRatioId, normalizeCover } from './diary_cover.js';

// ---- 形状 ------------------------------------------------------------------
//
// 一个形状就是一圈轮廓点，加上它自己的宽高比（aspect）。
//
// 轮廓点统一摆进一个宽 1、高 1/aspect 的方框里 —— 方框的长宽比就是形状
// 的长宽比，所以形状放进画布时不会被拉变形。
//
// 加一个新形状只要给一圈点。比如一个圆：
//
//   { id: 'circle', name: '圆形', aspect: 1,
//     points: Array.from({ length: 120 }, (_, i) => {
//       const a = (i / 120) * Math.PI * 2;
//       return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
//     }) }
//
// 剩下的（网格、画幅、填充、选模板）都是现成的。

// 心形：经典参数方程
//
//   x = 16 sin³t
//   y = 13 cos t − 5 cos 2t − 2 cos 3t − cos 4t
//
// y 取了负 —— 画布的 y 往下长。
function heartOutline() {
  const pts = [];
  const N = 240;
  for (let i = 0; i < N; i += 1) {
    const t = (i / N) * Math.PI * 2;
    const s = Math.sin(t);
    pts.push({
      x: 16 * s * s * s,
      y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
    });
  }
  return pts;
}

// 把一圈点摆进宽 1 的方框（高度按点自己的高宽比），返回归一化后的点。
function normalizeOutline(raw) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return {
    points: raw.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / h })),
    aspect: w / h,
  };
}

const HEART = normalizeOutline(heartOutline());

// 可用的形状模板。
export const SHAPES = [
  {
    id: 'heart',
    name: '心形',
    aspect: HEART.aspect,
    points: HEART.points,
  },
];

// ---- 网格 ------------------------------------------------------------------
//
// 画布被切成 n×n 的网格线。照片越多网格越密 —— 格子小，照片多。
//
// 每一格的长宽比 = 画布的长宽比 = 照片的长宽比，所以照片铺进格子不用裁。
export const WALL_SIZES = [];
for (let n = 3; n <= 32; n += 1) {
  WALL_SIZES.push({ id: `g${n}`, name: `${n}×${n}`, n });
}

// ---- 画幅 ------------------------------------------------------------------
//
// 格子（也就是照片）的宽高比 —— 和笔记里封面的五种画幅是同一套
// （src/js/diary_cover.js），这样照片墙里的格子和回忆笔记里的画框是同一批
// 数字。画布的长宽比也跟它走。
export const WALL_RATIOS = COVER_RATIOS;

export function getShape(shapeId) {
  return SHAPES.find((s) => s.id === shapeId) || SHAPES[0];
}

export function getSize(sizeId) {
  return WALL_SIZES.find((s) => s.id === sizeId) || WALL_SIZES[0];
}

// ---- 形状的几何 ------------------------------------------------------------

// 形状离画布边缘留多远（占画布宽/高的比例）。
//
// 形状贴着边画出来，墙看起来像被画布切掉了一角 —— 上下左右都留一点白边，
// 墙才「浮」在画布中间。
const SHAPE_MARGIN = 0.05;

// 形状在画布里占的位置：整个轮廓按比例缩放后放进去（一点不裁掉），居中。
//
// 画布太宽或太高时，形状就由窄的那一边决定大小 —— 形状永远是「能放进
// 画布的最大那一个」（留出白边以后，是「能放进白边里最大的那一个」）。
function placeShape(shape, canvasW, canvasH) {
  const mx = canvasW * SHAPE_MARGIN;
  const my = canvasH * SHAPE_MARGIN;
  const availW = canvasW - mx * 2;
  const availH = canvasH - my * 2;
  const w = Math.min(availW, availH * shape.aspect);
  const h = w / shape.aspect;
  return { x: mx + (availW - w) / 2, y: my + (availH - h) / 2, w, h };
}

// ---- 形状的调整（位置 + 大小）---------------------------------------------
//
// 系统给的是一套默认形状 —— 心形摆在画布正中，占满留白以后能占的最大面
// 积。有时候背景和形状对不上：形状该往边上挪一挪，或者该小一点。
//
// 所以形状带着一份「调整」：
//
//   scale —— 等比缩放（50% ~ 200%）
//   dx    —— 左右挪多少（模板单位：画布宽 = ratio，高 = 1）
//   dy    —— 上下挪多少
//
// 缩放是**等比**的 —— 形状自己的长宽比不变，所以心形放大以后还是心形，
// 不会被拉扁。
//
// 缩放绕形状的中心转：放大的那一圈从中心往外长，而不是往一边挤。

// 调整的上下限。
export const SHAPE_SCALE_MIN = 0.5;
export const SHAPE_SCALE_MAX = 2;

// 一份「什么都没调」的调整。
export const DEFAULT_SHAPE_TRANSFORM = Object.freeze({ scale: 1, dx: 0, dy: 0 });

// 把一份调整收拾干净：不是数的用默认值，缩放夹在上下限里。
export function normalizeTransform(transform) {
  const t = transform || {};
  let scale = Number(t.scale);
  if (!Number.isFinite(scale)) scale = 1;
  scale = Math.min(SHAPE_SCALE_MAX, Math.max(SHAPE_SCALE_MIN, scale));
  let dx = Number(t.dx);
  if (!Number.isFinite(dx)) dx = 0;
  let dy = Number(t.dy);
  if (!Number.isFinite(dy)) dy = 0;
  return { scale, dx, dy };
}

// ---- 形状中心在画布里的位置 -----------------------------------------------
//
// 「挪了多少」（dx / dy）是相对量：形状默认在正中，挪一点就偏一点。用户
// 真正想说的是「心形的中心放在画布的哪儿」—— 那是**位置**，不是位移。
//
// 所以外面（输入框、拖动）都用中心位置说话：cx / cy 是画布的百分之几
// （0 ~ 100）。这里负责它和 dx / dy 之间的换算。
//
// 中心位置的 50% / 50% 就是「正中」= 什么都不调。

// 形状中心的百分之几 → 一份调整。
//
// `place` 是形状没调之前在画布里占的框（见 placeShape）—— 中心位置说的
// 是「缩放之后形状的中心在哪儿」，所以要先按缩放算一遍。
export function transformFromCenter(centerX, centerY, scale, place, ratio) {
  const s = Math.min(SHAPE_SCALE_MAX, Math.max(SHAPE_SCALE_MIN, Number(scale) || 1));
  const cx = Number(centerX);
  const cy = Number(centerY);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    return { scale: s, dx: 0, dy: 0 };
  }
  // 中心位置的百分数 → 画布上的坐标。
  const wantX = (cx / 100) * ratio;
  const wantY = cy / 100;
  // 形状自己的中心（缩放前）。
  const baseCx = place.x + place.w / 2;
  const baseCy = place.y + place.h / 2;
  return {
    scale: s,
    dx: wantX - baseCx,
    dy: wantY - baseCy,
  };
}

// 一份调整 → 形状中心的百分之几。
//
// `place` 是形状没调之前占的框；`outline` 是**调整之后**的轮廓（中心就在
// 它的包围盒正中）。
export function centerFromTransform(transform, place, outline, ratio) {
  const tf = normalizeTransform(transform);
  const b = shapeBounds(outline);
  const baseCx = place.x + place.w / 2;
  const baseCy = place.y + place.h / 2;
  return {
    x: ((b.cx) / ratio) * 100,
    y: (b.cy) * 100,
    // 中心位置换算成位移（给那些要位移的地方用）。
    dx: b.cx - baseCx,
    dy: b.cy - baseCy,
    scale: tf.scale,
  };
}

// 形状没调之前在画布里占的框 —— 中心位置的换算要用它。
export function basePlace(shape, ratio) {
  return placeShape(shape, ratio, 1);
}

// 调整在缓存键里的样子。
function transformKey(tf) {
  const q = (n) => Math.round(n * TRANSFORM_KEY_PRECISION);
  return `${q(tf.scale)}.${q(tf.dx)}.${q(tf.dy)}`;
}

// 把轮廓按调整摆到画布上。
//
// 轮廓点先绕形状自己的中心缩放（等比），再整体平移 —— 于是缩放不会让形
// 状「跑到一边去」，用户抓着的那个手柄也不会在缩放时从手里跑掉。
function applyTransform(outline, place, tf) {
  if (tf.scale === 1 && tf.dx === 0 && tf.dy === 0) return outline;
  const cx = place.x + place.w / 2;
  const cy = place.y + place.h / 2;
  return outline.map((p) => ({
    x: cx + (p.x - cx) * tf.scale + tf.dx,
    y: cy + (p.y - cy) * tf.scale + tf.dy,
  }));
}

// 调整之后形状在画布里占的框 —— 手柄就画在它四个角上。
//
// 框是轮廓的包围盒（不是缩放前的那个框）—— 形状挪了、缩了，手柄跟着走。
function shapeBounds(outline) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// 把形状挪进画布范围里 —— 别让它整个跑到画布外面去（用户看不见，也找
// 不回来）。
//
// 规矩：**形状的中心**要留在画布里。剩下的部分可以伸出画布（伸出去的被
// 切掉，看起来就是「贴着边」）。
//
// `outline` 是**调整之前**的轮廓（没挪没缩的那一份）—— 挪动的余地按它
// 算，不然形状越小能挪的范围反而越大，没道理。
export function clampTransform(transform, ratio, outline) {
  const tf = normalizeTransform(transform);
  const b = shapeBounds(outline);
  if (!Number.isFinite(b.minX) || !(b.w > 0) || !(b.h > 0)) return tf;
  // 规矩：**形状的中心**留在画布里。
  //
  // 之前用的是「形状的三分之一留在画布里」—— 那太严了：正方形的画布上，
  // 用户把中心挪到 30% 会被拉回 38%，输入框里填的数字和结果对不上，像是
  // 坏了。而「中心在画布里」正是「设置中心位置」这句话本身的意思。
  //
  // 中心留在画布里，形状就至少还有一半看得见（除非它比画布还大）。
  const minDx = -b.cx;
  const maxDx = ratio - b.cx;
  const minDy = -b.cy;
  const maxDy = 1 - b.cy;
  return {
    scale: tf.scale,
    dx: Math.max(minDx, Math.min(maxDx, tf.dx)),
    dy: Math.max(minDy, Math.min(maxDy, tf.dy)),
  };
}

// 把轮廓切成一条条水平带，每条带记住它在 x 上的几段区间。
//
// 一条带里的截面是不变的（只有碰到顶点的 y 才会变），所以「格子有没有
// 落进形状里」只要看这条带和格子在 x 上有没有交叠。
function buildBands(points) {
  const ys = Array.from(new Set(points.map((p) => p.y))).sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    const spans = crossSpans(points, (y0 + y1) / 2);
    if (!spans.length) continue;
    bands.push({ y0, y1, spans });
  }
  return bands;
}

// 水平线 y 和轮廓的交点，成对成段。
function crossSpans(points, y) {
  const xs = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    // 半开区间：顶点算在它上面那条边上，水平线才不会被数两次。
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  xs.sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
  return spans;
}

// 形状和画幅定下来以后，带子和轮廓就不再变了 —— 缓存起来省得每次重算。
//
// 键里还有形状的调整（位置 + 大小）—— 拖一下形状，带子和轮廓都得跟着
// 变，所以它们是键的一部分。
const bandCache = new Map();

// 形状调整在键里的精度 —— 拖动时每一步都会算一次几何，键太细的话缓存
// 会被拖动过程塞满。四位小数（模板单位）远小于一个像素，够用了。
const TRANSFORM_KEY_PRECISION = 10000;

// 缓存最多留多少条。
//
// 拖动形状的时候，每一步都是一个新的键 —— 拖一次能攒下几十条。缓存是给
// 「反复问同一个问题」用的（重画、换网格、导出），拖动过程中的那些几乎
// 不会再被问一遍。所以超过上限就把**最老的**扔掉（Map 按插入顺序排）。
const BAND_CACHE_MAX = 200;

function shapeGeometry(shape, ratio, transform) {
  const tf = normalizeTransform(transform);
  const key = `${shape.id}@${ratio.toFixed(4)}@${transformKey(tf)}`;
  const hit = bandCache.get(key);
  if (hit) return hit;
  // 模板里的坐标：画布宽 ratio、高 1。画的时候乘一个缩放就是像素。
  const place = placeShape(shape, ratio, 1);
  const outline = shape.points.map((p) => ({
    x: place.x + p.x * place.w,
    y: place.y + p.y * place.h,
  }));
  // 用户调整过的形状：先按中心缩放，再平移 —— 带子和轮廓用的是同一份
  // 算好的点，所以「哪些格子落进形状里」和「画出来的形状」永远一致。
  const placed = applyTransform(outline, place, tf);
  const geo = { bands: buildBands(placed), outline: placed };
  bandCache.set(key, geo);
  // 拖动会攒下很多条 —— 超出上限就丢掉最老的那些。
  while (bandCache.size > BAND_CACHE_MAX) {
    const oldest = bandCache.keys().next();
    if (oldest.done) break;
    bandCache.delete(oldest.value);
  }
  return geo;
}

// 第一条还压在 y 下方的带子。
function firstBandBelow(bands, y) {
  let lo = 0;
  let hi = bands.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bands[mid].y1 <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 一个格子有没有落进形状里 —— 只要有一小块落进去就算。
function cellHitsShape(bands, x0, y0, x1, y1) {
  for (let i = firstBandBelow(bands, y0); i < bands.length; i += 1) {
    const band = bands[i];
    if (band.y0 >= y1) break;
    for (const span of band.spans) {
      if (span[1] <= x0) continue;
      if (span[0] >= x1) break;
      return true;
    }
  }
  return false;
}

// ---- 填充方式 --------------------------------------------------------------
//
// 一张填充方式 = 形状 × 网格 × 画幅 × 形状的调整。
//
// 格子按从上到下、从左到右的顺序编号，照片按这个顺序填进去。
//
// `transform` 是形状的调整（位置 + 大小）—— 用户拖过形状以后，格子里
// 哪些还落进形状里，就按调整过后的形状来算。
export function buildTemplate(shapeId, sizeId, ratioId, transform) {
  const shape = getShape(shapeId);
  const size = getSize(sizeId);
  const ratio = ratioValue(ratioId);
  const n = size.n;
  const tf = normalizeTransform(transform);
  const { bands, outline } = shapeGeometry(shape, ratio, tf);

  const cw = ratio / n;
  const ch = 1 / n;
  const cells = [];
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const x = col * cw;
      const y = row * ch;
      if (!cellHitsShape(bands, x, y, x + cw, y + ch)) continue;
      cells.push({ col, row, index: cells.length, x, y, w: cw, h: ch });
    }
  }

  return {
    shapeId: shape.id,
    shapeName: shape.name,
    sizeId: size.id,
    sizeName: size.name,
    ratioId,
    ratio,
    n,
    cols: n,
    rows: n,
    cells,
    capacity: cells.length,
    outline,
    transform: tf,
  };
}

// ---- 选模板 ----------------------------------------------------------------
//
// 挑一个「装得下照片」的网格：格子数刚好够放照片的那一档（格子最少、
// 空位最少）。一个都装不下时（照片比最密的网格还多），拿格子最多的那个
// —— 剩下的照片由页面提示放不下。
export function pickTemplate(shapeId, photoCount, ratioId, transform) {
  const count = Math.max(0, photoCount | 0);
  let fit = null;
  let biggest = null;
  for (const size of WALL_SIZES) {
    const t = buildTemplate(shapeId, size.id, ratioId, transform);
    if (!biggest || t.capacity > biggest.capacity) biggest = t;
    if (t.capacity >= count && (!fit || t.capacity < fit.capacity)) fit = t;
  }
  return fit || biggest || buildTemplate(shapeId, WALL_SIZES[0].id, ratioId, transform);
}

// 一批照片里最常见的画幅 —— 用户给照片设的封面的主流形状。
export function dominantRatio(ratioIds) {
  const counts = new Map();
  for (const id of ratioIds) {
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let bestId = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN) { bestN = n; bestId = id; }
  }
  return bestId || '1:1';
}

// ---- 格子上的封面 ----------------------------------------------------------
//
// 照片墙上显示的不是原图，是照片的「等比封面」。
//
// 默认用用户在回忆笔记里给这张照片设的封面；只有在封面画幅和格子的画幅
// 不一样的时候，才改用笔记里的默认裁法重裁一遍：从照片中心往外长，
// 长到有一条边碰到照片的边为止（和记忆编辑页的默认封面是同一个办法，
// 只是形状换成了格子的形状）。
export function resolveCellCover(cover, cellRatioId, picW, picH) {
  if (cover && cover.ratio === cellRatioId) {
    return normalizeCover(cover);
  }
  // 默认封面：中心在正中，不缩放 —— 形状由格子决定。
  return { ratio: cellRatioId, x: 0.5, y: 0.5, zoom: 1 };
}

// 一张照片在「没有自己封面」时的默认画幅 —— 离它自己的形状最近的那一种。
export function photoDefaultRatio(picW, picH) {
  if (!(picW > 0) || !(picH > 0)) return '1:1';
  return closestRatioId(picW, picH);
}

// ---- 墙的几何 --------------------------------------------------------------
//
// 模板里的坐标是「画布宽 ratio、高 1」，画的时候乘一个缩放就变成像素。
// 编辑器里的墙和导出的墙用的是同一个算法（只是画布大小不同），所以看到
// 的和导出的长得一样。
export function wallGeometry(template, canvasH) {
  const s = canvasH;
  const cellW = (template.ratio * s) / template.n;
  const cellH = s / template.n;
  const shape = template.outline.map((p) => ({ x: p.x * s, y: p.y * s }));
  return {
    scale: s,
    cellW,
    cellH,
    canvasW: template.ratio * s,
    canvasH: s,
    x: (col) => col * cellW,
    y: (row) => row * cellH,
    shape,
    // 形状在画布上的包围盒（像素）—— 缩放手柄就画在它四个角上。
    bounds: shapeBounds(shape),
  };
}

// 一个格子在画布上的位置（像素）。
export function cellRect(geo, cell) {
  return {
    x: geo.x(cell.col),
    y: geo.y(cell.row),
    w: geo.cellW,
    h: geo.cellH,
  };
}

// 导出时画布多宽。
//
// 格子大约三百多像素：格子太密就看不清了，太宽发出去太大。总的宽度
// 落在 1600 ~ 4800 之间。
export function exportCanvasWidth(n) {
  return Math.max(1600, Math.min(4800, Math.round(n * 320)));
}
