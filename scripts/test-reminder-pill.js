// scripts/test-reminder-pill.js — end-to-end check for the main window's
// 桌宠提醒 pill.
//
// The bug this guards against: the pill showed the pet's nag count
// ("桌宠提醒（1）") and looked like a button, but it was a plain <div> —
// clicking it did nothing at all. There was no way to reach the reminder
// UI from the top bar.
//
// This drives the REAL main window (src/index.html with the REAL
// preload) and the REAL IPC handlers, because the failure was in the seam
// between them: the renderer has to know it is a button, and the click
// has to reach a handler that can list the pending reminders.
//
// Usage: node scripts/run-electron.js scripts/test-reminder-pill.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const { buildPetState } = require(path.join(ROOT, 'main', 'pet_state.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

app.whenReady().then(async () => {
  console.log('reminder pill end-to-end test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-pill-'));
  await db.open(path.join(dir, 'test.sqlite'));

  const queue = new scheduler.ReminderQueue();
  queue.pushIfNew({
    source: 'event',
    source_id: 1,
    title: '刘杰的生日',
    description: '买蛋糕',
    contact_id: null,
    contact_name: '小绮',
    next_fire_at: db.nowStr(),
    kind: 'event',
    remind_kind: 'one_time',
    category: 'general',
  });

  let petState = true;
  let winMain = null;
  const broadcastPetState = () => {
    const payload = buildPetState({ petState, queue });
    if (winMain && !winMain.isDestroyed()) {
      winMain.webContents.send('pet:state-changed', payload);
    }
  };
  queue.on(() => broadcastPetState());

  winMain = new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ipc.register({
    queue,
    winMain,
    winPet: null,
    setPetState: (v) => { petState = !!v; },
    getPetState: () => petState,
    setActiveReminder: () => {},
    broadcastPetState,
    petController: null,
    // A minimal registry so the pages that list the installed pets have
    // something to talk to (the real app passes a full PetRegistry).
    petRegistry: {
      list: () => [],
      getManifest: () => null,
      resolveFrames: () => ({ frames: [], variantHint: '', loop: true }),
      isImported: () => false,
      getRootDir: () => '',
      rescan: () => {},
    },
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 500));

  // -------------------------------------------------------------------------
  // Test 1 — the pill shows the pet's nag count
  // -------------------------------------------------------------------------
  console.log('\n[1] the pill shows the pending count');
  const pill = await winMain.webContents.executeJavaScript(`(() => ({
    tag: document.getElementById('pet-pill').tagName,
    text: document.getElementById('pet-pill-text').textContent,
    remind: document.getElementById('pet-pill').classList.contains('remind'),
  }))()`);
  eq('the pill is a button', pill.tag, 'BUTTON');
  eq('the pill shows the count', pill.text, '桌宠提醒（1）');
  check('the pill is in its reminder state', pill.remind);

  // -------------------------------------------------------------------------
  // Test 2 — clicking the pill opens the reminder
  // -------------------------------------------------------------------------
  console.log('\n[2] clicking the pill opens the reminder');
  const modal = await winMain.webContents.executeJavaScript(`(async () => {
    // The window is PIN-locked on boot; the lock hides the top bar, so the
    // click is simulated on an unlocked window.
    document.body.classList.remove('locked');
    document.getElementById('pet-pill').click();
    await new Promise((r) => setTimeout(r, 100));
    const m = document.getElementById('reminder-modal');
    return {
      hidden: m.classList.contains('hidden'),
      title: document.getElementById('reminder-title').textContent,
      desc: document.getElementById('reminder-description').textContent,
      hasDone: !!document.getElementById('r-done'),
      hasSnooze: !!document.getElementById('r-snooze'),
    };
  })()`);
  check('the modal is open', !modal.hidden);
  eq('it shows the reminder title', modal.title, '刘杰的生日');
  eq('it shows the description', modal.desc, '买蛋糕');
  check('it offers 完成', modal.hasDone);
  check('it offers 稍后', modal.hasSnooze);

  // -------------------------------------------------------------------------
  // Test 3 — 完成 in the modal closes the reminder
  // -------------------------------------------------------------------------
  console.log('\n[3] 完成 closes the reminder');
  await winMain.webContents.executeJavaScript(
    `document.getElementById('r-done').click(); true`
  );
  await new Promise((r) => setTimeout(r, 300));
  eq('the queue has no active reminder left', queue.activeCount(), 0);
  eq('the item is still in the queue', queue.list().length, 1);
  check('the item is marked completed for today', queue.list()[0].dismissed_for_today === true);
  const acks = db.all('SELECT * FROM reminder_acks WHERE source = ? AND source_id = ?', ['event', 1]);
  eq('an ack row was written', acks.length, 1);

  // -------------------------------------------------------------------------
  // Test 4 — with nothing pending, the pill goes back to normal
  // -------------------------------------------------------------------------
  console.log('\n[4] the pill goes back to normal');
  broadcastPetState();
  await new Promise((r) => setTimeout(r, 200));
  const after = await winMain.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('pet-pill-text').textContent,
    remind: document.getElementById('pet-pill').classList.contains('remind'),
  }))()`);
  eq('the pill reads 桌宠正常', after.text, '桌宠正常');
  check('the reminder styling is gone', !after.remind);

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(failures.length ? 1 : 0);
}).catch((e) => {
  console.error('test crashed:', e);
  app.exit(1);
});
