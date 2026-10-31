// scripts/preview-memorial-cards.js — renders the 回忆事件 card list to a
// PNG so the layout can be eyeballed without a full app session.
//
// Run: node scripts/run-electron.js scripts/preview-memorial-cards.js
//
// Writes scripts/.memorial-cards-preview.png (a scratch file — delete it
// after looking at it).

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

const SRC = path.join(__dirname, '..', 'src');
const probePath = path.join(SRC, '.memorial-cards-preview.html');
const outPath = path.join(__dirname, '.memorial-cards-preview.png');

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./css/styles.css"></head><body>
<main id="app" class="content"></main><div id="toast-container"></div>
<script type="module">
const list = await import('./js/pages/events_memorial.js');

// A real PNG for each photo, so the preview shows actual pictures
// instead of empty boxes. The canvas hands back a data URL.
function photoDataUrl(from, to, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return c.toDataURL('image/png');
}

const P = {
  pa: photoDataUrl('#4a6b8a', '#c9b458', 320, 200),
  pb: photoDataUrl('#2d6a6a', '#8fd0c0', 320, 420),
  pc: photoDataUrl('#b98d5a', '#f0d9b5', 320, 240),
};

// The photos are served by the fake photo reader in the preload. Seed
// the real bytes there, so the renderer reads them through the same IPC
// call it uses in the app.
for (const [id, url] of Object.entries(P)) window.__testPhotos.set(id, url);

const ROWS = [
  {
    id: 'r1', kind: 'first_time', title: '第一次去海边',
    occurred_at: '2026-05-01 10:30:00', background: 'helena',
    contact_names: ['小明', '小红'], photo_count: 3,
    photo_ids: ['pa', 'pb', 'pc'],
    content: JSON.stringify([
      { type: 'text', text: '海风很大，浪声一直没停。她把鞋提在手里，光脚踩在被太阳晒热的沙滩上。' },
      { type: 'gallery', layout: 'two', photos: [{ photo_id: 'pa' }, { photo_id: 'pb' }] },
      { type: 'text', text: '傍晚风凉下来，我们沿着海岸线慢慢走回旅馆。她把鞋重新穿好，说下次要带一件外套。' },
    ]),
  },
  {
    id: 'r2', kind: 'other', title: '搬家那天',
    occurred_at: '2026-03-18 09:00:00', background: 'shadow',
    contact_names: ['阿伟'], photo_count: 1, photo_ids: ['pa'],
    content: JSON.stringify([
      { type: 'text', text: '箱子比想象中重。搬完最后一个，房间里空得能听见回声。' },
      { type: 'gallery', layout: 'one', photos: [{ photo_id: 'pa' }] },
    ]),
  },
  {
    id: 'r3', kind: 'other', title: '一起看的第一场电影',
    occurred_at: '2026-01-22 19:40:00', background: 'light',
    contact_names: [], photo_count: 0, photo_ids: [],
    content: JSON.stringify([
      { type: 'text', text: '散场的时候外面在下雨。我们在便利店门口站了很久，谁都没提要走。' },
    ]),
  },
  {
    id: 'r4', kind: 'other', title: '夏天的旧照片',
    occurred_at: '2025-07-30 14:00:00', background: 'shiro',
    contact_names: ['小明', '小红', '阿伟'], photo_count: 3,
    photo_ids: ['pa', 'pb', 'pc'],
    content: JSON.stringify([
      { type: 'gallery', layout: 'grid', photos: [
        { photo_id: 'pa' }, { photo_id: 'pb' }, { photo_id: 'pc' } ] },
      { type: 'text', text: '那天的风很暖。' },
    ]),
  },
  {
    // A long entry — the card has to clip it and fade the cut off.
    id: 'r5', kind: 'first_time', title: '一整年的记录',
    occurred_at: '2025-12-31 23:00:00', background: 'poonam',
    contact_names: ['小明'], photo_count: 2,
    photo_ids: ['pa', 'pb'],
    content: JSON.stringify([
      { type: 'text', text: '这一年过得很长。春天有很长很长的雨季，夏天热得让人发昏，秋天来得比想象中快。' },
      { type: 'gallery', layout: 'two', photos: [{ photo_id: 'pa' }, { photo_id: 'pb' }] },
      { type: 'text', text: '发生了很多事。有些记得清楚，有些已经想不起来了，还有很多当时以为很重要，如今已经想不起为什么。' },
      { type: 'text', text: '如果要给这一年写一句话，大概是：没有发生什么大事，但也没有哪一天是真的白过的。' },
      { type: 'text', text: '明年的愿望和今年差不多：睡好觉，少熬夜，多走路，把想做的事做完一半就好。' },
    ]),
  },
  {
    // The case the user called 割裂: short text, a big photo, more text.
    // The photo must sit in the same flow as the words, not float apart
    // from them.
    id: 'r6', kind: 'other', title: '那天打的一场球',
    occurred_at: '2026-10-31 15:00:00', background: 'light',
    contact_names: [], photo_count: 1, photo_ids: ['pa'],
    content: JSON.stringify([
      { type: 'text', text: '文字' },
      { type: 'gallery', layout: 'one', photos: [{ photo_id: 'pa' }] },
      { type: 'text', text: '打法' },
    ]),
  },
];

for (const row of ROWS) window.__testRows.seed(row.id, row);

await list.render([], {});
await new Promise(r => setTimeout(r, 400));

// Enter select mode, so the shot shows the checkbox layout too.
const enter = document.querySelector('[data-bulk-enter]');
if (enter) enter.click();
await new Promise(r => setTimeout(r, 300));
window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  fs.writeFileSync(probePath, PROBE_HTML);

  const win = new BrowserWindow({
    show: true,
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
  const state = await win.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('.memorial-card'));
    const photos = Array.from(document.querySelectorAll('.memorial-card-photo')).map(p => {
      const img = p.querySelector('img');
      const pr = p.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      const cs = getComputedStyle(img);
      return {
        box: Math.round(pr.width) + 'x' + Math.round(pr.height),
        img: Math.round(ir.width) + 'x' + Math.round(ir.height),
        natural: img.naturalWidth + 'x' + img.naturalHeight,
        widthStyle: p.style.width,
        // The painted area of the picture, after object-fit.
        fit: cs.objectFit + ' ' + cs.height + ' maxH=' + cs.maxHeight,
      };
    });
    const bodies = Array.from(document.querySelectorAll('.memorial-card-body')).map(b => {
      const r = b.getBoundingClientRect();
      return Math.round(r.width) + 'x' + Math.round(r.height)
        + ' scroll=' + b.scrollHeight;
    });
    // How each text block is clipped: a clamped block shows fewer lines
    // than it holds.
    const texts = Array.from(document.querySelectorAll('.memorial-card-text')).map(t => {
      const cs = getComputedStyle(t);
      return {
        lines: cs.webkitLineClamp,
        shown: Math.round(t.getBoundingClientRect().height),
        full: t.scrollHeight,
      };
    });
    return {
      cards: cards.length,
      sheets: cards.map(c => {
        const s = c.querySelector('.memorial-card-sheet').getBoundingClientRect();
        return Math.round(s.width) + 'x' + Math.round(s.height);
      }),
      bodies,
      texts,
      photos,
      withSrc: Array.from(document.querySelectorAll('.memorial-card-photo img'))
        .filter(i => i.src && i.src.startsWith('data:image')).length,
    };
  })()`);
  console.log('at capture:', JSON.stringify(state));
  await new Promise((r) => setTimeout(r, 800));

  // Scroll to the long entry, so the shot shows a card whose content is
  // cut off — the case the fade exists for.
  await win.webContents.executeJavaScript(`(() => {
    const card = Array.from(document.querySelectorAll('.memorial-card'))
      .find(c => c.textContent.includes('一整年的记录'));
    if (card) card.scrollIntoView({ block: 'center' });
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.writeFileSync(outPath, png);
  console.log('wrote', outPath, png.length, 'bytes');

  fs.unlinkSync(probePath);
  app.exit(0);
}).catch((e) => {
  console.error('preview failed:', e);
  try { fs.unlinkSync(probePath); } catch (_) {}
  app.exit(1);
});
