// src/js/quick_record.js — the 快速记录 window's renderer.
//
// Opened from the pet's right-click menu → 📝 记录. The user picks a
// record kind, fills a short form, and it is saved through the SAME ipcMain
// handlers the main window uses (attributes:create / events:create /
// memorial_events:create) — so validation, search indexing and bond
// tracking stay in one place and both windows agree on what a valid record
// is.
//
// The forms are FIELD-FOR-FIELD the same as the main window's
// (src/js/pages/attributes.js and src/js/pages/event_edit.js): the same
// fields, the same options, the same validation rules and the same
// conditional-visibility behaviour. A record captured here is
// indistinguishable from one captured in the main window.
//
// This window is NOT behind the PIN. That is the whole point: the user can
// jot something down without unlocking the main window. It deliberately
// exposes no browsing/listing surface — write-only, so it can't be used to
// peek at the data the PIN protects.
import { api, escapeHtml, displayName, todayYmd, wireDateInputs } from './api.js';
import {
  QUICK_THEME,
  buildEventForm,
  wireEventForm,
  validateEventForm,
  eventPayload,
  buildMemorialForm,
  readMemorialForm,
} from './form_fields.js';

const M = window.mp;

// ---- Record kinds -------------------------------------------------------
//
// Mirrors main/quick_record.js's RECORD_KINDS. The renderer asks the main
// process which kind to open (via `M.quickRecord.getKind()`); the table
// below supplies the label, icon, tint and form to render for it.
const KINDS = {
  like: {
    label: '喜好', icon: '💖', tint: 'var(--cat-like)',
    hint: '他喜欢的东西',
  },
  taboo: {
    label: '忌讳', icon: '🚫', tint: 'var(--cat-taboo)',
    hint: '不能碰的地方',
  },
  gift: {
    label: '礼物', icon: '🎁', tint: 'var(--cat-gift)',
    hint: '送过 / 想送的东西',
  },
  reminder: {
    label: '提醒日期', icon: '⏰', tint: 'var(--cat-general)',
    hint: '到点提醒我一件事',
  },
  memorial: {
    label: '回忆事件', icon: '🎞️', tint: 'var(--cat-memorial)',
    hint: '值得记住的一刻',
  },
  work: {
    label: '工作事件', icon: '💼', tint: 'var(--cat-work)',
    hint: '工作上的安排',
  },
};

// 1-12 lunar months; the day range is intentionally wide (1-30) and
// validated server-side because whether day 30 exists depends on the
// year/month. Same constants as src/js/pages/event_edit.js.
const LUNAR_MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const LUNAR_DAY_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1);

const pickerEl = document.getElementById('qr-picker');
const formEl = document.getElementById('qr-form');
const msgEl = document.getElementById('qr-msg');
const iconEl = document.getElementById('qr-icon');
const titleEl = document.getElementById('qr-title');
const subEl = document.getElementById('qr-sub');

// The kind currently being recorded, and the contacts loaded for it.
let currentKind = null;
let contacts = [];

// Handles returned by the shared form helpers (src/js/form_fields.js) for
// the form currently on screen. `eventWiring.read()` returns the live
// state of the 提醒日期 / 工作事件 form; `memorialIds` locates the 回忆事件
// fields. Both are null when a different kind is showing.
let eventWiring = null;
let memorialIds = null;

// ---- Small helpers ------------------------------------------------------

function say(text, kind) {
  msgEl.textContent = text || '';
  msgEl.className = 'qr-msg' + (kind ? ' ' + kind : '');
}

// Set the window's tint to the kind's colour. The tile / icon / header all
// read --qr-tint, so one write recolours the whole panel.
function applyTint(tint) {
  document.documentElement.style.setProperty('--qr-tint', tint || 'var(--accent)');
}

// The contact picker is a chip list rather than a <select>: the user can
// see who they already have at a glance, and one click picks them. The
// selected ids live in a Set so the chip list can be re-rendered freely.
const selectedContacts = new Set();

function contactPickerHtml() {
  if (contacts.length === 0) {
    return `<div class="qr-contacts-empty">还没有联系人。请先在主窗口添加联系人后再记录喜好 / 忌讳 / 礼物。</div>`;
  }
  return contacts.map((c) => `
    <button type="button" class="qr-chip${selectedContacts.has(c.id) ? ' selected' : ''}" data-id="${escapeHtml(c.id)}">
      ${escapeHtml(displayName(c))}
    </button>
  `).join('');
}

function wireContactPicker() {
  const box = formEl.querySelector('.qr-contacts');
  if (!box) return;
  box.querySelectorAll('.qr-chip').forEach((chip) => {
    chip.onclick = () => {
      const id = chip.dataset.id;
      if (!id) return;
      if (selectedContacts.has(id)) selectedContacts.delete(id);
      else selectedContacts.add(id);
      chip.classList.toggle('selected');
      refreshContactCount();
    };
  });
  // The toolbar (全选 / 清空) mirrors the main window's memorial contact
  // picker. It is optional chrome — the toolbar row is only rendered for
  // the multi-select forms (回忆事件) — so every lookup is guarded.
  const allBtn = formEl.querySelector('.qr-picker-all');
  if (allBtn) {
    allBtn.onclick = () => {
      contacts.forEach((c) => selectedContacts.add(c.id));
      formEl.querySelectorAll('.qr-chip').forEach((chip) => {
        if (chip.dataset.id) chip.classList.add('selected');
      });
      refreshContactCount();
    };
  }
  const noneBtn = formEl.querySelector('.qr-picker-none');
  if (noneBtn) {
    noneBtn.onclick = () => {
      selectedContacts.clear();
      formEl.querySelectorAll('.qr-chip').forEach((chip) => chip.classList.remove('selected'));
      refreshContactCount();
    };
  }
  refreshContactCount();
}

// Keep the "已选 N 人" label in sync with the selection.
function refreshContactCount() {
  const el = formEl.querySelector('.qr-count');
  if (!el) return;
  el.textContent = selectedContacts.size === 0 ? '未选' : `已选 ${selectedContacts.size} 人`;
}

// Pick the FIRST contact by default for the kinds that require exactly one.
// The user can switch to another with one click. Choosing nothing is
// rejected on save with a clear message rather than silently dropping the
// record.
function defaultContactId() {
  return contacts.length ? contacts[0].id : '';
}

function field(label, inner, hint) {
  return `
    <div class="qr-field">
      <label>${escapeHtml(label)}</label>
      ${inner}
      ${hint ? `<div class="qr-hint">${escapeHtml(hint)}</div>` : ''}
    </div>
  `;
}

// ---- Type picker --------------------------------------------------------

function renderPicker() {
  pickerEl.innerHTML = Object.entries(KINDS).map(([id, k]) => `
    <button type="button" class="qr-tile" data-kind="${id}" style="--qr-tint:${k.tint}">
      <span class="qr-tile-emoji">${k.icon}</span>
      <span>
        <div class="qr-tile-label">${escapeHtml(k.label)}</div>
        <div class="qr-tile-hint">${escapeHtml(k.hint)}</div>
      </span>
    </button>
  `).join('');
  pickerEl.querySelectorAll('.qr-tile').forEach((tile) => {
    tile.onclick = () => openKind(tile.dataset.kind);
  });
}

// ---- Per-kind forms ----------------------------------------------------
//
// Every form below mirrors the corresponding main-window form field for
// field (src/js/pages/attributes.js, src/js/pages/event_edit.js):
// the same labels, the same options, the same defaults, and the same
// conditional visibility.

// 喜好 / 忌讳 / 礼物 — all three are contact_attributes rows, differing only
// in their `kind` column. One form serves all three.
//
// Main window (src/js/pages/attributes.js renderForm): 描述* / 事件（记录时间）/
// 联系人*.
function attributeForm(kindId) {
  const k = KINDS[kindId];
  return `
    ${field('描述 *', `<input type="text" id="qr-desc" maxlength="200" placeholder="例如：抹茶甜点" autofocus/>`)}
    ${field('事件（记录时间）', `<input type="date" id="qr-event" value="${escapeHtml(todayYmd())}"/>`)}
    ${field('联系人 *', `<div class="qr-contacts">${contactPickerHtml()}</div>`)}
    <div class="qr-actions">
      <button type="submit" class="qr-btn">保存</button>
      <button type="button" class="qr-btn secondary" id="qr-back">返回</button>
    </div>
  `;
}

// 提醒日期 / 工作事件 — both are rows in the `events` table, differing in
// their `category` column ('general' vs 'work'). The work category drops
// the 类型 and 关联联系人 fields, matching the main window's form.
//
// The markup and the show/hide behaviour come from src/js/form_fields.js —
// the same module the main window's form uses, so the two cannot drift
// apart. Only the id prefix and the CSS classes differ.
function eventForm(kindId) {
  const isWork = kindId === 'work';
  const form = buildEventForm({
    theme: QUICK_THEME,
    id: 'qr',
    showTagKind: !isWork,
    showContact: !isWork,
    ev: {
      remind: true,
      remind_kind: 'one_time',
      remind_time: '09:00',
      remind_date: todayYmd(),
      lunar_month: null,
      lunar_day: null,
      tag_kind: null,
      interval_days: null,
    },
    contacts,
  });
  form.html += `
    <div class="qr-actions">
      <button type="submit" class="qr-btn">保存</button>
      <button type="button" class="qr-btn secondary" id="qr-back">返回</button>
    </div>
  `;
  return form;
}

// 回忆事件 — a memorial_events row.
//
// The markup comes from src/js/form_fields.js, the same module the main
// window's memorial form uses. The contact picker is supplied as markup
// because the two windows use different picker widgets (chips here, cards
// in the main window) — but the fields themselves are shared.
//
// The photo picker is the one place this window differs mechanically from
// the main window: photos have to be uploaded AFTER the event row exists
// (the upload needs the event id), so the files are picked here and
// uploaded once the create call returns.
function memorialForm() {
  const contactPickerMarkup = `
    <div class="qr-picker-toolbar">
      <button type="button" class="qr-tiny-btn qr-picker-all">全选</button>
      <button type="button" class="qr-tiny-btn qr-picker-none">清空</button>
      <span class="qr-count"></span>
    </div>
    <div class="qr-contacts">${contactPickerHtml()}</div>
  `;
  const form = buildMemorialForm({
    theme: QUICK_THEME,
    // A distinct id prefix: the window's own chrome already owns "qr-title"
    // (the header) and "qr-kind" (nothing yet, but the event form has it),
    // and the form's fields would shadow the header if they shared a name.
    id: 'qrm',
    ev: { kind: 'other' },
    contactPickerHtml: contactPickerMarkup,
    photoPickerHtml: '<div class="qr-photo-preview" id="qr-photo-preview"></div>',
  });
  form.html += `
    <div class="qr-actions">
      <button type="submit" class="qr-btn">保存</button>
      <button type="button" class="qr-btn secondary" id="qr-back">返回</button>
    </div>
  `;
  return form;
}

// ---- Open a kind --------------------------------------------------------

async function openKind(kindId) {
  const k = KINDS[kindId];
  if (!k) return;
  currentKind = kindId;
  selectedContacts.clear();
  say('');
  revokePendingPhotoUrls();

  // Load the contacts up front — the picker is needed by four of the six
  // forms, and fetching here (rather than per-form) keeps the switch
  // instant.
  try {
    contacts = await api.contacts.list();
  } catch (e) {
    contacts = [];
    say('联系人读取失败：' + ((e && e.message) || e), 'error');
  }

  applyTint(k.tint);
  iconEl.textContent = k.icon;
  titleEl.textContent = `记录 · ${k.label}`;
  subEl.textContent = k.hint;

  if (kindId === 'like' || kindId === 'taboo' || kindId === 'gift') {
    formEl.innerHTML = attributeForm(kindId);
  } else if (kindId === 'reminder' || kindId === 'work') {
    const form = eventForm(kindId);
    formEl.innerHTML = form.html;
    // The shared wiring owns the show/hide rules (启用提醒, 间隔天数,
    // 阳历/农历, 农历月日) — the same rules the main window's form uses.
    eventWiring = wireEventForm(formEl, form.ids, form.theme);
  } else {
    const form = memorialForm();
    formEl.innerHTML = form.html;
    memorialIds = form.ids;
  }

  pickerEl.classList.add('hidden');
  formEl.classList.remove('hidden');
  wireContactPicker();
  // The date / time / datetime-local inputs open their native picker when
  // the whole box is clicked, not only the trailing icon.
  wireDateInputs(formEl);

  const back = document.getElementById('qr-back');
  if (back) back.onclick = showPicker;

  if (kindId === 'memorial') {
    wirePhotoPicker();
  }

  // Pre-select the first contact for the kinds that need exactly one, so
  // the common case is a single click on 保存.
  if (kindId === 'like' || kindId === 'taboo' || kindId === 'gift') {
    const first = defaultContactId();
    if (first) selectedContacts.add(first);
    const chips = formEl.querySelectorAll('.qr-chip');
    chips.forEach((chip) => {
      if (chip.dataset.id === first) chip.classList.add('selected');
    });
    refreshContactCount();
  }

  formEl.onsubmit = (e) => { e.preventDefault(); save(kindId); };
}

// ---- Photo picker (回忆事件) -------------------------------------------
//
// The picked files are previewed locally (object URLs) so the user can
// confirm them before saving. The actual upload happens after the event
// row is created, because the upload endpoint needs the event id.
const pendingPhotoFiles = [];
let pendingPhotoUrls = [];

function revokePendingPhotoUrls() {
  for (const u of pendingPhotoUrls) URL.revokeObjectURL(u);
  pendingPhotoUrls = [];
  pendingPhotoFiles.length = 0;
}

function wirePhotoPicker() {
  if (!memorialIds) return;
  const input = document.getElementById(memorialIds.photos);
  const preview = document.getElementById('qr-photo-preview');
  if (!input || !preview) return;

  input.onchange = () => {
    // Drop the previous batch's previews before rendering the new one.
    for (const u of pendingPhotoUrls) URL.revokeObjectURL(u);
    pendingPhotoUrls = [];
    pendingPhotoFiles.length = 0;
    preview.innerHTML = '';

    const files = Array.from(input.files || []);
    for (const f of files) {
      const url = URL.createObjectURL(f);
      pendingPhotoUrls.push(url);
      pendingPhotoFiles.push(f);
      const div = document.createElement('div');
      div.className = 'qr-photo-item';
      const img = document.createElement('img');
      img.src = url;
      img.alt = f.name;
      div.appendChild(img);
      preview.appendChild(div);
    }
  };
}

function showPicker() {
  currentKind = null;
  selectedContacts.clear();
  revokePendingPhotoUrls();
  formEl.classList.add('hidden');
  formEl.innerHTML = '';
  pickerEl.classList.remove('hidden');
  applyTint('var(--accent)');
  iconEl.textContent = '📝';
  titleEl.textContent = '快速记录';
  subEl.textContent = '选择要记录的类型';
  say('');
}

// ---- Save ---------------------------------------------------------------

async function save(kindId) {
  const btn = formEl.querySelector('.qr-btn:not(.secondary)');
  if (btn) btn.disabled = true;
  try {
    if (kindId === 'like' || kindId === 'taboo' || kindId === 'gift') {
      await saveAttribute(kindId);
    } else if (kindId === 'reminder' || kindId === 'work') {
      await saveEvent(kindId);
    } else {
      await saveMemorial();
    }
  } catch (e) {
    say('保存失败：' + ((e && e.message) || e), 'error');
    if (btn) btn.disabled = false;
  }
}

// 喜好 / 忌讳 / 礼物 → contact_attributes.
//
// The contact is REQUIRED here, matching the main window's attributes form
// (the column is NOT NULL with a foreign key). We reject the save with a
// message rather than letting the server throw, so the user gets a hint
// instead of an error string.
async function saveAttribute(kindId) {
  const desc = (document.getElementById('qr-desc').value || '').trim();
  if (!desc) { say('请填写描述', 'error'); return; }
  if (selectedContacts.size === 0) {
    say('请选择联系人', 'error');
    return;
  }
  const event = document.getElementById('qr-event').value || todayYmd();
  await api.attributes.create({
    contact_id: Array.from(selectedContacts)[0],
    kind: kindId,
    description: desc,
    event,
  });
  await done(`已记录${KINDS[kindId].label}`);
}

// 提醒日期 / 工作事件 → the `events` table.
//
// Mirrors the main window's save handler (src/js/pages/event_edit.js):
// the repeat kind lives in `remind_kind`, the anchor date in `remind_date`,
// and a lunar anchor lives in `lunar_month` / `lunar_day` (in which case
// `remind_date` is null and the server recomputes next_fire_at from the
// lunar pair).
async function saveEvent(kindId) {
  const isWork = kindId === 'work';
  const state = eventWiring.read();

  // The validation (empty description, a lunar anchor on a repeat kind
  // that can't carry one, a bad interval) lives in the shared module, so
  // this window and the main window reject exactly the same inputs with
  // exactly the same wording.
  const err = validateEventForm(state);
  if (err) { say(err, 'error'); return; }

  // The main window leaves the title empty and lets the server derive it
  // from the contact name (e.g. "小李的生日"). Only 工作事件 — which has
  // no contact field at all — sends the description as the title.
  const payload = eventPayload(state, {
    category: isWork ? 'work' : 'general',
    title: isWork ? state.desc : '',
  });
  if (isWork) {
    payload.contact_id = null;
    payload.tag_kind = null;
  }

  await api.events.create(payload);
  await done(`已记录${KINDS[kindId].label}`);
}

// 回忆事件 → memorial_events.
async function saveMemorial() {
  // The shared reader owns the field names and the validation, so this
  // window and the main window accept exactly the same inputs.
  const { error, payload } = readMemorialForm(formEl, memorialIds);
  if (error) { say(error, 'error'); return; }
  payload.contact_ids = Array.from(selectedContacts);

  const saved = await api.memorialEvents.create(payload);

  // Photos are uploaded after the row exists — the upload endpoint needs
  // the event id. A failed photo does not roll back the event (the main
  // window behaves the same way): we surface a summary count instead.
  const files = pendingPhotoFiles.slice();
  if (files.length) {
    let okCount = 0;
    let failCount = 0;
    for (const f of files) {
      // Defensive size cap. Skip with a clear message rather than ship a
      // multi-megabyte blob through IPC silently.
      if (f.size > 20 * 1024 * 1024) {
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
    if (failCount > 0) {
      await done(`已记录回忆事件（${okCount} 张照片，${failCount} 张失败）`);
      return;
    }
    await done(`已记录回忆事件（${okCount} 张照片）`);
    return;
  }

  await done('已记录回忆事件');
}

// Report success and reset the form. The window STAYS OPEN (rather than
// closing) so the user can log several things in a row — the point of the
// quick-capture flow is speed, and re-opening from the pet menu for each
// entry would undo that. The message line confirms what was saved.
async function done(text) {
  say(text, 'ok');
  formEl.reset();
  selectedContacts.clear();
  // Re-render the form so the contact chips reset their "selected" state
  // and the date / time inputs go back to their defaults.
  await openKind(currentKind);
  say(text, 'ok');
}

// ---- Init ---------------------------------------------------------------

renderPicker();

// Ask the main process which kind to open. This is a pull rather than a
// push: the renderer is an ES module, so a message pushed on
// `did-finish-load` could arrive before `on(...)` had registered and would
// be dropped. Asking once the module has finished booting has no such
// race.
//
// Until the answer arrives the type picker is shown, so the window is
// usable even if it was opened without a specific kind in mind.
(async () => {
  if (!M || !M.quickRecord) return;
  try {
    const kindId = await M.quickRecord.getKind();
    if (kindId && KINDS[kindId]) await openKind(kindId);
  } catch (e) {
    console.error('[quick-record] getKind failed', e);
  }
})();
