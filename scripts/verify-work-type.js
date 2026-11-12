// scripts/verify-work-type.js — checks the 工作 (work) type of the event
// form.
//
// 工作 is NOT a tag kind: it is a CATEGORY. The row lands in the
// 工作事件 list (category='work') and carries no tag_kind, which is why
// the 提醒 page's 类型 filter has always mixed a category sentinel into
// a tag-kind dropdown.
//
// Three things can go wrong, and each of them is silent:
//
//   1. The row is written with tag_kind='work' instead of
//      category='work' — it then shows up as an untagged reminder and
//      never in the 工作事件 list.
//   2. The row keeps a contact — a work event has no 关联联系人 field,
//      so a contact id can only be a leftover.
//   3. A row switched OUT of 节日 keeps the festival code as its title,
//      so the list shows a raw code like "fathers_day" instead of the
//      contact's name.
//
// The title derivation lives on the server (deriveEventTitle in
// main/ipc.js), so the checks drive the real IPC handlers.
//
// Run: node scripts/run-electron.js scripts/verify-work-type.js

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.disableHardwareAcceleration();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// The real handlers, driven the way the renderer drives them.
const call = (channel, ...args) => ipcMain._invokeHandlers.get(channel)(null, ...args);

app.whenReady().then(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-work-type-'));
  const dbPath = path.join(tmpDir, 'test.db');

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

  // A contact, so the title derivation has something to derive from.
  const contact = await call('contacts:create', {
    name: '小李',
    relationship: '同事',
  });

  console.log('\n== the 工作 option writes the work CATEGORY ==');

  // This is the payload the shared form module builds when the 类型
  // dropdown is on 工作 (see eventPayload in src/js/form_fields.js).
  const created = await call('events:create', {
    title: '写周报',
    description: '写周报',
    contact_id: null,
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: '2026-11-11',
    category: 'work',
    tag_kind: null,
  });
  check('the row lands in the work category', created.category, 'work');
  check('the row carries no tag kind', created.tag_kind, null);
  check('the row carries no contact', created.contact_id, null);
  check('the row keeps the description as its text', created.description, '写周报');

  console.log('\n== the work rows are listed as work rows ==');

  const workRows = await call('events:list', { category: 'work' });
  check('the work list holds the row', workRows.map((r) => r.id), [created.id]);
  // The 提醒 list must not hold the work row. It does hold other rows —
  // a fresh database is seeded with one row per built-in festival — so
  // the check is about THIS row, not about the list being empty.
  const generalRows = await call('events:list', { category: 'general' });
  check('the 提醒 list does not hold it',
    generalRows.some((r) => r.id === created.id), false);

  console.log('\n== a row switched out of 节日 gets a fresh title ==');

  // A festival row stores the festival CODE as its title. Switching the
  // 类型 away from 节日 must clear that code — otherwise the list shows
  // a raw code instead of the contact's name.
  const fest = await call('events:create', {
    title: 'fathers_day',
    description: '给爸爸打电话',
    contact_id: contact.id,
    remind: true,
    remind_kind: 'yearly',
    remind_time: '09:00',
    remind_date: null,
    category: 'general',
    tag_kind: 'festival',
  });
  check('the festival row stores the code as its title', fest.title, 'fathers_day');

  // The client sends an empty title when the label must change.
  const switched = await call('events:update', fest.id, {
    title: '',
    description: '给爸爸打电话',
    contact_id: contact.id,
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: '2026-11-11',
    category: 'general',
    tag_kind: null,
  });
  check('the stale festival code is gone', switched.title, '小李的提醒');
  check('the tag kind is cleared too', switched.tag_kind, null);

  console.log('\n== a row moved between the categories ==');

  // A work row has no contact, so its title is the description. Moving
  // it back to the 提醒 list must drop the stale work title and let the
  // server derive a fresh one.
  const moved = await call('events:update', created.id, {
    title: '',
    description: '写周报',
    contact_id: contact.id,
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: '2026-11-11',
    category: 'general',
    tag_kind: null,
  });
  check('the row is a reminder now', moved.category, 'general');
  check('the contact is stored now', moved.contact_id, contact.id);
  check('the title is derived from the contact', moved.title, '小李的提醒');

  console.log('\n== a work row keeps the description as its title ==');

  const work2 = await call('events:create', {
    title: '开会',
    description: '开会',
    contact_id: null,
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: '2026-11-12',
    category: 'work',
    tag_kind: null,
  });
  check('a work row titles itself with the description', work2.title, '开会');

  console.log('\n== work is not accepted as a tag kind ==');

  // The server must not accept 'work' as a tag kind: it is a category,
  // and a row with tag_kind='work' would show up as an untagged reminder
  // and never in the 工作事件 list.
  const bad = await call('events:create', {
    title: 'x', description: 'x', contact_id: null,
    remind: true, remind_kind: 'one_time', remind_time: '09:00',
    remind_date: '2026-11-12', category: 'general', tag_kind: 'work',
  });
  check('work is not accepted as a tag kind', bad.tag_kind, null);
  check('the row still lands in the general category', bad.category, 'general');

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  if (fail) process.exitCode = 1;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
  app.quit();
});
