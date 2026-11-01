// src/js/pages/contact_edit.js — create or edit a contact (basic info only).
//
// Likes / taboos / gifts used to be edited inline here, but they now live in
// the global contact_attributes table and are managed from the dedicated
// `/likes`, `/taboos`, `/gifts` top-level pages. The reminder card below
// links the user there.
//
// Avatar: the contact row carries two independent fields:
//
//   * `icon_kind`     — Lucide-style glyph identifier. Picked from the
//                       icon grid below. Used as the default when no photo
//                       has been uploaded.
//   * `custom_avatar_path` — relative path under <appData>/SoulDesktopPet/avatars/
//                       pointing at the user's uploaded photo (or null when
//                       they have not picked one). The renderer resolves
//                       that path to a CSP-safe data URL via
//                       `contacts:avatar_read` and caches the result.
//
// Either field can stand alone, so a user with no photo still gets a
// recognisable icon, and a user who prefers the picker doesn't have to
// upload anything.
import { api, escapeHtml, toast, getCachedAvatarDataUrl, fetchAvatarDataUrl, invalidateAvatarDataUrl } from '../api.js';
import { ICONS, iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate } from '../router.js';

async function render(args) {
  const app = document.getElementById('app');
  const isNew = !args.id;
  let c = { id: null, name: '', relationship: '', icon_kind: 'user', custom_avatar_path: null };
  if (!isNew) {
    c = await api.contacts.get(args.id);
    // Prime the avatar cache so the first paint already shows the photo.
    fetchAvatarDataUrl(c.id);
  }
  // The effective glyph when the user has not picked one yet: prefer the
  // stored `icon_kind`, then fall back to the relationship-based suggestion.
  // The picker uses this to seed its selected cell.
  const initialKind = c.icon_kind && c.icon_kind !== 'user'
    ? c.icon_kind
    : (c.icon_kind || suggestIconKind(c.relationship));

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建联系人' : '编辑联系人'}</h1>
      <a class="pill-link" href="${isNew ? '#/contacts' : '#/contacts/' + c.id}">取消</a>
    </div>

    <div class="card">
      <div class="section-header"><h2>基本信息</h2></div>
      <div class="field">
        <label>姓名 *</label>
        <input type="text" id="f-name" value="${escapeHtml(c.name || '')}" autofocus/>
      </div>
      <div class="field">
        <label>与本人的关系</label>
        <input type="text" id="f-relationship" placeholder="家人 / 朋友 / 同事..."
               value="${escapeHtml(c.relationship || '')}"/>
      </div>
    </div>

    <div class="card">
      <div class="section-header">
        <h2>头像</h2>
        <div class="meta" id="avatar-current-label"></div>
      </div>
      <div class="row" style="gap:14px; align-items:center;">
        <div class="contact-avatar contact-avatar-preview"
             id="avatar-preview"
             style="color: var(--contact-${c.name ? defaultIndexFor(c.name) : 1})">
          ${renderAvatarPreview(c, getCachedAvatarDataUrl(c.id))}
        </div>
        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:8px;">
          <input type="file" id="f-avatar-file" accept="image/jpeg,image/png,image/gif,image/webp,image/bmp" hidden/>
          <button type="button" class="btn secondary" id="f-avatar-pick">上传头像…</button>
          <button type="button" class="btn secondary" id="f-avatar-clear" ${c.custom_avatar_path ? '' : 'disabled'}>清除头像</button>
          <div class="meta">支持 JPG / PNG / GIF / WebP / BMP，单张 ≤ 5MB。${isNew ? '保存联系人后可上传头像。' : ''}</div>
        </div>
      </div>
      <div class="icon-grid" id="icon-grid"></div>
    </div>

    <div class="card">
      <div class="section-header"><h2>喜好 / 忌讳 / 礼物</h2></div>
      <div class="meta">在顶部导航的「<a class="inline-link" href="#/likes">喜好</a> / <a class="inline-link" href="#/taboos">忌讳</a> / <a class="inline-link" href="#/gifts">礼物</a>」页面统一管理。</div>
    </div>

    <div class="row" style="margin-top:14px; gap:8px;">
      <button class="btn" id="save">${isNew ? '创建' : '保存'}</button>
      ${!isNew ? `<button class="btn danger" id="del">删除</button>` : ''}
    </div>
  `;

  // --- Icon picker wiring ---
  // `pickedKind` is the currently-selected Lucide glyph. It overrides the
  // photo's icon-ish appearance only when the user has NOT uploaded a custom
  // image — the renderer falls back to `iconSVG(pickedKind)` when there's
  // no `custom_avatar_path` to display. When a photo exists, `pickedKind`
  // is kept as the *post-photo* default glyph that will be used if the user
  // later clears the photo.
  const grid = document.getElementById('icon-grid');
  const previewEl = document.getElementById('avatar-preview');
  const labelEl = document.getElementById('avatar-current-label');
  let pickedKind = initialKind;

  function renderGrid() {
    grid.innerHTML = ICONS.map((ic) => {
      const selected = ic.name === pickedKind ? ' selected' : '';
      return `<div class="icon-cell${selected}" data-name="${escapeHtml(ic.name)}" title="${escapeHtml(ic.label)}">${iconSVG(ic.name, { size: 26 })}</div>`;
    }).join('');
    grid.querySelectorAll('.icon-cell').forEach((cell) => {
      cell.onclick = () => {
        pickedKind = cell.dataset.name;
        // When a photo is set, the preview is locked to that photo; clicking
        // a glyph updates the "next default" instead. When no photo is set,
        // clicking a glyph swaps the preview to the chosen icon immediately.
        if (!c.custom_avatar_path && !pendingFileInput) {
          previewEl.innerHTML = iconSVG(pickedKind, { size: 28 });
        }
        grid.querySelectorAll('.icon-cell').forEach((cc) => cc.classList.remove('selected'));
        cell.classList.add('selected');
        const meta = ICONS.find((i) => i.name === pickedKind);
        labelEl.textContent = meta ? `默认图标：${meta.label}` : '';
      };
    });
  }
  renderGrid();

  // --- Avatar wiring ---
  // The preview shows whichever of (a) the uploaded photo, (b) the picked
  // Lucide glyph, or (c) the auto-suggested glyph applies. `pendingFileInput`
  // tracks whether the user has selected a new file in this session that
  // hasn't yet been uploaded to disk — once they save() we POST the bytes.
  const fileInput = document.getElementById('f-avatar-file');
  const pickBtn   = document.getElementById('f-avatar-pick');
  const clearBtn  = document.getElementById('f-avatar-clear');
  let pendingFileInput = null; // File object the user just picked (or null)

  function updateLabel() {
    if (c.custom_avatar_path || pendingFileInput) {
      labelEl.textContent = '当前：已设置自定义头像';
    } else {
      const meta = ICONS.find((i) => i.name === pickedKind);
      labelEl.textContent = meta ? `当前：${meta.label}` : '当前：未设置';
    }
  }
  updateLabel();

  // Initial async load: the cache might still be cold on first visit. When
  // the data URL resolves, drop it into the preview.
  if (!isNew && c.custom_avatar_path) {
    fetchAvatarDataUrl(c.id).then((url) => {
      if (!url) return;
      previewEl.innerHTML = renderAvatarImg(url);
      updateLabel();
    });
  }

  pickBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      toast('头像文件超过 5MB，请压缩后再试');
      fileInput.value = '';
      return;
    }
    const mimeOk = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
    ].includes((f.type || '').toLowerCase());
    if (!mimeOk) {
      toast('不支持的图片格式');
      fileInput.value = '';
      return;
    }
    try {
      // Show a local blob URL immediately so the user gets feedback before
      // the save round-trip. The File itself stays in fileInput.files for
      // the save() handler to POST.
      const blobUrl = URL.createObjectURL(f);
      pendingFileInput = f;
      previewEl.innerHTML = renderAvatarImg(blobUrl);
      clearBtn.disabled = false;
      labelEl.textContent = '当前：已选择新头像（保存后生效）';
    } catch (e) {
      toast('读取图片失败');
      console.error(e);
    }
  };

  clearBtn.onclick = async () => {
    pendingFileInput = null;
    fileInput.value = '';
    if (isNew) {
      // No persisted row yet — just drop the in-memory preview.
      previewEl.innerHTML = iconSVG(pickedKind, { size: 28 });
      clearBtn.disabled = true;
      updateLabel();
      return;
    }
    try {
      await api.contacts.deleteAvatar(c.id);
      invalidateAvatarDataUrl(c.id);
      c.custom_avatar_path = null;
      previewEl.innerHTML = iconSVG(pickedKind, { size: 28 });
      clearBtn.disabled = true;
      updateLabel();
      toast('已清除头像');
    } catch (e) {
      toast('清除失败：' + (e && e.message ? e.message : e));
    }
  };

  // --- Auto-suggest when relationship text changes ---
  // Only kicks in when the user hasn't manually picked a glyph and no photo
  // is set; otherwise we'd be undoing a deliberate choice on every keystroke.
  const relInput = document.getElementById('f-relationship');
  relInput.oninput = () => {
    if (c.custom_avatar_path || pendingFileInput) return;
    const suggested = suggestIconKind(relInput.value);
    if (suggested && suggested !== pickedKind) {
      pickedKind = suggested;
      previewEl.innerHTML = iconSVG(suggested, { size: 28 });
      grid.querySelectorAll('.icon-cell').forEach((cc) => {
        cc.classList.toggle('selected', cc.dataset.name === suggested);
      });
      const meta = ICONS.find((i) => i.name === suggested);
      labelEl.textContent = meta ? `已自动推荐：${meta.label}` : '';
    }
  };

  // --- Save / delete ---
  document.getElementById('save').onclick = async () => {
    const name = document.getElementById('f-name').value.trim();
    const relationship = document.getElementById('f-relationship').value.trim() || null;
    if (!name) { toast('请填写「姓名」'); return; }

    let saved;
    try {
      saved = isNew
        ? await api.contacts.create({ name, relationship, icon_kind: pickedKind, custom_avatar_path: null })
        : await api.contacts.update(c.id, { name, relationship, icon_kind: pickedKind, custom_avatar_path: c.custom_avatar_path });
    } catch (e) {
      toast('保存失败：' + (e && e.message ? e.message : e));
      return;
    }

    // If the user picked a file in this session, ship the bytes to the
    // server now. Only does anything for an existing contact — for new
    // contacts we needed the id first, which we now have.
    if (pendingFileInput) {
      try {
        const ab = await pendingFileInput.arrayBuffer();
        await api.contacts.uploadAvatar(saved.id, {
          filename: pendingFileInput.name,
          mime: pendingFileInput.type,
          bytes: ab,
        });
        invalidateAvatarDataUrl(saved.id);
      } catch (e) {
        toast('头像上传失败：' + (e && e.message ? e.message : e));
      }
    }

    toast('已保存');
    navigate('/contacts/' + saved.id);
  };

  if (!isNew) {
    document.getElementById('del').onclick = async () => {
      if (!confirm('确认删除该联系人？\n\n该联系人关联的所有喜好、忌讳、礼物、重要日期以及只与该联系人关联的事件都会被一并删除。多联系人共享的事件会被保留（仅去除关联）。')) return;
      let result;
      try {
        result = await api.contacts.delete(c.id);
      } catch (e) {
        toast('删除失败：' + (e.message || e));
        return;
      }
      invalidateAvatarDataUrl(c.id);
      if (result && result.deleted && result.summary) {
        const s = result.summary;
        const parts = [];
        if (s.attributes)       parts.push(`${s.attributes} 条喜好/忌讳/礼物`);
        if (s.important_dates)  parts.push(`${s.important_dates} 个重要日期`);
        if (s.events)           parts.push(`${s.events} 个事件`);
        if (s.events_kept)      parts.push(`保留 ${s.events_kept} 个共享事件`);
        toast(parts.length ? `已删除 · ${parts.join(' / ')}` : '已删除');
      } else {
        toast('已删除');
      }
      navigate('/contacts');
    };
  }
}

// Render the avatar preview cell. Three states:
//   1. The user has uploaded a photo — show it (data URL).
//   2. No photo, but a glyph is picked — show the glyph.
//   3. No photo and no glyph — show the placeholder silhouette.
// The renderer treats the photo as authoritative: clicking a glyph in the
// grid does nothing visually when a photo is set, but the picked glyph is
// remembered as the next default if the user later clears the photo.
function renderAvatarPreview(c, cachedDataUrl) {
  if (cachedDataUrl) return renderAvatarImg(cachedDataUrl);
  // No photo — caller decides which glyph based on its `initialKind`. We
  // import iconSVG via the module so the picker and the preview share the
  // same shape, colour and stroke width.
  // The caller passes the effective kind via `c.icon_kind` already.
  const name = c.icon_kind && c.icon_kind !== 'user'
    ? c.icon_kind
    : 'user';
  return iconSVG(name, { size: 28 });
}

function renderAvatarImg(url) {
  return `<img src="${escapeHtml(url)}" alt=""/>`;
}

// Default palette index from a name, used only to color the avatar preview
// while the user is typing. Mirrors api.contactColorIndex but lives here to
// avoid an import cycle with api.js.
function defaultIndexFor(name) {
  const v = (name || '').trim();
  if (!v) return 1;
  let h = 0;
  for (let i = 0; i < v.length; i++) h = ((h << 5) - h + v.charCodeAt(i)) | 0;
  return (Math.abs(h) % 8) + 1;
}

register('/contacts/new', () => render({}));
register('/contacts/:id/edit', render);
