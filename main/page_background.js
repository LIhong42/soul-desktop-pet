// main/page_background.js — the shared background artwork for the pages
// that wear one.
//
// ---------------------------------------------------------------------------
// What this is
// ---------------------------------------------------------------------------
// Several pages paint one of the images in `resources/ui/` behind their
// content: the 今日 page, the 联系人 list, the 提醒日期 list, the 工作事件
// list and the 抽卡人生 page. They all wear the SAME picture, and the user
// picks that picture once in 设置.
//
// This module owns that *choice*; the folder itself is catalogued by
// main/ui_artwork.js, which is also where the other pages' artwork (the
// contact detail page's header banner) is registered.
//
// It used to live under the 今日 page's name (main/today_background.js) and
// to serve the 今日 page alone. The choice — "which picture, or none" — never
// belonged to one page, so the module was renamed and widened: the artwork
// catalog, the settings key and the "no background" sentinel are now shared
// by every page that wears a background.
//
// ---------------------------------------------------------------------------
// Why a module instead of reading the folder inline in ipc.js
// ---------------------------------------------------------------------------
// The renderer cannot read the filesystem, and the main window's CSP is
// `img-src 'self' data: file:` — so the image has to cross the IPC boundary as
// a `file://` URL, exactly the way pet frames and text boxes already do
// (see pet_registry.resolveFrames / pet_text_boxes.resolve). Building that URL
// here, next to those two, means the three can't disagree about how a local
// image reaches the renderer.
//
// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------
// `active()` reports the file the pages should use as their background:
//
//   1. The user's choice, stored in settings as `page_background_id`.
//   2. Otherwise the default — the first of the 今日 page's own artwork by sort
//      order, which is what makes "just ship one and it works" true.
//
// A choice that names a file this install doesn't have degrades to the
// default rather than to no background at all: the artwork is decoration, and
// a missing decoration should never blank the page.
//
// Only artwork the 今日 page *owns* is offered here. An image claimed by
// another page (the contact detail page's banner) is that page's own
// furniture and stays out of this picker — see main/ui_artwork.js.
//
// The pages also have to be readable *over* the artwork, so the CSS puts a
// translucent scrim between the image and the content — that's a styling
// concern, not one of this module's.

const uiArtwork = require('./ui_artwork');

// Only these are offered. Lowercased because a `.PNG` from a Windows
// screenshot tool must not silently vanish.
const ACCEPTED_EXT = uiArtwork.ACCEPTED_EXT;

// The settings key the user's choice is stored under.
//
// It is stored under ONE key for all the pages that wear a background, not
// one key per page: the user picks a picture, not a picture per page, and
// keeping the choice in a single row means adding a page to the set later
// can't strand an older install with a stale per-page key.
const SETTING_KEY = 'page_background_id';

// The id used when the user has explicitly asked for no background.
//
// It has to be distinguishable from "the user never chose anything", so it
// can't be the empty string: the settings row is absent for "never chose"
// (getSetting returns null) and holds this sentinel for "explicitly off".
// That distinction is what lets the user turn the artwork off and still be
// able to turn it back on via the "跟随默认" option.
const NONE = '__none__';

// The routes that wear the background artwork.
//
// The renderer matches this list EXACTLY (see routeHasBackground in
// src/js/page_background.js), so a detail page under a listed route does
// NOT inherit the artwork — which is why the entries below are the *list*
// pages themselves and not their parents. `/contacts` is a prefix of
// `/contacts/:id`, so a prefix match would put the artwork behind the
// contact DETAIL page as well; that page owns its own banner
// (`user-detail-background.png`) and paints a full-bleed paper surface, so
// the list artwork would only show through at its edges.
//
// The renderer asks for the background per route (see src/js/main.js), so
// this list is the single place that decides which pages wear the artwork.
// The renderer keeps a copy of it (src/js/page_background.js →
// BACKGROUND_ROUTES) to fall back on when the IPC bridge is unavailable,
// and the 设置 page keeps a copy of the ROUTE NAMES (src/js/pages/settings.js
// → PAGE_BG_ROUTE_LABELS) to label them for the user — so a route added
// here needs adding there too.
const BACKGROUND_ROUTES = [
  '/today',
  '/contacts',
  '/reminders',
  '/events/work',
  '/card-life',
];

/**
 * Locate the ui directory. `appPath` is the app root (the parent of `main/`),
 * matching how pet_registry finds `resources/pets`.
 */
function uiDir(appPath) {
  return uiArtwork.uiDir(appPath);
}

/**
 * List the background images the pages may use.
 *
 * Returns `[{ id, file, url, label }]`, sorted by id so the order is stable
 * across machines — `readdir` order is filesystem-dependent, and a list that
 * reorders itself between launches makes "the one I picked" ambiguous to a
 * user comparing screenshots.
 *
 * Only the 今日 page's OWN artwork is listed. An image claimed by another page
 * (the contact detail page's banner) belongs to that page's layout and is not
 * a background the user picks from a list.
 */
function list(appPath) {
  return uiArtwork.byOwner(appPath, 'today');
}

/**
 * Drop the memoised scan. Called by tests, and defensively on the settings
 * page render in case a dev adds a PNG while the app is running.
 */
function invalidate() {
  uiArtwork.invalidate();
}

/**
 * Resolve a persisted id to something renderable: `{ id, url }`, or `null` when
 * the id is empty ("no background") or names an image we don't have.
 *
 * The renderer treats `null` as "paint no artwork", so every caller gets the
 * same degradation.
 */
function resolve(appPath, id) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return null;
  const hit = list(appPath).find((b) => b.id === s);
  if (!hit) return null;
  return { id: hit.id, url: hit.url };
}

/**
 * The background the pages should paint, and the catalog the settings page
 * offers.
 *
 * `chosen` is the user's stored id; `current` is what actually gets used. They
 * differ in exactly three cases:
 *
 *   - The user has never chosen anything (no settings row) → `current` is the
 *     folder default (the first entry), so the shipped artwork shows up with
 *     no setup.
 *   - The user chose an image this install doesn't have → `current` falls back
 *     to the folder default rather than to nothing.
 *   - The user explicitly turned the background off → `current` is null.
 */
function active(appPath, db) {
  const rows = list(appPath);
  const stored = db && typeof db.getSetting === 'function'
    ? db.getSetting(SETTING_KEY)
    : null;
  const chosen = stored == null ? null : String(stored).trim();

  // `chosen === NONE` is the user saying "no background" — honour it rather
  // than falling back to the default, or the user could never turn the
  // artwork off.
  //
  // A *blank* stored value is different: that's the settings row the picker's
  // "跟随默认" writes when it clears the choice, and it means "follow the
  // folder default" — the same as never having chosen at all. `chosen` is
  // reported as null for it, so the picker shows 跟随默认 selected rather
  // than a blank entry.
  const explicitlyOff = chosen === NONE;
  const effective = (chosen === '') ? null : chosen;

  let current = null;
  if (effective && !explicitlyOff) {
    const hit = resolve(appPath, effective);
    if (hit) {
      current = hit;
    } else if (rows.length) {
      // The chosen image isn't on this machine. Fall back to the default
      // rather than to nothing: the artwork is decoration, and a stale id
      // shouldn't blank the page.
      current = { id: rows[0].id, url: rows[0].url };
    }
  } else if (!explicitlyOff && rows.length) {
    // Never chose anything → the folder default.
    current = { id: rows[0].id, url: rows[0].url };
  }

  return {
    // The catalog, for the settings page's picker.
    list: rows,
    // The id the user picked, verbatim — `null` when they've never chosen
    // (or when they cleared the choice), so the picker can show "跟随默认"
    // as a distinct state.
    chosen: effective,
    // What the pages paint: `{ id, url }` or null for no artwork.
    current,
    // The id that stands for "no background" in the picker.
    noneId: NONE,
    // The routes that wear the artwork, so the renderer doesn't have to
    // keep a second copy of the list.
    routes: BACKGROUND_ROUTES,
  };
}

module.exports = {
  ACCEPTED_EXT,
  SETTING_KEY,
  NONE,
  BACKGROUND_ROUTES,
  uiDir,
  list,
  resolve,
  active,
  invalidate,
};
