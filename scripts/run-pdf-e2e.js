// scripts/run-pdf-e2e.js — runs the PDF export's end-to-end test.
//
// The test needs a real Electron (a real browser rendering a real page),
// so it cannot be run by plain `node`. This is the Electron-side entry
// point: it starts the app, waits for the test's promise, and quits.
//
// Run: node scripts/run-electron.js scripts/run-pdf-e2e.js

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LOG = path.join(__dirname, '_pdf_e2e.log');
fs.writeFileSync(LOG, 'runner loaded\n');

// Electron's main-process console only reaches the terminal when the
// process is attached to one; a file is the reliable place for it.
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
    // The test file exports a PROMISE and the runner waits for it. The test
    // IS the export, so the app has to stay alive until the export has
    // finished — quitting early kills the export half-way and the test
    // never reaches its verdict.
    await require('./test_pdf_export_e2e.js');
  } catch (e) {
    fs.appendFileSync(LOG, 'THREW: ' + ((e && e.stack) || e) + '\n');
    process.exitCode = 1;
  }
  fs.appendFileSync(LOG, 'done\n');
  app.quit();
});
