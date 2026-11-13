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
  // The read of every photo asked for, keyed by the photo's id. The
  // promise stays in the map after it has settled: the wait before the
  // measurement needs it, and a settled promise resolves at once.
  photoFetches: new Map(),
  // The photos whose read is still ON ITS WAY. A read that is still in
  // flight must not be started a second time.
  inFlight: new Set(),
  // The photos of the note being drawn RIGHT NOW. The wait before the
  // measurement is scoped to this set, not to every photo ever fetched —
  // a promise that settled on an earlier note cannot re-arm this note's
  // freshly built <img>.
  currentPhotos: new Set(),
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

// The date, as the memory card writes it: the day, without the time.
function fmtDateOnly(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s);
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
    // A picture that is still on its way is marked as a placeholder, so the
    // wait before the measurement can tell "the picture is there" from
    // "the placeholder is there" — the two look identical to the browser.
    const placeholderAttr = src === BLANK ? ` ${PLACEHOLDER_ATTR}="1"` : '';
    return `
      <div class="diary-gallery-item" style="width:${photoCssWidth(frac)};">
        <div class="diary-gallery-frame" data-ratio="${escapeHtml(ratio)}" ${coverAttr}
             style="aspect-ratio:${coverAspectRatio(ratio)};">
          <img src="${escapeHtml(src)}" data-photo-id="${escapeHtml(p.photo_id)}"${placeholderAttr} alt=""/>
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
// The placeholder is ALSO a trap, and the trap is what made photos come
// out empty in the album. The placeholder is `complete` and has a
// naturalWidth of 1, so anything that asks "is this picture there yet?"
// by looking at those two properties says YES — while the picture is in
// fact still on its way. The wait before the measurement used to ask
// exactly that, so the page measured the note and told the main process
// it was ready while the frames were still empty, and the screenshot
// caught the empty frames.
//
// So the placeholder is marked as a placeholder, and the wait looks for
// that mark instead of guessing from the picture's own size.
//
// The bytes are fetched once per photo and kept. The page waits for
// them before it measures the note — a note measured while its photos
// are still placeholders comes out too short, and the bottom of it is
// cut off.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// The marker that says "this <img> is still holding the placeholder".
// It is set on the element itself, so it survives the src being swapped
// and is visible to whoever asks whether the picture is really there.
const PLACEHOLDER_ATTR = 'data-placeholder';

function photoSrc(photoId) {
  // Every photo of the note being drawn is remembered, so the wait before
  // the measurement knows which fetches belong to THIS note.
  state.currentPhotos.add(photoId);
  const cached = state.photoCache.get(photoId);
  if (cached) return cached;
  // A fetch that is already on its way is NOT started a second time.
  //
  // The same picture can be asked for twice — the same photo in two
  // galleries of one note, or a note drawn again while the first read is
  // still in flight. Starting a second read would leave the first read's
  // promise orphaned, and the wait would then be on the SECOND promise
  // while the swap below belongs to the first: the picture would be
  // swapped in late, or not at all.
  if (!state.inFlight.has(photoId)) {
    // The fetch is registered as PENDING, not as a finished empty string.
    // Caching an empty result would mean "this photo has no bytes, ever"
    // — the placeholder would then be drawn for this note AND for every
    // later note that shows the same photo, with no second attempt.
    state.inFlight.add(photoId);
    const pending = bridge.readPhoto(photoId).then((r) => {
      const url = (r && r.data_url) || '';
      if (url) {
        state.photoCache.set(photoId, url);
        // The picture that is already on the page is swapped in place —
        // re-rendering the whole note would flash.
        for (const img of document.querySelectorAll(`img[data-photo-id="${CSS.escape(photoId)}"]`)) {
          if (img.getAttribute(PLACEHOLDER_ATTR) !== '1') continue;
          img.removeAttribute(PLACEHOLDER_ATTR);
          img.src = url;
          // The bytes are in, but the picture is not drawn until the
          // browser has DECODED it. The wait ends when the new load
          // finishes — not when the src is set — so the note is never
          // measured with a picture that is still being decoded.
          releaseWhenLoaded(img);
        }
        applyCoverMappings();
      } else {
        // The read failed. The photo is dropped from the cache so a later
        // note may try again — a failed read is a moment, not a verdict —
        // and the placeholder stays where it is.
        state.photoCache.delete(photoId);
        releasePhotoWaiters(photoId);
      }
      return url;
    }).catch(() => {
      // Same: a failed read must not poison the cache.
      state.photoCache.delete(photoId);
      releasePhotoWaiters(photoId);
      return '';
    });
    // The promise is remembered even after it has settled, so the wait
    // before the measurement can always find it — a settled promise
    // resolves at once. The photo is free to be read again by a later
    // note only when the read FAILED, and a failed read is dropped from
    // the cache above.
    state.photoFetches.set(photoId, pending);
    pending.finally(() => {
      state.inFlight.delete(photoId);
    });
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

// End the wait of every <img> that is holding the placeholder of one
// photo. Called when the photo's bytes turn out to be unavailable, so the
// note is drawn without that picture instead of waiting for the ceiling.
function releasePhotoWaiters(photoId) {
  for (const img of document.querySelectorAll(`img[data-photo-id="${CSS.escape(photoId)}"]`)) {
    if (typeof img._pdfPlaceholderWaiter !== 'function') continue;
    const waiter = img._pdfPlaceholderWaiter;
    img._pdfPlaceholderWaiter = null;
    waiter();
  }
}

// End an <img>'s wait when the picture it has just been given has been
// loaded.
//
// The bytes arriving is not the same as the picture being there: the src
// is set, and the browser decodes the picture after that. The wait ends on
// the load, so the note is only measured once the picture can really be
// painted.
//
// A picture that fails to load ends the wait too — a note drawn without
// that picture is better than a note that is never drawn.
function releaseWhenLoaded(img) {
  const waiter = img._pdfPlaceholderWaiter;
  if (typeof waiter !== 'function') return;
  const finish = () => {
    img.removeEventListener('load', finish);
    img.removeEventListener('error', finish);
    img._pdfPlaceholderWaiter = null;
    waiter();
  };
  img.addEventListener('load', finish);
  img.addEventListener('error', finish);
  // A picture that is already decoded (the browser had it cached) never
  // fires another load event — the wait has to end right away.
  if (img.complete && (img.naturalWidth || img.dataset.failed)) finish();
}
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
// The note is drawn as a PAGE OF ITS OWN, with the same three layers the
// memory card has and the same look the editor's sheet has:
//
//   ┌─────────────────────────┐
//   │ 标题（标题行）            │  ← the header bar
//   ├─────────────────────────┤
//   │ 文字板块 / 图片板块        │  ← the body
//   ├─────────────────────────┤
//   │ 2026-03-14（日期行）       │  ← the foot strip
//   └─────────────────────────┘
//
// The title and the date are therefore part of the SAME screenshot as
// the writing: they carry the theme's own colors, because they are the
// theme's own header and foot.
//
// The card's own classes are used, so this page and the card in the
// list are the same page — one scaled up for the PDF, one scaled down
// for the list.
async function renderNote(ev) {
  const theme = getDiaryTheme(ev.background);
  const themeVars = diaryThemeVars(theme);
  const vars = Object.entries(themeVars).map(([k, v]) => `${k}:${v}`).join(';');

  // The photos of THIS note. The wait below is scoped to them: a promise
  // that settled while an earlier note was on the page cannot re-arm the
  // <img> elements this note has just built.
  state.currentPhotos = new Set();

  const sheet = document.getElementById('pdf-sheet');
  sheet.innerHTML = `
    <div class="memorial-card-sheet pdf-note-sheet" style="${vars}">
      <div class="memorial-card-header pdf-note-header">
        <span class="memorial-card-title">${escapeHtml(ev.title || '(无标题)')}</span>
      </div>
      <div class="memorial-card-body pdf-note-body">
        <div class="diary-blocks" id="pdf-blocks">
          ${blocksHtml(noteBlocks(ev))}
        </div>
      </div>
      <div class="memorial-card-foot pdf-note-foot">
        <span class="memorial-card-date">${escapeHtml(fmtDateOnly(ev.occurred_at))}</span>
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
  await Promise.all(currentPhotoFetches());
  await whenImagesSettled();
  applyCoverMappings();
  await nextFrame();
  applyCoverMappings();
  await nextFrame();
}

// The fetches of the photos this note is showing.
//
// Only the photos of the note being drawn are waited for.
// `state.photoFetches` holds every photo ever asked for, and waiting for
// all of them would make each note wait for the whole album's downloads —
// and, worse, a promise that settled on an earlier note carries no
// information about the <img> elements this note has just built.
function currentPhotoFetches() {
  const out = [];
  for (const photoId of state.currentPhotos) {
    const p = state.photoFetches.get(photoId);
    if (p) out.push(p);
  }
  return out;
}

// Wait until every <img> on the page has either loaded or failed.
//
// `decode()` is not enough on its own — a picture whose bytes have not
// arrived yet decodes to nothing. The load/error events are what say
// the picture is really there.
//
// The PLACEHOLDER is not a picture. It is complete and it has a
// naturalWidth of 1, so a check that only looks at those two properties
// says "the picture is there" while the real bytes are still on their way
// — and the album ends up with empty frames. The wait therefore looks
// for the placeholder's own mark, and only calls a picture settled when
// it is neither a placeholder nor still loading.
function whenImagesSettled() {
  const imgs = Array.from(document.querySelectorAll('#pdf-blocks img'));
  if (!imgs.length) return Promise.resolve();
  return Promise.all(imgs.map((img) => new Promise((resolve) => {
    if (img.getAttribute(PLACEHOLDER_ATTR) === '1') {
      // Still the placeholder.
      //
      // The placeholder's OWN load event has already fired by now, so
      // waiting for another one would wait for ever — the next load only
      // comes when the real bytes are swapped in, and that happens
      // through the swap, not through a DOM event the page can observe
      // here. So the wait is on the SWAP: the fetch's `.then()` clears
      // the mark and resolves this promise.
      //
      // If the bytes never arrive the wait has to end anyway, so there is
      // a ceiling on it — a note is better drawn without a picture than
      // not drawn at all.
      const done = () => {
        clearTimeout(ceiling);
        resolve();
      };
      const ceiling = setTimeout(done, PHOTO_WAIT_CEILING_MS);
      img._pdfPlaceholderWaiter = done;
      return;
    }
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

// How long the wait for a picture's bytes may last before the note is
// drawn without it. A picture that takes longer than this is treated as
// lost: the album is better off with a frame than with no page at all.
const PHOTO_WAIT_CEILING_MS = 15000;

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

  // The main process asks the page to paint once more before it takes the
  // screenshot.
  //
  // `capturePage()` does not render the page — it hands back the frame the
  // COMPOSITOR last committed. A page that has just swapped a photograph
  // in may not be in that frame yet, and the screenshot then shows an
  // empty picture frame. Asking the page to paint and to say when it has
  // makes the capture land on a frame that holds what the page drew.
  bridge.onPaint(async () => {
    try {
      await nextFrame();
      await nextFrame();
    } catch (e) {
      // A paint that cannot be waited for is still worth answering: the
      // main process falls back to a plain capture.
    }
    try {
      bridge.painted();
    } catch (e) {
      console.error('pdf_page: could not signal the paint', e);
    }
  });

  // Tell the main process the page is up and listening.
  try { bridge.ready(); } catch (e) { /* ignore */ }
}
