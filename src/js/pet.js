// src/js/pet.js — pet window: PNG-frame animator + drag/click/right-click +
// reminder UI. The legacy SVG species switcher is gone; the pet now plays
// PNG sequences resolved by the main process from each pet's manifest.
const M = window.mp;

const sprite = document.getElementById('pet-sprite');
const frame = document.getElementById('pet-frame');
const badge = document.getElementById('pet-badge');
const bubble = document.getElementById('pet-bubble');

// Bubble auto-fade timer — when a new head arrives we reset the timer so the
// bubble is re-showable even if it was mid-fade-out.
let bubbleFadeTimer = null;
const BUBBLE_VISIBLE_MS = 10_000;
const BUBBLE_FADE_MS = 600;

// Currently active pet and variant hint (for cache key).
let currentPetId = null;
let currentAction = 'default';
let currentDirection = 'right';
let currentVariantHint = '';

// LRU cache of preloaded <img> sets keyed by petId|variantHint. Capacity 20.
class FrameCache {
  constructor(capacity = 20) {
    this.cap = capacity;
    this.map = new Map();  // key -> HTMLImageElement[]
  }
  _key(petId, variantHint) { return `${petId}|${variantHint}`; }
  get(petId, variantHint) { return this.map.get(this._key(petId, variantHint)) || null; }
  put(petId, variantHint, imgs) {
    const k = this._key(petId, variantHint);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, imgs);
    while (this.map.size > this.cap) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  clear() { this.map.clear(); }
}
const cache = new FrameCache(20);

// Pre-create <img> objects so the browser can decode them off the hot path.
// Returns a Promise that resolves to the imgs list once all are decoded.
function preloadFrames(frames) {
  const imgs = [];
  let pending = 0;
  return new Promise((resolve) => {
    for (const f of frames) {
      const img = new Image();
      img.draggable = false;
      img.decoding = 'async';
      pending++;
      img.onload = img.onerror = () => {
        pending--;
        if (pending === 0) resolve(imgs);
      };
      img.src = f.url;
      imgs.push(img);
    }
    if (pending === 0) resolve(imgs);
  });
}

// FrameAnimator: plays a sequence of preloaded <img> elements by swapping
// the visible <img#pet-frame>. Uses setTimeout chain so a sequence switch
// cleanly cancels the previous chain. `loop` controls whether the sequence
// restarts; non-loop sequences call onEnded() once.
class FrameAnimator {
  constructor(displayImg) {
    this.img = displayImg;
    this.imgs = [];
    this.frames = [];           // [{url, ms}]
    this.loop = true;
    this.cursor = 0;
    this.timer = null;
    this.running = false;
    this.onEnded = null;
  }
  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.running = false;
  }
  async load(frames, imgs, loop) {
    this.stop();
    this.frames = frames;
    this.imgs = imgs;
    this.loop = loop !== false;
    this.cursor = 0;
    if (this.imgs.length > 0) this.img.src = this.imgs[0].src;
  }
  start() {
    if (this.running) return;
    if (this.frames.length === 0) return;
    this.running = true;
    this._tick();
  }
  _tick() {
    if (!this.running) return;
    const cur = this.frames[this.cursor];
    if (cur && this.imgs[this.cursor]) this.img.src = this.imgs[this.cursor].src;
    const next = this.cursor + 1;
    const ms = (cur && cur.ms) || 125;
    this.timer = setTimeout(() => {
      if (!this.running) return;
      if (next >= this.frames.length) {
        if (this.loop) {
          this.cursor = 0;
          this._tick();
        } else {
          this.running = false;
          if (this.onEnded) this.onEnded();
        }
      } else {
        this.cursor = next;
        this._tick();
      }
    }, ms);
  }
}
const animator = new FrameAnimator(frame);

// ---- Variant resolution ----
// Re-resolve every cycle so we get fresh random leaf picks (== the
// "随机风格变体轮播" decision). Cached preloads are reused.
//
// `opts.forceLoop` (when `false`) overrides the manifest's `loop: true` —
// used by the pet controller's one-shot path for movement actions so the
// walk/run frames play exactly once instead of cycling visually until the
// controller says otherwise.
async function playVariant(action, direction, opts = {}) {
  currentAction = action;
  currentDirection = direction;
  sprite.dataset.action = action;
  sprite.dataset.direction = direction;

  // Make sure we're working with the right pet id.
  if (!currentPetId) {
    try { currentPetId = await M.pet.getCurrent(); }
    catch { currentPetId = null; }
    if (currentPetId) sprite.dataset.pet = currentPetId;
  }
  if (!currentPetId) return;

  let resolved;
  try {
    resolved = await M.pet.resolveFrames(currentPetId, action, direction);
  } catch (e) {
    console.error('[pet] resolveFrames failed', action, e);
    return;
  }
  if (!resolved || !resolved.frames || resolved.frames.length === 0) return;
  // Bail if the variant changed while we were awaiting.
  if (currentAction !== action || currentDirection !== direction) return;

  currentVariantHint = resolved.variantHint || '';

  let imgs = cache.get(currentPetId, currentVariantHint);
  if (!imgs) {
    imgs = await preloadFrames(resolved.frames);
    cache.put(currentPetId, currentVariantHint, imgs);
  }
  if (currentAction !== action || currentDirection !== direction) return;

  // Honor an explicit `loop` override from the caller (typically from the
  // controller's `pet:action-changed` payload). Falls back to the
  // manifest's `loop: true` default when no override is supplied.
  const shouldLoop = (typeof opts.forceLoop === 'boolean')
    ? opts.forceLoop
    : (resolved.loop !== false);
  await animator.load(resolved.frames, imgs, shouldLoop);
  animator.onEnded = opts.onEnded || null;
  animator.start();
}

// ---- State / reminder UI ----
function setState(state, count, head) {
  sprite.dataset.state = state;
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
    if (head) {
      const parts = [];
      if (head.title) parts.push(head.title);
      if (head.contact_name) parts.push(head.contact_name);
      bubble.textContent = parts.join(' · ');
      bubble.classList.remove('hidden');
      bubble.classList.remove('fade');
      if (bubbleFadeTimer) clearTimeout(bubbleFadeTimer);
      bubbleFadeTimer = setTimeout(() => {
        bubble.classList.add('fade');
      }, BUBBLE_VISIBLE_MS);
    } else {
      bubble.classList.add('hidden');
    }
  } else {
    badge.classList.add('hidden');
    bubble.classList.add('hidden');
    bubble.classList.remove('fade');
    if (bubbleFadeTimer) { clearTimeout(bubbleFadeTimer); bubbleFadeTimer = null; }
  }
}

function clearReminderBubble() {
  bubble.classList.add('hidden');
  bubble.classList.remove('fade');
  if (bubbleFadeTimer) { clearTimeout(bubbleFadeTimer); bubbleFadeTimer = null; }
}

// ---- Drag implementation ----
const DRAG_THRESHOLD_PX = 4;
let pressing = false;
let didDrag = false;
let lastX = 0, lastY = 0, downX = 0, downY = 0;

sprite.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  pressing = true;
  didDrag = false;
  downX = e.screenX;
  downY = e.screenY;
  lastX = e.screenX;
  lastY = e.screenY;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!pressing) return;
  if (!didDrag) {
    if (Math.hypot(e.screenX - downX, e.screenY - downY) < DRAG_THRESHOLD_PX) return;
    didDrag = true;
    sprite.classList.add('dragging');
    try { M.pet.setPaused(2000); } catch {}
  }
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  M.pet.moveBy(dx, dy);
  lastX = e.screenX;
  lastY = e.screenY;
});

window.addEventListener('mouseup', async () => {
  if (!pressing) return;
  pressing = false;
  sprite.classList.remove('dragging');
  if (didDrag) return;
  // Non-drag single click is now a no-op — the main window is gated by a
  // 4-digit PIN and must be opened via right-click → "打开主窗口". We
  // still pause movement briefly for tactile feedback, and in REMINDER
  // state we dismiss the floating bubble (it would otherwise stay glued
  // to the pet until acknowledged).
  try { M.pet.setPaused(2000); } catch {}
  try {
    const s = await M.pet.getState();
    if (s && s.state === 'REMINDER') {
      clearReminderBubble();
    }
  } catch {}
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  M.pet.openContextMenu();
});

// ---- Bond / Cozy / Mood wiring ----
//
// Click → which variant fires is user-configurable from the settings page
// ("角色动作" 卡片). We cache the latest config in memory and refetch only
// when the pet changes (see the `pet:pet-changed` handler below) — every
// click doesn't round-trip the IPC. Cozy-reserved names (the right-click
// menu items) keep their legacy behavior, fired through `M.bond.*` so the
// cozy score side effect still applies; anything else goes through
// `pet:trigger_action` as a one-shot variant. The main-process
// `triggerOneShot` already has a tierForced fallback so unknown variants
// degrade to the default frame set without crashing the renderer.

// In-memory cache of the per-pet actions config. Refreshed on init and on
// `pet:pet-changed`. The click handler reads this without any await so it
// doesn't add latency to the pet's perceived response.
//
// Schema (v3):
//   _actionsCfg = { triggers: { click }, loop_variants: [...] }
let _actionsCfg = {
  triggers: { click: 'default' },
};

// Cozy-reserved names that route through the bond IPC (so cozy scores
// + cooldown still apply) instead of becoming a plain one-shot variant.
// These are no longer tier-gated — every one is available on a fresh pet.
// Anything else (a manifest-declared variant like `blink` / `greet`, or the
// always-present `default`) is fired as a one-shot via `M.pet.triggerAction`.
const COZY_KEYS = new Set(['pet', 'pat', 'feed', 'play', 'sleep', 'cuddle']);

async function refreshActionsCfg() {
  if (!M.pet || !M.pet.actionsConfig) return;
  try {
    const r = await M.pet.actionsConfig.get();
    if (r && r.config && r.config.triggers && typeof r.config.triggers === 'object') {
      _actionsCfg = r.config;
    }
  } catch (e) { /* leave previous cache in place */ }
}

// Fire the configured action for a given interaction id. The settings
// page maps each interaction (today: just `click`) to a variant name.
// The right-click menu entries have fixed particle+variant bindings and
// are NOT routed through this function — the right-click menu in
// main/ipc.js handles them directly.
function fireInteraction(interactionId) {
  const triggers = _actionsCfg && _actionsCfg.triggers;
  const v = triggers && triggers[interactionId];
  if (!v) return;
  if (COZY_KEYS.has(v)) {
    if (M.bond && typeof M.bond[v] === 'function') {
      try { M.bond[v](); } catch (e) { /* best-effort */ }
    }
    return;
  }
  if (M.pet && typeof M.pet.triggerAction === 'function') {
    try { M.pet.triggerAction(v, 1800); } catch (e) { /* best-effort */ }
  }
}

sprite.addEventListener('click', () => {
  fireInteraction('click');
});

// ---- Subscriptions from the main process ----
if (M.on) {
  M.on('pet:state-changed', (payload) => {
    setState(payload.state, payload.count, payload.head);
  });
  // Window resize: write the new render size into the CSS variables that
  // size .pet-root / .pet-sprite / .pet-frame / html+body. Fired when the
  // user switches pet in /settings (PetController.setPetId → setBounds).
  M.on('pet:size-changed', (payload) => {
    if (!payload || typeof payload.w !== 'number' || typeof payload.h !== 'number') return;
    const root = document.documentElement;
    root.style.setProperty('--size-w', `${payload.w}px`);
    root.style.setProperty('--size-h', `${payload.h}px`);
  });
  M.on('pet:pet-changed', (payload) => {
    if (payload && payload.petId && payload.petId !== currentPetId) {
      currentPetId = payload.petId;
      sprite.dataset.pet = currentPetId;
      // Drop cached preloads for the previous pet — they'll be rebuilt on
      // next play if needed.
      cache.clear();
      // Force-replay current action under the new pet.
      playVariant(currentAction, currentDirection);
    }
    // Re-read the click/dblclick mapping for the new pet so the next
    // user click resolves to a variant the new manifest actually has.
    refreshActionsCfg();
  });
  M.on('pet:action-changed', (payload) => {
    if (!payload) return;
    if (payload.petId && payload.petId !== currentPetId) {
      currentPetId = payload.petId;
      sprite.dataset.pet = currentPetId;
    }
    if (payload.oneShotMs && payload.action) {
      // One-shot: play the requested action for `oneShotMs` then notify
      // the controller via `pet:action_ended` so it can drop back to
      // `default` and re-roll the next loop action by probability
      // (default 70% / movement 15% / other 15%). The controller passes
      // `loop: false` for both movement and cozy one-shots, so the
      // frame sequence plays exactly once and `FrameAnimator.onEnded`
      // fires here when the last frame finishes — that's our
      // authoritative "action done" signal. The controller's
      // `actionUntil` timer is a defensive backstop for the rare case
      // where this IPC never lands.
      playVariant(payload.action, payload.direction || currentDirection, {
        forceLoop: (typeof payload.loop === 'boolean') ? payload.loop : undefined,
        onEnded: () => {
          if (M.pet && typeof M.pet.actionEnded === 'function') {
            try { M.pet.actionEnded(); } catch { /* best-effort */ }
          }
        },
      });
      return;
    }
    playVariant(payload.action, payload.direction);
  });

  // Mood broadcast — apply the data-mood attribute so CSS picks the
  // right filter. Also flash a soft bubble for happy_clingy / proud /
  // festive moods where pet_mood provided a line of text.
  M.on('pet:mood-changed', (payload) => {
    if (!payload) return;
    if (payload.mood) sprite.dataset.mood = payload.mood;
    const bondBubble = document.getElementById('pet-bond-bubble');
    const txt = payload.bubbleText || payload.bubble_text;
    if (bondBubble) {
      if (txt) {
        bondBubble.textContent = txt;
        bondBubble.classList.remove('hidden');
        // Auto-hide after 4s so the bubble doesn't pile up.
        clearTimeout(bondBubble._timer);
        bondBubble._timer = setTimeout(() => {
          bondBubble.classList.add('hidden');
        }, 4000);
      } else {
        bondBubble.classList.add('hidden');
      }
    }
  });

  // Cozy / bond-tier broadcasts — also route the cozy value to the data
  // attribute so future CSS hooks (e.g. hunger bar) can read it.
  M.on('pet:cozy-changed', (payload) => {
    if (!payload) return;
    if (typeof payload.value === 'number') sprite.dataset.cozy = String(Math.round(payload.value));
  });
  M.on('pet:bond-tier-changed', (payload) => {
    if (!payload) return;
    if (typeof payload.tier === 'number') sprite.dataset.bondTier = String(payload.tier);
  });

  // One-shot particles — append a transient <span> to the .pet-particles
  // layer. The CSS animation removes the element automatically after
  // floatUp finishes (we also drop it from the DOM to be safe).
  const particlesRoot = document.getElementById('pet-particles');
  M.on('pet:particle', (payload) => {
    if (!particlesRoot || !payload || !payload.char) return;
    const span = document.createElement('span');
    span.className = 'particle';
    span.textContent = payload.char;
    if (typeof payload.x === 'number' && typeof payload.y === 'number') {
      span.style.left = `${payload.x}%`;
      span.style.top = `${payload.y}%`;
    }
    particlesRoot.appendChild(span);
    setTimeout(() => {
      if (span.parentNode) span.parentNode.removeChild(span);
    }, 1500);
  });
}

// ---- Init ----
(async () => {
  try {
    const s = await M.pet.getState();
    setState(s.state, s.count, s.head);
    // Preload the per-pet click/dblclick config so the very first click
    // resolves to the user-picked variant instead of the legacy default.
    refreshActionsCfg();
    if (M.pet.getCurrent) {
      try { currentPetId = await M.pet.getCurrent(); } catch {}
    }
    if (currentPetId) sprite.dataset.pet = currentPetId;
    // Pull the current render size up-front so the CSS variables match the
    // window before the first frame paints (avoids a 220×220 → actual-size
    // flash on launch).
    if (M.pet.getCurrentSize) {
      try {
        const sz = await M.pet.getCurrentSize();
        if (sz && typeof sz.w === 'number' && typeof sz.h === 'number') {
          const root = document.documentElement;
          root.style.setProperty('--size-w', `${sz.w}px`);
          root.style.setProperty('--size-h', `${sz.h}px`);
        }
      } catch {}
    }
    playVariant('default', 'right');
  } catch (e) {
    console.error('pet init', e);
  }
})();
