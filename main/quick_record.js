// main/quick_record.js — the "记录" quick-capture window.
//
// Opened from the pet's right-click menu (pet:context_menu → 📝 记录 →
// one of the six record kinds). The window is deliberately SEPARATE from the
// main window: the main window is PIN-gated, and the whole point of this
// flow is to capture a record without unlocking it.
//
// Why a separate BrowserWindow rather than a layer inside the pet window:
// the pet window is ~215×320px (see BUBBLE_SIDE_ROOM_PX /
// BUBBLE_HEADROOM_PX in main/pet_controller.js) — far too small for a form
// with a contact picker, a date picker and several text fields. A separate
// window also lets the pet keep animating in the corner while the user
// fills the form in.
//
// The window is reused across invocations (one instance, re-targeted with a
// new record kind) so repeated captures don't spawn a pile of windows.
//
// Everything the form writes goes through the SAME ipcMain handlers the main
// window uses (attributes:create / events:create / memorial_events:create),
// so validation, search indexing and bond tracking stay in one place.

const { BrowserWindow } = require('electron');
const path = require('path');

// The six record kinds the menu offers. `icon` is the emoji shown on the
// menu item; `label` is the human name used in the window's title bar.
const RECORD_KINDS = [
  { id: 'like',     label: '喜好',     icon: '💖' },
  { id: 'taboo',    label: '忌讳',     icon: '🚫' },
  { id: 'gift',     label: '礼物',     icon: '🎁' },
  { id: 'reminder', label: '提醒日期', icon: '⏰' },
  { id: 'memorial', label: '回忆事件', icon: '🎞️' },
  { id: 'work',     label: '工作事件', icon: '💼' },
];

const RECORD_KIND_IDS = new Set(RECORD_KINDS.map((k) => k.id));

// Window geometry. The forms are field-for-field the same as the main
// window's, so the tallest one (回忆事件 — five text fields, a multi-contact
// picker and a photo picker) needs more room than the earlier trimmed-down
// version did. The panel scrolls (`.qr { overflow-y: auto }`), so the
// window never has to grow past the screen; the height here is just a
// comfortable default that keeps the common case (one or two fields)
// scroll-free.
const WIN_WIDTH = 400;
const WIN_HEIGHT = 640;

// The single live instance, if any. Reused on every capture.
let winQuick = null;

// The kind the window is currently showing. Held here (not just in the
// renderer) so a second invocation while the window is open can retarget
// it instead of opening a competing window.
let currentKind = null;

// Show the window for `kindId`. Returns true when the window was opened or
// focused. Unknown kinds are rejected — the caller passes a fixed table.
function show(kindId) {
  if (!RECORD_KIND_IDS.has(kindId)) return false;

  const kind = RECORD_KINDS.find((k) => k.id === kindId);
  currentKind = kindId;

  if (winQuick && !winQuick.isDestroyed()) {
    // Already open: retarget the existing window rather than spawning a
    // second one. `loadFile` again so the renderer picks up the new kind.
    retarget(winQuick, kindId);
    winQuick.show();
    winQuick.focus();
    return true;
  }

  winQuick = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: 320,
    minHeight: 400,
    show: false,
    title: `记录 · ${kind.label}`,
    icon: path.join(__dirname, '..', 'icons', 'icon.png'),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '..', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  winQuick.removeMenu();
  winQuick.loadFile(path.join(__dirname, '..', 'src', 'quick_record.html'));

  winQuick.once('ready-to-show', () => {
    if (winQuick && !winQuick.isDestroyed()) winQuick.show();
  });

  // When the user closes the window, drop the reference so the next capture
  // opens a fresh one (and so `isDestroyed()` checks stay meaningful).
  winQuick.on('closed', () => {
    winQuick = null;
    currentKind = null;
  });

  return true;
}

// Point an already-open window at a different record kind. The renderer
// asks for its kind over `quick-record:get_kind` on boot, so retargeting
// is just a state change — no message needs to be pushed. We DO reload the
// page so the renderer starts from a clean slate: a half-filled form for
// the previous kind must not leak into the new one.
function retarget(win, kindId) {
  currentKind = kindId;
  win.setTitle(`记录 · ${(RECORD_KINDS.find((k) => k.id === kindId) || {}).label || ''}`);
  win.webContents.reload();
}

// The kind the window should open with. Answered to the renderer's
// `quick-record:get_kind` request.
//
// This is a pull, not a push, on purpose: the renderer is an ES module, so
// its `on('quick-record:kind')` listener may not be registered yet when
// `did-finish-load` fires — a message sent at that moment would be
// dropped and the window would sit on the type picker with no kind
// selected. The renderer asking once it has finished booting has no such
// race.
function getKind() {
  return currentKind;
}

// Close the window (used when the record is saved and the user asked for
// the window to get out of the way).
function close() {
  if (winQuick && !winQuick.isDestroyed()) winQuick.close();
  winQuick = null;
  currentKind = null;
}

function isOpen() {
  return !!(winQuick && !winQuick.isDestroyed());
}

module.exports = {
  RECORD_KINDS,
  RECORD_KIND_IDS,
  show,
  close,
  isOpen,
  getKind,
  get currentKind() { return currentKind; },
};
