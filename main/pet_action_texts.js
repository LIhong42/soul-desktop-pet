// main/pet_action_texts.js — 动作 → 文本绑定 (per-pet).
//
// ---------------------------------------------------------------------------
// What this is
// ---------------------------------------------------------------------------
// Lets the user attach *one or more* speech lines to any pet "action"
// (角色动作 / 触发方式 / 特效绑定). When the pet window is about to play a
// given action, the controller asks this module for a line to show in the
// bubble, and the line is picked **at random** from the pool.
//
// Two rules make this feel right rather than noisy:
//
//   1. An action with no texts shows nothing, ever. That's the default —
//      nothing is bound until the user types something in /settings.
//   2. **"不展示文本" is always one of the candidates.** Even an action with
//      five bound lines has a real chance of staying silent on any given
//      play, because the candidate pool is `[...texts, null]` and we sample
//      it uniformly. Without this the pet would talk on literally every
//      action and become wallpaper noise; with it, the pet reads as
//      "occasionally has something to say", which is the intent.
//
// Persisted per-pet under `pet_action_texts:<pet_id>` in the generic
// `settings` table, mirroring the `pet_actions_config:<pet_id>` pattern.
//
// ---------------------------------------------------------------------------
// Why the *default* action carries the reminder texts
// ---------------------------------------------------------------------------
// The 吃饭提醒 / 休息提醒 bubbles are produced by main/pet_bubbles.js, which
// is deliberately decoupled from the animation path — it doesn't know what
// variant the pet is playing. But the user asked for those lines to be
// available to the *default* action too, so the pet can say them while it
// idles rather than only inside the rule's own bubble. To keep the two
// systems from fighting we do NOT copy them into the saved config. Instead:
//
//   - `enqueueRuntime` inserts a line into an **in-memory** runtime pool,
//     with a ttl, and returns a handle. pet_bubbles calls it when a rule
//     starts (`onStart`) and calls `dequeueRuntime` when the bubble is
//     cleared. That's the "动态插拔" the user asked for: the default
//     action's pool gains "午饭：今天吃撒" exactly while that bubble is on
//     screen, and loses it the instant the bubble goes away.
//   - The runtime pool is merged in front of the user's saved texts when
//     the pool is read, so a rule-driven line can never be persisted or
//     edited away, and two reminders firing together both show up.
//
// The pool is intentionally in-memory only: a 吃饭提醒 line that survives a
// restart would nag about lunch hours after the user left. Restart drops it
// and the rule re-evaluates on its own within one tick.

// Persistence key prefix, per pet.
const CONFIG_PREFIX = 'pet_action_texts:';

// How long a rule-driven line stays in the runtime pool after enqueue, if
// the matching dequeue call never arrives (crash, mid-teardown, missed
// clear). Purely a backstop: pet_bubbles always dequeues explicitly.
const RUNTIME_TTL_MS = 2 * 60 * 60_000;

// The sentinel for "say nothing". Kept as a module constant so the renderer
// and the main process can't drift on how it's spelled on the wire — the
// settings UI persists this exact string as a normal line, and the picker
// filters it back out into "未绑定" when it reads the config back.
const NO_TEXT = '';

function configKey(petId) {
  return `${CONFIG_PREFIX}${petId}`;
}

// ---------------------------------------------------------------------------
// Runtime pool (动态插拔)
// ---------------------------------------------------------------------------
//
// key: `${action}\u0000${text}` — composite so two actions can carry the
// same line without colliding, and so one action can carry the same line
// twice for different rules (meal + break) without dequeueing each other.
const runtimePool = new Map();   // key → { action, text, expiresAtMs }

// Drop expired entries. Called on every read/write so the pool self-prunes
// even if a dequeue is lost; cheap because the pool holds a handful of
// entries at most.
function pruneRuntime(nowMs) {
  for (const [k, v] of runtimePool) {
    if (v.expiresAtMs <= nowMs) runtimePool.delete(k);
  }
}

// Resolve a caller-supplied ttl. `undefined` / non-finite → the backstop
// TTL; anything else (including 0 or a negative number) is honoured
// verbatim, because "expire immediately" is a legitimate request and
// silently promoting it to 2 hours would strand the line in the pool.
function resolveTtl(ttlMs) {
  const n = Number(ttlMs);
  return Number.isFinite(n) ? n : RUNTIME_TTL_MS;
}

// Add `text` to `action`'s candidate pool until `ttlMs` elapses. Returns
// true when something was actually added (blank text and blank action are
// rejected — "no text" is the absence of a line, not a line).
function enqueueRuntime(action, text, ttlMs) {
  const a = String(action == null ? '' : action).trim();
  const t = String(text == null ? '' : text).trim();
  if (!a || !t) return false;
  pruneRuntime(Date.now());
  const key = `${a}\u0000${t}`;
  const expiresAtMs = Date.now() + resolveTtl(ttlMs);
  if (runtimePool.has(key)) {
    // Refresh the ttl rather than adding a duplicate — the same rule can
    // legitimately re-fire (休息提醒 every 3h) and we don't want two
    // copies weighting the pool in its favour.
    runtimePool.get(key).expiresAtMs = expiresAtMs;
    return false;
  }
  runtimePool.set(key, { action: a, text: t, expiresAtMs });
  return true;
}

// Remove a previously-enqueued runtime line. Idempotent: removing something
// that isn't there is a no-op, so the caller doesn't have to track handles.
function dequeueRuntime(action, text) {
  const a = String(action == null ? '' : action).trim();
  const t = String(text == null ? '' : text).trim();
  if (!a || !t) return false;
  pruneRuntime(Date.now());
  return runtimePool.delete(`${a}\u0000${t}`);
}

// Current runtime entries, optionally filtered to one action. Exposed so
// /settings can show the user what's temporarily wired in (e.g. "当前插播:
// 午饭：今天吃撒"), which makes the plug/unplug behaviour visible instead of
// mysterious.
function listRuntime(action) {
  pruneRuntime(Date.now());
  const a = action == null ? null : String(action).trim();
  const out = [];
  for (const v of runtimePool.values()) {
    if (a && v.action !== a) continue;
    out.push({ action: v.action, text: v.text, expiresAtMs: v.expiresAtMs });
  }
  return out;
}

// Wipe the whole pool. Called on shutdown and by tests; a rule-driven line
// must not outlive the process that produced it.
function clearRuntime() {
  runtimePool.clear();
}

// ---------------------------------------------------------------------------
// Saved config (the user's own bindings)
// ---------------------------------------------------------------------------
//
// Shape: { texts: { [action]: string[] }, boxes: { [action]: string } }
//
// An action maps to an **array**, never a single string, because one action
// can be bound to several lines and we sample among them. Missing action ⇒
// no texts ⇒ the picker always returns null and the pet stays silent.
//
// `boxes` is the 文本框 chosen per action (main/pet_text_boxes.js). It is a
// **separate map** rather than a field on the text arrays because the two are
// independent: an action can have five lines and the default box, or one line
// and a decorated box, or a box with no lines at all (the box would then apply
// to whatever a reminder line plugs in). Storing the box inside `texts[action]`
// would force a choice of array-vs-object layout for no benefit.
//
// Absent action ⇒ default box. The box is deliberately NOT validated against
// the folder here: a box id written on another machine must survive a round
// trip so it comes back when the user is back on the machine that has that
// PNG. The renderer degrades an unknown id to the CSS bubble (see
// pet_text_boxes.resolve), so a stale id costs a fallback, not a broken bubble.

// Normalize a caller-supplied action→texts map. Drops non-string / blank
// entries, trims, and de-dupes within each action while preserving order.
// The user's literal blank lines are NOT preserved — a blank line and "no
// line" mean the same thing to the picker, and storing the former would
// make the /settings list show phantom rows.
function normalizeTexts(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const action of Object.keys(map)) {
    const a = String(action).trim();
    if (!a) continue;
    const raw = map[action];
    const list = Array.isArray(raw) ? raw : [raw];
    const seen = new Set();
    const clean = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const t = item.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      clean.push(t);
    }
    if (clean.length > 0) out[a] = clean;
  }
  return out;
}

// Normalize a caller-supplied action→box map. Drops non-string / blank ids and
// trims, exactly as normalizeTexts does for lines. An all-blank action loses its
// key so "no box" is always an absent key, matching how `texts` represents "no
// lines" — the two maps then have the same shape and the UI can treat them alike.
function normalizeBoxes(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const action of Object.keys(map)) {
    const a = String(action).trim();
    if (!a) continue;
    const b = typeof map[action] === 'string' ? map[action].trim() : '';
    if (b) out[a] = b;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read cache
// ---------------------------------------------------------------------------
//
// `_pickActionText` runs on the controller's hot path — every time the pet
// starts an action, which is every couple of seconds while it's wandering.
// Each call was a SQL query + JSON.parse, which is wasteful for a blob that
// changes only when the user saves on /settings.
//
// So the parsed config is memoised per pet id, and `saveConfig` (the only
// writer) drops the entry. A per-process cache can't go stale from another
// process because the main process is the only writer, and a restore from a
// backup zip swaps the DB under us — hence `invalidate` is also exported and
// called from the settings page's save path.
//
// The cache is keyed by pet id and holds the *normalized* texts, so callers
// must not mutate what loadConfig returns. Both callers here treat it as
// read-only (the controller picks from it; the IPC handler copies it into
// the response payload).
const configCache = new Map();

function loadConfig(db, petId) {
  if (!db || !petId) return { texts: {}, boxes: {} };
  const cached = configCache.get(petId);
  if (cached) return cached;
  let raw = null;
  try { raw = db.getSetting(configKey(petId)); } catch { return { texts: {}, boxes: {} }; }
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const cfg = {
    texts: normalizeTexts(parsed && parsed.texts),
    boxes: normalizeBoxes(parsed && parsed.boxes),
  };
  configCache.set(petId, cfg);
  return cfg;
}

// Drop the memoised config for one pet (or all of them). Called on save and
// after a backup restore, the only two events that can change the blob
// behind the cache's back.
function invalidate(petId) {
  if (petId == null) configCache.clear();
  else configCache.delete(petId);
}

function saveConfig(db, petId, cfg) {
  if (!db || !petId) return false;
  const safe = {
    texts: normalizeTexts(cfg && cfg.texts),
    boxes: normalizeBoxes(cfg && cfg.boxes),
  };
  try {
    db.setSetting(configKey(petId), JSON.stringify(safe));
    // Re-seed the cache with what we just wrote, so the next pick is a
    // lookup rather than a query — and so it reflects the normalization we
    // applied rather than the raw string.
    configCache.set(petId, safe);
    return true;
  } catch (e) {
    console.error('[pet_action_texts] save failed:', e && e.message ? e.message : e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Candidate pool + pick
// ---------------------------------------------------------------------------

// The full candidate list for `action`: runtime lines first (so a live
// 吃饭提醒 is as likely to be picked as anything else, and shows up
// immediately when it fires), then the user's saved lines, then the
// mandatory `null` entry that means "this time, say nothing".
//
// We deliberately do **not** de-duplicate across the runtime/saved boundary:
// if the user manually bound "今天吃撒" to `default` and the meal rule also
// plugs it in, that's two independent reasons to say it, which reads as
// more enthusiasm, not less. Within each list they're already unique.
function candidatesFor(action, savedTexts) {
  const a = String(action == null ? '' : action).trim();
  const out = [];
  if (!a) return [null];
  for (const r of listRuntime(a)) out.push(r.text);
  const saved = savedTexts && savedTexts[a];
  if (Array.isArray(saved)) for (const t of saved) out.push(t);
  // The whole point: silence is always on the menu. See the header note.
  out.push(null);
  return out;
}

// Pick one candidate uniformly at random. Returns the chosen string, or
// null when the sample landed on the "no text" entry (or when the action
// has nothing bound at all — which collapses to a single `[null]` pool).
//
// Accepts an injected `rng` so tests can pin the sample. The sample is
// clamped into [0, 1) first: `Math.random()` can't produce a value outside
// that range, but an injected sampler might, and clamping at the low end
// (rather than letting a negative index silently fall through to the
// trailing `null`) keeps a malformed sampler from quietly biasing every
// draw toward silence.
function pickText(action, savedTexts, rng) {
  const pool = candidatesFor(action, savedTexts);
  const r = typeof rng === 'function' ? rng : Math.random;
  const raw = Number(r());
  const unit = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 0;
  const chosen = pool[Math.floor(unit * pool.length)];
  return (typeof chosen === 'string' && chosen.trim()) ? chosen : null;
}

// ---------------------------------------------------------------------------
// Introspection for the settings page
// ---------------------------------------------------------------------------

// The action rows /settings should render: everything the pet can actually
// perform, i.e. the union of
//   * `available_variants` — the character's own animation variants,
//   * any action already present in the saved config (so a binding survives a
//     pet switch that no longer declares that variant, instead of silently
//     vanishing from the editor).
//
// Deliberately NOT included: the user interactions. 单击桌宠 (TRIGGER_DEFS)
// and 右击菜单 · 摸一下/拍头/喂食/玩耍 (EFFECT_BINDINGS) are things the *user*
// does, not things the pet plays, so a bound line would never fire against
// them — the pet responds with whatever variant the interaction resolves to,
// and that variant is the one that gets a row (and picks the text).
//
// The caller supplies the variant list; we don't re-read the manifest here,
// because main/ipc.js already has the filtered list and would otherwise have
// to duplicate `getAvailableVariants`' policy in a second place.
function describeActions(db, petId, sources) {
  const cfg = loadConfig(db, petId);
  const seen = new Set();
  const rows = [];
  // Variants display as their raw manifest key — that's what the rest of
  // /settings shows for them, and it's what saveConfig persists.
  const push = (id) => {
    const a = String(id == null ? '' : id).trim();
    if (!a || seen.has(a)) return;
    seen.add(a);
    rows.push({
      action: a,
      label: a,
      group: 'variant',
      texts: Array.isArray(cfg.texts[a]) ? cfg.texts[a].slice() : [],
      // The 文本框 chosen for this action, or '' for the CSS default. Always
      // present (never undefined) so the settings page can bind a <select>
      // straight to it without a null check per row.
      box: (cfg.boxes && typeof cfg.boxes[a] === 'string') ? cfg.boxes[a] : '',
      // What the runtime has temporarily plugged in for this action, so the
      // UI can show it without the user guessing why the pet just said
      // something it wasn't configured to say.
      runtime: listRuntime(a),
    });
  };
  const s = sources || {};
  for (const v of (s.variants || [])) push(v);
  for (const a of Object.keys(cfg.texts)) push(a);
  // `boxes` too: an action the user gave a text box but no lines still needs
  // its row, or the box would be unreachable from the UI and could only ever be
  // set by hand-editing the DB.
  for (const a of Object.keys(cfg.boxes)) push(a);
  return rows;
}

module.exports = {
  CONFIG_PREFIX,
  NO_TEXT,
  RUNTIME_TTL_MS,

  // runtime pool (动态插拔)
  enqueueRuntime,
  dequeueRuntime,
  listRuntime,
  clearRuntime,

  // saved config
  configKey,
  normalizeTexts,
  normalizeBoxes,
  loadConfig,
  saveConfig,
  invalidate,

  // picking
  candidatesFor,
  pickText,

  // introspection
  describeActions,

  _internals: { runtimePool, pruneRuntime },
};