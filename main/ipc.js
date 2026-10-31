// main/ipc.js — register all ipcMain handlers (sql.js-friendly)
const { ipcMain, app, screen, Menu, dialog, shell, powerMonitor, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const db = require('./db');
const { fmtDateTime, computeNextFireEvent, DEFAULT_ADVANCE_DAYS, importantDateOccurrence } = require('./time_util');
const { validateLunar } = require('./lunar');
const { listFestivals, festivalLabel } = require('./festivals');
const {
  installPetZip, removeImported,
} = require('./pet_zip_import');
const { petRenderSize } = require('./pet_controller');
const { buildPetState } = require('./pet_state');
const albumPdf = require('./album_pdf');
const albumDocx = require('./album_docx');
const PDFDocument = require('pdfkit');
const albumVideo = require('./album_video');
const { verifyPin, hashPin, isValidPinShape } = require('./auth');
const petInteractions = require('./pet_interactions');
const bondEngine = require('./bond_engine');
const cozyEngine = require('./cozy_engine');
const petMoodMod = require('./pet_mood');
const petActionsConfig = require('./pet_actions_config');
const petActionTexts = require('./pet_action_texts');
const petBubbles = require('./pet_bubbles');
// 系统睡眠/唤醒后的桌宠拖拽状态恢复。见 main/pet_resume.js 的说明。
const petResumeMod = require('./pet_resume');
// 桌宠窗口的诊断日志（指针事件、唤醒、拖拽接管）。见 main/pet_diagnostics.js。
const petDiagnostics = require('./pet_diagnostics');
// 唤醒后的"输入通路是否还活着"探测器。见 main/pet_input_probe.js。
const { createInputProbe } = require('./pet_input_probe');
// 最后的手段：杀掉当前进程并重启整个应用。见 main/app_relaunch.js。
const { relaunchApp } = require('./app_relaunch');
// 文本框 catalog (resources/text_boxes) — scanned, not hard-coded.
const petTextBoxes = require('./pet_text_boxes');
const videoFrameSplit = require('./video_frame_split');
// 快速记录窗口（桌宠右键菜单 → 📝 记录）。独立于 PIN 门禁的主窗口。
const quickRecord = require('./quick_record');
const autostart = require('./autostart');
const imageBgRemove = require('./image_bg_remove');
const imageBatchResize = require('./image_batch_resize');
const appUpdate = require('./app_update');
// 日记正文的校验规则（文字块 + 图组），单独成模块便于单独测试。
const { normDiaryContent } = require('./diary_content');

// Tracks in-flight export jobs so the renderer can cancel them via
// `export:cancel`. The value is a mutable record: { killed, outPath? }.
// We don't keep a child handle here because the album modules own the
// child and expose a `cancelCheck()` callback instead.
const activeExportJobs = new Map();

// Same job-cancellation tracking for the video-frame-splitter tool.
// Mutated exactly the same way as activeExportJobs; the renderer only
// ever needs the `killed` flag plus the jobId it gets back from
// `tools:split_video_to_frames`.
const activeToolsJobs = new Map();

// Resolve the name to persist. Accepts legacy first_name/last_name for one
// release cycle so older renderer builds still work after the schema upgrade;
// prefers the new `name` field when present.
function resolveName(input) {
  if (input && typeof input.name === 'string' && input.name.trim()) {
    return input.name.trim();
  }
  const legacy = [input && input.first_name, input && input.last_name]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return legacy || '';
}

// The "every N days" stride. Only meaningful for remind_kind='every_n_days',
// so any other kind stores NULL — that keeps the column honest and stops a
// stale stride from resurfacing if the user switches the repeat type back
// and forth.
function normalizeIntervalDays(v, remindKind) {
  if (remindKind !== 'every_n_days') return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 365);
}

// How many days before the target date an event's reminder starts firing.
// Events keep the historical behaviour (fire on the day itself) unless the
// user explicitly asks for lead time, so the default here is 0 rather than
// the important-dates default of 7.
function normalizeAdvanceInput(v) {
  if (v == null || v === '') return 0;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 365);
}

// Important dates lead time. Absent → a week (the user's "remind me a week
// ahead" default). 0 is a legitimate value and means "only on the day".
function normalizeImportantAdvance(v) {
  if (v == null || v === '') return DEFAULT_ADVANCE_DAYS;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 365);
}

// Teardown callbacks pushed by register(). main.js's before-quit handler
// drains this list, so any module that starts a timer during registration
// gets a single, explicit shutdown path instead of leaking an interval that
// keeps the process alive.
const shutdownFns = [];

function shutdown() {
  while (shutdownFns.length) {
    const fn = shutdownFns.pop();
    try { fn(); } catch (e) { console.error('shutdown hook failed:', e); }
  }
}

function register({ queue, winMain, winPet: initialPetWindow, getWinPet, recreatePetWindow, setPetState, getPetState, setActiveReminder, broadcastPetState, petController, petRegistry }) {
  // The CURRENT pet window, or null when there is none.
  //
  // The pet window can be destroyed and recreated by the wake recovery (the
  // "just restart the pet" recovery — see `recoverPetAfterResume`), so every
  // use of the pet window in this module goes through this helper instead of
  // holding the window that existed when the handlers were registered.
  //
  // It returns null for a missing OR a destroyed window, so the usual
  // `if (!winPet || winPet.isDestroyed()) return;` guard becomes
  // `if (!petWin()) return;`.
  const petWin = () => {
    const w = typeof getWinPet === 'function' ? getWinPet() : initialPetWindow;
    return (w && !w.isDestroyed()) ? w : null;
  };

  // ---- 文本气泡引擎 ----
  // Two responsibilities live here, both of them needing an Electron
  // capability the rule engine deliberately doesn't depend on:
  //
  //   1. Broadcasting. petBubbles has no Electron import, so it hands us a
  //      callback instead of calling webContents.send directly. The pet
  //      window is the only consumer; if it's gone the tick simply no-ops.
  //   2. Idle sampling. The 休息提醒 rule needs "how long has the user been
  //      at the keyboard", which is powerMonitor.getSystemIdleTime() — a
  //      platform query, not a rule concern. Sampling it here keeps
  //      pet_bubbles.js runnable under plain node.
  const broadcastBubble = (payload) => {
    if (petWin()) {
      petWin().webContents.send(petBubbles.BROADCAST_CHANNEL, payload);
    }
  };

  // getSystemIdleTime() counts seconds of *system-wide* input inactivity
  // (keyboard + mouse). That's exactly "坐太久了" from the rule's point of
  // view, and unlike window focus it keeps working while the user is in
  // another app — which is most of a work session.
  const currentIdleSeconds = () => {
    try { return powerMonitor.getSystemIdleTime(); }
    catch (e) { return -1; }
  };

  // The engine owns its own 1s interval. Sampling idle time on the same
  // cadence (rather than per-tick inside the engine) keeps the Electron call
  // out of the rule code path entirely.
  const idleSampler = setInterval(() => {
    petBubbles.setIdleSeconds(currentIdleSeconds());
  }, 15_000);
  petBubbles.setIdleSeconds(currentIdleSeconds());
  petBubbles.start({ broadcast: broadcastBubble });

  // ---- Bond / Cozy / Mood glue ----
  // One-line helper called from existing CRUD handlers so we never forget
  // a dimension. Errors are swallowed because bond tracking is best-effort
  // and must never block user data writes.
  const trackActivity = (kind) => {
    try { petInteractions.trackActivity(db, kind, db.nowStr.bind(db)); } catch {}
  };

  // Trigger a one-shot variant on the pet window if the controller exists
  // and the variant is in the current pet's whitelist. minTier gates the
  // request early so the renderer doesn't need to know bond state.
  const fireVariant = (variant, ms, opts) => {
    if (!petController || !petController.triggerOneShot) return;
    petController.triggerOneShot(variant, ms, opts);
  };

  // Send a one-shot particle to the pet window. char is the emoji/glyph;
  // optional `x/y` lets the renderer anchor it (defaults to center).
  const sendParticle = (char, opts) => {
    if (!petWin()) return;
    petWin().webContents.send('pet:particle', Object.assign({ char }, opts || {}));
  };

  // Recompute bond + cozy + mood and push them to both windows on the
  // `pet:status-changed` channel. Same payload the scheduler's 1s tick
  // emits, so the renderer's repaint path handles both identically and
  // there's no ordering hazard between the two producers.
  const pushPetStatusNow = (petId) => {
    try {
      const id = petId || db.getSetting('pet_id');
      if (!id) return;
      const bond = petInteractions.getBondSnapshot(db, id);
      const cozy = petInteractions.getCozySnapshot(db, id);
      const mood = petInteractions.computeMood(db, petMoodMod.computeMood, queue.activeCount(), id);
      const payload = {
        mood: mood.mood,
        bond_tier: bond.tier,
        bond_value: bond.value,
        tier_label: bond.tier_label,
        tier_floor: bond.tier_floor,
        week_score: bond.weekly_score,
        next_tier: bond.next_tier,
        streak_weeks: bond.streak_weeks,
        cozy: cozy.value,
        cozy_today_peak: cozy.today_peak,
        cozy_today_interactions: cozy.today_interactions,
        lonely_hours: Math.round((cozy.lonely_hours | 0) * 10) / 10,
      };
      if (petWin()) petWin().webContents.send('pet:status-changed', payload);
      if (winMain && !winMain.isDestroyed()) winMain.webContents.send('pet:status-changed', payload);
    } catch (e) {
      console.error('[pushPetStatusNow]', e && e.message ? e.message : e);
    }
  };

  // ---- Contacts ----
  // ---- Contacts ----
  ipcMain.handle('contacts:list', () =>
    db.all('SELECT * FROM contacts WHERE listed = 1 ORDER BY updated_at DESC').map(db.parseContactRow));

  ipcMain.handle('contacts:get', (_e, id) =>
    db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [id])));

  // contacts:create / contacts:update only write basic info now. The
  // likes/taboos/gifts data lives in the contact_attributes table and is
  // managed via the attributes:* handlers below.
  ipcMain.handle('contacts:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    const name = resolveName(input);
    const relationship = (input && typeof input.relationship === 'string' && input.relationship.trim())
      ? input.relationship.trim() : null;
    // Avatar: `icon_kind` is a Lucide-style identifier (e.g. 'user', 'heart',
    // 'briefcase'). `custom_avatar_path` is an absolute filesystem path to a
    // user-uploaded image; null when the user is on the default glyph. Both
    // are optional in `input` and fall back to schema defaults.
    const iconKind = (input && typeof input.icon_kind === 'string' && input.icon_kind.trim())
      ? input.icon_kind.trim() : 'user';
    const customAvatar = (input && typeof input.custom_avatar_path === 'string' && input.custom_avatar_path.trim())
      ? input.custom_avatar_path.trim() : null;
    db.run(
      `INSERT INTO contacts(id, name, relationship, icon_kind, custom_avatar_path,
                            likes_json, taboos_json, gifts_json,
                            listed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', 1, ?, ?)`,
      [id, name, relationship, iconKind, customAvatar, now, now]
    );
    const stored = db.one('SELECT * FROM contacts WHERE id = ?', [id]);
    const parsed = db.parseContactRow(stored);
    db.upsertSearch('contact', id, db.buildContactBody(parsed));
    trackActivity('contact_added');
    return parsed;
  });

  ipcMain.handle('contacts:update', (_e, id, input) => {
    const now = db.nowStr();
    const name = resolveName(input);
    const relationship = (input && typeof input.relationship === 'string' && input.relationship.trim())
      ? input.relationship.trim() : null;
    const iconKind = (input && typeof input.icon_kind === 'string' && input.icon_kind.trim())
      ? input.icon_kind.trim() : 'user';
    const customAvatar = (input && typeof input.custom_avatar_path === 'string' && input.custom_avatar_path.trim())
      ? input.custom_avatar_path.trim() : null;
    db.run(
      `UPDATE contacts SET name=?, relationship=?, icon_kind=?, custom_avatar_path=?, updated_at=? WHERE id=?`,
      [name, relationship, iconKind, customAvatar, now, id]
    );
    const stored = db.one('SELECT * FROM contacts WHERE id = ?', [id]);
    const parsed = db.parseContactRow(stored);
    db.upsertSearch('contact', id, db.buildContactBody(parsed));
    trackActivity('contact_modified');
    return parsed;
  });

  ipcMain.handle('contacts:delete', (_e, id) => {
    // Hard-delete the contact and everything tied to it:
    //   * contact_attributes (likes / taboos / gifts)        — via FK cascade
    //   * important_dates                                    — via FK cascade
    //   * events whose ONLY contact is this one              — manual delete
    //   * search_index rows (contact / event / important_date) — manual
    //   * reminder_acks for those events/dates               — manual
    //   * live reminder queue entries                        — manual
    //   * the per-contact avatar file (if any)               — manual
    //
    // The "only contact" check is forward-compatible with a future
    // event_contacts many-to-many table — see db.deleteContactCascade.
    //
    // `queue` is passed in so the helper can prune active reminders without
    // reaching across modules. `updatePetState` is called afterwards so the
    // pet window's idle/active state reflects the (now smaller) queue.
    deleteContactAvatarFile(id);
    const result = db.deleteContactCascade(id, queue);
    updatePetState({ queue, setPetState, setActiveReminder });
    return result;
  });

  // ---- Contact avatars ----
  // Per-contact uploaded images live under <appData>/SoulDesktopPet/avatars/.
  // The on-disk filename is keyed by the contact id; the renderer retrieves
  // a CSP-friendly data URL via `contacts:avatar_read` so the <img src=…>
  // never has to reference a raw file path. `custom_avatar_path` in the DB
  // stores the relative path so we can find the file later.
  function getAvatarsDir() {
    return path.join(app.getPath('appData'), 'SoulDesktopPet', 'avatars');
  }

  // Resolve the on-disk path for a contact's avatar file. Returns null when
  // the contact has no uploaded avatar (DB column is null) or when the file
  // is missing on disk — both cases are treated identically by the caller.
  function getContactAvatarPath(contactId) {
    const row = db.one(
      'SELECT custom_avatar_path FROM contacts WHERE id = ?',
      [contactId]
    );
    if (!row || !row.custom_avatar_path) return null;
    const rel = String(row.custom_avatar_path).replace(/\\/g, '/');
    if (rel.includes('..') || path.isAbsolute(rel)) return null;
    const full = path.join(getAvatarsDir(), rel);
    if (!fs.existsSync(full)) return null;
    return full;
  }

  // Wipe a contact's avatar file from disk. Silent on missing files so it's
  // safe to call from delete handlers without race-checking existence.
  function deleteContactAvatarFile(contactId) {
    try {
      const full = getContactAvatarPath(contactId);
      if (full) fs.unlinkSync(full);
    } catch (e) {
      console.error('deleteContactAvatarFile failed:', e);
    }
  }

  // Accept an uploaded image and persist it under avatars/<contact_id><ext>.
  // We sanitize the original filename down to just an extension and use the
  // contact id as the stable basename so subsequent uploads overwrite cleanly.
  // The DB stores the *relative* path under avatars/, so the user-data dir
  // can move (e.g. across machines via backup import) without breaking links.
  ipcMain.handle('contacts:upload_avatar', (_e, contactId, input) => {
    if (!contactId) throw new Error('contactId is required');
    if (!input || !input.bytes) throw new Error('photo bytes required');
    if (!db.one('SELECT id FROM contacts WHERE id = ?', [contactId])) {
      throw new Error(`contact not found: ${contactId}`);
    }
    const mime = (input.mime || '').toLowerCase();
    const allowed = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp',
    };
    let ext = allowed[mime];
    if (!ext) {
      // Fall back to the original filename's extension, then to a generic
      // .bin suffix. We never trust the renderer-decided mime alone.
      const guessed = path.extname(input.filename || '').toLowerCase();
      ext = allowed[({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',  '.gif':  'image/gif',
        '.webp': 'image/webp','.bmp':  'image/bmp',
      }[guessed] || '')] || '.bin';
    }
    const avatarsDir = getAvatarsDir();
    fs.mkdirSync(avatarsDir, { recursive: true });
    // Drop any existing avatar file for this contact (different extension or
    // not) so we never accumulate stale images. Best effort — failure is
    // logged but doesn't abort the new upload.
    try {
      const existing = getContactAvatarPath(contactId);
      if (existing) fs.unlinkSync(existing);
    } catch (e) {
      console.error('avatar overwrite cleanup failed:', e);
    }
    const filename = `${contactId}${ext}`;
    const fullPath = path.join(avatarsDir, filename);
    const buf = Buffer.from(input.bytes);
    fs.writeFileSync(fullPath, buf);
    const relPath = path.posix.join(filename);
    const now = db.nowStr();
    db.run(
      `UPDATE contacts SET custom_avatar_path = ?, updated_at = ? WHERE id = ?`,
      [relPath, now, contactId]
    );
    const stored = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [contactId]));
    db.upsertSearch('contact', stored.id, db.buildContactBody(stored));
    trackActivity('avatar_uploaded');
    return stored;
  });

  // Read the contact's avatar (if any) as a base64 data URL so the renderer
  // can drop it straight into <img src=…> without tripping the CSP. Returns
  // { data_url, mime } or null when no avatar is set / the file is missing.
  // Mirrors memorial_events:photo_read so we get the same render behaviour
  // everywhere contact photos appear.
  ipcMain.handle('contacts:avatar_read', (_e, contactId) => {
    if (!contactId) return null;
    const full = getContactAvatarPath(contactId);
    if (!full) return null;
    try {
      const buf = fs.readFileSync(full);
      const mime = ({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif',   '.webp': 'image/webp',  '.bmp': 'image/bmp',
      }[path.extname(full).toLowerCase()] || 'application/octet-stream');
      return { data_url: `data:${mime};base64,${buf.toString('base64')}` , mime };
    } catch (e) {
      console.error('avatar_read failed:', e);
      return null;
    }
  });

  // Drop the avatar file + clear the DB column. The renderer can immediately
  // call contacts:get afterwards and the row will have custom_avatar_path=null.
  ipcMain.handle('contacts:avatar_delete', (_e, contactId) => {
    if (!contactId) throw new Error('contactId is required');
    deleteContactAvatarFile(contactId);
    const now = db.nowStr();
    db.run(
      `UPDATE contacts SET custom_avatar_path = NULL, updated_at = ? WHERE id = ?`,
      [now, contactId]
    );
    const stored = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [contactId]));
    db.upsertSearch('contact', stored.id, db.buildContactBody(stored));
    return stored;
  });

  // ---- Contact attributes (likes / taboos / gifts — global table) ----
  // All likes/taboos/gifts entries live in contact_attributes and are managed
  // through these handlers. The per-contact sub-pages and the three new global
  // top-level pages (/likes, /taboos, /gifts) all funnel through here.
  const ATTR_KINDS = new Set(['like', 'taboo', 'gift']);

  ipcMain.handle('attributes:list', (_e, kind, opts = {}) => {
    if (!ATTR_KINDS.has(kind)) throw new Error(`unknown attribute kind: ${kind}`);
    return db.listAttributes(kind, opts || {});
  });

  ipcMain.handle('attributes:create', (_e, input = {}) => {
    const kind = input.kind;
    if (!ATTR_KINDS.has(kind)) throw new Error(`unknown attribute kind: ${kind}`);
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new Error('description is required');
    if (!input.contact_id) throw new Error('contact_id is required');
    if (!db.one('SELECT id FROM contacts WHERE id = ?', [input.contact_id])) {
      throw new Error(`contact not found: ${input.contact_id}`);
    }
    const event = typeof input.event === 'string' && input.event.trim() ? input.event.trim() : null;
    const id = db.newId();
    const now = db.nowStr();
    db.run(
      `INSERT INTO contact_attributes(id, contact_id, kind, description, event, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.contact_id, kind, description, event, now, now]
    );
    // Sync search_index so the new description is searchable via LIKE.
    const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [input.contact_id]));
    if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    trackActivity('attribute_changed');
    return db.one(
      `SELECT a.*, c.name AS contact_name
         FROM contact_attributes a JOIN contacts c ON c.id = a.contact_id
        WHERE a.id = ?`, [id]
    );
  });

  ipcMain.handle('attributes:update', (_e, id, input = {}) => {
    if (!db.getAttribute(id)) throw new Error(`attribute not found: ${id}`);
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new Error('description is required');
    const event = typeof input.event === 'string' && input.event.trim() ? input.event.trim() : null;
    const now = db.nowStr();
    db.run(
      `UPDATE contact_attributes SET description=?, event=?, updated_at=? WHERE id=?`,
      [description, event, now, id]
    );
    const row = db.one('SELECT contact_id FROM contact_attributes WHERE id = ?', [id]);
    if (row) {
      const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [row.contact_id]));
      if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    }
    trackActivity('attribute_changed');
    return db.one(
      `SELECT a.*, c.name AS contact_name
         FROM contact_attributes a JOIN contacts c ON c.id = a.contact_id
        WHERE a.id = ?`, [id]
    );
  });

  ipcMain.handle('attributes:delete', (_e, id) => {
    const row = db.one('SELECT contact_id FROM contact_attributes WHERE id = ?', [id]);
    db.run('DELETE FROM contact_attributes WHERE id = ?', [id]);
    if (row) {
      const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [row.contact_id]));
      if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    }
    return true;
  });

  // Bulk-delete a set of contact_attributes rows in one round-trip.
  // Returns the number of rows actually deleted. Each affected contact's
  // search_index entry is rebuilt once (after the deletes) instead of once
  // per row, which matters when the renderer is wiping a filtered list of
  // dozens of items from the same contact.
  //
  // The renderer collects ids from the current filtered view and passes
  // them here. We deliberately trust the renderer: ids come from the same
  // DB read the renderer just made, so passing them back is round-trip safe.
  ipcMain.handle('attributes:delete_many', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    // Validate / normalize input. Anything non-string is dropped before it
    // touches SQL — defence in depth against accidental array-shape bugs.
    const safeIds = ids.filter((x) => typeof x === 'string' && x.length > 0);
    if (safeIds.length === 0) return { deleted: 0 };

    const placeholders = safeIds.map(() => '?').join(',');
    // Capture affected contact_ids BEFORE deleting so we can rebuild the
    // search index for each affected contact exactly once.
    const affectedContactIds = Array.from(new Set(
      db.all(
        `SELECT DISTINCT contact_id FROM contact_attributes WHERE id IN (${placeholders})`,
        safeIds
      ).map((r) => r.contact_id).filter(Boolean)
    ));
    db.run(
      `DELETE FROM contact_attributes WHERE id IN (${placeholders})`,
      safeIds
    );
    for (const cid of affectedContactIds) {
      const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [cid]));
      if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    }
    return { deleted: safeIds.length };
  });

  // Bulk-delete a set of events in one round-trip. Mirrors
  // attributes:delete_many — ids are trusted (round-trip from the same
  // DB read), search_index + reminder_acks + live reminder queue are all
  // pruned in bulk instead of one round-trip per row.
  ipcMain.handle('events:delete_many', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    const safeIds = ids.filter((x) => typeof x === 'string' && x.length > 0);
    if (safeIds.length === 0) return { deleted: 0 };

    const placeholders = safeIds.map(() => '?').join(',');
    // Wipe per-event side-tables BEFORE deleting the events themselves so
    // a crash mid-flight doesn't leave dangling search/ack rows.
    db.run(
      `DELETE FROM search_index WHERE kind = 'event' AND ref_id IN (${placeholders})`,
      safeIds
    );
    db.run(
      `DELETE FROM reminder_acks WHERE source = 'event' AND source_id IN (${placeholders})`,
      safeIds
    );
    if (queue && typeof queue.remove === 'function') {
      for (const id of safeIds) queue.remove('event', id);
    }
    db.run(`DELETE FROM events WHERE id IN (${placeholders})`, safeIds);

    // Pet state may have changed (queue is shorter) — push the updated
    // state to the renderer so the pet icon doesn't keep an idle "REMINDER"
    // glow after the queue empties.
    updatePetState({ queue, setPetState, setActiveReminder });
    return { deleted: safeIds.length };
  });

  // ---- Important dates ----
  ipcMain.handle('important_dates:list', (_e, contact_id) =>
    db.all('SELECT * FROM important_dates WHERE contact_id = ? ORDER BY month, day', [contact_id]));

  ipcMain.handle('important_dates:create', (_e, contact_id, input) => {
    const id = db.newId();
    const now = db.nowStr();
    // advance_days: how many days before the date the reminder starts
    // firing. Defaults to a week — the user asked for birthdays and
    // anniversaries to nag early. remind_enabled lets the user keep the
    // record but silence the nagging.
    const advanceDays = normalizeImportantAdvance(input.advance_days);
    const remindEnabled = input.remind_enabled === false || input.remind_enabled === 0 ? 0 : 1;
    db.run(
      `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                   remind_time, advance_days, remind_enabled,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, contact_id, input.label, input.day, input.month,
       input.year || null, input.kind || 'custom',
       input.remind_time || '09:00', advanceDays, remindEnabled, now, now]
    );
    db.upsertSearch('important_date', id, `${input.label} ${input.kind || ''}`);
    trackActivity('important_date_added');
    return db.one('SELECT * FROM important_dates WHERE id = ?', [id]);
  });

  ipcMain.handle('important_dates:update', (_e, id, input) => {
    const now = db.nowStr();
    const advanceDays = normalizeImportantAdvance(input.advance_days);
    const remindEnabled = input.remind_enabled === false || input.remind_enabled === 0 ? 0 : 1;
    db.run(
      `UPDATE important_dates SET label=?, day=?, month=?, year=?, kind=?,
                                 remind_time=?, advance_days=?, remind_enabled=?,
                                 updated_at=? WHERE id=?`,
      [input.label, input.day, input.month, input.year || null,
       input.kind || 'custom', input.remind_time || '09:00',
       advanceDays, remindEnabled, now, id]
    );
    db.upsertSearch('important_date', id, `${input.label} ${input.kind || ''}`);
    return db.one('SELECT * FROM important_dates WHERE id = ?', [id]);
  });

  ipcMain.handle('important_dates:delete', (_e, id) => {
    db.run('DELETE FROM important_dates WHERE id = ?', [id]);
    db.deleteSearch('important_date', id);
    return true;
  });

  // ---- Events ----
  // Categories: 'general' (the default "提醒日期" page), 'memorial' (回忆事件),
  // 'work' (工作事件). Filtering by category is optional — without it the
  // handler returns all categories (used by contact_detail and search).
  const EVENT_CATEGORIES = new Set(['general', 'memorial', 'work']);

  ipcMain.handle('events:list', (_e, opts = {}) => {
    // Memorial events live in their own table now (see memorial_events:*).
    // The legacy `events` table no longer carries category='memorial' rows;
    // short-circuit so any stale call returns an empty list instead of
    // surfacing reminder state for events the UI has retired.
    if (opts.category === 'memorial') return [];
    let sql = 'SELECT * FROM events WHERE 1=1';
    const args = [];
    if (opts.contact_id) { sql += ' AND contact_id = ?'; args.push(opts.contact_id); }
    if (opts.from) { sql += ' AND (next_fire_at IS NULL OR next_fire_at >= ?)'; args.push(opts.from); }
    if (opts.to) { sql += ' AND (next_fire_at IS NULL OR next_fire_at <= ?)'; args.push(opts.to); }
    if (opts.category && EVENT_CATEGORIES.has(opts.category)) {
      sql += ' AND category = ?'; args.push(opts.category);
    }
    // tag_kind filter (used by 提醒日期 list filters):
    //   - 'birthday' / 'anniversary' / 'festival' — match that exact value
    //   - 'none' — only events without a tag_kind (user-created untagged)
    //   - 'any_tagged' — anything where tag_kind IS NOT NULL
    //   - absent/empty — no filter
    if (opts.tag_kind === 'none') {
      sql += ' AND tag_kind IS NULL';
    } else if (opts.tag_kind === 'any_tagged') {
      sql += ' AND tag_kind IS NOT NULL';
    } else if (opts.tag_kind && EVENT_TAG_KINDS.has(opts.tag_kind)) {
      sql += ' AND tag_kind = ?';
      args.push(opts.tag_kind);
    }
    // Two-level ordering: 未完成事件在前（按即将到来的时间升序），
    // 已完成的单次事件（active=0 或 next_fire_at IS NULL）沉底。
    // "已完成"的定义：单次事件被触发后会被 scheduler 置为 active=0 +
    // next_fire_at=NULL（main/scheduler.js）。提醒关闭的一次性事件虽然
    // active=1 但也 next_fire_at=NULL，按同样规则沉底，避免过期的
    // remind_date 把它们顶到列表最前面。
    sql += ` ORDER BY
      (CASE WHEN remind_kind = 'one_time' AND (active = 0 OR next_fire_at IS NULL) THEN 1 ELSE 0 END) ASC,
      COALESCE(next_fire_at, remind_date, created_at) ASC`;
    return db.all(sql, args);
  });

  ipcMain.handle('events:list_today', () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today_date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today_start = `${today_date} 00:00:00`;
    const today_end = `${today_date} 23:59:59`;
    return db.all(
      `SELECT * FROM events
       WHERE active = 1 AND (
         (remind_kind = 'one_time' AND remind_date = ?)
         OR (next_fire_at BETWEEN ? AND ?)
       )
       ORDER BY COALESCE(next_fire_at, remind_date) ASC`,
      [today_date, today_start, today_end]);
  });

  ipcMain.handle('events:get', (_e, id) =>
    db.one('SELECT * FROM events WHERE id = ?', [id]));

  // Tag kinds: 'birthday' / 'anniversary' / 'festival' — or null/empty for
  // untyped events. Determines whether the title is a free-text label
  // (生日 / 纪念日) or a built-in festival code (节日).
  const EVENT_TAG_KINDS = new Set(['birthday', 'anniversary', 'festival']);
  const FESTIVAL_CODES = new Set(listFestivals().map((f) => f.code));

  ipcMain.handle('events:list_festivals', () => listFestivals());

  ipcMain.handle('events:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    // Category defaults to 'general'; reject unknown values so a typo can't
    // hide an event from every page.
    const category = EVENT_CATEGORIES.has(input.category) ? input.category : 'general';
    // Memorial events have their own table + handlers now. Reject any
    // attempt to write category='memorial' here so the UI is forced through
    // the new memorial_events:* channels.
    if (category === 'memorial') throw new Error('请使用新建回忆事件页面');
    // Tag kind is no longer settable from the new-event form. The renderer
    // never sends it. We accept it from internal callers (festival auto-
    // create) but never from the form.
    let tagKind = null;
    if (input.tag_kind && EVENT_TAG_KINDS.has(input.tag_kind)) {
      tagKind = input.tag_kind;
      if (tagKind === 'festival' && !FESTIVAL_CODES.has(input.title)) {
        throw new Error('节日类型必须选择内置节日');
      }
    }
    // Title is no longer required from the user — auto-fill from contact name
    // (with the tag_kind label, e.g. "刘杰的生日") or a generic placeholder
    // so the row always has a non-empty display label.
    let title = (typeof input.title === 'string' ? input.title.trim() : '');
    if (!title) {
      if (input.contact_id) {
        const c = db.one('SELECT name FROM contacts WHERE id = ?', [input.contact_id]);
        if (c && c.name) {
          const suffix = tagKind === 'birthday'    ? '生日'
                       : tagKind === 'anniversary' ? '纪念日'
                       : tagKind === 'festival'    ? '节日'
                       : '提醒';
          title = `${c.name}的${suffix}`;
        }
      }
      if (!title) title = '新建提醒';
    }
    // Lunar fields are accepted only when both are present; reject invalid
    // (month, day) pairs up front so the user gets immediate feedback.
    let lunarMonth = null, lunarDay = null;
    if (input.lunar_month != null && input.lunar_day != null) {
      const v = validateLunar(input.lunar_month, input.lunar_day);
      if (!v.ok) throw new Error(v.reason || '农历日期无效');
      lunarMonth = Number(input.lunar_month);
      lunarDay = Number(input.lunar_day);
    }
    const nf = computeNextFireEvent({
      ...input,
      title,
      remind: !!input.remind,
      active: true,
      next_fire_at: null,
      last_fired_at: null,
      lunar_month: lunarMonth,
      lunar_day: lunarDay,
    }, new Date());
    const intervalDays = normalizeIntervalDays(input.interval_days, input.remind_kind);
    const advanceDays = normalizeAdvanceInput(input.advance_days);
    db.run(
      `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                          remind_time, remind_date, next_fire_at, last_fired_at, active,
                          category, tag_kind, lunar_month, lunar_day,
                          interval_days, advance_days,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1,
               ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.contact_id || null, title, input.description || null,
       input.remind ? 1 : 0, input.remind_kind || 'none',
       input.remind_time || '09:00', input.remind_date || null,
       nf ? fmtDateTime(nf) : null,
       category, tagKind, lunarMonth, lunarDay,
       intervalDays, advanceDays, now, now]
    );
    db.upsertSearch('event', id, `${title} ${input.description || ''} ${input.remind_kind || ''} ${category} ${tagKind || ''}`);
    trackActivity('event_created');
    return db.one('SELECT * FROM events WHERE id = ?', [id]);
  });

  ipcMain.handle('events:update', (_e, id, input) => {
    const now = db.nowStr();
    const category = EVENT_CATEGORIES.has(input.category) ? input.category : 'general';
    if (category === 'memorial') throw new Error('请使用新建回忆事件页面');
    let tagKind = null;
    if (input.tag_kind && EVENT_TAG_KINDS.has(input.tag_kind)) {
      tagKind = input.tag_kind;
      if (tagKind === 'festival' && !FESTIVAL_CODES.has(input.title)) {
        throw new Error('节日类型必须选择内置节日');
      }
    }
    // Title may not be cleared by the user. If the form sends an empty
    // string, fall back to the existing row's title.
    let title = (typeof input.title === 'string' ? input.title.trim() : '');
    if (!title) {
      const existing = db.one('SELECT title FROM events WHERE id = ?', [id]);
      title = (existing && existing.title) || '新建提醒';
    }
    let lunarMonth = null, lunarDay = null;
    if (input.lunar_month != null && input.lunar_day != null) {
      const v = validateLunar(input.lunar_month, input.lunar_day);
      if (!v.ok) throw new Error(v.reason || '农历日期无效');
      lunarMonth = Number(input.lunar_month);
      lunarDay = Number(input.lunar_day);
    }
    const nf = computeNextFireEvent({
      ...input,
      title,
      remind: !!input.remind,
      active: true,
      next_fire_at: null,
      last_fired_at: null,
      lunar_month: lunarMonth,
      lunar_day: lunarDay,
    }, new Date());
    const intervalDays = normalizeIntervalDays(input.interval_days, input.remind_kind);
    const advanceDays = normalizeAdvanceInput(input.advance_days);
    db.run(
      `UPDATE events SET contact_id=?, title=?, description=?, remind=?, remind_kind=?,
                         remind_time=?, remind_date=?, next_fire_at=?, active=1,
                         category=?, tag_kind=?, lunar_month=?, lunar_day=?,
                         interval_days=?, advance_days=?, updated_at=?
       WHERE id=?`,
      [input.contact_id || null, title, input.description || null,
       input.remind ? 1 : 0, input.remind_kind || 'none',
       input.remind_time || '09:00', input.remind_date || null,
       nf ? fmtDateTime(nf) : null,
       category, tagKind, lunarMonth, lunarDay,
       intervalDays, advanceDays, now, id]
    );
    db.upsertSearch('event', id, `${title} ${input.description || ''} ${input.remind_kind || ''} ${category} ${tagKind || ''}`);
    return db.one('SELECT * FROM events WHERE id = ?', [id]);
  });

  ipcMain.handle('events:delete', (_e, id) => {
    db.run('DELETE FROM events WHERE id = ?', [id]);
    db.deleteSearch('event', id);
    return true;
  });

  ipcMain.handle('events:debug_fire_due_now', () => {
    db.run(
      `UPDATE events SET next_fire_at = ?
       WHERE active = 1 AND remind = 1 AND remind_kind != 'none'`,
      [db.nowStr()]
    );
    return true;
  });

  // ---- Memorial events ----
  // Independent from the reminder-style events table. Records "what
  // happened, when, with whom" — no remind/remind_kind/lunar/next_fire
  // fields. Photo metadata lives in memorial_event_photos; the actual
  // bytes are written to disk by photos_upload and served to the renderer
  // via the `memorial-photo://` protocol registered in main/main.js.

  // Photo storage lives under <appData>/SoulDesktopPet/photos/<event_id>/.
  function getPhotosDir() {
    return path.join(app.getPath('appData'), 'SoulDesktopPet', 'photos');
  }
  // Strip filesystem-hostile characters and clamp the basename before we
  // trust it as a filename on disk.
  function sanitizeFilename(name) {
    const stripped = String(name || '')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 120);
    return stripped || 'photo';
  }
  function guessExtFromMime(m) {
    if (!m) return '';
    return ({
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp',
      'image/heic': '.heic', 'image/heif': '.heic',
    }[String(m).toLowerCase()] || '');
  }

  // Replace the contacts associated with a memorial event. Drops the old
  // rows and inserts the new set in one transaction-ish block; unknown
  // contact ids are silently skipped (the FK would error out otherwise).
  function setMemorialEventContacts(eventId, contactIds) {
    db.run('DELETE FROM memorial_event_contacts WHERE memorial_event_id = ?', [eventId]);
    const now = db.nowStr();
    for (const cid of contactIds) {
      if (!db.one('SELECT id FROM contacts WHERE id = ?', [cid])) continue;
      db.run(
        `INSERT OR IGNORE INTO memorial_event_contacts(memorial_event_id, contact_id, created_at)
         VALUES (?, ?, ?)`,
        [eventId, cid, now]
      );
    }
  }

  // Trim a free-text form input. Non-strings and whitespace-only strings
// collapse to null so the DB doesn't store meaningless blanks and the
// search_index body stays tight.
function normFreeText(s) {
  return (typeof s === 'string' && s.trim()) ? s.trim() : null;
}

// Validate the diary's mixed text/image document.
//
// The document is a list of text blocks and galleries (a gallery holds the
// photos that share one insertion point). The rules live in
// main/diary_content.js so they can be checked on their own.

// Accept both YYYY-MM-DD and YYYY-MM-DD HH:MM[:SS] from the renderer
  // (datetime-local produces the former shape, the form fills the seconds
  // before posting). Anything else throws so the user sees a clear error
  // instead of a silently-shifted occurrence date.
  function normalizeOccurredAt(input, fallback) {
    if (typeof input !== 'string' || !input.trim()) {
      return fallback || db.nowStr();
    }
    const trimmed = input.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) return `${trimmed} 00:00:00`;
    const dateTime = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (!dateTime) throw new Error('事件发生时间格式无效');
    const [, y, mo, d, h, mi, s = '00'] = dateTime;
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
  }

  ipcMain.handle('memorial_events:list', (_e, opts = {}) =>
    db.listMemorialEvents(opts || {}));

  ipcMain.handle('memorial_events:get', (_e, id) => db.getMemorialEvent(id));

  ipcMain.handle('memorial_events:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    const kind = (input && (input.kind === 'first_time' || input.kind === 'other'))
      ? input.kind : 'other';
    const title = (typeof input.title === 'string' && input.title.trim())
      ? input.title.trim() : '回忆事件';
    // 5 free-text fields, all nullable. Each is independently trimmed and
    // stored only if non-empty; an empty string from the form becomes NULL
    // so search_index doesn't include noise.
    const place      = normFreeText(input && input.place);
    const food       = normFreeText(input && input.food);
    const outfit     = normFreeText(input && input.outfit);
    const activities = normFreeText(input && input.activities);
    const notes      = normFreeText(input && input.notes);
    const occurredAt = normalizeOccurredAt(input && input.occurred_at);
    // The diary background style id (one of the six presets) and the
    // mixed text/image document. Both are optional; an absent key means
    // "leave it unset" rather than "clear it".
    const background = (input && typeof input.background === 'string' && input.background)
      ? input.background : null;
    const content = normDiaryContent(input && input.content);
    const contactIds = Array.isArray(input && input.contact_ids)
      ? Array.from(new Set(input.contact_ids.filter((x) => typeof x === 'string' && x.length)))
      : [];
    db.run(
      `INSERT INTO memorial_events(id, kind, title,
                                   place, food, outfit, activities, notes,
                                   occurred_at, background, content,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, title,
       place, food, outfit, activities, notes,
       occurredAt, background, content, now, now]
    );
    setMemorialEventContacts(id, contactIds);
    db.upsertSearch('memorial_event', id,
      [title, place, food, outfit, activities, notes, kind, occurredAt]
        .filter(Boolean).join(' '));
    trackActivity('memorial_recorded');
    return db.getMemorialEvent(id);
  });

  ipcMain.handle('memorial_events:update', (_e, id, input) => {
    const now = db.nowStr();
    const cur = db.one('SELECT * FROM memorial_events WHERE id = ?', [id]);
    if (!cur) throw new Error('memorial_event not found');
    const kind = (input && (input.kind === 'first_time' || input.kind === 'other'))
      ? input.kind : cur.kind;
    const title = (typeof input.title === 'string' && input.title.trim())
      ? input.title.trim() : cur.title;
    // Per-field "fall back to existing value if the form didn't send this
    // key" semantics. The form always sends all 5 so the typeof check
    // doubles as a defensive guard for partial updates from future callers.
    const place      = (input && Object.prototype.hasOwnProperty.call(input, 'place'))
      ? normFreeText(input.place) : cur.place;
    const food       = (input && Object.prototype.hasOwnProperty.call(input, 'food'))
      ? normFreeText(input.food) : cur.food;
    const outfit     = (input && Object.prototype.hasOwnProperty.call(input, 'outfit'))
      ? normFreeText(input.outfit) : cur.outfit;
    const activities = (input && Object.prototype.hasOwnProperty.call(input, 'activities'))
      ? normFreeText(input.activities) : cur.activities;
    const notes      = (input && Object.prototype.hasOwnProperty.call(input, 'notes'))
      ? normFreeText(input.notes) : cur.notes;
    const occurredAt = normalizeOccurredAt(input && input.occurred_at, cur.occurred_at);
    // Background + content: an absent key keeps the existing value; an
    // explicit null clears it. The background is a free-form preset id
    // (the renderer falls back to the default for unknown ids), the
    // content is the mixed text/image document.
    const background = (input && Object.prototype.hasOwnProperty.call(input, 'background'))
      ? (typeof input.background === 'string' && input.background ? input.background : null)
      : cur.background;
    const content = (input && Object.prototype.hasOwnProperty.call(input, 'content'))
      ? normDiaryContent(input.content)
      : cur.content;
    const contactIds = Array.isArray(input && input.contact_ids)
      ? Array.from(new Set(input.contact_ids.filter((x) => typeof x === 'string' && x.length)))
      : db.all('SELECT contact_id FROM memorial_event_contacts WHERE memorial_event_id = ?', [id])
          .map((r) => r.contact_id);
    db.run(
      `UPDATE memorial_events
          SET kind=?, title=?,
              place=?, food=?, outfit=?, activities=?, notes=?,
              occurred_at=?, background=?, content=?, updated_at=?
        WHERE id=?`,
      [kind, title,
       place, food, outfit, activities, notes,
       occurredAt, background, content, now, id]
    );
    setMemorialEventContacts(id, contactIds);
    db.upsertSearch('memorial_event', id,
      [title, place, food, outfit, activities, notes, kind, occurredAt]
        .filter(Boolean).join(' '));
    trackActivity('memorial_recorded');
    return db.getMemorialEvent(id);
  });

  ipcMain.handle('memorial_events:delete', (_e, id) => {
    // Drop the on-disk photo directory before the DB rows. CASCADE on the
    // photo FK removes the metadata rows automatically.
    try {
      fs.rmSync(path.join(getPhotosDir(), id), { recursive: true, force: true });
    } catch (e) {
      console.error('memorial_events:delete photo dir rm failed:', e);
    }
    db.run('DELETE FROM memorial_events WHERE id = ?', [id]);
    db.deleteSearch('memorial_event', id);
    return true;
  });

  ipcMain.handle('memorial_events:delete_many', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    const safeIds = ids.filter((x) => typeof x === 'string' && x.length);
    if (safeIds.length === 0) return { deleted: 0 };
    for (const id of safeIds) {
      try {
        fs.rmSync(path.join(getPhotosDir(), id), { recursive: true, force: true });
      } catch (e) {
        console.error('memorial_events:delete_many photo dir rm failed:', e);
      }
      db.deleteSearch('memorial_event', id);
    }
    const placeholders = safeIds.map(() => '?').join(',');
    db.run(`DELETE FROM memorial_events WHERE id IN (${placeholders})`, safeIds);
    return { deleted: safeIds.length };
  });

  // ---- Memorial event photos ----
  ipcMain.handle('memorial_events:photos_list', (_e, eventId) =>
    db.listPhotosForMemorialEvent(eventId));

  ipcMain.handle('memorial_events:photos_upload', (_e, eventId, input) => {
    if (!input || !input.bytes) throw new Error('photo bytes required');
    if (!db.one('SELECT id FROM memorial_events WHERE id = ?', [eventId])) {
      throw new Error(`memorial_event not found: ${eventId}`);
    }
    const eventPath = path.join(getPhotosDir(), eventId);
    fs.mkdirSync(eventPath, { recursive: true });
    const safeBase = sanitizeFilename(input.filename || 'photo');
    const ext = path.extname(safeBase) || guessExtFromMime(input.mime);
    const baseName = safeBase.replace(/\.[^.]+$/, '') || 'photo';
    let filename = `${baseName}${ext}`;
    let n = 1;
    // Disambiguate if the user picks two files with the same basename
    // ("photo.jpg", "photo (1).jpg" both stripped to "photo").
    while (fs.existsSync(path.join(eventPath, filename))) {
      filename = `${baseName}-${n}${ext}`;
      n += 1;
    }
    const fullPath = path.join(eventPath, filename);
    const buf = Buffer.from(input.bytes);
    fs.writeFileSync(fullPath, buf);
    const id = db.newId();
    const now = db.nowStr();
    const relPath = path.posix.join('photos', eventId, filename);
    db.run(
      `INSERT INTO memorial_event_photos(id, memorial_event_id, relative_path, original_name, mime, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, eventId, relPath, input.filename || filename, input.mime || null, buf.length, now]
    );
    trackActivity('memorial_recorded');
    return db.one(
      `SELECT id, relative_path, original_name, mime, size_bytes, created_at
         FROM memorial_event_photos WHERE id = ?`,
      [id]
    );
  });

  ipcMain.handle('memorial_events:photos_delete', (_e, photoId) => {
    const row = db.one('SELECT * FROM memorial_event_photos WHERE id = ?', [photoId]);
    if (!row) return false;
    const full = path.join(getPhotosDir(), row.memorial_event_id, path.basename(row.relative_path));
    try { fs.unlinkSync(full); } catch {}
    db.run('DELETE FROM memorial_event_photos WHERE id = ?', [photoId]);
    // Tidy: remove the parent dir if it's now empty (best effort).
    try {
      const dir = path.dirname(full);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {}
    return true;
  });

  // Read a single photo's content as a base64 data URL. We deliberately
  // avoid a custom `memorial-photo://` scheme because CSP `default-src 'self'`
  // refuses to load images from any non-self protocol — the <img> tag falls
  // back to the broken-image icon. Data URLs sidestep the CSP entirely.
  //
  // Returns: { data_url, mime } or null if the row is missing. The renderer
  // turns `data_url` into <img src=…>. Each photo is a few MB at typical
  // upload sizes — fine for an in-memory base64 round-trip, and the browser
  // caches the decoded bitmap so re-renders don't re-read.
  ipcMain.handle('memorial_events:photo_read', (_e, photoId) => {
    const row = db.one('SELECT * FROM memorial_event_photos WHERE id = ?', [photoId]);
    if (!row) return null;
    const full = path.join(getPhotosDir(), row.memorial_event_id, path.basename(row.relative_path));
    if (!fs.existsSync(full)) return null;
    try {
      const buf = fs.readFileSync(full);
      const mime = row.mime || ({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.heic': 'image/heic', '.heif': 'image/heic',
      }[path.extname(full).toLowerCase()] || 'application/octet-stream');
      return { data_url: `data:${mime};base64,${buf.toString('base64')}`, mime };
    } catch (e) {
      console.error('photo_read failed:', e);
      return null;
    }
  });

  // ---- Photo EXIF metadata (post-orientation size) ------------------------
  // Used by the album editor to keep visual coordinates consistent with
  // the PDF renderer. pdfkit's openImage() transparently applies EXIF
  // orientation and returns the post-orientation width/height. The editor
  // uses the same numbers via this IPC so cover-fit math matches PDF
  // output for portrait phone shots.
  ipcMain.handle('memorial_events:photo_meta', (_e, photoId) => {
    const row = db.one('SELECT * FROM memorial_event_photos WHERE id = ?', [photoId]);
    if (!row) return null;
    const full = path.join(getPhotosDir(), row.memorial_event_id, path.basename(row.relative_path));
    if (!fs.existsSync(full)) return null;
    try {
      // Use a fresh PDFDocument just to call openImage() and read its
      // metadata. We never write any pages; the document is collected
      // into a buffer that we immediately discard. Calling openImage
      // mutates the document state but does not require a page to exist.
      const probe = new PDFDocument({ autoFirstPage: false });
      const img = probe.openImage(full);
      const w = img.width || 0;
      const h = img.height || 0;
      // No direct orientation tag from pdfkit, but width/height are
      // already post-orientation so the renderer can use them as-is.
      // The editor marks these dims as the "true" ones for cover-fit.
      return { width: w, height: h };
    } catch (e) {
      console.error('photo_meta failed:', e);
      return null;
    }
  });

  // ---- Search ----
  ipcMain.handle('search:query', (_e, q) => {
    q = (q || '').trim();
    if (!q) return { contacts: [], events: [], memorial_events: [], important_dates: [] };
    const like = `%${q}%`;
    const contacts = db.all(
      `SELECT * FROM contacts WHERE listed=1 AND (
        name LIKE ? OR relationship LIKE ?
        OR EXISTS (SELECT 1 FROM contact_attributes a
                   WHERE a.contact_id = contacts.id AND a.description LIKE ?)
      )`,
      [like, like, like]
    ).map(db.parseContactRow);
    const events = db.all('SELECT * FROM events WHERE title LIKE ? OR description LIKE ?', [like, like]);
    // Memorial events are searched by title/description only (kind lives in a
    // separate column we don't text-match). The renderer doesn't show
    // contact names on the search-result card, so we don't need the join
    // table here.
    const memorial = db.all(
      `SELECT * FROM memorial_events
        WHERE title LIKE ? OR place LIKE ? OR food LIKE ?
           OR outfit LIKE ? OR activities LIKE ? OR notes LIKE ?`,
      [like, like, like, like, like, like]
    );
    const dates = db.all('SELECT * FROM important_dates WHERE label LIKE ?', [like]);
    return { contacts, events, memorial_events: memorial, important_dates: dates };
  });

  // ---- Reminders ----
  // list_active returns every queue item, including items the user already
  // marked complete for today (with `dismissed_for_today: true`). The
  // 今日 page uses this distinction to render completed items in a
  // visually muted style, so the user can still scroll back to see what
  // they finished. Callers that only want non-dismissed items should use
  // `pet:get_state` (which carries the active head) or filter client-side.
  ipcMain.handle('reminders:list_active', () => queue.list());

  // Today view: returns EVERY event scheduled for today (whether or not
  // the scheduler has fired it yet), decorated with the soft-completion
  // state. The 今日 page uses this so the "当前提醒" block is the
  // authoritative list of what the user has to deal with today, not just
  // whatever the scheduler happens to have already nagged about. Pending
  // items surface above completed ones so attention still flows to what
  // needs doing.
  ipcMain.handle('reminders:list_today_view', () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today_date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today_start = `${today_date} 00:00:00`;
    const today_end = `${today_date} 23:59:59`;
    const today_prefix = today_date; // YYYY-MM-DD

    // Pull every event that should fire today. The filter is intentionally
    // NOT gated on `active = 1` — a one_time event gets flipped to
    // `active = 0` the moment the scheduler fires it, but the 今日 page
    // still needs to show the event (now with a "已完成" tag) so the user
    // can scroll back and confirm what they finished. The same is true
    // for periodic events the user is looking at mid-day.
    //
    // We match on three independent criteria, deduped by id:
    //   1. one_time with remind_date = today        (covers pre-fire AND
    //                                                post-fire one_times)
    //   2. any kind whose next_fire_at falls in today's window
    //                                                (covers periodic +
    //                                                daily still scheduled
    //                                                for later today)
    //   3. any kind whose last_fired_at falls in today's window
    //                                                (covers one_times
    //                                                that already fired
    //                                                and lost their
    //                                                next_fire_at)
    const events = db.all(
      `SELECT * FROM events
        WHERE (
          (remind_kind = 'one_time' AND remind_date = ?)
          OR (next_fire_at BETWEEN ? AND ?)
          OR (last_fired_at BETWEEN ? AND ?)
        )
        ORDER BY COALESCE(next_fire_at, remind_date) ASC`,
      [today_date, today_start, today_end, today_start, today_end]
    );

    // Look up the soft-completion state from reminder_acks. Restrict to
    // today's acks so that periodic events finished yesterday don't
    // re-mark as completed for the new day.
    const ackedTodayIds = new Set();
    if (events.length > 0) {
      const ids = events.map((e) => e.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.all(
        `SELECT source_id FROM reminder_acks
          WHERE source = 'event' AND acked_at LIKE ?
            AND source_id IN (${placeholders})`,
        [today_prefix + '%', ...ids]
      );
      for (const r of rows) ackedTodayIds.add(r.source_id);
    }

    // Also surface any queue item that the scheduler fired today but that
    // is NOT in the events list above — covers the edge case where the
    // event was completed (active=0) right after firing, or where the
    // event is a one_time that already got auto-deactivated. The queue
    // item still represents work the user was told about.
    const queueItems = queue.list();
    const eventIdsToday = new Set(events.map((e) => e.id));
    const extras = [];
    for (const q of queueItems) {
      if (q.source !== 'event') continue;
      if (eventIdsToday.has(q.source_id)) continue;
      // Only include queue items that fired today.
      if (q.next_fire_at && String(q.next_fire_at).slice(0, 10) === today_date) {
        extras.push(q);
      }
    }

    // Important dates inside their advance window (a birthday that is 5
    // days out, say). These are the rows the scheduler pushes every day
    // during the window, so they belong in the same list as the events.
    // The queue already holds today's fired set, so we prefer the queue
    // entries (they carry the computed days_left) and fall back to
    // recomputing the window for dates the scheduler hasn't reached yet.
    const importantDates = [];
    {
      const now = new Date();
      const idRows = db.all('SELECT * FROM important_dates WHERE remind_enabled = 1');
      const byId = new Map(idRows.map((r) => [r.id, r]));
      const queued = queueItems.filter((q) => q.source === 'important_date');

      // Which important dates the user already acknowledged TODAY. The
      // queue path reads this off the queue entry, but the fallback path
      // below covers dates the scheduler hasn't fired yet (the app started
      // after the reminder time) — those still need today's ack state,
      // otherwise an acknowledged date would reappear as pending.
      const ackedImportantToday = new Set();
      {
        const rows = db.all(
          `SELECT source_id FROM reminder_acks
            WHERE source = 'important_date' AND acked_at LIKE ?`,
          [today_prefix + '%']
        );
        for (const r of rows) ackedImportantToday.add(r.source_id);
      }

      for (const q of queued) {
        const row = byId.get(q.source_id);
        if (!row) continue;
        importantDates.push({
          source: 'important_date',
          source_id: q.source_id,
          title: q.title,
          description: null,
          contact_id: row.contact_id,
          contact_name: q.contact_name || null,
          next_fire_at: q.next_fire_at || today_start,
          remind_kind: null,
          category: null,
          tag_kind: null,
          kind: row.kind,
          dismissed_for_today: !!q.dismissed_for_today,
          days_left: q.days_left != null ? q.days_left : null,
          advance_days: row.advance_days,
        });
      }
      // Dates whose window is open but which the scheduler hasn't fired
      // yet (e.g. the app started after the reminder time passed today).
      for (const row of idRows) {
        if (queued.some((q) => q.source_id === row.id)) continue;
        const occ = importantDateOccurrence(row, now);
        if (!occ) continue;
        let titleStr = row.label;
        if (row.year) {
          const age = now.getFullYear() - row.year;
          if (age > 0) titleStr = `${row.label} · ${age}岁`;
        }
        const c = row.contact_id
          ? db.one('SELECT name FROM contacts WHERE id = ?', [row.contact_id])
          : null;
        importantDates.push({
          source: 'important_date',
          source_id: row.id,
          title: titleStr,
          description: null,
          contact_id: row.contact_id,
          contact_name: c && c.name ? c.name : null,
          next_fire_at: today_start,
          remind_kind: null,
          category: null,
          tag_kind: null,
          kind: row.kind,
          dismissed_for_today: ackedImportantToday.has(row.id),
          days_left: occ.days_left,
          advance_days: occ.advance_days,
        });
      }
    }

    const decorate = (r) => ({
      source: 'event',
      source_id: r.source_id,
      title: r.title,
      description: r.description || null,
      contact_id: r.contact_id,
      contact_name: r.contact_name || null,
      next_fire_at: r.next_fire_at || null,
      remind_kind: r.remind_kind || null,
      category: r.category || 'general',
      // Tag kind rides along so the renderer's 当前提醒 cards can pick a
      // category-specific glyph (🎂/💝/🎉) instead of the generic ⏰ —
      // matching the per-event list page below. The renderer still falls
      // back to ⏰ for tag_kind-less events (work / plain reminders).
      tag_kind: r.tag_kind || null,
      dismissed_for_today: !!r.dismissed_for_today,
    });
    const view = [
      ...events.map((e) => decorate({
        source_id: e.id,
        title: e.title,
        description: e.description,
        contact_id: e.contact_id,
        contact_name: (() => {
          if (!e.contact_id) return null;
          const c = db.one('SELECT name FROM contacts WHERE id = ?', [e.contact_id]);
          return c ? c.name : null;
        })(),
        next_fire_at: e.next_fire_at,
        remind_kind: e.remind_kind,
        category: e.category,
        tag_kind: e.tag_kind,
        dismissed_for_today: ackedTodayIds.has(e.id),
      })),
      ...extras.map(decorate),
      ...importantDates,
    ];

    // Pending items first, then completed — eye lands on what still needs
    // attention before drifting down into today's accomplishments.
    view.sort((a, b) => {
      if (a.dismissed_for_today !== b.dismissed_for_today) {
        return a.dismissed_for_today ? 1 : -1;
      }
      // Within a group, the soonest deadline comes first. A date that is
      // counting down ("还有 3 天") sorts ahead of a plain event.
      const aDays = a.days_left != null ? a.days_left : null;
      const bDays = b.days_left != null ? b.days_left : null;
      if (aDays !== bDays) {
        if (aDays === null) return 1;
        if (bDays === null) return -1;
        return aDays - bDays;
      }
      return (a.next_fire_at || '').localeCompare(b.next_fire_at || '');
    });

    return view;
  });

  // Mark a reminder as "completed for today" — the pet stops nagging, but
  // the queue item (and the 今日 page entry) remain visible. This is the
  // soft-dismiss action: the user said they handled it, but might want to
  // revisit it later in the day to confirm. A periodic reminder's next
  // occurrence tomorrow is still scheduled normally; the ack row we write
  // (next_fire_at = NULL) does not block future scanAndFire invocations.
  //
  // Works whether or not the event is in the live queue — the renderer
  // can mark a 今日-view item as completed even before the scheduler has
  // fired it. The reminder_acks row is the source of truth for "已确认
  // 完成"; the queue entry is just a transient nag mirror.
  ipcMain.handle('reminders:complete_for_today', (_e, source, sourceId) => {
    return completeReminderForToday(
      { queue, setPetState, setActiveReminder, broadcastPetState },
      source, sourceId,
    );
  });

  // Backwards-compatible: older renderer builds still call mark_done. Same
  // semantic now (soft-dismiss for today) so behavior is consistent across
  // builds. Anything that actually wants to hard-remove a reminder should
  // delete the underlying event/important_date directly.
  ipcMain.handle('reminders:mark_done', (_e, source, sourceId) => {
    queue.dismissForToday(source, sourceId);
    db.run(
      `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
       VALUES (?, ?, ?, NULL)`,
      [source, sourceId, db.nowStr()]
    );
    updatePetState({ queue, setPetState, setActiveReminder });
    broadcastPetState();
    trackActivity('reminder_completed');
    return true;
  });

  ipcMain.handle('reminders:snooze', (_e, source, sourceId, minutes) => {
    // A non-numeric `minutes` would make the new fire time an Invalid Date,
    // and `fmtDateTime` would then write a garbage string into
    // `events.next_fire_at` — the reminder becomes unschedulable with no
    // visible error. Coerce and bound it instead.
    const mins = Math.round(Number(minutes));
    if (!Number.isFinite(mins) || mins <= 0 || mins > 24 * 60) return false;
    const newFire = new Date(Date.now() + mins * 60_000);
    const newFireStr = fmtDateTime(newFire);
    // A snooze is NOT a "complete" — it just pushes the next fire time.
    // Earlier builds also INSERTed into reminder_acks here, which
    // reminders:list_today_view then read as "已 ack / 已完成" and visually
    // muted the chip, even though the user only asked to be nagged again
    // later. Filter on next_fire_at window instead, which already excludes
    // snoozed rows from today's view.
    if (source === 'event') {
      db.run('UPDATE events SET next_fire_at = ? WHERE id = ?', [newFireStr, sourceId]);
    }
    queue.remove(source, sourceId);
    updatePetState({ queue, setPetState, setActiveReminder });
    // Same flush reasoning as reminders:complete_for_today — guarantee
    // the pet window flips to NORMAL in a single message so the user
    // doesn't see the shake animation linger after they hit "稍后".
    broadcastPetState();
    trackActivity('reminder_snoozed');
    return true;
  });

  // ---- Pet / settings / windowing ----
  ipcMain.handle('pet:get_state', () => {
    // The same payload the `pet:state-changed` broadcast carries — one
    // builder (main/pet_state.js) so the initial read and the broadcasts
    // cannot drift apart.
    return buildPetState({ petState: getPetState(), queue });
  });

  ipcMain.handle('settings:get', (_e, key) => db.getSetting(key));
  ipcMain.handle('settings:set', (_e, key, value) => { db.setSetting(key, value); return true; });

  // ---- App PIN gate ----
  // The renderer must never see the salt/hash. verifyPin runs scrypt
  // server-side and returns only { ok: boolean }; the UI treats any false
  // (including shape errors) as "wrong PIN" so a tampered renderer can't
  // enumerate "did I get the shape wrong?".
  ipcMain.handle('app:verify_pin', (_e, pin) => {
    const stored = db.getSetting('app_pin_hash');
    if (!stored) return { ok: false };
    if (!isValidPinShape(pin)) return { ok: false };
    return { ok: verifyPin(pin, stored) };
  });

  ipcMain.handle('app:set_pin', (_e, newPin) => {
    if (!isValidPinShape(newPin)) {
      return { ok: false, reason: 'shape' };
    }
    try {
      db.setSetting('app_pin_hash', hashPin(newPin));
      return { ok: true };
    } catch (e) {
      console.error('app:set_pin failed:', e);
      return { ok: false, reason: 'hash' };
    }
  });

  ipcMain.handle('pet:set_position', (_e, x, y) => {
    // `setPosition` throws "conversion failure" on a fractional or NaN
    // coordinate, so coerce to a finite integer before using it.
    const px = Math.round(Number(x));
    const py = Math.round(Number(y));
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
    db.setSetting('pet_x', String(px));
    db.setSetting('pet_y', String(py));
    if (petWin()) {
      petWin().setPosition(px, py);
    }
    return true;
  });

  ipcMain.handle('pet:get_position', () => {
    // Read the LIVE window position, not the persisted setting.
    //
    // The renderer uses this to measure the drag grab offset against the
    // window's top-left corner. `db.getSetting('pet_x')` is only updated by
    // the window's `moved` event, so it can lag behind the real position —
    // and after a suspend/resume the OS may have moved the window without
    // the renderer having caught up. The live `getPosition()` is
    // authoritative.
    if (petWin()) {
      const [x, y] = petWin().getPosition();
      return { x, y };
    }
    // Fall back to the persisted position when the window is gone.
    return {
      x: parseInt(db.getSetting('pet_x') || '200', 10),
      y: parseInt(db.getSetting('pet_y') || '200', 10),
    };
  });

  // ---- Pet registry (frame-based) ----
  // The renderer asks for the list of installed pets, the current petId, and
  // resolves an animation variant to a concrete frame list. Frames are
  // returned as file:// URLs the renderer can feed straight to <img src>.
  if (petRegistry) {
    ipcMain.handle('pet:list', () => petRegistry.list());
    ipcMain.handle('pet:get_current', () => {
      // Legacy migration: if pet_id is unset but pet_species is set (one of
      // the old hard-coded species), fall back to the first registered pet
      // and persist the new key on the way out.
      if (!db.getSetting('pet_id') && db.getSetting('pet_species')) {
        const first = petRegistry.list()[0];
        if (first) {
          db.setSetting('pet_id', first.id);
          if (petController && petController.petId !== first.id) {
            petController.petId = first.id;
          }
          return first.id;
        }
      }
      return db.getSetting('pet_id') || (petRegistry.list()[0] && petRegistry.list()[0].id) || null;
    });
    ipcMain.handle('pet:set_current', (_e, id) => {
      if (petController && typeof petController.setPetId === 'function') {
        petController.setPetId(id);
      } else {
        db.setSetting('pet_id', id);
      }
      return true;
    });
    ipcMain.handle('pet:resolve_frames', (_e, petId, variant, direction) => {
      try {
        return petRegistry.resolveFrames({ petId, variant, direction });
      } catch (err) {
        console.error('[ipc] pet:resolve_frames failed:', err.message);
        throw err;
      }
    });
    // Renderer asks for the current pet's render size so it can set the
    // --size-w / --size-h / --sprite-h CSS variables before the first frame
    // paints (avoids a 220×220 → actual-size flash on launch). Returns the
    // scaled-to-render-size dimensions, not the raw manifest.defaultSize — so
    // the renderer's CSS variables match the window the main process just
    // created. `spriteH` is the pet's own height; `h` is the taller window
    // that includes the bubble headroom.
    ipcMain.handle('pet:get_current_size', () => {
      if (!petRegistry) return petRenderSize(null);
      const persisted = db.getSetting('pet_id');
      const first = petRegistry.list()[0];
      const id = (persisted && petRegistry.getManifest(persisted)) ? persisted
        : (first && first.id);
      if (!id) return petRenderSize(null);
      const m = petRegistry.getManifest(id);
      return petRenderSize(m && m.defaultSize);
    });
  }

  // ---- Pet import (frame-directory zip) ----
  // Users ship a zip whose contents already match the on-disk layout of
  // `resources/pets/default/`: variant directories (`default/`,
  // `reminder/`, `walking.right/`, `walking.left/`) each holding
  // `<name>_NNN_NNNN.png` frames. `pet_zip_import.installPetZip` writes a
  // matching `manifest.json` into `<userData>/SoulDesktopPet/pets/imported-<hash>/`
  // so the existing PetRegistry can pick it up unchanged.
  //
  // Handlers:
  //   pet:list_installed  — registry entries decorated with origin /
  //                          importedAt / description (now read straight
  //                          off the manifest.json the importer wrote).
  //   pet:import_from_zip — opens a picker, installs the zip, rescan.
  //   pet:remove_imported — drops an imported directory; if the user was
  //                          using it, switches to the first built-in
  //                          first.

  // userData parent — `installPetZip` and `removeImported` each append
  // `pets/` themselves, so this is the directory the existing
  // `PetRegistry.init({ userDataPath })` was told about.
  function getPetsUserDataPath() {
    return path.join(app.getPath('appData'), 'SoulDesktopPet');
  }

  // First built-in pet id, or null when no built-in exists. Imported pets
  // (those living under the user-data pets dir) are skipped on purpose —
  // determined by location, not by the `imported-` id prefix, so a
  // promoted-to-built-in pet is correctly treated as built-in.
  function pickFirstBuiltinId() {
    if (!petRegistry) return null;
    const all = petRegistry.list();
    const builtin = all.find((p) => !petRegistry.isImported(p.id));
    return builtin ? builtin.id : null;
  }

  // ---- orphan pruning ----
  // Deleting a pet used to remove only its folder, leaving its bond /
  // cozy / ritual / play-log rows and per-pet settings in the database.
  // Those rows then lingered forever, because the pet id was no longer
  // known to anything — even the settings UI had no way to find them.
  //
  // This sweeps the database for pet ids that no longer resolve to an
  // installed pet and deletes their data. It runs once per boot, after
  // the registry has been populated, so it also cleans up rows left by
  // pets deleted before this cleanup existed.
  //
  // Returns the list of pruned ids (for logging).
  function pruneOrphanedPetData() {
    if (!petRegistry) return [];
    const known = new Set(petRegistry.list().map((p) => p.id));
    if (known.size === 0) return []; // nothing installed — don't wipe the DB

    // Collect the distinct pet ids referenced anywhere in pet-scoped data.
    const referenced = new Set();
    const collect = (sql) => {
      try {
        for (const r of db.all(sql)) {
          if (r && r.pet_id) referenced.add(r.pet_id);
        }
      } catch (e) {
        // Table doesn't exist on this schema — skip it.
      }
    };
    collect('SELECT DISTINCT pet_id FROM bond_strength');
    collect('SELECT DISTINCT pet_id FROM cozy_state');
    collect('SELECT DISTINCT pet_id FROM weekly_ritual');
    collect('SELECT DISTINCT pet_id FROM play_log');

    // Per-pet settings keys carry the id after a known prefix.
    for (const prefix of [
      'pet_actions_config:',
      'pet_action_texts:',
      'pet_bubbles_state:',
      'auto_log:',
      'today_event:',
      'today_memorial:',
    ]) {
      try {
        for (const r of db.all('SELECT key FROM settings WHERE key LIKE ?', [prefix + '%'])) {
          const id = r.key.slice(prefix.length);
          if (id) referenced.add(id);
        }
      } catch (e) {
        console.error('[pet] orphan scan failed for prefix', prefix, e);
      }
    }

    const orphans = [...referenced].filter((id) => !known.has(id));
    for (const id of orphans) {
      try {
        const res = db.deletePetData(id);
        console.log(`[pet] pruned orphaned pet data for '${id}':`, JSON.stringify(res.summary));
      } catch (e) {
        console.error(`[pet] failed to prune orphaned pet data for '${id}':`, e && e.message);
      }
    }
    return orphans;
  }

  // Imported manifests already carry description/origin/importedAt — read
  // them straight from disk so the /pets UI doesn't have to second-guess
  // what the registry is showing. Built-ins get a stub object so the UI
  // renders them with the same shape.
  //
  // Whether a pet is deletable is decided by WHERE it lives (the registry
  // knows the real root dir), NOT by whether its id starts with
  // `imported-`. A pet that was imported and later promoted to a built-in
  // keeps its `imported-…` id while sitting in `resources/pets/`, and
  // guessing from the id wrongly offers it a delete button — the delete
  // then tries to remove a user-data path that doesn't exist and silently
  // fails.
  function decoratePetEntry(pet) {
    if (petRegistry && petRegistry.isImported(pet.id)) {
      // Read the manifest from the pet's real root dir. The id is not
      // guaranteed to equal the directory name (a built-in promoted from
      // an import keeps its old id), so derive the path from the
      // registry rather than guessing `pets/<id>/`.
      const rootDir = petRegistry.getRootDir(pet.id);
      let description = '';
      let origin = null;
      let importedAt = null;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
        if (m && typeof m.description === 'string') description = m.description;
        if (m && (m.origin === 'zip' || m.origin === 'folder')) origin = m.origin;
        if (m && typeof m.importedAt === 'string') importedAt = m.importedAt;
      } catch {}
      return { ...pet, description, source: 'imported', origin, importedAt };
    }
    return {
      ...pet,
      description: '',
      source: 'builtIn',
      origin: null,
      importedAt: null,
    };
  }

  ipcMain.handle('pet:list_installed', () => {
    if (!petRegistry) return [];
    return petRegistry.list().map(decoratePetEntry);
  });

  // Push import progress to the renderer. One-way channel, same shape as
  // `tools:progress` / `export:progress`: { phase, processed, total }.
  // `processed` is the number of frames finished so far, `total` the
  // number of frames in the pack — the renderer renders that as "N / total".
  function pushPetImportProgress(payload) {
    if (!winMain || winMain.isDestroyed()) return;
    try {
      winMain.webContents.send('pet:import-progress', {
        phase: (payload && payload.phase) || 'processing',
        processed: (payload && typeof payload.processed === 'number') ? payload.processed : 0,
        total: (payload && typeof payload.total === 'number') ? payload.total : 0,
        current: (payload && payload.current) || null,
      });
    } catch (e) {
      console.error('[pet] push import progress failed:', e);
    }
  }

  ipcMain.handle('pet:import_from_zip', async () => {
    if (!petRegistry) throw new Error('pet registry unavailable');
    const pick = await dialog.showOpenDialog(winMain, {
      title: '上传桌宠压缩包',
      properties: ['openFile'],
      filters: [{ name: '桌宠压缩包', extensions: ['zip'] }],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
      return { canceled: true };
    }
    const zip = pick.filePaths[0];
    const installed = await installPetZip(zip, getPetsUserDataPath(), pushPetImportProgress);
    petRegistry.rescan();
    // Surface the action count so the renderer can tell the user
    // "已识别 N 个动作" instead of just "已导入: name". Without this,
    // the only feedback that the new dynamic-discovery logic worked is
    // "the dropdown has more options than before" — easy to miss.
    let variantCount = 0;
    try {
      const m = petRegistry.getManifest(installed.pet.id);
      if (m && m.variants && typeof m.variants === 'object') {
        variantCount = Object.keys(m.variants).length;
      }
    } catch {}
    return {
      ok: true,
      deduped: !!installed.deduped,
      pet: { id: installed.pet.id, name: installed.pet.name },
      variantCount,
      // How the frames were treated on import: `processed` frames went
      // through the background cutout, `skipped` frames were already
      // transparent and were passed through untouched.
      cutout: installed.cutout || { processed: 0, skipped: 0 },
      // Total frame count of the pack — the renderer pairs it with the
      // progress messages to show "N / total".
      frames: installed.frames || { total: 0 },
    };
  });

  ipcMain.handle('pet:remove_imported', (_e, petId) => {
    if (!petRegistry) throw new Error('pet registry unavailable');
    if (typeof petId !== 'string' || !petId) {
      throw new Error('非导入桌宠不可删除');
    }
    // Guard on location, not on the `imported-` id prefix. A pet that
    // was imported and then promoted to a built-in still carries the
    // `imported-…` id but lives in `resources/pets/` — deleting it must
    // be refused, otherwise we'd try to remove a user-data path that
    // doesn't exist and the UI would show the row again unchanged.
    if (!petRegistry.isImported(petId)) {
      throw new Error('非导入桌宠不可删除');
    }
    let switchedTo = null;
    // If the user is currently using the pet they're about to delete, we
    // need to switch them off it first so the pet window doesn't end up
    // referencing a non-existent pet. setPetId() broadcasts pet:pet-changed
    // which the pet window already handles by clearing its frame cache.
    if (petController && petController.petId === petId) {
      const fallback = pickFirstBuiltinId();
      if (fallback && fallback !== petId) {
        petController.setPetId(fallback);
        switchedTo = fallback;
      } else {
        // No built-in to fall back to: refuse the deletion rather than
        // leaving the renderer pointing at a dead pet.
        throw new Error('当前正在使用该桌宠且没有内置备选，请先切换到其他桌宠');
      }
    }
    // Delete the pet's real root dir rather than assuming the directory
    // is named after the id — the registry knows where it actually lives.
    const rootDir = petRegistry.getRootDir(petId);
    // Wipe the pet's database rows (bond / cozy / ritual / play log) and
    // its per-pet settings (action bindings, bubble texts, bubble state)
    // BEFORE removing the folder. Deleting the folder alone used to leave
    // all of that behind, so the app kept affinity scores, cozy meters
    // and configs for a pet that no longer existed. Cleaning the DB first
    // means a failure here aborts the whole delete rather than leaving a
    // half-deleted pet.
    let dataSummary = null;
    try {
      dataSummary = db.deletePetData(petId);
    } catch (e) {
      console.error('[pet] deletePetData failed:', e && e.message);
      throw new Error('删除桌宠数据失败：' + ((e && e.message) || e));
    }
    removeImported(petId, getPetsUserDataPath(), rootDir);
    petRegistry.rescan();
    return { ok: true, removed: petId, switchedTo, data: dataSummary };
  });

  // ---- Pet species / walk toggle ----
  // Legacy handlers kept for backwards compatibility with renderers that still
  // call getSpecies/setSpecies. They map onto the new pet_id machinery: any
  // of the four old species values picks the first installed pet.
  ipcMain.handle('pet:get_species', () => {
    if (petRegistry) {
      const cur = db.getSetting('pet_id') || (petRegistry.list()[0] && petRegistry.list()[0].id);
      // Map back to a legacy token so older renderers don't break visually.
      if (cur) return 'cat';
    }
    const v = db.getSetting('pet_species');
    return (v === 'dog' || v === 'bird' || v === 'miku') ? v : 'cat';
  });
  ipcMain.handle('pet:set_species', (_e, species) => {
    if (petController && petRegistry) {
      const cur = db.getSetting('pet_id') || (petRegistry.list()[0] && petRegistry.list()[0].id);
      if (cur) petController.setPetId(cur);
    }
    return true;
  });
  ipcMain.handle('pet:get_walk_enabled', () =>
    db.getSetting('pet_walk_enabled') !== '0');
  ipcMain.handle('pet:set_walk_enabled', (_e, enabled) => {
    if (petController && typeof petController.setEnabled === 'function') {
      petController.setEnabled(!!enabled);
    }
    return true;
  });

  // ---- 开机自启动 ----
  // `supported` is false in dev builds: process.execPath points at the
  // Electron binary there, which must never be registered as a startup
  // entry. The renderer uses this to disable the checkbox and explain why,
  // instead of showing a toggle that silently does nothing.
  ipcMain.handle('app:get_autostart', () => ({
    supported: autostart.isSupported(),
    // Report what the user asked for, not just what's in the registry — a
    // failed write should stay visible as "on" so the next launch retries,
    // rather than the checkbox snapping back to "off" on every page visit.
    enabled: db.getSetting(autostart.SETTING_KEY) !== '0',
    // Lets the UI warn when the intent is on but the OS entry is missing
    // (e.g. the user removed it in Task Manager).
    active: autostart.isEnabled(),
  }));
  ipcMain.handle('app:set_autostart', (_e, enabled) => {
    const want = !!enabled;
    const r = autostart.setEnabled(want);
    if (r.ok) {
      // Only commit the stored intent once the registry write actually
      // succeeded, so a failure doesn't get mistaken for a user opt-out.
      db.setSetting(autostart.SETTING_KEY, want ? '1' : '0');
    }
    return {
      ok: r.ok,
      supported: r.supported,
      enabled: r.ok ? want : db.getSetting(autostart.SETTING_KEY) !== '0',
    };
  });
  // ---- 自动更新（更新源为 GitHub Releases）----
  //
  // 逻辑本身全在 main/app_update.js 里，这里只做三件事：把结果转成渲染
  // 进程能直接用的形状、把下载进度推回去、以及在安装前弹一次确认框。
  //
  // 安装确认放在主进程而不是渲染进程，是因为下一步 app.quit() 会直接
  // 关掉窗口——渲染进程没机会再弹任何东西。把确认放在这里，能保证用户
  // 一定看到「即将重启安装」这个提示。

  // 往主窗口推消息时统一走这里，而不是直接用上面闭包里捕获的 winMain。
  // 那个引用是 register() 调用时的快照，main.js 的 `activate` 事件
  // （macOS 关掉全部窗口后再点图标）会重建 winMain，此后闭包里的引用就指向
  // 一个已销毁的窗口。浏览器窗口发送是异步的，发给已销毁的窗口不会立刻
  // 报错，而是稍后以 "Object has been destroyed" 的形式冒出来——很难定位。
  const pushToMain = (channel, payload) => {
    // BrowserWindow.getAllWindows() 是当前真实存活的窗口，不受快照影响。
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send(channel, payload);
      } catch (e) {
        // 竞态：检查完 isDestroyed 到 send 之间窗口可能刚好被关掉。忽略即可，
        // 推送本来就是 best-effort 的（渲染进程下次轮询会拿到完整状态）。
      }
    }
  };

  // 状态轮询入口：设置页每次渲染、下载进度回调都读它。
  ipcMain.handle('app:get_update_state', () => appUpdate.publicState(db));

  // 手动检查。返回值 { ok, hasUpdate, info, reason }——reason 是中文原因，
  // 渲染进程直接显示，不需要自己再翻译一遍错误。
  ipcMain.handle('app:check_update', async () => {
    const r = await appUpdate.checkForUpdate(db);
    return { ...r, state: appUpdate.publicState(db) };
  });

  // 打开/关闭每日自动检查。打开时立刻补一次检查，不用等下一个 24 小时。
  // setEnabled 内部会回调 main.js 注册的钩子来重启每日调度器，定时器
  // 的生命周期只在 startDailyCheck 里管一处。
  ipcMain.handle('app:set_update_enabled', (_e, enabled) => {
    const r = appUpdate.setEnabled(db, !!enabled);
    return { ...r, state: appUpdate.publicState(db) };
  });

  // 下载安装包。下载进度走 `app:update-progress` 单向推送，模式与
  // tools:progress 一致（见 preload 的 allowed 列表）。
  ipcMain.handle('app:download_update', async () => {
    const r = await appUpdate.downloadUpdate(db, (p) => {
      pushToMain('app:update-progress', p);
    });
    return { ...r, state: appUpdate.publicState(db) };
  });

  // 启动安装器并退出重装。confirm=false 时直接静默重装（供「跳过确认」
  // 这类显式调用），默认走确认框。
  ipcMain.handle('app:install_update', async (_e, payload) => {
    const opts = payload || {};
    const p = opts.path;
    if (!p) return { ok: false, reason: '没有可安装的文件' };

    // 只允许安装自己刚下载到临时目录里的那个文件。渲染进程是潜在的
    // 攻击面（页面被注入脚本的话），不该由它指定任意路径给 spawn。
    // 这个校验把可执行文件的来源限制在 %TEMP%\SoulDesktopPet-update\。
    const tmpRoot = path.join(os.tmpdir(), 'SoulDesktopPet-update');
    const resolved = path.resolve(p);
    if (resolved !== path.join(tmpRoot, path.basename(resolved))) {
      return { ok: false, reason: '安装文件路径不合法' };
    }

    if (opts.confirm !== false) {
      const { response } = await dialog.showMessageBox(winMain, {
        type: 'info',
        buttons: ['立即更新', '暂不更新'],
        defaultId: 0,
        cancelId: 1,
        title: '更新 SoulDesktopPet',
        message: `将更新到 ${opts.version || '新版本'}`,
        detail:
          '更新程序会先关闭 SoulDesktopPet，安装完成后再自动打开。\n\n' +
          '你的联系人、提醒、回忆和照片都保存在应用数据目录，升级不会删除它们。',
      });
      if (response !== 0) return { ok: false, reason: null, canceled: true };
    }

    const r = appUpdate.installAndRelaunch(resolved);
    return { ...r, state: appUpdate.publicState(db) };
  });

  // 在文件管理器里定位安装包，供用户选择手动安装。
  ipcMain.handle('app:reveal_installer', (_e, payload) => {
    const p = (payload || {}).path;
    if (!p) return false;
    const tmpRoot = path.join(os.tmpdir(), 'SoulDesktopPet-update');
    const resolved = path.resolve(p);
    if (resolved !== path.join(tmpRoot, path.basename(resolved))) return false;
    return appUpdate.revealInstaller(resolved);
  });

  // 在系统浏览器打开 URL。渲染进程是潜在的注入面，限定 http/https 是为了
  // 防止它被诱导去打开 file:// 或本地自定义协议（那等价于任意文件访问）。
  ipcMain.handle('app:open_external', (_e, url) => {
    const s = String(url || '');
    if (!/^https?:\/\//i.test(s)) return { ok: false };
    return { ok: shell.openExternal(s) };
  });

  // 把状态变化推给渲染进程，这样每日检查在后台发现新版本时，设置页即使
  // 没重新渲染也能看到提示条。
  appUpdate.onStatus(() => {
    pushToMain('app:update-state', appUpdate.publicState(db));
  });

  ipcMain.handle('pet:set_paused', (_e, ms) => {
    // `setPaused` writes `Date.now() + ms` into the settings table. A
    // non-numeric `ms` would persist the string "NaN", and every later
    // comparison against it is false — silently breaking the pause.
    const dur = Math.round(Number(ms));
    if (!Number.isFinite(dur) || dur < 0) return false;
    if (petController && typeof petController.setPaused === 'function') {
      petController.setPaused(dur);
    }
    return true;
  });

  // Renderer signals back when a one-shot frame sequence has finished
  // playing (FrameAnimator.onEnded). The controller uses this to drop
  // back to `default` and re-roll the next loop action by probability
  // (default 70% / movement 15% / other 15%). This replaces the old
  // behavior where the controller only resumed after `actionUntil`
  // elapsed — now the loop continues as soon as the last frame paints.
  ipcMain.handle('pet:action_ended', () => {
    if (petController && typeof petController.handleActionEnded === 'function') {
      petController.handleActionEnded();
    }
    return true;
  });

  // One-shot variant (replaces the old Miku-only wave/sing): emit an
  // action-changed IPC for `ms` milliseconds, then the renderer restores
  // the underlying state automatically.
  ipcMain.handle('pet:trigger_action', (_e, action, ms) => {
    // A NaN `ms` would make `Math.max(durationMs, ms)` NaN inside
    // triggerOneShot, and the renderer would then be told the one-shot lasts
    // NaN milliseconds. Coerce and bound it.
    const dur = Math.round(Number(ms));
    const oneShotMs = Number.isFinite(dur) && dur > 0 ? dur : 1800;
    if (petController && typeof petController.triggerOneShot === 'function') {
      petController.triggerOneShot(action, oneShotMs);
    }
    return true;
  });

  // ---- Pet actions config (per-pet click/dblclick mapping + idle loop) ----
  // The settings page edits the config; the pet window reads click/dblclick
  // variants to decide what to fire, and the controller reads loop_variants
  // every scheduler tick to decide what to play while idle. Persistence
  // shape and defaults live in main/pet_actions_config.js so the three
  // consumers agree without re-implementing the same JSON.parse fallback.
  function resolvePetId(petId) {
    const id = (typeof petId === 'string' && petId) ? petId : db.getSetting('pet_id');
    return id || null;
  }

  ipcMain.handle('pet:actions_config:get', (_e, petId) => {
    const id = resolvePetId(petId);
    if (!id) {
      return {
        config: petActionsConfig.loadConfig(db, null),
        available_variants: [],
        trigger_defs: petActionsConfig.TRIGGER_DEFS,
        effect_bindings: petActionsConfig.EFFECT_BINDINGS,
        pet_id: null,
      };
    }
    const cfg = petActionsConfig.loadConfig(db, id);
    const filtered = petActionsConfig.filterAgainstManifest(cfg, petRegistry, id);
    return {
      config: filtered,
      available_variants: petActionsConfig.getAvailableVariants(petRegistry, id),
      trigger_defs: petActionsConfig.TRIGGER_DEFS,
      effect_bindings: petActionsConfig.EFFECT_BINDINGS,
      pet_id: id,
    };
  });

  ipcMain.handle('pet:actions_config:save', (_e, petId, cfg) => {
    const id = resolvePetId(petId);
    if (!id) throw new Error('未选择桌宠');
    const filtered = petActionsConfig.filterAgainstManifest(cfg || {}, petRegistry, id);
    const ok = petActionsConfig.saveConfig(db, id, filtered);
    if (!ok) throw new Error('保存失败');
    // Push the new loop list straight into the controller so the renderer
    // doesn't have to wait for the next 1s scheduler tick to see the change.
    if (petController && typeof petController.setLoopVariants === 'function') {
      petController.setLoopVariants(filtered.loop_variants);
    }
    return { ok: true, config: filtered };
  });

  // Lightweight accessor the pet window can call on startup (or after a
  // pet-switch event) without paying for the full config payload.
  ipcMain.handle('pet:loop_variants:get', (_e, petId) => {
    const id = resolvePetId(petId);
    if (!id) return { variants: ['default'] };
    const cfg = petActionsConfig.loadConfig(db, id);
    const filtered = petActionsConfig.filterAgainstManifest(cfg, petRegistry, id);
    return { variants: filtered.loop_variants };
  });

  // ---- 动作 → 文本绑定 ---------------------------------------------
  //
  // `get` returns one row per action the user could plausibly bind a line
  // to, so /settings can render the whole editor from a single call:
  //   * `actions` — the character variants the active pet's manifest
  //     declares, plus the trigger ids and right-click cozy actions,
  //     plus any action that already carries saved texts (so a binding
  //     survives a pet switch instead of silently disappearing).
  //   * `runtime` — the lines currently plugged into `default` by a live
  //     吃饭提醒 / 休息提醒 bubble. Surfaced so the UI can show that the
  //     plug/unplug is happening rather than looking like a bug.
  //
  // `save` takes the whole { texts: { action: [lines] } } map and replaces
  // it — a full replace rather than a merge, so removing a line in the UI
  // actually removes it from disk (a merge would make deletions
  // impossible without a separate delete verb).
  ipcMain.handle('pet:action_texts:get', (_e, petId) => {
    const id = resolvePetId(petId);
    const cfg = petActionTexts.loadConfig(db, id);
    if (!id) {
      return { texts: cfg.texts, boxes: cfg.boxes, actions: [], runtime: [], pet_id: null };
    }
    // Reuse the *same* manifest-filtered variant list the actions-config
    // card uses, so a pet that ships e.g. `pat` shows a `pat` row in both
    // editors. Building it here from the same call the other card makes
    // keeps the two dropdowns in lockstep without duplicating the
    // filtering policy.
    //
    // Only the character's OWN animations get a row. TRIGGER_DEFS (单击桌宠)
    // and EFFECT_BINDINGS (右击菜单 · 摸一下/拍头/喂食…) are *user*
    // interactions, not things the pet performs, so there's no line to
    // attach to them — the right-click menu already owns its own wording.
    // Feeding those ids in here is what used to produce those rows.
    const variants = petActionsConfig.getAvailableVariants(petRegistry, id);
    return {
      texts: cfg.texts,
      boxes: cfg.boxes,
      actions: petActionTexts.describeActions(db, id, { variants }),
      // What the bubble engine has plugged into `default` right now.
      runtime: petActionTexts.listRuntime(petBubbles.RUNTIME_TARGET_ACTION),
      // The 文本框 catalog (resources/text_boxes) — resolved to file:// URLs
      // here because the renderer can't read the filesystem. The rule-bubble
      // choice rides along so the whole card renders from this one call: it's
      // the same concept as a per-action box, just stored pet-independently
      // because a 吃饭提醒 belongs to no action (see main/pet_bubbles.js).
      textBoxes: petTextBoxes.list(null),
      ruleBox: petBubbles.loadRuleBox(),
      pet_id: id,
    };
  });

  ipcMain.handle('pet:action_texts:save', (_e, petId, cfg) => {
    const id = resolvePetId(petId);
    if (!id) throw new Error('未选择桌宠');
    // `normalizeTexts` inside saveConfig does the validation: drops
    // non-string / blank lines, de-dupes within an action, and rejects
    // blank action keys. No manifest filtering here on purpose — a line
    // bound to a variant the *current* pet doesn't expose must survive so
    // it comes back when the user switches back to the pet that has it.
    // Same reasoning for `boxes`: a box id is stored verbatim so a PNG the
    // current install lacks still resolves after the user copies the files
    // over, and an unknown id degrades to the CSS bubble at render time.
    //
    // The rule-bubble box is saved in the same call so the card has one save
    // button rather than two that can disagree.
    if (!petActionTexts.saveConfig(db, id, cfg || {})) throw new Error('保存失败');
    if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'ruleBox')) {
      petBubbles.saveRuleBox(db, cfg.ruleBox);
    }
    const saved = petActionTexts.loadConfig(db, id);
    return { ok: true, texts: saved.texts, boxes: saved.boxes, ruleBox: petBubbles.loadRuleBox() };
  });

  // ---- 文本气泡（吃饭提醒 / 休息提醒）----
  //
  // The rule set lives entirely in main/pet_bubbles.js. These handlers only
  // expose its self-describing list and its toggle setter, so adding a rule
  // means editing that one file — no IPC handler, no preload method, no
  // renderer branch.
  //
  // The push side (pet:bubble-changed) is wired up once, at the bottom of
  // register(), via petBubbles.start().
  ipcMain.handle('bubbles:get_config', () => petBubbles.describeRules(db));

  ipcMain.handle('bubbles:set_enabled', (_e, map) => {
    const saved = petBubbles.saveEnabled(db, map || {});
    // Re-evaluate immediately so unchecking a rule makes its bubble vanish
    // without waiting up to a full tick for the change to be observed.
    petBubbles.tick();
    return saved;
  });

  // Debug helpers. `preview` reports what each rule *would* say right now
  // without broadcasting; `force` makes one specific rule the winner for a
  // single tick so the bubble can be eyeballed without waiting for its real
  // trigger.
  ipcMain.handle('bubbles:preview', (_e, ruleName) => {
    const snap = petBubbles._internals.buildSnapshot(
      petBubbles._internals.loadState(db), new Date(), currentIdleSeconds(),
    );
    const rule = petBubbles.BUILTIN_RULES.find((r) => r.name === ruleName);
    if (!rule) {
      return petBubbles.BUILTIN_RULES.map((r) => {
        let intent = null;
        try { intent = r.build(snap); } catch { intent = null; }
        return { name: r.name, label: r.label, kind: r.kind, due: !!(intent && intent.text) };
      });
    }
    let intent = null;
    try { intent = rule.build(snap); } catch (e) {
      return { name: rule.name, error: e && e.message };
    }
    return {
      name: rule.name,
      label: rule.label,
      kind: rule.kind,
      due: !!(intent && intent.text),
      text: (intent && intent.text) || null,
      durationMs: (intent && intent.durationMs) || null,
    };
  });

  ipcMain.handle('bubbles:force', (_e, ruleName) => {
    const rule = petBubbles.BUILTIN_RULES.find((r) => r.name === ruleName);
    if (!rule) return { ok: false };
    if (petWin()) {
      petWin().webContents.send(petBubbles.BROADCAST_CHANNEL, {
        text: (typeof rule.forceText === 'function') ? rule.forceText() : rule.name,
        kind: rule.kind,
        rule: rule.name,
      });
    }
    return { ok: true };
  });

  ipcMain.handle('bubbles:get_idle_seconds', () => currentIdleSeconds());

  ipcMain.handle('window:show_main', () => {
    if (winMain && !winMain.isDestroyed()) {
      winMain.show();
      winMain.focus();
    }
    return true;
  });

  ipcMain.handle('window:hide_main', () => {
    if (winMain && !winMain.isDestroyed()) winMain.hide();
    return true;
  });

  ipcMain.handle('window:open_reminder', (_e, source, sourceId) => {
    if (winMain && !winMain.isDestroyed()) {
      winMain.show();
      winMain.focus();
      winMain.webContents.send('main:open-reminder', { source, source_id: sourceId });
    }
    return true;
  });

  // ---- App-level controls ----
  ipcMain.handle('app:quit', () => {
    setTimeout(() => app.quit(), 50); // slight delay so the IPC ack reaches the renderer
    return true;
  });

  // ---- Pet drag: receive a per-tick delta from the pet window. We add it
  // to the window's current position and clamp to the display work area.
  // (Using per-tick deltas — not cumulative-from-mousedown — is the key to
  // smooth 1:1 tracking. If we accumulated from mousedown, the main process
  // would add the full cumulative delta to the window's *current* position
  // each tick and the window would run away from the cursor.)
  ipcMain.handle('pet:move_by', (_e, dx, dy) => {
    if (!petWin()) return false;
    // A non-numeric delta would make `nx`/`ny` NaN, and `setPosition(NaN, NaN)`
    // throws "conversion failure" — which takes down the whole handler and
    // leaves the pet frozen. Coerce and reject instead.
    const ddx = Number(dx), ddy = Number(dy);
    if (!Number.isFinite(ddx) || !Number.isFinite(ddy)) return false;
    const [x, y] = petWin().getPosition();
    const w = petWin().getBounds().width;
    const h = petWin().getBounds().height;
    const nx = x + ddx;
    const ny = y + ddy;
    const display = screen.getDisplayMatching({ x: nx, y: ny, width: w, height: h })
      || screen.getPrimaryDisplay();
    const wa = display.workArea;
    const cx = Math.max(wa.x, Math.min(wa.x + wa.width - w, nx));
    const cy = Math.max(wa.y, Math.min(wa.y + wa.height - h, ny));
    // `setPosition` takes INTEGER coordinates and throws "conversion failure"
    // on a fractional one. The mouse deltas the renderer reports are
    // integers, but the accumulated position can still drift into a
    // fraction over many small moves — round before handing it over.
    petWin().setPosition(Math.round(cx), Math.round(cy));
    // Pause autonomous movement for ~2 s so the pet doesn't run away right
    // after the user releases the drag. The renderer also calls setPaused at
    // the start of every drag (see src/js/pet.js) — this is a safety net
    // for rendererless moves.
    if (petController && typeof petController.setPaused === 'function') {
      petController.setPaused(2000);
    }
    return true;
  });

  // ---- Pet drag: main-process cursor tracking ----
  //
  // Why this exists, and why it can't live in the renderer:
  //
  // The pet window is `focusable: false` and only ~220 px across. A
  // `mousemove` listener in the renderer only fires while the pointer is
  // INSIDE that 220 px rectangle — the moment the user drags the pet toward
  // a screen edge the pointer leaves the rectangle and the renderer stops
  // receiving moves, so the drag appears to freeze. The follow-up `mouseup`
  // is lost the same way, which left the renderer's `pressing` flag stuck
  // true forever and made every later mouse move inside the window teleport
  // the pet.
  //
  // The fix is to track the CURSOR in the main process, where
  // `screen.getCursorScreenPoint()` reports the pointer's absolute position
  // no matter what has focus or where the pointer is. The renderer still
  // owns the *gesture* (it decides when a drag starts and ends, and it knows
  // where on the sprite the user grabbed), so it sends a `pet:drag_start`
  // carrying that grab offset; from then on the main process follows the
  // cursor and keeps the same offset, which makes the drag work at 1:1
  // across the whole desktop instead of just inside the window.
  //
  // The renderer does NOT also apply a relative delta while this is active —
  // it would compound with the absolute position written here. It only falls
  // back to reporting deltas itself if the takeover fails (an older main
  // process with no `pet:drag_start` handler); see src/js/pet.js.
  const petDrag = {
    active: false,
    timer: null,
    // Offset from the pointer to the window's top-left, in screen px.
    grabDX: 0,
    grabDY: 0,
    // The highest gesture id this process has seen.
    //
    // The renderer owns the gesture lifecycle and stamps every drag
    // message with the id of the gesture it belongs to. The ids increase
    // monotonically, so this is a high-water mark: any message carrying
    // an id at or below it belongs to a gesture that has already been
    // finished here, and must not be allowed to (re)start a drag.
    //
    // See `pet:drag_start` below for why that matters.
    lastGestureId: 0,
  };

  // ---- The input-path probe ----
  //
  // When the renderer last told us that input is reaching it.
  //
  // The renderer sends `pet:input_alive` the first time it sees any input
  // event after a wake. It is the proof that the window's input path still
  // works — the renderer can be alive and deaf at the same time (it keeps
  // answering IPC while no mouse event ever reaches it), and only the
  // renderer itself can tell the two apart.
  let petInputAliveAt = 0;

  // When the app was last restarted (on the monotonic clock).
  //
  // One sleep can be reported more than once — the `resume` event, the
  // `unlock-screen` event and the clock-jump watchdog all notice it — and
  // the app must be restarted once, not three times.
  let lastAppRelaunchAt = -Infinity;

  // Should the app be restarted when the input path turns out to be dead?
  //
  //   'always' (default) — on every wake, no questions asked: kill the
  //                        process and start a new one. This is the
  //                        user's explicitly requested fallback, and it
  //                        is the default because the in-process recovery
  //                        does NOT cure every case: on the real machine
  //                        (2026-10-31) the pet was still undraggable
  //                        after a wake WITH a live input path — the
  //                        pointer events arrived, the pet simply did
  //                        not move. A fresh process is the only state
  //                        that is known to work, because it is the state
  //                        `npm start` produces.
  //   'auto'            — only when the probe actually sees a dead input
  //                        path. The restart is disruptive (the main
  //                        window closes and reopens), so it must not
  //                        happen on a healthy wake.
  //   'off'             — never.
  const petRestartOnWakeSetting = () => {
    try {
      const v = db.getSetting('pet_restart_app_on_wake');
      return v === 'always' || v === 'off' || v === 'auto' ? v : 'always';
    } catch (e) { return 'always'; }
  };

  // The probe itself. See main/pet_input_probe.js for how it decides that
  // the input path is dead.
  const petInputProbe = createInputProbe({
    getWindow: petWin,
    getCursor: () => screen.getCursorScreenPoint(),
    hasInputAlive: () => petInputAliveAt > 0,
    log: (entry) => {
      try { petDiagnostics.append(Object.assign({ src: 'main' }, entry)); } catch (e) {}
    },
    onAlive: () => { petInputAliveAt = 0; },
    onDead: (why) => {
      // The window is deaf. Nothing inside this process can fix that, so
      // the app is restarted — a fresh browser process registers the
      // pointer device from scratch.
      try {
        petDiagnostics.append({
          src: 'main',
          kind: 'input_path_dead',
          reason: why || 'resume',
          action: 'relaunch',
        });
      } catch (e) {}
      relaunchOnWake('input-path-dead:' + (why || 'resume'));
    },
  });

  // How often the main process samples the cursor while a drag is active.
  // ~60 Hz: fast enough that the pet tracks the pointer smoothly, slow
  // enough that the polling costs nothing measurable.
  const DRAG_POLL_MS = 16;

  // Move the pet window so the cursor stays at the same offset from its
  // top-left corner, clamped to the display's work area.
  //
  // The clamp mirrors `pet:move_by`'s: the window is taller than the sprite
  // (bubble headroom above it) and wider than it (side room), so the
  // window's box — not the sprite's — is what has to stay on screen.
  function applyDragPosition(cursorX, cursorY) {
    if (!petWin()) return;
    const w = petWin().getBounds().width;
    const h = petWin().getBounds().height;
    const nx = cursorX - petDrag.grabDX;
    const ny = cursorY - petDrag.grabDY;
    const display = screen.getDisplayMatching({ x: nx, y: ny, width: w, height: h })
      || screen.getPrimaryDisplay();
    const wa = display.workArea;
    const cx = Math.max(wa.x, Math.min(wa.x + wa.width - w, nx));
    const cy = Math.max(wa.y, Math.min(wa.y + wa.height - h, ny));
    // `setPosition` takes INTEGER coordinates and throws "conversion failure"
    // on a fractional one. The cursor is reported in whole pixels, but the
    // grab offset is whatever the renderer measured — often fractional, and
    // on a HiDPI display the two are in different units to begin with. So
    // round before handing the value over.
    //
    // `Math.round` (not `Math.floor`) keeps the window centred on the
    // cursor within half a pixel instead of drifting a pixel in one
    // direction.
    petWin().setPosition(Math.round(cx), Math.round(cy));
  }

  // Tear down the main process's side of the drag.
  //
  // `force` is the difference between "the gesture ended normally" and "we
  // have no idea whether a gesture is still in flight, so tear everything
  // down". The forced path runs on system resume: the renderer may have
  // lost its gesture state entirely (a `pointerup` that never arrived, a
  // `blur` that fired before the OS restored the session), so it may never
  // send `pet:drag_end` — and without this the cursor poller would keep
  // dragging the pet around forever.
  //
  // Both paths are idempotent: releasing the mutex and the pause are both
  // safe to repeat.
  function stopPetDrag(force = false) {
    if (petDrag.timer) {
      clearInterval(petDrag.timer);
      petDrag.timer = null;
    }
    if (!petDrag.active) {
      // Nothing was in flight. A forced teardown still has to release the
      // controller's mutex: the renderer may have been the only thing that
      // could have released it, and it might have died with the gesture.
      if (force && petController && typeof petController.setDragging === 'function') {
        petController.setDragging(false);
      }
      return;
    }
    petDrag.active = false;
    // Release the controller's drag mutex so the pet resumes its normal
    // autonomous life. Without this the pet would stand still forever.
    if (petController && typeof petController.setDragging === 'function') {
      petController.setDragging(false);
    }
    // Let the pet settle for a moment before it walks off again.
    if (petController && typeof petController.setPaused === 'function') {
      petController.setPaused(2000);
    }
  }

  ipcMain.handle('pet:drag_start', (_e, grabDX, grabDY, gestureId) => {
    if (!petWin()) return false;
    // Reject a start for a gesture this process has already finished.
    //
    // The renderer resolves the grab offset asynchronously (it asks the
    // main process where the window is), so the `pet:drag_start` it sends
    // can arrive AFTER the `pet:drag_end` of the same gesture — a quick
    // flick (press, move, release) is over before the reply comes back,
    // and after a system resume the main process can be slow to answer at
    // all.
    //
    // The messages arrive in the order they were SENT, and the start is
    // sent from a promise callback — so the end genuinely overtakes it.
    // Without this check the main process would start following the
    // cursor with nothing left to stop it: the pet would be glued to the
    // pointer (it could not be dragged anywhere) and the controller's
    // drag mutex would stay held, so the pet would never walk on its own
    // again. The right-click menu would keep working, because it does not
    // go through the drag protocol at all — which is what made the
    // symptom look so odd.
    //
    // The renderer applies the same rule before sending the start, so the
    // two sides agree on what a stale message is.
    const g = Number(gestureId);
    if (Number.isFinite(g) && g > 0) {
      if (g <= petDrag.lastGestureId) {
        // Already seen this gesture (or a newer one) — its end has
        // already been processed. Ignore the start.
        return false;
      }
      petDrag.lastGestureId = g;
    }
    const [wx, wy] = petWin().getPosition();
    // `screen.getCursorScreenPoint()` returns a Point OBJECT ({x, y}), not an
    // array — destructuring it as one throws "object is not iterable".
    const cursor = screen.getCursorScreenPoint();
    const cx = cursor.x, cy = cursor.y;
    // The renderer sends the offset between the pointer and the WINDOW's
    // top-left, which is what `applyDragPosition` needs: it positions the
    // window, not the sprite inside it. Fall back to a cursor-relative
    // estimate if the value is missing or nonsensical.
    let dx = Number(grabDX), dy = Number(grabDY);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      dx = cx - wx;
      dy = cy - wy;
    }
    petDrag.grabDX = dx;
    petDrag.grabDY = dy;
    petDrag.active = true;
    // Record the takeover: the offset the renderer measured, the cursor it
    // was measured against and the window it applies to. If the pet does
    // not follow the pointer, these three numbers say why.
    try {
      petDiagnostics.append({
        src: 'main',
        kind: 'drag_start',
        gestureId: g,
        grab: { dx, dy },
        cursor: { x: cx, y: cy },
        win: { x: wx, y: wy },
      });
    } catch (e) { /* diagnostics must never break the drag */ }
    // Take the mutex BEFORE the first position write, so no controller tick
    // can interleave and move the window between the grab and the first
    // follow.
    if (petController && typeof petController.setDragging === 'function') {
      petController.setDragging(true);
    }
    if (!petDrag.timer) {
      petDrag.timer = setInterval(() => {
        if (!petDrag.active) return;
        if (!petWin()) {
          stopPetDrag();
          return;
        }
        const cursor = screen.getCursorScreenPoint();
        applyDragPosition(cursor.x, cursor.y);
      }, DRAG_POLL_MS);
    }
    // Place the window under the cursor right away, so the first frame of
    // the drag is already aligned instead of snapping one poll later.
    applyDragPosition(cx, cy);
    return true;
  });

  ipcMain.handle('pet:drag_end', (_e, gestureId) => {
    // An end that belongs to an OLDER gesture must not stop the drag that
    // is running now — that would leave the pet glued to the cursor
    // again, this time in the other direction.
    //
    // A gesture id of 0 (or none at all, from an older renderer) means
    // "stop whatever drag you are running": that is the forced teardown
    // the renderer sends when it cannot know whether a drag is still in
    // flight — after a system resume, for instance.
    const g = Number(gestureId);
    if (Number.isFinite(g) && g > 0) {
      if (g < petDrag.lastGestureId) return true;
      petDrag.lastGestureId = g;
    }
    stopPetDrag();
    return true;
  });

  // Hand out the gesture-id high-water mark so the renderer can build ids
  // that are unique for the whole life of the app.
  //
  // The renderer counts its gestures from 1 every time it loads, but the
  // gesture ids have to keep increasing across a renderer reload — the
  // main process refuses a start whose id it has already seen, and after a
  // reload the fresh renderer would start at 1 again and have every one of
  // its drags refused as a replay. The pet would then be undraggable for
  // as long as the reloaded renderer lived.
  //
  // Handing out the current high-water mark lets a fresh renderer pick up
  // where the last one left off.
  ipcMain.handle('pet:gesture_base', () => petDrag.lastGestureId);

  // ---- Diagnostics ----
  //
  // The pet window appends what it sees to the diagnostic log: every
  // pointer press, every wake, every drag takeover. See
  // main/pet_diagnostics.js for why this exists — the "the pet cannot be
  // dragged after the machine sleeps" bug only reproduces on real
  // hardware, so the app records the facts instead of guessing.
  ipcMain.handle('pet:diag', (_e, entry) => {
    petDiagnostics.append(Object.assign({ src: 'renderer' }, entry || {}));
    return true;
  });

  // "Input is reaching the pet renderer again."
  //
  // Sent by the renderer once per wake, the first time it sees any input
  // event. The input probe watches for it: if the OS cursor moves over the
  // pet and this message never arrives, the window's input path is dead,
  // and the only cure left is a new process (main/app_relaunch.js).
  ipcMain.handle('pet:input_alive', () => {
    petInputAliveAt = Date.now();
    return true;
  });

  // ---- Pet drag: system suspend / resume recovery ----
  //
  // The drag protocol above depends on the renderer sending `pet:drag_end`.
  // A system suspend can break that: the `pointerup` may never be delivered,
  // and the renderer's own rescue paths can fire before the OS restores the
  // session. When that happens the main process would keep polling the
  // cursor forever — the pet glued to the pointer, and the controller's drag
  // mutex held so the pet never moves on its own again.
  //
  // So on resume we tear the drag down unconditionally, re-assert the
  // window's visibility and mouse state, tell the renderer to forget its
  // gesture, and — as the last resort — RESTART the pet: the pet window is
  // destroyed and created again, so the pet starts from the same clean
  // state it had before the machine slept.
  //
  // See main/pet_resume.js for the details and the upstream Electron issues
  // this works around.
  //
  // How long to wait before the pet may be restarted again.
  //
  // One wake can be reported more than once: the `resume` event and the
  // clock-jump watchdog both notice it, and Electron 32 emits `resume`
  // twice by itself (electron/electron#44252). The user should see the pet
  // restart once per sleep, not once per report.
  const PET_RESTART_DEBOUNCE_MS = 10000;
  function recoverPetAfterResume(reason) {
    // Record what the world looked like when the machine came back.
    //
    // The window's position, the display layout and the cursor's position
    // are the three things that decide whether a drag can work at all —
    // if the pet ended up on a display that is gone, or the cursor is
    // nowhere near it, the drag cannot start and the log is the only place
    // that will show it.
    try {
      const displays = screen.getAllDisplays().map((d) => ({
        id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor,
      }));
      const cursor = screen.getCursorScreenPoint();
      petDiagnostics.append({
        src: 'main',
        kind: 'resume',
        reason: reason || 'resume',
        win: petWin() ? petWin().getPosition() : null,
        cursor: { x: cursor.x, y: cursor.y },
        displays,
        dragActive: petDrag.active,
        lastGestureId: petDrag.lastGestureId,
      });
    } catch (e) { /* diagnostics must never break the recovery */ }

    // 0. The blunt mode: kill the process and start a new one.
    //
    //    This is the user's explicitly requested fallback, and it is the
    //    DEFAULT. The in-process recovery below does not cure every case:
    //    on the real machine (2026-10-31) the pet was still undraggable
    //    after a wake WITH a live input path — the pointer events arrived,
    //    the right-click menu opened, and the pet simply did not move. A
    //    fresh process is the only state that is known to work, because it
    //    is exactly the state `npm start` produces.
    //
    //    It happens LAST, after the in-process recovery — not instead of
    //    it. The recovery still has work worth doing even when the process
    //    is about to be replaced: it pulls the pet back into the visible
    //    work area (the OS may have moved the window while the machine was
    //    asleep, and the new process starts the pet at the position that
    //    was persisted). And it happens in a `finally`, so a step that
    //    throws cannot swallow the restart — that would leave the user in
    //    exactly the state this is meant to escape.

    try {
      // 1. Kill any drag the main process still believes in. `force` releases
      //    the controller's mutex even if `petDrag.active` was already false —
      //    the renderer might have died with the gesture and never sent
      //    `pet:drag_end`.
      stopPetDrag(true);

      if (!petWin()) return;

      // 2. Re-assert the window state.
      //
      //    `show()` is the documented recovery for a frameless + transparent
      //    window that comes back black or frozen after a resume
      //    (electron/electron#37361). `isVisible()` is checked first so an
      //    already-visible window is not needlessly re-shown — re-showing
      //    would briefly steal the z-order.
      try {
        if (!petWin().isVisible()) petWin().show();
      } catch (e) {
        console.error('[pet_resume] could not re-show the pet window:', e);
      }
      //
      //    `setIgnoreMouseEvents` state can be lost across a resume: the
      //    Windows mouse-forwarding implementation was buggy until the
      //    electron/electron#52633 refactor (Electron 44+), and this project
      //    ships Electron 32. Re-asserting it is cheap and idempotent.
      try {
        petWin().setIgnoreMouseEvents(false);
      } catch (e) {
        console.error('[pet_resume] could not restore mouse-event state:', e);
      }

      // 3. Tell the renderer to forget its gesture state.
      //
      //    The renderer's `pressing` flag can be stuck true if the `pointerup`
      //    never arrived. Left alone, the next mouse move over the pet would
      //    compute a delta against a stale baseline. The renderer resets
      //    itself on this message.
      //
      //    The "input is alive" report is reset FIRST, so the report the
      //    renderer sends next really belongs to this wake. A report left
      //    over from before the sleep would tell the input probe that the
      //    window is fine when it may not be.
      petInputAliveAt = 0;
      try {
        petWin().webContents.send('pet:resume');
      } catch (e) {
        console.error('[pet_resume] could not notify the pet renderer:', e);
      }

      // 4. Pull the pet back into the visible work area.
      //
      //    The OS may have moved the window while the machine was asleep (a
      //    monitor was unplugged, the resolution changed, a dock was
      //    undocked). Left outside the work area, the pet is unreachable —
      //    the user cannot drag it back.
      if (petController && typeof petController.clampIntoView === 'function') {
        try { petController.clampIntoView(); } catch (e) {
          console.error('[pet_resume] could not re-clamp the pet into view:', e);
        }
      }

      // 5. Remember where the pet is.
      //
      //    The new process starts the pet at the persisted position, and the
      //    window's own `moved` handler writes it — but that handler is an
      //    EVENT, and in the default mode this process is about to be
      //    killed. A `setPosition` whose event fires a moment too late
      //    would be lost, and the pet would come back where it was before
      //    the clamp instead of where the clamp put it. So the position is
      //    written to the database here, while the process is still alive.
      try {
        const win = petWin();
        if (win && !win.isDestroyed()) {
          const [mx, my] = win.getPosition();
          db.setSetting('pet_x', String(mx));
          db.setSetting('pet_y', String(my));
        }
        // The database is written to disk on a five-second timer, and in the
        // default mode this process is about to be killed — so the write is
        // flushed HERE, not left to a timer that may never fire again.
        db.save();
      } catch (e) {
        console.error('[pet_resume] could not persist the pet position:', e);
      }

      // 6. Restart the pet.
      //
      //    This is the "just restart the pet" recovery, and it is the user's
      //    explicit request: after a sleep the pet sometimes ends up in a
      //    state where it cannot be dragged at all, and the one thing that is
      //    known to work is a fresh start.
      //
      //    "Fresh start" means the pet WINDOW is destroyed and created again,
      //    not merely reloaded. The diagnostic log from the real machine
      //    (2026-10-31) showed why a reload is not enough: after the reload
      //    the renderer kept receiving IPC — it answered `pet:resume`, so it
      //    looked perfectly alive — but it never received a single mouse
      //    event again. A window whose input path is broken stays broken
      //    across a reload, because the reload keeps the same native window.
      //    A brand-new window has a brand-new native window, a brand-new
      //    renderer and a brand-new input registration.
      //
      //    What is preserved: the window's position and size, the main
      //    window, the database and the pet's identity. What changes: the
      //    pet's page is built from scratch — which is the whole point.
      //
      //    The restart is debounced: a wake can be reported twice (the
      //    `resume` event and the clock-jump watchdog can both fire), and
      //    restarting twice would make the pet blink twice for one sleep.
      restartPet(reason || 'resume');
    } catch (e) {
      // A step that throws must not take the rest of the recovery with it.
      console.error('[pet_resume] the in-process recovery failed:', e);
    } finally {
      // 7. Watch the pet's INPUT PATH — or, in the default mode, kill the
      //    process and start a new one.
      //
      //    Everything above repairs the app from the inside. One failure
      //    cannot be repaired that way: a renderer that is alive and deaf —
      //    it still answers IPC, so it looks healthy, while not a single
      //    mouse event reaches it. The cause is Chromium's pointer-device
      //    registry, which lives in the BROWSER process and is shared by
      //    every window, so a new window inherits the broken registry and a
      //    reload certainly does.
      //
      //    The probe watches the OS cursor (which the main process can read
      //    whether or not the renderer can) against the renderer's own
      //    "input is alive" report. If the cursor moves over the pet and the
      //    renderer stays silent, the input path is dead — and then the app
      //    is restarted, which is the user's explicitly requested fallback:
      //    kill the old process and start a new one.
      //
      //    This sits in a `finally` on purpose: it is the step the whole
      //    mechanism exists for, so nothing above may swallow it.
      startPetInputProbe(reason || 'resume');
    }
  }

  // Start watching the pet's input path after a wake.
  //
  // `reason` says what woke the machine; it goes into the diagnostic log
  // so the probe can be lined up with the wake.
  function startPetInputProbe(reason) {
    const mode = petRestartOnWakeSetting();
    if (mode === 'off') {
      try {
        petDiagnostics.append({ src: 'main', kind: 'input_probe_skipped', reason, mode });
      } catch (e) {}
      return;
    }
    if (mode === 'always') {
      // The blunt version: on every wake, kill the process and start a
      // new one. Nothing is probed — the user asked for the pet to come
      // back from a clean process every time.
      relaunchOnWake(reason);
      return;
    }
    petInputProbe.start(reason || 'resume');
  }

  // Kill the process and start a new one.
  //
  // Debounced like the pet restart: one sleep is reported more than once
  // (the `resume` event, the `unlock-screen` event and the clock-jump
  // watchdog can all fire for it), and the app must be restarted once, not
  // three times.
  function relaunchOnWake(reason) {
    const now = monotonicNow();
    if (now - lastAppRelaunchAt < PET_RESTART_DEBOUNCE_MS) return false;
    lastAppRelaunchAt = now;
    try {
      petDiagnostics.append({ src: 'main', kind: 'app_relaunch', reason, mode: 'always' });
    } catch (e) {}
    return relaunchApp('wake:' + (reason || 'resume'));
  }

  // Restart the pet.
  //
  // `reason` says what triggered it ('resume', 'unlock-screen', 'watchdog'),
  // and it goes into the diagnostic log so the restarts can be lined up
  // with the wake events.
  //
  // A monotonic clock is used for the de-duplication, not `Date.now()`.
  //
  // The wall clock can jump BACKWARDS — a clock change, an NTP correction —
  // and a gap that comes out negative would suppress the restart for the
  // next ten minutes, leaving the pet in its broken state for exactly as
  // long as it matters. `performance.now()` is monotonic: it never goes
  // backwards, and it keeps counting across a suspend (unlike the timers,
  // which do not fire while the process is frozen).
  const monotonicNow = () => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  );
  // The time of the last restart, on the monotonic clock. It starts at
  // minus infinity so that the FIRST restart is never suppressed — the
  // monotonic clock starts near zero when the process starts, so a plain
  // zero would swallow a restart that happens within the first ten seconds
  // of the app's life.
  let lastPetRestartAt = -Infinity;
  function restartPet(reason) {
    if (!petWin()) return;
    const now = monotonicNow();
    // One restart per wake. The `resume` event and the clock-jump watchdog
    // can both fire for the same sleep, and the user should see the pet
    // restart once, not twice.
    if (now - lastPetRestartAt < PET_RESTART_DEBOUNCE_MS) return;
    lastPetRestartAt = now;

    // The real restart: a new window in the old one's place.
    //
    // If the recreation itself fails, the fallback below takes over — a
    // page reload is weaker than a new window, but it is still a restart,
    // and the pet must not be left in the broken state.
    if (typeof recreatePetWindow === 'function') {
      let recreated = false;
      try {
        recreatePetWindow(reason);
        recreated = true;
      } catch (e) {
        console.error('[pet_resume] could not restart the pet window:', e);
      }
      if (recreated) {
        // The new window starts at the old one's position, but the OS may
        // have moved that position off-screen while the machine was asleep.
        if (petController && typeof petController.clampIntoView === 'function') {
          try { petController.clampIntoView(); } catch (e) {
            console.error('[pet_resume] could not re-clamp the pet into view:', e);
          }
        }
        return;
      }
    }

    // Fallback for a host that cannot recreate the window (the unit test
    // drives the recovery without one): reload the page in place.
    try {
      petDiagnostics.append({
        src: 'main',
        kind: 'pet_reload',
        reason,
        win: petWin().getPosition(),
      });
    } catch (e) { /* diagnostics must never break the recovery */ }
    try {
      petWin().reload();
    } catch (e) {
      console.error('[pet_resume] could not reload the pet window:', e);
    }
  }

  const petResume = petResumeMod.install({
    onResume: recoverPetAfterResume,
  });
  shutdownFns.push(() => {
    petResume.dispose();
  });

  // ---- Pet drag: clock-jump watchdog ----
  //
  // `powerMonitor`'s `resume` is NOT dependable on Windows 11 Modern
  // Standby: the OS freezes the whole process while the machine is asleep,
  // and the `WM_POWERBROADCAST` wake notification is often never delivered
  // (electron/electron#47739). A plain lid-close with no lock screen may
  // not produce an `unlock-screen` either. When neither event arrives,
  // NOTHING in this process knows the machine slept — and the pet stays
  // wedged in its broken post-sleep state.
  //
  // So the recovery gets a second, independent trigger: a heartbeat that
  // compares the wall clock against the time it last ticked. Node's timers
  // do not replay the ticks missed during a sleep, but the wall clock DOES
  // jump forward by the length of the sleep. So the first heartbeat after
  // a suspend sees a gap far larger than the heartbeat interval, which is
  // proof that time passed while we were not running.
  //
  // This makes the recovery work even when the OS tells us nothing.
  const WATCHDOG_INTERVAL_MS = 5000;
  // A gap larger than this means the process was not scheduled for a while.
  //
  // This MUST be comfortably ABOVE the heartbeat interval: the gap is
  // measured between two ticks, so a healthy gap is already ~INTERVAL.
  // A threshold below the interval would fire on every single tick.
  //
  // The margin covers a machine that is merely busy (a long GC pause, a
  // heavy disk) while still catching any real sleep — the shortest thing
  // anyone calls a "sleep" is several seconds, and a real suspend is
  // measured in minutes.
  const WATCHDOG_GAP_MS = 20000;
  let lastTickAt = Date.now();
  const watchdog = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    // A gap this large means the process was frozen — the machine slept.
    if (gap > WATCHDOG_GAP_MS) {
      console.log(`[pet_resume] detected a ${Math.round(gap / 1000)}s freeze (no power event) — recovering`);
      try { recoverPetAfterResume('watchdog'); } catch (e) {
        console.error('[pet_resume] watchdog recovery failed:', e);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
  // The watchdog must not keep the process alive on its own.
  if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
  shutdownFns.push(() => {
    clearInterval(watchdog);
  });

  // ---- 快速记录窗口 ----
  // Which record kind the quick-record window should open. The renderer
  // pulls this on boot (rather than the main process pushing it) so the
  // answer can't be lost to a listener-not-registered-yet race — the
  // renderer is an ES module and its `on(...)` call runs after
  // `did-finish-load` has already fired.
  //
  // See main/quick_record.js for the window itself.
  ipcMain.handle('quick-record:get_kind', () => quickRecord.getKind());

  // ---- Pet right-click context menu (native Electron Menu at cursor) ----
  // Two actionable items only: open the (PIN-gated) main window, or quit.
  // The previous "设置…" entry was removed because settings should only be
  // reachable from inside the main window — and the main window itself is
  // now protected by a PIN. The renderer re-locks on every visibility
  // restoration, so the menu doesn't need to send `main:open-reminder`
  // itself; the renderer hook in src/js/auth.js handles reminder replay
  // after unlock.
  ipcMain.handle('pet:context_menu', () => {
    // The right-click menu is the proof that the renderer still receives
    // MOUSE events. After a system suspend the pointer events can stop
    // arriving altogether while the mouse events keep coming — and the
    // symptom ("the pet cannot be dragged but the right-click menu still
    // works") only makes sense in that world. So the fact that this
    // handler runs is recorded: it is the evidence that separates "no
    // mouse events at all" from "no POINTER events".
    try {
      petDiagnostics.append({ src: 'main', kind: 'context_menu' });
    } catch (e) { /* diagnostics must never break the menu */ }
    // No bond-tier read here: every menu item is available at any tier.
    // fireBondAction wraps the IPC calls into a single helper so we can
    // route a click through to the pet renderer (which doubles as the
    // visual feedback layer for the cozy interaction).
    const fireBondAction = (action) => {
      let out = null;
      try {
        out = petInteractions.applyCozyInteraction(db, action, {}, db.nowStr.bind(db));
      } catch {}
      const accepted = !!(out && out.accepted);
      // Same 吃饭提醒 early-end hook as the `bond:feed` IPC above — the
      // right-click menu is the primary way a user feeds the pet, so
      // without this the bubble would outlive the meal it was asking about.
      if (accepted && action === 'feed') {
        try { petBubbles.emit('fed', { source: 'context_menu', at: Date.now() }); } catch {}
      }
      // Tell the pet window to play the variant + optional particle. We
      // intentionally do this here (main process) rather than in the
      // renderer so the menu works even if the pet window is unfocused.
      //
      // The one-shot duration and particle come from cozy_engine's return
      // value (`oneShotMs` / `particle`) — the same source the `bond:*` IPC
      // handlers use. This path used to carry a private hardcoded table
      // (feed=1500, sleep=2200, …) instead, which truncated the animations:
      // the renderer fired `pet:action_ended` mid-sequence and rolled a new
      // loop action while the feed frames were still playing. Keeping the
      // engine authoritative means the two entry points can't drift again.
      //
      // The variant is the one thing the menu resolves on its own: the user's
      // per-pet `effect_overrides` via `getEffectVariant`, which already
      // cross-checks the override against the active pet's manifest and falls
      // back through the binding default to `default`, so it always yields a
      // variant the renderer can resolve. The effect_overrides map is keyed by
      // cozy action id, so we look it up by `action`. No minTier: every cozy
      // action plays on every tier, so a fresh pet still animates when the
      // user right-clicks it.
      //
      // Everything below is gated on `accepted`, exactly like the `bond:*`
      // handlers. That matters on cooldown: `applyInteraction` returns
      // `{accepted:false, silent:true}` with no `oneShotMs`, so without the
      // guard we'd fall through to the 1800 default and play a reaction for
      // an interaction the engine refused to count — the menu would animate
      // while the cozy score silently didn't move.
      if (accepted) {
        const petId = db.getSetting('pet_id') || null;
        const cfg = petId ? petActionsConfig.loadConfig(db, petId) : null;
        const variant = petActionsConfig.getEffectVariant(cfg, action, petRegistry, petId);
        fireVariant(variant, out.oneShotMs || 1800);
        if (out.particle) sendParticle(out.particle);
        // Push the new cozy numbers straight away instead of waiting for the
        // 1s pipeline tick, matching the `bond:*` handlers so the 今日 page bar
        // animates on the same click as a renderer-initiated interaction.
        if (petId) pushPetStatusNow(petId);
      }
    };
    const menu = Menu.buildFromTemplate([
      { label: '🐾 SoulDesktopPet', enabled: false },
      { type: 'separator' },
      {
        // 记录 — the quick-capture submenu. First actionable row, because
        // capturing a note is the most frequent thing a user does with the
        // pet; everything below it is a pet interaction.
        //
        // It opens its OWN window (main/quick_record.js) rather than the
        // main window: the main window is PIN-gated, and this flow exists
        // precisely so a record can be taken without unlocking it.
        label: '📝 记录',
        submenu: quickRecord.RECORD_KINDS.map((k) => ({
          label: `${k.icon} ${k.label}`,
          click: () => { quickRecord.show(k.id); },
        })),
      },
      { type: 'separator' },
      // 关闭提醒 — turn the pet's nag off without opening the (PIN-gated)
      // main window.
      //
      // Only offered while a reminder is actually pending, so the rest of
      // the menu keeps its usual shape. It completes the reminder for
      // today — the same soft-dismiss the main window's 完成 button does —
      // so the badge disappears, the pet stops shaking, and the top-bar
      // pill goes back to 桌宠正常. The entry stays on the 今日 page.
      ...(queue.activeCount() > 0 ? [{
        label: `🔕 关闭提醒（${queue.activeCount()}）`,
        click: () => {
          const head = queue.activeHead();
          if (!head) return;
          completeReminderForToday(
            { queue, setPetState, setActiveReminder, broadcastPetState },
            head.source, head.source_id,
          );
        },
      }] : []),
      {
        label: '🥰 摸一下',
        click: () => fireBondAction('pet'),
      },
      {
        label: '🐾 双击拍头',
        click: () => fireBondAction('pat'),
      },
      { type: 'separator' },
      {
        label: '🍖 喂食',
        click: () => fireBondAction('feed'),
      },
      {
        label: '🧶 玩耍',
        click: () => fireBondAction('play'),
      },
      {
        label: '💤 睡觉',
        click: () => fireBondAction('sleep'),
      },
      { type: 'separator' },
      {
        label: '💃 跳舞',
        click: () => fireBondAction('cuddle'),
      },
      { type: 'separator' },
      {
        label: '📋 查看羁绊',
        click: () => {
          if (winMain && !winMain.isDestroyed()) {
            winMain.show();
            winMain.focus();
            // The bond/cozy/mood readouts now live on the 今日 page, so the
            // menu item lands there instead of the never-registered /pets
            // route. `main:navigate` only assigns location.hash — if the
            // window is already sitting on #/today (the default), that
            // assignment is a no-op and no hashchange fires, so the page
            // would never re-render. Bounce through a sentinel route to
            // force the transition, and have the renderer normalize it
            // back to /today.
            winMain.webContents.send('main:navigate', '/today');
            winMain.webContents.executeJavaScript(
              'if (location.hash === "#/today") { location.hash = "#/__today"; }'
            ).catch(() => {});
          }
        },
      },
      { type: 'separator' },
      {
        label: '打开主窗口',
        click: () => {
          if (winMain && !winMain.isDestroyed()) {
            winMain.show();
            winMain.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出 SoulDesktopPet',
        click: () => {
          setTimeout(() => app.quit(), 50);
        },
      },
    ]);
    menu.popup({ window: petWin() });
    return true;
  });

  // ---- Bond / Cozy / Mood IPC surface ----
  // These handlers back the `mp.bond.*` API exposed via preload. The pet
  // window also calls them for the one-shot interactions (摸/拍/喂/玩/睡/
  // 贴) that aren't covered by the right-click menu.
  ipcMain.handle('bond:get_snapshot', (_e, petId) => {
    return petInteractions.getBondSnapshot(db, petId);
  });

  ipcMain.handle('bond:get_weekly_breakdown', (_e, petId) => {
    return petInteractions.getWeeklyBreakdown(db, petId);
  });

  ipcMain.handle('bond:get_cozy_snapshot', (_e, petId) => {
    return petInteractions.getCozySnapshot(db, petId);
  });

  ipcMain.handle('bond:get_full_state', (_e, petId) => {
    // Composite snapshot used by the 今日 page so the renderer doesn't need
    // to round-trip four IPC calls. All four engines are pure functions over
    // the DB row, so this is safe to call at any cadence. The reminder count
    // is passed through because "reminder" is the top-priority mood — with a
    // hardcoded 0 the pet could never report that it was nagging, which is
    // exactly the state the user most wants to see on the page.
    const id = petId || db.getSetting('pet_id');
    const bond = petInteractions.getBondSnapshot(db, id);
    const cozy = petInteractions.getCozySnapshot(db, id);
    const mood = petInteractions.computeMood(db, petMoodMod.computeMood, queue.activeCount(), id);
    return Object.assign({}, bond, cozy, { mood: mood.mood });
  });

  // Cozy interactions — single shared handler so we can gate all six
  // actions the same way and keep variant/particle side effects in one
  // place. `action` is one of: pet | pat | feed | play | sleep | cuddle.
  const COZY_HANDLERS = ['pet', 'pat', 'feed', 'play', 'sleep', 'cuddle'];
  for (const action of COZY_HANDLERS) {
    ipcMain.handle(`bond:${action}`, () => {
      const id = db.getSetting('pet_id');
      // No bond-tier gate — cozy actions are available at every tier.
      const out = petInteractions.applyCozyInteraction(
        db, action, {}, db.nowStr.bind(db), id,
      );
      if (out && out.accepted) {
        if (out.variant) fireVariant(out.variant, out.oneShotMs || 1800);
        if (out.particle) sendParticle(out.particle);
        // Push the new numbers straight away instead of waiting for the 1s
        // pipeline tick, so the 今日 page's 舒适度 bar animates on the same
        // click. The tick is value-gated and would otherwise swallow this if
        // the scheduler happened to sample before the write landed.
        pushPetStatusNow(id);
        // Tell the bubble framework the user fed the pet. The 吃饭提醒 rule
        // watches this and closes its bubble immediately instead of leaving
        // "今天吃撒" up for the rest of its one-hour window. Routed through
        // `emit` rather than a direct call so future rules can watch other
        // cozy actions the same way without any call-site changes.
        if (action === 'feed') {
          try { petBubbles.emit('fed', { petId: id, at: Date.now() }); } catch {}
        }
      }
      return out;
    });
  }

  // Logged by the renderer when the user dwells on a contact (>5s on the
  // detail page). One record per contact per week — duplicates are
  // de-duped inside `logContactReviewed` so spamming the page can't
  // inflate the dimension.
  ipcMain.handle('bond:log_contact_viewed', (_e, contactId) => {
    petInteractions.logContactReviewed(db, contactId, db.nowStr.bind(db));
    return true;
  });

  // ---- Backup / restore ----
  // Round-trippable bundle: a zip containing soul-desktop-pet.db and a photos/
  // folder that follows the on-disk layout <appData>/SoulDesktopPet/photos.
  // search_index is not bundled — it's a derived cache that's rebuilt from
  // the imported tables by the next round of upsertSearch() calls.
  //
  // The flow is split into three handlers so the user gets a real OS
  // confirm() dialog between picking the file and overwriting the local DB:
  //
  //   backup:export    – showSaveDialog → return chosen path (or canceled)
  //   backup:import    – showOpenDialog → return chosen path (or canceled)
  //   backup:apply     – destructive: swap DB on disk, replace photos dir,
  //                       rebuild the in-memory reminder queue
  //
  // backup:export / backup:apply both snapshot the DB before doing IO so
  // the in-memory state always lands in the file the user is going to ship.

  function backupStamp() {
    // "YYYYMMDD-HHmmss" in local time. Safe for filenames on Windows /
    // macOS / Linux (no spaces, no colons).
    return db.nowStr().replace(/[-: ]/g, '').slice(0, 15);
  }

  ipcMain.handle('backup:export', async () => {
    if (!db.dbPath) throw new Error('数据库未初始化');
    const stamp = backupStamp();
    const result = await dialog.showSaveDialog(winMain, {
      title: '导出备份',
      defaultPath: `soul-desktop-pet-backup-${stamp}.zip`,
      filters: [{ name: 'SoulDesktopPet 备份', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    // Persist the latest in-memory state before copying the file out.
    db.save();

    const zip = new AdmZip();
    zip.addLocalFile(db.dbPath, '', 'soul-desktop-pet.db');
    const photosDir = getPhotosDir();
    if (fs.existsSync(photosDir)) {
      // Empty directories inside `photos/` would otherwise be dropped by
      // the zip writer; that's fine — empty dirs have no bytes anyway.
      zip.addLocalFolder(photosDir, 'photos');
    }
    zip.writeZip(result.filePath);

    db.setSetting('last_export_at', db.nowStr());
    return { canceled: false, path: result.filePath };
  });

  ipcMain.handle('backup:import', async () => {
    const pick = await dialog.showOpenDialog(winMain, {
      title: '导入备份',
      filters: [{ name: 'SoulDesktopPet 备份', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
      return { canceled: true };
    }
    return { canceled: false, path: pick.filePaths[0] };
  });

  ipcMain.handle('backup:apply', async (_e, zipPath) => {
    if (!zipPath) throw new Error('备份路径为空');
    if (!fs.existsSync(zipPath)) throw new Error('备份文件不存在');

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    if (!entries.some((e) => e.entryName === 'soul-desktop-pet.db')) {
      throw new Error('备份中缺少 soul-desktop-pet.db');
    }

    if (!db.dbPath) throw new Error('数据库未初始化');

    // 1) Snapshot current in-memory state, then close so we can replace the
    //    file on disk.
    try { db.save(); } catch (e) { console.error('pre-import save failed:', e); }
    db.close();

    // 2) Atomically replace soul-desktop-pet.db. We write to a sibling temp file
    //    first so a crash mid-write can't leave the live DB half-written.
    const dbEntry = entries.find((e) => e.entryName === 'soul-desktop-pet.db');
    const tmpDb = db.dbPath + '.import.tmp';
    fs.writeFileSync(tmpDb, dbEntry.getData());
    fs.copyFileSync(tmpDb, db.dbPath);
    try { fs.unlinkSync(tmpDb); } catch {}

    // 3) Reopen — sql.js reloads the bytes from disk.
    await db.open(db.dbPath);

    // 4) Wipe and rebuild the photos directory from the zip. Reject any
    //    entry whose path tries to escape (zip slip) — entryName must not
    //    contain ".." or absolute paths.
    const photosDir = getPhotosDir();
    fs.rmSync(photosDir, { recursive: true, force: true });
    fs.mkdirSync(photosDir, { recursive: true });
    for (const e of entries) {
      if (e.isDirectory) continue;
      if (!e.entryName.startsWith('photos/')) continue;
      if (e.entryName.includes('..')) continue;
      // Strip the "photos/" prefix; the resulting path must stay inside
      // photosDir.
      const rel = e.entryName.slice('photos/'.length);
      const out = path.join(photosDir, rel);
      const relOut = path.relative(photosDir, out);
      if (relOut.startsWith('..') || path.isAbsolute(relOut)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, e.getData());
    }

    // 5) Reset the live reminder queue so it doesn't keep stale ids from
    //    the previous DB. The next scheduler tick will repopulate from
    //    events.next_fire_at via scanAndFire().
    if (queue && typeof queue.clear === 'function') {
      queue.clear();
    }

    // 6) Drop the action-texts cache. The restore swapped the whole DB file,
    //    so the memoised `pet_action_texts:<petId>` blobs belong to the old
    //    database. Without this the pet would keep quoting lines the user
    //    deleted before the import until the process restarted.
    petActionTexts.invalidate();
    // Same reasoning for the rule bubbles' 文本框: it is memoised for the same
    // hot-path reason, and the restore swapped out the row it came from. Left
    // cached, 吃饭提醒 would keep drawing the box from the *previous* database
    // until restart.
    petBubbles.invalidateRuleBox();

    db.setSetting('last_import_at', db.nowStr());
    return { canceled: false };
  });

  // ---- Export: 回忆相册 (PDF) / 回忆视频 (MP4) -----------------------
  //
  // Material scope is strictly `memorial_events` + `memorial_event_photos`.
  // No mixing with the reminder `events` table, contact avatars, or
  // important dates — that's the brief from the user.
  //
  //   export:preview_filter  – filter counts + event summaries for the UI
  //   export:pdf             – save dialog → build PDF
  //   export:docx            – save dialog → build Word (.docx)
  //   export:mp4             – save dialog → build MP4
  //   export:cancel          – flip the killed flag for a running job
  //
  // Progress flows back through a one-way IPC channel: the renderer
  // subscribes once to `export:progress` and updates its UI per message.
  // We dedupe by jobId so two simultaneous exports don't trample each other.

  function pushExportProgress(jobId, phase, percent, note) {
    if (!winMain || winMain.isDestroyed()) return;
    try {
      winMain.webContents.send('export:progress', {
        jobId, phase, percent, note: note || null,
      });
    } catch (e) {
      console.error('[export] push progress failed:', e);
    }
  }

  // Look up contact names for a set of contact_ids. We use this to fill
  // the per-event `contact_names` field on preview responses (the table
  // query returns ids only). One query, batched.
  function resolveContactNames(ids) {
    const set = new Set((ids || []).filter((x) => x != null));
    if (set.size === 0) return new Map();
    const placeholders = Array.from(set, () => '?').join(',');
    const rows = db.all(`SELECT id, name FROM contacts WHERE id IN (${placeholders})`, Array.from(set));
    const m = new Map();
    for (const r of rows) m.set(r.id, r.name || '');
    return m;
  }

  ipcMain.handle('export:preview_filter', (_e, filter = {}) => {
    const contactIds = Array.isArray(filter.contactIds) && filter.contactIds.length
      ? filter.contactIds.map(String)
      : null;
    const range = filter.range && (filter.range.start || filter.range.end)
      ? {
          start: filter.range.start || null,
          end: filter.range.end || null,
        }
      : null;
    const rows = db.listMemorialEventsForExport({
      contactIds,
      start: range ? range.start : null,
      end: range ? range.end : null,
    });
    // Hydrate contact_names for the response (cheap one-shot).
    const allIds = new Set();
    for (const r of rows) (r.contact_ids || []).forEach((id) => allIds.add(id));
    const nameMap = resolveContactNames(Array.from(allIds));
    const events = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      occurred_at: r.occurred_at,
      place: r.place,
      photo_count: r.photo_count,
      contact_ids: r.contact_ids || [],
      contact_names: (r.contact_ids || []).map((id) => nameMap.get(id) || '').filter(Boolean),
      first_photo_id: r.first_photo_id || null,
      first_photo_relative_path: r.first_photo_relative_path || null,
    }));
    const eventCount = events.length;
    const photoCount = events.reduce((acc, e) => acc + (e.photo_count || 0), 0);
    return { eventCount, photoCount, events };
  });

  // Load the full event rows (with photos) for a chosen ordered id list.
  // The renderer picks the order via the /export preview checkboxes.
  function loadEventsForExport(eventIds) {
    const out = [];
    for (const id of eventIds) {
      const ev = db.getMemorialEvent(String(id));
      if (!ev) continue;
      // getMemorialEvent returns photos as a side field (db.js:1006+).
      // Defensive: if a future schema change drops it, hydrate via
      // listPhotosForMemorialEvent.
      if (!Array.isArray(ev.photos)) {
        ev.photos = db.listPhotosForMemorialEvent(String(id));
      }
      out.push(ev);
    }
    return out;
  }

  ipcMain.handle('export:pdf', async (_e, payload = {}) => {
    const eventIds = Array.isArray(payload.eventIds) ? payload.eventIds.map(String) : [];
    if (eventIds.length === 0) throw new Error('未选择任何事件');
    const stamp = backupStamp();
    const result = await dialog.showSaveDialog(winMain, {
      title: '导出回忆相册',
      defaultPath: `soul-desktop-pet-album-${stamp}.pdf`,
      filters: [{ name: 'PDF 相册', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const events = loadEventsForExport(eventIds);
    if (events.length === 0) throw new Error('所选事件不存在或已被删除');

    // We don't have a meaningful jobId for PDF (pdfkit runs in-process);
    // the renderer still wants progress, so synthesize a stable id.
    const jobId = `pdf-${Date.now().toString(36)}`;
    const job = { killed: false, outPath: result.filePath };
    activeExportJobs.set(jobId, job);

    const cancelCheck = () => job.killed;
    const progressCb = (phase, percent, note) => {
      if (job.killed) return;
      pushExportProgress(jobId, phase, percent, note);
    };

    // Forward the optional AlbumLayout from the WYSIWYG editor. When
    // missing, buildAlbum falls back to the original 1-photo-per-page mode.
    const layout = (payload && payload.layout) || null;

    try {
      const stats = await albumPdf.buildAlbum({
        events,
        layout,
        outPath: result.filePath,
        progressCb,
      });
      try { db.setSetting('last_pdf_export_at', db.nowStr()); } catch {}
      return {
        canceled: false,
        path: result.filePath,
        jobId,
        stats: {
          events: stats.events,
          photos: stats.photos,
          pages: stats.pages,
          bytes: stats.bytes,
          font: stats.font,
          heicSkipped: stats.heicSkipped,
          mode: stats.mode,
        },
      };
    } catch (err) {
      if (job.killed) {
        try { fs.unlinkSync(result.filePath); } catch {}
        return { canceled: true, jobId };
      }
      throw err;
    } finally {
      activeExportJobs.delete(jobId);
    }
  });

  ipcMain.handle('export:docx', async (_e, payload = {}) => {
    const eventIds = Array.isArray(payload.eventIds) ? payload.eventIds.map(String) : [];
    if (eventIds.length === 0) throw new Error('未选择任何事件');
    const stamp = backupStamp();
    const result = await dialog.showSaveDialog(winMain, {
      title: '导出回忆相册 (Word)',
      defaultPath: `soul-desktop-pet-album-${stamp}.docx`,
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const events = loadEventsForExport(eventIds);
    if (events.length === 0) throw new Error('所选事件不存在或已被删除');

    // 同 PDF：主进程内联执行，jobId 只是为了让渲染层能订阅进度 / 取消。
    const jobId = `docx-${Date.now().toString(36)}`;
    const job = { killed: false, outPath: result.filePath };
    activeExportJobs.set(jobId, job);

    const progressCb = (phase, percent, note) => {
      if (job.killed) return;
      pushExportProgress(jobId, phase, percent, note);
    };

    const layout = (payload && payload.layout) || null;

    try {
      const stats = await albumDocx.buildAlbum({
        events,
        layout,
        outPath: result.filePath,
        progressCb,
      });
      try { db.setSetting('last_docx_export_at', db.nowStr()); } catch {}
      return {
        canceled: false,
        path: result.filePath,
        jobId,
        stats: {
          events: stats.events,
          photos: stats.photos,
          pages: stats.pages,
          bytes: stats.bytes,
          heicSkipped: stats.heicSkipped,
          mode: stats.mode,
        },
      };
    } catch (err) {
      if (job.killed) {
        try { fs.unlinkSync(result.filePath); } catch {}
        return { canceled: true, jobId };
      }
      throw err;
    } finally {
      activeExportJobs.delete(jobId);
    }
  });

  ipcMain.handle('export:mp4', async (_e, payload = {}) => {
    const eventIds = Array.isArray(payload.eventIds) ? payload.eventIds.map(String) : [];
    if (eventIds.length === 0) throw new Error('未选择任何事件');
    const stamp = backupStamp();
    const result = await dialog.showSaveDialog(winMain, {
      title: '导出回忆视频',
      defaultPath: `soul-desktop-pet-album-${stamp}.mp4`,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const events = loadEventsForExport(eventIds);
    if (events.length === 0) throw new Error('所选事件不存在或已被删除');

    const jobId = `mp4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const job = { killed: false, outPath: result.filePath };
    activeExportJobs.set(jobId, job);

    const cancelCheck = () => job.killed;
    const progressCb = (phase, percent, note) => {
      if (job.killed) return;
      pushExportProgress(jobId, phase, percent, note);
    };

    try {
      const stats = await albumVideo.buildVideo({
        events,
        outPath: result.filePath,
        options: { cancelCheck, progressCb },
      });
      try { db.setSetting('last_mp4_export_at', db.nowStr()); } catch {}
      return {
        canceled: false,
        path: result.filePath,
        jobId,
        stats: {
          events: stats.events,
          photos: stats.photos,
          segments: stats.segments,
          durationSec: stats.durationSec,
          bytes: stats.bytes,
          font: stats.font,
          heicSkipped: stats.heicSkipped,
        },
      };
    } catch (err) {
      if (job.killed || (err && err.killed)) {
        try { fs.unlinkSync(result.filePath); } catch {}
        return { canceled: true, jobId };
      }
      throw err;
    } finally {
      activeExportJobs.delete(jobId);
    }
  });

  ipcMain.handle('export:cancel', (_e, payload = {}) => {
    const jobId = payload && payload.jobId;
    if (!jobId) return { ok: false, reason: 'no_job_id' };
    const job = activeExportJobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found' };
    job.killed = true;
    return { ok: true };
  });

  // ---- Tools page: video → frames zip -----------------------------------
  //
  // Three handlers back the splitter tool:
  //   tools:split_video_to_frames — input + save dialogs → ffmpeg + zip
  //   tools:cancel                — flip the killed flag for a running job
  //   tools:reveal_in_folder      — shell.showItemInFolder on the saved zip
  //
  // Both dialogs run in main (same pattern as `pet:import_from_zip`) so the
  // renderer never has to ship raw video bytes through IPC, and the
  // produce/check pair stays fast for large files (a 1080p 10-minute video
  // is hundreds of MB).
  //
  // Progress is delivered via `tools:progress` (one-way push), mirroring
  // `export:progress`.

  function pushToolsProgress(jobId, phase, percent, note) {
    if (!winMain || winMain.isDestroyed()) return;
    try {
      winMain.webContents.send('tools:progress', {
        jobId, phase,
        percent: (typeof percent === 'number') ? percent : null,
        note: note || null,
      });
    } catch (e) {
      console.error('[tools] push progress failed:', e);
    }
  }

  function tmpFramesDir() {
    // Per-run unique temp dir under os.tmpdir(). The finally block at the
    // call site is responsible for removing it (success, cancel, error
    // alike) — we don't want to leak hundreds of MB of PNGs across runs.
    return fs.mkdtempSync(path.join(os.tmpdir(), 'soul-desktop-pet-frames-'));
  }

  ipcMain.handle('tools:split_video_to_frames', async (_e, payload = {}) => {
    const fpsRaw = Number(payload && payload.fps);
    if (!Number.isFinite(fpsRaw) || fpsRaw <= 0 || fpsRaw > 60) {
      throw new Error('fps 必须在 0 – 60 之间');
    }
    // Three decimal places is plenty for 0.1 step; format 'jpg' is the
    // only other valid value beside the default 'png'.
    const fps = Math.round(fpsRaw * 1000) / 1000;
    const format = (String((payload && payload.format) || 'png').toLowerCase() === 'jpg')
      ? 'jpg' : 'png';

    const pick = await dialog.showOpenDialog(winMain, {
      title: '选择视频',
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
      return { canceled: true };
    }
    const inputPath = pick.filePaths[0];

    const stamp = backupStamp();
    const extSuffix = format === 'jpg' ? 'jpg' : 'png';
    const defaultName = `soul-desktop-pet-frames-${stamp}.zip`;
    const save = await dialog.showSaveDialog(winMain, {
      title: '保存拆帧压缩包',
      defaultPath: defaultName,
      filters: [{ name: '压缩包', extensions: ['zip'] }],
    });
    if (save.canceled || !save.filePath) {
      return { canceled: true };
    }
    const outPath = save.filePath;

    const jobId = `tools-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const job = { killed: false };
    activeToolsJobs.set(jobId, job);

    const cancelCheck = () => job.killed;
    const progressCb = (info) => {
      if (job.killed) return;
      pushToolsProgress(jobId, info.phase, info.percent, info.note);
    };

    const framesDir = tmpFramesDir();
    let zipWritten = false;
    try {
      const result = await videoFrameSplit.extractFrames({
        inputPath,
        outDir: framesDir,
        fps,
        format,
        cancelCheck,
        progressCb,
      });

      // Pack the per-frame outputs into the user-chosen zip. The files
      // have already been renamed to `frame_<seq>_<ms>.<ext>` by
      // video_frame_split.renameWithTimings, so the zip entries carry
      // both the ordinal and the per-frame interval (in ms) in their
      // filename; the ms segment is the same for every entry.
      progressCb({ phase: 'finalizing', percent: 99, note: '正在打包压缩包' });
      const zip = new AdmZip();
      const files = fs.readdirSync(framesDir)
        .filter((n) => n.startsWith('frame_') && n.endsWith('.' + extSuffix))
        .sort();
      for (const fn of files) {
        zip.addLocalFile(path.join(framesDir, fn), '', fn);
      }
      zip.writeZip(outPath);
      zipWritten = true;
      progressCb({ phase: 'done', percent: 100, note: `已生成 ${result.frames} 张图片` });

      return {
        canceled: false,
        path: outPath,
        frames: result.frames,
        bytes: fs.statSync(outPath).size,
      };
    } catch (err) {
      if (job.killed || (err && err.killed)) {
        // Clean up the half-written zip on cancel. The file may not exist
        // yet — fs.unlinkSync is fine on a missing path because we wrap
        // the call in try/catch.
        try { if (zipWritten && fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        return { canceled: true, jobId };
      }
      // Same cleanup on real errors: don't leave a 0-byte or partial
      // zip behind that the user might mistake for output.
      try { if (zipWritten && fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
      throw err;
    } finally {
      // Always remove the temp frames directory — success or not. fs.rm
      // with recursive+force is the right hammer here, ignoring EBUSY on
      // Windows when ffmpeg's release is briefly delayed.
      try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
      activeToolsJobs.delete(jobId);
    }
  });

  ipcMain.handle('tools:cancel', (_e, payload = {}) => {
    const jobId = payload && payload.jobId;
    if (!jobId) return { ok: false, reason: 'no_job_id' };
    const job = activeToolsJobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found' };
    job.killed = true;
    return { ok: true };
  });

  ipcMain.handle('tools:reveal_in_folder', (_e, p) => {
    const target = typeof p === 'string' ? p : (p && p.path);
    if (!target) return false;
    if (!fs.existsSync(target)) return false;
    try {
      shell.showItemInFolder(target);
      return true;
    } catch (e) {
      console.error('[tools] reveal_in_folder failed:', e);
      return false;
    }
  });

  // ---- Tools page: image → transparent PNG --------------------------------
  //
  //   tools:remove_image_background — open + save dialogs → cutout → PNG
  //
  // Shares the `activeToolsJobs` map, `tools:cancel` handler, and
  // `tools:progress` channel with the frame-splitter above: both are
  // cancellable, both report phase/percent, and neither should push image
  // bytes through IPC (a 24 MPix source is ~96 MB of RGBA). The decode /
  // cutout / re-encode pipeline lives in main/image_bg_remove.js, which
  // shares its cutout algorithm with the zip importer via
  // main/png_border_cutout.js.
  ipcMain.handle('tools:remove_image_background', async (_e, payload = {}) => {
    // `tolerance` is a named preset ("strict" / "normal" / "loose") rather
    // than a raw number so the renderer can't ask for a value the module
    // has no tuning for. It resolves to a 0-1 cost ceiling — how expensive
    // a pixel may be and still count as walkable background — not a
    // 0-255 colour distance. softness is the edge-feathering ring count,
    // 0-4.
    const tolerance = imageBgRemove.toleranceFor(payload && payload.tolerance);
    const softnessRaw = Number(payload && payload.softness);
    const softness = Number.isFinite(softnessRaw) ? Math.max(0, Math.min(4, Math.round(softnessRaw))) : 0;

    const pick = await dialog.showOpenDialog(winMain, {
      title: '选择图片',
      properties: ['openFile'],
      filters: [
        { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'tif', 'tiff'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
      return { canceled: true };
    }
    const inputPath = pick.filePaths[0];

    // Default the output name to <source>-transparent.png next to the
    // user's save location, so an accidental overwrite of the source is
    // at least an unlikely default.
    const stamp = backupStamp();
    const base = path.basename(inputPath, path.extname(inputPath));
    const defaultName = `${base}-transparent-${stamp}.png`;
    const save = await dialog.showSaveDialog(winMain, {
      title: '保存透明背景 PNG',
      defaultPath: defaultName,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (save.canceled || !save.filePath) {
      return { canceled: true };
    }
    const outPath = save.filePath;

    const jobId = `bgremove-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const job = { killed: false };
    activeToolsJobs.set(jobId, job);

    try {
      const result = await imageBgRemove.removeBackground({
        inputPath,
        outPath,
        tolerance,
        softness,
        cancelCheck: () => job.killed,
        progressCb: (info) => {
          if (job.killed) return;
          pushToolsProgress(jobId, info.phase, info.percent, info.note);
        },
      });
      return {
        canceled: false,
        path: outPath,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        transparentRatio: result.transparentRatio,
        jobId,
      };
    } catch (err) {
      if (job.killed || (err && err.killed)) {
        return { canceled: true, jobId };
      }
      throw err;
    } finally {
      activeToolsJobs.delete(jobId);
    }
  });

  // ---- Tools page: batch image resize -------------------------------------
  //
  //   tools:batch_resize_images — folder pickers → ffmpeg scale → output folder
  //
  // Shares the `activeToolsJobs` map, `tools:cancel` handler, and
  // `tools:progress` channel with the other two tools.
  //
  // This is the first tool in the app that picks *directories* rather than
  // a single file. Both pickers run in main (same convention as every
  // other dialog here) so the renderer never has to enumerate a folder
  // itself — the file listing, the format decisions, and the ffmpeg calls
  // all happen in the main process.
  //
  // The source folder is never written to. Output goes to a folder the
  // user picks, mirroring the source's sub-directory structure. main/
  // image_batch_resize.js additionally refuses to write into the source
  // tree or a sub-folder of it, so a mis-click can't destroy originals.
  ipcMain.handle('tools:batch_resize_images', async (_e, payload = {}) => {
    // The factor is a divisor: 2 means "shrink to half". Clamp it to the
    // range the module accepts so a bogus value can't reach ffmpeg.
    const factorRaw = Number(payload && payload.factor);
    const factor = Number.isFinite(factorRaw)
      ? Math.max(imageBatchResize.MIN_FACTOR, Math.min(imageBatchResize.MAX_FACTOR, factorRaw))
      : 2;
    const recursive = !(payload && payload.recursive === false);

    const srcPick = await dialog.showOpenDialog(winMain, {
      title: '选择要缩小的图片文件夹',
      properties: ['openDirectory'],
    });
    if (srcPick.canceled || !srcPick.filePaths || !srcPick.filePaths.length) {
      return { canceled: true };
    }
    const inputDir = srcPick.filePaths[0];

    // Default the output folder next to the source, named after it, so the
    // common case needs no thinking. The user can pick anywhere.
    const parentDir = path.dirname(inputDir);
    const baseName = path.basename(inputDir);
    const outPick = await dialog.showOpenDialog(winMain, {
      title: '选择输出文件夹',
      defaultPath: path.join(parentDir, `${baseName}-small`),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (outPick.canceled || !outPick.filePaths || !outPick.filePaths.length) {
      return { canceled: true };
    }
    const outputDir = outPick.filePaths[0];

    const jobId = `batchresize-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const job = { killed: false };
    activeToolsJobs.set(jobId, job);

    try {
      const result = await imageBatchResize.resizeBatch({
        inputDir,
        outputDir,
        factor,
        recursive,
        cancelCheck: () => job.killed,
        progressCb: (info) => {
          if (job.killed) return;
          pushToolsProgress(jobId, info.phase, info.percent, info.note);
        },
      });
      return {
        canceled: false,
        outputDir: result.outputDir,
        count: result.count,
        failed: result.failed,
        factor,
        jobId,
      };
    } catch (err) {
      if (job.killed || (err && err.killed)) {
        return { canceled: true, jobId };
      }
      throw err;
    } finally {
      activeToolsJobs.delete(jobId);
    }
  });

  // Node's event loop alive, and `main.js`'s before-quit handler is the one
  // place that already owns timer teardown, so we expose the cleanup rather
  // than hiding it behind a process listener here.
  shutdownFns.push(() => {
    clearInterval(idleSampler);
    petBubbles.stop();
    // The drag poller keeps the event loop alive on its own, so it has to be
    // torn down explicitly — otherwise the app would refuse to exit while a
    // drag was in flight.
    stopPetDrag();
  });

  // Sweep out data left behind by pets that no longer exist. Deleting a
  // pet now cleans up after itself (see `pet:remove_imported`), but rows
  // written by pets deleted BEFORE that fix are still in the database with
  // no way to find them from the UI. Pruning once at startup clears them.
  //
  // The registry is already populated by the time `register()` runs, so
  // the known-pet set is accurate here.
  try {
    const pruned = pruneOrphanedPetData();
    if (pruned.length) {
      console.log(`[pet] pruned data for ${pruned.length} removed pet(s): ${pruned.join(', ')}`);
    }
  } catch (e) {
    console.error('[pet] orphan prune failed:', e && e.message);
  }
}

function updatePetState({ queue, setPetState, setActiveReminder }) {
  // Reflect active (non-dismissed) reminders only. After a soft "完成"
  // the queue still contains the dismissed item, but the pet should drop
  // back to NORMAL — so we key off activeCount/activeHead here.
  const len = queue.activeCount();
  if (len > 0) {
    setPetState(true);
    setActiveReminder(queue.activeHead());
  } else {
    setPetState(false);
    setActiveReminder(null);
  }
}

// Soft-dismiss a reminder for today — the shared "关闭提醒" action.
//
// Called from three places, all of which must behave identically:
//   * the `reminders:complete_for_today` IPC (the main window's 完成
//     button, and the pet window's own dismissal),
//   * the pet's right-click menu item,
//   * the pet window's badge / bubble click.
//
// The reminder stops nagging — the badge disappears, the pet stops
// shaking, the top-bar pill goes back to 桌宠正常 — but the entry stays on
// the 今日 page so the user can still scroll back and confirm what they
// finished. A periodic reminder's next occurrence tomorrow is still
// scheduled normally.
function completeReminderForToday({ queue, setPetState, setActiveReminder, broadcastPetState }, source, sourceId) {
  queue.dismissForToday(source, sourceId);
  db.run(
    `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
     VALUES (?, ?, ?, NULL)`,
    [source, sourceId, db.nowStr()]
  );
  updatePetState({ queue, setPetState, setActiveReminder });
  // queue.dismissForToday → emit() → broadcastPetState() fires one
  // IPC, then updatePetState → setPetState(false) → a second. If
  // petState was already true the first call leaves
  // sprite.dataset.state='REMINDER' with count=0 in the renderer
  // (badge hidden but the shake animation continues) until the
  // second message lands. Force one authoritative broadcast so the
  // pet window flips back to NORMAL in one shot.
  broadcastPetState();
  try { petInteractions.trackActivity(db, 'reminder_completed', db.nowStr.bind(db)); } catch {}
  return true;
}

module.exports = { register, shutdown };