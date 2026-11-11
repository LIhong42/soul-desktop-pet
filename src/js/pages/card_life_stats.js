// src/js/pages/card_life_stats.js — the 打卡墙 (the check-in wall).
//
// The 抽卡 page draws one card a week and asks the user to write it
// down. Before this page existed there was no way to look back: the
// 抽卡 page showed the current card and a flat list of the ones
// before it, and neither said whether those older cards had actually been
// written down. A user who drew for five weeks had no answer to "how
// many of those did I finish?"
//
// This page is that answer. It is a SEPARATE route (#/card-life/stats)
// rather than another block on the 抽卡 page, because it is a
// different kind of thing: the 抽卡 page is about THIS week's card
// and what to do with it, while this page is about the whole history.
//
// ---------------------------------------------------------------------------
// What it shows
// ---------------------------------------------------------------------------
//   * the totals — how many weeks were drawn, how many were finished, the
//     completion rate, and the current streak;
//   * the GRID — one square per week, newest at the top, filled when the
//     week was written down and empty when it was not. The grid is the
//     shape of the habit: a run of filled squares IS the streak, seen at a
//     glance;
//   * the CARD — clicking a square puts THAT week's card on the table,
//     drawn in exactly the same style as the 抽卡 page's own card.
//     One card, one place: the user clicks a square and sees the very
//     thing they would have seen had they drawn that card this week.
//
// There is deliberately NO table of weeks below the grid. A list of rows
// repeating "week, card, done" is the same information the grid already
// gives, in a slower shape — and it pushed the card itself off the page.
// The grid IS the index; the card IS the detail.
//
// ---------------------------------------------------------------------------
// Who decides what counts as finished
// ---------------------------------------------------------------------------
// Not this file. The rule — "written down means a 回忆记录 with a photo
// or more than 30 characters of text" — lives in the main process
// (main/card_progress.js), because it needs the diary's content document
// and the photo counts, and the renderer cannot read either. The renderer
// receives finished rows over IPC and draws them.
//
// So this file holds no threshold and no counting logic. If the rule
// changes, it changes in one place and every number here follows.

import { api, escapeHtml } from '../api.js';
import { register, navigate, getReferrerPath } from '../router.js';

// The 抽卡 page — where the grid's squares and the summary's numbers
// come from. It is also where the 「返回」 link goes when there is no
// referrer to go back to.
const CARD_LIFE_ROUTE = '/card-life';

// The state of the page currently on screen.
//
// `openId` is WHICH week's card is on the table. It starts empty — the
// wall opens on the grid alone, and the first square the user clicks
// decides what is on the table. It is a VIEW state, not a URL state.
const pageState = {
  data: null,
  // Which week's card is on the table. Null means none — the wall opens
  // with the grid on its own.
  openId: null,
  // Where the 「返回」 link goes.
  //
  // It is captured ONCE, when the page is first entered. The router
  // updates its "previous path" only AFTER a page's render resolves, so
  // asking for it again on a later repaint (after a square is clicked)
  // would return this page's OWN path — and the back link would point
  // at the wall the user is already looking at.
  backTo: CARD_LIFE_ROUTE,
};

// Load the summary and draw the page.
//
// `known` short-circuits the fetch: clicking a square changes only what
// is on the table, not the data behind it, so the wall re-draws from
// what it already has instead of asking the main process for the same
// rows again.
async function render(known) {
  const app = document.getElementById('app');

  let data = known;
  if (!data) {
    app.innerHTML = `<div class="empty">载入中…</div>`;
    try {
      data = await api.cardDraws.progress();
    } catch (e) {
      console.error('could not load the card progress', e);
      app.innerHTML = `<div class="empty">打卡记录读取失败：${escapeHtml((e && e.message) || e)}</div>`;
      return;
    }
  }
  pageState.data = data;

  app.innerHTML = `
    <div class="cl-page cl-stats-page">
      <a class="back-link cl-stats-back" href="#${escapeHtml(pageState.backTo)}">
        <span class="icon-arrow-left"></span>返回抽卡
      </a>

      <div class="cl-head">
        <h1>打卡墙</h1>
        <span class="cl-head-heart" aria-hidden="true"></span>
        <span class="cl-head-tagline">看看这段时间走了多远</span>
      </div>

      ${emptyHtml(data)}
      ${summaryHtml(data)}
      ${gridHtml(data)}
      ${cardHtml(data)}
    </div>
  `;

  wire();
}

// Where the 「返回」 link goes.
//
// The referrer is whatever page the user was on when they opened this
// one — usually the 抽卡 page, but the wall is linked from there and
// the user may have come from anywhere. When there is no referrer (the
// page was opened directly), it falls back to the 抽卡 page, which is
// the only page that makes sense to return to.
//
// This is read ONCE per visit, when the page is first entered — see the
// note on `pageState.backTo`.
function captureBackTo() {
  const ref = getReferrerPath();
  if (ref && ref !== '/card-life/stats') return ref;
  return CARD_LIFE_ROUTE;
}

// The empty state — the user has not drawn a card yet, so there is
// nothing to check in on.
//
// It says so plainly and points at the page that has the deck.
function emptyHtml(data) {
  if (data.weeks > 0) return '';
  return `
    <div class="cl-stats-empty">
      <p class="cl-stats-empty-text">还没有抽过卡。</p>
      <p class="cl-stats-empty-hint">去抽卡抽一张，这里就会记下每一周。</p>
      <a class="btn cl-stats-empty-btn" href="#${escapeHtml(CARD_LIFE_ROUTE)}">去抽卡</a>
    </div>
  `;
}

// ---- The summary ----------------------------------------------------------
//
// Four numbers: how many weeks were drawn, how many were written down,
// the rate, and the current streak.
//
// The streak gets its own tile because it is the number the user is
// actually playing for — the others describe the past, the streak is the
// thing still in motion.

function summaryHtml(data) {
  if (!data.weeks) return '';
  const tiles = [
    { label: '已抽周数', value: data.weeks, unit: '周' },
    { label: '完成', value: data.done, unit: '周' },
    { label: '完成率', value: data.rate, unit: '%' },
    { label: '连续完成', value: data.streak, unit: '周', accent: true },
  ];
  return `
    <section class="cl-stats-summary">
      ${tiles.map((t) => `
        <div class="cl-stats-tile${t.accent ? ' cl-stats-tile--accent' : ''}">
          <div class="cl-stats-tile-value">
            <b>${escapeHtml(String(t.value))}</b><span>${escapeHtml(t.unit)}</span>
          </div>
          <div class="cl-stats-tile-label">${escapeHtml(t.label)}</div>
        </div>
      `).join('')}
    </section>
  `;
}

// ---- The grid -------------------------------------------------------------
//
// One square per week, newest at the top.
//
// The grid is the point of the page: a run of filled squares IS the
// streak, and a gap in the row is a week that was skipped or left
// unfinished. Reading that off a table of text takes effort; reading it
// off a wall of squares takes none.
//
// Each square carries its week in the tooltip and the date below it, so
// the grid is legible without a legend. The square for the current week
// is marked, so a user who has not drawn yet this week can tell the
// difference between "not drawn" and "drawn but not written".
//
// Clicking a square puts that week on the table below.
function gridHtml(data) {
  if (!data.weeks) return '';
  const cells = data.entries.map((e) => `
    <div class="cl-stats-cell-wrap">
      <button type="button"
              class="cl-stats-cell${e.done ? ' done' : ''}${e.id === currentId(data) ? ' current' : ''}${e.id === pageState.openId ? ' open' : ''}"
              data-id="${escapeHtml(e.id || '')}"
              data-week="${escapeHtml(e.weekKey || '')}"
              title="${escapeHtml(`${e.weekLabel || e.weekKey || ''} · ${e.done ? '已完成' : '未完成'}`)}"
              aria-label="${escapeHtml(`${e.weekLabel || e.weekKey || ''} ${e.title || ''} ${e.done ? '已完成' : '未完成'}`)}">
        <span class="cl-stats-cell-mark" aria-hidden="true"></span>
      </button>
      <span class="cl-stats-cell-week">${escapeHtml(weekShort(e.weekKey))}</span>
    </div>
  `).join('');
  return `
    <section class="cl-stats-section">
      <div class="cl-section">
        <div class="cl-section-head">
          <h2>
            <span class="cl-section-icon" style="--cl-section-icon: var(--icon-calendar);" aria-hidden="true"></span>
            每周一格
          </h2>
          <span class="cl-count">${data.weeks} 周</span>
        </div>
      </div>
      <div class="cl-stats-grid" id="cl-stats-grid">
        ${cells}
      </div>
      <p class="cl-stats-legend">
        <span class="cl-stats-legend-item">
          <span class="cl-stats-legend-swatch done" aria-hidden="true"></span>已完成
        </span>
        <span class="cl-stats-legend-item">
          <span class="cl-stats-legend-swatch" aria-hidden="true"></span>未完成
        </span>
        <span class="cl-stats-legend-note">
          完成 = 写了一篇回忆记录（有照片，或正文超过 ${data.threshold} 字）
        </span>
      </p>
    </section>
  `;
}

// ---- The card on the table ------------------------------------------------
//
// The week the user clicked, drawn in the SAME style as the 抽卡
// page's card — the same paper, the same paperclip, the same badge, the
// same button.
//
// This is deliberate. The wall is a history, but a history the user can
// act on: click an empty square from three months ago and the card that
// was drawn that week comes back, with its requirement, and a button
// that takes you to write it up. The card does not become a museum
// piece because it is in the past — it is the same card, still open.
//
// Only ONE card is on the table at a time. The table holds the current
// card on the 抽卡 page; here it holds the week you are looking at.

function cardHtml(data) {
  const entry = openEntry(data);
  if (!entry) return '';

  const recorded = !!entry.memorialEventId;
  const done = !!entry.done;
  const custom = entry.source === 'custom';
  // A custom card has no number in the official deck, so the counter
  // reads as "我的专属卡片" instead of an empty "第 号卡片".
  const counter = custom
    ? '<span class="cl-card-no">我的专属卡片</span>'
    : `<span class="cl-card-no">第 <b>${escapeHtml(entry.cardNo == null ? '?' : String(entry.cardNo))}</b> 号卡片</span>`;
  // The note under the card says where this week stands.
  //
  // The wording matches the 抽卡 page's own note, so the two read as
  // one thing — but the week is named, because here it is a week in the
  // past and not the current one.
  const note = done
    ? '这张卡已经记录过了'
    : (recorded
      ? '已经写了一点，再补上照片或写长一点就算数'
      : '这一周还没有记录，去写一写');
  // Why it counts, or does not. The 抽卡 page has no room for this
  // (it shows one card, and the user knows whether they wrote it); on
  // the wall, a click can land on any week of any age, so the card
  // says what that week is holding.
  const reasons = [];
  if (entry.hasPhoto) reasons.push(`有 ${entry.photoCount} 张照片`);
  if (entry.textLength > 0) reasons.push(`正文 ${entry.textLength} 字`);
  if (!reasons.length) reasons.push('还没有写回忆记录');

  return `
    <section class="cl-stats-section cl-stats-card-section">
      <div class="cl-section">
        <div class="cl-section-head">
          <h2>
            <span class="cl-section-icon" style="--cl-section-icon: var(--icon-star);" aria-hidden="true"></span>
            这一周的卡
          </h2>
          <span class="cl-count">${escapeHtml(entry.weekLabel || entry.weekKey || '')}</span>
        </div>
      </div>
      <div class="cl-stage cl-stats-stage">
        <div class="cl-card cl-stats-card">
          <span class="cl-card-clip" aria-hidden="true"></span>
          <div class="cl-card-head">
            <span class="cl-card-badge">
              <span class="cl-badge-star" aria-hidden="true"></span>
              这一周的挑战
            </span>
            ${counter}
          </div>
          <h2 class="cl-card-title">${escapeHtml(entry.title || '(无标题)')}</h2>
          ${entry.requirement ? `<p class="cl-card-req">${escapeHtml(entry.requirement)}</p>` : ''}
          <div class="cl-actions">
            <button class="btn" id="cl-stats-record" data-id="${escapeHtml(entry.id || '')}">
              <span class="cl-btn-play" aria-hidden="true"></span>
              ${recorded ? '查看这篇回忆' : '记录这一张'}
            </button>
          </div>
          <p class="cl-card-note">${escapeHtml(note)} · ${escapeHtml(reasons.join(' · '))}</p>
        </div>
      </div>
    </section>
  `;
}

// The week whose card is on the table, or null when none is.
//
// `openId` may point at a week that is no longer in the data (a draw
// deleted elsewhere), so the lookup is by id and a miss is simply "no
// card on the table".
function openEntry(data) {
  const id = pageState.openId;
  if (!id) return null;
  const entries = (data && data.entries) || [];
  return entries.find((e) => e.id === id) || null;
}

// The week the grid marks as "the one you are working on".
//
// It is the newest draw — the card the user drew most recently, which is
// the one still waiting to be written down. Marking it tells an
// unfinished user that the empty square is the card in front of them,
// and not one they skipped months ago.
function currentId(data) {
  return data.entries.length ? data.entries[0].id : null;
}

// A short form of a week key, for the grid's captions: 'MM-DD'.
function weekShort(weekKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekKey || ''));
  return m ? `${m[2]}-${m[3]}` : '';
}

// ---- The route ------------------------------------------------------------

// The route handler.
//
// The router calls this whenever the page is entered. The page's own
// repaints (after a square is clicked) call `render()` directly instead,
// so this function is the ENTRY point and the place where the visit's
// state is set up.
//
// That matters for the back link: the referrer is only meaningful on
// entry. By the time the user clicks a square, the router's "previous
// path" is this page's own path.
async function enter() {
  pageState.backTo = captureBackTo();
  // A fresh visit starts with nothing on the table — the wall opens on
  // the grid alone, and the state is a leftover from the last visit
  // otherwise.
  pageState.openId = null;
  await render();
}

register('/card-life/stats', enter);

// ---- Wiring ---------------------------------------------------------------

function wire() {
  // The grid's squares put their week on the table.
  document.querySelectorAll('.cl-stats-cell').forEach((cell) => {
    cell.onclick = () => {
      const id = cell.getAttribute('data-id');
      if (!id) return;
      // Clicking the square that is already on the table closes it — the
      // wall returns to the grid alone.
      pageState.openId = pageState.openId === id ? null : id;
      // The data has not changed, so the wall re-draws from what it
      // already holds rather than fetching the same rows again.
      render(pageState.data).then(() => {
        if (!pageState.openId) return;
        const card = document.querySelector('.cl-stats-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    };
  });

  // The button on the card. It behaves exactly as the 抽卡 page's own
  // button does: with an entry it opens the entry, without one it opens
  // the editor with the card's title and requirement filled in.
  //
  // The entry's id is carried along as well, so that IF the entry is
  // gone by the time the editor opens, the editor knows which card the
  // user meant and can create the entry from it.
  const recordBtn = document.getElementById('cl-stats-record');
  if (recordBtn) {
    recordBtn.onclick = () => {
      const id = recordBtn.getAttribute('data-id');
      const entry = openEntry(pageState.data || {});
      if (!id || !entry) return;
      if (entry.memorialEventId) {
        const q = `?draw=${encodeURIComponent(entry.id)}`;
        navigate('/diary/' + encodeURIComponent(entry.memorialEventId) + q);
        return;
      }
      navigate('/diary/new?draw=' + encodeURIComponent(entry.id));
    };
  }
}
