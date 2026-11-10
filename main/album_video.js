// main/album_video.js — MP4 slideshow generator for memorial events.
//
// Pipeline (per plan §6):
//   Phase A: for each event, generate a 3-second title card clip and one
//            Ken-Burns clip per photo, into a temp directory.
//   Phase B: build a concat list, then run ffmpeg's concat demuxer to join
//            everything into a single MP4.
//
// Why child_process.spawn instead of fluent-ffmpeg's fluent API:
//   - We need the child handle for SIGTERM cancellation; the fluent API
//     hides the child and varies across versions.
//   - All commands have well-defined input shapes (lavfi / single image
//     loop / concat demuxer), so constructing argv arrays directly is
//     easier to reason about and to debug.
//
// Cancellation:
//   The IPC layer passes a `cancelCheck` callback (returns true when the
//   user has clicked 取消). We poll it every 250ms; once true, we
//   SIGTERM the current ffmpeg child. The transient error from the
//   killed ffmpeg propagates out of the promise; the IPC layer then
//   deletes the half-written output.
//
// HEIC handling:
//   ffmpeg-static's bundled ffmpeg does NOT include libheif, so it cannot
//   decode HEIC/HEIF. For each event we count such photos, surface a
//   warning via the return value, and substitute a 1-second black frame
//   for the Ken Burns slot so the concat list still lines up.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app } = require('electron');
const ffmpegStatic = require('ffmpeg-static');

let _ffmpegPath = null;
function getFfmpegPath() {
  if (_ffmpegPath) return _ffmpegPath;
  if (typeof ffmpegStatic === 'string') {
    _ffmpegPath = ffmpegStatic;
  } else if (ffmpegStatic && typeof ffmpegStatic === 'object' && ffmpegStatic.path) {
    _ffmpegPath = ffmpegStatic.path;
  } else {
    throw new Error('ffmpeg-static did not return a binary path');
  }
  return _ffmpegPath;
}

const VIDEO_W = 1280;
const VIDEO_H = 720;
const VIDEO_FPS = 30;
const TITLE_DUR = 3;       // seconds
const DEFAULT_PHOTO_DUR = 4; // seconds
const HEIC_SUBSTITUTE_DUR = 1;

// ---- CJK font resolution ------------------------------------------------

function pickCjkFontPath() {
  const candidates = [];
  if (process.platform === 'win32') {
    // ffmpeg's drawtext filter accepts both TTF and TTC, but TTF is more
    // portable across distros. Real TTF files first; TTC as fallback.
    candidates.push('C:\\Windows\\Fonts\\simhei.ttf');
    candidates.push('C:\\Windows\\Fonts\\simfang.ttf');
    candidates.push('C:\\Windows\\Fonts\\STKAITI.TTF');
    candidates.push('C:\\Windows\\Fonts\\NotoSansSC-VF.ttf');
    candidates.push('C:\\Windows\\Fonts\\msyh.ttc');
  } else if (process.platform === 'darwin') {
    candidates.push('/System/Library/Fonts/PingFang.ttc');
    candidates.push('/System/Library/Fonts/STHeiti Medium.ttc');
  } else {
    candidates.push('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc');
    candidates.push('/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc');
    candidates.push('/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc');
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// ---- Helpers ------------------------------------------------------------

function fmtDateOnly(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

// ffmpeg drawtext treats `:`, `\`, `%` and `'` specially inside the
// `text=` value when we build the filter inline. We always build filters
// with single-quoted `text='...'` so we only need to escape the
// characters that have meaning to the filter parser.
function escapeForDrawtext(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/'/g, "\\'")
    .replace(/\n/g, ' ');
}

// Build a fontfile argument for drawtext. We only emit it when we found
// a CJK font; otherwise we let ffmpeg fall back to its default (no
// CJK glyphs) so the failure is visible in the UI rather than silent.
function fontFileArg(cjkFont) {
  if (!cjkFont) return '';
  // ffmpeg filter strings use forward slashes for paths even on Windows.
  const norm = cjkFont.replace(/\\/g, '/').replace(/'/g, "\\'");
  return `:fontfile='${norm}'`;
}

// Direct child_process.spawn wrapper. We resolve on exit code 0, reject
// otherwise. `cancelCheck` is polled every 250ms; once true, we SIGTERM
// the running ffmpeg, surface a `.killed` error so callers can tell
// cancellation apart from a real failure.
function runFfmpeg({ args, cancelCheck }) {
  return new Promise((resolve, reject) => {
    const bin = getFfmpegPath();
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new Error(`spawn ffmpeg failed: ${e && e.message ? e.message : e}`));
    }

    let stderrBuf = '';
    let cancelled = false;
    const poll = setInterval(() => {
      if (cancelCheck && cancelCheck() && !cancelled) {
        cancelled = true;
        try { child.kill('SIGTERM'); } catch {}
      }
    }, 250);

    child.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-32 * 1024);
    });
    child.stdout.on('data', () => { /* swallow */ });
    child.on('error', (e) => {
      clearInterval(poll);
      reject(new Error(`ffmpeg spawn error: ${e && e.message ? e.message : e}`));
    });
    child.on('exit', (code, signal) => {
      clearInterval(poll);
      if (cancelled) {
        const e = new Error('cancelled');
        e.killed = true;
        return reject(e);
      }
      if (code === 0) return resolve();
      const e = new Error(`ffmpeg exited code=${code} signal=${signal}\n${stderrBuf}`);
      e.stderr = stderrBuf;
      reject(e);
    });
  });
}

// ---- Main entry ---------------------------------------------------------

// Is this row a picture? A movie and a sound live in the same table as
// the pictures, and ffmpeg is told to read each photo as an image. The
// mime column is the authority; the extension is the fallback for a row
// that never had one.
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);

function isPicture(p) {
  if (!p) return false;
  if (p.mime) return String(p.mime).toLowerCase().startsWith('image/');
  return IMAGE_EXT.has(path.extname(String(p.relative_path || '')).toLowerCase());
}

// Build the video album.
//
//   events:       Array<MemorialEventRowWithPhotos>
//   outPath:      string
//   options:      {
//     photoDuration?: number (default 4, clamped 2..10),
//     cancelCheck?:   () => bool,
//     progressCb?:    (phase, percent, note?) => void,
//   }
//
// Resolves with: {
//   events, photos, durationSec, bytes, heicSkipped, font: 'cjk'|'fallback'
// }
async function buildVideo({ events, outPath, options = {} }) {
  const photoDuration = Math.max(2, Math.min(10, options.photoDuration || DEFAULT_PHOTO_DUR));
  const cancelCheck = options.cancelCheck || (() => false);
  const progressCb = options.progressCb || (() => {});

  const safeProgress = (phase, percent, note) => {
    try { progressCb(phase, Math.max(0, Math.min(100, percent)), note); } catch {}
  };

  // Resolve photo paths and count HEIC.
  //
  // A movie and a sound live in the same table as the pictures. ffmpeg
  // here is told to read each photo as an IMAGE, so a video row would
  // break the encode — the pictures are kept and the rest dropped.
  const photoRoot = path.join(app.getPath('appData'), 'SoulDesktopPet', 'photos');
  let embeddable = 0;
  let heicCount = 0;
  for (const ev of events) {
    const rows = Array.isArray(ev.photos) ? ev.photos : [];
    ev.photos = [];
    for (const p of rows) {
      const ext = path.extname(String(p.relative_path || '')).toLowerCase();
      p.full_path = path.join(photoRoot, ev.id, path.basename(p.relative_path || ''));
      p._is_heic = ext === '.heic' || ext === '.heif' || (p.mime && /heic|heif/i.test(p.mime));
      if (!isPicture(p)) continue;
      if (p._is_heic) heicCount += 1;
      else if (fs.existsSync(p.full_path)) embeddable += 1;
      ev.photos.push(p);
    }
    ev.photos.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  }

  // Set up a temp working directory.
  const jobId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  const tmpDir = path.join(os.tmpdir(), `soul-desktop-pet-export-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const segDir = path.join(tmpDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });

  const cjkFont = pickCjkFontPath();
  const farg = fontFileArg(cjkFont);
  const segments = [];
  const totalSegments = events.reduce(
    (acc, ev) => acc + 1 + ev.photos.filter((p) => !p._is_heic && fs.existsSync(p.full_path)).length,
    0
  );
  let segIndex = 0;
  let totalDurationSec = 0;

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  const throwCancelled = () => {
    const e = new Error('cancelled');
    e.killed = true;
    throw e;
  };

  try {
    safeProgress('preparing', 0, '准备素材');

    // ---- Phase A: per-event segments ----------------------------------
    for (let ei = 0; ei < events.length; ei += 1) {
      if (cancelCheck()) throwCancelled();
      const ev = events[ei];
      const evTitle = ev.title || '(无标题)';
      const evDate = fmtDateOnly(ev.occurred_at);
      const evContacts = Array.isArray(ev.contact_names) && ev.contact_names.length
        ? ev.contact_names.join('、')
        : '';

      // --- Title card segment ---
      const titlePath = path.join(segDir, `title_${ei}.mp4`);
      segments.push({ path: titlePath, dur: TITLE_DUR, kind: 'title', label: evTitle });
      totalDurationSec += TITLE_DUR;
      segIndex += 1;
      safeProgress('encoding', totalSegments > 0 ? (segIndex / totalSegments) * 50 : 0,
        `生成标题卡（${ei + 1}/${events.length}）`);

      const titleText = escapeForDrawtext(evTitle);
      const subText = escapeForDrawtext(`${evDate}${evContacts ? '  ·  ' + evContacts : ''}`);
      const titleVf =
        `drawtext=text='${titleText}':fontsize=48:fontcolor=white:x=(w-tw)/2:y=(h/2-60)${farg},` +
        `drawtext=text='${subText}':fontsize=24:fontcolor=white@0.85:x=(w-tw)/2:y=(h/2+10)${farg}`;

      await runFfmpeg({
        args: [
          '-y',
          '-f', 'lavfi', '-i', `color=c=black:s=${VIDEO_W}x${VIDEO_H}:d=${TITLE_DUR}:r=${VIDEO_FPS}`,
          '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
          '-vf', titleVf,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
          '-pix_fmt', 'yuv420p', '-r', String(VIDEO_FPS),
          '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
          '-shortest',
          titlePath,
        ],
        cancelCheck,
      });

      // --- Per-photo segments ---
      for (let pi = 0; pi < ev.photos.length; pi += 1) {
        if (cancelCheck()) throwCancelled();
        const p = ev.photos[pi];

        if (p._is_heic || !fs.existsSync(p.full_path)) {
          // HEIC substitute: 1-second black frame
          const blackPath = path.join(segDir, `photo_${ei}_${pi}_black.mp4`);
          await runFfmpeg({
            args: [
              '-y',
              '-f', 'lavfi', '-i', `color=c=black:s=${VIDEO_W}x${VIDEO_H}:d=${HEIC_SUBSTITUTE_DUR}:r=${VIDEO_FPS}`,
              '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
              '-map', '0:v', '-map', '1:a',
              '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
              '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
              '-shortest',
              blackPath,
            ],
            cancelCheck,
          });
          segments.push({ path: blackPath, dur: HEIC_SUBSTITUTE_DUR, kind: 'placeholder', label: '（照片无法解码）' });
          totalDurationSec += HEIC_SUBSTITUTE_DUR;
          segIndex += 1;
          safeProgress('encoding', totalSegments > 0 ? (segIndex / totalSegments) * 50 : 0,
            `跳过 HEIC 照片（${pi + 1}/${ev.photos.length}）`);
          continue;
        }

        const photoPath = path.join(segDir, `photo_${ei}_${pi}.mp4`);
        segments.push({ path: photoPath, dur: photoDuration, kind: 'photo', label: p.original_name || '' });
        totalDurationSec += photoDuration;
        segIndex += 1;
        safeProgress('encoding', totalSegments > 0 ? (segIndex / totalSegments) * 50 : 0,
          `生成照片段（${segIndex}/${totalSegments}）`);

        const frames = Math.round(photoDuration * VIDEO_FPS);
        const zoomExpr = `min(zoom+0.0015,1.10)`;
        const xExpr = `iw/2-(iw/zoom/2)`;
        const yExpr = `ih/2-(ih/zoom/2)`;
        const photoVf =
          `scale=2000:-2,zoompan=z='${zoomExpr}':d=${frames}:x='${xExpr}':y='${yExpr}':s=${VIDEO_W}x${VIDEO_H}:fps=${VIDEO_FPS},` +
          `fade=in:0:15,fade=out:${Math.max(0, frames - 15)}:15`;

        await runFfmpeg({
          args: [
            '-y',
            '-loop', '1', '-t', String(photoDuration), '-i', p.full_path,
            '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
            '-vf', photoVf,
            '-map', '0:v', '-map', '1:a',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
            '-pix_fmt', 'yuv420p', '-r', String(VIDEO_FPS),
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-shortest',
            photoPath,
          ],
          cancelCheck,
        });
      }
    }

    if (cancelCheck()) throwCancelled();

    // ---- Phase B: concat all segments ---------------------------------
    if (segments.length === 0) {
      // No segments? Build a 1s of black so the file is still a valid MP4.
      await runFfmpeg({
        args: [
          '-y',
          '-f', 'lavfi', '-i', `color=c=black:s=${VIDEO_W}x${VIDEO_H}:d=1:r=${VIDEO_FPS}`,
          '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
          '-shortest',
          outPath,
        ],
        cancelCheck,
      });
    } else {
      const concatTxt = path.join(tmpDir, 'concat.txt');
      const lines = segments.map((s) => `file '${s.path.replace(/'/g, "'\\''")}'`);
      fs.writeFileSync(concatTxt, lines.join('\n') + '\n', 'utf8');

      safeProgress('finalizing', 50, '合并视频段');
      // Stream-copy for fast concat — all segments share identical codec,
      // resolution, framerate. Fall back to re-encode if the stream copy
      // fails for any reason.
      try {
        await runFfmpeg({
          args: [
            '-y',
            '-f', 'concat', '-safe', '0', '-i', concatTxt,
            '-c', 'copy',
            '-movflags', '+faststart',
            outPath,
          ],
          cancelCheck,
        });
      } catch (err) {
        if (cancelCheck() || err.killed) throw err;
        await runFfmpeg({
          args: [
            '-y',
            '-f', 'concat', '-safe', '0', '-i', concatTxt,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
            '-pix_fmt', 'yuv420p', '-r', String(VIDEO_FPS),
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-movflags', '+faststart',
            outPath,
          ],
          cancelCheck,
        });
      }
    }

    if (!fs.existsSync(outPath)) {
      throw new Error('output file missing after ffmpeg concat');
    }
    const bytes = fs.statSync(outPath).size;
    safeProgress('done', 100, '导出完成');
    return {
      events: events.length,
      photos: embeddable,
      durationSec: totalDurationSec,
      bytes,
      segments: segments.length,
      heicSkipped: heicCount,
      font: cjkFont ? 'cjk' : 'fallback',
    };
  } catch (err) {
    safeProgress('error', 0, err && err.message ? err.message : String(err));
    throw err;
  } finally {
    cleanup();
  }
}

module.exports = { buildVideo, pickCjkFontPath };
