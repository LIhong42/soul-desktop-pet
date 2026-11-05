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
  const [todayView, state, bond, cozy, pets, portrait, importantDates] = await Promise.all([
    api.reminders.listTodayView(),
    api.pet.getState(),
    api.bond.getFullState(),
    api.bond.getCozySnapshot(),
    api.pet.list().catch(() => []),
    // A still picture of the pet in use, for the mood panel's portrait.
    // Null when the pet has no usable `default` variant — the panel then
    // falls back to the mood emoji.
    api.pet.getPortrait().catch(() => null),
    // Every important date the user added, for the 纪念日 carousel. A
    // failure here must not take the whole page down — the rest of the
    // dashboard is still worth showing, so the carousel degrades to empty.
    api.importantDates.listAll().catch(() => []),
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
          <span class="today-hero-date">今日 · ${today.getFullYear()}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}</span>
          <span class="today-hero-weekday">${weekday}</span>
        </h1>
      </div>

      <div class="today-section">
        <div class="today-section-head">
          <h2>桌宠状态</h2>
        </div>
        <div id="pet-status">${renderPetStatus(normalizeFromSnapshots(bond, cozy), petName, portrait)}</div>
      </div>

      <div class="today-section">
        <div class="today-section-head">
          <h2>纪念日</h2>
        </div>
        ${renderAnniversaryCarousel(importantDates)}
      </div>

      <div class="today-section">
        <div class="today-section-head">
          <h2>当前提醒</h2>
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
                <div class="lr-title">${escapeHtml(titleText)}</div>
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

  // The 纪念日 carousel is the one auto-rotating thing on the page, so it
  // gets its own wiring. `startAnniversaryRotation` is a no-op when there
  // is nothing to rotate (no dates, or a single card), which is also the
  // case where a rotation timer would be pure noise.
  startAnniversaryRotation(app);
}

// ---- 纪念日 carousel ------------------------------------------------------
//
// A horizontally scrolling strip of cards, one per important date the user
// added. The cards rotate on their own — the strip advances by one card
// every few seconds and then wraps back to the start.
//
// Why a carousel rather than a list: the whole point of this block is a
// glanceable "what's coming up" read. A list would push the rest of the
// dashboard down and the user would have to scroll past every date to find
// the reminders. A strip shows one date at a time, rotates through them,
// and keeps the page's vertical rhythm.
//
// Each card is ONE line, carrying four facts:
//   1. whose date it is (contact + label) — "妈妈 的生日"
//   2. the type — "生日" / "纪念日" / "忌日"
//   3. how long it has been — "至今 38 年" (only when the row has an
//      origin year; a row without one has no age to report)
//   4. how long until the next one — "还有 12 天"
//
// The facts are separated by a middot so the line reads as one sentence
// rather than four competing labels.

// The type of an important date, in the user's words. Mirrors the `kind`
// values stored in the `important_dates` table (see the edit form in
// important_date_detail.js).
const DATE_KIND_LABEL = {
  birthday: '生日',
  anniversary: '纪念日',
  deceased_date: '忌日',
  custom: '纪念日',
};

// A glyph per type, so a birthday and a 忌日 are told apart at a glance
// without reading the label. Matches the tone the 事件 page uses for the
// same idea (see categoryIcon() in api.js).
const DATE_KIND_ICON = {
  birthday: '🎂',
  anniversary: '💝',
  deceased_date: '🕯️',
  custom: '📅',
};

// The type → CSS accent key, used to tint the card's left strip. Shares
// the app's category palette (--cat-*) so a 生日 strip looks the same here
// as it does on the 事件 page.
const DATE_KIND_TONE = {
  birthday: 'birthday',
  anniversary: 'anniversary',
  deceased_date: 'memorial',
  custom: 'general',
};

// The kind label for a row. An unknown kind falls back to the generic
// 纪念日 rather than printing a raw enum value at the user.
function dateKindLabel(kind) {
  return DATE_KIND_LABEL[kind] || DATE_KIND_LABEL.custom;
}

// The countdown phrase. "就是今天" and "就在明天" read better than a
// bare number for the two cases the user cares about most; everything
// else is "还有 N 天".
function daysLeftPhrase(days) {
  if (days == null) return '';
  if (days === 0) return '就是今天';
  if (days === 1) return '就在明天';
  return `还有 ${days} 天`;
}

// The "how long since" phrase. Years are the unit that matters for a
// birthday or an anniversary, so that's what we count — a date with no
// origin year gets no clause at all.
//
// A year of 0 means the date's origin year IS the current year, so
// "至今 0 年" would be technically true and completely useless. The
// clause is dropped instead: for a first-year date the countdown alone
// says everything worth saying.
function yearsSincePhrase(years) {
  if (years == null || years <= 0) return '';
  return `至今 ${years} 年`;
}

// Render the carousel. Returns the empty state when the user has no
// important dates yet, so the section never renders as a bare heading.
function renderAnniversaryCarousel(dates) {
  const rows = (dates || []).filter(Boolean);
  if (rows.length === 0) {
    return `
      <div class="today-empty">
        <span class="today-empty-icon">📅</span>
        <div>
          <div>还没有添加纪念日。</div>
          <div class="today-empty-note">在联系人详情里添加生日或纪念日，这里会轮流展示。</div>
        </div>
      </div>
    `;
  }

  // One card per date. The cards are ordered by the backend (month, day),
  // so the strip reads as a calendar year rather than in insertion order.
  const cards = rows.map((row) => {
    const label = (row.label || '').trim() || dateKindLabel(row.kind);
    const who = (row.contact_name || '').trim();
    const kindLabel = dateKindLabel(row.kind);
    const tone = DATE_KIND_TONE[row.kind] || 'general';
    const icon = DATE_KIND_ICON[row.kind] || DATE_KIND_ICON.custom;
    // The three clauses of the line. The middle one is dropped when the
    // row has no origin year — "至今" with no number would be nonsense.
    const since = yearsSincePhrase(row.years_since);
    const until = daysLeftPhrase(row.days_until_next);
    // "谁的纪念日" — the contact's name, when there is one. An important
    // date always belongs to a contact in this schema, but the contact
    // may have been deleted since (the FK cascades the date away, so this
    // is defensive only) — the line still reads without it.
    const whoText = who ? `${who} 的` : '';
    const name = `${whoText}${label}`;
    // The date this card counts down to, as a tooltip. The card itself
    // stays one line; the exact date is the detail you want on hover.
    const nextDate = row.next_date || '';
    // The tail of the line is split in two: the type label (生日 / 纪念日)
    // stays in the soft ink, while the age and the countdown take the
    // accent — the countdown is the number the card exists to show, and
    // it should be the thing the eye lands on.
    //
    // The two spans are written with NO whitespace between them. The card
    // is a flex row, and whitespace between inline elements becomes an
    // anonymous flex item — the template's own indentation would show up
    // as extra gaps between the clauses, making the line look loosely
    // spaced and inconsistent from card to card. The separator spaces
    // are therefore written into the text itself.
    const kindText = kindLabel ? kindLabel + ' · ' : '';
    const statText = [since, until].filter(Boolean).join(' · ');
    return `
      <div class="card today-anniv-card" data-id="${escapeHtml(row.id || '')}" data-tone="${escapeHtml(tone)}" title="${escapeHtml(nextDate)}"><span class="today-anniv-icon">${escapeHtml(icon)}</span><span class="today-anniv-name">${escapeHtml(name)}</span><span class="today-anniv-kind">${escapeHtml(kindText)}</span><span class="today-anniv-stat">${escapeHtml(statText)}</span></div>
    `;
  }).join('');

  return `
    <div class="today-anniv" id="today-anniv">
      <div class="today-anniv-track" id="today-anniv-track">${cards}</div>
    </div>
    ${rows.length > 1 ? `
      <div class="today-anniv-dots" id="today-anniv-dots">
        ${rows.map((_, i) => `<button class="today-anniv-dot${i === 0 ? ' active' : ''}" data-index="${i}" aria-label="第 ${i + 1} 个纪念日"></button>`).join('')}
      </div>
    ` : ''}
  `;
}

// Auto-rotation. The strip advances by one card every `ROTATE_MS` and
// wraps around.
//
// The rotation is paused whenever the user is interacting with the strip:
// hovering it, focusing inside it, or scrolling it by hand. A carousel
// that yanks the content away while the user is reading it is the single
// most annoying thing a carousel can do — the timer restarts only after
// the user has been idle for a moment, so they always get a full beat to
// read whatever they were looking at.
//
// A single timer is kept at module scope rather than per-render, so
// navigating away from 今日 and back doesn't leave an orphaned interval
// running against a detached DOM node.
const ROTATE_MS = 5000;

let annivTimer = null;
let annivIndex = 0;

// The pause flag. Set by the hover/focus/scroll listeners and cleared by
// the idle timer, so the rotation resumes on its own a moment after the
// user lets go.
let annivPaused = false;
let annivResumeTimer = null;

function startAnniversaryRotation(app) {
  stopAnniversaryRotation();
  const root = app.querySelector('#today-anniv');
  const track = app.querySelector('#today-anniv-track');
  if (!root || !track) return;
  const cards = Array.from(track.querySelectorAll('.today-anniv-card'));
  // Nothing to rotate — a single card is already fully visible, and
  // rotating it would be a no-op that still burns a timer.
  if (cards.length < 2) return;

  const dots = Array.from(app.querySelectorAll('#today-anniv-dots .today-anniv-dot'));

  // True while the strip is being driven by the user rather than by the
  // rotation. It is set from the INPUT events — a wheel, a touch, a drag
  // on the scrollbar — and not from the `scroll` event, because the
  // rotation's own scrolling produces `scroll` events too, and there is
  // no way to tell those apart from the user's by looking at the
  // positions alone: the two can start from the same place and end up
  // crossing each other.
  //
  // The input events are unambiguous — a programmatic scroll never
  // produces a wheel or a touch.
  let userScrolling = false;

  // The index of the card currently at the left edge. Read off the
  // scroll position rather than tracked separately, so a manual scroll
  // by the user re-syncs it and the rotation continues from where they
  // left it instead of jumping back to a stale position.
  //
  // The same `scroll-padding-left` offset that `goTo` applies is added
  // back here, so the two agree on where a card sits.
  const currentIndex = () => {
    const left = track.scrollLeft;
    const padding = parseFloat(getComputedStyle(track).scrollPaddingLeft) || 0;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < cards.length; i++) {
      const dist = Math.abs(cards[i].offsetLeft - track.offsetLeft - padding - left);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  };

  // Move to a given card. `behavior: 'smooth'` animates the scroll so the
  // strip glides rather than jumps.
  const goTo = (i, smooth = true) => {
    const idx = ((i % cards.length) + cards.length) % cards.length;
    annivIndex = idx;
    const card = cards[idx];
    // `scrollLeft` is set from the card's offset within the track rather
    // than from a computed card width, so a card of any width (long
    // contact names, long labels) still lands flush at the left edge.
    //
    // The track's `scroll-padding-left` is subtracted, because that is
    // where the browser really snaps the card to: with the padding in
    // place the card sits that far off the edge, and a target that
    // ignored it would be a few pixels short every time.
    const padding = parseFloat(getComputedStyle(track).scrollPaddingLeft) || 0;
    const target = card.offsetLeft - track.offsetLeft - padding;
    if (typeof track.scrollTo === 'function') {
      // `behavior: 'auto'` means "whatever the CSS `scroll-behavior` says",
      // and the track says `smooth` — so 'auto' would animate too. Only
      // `instant` really jumps, and the first card has to appear without
      // a glide when the page is first rendered.
      track.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'instant' });
    } else {
      track.scrollLeft = target;
    }
    dots.forEach((d, di) => d.classList.toggle('active', di === idx));
  };

  // Pause while the user is engaged with the strip.
  const pause = () => {
    annivPaused = true;
    if (annivResumeTimer) { clearTimeout(annivResumeTimer); annivResumeTimer = null; }
  };
  // Resume a beat after the user stops interacting, so a hovered strip
  // doesn't start moving the instant the pointer leaves it.
  const resume = () => {
    if (annivResumeTimer) clearTimeout(annivResumeTimer);
    annivResumeTimer = setTimeout(() => {
      annivPaused = false;
      annivResumeTimer = null;
      // The user has let go, so the strip is ours again.
      userScrolling = false;
    }, 1200);
  };

  root.addEventListener('mouseenter', pause);
  root.addEventListener('mouseleave', resume);
  root.addEventListener('focusin', pause);
  root.addEventListener('focusout', resume);

  // The user taking hold of the strip: a wheel, a touch, a drag on the
  // scrollbar, or a click on a card. None of these ever come from the
  // rotation, so they are a reliable signal that the strip is being
  // driven by hand.
  const userTookOver = () => {
    userScrolling = true;
    pause();
    resume();
  };
  track.addEventListener('wheel', userTookOver, { passive: true });
  track.addEventListener('touchstart', userTookOver, { passive: true });
  track.addEventListener('pointerdown', userTookOver, { passive: true });

  // Re-sync the index with whatever is at the left edge. This runs for
  // the rotation's own scrolling too, but that is harmless: the
  // rotation has already set the index to where it is heading, and the
  // card that is actually at the edge is the same one.
  track.addEventListener('scroll', () => {
    const idx = currentIndex();
    if (idx === annivIndex) return;
    annivIndex = idx;
    dots.forEach((d, di) => d.classList.toggle('active', di === idx));
    // A scroll the user started has to hold the rotation still until
    // they let go. The rotation's own scroll must not, or the carousel
    // would stop for a moment after every single tick.
    if (userScrolling) {
      pause();
      resume();
    }
  }, { passive: true });

  // Clicking a dot jumps straight to that card.
  dots.forEach((dot) => {
    dot.onclick = () => {
      const i = parseInt(dot.dataset.index, 10);
      if (Number.isFinite(i)) goTo(i);
    };
  });

  // Clicking a card opens the important date's detail page, so the user
  // can edit or delete it from the dashboard.
  cards.forEach((card) => {
    card.onclick = () => {
      const id = card.dataset.id;
      if (id) navigate('/important-dates/' + id);
    };
  });

  annivTimer = setInterval(() => {
    if (annivPaused) return;
    goTo(annivIndex + 1);
  }, ROTATE_MS);

  // Start on the first card without animating — the strip is already at
  // scroll position 0 on a fresh render.
  goTo(0, false);
}

// Tear the carousel's timers down. Called at the start of every render
// (a re-render replaces the DOM, so the old listeners and interval must
// not survive) and when the page is left.
function stopAnniversaryRotation() {
  if (annivTimer) { clearInterval(annivTimer); annivTimer = null; }
  if (annivResumeTimer) { clearTimeout(annivResumeTimer); annivResumeTimer = null; }
  annivPaused = false;
  annivIndex = 0;
}

// Live status subscription. Registered once at module load rather than per
// render: re-subscribing on every navigation would leak a listener each
// time (the returned unsubscribe would have to be threaded through the
// router). `applyStatus` no-ops when `#pet-status` is absent, so pushes
// that land while the user is on another page are simply dropped — the
// next `render()` refetches fresh numbers anyway.
api.on('pet:status-changed', (payload) => {
  applyStatus(payload);
});

// The user swapped the active pet (设置 → 桌宠). The mood panel's portrait
// shows THAT pet's picture, so it has to be swapped too — otherwise the
// page keeps showing the old pet until the user navigates away and back.
api.on('pet:pet-changed', () => {
  const portrait = document.querySelector('#pet-status .today-mood-portrait');
  if (!portrait) return;
  api.pet.getPortrait().then((url) => {
    // The page may have been navigated away while the request was in
    // flight — the element would no longer be the one we asked about.
    if (!portrait.isConnected) return;
    if (url) {
      portrait.innerHTML = `<img class="today-mood-image" src="${escapeHtml(url)}" alt="桌宠" />`;
    } else {
      // No portrait available for the new pet — fall back to the mood
      // glyph the portrait was rendered with before.
      const mood = (portrait.closest('.today-mood-card') || {}).dataset?.mood;
      const meta = MOOD_META[mood] || { icon: '🙂' };
      portrait.textContent = meta.icon;
    }
  }).catch(() => {});
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
    // NOTE: a bare `value` key is deliberately NOT consulted here.
    // Both the bond and the cozy snapshot carry one, and they mean
    // different things — bond's is 亲密度, cozy's is 舒适度. A fallback
    // to `s.value` is how 亲密度 once rendered the 舒适度 number and
    // then "jumped" to the real value on the first interaction repaint.
    // Every payload reaching this function must use the explicit
    // `bond_value` / `cozy` names.
    bondValue: s.bond_value != null ? (s.bond_value | 0) : 0,
    nextTier: s.next_tier || null,
    weekScore: s.week_score | 0 || 0,
    // 陪伴天数 — the number of distinct days on which the user interacted
    // with the pet. Monotonic: it only ever goes up.
    daysTogether: s.days_together != null ? (s.days_together | 0) : 0,
    cozy: s.cozy != null ? (s.cozy | 0) : 0,
    // 今日互动 — the number of cozy interactions the user made TODAY.
    // This used to read `state.count`, which is the count of *unhandled
    // reminders* — a completely different thing that happened to be the
    // only number the old status payload exposed. The real per-action
    // tally lives in `cozy_state.today_interactions` and is pushed as
    // `cozy_today_interactions`.
    todayInteractions: sumInteractions(s.cozy_today_interactions),
    lonelyHours: Math.floor((s.lonely_hours || 0)),
  };
}

// `cozy_today_interactions` is a JSON object like {pet:6, feed:1}. The
// 今日互动 tile wants the TOTAL number of interactions, so sum the
// per-action counts. A malformed payload reads as 0 rather than throwing —
// a broken counter must not take the whole 桌宠状态 panel down with it.
function sumInteractions(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  let total = 0;
  for (const v of Object.values(raw)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  return total;
}

// `normalizeStatus` needs the cozy-only fields, which `getFullState`
// flattens onto the same object as bond — so pass that half separately.
//
// `bond` here is the FLATTENED `getFullState` payload, so the 亲密度
// arrives as `bond_value` (there is deliberately no bare `value` key —
// it used to mean both numbers at once). `cozy` is the separate
// `getCozySnapshot` payload, where the 舒适度 is still called `value`
// because that snapshot holds exactly one number.
function normalizeFromSnapshots(bond, cozy) {
  return normalizeStatus({
    mood: bond && bond.mood,
    pet_id: bond && bond.pet_id,
    bond_tier: bond && bond.bond_tier,
    tier_label: bond && bond.tier_label,
    tier_floor: bond && bond.tier_floor,
    bond_value: bond && bond.bond_value,
    next_tier: bond && bond.next_tier,
    week_score: bond && bond.week_score,
    // 陪伴天数 lives on the COZY snapshot, not the bond one. Reading it
    // off `bond` left the tile at 0 on the first paint and only correct
    // after the first `pet:status-changed` push repainted it.
    days_together: cozy && cozy.days_together,
    cozy: cozy && cozy.value,
    cozy_today_interactions: cozy && cozy.today_interactions,
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

function renderPetStatus(st, petName, portrait) {
  const mood = st.mood;
  const pct = bondPct(st);
  const next = st.nextTier;
  const weekly = st.weekScore;
  const lonelyHours = st.lonelyHours;
  const moodMeta = MOOD_META[mood] || { label: '平静', icon: '🙂' };
  // The three 陪伴状态 columns: today's interactions, the cozy score, and
  // the number of days the user has spent with the pet.
  //
  // `todayInteractions` comes from the cozy engine's per-action tally
  // (`cozy_state.today_interactions`), NOT from the reminder queue's
  // active count — the two used to be conflated here, which made the
  // tile report pending reminders under an "interactions" label.
  const todayActions = st.todayInteractions;
  // The portrait shows the pet the user actually has installed, rather
  // than a generic emoji standing in for it. When there is no portrait
  // (a pet with no usable `default` variant), the mood emoji stands in —
  // the panel always shows *something*, and the mood still reads.
  const portraitInner = portrait
    ? `<img class="today-mood-image" src="${escapeHtml(portrait)}" alt="${escapeHtml(petName || '桌宠')}" />`
    : escapeHtml(moodMeta.icon);

  return `
    <div class="today-status-grid">
      <div class="card today-mood-card" data-mood="${escapeHtml(mood)}">
        <div class="today-panel-title">当前心情</div>
        <div class="today-mood-row">
          <div class="today-mood-portrait" data-bind="mood-icon">${portraitInner}</div>
          <div class="today-mood-text">
            <div class="today-mood-word" data-bind="mood-label">${escapeHtml(moodMeta.label)}</div>
            <div class="today-mood-note" data-bind="mood-note">${escapeHtml(moodNote(mood))}</div>
          </div>
        </div>
      </div>

      <div class="card today-bond-card">
        <div class="today-bond-head">
          <div class="today-panel-title" style="margin-bottom:0">关系成长</div>
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
        <div class="today-panel-title">陪伴状态</div>
        <div class="today-companion-stats">
          <div class="today-companion-cell">
            <div class="today-companion-text">
              <div class="today-companion-stack">
                <div class="today-companion-value" data-bind="today-actions">${todayActions}</div>
                <div class="today-companion-label">今日互动</div>
              </div>
            </div>
          </div>
          <div class="today-companion-cell">
            <div class="today-companion-text">
              <div class="today-companion-stack">
                <div class="today-companion-value" data-bind="cozy-value">${clampPct(st.cozy)}</div>
                <div class="today-companion-label">舒适度</div>
              </div>
              <div class="today-meter today-companion-bar">
                <div class="today-meter-fill" data-tone="cozy" data-bind="cozy-fill" style="width:${clampPct(st.cozy)}%"></div>
              </div>
            </div>
          </div>
          <div class="today-companion-cell">
            <div class="today-companion-text">
              <div class="today-companion-stack">
                <div class="today-companion-value"><span data-bind="days-together">${st.daysTogether}</span><small>天</small></div>
                <div class="today-companion-label">陪伴天数</div>
              </div>
            </div>
          </div>
        </div>
        <div class="today-companion-meta">
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
function applyStatus(raw) {
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
    // The portrait holds the pet's own picture, not a mood glyph — so it
    // must NOT be overwritten with the mood emoji here. It only gets the
    // mood emoji when there is no picture at all (the portrait element
    // then contains a text node instead of an <img>).
    if (icon && !icon.querySelector('img')) {
      icon.textContent = meta ? meta.icon : '🙂';
    }
    if (label) label.textContent = meta ? meta.label : '平静';
    if (note) note.textContent = moodNote(s.mood);
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
  const daysTogether = q('days-together');
  if (daysTogether) daysTogether.textContent = String(s.daysTogether);
  const todayActions = q('today-actions');
  if (todayActions) todayActions.textContent = String(s.todayInteractions);
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
//
// The mood is now a pure function of 舒适度 (cozy) — five moods, one per
// band of the cozy ladder. The `reminder` mood is gone: nagging about a
// reminder is a separate, already-visible thing (the reminder list right
// below), and folding it into the mood made the mood unreadable as
// "how does the pet feel".
const MOOD_META = {
  depressed:    { label: '有点低落', icon: '🥀' },
  sad:          { label: '难过',     icon: '😢' },
  missing_you:  { label: '想你陪',   icon: '🥱' },
  content:      { label: '平静',     icon: '🙂' },
  happy_clingy: { label: '黏人',     icon: '🥰' },
};

// One line of plain-language context under the mood. The pet's own bubble
// text isn't persisted, so this re-derives the short version from the same
// inputs the mood tree used.
function moodNote(mood) {
  switch (mood) {
    case 'depressed':    return '好久没人陪它了，去摸摸它吧';
    case 'sad':          return '舒适度见底了，喂点东西就好';
    case 'missing_you':  return '有点想你了，还想再靠近一点';
    case 'content':      return '一切正常，作息规律';
    case 'happy_clingy': return '状态很好，想一直跟着你';
    default:             return '一切正常，作息规律';
  }
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
