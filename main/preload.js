// main/preload.js — main window preload, exposes safe IPC API to window
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp', {
  // contacts
  contacts: {
    list: () => ipcRenderer.invoke('contacts:list'),
    get: (id) => ipcRenderer.invoke('contacts:get', id),
    create: (input) => ipcRenderer.invoke('contacts:create', input),
    update: (id, input) => ipcRenderer.invoke('contacts:update', id, input),
    delete: (id) => ipcRenderer.invoke('contacts:delete', id),
    // Avatar upload/read/delete. `upload` payload shape mirrors the photo
    // uploaders: { filename, mime, bytes (ArrayBuffer|Uint8Array) }. `read`
    // returns { data_url, mime } or null when no avatar is set — embed the
    // data_url into <img src=…> directly (CSP-safe).
    uploadAvatar: (id, payload) => ipcRenderer.invoke('contacts:upload_avatar', id, payload),
    readAvatar:   (id)            => ipcRenderer.invoke('contacts:avatar_read', id),
    deleteAvatar: (id)            => ipcRenderer.invoke('contacts:avatar_delete', id),
  },
  // contact attributes (likes / taboos / gifts — global table)
  attributes: {
    list:   (kind, opts) => ipcRenderer.invoke('attributes:list', kind, opts || {}),
    create: (input) => ipcRenderer.invoke('attributes:create', input),
    update: (id, input) => ipcRenderer.invoke('attributes:update', id, input),
    delete: (id) => ipcRenderer.invoke('attributes:delete', id),
    deleteMany: (ids) => ipcRenderer.invoke('attributes:delete_many', ids),
  },
  // important dates
  importantDates: {
    list: (contactId) => ipcRenderer.invoke('important_dates:list', contactId),
    create: (contactId, input) => ipcRenderer.invoke('important_dates:create', contactId, input),
    update: (id, input) => ipcRenderer.invoke('important_dates:update', id, input),
    delete: (id) => ipcRenderer.invoke('important_dates:delete', id),
  },
  // events
  events: {
    list: (opts) => ipcRenderer.invoke('events:list', opts || {}),
    listToday: () => ipcRenderer.invoke('events:list_today'),
    get: (id) => ipcRenderer.invoke('events:get', id),
    create: (input) => ipcRenderer.invoke('events:create', input),
    update: (id, input) => ipcRenderer.invoke('events:update', id, input),
    delete: (id) => ipcRenderer.invoke('events:delete', id),
    deleteMany: (ids) => ipcRenderer.invoke('events:delete_many', ids),
    debugFireDueNow: () => ipcRenderer.invoke('events:debug_fire_due_now'),
    listFestivals: () => ipcRenderer.invoke('events:list_festivals'),
  },
  // memorial events (independent from the reminder events table)
  memorialEvents: {
    list:   (opts)      => ipcRenderer.invoke('memorial_events:list', opts || {}),
    get:    (id)        => ipcRenderer.invoke('memorial_events:get', id),
    create: (input)     => ipcRenderer.invoke('memorial_events:create', input),
    update: (id, input) => ipcRenderer.invoke('memorial_events:update', id, input),
    delete: (id)        => ipcRenderer.invoke('memorial_events:delete', id),
    deleteMany: (ids)   => ipcRenderer.invoke('memorial_events:delete_many', ids),
    photos: {
      // payload shape for upload: { filename, mime, bytes (ArrayBuffer|Uint8Array) }
      list:   (eventId)         => ipcRenderer.invoke('memorial_events:photos_list', eventId),
      upload: (eventId, payload)=> ipcRenderer.invoke('memorial_events:photos_upload', eventId, payload),
      delete: (photoId)         => ipcRenderer.invoke('memorial_events:photos_delete', photoId),
      // Returns { data_url, mime } — embed directly in <img src=...> to
      // bypass the CSP `default-src 'self'` rule that prevents custom protocol
      // schemes from being loaded into <img>.
      read:   (photoId)         => ipcRenderer.invoke('memorial_events:photo_read', photoId),
      // Returns { width, height } using pdfkit's openImage(), so dims are
      // post-EXIF-orientation. Used by the album editor to keep cover-fit
      // math consistent with the PDF renderer.
      meta:   (photoId)         => ipcRenderer.invoke('memorial_events:photo_meta', photoId),
    },
  },
  // reminders
  reminders: {
    listActive: () => ipcRenderer.invoke('reminders:list_active'),
    // Today's reminder view: every event scheduled for today (whether
    // or not the scheduler has fired it yet), with the soft-completion
    // state attached. Drives the "当前提醒" block on the 今日 page.
    listTodayView: () => ipcRenderer.invoke('reminders:list_today_view'),
    // Soft-dismiss for today. The pet stops nagging but the queue item
    // (and 今日 page entry) remain visible so the user can still scroll
    // back to confirm what they finished.
    completeForToday: (source, id) => ipcRenderer.invoke('reminders:complete_for_today', source, id),
    markDone: (source, id) => ipcRenderer.invoke('reminders:mark_done', source, id),
    snooze: (source, id, minutes) => ipcRenderer.invoke('reminders:snooze', source, id, minutes),
  },
  // search
  search: {
    query: (q) => ipcRenderer.invoke('search:query', q),
  },
  // pet / settings / windowing
  pet: {
    getState: () => ipcRenderer.invoke('pet:get_state'),
    setPosition: (x, y) => ipcRenderer.invoke('pet:set_position', x, y),
    getPosition: () => ipcRenderer.invoke('pet:get_position'),
    showMain: () => ipcRenderer.invoke('window:show_main'),
    openReminder: () => ipcRenderer.invoke('window:open_reminder'),
    // Legacy species API kept as a thin wrapper around the new pet-id registry.
    getSpecies: () => ipcRenderer.invoke('pet:get_species'),
    setSpecies: (s) => ipcRenderer.invoke('pet:set_species', s),
    // New frame-based registry.
    list: () => ipcRenderer.invoke('pet:list'),
    getCurrent: () => ipcRenderer.invoke('pet:get_current'),
    setCurrent: (id) => ipcRenderer.invoke('pet:set_current', id),
    resolveFrames: (petId, variant, direction) =>
      ipcRenderer.invoke('pet:resolve_frames', petId, variant, direction),
    // Autonomous-walk controls.
    getWalkEnabled: () => ipcRenderer.invoke('pet:get_walk_enabled'),
    setWalkEnabled: (b) => ipcRenderer.invoke('pet:set_walk_enabled', b),
    // Pack import — see main/pet_zip_import.js (frame-directory zip).
    listInstalled:   ()        => ipcRenderer.invoke('pet:list_installed'),
    importFromZip:   ()        => ipcRenderer.invoke('pet:import_from_zip'),
    removeImported:  (petId)   => ipcRenderer.invoke('pet:remove_imported', petId),
    // Active pet's manifest.defaultSize. Pet.js calls this on init so its
    // CSS --size-w / --size-h are correct before the first paint.
    getCurrentSize:  ()        => ipcRenderer.invoke('pet:get_current_size'),
    // Per-pet click / double-click / idle-loop config (settings page edits
    // it; pet window reads click_variant/dblclick_variant on each click).
    //   get()        → { config, available_variants, pet_id }
    //   save(cfg)    → { ok, config } (validated + filtered against manifest)
    //   getLoopVariants() → { variants: string[] }
    actionsConfig: {
      get:             ()    => ipcRenderer.invoke('pet:actions_config:get'),
      // (petId, cfg) — handler resolves petId via db fallback if null, but
      // we pass it explicitly so multi-window flows stay unambiguous.
      save:            (cfg) => ipcRenderer.invoke('pet:actions_config:save', null, cfg || {}),
      getLoopVariants: ()    => ipcRenderer.invoke('pet:loop_variants:get'),
    },
    // 动作 → 文本绑定 (per-pet). `get()` returns
    // { texts, actions: [{action, label, texts, runtime}], runtime, pet_id }
    // so the settings page builds the whole editor from one call;
    // `save({texts})` replaces the map wholesale.
    actionTexts: {
      get:  ()    => ipcRenderer.invoke('pet:action_texts:get'),
      save: (cfg) => ipcRenderer.invoke('pet:action_texts:save', null, cfg || {}),
    },
  },
  settings: {
    get: (k) => ipcRenderer.invoke('settings:get', k),
    set: (k, v) => ipcRenderer.invoke('settings:set', k, v),
  },
  // 文本气泡（吃饭提醒 / 休息提醒）配置。规则本身由
  // main/pet_bubbles.js 单点定义，/settings 只能读它的自描述列表并切
  // 换开关——新增一条规则时这里不需要改动。
  //   getConfig()  → { rules: [{name,label,kind,description,enabled}], feedWindows }
  //   setEnabled({ meal: false, … })
  //   say(text)    → 右键「说句话」输入的原文，立即以气泡显示
  //   onSayPrompt(cb) → 主进程请求弹出输入框
  //   preview / force / getIdleSeconds
  bubbles: {
    getConfig:      ()         => ipcRenderer.invoke('bubbles:get_config'),
    setEnabled:     (map)      => ipcRenderer.invoke('bubbles:set_enabled', map || {}),
    say:            (text)     => ipcRenderer.invoke('bubbles:say', text || ''),
    preview:        (ruleName) => ipcRenderer.invoke('bubbles:preview', ruleName || ''),
    force:          (ruleName) => ipcRenderer.invoke('bubbles:force', ruleName || ''),
    getIdleSeconds: ()         => ipcRenderer.invoke('bubbles:get_idle_seconds'),
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    // PIN gate: server-side verify + change. Renderer never sees the
    // stored hash / salt — only `{ ok: boolean }` round-trips.
    verifyPin: (pin) => ipcRenderer.invoke('app:verify_pin', pin),
    setPin:    (pin) => ipcRenderer.invoke('app:set_pin', pin),
    // 开机自启动 (Windows Run key). `get` resolves to
    // { supported, enabled, active } — see main/autostart.js.
    getAutostart:    ()      => ipcRenderer.invoke('app:get_autostart'),
    setAutostart:    (on)    => ipcRenderer.invoke('app:set_autostart', on),
    // 自动更新（GitHub Releases）。逻辑全在 main/app_update.js。
    //   getState()    → { currentVersion, supported, enabled, info, checking,
    //                    downloading, installing, error, lastCheckAt, repo }
    //   check()       → { ok, hasUpdate, info, reason, state }
    //   setEnabled(on)
    //   download()    → { ok, path, version, bytes, reason, state }（进度走
    //                    `app:update-progress` 推送）
    //   install({path, version, confirm}) → 会关闭应用并启动安装器
    //   revealInstaller(path) → 在文件管理器中定位安装包
    getUpdateState:     ()      => ipcRenderer.invoke('app:get_update_state'),
    checkUpdate:        ()      => ipcRenderer.invoke('app:check_update'),
    setUpdateEnabled:   (on)    => ipcRenderer.invoke('app:set_update_enabled', on),
    downloadUpdate:     ()      => ipcRenderer.invoke('app:download_update'),
    installUpdate:      (opts)  => ipcRenderer.invoke('app:install_update', opts || {}),
    revealInstaller:    (p)     => ipcRenderer.invoke('app:reveal_installer', { path: p }),
    // 打开外部链接（当前只有 GitHub Releases 页面）。限制为 http/https，
    // 否则渲染进程可以拿它去打开 file:// 或自定义 scheme。
    openExternal:       (url)   => ipcRenderer.invoke('app:open_external', url),
  },
  // Backup / restore. Two-step import (pick → apply) so the renderer can
  // surface a confirm() dialog between picking the zip and overwriting the
  // local DB.
  backup: {
    export: () => ipcRenderer.invoke('backup:export'),
    import: () => ipcRenderer.invoke('backup:import'),
    apply:  (zipPath) => ipcRenderer.invoke('backup:apply', zipPath),
  },

  // Export memorial albums (PDF) / videos (MP4) by contact and time range.
  // All material comes from `memorial_events` + `memorial_event_photos`.
  //   previewFilter({ contactIds, range:{start,end} }) → counts + event summaries
  //   pdf({ eventIds, layout? })                      → save dialog → builds
  //   mp4({ eventIds })                                → save dialog → builds
  //   cancel({ jobId })                                → flips the killed flag
  // pdf() now accepts an optional `layout` field (AlbumLayout from the
  // WYSIWYG editor) for the new multi-template experience. When missing,
  // it falls back to the original 1-photo-per-page behavior.
  export_: {
    previewFilter: (filter) => ipcRenderer.invoke('export:preview_filter', filter || {}),
    pdf: (payload) => ipcRenderer.invoke('export:pdf', payload || {}),
    docx: (payload) => ipcRenderer.invoke('export:docx', payload || {}),
    mp4: (payload) => ipcRenderer.invoke('export:mp4', payload || {}),
    cancel: (payload) => ipcRenderer.invoke('export:cancel', payload || {}),
  },

  // Video → frames zip tool. Backed by `tools:split_video_to_frames` and
  // `tools:cancel` in main/ipc.js. Both dialogs (input + save) run in the
  // main process — the renderer just kicks off the job and waits.
  //   splitVideo({ fps, format }) → { canceled } | { canceled:false, path, frames, bytes, jobId }
  //   cancel({ jobId })           → { ok }
  //   revealInFolder(path)        → bool; opens OS file manager at path
  //
  // removeImageBackground backs the "transparent PNG" tool. It reuses the
  // same `tools:cancel` + `tools:progress` channel:
  //   removeImageBackground({ tolerance, softness })
  //     → { canceled } | { canceled:false, path, width, height, bytes, transparentRatio, jobId }
  // tolerance is 'strict'|'normal'|'loose'; softness is 0-4.
  tools: {
    splitVideo:     (opts) => ipcRenderer.invoke('tools:split_video_to_frames', opts || {}),
    removeImageBackground: (opts) => ipcRenderer.invoke('tools:remove_image_background', opts || {}),
    cancel:         (payload) => ipcRenderer.invoke('tools:cancel', payload || {}),
    revealInFolder: (path) => ipcRenderer.invoke('tools:reveal_in_folder', path),
  },

  // Bond / Cozy / Mood API surface for the main window. The /pets page
  // uses these to render the tier label, weekly breakdown, today flag,
  // and current mood. Renderer-side wrappers around the same `mp.pet.*`
  // IPCs are exposed in pet/preload.js for the pet window.
  bond: {
    getSnapshot:       ()      => ipcRenderer.invoke('bond:get_snapshot'),
    getWeeklyBreakdown:()      => ipcRenderer.invoke('bond:get_weekly_breakdown'),
    getCozySnapshot:   ()      => ipcRenderer.invoke('bond:get_cozy_snapshot'),
    getFullState:      ()      => ipcRenderer.invoke('bond:get_full_state'),
    celebrate:         ()      => ipcRenderer.invoke('bond:celebrate'),
    legendaryDance:    ()      => ipcRenderer.invoke('bond:trigger_legendary_dance'),
    setMuted:          (b)     => ipcRenderer.invoke('bond:set_muted', !!b),
    getMuted:          ()      => ipcRenderer.invoke('bond:get_muted'),
    logContactViewed:  (id)    => ipcRenderer.invoke('bond:log_contact_viewed', id),
  },

  // Events from main → renderer
  on: (channel, cb) => {
    const allowed = [
      'pet:state-changed',
      'pet:size-changed',
      'main:open-reminder',
      'main:navigate',
      'main:say-prompt',
      'export:progress',
      'tools:progress',
      'app:update-progress',
      'app:update-state',
      'pet:mood-changed',
      'pet:status-changed',
      'pet:cozy-changed',
      'pet:bond-tier-changed',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});