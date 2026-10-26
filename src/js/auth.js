// src/js/auth.js — main-window PIN lock. Runs before router.start(); locks
// the body via `body.locked` and re-locks on every visibility restoration
// so right-click → "打开主窗口" always requires the PIN.
import { api, toast } from './api.js';

const PIN_LENGTH = 4;
let unlocked = false;
let pendingReminder = null;
let consecutiveFails = 0;

// ---- Public API ----
export function isUnlocked() { return unlocked; }

// Must be called BEFORE start() so a `main:open-reminder` IPC arriving while
// the user is on the PIN screen is captured rather than dispatched into a
// hidden modal. The actual modal pop reuses the existing
// `open-reminder` CustomEvent listener in src/js/main.js (line 112-118).
export function registerLockedEventHandlers() {
  api.on('main:open-reminder', (payload) => {
    if (unlocked) {
      window.dispatchEvent(new CustomEvent('open-reminder', { detail: payload }));
    } else {
      pendingReminder = payload;
    }
  });
}

// Lock the window. Idempotent; safe to call from visibilitychange / pageshow
// multiple times. Clears stale PIN input so a previously failed attempt
// doesn't linger visually.
export function lock() {
  document.body.classList.add('locked');
  unlocked = false;
  pendingReminder = null;
  const cells = document.querySelectorAll('#pin-cells .pin-cell');
  const errorEl = document.getElementById('pin-error');
  if (cells.length) {
    cells.forEach((c) => { c.value = ''; });
    errorEl.classList.add('hidden');
    cells[0].focus();
  }
  const btn = document.getElementById('pin-unlock');
  if (btn) btn.disabled = true;
}

// ---- Helpers ----
function focusCell(cells, idx) {
  if (idx < 0) idx = 0;
  if (idx >= PIN_LENGTH) idx = PIN_LENGTH - 1;
  cells[idx].focus();
  cells[idx].select();
}

function readPin(cells) {
  return cells.map((c) => c.value).join('');
}

function shake(cells, errorEl, msg) {
  cells.forEach((c) => { c.value = ''; });
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  const wrap = cells[0].parentElement;
  wrap.classList.remove('shake');
  // Force reflow so removing+re-adding `shake` re-triggers the animation
  // even when the previous attempt just finished.
  void wrap.offsetWidth;
  wrap.classList.add('shake');
  focusCell(cells, 0);
}

async function tryUnlock(cells, errorEl) {
  const pin = readPin(cells);
  if (pin.length !== PIN_LENGTH) return;
  let result;
  try {
    result = await api.app.verifyPin(pin);
  } catch (e) {
    shake(cells, errorEl, '验证失败：' + ((e && e.message) || e));
    return;
  }
  if (result && result.ok) {
    consecutiveFails = 0;
    unlocked = true;
    document.body.classList.remove('locked');
    // Replay any reminder event that arrived during the lock window.
    if (pendingReminder) {
      const p = pendingReminder;
      pendingReminder = null;
      // Defer one tick so the renderer's removal of `body.locked` paints
      // first — showReminderModal writes into the existing #reminder-modal
      // which is back in the normal layout chain once #app is visible.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('open-reminder', { detail: p }));
      }, 0);
    }
  } else {
    consecutiveFails += 1;
    if (consecutiveFails >= 5) {
      // No real lockout (4-digit space is too small for lockout to add
      // meaningful security) — just nag the user once. Continue counting
      // but don't show this toast on every subsequent failure.
      if (consecutiveFails === 5) {
        toast('密码错误次数过多，但仍可继续尝试。');
      }
    }
    shake(cells, errorEl, '密码错误，请重试。');
  }
}

// ---- Init: wire DOM events once. start() must run after #pin-modal is in
// the DOM (it's already in index.html, so this is safe at module load).
export function start() {
  const cells = Array.from(document.querySelectorAll('#pin-cells .pin-cell'));
  const errorEl = document.getElementById('pin-error');
  const unlockBtn = document.getElementById('pin-unlock');
  if (cells.length !== PIN_LENGTH || !errorEl || !unlockBtn) {
    console.error('[auth] PIN modal markup missing');
    return;
  }

  cells.forEach((cell, idx) => {
    cell.addEventListener('input', () => {
      // Sanitize: drop non-digits and cap at one char per cell.
      cell.value = (cell.value || '').replace(/\D/g, '').slice(0, 1);
      errorEl.classList.add('hidden');
      unlockBtn.disabled = readPin(cells).length !== PIN_LENGTH;
      if (cell.value && idx < PIN_LENGTH - 1) focusCell(cells, idx + 1);
      if (readPin(cells).length === PIN_LENGTH) tryUnlock(cells, errorEl);
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        if (!cell.value && idx > 0) {
          // Move back AND clear the previous cell so the user can retype.
          cells[idx - 1].value = '';
          focusCell(cells, idx - 1);
          e.preventDefault();
        } else if (cell.value) {
          // Default backspace behavior (clear current cell) — no preventDefault.
        }
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        focusCell(cells, idx - 1); e.preventDefault();
      } else if (e.key === 'ArrowRight' && idx < PIN_LENGTH - 1) {
        focusCell(cells, idx + 1); e.preventDefault();
      } else if (e.key === 'Enter') {
        tryUnlock(cells, errorEl);
      }
    });
    cell.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text') || '';
      const digits = text.replace(/\D/g, '').slice(0, PIN_LENGTH).split('');
      if (!digits.length) return;
      e.preventDefault();
      cells.forEach((c, i) => { c.value = digits[i] || ''; });
      unlockBtn.disabled = readPin(cells).length !== PIN_LENGTH;
      const last = Math.min(digits.length, PIN_LENGTH) - 1;
      focusCell(cells, last);
      if (digits.length === PIN_LENGTH) tryUnlock(cells, errorEl);
    });
    cell.addEventListener('focus', () => cell.select());
  });

  unlockBtn.addEventListener('click', () => tryUnlock(cells, errorEl));

  // ESC blurs the active cell — but does NOT close the modal. We never
  // want to give the user a way to bypass auth by dismissing the lock UI.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.activeElement
        && document.activeElement.classList
        && document.activeElement.classList.contains('pin-cell')) {
      document.activeElement.blur();
      e.preventDefault();
    }
  });

  // Re-lock on every "back to visible" transition. Covers:
  //   - cold open (DOM ready)
  //   - dev auto-show in main.js (`if (isDev) winMain.show()`)
  //   - right-click → "打开主窗口" → winMain.show()
  //   - any IPC that brings winMain forward (main:open-reminder, etc.)
  // pageshow fires on bfcache restore too, which doesn't apply to
  // Electron but costs nothing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') lock();
  });
  window.addEventListener('pageshow', () => lock());

  // First lock immediately so the renderer never paints unlocked content,
  // even briefly, on cold open / dev auto-show.
  lock();
}
