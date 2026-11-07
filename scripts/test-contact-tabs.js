// scripts/test-contact-tabs.js — proves the contact detail page owns the
// per-kind lists (喜好 / 忌讳 / 礼物) behind its own tab bar.
//
// The 喜好 / 忌讳 / 礼物 pages used to be top-level nav entries with their
// own routes; they are now tabs inside one contact:
//
//   #/contacts/:id          → 概览
//   #/contacts/:id/likes    → 喜好
//   #/contacts/:id/taboos   → 忌讳
//   #/contacts/:id/gifts    → 礼物
//
// This script drives the real main window and checks the parts that are
// easy to break: the tab bar and its counters, the add form inside a tab,
// the search / event filter, the per-tab state that must survive a tab
// switch, the bulk-delete flow, and the round-trip into the shared
// attribute detail page (which must send the user back to the tab).
//
// Run: node scripts/run-electron.js scripts/test-contact-tabs.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const evalIn = (win, code) =>
  win.webContents.executeJavaScript(
    `(async () => { try { ${code} } catch (e) { return { __threw: String(e && e.stack || e) }; } })()`, true);

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-f-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();

  const now = db.nowStr();
  const contactId = db.newId();
  db.run(
    `INSERT INTO contacts(id, name, relationship, icon_kind, likes_json, taboos_json,
                          gifts_json, listed, created_at, updated_at)
     VALUES (?, ?, '奶奶', 'user', '[]', '[]', '[]', 1, ?, ?)`,
    [contactId, '奶奶', now, now]
  );
  const add = (kind, desc, ev) => db.run(
    `INSERT INTO contact_attributes(id, contact_id, kind, description, event, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [db.newId(), contactId, kind, desc, ev, now, now]
  );
  add('like', '抹茶甜点', '2024-05-12');
  add('like', '晨练后喝豆浆', '2025-03-02');
  add('like', '喜欢散步', '2025-11-20');
  add('taboo', '不谈生意', '2025-08-01');
  add('gift', '真丝围巾', '2025-12-20');

  // One dated event, so the overview has something to merge into 重要日期.
  db.run(
    `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                        remind_time, remind_date, next_fire_at, active, category,
                        tag_kind, created_at, updated_at)
     VALUES (?, ?, ?, '', 1, 'yearly', '09:00', '2026-05-12', '2026-05-12', 1,
             'birthday', 'birthday', ?, ?)`,
    [db.newId(), contactId, '奶奶的生日', now, now]
  );

  const winMain = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  const queue = new scheduler.ReminderQueue();
  ipc.register({
    queue, winMain, winPet: null,
    setPetState: () => {}, getPetState: () => false,
    setActiveReminder: () => {}, broadcastPetState: () => {},
    petController: null,
    petRegistry: {
      list: () => [], getManifest: () => null, resolveFrames: () => ({ frames: [], variantHint: '', loop: true }),
      getPortrait: () => null, isImported: () => false, getRootDir: () => '', rescan: () => {},
    },
  });
  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  // ---- The overview tab ------------------------------------------------
  await evalIn(winMain, `location.hash = '#/contacts/${contactId}'; true`);
  await new Promise((r) => setTimeout(r, 1500));
  const overview = await evalIn(winMain, `return ({
    tabs: Array.from(document.querySelectorAll('.cd-tab')).map(t => t.textContent.trim()),
    sections: Array.from(document.querySelectorAll('#cd-body .section-header h2')).map(h => h.textContent.trim()),
    rowTitles: Array.from(document.querySelectorAll('#cd-body .list-row .lr-title')).map(e => e.textContent.trim()),
  })`);
  check('the tab bar shows 概览 + three kinds', overview.tabs, ['概览', '喜好3', '忌讳1', '礼物1']);
  // 事件 used to be a section of its own; its rows now live in 重要日期.
  check('the overview has only the 重要日期 / 回忆事件 sections',
    overview.sections, ['重要日期', '回忆事件']);
  check('the event row moved into 重要日期',
    overview.rowTitles.some(t => t.includes('奶奶的生日')), true);

  // ---- The 喜好 tab ----------------------------------------------------
  await evalIn(winMain, `location.hash = '#/contacts/${contactId}/likes'; true`);
  await new Promise((r) => setTimeout(r, 1500));
  const tab = await evalIn(winMain, `return ({
    active: document.querySelector('.cd-tab.is-active').textContent.trim(),
    rows: Array.from(document.querySelectorAll('.list-host .attribute-clickable .cd-attr-text')).map(e => e.textContent),
    count: (document.querySelector('.cd-count')||{}).textContent,
    hasAdd: !!document.getElementById('cd-add-toggle'),
    formHidden: document.getElementById('cd-add-card').classList.contains('hidden'),
  })`);
  check('the 喜好 tab is active', tab.active, '喜好3');
  check('only this contact\'s rows are listed', tab.rows, ['喜欢散步', '晨练后喝豆浆', '抹茶甜点']);
  check('the section shows the count', tab.count, '3');
  check('the add button is there', tab.hasAdd, true);
  check('the add form starts collapsed', tab.formHidden, true);

  // ---- Add a row through the tab's own form ----------------------------
  await evalIn(winMain, `
    document.getElementById('cd-add-toggle').click();
    return true;
  `);
  const opened = await evalIn(winMain, `
    const card = document.getElementById('cd-add-card');
    return { hidden: card.classList.contains('hidden') };
  `);
  check('clicking 新增条目 opens the form', opened.hidden, false);

  await evalIn(winMain, `
    document.getElementById('cd-add-desc').value = '爱喝茶';
    document.getElementById('cd-add-event').value = '2026-03-03';
    document.getElementById('cd-add-save').click();
    return true;
  `);
  await new Promise((r) => setTimeout(r, 1500));
  const afterAdd = await evalIn(winMain, `return ({
    rows: Array.from(document.querySelectorAll('.list-host .attribute-clickable .cd-attr-text')).map(e => e.textContent),
    count: (document.querySelector('.cd-count')||{}).textContent,
    tabCount: (document.querySelector('.cd-tab.is-active .cd-tab-count')||{}).textContent,
    formHidden: document.getElementById('cd-add-card').classList.contains('hidden'),
  })`);
  check('the new row shows up in the list', afterAdd.rows.includes('爱喝茶'), true);
  check('the section count grew', afterAdd.count, '4');
  check('the tab badge grew', afterAdd.tabCount, '4');
  check('the form closed again', afterAdd.formHidden, true);

  // The row really is in the DB, on this contact.
  const inDb = db.all('SELECT description FROM contact_attributes WHERE contact_id = ? ORDER BY created_at', [contactId])
    .map((r) => r.description);
  check('the row is in the database', inDb.includes('爱喝茶'), true);

  // ---- Search filters the list ----------------------------------------
  await evalIn(winMain, `
    const input = document.querySelector('.section-search');
    input.value = '抹茶';
    input.dispatchEvent(new Event('input'));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 600));
  const searched = await evalIn(winMain, `return ({
    rows: Array.from(document.querySelectorAll('.list-host .attribute-clickable .cd-attr-text')).map(e => e.textContent),
    footer: (document.querySelector('.list-tail > div.meta')||{}).textContent || '',
    inputAlive: document.querySelector('.section-search').value,
  })`);
  check('the search narrows the list', searched.rows, ['抹茶甜点']);
  check('the search input keeps its value', searched.inputAlive, '抹茶');
  check('the match footer reports the count', searched.footer.includes('匹配 1 条'), true);

  // The search term survives a tab switch.
  await evalIn(winMain, `location.hash = '#/contacts/${contactId}/taboos'; true`);
  await new Promise((r) => setTimeout(r, 1200));
  await evalIn(winMain, `location.hash = '#/contacts/${contactId}/likes'; true`);
  await new Promise((r) => setTimeout(r, 1200));
  const kept = await evalIn(winMain, `return ({
    value: document.querySelector('.section-search').value,
    rows: Array.from(document.querySelectorAll('.list-host .attribute-clickable .cd-attr-text')).map(e => e.textContent),
  })`);
  check('the search term survives a tab switch', kept.value, '抹茶');
  check('the filtered list is still filtered', kept.rows, ['抹茶甜点']);

  // ---- A row opens the shared attribute detail page --------------------
  await evalIn(winMain, `document.querySelector('.list-host .attribute-clickable').click(); true`);
  await new Promise((r) => setTimeout(r, 1200));
  const detail = await evalIn(winMain, `return ({
    hash: location.hash,
    back: (document.getElementById('back-link')||{}).textContent,
    title: (document.querySelector('#app h1')||{}).textContent,
  })`);
  check('the row opens the attribute detail page', detail.hash, '#/attributes/' + detail.hash.split('/').pop());
  check('the detail page offers a back link', detail.back.trim(), '返回喜好');

  await evalIn(winMain, `document.getElementById('back-link').click(); true`);
  await new Promise((r) => setTimeout(r, 1200));
  const back = await evalIn(winMain, `return location.hash;`);
  check('the back link returns to the contact tab', back, `#/contacts/${contactId}/likes`);

  // ---- Bulk delete inside a tab ----------------------------------------
  //
  // The toolbar's "全选" checkbox calls selectMode.onChange(); the old
  // contact-detail implementation never defined it, so clicking 全选 threw.
  // The row checkboxes and the delete button are exercised here.
  await evalIn(winMain, `location.hash = '#/contacts/${contactId}/likes'; true`);
  await new Promise((r) => setTimeout(r, 1200));
  const entered = await evalIn(winMain, `return (function() {
    const link = document.querySelector('[data-bulk-enter]');
    if (!link) return { found: false };
    link.click();
    return { found: true };
  })();`);
  check('the 批量删除 link is there', entered.found, true);
  await new Promise((r) => setTimeout(r, 400));

  const inSelectMode = await evalIn(winMain, `return ({
    toolbar: !!document.querySelector('[data-bulk-toolbar]'),
    checks: document.querySelectorAll('.bulk-row-check').length,
  });`);
  check('select mode shows the bulk toolbar', inSelectMode.toolbar, true);
  check('select mode puts a checkbox on every row', inSelectMode.checks, 1);

  // "全选" must not throw and must flip the row checkbox.
  const selectAll = await evalIn(winMain, `return (function() {
    const toggle = document.querySelector('[data-bulk-toggle]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const row = document.querySelector('.bulk-row-check');
    return { rowChecked: !!(row && row.checked),
             counter: (document.querySelector('[data-bulk-delete]')||{}).textContent };
  })();`);
  check('全选 checks the row too', selectAll.rowChecked, true);
  check('the delete button counts the selection', selectAll.counter.trim(), '删除选中 (1)');

  // Delete the selected row through the toolbar.
  await evalIn(winMain, `window.confirm = () => true; return true;`);
  await evalIn(winMain, `document.querySelector('[data-bulk-delete]').click(); true`);
  await new Promise((r) => setTimeout(r, 1500));
  const afterDelete = await evalIn(winMain, `return ({
    rows: Array.from(document.querySelectorAll('.list-host .attribute-clickable .cd-attr-text')).map(e => e.textContent),
    count: (document.querySelector('.cd-count')||{}).textContent,
  });`);
  check('the deleted row is gone from the list', afterDelete.rows.includes('抹茶甜点'), false);
  check('the section count followed the delete', afterDelete.count, '3');

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  if (fail) process.exitCode = 1;

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
