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
const bandCache = new Map();

function shapeGeometry(shape, ratio) {
  const key = `${shape.id}@${ratio.toFixed(4)}`;
  const hit = bandCache.get(key);
  if (hit) return hit;
  // 模板里的坐标：画布宽 ratio、高 1。画的时候乘一个缩放就是像素。
  const place = placeShape(shape, ratio, 1);
  const outline = shape.points.map((p) => ({
    x: place.x + p.x * place.w,
    y: place.y + p.y * place.h,
  }));
  const geo = { bands: buildBands(outline), outline };
  bandCache.set(key, geo);
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
// 一张填充方式 = 形状 × 网格 × 画幅。
//
// 格子按从上到下、从左到右的顺序编号，照片按这个顺序填进去。
export function buildTemplate(shapeId, sizeId, ratioId) {
  const shape = getShape(shapeId);
  const size = getSize(sizeId);
  const ratio = ratioValue(ratioId);
  const n = size.n;
  const { bands, outline } = shapeGeometry(shape, ratio);

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
  };
}

// ---- 选模板 ----------------------------------------------------------------
//
// 挑一个「装得下照片」的网格：格子数刚好够放照片的那一档（格子最少、
// 空位最少）。一个都装不下时（照片比最密的网格还多），拿格子最多的那个
// —— 剩下的照片由页面提示放不下。
export function pickTemplate(shapeId, photoCount, ratioId) {
  const count = Math.max(0, photoCount | 0);
  let fit = null;
  let biggest = null;
  for (const size of WALL_SIZES) {
    const t = buildTemplate(shapeId, size.id, ratioId);
    if (!biggest || t.capacity > biggest.capacity) biggest = t;
    if (t.capacity >= count && (!fit || t.capacity < fit.capacity)) fit = t;
  }
  return fit || biggest || buildTemplate(shapeId, WALL_SIZES[0].id, ratioId);
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
  return {
    scale: s,
    cellW,
    cellH,
    canvasW: template.ratio * s,
    canvasH: s,
    x: (col) => col * cellW,
    y: (row) => row * cellH,
    shape: template.outline.map((p) => ({ x: p.x * s, y: p.y * s })),
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
