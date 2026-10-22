// src/js/pet.js — pet window: PNG-frame animator + drag/click/right-click +
// reminder UI. The legacy SVG species switcher is gone; the pet now plays
// PNG sequences resolved by the main process from each pet's manifest.
const M = window.mp;

const sprite = document.getElementById('pet-sprite');
const frame = document.getElementById('pet-frame');
const badge = document.getElementById('pet-badge');
const bubble = document.getElementById('pet-bubble');
// Contextual bubble (吃饭提醒 / 休息提醒). Distinct from `bubble`
// above, which is the reminder-queue speech bubble. Both are drawn above the
// sprite; the contextual one carries a z-index so it wins when they collide.
const ctxBubble = document.getElementById('pet-text-bubble');

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

// ---- Contextual text bubble (main/pet_bubbles.js) ----
//
// The main process owns the *policy* — which bubble is due, what it says,
// and when it expires. This side only paints it and starts a self-expiry
// timer, which exists so the bubble disappears even if the main process
// stops ticking (e.g. the app is mid-quit and the interval is torn down
// before the next tick that would clear it).
//
// The payload is `{ text, kind, rule }`; `text: null` means "clear".
//
// Two producers share this one slot:
//   * the rule engine (吃饭提醒 / 休息提醒 / 说句话), via `pet:bubble-changed`
//   * the action picker (动作绑定的文本), via the `text` field on
//     `pet:action-changed`
// They coexist because the second only ever *adds* to the same bubble and
// the rule engine re-asserts its own text on every tick, so whichever is
// showing gets refreshed rather than flickering out.
const ACTION_TEXT_MS = 6_000;

// ---------------------------------------------------------------------------
// 文本框 sizing (see main/pet_text_boxes.js for where the numbers come from)
// ---------------------------------------------------------------------------
//
// The artwork is a canvas with the bubble in the middle band, so two things
// have to happen that a plain `background-image` wouldn't give us:
//
//   * The element is sized from the *text*, then the bubble's measured aspect
//     ratio sets its height. A fixed size made a 4-character line look lost in
//     a box sized for a sentence, and squashed the wide bubbles (5.png is
//     2.45:1) into the square the narrow ones want.
//   * The <img> is sized to the whole canvas and offset by the transparent
//     margins, so the drawn bubble — not the canvas — is what lands next to
//     the pet. Skipping this left ~25% of invisible padding under every
//     bubble, which is what made it look like it was floating away.
//
// ART_MIN_W / ART_MAX_W bound the text-driven width. The floor keeps a short
// line like "嗨" from producing a bubble too small to hold its frame artwork;
// the ceiling matches the CSS card's own wrapping behaviour.
const ART_MIN_W = 88;
const ART_MAX_W = 240;

// The artwork-mode text node's horizontal padding, mirrored from
// `.pet-bubble.has-art > .pet-bubble-text` in pet.css. The padding is not part
// of the text's own measured width, so the box has to add it back on both sides
// to hold the line. Kept as a constant rather than read from CSS because there's
// no cross-file channel for it and it is load-bearing for sizing; the CSS
// comment there says so too.
//
// There is deliberately no vertical counterpart: the box's height comes from the
// interior aspect (see applyArtGeometry), and the line count read from the DOM is
// what reserves vertical room. The only place it is added by hand is the
// last-resort floor for text that can't fit at any scale, where the alternative
// is clipping the user's line — see the note there.
const ART_TEXT_PAD_H = 14;

// The same padding on the vertical axis, used only by that last-resort floor.
const ART_TEXT_PAD_V = 2;

// How many doublings the bubble will make before it gives up on fitting the text
// by scaling. Bounded because a pathological input (a single unbreakable token in
// a very wide bubble) would otherwise loop toward an enormous box; at this point
// the `needH` floor takes over and the bubble simply grows tall enough.
const ART_MAX_GROW_STEPS = 6;

// A CJK glyph at the bubble's 13px font. Only the estimate path uses these two;
// anything with real layout measures instead. Mixed CJK/Latin text is a bit
// narrower per character than this on average (Latin letters are narrower, but
// in a CJK font most still advance a large fraction of an em), so treating the
// glyph as full width errs toward *under*-estimating capacity — the safe
// direction, since it wraps a line early rather than overflowing the white area.
const ART_CHAR_W = 13;

// Characters of slack to leave on every line.
//
// Sizing a line to exactly fill the interior leaves the first and last glyph
// hard against the drawn frame, and that is where the decoration is: 5.png's
// end-caps and 7.png's lace trim sit along the very edge of the white area, so
// a line sized to the full interior width overlaps them and the glyphs collide
// with the artwork. The interior measurement walks out from the centre and stops
// at the first *non-white* pixel, so it measures the frame line itself rather
// than a clear space inside it — meaning "fits the interior" and "fits between
// the decoration" are not the same width.
//
// Two characters is about 26px, which clears the frame stroke plus a little
// breathing room on each side. It costs one extra wrapped line on a long line,
// which the proportional growth below absorbs without changing the bubble's
// shape.
const ART_LINE_SLACK = 2;

// One line's height, from the 13px/1.5 font the bubble uses. Only needed when
// there's no layout to measure (see the fallback in applyArtGeometry); the
// wrapped-height calculation prefers the DOM's own height whenever it exists.
const ART_LINE_H = 20;

// How many lines the bubble holds before the whole thing scales up instead of
// wrapping further. Two lines is where a bubble stops reading as a bubble and
// starts reading as a paragraph; past it, growing the box keeps a reminder
// glanceable, which is what a bubble is for.
//
// This is the "fill the interior first, scale only when it's full" rule: the
// bubble is laid out to this many lines at the interior's own aspect, and scales
// proportionally only when the text needs more.
const ART_LINES_PER_BUBBLE = 2;

// Size the bubble and hand the CSS the geometry it needs.
//
// The ordering here is the whole trick. The bubble's **interior** aspect (`ia`,
// from main/pet_text_boxes.js) is the shape of the white area the text lives in
// — not `aspect`, which is the drawing including its wings, tails and lace trim.
// The two differ by 5–38%, and sizing to the drawing made every box too tall for
// its text, so the surplus showed up as empty space under the text rather than
// as a bubble that fit what it was saying.
//
// So: give the text every character the window allows, measure the lines the
// browser actually produced, and scale the bubble up only when that exceeds
// `ART_LINES_PER_BUBBLE`. The interior aspect is preserved at every step, which
// is what stops a long sentence turning into a letterbox.
function applyArtGeometry(box) {
  const b = ctxBubble;
  if (!b || !box) return;
  // A box with no geometry is unmeasured art, not a reason to skip the
  // artwork — fall back to the CSS default's proportions so the bubble still
  // appears (cropped approximately) instead of silently reverting to a plain
  // card when the user has deliberately chosen a text box.
  const g = box.geom || { left: 10, top: 25, right: 10, bottom: 25, aspect: 1.6, ia: 1.6, dx: 0, dy: 0 };

  // The interior's aspect, with the drawing's as a backstop for an older cached
  // geometry row that predates the split. Same fallback main/pet_text_boxes.js
  // makes, so the two agree on what an unmeasured box looks like.
  const ia = (Number.isFinite(g.ia) && g.ia > 0) ? g.ia : (g.aspect || 1.6);

  const textEl = document.getElementById('pet-bubble-text');
  if (!textEl) return;
  const raw = textEl.textContent || '';
  const padBox = ART_TEXT_PAD_H * 2;

  // Measure with the artwork *on*, so the text node is inside the same grid the
  // bubble will use and reports the width it will actually lay out at.
  //
  // Measuring with `has-art` removed — which is what this used to do — reports
  // the text's single unwrapped line, because with no artwork constraint the node
  // has no reason to wrap at all. Every downstream number came from a width the
  // text never occupied, and the browser then re-wrapped it into the clamped box
  // afterwards, wherever it liked. That mismatch is why breaks landed at four
  // characters regardless of how much room the box actually had.
  //
  // The width is cleared first so this re-measures from scratch: leaving the
  // previous line's width in place would wrap a shorter new line against a
  // constraint sized for the old one.
  b.classList.add('has-art');
  b.style.width = '';
  b.style.height = '';

  // Start from the widest the bubble may get and let the text's own measured
  // width pull it back down. The text node is stretched to the grid track (see
  // `justify-self: stretch` in pet.css — that's what makes centring work), so the
  // *node* measures as wide as the box no matter how short the line is. Reading
  // the node's width would therefore always return this maximum, which is what
  // left a two-character line sitting in a box sized for sixteen.
  //
  // `range` is the escape hatch: an inline range wraps the same text content and
  // reports its *ink* width, which is unaffected by the node's box, the grid
  // track, or the padding. Its width is the text as it would lay out on one
  // line — exactly the "how wide does this need to be" number the bubble wants.
  let textW = 0;
  try {
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const rects = range.getClientRects();
    // The widest line box. A range over wrapped content reports one rect per
    // line, and the widest of those is the line that sets the natural width.
    let widest = 0;
    for (const r of rects) if (r.width > widest) widest = r.width;
    textW = widest;
  } catch {
    textW = 0;   // no layout, or a detached node — the estimate below covers it
  }

  const textH = textEl.getBoundingClientRect().height;

  let lines = 1;
  let finalW;
  // Width of the widest line the box has to hold, *without* the slack — the
  // measured one on the layout path, the estimate on the fallback. Kept under
  // one name so the slack floor below is applied identically either way.
  let lineW;

  if (textW > 0 && textH > 0) {
    // The node reports its own padding, so the block height is a whole number of
    // lines. Rounding to nearest (not up) is right here: the node is exactly one
    // line-height per line, and `Math.round` keeps a single line from reporting
    // two.
    lines = Math.max(1, Math.round(textH / ART_LINE_H));
    // Hug the rendered text horizontally, plus the node's own padding — the
    // padding is not in the range's rects but is part of what the box must hold.
    //
    // `textW` is the widest *line as rendered*, so it never exceeds what already
    // fits. The slack is subtracted per character rather than as a flat width so
    // it scales with the line: what matters is that the first and last glyphs sit
    // clear of the frame, and that distance is measured in characters.
    const slackPx = ART_LINE_SLACK * ART_CHAR_W;
    lineW = textW;
    finalW = Math.max(ART_MIN_W, Math.min(ART_MAX_W, Math.round(textW + padBox + slackPx)));
  } else {
    // No layout available (hidden ancestor, or a non-rendering environment such
    // as a headless test). Scale by the text's character count, which is all we
    // can know here and is far better than a fixed box.
    const estW = Math.max(ART_MIN_W, Math.min(ART_MAX_W, padBox + raw.length * ART_CHAR_W));
    finalW = estW;
    lineW = Math.min(raw.length, ART_MAX_GROW_STEPS * ART_MAX_W) * ART_CHAR_W;
    // The same `ART_LINE_SLACK` the measured path applies, for the same reason:
    // a line sized to the exact interior width puts its outermost glyphs on the
    // frame, where some of these drawings carry decoration.
    const charsPerLine = Math.max(1, Math.floor((estW - padBox) / ART_CHAR_W) - ART_LINE_SLACK);
    lines = Math.max(1, Math.ceil(raw.length / charsPerLine));
  }

  // Scale the *whole* bubble up rather than letting the box grow tall and thin.
  //
  // The interior aspect is the thing held fixed. Growing width and height by the
  // same factor is what "等比" means here, and it keeps the drawn frame's shape
  // identical — only bigger — which is what makes these read as one set of
  // artwork rather than seven differently-stretched ones.
  //
  // The factor is *solved for*, not guessed from the line count. A box scaled by
  // `f` holds `(f*w / ia) / ART_LINE_H` lines, but only while the width cap
  // isn't binding — and it usually is, since the text was just measured against
  // `ART_MAX_W`. Assuming capacity scales linearly with `f` (the old
  // `ceil(lines / ART_LINES_PER_BUBBLE)`) under-sized the bubble and clipped the
  // last line on the wide bubbles, where 5.png's 3.38:1 interior needs to grow
  // more than twice to gain the same room. Solving the inequality directly keeps
  // the guarantee "the text fits" independent of the aspect.
  let grow = Math.max(1, Math.ceil(lines / ART_LINES_PER_BUBBLE));
  for (let i = 0; i < ART_MAX_GROW_STEPS; i++) {
    const w2 = Math.round(finalW * grow);
    const h2 = Math.round(w2 / ia);
    if (h2 / ART_LINE_H >= lines) break;
    grow++;
  }

  // Scaling `finalW` up carries the slack up with it — and where the width cap
  // is the binding constraint, it cancels the slack out exactly, leaving the
  // outermost glyphs hard against the frame. That is the collision ART_LINE_SLACK
  // exists to prevent, reintroduced by the growth that was meant to absorb it.
  //
  // So re-assert the slack on the scaled width rather than trusting the scaled
  // one: a line is only ever allowed to fill its box down to the slack. This is
  // what lets the guarantee hold at every line length — the bubble grows to keep
  // holding `lines`, and it keeps its clearance while it grows. Beyond
  // ART_MAX_W * ART_MAX_GROW_STEPS the text no longer fits at the slack, and
  // ART_TEXT_FLOOR below takes over rather than clipping it.
  finalW = Math.round(finalW * grow);
  const slackPx = ART_LINE_SLACK * ART_CHAR_W;
  const floorW = Math.max(ART_MIN_W, Math.round(lineW + padBox + slackPx));
  finalW = Math.max(ART_MIN_W, Math.min(ART_MAX_W * ART_MAX_GROW_STEPS, Math.max(finalW, floorW)));

  // Height from the interior aspect, so the white area is filled exactly and the
  // text sits centred in it. `grow` has already reserved the room for `lines`,
  // so this is the whole story — the measured block height is not needed as a
  // floor, and keeping it as one is what let the box break its own ratio.
  //
  // The floor is kept only for text that is genuinely taller than the aspect
  // allows at any scale (a very narrow bubble, or a long word that can't wrap).
  // It breaks the ratio, but the alternative is cutting the user's text off, and
  // unreadable text is a worse failure than a slightly tall bubble.
  const aspectH = Math.round(finalW / ia);
  const needH = Math.round(lines * ART_LINE_H + ART_TEXT_PAD_V);
  const finalH = Math.max(aspectH, needH);

  b.style.width = `${finalW}px`;
  b.style.height = `${finalH}px`;
  setArtScale(b, g, finalW, finalH);
}

// The canvas-to-bubble conversion, shared by the measured and fallback paths.
//
// ---------------------------------------------------------------------------
// Why the two axes need different scales
// ---------------------------------------------------------------------------
//
// The element is sized to the *interior's* aspect (`ia`), because that is the
// shape of the white area the text sits in. The drawing inside the canvas has its
// own aspect, and the two are not equal: 1.png's element is 1.611 while its
// drawing is 1.497. A single uniform `scale(k)` preserves the drawing's own
// aspect, so it can never exactly fill a box of a different aspect — one axis
// always overhangs. Unifying both axes on the same factor (what this used to do,
// taking the smaller of the two so nothing would be cropped) therefore left the
// artwork sticking out on one side, and since the text centres on the *box*, the
// visual result was the text sitting off to one side of the bubble.
//
// Scaling each axis by its own reciprocal instead makes the visible drawing
// exactly cover the element in both axes — the box and the drawn bubble become
// the same rectangle, which is the whole premise of this mode.
//
// The scale is applied with `width`/`height` rather than `transform`, so the
// offsets below are in the same units and are not scaled a second time.
function setArtScale(b, g, w, h) {
  const visibleW = (100 - g.left - g.right) / 100;
  const visibleH = (100 - g.top - g.bottom) / 100;
  // The canvas size at which its visible region exactly fills the box.
  const canvasW = w / visibleW;
  const canvasH = h / visibleH;
  b.style.setProperty('--art-w', `${canvasW.toFixed(2)}px`);
  b.style.setProperty('--art-h', `${canvasH.toFixed(2)}px`);
  // Offsets are a fraction of the *canvas*, and the canvas is now this size, so
  // the percentages finally mean what they were measured to mean.
  b.style.setProperty('--art-left', `${(-(g.left / 100) * canvasW).toFixed(2)}px`);
  b.style.setProperty('--art-top', `${(-(g.top / 100) * canvasH).toFixed(2)}px`);
  // -------------------------------------------------------------------------
  // The text offset is a *third*, separate correction — neither of the crop
  // numbers above. Those locate the whole drawing; the text wants the white
  // interior, and the two aren't concentric: 1.png's bat wings hang above its
  // bubble and dangles a cross below, so the drawing's centre sits well above
  // the middle of the white area.
  //
  // Each axis is scaled by *its own* dimension. `dx` is a fraction of the
  // drawing's width and `dy` of its height, so multiplying both by `w` — as this
  // originally did — only worked by accident, while the drawings were nearly
  // square. Now that the box follows the interior's aspect (1.5–3.4:1), applying
  // `w` to both would leave the vertical correction wrong by exactly that ratio,
  // which is what kept multi-line text sitting high in the bubble.
  // -------------------------------------------------------------------------
  b.style.setProperty('--text-dx', `${((g.dx || 0) * w).toFixed(2)}px`);
  b.style.setProperty('--text-dy', `${((g.dy || 0) * h).toFixed(2)}px`);
}

// The bubble kind currently painted, so a silent action can clear "its own"
// bubble without swallowing a live rule bubble. See clearActionBubbleIfMine.
function clearActionBubbleIfMine() {
  if (!ctxBubble || ctxBubble.dataset.kind !== 'action') return;
  ctxBubble.classList.add('hidden');
  ctxBubble.classList.remove('fade');
  ctxBubble.dataset.kind = '';
  clearTimeout(ctxBubble._timer);
  // The artwork has to be dropped too, not just hidden. Leaving `has-art` on
  // would keep the bubble in its fixed-square geometry, so the next line the
  // pet says (which may have no box of its own) would come back clipped or
  // floating in a stale frame. See clearBubbleArt.
  clearBubbleArt();
}

// Drop the 文本框 artwork and go back to the CSS card.
//
// Both the box attribute and the <img> src are cleared, not just hidden: the
// bubble's geometry is entirely different between the two modes (a CSS card
// hugs its text, an image bubble is a fixed-size box), so leaving a stale src
// would make the next bubble come back the wrong shape. Clearing the src
// rather than setting a 1×1 placeholder also releases the decoded bitmap —
// seven 2048×2048 PNGs is tens of MB the renderer would otherwise hold for
// the life of the process.
function clearBubbleArt() {
  if (!ctxBubble) return;
  ctxBubble.dataset.box = '';
  ctxBubble.classList.remove('has-art');
  // Drop the measured size too, not just the class. A stale inline width would
  // survive the next box change and size that bubble to the *previous* line,
  // which is exactly the fixed-size behaviour this replaced.
  ctxBubble.style.width = '';
  ctxBubble.style.height = '';
  ctxBubble.style.removeProperty('--art-left');
  ctxBubble.style.removeProperty('--art-top');
  ctxBubble.style.removeProperty('--art-w');
  ctxBubble.style.removeProperty('--art-h');
  ctxBubble.style.removeProperty('--art-scale');
  // The interior offset is measured per-box, so a leftover value from the
  // previous box would shift this bubble's text by a correction meant for a
  // different drawing.
  ctxBubble.style.removeProperty('--text-dx');
  ctxBubble.style.removeProperty('--text-dy');
  const art = document.getElementById('pet-bubble-art');
  if (art) art.removeAttribute('src');
}

function showContextBubble(payload) {
  if (!ctxBubble) return;
  clearTimeout(ctxBubble._timer);
  if (!payload || !payload.text) {
    ctxBubble.classList.add('hidden');
    ctxBubble.classList.remove('fade');
    ctxBubble.dataset.kind = '';
    clearBubbleArt();
    return;
  }

  // The 文本框 travels with the line it belongs to. Both producers send it on
  // the same payload (the controller with `pet:action-changed`, the rule engine
  // with `pet:bubble-changed`), so a box can never end up painted around
  // somebody else's line. `box: null` — the default, or an id that no longer
  // resolves on this machine — falls back to the CSS card.
  //
  // A no-box payload explicitly clears the artwork rather than leaving the
  // previous bubble's box in place; otherwise switching an action back to the
  // default box would leave the old image up around the new text.
  const box = payload.box || null;

  const textEl = document.getElementById('pet-bubble-text');
  if (textEl) textEl.textContent = payload.text;

  if (box && box.url) {
    ctxBubble.dataset.box = box.id || '';
    const art = document.getElementById('pet-bubble-art');
    // `src` is only assigned when it differs, so re-showing the same bubble
    // every second (the rule engine re-asserts its text each tick) doesn't
    // restart the image decode and flicker the artwork.
    if (art && art.getAttribute('src') !== box.url) art.setAttribute('src', box.url);
    // Sized *after* the text is set, because the width comes from the laid-out
    // text — measuring before it is in the DOM would size the box to the
    // previous line.
    applyArtGeometry(box);
  } else {
    clearBubbleArt();
  }

  ctxBubble.dataset.kind = payload.kind || '';
  ctxBubble.classList.remove('hidden', 'fade');
  // Self-expiry backstop. 1h is the framework's default duration; the main
  // side sends the authoritative clear well before this fires in the normal
  // case, so this is only a safety net against a missed broadcast.
  const ttl = (Number(payload.durationMs) || 60 * 60_000) + 30_000;
  ctxBubble._timer = setTimeout(() => {
    ctxBubble.classList.add('fade');
    setTimeout(() => ctxBubble.classList.add('hidden'), 600);
  }, ttl);
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
    // --size-* is the whole window (sprite + bubble headroom/side room).
    // --sprite-* is the pet's own box within it; without them the pet would
    // stretch to fill the padding. Fall back to the window size so an older
    // main process (no spriteW/spriteH in the payload) still paints sanely.
    root.style.setProperty('--sprite-w', `${payload.spriteW || payload.w}px`);
    root.style.setProperty('--sprite-h', `${payload.spriteH || payload.h}px`);
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
    // 动作自带文本 (main/pet_action_texts.js). The controller sends one
    // line with every action it starts, already randomly chosen from the
    // user's bound texts — or `null`, which is a real outcome and happens
    // even for an action with texts bound ("不展示文本" is always one of
    // the candidates). Showing it here, in the same bubble slot the rule
    // engine uses, means an action line and a reminder line never fight
    // over two different cards.
    //
    // `kind: 'action'` gets its own accent in pet.css so the user can tell
    // "my pet decided to say this" from "the 吃饭提醒 fired".
    if ('text' in payload) {
      if (payload.text) {
        // `box` rides along: the controller resolves the action's 文本框 to a
        // file:// URL (or null for the CSS default) and sends it on the same
        // payload as the line it belongs to.
        showContextBubble({
          text: payload.text,
          kind: 'action',
          durationMs: ACTION_TEXT_MS,
          box: payload.box || null,
        });
      } else {
        // No line for this play. Clear only if the bubble is currently
        // showing an *action* line — a live rule bubble (吃饭提醒) must
        // survive an action that happened to roll silence, or the pet
        // would flicker its reminder away mid-hour.
        clearActionBubbleIfMine();
      }
    }
    if (payload.oneShotMs && payload.action) {
      // One-shot: play the requested action through to the end of its
      // frame sequence, then notify the controller via `pet:action_ended`
      // so it can drop back to `default` and re-roll the next loop action
      // by probability (default 70% / movement 15% / other 15%).
      //
      // `oneShotMs` is used here ONLY as a truthiness marker that
      // distinguishes a one-shot from a plain loop broadcast — it is not
      // a timer. The animation's length is decided entirely by the frames
      // themselves (Σ frames[i].ms inside `FrameAnimator`), so an action
      // always plays in full no matter what number the controller sent.
      // The controller passes `loop: false` for both movement and cozy
      // one-shots, so the sequence plays exactly once and `onEnded` fires
      // when the last frame finishes — the authoritative "action done".
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

  // Contextual text bubble (吃饭提醒 / 休息提醒). Entirely
  // rule-driven from the main process — see main/pet_bubbles.js. This
  // handler is intentionally dumb so adding a rule requires no renderer
  // change at all.
  M.on('pet:bubble-changed', (payload) => {
    showContextBubble(payload);
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
          root.style.setProperty('--sprite-w', `${sz.spriteW || sz.w}px`);
          root.style.setProperty('--sprite-h', `${sz.spriteH || sz.h}px`);
        }
      } catch {}
    }
    playVariant('default', 'right');
  } catch (e) {
    console.error('pet init', e);
  }
})();
