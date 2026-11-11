// main/ui_artwork.js — the shared catalog of the artwork in `resources/ui/`.
//
// ---------------------------------------------------------------------------
// What this is
// ---------------------------------------------------------------------------
// `resources/ui/` holds the images the app paints as decoration: the shared
// page background the 今日 / 联系人 / 提醒 / 抽卡 pages
// wear, and the one the contact detail page wears across its whole page.
// The renderer
// cannot read the filesystem and the main window's CSP is
// `img-src 'self' data: file:` — so every one of these images has to cross
// the IPC boundary as a `file://` URL, exactly the way pet frames and text
// boxes already do (see pet_registry.resolveFrames / pet_text_boxes.resolve).
// Building that URL in one place means the pages can't disagree about how a
// local image reaches the renderer.
//
// The folder is *scanned*, not hard-coded, for the same reason
// `resources/text_boxes` is: dropping a new PNG in is the only step needed
// to add an option.
//
// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------
// Every page that wears artwork — the 今日 page, the list pages and the
// contact detail page — wears the SAME picture, chosen once in 设置
// (see main/page_background.js). So no image belongs to one page alone, and
// the picker lists them all.
//
// The scan result is memoised because the folder is static at runtime;
// re-stat'ing it on every page render would be wasted work.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Only these are offered. Lowercased because a `.PNG` from a Windows
// screenshot tool must not silently vanish.
const ACCEPTED_EXT = '.png';

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
 * List every artwork image in `resources/ui/`.
 *
 * Returns `[{ id, file, url, label }]`, sorted by id so the order is
 * stable across machines — `readdir` order is filesystem-dependent, and a
 * list that reorders itself between launches makes "the one I picked"
 * ambiguous to a user comparing screenshots.
 *
 * Sorting is numeric-aware (`2` before `10`), falling back to a plain string
 * compare so a non-numeric id (`today-background`) still lands somewhere
 * sensible.
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
    // has no decoration, and the pages render on the plain app surface.
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
 * Resolve an id to something renderable: `{ id, url }`, or `null` when the id
 * is empty or names an image we don't have.
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

module.exports = {
  ACCEPTED_EXT,
  uiDir,
  list,
  resolve,
  invalidate,
};
