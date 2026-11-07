// src/js/pages/tool_video_frames.js — detail page for /tools/video-frames
//
// Detail UI for the first /tools entry: extract every Nth frame from an
// uploaded video and pack the PNG/JPG outputs into a zip. The user picks
// a video, sets FPS + image format, and main/ipc.js drives ffmpeg +
// AdmZip. Progress flows through `tools:progress` and we render the
// same percentage/phase card the export page uses so the two pages feel
// consistent.
//
// State is module-scoped (single-page app, no concurrent renders), matching
// the convention used elsewhere (export.js). On mount we subscribe to the
// progress channel and tear the subscription down on every re-render so
// we never double-listen — same lifecycle pattern as `unsubscribeIfAny`
// in export.js.
import { api, escapeHtml, toast } from '../api.js';
import { register } from '../router.js';

const state = {
  running: false,
  // null | { jobId, phase, percent, note }
  progress: null,
  // null | { path, frames, bytes }
  result: null,
  // inputErrors surfaces simple field problems above the buttons.
  inputErrors: { fps: null },
  unsubscribeProgress: null,
};

function unsubscribeIfAny() {
  if (typeof state.unsubscribeProgress === 'function') {
    try { state.unsubscribeProgress(); } catch {}
    state.unsubscribeProgress = null;
  }
}

function phaseLabel(phase) {
  switch (phase) {
    case 'preparing':  return '准备中';
    case 'encoding':   return '正在拆帧';
    case 'finalizing': return '正在打包';
    case 'done':       return '完成';
    case 'error':      return '出错';
    default:           return phase || '';
  }
}

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderProgress() {
  if (!state.progress) return '';
  const p = state.progress;
  const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
  return `
    <div class="card tools-progress" data-job-id="${escapeHtml(p.jobId || '')}">
      <div class="tools-progress-head">
        <strong>正在拆帧…</strong>
        <span>${escapeHtml(phaseLabel(p.phase))}${p.note ? ' · ' + escapeHtml(p.note) : ''}</span>
      </div>
      <div class="tools-progress-bar"><div class="tools-progress-fill" style="width:${pct}%"></div></div>
      <div class="tools-progress-foot">
        <span>${pct}%</span>
        <button type="button" class="btn secondary" id="tools-cancel-btn">取消</button>
      </div>
    </div>
  `;
}

function renderResult() {
  if (!state.result) return '';
  const r = state.result;
  const sizeLabel = formatBytes(r.bytes);
  return `
    <div class="card tools-result">
      <div class="tools-result-head">
        <strong>✓ 拆帧完成</strong>
        <span class="meta">共 <strong>${Number(r.frames) || 0}</strong> 张图片${sizeLabel ? ' · ' + escapeHtml(sizeLabel) : ''}</span>
      </div>
      <div class="tools-result-body">
        <div class="tools-result-path">已保存到：<code>${escapeHtml(r.path || '')}</code></div>
        <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:8px;">
          <button type="button" class="btn" id="tools-reveal-btn">打开所在文件夹</button>
          <button type="button" class="btn secondary" id="tools-new-btn">再来一次</button>
        </div>
      </div>
    </div>
  `;
}

function render() {
  const app = document.getElementById('app');
  const fpsError = state.inputErrors.fps;
  const canStart = !state.running;

  // "返回工具列表" reuses the standard back-link style so the user can
  // recover the index even when they navigated straight to this URL.
  app.innerHTML = `
    <div class="page-column">
    <a class="back-link" href="#/tools">‹ 返回工具列表</a>
    <h1>视频拆帧</h1>
    <p class="meta">上传一个本地视频，按指定帧率逐帧导出为图片，再打包为 zip 压缩包。整个流程在本地运行，不会上传到任何服务器。</p>

    <div class="card tools-card">
      <h2>参数</h2>
      <div class="form-row">
        <div class="field">
          <label for="tools-fps">抽帧速率 (帧/秒)</label>
          <input type="number" id="tools-fps" min="0.1" max="60" step="0.1" value="1"
                 ${state.running ? 'disabled' : ''}/>
          <div class="meta">取值 0.1 – 60；默认值 1 表示每秒抽 1 帧。</div>
          ${fpsError ? `<div class="field-error">${escapeHtml(fpsError)}</div>` : ''}
        </div>
        <div class="field">
          <label for="tools-format">输出格式</label>
          <select id="tools-format" ${state.running ? 'disabled' : ''}>
            <option value="png" selected>PNG (无损，体积大)</option>
            <option value="jpg">JPG (有损，体积小)</option>
          </select>
        </div>
      </div>

      <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:8px;">
        <button type="button" class="btn" id="tools-pick-btn" ${canStart ? '' : 'disabled'}>
          选择视频并开始…
        </button>
      </div>

      ${renderProgress()}
      ${renderResult()}
    </div>

    <div class="card tools-help">
      <h2>说明</h2>
      <ul class="meta">
        <li>支持常见视频格式（mp4 / mov / mkv / webm / avi / m4v 等）。</li>
        <li>输出文件名示例：<code>frame_0001_200.png</code>，其中 0001 是该帧的序号（4 位），末尾是每一帧的间隔毫秒数（3 位，零填充，所有图片共用同一值）。例如抽帧速率 5 帧/秒 时全部为 200，10 帧/秒 时全部为 100。</li>
        <li>处理时间取决于视频时长和帧率；超过几分钟的视频建议先做小批量测试。</li>
        <li>中途点击「取消」会立即终止 ffmpeg，并删除未完成的 zip。</li>
      </ul>
    </div>
    </div>
  `;

  wireUi();
}

function wireUi() {
  // Selectively wire each control — they may not exist after a cancel
  // re-render (e.g. the user might race-click cancel and start anew).
  const pickBtn = document.getElementById('tools-pick-btn');
  if (pickBtn) pickBtn.addEventListener('click', onPick);

  const fpsEl = document.getElementById('tools-fps');
  if (fpsEl) {
    fpsEl.addEventListener('input', () => {
      if (state.inputErrors.fps) {
        state.inputErrors.fps = null;
        // Clear inline error without re-rendering the whole card;
        // cheaper and avoids losing focus on the input.
        const errEl = document.querySelector('.tools-card .field-error');
        if (errEl) errEl.remove();
      }
    });
  }

  const cancelBtn = document.getElementById('tools-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', onCancel);

  const revealBtn = document.getElementById('tools-reveal-btn');
  if (revealBtn) revealBtn.addEventListener('click', onReveal);

  const newBtn = document.getElementById('tools-new-btn');
  if (newBtn) newBtn.addEventListener('click', () => {
    state.result = null;
    render();
  });
}

// Validate FPS on submit. We avoid clamping silently — the user is the one
// who knows whether they wanted 0.5 fps vs 5 fps. We keep the bad input
// intact so they can fix it without re-typing.
function validateFps() {
  const el = document.getElementById('tools-fps');
  if (!el) return null;
  const v = Number(el.value);
  if (!Number.isFinite(v) || v <= 0) {
    state.inputErrors.fps = '请输入大于 0 的数字';
    return null;
  }
  if (v > 60) {
    state.inputErrors.fps = '最大支持 60 帧/秒';
    return null;
  }
  state.inputErrors.fps = null;
  return v;
}

async function onPick() {
  if (state.running) return;
  const fps = validateFps();
  if (fps == null) {
    render();
    return;
  }
  const fmtEl = document.getElementById('tools-format');
  const format = fmtEl ? (fmtEl.value || 'png') : 'png';

  state.running = true;
  state.result = null;
  state.progress = { jobId: null, phase: 'preparing', percent: 0, note: '正在打开文件选择…' };
  render();

  // Subscribe BEFORE the IPC call so the first progress message (which
  // main pushes while the dialog is still open) isn't dropped.
  ensureSubscribed();

  try {
    const out = await api.tools.splitVideo({ fps, format });
    if (out && out.canceled) {
      // User canceled one of the native dialogs. Treat as a benign
      // no-op so they don't see an error toast for clicking "取消".
      state.running = false;
      state.progress = null;
      render();
      return;
    }
    if (!out || !out.path) {
      throw new Error('未拿到结果路径');
    }
    state.running = false;
    state.progress = null;
    state.result = {
      path: out.path,
      frames: out.frames || 0,
      bytes: out.bytes || 0,
    };
    render();
  } catch (err) {
    console.error('[tools] splitVideo failed:', err);
    state.running = false;
    state.progress = null;
    render();
    toast('拆帧失败：' + (err && err.message ? err.message : String(err)));
  }
}

async function onCancel() {
  if (!state.progress || !state.progress.jobId) {
    // No jobId yet means main hasn't started ffmpeg — just reset state.
    state.running = false;
    state.progress = null;
    render();
    return;
  }
  const jobId = state.progress.jobId;
  try {
    await api.tools.cancel({ jobId });
  } catch (err) {
    console.error('[tools] cancel failed:', err);
  }
  // Don't preemptively clear progress — main will eventually send
  // a final progress message (or simply exit and the user will get a
  // toast-free re-render via the cancel path in onPick).
  toast('已取消');
}

async function onReveal() {
  if (!state.result || !state.result.path) return;
  try {
    const ok = await api.tools.revealInFolder(state.result.path);
    if (!ok) toast('找不到文件，可能已被移动或删除');
  } catch (err) {
    console.error('[tools] reveal failed:', err);
    toast('打开文件夹失败');
  }
}

function ensureSubscribed() {
  if (typeof state.unsubscribeProgress === 'function') return;
  state.unsubscribeProgress = api.on('tools:progress', (msg) => {
    if (!msg) return;
    state.progress = {
      jobId: msg.jobId || state.progress && state.progress.jobId,
      phase: msg.phase || 'encoding',
      percent: typeof msg.percent === 'number' ? msg.percent : (state.progress ? state.progress.percent : 0),
      note: msg.note || null,
    };
    if (msg.phase === 'done') {
      // Final update lands before the IPC promise resolves. Leave the
      // state alone so renderResult() takes over cleanly when onPick
      // finishes; just refresh the progress card in place for the
      // user to see 100%.
      const fillEl = document.querySelector('.tools-progress-fill');
      const pctEl = document.querySelector('.tools-progress-foot > span');
      if (fillEl) fillEl.style.width = '100%';
      if (pctEl) pctEl.textContent = '100%';
      return;
    }
    // Live-update without a full re-render so the page doesn't flicker
    // each progress message.
    const card = document.querySelector('.tools-progress');
    if (!card) return;
    const pct = Math.max(0, Math.min(100, Math.round(state.progress.percent || 0)));
    const fill = card.querySelector('.tools-progress-fill');
    const lbl = card.querySelector('.tools-progress-foot > span');
    const head = card.querySelector('.tools-progress-head > span');
    if (fill) fill.style.width = pct + '%';
    if (lbl) lbl.textContent = pct + '%';
    if (head) head.textContent = `${phaseLabel(state.progress.phase)}${state.progress.note ? ' · ' + state.progress.note : ''}`;
  });
}

register('/tools/video-frames', () => {
  // Tear down any stale subscription on re-render (same pattern as
  // export.js — module-scoped state survives navigation, but a hard
  // route load should not duplicate listeners).
  unsubscribeIfAny();
  render();
  ensureSubscribed();
});
