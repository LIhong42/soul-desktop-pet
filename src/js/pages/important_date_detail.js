// src/js/pages/important_date_detail.js — view + edit + delete a single
// important_date row. Reached via `#/important-dates/:id`. The list page
// (the contact-detail page) renders each row as a clickable card and the
// detail page is the only place where editing happens.

import { api, escapeHtml, displayName, toast, getCachedAvatarDataUrl, fetchAvatarDataUrl, wireDateInputs } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate, getReferrerPath } from '../router.js';

const KIND_LABEL = {
  birthday: '生日',
  anniversary: '纪念日',
  deceased_date: '忌日',
  custom: '自定义',
};

// "Back" goes to the URL the user was on right before opening this detail
// page. Read fresh on every render() call so re-entering from a different
// list reflects the new referrer, not a stale snapshot from a prior visit.
// router.js updates lastPath only after the handler resolves, so the value
// we read here is always the previous page's path — never our own URL.

async function render(args) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  // The schema doesn't expose a single-row getter for important_dates; the
  // caller (contact_detail) always lists them in batches, and the id is the
  // id field. Pull the contact's full list and find the matching row.
  // We don't know which contact this id belongs to, so we'd need to scan
  // every contact. Instead, expose a single-row lookup by walking through
  // each contact — slower but bounded by contact count, which is small.
  let found = null;
  let contact = null;
  try {
    const contacts = await api.contacts.list();
    for (const c of contacts) {
      const rows = await api.importantDates.list(c.id);
      const hit = (rows || []).find((r) => r && r.id === args.id);
      if (hit) { found = hit; contact = c; break; }
    }
  } catch (e) {
    app.innerHTML = `<div class="empty">载入失败：${escapeHtml(e.message || String(e))}</div>`;
    return;
  }

  if (!found) {
    app.innerHTML = `
      <div class="empty">重要日期不存在或已被删除</div>
      <div class="row" style="justify-content:center;">
        <a class="inline-link" href="#/contacts">返回联系人</a>
      </div>
    `;
    return;
  }

  // Back goes to wherever the user came from. The router records the
  // previous URL in lastPath; if the user deep-linked straight here, fall
  // back to the contact's detail page (the natural entry point for an
  // important-date row).
  const ref = getReferrerPath();
  const backPath = ref && ref !== `/important-dates/${args.id}`
    ? ref
    : `/contacts/${contact.id}`;
  const backHash = '#' + backPath;
  const backLabel = /^\/contacts\/[^/]+\/(likes|taboos|gifts|important-dates)/.test(backPath) ? '← 返回联系人详情'
                  : /^\/contacts\/[^/]+$/.test(backPath) ? '← 返回联系人详情'
                  : backPath === '/important-dates' ? '← 返回提醒日期'
                  : '← 返回上一页';
  // Warm the avatar data URL cache so the contact photo paints on the same
  // tick as the rest of the page.
  if (contact.custom_avatar_path) fetchAvatarDataUrl(contact.id);
  const avatarUrl = contact.custom_avatar_path ? getCachedAvatarDataUrl(contact.id) : '';

  app.innerHTML = `
    <div class="row between">
      <h1>重要日期详情</h1>
      <a class="inline-link" id="back-link" href="${escapeHtml(backHash)}">${escapeHtml(backLabel)}</a>
    </div>

    <div class="card">
      <div class="row" style="gap:12px; align-items:center;">
        <div class="contact-avatar" style="color: var(--contact-${defaultIndexFor(contact.name)})">
          ${avatarUrl
            ? `<img src="${escapeHtml(avatarUrl)}" alt=""/>`
            : iconSVG(suggestIconKind(contact.relationship), { title: displayName(contact) })}
        </div>
        <div style="flex:1; min-width:0;">
          <div class="lr-title">${escapeHtml(displayName(contact))}</div>
          <div class="meta">${escapeHtml(contact.relationship || '未填关系')}</div>
        </div>
        <a class="inline-link" href="#/contacts/${escapeHtml(contact.id)}">查看联系人</a>
      </div>
    </div>

    <div class="card">
      <div class="section-header"><h2>基本信息</h2></div>
      <div class="field">
        <label>名称 *</label>
        <input type="text" id="d-label" value="${escapeHtml(found.label || '')}" autofocus/>
      </div>
      <div class="form-row">
        <div class="field">
          <label>月 *</label>
          <input type="number" id="d-month" min="1" max="12" value="${escapeHtml(String(found.month || 1))}"/>
        </div>
        <div class="field">
          <label>日 *</label>
          <input type="number" id="d-day" min="1" max="31" value="${escapeHtml(String(found.day || 1))}"/>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>年（可选）</label>
          <input type="number" id="d-year" placeholder="1990" value="${escapeHtml(found.year ? String(found.year) : '')}"/>
        </div>
        <div class="field">
          <label>类型</label>
          <select id="d-kind">
            <option value="birthday"     ${found.kind === 'birthday'     ? 'selected' : ''}>生日</option>
            <option value="anniversary"  ${found.kind === 'anniversary'  ? 'selected' : ''}>纪念日</option>
            <option value="deceased_date" ${found.kind === 'deceased_date' ? 'selected' : ''}>忌日</option>
            <option value="custom"       ${found.kind === 'custom'       ? 'selected' : ''}>自定义</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>提醒时间</label>
        <input type="time" id="d-time" value="${escapeHtml(found.remind_time || '09:00')}"/>
      </div>
      <div class="form-row">
        <div class="field">
          <label>提前提醒（天）</label>
          <input type="number" id="d-advance" min="0" max="60" value="${escapeHtml(String(found.advance_days != null ? found.advance_days : 7))}"/>
          <div class="meta">提前这么多天开始每天提醒一次，0 = 只在当天提醒</div>
        </div>
        <div class="field">
          <label>提醒开关</label>
          <label><input type="checkbox" id="d-remind-enabled" ${found.remind_enabled === 0 ? '' : 'checked'}/> 启用提醒</label>
          <div class="meta">关闭后保留这条日期记录，但不再提醒</div>
        </div>
      </div>
      <div class="row" style="margin-top:14px; gap:8px;">
        <button class="btn" id="save">保存</button>
        <button class="btn danger" id="del">删除</button>
      </div>
    </div>

    <div class="card">
      <div class="section-header"><h2>元信息</h2></div>
      <div class="row" style="gap:24px; flex-wrap:wrap;">
        <div><div class="meta">创建时间</div>${escapeHtml(found.created_at || '未知')}</div>
        <div><div class="meta">更新时间</div>${escapeHtml(found.updated_at || '未知')}</div>
      </div>
    </div>
  `;

  // Click anywhere on the time input to open the time picker.
  wireDateInputs(app);

  document.getElementById('save').onclick = async () => {
    const label = document.getElementById('d-label').value.trim() || '生日';
    const month = parseInt(document.getElementById('d-month').value, 10);
    const day = parseInt(document.getElementById('d-day').value, 10);
    const yearRaw = document.getElementById('d-year').value;
    const year = yearRaw ? parseInt(yearRaw, 10) : null;
    const kind = document.getElementById('d-kind').value;
    const remindTime = document.getElementById('d-time').value || '09:00';
    const advanceDays = Math.floor(Number(document.getElementById('d-advance').value));
    const remindEnabled = document.getElementById('d-remind-enabled').checked;
    if (month < 1 || month > 12 || day < 1 || day > 31) { toast('日期不合法'); return; }
    if (!Number.isFinite(advanceDays) || advanceDays < 0) { toast('提前提醒天数不合法'); return; }
    try {
      await api.importantDates.update(found.id, {
        label, month, day, year, kind, remind_time: remindTime,
        advance_days: Math.min(advanceDays, 60),
        remind_enabled: remindEnabled,
      });
      toast('已保存');
    } catch (e) {
      toast('保存失败：' + (e.message || e));
    }
  };

  document.getElementById('del').onclick = async () => {
    if (!confirm('确认删除该重要日期？此操作不可撤销。')) return;
    try {
      await api.importantDates.delete(found.id);
      toast('已删除');
      navigate(backPath);
    } catch (e) {
      toast('删除失败：' + (e.message || e));
    }
  };
}

function defaultIndexFor(name) {
  const v = (name || '').trim();
  if (!v) return 1;
  let h = 0;
  for (let i = 0; i < v.length; i++) h = ((h << 5) - h + v.charCodeAt(i)) | 0;
  return (Math.abs(h) % 8) + 1;
}

register('/important-dates/:id', render);
