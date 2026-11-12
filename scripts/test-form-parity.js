// scripts/test-form-parity.js — proves the main window and the 快速记录
// window render the SAME form, and that the shared module owns the rules.
//
// The user's requirement: "请注意快速记录的表单应该和主窗口一致" and later
// "以后加字段只改一处". This script guards both halves:
//
//   1. Parity — the two windows' forms have the same fields, the same
//      labels, the same options and the same defaults. A field added to
//      one and forgotten in the other fails here.
//   2. Single source of truth — the lunar-disable rule and its rejection
//      messages live in src/js/form_fields.js and are exercised through
//      BOTH windows' wiring, so neither can drift.
//
// It builds the forms with the real builders in a real DOM (a hidden
// BrowserWindow), then compares the two renderings field by field.
//
// Run: node scripts/run-electron.js scripts/test-form-parity.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// Run a snippet inside the page and resolve with its result.
//
// The snippet must `return` its value. Electron's `executeJavaScript`
// hands back the completion value of the script, which is dropped for a
// bare parenthesised expression — so the value is wrapped explicitly.
const evalIn = (win, code) =>
  win.webContents.executeJavaScript(
    `(async () => { try { ${code} } catch (e) { return { __threw: String(e && e.stack || e) }; } })()`,
    true);


// Describe a rendered form: for every field, its label and the control's
// tag / options / value. Two forms are "the same form" when these match.
//
// NOTE: the IIFE must start on the SAME LINE as the `return` that
// interpolates it. `return` followed by a newline is an automatic
// semicolon insertion — the caller would get `undefined` and the IIFE
// would run as a stray statement.
const DESCRIBE = `(function() {
    const root = document.getElementById('probe');
    const out = [];
    root.querySelectorAll('.field, .qr-field').forEach(f => {
      const label = f.querySelector('label')?.textContent?.trim() || '';
      const ctrl = f.querySelector('select, input, textarea');
      if (!ctrl) { out.push({ label, control: null }); return; }
      const entry = { label, control: ctrl.tagName.toLowerCase() };
      if (ctrl.tagName === 'SELECT') {
        entry.options = Array.from(ctrl.options).map(o => o.value + '=' + o.textContent.trim());
      } else {
        entry.type = ctrl.type;
        entry.value = ctrl.value;
      }
      out.push(entry);
    });
    return out;
  })()`;

// The options a caller passes to buildEventForm in both windows.
const EV_OPTS = `
  ev: { remind: true, remind_kind: 'one_time', remind_time: '09:00',
        remind_date: '2026-10-27', lunar_month: null, lunar_day: null,
        tag_kind: null, interval_days: null },
  contacts: [{ id: 1, name: '小李', nickname: '', relationship: '同事' }],
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('  [page error]', message);
  });

  // The page has to be served from the project directory: a `data:` URL
  // cannot import a `file://` module (the import would be cross-origin and
  // never settle).
  const probePath = path.join(__dirname, '..', 'src', '.form-parity-probe.html');
  fs.writeFileSync(probePath,
    '<!doctype html><html><body><div id="probe"></div>' +
    '<script type="module">import * as m from "./js/form_fields.js";' +
    'window.__m = m; window.__ready = true;</script></body></html>');
  await win.loadFile(probePath);
  await evalIn(win, `
    await new Promise(res => {
      const t = setInterval(() => { if (window.__ready) { clearInterval(t); res(true); } }, 10);
    });
    return true;
  `);
  const diag = await evalIn(win, `
    return { hasM: typeof window.__m, ready: !!window.__ready,
             keys: window.__m ? Object.keys(window.__m).length : -1 };
  `);
  if (!diag || !diag.ready || !diag.keys) {
    console.log('  FAIL the shared form module did not load', JSON.stringify(diag));
    fail++;
  }

  // ---- Build both windows' event forms --------------------------------
  console.log('\n== 事件表单：主窗口 vs 快速记录 ==');

  const mainEvent = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.MAIN_THEME, id: 'e', showTagKind: true, showContact: true,
      ${EV_OPTS}
    });
    document.getElementById('probe').innerHTML = f.html;
    return ${DESCRIBE};
  `);

  const quickEvent = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.QUICK_THEME, id: 'qr', showTagKind: true, showContact: true,
      ${EV_OPTS}
    });
    document.getElementById('probe').innerHTML = f.html;
    return ${DESCRIBE};
  `);

  check('the two event forms have the same number of fields',
    quickEvent.length, mainEvent.length);
  check('the two event forms are field-for-field identical',
    quickEvent, mainEvent);

  // The working event form (工作事件) drops the contact and the 类型
  // dropdown — both windows must drop them the same way.
  const mainWork = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.MAIN_THEME, id: 'e', showTagKind: false, showContact: false,
      ev: { remind: true, remind_kind: 'one_time' }, contacts: [],
    });
    document.getElementById('probe').innerHTML = f.html;
    return ${DESCRIBE};
  `);
  const quickWork = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.QUICK_THEME, id: 'qr', showTagKind: false, showContact: false,
      ev: { remind: true, remind_kind: 'one_time' }, contacts: [],
    });
    document.getElementById('probe').innerHTML = f.html;
    return ${DESCRIBE};
  `);
  check('the two work-event forms are identical too', quickWork, mainWork);
  checkTrue('the work-event form has no contact field',
    !mainWork.some((f) => f.label.includes('关联联系人')),
    JSON.stringify(mainWork.map((f) => f.label)));

  // ---- The shared rules ------------------------------------------------
  console.log('\n== 共享规则：农历禁用 ==');

  // The disable rule must be the same in both windows, for the same
  // repeat kinds, with the same rejections.
  for (const kind of ['daily', 'weekly', 'every_n_days']) {
    const results = await evalIn(win, `
      const m = window.__m;
      const out = {};
      for (const [name, t, p] of [['main', m.MAIN_THEME, 'e'], ['quick', m.QUICK_THEME, 'qr']]) {
        const f = m.buildEventForm({
          theme: t, id: p, showTagKind: true, showContact: true,
          ev: { remind: true, remind_kind: 'one_time', remind_time: '09:00' },
          contacts: [{ id: 1, name: '小李' }],
        });
        const root = document.createElement('div');
        root.innerHTML = f.html;
        document.getElementById('probe').innerHTML = '';
        document.getElementById('probe').appendChild(root);
        m.wireEventForm(root, f.ids, t);
        const kindEl = root.querySelector('#' + p + '-kind');
        kindEl.value = ${JSON.stringify(kind)};
        kindEl.dispatchEvent(new Event('change'));
        const lunar = root.querySelector('input[name="' + p + '-cal-mode"][value="lunar"]');
        const mode = root.querySelector('input[name="' + p + '-cal-mode"]:checked')?.value;
        out[name] = { disabled: !!lunar?.disabled, mode };
      }
      return out;
    `);
    check('the lunar radio is disabled for ' + kind + ' (main window)',
      results.main.disabled, true);
    check('the lunar radio is disabled for ' + kind + ' (quick record)',
      results.quick.disabled, true);
    check('the mode falls back to 阳历 for ' + kind + ' (both windows)',
      [results.main.mode, results.quick.mode], ['solar', 'solar']);
  }

  // A lunar anchor stays available for the kinds that can carry one.
  const allowedResults = await evalIn(win, `
    const m = window.__m;
    const out = {};
    for (const [name, t, p] of [['main', m.MAIN_THEME, 'e'], ['quick', m.QUICK_THEME, 'qr']]) {
      const f = m.buildEventForm({
        theme: t, id: p, showTagKind: true, showContact: true,
        ev: { remind: true, remind_kind: 'one_time' }, contacts: [],
      });
      const root = document.createElement('div');
      root.innerHTML = f.html;
      document.getElementById('probe').innerHTML = '';
      document.getElementById('probe').appendChild(root);
      m.wireEventForm(root, f.ids, t);
      const kindEl = root.querySelector('#' + p + '-kind');
      kindEl.value = 'yearly';
      kindEl.dispatchEvent(new Event('change'));
      const lunar = root.querySelector('input[name="' + p + '-cal-mode"][value="lunar"]');
      out[name] = { disabled: !!lunar?.disabled };
    }
    return out;
  `);
  check('the lunar radio stays enabled for 每年 (main window)',
    allowedResults.main.disabled, false);
  check('the lunar radio stays enabled for 每年 (quick record)',
    allowedResults.quick.disabled, false);

  // The rejection messages come from one place.
  const rejections = await evalIn(win, `
    const m = window.__m;
    return {
      daily: m.lunarRejection('daily', 'lunar'),
      weekly: m.lunarRejection('weekly', 'lunar'),
      every_n_days: m.lunarRejection('every_n_days', 'lunar'),
      yearly: m.lunarRejection('yearly', 'lunar'),
      solar: m.lunarRejection('daily', 'solar'),
    };
  `);
  check('每天 is rejected with its own message', rejections.daily, '每天重复不支持农历日期');
  check('每周 is rejected with its own message', rejections.weekly, '每周重复不支持农历日期');
  check('每 N 天 is rejected with its own message', rejections.every_n_days, '每 N 天重复不支持农历日期');
  check('每年 may use a lunar anchor', rejections.yearly, null);
  check('阳历 is never rejected', rejections.solar, null);

  // A lunar anchor is only allowed for the kinds that can carry one.
  const lunarAllowed = await evalIn(win, `
    const m = window.__m;
    return ['daily', 'weekly', 'every_n_days', 'monthly', 'yearly', 'one_time']
      .map((k) => m.lunarAllowedFor(k));
  `);
  check('only the anchored kinds may use a lunar date',
    lunarAllowed, [false, false, false, true, true, true]);

  // ---- 节日类型 -----------------------------------------------------
  console.log('\n== 节日类型 ==');

  const FESTIVALS = [
    { code: 'fathers_day', label: '父亲节' },
    { code: 'christmas', label: '圣诞节' },
  ];

  // Both windows must offer the same festival picker, with the same
  // options — the catalog comes from the server, so it is passed in.
  const festivalForms = await evalIn(win, `
    const m = window.__m;
    const out = {};
    for (const [name, t, p] of [['main', m.MAIN_THEME, 'e'], ['quick', m.QUICK_THEME, 'qr']]) {
      const f = m.buildEventForm({
        theme: t, id: p, showTagKind: true, showContact: true,
        ev: { remind: true, remind_kind: 'one_time', remind_time: '09:00' },
        contacts: [], festivals: ${JSON.stringify(FESTIVALS)},
      });
      const root = document.createElement('div');
      root.innerHTML = f.html;
      document.getElementById('probe').innerHTML = '';
      document.getElementById('probe').appendChild(root);
      m.wireEventForm(root, f.ids, t);
      const sel = root.querySelector('#' + p + '-festival');
      out[name] = {
        options: Array.from(sel.options).map(o => o.value + '=' + o.textContent.trim()),
        hiddenBefore: root.querySelector('#' + p + '-festival-field').classList.contains('hidden'),
      };
      // Choosing 节日 reveals the picker and hides the repeat / date
      // controls, which have no effect on a festival.
      const tag = root.querySelector('#' + p + '-tag-kind');
      tag.value = 'festival';
      tag.dispatchEvent(new Event('change'));
      out[name].hiddenAfter = root.querySelector('#' + p + '-festival-field').classList.contains('hidden');
      out[name].repeatHidden = root.querySelector('#' + p + '-repeat-fields').classList.contains('hidden');
      out[name].dateHidden = root.querySelector('#' + p + '-solar-fields').classList.contains('hidden');
      // Switching back restores them.
      tag.value = '';
      tag.dispatchEvent(new Event('change'));
      out[name].repeatBack = root.querySelector('#' + p + '-repeat-fields').classList.contains('hidden');
      out[name].dateBack = root.querySelector('#' + p + '-solar-fields').classList.contains('hidden');
    }
    return out;
  `);
  check('the festival picker is hidden until 节日 is chosen (main window)',
    festivalForms.main.hiddenBefore, true);
  check('the festival picker is hidden until 节日 is chosen (quick record)',
    festivalForms.quick.hiddenBefore, true);
  check('choosing 节日 reveals the picker (both windows)',
    [festivalForms.main.hiddenAfter, festivalForms.quick.hiddenAfter], [false, false]);
  check('the festival picker lists the catalog (both windows)',
    [festivalForms.main.options, festivalForms.quick.options],
    [
      ['=请选择节日', 'fathers_day=父亲节', 'christmas=圣诞节'],
      ['=请选择节日', 'fathers_day=父亲节', 'christmas=圣诞节'],
    ]);
  check('the repeat controls are hidden for a festival (both windows)',
    [festivalForms.main.repeatHidden, festivalForms.quick.repeatHidden], [true, true]);
  check('the date controls are hidden for a festival (both windows)',
    [festivalForms.main.dateHidden, festivalForms.quick.dateHidden], [true, true]);
  check('leaving 节日 restores the repeat controls (both windows)',
    [festivalForms.main.repeatBack, festivalForms.quick.repeatBack], [false, false]);
  check('leaving 节日 restores the date controls (both windows)',
    [festivalForms.main.dateBack, festivalForms.quick.dateBack], [false, false]);

  // The 类型 dropdown offers 节日 alongside the other tag kinds.
  const tagOptions = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.MAIN_THEME, id: 'e', showTagKind: true, showContact: true,
      ev: { remind: true }, contacts: [], festivals: ${JSON.stringify(FESTIVALS)},
    });
    document.getElementById('probe').innerHTML = f.html;
    const sel = document.querySelector('#e-tag-kind');
    return Array.from(sel.options).map(o => o.value + '=' + o.textContent.trim());
  `);
  check('the 类型 dropdown offers 节日',
    tagOptions.includes('festival=节日'), true);
  check('the 类型 dropdown still offers the other kinds',
    tagOptions,
    ['=(无)', 'birthday=生日', 'anniversary=纪念日', 'festival=节日', 'work=工作']);

  // ---- 工作类型 --------------------------------------------------------
  console.log('\n== 工作类型 ==');

  // 工作 is a CATEGORY, not a tag kind: picking it moves the row into the
  // 工作事件 list and hides the 关联联系人 field (a work event has no
  // contact). The picker itself must be offered in BOTH windows.
  const workForms = await evalIn(win, `
    const m = window.__m;
    const out = {};
    for (const [name, t, p] of [['main', m.MAIN_THEME, 'e'], ['quick', m.QUICK_THEME, 'qr']]) {
      const f = m.buildEventForm({
        theme: t, id: p, showTagKind: true, showContact: true,
        ev: { remind: true, remind_kind: 'one_time', remind_time: '09:00' },
        contacts: [{ id: 1, name: '小李' }],
      });
      const root = document.createElement('div');
      root.innerHTML = f.html;
      document.getElementById('probe').innerHTML = '';
      document.getElementById('probe').appendChild(root);
      m.wireEventForm(root, f.ids, t);
      const contact = root.querySelector('#' + p + '-contact-field');
      const tag = root.querySelector('#' + p + '-tag-kind');
      out[name] = { contactHiddenBefore: contact.classList.contains('hidden') };
      // Choosing 工作 hides the contact field.
      tag.value = 'work';
      tag.dispatchEvent(new Event('change'));
      out[name].contactHiddenAfter = contact.classList.contains('hidden');
      // Switching back restores it.
      tag.value = '';
      tag.dispatchEvent(new Event('change'));
      out[name].contactBack = contact.classList.contains('hidden');
      out[name].read = m.wireEventForm(root, f.ids, t).read();
    }
    return out;
  `);
  check('the contact field is visible before 工作 is chosen (both windows)',
    [workForms.main.contactHiddenBefore, workForms.quick.contactHiddenBefore],
    [false, false]);
  check('choosing 工作 hides the contact field (both windows)',
    [workForms.main.contactHiddenAfter, workForms.quick.contactHiddenAfter],
    [true, true]);
  check('leaving 工作 restores the contact field (both windows)',
    [workForms.main.contactBack, workForms.quick.contactBack], [false, false]);

  // The work option reports itself as a category, not a tag kind.
  const workRead = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.MAIN_THEME, id: 'e', showTagKind: true, showContact: true,
      ev: { remind: true, remind_kind: 'one_time', remind_time: '09:00' },
      contacts: [{ id: 1, name: '小李' }],
    });
    const root = document.createElement('div');
    root.innerHTML = f.html;
    document.getElementById('probe').innerHTML = '';
    document.getElementById('probe').appendChild(root);
    const w = m.wireEventForm(root, f.ids, m.MAIN_THEME);
    const tag = root.querySelector('#e-tag-kind');
    tag.value = 'work';
    tag.dispatchEvent(new Event('change'));
    root.querySelector('#e-desc').value = '写周报';
    const workState = w.read();
    const payload = m.eventPayload(workState, { category: 'work', title: '' });
    // A work row built from scratch opens with 工作 already selected.
    const f2 = m.buildEventForm({
      theme: m.MAIN_THEME, id: 'e', showTagKind: true, showContact: true,
      ev: { category: 'work', remind: true, remind_kind: 'one_time' },
      contacts: [{ id: 1, name: '小李' }],
    });
    const root2 = document.createElement('div');
    root2.innerHTML = f2.html;
    document.getElementById('probe').innerHTML = '';
    document.getElementById('probe').appendChild(root2);
    const w2 = m.wireEventForm(root2, f2.ids, m.MAIN_THEME);
    return {
      work: workState.work,
      tagKind: workState.tagKind,
      payloadCategory: payload.category,
      payloadTagKind: payload.tag_kind,
      payloadContact: payload.contact_id,
      payloadTitle: payload.title,
      existing: w2.read().work,
    };
  `);
  check('the 工作 option is reported as work', workRead.work, true);
  check('a work row carries no tag kind', workRead.tagKind, null);
  check('a work payload lands in the work category', workRead.payloadCategory, 'work');
  check('a work payload carries no tag kind', workRead.payloadTagKind, null);
  check('a work payload carries no contact', workRead.payloadContact, null);
  check('a work payload titles itself with the description',
    workRead.payloadTitle, '写周报');
  check('an existing work row opens on the 工作 option',
    workRead.existing, true);

  // Switching the 类型 away from 节日 must clear the festival code that
  // was stored as the title. The client sends an EMPTY title in that
  // case, and the server re-derives it from the contact (see
  // deriveEventTitle in main/ipc.js) — the stored code must not survive.
  //
  // The picker's own selection may linger (it is simply hidden), but
  // the PAYLOAD must not carry the code: that is what would end up in
  // the row's title.
  const festivalSwitch = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.MAIN_THEME, id: 'e', showTagKind: true, showContact: true,
      ev: { tag_kind: 'festival', title: 'fathers_day', remind: true,
            remind_kind: 'one_time', remind_time: '09:00' },
      contacts: [{ id: 1, name: '小李' }],
      festivals: [{ code: 'fathers_day', label: '父亲节' }],
    });
    const root = document.createElement('div');
    root.innerHTML = f.html;
    document.getElementById('probe').innerHTML = '';
    document.getElementById('probe').appendChild(root);
    const w = m.wireEventForm(root, f.ids, m.MAIN_THEME);
    const tag = root.querySelector('#e-tag-kind');
    // Switch away from 节日: the code must no longer reach the payload.
    tag.value = '';
    tag.dispatchEvent(new Event('change'));
    const state = w.read();
    const payload = m.eventPayload(state, { category: 'general', title: '' });
    return { tagKind: state.tagKind, title: payload.title };
  `);
  check('leaving 节日 clears the tag kind', festivalSwitch.tagKind, null);
  check('leaving 节日 keeps the festival code out of the title',
    festivalSwitch.title, '');

  // A festival without a pick is refused; the payload carries the code.
  const festivalPayload = await evalIn(win, `
    const m = window.__m;
    const noPick = m.validateEventForm({ desc: 'x', tagKind: 'festival', festival: null });
    const withPick = m.validateEventForm({ desc: 'x', tagKind: 'festival', festival: 'fathers_day' });
    const payload = m.eventPayload(
      { desc: 'x', tagKind: 'festival', festival: 'fathers_day', kind: 'one_time',
        mode: 'solar', date: '2026-11-11', time: '09:00', contactId: null,
        remind: true, intervalDays: 3, lunarMonth: null, lunarDay: null },
      { category: 'general', title: '' });
    return { noPick, withPick, payload };
  `);
  check('a festival without a pick is refused', festivalPayload.noPick, '请选择节日');
  check('a festival with a pick passes', festivalPayload.withPick, null);
  check('the festival code becomes the title', festivalPayload.payload.title, 'fathers_day');
  check('a festival repeats every year', festivalPayload.payload.remind_kind, 'yearly');
  check('a festival stores no date', festivalPayload.payload.remind_date, null);
  check('a festival stores no lunar anchor', festivalPayload.payload.lunar_month, null);

  // ---- 回忆表单：主窗口 vs 快速记录 -------------------------------
  console.log('\n== 回忆表单：主窗口 vs 快速记录 ==');
  const mainMem = await evalIn(win, `
    const m = window.__m;
    const f = m.buildMemorialForm({
      theme: m.MAIN_THEME, id: 'e', ev: { kind: 'other' },
      contactPickerHtml: '<div class="c">c</div>',
      photoPickerHtml: '<div class="p">p</div>',
    });
    document.getElementById('probe').innerHTML = f.html;
    return ${DESCRIBE};
  `);

  const quickMem = await evalIn(win, `
    const m = window.__m;
    const f = m.buildMemorialForm({
      theme: m.QUICK_THEME, id: 'qrm', ev: { kind: 'other' },
      contactPickerHtml: '<div class="c">c</div>',
      photoPickerHtml: '<div class="p">p</div>',
    });
    document.getElementById('probe').innerHTML = f.html;
    return ${DESCRIBE};
  `);

  check('the two memorial forms have the same number of fields',
    quickMem.length, mainMem.length);
  check('the two memorial forms are field-for-field identical',
    quickMem, mainMem);

  // The id prefixes must not collide with each other or with the
  // 快速记录 window's own chrome (which owns qr-title, qr-kind, qr-form…).
  const memIds = await evalIn(win, `
    const m = window.__m;
    const f = m.buildMemorialForm({
      theme: m.QUICK_THEME, id: 'qrm', ev: {}, contactPickerHtml: '', photoPickerHtml: '',
    });
    return Object.values(f.ids);
  `);
  const evIds = await evalIn(win, `
    const m = window.__m;
    const f = m.buildEventForm({
      theme: m.QUICK_THEME, id: 'qr', showTagKind: true, showContact: true,
      ev: { remind: true }, contacts: [],
    });
    return Object.values(f.ids);
  `);
  const chromeIds = ['qr', 'qr-icon', 'qr-title', 'qr-sub', 'qr-picker', 'qr-form', 'qr-msg'];
  const all = [...memIds, ...evIds];
  check('no two form ids collide', all.length, new Set(all).size);
  check('no form id collides with the window chrome',
    all.filter((i) => chromeIds.includes(i)), []);

  // ---- The memorial form validates the same way -----------------------
  console.log('\n== 回忆校验 ==');
  const memValidation = await evalIn(win, `
    const m = window.__m;
    const f = m.buildMemorialForm({
      theme: m.MAIN_THEME, id: 'e', ev: {}, contactPickerHtml: '', photoPickerHtml: '',
    });
    const root = document.createElement('div');
    root.innerHTML = f.html;
    document.getElementById('probe').innerHTML = '';
    document.getElementById('probe').appendChild(root);
    const empty = m.readMemorialForm(root, f.ids);
    root.querySelector('#e-title').value = '一次旅行';
    const filled = m.readMemorialForm(root, f.ids);
    root.querySelector('#e-occurred').value = '';
    const noTime = m.readMemorialForm(root, f.ids);
    return { empty: empty.error, filled: filled.error, noTime: noTime.error,
             title: filled.payload.title, kind: filled.payload.kind };
  `);
  check('an empty memorial is refused', memValidation.empty, '请填写标题');
  check('a filled memorial passes', memValidation.filled, null);
  check('a missing time is refused', memValidation.noTime, '请填写事件发生时间');
  check('the title is read back', memValidation.title, '一次旅行');
  check('the kind defaults to 其他', memValidation.kind, 'other');

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  if (fail) process.exitCode = 1;
  // Remove the temporary probe page.
  try { fs.unlinkSync(probePath); } catch (e) { /* already gone */ }
  app.quit();
});
