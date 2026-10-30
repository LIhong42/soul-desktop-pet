// scripts/preview-diary-editor.js — renders the diary editor to a PNG so the
// layout can be eyeballed without a full app session.
//
// Run: node scripts/run-electron.js scripts/preview-diary-editor.js
//
// Writes scripts/.diary-preview.png (a scratch file — delete it after
// looking at it).

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

const SRC = path.join(__dirname, '..', 'src');
const probePath = path.join(SRC, '.diary-preview.html');
const outPath = path.join(__dirname, '.diary-preview.png');

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./css/styles.css"></head><body>
<main id="app" class="content"></main><div id="toast-container"></div>
<script type="module">
const editor = await import('./js/pages/diary_edit.js');
await editor.render({}, {});
document.getElementById('diary-title').value = '第一次去海边';
document.getElementById('diary-occurred').value = '2026-05-01T10:30';

// A real PNG, so the preview shows an actual picture. The canvas hands
// back a data URL, so decode it back into bytes — a File built from the
// URL *string* would contain text, not an image.
function makePhoto(name, from, to, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const b64 = c.toDataURL('image/png').split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: 'image/png' });
}

// Fill in the first text block, then split it with a gallery of three
// photos so the screenshot shows the mixed layout.
const ta = document.querySelector('.diary-block-text');
ta.value = '海风很大，浪声一直没停。她把鞋提在手里，光脚踩在被太阳晒热的沙滩上。';
ta.focus();
ta.setSelectionRange(11, 11);
ta.dispatchEvent(new Event('input'));

// The Helena paper — the one in the reference artwork: a blue header, a
// pale body and a green decorative strip at the bottom.
document.querySelector('.diary-theme-tile[data-theme-id="helena"]').click();
await new Promise(r => setTimeout(r, 50));

// A second, longer paragraph below the gallery, so the screenshot shows
// the body layer growing past the point where the decorative strip used
// to sit — the case that used to put the words on top of the decoration.
await new Promise(r => setTimeout(r, 300));
const tas = document.querySelectorAll('.diary-block-text');
const lower = tas[tas.length - 1];
lower.value = '傍晚风凉下来，我们沿着海岸线慢慢走回旅馆。她把鞋重新穿好，'
  + '说下次要带一件外套。我把这句话记在了这里 —— '
  + '这样下次想起这一天的时候，能连着想起海风、浪声，还有那双一直提在手里的鞋。';
lower.dispatchEvent(new Event('input'));

const fileInput = document.getElementById('diary-photos');
fileInput.click = () => {
  const files = [
    makePhoto('sunset.png', '#4a6b8a', '#c9b458', 320, 200),
    makePhoto('sea.png', '#2d6a6a', '#8fd0c0', 320, 420),
    makePhoto('sand.png', '#b98d5a', '#f0d9b5', 320, 240),
  ];
  Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
  fileInput.dispatchEvent(new Event('change'));
};
document.querySelector('.diary-block-bar [data-act="insert-image"]').click();

// The insert is async (the files are read into data URLs first).
await new Promise(r => setTimeout(r, 400));

// Switch the gallery to the two-up layout.
const gallery = document.querySelector('.diary-block-gallery');
gallery.querySelector('[data-layout="two"]').click();
await new Promise(r => setTimeout(r, 100));

// Start a drag of the first photo onto the second one, so the screenshot
// shows the reordering in progress (the picture follows the pointer).
const photos = Array.from(document.querySelectorAll('.diary-gallery-item'));
const r0 = photos[0].getBoundingClientRect();
const r1 = photos[1].getBoundingClientRect();
photos[0].dispatchEvent(new PointerEvent('pointerdown', {
  clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2,
  bubbles: true, button: 0,
}));
window.dispatchEvent(new PointerEvent('pointermove', {
  clientX: r1.left + r1.width / 2, clientY: r1.top + r1.height / 2,
  bubbles: true,
}));

window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  fs.writeFileSync(probePath, PROBE_HTML);

  const win = new BrowserWindow({
    // The window has to be on screen: a hidden one never paints, and the
    // capture would show an old frame instead of what the page looks like.
    show: true,
    width: 1180,
    height: 860,
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
    const g = document.querySelector('.diary-block-gallery');
    const page = document.querySelector('.diary-page');
    const foot = document.querySelector('.diary-page-foot');
    const body = document.querySelector('.diary-page-body');
    const pb = page.getBoundingClientRect();
    const fb = foot.getBoundingClientRect();
    const bb = body.getBoundingClientRect();
    return {
      widths: Array.from(g.querySelectorAll('.diary-gallery-item')).map(i => i.style.width),
      rects: Array.from(g.querySelectorAll('.diary-gallery-item')).map(i => Math.round(i.getBoundingClientRect().width)),
      selected: (g.querySelector('[data-layout].selected') || { dataset: {} }).dataset.layout || null,
      // The geometry of the three layers, in document coordinates.
      bodyBottom: Math.round(bb.bottom + window.scrollY),
      footTop: Math.round(fb.top + window.scrollY),
      footBottom: Math.round(fb.bottom + window.scrollY),
      pageBottom: Math.round(pb.bottom + window.scrollY),
      // Scroll so the bottom of the sheet — the decoration — is in view.
      scrollTo: Math.max(0, Math.round(fb.bottom - window.innerHeight + 40)),
    };
  })()`);
  console.log('at capture:', JSON.stringify(state));
  await new Promise((r) => setTimeout(r, 600));

  // Scroll the page so the decorative strip is in the shot — it is the
  // layer that has to stay below the text and the photos. The app
  // scrolls an inner container, so the scroll has to find whichever
  // element actually overflows.
  const scrolled = await win.webContents.executeJavaScript(`(() => {
    const foot = document.querySelector('.diary-page-foot');
    // The app scrolls the .content pane, not the window.
    const scroller = document.querySelector('.content') || document.scrollingElement;
    const target = Math.round(foot.getBoundingClientRect().bottom - scroller.clientHeight + 30);
    scroller.scrollTop = target;
    return { el: scroller.className || scroller.tagName, top: scroller.scrollTop,
             footTop: Math.round(foot.getBoundingClientRect().top) };
  })()`);
  console.log('scrolled:', JSON.stringify(scrolled));
  await new Promise((r) => setTimeout(r, 400));

  // The capture has to happen after the window has actually painted.
  // Asking for the size first forces a synchronous layout, so the frame
  // that comes back is not an empty one.
  const size = win.getContentSize();
  console.log('window size:', JSON.stringify(size));
  await new Promise((r) => setTimeout(r, 800));

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
