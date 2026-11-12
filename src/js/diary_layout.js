// src/js/diary_layout.js — the shared vocabulary of a diary document.
//
// A diary body is an ordered list of BLOCKS (see src/js/pages/diary_edit.js
// for the editor that writes them, and main/diary_content.js for the
// server-side validation):
//
//   { type: 'text',   text: '…' }
//   { type: 'gallery', layout: 'one' | 'two' | 'three' | 'grid',
//     photos: [{ photo_id: '…', width: 0.5,
//                cover: { ratio: '16:9'|'4:3'|'1:1'|'3:4'|'9:16',
//                         x, y, zoom } }] }
//   { type: 'video',  media_id: '…', poster_id: '…'|null, width: 1 }
//   { type: 'audio',  media_id: '…' }
//
// The layout of a gallery says how many photos sit on a row:
//
//   单图  one per row, full width
//   双图  two per row
//   三图  three per row
//   网格  four per row — the dense one
//
// This module owns the two facts both the editor and the list card need:
// the layout table, and the width a photo takes inside a gallery.
//
// The editor renders a gallery with real photos; the 回忆 list renders
// the SAME gallery as a thumbnail inside a card. If the two disagreed
// about a layout's width, the card would not be a miniature of the page
// the user wrote — so the table lives here, once, and both read it.
//
// A photo's COVER — the rectangle of the picture its frame shows — lives
// in src/js/diary_cover.js. This module reads it out of the document and
// hands it on; the editor and the list card both need it.

import { normalizeCover } from './diary_cover.js';

export const DIARY_GALLERY_LAYOUTS = [
  { id: 'one',   name: '单图', width: 1 },
  { id: 'two',   name: '双图', width: 0.5 },
  { id: 'three', name: '三图', width: 1 / 3 },
  { id: 'grid',  name: '网格', width: 0.25 },
];

// The gap between two photos in a gallery. Must match the `gap` of
// .diary-gallery-items in src/css/styles.css — the width of a photo
// gives up its share of this gap, so a row of photos fills the gallery
// exactly.
export const GALLERY_GAP = 8;

// The layout a gallery falls back to when the document names one we don't
// know (an entry written by a future version, or a hand-edited row).
export const DEFAULT_GALLERY_LAYOUT = 'two';

// Look up a layout by id. Returns null for an unknown id so callers can
// decide what their fallback is.
export function galleryLayout(id) {
  return DIARY_GALLERY_LAYOUTS.find((l) => l.id === id) || null;
}

// The layout a new gallery starts with: one photo wants the full width,
// two a pair, three a trio, more than that the dense grid.
export function defaultLayoutFor(count) {
  if (count <= 1) return 'one';
  if (count === 2) return 'two';
  if (count === 3) return 'three';
  return 'grid';
}

// The rendered width of a photo, as a CSS width.
//
// The gallery is a flex row with a gap, so N photos of width w plus the
// gaps between them have to fit in 100%. Each photo therefore gives up a
// share of the gap — (1 - w) * gap — and a full-width photo (w = 1)
// gives up nothing.
export function photoCssWidth(frac) {
  const w = Math.min(1, Math.max(0.06, frac));
  return `calc(${(w * 100).toFixed(3)}% - ${((1 - w) * GALLERY_GAP).toFixed(2)}px)`;
}

// The width a photo takes in a gallery: its own size if the user set one,
// the layout's default otherwise. `photo` is one entry of a gallery
// block's `photos` array; `layoutId` is the gallery's layout.
export function effectivePhotoWidth(photo, layoutId) {
  if (photo && typeof photo.width === 'number' && isFinite(photo.width) && photo.width > 0) {
    return photo.width;
  }
  const layout = galleryLayout(layoutId) || galleryLayout(DEFAULT_GALLERY_LAYOUT);
  return layout.width;
}

// Parse a stored `content` document into blocks.
//
// Returns [] when the column is empty or holds something that is not a
// JSON array — a stale or hand-edited row must not break the page.
//
// Two document shapes are understood:
//   { type: 'gallery', layout, photos: [{ photo_id, width }] }  — current
//   { type: 'image',  photo_id }                                — retired
// The retired shape held a single photo per block; it loads as a
// one-photo gallery, so the document has only one shape on screen.
export function parseDiaryContent(stored) {
  if (!stored) return [];
  // The column holds a JSON string. A caller that already has the parsed
  // array (an in-memory row) is served as it is.
  if (Array.isArray(stored)) return normalizeBlocks(stored);
  if (typeof stored !== 'string') return [];
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch (e) {
    console.error('diary content is not valid JSON:', e);
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
    } else if (b.type === 'gallery') {
      const photos = [];
      for (const p of (Array.isArray(b.photos) ? b.photos : [])) {
        if (!p || typeof p !== 'object') continue;
        const photoId = typeof p.photo_id === 'string' ? p.photo_id : '';
        if (!photoId) continue;
        const photo = { photo_id: photoId };
        if (typeof p.width === 'number' && isFinite(p.width) && p.width > 0) {
          photo.width = Math.min(1, Math.max(0.06, p.width));
        }
        // The photo's cover: the rectangle of the picture its frame
        // shows. A photo without one gets the default mapping, worked
        // out from the picture's own shape.
        const cover = normalizeCover(p.cover);
        if (cover) photo.cover = cover;
        photos.push(photo);
      }
      if (!photos.length) continue;
      blocks.push({
        type: 'gallery',
        layout: galleryLayout(b.layout) ? b.layout : DEFAULT_GALLERY_LAYOUT,
        photos,
      });
    } else if (b.type === 'image' && typeof b.photo_id === 'string' && b.photo_id) {
      blocks.push({
        type: 'gallery',
        layout: 'one',
        photos: [{ photo_id: b.photo_id }],
      });
    } else if (b.type === 'video' || b.type === 'audio') {
      const mediaId = typeof b.media_id === 'string' ? b.media_id.trim() : '';
      if (!mediaId) continue;
      const block = { type: b.type, media_id: mediaId };
      // A video may carry a poster frame — the picture that stands in for
      // it before the user presses play.
      if (b.type === 'video') {
        const posterId = typeof b.poster_id === 'string' ? b.poster_id.trim() : '';
        if (posterId) block.poster_id = posterId;
        if (typeof b.width === 'number' && isFinite(b.width) && b.width > 0) {
          block.width = Math.min(1, Math.max(0.06, b.width));
        }
      }
      blocks.push(block);
    }
  }
  return blocks;
}

// The plain text of a document — the words of its text blocks, joined by
// blank lines. This is the same order and the same spacing the editor
// writes to the `notes` column, so a card can show the entry's words
// without reading that column.
export function diaryPlainText(blocks) {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.text || '').trim())
    .filter(Boolean)
    .join('\n\n');
}
