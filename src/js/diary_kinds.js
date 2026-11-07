// src/js/diary_kinds.js — the vocabulary of a 回忆事件's 分类.
//
// The `kind` column says one thing about a memorial event: which 分类 it
// belongs to. There are exactly three values (see the memorial_events
// schema in main/db.js):
//
//     kind TEXT NOT NULL DEFAULT 'other'
//           CHECK (kind IN ('first_time','other','card_draw'))
//
//   first_time — 是第一次
//   other      — 不是第一次
//   card_draw  — 抽卡事件: the memory was written down from a card drawn
//                on the 抽卡人生 page (src/js/pages/card_life.js)
//
// Four places need to talk about it:
//
//   * src/js/diary_meta_form.js      — the 保存 dialog's 分类 choices
//   * src/js/form_fields.js          — the 快速记录 form's 类型 select
//   * src/js/pages/events_memorial.js — the 回忆事件 list card's tag
//   * src/js/pages/contact_detail.js — the contact's event list's tag
//
// They each used to spell the labels out on their own, which meant a
// rename had to be found in four files. The table lives here instead.

export const MEMORIAL_KINDS = [
  { value: 'first_time', label: '是第一次' },
  { value: 'other', label: '不是第一次' },
  { value: 'card_draw', label: '抽卡事件' },
];

// The label a kind shows up as on a card and in a select.
//
// The dialog asks the question ("是第一次" / "不是第一次" / "抽卡事件"),
// so it uses MEMORIAL_KINDS. A tag is not a question — it has to fit on
// one line next to a title — so it says what the entry IS ("第一次" /
// "其他" / "抽卡事件").
export function memorialKindLabel(kind) {
  if (kind === 'first_time') return '第一次';
  if (kind === 'card_draw') return '抽卡事件';
  return '其他';
}

// Normalize whatever the caller passes into one of the legal values.
export function normalizeMemorialKind(kind) {
  if (kind === 'first_time' || kind === 'card_draw') return kind;
  return 'other';
}
