// src/js/diary_audio_recorder.js — the 录音 dialog.
//
// 「插入音频」 in the diary editor used to mean one thing only: pick a
// file from the disk. But a 回忆事件 is a memory, and a lot of memories
// are a voice — a sentence said out loud, a laugh, the sound of a
// place. Making the user find a file for that is friction.
//
// So the audio insertion offers two doors: 从文件选择 (the old way) and
// 录音 (the new one). The recording happens here, in a small dialog
// that stays open while the user talks:
//
//   开始录音 → the microphone opens, a timer and a level meter run
//   停止     → the sound is handed back as a File
//   取消     → the microphone closes and nothing is kept
//
// The dialog never saves anything. It resolves with the recorded File
// (or null), and the editor puts that File through the same
// pending-media pipeline a picked file goes through — the same upload,
// the same audio block, the same preview before the entry is saved.
//
// The dialog is a modal because a recording is a moment the user is
// present for: a timer running behind another window is a timer
// nobody is watching.

import {
  startRecording, describeMicError,
} from './audio_recorder.js';

// Open the recording dialog.
//
// Returns a promise that resolves to the recorded File, or to null when
// the user cancelled or the recording failed.
export function openAudioRecorderDialog() {
  return new Promise((resolve) => {
    let recorder = null;
    let settled = false;
    let timerId = 0;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop diary-recorder-backdrop';
    backdrop.innerHTML = `
      <div class="modal diary-recorder-modal" role="dialog" aria-modal="true" aria-label="录音">
        <div class="modal-header">
          <h3>录音</h3>
          <button type="button" class="icon-btn" data-act="cancel" title="关闭">✕</button>
        </div>
        <div class="modal-body">
          <div class="diary-recorder-status" data-role="status">准备就绪</div>

          <div class="diary-recorder-timer" data-role="timer">00:00</div>

          <div class="diary-recorder-meter" data-role="meter" aria-hidden="true">
            <div class="diary-recorder-meter-fill" data-role="meter-fill"></div>
          </div>

          <div class="diary-recorder-hint" data-role="hint">按下「开始录音」，对着麦克风说话。</div>
        </div>

        <div class="modal-actions diary-recorder-actions">
          <button type="button" class="btn" data-act="start">开始录音</button>
          <button type="button" class="btn danger" data-act="stop" hidden>停止录音</button>
          <button type="button" class="btn secondary" data-act="cancel">取消</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const statusEl = backdrop.querySelector('[data-role="status"]');
    const timerEl = backdrop.querySelector('[data-role="timer"]');
    const meterEl = backdrop.querySelector('[data-role="meter"]');
    const meterFillEl = backdrop.querySelector('[data-role="meter-fill"]');
    const hintEl = backdrop.querySelector('[data-role="hint"]');
    const startBtn = backdrop.querySelector('[data-act="start"]');
    const stopBtn = backdrop.querySelector('[data-act="stop"]');

    // Close the dialog for good. The microphone is released first — a
    // dialog that closes while the recording is running would leave the
    // red dot on in the system tray.
    function close(result) {
      if (settled) return;
      settled = true;
      if (timerId) clearInterval(timerId);
      timerId = 0;
      if (recorder) {
        // A stop that is already under way is left to finish: the
        // recorder is closing itself.
        if (!stopping) recorder.cancel();
        recorder = null;
      }
      backdrop.remove();
      resolve(result);
    }

    // True while the recording is being wound up. A press on 取消 in
    // that moment must not cancel the recorder — the stop is already
    // under way, and tearing it down would leave the stop promise
    // unsettled.
    let stopping = false;

    // The timer ticks on its own interval rather than on a frame, so it
    // keeps the right time even when the window is not being painted.
    function startTimer() {
      timerId = setInterval(() => {
        if (!recorder) return;
        const s = Math.floor(recorder.elapsed());
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        timerEl.textContent = `${mm}:${ss}`;
      }, 200);
    }

    // The meter's bar.
    function onLevel(level) {
      const pct = Math.min(100, Math.round((level || 0) * 140));
      meterFillEl.style.width = pct + '%';
    }

    async function onStart() {
      startBtn.disabled = true;
      statusEl.textContent = '正在打开麦克风…';
      try {
        recorder = await startRecording(onLevel);
      } catch (e) {
        recorder = null;
        startBtn.disabled = false;
        statusEl.textContent = '无法录音';
        hintEl.textContent = describeMicError(e);
        return;
      }
      // Recording is under way: the start button goes away and the stop
      // button takes its place, so the dialog offers exactly one thing
      // at a time.
      startBtn.hidden = true;
      stopBtn.hidden = false;
      statusEl.textContent = '录音中…';
      hintEl.textContent = '对着麦克风说话，说完按下「停止录音」。';
      meterEl.classList.add('active');
      startTimer();
    }

    async function onStop() {
      stopBtn.disabled = true;
      const rec = recorder;
      if (!rec) { close(null); return; }
      stopping = true;
      statusEl.textContent = '正在处理…';
      let file = null;
      try {
        file = await rec.stop();
      } catch (e) {
        file = null;
      }
      stopping = false;
      recorder = null;
      if (timerId) { clearInterval(timerId); timerId = 0; }
      if (!file) {
        // Nothing was captured — the user stopped too early, or the
        // microphone gave back silence.
        stopBtn.disabled = false;
        statusEl.textContent = '没有录到声音';
        hintEl.textContent = '请重新录一次。';
        stopBtn.hidden = true;
        startBtn.hidden = false;
        startBtn.disabled = false;
        meterEl.classList.remove('active');
        meterFillEl.style.width = '0%';
        return;
      }
      // The caption is what the audio block shows under the player.
      close(file);
    }

    startBtn.addEventListener('click', onStart);
    stopBtn.addEventListener('click', onStop);
    backdrop.querySelectorAll('[data-act="cancel"]').forEach((el) => {
      el.addEventListener('click', () => close(null));
    });

    // Clicking the backdrop (but not the dialog) dismisses it, the way
    // the rest of the app's modals behave.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    const onKey = (e) => {
      if (e.key === 'Escape' && backdrop.isConnected) {
        close(null);
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  });
}
