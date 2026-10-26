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
import {
  MAIN_THEME,
  buildEventForm,
  wireEventForm,
  validateEventForm,
  eventPayload,
  buildMemorialForm,
  readMemorialForm,
} from '../form_fields.js';

const CATEGORIES = ['general', 'memorial', 'work'];
const CATEGORY_TITLE = { general: '提醒日期', memorial: '回忆事件', work: '工作事件' };
const CATEGORY_LIST_ROUTE = { general: '/reminders', memorial: '/events/memorial', work: '/events/work' };

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

  // 工作事件不需要「类型」选项（生日/纪念日/节日）和「关联联系人」字段。其余类别保留。
  const showTagKind = category !== 'work';
  const showContact = category !== 'work';

  // The form markup and its behaviour live in src/js/form_fields.js, shared
  // with the 快速记录 window so both stay in sync by construction.
  const form = buildEventForm({
    theme: MAIN_THEME,
    id: 'e',
    showTagKind,
    showContact,
    ev,
    contacts,
  });

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建' : '编辑'}${categoryTitle(category)}</h1>
      <a class="inline-link" href="${listHref}">← 返回列表</a>
    </div>
    <div class="card">
      ${form.html}
      <div class="row" style="margin-top:14px; gap:8px;">
        <button class="btn" id="save">${isNew?'创建':'保存'}</button>
        ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
      </div>
    </div>
  `;

  // The show/hide behaviour (启用提醒, 间隔天数, 阳历/农历, 农历月日) and
  // the lunar-anchor rules live in src/js/form_fields.js — the same module
  // the 快速记录 window uses, so the two forms cannot drift apart.
  const wired = wireEventForm(app, form.ids, form.theme);

  // Make the date / time / datetime-local inputs open their picker on click
  // of the whole input, not just the trailing icon.
  wireDateInputs(app);

  document.getElementById('save').onclick = async () => {
    const state = wired.read();
    // Tag kind comes from the 类型 dropdown. The dropdown includes an
    // "(无)" option that maps to null. Festival events are system-managed
    // and the dropdown is locked for them (see form HTML), so we just
    // preserve the existing tag_kind in that case.
    // For 工作事件 the dropdown is not rendered, so we keep the existing
    // tag_kind untouched on the server (typically null).
    let tagKind = ev.tag_kind || null;
    if (showTagKind && ev.tag_kind !== 'festival') {
      tagKind = state.tagKind || null;
    }
    const err = validateEventForm(state);
    if (err) { toast(err); return; }
    // Title is no longer on the form — the server auto-fills it from the
    // contact name (or a generic placeholder) on create, and falls back to
    // the existing title on update if the form somehow sends an empty value.
    // 工作事件没有关联联系人字段,提交时显式置 null,避免残留旧值。
    const input = eventPayload(state, {
      category,
      title: ev.title || '',
    });
    input.tag_kind = tagKind;
    if (!showContact) input.contact_id = null;
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

  // The contact picker and the photo block differ mechanically between the
  // main window and the 快速记录 window (this one also edits an existing
  // row and lists its already-uploaded photos), so they are supplied as
  // markup. Everything else comes from the shared builder.
  const contactPickerMarkup = `
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
  `;

  const memorialForm = buildMemorialForm({
    theme: MAIN_THEME,
    id: 'e',
    ev,
    contactPickerHtml: contactPickerMarkup,
    photoPickerHtml: '<div class="photo-preview" id="e-photo-preview"></div>',
    showPhotoExisting: !isNew,
    photoExistingHtml: '<div class="photo-existing" id="e-photo-existing"></div>',
  });

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建回忆事件' : '编辑回忆事件'}</h1>
      <a class="inline-link" href="${listHref}">← 返回列表</a>
    </div>
    <div class="card">
      ${memorialForm.html}
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
    const { error, payload } = readMemorialForm(app, memorialForm.ids);
    if (error) {
      toast(error);
      if (error === '请填写标题') document.getElementById('e-title').focus();
      return;
    }
    payload.contact_ids = Array.from(selectedIds);

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