// pet/preload.js — pet window preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp', {
  pet: {
    getState: () => ipcRenderer.invoke('pet:get_state'),
    // Legacy alias for getCurrent (kept so older renderer code keeps working).
    getSpecies: () => ipcRenderer.invoke('pet:get_current'),
    showMain: () => ipcRenderer.invoke('window:show_main'),
    openReminder: () => ipcRenderer.invoke('window:open_reminder'),
    moveBy: (dx, dy) => ipcRenderer.invoke('pet:move_by', dx, dy),
    // Main-process drag. `dragStart(grabDX, grabDY, gestureId)` hands the main
    // process the offset between the pointer and the window's top-left; from
    // then on the main process follows the cursor itself
    // (screen.getCursorScreenPoint), so the drag keeps working after the
    // pointer leaves the 220 px pet window. `dragEnd(gestureId)` releases it.
    //
    // `gestureId` identifies the pointer gesture the message belongs to.
    // The main process uses it to recognise a message that arrives after its
    // gesture has already ended — see the note on `pet:drag_start` in
    // main/ipc.js. `dragEnd(0)` means "stop whatever drag you are running".
    dragStart: (grabDX, grabDY, gestureId) =>
      ipcRenderer.invoke('pet:drag_start', grabDX, grabDY, gestureId),
    dragEnd: (gestureId) => ipcRenderer.invoke('pet:drag_end', gestureId),
    // The gesture-id high-water mark of the main process.
    //
    // The renderer counts its gestures from 1, but the ids have to stay
    // unique for the whole life of the app: the main process refuses a
    // start whose id it has already seen, so a renderer that reloaded would
    // otherwise have every one of its drags refused as a replay — and the
    // pet could not be dragged again until the app was restarted.
    //
    // Asking the main process for the current mark lets a fresh renderer
    // pick up where the last one left off.
    gestureBase: () => ipcRenderer.invoke('pet:gesture_base'),
    // Append one entry to the diagnostic log (main/pet_diagnostics.js).
    //
    // The pet window records every pointer press, every wake and every
    // drag takeover there. The "cannot be dragged after a sleep" bug only
    // reproduces on real hardware, so the app writes down what it sees
    // instead of guessing at the cause.
    diag: (entry) => ipcRenderer.invoke('pet:diag', entry),
    // "Input is reaching this renderer again."
    //
    // Sent once per wake, by the renderer, the first time it sees any
    // input event. The main process watches for it: if the OS cursor moves
    // over the pet and this message never arrives, the window's input path
    // is dead — a renderer can be alive and deaf at the same time, because
    // it still answers IPC while no mouse event ever reaches it. No
    // in-process recovery can fix that (the pointer device registry lives
    // in the browser process), so the main process restarts the app.
    inputAlive: () => ipcRenderer.invoke('pet:input_alive'),
    setPaused: (ms) => ipcRenderer.invoke('pet:set_paused', ms),
    openContextMenu: () => ipcRenderer.invoke('pet:context_menu'),
    triggerAction: (action, ms) => ipcRenderer.invoke('pet:trigger_action', action, ms),
    // Renderer-side signal fired by `FrameAnimator.onEnded` after a
    // one-shot (movement or cozy) finishes its frame sequence. The
    // controller uses this to drop back to `default` and re-roll the
    // next loop action by probability (default 70% / movement 15% /
    // other 15%). See `handleActionEnded` in main/pet_controller.js.
    actionEnded: () => ipcRenderer.invoke('pet:action_ended'),
    // New frame-based registry API.
    list: () => ipcRenderer.invoke('pet:list'),
    getCurrent: () => ipcRenderer.invoke('pet:get_current'),
    setCurrent: (id) => ipcRenderer.invoke('pet:set_current', id),
    resolveFrames: (petId, variant, direction) =>
      ipcRenderer.invoke('pet:resolve_frames', petId, variant, direction),
    // Active pet's manifest.defaultSize. Pet.js calls this on init so its
    // CSS --size-w / --size-h are correct before the first paint.
    getCurrentSize: () => ipcRenderer.invoke('pet:get_current_size'),
    // Per-pet click / dblclick / idle-loop config. The pet window reads
    // this on every click (cached in memory) to decide what variant to
    // fire instead of the legacy hard-coded cozy pet/pat.
    actionsConfig: {
      get:             ()    => ipcRenderer.invoke('pet:actions_config:get'),
      save:            (cfg) => ipcRenderer.invoke('pet:actions_config:save', cfg || {}),
      getLoopVariants: ()    => ipcRenderer.invoke('pet:loop_variants:get'),
    },
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  // 关闭提醒 — acknowledge the reminder the pet is nagging about.
  //
  // The pet window paints the badge and the headline bubble, so it needs
  // a way to tell the main process "this one is handled". Without it the
  // pet could only hide its own bubble, and the nag stayed on: the badge
  // kept counting, the sprite kept shaking, and the top-bar pill kept
  // reading 桌宠提醒. This is the same soft-dismiss the main window's
  // 完成 button performs — the reminder stops nagging but stays on the
  // 今日 page.
  reminders: {
    completeForToday: (source, id) =>
      ipcRenderer.invoke('reminders:complete_for_today', source, id),
  },
  // Bond / Cozy / Mood surface used by the pet renderer. The doubleclick
  // handler in pet.js calls `mp.bond.pat()`; the right-click menu also
  // dispatches here indirectly via the main process IPC handlers.
  bond: {
    getSnapshot:      () => ipcRenderer.invoke('bond:get_snapshot'),
    getFullState:     () => ipcRenderer.invoke('bond:get_full_state'),
    pet:      () => ipcRenderer.invoke('bond:pet'),
    pat:      () => ipcRenderer.invoke('bond:pat'),
    feed:     () => ipcRenderer.invoke('bond:feed'),
    play:     () => ipcRenderer.invoke('bond:play'),
    sleep:    () => ipcRenderer.invoke('bond:sleep'),
    cuddle:   () => ipcRenderer.invoke('bond:cuddle'),
  },
  on: (channel, cb) => {
    const allowed = [
      'pet:state-changed',
      'pet:species-changed',  // legacy
      'pet:action-changed',
      'pet:pet-changed',
      'pet:size-changed',
      // Bond / Cozy / Mood broadcast channels. Mood changes are
      // emitted only when the mood key actually flips, so the renderer
      // can apply the new CSS filter on every event without diffing.
      'pet:mood-changed',
      'pet:cozy-changed',
      'pet:bond-tier-changed',
      // One-shot particles (heart / sparkle / food / etc.) requested by
      // either the right-click menu or a cozy interaction. Renderer
      // spawns a transient <div> on the .pet-particles layer.
      'pet:particle',
      // Contextual text bubble (吃饭提醒 / 休息提醒). Emitted by
      // main/pet_bubbles.js; `{ text: null }` means "clear the bubble".
      'pet:bubble-changed',
      // 系统从睡眠/休眠中唤醒。主进程在 main/ipc.js 的恢复流程里发出，
      // 渲染层据此复位拖拽手势状态（睡眠期间 pointerup 可能丢失，
      // 导致 pressing 一直为 true，之后鼠标一移动就误算拖拽增量）。
      'pet:resume',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
