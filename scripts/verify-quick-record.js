// scripts/verify-quick-record.js — checks the 快速记录 (quick-record) flow.
//
// The quick-record window is the pet's right-click → 📝 记录 path. It
// writes through the SAME ipcMain handlers the main window uses, so what
// matters is that the payload shapes the quick-record form builds are
// accepted by those handlers and land in the right tables with the right
// columns.
//
// This runs under Electron (the handlers live behind `ipcMain.handle`, so
// they only exist inside an Electron main process) against a THROWAWAY
// database, so it never touches the user's real data.
//
// Run: node scripts/run-electron.js scripts/verify-quick-record.js

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Let the app reach 'ready' without opening a window.
app.disableHardwareAcceleration();

// ---- Temp DB ------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-qr-'));
const dbPath = path.join(tmpDir, 'test.db');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`);
  }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// A YYYY-MM-DD date `days` in the future. Used for reminder anchors: a
// one-time event whose date has passed has no next fire time, so the
// scheduling assertions need a future anchor.
function futureYmd(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

app.whenReady().then(async () => {
  const db = require(path.join(__dirname, '..', 'main', 'db'));
  await db.open(dbPath);

  // Register the real handlers. `queue` is only used by the delete paths,
  // which this script doesn't exercise, but we pass a minimal stub so the
  // registration doesn't blow up on a missing dependency.
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

  // A handler is registered via ipcMain.handle; call it directly the same
  // way the renderer would (through ipcRenderer.invoke).
  const call = (channel, ...args) => ipcMain._invokeHandlers.get(channel)(null, ...args);

  console.log('\n== setup: a contact to attach records to ==');
  const contact = await call('contacts:create', {
    name: '测试联系人',
    relationship: '朋友',
  });
  checkTrue('contact created', !!(contact && contact.id), JSON.stringify(contact));

  // ---- 喜好 / 忌讳 / 礼物 ----------------------------------------------
  //
  // These are `contact_attributes` rows. The quick-record form sends
  // { contact_id, kind, description, event } — the same shape the main
  // window's attributes form sends.
  console.log('\n== 喜好 (like) ==');
  const like = await call('attributes:create', {
    contact_id: contact.id,
    kind: 'like',
    description: '抹茶甜点',
    event: '2026-10-26',
  });
  checkTrue('like row created', !!(like && like.id));
  check('like kind', like.kind, 'like');
  check('like description', like.description, '抹茶甜点');
  check('like event', like.event, '2026-10-26');
  check('like contact', like.contact_id, contact.id);
  check('like joined contact_name', like.contact_name, '测试联系人');

  console.log('\n== 忌讳 (taboo) ==');
  const taboo = await call('attributes:create', {
    contact_id: contact.id,
    kind: 'taboo',
    description: '不要提前任',
    event: '2026-10-26',
  });
  check('taboo kind', taboo.kind, 'taboo');
  check('taboo description', taboo.description, '不要提前任');

  console.log('\n== 礼物 (gift) ==');
  const gift = await call('attributes:create', {
    contact_id: contact.id,
    kind: 'gift',
    description: '手冲咖啡礼盒',
    event: '2026-10-26',
  });
  check('gift kind', gift.kind, 'gift');
  check('gift description', gift.description, '手冲咖啡礼盒');

  // The three kinds must not bleed into each other.
  const likeRows = await call('attributes:list', 'like');
  const tabooRows = await call('attributes:list', 'taboo');
  const giftRows = await call('attributes:list', 'gift');
  check('like list has 1 row', likeRows.length, 1);
  check('taboo list has 1 row', tabooRows.length, 1);
  check('gift list has 1 row', giftRows.length, 1);

  // A missing contact must be rejected — the quick-record form relies on
  // this (it shows "请选择联系人" before calling).
  console.log('\n== 喜好 without a contact is rejected ==');
  let attrErr = null;
  try {
    await call('attributes:create', { contact_id: '', kind: 'like', description: 'x' });
  } catch (e) { attrErr = e; }
  checkTrue('empty contact_id rejected', !!attrErr, 'no error thrown');

  // ---- 提醒日期 (reminder → events, category 'general') ---------------
  //
  // The anchor date is in the FUTURE on purpose: a one-time event whose
  // date has already passed has no next fire time (it would never fire
  // again), and computeNextFireEvent correctly returns null for it.
  console.log('\n== 提醒日期 (reminder) ==');
  const future = futureYmd(30);
  const reminder = await call('events:create', {
    title: '打电话确认一下',
    description: '打电话确认一下',
    contact_id: contact.id,
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: future,
    category: 'general',
    tag_kind: null,
    lunar_month: null,
    lunar_day: null,
  });
  checkTrue('reminder row created', !!(reminder && reminder.id));
  check('reminder category', reminder.category, 'general');
  check('reminder remind_kind', reminder.remind_kind, 'one_time');
  check('reminder remind_date', reminder.remind_date, future);
  check('reminder remind_time', reminder.remind_time, '09:00');
  check('reminder contact', reminder.contact_id, contact.id);
  check('reminder title', reminder.title, '打电话确认一下');
  checkTrue('reminder has next_fire_at', !!reminder.next_fire_at, String(reminder.next_fire_at));

  // ---- 工作事件 (work → events, category 'work') -----------------------
  console.log('\n== 工作事件 (work) ==');
  const work = await call('events:create', {
    title: '周会',
    description: '周会',
    contact_id: null,
    remind: true,
    remind_kind: 'weekly',
    remind_time: '10:00',
    remind_date: future,
    category: 'work',
    tag_kind: null,
    lunar_month: null,
    lunar_day: null,
  });
  check('work category', work.category, 'work');
  check('work remind_kind', work.remind_kind, 'weekly');
  check('work contact is null', work.contact_id, null);

  // The two event categories must stay separate on the list pages.
  const generalRows = await call('events:list', { category: 'general' });
  const workRows = await call('events:list', { category: 'work' });
  checkTrue('general list has the reminder', generalRows.some((e) => e.id === reminder.id));
  checkTrue('general list excludes work', !generalRows.some((e) => e.id === work.id));
  checkTrue('work list has the work event', workRows.some((e) => e.id === work.id));
  checkTrue('work list excludes the reminder', !workRows.some((e) => e.id === reminder.id));

  // ---- 农历 (lunar) reminders ------------------------------------------
  //
  // The quick-record form offers the same 阳历 / 农历 switch as the main
  // window, so the lunar path must work through the same handler.
  console.log('\n== 农历提醒 (lunar) ==');
  const lunar = await call('events:create', {
    title: '',
    description: '中秋节',
    contact_id: contact.id,
    remind: true,
    remind_kind: 'yearly',
    remind_time: '09:00',
    remind_date: null,
    category: 'general',
    tag_kind: null,
    lunar_month: 8,
    lunar_day: 15,
  });
  check('lunar month stored', lunar.lunar_month, 8);
  check('lunar day stored', lunar.lunar_day, 15);
  check('lunar event has no solar anchor', lunar.remind_date, null);
  checkTrue('lunar event has a next_fire_at', !!lunar.next_fire_at, String(lunar.next_fire_at));
  // With no title the server derives one from the contact name, exactly
  // like the main window's form does.
  check('lunar title derived from the contact', lunar.title, '测试联系人的提醒');

  // An impossible lunar pair must be rejected with a clear message.
  let lunarErr = null;
  try {
    await call('events:create', {
      title: 'x', description: 'x', category: 'general',
      remind: true, remind_kind: 'yearly', remind_time: '09:00',
      remind_date: null, lunar_month: 13, lunar_day: 15,
    });
  } catch (e) { lunarErr = e; }
  checkTrue('an out-of-range lunar month is rejected', !!lunarErr, 'no error thrown');

  // ---- 回忆事件 (memorial → memorial_events) --------------------------
  console.log('\n== 回忆事件 (memorial) ==');
  const memorial = await call('memorial_events:create', {
    kind: 'first_time',
    title: '第一次去迪士尼',
    place: '迪士尼乐园',
    food: '米奇造型蛋糕',
    outfit: null,
    activities: null,
    notes: '排了三个小时的队',
    occurred_at: '2026-10-26 14:30:00',
    contact_ids: [contact.id],
  });
  checkTrue('memorial row created', !!(memorial && memorial.id));
  check('memorial kind', memorial.kind, 'first_time');
  check('memorial title', memorial.title, '第一次去迪士尼');
  check('memorial place', memorial.place, '迪士尼乐园');
  check('memorial food', memorial.food, '米奇造型蛋糕');
  check('memorial notes', memorial.notes, '排了三个小时的队');
  check('memorial occurred_at', memorial.occurred_at, '2026-10-26 14:30:00');
  check('memorial contact_ids', memorial.contact_ids, [contact.id]);
  check('memorial contact_names', memorial.contact_names, ['测试联系人']);

  // Empty free-text fields must become NULL, not empty strings.
  const sparse = await call('memorial_events:create', {
    kind: 'other',
    title: '随手记一笔',
    place: '',
    food: '',
    outfit: '',
    activities: '',
    notes: '',
    occurred_at: '2026-10-26 09:00:00',
    contact_ids: [],
  });
  check('sparse memorial place is null', sparse.place, null);
  check('sparse memorial notes is null', sparse.notes, null);
  check('sparse memorial contact_ids', sparse.contact_ids, []);

  // ---- Search index ----------------------------------------------------
  //
  // A record that can't be found by search isn't really recorded. Every
  // write path must be reachable from the search page.
  console.log('\n== search index ==');
  // `search:query` returns bucketed results: { contacts, events,
  // memorial_events, important_dates }. A like / taboo / gift is indexed
  // under its CONTACT (the search body is the contact's name +
  // relationship + all its attribute descriptions), so it surfaces in the
  // `contacts` bucket.
  const likeHits = await call('search:query', '抹茶');
  checkTrue('like is searchable (via its contact)',
    likeHits.contacts.some((c) => c.id === contact.id),
    JSON.stringify(likeHits.contacts).slice(0, 200));
  const memHits = await call('search:query', '迪士尼');
  checkTrue('memorial is searchable',
    memHits.memorial_events.some((m) => m.id === memorial.id),
    JSON.stringify(memHits.memorial_events).slice(0, 200));
  const evHits = await call('search:query', '周会');
  checkTrue('work event is searchable',
    evHits.events.some((e) => e.id === work.id),
    JSON.stringify(evHits.events).slice(0, 200));
  const giftHits = await call('search:query', '手冲咖啡');
  checkTrue('gift is searchable (via its contact)',
    giftHits.contacts.some((c) => c.id === contact.id),
    JSON.stringify(giftHits.contacts).slice(0, 200));

  // ---- The record kinds exposed to the menu ----------------------------
  console.log('\n== quick-record window ==');
  const quickRecord = require(path.join(__dirname, '..', 'main', 'quick_record'));
  const kindIds = quickRecord.RECORD_KINDS.map((k) => k.id);
  check('six record kinds', kindIds.length, 6);
  check('kinds', kindIds, ['like', 'taboo', 'gift', 'reminder', 'memorial', 'work']);
  checkTrue('every kind has an icon + label',
    quickRecord.RECORD_KINDS.every((k) => k.icon && k.label));

  // ---- The context menu exposes the 记录 submenu ------------------------
  console.log('\n== context menu ==');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc.js'), 'utf8');
  checkTrue('menu has a 记录 entry', ipcSrc.includes("label: '📝 记录'"));
  checkTrue('menu builds the submenu from RECORD_KINDS',
    ipcSrc.includes('quickRecord.RECORD_KINDS.map'));
  checkTrue('the 记录 entry is the first actionable row',
    ipcSrc.indexOf("label: '📝 记录'") < ipcSrc.indexOf("label: '🥰 摸一下'"));

  // ---- The window's page + preload wiring ------------------------------
  console.log('\n== wiring ==');
  const root = path.join(__dirname, '..');
  checkTrue('quick_record.html exists', fs.existsSync(path.join(root, 'src', 'quick_record.html')));
  checkTrue('quick_record.js exists', fs.existsSync(path.join(root, 'src', 'js', 'quick_record.js')));
  checkTrue('quick_record.css exists', fs.existsSync(path.join(root, 'src', 'css', 'quick_record.css')));
  const preloadSrc = fs.readFileSync(path.join(root, 'main', 'preload.js'), 'utf8');
  checkTrue('preload exposes quickRecord.getKind', preloadSrc.includes('quickRecord:'));
  checkTrue('preload has the get_kind handler', preloadSrc.includes("'quick-record:get_kind'"));
  const qrSrc = fs.readFileSync(path.join(root, 'src', 'js', 'quick_record.js'), 'utf8');
  checkTrue('renderer pulls the kind on boot', qrSrc.includes('quickRecord.getKind'));
  // Every kind the menu offers must have a form in the renderer.
  checkTrue('renderer defines all six kinds',
    ['like', 'taboo', 'gift', 'reminder', 'memorial', 'work']
      .every((k) => qrSrc.includes(`${k}: {`)));

  // ---- Cleanup ---------------------------------------------------------
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('verify-quick-record crashed:', e);
  process.exit(1);
});
