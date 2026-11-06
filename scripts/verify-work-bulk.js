// scripts/verify-work-bulk.js — verifies the 工作事件 page's bulk-select
// round trip.
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
// Register the work page the way the app's entry point does.
await import('./js/pages/events_work.js');

const q = (sel) => document.querySelector(sel);
const out = {};

// Seed the reminder-event table the 工作事件 page reads from.
window.__testEventRows.clear();
window.__testEventRows.seed('w1', {
  id: 'w1', kind: 'work', title: '第一件事',
  occurred_at: '2026-05-01 10:00:00', category: 'work',
  contact_ids: [], contact_names: [], notes: '正文',
});
window.__testEventRows.seed('w2', {
  id: 'w2', kind: 'work', title: '第二件事',
  occurred_at: '2026-06-01 10:00:00', category: 'work',
  contact_ids: [], contact_names: [], notes: '正文',
});

// Navigate to the page — the router dispatches to the registered handler.
start();
navigate('/events/work');
await new Promise(r => setTimeout(r, 600));

out.pageLoaded = !!q('#work-list');
out.hasEnterLink = !!q('[data-bulk-enter]');
if (!out.hasEnterLink) {
  window.__result = out;
  window.__ready = true;
} else {
  // Enter select mode through the 「批量删除」 link.
  q('[data-bulk-enter]').click();
  await new Promise(r => setTimeout(r, 250));
  out.toolbarShown = !!q('[data-bulk-toolbar]');
  out.checkboxShown = !!q('.bulk-row-check');

  const exit = q('[data-bulk-exit]');
  out.exitExists = !!exit;
  out.exitHasHandler = !!(exit && exit.onclick);

  // ...and clicking it must actually leave select mode.
  if (exit) exit.click();
  await new Promise(r => setTimeout(r, 250));
  out.toolbarGone = !q('[data-bulk-toolbar]');
  out.checkboxGone = !q('.bulk-row-check');
  out.bulkLinkBack = !!q('[data-bulk-enter]');
  out.newBack = !!q('#new-event');
  out.rows = document.querySelectorAll('#work-list .card').length;

  window.__result = out;
}
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

  const checks = [
    ['the page loaded', result.pageLoaded === true],
    ['the page carries a bulk entry link', result.hasEnterLink === true],
    ['select mode shows the bulk toolbar', result.toolbarShown === true],
    ['select mode puts a checkbox on each row', result.checkboxShown === true],
    ['the exit button is on the page', result.exitExists === true],
    ['the exit button is wired to a handler', result.exitHasHandler === true],
    ['leaving select mode takes the toolbar away', result.toolbarGone === true],
    ['leaving select mode takes the checkboxes away', result.checkboxGone === true],
    ['the bulk entry link comes back', result.bulkLinkBack === true],
    ['the new button comes back', result.newBack === true],
    ['the rows survive the round trip', result.rows >= 1],
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
