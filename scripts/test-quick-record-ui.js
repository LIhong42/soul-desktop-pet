// scripts/test-quick-record-ui.js — drives the 快速记录 window's real UI.
//
// The verification script (verify-quick-record.js) proves the DATA layer:
// that the payloads the form builds are accepted and land in the right
// tables. This script proves the UI layer: that the page renders, that
// picking a type swaps in the right form, that the fields are wired, and
// that clicking 保存 actually persists a row.
//
// It loads src/quick_record.html in a real BrowserWindow against a
// throwaway database, then drives the DOM the way a user would.
//
// Run: node scripts/run-electron.js scripts/test-quick-record-ui.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.disableHardwareAcceleration();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-qr-ui-'));
const dbPath = path.join(tmpDir, 'test.db');

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

// Run a snippet inside the page and resolve with its result. The snippet
// may be async; `executeJavaScript` awaits a returned promise.
const evalIn = (win, code) => win.webContents.executeJavaScript(code, true);

app.whenReady().then(async () => {
  const db = require(path.join(__dirname, '..', 'main', 'db'));
  await db.open(dbPath);

  const ipc = require(path.join(__dirname, '..', 'main', 'ipc'));
  ipc.register({
    queue: { remove() {}, add() {} },
    winMain: null,
    winPet: null,
    setPetState() {},
    getPetState: () => ({ state: 'NORMAL', count: 0 }),
    setActiveReminder() {},
    broadcastPetState() {},
    petController: null,
    petRegistry: null,
  });

  // A contact for the attribute-style records.
  const contact = await ipcMain._invokeHandlers.get('contacts:create')(null, {
    name: '小李',
    relationship: '同事',
  });

  const win = new BrowserWindow({
    width: 380,
    height: 520,
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
  await win.loadFile(path.join(__dirname, '..', 'src', 'quick_record.html'));

  // ---- The type picker ------------------------------------------------
  console.log('\n== type picker ==');
  const tiles = await evalIn(win, `
    Array.from(document.querySelectorAll('.qr-tile')).map(t => ({
      kind: t.dataset.kind,
      label: t.querySelector('.qr-tile-label').textContent,
    }))
  `);
  check('six tiles', tiles.length, 6);
  check('tile kinds', tiles.map((t) => t.kind),
    ['like', 'taboo', 'gift', 'reminder', 'memorial', 'work']);
  check('tile labels', tiles.map((t) => t.label),
    ['喜好', '忌讳', '礼物', '提醒日期', '回忆事件', '工作事件']);

  // The picker is visible and the form is hidden before a kind is chosen.
  check('picker visible initially',
    await evalIn(win, `!document.getElementById('qr-picker').classList.contains('hidden')`), true);
  check('form hidden initially',
    await evalIn(win, `document.getElementById('qr-form').classList.contains('hidden')`), true);

  // ---- 喜好: click the tile, fill the form, save -----------------------
  console.log('\n== 喜好: pick → fill → save ==');
  await evalIn(win, `document.querySelector('.qr-tile[data-kind="like"]').click()`);
  // The form swap is async (it loads contacts), so wait for it.
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qr-desc')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);
  check('form visible after picking 喜好',
    await evalIn(win, `!document.getElementById('qr-form').classList.contains('hidden')`), true);
  check('picker hidden after picking a kind',
    await evalIn(win, `document.getElementById('qr-picker').classList.contains('hidden')`), true);
  check('header shows the kind',
    await evalIn(win, `document.getElementById('qr-title').textContent`), '记录 · 喜好');
  checkTrue('desc field present',
    await evalIn(win, `!!document.getElementById('qr-desc')`));
  checkTrue('contact chips rendered',
    await evalIn(win, `document.querySelectorAll('.qr-chip').length > 0`));
  // The first contact is pre-selected, so the common case is one click.
  check('first contact pre-selected',
    await evalIn(win, `document.querySelectorAll('.qr-chip.selected').length`), 1);

  // Save with an empty description → the form must refuse.
  await evalIn(win, `
    document.getElementById('qr-desc').value = '';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 200));
  check('empty description is refused',
    await evalIn(win, `document.getElementById('qr-msg').textContent`), '请填写描述');
  check('nothing written for an empty description',
    db.all('SELECT * FROM contact_attributes').length, 0);

  // Fill it in properly and save.
  await evalIn(win, `
    document.getElementById('qr-desc').value = '抹茶甜点';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 400));
  const likeRows = db.all("SELECT * FROM contact_attributes WHERE kind='like'");
  check('one like row written', likeRows.length, 1);
  check('like description', likeRows[0] && likeRows[0].description, '抹茶甜点');
  check('like contact', likeRows[0] && likeRows[0].contact_id, contact.id);
  check('success message shown',
    await evalIn(win, `document.getElementById('qr-msg').textContent`), '已记录喜好');

  // The form resets so the next entry starts clean.
  check('desc cleared after save',
    await evalIn(win, `document.getElementById('qr-desc').value`), '');

  // ---- 忌讳: the same form, a different kind --------------------------
  console.log('\n== 忌讳 ==');
  await evalIn(win, `
    document.getElementById('qr-back').click();
  `);
  await evalIn(win, `document.querySelector('.qr-tile[data-kind="taboo"]').click()`);
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qr-desc')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);
  await evalIn(win, `
    document.getElementById('qr-desc').value = '不要提起前任';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 400));
  const tabooRows = db.all("SELECT * FROM contact_attributes WHERE kind='taboo'");
  check('one taboo row written', tabooRows.length, 1);
  check('taboo description', tabooRows[0] && tabooRows[0].description, '不要提起前任');
  check('the two kinds stay separate', db.all('SELECT * FROM contact_attributes').length, 2);

  // ---- 提醒日期: the event form ---------------------------------------
  console.log('\n== 提醒日期 ==');
  await evalIn(win, `document.getElementById('qr-back').click()`);
  await evalIn(win, `document.querySelector('.qr-tile[data-kind="reminder"]').click()`);
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qr-desc')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);
  checkTrue('reminder form has a date field',
    await evalIn(win, `!!document.getElementById('qr-date')`));
  checkTrue('reminder form has a time field',
    await evalIn(win, `!!document.getElementById('qr-time')`));
  checkTrue('reminder form has a repeat field',
    await evalIn(win, `!!document.getElementById('qr-kind')`));
  checkTrue('reminder form has a contact picker',
    await evalIn(win, `!!document.getElementById('qr-contact')`));
  checkTrue('reminder form has a type dropdown',
    await evalIn(win, `!!document.getElementById('qr-tag-kind')`));

  // The main window's event form also has these — the quick-record form
  // must match it field for field.
  checkTrue('reminder form has a 启用提醒 checkbox',
    await evalIn(win, `!!document.getElementById('qr-remind')`));
  checkTrue('reminder form has a 日期类型 radio group',
    await evalIn(win, `!!document.querySelector('input[name="qr-cal-mode"][value="lunar"]')`));
  checkTrue('reminder form has lunar month/day selects',
    await evalIn(win, `!!document.getElementById('qr-lunar-month') && !!document.getElementById('qr-lunar-day')`));
  checkTrue('reminder form has an interval-days input',
    await evalIn(win, `!!document.getElementById('qr-interval-days')`));
  check('启用提醒 is on by default',
    await evalIn(win, `document.getElementById('qr-remind').checked`), true);
  check('the lunar field set is hidden by default',
    await evalIn(win, `document.getElementById('qr-lunar-fields').classList.contains('hidden')`), true);
  check('the interval field is hidden for one_time',
    await evalIn(win, `document.getElementById('qr-interval-field').classList.contains('hidden')`), true);

  // Switching to 农历 reveals the lunar selects and hides the solar date.
  await evalIn(win, `
    document.querySelector('input[name="qr-cal-mode"][value="lunar"]').click();
  `);
  await new Promise((r) => setTimeout(r, 100));
  check('the lunar field set is shown in lunar mode',
    await evalIn(win, `!document.getElementById('qr-lunar-fields').classList.contains('hidden')`), true);
  check('the solar date is hidden in lunar mode',
    await evalIn(win, `document.getElementById('qr-solar-fields').classList.contains('hidden')`), true);

  // "每天" has no meaningful lunar anchor — the radio must be disabled,
  // exactly as in the main window.
  await evalIn(win, `
    document.getElementById('qr-kind').value = 'daily';
    document.getElementById('qr-kind').dispatchEvent(new Event('change'));
  `);
  await new Promise((r) => setTimeout(r, 100));
  check('the lunar radio is disabled for 每天',
    await evalIn(win, `document.querySelector('input[name="qr-cal-mode"][value="lunar"]').disabled`), true);
  check('the mode falls back to 阳历 for 每天',
    await evalIn(win, `document.querySelector('input[name="qr-cal-mode"]:checked').value`), 'solar');

  // "每 N 天" reveals the stride input.
  await evalIn(win, `
    document.getElementById('qr-kind').value = 'every_n_days';
    document.getElementById('qr-kind').dispatchEvent(new Event('change'));
  `);
  await new Promise((r) => setTimeout(r, 100));
  check('the interval field is shown for 每 N 天',
    await evalIn(win, `!document.getElementById('qr-interval-field').classList.contains('hidden')`), true);

  // Back to a normal yearly solar reminder for the actual save.
  await evalIn(win, `
    document.getElementById('qr-kind').value = 'yearly';
    document.getElementById('qr-kind').dispatchEvent(new Event('change'));
  `);
  await new Promise((r) => setTimeout(r, 100));

  await evalIn(win, `
    document.getElementById('qr-desc').value = '打电话确认一下';
    // The contact is optional here (as in the main window); pick one so
    // the server can derive the display title from it.
    document.getElementById('qr-contact').value = ${JSON.stringify(contact.id)};
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 400));
  // The DB seeds a handful of built-in general events, so count only the
  // row this form just wrote.
  const evRows = db.all("SELECT * FROM events WHERE category='general' AND description=?", ['打电话确认一下']);
  check('one general event written', evRows.length, 1);
  check('event description', evRows[0] && evRows[0].description, '打电话确认一下');
  check('event category', evRows[0] && evRows[0].category, 'general');
  check('event repeat kind', evRows[0] && evRows[0].remind_kind, 'yearly');
  check('event remind flag', evRows[0] && evRows[0].remind, 1);
  check('event has no lunar anchor in solar mode',
    evRows[0] && evRows[0].lunar_month, null);
  check('event interval is null for yearly', evRows[0] && evRows[0].interval_days, null);
  check('event contact', evRows[0] && evRows[0].contact_id, contact.id);
  // The quick-record form sends an empty title, so the server derives the
  // display label from the linked contact — the same as the main window.
  check('event title derived from the contact', evRows[0] && evRows[0].title, '小李的提醒');

  // ---- 工作事件: the event form without the contact / type fields -----
  console.log('\n== 工作事件 ==');
  await evalIn(win, `document.getElementById('qr-back').click()`);
  await evalIn(win, `document.querySelector('.qr-tile[data-kind="work"]').click()`);
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qr-desc')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);
  checkTrue('work form has NO contact picker',
    !(await evalIn(win, `!!document.getElementById('qr-contact')`)));
  checkTrue('work form has NO type dropdown',
    !(await evalIn(win, `!!document.getElementById('qr-tag-kind')`)));
  await evalIn(win, `
    document.getElementById('qr-desc').value = '季度汇报';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 400));
  const workRows = db.all("SELECT * FROM events WHERE category='work'");
  check('one work event written', workRows.length, 1);
  check('work event description', workRows[0] && workRows[0].description, '季度汇报');
  check('work event has no contact', workRows[0] && workRows[0].contact_id, null);

  // ---- 回忆事件: the memorial form ------------------------------------
  console.log('\n== 回忆事件 ==');
  await evalIn(win, `document.getElementById('qr-back').click()`);
  await evalIn(win, `document.querySelector('.qr-tile[data-kind="memorial"]').click()`);
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qrm-title')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);
  checkTrue('memorial form has a title field',
    await evalIn(win, `!!document.getElementById('qrm-title')`));
  // The memorial 类型 select must not collide with the event form's 重复
  // select — both are "kind" in their own right.
  checkTrue('memorial form has its own kind select',
    await evalIn(win, `!!document.getElementById('qrm-mem-kind') && !document.getElementById('qr-kind')`));
  checkTrue('memorial form has an occurrence field',
    await evalIn(win, `!!document.getElementById('qrm-occurred')`));
  checkTrue('memorial form has place / food fields',
    await evalIn(win, `!!document.getElementById('qrm-place') && !!document.getElementById('qrm-food')`));
  // The main window's memorial form also has 穿着 / 活动 and a photo
  // picker — the quick-record form must match it.
  checkTrue('memorial form has outfit / activities fields',
    await evalIn(win, `!!document.getElementById('qrm-outfit') && !!document.getElementById('qrm-activities')`));
  checkTrue('memorial form has a photo picker',
    await evalIn(win, `!!document.getElementById('qrm-photos')`));
  checkTrue('memorial form has a photo preview area',
    await evalIn(win, `!!document.getElementById('qr-photo-preview')`));
  checkTrue('memorial form has a 全选 / 清空 toolbar',
    await evalIn(win, `!!document.querySelector('.qr-picker-all') && !!document.querySelector('.qr-picker-none')`));
  // The memorial form is a MULTI-select (like the main window's), so no
  // contact is pre-selected — the user picks explicitly.
  check('memorial starts with no contact selected',
    await evalIn(win, `document.querySelectorAll('.qr-chip.selected').length`), 0);
  check('the contact count reads 未选',
    await evalIn(win, `document.querySelector('.qr-count').textContent`), '未选');

  // 全选 selects everyone; the count follows.
  await evalIn(win, `document.querySelector('.qr-picker-all').click()`);
  await new Promise((r) => setTimeout(r, 100));
  check('全选 selects every contact',
    await evalIn(win, `document.querySelectorAll('.qr-chip.selected').length`), 1);
  check('the contact count follows the selection',
    await evalIn(win, `document.querySelector('.qr-count').textContent`), '已选 1 人');

  // 清空 deselects everything.
  await evalIn(win, `document.querySelector('.qr-picker-none').click()`);
  await new Promise((r) => setTimeout(r, 100));
  check('清空 deselects every contact',
    await evalIn(win, `document.querySelectorAll('.qr-chip.selected').length`), 0);

  // An empty title must be refused.
  await evalIn(win, `
    document.getElementById('qrm-title').value = '';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 200));
  check('empty title is refused',
    await evalIn(win, `document.getElementById('qr-msg').textContent`), '请填写标题');
  check('nothing written for an empty title', db.all('SELECT * FROM memorial_events').length, 0);

  await evalIn(win, `
    document.getElementById('qrm-title').value = '第一次去迪士尼';
    document.getElementById('qrm-place').value = '迪士尼乐园';
    document.getElementById('qrm-food').value = '米奇蛋糕';
    document.getElementById('qrm-outfit').value = '红色连衣裙';
    document.getElementById('qrm-activities').value = '看了日落';
    // Attach the contact (the memorial form is a multi-select).
    document.querySelector('.qr-chip').click();
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 400));
  const memRows = db.all('SELECT * FROM memorial_events');
  check('one memorial written', memRows.length, 1);
  check('memorial title', memRows[0] && memRows[0].title, '第一次去迪士尼');
  check('memorial place', memRows[0] && memRows[0].place, '迪士尼乐园');
  check('memorial food', memRows[0] && memRows[0].food, '米奇蛋糕');
  check('memorial outfit', memRows[0] && memRows[0].outfit, '红色连衣裙');
  check('memorial activities', memRows[0] && memRows[0].activities, '看了日落');
  checkTrue('memorial occurred_at stored',
    !!memRows[0] && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(memRows[0].occurred_at),
    memRows[0] && memRows[0].occurred_at);

  // ---- 农历 (lunar) reminder -------------------------------------------
  //
  // The main window's event form offers 阳历 / 农历. The quick-record form
  // must offer the same thing and store the same columns, otherwise a
  // lunar reminder captured from the pet would silently never fire.
  console.log('\n== 农历提醒日期 ==');
  await evalIn(win, `document.getElementById('qr-back').click()`);
  await evalIn(win, `document.querySelector('.qr-tile[data-kind="reminder"]').click()`);
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qr-desc')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);
  // Pick 农历, a yearly repeat, and the 8th month / 15th day.
  await evalIn(win, `
    document.getElementById('qr-kind').value = 'yearly';
    document.getElementById('qr-kind').dispatchEvent(new Event('change'));
    document.querySelector('input[name="qr-cal-mode"][value="lunar"]').click();
    document.getElementById('qr-lunar-month').value = '8';
    document.getElementById('qr-lunar-day').value = '15';
  `);
  await new Promise((r) => setTimeout(r, 100));
  await evalIn(win, `
    document.getElementById('qr-desc').value = '中秋节';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 400));
  const lunarRows = db.all("SELECT * FROM events WHERE description=?", ['中秋节']);
  check('one lunar event written', lunarRows.length, 1);
  check('lunar month stored', lunarRows[0] && lunarRows[0].lunar_month, 8);
  check('lunar day stored', lunarRows[0] && lunarRows[0].lunar_day, 15);
  check('lunar event has no solar anchor',
    lunarRows[0] && lunarRows[0].remind_date, null);
  checkTrue('lunar event has a next_fire_at',
    !!(lunarRows[0] && lunarRows[0].next_fire_at), String(lunarRows[0] && lunarRows[0].next_fire_at));

  // "每天" + 农历 is an invalid combination (the scheduler has no lunar
  // anchor for a daily repeat). The main window prevents it by disabling
  // the 农历 radio and resetting the mode to 阳历 — the quick-record form
  // must do the same, so the combination is unreachable through the UI.
  await evalIn(win, `
    document.getElementById('qr-back').click();
    document.querySelector('.qr-tile[data-kind="reminder"]').click();
  `);
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qr-desc')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);
  await evalIn(win, `
    document.querySelector('input[name="qr-cal-mode"][value="lunar"]').click();
    document.getElementById('qr-kind').value = 'daily';
    document.getElementById('qr-kind').dispatchEvent(new Event('change'));
  `);
  await new Promise((r) => setTimeout(r, 100));
  check('the lunar radio is disabled for 每天 (invalid combo unreachable)',
    await evalIn(win, `document.querySelector('input[name="qr-cal-mode"][value="lunar"]').disabled`), true);
  check('the mode falls back to 阳历 for 每天',
    await evalIn(win, `document.querySelector('input[name="qr-cal-mode"]:checked').value`), 'solar');

  // Saving in that state stores a valid solar daily reminder — no broken
  // lunar anchor is written.
  await evalIn(win, `
    document.getElementById('qr-desc').value = '每天一杯水';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 400));
  const dailyRows = db.all("SELECT * FROM events WHERE description=?", ['每天一杯水']);
  check('one daily event written', dailyRows.length, 1);
  check('daily event repeat kind', dailyRows[0] && dailyRows[0].remind_kind, 'daily');
  check('daily event has no lunar anchor',
    dailyRows[0] && dailyRows[0].lunar_month, null);

  // ---- Photo upload (回忆事件) -----------------------------------------
  //
  // The photos have to be uploaded AFTER the event row exists (the upload
  // endpoint needs the event id), so this exercises the whole chain: pick
  // files → preview them → save → upload → rows land in the photos table.
  console.log('\n== 照片上传 ==');
  await evalIn(win, `document.getElementById('qr-back').click()`);
  await evalIn(win, `document.querySelector('.qr-tile[data-kind="memorial"]').click()`);
  await evalIn(win, `
    new Promise(res => {
      const t = setInterval(() => {
        if (document.getElementById('qrm-title')) { clearInterval(t); res(true); }
      }, 10);
    })
  `);

  // Write two tiny real PNG files so the file input accepts them.
  const photoPaths = [];
  for (const name of ['shot-a.png', 'shot-b.png']) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db0000000049454e44ae426082',
      'hex'));
    photoPaths.push(p);
  }

  // Attach the files to the <input type="file"> and fire the change event,
  // exactly as the OS file picker would.
  await evalIn(win, `
    (async () => {
      const input = document.getElementById('qrm-photos');
      const dt = new DataTransfer();
      const paths = ${JSON.stringify(photoPaths)};
      for (const p of paths) {
        const res = await fetch('file:///' + p.replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, '$1:'));
        const blob = await res.blob();
        dt.items.add(new File([blob], p.split(/[\\\\/]/).pop(), { type: 'image/png' }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  check('two thumbnails are previewed',
    await evalIn(win, `document.querySelectorAll('.qr-photo-item').length`), 2);
  checkTrue('the preview images have a blob: src',
    await evalIn(win, `!!document.querySelector('.qr-photo-item img')?.src?.startsWith('blob:')`));

  await evalIn(win, `
    document.getElementById('qrm-title').value = '带照片的回忆';
    document.getElementById('qr-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 1500));
  const photoEvent = db.all("SELECT * FROM memorial_events WHERE title=?", ['带照片的回忆']);
  check('the photo memorial was written', photoEvent.length, 1);
  const photoRows = db.all('SELECT * FROM memorial_event_photos WHERE memorial_event_id=?',
    photoEvent.length ? [photoEvent[0].id] : ['']);
  check('two photo rows uploaded', photoRows.length, 2);
  checkTrue('the uploaded photos have a relative_path',
    photoRows.every((p) => typeof p.relative_path === 'string' && p.relative_path.length > 0),
    JSON.stringify(photoRows.map((p) => p.relative_path)));
  check('the success message mentions the photo count',
    await evalIn(win, `document.getElementById('qr-msg').textContent`),
    '已记录回忆事件（2 张照片）');

  // ---- The window asks the main process which kind to open -------------
  console.log('\n== boot kind ==');
  // `quick-record:get_kind` is answered by the main process. It returns
  // null here (no quick-record window was opened), so the picker shows.
  check('getKind returns null when no window was targeted',
    await ipcMain._invokeHandlers.get('quick-record:get_kind')(null), null);

  // ---- Cleanup ---------------------------------------------------------
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('test-quick-record-ui crashed:', e);
  process.exit(1);
});
