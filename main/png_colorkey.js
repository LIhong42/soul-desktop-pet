// main/png_colorkey.js — run a single PNG through the border-connected
// cutout and return the transparentized output bytes.
//
// Why: pet packs imported via the zip uploader often ship frames with a
// solid black background (e.g. ripped from a Live2D preview page). When
// the pet is dropped on the desktop, that black background shows as a
// square border around the character, which looks broken. We pipeline
// each PNG through a cutout before it lands on disk so the alpha channel
// matches the actual silhouette.
//
// Why not ffmpeg's `colorkey` filter
// --------------------------------
// The original implementation ran
// `format=rgba,colorkey=0x000000:0.1:0.0`. A colorkey makes *every*
// pixel close to the key colour transparent, anywhere in the frame — so
// the character's black hair, black clothing and black outlines were
// punched out too, leaving a ragged half-erased sprite.
//
// The fix is a connectivity rule instead of a colour rule: only the
// background regions that can be *reached from the image border* without
// crossing the character are removed. A black garment enclosed by the
// character's outline survives, even when its colour matches the
// backdrop exactly. The implementation lives in
// `main/png_border_cutout.js` (the JS port of
// `opencv_border_cutout.py`).
//
// Why a temp file instead of stdin/stdout pipes:
//   Windows ffmpeg rejects explicit `pipe:0` / `pipe:1` filenames
//   (it tries to open a literal file named "pipe:1"), and refuses to
//   emit PNG to an unnamed stdout pipe ("At least one output file must
//   be specified"). Going through `os.tmpdir()` is reliable on every
//   platform; we clean up on every exit path.

const { cutoutPngBuffer } = require('./png_border_cutout');

// Run one PNG through the cutout pipeline. Returns a Buffer holding the
// re-encoded PNG (same width/height, now RGBA with the border-connected
// background turned transparent).
//
// `threshold` is the colour distance from the estimated backdrop that
// still counts as background; `softness` is the edge-feathering ring
// count (0-4).
//
// Throws on any failure; the message includes the underlying reason so
// the user can see what actually went wrong.
function transparentizePng(bytes, options = {}) {
  return cutoutPngBuffer(bytes, options);
}

module.exports = { transparentizePng };
