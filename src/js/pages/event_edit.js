// src/js/pages/event_edit.js — create/edit events + event detail.
//
// Two distinct flows live behind the same route table:
//
//   1. Reminder-style events (category 'general' or 'work'). These keep the
//      legacy form: 类型 / 描述 / 关联联系人 (single) / 启用提醒 + 重复 / 阳
//      历 or 农历 / 日期 / 时间. They continue to be persisted via the
//      `events` table and the `api.events.*` namespace.
//
//   2. Memorial events (category 'memorial'). These use the new memorial
//      flow: 类型 (第一次/其他) / 标题 / 描述 / 事件发生时间 / 多联系人 /
//      照片上传. They are persisted via `memorial_events` and
//      `memorial_event_photos` tables and the `api.memorialEvents.*`
//      namespace.
//
// The branch is decided at the top of `renderEdit` based on the URL's
// ?category=… param. Keeping both flows in one file avoids duplicating the
// route table and the constants shared by all three categories.
import { api, escapeHtml, displayName, fmtDateTime, toast, memorialPhotoUrl, fetchPhotoDataUrl, invalidatePhotoDataUrl, todayYmd, nowDatetimeLocal, wireDateInputs } from '../api.js';
import { register, navigate, getReferrerPath } from '../router.js';

const CATEGORIES = ['general', 'memorial', 'work'];
const CATEGORY_TITLE = { general: '提醒日期', memorial: '回忆事件', work: '工作事件' };
const CATEGORY_LIST_ROUTE = { general: '/reminders', memorial: '/events/memorial', work: '/events/work' };

// 1-12 lunar months; the day range is intentionally wide (1-30) and validated
// server-side because whether day 30 exists depends on the year/month.
const LUNAR_MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const LUNAR_DAY_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1);

function resolveCategory(params) {
  const c = (params && params.category) || 'general';
  return CATEGORIES.includes(c) ? c : 'general';
}

function categoryTitle(c) { return CATEGORY_TITLE[c] || '提醒日期'; }
function categoryListRoute(c) { return CATEGORY_LIST_ROUTE[c] || '/reminders'; }

async function renderEdit(args, params) {
  // Memorial events use a different form, table, and API namespace.
  // Dispatch into the dedicated handler. The general/work branches below
  // are byte-for-byte the legacy reminder form.
  const category = resolveCategory(params);
  if (category === 'memorial') {
    return renderMemorialEdit(args, params);
  }

  const app = document.getElementById('app');
  const isNew = !args.id;
  let ev = {
    category,
    contact_id: params.contact_id || null,
    title: '',
    description: '',
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: todayYmd(),
    lunar_month: null,
    lunar_day: null,
    tag_kind: null,
    interval_days: null,
    advance_days: null,
  };
  if (!isNew) {
    ev = await api.events.get(args.id);
  }
  const contacts = await api.contacts.list();
  const listRoute = categoryListRoute(category);
  // The "back" target honors the page the user actually came from rather
  // than the hard-coded category list. Falling back to the category list
  // keeps the legacy behavior for flows where no referrer exists (deep
  // link, app cold start, etc.).
  const returnTo = getReferrerPath() || listRoute;
  const listHref = '#' + returnTo;
  // Pre-compute the initial calendar mode: prefer lunar when both lunar
  // fields are populated (typically a saved lunar reminder); otherwise solar.
  const initialCalMode = (ev.lunar_month && ev.lunar_day) ? 'lunar' : 'solar';

  // 工作事件不需要「类型」选项（生日/纪念日/节日）和「关联联系人」字段。其余类别保留。
  const showTagKind = category !== 'work';
  const showContact = category !== 'work';

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建' : '编辑'}${categoryTitle(category)}</h1>
      <a class="inline-link" href="${listHref}">← 返回列表</a>
    </div>
    <div class="card">
      ${showTagKind ? `
      <div class="field">
        <label>类型</label>
        <select id="e-tag-kind">
          <option value=""           ${!ev.tag_kind ? 'selected' : ''}>(无)</option>
          <option value="birthday"    ${ev.tag_kind === 'birthday'    ? 'selected' : ''}>生日</option>
          <option value="anniversary" ${ev.tag_kind === 'anniversary' ? 'selected' : ''}>纪念日</option>
          ${ev.tag_kind === 'festival' ? '<option value="festival" selected>节日</option>' : ''}
        </select>
      </div>
      ` : ''}
      <div class="field"><label>描述</label><textarea id="e-desc">${escapeHtml(ev.description || '')}</textarea></div>
      ${showContact ? `
      <div class="field">
        <label>关联联系人（可选）</label>
        <select id="e-contact">
          <option value="">(独立事件)</option>
          ${contacts.map((c) => `<option value="${escapeHtml(c.id)}" ${ev.contact_id===c.id?'selected':''}>${escapeHtml(displayName(c))}</option>`).join('')}
        </select>
      </div>
      ` : ''}
      <div class="field">
        <label><input type="checkbox" id="e-remind" ${ev.remind?'checked':''}/> 启用提醒</label>
      </div>
      <div id="remind-fields">
        <div class="form-row">
          <div class="field">
            <label>重复</label>
            <select id="e-kind">
              <option value="one_time" ${ev.remind_kind==='one_time'?'selected':''}>只一次</option>
              <option value="daily"    ${ev.remind_kind==='daily'?'selected':''}>每天</option>
              <option value="weekly"   ${ev.remind_kind==='weekly'?'selected':''}>每周</option>
              <option value="every_n_days" ${ev.remind_kind==='every_n_days'?'selected':''}>每 N 天</option>
              <option value="monthly"  ${ev.remind_kind==='monthly'?'selected':''}>每月</option>
              <option value="yearly"   ${ev.remind_kind==='yearly'?'selected':''}>每年</option>
            </select>
          </div>
          <div class="field ${ev.remind_kind === 'every_n_days' ? '' : 'hidden'}" id="e-interval-field">
            <label>间隔天数</label>
            <input type="number" id="e-interval-days" min="1" max="365" value="${escapeHtml(String(ev.interval_days || 3))}"/>
            <div class="meta">每隔 N 天提醒一次（从起始日期算起）</div>
          </div>
          <div class="field">
            <label>日期类型</label>
            <div class="row" style="gap:12px; align-items:center;">
              <label><input type="radio" name="e-cal-mode" value="solar" ${initialCalMode==='solar'?'checked':''}/> 阳历</label>
              <label><input type="radio" name="e-cal-mode" value="lunar" ${initialCalMode==='lunar'?'checked':''}/> 农历</label>
            </div>
          </div>
        </div>
        <div id="solar-fields">
          <div class="field">
            <label id="date-label">日期</label>
            <input type="date" id="e-date" value="${escapeHtml(ev.remind_date || todayYmd())}"/>
          </div>
        </div>
        <div id="lunar-fields" class="hidden">
          <div class="form-row">
            <div class="field">
              <label>农历月</label>
              <select id="e-lunar-month">
                ${LUNAR_MONTH_OPTIONS.map((m) => `<option value="${m}" ${ev.lunar_month===m?'selected':''}>${m} 月</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>农历日</label>
              <select id="e-lunar-day">
                ${LUNAR_DAY_OPTIONS.map((d) => `<option value="${d}" ${ev.lunar_day===d?'selected':''}>${d} 日</option>`).join('')}
              </select>
            </div>
          </div>
          </div>
        <div class="field">
          <label>提醒时间</label>
          <input type="time" id="e-time" value="${escapeHtml(ev.remind_time || '09:00')}"/>
        </div>
      </div>
      <div class="row" style="margin-top:14px; gap:8px;">
        <button class="btn" id="save">${isNew?'创建':'保存'}</button>
        ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
      </div>
    </div>
  `;

  function toggleRemind() {
    const on = document.getElementById('e-remind').checked;
    document.getElementById('remind-fields').style.display = on ? '' : 'none';
  }
  function toggleKind() {
    const k = document.getElementById('e-kind').value;
    document.getElementById('date-label').textContent =
      k === 'one_time' ? '日期' :
      k === 'yearly' ? '周年日期' :
      k === 'monthly' ? '每月几号' :
      k === 'weekly' ? '起始日期（每周一次）' :
      k === 'every_n_days' ? '起始日期' :
      k === 'daily' ? '起始日期（可选）' : '日期';
    // The "每 N 天" stride input only applies to that one repeat kind.
    const intervalField = document.getElementById('e-interval-field');
    if (intervalField) intervalField.classList.toggle('hidden', k !== 'every_n_days');
  }
  // Show/hide the solar vs lunar field set, and gate the lunar radio when
  // the user picks a repeat kind that has no meaningful lunar anchor.
  //
  // "每天" has no anchor at all, and the two stride-based kinds (每周 /
  // 每 N 天) count days from an anchor date — a lunar anchor there would
  // mean "every 7 lunar days", which the scheduler doesn't implement, so
  // the radio is disabled for them too.
  function toggleCalMode() {
    const mode = document.querySelector('input[name="e-cal-mode"]:checked')?.value || 'solar';
    const kind = document.getElementById('e-kind').value;
    const noLunar = kind === 'daily' || kind === 'weekly' || kind === 'every_n_days';
    document.getElementById('solar-fields').classList.toggle('hidden', mode !== 'solar');
    document.getElementById('lunar-fields').classList.toggle('hidden', mode !== 'lunar');
    const lunarRadio = document.querySelector('input[name="e-cal-mode"][value="lunar"]');
    if (lunarRadio) {
      lunarRadio.disabled = noLunar;
      if (noLunar && lunarRadio.checked) {
        document.querySelector('input[name="e-cal-mode"][value="solar"]').checked = true;
        toggleCalMode();
      }
    }
  }

  document.getElementById('e-remind').onchange = toggleRemind;
  document.getElementById('e-kind').onchange = () => { toggleKind(); toggleCalMode(); };
  document.querySelectorAll('input[name="e-cal-mode"]').forEach((el) => {
    el.addEventListener('change', toggleCalMode);
  });
  toggleRemind();
  toggleKind();
  toggleCalMode();

  // Make the date / time / datetime-local inputs open their picker on click
  // of the whole input, not just the trailing icon.
  wireDateInputs(app);

  document.getElementById('save').onclick = async () => {
    const mode = document.querySelector('input[name="e-cal-mode"]:checked')?.value || 'solar';
    const kind = document.getElementById('e-kind').value;
    // Tag kind comes from the 类型 dropdown. The dropdown includes an
    // "(无)" option that maps to null. Festival events are system-managed
    // and the dropdown is locked for them (see form HTML), so we just
    // preserve the existing tag_kind in that case.
    // For 工作事件 the dropdown is not rendered, so we keep the existing
    // tag_kind untouched on the server (typically null).
    let tagKind = ev.tag_kind || null;
    if (showTagKind && ev.tag_kind !== 'festival') {
      const sel = document.getElementById('e-tag-kind').value;
      tagKind = sel || null;
    }
    // Title is no longer on the form — the server auto-fills it from the
    // contact name (or a generic placeholder) on create, and falls back to
    // the existing title on update if the form somehow sends an empty value.
    // 工作事件没有关联联系人字段,提交时显式置 null,避免残留旧值。
    const contactId = showContact
      ? (document.getElementById('e-contact').value || null)
      : null;
    const base = {
      title: ev.title || '',
      description: document.getElementById('e-desc').value.trim() || null,
      contact_id: contactId,
      remind: document.getElementById('e-remind').checked,
      remind_kind: kind,
      remind_time: document.getElementById('e-time').value || '09:00',
      category,
      tag_kind: tagKind,
    };
    if (kind === 'daily' && mode === 'lunar') {
      toast('每天重复不支持农历日期');
      return;
    }
    if ((kind === 'weekly' || kind === 'every_n_days') && mode === 'lunar') {
      toast(kind === 'weekly' ? '每周重复不支持农历日期' : '每 N 天重复不支持农历日期');
      return;
    }
    // The stride only applies to "每 N 天". Everything else stores null so
    // a stale value can't resurface if the user switches back and forth.
    if (kind === 'every_n_days') {
      const n = Math.floor(Number(document.getElementById('e-interval-days').value));
      if (!Number.isFinite(n) || n < 1) {
        toast('间隔天数需要是大于 0 的整数');
        return;
      }
      base.interval_days = Math.min(n, 365);
    } else {
      base.interval_days = null;
    }
    let input;
    if (mode === 'lunar') {
      input = {
        ...base,
        lunar_month: Number(document.getElementById('e-lunar-month').value),
        lunar_day: Number(document.getElementById('e-lunar-day').value),
        // remind_date is not meaningful for lunar; the server uses lunar_* to
        // recompute next_fire_at on every save/tick. Keep null for clarity.
        remind_date: null,
      };
    } else {
      input = {
        ...base,
        lunar_month: null,
        lunar_day: null,
        remind_date: document.getElementById('e-date').value || null,
      };
    }
    try {
      if (isNew) {
        await api.events.create(input);
        toast('已创建');
      } else {
        await api.events.update(ev.id, input);
        toast('已保存');
      }
      navigate(returnTo);
    } catch (e) {
      toast((e && e.message) || '保存失败');
    }
  };
  if (!isNew) {
    document.getElementById('del').onclick = async () => {
      if (!confirm('确认删除该事件？')) return;
      await api.events.delete(ev.id);
      toast('已删除');
      navigate(returnTo);
    };
  }
}

// ---- Memorial event form ----
// Layout: 类型 (第一次 / 其他) → 标题 → 描述 → 事件发生时间 → 关联联系人 (多选 +
// 可空) → 照片上传 (多张, 可空). No reminder controls.
//
// Save order: create the row first (so we have an id to attach photos to),
// then upload each picked file. On edit we replace the contact set in one
// shot — the server diffs against the existing rows so we don't need to
// tombstone the old ones client-side.
async function renderMemorialEdit(args, params) {
  const app = document.getElementById('app');
  const isNew = !args.id;
  // Honor the page the user came from for the "back" link & post-save
  // navigation. Fall back to the memorial list when there is no referrer
  // (deep link, cold start, etc.).
  const returnTo = getReferrerPath() || categoryListRoute('memorial');
  const listHref = '#' + returnTo;
  const preselectedContactId = params.contact_id || '';

  let ev = {
    kind: 'other',
    title: '',
    // Five free-text fields the user fills out independently. All default to
    // empty strings so the template can render textareas unconditionally;
    // the save handler turns empty strings into null.
    place: '',
    food: '',
    outfit: '',
    activities: '',
    notes: '',
    occurred_at: '',
    contact_ids: [],
    photos: [],
  };
  let existingPhotos = [];
  if (!isNew) {
    ev = await api.memorialEvents.get(args.id);
    existingPhotos = ev.photos || [];
  }
  const contacts = await api.contacts.list();

  const occurredLocal = ev.occurred_at
    ? (ev.occurred_at.length >= 16 ? ev.occurred_at.slice(0, 16) : ev.occurred_at)
    : nowDatetimeLocal();

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建回忆事件' : '编辑回忆事件'}</h1>
      <a class="inline-link" href="${listHref}">← 返回列表</a>
    </div>
    <div class="card">
      <div class="field">
        <label>类型</label>
        <select id="e-kind">
          <option value="first_time" ${ev.kind === 'first_time' ? 'selected' : ''}>第一次</option>
          <option value="other"      ${ev.kind === 'other'      ? 'selected' : ''}>其他</option>
        </select>
      </div>
      <div class="field">
        <label>标题 *</label>
        <input type="text" id="e-title" maxlength="120" value="${escapeHtml(ev.title || '')}" placeholder="例如：第一次去迪士尼" autofocus/>
      </div>
      <div class="field">
        <label>去了哪里 / 吃了什么</label>
        <div class="form-row">
          <div class="field">
            <input type="text" id="e-place" maxlength="200" value="${escapeHtml(ev.place || '')}" placeholder="例如：西湖边的咖啡店"/>
          </div>
          <div class="field">
            <input type="text" id="e-food" maxlength="200" value="${escapeHtml(ev.food || '')}" placeholder="例如：寿喜烧 + 提拉米苏"/>
          </div>
        </div>
      </div>
      <div class="field">
        <label>关联人穿了什么 / 干了哪些事</label>
        <div class="form-row">
          <div class="field">
            <input type="text" id="e-outfit" maxlength="200" value="${escapeHtml(ev.outfit || '')}" placeholder="例如：她穿了一件红色连衣裙"/>
          </div>
          <div class="field">
            <input type="text" id="e-activities" maxlength="200" value="${escapeHtml(ev.activities || '')}" placeholder="例如：看了日落 / 骑了双人自行车"/>
          </div>
        </div>
      </div>
      <div class="field">
        <label>其他补充描述</label>
        <textarea id="e-notes" rows="3" placeholder="其他想记住的细节…">${escapeHtml(ev.notes || '')}</textarea>
      </div>
      <div class="field">
        <label>事件发生时间 *</label>
        <input type="datetime-local" id="e-occurred" value="${escapeHtml(occurredLocal)}"/>
      </div>
      <div class="field">
        <label>关联联系人（可选，可不选；点击勾选或取消）</label>
        <div class="contact-picker-toolbar">
          <button type="button" class="btn secondary btn-tiny" id="e-contacts-all">全选</button>
          <button type="button" class="btn secondary btn-tiny" id="e-contacts-none">清空</button>
          <span class="meta" id="e-contacts-count"></span>
        </div>
        <div class="contact-picker" id="e-contact-picker">
          ${contacts.length === 0
            ? `<div class="empty">还没有联系人可选择</div>`
            : contacts.map((c) => `
              <div class="contact-pick" data-id="${escapeHtml(c.id)}">
                <span class="contact-pick-check" aria-hidden="true">✓</span>
                <span class="contact-pick-name">${escapeHtml(displayName(c))}</span>
                ${c.relationship ? `<span class="contact-pick-meta">${escapeHtml(c.relationship)}</span>` : ''}
              </div>
            `).join('')}
        </div>
      </div>
      <div class="field">
        <label>照片（可选，可上传多张）</label>
        <input type="file" id="e-photos" accept="image/*" multiple/>
        <div class="photo-preview" id="e-photo-preview"></div>
      </div>
      ${!isNew ? `
      <div class="field">
        <label>已上传的照片</label>
        <div class="photo-existing" id="e-photo-existing"></div>
      </div>
      ` : ''}
      <div class="row" style="margin-top:14px; gap:8px;">
        <button class="btn" id="save">${isNew ? '创建' : '保存'}</button>
        ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
      </div>
    </div>
  `;

  // ---- Multi-contact picker wiring ----
  // State of truth is `selectedIds` (a Set<id>). Each card toggles in/out on
  // click; the toolbar (全选 / 清空) and the initial pre-population all funnel
  // through the same toggleSelected() entry to avoid the previous chip-row bugs
  // (event handlers leaking, ctrl-click confusion on native <select multiple>).
  const selectedIds = new Set();
  const pickerEl = document.getElementById('e-contact-picker');
  const countEl = document.getElementById('e-contacts-count');

  function refreshPickerUi() {
    if (!pickerEl) return;
    pickerEl.querySelectorAll('.contact-pick').forEach((el) => {
      el.classList.toggle('selected', selectedIds.has(el.dataset.id));
    });
    if (countEl) {
      countEl.textContent = selectedIds.size === 0
        ? '未选'
        : `已选 ${selectedIds.size} 人`;
    }
  }
  function toggleSelected(id) {
    if (!id) return;
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    refreshPickerUi();
  }
  if (pickerEl) {
    pickerEl.querySelectorAll('.contact-pick').forEach((el) => {
      el.addEventListener('click', () => toggleSelected(el.dataset.id));
    });
  }
  const allBtn = document.getElementById('e-contacts-all');
  const noneBtn = document.getElementById('e-contacts-none');
  if (allBtn) allBtn.onclick = () => {
    pickerEl.querySelectorAll('.contact-pick').forEach((el) => selectedIds.add(el.dataset.id));
    refreshPickerUi();
  };
  if (noneBtn) noneBtn.onclick = () => {
    selectedIds.clear();
    refreshPickerUi();
  };

  // Pre-select the contact passed via ?contact_id=… (used when the user
  // starts from a contact-detail page), then pre-populate from the existing
  // event on edit.
  if (preselectedContactId) selectedIds.add(preselectedContactId);
  if (!isNew && Array.isArray(ev.contact_ids)) {
    for (const cid of ev.contact_ids) selectedIds.add(cid);
  }
  refreshPickerUi();

  // ---- Photo picker (local previews only; final URLs come from the server) ----
  // The file input sits above the .photo-preview container — we look up the
  // file input directly by id (no parentElement gymnastics) and store all
  // createdObjectURL'd URLs in pendingObjectUrls so we can revoke them on
  // submit/delete to avoid leaking between renders.
  const photoPreviewEl = document.getElementById('e-photo-preview');
  const photoFileInput = document.getElementById('e-photos');
  let pendingObjectUrls = [];
  function rerenderPhotoPreview() {
    photoPreviewEl.innerHTML = '';
    // Drop previously-allocated object URLs before adding fresh ones. Each
    // change event replaces the FileList wholesale, so the old URLs are no
    // longer referenced by any <img> in the DOM.
    for (const u of pendingObjectUrls) URL.revokeObjectURL(u);
    pendingObjectUrls = [];
    const files = Array.from(photoFileInput.files || []);
    for (const f of files) {
      const url = URL.createObjectURL(f);
      pendingObjectUrls.push(url);
      const div = document.createElement('div');
      div.className = 'photo-item';
      div.style.cssText = 'position:relative;width:96px;height:96px;';
      div.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(f.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;border:1px solid var(--border);"/>`;
      photoPreviewEl.appendChild(div);
    }
  }
  photoFileInput.addEventListener('change', rerenderPhotoPreview);

  // ---- Existing photos (edit mode) ----
  // Two interactions per photo:
  //   1. Click the image → opens a lightbox modal with the full-size image.
  //   2. Click the small ✕ corner → asks for confirm, then deletes via IPC.
  // The lightbox is a single shared element so opening another photo just
  // swaps its <img src=…>; we don't re-create the modal markup every time.
  function openLightbox(url, altName) {
    let lb = document.getElementById('photo-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'photo-lightbox';
      lb.className = 'photo-lightbox';
      lb.innerHTML = `
        <div class="photo-lightbox-card">
          <button type="button" class="photo-lightbox-x" title="关闭">✕</button>
          <img id="photo-lightbox-img" alt=""/>
          <div class="photo-lightbox-caption" id="photo-lightbox-caption"></div>
        </div>
      `;
      document.body.appendChild(lb);
      const close = () => { lb.classList.remove('open'); };
      lb.querySelector('.photo-lightbox-x').onclick = close;
      lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lb.classList.contains('open')) close();
      });
    }
    lb.querySelector('#photo-lightbox-img').src = url;
    lb.querySelector('#photo-lightbox-img').alt = altName || '';
    lb.querySelector('#photo-lightbox-caption').textContent = altName || '';
    lb.classList.add('open');
  }

  if (!isNew) {
    const existingEl = document.getElementById('e-photo-existing');
    function rerenderExisting() {
      if (existingPhotos.length === 0) {
        existingEl.innerHTML = '<div class="meta">暂无照片</div>';
        return;
      }
      existingEl.innerHTML = existingPhotos.map((p) => {
        // Try the cache first so the first paint shows the thumbnail; if
        // not cached yet we still emit an <img> and let the cache fill in
        // on the next tick (the same node will be re-rendered when the
        // IPC promise resolves).
        const cachedUrl = memorialPhotoUrl(p.id);
        if (!cachedUrl) fetchPhotoDataUrl(p.id);
        return `
        <div class="photo-item" data-id="${escapeHtml(p.id)}">
          <img src="${escapeHtml(cachedUrl)}" data-photo-id="${escapeHtml(p.id)}" alt="${escapeHtml(p.original_name || '')}" loading="lazy" data-view-name="${escapeHtml(p.original_name || '')}"/>
          <button type="button" class="photo-x" data-id="${escapeHtml(p.id)}" title="删除">✕</button>
        </div>
      `;
      }).join('');
      // Once the data URLs arrive, swap the <img src=…> in place so the
      // thumbnail repaints without losing layout.
      for (const p of existingPhotos) {
        if (!p.id) continue;
        fetchPhotoDataUrl(p.id).then((url) => {
          if (!url) return;
          existingEl.querySelectorAll('img').forEach((imgEl) => {
            if (imgEl.dataset.photoId === p.id && imgEl.src !== url) imgEl.src = url;
          });
        });
      }
      // Click on the image → lightbox; click on the ✕ → delete.
      existingEl.querySelectorAll('.photo-item').forEach((item) => {
        const id = item.dataset.id;
        const img = item.querySelector('img');
        const x = item.querySelector('.photo-x');
        if (img) {
          img.onclick = async (e) => {
            e.stopPropagation();
            const url = await fetchPhotoDataUrl(id);
            if (url) openLightbox(url, img.dataset.viewName);
          };
        }
        if (x) {
          x.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm('删除该照片？')) return;
            try {
              await api.memorialEvents.photos.delete(id);
              invalidatePhotoDataUrl(id);
              toast('已删除');
            } catch (err) {
              toast('删除失败：' + (err.message || err));
              return;
            }
            existingPhotos = existingPhotos.filter((p) => p.id !== id);
            rerenderExisting();
          };
        }
      });
    }
    rerenderExisting();
  }

  // ---- Save / delete handlers ----
  document.getElementById('save').onclick = async () => {
    const title = document.getElementById('e-title').value.trim();
    if (!title) { toast('请填写标题'); document.getElementById('e-title').focus(); return; }
    const occurredRaw = document.getElementById('e-occurred').value;
    if (!occurredRaw) { toast('请填写事件发生时间'); return; }
    // datetime-local uses 'YYYY-MM-DDTHH:MM'. The server expects 'YYYY-MM-DD HH:MM:SS'.
    const occurredAt = occurredRaw.replace('T', ' ') + ':00';

    const selectedContacts = Array.from(selectedIds);

    const payload = {
      kind: document.getElementById('e-kind').value,
      title,
      place:       document.getElementById('e-place').value.trim() || null,
      food:        document.getElementById('e-food').value.trim() || null,
      outfit:      document.getElementById('e-outfit').value.trim() || null,
      activities:  document.getElementById('e-activities').value.trim() || null,
      notes:       document.getElementById('e-notes').value.trim() || null,
      occurred_at: occurredAt,
      contact_ids: selectedContacts,
    };

    let saved;
    try {
      saved = isNew
        ? await api.memorialEvents.create(payload)
        : await api.memorialEvents.update(ev.id, payload);
    } catch (e) {
      toast((e && e.message) || '保存失败');
      return;
    }

    // Upload any newly picked files. We don't bail on the first failure —
    // each photo is independent — but we do surface a count summary so the
    // user knows something went wrong.
    const files = Array.from(photoFileInput.files || []);
    if (files.length) {
      let okCount = 0;
      let failCount = 0;
      for (const f of files) {
        // Defensive size cap. Skip with a clear toast rather than ship a
        // multi-megabyte blob through IPC silently.
        if (f.size > 20 * 1024 * 1024) {
          toast(`照片 ${f.name} 超过 20MB，已跳过`);
          failCount += 1;
          continue;
        }
        try {
          const ab = await f.arrayBuffer();
          await api.memorialEvents.photos.upload(saved.id, {
            filename: f.name,
            mime: f.type,
            bytes: ab,
          });
          okCount += 1;
        } catch (e) {
          console.error('photo upload failed:', e);
          failCount += 1;
        }
      }
      if (failCount > 0 && okCount === 0) {
        toast(`照片上传失败（${failCount} 张）`);
      } else if (failCount > 0) {
        toast(`已上传 ${okCount} 张，${failCount} 张失败`);
      }
    }

    // Free the preview object URLs now that the user is leaving the page.
    for (const u of pendingObjectUrls) URL.revokeObjectURL(u);
    pendingObjectUrls = [];

    toast(isNew ? '已创建' : '已保存');
    navigate(returnTo);
  };

  if (!isNew) {
    document.getElementById('del').onclick = async () => {
      if (!confirm('确认删除该回忆事件？\n\n关联的照片会一起被删除，此操作不可撤销。')) return;
      try {
        await api.memorialEvents.delete(ev.id);
      } catch (e) {
        toast('删除失败：' + (e.message || e));
        return;
      }
      for (const u of pendingObjectUrls) URL.revokeObjectURL(u);
      toast('已删除');
      navigate(returnTo);
    };
  }

  // Make the date / time / datetime-local inputs open their picker on click
  // of the whole input, not just the trailing icon.
  wireDateInputs(app);
}

// /events/:id and /events/:id/edit both render the edit form. Clicking an
// event card from any list (or from contact_detail / search / today) lands
// directly on the edit page — no separate "编辑" button click needed.
// /events/new keeps its own route for the empty-form create case.
register('/events/new', renderEdit);
register('/events/:id/edit', renderEdit);
register('/events/:id', renderEdit);