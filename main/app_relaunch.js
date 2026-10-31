// main/app_relaunch.js — the last-resort recovery: restart the whole app.
//
// Why this exists
// ---------------
// Everything else in the wake-recovery chain (main/pet_resume.js, the
// pet-window restart in main/main.js, the renderer-side gesture repair in
// src/js/pet.js) repairs the app FROM THE INSIDE. That is enough for
// everything except one failure:
//
//   **A renderer that is alive but deaf.**
//
//   After a system suspend the pet window can keep answering IPC — it
//   replies to `pet:resume`, so it looks perfectly healthy — while not a
//   single mouse event ever reaches it again. The renderer is fine; the
//   WINDOW's input registration is not.
//
//   The reason an in-process repair cannot fix it: a pointer event is
//   built by Chromium's `PointerEventFactory`, which needs a *registered
//   pointer device*. A suspend tears the device down and the OS brings it
//   back as a new one, and the browser process's device registry can end
//   up not knowing about it. The legacy mouse events do not need a device,
//   which is why they keep arriving — and why the right-click menu still
//   opens while the pet cannot be dragged.
//
//   The device registry lives in the BROWSER PROCESS and is shared by
//   every window, so a new window inherits the broken registry (which is
//   why restarting the pet window is not enough) and a page reload
//   certainly does.
//
// The only cure left is a new PROCESS: the browser process is started
// fresh, the pointer device is registered from scratch, and the pet is
// draggable again.
//
// What it does
// ------------
// `app.relaunch()` asks the OS to start a new instance of this executable
// (with the same arguments) and `app.exit(0)` ends this one immediately.
// The new instance starts a fresh browser process.
//
// The arguments are passed explicitly. The default would be
// `process.argv.slice(1)` anyway, but being explicit means the restart
// works the same whether the app was started by `npm start` (`electron .`)
// or from a packaged build.
//
// `app.exit(0)` is used rather than `app.quit()` on purpose: `quit` runs
// the `before-quit` / `will-quit` handlers and can be vetoed, and a vetoed
// quit would leave the relaunch half-done — two instances of the app, with
// the second one holding the database. `exit` cannot be vetoed.
//
// The database is written to disk on a five-second timer, and `exit` skips
// the normal shutdown path, so anything written in the last few seconds
// would be lost. The wake recovery therefore FLUSHES the database itself
// (main/ipc.js, `recoverPetAfterResume`) before it asks for the restart —
// the project stores its data in an in-memory SQLite that is written back to
// a single file, so an unflushed write is simply gone.

'use strict';

const { app } = require('electron');

// Restart the application.
//
// `reason` says why — it goes into the console and into the diagnostic
// log, so a restart can be lined up with the wake that caused it.
//
// `args` overrides the launch arguments. The default is the arguments this
// process was started with, so `electron .` and a packaged build both come
// back the way they went in.
//
// Returns true when the restart was requested.
function relaunchApp(reason, args) {
  try {
    console.log('[app_relaunch] restarting the app:', reason || 'unspecified');
    // The same arguments this process was started with, so `electron .`
    // and a packaged build both come back the way they went in.
    app.relaunch({ args: Array.isArray(args) ? args : process.argv.slice(1) });
    // `exit` — not `quit`: it cannot be vetoed, so there is never a
    // half-finished restart.
    app.exit(0);
    return true;
  } catch (e) {
    console.error('[app_relaunch] could not restart the app:', e);
    return false;
  }
}

module.exports = { relaunchApp };
