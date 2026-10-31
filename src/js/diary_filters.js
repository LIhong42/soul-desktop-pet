// src/js/diary_filters.js — the vocabulary of a 回忆事件 list filter.
//
// The 回忆事件 page (src/js/pages/events_memorial.js) filters its list by
// three independent axes:
//
//   * 时间   — how long ago the entry happened ("最近 30 天", "今年", …)
//   * 联系人 — who it was with
//   * 类型   — whether it was the first time (是第一次 / 不是第一次)
//
// plus the free-text 搜索 box that already existed. All of them compose:
// search ∩ time ∩ contact ∩ kind.
//
// This module owns the LABELS and the PREDICATES so the page itself only
// has to hold the current selection and re-run the filter. It follows the
// same pattern as the sibling modules:
//
//   * src/js/diary_kinds.js   — the kind vocabulary (是第一次 / 不是第一次)
//   * src/js/diary_themes.js  — the background presets
//   * src/js/diary_layout.js  — the document/gallery layout rules
//
// The filter is applied in the RENDERER, not in SQL. The list endpoint
// (main/db.js listMemorialEvents) already returns every column the filter
// needs — `occurred_at`, `kind`, `contact_ids` — so a filter change is a
// pure client-side pass over the cached rows: instant, no IPC round-trip,
// and it composes with the existing search box for free.

import { MEMORIAL_KINDS } from './diary_kinds.js';

// ---- 时间 -----------------------------------------------------------------
//
// The buckets are relative to "now", except the calendar-year ones which
// are anchored to the wall-clock year. Each bucket carries the predicate
// it stands for, so adding a bucket is a one-line change.
//
// `days` = the number of days back from now. `year` = the calendar year.
// A bucket with neither matches everything.

export const TIME_RANGES = [
  { value: '', label: '全部时间' },
  { value: '7d', label: '最近 7 天', days: 7 },
  { value: '30d', label: '最近 30 天', days: 30 },
  { value: '90d', label: '最近 3 个月', days: 90 },
  { value: '365d', label: '最近一年', days: 365 },
  { value: 'this_year', label: '今年', year: 'this' },
  { value: 'last_year', label: '去年', year: 'last' },
  { value: 'older', label: '更早' },
];

// Does an entry's occurrence date fall inside the given 时间 bucket?
//
// `occurred_at` is stored as a local datetime string ("YYYY-MM-DD
// HH:MM:SS"), so the date part is compared as a local date — no timezone
// drift. An entry whose date can't be parsed is kept under every bucket:
// it is better to show an entry we cannot place than to hide it behind a
// filter.
//
// `now` is injectable so the tests can pin the clock.
export function matchesTimeRange(occurredAt, value, now = new Date()) {
  if (!value) return true;
  const range = TIME_RANGES.find((x) => x.value === value);
  if (!range) return true;

  const date = parseDateOnly(occurredAt);
  // An entry we cannot place in time stays visible: a filter that hides
  // an entry the user cannot even see the date of would be baffling.
  if (!date) return true;

  if (range.days) {
    // "最近 N 天" reaches back N days from today, and today counts as
    // day one. So the cutoff is today−N: an entry from exactly N days
    // ago is still inside the window, which is the reading people
    // expect ("30 days ago" belongs to "the last 30 days").
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    cutoff.setDate(cutoff.getDate() - range.days);
    return date >= cutoff;
  }

  if (range.year) {
    const y = date.getFullYear();
    const thisYear = now.getFullYear();
    if (range.year === 'this') return y === thisYear;
    if (range.year === 'last') return y === thisYear - 1;
    return true;
  }

  // "更早": everything before the start of 今年.
  const thisYear = now.getFullYear();
  const yearStart = new Date(thisYear, 0, 1);
  return date < yearStart;
}

// Parse "YYYY-MM-DD…" into a local Date at midnight. Returns null when the
// value is missing or malformed.
function parseDateOnly(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// ---- 联系人 --------------------------------------------------------------
//
// The contact filter picks ONE contact (the entries carry a list of
// contacts, but filtering by one of them is what a user means by
// "这个人的回忆"). The dropdown lists every contact that appears in at
// least one entry — plus the ones the user has, even with no entry yet,
// so a filter value survives a contact being removed from the list.
//
// An empty value means "不限" — including entries with no contact at all
// (独立事件).
export function contactOptions(events, contacts) {
  const seen = new Map();
  for (const c of contacts || []) {
    seen.set(c.id, c.name || '(无名)');
  }
  for (const e of events || []) {
    const ids = e.contact_ids || [];
    const names = e.contact_names || [];
    ids.forEach((id, i) => {
      if (!seen.has(id)) seen.set(id, names[i] || '(无名)');
    });
  }
  return [...seen.entries()].map(([id, name]) => ({ value: id, label: name }));
}

// Does an entry belong to the given contact? An empty filter matches
// everything (including entries with no contact).
export function matchesContact(e, contactId) {
  if (!contactId) return true;
  const ids = e.contact_ids || [];
  return ids.includes(contactId);
}

// ---- 类型 -----------------------------------------------------------------
//
// The kind filter is the same vocabulary the cards show: 是第一次 /
// 不是第一次. The labels come from the shared kind list
// (src/js/diary_kinds.js), so a rename there shows up here too.
export function kindOptions() {
  return [
    { value: '', label: '全部类型' },
    ...MEMORIAL_KINDS.map((k) => ({ value: k.value, label: k.label })),
  ];
}

// Does an entry match the given kind? An empty filter matches everything.
export function matchesKind(e, kind) {
  if (!kind) return true;
  return (e.kind || 'other') === kind;
}

// ---- The combined filter -------------------------------------------------

// The default filter state — nothing filtered.
export function emptyFilter() {
  return { time: '', contact: '', kind: '' };
}

// Does an entry survive every axis of the filter? The axes are independent
// (AND), so a row has to pass all of them.
export function matchesFilter(e, filter, now = new Date()) {
  if (!filter) return true;
  if (!matchesTimeRange(e.occurred_at, filter.time, now)) return false;
  if (!matchesContact(e, filter.contact)) return false;
  if (!matchesKind(e, filter.kind)) return false;
  return true;
}
