// src/js/pages/event_edit.js — create/edit events + event detail.
//
// Two distinct flows live behind the same route table:
//
//   1. Reminder-style events (category 'general' or 'work'). These keep the
//      legacy form: 类型 / 描述 / 关联联系人 (single) / 启用提醒 + 重复 / 阳
//      历 or 农历 / 日期 / 时间. They continue to be persisted via the
//      `events` table and the `api.events.*` namespace.
//
//      Work events have no page of their own — the 提醒 page's 类型 filter
//      lists them (see src/js/pages/events.js) — but they keep their own
//      form shape here: no 类型 dropdown and no 关联联系人 field.
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
import { applyBackground } from '../page_background.js';
import {
  MAIN_THEME,
  WORK_KIND,
  buildEventForm,
  wireEventForm,
  validateEventForm,
  eventPayload,
} from '../form_fields.js';

const CATEGORIES = ['general', 'memorial', 'work'];
const CATEGORY_TITLE = { general: '提醒', memorial: '回忆', work: '工作事件' };
// Where each category's list lives. Work events have no page of their own
// any more: they are the 工作事件 option of the 提醒 page's 类型 filter,
// so their "back to list" target is that page with the filter applied.
const CATEGORY_LIST_ROUTE = {
  general: '/reminders',
  memorial: '/events/memorial',
  work: '/reminders?tag_kind=work',
};

function resolveCategory(params) {
  const c = (params && params.category) || 'general';
  return CATEGORIES.includes(c) ? c : 'general';
}

function categoryTitle(c) { return CATEGORY_TITLE[c] || '提醒'; }
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

  // The page wears the same background artwork as the 提醒 page — the user
  // asked for it, and it is the same picture the list it belongs to wears,
  // so the form does not look like a different app.
  //
  // It is applied before the form renders so the page doesn't flash the
  // plain app surface first.
  await applyBackground();

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
  // The built-in festival catalog, for the 类型 dropdown's 节日 option. It
  // comes from the server because the catalog lives in main/festivals.js
  // and the two must not drift.
  const festivals = await api.events.listFestivals();
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
    festivals,
  });

  // The `bg-page` wrapper is what the background stylesheet scopes itself
  // to — it rebuilds the cards as translucent sheets of paper over the
  // artwork. The 提醒 page uses the same wrapper, so the two pages read
  // as one family.
  app.innerHTML = `
    <div class="bg-page">
      <div class="row between">
        <h1>${isNew ? '新建' : '编辑'}${categoryTitle(category)}</h1>
        <a class="back-link" href="${listHref}"><span class="icon-arrow-left"></span>返回列表</a>
      </div>
      <div class="card">
        ${form.html}
        <div class="row" style="margin-top:14px; gap:8px;">
          <button class="btn" id="save">${isNew?'创建':'保存'}</button>
          ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
        </div>
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
    // "(无)" option that maps to null.
    //
    // The dropdown ALSO carries the 工作 option, which is a category
    // rather than a tag kind: picking it moves the row into the 工作事件
    // list (category='work') with a null tag_kind. The form hides the
    // 关联联系人 field for it, because a work event has no contact.
    //
    // For 工作事件 the dropdown is not rendered, so we keep the existing
    // tag_kind untouched on the server (typically null).
    let tagKind = ev.tag_kind || null;
    if (showTagKind) {
      tagKind = state.tagKind || null;
    }
    // The category follows the dropdown: 工作 selects the work category,
    // every other option keeps the page's own category.
    const nextCategory = (showTagKind && state.work) ? WORK_KIND : category;
    const err = validateEventForm(state);
    if (err) { toast(err); return; }
    // Title is no longer on the form — the server derives it from the
    // contact and the 类型, so the client sends an empty title unless it
    // has a reason to send a specific one. 工作事件没有关联联系人字段,
    // 提交时显式置 null,避免残留旧值。
    //
    // A festival row is the one case where the title IS the festival code:
    // eventPayload puts the picked festival's code there, and the server
    // rejects a festival row whose title is not a built-in code.
    //
    // Switching 类型 AWAY from 节日 must clear that code, otherwise the row
    // would keep a festival code as its title while no longer being a
    // festival. So the title is emptied here and the server re-derives it.
    //
    // The same applies when the row moves between the work and reminder
    // categories: the label changes (a work row has no contact to derive
    // a name from), so the title is emptied and the server rebuilds it.
    const wasFestival = ev.tag_kind === 'festival';
    const isFestival = tagKind === 'festival';
    const wasWork = ev.category === WORK_KIND;
    let title = ev.title || '';
    if (wasFestival && !isFestival) title = '';
    if (wasWork !== (nextCategory === WORK_KIND)) title = '';
    const input = eventPayload(state, {
      category: nextCategory,
      title,
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
// Memorial events (回忆) have their own editor: the diary editor in
// src/js/pages/diary_edit.js. `renderEdit` redirects memorial routes
// there, so the old one-field-per-slot memorial form no longer lives in
// this file. The 提醒 / 工作事件 branches above are unchanged.

// /events/:id and /events/:id/edit both render the edit form. Clicking an
// event card from any list (or from contact_detail / search / today) lands
// directly on the edit page — no separate "编辑" button click needed.
// /events/new keeps its own route for the empty-form create case.
register('/events/new', renderEdit);
register('/events/:id/edit', renderEdit);
register('/events/:id', renderEdit);