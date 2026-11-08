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
// The bytes the fake photo reader hands back, keyed by photo id. A
// preview can seed real pictures here so the list shows photographs
// instead of empty boxes.
const photoBytes = {};
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
    read: async (photoId) => ({ data_url: photoBytes[photoId] || '' }),
  },
};

const CONTACTS = [
  { id: 'c1', name: '小明', relationship: '朋友' },
  { id: 'c2', name: '小红' },
];

// The reminder-event table. The 工作事件 page reads from here (the
// 回忆事件 page has its own table — see `memorialEvents` above). Kept
// separate so a test that seeds one table cannot leak into the other.
const eventRows = {};

const events = {
  list: async () => Object.values(eventRows),
  get: async (id) => eventRows[id] || null,
  create: async (payload) => {
    const id = 'v' + (nextId++);
    eventRows[id] = Object.assign({ id }, payload);
    return eventRows[id];
  },
  update: async (id, payload) => {
    eventRows[id] = Object.assign({}, eventRows[id], payload);
    return eventRows[id];
  },
  delete: async (id) => { delete eventRows[id]; return true; },
  deleteMany: async () => ({ deleted: 0 }),
  listToday: async () => [],
  listFestivals: async () => [],
  debugFireDueNow: async () => null,
};

// The 抽卡人生 cards. The editor asks for the card it was opened from,
// so that the card's title and requirement can pre-fill the page. The
// fake holds a couple of cards and records the links the editor makes.
const cardRows = {};
const cardLinks = [];

contextBridge.exposeInMainWorld('mp', {
  memorialEvents: mem,
  events,
  contacts: {
    list: async () => CONTACTS,
    get: async (id) => CONTACTS.find((c) => c.id === id) || null,
  },
  cardDraws: {
    get: async (id) => cardRows[id] || null,
    link: async (id, eventId) => {
      cardLinks.push({ id, eventId });
      if (cardRows[id]) cardRows[id].memorial_event_id = eventId;
      return cardRows[id] || null;
    },
    state: async () => ({ weekKey: '', weekLabel: '', history: [], card: null }),
    draw: async () => ({ ok: false, error: 'not available in the test' }),
    progress: async () => ({ entries: [], weeks: 0, done: 0, pending: 0, rate: 0, streak: 0, best: 0, threshold: 30 }),
    customList: async () => [],
    customCreate: async () => null,
    customDelete: async () => true,
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

// The reminder-event table, reached the same way. The 工作事件 page's
// bulk-select round trip is checked against this one.
contextBridge.exposeInMainWorld('__testEventRows', {
  all: () => Object.assign({}, eventRows),
  seed: (id, row) => { eventRows[id] = row; return true; },
  clear: () => { for (const k of Object.keys(eventRows)) delete eventRows[k]; },
});

// The photos that were uploaded, in the order they were uploaded. The
// editor rewrites its temp ids with these, so a test can follow a photo
// from the pick to the saved document.
contextBridge.exposeInMainWorld('__testUploads', {
  all: () => uploads.slice(),
  clear: () => { uploads.length = 0; },
});

// The bytes the fake photo reader hands back. A preview seeds real
// pictures here so the list shows photographs rather than empty boxes.
contextBridge.exposeInMainWorld('__testPhotos', {
  set: (id, dataUrl) => { photoBytes[id] = dataUrl; return true; },
  all: () => Object.assign({}, photoBytes),
});

// The 抽卡人生 cards the fake holds, and the links the editor made to
// them. A test seeds a card to check that the editor pre-fills the page
// from it, and reads the links to check that saving links the new entry
// back to the card.
contextBridge.exposeInMainWorld('__testCards', {
  all: () => Object.assign({}, cardRows),
  seed: (id, row) => { cardRows[id] = row; return true; },
  clear: () => { for (const k of Object.keys(cardRows)) delete cardRows[k]; },
  links: () => cardLinks.slice(),
  clearLinks: () => { cardLinks.length = 0; },
});
