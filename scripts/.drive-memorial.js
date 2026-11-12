// A temporary driver: launch the REAL app with a remote debugging port,
// open the 回忆 page and its editor, and screenshot the image frames.
//
// It talks to the app over CDP (Chromium's DevTools Protocol) so the real
// preload bridge and the real database are in play — nothing is faked.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const OUT = path.join(process.env.TEMP || process.env.TMP, 'soul-memorial-frames.png');

function electronBin() {
  const rel = fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf-8').trim();
  return path.join(ROOT, 'node_modules', 'electron', 'dist', rel);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// A tiny CDP client over the WebSocket. Node has no ws module here, so
// the raw WebSocket handshake is done by hand — enough for one session.
function cdpConnect(wsUrl) {
  const net = require('net');
  const crypto = require('crypto');
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let handshaken = false;
    const handlers = [];
    const send = (method, params) => {
      const payload = Buffer.from(JSON.stringify({ id: send._id = (send._id || 0) + 1, method, params: params || {} }));
      const len = payload.length;
      let head;
      if (len < 126) { head = Buffer.alloc(6); head[0] = 0x81; head[1] = 0x80 | len; }
      else if (len < 65536) { head = Buffer.alloc(8); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
      else { head = Buffer.alloc(14); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      sock.write(Buffer.concat([head, mask, masked]));
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        buf = buf.slice(i + 4);
        handshaken = true;
        resolve({ send, on: (fn) => handlers.push(fn), close: () => sock.destroy() });
      }
      // Decode server frames (unmasked).
      while (buf.length >= 2) {
        const b1 = buf[0], b2 = buf[1];
        let len = b2 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          handlers.forEach(fn => fn(msg));
        } catch (e) { /* not json */ }
      }
    });
    sock.on('error', reject);
  });
}

async function main() {
  // The same two variables scripts/run-electron.js clears: they turn the
  // Electron binary into a plain Node binary, which refuses the switch.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const child = spawn(electronBin(), [`--remote-debugging-port=${PORT}`, '.'], {
    stdio: 'ignore',
    env,
  });
  await sleep(2500);

  let targets = [];
  for (let i = 0; i < 40; i++) {
    try {
      const all = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      targets = all.filter(t => t.type === 'page');
      if (i === 0 || i % 8 === 0) {
        console.log('POLL', i, all.map(t => t.type + ':' + (t.url || '').slice(-40)).join(' | '));
      }
      if (targets.length) break;
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  if (!targets.length) { console.error('NO TARGETS'); child.kill(); process.exit(1); }
  console.log('TARGETS', targets.map(t => t.title + ' ' + t.url).join(' | '));

  // The main window is the one that loads src/index.html — not the pet,
  // and not the DevTools front-end.
  const mainTarget = targets.find(t => /src\/index\.html/.test(t.url));
  if (!mainTarget) { console.error('NO MAIN TARGET'); child.kill(); process.exit(1); }
  const cdp = await cdpConnect(mainTarget.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  cdp.on((msg) => {
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  const call = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    cdp.send(method, Object.assign({ id }, params || {}));
  });
  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await call('Runtime.enable');
  await call('Page.enable');
  await sleep(600);

  // ---- the 回忆 list -------------------------------------------------
  await evalJs(`location.hash = '#/events/memorial'; true`);
  await sleep(2500);

  const listState = await evalJs(`(() => ({
    route: location.hash,
    locked: document.body.classList.contains('locked'),
    cards: document.querySelectorAll('.memorial-card').length,
    frames: Array.from(document.querySelectorAll('.memorial-card-frame')).map(f => {
      const r = f.getBoundingClientRect();
      return { ratio: f.dataset.ratio || null,
               w: Math.round(r.width), h: Math.round(r.height) };
    }),
    holes: Array.from(document.querySelectorAll('.memorial-card-frame img')).map(im => {
      const r = im.getBoundingClientRect();
      const p = im.parentElement.getBoundingClientRect();
      // A hole is empty space: the picture is smaller than the frame.
      return { gapX: Math.round(p.width - r.width), gapY: Math.round(p.height - r.height) };
    }),
  }))()`);
  console.log('LIST', JSON.stringify(listState, null, 1));

  const shot1 = await call('Page.captureScreenshot', { format: 'png' });
  if (shot1.result && shot1.result.data) {
    fs.writeFileSync(OUT.replace('.png', '-list.png'), Buffer.from(shot1.result.data, 'base64'));
    console.log('SHOT list', OUT.replace('.png', '-list.png'));
  }

  cdp.close();
  child.kill();
  await sleep(500);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
