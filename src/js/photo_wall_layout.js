// src/js/photo_wall_layout.js — 照片墙的形状模板。
//
// 一张照片墙由三样东西决定：
//
//   形状（心形……）  —— 轮廓长什么样
//   尺寸（5 个）    —— 格子有多少，能装多少张照片
//   画幅（5 种）    —— 每个格子（照片）自己的宽高比
//
// 每个格子的宽高比一样，所以整个墙是「一块块同样大小的照片拼成的形状」。
// 一个形状 × 5 个尺寸 × 5 种画幅 = 25 种预制的填充方式，每一种能装的
// 照片数都不一样（格子越扁，能塞进同一块形状里的格子越多）。
//
// 这个文件是纯计算，不碰 DOM —— 导出时算格子、编辑时画格子，用的是同一套
// 规则。加一个新形状只要往 SHAPES 里加一条：名字、宽高比，和一个判断
// 「这个点在不在形状里」的函数。

'use strict';

import { COVER_RATIOS, ratioValue, closestRatioId, normalizeCover } from './diary_cover.js';

// ---- 形状 ------------------------------------------------------------------
//
// 一个形状是「归一化坐标里的轮廓」：u 和 v 都在 0..1 之间，u 从左往右，
// v 从上往下。形状自己的宽高比（aspect）是轮廓的宽除以高 —— 墙的格子按
// 画幅摊开以后，整块墙还是这个比例，所以形状不会被拉变形。

// 心形：经典的心形曲线 (x²+y²−1)³ = x²y³。
//
// 这条曲线的取值范围是 x ∈ [−1.1387, 1.1387]、y ∈ [−1.0, 1.2347]：
// 下尖在 y = −1，两个圆弧的顶在 y = 1.2347，中间 y = 1 处有个凹口。
// 曲线围起来的区域就是心形（函数值 ≤ 0 的那一侧）。
const HEART_X0 = -1.1387;
const HEART_X1 = 1.1387;
const HEART_Y0 = -1.0;
const HEART_Y1 = 1.2347;

function heartInside(u, v) {
  const x = u * (HEART_X1 - HEART_X0) + HEART_X0;
  const y = HEART_Y1 - v * (HEART_Y1 - HEART_Y0);
  const t = x * x + y * y - 1;
  return t * t * t - x * x * y * y * y <= 0;
}

// 可用的形状模板。
//
// 加一个新形状 = 加一条记录。比如一个圆：
//
//   { id: 'circle', name: '圆形', aspect: 1,
//     inside: (u, v) => (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.25 }
//
// 剩下的（尺寸、画幅、填充、选模板）都是现成的。
export const SHAPES = [
  {
    id: 'heart',
    name: '心形',
    aspect: (HEART_X1 - HEART_X0) / (HEART_Y1 - HEART_Y0),
    inside: heartInside,
  },
];

// ---- 尺寸 ------------------------------------------------------------------
//
// 每个形状有 5 个尺寸。尺寸用「行数」表示 —— 格子排成多少行，列数由
// 形状的宽高比和格子的画幅决定（见 buildTemplate）。
//
// 行数越多格子越密，能装的照片也越多：最小的一档十来张，最大的一档
// 一百多张。
export const WALL_SIZES = [
  { id: 's1', name: '小型', rows: 5 },
  { id: 's2', name: '中小型', rows: 7 },
  { id: 's3', name: '中型', rows: 9 },
  { id: 's4', name: '大型', rows: 12 },
  { id: 's5', name: '超大', rows: 15 },
];

// ---- 画幅 ------------------------------------------------------------------
//
// 格子的宽高比 —— 和笔记里封面的五种画幅是同一套（src/js/diary_cover.js），
// 这样照片墙里的格子比例和回忆笔记里的画框比例是同一批数字。
export const WALL_RATIOS = COVER_RATIOS;

// 一个形状的全部 25 种填充方式。
export function listTemplates(shapeId) {
  const shape = getShape(shapeId);
  const out = [];
  for (const size of WALL_SIZES) {
    for (const ratio of WALL_RATIOS) {
      out.push(buildTemplate(shape.id, size.id, ratio.id));
    }
  }
  return out;
}

export function getShape(shapeId) {
  return SHAPES.find((s) => s.id === shapeId) || SHAPES[0];
}

export function getSize(sizeId) {
  return WALL_SIZES.find((s) => s.id === sizeId) || WALL_SIZES[0];
}

// ---- 填充方式 --------------------------------------------------------------
//
// 一张填充方式 = 形状 × 尺寸 × 画幅。
//
// 格子排成 rows 行 × cols 列。列数是这么来的：整块墙的宽高比要等于
// 形状自己的宽高比（不然心形会被拉扁），而墙的宽高比 = 列数×格子宽 /
// (行数×格子高) = (列数/行数) × 格子画幅。于是列数 = 行数 × 形状宽高比
// / 格子画幅。
//
// 格子画幅越扁，列数越多 —— 同样一块形状里能塞下的格子也越多。这就是
// 25 种填充方式「能装的照片数各不相同」的来源。
//
// 格子按从上到下、从左到右的顺序编号，照片按这个顺序填进去。
export function buildTemplate(shapeId, sizeId, ratioId) {
  const shape = getShape(shapeId);
  const size = getSize(sizeId);
  const ratio = ratioValue(ratioId);
  const rows = size.rows;
  const cols = Math.max(2, Math.round(rows * shape.aspect / ratio));

  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const u = (col + 0.5) / cols;
      const v = (row + 0.5) / rows;
      if (!shape.inside(u, v)) continue;
      cells.push({ col, row, index: cells.length });
    }
  }

  return {
    shapeId: shape.id,
    shapeName: shape.name,
    sizeId: size.id,
    sizeName: size.name,
    ratioId,
    rows,
    cols,
    cells,
    capacity: cells.length,
  };
}

// ---- 选模板 ----------------------------------------------------------------
//
// 挑一个「综合最接近」的填充方式：照片数要装得下（装不下的模板先出局），
// 装得下的里面挑格子数最接近照片数的，再看画幅跟用户设的封面画幅差多少。
//
// 画幅的差距按对数算：宽高比是个倍数，1.78 和 1.33 的差跟 1.33 和 1.0
// 的差不是一回事（和笔记里挑封面用的是同一个想法）。
//
// 照片数差一张格子 vs 画幅差一档，谁更急？格子差得多意味着墙上空一块或
// 少放几张，画幅差一档只是裁得狠一点。所以画幅的差距换算成「几张照片」
// 的价钱再比。
const RATIO_PRICE = 8;

export function pickTemplate(shapeId, photoCount, ratioId) {
  const templates = listTemplates(shapeId);
  const count = Math.max(0, photoCount | 0);
  const wantRatio = ratioValue(ratioId);

  // 装得下照片的模板先挑：墙上空几格还能补，少放几张照片就是丢照片了。
  // 一个都装不下（照片比最大的模板还多）时，只能拿格子最多的那个。
  const fitting = templates.filter((t) => t.capacity >= count);
  const candidates = fitting.length ? fitting : templates;
  const overflow = fitting.length ? 0 : 1;

  let best = null;
  let bestScore = Infinity;
  for (const t of candidates) {
    // 格子数的差：空出来的格子算钱，装不下的算得更贵。
    const gap = t.capacity - count;
    const countPrice = gap >= 0 ? gap : -gap * 3;
    const ratioGap = Math.abs(Math.log(ratioValue(t.ratioId) / wantRatio));
    const score = countPrice + ratioGap * RATIO_PRICE;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = t;
    }
  }
  // 一个都装不下时，格子最多的那个优先 —— 剩下的照片由页面提示放不下。
  if (overflow) {
    let maxCap = -1;
    for (const t of templates) {
      if (t.capacity > maxCap) { maxCap = t.capacity; best = t; }
    }
  }
  return best || templates[0];
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
// 墙的格子之间留一条缝 —— 拼在一起是一块形状，中间有缝才看得出是一张一
// 张摆的。缝是格子的百分之一点五，所以格子越大缝越宽。
//
// 编辑器里的墙和导出的墙用的是同一个算法（只是格子的大小不同），所以
// 看到的和导出的长得一样。
export function wallGeometry(template, cellW) {
  const ratio = ratioValue(template.ratioId);
  const w = Math.max(8, Math.round(cellW));
  const h = Math.max(8, Math.round(w / ratio));
  const gap = Math.max(0, Math.round(w * 0.015));
  return {
    cellW: w,
    cellH: h,
    gap,
    width: template.cols * w + (template.cols - 1) * gap,
    height: template.rows * h + (template.rows - 1) * gap,
    x: (col) => col * (w + gap),
    y: (row) => row * (h + gap),
  };
}

// 导出时一个格子多少像素。
//
// 墙的宽度大致定在三千多像素：再宽没必要，再窄发出去看不清。
// 格子多了就小一点，格子少了就大一点，但都有个上下限。
export function exportCellWidth(cols) {
  const target = 3200;
  return Math.max(120, Math.min(480, Math.round(target / Math.max(1, cols))));
}
