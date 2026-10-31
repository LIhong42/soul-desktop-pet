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
//      `lastX/lastY` — teleporting the pet across the screen and leaving
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
//      I captured" as PROOF that my captured gesture is dead — the pointer
//      that owned it no longer exists — and to tear the gesture down
//      immediately, freeing the pointer id for the next gesture.
//
//      This is event-driven rather than lifecycle-driven on purpose. The
//      main process also listens for `powerMonitor`'s `resume`, but that
//      event is not dependable on Windows 11 Modern Standby (the OS freezes
//      the process before the event is delivered, electron/electron#47739),
//      and a plain lid-close without a lock screen may produce no
//      `unlock-screen` either. If the recovery only ran on those events, the
//      pet would stay wedged — which is exactly what the original bug
//      report describes.
const DRAG_THRESHOLD_PX = 4;
let pressing = false;
let didDrag = false;
let lastX = 0, lastY = 0, downX = 0, downY = 0;
// The pointer id that started the current gesture, so `pointermove` /
// `pointerup` from a different pointer (a stray touch, a pen) can't hijack
// the drag.
//
// `null` means "no gesture owns a pointer id" — the state the renderer
// returns to whenever a gesture ends or is torn down. Keeping it `null`
// (rather than a stale id) is what allows the next gesture to start.
let dragPointerId = null;

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
function endDrag(force = false) {
  if (!pressing && !force) return;
  const wasDragging = didDrag;
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
  pressing = false;
  didDrag = false;
  dragPointerId = null;
  dragOwner = 'none';
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
  try { M.pet.dragEnd(); } catch {}
  if (wasDragging) {
    return;
  }
  // A forced teardown (the resume path) is NOT a click. It must not run the
  // click side effects below — otherwise waking the machine up would
  // dismiss a pending reminder bubble the user never acknowledged.
  if (force) {
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

sprite.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pressing = true;
  didDrag = false;
  // Ownership is decided when the drag threshold is crossed, not here — but
  // it must start from a clean slate in case a previous gesture ended
  // without going through `endDrag`.
  dragOwner = 'none';
  downX = e.screenX;
  downY = e.screenY;
  lastX = e.screenX;
  lastY = e.screenY;
  dragPointerId = e.pointerId;
  // Capture the pointer so this element keeps receiving move/up events even
  // if the pointer travels outside the window. Without this the gesture
  // simply evaporates the moment the cursor leaves the 220 px box.
  try { sprite.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!pressing) return;
  // Self-heal: an event from a pointer that is not the one this gesture
  // captured means the captured pointer is gone — the device was re-created
  // by a system suspend, or the gesture was hijacked by another pointer.
  //
  // The old code just `return`ed here, which left `dragPointerId` pointing
  // at a dead id forever. Every subsequent event from the new mouse was
  // rejected by the same guard, so the pet could never be dragged again for
  // the rest of the session. Tearing the gesture down here frees the id and
  // lets the next `pointerdown` start a clean drag.
  if (dragPointerId !== null && e.pointerId !== dragPointerId) {
    endDrag(true);
    return;
  }
  if (!didDrag) {
    if (Math.hypot(e.screenX - downX, e.screenY - downY) < DRAG_THRESHOLD_PX) return;
    didDrag = true;
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
    // The grab offset is measured against the WINDOW's own screen position.
    // `window.screenX` is the browser's view of it, which can be stale:
    // after a suspend/resume the OS may have moved the window (display
    // reconfiguration, monitor hotplug, dock undock), and the renderer is
    // not guaranteed to have caught up. A stale value would offset the
    // window by that delta the moment the drag starts, making the pet jump.
    //
    // So the offset is resolved against the main process's authoritative
    // window position instead. `M.pet.getPosition()` returns the real,
    // current coordinates. When it is unavailable or fails (an older main
    // process) we fall back to `window.screenX`, which is the pre-existing
    // behaviour.
    //
    // The lookup is asynchronous, so the takeover happens a tick later than
    // it used to. That is harmless: the main process places the window
    // under the cursor immediately on `drag_start`, and until then the
    // renderer holds still (see the 'pending' ownership mode above).
    //
    // The start must NOT be cancelled by a `pointerup` that lands while the
    // lookup is still in flight — a quick flick (press, move, release) is
    // over before the reply arrives, and skipping the start would leave the
    // main process with a drag it knows nothing about. Instead the start is
    // always sent, and the `drag_end` that follows it tears the main
    // process's side back down. Both messages are ordered on the same
    // channel, so the main process sees start-then-end and ends up idle.
    dragOwner = 'pending';
    const fallbackOffset = { dx: e.screenX - window.screenX, dy: e.screenY - window.screenY };
    const startDrag = (offset) => {
      Promise.resolve(M.pet.dragStart(offset.dx, offset.dy)).then(
        () => { if (pressing && dragOwner === 'pending') dragOwner = 'main'; },
        () => { if (pressing && dragOwner === 'pending') dragOwner = 'local'; }
      );
    };
    try {
      if (typeof M.pet.getPosition === 'function') {
        Promise.resolve(M.pet.getPosition()).then(
          (pos) => {
            // A malformed reply means the main process is not usable for
            // this — fall back rather than dragging the pet to the origin.
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
              startDrag({ dx: e.screenX - pos.x, dy: e.screenY - pos.y });
            } else {
              startDrag(fallbackOffset);
            }
          },
          () => startDrag(fallbackOffset)
        );
      } else {
        startDrag(fallbackOffset);
      }
    } catch {
      dragOwner = 'local';
    }
  }

  // The window position is owned by the main process for the duration of
  // the drag — it polls the cursor and writes the absolute position. The
  // renderer must NOT also apply a relative delta on top of that: the two
  // would compound and the pet would race away from the cursor.
  if (dragOwner === 'local') {
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (dx !== 0 || dy !== 0) {
      try { M.pet.moveBy(dx, dy); } catch {}
    }
  }
  lastX = e.screenX;
  lastY = e.screenY;
});

window.addEventListener('pointerup', (e) => {
  // Same self-heal as in `pointermove`: a `pointerup` from a different
  // pointer proves the captured one is dead. End the stale gesture instead
  // of ignoring the event — otherwise the gesture stays wedged.
  if (dragPointerId !== null && e.pointerId !== dragPointerId) {
    endDrag(true);
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
  endDrag();
});

// `pointercancel` fires when the gesture is torn down by the platform (a
// touch being hijacked, a pen leaving range). It is the pointer-events
// equivalent of a lost `mouseup`.
window.addEventListener('pointercancel', (e) => {
  if (dragPointerId !== null && e.pointerId !== dragPointerId) {
    endDrag(true);
    return;
  }
  endDrag();
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
  endDrag(true);
});

// The window is `focusable: false`, so it never takes keyboard focus and
// `blur` is not a reliable signal on its own — but `visibilitychange` (the
// app being minimised or another window covering it) is. Both are wired up
// so a gesture can never survive the app losing the foreground.
window.addEventListener('blur', endDrag);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) endDrag();
});

// ---- Drag watchdog (renderer side) ----
//
// The event-driven self-heal above already covers the "pointer identity
// changed" case: the first `pointermove` after the wake tears the stale
// gesture down. But that only helps if a `pointermove` actually arrives.
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
  if (pressing || didDrag || dragPointerId !== null) {
    endDrag(true);
  }
}, DRAG_WATCHDOG_INTERVAL_MS);
// The watchdog must not keep the page alive on its own.
if (dragWatchdog && typeof dragWatchdog.unref === 'function') dragWatchdog.unref();

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
    endDrag(true);
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
