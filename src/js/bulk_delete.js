// src/js/bulk_delete.js — Shared helpers for batch-select + bulk delete.
//
// The "filter page → bulk delete" UX has two phases:
//
//   1. Idle phase: the page renders normally. A "批量删除" link is shown
//      next to the section header when (a) a filter is active OR (b) the
//      section has rows at all. The link is hidden entirely when the
//      section is empty (no point entering select mode with nothing to
//      pick from).
//
//   2. Select phase: the page re-renders with a checkbox on each row, a
//      sticky toolbar across the top with "全选 / 取消 / 删除选中 (N)" and
//      an "退出选择" link. Per-row edit/delete buttons stay (so the user
//      can still single-row delete) but row click handlers that would
//      navigate away (e.g. event cards) are suspended to avoid losing
//      the selection.
//
// Why this lives in its own module:
//   - Three pages (events/reminders, events/memorial, the pet window's
//     快速记录 list) plus contact_detail's three kind tabs
//     (喜好 / 忌讳 / 礼物) all want the same UX. Duplicating it five
//     times would make every tweak a multi-file chore.
//   - contact_detail's kind tabs are rendered imperatively
//     (host.innerHTML = ...), so the helper takes an `attach(host,
//     state)` callback and returns the controls the page must wire
//     itself. That's enough to keep contact_detail's existing pager /
//     search wiring intact.
//
// Bulk delete semantics:
//   - Bulk delete targets the CURRENT FILTERED SET — not "everything in
//     the table". If the user has narrowed to "Birthday events for Alice",
//     only those events get deleted, never Alice's other events.
//   - "Select all" selects every row visible in the current filtered set
//     (across pagination). Once selected, deleting removes those rows
//     even if the user changes the filter mid-delete — the id list is
//     captured at confirm time, not at confirm+delete time. This avoids
//     accidentally deleting rows the user can no longer see.
//   - The confirm dialog always echoes the count. Deleting dozens of
//     rows by accident is much harder when the count is right there in
//     front of the user.

import { toast } from './api.js';

// Build the toolbar that sits at the top of a section while in select mode.
// Returned HTML is meant to be embedded in the page; nothing is wired yet —
// `wireBulkToolbar` does that.
//
// `count` is the number of currently-checked rows. `total` is the size of
// the visible filtered set. `kindLabel` is what we say in the delete
// confirm ("个喜好条目" / "条事件" / etc.).
export function bulkToolbarHtml({ count, total, kindLabel }) {
  return `
    <div class="card bulk-toolbar" data-bulk-toolbar>
      <div class="row between" style="flex-wrap:wrap; gap:8px;">
        <div class="row" style="gap:8px;">
          <label class="row" style="gap:6px; cursor:pointer;">
            <input type="checkbox" data-bulk-toggle ${count === total && total > 0 ? 'checked' : ''}/>
            <span>全选（${count} / ${total}）</span>
          </label>
        </div>
        <div class="row" style="gap:8px;">
          <button type="button" class="btn danger" data-bulk-delete ${count === 0 ? 'disabled' : ''}>删除选中 (${count})</button>
          <button type="button" class="btn secondary" data-bulk-exit>退出选择</button>
        </div>
      </div>
    </div>
  `;
}

// The "进入批量删除" link rendered in idle mode next to the section header.
// Hidden when `total === 0` (caller decides). Single-line text keeps it
// visually quieter than the "+ 新建" button next to it.
export function bulkEnterLinkHtml() {
  return `<a class="inline-link" href="#" data-bulk-enter>批量删除</a>`;
}

// Render a row in select mode. Wraps the existing row HTML with a checkbox
// column on the left. `defaultChecked` lets the caller remember selections
// across re-renders (so paging doesn't wipe the user's choices).
//
// The original row HTML is passed via `rowHtml` so each page can keep its
// own row template — bulk mode is purely an additive wrapper.
//
// `kind` is optional: when provided, the outer .card carries the same
// data-kind so the category color-strip stays visible during select mode
// (the inner row keeps its own data-kind for pages that pre-tag it).
export function bulkSelectableRowHtml(rowHtml, id, defaultChecked, kind) {
  const kindAttr = kind ? ` data-kind="${escapeAttr(kind)}"` : '';
  return `
    <div class="card bulk-row"${kindAttr} data-bulk-id="${escapeAttr(id)}">
      <div class="row" style="gap:10px;">
        <input type="checkbox" class="bulk-row-check" data-bulk-id="${escapeAttr(id)}" ${defaultChecked ? 'checked' : ''}/>
        <div style="flex:1; min-width:0;">${rowHtml}</div>
      </div>
    </div>
  `;
}

// Wire the toolbar inside a host element. Pass `selectMode` (object with
// `selected: Set<id>`, `onChange: () => void`) and `handlers`
// (`onDelete(ids)`, `onExit()`). Re-renders aren't done here — the page
// handles that in `onChange` / `onDelete`.
export function wireBulkToolbar(host, selectMode, handlers) {
  const toolbar = host.querySelector('[data-bulk-toolbar]');
  if (!toolbar) return;
  const toggle = toolbar.querySelector('[data-bulk-toggle]');
  const del = toolbar.querySelector('[data-bulk-delete]');
  const exit = toolbar.querySelector('[data-bulk-exit]');
  if (toggle) {
    toggle.onchange = () => {
      const visibleIds = collectVisibleIds(host);
      if (toggle.checked) {
        for (const id of visibleIds) selectMode.selected.add(id);
      } else {
        for (const id of visibleIds) selectMode.selected.delete(id);
      }
      selectMode.onChange();
    };
  }
  if (del) {
    del.onclick = async () => {
      const ids = [...selectMode.selected];
      if (ids.length === 0) return;
      const kindLabel = handlers.kindLabel || '条目';
      if (!confirm(`确认删除选中的 ${ids.length} 个${kindLabel}？此操作不可撤销。`)) return;
      try {
        const result = await handlers.onDelete(ids);
        const deleted = result && typeof result.deleted === 'number' ? result.deleted : ids.length;
        toast(`已删除 ${deleted} 个${kindLabel}`);
        selectMode.selected.clear();
        handlers.onExit();
      } catch (e) {
        toast('删除失败：' + (e.message || e));
      }
    };
  }
  if (exit) {
    exit.onclick = () => {
      selectMode.selected.clear();
      handlers.onExit();
    };
  }
}

// Wire the per-row checkboxes inside a host. Returns the live count via
// `selectMode.onChange` whenever a checkbox flips. Re-renders are the
// page's job — this just keeps the Set in sync.
export function wireBulkRowChecks(host, selectMode) {
  host.querySelectorAll('.bulk-row-check').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.bulkId;
      if (!id) return;
      if (cb.checked) selectMode.selected.add(id);
      else selectMode.selected.delete(id);
      selectMode.onChange();
    };
  });
}

// Wire the "进入批量删除" link in idle mode.
export function wireBulkEnter(host, onEnter) {
  const link = host.querySelector('[data-bulk-enter]');
  if (!link) return;
  link.onclick = (e) => {
    e.preventDefault();
    onEnter();
  };
}

// Collect the ids of all visible bulk-rows inside a host. Used by the
// "select all" toggle — it should only flip the rows the user can see
// right now, not rows on other pages of the pager.
function collectVisibleIds(host) {
  const out = [];
  host.querySelectorAll('.bulk-row').forEach((row) => {
    const id = row.dataset.bulkId;
    if (id) out.push(id);
  });
  return out;
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
