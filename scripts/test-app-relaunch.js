// scripts/test-app-relaunch.js — regression test for the "kill the process
// and start a new one" wake recovery.
//
// THE STAKES
// ----------
// The wake recovery's last resort is to kill the running app and start a
// new one (see main/app_relaunch.js). That is a heavy-handed fix, and it
// has exactly one unacceptable outcome: **the app does not come back**.
//
// The app takes the single-instance lock (main/main.js). The relaunched
// process asks for the same lock. If the old process has not released it
// yet, the new one is told "another instance is already running" — and
// main.js quits on that answer. The user would be left with NO app at all,
// which is worse than the bug this whole mechanism exists to fix.
//
// So this test answers the three questions that decide whether the relaunch
// survives:
//
//   1. Is the lock exclusive? (A second live instance must not get it.)
//   2. Can a process that was refused the lock ask again later? (The
//      answer decides whether the fix is "retry the lock" or "wait for the
//      old process to be gone before asking".)
//   3. Does the real `app.relaunch()` + `app.exit(0)` sequence actually
//      produce a RUNNING new instance that holds the lock?
//
// Usage: node scripts/run-electron.js scripts/test-app-relaunch.js

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SELF = path.join(__dirname, 'test-app-relaunch.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

// ---------------------------------------------------------------------------
// The child: asks for the lock, retrying until it gets it, and writes the
// answer to a file (a relaunched process does not inherit our console).
// ---------------------------------------------------------------------------
if (argOf('child')) {
  (async () => {
    // `--child=<file>` — the file is where the answer is written.
    const resultFile = argOf('child');
    const startedAt = Date.now();
    let got = false;
    let attempts = 0;
    while (Date.now() - startedAt < 20000) {
      attempts++;
      if (app.requestSingleInstanceLock()) { got = true; break; }
      await sleep(200);
    }
    try {
      fs.writeFileSync(resultFile,
        `lock=${got ? 'got' : 'timeout'} attempts=${attempts} waitedMs=${Date.now() - startedAt}`);
    } catch (e) { /* the test cannot write → the parent will time out */ }
    app.exit(0);
    setTimeout(() => process.exit(0), 100);
  })();
} else if (argOf('victim')) {
  // The victim holds the lock and then relaunches itself — exactly what
  // main/app_relaunch.js does on a wake.
  app.whenReady().then(async () => {
    const got = app.requestSingleInstanceLock();
    if (!got) { app.exit(1); return; }
    const { relaunchApp } = require(path.join(ROOT, 'main', 'app_relaunch.js'));
    relaunchApp('test', [SELF, `--child=${argOf('result')}`]);
    // `relaunchApp` calls app.exit(0) itself.
    setTimeout(() => app.exit(0), 2000);
  });
} else {
  app.whenReady().then(async () => {
    console.log('app relaunch regression test (real Electron)');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-relaunch-'));

    // -------------------------------------------------------------------
    // [1] The lock is exclusive.
    // -------------------------------------------------------------------
    console.log('\n[1] the single-instance lock is exclusive');
    const firstTry = app.requestSingleInstanceLock();
    check('the first instance gets the lock', firstTry === true, String(firstTry));

    const resultFile1 = path.join(tmp, 'r1.txt');
    const child1 = spawn(process.execPath,
      [SELF, `--child=${resultFile1}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err1 = '';
    child1.stderr.on('data', (d) => { err1 += d.toString(); });
    await sleep(2500);
    check('a second live instance is refused the lock',
      !fs.existsSync(resultFile1) || /lock=timeout/.test(fs.readFileSync(resultFile1, 'utf8')),
      err1.slice(0, 200));

    // -------------------------------------------------------------------
    // [2] A refused lock can be asked for again.
    // -------------------------------------------------------------------
    console.log('\n[2] a refused lock can be asked for again');
    app.releaseSingleInstanceLock();
    // The child keeps retrying; once the lock is free it must get it.
    const deadline = Date.now() + 20000;
    let answer = '';
    while (Date.now() < deadline) {
      if (fs.existsSync(resultFile1)) { answer = fs.readFileSync(resultFile1, 'utf8'); break; }
      await sleep(200);
    }
    check('the second instance gets the lock once it is released',
      /lock=got/.test(answer), answer.trim() || 'no answer');
    check('the refusal was retried, not given up on', /attempts=(1[0-9]|[2-9])/.test(answer), answer.trim());

    // -------------------------------------------------------------------
    // [3] The real relaunch: app.relaunch() + app.exit(0).
    // -------------------------------------------------------------------
    console.log('\n[3] the real relaunch brings the app back');
    // The victim holds the lock, relaunches and exits — the exact sequence
    // of main/app_relaunch.js. The relaunched instance must come up and
    // get the lock; if the relaunch were racy it would be refused (the old
    // process still held the lock) and the app would have quit.
    const resultFile3 = path.join(tmp, 'r3.txt');
    const victim = spawn(process.execPath,
      [SELF, `--victim=1`, `--result=${resultFile3}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err3 = '';
    victim.stderr.on('data', (d) => { err3 += d.toString(); });
    await new Promise((resolve) => victim.on('exit', resolve));

    const deadline3 = Date.now() + 25000;
    let answer3 = '';
    while (Date.now() < deadline3) {
      if (fs.existsSync(resultFile3)) { answer3 = fs.readFileSync(resultFile3, 'utf8'); break; }
      await sleep(250);
    }
    check('the relaunched instance came up and got the lock',
      /lock=got/.test(answer3), answer3.trim() || `no answer ${err3.slice(0, 300)}`);

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      app.exit(1);
    }
    app.exit(0);
  });
}
