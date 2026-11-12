// src/js/pages/diary_edit.js — the diary editor for 回忆.
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
//
// ---- Where the metadata lives ----
//
// The paper holds the writing and nothing else. The three pieces of
// metadata that are NOT part of the writing — 事件发生时间 / 关联联系人 /
// 事件分类 — used to sit in the side panel, but that made the user reach
// for the right-hand column to finish an entry that was already written.
//
// Now they are asked for in a dialog when the user presses 保存: the press
// is the moment the entry becomes a record, and a record has a time, a
// cast and a 分类. The dialog lives in
// src/js/diary_meta_form.js.

import {
  api, escapeHtml, toast,
  memorialPhotoUrl, fetchPhotoDataUrl, invalidatePhotoDataUrl,
  wireDateInputs,
} from '../api.js';
import { register, navigate, getReferrerPath } from '../router.js';
import { openContextMenu } from '../context_menu.js';
import {
  DIARY_THEMES, DEFAULT_THEME_ID, getDiaryTheme, diaryThemeVars,
} from '../diary_themes.js';
import {
  DIARY_GALLERY_LAYOUTS, galleryLayout, defaultLayoutFor, photoCssWidth,
  parseDiaryContent,
} from '../diary_layout.js';
import {
  COVER_RATIOS, DEFAULT_COVER_RATIO, coverFrameStyle, coverRect,
  coverAspectRatio, defaultCover, normalizeCover,
} from '../diary_cover.js';
import { openMemorialMetaDialog } from '../diary_meta_form.js';
import { openAudioRecorderDialog } from '../diary_audio_recorder.js';
import { normalizeMemorialKind } from '../diary_kinds.js';

const MEMORIAL_LIST_ROUTE = '/events/memorial';

// The state of the page currently on screen. Kept at module scope so a
// failed save doesn't lose what the user typed, and so the photo upload
// pass can find the blocks it needs to rewrite.
const pageState = {
  isNew: true,
  eventId: null,
  background: DEFAULT_THEME_ID,
  selectedContactIds: new Set(),
  // The metadata that the 保存 dialog owns: when it happened, whether it
  // was the first time, and who was there. It is not on the page — the
  // dialog asks for it every time the user presses 保存, and the values
  // it returns become the next round's defaults.
  occurredAt: '',
  kind: 'other',
  // The mixed document. `blocks[i].el` points at the live DOM node for
  // that block (the text block's textarea, the gallery's figure).
  blocks: [],
  // Photos the user picked but that aren't uploaded yet. Each entry is
  // { file, tempId }. A gallery photo referring to a tempId is rewritten
  // to the real photo id once the upload succeeds.
  pendingPhotos: [],
  // A movie or a sound the user picked but that isn't uploaded yet. Each
  // entry is { file, tempId, kind }. A media block referring to a tempId
  // is rewritten to the real media id once the upload succeeds.
  pendingMedia: [],
  existingPhotos: [],
  returnTo: MEMORIAL_LIST_ROUTE,
  // The 抽卡 card this entry was started from (null for every entry
  // that was not opened from a drawn card). It carries the card's title
  // and requirement into the page, and it is linked back to the card once
  // the entry is saved.
  draw: null,
  // Removes the document-level listeners the theme picker's popover adds.
  // The page is re-rendered on every navigation, and a listener left
  // behind would close a picker that is no longer on screen.
  cleanupThemePicker: null,
};

// ---- Theme picker --------------------------------------------------------
//
// The six background styles used to sit in an always-open panel beside
// the writing surface. That crowded the page for a choice the user makes
// once and then never touches again.
//
// Now the panel is ONE button: it shows the style in use — a miniature
// of the page and the style's name — and pressing it opens the six
// previews in a popover underneath. Picking a style closes the popover
// again, so the page goes straight back to writing.

// The miniature page on the collapsed button. It is painted in the same
// three layers the real page is: the header bar, the body and the
// decorative strip.
function themeThumbHtml(theme) {
  return `
    <span class="diary-theme-thumb"
          style="--theme-header:${escapeHtml(theme.headerBg)};
                 --theme-top:${escapeHtml(theme.bgTop)};
                 --theme-mid:${escapeHtml(theme.bgMid)}">
      <span class="diary-theme-thumb-bar"></span>
      <span class="diary-theme-thumb-body"></span>
      <span class="diary-theme-thumb-foot"></span>
    </span>
  `;
}

// The collapsed button. It carries the style that is in use.
function themeToggleHtml(theme) {
  return `
    <button type="button" class="diary-theme-toggle" id="diary-theme-toggle"
            aria-expanded="false" aria-controls="diary-theme-pop">
      ${themeThumbHtml(theme)}
      <span class="diary-theme-toggle-label">
        <span class="diary-theme-toggle-title" id="diary-theme-current">${escapeHtml(theme.name)}</span>
      </span>
      <span class="diary-theme-chevron" aria-hidden="true"></span>
    </button>
  `;
}

// The six background style tiles. Each tile previews the style
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

// ---- The cover editor ----------------------------------------------------
//
// Clicking a picture opens the REAL picture — the whole file, uncropped —
// so the user can pick the part of it the gallery should show.
//
// On the picture sits the FRAME: the rectangle the gallery will show. It
// has one of the three allowed shapes, and it can be dragged anywhere and
// scaled with the wheel. The three buttons in the corner change its
// shape; 保存 hands the frame back to the gallery.
//
// The frame's numbers are relative — where its centre sits in the
// picture (0..1) and how much of the picture it covers — so the same
// frame works at every size the picture is drawn at.
//
// One element, reopened by swapping the picture and the frame's numbers.

let coverEl = null;

// Open the cover editor for one photo of a gallery.
//
// The picture may not be in the page yet — its bytes are fetched on the
// spot — so the editor opens once they are here.
async function openCoverEditor(block, photo) {
  const url = photo.previewUrl || memorialPhotoUrl(photo.photoId);
  if (!url) {
    const fetched = await fetchPhotoDataUrl(photo.photoId);
    if (!fetched) {
      toast('图片读不出来');
      return;
    }
    openCoverEditorWith(block, photo, fetched);
    return;
  }
  openCoverEditorWith(block, photo, url);
}

function openCoverEditorWith(block, photo, url) {
  const el = ensureCoverEl();

  // The frame the editor starts from: the photo's own cover, or the
  // default mapping for its shape.
  const start = photo.cover || defaultCoverFor(photo);
  const state = {
    block,
    photo,
    url,
    cover: { ratio: start.ratio, x: start.x, y: start.y, zoom: start.zoom },
    // The picture's own size, learned when it is decoded.
    picW: photo.naturalW || 0,
    picH: photo.naturalH || 0,
  };

  el.querySelector('.cover-editor-img').src = url;
  el.querySelector('.cover-editor-img').alt = photo.name || '';
  el.querySelector('.cover-editor-title').textContent = photo.name || '';
  el.classList.add('open');

  const img = el.querySelector('.cover-editor-img');
  const onLoad = () => {
    state.picW = img.naturalWidth || state.picW;
    state.picH = img.naturalHeight || state.picH;
    // A photo whose size was unknown when the editor opened gets its
    // default mapping now that the size is known.
    if (!photo.cover && state.picW && state.picH) {
      state.cover = defaultCover(state.picW, state.picH);
    }
    renderCoverEditor(el, state);
  };
  if (img.complete && img.naturalWidth) onLoad();
  else {
    img.addEventListener('load', onLoad, { once: true });
    // The bytes may already be in the cache, so the image may already be
    // there without a new load event.
    setTimeout(onLoad, 0);
  }
  // The frame is dragged and the wheel zooms it. The listeners are bound
  // once — the editor element is built once — and they act on the state
  // of the picture that is open.
  if (!coverEl.dataset.dragBound) {
    coverEl.dataset.dragBound = '1';
    bindCoverDrag(coverEl);
  }
  renderCoverEditor(el, state);
}

// Build the editor's DOM once.
function ensureCoverEl() {
  if (coverEl) return coverEl;
  coverEl = document.createElement('div');
  coverEl.id = 'cover-editor';
  coverEl.className = 'cover-editor';
  coverEl.innerHTML = `
    <div class="cover-editor-card">
      <div class="cover-editor-head">
        <span class="cover-editor-title"></span>
        <button type="button" class="cover-editor-x" title="关闭">✕</button>
      </div>
      <div class="cover-editor-stage">
        <img class="cover-editor-img" alt=""/>
        <div class="cover-editor-frame"></div>
      </div>
      <div class="cover-editor-foot">
        <div class="cover-editor-ratios"></div>
        <div class="cover-editor-actions">
          <button type="button" class="btn cover-editor-reset">重置</button>
          <button type="button" class="btn cover-editor-cancel">取消</button>
          <button type="button" class="btn primary cover-editor-save">保存封面</button>
        </div>
      </div>
      <div class="cover-editor-hint">拖动取景框移动画面 · 滚轮缩放 · 取景框只在原图有富余的方向上移动</div>
    </div>
  `;
  document.body.appendChild(coverEl);

  // The shape buttons — one per allowed ratio.
  const ratios = coverEl.querySelector('.cover-editor-ratios');
  ratios.innerHTML = COVER_RATIOS.map((r) => `
    <button type="button" class="cover-editor-ratio" data-ratio="${escapeHtml(r.id)}"
            title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>
  `).join('');

  coverEl.addEventListener('click', (e) => {
    if (e.target === coverEl) closeCoverEditor();
  });
  coverEl.querySelector('.cover-editor-x').onclick = () => closeCoverEditor();
  coverEl.querySelector('.cover-editor-cancel').onclick = () => closeCoverEditor();
  coverEl.querySelector('.cover-editor-save').onclick = () => saveCoverEditor();
  coverEl.querySelector('.cover-editor-reset').onclick = () => resetCoverEditor();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && coverEl.classList.contains('open')) closeCoverEditor();
  });
  return coverEl;
}

// The editor's state, kept on the element so the listeners below can
// reach it.
let coverState = null;

// Draw the editor: the frame on the picture, the shape buttons.
function renderCoverEditor(el, state) {
  coverState = state;
  const img = el.querySelector('.cover-editor-img');
  const frame = el.querySelector('.cover-editor-frame');
  const stage = el.querySelector('.cover-editor-stage');
  // The picture's own size. A picture that has not been decoded yet has
  // no size — a placeholder shape stands in for it so the frame has
  // something to lie on.
  const picW = state.picW || img.naturalWidth || 800;
  const picH = state.picH || img.naturalHeight || 600;

  // The picture is drawn in the stage, scaled to fit it. The picture is
  // shown as large as the stage allows — the user is picking a part of
  // it, and the smaller it is drawn the harder that is to do.
  const stageRect = stage.getBoundingClientRect();
  const scale = Math.min(stageRect.width / picW, stageRect.height / picH) || 1;
  const dispW = picW * scale;
  const dispH = picH * scale;
  img.style.width = dispW + 'px';
  img.style.height = dispH + 'px';

  // The frame on the drawn picture — the very rectangle the frame shows,
  // so what the user moves is what they get.
  const rect = coverRect(picW, picH, state.cover);
  const fw = rect.width * scale;
  const fh = rect.height * scale;

  frame.style.width = fw + 'px';
  frame.style.height = fh + 'px';
  // The stage is the positioning context; the picture is centred in it.
  frame.style.left = (stage.clientWidth - dispW) / 2 + rect.left * scale + 'px';
  frame.style.top = (stage.clientHeight - dispH) / 2 + rect.top * scale + 'px';

  // The shape buttons show which shape is in use.
  for (const btn of el.querySelectorAll('.cover-editor-ratio')) {
    btn.classList.toggle('selected', btn.dataset.ratio === state.cover.ratio);
  }
}

// Move the frame with the pointer. The frame is dragged; the picture
// stays where it is.
//
// The frame's TOP-LEFT corner is what follows the pointer — the user
// pushes the frame itself, not the middle of it. The stored cover keeps
// the frame's CENTRE, so the corner is turned back into a centre after
// every move.
//
// The listeners are bound once — the editor element is built once — and
// they act on the picture that is open, which is `coverState`.
function bindCoverDrag(el) {
  const frame = el.querySelector('.cover-editor-frame');
  const stage = el.querySelector('.cover-editor-stage');
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onDown = (e) => {
    const state = coverState;
    if (!state) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = coverRect(state.picW || 800, state.picH || 600, state.cover);
    startLeft = rect.left;
    startTop = rect.top;
    frame.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onMove = (e) => {
    const state = coverState;
    if (!dragging || !state) return;
    const img = el.querySelector('.cover-editor-img');
    const dispW = img.offsetWidth || 1;
    const dispH = img.offsetHeight || 1;
    const picW = state.picW || 800;
    const picH = state.picH || 600;
    const rect = coverRect(picW, picH, state.cover);
    const left = startLeft + (e.clientX - startX) / dispW * picW;
    const top = startTop + (e.clientY - startY) / dispH * picH;
    state.cover.x = (left + rect.width / 2) / picW;
    state.cover.y = (top + rect.height / 2) / picH;
    renderCoverEditor(el, state);
  };

  const onUp = () => {
    dragging = false;
    frame.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  frame.addEventListener('pointerdown', onDown);

  // The wheel zooms the frame in and out around its centre.
  const onWheel = (e) => {
    const state = coverState;
    if (!state) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    state.cover.zoom = clampNum(state.cover.zoom * (dir > 0 ? 1.1 : 1 / 1.1),
      state.cover.zoom, 1, 4);
    renderCoverEditor(el, state);
  };
  stage.addEventListener('wheel', onWheel, { passive: false });

  // The shape buttons.
  for (const btn of el.querySelectorAll('.cover-editor-ratio')) {
    btn.onclick = () => {
      const state = coverState;
      if (!state) return;
      state.cover.ratio = btn.dataset.ratio;
      // Switching the shape keeps the frame's centre: the picture stays
      // where the user put it.
      renderCoverEditor(el, state);
    };
  }
}

// Put the frame back to the default mapping for the picture's shape.
function resetCoverEditor() {
  const el = coverEl;
  const state = coverState;
  if (!el || !state) return;
  if (state.picW && state.picH) {
    state.cover = defaultCover(state.picW, state.picH);
  } else {
    state.cover = { ratio: DEFAULT_COVER_RATIO, x: 0.5, y: 0.5, zoom: 1 };
  }
  renderCoverEditor(el, state);
}

// Hand the frame back to the gallery and close the editor.
function saveCoverEditor() {
  const el = coverEl;
  const state = coverState;
  if (!el || !state) return;
  state.photo.cover = normalizeCover(state.cover);
  applyPhotoCover(state.photo);
  closeCoverEditor();
}

function closeCoverEditor() {
  if (!coverEl) return;
  coverEl.classList.remove('open');
  coverState = null;
}

function clampNum(v, fallback, min, max) {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
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
//
// The layout table and the width math live in src/js/diary_layout.js —
// the 回忆 list draws the same galleries inside its cards, and the two
// have to agree on what "双图" means.

const DEFAULT_GALLERY_LAYOUT_FALLBACK = DIARY_GALLERY_LAYOUTS[1];

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
// EVERY block carries the SAME insertions: a paragraph, a picture, a
// movie, a sound — above or below the block that was pressed. That was
// not always so: a text block could only hold pictures, a gallery could
// only hold text, and a media block could do both. The result was a
// document the user could not shape — a picture could not follow a
// picture, and a paragraph could not be dropped under a gallery.
//
// So the insertions are built ONCE (insertionMenuItems) and every menu
// uses them. The block's own business — the editing commands of a
// paragraph, the layout switch of a gallery, the player commands of a
// movie — sits around them.
//
// The caret is captured when the menu opens so the editing commands
// (剪切 / 复制 / 粘贴) act on the text the user pointed at. The inserted
// block does NOT land at the caret: it goes above or below the whole
// block, so the paragraph is never cut in two.

// The kinds of block that can be inserted.
const INSERT_KINDS = [
  { kind: 'text', label: '文字' },
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'audio', label: '音频' },
];

// The insertions every block's menu carries.
//
// Each kind of block has two doors: one above the pressed block and one
// below it. The two are asked for in one go, so the menu reads as a
// choice of WHAT to put in and WHERE to put it.
//
// A sound has a third door: a recording made right now, instead of a
// file from the disk. It lands in the same places.
function insertionMenuItems() {
  const items = [];
  for (const k of INSERT_KINDS) {
    items.push({
      wide: true,
      row: [
        { act: 'insert-' + k.kind, value: 'before', label: '↑ ' + k.label },
        { act: 'insert-' + k.kind, value: 'after', label: '↓ ' + k.label },
      ],
    });
  }
  items.push({
    wide: true,
    row: [
      { act: 'record-audio', value: 'before', label: '↑ 录音' },
      { act: 'record-audio', value: 'after', label: '↓ 录音' },
    ],
  });
  return items;
}

// The menu of a text block: the insertions every block carries, plus the
// editing commands the browser's own right-click menu would have offered
// (the custom menu replaces it, so they have to be here).
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
      ...insertionMenuItems(),
      { sep: true },
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
    case 'insert-text':
    case 'insert-image':
    case 'insert-video':
    case 'insert-audio':
    case 'record-audio': {
      // The insertion goes above or below the whole block, never at the
      // caret: the words the user wrote stay one unbroken piece.
      ta.focus();
      // A recording is a sound that was made instead of picked, so it
      // lands where a picked sound would.
      const kind = act === 'record-audio' ? 'audio' : act.slice('insert-'.length);
      startInsertion(block, kind, value, act === 'record-audio');
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
// `cover` is the rectangle of the picture the photo's frame shows — see
// src/js/diary_cover.js. It is null until the picture's own shape is
// known; the default mapping is worked out then.
//
// `naturalW` / `naturalH` are the picture's own size, learned when its
// bytes are in the page. They are what the default mapping and the
// cover editor work from.
//
// The preview source is a DATA URL, not a blob: URL. The app's CSP is
// `img-src 'self' data: file:` — a blob: URL is blocked, so a
// createObjectURL preview would render as a broken image. Reading the
// picked file into a data URL costs the same round trip the existing
// photo cache already makes, and it works under the CSP.
function makeGalleryPhoto(photoId, name, previewUrl, width, cover) {
  return {
    photoId,
    name: name || '',
    previewUrl: previewUrl || null,
    width: (typeof width === 'number' && isFinite(width) && width > 0) ? width : null,
    cover: normalizeCover(cover),
    naturalW: 0,
    naturalH: 0,
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
// counter and the insertions every block carries. Right-clicking one of
// the pictures adds that picture's own action on top.
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
  items.push(...insertionMenuItems());

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
    case 'insert-text':
    case 'insert-image':
    case 'insert-video':
    case 'insert-audio':
    case 'record-audio': {
      const kind = act === 'record-audio' ? 'audio' : act.slice('insert-'.length);
      startInsertion(block, kind, value, act === 'record-audio');
      break;
    }
    case 'delete-photo':
      if (photo) removeGalleryPhoto(block, photo);
      break;
  }
}

// Build the DOM of one photo in a gallery: the frame, the picture inside
// it, a delete button and the handle the user drags to resize it.
//
// The FRAME is the picture's shape — one of the three allowed ratios —
// and the picture inside it is drawn to COVER the frame. The frame is
// what fills the row: pictures of different shapes sit side by side
// without leaving a hole between them, because every frame is a
// rectangle and the picture fills its own.
function buildGalleryItem(block, photo) {
  const item = document.createElement('div');
  item.className = 'diary-gallery-item';
  item.dataset.photoId = photo.photoId;

  const frame = document.createElement('div');
  frame.className = 'diary-gallery-frame';
  item.appendChild(frame);

  const img = document.createElement('img');
  img.alt = photo.name || '';
  img.loading = 'lazy';
  // An <img> is draggable by default. The browser's own image drag would
  // take the pointer over, and the page would never hear about the drag —
  // so the picture could not be moved.
  img.draggable = false;
  // The picture's own size arrives with the bytes. It is what the
  // default mapping is worked out from.
  img.addEventListener('load', () => learnPhotoSize(photo, img));
  frame.appendChild(img);

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
    openCoverEditor(block, photo);
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

// The frame's shape, and the mapping of the picture inside it.
//
// The frame's ratio is the photo's own cover — the one the user picked,
// or the default mapping worked out from the picture's shape.
function applyPhotoCover(photo) {
  if (!photo.el) return;
  const frame = photo.el.querySelector('.diary-gallery-frame');
  const img = photo.el.querySelector('img');
  if (!frame || !img) return;

  const cover = photo.cover || defaultCoverFor(photo);
  frame.style.aspectRatio = coverAspectRatio(cover.ratio);
  frame.dataset.ratio = cover.ratio;

  // The picture is drawn so that it fills the frame, with the cover's
  // part of it showing. Without the picture's own size the mapping
  // cannot be placed, so the picture is drawn plain until it is known.
  if (photo.naturalW && photo.naturalH) {
    // The frame's OWN size, in the page's own units.
    const style = coverFrameStyle(photo.naturalW, photo.naturalH, cover,
      frame.clientWidth, frame.clientHeight);
    if (style) {
      img.style.width = style.imgWidth + 'px';
      img.style.height = style.imgHeight + 'px';
      img.style.left = style.imgLeft + 'px';
      img.style.top = style.imgTop + 'px';
      return;
    }
  }
  img.style.width = '';
  img.style.height = '';
  img.style.left = '';
  img.style.top = '';
}

// The cover a photo shows when the user has not chosen one: the closest
// allowed ratio, centred, at the widest zoom.
//
// A picture whose size is not known yet gets the default ratio — the
// mapping is worked out again as soon as the bytes are in the page.
function defaultCoverFor(photo) {
  if (photo.naturalW && photo.naturalH) return defaultCover(photo.naturalW, photo.naturalH);
  return { ratio: DEFAULT_COVER_RATIO, x: 0.5, y: 0.5, zoom: 1 };
}

// Learn the picture's own size once its bytes are in the page, and work
// out its default mapping the first time.
function learnPhotoSize(photo, img) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  if (photo.naturalW === img.naturalWidth && photo.naturalH === img.naturalHeight) return;
  photo.naturalW = img.naturalWidth;
  photo.naturalH = img.naturalHeight;
  // A photo the user has not given a cover of its own gets the default
  // mapping for its shape.
  if (!photo.cover) photo.cover = defaultCover(photo.naturalW, photo.naturalH);
  applyPhotoCover(photo);
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
    applyPhotoCover(photo);
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
    // The picture's own size is what the mapping is worked out from. It
    // is known once the bytes are decoded.
    if (img.complete && img.naturalWidth) learnPhotoSize(photo, img);
  });
}

// Apply the photo's width to its element: its own size if the user set
// one, the layout's default otherwise.
function applyPhotoWidth(block, photo) {
  if (!photo.el) return;
  const layout = galleryLayout(block.layout) || DEFAULT_GALLERY_LAYOUT_FALLBACK;
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
  // The ghost sits under the pointer. An <img> is draggable by default,
  // and the browser's own image drag would take the gesture over — it
  // ends the page's drag with a synthetic pointerup and the picture
  // would snap back. So the ghost's picture is not draggable either.
  img.draggable = false;
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
//
// The photo's drag belongs to the GALLERY. A drag that walks out of the
// gallery is not a photo drag any more — the user is carrying the whole
// block away — so the gallery hands the gesture over and stops.
function startGalleryReorder(block, photo, ev) {
  const items = block.itemsEl;
  if (!items || block.photos.length < 2) return;
  const startX = ev.clientX;
  const startY = ev.clientY;
  let started = false;
  let ghost = null;
  let lastTarget = null;

  // Give the gesture back: the listeners come off, the ghost goes away
  // and the gallery looks as it did.
  const stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('diary-reordering');
    if (photo.el) photo.el.classList.remove('reordering');
    if (ghost) { ghost.remove(); ghost = null; }
    // The gallery is not "being dragged" any more, so a click on one of
    // its photos works again.
    block.dragging = false;
    started = false;
  };

  const onMove = (e) => {
    // The pointer left the gallery: the block takes the gesture over.
    if (!galleryHasPoint(block, e.clientX, e.clientY)) {
      stop();
      return;
    }
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
    const wasDragging = started;
    stop();
    if (wasDragging) {
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

// Is a point inside the gallery? The rectangles are used instead of a
// hit test, so this works in a window that is not on screen too.
function galleryHasPoint(block, x, y) {
  const el = block && block.el;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
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
  const layout = galleryLayout(block.layout) || DEFAULT_GALLERY_LAYOUT_FALLBACK;
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
//
// A movie or a sound is deleted the same way: its file lives in the same
// place a picture's does, and a file the user has not saved yet is only
// dropped from the pending list.
function deletePhoto(photoId) {
  const pending = pageState.pendingPhotos.find((p) => p.tempId === photoId);
  if (pending) {
    pageState.pendingPhotos = pageState.pendingPhotos.filter((p) => p.tempId !== photoId);
    return;
  }
  const pendingMedia = pageState.pendingMedia.find((m) => m.tempId === photoId);
  if (pendingMedia) {
    pageState.pendingMedia = pageState.pendingMedia.filter((m) => m.tempId !== photoId);
    return;
  }
  api.memorialEvents.photos.delete(photoId)
    .then(() => invalidatePhotoDataUrl(photoId))
    .catch((e) => console.error('photo delete failed:', e));
}

// ---- Media blocks --------------------------------------------------------
//
// A VIDEO and an AUDIO are the other two things the user can put into the
// writing, beside the words and the pictures.
//
// They are not galleries: a gallery holds any number of pictures laid out
// in rows, but a movie is one file that plays, and a sound is one file
// that plays. So each is a block of its own:
//
//   { type: 'video', media_id, poster_id, width }
//   { type: 'audio', media_id }
//
// The file itself lives in the same `memorial_event_photos` table as the
// pictures — the row's `mime` says which it is — so deleting the entry
// takes the movie with it, and the file lands on disk in the same place.
//
// The bytes are NOT read into a data URL the way a picture's are. A movie
// is tens of megabytes: base64 would grow it by a third and push it
// through the IPC as a string. Instead the <video>/<audio> element is
// pointed straight at the file on disk, which the CSP allows for media.

// The biggest movie or sound the editor will upload. A picture's ceiling
// is 20MB; a movie is allowed more room, but not an endless amount — a
// two-gigabyte video would stall the save and fill the disk.
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

// Build a video block. `mediaId` is a saved media id or a pending-upload
// temp id; `width` is the share of the page's width the player takes.
function makeVideoBlock(mediaId, name, width) {
  const block = {
    type: 'video',
    mediaId,
    name: name || '',
    width: (typeof width === 'number' && isFinite(width) && width > 0) ? width : null,
    posterId: null,
    el: null,
  };
  buildMediaEl(block);
  return block;
}

// Build an audio block. A sound has no picture and no size of its own —
// it is a bar with a play button on it.
function makeAudioBlock(mediaId, name) {
  const block = {
    type: 'audio',
    mediaId,
    name: name || '',
    el: null,
  };
  buildMediaEl(block);
  return block;
}

// Build the block's DOM. The element the media plays in is created
// empty; its `src` is filled in once the file's url is known.
function buildMediaEl(block) {
  const wrap = document.createElement(block.type === 'video' ? 'figure' : 'div');
  wrap.className = block.type === 'video'
    ? 'diary-block-video'
    : 'diary-block-audio';

  const player = document.createElement(block.type === 'video' ? 'video' : 'audio');
  player.className = 'diary-media-player';
  player.controls = true;
  // `metadata` — the browser fetches just enough to know the length, not
  // the whole file. It is what lets the player show how long the sound
  // is, so the user knows what they are about to press. `none` would
  // leave the bar with no duration and no state until the first press,
  // and the first press would then have to wait for the whole file.
  player.preload = 'metadata';
  if (block.type === 'video') {
    player.playsInline = true;
  }
  wrap.appendChild(player);

  // The name of the file, so the reader knows what they are looking at
  // even before the media has loaded.
  const caption = document.createElement('div');
  caption.className = 'diary-media-caption';
  caption.textContent = block.name || '';
  wrap.appendChild(caption);

  // Right-clicking the block opens its menu.
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMediaMenu(block, e);
  });

  block.el = wrap;
  block.playerEl = player;
  block.captionEl = caption;
  return wrap;
}

// The block's menu.
//
// A media block is a thing of its own on the page, so its menu offers the
// insertions every block carries — plus the one thing that belongs to a
// media block alone: removing it, and the commands that act on the file
// itself.
//
// The editing commands the browser's own menu would have offered (剪切 /
// 复制 / 粘贴 / 全选) make no sense here: there is no text to cut. What
// does make sense is 复制链接 — the file's location — and 播放 / 暂停,
// which is the same thing the player's own button does but reachable
// without aiming at it.
function openMediaMenu(block, e) {
  const playing = !!(block.playerEl && !block.playerEl.paused);

  openContextMenu({
    x: e.clientX,
    y: e.clientY,
    items: [
      ...insertionMenuItems(),
      { sep: true },
      { row: [
        { act: 'media-play', label: playing ? '暂停' : '播放' },
        { act: 'media-copy-link', label: '复制链接' },
      ]},
      { act: 'media-remove', label: '删除这段媒体', danger: true },
    ],
    onAction: (act, value) => handleMediaMenuAction(block, act, value),
  });
}

// Run the action the user picked in a media block's menu.
function handleMediaMenuAction(block, act, value) {
  switch (act) {
    case 'insert-text':
    case 'insert-image':
    case 'insert-video':
    case 'insert-audio':
    case 'record-audio': {
      const kind = act === 'record-audio' ? 'audio' : act.slice('insert-'.length);
      startInsertion(block, kind, value, act === 'record-audio');
      break;
    }
    case 'media-play': {
      const player = block.playerEl;
      if (!player) break;
      if (player.paused) {
        player.play().catch((err) => console.error('media play failed:', err));
      } else {
        player.pause();
      }
      break;
    }
    case 'media-copy-link': {
      copyMediaLink(block);
      break;
    }
    case 'media-remove': {
      removeMediaBlock(block);
      break;
    }
  }
}

// Copy the media's link to the clipboard — the file's place on disk.
//
// A pending file has no link yet: it lives in the browser until it is
// uploaded, so there is nothing to copy.
async function copyMediaLink(block) {
  if (!block.mediaId || String(block.mediaId).startsWith('pending-')) {
    toast('还没有保存，暂无链接');
    return;
  }
  const url = await loadMediaUrl(block.mediaId);
  if (!url) {
    toast('复制失败：找不到文件');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制');
  } catch (e) {
    toast('复制失败');
  }
}

// Remove a media block. The file behind it is deleted too — otherwise it
// would linger on disk with no reference to it.
function removeMediaBlock(block) {
  const i = pageState.blocks.indexOf(block);
  if (i < 0) return;
  deletePhoto(block.mediaId);
  pageState.blocks.splice(i, 1);
  renderBlocks();
}

// Fill the player's source once the file's url is known.
//
// A pending file has no url on the server yet: it is read straight from
// the picked File, which is a `blob:` URL — and the CSP allows blob: under
// media-src, so the movie plays before it is saved. Once the file is
// uploaded, the saved `file:` URL takes its place.
function setMediaSource(block, url) {
  const player = block.playerEl;
  if (!player) return;
  if (!url) {
    player.removeAttribute('src');
    return;
  }
  if (player.getAttribute('src') !== url) player.setAttribute('src', url);
}

// Read a media file's url out of the main process. A saved file comes
// back as a `file:` URL the <video>/<audio> can load directly.
async function loadMediaUrl(mediaId) {
  if (!mediaId) return '';
  try {
    const r = await api.memorialEvents.photos.readMedia(mediaId);
    return (r && r.url) || '';
  } catch (e) {
    console.error('media read failed:', e);
    return '';
  }
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

// ---- Moving the blocks ---------------------------------------------------
//
// The document is a list of blocks, and the order they are in IS the
// order they are read in — the words, the pictures and the movies follow
// each other down the page. So the user has to be able to change that
// order: a picture that ended up above the paragraph it belongs to has
// to be able to go below it.
//
// The WHOLE BLOCK is the handle: a press anywhere on it picks it up.
// The ⋮⋮ grip at the top-left is the visible sign of that, but it is
// not the only place the drag starts.
//
// A block is not a plain box, though. It holds content that has
// gestures of its own:
//
//   · a text block is a textarea — a press in it selects text;
//   · a gallery holds a drag of its own (reordering the photos) and a
//     resize handle;
//   · a media block holds a player with its own controls.
//
// So the press is looked at before the drag begins. A press on the
// content the user is really working with stays with that content; a
// press on the block around it moves the block.
//
// Two presses cannot be told apart from a drag by the press alone, and
// both are settled AFTER the pointer has moved, because only the
// movement says what the user meant:
//
//   · in a textarea — dragging across the words selects them, and
//     dragging away from them moves the block. If the drag drew a
//     selection, the selection was meant, and the block stays put.
//
//   · in a gallery — the photos reorder with a drag of their own. A
//     drag that stays inside the gallery is the photo's; a drag that
//     walks out of it is the block's.
//
// The drag swaps two blocks: the one the user picked up and the one the
// pointer is over. It is a swap and not an insert, so the two blocks
// keep their relative order to everything else — the page does not
// shuffle around them.
//
// The block that is being dragged follows the pointer as a GHOST, the
// way a photo does inside a gallery, and the block under the pointer is
// marked so the user can see where the swap will happen.

// The pixels the pointer has to travel before a press becomes a drag.
// A press that does not move is a press, not a drag.
const BLOCK_DRAG_THRESHOLD = 5;

// A ghost of the block that is being dragged. It shows the block's own
// kind — a picture, a player, a paragraph of words — so the user sees
// what they are carrying.
function makeBlockGhost(block, e) {
  const ghost = document.createElement('div');
  ghost.className = 'diary-block-ghost';
  const label = block.type === 'text' ? '文字'
    : (block.type === 'gallery' ? '图组'
      : (block.type === 'video' ? '视频' : '音频'));
  ghost.innerHTML = `<span class="diary-block-ghost-icon" aria-hidden="true">⋮⋮</span>`
    + `<span class="diary-block-ghost-label">${label}</span>`;
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  return ghost;
}

// The block wrapper under a point, if there is one. The rectangles are
// used instead of a hit test, so this works in a window that is not on
// screen too.
function blockWrapAt(host, x, y) {
  for (const el of Array.from(host.children)) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

// Put two blocks in each other's places.
//
// The two blocks may be of different kinds — a picture and a paragraph,
// a movie and a sound — that is the whole point of the gesture.
function swapBlocks(a, b) {
  const ia = pageState.blocks.indexOf(a);
  const ib = pageState.blocks.indexOf(b);
  if (ia < 0 || ib < 0 || ia === ib) return false;
  pageState.blocks[ia] = b;
  pageState.blocks[ib] = a;
  return true;
}

// The content inside a block that owns its own gesture — the resize
// handle of a picture and its delete button.
//
// A press on one of these is that content's business, not the block's:
// dragging the handle resizes the picture, pressing the button deletes
// it.
//
// The photos of a gallery are NOT in this list. A picture can be picked
// up and carried out of its gallery, and the gallery decides what a
// drag that stays inside it means (see startGalleryReorder).
//
// The text of a text block is NOT in this list either. A textarea can
// be dragged away from the words it holds, and the selection it draws
// during the drag is what tells the two apart (see startBlockDrag).
//
// The native controls of a movie and of a sound are not in this list
// either, and they do not have to be: Chromium's own media controls
// swallow the press and never let it reach the page, so the browser
// has already decided that those presses belong to the player. The
// surface of a movie — everything above the controls — is free, and
// it makes a big, comfortable handle for carrying the block around.
//
// The list is walked from the pressed element upwards, so a press deep
// inside a picture is recognized too.
function ownsItsOwnGesture(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.classList
      && (node.classList.contains('diary-gallery-handle')
        || node.classList.contains('photo-x'))) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

// The gallery the press landed in, if it landed in one. The gallery's
// own photo drag keeps the gesture as long as the pointer stays inside
// it; the block takes over when the pointer walks out.
function galleryUnder(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.classList && node.classList.contains('diary-block-gallery')) return node;
    node = node.parentElement;
  }
  return null;
}

// The gallery block a gallery element belongs to.
function galleryBlockOf(el) {
  return pageState.blocks.find((b) => b.type === 'gallery' && b.el === el) || null;
}

// The textarea a press landed in, if the press landed in one. Its
// selection is what tells a text drag apart from a block drag.
function textareaUnder(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.classList && node.classList.contains('diary-block-text')) return node;
    node = node.parentElement;
  }
  return null;
}

// Drag a block onto another one to swap their places.
//
// The block follows the pointer as a ghost, and the block under the
// pointer is marked as the swap's target. The swap itself happens when
// the drag ends, so the user can carry the block past a neighbour and
// come back — the order only changes when the pointer is released.
//
// `press` says what the press was: which textarea it landed in (if
// any) and the selection that textarea had at the time.
//
// Two presses are ambiguous, and both are settled AFTER the pointer
// has moved, because only the movement says what the user meant:
//
//   · a press in a textarea — dragging across the words selects them,
//     and dragging the block away from them moves the block. So the
//     first movement does not prevent the default action: the browser
//     is left free to draw the selection, and the decision is made a
//     tick later, when the selection has settled. A range that
//     appeared means the user was selecting text.
//
//   · a press on a photo in a gallery — the photo has a drag of its
//     own (reordering it inside the gallery). So the block only takes
//     over when the pointer leaves the gallery: a drag that stays
//     inside is the photo's, and a drag that walks out of the gallery
//     is the block's.
function startBlockDrag(block, ev, press) {
  const host = document.getElementById('diary-blocks');
  if (!host) return;
  const startX = ev.clientX;
  const startY = ev.clientY;
  const ta = press.ta;
  const selBefore = press.selBefore;
  // The gallery the press landed in, if it landed in one. Its photos
  // have a drag of their own, so the block waits until the pointer
  // walks out of the gallery.
  const gallery = press.gallery;
  let started = false;
  let ghost = null;
  let target = null;
  // Set once the press has been judged: an inner gesture that turned
  // out to be the one that was meant cancels the block drag, and the
  // rest of the gesture belongs to that inner gesture.
  let cancelled = false;

  const clearTarget = () => {
    if (target) target.classList.remove('drop-target');
    target = null;
  };

  // Has the drag drawn a selection in the textarea? The browser updates
  // the selection after the pointer event has been handled, so the
  // answer is one event behind — hence the check on the NEXT move.
  //
  // A RANGE is what counts. A press that only places the caret leaves
  // the two ends equal, and that is not a selection — it is a click,
  // and the click must still reach the textarea.
  const selectionDrawn = () => {
    if (!ta) return false;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start === end) return false;
    // The range has to be one the drag made, not one that was already
    // there when the press began.
    return !(start === selBefore[0] && end === selBefore[1]);
  };

  const beginDrag = (e) => {
    started = true;
    document.body.classList.add('diary-block-dragging');
    ghost = makeBlockGhost(block, e);
    document.body.appendChild(ghost);
  };

  // The last pointer position, so the ghost can start where the
  // pointer is even when the drag begins a tick after the press.
  let lastEvent = ev;

  const onMove = (e) => {
    lastEvent = e;
    if (cancelled) return;
    if (!started) {
      // A small movement is a press, not a drag.
      if (Math.abs(e.clientX - startX) < BLOCK_DRAG_THRESHOLD
        && Math.abs(e.clientY - startY) < BLOCK_DRAG_THRESHOLD) return;
      if (ta) {
        // The decision waits a tick: the browser draws the selection
        // after this event, and the check has to read it after that.
        // The check runs again on every later move, so a selection that
        // the browser drew late still cancels the drag.
        if (!press.judged) {
          press.judged = true;
          setTimeout(() => {
            if (cancelled) return;
            if (selectionDrawn()) {
              // The user was selecting text. The block stays put.
              cancelled = true;
              return;
            }
            beginDrag(lastEvent);
          }, 0);
        }
        return;
      }
      if (gallery) {
        // The press was in a gallery. As long as the pointer stays in
        // it, the photos' own drag owns the gesture. The gallery hands
        // the gesture over when the pointer walks out of it.
        if (galleryHasPoint(gallery, e.clientX, e.clientY)) return;
        beginDrag(e);
      } else {
        beginDrag(e);
      }
    }
    if (!started) return;
    if (e.cancelable) e.preventDefault();
    if (ghost) {
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
    }
    // The block under the pointer is the one the dragged block would
    // swap with.
    const wrap = blockWrapAt(host, e.clientX, e.clientY);
    if (!wrap || wrap === block.wrap) {
      clearTarget();
      return;
    }
    if (wrap !== target) {
      clearTarget();
      target = wrap;
      target.classList.add('drop-target');
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('diary-block-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    if (!started) return;
    // The drag ends with a click event on the block — swallow it, so
    // the press does not reach whatever is under the pointer. A drag
    // that began on a photo must not open the picture either.
    if (gallery) {
      gallery.dragging = true;
      setTimeout(() => { gallery.dragging = false; }, 0);
    }
    if (target) {
      const other = pageState.blocks.find((b) => b.wrap === target);
      clearTarget();
      if (other && swapBlocks(block, other)) renderBlocks();
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// The grip of a block: the sign that the block can be picked up.
//
// It is the visible handle at the top-left, but the drag starts
// anywhere on the block — this is only where the user is told so.
function makeBlockGrip(block) {
  const grip = document.createElement('span');
  grip.className = 'diary-block-grip';
  grip.title = '拖动可与其它块交换位置';
  grip.textContent = '⋮⋮';
  grip.addEventListener('pointerdown', (e) => {
    // Only the left button moves a block — the right one opens the
    // menu.
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    startBlockDrag(block, e, { ta: null, selBefore: null, gallery: null });
  });
  // A drag ends with a click event on the grip — don't let it through.
  grip.addEventListener('click', (e) => e.stopPropagation());
  grip.addEventListener('contextmenu', (e) => e.stopPropagation());
  return grip;
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
  // files would linger on disk with no reference to them. The same goes
  // for a movie or a sound.
  if (block.type === 'gallery') {
    for (const photo of block.photos.slice()) deletePhoto(photo.photoId);
  } else if (block.type === 'video' || block.type === 'audio') {
    deletePhoto(block.mediaId);
  }
  pageState.blocks.splice(index, 1);
  renderBlocks();
}

// Re-render every block into the page. The text blocks keep their live
// <textarea> nodes (they hold the user's cursor position and uncommitted
// IME composition); the galleries keep their DOM too, so a photo that is
// already on screen isn't rebuilt from scratch on every keystroke.
//
// Every block carries a GRIP — the sign that the block can be picked up
// and swapped with another one. The grip belongs to the wrapper, not to
// the block's own content, so it never competes with the text
// selection of a textarea, with the photo drag inside a gallery, or
// with the resize handle of a picture.
function renderBlocks() {
  const host = document.getElementById('diary-blocks');
  if (!host) return;
  host.innerHTML = '';
  for (const block of pageState.blocks) {
    const wrap = document.createElement('div');
    wrap.className = 'diary-block';
    wrap.dataset.blockType = block.type;
    // The wrapper is kept on the block: the drag looks the target up by
    // it when the pointer is released.
    block.wrap = wrap;
    // The whole block is the handle: a press anywhere on it picks it
    // up. The content that owns a gesture of its own — the words of a
    // text block, the photos of a gallery — keeps it; the press is
    // looked at before the drag begins.
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (ownsItsOwnGesture(e.target)) return;
      // The textarea under the press, and the selection it had when
      // the press began. A drag that changes the selection was a text
      // selection, not a move.
      const ta = textareaUnder(e.target);
      const selBefore = ta ? [ta.selectionStart, ta.selectionEnd] : null;
      // The gallery under the press, if any. Its photos reorder with a
      // drag of their own, so the block only takes over once the
      // pointer leaves the gallery.
      const galleryEl = galleryUnder(e.target);
      const gallery = galleryEl ? galleryBlockOf(galleryEl) : null;
      startBlockDrag(block, e, { ta, selBefore, gallery });
    });
    wrap.appendChild(makeBlockGrip(block));
    if (block.type === 'text') {
      // The text block is just the text: its controls live in the
      // right-click menu (see openTextMenu).
      wrap.appendChild(block.el);
    } else if (block.type === 'gallery') {
      syncGalleryEl(block);
      wrap.appendChild(block.el);
    } else {
      // A media block is already built: its player holds the file's url.
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

// Insert a gallery above or below a block. The block is NOT split: the
// picture lands beside the whole paragraph, so the words the user wrote
// stay one unbroken block.
//
// Splitting at the caret used to be the rule, but it cut the paragraph
// in two around the picture — a sentence ended up with the picture in
// the middle of it, and the two halves read as two paragraphs. A
// picture is a thing of its own now, not a word in the middle of a
// sentence.
//
// Every picked file lands in the SAME gallery — one insertion point can
// hold any number of photos.
async function insertGalleryBeside(anchor, files, where) {
  const idx = pageState.blocks.indexOf(anchor);
  if (idx < 0) return;

  // Where the caret was, BEFORE the redraw: the re-render takes the
  // textarea out of the page and puts it back, and that can lose the
  // selection.
  const ta = anchor.el;
  const caret = ta && ta.selectionStart != null ? ta.selectionStart : null;

  // The gallery goes right beside the anchor.
  const photos = await makePendingPhotos(files);
  const at = where === 'before' ? idx : idx + 1;
  pageState.blocks.splice(at, 0, makeGalleryBlock(photos, null));
  renderBlocks();

  // Keep the caret in the anchor, where it was, so the user keeps
  // typing where they left off.
  if (ta) {
    ta.focus();
    try { ta.setSelectionRange(caret, caret); } catch (err) { /* no selection */ }
  }
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

// Exported so the router can drive the editor directly.
export async function render(args, params) {
  const app = document.getElementById('app');
  // Whether the page is writing a NEW entry. It starts as "the URL named
  // no id", but it can become true later: the URL may name an entry that
  // no longer exists, and then the page writes a new one instead.
  let isNew = !args.id;
  pageState.isNew = isNew;
  pageState.eventId = isNew ? null : args.id;
  pageState.selectedContactIds = new Set();
  pageState.pendingPhotos = [];
  pageState.pendingMedia = [];
  pageState.blocks = [];
  pageState.existingPhotos = [];
  // The previous visit's popover listeners belong to a picker that is
  // about to be replaced — drop them before the new page is drawn.
  if (pageState.cleanupThemePicker) pageState.cleanupThemePicker();
  pageState.cleanupThemePicker = null;
  // A pending target from a previous visit to this page would send the
  // next file pick to the wrong place.
  pendingInsert = null;
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
  // The entry the URL names may not exist — it was deleted, or the link
  // was stale. Either way the editor does NOT dead-end on an error page:
  // it becomes a NEW entry instead, so the user can write the memory the
  // link was asking for.
  //
  // The id is kept in `pageState.eventId` only when the entry was really
  // found. A missing entry leaves it null, so 保存 creates rather than
  // overwrites.
  let missing = false;
  if (!isNew) {
    ev = await api.memorialEvents.get(args.id);
    if (!ev) {
      missing = true;
      // The page becomes a new entry. `args.id` is deliberately NOT
      // carried over — saving must not try to update a row that is gone.
      isNew = true;
      pageState.isNew = true;
      pageState.eventId = null;
      ev = {
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
    } else {
      pageState.existingPhotos = ev.photos || [];
      for (const cid of (ev.contact_ids || [])) pageState.selectedContactIds.add(cid);
    }
  }
  // 抽卡: the entry starts from the card that was drawn. The card's
  // title and requirement fill the page, and the entry is filed as
  // 抽卡事件 — the 分类 the 抽卡 page records.
  let draw = null;
  if (params.draw) {
    try {
      draw = await api.cardDraws.get(params.draw);
    } catch (e) {
      console.error('could not load the drawn card', e);
      draw = null;
    }
  }
  pageState.draw = draw;
  if ((isNew || missing) && draw) {
    ev.title = draw.title || ev.title;
    ev.notes = draw.requirement || ev.notes;
    ev.kind = 'card_draw';
  }
  if (params.contact_id) pageState.selectedContactIds.add(params.contact_id);

  const contacts = await api.contacts.list();
  const theme = getDiaryTheme(ev.background || DEFAULT_THEME_ID);
  pageState.background = theme.id;
  // The metadata the 保存 dialog starts from: what the entry says, or
  // "now" for a new one.
  pageState.occurredAt = ev.occurred_at || '';
  pageState.kind = normalizeMemorialKind(ev.kind);

  const themeVars = diaryThemeVars(theme);

  // The back link says where it goes. It follows the page the user came
  // from: the 抽卡 page, the 打卡墙, or the 回忆 list.
  const backLabel = pageState.returnTo === '/card-life/stats'
    ? '返回打卡墙'
    : (pageState.returnTo === '/card-life' ? '返回抽卡' : '返回列表');

  app.innerHTML = `
    <div class="row between diary-topbar">
      <a class="back-link" href="#${escapeHtml(pageState.returnTo)}"><span class="icon-arrow-left"></span>${backLabel}</a>
      <div class="row" style="gap:8px;">
        ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
        <button class="btn" id="save">保存</button>
      </div>
    </div>

    <!-- The entry was started from a card drawn on the 抽卡 page, so the
         page says where it came from. The card's own title and requirement
         are already in the title field and the first text block. -->
    ${pageState.draw ? `
    <div class="diary-draw-banner">
      <span class="diary-draw-badge">抽卡</span>
      <span>来自抽卡 · ${pageState.draw.source === 'custom'
        ? '我自己添加的卡片'
        : `第 ${escapeHtml(String(pageState.draw.card_no || '?'))} 张`} · ${escapeHtml(pageState.draw.week_key || '')} 那一周</span>
    </div>` : ''}

    <!-- The link named an entry that is gone — it was deleted, or the link
         was stale. The page writes a NEW entry rather than dead-ending,
         so the banner says so rather than letting the user wonder why
         the page is empty. -->
    ${missing ? `
    <div class="diary-draw-banner diary-missing-banner">
      <span class="diary-draw-badge">重写</span>
      <span>原来那篇回忆已经不在了 —— 这里可以重新写一篇。</span>
    </div>` : ''}

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
          <!-- The picker for a movie or a sound. It is separate from the
               picture picker because the two accept different files, and
               the media block it fills is a player rather than a
               picture. -->
          <input type="file" id="diary-media" accept="video/*,audio/*"/>
        </div>
        <!-- The decorative strip at the bottom of the page. It is a layer
             of its own, BELOW the body: the body grows with the text and
             the photos, and the decoration keeps its own height, so a long
             entry never has its pictures or its words sitting on top of
             it. -->
        <div class="diary-page-foot" aria-hidden="true"></div>
      </div>

      <!-- The side panel holds the paper style and a short guide to the
           editing rules. The time, the cast and the first-time flag are
           asked for in the 保存 dialog — the press on 保存 is the moment
           the entry becomes a record.

           The guide is here because every control of the document lives
           in a right-click menu: nothing on the page says so. A user
           who does not know that would hunt for a button that is not
           there. The card lists the rules and nothing else — it is a
           map of the gestures, not a tutorial. -->
      <aside class="diary-side">
        <section class="card diary-side-card">
          <h2>背景样式</h2>
          <div class="diary-theme-picker" id="diary-theme-picker">
            ${themeToggleHtml(theme)}
            <div class="diary-theme-pop" id="diary-theme-pop" hidden>
              ${themePickerHtml(theme.id)}
            </div>
          </div>
        </section>

        <section class="card diary-side-card diary-help-card">
          <h2>编辑规则</h2>
          <ul class="diary-help-list">
            <li><b>右键任意一块</b>：上 / 下方插入<b>文字、图片、视频、音频</b>，四样都能插在任意一块的上下</li>
            <li><b>右键文字</b>：删除此段、剪切 / 复制 / 粘贴</li>
            <li><b>右键图组</b>：单图 / 双图 / 三图 / 网格、加图</li>
            <li><b>右键某张图</b>：删除这张图片</li>
            <li><b>右键视频 / 音频</b>：播放 / 暂停、复制链接、删除这段媒体</li>
            <li><b>拖动图片</b>换顺序，<b>拖右下角手柄</b>改大小</li>
            <li><b>按住块任意空白处拖动</b>，与另一块交换位置（块里划选文字、拖图组里的照片，都还归它们自己）</li>
          </ul>
        </section>
      </aside>
    </div>
  `;

  // Build the document from what was saved (or start empty).
  loadBlocks(ev);

  wireThemePicker();
  wirePhotoInput();
  wireMediaInput();
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
// The document is read with the shared parser (src/js/diary_layout.js), so
// the editor and the 回忆 list card read the same document the same
// way.
function loadBlocks(ev) {
  const blocks = [];
  const parsed = parseDiaryContent(ev.content);
  if (parsed.length) {
    for (const b of parsed) {
      if (b.type === 'text') {
        blocks.push(makeTextBlock(b.text));
      } else if (b.type === 'gallery') {
        const gallery = makeGalleryBlock(loadGalleryPhotos(b), b.layout);
        if (gallery.photos.length) blocks.push(gallery);
      } else if (b.type === 'video' || b.type === 'audio') {
        const media = loadMediaBlock(b, ev.photos || []);
        if (media) blocks.push(media);
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
//
// The photo's cover comes along too: a photo the user gave a cover of
// its own keeps it; a photo without one gets the default mapping for
// its shape, worked out as soon as its bytes are in the page.
function loadGalleryPhotos(b) {
  const photos = [];
  for (const p of (Array.isArray(b.photos) ? b.photos : [])) {
    if (!p || typeof p !== 'object' || typeof p.photo_id !== 'string' || !p.photo_id) continue;
    const meta = pageState.existingPhotos.find((x) => x.id === p.photo_id);
    photos.push(makeGalleryPhoto(
      p.photo_id,
      meta ? meta.original_name : '',
      null,
      typeof p.width === 'number' && isFinite(p.width) && p.width > 0 ? p.width : null,
      p.cover
    ));
  }
  return photos;
}

// Build a media block from a saved one, and point its player at the file
// on disk.
//
// The url comes from the main process: a movie is too big to carry as a
// data URL, so the <video> is pointed straight at the file, which the
// CSP allows for media.
function loadMediaBlock(b, eventPhotos) {
  const mediaId = b.media_id;
  if (!mediaId) return null;
  const meta = (eventPhotos || []).find((x) => x && x.id === mediaId);
  const name = meta ? (meta.original_name || '') : '';
  const block = b.type === 'audio'
    ? makeAudioBlock(mediaId, name)
    : makeVideoBlock(mediaId, name, typeof b.width === 'number' ? b.width : null);
  // The player's source arrives a tick later — the url is fetched from
  // the main process.
  loadMediaUrl(mediaId).then((url) => {
    // The page may have been re-rendered while the url was on its way.
    if (!block.playerEl || !block.playerEl.isConnected) return;
    setMediaSource(block, url);
  });
  return block;
}

// Repaint the writing surface when the user picks a different background.
//
// The picker is a popover: the button opens it, a style closes it, and a
// press anywhere outside it closes it too. The button itself carries the
// style in use, so it is repainted with the miniature of the new page
// whenever the style changes.
function wireThemePicker() {
  const page = document.getElementById('diary-page');
  const picker = document.getElementById('diary-theme-picker');
  const toggle = document.getElementById('diary-theme-toggle');
  const pop = document.getElementById('diary-theme-pop');
  if (!picker || !toggle || !pop) return;

  // Open or close the popover.
  const setOpen = (open) => {
    picker.classList.toggle('open', open);
    pop.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  toggle.onclick = (e) => {
    e.stopPropagation();
    setOpen(pop.hidden);
  };

  // A press outside the picker closes it. The listener is on the
  // document and is removed when the page goes away, so it cannot fire
  // against a picker that no longer exists.
  const onDocClick = (e) => {
    if (!picker.contains(e.target)) setOpen(false);
  };
  document.addEventListener('click', onDocClick);
  // The Escape key closes it as well — a popover you can only close by
  // clicking somewhere else is a popover you cannot close with the
  // keyboard.
  const onKey = (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      setOpen(false);
      toggle.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  // The page is re-rendered on every navigation; the listeners belong to
  // the one that is on screen.
  pageState.cleanupThemePicker = () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  };

  document.querySelectorAll('.diary-theme-tile').forEach((tile) => {
    tile.onclick = () => {
      const t = getDiaryTheme(tile.dataset.themeId);
      pageState.background = t.id;
      const vars = diaryThemeVars(t);
      for (const [k, v] of Object.entries(vars)) page.style.setProperty(k, v);
      document.querySelectorAll('.diary-theme-tile').forEach((el) => {
        el.classList.toggle('selected', el === tile);
      });
      // The button now shows the style that was just picked.
      const name = document.getElementById('diary-theme-current');
      if (name) name.textContent = t.name;
      const thumb = toggle.querySelector('.diary-theme-thumb');
      if (thumb) {
        thumb.style.setProperty('--theme-header', t.headerBg);
        thumb.style.setProperty('--theme-top', t.bgTop);
        thumb.style.setProperty('--theme-mid', t.bgMid);
      }
      // The choice is made — close the popover and go back to writing.
      setOpen(false);
    };
  });
}

// ---- Insertions ----------------------------------------------------------

// The insertion the user asked for and has not supplied yet.
//
// Every block's menu asks for the same things — a paragraph, a picture,
// a movie, a sound, above or below the block that was pressed — so
// there is ONE record of the pending insertion instead of one per kind.
//
// It is { anchor, kind, where }:
//
//   anchor  the block the insertion hangs off
//   kind    'text' | 'image' | 'video' | 'audio'
//   where   'before' | 'after'
//
// A 'text' insertion needs no file at all, so it is placed right away
// and never reaches this record. The other kinds wait for the file
// picker to hand over a file.
let pendingInsert = null;

// The gallery whose "+ 加图" action was picked. When set, the next file
// pick joins THAT gallery instead of starting a new one — that is the
// one insertion that adds to a block rather than putting a new one
// beside it.
let pendingGalleryFor = null;

// Start an insertion above or below a block.
//
// A paragraph is placed at once: there is no file to wait for. The other
// kinds open the file picker and leave a record behind, so the file that
// comes back knows where it has to land.
//
// `recording` says the sound is being made right now instead of picked
// from the disk — it lands in the same places either way.
function startInsertion(anchor, kind, where, recording) {
  const side = where === 'before' ? 'before' : 'after';

  if (kind === 'text') {
    insertTextBeside(anchor, side);
    return;
  }

  if (recording) {
    recordAudioBeside(anchor, side);
    return;
  }

  pendingInsert = { anchor, kind, where: side };
  const fileInput = document.getElementById(kind === 'image' ? 'diary-photos' : 'diary-media');
  if (fileInput) fileInput.click();
}

// Put a new paragraph above or below a block.
function insertTextBeside(anchor, side) {
  const i = pageState.blocks.indexOf(anchor);
  if (i < 0) return null;
  const block = makeTextBlock('');
  insertBlock(side === 'before' ? i : i + 1, block);
  // The new paragraph takes the caret, so the user can type into it
  // straight away.
  const ta = block.el;
  if (ta) {
    ta.focus();
    try { ta.setSelectionRange(0, 0); } catch (err) { /* no selection */ }
  }
  return block;
}

// The index a new block of media takes next to an anchor.
//
// Media that follows the anchor is walked PAST, so two files picked one
// after the other keep the order they were picked in. Going UP, the
// media that already stands above the anchor is walked past the other
// way — the new one lands below it, in the run of media the user is
// already looking at.
function insertionIndex(anchor, side) {
  const idx = pageState.blocks.indexOf(anchor);
  if (idx < 0) return -1;

  if (side === 'after') {
    let at = idx + 1;
    while (at < pageState.blocks.length) {
      const next = pageState.blocks[at];
      if (next.type !== 'video' && next.type !== 'audio') break;
      at += 1;
    }
    return at;
  }
  let at = idx;
  while (at > 0) {
    const prev = pageState.blocks[at - 1];
    if (prev.type !== 'video' && prev.type !== 'audio') break;
    at -= 1;
  }
  return at;
}

// ---- Photos --------------------------------------------------------------

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

    // An insertion of a picture: drop the gallery above or below the
    // block it hangs off. The text is left whole — the picture does not
    // cut it in two. Every picked file goes into that one gallery.
    if (pendingInsert && pendingInsert.kind === 'image') {
      const target = pendingInsert;
      pendingInsert = null;
      await insertGalleryBeside(target.anchor, files, target.where);
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

// ---- Media picker --------------------------------------------------------

// The picker for a movie or a sound. It is separate from the picture
// picker because the two accept different files: the picture picker takes
// images, this one takes video (or audio) depending on what the user
// asked for.
function wireMediaInput() {
  const fileInput = document.getElementById('diary-media');
  if (!fileInput) return;

  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files || []);
    // Reset the input so picking the same file twice in a row still
    // fires a change event.
    fileInput.value = '';
    if (!files.length) return;
    // An insertion of a movie or a sound: the media goes above or below
    // the block it hangs off, for the same reason a picture does.
    if (pendingInsert && (pendingInsert.kind === 'video' || pendingInsert.kind === 'audio')) {
      const target = pendingInsert;
      pendingInsert = null;
      await insertMediaBeside(target.anchor, files[0], target.kind, target.where);
      return;
    }

    // No target: the picker was opened some other way. Put the media at
    // the end of the document.
    await insertMediaBeside(null, files[0], fileKindFor(files[0]), 'after');
  };
}

// What kind of media a picked file is. The picker already filtered by
// type, but a user can force a different type through the OS dialog, so
// the file's own mime decides.
function fileKindFor(file) {
  const type = (file && file.type) || '';
  if (type.startsWith('audio/')) return 'audio';
  return 'video';
}

// Insert a media block above or below another block. A text block is NOT
// split — the movie goes beside the whole paragraph, so the words the
// user wrote stay one unbroken piece, the same rule a picture follows.
//
// The media lands beside the anchor AND past any media already
// inserted there, so two attachments picked one after the other keep the
// order they were picked in. (Straight beside the anchor, the second
// one would jump in front of the first.)
//
// Only the first picked file is taken: a movie is a thing of its own,
// not a row of things. Picking several at once takes the first one and
// leaves the rest alone.
//
// The anchor is whichever block the user acted on. The new media lands
// right beside it — above it or below it, as asked.
async function insertMediaBeside(anchor, file, kind, where) {
  if (!file) return;
  const type = kind === 'audio' ? 'audio' : 'video';

  // The file is registered as a pending upload, the same way a picture
  // is: the block refers to it by a temp id until the upload succeeds.
  const tempId = 'pending-media-' + Date.now() + '-' + (++blockSeq);
  pageState.pendingMedia.push({ file, tempId, kind: type });

  const block = type === 'audio'
    ? makeAudioBlock(tempId, file.name)
    : makeVideoBlock(tempId, file.name, null);

  // Point the player at the file the user just picked, so the movie
  // plays straight away — the user should not have to save first to see
  // what they attached. A picked file lives in the browser's hands, and
  // the only way to point a player at it is a blob: URL.
  setMediaSource(block, URL.createObjectURL(file));

  if (anchor) {
    const at = insertionIndex(anchor, where);
    if (at < 0) return;
    pageState.blocks.splice(at, 0, block);
  } else {
    pageState.blocks.push(block);
  }
  renderBlocks();
}

// Record a sound and put it in the document.
//
// The recording dialog returns a File, and the File goes through the
// very same path a picked sound does: the same pending-media list, the
// same upload on save, the same audio block on the page. The only
// difference is where the bytes came from.
async function recordAudioBeside(anchor, where) {
  let file = null;
  try {
    file = await openAudioRecorderDialog();
  } catch (e) {
    console.error('recording failed:', e);
    toast('录音失败');
    return;
  }
  // The user closed the dialog without recording anything.
  if (!file) return;
  await insertMediaBeside(anchor, file, 'audio', where);
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
        // The photo's cover: the rectangle of the picture its frame
        // shows. A photo whose cover is still the default mapping for
        // its own shape needs none of its own — the default is worked
        // out again wherever the picture is drawn.
        const cover = p.cover;
        if (cover && !isDefaultCover(cover, p)) {
          item.cover = {
            ratio: cover.ratio,
            x: Math.round(cover.x * 1000) / 1000,
            y: Math.round(cover.y * 1000) / 1000,
            zoom: Math.round(cover.zoom * 1000) / 1000,
          };
        }
        return item;
      });
      if (photos.length) {
        out.push({ type: 'gallery', layout: block.layout, photos });
      }
    } else if (block.type === 'video') {
      const item = { type: 'video', media_id: block.mediaId };
      // Only a size the user set by hand is stored — a video that still
      // takes the whole width needs no width of its own.
      if (typeof block.width === 'number') {
        item.width = Math.round(block.width * 1000) / 1000;
      }
      out.push(item);
    } else if (block.type === 'audio') {
      out.push({ type: 'audio', media_id: block.mediaId });
    }
  }
  return out;
}

// Is this cover the default mapping for the picture's own shape?
//
// A cover that says nothing more than the default is not stored: it is
// worked out again wherever the picture is drawn, so the document stays
// small and the default follows the picture if it ever changes.
function isDefaultCover(cover, photo) {
  if (!cover) return true;
  if (!photo.naturalW || !photo.naturalH) return false;
  const def = defaultCover(photo.naturalW, photo.naturalH);
  return cover.ratio === def.ratio
    && Math.abs(cover.x - def.x) < 0.002
    && Math.abs(cover.y - def.y) < 0.002
    && Math.abs(cover.zoom - def.zoom) < 0.002;
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

// True while the 保存 dialog is open. A second press on 保存 while the
// dialog is up would open a second one on top of it.
let metaDialogOpen = false;

async function onSave() {
  if (metaDialogOpen) return;
  const title = (document.getElementById('diary-title').value || '').trim();
  const body = plainTextFromBlocks();

  if (!title && !body) {
    toast('请至少填写标题或正文');
    return;
  }

  // The press on 保存 opens the metadata dialog: when it happened, whether
  // it was the first time, and who was there. The dialog starts from the
  // entry's current values, so pressing 保存 again on the same entry
  // shows the same answers — the user only has to change what changed.
  metaDialogOpen = true;
  let meta = null;
  try {
    const contacts = await api.contacts.list();
    meta = await openMemorialMetaDialog({
      contacts,
      occurredAt: pageState.occurredAt,
      kind: pageState.kind,
      contactIds: Array.from(pageState.selectedContactIds),
    });
  } finally {
    metaDialogOpen = false;
  }
  // The user dismissed the dialog — nothing is written.
  if (!meta) return;

  // Keep the answers as the next round's defaults.
  pageState.occurredAt = meta.occurredAt;
  pageState.kind = meta.kind;
  pageState.selectedContactIds = new Set(meta.contactIds);

  const payload = {
    kind: meta.kind,
    title: title || '回忆',
    // The plain text lives in `notes` (search + album export read it);
    // the interleaved document lives in `content`.
    notes: body || null,
    content: serializeBlocks(),
    occurred_at: meta.occurredAt,
    background: pageState.background,
    contact_ids: meta.contactIds,
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

  // The entry was written from a card drawn on the 抽卡 page — point
  // the card back at the entry, so the page can show that this card was
  // already recorded.
  if (pageState.draw && pageState.draw.id && pageState.isNew) {
    try {
      await api.cardDraws.link(pageState.draw.id, saved.id);
    } catch (e) {
      // A failed link is cosmetic — the entry itself is saved.
      console.error('could not link the drawn card', e);
    }
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

  // Upload the newly picked movies and sounds, the same way the photos
  // go up: each file is registered as a row in `memorial_event_photos`,
  // and the document is rewritten so the pending temp ids become the real
  // media ids.
  const pendingMedia = pageState.pendingMedia.slice();
  if (pendingMedia.length) {
    let okCount = 0;
    let failCount = 0;
    for (const m of pendingMedia) {
      // A movie is a lot bigger than a picture, so it gets a roomier
      // ceiling — but not an endless one.
      if (m.file.size > MAX_MEDIA_BYTES) {
        toast(`${m.kind === 'audio' ? '音频' : '视频'} ${m.file.name} 超过 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB，已跳过`);
        failCount += 1;
        continue;
      }
      try {
        const ab = await m.file.arrayBuffer();
        const media = await api.memorialEvents.photos.upload(saved.id, {
          filename: m.file.name,
          mime: m.file.type,
          bytes: ab,
        });
        // Point the block at the saved media.
        for (const block of pageState.blocks) {
          if (block.type !== 'video' && block.type !== 'audio') continue;
          if (block.mediaId === m.tempId) block.mediaId = media.id;
        }
        okCount += 1;
      } catch (e) {
        console.error('media upload failed:', e);
        failCount += 1;
      }
    }
    if (failCount > 0 && okCount === 0) toast(`媒体上传失败（${failCount} 个）`);
    else if (failCount > 0) toast(`已上传 ${okCount} 个，${failCount} 个失败`);

    // Write the document again with the real media ids.
    if (okCount > 0) {
      try {
        await api.memorialEvents.update(saved.id, { content: serializeBlocks() });
      } catch (e) {
        toast('媒体保存失败：' + ((e && e.message) || e));
      }
    }
  }

  // The pending photos are uploaded now, so the preview list is done.
  pageState.pendingPhotos = [];
  pageState.pendingMedia = [];

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
  pageState.pendingMedia = [];
  toast('已删除');
  navigate(pageState.returnTo);
}

register('/diary/new', render);
register('/diary/:id', render);
