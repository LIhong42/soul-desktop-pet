// src/js/audio_recorder.js — records a voice clip from the microphone.
//
// The diary editor can attach a sound to a 回忆事件 in two ways: pick a
// file from the disk, or speak it now. The second way is the one this
// module serves — it asks the OS for the microphone, records what the
// user says, and hands the result back as an ordinary `File`.
//
// A `File` is the point of the design. The editor's media pipeline
// already knows how to upload a picked file and how to play it back
// before it is saved (see src/js/pages/diary_edit.js, insertMediaAfterTextBlock
// and the pendingMedia list). A recording that came out of this module
// is just another File, so it rides that pipeline unchanged: the same
// pending-media list, the same upload, the same audio block, the same
// blob: preview.
//
// ---- The format ----
//
// MediaRecorder hands back whatever the browser likes — on Chromium
// that is usually `audio/webm;codecs=opus`. The bytes are a real
// container, so the extension must match it or the player will not
// load it. The mime the recorder reports is therefore taken at face
// value and turned into an extension, and the file is named after it.
//
// The one wrinkle: `audio/webm` is also the mime of a video/webm, and
// the editor's own kind sniffing (`fileKindFor`) says "anything that is
// not audio/ is a video". A webm sound reports `audio/webm`, so it
// lands on the audio side — but the extension is .webm for both, so the
// mime is what decides the kind, and it is stored in the database row.
//
// ---- Permissions ----
//
// The main process grants microphone access to the main window (see
// main/main.js, the `media` permission handler). Without it
// getUserMedia rejects with NotAllowedError, and the dialog turns that
// into a message rather than a silent failure.

// The mime types we would rather record in, best first. Chromium
// supports webm/opus in every build; the others are only used if the
// browser refuses the first choice.
const PREFERRED_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

// The extension each mime gets on disk. A mime with parameters
// (`audio/webm;codecs=opus`) is matched on its type/subtype only.
const MIME_EXTENSIONS = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
};

// The extension a mime maps to. '' when the mime is unknown — the
// caller then falls back to the recorder's own name or .webm.
export function extensionForMime(mime) {
  const bare = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[bare] || '';
}

// The mime the recorder should use. The browser's own list is the
// source of truth: it says what this build can actually record.
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const supported = (typeof MediaRecorder.isTypeSupported === 'function')
    ? MediaRecorder.isTypeSupported
    : () => false;
  for (const mime of PREFERRED_MIMES) {
    if (supported(mime)) return mime;
  }
  return '';
}

// Ask for the microphone.
//
// Returns the stream. Throws on refusal — the caller turns that into a
// message for the user, because "it did nothing" is the worst possible
// answer to a pressed button.
export async function requestMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('NO_MIC_SUPPORT');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // The default is fine for a voice clip: the browser turns the
      // noise suppression and the echo cancellation on by itself.
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
}

// A recording in progress.
//
// The object owns the stream and the recorder, and it must be closed
// either way: a stream that is left open keeps the microphone's red
// dot on in the system tray forever.
export class AudioRecorder {
  constructor(stream, recorder, chunks) {
    this.stream = stream;
    this.recorder = recorder;
    this.chunks = chunks;
    this.mime = recorder.mimeType || '';
    this.startedAt = 0;
    // Frees the level meter's animation frame and audio context. Set
    // by attachLevelMeter; null when there is no meter.
    this.cleanupMeter = null;
  }

  // Stop recording and hand back the sound as a File.
  //
  // Resolves to null when nothing was captured — a recording of zero
  // length is not a sound, and saving an empty file would only make a
  // broken player on the page.
  stop() {
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        this.closeStream();
        fn(arg);
      };
      this.recorder.onstop = () => {
        try {
          const blob = new Blob(this.chunks, { type: this.mime || 'application/octet-stream' });
          if (!blob.size) {
            done(resolve, null);
            return;
          }
          done(resolve, new File([blob], this.fileName(), { type: blob.type }));
        } catch (e) {
          done(reject, e);
        }
      };
      try {
        this.recorder.stop();
      } catch (e) {
        done(reject, e);
      }
    });
  }

  // Throw the recording away and close the microphone.
  //
  // The stop handler is taken off first: a cancelled recording must not
  // hand back a File afterwards, and the handler left on the recorder
  // would fire the moment the recorder is stopped.
  cancel() {
    this.recorder.onstop = null;
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch (e) { /* the recorder was already stopped */ }
    this.closeStream();
  }

  // Release everything the recording holds: the microphone and the
  // meter. Every teardown path goes through here, so the red dot in
  // the system tray always goes away.
  closeStream() {
    if (this.cleanupMeter) {
      try { this.cleanupMeter(); } catch (e) { /* the meter was already freed */ }
      this.cleanupMeter = null;
    }
    try {
      this.stream.getTracks().forEach((t) => t.stop());
    } catch (e) { /* the stream was already closed */ }
  }

  // The name the sound is saved under. It carries the moment it was
  // recorded, so a folder of voice clips can be told apart.
  fileName() {
    const ext = extensionForMime(this.mime) || '.webm';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `录音 ${stamp}${ext}`;
  }

  // The length of the recording so far, in seconds.
  elapsed() {
    if (!this.startedAt) return 0;
    return (Date.now() - this.startedAt) / 1000;
  }
}

// Start recording.
//
// `onLevel` (optional) is called with a 0..1 number for the input level,
// so the dialog can show a meter. It is called often — the caller
// should keep it cheap.
//
// Returns an AudioRecorder. Throws on refusal.
export async function startRecording(onLevel) {
  const stream = await requestMicrophone();

  const mime = pickMimeType();
  let recorder;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    // The browser said it supported the mime but refused to build a
    // recorder with it. Fall back to its own default rather than
    // failing the whole recording.
    try {
      recorder = new MediaRecorder(stream);
    } catch (e2) {
      stream.getTracks().forEach((t) => t.stop());
      throw e2;
    }
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  const rec = new AudioRecorder(stream, recorder, chunks);
  rec.startedAt = Date.now();
  recorder.start();

  if (typeof onLevel === 'function') attachLevelMeter(rec, onLevel);
  return rec;
}

// Watch the input level.
//
// The level comes from an AnalyserNode fed by the same stream. The
// meter is a nicety, not the point of the recording, so a browser that
// cannot build the audio graph must not break the recording: the
// failure is swallowed and the meter simply stays flat.
function attachLevelMeter(rec, onLevel) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(rec.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      try { onLevel(peak); } catch (e) { /* the caller threw */ }
      raf = requestAnimationFrame(tick);
    };
    tick();

    // The meter must not outlive the recording: the animation frame
    // keeps running until it is cancelled, and the context stays open.
    rec.cleanupMeter = () => {
      cancelAnimationFrame(raf);
      try { ctx.close(); } catch (e) { /* already closed */ }
    };
  } catch (e) {
    // No audio graph — the recording carries on without a meter.
  }
}

// Turn a microphone failure into a message the user can act on.
export function describeMicError(err) {
  const name = (err && err.name) || '';
  const msg = String((err && err.message) || err || '');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '麦克风权限被拒绝。请在系统设置里允许本应用使用麦克风后重试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到麦克风设备。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被占用，请关闭正在使用麦克风的程序后重试。';
  }
  if (msg === 'NO_MIC_SUPPORT' || name === 'NotSupportedError') {
    return '当前环境不支持录音。';
  }
  return '无法开始录音：' + (msg || name || '未知错误');
}

// A short label for a recorded sound, used as the caption.
export function recordingCaption(durationSeconds) {
  const s = Math.max(0, Math.round(durationSeconds || 0));
  if (s < 60) return `录音 ${s} 秒`;
  const m = Math.floor(s / 60);
  return `录音 ${m} 分 ${s % 60} 秒`;
}
