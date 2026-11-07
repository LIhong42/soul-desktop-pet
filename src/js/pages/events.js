// src/js/pages/events.js — 提醒日期 list (general-category events).
//
// This page now includes two independent filter dropdowns:
//   - 类型 (tag_kind): 全部 / 生日 / 纪念日 / 节日 / 未分类
//   - 关联联系人 (contact_id): 全部 / a contact / (独立事件)
//
// Both filter values are reflected in the URL hash so the page can be
// bookmarked / shared. Changing either triggers a re-fetch via events:list.
import { api, escapeHtml, displayName, eventKindAttr, formatRelative, countdownTo, categoryIcon, repeatLabel, eventDisplayTitle } from '../api.js';
import { register, navigate } from '../router.js';
import { applyBackground } from '../page_background.js';
import { pageSlice, pagerHtml, wirePager } from '../pager.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml, bulkSelectableRowHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';

const TAG_KIND_FILTER_OPTIONS = [
  { value: '',            label: '全部' },
  { value: 'birthday',    label: '生日' },
  { value: 'anniversary', label: '纪念日' },
  { value: 'festival',    label: '节日' },
  { value: 'none',        label: '未分类' },
];

// selectMode is per-page-instance state. We attach it to a module-scoped
// object so toggling bulk-delete mode doesn't lose the user's checkbox
// selections on re-render.
//
// `page` is the current page index (0-based). It is NOT in the URL: the
// filters are (so a filtered view can be shared), but the page number is
// a transient view state, and putting it in the hash would make every
// "next page" click a history entry. A filter change resets it to 0.
const pageState = {
  selectMode: { active: false, selected: new Set() },
  page: 0,
};

async function render(args, params) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  // The page wears the shared background artwork. It's applied before the
  // list loads so the page doesn't flash the plain app surface first.
  await applyBackground();

  // Filters: tag_kind + contact_id. Both come from the URL hash so they
  // survive page reloads and can be shared as a URL.
  const tagKindFilter = (params && params.tag_kind) || '';
  const contactFilter = (params && params.contact_id) || '';

  const opts = { category: 'general' };
  if (tagKindFilter) opts.tag_kind = tagKindFilter;
  // Note: we deliberately don't pre-filter by contact_id on the server side
  // when the filter is 'standalone' (independent events). The renderer applies
  // that filter locally after the fetch — see below.
  if (contactFilter && contactFilter !== '__standalone__') opts.contact_id = contactFilter;

  const [events, contacts, festivals] = await Promise.all([
    api.events.list(opts),
    api.contacts.list(),
    api.events.listFestivals(),
  ]);
  const cById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  // Map festival code → human label so the list shows "父亲节" instead of
  // "fathers_day". Done up-front to avoid per-row async work in renderRow.
  const festByCode = Object.fromEntries(festivals.map((f) => [f.code, f.label]));

  // Apply the local contact filter on top of the server result. The server
  // already filters by category + tag_kind; this is the only place contact
  // filtering happens (so the (独立事件) bucket works without a DB query).
  const filteredEvents = events.filter((e) => {
    if (!contactFilter) return true;
    if (contactFilter === '__standalone__') return !e.contact_id;
    return e.contact_id === contactFilter;
  });

  // The list and the pager live in their OWN subtree (#reminders-list), so
  // that turning the page repaints only that strip. The filter bar above
  // it — and the `<select>` elements in it — are never rebuilt, so the
  // dropdowns keep their open state and the page doesn't flash.
  app.innerHTML = `
    <div class="bg-page">
      <div class="row between">
        <h1>提醒日期 ${pageState.selectMode.active ? '' : (filteredEvents.length > 0 ? bulkEnterLinkHtml() : '')}</h1>
        <button class="btn" id="new-event">+ 新建</button>
      </div>
      <div class="card">
        <div class="form-row">
          <div class="field">
            <label>类型</label>
            <select id="filter-tag-kind">
              ${TAG_KIND_FILTER_OPTIONS.map((o) =>
                `<option value="${escapeHtml(o.value)}" ${tagKindFilter === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label>关联联系人</label>
            <select id="filter-contact">
              <option value="">全部</option>
              <option value="__standalone__" ${contactFilter === '__standalone__' ? 'selected' : ''}>(独立事件)</option>
              ${contacts.map((c) =>
                `<option value="${escapeHtml(c.id)}" ${contactFilter === c.id ? 'selected' : ''}>${escapeHtml(displayName(c))}</option>`
              ).join('')}
            </select>
          </div>
        </div>
      </div>
      <div id="reminders-list"></div>
    </div>
  `;

  document.getElementById('new-event').onclick = () => navigate('/events/new?category=general');

  // Filter dropdowns — both navigate to a new hash with the filter values
  // encoded in the query string. The router re-renders the page on each
  // hash change so the URL is the single source of truth for filter state.
  function applyFilters() {
    const tk = document.getElementById('filter-tag-kind').value || '';
    const cf = document.getElementById('filter-contact').value || '';
    const q = new URLSearchParams();
    if (tk) q.set('tag_kind', tk);
    if (cf) q.set('contact_id', cf);
    const qs = q.toString();
    // A new filter means a new list — start it at the first page.
    pageState.page = 0;
    navigate('/reminders' + (qs ? '?' + qs : ''));
  }
  document.getElementById('filter-tag-kind').onchange = applyFilters;
  document.getElementById('filter-contact').onchange = applyFilters;

  // The pager. Changing the page repaints ONLY the list subtree — the
  // filter bar above it is left alone, so the dropdowns keep their state
  // and the page doesn't flash. The URL is untouched: the page number is
  // a view state, not part of the filtered view.
  function paintList() {
    const host = document.getElementById('reminders-list');
    if (!host) return;

    const { total, totalPages, visible } = pageSlice(filteredEvents, pageState);

    host.innerHTML = `
      ${pageState.selectMode.active ? bulkToolbarHtml({
          count: pageState.selectMode.selected.size,
          total: total,
          kindLabel: '个提醒日期',
        }) : ''}
      ${total === 0
        ? `<div class="empty">没有匹配的提醒日期</div>`
        : visible.map((e) => pageState.selectMode.active
            ? bulkSelectableRowHtml(rowInner(e, cById, festByCode), e.id, pageState.selectMode.selected.has(e.id), eventKindAttr(e))
            : renderRow(e, cById, festByCode)).join('')}
      ${pagerHtml(pageState.page, totalPages, total)}
    `;

    if (!pageState.selectMode.active) {
      host.querySelectorAll('.card.clickable').forEach((el) => {
        el.onclick = () => navigate('/events/' + el.dataset.id + '?category=general');
      });
    }

    wirePager(host, pageState, paintList, () => {
      // Keep the user at the top of the new page — otherwise they land
      // halfway down it, looking at rows they already saw.
      const scroller = document.querySelector('.content');
      if (scroller) scroller.scrollTop = 0;
    });

    if (pageState.selectMode.active) {
      wireBulkRowChecks(host, pageState.selectMode);
      // The toolbar is part of the subtree we just rewrote, so the button
      // the user is about to click is a NEW node — its handlers have to be
      // bound again.
      wireBulkToolbar(host, pageState.selectMode, bulkHandlers);
    }
  }

  // Bulk-select mode wiring.
  const bulkHandlers = {
    onDelete: async (ids) => {
      const result = await api.events.deleteMany(ids);
      // Refresh from DB so the list reflects the deletion. Re-render via
      // navigate() to also re-fetch filtered events from the server.
      const tk = document.getElementById('filter-tag-kind').value || '';
      const cf = document.getElementById('filter-contact').value || '';
      const q = new URLSearchParams();
      if (tk) q.set('tag_kind', tk);
      if (cf) q.set('contact_id', cf);
      const qs = q.toString();
      navigate('/reminders' + (qs ? '?' + qs : ''));
      return result;
    },
    onExit: () => {
      pageState.selectMode.active = false;
      pageState.selectMode.selected = new Set();
      // Re-navigate so we exit select mode and re-render in idle form.
      const tk = document.getElementById('filter-tag-kind').value || '';
      const cf = document.getElementById('filter-contact').value || '';
      const q = new URLSearchParams();
      if (tk) q.set('tag_kind', tk);
      if (cf) q.set('contact_id', cf);
      const qs = q.toString();
      navigate('/reminders' + (qs ? '?' + qs : ''));
    },
  };
  if (pageState.selectMode.active) {
    pageState.selectMode.onChange = () => {
      const t = document.querySelector('[data-bulk-toolbar]');
      if (!t) return;
      // Sync every row checkbox with the current Set — otherwise hitting
      // "全选" in the toolbar only updates the counter; the per-row boxes
      // stay empty because they were rendered once at enter-time.
      document.querySelectorAll('.bulk-row-check').forEach((cb) => {
        const id = cb.dataset.bulkId;
        if (!id) return;
        cb.checked = pageState.selectMode.selected.has(id);
      });
      t.outerHTML = bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: filteredEvents.length,
        kindLabel: '个提醒日期',
      });
      wireBulkToolbar(document.getElementById('reminders-list'), pageState.selectMode, bulkHandlers);
    };
  }
  wireBulkEnter(app, () => {
    pageState.selectMode.active = true;
    pageState.selectMode.selected = new Set();
    render(args, params);
  });

  // First paint of the list subtree.
  paintList();
}

// Inner content for a single event row when wrapped in a bulk-selectable
// shell. Same fields as renderRow but without the clickable-card wrapper.
function rowInner(e, cById, festByCode) {
  let displayTitle = resolveDisplayTitle(e, cById, festByCode);
  return renderRowInner(e, displayTitle, cById);
}

function renderRow(e, cById, festByCode) {
  // Festival events store their title as the festival code (e.g.
  // 'fathers_day'). Resolve to the human label for display.
  const displayTitle = resolveDisplayTitle(e, cById, festByCode);
  const kind = eventKindAttr(e);
  return `
        <div class="card list-row clickable" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(e.id)}">
          ${renderRowInner(e, displayTitle, cById)}
        </div>
      `;
}

// Compute the row's display title. Three cases:
//   1. Festival → resolve the code to a human label (e.g. 'fathers_day' → '父亲节').
//   2. Tag-kind + stored "的提醒" title → rewrite to "{name}的{tagKindLabel}" so the
//      list visually matches the holiday format ("刘杰的生日" rather than
//      "刘杰的提醒").
//   3. Otherwise → use the stored title as-is.
function resolveDisplayTitle(e, cById, festByCode) {
  const raw = e.title || '';
  if (e.tag_kind === 'festival' && festByCode && festByCode[raw]) {
    return festByCode[raw];
  }
  const contact = e.contact_id && cById && cById[e.contact_id] ? cById[e.contact_id] : null;
  if (contact && e.tag_kind && tagKindLabel(e.tag_kind) && raw.endsWith('的提醒')) {
    const name = displayName(contact);
    if (raw === `${name}的提醒`) {
      return `${name}的${tagKindLabel(e.tag_kind)}`;
    }
  }
  return raw;
}

// Shared row body used by both idle renderRow (wrapped in a .card) and
// bulk-select rowInner (wrapped in .bulk-row). Returns the inner three-column
// grid plus the right-side time chip.
function renderRowInner(e, displayTitle, cById) {
  const kind = eventKindAttr(e);
  const metaParts = [];
  if (e.lunar_month && e.lunar_day) metaParts.push(`农历 ${e.lunar_month}-${e.lunar_day}`);
  metaParts.push(repeatLabel(e));
  if (!e.active) metaParts.push('已结束');
  const meta = metaParts.join(' · ');
  // Time chip on the right: relative date + countdown.
  const target = e.next_fire_at || e.remind_date;
  const rel = formatRelative(target);
  const cd  = countdownTo(target);
  const tagLabel = e.tag_kind ? tagKindLabel(e.tag_kind) : null;
  // Fold the user's description into the title. An untagged reminder's title
  // is auto-generated ("爷爷的提醒"), so the description is the only real
  // content — without this the list shows a label and hides what the user
  // actually wrote.
  const titleText = eventDisplayTitle(e, displayTitle) || '(无标题)';
  return `
    <div class="lr-id">
      <span class="cat-icon" data-tone="${escapeHtml(kind)}">${escapeHtml(categoryIcon(e.category, e.tag_kind))}</span>
    </div>
    <div class="lr-main">
      <div class="lr-title">${escapeHtml(titleText)}${tagLabel ? ` <span class="tag" style="margin-left:6px">${escapeHtml(tagLabel)}</span>` : ''}</div>
      <div class="lr-meta">${meta}</div>
    </div>
    <div class="lr-side">
      <div class="time-chip ${cd ? 'urgent' : ''}"><span class="chip-dot"></span>${escapeHtml(rel)}</div>
      ${cd ? `<div class="time-chip muted">${escapeHtml(cd)}</div>` : ''}
    </div>
  `;
}

// Map a tag_kind code to its short label.
function tagKindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', festival: '节日' }[k]) || '';
}

register('/reminders', render);