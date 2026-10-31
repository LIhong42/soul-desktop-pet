// main/pet_diagnostics.js — an append-only log of what the pet window did.
//
// Why this exists
// ---------------
// "The pet cannot be dragged any more after the machine sleeps" is a bug
// that only reproduces on real hardware: it needs an actual system
// suspend, which no automated test can perform. Guessing at the cause
// from the code alone is how the first two attempts at this bug went
// wrong — both were plausible, both were wrong, and both looked right.
//
// So the app records what it sees. Every pointer press, the first move of
// every gesture, every wake, and every drag takeover is written here as
// one JSON object per line, with the coordinates and the element geometry
// needed to tell the possible causes apart:
//
//   * the press never reached the sprite  → the window was hit-tested but
//     the sprite was not the target (a zero-sized sprite, an element on
//     top of it, a different pointer button)
//   * the moves never arrived  → the gesture's move counter stays at zero
//   * the moves arrived but the threshold was never crossed → the distance
//     from the press is in the log, so the threshold can be checked
//   * the drag started but the window did not move → the main process's
//     cursor poller is not writing the position
//
// Where it goes
// -------------
// `<userData>/pet-diagnostics.log` — the app's own data directory, never
// the repository. The file is capped, so it cannot grow without bound,
// and it is plain JSON lines so it can be read with any text editor.
//
// Diagnostics must never break the app: every write is wrapped, and a
// failure is swallowed.

'use strict';

const fs = require('fs');
const path = require('path');

// The cap. The log is a diagnostic aid, not an archive: when it grows
// past this, the oldest lines are dropped.
const MAX_BYTES = 512 * 1024;
// How many lines to keep when rotating.
const KEEP_LINES = 2000;

let cachedPath = null;

// The file the log is written to.
//
// `app.getPath('userData')` is the app's own data directory. It is
// resolved lazily because this module is loaded before Electron's `app`
// is ready.
function logPath() {
  if (cachedPath) return cachedPath;
  try {
    const { app } = require('electron');
    cachedPath = path.join(app.getPath('userData'), 'pet-diagnostics.log');
  } catch (e) {
    // No Electron (a plain-node script) — fall back to the OS temp
    // directory, NEVER to the working directory: a test run must not leave
    // files behind in the repository.
    cachedPath = path.join(require('os').tmpdir(), 'pet-diagnostics.log');
  }
  return cachedPath;
}

// Drop the oldest lines once the file grows past the cap.
//
// A failing rotation is not worth failing the write over — the next
// append would hit the same problem, and the file is a diagnostic aid.
function rotate(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(file, lines.slice(-KEEP_LINES).join('\n'), 'utf8');
  } catch (e) { /* the file may not exist yet */ }
}

// Append one entry.
//
// `entry` is a plain object. It is merged with a timestamp and written as
// a single JSON line.
function append(entry) {
  try {
    const file = logPath();
    rotate(file);
    const record = Object.assign({ t: new Date().toISOString() }, entry || {});
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

// Read the log back. Used by the tests and by anyone who wants to look
// at it from the main process.
function read() {
  try {
    return fs.readFileSync(logPath(), 'utf8');
  } catch (e) {
    return '';
  }
}

// Forget where the log lives. Only used by the tests, which need a
// different file per case.
function _resetPath() {
  cachedPath = null;
}

module.exports = { append, read, logPath, _resetPath, MAX_BYTES };
