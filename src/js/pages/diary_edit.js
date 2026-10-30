// src/js/pages/diary_edit.js — the diary editor for 回忆事件.
//
// This page replaces the old one-field-per-slot memorial form. Instead of
// five narrow inputs (去了哪里 / 吃了什么 / 穿了什么 / 干了哪些事 / 补充描述)
// the user now writes on a single diary page: a title, a free-form body,
// and any number of photos, laid over one of six background styles.
//
// Flow:
//   /diary/new          → a blank diary page
//   /diary/<id>         → an existing entry
//   保存                → the entry is written (photos included)
//
// ---- Mixed text and images ----
//
// The body is not a plain <textarea> — that would keep text and photos
// in two separate boxes, which is what the old form did. Instead the page
// holds an ordered list of BLOCKS:
//
//   { type: 'text',  text: '…' }
//   { type: 'image', photo_id: '…' }
//
// The user types into a text block, and inserting an image splits the
// current block and inserts an image block between the halves. So the
// document reads top to bottom exactly as it will be stored.
//
// The blocks live in the `content` column (a JSON array). The plain text
// is ALSO written to the legacy `notes` column, because the search index
// and the album export both read that column — a diary written as mixed
// content must still be findable by its words.
//
// The five legacy structured fields (place / food / outfit / activities)
// are left untouched on save — they keep whatever the old form wrote, so
// an entry created before the diary editor existed still shows its
// structured fields in the detail view and in search results.

import {
  api, escapeHtml, displayName, toast,
  memorialPhotoUrl, fetchPhotoDataUrl, invalidatePhotoDataUrl,
  nowDatetimeLocal, wireDateInputs,
} from '../api.js';
import { register, navigate, getReferrerPath } from '../router.js';
import {
  DIARY_THEMES, DEFAULT_THEME_ID, getDiaryTheme, diaryThemeVars,
} from '../diary_themes.js';

const MEMORIAL_LIST_ROUTE = '/events/memorial';

// The state of the page currently on screen. Kept at module scope so a
// failed save doesn't lose what the user typed, and so the photo upload
// pass can find the blocks it needs to rewrite.
const pageState = {
  isNew: true,
  eventId: null,
  background: DEFAULT_THEME_ID,
  selectedContactIds: new Set(),
  // The mixed document. `blocks[i].el` points at the live DOM node for
  // that block (text blocks only — image blocks are re-rendered from
  // their photo id).
  blocks: [],
  // Photos the user picked but that aren't uploaded yet. Each entry is
  // { file, url, tempId }. A block referring to a tempId is rewritten to
  // the real photo id once the upload succeeds.
  pendingPhotos: [],
  existingPhotos: [],
  returnTo: MEMORIAL_LIST_ROUTE,
};

// ---- Theme picker --------------------------------------------------------

// Render the six background style tiles. Each tile previews the style
// faithfully: the header bar, the page background and the three accent
// dots, exactly like the reference picker.
function themePickerHtml(selectedId) {
  return `
    <div class="diary-theme-grid">
      ${DIARY_THEMES.map((t) => `
        <button type="button" class="diary-theme-tile${t.id === selectedId ? ' selected' : ''}"
                data-theme-id="${escapeHtml(t.id)}" title="${escapeHtml(t.name)}">
          <span class="diary-theme-bar" style="background:${escapeHtml(t.headerBg)}">Tackbox</span>
          <span class="diary-theme-body" style="background:${escapeHtml(t.bg)}">
            <span class="diary-theme-dots">
              ${t.dots.map((c) => `<i style="background:${escapeHtml(c)}"></i>`).join('')}
            </span>
            <span class="diary-theme-name" style="color:${escapeHtml(t.text)}">${escapeHtml(t.name)}</span>
          </span>
          <span class="diary-theme-check">✓</span>
        </button>
      `).join('')}
    </div>
  `;
}

// ---- Contact picker ------------------------------------------------------

function contactPickerHtml(contacts, selected) {
  if (contacts.length === 0) {
    return `<div class="meta">还没有联系人可选择</div>`;
  }
  return `
    <div class="contact-picker-toolbar">
      <button type="button" class="btn secondary btn-tiny" id="diary-contacts-all">全选</button>
      <button type="button" class="btn secondary btn-tiny" id="diary-contacts-none">清空</button>
      <span class="meta" id="diary-contacts-count"></span>
    </div>
    <div class="contact-picker" id="diary-contact-picker">
      ${contacts.map((c) => `
        <div class="contact-pick${selected.has(c.id) ? ' selected' : ''}" data-id="${escapeHtml(c.id)}">
          <span class="contact-pick-check" aria-hidden="true">✓</span>
          <span class="contact-pick-name">${escapeHtml(displayName(c))}</span>
          ${c.relationship ? `<span class="contact-pick-meta">${escapeHtml(c.relationship)}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// ---- Lightbox ------------------------------------------------------------
//
// Same shared-modal pattern the memorial edit page uses: one element,
// reopened by swapping the <img src>.

let lightboxEl = null;
function openLightbox(url, altName) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.id = 'photo-lightbox';
    lightboxEl.className = 'photo-lightbox';
    lightboxEl.innerHTML = `
      <div class="photo-lightbox-card">
        <button type="button" class="photo-lightbox-x" title="关闭">✕</button>
        <img id="photo-lightbox-img" alt=""/>
        <div class="photo-lightbox-caption" id="photo-lightbox-caption"></div>
      </div>
    `;
    document.body.appendChild(lightboxEl);
    const close = () => { lightboxEl.classList.remove('open'); };
    lightboxEl.querySelector('.photo-lightbox-x').onclick = close;
    lightboxEl.addEventListener('click', (e) => { if (e.target === lightboxEl) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightboxEl.classList.contains('open')) close();
    });
  }
  lightboxEl.querySelector('#photo-lightbox-img').src = url;
  lightboxEl.querySelector('#photo-lightbox-img').alt = altName || '';
  lightboxEl.querySelector('#photo-lightbox-caption').textContent = altName || '';
  lightboxEl.classList.add('open');
}

// ---- Blocks --------------------------------------------------------------
//
// A block is the unit of the mixed document. Text blocks are <textarea>
// elements so the user gets a real editing surface (multi-line, IME
// friendly, no contenteditable quirks); image blocks are a figure with
// the photo and a delete button.
//
// Blocks are kept in `pageState.blocks` in document order, and each text
// block keeps a reference to its own <textarea> so the document can be
// serialized on save without re-querying the DOM.

let blockSeq = 0;

// Build one text block. `text` is its initial content.
function makeTextBlock(text) {
  const id = 'diary-tb-' + (++blockSeq);
  const block = { type: 'text', id, el: null };
  const ta = document.createElement('textarea');
  ta.className = 'diary-block-text';
  ta.id = id;
  ta.rows = 1;
  ta.placeholder = '写下这一刻…';
  ta.value = text || '';
  // Auto-grow: the textarea has no inner scrollbar, it just gets taller
  // as the user types. That keeps the page reading as one document.
  ta.addEventListener('input', () => autoGrow(ta));
  block.el = ta;
  return block;
}

// Resize a text block to fit its content.
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// Build one image block. `photoId` is either a saved photo id or a
// pending-upload temp id.
//
// The preview source is a DATA URL, not a blob: URL. The app's CSP is
// `img-src 'self' data: file:` — a blob: URL is blocked, so a
// createObjectURL preview would render as a broken image. Reading the
// picked file into a data URL costs the same round trip the existing
// photo cache already makes, and it works under the CSP.
function makeImageBlock(photoId, name, previewUrl) {
  const block = { type: 'image', photoId, name: name || '', previewUrl: previewUrl || null, el: null };
  const fig = document.createElement('figure');
  fig.className = 'diary-block-image';
  fig.dataset.photoId = photoId;
  const img = document.createElement('img');
  img.alt = name || '';
  img.loading = 'lazy';
  if (previewUrl) {
    img.src = previewUrl;
  } else {
    const cached = memorialPhotoUrl(photoId);
    img.src = cached || '';
    if (!cached) {
      // The bytes aren't cached yet — pull them and swap them in. The
      // placeholder keeps the layout from jumping.
      fetchPhotoDataUrl(photoId).then((url) => {
        if (url && img.src !== url) img.src = url;
      });
    }
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'photo-x';
  del.title = '删除这张图片';
  del.textContent = '✕';
  fig.appendChild(img);
  fig.appendChild(del);
  block.el = fig;
  return block;
}

// Read a picked file into a data URL so it can be shown in an <img>.
// The CSP allows data: URLs, which is what the saved photos use too.
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Insert a block into the list at `index` and put it on the page.
function insertBlock(index, block) {
  pageState.blocks.splice(index, 0, block);
  renderBlocks();
  return block;
}

// Remove the block at `index`.
function removeBlock(index) {
  const block = pageState.blocks[index];
  if (!block) return;
  // Deleting an image also deletes the underlying photo — otherwise the
  // file would linger on disk with no reference to it.
  if (block.type === 'image') {
    const pending = pageState.pendingPhotos.find((p) => p.tempId === block.photoId);
    if (pending) {
      pageState.pendingPhotos = pageState.pendingPhotos.filter((p) => p.tempId !== block.photoId);
    } else {
      api.memorialEvents.photos.delete(block.photoId)
        .then(() => invalidatePhotoDataUrl(block.photoId))
        .catch((e) => console.error('photo delete failed:', e));
    }
  }
  pageState.blocks.splice(index, 1);
  renderBlocks();
}

// Re-render every block into the page. The text blocks keep their live
// <textarea> nodes (they hold the user's cursor position and uncommitted
// IME composition), so only the image blocks are rebuilt.
function renderBlocks() {
  const host = document.getElementById('diary-blocks');
  if (!host) return;
  host.innerHTML = '';
  for (const block of pageState.blocks) {
    const wrap = document.createElement('div');
    wrap.className = 'diary-block';
    wrap.dataset.blockType = block.type;
    const idx = pageState.blocks.indexOf(block);
    if (block.type === 'text') {
      wrap.appendChild(block.el);
      // The per-block toolbar. "插入图片" puts the picture right at the
      // caret, which is what makes text and images interleave.
      const bar = document.createElement('div');
      bar.className = 'diary-block-bar';
      bar.innerHTML = `
        <button type="button" class="btn secondary btn-tiny" data-act="insert-image">插入图片</button>
        <button type="button" class="btn secondary btn-tiny" data-act="delete-block">删除此段</button>
      `;
      bar.querySelector('[data-act="insert-image"]').onclick = () => {
        // Insert at the caret: the text above the caret stays above the
        // picture, the text below moves under it.
        const fileInput = document.getElementById('diary-photos');
        block.el.focus();
        pendingInsertFor = block;
        if (fileInput) fileInput.click();
      };
      bar.querySelector('[data-act="delete-block"]').onclick = () => removeBlock(idx);
      wrap.appendChild(bar);
    } else {
      wrap.appendChild(block.el);
      // Re-assert the source on every render. The <img> is re-attached to
      // the document here, and a data: URL that was detached in between
      // can come back broken — setting it again makes the browser reload
      // it.
      const img = block.el.querySelector('img');
      if (img) {
        const src = block.previewUrl || memorialPhotoUrl(block.photoId);
        if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
      }
      const bar = document.createElement('div');
      bar.className = 'diary-block-image-bar';
      bar.innerHTML = `
        <button type="button" class="btn secondary btn-tiny" data-act="insert-before">↑ 在上方插入文字</button>
        <button type="button" class="btn secondary btn-tiny" data-act="insert-after">↓ 在下方插入文字</button>
      `;
      bar.querySelector('[data-act="insert-before"]').onclick = () => {
        insertBlock(idx, makeTextBlock(''));
      };
      bar.querySelector('[data-act="insert-after"]').onclick = () => {
        insertBlock(idx + 1, makeTextBlock(''));
      };
      wrap.appendChild(bar);
      block.el.querySelector('.photo-x').onclick = () => removeBlock(idx);
      block.el.querySelector('img').onclick = () => {
        const url = block.previewUrl || memorialPhotoUrl(block.photoId);
        if (url) openLightbox(url, block.name);
      };
    }
    host.appendChild(wrap);
  }
  // An empty document still needs one text block to type into.
  if (pageState.blocks.length === 0) {
    pageState.blocks.push(makeTextBlock(''));
    renderBlocks();
    return;
  }
  // The textareas only have a measurable height once they're in the DOM.
  for (const b of pageState.blocks) {
    if (b.type === 'text') autoGrow(b.el);
  }
  updateBlockHints();
}

// Insert an image at the caret of a text block, splitting it so the text
// before the caret stays above the image and the text after stays below.
async function insertImageAfterTextBlock(textBlock, file) {
  const idx = pageState.blocks.indexOf(textBlock);
  if (idx < 0) return;
  const ta = textBlock.el;
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, caret);
  const after = ta.value.slice(caret);

  // The upper half keeps the text before the caret.
  textBlock.el.value = before;
  // The image goes right after it.
  const tempId = 'pending-' + Date.now() + '-' + (++blockSeq);
  const previewUrl = await fileToDataUrl(file);
  pageState.pendingPhotos.push({ file, tempId });
  pageState.blocks.splice(idx + 1, 0, makeImageBlock(tempId, file.name, previewUrl));
  // The lower half holds the text that was after the caret.
  pageState.blocks.splice(idx + 2, 0, makeTextBlock(after));
  renderBlocks();

  // Put the caret in the lower half so the user keeps typing where they
  // left off.
  const newTa = pageState.blocks[idx + 2].el;
  newTa.focus();
  newTa.setSelectionRange(0, 0);
}

// The per-block hint line: shows the photo count and the "add image"
// affordance next to the text.
function updateBlockHints() {
  const total = pageState.blocks.filter((b) => b.type === 'image').length;
  const hint = document.getElementById('diary-photo-hint');
  if (hint) hint.textContent = total > 0 ? `共 ${total} 张图片` : '';
}

// ---- Page ----------------------------------------------------------------

// Exported so the test harness (scripts/test-diary-editor.js) can drive
// the editor directly, the way the router does.
export async function render(args, params) {
  const app = document.getElementById('app');
  const isNew = !args.id;
  pageState.isNew = isNew;
  pageState.eventId = isNew ? null : args.id;
  pageState.selectedContactIds = new Set();
  pageState.pendingPhotos = [];
  pageState.blocks = [];
  pageState.existingPhotos = [];
  // The back link and the post-save navigation follow the page the user
  // actually came from; the memorial list is the fallback.
  pageState.returnTo = getReferrerPath() || MEMORIAL_LIST_ROUTE;

  let ev = {
    kind: 'other',
    title: '',
    notes: '',
    place: '',
    food: '',
    outfit: '',
    activities: '',
    occurred_at: '',
    background: DEFAULT_THEME_ID,
    content: null,
    contact_ids: [],
    photos: [],
  };
  if (!isNew) {
    ev = await api.memorialEvents.get(args.id);
    if (!ev) {
      app.innerHTML = `<div class="empty">这篇回忆不存在或已被删除。</div>`;
      return;
    }
    pageState.existingPhotos = ev.photos || [];
    for (const cid of (ev.contact_ids || [])) pageState.selectedContactIds.add(cid);
  }
  if (params.contact_id) pageState.selectedContactIds.add(params.contact_id);

  const contacts = await api.contacts.list();
  const theme = getDiaryTheme(ev.background || DEFAULT_THEME_ID);
  pageState.background = theme.id;

  const occurredLocal = ev.occurred_at
    ? (ev.occurred_at.length >= 16 ? ev.occurred_at.slice(0, 16) : ev.occurred_at)
    : nowDatetimeLocal();

  const themeVars = diaryThemeVars(theme);

  app.innerHTML = `
    <div class="row between diary-topbar">
      <a class="inline-link" href="#${escapeHtml(pageState.returnTo)}">← 返回列表</a>
      <div class="row" style="gap:8px;">
        ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
        <button class="btn" id="save">保存</button>
      </div>
    </div>

    <div class="diary-layout">
      <!-- The writing surface. Its colors come from the CSS variables the
           theme writes inline, so switching the background repaints the
           page without a re-render. -->
      <div class="diary-page" id="diary-page"
           style="${Object.entries(themeVars).map(([k, v]) => `${k}:${v}`).join(';')}">
        <div class="diary-page-header">Tackbox</div>
        <div class="diary-page-body">
          <input type="text" id="diary-title" class="diary-title" maxlength="120"
                 placeholder="标题" value="${escapeHtml(ev.title || '')}" autofocus/>
          <div class="diary-meta-row">
            <input type="datetime-local" id="diary-occurred" value="${escapeHtml(occurredLocal)}"/>
            <span class="diary-date-hint" id="diary-date-hint"></span>
          </div>

          <!-- The mixed document: text blocks and image blocks, interleaved
               in the order the user arranged them. -->
          <div class="diary-blocks" id="diary-blocks"></div>

          <div class="diary-block-add">
            <input type="file" id="diary-photos" accept="image/*" multiple/>
            <button type="button" class="btn secondary btn-tiny" id="diary-add-photo">+ 添加图片</button>
            <span class="meta" id="diary-photo-hint"></span>
          </div>
        </div>
      </div>

      <!-- The side panel: background style and contacts. -->
      <aside class="diary-side">
        <section class="card diary-side-card">
          <h2>背景样式</h2>
          ${themePickerHtml(theme.id)}
        </section>
        <section class="card diary-side-card">
          <h2>关联联系人（可选）</h2>
          ${contactPickerHtml(contacts, pageState.selectedContactIds)}
        </section>
        <section class="card diary-side-card">
          <h2>图文混排</h2>
          <div class="meta">
            在文字中间点「插入图片」，图片会插到光标所在的位置；<br/>
            图片下方可以继续写文字，图文顺序按页面排列保存。
          </div>
        </section>
      </aside>
    </div>
  `;

  // Build the document from what was saved (or start empty).
  loadBlocks(ev);

  wireThemePicker();
  wireContactPicker(contacts);
  wirePhotoInput();
  wireDateInputs(app);

  document.getElementById('save').onclick = onSave;
  const delBtn = document.getElementById('del');
  if (delBtn) delBtn.onclick = onDelete;
}

// Rebuild the block list from a saved entry.
//
// `content` is the JSON document written by the diary editor. When it's
// missing (an entry written before the mixed editor existed) we fall back
// to a single text block holding the legacy `notes` body, so old entries
// open in the new editor without losing their text.
function loadBlocks(ev) {
  const blocks = [];
  let parsed = null;
  if (ev.content) {
    try {
      parsed = JSON.parse(ev.content);
    } catch (e) {
      console.error('diary content is not valid JSON:', e);
      parsed = null;
    }
  }
  if (Array.isArray(parsed) && parsed.length) {
    for (const b of parsed) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        blocks.push(makeTextBlock(typeof b.text === 'string' ? b.text : ''));
      } else if (b.type === 'image' && typeof b.photo_id === 'string') {
        const photo = pageState.existingPhotos.find((p) => p.id === b.photo_id);
        blocks.push(makeImageBlock(b.photo_id, photo ? photo.original_name : '', null));
      }
    }
  } else if (ev.notes) {
    blocks.push(makeTextBlock(ev.notes));
  }
  if (!blocks.length) blocks.push(makeTextBlock(''));
  pageState.blocks = blocks;
  renderBlocks();
}

// Repaint the writing surface when the user picks a different background.
function wireThemePicker() {
  const page = document.getElementById('diary-page');
  document.querySelectorAll('.diary-theme-tile').forEach((tile) => {
    tile.onclick = () => {
      const t = getDiaryTheme(tile.dataset.themeId);
      pageState.background = t.id;
      const vars = diaryThemeVars(t);
      for (const [k, v] of Object.entries(vars)) page.style.setProperty(k, v);
      document.querySelectorAll('.diary-theme-tile').forEach((el) => {
        el.classList.toggle('selected', el === tile);
      });
    };
  });
}

function wireContactPicker(contacts) {
  const picker = document.getElementById('diary-contact-picker');
  const countEl = document.getElementById('diary-contacts-count');
  if (!picker) return;

  function refresh() {
    picker.querySelectorAll('.contact-pick').forEach((el) => {
      el.classList.toggle('selected', pageState.selectedContactIds.has(el.dataset.id));
    });
    if (countEl) {
      countEl.textContent = pageState.selectedContactIds.size === 0
        ? '未选'
        : `已选 ${pageState.selectedContactIds.size} 人`;
    }
  }
  picker.querySelectorAll('.contact-pick').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.id;
      if (!id) return;
      if (pageState.selectedContactIds.has(id)) pageState.selectedContactIds.delete(id);
      else pageState.selectedContactIds.add(id);
      refresh();
    };
  });
  const allBtn = document.getElementById('diary-contacts-all');
  if (allBtn) allBtn.onclick = () => {
    contacts.forEach((c) => pageState.selectedContactIds.add(c.id));
    refresh();
  };
  const noneBtn = document.getElementById('diary-contacts-none');
  if (noneBtn) noneBtn.onclick = () => {
    pageState.selectedContactIds.clear();
    refresh();
  };
  refresh();
}

// ---- Photos --------------------------------------------------------------

// The text block whose "插入图片" button was clicked. When set, the next
// file pick is inserted AT THE CARET inside that block (splitting it);
// when null, the pick appends after the block the user is in.
let pendingInsertFor = null;

// The "+ 添加图片" button. The picked files are inserted into the
// document at the caret position of the text block the user was last in.
function wirePhotoInput() {
  const fileInput = document.getElementById('diary-photos');
  const addBtn = document.getElementById('diary-add-photo');

  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files || []);
    // Reset the input so picking the same file twice in a row still
    // fires a change event.
    fileInput.value = '';
    if (!files.length) return;

    if (pendingInsertFor) {
      // Split the text block at the caret and drop the image in between.
      const target = pendingInsertFor;
      pendingInsertFor = null;
      await insertImageAfterTextBlock(target, files[0]);
      // Extra files go after the first image, in pick order.
      for (let i = 1; i < files.length; i++) {
        const anchor = lastFocusedTextBlock();
        const idx = pageState.blocks.indexOf(anchor);
        const at = idx >= 0 ? idx + 1 : pageState.blocks.length;
        await addPendingImage(at, files[i]);
      }
      return;
    }

    // No explicit target: insert each file after the text block the user
    // is in (or after the last text block, when nothing is focused).
    let anchor = lastFocusedTextBlock();
    for (const f of files) {
      const idx = pageState.blocks.indexOf(anchor);
      const at = idx >= 0 ? idx + 1 : pageState.blocks.length;
      await addPendingImage(at, f);
      // Continue inserting after the image we just added, so multiple
      // files keep their pick order.
      anchor = pageState.blocks[at];
    }
    renderBlocks();
  };
  if (addBtn) addBtn.onclick = () => fileInput.click();
}

// Register a pending (not yet uploaded) photo and insert an image block
// for it at `index`.
async function addPendingImage(index, file) {
  const tempId = 'pending-' + Date.now() + '-' + (++blockSeq);
  const previewUrl = await fileToDataUrl(file);
  pageState.pendingPhotos.push({ file, tempId });
  insertBlock(index, makeImageBlock(tempId, file.name, previewUrl));
}

// The text block the user was last typing in. Falls back to the last
// text block in the document.
function lastFocusedTextBlock() {
  const active = document.activeElement;
  const found = pageState.blocks.find((b) => b.type === 'text' && b.el === active);
  if (found) return found;
  for (let i = pageState.blocks.length - 1; i >= 0; i--) {
    if (pageState.blocks[i].type === 'text') return pageState.blocks[i];
  }
  return null;
}

// ---- Serialize -----------------------------------------------------------

// Turn the live blocks into the JSON document shape the server stores.
function serializeBlocks() {
  const out = [];
  for (const block of pageState.blocks) {
    if (block.type === 'text') {
      const text = block.el.value || '';
      if (text.length) out.push({ type: 'text', text });
    } else if (block.type === 'image') {
      out.push({ type: 'image', photo_id: block.photoId });
    }
  }
  return out;
}

// The plain-text body. The search index and the album export both read
// the `notes` column, so the document's words have to be mirrored there
// or a mixed-content diary would become unfindable.
function plainTextFromBlocks() {
  return pageState.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.el.value || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---- Save / delete -------------------------------------------------------

async function onSave() {
  const title = (document.getElementById('diary-title').value || '').trim();
  const body = plainTextFromBlocks();
  const occurredRaw = document.getElementById('diary-occurred').value;

  if (!title && !body) {
    toast('请至少填写标题或正文');
    return;
  }
  if (!occurredRaw) {
    toast('请填写发生时间');
    return;
  }

  const payload = {
    kind: 'other',
    title: title || '回忆事件',
    // The plain text lives in `notes` (search + album export read it);
    // the interleaved document lives in `content`.
    notes: body || null,
    content: serializeBlocks(),
    occurred_at: occurredRaw.replace('T', ' ') + ':00',
    background: pageState.background,
    contact_ids: Array.from(pageState.selectedContactIds),
  };

  const saveBtn = document.getElementById('save');
  if (saveBtn) saveBtn.disabled = true;

  let saved;
  try {
    saved = pageState.isNew
      ? await api.memorialEvents.create(payload)
      : await api.memorialEvents.update(pageState.eventId, payload);
  } catch (e) {
    toast((e && e.message) || '保存失败');
    if (saveBtn) saveBtn.disabled = false;
    return;
  }

  // Upload the newly picked photos and rewrite the document so the
  // pending temp ids become real photo ids. Each upload is independent —
  // one failure doesn't roll the entry back — but we report a count so
  // the user knows something went wrong.
  const pending = pageState.pendingPhotos.slice();
  if (pending.length) {
    let okCount = 0;
    let failCount = 0;
    for (const p of pending) {
      if (p.file.size > 20 * 1024 * 1024) {
        toast(`照片 ${p.file.name} 超过 20MB，已跳过`);
        failCount += 1;
        continue;
      }
      try {
        const ab = await p.file.arrayBuffer();
        const photo = await api.memorialEvents.photos.upload(saved.id, {
          filename: p.file.name,
          mime: p.file.type,
          bytes: ab,
        });
        // Point the block at the saved photo.
        for (const block of pageState.blocks) {
          if (block.type === 'image' && block.photoId === p.tempId) {
            block.photoId = photo.id;
          }
        }
        okCount += 1;
      } catch (e) {
        console.error('photo upload failed:', e);
        failCount += 1;
      }
    }
    if (failCount > 0 && okCount === 0) toast(`照片上传失败（${failCount} 张）`);
    else if (failCount > 0) toast(`已上传 ${okCount} 张，${failCount} 张失败`);

    // Write the document again with the real photo ids.
    if (okCount > 0) {
      try {
        await api.memorialEvents.update(saved.id, { content: serializeBlocks() });
      } catch (e) {
        toast('图片顺序保存失败：' + ((e && e.message) || e));
      }
    }
  }

  // The pending photos are uploaded now, so the preview list is done.
  pageState.pendingPhotos = [];

  toast(pageState.isNew ? '已保存' : '已更新');
  navigate(pageState.returnTo);
}

async function onDelete() {
  if (!confirm('确认删除这篇回忆？\n\n关联的照片会一起被删除，此操作不可撤销。')) return;
  try {
    await api.memorialEvents.delete(pageState.eventId);
  } catch (e) {
    toast('删除失败：' + ((e && e.message) || e));
    return;
  }
  pageState.pendingPhotos = [];
  toast('已删除');
  navigate(pageState.returnTo);
}

register('/diary/new', render);
register('/diary/:id', render);
