// src/js/api.js — thin wrappers around window.mp (preload bridge)
const M = window.mp;
if (!M) {
  document.body.innerHTML = '<div style="padding:20px;color:#900">Preload bridge missing. Run via Electron, not a browser.</div>';
  throw new Error('Preload bridge missing');
}

export const api = {
  contacts: {
    list: () => M.contacts.list(),
    get: (id) => M.contacts.get(id),
    create: (input) => M.contacts.create(input),
    update: (id, input) => M.contacts.update(id, input),
    delete: (id) => M.contacts.delete(id),
    uploadAvatar: (id, payload) => M.contacts.uploadAvatar(id, payload),
    readAvatar:   (id)          => M.contacts.readAvatar(id),
    deleteAvatar: (id)          => M.contacts.deleteAvatar(id),
  },
  attributes: {
    list:   (kind, opts) => M.attributes.list(kind, opts || {}),
    create: (input) => M.attributes.create(input),
    update: (id, input) => M.attributes.update(id, input),
    delete: (id) => M.attributes.delete(id),
    deleteMany: (ids) => M.attributes.deleteMany(ids),
  },
  importantDates: {
    list: (contactId) => M.importantDates.list(contactId),
    create: (contactId, input) => M.importantDates.create(contactId, input),
    update: (id, input) => M.importantDates.update(id, input),
    delete: (id) => M.importantDates.delete(id),
  },
  events: {
    list: (opts) => M.events.list(opts || {}),
    listToday: () => M.events.listToday(),
    get: (id) => M.events.get(id),
    create: (input) => M.events.create(input),
    update: (id, input) => M.events.update(id, input),
    delete: (id) => M.events.delete(id),
    deleteMany: (ids) => M.events.deleteMany(ids),
    debugFireDueNow: () => M.events.debugFireDueNow(),
    listFestivals: () => M.events.listFestivals(),
  },
  memorialEvents: {
    list:   (opts)      => M.memorialEvents.list(opts || {}),
    get:    (id)        => M.memorialEvents.get(id),
    create: (input)     => M.memorialEvents.create(input),
    update: (id, input) => M.memorialEvents.update(id, input),
    delete: (id)        => M.memorialEvents.delete(id),
    deleteMany: (ids)   => M.memorialEvents.deleteMany(ids),
    photos: {
      list:   (eventId)         => M.memorialEvents.photos.list(eventId),
      upload: (eventId, payload)=> M.memorialEvents.photos.upload(eventId, payload),
      delete: (photoId)         => M.memorialEvents.photos.delete(photoId),
      read:   (photoId)         => M.memorialEvents.photos.read(photoId),
    },
  },
  reminders: {
    listActive: () => M.reminders.listActive(),
    // Today's reminder view: every event scheduled for today (whether
    // or not the scheduler has fired it yet), with the soft-completion
    // state attached. Drives the "当前提醒" block on the 今日 page.
    listTodayView: () => M.reminders.listTodayView(),
    // Soft-dismiss for today. The pet stops nagging but the queue item
    // (and 今日 page entry) remain visible so the user can still scroll
    // back to confirm what they finished.
    completeForToday: (source, id) => M.reminders.completeForToday(source, id),
    markDone: (source, id) => M.reminders.markDone(source, id),
    snooze: (source, id, minutes) => M.reminders.snooze(source, id, minutes),
  },
  search: {
    query: (q) => M.search.query(q),
  },
  // Bond / cozy / mood readouts. `getFullState` is the composite the 今日
  // page uses (bond + cozy + resolved mood in one round-trip); the rest
  // back the pet window's interactions and the tier-gated menu items.
  bond: {
    getFullState:      () => M.bond.getFullState?.() || Promise.resolve(null),
    getSnapshot:       () => M.bond.getSnapshot?.() || Promise.resolve(null),
    getCozySnapshot:   () => M.bond.getCozySnapshot?.() || Promise.resolve(null),
    getWeeklyBreakdown:() => M.bond.getWeeklyBreakdown?.() || Promise.resolve(null),
    celebrate:         () => M.bond.celebrate?.(),
    legendaryDance:    () => M.bond.legendaryDance?.(),
    setMuted:          (b) => M.bond.setMuted?.(!!b),
    getMuted:          () => M.bond.getMuted?.(),
  },
  pet: {
    getState: () => M.pet.getState(),
    setPosition: (x, y) => M.pet.setPosition(x, y),
    getPosition: () => M.pet.getPosition(),
    showMain: () => M.pet.showMain(),
    openReminder: () => M.pet.openReminder?.() || M.pet.showMain(),
    // Legacy species getters/setters kept as thin wrappers around the new
    // pet_id registry so older callers still compile.
    getSpecies: () => M.pet.getSpecies?.() || M.pet.getCurrent?.(),
    setSpecies: (s) => M.pet.setCurrent?.(s),
    // New frame-based registry.
    list: () => M.pet.list?.() || Promise.resolve([]),
    getCurrent: () => M.pet.getCurrent?.(),
    setCurrent: (id) => M.pet.setCurrent?.(id),
    resolveFrames: (petId, variant, direction) =>
      M.pet.resolveFrames?.(petId, variant, direction),
    getWalkEnabled: () => M.pet.getWalkEnabled(),
    setWalkEnabled: (b) => M.pet.setWalkEnabled(b),
    // Pack import (frame-directory zip — see main/pet_zip_import.js).
    // listInstalled returns registry entries decorated with
    // `source: 'builtIn' | 'imported'`, `origin`, `importedAt`, and
    // `description` so the settings page can render a unified list.
    // importFromZip pops a native picker and resolves to { canceled } or
    // { ok, deduped, pet: { id, name } }.
    listInstalled:   ()      => M.pet.listInstalled?.() || Promise.resolve([]),
    importFromZip:   ()      => M.pet.importFromZip?.(),
    removeImported:  (petId) => M.pet.removeImported?.(petId),
    // Per-pet click / dblclick / idle-loop config (settings page editor;
    // pet window also reads click_variant/dblclick_variant on each click).
    //   get()        → { config, available_variants, pet_id }
    //   save(cfg)    → { ok, config } (validated + filtered against manifest)
    //   getLoopVariants() → { variants: string[] }
    actionsConfig: {
      get:             ()    => M.pet.actionsConfig?.get?.(),
      save:            (cfg) => M.pet.actionsConfig?.save?.(cfg || {}),
      getLoopVariants: ()    => M.pet.actionsConfig?.getLoopVariants?.(),
    },
    // 动作 → 文本绑定. The pet controller calls the same picker every time
    // it starts an action; /settings edits the pool it picks from.
    actionTexts: {
      get:  ()    => M.pet.actionTexts?.get?.() || Promise.resolve({ texts: {}, actions: [], runtime: [] }),
      save: (cfg) => M.pet.actionTexts?.save?.(cfg || {}),
    },
  },
  settings: {
    get: (k) => M.settings.get(k),
    set: (k, v) => M.settings.set(k, v),
  },
  // 文本气泡配置（吃饭提醒 / 休息提醒）。规则由主进程
  // main/pet_bubbles.js 单点定义，这里只做薄封装。
  bubbles: {
    getConfig:      ()     => M.bubbles?.getConfig?.() || Promise.resolve({ rules: [], feedWindows: {} }),
    setEnabled:     (map)  => M.bubbles?.setEnabled?.(map || {}),
    say:            (t)    => M.bubbles?.say?.(t || ''),
    preview:        (r)    => M.bubbles?.preview?.(r || ''),
    force:          (r)    => M.bubbles?.force?.(r || ''),
    getIdleSeconds: ()     => M.bubbles?.getIdleSeconds?.(),
  },
  app: {
    quit: () => M.app.quit(),
    // PIN gate (see main/auth.js). Renderer never sees the salt/hash —
    // only `{ ok: boolean }` round-trips through these wrappers.
    verifyPin: (pin) => M.app.verifyPin(pin),
    setPin:    (pin) => M.app.setPin(pin),
    // 开机自启动. Returns { supported, enabled, active }.
    getAutostart: ()     => M.app.getAutostart(),
    setAutostart: (on)   => M.app.setAutostart(on),
    // 自动更新 (GitHub Releases). 详见 main/app_update.js 的模块注释。
    getUpdateState:   ()     => M.app.getUpdateState(),
    checkUpdate:      ()     => M.app.checkUpdate(),
    setUpdateEnabled: (on)   => M.app.setUpdateEnabled(on),
    downloadUpdate:   ()     => M.app.downloadUpdate(),
    installUpdate:    (opts) => M.app.installUpdate(opts || {}),
    revealInstaller:  (p)    => M.app.revealInstaller(p),
    openExternal:     (url) => M.app.openExternal(url),
  },
  backup: {
    export: () => M.backup.export(),
    import: () => M.backup.import(),
    apply:  (zipPath) => M.backup.apply(zipPath),
  },
  // Memorial album / video export by contact + time range. Material scope
  // is strictly `memorial_events` + `memorial_event_photos`. Underscored
  // name to avoid the ES reserved word `export` in module scope.
  export_: {
    previewFilter: (filter) => M.export_.previewFilter(filter || {}),
    pdf: (payload) => M.export_.pdf(payload || {}),
    docx: (payload) => M.export_.docx(payload || {}),
    mp4: (payload) => M.export_.mp4(payload || {}),
    cancel: (payload) => M.export_.cancel(payload || {}),
  },
  // Video → frames zip tool. Main opens the file picker and save dialog so
  // raw video bytes never have to round-trip through IPC.
  tools: {
    splitVideo:     (opts) => M.tools.splitVideo(opts || {}),
    removeImageBackground: (opts) => M.tools.removeImageBackground(opts || {}),
    cancel:         (payload) => M.tools.cancel(payload || {}),
    revealInFolder: (path) => M.tools.revealInFolder(path),
  },
  on: (channel, cb) => M.on(channel, cb),
};

export function toast(msg, ms = 1800) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'all 200ms';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

export function fmtDate(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Local-time YYYY-MM-DD for today. Used by contact-edit pages as the default
// "event" value when the user adds a list row without picking a date — saves
// stay useful even when the user is in a hurry and skips the date field.
export function todayYmd() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local-time "YYYY-MM-DDTHH:MM" for datetime-local inputs. Same purpose as
// `todayYmd` but for datetime pickers (see toYMD on the comment in the file).
export function nowDatetimeLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Make the whole <input type="date"> / type="time"> / type="datetime-local">
// box open its native picker on click, not only the tiny calendar icon on the
// right. Iterates once over the supplied root (or document) and wires every
// date-shaped input it finds. Re-running on a re-render is safe — handlers
// are idempotent because we replace `onclick` rather than append.
//
// `showPicker()` is supported since Chromium 99 / Electron 15+. We feature-
// detect and silently no-op in older runtimes, where the user still has the
// trailing icon to fall back on.
export function wireDateInputs(root) {
  const scope = root || document;
  const els = scope.querySelectorAll('input[type="date"], input[type="time"], input[type="datetime-local"]');
  for (const el of els) {
    el.onclick = (e) => {
      // Don't fight the user when they're typing into the visible text part
      // (date pickers also have a free-text mode in some locales); only auto-
      // open when the click landed in the calendar-icon gutter, or on an
      // empty input. In practice: always try showPicker() — it's a no-op if
      // the picker is already showing or if the input is unfocused.
      try {
        if (typeof el.showPicker === 'function') {
          el.showPicker();
        }
      } catch (_) {
        // showPicker() rejects if the input is disabled or already showing;
        // both are fine — do nothing.
      }
      // Mark the input as having been opened via click so subsequent focus
      // events don't double-open it on re-renders that reuse the same node.
      el.dataset.datePickerOpened = '1';
    };
    // Belt-and-braces: opening on focus as well, so a Tab into the field also
    // pops the calendar. Skipped if the click handler above already opened it.
    el.onfocus = () => {
      if (el.dataset.datePickerOpened === '1') {
        el.dataset.datePickerOpened = '';
        return;
      }
      try {
        if (typeof el.showPicker === 'function') el.showPicker();
      } catch (_) {}
    };
  }
}

export function fmtDateTime(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

// Compact "NN MM DD HH MM" or "YYYY-MM-DD HH:MM" → local Date. Used by
// list rows to compute "还有 N 天" / "已过期 N 小时" relative strings
// without coupling callers to backend time formats.
function parseDbDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

// Relative-time chip text from a database timestamp. Returns one of:
//   "今天 HH:MM"      — same day
//   "明天 HH:MM"      — next day
//   "昨天 HH:MM"      — previous day
//   "周X HH:MM"       — within 6 days
//   "MM-DD HH:MM"     — same year, beyond
//   "YYYY-MM-DD"      — different year
//   "未知"            — unparseable input
// Treated as a string helper only — no UI logic, just a label.
export function formatRelative(s, now = new Date()) {
  const d = parseDbDate(s);
  if (!d) return '未知';
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target - today) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diffDays === 0) return `今天 ${hm}`;
  if (diffDays === 1) return `明天 ${hm}`;
  if (diffDays === -1) return `昨天 ${hm}`;
  if (diffDays > 1 && diffDays <= 6) {
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `周${wd} ${hm}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
  }
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// "还有 N 天 / N 小时 / N 分钟" countdown from now → date. Returns null
// when the date is in the past or unparseable. Used by the right-side
// time chip on event rows so the user sees "紧迫度" at a glance.
export function countdownTo(d_or_s, now = new Date()) {
  const target = typeof d_or_s === 'string' ? parseDbDate(d_or_s) : d_or_s;
  if (!target) return null;
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return null;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `还有 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `还有 ${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `还有 ${days} 天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `还有 ${months} 个月`;
  const years = Math.floor(days / 365);
  return `还有 ${years} 年`;
}

// Short Chinese weekday-and-time label, used in headers ("今日").
export function dayLabel(d) {
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `周${wd}`;
}

// Emoji glyph for an event category. Stable across releases — the icon set
// stays inside JS so we don't need to ship icon fonts. Falls back to a
// dot glyph for unknown categories.
export function categoryIcon(cat, tagKind) {
  if (cat === 'memorial') return '🎞️';
  if (cat === 'work')     return '💼';
  if (tagKind === 'birthday')    return '🎂';
  if (tagKind === 'anniversary') return '💝';
  if (tagKind === 'festival')    return '🎉';
  return '⏰';
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function firstChar(s) {
  if (!s) return '?';
  return s.trim().charAt(0).toUpperCase();
}

// Deterministic 1..8 palette index from a contact's name. The result is
// stable across renders (no Date.now / Math.random) so a contact always
// shows the same color-strip + avatar tint. Empty / missing names fall back
// to index 1 (the warm-orange default) which matches the legacy `.avatar`
// background. The palette in styles.css is curated to stay distinct at 36px.
export function contactColorIndex(s) {
  const v = (s == null ? '' : String(s)).trim();
  if (!v) return 1;
  let h = 0;
  for (let i = 0; i < v.length; i++) {
    // djb2-ish: fast, good distribution, no need for crypto strength here.
    h = ((h << 5) - h + v.charCodeAt(i)) | 0;
  }
  // Map to 1..8 inclusive (palette size). Using Math.abs to avoid negatives
  // shifting the bucket, then mod 8 + 1.
  return (Math.abs(h) % 8) + 1;
}

// Map an event row to its CSS `data-kind` value, picking the most specific
// category available. Used by every page that renders event cards so the
// color-strip styles in styles.css (`[data-kind=...]`) light up uniformly.
//   1. memorial events outrank everything — they live on their own page
//      and use a dedicated kind label.
//   2. work events next — they're a sibling of memorial.
//   3. tag_kind (birthday/anniversary/festival) when set, so the same
//      selector works on /reminders, /today, and /search.
//   4. everything else (ordinary reminders, one-off notes) → 'general',
//      which falls back to --accent.
export function eventKindAttr(e) {
  if (!e) return 'general';
  if (e.category === 'memorial') return 'memorial';
  if (e.category === 'work')     return 'work';
  if (e.tag_kind === 'birthday')    return 'birthday';
  if (e.tag_kind === 'anniversary') return 'anniversary';
  if (e.tag_kind === 'festival')    return 'festival';
  return 'general';
}

// Single source of truth for "how do we show this contact's name"? Used by
// every page that renders a contact (list, detail, home, today, events,
// search, event_edit). Falls back to "(无名)" for contacts with an empty
// `name` field.
export function displayName(c) {
  return (c && typeof c.name === 'string' && c.name.trim()) || '(无名)';
}

// Photo display. Earlier versions exposed a custom `memorial-photo://`
// scheme handled by main.js, but `default-src 'self'` in index.html CSP
// blocks <img src=…> from loading any non-self protocol — the browser shows
// a broken-image icon even though the protocol handler returns 200. The fix
// is to embed photos as data URLs (base64). They bypass the CSP entirely
// and the browser caches the decoded bitmap on subsequent renders.
//
// `photoDataUrlCache` is a module-level Map<photoId, dataUrl>. The first
// lookup of a given photo IPCs to main and stores the result; subsequent
// lookups are synchronous. Callers can pass through `memorialPhotoUrl()` —
// when given a relative_path it returns the data URL synchronously when
// already cached, otherwise it returns '' and kicks off a background fetch
// that resolves into the cache. The list-page <img> tags render with the
// blank alt attribute until the second tick when the cache populates; the
// lightbox pre-warms entries on open.
const photoDataUrlCache = new Map();
const photoFetchInflight = new Map();

export function getCachedPhotoDataUrl(photoId) {
  return photoDataUrlCache.get(photoId) || '';
}

// Resolve a photoId to a data URL, calling the IPC once and caching. Returns
// a Promise<string>. Callers usually don't await this — they fire-and-forget
// to warm the cache for the next render.
export async function fetchPhotoDataUrl(photoId) {
  if (!photoId) return '';
  if (photoDataUrlCache.has(photoId)) return photoDataUrlCache.get(photoId);
  if (photoFetchInflight.has(photoId)) return photoFetchInflight.get(photoId);
  const p = (async () => {
    try {
      const r = await api.memorialEvents.photos.read(photoId);
      const url = (r && r.data_url) || '';
      if (url) photoDataUrlCache.set(photoId, url);
      return url;
    } catch (e) {
      console.error('fetchPhotoDataUrl failed for', photoId, e);
      return '';
    } finally {
      photoFetchInflight.delete(photoId);
    }
  })();
  photoFetchInflight.set(photoId, p);
  return p;
}

// Caches for photo post-orientation dimensions, returned by the
// `memorial_events:photo_meta` IPC. The editor uses these so that the
// cover-fit math matches what pdfkit draws into the PDF (pdfkit applies
// EXIF orientation transparently via openImage()).
const photoMetaCache = new Map(); // photoId → { width, height }
const photoMetaInflight = new Map(); // photoId → Promise<{width,height}|null>
export async function fetchPhotoMeta(photoId) {
  if (!photoId) return null;
  if (photoMetaCache.has(photoId)) return photoMetaCache.get(photoId);
  if (photoMetaInflight.has(photoId)) return photoMetaInflight.get(photoId);
  const p = (async () => {
    try {
      const r = await api.memorialEvents.photos.meta(photoId);
      if (r && (r.width || r.height)) {
        photoMetaCache.set(photoId, { width: r.width, height: r.height });
        return photoMetaCache.get(photoId);
      }
      return null;
    } catch (e) {
      console.error('fetchPhotoMeta failed for', photoId, e);
      return null;
    } finally {
      photoMetaInflight.delete(photoId);
    }
  })();
  photoMetaInflight.set(photoId, p);
  return p;
}

// Drop the cached entry for a photo — call after a delete so the renderer
// doesn't keep showing the now-stale bytes.
export function invalidatePhotoDataUrl(photoId) {
  if (!photoId) return;
  photoDataUrlCache.delete(photoId);
  photoFetchInflight.delete(photoId);
}

// Contact avatar data-URL cache. Mirrors the photo cache above: the
// `custom_avatar_path` column only stores a relative path (e.g.
// "<contact_id>.jpg") which the renderer can't turn into an <img src=…>
// without a round-trip. We hide that by resolving the path server-side
// and caching the resulting data URL here. Cache key is the contact id.
const avatarDataUrlCache = new Map();
const avatarFetchInflight = new Map();

// Synchronous lookup. Returns the cached data URL or '' when missing.
export function getCachedAvatarDataUrl(contactId) {
  if (!contactId) return '';
  return avatarDataUrlCache.get(contactId) || '';
}

// Async resolver: returns a Promise<string>. First call IPCs to main and
// caches the result; subsequent calls return the cached value.
export async function fetchAvatarDataUrl(contactId) {
  if (!contactId) return '';
  if (avatarDataUrlCache.has(contactId)) return avatarDataUrlCache.get(contactId);
  if (avatarFetchInflight.has(contactId)) return avatarFetchInflight.get(contactId);
  const p = (async () => {
    try {
      const r = await api.contacts.readAvatar(contactId);
      const url = (r && r.data_url) || '';
      if (url) avatarDataUrlCache.set(contactId, url);
      return url;
    } catch (e) {
      console.error('fetchAvatarDataUrl failed for', contactId, e);
      return '';
    } finally {
      avatarFetchInflight.delete(contactId);
    }
  })();
  avatarFetchInflight.set(contactId, p);
  return p;
}

// Fire-and-forget cache warmer. The list pages call this for every row
// before the first render so the second paint shows the avatar without
// further round-trips.
export function warmAvatarCache(contactId) {
  if (!contactId) return;
  if (!avatarDataUrlCache.has(contactId) && !avatarFetchInflight.has(contactId)) {
    fetchAvatarDataUrl(contactId);
  }
}

// Drop the cached entry for a contact — call after upload/delete so the
// renderer doesn't keep showing stale (or, post-delete, freshly uploaded)
// bytes for the same contact id.
export function invalidateAvatarDataUrl(contactId) {
  if (!contactId) return;
  avatarDataUrlCache.delete(contactId);
  avatarFetchInflight.delete(contactId);
}

// Legacy shape compatibility — the row helper `listMemorialEvents` /
// `getMemorialEvent` returns each photo as `{ id, relative_path, ... }`.
// Earlier renderer code passed `relative_path` into `memorialPhotoUrl()`
// and used the result in an <img src=…>. We keep the same function name so
// callers don't need to be rewritten, but the argument is now a photo id
// (we map it through the cache). Any non-id input returns '' and is ignored.
export function memorialPhotoUrl(photoIdOrPath) {
  if (!photoIdOrPath) return '';
  if (photoDataUrlCache.has(photoIdOrPath)) return photoDataUrlCache.get(photoIdOrPath);
  // Trigger a background fetch — the <img> tag will repaint on the next
  // tick once the cache resolves. Callers that need a guaranteed-ready URL
  // should call fetchPhotoDataUrl() and `await` it.
  fetchPhotoDataUrl(photoIdOrPath);
  return '';
}