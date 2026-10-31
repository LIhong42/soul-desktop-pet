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
//
// The reminder the pet is currently nagging about, as `{ source, source_id }`.
// The main process sends the head's identity on every `pet:state-changed`
// payload, so the pet window can acknowledge exactly that reminder when the
// user closes it.
//
// This is what makes "关闭提醒" possible at all: without the ids the
// window could only hide its own bubble, and the nag stayed on — badge
// counting, sprite shaking, top-bar pill still reading 桌宠提醒.
let currentReminder = null;

function setState(state, count, head) {
  sprite.dataset.state = state;
  // Remember which reminder the badge/bubble are showing, so a click on
  // the pet (or on the bubble) completes the right one. Cleared as soon as
  // nothing is pending, so a stale id can never be completed by a later
  // click.
  currentReminder = (count > 0 && head && head.source && head.source_id != null)
    ? { source: head.source, source_id: head.source_id }
    : null;
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
    if (head) {
      const parts = [];
      if (head.title) parts.push(head.title);
      if (head.contact_name) parts.push(head.contact_name);
      // A date that's counting down carries its countdown in the bubble:
      // "刘杰的生日 · 还有 3 天". days_left is null for every other kind
      // of reminder, which leaves the bubble unchanged.
      if (head.days_left != null) {
        parts.push(head.days_left === 0
          ? '就是今天'
          : head.days_left === 1
            ? '就在明天'
            : `还有 ${head.days_left} 天`);
      }
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

// Close the reminder the pet is nagging about.
//
// "Close" means the same soft-dismiss the main window's 完成 button
// performs: the pet stops nagging (badge off, no shake, top-bar pill back
// to 桌宠正常) while the entry stays on the 今日 page so the user can still
// scroll back and confirm what they finished.
//
// The decision belongs to the main process — it owns the queue and the ack
// table — so this side only asks. The main process answers with a
// `pet:state-changed` broadcast, and that is what actually clears the badge.
async function dismissCurrentReminder() {
  const r = currentReminder;
  if (!r) {
    // Nothing to acknowledge (the nag is already gone). Just drop the
    // bubble so the pet stops showing a headline that is no longer true.
    clearReminderBubble();
    return;
  }
  // Cleared BEFORE the await, so a second click — or a click that lands
  // while the main process is still answering — cannot fire a second
  // dismissal for the same reminder.
  currentReminder = null;
  try {
    await M.reminders.completeForToday(r.source, r.source_id);
  } catch (e) {
    // Put it back so the user can try again, and leave the bubble up —
    // the reminder is still pending.
    console.error('[pet] could not close the reminder', e);
    currentReminder = r;
    return;
  }
  badge.classList.add('hidden');
  clearReminderBubble();
}

// The bubble is the visible face of the nag, so clicking it is the most
// explicit way to turn it off.
//
// The badge stays `pointer-events: none`: it sits over the pet's shoulder,
// which is exactly where people grab the pet to drag it, and a badge that
// swallowed the pointerdown would break the drag. A click that lands on
// the badge still reaches the sprite underneath, so clicking the number
// closes the reminder all the same — it just also plays the pet's usual
// click reaction.
//
// A drag that ends over the bubble does not fire a click (the press and
// the release land on different elements, so the click targets their
// common ancestor), so this cannot fire in the middle of a drag.
bubble.addEventListener('click', (e) => {
  e.stopPropagation();
  dismissCurrentReminder();
});

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
//   * the rule engine (吃饭提醒 / 休息提醒), via `pet:bubble-changed`
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
//
// Four layers, because each naive version had a failure mode that made the
// pet undraggable for the rest of the session:
//
//   1. **Pointer capture + an explicit end-of-gesture reset.** The pet window
//      is `focusable: false` and only ~220 px across, so a `mouseup` that
//      happens outside that rectangle never reaches the renderer. The old
//      code left its `pressing` flag stuck true forever, and every later
//      mouse move inside the window then computed its delta against a stale
//      baseline — teleporting the pet across the screen and leaving
//      drag permanently broken.
//
//   2. **Main-process cursor tracking.** Once the pointer leaves the pet's
//      rectangle, the renderer stops receiving `mousemove` at all — the
//      window is simply not under the cursor any more. The main process
//      solves this by polling `screen.getCursorScreenPoint()`, which reports
//      the pointer's absolute position regardless of what has focus. It owns
//      the window position for the duration of the drag.
//
//   3. **A renderer fallback for an older main process.** If `pet:drag_start`
//      isn't available, the renderer falls back to reporting relative deltas
//      itself — the original behaviour. It only works while the pointer
//      stays inside the window, but it is strictly better than a pet that
//      cannot be dragged at all.
//
//   4. **Self-healing on a pointer-identity change** (added after the
//      "undraggable after a real sleep" report). This is the layer that
//      makes the drag survive a suspend, and it deliberately does NOT depend
//      on the OS telling us that a sleep happened.
//
//      The mechanism it defends against: a system suspend tears down and
//      re-creates the pointer device. On wake the mouse reports a NEW
//      `pointerId`. The gesture's `dragPointerId` still names the OLD (now
//      dead) id, so the guard
//
//          if (dragPointerId !== null && e.pointerId !== dragPointerId) return;
//
//      rejects every single event from the new mouse — forever. The pet is
//      not "stuck mid-drag": it is wedged in a state where no pointer event
//      can ever start a new gesture, because a fresh `pointerdown` is the
//      only thing that clears it and that handler is unreachable for the
//      gesture in flight.
//
//      The fix is to treat "an event arrived whose pointer id is not the one
//      I captured" as proof that the pointer device was re-created, and to
//      act on it according to how far the gesture has got:
//
//        * Before the drag threshold, the pet has not moved, so the gesture
//          is REBOUND to the new pointer (see `rebindToPointer`). The drag
//          can still begin, and following a different pointer cannot make
//          the pet jump.
//
//        * Once the drag is under way, the pet is being moved by the user,
//          so the gesture is torn down instead: a second device must not
//          take the drag over. The next press starts a clean gesture.
//
//      Tearing down in BOTH cases is what wedged the pet: the press
//      carried the old id and every move carried the new one, so the press
//      was killed by the move that followed it, over and over.
//
//      This is event-driven rather than lifecycle-driven on purpose. The
//      main process also listens for `powerMonitor`'s `resume`, but that
//      event is not dependable on Windows 11 Modern Standby (the OS freezes
//      the process before the event is delivered, electron/electron#47739),
//      and a plain lid-close without a lock screen may produce no
//      `unlock-screen` either. If the recovery only ran on those events, the
//      pet would stay wedged — which is exactly what the original bug
//      report describes.
//
//   5. **Coordinates that cannot go stale.** The grab offset and the drag
//      threshold are both measured in the pet WINDOW's own coordinates
//      (`clientX`/`clientY`), not in screen coordinates. Screen coordinates
//      are the sum of two independently-drifting numbers — the pointer's
//      place on the desktop and the window's place on the desktop — and
//      after a suspend either can be stale. The window's coordinates have
//      no such second term, so nothing about them can be out of date.
const DRAG_THRESHOLD_PX = 4;
// How long the renderer waits for the main process to take over the drag
// before it drives the window itself.
//
// The takeover is a round-trip to the main process, and a round-trip can
// be lost: the main process can be frozen across a system suspend, and the
// reply to a request that was in flight when the machine went to sleep may
// never arrive. A renderer that waits for it forever moves nothing — it
// does not own the position while the takeover is pending — and the main
// process was never told to follow the cursor, so the pet would not move
// at all.
//
// So the wait is bounded. When it expires the renderer takes over the
// movement itself and reports the deltas, the way it did before the
// main-process drag existed. The end of the drag is sent first, ordered
// after the pending start, so the main process can never be left
// following the cursor with nothing left to stop it.
const DRAG_TAKEOVER_TIMEOUT_MS = 400;
let pressing = false;
let didDrag = false;
// The pointer's position at the press, relative to the pet WINDOW's
// top-left corner.
//
// These are the coordinates the drag is built on, because they answer the
// question the drag actually asks: "how far inside the window did the user
// grab the pet?". Screen coordinates cannot answer it reliably: they are
// the sum of two independently-drifting numbers (the pointer's place on the
// desktop and the window's place on the desktop), and after a system
// suspend either of them can be stale — the OS may have re-arranged the
// displays while the machine was asleep, and the renderer's idea of the
// window's screen origin is not guaranteed to match the main process's.
//
// The client coordinates have no such second term: the browser computes
// them from the same event that carries the pointer's position, relative
// to the viewport it is dispatching into. There is nothing to drift.
let downClientX = 0, downClientY = 0;
// The same press, in the coordinates the OTHER families speak.
//
// The screen coordinates are used for ONE thing only: telling the
// compatibility mouse event of a pointer press apart from a genuinely new
// physical press. They are never used to measure the drag — see
// `downClientX` for why that would drift.
let downScreenX = 0, downScreenY = 0;
let downTimeStamp = 0;
// The pointer id that started the current gesture, so `pointermove` /
// `pointerup` from a different pointer (a stray touch, a pen) can't hijack
// the drag.
//
// `null` means "no gesture owns a pointer id" — the state the renderer
// returns to whenever a gesture ends or is torn down. Keeping it `null`
// (rather than a stale id) is what allows the next gesture to start.
let dragPointerId = null;

// Which event family is driving the gesture in flight.
//
//   'pointer' — the modern Pointer Events (`pointerdown` / `pointermove` /
//                `pointerup`).
//   'mouse'   — the legacy mouse events (`mousedown` / `mousemove` /
//                `mouseup`).
//   null      — no gesture in flight.
//
// WHY THIS EXISTS
// ---------------
// After a system suspend, Chromium can end up in a state where the POINTER
// events are no longer delivered to the renderer at all, while the legacy
// MOUSE events still are.
//
// The two families are not the same pipeline. A pointer event is built from
// the raw input by `PointerEventFactory`, which needs a registered pointer
// DEVICE; the legacy mouse events are built straight from the raw mouse
// input and do not need one. A suspend tears the pointer device down and the
// OS brings it back as a new one, and Chromium's device registry can end up
// not knowing about it — so the raw input produces mouse events but no
// pointer events.
//
// The symptom is exactly this: the pet cannot be dragged (the drag is built
// on pointer events), but everything else still works — the right-click menu
// opens (a `contextmenu` DOM event, a mouse event) and a click still plays
// the pet's action (a `click` DOM event, also a mouse event).
//
// So the drag accepts BOTH families. Whichever one delivers the press drives
// the gesture; the other one is ignored. In a healthy browser the pointer
// family always wins: `pointerdown` is dispatched before the compatibility
// mouse events, and the sprite's `pointerdown` handler calls
// `preventDefault()`, which suppresses the compatibility `mousedown` entirely.
// So the mouse path is a pure fallback — it costs nothing when the pointer
// events work.
let dragFamily = null;

// How many moves EACH family produced during the gesture in flight.
//
// This is the census. It is what makes the next failure diagnosable:
// "the pointer family delivered the press and then went silent, while the
// mouse family carried the movement" looks exactly like "the user did not
// move the mouse" from the outside — and the two need completely different
// fixes. The old log could only count the moves of the family that owned
// the gesture, so the losing family was invisible and the question could
// not be answered.
let gesturePointerMoves = 0;
let gestureMouseMoves = 0;

// The last pointer event of the gesture in flight.
//
// It is what tells a COMPATIBILITY mouse event apart from a genuine
// mouse-family move. A browser that dispatches both families synthesises a
// `mousemove` next to every `pointermove`, at the same position and in the
// same task; a browser whose pointer pipeline has died delivers the
// movement as a `mousemove` with nothing behind it. The echo carries the
// pointer's position and moment; the genuine move has moved on from both.
let lastPointerScreenX = 0, lastPointerScreenY = 0;
let lastPointerTimeStamp = 0;

// Is this mouse event the compatibility echo of a pointer event?
//
// The test is the same one the press handler uses (same position, same
// moment), because it is the same phenomenon: the browser synthesising the
// other family for an event it has already delivered.
function isCompatMouseEvent(e) {
  if (!lastPointerTimeStamp) return false;
  if (Math.abs((e.screenX || 0) - lastPointerScreenX) > 2) return false;
  if (Math.abs((e.screenY || 0) - lastPointerScreenY) > 2) return false;
  return Math.abs((e.timeStamp || 0) - lastPointerTimeStamp) < 100;
}

// How far the pointer has moved since the press, in the window's own
// coordinates.
//
// The client coordinates are the ones that answer this: they are measured
// against the viewport the event is dispatched into, so there is nothing in
// them that can drift while the machine is asleep.
function distanceFromPress(e) {
  const dx = (Number.isFinite(e.clientX) ? e.clientX : 0) - downClientX;
  const dy = (Number.isFinite(e.clientY) ? e.clientY : 0) - downClientY;
  return Math.hypot(dx, dy);
}

// Hand the gesture over to the other event family.
//
// This is what the "the pointer pipeline died in the middle of a gesture"
// case needs: the press arrived as a pointer event, the movement arrives as
// mouse events, and the family gate would otherwise throw the movement
// away — the gesture would sit there until the release, the pet would not
// move, and the user would see a pet that cannot be dragged.
//
// The handover is only allowed while the pet has NOT started moving
// (`didDrag` is false). The grab point is the same either way and the
// movement is measured from it, so switching cannot make the pet jump — and
// once the drag is under way, the pointer that owns it is the one the user
// is actually holding.
function switchGestureFamily(family, e) {
  const from = dragFamily;
  dragFamily = family;
  if (family === 'mouse') {
    // The mouse family has no pointer id — there is no device that could
    // be re-created under us.
    dragPointerId = null;
  } else if (Number.isFinite(e.pointerId)) {
    dragPointerId = e.pointerId;
  }
  try {
    if (M.pet && typeof M.pet.diag === 'function') {
      M.pet.diag(diagSnapshot({
        kind: 'family_switch',
        where: 'renderer',
        from,
        to: family,
        dist: Number(distanceFromPress(e).toFixed(2)),
        ev: {
          screenX: e.screenX, screenY: e.screenY,
          clientX: e.clientX, clientY: e.clientY,
          pointerId: e.pointerId, buttons: e.buttons,
          isTrusted: e.isTrusted,
        },
      }));
    }
  } catch (err) { /* diagnostics must never break the drag */ }
}

// Whether the gesture in flight started on the pet itself.
//
// The whole pet WINDOW is the drag target now (see the press handlers
// below), so a press can land on the transparent margin around the sprite.
// Such a press starts a drag — that is the whole point — but it must NOT
// run the click side effects (pausing the pet, acknowledging a reminder):
// only a click ON the pet means that.
let gestureOnSprite = false;

// How many input events this renderer has seen since it was loaded.
//
// The main process uses it to find out whether the window's INPUT PATH is
// still alive after a system suspend. A renderer can be alive and deaf at
// the same time: it still answers IPC, so from the outside it looks
// perfectly healthy, while the window's input registration is dead and not
// a single mouse event ever reaches it. The counter is what tells the two
// apart.
let inputEventCount = 0;

// How many events each family has produced.
//
// After a system suspend one family can stop entirely while the other
// keeps working. Which one stopped is the difference between "the pet is
// deaf" and "the pet is using its fallback input path", and it is the
// thing the diagnostic log has to show.
let pointerEventCount = 0;
let mouseEventCount = 0;

// Has the main process been told that input is reaching this renderer?
//
// It is told once per wake. The main process is watching for it: if the OS
// cursor moves over the pet and this message never arrives, the input
// path is dead and the only cure left is a new process.
let inputAliveReported = false;
try {
  // Read by the main process through `executeJavaScript`, which runs in
  // this same (main) world.
  window.__petInputCount = () => inputEventCount;
} catch (e) { /* diagnostics must never break the pet */ }

// Count an input event and tell the main process, once, that input is
// getting through.
function countInputEvent(family) {
  inputEventCount++;
  if (family === 'pointer') pointerEventCount++;
  else if (family === 'mouse') mouseEventCount++;
  if (inputAliveReported) return;
  inputAliveReported = true;
  try {
    if (M.pet && typeof M.pet.inputAlive === 'function') M.pet.inputAlive();
  } catch (e) { /* the probe must never break the pet */ }
}

// Is this element one the user has to be able to CLICK rather than drag?
//
// The reminder bubble is the only such element: clicking it closes the
// reminder. It sits above the sprite, so it never covered the pet's body,
// but now that the whole window is a drag target it has to be excluded
// explicitly — otherwise a click on the bubble would start a drag and
// swallow the click.
function isInteractiveTarget(target) {
  try {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('[data-pet-interactive]');
  } catch (e) { return false; }
}

// A monotonically increasing id, one per pointer gesture.
//
// The main process mirrors the renderer's gesture lifecycle: it starts
// following the cursor on `pet:drag_start` and stops on `pet:drag_end`.
// Both messages carry the id of the gesture they belong to, so the main
// process can tell a message about the LIVE gesture from one about a
// gesture that has already ended.
//
// The id is what makes the protocol order-independent. Without it, a
// `pet:drag_start` that arrives after its own `pet:drag_end` looks
// exactly like a fresh drag — and the main process would start following
// the cursor with nothing left to stop it. That is the failure this id
// exists to prevent; see the note on `pet:drag_start` in main/ipc.js.
let gestureSeq = 0;
// The id of the gesture in flight, or 0 when no gesture is in flight.
//
// This is the LOCAL sequence number: it identifies the gesture inside this
// renderer. The id that travels to the main process is `gestureBase +
// gestureSeq` — see `currentWireId`.
let currentGesture = 0;
// The gesture id as the main process knows it: `gestureBase + gestureSeq`.
//
// 0 means "not sent to the main process yet" — the gesture has not reached
// the drag threshold, or its `pet:drag_start` is still in flight.
let currentWireId = 0;
// The offset that turns the local gesture sequence into an id the main
// process accepts.
//
// The main process refuses a `pet:drag_start` whose id it has already seen
// (that is how it recognises a replayed message), so the ids have to keep
// increasing for the whole life of the app. The renderer counts its
// gestures from 1 every time it loads, so after a reload it would hand out
// ids the main process has already seen — and every one of its drags would
// be refused, leaving the pet undraggable until the app was restarted.
//
// Asking the main process for its current high-water mark at startup lets a
// fresh renderer pick up where the last one left off. The answer is
// `gestureBaseReady`, so a drag that starts before the answer arrives waits
// for it instead of guessing.
let gestureBase = 0;
let gestureBaseReady = Promise.resolve(0);
// Whether the last attempt to fetch the base failed. A failed fetch leaves
// the ids starting from 1, which the main process may already have seen —
// so the next drag retries the fetch before it uses an id.
let gestureBaseFailed = false;

// Ask the main process where its gesture ids have got to.
//
// The request is fired as early as possible — the renderer is the only
// thing that can drag the pet, and a drag that starts before the answer
// arrives has to wait for it. It never rejects: a main process without the
// handler (an older build) simply leaves the base at 0, and the ids stay
// locally unique, which is all an older main process needs.
function refreshGestureBase() {
  try {
    if (!M.pet || typeof M.pet.gestureBase !== 'function') {
      gestureBaseFailed = true;
      return Promise.resolve(gestureBase);
    }
    gestureBaseReady = Promise.resolve(M.pet.gestureBase()).then(
      (b) => {
        const n = Number(b);
        if (Number.isFinite(n) && n > gestureBase) gestureBase = n;
        gestureBaseFailed = false;
        return gestureBase;
      },
      () => {
        gestureBaseFailed = true;
        return gestureBase;
      }
    );
  } catch {
    gestureBaseFailed = true;
  }
  return gestureBaseReady;
}
refreshGestureBase();

// The `pet:drag_start` that is still in flight, as `{ gesture, wireId,
// promise }`.
//
// The start cannot be sent synchronously: the renderer has to ask the
// main process where the window is before it can measure the grab
// offset, and that answer comes back asynchronously. Meanwhile the user
// can already have released the button.
//
// The main process sees the two messages in the order they are SENT, and
// the start is sent from a promise callback — so an end sent in the
// meantime would arrive FIRST. The main process would then be following
// the cursor with nothing left to stop it: the pet would be glued to the
// pointer (it could not be dragged anywhere) and the controller's drag
// mutex would stay held, so the pet would never walk on its own again.
//
// Keeping the in-flight start here lets `endDrag` send the end AFTER it,
// which restores the order the main process expects: start, then end.
let pendingStart = null;

// The gesture id of the drag the main process may be following the cursor
// for, or 0 when there is none.
//
// It is what tells a fresh press that there is a stale drag to clean up.
let dragLive = 0;

// Who owns the window position during the current drag.
//
//   'none'   — no drag in progress.
//   'pending'— the takeover has been requested but the IPC hasn't answered
//              yet. The renderer holds still: emitting a delta now would
//              double-apply the movement once the main process takes over.
//   'main'   — the main process polls the cursor and writes the absolute
//              window position. The renderer must not touch the position.
//   'local'  — the main process could not take over (an older main process
//              with no `pet:drag_start` handler), so the renderer reports
//              relative deltas itself.
//
// The mode is an enum rather than a boolean because the decision is
// asynchronous: the `pet:drag_start` IPC resolves a tick or two later. A
// boolean would have let the first few moves slip into the wrong branch and
// double-apply the movement.
let dragOwner = 'none';

// Tell the main process that the gesture is over.
//
// `gesture` is the id of the gesture being ended. 0 means "no gesture is
// in flight" — the forced teardown with nothing to tear down. The main
// process reads 0 as "stop whatever drag you are running", which is
// exactly what a forced teardown wants: it may be cleaning up a drag
// whose `pet:drag_end` never arrived.
function sendDragEnd(gesture) {
  // A stale end — one that belongs to an older gesture — must not clear
  // the live flag: a newer drag may be running by now.
  if (!gesture || gesture >= dragLive) dragLive = 0;
  try { M.pet.dragEnd(gesture); } catch {}
}

// Close a drag whose `pet:drag_start` is still in flight.
//
// The end of a gesture must never overtake its start. The start is sent
// from a promise callback (the renderer has to ask the main process where
// the window is before it can measure the grab offset), so an end sent
// while the lookup is still running arrives FIRST at the main process.
//
// The main process would then be following the cursor with nothing left
// to stop it: the pet is glued to the pointer — it cannot be dragged
// anywhere — and the controller's drag mutex stays held, so the pet never
// walks on its own again. The right-click menu keeps working, because it
// does not go through the drag protocol at all, which is what made the
// symptom look so odd.
//
// Waiting for the start restores the order the main process expects:
// start, then end.
//
// The end carries the id the main process knows the gesture by, which is
// only known once the start has been built — so it is read from the pending
// record at the moment the end is actually sent, not captured earlier.
function closePendingStart() {
  const pending = pendingStart;
  if (!pending) return;
  pendingStart = null;
  const send = () => sendDragEnd(pending.wireId);
  pending.promise.then(send, send);
}

// End the gesture no matter how it ended — a normal release, a lost
// capture, the window losing focus, or the app being backgrounded.
//
// This is the fix for the "permanently undraggable" symptom: any exit path
// that skipped this left `pressing` true, and a stuck `pressing` turns every
// subsequent mouse move inside the window into a bogus drag delta.
//
// `force` skips the "was a gesture even in progress?" check. It is used by
// the system-resume path: after a suspend the renderer cannot know whether
// the main process still believes a drag is running, and the main process's
// side is only ever torn down by an explicit `pet:drag_end`. Sending that
// message unconditionally is safe — the main process's handler is
// idempotent — and it is the only way to guarantee the cursor poller and
// the controller's drag mutex are released.
//
// Without this, a suspend that swallowed the `pointerup` would leave the
// main process dragging the pet around forever: the pet stuck to the
// pointer, and the pet's autonomous movement dead for the rest of the
// session.
function endDrag(force = false, reason = '') {
  if (!pressing && !force) return;
  const wasDragging = didDrag;
  // Record WHY the gesture ended.
  //
  // A gesture that is torn down by something the user did not do (a blur,
  // a lost capture, a wake) is the signature of the post-sleep wedge: the
  // drag starts and then dies on its own. The reason is what tells the
  // two apart in the diagnostic log.
  try {
    if (M.pet && typeof M.pet.diag === 'function') {
      M.pet.diag(diagSnapshot({
        kind: 'drag_end',
        where: 'renderer',
        reason: reason || (force ? 'forced' : 'release'),
        forced: !!force,
        wasDragging,
        dragOwner,
        // How many moves the gesture saw. Zero means the pointer never
        // moved after the press; one means it moved but never far enough.
        moves: gestureMoves,
        // The census: how many moves EACH family produced. This is what
        // tells "the pointer pipeline died mid-gesture and the mouse family
        // carried the movement" apart from "the user did not move the
        // mouse" — the two look identical from the outside.
        pointerMoves: gesturePointerMoves,
        mouseMoves: gestureMouseMoves,
        // The family that owned the gesture, and whether it was handed
        // over to the other one while it was in flight.
        family: dragFamily,
        wireId: currentWireId,
      }));
    }
  } catch (e) { /* diagnostics must never break the teardown */ }
  // The local sequence number of the gesture being ended.
  //
  // It identifies the gesture inside this renderer; the id the main
  // process knows it by is `currentWireId`, which is only set once the
  // `pet:drag_start` has been built.
  const gesture = currentGesture;
  // The id the main process knows this gesture by. 0 when the gesture never
  // reached the drag threshold, or its start is still in flight.
  const wireId = currentWireId;
  // Clear the gesture state FIRST, then release the pointer capture.
  //
  // The order matters. `releasePointerCapture` fires `lostpointercapture`
  // synchronously, and the handler for that event calls back into
  // `endDrag`. If the state were still live at that moment, the nested
  // call would tear the gesture down a second time and send a duplicate
  // `pet:drag_end` to the main process. Clearing first makes the nested
  // call a no-op (its `if (!pressing) return` guard trips).
  //
  // The capture itself must be released: it is what keeps the gesture alive
  // when the cursor leaves the 220 px box. If we forget to release it, the
  // sprite stays the capture target for a pointer that no longer exists —
  // and Chromium keeps routing that pointer's events to the sprite instead
  // of to the window. After a system suspend the pointer device is
  // re-created, so this stale capture is exactly what wedges the pet.
  //
  // `hasPointerCapture` is checked first because `releasePointerCapture`
  // throws if the id is not captured (it is a no-op only for a stale id the
  // browser already forgot).
  const capturedId = dragPointerId;
  // Whether the press that started this gesture landed on the pet itself.
  // It decides whether the release counts as a CLICK on the pet.
  const onSprite = gestureOnSprite;
  pressing = false;
  didDrag = false;
  dragPointerId = null;
  dragFamily = null;
  gestureOnSprite = false;
  dragOwner = 'none';
  currentGesture = 0;
  currentWireId = 0;
  sprite.classList.remove('dragging');
  if (capturedId !== null) {
    try {
      if (typeof sprite.hasPointerCapture === 'function'
        && sprite.hasPointerCapture(capturedId)) {
        sprite.releasePointerCapture(capturedId);
      }
    } catch {}
  }
  // Tell the main process to stop following the cursor and to release the
  // controller's drag mutex. This is sent on EVERY exit path, including
  // the forced one, because it is the only way the main process learns
  // that the gesture is over.
  //
  // The gesture id travels with it so the main process can tell this
  // end apart from a LATE end belonging to an older gesture — one that
  // must not stop the drag that is running now.
  //
  // When this gesture's `pet:drag_start` is still in flight, the end is
  // deferred until it has been sent — otherwise the end would overtake
  // the start and leave the main process following the cursor forever.
  // See `closePendingStart`.
  const pending = (pendingStart && pendingStart.gesture === gesture) ? pendingStart : null;
  if (pending) {
    pendingStart = null;
    // The id is read when the end is actually sent: it only exists once the
    // start has been built, which is what the promise waits for.
    const send = () => sendDragEnd(pending.wireId);
    pending.promise.then(send, send);
  } else if (force) {
    // A forced teardown — the system came back from sleep, or the pointer
    // device was re-created under us. The renderer cannot know whether the
    // main process still believes a drag is running, and which gesture it
    // belongs to, so it asks for a full stop: the id 0 means "stop
    // whatever drag you are running".
    sendDragEnd(0);
  } else if (wasDragging) {
    // The start already reached the main process, so it knows this gesture
    // by its id.
    sendDragEnd(wireId);
  } else {
    // No drag was ever started — this was a plain click. The main process
    // cannot know about a gesture that never started, so the end goes out
    // with the id 0, which means "stop whatever drag you are running".
    // That is exactly right: the user pressed and released, so any drag
    // still running on the other side belongs to a gesture that is over.
    sendDragEnd(0);
  }
  if (wasDragging) {
    return;
  }
  // A forced teardown (the resume path) is NOT a click. It must not run the
  // click side effects below — otherwise waking the machine up would
  // dismiss a pending reminder bubble the user never acknowledged.
  if (force) {
    return;
  }
  // A press on the transparent margin around the pet starts a drag, but it
  // is not a click ON the pet: it must not pause the pet and it must not
  // acknowledge a reminder the user never looked at.
  if (!onSprite) {
    return;
  }
  // Non-drag single click is now a no-op — the main window is gated by a
  // 4-digit PIN and must be opened via right-click → "打开主窗口". We
  // still pause movement briefly for tactile feedback, and in REMINDER
  // state the click acknowledges the reminder (it would otherwise stay
  // glued to the pet until acknowledged).
  try { M.pet.setPaused(2000); } catch {}
  // A click on the pet while it is nagging is the user saying "handled".
  //
  // This used to hide the floating bubble and nothing else, which is why
  // the reminder felt impossible to close: the bubble went away but the
  // badge kept counting, the sprite kept shaking and the top-bar pill
  // kept reading 桌宠提醒. Completing the reminder for today closes the
  // whole thing — and the entry stays on the 今日 page, marked 已完成,
  // so nothing is lost if the click was not meant as an acknowledgement.
  if (currentReminder) {
    dismissCurrentReminder();
  }
}

// ---- Diagnostics ----
//
// The pet window records what it sees — every pointer press, every wake,
// every drag takeover — to the diagnostic log in the main process (see
// main/pet_diagnostics.js).
//
// This exists because "the pet cannot be dragged any more after the
// machine sleeps" is a bug that only reproduces on real hardware: it needs
// an actual system suspend. Two earlier attempts at this bug were
// plausible, were wrong, and both looked right on paper. The log turns
// the next reproduction into evidence instead of another guess.
//
// The snapshot deliberately records the things that tell the possible
// causes apart: the pointer's coordinates in BOTH spaces, what element was
// actually under the pointer, the sprite's geometry, the CSS variables
// that size it, and the window's position on the desktop.
//
// Diagnostics must never break the pet: every call is wrapped, and a
// failure is swallowed.

// The geometry and state a diagnostic entry carries.
function diagSnapshot(extra) {
  const out = {};
  try {
    out.win = {
      screenX: window.screenX, screenY: window.screenY,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      dpr: window.devicePixelRatio,
      hidden: document.hidden,
      readyState: document.readyState,
    };
    out.screen = {
      width: window.screen.width, height: window.screen.height,
      availWidth: window.screen.availWidth, availHeight: window.screen.availHeight,
    };
    const cs = getComputedStyle(document.documentElement);
    out.css = {
      sizeW: cs.getPropertyValue('--size-w').trim(),
      sizeH: cs.getPropertyValue('--size-h').trim(),
      spriteW: cs.getPropertyValue('--sprite-w').trim(),
      spriteH: cs.getPropertyValue('--sprite-h').trim(),
    };
    const r = sprite.getBoundingClientRect();
    out.sprite = { x: r.x, y: r.y, w: r.width, h: r.height };
  } catch (e) {
    out.snapshotError = String(e);
  }
  return Object.assign(out, extra || {});
}

// Record a pointer event.
//
// `where` says which handler saw it: 'window' for the capture-phase
// listener on the window (which sees EVERY press, whether or not it
// landed on the pet) and 'sprite' for the sprite's own handler. The
// difference between the two is what separates "the press never reached
// the pet" from "the press reached the pet and the drag still did not
// start".
function diagEvent(where, e, extra) {
  try {
    if (!M.pet || typeof M.pet.diag !== 'function') return;
    const info = { kind: 'pointerdown', where };
    if (e) {
      info.ev = {
        screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY,
        pointerId: e.pointerId, button: e.button, buttons: e.buttons,
        isTrusted: e.isTrusted,
      };
      try {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        info.hit = hit ? (hit.id || hit.className || hit.tagName) : null;
      } catch (err) { info.hit = 'elementFromPoint failed: ' + err; }
    }
    M.pet.diag(diagSnapshot(Object.assign(info, extra || {})));
  } catch (e) { /* diagnostics must never break the pet */ }
}

// Every press, whatever it landed on.
//
// Capture phase on the window, so it runs BEFORE the sprite's own
// handler: the log then shows both a 'window' and a 'sprite' entry for a
// press that reached the pet, and only a 'window' entry for one that did
// not.
//
// THE WINDOW IS THE HIT TARGET
// ----------------------------
// The gesture starts here, not on the sprite.
//
// The sprite is 165 px wide inside a 216 px window, and the artwork
// inside it is narrower still (the PNG is a wide image letterboxed into a
// tall box), so a press that lands anywhere near the visible pet but
// outside the sprite's box did NOTHING AT ALL: no gesture, no drag, no
// feedback. The real machine's diagnostic log (2026-10-31) caught exactly
// that — a `pointerdown` at clientX 210, where the sprite ends at 190,
// hitting `BODY` and producing a grab that silently went nowhere.
//
// The pet walks around on its own, so the user aims at where the pet was
// a moment ago and misses the 165 px box all the time. Making the whole
// window draggable removes the whole class of "I grabbed it and nothing
// happened".
window.addEventListener('pointerdown', (e) => {
  diagEvent('window', e);
  countInputEvent('pointer');
  if (e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;
  beginGesture(e, 'pointer');
}, true);

// How many moves the current gesture has seen.
//
// The counter is what tells "the moves never arrived" apart from "the
// moves arrived but the threshold was never crossed" — two failures that
// look identical from the outside and need completely different fixes.
let gestureMoves = 0;

// Record a move of the gesture in flight.
//
// Only the FIRST move of a gesture is logged in full: a drag produces a
// move every frame, and logging them all would bury the interesting
// entries. The first move is the one that matters — it carries the
// pointer's coordinates in both spaces and shows whether the threshold
// was in reach.
function diagMove(e, extra) {
  try {
    if (!M.pet || typeof M.pet.diag !== 'function') return;
    const downDx = (Number.isFinite(e.clientX) ? e.clientX : 0) - downClientX;
    const downDy = (Number.isFinite(e.clientY) ? e.clientY : 0) - downClientY;
    M.pet.diag(diagSnapshot(Object.assign({
      kind: 'pointermove',
      where: 'renderer',
      moves: gestureMoves,
      ev: {
        screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY,
        pointerId: e.pointerId, buttons: e.buttons,
        isTrusted: e.isTrusted,
      },
      // The distance from the press, in the window's own coordinates.
      // This is what the drag threshold is measured on.
      fromPress: { dx: downDx, dy: downDy, dist: Math.hypot(downDx, downDy) },
      didDrag,
      dragOwner,
    }, extra || {})));
  } catch (e) { /* diagnostics must never break the drag */ }
}

// The offset of the grab point inside the pet window.
//
// The main process positions the window with `window = cursor - offset`, so
// the offset decides where the pet sits relative to the pointer. It has to
// describe the point the user actually grabbed.
//
// The offset is measured in the window's own coordinates, so it describes
// a point inside the window by construction. This check is the safety net
// for the case where it does not: a grab point outside the window means the
// measurement and the window disagree about where they are, and dragging
// with such an offset would fling the pet across the screen. It is
// rejected and the pet is grabbed by its centre instead.
function usableGrabOffset(off) {
  if (!off || !Number.isFinite(off.dx) || !Number.isFinite(off.dy)) return null;
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  if (w > 0 && (off.dx < 0 || off.dx > w)) return null;
  if (h > 0 && (off.dy < 0 || off.dy > h)) return null;
  return off;
}

// Grab the pet by the middle of its sprite — the fallback when the grab
// point cannot be trusted.
function spriteCentreOffset() {
  try {
    const r = sprite.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      return { dx: r.x + r.width / 2, dy: r.y + r.height / 2 };
    }
  } catch {}
  return { dx: (window.innerWidth || 0) / 2, dy: (window.innerHeight || 0) / 2 };
}

// Point the gesture at a different pointer device.
//
// A system suspend tears the pointer device down and the OS brings it back
// as a NEW device with a NEW pointer id — while the button the user is
// holding is still logically down. The gesture captured the dead id, so
// every event the new mouse sends looks like it came from a stranger, and
// the pet could not be dragged at all.
//
// This is only safe BEFORE the drag has started: the pet has not moved yet,
// so following a different pointer cannot make it jump. Once the drag is
// under way the pet IS the thing being moved, and a second device must not
// take it over — that case tears the gesture down instead (see the
// `pointermove` handler).
function rebindToPointer(pointerId) {
  const oldId = dragPointerId;
  // The new id is stored BEFORE the old capture is released.
  //
  // `releasePointerCapture` fires `lostpointercapture` synchronously, and
  // that handler tears the gesture down when the lost capture belongs to
  // this gesture. Writing the new id first makes the old capture look like
  // somebody else's, so the handler leaves the gesture alone.
  dragPointerId = pointerId;
  if (oldId !== null && oldId !== pointerId) {
    try {
      if (typeof sprite.hasPointerCapture === 'function'
        && sprite.hasPointerCapture(oldId)) {
        sprite.releasePointerCapture(oldId);
      }
    } catch {}
  }
  // Capture the new pointer, so the gesture survives the pointer travelling
  // outside the 220 px pet window. The capture is what makes the drag keep
  // working once the cursor leaves the box.
  try { sprite.setPointerCapture(pointerId); } catch {}
  try {
    if (M.pet && typeof M.pet.diag === 'function') {
      M.pet.diag(diagSnapshot({
        kind: 'pointer_rebind',
        where: 'renderer',
        from: oldId,
        to: pointerId,
        didDrag,
      }));
    }
  } catch (e) { /* diagnostics must never break the drag */ }
}

// Begin a gesture.
//
// `family` is 'pointer' or 'mouse' — which event family delivered the
// press. The gesture is then driven by that family alone (see `dragFamily`),
// so the two can never fight over the same press.
function beginGesture(e, family) {
  // A gesture from the OTHER family is stale by definition.
  //
  // The two families cannot both be alive for one press: in a healthy
  // browser the `pointerdown` arrives first and its `preventDefault()`
  // suppresses the compatibility mouse events entirely. So a mouse press
  // arriving while a POINTER gesture is live means the pointer events are
  // not coming — which is exactly the post-suspend state — and the pointer
  // gesture can never be ended by a `pointerup` that will not arrive.
  //
  // Leaving it in place would wedge the pet for the rest of the session:
  // the mouse press would be swallowed, so the pet could never be dragged
  // again. Tearing the stale gesture down first lets the mouse family
  // take over. The same applies the other way round — a `pointerdown`
  // arriving while a MOUSE gesture is live means the pointer device came
  // back, and the newer family wins.
  if (pressing && dragFamily && dragFamily !== family) {
    // …unless it is the COMPATIBILITY mouse event of the pointer press
    // that started the live gesture.
    //
    // The compatibility event carries the same coordinates and is created
    // in the same task, so it is told apart from a genuinely new press by
    // both. (A real browser suppresses it entirely — the `pointerdown`
    // handler calls `preventDefault()` — but not every environment does,
    // and treating the compatibility event as a new press would tear the
    // gesture down in the middle of the user's drag.)
    const isCompatEvent = family === 'mouse'
      && dragFamily === 'pointer'
      && Math.abs((e.screenX || 0) - downScreenX) < 2
      && Math.abs((e.screenY || 0) - downScreenY) < 2
      && Math.abs((e.timeStamp || 0) - downTimeStamp) < 100;
    if (isCompatEvent) return;
    endDrag(true, 'family-switch');
  }
  pressing = true;
  didDrag = false;
  dragFamily = family;
  // The move counter of this gesture — it goes into the diagnostic log, so
  // it says how many moves the gesture actually saw.
  gestureMoves = 0;
  // The census of this gesture: how many moves each family produced. See
  // the note on `gesturePointerMoves`.
  gesturePointerMoves = 0;
  gestureMouseMoves = 0;
  // Remember where the press was, in the pointer family's terms. It is what
  // tells a later compatibility mouse event apart from a genuine
  // mouse-family move — see `isCompatMouseEvent`.
  if (family === 'pointer') {
    lastPointerScreenX = Number.isFinite(e.screenX) ? e.screenX : 0;
    lastPointerScreenY = Number.isFinite(e.screenY) ? e.screenY : 0;
    lastPointerTimeStamp = Number.isFinite(e.timeStamp) ? e.timeStamp : 0;
  } else {
    lastPointerTimeStamp = 0;
  }
  // The pet must not walk away while the user is holding it.
  //
  // The autonomous walk is only paused once the drag actually starts — but
  // the walk does not wait for the drag: it keeps going, and the pet slides
  // out from under the cursor in the moment between the press and the
  // threshold. The user's moves then land on the desktop instead of on the
  // pet, and the pet looks like it cannot be dragged. Pausing it on the
  // press closes that window: the grab point is where the user pressed, and
  // the pet stays there until the gesture ends.
  try { M.pet.setPaused(2000); } catch {}
  // Ownership is decided when the drag threshold is crossed, not here — but
  // it must start from a clean slate in case a previous gesture ended
  // without going through `endDrag`.
  dragOwner = 'none';
  // The grab point, relative to the window. See the note on
  // `downClientX` — this is the measurement the drag is built on.
  downClientX = Number.isFinite(e.clientX) ? e.clientX : 0;
  downClientY = Number.isFinite(e.clientY) ? e.clientY : 0;
  // The same press in the other family's coordinates — see the note on
  // `downScreenX`.
  downScreenX = Number.isFinite(e.screenX) ? e.screenX : 0;
  downScreenY = Number.isFinite(e.screenY) ? e.screenY : 0;
  downTimeStamp = Number.isFinite(e.timeStamp) ? e.timeStamp : 0;
  // Only the pointer family has a pointer id. The mouse family has no
  // device to be confused by — which is exactly why it still works when the
  // pointer devices are broken.
  dragPointerId = (family === 'pointer' && Number.isFinite(e.pointerId))
    ? e.pointerId
    : null;
  // Did the press land on the pet itself, or on the transparent margin
  // around it? The margin starts a drag but is not a click on the pet.
  //
  // `contains` throws when it is given something that is not a Node (the
  // window itself is not one), so the check is made defensively.
  gestureOnSprite = false;
  try {
    if (e.target && typeof sprite.contains === 'function' && sprite.contains(e.target)) {
      gestureOnSprite = true;
    }
  } catch (e) { /* not a node — the press was not on the pet */ }
  // Every gesture gets its own id, so the main process can tell which
  // drag messages belong to it.
  //
  // The id the main process knows it by is `gestureBase + this sequence`,
  // which keeps growing across a renderer reload — see `gestureBase`.
  currentGesture = ++gestureSeq;
  // No id yet: the gesture has not reached the drag threshold, so nothing
  // has been sent to the main process yet.
  currentWireId = 0;
  // A new press means the previous gesture is over. Close its drag: if
  // its `pet:drag_start` is still in flight, the end has to wait for it
  // so the two do not arrive swapped.
  closePendingStart();
  // Barrier: tell the main process that any drag it may still be running
  // belongs to a gesture that is already over.
  //
  // A new press means the previous gesture ended, so its `pet:drag_end`
  // has already been sent — but it may have been overtaken by a late
  // `pet:drag_start`, leaving the main process following the cursor with
  // nothing to stop it. The pet would then be glued to the pointer
  // and could not be dragged anywhere, which is exactly the "the pet
  // cannot be dragged" symptom. Ending the drag here — with the id 0,
  // which means "stop whatever you are running" — clears that before the
  // user can see it.
  //
  // Only sent when a drag is actually outstanding, so a normal gesture
  // does not produce an extra message.
  if (dragLive) sendDragEnd(0);
  // Capture the pointer so this element keeps receiving move/up events even
  // if the pointer travels outside the window. Without this the gesture
  // simply evaporates the moment the cursor leaves the 220 px box.
  //
  // Only the pointer family can be captured — there is no pointer capture
  // for the legacy mouse events, so a mouse gesture simply stops when the
  // cursor leaves the window. That is survivable: by then the main process
  // has usually taken the position over, and it follows the OS cursor.
  if (family === 'pointer') {
    try { sprite.setPointerCapture(e.pointerId); } catch {}
  }
  e.preventDefault();
}

sprite.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // The gesture was already started by the window's capture-phase handler
  // — this listener only records that the press landed on the pet itself,
  // which is what the log needs to tell "grabbed the pet" apart from
  // "grabbed the transparent margin around it".
  diagEvent('sprite', e);
});
// Every mouse press, whatever it landed on.
//
// The capture phase on the window sees EVERY press, whether or not it landed
// on the pet — the mouse counterpart of the pointer listener above. It is
// what proves, after a system suspend, that the mouse events still arrive
// even though the pointer events have stopped.
//
// It is also where the gesture starts when the pointer events are the ones
// that stopped: in a healthy browser the pointerdown handler above has
// already called `preventDefault()`, which suppresses this compatibility
// event entirely, so this path costs nothing.
window.addEventListener('mousedown', (e) => {
  diagMouse('window', e);
  countInputEvent('mouse');
  if (e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;
  beginGesture(e, 'mouse');
}, true);
// Record a mouse-family event.
//
// The mouse events are the fallback input path (see `dragFamily`), and they
// are also the evidence for what really happens after a system suspend: the
// POINTER events can stop arriving altogether while the MOUSE events keep
// coming. Only the log can show that difference — from the outside, "the pet
// cannot be dragged but the right-click menu works" looks like nonsense.
function diagMouse(where, e, extra) {
  try {
    if (!M.pet || typeof M.pet.diag !== 'function') return;
    const info = { kind: 'mouse', where };
    if (e) {
      info.ev = {
        screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY,
        button: e.button, buttons: e.buttons,
        isTrusted: e.isTrusted,
      };
      try {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        info.hit = hit ? (hit.id || hit.className || hit.tagName) : null;
      } catch (err) { info.hit = 'elementFromPoint failed: ' + err; }
    }
    M.pet.diag(diagSnapshot(Object.assign(info, extra || {})));
  } catch (e) { /* diagnostics must never break the pet */ }
}

// Record a release that had no press behind it.
//
// This is the log entry for "the first press after the wake did nothing":
// the press itself never reached the renderer (it was swallowed while the
// pointer device was being re-registered), so the release arrives with no
// gesture waiting for it.
function diagOrphanRelease(family, e) {
  try {
    if (!M.pet || typeof M.pet.diag !== 'function') return;
    M.pet.diag(diagSnapshot({
      kind: 'orphan_release',
      where: 'renderer',
      family,
      ev: {
        screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY,
        pointerId: e.pointerId, button: e.button,
        isTrusted: e.isTrusted,
      },
    }));
  } catch (e) { /* diagnostics must never break the pet */ }
}

// The legacy mouse events — the fallback for a browser whose pointer
// events have stopped after a system suspend.
//
// `pressing` is the guard that keeps the two families apart: the pointer
// family always delivers its press first (and its `preventDefault()`
// suppresses the compatibility mouse events altogether), so a `mousedown`
// that arrives while a gesture is live is never a second gesture.
sprite.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  diagMouse('sprite', e);
});

// The move handling, shared by both event families.
//
// `family` is 'pointer' or 'mouse'. The only difference between them is the
// foreign-pointer check: a mouse event has no pointer id, and the whole
// "the pointer device was re-created under us" problem is a pointer-events
// problem. Everything else — the threshold, the takeover, the local
// fallback — is identical.
function handleDragMove(e, family) {
  if (!pressing) return;
  gestureMoves++;
  // The census: how many moves each family produced during this gesture.
  if (family === 'pointer') gesturePointerMoves++;
  else gestureMouseMoves++;
  // The first move of a gesture is logged in full: it shows the pointer's
  // coordinates in both spaces and how far it was from the press, which is
  // what tells "the move never arrived" apart from "the move arrived but
  // did not reach the threshold".
  if (gestureMoves === 1) diagMove(e, { family });
  // An event from a pointer device this gesture did not capture.
  //
  // A system suspend tears the pointer device down, and the OS brings it
  // back as a NEW device with a NEW pointer id — while the button the user
  // is holding is still logically down. The gesture captured the old id,
  // so every event the new mouse sends looks like it came from a stranger.
  //
  // Tearing the gesture down on the first of them left the pet
  // undraggable: the press carried the old id and every move carried the
  // new one, so the press was killed by the move that followed it, over
  // and over. The pet could not be dragged at all — which is exactly what
  // the user reported.
  //
  // So before the drag has started, the gesture follows the pointer that
  // is actually moving. The pet has not moved yet, so following the new
  // pointer cannot make it jump, and the drag can still begin.
  //
  // Once the drag HAS started, the captured device is the one the user is
  // holding and the pet is already being moved — a second device must not
  // take the drag over. The gesture ends instead, and the next press
  // starts a clean one.
  if (family === 'pointer' && dragPointerId !== null && e.pointerId !== dragPointerId) {
    if (!didDrag) {
      rebindToPointer(e.pointerId);
    } else {
      endDrag(true, 'foreign-pointer');
      return;
    }
  }
  if (!didDrag) {
    // The threshold is measured in the window's own coordinates.
    //
    // It only has to answer "did the pointer move far enough to count as
    // a drag?", and the client coordinates answer that with no reference to
    // anything outside the window. The screen coordinates would answer it
    // just as well — as long as they still track the pointer, which is
    // exactly the thing that cannot be assumed after the machine has been
    // asleep: a renderer that was frozen across the sleep may deliver a
    // first move whose screen coordinates are stale, and then the distance
    // never reaches the threshold and the drag never starts.
    const movedX = e.clientX - downClientX;
    const movedY = e.clientY - downClientY;
    if (Math.hypot(movedX, movedY) < DRAG_THRESHOLD_PX) return;
    didDrag = true;
    // The move that crossed the threshold is worth its own entry: it is
    // the moment the drag becomes real.
    diagMove(e, { crossed: true, family });
    sprite.classList.add('dragging');
    try { M.pet.setPaused(2000); } catch {}
    // Hand the drag over to the main process. The offset is between the
    // pointer and the WINDOW's top-left, so the pet stays exactly where the
    // user grabbed it instead of jumping its centre to the cursor.
    //
    // It has to be the window and not the sprite: the window is bigger than
    // the sprite (bubble headroom above it, side room beside it), and the
    // main process positions the *window* — `setPosition` moves the window,
    // not the sprite inside it. Measuring against the sprite would offset
    // the window by the headroom the moment the drag starts.
    //
    // Until the IPC resolves we don't know whether the main process took
    // over, so the position is left alone for these few frames. The main
    // process places the window under the cursor immediately on
    // `drag_start`, so nothing is lost by not guessing here — and guessing
    // would double-apply the movement once the takeover does land.
    //
    // The grab offset is the press's CLIENT coordinates — where inside the
    // window the user grabbed the pet. It is not measured against the
    // window's screen position: `window.screenX` is the browser's view of
    // it, which can be stale. After a suspend/resume the OS may have moved
    // the window (display reconfiguration, monitor hotplug, dock undock),
    // and the renderer is not guaranteed to have caught up. A stale value
    // would offset the window by that delta the moment the drag starts,
    // making the pet jump — and it would need an IPC round-trip to the main
    // process to get the authoritative position, which delays the takeover
    // by a tick and can be lost entirely when the main process was frozen
    // across the sleep.
    //
    // The client coordinates have no such second term to drift: they come
    // from the same event that carries the pointer, measured against the
    // viewport the event is dispatched into. So the offset needs no lookup
    // at all, and the takeover is not delayed.
    //
    // The whole chain — the gesture base and then the start — is ONE
    // promise, registered here, synchronously.
    //
    // Registering it synchronously is what makes the ordering work. The
    // user can release the button while the chain is still running (a
    // quick flick: press, move, release), and `endDrag` then has to wait
    // for this promise before it sends `pet:drag_end` — otherwise the end
    // overtakes the start and the main process is left following the
    // cursor with nothing left to stop it.
    //
    // The start is sent even if the gesture has already ended: skipping
    // it would make a flick do nothing at all — the pet would stay where
    // it was even though the user clearly moved it. The deferred end
    // stops the drag right after, so the pet ends up where the flick
    // took it.
    //
    // The gesture id travels with both messages so the main process can
    // recognise a message that belongs to a gesture it has already
    // finished — the safety net for the case the deferral cannot cover
    // (a start from an OLDER gesture arriving late).
    dragOwner = 'pending';
    const gesture = currentGesture;
    // The grab offset: how far inside the pet window the user grabbed it.
    //
    // It is read from the PRESS, in the window's own coordinates
    // (`downClientX`/`downClientY`). That is exactly the number the main
    // process needs: it places the window with `window = cursor - offset`,
    // so the offset it wants is "where inside the window is the cursor" —
    // which is what the client coordinates are, by definition. The press
    // point is also the only one that describes what the user actually
    // grabbed; using the move that crossed the threshold instead folds
    // everything the pointer travelled in between into the offset, and the
    // main process cancels that distance right back out.
    //
    // It used to be measured from the SCREEN coordinates
    // (`e.screenX - window.screenX`), which asks the browser where the
    // window is on the desktop. That is a second, independent number, and
    // after a system suspend the two can disagree: the OS may have moved
    // the window while the machine was asleep, and the renderer's view of
    // the window's screen origin is not guaranteed to have caught up. The
    // offset then describes a point that is not on the pet, the pet is
    // grabbed by the wrong part of itself, and the drag never starts.
    //
    // The client coordinates have no second term to drift: they come
    // from the same event that carries the pointer, measured against the
    // viewport the event is dispatched into.
    const grabOffset = { dx: downClientX, dy: downClientY };
    // The gesture id the main process knows this gesture by: the base it
    // handed out at startup plus the local sequence number.
    //
    // The base is waited for here rather than assumed: a drag that starts
    // before the answer arrives would otherwise use an id the main process
    // has already seen, and the start would be refused as a replay. The
    // answer is fetched at startup, so it is normally already there and
    // this costs nothing.
    //
    // A fetch that failed is retried now — a drag is exactly the moment
    // when an id the main process has already seen would do the most
    // damage, so it is the moment to make sure the base is right.
    const basePromise = gestureBaseFailed ? refreshGestureBase() : gestureBaseReady;
    const pending = { gesture, wireId: 0, promise: null };
    // Send the start, and report what the main process answered.
    //
    // The id is `base + gesture`. The main process refuses an id it has
    // already seen (that is how it recognises a replayed message), so a
    // base that is behind the main process's high-water mark makes the
    // start come back as `false`.
    const sendStart = (base) => {
      const wireId = base + gesture;
      // The id belongs to THIS gesture, whoever is current now.
      pending.wireId = wireId;
      // Only the live gesture may claim the renderer's own id — a chain
      // that resolved late must not overwrite the id of the gesture that
      // is running now, or the end would name the wrong gesture.
      if (gesture === currentGesture) currentWireId = wireId;
      // From here on the main process may be following the cursor, so a
      // fresh press has to know that there is a drag to clean up.
      //
      // The highest id wins: the main process follows the newest drag it
      // accepted, and a late chain from an older gesture must not hide it.
      if (!dragLive || wireId > dragLive) dragLive = wireId;
      // Reject an offset that does not describe a point inside the pet
      // window — that means the pointer's screen coordinates and the
      // window's position are in different spaces, which happens when the
      // OS moved the window while the machine was asleep. Grabbing the pet
      // by its centre is the safe answer.
      const off = usableGrabOffset(grabOffset) || spriteCentreOffset();
      // Record the takeover: the offset that was measured, and whether it
      // had to be replaced by the sprite's centre (which means the
      // measurement was not usable).
      try {
        if (M.pet && typeof M.pet.diag === 'function') {
          M.pet.diag(diagSnapshot({
            kind: 'drag_start',
            where: 'renderer',
            wireId,
            grab: { dx: off.dx, dy: off.dy },
            measured: grabOffset,
            centred: off !== grabOffset,
            family,
          }));
        }
      } catch (e) { /* diagnostics must never break the drag */ }
      return M.pet.dragStart(off.dx, off.dy, wireId);
    };
    const chain = basePromise
      .then((base) => sendStart(base))
      .then((ok) => {
        if (ok !== false) return ok;
        // Refused: the main process has already seen this id, so our base
        // is behind its high-water mark. Re-read the base and try once
        // more.
        //
        // Dropping to the window-local fallback instead would look exactly
        // like "the pet cannot be dragged": the local fallback can only
        // move the pet inside its own 216 px window, because it works off
        // the movement the renderer sees — and the renderer sees nothing
        // once the cursor leaves the window.
        return refreshGestureBase().then((base) => {
          // The gesture may have ended while the base was being fetched.
          if (gesture !== currentGesture) return ok;
          return sendStart(base);
        });
      });
    // Remember the in-flight chain, so `endDrag` sends the end after it
    // instead of before it.
    pending.promise = chain;
    pendingStart = pending;
    // The takeover must not wait forever — see the note on
    // `DRAG_TAKEOVER_TIMEOUT_MS`.
    const takeoverTimer = setTimeout(() => {
      if (dragOwner !== 'pending') return;
      if (gesture !== currentGesture) return;
      // Close the drag the main process may already have started: the end
      // is ordered after the pending start, so the main process cannot end
      // up following the cursor with nothing to stop it.
      closePendingStart();
      // The main process never took the wheel — drive the window here.
      dragOwner = 'local';
    }, DRAG_TAKEOVER_TIMEOUT_MS);
    chain.then(
      (ok) => {
        clearTimeout(takeoverTimer);
        try {
          if (M.pet && typeof M.pet.diag === 'function') {
            M.pet.diag(diagSnapshot({ kind: 'drag_takeover', where: 'renderer', accepted: ok, owner: 'main', family }));
          }
        } catch (e) { /* diagnostics must never break the drag */ }
        if (!pressing || gesture !== currentGesture || dragOwner !== 'pending') return;
        // The main process answers `false` when it refuses the start
        // (a gesture it has already finished). Fall back to reporting
        // the deltas ourselves, the way an older main process is
        // handled.
        dragOwner = (ok === false) ? 'local' : 'main';
      },
      () => {
        clearTimeout(takeoverTimer);
        if (!pressing || gesture !== currentGesture || dragOwner !== 'pending') return;
        dragOwner = 'local';
      }
    );
  }

  // The window position is owned by the main process for the duration of
  // the drag — it polls the cursor and writes the absolute position. The
  // renderer must NOT also apply a relative delta on top of that: the two
  // would compound and the pet would race away from the cursor.
  if (dragOwner === 'local') {
    // The main process refused the takeover (or never answered), so the
    // window is NOT following the pointer — which means the pointer's
    // movement INSIDE the window is its movement on the screen.
    //
    // The delta is measured from the PRESS, not from the previous move.
    // Moving the window changes the client coordinates, so a delta taken
    // from the previous move would feed back into itself: the pet would
    // travel at half the pointer's speed and drift away from it.
    //
    // Measured from the press it is exact, and it needs nothing but the
    // event itself: the grabbed point stays under the pointer because the
    // window moves by exactly the distance the pointer moved inside it.
    // The screen coordinates are not used here on purpose — after a system
    // suspend they can be stale, and a stale delta would move the pet by
    // nothing at all.
    const dx = (Number.isFinite(e.clientX) ? e.clientX : 0) - downClientX;
    const dy = (Number.isFinite(e.clientY) ? e.clientY : 0) - downClientY;
    if (dx !== 0 || dy !== 0) {
      try { M.pet.moveBy(dx, dy); } catch {}
    }
  }
}

// The pointer events.
//
// The family gate is what keeps the two input paths apart: only the family
// that started the gesture may drive it — with one exception, the handover
// in `mousemove` below.
window.addEventListener('pointermove', (e) => {
  countInputEvent('pointer');
  // Remember where the pointer is, so a compatibility mouse event can be
  // recognised later (see `isCompatMouseEvent`).
  lastPointerScreenX = Number.isFinite(e.screenX) ? e.screenX : 0;
  lastPointerScreenY = Number.isFinite(e.screenY) ? e.screenY : 0;
  lastPointerTimeStamp = Number.isFinite(e.timeStamp) ? e.timeStamp : 0;
  if (dragFamily !== 'pointer') {
    // The pointer family is moving while the gesture belongs to the mouse
    // family. That means the pointer device came back in the middle of a
    // gesture — the gesture takes the handover, but only while the pet has
    // not started moving (see `switchGestureFamily`).
    if (dragFamily === 'mouse' && pressing && !didDrag) {
      if (distanceFromPress(e) >= DRAG_THRESHOLD_PX) {
        switchGestureFamily('pointer', e);
      }
    }
    return;
  }
  handleDragMove(e, 'pointer');
});

// The mouse events — the fallback for a browser whose pointer events have
// stopped after a system suspend.
//
// A mouse gesture cannot be captured, so it only survives while the cursor
// stays over the window. That is enough: the main process takes the
// position over within a tick and follows the OS cursor from there.
window.addEventListener('mousemove', (e) => {
  countInputEvent('mouse');
  if (dragFamily !== 'mouse') {
    // The mouse family is moving while the gesture belongs to the pointer
    // family. Two very different things can cause that:
    //
    //   * The browser is dispatching both families and this is the
    //     COMPATIBILITY echo of a pointer move — the same position, in the
    //     same task. It carries no information of its own and must be
    //     ignored, or it would steal the gesture from the pointer family.
    //
    //   * The pointer pipeline died in the middle of the gesture. The press
    //     arrived as a pointer event, the movement arrives as mouse events,
    //     and the family gate would throw the movement away: the gesture
    //     would sit there doing nothing until the release, and the pet
    //     could not be dragged. The mouse family takes the handover — but
    //     only once the movement is big enough to be a drag, and only while
    //     the pet has not started moving.
    if (dragFamily === 'pointer' && pressing && !didDrag && !isCompatMouseEvent(e)) {
      if (distanceFromPress(e) >= DRAG_THRESHOLD_PX) {
        gestureMouseMoves++;
        switchGestureFamily('mouse', e);
        handleDragMove(e, 'mouse');
      } else {
        gestureMouseMoves++;
      }
    }
    return;
  }
  handleDragMove(e, 'mouse');
});

window.addEventListener('pointerup', (e) => {
  if (dragFamily !== 'pointer') {
    // The gesture belongs to the MOUSE family, and the pointer family has
    // just delivered a release.
    //
    // That happens after a handover: the press arrived as a pointer event
    // and the movement as mouse events, so the mouse family took the
    // gesture over. The mouse family cannot capture the pointer, so its
    // own release may never arrive — a `mouseup` is only delivered while
    // the cursor is over the window. This release is a perfectly good
    // ending, and taking it is what keeps the gesture from staying open
    // (an open gesture swallows the next press, and the pet could never be
    // dragged again).
    if (dragFamily === 'mouse' && pressing) {
      endDrag(false, 'pointerup');
      return;
    }
    // A release with no press behind it.
    //
    // After a system suspend this is the signature of a press whose
    // `pointerdown` was swallowed: the gesture never started, so nothing
    // was waiting for this release. It only counts when the OTHER family
    // has never been seen at all — otherwise every ordinary release would
    // be reported as an orphan.
    if (!pressing && mouseEventCount === 0) diagOrphanRelease('pointer', e);
    return;
  }
  // Same self-heal as in `pointermove`: a `pointerup` from a different
  // pointer proves the captured one is dead. End the stale gesture instead
  // of ignoring the event — otherwise the gesture stays wedged.
  if (dragPointerId !== null && e.pointerId !== dragPointerId) {
    endDrag(true, 'foreign-pointer');
    return;
  }
  // The pointer capture is released by `endDrag` itself, and that happens
  // AFTER it has cleared the gesture state — see the comment inside
  // `endDrag` about the ordering.
  //
  // Releasing it HERE instead would fire `lostpointercapture`
  // synchronously, while the gesture was still live. The handler for that
  // event would tear the gesture down a second time, as a FORCED teardown,
  // and the forced path deliberately skips the click side effects. The
  // outer `endDrag()` below would then find the gesture already torn down
  // and do nothing either.
  //
  // The net effect was that a click on the pet never ran its click side
  // effects at all — which is why the pet's click never dismissed the
  // reminder it was nagging about: that dismissal lived in exactly those
  // side effects, so it was dead code.
  endDrag(false, 'pointerup');
});

// The mouse release — the fallback input path (see `dragFamily`).
window.addEventListener('mouseup', (e) => {
  if (dragFamily !== 'mouse') {
    // The mirror image of the pointer case above: a release with no press
    // behind it while the pointer family has never been seen at all.
    if (!pressing && pointerEventCount === 0) diagOrphanRelease('mouse', e);
    return;
  }
  diagMouse('window-up', e);
  endDrag(false, 'mouseup');
});

// A mouse gesture can lose its release.
//
// The legacy mouse events have no pointer capture, so if the cursor leaves
// the window before the release arrives, the `mouseup` is never delivered
// and the gesture would stay open forever: `pressing` would remain true,
// the next press on the pet would be swallowed by that guard, and the pet
// could never be dragged again.
//
// The window follows the cursor once the drag starts, so the cursor normally
// stays inside it and this never fires. It is the safety net for the case
// where it does not — a fast flick that leaves the window before the drag
// threshold is crossed.
function endMouseGestureIfOpen(reason, e) {
  if (dragFamily !== 'mouse' || !pressing) return;
  diagMouse('window-leave', e, { reason });
  endDrag(false, reason);
}

// `mouseleave` is the direct signal: it fires when the pointer leaves the
// window. It does not bubble, so it is only heard on the window itself.
window.addEventListener('mouseleave', (e) => {
  endMouseGestureIfOpen('mouseleave', e);
});

// `mouseout` is the belt to that pair of braces: it bubbles, so it is heard
// wherever the pointer was when it left. It only means "the pointer left the
// window" when `relatedTarget` is null — a move to another element inside
// the window has a related element, and must not end the gesture.
window.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;
  endMouseGestureIfOpen('mouseout', e);
});

// `pointercancel` fires when the gesture is torn down by the platform (a
// touch being hijacked, a pen leaving range). It is the pointer-events
// equivalent of a lost `mouseup`.
window.addEventListener('pointercancel', (e) => {
  if (dragPointerId !== null && e.pointerId !== dragPointerId) {
    endDrag(true, 'foreign-pointer');
    return;
  }
  endDrag(false, 'pointercancel');
});

// `lostpointercapture` fires when the capture is released WITHOUT a
// `pointerup` — either the browser revoked it, or (the case that matters
// here) the underlying pointer device was torn down and re-created by a
// system suspend.
//
// There is no `lostpointercapture` listener anywhere else in this file, so
// without this one the gesture would sit in `pressing = true` with a
// dangling `dragPointerId` until some unrelated event happened to arrive.
// With it, the gesture is torn down the moment the capture is lost.
//
// The handler only acts when a gesture is actually in flight: the browser
// also fires `lostpointercapture` at the end of an ordinary release, and by
// then `pointerup` has already ended the gesture (`pressing` is false), so
// this is a no-op in the normal case.
window.addEventListener('lostpointercapture', (e) => {
  if (!pressing) return;
  // Only tear down if the capture we lost is the one this gesture owns.
  if (dragPointerId !== null && e.pointerId !== dragPointerId) return;
  endDrag(true, 'lostpointercapture');
});

// The window is `focusable: false`, so it never takes keyboard focus and
// `blur` is not a reliable signal on its own — but `visibilitychange` (the
// app being minimised or another window covering it) is. Both are wired up
// so a gesture can never survive the app losing the foreground.
window.addEventListener('blur', () => endDrag(true, 'blur'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) endDrag(false, 'hidden');
});

// ---- Drag watchdog (renderer side) ----
//
// The event-driven self-heal above already covers the "pointer identity
// changed" case: the first `pointermove` after the wake rebinds the stale
// gesture to the new pointer (or tears it down if it was already dragging).
// But that only helps if a `pointermove` actually arrives.
//
// It might not. Two independent reasons:
//
//   * The renderer can be frozen for the whole sleep and stay frozen for a
//     moment after the wake, so the `pointerup`/`pointermove` that would
//     have triggered the self-heal is delivered late or dropped
//     (electron/electron#43020).
//   * If the pointer does not move — the user just clicks — there is no
//     `pointermove` at all. The `pointerdown` would then be handled
//     correctly (it always resets the gesture), but a `pointerdown` on the
//     sprite requires the window to be hit-tested at the sprite's
//     coordinates, and a stale pointer capture can make Chromium route
//     that click to the capture target instead of to the sprite.
//
// So the renderer also runs its own clock watchdog. It is the same trick
// the main process uses: timers do not replay missed ticks across a sleep,
// but the wall clock jumps forward by the length of the sleep. A gap
// larger than the heartbeat interval therefore proves the renderer was
// frozen.
//
// This makes the renderer recover on its own, with no help from the main
// process and no reliance on an OS power event being delivered — the two
// things that cannot be relied upon.
const DRAG_WATCHDOG_INTERVAL_MS = 5000;
// This MUST be comfortably ABOVE the heartbeat interval: the gap is
// measured between two ticks, so a healthy gap is already ~INTERVAL. A
// threshold below the interval would fire on every single tick.
//
// The margin covers a machine that is merely busy (a long GC pause, a
// heavy disk, a background tab doing work) while still catching any real
// sleep — the shortest thing anyone calls a "sleep" is several seconds,
// and a real suspend is measured in minutes.
const DRAG_WATCHDOG_GAP_MS = 20000;
let lastWatchdogAt = Date.now();
const dragWatchdog = setInterval(() => {
  const now = Date.now();
  const gap = now - lastWatchdogAt;
  lastWatchdogAt = now;
  if (gap <= DRAG_WATCHDOG_GAP_MS) return;
  // We were frozen — the machine slept. Any gesture in flight is stale:
  // its pointer device is gone and its `pointerup` was never delivered.
  try {
    if (M.pet && typeof M.pet.diag === 'function') {
      M.pet.diag(diagSnapshot({
        kind: 'freeze',
        where: 'renderer',
        gapMs: gap,
        pressing, didDrag, dragPointerId, dragOwner, dragLive,
      }));
    }
  } catch (e) { /* diagnostics must never break the recovery */ }
  if (pressing || didDrag || dragPointerId !== null) {
    endDrag(true, 'watchdog');
  }
}, DRAG_WATCHDOG_INTERVAL_MS);
// The watchdog must not keep the page alive on its own.
if (dragWatchdog && typeof dragWatchdog.unref === 'function') dragWatchdog.unref();

window.addEventListener('contextmenu', (e) => {
  diagMouse('contextmenu', e);
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
  // The system came back from sleep/hibernate. The main process has already
  // torn down its side of the drag (the cursor poller and the controller's
  // drag mutex) — see main/pet_resume.js.
  //
  // The renderer has to forget its gesture too: a `pointerup` that happened
  // while the machine was asleep was never delivered, so `pressing` would
  // still be true and the next mouse move over the pet would compute a
  // delta against a stale baseline and teleport it.
  //
  // `endDrag(true)` forces the reset AND sends `pet:drag_end`, which is
  // harmless (the main process's handler is idempotent) and guarantees the
  // main process learns the gesture is over even if it somehow still
  // believed a drag was running.
  M.on('pet:resume', () => {
    // Record the wake before tearing the gesture down: the snapshot is
    // what shows whether the pet's own geometry survived the sleep.
    try {
      if (M.pet && typeof M.pet.diag === 'function') {
        M.pet.diag(diagSnapshot({ kind: 'resume', where: 'renderer' }));
      }
    } catch (e) { /* diagnostics must never break the recovery */ }
    endDrag(true, 'resume');
    // The main process is watching for proof that input is reaching this
    // renderer again (see `countInputEvent`). The next wake needs a fresh
    // report, so the flag goes back to "not reported yet".
    inputAliveReported = false;
  });
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
    // Record the boot.
    //
    // The wake recovery can restart the pet, and the diagnostic log is the
    // only place that can tell "the pet's page was rebuilt and the mouse
    // still does not arrive" apart from "the pet's page was never rebuilt
    // at all". The log line is written FIRST, before anything can fail, so
    // a page that dies during init still leaves a trace.
    try {
      if (M.pet && typeof M.pet.diag === 'function') {
        M.pet.diag(diagSnapshot({ kind: 'boot', where: 'renderer' }));
      }
    } catch (e) { /* diagnostics must never break the pet */ }

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
