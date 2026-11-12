// src/js/diary_cover.js — the cover of a picture in a gallery.
//
// A gallery shows every picture in a frame of one of five shapes:
//
//   横屏  16:9      横版  4:3
//   方形   1:1
//   竖版  3:4       竖屏  9:16
//
// The frame does NOT show the whole picture — it shows a MAPPING of it: a
// rectangle cut out of the original. The mapping is a crop, and it is
// what makes the frame free of holes: a picture of any shape fills its
// frame completely, and pictures of different shapes sit side by side
// without leaving gaps between them.
//
// ---- The default mapping ----
//
// When the user picks a picture and has not chosen a cover of their own,
// the mapping is worked out from the picture's own shape:
//
//   1. Take the allowed ratio closest to the picture's ratio.
//   2. Cut a rectangle of that ratio out of the picture, growing from the
//      picture's centre outwards until one of its edges reaches the
//      picture's edge.
//
// So a wide picture in a 16:9 frame loses nothing but its top and bottom
// edges; a square one in a 1:1 frame loses nothing at all; a 3:4 photo —
// the shape most phone cameras make — takes 3:4 and loses nothing either.
//
// ---- A cover of the user's own ----
//
// The automatic mapping is often good and sometimes ugly — the picture's
// centre may be an empty wall while the people stand at its edge. So the
// user opens the picture and moves the frame themselves.
//
// A cover is stored with the document, beside the photo it belongs to:
//
//   { photo_id: '…', width: 0.5,
//     cover: { ratio: '16:9', x: 0.5, y: 0.4, zoom: 1 } }
//
// `x` and `y` are the CENTRE of the frame in the picture's own
// coordinates — 0.5 is the middle, 0 the left edge, 1 the right edge.
// `zoom` says how much of the picture the frame covers: 1 is the widest
// the frame can be (it touches one of the picture's edges), 2 is twice
// as close.
//
// The numbers are relative, so the same cover works at any size the
// picture is drawn at — on the editor's page, on a card in the 回忆
// list, in a thumbnail.
//
// ---- How a frame is drawn ----
//
// The frame is a window onto the picture. The picture is drawn at its
// own shape, scaled up until the cover's rectangle covers the frame, and
// then slid so that the rectangle lands on the frame. The frame clips
// whatever hangs over.
//
// The rectangle is always kept inside the picture, so a frame always has
// something to show — there is never a hole in it.

'use strict';

// The shapes a gallery frame may take.
//
// 4:3 and 3:4 are here because they are the shape most phone photos
// actually are — without them a 3:4 photo has no frame of its own and
// is forced into 9:16, which cuts a narrow strip out of it and leaves
// the one axis the user wants to move frozen.
export const COVER_RATIOS = [
  { id: '16:9', name: '横屏', value: 16 / 9 },
  { id: '4:3', name: '横版', value: 4 / 3 },
  { id: '1:1', name: '方形', value: 1 },
  { id: '3:4', name: '竖版', value: 3 / 4 },
  { id: '9:16', name: '竖屏', value: 9 / 16 },
];

// The ratio a picture falls back to when its own shape is unknown (the
// bytes have not been read yet, or the file is not a picture at all).
export const DEFAULT_COVER_RATIO = '16:9';

// The smallest share of the picture a frame may cover. A frame that
// covered the whole picture would not be a frame at all.
const MIN_ZOOM = 1;

// The biggest share. Past this the frame is a few pixels of the picture
// blown up — it stops being a cover and starts being noise.
const MAX_ZOOM = 4;

// How far a frame may reach out of the picture. A frame whose centre is
// near the edge can still hang a little over it — the picture is then
// drawn a little larger and the overflow is cut off.
const OVERSCAN = 0.5;

// The ratio table, keyed by id.
const RATIO_BY_ID = new Map(COVER_RATIOS.map((r) => [r.id, r]));

// The ratio of a picture, or null when the size is unknown.
export function pictureRatio(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  return width / height;
}

// The allowed ratio closest to the picture's own.
//
// The allowed ratios sit on a line — 16:9 = 1.78, 4:3 = 1.33, 1:1 = 1,
// 3:4 = 0.75, 9:16 = 0.56 — and the closest one is the one whose distance
// in LOG space is smallest. Log space is used because a picture's ratio is
// a scale: a picture twice as wide is twice as wide whatever its
// height, and a plain subtraction would weigh a wide picture against
// a tall one unfairly.
//
// A picture can sit exactly between two shapes, and either shape would
// keep the same share of it. The tie is broken towards the shape on the
// SAME SIDE as the picture: a picture a little wider than square takes
// the wide shape, a picture a little taller takes the tall one.
export function closestRatioId(pictureW, pictureH) {
  const r = pictureRatio(pictureW, pictureH);
  if (r == null) return DEFAULT_COVER_RATIO;
  const logR = Math.log(r);
  // Which way the picture leans compared to the square.
  const pictureSide = Math.sign(logR - Math.log(1));
  let bestId = DEFAULT_COVER_RATIO;
  let bestDist = Infinity;
  let bestSide = 0;
  for (const item of COVER_RATIOS) {
    const d = Math.abs(logR - Math.log(item.value));
    const side = Math.sign(Math.log(item.value) - Math.log(1));
    if (d < bestDist - 1e-9) {
      bestDist = d;
      bestId = item.id;
      bestSide = side;
      continue;
    }
    if (Math.abs(d - bestDist) > 1e-9) continue;
    // A tie: the shape that leans the same way as the picture wins.
    if (side === pictureSide && side !== 0 && bestSide !== pictureSide) {
      bestId = item.id;
      bestSide = side;
    }
  }
  return bestId;
}

// The value of a ratio id, or the default's.
export function ratioValue(id) {
  const item = RATIO_BY_ID.get(id);
  return item ? item.value : (RATIO_BY_ID.get(DEFAULT_COVER_RATIO) || COVER_RATIOS[0]).value;
}

// The size of the frame cut out of a picture of `picW` × `picH`, at a
// given ratio and zoom.
//
// The frame starts as the LARGEST rectangle of that ratio that fits in
// the picture — that is the rectangle that touches one of the picture's
// edges when grown from the centre. A zoom of 1 is that rectangle; a
// zoom of 2 halves both of its sides.
export function coverSize(picW, picH, ratioId, zoom) {
  const ar = ratioValue(ratioId);
  const picRatio = picW / picH;
  let w;
  let h;
  if (picRatio >= ar) {
    // The picture is wider than the frame: the frame is limited by the
    // picture's height instead.
    h = picH;
    w = picH * ar;
  } else {
    w = picW;
    h = picW / ar;
  }
  const z = (typeof zoom === 'number' && isFinite(zoom) && zoom > 0) ? zoom : 1;
  return { w: w / z, h: h / z };
}

// The default cover for a picture of a given shape: the closest ratio,
// centred, at the widest zoom.
//
// The frame is grown from the picture's centre outwards until one of its
// edges reaches the picture's edge — so the frame's CENTRE is the
// picture's centre, and `x` and `y` are 0.5.
export function defaultCover(picW, picH) {
  const ratioId = closestRatioId(picW, picH);
  return {
    ratio: ratioId,
    x: 0.5,
    y: 0.5,
    zoom: 1,
  };
}

// Keep a cover inside the rules: a known ratio, a centre that may hang
// a little over the picture's edge, and a zoom inside its bounds.
export function normalizeCover(cover) {
  if (!cover || typeof cover !== 'object') return null;
  const ratio = RATIO_BY_ID.has(cover.ratio) ? cover.ratio : DEFAULT_COVER_RATIO;
  let x = typeof cover.x === 'number' && isFinite(cover.x) ? cover.x : 0.5;
  let y = typeof cover.y === 'number' && isFinite(cover.y) ? cover.y : 0.5;
  const zoom = typeof cover.zoom === 'number' && isFinite(cover.zoom)
    ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cover.zoom))
    : MIN_ZOOM;
  // The centre may sit slightly outside the picture — a frame near the
  // edge can still hang over it — but not far outside it.
  x = Math.min(1 + OVERSCAN, Math.max(-OVERSCAN, x));
  y = Math.min(1 + OVERSCAN, Math.max(-OVERSCAN, y));
  return { ratio, x: round4(x), y: round4(y), zoom: round4(zoom) };
}

// The rectangle of the picture that a cover shows, in the picture's own
// pixels: { left, top, width, height }.
//
// The rectangle is kept INSIDE the picture, so the frame always has
// picture to show and never leaves a hole.
export function coverRect(picW, picH, cover) {
  const c = normalizeCover(cover) || defaultCover(picW, picH);
  const { w, h } = coverSize(picW, picH, c.ratio, c.zoom);
  const cw = Math.min(w, picW);
  const ch = Math.min(h, picH);
  // The centre, pulled back inside the picture so the rectangle fits.
  const cx = Math.min(picW - cw / 2, Math.max(cw / 2, c.x * picW));
  const cy = Math.min(picH - ch / 2, Math.max(ch / 2, c.y * picH));
  return {
    left: cx - cw / 2,
    top: cy - ch / 2,
    width: cw,
    height: ch,
  };
}

// How to draw a picture inside a frame so that the frame shows exactly
// the cover's rectangle of it.
//
// The picture is drawn at its own shape, scaled up until the cover's
// rectangle covers the frame, and then slid so that the rectangle sits
// where the frame wants it. The frame clips whatever hangs over.
//
// The numbers are pixels, so the frame's own size has to be known. The
// result is the same at any size — the picture is scaled to the frame,
// so the same cover gives the same picture at any size.
//
// `frameW` and `frameH` are the frame's size in pixels.
export function coverFrameStyle(picW, picH, cover, frameW, frameH) {
  if (!(picW > 0) || !(picH > 0) || !(frameW > 0) || !(frameH > 0)) {
    return null;
  }
  const rect = coverRect(picW, picH, cover);
  // The scale that makes the cover's rectangle cover the frame.
  const scale = Math.max(frameW / rect.width, frameH / rect.height);
  const imgW = picW * scale;
  const imgH = picH * scale;
  // Where the picture's own top-left corner goes so that the rectangle
  // lands on the frame's top-left corner.
  const left = -rect.left * scale;
  const top = -rect.top * scale;
  return {
    imgWidth: imgW,
    imgHeight: imgH,
    imgLeft: left,
    imgTop: top,
  };
}

// The frame's own shape as a CSS aspect-ratio.
export function coverAspectRatio(ratioId) {
  const ar = ratioValue(ratioId);
  return `${ar.toFixed(6)}`;
}

// A cover that is safe to write to the document: null when the cover
// says nothing beyond the default, so the document stays small.
export function compactCover(cover) {
  const c = normalizeCover(cover);
  if (!c) return null;
  return c;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
