// src/js/gesture_guard.js — a shared guard for pointer gestures that must
// survive a system suspend.
//
// The problem
// -----------
// A pointer gesture is a latch: it is set on `pointerdown` and cleared on
// `pointerup`. If the `pointerup` never arrives, the latch stays set
// forever and the feature is wedged.
//
// The `pointerup` goes missing in several ways:
//
//   * **A system suspend.** The machine sleeps, the OS tears down and
//     re-creates the pointer device, and on wake the mouse reports a NEW
//     `pointerId`. The browser never delivers a `pointerup` for the old
//     device — the gesture simply never ends. The pet window had exactly
//     this bug: after a sleep it could not be dragged again for the rest of
//     the session.
//
//   * **A release outside the window.** The gesture's `pointerup` listener
//     is on `window`. Releasing the button outside the application window
//     delivers no `pointerup` either.
//
//   * **A platform gesture takeover.** The OS may cancel the pointer
//     (a touch being hijacked, a pen leaving range) — that arrives as
//     `pointercancel`, which is easy to forget.
//
// The fix
// -------
// A gesture that records the `pointerId` it started with can recognise
// that it is dead as soon as an event arrives from a DIFFERENT pointer.
// That event is proof: the pointer that owned the gesture no longer
// exists. The gesture is then torn down, which frees the state and lets
// the next interaction start cleanly.
//
// `pointercancel` is handled too, for the platform-cancel case.
//
// This is deliberately event-driven rather than lifecycle-driven. Listening
// for the OS's power events is not dependable — Windows 11's Modern
// Standby freezes the whole process while the machine is asleep, so the
// wake notification is often never delivered at all
// (electron/electron#47739). Recovering from the events the page actually
// receives works regardless.
//
// Usage
// -----
//   const guard = createGestureGuard({
//     // Called when the gesture is torn down. Must clear the latch,
//     // remove any CSS classes, and remove the listeners.
//     onCancel: () => { state.drag = null; cleanupDrag(); },
//     // Optional: called on a normal end. Defaults to onCancel.
//     onEnd: () => { ... },
//   });
//
//   // On pointerdown:
//   guard.begin(e.pointerId);
//
//   // On pointermove:
//   guard.move(e);   // returns false if this event belongs to a dead gesture
//
//   // On pointerup / pointercancel:
//   guard.end(e);    // returns true if this event ended the gesture

// createGestureGuard(options) → guard
//
// options:
//   onEnd(e)    — called when the gesture ends normally (a `pointerup` for
//                 the gesture's own pointer). Receives the event.
//   onCancel(e) — called when the gesture is torn down without a normal
//                 end: a `pointercancel`, or a foreign pointer id.
//                 Defaults to `onEnd`.
//
// The returned guard exposes:
//   begin(pointerId)  — start a gesture for this pointer id.
//   isActive()         — is a gesture in flight?
//   move(e)            — handle a `pointermove`; returns false when the
//                        event belongs to a different (dead) gesture, in
//                        which case the gesture has already been cancelled.
//   end(e)             — handle a `pointerup`; returns true if this event
//                        ended the gesture.
//   cancel(e)          — handle a `pointercancel`; always cancels.
//   cancelIfStale(e)   — cancel if `e` belongs to a foreign pointer.
//
// `begin()` cancels any gesture already in flight, so a second
// `pointerdown` (e.g. the user starts a new drag) never leaves the old
// gesture's state behind.
export function createGestureGuard({ onEnd, onCancel } = {}) {
  const finish = typeof onEnd === 'function' ? onEnd : () => {};
  const abort = typeof onCancel === 'function' ? onCancel : finish;

  // The pointer id that owns the current gesture, or null when no gesture
  // is in flight.
  let pointerId = null;

  const clear = () => { pointerId = null; };

  return {
    begin(id) {
      // A new gesture supersedes any gesture in flight. Cancel it first so
      // its listeners and CSS classes are cleaned up.
      if (pointerId !== null) {
        const old = pointerId;
        clear();
        try { abort({ pointerId: old }); } catch (e) { console.error('[gesture_guard] cancel failed:', e); }
      }
      pointerId = (id === undefined || id === null) ? null : id;
    },

    isActive() { return pointerId !== null; },

    // Returns true when the event belongs to the live gesture, false when
    // the gesture was dead and has just been cancelled.
    move(e) {
      if (pointerId === null) return false;
      if (e && pointerId !== null && e.pointerId !== pointerId) {
        // An event from a different pointer: the one that owned this
        // gesture is gone. This is the post-suspend case.
        const old = pointerId;
        clear();
        try { abort(e); } catch (err) { console.error('[gesture_guard] cancel failed:', err); }
        return false;
      }
      return true;
    },

    // Returns true when this event ended the live gesture.
    end(e) {
      if (pointerId === null) return false;
      if (e && pointerId !== null && e.pointerId !== pointerId) {
        // A `pointerup` from a foreign pointer. The gesture we are holding
        // is dead — end it rather than ignoring the event.
        const old = pointerId;
        clear();
        try { abort(e); } catch (err) { console.error('[gesture_guard] cancel failed:', err); }
        return false;
      }
      clear();
      try { finish(e); } catch (err) { console.error('[gesture_guard] end failed:', err); }
      return true;
    },

    // A `pointercancel` from the platform. Cancels the gesture whatever the
    // pointer id is — the platform is telling us the gesture is over.
    cancel(e) {
      if (pointerId === null) return false;
      clear();
      try { abort(e); } catch (err) { console.error('[gesture_guard] cancel failed:', err); }
      return true;
    },
  };
}
