// src/js/pages/contacts_list.js — list + create
import { api, escapeHtml, contactColorIndex, displayName, getCachedAvatarDataUrl, warmAvatarCache } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate } from '../router.js';
import { applyBackground } from '../page_background.js';

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
  app.innerHTML = `
    <div class="bg-page">
      <div class="row between">
        <h1>联系人 <span class="meta" style="margin-left:6px">· ${contacts.length} 人</span></h1>
        <button class="btn" id="new-contact">+ 新建</button>
      </div>
      ${contacts.length === 0
        ? `<div class="empty">还没有联系人 · 点 + 新建 创建一个</div>`
        : contacts.map((c) => `
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
        `).join('')}
    </div>
  `;
  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => navigate('/contacts/' + el.dataset.id);
  });
  document.getElementById('new-contact').onclick = () => navigate('/contacts/new');
}

register('/contacts', render);