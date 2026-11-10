// scripts/test-diary-media.js — proves the diary's video and audio
// attachments work against the REAL backend.
//
// The editor test (scripts/test-diary-editor.js) drives the renderer
// against a fake API, so it proves the page behaves. This one proves
// the other half: that a real movie really lands on disk, that the
// database row that points at it is written, that the document that
// names it survives the server's validation, and that the renderer can
// read the file back and play it.
//
// What it covers:
//
//   1. A real .mp4 (made by ffmpeg) uploads through the real IPC, lands
//      in the photos directory, and gets a row in memorial_event_photos.
//   2. The media url the renderer is handed is a file: URL that points
//      at that file, and the file plays in a <video> element.
//   3. A real .mp3 uploads the same way and plays in an <audio>.
//   4. The document that names them survives the server's validation
//      (main/diary_content.js) unchanged.
//   5. Deleting the media deletes the file on disk with it.
//
// Run: node scripts/run-electron.js scripts/test-diary-media.js

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

app.disableHardwareAcceleration();

// The test writes rows and media files, so it must not touch the
// user's own data. The appData directory — where the photos live — is
// pointed at a scratch folder for the run.
const SCRATCH = path.join(os.tmpdir(), 'soul-diary-media-test');
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

// A tiny movie: one frame of colour, a fraction of a second long. The
// point is a real, playable video file — not a stub with a .mp4 name.
function makeVideo(outPath) {
  const ffmpeg = require('ffmpeg-static');
  execFileSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outPath,
  ], { stdio: 'ignore' });
  return outPath;
}

// A tiny sound: a fraction of a second of a tone.
function makeAudio(outPath) {
  const ffmpeg = require('ffmpeg-static');
  execFileSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    outPath,
  ], { stdio: 'ignore' });
  return outPath;
}

let win;
let db;

app.whenReady().then(async () => {
  // The scratch directory is fixed for the run, so the preload can find
  // the two files without a handshake between them.
  const tmp = SCRATCH;
  fs.mkdirSync(tmp, { recursive: true });
  const videoPath = path.join(tmp, '我的 视频.mp4');
  const audioPath = path.join(tmp, 'song.mp3');
  try {
    makeVideo(videoPath);
    makeAudio(audioPath);
  } catch (e) {
    console.error('could not build the test media:', e);
    app.exit(1);
    return;
  }
  console.log(`  (built ${fs.statSync(videoPath).size} bytes of video, `
    + `${fs.statSync(audioPath).size} bytes of audio)`);

  // The real main process: the real database, the real IPC handlers.
  //
  // The database is a scratch one, NOT the user's own — the test writes
  // rows and files, and it must not touch what the user has. The
  // photos directory is the real one under the scratch userData, so the
  // file handling is exercised exactly as it is in the app.
  const dbPath = path.join(__dirname, '..', 'main', 'db.js');
  db = require(dbPath);
  await db.open(path.join(tmp, 'test.db'));

  // The real IPC handlers. The memorial-event channels this test uses
  // do not touch the pet, the queue or the reminder window, so the
  // stubs below are never reached — they are here only to satisfy the
  // register() signature.
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
      preload: path.join(__dirname, 'diary-media-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The test's preload reads the two media files off the disk, so it
      // needs Node's fs. The app's own preload does not — this is the
      // test's business only.
      sandbox: false,
    },
  });

  // The probe page loads the editor's modules. The API is the REAL one
  // here — the preload hands out the real IPC bridge.
  const SRC = path.join(__dirname, '..', 'src');
  const probePath = path.join(SRC, '.diary-media-probe.html');
  fs.writeFileSync(probePath, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./css/styles.css"></head><body>
<div id="app"></div><div id="toast-container"></div>
<script type="module">
const editor = await import('./js/pages/diary_edit.js');
window.__editor = editor;
window.__router = await import('./js/router.js');
</script></body></html>`);

  await win.loadFile(probePath);

  // The probe page imports the editor with a top-level await, and the
  // load event fires BEFORE that await settles — so the page can be
  // 'loaded' with the editor still on its way. Wait for it here rather
  // than tripping over it halfway through the run.
  await evalIn(win, `
    for (let i = 0; i < 100 && !window.__editor; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return typeof window.__editor;
  `);

  // A preload that throws leaves the page without its bridge, and the
  // failure is silent — so the console is echoed here.
  win.webContents.on('console-message', (e, level, message) => {
    console.log('  [renderer]', message);
  });

  const result = await evalIn(win, `
    // What did the preload actually hand over?
    const bridge = {
      hasMp: typeof window.mp,
      hasBytes: typeof window.__mediaBytes,
      hasEditor: typeof window.__editor,
      keys: Object.keys(window).filter(k => k.startsWith('__') || k === 'mp'),
    };
    if (typeof window.__mediaBytes !== 'function') return { bridge };

    // Upload the two real files through the REAL upload IPC — the same
    // call the editor's save makes.
    const videoBytes = new Uint8Array(window.__mediaBytes('video')).buffer;
    const audioBytes = new Uint8Array(window.__mediaBytes('audio')).buffer;

    // A first entry, so the media has an entry to hang from.
    const entry = await window.mp.memorialEvents.create({
      kind: 'other',
      title: '有视频的一篇',
      notes: '那天她唱了一首歌。',
      content: [],
      occurred_at: '2026-05-03 10:30:00',
      background: 'light',
      contact_ids: [],
    });

    const video = await window.mp.memorialEvents.photos.upload(entry.id, {
      filename: '我的 视频.mp4',
      mime: 'video/mp4',
      bytes: videoBytes,
    });
    const audio = await window.mp.memorialEvents.photos.upload(entry.id, {
      filename: 'song.mp3',
      mime: 'audio/mpeg',
      bytes: audioBytes,
    });

    // The document that names them — the shape the editor writes.
    const content = [
      { type: 'text', text: '那天她唱了一首歌。' },
      { type: 'video', media_id: video.id },
      { type: 'audio', media_id: audio.id },
    ];
    const saved = await window.mp.memorialEvents.update(entry.id, { content });

    // Read the media back the way the editor does.
    const videoInfo = await window.mp.memorialEvents.photos.readMedia(video.id);
    const audioInfo = await window.mp.memorialEvents.photos.readMedia(audio.id);

    // Can a <video> actually play the file the url points at? Ask the
    // element itself, not the filesystem.
    const v = document.createElement('video');
    v.src = videoInfo.url;
    v.preload = 'metadata';
    const videoMeta = await new Promise((resolve) => {
      let settled = false;
      const done = (ok, detail) => {
        if (settled) return;
        settled = true;
        resolve({ ok, detail, duration: v.duration, w: v.videoWidth, h: v.videoHeight });
      };
      v.onloadedmetadata = () => done(true, 'loadedmetadata');
      v.onerror = () => done(false, v.error ? String(v.error.code) : 'error');
      setTimeout(() => done(false, 'timeout'), 8000);
    });

    const a = document.createElement('audio');
    a.src = audioInfo.url;
    a.preload = 'metadata';
    const audioMeta = await new Promise((resolve) => {
      let settled = false;
      const done = (ok, detail) => {
        if (settled) return;
        settled = true;
        resolve({ ok, detail, duration: a.duration });
      };
      a.onloadedmetadata = () => done(true, 'loadedmetadata');
      a.onerror = () => done(false, a.error ? String(a.error.code) : 'error');
      setTimeout(() => done(false, 'timeout'), 8000);
    });

    // Now delete the video and see whether the file on disk goes with it.
    // The delete is the LAST thing that happens, so the checks above can
    // still look at the files.
    const filesBeforeDelete = null;

    // The real EDITOR, opening the entry that was just saved. The
    // players on the page have to play the saved files — this is the
    // case the user actually meets: the entry is saved, the page is
    // closed, and the entry is opened again.
    await window.__editor.render({ id: entry.id }, {});
    await new Promise((r) => setTimeout(r, 400));

    const pageVideo = document.querySelector('.diary-block-video video');
    const pageAudio = document.querySelector('.diary-block-audio audio');
    const pageVideoSrc = pageVideo ? (pageVideo.getAttribute('src') || '') : '';
    const pageAudioSrc = pageAudio ? (pageAudio.getAttribute('src') || '') : '';

    // Ask the page's own players whether they loaded.
    const pageVideoMeta = pageVideo
      ? await new Promise((resolve) => {
          let settled = false;
          const done = (ok, detail) => {
            if (settled) return;
            settled = true;
            resolve({ ok, detail, duration: pageVideo.duration });
          };
          if (pageVideo.readyState >= 1) done(true, 'already loaded');
          pageVideo.onloadedmetadata = () => done(true, 'loadedmetadata');
          pageVideo.onerror = () => done(false, pageVideo.error ? String(pageVideo.error.code) : 'error');
          setTimeout(() => done(false, 'timeout'), 8000);
        })
      : { ok: false, detail: 'no player on the page' };
    const pageAudioMeta = pageAudio
      ? await new Promise((resolve) => {
          let settled = false;
          const done = (ok, detail) => {
            if (settled) return;
            settled = true;
            resolve({ ok, detail, duration: pageAudio.duration });
          };
          if (pageAudio.readyState >= 1) done(true, 'already loaded');
          pageAudio.onloadedmetadata = () => done(true, 'loadedmetadata');
          pageAudio.onerror = () => done(false, pageAudio.error ? String(pageAudio.error.code) : 'error');
          setTimeout(() => done(false, 'timeout'), 8000);
        })
      : { ok: false, detail: 'no player on the page' };

    // And the real thing: press play and watch the media MOVE. Loading
    // the metadata is not the same as playing — a player that cannot
    // play shows a duration and stays still.
    //
    // The movement is what is waited for, not the playing event: a
    // short clip can finish before the event lands, and the clock is the
    // honest answer anyway.
    const playProbe = async (el) => {
      if (!el) return { ok: false, detail: 'no player', time: 0 };
      // play() returns a promise that settles only when the media starts
      // or fails. A player with no source can sit there forever, so the
      // wait is bounded — a broken player must fail the check, not hang
      // the whole run.
      const started = await Promise.race([
        (async () => {
          try {
            el.muted = true;
            await el.play();
            return 'started';
          } catch (e) {
            return 'refused: ' + String(e && e.message || e);
          }
        })(),
        new Promise((r) => setTimeout(() => r('never started'), 5000)),
      ]);
      if (started !== 'started') {
        return { ok: false, detail: 'play() ' + started, time: 0 };
      }
      // Poll the clock until it moves. The poll is a timer, not a
      // recursive call, so nothing spins.
      const deadline = Date.now() + 8000;
      let error = null;
      el.onerror = () => { error = el.error ? String(el.error.code) : 'error'; };
      let detail = 'timeout';
      let ok = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 60));
        if (error) { detail = error; break; }
        if (el.currentTime > 0) { ok = true; detail = 'playing'; break; }
      }
      const time = el.currentTime;
      el.pause();
      return { ok, detail, time };
    };

    const pageVideoPlay = await playProbe(pageVideo);
    const pageAudioPlay = await playProbe(pageAudio);

    // And the movie the user has JUST picked — before it is saved. It
    // lives in the browser's hands, so the player is pointed at a blob:
    // url, and it has to play from there.
    let pendingPlay = { ok: false, detail: 'not tried', time: 0 };
    let pendingSrc = '';
    let pendingDetail = '';
    // A FRESH page: the saved entry above is on the page now, and we
    // want an empty document to drop the picked movie into.
    await window.__editor.render({}, {});
    await new Promise((r) => setTimeout(r, 200));
    // The page was redrawn, so the picker is a new element now — the old
    // one is off the page and its handler is gone with it.
    const mediaInput = document.getElementById('diary-media');
    if (mediaInput) {
      const realBytes = new Uint8Array(window.__mediaBytes('video'));
      const picked = new File([realBytes], 'picked.mp4', { type: 'video/mp4' });
      mediaInput.click = () => {
        Object.defineProperty(mediaInput, 'files', { value: [picked], configurable: true });
        mediaInput.dispatchEvent(new Event('change'));
      };
      // Pick the file the way the editor does it: the text block's
      // right-click menu, then 「插入视频」.
      const ta = document.querySelector('.diary-block-text');
      if (ta) {
        ta.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 120, clientY: 140,
        }));
        const insertVideo = document.querySelector('#ctx-menu [data-ctx-act="insert-video"]');
        if (insertVideo) insertVideo.click();
        pendingDetail = insertVideo ? 'menu clicked' : 'no 插入视频 entry';
      } else {
        pendingDetail = 'no text block';
      }
      await new Promise((r) => setTimeout(r, 300));
      const pendingPlayer = document.querySelector('.diary-block-video video');
      pendingSrc = pendingPlayer ? (pendingPlayer.getAttribute('src') || '') : '';
      pendingPlay = await playProbe(pendingPlayer);
    } else {
      pendingDetail = 'no media picker';
    }

    return {
      entryId: entry.id,
      videoId: video.id,
      audioId: audio.id,
      videoMime: video.mime,
      audioMime: audio.mime,
      videoName: video.original_name,
      audioName: audio.original_name,
      videoSize: video.size_bytes,
      audioSize: audio.size_bytes,
      videoUrl: videoInfo.url,
      audioUrl: audioInfo.url,
      videoMimeOut: videoInfo.mime,
      audioMimeOut: audioInfo.mime,
      content: saved.content,
      videoMeta, audioMeta,
      pageVideoSrc, pageAudioSrc, pageVideoMeta, pageAudioMeta,
      pageVideoPlay, pageAudioPlay,
      pendingSrc, pendingPlay, pendingDetail,
      filesBeforeDelete,
    };
  `);

  if (result && result.__threw) {
    console.error('\n  the renderer threw:\n  ' + result.__threw + '\n');
    console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
    app.exit(1);
    return;
  }
  if (result && result.bridge) {
    console.error('\n  the preload did not expose its bridge:');
    console.error('  ' + JSON.stringify(result.bridge) + '\n');
    console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
    app.exit(1);
    return;
  }

  const photosDir = path.join(SCRATCH, 'SoulDesktopPet', 'photos', result.entryId);

  console.log('\n== 上传 ==');
  checkTrue('the video upload returned a row', !!result.videoId);
  checkTrue('the audio upload returned a row', !!result.audioId);
  check('the video kept its mime', result.videoMime, 'video/mp4');
  check('the audio kept its mime', result.audioMime, 'audio/mpeg');
  // The name with a space in it is the point: a name that needs
  // encoding must survive the round trip.
  check('the video kept its name', result.videoName, '我的 视频.mp4');
  check('the audio kept its name', result.audioName, 'song.mp3');
  checkTrue('the video has bytes on record', result.videoSize > 0);
  checkTrue('the audio has bytes on record', result.audioSize > 0);

  console.log('\n== 落盘 ==');
  const onDisk = fs.existsSync(photosDir) ? fs.readdirSync(photosDir) : [];
  checkTrue('the video is on disk', onDisk.some((f) => f.endsWith('.mp4')), onDisk.join(', '));
  checkTrue('the audio is on disk', onDisk.some((f) => f.endsWith('.mp3')), onDisk.join(', '));

  console.log('\n== 播放 ==');
  checkTrue('the video url is a file: url',
    (result.videoUrl || '').startsWith('file:///'), result.videoUrl);
  checkTrue('the audio url is a file: url',
    (result.audioUrl || '').startsWith('file:///'), result.audioUrl);
  // The url must be ENCODED: the user's own name sits in the path, and
  // a name with a space or a Chinese character in it will not load
  // otherwise.
  checkTrue('the video url is encoded',
    !result.videoUrl.includes(' '), result.videoUrl);
  checkTrue('the video url names the file',
    decodeURIComponent(result.videoUrl).endsWith('我的 视频.mp4'), result.videoUrl);
  checkTrue('the audio url names the file',
    decodeURIComponent(result.audioUrl).endsWith('song.mp3'), result.audioUrl);
  check('the mime came back with the video', result.videoMimeOut, 'video/mp4');
  check('the mime came back with the audio', result.audioMimeOut, 'audio/mpeg');
  checkTrue('the <video> element loaded the movie',
    result.videoMeta.ok, result.videoMeta.detail);
  checkTrue('the movie has a length', result.videoMeta.duration > 0, String(result.videoMeta.duration));
  checkTrue('the movie has a size', result.videoMeta.w === 64 && result.videoMeta.h === 48,
    `${result.videoMeta.w}x${result.videoMeta.h}`);
  checkTrue('the <audio> element loaded the sound',
    result.audioMeta.ok, result.audioMeta.detail);
  checkTrue('the sound has a length', result.audioMeta.duration > 0, String(result.audioMeta.duration));

  console.log('\n== 页面上的播放器 ==');
  // The editor, opening the saved entry. The players ON THE PAGE have to
  // play the saved files — this is the case the user meets every time:
  // the entry is saved, and the entry is opened again.
  checkTrue('the page has a video player', !!result.pageVideoSrc, result.pageVideoSrc);
  checkTrue('the page has an audio player', !!result.pageAudioSrc, result.pageAudioSrc);
  checkTrue('the page player points at the file on disk',
    String(result.pageVideoSrc).startsWith('file:///'), result.pageVideoSrc);
  checkTrue('the page player loaded the movie',
    result.pageVideoMeta.ok, result.pageVideoMeta.detail);
  checkTrue('the movie on the page has a length',
    result.pageVideoMeta.duration > 0, String(result.pageVideoMeta.duration));
  checkTrue('the page player loaded the sound',
    result.pageAudioMeta.ok, result.pageAudioMeta.detail);
  checkTrue('the sound on the page has a length',
    result.pageAudioMeta.duration > 0, String(result.pageAudioMeta.duration));

  console.log('\n== 真的播了 ==');
  // The player was pressed and the media moved. A player that can show a
  // duration but cannot play would still pass every check above.
  checkTrue('the movie on the page plays', result.pageVideoPlay.ok, result.pageVideoPlay.detail);
  checkTrue('the movie actually moved',
    result.pageVideoPlay.time > 0, String(result.pageVideoPlay.time));
  checkTrue('the sound on the page plays', result.pageAudioPlay.ok, result.pageAudioPlay.detail);
  checkTrue('the sound actually moved',
    result.pageAudioPlay.time > 0, String(result.pageAudioPlay.time));

  console.log('\n== 刚选中的文件 ==');
  // The movie the user has picked but NOT saved yet. It lives in the
  // browser's hands, so the player has to point at a blob: url — and it
  // still has to play, because the user wants to see what they attached
  // before they commit to it.
  checkTrue('the picked movie has a player', !!result.pendingSrc,
    result.pendingSrc + ' / ' + result.pendingDetail);
  checkTrue('the picked movie plays from the blob',
    result.pendingPlay.ok, result.pendingPlay.detail + ' / ' + result.pendingDetail);
  checkTrue('the picked movie actually moved',
    result.pendingPlay.time > 0, String(result.pendingPlay.time));

  console.log('\n== 文档 ==');
  // The `content` column holds a JSON string — the server canonicalizes
  // it on the way in.
  const doc = typeof result.content === 'string' ? JSON.parse(result.content) : result.content;
  const types = (doc || []).map((b) => b.type);
  check('the document keeps the block order', types, ['text', 'video', 'audio']);
  checkTrue('the document names the movie',
    doc[1] && doc[1].media_id === result.videoId);
  checkTrue('the document names the sound',
    doc[2] && doc[2].media_id === result.audioId);

  console.log('\n== 删除 ==');
  // Deleting the media takes the file on disk with it.
  await evalIn(win, `
    await window.mp.memorialEvents.photos.delete(${JSON.stringify(result.videoId)});
    return true;
  `);
  const afterDelete = fs.existsSync(photosDir) ? fs.readdirSync(photosDir) : [];
  checkTrue('the deleted movie is gone from the disk',
    !afterDelete.some((f) => f.endsWith('.mp4')), afterDelete.join(', '));
  checkTrue('the sound is still there',
    afterDelete.some((f) => f.endsWith('.mp3')), afterDelete.join(', '));

  // The probe page is a scratch file — take it away again.
  try { fs.unlinkSync(path.join(SRC, '.diary-media-probe.html')); } catch (e) {}

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
