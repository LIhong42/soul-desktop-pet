// src/js/pages/contact_list_edit.js — manage one list (likes / taboos / gifts)
// on a single contact. Add / edit / delete rows independently. Reached via
// `#/contacts/:id/:kind` where kind is 'likes' | 'taboos' | 'gifts'.
//
// Reads and writes go through the new contact_attributes table via
// `api.attributes.*` (kind is mapped from the URL's plural form to the
// single form stored in the DB).
import { api, escapeHtml, displayName, fmtDate, toast, todayYmd, wireDateInputs } from '../api.js';
import { register, navigate } from '../router.js';

const KIND_META = {
  likes:  { title: '喜好', singular: '喜好条目', attrKind: 'like' },
  taboos: { title: '忌讳', singular: '忌讳条目', attrKind: 'taboo' },
  gifts:  { title: '礼物参考', singular: '礼物条目', attrKind: 'gift' },
};

function renderRow(it) {
  const desc = escapeHtml(it.description || '');
  const date = it.event ? `<div class="meta">${escapeHtml(fmtDate(it.event))}</div>` : '';
  return `
    <div class="card list-item-row clickable attribute-clickable" data-id="${escapeHtml(it.id)}" style="cursor:pointer;">
      <div class="row between">
        <div style="flex:1; min-width:0;">
          <div class="lr-title-main">${desc}</div>
          ${date}
        </div>
      </div>
    </div>
  `;
}

// New-row form pinned at top: description input + date input + save button.
// Used both for "add new" and "edit existing" — `state.editingId` flips the
// submit label.
function renderEditForm(state, mode) {
  const editing = !!state.editingId;
  const title = editing ? '编辑条目' : '新增条目';
  const submitLabel = editing ? '保存' : '添加';
  return `
    <div class="card">
      <div class="section-header"><h2>${title}</h2></div>
      <div class="field">
        <label>描述 *</label>
        <input type="text" id="row-desc" placeholder="例如：抹茶甜点" value="${escapeHtml(state.draftDescription || '')}" autofocus/>
      </div>
      <div class="field">
        <label>事件（记录时间）</label>
        <input type="date" id="row-event" value="${escapeHtml(state.draftEvent || '')}"/>
      </div>
      <div class="row" style="margin-top:14px; gap:8px;">
        <button type="button" class="btn" id="row-save">${submitLabel}</button>
        ${editing ? '<button type="button" class="btn secondary" id="row-cancel">取消</button>' : ''}
      </div>
    </div>
  `;
}

async function render(args) {
  const meta = KIND_META[args.kind];
  if (!meta) {
    toast('未知列表类型');
    navigate('/contacts/' + args.id);
    return;
  }

  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const c = await api.contacts.get(args.id);

  // Local state for the form draft, in-progress edit, and the item list.
  // `items` is re-fetched via api.attributes.list after each mutation.
  const state = {
    editingId: null,
    draftDescription: '',
    draftEvent: todayYmd(),
    items: [],
  };

  async function refreshItems() {
    state.items = await api.attributes.list(meta.attrKind, { contact_id: c.id });
  }
  await refreshItems();

  function rerender() {
    app.innerHTML = `
      <div class="row between">
        <h1>${escapeHtml(meta.title)} · ${escapeHtml(displayName(c))}</h1>
        <div>
          <a class="back-link" href="#/contacts/${escapeHtml(c.id)}"><span class="icon-arrow-left"></span>返回详情</a>
        </div>
      </div>
      <div class="card">
        <div class="row" style="gap:24px">
          <div><div class="meta">联系人</div><a class="inline-link" href="#/contacts/${escapeHtml(c.id)}">${escapeHtml(displayName(c))}</a></div>
          ${c.relationship ? `<div><div class="meta">关系</div>${escapeHtml(c.relationship)}</div>` : ''}
          <div><div class="meta">条目数</div>${state.items.length}</div>
        </div>
      </div>

      ${renderEditForm(state)}

      <div class="section-header"><h2>已有${meta.title}（${state.items.length}）</h2></div>
      ${state.items.length === 0
        ? `<div class="empty">还没有${meta.title}条目 · 在上方表单中添加</div>`
        : state.items.map(renderRow).join('')}
    `;
    wireForm();
    wireRows();
  }

  function wireForm() {
    const desc = document.getElementById('row-desc');
    const ev = document.getElementById('row-event');
    const save = document.getElementById('row-save');
    const cancel = document.getElementById('row-cancel');
    if (state.editingId) {
      desc.value = state.draftDescription;
      ev.value = state.draftEvent;
    } else {
      desc.value = '';
      // New rows default to today's local date so the user gets a sensible
      // value without picking anything.
      ev.value = state.draftEvent || todayYmd();
    }
    save.onclick = async () => {
      const description = desc.value.trim();
      if (!description) { toast('请填写描述'); desc.focus(); return; }
      // Save-time backfill: empty event fields default to today's local date.
      const event = ev.value || todayYmd();
      try {
        if (state.editingId) {
          await api.attributes.update(state.editingId, { description, event });
          toast('已保存');
        } else {
          await api.attributes.create({
            contact_id: c.id,
            kind: meta.attrKind,
            description,
            event,
          });
          toast('已添加');
        }
      } catch (e) {
        toast('操作失败：' + (e.message || e));
        return;
      }
      state.editingId = null;
      state.draftDescription = '';
      state.draftEvent = todayYmd();
      await refreshItems();
      rerender();
    };
    if (cancel) {
      cancel.onclick = () => {
        state.editingId = null;
        state.draftDescription = '';
        state.draftEvent = todayYmd();
        rerender();
      };
    }
    // Make the date input open its picker on click of the whole box.
    wireDateInputs(document.getElementById('app'));
  }

  function wireRows() {
    // Click on a row navigates to the dedicated detail/edit page.
    app.querySelectorAll('.attribute-clickable').forEach((row) => {
      row.onclick = () => navigate('/attributes/' + row.dataset.id);
    });
  }

  rerender();
}

register('/contacts/:id/likes',  (args) => render({ ...args, kind: 'likes' }));
register('/contacts/:id/taboos', (args) => render({ ...args, kind: 'taboos' }));
register('/contacts/:id/gifts',  (args) => render({ ...args, kind: 'gifts' }));
