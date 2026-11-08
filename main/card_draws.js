// main/card_draws.js — the 抽卡人生 deck and the weekly draw.
//
// The official deck lives in `resources/intersting-list/list.md` — a plain
// markdown file the user can edit without touching the app. Every
// `### NN. 标题` heading is one card; the `要求：…` lines under it are
// that card's requirement.
//
// The user can add cards of their own on the 抽卡人生 page. Those live in
// the database (main/db.js, `custom_cards`) rather than in a file, because
// they are data the app owns. A draw picks from BOTH pools, so a custom
// card can come up just like an official one.
//
// The rules that are NOT in the file live here:
//
//   * one draw per week — the week starts on Monday, local time;
//   * the drawn card is remembered, so the page can show it again after a
//     restart, and so the 记录 button still works days later.
//
// The storage lives in main/db.js (`card_draws`); this module only owns the
// deck, the calendar and the rules.

const fs = require('fs');
const path = require('path');

// The completion rule — "a week counts as written when its 回忆记录 has
// a photo, or more than 30 characters of text".
//
// It lives in its own module (main/card_progress.js) because the 打卡墙
// needs it too, and there must be ONE rule: the 抽卡人生 page's history
// list and the 打卡墙's squares answer the same question, and two pages
// answering it differently would be worse than either answer.
const cardProgress = require('./card_progress');

// Where the deck file lives. `appPath` is the app root (the parent of
// `main/`), matching how ui_artwork finds `resources/ui`.
function deckPath(appPath) {
  return path.join(
    appPath || path.join(__dirname, '..'),
    'resources', 'intersting-list', 'list.md');
}

// ---- The deck ------------------------------------------------------------

// Parse the markdown deck into cards.
//
// The file's shape is one card per section:
//
//     ### 01. 给一个曾经重要、如今失联的人写一封信
//
//     - 要求：给看到题目第一个想到的人写一封信。
//
// The number in the heading is the card's number, the rest of the heading
// line is its title, and the `要求：` lines are its requirement. A card
// without a requirement is legal — it simply has none.
//
// Returns `[]` when the file is missing or unreadable: a user who deleted
// the deck should see an empty deck, not a broken page.
function parseDeck(md) {
  if (!md || typeof md !== 'string') return [];
  const cards = [];
  const head = /^###[ \t]*(\d+)\.[ \t]*(.*)$/gm;
  const marks = [];
  let m;
  while ((m = head.exec(md))) {
    marks.push({
      no: Number(m[1]),
      title: m[2].trim(),
      markStart: m.index,
      bodyStart: head.lastIndex,
    });
  }
  for (let i = 0; i < marks.length; i++) {
    // A card's body runs until the NEXT heading starts.
    const end = i + 1 < marks.length ? marks[i + 1].markStart : md.length;
    const body = md.slice(marks[i].bodyStart, Math.max(marks[i].bodyStart, end));
    cards.push({
      no: marks[i].no,
      title: marks[i].title,
      requirement: extractRequirement(body),
    });
  }
  return cards;
}

// Pull the requirement out of a card's body.
//
// The lines look like `- 要求：…`; the bullet and the `要求：` prefix are
// stripped. A card whose body has no `要求：` prefix still has a
// requirement — it is the whole body — so the prefix is optional and a
// requirement can wrap over several lines.
function extractRequirement(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•·]\s*/, '').trim())
    .filter(Boolean);
  return lines
    .map((l) => l.replace(/^要求[：:]\s*/, '').trim())
    .join('\n')
    .trim();
}

// Read the deck from disk. Returns { cards, error }.
//
// The error is a human-readable string (not an Error) so the page can show
// it verbatim without a try/catch of its own.
function readDeck(appPath) {
  const file = deckPath(appPath);
  let md;
  try {
    md = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { cards: [], error: `卡库读取失败：${e.message}` };
  }
  const cards = parseDeck(md);
  if (!cards.length) {
    return { cards: [], error: '卡库是空的（resources/intersting-list/list.md）' };
  }
  return { cards, error: null };
}

// The whole pool a draw picks from: the official deck plus the cards the
// user added. Returns { cards, error }.
//
// The error only ever comes from the official deck — a missing or empty
// list.md is worth telling the user about, but the custom cards are still
// perfectly drawable, so the pool is returned either way.
//
// Every card in the pool carries where it came from:
//
//   source — 'deck' (list.md) or 'custom' (the user's own)
//   no     — the card's number in the official deck (null for a custom
//            card, which has no number)
//   refId  — the custom_cards row a custom card came from (null for an
//            official card)
function readPool(appPath, db) {
  const deck = readDeck(appPath);
  const cards = deck.cards.map((c) => ({
    no: c.no,
    title: c.title,
    requirement: c.requirement,
    source: 'deck',
    refId: null,
  }));
  const custom = db.listCustomCards();
  for (const c of custom) {
    cards.push({
      no: null,
      title: c.title || '',
      requirement: c.requirement || '',
      source: 'custom',
      refId: c.id,
    });
  }
  return { cards, error: deck.error };
}

// ---- The week ------------------------------------------------------------

function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The key of the week a date falls in: the Monday of that week, as
// 'YYYY-MM-DD'. Local time, so the week changes at the user's midnight and
// not at UTC's.
//
// `now` is injectable so the tests can pin the clock.
function weekKey(now = new Date()) {
  const day = (now.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  return ymd(monday);
}

// The Sunday that closes the week — used for the "本周" label.
function weekEndKey(now = new Date()) {
  const day = (now.getDay() + 6) % 7;
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (6 - day));
  return ymd(sunday);
}

// ---- The page's state ----------------------------------------------------

// Everything the 抽卡人生 page needs to draw itself:
//
//   weekKey / weekLabel — which week it is, and how it reads;
//   deckSize            — how many cards the official deck holds;
//   customCards         — the cards the user added, oldest first;
//   customCount         — how many of those there are;
//   totalSize           — the whole pool a draw picks from;
//   card                — this week's card (null when none was drawn);
//   history             — the cards drawn before, newest first.
function state(appPath, db, now = new Date()) {
  const key = weekKey(now);
  const deck = readDeck(appPath);
  const customCards = db.listCustomCards();
  // The history carries the completion verdict, so the page's 「已记录」
  // badge and the 打卡墙's squares cannot disagree about the same week.
  // The rule lives in main/card_progress.js — one copy, two pages.
  const withVerdict = (row) => {
    const v = cardProgress.evaluate(row);
    return { ...row, done: v.done, photo_count: v.photoCount, text_length: v.textLength };
  };
  // One query brings both the history and this week's card, each with
  // the completion verdict attached, so the card on the stage and the
  // square on the 打卡墙 never disagree about the same week.
  const rows = db.listCardDrawsWithProgress(53);
  const history = rows.slice(0, 52).map(withVerdict);
  const card = rows.find((r) => r.week_key === key);
  return {
    weekKey: key,
    weekLabel: `${key} ~ ${weekEndKey(now)}`,
    deckSize: deck.cards.length,
    deckError: deck.error,
    customCards,
    customCount: customCards.length,
    totalSize: deck.cards.length + customCards.length,
    card: card ? withVerdict(card) : null,
    history,
    // How many weeks have been drawn IN TOTAL. The history above is
    // capped at a year (52) because the page's list is a reading list,
    // not a ledger — but the 打卡墙's door says how far the user has got,
    // and that number must not stop at 52. The count is a plain COUNT,
    // so it costs nothing however long the history is.
    totalDraws: db.countCardDraws(),
  };
}

// Draw a card for the current week.
//
// One draw per week: when the week already has a card, the existing card
// comes back with `drawn: false` — the draw is not repeated, and the page
// shows the card that is already there.
//
// Returns { ok, card, reason }:
//
//   ok     — true when a NEW card was drawn, false when the week already
//            had one;
//   reason — 'drawn' | 'already_drawn' | 'empty_deck'.
function draw(appPath, db, now = new Date()) {
  const key = weekKey(now);
  const existing = db.getCardDrawByWeek(key);
  if (existing) return { ok: false, card: existing, reason: 'already_drawn' };

  const pool = readPool(appPath, db);
  if (!pool.cards.length) {
    return { ok: false, card: null, reason: 'empty_deck', error: pool.error };
  }
  // A card is picked at random from the whole pool — the official deck and
  // the user's own cards together. The deck is small enough that a
  // shuffle-and-take would behave the same, but the point of a draw is
  // that the user cannot predict which card comes up.
  const picked = pool.cards[Math.floor(Math.random() * pool.cards.length)];
  const card = db.createCardDraw({
    week_key: key,
    card_no: picked.no,
    title: picked.title,
    requirement: picked.requirement,
    source: picked.source,
    card_ref_id: picked.refId,
    drawn_at: db.nowStr(),
  });
  return { ok: true, card, reason: 'drawn' };
}

module.exports = {
  deckPath,
  parseDeck,
  extractRequirement,
  readDeck,
  readPool,
  weekKey,
  weekEndKey,
  state,
  draw,
};
