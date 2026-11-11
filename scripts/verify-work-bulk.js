// scripts/verify-work-bulk.js — verifies the 工作事件 TYPE of the 提醒
// page: the bulk-select round trip and the type filter itself.
//
// 工作事件 have no page of their own any more — they are the 工作事件
// option of the 提醒 page's 类型 filter, which selects the work CATEGORY
// (category='work') rather than a tag kind. So this test navigates to
// /reminders?tag_kind=work and checks that the list really shows the
// work rows (and only those).
//
// The general 提醒 view is checked through the same battery, because both
// views share one code path — a bug in the shared bulk wiring shows up in
// either.
//
// Entering select mode repaints the list subtree, and the bulk toolbar
// is part of that subtree — so the 「退出选择」 button the user clicks is
// a NEW node, with none of the handlers the old one had. Binding the
// toolbar only at mount time left the button dead.
//
// The page is loaded through the router, the way the app loads it, so
// the check exercises the real navigation path.
//
// Run: node scripts/run-electron.js scripts/verify-work-bulk.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

const SRC = path.join(__dirname, '..', 'src');
const probePath = path.join(SRC, '.work-bulk-verify.html');

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./css/styles.css"></head><body>
<main id="app" class="content"></main><div id="toast-container"></div>
<script type="module">
const { navigate, start } = await import('./js/router.js');
// Register the reminder page the way the app's entry point does.
await import('./js/pages/events.js');

const q = (sel) => document.querySelector(sel);
const out = {};

// Seed the reminder-event table the 提醒 page reads from: two work rows
// and one general row, so the work view can be checked for leaks.
window.__testEventRows.clear();
window.__testEventRows.seed('w1', {
  id: 'w1', kind: 'work', title: '第一件事', description: '写周报',
  occurred_at: '2026-05-01 10:00:00', category: 'work',
  contact_ids: [], contact_names: [], notes: '正文',
});
window.__testEventRows.seed('w2', {
  id: 'w2', kind: 'work', title: '第二件事', description: '开会',
  occurred_at: '2026-06-01 10:00:00', category: 'work',
  contact_ids: [], contact_names: [], notes: '正文',
});
window.__testEventRows.seed('g1', {
  id: 'g1', kind: 'general', title: '普通提醒', description: '喝水',
  occurred_at: '2026-05-02 10:00:00', category: 'general',
  contact_ids: [], contact_names: [], notes: '正文',
});

// The confirm dialog the bulk delete raises is answered 「yes」 — the test
// drives the delete path, and a dialog would hang the renderer.
window.confirm = () => true;

// Navigate to the page — the router dispatches to the registered handler.
start();

// Run one battery of checks against a view, and return what it found.
async function runView(hash, expectRows, expectIds) {
  navigate(hash);
  await new Promise(r => setTimeout(r, 600));
  const v = {};

  v.pageLoaded = !!q('#reminders-list');
  v.title = (q('h1') || {}).textContent || '';
  v.rows = document.querySelectorAll('#reminders-list .card').length;
  v.rowIds = Array.from(document.querySelectorAll('#reminders-list .card'))
    .map((el) => el.dataset.id).sort().join(',');
  v.mainLine = (q('#reminders-list .lr-title') || {}).textContent || '';
  v.kindOptions = Array.from(document.querySelectorAll('#filter-tag-kind option'))
    .map((o) => o.value).join(',');
  v.kindSelected = (q('#filter-tag-kind') || {}).value || '';

  v.expectRows = expectRows;
  v.expectIds = expectIds;

  v.hasEnterLink = !!q('[data-bulk-enter]');
  if (!v.hasEnterLink) return v;

  // Enter select mode through the 「批量删除」 link.
  q('[data-bulk-enter]').click();
  await new Promise(r => setTimeout(r, 250));
  v.toolbarShown = !!q('[data-bulk-toolbar]');
  v.checkboxShown = !!q('.bulk-row-check');

  const exit = q('[data-bulk-exit]');
  v.exitExists = !!exit;
  v.exitHasHandler = !!(exit && exit.onclick);

  // ...and clicking it must actually leave select mode.
  if (exit) exit.click();
  await new Promise(r => setTimeout(r, 250));
  v.toolbarGone = !q('[data-bulk-toolbar]');
  v.checkboxGone = !q('.bulk-row-check');
  v.bulkLinkBack = !!q('[data-bulk-enter]');
  v.newBack = !!q('#new-event');
  v.rowsAfter = document.querySelectorAll('#reminders-list .card').length;

  // ---- the delete path ----
  //
  // Deleting must actually take the row off the screen. A re-render
  // driven by a hash CHANGE would not do it here: the filters are
  // already in the URL, so the same hash fires no hashchange and the
  // list would keep the deleted row.
  q('[data-bulk-enter]').click();
  await new Promise(r => setTimeout(r, 250));
  const firstCheck = q('.bulk-row-check');
  if (firstCheck) {
    firstCheck.checked = true;
    firstCheck.onchange();
  }
  await new Promise(r => setTimeout(r, 150));
  const del = q('[data-bulk-delete]');
  v.deleteButtonExists = !!del;
  if (del) del.click();
  await new Promise(r => setTimeout(r, 400));
  v.rowsAfterDelete = document.querySelectorAll('#reminders-list .card').length;
  v.toolbarGoneAfterDelete = !q('[data-bulk-toolbar]');

  return v;
}

// The work view: the two work rows and only those.
out.work = await runView('/reminders?tag_kind=work', 2, 'w1,w2');
// The general view: the general row only.
out.general = await runView('/reminders', 1, 'g1');

window.__result = out;
window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  fs.writeFileSync(probePath, PROBE_HTML);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'diary-test-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('  [page error]', message);
  });

  await win.loadFile(probePath);
  await win.webContents.executeJavaScript(
    `(async () => {
       await new Promise(res => {
         const t = setInterval(() => { if (window.__ready) { clearInterval(t); res(true); } }, 10);
       });
       return true;
     })()`
  );
  const result = await win.webContents.executeJavaScript('window.__result');
  console.log(JSON.stringify(result, null, 2));

  // The checks that only make sense for one of the two views.
  const viewSpecific = {
    work: [
      ['the heading still names the page (提醒)', /提醒/.test(result.work.title || '')],
      ['the work view shows the two work rows', result.work.rows === 2],
      ['the general row does not leak into the work view', result.work.rowIds === 'w1,w2'],
      ['the work row shows its description', /写周报/.test(result.work.mainLine || '')],
      ['the 工作事件 option is the selected one', result.work.kindSelected === 'work'],
    ],
    general: [
      ['the heading names the reminders', /提醒/.test(result.general.title || '')],
      ['the general view shows the general row only', result.general.rows === 1],
      ['the work rows do not leak into the general view', result.general.rowIds === 'g1'],
      ['the 全部 option is the selected one', result.general.kindSelected === ''],
    ],
  };

  // The checks both views share: the bulk-select round trip.
  const shared = (v) => [
    ['the page loaded', v.pageLoaded === true],
    ['the 类型 dropdown carries a 工作事件 option',
      /(^|,)work(,|$)/.test(v.kindOptions || '')],
    ['the page carries a bulk entry link', v.hasEnterLink === true],
    ['select mode shows the bulk toolbar', v.toolbarShown === true],
    ['select mode puts a checkbox on each row', v.checkboxShown === true],
    ['the exit button is on the page', v.exitExists === true],
    ['the exit button is wired to a handler', v.exitHasHandler === true],
    ['leaving select mode takes the toolbar away', v.toolbarGone === true],
    ['leaving select mode takes the checkboxes away', v.checkboxGone === true],
    ['the bulk entry link comes back', v.bulkLinkBack === true],
    ['the new button comes back', v.newBack === true],
    ['the rows survive the round trip', v.rowsAfter === v.expectRows],
    ['the delete button is there', v.deleteButtonExists === true],
    ['the deleted row is gone from the list', v.rowsAfterDelete === v.expectRows - 1],
    ['deleting leaves select mode', v.toolbarGoneAfterDelete === true],
  ];

  const checks = [
    ...viewSpecific.work.map(([l, ok]) => ['工作事件: ' + l, ok]),
    ...viewSpecific.general.map(([l, ok]) => ['提醒: ' + l, ok]),
    ...shared(result.work).map(([l, ok]) => ['工作事件: ' + l, ok]),
    ...shared(result.general).map(([l, ok]) => ['提醒: ' + l, ok]),
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log((ok ? '  ok   ' : '  FAIL ') + label);
    if (!ok) failed++;
  }
  console.log(`\n== ${checks.length - failed} passed, ${failed} failed ==\n`);

  fs.unlinkSync(probePath);
  app.exit(failed === 0 ? 0 : 1);
}).catch((e) => {
  console.error('verify failed:', e);
  try { fs.unlinkSync(probePath); } catch (_) {}
  app.exit(1);
});
