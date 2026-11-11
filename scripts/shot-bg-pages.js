// scripts/shot-bg-pages.js — render the three pages that wear the shared
// background artwork, with sample rows, so the result can be looked at.
//
// The seed data is written straight into the temp DB — the point of the shot
// is the *styling*, so a handful of realistic rows is all it needs.
//
// Usage: node scripts/run-electron.js scripts/shot-bg-pages.js [outDir]

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler'));
const ipc = require(path.join(ROOT, 'main', 'ipc.js'));
const pageBackground = require(path.join(ROOT, 'main', 'page_background.js'));

const OUT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'soulpet-bgpages');

const PAGES = ['/contacts', '/reminders'];

// The 新建提醒 page wears the same artwork as the list it belongs to.
// It is shot separately from PAGES because it needs its own wait
// condition (its h1 is 新建提醒, and the festival picker has to be
// revealed before the shot).
const FORM_ROUTE = '/events/new?category=general';

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-bgpages-'));
  await db.open(path.join(dir, 'test.sqlite'));
  pageBackground.invalidate();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- seed ------------------------------------------------------------
  const now = db.nowStr();
  const contacts = [
    ['c1', '林小满', '女友',   'heart'],
    ['c2', '周叙白', '同事',   'briefcase'],
    ['c3', '苏念',   '挚友',   'user'],
    ['c4', '陈屿',   '父亲',   'user'],
    ['c5', '何雨桐', '客户',   'briefcase'],
  ];
  for (const [id, name, rel, icon] of contacts) {
    db.run(
      `INSERT INTO contacts(id, name, relationship, icon_kind, custom_avatar_path,
                            likes_json, taboos_json, gifts_json,
                            listed, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, '[]', '[]', '[]', 1, ?, ?)`,
      [id, name, rel, icon, now, now]);
  }

  // A few 提醒 rows (category='general') and 工作事件 rows
  // (category='work'), spread over the near future so the countdown chips
  // show something other than "就是今天". The work rows are not on their
  // own page any more — the 提醒 page's 工作事件 类型 lists them.
  const events = [
    ['e1', 'general', '林小满的生日',     'c1', 'birthday',    12,  '一起吃顿好的'],
    ['e2', 'general', '结婚纪念日',       'c1', 'anniversary', 40,  '第三十年'],
    ['e3', 'general', '周叙白的生日',     'c2', 'birthday',    3,   ''],
    ['e4', 'general', '苏念的生日',       'c3', 'birthday',    25,  ''],
    ['e5', 'work',    '季度述职',         '',  '',            9,   '整理 Q3 的项目复盘与下季度目标'],
    ['e6', 'work',    '周报',             'c2', '',            2,   '提交本周周报'],
    ['e7', 'work',    '和何雨桐对接需求', 'c5', '',           17,   '确认 Q4 的功能范围与排期'],
  ];
  for (const [id, cat, title, cid, tag, days, desc] of events) {
    const d = new Date(Date.now() + days * 86400000);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const fire = `${ymd} 09:00`;
    db.run(
      `INSERT INTO events(id, category, title, description, contact_id, tag_kind,
                          remind, remind_kind, remind_date, next_fire_at,
                          active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'yearly', ?, ?, 1, ?, ?)`,
      [id, cat, title, desc, cid || null, tag || null, ymd, fire, now, now]);
  }

  // ---- window ----------------------------------------------------------
  const winMain = new BrowserWindow({
    width: 1280,
    height: 860,
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
    petRegistry: {
      list: () => [],
      getManifest: () => null,
      resolveFrames: () => ({ frames: [], variantHint: '', loop: true }),
      getPortrait: () => null,
      isImported: () => false,
      getRootDir: () => '',
      rescan: () => {},
    },
  });

  await winMain.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  await winMain.webContents.executeJavaScript(`document.body.classList.remove('locked'); true`);

  winMain.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer] ${message}`);
  });

  for (const p of PAGES) {
    await winMain.webContents.executeJavaScript(`location.hash = '#${p}'; true`);
    // Wait until the page's own <h1> is the one we expect, THEN wait for a
    // paint. capturePage() grabs whatever is on screen at that instant, and
    // the DOM can be updated a frame or two before the compositor shows it.
    await winMain.webContents.executeJavaScript(`(async () => {
      const want = ${JSON.stringify(p)};
      const label = ${JSON.stringify(p === '/contacts' ? '联系人' : '提醒')};
      for (let i = 0; i < 60; i++) {
        const h1 = document.querySelector('#app h1');
        if (h1 && h1.textContent.includes(label)) {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    const landed = await winMain.webContents.executeJavaScript('location.hash');
    const head = await winMain.webContents.executeJavaScript(
      `document.querySelector('#app h1') ? document.querySelector('#app h1').textContent.trim() : '(no h1)'`);
    const name = p.replace(/\//g, '-').replace(/^-/, '') || 'root';
    const file = path.join(OUT_DIR, `${name}.png`);
    const shot = await winMain.webContents.capturePage();
    fs.writeFileSync(file, shot.toPNG());
    console.log(`wrote ${file}  (hash=${landed}, h1=${head})`);
  }

  // ---- the 新建提醒 form ----------------------------------------------
  //
  // Two shots: the form as it opens (类型 = (无)), and the form with
  // 类型 = 节日 chosen, so the festival picker and the hidden repeat /
  // date controls can both be seen.
  await winMain.webContents.executeJavaScript(`location.hash = '#${FORM_ROUTE}'; true`);
  await winMain.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 60; i++) {
      const h1 = document.querySelector('#app h1');
      if (h1 && h1.textContent.includes('新建提醒')) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  const formShot = await winMain.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'events-new.png'), formShot.toPNG());
  console.log(`wrote ${path.join(OUT_DIR, 'events-new.png')}`);

  // Pick 节日 and reveal the picker.
  await winMain.webContents.executeJavaScript(`(async () => {
    const sel = document.querySelector('#e-tag-kind');
    if (!sel) return 'no dropdown';
    sel.value = 'festival';
    sel.dispatchEvent(new Event('change'));
    const f = document.querySelector('#e-festival');
    if (f && f.options.length > 1) f.selectedIndex = 1;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const festShot = await winMain.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'events-new-festival.png'), festShot.toPNG());
  console.log(`wrote ${path.join(OUT_DIR, 'events-new-festival.png')}`);

  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
