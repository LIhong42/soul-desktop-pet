// main/pet_bubble_types.js — bubble "kind" catalogue.
//
// A "kind" is the identity of a bubble category (吃饭提醒 / 休息提醒).
// It is NOT the text itself — the text comes from a Rule's `build(state)`.
// Kinds give the renderer a stable CSS hook (`data-kind`) and give the
// framework a vocabulary for user-facing enable/disable toggles.
const KINDS = Object.freeze({
  MEAL: 'meal',                  // 吃饭提醒
  BREAK: 'break',                // 休息提醒
  UPDATE: 'update',              // 有新版本
});

// Human labels for the settings page. Kept here (not in the renderer) so a
// new kind only needs one edit to become configurable.
const KIND_LABELS = Object.freeze({
  [KINDS.MEAL]: '吃饭提醒',
  [KINDS.BREAK]: '休息提醒',
  [KINDS.UPDATE]: '有新版本',
});

module.exports = { KINDS, KIND_LABELS };
