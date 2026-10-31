// main/pet_resume.js — system suspend/resume recovery for the pet window.
//
// Why this exists
// ---------------
// The pet drag is a two-party protocol:
//
//   * the RENDERER owns the gesture  (when a drag starts and ends)
//   * the MAIN PROCESS owns the position (it polls the cursor and writes the
//     window position)
//
// The renderer releases the main process's side by sending `pet:drag_end`.
// That message is the ONLY thing that stops the 16 ms cursor poller and
// releases the controller's drag mutex (`petController._dragging`).
//
// A system suspend breaks that guarantee:
//
//   * The `pointerup` that ends the gesture may never be delivered — the
//     pointer can be anywhere, the window may not be under it, and Chromium
//     does not reliably cancel the pointer capture across a sleep.
//   * The renderer's own rescue paths (`blur`, `visibilitychange`) can fire
//     BEFORE the OS restores the session, and their `endDrag()` early-returns
//     when `pressing` is already false — so `pet:drag_end` may never be sent.
//
// When that happens the main process keeps polling the cursor forever: the
// pet is glued to the pointer, and because `petController._dragging` stays
// true, `PetController.tick()` returns early forever and the pet's
// autonomous movement is dead for the rest of the session.
//
// Upstream Electron issues (all closed as stale/not_planned, so there is no
// upstream fix to wait for):
//
//   * electron/electron#37361 — a frameless + transparent window comes back
//     black/frozen after resume; the documented recovery is `win.show()`.
//   * electron/electron#32084 — all web content turns transparent after a
//     wakeup.
//   * electron/electron#43020 — a sleeping/blocked main process makes the
//     renderer stop receiving mouse events entirely.
//
// So the recovery has to be ours: on resume we unconditionally tear down any
// drag the main process still believes in, re-assert the window's
// visibility/mouse state, and tell the renderer to forget its gesture.
//
// IMPORTANT — this module is a FALLBACK, not the primary fix.
//
// The primary bug ("the pet can no longer be dragged at all after a sleep")
// was NOT caused by the drag state being stale. It was caused by the
// renderer wedging itself: a suspend tears down and re-creates the pointer
// device, so on wake the mouse reports a NEW `pointerId` while the gesture
// still named the old, dead one — and the renderer's "ignore foreign
// pointer events" guard then rejected every event from the new mouse
// forever. That is fixed in the renderer itself (src/js/pet.js), which
// heals itself from the pointer events it actually receives.
//
// This module only handles the main process's side, and it is not enough on
// its own for two reasons:
//
//   * `powerMonitor`'s `resume` is NOT reliably delivered. On Windows 11
//     Modern Standby the OS freezes the whole process while the machine is
//     asleep, so the wake notification is often never dispatched at all
//     (electron/electron#47739). A plain lid-close with no lock screen may
//     not produce an `unlock-screen` either.
//   * Even when the event does arrive, the renderer may still be frozen and
//     may not process the `pet:resume` message promptly.
//
// The main process therefore ALSO runs a clock-jump watchdog (see the
// `WATCHDOG_*` constants in main/ipc.js) that detects the freeze from the
// wall clock, with no dependency on any OS event.
//
// This module deliberately has NO Electron import of its own beyond
// `powerMonitor`, and it takes its collaborators as arguments, so it can be
// unit-tested under a stubbed `electron` module (see
// scripts/test-pet-resume.js).

'use strict';

const { powerMonitor } = require('electron');

// How long to wait before acting on a second `resume`.
//
// Electron 32 emits `resume` TWICE on Windows: once from Electron's own
// `WM_POWERBROADCAST` handler and once from Chromium's
// `base::PowerSuspendObserver` (electron/electron#44252, labelled 32-x-y).
// The duplicate was only removed in Electron 35+ by PR #47162, so on the
// Electron version this project ships we have to de-duplicate ourselves.
//
// The window is generous on purpose: the recovery is idempotent, so a
// spurious second run is harmless — but we do not want the recovery to run
// twice for one real sleep, because it briefly re-shows the window.
const RESUME_DEBOUNCE_MS = 2000;

// Install the resume/suspend listeners.
//
// `onResume` is called when the system comes back. It is expected to do the
// actual recovery work.
//
// Returns a `dispose()` function that removes the listeners — used by the
// app's shutdown path so the handlers don't outlive the windows.
function install({ onResume, onSuspend } = {}) {
  if (!powerMonitor || typeof powerMonitor.on !== 'function') {
    return { dispose() {} };
  }

  // Timestamp of the last handled resume. Used to swallow the duplicate
  // `resume` event that Electron 32 emits.
  let lastResumeAt = 0;

  const handleResume = () => {
    const now = Date.now();
    if (now - lastResumeAt < RESUME_DEBOUNCE_MS) {
      // Duplicate event (electron/electron#44252). Ignore it.
      return;
    }
    lastResumeAt = now;
    if (typeof onResume === 'function') {
      try { onResume(); } catch (e) { console.error('[pet_resume] resume handler failed:', e); }
    }
  };

  const handleSuspend = () => {
    if (typeof onSuspend === 'function') {
      try { onSuspend(); } catch (e) { console.error('[pet_resume] suspend handler failed:', e); }
    }
  };

  // `resume` and `unlock-screen` are the reliable hooks; `suspend` is NOT.
  //
  // On Windows 11 24H2 laptops the whole app is frozen by the OS during
  // Modern Standby, so a `suspend` handler runs too late (or not at all) —
  // see electron/electron#47739. We listen to it anyway, but only to do
  // bookkeeping; the real recovery happens on `resume` / `unlock-screen`.
  powerMonitor.on('resume', handleResume);
  powerMonitor.on('unlock-screen', handleResume);
  powerMonitor.on('suspend', handleSuspend);

  return {
    dispose() {
      try {
        powerMonitor.removeListener('resume', handleResume);
        powerMonitor.removeListener('unlock-screen', handleResume);
        powerMonitor.removeListener('suspend', handleSuspend);
      } catch (e) { /* the module may already be torn down */ }
    },
  };
}

module.exports = { install, RESUME_DEBOUNCE_MS };
