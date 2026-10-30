// src/js/pages/events_memorial.js — 回忆事件 list.
//
// Reads from `memorial_events` (independent of the reminder events table).
// Each row carries its own kind ('first_time' / 'other'), occurrence time,
// multi-contact list, the diary background style it was written on, and an
// optional thumbnail of the first uploaded photo.
//
// Clicking a row opens the diary editor (src/js/pages/diary_edit.js).
import { api, escapeHtml, categoryIcon, memorialPhotoUrl, fetchPhotoDataUrl } from '../api.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml, bulkSelectableRowHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';
import { getDiaryTheme } from '../diary_themes.js';

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
  // Pre-warm the data-URL cache for every photo shown on the list page (up
  // to two thumbnails per row) so the first paint doesn't flash empty img
  // boxes before the IPC round-trip resolves.
  for (const e of events) {
    if (e.first_photo_id) fetchPhotoDataUrl(e.first_photo_id);
    if (e.second_photo_id) fetchPhotoDataUrl(e.second_photo_id);
  }
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
        : filtered.map((e) => pageState.selectMode.active
            ? bulkSelectableRowHtml(rowInner(e), e.id, pageState.selectMode.selected.has(e.id), 'memorial')
            : renderRow(e)).join('')}
  `;

  if (!pageState.selectMode.active) {
    host.querySelectorAll('.card.clickable').forEach((el) => {
      el.onclick = () => navigate('/diary/' + encodeURIComponent(el.dataset.id));
    });
  }
  if (pageState.selectMode.active) {
    wireBulkRowChecks(host, pageState.selectMode);
  }
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
    for (const id of [e.first_photo_id, e.second_photo_id]) {
      if (!id) continue;
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
  for (const e of events) {
    if (e.first_photo_id) fetchPhotoDataUrl(e.first_photo_id);
    if (e.second_photo_id) fetchPhotoDataUrl(e.second_photo_id);
  }
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

// Render up to two small thumbnails side-by-side. The list endpoint now
// returns both `first_photo_id` and `second_photo_id` so we don't need a
// second round-trip per row. Each <img> carries a `data-photo-id` join key
// so the post-render swap loop can find and update it once the data URL
// resolves.
function thumbsHtml(e) {
  const ids = [e.first_photo_id, e.second_photo_id].filter(Boolean).slice(0, 2);
  if (ids.length === 0) return '';
  const more = e.photo_count > ids.length ? `<span class="thumb-more">+${e.photo_count - ids.length}</span>` : '';
  const imgs = ids.map((id) => {
    const url = memorialPhotoUrl(id);
    return `<img class="thumb" src="${escapeHtml(url)}" data-photo-id="${escapeHtml(id)}" alt="" loading="lazy"/>`;
  }).join('');
  return `<span class="thumb-stack">${imgs}${more}</span>`;
}

function renderRow(e) {
  return `
    <div class="card list-row clickable memorial-row" data-kind="memorial" data-id="${escapeHtml(e.id)}">
      ${memorialRowInner(e)}
    </div>
  `;
}

function rowInner(e) {
  return memorialRowInner(e);
}

// Layout:
//   column 1: title (with kind tag)
//   column 2: contact names (same font size as the title) + relative time
//             on the same line
//   column 3: up to two photo thumbnails
//
// The user wanted the title to lead, the contacts to follow, and the photos
// to anchor the right edge. The avatar-stack was removed here — the title
// block already carries the category glyph, so a second avatar in front of
// the contact names just made the row feel busy.
function memorialRowInner(e) {
  const names = (e.contact_names || []).filter(Boolean);
  const contactText = contactSummary(e);
  // A small swatch of the background style the entry was written on, so
  // the list reads at a glance like a shelf of diary pages.
  const theme = getDiaryTheme(e.background);
  return `
    <div class="mr-title">
      <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
      <span class="lr-title">${escapeHtml(e.title || '(无标题)')}</span>
      <span class="tag">${escapeHtml(kindTagLabel(e.kind))}</span>
    </div>
    <div class="mr-mid">
      <span class="contact-text">${escapeHtml(contactText)}</span>
      <span class="contact-time"><span class="chip-dot"></span>${escapeHtml(formatDateOnly(e.occurred_at))}</span>
      <span class="mr-bg-swatch" title="${escapeHtml(theme.name)}" style="background:${escapeHtml(theme.headerBg)}"></span>
    </div>
    <div class="mr-thumbs">
      ${thumbsHtml(e)}
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
