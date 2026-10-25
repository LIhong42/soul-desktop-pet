// src/js/pages/settings.js — pet selection, walk toggle, pack import / remove,
// backup, quit
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

// ---- 桌宠压缩包导入进度 -----------------------------------------------
//
// 主进程每处理完一帧就推一次 `pet:import-progress`
// （{ phase, processed, total, current }），这里把它渲染成一条进度条 +
// "已处理 N / total 张图片"的计数。状态是模块级的（单页应用，参见
// tool_video_frames.js 的做法），渲染时把进度条的内联 HTML 一并画出来，
// 之后靠 paintImportProgress() 原地更新，不整页重绘（避免闪烁）。
let _importProgress = null;   // null | { phase, processed, total, current }
let _importUnsub = null;      // 退订函数，页面重渲染时清理

// 计算百分比。total 未知（0）时返回 null，表示不确定态。
function importPercent(p) {
  if (!p) return null;
  const total = Number(p.total) || 0;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((Number(p.processed) || 0) / total) * 100)));
}

// 进度条的 HTML。放在上传按钮下面，跟按钮同一块区域。
function importProgressHtml() {
  if (!_importProgress) return '';
  const p = _importProgress;
  const total = Number(p.total) || 0;
  const processed = Number(p.processed) || 0;
  const pct = importPercent(p);
  // 计数文案：始终显示"已处理 N / total 张图片"。total 还没算出来时
  // 只显示已处理的数量，避免出现 "3 / 0" 这种难看的中间态。
  const countText = total > 0
    ? `已处理 ${processed} / ${total} 张图片`
    : `已处理 ${processed} 张图片`;
  const phaseText = p.phase === 'preparing' ? '正在读取压缩包…' : '正在处理图片…';
  return `
    <div id="pet-import-progress" style="margin-top:10px;">
      <div class="meta">${phaseText}${p.current ? ' · ' + escapeHtml(p.current) : ''}</div>
      <div class="tools-progress-bar" style="margin-top:6px;">
        <div class="tools-progress-fill" style="width:${pct === null ? 30 : pct}%;${pct === null ? 'animation: tools-progress-indeterminate 1.2s ease-in-out infinite;' : ''}"></div>
      </div>
      <div class="meta" style="margin-top:4px;">${countText}${pct === null ? '' : ` · ${pct}%`}</div>
    </div>
  `;
}

// 原地更新进度条（不整页重绘）。
function paintImportProgress() {
  const p = _importProgress;
  let host = document.getElementById('pet-import-progress');
  if (!p) {
    if (host) host.outerHTML = '';
    return;
  }
  // 进度条可能还没画出来（点按钮那一刻页面是按"无进度"渲染的），
  // 这时按需插到上传按钮后面。
  if (!host) {
    const btn = document.getElementById('import-from-zip');
    if (!btn || !btn.parentElement) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = importProgressHtml();
    const created = wrap.firstElementChild;
    if (!created) return;
    btn.parentElement.insertAdjacentElement('afterend', created);
    host = created;
  }
  const total = Number(p.total) || 0;
  const processed = Number(p.processed) || 0;
  const pct = importPercent(p);
  const fill = host.querySelector('.tools-progress-fill');
  if (fill) {
    fill.style.width = (pct === null ? 30 : pct) + '%';
    fill.style.animation = pct === null
      ? 'tools-progress-indeterminate 1.2s ease-in-out infinite'
      : '';
  }
  const metas = host.querySelectorAll('.meta');
  if (metas.length >= 2) {
    const countText = total > 0
      ? `已处理 ${processed} / ${total} 张图片`
      : `已处理 ${processed} 张图片`;
    metas[1].textContent = countText + (pct === null ? '' : ` · ${pct}%`);
    // 头部那行显示阶段和当前正在处理的文件名。
    const phaseText = p.phase === 'preparing' ? '正在读取压缩包…' : '正在处理图片…';
    metas[0].textContent = phaseText + (p.current ? ' · ' + p.current : '');
  }
}

// 订阅导入进度事件。重复调用会先退订旧的，避免一次进度触发多次重绘。
function ensureImportSubscribed() {
  if (typeof api.on !== 'function') return;
  if (typeof _importUnsub === 'function') {
    try { _importUnsub(); } catch (_) { /* 已失效 */ }
  }
  _importUnsub = api.on('pet:import-progress', (msg) => {
    if (!msg) return;
    _importProgress = {
      phase: msg.phase || 'processing',
      processed: Number(msg.processed) || 0,
      total: Number(msg.total) || 0,
      current: msg.current || null,
    };
    paintImportProgress();
  });
}

async function render() {
  // 重渲染前先退掉上一轮的导入进度订阅，否则离开页面再回来会叠加
  // 监听器，一次进度事件触发多次重绘。
  if (typeof _importUnsub === 'function') {
    try { _importUnsub(); } catch (_) { /* 已失效 */ }
    _importUnsub = null;
  }
  const app = document.getElementById('app');
  const lastExport = await api.settings.get('last_export_at');
  const lastImport = await api.settings.get('last_import_at');
  // Pet list is now dynamic, sourced from the resources/pets/ registry.
  // `listInstalled` returns entries decorated with source/origin/importedAt/
  // description, which we need to render the per-row delete button.
  const installed = (await api.pet.listInstalled?.()) || (await api.pet.list()) || [];
  const currentPetId = await api.pet.getCurrent();
  const walkEnabled = await api.pet.getWalkEnabled();
  // 开机自启动。Defaults to on, but the source of truth is the DB (the main
  // process decides that on first launch). `supported` is false in dev builds.
  const autoStart = (await api.app.getAutostart?.())
    || { supported: false, enabled: true, active: false };
  // 自动更新状态。更新卡片由 renderUpdateCard() 单独渲染——它需要自己订阅
  // 进度事件并局部重绘，不适合放进下面那次整页 innerHTML 赋值里。
  // 主进程可能还没注册完 handler（老版本的 preload），所以都做可选调用。
  const updateState = (await api.app.getUpdateState?.())
    || { supported: false, enabled: true, currentVersion: '', info: null };

  const petOptions = installed.length
    ? installed.map((p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === currentPetId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
      ).join('')
    : '<option value="">(未找到桌宠)</option>';

  app.innerHTML = `
    <h1>设置</h1>
    <div class="card">
      <h2>桌面宠物形象</h2>
      <div class="form-row">
        <div class="field">
          <label>桌宠</label>
          <select id="pet-species">${petOptions}</select>
        </div>
        <div class="field" style="justify-content:flex-end;">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="pet-walk-enabled" ${walkEnabled ? 'checked' : ''}/>
            自动行走
          </label>
        </div>
      </div>
      <p class="meta" style="margin-top:8px">
        切换桌宠后立刻生效；自动行走开启时，宠物会在桌面上随机走路、跳跃、睡觉；关闭后宠物原地待机。
      </p>
      <p class="meta" style="margin-top:4px">
        桌宠文件夹位于 <code>resources/pets/<id>/</code>，每个桌宠自带 <code>manifest.json</code> 描述自己的动作。
      </p>

      <h3 style="margin-top:18px;">上传桌宠压缩包</h3>
      <p class="meta">压缩包内需要按动作分目录放帧文件：<code>default/</code> 必填，其他动作目录名任意（如 <code>blinking/</code>、<code>dancing/</code>、<code>headpat/</code> 等），有几个就识别几个。每个目录下放 <code><name>_NNN_NNNN.png</code> 命名的帧，其中 <code>NNN</code> 为帧序号、最后四位为该帧播放毫秒数。压缩包可以包一层顶层目录，也可以直接放帧目录。上传后系统会自动生成 <code>manifest.json</code> 并立即生效。</p>
      <p class="meta" style="margin-top:6px;"><strong>支持两种图片类型：</strong></p>
      <ul class="meta" style="margin-top:4px; padding-left:22px;">
        <li><strong>非透明 PNG（默认）：</strong>图片带实色背景（如纯黑底），上传时会自动抠掉背景、去除描边并导出透明 PNG。</li>
        <li><strong>透明 PNG：</strong>图片本身已经抠好背景，上传时<strong>跳过抠图流程</strong>，原样使用，边缘不会被二次处理。</li>
      </ul>
      <p class="meta" style="margin-top:6px;">系统会自动判断每一帧属于哪种类型，可以混用（同一压缩包里既有透明帧也有非透明帧也可以）。</p>
      <div class="row" style="gap:8px; margin-top:10px; flex-wrap:wrap;">
        <button class="btn" id="import-from-zip">上传桌宠压缩包…</button>
      </div>
      ${importProgressHtml()}

      <div id="installed-pets-list" style="margin-top:14px;"></div>
    </div>

    <div class="card">
      <h2>角色动作</h2>
      <p class="meta">配置桌宠在被点击时和待机时分别播放什么动作。配置是按桌宠分别保存的，切换桌宠后会自动加载。</p>
      <div id="pet-actions-card-body">
        <div class="empty">载入中…</div>
      </div>
    </div>

    <div class="card">
      <h2>动作文本</h2>
      <p class="meta">给桌宠的每个动作绑定"它想说的话"。播放该动作时会从绑定的多条文本里<strong>随机挑一条</strong>展示；<strong>"不展示文本"始终是其中一项</strong>，所以即使绑定了文本，这个动作也可能一句话都不说。默认不绑定任何文本。</p>
      <div id="pet-action-texts-card-body">
        <div class="empty">载入中…</div>
      </div>
    </div>

    <div class="card">
      <h2>文本气泡</h2>
      <p class="meta">桌宠会根据条件主动说话，气泡浮在桌宠上方，与动作播放互不影响。每条规则都可以单独关闭。</p>
      <div id="pet-bubbles-card-body">
        <div class="empty">载入中…</div>
      </div>
    </div>

    <div class="card">
      <h2>开机启动</h2>
      <div class="field" style="justify-content:flex-start;">
        <label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" id="app-autostart" ${autoStart.enabled ? 'checked' : ''}
                 ${autoStart.supported ? '' : 'disabled'}/>
          开机时自动启动 SoulDesktopPet
        </label>
      </div>
      <p class="meta" style="margin-top:8px">
        ${autoStart.supported
          ? '开启后，电脑开机登录时会自动运行桌宠，无需手动双击。默认已开启。'
          : '当前为开发模式，暂不支持开机自启动；打包安装后才能使用。'}
      </p>
      ${autoStart.supported && autoStart.enabled && !autoStart.active
        ? '<p class="meta" style="margin-top:4px; color:#b26a00;">⚠ 开机启动项当前未生效，可能已被系统或安全软件禁用；取消勾选后重新勾选可尝试恢复。</p>'
        : ''}
    </div>

    <div class="card" id="update-card">
      <h2>软件更新</h2>
      <div id="update-card-body">
        <div class="empty">载入中…</div>
      </div>
    </div>

    <div class="card">
      <h2>数据迁移</h2>
      <p>将所有联系人、提醒、回忆事件、照片和设置打包到一个 zip 文件，方便在不同机器之间迁移。</p>
      <p class="meta">最近导出：<strong>${lastExport || '从未'}</strong> · 最近导入：<strong>${lastImport || '从未'}</strong></p>
      <div class="row" style="gap:8px; margin-top:10px;">
        <button class="btn" id="export-backup">导出备份…</button>
        <button class="btn secondary" id="import-backup">导入备份…</button>
      </div>
      <p class="meta" style="margin-top:8px">导入会覆盖当前所有数据。建议先导出一份当前备份再导入。</p>
    </div>

    <div class="card">
      <h2>访问密码</h2>
      <p class="meta">4 位数字。修改后下次打开主窗口时生效。</p>
      <div class="form-row">
        <div class="field">
          <label>当前密码</label>
          <input type="password" inputmode="numeric" pattern="\d{4}" maxlength="4" id="pin-current" autocomplete="off"/>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>新密码</label>
          <input type="password" inputmode="numeric" pattern="\d{4}" maxlength="4" id="pin-new" autocomplete="off"/>
        </div>
        <div class="field">
          <label>确认新密码</label>
          <input type="password" inputmode="numeric" pattern="\d{4}" maxlength="4" id="pin-confirm" autocomplete="off"/>
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn" id="pin-change">修改密码</button>
      </div>
    </div>

    <div class="card">
      <h2>应用</h2>
      <button class="btn danger" id="quit-app">退出 SoulDesktopPet</button>
      <p class="meta" style="margin-top:8px">点击后关闭整个应用，包括桌面宠物。</p>
    </div>
  `;
  document.getElementById('pet-species').onchange = async (e) => {
    try {
      await api.pet.setCurrent(e.target.value);
      toast('桌宠已切换');
      // Re-render the whole page so the "角色动作" card (which depends
      // on the active pet's manifest variants) and the installed-pets
      // list (which highlights the newly-selected row) both reflect the
      // new pet without the user having to leave and come back.
      render();
    } catch (err) {
      toast('切换失败：' + ((err && err.message) || err));
    }
  };
  document.getElementById('pet-walk-enabled').onchange = async (e) => {
    try {
      await api.pet.setWalkEnabled(!!e.target.checked);
      toast(e.target.checked ? '自动行走已开启' : '自动行走已关闭');
    } catch (err) {
      toast('设置失败：' + ((err && err.message) || err));
    }
  };
  document.getElementById('app-autostart').onchange = async (e) => {
    const want = !!e.target.checked;
    try {
      const r = await api.app.setAutostart(want);
      if (!r || !r.ok) {
        // The registry write failed. Snap the checkbox back to the stored
        // intent rather than leaving it showing a state that isn't real.
        e.target.checked = !want;
        toast(r && r.supported === false
          ? '开发模式下不支持开机自启动'
          : '设置失败：无法写入开机启动项');
        return;
      }
      toast(want ? '开机自启动已开启' : '开机自启动已关闭');
    } catch (err) {
      e.target.checked = !want;
      toast('设置失败：' + ((err && err.message) || err));
    }
  };
  document.getElementById('import-from-zip').onclick = async () => {
    // 先订阅再调用 IPC：主进程在文件选择框还开着的时候就会开始推进度，
    // 晚订阅会丢掉最前面的几条消息。
    _importProgress = { phase: 'preparing', processed: 0, total: 0, current: null };
    ensureImportSubscribed();
    paintImportProgress();
    try {
      const r = await api.pet.importFromZip?.();
      if (!r || r.canceled) {
        // 用户在文件选择框里点了取消 —— 清掉进度条，不报错。
        _importProgress = null;
        paintImportProgress();
        return;
      }
      const count = (r && typeof r.variantCount === 'number') ? r.variantCount : null;
      // Report what happened to the frames: how many went through the
      // background cutout and how many were already transparent and
      // therefore skipped it.
      const cut = (r && r.cutout) ? r.cutout : null;
      const cutNote = (cut && (cut.processed || cut.skipped))
        ? `（${cut.processed || 0} 帧已抠图，${cut.skipped || 0} 帧透明已跳过）`
        : '';
      if (r.deduped) {
        toast(count != null
          ? `已存在同内容桌宠：${r.pet.name}（${count} 个动作）`
          : `已存在同内容桌宠：${r.pet.name}`);
      } else {
        toast(count != null
          ? `已导入：${r.pet.name}（识别了 ${count} 个动作）${cutNote}`
          : `已导入：${r.pet.name}${cutNote}`);
      }
      // 导入完成，进度条不再需要。
      _importProgress = null;
      render();
    } catch (e) {
      _importProgress = null;
      toast('导入失败：' + ((e && e.message) || e));
      render();
    }
  };

  // Render the per-pet row list (thumbnail + delete-button) below the
  // import controls. The dropdown above already covers "switch", so this
  // list is purely for managing imported packs.
  const listEl = document.getElementById('installed-pets-list');
  if (installed.length > 0) {
    listEl.innerHTML = installed.map((p) => petRow(p, currentPetId)).join('');
    wirePetListActions(currentPetId);
  } else {
    listEl.innerHTML = '';
  }

  document.getElementById('export-backup').onclick = async () => {
    try {
      const r = await api.backup.export();
      if (!r || r.canceled) return;
      toast('已导出到 ' + r.path);
      render();
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || e));
    }
  };
  document.getElementById('import-backup').onclick = async () => {
    // Step 1: pick the zip.
    const picked = await api.backup.import();
    if (!picked || picked.canceled) return;
    // Step 2: confirm — full-string warning that names the destructive scope.
    if (!confirm('导入会覆盖当前所有数据，包括联系人、提醒、回忆事件、照片和设置。建议先导出一份当前备份再继续。')) return;
    // Step 3: swap.
    try {
      await api.backup.apply(picked.path);
      toast('导入完成');
      // Re-render the page so the new last_import_at shows up.
      navigate('/settings');
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || e));
    }
  };
  document.getElementById('quit-app').onclick = async () => {
    if (!confirm('确认退出 SoulDesktopPet？')) return;
    await api.app.quit();
  };

  // Render the per-pet "角色动作" editor. Reads the config off the main
  // process, builds the trigger→variant mapping table and the ordered
  // loop-list editor, and wires the save button. The IPC handler
  // validates + filters against the manifest, so the renderer just sends
  // raw form state.
  await renderPetActionsCard(currentPetId);
  await renderActionTextsCard();
  await renderBubblesCard();
  // 放在最后：它会自己订阅事件并重绘 #update-card-body，而那个节点是上面
  // 那次整页 innerHTML 赋值刚创建的。
  await renderUpdateCard(updateState);
}

// ---------------------------------------------------------------------------
// 动作文本卡片 (main/pet_action_texts.js)
// ---------------------------------------------------------------------------
//
// One row per action the active pet can play, each holding the list of lines
// bound to it. The rows come from the main process (which unions the pet's
// own manifest variants with anything already bound), so this file stays a
// pure editor over a payload it doesn't interpret.
//
// Note there are deliberately no rows for 单击桌宠 or the 右击菜单 · 摸一下 /
// 拍头 / 喂食 entries: those are the *user's* actions, not the pet's. When you
// click the pet it resolves to some variant, and that variant is what picks
// and shows the text — so that's the row you bind to.
//
// `_actionTextsForm` is the working copy, in exactly the shape the IPC
// persists: `{ texts: { action: [lines] } }`. Chip add/remove mutate it in
// memory and re-render locally; only 保存 hits the disk.
//
// One delegated listener on the list container handles both buttons. The
// alternative — rebinding per row after every re-render — is the same amount
// of code and has to remember to rebind; delegation can't drift because
// there is nothing to re-bind.
let _actionTextsForm = null;
// Row skeleton (labels + ordering). Only changes when the active pet does,
// so it's kept at module scope and survives the in-memory re-renders that
// chip edits trigger.
let _actionTextsRows = null;
// The 文本框 catalog from resources/text_boxes, as
// `[{ id, label, url }]`. Module-scoped for the same reason as
// _actionTextsRows: it's fixed for the life of the card render, and both the
// per-row dropdown and the rule-bubble dropdown build off it.
let _textBoxes = [];

// One cell of the picker: the bubble artwork, cropped and scaled to fit.
//
// The geometry behind this is the same one the pet window uses (see
// main/pet_text_boxes.js and .pet-bubble.has-art in pet.css): the 2048×2048
// canvas has the bubble in a middle band with 4–19% transparent margin on each
// side and 9–29% above/below, so the raw canvas is mostly empty. `geom` rides
// in the payload because the crop needs those margins.
//
// Deliberately just the frame, with no sample text laid over it. The point of
// the grid is to let the user compare the *artwork* — a comic burst against a
// plain rounded box — and overlaying a line of text on every one of them put a
// repeated string across all seven and made the harder-to-read art (3's heavy
// black frame, 7's lace trim) harder still to judge. The bubble's own white
// interior already shows where text will go.
function renderTextBoxThumb(box) {
  const g = box.geom || {};
  // The drawing's own shape, which is what the crop window has to be. A drawn
  // bubble with no measurement gets the conservative fallback aspect rather
  // than being squashed into a square it probably doesn't have.
  const aspect = Number.isFinite(g.aspect) && g.aspect > 0 ? g.aspect : 1.6;

  // Margins as fractions of the canvas, falling back to the same centred guess
  // main/pet_text_boxes.js makes for art with no measured row.
  const l = g.left == null ? 10 : g.left;
  const r = g.right == null ? 10 : g.right;
  const t = g.top == null ? 25 : g.top;
  const b = g.bottom == null ? 25 : g.bottom;

  // The crop is one uniform scale applied to the square canvas, then the drawing
  // is centred in the frame. This works because the measured `aspect` *is*
  // `visW/visH` — the drawing's shape is the crop window's shape — so a single
  // scale lands it proportionally on both axes at once.
  //
  // Everything is computed in pixels against a frame of `fw` x `fh` and converted
  // to percentages only at the very end. That matters because CSS resolves
  // `width` against the frame's width but `height` against its height: a
  // percentage that looks right as a width is a different number of pixels as a
  // height. Mixing the two mid-calculation is what left every preview with its
  // top and bottom sliced off — the canvas got stretched onto a non-square
  // frame, overflowed it vertically, and `overflow: hidden` cut it.
  //
  // The frame is taken as `fw` wide only because it's a convenient unit; the
  // browser sizes it from `--thumb-w` and `--thumb-ar`, so every value below is
  // a ratio and the absolute choice cancels out.
  const fw = 100;
  const fh = fw / aspect;
  const visW = 100 - l - r;
  const visH = 100 - t - b;

  // How much of the frame the drawing should occupy. Less than 1 leaves a margin
  // so the art isn't flush against the edge — flush reads as *clipped* in a grid
  // of small thumbnails, which is how "the picture isn't showing in full" gets
  // reported. One number resizes all seven previews at once.
  const INSET = 0.88;

  // The canvas is square, so one side `q` fixes both axes and the drawing
  // occupies visW x visH percent of it. Solving on the width also satisfies the
  // height, because fh = fw * visH/visW by the aspect measurement.
  const q = (fw * INSET * 100) / visW;
  const drawW = (q * visW) / 100;
  const drawH = (q * visH) / 100;

  // Centre the *drawing* — not the canvas, which is lopsided; centring that
  // would push the drawing to one side. The image then sits at the drawing's
  // top-left minus the canvas margin that precedes it, which is negative: the
  // canvas overhangs the frame, because the crop shows a middle band of a much
  // larger square.
  const ix = (fw - drawW) / 2 - (l / 100) * q;
  const iy = (fh - drawH) / 2 - (t / 100) * q;

  // The frame carries the drawing's own aspect, not the interior's, so the crop
  // window is the shape of the whole thing including its decoration.
  return `<span class="action-texts-thumb"
      style="--prev-w:${(q / fw) * 100}%;--prev-h:${(q / fh) * 100}%;
             --prev-left:${(ix / fw) * 100}%;--prev-top:${(iy / fh) * 100}%;
             --thumb-w:${Math.min(100, 62 * aspect)}%;--thumb-ar:${aspect}">
      <img alt="" draggable="false" src="${escapeHtml(box.url)}">
    </span>`;
}

// The CSS-drawn bubble, rendered the way the pet renders it when no text box
// is chosen — so "默认" is a *picture* too, rather than the one option in the
// list the user has to imagine.
function renderDefaultThumb() {
  return `<span class="action-texts-thumb action-texts-thumb-default"></span>`;
}

// The whole picker: a button showing the current choice by name, plus the
// popover grid of every option drawn as its bubble.
//
// This replaced a native <select>. A <select> renders its own option list and
// offers no hook to put an image in an option, so the only thing it could show
// was a list of bare filenames — the user had to pick a number and go find out
// what it looked like. Self-drawing the trigger and the panel is what makes
// every style previewable before it's chosen.
//
// `name` is the form key ('rule' for the reminder bubbles, else the action).
// `value` is the currently-selected id ('' = default). An id that isn't in the
// catalog — the PNG was deleted, or the config came from another machine — gets
// its own cell marked unavailable rather than silently snapping to 默认, which
// would read as "my choice was never saved". Saving without touching it keeps
// the id, so dropping the PNG back in restores the bubble.
function renderTextBoxSelect(name, value) {
  const cur = String(value == null ? '' : value);
  const hit = _textBoxes.find((b) => b.id === cur);
  const orphan = cur && !hit;
  const triggerName = hit ? hit.label : (orphan ? `${cur}（当前不可用）` : '默认');

  const cells = [
    `<button type="button" class="action-texts-cell${cur === '' ? ' is-on' : ''}"
        data-box-pick="" role="option" aria-selected="${cur === ''}">
      ${renderDefaultThumb()}<span class="action-texts-cell-name">默认</span>
    </button>`,
    ..._textBoxes.map((b) => `
      <button type="button" class="action-texts-cell${b.id === cur ? ' is-on' : ''}"
          data-box-pick="${escapeHtml(b.id)}" role="option" aria-selected="${b.id === cur}">
        ${renderTextBoxThumb(b)}<span class="action-texts-cell-name">${escapeHtml(b.label)}</span>
      </button>`),
    ...(orphan ? [`<button type="button" class="action-texts-cell is-on is-orphan"
        data-box-pick="${escapeHtml(cur)}" role="option" aria-selected="true">
      <span class="action-texts-thumb"><span class="action-texts-thumb-missing">?</span></span>
      <span class="action-texts-cell-name">${escapeHtml(cur)}（当前不可用）</span>
    </button>`] : []),
  ].join('');

  // Collapsed, this is just a dropdown with the chosen name — no artwork. A
  // thumbnail here would put seven bubble images into a list of action rows,
  // where the row's job is to say *which* box is set, not to show it again; the
  // panel is where the pictures belong, one click away. It also keeps the rows
  // a uniform height instead of alternating tall-with-image / short-without.
  return `<span class="action-texts-boxwrap" data-box-name="${escapeHtml(name)}">
      <button type="button" class="action-texts-box" data-box-toggle="1"
          aria-haspopup="listbox" aria-expanded="false">
        <span class="action-texts-box-name">${escapeHtml(triggerName)}</span>
        <span class="action-texts-box-caret" aria-hidden="true">▾</span>
      </button>
      <span class="action-texts-panel" data-box-panel hidden role="listbox">
        ${cells}
      </span>
    </span>`;
}

async function renderActionTextsCard() {
  const body = document.getElementById('pet-action-texts-card-body');
  if (!body) return;
  if (!api.pet || !api.pet.actionTexts) {
    body.innerHTML = `<div class="empty">当前版本不支持动作文本配置。</div>`;
    return;
  }
  let snapshot;
  try {
    snapshot = await api.pet.actionTexts.get();
  } catch (e) {
    body.innerHTML = `<div class="empty">读取失败：${escapeHtml((e && e.message) || String(e))}</div>`;
    return;
  }
  _actionTextsRows = (snapshot && snapshot.actions) || [];
  // Deep-ish copy: each action's list is cloned so chip edits can't mutate
  // the row skeleton's `texts` array in place.
  const saved = (snapshot && snapshot.texts) || {};
  const formTexts = {};
  for (const k of Object.keys(saved)) {
    formTexts[k] = Array.isArray(saved[k]) ? saved[k].slice() : [];
  }
  // 文本框 catalog + the two selections that go with it. `textBoxes` is the
  // list main/pet_text_boxes.js scanned out of resources/text_boxes; it's empty
  // on an install with no art, in which case the picker is simply absent rather
  // than broken.
  _textBoxes = (Array.isArray(snapshot && snapshot.textBoxes) ? snapshot.textBoxes : [])
    // The catalog is only ever consumed as `{id, label, url, geom}`; anything
    // else would render as "[object Object]" in the grid rather than failing
    // visibly here.
    .filter((b) => b && typeof b.id === 'string' && b.id);
  // `ruleBox` arrives **resolved**, not as a bare id: main/pet_bubbles.js
  // loadRuleBox returns `petTextBoxes.resolve(...)` — `{ id, url, geom }` or
  // null. Everything below works in ids (that's what gets persisted, and what
  // the catalog is keyed by), so unwrap it here. Passing the object straight
  // through is what produced a phantom "（当前不可用）" option labelled
  // "[object Object]" and, on save, a stored id of "[object Object]".
  const ruleRaw = snapshot && snapshot.ruleBox;
  const ruleId = (ruleRaw && typeof ruleRaw === 'object') ? (ruleRaw.id || '') : (ruleRaw || '');
  const formBoxes = {};
  for (const k of Object.keys((snapshot && snapshot.boxes) || {})) {
    formBoxes[k] = String((snapshot.boxes[k]) || '');
  }
  // The 吃饭提醒 / 休息提醒 box is a single user-level choice, kept here as a
  // scalar on the same form so the card has one save button.
  _actionTextsForm = { texts: formTexts, boxes: formBoxes, ruleBox: ruleId };

  if (_actionTextsRows.length === 0) {
    body.innerHTML = `<div class="empty">当前桌宠没有可配置文本的动作。</div>`;
    return;
  }

  // Lines currently plugged in by a live rule bubble. Surfacing them here
  // makes the plug/unplug visible: while 吃饭提醒 is up the line appears
  // under "当前插播", and it drops off when the bubble ends — otherwise the
  // behaviour would look like the pet inventing text the user never wrote.
  const runtimeLines = ((snapshot && snapshot.runtime) || []).map((r) => r.text).filter(Boolean);

  body.innerHTML = `
    ${runtimeLines.length ? `
      <p class="meta" style="margin:10px 0 0;">
        当前插播（来自文本气泡规则，气泡结束后自动移除）：
        ${runtimeLines.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}
      </p>` : ''}
    ${_textBoxes.length ? `
      <p class="meta" style="margin:12px 0 6px;">
        提醒气泡（吃饭 / 休息 / 说句话）的文本框：
        ${renderTextBoxSelect('rule', _actionTextsForm.ruleBox)}
      </p>` : ''}
    <div class="action-texts-list" id="action-texts-list">
      ${_actionTextsRows.map(renderActionTextsRow).join('')}
    </div>
    <div class="row" style="margin-top:14px; gap:8px;">
      <button class="btn" id="action-texts-save">保存</button>
      <button class="btn secondary" id="action-texts-reset">清空全部文本</button>
      <span class="meta" id="action-texts-status" style="margin-left:8px;"></span>
    </div>
  `;

  wireActionTextsList(body);

  document.getElementById('action-texts-reset').onclick = async () => {
    if (!confirm('确认清空所有动作的绑定文本？')) return;
    // Boxes are reset too: "清空" means back to defaults, and leaving a
    // decorated bubble on an action with no text left would be a silent
    // half-reset the user didn't ask for.
    _actionTextsForm = { texts: {}, boxes: {}, ruleBox: '' };
    renderActionTextsCard();
  };
  document.getElementById('action-texts-save').onclick = async () => {
    const status = document.getElementById('action-texts-status');
    const list = document.getElementById('action-texts-list');
    // Absorb any text the user typed but didn't press Enter on. Same reason
    // as the actions-config card's DOM read: relying on the add-button alone
    // silently drops a line the user believed they saved.
    for (const input of list.querySelectorAll('[data-text-input]')) {
      const action = input.getAttribute('data-text-input');
      addActionText(action, input.value);
    }
    try {
      const r = await api.pet.actionTexts.save(_actionTextsForm);
      if (r && r.texts) {
        const next = {};
        for (const k of Object.keys(r.texts)) next[k] = (r.texts[k] || []).slice();
        const nextBoxes = {};
        for (const k of Object.keys(r.boxes || {})) nextBoxes[k] = r.boxes[k];
        // `ruleBox` comes back resolved (`{id, url, geom}`) or null, matching
        // the get() payload — unwrap it the same way the initial render does,
        // or the form would hold an object and the picker would label it
        // "[object Object]" on the very next repaint.
        //
        // A null ruleBox means "the stored id doesn't resolve on this machine".
        // Keep showing the id we asked for so the unavailable cell explains
        // itself instead of silently reverting to 默认.
        const savedRule = (r.ruleBox && typeof r.ruleBox === 'object') ? r.ruleBox.id : r.ruleBox;
        // Rebase the form on what the main side actually stored, not on what
        // we asked for: normalizeBoxes drops blanks, so a form still holding
        // them would drift from the DB and re-add them on the next save.
        _actionTextsForm = {
          texts: next,
          boxes: nextBoxes,
          ruleBox: savedRule || _actionTextsForm.ruleBox || '',
        };
      }
      if (status) status.textContent = '已保存 · 改动会立即生效';
      toast('动作文本已保存');
      rerenderActionTextsList();
    } catch (e) {
      if (status) status.textContent = '保存失败';
      toast('保存失败：' + ((e && e.message) || e));
    }
  };
}

// A single action row: the action's name on the left, its bound lines as
// removable chips on the right, with an always-present add-input beneath.
// An action with nothing bound renders the same shell minus the chip list,
// so every action is visible in its "未绑定" state — the user can see what
// they *haven't* configured, not just what they have.
function renderActionTextsRow(a) {
  const bound = (_actionTextsForm && _actionTextsForm.texts[a.action]) || a.texts || [];
  const lines = Array.isArray(bound) ? bound : [];
  const box = (_actionTextsForm && _actionTextsForm.boxes[a.action]) ?? a.box ?? '';
  return `
    <div class="action-texts-row">
      <div class="action-texts-label" title="${escapeHtml(a.action)}">${escapeHtml(a.label)}</div>
      <div class="action-texts-body">
        ${_textBoxes.length ? `
          <div class="action-texts-boxrow">
            <span class="meta">文本框</span>
            ${renderTextBoxSelect(a.action, box)}
          </div>` : ''}
        ${lines.length ? `
          <div class="action-texts-chips">
            ${lines.map((t, i) => `
              <span class="action-texts-chip">
                <span class="action-texts-chip-text">${escapeHtml(t)}</span>
                <button class="action-texts-chip-x" data-text-remove="${escapeHtml(a.action)}" data-text-idx="${i}" title="移除">×</button>
              </span>
            `).join('')}
          </div>`
        : `<div class="meta">未绑定任何文本</div>`}
        <div class="action-texts-add">
          <input type="text" class="action-texts-input" data-text-input="${escapeHtml(a.action)}"
                 placeholder="输入一条文本，回车或点 + 添加" maxlength="80"/>
          <button class="btn secondary" data-text-add="${escapeHtml(a.action)}">+</button>
        </div>
      </div>
    </div>
  `;
}

// One delegated listener for both chip buttons, plus Enter-to-add on the
// inputs. Bound once per card render; survives every local re-render
// because the container node itself is replaced only by a full card render.
function wireActionTextsList(body) {
  const list = document.getElementById('action-texts-list');
  if (!list) return;

  list.onclick = (e) => {
    const addBtn = e.target.closest('[data-text-add]');
    if (addBtn) {
      const action = addBtn.getAttribute('data-text-add');
      const input = list.querySelector(`[data-text-input="${CSS.escape(action)}"]`);
      if (!addActionText(action, input ? input.value : '')) return;
      if (input) input.value = '';
      rerenderActionTextsList();
      return;
    }
    const rmBtn = e.target.closest('[data-text-remove]');
    if (rmBtn) {
      const action = rmBtn.getAttribute('data-text-remove');
      const idx = Number(rmBtn.getAttribute('data-text-idx'));
      const lines = (_actionTextsForm.texts[action] || []).slice();
      lines.splice(idx, 1);
      // Drop the key entirely when the list empties, so "no lines" is
      // represented by an absent key rather than an empty array the main
      // side would have to special-case.
      if (lines.length > 0) _actionTextsForm.texts[action] = lines;
      else delete _actionTextsForm.texts[action];
      rerenderActionTextsList();
    }
  };

  // Enter submits the row it's in. Without this, "回车添加" (which the
  // placeholder promises) would silently insert a newline-ish nothing.
  list.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('[data-text-input]');
    if (!input) return;
    e.preventDefault();
    const action = input.getAttribute('data-text-input');
    if (!addActionText(action, input.value)) return;
    input.value = '';
    rerenderActionTextsList();
  };

  // 文本框 picker. Bound on `click` rather than `change` because these are
  // buttons, not a <select> — there is no change event to wait for.
  //
  // Mutates the form but does NOT re-render the list: the picker is already
  // showing the chosen value, and replacing the rows mid-interaction would
  // collapse the panel under the cursor. The row repaints on the next chip edit.
  //
  // The rule-bubble picker lives outside the list container (it's in the card
  // header), so the handlers below are bound on `body` — the one node that
  // contains both — rather than being split across two roots.
  wireTextBoxPickers(body);
}

// ---------------------------------------------------------------------------
// 文本框 picker behaviour
// ---------------------------------------------------------------------------
//
// Three concerns, all delegated off `root` so they survive the card's
// innerHTML re-renders: which picker is open, closing it when the user moves
// away, and applying a pick.
//
// The panel is a popover, not a listbox the browser positions: the grid has to
// lay out in document flow to size its cells from the bubble art, and the card
// is narrow enough that the panel has to be able to flip below the trigger near
// the bottom of the window.
function wireTextBoxPickers(root) {
  closeTextBoxPanels();

  root.onclick = (e) => {
    const toggle = e.target.closest('[data-box-toggle]');
    if (toggle) {
      const wrap = toggle.closest('.action-texts-boxwrap');
      if (!wrap) return;
      // Re-clicking the open trigger closes it. Handled here rather than by
      // falling through to the outside-click close below, because that close
      // would run *and* this handler would then reopen the panel.
      if (wrap.hasAttribute('data-open')) { closeTextBoxPanels(); return; }
      openTextBoxPanel(wrap);
      return;
    }

    const cell = e.target.closest('[data-box-pick]');
    if (cell) {
      const wrap = cell.closest('.action-texts-boxwrap');
      if (!wrap) return;
      // An unavailable cell is displayed, not selectable: it stands for an id
      // whose PNG is gone. Clicking it would keep the id (harmless — the pet
      // degrades to the CSS bubble) but silently repainting the trigger with a
      // real thumbnail would imply the art is back.
      if (cell.classList.contains('is-orphan')) { closeTextBoxPanels(); return; }
      setTextBox(wrap.getAttribute('data-box-name'), cell.getAttribute('data-box-pick'));
      // Repaint just this picker rather than the whole card: a full re-render
      // would tear down the panel under the cursor mid-click.
      paintTextBoxPicker(wrap);
      closeTextBoxPanels();
      return;
    }

    // A click anywhere else closes whatever is open.
    closeTextBoxPanels();
  };

  // Escape closes, matching what a popover is expected to do. Bound on the
  // document rather than `root` because the open panel may be anywhere in the
  // card, and the key can land anywhere.
  if (!_textBoxEscBound) {
    _textBoxEscBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTextBoxPanels();
    });
  }
}

// Bound-once guard for the Escape listener; see wireTextBoxPickers.
let _textBoxEscBound = false;

function openTextBoxPanel(wrap) {
  // One panel at a time: opening a second closes the first, so two pickers
  // never overlap over the card (and over each other's triggers).
  closeTextBoxPanels();
  wrap.setAttribute('data-open', '');
  const toggle = wrap.querySelector('[data-box-toggle]');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  const panel = wrap.querySelector('[data-box-panel]');
  if (panel) panel.hidden = false;
  // Flip below the trigger when there isn't room above. Measured after the
  // panel is visible — otherwise it has no height to compare against.
  if (panel) {
    const pRect = panel.getBoundingClientRect();
    const tRect = (toggle || wrap).getBoundingClientRect();
    if (pRect.height && tRect.bottom + pRect.height > window.innerHeight - 8 && tRect.top > pRect.height) {
      wrap.setAttribute('data-drop', 'up');
    }
  }
}

function closeTextBoxPanels() {
  document.querySelectorAll('.action-texts-boxwrap[data-open]').forEach((w) => {
    w.removeAttribute('data-open');
    w.removeAttribute('data-drop');
    const t = w.querySelector('[data-box-toggle]');
    if (t) t.setAttribute('aria-expanded', 'false');
    const p = w.querySelector('[data-box-panel]');
    if (p) p.hidden = true;
  });
}

// Repaint one picker to reflect a new choice, without touching the rest of the
// card. Only the cheap parts are updated in place: the trigger's thumbnail and
// name, plus the `is-on` marks in the grid. Re-rendering the whole grid would
// re-fetch every PNG, which is the one thing the previews made expensive.
function paintTextBoxPicker(wrap) {
  const name = wrap.getAttribute('data-box-name');
  const value = name === 'rule'
    ? (_actionTextsForm ? _actionTextsForm.ruleBox : '')
    : (_actionTextsForm && _actionTextsForm.boxes ? (_actionTextsForm.boxes[name] || '') : '');
  const cur = String(value == null ? '' : value);
  const hit = _textBoxes.find((b) => b.id === cur);
  const orphan = cur && !hit;

  const toggle = wrap.querySelector('[data-box-toggle]');
  const label = toggle && toggle.querySelector('.action-texts-box-name');
  if (label) {
    label.textContent = hit ? hit.label : (orphan ? `${cur}（当前不可用）` : '默认');
  }
  // Only the label and the grid's highlight change: the collapsed trigger
  // carries no artwork to swap (see renderTextBoxSelect).

  wrap.querySelectorAll('[data-box-pick]').forEach((c) => {
    const on = String(c.getAttribute('data-box-pick') || '') === cur;
    c.classList.toggle('is-on', on);
    c.setAttribute('aria-selected', String(on));
  });
}

// Record a 文本框 choice into the in-memory form. An empty value deletes the
// key rather than storing '', so "默认" and "never set" are the same state —
// matching how an emptied text list is stored.
function setTextBox(name, value) {
  if (!_actionTextsForm || !name) return;
  const id = String(value == null ? '' : value);
  if (name === 'rule') { _actionTextsForm.ruleBox = id; return; }
  if (id) _actionTextsForm.boxes[name] = id;
  else delete _actionTextsForm.boxes[name];
}

// Mutating helper shared by the add button, Enter, and the pre-save DOM
// sweep — so all three apply identical trimming and de-duplication. Returns
// true when a line was actually added, so callers can skip the re-render
// (and the "已存在" toast already fired inside).
function addActionText(action, raw) {
  const line = String(raw == null ? '' : raw).trim();
  if (!line) return false;
  const list = _actionTextsForm.texts[action] || [];
  if (list.includes(line)) {
    toast('该文本已存在');
    return false;
  }
  list.push(line);
  _actionTextsForm.texts[action] = list;
  return true;
}

// Repaint the row list from the in-memory form. No IPC round-trip, so
// chip edits feel instant; 保存 is the only thing that touches disk.
function rerenderActionTextsList() {
  const list = document.getElementById('action-texts-list');
  if (!list || !_actionTextsRows) return;
  list.innerHTML = _actionTextsRows.map(renderActionTextsRow).join('');
}

// ---------------------------------------------------------------------------
// 文本气泡卡片
// ---------------------------------------------------------------------------
//
// The card renders whatever `api.bubbles.getConfig()` returns. It has no
// hard-coded knowledge of 吃饭提醒 / 休息提醒 — the labels, descriptions and
// toggle ids all come from the main process's rule list (main/pet_bubbles.js
// `describeRules`). Adding a rule there makes a new row appear here
// automatically, with no change to this file.
let _bubblesCfg = null;

async function renderBubblesCard() {
  const body = document.getElementById('pet-bubbles-card-body');
  if (!body) return;
  if (!api.bubbles) {
    body.innerHTML = `<div class="empty">当前版本不支持文本气泡配置。</div>`;
    return;
  }
  let cfg;
  try {
    cfg = await api.bubbles.getConfig();
  } catch (e) {
    body.innerHTML = `<div class="empty">读取失败：${escapeHtml((e && e.message) || String(e))}</div>`;
    return;
  }
  const rules = (cfg && cfg.rules) || [];
  _bubblesCfg = cfg;
  if (rules.length === 0) {
    body.innerHTML = `<div class="empty">暂无文本气泡规则。</div>`;
    return;
  }

  const fedWindows = (cfg && cfg.feedWindows) || {};

  body.innerHTML = `
    <div class="list-item" style="margin-top:10px;">
      ${rules.map((r) => `
        <div class="row" style="gap:10px; align-items:flex-start; padding:8px 0; border-bottom:1px solid #eee;">
          <label style="display:flex; align-items:center; gap:6px; flex:1; min-width:0; cursor:pointer;">
            <input type="checkbox" data-bubble-kind="${escapeHtml(r.kind)}" ${r.enabled ? 'checked' : ''}/>
            <span style="min-width:0;">
              <span style="font-weight:600;">${escapeHtml(r.label)}</span>
              <div class="meta">${escapeHtml(r.description || '')}</div>
            </span>
          </label>
          <button class="btn secondary" data-bubble-preview="${escapeHtml(r.name)}">预览</button>
        </div>
      `).join('')}
    </div>
    <p class="meta" style="margin-top:10px;">
      气泡默认持续 1 小时；吃饭提醒会在你喂食后立即结束。
      ${Object.keys(fedWindows).length ? '今天的吃饭提醒已处理。' : ''}
    </p>
  `;

  // Toggle handlers — each checkbox writes the whole kind→bool map, since
  // that's the shape the IPC handler takes.
  body.querySelectorAll('[data-bubble-kind]').forEach((cb) => {
    cb.onchange = async () => {
      const map = {};
      for (const r of (_bubblesCfg && _bubblesCfg.rules) || []) {
        map[r.kind] = r.kind === cb.getAttribute('data-bubble-kind')
          ? cb.checked
          : r.enabled;
      }
      try {
        const saved = await api.bubbles.setEnabled(map);
        if (_bubblesCfg && _bubblesCfg.rules) {
          for (const r of _bubblesCfg.rules) {
            if (saved && typeof saved[r.kind] === 'boolean') r.enabled = saved[r.kind];
          }
        }
        toast(cb.checked ? '已开启' : '已关闭');
      } catch (e) {
        cb.checked = !cb.checked;   // snap back so the UI never lies
        toast('设置失败：' + ((e && e.message) || e));
      }
    };
  });

  // Preview — asks the main process what this rule would say right now and
  // shows the answer inline. Useful for the time-window rules, where the
  // answer outside the window is "not due right now".
  body.querySelectorAll('[data-bubble-preview]').forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.getAttribute('data-bubble-preview');
      try {
        const r = await api.bubbles.preview(name);
        if (!r) { toast('无返回'); return; }
        if (r.error) { toast('读取失败：' + r.error); return; }
        toast(r.due ? `现在会说：${r.text}` : `${r.label}：当前未到触发条件`);
      } catch (e) {
        toast('预览失败：' + ((e && e.message) || e));
      }
    };
  });
}

// Local working copy of the action-config form so chip toggles + select
// changes don't round-trip the IPC. Saved explicitly on button click.
let _petActionsForm = null;

// Render a variant key for display in the settings card. By design the
// dropdowns and the loop list show the **raw manifest key** (e.g.
// `default`, `walking`, `reminder`, `pat`, `blink`) — exactly the same
// string the user would see if they opened the pet's `manifest.json`.
// The earlier Chinese-localized labels (e.g. "默认 — 桌宠自带的默认
// 动作" / "走路" / "拍头 (cozy, tier≥5)") were misleading once we
// dropped the cozy keys from the picker: a label like "拍头 (cozy,
// tier≥5)" implied `pat` was a *cozy* action, but the manifest only
// declares it as a regular `headpat` animation the pet happens to
// share with the cozy right-click binding. Showing the raw key keeps
// the UI honest: whatever you pick in the dropdown is exactly the
// variant name that will be resolved at runtime.
function variantLabel(v) {
  if (!v) return '?';
  return v;
}

// Filter the available-variants list to only the "角色动作" category —
// excludes the cozy reserved names (pet/pat/feed/play/sleep/cuddle)
// and the controller-internal states (walking/reminder). The actual
// filtering happens in main/pet_actions_config.js (`getAvailableVariants`),
// so this renderer just consumes the already-filtered list from the
// IPC payload — no duplicate policy to keep in sync.

async function renderPetActionsCard(petId) {
  const body = document.getElementById('pet-actions-card-body');
  if (!body) return;
  if (!api.pet || !api.pet.actionsConfig) {
    body.innerHTML = `<div class="empty">当前版本不支持角色动作配置。</div>`;
    return;
  }
  let snapshot;
  try {
    snapshot = await api.pet.actionsConfig.get();
  } catch (e) {
    body.innerHTML = `<div class="empty">读取配置失败：${escapeHtml((e && e.message) || String(e))}</div>`;
    return;
  }
  const cfg = (snapshot && snapshot.config) || {};
  const variants = (snapshot && snapshot.available_variants) || ['default'];
  const triggerDefs = (snapshot && snapshot.trigger_defs) || [
    { id: 'click', label: '单击桌宠' },
  ];
  const effectBindings = (snapshot && snapshot.effect_bindings) || [];
  _allVariantsCache = variants;

  // Every <select> in this card shows the same pool: the "角色动作"
  // (character-action) variants — i.e. what the pet can actually play
  // as a pure animation. The 6 cozy keys (pet/pat/feed/play/sleep/cuddle)
  // are deliberately NOT in this list: they belong to the right-click
  // menu as trigger→particle+cozy-score pairs, and the user can only
  // invoke them through that menu. Mixing them into the dropdowns
  // would let the user think they can "make 单击桌宠 trigger 喂食",
  // which is a category error — 喂食 has a chicken-leg particle and a
  // cozy score, that's not what clicking the pet should do.
  //
  // The pool comes straight from `available_variants`, which the main
  // process already filters to "角色动作 only". The renderer doesn't
  // re-filter here on purpose — the single source of truth for the
  // policy lives in `getAvailableVariants`.
  const characterVariants = variants;
  const characterOptionsHtml = characterVariants.map((v) => renderOption(v)).join('');

  function renderOption(v) {
    return `<option value="${escapeHtml(v)}">${escapeHtml(variantLabel(v))}</option>`;
  }

  // Pre-fill the working copy. Use the v3 schema
  //   (`triggers: { click }`, `effect_overrides: { feed, ... }`, `loop_variants`).
  // effect_overrides is keyed by EFFECT_BINDINGS id and only contains
  // user-customized entries — the `getEffectVariant` helper on the main
  // side falls back to each binding's `default_variant` for missing keys,
  // so we don't need to seed the override map with all six ids.
  //
  // The loop list and the dropdowns all draw from the same pool: every
  // variant the pet's manifest declares. The main process is the source
  // of truth for that pool (`getAvailableVariants`), so we trust the
  // values coming back from the IPC and don't re-filter on the renderer.
  // The canonical clean-up still happens on save via
  // `filterAgainstManifest`, which drops any keys the manifest doesn't
  // declare — that protects against a config written for a previous
  // pet whose manifest had different variants.
  const initialLoop = (Array.isArray(cfg.loop_variants) && cfg.loop_variants.length > 0)
    ? cfg.loop_variants.slice()
    : ['default'];
  const initialTriggers = (cfg.triggers && typeof cfg.triggers === 'object')
    ? Object.assign({}, cfg.triggers)
    : { click: 'default' };
  const initialEffectOverrides = (cfg.effect_overrides && typeof cfg.effect_overrides === 'object')
    ? Object.assign({}, cfg.effect_overrides)
    : {};
  _petActionsForm = {
    triggers: initialTriggers,
    effect_overrides: initialEffectOverrides,
    loop_variants: initialLoop,
  };

  body.innerHTML = `
    <h3 style="margin-top:0;">触发方式 → 角色动作</h3>
    <p class="meta">把"单击桌宠"映射到桌宠自带的角色动作（纯动画，不附带任何特效或 cozy 计分）。下拉里只列角色动作；带特效的 cozy 动作只能通过右击菜单触发。</p>
    <div class="trigger-map-table" id="pet-action-trigger-map">
      ${triggerDefs.map((def) => {
        return `
          <div class="trigger-map-row" data-trigger-id="${escapeHtml(def.id)}">
            <div class="trigger-map-label">${escapeHtml(def.label)}</div>
            <select class="trigger-map-picker" data-trigger-picker="${escapeHtml(def.id)}">
              ${characterOptionsHtml}
            </select>
          </div>
        `;
      }).join('')}
    </div>

    <h3 style="margin-top:18px;">动作循环列表</h3>
    <p class="meta">桌宠默认待机时按下面列表的顺序循环播放这些动作。<code>default</code> 不可删除（是兜底动画）。桌宠切换到下一个列表项的间隔约为 <strong>4-10 秒</strong>。下拉里只列桌宠自带的角色动作。</p>
    <div class="loop-list" id="pet-action-loop-list">
      ${initialLoop.map((v, i) => renderLoopItem(v, i)).join('')}
    </div>
    <div class="row" style="gap:8px; margin-top:8px; align-items:center;">
      <select id="pet-action-loop-add-select" class="loop-add-select">
        <option value="">— 选择要加入循环的动作 —</option>
        ${characterVariants
          .filter((v) => !initialLoop.includes(v))
          .map(renderOption)
          .join('')}
      </select>
      <button class="btn" id="pet-action-loop-add" ${characterVariants.every((v) => initialLoop.includes(v)) ? 'disabled' : ''}>加入循环</button>
    </div>

    <h3 style="margin-top:18px;">特效绑定 (右击菜单 · 角色动作可改)</h3>
    <p class="meta">桌宠的右击菜单有 6 个 cozy 动作，每个都绑定了<strong>固定的特效</strong>（鸡腿 🧶 💞 等）和<strong>可配置的角色动作</strong>。例如，喂食时特效永远是 🍖 鸡腿，但用户可以让桌宠在喂食时做"微笑/吃饭"等动作；不设置则使用默认动作。下拉里只列角色动作。</p>
    <div class="effect-bindings-table">
      ${effectBindings.map((b) => {
        // What the select should display initially:
        //   1. The user's saved override for this binding, if any.
        //   2. Otherwise the binding's `default_variant` if the current
        //      pet's manifest actually exposes it (so VioletMoon's
        //      default of `pat` shows "pat" in the dropdown).
        //   3. Otherwise fall back to `default` (the always-available
        //      fallback animation).
        // The `getEffectVariant` helper on the main side re-derives
        // the same chain at click time, so the select's initial value
        // and the actually-played variant are always in sync.
        const userOverride = initialEffectOverrides && initialEffectOverrides[b.id];
        const def = b.default_variant || 'default';
        let currentVariant;
        if (userOverride) {
          currentVariant = userOverride;
        } else if (characterVariants.includes(def)) {
          currentVariant = def;
        } else {
          currentVariant = 'default';
        }
        return `
        <div class="effect-binding-row" data-binding-id="${escapeHtml(b.id)}">
          <div class="effect-binding-label">${escapeHtml(b.label)}</div>
          <div class="effect-binding-particle">${escapeHtml(b.particle)}</div>
          <div class="effect-binding-arrow">→</div>
          <select class="effect-binding-picker" data-binding-picker="${escapeHtml(b.id)}" data-binding-default="${escapeHtml(characterVariants.includes(def) ? def : 'default')}" data-binding-current="${escapeHtml(currentVariant)}">
            ${characterOptionsHtml}
          </select>
          <div class="effect-binding-tier">tier≥${b.minTier}</div>
        </div>
      `;
      }).join('')}
    </div>

    <div class="row" style="margin-top:14px;">
      <button class="btn" id="pet-action-save">保存</button>
      <button class="btn secondary" id="pet-action-reset">恢复默认</button>
      <span class="meta" id="pet-action-status" style="margin-left:8px;"></span>
    </div>
  `;

  // Apply current trigger values to the freshly-rendered selects.
  document.querySelectorAll('[data-trigger-picker]').forEach((sel) => {
    const id = sel.getAttribute('data-trigger-picker');
    if (initialTriggers[id]) sel.value = initialTriggers[id];
    sel.onchange = () => {
      if (!_petActionsForm.triggers) _petActionsForm.triggers = {};
      _petActionsForm.triggers[id] = sel.value;
    };
  });

  // Effect-binding variant pickers. We compare the chosen value against
  // the binding's default_variant to decide whether to *write* an entry
  // to effect_overrides or *omit* it (so the main side falls back to the
  // default). This keeps the stored config minimal — overrides only exist
  // for entries the user actually changed.
  document.querySelectorAll('[data-binding-picker]').forEach((sel) => {
    const id = sel.getAttribute('data-binding-picker');
    const def = sel.getAttribute('data-binding-default') || 'default';
    const current = sel.getAttribute('data-binding-current') || def;
    sel.value = current;
    sel.onchange = () => {
      if (!_petActionsForm.effect_overrides) _petActionsForm.effect_overrides = {};
      if (sel.value === def) {
        // User reset this row to the binding's default — drop the
        // override entirely so future loads treat it as "use default".
        delete _petActionsForm.effect_overrides[id];
      } else {
        _petActionsForm.effect_overrides[id] = sel.value;
      }
    };
  });

  // Wire × / ↕ / + buttons for the loop list.
  wireLoopList();
  document.getElementById('pet-action-loop-add').onclick = () => {
    const addSel = document.getElementById('pet-action-loop-add-select');
    if (!addSel || !addSel.value) return;
    addLoopVariant(addSel.value);
    addSel.value = '';
  };
  document.getElementById('pet-action-reset').onclick = async () => {
    _petActionsForm = {
      triggers: Object.fromEntries(triggerDefs.map((d) => [d.id, 'default'])),
      effect_overrides: {},
      loop_variants: ['default'],
    };
    await renderPetActionsCard(petId);
  };
  document.getElementById('pet-action-save').onclick = async () => {
    const status = document.getElementById('pet-action-status');
    // Pull the *current* state of the effect-binding select(s) straight
    // from the DOM before saving. The per-row onchange handler does
    // update `_petActionsForm.effect_overrides`, but a fast user can
    // open the dropdown, pick a value, and click Save before the
    // browser dispatches `change` — at which point `_petActionsForm`
    // still reflects the previous value. Reading from the DOM at save
    // time guarantees what the user sees on screen is what gets
    // persisted.
    if (!_petActionsForm.effect_overrides || typeof _petActionsForm.effect_overrides !== 'object') {
      _petActionsForm.effect_overrides = {};
    }
    document.querySelectorAll('[data-binding-picker]').forEach((sel) => {
      const id = sel.getAttribute('data-binding-picker');
      const def = sel.getAttribute('data-binding-default') || 'default';
      if (!id) return;
      if (sel.value && sel.value !== def) {
        _petActionsForm.effect_overrides[id] = sel.value;
      } else {
        delete _petActionsForm.effect_overrides[id];
      }
    });
    try {
      const r = await api.pet.actionsConfig.save(_petActionsForm);
      if (status) {
        status.textContent = '已保存 · 改动会立即同步到桌宠，重启后保留';
      }
      toast('角色动作已保存');
      if (r && r.config) _petActionsForm = r.config;
    } catch (e) {
      if (status) status.textContent = '保存失败';
      toast('保存失败：' + ((e && e.message) || e));
    }
  };
  document.getElementById('pin-change').onclick = async () => {
    const cur = document.getElementById('pin-current').value;
    const nw  = document.getElementById('pin-new').value;
    const cf  = document.getElementById('pin-confirm').value;
    if (!/^\d{4}$/.test(cur)) { toast('请输入当前 4 位密码'); return; }
    if (!/^\d{4}$/.test(nw))  { toast('新密码必须是 4 位数字'); return; }
    if (nw !== cf)            { toast('两次输入的新密码不一致'); return; }
    try {
      const v = await api.app.verifyPin(cur);
      if (!v || !v.ok) { toast('当前密码错误'); return; }
      const r = await api.app.setPin(nw);
      if (!r || !r.ok) { toast('密码修改失败'); return; }
      toast('密码已更新');
      document.getElementById('pin-current').value = '';
      document.getElementById('pin-new').value = '';
      document.getElementById('pin-confirm').value = '';
    } catch (e) {
      toast('修改失败：' + ((e && e.message) || e));
    }
  };
}

// Render a single row in the ordered loop list. The `index` is shown
// so the user can tell at a glance what the playback order is.
function renderLoopItem(variant, index) {
  const isDefault = variant === 'default';
  return `
    <div class="loop-list-item" data-loop-variant="${escapeHtml(variant)}">
      <span class="loop-list-index">${index + 1}.</span>
      <span class="loop-list-name">${escapeHtml(variantLabel(variant))}</span>
      <span class="loop-list-key">${escapeHtml(variant)}</span>
      <span class="loop-list-spacer"></span>
      <button class="loop-list-btn" data-loop-action="up"   title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button class="loop-list-btn" data-loop-action="down" title="下移">↓</button>
      <button class="loop-list-btn loop-list-remove" data-loop-action="remove" title="${isDefault ? '默认动作不可删除' : '从循环中移除'}" ${isDefault ? 'disabled' : ''}>×</button>
    </div>
  `;
}

function wireLoopList() {
  const allVariants = _allVariantsCache || [];
  document.querySelectorAll('[data-loop-action]').forEach((btn) => {
    btn.onclick = () => {
      const item = btn.closest('[data-loop-variant]');
      if (!item) return;
      const v = item.getAttribute('data-loop-variant');
      const action = btn.getAttribute('data-loop-action');
      const list = (_petActionsForm && _petActionsForm.loop_variants) || [];
      const i = list.indexOf(v);
      if (i < 0) return;
      if (action === 'up' && i > 0) {
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
      } else if (action === 'down' && i < list.length - 1) {
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
      } else if (action === 'remove' && v !== 'default') {
        list.splice(i, 1);
        if (list.length === 0) list.push('default');
      } else {
        return;
      }
      _petActionsForm.loop_variants = list;
      rerenderLoopList();
    };
  });
}

// Module-level cache for the full available-variants list, used by
// rerenderLoopList when the "add to loop" dropdown refreshes. Populated
// by renderPetActionsCard on every render.
let _allVariantsCache = null;

function addLoopVariant(variant) {
  if (!variant) return;
  const list = (_petActionsForm && _petActionsForm.loop_variants) || [];
  if (list.includes(variant)) return;
  list.push(variant);
  _petActionsForm.loop_variants = list;
  rerenderLoopList();
}

function rerenderLoopList() {
  const wrap = document.getElementById('pet-action-loop-list');
  if (!wrap) return;
  const list = (_petActionsForm && _petActionsForm.loop_variants) || [];
  wrap.innerHTML = list.map((v, i) => renderLoopItem(v, i)).join('');
  wireLoopList();
  // Refresh the "+ add" dropdown so newly-available variants show up and
  // already-added ones drop off the list.
  const addSel = document.getElementById('pet-action-loop-add-select');
  const addBtn = document.getElementById('pet-action-loop-add');
  if (addSel) {
    addSel.innerHTML = `<option value="">— 选择要加入循环的动作 —</option>` +
      (_allVariantsCache || [])
        .filter((v) => !list.includes(v))
        .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(variantLabel(v))}</option>`)
        .join('');
  }
  if (addBtn) addBtn.disabled = (_allVariantsCache || []).every((v) => list.includes(v));
}

// Build a single pet-management row. Built-in rows are non-destructive
// (no delete button); imported rows get a delete button. Thumbnails fall
// back to an emoji when the registry can't give us a frame.
function petRow(pet, currentPetId) {
  const isCurrent = pet.id === currentPetId;
  const isImported = pet.source === 'imported';
  const sourceTag = isImported
    ? `<span class="tag">已导入${pet.origin === 'zip' ? ' · ZIP' : ' · 文件夹'}</span>`
    : `<span class="tag">内置</span>`;
  const sizeTxt = pet.defaultSize ? `${pet.defaultSize.w}×${pet.defaultSize.h}` : '';
  const meta = [
    sourceTag,
    sizeTxt ? `<span class="meta">${sizeTxt}</span>` : '',
    pet.importedAt ? `<span class="meta">导入于 ${escapeHtml(String(pet.importedAt).slice(0, 10))}</span>` : '',
  ].filter(Boolean).join(' ');
  const desc = pet.description ? `<div class="meta">${escapeHtml(pet.description)}</div>` : '';
  return `
    <div class="list-item pet-row" data-pet-id="${escapeHtml(pet.id)}" data-source="${escapeHtml(pet.source || 'builtIn')}">
      <div class="row" style="gap:12px; flex:1; min-width:0; align-items:center;">
        <div class="pet-thumb-wrap" data-pet-thumb-for="${escapeHtml(pet.id)}">
          <div class="pet-thumb pet-thumb-emoji">🐾</div>
        </div>
        <div style="min-width:0; flex:1;">
          <div class="lr-title" style="display:flex; align-items:center; gap:6px;">
            <span>${escapeHtml(pet.name || pet.id)}</span>
            ${isCurrent ? '<span class="tag tag-current">当前使用</span>' : ''}
          </div>
          <div class="lr-meta">${meta}</div>
          ${desc}
        </div>
      </div>
      <div class="row" style="gap:6px;">
        ${isImported
          ? `<button class="btn danger" data-action="remove-pet" data-pet-id="${escapeHtml(pet.id)}" data-pet-name="${escapeHtml(pet.name || pet.id)}">删除</button>`
          : ''}
      </div>
    </div>
  `;
}

function wirePetListActions(currentPetId) {
  document.querySelectorAll('[data-action="remove-pet"]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-pet-id');
      const name = btn.getAttribute('data-pet-name') || id;
      const wasCurrent = id === currentPetId;
      const warn = wasCurrent
        ? '\n\n当前正在使用它，删除后会自动切换到其他内置桌宠。'
        : '';
      if (!confirm(`确认删除桌宠"${name}"？此操作不可撤销。${warn}`)) return;
      try {
        const r = await api.pet.removeImported?.(id);
        if (r && r.switchedTo) toast(`已删除并切换到 ${r.switchedTo}`);
        else                    toast('已删除');
        render();
      } catch (e) {
        toast('删除失败：' + ((e && e.message) || e));
      }
    };
  });
  // Lazy async thumbnails: resolve the first frame of the default variant
  // for each row. Errors are swallowed — the emoji stays in place.
  const wraps = document.querySelectorAll('[data-pet-thumb-for]');
  wraps.forEach((wrap) => {
    const petId = wrap.getAttribute('data-pet-thumb-for');
    if (!petId || !api.pet.resolveFrames) return;
    api.pet.resolveFrames(petId, 'default', 'right')
      .then((r) => {
        if (r && Array.isArray(r.frames) && r.frames.length > 0) {
          wrap.innerHTML = `<img class="pet-thumb" src="${escapeHtml(r.frames[0].url)}" alt="${escapeHtml(petId)}"/>`;
        }
      })
      .catch(() => { /* keep emoji */ });
  });
}

register('/settings', render);

// ---------------------------------------------------------------------------
// 软件更新卡片 (main/app_update.js)
// ---------------------------------------------------------------------------
//
// 单独成函数的原因：这张卡片的状态会自己变——每日检查在后台完成、下载进度
// 一路往上报——而它周围的内容都是静态的。塞进 render() 的整页 innerHTML
// 赋值会导致每次进度事件都把整个设置页重建一遍，正在输入的文本框内容会被
// 冲掉。所以它只重绘自己那一个 #update-card-body。
//
// 订阅的两个事件：
//   app:update-progress → 下载进度（{ phase, percent, received, total }）
//   app:update-state    → 主进程状态变了（后台检查完成、开始/结束下载）

let _updateState = null;   // 最近一次主进程状态
let _updateProgress = null; // 下载进度，非 null 表示正在下载
let _updateUnsub = [];      // 事件退订函数，页面重渲染时统一清理

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ts) {
  if (!ts) return '从未';
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '从未';
  const d = new Date(n);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderUpdateCard(state) {
  const body = document.getElementById('update-card-body');
  if (!body) return;
  if (state) _updateState = state;

  // 重新订阅。render() 每次进页面都会调这里，而退订函数会被丢掉，所以
  // 先清掉上一轮的，否则事件会叠加（一次下载进度触发 N 次重绘）。
  for (const off of _updateUnsub) { try { off(); } catch (_) { /* 已失效 */ } }
  _updateUnsub = [];
  if (api.on) {
    _updateUnsub.push(api.on('app:update-progress', (p) => {
      _updateProgress = p;
      paintUpdateCard();
    }));
    _updateUnsub.push(api.on('app:update-state', async (s) => {
      _updateState = s;
      // 状态变了多半意味着后台检查有结果，把过期的进度清掉。
      if (!s.downloading) _updateProgress = null;
      paintUpdateCard();
    }));
  }

  paintUpdateCard();
}

// 只重绘卡片内容，不碰页面上任何其他元素。
function paintUpdateCard() {
  const body = document.getElementById('update-card-body');
  if (!body || !_updateState) return;
  const s = _updateState;

  if (!s.supported) {
    body.innerHTML = `
      <p class="meta">当前版本 <strong>${escapeHtml(s.currentVersion || '—')}</strong>。</p>
      <p class="meta" style="margin-top:4px; color:#b26a00;">
        自动更新仅在打包安装版（Windows）可用；开发模式下请从
        <code>GitHub Releases</code> 手动下载。
      </p>`;
    return;
  }

  const info = s.info;
  const hasUpdate = !!(info && info.hasUpdate);
  const downloading = !!s.downloading || !!_updateProgress;

  // --- 进度条 ---
  let progressHtml = '';
  if (downloading) {
    const p = _updateProgress || {};
    // percent 可能为 null：GitHub 的对象存储不总是给 content-length，
    // 这时只能显示不确定态的动画条而不是一个假的 0%。
    const pct = (p.percent === null || p.percent === undefined) ? null : Math.max(0, Math.min(100, p.percent));
    progressHtml = `
      <div style="margin-top:12px;">
        <div class="meta">正在下载安装包…${pct === null ? '' : ` ${pct}%`}</div>
        <div class="tools-progress-bar" style="margin-top:6px;">
          <div class="tools-progress-fill" style="width:${pct === null ? 30 : pct}%;${pct === null ? 'animation: tools-progress-indeterminate 1.2s ease-in-out infinite;' : ''}"></div>
        </div>
        ${p.total ? `<div class="meta" style="margin-top:4px;">${fmtBytes(p.received)} / ${fmtBytes(p.total)}</div>` : ''}
        <p class="meta" style="margin-top:6px; color:#b26a00;">
          下载完成后会自动启动安装程序，中途请不要关闭 SoulDesktopPet。
        </p>
      </div>`;
  }

  // --- 有更新 / 已是最新 ---
  let statusHtml;
  if (s.checking) {
    statusHtml = '<p class="meta" style="margin-top:8px;">正在检查更新…</p>';
  } else if (hasUpdate) {
    const notes = (info.notes || '').trim();
    statusHtml = `
      <div class="meta" style="margin-top:8px;">
        发现新版本 <strong>${escapeHtml(info.version)}</strong>
        <span style="color:var(--muted);">（当前 ${escapeHtml(s.currentVersion)}）</span>
        ${info.publishedAt ? ` · 发布于 ${escapeHtml(fmtTime(Date.parse(info.publishedAt) || null))}` : ''}
      </div>
      ${notes
        ? `<details style="margin-top:8px;">
             <summary class="meta" style="cursor:pointer;">更新内容</summary>
             <pre class="meta" style="white-space:pre-wrap; margin-top:6px; font-family:inherit;">${escapeHtml(notes)}</pre>
           </details>`
        : ''}
      ${info.downloadable
        ? ''
        : '<p class="meta" style="margin-top:8px; color:#b26a00;">⚠ 该版本未提供适用于当前系统的安装包，可前往 GitHub Releases 手动查看。</p>'}`;
  } else if (s.error) {
    statusHtml = `<p class="meta" style="margin-top:8px; color:#b26a00;">${escapeHtml(s.error)}</p>`;
  } else if (info) {
    statusHtml = `<p class="meta" style="margin-top:8px;">已是最新版本（${escapeHtml(s.currentVersion)}）。</p>`;
  } else {
    statusHtml = '<p class="meta" style="margin-top:8px;">尚未检查过更新。</p>';
  }

  // --- 按钮 ---
  let buttons;
  if (downloading) {
    buttons = '<button class="btn" disabled>正在下载…</button>';
  } else if (hasUpdate && info.downloadable) {
    buttons = `<button class="btn" id="btn-update-now">下载并更新</button>
               <button class="btn secondary" id="btn-check-update">重新检查</button>`;
  } else if (hasUpdate) {
    // 有新版本但没有对应平台的安装包：唯一出路是去 GitHub 手动下载。
    buttons = `<button class="btn" id="btn-open-releases">前往 GitHub 下载</button>
               <button class="btn secondary" id="btn-check-update">重新检查</button>`;
  } else {
    buttons = `<button class="btn" id="btn-check-update" ${s.checking ? 'disabled' : ''}>
                 ${s.checking ? '检查中…' : '检查更新'}
               </button>`;
  }

  body.innerHTML = `
    <p class="meta">当前版本 <strong>${escapeHtml(s.currentVersion || '—')}</strong>
      ${hasUpdate ? '' : ''}
      · 上次检查：${escapeHtml(fmtTime(s.lastCheckAt))}
    </p>
    <div class="field" style="justify-content:flex-start; margin-top:10px;">
      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="app-update-enabled" ${s.enabled ? 'checked' : ''}/>
        每天自动检查一次更新
      </label>
    </div>
    ${statusHtml}
    ${progressHtml}
    <div class="row" style="gap:8px; margin-top:12px; flex-wrap:wrap;">
      ${buttons}
    </div>
    <p class="meta" style="margin-top:10px;">
      更新来源：GitHub Releases（<code>${escapeHtml(s.repo || '')}</code>）。
      下载的安装包会先校验 SHA-256 再执行；校验不通过的文件不会被安装。
      你的联系人、提醒、回忆和照片保存在应用数据目录，升级不会删除它们。
    </p>`;

  wireUpdateCard();
}

// 事件委托在每次重绘后重绑。按钮节点每次 paintUpdateCard 都是新建的，
// 所以这里必须重新绑定。
function wireUpdateCard() {
  const toggle = document.getElementById('app-update-enabled');
  if (toggle) {
    toggle.onchange = async (e) => {
      const want = !!e.target.checked;
      try {
        const r = await api.app.setUpdateEnabled(want);
        _updateState = r.state || _updateState;
        paintUpdateCard();
        toast(want ? '已开启每日自动检查更新' : '已关闭自动检查更新');
      } catch (err) {
        // 落库失败要把勾选框弹回去，否则界面显示的是一个不存在的状态。
        e.target.checked = !want;
        toast('设置失败：' + ((err && err.message) || err));
      }
    };
  }

  const checkBtn = document.getElementById('btn-check-update');
  if (checkBtn) {
    checkBtn.onclick = async () => {
      checkBtn.disabled = true;
      try {
        const r = await api.app.checkUpdate();
        _updateState = r.state || _updateState;
        if (!r.ok) {
          _updateState = { ..._updateState, error: r.reason || '检查更新失败' };
          toast(r.reason || '检查更新失败');
        } else if (r.hasUpdate) {
          toast(`发现新版本 ${r.info.version}`);
        } else {
          toast('已是最新版本');
        }
      } catch (err) {
        toast('检查失败：' + ((err && err.message) || err));
      } finally {
        paintUpdateCard();
      }
    };
  }

  const releasesBtn = document.getElementById('btn-open-releases');
  if (releasesBtn) {
    releasesBtn.onclick = () => openReleasesPage();
  }

  const updateBtn = document.getElementById('btn-update-now');
  if (updateBtn) {
    updateBtn.onclick = async () => {
      updateBtn.disabled = true;
      _updateProgress = { phase: 'downloading', percent: 0, received: 0, total: 0 };
      paintUpdateCard();
      let r;
      try {
        r = await api.app.downloadUpdate();
      } catch (err) {
        _updateProgress = null;
        paintUpdateCard();
        toast('下载失败：' + ((err && err.message) || err));
        return;
      }
      _updateProgress = null;
      _updateState = r.state || _updateState;

      if (!r.ok) {
        paintUpdateCard();
        // 校验和缺失、下载中断这类失败都可能需要用户去 GitHub 手动拿，
        // 所以提供「打开 Releases 页面」的出口，而不是让用户干瞪眼。
        toast(r.reason || '下载失败');
        if (r.reason && /校验和|手动/.test(r.reason)) {
          openReleasesPage();
        }
        return;
      }

      // 下载成功，直接进入安装。install() 会弹确认框，然后关掉应用。
      try {
        const ir = await api.app.installUpdate({
          path: r.path,
          version: r.version,
          confirm: true,
        });
        if (ir && ir.canceled) {
          paintUpdateCard();
          toast('已取消更新');
        }
        // 非取消时应用会退出，这里不再操作界面。
      } catch (err) {
        paintUpdateCard();
        toast('安装失败：' + ((err && err.message) || err));
      }
    };
  }
}

// 在系统浏览器打开 Releases 页面——校验和缺失这类没法自动解决的失败，
// 用户需要有个去处。
async function openReleasesPage() {
  const repo = _updateState?.repo || 'LIhong42/soul-desktop-pet';
  const url = `https://github.com/${repo}/releases/latest`;
  const r = await api.app.openExternal?.(url);
  if (!r || !r.ok) toast('请手动打开：' + url);
}