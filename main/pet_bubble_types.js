// main/pet_bubble_types.js — bubble "kind" catalogue + shared text helpers.
//
// A "kind" is the identity of a bubble category (吃饭提醒 / 休息提醒).
// It is NOT the text itself — the text comes from a Rule's `text(ctx)`.
// Kinds give the renderer a stable CSS hook (`data-kind`) and give the
// framework a vocabulary for user-facing enable/disable toggles.
//
// `textAtLeastOneOf` is exported because the shipped rules do the same
// thing: "compose a sentence from a list of phrases, best-effort".
const KINDS = Object.freeze({
  MEAL: 'meal',                  // 吃饭提醒
  BREAK: 'break',                // 休息提醒
});

// Human labels for the settings page. Kept here (not in the renderer) so a
// new kind only needs one edit to become configurable.
const KIND_LABELS = Object.freeze({
  [KINDS.MEAL]: '吃饭提醒',
  [KINDS.BREAK]: '休息提醒',
});

// Pick at most `limit` phrases from `list` and join them. Used for the
// meal windows (short label + what to eat). Skipping null/empty entries
// means a caller can pass a partially-filled array without guarding.
function textAtLeastOneOf(list, limit, sep) {
  const parts = (Array.isArray(list) ? list : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, limit > 0 ? limit : 1);
  if (parts.length === 0) return null;
  return parts.join(sep == null ? '' : sep);
}

module.exports = { KINDS, KIND_LABELS, textAtLeastOneOf };