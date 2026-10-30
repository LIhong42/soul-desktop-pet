// scripts/diary-test-preload.js — a preload for the diary editor test.
//
// The real preload (main/preload.js) exposes `window.mp` through
// contextBridge, which makes it read-only from the renderer — a test
// can't replace it. This preload exposes the SAME shape, but backed by an
// in-memory fake instead of the IPC bridge, so the renderer modules can be
// exercised without a database.
//
// Only the channels the diary feature touches are faked. Anything else
// throws, so a test that reaches for an unexpected channel fails loudly
// instead of silently getting undefined.

const { contextBridge } = require('electron');

const rows = {};
const uploads = [];
let nextId = 1;
let nextPhotoId = 1;

const mem = {
  list: async () => Object.values(rows),
  get: async (id) => rows[id] || null,
  create: async (payload) => {
    const id = 'e' + (nextId++);
    const row = Object.assign({ id, photos: [] }, payload);
    rows[id] = row;
    return row;
  },
  update: async (id, payload) => {
    rows[id] = Object.assign({}, rows[id], payload);
    return rows[id];
  },
  delete: async (id) => { delete rows[id]; return true; },
  deleteMany: async () => ({ deleted: 0 }),
  photos: {
    list: async () => [],
    // The real handler returns the stored photo row. The test needs a
    // real id so the editor can rewrite the document's temp ids.
    upload: async () => {
      const photo = {
        id: 'p' + (nextPhotoId++),
        original_name: 'photo.jpg',
        mime: 'image/jpeg',
      };
      uploads.push(photo);
      return photo;
    },
    delete: async () => true,
    read: async () => ({ data_url: '' }),
  },
};

const CONTACTS = [
  { id: 'c1', name: '小明', relationship: '朋友' },
  { id: 'c2', name: '小红' },
];

contextBridge.exposeInMainWorld('mp', {
  memorialEvents: mem,
  contacts: {
    list: async () => CONTACTS,
    get: async (id) => CONTACTS.find((c) => c.id === id) || null,
  },
});

// The test reaches the fake rows through a separate global so it can seed
// and inspect them without going through the renderer.
//
// NOTE: contextBridge CLONES the objects it exposes, so handing out the
// live `rows` object would let the test mutate a copy and see nothing.
// Every operation therefore goes through a function.
contextBridge.exposeInMainWorld('__testRows', {
  all: () => Object.assign({}, rows),
  seed: (id, row) => { rows[id] = row; return true; },
  clear: () => { for (const k of Object.keys(rows)) delete rows[k]; },
});

// The photos that were uploaded, in the order they were uploaded. The
// editor rewrites its temp ids with these, so a test can follow a photo
// from the pick to the saved document.
contextBridge.exposeInMainWorld('__testUploads', {
  all: () => uploads.slice(),
  clear: () => { uploads.length = 0; },
});
