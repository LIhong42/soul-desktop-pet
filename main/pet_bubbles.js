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
// never observe a half-updated state, and so a rule can be handed a literal
// object.

const db = require('./db');
const petBubbleTypes = require('./pet_bubble_types');
const petActionTexts = require('./pet_action_texts');
const petTextBoxes = require('./pet_text_boxes');

const KINDS = petBubbleTypes.KINDS;

// Which action a rule's line gets plugged into. `default` is the pet's idle
// animation, so while a 吃饭提醒 / 休息提醒 bubble is up the pet can also say
// the line from its normal idle action — the "动态插拔" behaviour the user
// asked for. See main/pet_action_texts.js for why this is a runtime pool
// rather than a copy into the saved config.
const RUNTIME_TARGET_ACTION = 'default';

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

// The two nagging reminders (吃饭 / 休息) run for one hour, per spec. A rule
// may override per-intent via `build()`'s returned `durationMs` — the
// 有新版本 rule does exactly that, with a shorter window of its own.
const DEFAULT_DURATION_MS = 60 * 60_000;
// 有新版本 is a notification rather than a nagging reminder, so it gets a
// shorter window — long enough to read and act on, short enough that it
// doesn't squat on the bubble slot and starve 吃饭提醒.
//
// 「有新版本」气泡挂多久。
//
// 机制和吃饭/休息提醒完全一致：都靠「时间窗」来取消，不是靠「消费一条
// 通知」。一次检测到新版本 = 开一个 10 分钟的窗口；窗口没到之前 build()
// 一直返回那句话，窗口一过 build() 就返回 null，气泡自然消失、也自动从
// default 动作的候选池里摘掉（见 syncRuntime）。
//
// 需求：「请把检测更新气泡也改为时间取消，在检测后如果有版本更新，则将气泡
// 绑定到default动作，10分钟后取消绑定」。
const UPDATE_DURATION_MS = 10 * 60_000;
// 「有新版本」气泡的文案。
//
// 只有这四个字：版本号和「去 GitHub 下载吧」都去掉了。气泡本身很小，
// 塞一整句会撑破布局；而版本号在设置页的更新卡片里本来就写着，桌宠这
// 边再说一遍是冗余。
//
// 这条规则是 plug-only 的（见 UPDATE_RULE 的注释）：这句话只会作为
// default 动作的一句台词被插进去，不会画成一条独立的气泡。所以它不可
// 点——下载请到设置页的更新卡片里点。
const UPDATE_TEXT = '有新版本';

const REFRESH_MS = 1000;   // tick cadence

// ---------------------------------------------------------------------------
// 文本框 for rule bubbles
// ---------------------------------------------------------------------------
//
// A rule bubble has no action of its own — 吃饭提醒 belongs to no variant, and
// the same line also gets mirrored into `default`'s pool (see RUNTIME_TARGET_ACTION
// below). So it can't read a per-action choice, and it takes a separate
// user-level one instead.
//
// It is stored pet-independently, alongside the enable toggles, for the same
// reason those are: the reminder is about the user and their clock, not about
// whichever pet is loaded, so switching pets must not silently restyle their
// reminders.
//
// Deliberately resolved (not stored as a URL): an id that no longer resolves —
// PNG deleted, config imported from another machine — degrades to the CSS
// bubble via petTextBoxes.resolve returning null. Same rule as everywhere
// else: a stale reference costs a fallback, never a broken bubble.
const BOX_KEY = 'pet_bubbles_box';

// Memoised because `push` runs on every rule tick (1Hz, and a bubble up for an
// hour means ~3600 pushes) and `db.getSetting` is a live SQL query, not a
// cached read. The value only changes when the user saves on /settings, which
// goes through `saveRuleBox` below and re-seeds this — the same pattern
// pet_action_texts uses for its config blob, and for the same reason.
let ruleBoxCache = null;

function loadRuleBox() {
  if (ruleBoxCache !== null) return ruleBoxCache;
  try {
    const raw = db.getSetting(BOX_KEY);
    const s = (typeof raw === 'string' ? raw : '').trim();
    ruleBoxCache = petTextBoxes.resolve(null, s);
  } catch (e) {
    console.error('[pet_bubbles] loadRuleBox failed:', e && e.message ? e.message : e);
    ruleBoxCache = null;
  }
  return ruleBoxCache;
}

function saveRuleBox(dbRef, id) {
  const s = String(id == null ? '' : id).trim();
  dbRef.setSetting(BOX_KEY, s);
  // Re-seed rather than invalidate-to-null, so the very next push is a cache
  // hit and already reflects the new choice (the pet shouldn't have to wait a
  // tick for a restyled bubble).
  ruleBoxCache = petTextBoxes.resolve(null, s);
  return s;
}

// Drop the memoised box so the next `loadRuleBox` re-reads the row. Needed when
// the DB is swapped underneath us (backup restore) — otherwise the pet would
// keep painting reminders in the previous database's bubble.
function invalidateRuleBox() {
  ruleBoxCache = null;
}

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
    // Same line for every window, per spec.
    //
    // The window label ("早饭" / "午饭" / "晚饭") used to be prepended, giving
    // "早饭：今天吃撒". That prefix is gone: it made the line longer than the
    // sentence needed, and the user asked for the plain four characters. The
    // window is still visible in the settings page's one-line summary
    // (see describe() below), so nothing is actually lost — and the bubble
    // itself is the wrong place for it, because the bubble is small and every
    // extra glyph pushes it toward wrapping.
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
    // The sample line the settings page's 「预览」 button shows when the
    // meal window isn't open right now.
    //
    // Without this the preview fell back to the rule's *name* — the literal
    // string "meal" — because `bubbles:force` uses `forceText()` when the
    // rule has one and the rule name otherwise. So the preview drew a bubble
    // reading "meal" while the real bubble reads "今天吃撒": the user was
    // looking at a picture of something the pet would never say.
    forceText() {
      return this.text;
    },
    build(state) {
      const win = state.activeMealWindow;
      if (!win.id) return null;
      // Already fed during this window → the bubble is done, whether it was
      // up for an hour or thirty seconds.
      if (state.feedWindows[win.id]) return null;
      return {
        text: this.text,
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

  // ---------------------------------------------------------------------
  // 有新版本 — "有新版本啦"
  //
  // Unlike the two rules above, this one is *event*-triggered rather than
  // clock-driven: the window only opens after main/app_update.js has
  // actually checked GitHub and found a newer release. The check runs on its
  // own schedule (once a day, see app_update.js), so the window arrives as a
  // push — `setUpdateNotice()` — rather than being polled by `build()`.
  //
  // Once the window is open, though, the mechanism is EXACTLY the meal
  // rule's: `build()` asks "am I inside the window?" every tick, and the
  // moment it isn't, the rule stops winning, the bubble disappears, and
  // syncRuntime() takes the line back out of the `default` action's pool
  // (动态插拔). There is no separate "showing" bookkeeping and no "consume
  // the notice" step — the window's own expiry IS the cancellation.
  //
  // The window is a plain runtime value, not a DB read: it is a fact about
  // "a newer release exists", and re-deriving it from the settings table
  // every second would mean re-parsing JSON 3600 times an hour for a value
  // that changes twice a day at most.
  //
  // ---------------------------------------------------------------------
  // plugOnly — 这条规则只「插播」，不占气泡位
  // ---------------------------------------------------------------------
  //
  // 这条规则以前是两条路同时走的：既赢得气泡位（广播自己的 kind，琥珀色、
  // 可点 → GitHub Releases），又被 syncRuntime() 插进 default 动作的台词池
  // （重播成一句动作台词，浅蓝色、不可点）。同一句话被画了两次，而且两次
  // 的样子和能不能点都不一样 —— 用户看到的是一个黄的一个蓝的，只有黄色
  // 那个能点。
  //
  // 现在只保留动态插拔这一条路：`plugOnly` 让它跳过 pickRule，不赢得气泡
  // 位，只把那句话插进 default 的台词池。于是「有新版本」只会以动作气泡的
  // 样子出现一次，一种颜色、一套行为。
  //
  // 代价要说清楚：动作气泡是 pointer-events:none，所以「点气泡跳 GitHub」
  // 这个交互在插播路径上是失效的 —— 现在这句提示的作用变成了「告诉桌宠有
  // 新版了」，跳转要走去设置页的更新卡片。
  // 这是用户明确选择的方向（去掉规则路径，只保留动态插拔），所以这里照办，
  // 而不是偷偷留一条规则路径兜底。渲染进程里那条可点分支（src/js/pet.js）
  // 和对应的 CSS（.pet-bubble[data-kind="update"]）也一并删掉了。
  //
  // priority 只在 plugOnly 规则之间排序时才有意义（多条插播规则谁先插），
  // 不再影响气泡位的竞争。
  // ---------------------------------------------------------------------
  {
    name: 'update',
    label: '有新版本',
    kind: KINDS.UPDATE,
    enabled: true,
    priority: 100,
    // 只插播，不占气泡位。见上面的说明。
    plugOnly: true,
    describe() {
      return '检测到新版本时，由桌宠像说自己的台词一样冒一句（窗口 10 分钟后自动结束）';
    },
    // 用于设置页的「预览」按钮（bubbles:force）。这里给一条样例文案，
    // 让用户能在真的等到新版本之前先看一眼气泡长什么样。
    forceText() {
      return UPDATE_TEXT;
    },
    // 激活锁（startedAt）用的是稳定的键 'update'，不是「这一次检测」的
    // 序号。
    //
    // 为什么不需要按检测分键：这条规则的 onStart 什么都不做，锁存在的唯一
    // 目的是别让 onStart 每秒都跑一遍。而「一次检测冒一次泡」这件事根本
    // 不靠这个锁——它靠的是那个时间窗：窗口开着的时候 build() 返回那句
    // 话，窗口一关就返回 null。没有第二次检测，就没有新的窗口，也就没有
    // 第二次冒泡。
    //
    // 反过来，按检测分键（update:1、update:2……）是有代价的：startedAt
    // 是**持久化**的，每检测一次就多一个键，永远不会被清掉——那个 JSON
    // blob 会随着检测次数一直变大。稳定的键没有这个问题。
    activationKey() {
      return 'update';
    },
    build(state) {
      // 窗口开着吗？没开就没话说。
      //
      // 取消完全靠时间：窗口的 untilAt 一过，build() 就返回 null，气泡
      // 消失，default 动作里的那句也跟着被摘掉（见 syncRuntime）。这跟
      // 吃饭提醒靠时间段收尾是同一个机制。
      //
      // 没有「消费通知」这一步，也没有「已提醒」的持久化锁——那两样都会把
      // 第二次检测按死：同一个版本第二次被检出时，气泡就不会再出现。
      const win = state.updateWindow;
      if (!win || !win.version) return null;
      if (state.nowMs >= win.untilAt) return null;
      return {
        text: UPDATE_TEXT,
        durationMs: UPDATE_DURATION_MS,
      };
    },
    onStart() {
      // 这个规则不需要在 onStart 里记任何东西。
      //
      // 窗口的开关完全由「检测到新版本」这个事件驱动（setUpdateNotice
      // 开窗），由窗口自己的 untilAt 关窗。onStart 如果再去写点什么，
      // 就会变成第二份状态——而两份状态迟早会不一致。
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
//
// 「有新版本」这条规则不在持久化状态里留任何东西——它的生命周期完全由
// 那个时间窗决定：一次检测打开一个 10 分钟的窗口，窗口一关气泡就结束。
// 不是一个跨重启的「已提醒」标记。曾经有过一个 updateNotifiedVersion 的
// 锁和一个 updateShownCount 的计数，它们都会把第二次检测按死：用户升级到
// 下一个版本之前，同一个版本再也不冒泡了。老库里残留的那两个字段会被
// 读进来但不再被使用，也不写回去。

function loadState(dbRef) {
  const raw = dbRef.getSetting(STATE_KEY_PREFIX);
  let parsed = {};
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') parsed = o;
    } catch { parsed = {}; }
  }
  const startedAt = (parsed.startedAt && typeof parsed.startedAt === 'object') ? parsed.startedAt : {};
  // Older builds keyed the update rule's activation latch by detection
  // ("update:3"), which left one dead entry behind per check — forever,
  // because nothing ever pruned them. The key is now a stable "update", so
  // those leftovers are dropped here; the next saveState() writes the
  // trimmed map back and the blob stops growing.
  for (const k of Object.keys(startedAt)) {
    if (k.startsWith('update:')) delete startedAt[k];
  }
  return {
    feedWindows: (parsed.feedWindows && typeof parsed.feedWindows === 'object') ? parsed.feedWindows : {},
    lastBreakNudgeAt: Number(parsed.lastBreakNudgeAt) || 0,
    breakNudgeCount: parsed.breakNudgeCount | 0,
    feedWindowsDay: parsed.feedWindowsDay || '',
    startedAt,
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
// this module stays free of an Electron dependency. -1 means "the platform
// didn't tell us", which every idle-based rule must treat as "don't nag".
let runtimeIdleSeconds = -1;
function setIdleSeconds(v) {
  runtimeIdleSeconds = (typeof v === 'number' && Number.isFinite(v)) ? v : -1;
}

// ---------------------------------------------------------------------------
// Runtime: 有新版本 time window
// ---------------------------------------------------------------------------
//
// Set by main/app_update.js when a check finds a newer release on GitHub.
// Kept in memory rather than in the settings table because it is a *fact
// about the current release*, not a user preference: it goes stale on its
// own as soon as the user upgrades or the check runs again.
//
// runtimeUpdateWindow 是一次「检测到更新」打开的**时间窗**：
//   { version, openedAt, untilAt }
//   version  —— 比本地新的那个版本号
//   openedAt —— 窗口打开的时间
//   untilAt  —— 窗口关闭的时间（= openedAt + UPDATE_DURATION_MS）
//
// 机制和吃饭提醒完全一致：窗口开着的时候 build() 一直返回「有新版本」，
// 气泡就一直在；10 分钟一到，build() 返回 null，气泡消失，那句话也从
// default 动作的候选池里被摘掉（动态插拔）。
//
// 下一次检测会把窗口重新打开（untilAt 顺延），于是又冒一次泡——哪怕是
// 同一个版本，因为那是一次新的检测。窗口是整体替换的，不需要一个序号
// 来区分「这是第几次检测」：没有任何逻辑需要同时持有两个窗口。
//
// 这里刻意不放持久化的「已提醒」锁：那个锁跨重启存在，会在用户升级到
// 下一个版本之前把提醒按死——正是「检测到新版本但气泡不出现」的原因。
let runtimeUpdateWindow = null;

/**
 * Tell the bubble engine a newer release exists.
 *
 * 每一次调用都代表一次独立的「检测到新版本」，所以每一次都会打开一个
 * 新的时间窗——哪怕版本号和上一次完全一样。窗口 10 分钟后自己关上，气泡
 * 随之结束；要再冒一次，必须有下一次检测。
 *
 * @param {string} version  the newer version, e.g. "0.2.0"
 */
function setUpdateNotice(version) {
  const v = String(version || '').trim();
  if (!v) return false;
  const now = Date.now();
  // 每次检测都重开窗口：untilAt 从「这一次检测」开始算 10 分钟。
  //
  // 如果上一次检测的窗口还开着（同一版本被检出了两次），相当于把剩余
  // 时间顺延到从现在起算 10 分钟——这是「每次检测都提醒一次」的应有之义。
  runtimeUpdateWindow = {
    version: v,
    openedAt: now,
    untilAt: now + UPDATE_DURATION_MS,
  };
  return true;
}

/**
 * Close the window. Called when the user has acknowledged it (e.g. opened
 * the releases page) or when the update is no longer current.
 */
function clearUpdateNotice(version) {
  if (!runtimeUpdateWindow) return false;
  // With no version given, close unconditionally; with one, only close if it
  // matches — so a stale ack for an old version can't wipe a fresher window.
  if (version != null && runtimeUpdateWindow.version !== String(version)) return false;
  runtimeUpdateWindow = null;
  return true;
}

/**
 * Forget everything about the 有新版本 reminder: close the time window.
 *
 * 这只给开发模式的调试入口用（main/app_update.js 的 devTools）。正常路径
 * 永远不需要它——现在没有跨重启的「已提醒」锁，模拟出来的提醒本来就只在
 * 内存里。
 */
function resetUpdateReminder() {
  runtimeUpdateWindow = null;
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
    // The "有新版本" time window, opened by main/app_update.js when a check
    // finds a newer release. Null whenever no newer release is known, or
    // when the window has closed. The rule asks it "am I inside the window?"
    // every tick — exactly like the meal rule asks "am I inside the meal
    // window?" — and that question is the whole cancellation mechanism.
    updateWindow: runtimeUpdateWindow,
    // The live state object, by reference. `onStart` / `onEvent` get the
    // snapshot, and a rule that needs to record a *scalar* (not a shared
    // sub-object) has to write it somewhere that survives the tick —
    // writing it on the snapshot would be silently discarded, because the
    // snapshot is rebuilt from scratch on every tick.
    //
    // `feedWindows` above is shared by reference for the same reason; this
    // is the general escape hatch for rules whose latch is a scalar.
    liveState: state,
    // The framework's own mutation signal — set by rules to request a save.
    dirty: false,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// The highest-priority rule that wants a bubble right now, or null.
//
// A rule marked `plugOnly` is skipped here — see the comment on the `update`
// rule for why 有新版本 wants to be *said* but not to *own* the bubble slot.
function pickRule(snapshot, enabledMap) {
  for (const rule of ORDERED_RULES) {
    if (rule.plugOnly) continue;
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

// ---------------------------------------------------------------------------
// Plug-only rules (动态插拔 only, no bubble slot)
// ---------------------------------------------------------------------------
//
// A `plugOnly` rule never wins the bubble slot; it only feeds a line into the
// `default` action's runtime pool, and the pet says it when that action
// happens to play. The bubble that eventually appears is an *action* bubble,
// so it wears the action accent rather than the rule's own.
//
// The reason 有新版本 works this way is that it used to work BOTH ways at
// once, and the two ways disagreed: the rule path broadcast its own kind
// (amber, clickable → GitHub Releases), while the 动态插拔 path replayed the
// same sentence as an action line (blue, not clickable). The user saw the
// same sentence in two different colours and could only click one of them —
// the one that mattered.
//
// So the rule path is gone: 有新版本 is *only* spoken by the pet as one of
// its own lines. One path, one look, one behaviour.
//
// Returned as a list rather than a single rule: several plug-only rules
// could coexist, and the pool takes all of their lines at once.
function collectPlugOnly(snapshot, enabledMap) {
  const out = [];
  for (const rule of ORDERED_RULES) {
    if (!rule.plugOnly) continue;
    if (enabledMap[rule.kind] === false) continue;
    let intent;
    try {
      intent = rule.build(snapshot);
    } catch (e) {
      console.error(`[pet_bubbles] rule "${rule.name}" build failed:`, e && e.message ? e.message : e);
      continue;
    }
    if (intent && typeof intent.text === 'string' && intent.text.trim()) {
      out.push({ rule, intent });
    }
  }
  return out;
}

// Run a rule's activation hook at most once per bubble. The latch is stored
// on the persisted state so a restart doesn't re-nudge the break rule
// mid-bubble.
//
// A rule may declare `activationKey(snapshot)` to make the latch finer than
// "once per rule name" — e.g. per window rather than per rule. The 有新版本
// rule declares one, but it settles on the stable "update": its `onStart`
// does nothing, and the per-detection latch it used to carry was not just
// unnecessary but harmful (it wrote one more key into the *persisted*
// `startedAt` map on every check, forever).
function maybeRunOnStart(rule, state, snapshot, durationMs, nowMs) {
  // The latch key. Without activationKey it's the rule's own name, which
  // keeps the old behaviour (one activation per bubble per rule).
  const key = (typeof rule.activationKey === 'function')
    ? (rule.activationKey(snapshot) || rule.name)
    : rule.name;
  const last = Number(state.startedAt[key]) || 0;
  if (nowMs - last < durationMs) return;
  state.startedAt[key] = nowMs;
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

function push(payload) {
  lastBroadcastKey = payload.text == null ? '' : `${payload.kind}|${payload.rule}|${payload.text}`;
  if (!broadcastFn) return;
  // Stamp the 文本框 onto every bubble that goes out — the rule bubble and
  // the clear alike. Doing it here rather than at each push call site is what
  // guarantees a box can't be attached to one kind of bubble and forgotten on
  // another; there is no path to `broadcastFn` that skips this.
  //
  // The clear payload carries a null box too, so the renderer drops the
  // artwork when the bubble goes rather than leaving it behind.
  try {
    broadcastFn({ ...payload, box: payload.text == null ? null : loadRuleBox() });
  }
  catch (e) { console.error('[pet_bubbles] broadcast failed:', e && e.message ? e.message : e); }
}

// ---------------------------------------------------------------------------
// 动态插拔 — mirror the live rule line into the `default` action's pool
// ---------------------------------------------------------------------------
//
// The currently-winning rule's text is added to `default`'s candidate pool
// for exactly as long as that rule's bubble is on screen, then removed. We
// derive both the add and the remove from the same tick result rather than
// hooking per-rule onStart/onEnd, because:
//
//   * the "which rule is showing" decision is already made here (priority
//     order + enable toggles), so mirroring it can't disagree with what the
//     user actually sees;
//   * a rule that *stops* being the winner (because the user fed the pet and
//     吃饭提醒 dropped out) leaves no onEnd hook to fire — there's no
//     "bubble disappeared" event. Diffing the winner set per tick is the only
//     place that reliably notices.
//
// `runtimePlugged` holds what we last added, so the next tick can remove
// exactly those entries and no others — two rules can carry the same line
// text ("坐太久了" in two nudges) and we must not yank the other's copy.
let runtimePlugged = [];   // [{ text, ttlMs }]

function plugRuntime(text, ttlMs) {
  if (!text) return;
  petActionTexts.enqueueRuntime(RUNTIME_TARGET_ACTION, text, ttlMs);
  runtimePlugged.push({ text, ttlMs: Number(ttlMs) || 0 });
}

// Reconcile the runtime pool with what's on screen right now. `lines` is the
// list of lines to have plugged right now — the winning rule's line plus
// every plug-only rule's line (a list, because plug-only rules don't compete
// for the bubble slot and so can all be live at once). Returns true when the
// `default` action gained or lost a line, which the caller uses to force a
// re-pick of the action's speech bubble.
function syncRuntime(lines) {
  const want = [];
  for (const l of (Array.isArray(lines) ? lines : [])) {
    if (!l || !l.text) continue;
    want.push({ text: l.text, ttlMs: Number(l.ttlMs) || 0 });
  }
  const had = runtimePlugged.length > 0;
  // Remove everything we plugged on a previous tick, then re-add the current
  // set. Simpler (and safer) than trying to diff: the pool is at most a
  // couple of entries, and a full reset can't strand a line we forgot about.
  for (const old of runtimePlugged) {
    petActionTexts.dequeueRuntime(RUNTIME_TARGET_ACTION, old.text);
  }
  runtimePlugged = [];
  for (const l of want) {
    // The authoritative removal happens on the *next* tick once the rule
    // stops winning; this ttl only matters if the app is killed mid-bubble,
    // in which case the in-memory pool dies with it anyway.
    plugRuntime(l.text, l.ttlMs);
  }
  return had !== (want.length > 0);
}

// Clear the pool on stop() so a line can't outlive the process that
// produced it.
function resetRuntime() {
  for (const old of runtimePlugged) {
    petActionTexts.dequeueRuntime(RUNTIME_TARGET_ACTION, old.text);
  }
  runtimePlugged = [];
  petActionTexts.clearRuntime();
}

// ---------------------------------------------------------------------------
// Previewing a plug-only rule
// ---------------------------------------------------------------------------
//
// The settings page's 「预览」 button has to show the user what a rule looks
// like. For a plug-only rule the honest preview is the thing itself: plug the
// line into the pool and let the pet say it, exactly as a real detection
// would. Painting a rule-bubble card instead would show a look the user
// never sees in practice — a different colour, a different click behaviour —
// which is the very inconsistency this rule was changed to remove.
//
// The line is inserted directly rather than going through `syncRuntime`, so
// it survives until the next tick reconciles the pool. That is deliberate:
// the next tick would otherwise immediately dequeue it again (its rule
// isn't due), and the preview would never be spoken.
//
// Returns the text that was plugged, or null if the rule has nothing to say.
function forcePlugOnly(rule) {
  if (!rule || !rule.plugOnly) return null;
  const text = (typeof rule.forceText === 'function') ? rule.forceText() : rule.name;
  if (!text) return null;
  // A generous ttl: the preview is a one-off, and the pool entry is
  // reconciled away on the next tick anyway.
  petActionTexts.enqueueRuntime(RUNTIME_TARGET_ACTION, text, petActionTexts.RUNTIME_TTL_MS);
  return text;
}

function tick() {
  if (!db.get()) return;

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

  let payload = { text: null, kind: null, rule: null, durationMs: DEFAULT_DURATION_MS };
  if (picked) {
    const { rule, intent } = picked;
    const durationMs = Number.isFinite(intent.durationMs) ? intent.durationMs : DEFAULT_DURATION_MS;
    maybeRunOnStart(rule, state, snapshot, durationMs, now.getTime());
    // durationMs travels with the payload so the renderer's self-expiry
    // backstop matches the rule's own duration. Without it the renderer
    // falls back to 1 hour — which for the 有新版本 bubble (10 minutes)
    // would leave it on screen for an hour and a half if the main side's
    // clear broadcast were ever missed.
    payload = { text: intent.text, kind: rule.kind, rule: rule.name, durationMs };
  }

  // Mirror the live lines into the `default` action's speech pool (动态插拔).
  // Two sources feed it:
  //
  //   * the winning rule's line, for as long as that rule owns the bubble
  //     slot;
  //   * every plug-only rule's line (currently just 有新版本), for as long as
  //     that rule's own window is open.
  //
  // When the winning rule changes — or stops winning entirely, e.g. after the
  // user feeds the pet — or when a plug-only rule's window closes, the stale
  // line is removed on the very next tick.
  const plugLines = [];
  for (const { rule, intent } of collectPlugOnly(snapshot, enabledMap)) {
    plugLines.push({
      text: intent.text,
      ttlMs: Number.isFinite(intent.durationMs) ? intent.durationMs : DEFAULT_DURATION_MS,
    });
    // A plug-only rule still gets its activation hook, so `onStart` runs once
    // per window rather than every tick.
    maybeRunOnStart(rule, state, snapshot, plugLines[plugLines.length - 1].ttlMs, now.getTime());
  }
  const syncLines = [];
  if (payload.text) {
    syncLines.push({
      text: payload.text,
      ttlMs: picked && Number.isFinite(picked.intent.durationMs)
        ? picked.intent.durationMs : DEFAULT_DURATION_MS,
    });
  }
  for (const l of plugLines) syncLines.push(l);
  syncRuntime(syncLines);

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
  // Drop the plugged-in rule lines too, so a stop()/start() cycle can't
  // leave a 吃饭提醒 line stranded in the `default` action's pool with no
  // rule behind it to remove it.
  resetRuntime();
  // The 有新版本 time window is a runtime value, so it dies with the engine
  // that owns it. Nothing about it is persisted: every detection opens a
  // fresh window, and the bubble ends when that window closes.
  runtimeUpdateWindow = null;
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
      // A plug-only rule doesn't own the bubble slot — it only feeds a line
      // into the idle action's pool. Surfaced so the settings page can say
      // so, and so the preview button knows to preview it the plug way.
      plugOnly: !!r.plugOnly,
    })),
    // Surfaced so the settings page can show "今日已喂食" without waiting
    // for the bubble to appear.
    feedWindows: state.feedWindows,
  };
}

module.exports = {
  BROADCAST_CHANNEL,
  DEFAULT_DURATION_MS,
  UPDATE_DURATION_MS,
  UPDATE_TEXT,
  REFRESH_MS,
  BUILTIN_RULES,
  KINDS,
  RUNTIME_TARGET_ACTION,

  // lifecycle
  start,
  stop,
  tick,
  setIdleSeconds,
  emit,
  invalidateRuleBox,

  // 有新版本 time window (opened by main/app_update.js on every detection)
  setUpdateNotice,
  clearUpdateNotice,
  // 开发模式调试用：把模拟出来的提醒收掉。
  resetUpdateReminder,

  // config / introspection
  loadEnabled,
  saveEnabled,
  describeRules,

  // 文本框 for rule bubbles (pet-independent, like the enable toggles)
  loadRuleBox,
  saveRuleBox,
  invalidateRuleBox,

  // 动态插拔 — the runtime lines currently plugged into `default`'s pool,
  // re-exported so the settings page can show them without reaching into
  // pet_action_texts directly.
  listRuntime: petActionTexts.listRuntime,
  // Preview a plug-only rule by plugging it, rather than by painting a
  // rule-bubble card the user would never see for real.
  forcePlugOnly,

  // internals, exposed so the IPC layer can build a preview of what each
  // rule would say right now
  _internals: {
    loadState,
    buildSnapshot,
  },
};