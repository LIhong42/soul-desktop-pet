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
// the rules can be checked on their own (scripts/verify-diary-db.js).

'use strict';

// The gallery layouts the editor offers. Kept in sync with
// DIARY_GALLERY_LAYOUTS in src/js/pages/diary_edit.js.
const DIARY_GALLERY_LAYOUTS = new Set(['one', 'two', 'three', 'grid']);

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
      const layout = DIARY_GALLERY_LAYOUTS.has(b.layout) ? b.layout : DEFAULT_GALLERY_LAYOUT;
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

// Read a stored document back into blocks. The renderer does its own
// reading (it needs the photo names), but a round-trip through here
// proves a stored document is still understood.
function parseDiaryContent(stored) {
  if (!stored) return [];
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed;
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

module.exports = {
  normDiaryContent,
  parseDiaryContent,
  DIARY_GALLERY_LAYOUTS,
  DEFAULT_GALLERY_LAYOUT,
  MIN_PHOTO_WIDTH,
};
