// src/js/pages/card_life.js — 抽卡人生.
//
// The page draws one card a week. The pool it draws from is the official
// deck in `resources/intersting-list/list.md` (read by the main process —
// the renderer cannot read files) PLUS the cards the user added on this
// page, which live in the database.
//
//   * 未抽 → a deck of cards and a 「抽一张卡」 button;
//   * 已抽 → the card that was drawn, with a 「记录这一张」 button that
//     opens the 回忆事件 editor with the card's title and requirement
//     already filled in;
//   * 规则 → a card of its own that spells the game out;
//   * 我添加的卡片 → a form for the user's own cards, and the list of
//     them (each one can be deleted);
//   * a short history of the cards drawn before, so a card that was never
//     recorded can still be picked up days later.
//
// One draw per week is the rule, and it lives in the main process
// (main/card_draws.js) — the page only asks for a draw and shows what
// comes back.
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

const CARD_LIST_ROUTE = '/events/memorial';

// The state of the page currently on screen. Kept at module scope so a
// redraw (after a draw) does not need a second round-trip.
const pageState = {
  state: null,
  // True while the drawn card is being put on screen, so the card can
  // play its entrance animation exactly once per draw.
  justDrew: false,
};

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
    <div class="page-column">
      <div class="cl-page">
        <div class="cl-head">
          <h1>抽卡人生</h1>
          <p class="cl-sub">
            每周可以抽一张卡 · 本周 ${escapeHtml(state.weekLabel || '')}
            · 卡池 ${state.totalSize || 0} 张
            ${state.customCount ? `（官方 ${state.deckSize || 0} + 我的 ${state.customCount}）` : ''}
          </p>
        </div>

        ${state.deckError ? `<div class="cl-error">${escapeHtml(state.deckError)}</div>` : ''}

        <div class="cl-table">
          <div class="cl-stage" id="cl-stage">
            ${state.card ? cardHtml(state.card) : deckHtml(state)}
          </div>

          ${rulesHtml()}
        </div>

        ${customHtml(state)}

        ${historyHtml(state)}
      </div>
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
function cardHtml(card) {
  const recorded = !!card.memorial_event_id;
  const custom = card.source === 'custom';
  // The entrance animation plays once per draw — the flag is cleared as
  // the card is written, so a later visit does not replay it.
  const animate = pageState.justDrew;
  pageState.justDrew = false;
  return `
    <div class="cl-card${animate ? ' cl-card--in' : ''}">
      <div class="cl-card-head">
        <span class="cl-card-no">${escapeHtml(custom ? '自定义' : String(card.card_no == null ? '?' : card.card_no))}</span>
        <span class="cl-card-week">${escapeHtml(card.week_key || '')} 那一周</span>
      </div>
      <h2 class="cl-card-title">${escapeHtml(card.title || '(无标题)')}</h2>
      ${card.requirement ? `<p class="cl-card-req">${escapeHtml(card.requirement)}</p>` : ''}
      <div class="cl-actions">
        <button class="btn" id="cl-record">
          ${recorded ? '查看这篇回忆' : '记录这一张'}
        </button>
        <a class="btn secondary" href="#${CARD_LIST_ROUTE}">回忆事件</a>
      </div>
      ${recorded
        ? '<p class="cl-card-note">这张卡已经记录过了。</p>'
        : '<p class="cl-card-note">本周的卡已经抽过，下周一可以再抽。</p>'}
    </div>
  `;
}

// ---- The rules ------------------------------------------------------------
//
// The drawn card is the prize; this card is the note that says how the
// game works. It sits BESIDE the drawn card — same row, half a step
// back — and is always there, so nobody has to guess why the button says
// 「抽一张卡」 and why it only works once a week.
//
// It is a card of its own, but a quieter one than the card you draw: a
// dashed edge and a muted paper, so the two never look like rivals.
function rulesHtml() {
  return `
    <section class="cl-rules">
      <div class="cl-rules-card">
        <div class="cl-rules-head">
          <span class="cl-rules-badge">规则</span>
          <span class="cl-rules-title">抽卡人生怎么玩</span>
        </div>
        <ol class="cl-rules-list">
          <li>每周只能抽一张卡——一周从星期一开始算，抽过了就要等下个星期一；</li>
          <li>卡来自两个地方：官方卡库，和你在下面自己添加的卡片；两边放在一起随机抽，所以你写的那张也可能被抽到；</li>
          <li>抽到之后想写下来，点「记录这一张」，会跳到回忆事件的编辑器，标题和要求已经替你填好了；</li>
          <li>写完的回忆归到「抽卡事件」这一类，在回忆事件的列表里按「类型」就能筛出来；</li>
          <li>抽过的卡都留在下面的历史里，哪一周抽的、记没记过都写着，没记的随时可以补记。</li>
        </ol>
      </div>
    </section>
  `;
}

// ---- The user's own cards -------------------------------------------------
//
// The cards the user added. They live in the database, they are drawn from
// the same pool as the official deck, and each one can be deleted again —
// deleting one does not touch the cards already drawn from it.

function customHtml(state) {
  const cards = state.customCards || [];
  const rows = cards.map((c, i) => `
    <div class="cl-custom-row">
      <span class="cl-custom-no">${i + 1}</span>
      <span class="cl-custom-title">${escapeHtml(c.title || '(无标题)')}</span>
      ${c.requirement ? `<span class="cl-custom-req">${escapeHtml(c.requirement)}</span>` : ''}
      <button class="cl-custom-del" data-id="${escapeHtml(c.id || '')}" title="删除这张卡">删除</button>
    </div>
  `).join('');

  return `
    <section class="cl-custom">
      <h2>我添加的卡片${cards.length ? `（${cards.length} 张）` : ''}</h2>
      <form class="cl-custom-form" id="cl-custom-form">
        <input type="text" id="cl-custom-title" class="cl-custom-input" maxlength="120"
               placeholder="卡片标题，例如：给三个月后的自己写一封信"/>
        <textarea id="cl-custom-req" class="cl-custom-input" rows="2" maxlength="2000"
                  placeholder="要求（可选）：这张卡要做什么"></textarea>
        <button type="submit" class="btn cl-custom-add" id="cl-custom-add">添加卡片</button>
      </form>
      <p class="cl-custom-hint">
        自己添加的卡片和官方卡库放在一起抽——每周抽到的卡，有可能是你写的这一张。
      </p>
      ${cards.length
        ? `<div class="cl-custom-list">${rows}</div>`
        : '<p class="cl-custom-empty">还没有添加自己的卡片。</p>'}
    </section>
  `;
}

// Wire the add form and the delete buttons.
function wireCustom() {
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
      const addBtn = document.getElementById('cl-custom-add');
      if (addBtn) { addBtn.disabled = true; addBtn.textContent = '添加中…'; }
      try {
        await api.cardDraws.customCreate({ title, requirement });
        await render();
        toast('卡片已添加');
      } catch (err) {
        console.error('could not add the card', err);
        toast((err && err.message) || '添加失败');
        const btn = document.getElementById('cl-custom-add');
        if (btn) { btn.disabled = false; btn.textContent = '添加卡片'; }
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
}

// The cards drawn before, newest first.
//
// A card that was never recorded can still be written up — every row
// carries its own 记录 link, so a card from three weeks ago is not lost
// just because the week is over.
function historyHtml(state) {
  // This week's card is already on the stage — the list holds the older
  // ones only.
  const currentId = state.card && state.card.id;
  const history = (state.history || []).filter((h) => h.id !== currentId);
  if (!history.length) return '';
  const rows = history.map((h) => `
    <div class="cl-history-row">
      <span class="cl-history-week">${escapeHtml(h.week_key || '')}</span>
      <span class="cl-history-title">${escapeHtml(h.title || '(无标题)')}</span>
      ${h.source === 'custom' ? '<span class="cl-history-mine">我的</span>' : ''}
      <span class="cl-history-state${h.memorial_event_id ? ' done' : ''}">
        ${h.memorial_event_id ? '已记录' : '未记录'}
      </span>
      ${h.memorial_event_id
        ? `<a class="cl-history-open" href="#/diary/${encodeURIComponent(h.memorial_event_id)}">查看</a>`
        : `<a class="cl-history-open" href="#/diary/new?draw=${encodeURIComponent(h.id)}">记录</a>`}
    </div>
  `).join('');
  return `
    <section class="cl-history">
      <h2>抽过的卡</h2>
      ${rows}
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
        navigate('/diary/' + encodeURIComponent(card.memorial_event_id));
        return;
      }
      // The editor opens with the card's title and requirement filled in,
      // filed as 抽卡事件.
      navigate('/diary/new?draw=' + encodeURIComponent(card.id));
    };
  }
}

register('/card-life', render);
