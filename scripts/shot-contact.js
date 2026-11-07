// scripts/shot-contact.js — render the 联系人详情页 in the REAL main window
// and save a PNG, so the page's visual design can be checked without a human
// driving the app.
//
// It uses the real preload + the real IPC handlers and seeds a contact with
// one of everything the page shows (a banner, an important date, a dated
// event, a memorial event with a photo), so the shot exercises the real
// layout rather than an empty state.
//
// Usage: node scripts/run-electron.js scripts/shot-contact.js [outFile]

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));
const { PetRegistry } = require(path.join(ROOT, 'main', 'pet_registry.js'));

const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'contact-shot.png');

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-shot-'));
  await db.open(path.join(dir, 'test.sqlite'));

  pageBackground.invalidate();

  const petRegistry = new PetRegistry();
  await petRegistry.init({ appPath: ROOT, userDataPath: path.join(dir, 'userdata') });

  const winMain = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const queue = new scheduler.ReminderQueue();
  ipc.register({
    queue,
    winMain,
    winPet: null,
    setPetState: () => {},
    getPetState: () => false,
    setActiveReminder: () => {},
    broadcastPetState: () => {},
    petController: null,
    petRegistry,
  });

  // ---- Seed one contact with one of everything the page shows ----------
  const now = db.nowStr();
  const contactId = db.newId();
  db.run(
    `INSERT INTO contacts(id, name, relationship, icon_kind, likes_json, taboos_json,
                          gifts_json, listed, created_at, updated_at)
     VALUES (?, ?, ?, 'heart', '[]', '[]', '[]', 1, ?, ?)`,
    [contactId, '小绮', '女朋友', now, now]
  );
  const addAttr = (kind, desc, ev) => db.run(
    `INSERT INTO contact_attributes(id, contact_id, kind, description, event, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [db.newId(), contactId, kind, desc, ev, now, now]
  );
  addAttr('like', '喜欢抹茶甜点', '2025-11-20');
  addAttr('like', '喜欢散步', '2025-03-02');
  addAttr('like', '晨练后喝豆浆', '2024-05-12');
  addAttr('taboo', '不谈生意', '2025-08-01');
  addAttr('gift', '真丝围巾', '2025-12-20');
  db.run(
    `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                  remind_time, advance_days, remind_enabled, created_at, updated_at)
     VALUES (?, ?, '生日', 1, 3, 1998, 'birthday', '09:00', 7, 1, ?, ?)`,
    [db.newId(), contactId, now, now]
  );
  db.run(
    `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                        remind_time, remind_date, next_fire_at, active, category,
                        tag_kind, created_at, updated_at)
     VALUES (?, ?, '恋爱纪念日', '', 1, 'yearly', '09:00', '2024-08-19',
             '2027-08-19 09:00:00', 1, 'general', 'anniversary', ?, ?)`,
    [db.newId(), contactId, now, now]
  );
  const memorialId = db.newId();
  db.run(
    `INSERT INTO memorial_events(id, kind, title, place, food, outfit, activities,
                                  notes, occurred_at, created_at, updated_at)
     VALUES (?, 'first_time', '第一次一起看海', '青岛', '海鲜', ?, '看海、吹风',
             '那天的风很大，但她笑得很开心。', '2025-10-31 17:55:00', ?, ?)`,
    [memorialId, '浅蓝连衣裙', now, now]
  );
  db.run(
    `INSERT INTO memorial_event_contacts(memorial_event_id, contact_id, created_at)
     VALUES (?, ?, ?)`,
    [memorialId, contactId, now]
  );

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  // A photo for the memorial row. The bytes go in through the real IPC
  // handler, so the tile shows what the user would really see.
  const photoBytes = Array.from(
    fs.readFileSync(path.join(ROOT, 'resources', 'ui', 'user-detail-background.png')));
  await winMain.webContents.executeJavaScript(`(async () => {
    await window.mp.memorialEvents.photos.upload(${JSON.stringify(memorialId)}, {
      filename: 'sea.png', mime: 'image/png', bytes: ${JSON.stringify(photoBytes)},
    });
    return true;
  })()`);

  await winMain.webContents.executeJavaScript(`location.hash = '#/contacts/${contactId}'; true`);
  await new Promise((r) => setTimeout(r, 3000));

  const shot = await winMain.webContents.capturePage();
  fs.writeFileSync(OUT, shot.toPNG());
  console.log('wrote ' + OUT);

  // The 喜好 tab, so the tab body's card styling is visible too.
  await winMain.webContents.executeJavaScript(`location.hash = '#/contacts/${contactId}/likes'; true`);
  await new Promise((r) => setTimeout(r, 1200));
  const tabShot = await winMain.webContents.capturePage();
  const tabOut = path.join(path.dirname(OUT), 'contact-likes.png');
  fs.writeFileSync(tabOut, tabShot.toPNG());
  console.log('wrote ' + tabOut);

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
