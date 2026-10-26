// src/js/pages/events_work.js — 工作事件 list (category='work')
import { api, escapeHtml, firstChar, displayName, fmtDateTime, formatRelative, countdownTo, categoryIcon, contactColorIndex, toast, repeatLabel } from '../api.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml, bulkSelectableRowHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';

// selectMode is per-page state so toggling bulk-delete mode doesn't lose
// the user's checkbox selections on re-render. `q` mirrors the current
// search so the list subtree can be re-filtered without an IPC round-trip;
// `allEvents` / `cById` cache the loaded data for the same reason.
const pageState = {
  selectMode: { active: false, selected: new Set() },
  q: '',
  allEvents: [],
  cById: {},
  basePath: '/events/work',
};

async function render(args, params) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  // First time (or after a category change), reload data. Subsequent
  // re-renders triggered by search / bulk-select reuse the cache — this
  // matches the gift page's behaviour of keeping loaded data in memory
  // across keystroke-driven re-filters.
  const opts = { category: 'work' };
  if (params.contact_id) opts.contact_id = params.contact_id;
  const [events, contacts] = await Promise.all([
    api.events.list(opts),
    api.contacts.list(),
  ]);
  pageState.allEvents = events;
  pageState.cById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  pageState.q = ((params && params.q) || '').trim().toLowerCase();
  // Preserve any other query params (e.g. contact_id) when syncing search
  // back to the URL.
  pageState.basePath = '/events/work' + (params.contact_id ? '?contact_id=' + encodeURIComponent(params.contact_id) : '');

  // Initial paint. Structure: a static shell that wraps a replaceable
  // list subtree. The <input> and the `?q=...` URL live entirely outside
  // the rewritten subtree so typing Chinese IME compositions never tears
  // down the live input (the bug the previous full-rerender design had).
  const initialQ = pageState.q;
  app.innerHTML = `
    <div id="page-header" class="row between">
      <h1>工作事件 ${!pageState.selectMode.active && pageState.allEvents.length > 0 ? bulkEnterLinkHtml() : ''}</h1>
      <button class="btn" id="new-event">+ 新建</button>
    </div>
    <div class="page-search">
      <input type="search" id="work-q" class="page-search-input"
             placeholder="在工作事件中搜索…" autocomplete="off" />
      <button class="btn secondary page-search-clear" id="work-clear" type="button"
              style="${initialQ ? '' : 'display:none;'}">清除</button>
      <span class="meta page-search-meta" style="${initialQ ? '' : 'display:none;'}"></span>
    </div>
    <div id="work-list"></div>
  `;

  // Set initial query value on the freshly-mounted input, but only this
  // one time — every subsequent keystroke reads from the same node, so
  // re-assigning the value would steal the caret out from under the user.
  const input = document.getElementById('work-q');
  if (input) input.value = initialQ;

  wireSearchInput();
  rerenderList();

  // 静态头部按钮一次性绑定即可；行级 click handler 由 rerenderList() 在
  // 每次列表重绘时重新绑定，避免初次 mount 后又被覆盖。
  document.getElementById('new-event').onclick = () => navigate('/events/new?category=work');

  wireBulk();
  applyPhotos();
}

// Re-render ONLY the list subtree (#work-list) and the search-row chrome
// (清除 button + match counter). Never touches #work-q, so the IME
// composition context (候选词, 拼音中间态, 光标位置) survives every
// keystroke — same pattern as attributes.js / contact_detail.js.
function rerenderList() {
  const events = pageState.allEvents;
  const cById = pageState.cById;
  const q = pageState.q;
  const filtered = q ? events.filter((e) => matchesWorkQuery(e, cById, q)) : events;
  const suppressed = events.length - filtered.length;

  // 清除按钮 + 匹配数徽章：与原实现行为一致，仅在 q 非空时出现。
  const clearBtn = document.getElementById('work-clear');
  if (clearBtn) clearBtn.style.display = q ? '' : 'none';
  const metaEl = document.querySelector('.page-search-meta');
  if (metaEl) {
    metaEl.style.display = q ? '' : 'none';
    metaEl.textContent = q ? `${filtered.length} / ${events.length} 条匹配` : '';
  }

  const host = document.getElementById('work-list');
  if (!host) return;
  host.innerHTML = `
    ${pageState.selectMode.active ? bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: filtered.length,
        kindLabel: '个工作事件',
      }) : ''}
    ${events.length === 0
      ? `<div class="empty">还没有工作事件 · 点 + 新建 创建一个</div>`
      : filtered.length === 0
        ? `<div class="empty">没有匹配「${escapeHtml(q)}」的工作事件 · 已隐藏 ${suppressed} 条</div>`
        : filtered.map((e) => pageState.selectMode.active
            ? bulkSelectableRowHtml(rowInner(e, cById), e.id, pageState.selectMode.selected.has(e.id), 'work')
            : renderRow(e, cById)).join('')}
  `;

  if (!pageState.selectMode.active) {
    host.querySelectorAll('.card.clickable').forEach((el) => {
      el.onclick = () => navigate('/events/' + el.dataset.id + '?category=work');
    });
  }

  if (pageState.selectMode.active) {
    wireBulkRowChecks(host, pageState.selectMode);
  }
}

// Wire the search input exactly once per page mount. `data-wired` guards
// against double-binding if the page module is re-evaluated. The IME-safe
// pattern (120ms idle settle + immediate flush at compositionend) is
// inherited from the gift page — the difference is that flush() now calls
// rerenderList() instead of navigate(), avoiding the full-page render that
// used to drop Chinese composition context.
function wireSearchInput() {
  const input = document.getElementById('work-q');
  const clearBtn = document.getElementById('work-clear');
  if (!input) return;
  if (!input.dataset.wired) {
    input.dataset.wired = '1';
    let settleTimer = null;
    const apply = () => {
      settleTimer = null;
      const raw = input.value;
      const next = raw.trim().toLowerCase();
      pageState.q = next;
      const targetHash = next
        ? pageState.basePath + (pageState.basePath.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(next)
        : pageState.basePath;
      // 使用 replaceState 而不是 navigate()：避免每次输入都新增历史栈条目，
      // 且不触发路由监听器重渲整个 app，IME 上下文永远不会被打断。
      if (location.hash !== '#' + targetHash) {
        try { history.replaceState(null, '', '#' + targetHash); } catch (_) {}
      }
      rerenderList();
    };
    input.addEventListener('input', () => {
      // 120ms 防抖合并 IME 组合期内的多次 input 事件；输入框节点本
      // 身不会被重建，所以拼音中间态和候选词窗口都不会被打断。
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(apply, 120);
    });
    input.addEventListener('compositionend', () => {
      // 候选词上屏/取消的瞬间立即刷新，跳过防抖等待。
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

// Placeholder kept for call-site symmetry with events_memorial.js.
// Work events have no photos, so there's nothing to async-swap.
function applyPhotos() { /* no-op */ }

// Bulk-select wiring. The toolbar / "Enter bulk-delete" link live inside
// rewritten subtrees, so re-bind them every time the list redraws and
// once on initial mount for the header row's link.
function wireBulk() {
  const handlers = {
    onDelete: async (ids) => {
      const result = await api.events.deleteMany(ids);
      // 仅在删除后重新拉取数据；URL 与 pageState.q 保持不变。
      const params = { q: pageState.q, contact_id: undefined };
      await reloadAndRender(params);
      return result;
    },
    onExit: () => {
      pageState.selectMode.active = false;
      pageState.selectMode.selected = new Set();
      rerenderList();
      // 重新挂上页面头部的「批量删除」入口链接（和当前选中行数无关 — 只看
      // 是否有可批量操作的事件）。只有当列表非空时才显示入口，避免空状态
      // 下出现无用按钮。
      const header = document.getElementById('page-header');
      if (header) {
        const enterLink = pageState.allEvents.length > 0 ? bulkEnterLinkHtml() : '';
        const newHeader = document.createElement('div');
        newHeader.id = 'page-header';
        newHeader.className = 'row between';
        newHeader.innerHTML = `
          <h1>工作事件 ${enterLink}</h1>
          <button class="btn" id="new-event">+ 新建</button>
        `;
        header.replaceWith(newHeader);
        document.getElementById('new-event').onclick = () => navigate('/events/new?category=work');
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
        pageState.q ? matchesWorkQuery(e, pageState.cById, pageState.q) : true
      ).length;
      t.outerHTML = bulkToolbarHtml({
        count,
        total,
        kindLabel: '个工作事件',
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

// 删除后重新拉取数据并重渲整个 app。保留输入框的当前值。
async function reloadAndRender(params = {}) {
  const app = document.getElementById('app');
  const opts = { category: 'work' };
  if (params.contact_id) opts.contact_id = params.contact_id;
  const [events, contacts] = await Promise.all([
    api.events.list(opts),
    api.contacts.list(),
  ]);
  pageState.allEvents = events;
  pageState.cById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  pageState.q = ((params && params.q) || '').trim().toLowerCase();
  pageState.basePath = '/events/work' + (params.contact_id ? '?contact_id=' + encodeURIComponent(params.contact_id) : '');
  render([], { contact_id: params.contact_id, q: pageState.q });
}

function renderRow(e, cById) {
  return `
    <div class="card list-row clickable" data-kind="work" data-id="${escapeHtml(e.id)}">
      ${workRowInner(e, cById)}
    </div>
  `;
}

function rowInner(e, cById) {
  return workRowInner(e, cById);
}

// Shared body for both idle renderRow (wrapped in a .card) and bulk-select
// rowInner (wrapped in .bulk-row). The bulk-row caller prepends a checkbox;
// the body itself is the same three-column grid for both modes.
function workRowInner(e, cById) {
  const contact = e.contact_id && cById && cById[e.contact_id] ? cById[e.contact_id] : null;
  const contactName = contact ? displayName(contact) : '';
  const contactTone = contact ? contactColorIndex(contact.name) : 0;
  const metaParts = [kindLabel(e.remind_kind)];
  if (e.lunar_month && e.lunar_day) metaParts.push(`农历 ${e.lunar_month}-${e.lunar_day}`);
  if (contact) metaParts.push(escapeHtml(contactName));
  if (!e.active) metaParts.push('已结束');
  const meta = metaParts.join(' · ');
  const target = e.next_fire_at || e.remind_date;
  const rel = formatRelative(target);
  const cd  = countdownTo(target);
  // 工作事件没有关联联系人，标题总是被服务端默认为「新建提醒」。
  // 直接展示 description（即用户填写的具体工作内容）作为主行，标题
  // 退化为没有 description 时的兜底。
  const desc = (e.description || '').trim();
  const mainLine = desc || e.title || '(无描述)';
  return `
    <div class="lr-id">
      <span class="cat-icon" data-tone="work">${escapeHtml(categoryIcon('work', e.tag_kind))}</span>
      ${contact ? `<span class="stack-av" style="background: var(--contact-${contactTone})" title="${escapeHtml(contactName)}">${escapeHtml(firstChar(contact.name))}</span>` : ''}
    </div>
    <div class="lr-main">
      <div class="lr-title">${escapeHtml(mainLine)}</div>
      <div class="lr-meta">${meta}</div>
    </div>
    <div class="lr-side">
      <div class="time-chip ${cd ? 'urgent' : ''}"><span class="chip-dot"></span>${escapeHtml(rel)}</div>
      ${cd ? `<div class="time-chip muted">${escapeHtml(cd)}</div>` : ''}
    </div>
  `;
}

function kindLabel(k) {
  return repeatLabel(k);
}

// Local search predicate for work events. Work events have far fewer
// user-visible fields than memorial events — the row's primary text is
// `description`, with `title` as a fallback and `contact.name` for the
// linked contact. We substring-match across all three so a query like
// "周报" hits the description; "张三" hits the linked contact.
function matchesWorkQuery(e, cById, q) {
  if (!q) return true;
  const fields = [e.title, e.description];
  for (const f of fields) {
    if (typeof f === 'string' && f.toLowerCase().includes(q)) return true;
  }
  if (e.contact_id && cById && cById[e.contact_id]) {
    const name = cById[e.contact_id].name || '';
    if (typeof name === 'string' && name.toLowerCase().includes(q)) return true;
  }
  return false;
}

register('/events/work', render);
