// scripts/diary-media-preload.js — the preload for the media test.
//
// The real preload (main/preload.js) hands out the whole IPC bridge,
// and this test wants exactly that: the media goes through the REAL
// handlers, against the REAL database, onto the REAL disk.
//
// The real preload calls `contextBridge.exposeInMainWorld` itself, and a
// bridge name can only be exposed once per page. So this preload does
// not load it directly: it reads the real preload's SOURCE, runs it
// with a stand-in `contextBridge` that captures what it would expose,
// and then exposes the captured object — plus this test's own two
// files — for real.

const { contextBridge } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const PRELOAD = path.join(__dirname, '..', 'main', 'preload.js');

// Run the real preload's source with a stand-in contextBridge, so we
// can see what it would expose without exposing it.
const source = fs.readFileSync(PRELOAD, 'utf-8');
let captured = null;
const sandboxModule = { exports: {} };
const fakeRequire = (id) => {
  if (id === 'electron') {
    return {
      contextBridge: {
        exposeInMainWorld: (name, value) => { captured = value; },
      },
      ipcRenderer: require('electron').ipcRenderer,
    };
  }
  return require(id);
};
const sandboxRequire = fakeRequire;
vm.runInThisContext(
  `(function (require, module, exports, __filename, __dirname) {\n${source}\n})`
)(sandboxRequire, sandboxModule, sandboxModule.exports, PRELOAD, path.dirname(PRELOAD));
if (!captured) throw new Error('the real preload exposed nothing');

// The test writes the two files into a scratch directory whose path is
// fixed for the run, so both sides can find them without a handshake.
const tmpDir = path.join(os.tmpdir(), 'soul-diary-media-test');
const videoFile = path.join(tmpDir, '我的 视频.mp4');
const audioFile = path.join(tmpDir, 'song.mp3');

// The bytes of the two test files, read on demand.
function fileBytes(p) {
  try { return Array.from(fs.readFileSync(p)); } catch (e) { return []; }
}

contextBridge.exposeInMainWorld('mp', captured);
contextBridge.exposeInMainWorld('__mediaBytes', (which) => (
  which === 'video' ? fileBytes(videoFile) : fileBytes(audioFile)
));

// A preload that throws leaves the page without its bridge, and the
// failure is otherwise silent — so it is reported on the console.
process.on('uncaughtException', (e) => {
  console.error('diary-media-preload failed:', e);
});
