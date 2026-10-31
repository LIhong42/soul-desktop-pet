// main/pet_state.js — the shape of the pet's reminder-state payload.
//
// The SAME payload is needed in two places:
//
//   * main/main.js broadcasts it on `pet:state-changed` whenever the pet's
//     state flips (a reminder fired, one was dismissed, the day rolled);
//   * main/ipc.js returns it from `pet:get_state`, which is the pet
//     window's INITIAL read — the renderer paints the badge and the
//     headline bubble from it before the first broadcast arrives.
//
// Two copies of a payload shape drift. A field added for one and forgotten
// in the other shows up as a renderer that reads `undefined` from one path
// and a real value from the other — which is exactly how `days_left` ("还有
// N 天") ended up in the broadcast but not in the initial state, so the
// pet's bubble showed the countdown only after the first state change.
//
// One builder, used by both.
function buildPetState({ petState, queue }) {
  // The active (non-dismissed) subset drives both the count and the head.
  // Dismissed items stay in the queue so the 今日 page can still show them,
  // but they must not nag.
  const head = queue.activeHead();
  return {
    state: petState ? 'REMINDER' : 'NORMAL',
    count: queue.activeCount(),
    // `head` carries enough of the current nag for the pet window to
    // render a meaningful speech bubble without another round-trip.
    //
    // `source` / `source_id` identify WHICH reminder this is — the pet
    // window needs them to acknowledge the nag it is showing ("关闭提醒"),
    // and the pet's right-click menu uses the same pair to complete it.
    // Without them the pet could only hide its own bubble, which left the
    // badge counting and the sprite shaking: a reminder with no way to be
    // turned off.
    //
    // `days_left` is present only for date-anchored reminders that are
    // counting down to a future day (a birthday with the advance window
    // open). null for everything else.
    head: head ? {
      title: head.title,
      source: head.source,
      source_id: head.source_id,
      contact_name: head.contact_name || null,
      description: head.description || null,
      days_left: head.days_left != null ? head.days_left : null,
    } : null,
  };
}

module.exports = { buildPetState };
