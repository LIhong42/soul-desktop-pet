// src/js/pages/tool_batch_resize.js — detail page for /tools/batch-resize
//
// Detail UI for the batch image-resize tool: the user picks a folder of
// images, chooses how much to shrink them by, picks an output folder, and
// main/image_batch_resize.js runs ffmpeg's `scale` filter over the tree.
//
// The source folder is never modified. Every output file lands in a
// folder the user chooses, and the source's sub-directory structure is
// mirrored into it — a folder of animation frames keeps its per-action
// sub-folders.
//
// The factor is a *divisor*, not a percentage: 2 means "shrink to half",
// 4 means "shrink to a quarter". The presets cover the common cases and
// the custom field takes anything else, including fractions like 1.5.
//
// Transparency survives the resize. ffmpeg's scaler runs on RGBA, so a
// cut-out character frame keeps its soft anti-aliased edges instead of
// getting hard jaggies — which is the whole reason the project decodes
// to RGBA everywhere else too.
//
// State is module-scoped (single-page app), matching tool_transparent_png.js.
// Progress arrives on the shared `tools:progress` channel; we subscribe on
// mount and tear the subscription down on every re-render so a cancel that
// re-renders can't leave us double-listening.
import { api, escapeHtml, toast } from '../api.js';
import { register } from '../router.js';

const state = {
  running: false,
  // null | { jobId, phase, percent, note }
  progress: null,
  // null | { outputDir, count, failed, factor }
  result: null,
  inputErrors: { factor: null },
  // 'custom' or one of the preset values
  factorMode: '2',
  customFactor: 2,
  recursive: true,
  unsubscribeProgress: null,
};

// Preset divisors. These mirror main/image_batch_resize.js's PRESET_FACTORS;
// the authoritative list lives in main, but the UI needs the labels up
// front and the module exports the same array for anyone who wants to
// check them.
const FACTOR_PRESETS = [
  { value: '2', label: '1/2', hint: '缩小到一半' },
  { value: '3', label: '1/3', hint: '缩小到三分之一' },
  { value: '4', label: '1/4', hint: '缩小到四分之一' },
  { value: '8', label: '1/8', hint: '缩小到八分之一' },
  { value: 'custom', label: '自定义', hint: '自己填写倍数' },
];

const MIN_FACTOR = 0.1;
const MAX_FACTOR = 100;

function unsubscribeIfAny() {
  if (typeof state.unsubscribeProgress === 'function') {
    try { state.unsubscribeProgress(); } catch {}
    state.unsubscribeProgress = null;
  }
}

function phaseLabel(phase) {
  switch (phase) {
    case 'resizing':  return '正在缩小';
    case 'encoding':  return '导出中';
    case 'done':      return '完成';
    case 'error':     return '出错';
    default:          return phase || '';
  }
}

// The factor that will actually be sent to main, or null when the custom
// field holds something we can't use.
function effectiveFactor() {
  if (state.factorMode === 'custom') {
    const n = Number(state.customFactor);
    if (!Number.isFinite(n) || n < MIN_FACTOR || n > MAX_FACTOR) return null;
    return n;
  }
  const n = Number(state.factorMode);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function factorHint() {
  const f = effectiveFactor();
  if (!f) return '请输入一个有效的倍数。';
  if (f === 1) return '当前：1 倍，即不改变尺寸。';
  return `当前：宽高各缩小为原来的 1/${f}。`;
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
  return `
    <div class="card tools-result">
      <div class="tools-result-head">
        <strong>✓ 已完成缩小</strong>
        <span class="meta">成功 ${escapeHtml(String(r.count))} 张${r.failed ? ` · 跳过 ${escapeHtml(String(r.failed))} 张` : ''}</span>
      </div>
      <div class="tools-result-body">
        <div class="tools-result-path">输出文件夹：<code>${escapeHtml(r.outputDir || '')}</code></div>
        <div class="meta" style="margin-top:6px;">原图未被修改，缩小的图片已按原有子目录结构写入输出文件夹。</div>
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
  const factorError = state.inputErrors.factor;
  const canStart = !state.running;
  const isCustom = state.factorMode === 'custom';

  app.innerHTML = `
    <a class="back-link" href="#/tools">‹ 返回工具列表</a>
    <h1>图片批量缩小</h1>
    <p class="meta">把一个文件夹里的所有图片按指定倍数缩小，结果写入另一个文件夹。<b>原图不会被修改</b>。整个流程在本地运行，不会上传到任何服务器。</p>

    <div class="card tools-card">
      <h2>参数</h2>
      <div class="form-row">
        <div class="field">
          <label for="tools-resize-factor">缩小倍数</label>
          <select id="tools-resize-factor" ${state.running ? 'disabled' : ''}>
            ${FACTOR_PRESETS.map((o) => `
              <option value="${escapeHtml(o.value)}" ${o.value === state.factorMode ? 'selected' : ''}>
                ${escapeHtml(o.label)} · ${escapeHtml(o.hint)}
              </option>
            `).join('')}
          </select>
          <div class="meta">${escapeHtml(isCustom ? '在下方填写自定义倍数。' : factorHint())}</div>
          ${factorError ? `<div class="field-error">${escapeHtml(factorError)}</div>` : ''}
        </div>
        <div class="field">
          <label for="tools-resize-custom">自定义倍数</label>
          <input type="number" id="tools-resize-custom" min="${MIN_FACTOR}" max="${MAX_FACTOR}" step="0.1"
                 value="${escapeHtml(String(state.customFactor))}"
                 ${state.running || !isCustom ? 'disabled' : ''}/>
          <div class="meta">倍数大于 1 表示缩小：2 = 缩小到一半，3 = 缩小到三分之一。允许小数。</div>
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label><input type="checkbox" id="tools-resize-recursive" ${state.recursive ? 'checked' : ''}
                        ${state.running ? 'disabled' : ''}/> 包含子文件夹</label>
          <div class="meta">开启后递归处理所有子目录，并在输出文件夹中保留同样的目录结构。</div>
        </div>
      </div>

      <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:8px;">
        <button type="button" class="btn" id="tools-pick-btn" ${canStart ? '' : 'disabled'}>
          选择文件夹并开始…
        </button>
      </div>

      ${renderProgress()}
      ${renderResult()}
    </div>

    <div class="card tools-help">
      <h2>说明</h2>
      <ul class="meta">
        <li>整个过程会依次让你选择<b>源文件夹</b>和<b>输出文件夹</b>。源文件夹只读，缩小的图片全部写入输出文件夹。</li>
        <li>源文件夹里的<b>子目录结构会被原样复制</b>到输出文件夹 —— 例如 <code>动作A/</code>、<code>动作B/</code> 里的图片仍会分开放置。</li>
        <li>透明 PNG 的<b>透明通道会完整保留</b>，半透明边缘不会被压成实心，因此抠过图的角色素材缩小后依然没有白边或锯齿。</li>
        <li>带透明通道的图片一律输出为 <b>PNG</b>（无损），普通 JPG 等没有透明通道的格式会保持原格式。</li>
        <li>缩放使用 <b>lanczos</b> 算法，画质损失小，适合角色立绘这类边缘精细的素材。</li>
        <li>尺寸按<b>四舍五入</b>取整，宽高各自独立计算，比例不会有偏差。</li>
        <li>输出文件夹不会被清空 —— 里面已有的其他文件会保留，但同名的图片会被本次结果覆盖。</li>
        <li>为防止误操作，输出文件夹<b>不能与源文件夹相同</b>，也不能位于源文件夹内部。</li>
        <li>处理时间与图片数量和尺寸相关；中途点击「取消」会立即终止（已生成的图片会保留）。</li>
      </ul>
    </div>
  `;

  wireUi();
}

function wireUi() {
  const pickBtn = document.getElementById('tools-pick-btn');
  if (pickBtn) pickBtn.addEventListener('click', onPick);

  const modeEl = document.getElementById('tools-resize-factor');
  if (modeEl) {
    modeEl.addEventListener('change', () => {
      state.factorMode = modeEl.value || '2';
      state.inputErrors.factor = null;
      render();
    });
  }

  const customEl = document.getElementById('tools-resize-custom');
  if (customEl) {
    customEl.addEventListener('input', () => {
      state.customFactor = Number(customEl.value);
    });
  }

  const recEl = document.getElementById('tools-resize-recursive');
  if (recEl) {
    recEl.addEventListener('change', () => {
      state.recursive = !!recEl.checked;
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

  const factor = effectiveFactor();
  if (!factor) {
    state.inputErrors.factor = `倍数需要在 ${MIN_FACTOR} – ${MAX_FACTOR} 之间`;
    render();
    return;
  }
  state.inputErrors.factor = null;

  state.running = true;
  state.result = null;
  state.progress = { jobId: null, phase: 'resizing', percent: 0, note: '正在打开文件夹选择…' };
  render();

  // Subscribe BEFORE the IPC call so the first progress message (main
  // pushes it while the dialog is still open) isn't dropped.
  ensureSubscribed();

  try {
    const out = await api.tools.batchResizeImages({
      factor,
      recursive: state.recursive,
    });
    if (out && out.canceled) {
      // User backed out of one of the native dialogs, or hit 取消. Treat
      // as a benign no-op so they don't see an error toast.
      state.running = false;
      state.progress = null;
      render();
      return;
    }
    if (!out) {
      throw new Error('未拿到处理结果');
    }
    state.running = false;
    state.progress = null;
    state.result = {
      outputDir: out.outputDir || '',
      count: out.count || 0,
      failed: out.failed || 0,
      factor: out.factor || factor,
    };
    render();
    if (!state.result.count) {
      toast('没有找到可处理的图片');
    }
  } catch (err) {
    console.error('[tools] batchResizeImages failed:', err);
    state.running = false;
    state.progress = null;
    render();
    toast('批量缩小失败：' + (err && err.message ? err.message : String(err)));
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
  if (!state.result || !state.result.outputDir) return;
  try {
    const ok = await api.tools.revealInFolder(state.result.outputDir);
    if (!ok) toast('找不到文件夹，可能已被移动或删除');
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
      phase: msg.phase || 'resizing',
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

register('/tools/batch-resize', () => {
  // Module-scoped state survives navigation, but a hard route load should
  // not duplicate the progress listener.
  unsubscribeIfAny();
  render();
  ensureSubscribed();
});
