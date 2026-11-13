// main/diary_content.js — validates the diary's mixed text/media document.
//
// The diary editor writes the body of a memorial event as an ordered
// document: a JSON array of blocks that live in the `content` column.
//
//   { type: 'text',   text: '…' }
//   { type: 'gallery', layout: 'one'|'two'|'three'|'grid',
//     photos: [{ photo_id: '…', width: 0.5,
//                cover: { ratio: '16:9'|'4:3'|'1:1'|'3:4'|'9:16',
//                         x, y, zoom } }] }
//   { type: 'video',  media_id: '…', poster_id: '…'|null, width: 1 }
//   { type: 'audio',  media_id: '…' }
//
// A GALLERY is the multi-image insertion point: one place in the text can
// hold any number of photos. `layout` says how many photos sit on a row,
// and a photo's `width` is its share of the gallery's width — set when the
// user resizes that one photo.
//
// A VIDEO and an AUDIO are single media files. They live in the same
// `memorial_event_photos` table as the pictures — the row's `mime` says
// which it is — but they get their own block types because they render
// differently: a video is a player, an audio is a bar.
//
// The retired shape held a single photo per block:
//
//   { type: 'image',  photo_id: '…' }
//
// It is still understood, and stored as a one-photo gallery, so the
// document has only one shape on disk no matter which editor wrote it.
//
// The document is re-serialized here rather than stored verbatim: that
// keeps the stored shape canonical (two clients writing the same document
// produce the same bytes), drops empty blocks, and guarantees the JSON
// never contains anything but strings and numbers.
//
// This module is deliberately free of Electron and database imports, so
// the rules can be checked on their own.

'use strict';

// The gallery layouts the editor offers. Kept in sync with
// DIARY_GALLERY_LAYOUTS in src/js/pages/diary_edit.js.
//
// The value is the share of the gallery's width ONE PHOTO takes when the
// user has not resized it — the same numbers the editor's layout list
// carries (src/js/diary_layout.js).
const DIARY_GALLERY_LAYOUTS = {
  one: 1,
  two: 0.5,
  three: 1 / 3,
  grid: 0.25,
};

// The gap between two photos in a gallery, in CSS px. Must match the
// `gap` of .diary-gallery-items in src/css/styles.css — a photo's width
// gives up its share of this gap, so a row of photos fills the gallery
// exactly.
const GALLERY_GAP = 8;

// The layout used when the sender doesn't name one, and the layout a
// retired single-photo block is stored under.
const DEFAULT_GALLERY_LAYOUT = 'two';

// The smallest share of the gallery's width a photo may take.
const MIN_PHOTO_WIDTH = 0.06;

// The shapes a photo's cover may take. The same five the editor
// offers — see src/js/diary_cover.js.
const COVER_RATIOS = new Set(['16:9', '4:3', '1:1', '3:4', '9:16']);

// The shape a photo's cover falls back to when the document names one
// we don't know.
const DEFAULT_COVER_RATIO = '16:9';

// The smallest share of a picture a cover's frame may show.
const MIN_COVER_ZOOM = 1;

// The biggest share. Past this the frame is a few pixels of the picture
// blown up.
const MAX_COVER_ZOOM = 4;

// How far a cover's centre may hang out of the picture.
const COVER_OVERSCAN = 0.5;

// The widest a video may be. A video is its own row, so it may take the
// whole width — but not more than the page is wide.
const MAX_VIDEO_WIDTH = 1;

// Validate and canonicalize a diary document.
//
// Returns the JSON string to store, or null when there is no document.
// Throws when the payload is not an array — a malformed document is a
// programming error, not something to silently drop.
function normDiaryContent(input) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) throw new Error('日记内容格式错误');
  const blocks = [];
  for (const b of input) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      const text = typeof b.text === 'string' ? b.text : '';
      if (text.length) blocks.push({ type: 'text', text });
    } else if (b.type === 'image') {
      const photoId = typeof b.photo_id === 'string' ? b.photo_id.trim() : '';
      if (photoId.length) {
        blocks.push({ type: 'gallery', layout: 'one', photos: [{ photo_id: photoId }] });
      }
    } else if (b.type === 'gallery') {
      const photos = [];
      for (const p of (Array.isArray(b.photos) ? b.photos : [])) {
        if (!p || typeof p !== 'object') continue;
        const photoId = typeof p.photo_id === 'string' ? p.photo_id.trim() : '';
        if (!photoId.length) continue;
        const item = { photo_id: photoId };
        // The photo's share of the gallery's width.
        if (typeof p.width === 'number' && isFinite(p.width) && p.width > 0) {
          item.width = round3(Math.min(1, Math.max(MIN_PHOTO_WIDTH, p.width)));
        }
        // The photo's cover: the rectangle of the picture the frame
        // shows. A photo without one gets the default mapping, worked
        // out from the picture's own shape.
        const cover = normCover(p.cover);
        if (cover) item.cover = cover;
        photos.push(item);
      }
      if (!photos.length) continue;
      const layout = Object.prototype.hasOwnProperty.call(DIARY_GALLERY_LAYOUTS, b.layout)
        ? b.layout : DEFAULT_GALLERY_LAYOUT;
      blocks.push({ type: 'gallery', layout, photos });
    } else if (b.type === 'video' || b.type === 'audio') {
      const mediaId = typeof b.media_id === 'string' ? b.media_id.trim() : '';
      if (!mediaId.length) continue;
      const block = { type: b.type, media_id: mediaId };
      // A video may carry a poster frame (a picture that stands in for it
      // before the user presses play). An audio has no poster.
      if (b.type === 'video') {
        const posterId = typeof b.poster_id === 'string' ? b.poster_id.trim() : '';
        if (posterId.length) block.poster_id = posterId;
        if (typeof b.width === 'number' && isFinite(b.width) && b.width > 0) {
          block.width = round3(Math.min(MAX_VIDEO_WIDTH, Math.max(MIN_PHOTO_WIDTH, b.width)));
        }
      }
      blocks.push(block);
    }
  }
  if (!blocks.length) return null;
  return JSON.stringify(blocks);
}

// Read a stored document back into blocks.
//
// The blocks come back in the CANONICAL shape: the retired single-photo
// block is read as a one-photo gallery, an unknown layout falls back to
// the default one, and a photo's width and cover are clamped to the
// rules. That is the same shape the renderer reads (src/js/diary_layout.js
// does the same for its side), so the exporter and the page look at the
// same document.
function parseDiaryContent(stored) {
  if (!stored) return [];
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return normalizeBlocks(parsed);
}

// Turn a raw block array into the canonical block list: unknown blocks
// dropped, empty galleries dropped, the retired single-photo block read
// as a one-photo gallery.
function normalizeBlocks(parsed) {
  const blocks = [];
  for (const b of parsed) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      blocks.push({ type: 'text', text: typeof b.text === 'string' ? b.text : '' });
      continue;
    }
    if (b.type === 'gallery') {
      const photos = [];
      for (const p of (Array.isArray(b.photos) ? b.photos : [])) {
        if (!p || typeof p !== 'object') continue;
        const photoId = typeof p.photo_id === 'string' ? p.photo_id : '';
        if (!photoId) continue;
        const photo = { photo_id: photoId };
        if (typeof p.width === 'number' && isFinite(p.width) && p.width > 0) {
          photo.width = Math.min(1, Math.max(MIN_PHOTO_WIDTH, p.width));
        }
        const cover = normCover(p.cover);
        if (cover) photo.cover = cover;
        photos.push(photo);
      }
      if (!photos.length) continue;
      blocks.push({
        type: 'gallery',
        layout: Object.prototype.hasOwnProperty.call(DIARY_GALLERY_LAYOUTS, b.layout)
          ? b.layout : DEFAULT_GALLERY_LAYOUT,
        photos,
      });
      continue;
    }
    if (b.type === 'image' && typeof b.photo_id === 'string' && b.photo_id) {
      blocks.push({ type: 'gallery', layout: 'one', photos: [{ photo_id: b.photo_id }] });
      continue;
    }
    if (b.type === 'video' || b.type === 'audio') {
      const mediaId = typeof b.media_id === 'string' ? b.media_id.trim() : '';
      if (!mediaId) continue;
      const block = { type: b.type, media_id: mediaId };
      if (b.type === 'video') {
        const posterId = typeof b.poster_id === 'string' ? b.poster_id.trim() : '';
        if (posterId) block.poster_id = posterId;
        if (typeof b.width === 'number' && isFinite(b.width) && b.width > 0) {
          block.width = Math.min(MAX_VIDEO_WIDTH, Math.max(MIN_PHOTO_WIDTH, b.width));
        }
      }
      blocks.push(block);
    }
  }
  return blocks;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// Validate a photo's cover.
//
// Returns null when the document carries no cover — the picture then
// gets the default mapping, worked out from its own shape. A cover that
// says only what the default would say is kept as it is: the document
// is the user's, and dropping fields the user can see would make the
// editor's picture of the entry differ from the stored one.
function normCover(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ratio = COVER_RATIOS.has(raw.ratio) ? raw.ratio : DEFAULT_COVER_RATIO;
  const x = clampNum(raw.x, 0.5, -COVER_OVERSCAN, 1 + COVER_OVERSCAN);
  const y = clampNum(raw.y, 0.5, -COVER_OVERSCAN, 1 + COVER_OVERSCAN);
  const zoom = clampNum(raw.zoom, MIN_COVER_ZOOM, MIN_COVER_ZOOM, MAX_COVER_ZOOM);
  return { ratio, x: round3(x), y: round3(y), zoom: round3(zoom) };
}

function clampNum(v, fallback, min, max) {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// ---- 排版映射 ------------------------------------------------------------
//
// 编辑页的排版规则，主进程这边的对应版本。导出件要照着编辑页的样子
// 重排一遍（Word 相册、或者别的什么），就得知道图组里每张照片占多
// 宽、一行放几张 —— 这一节就是那份对应表。
//
// 规则本身跟 src/js/diary_layout.js 一致：一张照片的宽度是它在图组里
// 占的份额，用户拖过手柄的照片用自己的份额，没拖过的用图组排版的
// 默认份额。

// 一张照片在图组里占的份额（0-1）。
function photoShare(photo, layoutId) {
  if (photo && typeof photo.width === 'number' && isFinite(photo.width) && photo.width > 0) {
    return Math.min(1, Math.max(MIN_PHOTO_WIDTH, photo.width));
  }
  const layout = DIARY_GALLERY_LAYOUTS[layoutId];
  return layout != null ? layout : DIARY_GALLERY_LAYOUTS[DEFAULT_GALLERY_LAYOUT];
}

// 一张照片的实际宽度（CSS px），给定图组的可用宽度。
//
// 图组是一行 flex，照片之间有 GALLERY_GAP 的缝，所以每张照片要让出
// 自己那份缝：宽度 = 份额 × 可用宽度 − (1 − 份额) × 缝。这样一行的
// 照片加上缝，正好铺满图组 —— 和编辑页的算法是同一个。
function photoWidthPx(photo, layoutId, galleryWidth) {
  const share = photoShare(photo, layoutId);
  return Math.max(1, share * galleryWidth - (1 - share) * GALLERY_GAP);
}

// 一个图组分成几行，每行放哪几张。
//
// 一行放几张由排版说了算（单图一行、双图一行……），但用户把某一张
// 拖宽了，那一行就放不下那么多张 —— 于是换行。所以行是按「这一行还
// 装得下几张」算出来的，和浏览器的 flex 换行是同一件事。
function galleryRows(photos, layoutId, galleryWidth) {
  const perRow = Math.max(1, Math.round(1 / photoShare({ width: undefined }, layoutId)));
  const rows = [];
  let row = [];
  let used = 0;
  for (const p of photos) {
    const w = photoWidthPx(p, layoutId, galleryWidth);
    // 换行前先看这一行还装不装得下：装得下就放，装不下就换行。
    const fits = row.length === 0 || (used + w + GALLERY_GAP) <= galleryWidth + 0.5;
    if (!fits) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(p);
    used += w + (row.length > 1 ? GALLERY_GAP : 0);
  }
  if (row.length) rows.push(row);
  return rows;
}

// ---- 画框的形状 ------------------------------------------------------------
//
// 编辑页里一张照片不是原样摆着，而是摆在一个「画框」里：画框有自己的
// 形状（横屏 / 横版 / 方形 / 竖版 / 竖屏），照片按画框裁出来。导出件
// 要照着编辑页的样子排，就得知道画框是什么形状 —— 这一节是
// src/js/diary_cover.js 的对应版本。

// 五种画框形状的宽高比。
const COVER_RATIO_VALUES = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
  '3:4': 3 / 4,
  '9:16': 9 / 16,
};

// 画框的宽高比（一个数），未知形状时退回默认的横屏。
function coverRatioValue(ratioId) {
  const v = COVER_RATIO_VALUES[ratioId];
  return v != null ? v : COVER_RATIO_VALUES[DEFAULT_COVER_RATIO];
}

// 一张照片在没有自己画框时用哪一种画框：离它自己的形状最近的那一种。
//
// 最近是按对数的距离算的：宽高比是一个「倍数」，宽一倍的图宽一倍的
// 高，比一减一公平得多。两种形状一样近时，取跟照片同侧的那一种 ——
// 稍微偏宽的图取宽的形状，稍微偏高的图取高的形状。
function closestCoverRatioId(picW, picH) {
  if (!(picW > 0) || !(picH > 0)) return DEFAULT_COVER_RATIO;
  const logR = Math.log(picW / picH);
  const side = Math.sign(logR - Math.log(1));
  let bestId = DEFAULT_COVER_RATIO;
  let bestDist = Infinity;
  let bestSide = 0;
  for (const [id, value] of Object.entries(COVER_RATIO_VALUES)) {
    const d = Math.abs(logR - Math.log(value));
    const s = Math.sign(Math.log(value) - Math.log(1));
    if (d < bestDist - 1e-9) {
      bestDist = d; bestId = id; bestSide = s;
      continue;
    }
    if (Math.abs(d - bestDist) > 1e-9) continue;
    if (s === side && s !== 0 && bestSide !== side) {
      bestId = id; bestSide = s;
    }
  }
  return bestId;
}

// 一张照片的画框：画框的形状（宽高比）+ 照片被裁掉的部分。
//
// 编辑页里照片是「裁」进画框的：画框是照片上的一块矩形，画框之外的部分
// 被切掉。导出件要照着编辑页的样子摆照片，就得算出同一块矩形。
//
// 返回 { ratioId, ratio（宽高比）, crop: { l, t, r, b } }，crop 的四个数
// 是照片宽高的比例（0-1），告诉 Word 从照片的四边各切掉多少。
function photoFrame(picW, picH, cover) {
  const c = normCover(cover);
  const ratioId = c ? c.ratio : closestCoverRatioId(picW, picH);
  const ratio = coverRatioValue(ratioId);
  const zoom = c ? c.zoom : 1;

  // 画框的矩形：从照片的中心往外长，长到有一条边碰到照片的边为止。
  // 这就是编辑页的算法（src/js/diary_cover.js 的 coverRect）。
  let w; let h;
  if (picW / picH >= ratio) {
    h = picH; w = picH * ratio;
  } else {
    w = picW; h = picW / ratio;
  }
  const z = (typeof zoom === 'number' && isFinite(zoom) && zoom > 0) ? zoom : 1;
  w /= z; h /= z;

  // 矩形留在照片里面，画框才永远有东西可看。
  w = Math.min(w, picW);
  h = Math.min(h, picH);
  const cx = Math.min(picW - w / 2, Math.max(w / 2, (c ? c.x : 0.5) * picW));
  const cy = Math.min(picH - h / 2, Math.max(h / 2, (c ? c.y : 0.5) * picH));
  const left = cx - w / 2;
  const top = cy - h / 2;
  return {
    ratioId,
    ratio,
    crop: {
      l: left / picW,
      t: top / picH,
      r: (picW - (left + w)) / picW,
      b: (picH - (top + h)) / picH,
    },
  };
}

module.exports = {
  normDiaryContent,
  parseDiaryContent,
  DIARY_GALLERY_LAYOUTS,
  DEFAULT_GALLERY_LAYOUT,
  MIN_PHOTO_WIDTH,
  GALLERY_GAP,
  photoShare,
  photoWidthPx,
  galleryRows,
  coverRatioValue,
  closestCoverRatioId,
  photoFrame,
  normCover,
};
