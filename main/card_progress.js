// main/card_progress.js — the 抽卡 打卡墙 (the check-in wall).
//
// The 抽卡 page draws one card a week and the user is supposed to
// write the card down: a 回忆 with pictures and words. But the page
// only ever showed the CURRENT card and a flat list of the ones before
// it — there was no way to look back and see how many weeks had actually
// been completed, which weeks were missed, and what each week's card was.
//
// This module owns that answer. It turns the draws (main/db.js →
// `card_draws`) into a summary the page can draw:
//
//   * a per-week entry saying which card it was and whether it was
//     finished;
//   * the totals — how many weeks were drawn, how many were finished,
//     the completion rate;
//   * the streak — how many weeks in a row were finished.
//
// ---------------------------------------------------------------------------
// The completion rule
// ---------------------------------------------------------------------------
// A week counts as FINISHED when the user actually wrote the card down.
// "Wrote it down" means the 回忆 the card points at is a real entry,
// and it counts as written when EITHER of these holds:
//
//   * it has at least one photo attached   (图文并茂), or
//   * its text runs past 30 characters        (字够长).
//
// Either one is enough. The rule is deliberately generous about the
// second half: a user who wrote a genuine paragraph about the card has
// done the thing the game asks for, and holding their entry hostage over
// a photo upload is the kind of pedantry that makes a ritual fall apart.
//
// What counts as "text" is the entry's CONTENT DOCUMENT plus the five
// user-facing fields (notes / place / food / outfit / activities). The
// document is the modern editor's body — a JSON array of blocks — and it
// is where a long entry actually lives. The five fields are counted too
// because the editor's first screen asks for them, and a user who fills
// in 「地点 / 食物 / 穿着」 and writes a sentence has written the card
// down.
//
// The threshold is "more than 30 characters", so 30 is NOT enough and 31
// is. The count is of the trimmed strings, concatenated — so the
// characters a user can see are the characters that count.
//
// ---------------------------------------------------------------------------
// Why this lives in the main process
// ---------------------------------------------------------------------------
// The rule needs the diary content document, which is JSON, and the
// photo count, which is a table the renderer cannot read. The renderer
// receives plain rows over IPC and decides nothing — it draws what this
// module says.

'use strict';

const { parseDiaryContent } = require('./diary_content');

// How many characters a 回忆记录 needs before it counts as "written".
//
// The rule is "more than 30", so the threshold is exclusive: a 30
// character entry is not enough, a 31 character one is.
const TEXT_THRESHOLD = 30;

// The five user-facing text fields, in the order they are counted.
//
// The order does not matter for the total — the count is the length of
// everything concatenated — but it is fixed so the number is the same on
// every machine and in every run.
const TEXT_FIELDS = ['notes', 'place', 'food', 'outfit', 'activities'];

// The text of a 回忆记录, as one string.
//
// The content document comes first (it is the body the user typed) and
// the five fields follow. A document's text blocks are concatenated; a
// gallery block contributes nothing, because the photo it holds is
// already counted as a photo.
//
// The parts are joined with NOTHING between them, not with a newline.
// A separator would be a character the user never typed, and the count
// is meant to be the characters they can SEE — so the pieces are simply
// laid end to end. Each piece is trimmed, so a field the user left
// blank adds nothing at all.
//
// A document that fails to parse contributes nothing rather than
// throwing: a malformed body is a reason to count fewer characters, not
// a reason to break the whole page.
function textOf(row) {
  const parts = [];
  if (row && row.event_content) {
    for (const b of parseDiaryContent(row.event_content)) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        parts.push(b.text.trim());
      }
    }
  }
  for (const f of TEXT_FIELDS) {
    const key = `event_${f}`;
    const v = row ? row[key] : null;
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  return parts.join('');
}

// How many characters the entry's text runs to.
//
// Only the characters the user typed count. Whitespace inside a piece is
// kept — the user typed those too — but the pieces are trimmed at their
// edges, so a field that is blank, or padded with spaces, adds nothing.
function textLength(row) {
  return textOf(row).length;
}

// Is this draw finished?
//
// `row` is a row from listCardDrawsWithProgress(). A draw is finished
// when it points at a 回忆 AND that entry is written enough.
//
// Returns { done, hasPhoto, textLength, photoCount } — the parts, so the
// page can say WHY a week counts (a photo? a long text?) rather than
// only that it does.
function evaluate(row) {
  // The photo count comes out of a COUNT(*), so it is a number — but the
  // row may also have been built by hand (the tests do that), where it is
  // whatever the caller wrote. Number() handles both, and a value that is
  // not a number at all becomes 0 rather than NaN.
  const photoCount = Math.max(0, Number((row && row.photo_count) || 0) || 0);
  const hasEvent = !!(row && row.event_id);
  const len = textLength(row);
  const hasPhoto = photoCount > 0;
  return {
    // The rule: written down, with a picture or with enough words.
    done: hasEvent && (hasPhoto || len > TEXT_THRESHOLD),
    hasEvent,
    hasPhoto,
    photoCount,
    textLength: len,
  };
}

// The number of weeks in a row that were finished, counting back from the
// most recent draw.
//
// The streak counts CONSECUTIVE WEEKS, not consecutive entries: a user
// who skipped a week and then finished two in a row has a streak of one,
// because the week in between was not finished.
//
// The walk goes backwards from the newest entry and stops at the first
// week that breaks the chain — either a week that was not finished, or a
// gap in the weeks themselves (a week with no draw at all is not on the
// list, so the two weeks around it are not adjacent).
//
// The newest week is a special case: this week's card is being worked on
// right now, so it is usually NOT finished, and an unfinished current
// week must not zero out the run behind it. So the walk skips an
// unfinished newest week and keeps counting from the one before it.
function currentStreak(entries) {
  let streak = 0;
  let prevWeek = null;
  let seenOne = false;
  for (const e of entries) {
    // The newest entry, when it is unfinished, is simply stepped over —
    // the chain continues from the week before it. Its week key is still
    // remembered, because the week after it has to be adjacent to IT.
    if (!seenOne) {
      seenOne = true;
      prevWeek = e.weekKey;
      if (!e.done) continue;
      streak = 1;
      continue;
    }
    // Are the two weeks adjacent? If there is a gap, the streak ends.
    if (!adjacentWeeks(prevWeek, e.weekKey)) break;
    if (!e.done) break;
    streak += 1;
    prevWeek = e.weekKey;
  }
  return streak;
}

// The longest run of finished weeks anywhere in the history.
function longestStreak(entries) {
  const chrono = entries.slice().reverse(); // oldest first
  let best = 0;
  let run = 0;
  let prevWeek = null;
  for (const e of chrono) {
    if (prevWeek !== null && !adjacentWeeks(prevWeek, e.weekKey)) run = 0;
    if (e.done) run += 1;
    else run = 0;
    if (run > best) best = run;
    prevWeek = e.weekKey;
  }
  return best;
}

// Are two week keys ('YYYY-MM-DD', the Monday of the week) consecutive?
//
// Consecutive means the later one is exactly seven days after the earlier
// one. The dates are parsed as LOCAL dates, because the week keys are
// local Mondays — parsing them as UTC would shift them by a day in some
// time zones and make the comparison wrong.
function adjacentWeeks(earlierKey, laterKey) {
  const a = parseWeekKey(earlierKey);
  const b = parseWeekKey(laterKey);
  if (!a || !b) return false;
  return Math.round((b.getTime() - a.getTime()) / 86400000) === 7;
}

// A week key as a local Date at midnight.
//
// Returns null for a key that is not 'YYYY-MM-DD' — a malformed key must
// not make the whole page throw.
function parseWeekKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!mo || mo < 1 || mo > 12 || !d || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null; // e.g. 2026-02-30
  }
  return dt;
}

// ---- The whole summary ----------------------------------------------------

// Everything the 打卡墙 page needs.
//
// `rows` comes from db.listCardDrawsWithProgress(); the entries are
// decorated with their completion state and the totals are worked out
// here.
//
// Returns:
//
//   entries   — one per draw, newest first:
//                { id, weekKey, weekLabel, title, requirement, source,
//                  cardNo, done, hasPhoto, photoCount, textLength,
//                  memorialEventId, eventTitle }
//   weeks     — the number of weeks drawn
//   done      — how many of them were finished
//   pending   — how many are still waiting to be written
//   rate      — the completion rate as a percentage (0–100), rounded
//   streak    — the current run of finished weeks
//   best      — the longest run of finished weeks ever
//   firstWeek / lastWeek — the span the entries cover
function summary(rows, now = new Date()) {
  const list = Array.isArray(rows) ? rows : [];
  const entries = list.map((row) => {
    const v = evaluate(row);
    return {
      id: row.id,
      weekKey: row.week_key,
      weekLabel: weekLabel(row.week_key),
      title: row.title || '',
      requirement: row.requirement || '',
      source: row.source === 'custom' ? 'custom' : 'deck',
      // The card's number in the official deck. A custom card has none.
      // The column is an INTEGER, but the row may have been assembled by
      // hand, so the value is coerced rather than trusted.
      cardNo: row.card_no == null || row.card_no === ''
        ? null
        : Number(row.card_no),
      done: v.done,
      hasPhoto: v.hasPhoto,
      photoCount: v.photoCount,
      textLength: v.textLength,
      // The entry this draw became — but only if that entry STILL EXISTS.
      //
      // The draw's own `memorial_event_id` column is not enough: the
      // link is not a foreign key with ON DELETE, so a deleted entry
      // leaves the draw holding a stale id. The JOIN already knows the
      // truth (`event_id` is NULL when the entry is gone), so the joined
      // id is what goes here.
      //
      // Getting this wrong means the wall says 「查看这篇回忆」 and the
      // editor answers 「这篇回忆不存在」.
      memorialEventId: row.event_id || null,
      eventTitle: row.event_title || '',
    };
  });

  const weeks = entries.length;
  const done = entries.filter((e) => e.done).length;
  const pending = weeks - done;
  const rate = weeks ? Math.round((done / weeks) * 100) : 0;

  return {
    entries,
    weeks,
    done,
    pending,
    rate,
    // The streak counts the CURRENT run, so the entries have to be in
    // date order — they are, newest first.
    streak: currentStreak(entries),
    best: longestStreak(entries),
    firstWeek: entries.length ? entries[entries.length - 1].weekKey : null,
    lastWeek: entries.length ? entries[0].weekKey : null,
    threshold: TEXT_THRESHOLD,
    now: now.toISOString(),
  };
}

// The week a card belongs to, read the way the 抽卡 page reads it:
// the Monday and the Sunday of that week.
function weekLabel(key) {
  const monday = parseWeekKey(key);
  if (!monday) return String(key || '');
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${fmt(monday)} ~ ${fmt(sunday)}`;
}

module.exports = {
  TEXT_THRESHOLD,
  TEXT_FIELDS,
  textOf,
  textLength,
  evaluate,
  currentStreak,
  longestStreak,
  adjacentWeeks,
  parseWeekKey,
  summary,
  weekLabel,
};
