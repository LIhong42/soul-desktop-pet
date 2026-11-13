// scripts/test_pdf_photo_render.js — the PDF export's "empty photo" bug.
//
// The PDF album export draws each note in the offscreen page
// (src/js/pdf_page.js) and screenshots it. A note whose photos come out as
// empty frames means the screenshot was taken while the <img> was still
// empty.
//
// This harness re-implements the page's exact algorithm against a fake DOM
// whose image loading is ASYNCHRONOUS, so the race is observable. Each case
// asserts on what the page would have drawn.
//
// Run: node scripts/test_pdf_photo_render.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The placeholder the page puts into an <img> whose bytes have not arrived.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// The marker the page sets on an <img> that is still holding the
// placeholder — the fix for "the placeholder looks like a loaded picture".
const PLACEHOLDER_ATTR = 'data-placeholder';

// How long the wait for a picture's bytes may last before the note is
// drawn without it.
const PHOTO_WAIT_CEILING_MS = 15000;

// ---- A fake DOM, faithful to the parts the page relies on ---------------
//
// The <img> element behaves like a browser's: `complete` is false until the
// bytes arrive, `naturalWidth` is 0 until then, and setting `src` starts a
// load that finishes on a later tick.

class FakeImage {
  constructor() {
    this.src = '';
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.style = {};
    this.dataset = {};
    this._attrs = {};
    this._listeners = { load: [], error: [] };
    this.delay = 0;
    this.failed = false;
  }
  getAttribute(name) { return this._attrs[name] || null; }
  setAttribute(name, value) { this._attrs[name] = value; }
  removeAttribute(name) { delete this._attrs[name]; }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  _fire(type) {
    for (const fn of (this._listeners[type] || []).slice()) fn();
  }
  // Set the src and schedule the load. `bytes` is what the image decodes to.
  setSrc(url, bytes) {
    this.src = url;
    if (!url || url === BLANK) {
      // The placeholder decodes immediately — it is already "there".
      this.complete = true;
      this.naturalWidth = 1;
      this.naturalHeight = 1;
      this._fire('load');
      return;
    }
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    const finish = () => {
      if (this.failed) {
        this.complete = true;
        this.dataset.failed = '1';
        this._fire('error');
        return;
      }
      this.complete = true;
      this.naturalWidth = bytes.w;
      this.naturalHeight = bytes.h;
      this._fire('load');
    };
    if (this.delay <= 0) {
      // A microtask, not a synchronous set — a browser never decodes
      // synchronously, and the difference is the whole bug.
      Promise.resolve().then(finish);
    } else {
      setTimeout(finish, this.delay);
    }
  }
}

class FakeFrame {
  constructor() {
    this.clientWidth = 200;
    this.clientHeight = 113; // 16:9
    this.img = new FakeImage();
    this._attrs = {};
  }
  getAttribute(name) { return this._attrs[name] || null; }
  setAttribute(name, value) { this._attrs[name] = value; }
  querySelector(sel) { return sel === 'img' ? this.img : null; }
}

// ---- The page's own code -------------------------------------------------
//
// The functions under test are transcribed from src/js/pdf_page.js with only
// the DOM access replaced by the fakes above. Keeping them faithful is the
// point: if the page's algorithm is wrong, this harness must fail.
//
// The transcription is checked against the real source, so the harness
// cannot drift away from the page it guards.

function nextFrame() {
  return new Promise((resolve) => {
    // The page uses requestAnimationFrame twice.
    setTimeout(() => setTimeout(resolve, 0), 0);
  });
}

// The FIXED whenImagesSettled(): a picture holding the placeholder is not
// settled, even though the placeholder is complete and has a naturalWidth.
//
// The wait is on the SWAP, not on a DOM event: the placeholder's own load
// event has already fired by the time this runs, so listening for another
// one would wait for ever.
function whenImagesSettled(imgs) {
  if (!imgs.length) return Promise.resolve();
  return Promise.all(imgs.map((img) => new Promise((resolve) => {
    if (img.getAttribute(PLACEHOLDER_ATTR) === '1') {
      const done = () => {
        clearTimeout(ceiling);
        resolve();
      };
      const ceiling = setTimeout(done, PHOTO_WAIT_CEILING_MS);
      img._pdfPlaceholderWaiter = done;
      return;
    }
    if (img.complete && (img.naturalWidth || img.dataset.failed)) {
      resolve();
      return;
    }
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => {
      img.dataset.failed = '1';
      resolve();
    }, { once: true });
  })));
}

// The FIXED page logic, with the DOM replaced.
//
// The ORDER mirrors src/js/pdf_page.js exactly:
//
//   1. the HTML build calls photoSrc() for every photo, which registers the
//      fetch and hands back the placeholder;
//   2. `await Promise.all(the note's fetches)` — the bytes arrive and the
//      fetch's `.then()` swaps `img.src` on the LIVE <img>;
//   3. `await whenImagesSettled()` — wait for the NEW load;
//   4. two animation frames, then the reply.
async function renderNoteLikePage(page) {
  // ---- step 1: the HTML build ------------------------------------------
  page.frames = page.specs.map((spec) => {
    const frame = new FakeFrame();
    frame.img.delay = spec.delay;
    frame.img.failed = spec.failed;
    frame.setAttribute('data-photo-id', spec.photoId);
    if (spec.cover) frame.setAttribute('data-cover', JSON.stringify(spec.cover));
    return frame;
  });

  for (const spec of page.specs) {
    page.currentPhotos.add(spec.photoId);
    const cached = page.cache.get(spec.photoId);
    if (cached) {
      for (const f of page.frames) {
        if (f.getAttribute('data-photo-id') !== spec.photoId) continue;
        f.img.setSrc(cached, spec.bytes);
      }
      continue;
    }
    if (!page.inFlight.has(spec.photoId)) {
      page.inFlight.add(spec.photoId);
      const p = page.readPhoto(spec.photoId).then((url) => {
        if (url) {
          page.cache.set(spec.photoId, url);
          for (const f of page.frames) {
            if (f.getAttribute('data-photo-id') !== spec.photoId) continue;
            const img = f.img;
            if (img.getAttribute(PLACEHOLDER_ATTR) !== '1') continue;
            img.removeAttribute(PLACEHOLDER_ATTR);
            img.src = url;
            img.setSrc(url, spec.bytes);
            // The bytes are in, but the picture is not drawn until the
            // browser has decoded it — the wait ends on the load.
            releaseWhenLoaded(img);
          }
        } else {
          // A failed read must not be cached as a finished empty string.
          page.cache.delete(spec.photoId);
          releasePhotoWaiters(page, spec.photoId);
        }
        return url;
      }).catch(() => {
        page.cache.delete(spec.photoId);
        releasePhotoWaiters(page, spec.photoId);
        return '';
      });
      page.fetches.set(spec.photoId, p);
      p.finally(() => {
        page.inFlight.delete(spec.photoId);
      });
    }
    // The placeholder goes into EVERY <img> of this photo, marked as a
    // placeholder — the page builds one <img> per use of a picture, so the
    // same picture used twice has two of them.
    if (!page.cache.get(spec.photoId)) {
      for (const f of page.frames) {
        if (f.getAttribute('data-photo-id') !== spec.photoId) continue;
        f.img.setAttribute(PLACEHOLDER_ATTR, '1');
        f.img.setSrc(BLANK, spec.bytes);
      }
    }
  }

  // ---- step 2: the bytes arrive ----------------------------------------
  await Promise.all(page.currentFetches());
  // ---- step 3: the pictures settle -------------------------------------
  await whenImagesSettled(page.frames.map((f) => f.img));
  // ---- step 4: the frame advances --------------------------------------
  await nextFrame();
  await nextFrame();
}

// End an <img>'s wait when the picture it has just been given has been
// loaded.
function releaseWhenLoaded(img) {
  const waiter = img._pdfPlaceholderWaiter;
  if (typeof waiter !== 'function') return;
  const finish = () => {
    img.removeEventListener('load', finish);
    img.removeEventListener('error', finish);
    img._pdfPlaceholderWaiter = null;
    waiter();
  };
  img.addEventListener('load', finish);
  img.addEventListener('error', finish);
  if (img.complete && (img.naturalWidth || img.dataset.failed)) finish();
}

// End the wait of every <img> that is holding the placeholder of one
// photo. Called when the photo's bytes turn out to be unavailable.
function releasePhotoWaiters(page, photoId) {
  for (const f of page.frames) {
    if (f.getAttribute('data-photo-id') !== photoId) continue;
    const img = f.img;
    if (typeof img._pdfPlaceholderWaiter !== 'function') continue;
    const waiter = img._pdfPlaceholderWaiter;
    img._pdfPlaceholderWaiter = null;
    waiter();
  }
}

function makePage(specs, readPhoto) {  return {
    cache: new Map(),
    // The promise of every read asked for — kept after it has settled, so
    // the wait before the measurement can always find it.
    fetches: new Map(),
    // The reads that are still on their way. A read that is in flight is
    // not started a second time.
    inFlight: new Set(),
    currentPhotos: new Set(),
    frames: [],
    specs,
    readPhoto,
    currentFetches() {
      const out = [];
      for (const id of this.currentPhotos) {
        const p = this.fetches.get(id);
        if (p) out.push(p);
      }
      return out;
    },
  };
}

// ---- The cases ----------------------------------------------------------

// Case 1: the first note, with a photo whose bytes arrive AFTER the DOM
// was built. The page must not capture the placeholder.
async function caseFirstNotePlaceholderRace() {
  const page = makePage(
    [{ photoId: 'p1', delay: 30, bytes: { w: 1200, h: 900 } }],
    (id) => new Promise((res) => setTimeout(() => res('data:image/png;base64,AAA'), 30)),
  );
  await renderNoteLikePage(page);
  const img = page.frames[0].img;
  return {
    name: 'first note: photo bytes arrive late',
    ok: img.src !== BLANK && img.naturalWidth === 1200,
    detail: `src=${img.src === BLANK ? 'PLACEHOLDER' : 'real'} naturalWidth=${img.naturalWidth}`,
  };
}

// Case 2: a photo whose fetch FAILED. The page must not cache the empty
// result as a finished photo, or the placeholder is drawn for good.
async function caseFailedPhotoNotCachedAsEmpty() {
  const page = makePage(
    [{ photoId: 'p1', delay: 0, bytes: { w: 800, h: 600 } }],
    () => Promise.resolve(''),
  );
  await renderNoteLikePage(page);
  const cachedEmpty = page.cache.get('p1') === '';
  return {
    name: 'a failed photo read is not cached as a finished empty photo',
    ok: !cachedEmpty,
    detail: cachedEmpty
      ? 'the empty result was cached — the placeholder would be drawn for this note AND every later one, with no retry'
      : 'the failed read was dropped from the cache, so a later note may try again',
  };
}

// Case 3: a note that shares a photo with an earlier note. The cache has
// the URL, so the <img> is built with it — but it still has to LOAD, and
// the page must wait for THAT load, not for the cached promise.
async function caseCachedPhotoSecondNote() {
  const page = makePage(
    [{ photoId: 'p1', delay: 20, bytes: { w: 1024, h: 768 } }],
    () => Promise.resolve(''),
  );
  page.cache.set('p1', 'data:image/png;base64,AAA');
  await renderNoteLikePage(page);
  const img = page.frames[0].img;
  return {
    name: 'second note re-using a cached photo: the img still has to LOAD',
    ok: img.naturalWidth === 1024,
    detail: `naturalWidth=${img.naturalWidth} complete=${img.complete}`,
  };
}

// Case 4 — THE ONE THAT MATTERS MOST. `whenImagesSettled()` used to treat
// the 1x1 PLACEHOLDER as settled, because it is complete and has a
// naturalWidth. The page then measured the note and replied while the
// frames were still empty, and the screenshot caught the empty frames.
async function casePlaceholderLooksSettled() {
  const page = makePage(
    [{ photoId: 'p1', delay: 50, bytes: { w: 1200, h: 900 } }],
    (id) => new Promise((res) => setTimeout(() => res('data:image/png;base64,AAA'), 50)),
  );

  // The DOM holds the placeholder and the fetch is in flight but NOT
  // registered among the fetches being waited on.
  page.frames = page.specs.map((spec) => {
    const frame = new FakeFrame();
    frame.img.delay = spec.delay;
    frame.setAttribute('data-photo-id', spec.photoId);
    frame.img.setAttribute(PLACEHOLDER_ATTR, '1');
    frame.img.setSrc(BLANK, spec.bytes);
    return frame;
  });

  let settled = false;
  const waiting = whenImagesSettled(page.frames.map((f) => f.img)).then(() => {
    settled = true;
  });

  // The wait must NOT be over while the placeholder is still there.
  await new Promise((r) => setTimeout(r, 20));
  const placeholderAccepted = settled;
  const detail = placeholderAccepted
    ? 'the placeholder (naturalWidth=1) satisfied the settled check — the capture happens with an empty frame'
    : 'the wait holds while the placeholder is in place';

  // Now let the bytes arrive and the swap release the wait.
  const img = page.frames[0].img;
  img.removeAttribute(PLACEHOLDER_ATTR);
  img.setSrc('data:image/png;base64,AAA', { w: 1200, h: 900 });
  releaseWhenLoaded(img);
  await waiting;
  const released = settled;

  return {
    name: 'whenImagesSettled() rejects the 1x1 placeholder, and releases on the swap',
    ok: !placeholderAccepted && released,
    detail: `${detail}; released when the bytes arrived: ${released}`,
  };
}

// Case 5: the wait must be scoped to the note being drawn. A promise that
// settled on an earlier note carries no information about the <img> this
// note has just built, so waiting on it proves nothing.
async function caseWaitIsScopedToTheNote() {
  const page = makePage(
    [{ photoId: 'p1', delay: 20, bytes: { w: 640, h: 480 } }],
    (id) => new Promise((res) => setTimeout(() => res('data:image/png;base64,AAA'), 20)),
  );
  // An earlier note already fetched a DIFFERENT photo.
  page.fetches.set('old', Promise.resolve('data:image/png;base64,OLD'));
  // This note shows a photo of its own, with a fetch of its own.
  const own = Promise.resolve('data:image/png;base64,OWN');
  page.fetches.set('p1', own);
  page.currentPhotos.add('p1');

  const fetches = page.currentFetches();
  return {
    name: 'the wait is scoped to the photos of the note being drawn',
    ok: fetches.length === 1 && fetches[0] === own && fetches[0] !== page.fetches.get('old'),
    detail: `waits on ${fetches.length} fetch(es) — this note's own; the earlier note's photo is not among them`,
  };
}

// Case 6: the bytes arriving is not the same as the picture being there.
// The src is set, and the browser decodes the picture AFTER that. The wait
// has to end on the load, not on the swap — otherwise the note is measured
// while a picture is still being decoded, and the screenshot catches a
// half-painted picture.
async function caseWaitEndsOnDecodeNotOnSwap() {
  const page = makePage(
    [{ photoId: 'p1', delay: 40, bytes: { w: 1200, h: 900 } }],
    (id) => new Promise((res) => setTimeout(() => res('data:image/png;base64,AAA'), 5)),
  );

  await renderNoteLikePage(page);
  const img = page.frames[0].img;
  return {
    name: 'the wait ends on the picture being decoded, not on the bytes arriving',
    ok: img.naturalWidth === 1200 && img.complete === true,
    detail: `naturalWidth=${img.naturalWidth} (a picture that was measured mid-decode would be 0 or 1)`,
  };
}

// Case 7: the same photo asked for twice. The same picture can sit in two
// galleries of one note, and a note can be drawn again while the first read
// is still on its way. A second read would leave the first read's promise
// orphaned: the wait would then be on the SECOND promise while the swap
// belongs to the first, and the picture would be swapped in late — or not
// at all, and the frame would come out empty.
async function caseSamePhotoReadOnlyOnce() {
  let reads = 0;
  const page = makePage(
    [
      { photoId: 'p1', delay: 30, bytes: { w: 1200, h: 900 } },
      { photoId: 'p1', delay: 30, bytes: { w: 1200, h: 900 } },
    ],
    () => {
      reads += 1;
      return new Promise((res) => setTimeout(() => res('data:image/png;base64,AAA'), 30));
    },
  );

  await renderNoteLikePage(page);
  const imgs = page.frames.map((f) => f.img);
  const allReal = imgs.every((im) => im.src !== BLANK && im.naturalWidth === 1200);
  return {
    name: 'the same photo is read once, not twice',
    ok: reads === 1 && allReal,
    detail: `${reads} read(s) for 2 uses of the same photo; both <img>s show the picture: ${allReal}`,
  };
}

// ---- The source is what the harness guards --------------------------------
//
// The harness transcribes the page's algorithm. If the page changes and the
// harness is left behind, the harness would pass while the page is broken —
// so the two are checked against each other.

function checkSourceInSync() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'pdf_page.js'),
    'utf8',
  );
  const checks = [
    ['the placeholder marker', /PLACEHOLDER_ATTR\s*=\s*'data-placeholder'/],
    ['the marker on the <img>', /\$\{placeholderAttr\}/],
    ['the wait rejecting the placeholder', /img\.getAttribute\(PLACEHOLDER_ATTR\) === '1'/],
    ['the failed read dropped from the cache', /state\.photoCache\.delete\(photoId\)/],
    ['the wait scoped to the note', /currentPhotoFetches\(\)/],
    ['the paint handshake', /bridge\.onPaint/],
    ['the wait ending on the decode', /releaseWhenLoaded\(/],
    ['the wait having a ceiling', /PHOTO_WAIT_CEILING_MS/],
    ['the in-flight guard', /state\.inFlight\.has\(photoId\)/],
  ];
  const missing = checks.filter(([, re]) => !re.test(src)).map(([name]) => name);
  return {
    name: 'src/js/pdf_page.js still has the fixes the harness models',
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(', ')}` : 'all present',
  };
}

(async () => {
  const cases = [
    await caseFirstNotePlaceholderRace(),
    await caseFailedPhotoNotCachedAsEmpty(),
    await caseCachedPhotoSecondNote(),
    await casePlaceholderLooksSettled(),
    await caseWaitIsScopedToTheNote(),
    await caseWaitEndsOnDecodeNotOnSwap(),
    await caseSamePhotoReadOnlyOnce(),
    checkSourceInSync(),
  ];
  let failed = 0;
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.detail}`);
    if (!c.ok) failed += 1;
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  // The exit code is set rather than the process killed outright: on
  // Windows, process.exit() can truncate stdout that has not been flushed
  // yet, and the report would be lost.
  process.exitCode = failed ? 1 : 0;
})();
