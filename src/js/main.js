// src/js/main.js — entry point, wires router, navigation active link, reminder modal, pet state pill
import { api, escapeHtml, fmtDateTime, toast } from './api.js';
import { register, onChange, navigate, start } from './router.js';
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
import './pages/diary_edit.js';
import './pages/tools.js';
import './pages/tool_video_frames.js';
import './pages/tool_transparent_png.js';
import './pages/tool_batch_resize.js';
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
    // The tooltip says what a click does, so the pill does not read as a
    // status label that happens to be clickable.
    pill.title = '桌宠正在提醒你 — 点击查看并处理';
  } else {
    pill.classList.remove('remind');
    text.textContent = '桌宠正常';
    pill.title = '查看桌宠状态';
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

// The pet pill is the way into the reminder UI.
//
// It shows the pet's live nag count ("桌宠提醒（1）"), so clicking it
// should do the obvious thing: open the reminder the pet is nagging about
// so it can be 完成 / 稍后 / 明天. With nothing pending it lands on 今日,
// where the reminder list and the pet's live status live.
//
// The pill used to be a plain <div>: it looked like a button and did
// nothing at all when clicked.
document.getElementById('pet-pill').onclick = async () => {
  try {
    // `listActive` returns the whole queue, including the items that were
    // already completed for today — those must not reopen a modal.
    const active = await api.reminders.listActive();
    const pending = (active || []).filter((r) => !r.dismissed_for_today);
    if (pending.length === 0) {
      navigate('/today');
      return;
    }
    showReminderModal(pending[0]);
  } catch (e) {
    console.error('[pill] could not open the reminder', e);
    navigate('/today');
  }
};

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