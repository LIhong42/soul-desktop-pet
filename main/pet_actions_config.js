// main/pet_actions_config.js — Per-pet "actions and triggers" config.
//
// Stores the user's preferences for which variant fires when the user
// triggers a named "interaction" (left-click, double-click, right-click
// menu items, etc.), and which variants the pet cycles through while
// idle. Persisted as a JSON blob in the generic `settings` table under
// the key `pet_actions_config:<pet_id>`, mirroring the per-pet
// `auto_log:<pet_id>` pattern used by auto_behaviors.js.
//
// Schema (current):
//   {
//     triggers: { [interaction_id]: variant_name },   // e.g. { click: 'default', pat: 'pat' }
//     loop_variants: ['default', 'greet', ...]      // ordered, used by pet_controller
//   }
//
// Legacy schema (v1): { click_variant, dblclick_variant, loop_variants }.
// We accept both shapes when reading so users on the previous build don't
// lose their existing settings.
//
// Why a separate file: the config is shared by three call sites
//   1. settings page (renderer) — read/write via IPC
//   2. pet_controller           — read `loop_variants` every tick
//   3. pet window (renderer)    — read `triggers` on every click
// Keeping the validation + default-fallback logic in one place avoids
// duplicating JSON.parse-with-defaults across all three sites.

// Stable identifier for each user-facing interaction that the *settings
// page* lets the user remap. Today this is just "单击桌宠" (a left-click
// on the pet sprite) — the dblclick handler was removed because double-
// clicks are awkward on a small pet window.
//
// The right-click menu's cozy actions (摸一下/拍头/喂食/玩耍/睡觉/跳舞)
// live in a separate "effect bindings" structure below. The particle
// effect for each is hard-coded (chicken-leg for 喂食, yarn for 玩耍,
// etc. — that's part of the cozy action's identity), but the **pet
// variant** that plays in response is user-configurable. So 喂食 always
// shows 🍖, but the user can choose whether their pet does a `default`
// sway, a `blink`, a `pat`, or anything else. This split is what the
// user explicitly asked for: "特效不需要进行设置，角色动作用户可以设置".
const TRIGGER_DEFS = [
  { id: 'click', label: '单击桌宠', cozy: false },
];

// Right-click menu entries. The `particle` is hard-coded — these icons
// are part of how the cozy system signals "you fed/played/slept/cuddled
// the pet" and changing them would break the cozy score side effect.
// The `default_variant` is what fires when the user hasn't customized
// anything; the user can override it via the `effect_overrides` map in
// the saved config (keyed by cozy action id, e.g. 'feed').
const EFFECT_BINDINGS = [
  { id: 'pet',    label: '右击菜单 · 摸一下', particle: '💗', default_variant: 'default', minTier: 1, cozy_action: 'pet' },
  { id: 'pat',    label: '右击菜单 · 拍头',   particle: '✨', default_variant: 'pat',     minTier: 5, cozy_action: 'pat' },
  { id: 'feed',   label: '右击菜单 · 喂食',   particle: '🍖', default_variant: 'default', minTier: 1, cozy_action: 'feed' },
  { id: 'play',   label: '右击菜单 · 玩耍',   particle: '🧶', default_variant: 'play',    minTier: 3, cozy_action: 'play' },
  { id: 'sleep',  label: '右击菜单 · 睡觉',   particle: '💤', default_variant: 'sleep',   minTier: 2, cozy_action: 'sleep' },
  { id: 'cuddle', label: '右击菜单 · 跳舞',   particle: '💞', default_variant: 'cuddle',  minTier: 6, cozy_action: 'cuddle' },
];

const DEFAULTS = Object.freeze({
  triggers: Object.freeze({
    click: 'default',
  }),
  // effect_overrides: per-cozy-action variant override. Keys are
  // EFFECT_BINDINGS ids ('pet' / 'pat' / 'feed' / 'play' / 'sleep' /
  // 'cuddle'). Missing keys fall back to the binding's default_variant.
  effect_overrides: Object.freeze({}),
  loop_variants: ['default'],
});

function configKey(petId) {
  return `pet_actions_config:${petId}`;
}

// Read config from the settings table. Falls back to DEFAULTS when the row
// is missing or the JSON is corrupt, mirroring auto_behaviors.loadLog().
// Accepts the v3 schema
//   ({ triggers: { click }, effect_overrides: { feed: 'blink', ... }, loop_variants }),
// the v2 schema
//   ({ triggers: { click, dblclick, pet, pat, ... }, loop_variants }),
// and the v1 legacy schema ({ click_variant, dblclick_variant, loop_variants }).
// v2's right-click triggers are ignored on read (they're hardcoded now);
// the v1 click_variant still projects onto the new `triggers.click`.
function loadConfig(db, petId) {
  const fallback = cloneDefaults();
  if (!db || !petId) return fallback;
  const raw = db.getSetting(configKey(petId));
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;

  // v3 / v2 path: triggers is an object, only `click` is meaningful now.
  if (parsed.triggers && typeof parsed.triggers === 'object') {
    const clickVal = parsed.triggers.click;
    if (typeof clickVal === 'string' && clickVal) {
      fallback.triggers.click = clickVal;
    }
    if (Array.isArray(parsed.loop_variants)) {
      const cleaned = parsed.loop_variants.filter((v) => typeof v === 'string' && v);
      if (cleaned.length > 0) fallback.loop_variants = cleaned;
    }
    // effect_overrides: a partial map keyed by EFFECT_BINDINGS id. Only
    // accept string values so a corrupt entry doesn't crash; unknown
    // keys are preserved on read and filtered out at resolve time (or
    // by filterAgainstManifest on save). Missing keys fall back to
    // EFFECT_BINDINGS[id].default_variant.
    if (parsed.effect_overrides && typeof parsed.effect_overrides === 'object') {
      const validIds = new Set(EFFECT_BINDINGS.map((b) => b.id));
      for (const k of Object.keys(parsed.effect_overrides)) {
        const v = parsed.effect_overrides[k];
        if (validIds.has(k) && typeof v === 'string' && v) {
          fallback.effect_overrides[k] = v;
        }
      }
    }
    return fallback;
  }

  // v1 migration: project click_variant onto the new `triggers.click`.
  // dblclick_variant is dropped — dblclick is no longer a user interaction.
  if (typeof parsed.click_variant === 'string' && parsed.click_variant) {
    fallback.triggers.click = parsed.click_variant;
  }
  if (Array.isArray(parsed.loop_variants)) {
    const cleaned = parsed.loop_variants.filter((v) => typeof v === 'string' && v);
    if (cleaned.length > 0) fallback.loop_variants = cleaned;
  }
  return fallback;
}

// Persist config. Returns true on success, false on bad input.
function saveConfig(db, petId, cfg) {
  if (!db || !petId || !cfg || typeof cfg !== 'object') return false;
  const triggers = {};
  for (const def of TRIGGER_DEFS) {
    const v = cfg.triggers && cfg.triggers[def.id];
    triggers[def.id] = (typeof v === 'string' && v) ? v : (DEFAULTS.triggers[def.id] || 'default');
  }
  const loop = Array.isArray(cfg.loop_variants) && cfg.loop_variants.length > 0
    ? cfg.loop_variants.filter((v) => typeof v === 'string' && v)
    : [...DEFAULTS.loop_variants];
  // effect_overrides: per-cozy-action variant override. Filter to known
  // EFFECT_BINDINGS ids with string values; drop empty / non-string /
  // unknown-key entries. An empty object is fine — that just means
  // "use EFFECT_BINDINGS defaults for everything".
  const validIds = new Set(EFFECT_BINDINGS.map((b) => b.id));
  const effect_overrides = {};
  if (cfg.effect_overrides && typeof cfg.effect_overrides === 'object') {
    for (const k of Object.keys(cfg.effect_overrides)) {
      if (!validIds.has(k)) continue;
      const v = cfg.effect_overrides[k];
      if (typeof v === 'string' && v) effect_overrides[k] = v;
    }
  }
  const safe = {
    triggers,
    effect_overrides,
    loop_variants: loop.length > 0 ? loop : [...DEFAULTS.loop_variants],
  };
  try {
    db.setSetting(configKey(petId), JSON.stringify(safe));
    return true;
  } catch (e) {
    console.error('[pet_actions_config] save failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Resolve the variant names declared by the current pet's manifest. We
// deliberately read the raw manifest (not the registry's filtered view) so
// the settings page can list every variant the pet knows about, even ones
// the registry's `requiresTier` filter would normally hide at low tiers.
//
// Result policy: **every variant declared in the pet's manifest is a
// "角色动作" the user can pick** from the dropdowns on the settings
// page (触发方式、循环列表 add、特效绑定的角色动作列). The contract is:
//   - `default` is always present (sane fallback).
//   - every other key from `manifest.variants` is appended in the
//     order it appears in the manifest (so the dropdown mirrors what
//     the user sees when they open the pet's `manifest.json`).
//   - we do NOT inject the 6 cozy keys (pet/pat/feed/play/sleep/cuddle)
//     here — they're not in the manifest, they're hardcoded in the
//     right-click menu. The user can still pick `pat` for, say, the
//     "单击桌宠" action *only if the current pet's manifest declares
//     `pat` as a variant* (VioletMoon does — it points at the
//     `headpat/` frame dir). That's the rule: the manifest is the
//     source of truth for "what can this pet play", and the settings
//     page mirrors it verbatim.
//
// Why we don't add the 6 cozy keys automatically: doing so would let
// the user pick "feed" for a click on a pet whose manifest doesn't
// declare a `feed` variant — `petController.triggerOneShot` would
// then fall back to the default frame set and the click would look
// like it worked but the cozy score side effect (which the user
// thought they were triggering) would not run. Restricting to manifest
// keys makes the dropdown a truthful contract.
//
// `walking` and `reminder` are intentionally included too — they're
// declared in the manifest (the controller auto-spawns them at runtime
// but the manifest is the canonical list), and a user who wants their
// pet to loop `walking` while idle should be able to pick it.
function getAvailableVariants(petRegistry, petId) {
  const out = ['default'];
  if (!petRegistry || !petId) return out;
  const m = petRegistry.getManifest(petId);
  if (m && m.variants && typeof m.variants === 'object') {
    for (const k of Object.keys(m.variants)) {
      if (!k || k === 'default') continue;  // default is already at the head
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

// Drop variants from a config that the pet doesn't actually expose in its
// manifest. Used by both the IPC handler (before save) and the controller
// (every tick) so a stale config written for a previous pet can't break a
// newly-installed pet's idle loop.
//
// Cozy reserved names are always considered "valid" regardless of the
// manifest — the pet window routes them through bond.*, not through the
// registry's resolveFrames.
const COZY_ALLOWED = new Set(['pet', 'pat', 'feed', 'play', 'sleep', 'cuddle']);

// Directional movement keys (`walking.left/right`, `running.left/right`)
// are valid `triggers.click` / `effect_overrides` values — the user can
// explicitly trigger them on click or from a (future) right-click entry —
// but they must NEVER appear in `loop_variants`. The autonomous idle
// loop uses the bare `walking` key emitted by PetController's
// `_startRandomAction`; the directional variants are user-initiated
// actions with their own speed / duration / edge-clamping logic. Silently
// dropping them from loop_variants prevents the controller from
// spontaneously wandering in a fixed direction every cycle.
const { getMovementProfile } = require('./pet_controller');
function isMovementVariant(v) {
  const p = getMovementProfile(v);
  return !!(p && p.direction);
}

function isVariantAllowed(v, petRegistry, petId) {
  if (typeof v !== 'string' || !v) return false;
  if (v === 'default') return true;
  if (COZY_ALLOWED.has(v)) return true;
  if (!petRegistry || !petId) return false;
  const m = petRegistry.getManifest(petId);
  return !!(m && m.variants && Object.prototype.hasOwnProperty.call(m.variants, v));
}

function filterAgainstManifest(cfg, petRegistry, petId) {
  const triggers = {};
  for (const def of TRIGGER_DEFS) {
    const raw = cfg && cfg.triggers && cfg.triggers[def.id];
    triggers[def.id] = isVariantAllowed(raw, petRegistry, petId)
      ? raw
      : DEFAULTS.triggers[def.id];
  }
  const loopRaw = (cfg && cfg.loop_variants) || DEFAULTS.loop_variants;
  let loop_variants = loopRaw.filter((v) =>
    isVariantAllowed(v, petRegistry, petId) && !isMovementVariant(v));
  if (!loop_variants.includes('default')) loop_variants.unshift('default');
  if (loop_variants.length === 0) loop_variants = [...DEFAULTS.loop_variants];
  // effect_overrides: same variant validity rule, but each key is
  // independently checked — we don't drop the whole map if one entry
  // is invalid, just that one entry.
  const effect_overrides = {};
  if (cfg && cfg.effect_overrides && typeof cfg.effect_overrides === 'object') {
    const validIds = new Set(EFFECT_BINDINGS.map((b) => b.id));
    for (const k of Object.keys(cfg.effect_overrides)) {
      if (!validIds.has(k)) continue;
      const v = cfg.effect_overrides[k];
      if (isVariantAllowed(v, petRegistry, petId)) {
        effect_overrides[k] = v;
      }
    }
  }
  return { triggers, loop_variants, effect_overrides };
}

function cloneDefaults() {
  return {
    triggers: { ...DEFAULTS.triggers },
    effect_overrides: { ...DEFAULTS.effect_overrides },
    loop_variants: [...DEFAULTS.loop_variants],
  };
}

// Resolve the variant that should play for a given right-click cozy
// action. Used by the context menu handler in main/ipc.js so the pet's
// reaction animation respects the user's per-cozy-action override.
//
// Falls back (in order):
//   1. The user's saved override for that cozy action id, if it's a
//      string the active pet's manifest actually exposes.
//   2. EFFECT_BINDINGS[id].default_variant, if the active pet's manifest
//      exposes it. Many pets ship without `pat` / `sleep` / `cuddle` /
//      `play` variants (the cozy names that double as EFFECT_BINDINGS
//      ids) — falling back to `default` keeps the pet rendering *some*
//      animation instead of `pet:resolve_frames` failing.
//   3. 'default' as a last resort.
//
// Why not just trust the override: a user with multiple pets can
// override `pet → dancing` on VioletMoon and forget to clear it when
// switching to a pet that doesn't have `dancing`. We have to cross-check
// against the active manifest or we'll keep pointing at a variant the
// active pet can't play, and the renderer will go blank.
function getEffectVariant(cfg, cozyActionId, petRegistry, petId) {
  const binding = EFFECT_BINDINGS.find((b) => b.id === cozyActionId);
  const hardFallback = binding ? binding.default_variant : 'default';
  // Allow the caller to skip manifest validation (e.g. a caller that has no
  // manifest); the production IPC path always passes both. `petManifestExposes` returns
  // true for `default` even without looking at the manifest, so the
  // common case (any pet, default fallback) is safe.
  const variantExists = (v) => {
    if (v === 'default') return true;
    if (!petRegistry || !petId) return false;
    const m = petRegistry.getManifest(petId);
    return !!(m && m.variants && Object.prototype.hasOwnProperty.call(m.variants, v));
  };
  if (cfg && cfg.effect_overrides) {
    const override = cfg.effect_overrides[cozyActionId];
    if (typeof override === 'string' && override && variantExists(override)) return override;
  }
  if (variantExists(hardFallback)) return hardFallback;
  return 'default';
}

module.exports = {
  DEFAULTS,
  TRIGGER_DEFS,
  EFFECT_BINDINGS,
  COZY_ALLOWED,
  configKey,
  loadConfig,
  saveConfig,
  getAvailableVariants,
  isVariantAllowed,
  filterAgainstManifest,
  getEffectVariant,
};