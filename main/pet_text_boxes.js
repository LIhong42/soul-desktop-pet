// main/pet_text_boxes.js — the 文本框 (text box) catalog.
//
// ---------------------------------------------------------------------------
// What this is
// ---------------------------------------------------------------------------
// Scans `resources/text_boxes/` for bubble artwork and exposes it as a list the
// settings page can offer per action. These are **drawn bubbles**, not
// transparent decorations: each PNG is a full bubble with its own white text
// area, so choosing one replaces the CSS-drawn bubble entirely rather than
// decorating it.
//
// The folder is scanned rather than hard-coded so dropping a new PNG in is the
// only step needed to add a text box — the same contract resources/pets has.
//
// ---------------------------------------------------------------------------
// The image contract
// ---------------------------------------------------------------------------
// Every file in the folder is offered as-is; there's no manifest to keep in
// sync and therefore no way for the catalog and the folder to disagree. The
// id is the filename without its extension (`3.png` → `3`), which is what gets
// persisted in the action config, so it must stay stable across sessions.
//
// Only `.png` is picked up. Anything else (a README, a .DS_Store left by a
// macOS copy, a stray .psd) is ignored rather than surfacing as a broken
// choice in the dropdown.
//
// ---------------------------------------------------------------------------
// Why a module instead of reading the folder inline in ipc.js
// ---------------------------------------------------------------------------
// The renderer needs a `file://` URL, not a filesystem path: the pet window
// runs with a CSP of `img-src 'self' file: data:` and loads frames exactly
// this way already (see pet_registry.resolveFrames). Building that URL here —
// next to the equivalent logic for pet frames — means the text boxes and the
// pet frames can't disagree about how to hand the renderer a local image.
//
// The scan result is memoised because it's read on every settings-page render
// and the folder is static at runtime; re-stat'ing seven files per render
// would be wasted work. `invalidate()` exists for tests and for the packaging
// case where resources land next to the app rather than inside it.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// Geometry (每张图里气泡实际占的位置)
// ---------------------------------------------------------------------------
//
// The shipped art is a 2048×2048 canvas with the drawn bubble occupying only
// the middle band of it — roughly 8–19% transparent margin on each side and
// 24–33% above and below. Two consequences drive this whole table:
//
//   1. Positioning the element by the *canvas* left ~25–30% of invisible
//      padding between the bubble and the pet, which read as the bubble
//      "floating too high". The bubble's own bottom edge, not the canvas's, is
//      what should sit at the pet's head.
//   2. The bubbles are not square — aspect ranges from 1.50 (1.png) to 2.45
//      (5.png) — so a fixed square sized element would distort every one of
//      them. Sizing has to follow each image's own aspect.
//
// The numbers below are the opaque-pixel bounds as percentages of the canvas,
// produced by `node scripts/measure-text-boxes.js`. They are a *cached
// measurement*, not a scan at runtime: decoding a 2048×2048 PNG costs ~17MB of
// inflate and would be absurd on the render path, and the art is static.
//
// ---------------------------------------------------------------------------
// The two aspects, and why the text uses `ia` rather than `aspect`
// ---------------------------------------------------------------------------
//
// `aspect` is the **drawing** — bubble plus its decoration. `ia` is the flat
// white **interior** the text is actually laid into. They are not concentric and
// not the same shape, and the difference is large: the interior is 5% to 38%
// wider than the drawing (worst on 5.png, whose end-caps eat a third of its
// width).
//
// Sizing the bubble from `aspect` therefore made every box too tall for its
// text, and the surplus appeared as text sitting high in the white with the
// empty space piled underneath — which is most of what "the text is bunched in
// the top-left" actually looked like. `ia` is what the renderer lays out to.
//
// `il`/`it`/`ir`/`ib` are the interior's own margins from the canvas edge, and
// `dx`/`dy` are how far the interior's centre sits from the drawing's centre as a
// fraction of the drawing's width/height. Both are needed because a drawing
// centred vertically is not a text line centred vertically: 1.png hangs bat
// wings above the bubble and dangles a cross below it, and 7.png's lace trim
// sits heavier along the bottom edge.
//
// A zero in `dx`/`dy` is a measurement, not a gap — 3, 5 and 7 measure as
// horizontally centred (their decoration is symmetric left-to-right), which is
// exactly why their vertical offset is the only correction that applies.
//
// If you replace or add art, re-run the measurement script and paste the new
// row. An id with no row here still works — it just gets the conservative
// fallback geometry (see `geometryFor`).
const GEOMETRY = {
  '1': { left:  7.23, top: 19.24, right:  8.79, bottom: 15.33, aspect: 1.284, ia: 1.609, dx:  0.0498, dy: -0.0281 },
  '2': { left:  3.81, top: 26.27, right:  3.76, bottom: 25.24, aspect: 1.906, ia: 2.007, dx:  0.0024, dy: -0.0059 },
  '3': { left:  6.88, top:  8.79, right:  6.88, bottom:  8.84, aspect: 1.047, ia: 1.729, dx:  0,      dy: -0.0049 },
  '4': { left:  2.44, top: 23.10, right:  2.15, bottom: 19.78, aspect: 1.670, ia: 2.152, dx:  0.0022, dy: -0.0249 },
  '5': { left:  4.59, top: 28.91, right:  3.66, bottom: 28.91, aspect: 2.175, ia: 3.383, dx: -0.0046, dy:  0.0015 },
  '6': { left: 11.43, top: 25.00, right:  7.91, bottom: 19.34, aspect: 1.449, ia: 1.704, dx: -0.0176, dy: -0.0078 },
  '7': { left:  5.62, top: 21.00, right:  5.62, bottom: 23.97, aspect: 1.613, ia: 2.170, dx:  0,      dy:  0.0156 },
};

// Used for art with no measured row. Assumes the bubble is centred with a
// quarter-canvas margin all round, which is close enough that a missing
// measurement costs a slightly larger clickable box rather than a misplaced
// bubble — and the artwork is `pointer-events: none` regardless, so nothing is
// clickable in the first place.
//
// `ia` matches `aspect` here rather than being some wider guess: with no
// measurement there is no evidence the interior is wider than the drawing, and
// assuming it is would size every unmeasured box to a shape it probably doesn't
// have. `dx`/`dy` are 0 for the same reason a centred guess can't justify any
// correction — a spurious offset would move *every* unmeasured box off true.
const FALLBACK_GEOMETRY = { left: 10, top: 25, right: 10, bottom: 25, aspect: 1.6, ia: 1.6, dx: 0, dy: 0 };

function geometryFor(id) {
  return GEOMETRY[String(id)] || FALLBACK_GEOMETRY;
}

// The interior's aspect — the shape the *text* is laid into, as opposed to
// `aspect`, which is the shape of the whole drawing including its decoration.
//
// Exposed as a helper rather than read off the raw row at each call site so
// that an older cached row without an `ia` still works: it falls back to the
// drawing's own aspect, which is what the renderer used unconditionally before
// the two were separated. Better a box that's merely a little tall than one
// sized to a shape nobody measured.
function interiorAspectFor(id) {
  const g = geometryFor(id);
  return Number.isFinite(g.ia) && g.ia > 0 ? g.ia : (g.aspect || 1.6);
}

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------
//
// The value meaning "use the current CSS-drawn bubble". It's the empty string
// rather than a literal id so an action with no choice stored and an action
// explicitly reset to default are the same state in the DB — one less thing to
// migrate, and it means a folder of text boxes can be emptied without leaving
// dangling references behind.
const DEFAULT_BOX = '';

// Only these are offered. Lowercased because a `.PNG` from a Windows
// screenshot tool must not silently vanish.
const ACCEPTED_EXT = '.png';

// Memo's the last scan. `null` ⇒ never scanned. A scan that finds nothing is
// cached too (as an empty array) — that's a valid state meaning "this install
// has no text boxes", and re-scanning on every render wouldn't find any.
let cache = null;

/**
 * Locate the text_boxes directory. `appPath` is the app root (the parent of
 * `main/`), matching how pet_registry finds `resources/pets`.
 */
function boxDir(appPath) {
  return path.join(appPath || path.join(__dirname, '..'), 'resources', 'text_boxes');
}

/**
 * List the available text boxes.
 *
 * Returns `[{ id, file, url, label }]`, sorted by id so the dropdown order is
 * stable across machines — `readdir` order is filesystem-dependent, and a list
 * that reorders itself between launches makes "the one I picked" ambiguous to
 * a user comparing screenshots.
 *
 * Sorting is numeric-aware (`3` before `10`), falling back to a plain string
 * compare so a non-numeric id (`cloud`) still lands somewhere sensible.
 *
 * `url` is a `file://` URL for the renderer; `file` is the bare filename for
 * diagnostics. A file that vanishes between the readdir and the stat (a sync
 * tool mid-copy) is skipped instead of surfaced as a choice that 404s.
 */
function list(appPath) {
  if (cache) return cache;

  const dir = boxDir(appPath);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No folder at all. Not an error: a build without text boxes simply has no
    // options, and every action stays on the CSS default.
    cache = [];
    return cache;
  }

  const rows = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(ACCEPTED_EXT)) continue;
    // Skip directories that merely end in .png, and anything we can't stat.
    const abs = path.join(dir, name);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch { continue; }

    const id = path.basename(name, path.extname(name));
    if (!id) continue;
    const g = geometryFor(id);
    rows.push({
      id,
      file: name,
      // Same encoding the frame loader relies on: a Chinese filename has to be
      // percent-encoded or the <img> fails to load silently.
      url: pathToFileURL(abs).href,
      // What the dropdown shows. The raw id is the honest label — inventing a
      // name here would mean a second place to update when a PNG is renamed.
      label: id,
      // Carried so the settings page can render a thumbnail cropped to the
      // bubble rather than showing the mostly-empty canvas. Same numbers the
      // renderer uses; see the GEOMETRY note above.
      geom: {
        left: g.left, top: g.top, right: g.right, bottom: g.bottom,
        aspect: g.aspect,
        // The interior's aspect, which is what the text is laid into. Kept
        // beside `aspect` rather than replacing it because the crop math still
        // needs the drawing's own bounds.
        ia: interiorAspectFor(id),
        dx: g.dx, dy: g.dy,
      },
    });
  }

  rows.sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;      // numeric ids first, then named ones
    if (bNum) return 1;
    return a.id.localeCompare(b.id);
  });

  cache = rows;
  return cache;
}

/**
 * Drop the memoised scan. Called by tests, and defensively on the settings
 * page render in case a dev adds a PNG while the app is running.
 */
function invalidate() {
  cache = null;
}

/**
 * Is `id` a text box this install actually has?
 *
 * The point of this check is that the id reaches us from a persisted config
 * the user may have written on a different machine, or against a folder that
 * has since had files removed. A stale id must degrade to "use the CSS
 * default", never to an <img> pointing at a missing file.
 */
function isKnown(appPath, id) {
  const s = String(id == null ? '' : id).trim();
  if (!s || s === DEFAULT_BOX) return false;
  return list(appPath).some((b) => b.id === s);
}

/**
 * Resolve a persisted id to something renderable: `{ id, url }`, or `null` when
 * the choice is the default or names a box we don't have. The renderer treats
 * `null` as "keep the CSS bubble", so every caller gets the same degradation.
 */
function resolve(appPath, id) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return null;
  const hit = list(appPath).find((b) => b.id === s);
  if (!hit) return null;
  const g = geometryFor(hit.id);
  return {
    id: hit.id,
    url: hit.url,
    // The transparent margins around the drawn bubble, as percentages of the
    // canvas, plus the bubble's own aspect ratio. The renderer needs these to
    // size the element from the text and then crop the margin away — see the
    // GEOMETRY table above for why neither can be assumed.
    //
    // `ia` is the interior's aspect, which is the shape the text is laid into.
    // It differs from `aspect` by 5–38% because the decoration around each
    // bubble takes up space the text can't use, so the renderer must size to
    // `ia` and use `aspect` only for the crop.
    //
    // `dx`/`dy` come along because centring text on the drawing is not the same
    // as centring it on the white interior: decoration is unevenly distributed
    // around each bubble. They're fractions of the drawing's own size, so the
    // renderer can apply them to the sized element without knowing the canvas.
    geom: {
      left: g.left, top: g.top, right: g.right, bottom: g.bottom,
      aspect: g.aspect,
      ia: interiorAspectFor(hit.id),
      dx: g.dx, dy: g.dy,
    },
  };
}

module.exports = {
  DEFAULT_BOX,
  ACCEPTED_EXT,
  boxDir,
  list,
  resolve,
  isKnown,
  invalidate,

  // The measured bubble-inside-canvas table, so the settings page can render
  // each option's thumbnail cropped to its bubble rather than showing the
  // full 2048×2048 canvas (which would look like a mostly-empty square).
  GEOMETRY,
  geometryFor,
  interiorAspectFor,

  _internals: { cache },
};