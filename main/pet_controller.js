// main/pet_controller.js — autonomous pet movement + state machine (frame-based).
//
// Per-tick responsibilities:
//   * Translate the pet window horizontally (walk).
//   * Pick the next animation variant ("variant" = a UI-level action key like
//     default/walking/reminder) and broadcast it to the renderer.
//   * Push the current variant + direction + petId so the renderer can resolve
//     frames via PetRegistry.
//
// Persistence:
//   * `pet_walk_enabled`  : "1" or "0"
//   * `pet_id`            : active pet id (replaces legacy `pet_species`)
//   * `pet_paused_until`  : epoch ms; controller skips movement while Date.now()
//                          < this value.

const { screen } = require('electron');

// 动作 → 文本绑定。Loaded lazily to avoid a require cycle at module load:
// pet_action_texts has no imports back into the controller, but keeping the
// dependency one-way makes the "bubbles never touch the animation path"
// invariant easier to see. See main/pet_action_texts.js.
const petActionTexts = require('./pet_action_texts');

const TICK_MS = 100;

// Lost-IPC watchdog for one-shot animations, see `tick()`.
//
// An action's real duration comes only from its frame sequence — the
// renderer plays every frame and calls back. This constant is NOT an
// animation length: it is the point past which we conclude the callback
// never arrived (renderer crash / dropped IPC) and the pet is frozen
// rather than busy. Set far above the longest realistic sequence — the
// imported VioletMoon `dancing` is 61 frames ≈ 12.2s — so it can never
// truncate a real animation.
const ONE_SHOT_WATCHDOG_MS = 5 * 60_000;

// Render height is fixed; width is computed from the active pet's
// `manifest.defaultSize` so the character fits the window without any
// letterboxing. Built-in pets declare 768×832 (≈ 0.92 wide:tall) and end up
// ≈ 203×220; an imported 109×145 ends up ≈ 165×220. Width floor of 48 px
// keeps extreme aspect ratios (e.g. a 1×4096 sprite) clickable.
const PET_RENDER_HEIGHT = 220;
const PET_RENDER_MIN_WIDTH = 48;

// The window is also WIDER than the sprite, by the same amount on each side.
// All three bubbles are centred on the sprite and constrained to the window
// width (`max-width: 100%`), so without this the window is only as wide as
// the pet — ~165px for the shipped 2160×2880 sprite, which fits barely 13
// CJK characters per line and forced every bubble to wrap awkwardly.
//
// The extra width is transparent and `pointer-events: none` (only
// .pet-sprite is clickable), so the wider hit box doesn't steal clicks from
// whatever is behind the pet.
const BUBBLE_SIDE_ROOM_PX = 70;

// The window is deliberately TALLER than the sprite, and the sprite sits at
// the bottom of it. All three bubbles (reminder / bond / contextual) are
// anchored to the sprite's TOP edge with `bottom: var(--sprite-h)`, so they
// draw into the headroom above the pet. When the window was exactly as tall
// as the pet they rendered above y=0 and were clipped away by the body's
// `overflow: hidden` — a single-line bubble lost its top few pixels, and a
// wrapped one lost most of itself.
//
// The gap between bubble and pet is the tail alone (5px): anchoring at the
// sprite's top edge is what keeps the card clear of the character's head.
// An earlier `- 4px` / `- 6px` tucked the card down onto the sprite box,
// which read as covering the pet.
//
// This headroom is the space those bubbles actually draw into. The trade-off
// is a transparent band above the pet: the window reports a taller hit box
// than the visible character, which is why the sprite keeps
// `pointer-events: auto` and the headroom stays `pointer-events: none`
// (see --size-h usage in src/css/pet.css). Must stay in sync with the bubble
// `bottom` / `max-height` rules in pet.css, which pin the sprite to the
// bottom of the box and cap bubbles at the headroom.
const BUBBLE_HEADROOM_PX = 120;

// ---- Movement profiles ----
//
// `walking` (bare) is the autonomous wander loop emitted by
// `_startRandomAction` — no direction, the renderer's CSS flip rule
// (scoped to `[data-action="walking"]`) handles orientation.
//
// The four compound keys (`walking.left/right`, `running.left/right`) are
// what `triggerOneShot` uses when the user explicitly picks a directional
// movement action from /settings or a (future) right-click entry. Running
// is faster (4~8 px/tick vs walking's 1~2 px/tick) and uses a **random
// target distance** instead of a fixed duration — `durationMs` is computed
// from `ceil(distance / speed) * TICK_MS`.
//
// Adding a directional running/walking action to the manifest automatically
// unlocks the corresponding profile here (see `getMovementProfile`); no
// other code path needs to know.
const MOVEMENT_PROFILES = {
  'walking': {
    base: 'walking', direction: null,
    minSpeedPxPerTick: 1, maxSpeedPxPerTick: 2,
    minDurationMs: 6000, maxDurationMs: 12000,
    targetDistancePx: null,
  },
  'walking.left': {
    base: 'walking', direction: 'left',
    minSpeedPxPerTick: 1, maxSpeedPxPerTick: 2,
    minDurationMs: 6000, maxDurationMs: 12000,
    targetDistancePx: null,
  },
  'walking.right': {
    base: 'walking', direction: 'right',
    minSpeedPxPerTick: 1, maxSpeedPxPerTick: 2,
    minDurationMs: 6000, maxDurationMs: 12000,
    targetDistancePx: null,
  },
  'running.left': {
    base: 'running', direction: 'left',
    minSpeedPxPerTick: 4, maxSpeedPxPerTick: 8,
    minDurationMs: 0, maxDurationMs: 0,
    targetDistancePx: { min: 80, max: 320 },
  },
  'running.right': {
    base: 'running', direction: 'right',
    minSpeedPxPerTick: 4, maxSpeedPxPerTick: 8,
    minDurationMs: 0, maxDurationMs: 0,
    targetDistancePx: { min: 80, max: 320 },
  },
};

const DIRECTION_SIGN = { left: -1, right: 1 };

// ---- Loop-action probability table ----
//
// When the controller needs to pick the next autonomous action (every
// `_pickNextAt` cycle, and after a one-shot completes), it samples from
// three pools with these weights:
//
//   default  : 70%  — pet sits in idle; the most common state.
//   movement : 15%  — split evenly across every movement variant the
//                      active pet's manifest declares (walking.* /
//                      running.*). On a pet without any movement
//                      assets this pool is empty and the 15% falls
//                      through to `other`.
//   other    : 15%  — split evenly across `loopVariants` entries that
//                      are neither `default` nor a movement variant
//                      (e.g. user-configured `greet` / `blink` /
//                      `dancing`). When `loopVariants` is empty
//                      (default config), this pool is empty and the
//                      unspent weight falls through to `default`.
//
// The user explicitly chose this distribution: "默认 50%, 移动 20%,
// 其它 30%" — meaning each *draw* lands on `default` 50% of the time,
// `movement` 20%, and any of the user's idle-loop variants 30%. These
// are **per-draw probabilities**, not screen-time shares.
//
// Note that because each draw produces a very different natural
// duration (default ≈ 0s, movement ≈ 6-12s, other ≈ 1.8-3s), the
// wall-clock time the pet spends in each category is **not** the
// same as the draw probability. To prevent the pet from busy-looping
// `default` re-rolls (which would make the default frames invisible)
// `default` rolls are held on screen for at least `DEFAULT_MIN_MS`
// before the controller re-rolls. Movement and other rolls play out
// their natural duration.
const DEFAULT_MIN_MS = 2500;
const DEFAULT_MAX_MS = 5000;
const LOOP_PROBABILITY = Object.freeze({
  default: 0.50,
  movement: 0.20,
  other: 0.30,
});

// Idle-window ranges used by `_chooseNextLoopAction`.
//
// The original design used long cool-downs (default 8~16s, walk 6~14s,
// run 8~18s, other 6~12s) so the pet looked "lazy" between actions. The
// user later asked to switch to **event-driven + per-cycle probability**:
// as soon as one action finishes, the controller rolls the dice for
// the next one with no separate "rest" timer — the visual pause between
// actions is just the natural duration of the `default` variant itself.
//
// We keep the per-action duration knobs from `MOVEMENT_PROFILES`, but
// every "idle" window below is **zero** — the user explicitly asked
// for pure event-driven + per-cycle probability: when an action
// finishes, the controller immediately re-rolls the dice for the next
// one. No cool-down, no breathing pause, no anti-repeat logic. The
// 50/30/20 distribution is what governs how often each kind fires; the
// renderer is idempotent on repeat `default` broadcasts (frames are
// cached, no flicker), so 50% of the time the pet just keeps showing
// default frames while the controller silently re-rolls.
//
// The legacy `IDLE_PICK_NEXT_*` / `POST_WALK_IDLE_*` / `POST_RUN_IDLE_*`
// / `POST_OTHER_IDLE_*` constants are kept exported (= 0) so any
// external code that imports them by name still resolves. Re-enable by
// setting them back to positive ranges if you want cool-downs again.
const IDLE_PICK_NEXT_MIN_MS = 0;
const IDLE_PICK_NEXT_JITTER_MS = 0;
const POST_WALK_IDLE_MIN_MS = 0;
const POST_WALK_IDLE_JITTER_MS = 0;
const POST_RUN_IDLE_MIN_MS = 0;
const POST_RUN_IDLE_JITTER_MS = 0;
const POST_OTHER_IDLE_MIN_MS = 0;
const POST_OTHER_IDLE_JITTER_MS = 0;

// `other` loop variants (the ones the user adds to loop_variants via
// /settings) don't have a built-in profile, so we use these fallbacks
// for "how long should the pet sit on this action".
const OTHER_VARIANT_MIN_MS = 1800;
const OTHER_VARIANT_MAX_MS = 3000;

// Returns the profile entry for `name` iff it's a recognized movement
// variant (including bare `walking`); otherwise null. Lets the controller
// pick speed / duration / target-distance uniformly for both the
// autonomous wander and user-triggered directional movement.
function getMovementProfile(name) {
  return Object.prototype.hasOwnProperty.call(MOVEMENT_PROFILES, name)
    ? MOVEMENT_PROFILES[name]
    : null;
}

// Resolve `{w, h}` for the renderer / window given a manifest's
// `defaultSize`. Both dimensions are the WINDOW box, padded beyond the sprite
// so bubbles have room to draw (see BUBBLE_HEADROOM_PX /
// BUBBLE_SIDE_ROOM_PX). `spriteW` / `spriteH` are the pet's own size within
// it — the renderer sizes the character from those, not from w/h.
//
// Falls back to a square window when the input is missing or malformed.
function petRenderSize(defaultSize) {
  const windowH = PET_RENDER_HEIGHT + BUBBLE_HEADROOM_PX;
  const w = (defaultSize && Number(defaultSize.w)) || 1;
  const h = (defaultSize && Number(defaultSize.h)) || 1;
  if (!(w > 0) || !(h > 0)) {
    const fallback = windowH;
    return { w: fallback, h: fallback, spriteW: PET_RENDER_HEIGHT, spriteH: PET_RENDER_HEIGHT };
  }
  const spriteW = Math.max(PET_RENDER_MIN_WIDTH, Math.round(PET_RENDER_HEIGHT * (w / h)));
  return {
    w: spriteW + BUBBLE_SIDE_ROOM_PX * 2,
    h: windowH,
    spriteW,
    spriteH: PET_RENDER_HEIGHT,
  };
}

// UI-level variants the controller emits. The vup resource set shipped
// ("Default" + "MOVE") provides only `default` / `walking` / `reminder`; the
// remaining keys (pat, greet, play, sleep, cuddle) are accepted here so
// manifest authors can declare them and ship resources later. Today the
// renderer turns these into a manifest `variants` lookup; if the manifest
// doesn't have the requested variant, the registry falls back to `default`
// and the CSS filter (driven by `data-mood`) carries the visual difference.
// Built-in pets ship `default` / `walking` / `reminder`; `pat`, `play`,
// `sleep`, `cuddle` are reserved by cozy_engine (tier-gated interactions).
// Anything else a manifest author declares (e.g. `blink`) is accepted too
// — the trigger_oneShot call below sends a `pet:action-changed` IPC, and
// the renderer falls back to the default frame set when resolveFrames
// can't find the variant (see pet_registry's tierForced branch).
const VALID_VARIANTS = new Set([
  'default', 'walking', 'reminder',
  'pat', 'greet', 'play', 'sleep', 'cuddle',
  // Compound directional movement keys — accepted as-is by
  // triggerOneShot's movement branch so we don't have to fall through to
  // the manifest check. The manifest still has to declare them for the
  // renderer to resolve frames.
  'walking.left', 'walking.right', 'running.left', 'running.right',
]);

class PetController {
  constructor({ winPet, db, petRegistry }) {
    this.win = winPet;
    this.db = db;
    this.petRegistry = petRegistry;
    this.timer = null;
    this.action = 'default';   // 'default' | 'walking' | 'reminder'
    this.actionDirection = 1;  // -1 = left, +1 = right
    this.actionStepVel = 1;    // px per tick while walking
    this.actionUntil = 0;
    // True while a user-triggered one-shot is playing. `tick()` skips its
    // autonomous re-roll entirely while this is set, so an action always
    // plays its full frame sequence and only ends when the renderer
    // reports `pet:action_ended` (which clears this flag).
    this._oneShot = false;
    // When `_oneShot` was set, so `tick()` can distinguish "still playing
    // a long animation" from "renderer went silent" after
    // ONE_SHOT_WATCHDOG_MS.
    this._oneShotStartedAt = 0;
    this._pickNextAt = 0;
    this.enabled = db.getSetting('pet_walk_enabled') !== '0';
    // Legacy `pet_species` is allowed during migration; map to a real pet id.
    const persistedPet = db.getSetting('pet_id')
      || (db.getSetting('pet_species') ? 'vup' : null);
    const knownIds = petRegistry ? petRegistry.list().map((p) => p.id) : [];
    this.petId = (persistedPet && knownIds.includes(persistedPet))
      ? persistedPet
      : (knownIds[0] || 'vup');
    if (petRegistry && this.petId && !db.getSetting('pet_id')) {
      db.setSetting('pet_id', this.petId);
    }
    this._reminderOn = false;
    // Bond tier 1..7, synced from main bond_engine on each scheduler tick.
    // Used to gate one-shot variants that require a higher tier.
    this.bondTier = 1;
    // Variants to cycle through while idle (action === 'default'). Defaults
    // to a single entry; the scheduler pushes the per-pet config every tick
    // (see pet_actions_config.loadConfig → setLoopVariants). `_variantCursor`
    // is advanced inside `_startRandomAction` so the same loop list round-
    // robins deterministically instead of random-shuffling on each pass.
    this.loopVariants = ['default'];
    this._variantCursor = 0;
    // Load the active pet's per-pet `pet_actions_config:<petId>` so the
    // idle loop reflects the user's saved variant list, not just `['default']`.
    // Without this, a pet that has 9 user-configured loop variants
    // (e.g. `imported-cb19789a4afbe952` with eating/dancing/blinking/...)
    // would still roll an empty `otherPool` on every cycle, and the 30%
    // "other" weight would silently fall through to `default` — making
    // every action except default/walking invisible on the pet.
    // The lazy require avoids a require cycle (pet_actions_config.js
    // already requires pet_controller.js for `getMovementProfile`).
    if (this.petId) {
      try {
        const petActionsConfig = require('./pet_actions_config');
        const cfg = petActionsConfig.loadConfig(this.db, this.petId);
        const filtered = petActionsConfig.filterAgainstManifest(cfg, this.petRegistry, this.petId);
        this.loopVariants = filtered.loop_variants;
      } catch (e) {
        // Best-effort: if the config load fails, fall back to ['default'].
        // Don't break controller construction over a bad config row.
        console.error('[pet_controller] ctor loadConfig failed:', e && e.message);
      }
    }
    // Window/CSS render size for the current pet. Recomputed on setPetId()
    // and used by _bounds() / _stepWalk() so the auto-walk clamp follows
    // the window when its width changes.
    let defaultSize = null;
    if (petRegistry) {
      const m = petRegistry.getManifest(this.petId);
      defaultSize = m && m.defaultSize;
    }
    const init = petRenderSize(defaultSize);
    this.renderW = init.w;
    this.renderH = init.h;
  }

  start() {
    if (this.timer) return;
    this._pickNextAt = Date.now() + 3000;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.broadcastAction();
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.db.setSetting('pet_walk_enabled', this.enabled ? '1' : '0');
    if (!this.enabled) {
      this.action = 'default';
      this.broadcastAction();
    }
  }

  // Bound from main/scheduler.js 1s tick — keeps `this.bondTier` in sync so
  // triggerOneShot can refuse tier-gated variants without an extra DB read.
  setBondTier(tier) {
    const t = Math.max(1, Math.min(7, (tier | 0) || 1));
    if (this.bondTier === t) return;
    this.bondTier = t;
  }

  // Replace the idle-loop variant list. Called by the scheduler every tick
  // (so the controller always sees the latest persisted config) and by the
  // settings page IPC handler (so the change is reflected immediately
  // without waiting for the next scheduler tick).
  //
  // If the new list is empty or missing 'default', we patch in 'default'
  // so the renderer never sits on a blank variant.
  setLoopVariants(variants) {
    const safe = Array.isArray(variants) && variants.length > 0
      ? variants.filter((v) => typeof v === 'string' && v)
      : ['default'];
    if (!safe.includes('default')) safe.push('default');
    // Compare to current list — avoid spurious broadcasts when the scheduler
    // re-applies the same value every second.
    if (this.loopVariants.length === safe.length &&
        this.loopVariants.every((v, i) => v === safe[i])) {
      return;
    }
    this.loopVariants = safe;
    // Reset the cursor to 0 so a freshly-saved config starts from the top.
    this._variantCursor = 0;
    // If we're currently in the default (idle) state, the user just edited
    // the loop — emit a fresh action-changed so the renderer re-resolves
    // frames against the new variant. Walking/reminder states are
    // unaffected (the loop only applies to default).
    if (this.action === 'default' && !this._reminderOn) {
      this.broadcastAction();
    }
  }

  // Pick the variant name to broadcast for the current `action` state.
  // Default-state variant comes from loopVariants[_variantCursor]; other
  // states pass through unchanged. Keeping this in one place makes the
  // "what variant am I playing right now" question answerable from a
  // single function instead of duplicating the logic in callers.
  currentVariantName() {
    if (this._reminderOn) return 'reminder';
    // The controller is the source of truth for what variant is playing
    // right now — `this.action` is set by `_chooseNextLoopAction` /
    // `triggerOneShot` to whatever was actually rolled. Movement
    // variants pass through verbatim (they have their own direction);
    // `default` uses the per-pet loop list cursor so the *default*
    // frames naturally rotate through the user's `loop_variants` (the
    // cursor is also driven by the `default` branch in
    // `_chooseNextLoopAction`). For anything else — an `other` variant
    // like `eating` / `dancing` / `hearting` rolled from the user's
    // loop list, or a one-shot variant from `triggerOneShot` — we
    // return `this.action` directly so the renderer actually plays
    // those frames instead of falling through to `default`.
    if (getMovementProfile(this.action)) return this.action;
    if (this.action === 'default') {
      const list = (this.loopVariants && this.loopVariants.length > 0)
        ? this.loopVariants : ['default'];
      let idx = this._variantCursor % list.length;
      if (idx < 0) idx = 0;
      return list[idx];
    }
    return this.action;
  }

  setPetId(id) {
    if (!this.petRegistry) return;
    const known = this.petRegistry.list().map((p) => p.id);
    if (!known.includes(id)) return;
    const prevPetId = this.petId;
    this.petId = id;
    this.db.setSetting('pet_id', id);
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('pet:pet-changed', { petId: id });
    }
    // Resize the window + broadcast the new render size so pet.js can
    // update its CSS variables. We keep the current x/y position so the
    // pet doesn't jump to a screen edge on switch.
    const manifest = this.petRegistry.getManifest(id);
    const newSize = petRenderSize(manifest ? manifest.defaultSize : null);
    if (newSize.w !== this.renderW || newSize.h !== this.renderH) {
      this.renderW = newSize.w;
      this.renderH = newSize.h;
      if (this.win && !this.win.isDestroyed()) {
        const [x, y] = this.win.getPosition();
        this.win.setBounds({ x, y, width: newSize.w, height: newSize.h });
        this.win.webContents.send('pet:size-changed', newSize);
      }
    }
    // **Per-pet loop list**: when the active pet changes, the idle
    // loop should pick up *that* pet's saved `pet_actions_config:<id>`
    // — different pets ship with different variant folders, so each
    // pet has its own user-configured `loop_variants` list. We load it
    // here (in addition to the IPC `pet:actions_config:save` path,
    // which handles user-driven edits) so a fresh app launch with the
    // imported pet already active gets the right list without the user
    // having to re-open settings.
    //
    // We lazily require `pet_actions_config` here to avoid a require
    // cycle (pet_actions_config.js already requires pet_controller.js
    // for `getMovementProfile`).
    if (id !== prevPetId) {
      try {
        const petActionsConfig = require('./pet_actions_config');
        const cfg = petActionsConfig.loadConfig(this.db, id);
        const filtered = petActionsConfig.filterAgainstManifest(cfg, this.petRegistry, id);
        this.setLoopVariants(filtered.loop_variants);
        this._variantCursor = 0;
        // Force the new action to be picked immediately so the pet
        // doesn't sit on the previous pet's frames after a switch.
        this.action = 'default';
        this.actionStepVel = 0;
        this.actionUntil = 0;
        this._pickNextAt = 0;
      } catch (e) {
        // Best-effort: if the config load fails, fall back to whatever
        // the previous pet had loaded. Don't break pet switching.
        console.error('[pet_controller] setPetId loadConfig failed:', e && e.message);
      }
    }
    this.broadcastAction();
  }

  // One-shot: renderer can ask the controller to fire a one-shot variant for
  // `ms` milliseconds, after which the underlying state resumes. Used for
  // click-triggered `reminder`, cozy right-click menu entries, and
  // directional movement. `opts.minTier` lets callers gate the request
  // behind the bond tier — useful for `pat` (tier>=5) or `cuddle`
  // (tier>=6) when you don't want IPC round-trips.
  //
  // Directional movement (`walking.left/right`, `running.left/right`) is a
  // special case: instead of just broadcasting, we also drive the
  // controller's internal motion state (action / direction / speed /
  // actionUntil) so `tick()` actually moves the window. Before applying
  // the profile we pre-flight the work area bounds and **reverse the
  // direction** when the pet is already at the matching edge — a `walking.left`
  // request at x=0 becomes `walking.right`, preserving the user's intent
  // (move, just not into the wall).
  //
  // **Preemption**: when the user triggers any one-shot while the pet is
  // mid-walk, the in-progress movement is **cancelled** before the new
  // action is applied. The user explicitly asked for this: cozy / right-
  // click actions must not be "interrupted" by an in-flight autonomous
  // walk — instead, the walk stops and the user action takes over. We
  // achieve this by clearing `actionUntil` so the next `tick()` no longer
  // routes through `_stepWalk`, and (for non-movement variants) by
  // setting `this.action = variant` so `tick()` doesn't accidentally fire
  // autonomous code mid-one-shot.
  //
  // All one-shots now carry `loop: false` on the wire so the renderer
  // plays the frame sequence **exactly once**. When the sequence
  // finishes, the renderer signals back via `pet:action_ended` →
  // `handleActionEnded()` → `_chooseNextLoopAction()`, which re-rolls
  // the loop by probability (default 70%, movement 15%, other 15%).
  //
  // Validation: built-in reserved names pass directly. Other variants are
  // accepted iff the active pet's manifest actually declares them — this
  // lets users wire up custom variants like `blink` / `wave` from imported
  // pets (the /settings 角色动作 editor surfaces whatever the manifest
  // exposes). Unknown variants fall through silently rather than throwing,
  // since the renderer's resolveFrames already handles missing variants via
  // the registry's tierForced fallback.
  triggerOneShot(variant, ms, opts) {
    if (!variant || typeof variant !== 'string') return;
    const minTier = (opts && opts.minTier) | 0 || 0;
    if (minTier > 0 && this.bondTier < minTier) return;

    // ---- Preempt any in-flight movement ----
    // If the controller is currently mid-walk (either the autonomous
    // wander loop emitted `walking`, or a previous directional trigger is
    // still in progress), drop `actionUntil` so the next tick() stops
    // calling `_stepWalk`. We don't reset `this.action` here — that's
    // the responsibility of the branch below.
    if (getMovementProfile(this.action)) {
      this.actionUntil = 0;
    }

    // ---- Directional movement branch ----
    let prof = getMovementProfile(variant);
    if (prof && prof.direction) {
      const b = this._bounds();
      if (!b || !this.win || this.win.isDestroyed()) return;

      // Edge pre-flight: if the requested direction would push the pet
      // into the wall immediately, swap to the opposite direction. We use
      // a 0.5 px tolerance to absorb float-rounding from setPosition.
      let effective = variant;
      const [x] = this.win.getPosition();
      const atLeftEdge  = x <= b.x + 0.5;
      const atRightEdge = x + this.renderW >= b.x + b.w - 0.5;
      if (prof.direction === 'left'  && atLeftEdge)  effective = `${prof.base}.right`;
      if (prof.direction === 'right' && atRightEdge) effective = `${prof.base}.left`;
      const eprof = getMovementProfile(effective);
      if (!eprof) return;

      const speed = eprof.minSpeedPxPerTick
        + Math.floor(Math.random() * (eprof.maxSpeedPxPerTick - eprof.minSpeedPxPerTick + 1));
      let durationMs;
      if (eprof.targetDistancePx) {
        const dist = eprof.targetDistancePx.min
          + Math.floor(Math.random() * (eprof.targetDistancePx.max - eprof.targetDistancePx.min + 1));
        durationMs = Math.max(1, Math.ceil(dist / speed)) * TICK_MS;
      } else {
        durationMs = eprof.minDurationMs
          + Math.floor(Math.random() * (eprof.maxDurationMs - eprof.minDurationMs));
      }

      this.action = effective;                                  // e.g. 'walking.left'
      this.actionDirection = DIRECTION_SIGN[eprof.direction];
      this.actionStepVel = speed;
      this.actionUntil = Date.now() + durationMs;
      // After the movement segment finishes, fall back to default for a
      // randomized cool-down before any further auto-walk is considered.
      this._pickNextAt = this.actionUntil + 4000 + Math.floor(Math.random() * 6000);

      this.win.webContents.send('pet:action-changed', {
        petId: this.petId,
        action: effective,
        direction: eprof.direction,
        oneShotMs: Math.max(durationMs, ms || 1500),
        loop: false,        // play the walk/run frames exactly once
        text: this._pickActionText(effective),
      });
      return;
    }

    // ---- Generic one-shot branch (non-movement variants) ----
    if (!VALID_VARIANTS.has(variant)) {
      const m = this.petRegistry && this.petRegistry.getManifest(this.petId);
      const declared = m && m.variants && Object.prototype.hasOwnProperty.call(m.variants, variant);
      if (!declared) return;
    } else {
      // Even if `variant` is in VALID_VARIANTS (a reserved cozy key),
      // verify the current pet's manifest actually exposes it. Otherwise
      // we'd broadcast e.g. `cuddle` to a pet whose manifest only ships
      // `default`/`walking`, and the renderer's resolveFrames call
      // throws "pet X has no variant cuddle" — leaking imported-pet
      // overrides into the default pet.
      const m2 = this.petRegistry && this.petRegistry.getManifest(this.petId);
      const declared2 = m2 && m2.variants && Object.prototype.hasOwnProperty.call(m2.variants, variant);
      if (!declared2 && variant !== 'default') return;
    }
    // Mirror the renderer state on the controller so `tick()` doesn't
    // accidentally re-route through the autonomous path while the user
    // one-shot is still playing.
    //
    // **Play length comes from the frames alone.** The caller's `ms` is
    // NOT an animation duration and never truncates anything — the
    // renderer plays the variant's full frame sequence and reports back
    // via `pet:action_ended`. We set `_oneShot` so `tick()` stays out of
    // the way until that report lands. `actionUntil` is kept only as a
    // diagnostic backstop (it also gates `_pickNextAt`); nothing reads it
    // to cut an animation short.
    const oneShotMs = Math.max(300, ms || 1500);
    this.action = variant;
    this.actionStepVel = 0;
    this.actionDirection = this.actionDirection || 1;
    this.actionUntil = Date.now() + oneShotMs;
    this._oneShot = true;
    // Lost-IPC watchdog. A one-shot normally ends when the renderer's
    // `onEnded` calls back; if that IPC is ever dropped (renderer crashed,
    // window reloaded) nothing would ever clear `_oneShot` and the pet
    // would sit frozen on that variant forever. This deadline is the only
    // thing that can end a one-shot without the renderer's say-so, so it
    // is deliberately far larger than any real animation — `dancing` is
    // 61 frames ≈ 12.2s, and pets with longer sequences exist. Five
    // minutes cannot cut a legitimate animation short; it only catches a
    // genuinely stuck one. `handleActionEnded()` clears it on the normal
    // path, so the common case never waits this long.
    this._oneShotStartedAt = Date.now();
    // Defer the next autonomous re-roll until well after this one-shot
    // is done; the renderer's onEnded handler will reset this earlier via
    // `handleActionEnded`, but having a backstop here keeps us sane if
    // the IPC round-trip ever drops.
    this._pickNextAt = this.actionUntil + 2000 + Math.floor(Math.random() * 2000);
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('pet:action-changed', {
        petId: this.petId,
        action: variant,
        direction: this.actionDirection > 0 ? 'right' : 'left',
        oneShotMs,
        loop: false,        // play cozy / idle-variant frames exactly once
        text: this._pickActionText(variant),
      });
    }
  }

  setPaused(ms) {
    this.db.setSetting('pet_paused_until', String(Date.now() + (ms || 0)));
  }

  // Called by the renderer when a one-shot (or movement segment) finishes
  // playing its frame sequence — `M.pet.actionEnded()` →
  // `ipcMain.handle('pet:action_ended')` → this method. Drops the
  // controller back to `default` and re-rolls the loop action by
  // probability. Idempotent: if we're already in `default` (e.g. the
  // renderer's onEnded fires after a reminder abort), we still re-roll
  // so a fresh `_pickNextAt` window starts.
  handleActionEnded() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this._reminderOn) {
      // Reminder state holds position and ignores autonomous actions.
      // Don't re-roll until the queue empties.
      return;
    }
    // The renderer finished a one-shot: its `onEnded` is the authoritative
    // end-of-animation signal, so hand off to the next action now.
    this._oneShot = false;
    this._oneShotStartedAt = 0;
    this.actionUntil = 0;
    this.actionStepVel = 0;
    this._chooseNextLoopAction();
  }

  _paused() {
    const raw = this.db.getSetting('pet_paused_until');
    if (!raw) return false;
    const until = parseInt(raw, 10);
    if (!until) return false;
    if (Date.now() < until) return true;
    return false;
  }

  _bounds() {
    if (!this.win || this.win.isDestroyed()) return null;
    const [x, y] = this.win.getPosition();
    const display = screen.getDisplayMatching({ x, y, width: this.renderW, height: this.renderH })
      || screen.getPrimaryDisplay();
    const wa = display.workArea;
    return { x: wa.x, y: wa.y, w: wa.width, h: wa.height };
  }

  // Total play time of one full pass through a variant's frame sequence
  // (Σ frames[i].ms from the manifest). The user noted that walking
  // variants with 15-18 frames and ~200ms each should play for ~3s,
  // not the hardcoded 6-12s the controller was using — so we now read
  // the actual frame timing from the registry instead of trusting
  // `MOVEMENT_PROFILES.min/maxDurationMs`. Falls back to a sane
  // default if the registry can't resolve (e.g. during startup, or if
  // the pet was uninstalled mid-run).
  _variantPlayMs(variant) {
    const FALLBACK = 3000;
    if (!this.petRegistry || !this.petId || !variant) return FALLBACK;
    let frames;
    try {
      const r = this.petRegistry.resolveFrames({ petId: this.petId, variant, bondTier: this.bondTier });
      frames = r && r.frames;
    } catch { return FALLBACK; }
    if (!frames || frames.length === 0) return FALLBACK;
    let total = 0;
    for (const f of frames) total += (f.ms || 0);
    return total > 0 ? total : FALLBACK;
  }

  // Pick a speech line for `action`, or null when the pet should stay
  // silent. The pool always contains an explicit "no text" candidate, so
  // this returns null even for an action the user bound lines to — that's
  // the intended behaviour, not a fallback (see pet_action_texts.js).
  //
  // Best-effort by design: a corrupt config row or a DB hiccup must never
  // stop the animation path, so any failure degrades to "the pet says
  // nothing", which is always a valid outcome.
  _pickActionText(action) {
    if (!this.db || !this.petId) return null;
    try {
      const cfg = petActionTexts.loadConfig(this.db, this.petId);
      return petActionTexts.pickText(action, cfg.texts);
    } catch (e) {
      console.error('[pet_controller] _pickActionText failed:', e && e.message ? e.message : e);
      return null;
    }
  }

  broadcastAction() {
    if (!this.win || this.win.isDestroyed()) return;
    // Resolve the variant name through currentVariantName so the default-
    // state branch rotates through the per-pet loop list. Walking and
    // reminder pass through unchanged.
    let action = this.currentVariantName();
    // The autonomous wander loop still emits bare `'walking'`, but the
    // bundled pet's manifest only declares per-direction assets
    // (`walking.left/right`). The registry is a plain key lookup, so we
    // compose the wire-side action to `walking.<direction>` here — that
    // way the renderer can resolve frames without us having to either
    // (a) ship a bare `walking/` asset dir, or (b) teach the registry to
    // transparently rewrite keys. Internal `this.action` stays bare
    // `'walking'` so `tick()` keeps routing through `_stepWalk` and the
    // autonomous flip-on-wall semantics still work.
    if (action === 'walking') {
      action = `walking.${this.actionDirection > 0 ? 'right' : 'left'}`;
    }
    this.win.webContents.send('pet:action-changed', {
      petId: this.petId,
      action,
      direction: this.actionDirection > 0 ? 'right' : 'left',
      text: this._pickActionText(action),
    });
  }

  // External API: scheduler can flip a "is the queue non-empty / has reminder"
  // flag and the controller will reflect that as `reminder` variant.
  setReminding(on) {
    const next = !!on;
    if (this._reminderOn === next) return;
    this._reminderOn = next;
    this.broadcastAction();
  }

  tick() {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.enabled) {
      if (this.action !== 'default') {
        this.action = 'default';
        this.broadcastAction();
      }
      return;
    }
    if (this._reminderOn) {
      // Reminder overrides autonomous motion; just hold position.
      return;
    }
    if (this._paused()) {
      return;
    }

    const now = Date.now();
    if (this.action === 'default') {
      if (now >= this._pickNextAt) this._startRandomAction();
      return;
    }
    // Anything with a movement profile (bare `walking` from the
    // autonomous loop, or `walking.left/right` / `running.left/right` from
    // triggerOneShot) drives `_stepWalk`. `_startRandomAction` continues
    // to emit bare `walking` for the wander loop.
    if (getMovementProfile(this.action)) {
      this._stepWalk();
      return;
    }
    // Non-movement action that's already exhausted its duration (e.g.
    // an `other` variant like `greet` / `blink` that was rolled by
    // `_chooseNextLoopAction`). This is what makes the loop
    // "event-driven + probability": every action naturally hands off to
    // the next roll, with no separate cool-down timer gating it.
    //
    // **One-shots never take this branch while they are playing.** An action's
    // play length is defined solely by its frame sequence (Σ frames[i].ms) —
    // the renderer plays it through and reports `pet:action_ended` when the
    // last frame lands. No external millisecond figure decides when an
    // animation stops, so a one-shot always completes.
    //
    // The one exception is the lost-IPC watchdog: if `_oneShot` has been
    // set for longer than `ONE_SHOT_WATCHDOG_MS` the renderer never called
    // back and the animation is stuck rather than merely long, so we roll
    // on. The threshold is minutes, not the animation's own length — it has
    // to be large enough that no real sequence can ever reach it, which is
    // what makes "only the frames end an animation" true in practice.
    if (this._oneShot) {
      if (Date.now() - this._oneShotStartedAt < ONE_SHOT_WATCHDOG_MS) return;
      console.warn(`[pet_controller] one-shot '${this.action}' produced no action_ended within ${ONE_SHOT_WATCHDOG_MS}ms; rolling on`);
      this._oneShot = false;
      // Re-roll directly rather than falling through to the `actionUntil`
      // check below — that timer is the caller's `ms`, which has long since
      // expired *or* may not have (a caller passing a very large `ms` would
      // otherwise leave the pet frozen for that whole span, the exact
      // outcome this watchdog exists to prevent).
      this._chooseNextLoopAction();
      return;
    }
    if (this.actionUntil && now >= this.actionUntil) {
      this._chooseNextLoopAction();
      return;
    }
  }

  // Pick the next action from the loop queue using the configured
  // probability distribution. Called by `tick()` when `action === 'default'`
  // and `_pickNextAt` is reached, and by `handleActionEnded()` whenever a
  // one-shot finishes.
  //
  // Sampling works by summing each pool's weight into a "thresholds" array
  // and picking `Math.random()` against it. Empty pools contribute 0 so
  // their weight is silently absorbed by `default` (which always has at
  // least 0.70). When both `movement` and `other` pools are empty, the pet
  // stays in `default` and `_pickNextAt` is pushed out to keep the timer
  // happy.
  _chooseNextLoopAction() {
    // Any loop-rolled action is controller-timed, not renderer-timed, so
    // it is not exempt from the autonomous re-roll. (Movement one-shots
    // go through `_stepWalk`, which re-rolls on its own duration and is
    // exempt via the `getMovementProfile` branch in `tick()` anyway.)
    this._oneShot = false;
    this._oneShotStartedAt = 0;

    // ---- Build the candidate pools ----
    // Movement pool: every compound key the active pet's manifest declares
    // that has a movement profile (walking.* / running.*). Excludes bare
    // `walking` because that's only used internally by the autonomous
    // wander — when an external user-facing "walk" cycle fires we use the
    // per-direction variant that the manifest actually ships.
    const movementPool = [];
    if (this.petRegistry) {
      const m = this.petRegistry.getManifest(this.petId);
      if (m && m.variants) {
        for (const key of Object.keys(m.variants)) {
          if (key !== 'default' && getMovementProfile(key)) movementPool.push(key);
        }
      }
    }
    // Other pool: every entry in the user's `loop_variants` that's neither
    // `default` nor a movement variant. `pet_actions_config` already strips
    // directional movement keys from `loop_variants`, so we just need to
    // recheck defensively in case a stale config slips through.
    const otherPool = [];
    if (Array.isArray(this.loopVariants)) {
      for (const v of this.loopVariants) {
        if (!v || v === 'default') continue;
        if (getMovementProfile(v)) continue;
        otherPool.push(v);
      }
    }

    // ---- Weighted roll ----
    // Single random pick — we don't even out across many cycles, but the
    // distribution averages out fast and a single sample per cycle keeps
    // the controller cheap.
    const r = Math.random();
    const movWeight = movementPool.length > 0 ? LOOP_PROBABILITY.movement : 0;
    const otherWeight = otherPool.length > 0 ? LOOP_PROBABILITY.other : 0;
    const defaultWeight = LOOP_PROBABILITY.default + (LOOP_PROBABILITY.movement - movWeight)
      + (LOOP_PROBABILITY.other - otherWeight);

    const cum = [
      { kind: 'default', threshold: defaultWeight },
      { kind: 'movement', threshold: defaultWeight + movWeight },
      { kind: 'other', threshold: defaultWeight + movWeight + otherWeight },
    ];

    let kind = 'default';
    if (r < cum[0].threshold) kind = 'default';
    else if (r < cum[1].threshold) kind = 'movement';
    else kind = 'other';

    const now = Date.now();
    if (kind === 'movement') {
      const variant = movementPool[Math.floor(Math.random() * movementPool.length)];
      const prof = getMovementProfile(variant);
      // Natural play time of the variant's frame sequence. The user
      // pointed out that with 15-18 frames at ~200ms each, walking
      // should naturally play for ~3s — not the hardcoded 6-12s. We
      // resolve the actual frame count + per-frame ms from the
      // registry and use that as the action duration. The pet then
      // moves at a speed that makes sense for *that* play length
      // (1 px/tick over 3s ≈ 30px; over 6s ≈ 60px), so the pet still
      // covers a visible chunk of screen without outrunning the loop.
      const playMs = this._variantPlayMs(variant);
      const ticks = Math.max(1, Math.round(playMs / TICK_MS));

      if (variant === 'walking') {
        if (Math.random() < 0.3) this.actionDirection *= -1;
        // Speed scaled so the pet covers ~30~60px in the natural play.
        this.actionStepVel = 1 + Math.floor(Math.random() * 2);
        this.action = 'walking';
        this.actionUntil = now + playMs;
        this._pickNextAt = this.actionUntil;
      } else {
        // walking.<dir> / running.<dir>: honour the direction encoded
        // in `variant`. Speed is derived from the natural play time
        // and the target distance (running) or fixed 1-2 px/tick
        // (walking). For running we keep the original "cover
        // `targetDistancePx` over the play time" semantics.
        const dir = prof.direction;
        const sign = DIRECTION_SIGN[dir] || 1;
        let speed;
        if (prof.targetDistancePx) {
          // Pick a target distance, then back-derive the speed so the
          // pet covers that distance in exactly `playMs`.
          const dist = prof.targetDistancePx.min
            + Math.floor(Math.random() * (prof.targetDistancePx.max - prof.targetDistancePx.min + 1));
          // ceil(dist / ticks) px/tick — at least 1 so the pet moves.
          speed = Math.max(1, Math.ceil(dist / ticks));
        } else {
          // Walking: 1-2 px/tick is the visual sweet spot the user
          // liked in the previous tuning. 1 px/tick over ~3s ≈ 30px,
          // over ~6s ≈ 60px — the pet noticeably moves but doesn't
          // rocket across the screen.
          speed = 1 + Math.floor(Math.random() * 2);
        }
        this.actionDirection = sign;
        this.actionStepVel = speed;
        this.action = variant;
        this.actionUntil = now + playMs;
        this._pickNextAt = this.actionUntil;
      }
      this.broadcastAction();
      return;
    }

    if (kind === 'other' && otherPool.length > 0) {
      const variant = otherPool[Math.floor(Math.random() * otherPool.length)];
      this.action = variant;
      this.actionStepVel = 0;          // no motion for "other" idle variants
      this.actionDirection = 0;        // visual direction is meaningless without motion
      // Natural play time of the variant — e.g. `dancing` (61 frames
      // × 200ms = 12.2s) plays in full, instead of being cut off at
      // the previous 1.8-3s `OTHER_VARIANT_MAX_MS` cap. The user
      // wanted each variant to play *its* animation, not a constant
      // arbitrary window.
      const playMs = this._variantPlayMs(variant);
      this.actionUntil = now + playMs;
      this._pickNextAt = this.actionUntil;
      this.broadcastAction();
      return;
    }

    // ---- default ----
    // Hold the default frames on screen for at least DEFAULT_MIN_MS
    // (up to DEFAULT_MAX_MS) before re-rolling. This gives the user a
    // visible "still" period between actions — without it, default
    // re-rolls happen on the very next tick (50% × 50% × 50%… chains
    // look fine statistically but the default frames are barely
    // visible because each roll is followed immediately by another).
    // The hold is implemented as `actionUntil`, so the existing
    // `tick()` branch
    //     if (this.actionUntil && now >= this.actionUntil) {
    //       this._chooseNextLoopAction();
    //     }
    // picks it up automatically.
    this.action = 'default';
    this.actionStepVel = 0;
    this.actionDirection = this.actionDirection || 1;
    this.actionUntil = now + DEFAULT_MIN_MS
      + Math.floor(Math.random() * (DEFAULT_MAX_MS - DEFAULT_MIN_MS));
    this._pickNextAt = this.actionUntil;
    this.broadcastAction();
  }

  // Backwards-compat shim — the old `_startRandomAction` name is referenced
  // from a few call sites (and from older comments). Redirecting keeps the
  // rename transparent.
  _startRandomAction() {
    this._chooseNextLoopAction();
  }

  _stepWalk() {
    if (Date.now() >= this.actionUntil) {
      // Walk finished (duration elapsed, not a wall bounce — wall bounces
      // just flip `actionDirection` and keep walking). Roll the dice
      // immediately for the next action. If it lands on `default` we'll
      // get a 2.2~4.0s breathing pause via the `default` branch's
      // `_pickNextAt`. If it lands on another movement we'll re-enter
      // `_stepWalk` next tick; if `other`, the broadcast already wired
      // the renderer.
      this._chooseNextLoopAction();
      return;
    }
    const b = this._bounds();
    if (!b) return;
    let [x, y] = this.win.getPosition();
    x = (x || 0) + this.actionDirection * this.actionStepVel;
    if (x < b.x) {
      x = b.x;
      this.actionDirection = 1;
    } else if (x + this.renderW > b.x + b.w) {
      x = b.x + b.w - this.renderW;
      this.actionDirection = -1;
    }
    // The window is taller than the pet by BUBBLE_HEADROOM_PX, and the sprite is
    // pinned to the window's BOTTOM — so the sprite's top edge is at
    // y + renderH - PET_RENDER_HEIGHT. Clamping the window's top instead
    // would let the pet be pushed a full headroom off the top of the screen.
    if ((y || 0) + this.renderH - PET_RENDER_HEIGHT < b.y) {
      y = b.y - this.renderH + PET_RENDER_HEIGHT;
    }
    if ((y + this.renderH) > b.y + b.h) y = b.y + b.h - this.renderH;
    this.win.setPosition(Math.round(x), Math.round(y), false);
  }
}

module.exports = {
  PetController,
  VALID_VARIANTS,
  petRenderSize,
  MOVEMENT_PROFILES,
  getMovementProfile,
};
