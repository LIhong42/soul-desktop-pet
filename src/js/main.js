// src/js/main.js — entry point, wires router, navigation active link, reminder modal, pet state pill
import { api, escapeHtml, fmtDateTime, toast } from './api.js';
import { register, onChange, start } from './router.js';
import { start as startAuth, registerLockedEventHandlers } from './auth.js';
import './pages/today.js';
import './pages/contacts_list.js';
import './pages/contact_detail.js';
import './pages/contact_edit.js';
import './pages/contact_list_edit.js';
import './pages/attributes.js';
import './pages/attribute_detail.js';
import './pages/important_date_detail.js';
import './pages/events.js';
import './pages/events_memorial.js';
import './pages/events_work.js';
import './pages/event_edit.js';
import './pages/tools.js';
import './pages/tool_video_frames.js';
import './pages/tool_transparent_png.js';
import './pages/settings.js';
import './pages/export.js';

function updateActiveLink(path) {
  document.querySelectorAll('.nav a').forEach((a) => {
    const r = a.getAttribute('data-route') || '';
    const match = (path === '/' && r === '/') ||
                  (path.startsWith(r) && r !== '/');
    a.classList.toggle('active', match);
  });
}

function updatePetPill(state) {
  const pill = document.getElementById('pet-pill');
  const text = document.getElementById('pet-pill-text');
  if (!pill) return;
  if (state && state.state === 'REMINDER') {
    pill.classList.add('remind');
    text.textContent = `桌宠提醒（${state.count}）`;
  } else {
    pill.classList.remove('remind');
    text.textContent = '桌宠正常';
  }
}

function showReminderModal(r) {
  const modal = document.getElementById('reminder-modal');
  const title = document.getElementById('reminder-title');
  const meta = document.getElementById('reminder-meta');
  const desc = document.getElementById('reminder-description');
  const actions = document.getElementById('reminder-actions');

  title.textContent = r.title || '提醒';
  meta.innerHTML = `
    <span class="tag">${r.source === 'event' ? '事件' : '重要日期'}</span>
    ${r.contact_name ? '关联联系人：' + escapeHtml(r.contact_name) : ''}
    · ${fmtDateTime(r.next_fire_at)}
  `;
  desc.textContent = r.description || '';

  actions.innerHTML = `
    <button class="btn" id="r-done">完成</button>
    <button class="btn secondary" id="r-snooze">稍后 30 分钟</button>
    <button class="btn secondary" id="r-snooze-1d">明天再提醒</button>
  `;
  modal.classList.remove('hidden');

  document.getElementById('r-done').onclick = async () => {
    // Soft-dismiss for today: pet stops nagging but the entry remains on
    // the 今日 page (with a "已完成" badge) so the user can still scroll
    // back and click through to the source event / important date.
    await api.reminders.completeForToday(r.source, r.source_id);
    modal.classList.add('hidden');
    toast('已标记完成（今日不再提醒）');
    location.reload();
  };
  document.getElementById('r-snooze').onclick = async () => {
    await api.reminders.snooze(r.source, r.source_id, 30);
    modal.classList.add('hidden');
    toast('30 分钟后再提醒');
  };
  document.getElementById('r-snooze-1d').onclick = async () => {
    await api.reminders.snooze(r.source, r.source_id, 60 * 24);
    modal.classList.add('hidden');
    toast('明天再提醒');
  };
}

document.getElementById('reminder-close').onclick = () => {
  document.getElementById('reminder-modal').classList.add('hidden');
};

// ---- 说句话 (pet right-click → 💬 说句话) ----
//
// The input lives here rather than in the pet window because the pet window
// is `focusable: false` — a <input> inside it can never receive the caret.
// (Neither Electron's native Menu nor dialog.showMessageBox can help: the
// former has no input item type, and `inputFieldType` doesn't exist until
// Electron 36 while this app runs 32.)
//
// Routed through the auth lock the same way reminders are: if the main
// window is PIN-locked the prompt is buffered rather than shown against a
// hidden DOM.
function showSayPrompt() {
  const modal = document.getElementById('say-modal');
  const input = document.getElementById('say-input');
  if (!modal || !input) return;
  input.value = '';
  modal.classList.remove('hidden');
  input.focus();
}

function closeSayPrompt() {
  const modal = document.getElementById('say-modal');
  if (modal) modal.classList.add('hidden');
}

async function submitSayPrompt() {
  const input = document.getElementById('say-input');
  const text = (input && input.value || '').trim();
  closeSayPrompt();
  if (!text) return;
  // The engine owns the bubble lifetime; sending the text back through it
  // (rather than broadcasting here) is what stops the next 1s tick from
  // overwriting the typed bubble with whatever rule happens to be due.
  try {
    await api.bubbles.say(text);
  } catch (e) {
    toast('发送失败：' + ((e && e.message) || e));
  }
}

document.getElementById('say-close').onclick = closeSayPrompt;
document.getElementById('say-cancel').onclick = closeSayPrompt;
document.getElementById('say-submit').onclick = submitSayPrompt;
document.getElementById('say-input').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitSayPrompt(); }
  if (e.key === 'Escape') { e.preventDefault(); closeSayPrompt(); }
};
document.getElementById('say-modal').onclick = (e) => {
  // Click the backdrop to dismiss, matching the other modals.
  if (e.target === e.currentTarget) closeSayPrompt();
};

window.addEventListener('open-say-prompt', showSayPrompt);

api.on('pet:state-changed', (payload) => {
  updatePetPill(payload);
  if (payload.state === 'NORMAL' && !document.getElementById('reminder-modal').classList.contains('hidden')) {
    document.getElementById('reminder-modal').classList.add('hidden');
  }
});

// Hand `main:open-reminder` over to the auth module — it buffers the event
// while the PIN modal is locked and replays it (via the CustomEvent below)
// once the user unlocks. Without this hop the reminder modal would pop
// against an empty DOM while the lock UI is on top.
registerLockedEventHandlers();

// Allow the main process (e.g. pet context menu) to push a hash route.
api.on('main:navigate', (path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return;
  // `/today` is also the default landing route, so a plain hash assignment
  // when we're already there is a no-op (no hashchange → no re-render) and
  // the "查看羁绊" menu item would look like it did nothing. Route through a
  // sentinel hash to force a real transition, then let the router's own
  // unknown-route fallback put us back on /today.
  if (path === '/today' && location.hash === '#/today') {
    location.hash = '#/__today';
    return;
  }
  location.hash = '#' + path;
});

// App-internal open-reminder (from home page click)
window.addEventListener('open-reminder', async (e) => {
  const { source, source_id } = e.detail;
  const active = await api.reminders.listActive();
  const r = active.find((x) => x.source === source && x.source_id === source_id)
            || active[0];
  if (r) showReminderModal(r);
});

onChange(updateActiveLink);

// Initial pet pill state
api.pet.getState().then(updatePetPill);

// Lock the window first (body.locked hides #app / .topbar). The router
// still mounts and the pet pill state still resolves — they're harmless
// behind the lock UI and they keep the renderer warm so unlock is instant.
startAuth();
start();