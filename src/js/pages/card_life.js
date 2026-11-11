// src/js/pages/card_life.js — 抽卡.
//
// The page draws one card a week. The pool it draws from is the official
// deck in `resources/intersting-list/list.md` (read by the main process —
// the renderer cannot read files) PLUS the cards the user added on this
// page, which live in the database.
//
//   * 未抽 → a deck of cards and a 「抽一张卡」 button;
//   * 已抽 → the card that was drawn, on a sheet of paper, with a
//     「记录这一张」 button that opens the 回忆 editor with the card's
//     title and requirement already filled in;
//   * 规则 → a card of its own, beside the drawn card, that spells the
//     game out;
//   * 我的专属卡片 → the user's own cards, in one list (capped at a few,
//     each with a delete button), and the button that adds another;
//   * a short history of the cards drawn before, so a card that was never
//     recorded can still be picked up days later.
//
// One draw per week is the rule, and it lives in the main process
// (main/card_draws.js) — the page only asks for a draw and shows what
// comes back.
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';
import { pageSlice, pagerHtml, wirePager } from '../pager.js';

// How many of the user's own cards one page of the list shows.
//
// The list is paginated rather than endless for the same reason the app's
// other lists are: a user with a hundred cards would otherwise get an
// unreadable scroll, and the list is drawn over the shared artwork — a
// page taller than the viewport shows only the top slice of a fixed
// picture. The pager under the list reaches the rest.
const CUSTOM_PAGE_SIZE = 3;

// The state of the page currently on screen. Kept at module scope so a
// redraw (after a draw) does not need a second round-trip.
const pageState = {
  state: null,
  // True while the drawn card is being put on screen, so the card can
  // play its entrance animation exactly once per draw.
  justDrew: false,
  // True while the 「添加卡片」 form is open. The form is hidden until the
  // button is clicked, so the page's default state is the card list.
  adding: false,
};

// Which page of the user's own cards is showing.
//
// It is a separate object from pageState because the shared pager
// (src/js/pager.js) reads and writes a `page` key on the state it is
// given — the same shape the other four paginated lists use. The index is
// a view state, not a URL state, so paging is not a history entry.
const customPager = { page: 0 };

async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  let state;
  try {
    state = await api.cardDraws.state();
  } catch (e) {
    console.error('could not load the card deck', e);
    app.innerHTML = `<div class="empty">卡库读取失败：${escapeHtml((e && e.message) || e)}</div>`;
    return;
  }
  pageState.state = state;

  app.innerHTML = `
    <div class="cl-page">
      <div class="cl-head">
        <h1>抽卡</h1>
        <span class="cl-head-heart" aria-hidden="true"></span>
        <span class="cl-head-tagline">每周给生活一点刺激</span>
      </div>

      ${state.deckError ? `<div class="cl-error">${escapeHtml(state.deckError)}</div>` : ''}

      <div class="cl-table">
        <div class="cl-stage" id="cl-stage">
          ${state.card ? cardHtml(state.card, state.weekLabel) : deckHtml(state)}
        </div>

        ${rulesHtml()}
      </div>

      ${checkinHtml(state)}

      ${customHtml(state)}

      ${historyHtml(state)}
    </div>
  `;

  wireStage();
  wireCustom();
}

// The stage holds either the deck (nothing drawn yet) or the card that
// was drawn. Only one of them is on screen at a time.
function deckHtml(state) {
  const canDraw = (state.totalSize || 0) > 0;
  return `
    <div class="cl-deck">
      <div class="cl-deck-stack" aria-hidden="true">
        <span class="cl-deck-card cl-deck-card--3"></span>
        <span class="cl-deck-card cl-deck-card--2"></span>
        <span class="cl-deck-card cl-deck-card--1">
          <span class="cl-deck-mark">?</span>
        </span>
      </div>
      <p class="cl-deck-text">
        ${canDraw ? '这一周还没有抽过。' : '卡池里还没有卡片。'}
      </p>
      <button class="btn cl-draw-btn" id="cl-draw" ${canDraw ? '' : 'disabled'}>
        抽一张卡
      </button>
    </div>
  `;
}

// The drawn card: its number, its title and its requirement — the same
// three things a deck card holds.
function cardHtml(card, weekLabel) {
  // Two different questions, and they are not the same:
  //
  //   recorded — is there an entry to LOOK AT? (the button offers to
  //              open it)
  //   done     — is that entry WRITTEN ENOUGH to count? (the rule the
  //              打卡墙 draws its squares from)
  //
  // An entry can exist and still be too thin to count — a title and
  // nothing else. That case says so, rather than claiming the card is
  // done.
  const recorded = !!card.memorial_event_id;
  const done = card.done === undefined ? recorded : !!card.done;
  const custom = card.source === 'custom';
  // The entrance animation plays once per draw — the flag is cleared as
  // the card is written, so a later visit does not replay it.
  const animate = pageState.justDrew;
  pageState.justDrew = false;
  // A custom card has no number in the official deck, so the counter
  // reads as "我的专属卡片" instead of an empty "第 号卡片".
  const counter = custom
    ? '<span class="cl-card-no">我的专属卡片</span>'
    : `<span class="cl-card-no">本周第 <b>${escapeHtml(card.card_no == null ? '?' : String(card.card_no))}</b> 号卡片</span>`;
  // The note under the card says where this week stands.
  const note = done
    ? '这张卡已经记录过了'
    : (recorded
      ? '已经写了一点，再补上照片或写长一点就算数'
      : '本周已抽取，下一周继续开启');
  return `
    <div class="cl-card${animate ? ' cl-card--in' : ''}">
      <span class="cl-card-clip" aria-hidden="true"></span>
      <div class="cl-card-head">
        <span class="cl-card-badge">
          <span class="cl-badge-star" aria-hidden="true"></span>
          本周挑战
        </span>
        ${counter}
      </div>
      <h2 class="cl-card-title">${escapeHtml(card.title || '(无标题)')}</h2>
      ${card.requirement ? `<p class="cl-card-req">${escapeHtml(card.requirement)}</p>` : ''}
      <div class="cl-actions">
        <button class="btn" id="cl-record">
          <span class="cl-btn-play" aria-hidden="true"></span>
          ${recorded ? '查看这篇回忆' : '记录这一张'}
        </button>
      </div>
      <p class="cl-card-note">${escapeHtml(note)} · 本周 ${escapeHtml(weekLabel || '')}</p>
    </div>
  `;
}

// ---- The 打卡墙 link ------------------------------------------------------
//
// The door to the check-in wall — the page that shows every week the user
// has drawn and how many of them were actually written down.
//
// It sits under the stage, next to the rules card, because it answers
// the question the rules card raises: 「完成后记录回忆」 — but the rules
// card says HOW, and this says HOW FAR ALONG you are.
//
// It is a link rather than a block of statistics because the statistics
// need room to breathe: the wall is a grid of weeks and a list, and
// cramming them into a corner of this page would make both unreadable.
function checkinHtml(state) {
  // The TOTAL number of weeks drawn — not the length of the page's own
  // history list, which is capped at a year. The door says how far the
  // user has got, so it must count the whole history.
  const weeks = state.totalDraws != null
    ? state.totalDraws
    : (state.history || []).length;
  return `
    <a class="cl-checkin" href="#/card-life/stats">
      <span class="cl-checkin-icon" aria-hidden="true"></span>
      <span class="cl-checkin-text">
        <span class="cl-checkin-title">打卡墙</span>
        <span class="cl-checkin-sub">${weeks
          ? `已经抽了 ${weeks} 周，看看完成了多少`
          : '抽过的每一周都会记在这里'}</span>
      </span>
      <span class="cl-checkin-arrow" aria-hidden="true">→</span>
    </a>
  `;
}

// ---- The rules ------------------------------------------------------------
//
// The drawn card is the prize; this card is the note that says how the
// game works. It sits BESIDE the drawn card — same row, half a step
// back — and is always there, so nobody has to guess why the button says
// 「抽一张卡」 and why it only works once a week.
//
// Each rule is just a title — the rules read as a short list of
// statements, so there is no explanation line under them.
function rulesHtml() {
  return `
    <section class="cl-rules">
      <div class="cl-rules-card">
        <div class="cl-rules-head">
          <span class="cl-rules-icon" aria-hidden="true"></span>
          <span class="cl-rules-title">抽卡规则</span>
        </div>
        <ol class="cl-rules-list">
          <li>
            <span class="cl-rule-title">每周只能抽取一张卡</span>
          </li>
          <li>
            <span class="cl-rule-title">官方卡片与自定义卡片混合</span>
          </li>
          <li>
            <span class="cl-rule-title">完成后记录回忆</span>
          </li>
        </ol>
        <p class="cl-rules-foot">已经抽取的卡片会保留在历史记录中。</p>
      </div>
    </section>
  `;
}

// ---- The user's own cards -------------------------------------------------
//
// The cards the user added. They live in the database, they are drawn from
// the same pool as the official deck, and each one can be deleted again —
// deleting one does not touch the cards already drawn from it.
//
// There is ONE list of them, under the heading 我的专属卡片. There used to
// be two — a preview above and a 「已添加的卡片」 table below — which meant
// the same cards were on the page twice, in two different shapes, and the
// user had to look in one place to add a card and another to delete one.
//
// The list is PAGINATED: it shows a fixed number of cards per page, with
// the app's shared pager underneath. A card is never hidden — it is one
// click of 「下一页」 away, and every card carries its own delete button,
// so any card can be deleted from any page.

function customHtml(state) {
  const cards = state.customCards || [];

  // Which slice of the cards the current page shows. The shared pager
  // does the maths and clamps the index, so deleting a card on the last
  // page cannot leave the list pointing past the end.
  const { total, totalPages, visible } = pageSlice(cards, customPager, CUSTOM_PAGE_SIZE);

  const list = cards.length
    ? `<div class="cl-custom-list">${visible.map(customCardHtml).join('')}</div>`
    : '<p class="cl-custom-empty">还没有添加自己的卡片。</p>';

  const form = pageState.adding ? customFormHtml() : '';

  return `
    <section class="cl-custom">
      <div class="cl-section">
        <div class="cl-section-head">
          <h2>
            <span class="cl-section-icon" aria-hidden="true"></span>
            我的专属卡片
          </h2>
          ${cards.length ? `<span class="cl-count">${cards.length} 张</span>` : ''}
        </div>
      </div>

      <div class="cl-custom-panel">
        ${list}
      </div>

      <div id="cl-custom-pager">
        ${pagerHtml(customPager.page, totalPages, total)}
      </div>

      <div class="cl-custom-addbar">
        ${pageState.adding ? '' : `
          <button type="button" class="cl-custom-add-btn" id="cl-custom-add">
            添加卡片
          </button>
        `}
      </div>

      ${form}

      <p class="cl-custom-hint">
        自己添加的卡片和官方卡库放在一起抽——每周抽到的卡，有可能是你写的这一张。
      </p>
    </section>
  `;
}

// One of the user's own cards.
//
// It carries a delete button, so a card can be thrown away from here
// without hunting for it anywhere else.
function customCardHtml(c) {
  return `
    <div class="cl-custom-card">
      <span class="cl-custom-icon" aria-hidden="true"></span>
      <div class="cl-custom-text">
        <div class="cl-custom-head">
          <p class="cl-custom-title">${escapeHtml(c.title || '(无标题)')}</p>
          <span class="cl-custom-tag">自定义卡片</span>
        </div>
        ${c.requirement
          ? `<p class="cl-custom-req">${escapeHtml(c.requirement)}</p>`
          : ''}
      </div>
      <button class="cl-custom-del cl-custom-del--preview" data-id="${escapeHtml(c.id || '')}"
              title="删除这张卡" aria-label="删除「${escapeHtml(c.title || '(无标题)')}」">
        <span class="cl-del-icon" aria-hidden="true"></span>
        删除
      </button>
    </div>
  `;
}

// The add form. It only exists while the user is adding a card.
function customFormHtml() {
  return `
    <form class="cl-custom-form" id="cl-custom-form">
      <input type="text" id="cl-custom-title" class="cl-custom-input" maxlength="120"
             placeholder="卡片标题，例如：给三个月后的自己写一封信"/>
      <textarea id="cl-custom-req" class="cl-custom-input" rows="2" maxlength="2000"
                placeholder="要求（可选）：这张卡要做什么"></textarea>
      <div class="cl-custom-form-actions">
        <button type="submit" class="cl-custom-submit" id="cl-custom-submit">保存卡片</button>
        <button type="button" class="cl-custom-cancel" id="cl-custom-cancel">取消</button>
      </div>
    </form>
  `;
}

// Wire the add form and the delete buttons.
function wireCustom() {
  // The 「＋ 添加卡片」 button opens the form. It sits under the list of
  // the user's own cards.
  const addBtn = document.getElementById('cl-custom-add');
  const openForm = async () => {
    if (pageState.adding) return;
    pageState.adding = true;
    await render();
    const titleEl = document.getElementById('cl-custom-title');
    if (titleEl) titleEl.focus();
  };
  if (addBtn) addBtn.onclick = openForm;

  // The cancel button closes the form again. Without it the form is a
  // one-way door: the 「添加卡片」 button is replaced by the form, so a
  // user who changes their mind has no way back.
  const cancelBtn = document.getElementById('cl-custom-cancel');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      pageState.adding = false;
      await render();
    };
  }

  const form = document.getElementById('cl-custom-form');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const titleEl = document.getElementById('cl-custom-title');
      const reqEl = document.getElementById('cl-custom-req');
      const title = (titleEl && titleEl.value || '').trim();
      const requirement = (reqEl && reqEl.value || '').trim();
      if (!title) {
        toast('先给这张卡写个标题');
        if (titleEl) titleEl.focus();
        return;
      }
      const submitBtn = document.getElementById('cl-custom-submit');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '保存中…'; }
      try {
        await api.cardDraws.customCreate({ title, requirement });
        pageState.adding = false;
        await render();
        toast('卡片已添加');
      } catch (err) {
        console.error('could not add the card', err);
        toast((err && err.message) || '添加失败');
        const btn = document.getElementById('cl-custom-submit');
        if (btn) { btn.disabled = false; btn.textContent = '保存卡片'; }
      }
    };
  }

  document.querySelectorAll('.cl-custom-del').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-id');
      if (!id) return;
      btn.disabled = true;
      try {
        await api.cardDraws.customDelete(id);
        await render();
        toast('卡片已删除');
      } catch (err) {
        console.error('could not delete the card', err);
        toast((err && err.message) || '删除失败');
        btn.disabled = false;
      }
    };
  });

  // The pager under the list. The page index lives in `customPager`; the
  // repaint re-renders the whole page, which also re-runs this wiring —
  // the pager's buttons are new nodes after every repaint.
  const pagerHost = document.getElementById('cl-custom-pager');
  if (pagerHost) {
    wirePager(
      pagerHost,
      customPager,
      async () => { await render(); },
      // Keep the user at the top of the new page of cards — otherwise they
      // land halfway down the page, looking at cards they already saw.
      // This runs BEFORE the repaint, which is what makes the scroll
      // stick: the repaint changes the content's height, and a scroll
      // set afterwards would be measured against the new content.
      () => {
        const scroller = document.querySelector('.content');
        if (scroller) scroller.scrollTop = 0;
      });
  }
}

// The cards drawn before, newest first.
//
// A card that was never recorded can still be written up — every row
// carries its own 记录 link, so a card from three weeks ago is not lost
// just because the week is over.
//
// The 「已记录 / 未记录」 verdict uses the SAME rule as the 打卡墙 — a
// week counts as recorded when its 回忆记录 has a photo or more than 30
// characters of text. It used to read the link alone, which meant this
// list could call a week 「已记录」 while the wall called the same week
// 「未完成」. Two pages answering the same question differently is worse
// than either answer, so they now share one rule
// (main/card_progress.js).
function historyHtml(state) {
  // This week's card is already on the stage — the list holds the older
  // ones only.
  const currentId = state.card && state.card.id;
  const history = (state.history || []).filter((h) => h.id !== currentId);
  if (!history.length) return '';
  const rows = history.map((h) => {
    // A card with no entry at all was never recorded. A card WITH an
    // entry counts only if that entry is written enough.
    const recorded = h.memorial_event_id
      ? (h.done === undefined ? true : !!h.done)
      : false;
    return `
    <div class="cl-history-row">
      <span class="cl-history-week">${escapeHtml(h.week_key || '')}</span>
      <span class="cl-history-title">${escapeHtml(h.title || '(无标题)')}</span>
      ${h.source === 'custom' ? '<span class="cl-history-mine">我的</span>' : ''}
      <span class="cl-history-state${recorded ? ' done' : ''}">
        ${recorded ? '已记录' : '未记录'}
      </span>
      ${h.memorial_event_id
        ? `<a class="cl-history-open" href="#/diary/${encodeURIComponent(h.memorial_event_id)}?draw=${encodeURIComponent(h.id)}">查看</a>`
        : `<a class="cl-history-open" href="#/diary/new?draw=${encodeURIComponent(h.id)}">记录</a>`}
    </div>
  `;
  }).join('');
  return `
    <section class="cl-history">
      <div class="cl-section">
        <div class="cl-section-head">
          <h2>
            <span class="cl-section-icon" style="--cl-section-icon: var(--icon-list);" aria-hidden="true"></span>
            抽过的卡
          </h2>
        </div>
      </div>
      <div class="cl-added">
        ${rows}
      </div>
    </section>
  `;
}

// Wire the stage's buttons. The handlers live here rather than inline so
// the markup stays readable.
function wireStage() {
  const drawBtn = document.getElementById('cl-draw');
  if (drawBtn) {
    drawBtn.onclick = async () => {
      drawBtn.disabled = true;
      drawBtn.textContent = '抽卡中…';
      try {
        const result = await api.cardDraws.draw();
        if (!result || !result.ok) {
          // The week already had a card — show it instead of complaining.
          if (result && result.card) {
            pageState.state = result.state;
            pageState.justDrew = false;
            await render();
            toast('本周已经抽过卡了');
            return;
          }
          toast((result && result.error) || '抽卡失败');
          drawBtn.disabled = false;
          drawBtn.textContent = '抽一张卡';
          return;
        }
        pageState.state = result.state;
        pageState.justDrew = true;
        await render();
        toast('抽到了！');
      } catch (e) {
        console.error('draw failed', e);
        toast((e && e.message) || '抽卡失败');
        const btn = document.getElementById('cl-draw');
        if (btn) { btn.disabled = false; btn.textContent = '抽一张卡'; }
      }
    };
  }

  const recordBtn = document.getElementById('cl-record');
  if (recordBtn) {
    recordBtn.onclick = () => {
      const card = pageState.state && pageState.state.card;
      if (!card) return;
      if (card.memorial_event_id) {
        // The card's id rides along, so that if the entry turns out to be
        // gone, the editor knows which card was meant and can write it
        // up instead of showing an error page.
        const q = `?draw=${encodeURIComponent(card.id)}`;
        navigate('/diary/' + encodeURIComponent(card.memorial_event_id) + q);
        return;
      }
      // The editor opens with the card's title and requirement filled in,
      // filed as 抽卡事件.
      navigate('/diary/new?draw=' + encodeURIComponent(card.id));
    };
  }
}

register('/card-life', render);
