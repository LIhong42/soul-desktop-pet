// src/js/pages/events.js — 提醒 list.
//
// This page now includes two independent filter dropdowns:
//   - 类型 (tag_kind): 全部 / 生日 / 纪念日 / 节日 / 工作事件 / 未分类
//   - 关联联系人 (contact_id): 全部 / a contact / (独立事件)
//
// Both filter values are reflected in the URL hash so the page can be
// bookmarked / shared. Changing either triggers a re-fetch via events:list.
//
// ---- 工作事件 as a 类型 ----
//
// 工作事件 are not a separate page any more: they are one of the 类型 the
// 提醒 page filters by. They live in the same `events` table as the other
// reminders, tagged by `category='work'` rather than by `tag_kind` — the
// two are different axes (类别 vs 类型), and a work event is a work event
// no matter what tag kind it carries.
//
// So the 类型 dropdown's 工作事件 option selects a CATEGORY, while the
// other options select a tag kind. The two are mutually exclusive: picking
// 工作事件 switches the query to `category='work'` and clears the tag
// kind, picking any other option goes back to `category='general'`.
//
// The work events themselves are still created through the work form
// (category='work'), which the 新建 button reaches once 工作事件 is the
// selected 类型.
//
// The page keeps its own name — the heading always reads 提醒, whichever
// 类型 is selected. 工作事件 is a filter, not a page; the dropdown says
// which slice of the reminders the list is showing.
import { api, escapeHtml, displayName, eventKindAttr, formatRelative, countdownTo, categoryIcon, repeatLabel, eventDisplayTitle } from '../api.js';
import { register, navigate } from '../router.js';
import { applyBackground } from '../page_background.js';
import { pageSlice, pagerHtml, wirePager } from '../pager.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml, bulkSelectableRowHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';

// The 类型 dropdown's options.
//
// `value` is the URL's `tag_kind` parameter. The 工作事件 option is
// special: it selects the work CATEGORY rather than a tag kind, so its
// value is the sentinel 'work'. See the note at the top of this file.
const TAG_KIND_FILTER_OPTIONS = [
  { value: '',            label: '全部' },
  { value: 'birthday',    label: '生日' },
  { value: 'anniversary', label: '纪念日' },
  { value: 'festival',    label: '节日' },
  { value: 'work',        label: '工作事件' },
  { value: 'none',        label: '未分类' },
];

// The sentinel that stands for "the work category" in the 类型 dropdown.
const WORK_KIND = 'work';

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

  // The 工作事件 option selects the work CATEGORY instead of a tag kind.
  // The two are mutually exclusive, so the work option wins and the tag
  // kind filter is left out of the query entirely.
  const isWork = tagKindFilter === WORK_KIND;

  const opts = { category: isWork ? 'work' : 'general' };
  if (tagKindFilter && !isWork) opts.tag_kind = tagKindFilter;
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
      <div class="row between" id="page-header">
        <h1>提醒 ${pageState.selectMode.active ? '' : (filteredEvents.length > 0 ? bulkEnterLinkHtml() : '')}</h1>
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

  // The 新建 button opens the form for the list's category: the work
  // form when 工作事件 is the selected 类型, the reminder form otherwise.
  document.getElementById('new-event').onclick = () =>
    navigate('/events/new?category=' + (isWork ? 'work' : 'general'));

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

    // The noun for the current list — the toolbar counter and the empty
    // state both name what the list holds, and the work view holds work
    // events, not reminders.
    const noun = isWork ? '工作事件' : '提醒';

    host.innerHTML = `
      ${pageState.selectMode.active ? bulkToolbarHtml({
          count: pageState.selectMode.selected.size,
          total: total,
          kindLabel: '个' + noun,
        }) : ''}
      ${total === 0
        ? `<div class="empty">没有匹配的${noun}</div>`
        : visible.map((e) => pageState.selectMode.active
            ? bulkSelectableRowHtml(rowInner(e, cById, festByCode), e.id, pageState.selectMode.selected.has(e.id), eventKindAttr(e))
            : renderRow(e, cById, festByCode)).join('')}
      ${pagerHtml(pageState.page, totalPages, total)}
    `;

    if (!pageState.selectMode.active) {
      host.querySelectorAll('.card.clickable').forEach((el) => {
        el.onclick = () => navigate('/events/' + el.dataset.id + '?category=' + (isWork ? 'work' : 'general'));
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
      // Re-fetch the list so the deleted rows actually disappear.
      //
      // A navigate() to the same URL would NOT do it: the filters are
      // already in the hash, so setting the same hash fires no
      // hashchange and the router would never re-render — the deleted
      // rows would stay on screen. So the fetch is done here and the
      // list is repainted from the fresh rows.
      const opts2 = { category: isWork ? 'work' : 'general' };
      if (tagKindFilter && !isWork) opts2.tag_kind = tagKindFilter;
      if (contactFilter && contactFilter !== '__standalone__') opts2.contact_id = contactFilter;
      const fresh = await api.events.list(opts2);
      // The contact filter's 「独立事件」 bucket is applied locally, the
      // same way the initial load does it.
      const freshFiltered = fresh.filter((e) => {
        if (!contactFilter) return true;
        if (contactFilter === '__standalone__') return !e.contact_id;
        return e.contact_id === contactFilter;
      });
      filteredEvents.length = 0;
      filteredEvents.push(...freshFiltered);
      return result;
    },
    onExit: () => {
      pageState.selectMode.active = false;
      pageState.selectMode.selected = new Set();
      // Repaint the list subtree instead of re-navigating. The filters are
      // already in the URL, so navigate() would set the SAME hash — and
      // setting the same hash fires no hashchange, so the router would
      // never re-render and the page would stay in select mode.
      //
      // The header (the title and its 「批量删除」 link) is rebuilt
      // separately, because it lives OUTSIDE the list subtree that
      // paintList() rewrites.
      paintList();
      restoreHeader();
    },
  };

  // Rebuild the page header (the title and its 「批量删除」 entry link) and
  // re-bind the link, so entering and leaving select mode both leave the
  // header in the right state.
  //
  // The header lives outside the list subtree, so paintList() cannot
  // touch it — it has to be rebuilt by hand.
  function restoreHeader() {
    const header = document.getElementById('page-header');
    if (!header) return;
    // The 「批量删除」 link is only offered in idle mode — in select mode
    // the toolbar carries the way out.
    const enterLink = (!pageState.selectMode.active && filteredEvents.length > 0)
      ? bulkEnterLinkHtml() : '';
    header.innerHTML = `
      <h1>提醒 ${enterLink}</h1>
      <button class="btn" id="new-event">+ 新建</button>
    `;
    document.getElementById('new-event').onclick = () =>
      navigate('/events/new?category=' + (isWork ? 'work' : 'general'));
    wireBulkEnter(header, () => {
      pageState.selectMode.active = true;
      pageState.selectMode.selected = new Set();
      paintList();
      restoreHeader();
    });
  }
  // The counter refresh, wired unconditionally.
  //
  // It used to be assigned only when the page rendered in select mode,
  // because entering select mode used to re-render the whole page. Now
  // that entering only repaints the list, the page can reach select mode
  // without ever passing through this branch — so the handler has to be
  // there from the start, or the first checkbox flip would find
  // `selectMode.onChange` undefined.
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
      kindLabel: '个' + (isWork ? '工作事件' : '提醒'),
    });
    wireBulkToolbar(document.getElementById('reminders-list'), pageState.selectMode, bulkHandlers);
  };
  wireBulkEnter(app, () => {
    pageState.selectMode.active = true;
    pageState.selectMode.selected = new Set();
    // Repaint the list and the header in place rather than re-navigating:
    // the filters are already in the URL, so a navigate() to the SAME
    // hash would fire no hashchange and the router would never re-render.
    paintList();
    restoreHeader();
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
  // A work event may still carry a linked contact, and it is the one
  // piece of context the row cannot show in its main line — the work
  // page this list absorbed showed it in the meta row too.
  if (e.category === 'work' && e.contact_id && cById && cById[e.contact_id]) {
    metaParts.push(displayName(cById[e.contact_id]));
  }
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
  //
  // Work events are the exception: their title is always the server's
  // generic "新建提醒" placeholder, so the description IS the event's
  // text. Showing "新建提醒 — 周报" would put a placeholder in front of
  // the real content — the work page this list absorbed showed the
  // description alone, so it still does.
  const isWork = e.category === 'work';
  const desc = (e.description || '').trim();
  const titleText = isWork
    ? (desc || displayTitle || '(无描述)')
    : (eventDisplayTitle(e, displayTitle) || '(无标题)');
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