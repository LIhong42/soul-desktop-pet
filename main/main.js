// main/main.js — Electron entry: DB, scheduler, IPC, two windows
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const scheduler = require('./scheduler');
const ipc = require('./ipc');
const { PetController, petRenderSize } = require('./pet_controller');
const { PetRegistry } = require('./pet_registry');
const autostart = require('./autostart');

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
const gotLock = app.requestSingleInstanceLock();
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
  // Use the active (non-dismissed) subset for both the count and the head
  // bubble. Dismissed items stay in the queue but should not nag the user.
  const activeHead = queue.activeHead();
  const payload = {
    state: petState ? 'REMINDER' : 'NORMAL',
    count: queue.activeCount(),
    // Carry enough of `head` that the pet window can render a meaningful
    // speech bubble without an extra round-trip back to us. Fields are
    // already on the head object (see scheduler.ReminderQueue → scanAndFire).
    head: activeHead ? {
      title: activeHead.title,
      contact_name: activeHead.contact_name || null,
      description: activeHead.description || null,
    } : null,
  };
  if (winPet && !winPet.isDestroyed()) winPet.webContents.send('pet:state-changed', payload);
  if (winMain && !winMain.isDestroyed()) winMain.webContents.send('pet:state-changed', payload);
}

const queue = new scheduler.ReminderQueue();
queue.on((payload) => {
  broadcastPetState();
});

function createWindows({ petRegistry } = {}) {
  const petX = parseInt(db.getSetting('pet_x') || '200', 10);
  const petY = parseInt(db.getSetting('pet_y') || '200', 10);

  // Size the pet window from the current pet's manifest.defaultSize. Falls
  // back to a 220×220 square when no pet has been resolved yet (first
  // launch with an empty registry) — pet.js's CSS variables also default to
  // 220px so the first frame doesn't flash at the wrong size.
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

  winPet = new BrowserWindow({
    width: initialW,
    height: initialH,
    x: petX,
    y: petY,
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
  winPet.setIgnoreMouseEvents(false); // CSS hit-target handles click-through; we keep mouse events ON.
  winPet.loadFile(path.join(__dirname, '..', 'src', 'pet.html'));
  winPet.setAlwaysOnTop(true, 'screen-saver');

  winPet.on('moved', () => {
    if (!winPet || winPet.isDestroyed()) return;
    const [x, y] = winPet.getPosition();
    db.setSetting('pet_x', String(x));
    db.setSetting('pet_y', String(y));
  });

  winMain = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    center: true,
    title: 'SoulDesktopPet',
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
    winPet,
    queue,
    getPetState,
    setPetState,
    setActiveReminder,
    petController,
  });

  // Bond pipeline — 1s tick that drives cozy decay, mood decision tree,
  // and weekly settlement. Started after scheduler.start() so the reminder
  // queue is already pushing activeCount() correctly into the mood payload.
  scheduler.startBondPipeline({ petController, winPet, winMain, queue, petRegistry });

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
  if (petController) petController.stop();
  try { db.save(); } catch (e) { console.error('db save error:', e); }
});