// main/diary_content.js — validates the diary's mixed text/media document.
//
// The diary editor writes the body of a memorial event as an ordered
// document: a JSON array of blocks that live in the `content` column.
//
//   { type: 'text',   text: '…' }
//   { type: 'gallery', layout: 'one'|'two'|'three'|'grid',
//     photos: [{ photo_id: '…', width: 0.5 }] }
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

module.exports = {
  normDiaryContent,
  parseDiaryContent,
  DIARY_GALLERY_LAYOUTS,
  DEFAULT_GALLERY_LAYOUT,
  MIN_PHOTO_WIDTH,
};
