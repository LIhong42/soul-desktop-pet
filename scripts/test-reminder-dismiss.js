// scripts/test-reminder-dismiss.js — end-to-end check that the desktop
// pet's reminder can actually be closed.
//
// The bug this guards against: the pet's reminder had no way to be turned
// off. Clicking the pet hid its speech bubble and nothing else — so the
// badge kept counting, the sprite kept shaking and the top-bar pill kept
// reading 桌宠提醒 — and the bubble's own dismissal was dead code anyway
// (the pointer capture was released before the gesture state was cleared,
// so the click side effects never ran).
//
// The failure lived in the seam between the two halves, so this test drives
// both of them for real:
//
//   * the REAL renderer — src/pet.html with the REAL preload;
//   * the REAL IPC handlers — main/ipc.js.
//
// The renderer has to know WHICH reminder it is showing (source /
// source_id), and the main process has to turn that into a dismissal that
// really leaves the queue. A stubbed renderer would not catch a mismatch
// between the two.
//
// Usage: node scripts/run-electron.js scripts/test-reminder-dismiss.js

const { app, BrowserWindow, Menu } = require('electron');
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
// Module scope: the helpers below reach the pet window from outside the
// `whenReady` block.
let winPet = null;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

app.whenReady().then(async () => {
  console.log('reminder dismissal end-to-end test (real Electron)');

  // A throwaway database — never the user's data.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-dismiss-'));
  await db.open(path.join(dir, 'test.sqlite'));

  // The real queue, with one reminder in it.
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

  let petState = false;
  const broadcasts = [];

  // The scheduler flips the pet into REMINDER state when a reminder fires;
  // the renderer reads that state on boot.
  petState = true;

  // The real broadcast — the same payload builder main/main.js uses.
  const broadcastPetState = () => {
    const payload = buildPetState({ petState, queue });
    broadcasts.push(payload);
    if (winPet && !winPet.isDestroyed()) {
      winPet.webContents.send('pet:state-changed', payload);
    }
  };
  queue.on(() => broadcastPetState());

  // The pet window, with the REAL preload — the renderer talks to the main
  // process through the same bridge it uses in the app.
  winPet = new BrowserWindow({
    width: 220,
    height: 220,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'pet', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The handlers are registered BEFORE the page loads: the renderer reads
  // the pet's state on boot, and an invoke with no handler behind it
  // rejects.
  ipc.register({
    queue,
    winMain: null,
    winPet,
    setPetState: (v) => { petState = !!v; },
    getPetState: () => petState,
    setActiveReminder: () => {},
    broadcastPetState,
    petController: null,
    // A minimal registry so the renderer's frame requests have a handler
    // behind them (the real app passes a full PetRegistry).
    petRegistry: {
      list: () => [],
      getManifest: () => null,
      resolveFrames: () => ({ frames: [], variantHint: '', loop: true }),
      isImported: () => false,
      getRootDir: () => '',
      rescan: () => {},
    },
  });

  await winPet.loadFile(path.join(ROOT, 'src', 'pet.html'));

  // The renderer reads its state on boot, so give it a moment to paint.
  await new Promise((r) => setTimeout(r, 300));

  // -------------------------------------------------------------------------
  // Test 1 — the pet window knows it is nagging, and knows WHICH reminder
  // -------------------------------------------------------------------------
  console.log('\n[1] the pet window is told what it is nagging about');
  const painted = await winPet.webContents.executeJavaScript(`(() => ({
    badge: document.getElementById('pet-badge').textContent,
    badgeHidden: document.getElementById('pet-badge').classList.contains('hidden'),
    bubble: document.getElementById('pet-bubble').textContent,
    bubbleHidden: document.getElementById('pet-bubble').classList.contains('hidden'),
  }))()`);
  eq('the badge shows the count', painted.badge, '1');
  check('the badge is visible', !painted.badgeHidden);
  check('the bubble is visible', !painted.bubbleHidden);
  check('the bubble carries the reminder', painted.bubble.includes('刘杰的生日'), painted.bubble);

  // -------------------------------------------------------------------------
  // Test 2 — clicking the pet closes the reminder
  // -------------------------------------------------------------------------
  console.log('\n[2] clicking the pet closes the reminder');
  await winPet.webContents.executeJavaScript(`(() => {
    const sprite = document.getElementById('pet-sprite');
    const mk = (type) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0 });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      Object.defineProperty(ev, 'screenX', { value: 100 });
      Object.defineProperty(ev, 'screenY', { value: 100 });
      return ev;
    };
    sprite.dispatchEvent(mk('pointerdown'));
    window.dispatchEvent(mk('pointerup'));
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  eq('the queue has no active reminder left', queue.activeCount(), 0);
  eq('the item is still in the queue', queue.list().length, 1);
  check('the item is marked completed for today', queue.list()[0].dismissed_for_today === true);

  const last = broadcasts[broadcasts.length - 1];
  eq('the pet state went back to normal', last.state, 'NORMAL');
  eq('the count went to zero', last.count, 0);

  const acks = db.all('SELECT * FROM reminder_acks WHERE source = ? AND source_id = ?', ['event', 1]);
  eq('an ack row was written', acks.length, 1);

  const afterClick = await winPet.webContents.executeJavaScript(`(() => ({
    badgeHidden: document.getElementById('pet-badge').classList.contains('hidden'),
    bubbleHidden: document.getElementById('pet-bubble').classList.contains('hidden'),
  }))()`);
  check('the badge is gone', afterClick.badgeHidden);
  check('the bubble is gone', afterClick.bubbleHidden);

  // -------------------------------------------------------------------------
  // Test 3 — the right-click menu offers 关闭提醒, and it works
  // -------------------------------------------------------------------------
  console.log('\n[3] the pet menu can close the reminder too');
  queue.pushIfNew({
    source: 'important_date',
    source_id: 2,
    title: '妈妈生日',
    description: null,
    contact_id: null,
    contact_name: null,
    next_fire_at: db.nowStr(),
    kind: 'birthday',
    remind_kind: null,
    category: null,
    days_left: 3,
  });
  eq('the new reminder is pending', queue.activeCount(), 1);

  // Capture the menu template instead of showing it.
  const realBuild = Menu.buildFromTemplate;
  let template = null;
  Menu.buildFromTemplate = (tpl) => { template = tpl; return { popup: () => {} }; };
  try {
    await openContextMenu();
  } finally {
    Menu.buildFromTemplate = realBuild;
  }

  check('the menu was built', Array.isArray(template));
  const closeItem = (template || []).find((i) => i && typeof i.label === 'string' && i.label.includes('关闭提醒'));
  check('the menu has a 关闭提醒 entry', !!closeItem, JSON.stringify((template || []).map((i) => i && i.label)));

  if (closeItem) {
    closeItem.click();
    await new Promise((r) => setTimeout(r, 100));
    eq('the reminder was closed', queue.activeCount(), 0);
    const acks2 = db.all('SELECT * FROM reminder_acks WHERE source = ? AND source_id = ?', ['important_date', 2]);
    eq('an ack row was written for it too', acks2.length, 1);
  }

  // -------------------------------------------------------------------------
  // Test 4 — with nothing pending, the menu does not offer the entry
  // -------------------------------------------------------------------------
  console.log('\n[4] no 关闭提醒 entry when nothing is pending');
  template = null;
  Menu.buildFromTemplate = (tpl) => { template = tpl; return { popup: () => {} }; };
  try {
    await openContextMenu();
  } finally {
    Menu.buildFromTemplate = realBuild;
  }
  const closeItem2 = (template || []).find((i) => i && typeof i.label === 'string' && i.label.includes('关闭提醒'));
  check('the entry is gone', !closeItem2);

  // ---- Report ----
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

// ---------------------------------------------------------------------------
// Open the pet's right-click menu through the real IPC path.
//
// `ipcMain` has no "call this handler" API, so the handler is reached the
// same way the app reaches it: through a renderer. The pet window is
// loaded with the real preload, and `mp.pet.openContextMenu` is one of
// the channels it exposes.
// ---------------------------------------------------------------------------
async function openContextMenu() {
  return winPet.webContents.executeJavaScript(`window.mp.pet.openContextMenu()`);
}
