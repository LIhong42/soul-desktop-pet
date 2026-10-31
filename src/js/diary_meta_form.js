// src/js/diary_meta_form.js — the 回忆事件 metadata dialog.
//
// The diary editor (src/js/pages/diary_edit.js) is a writing surface: the
// title, the body and the photos live on one sheet of paper, and nothing
// else. The three pieces of metadata that are NOT part of the writing —
//
//   * 事件发生时间   when it happened
//   * 关联联系人     who was there
//   * 是否第一次     whether this was the first time
//
// — used to sit in the side panel next to the paper. They broke the
// promise of the page: the user had to reach for the right-hand column to
// finish an entry that was already written on the sheet.
//
// Now they live in a dialog that opens when the user presses 保存. The
// press on 保存 is the moment the entry becomes a record — a record has a
// time, a cast and a first-time flag — so that is where the questions are
// asked. The user writes first and answers second.
//
// The dialog is the ONE place these three values are edited, so it is also
// the one place their rules live:
//   * the time is required — a memory without a date cannot be filed;
//   * the contacts are optional and multi-select;
//   * 是否第一次 is a two-way choice, and the two-way choice is written
//     to the `kind` column ('first_time' / 'other').
//
// The dialog returns the values to the caller; it never saves anything
// itself. The editor keeps ownership of the save.

import { escapeHtml, displayName, nowDatetimeLocal, wireDateInputs } from './api.js';
import { MEMORIAL_KINDS, memorialKindLabel, normalizeMemorialKind } from './diary_kinds.js';

// The kind vocabulary lives in src/js/diary_kinds.js — the dialog is only
// one of the places that shows it (the 快速记录 form, the list card and the
// contact's event list are the others). It is re-exported here because the
// dialog is where the choice is made.
export { MEMORIAL_KINDS, memorialKindLabel, normalizeMemorialKind };

// ---- The contact picker --------------------------------------------------
//
// The same card-grid picker the side panel used, moved into the dialog.
// The toolbar (全选 / 清空 + a live count) comes with it, because a list
// of twenty contacts with no way to clear it is a chore.

function contactPickerHtml(contacts, selected) {
  if (!contacts.length) {
    return `<div class="meta">还没有联系人可选择</div>`;
  }
  return `
    <div class="contact-picker-toolbar">
      <button type="button" class="btn secondary btn-tiny" data-act="all">全选</button>
      <button type="button" class="btn secondary btn-tiny" data-act="none">清空</button>
      <span class="diary-meta-count" data-role="count"></span>
    </div>
    <div class="contact-picker diary-meta-contacts" data-role="picker">
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

// ---- The dialog ----------------------------------------------------------

// Open the metadata dialog.
//
// `opts`:
//   contacts    the contact list to pick from
//   occurredAt  the current value ('YYYY-MM-DD HH:MM:SS' or the
//               datetime-local shape)
//   kind        the current 是否第一次 value
//   contactIds  the currently selected contacts
//   onConfirm   called with { occurredAt, kind, contactIds } when the
//               user presses 确认. It may return a promise.
//   onCancel    called when the dialog is dismissed
//
// Returns a promise that resolves to the confirmed values, or to null if
// the user dismissed the dialog.
export function openMemorialMetaDialog(opts = {}) {
  const {
    contacts = [],
    occurredAt = null,
    kind = 'other',
    contactIds = [],
    onConfirm = null,
    onCancel = null,
  } = opts;

  const selected = new Set(contactIds || []);

  // The datetime-local input wants 'YYYY-MM-DDTHH:MM'. The stored value
  // is 'YYYY-MM-DD HH:MM:SS', so it is trimmed and re-joined here.
  const occurredLocal = occurredAt
    ? (String(occurredAt).length >= 16 ? String(occurredAt).slice(0, 16).replace(' ', 'T') : String(occurredAt))
    : nowDatetimeLocal();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop diary-meta-modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal diary-meta-modal" role="dialog" aria-modal="true" aria-label="保存回忆事件">
      <div class="modal-header">
        <h3>保存回忆事件</h3>
        <button type="button" class="icon-btn" data-act="cancel" title="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="diary-meta-field">
          <label class="diary-meta-label" for="diary-meta-occurred">事件发生时间</label>
          <input type="datetime-local" id="diary-meta-occurred" data-role="occurred"
                 value="${escapeHtml(occurredLocal)}"/>
        </div>

        <div class="diary-meta-field">
          <label class="diary-meta-label">是否第一次</label>
          <div class="diary-meta-radios" data-role="kind-row">
            ${MEMORIAL_KINDS.map((k) => `
              <label class="diary-meta-radio">
                <input type="radio" name="diary-meta-kind" value="${k.value}"
                       ${normalizeMemorialKind(kind) === k.value ? 'checked' : ''}/>
                <span>${escapeHtml(k.label)}</span>
              </label>
            `).join('')}
          </div>
        </div>

        <div class="diary-meta-field">
          <label class="diary-meta-label">关联联系人</label>
          ${contactPickerHtml(contacts, selected)}
        </div>
      </div>

      <!-- The buttons live in their own footer, OUTSIDE the scrolling
           body: a short window scrolls the questions, never the buttons
           that dismiss the dialog. -->
      <div class="modal-actions diary-meta-actions">
        <button type="button" class="btn" data-act="confirm">确认保存</button>
        <button type="button" class="btn secondary" data-act="cancel">取消</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  // The whole input opens its picker on a click, not just the trailing
  // icon — the same behaviour the inline side-panel field had.
  wireDateInputs(backdrop);

  const picker = backdrop.querySelector('[data-role="picker"]');
  const countEl = backdrop.querySelector('[data-role="count"]');

  function refresh() {
    if (picker) {
      picker.querySelectorAll('.contact-pick').forEach((el) => {
        el.classList.toggle('selected', selected.has(el.dataset.id));
      });
    }
    if (countEl) {
      countEl.textContent = selected.size === 0
        ? '未选'
        : `已选 ${selected.size} 人`;
    }
  }

  if (picker) {
    picker.querySelectorAll('.contact-pick').forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.id;
        if (!id) return;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        refresh();
      };
    });
  }

  backdrop.querySelector('[data-act="all"]')?.addEventListener('click', () => {
    contacts.forEach((c) => selected.add(c.id));
    refresh();
  });
  backdrop.querySelector('[data-act="none"]')?.addEventListener('click', () => {
    selected.clear();
    refresh();
  });
  refresh();

  return new Promise((resolve) => {
    let settled = false;

    function close(result) {
      if (settled) return;
      settled = true;
      backdrop.remove();
      if (result === null && onCancel) onCancel();
      resolve(result);
    }

    backdrop.querySelectorAll('[data-act="cancel"]').forEach((el) => {
      el.onclick = () => close(null);
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

    const confirmBtn = backdrop.querySelector('[data-act="confirm"]');
    confirmBtn.onclick = async () => {
      const raw = backdrop.querySelector('[data-role="occurred"]').value;
      if (!raw) {
        // The time is required — a memory without a date cannot be filed.
        // Keep the dialog open so the user can fill it in.
        backdrop.querySelector('[data-role="occurred"]').focus();
        return;
      }
      const occurred = raw.replace('T', ' ') + ':00';
      const kindValue = normalizeMemorialKind(
        backdrop.querySelector('input[name="diary-meta-kind"]:checked')?.value);
      const result = { occurredAt: occurred, kind: kindValue, contactIds: Array.from(selected) };
      if (onConfirm) {
        confirmBtn.disabled = true;
        try {
          await onConfirm(result);
        } finally {
          confirmBtn.disabled = false;
        }
      }
      document.removeEventListener('keydown', onKey);
      close(result);
    };
  });
}
