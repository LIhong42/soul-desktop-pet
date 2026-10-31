// scripts/drag-probe-preload.js — preload for the end-to-end drag test's
// probe window. It exposes just enough of the pet bridge for the test to
// drive a drag through the real IPC path.
//
// This is a fixture, not a temporary file: scripts/test-pet-drag-e2e.js
// loads it as the probe window's preload so the test can talk to the real
// `pet:drag_start` / `pet:drag_end` handlers in main/ipc.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp', {
  pet: {
    moveBy: (dx, dy) => ipcRenderer.invoke('pet:move_by', dx, dy),
    // The gesture id travels with both messages — the probe has to speak
    // the same protocol the real preload does, or the main process cannot
    // tell a stale message from a current one.
    dragStart: (dx, dy, gestureId) => ipcRenderer.invoke('pet:drag_start', dx, dy, gestureId),
    dragEnd: (gestureId) => ipcRenderer.invoke('pet:drag_end', gestureId),
    gestureBase: () => ipcRenderer.invoke('pet:gesture_base'),
  },
  on: () => () => {},
});
