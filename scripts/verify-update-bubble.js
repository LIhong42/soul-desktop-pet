// scripts/verify-update-bubble.js — checks the 「有新版本」 bubble.
//
// The update bubble is the one rule in main/pet_bubbles.js whose window is
// opened by an *event* rather than by the clock: main/app_update.js pushes
// a newer release in, and that push opens a 10-minute time window.
//
// It is also the one *plug-only* rule: it does NOT own the bubble slot. It
// only feeds its line into the `default` action's speech pool (动态插拔), and
// the pet says it like one of its own lines. It used to work both ways at
// once, and the two ways disagreed — the rule path painted an amber card
// that was clickable (→ GitHub Releases), while the plug path replayed the
// same sentence as a blue action line that was not. One sentence, two
// looks, only one of them clickable. Now there is only the plug path.
//
// So the checks below are about the *line*, not about a broadcast:
//
//   1. While the window is open the line is plugged in — and it STAYS
//      plugged in. A naive "build() returns null once the user has been
//      told" latch makes it flash for a single frame, because build() and
//      onStart() run in the same tick and would fight each other.
//
//   2. When the window closes (10 minutes later) the line is taken back
//      out — and it does NOT come back on its own. The expiry IS the
//      cancellation; there is no separate "consume the notice" step.
//
//   3. The NEXT detection opens a new window and the line comes back —
//      even for the very same version, because that is a new detection.
//
//   4. The rule never wins the bubble slot, so it never broadcasts a
//      bubble of its own.
//
//   5. Turning the bubble off in the settings silences it.
//
// These run against a real database (a throwaway file in the OS temp dir,
// never the user's data) and drive the real tick(), so the checks cover the
// wiring and not just the rule's build() in isolation.
//
// Run: node scripts/verify-update-bubble.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require(path.join(__dirname, '..', 'main', 'db'));
const petBubbles = require(path.join(__dirname, '..', 'main', 'pet_bubbles'));
const petActionTexts = require(path.join(__dirname, '..', 'main', 'pet_action_texts'));

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`);
  }
}

function ok(name, cond) {
  check(name, !!cond, true);
}

const UPDATE_RULE = petBubbles.BUILTIN_RULES.find((r) => r.name === 'update');

// Everything the engine broadcasts, in order. The last entry is "what is on
// screen right now".
let broadcasts = [];
function onBroadcast(payload) {
  broadcasts.push(payload);
}
function current() {
  return broadcasts.length ? broadcasts[broadcasts.length - 1] : null;
}
function resetBroadcasts() {
  broadcasts = [];
}

// The engine asks every rule "what would you say right now?" — that is the
// question the line's presence hinges on. The broadcast is a poor probe for
// the update rule, because its text is identical for every version and the
// engine de-duplicates broadcasts on text|kind|rule. (And now the rule never
// broadcasts at all — it only plugs a line — so this is the only probe that
// says anything about whether the window is open.)
function askUpdateRule() {
  const snapshot = petBubbles._internals.buildSnapshot(
    petBubbles._internals.loadState(db), new Date(), -1);
  return UPDATE_RULE.build(snapshot);
}

// The lines currently plugged into the `default` action's pool.
function runtimeLines() {
  const list = petActionTexts.listRuntime('default');
  return (list || []).map((e) => (e && e.text) || e);
}

async function main() {
  console.log('== the update rule ==');
  ok('the update rule exists', !!UPDATE_RULE);
  ok('the update rule has its own kind', UPDATE_RULE.kind === 'update');
  // The whole point of the change: the rule is plug-only, so it never wins
  // the bubble slot. `pickRule` skipping it is what stops the amber
  // clickable card from ever being drawn.
  ok('the update rule is plug-only', UPDATE_RULE.plugOnly === true);
  ok('the update rule outranks the meal bubble',
    UPDATE_RULE.priority > petBubbles.BUILTIN_RULES.find((r) => r.name === 'meal').priority);
  ok('the update rule outranks the break bubble',
    UPDATE_RULE.priority > petBubbles.BUILTIN_RULES.find((r) => r.name === 'break').priority);

  // A throwaway database — never the user's data.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpet-update-bubble-'));
  const file = path.join(dir, 'test.sqlite');
  await db.open(file);

  // The meal and break rules are clock-driven — the meal bubble fires
  // whenever the script happens to run inside a meal window, and the break
  // bubble fires after an hour of "idle time" (the probe reports -1 here, so
  // it stays quiet, but the meal one is not under our control). Both are
  // switched off for the duration of the check so the assertions are about
  // the update bubble and nothing else.
  petBubbles.saveEnabled(db, { update: true, meal: false, break: false });

  // The engine's tick() calls db.get() and reads/writes settings, so it
  // needs the real db module — which is now open.
  //
  // The interval is set to an hour: the checks below drive tick() by hand,
  // and a background tick landing in the middle of one would make the
  // assertions depend on when the script happens to run. The engine's
  // 1.5s warm-up tick is harmless — everything after this point is
  // synchronous, so it cannot fire before the last assertion.
  petBubbles.start({ broadcast: onBroadcast, intervalMs: 60 * 60_000 });

  // -------------------------------------------------------------------------
  // 1. A detection plugs the line in, and it STAYS plugged in.
  // -------------------------------------------------------------------------
  console.log('\n== a detection plugs the line in ==');

  resetBroadcasts();
  petBubbles.setUpdateNotice('0.9.0');
  petBubbles.tick();

  // The rule must NOT broadcast a bubble of its own — that was the amber
  // card the change removed. If it ever does, the user is back to seeing
  // the same sentence in two colours.
  check('no rule bubble is broadcast', current() && current().text, null);
  check('the rule does not win the bubble slot',
    petBubbles._internals.pickRule(
      petBubbles._internals.buildSnapshot(
        petBubbles._internals.loadState(db), new Date(), -1),
      petBubbles.loadEnabled(db),
    ), null);

  // What it does instead: the line joins the idle action's pool, and the
  // pet says it like any of its own lines.
  ok('the line is in the default action pool',
    runtimeLines().includes('有新版本'));

  // The critical bit: it must NOT disappear on the next tick. This is where
  // a naive latch (build() returning null once onStart has fired) would
  // fail — the line would be live for exactly one second.
  petBubbles.tick();
  petBubbles.tick();
  check('the rule still has something to say a second later',
    (askUpdateRule() || {}).text, '有新版本');
  ok('the line is still plugged in a second later',
    runtimeLines().includes('有新版本'));

  // -------------------------------------------------------------------------
  // 2. The line is bound to the `default` action while the window is open.
  // -------------------------------------------------------------------------
  console.log('\n== the line is bound to the default action ==');

  ok('the line is in the default action pool',
    runtimeLines().includes('有新版本'));

  // -------------------------------------------------------------------------
  // 3. The window closes after 10 minutes → the line is taken back out of
  //    the `default` action's pool.
  // -------------------------------------------------------------------------
  console.log('\n== the line ends when its window closes ==');

  const win = petBubbles.getUpdateWindow();
  ok('the window is open', !!win);
  check('the window knows its version', win && win.version, '0.9.0');
  check('the window lasts 10 minutes',
    win && win.untilAt - win.openedAt, petBubbles.UPDATE_DURATION_MS);

  // Move time past the window. The window's own untilAt is the cancellation
  // mechanism, so the honest way to move time is to wait it out — but the
  // check cannot wait 10 minutes. Instead, open a window whose deadline has
  // already passed (that is exactly the state the engine is in 10 minutes
  // later) and let build() answer.
  //
  // NOTE: the engine's tick() reads the *real* clock, so the window has to
  // be expired relative to real time. Re-opening it with a deadline in the
  // past is exactly what a window looks like after 10 minutes.
  petBubbles.setUpdateNotice('0.9.0');
  const stale = petBubbles.getUpdateWindow();
  // Pretend the window was opened 11 minutes ago.
  stale.openedAt = Date.now() - petBubbles.UPDATE_DURATION_MS - 60_000;
  stale.untilAt = stale.openedAt + petBubbles.UPDATE_DURATION_MS;

  // The line is gone from the pool...
  resetBroadcasts();
  petBubbles.tick();
  check('the rule has nothing to say', askUpdateRule(), null);
  ok('the line was removed from the default action pool',
    !runtimeLines().includes('有新版本'));

  // More ticks must not bring it back — this is the "气泡展示完成之后就结束
  // 该气泡" half of the requirement.
  petBubbles.tick();
  petBubbles.tick();
  check('nothing came back on its own', askUpdateRule(), null);
  ok('the line stays out of the pool',
    !runtimeLines().includes('有新版本'));

  // -------------------------------------------------------------------------
  // 4. The NEXT detection opens a new window and the line comes back.
  // -------------------------------------------------------------------------
  console.log('\n== the next detection plugs the line in again ==');

  // The very same version. A second check that finds the same release is a
  // second detection, and it must be announced again.
  petBubbles.setUpdateNotice('0.9.0');
  resetBroadcasts();
  petBubbles.tick();
  check('the rule has something to say again',
    (askUpdateRule() || {}).text, '有新版本');
  ok('the line is plugged in again',
    runtimeLines().includes('有新版本'));

  // The window was re-opened, so its deadline moved forward from the new
  // detection — not from the old one.
  //
  // `>=` rather than `>`: the whole check can run inside a single
  // millisecond, so `Date.now()` may not have moved between the two
  // detections. The meaningful assertion is the one below — the new
  // window's deadline is a full 10 minutes from *its own* opening, not a
  // leftover from the previous detection.
  const reopened = petBubbles.getUpdateWindow();
  ok('the window was re-opened', !!reopened);
  ok('the window opened no earlier than the previous one',
    reopened.openedAt >= win.openedAt);
  check('the new window lasts 10 minutes from the new detection',
    reopened.untilAt - reopened.openedAt, petBubbles.UPDATE_DURATION_MS);

  // And it must survive a restart in between: nothing about the update
  // reminder is persisted, so a fresh engine picks the next detection up
  // just the same.
  petBubbles.stop();
  petBubbles.start({ broadcast: onBroadcast, intervalMs: 60 * 60_000 });
  petBubbles.setUpdateNotice('0.9.0');
  resetBroadcasts();
  petBubbles.tick();
  check('a detection after a restart is announced too',
    (askUpdateRule() || {}).text, '有新版本');
  ok('the line is plugged in again after a restart',
    runtimeLines().includes('有新版本'));

  // -------------------------------------------------------------------------
  // 5. A detection arriving WHILE the bubble is still up extends the window
  //    instead of being swallowed.
  // -------------------------------------------------------------------------
  console.log('\n== a detection during a live bubble extends it ==');

  const before = petBubbles.getUpdateWindow();
  petBubbles.setUpdateNotice('0.9.0');
  petBubbles.tick();
  const after = petBubbles.getUpdateWindow();

  ok('the window was re-opened', after.openedAt >= before.openedAt);
  ok('the window deadline moved forward', after.untilAt >= before.untilAt);
  check('the rule still has something to say',
    (askUpdateRule() || {}).text, '有新版本');

  // A newer version interrupts a bubble that is still on screen.
  petBubbles.setUpdateNotice('0.10.0');
  petBubbles.tick();
  check('the newer version is due',
    (askUpdateRule() || {}).text, '有新版本');
  check('the window tracks the newer version',
    petBubbles.getUpdateWindow().version, '0.10.0');

  // -------------------------------------------------------------------------
  // 6. Turning the bubble off in the settings silences it.
  // -------------------------------------------------------------------------
  console.log('\n== the toggle silences the bubble ==');

  petBubbles.saveEnabled(db, { update: false, meal: false, break: false });

  petBubbles.setUpdateNotice('2.0.0');
  resetBroadcasts();
  petBubbles.tick();
  check('a disabled update rule has nothing to say', askUpdateRule(), null);
  ok('a disabled update rule plugs nothing in',
    !runtimeLines().includes('有新版本'));

  // -------------------------------------------------------------------------
  // 7. The dev-mode reset hook closes the simulated window.
  // -------------------------------------------------------------------------
  console.log('\n== the dev reset closes the simulated window ==');

  petBubbles.saveEnabled(db, { update: true, meal: false, break: false });
  petBubbles.setUpdateNotice('0.0.0-dev');
  ok('the simulated window is open', !!petBubbles.getUpdateWindow());

  petBubbles.resetUpdateReminder();
  check('the simulated window is gone', !!petBubbles.getUpdateWindow(), false);
  check('the simulated rule is silent', askUpdateRule(), null);

  // Nothing about the update reminder is persisted — a state dump must not
  // carry an "已提醒" latch that would silence the next detection.
  const saved = petBubbles._internals.loadState(db);
  check('no "已提醒" latch is persisted', saved.updateNotifiedVersion, undefined);
  check('no showing count is persisted', saved.updateShownCount, undefined);
  check('no window is persisted', saved.updateWindow, undefined);

  // Older builds keyed the activation latch by detection ("update:3"),
  // leaving one dead entry per check in the persisted blob. Those are
  // pruned on load, so the blob can't grow without bound.
  db.setSetting('pet_bubbles_state:', JSON.stringify({
    feedWindows: {},
    lastBreakNudgeAt: 0,
    breakNudgeCount: 0,
    feedWindowsDay: '',
    startedAt: { update: 1, 'update:3': 2, 'update:4': 3, meal: 4, break: 5 },
  }));
  const pruned = petBubbles._internals.loadState(db);
  check('the per-detection latch keys are pruned',
    Object.keys(pruned.startedAt).sort(), ['break', 'meal', 'update']);

  petBubbles.stop();

  // The throwaway database goes away with the check — it never touched the
  // user's data, and leaving it in the temp dir would just be litter.
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
