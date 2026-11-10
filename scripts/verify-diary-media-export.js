// scripts/verify-diary-media-export.js — checks that a video or an audio
// never reaches the album exporters.
//
// A movie and a sound live in the SAME table as the pictures
// (`memorial_event_photos`); the `mime` column says which is which. The
// album is a book of PICTURES, though:
//
//   - pdfkit's openImage() throws on anything that is not an image,
//   - ffmpeg is told to read each photo as an image,
//   - Word only eats image formats.
//
// So a diary that carries a movie must still export. This script proves
// the pictures are kept and the media is dropped, at every layer that
// decides what a "photo" is:
//
//   1. The list query's photo_count / photo_ids count pictures only.
//   2. The export query's photo_count / first_photo_id are pictures only.
//   3. The PDF and Word exporters embed the picture only.
//   4. The album layout builder skips a video row.
//
// It runs under Electron because the exporters ask the app where the
// photos live.
//
// Run: node scripts/run-electron.js scripts/verify-diary-media-export.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

// The exporters read the photos out of the app's own photos directory,
// and this test writes a picture there. The appData path is pointed at a
// scratch folder so the user's own files are never touched.
const SCRATCH = path.join(os.tmpdir(), 'soul-diary-media-export-test');
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-diary-media-export-'));

app.whenReady().then(async () => {
  const db = require('../main/db.js');
  await db.open(path.join(tmpDir, 'test.sqlite'));

  // One entry carrying a picture, a movie and a sound.
  const EVENT = 'ev_media';
  db.run(
    `INSERT INTO memorial_events(id, kind, title, notes, occurred_at, created_at, updated_at, background, content)
     VALUES (?, 'other', '有视频的一篇', '那天她唱了一首歌。',
             '2026-05-03 10:30:00', '2026-05-03 10:30:00', '2026-05-03 10:30:00', 'light', ?)`,
    [EVENT, JSON.stringify([
      { type: 'text', text: '那天她唱了一首歌。' },
      { type: 'gallery', layout: 'one', photos: [{ photo_id: 'p_pic' }] },
      { type: 'video', media_id: 'm_vid' },
      { type: 'audio', media_id: 'm_aud' },
    ])]
  );

  const now = '2026-05-03 10:30:00';
  const rows = [
    ['p_pic', 'photos/ev_media/pic.jpg', 'pic.jpg', 'image/jpeg'],
    ['m_vid', 'photos/ev_media/movie.mp4', 'movie.mp4', 'video/mp4'],
    ['m_aud', 'photos/ev_media/song.mp3', 'song.mp3', 'audio/mpeg'],
    // A row with no mime at all — an old upload, before the column knew
    // about movies. The extension has to carry the decision.
    ['p_old', 'photos/ev_media/old.JPG', 'old.JPG', null],
    // A row with no mime and a movie extension.
    ['m_old', 'photos/ev_media/old.mp4', 'old.mp4', null],
  ];
  for (const [id, rel, name, mime] of rows) {
    db.run(
      `INSERT INTO memorial_event_photos(id, memorial_event_id, relative_path, original_name, mime, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, 10, ?)`,
      [id, EVENT, rel, name, mime, now]
    );
  }

  console.log('\n== 列表查询 ==');
  const listed = db.listMemorialEvents({});
  const row = listed.find((r) => r.id === EVENT);
  checkTrue('the entry is listed', !!row);
  // The picture and the mime-less .JPG. The two media rows are not
  // pictures, so they must not be counted.
  check('the photo count is the pictures only', row.photo_count, 2);
  check('the photo ids are the pictures only', row.photo_ids, ['p_pic', 'p_old']);
  check('the first photo is a picture', row.first_photo_id, 'p_pic');

  console.log('\n== 导出查询 ==');
  const exported = db.listMemorialEventsForExport({});
  const exRow = exported.find((r) => r.id === EVENT);
  checkTrue('the entry is exported', !!exRow);
  check('the export photo count is the pictures only', exRow.photo_count, 2);
  check('the export first photo is a picture', exRow.first_photo_id, 'p_pic');

  console.log('\n== 导出器 ==');
  // The exporters read the pictures out of the app's photos directory,
  // so the picture has to be a real file there.
  const photosDir = path.join(SCRATCH, 'SoulDesktopPet', 'photos', EVENT);
  fs.mkdirSync(photosDir, { recursive: true });
  // A real 1x1 JPEG — pdfkit must be able to open it.
  fs.writeFileSync(path.join(photosDir, 'pic.jpg'), Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
    'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIA' +
    'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
    'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
    'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
    'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEB' +
    'AAA/APn+iiigD//Z',
    'base64'));

  // The media files have to be REAL files on disk, or the "the file is
  // missing" branch would hide the bug the test is looking for: a video
  // that exists would be handed to ffmpeg as an image.
  fs.writeFileSync(path.join(photosDir, 'movie.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]));
  fs.writeFileSync(path.join(photosDir, 'song.mp3'), Buffer.from([0x49, 0x44, 0x33]));
  checkTrue('the video file is on disk', fs.existsSync(path.join(photosDir, 'movie.mp4')));
  checkTrue('the sound file is on disk', fs.existsSync(path.join(photosDir, 'song.mp3')));

  const pictures = [
    { id: 'p_pic', relative_path: 'photos/ev_media/pic.jpg', mime: 'image/jpeg' },
    { id: 'm_vid', relative_path: 'photos/ev_media/movie.mp4', mime: 'video/mp4' },
    { id: 'm_aud', relative_path: 'photos/ev_media/song.mp3', mime: 'audio/mpeg' },
  ];
  const event = {
    id: EVENT,
    title: '有视频的一篇',
    occurred_at: '2026-05-03 10:30:00',
    notes: '那天她唱了一首歌。',
    contact_names: [],
    photos: pictures.slice(),
  };

  const albumPdf = require('../main/album_pdf.js');
  const albumDocx = require('../main/album_docx.js');

  const pdfOut = path.join(tmpDir, 'album.pdf');
  const pdfStats = await albumPdf.buildAlbum({
    events: [JSON.parse(JSON.stringify(event))],
    outPath: pdfOut,
  });
  checkTrue('the pdf export produced a file', fs.existsSync(pdfOut));
  // Only the picture could be embedded: the video and the sound are not
  // image formats, so pdfkit and Word would both refuse them.
  check('the pdf export embedded the picture only', pdfStats.photos, 1);

  const docxOut = path.join(tmpDir, 'album.docx');
  const docxStats = await albumDocx.buildAlbum({
    events: [JSON.parse(JSON.stringify(event))],
    outPath: docxOut,
  });
  checkTrue('the docx export produced a file', fs.existsSync(docxOut));
  check('the docx export embedded the picture only', docxStats.photos, 1);

  // The video exporter hands each photo to ffmpeg as an IMAGE, so a
  // movie row would break the encode outright. It must be dropped
  // before ffmpeg ever sees it.
  const albumVideo = require('../main/album_video.js');
  const mp4Out = path.join(tmpDir, 'album.mp4');
  let mp4Stats = null;
  let mp4Error = null;
  try {
    mp4Stats = await albumVideo.buildVideo({
      events: [JSON.parse(JSON.stringify(event))],
      outPath: mp4Out,
      options: { photoDuration: 2 },
    });
  } catch (e) {
    mp4Error = e;
  }
  checkTrue('the mp4 export did not fail', !mp4Error, mp4Error ? String(mp4Error.message) : '');
  if (mp4Stats) {
    checkTrue('the mp4 export produced a file', fs.existsSync(mp4Out));
    check('the mp4 export embedded the picture only', mp4Stats.photos, 1);
  }

  console.log('\n== 相册排版 ==');
  // The renderer-side builder: a video row must not occupy a slot. It is
  // an ES module and it touches the DOM, so it runs in a renderer.
  const SRC = path.join(__dirname, '..', 'src');
  const probePath = path.join(SRC, '.diary-media-export-probe.html');
  fs.writeFileSync(probePath, `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
window.__builder = await import('./js/album_builder.js');
</script></body></html>`);

  const win = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(probePath);
  // The probe page imports the module in a module script, so it may not
  // have landed yet when the page reports it is loaded.
  await win.webContents.executeJavaScript(
    `(async () => { for (let i = 0; i < 100 && !window.__builder; i += 1) {
       await new Promise((r) => setTimeout(r, 50));
     } return !!window.__builder; })()`, true);
  const layoutResult = await win.webContents.executeJavaScript(
    `(async () => {
       const b = window.__builder;
       const event = ${JSON.stringify(event)};
       const layout = b.buildAlbumLayout([event], { themeId: 'classic' });
       const slotIds = [];
       for (const p of layout.pages) {
         for (const s of (p.slots || [])) if (s.photoId) slotIds.push(s.photoId);
       }
       return { slotIds, stats: layout.stats };
     })()`,
    true);
  check('the layout puts the picture in a slot', layoutResult.slotIds, ['p_pic']);
  check('the layout counts the picture only', layoutResult.stats.photos, 1);
  // A video is not a HEIC, so it must not be counted as a skipped photo.
  check('the layout skips nothing', layoutResult.stats.heicSkipped, 0);

  // The probe page is a scratch file — take it away again.
  try { fs.unlinkSync(probePath); } catch (e) {}

  db.close();
  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
