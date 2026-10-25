// src/js/pages/tool_transparent_png.js — detail page for /tools/transparent-png
//
// Detail UI for the background-removal tool: the user picks an image,
// chooses how tolerant the background match should be and whether to
// soften the cut edge, then main/image_bg_remove.js computes a transparent
// PNG.
//
// "Transparent everywhere outside the outline" is decided in main by
// connectivity, not color — that's why this page doesn't offer a manual
// color picker the way a colorkey tool would. Interior regions that share
// the background color survive because the outline separates them from the
// image border, and so do the character's black hair and clothing even
// when the backdrop is black too. The tolerance control only widens how
// far a pixel may stray from the estimated background color, so it's the
// knob that matters for noisy or soft-shadowed sources.
//
// State is module-scoped (single-page app), matching tool_video_frames.js.
// Progress arrives on the shared `tools:progress` channel; we subscribe on
// mount and tear the subscription down on every re-render so a cancel that
// re-renders can't leave us double-listening.
import { api, escapeHtml, toast } from '../api.js';
import { register } from '../router.js';

const state = {
  running: false,
  // null | { jobId, phase, percent, note }
  progress: null,
  // null | { path, width, height, bytes, transparentRatio }
  result: null,
  inputErrors: { tolerance: null },
  tolerance: 'normal',
  softness: 0,
  unsubscribeProgress: null,
};

const TOLERANCE_OPTIONS = [
  { value: 'strict', label: '严格', hint: '背景干净、边界清晰时使用' },
  { value: 'normal', label: '标准', hint: '默认，适合大多数图片' },
  { value: 'loose', label: '宽松', hint: '背景有噪点或渐变投影时使用' },
];

function unsubscribeIfAny() {
  if (typeof state.unsubscribeProgress === 'function') {
    try { state.unsubscribeProgress(); } catch {}
    state.unsubscribeProgress = null;
  }
}

function phaseLabel(phase) {
  switch (phase) {
    case 'probing':  return '读取图片';
    case 'decoding': return '解码中';
    case 'analyzing':return '识别背景';
    case 'encoding': return '导出 PNG';
    case 'done':     return '完成';
    case 'error':    return '出错';
    default:         return phase || '';
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

function currentToleranceOption() {
  return TOLERANCE_OPTIONS.find((o) => o.value === state.tolerance) || TOLERANCE_OPTIONS[1];
}

function renderProgress() {
  if (!state.progress) return '';
  const p = state.progress;
  const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
  return `
    <div class="card tools-progress" data-job-id="${escapeHtml(p.jobId || '')}">
      <div class="tools-progress-head">
        <strong>正在处理…</strong>
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
  const pct = Math.round((r.transparentRatio || 0) * 1000) / 10;
  return `
    <div class="card tools-result">
      <div class="tools-result-head">
        <strong>✓ 已生成透明背景 PNG</strong>
        <span class="meta">${escapeHtml(String(r.width))} × ${escapeHtml(String(r.height))}${sizeLabel ? ' · ' + escapeHtml(sizeLabel) : ''}</span>
      </div>
      <div class="tools-result-body">
        <div class="tools-result-path">已保存到：<code>${escapeHtml(r.path || '')}</code></div>
        <div class="meta" style="margin-top:6px;">透明区域约占 ${escapeHtml(String(pct))}%。</div>
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
  const tolError = state.inputErrors.tolerance;
  const canStart = !state.running;
  const tolOpt = currentToleranceOption();

  app.innerHTML = `
    <a class="back-link" href="#/tools">‹ 返回工具列表</a>
    <h1>图片去背景</h1>
    <p class="meta">选择一张图片，自动把边界线以外的背景变透明，边界线以内的部分完整保留（包括与背景颜色相同的内部区域）。整个流程在本地运行，不会上传到任何服务器。</p>

    <div class="card tools-card">
      <h2>参数</h2>
      <div class="form-row">
        <div class="field">
          <label for="tools-tolerance">容差</label>
          <select id="tools-tolerance" ${state.running ? 'disabled' : ''}>
            ${TOLERANCE_OPTIONS.map((o) => `
              <option value="${escapeHtml(o.value)}" ${o.value === state.tolerance ? 'selected' : ''}>
                ${escapeHtml(o.label)} · ${escapeHtml(o.hint)}
              </option>
            `).join('')}
          </select>
          <div class="meta">当前：${escapeHtml(tolOpt.hint)}。</div>
          ${tolError ? `<div class="field-error">${escapeHtml(tolError)}</div>` : ''}
        </div>
        <div class="field">
          <label for="tools-softness">边缘柔化：<span id="tools-softness-val">${state.softness}</span></label>
          <input type="range" id="tools-softness" min="0" max="4" step="1" value="${state.softness}"
                 ${state.running ? 'disabled' : ''}/>
          <div class="meta">0 为硬边（边缘锐利）；数值越大边缘过渡越柔和，可减少深色背景上的白边光晕。</div>
        </div>
      </div>

      <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:8px;">
        <button type="button" class="btn" id="tools-pick-btn" ${canStart ? '' : 'disabled'}>
          选择图片并开始…
        </button>
      </div>

      ${renderProgress()}
      ${renderResult()}
    </div>

    <div class="card tools-help">
      <h2>说明</h2>
      <ul class="meta">
        <li>工作方式：先估计图片四边的背景颜色，再把与背景颜色相近的像素标记为「背景候选」；这些候选会分成若干连通区域，只有<b>与图片边缘相连</b>的那些才真正算背景并转为透明。</li>
        <li>因此，被轮廓线围住的区域一律保留——哪怕它和背景颜色完全一样。这正是与普通「按颜色抠图」的区别。</li>
        <li>所以角色身上的<b>黑色头发、黑色衣服、黑色轮廓</b>不会被误删，哪怕背景同样是黑色。</li>
        <li>如果原图在角色外围有一圈<b>白色「贴纸」描边</b>，它会一并被去掉——描边是按位置识别的（紧贴边缘的窄亮带），因此角色内部被包围的白色头发、衬衫和皮肤都会保留；角色本身是亮色时不会被误判。</li>
        <li>抠图在角色内部造成的空洞会被自动补上，不会留下黑洞。</li>
        <li>若背景带有渐变投影或压缩噪点导致边缘残留，请把「容差」调到<b>宽松</b>再试。</li>
        <li>支持常见图片格式（png / jpg / bmp / webp 等），输出统一为透明 PNG，尺寸与原图一致。</li>
        <li>处理时间与图片尺寸相关；超大图片（约 4000 万像素以上）请先缩小。</li>
        <li>中途点击「取消」会立即终止处理。</li>
      </ul>
    </div>
  `;

  wireUi();
}

function wireUi() {
  const pickBtn = document.getElementById('tools-pick-btn');
  if (pickBtn) pickBtn.addEventListener('click', onPick);

  const tolEl = document.getElementById('tools-tolerance');
  if (tolEl) {
    tolEl.addEventListener('change', () => {
      state.tolerance = tolEl.value || 'normal';
      if (state.inputErrors.tolerance) state.inputErrors.tolerance = null;
      const errEl = document.querySelector('.tools-card .field-error');
      if (errEl) errEl.remove();
      const hint = document.querySelector('.tools-card .field .meta');
      if (hint) hint.textContent = `当前：${currentToleranceOption().hint}。`;
    });
  }

  const softEl = document.getElementById('tools-softness');
  if (softEl) {
    softEl.addEventListener('input', () => {
      state.softness = Number(softEl.value) || 0;
      const valEl = document.getElementById('tools-softness-val');
      if (valEl) valEl.textContent = state.softness;
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

async function onPick() {
  if (state.running) return;

  // Guard against a value we don't have a preset for (defensive — the
  // <select> can only emit known values, but state is module-scoped).
  if (!TOLERANCE_OPTIONS.some((o) => o.value === state.tolerance)) {
    state.inputErrors.tolerance = '容差取值无效';
    render();
    return;
  }
  state.inputErrors.tolerance = null;

  state.running = true;
  state.result = null;
  state.progress = { jobId: null, phase: 'probing', percent: 0, note: '正在打开文件选择…' };
  render();

  // Subscribe BEFORE the IPC call so the first progress message (main
  // pushes it while the dialog is still open) isn't dropped.
  ensureSubscribed();

  try {
    const out = await api.tools.removeImageBackground({
      tolerance: state.tolerance,
      softness: state.softness,
    });
    if (out && out.canceled) {
      // User backed out of one of the native dialogs, or hit 取消. Treat
      // as a benign no-op so they don't see an error toast.
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
      width: out.width || 0,
      height: out.height || 0,
      bytes: out.bytes || 0,
      transparentRatio: out.transparentRatio || 0,
    };
    render();
  } catch (err) {
    console.error('[tools] removeImageBackground failed:', err);
    state.running = false;
    state.progress = null;
    render();
    toast('去背景失败：' + (err && err.message ? err.message : String(err)));
  }
}

async function onCancel() {
  if (!state.progress || !state.progress.jobId) {
    // No jobId yet means main hasn't started work — just reset state.
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
  // Don't preemptively clear progress — main's promise settles and onPick
  // re-renders through the canceled branch above.
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
      jobId: msg.jobId || (state.progress && state.progress.jobId),
      phase: msg.phase || 'decoding',
      percent: typeof msg.percent === 'number' ? msg.percent : (state.progress ? state.progress.percent : 0),
      note: msg.note || null,
    };
    if (msg.phase === 'done') {
      // Final update lands before the IPC promise resolves. Leave state
      // alone so renderResult() takes over cleanly; just show 100%.
      const fillEl = document.querySelector('.tools-progress-fill');
      const pctEl = document.querySelector('.tools-progress-foot > span');
      if (fillEl) fillEl.style.width = '100%';
      if (pctEl) pctEl.textContent = '100%';
      return;
    }
    // Live-update in place so the page doesn't flicker per message.
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

register('/tools/transparent-png', () => {
  // Module-scoped state survives navigation, but a hard route load should
  // not duplicate the progress listener.
  unsubscribeIfAny();
  render();
  ensureSubscribed();
});