// main/today_background.js — the 今日 page's background artwork catalog.
//
// ---------------------------------------------------------------------------
// What this is
// ---------------------------------------------------------------------------
// Scans `resources/ui/` for the images the 今日 page paints behind its
// content and hands the renderer `file://` URLs for them.
//
// The folder is scanned rather than hard-coded, for the same reason
// `resources/text_boxes` is: dropping a new PNG in is the only step needed to
// add an option. The ids are the filenames without their extensions, so
// `today-background.png` → `today-background`.
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
// The scan result is memoised because the folder is static at runtime;
// re-stat'ing it on every 今日 page render would be wasted work.
//
// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------
// `active()` reports the file the 今日 page should use as its background:
//
//   1. The user's choice, stored in settings as `today_background_id`.
//   2. Otherwise the folder's default — the first entry by sort order, which
//      is what makes "just ship one and it works" true.
//
// A choice that names a file this install doesn't have degrades to the
// default rather than to no background at all: the artwork is decoration, and
// a missing decoration should never blank the page.
//
// The 今日 page also has to be readable *over* the artwork, so the CSS puts a
// translucent scrim between the image and the content — that's a styling
// concern, not one of this module's.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Only these are offered. Lowercased because a `.PNG` from a Windows
// screenshot tool must not silently vanish.
const ACCEPTED_EXT = '.png';

// The settings key the user's choice is stored under.
const SETTING_KEY = 'today_background_id';

// The id used when the user has explicitly asked for no background.
//
// It has to be distinguishable from "the user never chose anything", so it
// can't be the empty string: the settings row is absent for "never chose"
// (getSetting returns null) and holds this sentinel for "explicitly off".
// That distinction is what lets the user turn the artwork off and still be
// able to turn it back on via the "跟随默认" option.
const NONE = '__none__';

// Memoised scan. `null` ⇒ never scanned.
let cache = null;

/**
 * Locate the ui directory. `appPath` is the app root (the parent of `main/`),
 * matching how pet_registry finds `resources/pets`.
 */
function uiDir(appPath) {
  return path.join(appPath || path.join(__dirname, '..'), 'resources', 'ui');
}

/**
 * List the available background images.
 *
 * Returns `[{ id, file, url, label }]`, sorted by id so the order is stable
 * across machines — `readdir` order is filesystem-dependent, and a list that
 * reorders itself between launches makes "the one I picked" ambiguous to a
 * user comparing screenshots.
 *
 * Sorting is numeric-aware (`2` before `10`), falling back to a plain string
 * compare so a non-numeric id (`today-background`) still lands somewhere
 * sensible. With the shipped art there's exactly one entry, so the sort is
 * belt-and-braces for when a second one is dropped in.
 *
 * `url` is a `file://` URL for the renderer; `file` is the bare filename for
 * diagnostics. A file that vanishes between the readdir and the stat (a sync
 * tool mid-copy) is skipped instead of surfaced as a choice that 404s.
 */
function list(appPath) {
  if (cache) return cache;

  const dir = uiDir(appPath);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No folder at all. Not an error: a build without any ui artwork simply
    // has no background, and the 今日 page renders on the plain app surface.
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
    rows.push({
      id,
      file: name,
      // Same encoding the frame loader relies on: a Chinese filename has to be
      // percent-encoded or the <img> fails to load silently.
      url: pathToFileURL(abs).href,
      // What the picker shows. The raw id is the honest label — inventing a
      // name here would mean a second place to update when a PNG is renamed.
      label: id,
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
 * The background the 今日 page should paint, and the catalog the settings page
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
    // What the 今日 page paints: `{ id, url }` or null for no artwork.
    current,
    // The id that stands for "no background" in the picker.
    noneId: NONE,
  };
}

module.exports = {
  ACCEPTED_EXT,
  SETTING_KEY,
  NONE,
  uiDir,
  list,
  resolve,
  active,
  invalidate,
};
