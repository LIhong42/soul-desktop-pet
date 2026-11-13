// scripts/run-photo-wall-e2e.js — runs the photo wall's end-to-end test.
//
// The test needs a real Electron (a real browser rendering a real page),
// so it cannot be run by plain `node`. This is the Electron-side entry
// point: it starts the app, waits for the test's promise, and quits.
//
// Run: node scripts/run-electron.js scripts/run-photo-wall-e2e.js

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LOG = path.join(__dirname, '_photo_wall_e2e.log');
fs.writeFileSync(LOG, 'runner loaded\n');

const origLog = console.log;
const origErr = console.error;
const toFile = (tag, args) => {
  fs.appendFileSync(LOG, tag + ' ' + args.join(' ') + '\n');
};
console.log = (...a) => { toFile('LOG', a); origLog(...a); };
console.error = (...a) => { toFile('ERR', a); origErr(...a); };

process.on('uncaughtException', (e) => {
  fs.appendFileSync(LOG, 'UNCAUGHT: ' + ((e && e.stack) || e) + '\n');
});

app.whenReady().then(async () => {
  fs.appendFileSync(LOG, 'ready\n');
  try {
    await require('./test_photo_wall_e2e.js');
  } catch (e) {
    fs.appendFileSync(LOG, 'THREW: ' + ((e && e.stack) || e) + '\n');
    process.exitCode = 1;
  }
  fs.appendFileSync(LOG, 'done\n');
  app.quit();
});
