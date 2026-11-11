// src/js/pager.js — Shared list pagination.
//
// Three pages show a long list over the shared background artwork:
// 提醒 (events.js), 联系人 (contacts_list.js) and the contact detail
// page's kind tabs (contact_detail.js). All three want the same thing: a
// fixed number of rows per page, a pager under the list, and a repaint
// that touches nothing but the list itself.
//
// Why this lives in its own module:
//
//   - The pagination maths (page count, clamping, slicing) is the same
//     everywhere, and getting it subtly different per page is how you end
//     up with a page whose last page shows 3 rows while another's shows 8.
//   - The pager markup and its styling live in one place, so the three
//     list pages cannot drift apart visually.
//   - The page index is a VIEW state, not a URL state — it is not in the
//     hash, because every "next page" click would then be a history entry.
//     Each page keeps its own index in its own state object.
//
// Usage:
//
//   import { pageSlice, pagerHtml, wirePager } from '../pager.js';
//
//   const { total, totalPages, start, visible } = pageSlice(rows, state.page);
//   host.innerHTML = rowsHtml(visible) + pagerHtml(state.page, totalPages, total);
//   wirePager(host, state, () => paintList());
//
// `pagerHtml` renders nothing when everything fits on one page — an empty
// strip under a short list would just be a line of nothing.

export const PAGE_SIZE = 8;

// How many rows one page of a list shows.
//
// The list is paginated rather than endless for two reasons. The obvious
// one is length: a user with a hundred contacts or festivals gets an
// unreadable scroll. The less obvious one is the background artwork — the
// list is drawn over the shared picture, and a page whose content is
// taller than the viewport shows only the top slice of a fixed artwork.
// Keeping the list to one screenful keeps the picture and the content in
// the same frame instead of letting the rows run off past the bottom of
// the painting.

// Work out which slice of `rows` the current page shows.
//
// The page index is clamped rather than trusted: deleting rows can leave
// it pointing past the end, and a filter change can leave it past the end
// of a shorter list. The clamp is applied to the STATE here (so the
// caller's state stays in sync) and the clamped value is returned.
export function pageSlice(rows, state, pageSize = PAGE_SIZE) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;
  const start = state.page * pageSize;
  return {
    total,
    totalPages,
    start,
    visible: rows.slice(start, start + pageSize),
  };
}

// The pager markup.
//
// `total` is optional: pass it to also show the entry count
// ("第 1 / 5 页 · 共 33 条"), leave it out for the shorter
// "第 1 / 5 页" the contact detail page's tabs use.
//
// The buttons carry `.section-page`, the same class the contact detail
// page's pager uses, so every pager in the app is styled by one set of
// rules and cannot drift apart.
export function pagerHtml(page, totalPages, total = null) {
  if (totalPages <= 1) return '';
  const cur = page + 1; // 1-based for display
  const prevDisabled = page <= 0;
  const nextDisabled = page >= totalPages - 1;
  const counter = total === null
    ? `第 ${cur} / ${totalPages} 页`
    : `第 ${cur} / ${totalPages} 页 · 共 ${total} 条`;
  return `
    <div class="row between section-pager">
      <button type="button" class="btn secondary section-page" data-action="prev" ${prevDisabled ? 'disabled' : ''}>← 上一页</button>
      <div class="meta">${counter}</div>
      <button type="button" class="btn secondary section-page" data-action="next" ${nextDisabled ? 'disabled' : ''}>下一页 →</button>
    </div>
  `;
}

// Wire the pager's buttons inside `host`.
//
// `onChange` is called after the page index moves, and is expected to
// repaint the list. The index is clamped to the valid range here too, so
// a click on an edge button is a no-op rather than an out-of-range page.
//
// `onPageChange` is optional and fires whenever the page actually moves
// — the contact detail page uses it to reload the tab's data, the list
// pages use it to scroll back to the top.
export function wirePager(host, state, onChange, onPageChange = null) {
  host.querySelectorAll('.section-page').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      const before = state.page;
      if (action === 'prev') state.page = Math.max(0, state.page - 1);
      if (action === 'next') state.page = state.page + 1;
      if (state.page === before) return; // nothing moved
      if (onPageChange) onPageChange(state.page);
      onChange(state.page);
    };
  });
}
