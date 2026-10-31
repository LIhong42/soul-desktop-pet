// main/main.js — Electron entry: DB, scheduler, IPC, two windows
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const scheduler = require('./scheduler');
const ipc = require('./ipc');
const { PetController, petRenderSize } = require('./pet_controller');
const { PetRegistry } = require('./pet_registry');
const { buildPetState } = require('./pet_state');
const autostart = require('./autostart');
const appUpdate = require('./app_update');
const petDiagnostics = require('./pet_diagnostics');

const isDev = process.argv.includes('--dev') || !app.isPackaged;

// Surface unhandled rejections with a stack instead of Node's default one-
// liner. Prevents the cryptic "UnhandledPromiseRejectionWarning" that
// Electron emits otherwise when any awaitable chain in the main process
// rejects without a catch.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
});

// Single instance
//
// `app.requestSingleInstanceLock()` fails when another instance holds the
// lock. Two very different things can cause that, and they must not be
// treated the same:
//
//   * The user launched the app twice. The instance that is already running
//     is told about it (the 'second-instance' event below) and brings its
//     window up; this process quits.
//
//   * This process is the RELAUNCH of a dying instance. The wake recovery
//     kills the app and starts a new one (main/app_relaunch.js), and the
//     old process can still hold the lock for a moment after it was told
//     to die.
//
// The second case is the dangerous one. Quitting on a refused lock would
// leave the user with NO app at all — a far worse outcome than the bug the
// relaunch exists to fix. So the lock is asked for again for a few
// seconds before giving up.
//
// A refused lock CAN be asked for again: the lock is a named OS object
// that is released when its holder dies, and the request is a fresh
// attempt each time. `scripts/test-app-relaunch.js` proves both halves of
// that statement against a real Electron.
const LOCK_RETRY_MS = 6000;
const LOCK_RETRY_STEP_MS = 200;

// A synchronous sleep.
//
// The lock is taken before anything else happens — before a window exists,
// before the database is open — so waiting here costs nothing. It has to
// be synchronous because everything below it is module-level code.
function sleepSync(ms) {
  try {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
  } catch (e) {
    // A runtime without Atomics (or a locked main thread) must not stop the
    // app from starting: fall back to a busy wait.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

function acquireSingleInstanceLock() {
  if (app.requestSingleInstanceLock()) return true;
  const deadline = Date.now() + LOCK_RETRY_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    sleepSync(LOCK_RETRY_STEP_MS);
    attempts++;
    if (app.requestSingleInstanceLock()) {
      console.log(`[main] the single-instance lock was taken after ${attempts} retries`);
      return true;
    }
  }
  return false;
}

const gotLock = acquireSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let winMain = null;
let winPet = null;
let petState = false; // false = NORMAL, true = REMINDER
let activeReminder = null;
let petController = null;
let petRegistryRef = null; // cached for createWindows() to read after init

function setPetState(v) {
  if (petState === v) return;
  petState = v;
  broadcastPetState();
}

function getPetState() { return petState; }

function setActiveReminder(r) { activeReminder = r; }

function broadcastPetState() {
  // The payload shape lives in main/pet_state.js so this broadcast and the
  // `pet:get_state` IPC (the pet window's initial read) cannot drift.
  const payload = buildPetState({ petState, queue });
  if (winPet && !winPet.isDestroyed()) winPet.webContents.send('pet:state-changed', payload);
  if (winMain && !winMain.isDestroyed()) winMain.webContents.send('pet:state-changed', payload);
}

const queue = new scheduler.ReminderQueue();
queue.on((payload) => {
  broadcastPetState();
});

// Create the pet window.
//
// This is a function of its own, not a block of code inside `createWindows`,
// because the wake recovery DESTROYS AND RECREATES the pet window (see
// `recreatePetWindow`): a window that comes back from a system sleep can be
// a window whose input path is broken — the renderer keeps receiving IPC, so
// the pet looks alive, but the mouse never reaches it again and the pet can
// no longer be dragged. A brand-new window has a brand-new native window
// and a brand-new input registration, so whatever the sleep broke is gone.
//
// `x` / `y` / `width` / `height` override the persisted position and the
// manifest's default size — that is how the recreated window keeps the place
// the user left the pet in.
function createPetWindow({ petRegistry, x, y, width, height } = {}) {
  const petX = parseInt(db.getSetting('pet_x') || '200', 10);
  const petY = parseInt(db.getSetting('pet_y') || '200', 10);

  // Size the pet window from the current pet's manifest.defaultSize. Falls
  // back to a 220×220 square when no pet has been resolved yet (first
  // launch with an empty registry) — pet.js's CSS variables also default to
  // 220px so the first frame doesn't flash at the wrong size.
  //
  // The fallback here is the SPRITE size, not the window size: the window is
  // taller by the bubble headroom (see petRenderSize / BUBBLE_HEADROOM_PX).
  // pet.js's CSS defaults to the same sprite size and the controller sends
  // the real window size on `pet:size-changed` a moment later, so a brief
  // mismatch here just means one clipped frame before the first bubble.
  let initialW = 220, initialH = 220;
  if (petRegistry) {
    const persisted = db.getSetting('pet_id');
    const first = petRegistry.list()[0];
    const id = (persisted && petRegistry.getManifest(persisted)) ? persisted
      : (first && first.id);
    if (id) {
      const m = petRegistry.getManifest(id);
      const s = petRenderSize(m && m.defaultSize);
      initialW = s.w;
      initialH = s.h;
    }
  }

  const w = new BrowserWindow({
    width: width || initialW,
    height: height || initialH,
    x: x === undefined ? petX : x,
    y: y === undefined ? petY : y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    focusable: false,
    show: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'pet', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  w.setIgnoreMouseEvents(false); // CSS hit-target handles click-through; we keep mouse events ON.
  w.loadFile(path.join(__dirname, '..', 'src', 'pet.html'));
  w.setAlwaysOnTop(true, 'screen-saver');

  w.on('moved', () => {
    if (!w.isDestroyed()) {
      const [mx, my] = w.getPosition();
      db.setSetting('pet_x', String(mx));
      db.setSetting('pet_y', String(my));
    }
  });

  // The window's own load events go into the diagnostic log, so the log can
  // tell "the pet's page never loaded" apart from "the page loaded and the
  // mouse still does not arrive".
  w.webContents.on('did-finish-load', () => {
    try {
      petDiagnostics.append({ src: 'main', kind: 'pet_window_loaded', win: w.getPosition() });
    } catch (e) { /* diagnostics must never break the app */ }
  });
  w.webContents.on('did-fail-load', (_e, code, desc) => {
    try {
      petDiagnostics.append({ src: 'main', kind: 'pet_window_load_failed', code, desc });
    } catch (e) { /* diagnostics must never break the app */ }
  });

  return w;
}

// Restart the pet: destroy the pet window and create a new one in its
// place.
//
// This is the "just restart the pet" recovery — the user's explicit request
// for the "the pet cannot be dragged after a sleep" bug. Everything that
// could have been broken by the sleep (the gesture state, the pointer
// captures, the preload bridge, the native window's input registration) dies
// with the old window.
//
// What is preserved: the window's position and size, the main window, the
// database and the pet's identity. What changes: the pet's page is built
// from scratch, which is the whole point.
//
// The collaborators that hold the pet window are updated here, so the pet
// keeps walking, keeps answering the reminder badge and keeps listening to
// the pet's own IPC.
function recreatePetWindow(reason) {
  const old = winPet;
  let pos = null;
  let size = null;
  try {
    if (old && !old.isDestroyed()) {
      pos = old.getPosition();
      const b = old.getBounds();
      size = { width: b.width, height: b.height };
    }
  } catch (e) { /* the old window may already be gone */ }

  // The NEW window is created FIRST, and the old one is destroyed after.
  //
  // The order matters: destroying the last window makes Electron quit the
  // app (that is the default when no 'window-all-closed' handler says
  // otherwise), so the replacement has to exist before the original goes
  // away. The two windows overlap for a fraction of a millisecond — the pet
  // blinks once, which is exactly what a restart looks like.
  const next = createPetWindow({
    petRegistry: petRegistryRef,
    x: pos ? pos[0] : undefined,
    y: pos ? pos[1] : undefined,
    width: size ? size.width : undefined,
    height: size ? size.height : undefined,
  });
  winPet = next;

  try {
    if (old && !old.isDestroyed()) old.destroy();
  } catch (e) {
    console.error('[main] could not destroy the pet window:', e);
  }

  // The controller moves the window on its own — it has to be told about
  // the new one, or the pet would keep trying to move a window that no
  // longer exists.
  if (petController && typeof petController.setWindow === 'function') {
    try { petController.setWindow(winPet); } catch (e) {
      console.error('[main] could not point the pet controller at the new window:', e);
    }
  }

  try {
    petDiagnostics.append({
      src: 'main',
      kind: 'pet_window_recreated',
      reason: reason || 'resume',
      pos: pos,
      size: size,
    });
  } catch (e) { /* diagnostics must never break the app */ }

  return winPet;
}

function createWindows({ petRegistry } = {}) {
  winPet = createPetWindow({ petRegistry });

  // Display configuration changed — a monitor was plugged/unplugged, the
  // resolution changed, a dock was undocked.
  //
  // The OS can leave the pet window parked outside the new work area, where
  // the user cannot reach it to drag it back. Pull it into view.
  //
  // This also fires around a system resume (the display layout is
  // re-evaluated then), which is the same failure mode.
  const onDisplayChanged = () => {
    if (!petController || typeof petController.clampIntoView !== 'function') return;
    try { petController.clampIntoView(); } catch (e) {
      console.error('[main] could not re-clamp the pet into view:', e);
    }
  };
  screen.on('display-added', onDisplayChanged);
  screen.on('display-removed', onDisplayChanged);
  screen.on('display-metrics-changed', onDisplayChanged);

  winMain = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    center: true,
    title: 'SoulDesktopPet',
    // Packaged builds inherit the icon from the exe resource, but dev runs
    // (plain electron.exe) would otherwise show the default Electron logo.
    icon: path.join(__dirname, '..', 'icons', 'icon.png'),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  winMain.removeMenu();
  winMain.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  winMain.once('ready-to-show', () => {
    // Main window starts hidden — user opens it via pet click or Settings.
    // In dev mode, always show the main window on launch so the developer
    // can iterate on the UI without having to click the pet each time.
    if (isDev) {
      winMain.show();
      winMain.focus();
    }
  });

  if (isDev) {
    winMain.webContents.on('did-finish-load', () => {
      winMain.webContents.openDevTools({ mode: 'detach' });
    });
  }
}

function getDbPath() {
  // %APPDATA%/SoulDesktopPet/soul-desktop-pet.db
  const dir = path.join(app.getPath('appData'), 'SoulDesktopPet');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'soul-desktop-pet.db');
}

app.on('second-instance', () => {
  if (winMain && !winMain.isDestroyed()) {
    if (!winMain.isVisible()) winMain.show();
    winMain.focus();
  }
});

app.whenReady().then(async () => {
  await db.open(getDbPath());

  // Align the Windows Run key with what the user last asked for. First launch
  // opts in by default (see syncOnLaunch); later launches honour the stored
  // choice. No-op in dev — autostart is packaged-build only, so `npm start`
  // never registers electron.exe as a startup entry.
  autostart.syncOnLaunch(db);

  // Scan pet resources before creating the controller so the controller can
  // pick a valid petId from the registry on construction.
  const petRegistry = new PetRegistry();
  await petRegistry.init({
    appPath: path.join(__dirname, '..'),
    userDataPath: path.join(app.getPath('appData'), 'SoulDesktopPet'),
  });

  petRegistryRef = petRegistry;
  createWindows({ petRegistry });

  // Start the autonomous-movement state machine. Created here (after the
  // pet window exists) so it has a window reference to translate.
  petController = new PetController({ winPet, db, petRegistry });
  petController.start();

  ipc.register({
    queue,
    winMain,
    winPet,
    // The pet window can be destroyed and recreated by the wake recovery,
    // so the modules that talk to it resolve it through a getter instead
    // of holding the window that existed at startup.
    getWinPet: () => winPet,
    recreatePetWindow,
    setPetState,
    getPetState,
    setActiveReminder,
    broadcastPetState,
    petController,
    petRegistry,
  });

  scheduler.start({
    app,
    winMain,
    queue,
    getPetState,
    setPetState,
    setActiveReminder,
    petController,
  });

  // Bond pipeline — 1s tick that drives cozy decay, mood decision tree,
  // and weekly settlement. Started after scheduler.start() so the reminder
  // queue is already pushing activeCount() correctly into the mood payload.
  scheduler.startBondPipeline({
    petController, winPet, getWinPet: () => winPet, winMain, queue, petRegistry,
  });

  // 每日自动检查更新（更新源为 GitHub Releases）。首次检查延迟
  // FIRST_CHECK_DELAY_MS，之后每 24 小时一次，且距上次检查不足一天会跳过
  // ——所以重启应用不会每次都联网。检查是静默的：只更新内部状态，不弹窗，
  // 用户在设置页能看到「有新版本」提示。
  //
  // 用户在设置里重新勾选「自动检查更新」时，ipc.js 会回调下面这个钩子来
  // 重启调度器；没有它的话，定时器会在 stopDailyCheck 之后再也不恢复。
  const runUpdateCheck = () => {
    appUpdate.checkForUpdate(db).then((r) => {
      if (r.ok && r.hasUpdate) {
        console.log(`[app_update] 有新版本：${r.info.version}（当前 ${r.info.currentVersion}）`);
      }
    });
  };
  appUpdate.onEnableToggled(() => {
    appUpdate.startDailyCheck(db, runUpdateCheck);
  });
  appUpdate.startDailyCheck(db, runUpdateCheck);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows({ petRegistry: petRegistryRef });
  });
});

app.on('window-all-closed', () => {
  // Quit on Windows/Linux when both windows close. The pet window itself has
  // no close button (frame:false), so this only fires after the main window
  // is closed too — or via the explicit "退出 SoulDesktopPet" button in Settings.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  scheduler.stop();
  scheduler.stopBondPipeline();
  appUpdate.stopDailyCheck();
  // Drains ipc.js's registered timers (currently the bubble engine's 1s
  // tick + the idle sampler). Called before db.save() so any final
  // bubble-state write lands in the snapshot we persist.
  ipc.shutdown();
  if (petController) petController.stop();
  try { db.save(); } catch (e) { console.error('db save error:', e); }
});