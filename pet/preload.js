// pet/preload.js — pet window preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp', {
  pet: {
    getState: () => ipcRenderer.invoke('pet:get_state'),
    getPosition: () => ipcRenderer.invoke('pet:get_position'),
    // Legacy alias for getCurrent (kept so older renderer code keeps working).
    getSpecies: () => ipcRenderer.invoke('pet:get_current'),
    showMain: () => ipcRenderer.invoke('window:show_main'),
    openReminder: () => ipcRenderer.invoke('window:open_reminder'),
    moveBy: (dx, dy) => ipcRenderer.invoke('pet:move_by', dx, dy),
    // Main-process drag. `dragStart(grabDX, grabDY)` hands the main process
    // the offset between the pointer and the window's top-left; from then on
    // the main process follows the cursor itself (screen.getCursorScreenPoint),
    // so the drag keeps working after the pointer leaves the 220 px pet
    // window. `dragEnd()` releases it.
    dragStart: (grabDX, grabDY) => ipcRenderer.invoke('pet:drag_start', grabDX, grabDY),
    dragEnd: () => ipcRenderer.invoke('pet:drag_end'),
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
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
