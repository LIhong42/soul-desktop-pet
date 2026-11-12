// scripts/test-diary-cover.js — proves the picture frames of a gallery
// work the way the user asked for.
//
// The rules the frames follow:
//
//   1. Every frame is one of the allowed shapes: 16:9, 4:3, 1:1, 3:4 or
//      9:16. Nothing else may appear in a gallery.
//   2. The frame shows a MAPPING of the picture — a rectangle cut out of
//      it — never the whole picture with empty space around it.
//   3. The default mapping is the allowed shape closest to the picture's
//      own, cut from the centre outwards until one edge reaches the
//      picture's edge.
//   4. The user can pick a mapping of their own: the picture opens at
//      its real size with the frame lying on it, and the frame can be
//      moved, scaled and given another shape.
//   5. The mapping is stored with the document, so the page and the
//      card in the 回忆 list show the same thing.
//
// Run: node scripts/run-electron.js scripts/test-diary-cover.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const evalIn = (win, code) =>
  win.webContents.executeJavaScript(
    `(async () => { try { ${code} } catch (e) { return { __threw: String(e && e.stack || e) }; } })()`,
    true);

const SRC = path.join(__dirname, '..', 'src');
const probePath = path.join(SRC, '.diary-cover-probe.html');

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./css/styles.css"></head><body>
<div id="app"></div><div id="toast-container"></div>
<script type="module">
const routerMod = await import('./js/router.js');
const editor = await import('./js/pages/diary_edit.js');
const list = await import('./js/pages/events_memorial.js');
const cover = await import('./js/diary_cover.js');
const layout = await import('./js/diary_layout.js');

// Drive the right-click menu the way the user does.
window.__menu = {
  open(el, x = 120, y = 140) {
    if (!el) throw new Error('menu opened on a missing element');
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }));
    return true;
  },
  clickInsert(act, where = 'after') {
    const sel = '#ctx-menu [data-ctx-act="' + act + '"]'
      + '[data-ctx-value="' + where + '"]';
    const btn = document.querySelector(sel);
    if (!btn) throw new Error('menu entry missing: ' + act + '/' + where);
    btn.click();
    return true;
  },
};

// The 保存 button opens the metadata dialog. The test presses it the
// way the user does.
window.__meta = {
  async open() {
    document.querySelectorAll('.diary-meta-modal-backdrop').forEach(el => el.remove());
    document.getElementById('save').click();
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector('.diary-meta-modal-backdrop');
      if (el) return el;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('the metadata dialog did not open');
  },
  async confirm() {
    const el = await window.__meta.open();
    el.querySelector('[data-act="confirm"]').click();
    await new Promise(r => setTimeout(r, 300));
    return true;
  },
};

window.__editor = editor;
window.__list = list;
window.__cover = cover;
window.__layout = layout;
window.__router = routerMod;
window.__rows = window.__testRows;

// A real picture, so the page learns its size and can place the mapping.
window.__makePhoto = (name, w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#4a6b8a'); grad.addColorStop(1, '#c9b458');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // A mark in the middle, so the visible part can be told apart.
  g.fillStyle = '#ffffff'; g.beginPath();
  g.arc(w / 2, h / 2, Math.min(w, h) / 8, 0, Math.PI * 2); g.fill();
  const b64 = c.toDataURL('image/png').split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: 'image/png' });
};
window.__ready = true;
</script></body></html>`;

function cleanup(win) {
  try { win.destroy(); } catch (e) { /* already gone */ }
}

app.whenReady().then(async () => {
  fs.writeFileSync(probePath, PROBE_HTML);
  const win = new BrowserWindow({
    width: 1200, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'diary-test-preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(probePath);

  const ready = await evalIn(win, `
    for (let i = 0; i < 60; i++) {
      if (window.__ready) return { ready: true, hasCover: !!window.__cover };
      await new Promise(r => setTimeout(r, 50));
    }
    return { ready: false };
  `);
  if (!ready || !ready.ready) {
    console.log('  FAIL the diary modules did not load', JSON.stringify(ready));
    fail++;
    cleanup(win);
    try { fs.unlinkSync(probePath); } catch (e) { /* gone */ }
    return;
  }

  // ---- 1. The allowed shapes -----------------------------------------
  console.log('\n== 宽高比 ==');
  const ratios = await evalIn(win, `
    const m = window.__cover;
    return {
      list: m.COVER_RATIOS.map(r => ({ id: r.id, name: r.name, value: r.value })),
      defaultId: m.DEFAULT_COVER_RATIO,
      // The closest allowed shape to a picture of a given shape.
      wide: m.closestRatioId(2000, 1000),
      tall: m.closestRatioId(1000, 2000),
      square: m.closestRatioId(1000, 1000),
      // A 4:3 picture has a shape of its own, so it is not forced into
      // 16:9 — and nothing is cut out of it.
      fourThree: m.closestRatioId(1200, 900),
      threeFour: m.closestRatioId(900, 1200),
      // A 5:4 picture is nearer to 4:3 than to the square.
      fiveFour: m.closestRatioId(500, 400),
      // A picture of unknown size falls back to the default.
      unknown: m.closestRatioId(0, 0),
    };
  `);
  check('there are exactly five shapes', ratios.list.length, 5);
  check('the shapes are 横屏, 横版, 方形, 竖版 and 竖屏',
    ratios.list.map(r => r.name), ['横屏', '横版', '方形', '竖版', '竖屏']);
  check('the shapes are 16:9, 4:3, 1:1, 3:4 and 9:16',
    ratios.list.map(r => r.id), ['16:9', '4:3', '1:1', '3:4', '9:16']);
  check('a wide picture takes the wide shape', ratios.wide, '16:9');
  check('a tall picture takes the tall shape', ratios.tall, '9:16');
  check('a square picture takes the square shape', ratios.square, '1:1');
  check('a 4:3 picture takes the 4:3 shape', ratios.fourThree, '4:3');
  check('a 3:4 picture takes the 3:4 shape', ratios.threeFour, '3:4');
  check('a 5:4 picture takes the 4:3 shape', ratios.fiveFour, '4:3');
  check('a picture of unknown size falls back to the default',
    ratios.unknown, '16:9');

  // ---- 2. The default mapping ----------------------------------------
  //
  // The mapping is the allowed shape closest to the picture's own, cut
  // from the centre outwards until one edge reaches the picture's edge.
  console.log('\n== 默认映射 ==');
  const defaults = await evalIn(win, `
    const m = window.__cover;
    const out = {};
    for (const [name, w, h] of [['wide', 2000, 1000], ['tall', 1000, 2000], ['square', 1000, 1000], ['phone', 1279, 1706]]) {
      const c = m.defaultCover(w, h);
      const r = m.coverRect(w, h, c);
      out[name] = {
        cover: c,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        // The frame's shape must be the allowed one.
        ar: r.width / r.height,
        // The frame must touch one of the picture's edges.
        touchesEdge: r.left <= 0.001 || r.top <= 0.001
                  || r.left + r.width >= w - 0.001
                  || r.top + r.height >= h - 0.001,
        // The frame must lie inside the picture.
        inside: r.left >= -0.001 && r.top >= -0.001
             && r.left + r.width <= w + 0.001
             && r.top + r.height <= h + 0.001,
      };
    }
    return out;
  `);
  check('a wide picture is cut into a 16:9 frame',
    Math.round(defaults.wide.rect.width / defaults.wide.rect.height * 100) / 100, 1.78);
  check('the wide frame touches an edge of the picture',
    defaults.wide.touchesEdge, true);
  check('the wide frame lies inside the picture', defaults.wide.inside, true);
  check('a tall picture is cut into a 9:16 frame',
    Math.round(defaults.tall.rect.width / defaults.tall.rect.height * 100) / 100, 0.56);
  check('the tall frame touches an edge of the picture',
    defaults.tall.touchesEdge, true);
  check('a square picture is cut into a 1:1 frame',
    Math.round(defaults.square.rect.width / defaults.square.rect.height * 100) / 100, 1);
  check('a square picture loses nothing at all',
    defaults.square.rect.width, 1000);
  check('the default mapping is centred',
    [defaults.wide.cover.x, defaults.wide.cover.y], [0.5, 0.5]);

  // A phone photo is 3:4 — and it has a frame of its own, so nothing is
  // cut out of it. Before 3:4 was allowed, such a photo was forced into
  // a 9:16 frame, which cut a narrow strip out of it and left the frame
  // in a shape the photo had no claim to.
  check('a 3:4 phone photo takes a 3:4 frame',
    defaults.phone.cover.ratio, '3:4');
  check('a 3:4 phone photo loses nothing at all',
    [Math.round(defaults.phone.rect.width), Math.round(defaults.phone.rect.height)],
    [1279, 1705]);
  check('the 3:4 frame is the picture itself',
    defaults.phone.cover.zoom, 1);

  // ---- 3. The mapping is placed correctly ----------------------------
  //
  // The frame is a window onto the picture: the picture is drawn at its
  // own shape, scaled up until the cover's rectangle covers the frame,
  // and then slid so the rectangle lands on the frame.
  //
  // The check is done against an independent model: the rectangle is
  // placed on the picture by hand, and the drawing is computed from
  // that.
  console.log('\n== 映射位置 ==');
  const placement = await evalIn(win, `
    const m = window.__cover;
    const out = [];
    const cases = [
      [2000, 1000, '16:9', 1, 0.5, 0.5],
      [2000, 1000, '1:1',  1, 0.5, 0.5],
      [1000, 2000, '9:16', 1, 0.5, 0.5],
      [1000, 2000, '16:9', 1, 0.5, 0.5],
      [1000, 1000, '16:9', 1, 0.5, 0.5],
      [1200, 900,  '16:9', 1, 0.5, 0.5],
      [2000, 1000, '16:9', 2, 0.5, 0.5],
      [2000, 1000, '16:9', 1, 0.2, 0.8],
      [2000, 1000, '16:9', 1, 0.9, 0.1],
    ];
    const FRAME_W = 320, FRAME_H = 180;
    for (const [w, h, ratio, zoom, x, y] of cases) {
      const cover = { ratio, x, y, zoom };
      const style = m.coverFrameStyle(w, h, cover, FRAME_W, FRAME_H);
      const rect = m.coverRect(w, h, cover);
      // The independent model: place the frame on the picture by hand.
      const ar = ratio === '16:9' ? 16/9 : ratio === '4:3' ? 4/3
        : ratio === '9:16' ? 9/16 : ratio === '3:4' ? 3/4 : 1;
      let fw = w, fh = w / ar;
      if (fh > h) { fh = h; fw = h * ar; }
      fw /= zoom; fh /= zoom;
      const left = x * w - fw / 2, top = y * h - fh / 2;
      // The frame is kept inside the picture.
      const cl = Math.min(w - fw, Math.max(0, left));
      const ct = Math.min(h - fh, Math.max(0, top));
      // The scale that makes the rectangle cover the frame.
      const scale = Math.max(FRAME_W / fw, FRAME_H / fh);
      const wantW = w * scale, wantH = h * scale;
      const wantL = -cl * scale, wantT = -ct * scale;
      out.push({
        ratio, zoom, x, y,
        ok: Math.abs(style.imgWidth - wantW) < 0.05
         && Math.abs(style.imgHeight - wantH) < 0.05
         && Math.abs(style.imgLeft - wantL) < 0.05
         && Math.abs(style.imgTop - wantT) < 0.05,
        got: [style.imgWidth, style.imgHeight, style.imgLeft, style.imgTop],
        want: [wantW, wantH, wantL, wantT],
        // The frame must show part of the picture, and only part of it.
        rectInside: rect.left >= -0.001 && rect.top >= -0.001
          && rect.left + rect.width <= w + 0.001
          && rect.top + rect.height <= h + 0.001,
        rectAr: rect.width / rect.height,
      });
    }
    return out;
  `);
  checkTrue('every mapping lands the frame where the cover says',
    placement.every(p => p.ok),
    JSON.stringify(placement.filter(p => !p.ok)));
  checkTrue('every frame shows part of the picture and nothing else',
    placement.every(p => p.rectInside));
  checkTrue('every frame has the shape the cover names',
    placement.every(p => {
      const ar = p.ratio === '16:9' ? 16 / 9 : p.ratio === '4:3' ? 4 / 3
        : p.ratio === '9:16' ? 9 / 16 : p.ratio === '3:4' ? 3 / 4 : 1;
      return Math.abs(p.rectAr - ar) < 0.01;
    }));

  // ---- 4. The frames in the editor ------------------------------------
  //
  // A picture of any shape fills its frame, so a row of pictures has no
  // hole in it.
  console.log('\n== 编辑器中的图片框 ==');
  const frames = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 60));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '看看图。';
    ta.focus();
    ta.setSelectionRange(3, 3);
    ta.dispatchEvent(new Event('input'));

    // Three files at once — they share one gallery.
    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const files = [
        window.__makePhoto('wide.png', 320, 200),
        window.__makePhoto('tall.png', 320, 420),
        window.__makePhoto('square.png', 320, 240),
      ];
      Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.clickInsert('insert-image');
    await new Promise(r => setTimeout(r, 400));
    // The pictures are read and decoded — wait for them.
    for (let i = 0; i < 60; i++) {
      const imgs = Array.from(document.querySelectorAll('.diary-gallery-item img'));
      if (imgs.length === 3 && imgs.every(i => i.naturalWidth)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 200));

    const items = Array.from(document.querySelectorAll('.diary-gallery-item'));
    return {
      items: items.length,
      // Every picture sits in a frame.
      frames: items.map(i => !!i.querySelector('.diary-gallery-frame')),
      // The frame's shape is one of the three allowed ones.
      ratios: items.map(i => {
        const f = i.querySelector('.diary-gallery-frame');
        return f ? f.dataset.ratio : null;
      }),
      // The picture fills its frame — no empty plate around it. The
      // picture is drawn at its own shape and slid so that the cover's
      // part of it lands on the frame, so the picture must be at least
      // as big as the frame on both sides.
      fits: items.map(i => {
        const f = i.querySelector('.diary-gallery-frame');
        const img = i.querySelector('img');
        if (!f || !img) return null;
        const fr = f.getBoundingClientRect();
        const ir = img.getBoundingClientRect();
        return {
          wide: ir.width >= fr.width - 0.5,
          tall: ir.height >= fr.height - 0.5,
          // The picture keeps its own shape.
          shape: Math.abs((ir.width / ir.height) - (img.naturalWidth / img.naturalHeight)) < 0.02,
        };
      }),
      // The frame has a real height of its own.
      frameHeights: items.map(i => {
        const f = i.querySelector('.diary-gallery-frame');
        return f ? Math.round(f.getBoundingClientRect().height) : 0;
      }),
    };
  `);
  check('the gallery holds the three pictures', frames.items, 3);
  checkTrue('every picture sits in a frame', frames.frames.every(Boolean));
  checkTrue('every frame carries one of the allowed shapes',
    frames.ratios.every(r => ['16:9', '4:3', '1:1', '3:4', '9:16'].includes(r)),
    JSON.stringify(frames.ratios));
  checkTrue('every picture covers its frame',
    frames.fits.every(f => f && f.wide && f.tall),
    JSON.stringify(frames.fits));
  checkTrue('every picture keeps its own shape',
    frames.fits.every(f => f && f.shape),
    JSON.stringify(frames.fits));
  checkTrue('every frame has a height of its own',
    frames.frameHeights.every(h => h > 0), JSON.stringify(frames.frameHeights));

  // ---- 5. The cover editor --------------------------------------------
  //
  // Clicking a picture opens the real picture with the frame on it. The
  // frame can be moved, scaled and given another shape.
  console.log('\n== 选定展示画面 ==');
  const editorOpen = await evalIn(win, `
    const item = document.querySelector('.diary-gallery-item');
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    const el = document.querySelector('.cover-editor');
    const frame = el ? el.querySelector('.cover-editor-frame') : null;
    return {
      open: !!el && el.classList.contains('open'),
      hasPicture: !!el && !!el.querySelector('.cover-editor-img'),
      hasFrame: !!frame,
      // The shapes are offered.
      ratios: el ? Array.from(el.querySelectorAll('.cover-editor-ratio'))
        .map(b => b.dataset.ratio) : [],
      hasSave: !!el && !!el.querySelector('.cover-editor-save'),
      hasReset: !!el && !!el.querySelector('.cover-editor-reset'),
      frameSize: frame ? {
        w: Math.round(frame.getBoundingClientRect().width),
        h: Math.round(frame.getBoundingClientRect().height),
      } : null,
    };
  `);
  check('the double click opens the cover editor', editorOpen.open, true);
  checkTrue('the editor shows the real picture', editorOpen.hasPicture);
  checkTrue('the editor shows the frame', editorOpen.hasFrame);
  check('the editor offers the five shapes',
    editorOpen.ratios, ['16:9', '4:3', '1:1', '3:4', '9:16']);
  checkTrue('the editor can save the cover', editorOpen.hasSave);
  checkTrue('the editor can reset the cover', editorOpen.hasReset);

  // The frame's shape must follow the shape that is picked.
  const shapeSwitch = await evalIn(win, `
    const el = document.querySelector('.cover-editor');
    const frame = el.querySelector('.cover-editor-frame');
    const btn = el.querySelector('.cover-editor-ratio[data-ratio="1:1"]');
    btn.click();
    await new Promise(r => setTimeout(r, 60));
    const square = {
      w: Math.round(frame.getBoundingClientRect().width),
      h: Math.round(frame.getBoundingClientRect().height),
    };
    const tall = el.querySelector('.cover-editor-ratio[data-ratio="9:16"]');
    tall.click();
    await new Promise(r => setTimeout(r, 60));
    const portrait = {
      w: Math.round(frame.getBoundingClientRect().width),
      h: Math.round(frame.getBoundingClientRect().height),
    };
    return {
      square, portrait,
      selected: el.querySelector('.cover-editor-ratio.selected').dataset.ratio,
    };
  `);
  check('picking 方形 makes the frame square',
    Math.round(shapeSwitch.square.w / shapeSwitch.square.h * 100) / 100, 1);
  check('picking 竖屏 makes the frame tall',
    shapeSwitch.portrait.h > shapeSwitch.portrait.w, true);
  check('the picked shape is the marked one', shapeSwitch.selected, '9:16');

  // Saving the cover writes it into the document.
  const saved = await evalIn(win, `
    const el = document.querySelector('.cover-editor');
    el.querySelector('.cover-editor-ratio[data-ratio="1:1"]').click();
    await new Promise(r => setTimeout(r, 60));
    el.querySelector('.cover-editor-save').click();
    await new Promise(r => setTimeout(r, 120));

    // The editor is closed and the frame on the page follows the cover.
    const closed = !document.querySelector('.cover-editor.open');
    const frame = document.querySelector('.diary-gallery-frame');
    const item = document.querySelector('.diary-gallery-item');
    return {
      closed,
      ratio: frame ? frame.dataset.ratio : null,
      // The browser normalizes the aspect-ratio it is given, so the frame
      // is measured rather than read.
      aspect: frame ? (() => {
        const r = frame.getBoundingClientRect();
        return r.height ? Math.round(r.width / r.height * 100) / 100 : 0;
      })() : 0,
      itemRatio: item ? item.querySelector('.diary-gallery-frame').dataset.ratio : null,
    };
  `);
  check('the editor closes when the cover is saved', saved.closed, true);
  check('the frame on the page takes the saved shape', saved.ratio, '1:1');
  check('the frame\'s aspect ratio follows the shape', saved.aspect, 1);

  // ---- 5c. The frame can be moved and zoomed -------------------------
  //
  // Moving the frame on the real picture must change what the gallery
  // shows: the picture slides under the frame. The wheel makes the
  // frame smaller, so a closer part of the picture shows.
  console.log('\n== 移动与缩放取景框 ==');
  const moved = await evalIn(win, `
    // Open the editor on the picture again.
    const item = document.querySelector('.diary-gallery-item');
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    const el = document.querySelector('.cover-editor');
    const frame = el.querySelector('.cover-editor-frame');
    const img = el.querySelector('.cover-editor-img');
    // The wide shape: the frame is as wide as the picture, so it moves
    // up and down.
    el.querySelector('.cover-editor-ratio[data-ratio="16:9"]').click();
    await new Promise(r => setTimeout(r, 60));

    const fr = frame.getBoundingClientRect();
    const ir = img.getBoundingClientRect();

    // Drag the frame down by a quarter of the picture.
    const startX = fr.left + fr.width / 2;
    const startY = fr.top + fr.height / 2;
    const dy = Math.round(ir.height * 0.25);
    frame.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0, pointerId: 1,
    }));
    await new Promise(r => setTimeout(r, 30));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: startX, clientY: startY + dy, pointerId: 1,
    }));
    await new Promise(r => setTimeout(r, 60));
    const afterDrag = frame.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: startX, clientY: startY + dy, pointerId: 1,
    }));
    await new Promise(r => setTimeout(r, 60));

    // The wheel makes the frame smaller.
    const before = frame.getBoundingClientRect();
    el.querySelector('.cover-editor-stage').dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }));
    await new Promise(r => setTimeout(r, 60));
    const afterZoom = frame.getBoundingClientRect();

    // Save and look at the gallery's own frame.
    el.querySelector('.cover-editor-save').click();
    await new Promise(r => setTimeout(r, 200));
    const gf = document.querySelector('.diary-gallery-frame');
    const gi = document.querySelector('.diary-gallery-item img');
    const gr = gf.getBoundingClientRect();
    const gir = gi.getBoundingClientRect();

    return {
      dragMoved: Math.round(afterDrag.top - fr.top),
      zoomedIn: afterZoom.width < before.width - 0.5,
      // The gallery's frame shows a part of the picture that is NOT the
      // middle any more — the picture slid under the frame.
      pictureSlid: Math.abs(gir.top - gr.top) > 0.5,
      // The picture still covers the frame.
      covers: gir.width >= gr.width - 0.5 && gir.height >= gr.height - 0.5,
      frameRatio: gf.dataset.ratio,
    };
  `);
  checkTrue('dragging the frame moves it', moved.dragMoved > 0,
    JSON.stringify(moved));
  checkTrue('the wheel makes the frame smaller', moved.zoomedIn,
    JSON.stringify(moved));
  checkTrue('the picture slides under the frame', moved.pictureSlid,
    JSON.stringify(moved));
  checkTrue('the picture still covers the frame', moved.covers,
    JSON.stringify(moved));
  check('the frame keeps the shape that was picked', moved.frameRatio, '16:9');

  // ---- 6. The cover travels with the document -------------------------
  console.log('\n== 封面随文档保存 ==');
  const documentSaved = await evalIn(win, `
    await window.__editor.render({}, {});
    await new Promise(r => setTimeout(r, 80));

    const ta = document.querySelector('.diary-block-text');
    ta.value = '有图。';
    ta.focus();
    ta.setSelectionRange(2, 2);
    ta.dispatchEvent(new Event('input'));

    const fileInput = document.getElementById('diary-photos');
    fileInput.click = () => {
      const files = [window.__makePhoto('one.png', 320, 200)];
      Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
      fileInput.dispatchEvent(new Event('change'));
    };
    window.__menu.open(ta);
    window.__menu.clickInsert('insert-image');
    await new Promise(r => setTimeout(r, 400));
    for (let i = 0; i < 60; i++) {
      const img = document.querySelector('.diary-gallery-item img');
      if (img && img.naturalWidth) break;
      await new Promise(r => setTimeout(r, 50));
    }

    // Give the picture a cover of its own.
    const item = document.querySelector('.diary-gallery-item');
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const el = document.querySelector('.cover-editor');
    el.querySelector('.cover-editor-ratio[data-ratio="9:16"]').click();
    await new Promise(r => setTimeout(r, 60));
    el.querySelector('.cover-editor-save').click();
    await new Promise(r => setTimeout(r, 120));

    // Save the entry.
    await window.__meta.confirm();
    await new Promise(r => setTimeout(r, 300));

    const rows = window.__rows.all();
    const row = Object.values(rows).find(r => r && r.content);
    const blocks = row ? window.__layout.parseDiaryContent(row.content) : [];
    const gallery = blocks.find(b => b.type === 'gallery');
    return {
      saved: !!row,
      photoCover: gallery && gallery.photos[0] ? gallery.photos[0].cover : null,
    };
  `);
  checkTrue('the entry was saved', documentSaved.saved);
  checkTrue('the cover travels with the document',
    documentSaved.photoCover && documentSaved.photoCover.ratio === '9:16',
    JSON.stringify(documentSaved.photoCover));

  // ---- 7. A cover survives a round trip --------------------------------
  //
  // The document is read back by the same parser the list page uses.
  console.log('\n== 封面读回 ==');
  const roundTrip = await evalIn(win, `
    const m = window.__layout;
    const stored = JSON.stringify([
      { type: 'gallery', layout: 'two', photos: [
        { photo_id: 'p1', cover: { ratio: '9:16', x: 0.3, y: 0.7, zoom: 2 } },
        { photo_id: 'p2' },
      ]},
    ]);
    const blocks = m.parseDiaryContent(stored);
    const photos = blocks[0].photos;
    return {
      count: photos.length,
      cover: photos[0].cover,
      // A photo without a cover gets none — the default is worked out
      // from the picture's own shape where it is drawn.
      noCover: photos[1].cover === undefined,
    };
  `);
  check('the document still holds both pictures', roundTrip.count, 2);
  check('the cover is read back as it was written',
    roundTrip.cover, { ratio: '9:16', x: 0.3, y: 0.7, zoom: 2 });
  check('a picture without a cover has none', roundTrip.noCover, true);

  cleanup(win);
  try { fs.unlinkSync(probePath); } catch (e) { /* gone */ }
  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
