// main/pet_input_probe.js — find out whether the pet window's INPUT PATH
// is still alive after a system suspend.
//
// The problem
// -----------
// After a wake the pet window can be alive and deaf at the same time.
//
// "Alive" means it still answers IPC: it replies to `pet:resume`, it
// answers `pet:gesture_base`, its diagnostic entries keep arriving. From
// the outside it looks perfectly healthy.
//
// "Deaf" means not a single mouse event reaches it. The window's input
// registration is broken — the pointer device was torn down by the suspend
// and the browser process's device registry does not know about the new
// one (see main/app_relaunch.js for the details).
//
// Nothing inside the running process can repair that: the device registry
// belongs to the browser process and is shared by every window, so a new
// window inherits it and a page reload certainly does. The only cure is a
// new PROCESS.
//
// How the probe tells the two apart
// ---------------------------------
// The probe watches two things at the same time:
//
//   * The OS cursor. The main process can read it directly
//     (`screen.getCursorScreenPoint()`) whether or not the renderer can.
//   * The renderer's own report. The renderer sends `pet:input_alive` the
//     first time it sees any input event after the wake.
//
// A healthy renderer answers that message as soon as the cursor moves over
// the pet — so the probe stops and does nothing.
//
// A deaf renderer never answers it. But "the cursor moved" alone proves
// nothing: the user may have moved the mouse over the desktop. So the
// probe also checks that the cursor is INSIDE the pet window — the window
// that would have received the event. The cursor moved, it is sitting on
// the pet, and the pet has not seen a single event: the input path is
// dead.
//
// The strike counter is what keeps this from firing on a single unlucky
// poll: the cursor has to sit on the pet, having moved, for several
// consecutive checks while the renderer stays silent.
//
// The probe gives up on its own after `timeoutMs`. A user who never
// touches the mouse after waking the machine must not cause a restart.

'use strict';

const DEFAULT_INTERVAL_MS = 500;
// How many consecutive checks have to agree before the input path is
// declared dead. At 500 ms per check that is a second and a half of the
// cursor sitting on the pet with no answer from the renderer.
const DEFAULT_STRIKES = 3;
// How long the probe keeps watching. Long enough to cover "the user woke
// the machine, went for coffee, came back and tried to drag the pet".
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// createInputProbe(options) → probe
//
// options:
//   getWindow()    → the pet window (or null when it is gone).
//   getCursor()    → {x, y} — the OS cursor position.
//   hasInputAlive()→ has the renderer reported input since the probe
//                    started?
//   onDead(reason) → called when the input path looks dead.
//   onAlive()      → called when the renderer proved it is alive.
//   intervalMs     → how often to poll.
//   strikes        → how many consecutive checks have to agree.
//   timeoutMs      → when to give up.
//
// The returned probe exposes:
//   start(reason)  → begin watching (a second start replaces the first).
//   stop()         → stop watching.
//   isRunning()    → is it watching?
function createInputProbe({
  getWindow,
  getCursor,
  hasInputAlive,
  onDead,
  onAlive,
  intervalMs = DEFAULT_INTERVAL_MS,
  strikes = DEFAULT_STRIKES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log,
} = {}) {
  let timer = null;
  let startedAt = 0;
  let cursor0 = null;
  let moved = false;
  let deadStrikes = 0;
  let reason = '';

  const note = (entry) => {
    if (typeof log === 'function') {
      try { log(entry); } catch (e) { /* the probe must never break the app */ }
    }
  };

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  // Is the cursor inside the pet window?
  //
  // The window's bounds are the whole point: the pet window is a small
  // transparent box, and a cursor sitting inside it is a cursor that MUST
  // have produced a mouse event if the input path were alive.
  const cursorOverPet = (cursor) => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || typeof win.getBounds !== 'function') return false;
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
    let b;
    try { b = win.getBounds(); } catch (e) { return false; }
    if (!b) return false;
    return cursor.x >= b.x && cursor.x < b.x + b.width
        && cursor.y >= b.y && cursor.y < b.y + b.height;
  };

  const check = () => {
    // The renderer proved it is alive → nothing to do.
    if (typeof hasInputAlive === 'function' && hasInputAlive()) {
      note({ kind: 'input_probe_alive', reason, afterMs: Date.now() - startedAt });
      stop();
      if (typeof onAlive === 'function') { try { onAlive(); } catch (e) {} }
      return;
    }
    // The pet window is gone — there is nothing left to probe.
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      stop();
      return;
    }
    let cursor = null;
    try { cursor = typeof getCursor === 'function' ? getCursor() : null; } catch (e) { cursor = null; }
    if (cursor && typeof cursor.x === 'number') {
      if (!cursor0) {
        cursor0 = { x: cursor.x, y: cursor.y };
      } else if (cursor.x !== cursor0.x || cursor.y !== cursor0.y) {
        // The cursor moved at least once since the probe started. It only
        // counts when it is also sitting on the pet: a cursor that moved
        // over the desktop proves nothing about the pet window.
        moved = true;
      }
      if (moved && cursorOverPet(cursor)) {
        deadStrikes++;
        if (deadStrikes >= strikes) {
          note({
            kind: 'input_probe_dead', reason,
            cursor: { x: cursor.x, y: cursor.y },
            afterMs: Date.now() - startedAt,
          });
          stop();
          if (typeof onDead === 'function') { try { onDead(reason); } catch (e) {} }
          return;
        }
      } else {
        deadStrikes = 0;
      }
    }
  };

  const start = (why) => {
    stop();
    reason = why || '';
    startedAt = Date.now();
    cursor0 = null;
    moved = false;
    deadStrikes = 0;
    note({ kind: 'input_probe_start', reason });
    timer = setInterval(check, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    // Give up on its own: a user who never touches the mouse must not
    // cause a restart.
    const giveUp = setTimeout(() => {
      if (timer) {
        note({ kind: 'input_probe_timeout', reason });
        stop();
      }
    }, timeoutMs);
    if (typeof giveUp.unref === 'function') giveUp.unref();
  };

  return {
    start,
    stop,
    isRunning: () => timer !== null,
  };
}

module.exports = {
  createInputProbe,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STRIKES,
  DEFAULT_TIMEOUT_MS,
};
