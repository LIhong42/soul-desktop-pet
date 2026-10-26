// src/js/pages/contact_detail.js — view a single contact + their dates + events
import { api, escapeHtml, firstChar, displayName, eventKindAttr, contactColorIndex, fmtDate, fmtDateTime, formatRelative, countdownTo, categoryIcon, toast, getCachedAvatarDataUrl, fetchAvatarDataUrl, wireDateInputs, repeatLabel, eventDisplayTitle } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml,
  wireBulkEnter, wireBulkToolbar,
} from '../bulk_delete.js';

// Render the avatar block for the detail-page header. Mirrors the rule used
// in contacts_list.js: prefer the user's uploaded photo (resolved to a data
// URL via the avatar cache), otherwise a Lucide glyph picked from
// `icon_kind` or auto-suggested from `relationship`.
function detailAvatarHTML(c) {
  const url = c.custom_avatar_path ? getCachedAvatarDataUrl(c.id) : '';
  if (url) return `<img src="${escapeHtml(url)}" alt=""/>`;
  const name = c.icon_kind && c.icon_kind !== 'user'
    ? c.icon_kind
    : suggestIconKind(c.relationship);
  return iconSVG(name, { title: displayName(c), size: 32 });
}

// --- List section with search + event filter + pagination -----------------
//
// Each of the likes / taboos / gifts sections behaves identically:
//   * Header with title + count badge, plus a "管理 →" link that opens the
//     per-section edit page (#/contacts/:id/:kind)
//   * Two independent filters:
//       - "section-search"    : keyword in `description` (case-insensitive)
//       - "section-event-filter": dropdown over distinct years/months observed
//         in the items' `event` values. Adds "不限" and "未填事件" entries.
//     They compose: search ∩ eventFilter, in either order; both empty = all.
//   * Search hits are surfaced in (event date desc, original order) so
//     recent events rise to the top.
//   * When the visible result set exceeds PAGE_SIZE, pagination controls
//     (上一页 / 第 X / Y 页 / 下一页) appear under the list.

const PAGE_SIZE = 5;

// Internal short kind ("like" / "taboo" / "gift") ↔ URL long kind
// ("likes" / "taboos" / "gifts"). The contact-detail UI talks in the short
// form; sub-page routes use the long form.
const kindMap = { like: 'likes', taboo: 'taboos', gift: 'gifts' };
const kindTitle = { like: '喜好', taboo: '忌讳', gift: '礼物参考' };

// Pure filter on description — case-insensitive substring match. Empty
// query means "do not filter by description".
function matchesQuery(item, q) {
  if (!q) return true;
  const desc = (item && item.description) || '';
  return desc.toLowerCase().includes(q);
}

// Pure filter on event date. `filterValue` is one of:
//   ''           — do not filter by event (show everything)
//   '__none__'   — show only items without an event
//   'YYYY'       — show items whose event starts with YYYY
//   'YYYY-MM'    — show items whose event starts with YYYY-MM
function matchesEvent(item, filterValue) {
  if (!filterValue) return true;
  const ev = (item && item.event) || '';
  if (filterValue === '__none__') return !ev;
  return ev.startsWith(filterValue);
}

// Build the dropdown options from the items currently visible. Includes
// "不限" + "未填事件" + every distinct (year, year-month) tuple observed,
// sorted descending so most-recent years/months appear first.
function buildEventFilterOptions(items) {
  const yearMonths = new Map(); // year → Set of "MM"
  for (const it of items || []) {
    const ev = it && it.event;
    if (!ev) continue;
    const m = /^(\d{4})(?:-(\d{2}))?/.exec(ev);
    if (!m) continue;
    const y = m[1];
    if (!yearMonths.has(y)) yearMonths.set(y, new Set());
    if (m[2]) yearMonths.get(y).add(m[2]);
  }
  const years = [...yearMonths.keys()].sort().reverse();
  const opts = [{ value: '', label: '不限' }, { value: '__none__', label: '未填事件' }];
  for (const y of years) {
    opts.push({ value: y, label: y + ' 年（全部月份）' });
    const months = [...yearMonths.get(y)].sort().reverse();
    for (const mo of months) opts.push({ value: `${y}-${mo}`, label: `${y}-${mo}` });
  }
  return opts;
}

function matchesEither(item, q, evFilter) {
  return matchesQuery(item, q) && matchesEvent(item, evFilter);
}

// Sort helper: items with an event come first by date desc, then items
// without an event retain their original order at the tail.
function sortByEventDesc(items) {
  const indexed = items.map((it, i) => ({ it, i }));
  indexed.sort((a, b) => {
    const ea = a.it.event || '';
    const eb = b.it.event || '';
    if (ea && !eb) return -1;
    if (!ea && eb) return 1;
    if (ea && eb) {
      if (ea < eb) return 1;
      if (ea > eb) return -1;
    }
    return a.i - b.i;
  });
  return indexed.map((x) => x.it);
}

function renderItemRow(it) {
  return `
    <div class="row between attribute-clickable" data-id="${escapeHtml(it.id)}" style="cursor:pointer;">
      <div style="flex:1; min-width:0;">
        <div class="lr-title-main">${escapeHtml(it.description || '')}</div>
        ${it.event ? `<div class="meta">${escapeHtml(fmtDate(it.event))}</div>` : ''}
      </div>
    </div>
  `;
}

// Inline editor row is no longer used: each row click navigates to the
// dedicated `/attributes/:id` detail page where edits happen. Kept the
// `editingId` field in state for backward-compat no-op behaviour.

function renderPager(state, totalPages) {
  if (totalPages <= 1) return '';
  const cur = state.page + 1; // 1-based for display
  const prevDisabled = state.page <= 0;
  const nextDisabled = state.page >= totalPages - 1;
  return `
    <div class="row between" style="margin-top:8px">
      <button type="button" class="btn secondary section-page" data-kind="${escapeHtml(state.kind)}" data-action="prev" ${prevDisabled ? 'disabled' : ''}>← 上一页</button>
      <div class="meta">第 ${cur} / ${totalPages} 页</div>
      <button type="button" class="btn secondary section-page" data-kind="${escapeHtml(state.kind)}" data-action="next" ${nextDisabled ? 'disabled' : ''}>下一页 →</button>
    </div>
  `;
}

function renderListSection(title, items, state, kind, c) {
  const all = items || [];
  const q = state.query.trim().toLowerCase();

  // Apply description search and event filter independently; both must match.
  const filtered = all.filter((it) => matchesEither(it, q, state.eventFilter));
  // When *something* filters, surface date-anchored items first.
  const ordered = (q || state.eventFilter) ? sortByEventDesc(filtered) : filtered;

  // Clamp page into the new bounds (handles e.g. deleting a row on the last page).
  const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;

  const start = state.page * PAGE_SIZE;
  const visible = ordered.slice(start, start + PAGE_SIZE);

  const filtersActive = !!(q || state.eventFilter);
  const selectActive = !!state.selectModeActive;
  // When a row is being inline-edited, render the edit form in place of its
  // normal row. All other rows render as before. In bulk-select mode we
  // additionally prefix each row with a checkbox.
  const rowsHtml = visible.map((it) => {
    const inner = renderItemRow(it);
    if (selectActive) {
      return `
        <div class="row" style="gap:10px; padding:6px 0;">
          <input type="checkbox" class="section-bulk-check" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(it.id)}" ${state.selected.has(it.id) ? 'checked' : ''}/>
          <div style="flex:1; min-width:0;">${inner}</div>
        </div>
      `;
    }
    return inner;
  }).join('');
  const listHtml = visible.length
    ? `<div class="card" data-kind="${escapeHtml(kind)}">${rowsHtml}</div>`
    : (filtersActive
        ? `<div class="empty">没有匹配的${title}</div>`
        : `<div class="empty">还没有${title}</div>`);

  const countBadge = all.length ? `<span class="meta">${all.length}</span>` : '';
  const searchInput = `
    <input type="text" class="section-search" data-kind="${escapeHtml(kind)}"
           placeholder="搜索描述…" value="${escapeHtml(state.query)}"/>
  `;
  const opts = buildEventFilterOptions(all);
  const eventFilterHtml = `
    <select class="section-event-filter" data-kind="${escapeHtml(kind)}">
      ${opts.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === state.eventFilter ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
    </select>
  `;
  // In idle mode the right side of the header carries a "管理 →" link
  // (per-section manage page) PLUS a "批量删除" link when there's at least
  // one row to pick from. In select mode the header just shows the count
  // badge — the toolbar below takes over the action area.
  const editLink = c && !selectActive
    ? `<a class="inline-link section-manage" href="#/contacts/${escapeHtml(c.id)}/${escapeHtml(kindMap[kind])}">管理 →</a>`
    : '';
  const enterBulkLink = (!selectActive && ordered.length > 0 && c)
    ? bulkEnterLinkHtml().replace('data-bulk-enter', `data-bulk-enter data-kind="${escapeHtml(kind)}"`)
    : '';

  const matchFooter = filtersActive
    ? `<div class="meta" style="padding:6px 0">匹配 ${ordered.length} 条${q ? ' · 关键词：' + escapeHtml(state.query) : ''}${state.eventFilter ? ' · 事件：' + escapeHtml(state.eventFilter === '__none__' ? '未填事件' : state.eventFilter) : ''}</div>`
    : '';

  const toolbarHtml = selectActive ? bulkToolbarHtml({
    count: state.selected.size,
    total: ordered.length,
    kindLabel: '条' + title,
  }) : '';

  return `
    <div class="section-header">
      <h2>${title} ${countBadge} ${enterBulkLink}</h2>
      ${editLink}
    </div>
    <div class="filter-row">
      ${searchInput}
      ${eventFilterHtml}
    </div>
    ${toolbarHtml}
    ${listHtml}
    ${matchFooter}
    ${renderPager(state, totalPages)}
  `;
}

async function render(args) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const c = await api.contacts.get(args.id);
  // Warm the avatar data URL cache so the header photo paints on the same
  // tick as the rest of the page (the first IPC populates the cache; the
  // second paint uses the cached value).
  if (c.custom_avatar_path) fetchAvatarDataUrl(c.id);
  const [dates, events, memorial, likes, taboos, gifts] = await Promise.all([
    api.importantDates.list(args.id),
    api.events.list({ contact_id: args.id }),
    api.memorialEvents.list({ contact_id: args.id }),
    api.attributes.list('like',  { contact_id: args.id }),
    api.attributes.list('taboo', { contact_id: args.id }),
    api.attributes.list('gift',  { contact_id: args.id }),
  ]);
  // Per-kind item list, sourced from the new contact_attributes table.
  // `id` is the contact's own id (used for refresh after a per-item mutation).
  const itemsByKind = {
    like:  likes,
    taboo: taboos,
    gift:  gifts,
  };

  // Per-section UI state. Owned by this render() invocation; the inputs
  // and pager buttons read/mutate this directly via closures.
  //
  // selectModeActive + selected drive the bulk-delete UI. `selected` is a
  // Set<id> so toggling a checkbox is O(1) and the count shown in the
  // toolbar is always in sync.
  const sectionState = {
    like:  { kind: 'like',  query: '', eventFilter: '', page: 0, editingId: null,
             selectModeActive: false, selected: new Set() },
    taboo: { kind: 'taboo', query: '', eventFilter: '', page: 0, editingId: null,
             selectModeActive: false, selected: new Set() },
    gift:  { kind: 'gift',  query: '', eventFilter: '', page: 0, editingId: null,
             selectModeActive: false, selected: new Set() },
  };

  // Refresh a single kind's items from the API and re-render only that
  // section. Avoids a full-page re-render after a row edit/delete.
  async function refreshKind(kind) {
    const attrKind = kind;
    itemsByKind[kind] = await api.attributes.list(attrKind, { contact_id: args.id });
    const host = document.querySelector(`.list-host[data-kind="${kind}"]`);
    if (!host) return;
    host.innerHTML = renderListSection(kindTitle[kind], itemsByKind[kind], sectionState[kind], kind, c);
    wireSection(kind);
  }

  function rerenderSections() {
    for (const kind of ['like', 'taboo', 'gift']) {
      const host = document.querySelector(`.list-host[data-kind="${kind}"]`);
      if (!host) continue;
      host.innerHTML = renderListSection(kindTitle[kind], itemsByKind[kind], sectionState[kind], kind, c);
      wireSection(kind);
    }
  }

  // Repaint only the rows + pager for one section, leaving the search
  // <input> mounted. Used by the search handler - the live input must
  // NEVER be replaced, or the Chinese IME composition context breaks
  // (typing "汉" drops the intermediate pinyin strokes, and even backspace
  // drops the caret until the user re-clicks the box).
  function rerenderListOnly(kind) {
    const all = itemsByKind[kind] || [];
    const state = sectionState[kind];
    const q = state.query.trim().toLowerCase();
    const filtered = all.filter((it) => matchesEither(it, q, state.eventFilter));
    const ordered = (q || state.eventFilter) ? sortByEventDesc(filtered) : filtered;
    const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
    if (state.page >= totalPages) state.page = totalPages - 1;
    if (state.page < 0) state.page = 0;
    const start = state.page * PAGE_SIZE;
    const visible = ordered.slice(start, start + PAGE_SIZE);
    const filtersActive = !!(q || state.eventFilter);
    const selectActive = !!state.selectModeActive;

    const rowsHtml = visible.map((it) => {
      const inner = renderItemRow(it);
      if (selectActive) {
        return `
          <div class="row" style="gap:10px; padding:6px 0;">
            <input type="checkbox" class="section-bulk-check" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(it.id)}" ${state.selected.has(it.id) ? 'checked' : ''}/>
            <div style="flex:1; min-width:0;">${inner}</div>
          </div>
        `;
      }
      return inner;
    }).join('');
    const listHtml = visible.length
      ? `<div class="card" data-kind="${escapeHtml(kind)}">${rowsHtml}</div>`
      : (filtersActive
          ? `<div class="empty">没有匹配的${kindTitle[kind]}</div>`
          : `<div class="empty">还没有${kindTitle[kind]}</div>`);
    const matchFooter = filtersActive
      ? `<div class="meta" style="padding:6px 0">匹配 ${ordered.length} 条${q ? ' · 关键词：' + escapeHtml(state.query) : ''}${state.eventFilter ? ' · 事件：' + escapeHtml(state.eventFilter === '__none__' ? '未填事件' : state.eventFilter) : ''}</div>`
      : '';
    const pagerHtml = renderPager(state, totalPages);

    const host = document.querySelector(`.list-host[data-kind="${kind}"]`);
    if (!host) return;
    // Preserve the live .filter-row <input>/<select>; replace everything
    // after it. The input stays mounted and keeps its caret + IME state.
    const filterRow = host.querySelector('.filter-row');
    const tail = [listHtml, matchFooter, pagerHtml].filter(Boolean).join('');
    if (filterRow) {
      while (filterRow.nextSibling) filterRow.nextSibling.remove();
      filterRow.insertAdjacentHTML('afterend', tail);
    } else {
      host.innerHTML = tail;
    }
    wirePager(kind);
    wireBulkAfterSearch(kind);
  }

  function wireSection(kind) {
    const input = document.querySelector(`.section-search[data-kind="${kind}"]`);
    if (input) {
      // The live <input> is NEVER replaced. We only repaint the rows /
      // pager below it, so the IME composition context survives every
      // keystroke (inputting "汉" no longer drops the intermediate pinyin
      // strokes, and backspace works without re-clicking).
      let settleTimer = null;
      const apply = () => {
        settleTimer = null;
        sectionState[kind].query = input.value;
        sectionState[kind].page = 0; // reset to first page on new filter
        rerenderListOnly(kind);
      };
      input.addEventListener('input', () => {
        // 120ms debounce collapses IME composition bursts into one
        // repaint. The input itself is not touched.
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(apply, 120);
      });
      input.addEventListener('compositionend', () => {
        if (settleTimer) clearTimeout(settleTimer);
        apply();
      });
    }
    const select = document.querySelector(`.section-event-filter[data-kind="${kind}"]`);
    if (select) {
      select.onchange = (e) => {
        sectionState[kind].eventFilter = e.target.value;
        sectionState[kind].page = 0;
        rerenderListOnly(kind);
      };
    }
    document.querySelectorAll(`.section-page[data-kind="${kind}"]`).forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        if (action === 'prev') sectionState[kind].page = Math.max(0, sectionState[kind].page - 1);
        if (action === 'next') sectionState[kind].page = sectionState[kind].page + 1;
        rerenderSections();
      };
    });
    wireRowClicks(kind);
    wireBulkEnter(kind);
    if (sectionState[kind].selectModeActive) wireBulkInSection(kind);
  }

  // Wire pager buttons for a single section (used after rerenderListOnly).
  function wirePager(kind) {
    document.querySelectorAll(`.section-page[data-kind="${kind}"]`).forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        if (action === 'prev') sectionState[kind].page = Math.max(0, sectionState[kind].page - 1);
        if (action === 'next') sectionState[kind].page = sectionState[kind].page + 1;
        rerenderListOnly(kind);
      };
    });
  }

  // Wire row-click navigation for a single section.
  function wireRowClicks(kind) {
    if (sectionState[kind].selectModeActive) return;
    document.querySelectorAll(`.list-host[data-kind="${kind}"] .attribute-clickable`).forEach((row) => {
      row.onclick = () => navigate('/attributes/' + row.dataset.id);
    });
  }

  // Wire the "进入批量删除" link in a section's header.
  function wireBulkEnter(kind) {
    const enterLink = document.querySelector(`.list-host[data-kind="${kind}"] [data-bulk-enter][data-kind="${kind}"]`);
    if (!enterLink) return;
    enterLink.onclick = (e) => {
      e.preventDefault();
      sectionState[kind].selectModeActive = true;
      sectionState[kind].selected = new Set();
      rerenderSections();
    };
  }

  // Wire the bulk-select controls (toolbar + per-row checkboxes) for a
  // section that's in select mode.
  function wireBulkInSection(kind) {
    const host = document.querySelector(`.list-host[data-kind="${kind}"]`);
    if (!host) return;
    const handlers = {
      kindLabel: '条' + kindTitle[kind],
      onDelete: async (ids) => {
        const result = await api.attributes.deleteMany(ids);
        sectionState[kind].selectModeActive = false;
        sectionState[kind].selected = new Set();
        toast(`已删除 ${result.deleted} 条${kindTitle[kind]}`);
        await refreshKind(kind);
        return result;
      },
      onExit: () => {
        sectionState[kind].selectModeActive = false;
        sectionState[kind].selected = new Set();
        rerenderSections();
      },
    };
    // Per-row checkbox flips — keep the Set in sync, then refresh the
    // toolbar count without rebuilding the whole list (which would
    // steal the user's focus).
    host.querySelectorAll('.section-bulk-check').forEach((cb) => {
      cb.onchange = () => {
        const id = cb.dataset.id;
        if (!id) return;
        if (cb.checked) sectionState[kind].selected.add(id);
        else sectionState[kind].selected.delete(id);
        const t = host.querySelector('[data-bulk-toolbar]');
        if (!t) return;
        host.querySelectorAll('.section-bulk-check').forEach((rowCb) => {
          const rid = rowCb.dataset.id;
          if (!rid) return;
          rowCb.checked = sectionState[kind].selected.has(rid);
        });
        const all = itemsByKind[kind] || [];
        const qq = sectionState[kind].query.trim().toLowerCase();
        const ef = sectionState[kind].eventFilter;
        const total = all.filter((it) => matchesEither(it, qq, ef)).length;
        t.outerHTML = bulkToolbarHtml({
          count: sectionState[kind].selected.size,
          total,
          kindLabel: '条' + kindTitle[kind],
        });
        wireBulkToolbar(host, sectionState[kind], handlers);
      };
    });
    wireBulkToolbar(host, sectionState[kind], handlers);
  }

  // After rerenderListOnly: re-wire pager + bulk UI. Search input is NOT
  // re-wired — it stays mounted and keeps its caret + IME state.
  function wireBulkAfterSearch(kind) {
    wirePager(kind);
    if (sectionState[kind].selectModeActive) wireBulkInSection(kind);
  }

  app.innerHTML = `
    <div class="contact-header">
      <div class="contact-avatar contact-avatar-lg"
           style="color: var(--contact-${contactColorIndex(c.name)})">
        ${detailAvatarHTML(c)}
      </div>
      <div class="contact-header-text">
        <h1>${escapeHtml(displayName(c))}${c.relationship
          ? `<span class="relationship-sep">·</span><span class="relationship">${escapeHtml(c.relationship)}</span>`
          : ''}</h1>
        <div class="contact-header-actions">
          <a class="inline-link" href="#/contacts/${escapeHtml(c.id)}/edit">编辑基本信息</a>
          <a class="inline-link" href="#/contacts">← 返回</a>
        </div>
      </div>
    </div>
    <div class="card" data-contact-color="${contactColorIndex(c.name)}">
      <div class="row" style="gap:24px">
        <div><div class="meta">条目统计</div>${likes.length} 喜好 / ${taboos.length} 忌讳 / ${gifts.length} 礼物</div>
      </div>
    </div>

    <div class="list-host" data-kind="like"></div>
    <div class="list-host" data-kind="taboo"></div>
    <div class="list-host" data-kind="gift"></div>

    <div class="section-header">
      <h2>重要日期</h2>
      <button class="btn secondary" id="add-date">+ 新增</button>
    </div>
    ${dates.length === 0
      ? `<div class="empty">还没有重要日期</div>`
      : dates.map((d) => {
        const kindTone = d.kind === 'birthday' ? 'birthday'
                       : d.kind === 'anniversary' ? 'anniversary'
                       : 'important';
        const icon = d.kind === 'birthday' ? '🎂'
                   : d.kind === 'anniversary' ? '💝'
                   : '📅';
        return `
        <div class="card list-row clickable" data-kind="important" data-important="${escapeHtml(d.id)}">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${kindTone}">${icon}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(d.label)} <span class="tag" style="margin-left:6px">${escapeHtml(kindLabel(d.kind))}</span></div>
            <div class="lr-meta">每年 ${d.month}/${d.day}${d.year ? ' · ' + d.year + '年生' : ''} · 提醒 ${escapeHtml(d.remind_time || '09:00')}${d.remind_enabled === 0 ? ' · 已关闭' : ''}${d.remind_enabled !== 0 && d.advance_days > 0 ? ` · 提前 ${d.advance_days} 天` : ''}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip"><span class="chip-dot"></span>每年 ${d.month}-${d.day}</div>
          </div>
        </div>
      `}).join('')}

    <div class="section-header">
      <h2>回忆事件</h2>
      <button class="btn secondary" id="add-memorial">+ 新增</button>
    </div>
    ${memorial.length === 0
      ? `<div class="empty">还没有回忆事件</div>`
      : memorial.map((e) => `
        <div class="card list-row clickable" data-kind="memorial" data-memorial="${escapeHtml(e.id)}">
          <div class="lr-id">
            <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title || '(无标题)')} <span class="tag" style="margin-left:6px">${escapeHtml(e.kind === 'first_time' ? '第一次' : '其他')}</span></div>
            <div class="lr-meta">${e.photo_count > 0 ? `${e.photo_count} 张照片` : '回忆事件'}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip"><span class="chip-dot"></span>${escapeHtml(formatRelative(e.occurred_at))}</div>
          </div>
        </div>
      `).join('')}

    <div class="section-header">
      <h2>事件</h2>
      <button class="btn secondary" id="add-event">+ 新增</button>
    </div>
    ${events.length === 0
      ? `<div class="empty">还没有事件</div>`
      : events.map((e) => {
        const kind = eventKindAttr(e);
        const rel = formatRelative(e.next_fire_at || e.remind_date);
        const cd  = countdownTo(e.next_fire_at || e.remind_date);
        return `
        <div class="card list-row clickable" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category || 'general')}">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${escapeHtml(kind)}">${escapeHtml(categoryIcon(e.category, e.tag_kind))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(eventDisplayTitle(e) || '(无标题)')}</div>
            <div class="lr-meta">${escapeHtml(repeatLabel(e))}${e.active ? '' : ' · 已结束'}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip ${cd ? 'urgent' : ''}"><span class="chip-dot"></span>${escapeHtml(rel)}</div>
            ${cd ? `<div class="time-chip muted">${escapeHtml(cd)}</div>` : ''}
          </div>
        </div>
      `}).join('')}
  `;

  rerenderSections();

  document.getElementById('add-date').onclick = () => showDateDialog(args.id);
  document.getElementById('add-event').onclick = () => navigate('/events/new?category=general&contact_id=' + args.id);
  const addMemorial = document.getElementById('add-memorial');
  if (addMemorial) addMemorial.onclick = () => navigate('/events/new?category=memorial&contact_id=' + args.id);
  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => {
      if (el.dataset.important) {
        navigate('/important-dates/' + el.dataset.important);
      } else if (el.dataset.memorial) {
        navigate('/events/' + el.dataset.memorial + '?category=memorial');
      } else if (el.dataset.id) {
        navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
      }
    };
  });
}

// Label for an important-date row's `kind` column. (The event repeat
// modes use the shared repeatLabel() from api.js instead.)
function kindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', deceased_date: '忌日', custom: '自定义' }[k]) || k || '';
}

function showDateDialog(contactId) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>新增重要日期</h3>
        <button class="icon-btn" id="x">✕</button>
      </div>
      <div class="modal-body">
        <div class="field"><label>名称（例：生日）</label><input type="text" id="d-label"/></div>
        <div class="form-row">
          <div class="field"><label>月</label><input type="number" id="d-month" min="1" max="12" value="1"/></div>
          <div class="field"><label>日</label><input type="number" id="d-day" min="1" max="31" value="1"/></div>
        </div>
        <div class="form-row">
          <div class="field"><label>年（可选）</label><input type="number" id="d-year" placeholder="1990"/></div>
          <div class="field"><label>类型</label>
            <select id="d-kind">
              <option value="birthday">生日</option>
              <option value="anniversary">纪念日</option>
              <option value="deceased_date">忌日</option>
              <option value="custom">自定义</option>
            </select>
          </div>
        </div>
        <div class="field"><label>提醒时间</label><input type="time" id="d-time" value="09:00"/></div>
        <div class="form-row">
          <div class="field">
            <label>提前提醒（天）</label>
            <input type="number" id="d-advance" min="0" max="60" value="7"/>
            <div class="meta">提前这么多天开始每天提醒一次，0 = 只在当天提醒</div>
          </div>
          <div class="field">
            <label>提醒开关</label>
            <label><input type="checkbox" id="d-remind-enabled" checked/> 启用提醒</label>
            <div class="meta">关闭后保留这条日期记录，但不再提醒</div>
          </div>
        </div>
        <div class="row" style="margin-top:14px; gap:8px;">
          <button class="btn" id="save">保存</button>
          <button class="btn secondary" id="cancel">取消</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Click anywhere on the time input to open the time picker.
  wireDateInputs(modal);
  modal.querySelector('#x').onclick = () => modal.remove();
  modal.querySelector('#cancel').onclick = () => modal.remove();
  modal.querySelector('#save').onclick = async () => {
    const advanceDays = Math.floor(Number(modal.querySelector('#d-advance').value));
    const input = {
      label: modal.querySelector('#d-label').value.trim() || '生日',
      month: parseInt(modal.querySelector('#d-month').value, 10),
      day: parseInt(modal.querySelector('#d-day').value, 10),
      year: modal.querySelector('#d-year').value ? parseInt(modal.querySelector('#d-year').value, 10) : null,
      kind: modal.querySelector('#d-kind').value,
      remind_time: modal.querySelector('#d-time').value || '09:00',
      advance_days: Number.isFinite(advanceDays) && advanceDays >= 0 ? Math.min(advanceDays, 60) : 7,
      remind_enabled: modal.querySelector('#d-remind-enabled').checked,
    };
    if (input.month < 1 || input.month > 12 || input.day < 1 || input.day > 31) {
      toast('日期不合法');
      return;
    }
    await api.importantDates.create(contactId, input);
    modal.remove();
    toast('已添加');
    render({ id: contactId });
  };
}

register('/contacts/:id', render);