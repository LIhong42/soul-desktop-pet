// main/pet_bubbles.js — the text-bubble framework.
//
// ---------------------------------------------------------------------------
// What this is
// ---------------------------------------------------------------------------
// A small rule engine that decides, once a second, *which text bubble (if any)
// should currently be floating above the pet*, and broadcasts it to the pet
// window on a single IPC channel (`pet:bubble-changed`).
//
// It is deliberately **decoupled from pet actions**. The pet's animation
// state machine lives in main/pet_controller.js and its rule set in
// main/auto_behaviors.js; neither knows this file exists. This module only
// ever produces `{ text, kind }` payloads — it never touches `action`,
// `variant`, the frame animator, or the reminder queue. A bubble can appear
// while the pet is walking, sleeping, shaking a reminder, or sitting still,
// and it changes none of that. Conversely, adding a bubble rule can never
// make the pet stutter, because nothing on the animation path is touched.
//
// ---------------------------------------------------------------------------
// Adding a rule
// ---------------------------------------------------------------------------
// Append one entry to BUILTIN_RULES. Everything else — persistence, gating,
// priority, rendering, settings UI — is derived from that entry. There is no
// second registry to update and no switch statement to extend.
//
//   {
//     name: 'unique_id',                 // stable id; also the settings key
//     label: '吃饭提醒',                   // shown in /settings
//     kind: KINDS.MEAL,                  // CSS hook on the bubble element
//     enabled: true,                     // default on/off
//     priority: 30,                      // higher wins when several are due
//     describe() { return '…'; },        // optional one-line settings blurb
//
//     // Pure: read the snapshot, return the bubble intent (or null).
//     build(state) {
//       return { text: '今天吃撒', durationMs: 60*60_000 };
//     },
//
//     // Optional event reaction (see the `watch` list). Called with the same
//     // snapshot shape as build(), plus the event payload.
//     watch: ['fed'],
//     onEvent(name, state, payload) {},
//
//     // Optional one-shot side effect, fired exactly once per activation,
//     // before the bubble is first broadcast. May be async.
//     async onStart(state) {},
//   }
//
// `build(state)` must stay a pure function of the snapshot it is handed —
// side effects belong in `onStart` / `onEvent`, which the framework
// schedules and error-contains for you.
//
// ---------------------------------------------------------------------------
// Why a snapshot instead of reading globals
// ---------------------------------------------------------------------------
// Rules, the event bus, persistence, and the IPC push all run inside one
// synchronous tick. `build()` receives a snapshot of that tick's world
// (clock, fed-window latches, OS idle time) so a rule can
// never observe a half-updated state, and so a rule is testable by handing it
// a literal object.

const db = require('./db');
const petBubbleTypes = require('./pet_bubble_types');

const KINDS = petBubbleTypes.KINDS;

// The one IPC channel the pet window listens on. Both "bubble appeared" and
// "bubble gone" ride the same channel: `text: null` means clear. One channel
// keeps the renderer dumb (it paints what it's told) and means a new rule
// never adds a new cross-process contract.
const BROADCAST_CHANNEL = 'pet:bubble-changed';

// Per-rule persistence key. Deliberately NOT keyed on pet id: bubbles are a
// property of the user and their clock, not of whichever pet happens to be
// loaded, so switching pets doesn't silently reset "今天已喂食".
const STATE_KEY_PREFIX = 'pet_bubbles_state:';
// Per-user toggle key (which kinds are on). Also pet-independent.
const OPTS_KEY = 'pet_bubbles_enabled';

// All three shipped rules run for one hour, per spec. A rule may override
// per-intent via `build()`'s returned `durationMs`.
const DEFAULT_DURATION_MS = 60 * 60_000;
const REFRESH_MS = 1000;   // tick cadence

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

const BUILTIN_RULES = [

  // ---------------------------------------------------------------------
  // 吃饭提醒 — "今天吃撒"
  //
  // Fires when the clock enters a meal window and stays for one hour; ends
  // early the moment the user feeds the pet (right-click menu 喂食, or a
  // click action configured to route through the cozy feed). Windows are
  // wall-clock ranges with minute precision, so someone who eats at 12:20
  // isn't nagged all afternoon.
  //
  // Priority is high because a meal window is time-boxed: if it loses to a
  // longer-running rule it may get no second chance today.
  // ---------------------------------------------------------------------
  {
    name: 'meal',
    label: '吃饭提醒',
    kind: KINDS.MEAL,
    enabled: true,
    priority: 30,
    // Same line for every window, per spec. The window label is prepended so
    // the user can tell which window is nagging them without the text
    // growing into a sentence: "午饭：今天吃撒".
    text: '今天吃撒',
    windows: [
      { id: 'breakfast', label: '早饭', from: '06:30', to: '09:30' },
      { id: 'lunch',     label: '午饭', from: '11:00', to: '14:00' },
      { id: 'dinner',    label: '晚饭', from: '17:00', to: '20:30' },
    ],
    watch: ['fed'],
    describe() {
      return this.windows.map((w) => `${w.label} ${w.from}-${w.to}`).join(' · ')
        + '（喂食后自动结束）';
    },
    build(state) {
      const win = state.activeMealWindow;
      if (!win.id) return null;
      // Already fed during this window → the bubble is done, whether it was
      // up for an hour or thirty seconds.
      if (state.feedWindows[win.id]) return null;
      return {
        text: petBubbleTypes.textAtLeastOneOf([win.label, this.text], 2, '：') || this.text,
        durationMs: DEFAULT_DURATION_MS,
      };
    },
    onEvent(name, state) {
      if (name !== 'fed') return;
      // Early end: pin the current window as handled. The bubble disappears
      // on the next tick (~1s) rather than waiting out the full hour.
      state.feedWindows[state.activeMealWindow.id] = true;
      state.dirty = true;
    },
  },

  // ---------------------------------------------------------------------
  // 休息提醒
  //
  // Fires after a continuous stretch of computer use longer than an hour,
  // then at most once every 3 hours while the user stays glued to the
  // keyboard. "High-frequency use" is measured by OS-level idle time
  // (powerMonitor.getSystemIdleTime, wired up in ipc.js) rather than by
  // window focus: the pet window is deliberately unfocusable, so window
  // focus isn't a usable signal here.
  // ---------------------------------------------------------------------
  {
    name: 'break',
    label: '休息提醒',
    kind: KINDS.BREAK,
    enabled: true,
    // Below meal: a stretch reminder is the least time-critical and it
    // recurs, so yielding to a time-boxed meal window is safe.
    priority: 5,
    minContinuousUseMs: 60 * 60_000,
    cooldownMs: 3 * 60 * 60_000,
    texts: [
      '坐太久了，起来走两步吧',
      '该活动一下啦，伸个懒腰～',
      '眼睛也该歇歇，看看远处吧',
    ],
    describe() {
      const mins = Math.round(this.minContinuousUseMs / 60_000);
      return `连续使用电脑超过 ${mins} 分钟提醒休息，之后每 ${Math.round(this.cooldownMs / 3600_000)} 小时一次`;
    },
    build(state) {
      if (state.idleSeconds < 0) return null;             // platform unknown
      if (state.idleSeconds * 1000 < this.minContinuousUseMs) return null;
      if (Date.now() - state.lastBreakNudgeAt < this.cooldownMs) return null;
      // Rotate through the lines so a long session doesn't repeat itself
      // verbatim every 3 hours. The index derives from the nudge count,
      // which is persisted, so it survives restarts instead of reshuffling.
      const i = state.breakNudgeCount % this.texts.length;
      return { text: this.texts[i], durationMs: DEFAULT_DURATION_MS };
    },
    onStart(state) {
      // Stamp the cooldown from onStart (before the first broadcast) so the
      // very next tick already sees it and can't fire a second bubble.
      state.lastBreakNudgeAt = Date.now();
      state.breakNudgeCount = (state.breakNudgeCount | 0) + 1;
      state.dirty = true;
    },
  },
];

// Stable "due" ordering: priority descending, declaration order as the
// tie-break, so the result never depends on sort stability.
const ORDERED_RULES = BUILTIN_RULES
  .map((r, i) => ({ r, i }))
  .sort((a, b) => (b.r.priority - a.r.priority) || (a.i - b.i))
  .map((x) => x.r);

// ---------------------------------------------------------------------------
// Settings-backed per-user config (enable toggles)
// ---------------------------------------------------------------------------

// A kind is on unless it was explicitly turned off, so a kind added in a
// later release defaults to enabled with no migration.
function loadEnabled(dbRef) {
  let stored = {};
  const raw = dbRef.getSetting(OPTS_KEY);
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') stored = o;
    } catch { stored = {}; }
  }
  const out = {};
  for (const rule of BUILTIN_RULES) {
    const v = stored[rule.kind];
    out[rule.kind] = (v === false) ? false : (v === true ? true : rule.enabled !== false);
  }
  return out;
}

function saveEnabled(dbRef, map) {
  const clean = {};
  for (const rule of BUILTIN_RULES) {
    clean[rule.kind] = !(map && map[rule.kind] === false);
  }
  dbRef.setSetting(OPTS_KEY, JSON.stringify(clean));
  return clean;
}

// ---------------------------------------------------------------------------
// Rule state (one JSON blob, so a new rule needs no new key or migration)
// ---------------------------------------------------------------------------
//
// The persisted shape has five fields, all of them readable in loadState /
// writable in saveState below — deliberately not duplicated into a separate
// default object, so adding a field can't leave a stale copy behind:
//
//   feedWindows      meal window id → true, for windows already handled today
//   lastBreakNudgeAt epoch ms of the last 休息提醒 nudge; persisted so the
//                    3-hour cooldown survives a restart mid-session
//   breakNudgeCount  how many nudges so far (drives the line rotation)
//   feedWindowsDay   which day `feedWindows` refers to; rolled at midnight so
//                    a stale "早饭已处理" doesn't suppress today's nag
//   startedAt        rule name → epoch ms it was last activated, so `onStart`
//                    fires once per bubble rather than once per tick

function loadState(dbRef) {
  const raw = dbRef.getSetting(STATE_KEY_PREFIX);
  let parsed = {};
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') parsed = o;
    } catch { parsed = {}; }
  }
  return {
    feedWindows: (parsed.feedWindows && typeof parsed.feedWindows === 'object') ? parsed.feedWindows : {},
    lastBreakNudgeAt: Number(parsed.lastBreakNudgeAt) || 0,
    breakNudgeCount: parsed.breakNudgeCount | 0,
    feedWindowsDay: parsed.feedWindowsDay || '',
    startedAt: (parsed.startedAt && typeof parsed.startedAt === 'object') ? parsed.startedAt : {},
  };
}

function saveState(dbRef, state) {
  dbRef.setSetting(STATE_KEY_PREFIX, JSON.stringify({
    feedWindows: state.feedWindows,
    lastBreakNudgeAt: state.lastBreakNudgeAt,
    breakNudgeCount: state.breakNudgeCount,
    feedWindowsDay: state.feedWindowsDay,
    startedAt: state.startedAt,
  }));
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function dayKeyOf(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "HH:MM" → minutes since local midnight. Returns null on malformed input so
// a bad rule config degrades to "never fires" rather than throwing every tick.
function parseHhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
  return h * 60 + min;
}

// Which meal window contains `now`, or null. `null` means "no meal window
// right now" — distinct from "a window is active but already fed", which the
// rule expresses via its own `feedWindows` latch.
function currentMealWindow(rule, now) {
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  for (const w of rule.windows) {
    const from = parseHhmmToMinutes(w.from);
    const to = parseHhmmToMinutes(w.to);
    if (from == null || to == null) continue;
    // Windows that wrap past midnight (e.g. 22:00 → 02:00) are supported by
    // testing both halves. None of the shipped windows need it, but a
    // user-authored rule might.
    const inRange = (from <= to)
      ? (minuteOfDay >= from && minuteOfDay < to)
      : (minuteOfDay >= from || minuteOfDay < to);
    if (inRange) return w;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runtime inputs the rules read but this module doesn't own
// ---------------------------------------------------------------------------
//
// OS idle seconds arrive from the host process (powerMonitor in ipc.js) so
// this module stays free of an Electron dependency and remains testable under
// plain node. -1 means "the platform didn't tell us", which every idle-based
// rule must treat as "don't nag".
let runtimeIdleSeconds = -1;
function setIdleSeconds(v) {
  runtimeIdleSeconds = (typeof v === 'number' && Number.isFinite(v)) ? v : -1;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

// Build the per-tick view of the world. `feedWindows` is shared by reference
// with `state` on purpose — that's how `onEvent`'s "pin this window as
// handled" write lands in the object the caller will persist. Everything else
// is copied.
function buildSnapshot(state, now, idleSeconds) {
  const today = dayKeyOf(now);

  // Roll the "handled meal windows" map over at midnight.
  if (state.feedWindowsDay !== today) {
    state.feedWindows = {};
    state.feedWindowsDay = today;
    state.dirty = true;
  }

  const mealRule = BUILTIN_RULES.find((r) => r.name === 'meal');
  const activeMealWindow = (mealRule && currentMealWindow(mealRule, now)) || { id: '', label: '' };

  return {
    now,
    nowMs: now.getTime(),
    dayKey: today,
    minuteOfDay: now.getHours() * 60 + now.getMinutes(),
    feedWindows: state.feedWindows,
    activeMealWindow,
    idleSeconds: (typeof idleSeconds === 'number' && Number.isFinite(idleSeconds)) ? idleSeconds : -1,
    lastBreakNudgeAt: state.lastBreakNudgeAt,
    breakNudgeCount: state.breakNudgeCount | 0,
    // The framework's own mutation signal — set by rules to request a save.
    dirty: false,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// The highest-priority rule that wants a bubble right now, or null.
function pickRule(snapshot, enabledMap) {
  for (const rule of ORDERED_RULES) {
    if (enabledMap[rule.kind] === false) continue;
    let intent;
    try {
      intent = rule.build(snapshot);
    } catch (e) {
      console.error(`[pet_bubbles] rule "${rule.name}" build failed:`, e && e.message ? e.message : e);
      continue;
    }
    if (intent && typeof intent.text === 'string' && intent.text.trim()) {
      return { rule, intent };
    }
  }
  return null;
}

// Run a rule's activation hook at most once per bubble. The latch is stored
// on the persisted state so a restart doesn't re-nudge the break rule
// mid-bubble.
function maybeRunOnStart(rule, state, snapshot, durationMs, nowMs) {
  const last = Number(state.startedAt[rule.name]) || 0;
  if (nowMs - last < durationMs) return;
  state.startedAt[rule.name] = nowMs;
  state.dirty = true;
  if (typeof rule.onStart !== 'function') return;
  try {
    // Fire-and-forget by design: a slow or failing network fetch must not
    // stall the 1s tick.
    Promise.resolve(rule.onStart(snapshot)).catch((e) => {
      console.error(`[pet_bubbles] rule "${rule.name}" onStart failed:`, e && e.message ? e.message : e);
    });
  } catch (e) {
    console.error(`[pet_bubbles] rule "${rule.name}" onStart threw:`, e && e.message ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

let timer = null;
let warmupTimer = null;
let intervalMs = REFRESH_MS;
let broadcastFn = null;
let lastBroadcastKey = null;   // dedupe: don't re-push an unchanged bubble

// A user-typed bubble takes over the single bubble slot until it expires.
// It has to, or the very next tick (≤1s later) would overwrite what the user
// just typed with whatever rule happened to be due — the message would flash
// and vanish, which reads as a bug. Expiry keeps the slot from being held
// forever, after which the normal rule-driven bubble resumes as if nothing
// happened.
//
// Not persisted: it's a transient UI override with a 10-minute life, and
// writing it to `settings` would mean a restart re-showing a message the
// user typed a while ago.
let manual = null;   // { text, kind, rule, durationMs, expiresAtMs }

// How long a typed bubble stays up. Long enough to read a sentence (the
// bubble is `nowrap` and capped at 280px in CSS, so long text wraps to a few
// lines), short enough that a forgotten message isn't still on screen at
// lunchtime.
const MANUAL_DURATION_MS = 10 * 60_000;

function push(payload) {
  lastBroadcastKey = payload.text == null ? '' : `${payload.kind}|${payload.rule}|${payload.text}`;
  if (!broadcastFn) return;
  try { broadcastFn(payload); }
  catch (e) { console.error('[pet_bubbles] broadcast failed:', e && e.message ? e.message : e); }
}

// Show `text` in the bubble slot, overriding the rule engine until it
// expires. Called from the right-click menu's "说句话" item.
//
// Deliberately bypasses `tick()`: the user asked for this bubble, so it goes
// out immediately rather than waiting up to a second, and it does not
// consult the enable toggles (turning 吃饭提醒 off shouldn't stop the user
// from typing at their pet).
function say(text, opts) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  const o = opts || {};
  manual = {
    text: t,
    kind: o.kind || 'manual',
    rule: o.rule || 'manual',
    durationMs: Number.isFinite(o.durationMs) ? o.durationMs : MANUAL_DURATION_MS,
    expiresAtMs: Date.now() + (Number.isFinite(o.durationMs) ? o.durationMs : MANUAL_DURATION_MS),
  };
  push({ text: manual.text, kind: manual.kind, rule: manual.rule, durationMs: manual.durationMs });
  return true;
}

// Dismiss the typed bubble early (context menu → 收起气泡, or any future
// dismiss affordance). Falls through to the rule-driven bubble on the next
// tick rather than blanking the slot, so dismissing a manual bubble doesn't
// also swallow a 吃饭提醒 that is currently due.
function clearManual() {
  if (!manual) return false;
  manual = null;
  // Force the next tick to re-broadcast: lastBroadcastKey still holds the
  // manual text, and if a rule happened to be showing that identical string
  // we'd wrongly skip the push.
  lastBroadcastKey = null;
  return true;
}

function tick() {
  if (!db.get()) return;

  // A live manual bubble wins over the rule engine for as long as it lasts.
  if (manual) {
    if (Date.now() < manual.expiresAtMs) {
      push({
        text: manual.text,
        kind: manual.kind,
        rule: manual.rule,
        durationMs: manual.durationMs,
      });
      return;
    }
    manual = null;
    lastBroadcastKey = null;   // let the rule result repaint
  }

  let state;
  let enabledMap;
  try {
    state = loadState(db);
    enabledMap = loadEnabled(db);
  } catch (e) {
    console.error('[pet_bubbles] state load failed:', e && e.message ? e.message : e);
    return;
  }

  const now = new Date();
  const snapshot = buildSnapshot(state, now, runtimeIdleSeconds);
  const picked = pickRule(snapshot, enabledMap);

  let payload = { text: null, kind: null, rule: null };
  if (picked) {
    const { rule, intent } = picked;
    const durationMs = Number.isFinite(intent.durationMs) ? intent.durationMs : DEFAULT_DURATION_MS;
    maybeRunOnStart(rule, state, snapshot, durationMs, now.getTime());
    payload = { text: intent.text, kind: rule.kind, rule: rule.name };
  }

  if (snapshot.dirty || state.dirty) saveState(db, state);

  // Broadcast only on a real change. A bubble sitting on screen for an hour
  // produces ~3600 identical ticks; pushing them all would restart the
  // renderer's fade timer every second.
  const key = payload.text == null ? '' : `${payload.kind}|${payload.rule}|${payload.text}`;
  if (key !== lastBroadcastKey) push(payload);
}

// Deliver a `watch` event to every rule that asked for it. Called from the
// cozy feed IPC handler so the meal rule can end early; later event kinds
// slot in here without changing call sites.
function emit(eventName, payload) {
  if (!db.get()) return;
  for (const rule of BUILTIN_RULES) {
    if (!Array.isArray(rule.watch) || !rule.watch.includes(eventName)) continue;
    if (typeof rule.onEvent !== 'function') continue;
    let state, snapshot;
    try {
      state = loadState(db);
      snapshot = buildSnapshot(state, new Date(), runtimeIdleSeconds);
      rule.onEvent(eventName, snapshot, payload);
    } catch (e) {
      console.error(`[pet_bubbles] rule "${rule.name}" onEvent failed:`, e && e.message ? e.message : e);
      continue;
    }
    if (snapshot.dirty || state.dirty) saveState(db, state);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function start({ broadcast, intervalMs: ms } = {}) {
  if (timer) return;
  broadcastFn = broadcast || null;
  intervalMs = (Number.isFinite(ms) && ms > 0) ? ms : REFRESH_MS;
  // Fire once shortly after start so a bubble that should already be up
  // (the app was launched at 12:30, mid-lunch-window) appears immediately
  // rather than after a full interval of nothing. Tracked so stop() can
  // cancel it — a warm-up tick that outlives stop() would fire a broadcast
  // into a torn-down window.
  warmupTimer = setTimeout(tick, 1500);
  timer = setInterval(tick, intervalMs);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null; }
  lastBroadcastKey = null;
  manual = null;
}

// ---------------------------------------------------------------------------
// Introspection for /settings and debug tooling
// ---------------------------------------------------------------------------

function describeRules(dbRef) {
  const enabled = loadEnabled(dbRef);
  const state = loadState(dbRef);
  return {
    rules: BUILTIN_RULES.map((r) => ({
      name: r.name,
      label: r.label,
      kind: r.kind,
      priority: r.priority,
      enabled: enabled[r.kind] !== false,
      description: (typeof r.describe === 'function') ? r.describe() : '',
    })),
    // Surfaced so the settings page can show "今日已喂食" without waiting
    // for the bubble to appear.
    feedWindows: state.feedWindows,
  };
}

module.exports = {
  BROADCAST_CHANNEL,
  DEFAULT_DURATION_MS,
  REFRESH_MS,
  BUILTIN_RULES,
  KINDS,

  // lifecycle
  start,
  stop,
  tick,
  setIdleSeconds,
  emit,
  say,
  clearManual,

  // config / introspection
  loadEnabled,
  saveEnabled,
  describeRules,

  // internals, exported for tests
  _internals: {
    loadState,
    saveState,
    buildSnapshot,
    pickRule,
    parseHhmmToMinutes,
    currentMealWindow,
    dayKeyOf,
    maybeRunOnStart,
    ORDERED_RULES,
  },
};