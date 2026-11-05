// src/js/pages/today.js — Today's reminders + the pet's live status.
//
// This page is also what the pet window's right-click menu item
// "📋 查看羁绊" navigates to (main/ipc.js → `main:navigate '/today'`), so
// the reminder list is joined by a 桌宠状态 block: mood, bond tier /
// 亲密度, cozy, weekly progress, and loneliness. Everything on this page
// comes from two composite snapshots so the renderer makes one round-trip
// per group instead of eight separate IPC calls.
import { api, escapeHtml, eventKindAttr, categoryIcon } from '../api.js';
import { register, navigate } from '../router.js';

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  // The background artwork is applied *before* the data loads so the page
  // doesn't flash the plain app surface and then repaint into the artwork.
  // The fetch can't fail in a way that matters: `applyBackground` catches
  // its own errors and leaves the page without artwork, which is the same
  // thing that happens on an install with no `resources/ui` folder.
  await applyBackground();

  // The "当前提醒" block drives off `listTodayView` so it covers every event
  // scheduled for today — not just the ones the scheduler has already fired.
  // This matches the user's mental model: anything I should remember today is
  // in this list, whether the pet has nagged me about it yet or not.
  // Soft-completed items are included too, so the user can scroll back to
  // see what they finished and click through to confirm.
  const [todayView, state, bond, cozy, pets] = await Promise.all([
    api.reminders.listTodayView(),
    api.pet.getState(),
    api.bond.getFullState(),
    api.bond.getCozySnapshot(),
    api.pet.list().catch(() => []),
  ]);

  const today = new Date();
  const m = today.getMonth() + 1;
  const d = today.getDate();
  // The weekday rides along with the date. A bare "今日 · 2026-11-05" tells
  // you the date but not the rhythm of the week — which day is the busy one
  // is exactly the thing a dashboard's header is there to say at a glance.
  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const weekday = WEEKDAYS[today.getDay()];
  // When the pet is not actively nagging (state !== 'REMINDER'), all of
  // today's reminder chips render muted. The user's mental model: a non-
  // nagging pet has nothing to surface, so the list rows act as a record
  // ("here's what was on the schedule today"), not an active nagger. The
  // per-row `dismissed_for_today` flag still drives the chip's color when
  // the pet IS in REMINDER state, so a pending reminder stays visually
  // distinct while the pet is actively firing.
  const forceMuted = (state && state.state) ? state.state !== 'REMINDER' : false;

  const petName = (() => {
    const cur = bond && bond.pet_id;
    const hit = (pets || []).find((p) => p.id === cur);
    return (hit && (hit.name || hit.manifest?.name)) || '';
  })();

  app.innerHTML = `
    <div class="today-page">
      <div class="today-hero">
        <h1 class="today-hero-title">
          <span class="today-hero-emoji">🗓️</span>
          <span class="today-hero-date">今日 · ${today.getFullYear()}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}</span>
          <span class="today-hero-weekday">${weekday}</span>
        </h1>
      </div>

      <div class="today-section">
        <div class="today-section-head">
          <h2><span class="today-section-emoji">🐾</span>桌宠状态</h2>
        </div>
        <div id="pet-status">${renderPetStatus(normalizeFromSnapshots(bond, cozy), state, petName)}</div>
      </div>

      <div class="today-section">
        <div class="today-section-head">
          <h2><span class="today-section-emoji">🔔</span>当前提醒</h2>
        </div>
        ${(() => {
          if (todayView.length === 0) {
            return `
              <div class="today-empty">
                <span class="today-empty-icon">✓</span>
                <div>
                  <div>今天没有待办事项，享受轻松时光。</div>
                  <div class="today-empty-note">一切安好，桌宠正陪着你。</div>
                </div>
              </div>
            `;
          }
          // The list is already sorted by the IPC handler: pending items
          // first, completed items last, each subgroup ordered by fire time.
          return `<div class="today-reminders">${todayView.map((r) => {
            const sourceLabel = r.source === 'event' ? '事件' : '重要日期';
            const contactName = r.contact_name || '';
            const completed = !!r.dismissed_for_today || forceMuted;
            // The chip tells the user *when* the reminder is due. For a date
            // that's counting down (a birthday with the advance window open)
            // it says how many days are left; everything else just says
            // "今日提醒".
            const chipLabel = r.days_left != null
              ? (r.days_left === 0 ? '就是今天' : r.days_left === 1 ? '就在明天' : `还有 ${r.days_left} 天`)
              : '今日提醒';
            // The card is a single line: just the event description (or a
            // contact-name / source fallback when description is empty). No
            // second "meta" row — duplicating the same text twice adds
            // visual noise and doesn't carry extra information for a
            // reminder the user already has context on.
            //
            // When the event HAS a description we show it alone (it's the
            // content the user wrote). When it doesn't, we fall back to the
            // title — but the title alone is often a generic auto-generated
            // label ("爷爷的提醒"), so we append the description when there
            // is one. See eventDisplayTitle() in api.js for the shared rule.
            const description = (r.description || '').trim();
            const titleText = r.source === 'event'
              ? (description ? description : (r.title || contactName || sourceLabel))
              : (r.title || contactName || sourceLabel);
            // Preserve the event's real category (general / work) so the edit
            // page opens the right form. important_date has no category — it
            // doesn't have an editable form anyway, so default to general.
            const dataCategory = r.category || 'general';
            // Glyph + tone: each event-typed reminder should look the same as
            // its entry on the 事件 page (🎂/💝/🎉/💼), so a birthday is
            // visually distinct from a work reminder. categoryIcon() and
            // eventKindAttr() are shared with events.js / event_edit.js, so the
            // colors stay in sync without us re-defining them here.
            const displayCategory = r.category || 'general';
            const tone = eventKindAttr({ category: r.category, tag_kind: r.tag_kind });
            const glyph = categoryIcon(displayCategory, r.tag_kind);
            return `
            <div class="card list-row clickable" data-kind="${escapeHtml(tone)}" data-source="${escapeHtml(r.source)}" data-id="${escapeHtml(r.source_id)}" data-action="reminder" data-completed="${completed}" data-category="${escapeHtml(dataCategory)}">
              <div class="lr-id">
                <span class="cat-icon" data-tone="${escapeHtml(tone)}">${escapeHtml(glyph)}</span>
              </div>
              <div class="lr-main">
                <div class="lr-title">${escapeHtml(titleText)}${r.tag_kind && tagKindLabel(r.tag_kind) ? ` <span class="tag" style="margin-left:6px">${escapeHtml(tagKindLabel(r.tag_kind))}</span>` : ''}</div>
              </div>
              <div class="lr-side">
                <div class="time-chip ${completed ? '' : 'urgent'}"><span class="chip-dot"></span>${chipLabel}</div>
              </div>
            </div>
          `}).join('')}</div>`;
        })()}
      </div>
    </div>
  `;

  app.querySelectorAll('.card.clickable').forEach((el) => {
    if (el.dataset.action === 'reminder') {
      el.onclick = () => {
        // The reminder view can include both queue-fired items and
        // not-yet-fired events scheduled for today. For both, the
        // "natural" interaction is to land on the source event's edit
        // form (or its detail route) rather than to risk popping the
        // reminder modal for the wrong item. The modal path is reserved
        // for the pet-window click flow, which already targets the
        // specific queue head by design.
        if (el.dataset.source === 'event') {
          navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
        } else {
          // Important dates don't have a standalone detail route in this
          // build; just open the events view so the user lands somewhere
          // useful instead of the modal for a different reminder.
          navigate('/events');
        }
      };
    } else {
      el.onclick = () => navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
    }
  });

  // Remember the latest reminder count so `applyStatus` can render the
  // mood note ("还有 N 件事等你处理") without re-querying pet state on
  // every push. `pet:state-changed` keeps it fresh while the user works.
  lastPetState = state;
}

// Live status subscription. Registered once at module load rather than per
// render: re-subscribing on every navigation would leak a listener each
// time (the returned unsubscribe would have to be threaded through the
// router). `applyStatus` no-ops when `#pet-status` is absent, so pushes
// that land while the user is on another page are simply dropped — the
// next `render()` refetches fresh numbers anyway.
let lastPetState = null;
api.on('pet:status-changed', (payload) => {
  applyStatus(payload, lastPetState);
});

// Keep the reminder count fresh for the mood note, and repaint while the
// 今日 page happens to be the one on screen.
api.on('pet:state-changed', (payload) => {
  lastPetState = payload;
  if (document.getElementById('pet-status')) {
    const moodEl = document.querySelector('#pet-status .today-mood-card[data-mood]');
    const note = moodEl && moodEl.querySelector('[data-bind="mood-note"]');
    const mood = moodEl && moodEl.dataset.mood;
    if (note && mood) note.textContent = moodNote(mood, payload);
    // 今日互动 counts the same day's interactions, so it moves with the
    // pet's state too.
    const actions = document.querySelector('#pet-status [data-bind="today-actions"]');
    if (actions && payload && typeof payload.count === 'number') {
      actions.textContent = String(payload.count);
    }
  }
});

// ---- 桌宠状态 block -----------------------------------------------------
//
// Three stat cards: mood, 羁绊 progression, and 陪伴 gauges. The block is
// rendered once into `#pet-status` and thereafter repainted in place by
// `applyStatus()` from `pet:status-changed` pushes, so feeding the pet
// updates the 舒适度 bar without re-fetching the whole page.
//
// Terminology note, because the two numbers are easy to confuse:
//   亲密度 (bond_value) — deep, long-term relationship strength. Only moves
//     via weekly settlement, so feeding does NOT change it. Shown as a
//     milestone ladder, not a fast-moving gauge.
//   舒适度 (cozy) — short-term contentment. Feeding / 玩耍 / 摸摸 move it
//     immediately, and it decays on its own over time. This is the number
//     the user can actually influence by interacting.

// Normalize the two snapshot shapes (getFullState vs the status push) into
// one object so `renderPetStatus` / `applyStatus` don't each have to know
// which source produced the numbers.
function normalizeStatus(src) {
  const s = src || {};
  return {
    mood: s.mood || 'content',
    pet_id: s.pet_id || null,
    tier: s.bond_tier != null ? (s.bond_tier | 0) : ((s.tier | 0) || 1),
    tierLabel: s.tier_label || '陌生',
    tierFloor: s.tier_floor | 0 || 0,
    bondValue: s.bond_value != null ? (s.bond_value | 0) : (s.value | 0) || 0,
    nextTier: s.next_tier || null,
    weekScore: s.week_score | 0 || 0,
    streak: s.streak_weeks | 0 || 0,
    cozy: s.cozy != null ? (s.cozy | 0) : (s.value != null && s.weekly_max == null ? (s.value | 0) : (c.value | 0)),
    lonelyHours: Math.floor((s.lonely_hours || 0)),
  };
}

// `normalizeStatus` needs the cozy-only fields, which `getFullState`
// flattens onto the same object as bond — so pass that half separately.
function normalizeFromSnapshots(bond, cozy) {
  return normalizeStatus({
    mood: bond && bond.mood,
    pet_id: bond && bond.pet_id,
    bond_tier: bond && bond.tier,
    tier_label: bond && bond.tier_label,
    tier_floor: bond && bond.tier_floor,
    bond_value: bond && bond.value,
    next_tier: bond && bond.next_tier,
    week_score: bond && bond.weekly_score,
    streak_weeks: bond && bond.streak_weeks,
    cozy: cozy && cozy.value,
    lonely_hours: cozy && cozy.lonely_hours,
  });
}

function bondPct(s) {
  // `next_tier` gives the absolute threshold for the next tier and
  // `tier_floor` the current tier's floor, so the bar fills the *span*
  // between them — a tier-6 pet at 8001 shows ~0% toward tier 7, not 100%.
  if (!s.nextTier) return 100; // already at max tier
  const span = Math.max(1, s.nextTier.threshold - s.tierFloor);
  return Math.max(0, Math.min(100, Math.round((s.bondValue - s.tierFloor) / span * 100)));
}

function renderPetStatus(st, state, petName) {
  const mood = st.mood;
  const pct = bondPct(st);
  const next = st.nextTier;
  const weekly = st.weekScore;
  const lonelyHours = st.lonelyHours;
  const moodMeta = MOOD_META[mood] || { label: '平静', icon: '🙂' };
  // The three 陪伴状态 reads the reference shows as icon-chip columns:
  // today's interactions, the cozy score, and the streak.
  const todayActions = (state && typeof state.count === 'number') ? state.count : 0;

  return `
    <div class="today-status-grid">
      <div class="card today-mood-card" data-mood="${escapeHtml(mood)}">
        <div class="today-panel-title"><span class="today-panel-emoji">💗</span>当前心情</div>
        <div class="today-mood-row">
          <div class="today-mood-portrait" data-bind="mood-icon">${escapeHtml(moodMeta.icon)}</div>
          <div class="today-mood-text">
            <div class="today-mood-word" data-bind="mood-label">${escapeHtml(moodMeta.label)}</div>
            <div class="today-mood-note" data-bind="mood-note">${escapeHtml(moodNote(mood, state))}</div>
          </div>
        </div>
      </div>

      <div class="card today-bond-card">
        <div class="today-bond-head">
          <div class="today-panel-title" style="margin-bottom:0"><span class="today-panel-emoji">🌱</span>关系成长</div>
          <div class="today-tier-pill"><span data-bind="tier-badge">T${st.tier}</span> · <span data-bind="tier-label">${escapeHtml(st.tierLabel)}</span></div>
        </div>
        <div class="today-bond-body">
          <div class="today-bond-number">
            <b data-bind="bond-value">${st.bondValue}</b>
            <span>亲密度</span>
          </div>
          <div class="today-bond-divider"></div>
          <div class="today-bond-progress">
            <div class="today-meter" data-bind="bond-meter" title="${next ? `距离下一等级还差 ${Math.max(0, next.threshold - st.bondValue)}` : '已达最高等级'}">
              <div class="today-meter-fill" data-tone="bond" data-bind="bond-fill" style="width:${pct}%"></div>
            </div>
            <div class="today-hint" data-bind="bond-note">${next ? `距离成为${escapeHtml(TIER_LABELS[next.tier] || ('T' + next.tier))}，还差 ${Math.max(0, next.threshold - st.bondValue)} 点` : '已经达到最高等级啦'}</div>
          </div>
        </div>
      </div>

      <div class="card today-wide">
        <div class="today-panel-title"><span class="today-panel-emoji">📊</span>陪伴状态</div>
        <div class="today-companion-stats">
          <div class="today-companion-cell">
            <div class="today-companion-icon" data-tone="cal">🗓️</div>
            <div class="today-companion-text">
              <div class="today-companion-value" data-bind="today-actions">${todayActions}</div>
              <div class="today-companion-label">今日互动</div>
            </div>
          </div>
          <div class="today-companion-cell">
            <div class="today-companion-icon" data-tone="cozy">😊</div>
            <div class="today-companion-text">
              <div class="today-companion-value" data-bind="cozy-value">${clampPct(st.cozy)}</div>
              <div class="today-companion-label">舒适度</div>
              <div class="today-meter today-companion-bar">
                <div class="today-meter-fill" data-tone="cozy" data-bind="cozy-fill" style="width:${clampPct(st.cozy)}%"></div>
              </div>
            </div>
          </div>
          <div class="today-companion-cell">
            <div class="today-companion-icon" data-tone="streak">⭐</div>
            <div class="today-companion-text">
              <div class="today-companion-value"><span data-bind="streak">${st.streak}</span><small>天</small></div>
              <div class="today-companion-label">连续陪伴</div>
            </div>
          </div>
        </div>
        <div class="today-companion-meta">
          <span class="today-heart">♥</span>
          <span data-bind="lonely">${lonelyHours > 0 ? `已经独处 ${lonelyHours} 个小时了，回来陪陪它吧` : '一直陪着你，关系慢慢成长。'}</span>
        </div>
      </div>
    </div>
  `;
}

// Cozy is a 0..100 score; clamp before it reaches a CSS width so a bad
// value can never make the bar overflow its track.
function clampPct(v) {
  return Math.max(0, Math.min(100, v | 0));
}

// Repaint the already-rendered 桌宠状态 block from a `pet:status-changed`
// payload. Patches text nodes and bar widths in place instead of
// re-rendering the block, so the CSS width transition animates and the
// reminder list below (which may be scrolled or mid-hover) is untouched.
function applyStatus(raw, state) {
  const host = document.getElementById('pet-status');
  if (!host) return;
  const s = normalizeStatus(raw);
  const q = (name) => host.querySelector(`[data-bind="${name}"]`);
  const moodEl = host.querySelector('.today-mood-card[data-mood]');

  // Mood: swap icon, label and the accent class in one shot.
  const meta = MOOD_META[s.mood];
  if (moodEl) {
    moodEl.dataset.mood = s.mood;
    const icon = q('mood-icon');
    const label = q('mood-label');
    const note = q('mood-note');
    if (icon) icon.textContent = meta ? meta.icon : '🙂';
    if (label) label.textContent = meta ? meta.label : '平静';
    if (note) note.textContent = moodNote(s.mood, state);
  }

  const badge = q('tier-badge');
  const tLabel = q('tier-label');
  const fill = q('bond-fill');
  const meterEl = q('bond-meter');
  const note = q('bond-note');
  const value = q('bond-value');
  const next = s.nextTier;
  if (badge) badge.textContent = 'T' + s.tier;
  if (tLabel) tLabel.textContent = s.tierLabel;
  if (value) value.textContent = String(s.bondValue);
  if (fill) fill.style.width = bondPct(s) + '%';
  if (meterEl) {
    meterEl.title = next
      ? `距离下一等级还差 ${Math.max(0, next.threshold - s.bondValue)}`
      : '已达最高等级';
  }
  if (note) {
    note.textContent = next
      ? `距离成为${TIER_LABELS[next.tier] || ('T' + next.tier)}，还差 ${Math.max(0, next.threshold - s.bondValue)} 点`
      : '已经达到最高等级啦';
  }

  // The 陪伴状态 columns. The cozy column carries both the number and the
  // bar, so both are patched from the same clamped value.
  const cozyValue = q('cozy-value');
  const cozyFill = q('cozy-fill');
  const cozyPct = clampPct(s.cozy);
  if (cozyValue) cozyValue.textContent = String(cozyPct);
  if (cozyFill) cozyFill.style.width = cozyPct + '%';
  const streak = q('streak');
  if (streak) streak.textContent = String(s.streak);
  const todayActions = q('today-actions');
  if (todayActions && state && typeof state.count === 'number') {
    todayActions.textContent = String(state.count);
  }
  const lonely = q('lonely');
  if (lonely) {
    lonely.textContent = s.lonelyHours > 0
      ? `已经独处 ${s.lonelyHours} 个小时了，回来陪陪它吧`
      : '一直陪着你，关系慢慢成长。';
  }
}

// Tier names for the "距 X 还差 N" hint. Mirrors TIER_LABELS in
// main/bond_engine.js — the snapshot carries `tier_label` for the *current*
// tier, but not for the one being climbed toward.
const TIER_LABELS = {
  1: '陌生', 2: '初识', 3: '朋友', 4: '挚友',
  5: '知己', 6: '灵魂伴侣', 7: '传说',
};

// Mirrors pet_mood.js's `computeMood` result keys. The main process owns
// the decision tree; this map only translates the resolved mood id into
// something a human can read.
const MOOD_META = {
  reminder:     { label: '在催你',   icon: '⏰' },
  depressed:    { label: '有点低落', icon: '🥀' },
  sad:          { label: '难过',     icon: '😢' },
  concerned:    { label: '有点担心', icon: '🤔' },
  lonely:       { label: '想你了',   icon: '🥺' },
  festive:      { label: '很开心',   icon: '🎉' },
  proud:        { label: '骄傲',     icon: '✨' },
  happy_clingy: { label: '黏人',     icon: '🥰' },
  missing_you:  { label: '想你陪',   icon: '🥱' },
  content:      { label: '平静',     icon: '🙂' },
};

// One line of plain-language context under the mood. The pet's own bubble
// text isn't persisted, so this re-derives the short version from the same
// inputs the mood tree used.
function moodNote(mood, state) {
  if (mood === 'reminder' && state) return `还有 ${state.count} 件事等你处理`;
  switch (mood) {
    case 'depressed':    return '好久没人陪它了，去摸摸它吧';
    case 'sad':          return '舒适度见底了，喂点东西就好';
    case 'concerned':    return '今天互动有点少，它注意到了';
    case 'lonely':       return '超过一天没一起玩了';
    case 'festive':      return '周末 + 高羁绊，今天值得庆祝';
    case 'proud':        return '今天你为它做了些什么';
    case 'happy_clingy': return '状态很好，想一直跟着你';
    case 'missing_you':  return '有点想你了，还想再靠近一点';
    default:             return '一切正常，作息规律';
  }
}

function tagKindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', festival: '节日' }[k]) || '';
}

// ---- 背景 (background artwork) --------------------------------------------
//
// The 今日 page paints the artwork from `resources/ui/` behind its content.
// The image is chosen in the main process (main/today_background.js) and
// arrives as a `file://` URL, because the renderer can't read the filesystem
// and the main window's CSP only allows `file:` in `img-src`.
//
// The artwork is decoration, so every failure path here degrades to "no
// artwork" rather than to a broken page: a missing IPC bridge, an install
// with no `resources/ui` folder, or a stored id naming a file this machine
// doesn't have all end the same way.

const contentEl = () => document.querySelector('.content');

// Paint the background onto the scroll container. `background-image` takes
// the URL, and the `no-art` class is dropped so the artwork shows again
// after the user turned it off and back on.
export async function applyBackground() {
  const el = contentEl();
  if (!el) return;
  try {
    const info = await api.todayBackground.get();
    const current = info && info.current;
    if (current && current.url) {
      el.style.setProperty('--today-bg-image', `url("${current.url}")`);
      el.classList.add('today-bg');
      el.classList.remove('no-art');
    } else {
      // The user turned the background off, or this install has no artwork.
      el.classList.add('today-bg', 'no-art');
      el.style.removeProperty('--today-bg-image');
    }
  } catch (e) {
    console.warn('[today] could not load the page background:', e);
    el.classList.add('today-bg', 'no-art');
    el.style.removeProperty('--today-bg-image');
  }
}

// Remove the background again when the user navigates to another page —
// only the 今日 page has one.
export function clearBackground() {
  const el = contentEl();
  if (!el) return;
  el.classList.remove('today-bg', 'no-art');
  el.style.removeProperty('--today-bg-image');
}

register('/today', render);
