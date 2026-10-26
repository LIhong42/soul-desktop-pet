// src/js/form_fields.js — shared form-field builders for the event and
// memorial forms.
//
// The main window (src/js/pages/event_edit.js) and the 快速记录 window
// (src/js/quick_record.js) present the SAME forms: the same fields, the
// same options, the same defaults, the same conditional-visibility rules
// and the same validation messages. Before this module existed that parity
// was maintained by hand in two places, so adding a field meant editing
// both — and forgetting one produced a window that silently disagreed with
// the other.
//
// This module is the single source of truth for that shared shape. It
// builds the markup and owns the behaviour; each window supplies its own
// id prefix and CSS class names so the rendered result still looks native
// to that window (the main window uses .field / .form-row / .meta, the
// quick-record window uses .qr-field / .qr-row / .qr-hint).
//
// What lives here:
//   * the field builders (event form, memorial form)
//   * the show/hide wiring (启用提醒, 间隔天数, 阳历/农历, lunar fields)
//   * the calendar-mode rules (which repeat kinds can carry a lunar anchor)
//   * the validation that both windows used to duplicate
//
// What does NOT live here: the actual save calls. Each window still owns
// its own submit handler, because they post to different places (the main
// window also supports editing an existing row, and the quick-record
// window only ever creates).

import { escapeHtml, displayName, todayYmd, nowDatetimeLocal } from './api.js';

// ---- Calendar-mode rules ------------------------------------------------
//
// A lunar anchor is only meaningful for the repeat kinds that fire on a
// calendar date. "每天" has no anchor at all, and the two stride-based
// kinds (每周 / 每 N 天) count days from an anchor date — a lunar anchor
// there would mean "every 7 lunar days", which the scheduler doesn't
// implement. Those three kinds therefore cannot use 农历.
//
// This rule used to be written twice (once per window), together with the
// two matching rejection messages. It is now defined once here and both
// windows read it.

// The repeat kinds that cannot carry a lunar anchor.
export const LUNAR_INCOMPATIBLE_KINDS = new Set(['daily', 'weekly', 'every_n_days']);

// Can this repeat kind carry a lunar (农历) anchor?
export function lunarAllowedFor(kind) {
  return !LUNAR_INCOMPATIBLE_KINDS.has(kind);
}

// The rejection message for a lunar anchor on an incompatible repeat kind.
// Returns null when the combination is fine.
export function lunarRejection(kind, mode) {
  if (mode !== 'lunar') return null;
  if (kind === 'daily') return '每天重复不支持农历日期';
  if (kind === 'weekly') return '每周重复不支持农历日期';
  if (kind === 'every_n_days') return '每 N 天重复不支持农历日期';
  return null;
}

// The label the date field carries for each repeat kind. The date means
// something different per repeat mode, so the label follows it.
export function dateLabelFor(kind) {
  switch (kind) {
    case 'one_time': return '日期';
    case 'yearly': return '周年日期';
    case 'monthly': return '每月几号';
    case 'weekly': return '起始日期（每周一次）';
    case 'every_n_days': return '起始日期';
    case 'daily': return '起始日期（可选）';
    default: return '日期';
  }
}

// 1-12 lunar months; the day range is intentionally wide (1-30) and
// validated server-side because whether day 30 exists depends on the
// year/month.
export const LUNAR_MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
export const LUNAR_DAY_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1);

// The repeat options, in the order both forms show them.
export const REPEAT_OPTIONS = [
  { value: 'one_time', label: '只一次' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'every_n_days', label: '每 N 天' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
];

// The 类型 (tag kind) options, minus 节日 — festivals are system-managed
// and can only be chosen from the festival library, never typed in.
export const TAG_KIND_OPTIONS = [
  { value: '', label: '(无)' },
  { value: 'birthday', label: '生日' },
  { value: 'anniversary', label: '纪念日' },
];

// ---- Style adapters -----------------------------------------------------
//
// The two windows spell their layout classes differently. A "theme" object
// carries the class names so the builders below can emit markup that
// matches whichever window is using them.

export const MAIN_THEME = {
  field: 'field',
  row: 'form-row',
  meta: 'meta',
  hidden: 'hidden',
  // A checkbox / radio control that sits inline with its label.
  inlineLabel: '',
  // The wrapper for a group of radio buttons.
  radioRow: 'row',
  // Class(es) added to a radio's wrapper when the radio is disabled. The
  // main window styles the disabled radio itself (input:disabled), so it
  // needs no extra class.
  disabledClass: '',
  disabledRadioClass: '',
};

export const QUICK_THEME = {
  field: 'qr-field',
  row: 'qr-row',
  meta: 'qr-hint',
  hidden: 'hidden',
  inlineLabel: 'qr-check',
  radioRow: 'qr-radios',
  // The quick-record theme marks a disabled radio's wrapper.
  disabledClass: 'disabled',
  disabledRadioClass: '',
};

// Build the markup for one labelled field.
function field(theme, label, inner, hint) {
  return `
    <div class="${theme.field}">
      <label>${escapeHtml(label)}</label>
      ${inner}
      ${hint ? `<div class="${theme.meta}">${escapeHtml(hint)}</div>` : ''}
    </div>
  `;
}

// Build a checkbox whose label sits next to the box (启用提醒).
function inlineCheckbox(theme, id, text, checked) {
  const cls = theme.inlineLabel ? ` class="${theme.inlineLabel}"` : '';
  return `
    <div class="${theme.field}">
      <label${cls}><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}/> ${escapeHtml(text)}</label>
    </div>
  `;
}

// Build a radio group (阳历 / 农历).
function radioGroup(theme, name, options, checkedValue) {
  const rows = options.map((o) => {
    const cls = theme.inlineLabel ? ` class="${theme.inlineLabel}"` : '';
    return `<label${cls}><input type="radio" name="${name}" value="${o.value}" ${o.value === checkedValue ? 'checked' : ''}/> ${escapeHtml(o.label)}</label>`;
  }).join('');
  const style = theme === MAIN_THEME ? ' style="gap:12px; align-items:center;"' : '';
  return `
    <div class="${theme.field}">
      <label>日期类型</label>
      <div class="${theme.radioRow}"${style}>${rows}</div>
    </div>
  `;
}

// ---- The event form (提醒日期 / 工作事件) --------------------------------
//
// Builds the 提醒日期 / 工作事件 form. `opts` describes the record being
// edited (or the blank defaults for a new one) and `cfg` describes how
// the surrounding window wants it rendered.
//
// The returned object carries the markup plus the ids and the initial
// values, so the caller can wire the behaviour with `wireEventForm`
// without having to re-derive any of it.
export function buildEventForm(opts = {}) {
  const {
    theme = MAIN_THEME,
    prefix = 'e',
    id = null,             // the id prefix actually in use ('e' / 'qr')
    showTagKind = true,
    showContact = true,
    ev = {},
    contacts = [],
  } = opts;
  const p = id || prefix;
  const t = theme;

  const initialCalMode = (ev.lunar_month && ev.lunar_day) ? 'lunar' : 'solar';
  const initialKind = ev.remind_kind || 'one_time';

  const tagKindOptions = TAG_KIND_OPTIONS.map((o) => {
    const sel = (ev.tag_kind || '') === o.value ? ' selected' : '';
    return `<option value="${o.value}"${sel}>${escapeHtml(o.label)}</option>`;
  }).join('');

  const repeatOptions = REPEAT_OPTIONS.map((o) => {
    const sel = o.value === initialKind ? ' selected' : '';
    return `<option value="${o.value}"${sel}>${escapeHtml(o.label)}</option>`;
  }).join('');

  const contactOptions = contacts.map((c) => {
    const sel = ev.contact_id === c.id ? ' selected' : '';
    return `<option value="${escapeHtml(c.id)}"${sel}>${escapeHtml(displayName(c))}</option>`;
  }).join('');

  const html = `
    ${showTagKind ? field(t, '类型', `
      <select id="${p}-tag-kind">
        ${tagKindOptions}
      </select>
    `) : ''}
    ${field(t, '描述', `<textarea id="${p}-desc">${escapeHtml(ev.description || '')}</textarea>`)}
    ${showContact ? field(t, '关联联系人（可选）', `
      <select id="${p}-contact">
        <option value="">(独立事件)</option>
        ${contactOptions}
      </select>
    `) : ''}
    ${inlineCheckbox(t, `${p}-remind`, '启用提醒', ev.remind !== false)}
    <div id="${p}-remind-fields"${ev.remind === false ? ' class="hidden"' : ''}>
      <div class="${t.row}">
        ${field(t, '重复', `
          <select id="${p}-kind">
            ${repeatOptions}
          </select>
        `)}
        <div class="${t.field} ${initialKind === 'every_n_days' ? '' : 'hidden'}" id="${p}-interval-field">
          <label>间隔天数</label>
          <input type="number" id="${p}-interval-days" min="1" max="365" value="${escapeHtml(String(ev.interval_days || 3))}"/>
          <div class="${t.meta}">每隔 N 天提醒一次（从起始日期算起）</div>
        </div>
        ${radioGroup(t, `${p}-cal-mode`, [{ value: 'solar', label: '阳历' }, { value: 'lunar', label: '农历' }], initialCalMode)}
      </div>
      <div id="${p}-solar-fields">
        ${field(t, '日期', `<input type="date" id="${p}-date" value="${escapeHtml(ev.remind_date || todayYmd())}"/>`)}
      </div>
      <div id="${p}-lunar-fields" class="${t.hidden}">
        <div class="${t.row}">
          ${field(t, '农历月', `
            <select id="${p}-lunar-month">
              ${LUNAR_MONTH_OPTIONS.map((m) => `<option value="${m}" ${ev.lunar_month === m ? 'selected' : ''}>${m} 月</option>`).join('')}
            </select>
          `)}
          ${field(t, '农历日', `
            <select id="${p}-lunar-day">
              ${LUNAR_DAY_OPTIONS.map((d) => `<option value="${d}" ${ev.lunar_day === d ? 'selected' : ''}>${d} 日</option>`).join('')}
            </select>
          `)}
        </div>
      </div>
      ${field(t, '提醒时间', `<input type="time" id="${p}-time" value="${escapeHtml(ev.remind_time || '09:00')}"/>`)}
    </div>
  `;

  return {
    html,
    // The theme travels with the ids so `wireEventForm` can style a
    // disabled radio the way this window expects, without the caller
    // having to pass it a second time.
    theme: t,
    ids: {
      tagKind: `${p}-tag-kind`,
      desc: `${p}-desc`,
      contact: `${p}-contact`,
      remind: `${p}-remind`,
      remindFields: `${p}-remind-fields`,
      kind: `${p}-kind`,
      intervalField: `${p}-interval-field`,
      intervalDays: `${p}-interval-days`,
      solarFields: `${p}-solar-fields`,
      lunarFields: `${p}-lunar-fields`,
      lunarMonth: `${p}-lunar-month`,
      lunarDay: `${p}-lunar-day`,
      date: `${p}-date`,
      time: `${p}-time`,
      calMode: `${p}-cal-mode`,
    },
  };
}

// ---- Wiring the event form's behaviour ----------------------------------
//
// Owns every show/hide rule of the event form:
//   * 启用提醒 hides the whole repeat / date / time group;
//   * the date label changes with the repeat kind;
//   * the 间隔天数 input appears only for "每 N 天";
//   * the lunar radio is disabled for the repeat kinds that have no
//     meaningful lunar anchor (每天 / 每周 / 每 N 天).
//
// `root` is the element the form was rendered into. `ids` comes from
// buildEventForm. Returns a small handle so the caller can read the
// current state without re-querying the DOM.
export function wireEventForm(root, ids, theme = MAIN_THEME) {
  const $ = (id) => root.querySelector('#' + id);
  const remindEl = $(ids.remind);
  const kindEl = $(ids.kind);
  const dateEl = $(ids.date);
  const intervalField = $(ids.intervalField);
  const remindFields = $(ids.remindFields);

  function toggleRemind() {
    if (remindFields) remindFields.classList.toggle('hidden', !remindEl.checked);
  }

  function toggleKind() {
    const k = kindEl.value;
    if (dateEl) {
      // The date field lives inside the solar field set, so it may be
      // absent from the DOM while the lunar mode is active.
      const label = dateEl.closest('.field, .qr-field')?.querySelector('label');
      if (label) label.textContent = dateLabelFor(k);
    }
    if (intervalField) intervalField.classList.toggle('hidden', k !== 'every_n_days');
  }

  function toggleCalMode() {
    const mode = root.querySelector(`input[name="${ids.calMode}"]:checked`)?.value || 'solar';
    const kind = kindEl.value;
    const noLunar = !lunarAllowedFor(kind);
    const solarFields = $(ids.solarFields);
    const lunarFields = $(ids.lunarFields);
    if (solarFields) solarFields.classList.toggle('hidden', mode !== 'solar');
    if (lunarFields) lunarFields.classList.toggle('hidden', mode !== 'lunar');
    const lunarRadio = root.querySelector(`input[name="${ids.calMode}"][value="lunar"]`);
    if (lunarRadio) {
      lunarRadio.disabled = noLunar;
      const wrap = lunarRadio.closest('label');
      if (wrap) {
        // The theme decides how a disabled radio is marked. The main window
        // has no such style, so its class is empty and the toggle is a
        // no-op there.
        if (theme.disabledClass) wrap.classList.toggle(theme.disabledClass, noLunar);
        if (theme.disabledRadioClass) wrap.classList.toggle(theme.disabledRadioClass, noLunar);
      }
      if (noLunar && lunarRadio.checked) {
        const solarRadio = root.querySelector(`input[name="${ids.calMode}"][value="solar"]`);
        if (solarRadio) solarRadio.checked = true;
        toggleCalMode();
      }
    }
  }

  if (remindEl) remindEl.onchange = toggleRemind;
  if (kindEl) kindEl.onchange = () => { toggleKind(); toggleCalMode(); };
  root.querySelectorAll(`input[name="${ids.calMode}"]`).forEach((el) => {
    el.addEventListener('change', toggleCalMode);
  });
  toggleRemind();
  toggleKind();
  toggleCalMode();

  return {
    // Read the current state of the form.
    read() {
      const mode = root.querySelector(`input[name="${ids.calMode}"]:checked`)?.value || 'solar';
      const kind = kindEl ? kindEl.value : 'one_time';
      return {
        mode,
        kind,
        remind: remindEl ? remindEl.checked : true,
        desc: ($(ids.desc)?.value || '').trim(),
        contactId: $(ids.contact)?.value || null,
        tagKind: $(ids.tagKind)?.value || null,
        date: $(ids.date)?.value || null,
        time: $(ids.time)?.value || '09:00',
        lunarMonth: $(ids.lunarMonth)?.value ? Number($(ids.lunarMonth).value) : null,
        lunarDay: $(ids.lunarDay)?.value ? Number($(ids.lunarDay).value) : null,
        intervalDays: $(ids.intervalDays)?.value,
      };
    },
  };
}

// ---- Validating an event form ------------------------------------------
//
// The checks both windows used to duplicate. Returns an error string, or
// null when the form is valid.
export function validateEventForm(state) {
  if (!state.desc) return '请填写描述';
  // A lunar anchor on a repeat kind that can't carry one. The UI already
  // prevents this (the radio is disabled and the mode resets to 阳历), so
  // this is the belt-and-braces check for the unreachable state — the same
  // guard the main window has always had.
  const reject = lunarRejection(state.kind, state.mode);
  if (reject) return reject;
  if (state.kind === 'every_n_days') {
    const n = Math.floor(Number(state.intervalDays));
    if (!Number.isFinite(n) || n < 1) return '间隔天数需要是大于 0 的整数';
  }
  return null;
}

// Build the payload for api.events.create / update from a validated form
// state. `category` decides which list the row lands in.
export function eventPayload(state, opts = {}) {
  const { category = 'general', title = '' } = opts;
  const payload = {
    title,
    description: state.desc,
    contact_id: state.contactId || null,
    remind: state.remind,
    remind_kind: state.kind,
    remind_time: state.time || '09:00',
    category,
    tag_kind: state.tagKind || null,
    advance_days: null,
  };
  if (state.kind === 'every_n_days') {
    payload.interval_days = Math.min(Math.floor(Number(state.intervalDays)), 365);
  } else {
    // The stride only applies to "每 N 天". Everything else stores null so
    // a stale value can't resurface if the user switches back and forth.
    payload.interval_days = null;
  }
  if (state.mode === 'lunar') {
    payload.lunar_month = state.lunarMonth;
    payload.lunar_day = state.lunarDay;
    // remind_date is not meaningful for a lunar anchor; the server uses
    // lunar_* to recompute next_fire_at on every save/tick.
    payload.remind_date = null;
  } else {
    payload.lunar_month = null;
    payload.lunar_day = null;
    payload.remind_date = state.date || null;
  }
  return payload;
}

// ---- The memorial form (回忆事件) ---------------------------------------
//
// Builds the 回忆事件 form. `opts.cb` supplies the contact picker markup
// and the photo picker markup, because those two differ in *mechanics*
// between the windows (the main window edits an existing row and shows
// the already-uploaded photos; the quick-record window only creates).
//
// The main window's memorial form:
//   类型 / 标题* / 去了哪里·吃了什么 / 关联人穿了什么·干了哪些事 /
//   其他补充描述 / 事件发生时间* / 关联联系人（多选）/ 照片（可选，多张）
export function buildMemorialForm(opts = {}) {
  const {
    theme = MAIN_THEME,
    id = 'e',
    ev = {},
    contactPickerHtml = '',
    photoPickerHtml = '',
    showPhotoExisting = false,
    photoExistingHtml = '',
  } = opts;
  const p = id;
  const t = theme;

  const occurredLocal = ev.occurred_at
    ? (ev.occurred_at.length >= 16 ? ev.occurred_at.slice(0, 16) : ev.occurred_at)
    : nowDatetimeLocal();

  const html = `
    ${field(t, '类型', `
      <select id="${p}-mem-kind">
        <option value="first_time" ${ev.kind === 'first_time' ? 'selected' : ''}>第一次</option>
        <option value="other"      ${ev.kind === 'other' || !ev.kind ? 'selected' : ''}>其他</option>
      </select>
    `)}
    ${field(t, '标题 *', `<input type="text" id="${p}-title" maxlength="120" value="${escapeHtml(ev.title || '')}" placeholder="例如：第一次去迪士尼" autofocus/>`)}
    ${field(t, '去了哪里 / 吃了什么', `
      <div class="${t.row}">
        <input type="text" id="${p}-place" maxlength="200" value="${escapeHtml(ev.place || '')}" placeholder="例如：西湖边的咖啡店"/>
        <input type="text" id="${p}-food" maxlength="200" value="${escapeHtml(ev.food || '')}" placeholder="例如：寿喜烧 + 提拉米苏"/>
      </div>
    `)}
    ${field(t, '关联人穿了什么 / 干了哪些事', `
      <div class="${t.row}">
        <input type="text" id="${p}-outfit" maxlength="200" value="${escapeHtml(ev.outfit || '')}" placeholder="例如：她穿了一件红色连衣裙"/>
        <input type="text" id="${p}-activities" maxlength="200" value="${escapeHtml(ev.activities || '')}" placeholder="例如：看了日落 / 骑了双人自行车"/>
      </div>
    `)}
    ${field(t, '其他补充描述', `<textarea id="${p}-notes" rows="3" placeholder="其他想记住的细节…">${escapeHtml(ev.notes || '')}</textarea>`)}
    ${field(t, '事件发生时间 *', `<input type="datetime-local" id="${p}-occurred" value="${escapeHtml(occurredLocal)}"/>`)}
    ${field(t, '关联联系人（可选，可不选；点击勾选或取消）', contactPickerHtml)}
    ${field(t, '照片（可选，可上传多张）', `
      <input type="file" id="${p}-photos" accept="image/*" multiple/>
      ${photoPickerHtml}
    `)}
    ${showPhotoExisting ? field(t, '已上传的照片', photoExistingHtml) : ''}
  `;

  return {
    html,
    ids: {
      // Deliberately not `${p}-kind`: the event form already uses that id for
      // the repeat mode. Two builders sharing an id makes the ids ambiguous
      // to whoever wires the form later.
      kind: `${p}-mem-kind`,
      title: `${p}-title`,
      place: `${p}-place`,
      food: `${p}-food`,
      outfit: `${p}-outfit`,
      activities: `${p}-activities`,
      notes: `${p}-notes`,
      occurred: `${p}-occurred`,
      photos: `${p}-photos`,
    },
  };
}

// Read + validate a memorial form. Returns { error, payload }.
export function readMemorialForm(root, ids) {
  const $ = (id) => root.querySelector('#' + id);
  const title = ($(ids.title)?.value || '').trim();
  if (!title) return { error: '请填写标题', payload: null };
  const occurredRaw = $(ids.occurred)?.value;
  if (!occurredRaw) return { error: '请填写事件发生时间', payload: null };
  // datetime-local gives 'YYYY-MM-DDTHH:MM'; the backend wants
  // 'YYYY-MM-DD HH:MM:SS'.
  const payload = {
    kind: $(ids.kind)?.value || 'other',
    title,
    place:      ($(ids.place)?.value || '').trim() || null,
    food:       ($(ids.food)?.value || '').trim() || null,
    outfit:     ($(ids.outfit)?.value || '').trim() || null,
    activities: ($(ids.activities)?.value || '').trim() || null,
    notes:      ($(ids.notes)?.value || '').trim() || null,
    occurred_at: occurredRaw.replace('T', ' ') + ':00',
  };
  return { error: null, payload };
}
