// src/js/pages/events_memorial.js — 回忆事件 list.
//
// Reads from `memorial_events` (independent of the reminder events table).
// Each row carries its own kind ('first_time' / 'other'), occurrence time,
// multi-contact list, the diary background style it was written on, the
// ordered list of its photo ids, and the diary document (`content`) that
// says where the text and the photos sit.
//
// ---- The cards ----
//
// The list is a grid of CARDS, and each card is a miniature of the diary
// page the entry was written on: the same header bar with the title, the
// same paper background, the same text blocks and the same photo
// galleries in the same order — and the same decorative strip at the
// bottom.
//
// The card is a fixed size (320px, set on .memorial-card-sheet in
// src/css/styles.css), so an entry that is three paragraphs long and one
// that is a single sentence take up the same room. Whatever does not fit
// is cut off at the bottom, and the card fades out over its last lines so
// the cut reads as "there is more" rather than as a clipped sentence.
//
// Clicking a card opens the diary editor (src/js/pages/diary_edit.js).
import { api, escapeHtml, memorialPhotoUrl, fetchPhotoDataUrl } from '../api.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';
import { getDiaryTheme, diaryThemeVars } from '../diary_themes.js';
import {
  parseDiaryContent, effectivePhotoWidth, photoCssWidth,
  galleryLayout, DEFAULT_GALLERY_LAYOUT,
} from '../diary_layout.js';

// selectMode is per-page state so toggling bulk-delete mode doesn't lose
// the user's checkbox selections on re-render. `q` mirrors the current
// search so the list subtree can be re-filtered without an IPC round-trip;
// `allEvents` caches the loaded data for the same reason.
const pageState = {
  selectMode: { active: false, selected: new Set() },
  q: '',
  allEvents: [],
  basePath: '/events/memorial',
};

// Exported so the test harness (scripts/test-diary-editor.js) can drive
// the list directly, the way the router does.
export async function render(args, params) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  const opts = {};
  if (params.contact_id) opts.contact_id = params.contact_id;
  const events = await api.memorialEvents.list(opts);
  // Pre-warm the data-URL cache for every photo the cards show, so the
  // first paint doesn't flash empty img boxes before the IPC round-trip
  // resolves.
  for (const e of events) warmPhotos(e);
  pageState.allEvents = events;
  pageState.q = ((params && params.q) || '').trim().toLowerCase();
  // The URL is the single source of truth for the filter state, so it
  // carries the contact filter alongside the search query.
  const baseParams = new URLSearchParams();
  if (params.contact_id) baseParams.set('contact_id', params.contact_id);
  const baseQs = baseParams.toString();
  pageState.basePath = '/events/memorial' + (baseQs ? '?' + baseQs : '');

  // Same static-shell-plus-replaceable-subtree pattern as the work page
  // and the gift page: the search input lives OUTSIDE the rewritten list,
  // so typing IME Chinese candidates never tears down the live input.
  const initialQ = pageState.q;
  app.innerHTML = `
    <div id="page-header" class="row between">
      <h1>回忆事件 ${!pageState.selectMode.active && pageState.allEvents.length > 0 ? bulkEnterLinkHtml() : ''}</h1>
      <div class="row" style="gap:8px;">
        <button class="btn secondary" id="open-export" style="${pageState.allEvents.length > 0 ? '' : 'display:none;'}">导出回忆</button>
        <button class="btn" id="new-event">+ 新建</button>
      </div>
    </div>
    <div class="page-search">
      <input type="search" id="memorial-q" class="page-search-input"
             placeholder="在回忆事件中搜索…" autocomplete="off" />
      <button class="btn secondary page-search-clear" id="memorial-clear" type="button"
              style="${initialQ ? '' : 'display:none;'}">清除</button>
      <span class="meta page-search-meta" style="${initialQ ? '' : 'display:none;'}"></span>
    </div>
    <div id="memorial-list"></div>
  `;

  // Set initial query value on the freshly-mounted input only this once;
  // subsequent keystrokes read from the same node.
  const input = document.getElementById('memorial-q');
  if (input) input.value = initialQ;

  wireSearchInput();
  rerenderList();
  applyPhotos();

  // 静态头部按钮一次性绑定；行级 click handler 由 rerenderList() 在每次
  // 列表重绘时重新绑定，避免初次 mount 后又被覆盖。
  document.getElementById('new-event').onclick = () =>
    navigate('/diary/new' + (params.contact_id ? '?contact_id=' + encodeURIComponent(params.contact_id) : ''));
  const exportBtn = document.getElementById('open-export');
  if (exportBtn) exportBtn.onclick = () => navigate('/export');

  wireBulk();
}

// Re-render ONLY the list subtree (#memorial-list) and the search-row
// chrome (清除 button, 匹配数, 导出按钮可见性). Never touches
// #memorial-q — IME composition context is preserved across keystrokes.
function rerenderList() {
  const events = pageState.allEvents;
  const q = pageState.q;
  const filtered = q ? events.filter((e) => matchesMemorialQuery(e, q)) : events;
  const suppressed = events.length - filtered.length;

  const clearBtn = document.getElementById('memorial-clear');
  if (clearBtn) clearBtn.style.display = q ? '' : 'none';
  const metaEl = document.querySelector('.page-search-meta');
  if (metaEl) {
    metaEl.style.display = q ? '' : 'none';
    metaEl.textContent = q ? `${filtered.length} / ${events.length} 条匹配` : '';
  }
  const exportBtn = document.getElementById('open-export');
  if (exportBtn) exportBtn.style.display = events.length > 0 ? '' : 'none';

  const host = document.getElementById('memorial-list');
  if (!host) return;
  host.innerHTML = `
    ${pageState.selectMode.active ? bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: filtered.length,
        kindLabel: '个回忆事件',
      }) : ''}
    ${events.length === 0
      ? `<div class="empty">还没有回忆事件 · 点 + 新建 创建一个</div>`
      : filtered.length === 0
        ? `<div class="empty">没有匹配「${escapeHtml(q)}」的回忆事件 · 已隐藏 ${suppressed} 条</div>`
        : `<div class="memorial-grid">${filtered.map((e) => pageState.selectMode.active
            ? bulkSelectableCardHtml(e, pageState.selectMode.selected.has(e.id))
            : renderRow(e)).join('')}</div>`}
  `;

  if (!pageState.selectMode.active) {
    host.querySelectorAll('.memorial-card.clickable').forEach((el) => {
      el.onclick = () => navigate('/diary/' + encodeURIComponent(el.dataset.id));
    });
  }
  if (pageState.selectMode.active) {
    wireBulkRowChecks(host, pageState.selectMode);
  }
}

// A card in select mode: the same card, with a checkbox on its title bar.
//
// The bulk helper's own row wrapper is a plain panel, which would put a
// frame around the page again — so the checkbox is added to the card
// instead of the card to a generic row.
function bulkSelectableCardHtml(e, checked) {
  const check = `
    <label class="memorial-card-check" title="选择这篇回忆">
      <input type="checkbox" class="bulk-row-check" data-bulk-id="${escapeHtml(e.id)}" ${checked ? 'checked' : ''}/>
    </label>`;
  return `
    <div class="bulk-row memorial-card memorial-card--selectable" data-bulk-id="${escapeHtml(e.id)}">
      ${cardSheetHtml(e, check)}
    </div>
  `;
}

// Wire the search input exactly once. IME-safe pattern (120ms idle
// settle + immediate flush at compositionend) mirrors the work page and
// the gift page. Differences vs the previous full-rerender design:
//   - apply() only updates pageState.q + repaints #memorial-list + URL,
//     it never replaces the input node, so 中文 候选词 are preserved;
//   - URL sync uses history.replaceState (no history entry pollution,
//     no router re-render) — same target as the work page.
function wireSearchInput() {
  const input = document.getElementById('memorial-q');
  const clearBtn = document.getElementById('memorial-clear');
  if (!input) return;
  if (!input.dataset.wired) {
    input.dataset.wired = '1';
    let settleTimer = null;
    const apply = () => {
      settleTimer = null;
      const next = input.value.trim().toLowerCase();
      pageState.q = next;
      const targetHash = next
        ? pageState.basePath + (pageState.basePath.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(next)
        : pageState.basePath;
      if (location.hash !== '#' + targetHash) {
        try { history.replaceState(null, '', '#' + targetHash); } catch (_) {}
      }
      rerenderList();
    };
    input.addEventListener('input', () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(apply, 120);
    });
    input.addEventListener('compositionend', () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      apply();
    });
  }
  if (clearBtn && !clearBtn.dataset.wired) {
    clearBtn.dataset.wired = '1';
    clearBtn.onclick = () => {
      if (input.value) input.value = '';
      pageState.q = '';
      const targetHash = pageState.basePath;
      if (location.hash !== '#' + targetHash) {
        try { history.replaceState(null, '', '#' + targetHash); } catch (_) {}
      }
      rerenderList();
      input.focus();
    };
  }
}

// Swap in the real data URLs once the IPC round-trip resolves. The
// initial render only writes `src=""` placeholders because
// `memorialPhotoUrl` is synchronous; without this follow-up the browser
// would mark the thumbnail as broken. Iterates over every photo id that
// was pre-warmed at render() time so first-paint races resolve cleanly.
function applyPhotos() {
  for (const e of pageState.allEvents) {
    for (const id of photoIdsOf(e)) {
      fetchPhotoDataUrl(id).then((url) => {
        if (!url) return;
        const app = document.getElementById('app');
        if (!app) return;
        app.querySelectorAll(`img[data-photo-id="${CSS.escape(id)}"]`).forEach((imgEl) => {
          if (imgEl.src !== url) imgEl.src = url;
        });
      });
    }
  }
}

// Every photo id an entry carries, oldest first.
//
// The card lays the photos out the way the diary editor wrote them, so it
// needs every id — the list endpoint returns them all in `photo_ids`.
// The older single-photo fields are kept as a fallback for a row that
// predates that column.
function photoIdsOf(e) {
  if (Array.isArray(e.photo_ids) && e.photo_ids.length) return e.photo_ids;
  return [e.first_photo_id, e.second_photo_id].filter(Boolean);
}

// Start fetching the bytes of every photo a card shows. The images are
// cached by id, so a photo that appears on several cards is read once.
function warmPhotos(e) {
  for (const id of photoIdsOf(e)) fetchPhotoDataUrl(id);
}

// Bulk-select wiring. Lives outside the rewritten subtree so it can
// re-bind on every list redraw without double-firing.
function wireBulk() {
  const handlers = {
    onDelete: async (ids) => {
      const result = await api.memorialEvents.deleteMany(ids);
      // 删除后重新拉取数据；保留输入框的当前值和筛选条件。
      const base = new URLSearchParams(pageState.basePath.split('?')[1] || '');
      await reloadAndRender({
        q: pageState.q,
        contact_id: base.get('contact_id') || undefined,
      });
      return result;
    },
    onExit: () => {
      pageState.selectMode.active = false;
      pageState.selectMode.selected = new Set();
      rerenderList();
      // 重新挂上「批量删除」入口链接 — 仅当列表非空时显示，否则删除按钮
      // 会指向无内容的列表，对用户无意义。
      const header = document.getElementById('page-header');
      if (pageState.allEvents.length === 0) return;
      if (header) {
        const base = new URLSearchParams(pageState.basePath.split('?')[1] || '');
        const contactQp = base.get('contact_id')
          ? '?contact_id=' + encodeURIComponent(base.get('contact_id'))
          : '';
        const newHeader = document.createElement('div');
        newHeader.id = 'page-header';
        newHeader.className = 'row between';
        newHeader.innerHTML = `
          <h1>回忆事件 ${bulkEnterLinkHtml()}</h1>
          <div class="row" style="gap:8px;">
            <button class="btn secondary" id="open-export">导出回忆</button>
            <button class="btn" id="new-event">+ 新建</button>
          </div>
        `;
        header.replaceWith(newHeader);
        document.getElementById('new-event').onclick = () =>
          navigate('/diary/new' + contactQp);
        const eb = document.getElementById('open-export');
        if (eb) eb.onclick = () => navigate('/export');
        wireBulkEnter(newHeader, () => {
          pageState.selectMode.active = true;
          pageState.selectMode.selected = new Set();
          rerenderList();
        });
      }
    },
  };

  if (pageState.selectMode.active) {
    pageState.selectMode.onChange = () => {
      const t = document.querySelector('[data-bulk-toolbar]');
      if (!t) return;
      document.querySelectorAll('.bulk-row-check').forEach((cb) => {
        const id = cb.dataset.bulkId;
        if (!id) return;
        cb.checked = pageState.selectMode.selected.has(id);
      });
      const count = pageState.selectMode.selected.size;
      const total = pageState.allEvents.filter((e) =>
        pageState.q ? matchesMemorialQuery(e, pageState.q) : true
      ).length;
      t.outerHTML = bulkToolbarHtml({
        count,
        total,
        kindLabel: '个回忆事件',
      });
      wireBulkToolbar(document.getElementById('app'), pageState.selectMode, handlers);
    };
    wireBulkRowChecks(document.getElementById('app'), pageState.selectMode);
    wireBulkToolbar(document.getElementById('app'), pageState.selectMode, handlers);
  }
  wireBulkEnter(document.getElementById('app'), () => {
    pageState.selectMode.active = true;
    pageState.selectMode.selected = new Set();
    rerenderList();
  });
}

async function reloadAndRender(params = {}) {
  const opts = {};
  if (params.contact_id) opts.contact_id = params.contact_id;
  const events = await api.memorialEvents.list(opts);
  for (const e of events) warmPhotos(e);
  pageState.allEvents = events;
  pageState.q = ((params && params.q) || '').trim().toLowerCase();
  render([], {
    contact_id: params.contact_id,
    q: pageState.q,
  });
}

function kindTagLabel(kind) {
  return kind === 'first_time' ? '第一次' : '其他';
}

// YYYY-MM-DD (no minutes). `formatRelative` is built for "when does the next
// reminder fire" so it always tags the time-of-day — useless here, since
// memorial events are anchored to a date, not an instant.
function formatDateOnly(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function contactSummary(e) {
  const names = (e.contact_names || []).filter(Boolean);
  if (names.length === 0) return '独立事件';
  if (names.length === 1) return names[0];
  return `${names[0]} 等 ${names.length} 人`;
}

// Render one card. The card IS the diary page — the header bar with the
// title, the paper with the text and the photos in the order the entry
// was written, and the strip at the bottom. There is no panel around it:
// the page stands on its own.
//
// The card is a fixed size, so the body is clipped and faded at the
// bottom — a long entry shows its beginning, never its end.
function renderRow(e) {
  return `
    <div class="memorial-card clickable" data-id="${escapeHtml(e.id)}">
      ${cardSheetHtml(e)}
    </div>
  `;
}

// The miniature diary page: the header bar with the title, the body with
// the text and the photos, and the strip at the bottom.
//
// The body is a THUMBNAIL of the page, not a redrawing of it: the
// document is laid out at the editor's own proportions and scaled down
// as one piece, so the card's edge cuts the page where a photograph of a
// page would cut it — a photo shows its top, the words below it are
// simply not there yet.
//
// The bottom strip is the sheet's third layer — the one the editor
// paints as a plain band. Here it carries the entry's details (who it
// was with, when, how many photos), in the sheet's own ink.
//
// `lead` is an optional mark on the title bar — the select-mode
// checkbox rides there.
function cardSheetHtml(e, lead) {
  const theme = getDiaryTheme(e.background);
  const themeVars = Object.entries(diaryThemeVars(theme))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return `
    <div class="memorial-card-sheet" style="${themeVars}">
      <div class="memorial-card-header">
        ${lead || ''}
        <span class="memorial-card-title">${escapeHtml(e.title || '(无标题)')}</span>
      </div>
      <div class="memorial-card-body">
        <div class="memorial-card-page">
          ${cardBlocksHtml(e)}
        </div>
      </div>
      <div class="memorial-card-foot">
        <span class="memorial-card-contact">${escapeHtml(contactSummary(e))}</span>
        <span class="memorial-card-date">${escapeHtml(formatDateOnly(e.occurred_at))}</span>
        <span class="tag">${escapeHtml(kindTagLabel(e.kind))}</span>
        ${e.photo_count ? `<span class="memorial-card-photos">${e.photo_count} 张照片</span>` : ''}
      </div>
    </div>
  `;
}

// The body of the card: the entry's document, rendered block by block.
//
// The blocks come from the same parser the editor uses, so the card
// shows the text and the photos in the order they were written, in the
// gallery arrangement the user chose.
//
// An entry written before the mixed editor existed has no document — it
// falls back to the plain `notes` text, exactly as the editor does.
function cardBlocksHtml(e) {
  const blocks = parseDiaryContent(e.content);
  if (!blocks.length) {
    const legacy = (e.notes || '').trim();
    return legacy
      ? `<div class="memorial-card-text">${escapeHtml(legacy)}</div>`
      : `<div class="memorial-card-text memorial-card-text--empty">（还没有正文）</div>`;
  }
  return blocks.map(cardBlockHtml).join('');
}

// One block of the document. A text block is its own paragraph; a gallery
// is a row of photos laid out the way the gallery was saved.
function cardBlockHtml(b) {
  if (b.type === 'text') {
    const text = (b.text || '').trim();
    if (!text) return '';
    return `<div class="memorial-card-text">${escapeHtml(text)}</div>`;
  }
  if (b.type === 'gallery') {
    return cardGalleryHtml(b);
  }
  return '';
}

// A gallery inside the card: the photos sit in a wrapping row, each one
// taking the share of the width the user gave it, or the layout's default
// when they left it alone.
//
// The gallery is the editor's gallery block — a framed panel with the
// photos inside it — laid out at the editor's own proportions. The whole
// page is scaled down afterwards, so the pictures keep their shape and
// their size relative to the paper.
function cardGalleryHtml(b) {
  const layout = galleryLayout(b.layout) || galleryLayout(DEFAULT_GALLERY_LAYOUT);
  const photos = b.photos.map((p) => {
    const url = memorialPhotoUrl(p.photo_id);
    const frac = effectivePhotoWidth(p, b.layout);
    return `
      <div class="memorial-card-photo" style="width:${photoCssWidth(frac)};">
        <img src="${escapeHtml(url)}" data-photo-id="${escapeHtml(p.photo_id)}" alt="" loading="lazy"/>
      </div>
    `;
  }).join('');
  return `
    <div class="memorial-card-gallery" data-layout="${escapeHtml(layout.id)}">
      <div class="memorial-card-gallery-items">${photos}</div>
    </div>
  `;
}

// Local search predicate for memorial events. We deliberately match across
// every user-visible field so a typed query feels "find what I see": title,
// description, place, food, outfit, activities, notes, and the names of any
// linked contacts. All comparisons are case-insensitive substring matches;
// there's no stemming or token-splitting — the list is small enough that
// fuzzy matching would feel surprising rather than helpful.
function matchesMemorialQuery(e, q) {
  if (!q) return true;
  const fields = [e.title, e.description, e.place, e.food, e.outfit, e.activities, e.notes];
  for (const f of fields) {
    if (typeof f === 'string' && f.toLowerCase().includes(q)) return true;
  }
  const names = (e.contact_names || []).filter(Boolean);
  for (const n of names) {
    if (n.toLowerCase().includes(q)) return true;
  }
  return false;
}

// Backward-compat no-op kept at file scope so any external reference
// (rare, kept for safety) doesn't get a name error.
function wirePageSearch() { /* no-op; see wireSearchInput() */ }

register('/events/memorial', render);
