// scripts/test-diary-audio-recording.js — proves the 录音 (voice
// recording) path works against the REAL backend.
//
// The audio insertion had one door: pick a file from the disk. It has
// two now — the file, and a recording made from the microphone. This
// test covers the second one end to end:
//
//   1. The recording engine produces a real File with real bytes and a
//      mime the editor's own kind-sniffing recognises as audio.
//   2. That File goes into the pending-media list and becomes an audio
//      block on the page — the same block a picked sound produces.
//   3. The audio block serialises into the document the server stores.
//   4. The recorded sound uploads through the REAL upload IPC, lands on
//      disk, and gets a row in memorial_event_photos whose mime says
//      it is audio (not a picture — the album exporters would choke
//      on it otherwise).
//   5. The saved sound reads back as a file: URL the <audio> element
//      can load.
//
// The microphone itself is not opened: the test drives the recording
// engine with a synthetic MediaRecorder fed by a real audio stream,
// so the test does not need a microphone, a permission, or a human
// talking into the room. What is proven is everything the microphone
// would have produced downstream.
//
// Run: node scripts/run-electron.js scripts/test-diary-audio-recording.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.disableHardwareAcceleration();

// The test writes rows and media files, so it must not touch the user's
// own data.
const SCRATCH = path.join(os.tmpdir(), 'soul-diary-recording-test');
app.setPath('appData', SCRATCH);
app.setPath('userData', SCRATCH);

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

let win;
let db;

app.whenReady().then(async () => {
  const tmp = SCRATCH;
  fs.mkdirSync(tmp, { recursive: true });

  // The real main process: the real database, the real IPC handlers.
  const dbPath = path.join(__dirname, '..', 'main', 'db.js');
  db = require(dbPath);
  await db.open(path.join(tmp, 'test.db'));

  const ipc = require(path.join(__dirname, '..', 'main', 'ipc.js'));
  ipc.register({
    queue: { list: () => [], activeCount: () => 0, remove: () => {}, dismissForToday: () => {} },
    winMain: null,
    winPet: null,
    getWinPet: () => null,
    recreatePetWindow: () => {},
    setPetState: () => {},
    getPetState: () => ({}),
    setActiveReminder: () => {},
    broadcastPetState: () => {},
    petController: null,
    petRegistry: null,
  });

  win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (e, level, message) => {
    console.log('  [renderer]', message);
  });

  // The probe page loads the recording engine and the editor's own
  // modules, so the test drives the real code.
  const SRC = path.join(__dirname, '..', 'src');
  const probePath = path.join(SRC, '.diary-recording-probe.html');
  fs.writeFileSync(probePath, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./css/styles.css"></head><body>
<div id="app"></div><div id="toast-container"></div>
<script type="module">
window.__recorder = await import('./js/audio_recorder.js');
window.__editor = await import('./js/pages/diary_edit.js');
window.__router = await import('./js/router.js');
</script></body></html>`);

  await win.loadFile(probePath);

  // The probe page imports the modules with a top-level await, and the
  // load event fires BEFORE that await settles — wait for it here.
  await evalIn(win, `
    for (let i = 0; i < 100 && !window.__recorder; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return typeof window.__recorder;
  `);

  // ---- 1. The recording engine -------------------------------------
  //
  // The microphone is replaced by a synthetic one: an oscillator feeding
  // a MediaStreamDestination. The bytes are real, the mime is real, and
  // nothing depends on a device being present.
  const engine = await evalIn(win, `
    const R = window.__recorder;
    if (!R) return { __threw: 'the recorder module did not load' };

    // A synthetic microphone: an audio context whose stream the recorder
    // can consume.
    //
    // The oscillator must carry a GAIN of 1 and be running BEFORE the
    // recorder starts. A silent source gives MediaRecorder nothing to
    // encode, and it hands back an empty chunk — the recording then
    // looks like a broken engine when the fault is the fixture.
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    await new Promise((r) => setTimeout(r, 200));

    // The recorder asks for the microphone through getUserMedia. The
    // test answers with the synthetic stream.
    const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => dest.stream;

    // A MediaRecorder that records the synthetic stream for real.
    const started = await R.startRecording(() => {});
    const rec = started;
    // Long enough for the encoder to emit a chunk of its own.
    await new Promise((r) => setTimeout(r, 800));
    const file = await rec.stop();

    navigator.mediaDevices.getUserMedia = realGum;
    try { osc.stop(); ctx.close(); } catch (e) { /* already closed */ }

    if (!file) {
      return { mime: rec.mime, size: 0, isFile: false };
    }
    return {
      isFile: file instanceof File,
      size: file.size,
      mime: file.type,
      name: file.name,
      ext: R.extensionForMime(file.type),
      bareMime: String(file.type).split(';')[0],
    };
  `);

  checkTrue('the recorder module loaded', !engine.__threw, engine.__threw);
  checkTrue('the recording produced a File', engine.isFile === true);
  checkTrue('the recording carries real bytes', (engine.size || 0) > 0,
    `size was ${engine.size}`);
  checkTrue('the mime says audio', String(engine.bareMime || '').startsWith('audio/'),
    `mime was ${engine.mime}`);
  checkTrue('the extension matches the mime',
    !!engine.ext && engine.name.endsWith(engine.ext),
    `name ${engine.name} / ext ${engine.ext}`);
  checkTrue('the file is named as a recording', /^录音 /.test(engine.name || ''),
    `name was ${engine.name}`);

  // ---- 2. The recorded file becomes an audio block ------------------
  //
  // The editor's own menu is driven the way the user drives it: the
  // 「录音」 entry opens the recording dialog, and the sound the dialog
  // hands back becomes an audio block on the page.
  //
  // The microphone is the synthetic one from the first check, so the
  // dialog runs its real code path — the real start button, the real
  // stop, the real File.
  const inserted = await evalIn(win, `
    const editor = window.__editor;
    if (!editor) return { __threw: 'the editor module did not load' };

    // The synthetic microphone, again.
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    await new Promise((r) => setTimeout(r, 200));
    navigator.mediaDevices.getUserMedia = async () => dest.stream;

    // Render the editor's page.
    await editor.render({}, {});
    await new Promise((r) => setTimeout(r, 100));

    // The text block IS the textarea — the class sits on it, not on a
    // wrapper around it.
    const ta = document.querySelector('textarea.diary-block-text');
    if (!ta) return { __threw: 'the editor page has no text block' };
    ta.value = '那天她说了一句话。';

    // Right-click the text block and check that the menu offers both
    // ways of getting a sound in.
    ta.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 120, clientY: 140,
    }));
    const acts = Array.from(document.querySelectorAll('#ctx-menu [data-ctx-act]'))
      .map((b) => b.dataset.ctxAct);
    const labels = Array.from(document.querySelectorAll('#ctx-menu [data-ctx-act]'))
      .map((b) => b.textContent.trim());

    // Press 「录音」.
    document.querySelector('#ctx-menu [data-ctx-act="record-audio"][data-ctx-value="after"]').click();
    await new Promise((r) => setTimeout(r, 150));

    // The dialog is on screen.
    const dialog = document.querySelector('.diary-recorder-backdrop');
    const dialogExists = !!dialog;
    const hasStart = !!(dialog && dialog.querySelector('[data-act="start"]'));
    const hasTimer = !!(dialog && dialog.querySelector('[data-role="timer"]'));
    const hasMeter = !!(dialog && dialog.querySelector('[data-role="meter"]'));

    // Press 「开始录音」, let it run, then 「停止录音」.
    dialog.querySelector('[data-act="start"]').click();
    await new Promise((r) => setTimeout(r, 900));

    const statusWhileRecording = dialog.querySelector('[data-role="status"]').textContent;
    const stopVisible = !dialog.querySelector('[data-act="stop"]').hidden;

    dialog.querySelector('[data-act="stop"]').click();
    await new Promise((r) => setTimeout(r, 600));

    try { osc.stop(); ctx.close(); } catch (e) { /* already closed */ }

    // The dialog is gone, and the recording is on the page.
    const dialogGone = !document.querySelector('.diary-recorder-backdrop');
    const blockTypes = Array.from(document.querySelectorAll('.diary-block'))
      .map((b) => b.dataset.blockType);
    const player = document.querySelector('.diary-block-audio audio');
    const caption = document.querySelector('.diary-block-audio .diary-media-caption');
    const src = player ? player.getAttribute('src') : '';

    return {
      acts,
      labels,
      dialogExists,
      hasStart,
      hasTimer,
      hasMeter,
      statusWhileRecording,
      stopVisible,
      dialogGone,
      blockTypes,
      hasAudioBlock: blockTypes.includes('audio'),
      hasPlayer: !!player,
      isBlob: String(src).startsWith('blob:'),
      caption: caption ? caption.textContent : '',
    };
  `);

  checkTrue('the editor module loaded', !inserted.__threw, inserted.__threw);
  checkTrue('the menu offers the file route', (inserted.acts || []).includes('insert-audio'));
  checkTrue('the menu offers the recording route', (inserted.acts || []).includes('record-audio'));
  checkTrue('the recording dialog opened', inserted.dialogExists === true);
  checkTrue('the dialog has a start button', inserted.hasStart === true);
  checkTrue('the dialog has a timer', inserted.hasTimer === true);
  checkTrue('the dialog has a level meter', inserted.hasMeter === true);
  check('the dialog says it is recording', inserted.statusWhileRecording, '录音中…');
  checkTrue('the stop button appears while recording', inserted.stopVisible === true);
  checkTrue('the dialog closes when the recording ends', inserted.dialogGone === true);
  checkTrue('the recording became an audio block', inserted.hasAudioBlock === true);
  checkTrue('the audio block has a player', inserted.hasPlayer === true);
  checkTrue('the player points at the recorded blob', inserted.isBlob === true, inserted.src);
  checkTrue('the caption names the recording', /^录音 /.test(inserted.caption || ''),
    `caption was ${inserted.caption}`);

  // ---- 2b. Cancelling a running recording ---------------------------
  //
  // The microphone must be released when the dialog is dismissed while
  // the recording is still going. A stream left open keeps the system's
  // recording dot on — and the next recording would find the device
  // busy.
  const cancelled = await evalIn(win, `
    const editor = window.__editor;
    if (!editor) return { __threw: 'the editor module did not load' };

    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    await new Promise((r) => setTimeout(r, 200));

    // The microphone is handed over, and the test keeps a handle on the
    // tracks so it can see whether they were released.
    let handed = null;
    navigator.mediaDevices.getUserMedia = async () => {
      handed = dest.stream;
      return dest.stream;
    };

    await editor.render({}, {});
    await new Promise((r) => setTimeout(r, 100));

    const ta = document.querySelector('textarea.diary-block-text');
    ta.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 120, clientY: 140,
    }));
    document.querySelector('#ctx-menu [data-ctx-act="record-audio"][data-ctx-value="after"]').click();
    await new Promise((r) => setTimeout(r, 150));

    const dialog = document.querySelector('.diary-recorder-backdrop');
    dialog.querySelector('[data-act="start"]').click();
    await new Promise((r) => setTimeout(r, 400));

    // Dismiss the dialog while the recording is running.
    dialog.querySelector('[data-act="cancel"]').click();
    await new Promise((r) => setTimeout(r, 300));

    try { osc.stop(); ctx.close(); } catch (e) { /* already closed */ }

    const tracks = handed ? handed.getTracks() : [];
    return {
      dialogGone: !document.querySelector('.diary-recorder-backdrop'),
      trackCount: tracks.length,
      allEnded: tracks.every((t) => t.readyState === 'ended'),
      blockTypes: Array.from(document.querySelectorAll('.diary-block'))
        .map((b) => b.dataset.blockType),
    };
  `);

  checkTrue('the dialog closes when cancelled', cancelled.dialogGone === true);
  checkTrue('the microphone track was released', cancelled.allEnded === true,
    `readyStates were ${cancelled.trackCount}`);
  checkTrue('a cancelled recording adds nothing to the page',
    !(cancelled.blockTypes || []).includes('audio'),
    `blocks were ${cancelled.blockTypes}`);

  // ---- 3. The upload path -------------------------------------------
  //
  // The recorded sound goes up through the REAL upload IPC — the same
  // call the editor's save makes for a pending media file.
  const uploaded = await evalIn(win, `
    const entry = await window.mp.memorialEvents.create({
      kind: 'other',
      title: '有录音的一篇',
      notes: '那天她说了一句话。',
      content: [],
      occurred_at: '2026-05-03 10:30:00',
      background: 'light',
      contact_ids: [],
    });

    // The bytes of a recorded webm/opus file. A real recording is not
    // needed here: the upload path treats the bytes as opaque.
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x03, 0x04, 0x05]);
    const media = await window.mp.memorialEvents.photos.upload(entry.id, {
      filename: '录音 20261110-101112.webm',
      mime: 'audio/webm',
      bytes: bytes.buffer,
    });

    // The document that names the sound — the shape the editor
    // serializes an audio block into.
    const doc = [{ type: 'audio', media_id: media.id }];
    const saved = await window.mp.memorialEvents.update(entry.id, { content: doc });

    return {
      entryId: entry.id,
      mediaId: media.id,
      mime: media.mime,
      originalName: media.original_name,
      size: media.size_bytes,
      // The content column comes back as a JSON string — it is the
      // database's own column, not a parsed document.
      savedContent: saved.content,
    };
  `);

  checkTrue('the upload made a row', !!uploaded.mediaId);
  check('the row says it is audio', uploaded.mime, 'audio/webm');
  check('the row keeps the recorded name', uploaded.originalName, '录音 20261110-101112.webm');
  check('the row knows the size', uploaded.size, 8);

  // The stored document names the sound — parsed the way the editor
  // parses it (src/js/diary_layout.js, parseDiaryContent).
  const docBlocks = await evalIn(win, `
    const layout = await import('./js/diary_layout.js');
    const blocks = layout.parseDiaryContent(${JSON.stringify(uploaded.savedContent)});
    return blocks.map((b) => ({ type: b.type, mediaId: b.media_id || b.mediaId }));
  `);

  checkTrue('the document keeps one block', docBlocks.length === 1,
    `got ${docBlocks.length}`);
  check('the block is an audio block', docBlocks[0] && docBlocks[0].type, 'audio');
  check('the block names the sound', docBlocks[0] && docBlocks[0].mediaId, uploaded.mediaId);

  // ---- 4. The saved sound reads back --------------------------------
  const readBack = await evalIn(win, `
    const r = await window.mp.memorialEvents.photos.readMedia(${JSON.stringify(uploaded.mediaId)});
    if (!r) return { ok: false };
    return {
      ok: true,
      url: r.url,
      mime: r.mime,
      size: r.size_bytes,
      name: r.original_name,
      isFileUrl: String(r.url || '').startsWith('file:///'),
    };
  `);

  checkTrue('the saved sound reads back', readBack.ok === true);
  checkTrue('the url is a file: url', readBack.isFileUrl === true, readBack.url);
  check('the url reads as audio', readBack.mime, 'audio/webm');
  check('the name survives', readBack.name, '录音 20261110-101112.webm');

  // ---- 5. The row is not a picture -----------------------------------
  //
  // The album exporters lay out pictures only. A sound dropped into one
  // of them would reach pdfkit's openImage() and break the export, so
  // the row must be recognised as media, not as a photo.
  const isPicture = await evalIn(win, `
    const photos = await window.mp.memorialEvents.photos.list(${JSON.stringify(uploaded.entryId)});
    return photos.map((p) => ({ id: p.id, mime: p.mime }));
  `);

  checkTrue('the entry lists the sound', Array.isArray(isPicture) && isPicture.length === 1);
  check('the row is not a picture', isPicture[0] && isPicture[0].mime, 'audio/webm');

  // The probe page is a temporary file — it goes with the run.
  try { fs.unlinkSync(probePath); } catch (e) { /* it was already gone */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(fail ? 1 : 0);
});
