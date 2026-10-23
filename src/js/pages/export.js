// src/js/pages/export.js — /export page
//
// Filter memorial events by contact + time range, preview the matching set,
// then export as PDF (album) or MP4 (video). Material comes strictly from
// `memorial_events` + `memorial_event_photos`; the UI never reaches into
// the reminder `events` table, contact avatars, or important dates.
//
// State is module-level (single-page app, no concurrent renders). The
// page subscribes to `api.on('export:progress', ...)` on mount and
// unsubscribes when navigated away (window hashchange or before
// re-rendering on filter change).
//
// Two views inside the page: 'filter' (default) and 'editor' (the
// WYSIWYG album layout editor). The editor is mounted into a single
// `<div id="album-editor-root">` shell and torn down on back/leave.
import { api, escapeHtml, toast, fetchPhotoDataUrl, memorialPhotoUrl } from '../api.js';
import { register } from '../router.js';
import { ALL, CUSTOM, buildPresetList, applyFilter, fmtForChip, ymd } from '../export_filter.js';
import { mountEditor, destroyEditor } from './album_editor.js';

const state = {
  contacts: [],
  events: [],                 // last preview response
  selectedContactIds: new Set(),
  presetValue: ALL,
  customRange: { start: '', end: '' },
  selectedEventIds: new Set(),
  exporting: null,            // { jobId, kind, phase, percent, note }
  unsubscribeProgress: null,
  lastFilterKey: null,        // for de-dup
  loading: false,
  view: 'filter',             // 'filter' | 'editor'
  lastEditorLayout: null,     // for passing through to doExport
};

function unsubscribeIfAny() {
  if (typeof state.unsubscribeProgress === 'function') {
    try { state.unsubscribeProgress(); } catch {}
    state.unsubscribeProgress = null;
  }
}

function formatDateOnly(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function phaseLabel(phase) {
  switch (phase) {
    case 'preparing':  return '准备中';
    case 'encoding':   return '正在编码';
    case 'finalizing': return '收尾中';
    case 'done':       return '完成';
    case 'error':      return '出错了';
    default:           return phase || '';
  }
}

function renderPresetOptions(nowGroups) {
  const { presets, yearlyGroups } = nowGroups;
  const fixed = presets
    .map((p) => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`)
    .join('');
  const yearly = yearlyGroups.map((g) => `
    <optgroup label="${escapeHtml(String(g.year))} 年">
      ${g.quarters.map((q) =>
        `<option value="${escapeHtml(q.value)}">${escapeHtml(String(g.year) + ' ' + q.label)}</option>`
      ).join('')}
      ${g.months.map((m) =>
        `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`
      ).join('')}
    </optgroup>
  `).join('');
  return fixed + yearly;
}

function renderContactChipList() {
  if (state.contacts.length === 0) {
    return `<p class="meta">还没有联系人 — 先去添加联系人和回忆事件再回来。</p>`;
  }
  return state.contacts.map((c) => {
    const selected = state.selectedContactIds.has(c.id);
    return `<button type="button" class="chip ${selected ? 'chip-selected' : ''}"
              data-contact-id="${escapeHtml(c.id)}"
              data-selected="${selected ? '1' : '0'}">
      ${escapeHtml(fmtForChip(c) || c.id)}
    </button>`;
  }).join('');
}

function renderEventList() {
  if (state.events.length === 0) {
    return `<p class="meta">没有匹配的事件。请调整筛选条件，或先到「回忆事件」页新增。</p>`;
  }
  return state.events.map((e) => {
    const checked = state.selectedEventIds.has(e.id);
    const names = (e.contact_names || []).filter(Boolean);
    const summary = names.length
      ? (names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 人`)
      : '独立事件';
    const photoCount = e.photo_count || 0;
    const thumbId = e.first_photo_id;
    const thumb = thumbId
      ? `<img class="export-thumb" src="${escapeHtml(memorialPhotoUrl(thumbId))}"
                data-photo-id="${escapeHtml(thumbId)}" alt="" loading="lazy"/>`
      : '';
    return `
      <label class="export-event-row" data-event-id="${escapeHtml(e.id)}">
        <input type="checkbox" class="export-event-check"
               data-event-id="${escapeHtml(e.id)}" ${checked ? 'checked' : ''}/>
        <div class="export-event-body">
          <div class="export-event-title">${escapeHtml(e.title || '(无标题)')}</div>
          <div class="export-event-meta">
            <span>${escapeHtml(formatDateOnly(e.occurred_at))}</span>
            <span>·</span>
            <span>${escapeHtml(summary)}</span>
            <span>·</span>
            <span>${photoCount} 张照片</span>
          </div>
        </div>
        <div class="export-event-thumb">${thumb}</div>
      </label>
    `;
  }).join('');
}

function renderExportProgress() {
  if (!state.exporting) return '';
  const e = state.exporting;
  const pct = Math.max(0, Math.min(100, Math.round(e.percent || 0)));
  return `
    <div class="card export-progress" data-job-id="${escapeHtml(e.jobId)}">
      <div class="export-progress-head">
        <strong>${escapeHtml(e.kind === 'docx' ? '正在导出相册 (Word)…'
          : e.kind === 'pdf' ? '正在导出相册 (PDF)…' : '正在导出视频 (MP4)…')}</strong>
        <span>${escapeHtml(phaseLabel(e.phase))} ${e.note ? '· ' + escapeHtml(e.note) : ''}</span>
      </div>
      <div class="export-progress-bar"><div class="export-progress-fill" style="width:${pct}%"></div></div>
      <div class="export-progress-foot">
        <span>${pct}%</span>
        <button type="button" class="btn secondary" id="export-cancel-btn">取消</button>
      </div>
    </div>
  `;
}

function render() {
  const app = document.getElementById('app');
  if (state.view === 'editor') {
    renderEditorView(app);
    return;
  }
  const nowGroups = buildPresetList(new Date(), 5);
  const totalEvents = state.events.length;
  const totalPhotos = state.events.reduce((acc, e) => acc + (e.photo_count || 0), 0);
  const selectedCount = state.selectedEventIds.size;
  const hasEvents = totalEvents > 0;
  const exporting = state.exporting;
  const exportDisabled = !hasEvents || selectedCount === 0 || exporting;

  app.innerHTML = `
    <h1>导出回忆</h1>
    <p class="meta">按联系人和时间段筛选已记录的回忆事件，导出为 PDF / Word 相册或 MP4 视频。素材仅来自「回忆事件」中已上传的事件与照片。</p>

    <div class="card">
      <h2>筛选条件</h2>
      <div class="form-row">
        <div class="field" style="flex:1; min-width:240px;">
          <label>关联联系人</label>
          <div class="chip-list" id="export-contacts">
            <div class="chip-list-actions">
              <a href="#" data-action="contacts-all">全选</a>
              <a href="#" data-action="contacts-none">清空</a>
            </div>
            ${renderContactChipList()}
          </div>
        </div>
        <div class="field" style="flex:1; min-width:240px;">
          <label>时间段</label>
          <select id="export-preset">
            ${renderPresetOptions(nowGroups)}
          </select>
        </div>
      </div>
      <div class="form-row" id="export-custom-row" style="display:none;">
        <div class="field">
          <label>起始日期</label>
          <input type="date" id="export-custom-start"/>
        </div>
        <div class="field">
          <label>结束日期</label>
          <input type="date" id="export-custom-end"/>
        </div>
      </div>
      <p class="meta" id="export-counts">
        匹配 <strong>${totalEvents}</strong> 个事件 · 共 <strong>${totalPhotos}</strong> 张照片${state.loading ? ' · 加载中…' : ''}
      </p>
    </div>

    <div class="card" id="export-events-card">
      <h2>事件预览</h2>
      <div class="chip-list-actions" style="margin-bottom:8px;">
        <a href="#" data-action="events-all">全选</a>
        <a href="#" data-action="events-none">全不选</a>
        <a href="#" data-action="events-invert">反选</a>
        <a href="#" data-action="events-with-photos">只选有照片的</a>
        <span class="meta" style="margin-left:auto;">已选 ${selectedCount} / ${totalEvents}</span>
      </div>
      <div class="export-event-list">${renderEventList()}</div>
    </div>

    <div class="card">
      <h2>导出</h2>
      <div class="row" style="gap:8px; flex-wrap:wrap;">
        <button class="btn" id="export-pdf-btn" ${exportDisabled ? 'disabled' : ''}>导出相册 (PDF)</button>
        <button class="btn" id="export-docx-btn" ${exportDisabled ? 'disabled' : ''}>导出相册 (Word)</button>
        <button class="btn" id="export-mp4-btn" ${exportDisabled ? 'disabled' : ''}>导出回忆视频 (MP4)</button>
        <button class="btn" id="export-edit-btn" ${exportDisabled ? 'disabled' : ''}>编辑并导出相册</button>
      </div>
      <p class="meta" style="margin-top:8px;">直接导出使用简单排版；Word 导出生成可编辑的图文文档（章节 + 内嵌照片）。「编辑并导出相册」可选择主题与版式、调整每页图文布局。视频每张照片 4 秒（含 Ken Burns 推拉）。</p>
      ${renderExportProgress()}
    </div>
  `;

  // Hydrate the preset select from state, then show the custom row if
  // the previous state had a custom range picked.
  const presetEl = document.getElementById('export-preset');
  if (presetEl) {
    if (state.presetValue && Array.from(presetEl.options).some((o) => o.value === state.presetValue)) {
      presetEl.value = state.presetValue;
    }
    const showCustom = state.presetValue === CUSTOM;
    const row = document.getElementById('export-custom-row');
    if (row) row.style.display = showCustom ? '' : 'none';
    if (showCustom) {
      const s = document.getElementById('export-custom-start');
      const e = document.getElementById('export-custom-end');
      if (s) s.value = state.customRange.start || '';
      if (e) e.value = state.customRange.end || '';
    }
  }
  wireUi();
  // Kick off async thumbnail hydration for visible rows.
  hydrateThumbnails();
}

// ---- editor view ----------------------------------------------------------
//
// The editor is mounted into a single container element. We tear it down
// when the user backs out. The layout produced by the editor is stashed
// on `state.lastEditorLayout` and passed to doExport() as the `layout`
// argument.

function renderEditorView(app) {
  app.innerHTML = `
    <div id="album-editor-root" class="album-editor-root"></div>
  `;
  const root = app.querySelector('#album-editor-root');
  // Build the events-with-photos array expected by the editor.
  // state.events only has summary rows; we need the full event + photos.
  // Issue a single batched getMemorialEvent IPC.
  Promise.all(state.events.map(async (e) => {
    try {
      const full = await api.memorialEvents.get(e.id);
      return full || null;
    } catch (err) {
      console.error('[export] failed to load event for editor', e.id, err);
      return null;
    }
  })).then((fullEvents) => {
    const usable = fullEvents.filter(Boolean);
    if (usable.length === 0) {
      toast('没有可编辑的事件');
      setView('filter');
      return;
    }
    mountEditor({
      container: root,
      events: usable,
      onBack: () => {
        destroyEditor();
        setView('filter');
      },
      onExport: (layout) => {
        state.lastEditorLayout = layout;
        doExport('pdf', { layout });
      },
    });
  }).catch((err) => {
    console.error('[export] editor mount failed', err);
    toast('打开编辑器失败：' + (err && err.message ? err.message : err));
    setView('filter');
  });
}

function setView(v) {
  state.view = v;
  if (v !== 'editor') {
    destroyEditor();
  }
  render();
}

function enterEditor() {
  if (state.selectedEventIds.size === 0) {
    toast('请至少选择一个事件');
    return;
  }
  setView('editor');
}

function wireUi() {
  // Contact chip toggle
  document.querySelectorAll('#export-contacts [data-contact-id]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.getAttribute('data-contact-id');
      if (state.selectedContactIds.has(id)) state.selectedContactIds.delete(id);
      else state.selectedContactIds.add(id);
      btn.classList.toggle('chip-selected');
      btn.setAttribute('data-selected', state.selectedContactIds.has(id) ? '1' : '0');
      schedulePreview();
    };
  });

  // Contact select-all / clear-all
  document.querySelectorAll('#export-contacts [data-action]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const act = a.getAttribute('data-action');
      if (act === 'contacts-all') {
        state.contacts.forEach((c) => state.selectedContactIds.add(c.id));
      } else if (act === 'contacts-none') {
        state.selectedContactIds.clear();
      }
      render();
      schedulePreview();
    };
  });

  // Preset
  const presetEl = document.getElementById('export-preset');
  if (presetEl) {
    presetEl.onchange = () => {
      state.presetValue = presetEl.value;
      const row = document.getElementById('export-custom-row');
      if (row) row.style.display = state.presetValue === CUSTOM ? '' : 'none';
      schedulePreview();
    };
  }
  // Custom range inputs
  const sEl = document.getElementById('export-custom-start');
  const eEl = document.getElementById('export-custom-end');
  if (sEl) sEl.onchange = () => { state.customRange.start = sEl.value || ''; schedulePreview(); };
  if (eEl) eEl.onchange = () => { state.customRange.end = eEl.value || ''; schedulePreview(); };

  // Event list actions
  document.querySelectorAll('[data-action^="events-"]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const act = a.getAttribute('data-action');
      if (act === 'events-all') {
        state.events.forEach((ev) => state.selectedEventIds.add(ev.id));
      } else if (act === 'events-none') {
        state.selectedEventIds.clear();
      } else if (act === 'events-invert') {
        const next = new Set();
        state.events.forEach((ev) => {
          if (!state.selectedEventIds.has(ev.id)) next.add(ev.id);
        });
        state.selectedEventIds = next;
      } else if (act === 'events-with-photos') {
        state.selectedEventIds.clear();
        state.events.forEach((ev) => {
          if ((ev.photo_count || 0) > 0) state.selectedEventIds.add(ev.id);
        });
      }
      render();
    };
  });

  // Per-row checkbox
  document.querySelectorAll('.export-event-check').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.getAttribute('data-event-id');
      if (cb.checked) state.selectedEventIds.add(id);
      else state.selectedEventIds.delete(id);
      // Lightweight in-place update of the count label to avoid a full
      // re-render flicker on every checkbox.
      const lbl = document.querySelector('.chip-list-actions .meta');
      if (lbl) lbl.textContent = `已选 ${state.selectedEventIds.size} / ${state.events.length}`;
      const pdfBtn = document.getElementById('export-pdf-btn');
      const docxBtn = document.getElementById('export-docx-btn');
      const mp4Btn = document.getElementById('export-mp4-btn');
      const editBtn = document.getElementById('export-edit-btn');
      const disable = state.selectedEventIds.size === 0 || state.exporting;
      if (pdfBtn) pdfBtn.disabled = disable;
      if (docxBtn) docxBtn.disabled = disable;
      if (mp4Btn) mp4Btn.disabled = disable;
      if (editBtn) editBtn.disabled = disable;
    };
  });

  // Export buttons
  const pdfBtn = document.getElementById('export-pdf-btn');
  const docxBtn = document.getElementById('export-docx-btn');
  const mp4Btn = document.getElementById('export-mp4-btn');
  const editBtn = document.getElementById('export-edit-btn');
  if (pdfBtn) pdfBtn.onclick = () => doExport('pdf');
  if (docxBtn) docxBtn.onclick = () => doExport('docx');
  if (mp4Btn) mp4Btn.onclick = () => doExport('mp4');
  if (editBtn) editBtn.onclick = enterEditor;

  // Cancel
  const cancelBtn = document.getElementById('export-cancel-btn');
  if (cancelBtn) cancelBtn.onclick = doCancel;
}

// After rendering, swap placeholder <img src=""> for actual data URLs as
// the photo IPC resolves. Same lazy-load pattern the memorial list uses.
function hydrateThumbnails() {
  document.querySelectorAll('img.export-thumb[data-photo-id]').forEach((img) => {
    const id = img.getAttribute('data-photo-id');
    if (!id) return;
    fetchPhotoDataUrl(id).then((url) => {
      // The element might have been replaced by a re-render; guard.
      if (img.isConnected && img.getAttribute('data-photo-id') === id) {
        img.src = url;
      }
    }).catch(() => { /* keep placeholder */ });
  });
}

// Debounced re-preview when filter state changes.
let previewTimer = null;
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 200);
}

async function runPreview() {
  const filterPayload = applyFilter({
    contactIds: Array.from(state.selectedContactIds),
    presetValue: state.presetValue,
    customRange: state.customRange,
  });
  const key = JSON.stringify(filterPayload);
  if (key === state.lastFilterKey) return;
  state.lastFilterKey = key;
  state.loading = true;
  // Show a cheap "loading" tick on the count line.
  const counts = document.getElementById('export-counts');
  if (counts) counts.innerHTML = `加载中…`;
  try {
    const resp = await api.export_.previewFilter(filterPayload);
    state.events = Array.isArray(resp.events) ? resp.events : [];
    // Default: select all (if anything to select).
    state.selectedEventIds = new Set(state.events.map((e) => e.id));
    state.loading = false;
    render();
  } catch (e) {
    state.loading = false;
    toast('加载事件失败：' + ((e && e.message) || e));
    if (counts) counts.innerHTML = '加载失败';
  }
}

async function doExport(kind, options = {}) {
  if (state.exporting) return;
  const ids = Array.from(state.selectedEventIds);
  if (ids.length === 0) {
    toast('请至少选择一个事件');
    return;
  }
  // Set up the progress card immediately so the user gets feedback
  // before the save dialog appears.
  state.exporting = { jobId: '', kind, phase: 'preparing', percent: 0, note: '准备中' };
  // The editor view should stay visible during export so the user can see
  // the progress card overlay. Don't re-render until the export finishes.
  const isEditor = state.view === 'editor';
  if (!isEditor) render();
  try {
    const fn = kind === 'docx' ? api.export_.docx
      : kind === 'pdf' ? api.export_.pdf
        : api.export_.mp4;
    const payload = { eventIds: ids };
    if (options.layout) payload.layout = options.layout;
    const r = await fn(payload);
    if (!r || r.canceled) {
      state.exporting = null;
      render();
      return;
    }
    // If the save dialog was canceled before any ffmpeg/pdfkit work
    // started, we may not have a jobId. In that case just clear state.
    if (r.jobId) {
      state.exporting = state.exporting || {
        jobId: r.jobId, kind, phase: 'done', percent: 100, note: '完成',
      };
      state.exporting.jobId = r.jobId;
    }
    if (r.stats) {
      const fmt = (n) => n.toLocaleString();
      const sizeTxt = (r.stats.bytes != null)
        ? ` · ${(r.stats.bytes / 1024 / 1024).toFixed(1)} MB`
        : '';
      const photoTxt = (r.stats.photos != null) ? ` · ${fmt(r.stats.photos)} 张照片` : '';
      const durTxt = (r.stats.durationSec != null)
        ? ` · ${Math.round(r.stats.durationSec)}s`
        : '';
      const pageTxt = (r.stats.pages != null) ? ` · ${r.stats.pages} 页` : '';
      const kindLabel = kind === 'docx' ? 'Word 相册'
        : kind === 'pdf' ? 'PDF 相册' : 'MP4 视频';
      toast(`${kindLabel} 已导出：${r.stats.events} 个事件${photoTxt}${pageTxt}${durTxt}${sizeTxt}`);
    } else {
      toast(kind === 'docx' ? 'Word 已导出' : kind === 'pdf' ? 'PDF 已导出' : '视频已导出');
    }
    state.exporting = null;
    render();
  } catch (e) {
    state.exporting = null;
    render();
    toast('导出失败：' + ((e && e.message) || e));
  }
}

async function doCancel() {
  if (!state.exporting || !state.exporting.jobId) return;
  try {
    await api.export_.cancel({ jobId: state.exporting.jobId });
    const btn = document.getElementById('export-cancel-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '取消中…';
    }
  } catch (e) {
    toast('取消失败：' + ((e && e.message) || e));
  }
}

async function mount() {
  unsubscribeIfAny();
  // Subscribe to progress push from main.
  state.unsubscribeProgress = api.on('export:progress', (msg) => {
    if (!msg || !state.exporting) return;
    // Only honor messages for the active job (or a not-yet-assigned jobId
    // which we set once the IPC handler returns).
    if (state.exporting.jobId && msg.jobId && state.exporting.jobId !== msg.jobId) return;
    if (msg.jobId) state.exporting.jobId = msg.jobId;
    state.exporting.phase = msg.phase || state.exporting.phase;
    state.exporting.percent = msg.percent != null ? msg.percent : state.exporting.percent;
    state.exporting.note = msg.note || state.exporting.note;
    if (msg.phase === 'done' || msg.phase === 'error') {
      // The IPC handler will resolve/reject shortly; let it drive the UI.
      return;
    }
    // Live-update the progress card in place.
    const card = document.querySelector('.export-progress');
    if (!card) return;
    const fill = card.querySelector('.export-progress-fill');
    const lbl = card.querySelector('.export-progress-foot span');
    const head = card.querySelector('.export-progress-head > span');
    if (fill) fill.style.width = `${Math.round(state.exporting.percent)}%`;
    if (lbl)  lbl.textContent = `${Math.round(state.exporting.percent)}%`;
    if (head) head.textContent = `${phaseLabel(state.exporting.phase)}${state.exporting.note ? ' · ' + state.exporting.note : ''}`;
  });
  // Load contact list + initial preview.
  try {
    state.contacts = (await api.contacts.list()) || [];
  } catch (e) {
    state.contacts = [];
    toast('加载联系人失败：' + ((e && e.message) || e));
  }
  // Default: all contacts selected.
  state.selectedContactIds = new Set(state.contacts.map((c) => c.id));
  // Initial preset: "all time".
  state.presetValue = ALL;
  state.customRange = { start: '', end: '' };
  state.lastFilterKey = null;
  await runPreview();
  // Tear down subscription when the user navigates away.
  window.addEventListener('hashchange', unsubscribeIfAny, { once: true });
}

register('/export', mount);
