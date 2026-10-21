// src/js/pages/settings.js — pet selection, walk toggle, pack import / remove,
// backup, quit
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render() {
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
      <div class="row" style="gap:8px; margin-top:10px; flex-wrap:wrap;">
        <button class="btn" id="import-from-zip">上传桌宠压缩包…</button>
      </div>

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
    try {
      const r = await api.pet.importFromZip?.();
      if (!r || r.canceled) return;
      const count = (r && typeof r.variantCount === 'number') ? r.variantCount : null;
      if (r.deduped) {
        toast(count != null
          ? `已存在同内容桌宠：${r.pet.name}（${count} 个动作）`
          : `已存在同内容桌宠：${r.pet.name}`);
      } else {
        toast(count != null
          ? `已导入：${r.pet.name}（识别了 ${count} 个动作）`
          : `已导入：${r.pet.name}`);
      }
      render();
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || e));
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