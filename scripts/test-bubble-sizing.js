// scripts/test-bubble-sizing.js — checks the 文本框 bubble's auto-sizing.
//
// The bug this guards against: the 吃饭提醒 bubble did not size itself to its
// text. It was measured while the element still carried `.pet-bubble.hidden`
// (`display: none`), so the browser reported no layout at all — the range had
// no rects and the node had a zero height. Every number then came from the
// character-count *estimate* fallback, which worked out to five characters per
// line. 「早饭：今天吃撒」 is seven characters, so the box was sized for TWO
// lines and the text wrapped, even though the artwork had room for one.
//
// The 更新提醒 escaped the bug by luck: it travels the *action* path, which
// repaints the bubble on every action play, so its second paint measured a
// visible bubble and got a real layout measurement. The rule path has no such
// second chance — its broadcast is de-duplicated, so the bubble is measured
// once and then sits there for the whole hour.
//
// These checks drive the REAL renderer (src/pet.html) through the REAL IPC
// channel (`pet:bubble-changed`), because the failure was in the seam between
// them: the renderer has to un-hide the bubble before it measures, and the
// main process has to send the text without a prefix.
//
// Usage: node scripts/run-electron.js scripts/test-bubble-sizing.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'main', 'db'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// The real 文本框 artwork, so the measurement runs against the same geometry
// the user's own bubbles use.
//
// Both the file and the geometry come from main/pet_text_boxes.js, which is
// where the app gets them from too. A hand-written copy of the geometry would
// drift from the real table, and a test that measures against a shape no user
// will ever see is a test that proves nothing about the real bubbles.
function pickBoxArt() {
  const petTextBoxes = require(path.join(ROOT, 'main', 'pet_text_boxes'));
  const list = petTextBoxes.list(null);
  if (!list || !list.length) return null;
  return petTextBoxes.resolve(null, list[0].id);
}

app.whenReady().then(async () => {
  console.log('bubble auto-sizing test (real Electron)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-bubble-size-'));
  // A throwaway database — never the user's data. The bubble engine reads its
  // state from it, so it has to be open for the rule to be asked anything.
  await db.open(path.join(dir, 'test.sqlite'));

  const art = pickBoxArt();
  if (!art) {
    console.log('  FAIL no 文本框 artwork found under resources/text_boxes — cannot test');
    process.exit(1);
  }

  const win = new BrowserWindow({
    width: 420,
    height: 520,
    show: false,
    webPreferences: {
      // The real pet preload, so `pet:bubble-changed` is a real channel and
      // the renderer wires it up exactly the way it does in the app.
      preload: path.join(ROOT, 'pet', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'pet.html'));
  await new Promise((r) => setTimeout(r, 600));

  // The real pet window's box, so the bubble's `max-width: 100%` cap (which
  // is what makes a long line wrap instead of overflowing the window) behaves
  // the way it does in the app. See main/pet_controller.js: a 220px sprite
  // plus 25px of side room on each side, and 100px of headroom above.
  await win.webContents.executeJavaScript(`
    (() => {
      const r = document.documentElement;
      r.style.setProperty('--size-w', '270px');
      r.style.setProperty('--size-h', '320px');
      r.style.setProperty('--sprite-w', '220px');
      r.style.setProperty('--sprite-h', '220px');
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 60));

  // Read the bubble's geometry back out of the DOM. The inline width/height
  // are the numbers applyArtGeometry computed; the line count is what the
  // browser actually laid out.
  const readGeometry = () => win.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('pet-text-bubble');
      const t = document.getElementById('pet-bubble-text');
      const range = document.createRange();
      range.selectNodeContents(t);
      const rects = Array.from(range.getClientRects());
      let widest = 0;
      for (const r of rects) if (r.width > widest) widest = r.width;
      return {
        inlineW: parseFloat(b.style.width) || 0,
        inlineH: parseFloat(b.style.height) || 0,
        lineCount: Math.max(1, Math.round(t.getBoundingClientRect().height / 20)),
        rects: rects.length,
        inkW: widest,
        visible: !b.classList.contains('hidden'),
        hasArt: b.classList.contains('has-art'),
        text: t.textContent,
      };
    })()
  `);

  // Paint a bubble the way the app does: the main process sends the real IPC
  // and the renderer's own `pet:bubble-changed` handler paints it.
  //
  // The bubble is cleared first, so each measurement starts from the same
  // state a real "a bubble appears" starts from — which is the state the bug
  // lived in.
  async function paint(text, box) {
    await win.webContents.executeJavaScript(`
      (() => {
        const b = document.getElementById('pet-text-bubble');
        const a = document.getElementById('pet-bubble-art');
        b.classList.add('hidden');
        b.classList.remove('fade');
        b.style.width = ''; b.style.height = '';
        b.dataset.kind = ''; b.dataset.box = '';
        a.removeAttribute('src');
        document.getElementById('pet-bubble-text').textContent = '';
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 60));
    win.webContents.send('pet:bubble-changed', {
      text, kind: 'meal', rule: 'meal', durationMs: 60 * 60_000, box,
    });
    await new Promise((r) => setTimeout(r, 120));
    return readGeometry();
  }

  // -------------------------------------------------------------------------
  // 1. The bubble sizes itself to the text.
  // -------------------------------------------------------------------------
  console.log('\n== the box fits the text ==');

  const short = await paint('今天吃撒', art);
  const long = await paint('坐太久了，起来走两步吧', art);

  check('the short line paints the artwork', short.hasArt === true, JSON.stringify(short));
  check('the long line paints the artwork', long.hasArt === true, JSON.stringify(long));
  check('the bubble is visible after the paint', short.visible === true, JSON.stringify(short));

  // The whole point: the estimate fallback would have given both of these the
  // SAME width (it only knows the character count, and the short line's
  // estimate was clamped up to ART_MIN_W). A real measurement separates them.
  check('the long line gets a wider box than the short one',
    long.inlineW > short.inlineW,
    `short ${short.inlineW}px, long ${long.inlineW}px`);

  // The short line is four characters — it must fit on ONE line. The old
  // estimate gave it two (charsPerLine worked out to 2 after the slack).
  eq('the four-character line stays on one line', short.lineCount, 1);
  eq('the four-character line lays out as one range rect', short.rects, 1);

  // The box has to actually be wide enough to hold the text it was given.
  check('the box is wider than the text it holds',
    short.inlineW > short.inkW,
    `box ${short.inlineW}px, text ${short.inkW}px`);

  // -------------------------------------------------------------------------
  // 2. The size is not left over from the previous line.
  // -------------------------------------------------------------------------
  console.log('\n== the size follows the line, not the last one ==');

  const first = await paint('坐太久了，起来走两步吧', art);
  const second = await paint('今天吃撒', art);
  const third = await paint('坐太久了，起来走两步吧', art);

  check('a long line is wider than a short one',
    first.inlineW > second.inlineW,
    `long ${first.inlineW}px, short ${second.inlineW}px`);
  check('the same long line measures the same both times',
    Math.abs(first.inlineW - third.inlineW) <= 1,
    `${first.inlineW}px vs ${third.inlineW}px`);
  check("a short line does not inherit the long one's size",
    second.inlineW < first.inlineW,
    `${second.inlineW}px vs ${first.inlineW}px`);

  // -------------------------------------------------------------------------
  // 3. The meal line is the plain four characters — no window prefix.
  //
  // This half runs in the MAIN process: it asks the meal rule itself what it
  // would say, rather than checking a string the test made up. The renderer
  // only ever paints what it is told, so the prefix lived in the rule — and
  // asserting it here is what keeps it from creeping back in.
  // -------------------------------------------------------------------------
  console.log('\n== the meal line carries no window prefix ==');

  const petBubbles = require(path.join(ROOT, 'main', 'pet_bubbles'));
  const mealRule = petBubbles.BUILTIN_RULES.find((r) => r.name === 'meal');
  check('the meal rule exists', !!mealRule);
  eq('the meal line is exactly "今天吃撒"', mealRule.text, '今天吃撒');
  check('the meal line has no "：" in it', !String(mealRule.text).includes('：'), mealRule.text);

  // The rule's own build() — the thing that actually produces the bubble text
  // — must agree, for every meal window.
  for (const w of mealRule.windows) {
    const snapshot = {
      activeMealWindow: w,
      feedWindows: {},
    };
    const intent = mealRule.build(snapshot);
    eq(`the ${w.label} window says "今天吃撒"`, intent && intent.text, '今天吃撒');
  }

  // And the preview button must show the same line, not the rule's name.
  eq('the meal preview shows the same line', mealRule.forceText(), '今天吃撒');

  // -------------------------------------------------------------------------
  // 4. The card mode (no 文本框) still hugs its text.
  // -------------------------------------------------------------------------
  console.log('\n== the CSS card still hugs its text ==');

  const card = await paint('今天吃撒', null);
  check('the card does not wear artwork', card.hasArt === false, JSON.stringify(card));
  check('the card is visible', card.visible === true, JSON.stringify(card));
  check('the card lays the line out once', card.lineCount === 1, JSON.stringify(card));

  // The throwaway database goes away with the check — it never touched the
  // user's data, and leaving it in the temp dir would just be litter.
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
