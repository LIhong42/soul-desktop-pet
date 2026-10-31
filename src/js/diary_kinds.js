// src/js/diary_kinds.js — the vocabulary of a 回忆事件's kind.
//
// The `kind` column says one thing about a memorial event: whether it
// was the first time it happened. There are exactly two values (see the
// memorial_events schema in main/db.js:
//
//     kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('first_time','other'))
//
// Four places need to talk about it:
//
//   * src/js/diary_meta_form.js      — the 保存 dialog's radio choices
//   * src/js/form_fields.js          — the 快速记录 form's 类型 select
//   * src/js/pages/events_memorial.js — the 回忆事件 list card's tag
//   * src/js/pages/contact_detail.js — the contact's event list's tag
//
// They each used to spell the labels out on their own, which meant a
// rename had to be found in four files. The table lives here instead.

export const MEMORIAL_KINDS = [
  { value: 'first_time', label: '是第一次' },
  { value: 'other', label: '不是第一次' },
];

// The label a kind shows up as on a card and in a select.
//
// The dialog asks the question ("是第一次" / "不是第一次"), so it uses
// MEMORIAL_KINDS. A tag is not a question — it has to fit on one line
// next to a title — so it says what the entry IS ("第一次" / "其他").
export function memorialKindLabel(kind) {
  return kind === 'first_time' ? '第一次' : '其他';
}

// Normalize whatever the caller passes into one of the two legal values.
export function normalizeMemorialKind(kind) {
  return kind === 'first_time' ? 'first_time' : 'other';
}
