// main/preload_pdf_page.js — preload for the offscreen diary page
// (src/pdf_page.html).
//
// The page renders ONE memory note for the PDF export and nothing else.
// It gets a deliberately narrow bridge: the read-only entry lookup and
// the photo bytes it needs to draw the note, plus the render channel the
// main process drives it through.
//
// It does NOT get the main window's `mp` namespace — the export page has
// no business touching contacts, reminders, the pet or the settings. And
// it does not get the app's `api.js` wrapper: that wrapper is built
// around the whole app, and this page needs exactly two calls.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soulPdfPage', {
  // The entry the page is asked to draw.
  readEvent: (id) => ipcRenderer.invoke('memorial_events:get', id),
  // The bytes of one photo, as a data URL.
  readPhoto: (photoId) => ipcRenderer.invoke('memorial_events:photo_read', photoId),

  // The main process asks for a note to be drawn. The handler answers
  // with the size of the drawn note.
  //
  //   onRender(({ eventId, width }) => void)  — the request
  //   reply({ ok, width, height })             — the answer
  //
  // The two are separate calls rather than one `invoke` because the
  // request is a PULL: the main process asks, the page draws, and the
  // answer comes back when the drawing is done.
  onRender: (handler) => {
    ipcRenderer.on('export:pdf_page_render', (_e, payload) => {
      handler(payload || {});
    });
  },
  reply: (result) => ipcRenderer.send('export:pdf_page_reply', result),
  ready: () => ipcRenderer.send('export:pdf_page_ready'),
});
