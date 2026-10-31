// src/js/pages/diary_edit.js — the diary editor for 回忆事件.
//
// This page replaces the old one-field-per-slot memorial form. Instead of
// five narrow inputs (去了哪里 / 吃了什么 / 穿了什么 / 干了哪些事 / 补充描述)
// the user now writes on a single diary page: a title, a free-form body,
// and any number of photos, laid over one of six background styles.
//
// Flow:
//   /diary/new          → a blank diary page
//   /diary/<id>         → an existing entry
//   保存                → the entry is written (photos included)
//
// ---- Mixed text and images ----
//
// The body is not a plain <textarea> — that would keep text and photos
// in two separate boxes, which is what the old form did. Instead the page
// holds an ordered list of BLOCKS:
//
//   { type: 'text',   text: '…' }
//   { type: 'gallery', layout: 'one' | 'two' | 'three' | 'grid',
//     photos: [{ photo_id: '…', width: 0.5 }] }
//
// The user types into a text block, and inserting an image splits the
// current block and inserts a gallery between the halves. So the document
// reads top to bottom exactly as it will be stored.
//
// A GALLERY is the multi-image insertion point: one place in the text can
// hold any number of photos. The layout says how many photos sit on a row
// (one per row, two per row, three per row, a dense grid), and every
// photo can be resized on its own by dragging its handle — that override
// wins over the layout for that one photo. The photos keep the order the
// user put them in: drag a photo onto another one to swap their places.
//
// The blocks live in the `content` column (a JSON array). The plain text
// is ALSO written to the legacy `notes` column, because the search index
// and the album export both read that column — a diary written as mixed
// content must still be findable by its words.
//
// The five legacy structured fields (place / food / outfit / activities)
// are left untouched on save — they keep whatever the old form wrote, so
// an entry created before the diary editor existed still shows its
// structured fields in the detail view and in search results.
//
// ---- Where the controls live ----
//
// The controls of a block do NOT sit in the document. A 「插入图片 / 删除此段」
// row under every text block, and a layout switcher under every gallery,
// broke the flow of the writing: the buttons read as part of the page.
//
// So they live in a right-click menu instead (src/js/context_menu.js):
// right-click a text block for its two actions, right-click a gallery for
// the layout switch, the photo counter and the text insertions. The
// buttons are the same ones as before — only the way they appear changed.
// The text block's menu also carries the editing commands (剪切 / 复制 /
// 粘贴 / 全选), because the custom menu replaces the browser's own.

import {
  api, escapeHtml, displayName, toast,
  memorialPhotoUrl, fetchPhotoDataUrl, invalidatePhotoDataUrl,
  nowDatetimeLocal, wireDateInputs,
} from '../api.js';
import { register, navigate, getReferrerPath } from '../router.js';
import { openContextMenu } from '../context_menu.js';
import {
  DIARY_THEMES, DEFAULT_THEME_ID, getDiaryTheme, diaryThemeVars,
} from '../diary_themes.js';

const MEMORIAL_LIST_ROUTE = '/events/memorial';

// The state of the page currently on screen. Kept at module scope so a
// failed save doesn't lose what the user typed, and so the photo upload
// pass can find the blocks it needs to rewrite.
const pageState = {
  isNew: true,
  eventId: null,
  background: DEFAULT_THEME_ID,
  selectedContactIds: new Set(),
  // The mixed document. `blocks[i].el` points at the live DOM node for
  // that block (the text block's textarea, the gallery's figure).
  blocks: [],
  // Photos the user picked but that aren't uploaded yet. Each entry is
  // { file, tempId }. A gallery photo referring to a tempId is rewritten
  // to the real photo id once the upload succeeds.
  pendingPhotos: [],
  existingPhotos: [],
  returnTo: MEMORIAL_LIST_ROUTE,
};

// ---- Theme picker --------------------------------------------------------

// Render the six background style tiles. Each tile previews the style
// faithfully: the header bar, the body surface, the decorative strip and
// the three accent dots, exactly like the reference picker.
function themePickerHtml(selectedId) {
  return `
    <div class="diary-theme-grid">
      ${DIARY_THEMES.map((t) => `
        <button type="button" class="diary-theme-tile${t.id === selectedId ? ' selected' : ''}"
                data-theme-id="${escapeHtml(t.id)}" title="${escapeHtml(t.name)}">
          <span class="diary-theme-bar" style="background:${escapeHtml(t.headerBg)};--theme-header-text:${escapeHtml(t.headerText)}">标题</span>
          <span class="diary-theme-body"
                style="--theme-top:${escapeHtml(t.bgTop)};--theme-mid:${escapeHtml(t.bgMid)}">
            <span class="diary-theme-band diary-theme-band-top"></span>
            <span class="diary-theme-band diary-theme-band-mid"></span>
            <span class="diary-theme-info">
              <span class="diary-theme-dots">
                ${t.dots.map((c) => `<i style="background:${escapeHtml(c)}"></i>`).join('')}
              </span>
              <span class="diary-theme-name" style="color:${escapeHtml(t.text)}">${escapeHtml(t.name)}</span>
            </span>
          </span>
          <span class="diary-theme-check">✓</span>
        </button>
      `).join('')}
    </div>
  `;
}

// ---- Contact picker ------------------------------------------------------

function contactPickerHtml(contacts, selected) {
  if (contacts.length === 0) {
    return `<div class="meta">还没有联系人可选择</div>`;
  }
  return `
    <div class="contact-picker-toolbar">
      <button type="button" class="btn secondary btn-tiny" id="diary-contacts-all">全选</button>
      <button type="button" class="btn secondary btn-tiny" id="diary-contacts-none">清空</button>
      <span class="meta" id="diary-contacts-count"></span>
    </div>
    <div class="contact-picker" id="diary-contact-picker">
      ${contacts.map((c) => `
        <div class="contact-pick${selected.has(c.id) ? ' selected' : ''}" data-id="${escapeHtml(c.id)}">
          <span class="contact-pick-check" aria-hidden="true">✓</span>
          <span class="contact-pick-name">${escapeHtml(displayName(c))}</span>
          ${c.relationship ? `<span class="contact-pick-meta">${escapeHtml(c.relationship)}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// ---- Lightbox ------------------------------------------------------------
//
// Same shared-modal pattern the memorial edit page uses: one element,
// reopened by swapping the <img src>.

let lightboxEl = null;
function openLightbox(url, altName) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.id = 'photo-lightbox';
    lightboxEl.className = 'photo-lightbox';
    lightboxEl.innerHTML = `
      <div class="photo-lightbox-card">
        <button type="button" class="photo-lightbox-x" title="关闭">✕</button>
        <img id="photo-lightbox-img" alt=""/>
        <div class="photo-lightbox-caption" id="photo-lightbox-caption"></div>
      </div>
    `;
    document.body.appendChild(lightboxEl);
    const close = () => { lightboxEl.classList.remove('open'); };
    lightboxEl.querySelector('.photo-lightbox-x').onclick = close;
    lightboxEl.addEventListener('click', (e) => { if (e.target === lightboxEl) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightboxEl.classList.contains('open')) close();
    });
  }
  lightboxEl.querySelector('#photo-lightbox-img').src = url;
  lightboxEl.querySelector('#photo-lightbox-img').alt = altName || '';
  lightboxEl.querySelector('#photo-lightbox-caption').textContent = altName || '';
  lightboxEl.classList.add('open');
}

// ---- Blocks --------------------------------------------------------------
//
// A block is the unit of the mixed document. Text blocks are <textarea>
// elements so the user gets a real editing surface (multi-line, IME
// friendly, no contenteditable quirks); gallery blocks hold the photos
// that share one insertion point.
//
// Blocks are kept in `pageState.blocks` in document order, and each text
// block keeps a reference to its own <textarea> so the document can be
// serialized on save without re-querying the DOM.

let blockSeq = 0;

// ---- Gallery layouts ----------------------------------------------------
//
// A gallery lays its photos out in a wrapping flex row. The layout picks
// the default width of every photo in it:
//
//   单图  one per row, full width
//   双图  two per row
//   三图  three per row
//   网格  four per row — the dense one
//
// Dragging a photo's handle overrides that default for that one photo,
// so a gallery can end up with one big picture next to two small ones.

const GALLERY_GAP = 8; // keep in sync with .diary-gallery-items in styles.css

const DIARY_GALLERY_LAYOUTS = [
  { id: 'one',   name: '单图', width: 1 },
  { id: 'two',   name: '双图', width: 0.5 },
  { id: 'three', name: '三图', width: 1 / 3 },
  { id: 'grid',  name: '网格', width: 0.25 },
];

function galleryLayout(id) {
  return DIARY_GALLERY_LAYOUTS.find((l) => l.id === id) || null;
}

// The layout a new gallery starts with: one photo wants the full width,
// two a pair, three a trio, more than that the dense grid.
function defaultLayoutFor(count) {
  if (count <= 1) return 'one';
  if (count === 2) return 'two';
  if (count === 3) return 'three';
  return 'grid';
}

// The rendered width of a photo, as a CSS width.
//
// The flex row has a gap, so N photos of width w plus the gaps between
// them have to fit in 100%. Each photo therefore gives up a share of the
// gap — (1 - w) * gap — and a full-width photo (w = 1) gives up nothing.
function photoCssWidth(frac) {
  const w = Math.min(1, Math.max(0.06, frac));
  return `calc(${(w * 100).toFixed(3)}% - ${((1 - w) * GALLERY_GAP).toFixed(2)}px)`;
}

// Build one text block. `text` is its initial content.
function makeTextBlock(text) {
  const id = 'diary-tb-' + (++blockSeq);
  const block = { type: 'text', id, el: null };
  const ta = document.createElement('textarea');
  ta.className = 'diary-block-text';
  ta.id = id;
  ta.rows = 1;
  ta.placeholder = '写下这一刻…';
  ta.value = text || '';
  // Auto-grow: the textarea has no inner scrollbar, it just gets taller
  // as the user types. That keeps the page reading as one document.
  ta.addEventListener('input', () => autoGrow(ta));
  // The block's controls live in a right-click menu, so the writing
  // surface stays a clean document.
  ta.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTextMenu(block, e);
  });
  block.el = ta;
  return block;
}

// ---- The block menus -----------------------------------------------------
//
// The menu of a text block: the two actions the block used to carry, plus
// the editing commands the browser's own right-click menu would have
// offered (the custom menu replaces it, so they have to be here).
//
// The caret is captured when the menu opens: the picture lands where the
// user pressed, not where the caret happened to be.
function openTextMenu(block, e) {
  const ta = block.el;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  // Focus first, then put the caret back: focusing a textarea can move
  // the caret to the end of the text.
  ta.focus();
  try { ta.setSelectionRange(start, end); } catch (err) { /* no selection */ }
  const hasSelection = end > start;

  openContextMenu({
    x: e.clientX,
    y: e.clientY,
    items: [
      { act: 'insert-image', label: '插入图片' },
      { act: 'delete-block', label: '删除此段', danger: true },
      { sep: true },
      { row: [
        { act: 'cut', label: '剪切', disabled: !hasSelection },
        { act: 'copy', label: '复制', disabled: !hasSelection },
        { act: 'paste', label: '粘贴' },
        { act: 'select-all', label: '全选' },
      ]},
    ],
    onAction: (act, value) => handleTextMenuAction(block, act, value, { start, end }),
  });
}

// Run the action the user picked in a text block's menu.
function handleTextMenuAction(block, act, value, sel) {
  const ta = block.el;
  switch (act) {
    case 'insert-image': {
      // The picture goes in at the caret: the text above it stays above,
      // the text below moves under it.
      const fileInput = document.getElementById('diary-photos');
      pendingInsertFor = block;
      pendingInsertCaret = sel.start;
      ta.focus();
      if (fileInput) fileInput.click();
      break;
    }
    case 'delete-block': {
      const i = pageState.blocks.indexOf(block);
      if (i >= 0) removeBlock(i);
      break;
    }
    case 'cut':
    case 'copy':
      restoreSelection(ta, sel);
      document.execCommand(act);
      break;
    case 'paste':
      pasteIntoTextarea(ta, sel);
      break;
    case 'select-all':
      ta.focus();
      ta.select();
      break;
  }
}

// Put the caret (and the selection) back where it was. The menu's press
// does not move the focus, but a click on the page behind it would.
function restoreSelection(ta, sel) {
  ta.focus();
  try { ta.setSelectionRange(sel.start, sel.end); } catch (err) { /* no selection */ }
}

// Paste the clipboard into a text block at the caret.
//
// The clipboard API is the way in; the browser's own paste command is the
// fallback for the case where it is not available.
async function pasteIntoTextarea(ta, sel) {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    restoreSelection(ta, sel);
    document.execCommand('paste');
    return;
  }
  if (!text) return;
  restoreSelection(ta, sel);
  // insertText keeps the undo stack working; if the browser refuses it,
  // the text is spliced in by hand.
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    ta.value = ta.value.slice(0, sel.start) + text + ta.value.slice(sel.end);
    ta.dispatchEvent(new Event('input'));
  }
}

// Resize a text block to fit its content.
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// One photo inside a gallery. `photoId` is either a saved photo id or a
// pending-upload temp id; `width` is the share of the gallery's width the
// photo takes, or null for "whatever the layout says".
//
// The preview source is a DATA URL, not a blob: URL. The app's CSP is
// `img-src 'self' data: file:` — a blob: URL is blocked, so a
// createObjectURL preview would render as a broken image. Reading the
// picked file into a data URL costs the same round trip the existing
// photo cache already makes, and it works under the CSP.
function makeGalleryPhoto(photoId, name, previewUrl, width) {
  return {
    photoId,
    name: name || '',
    previewUrl: previewUrl || null,
    width: (typeof width === 'number' && isFinite(width) && width > 0) ? width : null,
    el: null,
  };
}

// Build a gallery block. `photos` is a list of gallery photos; the layout
// defaults to one that suits their number.
function makeGalleryBlock(photos, layout) {
  const list = photos || [];
  const block = {
    type: 'gallery',
    layout: layout || defaultLayoutFor(list.length),
    photos: list,
    // The photo the user last picked — the one a drag would move.
    selectedId: list.length ? list[0].photoId : null,
    el: null,
    itemsEl: null,
  };
  buildGalleryEl(block);
  return block;
}

// Build the gallery's DOM: the row of photos. The gallery's controls live
// in a right-click menu, so the pictures stay the only thing on the page.
function buildGalleryEl(block) {
  const fig = document.createElement('figure');
  fig.className = 'diary-block-gallery';

  const items = document.createElement('div');
  items.className = 'diary-gallery-items';
  fig.appendChild(items);

  // Right-clicking the gallery (or one of its pictures) opens its menu.
  fig.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openGalleryMenu(block, e);
  });

  block.el = fig;
  block.itemsEl = items;
  syncGalleryEl(block);
  return fig;
}

// The gallery's menu: the layout switch, the add button, the photo
// counter and the two text insertions. Right-clicking one of the
// pictures adds that picture's own action on top.
function openGalleryMenu(block, e) {
  const itemEl = e.target && e.target.closest
    ? e.target.closest('.diary-gallery-item')
    : null;
  const photo = itemEl ? block.photos.find((p) => p.el === itemEl) : null;

  const items = [];
  if (photo) {
    items.push({ act: 'delete-photo', label: '删除这张图片', danger: true });
    items.push({ sep: true });
  }
  items.push({
    row: DIARY_GALLERY_LAYOUTS.map((l) => ({
      act: 'layout',
      value: l.id,
      label: l.name,
      selected: l.id === block.layout,
    })),
  });
  items.push({ act: 'gallery-add', label: '+ 加图' });
  items.push({ info: true, label: block.photos.length ? `${block.photos.length} 张` : '还没有照片' });
  items.push({ sep: true });
  items.push({ act: 'insert-before', label: '↑ 上方插入文字' });
  items.push({ act: 'insert-after', label: '↓ 下方插入文字' });

  openContextMenu({
    x: e.clientX,
    y: e.clientY,
    items,
    onAction: (act, value) => handleGalleryMenuAction(block, act, value, photo),
  });
}

// Run the action the user picked in a gallery's menu.
function handleGalleryMenuAction(block, act, value, photo) {
  switch (act) {
    case 'layout':
      setGalleryLayout(block, value);
      break;
    case 'gallery-add': {
      pendingGalleryFor = block;
      const fileInput = document.getElementById('diary-photos');
      if (fileInput) fileInput.click();
      break;
    }
    case 'insert-before': {
      const i = pageState.blocks.indexOf(block);
      if (i >= 0) insertBlock(i, makeTextBlock(''));
      break;
    }
    case 'insert-after': {
      const i = pageState.blocks.indexOf(block);
      if (i >= 0) insertBlock(i + 1, makeTextBlock(''));
      break;
    }
    case 'delete-photo':
      if (photo) removeGalleryPhoto(block, photo);
      break;
  }
}

// Build the DOM of one photo in a gallery: the picture, a delete button
// and the handle the user drags to resize it.
function buildGalleryItem(block, photo) {
  const item = document.createElement('div');
  item.className = 'diary-gallery-item';
  item.dataset.photoId = photo.photoId;

  const img = document.createElement('img');
  img.alt = photo.name || '';
  img.loading = 'lazy';
  // An <img> is draggable by default. The browser's own image drag would
  // take the pointer over, and the page would never hear about the drag —
  // so the picture could not be moved.
  img.draggable = false;
  item.appendChild(img);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'photo-x';
  del.title = '删除这张图片';
  del.textContent = '✕';
  del.onclick = (e) => {
    e.stopPropagation();
    removeGalleryPhoto(block, photo);
  };
  // A press on the delete button is not a drag of the photo.
  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  item.appendChild(del);

  const handle = document.createElement('span');
  handle.className = 'diary-gallery-handle';
  handle.title = '拖动调整大小';
  handle.textContent = '↔';
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startGalleryResize(block, photo, e);
  });
  // A drag ends with a click event on the handle — don't let it reach
  // the photo, which would open the lightbox.
  handle.addEventListener('click', (e) => e.stopPropagation());
  item.appendChild(handle);

  // A click selects the photo. The picture is opened full screen on a
  // double click: the lightbox covers the whole page, so it must not open
  // on every click, or the photo could not be picked up again.
  item.onclick = () => {
    if (block.dragging) return;
    selectGalleryPhoto(block, photo);
  };
  item.ondblclick = () => {
    if (block.dragging) return;
    const url = photo.previewUrl || memorialPhotoUrl(photo.photoId);
    if (url) openLightbox(url, photo.name);
  };

  // Pressing a photo starts a drag that reorders the gallery. The drag
  // only begins once the pointer has actually moved, so a plain click
  // still opens the picture.
  item.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    startGalleryReorder(block, photo, e);
  });
  // Nothing in a photo may start a browser drag — that would swallow the
  // pointer and the picture could not be moved.
  item.addEventListener('dragstart', (e) => e.preventDefault());
  return item;
}

// Bring the gallery's DOM in line with the model: drop the photos that
// are gone, put the rest in order, apply their widths and refresh the
// picture sources.
function syncGalleryEl(block) {
  const items = block.itemsEl;
  if (!items) return;
  for (const el of Array.from(items.children)) {
    if (!block.photos.some((p) => p.el === el)) el.remove();
  }
  if (block.selectedId && !block.photos.some((p) => p.photoId === block.selectedId)) {
    block.selectedId = block.photos.length ? block.photos[0].photoId : null;
  }
  block.photos.forEach((photo, i) => {
    if (!photo.el) photo.el = buildGalleryItem(block, photo);
    if (items.children[i] !== photo.el) {
      items.insertBefore(photo.el, items.children[i] || null);
    }
    applyPhotoWidth(block, photo);
    photo.el.classList.toggle('selected', photo.photoId === block.selectedId);
    const img = photo.el.querySelector('img');
    if (!img) return;
    let src = photo.previewUrl || '';
    if (!src) {
      src = memorialPhotoUrl(photo.photoId);
      if (!src && !img.getAttribute('src')) {
        // The bytes aren't cached yet — pull them and swap them in.
        fetchPhotoDataUrl(photo.photoId).then((url) => {
          if (url && img.getAttribute('src') !== url) img.setAttribute('src', url);
        });
      }
    }
    if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
  });
}

// Apply the photo's width to its element: its own size if the user set
// one, the layout's default otherwise.
function applyPhotoWidth(block, photo) {
  if (!photo.el) return;
  const layout = galleryLayout(block.layout) || DIARY_GALLERY_LAYOUTS[1];
  const frac = photo.width != null ? photo.width : layout.width;
  photo.el.style.width = photoCssWidth(frac);
}

// Mark one photo as the selected one — the one a drag would pick up.
function selectGalleryPhoto(block, photo) {
  block.selectedId = photo.photoId;
  for (const p of block.photos) {
    if (p.el) p.el.classList.toggle('selected', p === photo);
  }
}

// Put two photos in each other's places.
function swapGalleryPhotos(block, a, b) {
  const ia = block.photos.indexOf(a);
  const ib = block.photos.indexOf(b);
  if (ia < 0 || ib < 0 || ia === ib) return false;
  block.photos[ia] = b;
  block.photos[ib] = a;
  return true;
}

// The gallery item under a point, if there is one. The rectangles are
// used instead of a hit test, so this works in a window that is not on
// screen too.
function galleryItemAt(items, x, y) {
  for (const el of Array.from(items.children)) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

// A copy of the photo that follows the pointer while it is dragged.
function makeReorderGhost(photo, e) {
  const ghost = document.createElement('div');
  ghost.className = 'diary-gallery-ghost';
  const img = document.createElement('img');
  img.alt = photo.name || '';
  const src = photo.el ? photo.el.querySelector('img').getAttribute('src') : '';
  if (src) img.setAttribute('src', src);
  ghost.appendChild(img);
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  return ghost;
}

// Drag a photo onto another one to swap their places. The photo under
// the pointer follows the cursor, and the gallery swaps the two photos as
// soon as the drag reaches a neighbour.
function startGalleryReorder(block, photo, ev) {
  const items = block.itemsEl;
  if (!items || block.photos.length < 2) return;
  const startX = ev.clientX;
  const startY = ev.clientY;
  let started = false;
  let ghost = null;
  let lastTarget = null;

  const onMove = (e) => {
    if (!started) {
      // A small movement is a click, not a drag.
      if (Math.abs(e.clientX - startX) < 5 && Math.abs(e.clientY - startY) < 5) return;
      started = true;
      block.dragging = true;
      selectGalleryPhoto(block, photo);
      document.body.classList.add('diary-reordering');
      if (photo.el) photo.el.classList.add('reordering');
      ghost = makeReorderGhost(photo, e);
      document.body.appendChild(ghost);
    }
    if (e.cancelable) e.preventDefault();
    if (ghost) {
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
    }
    const target = galleryItemAt(items, e.clientX, e.clientY);
    if (!target || target === photo.el) return;
    if (target.parentElement !== items) return;
    // Only swap when the pointer reaches a new neighbour, otherwise the
    // swap would undo itself right away.
    if (target === lastTarget) return;
    lastTarget = target;
    const other = block.photos.find((p) => p.el === target);
    if (!other) return;
    if (swapGalleryPhotos(block, photo, other)) syncGalleryEl(block);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('diary-reordering');
    if (photo.el) photo.el.classList.remove('reordering');
    if (ghost) { ghost.remove(); ghost = null; }
    if (started) {
      // The drag ends with a click event on the photo — swallow it, so
      // the picture doesn't open in the lightbox.
      block.dragging = true;
      setTimeout(() => { block.dragging = false; }, 0);
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Switch the gallery's arrangement. The layout is the base size, so any
// size the user set by hand is dropped — otherwise the new arrangement
// would not be visible.
function setGalleryLayout(block, layoutId) {
  if (!galleryLayout(layoutId)) return;
  block.layout = layoutId;
  for (const p of block.photos) p.width = null;
  syncGalleryEl(block);
}

// Resize a photo by dragging its handle. The width is a share of the
// gallery's width, so it survives a window resize.
function startGalleryResize(block, photo, ev) {
  const items = block.itemsEl;
  if (!items) return;
  const containerWidth = items.getBoundingClientRect().width || 1;
  const startX = ev.clientX;
  const layout = galleryLayout(block.layout) || DIARY_GALLERY_LAYOUTS[1];
  const startFrac = photo.width != null ? photo.width : layout.width;

  selectGalleryPhoto(block, photo);

  const onMove = (e) => {
    const dx = e.clientX - startX;
    const frac = Math.min(1, Math.max(0.06, startFrac + dx / containerWidth));
    photo.width = Math.round(frac * 1000) / 1000;
    if (photo.el) photo.el.style.width = photoCssWidth(photo.width);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('diary-resizing');
    // The drag ends with a click event on the photo — swallow it.
    block.dragging = true;
    setTimeout(() => { block.dragging = false; }, 0);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  document.body.classList.add('diary-resizing');
}

// Remove one photo from a gallery. The gallery itself goes away when its
// last photo leaves.
function removeGalleryPhoto(block, photo) {
  const idx = block.photos.indexOf(photo);
  if (idx < 0) return;
  block.photos.splice(idx, 1);
  deletePhoto(photo.photoId);
  if (!block.photos.length) {
    const bi = pageState.blocks.indexOf(block);
    if (bi >= 0) pageState.blocks.splice(bi, 1);
  }
  renderBlocks();
}

// Delete the underlying photo file — otherwise it would linger on disk
// with no reference to it.
function deletePhoto(photoId) {
  const pending = pageState.pendingPhotos.find((p) => p.tempId === photoId);
  if (pending) {
    pageState.pendingPhotos = pageState.pendingPhotos.filter((p) => p.tempId !== photoId);
    return;
  }
  api.memorialEvents.photos.delete(photoId)
    .then(() => invalidatePhotoDataUrl(photoId))
    .catch((e) => console.error('photo delete failed:', e));
}

// Read a picked file into a data URL so it can be shown in an <img>.
// The CSP allows data: URLs, which is what the saved photos use too.
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Insert a block into the list at `index` and put it on the page.
function insertBlock(index, block) {
  pageState.blocks.splice(index, 0, block);
  renderBlocks();
  return block;
}

// Remove the block at `index`.
function removeBlock(index) {
  const block = pageState.blocks[index];
  if (!block) return;
  // Deleting a gallery also deletes the photos it holds — otherwise the
  // files would linger on disk with no reference to them.
  if (block.type === 'gallery') {
    for (const photo of block.photos.slice()) deletePhoto(photo.photoId);
  }
  pageState.blocks.splice(index, 1);
  renderBlocks();
}

// Re-render every block into the page. The text blocks keep their live
// <textarea> nodes (they hold the user's cursor position and uncommitted
// IME composition); the galleries keep their DOM too, so a photo that is
// already on screen isn't rebuilt from scratch on every keystroke.
function renderBlocks() {
  const host = document.getElementById('diary-blocks');
  if (!host) return;
  host.innerHTML = '';
  for (const block of pageState.blocks) {
    const wrap = document.createElement('div');
    wrap.className = 'diary-block';
    wrap.dataset.blockType = block.type;
    if (block.type === 'text') {
      // The text block is just the text: its controls live in the
      // right-click menu (see openTextMenu).
      wrap.appendChild(block.el);
    } else {
      syncGalleryEl(block);
      wrap.appendChild(block.el);
    }
    host.appendChild(wrap);
  }
  // An empty document still needs one text block to type into.
  if (pageState.blocks.length === 0) {
    pageState.blocks.push(makeTextBlock(''));
    renderBlocks();
    return;
  }
  // The textareas only have a measurable height once they're in the DOM.
  for (const b of pageState.blocks) {
    if (b.type === 'text') autoGrow(b.el);
  }
}

// Insert a gallery at the caret of a text block, splitting it so the text
// before the caret stays above the pictures and the text after stays
// below. Every picked file lands in the SAME gallery — one insertion
// point can hold any number of photos.
//
// `caretPos` is where the picture goes: the position the user pressed
// at, when the insertion came from the block's right-click menu.
async function insertGalleryAfterTextBlock(textBlock, files, caretPos) {
  const idx = pageState.blocks.indexOf(textBlock);
  if (idx < 0) return;
  const ta = textBlock.el;
  const caret = (typeof caretPos === 'number') ? caretPos : ta.selectionStart;
  const before = ta.value.slice(0, caret);
  const after = ta.value.slice(caret);

  // The upper half keeps the text before the caret.
  textBlock.el.value = before;
  // The gallery goes right after it.
  const photos = await makePendingPhotos(files);
  pageState.blocks.splice(idx + 1, 0, makeGalleryBlock(photos, null));
  // The lower half holds the text that was after the caret.
  pageState.blocks.splice(idx + 2, 0, makeTextBlock(after));
  renderBlocks();

  // Put the caret in the lower half so the user keeps typing where they
  // left off.
  const newTa = pageState.blocks[idx + 2].el;
  newTa.focus();
  newTa.setSelectionRange(0, 0);
}

// Read the picked files into gallery photos and register them as pending
// uploads. The temp id they carry is rewritten to the real photo id once
// the upload succeeds.
async function makePendingPhotos(files) {
  const photos = [];
  for (const file of files) {
    const previewUrl = await fileToDataUrl(file);
    const tempId = 'pending-' + Date.now() + '-' + (++blockSeq);
    pageState.pendingPhotos.push({ file, tempId });
    photos.push(makeGalleryPhoto(tempId, file.name, previewUrl, null));
  }
  return photos;
}

// ---- Page ----------------------------------------------------------------

// Exported so the test harness (scripts/test-diary-editor.js) can drive
// the editor directly, the way the router does.
export async function render(args, params) {
  const app = document.getElementById('app');
  const isNew = !args.id;
  pageState.isNew = isNew;
  pageState.eventId = isNew ? null : args.id;
  pageState.selectedContactIds = new Set();
  pageState.pendingPhotos = [];
  pageState.blocks = [];
  pageState.existingPhotos = [];
  // A pending target from a previous visit to this page would send the
  // next file pick to the wrong place.
  pendingInsertFor = null;
  pendingInsertCaret = null;
  pendingGalleryFor = null;
  // The back link and the post-save navigation follow the page the user
  // actually came from; the memorial list is the fallback.
  pageState.returnTo = getReferrerPath() || MEMORIAL_LIST_ROUTE;

  let ev = {
    kind: 'other',
    title: '',
    notes: '',
    place: '',
    food: '',
    outfit: '',
    activities: '',
    occurred_at: '',
    background: DEFAULT_THEME_ID,
    content: null,
    contact_ids: [],
    photos: [],
  };
  if (!isNew) {
    ev = await api.memorialEvents.get(args.id);
    if (!ev) {
      app.innerHTML = `<div class="empty">这篇回忆不存在或已被删除。</div>`;
      return;
    }
    pageState.existingPhotos = ev.photos || [];
    for (const cid of (ev.contact_ids || [])) pageState.selectedContactIds.add(cid);
  }
  if (params.contact_id) pageState.selectedContactIds.add(params.contact_id);

  const contacts = await api.contacts.list();
  const theme = getDiaryTheme(ev.background || DEFAULT_THEME_ID);
  pageState.background = theme.id;

  const occurredLocal = ev.occurred_at
    ? (ev.occurred_at.length >= 16 ? ev.occurred_at.slice(0, 16) : ev.occurred_at)
    : nowDatetimeLocal();

  const themeVars = diaryThemeVars(theme);

  app.innerHTML = `
    <div class="row between diary-topbar">
      <a class="inline-link" href="#${escapeHtml(pageState.returnTo)}">← 返回列表</a>
      <div class="row" style="gap:8px;">
        ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
        <button class="btn" id="save">保存</button>
      </div>
    </div>

    <div class="diary-layout">
      <!-- The writing surface. Its colors come from the CSS variables the
           theme writes inline, so switching the background repaints the
           page without a re-render. -->
      <div class="diary-page" id="diary-page"
           style="${Object.entries(themeVars).map(([k, v]) => `${k}:${v}`).join(';')}">
        <!-- The header bar carries the title: the user types and edits it
             right there, so the page opens straight on the writing. -->
        <div class="diary-page-header">
          <input type="text" id="diary-title" class="diary-title" maxlength="120"
                 placeholder="标题" value="${escapeHtml(ev.title || '')}" autofocus/>
        </div>
        <div class="diary-page-body">
          <!-- The mixed document: text blocks and galleries, interleaved
               in the order the user arranged them. -->
          <div class="diary-blocks" id="diary-blocks"></div>

          <!-- The file input lives at the end of the page. It is opened
               by the 「插入图片」 action on a text block and by the
               "+ 加图" action on a gallery, so it has no button of its
               own — the picture is always added where the user is
               working. -->
          <input type="file" id="diary-photos" accept="image/*" multiple/>
        </div>
        <!-- The decorative strip at the bottom of the page. It is a layer
             of its own, BELOW the body: the body grows with the text and
             the photos, and the decoration keeps its own height, so a long
             entry never has its pictures or its words sitting on top of
             it. -->
        <div class="diary-page-foot" aria-hidden="true"></div>
      </div>

      <!-- The side panel: the date, the background style and the contacts.
           The date lives here rather than on the writing page itself: the
           page is the writing surface, and the date is a property of the
           entry, not part of the text the user writes. -->
      <aside class="diary-side">
        <section class="card diary-side-card">
          <h2>发生时间</h2>
          <div class="diary-meta-row">
            <input type="datetime-local" id="diary-occurred" value="${escapeHtml(occurredLocal)}"/>
          </div>
        </section>
        <section class="card diary-side-card">
          <h2>背景样式</h2>
          ${themePickerHtml(theme.id)}
        </section>
        <section class="card diary-side-card">
          <h2>关联联系人（可选）</h2>
          ${contactPickerHtml(contacts, pageState.selectedContactIds)}
        </section>
      </aside>
    </div>
  `;

  // Build the document from what was saved (or start empty).
  loadBlocks(ev);

  wireThemePicker();
  wireContactPicker(contacts);
  wirePhotoInput();
  wireDateInputs(app);

  document.getElementById('save').onclick = onSave;
  const delBtn = document.getElementById('del');
  if (delBtn) delBtn.onclick = onDelete;
}

// Rebuild the block list from a saved entry.
//
// `content` is the JSON document written by the diary editor. When it's
// missing (an entry written before the mixed editor existed) we fall back
// to a single text block holding the legacy `notes` body, so old entries
// open in the new editor without losing their text.
//
// Two document shapes are understood:
//   { type: 'gallery', layout, photos: [{ photo_id, width }] }  — current
//   { type: 'image',  photo_id }                                — retired
// The retired shape held a single photo per block; it loads as a
// one-photo gallery so the old entries still open.
function loadBlocks(ev) {
  const blocks = [];
  let parsed = null;
  if (ev.content) {
    try {
      parsed = JSON.parse(ev.content);
    } catch (e) {
      console.error('diary content is not valid JSON:', e);
      parsed = null;
    }
  }
  if (Array.isArray(parsed) && parsed.length) {
    for (const b of parsed) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        blocks.push(makeTextBlock(typeof b.text === 'string' ? b.text : ''));
      } else if (b.type === 'gallery') {
        const gallery = makeGalleryBlock(loadGalleryPhotos(b), galleryLayout(b.layout) ? b.layout : 'two');
        if (gallery.photos.length) blocks.push(gallery);
      } else if (b.type === 'image' && typeof b.photo_id === 'string') {
        const photo = pageState.existingPhotos.find((p) => p.id === b.photo_id);
        blocks.push(makeGalleryBlock(
          [makeGalleryPhoto(b.photo_id, photo ? photo.original_name : '', null, null)],
          'one'
        ));
      }
    }
  } else if (ev.notes) {
    blocks.push(makeTextBlock(ev.notes));
  }
  if (!blocks.length) blocks.push(makeTextBlock(''));
  pageState.blocks = blocks;
  renderBlocks();
}

// Read the photos of a saved gallery, with their names and sizes.
function loadGalleryPhotos(b) {
  const photos = [];
  for (const p of (Array.isArray(b.photos) ? b.photos : [])) {
    if (!p || typeof p !== 'object' || typeof p.photo_id !== 'string' || !p.photo_id) continue;
    const meta = pageState.existingPhotos.find((x) => x.id === p.photo_id);
    photos.push(makeGalleryPhoto(
      p.photo_id,
      meta ? meta.original_name : '',
      null,
      typeof p.width === 'number' && isFinite(p.width) && p.width > 0 ? p.width : null
    ));
  }
  return photos;
}

// Repaint the writing surface when the user picks a different background.
function wireThemePicker() {
  const page = document.getElementById('diary-page');
  document.querySelectorAll('.diary-theme-tile').forEach((tile) => {
    tile.onclick = () => {
      const t = getDiaryTheme(tile.dataset.themeId);
      pageState.background = t.id;
      const vars = diaryThemeVars(t);
      for (const [k, v] of Object.entries(vars)) page.style.setProperty(k, v);
      document.querySelectorAll('.diary-theme-tile').forEach((el) => {
        el.classList.toggle('selected', el === tile);
      });
    };
  });
}

function wireContactPicker(contacts) {
  const picker = document.getElementById('diary-contact-picker');
  const countEl = document.getElementById('diary-contacts-count');
  if (!picker) return;

  function refresh() {
    picker.querySelectorAll('.contact-pick').forEach((el) => {
      el.classList.toggle('selected', pageState.selectedContactIds.has(el.dataset.id));
    });
    if (countEl) {
      countEl.textContent = pageState.selectedContactIds.size === 0
        ? '未选'
        : `已选 ${pageState.selectedContactIds.size} 人`;
    }
  }
  picker.querySelectorAll('.contact-pick').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.id;
      if (!id) return;
      if (pageState.selectedContactIds.has(id)) pageState.selectedContactIds.delete(id);
      else pageState.selectedContactIds.add(id);
      refresh();
    };
  });
  const allBtn = document.getElementById('diary-contacts-all');
  if (allBtn) allBtn.onclick = () => {
    contacts.forEach((c) => pageState.selectedContactIds.add(c.id));
    refresh();
  };
  const noneBtn = document.getElementById('diary-contacts-none');
  if (noneBtn) noneBtn.onclick = () => {
    pageState.selectedContactIds.clear();
    refresh();
  };
  refresh();
}

// ---- Photos --------------------------------------------------------------

// The text block whose 「插入图片」 action was picked. When set, the next
// file pick is inserted AT THE CARET inside that block (splitting it).
let pendingInsertFor = null;

// Where in that block the picture goes: the position the user pressed at
// when the action came from the block's right-click menu.
let pendingInsertCaret = null;

// The gallery whose "+ 加图" action was picked. When set, the next file
// pick joins that gallery instead of starting a new one.
let pendingGalleryFor = null;

// The shared file picker. It is opened by the 「插入图片」 action on a text
// block and by the "+ 加图" action on a gallery, so the picture always
// lands where the user is working.
function wirePhotoInput() {
  const fileInput = document.getElementById('diary-photos');

  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files || []);
    // Reset the input so picking the same file twice in a row still
    // fires a change event.
    fileInput.value = '';
    if (!files.length) return;

    // "+ 加图" on a gallery: the picked photos join that gallery, so one
    // insertion point can hold any number of pictures.
    if (pendingGalleryFor) {
      const target = pendingGalleryFor;
      pendingGalleryFor = null;
      await addPhotosToGallery(target, files);
      return;
    }

    // 「插入图片」 on a text block: split the block at the caret and drop
    // the gallery in between. Every picked file goes into that one
    // gallery.
    if (pendingInsertFor) {
      const target = pendingInsertFor;
      const caret = pendingInsertCaret;
      pendingInsertFor = null;
      pendingInsertCaret = null;
      await insertGalleryAfterTextBlock(target, files, caret);
      return;
    }

    // No target: the picker was opened some other way. Put the gallery
    // at the end of the document.
    const photos = await makePendingPhotos(files);
    insertBlock(pageState.blocks.length, makeGalleryBlock(photos, null));
  };
}

// Add picked photos to an existing gallery.
async function addPhotosToGallery(block, files) {
  const photos = await makePendingPhotos(files);
  for (const photo of photos) block.photos.push(photo);
  renderBlocks();
}

// ---- Serialize -----------------------------------------------------------

// Turn the live blocks into the JSON document shape the server stores.
function serializeBlocks() {
  const out = [];
  for (const block of pageState.blocks) {
    if (block.type === 'text') {
      const text = block.el.value || '';
      if (text.length) out.push({ type: 'text', text });
    } else if (block.type === 'gallery') {
      const photos = block.photos.map((p) => {
        const item = { photo_id: p.photoId };
        // Only a size the user set by hand is stored — a photo that
        // still follows the layout needs no width of its own.
        if (typeof p.width === 'number') {
          item.width = Math.round(p.width * 1000) / 1000;
        }
        return item;
      });
      if (photos.length) {
        out.push({ type: 'gallery', layout: block.layout, photos });
      }
    }
  }
  return out;
}

// The plain-text body. The search index and the album export both read
// the `notes` column, so the document's words have to be mirrored there
// or a mixed-content diary would become unfindable.
function plainTextFromBlocks() {
  return pageState.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.el.value || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---- Save / delete -------------------------------------------------------

async function onSave() {
  const title = (document.getElementById('diary-title').value || '').trim();
  const body = plainTextFromBlocks();
  const occurredRaw = document.getElementById('diary-occurred').value;

  if (!title && !body) {
    toast('请至少填写标题或正文');
    return;
  }
  if (!occurredRaw) {
    toast('请填写发生时间');
    return;
  }

  const payload = {
    kind: 'other',
    title: title || '回忆事件',
    // The plain text lives in `notes` (search + album export read it);
    // the interleaved document lives in `content`.
    notes: body || null,
    content: serializeBlocks(),
    occurred_at: occurredRaw.replace('T', ' ') + ':00',
    background: pageState.background,
    contact_ids: Array.from(pageState.selectedContactIds),
  };

  const saveBtn = document.getElementById('save');
  if (saveBtn) saveBtn.disabled = true;

  let saved;
  try {
    saved = pageState.isNew
      ? await api.memorialEvents.create(payload)
      : await api.memorialEvents.update(pageState.eventId, payload);
  } catch (e) {
    toast((e && e.message) || '保存失败');
    if (saveBtn) saveBtn.disabled = false;
    return;
  }

  // Upload the newly picked photos and rewrite the document so the
  // pending temp ids become real photo ids. Each upload is independent —
  // one failure doesn't roll the entry back — but we report a count so
  // the user knows something went wrong.
  const pending = pageState.pendingPhotos.slice();
  if (pending.length) {
    let okCount = 0;
    let failCount = 0;
    for (const p of pending) {
      if (p.file.size > 20 * 1024 * 1024) {
        toast(`照片 ${p.file.name} 超过 20MB，已跳过`);
        failCount += 1;
        continue;
      }
      try {
        const ab = await p.file.arrayBuffer();
        const photo = await api.memorialEvents.photos.upload(saved.id, {
          filename: p.file.name,
          mime: p.file.type,
          bytes: ab,
        });
        // Point the gallery at the saved photo.
        for (const block of pageState.blocks) {
          if (block.type !== 'gallery') continue;
          for (const item of block.photos) {
            if (item.photoId === p.tempId) item.photoId = photo.id;
          }
        }
        okCount += 1;
      } catch (e) {
        console.error('photo upload failed:', e);
        failCount += 1;
      }
    }
    if (failCount > 0 && okCount === 0) toast(`照片上传失败（${failCount} 张）`);
    else if (failCount > 0) toast(`已上传 ${okCount} 张，${failCount} 张失败`);

    // Write the document again with the real photo ids.
    if (okCount > 0) {
      try {
        await api.memorialEvents.update(saved.id, { content: serializeBlocks() });
      } catch (e) {
        toast('图片顺序保存失败：' + ((e && e.message) || e));
      }
    }
  }

  // The pending photos are uploaded now, so the preview list is done.
  pageState.pendingPhotos = [];

  toast(pageState.isNew ? '已保存' : '已更新');
  navigate(pageState.returnTo);
}

async function onDelete() {
  if (!confirm('确认删除这篇回忆？\n\n关联的照片会一起被删除，此操作不可撤销。')) return;
  try {
    await api.memorialEvents.delete(pageState.eventId);
  } catch (e) {
    toast('删除失败：' + ((e && e.message) || e));
    return;
  }
  pageState.pendingPhotos = [];
  toast('已删除');
  navigate(pageState.returnTo);
}

register('/diary/new', render);
register('/diary/:id', render);
