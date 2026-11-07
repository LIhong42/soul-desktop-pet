// src/js/pages/contacts_list.js — list + create
import { api, escapeHtml, contactColorIndex, displayName, getCachedAvatarDataUrl, warmAvatarCache } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate } from '../router.js';
import { applyBackground } from '../page_background.js';
import { pageSlice, pagerHtml, wirePager } from '../pager.js';

// The list is paginated. `page` is the current page index (0-based) — a
// VIEW state, not a URL state: putting it in the hash would make every
// "next page" click a history entry.
//
// The page's own state lives at module scope, like the other list pages'
// (events.js / events_work.js), so it survives a repaint of the list
// subtree.
const pageState = { page: 0 };

// Render the avatar block for a single contact row. When the contact has
// an uploaded photo (cached as a data URL by `warmAvatarCache` + an async
// `fetchAvatarDataUrl`) we prefer the photo; otherwise we render a Lucide
// glyph chosen from `icon_kind` or auto-suggested from `relationship`.
function contactAvatarHTML(c) {
  const url = c.custom_avatar_path ? getCachedAvatarDataUrl(c.id) : '';
  if (url) return `<img src="${escapeHtml(url)}" alt=""/>`;
  const name = c.icon_kind && c.icon_kind !== 'user'
    ? c.icon_kind
    : suggestIconKind(c.relationship);
  return iconSVG(name, { title: displayName(c) });
}

// One contact row.
function contactRowHTML(c, tone) {
  return `
    <div class="card list-row clickable"
         data-contact-color="${tone(c.name)}"
         data-id="${escapeHtml(c.id)}">
      <div class="lr-id">
        <div class="contact-avatar" style="color: var(--contact-${tone(c.name)})">
          ${contactAvatarHTML(c)}
        </div>
      </div>
      <div class="lr-main">
        <div class="lr-title">
          ${escapeHtml(displayName(c))}
          ${c.relationship
            ? `<span class="relationship-sep">·</span><span class="relationship">${escapeHtml(c.relationship)}</span>`
            : ''}
        </div>
      </div>
    </div>
  `;
}

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  // The page wears the shared background artwork. It's applied before the
  // list loads so the page doesn't flash the plain app surface first.
  await applyBackground();
  const contacts = await api.contacts.list();
  // Pre-compute the per-contact palette index once so we don't re-hash on
  // every row's data-attribute set.
  const tone = (name) => contactColorIndex(name);
  // Warm the avatar cache so contacts with custom photos repaint on the
  // second tick without a per-row IPC.
  for (const c of contacts) if (c.custom_avatar_path) warmAvatarCache(c.id);

  // Structure: a static shell that wraps a replaceable list subtree. The
  // header (the person count, the "新建" button) lives OUTSIDE the subtree,
  // so turning a page repaints only the rows and the pager.
  app.innerHTML = `
    <div class="bg-page">
      <div class="row between">
        <h1>联系人 <span class="meta" style="margin-left:6px">· ${contacts.length} 人</span></h1>
        <button class="btn" id="new-contact">+ 新建</button>
      </div>
      <div id="contacts-list"></div>
    </div>
  `;

  // Paint the list subtree. Declared here (rather than at module scope)
  // because it closes over `contacts` and `tone`.
  function paintList() {
    const host = document.getElementById('contacts-list');
    if (!host) return;

    const { total, totalPages, visible } = pageSlice(contacts, pageState);

    host.innerHTML = `
      ${total === 0
        ? `<div class="empty">还没有联系人 · 点 + 新建 创建一个</div>`
        : visible.map((c) => contactRowHTML(c, tone)).join('')}
      ${pagerHtml(pageState.page, totalPages, total)}
    `;

    host.querySelectorAll('.card.clickable').forEach((el) => {
      el.onclick = () => navigate('/contacts/' + el.dataset.id);
    });

    wirePager(host, pageState, paintList, () => {
      // Keep the user at the top of the new page — otherwise they land
      // halfway down it, looking at rows they already saw.
      const scroller = document.querySelector('.content');
      if (scroller) scroller.scrollTop = 0;
    });
  }

  paintList();
  document.getElementById('new-contact').onclick = () => navigate('/contacts/new');
}

register('/contacts', render);
