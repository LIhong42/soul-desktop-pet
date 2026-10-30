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
<div id="app"></div><div id="toast-container"></div>
<script type="module">
const editor = await import('./js/pages/diary_edit.js');
await editor.render({}, {});
document.getElementById('diary-title').value = '第一次去海边';
document.getElementById('diary-occurred').value = '2026-05-01T10:30';

// Fill in the first text block, then split it with an image so the
// screenshot shows the mixed layout.
const ta = document.querySelector('.diary-block-text');
ta.value = '海风很大，浪声一直没停。她把鞋提在手里，光脚踩在被太阳晒热的沙滩上。';
ta.focus();
ta.setSelectionRange(11, 11);
ta.dispatchEvent(new Event('input'));

const fileInput = document.getElementById('diary-photos');
fileInput.click = () => {
  // A gradient PNG, so the preview shows a real image block. The canvas
  // hands back a data URL, so decode it back into bytes — a File built
  // from the URL *string* would contain text, not an image.
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 320, 200);
  grad.addColorStop(0, '#4a6b8a');
  grad.addColorStop(1, '#c9b458');
  g.fillStyle = grad;
  g.fillRect(0, 0, 320, 200);
  const b64 = c.toDataURL('image/png').split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'sunset.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new Event('change'));
};
document.querySelector('.diary-block-bar [data-act="insert-image"]').click();

// The insert is async (the file is read into a data URL first).
await new Promise(r => setTimeout(r, 200));

window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  fs.writeFileSync(probePath, PROBE_HTML);

  const win = new BrowserWindow({
    show: false,
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
  await new Promise((r) => setTimeout(r, 600));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(outPath, image.toPNG());
  console.log('wrote', outPath);

  fs.unlinkSync(probePath);
  app.exit(0);
}).catch((e) => {
  console.error('preview failed:', e);
  try { fs.unlinkSync(probePath); } catch (_) {}
  app.exit(1);
});
