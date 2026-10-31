// src/js/pages/album_editor.js — WYSIWYG album layout editor.
//
// Embedded inside /export. Toggled via state.view = 'editor' in export.js.
// Renders an editing surface for an AlbumLayout: theme switcher, page
// thumbnails, a per-page canvas with photo slots + text slots, a property
// inspector for the selected slot, and a bottom photo palette to drag
// new photos into empty slots.
//
// Pointer events are used throughout for drag-and-drop (HTML5 drag has
// no precedent in this codebase; pointer events also unify canvas pan
// with photo drag in v1).
//
// Public API:
//   mountEditor({ container, events, onBack, onExport })
//   destroyEditor()
//
// State is module-level (single instance, single page).

import {
  api,
  escapeHtml,
  toast,
  fetchPhotoDataUrl,
  fetchPhotoMeta,
} from '../api.js';
import {
  THEMES,
  LAYOUT_TEMPLATES,
  getTheme,
  getLayoutTemplate,
  getPageDims,
  slotRect,
  slotRectCss,
  computePhotoDrawRect,
  applyExifOrientation,
} from '../album_layouts.js';
import {
  buildAlbumLayout,
  remapPageTemplate,
} from '../album_builder.js';
import { createGestureGuard } from '../gesture_guard.js';

// ---- state -----------------------------------------------------------------

const state = {
  container: null,
  events: [],          // memorial events with photos
  eventById: new Map(),// eventId → event
  photoById: new Map(),// photoId → {id, eventId, full_path, mime, ...}
  layout: null,        // AlbumLayout (mutated in place)
  selectedPageIdx: 0,
  selectedSlotIdx: null,
  selectedSlotType: null, // 'photo' | 'text' | null
  editingPhotoSlotIdx: null, // photo slot in "pan/zoom edit" mode
  // Drag state (single active drag at a time)
  drag: null,
  // Computed CSS pixel size of the current page canvas (depends on
  // container width)
  canvasPx: { w: 0, h: 0, scale: 1 },
  // Resize observer handle
  resizeObserver: null,
  // Cached photo data URLs (Map<photoId, dataUrl>)
  photoUrls: new Map(),
  // Double-click armed for slot swap; null when idle.
  swapArmed: null,
  // Set of photoIds that have been swapped at least once (drives the
  // "order" column of the Customizations panel).
  swapLog: new Set(),
  // Customizations panel open/closed
  customPanelOpen: false,
  // Undo/redo history stack of layout snapshots.
  history: [],
  historyIdx: -1,
  historyMax: 50,
  // ---- PPT-style free text boxes (selected by id, not slotIdx) ----
  selectedFreeTextId: null,
  // Free-form text box drag state (single active at a time)
  freeTextDrag: null,
  // Free-form text box resize state
  freeTextResize: null,
};

// ---- Gesture guards --------------------------------------------------------
//
// Every drag gesture in this editor is a latch: set on `pointerdown`,
// cleared on `pointerup`. If the `pointerup` never arrives, the latch
// stays set and the gesture never ends.
//
// That happens in two ways, both common:
//
//   * **A system suspend.** The OS tears down and re-creates the pointer
//     device, so on wake the mouse reports a NEW `pointerId` and the
//     browser never delivers a `pointerup` for the old one. The pet window
//     had exactly this bug (it became undraggable for the rest of the
//     session after a sleep).
//   * **A release outside the window.** The `pointerup` listeners live on
//     `window`; releasing the button outside the application window
//     delivers no event either.
//
// The guards below fix both: they record the pointer id that owns the
// gesture, and treat "an event from a different pointer" as proof that the
// gesture is dead — tearing it down so the next interaction starts clean.
//
// The photo drag (slot→slot / palette→slot) matters most. When its
// `pointerup` is lost, the drag's ghost element stays on screen AND
// `onCanvasPointerUp` stays registered — so the user's NEXT unrelated
// click commits a stale photo swap, silently moving a photo into a slot
// they never dropped it on.
//
// See src/js/gesture_guard.js for the shared implementation.

// Photo drag — the one that can commit a real layout mutation.
const photoDragGuard = createGestureGuard({
  onEnd: () => onCanvasPointerUp(),
  onCancel: () => {
    // The drag was abandoned: remove the ghost and drop the listeners,
    // but commit NOTHING. A cancelled drag must not move a photo.
    cleanupDrag();
  },
});

// Free-text box move.
const freeTextDragGuard = createGestureGuard({
  onEnd: () => onWindowFreeTextUp(),
  onCancel: () => onWindowFreeTextUp(),
});

// Free-text box resize (the corner handles).
const freeTextResizeGuard = createGestureGuard({
  onEnd: () => onWindowFreeTextResizeUp(),
  onCancel: () => onWindowFreeTextResizeUp(),
});

// Photo pan (moving a photo inside its slot).
const photoPanGuard = createGestureGuard({
  onEnd: () => onWindowPhotoPanUp(),
  onCancel: () => onWindowPhotoPanUp(),
});

// Text pan (moving a text block inside its slot).
const textPanGuard = createGestureGuard({
  onEnd: () => onWindowTextPanUp(),
  onCancel: () => onWindowTextPanUp(),
});

// ---- Free-form text box defaults & factories --------------------------------
//
// FreeText is stored on page.freeTexts in pt units. The editor renders
// with px = pt * state.canvasPx.scale; the PDF side uses pt directly. This
// keeps WYSIWYG 1:1 without baking any per-page scale into the layout JSON.

const DEFAULT_FREETEXT_STYLE = {
  fontSize: 18,                 // pt
  fontWeight: 'normal',
  fontStyle:  'normal',
  textAlign:  'left',
  color:      '#2a2a2a',
  backgroundColor: null,
  borderColor:    null,
  borderWidth:    0,
  padding:        4,            // pt
  rotation:       0,            // reserved, not rendered
};

const FREETEXT_LIMITS = {
  fontSizeMin:  8,
  fontSizeMax:  72,
  borderWidthMin: 0,
  borderWidthMax: 3,
  paddingMin:  0,
  paddingMax:  20,
  wMin: 40,
  wMax: 9999,
  hMin: 20,
  hMax: 9999,
};

function genFreeTextId() {
  return 'ft_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

function createFreeText({ x, y, w, h } = {}) {
  return {
    id: genFreeTextId(),
    text: '点击编辑文字',
    x: Number(x) || 100,
    y: Number(y) || 100,
    w: Number(w) || 200,
    h: Number(h) || 60,
    ...DEFAULT_FREETEXT_STYLE,
  };
}

// Walk the layout and inject freeTexts: [] on any page that doesn't have
// it. Idempotent and safe to call after JSON.parse(JSON.stringify(...)) —
// we always want every page to have the array so downstream code can
// blindly iterate.
function ensurePageShape(layout) {
  if (!layout || !Array.isArray(layout.pages)) return;
  for (const p of layout.pages) {
    if (!Array.isArray(p.freeTexts)) p.freeTexts = [];
  }
}

// ---- Floating text toolbar --------------------------------------------------
//
// The toolbar appears above/below the selected text element (slot text or
// freeform text box). It is mounted ONCE inside #album-canvas after every
// renderActivePage() call and is kept across re-renders via appendChild
// (because innerHTML = ... would otherwise wipe it).
//
// Coordinate system: the canvas is `position: relative`; the toolbar is
// `position: absolute` inside it. Position is computed in canvas-relative
// pixels from the target's `offsetLeft/Top/Width/Height`.

// State for the currently active text target. We track it explicitly so
// other handlers (e.g. Esc, click-elsewhere) can find what to clear.
// Returns the currently-selected text target descriptor, or null. Used by
// the canvas click handler and the keyboard handler to figure out what to
// commit/clear.
function getActiveTextTarget() {
  if (!state.layout) return null;
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page) return null;
  if (state.selectedFreeTextId != null) {
    const ft = (page.freeTexts || []).find((f) => f.id === state.selectedFreeTextId);
    if (!ft) return null;
    // The wrapper (.album-freetext) is what receives clicks because the
    // inner .album-freetext-content has pointer-events: none (so the
    // overlay handles can receive clicks on top). The wrapper itself
    // becomes the contenteditable host.
    const wrap = state.container.querySelector(`[data-ft-id="${state.selectedFreeTextId}"]`);
    if (!wrap) return null;
    return { kind: 'freetext', el: wrap, wrap, content: ft, page };
  }
  if (state.selectedSlotIdx != null
      && (state.selectedSlotType === 'title' || state.selectedSlotType === 'caption')) {
    const content = page.slots[state.selectedSlotIdx];
    if (!content || content.type === 'photo') return null;
    const wrap = state.container.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
    if (!wrap) return null;
    return { kind: 'slot', el: wrap, wrap, content, page };
  }
  return null;
}

// Normalize any color string to #rrggbb. Returns null for falsy.
function normalizeHexColor(v, fallback) {
  if (!v) return fallback || null;
  const s = String(v).trim();
  if (!s) return fallback || null;
  if (/^#([0-9a-f]{3})$/i.test(s)) {
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
    return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  }
  if (/^#([0-9a-f]{6})$/i.test(s)) return s.toLowerCase();
  return fallback || null;
}

// Build the toolbar DOM as a single absolute-positioned element.
function buildToolbarEl() {
  const wrap = document.createElement('div');
  wrap.id = 'album-text-toolbar';
  wrap.className = 'album-text-toolbar';
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="tt-row">
      <span class="tt-group tt-size">
        <button type="button" class="tt-btn" data-tt="size-down" title="缩小字号">A-</button>
        <input type="number" class="tt-num" data-tt="size-set" min="6" max="96" step="1" value="18"/>
        <span class="tt-unit">pt</span>
        <button type="button" class="tt-btn" data-tt="size-up" title="放大字号">A+</button>
      </span>
      <span class="tt-sep"></span>
      <span class="tt-group">
        <button type="button" class="tt-btn tt-b" data-tt="bold" title="加粗 (Ctrl+B)">B</button>
        <button type="button" class="tt-btn tt-i" data-tt="italic" title="斜体 (Ctrl+I)">I</button>
      </span>
      <span class="tt-sep"></span>
      <span class="tt-group">
        <button type="button" class="tt-btn" data-tt="align" data-align="left" title="左对齐">⇤</button>
        <button type="button" class="tt-btn" data-tt="align" data-align="center" title="居中">↔</button>
        <button type="button" class="tt-btn" data-tt="align" data-align="right" title="右对齐">⇥</button>
      </span>
      <span class="tt-sep"></span>
      <span class="tt-group">
        <button type="button" class="tt-btn tt-color" data-tt="text-color" title="文字颜色">
          <span class="tt-swatch" data-tt-swatch="fg"></span>
          <span class="tt-glyph">A</span>
        </button>
        <input type="color" data-tt="text-color-input" hidden/>
      </span>
      <span class="tt-sep tt-only-freetext"></span>
      <span class="tt-group tt-only-freetext">
        <button type="button" class="tt-btn tt-color" data-tt="bg-color" title="背景色">
          <span class="tt-swatch" data-tt-swatch="bg"></span>
          <span class="tt-glyph">▢</span>
        </button>
        <input type="color" data-tt="bg-color-input" hidden/>
      </span>
      <span class="tt-sep tt-only-freetext"></span>
      <span class="tt-group tt-only-freetext">
        <button type="button" class="tt-btn tt-color" data-tt="border-color" title="边框颜色">
          <span class="tt-swatch" data-tt-swatch="border"></span>
          <span class="tt-glyph">▭</span>
        </button>
        <input type="color" data-tt="border-color-input" hidden/>
      </span>
    </div>
    <div class="tt-popover" hidden>
      <div class="tt-popover-body">
        <div class="tt-pp-color-row">
          <input type="color" data-tt="pop-color"/>
          <input type="text" class="tt-pp-hex" data-tt="pop-hex" maxlength="7" placeholder="#rrggbb"/>
          <button type="button" class="tt-pp-clear" data-tt="pop-clear">无</button>
        </div>
      </div>
    </div>
  `;
  // Prevent the toolbar mousedown/click from bubbling to canvas (which
  // would immediately clear the selection).
  wrap.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  wrap.addEventListener('mousedown', (e) => { e.stopPropagation(); });
  wrap.addEventListener('click', (e) => { e.stopPropagation(); });
  return wrap;
}

// Lazily ensure the toolbar element exists in the canvas. Called after
// every renderActivePage() because innerHTML = ... wipes it.
function ensureToolbarMounted() {
  const canvas = state.container && state.container.querySelector('#album-canvas');
  if (!canvas) return null;
  let tb = canvas.querySelector('#album-text-toolbar');
  if (!tb) {
    tb = buildToolbarEl();
    canvas.appendChild(tb);
    wireToolbarGlobals(tb);
  }
  return tb;
}

// Wire the toolbar's static event handlers (called once on creation).
function wireToolbarGlobals(tb) {
  // Popover handling: clicking one of the three color buttons (text-color,
  // bg-color, border-color) opens a popover under it with color picker +
  // hex input + "无" clear. Only one popover open at a time.
  let openKind = null; // 'text-color' | 'bg-color' | 'border-color'
  const popover = tb.querySelector('.tt-popover');

  const closePopover = () => {
    popover.hidden = true;
    openKind = null;
  };

  const openPopover = (kind, anchorBtn) => {
    const target = getActiveTextTarget();
    if (!target) { closePopover(); return; }
    openKind = kind;
    // Position popover under the toolbar, centered.
    const tbRect = tb.getBoundingClientRect();
    const cvRect = state.container.querySelector('#album-canvas').getBoundingClientRect();
    popover.style.left = Math.max(0, Math.min(
      tbRect.left - cvRect.left + tbRect.width / 2 - 100,
      cvRect.width - 210
    )) + 'px';
    popover.style.top = (tbRect.bottom - cvRect.top + 6) + 'px';
    // Set the current value into the popover.
    const colorInput = popover.querySelector('[data-tt="pop-color"]');
    const hexInput = popover.querySelector('[data-tt="pop-hex"]');
    const clearBtn = popover.querySelector('[data-tt="pop-clear"]');
    let currentVal = null;
    if (kind === 'text-color') currentVal = target.content.color || null;
    else if (kind === 'bg-color') currentVal = target.content.backgroundColor || null;
    else if (kind === 'border-color') currentVal = target.content.borderColor || null;
    // Clear button only makes sense for bg + border (text color always has one)
    clearBtn.style.display = (kind === 'text-color') ? 'none' : '';
    colorInput.value = currentVal ? normalizeHexColor(currentVal, '#000000') : '#000000';
    hexInput.value = currentVal || '';
    popover.hidden = false;
    // Wire popover events scoped to this open
    const onColorChange = (e) => {
      const v = e.target.value;
      hexInput.value = v;
      applyToolbarColor(kind, v);
    };
    const onHexChange = (e) => {
      const v = normalizeHexColor(e.target.value, null);
      if (v) {
        colorInput.value = v;
        applyToolbarColor(kind, v);
      }
    };
    const onClear = () => {
      applyToolbarColor(kind, null);
      hexInput.value = '';
      popover.hidden = true;
      openKind = null;
    };
    colorInput.oninput = onColorChange;
    hexInput.oninput = onHexChange;
    clearBtn.onclick = onClear;
  };

  // After a toolbar button click, refocus the contenteditable so the
  // user can keep typing without re-clicking the text. The click already
  // blurred the contenteditable (since the click target was outside it).
  function refocusTarget() {
    const tgt = getActiveTextTarget();
    if (tgt && tgt.el && tgt.el.contentEditable === 'true') {
      tgt.el.focus();
    }
  }

  tb.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tt]');
    if (!t) return;
    const act = t.getAttribute('data-tt');
    const tgt = getActiveTextTarget();
    if (!tgt) return;
    if (act === 'size-down' || act === 'size-up' || act === 'size-set') {
      e.preventDefault();
      const isSlot = tgt.kind === 'slot';
      const baseFont = isSlot
        ? computeBaseFontForSlot(tgt.content)
        : 18;
      const cur = isSlot
        ? Math.round((tgt.content.fontScale || 1) * baseFont)
        : (tgt.content.fontSize || 18);
      let next = cur;
      if (act === 'size-down') next = cur - 1;
      else if (act === 'size-up') next = cur + 1;
      else if (act === 'size-set') {
        const n = Number(t.value);
        if (Number.isFinite(n)) next = n;
      }
      next = Math.max(6, Math.min(96, next));
      if (isSlot) {
        tgt.content.fontScale = next / baseFont;
        // Re-render the slot DOM with new size
        renderActivePage();
        // Re-apply selection + re-mount toolbar
        remountSelectionAfterRender();
      } else {
        tgt.content.fontSize = next;
        const scale = state.canvasPx.scale || 1;
        tgt.el.style.fontSize = (next * scale) + 'px';
        commitToolbarHistory();
        refocusTarget();
      }
      // Update input field
      const inp = tb.querySelector('[data-tt="size-set"]');
      if (inp) inp.value = String(next);
      return;
    }
    if (act === 'bold' || act === 'italic') {
      e.preventDefault();
      if (tgt.kind === 'slot') {
        if (act === 'bold') tgt.content.bold = !tgt.content.bold;
        else tgt.content.italic = !tgt.content.italic;
        renderActivePage();
        remountSelectionAfterRender();
      } else {
        if (act === 'bold') {
          tgt.content.fontWeight = tgt.content.fontWeight === 'bold' ? 'normal' : 'bold';
          tgt.el.style.fontWeight = tgt.content.fontWeight === 'bold' ? 700 : 400;
        } else {
          tgt.content.fontStyle = tgt.content.fontStyle === 'italic' ? 'normal' : 'italic';
          tgt.el.style.fontStyle = tgt.content.fontStyle;
        }
        commitToolbarHistory();
        refocusTarget();
      }
      updateToolbarState();
      return;
    }
    if (act === 'align') {
      e.preventDefault();
      const a = t.getAttribute('data-align');
      if (!a) return;
      tgt.content.textAlign = a;
      if (tgt.kind === 'slot') {
        // Re-render so .album-text wrapper picks up text-align
        renderActivePage();
        remountSelectionAfterRender();
      } else {
        // FreeText: text-align is on the inner contenteditable
        tgt.el.style.textAlign = a;
        commitToolbarHistory();
        refocusTarget();
      }
      updateToolbarState();
      return;
    }
    if (act === 'text-color' || act === 'bg-color' || act === 'border-color') {
      e.preventDefault();
      if (openKind === act) {
        closePopover();
      } else {
        openPopover(act, t);
      }
      return;
    }
    if (act === 'text-color-input' || act === 'bg-color-input' || act === 'border-color-input') {
      // Hidden inputs; nothing to do here (their change handlers are below)
      return;
    }
  });
  // Also wire the hidden color inputs to act as fallback triggers
  ['text-color-input', 'bg-color-input', 'border-color-input'].forEach((kind) => {
    const inp = tb.querySelector(`[data-tt="${kind}"]`);
    if (inp) inp.onchange = (e) => {
      const realKind = kind.replace('-input', '');
      applyToolbarColor(realKind, e.target.value);
    };
  });
  // Close popover on outside click
  document.addEventListener('mousedown', (e) => {
    if (popover.hidden) return;
    if (e.target.closest('.tt-popover')) return;
    if (e.target.closest('.tt-color')) return;
    popover.hidden = true;
    openKind = null;
  }, true);
}

// Apply a color change to the active target, from the popover.
function applyToolbarColor(kind, value) {
  const tgt = getActiveTextTarget();
  if (!tgt) return;
  if (kind === 'text-color') {
    if (!value) return;
    tgt.content.color = normalizeHexColor(value, '#2a2a2a');
    tgt.el.style.color = tgt.content.color;
  } else if (kind === 'bg-color') {
    tgt.content.backgroundColor = value ? normalizeHexColor(value, '#ffffff') : null;
    if (tgt.kind === 'freetext') {
      tgt.wrap.style.backgroundColor = tgt.content.backgroundColor || 'transparent';
    }
  } else if (kind === 'border-color') {
    tgt.content.borderColor = value ? normalizeHexColor(value, '#000000') : null;
    if (tgt.content.borderColor && !tgt.content.borderWidth) tgt.content.borderWidth = 1;
    if (tgt.kind === 'freetext') {
      if (tgt.content.borderColor && tgt.content.borderWidth) {
        const wpx = Math.max(1, Math.round(tgt.content.borderWidth * (state.canvasPx.scale || 1)));
        tgt.wrap.style.border = `${wpx}px solid ${tgt.content.borderColor}`;
      } else {
        tgt.wrap.style.border = 'none';
      }
    }
  }
  commitToolbarHistory();
  updateToolbarState();
  // Refocus the contenteditable so the user can keep typing after
  // picking a color (the color picker steals focus from the editor).
  const tgt2 = getActiveTextTarget();
  if (tgt2 && tgt2.el && tgt2.el.contentEditable === 'true') {
    tgt2.el.focus();
  }
}

// Push a single history snapshot for toolbar-driven edits. We throttle
// slightly to avoid one snapshot per pixel of a slider drag.
let _ttHistoryTimer = null;
function commitToolbarHistory() {
  if (_ttHistoryTimer) return;
  _ttHistoryTimer = setTimeout(() => {
    _ttHistoryTimer = null;
    pushHistory();
  }, 400);
}

// Re-select the same text target after a renderActivePage() (which wipes
// the contenteditable focus + toolbar position). Used by toolbar buttons
// that need a full re-render (slot fontScale/bold/italic/align).
function remountSelectionAfterRender() {
  const target = getActiveTextTarget();
  if (!target) return;
  // Re-find the el after re-render (DOM was rebuilt)
  const newEl = target.kind === 'freetext'
    ? state.container.querySelector(`[data-ft-id="${state.selectedFreeTextId}"]`)
    : state.container.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
  if (newEl) target.el = newEl;
  mountFloatingToolbar();
  // For slots, focus and place caret
  if (target.kind === 'slot' && newEl) {
    newEl.contentEditable = 'true';
    newEl.focus();
    placeCaretAtEnd(newEl);
  }
}

// Place the caret at the end of an element's text content.
function placeCaretAtEnd(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch (_) { /* ignore */ }
}

// Compute the base font (pt) for a slot text given the template + theme.
// Mirrors the calculation in renderSlot() so the toolbar's number field
// matches the visible size.
function computeBaseFontForSlot(content) {
  // Approximation: title = 28, caption = 16. Use type to pick.
  return content.type === 'title' ? 28 : 16;
}

// Show the toolbar and populate it with the current target's values, then
// position it next to the element. Called by onCanvasSlotPointerDown,
// onFreeTextPointerDown (select branch), and remountSelectionAfterRender.
function mountFloatingToolbar() {
  const tb = ensureToolbarMounted();
  if (!tb) return;
  const target = getActiveTextTarget();
  if (!target) {
    tb.hidden = true;
    return;
  }
  tb.dataset.target = target.kind;
  // Toggle freetext-only buttons
  tb.querySelectorAll('.tt-only-freetext').forEach((el) => {
    el.style.display = (target.kind === 'freetext') ? '' : 'none';
  });
  updateToolbarState();
  tb.hidden = false;
  // Enable contenteditable on the inner element so user can type directly
  if (target.el.contentEditable !== 'true') {
    target.el.contentEditable = 'true';
    target.el.classList.add('is-editing');
    target.el.addEventListener('input', onInlineEditInput, false);
    target.el.addEventListener('blur', onInlineEditBlur, false);
    target.el.addEventListener('keydown', onInlineEditKeydown, false);
    target.el.addEventListener('paste', onInlineEditPaste, false);
  }
  positionFloatingToolbar();
  // Focus + caret at end (so user can immediately type). We ALWAYS place
  // the caret (not just when focus was needed), so the caret position is
  // predictable regardless of whether the pre-render focus() in
  // onCanvasSlotPointerDown already landed.
  if (document.activeElement !== target.el) target.el.focus();
  placeCaretAtEnd(target.el);
  // Belt-and-suspenders: positionFloatingToolbar schedules an rAF that
  // changes the toolbar's left/top — the resulting reflow can cause
  // Chromium to clear the selection range inside the contenteditable
  // (selection is invalidated when its container's layout shifts).
  // Re-assert focus + caret placement on the next tick to be sure.
  setTimeout(() => {
    const t = getActiveTextTarget();
    if (t && t.el && t.el.contentEditable === 'true') {
      if (document.activeElement !== t.el) t.el.focus();
      placeCaretAtEnd(t.el);
    }
  }, 60);
}

// Update toolbar button active states / current values from the target.
function updateToolbarState() {
  const tb = state.container && state.container.querySelector('#album-text-toolbar');
  if (!tb) return;
  const target = getActiveTextTarget();
  if (!target) return;
  const isSlot = target.kind === 'slot';
  // Font size
  const baseFont = isSlot ? computeBaseFontForSlot(target.content) : 18;
  const cur = isSlot
    ? Math.round((target.content.fontScale || 1) * baseFont)
    : (target.content.fontSize || 18);
  const sizeInp = tb.querySelector('[data-tt="size-set"]');
  if (sizeInp && document.activeElement !== sizeInp) sizeInp.value = String(cur);
  // Bold
  const boldBtn = tb.querySelector('[data-tt="bold"]');
  const isBold = isSlot ? !!target.content.bold : (target.content.fontWeight === 'bold');
  if (boldBtn) boldBtn.classList.toggle('is-active', isBold);
  // Italic
  const italicBtn = tb.querySelector('[data-tt="italic"]');
  const isItalic = isSlot ? !!target.content.italic : (target.content.fontStyle === 'italic');
  if (italicBtn) italicBtn.classList.toggle('is-active', isItalic);
  // Align
  const align = target.content.textAlign || (isSlot
    ? (target.content.type === 'title' ? 'center' : 'left')
    : 'left');
  tb.querySelectorAll('[data-tt="align"]').forEach((b) => {
    b.classList.toggle('is-active', b.getAttribute('data-align') === align);
  });
  // Color swatches
  const fgSwatch = tb.querySelector('[data-tt-swatch="fg"]');
  if (fgSwatch) {
    const theme = getTheme(state.layout.themeId);
    const c = normalizeHexColor(target.content.color, theme.cssVar.text || '#2a2a2a');
    fgSwatch.style.background = c;
  }
  if (target.kind === 'freetext') {
    const bgSwatch = tb.querySelector('[data-tt-swatch="bg"]');
    if (bgSwatch) bgSwatch.style.background = target.content.backgroundColor || 'transparent';
    const borderSwatch = tb.querySelector('[data-tt-swatch="border"]');
    if (borderSwatch) borderSwatch.style.background = target.content.borderColor || 'transparent';
  }
}

// Position the toolbar above (or below if not enough room) the target's
// wrapper, in canvas-relative coordinates.
function positionFloatingToolbar() {
  const tb = state.container && state.container.querySelector('#album-text-toolbar');
  if (!tb || tb.hidden) return;
  const target = getActiveTextTarget();
  if (!target) { tb.hidden = true; return; }
  const canvas = state.container.querySelector('#album-canvas');
  if (!canvas) return;
  // Defer to next frame so toolbar has been laid out
  requestAnimationFrame(() => {
    const wrapRect = target.wrap.getBoundingClientRect();
    const cvRect = canvas.getBoundingClientRect();
    const tbW = tb.offsetWidth || 360;
    const tbH = tb.offsetHeight || 36;
    let left = wrapRect.left - cvRect.left + wrapRect.width / 2 - tbW / 2;
    let top = wrapRect.top - cvRect.top - tbH - 10;
    if (top < 0) {
      // Flip below
      top = wrapRect.bottom - cvRect.top + 10;
    }
    // Clamp horizontally
    left = Math.max(0, Math.min(left, cvRect.width - tbW));
    tb.style.left = left + 'px';
    tb.style.top = top + 'px';
  });
}

// ---- contenteditable event handlers ----------------------------------------

let _ttEditTimer = null;
function onInlineEditInput(e) {
  const target = getActiveTextTarget();
  if (!target) return;
  // Sync text to model. Use innerText (not textContent) to preserve \n.
  const txt = e.target.innerText.replace(/ /g, ' '); // nbsp → space
  target.content.text = txt;
  // Debounce a single history push
  if (_ttEditTimer) clearTimeout(_ttEditTimer);
  _ttEditTimer = setTimeout(() => {
    _ttEditTimer = null;
    commitToolbarHistory();
  }, 600);
}

function onInlineEditBlur(e) {
  // When the text click path focuses the pre-render element, that element
  // gets detached and its blur fires. We tagged it with suppressBlur so the
  // model/DOM stays untouched (the new element after re-render will be the
  // active target).
  if (e && e.target && e.target.dataset && e.target.dataset.suppressBlur === '1') return;
  const target = getActiveTextTarget();
  if (!target) return;
  // Normalize: re-write the innerText back to drop any browser-injected
  // <br>/<div> wrappers. For freeform text the wrapper contains an
  // absolutely-positioned overlay (resize handles) so we cannot use
  // innerText there (it would clobber the overlay). Instead, for freeText
  // we just sync the model from innerText and don't touch the DOM; for
  // slot text (which has only a text node inside) innerText round-trips
  // safely and cleans up stray <br>/<div>.
  const txt = (e.target.innerText || '').replace(/ /g, ' ').replace(/\n+$/, '');
  target.content.text = txt;
  if (target.kind === 'slot') {
    e.target.innerText = target.content.text;
    e.target.contentEditable = 'false';
    e.target.classList.remove('is-editing');
    e.target.removeEventListener('input', onInlineEditInput, false);
    e.target.removeEventListener('blur', onInlineEditBlur, false);
    e.target.removeEventListener('keydown', onInlineEditKeydown, false);
    e.target.removeEventListener('paste', onInlineEditPaste, false);
    commitToolbarHistory();
    return;
  }
  // freeText: schedule a re-render so the model text matches the DOM
  // (renderActivePage rebuilds the wrapper from escapeHtml(ft.text)).
  e.target.contentEditable = 'false';
  e.target.classList.remove('is-editing');
  e.target.removeEventListener('input', onInlineEditInput, false);
  e.target.removeEventListener('blur', onInlineEditBlur, false);
  e.target.removeEventListener('keydown', onInlineEditKeydown, false);
  e.target.removeEventListener('paste', onInlineEditPaste, false);
  if (typeof renderActivePage === 'function') renderActivePage();
  commitToolbarHistory();
}

function onInlineEditKeydown(e) {
  // Ctrl+B / Ctrl+I for bold/italic from keyboard inside the editor
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); document.querySelector('[data-tt="bold"]').click(); return; }
    if (k === 'i') { e.preventDefault(); document.querySelector('[data-tt="italic"]').click(); return; }
  }
  // Enter handling: convert to \n (prevent browser from inserting <br>/<div>)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // Insert a newline at the caret
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const tn = document.createTextNode('\n');
    range.insertNode(tn);
    range.setStartAfter(tn);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    // Trigger input handler to sync model
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function onInlineEditPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
  // Insert plain text at caret
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const tn = document.createTextNode(text);
  range.insertNode(tn);
  range.setStartAfter(tn);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  e.target.dispatchEvent(new Event('input', { bubbles: true }));
}

// Hide toolbar and exit contenteditable for the active target, if any.
// Called when clicking empty canvas, pressing Esc, etc.
function clearTextSelection() {
  // Exit contenteditable on the active element, if still editing
  const target = getActiveTextTarget();
  if (target && target.el.contentEditable === 'true') {
    const txt = (target.el.innerText || '').replace(/ /g, ' ').replace(/\n+$/, '');
    target.content.text = txt;
    target.el.contentEditable = 'false';
    target.el.classList.remove('is-editing');
  }
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.selectedFreeTextId = null;
  const tb = state.container && state.container.querySelector('#album-text-toolbar');
  if (tb) {
    tb.hidden = true;
    const popover = tb.querySelector('.tt-popover');
    if (popover) popover.hidden = true;
  }
  // Also clear contenteditable listeners
  if (target) {
    target.el.removeEventListener('input', onInlineEditInput);
    target.el.removeEventListener('blur', onInlineEditBlur);
    target.el.removeEventListener('keydown', onInlineEditKeydown);
    target.el.removeEventListener('paste', onInlineEditPaste);
  }
}

// ---- mount / destroy --------------------------------------------------------

export function mountEditor({ container, events, onBack, onExport }) {
  state.container = container;
  state.events = events || [];
  state.eventById = new Map(state.events.map((e) => [e.id, e]));
  state.photoById = new Map();
  state.events.forEach((e) => {
    (e.photos || []).forEach((p) => state.photoById.set(p.id, { ...p, eventId: e.id }));
  });
  state.onBack = onBack;
  state.onExport = onExport;

  // Build initial layout
  state.layout = buildAlbumLayout(state.events, { themeId: 'classic' });
  ensurePageShape(state.layout);
  state.selectedPageIdx = 0;
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.editingPhotoSlotIdx = null;
  state.photoUrls = new Map();
  state.swapArmed = null;
  state.swapLog = new Set();
  state.customPanelOpen = false;
  state.history = [];
  state.historyIdx = -1;
  state.selectedFreeTextId = null;
  state.freeTextDrag = null;
  state.freeTextResize = null;

  renderShell();
  applyTheme(state.layout.themeId);
  computeCanvasSize();
  renderPageThumbs();
  renderActivePage();
  renderPhotoPalette();
  renderCustomPanel();
  setupResizeObserver();
  // Pre-warm the photo URL cache for the current page (immediately)
  // and for every page (so page thumbnails can paint real images).
  prefetchPagePhotos(state.selectedPageIdx);
  prefetchAllPhotos();
  // Pull post-orientation dimensions from the main process. This keeps
  // the editor's cover-fit math consistent with the PDF side, which uses
  // pdfkit's openImage() and thus sees the rotated dims for portrait
  // phone shots. Re-render the canvas once metas arrive.
  prefetchAllMetas().then(() => {
    if (!state.container || !state.layout) return;
    renderPageThumbs();
    renderActivePage();
  });
  // Seed the undo history with the initial layout so the first user
  // action can be undone.
  pushHistory();
  // Global keyboard shortcuts
  state._keydown = onEditorKeydown;
  window.addEventListener('keydown', state._keydown, { capture: true });
}

// Resolve and cache post-orientation width/height for every photo in the
// current layout. Sets `photo.orientation = 0` and writes `photo.width /
// height` from the meta result so that `applyExifOrientation` becomes a
// no-op for them (the dims are already rotated).
function prefetchAllMetas() {
  const ids = new Set();
  state.layout.pages.forEach((page) => {
    page.slots.forEach((s) => { if (s.photoId) ids.add(s.photoId); });
  });
  state.events.forEach((ev) => {
    (ev.photos || []).forEach((p) => { if (p.id) ids.add(p.id); });
  });
  return Promise.all(Array.from(ids).map((id) => fetchPhotoMeta(id).then((m) => {
    if (!m || !m.width || !m.height) return;
    const photo = state.photoById.get(id);
    if (!photo) return;
    // Mark orientation as already-applied (0) and overwrite width/height
    // with post-orientation dims. applyExifOrientation will then be a
    // no-op for this photo.
    photo.width = m.width;
    photo.height = m.height;
    photo.orientation = 0;
  })));
}

export function destroyEditor() {
  if (state.resizeObserver) {
    try { state.resizeObserver.disconnect(); } catch {}
    state.resizeObserver = null;
  }
  if (state._keydown) {
    window.removeEventListener('keydown', state._keydown, { capture: true });
    state._keydown = null;
  }
  // Release the gesture guards FIRST, while `state.container` is still
  // valid. A guard that still holds a pointer id would otherwise cancel
  // the NEXT editor's first gesture (the guards are module level and
  // outlive the editor instance), and its teardown handler reaches into
  // `state.container`.
  photoDragGuard.cancel();
  freeTextDragGuard.cancel();
  freeTextResizeGuard.cancel();
  photoPanGuard.cancel();
  textPanGuard.cancel();
  cleanupDrag();
  if (state.photoPan) {
    state.photoPan = null;
    window.removeEventListener('pointermove', onWindowPhotoPanMove, { capture: true });
    window.removeEventListener('pointerup', onWindowPhotoPanUp, { capture: true });
    window.removeEventListener('pointercancel', onWindowPhotoPanCancel, { capture: true });
  }
  if (state.textPan) {
    state.textPan = null;
    window.removeEventListener('pointermove', onWindowTextPanMove, { capture: true });
    window.removeEventListener('pointerup', onWindowTextPanUp, { capture: true });
    window.removeEventListener('pointercancel', onWindowTextPanCancel, { capture: true });
  }
  if (state.freeTextDrag) {
    state.freeTextDrag = null;
    window.removeEventListener('pointermove', onWindowFreeTextMove, { capture: true });
    window.removeEventListener('pointerup', onWindowFreeTextUp, { capture: true });
    window.removeEventListener('pointercancel', onWindowFreeTextCancel, { capture: true });
  }
  if (state.freeTextResize) {
    state.freeTextResize = null;
    window.removeEventListener('pointermove', onWindowFreeTextResize, { capture: true });
    window.removeEventListener('pointerup', onWindowFreeTextResizeUp, { capture: true });
    window.removeEventListener('pointercancel', onWindowFreeTextResizeCancel, { capture: true });
  }
  state.container = null;
  state.layout = null;
  state.events = [];
  state.eventById = new Map();
  state.photoById = new Map();
  state.photoUrls = new Map();
  state.swapArmed = null;
  state.swapLog = new Set();
  state.history = [];
  state.historyIdx = -1;
  state.customPanelOpen = false;
  state.selectedFreeTextId = null;
  state.freeTextDrag = null;
  state.freeTextResize = null;
}

// ---- render: shell ---------------------------------------------------------

function renderShell() {
  state.container.innerHTML = `
    <div class="album-editor" data-theme="${escapeHtml(state.layout.themeId)}">
      <div class="album-toolbar">
        <button class="btn secondary" id="album-back-btn" type="button">← 返回筛选</button>
        <div class="album-toolbar-spacer"></div>
        <button class="btn secondary" id="album-undo-btn" type="button" disabled title="撤销 (Ctrl+Z)">↶</button>
        <button class="btn secondary" id="album-redo-btn" type="button" disabled title="重做 (Ctrl+Y)">↷</button>
        <button class="btn secondary" id="album-custom-btn" type="button" title="查看自定义项">
          自定义 <span class="album-custom-dot-count" id="album-custom-dot-count"></span>
        </button>
        <label class="album-toolbar-field">
          <span>主题</span>
          <select id="album-theme-select">
            ${THEMES.map((t) => `<option value="${escapeHtml(t.id)}" ${
              t.id === state.layout.themeId ? 'selected' : ''
            }>${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </label>
        <label class="album-toolbar-field" id="album-template-toolbar-field" style="display:none;">
          <span>版式</span>
          <select id="album-template-select">
            ${LAYOUT_TEMPLATES.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn secondary" id="album-add-text-btn" type="button" title="在当前页插入浮动文本框">+ 文本</button>
        <button class="btn" id="album-export-btn" type="button">导出 PDF</button>
      </div>
      <div class="album-custom-panel" id="album-custom-panel" hidden>
        <div class="album-custom-col" data-custom-kind="ratio">
          <div class="album-custom-col-head">
            <span class="album-dot album-dot-blue"></span>
            <span>宽高比（自定义缩放）</span>
            <button class="album-custom-reset" data-reset-kind="ratio" type="button">全部重置</button>
          </div>
          <div class="album-custom-col-list" id="album-custom-ratio-list"></div>
        </div>
        <div class="album-custom-col" data-custom-kind="order">
          <div class="album-custom-col-head">
            <span class="album-dot album-dot-green"></span>
            <span>顺序（换过槽位）</span>
            <button class="album-custom-reset" data-reset-kind="order" type="button">全部重置</button>
          </div>
          <div class="album-custom-col-list" id="album-custom-order-list"></div>
        </div>
        <div class="album-custom-col" data-custom-kind="caption-pos">
          <div class="album-custom-col-head">
            <span class="album-dot album-dot-violet"></span>
            <span>描述位置</span>
            <button class="album-custom-reset" data-reset-kind="caption-pos" type="button">全部重置</button>
          </div>
          <div class="album-custom-col-list" id="album-custom-caption-list"></div>
        </div>
        <div class="album-custom-col" data-custom-kind="freetext">
          <div class="album-custom-col-head">
            <span class="album-dot album-dot-amber"></span>
            <span>浮动文本框</span>
            <button class="album-custom-reset" data-reset-kind="freetext" type="button">全部清除</button>
          </div>
          <div class="album-custom-col-list" id="album-custom-freetext-list"></div>
        </div>
      </div>
      <div class="album-body">
        <aside class="album-side album-side-left">
          <div class="album-side-title">页面 <span id="album-page-count">${state.layout.pages.length}</span></div>
          <div class="album-page-thumbs" id="album-page-thumbs"></div>
          <button class="btn secondary album-add-page" id="album-add-page-btn" type="button">+ 新页</button>
        </aside>
        <main class="album-canvas-wrap" id="album-canvas-wrap">
          <div class="album-canvas" id="album-canvas" data-theme="${escapeHtml(state.layout.themeId)}"></div>
        </main>
        <aside class="album-side album-side-right" id="album-inspector"></aside>
      </div>
      <div class="album-palette" id="album-palette">
        <div class="album-palette-title">照片 · 拖到画布</div>
        <div class="album-palette-strip" id="album-palette-strip"></div>
      </div>
    </div>
  `;
  // Wire shell-level handlers
  state.container.querySelector('#album-back-btn').onclick = handleBack;
  state.container.querySelector('#album-export-btn').onclick = handleExport;
  state.container.querySelector('#album-add-text-btn').onclick = handleAddFreeText;
  state.container.querySelector('#album-theme-select').onchange = (e) => {
    state.layout.themeId = e.target.value;
    applyTheme(state.layout.themeId);
    // Theme change doesn't move slots, just colors. Re-render canvas only.
    renderActivePage();
  };
  const tplSelect = state.container.querySelector('#album-template-select');
  tplSelect.onchange = (e) => handleChangePageTemplate(state.selectedPageIdx, e.target.value);
  // Page thumb strip + add page
  state.container.querySelector('#album-add-page-btn').onclick = handleAddPage;
  // Palette drag
  state.container.querySelector('#album-palette-strip').onpointerdown = onPalettePointerDown;
  // Undo/redo
  state.container.querySelector('#album-undo-btn').onclick = undo;
  state.container.querySelector('#album-redo-btn').onclick = redo;
  // Customizations panel toggle
  state.container.querySelector('#album-custom-btn').onclick = toggleCustomPanel;
  // Customizations column reset buttons
  state.container.querySelectorAll('.album-custom-reset').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      resetCustomization(btn.getAttribute('data-reset-kind'));
    };
  });
  updateUndoRedoButtons();
}

function applyTheme(themeId) {
  const root = state.container.querySelector('.album-editor');
  if (!root) return;
  root.setAttribute('data-theme', themeId);
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.setAttribute('data-theme', themeId);
  const theme = getTheme(themeId);
  // Set CSS custom properties on the canvas wrapper so both editor chrome
  // and inner slots pick them up uniformly
  const wrap = state.container.querySelector('#album-canvas-wrap');
  if (wrap) {
    wrap.style.setProperty('--theme-bg', theme.cssVar.bg);
    wrap.style.setProperty('--theme-surface', theme.cssVar.surface);
    wrap.style.setProperty('--theme-text', theme.cssVar.text);
    wrap.style.setProperty('--theme-muted', theme.cssVar.muted);
    wrap.style.setProperty('--theme-accent', theme.cssVar.accent);
    wrap.style.setProperty('--theme-accent-dark', theme.cssVar.accentDark);
    wrap.style.setProperty('--theme-ribbon', theme.cssVar.ribbon);
    wrap.style.setProperty('--theme-title-size', `${theme.size.title}pt`);
    wrap.style.setProperty('--theme-body-size', `${theme.size.body}pt`);
    wrap.style.setProperty('--theme-caption-size', `${theme.size.caption}pt`);
  }
}

function setupResizeObserver() {
  const wrap = state.container.querySelector('#album-canvas-wrap');
  if (!wrap || typeof ResizeObserver === 'undefined') return;
  if (state.resizeObserver) {
    try { state.resizeObserver.disconnect(); } catch {}
  }
  state.resizeObserver = new ResizeObserver(() => {
    computeCanvasSize();
    renderActivePage();
  });
  state.resizeObserver.observe(wrap);
}

function computeCanvasSize() {
  const wrap = state.container.querySelector('#album-canvas-wrap');
  if (!wrap) return;
  // Use a small inset so the canvas isn't flush against the inspector
  const availW = Math.max(280, wrap.clientWidth - 24);
  const availH = Math.max(220, wrap.clientHeight - 24);
  // Maintain theme page AR
  const pageDims = getPageDims(state.layout.pageShape);
  const pageAR = pageDims.w / pageDims.h;
  let w = availW;
  let h = w / pageAR;
  if (h > availH) {
    h = availH;
    w = h * pageAR;
  }
  state.canvasPx = { w, h, scale: w / pageDims.w };
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
}

// ---- render: page thumbs ----------------------------------------------------

function renderPageThumbs() {
  const wrap = state.container.querySelector('#album-page-thumbs');
  if (!wrap) return;
  const total = state.layout.pages.length;
  document.getElementById('album-page-count').textContent = String(total);
  const html = [];
  for (let i = 0; i < total; i += 1) {
    const page = state.layout.pages[i];
    const tpl = getLayoutTemplate(page.templateId);
    const photoCount = page.slots.filter((s) => s.type === 'photo' && s.photoId).length;
    const textCount = page.slots.filter((s) => s.type !== 'photo').length;
    const isActive = i === state.selectedPageIdx;
    html.push(`
      <button type="button"
        class="album-page-thumb ${isActive ? 'is-active' : ''}"
        data-page-idx="${i}">
        <div class="album-page-thumb-num">${i + 1}</div>
        <canvas class="album-page-thumb-mini" data-page-thumb-idx="${i}" width="80" height="52"></canvas>
        <div class="album-page-thumb-meta">${photoCount}图·${textCount}文</div>
      </button>
    `);
  }
  wrap.innerHTML = html.join('');
  wrap.querySelectorAll('.album-page-thumb').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-page-idx'));
      selectPage(idx);
    };
  });
  // Render mini previews of each page. Defer to next frame so layout has
  // settled and so we can coalesce multiple paint calls.
  for (let i = 0; i < total; i += 1) {
    const mini = wrap.querySelector(`canvas[data-page-thumb-idx="${i}"]`);
    if (mini) scheduleMiniPaint(mini, state.layout.pages[i]);
  }
}

// ---- page thumbnail painter (cheap canvas draw) -----------------------------
// 80x52 pixels is small; we draw a cover-style photo fill for each photo
// slot that has its dataUrl cached, a gray block for empty photo slots, and
// a single horizontal "text placeholder" line for text slots. The result
// reads as a faithful layout sketch while staying O(1) per page.

function scheduleMiniPaint(canvasEl, page) {
  requestAnimationFrame(() => {
    if (!canvasEl || !canvasEl.isConnected) return;
    renderPageMini(canvasEl, page);
  });
}

function renderPageMini(canvasEl, page) {
  const W = 80;
  const H = 52;
  const ctx = canvasEl.getContext('2d');
  if (!ctx) return;
  const theme = getTheme(state.layout.themeId);
  // background
  ctx.fillStyle = theme.cssVar.surface || '#f8f8f8';
  ctx.fillRect(0, 0, W, H);
  const tpl = getLayoutTemplate(page.templateId);
  for (const s of tpl.slots) {
    const r = slotRect(s, W, H, 2);
    const content = page.slots.find((ps) =>
      ps._slotTemplate
      && ps._slotTemplate.x === s.x
      && ps._slotTemplate.y === s.y
      && ps._slotTemplate.w === s.w
      && ps._slotTemplate.h === s.h
    );
    if (s.type === 'photo') {
      const photoId = content && content.photoId;
      const url = photoId ? state.photoUrls.get(photoId) : null;
      if (url) {
        const img = getCachedMiniImage(url);
        if (img) {
          // Cover-style draw
          const scale = Math.max(r.w / img.width, r.h / img.height);
          const dw = img.width * scale;
          const dh = img.height * scale;
          ctx.drawImage(img, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
          continue;
        }
      }
      // Empty photo slot or not yet loaded
      ctx.fillStyle = photoId ? '#bbb' : '#e3e3e3';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    } else {
      // Text slot: draw a soft surface bar with a single short line
      ctx.fillStyle = theme.cssVar.bg || '#ffffff';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = theme.cssVar.muted || '#888';
      const lineY = r.y + r.h / 2 - 1;
      ctx.fillRect(r.x + 2, lineY, Math.max(8, r.w * 0.6), 2);
    }
  }
  // Free-form text boxes (PT-absolute → 80×52 mini). Draw a thin accent
  // outline + tiny "T" so users can tell at a glance that there's a
  // floating text frame on this page.
  const fts = page.freeTexts || [];
  if (fts.length) {
    const pDims = getPageDims(state.layout.pageShape);
    for (const ft of fts) {
      const fx = (ft.x / pDims.w) * W;
      const fy = (ft.y / pDims.h) * H;
      const fw = (ft.w / pDims.w) * W;
      const fh = (ft.h / pDims.h) * H;
      ctx.save();
      ctx.strokeStyle = theme.cssVar.accent || '#f4a8a0';
      ctx.lineWidth = 1;
      ctx.strokeRect(fx + 0.5, fy + 0.5, Math.max(2, fw - 1), Math.max(2, fh - 1));
      // Optional background tint
      if (ft.backgroundColor) {
        try {
          ctx.fillStyle = ft.backgroundColor;
          ctx.globalAlpha = 0.35;
          ctx.fillRect(fx, fy, fw, fh);
        } catch {}
        ctx.globalAlpha = 1;
      }
      // Tiny "T" indicator in top-left of the frame
      ctx.fillStyle = theme.cssVar.accent || '#f4a8a0';
      ctx.font = 'bold 7px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('T', Math.min(fx + 2, fx + fw - 6), Math.min(fy + 1, fy + fh - 8));
      ctx.restore();
    }
  }
  // Thin border
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}

// Tiny image cache keyed by dataUrl. Same image can be reused by the
// photo palette thumbnails and by the page-thumbnail painter.
const _miniImgCache = new Map();
function getCachedMiniImage(url) {
  const cached = _miniImgCache.get(url);
  if (cached && cached.complete) return cached;
  if (cached) return null; // still loading
  const img = new Image();
  _miniImgCache.set(url, img);
  img.onload = () => {
    // Once an image loads, repaint every page thumbnail that's on screen.
    const wrap = state.container && state.container.querySelector('#album-page-thumbs');
    if (wrap) {
      wrap.querySelectorAll('canvas[data-page-thumb-idx]').forEach((c) => {
        const idx = Number(c.getAttribute('data-page-thumb-idx'));
        if (state.layout && state.layout.pages[idx]) {
          scheduleMiniPaint(c, state.layout.pages[idx]);
        }
      });
    }
  };
  img.src = url;
  return null;
}

function selectPage(idx) {
  if (idx < 0 || idx >= state.layout.pages.length) return;
  state.selectedPageIdx = idx;
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.editingPhotoSlotIdx = null;
  state.selectedFreeTextId = null;
  renderPageThumbs();
  renderActivePage();
}

// ---- render: active page canvas ---------------------------------------------

function renderActivePage() {
  const canvas = state.container.querySelector('#album-canvas');
  if (!canvas) return;
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page) {
    canvas.innerHTML = `<div class="album-empty">空相册</div>`;
    return;
  }
  const tpl = getLayoutTemplate(page.templateId);
  const pageDims = getPageDims(state.layout.pageShape);
  const pw = state.canvasPx.w;
  const ph = state.canvasPx.h;
  // Build slot DOM in original template order so we can map back to slotIdx
  // via the same index. We also tag each photo slot with its photoId so
  // the drop handler can resolve which slot was hit.
  const theme = getTheme(state.layout.themeId);

  // Decorative ribbon (theme-driven)
  let deco = '';
  if (theme.chrome && theme.chrome.showRibbon) {
    deco += `<div class="album-ribbon album-ribbon-left"></div>`;
  }

  const slotsHtml = tpl.slots.map((slot, slotIdx) => {
    // Find the actual content slot for this template slot. Because builder
    // creates slots in template order (photo slots first then text slots),
    // we use position-based matching: walk through page.slots in order and
    // find the i-th one matching slot.type at position slotIdx.
    const content = findContentForTemplateSlot(page, slot, slotIdx);
    const r = slotRect(slot, pw, ph, slot.padding || 0);
    return renderSlot(content, slot, slotIdx, r, theme);
  }).join('');

  // Free-form text boxes (PPT-style). Stored on page.freeTexts in pt units.
  // We render last so they sit on top of template slots.
  const scale = state.canvasPx.scale || 1;
  const freeTextsHtml = (page.freeTexts || []).map((ft) => renderFreeTextEl(ft, scale)).join('');

  canvas.innerHTML = deco + slotsHtml + freeTextsHtml;

  // Re-append the floating text toolbar (innerHTML = ... just wiped it).
  // It will be hidden if nothing is selected.
  const tb = ensureToolbarMounted();
  if (tb && !tb.hidden) {
    // Toolbar is currently visible; after the re-render we need to
    // re-find the target el + reposition.
    const target = getActiveTextTarget();
    if (target) {
      const newEl = target.kind === 'freetext'
        ? canvas.querySelector(`[data-ft-id="${state.selectedFreeTextId}"]`)
        : canvas.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
      if (newEl) {
        target.el = newEl;
        if (newEl.contentEditable !== 'true') {
          newEl.contentEditable = 'true';
          newEl.classList.add('is-editing');
          newEl.addEventListener('input', onInlineEditInput);
          newEl.addEventListener('blur', onInlineEditBlur);
          newEl.addEventListener('keydown', onInlineEditKeydown);
          newEl.addEventListener('paste', onInlineEditPaste);
        }
        updateToolbarState();
        positionFloatingToolbar();
      } else {
        tb.hidden = true;
      }
    } else {
      tb.hidden = true;
    }
  }

  // Per-slot pointer handlers
  canvas.querySelectorAll('[data-slot-idx]').forEach((el) => {
    const slotIdx = Number(el.getAttribute('data-slot-idx'));
    el.onpointerdown = (e) => onCanvasSlotPointerDown(e, slotIdx);
  });
  // Free-form text box pointer handlers (move + resize). Resize handles
  // get installed below after overlay is wired.
  canvas.querySelectorAll('[data-ft-id]').forEach((el) => {
    el.onpointerdown = onFreeTextPointerDown;
  });
  // Resize handles (only present on the selected one, so this is cheap)
  canvas.querySelectorAll('[data-ft-handle]').forEach((el) => {
    el.onpointerdown = onFreeTextHandlePointerDown;
  });
  // Wheel handler on the canvas — drives photo zoom when over a photo slot
  canvas.onwheel = onCanvasWheel;
  // Pointer up on the canvas itself catches drops into empty space.
  //
  // It goes through the gesture guard, so a release from a pointer that is
  // NOT the one the drag started with cannot commit a drop. That is the
  // case after a system suspend: the mouse is a new device with a new
  // pointer id, and without this guard the user's next click would swap a
  // photo into a slot they never dropped it on.
  canvas.onpointerup = onCanvasPointerUp;
  canvas.onpointermove = onCanvasPointerMove;
  // Click on empty canvas area (not on any slot) clears the current
  // selection. Only fires when no drag/pan is active, so it doesn't
  // conflict with the drag handlers above.
  canvas.onclick = (e) => {
    if (state.drag || state.photoPan || state.textPan
        || state.freeTextDrag || state.freeTextResize) return;
    // FreeText delete button: remove the FT and stop event propagation so
    // we don't fall through to "clear selection" right after.
    const del = e.target.closest && e.target.closest('[data-ft-delete]');
    if (del) {
      const wrap = del.closest('[data-ft-id]');
      if (wrap) {
        const ftId = wrap.getAttribute('data-ft-id');
        deleteFreeTextById(ftId);
      }
      e.stopPropagation();
      return;
    }
    if (e.target !== canvas) return;
    if (state.selectedSlotIdx == null && !state.swapArmed
        && state.selectedFreeTextId == null) return;
    // If the click is inside the floating toolbar, the toolbar's own
    // pointerdown handler should have stopped propagation already; this
    // is a defensive check.
    if (e.target.closest && e.target.closest('#album-text-toolbar')) return;
    clearTextSelection();
    state.swapArmed = null;
    renderActivePage();
  };

  // Inspector
  renderInspector();
  // Update toolbar template select to current
  const tplSelect = state.container.querySelector('#album-template-select');
  if (tplSelect) tplSelect.value = page.templateId;
}

// Map a template slot at index slotIdx to its content slot in page.slots.
// page.slots is built in template order (photos first, then text) so we
// walk through tpl.slots and consume page.slots in lockstep. We match
// by checking the stored _slotTemplate coords to be defensive against
// future re-orderings.
function findContentForTemplateSlot(page, templateSlot, slotIdx) {
  // Look for content whose _slotTemplate matches this templateSlot exactly
  return page.slots.find((s) =>
    s._slotTemplate
    && s._slotTemplate.x === templateSlot.x
    && s._slotTemplate.y === templateSlot.y
    && s._slotTemplate.w === templateSlot.w
    && s._slotTemplate.h === templateSlot.h
  ) || null;
}

// Render a free-form text box. `scale` is px-per-pt for the current
// canvas (state.canvasPx.scale). All geometry is stored in pt; the
// editor converts on the way out so the PDF side can use the same
// numbers directly.
function renderFreeTextEl(ft, scale) {
  const left = (ft.x * scale).toFixed(1);
  const top = (ft.y * scale).toFixed(1);
  const width = (ft.w * scale).toFixed(1);
  const height = (ft.h * scale).toFixed(1);
  const fontPx = Math.max(6, Math.round(ft.fontSize * scale));
  const padPx = Math.max(0, Math.round((ft.padding || 0) * scale));
  const color = ft.color || '#2a2a2a';
  const bg = ft.backgroundColor || 'transparent';
  const borderW = Math.max(0, Math.round((ft.borderWidth || 0) * scale));
  const borderColor = ft.borderColor || 'transparent';
  const isSelected = state.selectedFreeTextId === ft.id;
  const cls = [
    'album-freetext',
    isSelected ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
  // border requires explicit style when borderWidth > 0
  const borderStyle = borderW > 0
    ? `border:${borderW}px solid ${borderColor};`
    : '';
  // When selected, append the 8-handle overlay (overlay is pointer-events:none;
  // individual handles are pointer-events:auto)
  const overlay = isSelected ? renderFreeTextOverlay(ft, scale) : '';
  // Escape user text but preserve \n for pre-wrap rendering
  const escaped = escapeHtml(ft.text || '').replace(/\n/g, '&#10;');
  return `
    <div class="${cls}" data-ft-id="${escapeHtml(ft.id)}" tabindex="-1" style="
      left:${left}px;top:${top}px;width:${width}px;height:${height}px;
      font-size:${fontPx}px;
      color:${color};
      background-color:${bg};
      padding:${padPx}px;
      text-align:${escapeHtml(ft.textAlign || 'left')};
      font-weight:${ft.fontWeight === 'bold' ? 700 : 400};
      font-style:${ft.fontStyle === 'italic' ? 'italic' : 'normal'};
      ${borderStyle}
    ">${escaped}${overlay}</div>
  `;
}

// 8 resize handles + a small delete button. Coordinates are in CSS px
// (already converted from pt via scale).
function renderFreeTextOverlay(ft, scale) {
  const handle = (where, cursor) => `
    <span class="album-fth-handle" data-ft-handle="${where}" style="cursor:${cursor};"></span>
  `;
  return `
    <div class="album-fth-overlay">
      ${handle('nw', 'nwse-resize')}
      ${handle('n',  'ns-resize')}
      ${handle('ne', 'nesw-resize')}
      ${handle('e',  'ew-resize')}
      ${handle('se', 'nwse-resize')}
      ${handle('s',  'ns-resize')}
      ${handle('sw', 'nesw-resize')}
      ${handle('w',  'ew-resize')}
      <button type="button" class="album-fth-delete" data-ft-delete="1" title="删除此文本">×</button>
    </div>
  `;
}

function renderSlot(content, templateSlot, slotIdx, r, theme) {
  const isPhoto = templateSlot.type === 'photo';
  const isSelected = state.selectedSlotIdx === slotIdx;
  const isEditing = state.editingPhotoSlotIdx === slotIdx;
  const isSwapArmed = state.swapArmed && state.swapArmed.slotIdx === slotIdx;
  const baseStyle = `left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px;`;
  const cls = [
    'album-slot',
    `album-slot-${templateSlot.type}`,
    isSelected ? 'is-selected' : '',
    isEditing ? 'is-editing' : '',
    isSwapArmed ? 'is-swap-armed' : '',
    isPhoto ? (content && content.photoId ? '' : 'is-empty') : '',
  ].filter(Boolean).join(' ');
  const hint = isPhoto
    ? '拖动平移 · 双击换槽'
    : '拖动平移文字';
  if (isPhoto) {
    const photoId = content && content.photoId;
    const url = photoId ? (state.photoUrls.get(photoId) || '') : '';
    const transform = (content && content.transform) || { x: 50, y: 50, zoom: 1 };
    return `
      <div class="${cls}" data-slot-idx="${slotIdx}" data-slot-type="photo" style="${baseStyle}">
        ${photoId ? `
          <div class="album-photo" data-photo-id="${escapeHtml(photoId)}" style="
            position:absolute;
            ${(() => {
              // Compute draw rect using natural AR if available
              const photo = state.photoById.get(photoId);
              let srcW = photo && photo.width ? photo.width : 4;
              let srcH = photo && photo.height ? photo.height : 3;
              // Apply EXIF orientation swap (5..8 → w/h swapped) so
              // portrait phone shots render correctly here, matching the
              // PDF side which uses pdfkit.openImage() (post-orientation).
              const dims = applyExifOrientation(srcW, srcH, photo && photo.orientation);
              const dRect = computePhotoDrawRect(r, dims.w, dims.h, transform);
              return `left:${dRect.x.toFixed(1)}px;top:${dRect.y.toFixed(1)}px;width:${dRect.width.toFixed(1)}px;height:${dRect.height.toFixed(1)}px;`;
            })()}
          ">
            ${url ? `<img src="${escapeHtml(url)}" alt="" draggable="false"/>` : `<div class="album-photo-loading">加载中…</div>`}
          </div>
        ` : `<div class="album-photo-empty">拖照片到此处</div>`}
        ${isEditing && photoId ? renderPhotoEditControls() : ''}
        <div class="album-slot-hint">${escapeHtml(hint)}</div>
      </div>
    `;
  }
  // Text slot
  const text = (content && content.text) || '';
  const editable = isSelected;
  const textOffset = (content && content.textOffset) || { x: 0, y: 0 };
  const fontScale = (content && content.fontScale) || 1;
  const textAlign = (content && content.textAlign)
    || (templateSlot.type === 'title' ? 'center' : 'left');
  // CSS px = pt * 96/72, so for fidelity with the PDF (which uses pt) we
  // scale the theme's font-size by 96/72.
  const baseFontPx = templateSlot.type === 'title'
    ? theme.size.title
    : theme.size.caption;
  const fontPx = Math.round(baseFontPx * fontScale * 96 / 72);
  // Per-slot override for color / bold / italic. Falls back to theme
  // defaults (theme.cssVar.text / theme.weight.title|caption) when unset.
  const slotColor = content && content.color ? content.color : (theme.cssVar.text || '');
  const themeWeight = templateSlot.type === 'title'
    ? (theme.weight && theme.weight.title) || 'bold'
    : (theme.weight && theme.weight.caption) || 'normal';
  const isBold = content && content.bold === true;
  const isItalic = content && content.italic === true;
  const cssWeight = isBold ? 700 : (themeWeight === 'bold' ? 700 : 400);
  const cssItalic = isItalic ? 'italic' : (themeWeight === 'italic' ? 'italic' : 'normal');
  const extraStyle = slotColor ? `color:${slotColor};` : '';
  return `
    <div class="${cls}" data-slot-idx="${slotIdx}" data-slot-type="${templateSlot.type}" style="${baseStyle}">
      <div class="album-text ${editable ? 'is-selected' : ''}" data-text-idx="${slotIdx}"
           data-text-align="${escapeHtml(textAlign)}"
           style="transform: translate(${textOffset.x}px, ${textOffset.y}px); text-align:${escapeHtml(textAlign)};">
        ${templateSlot.type === 'title'
          ? `<div class="album-text-title" data-text-role="title" tabindex="-1" style="font-size:${fontPx}px;font-weight:${cssWeight};font-style:${cssItalic};text-align:${escapeHtml(textAlign)};${extraStyle}">${escapeHtml(text)}</div>`
          : `<div class="album-text-caption" data-text-role="caption" tabindex="-1" style="font-size:${fontPx}px;font-weight:${cssWeight};font-style:${cssItalic};text-align:${escapeHtml(textAlign)};${extraStyle}">${escapeHtml(text)}</div>`}
      </div>
      <div class="album-slot-hint">${escapeHtml(hint)}</div>
    </div>
  `;
}

function renderPhotoEditControls() {
  return `
    <div class="album-photo-edit-controls">
      <button type="button" data-photo-action="zoom-out" title="缩小">−</button>
      <button type="button" data-photo-action="reset" title="重置">↺</button>
      <button type="button" data-photo-action="zoom-in" title="放大">+</button>
      <button type="button" data-photo-action="done" title="完成">✓</button>
    </div>
  `;
}

// ---- render: inspector ------------------------------------------------------

// ---- free-text inspector ---------------------------------------------------

// Normalize a user-typed hex to #rrggbb. Returns the fallback if it can't
// be parsed at all. Both <input type="color"> and the hex text input write
// to the same field; this keeps them in sync.
function normalizeHexColorLegacy(v, fallback = '#2a2a2a') {
  if (!v) return fallback;
  const s = String(v).trim();
  if (/^#([0-9a-f]{6})$/i.test(s)) return s.toLowerCase();
  if (/^#([0-9a-f]{3})$/i.test(s)) {
    const m = s.slice(1);
    return ('#' + m[0] + m[0] + m[1] + m[1] + m[2] + m[2]).toLowerCase();
  }
  return fallback;
}

function renderFreeTextInspector(ft) {
  const color = ft.color || '#2a2a2a';
  const bg = ft.backgroundColor || '';
  const border = ft.borderColor || '';
  return `
    <div class="album-inspector-section">
      <div class="album-inspector-title">浮动文本</div>
      <textarea class="album-inspector-text" id="ft-text" rows="4"
        placeholder="在此输入内容（支持换行）">${escapeHtml(ft.text || '')}</textarea>
    </div>

    <div class="album-inspector-section">
      <div class="album-inspector-label">字号 <span id="ft-fontsize-label">${Math.round(ft.fontSize || 12)} pt</span></div>
      <div class="album-inspector-row">
        <input type="range" min="${FREETEXT_LIMITS.fontSizeMin}" max="${FREETEXT_LIMITS.fontSizeMax}" id="ft-fontsize" value="${Math.round(ft.fontSize || 12)}" style="width:100%;"/>
      </div>
    </div>

    <div class="album-inspector-section">
      <div class="album-inspector-label">文字颜色</div>
      <div class="album-inspector-color-row">
        <input type="color" id="ft-color" value="${escapeHtml(color)}"/>
        <input type="text" id="ft-color-hex" value="${escapeHtml(color)}" maxlength="7"/>
      </div>
    </div>

    <div class="album-inspector-section">
      <div class="album-inspector-label">字重 / 斜体</div>
      <div class="album-inspector-row" style="gap:6px;">
        <div class="album-inspector-toggle-group" role="group" aria-label="字重">
          <button type="button" class="${ft.fontWeight === 'bold' ? 'is-active' : ''}" data-ft-weight="normal">常规</button>
          <button type="button" class="${ft.fontWeight === 'bold' ? 'is-active' : ''}" data-ft-weight="bold">粗体</button>
        </div>
        <button type="button" class="album-inspector-toggle-group ${ft.fontStyle === 'italic' ? 'is-active' : ''}" data-ft-italic="1"
          style="border:1px solid var(--border);border-radius:4px;padding:4px 10px;font-size:12px;background:${ft.fontStyle === 'italic' ? 'var(--theme-accent)' : 'transparent'};color:${ft.fontStyle === 'italic' ? '#fff' : 'inherit'};cursor:pointer;">斜体</button>
      </div>
      <div class="album-inspector-label" style="margin-top:6px;">对齐</div>
      <div class="album-text-align-group" role="group" aria-label="对齐">
        <button type="button" class="album-text-align-btn ${ft.textAlign === 'left' ? 'is-active' : ''}" data-ft-align="left" title="左对齐">⇤</button>
        <button type="button" class="album-text-align-btn ${ft.textAlign === 'center' ? 'is-active' : ''}" data-ft-align="center" title="居中">↔</button>
        <button type="button" class="album-text-align-btn ${ft.textAlign === 'right' ? 'is-active' : ''}" data-ft-align="right" title="右对齐">⇥</button>
      </div>
    </div>

    <div class="album-inspector-section">
      <div class="album-inspector-label">背景</div>
      <div class="album-inspector-color-row">
        <input type="color" id="ft-bg" value="${escapeHtml(bg || '#ffffff')}"/>
        <input type="text" id="ft-bg-hex" value="${escapeHtml(bg)}" placeholder="无填充" maxlength="7"/>
        <button type="button" class="album-inspector-clear-btn" id="ft-bg-clear">无</button>
      </div>
    </div>

    <div class="album-inspector-section">
      <div class="album-inspector-label">边框</div>
      <div class="album-inspector-color-row">
        <input type="color" id="ft-border" value="${escapeHtml(border || '#2a2a2a')}"/>
        <input type="text" id="ft-border-hex" value="${escapeHtml(border)}" placeholder="无边框" maxlength="7"/>
        <button type="button" class="album-inspector-clear-btn" id="ft-border-clear">无</button>
      </div>
      <div class="album-inspector-row" style="margin-top:4px;align-items:center;gap:6px;">
        <span style="font-size:11px;color:var(--muted);width:48px;">粗细</span>
        <input type="range" min="0" max="${FREETEXT_LIMITS.borderWidthMax}" step="0.5" id="ft-border-width" value="${Number(ft.borderWidth || 0)}" style="flex:1;"/>
        <span id="ft-border-width-label" style="font-size:11px;color:var(--muted);width:36px;text-align:right;">${(ft.borderWidth || 0).toFixed(1)} pt</span>
      </div>
    </div>

    <div class="album-inspector-section">
      <div class="album-inspector-label">位置与尺寸 (pt)</div>
      <div class="album-inspector-geom">
        <label>X<input type="number" id="ft-x" value="${Math.round(ft.x || 0)}"/></label>
        <label>Y<input type="number" id="ft-y" value="${Math.round(ft.y || 0)}"/></label>
        <label>W<input type="number" id="ft-w" value="${Math.round(ft.w || 0)}"/></label>
        <label>H<input type="number" id="ft-h" value="${Math.round(ft.h || 0)}"/></label>
      </div>
      <div class="album-inspector-row" style="margin-top:6px;align-items:center;gap:6px;">
        <span style="font-size:11px;color:var(--muted);width:48px;">内边距</span>
        <input type="range" min="${FREETEXT_LIMITS.paddingMin}" max="${FREETEXT_LIMITS.paddingMax}" id="ft-padding" value="${Math.round(ft.padding || 0)}" style="flex:1;"/>
        <span id="ft-padding-label" style="font-size:11px;color:var(--muted);width:36px;text-align:right;">${Math.round(ft.padding || 0)} pt</span>
      </div>
    </div>

    <div class="album-inspector-section" style="display:flex;gap:6px;">
      <button type="button" class="btn secondary" id="ft-reset" style="flex:1;">重置样式</button>
      <button type="button" class="btn secondary" id="ft-delete" style="flex:1;color:#ef4444;">删除文本框</button>
    </div>
  `;
}

// Wire the inspector widgets. Many of these use the live-update + debounce
// pushHistory pattern; only the few "commit once" actions call pushHistory
// directly. This keeps the undo stack from filling up with one snapshot
// per keystroke during color or font-size fiddling.
function wireFreeTextInspector(ft) {
  const root = state.container.querySelector('#album-inspector');
  if (!root) return;

  let liveSnapTimer = null;
  function scheduleLiveSnapshot() {
    if (liveSnapTimer) clearTimeout(liveSnapTimer);
    liveSnapTimer = setTimeout(() => {
      pushHistory();
      renderCustomPanel();
    }, 600);
  }

  // Text
  const ta = root.querySelector('#ft-text');
  if (ta) {
    let lastSnap = ft.text;
    let t = null;
    ta.oninput = (e) => {
      ft.text = e.target.value;
      const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
      if (el) el.textContent = ft.text;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (ft.text !== lastSnap) {
          pushHistory();
          renderCustomPanel();
          lastSnap = ft.text;
        }
      }, 1000);
    };
  }

  // Font size
  const fsRange = root.querySelector('#ft-fontsize');
  const fsLabel = root.querySelector('#ft-fontsize-label');
  const scale = state.canvasPx.scale || 1;
  if (fsRange) {
    fsRange.oninput = (e) => {
      ft.fontSize = Number(e.target.value);
      if (fsLabel) fsLabel.textContent = `${Math.round(ft.fontSize)} pt`;
      const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
      if (el) el.style.fontSize = `${Math.max(6, Math.round(ft.fontSize * scale))}px`;
      scheduleLiveSnapshot();
    };
    fsRange.onchange = () => pushHistory();
  }

  // Color (color input + hex text)
  const ftColor = root.querySelector('#ft-color');
  const ftColorHex = root.querySelector('#ft-color-hex');
  function applyTextColor(hex) {
    const c = normalizeHexColorLegacy(hex, ft.color);
    ft.color = c;
    const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
    if (el) el.style.color = c;
    if (ftColor && ftColor.value !== c) ftColor.value = c;
    if (ftColorHex && ftColorHex.value !== c) ftColorHex.value = c;
  }
  if (ftColor) ftColor.oninput = (e) => { applyTextColor(e.target.value); scheduleLiveSnapshot(); };
  if (ftColorHex) ftColorHex.onchange = (e) => { applyTextColor(e.target.value); pushHistory(); };

  // Background
  const ftBg = root.querySelector('#ft-bg');
  const ftBgHex = root.querySelector('#ft-bg-hex');
  const ftBgClear = root.querySelector('#ft-bg-clear');
  function applyBg(v) {
    if (v == null || v === '') {
      ft.backgroundColor = null;
    } else {
      ft.backgroundColor = normalizeHexColorLegacy(v, '#ffffff');
    }
    const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
    if (el) el.style.backgroundColor = ft.backgroundColor || 'transparent';
    if (ftBgHex && ftBgHex.value !== (ft.backgroundColor || '')) ftBgHex.value = ft.backgroundColor || '';
  }
  if (ftBg) ftBg.oninput = (e) => { applyBg(e.target.value); scheduleLiveSnapshot(); };
  if (ftBgHex) ftBgHex.onchange = (e) => { applyBg(e.target.value); pushHistory(); };
  if (ftBgClear) ftBgClear.onclick = () => { applyBg(''); pushHistory(); renderActivePage(); };

  // Border
  const ftBorder = root.querySelector('#ft-border');
  const ftBorderHex = root.querySelector('#ft-border-hex');
  const ftBorderClear = root.querySelector('#ft-border-clear');
  const ftBorderW = root.querySelector('#ft-border-width');
  const ftBorderWLabel = root.querySelector('#ft-border-width-label');
  function applyBorderColor(v) {
    if (v == null || v === '') {
      ft.borderColor = null;
      ft.borderWidth = 0;
    } else {
      ft.borderColor = normalizeHexColorLegacy(v, '#2a2a2a');
      if (!ft.borderWidth) ft.borderWidth = 1;
    }
    refreshBorderDom();
  }
  function refreshBorderDom() {
    const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
    if (el) {
      if (ft.borderWidth > 0 && ft.borderColor) {
        const wpx = Math.max(1, Math.round(ft.borderWidth * scale));
        el.style.border = `${wpx}px solid ${ft.borderColor}`;
      } else {
        el.style.border = '0';
      }
    }
    if (ftBorderW) ftBorderW.value = String(ft.borderWidth || 0);
    if (ftBorderWLabel) ftBorderWLabel.textContent = `${(ft.borderWidth || 0).toFixed(1)} pt`;
    if (ftBorderHex && ftBorderHex.value !== (ft.borderColor || '')) ftBorderHex.value = ft.borderColor || '';
  }
  if (ftBorder) ftBorder.oninput = (e) => { applyBorderColor(e.target.value); scheduleLiveSnapshot(); };
  if (ftBorderHex) ftBorderHex.onchange = (e) => { applyBorderColor(e.target.value); pushHistory(); };
  if (ftBorderClear) ftBorderClear.onclick = () => { applyBorderColor(''); pushHistory(); renderActivePage(); };
  if (ftBorderW) ftBorderW.oninput = (e) => {
    ft.borderWidth = Number(e.target.value);
    if (ftBorderWLabel) ftBorderWLabel.textContent = `${ft.borderWidth.toFixed(1)} pt`;
    refreshBorderDom();
    scheduleLiveSnapshot();
  };
  if (ftBorderW) ftBorderW.onchange = () => pushHistory();

  // Weight / italic / align
  root.querySelectorAll('[data-ft-weight]').forEach((btn) => {
    btn.onclick = () => {
      ft.fontWeight = btn.getAttribute('data-ft-weight') === 'bold' ? 'bold' : 'normal';
      const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
      if (el) el.style.fontWeight = ft.fontWeight === 'bold' ? 700 : 400;
      // Refresh button active states without a full re-render
      root.querySelectorAll('[data-ft-weight]').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-ft-weight') === ft.fontWeight);
      });
      pushHistory();
    };
  });
  const italicBtn = root.querySelector('[data-ft-italic]');
  if (italicBtn) {
    italicBtn.onclick = () => {
      ft.fontStyle = ft.fontStyle === 'italic' ? 'normal' : 'italic';
      const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
      if (el) el.style.fontStyle = ft.fontStyle;
      italicBtn.style.background = ft.fontStyle === 'italic' ? 'var(--theme-accent)' : 'transparent';
      italicBtn.style.color = ft.fontStyle === 'italic' ? '#fff' : 'inherit';
      pushHistory();
    };
  }
  root.querySelectorAll('[data-ft-align]').forEach((btn) => {
    btn.onclick = () => {
      const a = btn.getAttribute('data-ft-align');
      if (!a) return;
      ft.textAlign = a;
      const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
      if (el) el.style.textAlign = a;
      root.querySelectorAll('[data-ft-align]').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-ft-align') === a);
      });
      pushHistory();
    };
  });

  // Geometry inputs (X / Y / W / H)
  function bindGeom(id, key) {
    const el = root.querySelector(`#ft-${id}`);
    if (!el) return;
    el.onchange = () => {
      const v = Number(el.value);
      if (!Number.isFinite(v)) return;
      ft[key] = v;
      clampFreeTextRect(ft);
      // Reflect the clamped value back
      el.value = String(Math.round(ft[key]));
      // Update DOM in place — we want to keep inspector focus and avoid
      // re-rendering the whole canvas.
      const wrap = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
      if (wrap) {
        wrap.style.left = `${(ft.x * scale).toFixed(1)}px`;
        wrap.style.top  = `${(ft.y * scale).toFixed(1)}px`;
        wrap.style.width  = `${(ft.w * scale).toFixed(1)}px`;
        wrap.style.height = `${(ft.h * scale).toFixed(1)}px`;
      }
      pushHistory();
    };
  }
  bindGeom('x', 'x');
  bindGeom('y', 'y');
  bindGeom('w', 'w');
  bindGeom('h', 'h');

  // Padding
  const padR = root.querySelector('#ft-padding');
  const padL = root.querySelector('#ft-padding-label');
  if (padR) {
    padR.oninput = (e) => {
      ft.padding = Number(e.target.value);
      if (padL) padL.textContent = `${Math.round(ft.padding)} pt`;
      const el = state.container.querySelector(`[data-ft-id="${ft.id}"]`);
      if (el) el.style.padding = `${Math.max(0, Math.round(ft.padding * scale))}px`;
      scheduleLiveSnapshot();
    };
    padR.onchange = () => pushHistory();
  }

  // Reset (style only — keep position/size)
  const reset = root.querySelector('#ft-reset');
  if (reset) {
    reset.onclick = () => {
      Object.assign(ft, {
        fontSize: DEFAULT_FREETEXT_STYLE.fontSize,
        fontWeight: DEFAULT_FREETEXT_STYLE.fontWeight,
        fontStyle: DEFAULT_FREETEXT_STYLE.fontStyle,
        textAlign: DEFAULT_FREETEXT_STYLE.textAlign,
        color: DEFAULT_FREETEXT_STYLE.color,
        backgroundColor: null,
        borderColor: null,
        borderWidth: 0,
        padding: DEFAULT_FREETEXT_STYLE.padding,
      });
      pushHistory();
      renderActivePage();
    };
  }
  // Delete
  const del = root.querySelector('#ft-delete');
  if (del) del.onclick = () => {
    deleteFreeTextById(ft.id);
  };
}

function renderInspector() {
  const host = state.container.querySelector('#album-inspector');
  if (!host) return;
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page) {
    host.innerHTML = '<div class="album-inspector-empty">未选择页面</div>';
    return;
  }
  // Free-form text box takes priority — sits on top of everything.
  if (state.selectedFreeTextId != null) {
    const ft = (page.freeTexts || []).find((f) => f.id === state.selectedFreeTextId);
    if (ft) {
      // Free-form text editing is handled by the floating toolbar + the
      // 8 resize handles on the canvas itself. The right panel just shows
      // a hint + an explicit "重置样式" + delete button (since the FT's
      // delete affordance is the small ✕ on the overlay).
      host.innerHTML = `
        <div class="album-inspector-section">
          <div class="album-inspector-title">浮动文本框</div>
          <div class="album-inspector-hint">在画布上点击文字直接编辑；<br/>使用文字框<strong>上方浮动的工具栏</strong>调整字号、颜色、粗体、斜体、对齐、背景、边框。<br/>拖动<strong>8 个角块</strong>可缩放。</div>
          <div class="album-inspector-row" style="margin-top:8px;gap:6px;">
            <button type="button" class="btn secondary" id="album-ft-reset-style">重置样式</button>
            <button type="button" class="btn secondary" id="album-ft-delete">删除文本框</button>
          </div>
        </div>
      `;
      const resetBtn = host.querySelector('#album-ft-reset-style');
      if (resetBtn) resetBtn.onclick = () => {
        pushHistory();
        Object.assign(ft, {
          ...DEFAULT_FREETEXT_STYLE,
          text: ft.text,
          x: ft.x, y: ft.y, w: ft.w, h: ft.h, id: ft.id,
        });
        renderActivePage();
        mountFloatingToolbar();
      };
      const delBtn = host.querySelector('#album-ft-delete');
      if (delBtn) delBtn.onclick = () => {
        deleteFreeTextById(ft.id);
      };
      return;
    }
    // The id was lost (undo/redo maybe?) — drop it.
    state.selectedFreeTextId = null;
  }
  if (state.selectedSlotIdx == null) {
    // Page-level inspector: change template, page meta
    const tpl = getLayoutTemplate(page.templateId);
    const eventId = page.eventId;
    const ev = state.eventById.get(eventId);
    host.innerHTML = `
      <div class="album-inspector-section">
        <div class="album-inspector-title">当前页 · 第 ${state.selectedPageIdx + 1} 页</div>
        <div class="album-inspector-meta">${escapeHtml(tpl.name)} · ${page.slots.filter((s) => s.type === 'photo').length} 图 · ${page.slots.filter((s) => s.type !== 'photo').length} 文</div>
      </div>
      <div class="album-inspector-section">
        <div class="album-inspector-label">换版式</div>
        <div class="album-inspector-templates">
          ${LAYOUT_TEMPLATES.map((t) => `
            <button type="button" class="album-inspector-tpl ${
              t.id === page.templateId ? 'is-active' : ''
            }" data-tpl-id="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>
          `).join('')}
        </div>
      </div>
      ${ev ? `
      <div class="album-inspector-section">
        <div class="album-inspector-label">所属事件</div>
        <div class="album-inspector-meta">${escapeHtml(ev.title || '(无标题)')}</div>
      </div>
      ` : ''}
      <div class="album-inspector-section">
        <button type="button" class="btn secondary" id="album-delete-page-btn">删除此页</button>
      </div>
    `;
    host.querySelectorAll('.album-inspector-tpl').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        handleChangePageTemplate(state.selectedPageIdx, btn.getAttribute('data-tpl-id'));
      };
    });
    const delBtn = host.querySelector('#album-delete-page-btn');
    if (delBtn) delBtn.onclick = handleDeletePage;
    return;
  }
  // Slot-level inspector
  const content = page.slots[state.selectedSlotIdx];
  if (!content) {
    host.innerHTML = '<div class="album-inspector-empty">空 slot</div>';
    return;
  }
  if (content.type === 'photo') {
    host.innerHTML = `
      <div class="album-inspector-section">
        <div class="album-inspector-title">照片</div>
        <div class="album-inspector-meta">${content.photoId ? '已放置' : '空槽位'}</div>
      </div>
      <div class="album-inspector-section">
        <div class="album-inspector-label">变换 (pan / zoom)</div>
        <div class="album-inspector-row">
          <label>X <input type="range" min="0" max="100" id="album-pan-x" value="${content.transform.x}"/></label>
          <label>Y <input type="range" min="0" max="100" id="album-pan-y" value="${content.transform.y}"/></label>
          <label>缩放 <input type="range" min="1" max="40" id="album-zoom" value="${Math.round(content.transform.zoom * 10)}"/></label>
        </div>
        <div class="album-inspector-row">
          <button type="button" class="btn secondary" id="album-photo-reset">重置变换</button>
          ${content.photoId ? '<button type="button" class="btn secondary" id="album-photo-remove">移除照片</button>' : ''}
        </div>
        <div class="album-inspector-warning" id="album-photo-warning" hidden></div>
      </div>
    `;
    wirePhotoInspector(content);
  } else {
    // Text slot — editing happens in-place via the floating toolbar
    // (mountFloatingToolbar). The right panel is now minimal: just a
    // hint pointing to the toolbar.
    const offX = (content.textOffset && content.textOffset.x) || 0;
    const offY = (content.textOffset && content.textOffset.y) || 0;
    host.innerHTML = `
      <div class="album-inspector-section">
        <div class="album-inspector-title">${content.type === 'title' ? '标题' : '说明文字'}</div>
        <div class="album-inspector-hint">在画布上点击文字直接编辑；<br/>使用文字框<strong>上方浮动的工具栏</strong>调整字号、颜色、粗体、斜体、对齐。</div>
        <button type="button" class="btn secondary" id="album-text-reset" style="margin-top:8px;">重置为默认</button>
      </div>
      <div class="album-inspector-section">
        <div class="album-inspector-label">位置偏移 (px · 与 PDF 一致)</div>
        <div class="album-inspector-row">
          <label>X <input type="range" min="-200" max="200" id="album-text-x" value="${Math.round(offX)}"/></label>
          <label>Y <input type="range" min="-120" max="120" id="album-text-y" value="${Math.round(offY)}"/></label>
        </div>
        <div class="album-inspector-row">
          <button type="button" class="btn secondary" id="album-text-offset-reset">重置位置</button>
        </div>
      </div>
    `;
    const reset = host.querySelector('#album-text-reset');
    if (reset) {
      reset.onclick = () => {
        const ev = state.eventById.get(page.eventId);
        if (content.type === 'title') {
          content.text = ev ? (ev.title || '') : '';
        } else {
          import('../album_builder.js').then((mod) => {
            content.text = mod.buildEventCaption(ev || {});
            const el = state.container.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
            if (el) el.textContent = content.text;
            pushHistory();
          });
          return;
        }
        const el = state.container.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
        if (el) el.textContent = content.text;
        pushHistory();
      };
    }
    // Text position offset controls (kept here as the one item not on the
    // floating toolbar; the toolbar is for visual style only).
    const xRange = host.querySelector('#album-text-x');
    const yRange = host.querySelector('#album-text-y');
    if (xRange) xRange.oninput = (e) => {
      const next = clampTextOffset({ ...(content.textOffset || {}), x: Number(e.target.value) });
      content.textOffset = next;
      updateTextOffset(state.selectedPageIdx, state.selectedSlotIdx);
    };
    if (yRange) yRange.oninput = (e) => {
      const next = clampTextOffset({ ...(content.textOffset || {}), y: Number(e.target.value) });
      content.textOffset = next;
      updateTextOffset(state.selectedPageIdx, state.selectedSlotIdx);
    };
    const offReset = host.querySelector('#album-text-offset-reset');
    if (offReset) offReset.onclick = () => {
      content.textOffset = clampTextOffset({ x: 0, y: 0 });
      if (xRange) xRange.value = '0';
      if (yRange) yRange.value = '0';
      updateTextOffset(state.selectedPageIdx, state.selectedSlotIdx);
    };
  }
}

function wirePhotoInspector(content) {
  const root = state.container.querySelector('#album-inspector');
  if (!root) return;
  const xRange = root.querySelector('#album-pan-x');
  const yRange = root.querySelector('#album-pan-y');
  const zRange = root.querySelector('#album-zoom');
  const warning = root.querySelector('#album-photo-warning');
  let warningTimer = null;
  function showWarning(text) {
    if (!warning) return;
    warning.textContent = text;
    warning.hidden = false;
    if (warningTimer) clearTimeout(warningTimer);
    warningTimer = setTimeout(() => { warning.hidden = true; }, 1500);
  }
  if (xRange) xRange.oninput = (e) => {
    const prev = content.transform.x;
    const next = clampPhotoTransform({ ...content.transform, x: Number(e.target.value) });
    if (wasClamped(prev, next.x)) showWarning('X 已夹紧到 0..100');
    content.transform = next;
    updateSlotPhotoTransform(state.selectedPageIdx, state.selectedSlotIdx);
  };
  if (yRange) yRange.oninput = (e) => {
    const prev = content.transform.y;
    const next = clampPhotoTransform({ ...content.transform, y: Number(e.target.value) });
    if (wasClamped(prev, next.y)) showWarning('Y 已夹紧到 0..100');
    content.transform = next;
    updateSlotPhotoTransform(state.selectedPageIdx, state.selectedSlotIdx);
  };
  if (zRange) zRange.oninput = (e) => {
    const prev = content.transform.zoom;
    const next = clampPhotoTransform({ ...content.transform, zoom: Number(e.target.value) / 10 });
    if (wasClamped(prev, next.zoom)) showWarning('缩放已夹紧到 0.1..4');
    content.transform = next;
    updateSlotPhotoTransform(state.selectedPageIdx, state.selectedSlotIdx);
  };
  const reset = root.querySelector('#album-photo-reset');
  if (reset) reset.onclick = () => {
    content.transform = clampPhotoTransform({ x: 50, y: 50, zoom: 1 });
    renderActivePage();
  };
  const remove = root.querySelector('#album-photo-remove');
  if (remove) remove.onclick = () => {
    content.photoId = null;
    content.empty = true;
    content.transform = clampPhotoTransform(null);
    renderActivePage();
  };
}

function updateSlotPhotoTransform(pageIdx, slotIdx) {
  const page = state.layout.pages[pageIdx];
  if (!page) return;
  const content = page.slots[slotIdx];
  if (!content || content.type !== 'photo') return;
  const tpl = getLayoutTemplate(page.templateId);
  const templateSlot = tpl.slots[slotIdx];
  if (!templateSlot) return;
  const pw = state.canvasPx.w;
  const ph = state.canvasPx.h;
  const r = slotRect(templateSlot, pw, ph, templateSlot.padding || 0);
  const photo = state.photoById.get(content.photoId);
  const srcW = photo && photo.width ? photo.width : 4;
  const srcH = photo && photo.height ? photo.height : 3;
  // EXIF orientation swap — keeps editor WYSIWYG with the PDF side
  // (which uses pdfkit.openImage() that reads post-orientation dims).
  const dims = applyExifOrientation(srcW, srcH, photo && photo.orientation);
  const dRect = computePhotoDrawRect(r, dims.w, dims.h, content.transform);
  const photoEl = state.container.querySelector(
    `[data-slot-idx="${slotIdx}"] .album-photo`
  );
  if (photoEl) {
    photoEl.style.left = `${dRect.x.toFixed(1)}px`;
    photoEl.style.top = `${dRect.y.toFixed(1)}px`;
    photoEl.style.width = `${dRect.width.toFixed(1)}px`;
    photoEl.style.height = `${dRect.height.toFixed(1)}px`;
  }
}

// Apply text offset to the slot's text wrapper in place (no full re-render).
function updateTextOffset(pageIdx, slotIdx) {
  const content = state.layout.pages[pageIdx] && state.layout.pages[pageIdx].slots[slotIdx];
  if (!content) return;
  const off = content.textOffset || { x: 0, y: 0 };
  const wrap = state.container.querySelector(
    `[data-slot-idx="${slotIdx}"] [data-text-idx]`
  );
  if (wrap) {
    wrap.style.transform = `translate(${off.x || 0}px, ${off.y || 0}px)`;
  }
}

// ---- free-form text box: pointer, drag, resize ------------------------------
//
// State is one of:
//   freeTextDrag:   { ftId, startX, startY, baseX, baseY }       (whole-box move)
//   freeTextResize: { ftId, handle, startX, startY, baseX, baseY, baseW, baseH }
// Both are exclusive with photoPan / textPan / drag.

function findFreeTextById(id) {
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page) return null;
  return (page.freeTexts || []).find((ft) => ft.id === id) || null;
}

function clampFreeTextRect(ft) {
  const pageDims = getPageDims(state.layout.pageShape);
  const pw = pageDims.w;
  const ph = pageDims.h;
  const wMin = FREETEXT_LIMITS.wMin;
  const wMax = Math.min(FREETEXT_LIMITS.wMax, pw);
  const hMin = FREETEXT_LIMITS.hMin;
  const hMax = Math.min(FREETEXT_LIMITS.hMax, ph);
  ft.w = Math.max(wMin, Math.min(wMax, Number(ft.w) || 200));
  ft.h = Math.max(hMin, Math.min(hMax, Number(ft.h) || 60));
  ft.x = Math.max(0, Math.min(pw - ft.w, Number(ft.x) || 0));
  ft.y = Math.max(0, Math.min(ph - ft.h, Number(ft.y) || 0));
  ft.fontSize = Math.max(FREETEXT_LIMITS.fontSizeMin,
    Math.min(FREETEXT_LIMITS.fontSizeMax, Number(ft.fontSize) || 12));
  ft.borderWidth = Math.max(FREETEXT_LIMITS.borderWidthMin,
    Math.min(FREETEXT_LIMITS.borderWidthMax, Number(ft.borderWidth) || 0));
  ft.padding = Math.max(FREETEXT_LIMITS.paddingMin,
    Math.min(FREETEXT_LIMITS.paddingMax, Number(ft.padding) || 0));
}

function onFreeTextPointerDown(e) {
  const wrap = e.currentTarget;
  const ftId = wrap.getAttribute('data-ft-id');
  if (!ftId) return;
  // Don't start a drag if the user actually clicked the delete button
  // (its handler is bound separately and stops propagation).
  if (e.target.closest && e.target.closest('[data-ft-delete]')) return;
  // Don't preventDefault — we want the browser to focus the contenteditable
  // (this is the click that lets the user start typing). Drag still works
  // because we track pointermove/pointerup manually.
  const ft = findFreeTextById(ftId);
  if (!ft) return;
  // If a swap was armed, clear it (FT clicked wins).
  if (state.swapArmed) state.swapArmed = null;
  // Selection: prefer freeText over slot
  state.selectedFreeTextId = ftId;
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.editingPhotoSlotIdx = null;
  // Make the wrapper focusable BEFORE the render wipes it, so the
  // browser's default mousedown-focus action has something real to focus.
  // After renderActivePage the DOM is rebuilt, so we then re-focus the new
  // element.
  try {
    wrap.setAttribute('contenteditable', 'true');
    wrap.classList.add('is-editing');
    wrap.dataset.suppressBlur = '1';
    wrap.focus();
    if (typeof placeCaretAtEnd === 'function') placeCaretAtEnd(wrap);
  } catch (_) { /* ignore */ }
  // Start drag (no pushHistory here — only on pointerup)
  const scale = state.canvasPx.scale || 1;
  state.freeTextDrag = {
    ftId,
    startX: e.clientX,
    startY: e.clientY,
    baseX: ft.x,
    baseY: ft.y,
    scale,
  };
  wrap.classList.add('is-dragging');
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.add('has-active-drag');
  // Claim the gesture so a lost `pointerup` (a system suspend re-creates
  // the pointer device) tears the gesture down instead of leaving the box
  // stuck to the cursor. See the guard notes above.
  freeTextDragGuard.begin(e && e.pointerId);
  window.addEventListener('pointermove', onWindowFreeTextMove, { capture: true });
  window.addEventListener('pointerup', onWindowFreeTextUp, { capture: true });
  window.addEventListener('pointercancel', onWindowFreeTextCancel, { capture: true });
  // Mount the toolbar WITHOUT re-rendering — the re-render was detaching
  // the contenteditable wrapper and the focus was landing on a detached
  // node. mountFloatingToolbar handles contenteditable + caret placement
  // on the existing wrapper. The handles/overlay are added on the next
  // render (mountFloatingToolbar schedules a render pass via the
  // positionFloatingToolbar path? — actually no, the overlay only renders
  // during renderActivePage, so we DO need a single render here. But
  // we render AFTER mountFloatingToolbar focuses the wrapper, so the
  // focus is preserved on the re-created wrapper.)
  if (typeof mountFloatingToolbar === 'function') mountFloatingToolbar();
  // Now do a single re-render so the selection overlay + 8 handles show
  // up. mountFloatingToolbar's setTimeout(60) will re-assert focus after
  // the resulting reflow.
  renderActivePage();
  if (typeof mountFloatingToolbar === 'function') mountFloatingToolbar();
}

function onFreeTextHandlePointerDown(e) {
  const handleEl = e.currentTarget;
  const wrap = handleEl.closest('[data-ft-id]');
  if (!wrap) return;
  const handle = handleEl.getAttribute('data-ft-handle');
  if (!handle) return;
  const ftId = wrap.getAttribute('data-ft-id');
  const ft = findFreeTextById(ftId);
  if (!ft) return;
  e.preventDefault();
  e.stopPropagation();
  const scale = state.canvasPx.scale || 1;
  state.freeTextResize = {
    ftId,
    handle,
    startX: e.clientX,
    startY: e.clientY,
    baseX: ft.x,
    baseY: ft.y,
    baseW: ft.w,
    baseH: ft.h,
    scale,
  };
  wrap.classList.add('is-resizing');
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.add('has-active-drag');
  // Claim the gesture — see the guard notes above.
  freeTextResizeGuard.begin(e && e.pointerId);
  window.addEventListener('pointermove', onWindowFreeTextResize, { capture: true });
  window.addEventListener('pointerup', onWindowFreeTextResizeUp, { capture: true });
  window.addEventListener('pointercancel', onWindowFreeTextResizeCancel, { capture: true });
}

function onWindowFreeTextMove(e) {
  const d = state.freeTextDrag;
  if (!d) return;
  // A move from a foreign pointer means the gesture is dead (post-suspend).
  // The guard cancels it, which clears the state and the CSS classes.
  if (!freeTextDragGuard.move(e)) return;
  const ft = findFreeTextById(d.ftId);
  if (!ft) return;
  const dxPt = (e.clientX - d.startX) / d.scale;
  const dyPt = (e.clientY - d.startY) / d.scale;
  ft.x = d.baseX + dxPt;
  ft.y = d.baseY + dyPt;
  clampFreeTextRect(ft);
  // Update DOM in place — keeps the drag snappy.
  const el = state.container.querySelector(`[data-ft-id="${d.ftId}"]`);
  if (el) {
    el.style.left = `${(ft.x * d.scale).toFixed(1)}px`;
    el.style.top  = `${(ft.y * d.scale).toFixed(1)}px`;
  }
}

function onWindowFreeTextUp(e) {
  const d = state.freeTextDrag;
  state.freeTextDrag = null;
  window.removeEventListener('pointermove', onWindowFreeTextMove, { capture: true });
  window.removeEventListener('pointerup', onWindowFreeTextUp, { capture: true });
  window.removeEventListener('pointercancel', onWindowFreeTextCancel, { capture: true });
  if (!d) return;
  const el = state.container.querySelector(`[data-ft-id="${d.ftId}"]`);
  if (el) el.classList.remove('is-dragging');
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.remove('has-active-drag');
  // One snapshot per drag, not per pixel.
  pushHistory();
}

// The platform cancelled the free-text drag.
function onWindowFreeTextCancel(e) {
  freeTextDragGuard.cancel(e);
}

function onWindowFreeTextResize(e) {
  const r = state.freeTextResize;
  if (!r) return;
  // A move from a foreign pointer means the gesture is dead (post-suspend).
  if (!freeTextResizeGuard.move(e)) return;
  const ft = findFreeTextById(r.ftId);
  if (!ft) return;
  const dxPt = (e.clientX - r.startX) / r.scale;
  const dyPt = (e.clientY - r.startY) / r.scale;
  applyHandleResize(ft, r.handle, r, dxPt, dyPt);
  clampFreeTextRect(ft);
  const el = state.container.querySelector(`[data-ft-id="${r.ftId}"]`);
  if (el) {
    el.style.left = `${(ft.x * r.scale).toFixed(1)}px`;
    el.style.top  = `${(ft.y * r.scale).toFixed(1)}px`;
    el.style.width  = `${(ft.w * r.scale).toFixed(1)}px`;
    el.style.height = `${(ft.h * r.scale).toFixed(1)}px`;
  }
}

function onWindowFreeTextResizeUp(e) {
  const r = state.freeTextResize;
  state.freeTextResize = null;
  window.removeEventListener('pointermove', onWindowFreeTextResize, { capture: true });
  window.removeEventListener('pointerup', onWindowFreeTextResizeUp, { capture: true });
  window.removeEventListener('pointercancel', onWindowFreeTextResizeCancel, { capture: true });
  if (!r) return;
  const el = state.container.querySelector(`[data-ft-id="${r.ftId}"]`);
  if (el) el.classList.remove('is-resizing');
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.remove('has-active-drag');
  pushHistory();
}

// The platform cancelled the free-text resize.
function onWindowFreeTextResizeCancel(e) {
  freeTextResizeGuard.cancel(e);
}

// Apply a handle drag delta to ft. Conventions for each handle:
//   nw, w, sw → change x and w (left edge moves); x never goes past right edge
//   ne, e, se → change only w; x fixed
//   n, s      → change only h; y depends
//   The (handle → what to change) mapping is straightforward but error-prone
//   in code; we keep it explicit.
function applyHandleResize(ft, handle, r, dxPt, dyPt) {
  switch (handle) {
    case 'nw':
      ft.x = r.baseX + dxPt;
      ft.y = r.baseY + dyPt;
      ft.w = r.baseW - dxPt;
      ft.h = r.baseH - dyPt;
      break;
    case 'n':
      ft.y = r.baseY + dyPt;
      ft.h = r.baseH - dyPt;
      break;
    case 'ne':
      ft.y = r.baseY + dyPt;
      ft.w = r.baseW + dxPt;
      ft.h = r.baseH - dyPt;
      break;
    case 'e':
      ft.w = r.baseW + dxPt;
      break;
    case 'se':
      ft.w = r.baseW + dxPt;
      ft.h = r.baseH + dyPt;
      break;
    case 's':
      ft.h = r.baseH + dyPt;
      break;
    case 'sw':
      ft.x = r.baseX + dxPt;
      ft.w = r.baseW - dxPt;
      ft.h = r.baseH + dyPt;
      break;
    case 'w':
      ft.x = r.baseX + dxPt;
      ft.w = r.baseW - dxPt;
      break;
    default: break;
  }
}

// Remove a free-form text box by id (used by both the overlay's delete
// button and the Delete key handler).
function deleteFreeTextById(ftId) {
  if (!ftId) return;
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page || !Array.isArray(page.freeTexts)) return;
  const before = page.freeTexts.length;
  page.freeTexts = page.freeTexts.filter((ft) => ft.id !== ftId);
  if (page.freeTexts.length === before) return;
  if (state.selectedFreeTextId === ftId) state.selectedFreeTextId = null;
  pushHistory();
  renderActivePage();
  renderPageThumbs();
  renderCustomPanel();
}
// ---- render: photo palette --------------------------------------------------
// ---- render: photo palette --------------------------------------------------

function renderPhotoPalette() {
  const strip = state.container.querySelector('#album-palette-strip');
  if (!strip) return;
  // Build a deduplicated list of all photos across all events
  const seen = new Set();
  const photos = [];
  for (const ev of state.events) {
    for (const p of (ev.photos || [])) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      photos.push(p);
    }
  }
  if (photos.length === 0) {
    strip.innerHTML = '<div class="album-palette-empty">没有可拖动的照片</div>';
    return;
  }
  strip.innerHTML = photos.map((p) => `
    <div class="album-palette-item" data-photo-id="${escapeHtml(p.id)}" title="${escapeHtml(p.original_name || p.id)}">
      <div class="album-palette-thumb" data-photo-thumb-id="${escapeHtml(p.id)}"></div>
    </div>
  `).join('');
  // Fetch data URLs (uses the existing cache)
  photos.forEach((p) => {
    fetchPhotoDataUrl(p.id).then((url) => {
      if (!url) return;
      state.photoUrls.set(p.id, url);
      const slot = state.container.querySelector(`[data-photo-thumb-id="${CSS.escape(p.id)}"]`);
      if (slot) slot.innerHTML = `<img src="${escapeHtml(url)}" alt="" draggable="false"/>`;
    }).catch(() => {});
  });
}

// ---- pointer events: palette → canvas drag ----------------------------------
//
// Single drag state machine. pointerdown on a palette item OR a canvas photo
// slot starts a drag; pointermove tracks; pointerup resolves into the target
// slot (if any).

function onPalettePointerDown(e) {
  const item = e.target.closest('.album-palette-item');
  if (!item) return;
  e.preventDefault();
  const photoId = item.getAttribute('data-photo-id');
  if (!photoId) return;
  startDrag({
    kind: 'palette',
    photoId,
    sourceSlotIdx: null,
    sourcePageIdx: null,
    ghostText: item.getAttribute('title') || '',
  }, e);
}

function onCanvasSlotPointerDown(e, slotIdx) {
  // Click selects the slot. If a drag is in progress this won't fire because
  // we captured the pointer. Pointer up handler resolves the drop.
  const el = e.currentTarget;
  const slotType = el.getAttribute('data-slot-type');

  // ---- swapArmed handling ----
  // If a previous double-click armed a swap, the next click on a photo slot
  // resolves it: click on another occupied photo → swap; click on empty
  // photo → cancel; click on text → cancel.
  if (state.swapArmed && slotType === 'photo') {
    const cur = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
    if (cur && cur.photoId && slotIdx !== state.swapArmed.slotIdx) {
      e.preventDefault();
      commitSwap(slotIdx);
      return;
    }
    // Empty target or same slot → cancel armed swap
    state.swapArmed = null;
    renderActivePage();
    return;
  }
  if (state.swapArmed && slotType !== 'photo') {
    // Click on a non-photo slot cancels
    state.swapArmed = null;
  }

  state.selectedSlotIdx = slotIdx;
  state.selectedSlotType = slotType;
  if (slotType === 'photo') {
    const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
    if (content && content.photoId) {
      // Double-click on a photo with content → enter swap-armed mode
      // (replaces the old "default slot→slot drag" UX).
      if (e.detail === 2) {
        e.preventDefault();
        state.swapArmed = {
          slotIdx,
          pageIdx: state.selectedPageIdx,
          photoId: content.photoId,
          transform: { ...content.transform },
        };
        renderActivePage();
        return;
      }
      // Default → pan the photo inside its slot. Alt+drag is the
      // legacy slot→slot drag (kept for power users).
      e.preventDefault();
      if (e.altKey || e.metaKey || e.button === 1) {
        startDrag({
          kind: 'slot',
          photoId: content.photoId,
          sourceSlotIdx: slotIdx,
          sourcePageIdx: state.selectedPageIdx,
          ghostText: '',
        }, e);
      } else {
        startPhotoPan(slotIdx, e);
      }
    } else {
      // Empty photo slot — select only
      renderActivePage();
      return;
    }
  } else {
    // Text slot — default click selects the text for in-place editing
    // via the floating toolbar. We DO NOT call startTextPan here, because
    // startTextPan pushes history + grabs window-level pointer listeners
    // on every click, which (a) floods the undo stack and (b) interferes
    // with the contenteditable focus the user needs to type.
    //
    // To pan the text within its slot, the user uses the X/Y sliders in
    // the right inspector panel (or the offsetX/Y controls).
    state.selectedSlotIdx = slotIdx;
    state.selectedSlotType = slotType;
    state.editingPhotoSlotIdx = null;
    state.swapArmed = null;
    // Clear is-selected on any other slot first
    const canvas = state.container.querySelector('#album-canvas');
    if (canvas) {
      canvas.querySelectorAll('.album-slot.is-selected').forEach((n) => {
        if (n !== el) n.classList.remove('is-selected');
      });
    }
    el.classList.add('is-selected');
    // Also clear the inner .album-text .is-selected (it was set by the old
    // render path's editable flag) so the selection ring shows on the
    // outer slot, not the inner text frame.
    const innerText = el.querySelector('.album-text');
    if (innerText) innerText.classList.add('is-selected');
    // Mount the toolbar (sets contenteditable on the inner text element,
    // focuses it, places the caret at the end). NO re-render — the
    // contenteditable element must stay in the DOM for the focus to stick.
    if (typeof mountFloatingToolbar === 'function') mountFloatingToolbar();
  }
}

// Commit the swap armed by a previous double-click. Exchanges photoId,
// transform and empty flag between the armed slot and the target slot.
function commitSwap(targetSlotIdx) {
  const armed = state.swapArmed;
  if (!armed) return;
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page) return;
  const src = page.slots[armed.slotIdx];
  const dst = page.slots[targetSlotIdx];
  if (!src || !dst) return;
  if (!src.photoId || !dst.photoId) return;
  pushHistory();
  const tmpPhotoId = src.photoId;
  const tmpTransform = src.transform;
  src.photoId = dst.photoId;
  src.transform = { ...dst.transform };
  src.empty = false;
  dst.photoId = tmpPhotoId;
  dst.transform = { ...tmpTransform };
  dst.empty = false;
  // Record the swap in the log so the order-customization column picks
  // it up. We key by photoId rather than slotIdx so a swap survives
  // subsequent layout reorders.
  if (!state.swapLog) state.swapLog = new Set();
  state.swapLog.add(src.photoId);
  state.swapLog.add(dst.photoId);
  state.swapArmed = null;
  renderActivePage();
  renderPageThumbs();
  renderCustomPanel();
}

// ---- direct photo pan/zoom --------------------------------------------------
//
// When the user holds Alt and drags a photo on the canvas, the photo's
// transform.x/y is updated (pan). Wheel (with or without Alt) on a photo
// adjusts transform.zoom. This is independent of the slot→slot drag system.

function startPhotoPan(slotIdx, e) {
  const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
  if (!content) return;
  const t = content.transform || (content.transform = { x: 50, y: 50, zoom: 1 });
  state.photoPan = {
    slotIdx,
    startX: e.clientX,
    startY: e.clientY,
    baseX: t.x,
    baseY: t.y,
    // We translate pixel deltas to 0..100 pan units based on the slot
    // pixel size at the moment of drag start.
    pixelsToUnits: computePanUnitsPerPixel(slotIdx),
  };
  // Claim the gesture — see the guard notes above.
  photoPanGuard.begin(e && e.pointerId);
  window.addEventListener('pointermove', onWindowPhotoPanMove, { capture: true });
  window.addEventListener('pointerup', onWindowPhotoPanUp, { capture: true });
  window.addEventListener('pointercancel', onWindowPhotoPanCancel, { capture: true });
  // Visual hint: cursor + slot outline + alignment crosshair
  const slotEl = state.container.querySelector(`[data-slot-idx="${slotIdx}"]`);
  if (slotEl) slotEl.classList.add('is-panning');
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.add('has-active-drag');
  pushHistory();
}

function computePanUnitsPerPixel(slotIdx) {
  // Pan unit range: 0..100 covers the slot's width/height. So 1 pixel of
  // mouse movement = 100 / slotWidthPx units in x, and similarly for y.
  const tpl = getLayoutTemplate(state.layout.pages[state.selectedPageIdx].templateId);
  const tSlot = tpl.slots[slotIdx];
  if (!tSlot) return { x: 1, y: 1 };
  const r = slotRect(tSlot, state.canvasPx.w, state.canvasPx.h, tSlot.padding || 0);
  return {
    x: r.w > 0 ? 100 / r.w : 1,
    y: r.h > 0 ? 100 / r.h : 1,
  };
}

// ---- value clamps ---------------------------------------------------------
// All mutations on photo.transform / text.textOffset pass through these so
// that dirty external data (e.g. set from DevTools, future IPC, or a
// corrupted save file) never escapes the legal range.

function clampPhotoTransform(t) {
  const src = t || {};
  return {
    x:    Math.max(0,   Math.min(100, Number(src.x)    || 50)),
    y:    Math.max(0,   Math.min(100, Number(src.y)    || 50)),
    zoom: Math.max(0.1, Math.min(4,   Number(src.zoom) || 1)),
  };
}

function clampTextOffset(o) {
  const src = o || {};
  return {
    x: Math.max(-300, Math.min(300, Number(src.x) || 0)),
    y: Math.max(-180, Math.min(180, Number(src.y) || 0)),
  };
}

// Compare two clamp-able values; returns true if a clamp actually changed
// the value (used to decide whether to show the "clamped" UI warning).
function wasClamped(prev, next) {
  return Math.abs((prev || 0) - (next || 0)) > 0.001;
}

function onWindowPhotoPanMove(e) {
  const p = state.photoPan;
  if (!p) return;
  // A move from a foreign pointer means the gesture is dead (post-suspend).
  if (!photoPanGuard.move(e)) return;
  const dx = e.clientX - p.startX;
  const dy = e.clientY - p.startY;
  const content = state.layout.pages[state.selectedPageIdx].slots[p.slotIdx];
  if (!content) return;
  content.transform = content.transform || { x: 50, y: 50, zoom: 1 };
  // Pan semantics: the image should follow the cursor (Figma/Photos.app
  // convention). Mouse moves right by dx → image also moves right inside
  // the slot, exposing more of the LEFT side of the image (which is what
  // `transform.x > 50` does: shifts the image further right in the slot).
  const newX = Math.max(0, Math.min(100, p.baseX + dx * p.pixelsToUnits.x));
  const newY = Math.max(0, Math.min(100, p.baseY + dy * p.pixelsToUnits.y));
  content.transform.x = newX;
  content.transform.y = newY;
  updateSlotPhotoTransform(state.selectedPageIdx, p.slotIdx);
}

function onWindowPhotoPanUp(e) {
  const p = state.photoPan;
  state.photoPan = null;
  window.removeEventListener('pointermove', onWindowPhotoPanMove, { capture: true });
  window.removeEventListener('pointerup', onWindowPhotoPanUp, { capture: true });
  window.removeEventListener('pointercancel', onWindowPhotoPanCancel, { capture: true });
  if (p && p.slotIdx != null) {
    const slotEl = state.container.querySelector(`[data-slot-idx="${p.slotIdx}"]`);
    if (slotEl) slotEl.classList.remove('is-panning');
  }
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.remove('has-active-drag');
}

// The platform cancelled the photo pan.
function onWindowPhotoPanCancel(e) {
  photoPanGuard.cancel(e);
}

// ---- direct text pan -------------------------------------------------------
//
// Alt + drag a text slot to move the text inside its slot. We work in pixel
// units that mirror the PDF's pt-space (1px = 1pt in user space because the
// editor canvas is scaled to match A4 exactly — see computeCanvasSize).

function startTextPan(slotIdx, e) {
  const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
  if (!content) return;
  content.textOffset = content.textOffset || { x: 0, y: 0 };
  state.textPan = {
    slotIdx,
    startX: e.clientX,
    startY: e.clientY,
    baseX: content.textOffset.x || 0,
    baseY: content.textOffset.y || 0,
  };
  // Claim the gesture — see the guard notes above.
  textPanGuard.begin(e && e.pointerId);
  window.addEventListener('pointermove', onWindowTextPanMove, { capture: true });
  window.addEventListener('pointerup', onWindowTextPanUp, { capture: true });
  window.addEventListener('pointercancel', onWindowTextPanCancel, { capture: true });
  const slotEl = state.container.querySelector(`[data-slot-idx="${slotIdx}"]`);
  if (slotEl) slotEl.classList.add('is-panning');
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.add('has-active-drag');
  pushHistory();
}

function onWindowTextPanMove(e) {
  const p = state.textPan;
  if (!p) return;
  // A move from a foreign pointer means the gesture is dead (post-suspend).
  if (!textPanGuard.move(e)) return;
  const content = state.layout.pages[state.selectedPageIdx].slots[p.slotIdx];
  if (!content) return;
  // 1:1 px → pt mapping keeps PDF and editor visually identical.
  const dx = e.clientX - p.startX;
  const dy = e.clientY - p.startY;
  content.textOffset = {
    x: Math.max(-300, Math.min(300, p.baseX + dx)),
    y: Math.max(-180, Math.min(180, p.baseY + dy)),
  };
  updateTextOffset(state.selectedPageIdx, p.slotIdx);
  // Keep inspector sliders in sync
  const xRange = state.container.querySelector('#album-text-x');
  const yRange = state.container.querySelector('#album-text-y');
  if (xRange) xRange.value = String(Math.round(content.textOffset.x));
  if (yRange) yRange.value = String(Math.round(content.textOffset.y));
}

function onWindowTextPanUp() {
  const p = state.textPan;
  state.textPan = null;
  window.removeEventListener('pointermove', onWindowTextPanMove, { capture: true });
  window.removeEventListener('pointerup', onWindowTextPanUp, { capture: true });
  window.removeEventListener('pointercancel', onWindowTextPanCancel, { capture: true });
  if (p && p.slotIdx != null) {
    const slotEl = state.container.querySelector(`[data-slot-idx="${p.slotIdx}"]`);
    if (slotEl) slotEl.classList.remove('is-panning');
  }
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.classList.remove('has-active-drag');
}

// The platform cancelled the text pan.
function onWindowTextPanCancel(e) {
  textPanGuard.cancel(e);
}

function onCanvasWheel(e) {
  // Wheel over a photo slot → zoom that photo. We allow this without
  // requiring Alt since it's a natural gesture over the image.
  if (!e.target) return;
  const slotEl = e.target.closest && e.target.closest('[data-slot-idx][data-slot-type="photo"]');
  if (!slotEl) return;
  const slotIdx = Number(slotEl.getAttribute('data-slot-idx'));
  const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
  if (!content || !content.photoId) return;
  e.preventDefault();
  // deltaY < 0 = scroll up = zoom in. 1 notch ≈ 10% zoom.
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const cur = (content.transform && content.transform.zoom) || 1;
  const next = Math.max(0.1, Math.min(4, cur * factor));
  content.transform = content.transform || { x: 50, y: 50, zoom: 1 };
  content.transform.zoom = next;
  updateSlotPhotoTransform(state.selectedPageIdx, slotIdx);
  // Keep inspector sliders in sync if visible
  const zoomRange = state.container.querySelector('#album-zoom');
  if (zoomRange) zoomRange.value = String(Math.round(next * 10));
}

function onCanvasPointerMove(e) {
  if (!state.drag) return;
  // Follow the cursor with the ghost.
  //
  // NOTE: this used to call a `moveDragGhost()` that never existed — the
  // function was renamed to `positionGhost()` when the album editor was
  // first written, but this call site was missed. The ReferenceError threw
  // out of this function on EVERY pointermove, so the drop target was
  // never highlighted and `state.drag.overSlotIdx` was never set — which
  // meant a photo drag never actually committed a drop.
  positionGhost(e);
  // Highlight the target slot
  const over = findSlotUnderPointer(e);
  state.container.querySelectorAll('.album-slot.is-drop-target').forEach((el) => {
    el.classList.remove('is-drop-target');
  });
  if (over && over.el) over.el.classList.add('is-drop-target');
  state.drag.overSlotIdx = over ? over.slotIdx : null;
  state.drag.overSlotType = over ? over.slotType : null;
}

function onCanvasPointerUp(e) {
  if (!state.drag) return;
  // Defence in depth: only the pointer that STARTED the drag may commit a
  // drop.
  //
  // The guard already routes the window-level `pointerup` correctly, but
  // this handler is also bound to the canvas element (`canvas.onpointerup`),
  // so it can be reached by a click that has nothing to do with the drag.
  // If that click comes from a different pointer — which is exactly what
  // happens after a system suspend, when the mouse is re-created with a new
  // pointer id — committing here would swap a photo into a slot the user
  // never dropped it on.
  //
  // So: if a drag is live but this event is from a foreign pointer, the
  // drag is stale. Tear it down without committing anything.
  if (e && photoDragGuard.isActive() && e.pointerId !== undefined
      && e.pointerId !== null && !photoDragGuard.move(e)) {
    // The guard has already cancelled the drag.
    return;
  }
  const over = state.drag.overSlotIdx;
  const overType = state.drag.overSlotType;
  const sourceSlotIdx = state.drag.sourceSlotIdx;
  const sourcePageIdx = state.drag.sourcePageIdx;
  const photoId = state.drag.photoId;
  cleanupDrag();
  if (over == null || overType !== 'photo') {
    // Drop on empty area — no-op
    return;
  }
  const targetPage = state.layout.pages[state.selectedPageIdx];
  const targetContent = targetPage.slots[over];
  if (!targetContent || targetContent.type !== 'photo') return;
  // Same-slot drop = no-op
  if (sourceSlotIdx === over && sourcePageIdx === state.selectedPageIdx) return;
  if (targetContent.photoId) {
    // Swap: exchange photoIds between source and target
    const sourcePage = state.layout.pages[sourcePageIdx];
    if (sourcePageIdx != null && sourceSlotIdx != null) {
      pushHistory();
      const sourceContent = sourcePage.slots[sourceSlotIdx];
      const tmpId = sourceContent.photoId;
      const tmpTransform = sourceContent.transform;
      sourceContent.photoId = targetContent.photoId;
      sourceContent.transform = targetContent.transform;
      sourceContent.empty = !sourceContent.photoId;
      targetContent.photoId = tmpId;
      targetContent.transform = tmpTransform;
      targetContent.empty = !targetContent.photoId;
      if (!state.swapLog) state.swapLog = new Set();
      state.swapLog.add(sourceContent.photoId);
      state.swapLog.add(targetContent.photoId);
    } else {
      // From palette into occupied slot — replace
      pushHistory();
      targetContent.photoId = photoId;
      targetContent.transform = { x: 50, y: 50, zoom: 1 };
      targetContent.empty = false;
    }
  } else {
    // Empty slot — place the photo
    pushHistory();
    targetContent.photoId = photoId;
    targetContent.transform = { x: 50, y: 50, zoom: 1 };
    targetContent.empty = false;
  }
  // Ensure URL is cached
  if (photoId && !state.photoUrls.has(photoId)) {
    fetchPhotoDataUrl(photoId).then((url) => {
      if (url) {
        state.photoUrls.set(photoId, url);
        renderActivePage();
      }
    }).catch(() => {});
  }
  renderActivePage();
  renderPageThumbs();
  renderCustomPanel();
}

function findSlotUnderPointer(e) {
  const canvas = state.container.querySelector('#album-canvas');
  if (!canvas) return null;
  // Walk up from the element under the pointer; if it's a slot, return it
  let el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return null;
  // If the user is over the canvas's own area (not in a slot), bail
  if (!canvas.contains(el)) return null;
  while (el && el !== canvas) {
    if (el.hasAttribute && el.hasAttribute('data-slot-idx')) {
      return {
        el,
        slotIdx: Number(el.getAttribute('data-slot-idx')),
        slotType: el.getAttribute('data-slot-type'),
      };
    }
    el = el.parentElement;
  }
  return null;
}

function startDrag(drag, e) {
  // A previous drag may still be live (its `pointerup` was lost). Cancel it
  // first — otherwise its ghost element is orphaned on screen and its
  // listeners stay registered.
  if (state.drag) cleanupDrag();
  state.drag = drag;
  // Create a ghost element
  const ghost = document.createElement('div');
  ghost.className = 'album-drag-ghost';
  ghost.textContent = drag.ghostText || '🖼';
  document.body.appendChild(ghost);
  state.drag.ghost = ghost;
  positionGhost(e);
  // Take ownership of the gesture, so a `pointerup` from a DIFFERENT
  // pointer (which is what the mouse looks like after a system suspend)
  // cancels the drag instead of being ignored. See the guard notes above.
  photoDragGuard.begin(e && e.pointerId);
  // Capture global pointer events
  window.addEventListener('pointermove', onWindowPointerMove, { capture: true });
  window.addEventListener('pointerup', onWindowPointerUp, { capture: true });
  window.addEventListener('pointercancel', onWindowPointerCancel, { capture: true });
}

function onWindowPointerMove(e) {
  if (!state.drag) return;
  // A move from a foreign pointer means our gesture is dead (post-suspend).
  // The guard cancels it, which removes the ghost and the listeners.
  if (!photoDragGuard.move(e)) return;
  positionGhost(e);
  onCanvasPointerMove(e);
}

function onWindowPointerUp(e) {
  if (!state.drag) return;
  // Only a `pointerup` from the gesture's OWN pointer commits the drop.
  // A foreign one cancels it — that is what stops a stale drag from
  // swapping a photo into a slot the user never dropped it on.
  photoDragGuard.end(e);
}

// The platform cancelled the gesture (a touch being hijacked, a pen leaving
// range, a system gesture taking over).
function onWindowPointerCancel(e) {
  photoDragGuard.cancel(e);
}

function positionGhost(e) {
  if (!state.drag || !state.drag.ghost) return;
  const g = state.drag.ghost;
  g.style.left = `${e.clientX + 8}px`;
  g.style.top = `${e.clientY + 8}px`;
}

function cleanupDrag() {
  if (state.drag) {
    if (state.drag.ghost) {
      try { state.drag.ghost.remove(); } catch {}
    }
    state.drag = null;
  }
  window.removeEventListener('pointermove', onWindowPointerMove, { capture: true });
  window.removeEventListener('pointerup', onWindowPointerUp, { capture: true });
  window.removeEventListener('pointercancel', onWindowPointerCancel, { capture: true });
  state.container.querySelectorAll('.album-slot.is-drop-target').forEach((el) => {
    el.classList.remove('is-drop-target');
  });
}

// ---- event handlers ---------------------------------------------------------

function handleBack() {
  if (state.onBack) state.onBack();
}

function handleExport() {
  if (state.onExport) {
    state.onExport(state.layout);
  }
}

// Add a new free-form text box centered on the current page canvas.
// Mirrors the way `handleAddPage` works for new pages — single click
// produces a single, ready-to-edit text box.
function handleAddFreeText() {
  if (!state.layout || !state.layout.pages[state.selectedPageIdx]) return;
  const pageDims = getPageDims(state.layout.pageShape);
  const w = 220;
  const h = 60;
  const x = Math.max(0, (pageDims.w - w) / 2);
  const y = Math.max(0, (pageDims.h - h) / 2);
  const ft = createFreeText({ x, y, w, h });
  // Use the theme's default text color for a less jarring first impression.
  const theme = getTheme(state.layout.themeId);
  ft.color = theme.cssVar.text || '#2a2a2a';
  pushHistory();
  const page = state.layout.pages[state.selectedPageIdx];
  page.freeTexts = page.freeTexts || [];
  page.freeTexts.push(ft);
  state.selectedFreeTextId = ft.id;
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  renderActivePage();
  renderCustomPanel();
}

function handleAddPage() {
  // Add a fresh page after the current one, using a default template and
  // pulling content from the current page's event (if any).
  pushHistory();
  const cur = state.layout.pages[state.selectedPageIdx];
  const eventId = cur ? cur.eventId : null;
  const ev = eventId ? state.eventById.get(eventId) : null;
  // Find an unused photo from the same event (or any event) to seed the page
  const usedIds = new Set();
  state.layout.pages.forEach((p) => p.slots.forEach((s) => {
    if (s.photoId) usedIds.add(s.photoId);
  }));
  let seedPhoto = null;
  for (const e of state.events) {
    for (const p of (e.photos || [])) {
      if (!usedIds.has(p.id)) { seedPhoto = p; break; }
    }
    if (seedPhoto) break;
  }
  const tpl = getLayoutTemplate('single-full');
  const newPage = {
    templateId: 'single-full',
    eventId: eventId,
    slots: [
      seedPhoto
        ? { type: 'photo', photoId: seedPhoto.id, transform: { x: 50, y: 50, zoom: 1 },
            _slotTemplate: { x: tpl.slots[0].x, y: tpl.slots[0].y, w: tpl.slots[0].w, h: tpl.slots[0].h, padding: 0 } }
        : { type: 'photo', photoId: null, transform: { x: 50, y: 50, zoom: 1 },
            _slotTemplate: { x: tpl.slots[0].x, y: tpl.slots[0].y, w: tpl.slots[0].w, h: tpl.slots[0].h, padding: 0 }, empty: true },
      { type: 'caption', text: ev ? '' : '',
        _slotTemplate: { x: tpl.slots[1].x, y: tpl.slots[1].y, w: tpl.slots[1].w, h: tpl.slots[1].h, padding: 4 } },
    ],
  };
  // Fill caption with event data
  if (ev) {
    import('../album_builder.js').then((mod) => {
      newPage.slots[1].text = mod.buildEventCaption(ev);
      state.layout.pages.splice(state.selectedPageIdx + 1, 0, newPage);
      selectPage(state.selectedPageIdx + 1);
    });
  } else {
    state.layout.pages.splice(state.selectedPageIdx + 1, 0, newPage);
    selectPage(state.selectedPageIdx + 1);
  }
}

function handleDeletePage() {
  if (state.layout.pages.length <= 1) {
    toast('至少需要保留一页');
    return;
  }
  pushHistory();
  state.layout.pages.splice(state.selectedPageIdx, 1);
  if (state.selectedPageIdx >= state.layout.pages.length) {
    state.selectedPageIdx = state.layout.pages.length - 1;
  }
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.selectedFreeTextId = null;
  renderPageThumbs();
  renderActivePage();
}

function handleChangePageTemplate(pageIdx, newTemplateId) {
  const cur = state.layout.pages[pageIdx];
  if (!cur) return;
  const ev = state.eventById.get(cur.eventId);
  const next = remapPageTemplate(cur, newTemplateId, { event: ev });
  if (next.templateId === cur.templateId) return;
  pushHistory();
  state.layout.pages[pageIdx] = next;
  renderPageThumbs();
  renderActivePage();
}

// ---- photo prefetch (so canvas images appear quickly) -----------------------

function prefetchPagePhotos(pageIdx) {
  const page = state.layout.pages[pageIdx];
  if (!page) return;
  const ids = new Set();
  page.slots.forEach((s) => { if (s.photoId) ids.add(s.photoId); });
  ids.forEach((id) => prefetchPhoto(id));
}

// Prefetch every photo referenced by any page (used so page thumbnails
// can render real images, not just gray blocks). Cheaper than streaming
// every page's photos on selection.
function prefetchAllPhotos() {
  const ids = new Set();
  state.layout.pages.forEach((page) => {
    page.slots.forEach((s) => { if (s.photoId) ids.add(s.photoId); });
  });
  ids.forEach((id) => prefetchPhoto(id));
}

function prefetchPhoto(photoId) {
  if (state.photoUrls.has(photoId)) return;
  fetchPhotoDataUrl(photoId).then((url) => {
    if (!url) return;
    state.photoUrls.set(photoId, url);
    // Update the current page's photo element if it shows this id
    const page2 = state.layout.pages[state.selectedPageIdx];
    if (!page2) return;
    const slotIdx = page2.slots.findIndex((s) => s.photoId === photoId);
    if (slotIdx >= 0) {
      const el = state.container.querySelector(`[data-slot-idx="${slotIdx}"] .album-photo`);
      if (el) {
        el.innerHTML = `<img src="${escapeHtml(url)}" alt="" draggable="false"/>`;
      }
    }
  }).catch(() => {});
}

// ---- Customizations panel ----------------------------------------------------
// Three independent dimensions, like immich-book:
//   blue  = ratio  — photo whose transform.zoom differs from 1
//   green = order  — photo that has been swapped at least once
//   violet= caption pos — text slot whose textOffset is non-default
// A "全部重置" button per column clears that dimension back to defaults.

function toggleCustomPanel() {
  state.customPanelOpen = !state.customPanelOpen;
  const panel = state.container.querySelector('#album-custom-panel');
  if (panel) panel.hidden = !state.customPanelOpen;
  if (state.customPanelOpen) renderCustomPanel();
}

function collectCustomizations() {
  const out = { ratio: [], order: [], captionPos: [], freetext: [] };
  state.layout.pages.forEach((page, pi) => {
    page.slots.forEach((s, si) => {
      if (s.type === 'photo' && s.photoId) {
        const t = s.transform || {};
        if (Math.abs((t.zoom != null ? t.zoom : 1) - 1) > 0.01) {
          out.ratio.push({
            pi, si,
            label: (state.photoById.get(s.photoId) || {}).original_name || s.photoId,
            value: Number(t.zoom.toFixed(2)),
          });
        }
        if (state.swapLog && state.swapLog.has(s.photoId)) {
          out.order.push({
            pi, si,
            label: (state.photoById.get(s.photoId) || {}).original_name || s.photoId,
          });
        }
      } else if (s.type !== 'photo' && s.textOffset) {
        const o = s.textOffset;
        if ((o.x || 0) !== 0 || (o.y || 0) !== 0) {
          out.captionPos.push({
            pi, si,
            label: (s.text || '').slice(0, 18) || `文字 #${si + 1}`,
            value: `${Math.round(o.x || 0)},${Math.round(o.y || 0)}`,
          });
        }
      }
    });
    // Free-form text boxes
    (page.freeTexts || []).forEach((ft, fi) => {
      out.freetext.push({
        pi, fi,
        ftId: ft.id,
        label: (ft.text || '').replace(/\n/g, ' ').slice(0, 18) || `浮动文本 #${fi + 1}`,
      });
    });
  });
  return out;
}

function renderCustomPanel() {
  if (!state.container) return;
  const collected = collectCustomizations();
  const counts = collected.ratio.length + collected.order.length
    + collected.captionPos.length + collected.freetext.length;
  const dotCountEl = state.container.querySelector('#album-custom-dot-count');
  if (dotCountEl) dotCountEl.textContent = counts > 0 ? String(counts) : '';
  const lists = {
    ratio:     state.container.querySelector('#album-custom-ratio-list'),
    order:     state.container.querySelector('#album-custom-order-list'),
    captionPos:state.container.querySelector('#album-custom-caption-list'),
    freetext:  state.container.querySelector('#album-custom-freetext-list'),
  };
  const renderItem = (item, kind) => {
    const valueText = kind === 'ratio' ? `× ${item.value}`
      : kind === 'order' ? '已换槽'
      : kind === 'captionPos' ? `Δ ${item.value}`
      : '';
    return `<div class="album-custom-item"
      data-page-idx="${item.pi}"
      data-slot-idx="${item.si != null ? item.si : ''}"
      data-ft-id="${item.ftId || ''}">
      <span class="album-custom-item-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
      <span class="album-custom-item-value">${escapeHtml(valueText)}</span>
    </div>`;
  };
  if (lists.ratio) lists.ratio.innerHTML = collected.ratio.length
    ? collected.ratio.map((i) => renderItem(i, 'ratio')).join('')
    : '<div class="album-custom-empty">—</div>';
  if (lists.order) lists.order.innerHTML = collected.order.length
    ? collected.order.map((i) => renderItem(i, 'order')).join('')
    : '<div class="album-custom-empty">—</div>';
  if (lists.captionPos) lists.captionPos.innerHTML = collected.captionPos.length
    ? collected.captionPos.map((i) => renderItem(i, 'captionPos')).join('')
    : '<div class="album-custom-empty">—</div>';
  if (lists.freetext) lists.freetext.innerHTML = collected.freetext.length
    ? collected.freetext.map((i) => renderItem(i, 'freetext')).join('')
    : '<div class="album-custom-empty">—</div>';
  // Click an item → jump to its page + slot/freeText
  state.container.querySelectorAll('.album-custom-item').forEach((el) => {
    el.onclick = () => {
      const pi = Number(el.getAttribute('data-page-idx'));
      const ftId = el.getAttribute('data-ft-id') || null;
      if (!Number.isFinite(pi)) return;
      if (pi !== state.selectedPageIdx) selectPage(pi);
      if (ftId) {
        state.selectedFreeTextId = ftId;
        state.selectedSlotIdx = null;
        state.selectedSlotType = null;
        renderActivePage();
        return;
      }
      const si = Number(el.getAttribute('data-slot-idx'));
      if (!Number.isFinite(si)) return;
      state.selectedSlotIdx = si;
      const slot = state.layout.pages[pi] && state.layout.pages[pi].slots[si];
      state.selectedSlotType = slot ? slot.type : null;
      renderActivePage();
    };
  });
}

function resetCustomization(kind) {
  pushHistory();
  if (kind === 'ratio') {
    state.layout.pages.forEach((page) => {
      page.slots.forEach((s) => {
        if (s.type === 'photo' && s.photoId) {
          s.transform = clampPhotoTransform({ x: 50, y: 50, zoom: 1 });
        }
      });
    });
  } else if (kind === 'order') {
    state.swapLog = new Set();
  } else if (kind === 'caption-pos') {
    state.layout.pages.forEach((page) => {
      page.slots.forEach((s) => {
        if (s.type !== 'photo') {
          s.textOffset = clampTextOffset({ x: 0, y: 0 });
        }
      });
    });
  } else if (kind === 'freetext') {
    state.layout.pages.forEach((page) => {
      page.freeTexts = [];
    });
    state.selectedFreeTextId = null;
  }
  renderActivePage();
  renderCustomPanel();
}

// ---- undo / redo -------------------------------------------------------------
// Snapshot-based history. We snapshot the whole layout (JSON deep-clone) on
// every meaningful mutation. Cheap because AlbumLayout is mostly plain
// objects (no functions/DOM refs).

function pushHistory() {
  // Truncate any redo branch
  state.history = state.history.slice(0, state.historyIdx + 1);
  const snapshot = JSON.parse(JSON.stringify(state.layout));
  state.history.push(snapshot);
  if (state.history.length > state.historyMax) {
    state.history.shift();
  }
  state.historyIdx = state.history.length - 1;
  updateUndoRedoButtons();
}

function undo() {
  if (state.historyIdx <= 0) return;
  state.historyIdx -= 1;
  state.layout = JSON.parse(JSON.stringify(state.history[state.historyIdx]));
  ensurePageShape(state.layout);
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.selectedFreeTextId = null;
  state.swapArmed = null;
  renderPageThumbs();
  renderActivePage();
  renderCustomPanel();
  updateUndoRedoButtons();
}

function redo() {
  if (state.historyIdx >= state.history.length - 1) return;
  state.historyIdx += 1;
  state.layout = JSON.parse(JSON.stringify(state.history[state.historyIdx]));
  ensurePageShape(state.layout);
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.selectedFreeTextId = null;
  state.swapArmed = null;
  renderPageThumbs();
  renderActivePage();
  renderCustomPanel();
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const u = state.container && state.container.querySelector('#album-undo-btn');
  const r = state.container && state.container.querySelector('#album-redo-btn');
  if (u) u.disabled = state.historyIdx <= 0;
  if (r) r.disabled = state.historyIdx >= state.history.length - 1;
}

// ---- keyboard shortcuts ------------------------------------------------------
// Esc         → cancel swapArmed → clear selection
// Delete/Bksp → remove photo from selected photo slot (when not editing text)
// Ctrl/Cmd+Z  → undo   (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y → redo)

function onEditorKeydown(e) {
  // Undo / redo first — they win even when an input is focused, unless
  // the user is actively typing in the inspector textarea.
  const activeEl = document.activeElement;
  const activeTag = (activeEl && activeEl.tagName) || '';
  // contenteditable elements are not INPUT/TEXTAREA but the user is typing.
  // We want Esc/Delete to still clear selection in that case, so we treat
  // isEditable elements as "focused but Esc/Del still apply" — keep the
  // Ctrl+Z handling as well.
  const isContentEditable = !!(activeEl && activeEl.isContentEditable);
  const isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

  const meta = e.ctrlKey || e.metaKey;
  if (meta && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return;
  }
  if (isTyping) return;

  if (e.key === 'Escape') {
    if (state.swapArmed) {
      state.swapArmed = null;
      renderActivePage();
    } else if (state.selectedFreeTextId != null || state.selectedSlotIdx != null) {
      // clearTextSelection() also exits any active contenteditable
      // and hides the floating toolbar.
      clearTextSelection();
      renderActivePage();
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // While the user is typing in a contenteditable, do not hijack the key
    // — let the browser handle the deletion inside the text.
    if (isContentEditable) return;
    // Free-form text first — it sits on top of everything.
    if (state.selectedFreeTextId != null) {
      deleteFreeTextById(state.selectedFreeTextId);
      e.preventDefault();
      return;
    }
    if (state.selectedSlotType === 'photo' && state.selectedSlotIdx != null) {
      const c = state.layout.pages[state.selectedPageIdx]
        && state.layout.pages[state.selectedPageIdx].slots[state.selectedSlotIdx];
      if (c && c.photoId) {
        pushHistory();
        c.photoId = null;
        c.empty = true;
        c.transform = clampPhotoTransform(null);
        renderActivePage();
        renderPageThumbs();
        e.preventDefault();
      }
    }
  }
}
