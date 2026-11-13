// src/js/pdf_page.js — the offscreen diary page used by the PDF export.
//
// The export used to put one photo on one PDF page, which threw away
// everything the user arranged in the 回忆 editor. Now one PDF page holds
// one MEMORY NOTE: the note's text blocks and image blocks, in the order
// the user wrote them, scaled as one piece onto the page.
//
// The page is rendered by the real browser — the same CSS, the same
// modules, the same block classes the editor uses — so the exported page
// is the editor's page by construction, not a re-implementation of it.
// The main process then screenshots it and drops the bitmap into the PDF.
//
// It talks to the main process through its OWN bridge
// (main/preload_pdf_page.js), not the app's `api.js`: the app's API
// wrapper is built around the whole app (reminders, the pet, the export
// channels), and this page needs exactly two calls — read the entry, read
// a picture's bytes.
//
// The protocol is a pull, not a push: the main process sends
// `{ width, eventId }` over IPC, the page renders it and answers with
// `{ ok, x, y, width, height }` — the note's box inside the window —
// or `{ ok: false, reason }` when the note cannot be drawn.

import { getDiaryTheme, diaryThemeVars } from './diary_themes.js';
import {
  parseDiaryContent, effectivePhotoWidth, photoCssWidth,
  galleryLayout, DEFAULT_GALLERY_LAYOUT,
} from './diary_layout.js';
import {
  coverAspectRatio, coverFrameStyle, defaultCover, normalizeCover,
  DEFAULT_COVER_RATIO,
} from './diary_cover.js';

const bridge = window.soulPdfPage;

// The state of the page being drawn.
const state = {
  token: 0,
  photoCache: new Map(),
  pending: new Map(),
};

// ---- The block rendering --------------------------------------------------
//
// These are the editor's own block shapes — the same class names, the
// same DOM structure, the same module calls. That is what makes the
// export's page the editor's page: there is no second set of rules to
// keep in step with the first.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function blocksHtml(blocks) {
  return blocks.map((b) => blockHtml(b)).join('');
}

// One block of the document. A text block is a paragraph; a gallery is a
// row of photos laid out the way the gallery was saved.
function blockHtml(b) {
  if (b.type === 'text') {
    const text = (b.text || '').trim();
    if (!text) return '';
    // A <div> rather than the editor's <textarea>: the words are the
    // same, but a textarea would show its own padding and border, and a
    // textarea cannot be laid out as a plain paragraph of text.
    return `<div class="diary-block-text pdf-block-text">${escapeHtml(text)}</div>`;
  }
  if (b.type === 'gallery') {
    return galleryHtml(b);
  }
  // A movie or a sound has no place on a printed page — the export is a
  // paper album. The block is skipped, exactly as a text block with
  // nothing in it is.
  return '';
}

// A gallery: the photos sit in a wrapping row, each one taking the share
// of the width the user gave it, or the layout's default when they left
// it alone.
function galleryHtml(b) {
  const layout = galleryLayout(b.layout) || galleryLayout(DEFAULT_GALLERY_LAYOUT);
  const photos = b.photos.map((p) => {
    const frac = effectivePhotoWidth(p, b.layout);
    const cover = normalizeCover(p.cover);
    const ratio = cover ? cover.ratio : DEFAULT_COVER_RATIO;
    const src = photoSrc(p.photo_id);
    const coverAttr = cover
      ? `data-cover="${escapeHtml(JSON.stringify(cover))}"`
      : '';
    return `
      <div class="diary-gallery-item" style="width:${photoCssWidth(frac)};">
        <div class="diary-gallery-frame" data-ratio="${escapeHtml(ratio)}" ${coverAttr}
             style="aspect-ratio:${coverAspectRatio(ratio)};">
          <img src="${escapeHtml(src)}" data-photo-id="${escapeHtml(p.photo_id)}" alt=""/>
        </div>
      </div>
    `;
  }).join('');
  return `
    <div class="diary-block-gallery" data-layout="${escapeHtml(layout.id)}">
      <div class="diary-gallery-items">${photos}</div>
    </div>
  `;
}

// The data URL of a photo, or a placeholder when the bytes have not
// arrived yet.
//
// The placeholder is a 1×1 transparent GIF: an <img> with no src at all
// would still take its frame's size, so the layout does not shift when
// the real bytes land.
//
// The bytes are fetched once per photo and kept. The page waits for
// them before it measures the note — a note measured while its photos
// are still placeholders comes out too short, and the bottom of it is
// cut off.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function photoSrc(photoId) {
  const cached = state.photoCache.get(photoId);
  if (cached) return cached;
  if (!state.photoCache.has(photoId)) {
    state.photoCache.set(photoId, '');
    // The promise is kept so the render can wait for the bytes.
    const pending = bridge.readPhoto(photoId).then((r) => {
      const url = (r && r.data_url) || '';
      state.photoCache.set(photoId, url);
      // The picture that is already on the page is swapped in place —
      // re-rendering the whole note would flash.
      for (const img of document.querySelectorAll(`img[data-photo-id="${CSS.escape(photoId)}"]`)) {
        if (url) img.src = url;
      }
      applyCoverMappings();
      return url;
    }).catch(() => { /* the placeholder stays */ });
    state.pending.set(photoId, pending);
  }
  return state.photoCache.get(photoId) || BLANK;
}

// Place the mapping of every picture on the page.
//
// The frame is a window onto the picture: the picture is drawn at its own
// shape and slid so that the cover's part of it lands on the frame. The
// numbers are measured against the frame's OWN size, so the mapping is
// the same at any size — which is what lets the export scale the note
// down onto the PDF page without the pictures changing shape.
function applyCoverMappings() {
  for (const frame of document.querySelectorAll('.diary-gallery-frame')) {
    const img = frame.querySelector('img');
    if (!img || !img.complete || !img.naturalWidth) continue;
    const raw = frame.getAttribute('data-cover');
    let cover = null;
    if (raw) {
      try { cover = normalizeCover(JSON.parse(raw)); } catch (e) { cover = null; }
    }
    if (!cover) cover = defaultCover(img.naturalWidth, img.naturalHeight);
    const style = coverFrameStyle(
      img.naturalWidth, img.naturalHeight, cover,
      frame.clientWidth, frame.clientHeight,
    );
    if (!style) continue;
    img.style.width = style.imgWidth + 'px';
    img.style.height = style.imgHeight + 'px';
    img.style.left = style.imgLeft + 'px';
    img.style.top = style.imgTop + 'px';
  }
}

// ---- The note -------------------------------------------------------------

// The note's own blocks.
//
// A note written before the mixed editor existed has no document — it
// falls back to the plain `notes` text, exactly as the editor does.
function noteBlocks(ev) {
  const blocks = parseDiaryContent(ev.content);
  if (blocks.length) return blocks;
  const legacy = (ev.notes || '').trim();
  return legacy ? [{ type: 'text', text: legacy }] : [];
}

// Draw one note into the page.
//
// The note is wrapped in the editor's own `.diary-page` sheet — but only
// its BODY is filled. The title bar and the decorative strip are the
// page's furniture, not part of the writing, and the export is a paper
// album of what the user wrote: the text blocks and the image blocks.
//
// The body's own padding is kept, because it is the margin the editor
// gives the writing — the words start at the same distance from the edge
// as they do on screen.
async function renderNote(ev) {
  const theme = getDiaryTheme(ev.background);
  const themeVars = diaryThemeVars(theme);
  const vars = Object.entries(themeVars).map(([k, v]) => `${k}:${v}`).join(';');

  const sheet = document.getElementById('pdf-sheet');
  sheet.innerHTML = `
    <div class="diary-page pdf-note-page" style="${vars}">
      <div class="diary-page-body pdf-note-body">
        <div class="diary-blocks" id="pdf-blocks">
          ${blocksHtml(noteBlocks(ev))}
        </div>
      </div>
    </div>
  `;

  // Wait for the photos' BYTES to arrive, and then for the pictures
  // themselves to settle. Both are needed: the frames need their own
  // size before the mapping can be placed, the mapping has to be placed
  // before the note is measured, and a note measured while its photos
  // are still placeholders comes out too short — the bottom of it would
  // be cut off. A picture that never arrives is left as it is — the note
  // is still drawn, just without that picture.
  await Promise.all(Array.from(state.pending.values()));
  await whenImagesSettled();
  applyCoverMappings();
  await nextFrame();
  applyCoverMappings();
  await nextFrame();
}

// Wait until every <img> on the page has either loaded or failed.
//
// `decode()` is not enough on its own — a picture whose bytes have not
// arrived yet decodes to nothing. The load/error events are what say
// the picture is really there.
function whenImagesSettled() {
  const imgs = Array.from(document.querySelectorAll('#pdf-blocks img'));
  if (!imgs.length) return Promise.resolve();
  return Promise.all(imgs.map((img) => new Promise((resolve) => {
    if (img.complete && (img.naturalWidth || img.dataset.failed)) {
      resolve();
      return;
    }
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => {
      img.dataset.failed = '1';
      resolve();
    }, { once: true });
  })));
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

// ---- The protocol ---------------------------------------------------------

// The main process asks for a note. The answer carries the note's RECT
// inside the window — the main process captures exactly that box and
// scales it onto the PDF page without distorting it.
async function handleRender(payload) {
  const token = ++state.token;
  const width = Math.max(320, Math.min(2000, Number(payload.width) || 560));
  document.getElementById('pdf-sheet').style.width = width + 'px';

  let ev = null;
  try {
    ev = await bridge.readEvent(payload.eventId);
  } catch (e) {
    console.error('pdf_page: could not load the entry', e);
  }
  if (!ev) {
    return { ok: false, reason: 'not_found', token };
  }

  await renderNote(ev);
  if (token !== state.token) return { ok: false, reason: 'stale', token };

  // The note's box, in CSS pixels, relative to the window's viewport.
  // `capturePage` takes the same units, so the main process can ask for
  // exactly this box and get the note — not the empty window around it.
  //
  // The height is the sheet's CONTENT height: a note taller than the
  // window is clipped by the window, and the rectangle would then report
  // the clipped height. The content height is the note's real height
  // however tall the note is.
  const sheet = document.getElementById('pdf-sheet');
  const rect = sheet.getBoundingClientRect();
  return {
    ok: true,
    token,
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.ceil(rect.width),
    height: Math.ceil(sheet.scrollHeight),
    // The window's own height, so the main process can tell whether the
    // note fits — and grow the window if it does not.
    viewportHeight: window.innerHeight,
  };
}

if (bridge) {
  bridge.onRender(async (payload) => {
    let reply;
    try {
      reply = await handleRender(payload || {});
    } catch (e) {
      console.error('pdf_page: render failed', e);
      reply = { ok: false, reason: 'error', message: String((e && e.message) || e) };
    }
    try {
      bridge.reply(reply);
    } catch (e) {
      console.error('pdf_page: could not reply', e);
    }
  });
  // Tell the main process the page is up and listening.
  try { bridge.ready(); } catch (e) { /* ignore */ }
}
