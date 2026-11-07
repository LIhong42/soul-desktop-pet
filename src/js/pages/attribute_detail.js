// src/js/pages/attribute_detail.js — view + edit + delete a single
// likes/taboos/gifts entry. Reached via `#/attributes/:id` from one of the
// per-contact tabs (喜好 / 忌讳 / 礼物) on the contact detail page. The
// list pages only render rows; all mutations live here so the row UI stays
// uncluttered.

import { api, escapeHtml, displayName, fmtDate, todayYmd, toast, getCachedAvatarDataUrl, fetchAvatarDataUrl, wireDateInputs } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate, getReferrerPath } from '../router.js';

const TITLE_BY_KIND = { like: '喜好', taboo: '忌讳', gift: '礼物' };

// URL segment of the contact tab each kind lives in.
const TAB_SEGMENT = { like: 'likes', taboo: 'taboos', gift: 'gifts' };

// "Back" always goes to the URL the user was on right before opening this
// detail page. We read it fresh on every render() call so re-entering the
// detail page from a different list reflects the new referrer, not the
// stale one captured on a prior visit.
//
// router.js guarantees that lastPath is updated only AFTER the handler
// resolves, so calling getReferrerPath() at the top of render() returns the
// previous page's path — never our own URL.
//
// Fallback (direct URL entry, no referrer): the contact's own tab, since
// that is where every attribute row is managed from.
function pickBackPath(kind, contactId) {
  return getReferrerPath() || `/contacts/${contactId}/${TAB_SEGMENT[kind] || 'likes'}`;
}

async function render(args) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  // The id alone is enough to find the entry, but the contact_attributes
  // list endpoint takes a kind as well — we'd have to call it 3 times to
  // cover likes/taboos/gifts. Use the dedicated single-row lookup instead.
  let row = null;
  let kind = null;
  let errors = [];
  for (const k of ['like', 'taboo', 'gift']) {
    try {
      const r = await api.attributes.list(k, {});
      const hit = (r || []).find((x) => x && x.id === args.id);
      if (hit) { row = hit; kind = k; break; }
    } catch (e) {
      errors.push(`${k}: ${e.message || e}`);
    }
  }
  if (!row) {
    app.innerHTML = `<div class="empty">条目不存在${errors.length ? ' · ' + escapeHtml(errors.join('; ')) : ''}</div>
      <div class="row" style="gap:8px; justify-content:center;">
        <a class="inline-link" href="#/contacts">返回联系人</a>
      </div>`;
    return;
  }

  const c = await api.contacts.get(row.contact_id);
  // Warm the avatar data URL cache so the avatar photo paints on the same
  // tick as the rest of the page.
  if (c.custom_avatar_path) fetchAvatarDataUrl(c.id);
  const titleText = TITLE_BY_KIND[kind] || '条目';
  const backPath = pickBackPath(kind, row.contact_id);
  const backHash = '#' + backPath;
  // Label follows the page the user came from: the contact's own tab says
  // "返回喜好 / 忌讳 / 礼物"; the contact overview says "返回联系人详情".
  const tabMatch = /^\/contacts\/[^/]+\/(likes|taboos|gifts)$/.exec(backPath);
  const backLabel = tabMatch
    ? ({ likes: '返回喜好', taboos: '返回忌讳', gifts: '返回礼物' }[tabMatch[1]])
    : /^\/contacts\/[^/]+/.test(backPath) ? '返回联系人详情'
    : '返回联系人';
  const avatarUrl = c.custom_avatar_path ? getCachedAvatarDataUrl(c.id) : '';

  app.innerHTML = `
    <div class="page-column">
      <div class="row between">
        <h1>${escapeHtml(titleText)}详情</h1>
        <a class="back-link" id="back-link" href="${escapeHtml(backHash)}"><span class="icon-arrow-left"></span>${escapeHtml(backLabel)}</a>
      </div>

      <div class="card">
        <div class="row" style="gap:12px; align-items:center;">
          <div class="contact-avatar" style="color: var(--contact-${defaultIndexFor(c.name)})">
            ${avatarUrl
              ? `<img src="${escapeHtml(avatarUrl)}" alt=""/>`
              : iconSVG(suggestIconKind(c.relationship), { title: displayName(c) })}
          </div>
          <div style="flex:1; min-width:0;">
            <div class="lr-title">${escapeHtml(displayName(c))}</div>
            <div class="meta">${escapeHtml(c.relationship || '未填关系')}</div>
          </div>
          <a class="inline-link" href="#/contacts/${escapeHtml(c.id)}">查看联系人</a>
        </div>
      </div>

      <div class="card">
        <div class="section-header"><h2>基本信息</h2></div>
        <div class="field">
          <label>描述 *</label>
          <input type="text" id="attr-desc" value="${escapeHtml(row.description || '')}" autofocus/>
        </div>
        <div class="field">
          <label>事件（记录时间）</label>
          <input type="date" id="attr-event" value="${escapeHtml(row.event || todayYmd())}"/>
        </div>
        <div class="row" style="margin-top:14px; gap:8px;">
          <button class="btn" id="save">保存</button>
          <button class="btn danger" id="del">删除</button>
        </div>
      </div>

      <div class="card">
        <div class="section-header"><h2>元信息</h2></div>
        <div class="row" style="gap:24px; flex-wrap:wrap;">
          <div><div class="meta">创建时间</div>${escapeHtml(row.created_at || '未知')}</div>
          <div><div class="meta">更新时间</div>${escapeHtml(row.updated_at || '未知')}</div>
        </div>
      </div>
    </div>
  `;

  // Click anywhere on the date input to open the calendar picker.
  wireDateInputs(app);

  document.getElementById('save').onclick = async () => {
    const desc = document.getElementById('attr-desc');
    const ev = document.getElementById('attr-event');
    const description = desc.value.trim();
    if (!description) { toast('请填写描述'); desc.focus(); return; }
    const event = ev.value || todayYmd();
    try {
      await api.attributes.update(row.id, { description, event });
      toast('已保存');
      // Stay on the page so the user can keep editing; reflect the saved value.
      document.getElementById('attr-desc').value = description;
      document.getElementById('attr-event').value = event;
    } catch (e) {
      toast('保存失败：' + (e.message || e));
    }
  };

  document.getElementById('del').onclick = async () => {
    if (!confirm('确认删除该条目？此操作不可撤销。')) return;
    try {
      await api.attributes.delete(row.id);
      toast('已删除');
      navigate(backPath);
    } catch (e) {
      toast('删除失败：' + (e.message || e));
    }
  };
}

// Local copy of the contact-color-index helper. We avoid importing from
// api.js to prevent cycles (and the function is two lines).
function defaultIndexFor(name) {
  const v = (name || '').trim();
  if (!v) return 1;
  let h = 0;
  for (let i = 0; i < v.length; i++) h = ((h << 5) - h + v.charCodeAt(i)) | 0;
  return (Math.abs(h) % 8) + 1;
}

register('/attributes/:id', render);
