// src/js/pages/event_edit.js — create/edit events + event detail.
//
// Two distinct flows live behind the same route table:
//
//   1. Reminder-style events (category 'general' or 'work'). These keep the
//      legacy form: 类型 / 描述 / 关联联系人 (single) / 启用提醒 + 重复 / 阳
//      历 or 农历 / 日期 / 时间. They continue to be persisted via the
//      `events` table and the `api.events.*` namespace.
//
//   2. Memorial events (category 'memorial'). These live in the
//      `memorial_events` table and are edited by the diary editor
//      (src/js/pages/diary_edit.js) — a full page where the user writes
//      free-form text, adds photos and picks one of six background
//      styles, then tags the entry on save. Memorial routes therefore
//      redirect out of this file.
//
// The branch is decided at the top of `renderEdit` based on the URL's
// ?category=… param.
import { api, toast, todayYmd, wireDateInputs } from '../api.js';
import { register, navigate, getReferrerPath } from '../router.js';
import {
  MAIN_THEME,
  buildEventForm,
  wireEventForm,
  validateEventForm,
  eventPayload,
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
  // Memorial events live in their own table and use their own editor.
  // The diary editor (src/js/pages/diary_edit.js) replaced the old
  // one-field-per-slot form, so memorial links point there instead of
  // rendering a form on this page.
  const category = resolveCategory(params);
  if (category === 'memorial') {
    const q = params.contact_id ? '?contact_id=' + encodeURIComponent(params.contact_id) : '';
    navigate(args.id ? '/diary/' + encodeURIComponent(args.id) + q : '/diary/new' + q);
    return;
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

// ---- Memorial events ----
//
// Memorial events (回忆事件) have their own editor: the diary editor in
// src/js/pages/diary_edit.js. `renderEdit` redirects memorial routes
// there, so the old one-field-per-slot memorial form no longer lives in
// this file. The 提醒日期 / 工作事件 branches above are unchanged.

// /events/:id and /events/:id/edit both render the edit form. Clicking an
// event card from any list (or from contact_detail / search / today) lands
// directly on the edit page — no separate "编辑" button click needed.
// /events/new keeps its own route for the empty-form create case.
register('/events/new', renderEdit);
register('/events/:id/edit', renderEdit);
register('/events/:id', renderEdit);