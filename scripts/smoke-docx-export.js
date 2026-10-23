#!/usr/bin/env node
// scripts/smoke-docx-export.js — behavioural checks for main/album_docx.js.
//
// Generates real .docx files from a synthetic event set and asserts the
// output is a structurally valid OOXML package: every part named in
// [Content_Types].xml exists, every r:embed id in document.xml resolves
// to a relationship AND to a media file, and the embedded image bytes
// survive the zip round-trip. Electron is stubbed out (album_docx only
// uses `app.getPath` for the photo root, and these photos carry an
// explicit full_path), so no app instance and no user data are involved.
//
// Covers both modes: legacy (no layout) and layout (the WYSIWYG editor
// output).
//
// Usage: node scripts/smoke-docx-export.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const sax = require('sax');

// Read the raw central directory. This is where the OPC-compliance bugs
// live: Word looks at version-made-by and external-attributes before it
// ever looks at the XML, and rejects the whole file if they imply a
// non-MS-DOS host.
function readCentralDirectory(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count; k += 1) {
    assert.strictEqual(buf.readUInt32LE(off), 0x02014b50, 'bad central directory signature');
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      madeBy: buf.readUInt16LE(off + 4),
      externalAttr: buf.readUInt32LE(off + 38),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const ROOT = path.join(__dirname, '..');

// ---- electron stub --------------------------------------------------------
// album_docx does `require('electron')` for app.getPath('appData'). Point
// it at a temp dir so resolvePhoto() can never touch real user data.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir() },
  },
};

const albumDocx = require(path.join(ROOT, 'main', 'album_docx.js'));

// ---- test fixtures -------------------------------------------------------

// Minimal valid PNG (1×1, red). zlib-compressed so the header layout that
// sniffImageSize() parses is byte-exact.
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  const raw = Buffer.concat([
    Buffer.from([0]),                                  // filter byte
    Buffer.alloc(width * 3, 0xff),                     // one scanline of white
  ]);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// A baseline JPEG carrying an EXIF APP1 segment with Orientation=6
// ("rotate 90° CW"). Stored dimensions are 1200×800 (landscape) but the
// displayed image is 800×1200 (portrait) — the phone-camera case. The
// renderer must swap them, or the photo lies on its side in Word.
function makeExifJpeg(width, height, orientation) {
  const entries = [
    // IFD0 with a single Orientation entry (tag 0x0112, type SHORT, count 1).
    Buffer.from([
      0x49, 0x49,                         // 'II' little-endian
      0x2a, 0x00,                         // magic 42
      0x08, 0x00, 0x00, 0x00,             // offset of IFD0
    ]),
    (() => {
      const b = Buffer.alloc(2 + 12 + 4);
      b.writeUInt16LE(1, 0);              // 1 directory entry
      b.writeUInt16LE(0x0112, 2);         // tag: Orientation
      b.writeUInt16LE(3, 4);              // type 3 = SHORT
      b.writeUInt32LE(1, 6);              // count
      b.writeUInt16LE(orientation, 10);   // value
      b.writeUInt16LE(0, 12);             // next IFD = none
      b.writeUInt16LE(0, 14);
      return b;
    })(),
  ];
  const tiff = Buffer.concat(entries);
  const app1Payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'ascii'),
    tiff,
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => { const l = Buffer.alloc(2); l.writeUInt16BE(app1Payload.length + 2); return l; })(),
    app1Payload,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);              // length
  sof[4] = 8;                            // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;                            // 3 components
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),            // SOI
    app1,
    sof,
    Buffer.from([0xff, 0xd9]),            // EOI
  ]);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-docx-smoke-'));
const photoDir = path.join(tmpRoot, 'photos', 'ev1');
fs.mkdirSync(photoDir, { recursive: true });

// Three real PNGs with distinct dimensions so we can assert that the
// emitted <wp:extent> preserves each photo's aspect ratio.
const PHOTO_DIMS = [[800, 600], [600, 800], [1000, 500]];
const photoFiles = PHOTO_DIMS.map(([w, h], i) => {
  const p = path.join(photoDir, `p${i}.png`);
  fs.writeFileSync(p, makePng(w, h));
  return p;
});

// A portrait phone shot: stored 1200×800 landscape, EXIF orientation 6
// means it must DISPLAY as 800×1200.
const exifFile = path.join(photoDir, 'rotated.jpg');
fs.writeFileSync(exifFile, makeExifJpeg(1200, 800, 6));

const events = [
  {
    id: 'ev1',
    title: '西湖一日游',
    occurred_at: '2024-05-01T09:30:00',
    contact_names: ['小明', '小红'],
    place: '杭州西湖',
    food: '东坡肉',
    outfit: '白色连衣裙',
    activities: '划船',
    notes: '今天天气很好 & "<很好>"',
    photos: photoFiles.map((full, i) => ({
      id: `ph${i}`,
      relative_path: `ev1/p${i}.png`,
      original_name: `照片${i}.png`,
      created_at: `2024-05-0${i + 1}T10:00:00`,
      full_path: full,
    })),
  },
  {
    id: 'ev2',
    title: '竖拍照片',
    occurred_at: '2024-06-01',
    photos: [{ id: 'phexif', relative_path: 'ev1/rotated.jpg', original_name: 'rotated.jpg', full_path: exifFile }],
  },
  {
    id: 'ev3',
    title: '在家做饭',
    occurred_at: '2024-06-12T18:00:00',
    contact_names: [],
    place: '家',
    notes: '',
    // A HEIC must be skipped, not crash the build.
    photos: [{ id: 'pheic', relative_path: 'ev3/a.heic', original_name: 'a.heic', _is_heic: true }],
  },
];

// A two-page layout matching what the album editor emits.
const layout = {
  themeId: 'warm',
  cover: { title: '我们的回忆', subtitle: '2024', showStats: true },
  pages: [
    {
      templateId: 'big-top-text-bottom',
      slots: [
        { type: 'photo', photoId: 'ph0', _slotTemplate: { x: 4, y: 4, w: 92, h: 72 } },
        { type: 'title', text: '西湖一日游', _slotTemplate: { x: 4, y: 76, w: 92, h: 8 } },
        { type: 'caption', text: '风很舒服', _slotTemplate: { x: 4, y: 84, w: 92, h: 12 } },
      ],
      freeTexts: [{ text: '浮层文字', x: 40, y: 40, w: 200, h: 60, fontSize: 14, color: '#a85530' }],
    },
    {
      templateId: 'three-grid-text',
      slots: [
        { type: 'photo', photoId: 'ph1', _slotTemplate: { x: 0, y: 0, w: 50, h: 40 } },
        { type: 'photo', photoId: 'ph2', _slotTemplate: { x: 50, y: 0, w: 50, h: 40 } },
        { type: 'caption', text: '三宫格', _slotTemplate: { x: 0, y: 80, w: 100, h: 20 } },
      ],
      freeTexts: [],
    },
  ],
};

// ---- assertions ----------------------------------------------------------

let passed = 0;
// Async-aware check: an async callback that returns a rejected promise must
// fail the check, not become an unhandled rejection.
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e));
    process.exitCode = 1;
  }
}

// Parse a docx and assert it is a structurally sound OOXML package.
// requireImages defaults to true; pass false for the all-text fixtures.
function inspectDocx(file, { requireImages = true } = {}) {
  // --- OPC container compliance (checked before any XML) -------------------
  // Word reports "Word 在试图打开文件时遇到错误" and shows an empty
  // document when these are wrong, with no more detail than that.
  const cd = readCentralDirectory(file);
  assert.ok(cd.length > 0, 'empty zip');

  // [Content_Types].xml must be the first entry: Word's OPC reader relies on
  // it to discover every other part's content type.
  assert.strictEqual(
    cd[0].name, '[Content_Types].xml',
    `[Content_Types].xml must be the first zip entry; got "${cd[0].name}"`
  );

  for (const e of cd) {
    // version-made-by high byte = host OS. 0 = FAT/MS-DOS, which is what
    // Word itself writes. Anything else (3 = Unix, 10 = NTFS) makes Word
    // interpret external-attributes as Unix permission bits and reject the
    // package outright.
    const host = e.madeBy >> 8;
    assert.strictEqual(
      host, 0,
      `entry ${e.name} declares zip host ${host}; must be 0 (FAT/MS-DOS) or Word refuses the file`
    );
    // external attributes must be zero. Word's own packages are 0 here.
    assert.strictEqual(
      e.externalAttr, 0,
      `entry ${e.name} has external attributes 0x${e.externalAttr.toString(16)}; must be 0`
    );
  }

  const zip = new AdmZip(file);
  const names = zip.getEntries().map((e) => e.entryName);
  const read = (n) => {
    const e = zip.getEntry(n);
    assert.ok(e, `missing part: ${n}`);
    return e.getData().toString('utf8');
  };

  // Required parts.
  for (const req of [
    '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml',
    'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml',
  ]) {
    assert.ok(names.includes(req), `missing part: ${req}`);
  }

  const docXml = read('word/document.xml');
  const relsXml = read('word/_rels/document.xml.rels');
  const ctXml = read('[Content_Types].xml');
  const stylesXml = read('word/styles.xml');

  // tblW with type="pct" is in fiftieths of a percent, so a full-width
  // table must be 5000. Emitting 100 or 9600 makes Word mis-size the table.
  for (const m of docXml.matchAll(/<w:tblW w:w="(\d+)" w:type="pct"\/>/g)) {
    const v = Number(m[1]);
    assert.ok(v > 0 && v <= 5000, `tblW pct out of range: ${v} (max 5000)`);
  }

  // Every r:embed in the body must resolve to a relationship.
  const embeds = Array.from(docXml.matchAll(/r:embed="([^"]+)"/g)).map((m) => m[1]);
  const relIds = new Set(Array.from(relsXml.matchAll(/Id="([^"]+)"/g)).map((m) => m[1]));
  for (const id of embeds) {
    assert.ok(relIds.has(id), `document.xml references unknown rel ${id}`);
  }

  // Every image relationship must point at a file that is actually present
  // and non-empty.
  const imageRels = Array.from(relsXml.matchAll(
    /Id="([^"]+)"[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g
  )).map((m) => ({ id: m[1], target: m[2] }));
  for (const r of imageRels) {
    const entryName = 'word/' + r.target;
    assert.ok(names.includes(entryName), `relationship ${r.id} targets missing part ${entryName}`);
    const data = zip.getEntry(entryName).getData();
    assert.ok(data.length > 0, `media part ${entryName} is empty`);
  }

  // Each media extension must be declared in [Content_Types].xml.
  for (const e of zip.getEntries()) {
    if (!e.entryName.startsWith('word/media/')) continue;
    const ext = path.extname(e.entryName).slice(1);
    assert.ok(ext, 'media entry has no extension: ' + e.entryName);
    assert.ok(
      ctXml.includes(`Extension="${ext}"`),
      `media extension .${ext} not declared in [Content_Types].xml`
    );
    // Extension 属性的值不能带前导点（"png" 而非 ".png"）。
    assert.ok(
      !ctXml.includes(`Extension=".${ext}"`),
      `[Content_Types].xml declares a leading-dot Extension for .${ext}`
    );
    // 文件名不能出现双点（image1..jpg 曾是真实 bug）。
    assert.ok(
      !/\.\./.test(e.entryName),
      `media entry has a double-dot name: ${e.entryName}`
    );
  }

  // Structural sanity on the body: balanced tables, at least one drawing.
  const openTables = (docXml.match(/<w:tbl>/g) || []).length;
  const closeTables = (docXml.match(/<\/w:tbl>/g) || []).length;
  assert.strictEqual(openTables, closeTables, 'unbalanced <w:tbl> in document.xml');
  if (requireImages) {
    assert.ok(embeds.length > 0, 'no images embedded');
    assert.ok(/<w:drawing>/.test(docXml), 'no <w:drawing> element');
  }

  // <wp:extent> count must equal the embed count — a mismatch means an
  // inline image was emitted without a size, which Word renders blank.
  const extents = (docXml.match(/<wp:extent /g) || []).length;
  assert.strictEqual(extents, embeds.length, 'wp:extent count != r:embed count');

  // docPr ids must be unique — Word rejects duplicates in strict mode.
  const docPrIds = Array.from(docXml.matchAll(/<wp:docPr id="(\d+)"/g)).map((m) => m[1]);
  assert.strictEqual(new Set(docPrIds).size, docPrIds.length, 'duplicate wp:docPr ids');

  // Every XML part must parse. A malformed part is what makes Word show
  // "文件已损坏" rather than a specific error, so this is the check that
  // actually matters for whether the export is usable.
  for (const e of zip.getEntries()) {
    if (!e.entryName.endsWith('.xml') && !e.entryName.endsWith('.rels')) continue;
    const p = sax.parser(true, { strict: true }); // strict => throws on bad XML
    let parseError = null;
    p.onerror = (err) => { parseError = err; p.resume(); };
    try {
      p.write(e.getData().toString('utf8')).close();
    } catch (err) {
      parseError = err;
    }
    assert.ok(!parseError, `${e.entryName} is not well-formed XML: ${parseError && parseError.message}`);
  }

  return { docXml, relsXml, imageRels, embeds, stylesXml };
}

// ---- legacy mode ---------------------------------------------------------

console.log('\n[legacy] 无 layout 的导出');

const legacyOut = path.join(tmpRoot, 'legacy.docx');
let legacyStats;
const legacyEvents = JSON.parse(JSON.stringify(events));

(async () => {
  legacyStats = await albumDocx.buildAlbum({
    events: legacyEvents,
    outPath: legacyOut,
  });

  await check('produces a non-empty file', () => {
    assert.ok(fs.existsSync(legacyOut));
    assert.ok(fs.statSync(legacyOut).size > 0);
  });

  const info = inspectDocx(legacyOut);

  await check('embeds every supported photo and skips HEIC', () => {
    // 3 PNGs (ev1) + 1 EXIF jpg (ev2); ev3's only photo is HEIC and is skipped.
    assert.strictEqual(legacyStats.photos, 4, 'expected 4 embedded photos');
    assert.strictEqual(legacyStats.heicSkipped, 1, 'expected 1 HEIC skipped');
    assert.strictEqual(info.embeds.length, 4);
  });

  await check('applies EXIF orientation when sizing images', () => {
    // The EXIF photo is stored 1200×800 but must display 800×1200 (a
    // portrait ratio). Look for a wp:extent whose cx/cy ratio is ~0.667.
    const ratios = Array.from(info.docXml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g))
      .map((m) => Number(m[1]) / Number(m[2]));
    const portrait = ratios.some((r) => Math.abs(r - 800 / 1200) < 0.01);
    assert.ok(portrait, `no portrait-oriented image found; ratios: ${ratios.map((r) => r.toFixed(3)).join(', ')}`);
    // And it must NOT have been laid out with the raw 1200×800 landscape ratio.
    const landscapeRaw = 1200 / 800;
    assert.ok(
      !ratios.some((r) => Math.abs(r - landscapeRaw) < 0.01),
      'EXIF-rotated photo was laid out in its unrotated landscape ratio'
    );
  });

  await check('renders event titles, dates and fields', () => {
    assert.ok(info.docXml.includes('西湖一日游'), 'missing event title');
    assert.ok(info.docXml.includes('2024-05-01'), 'missing event date');
    assert.ok(info.docXml.includes('小明、小红'), 'missing contact names');
    assert.ok(info.docXml.includes('杭州西湖'), 'missing place field');
    assert.ok(info.docXml.includes('东坡肉'), 'missing food field');
    assert.ok(info.docXml.includes('划船'), 'missing activities field');
  });

  await check('escapes XML metacharacters in event text', () => {
    // notes = '今天天气很好 & "<很好>"'
    assert.ok(info.docXml.includes('&amp;'), 'ampersand not escaped');
    assert.ok(!/ & /.test(info.docXml), 'raw unescaped ampersand leaked into XML');
    assert.ok(info.docXml.includes('&lt;很好&gt;'), 'angle brackets not escaped');
  });

  await check('preserves each photo aspect ratio in wp:extent', () => {
    // EMU per point is 12700. Sizes are scaled down to fit the grid cell
    // (never up), so only the ratio is asserted.
    const ratios = Array.from(info.docXml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g))
      .map((m) => Number(m[1]) / Number(m[2]))
      .map((r) => Math.round(r * 1000) / 1000);
    assert.ok(ratios.length >= 3, 'expected at least 3 sized images');
    // Expected ratios for the three fixture photos.
    const expected = [
      Math.round((800 / 600) * 1000) / 1000,
      Math.round((600 / 800) * 1000) / 1000,
      Math.round((1000 / 500) * 1000) / 1000,
    ];
    for (const e of expected) {
      assert.ok(
        ratios.some((r) => Math.abs(r - e) < 0.01),
        `no image with aspect ratio ${e}; got ${ratios.join(', ')}`
      );
    }
  });

  // ---- layout mode -------------------------------------------------------

  console.log('\n[layout] 带 AlbumLayout 的导出');

  const layoutOut = path.join(tmpRoot, 'layout.docx');
  const layoutStats = await albumDocx.buildAlbum({
    events: JSON.parse(JSON.stringify(events)),
    layout: JSON.parse(JSON.stringify(layout)),
    outPath: layoutOut,
  });
  const linfo = inspectDocx(layoutOut);

  await check('reports layout mode and page count', () => {
    assert.strictEqual(layoutStats.mode, 'layout');
    // cover + 2 pages
    assert.strictEqual(layoutStats.pages, 3);
  });

  await check('uses the cover title from the layout', () => {
    assert.ok(linfo.docXml.includes('我们的回忆'), 'missing custom cover title');
  });

  await check('embeds layout photo slots and skips empty ones', () => {
    // ph0 on page 1, ph1 + ph2 on page 2 → 3 embeds. The three-grid
    // template declares a third photo slot with no photoId; it must render
    // a placeholder, not an image.
    assert.strictEqual(layoutStats.photos, 3);
    assert.ok(linfo.docXml.includes('（空位）'), 'empty slot placeholder missing');
  });

  await check('renders layout text slots and free text boxes', () => {
    assert.ok(linfo.docXml.includes('风很舒服'), 'missing caption slot text');
    assert.ok(linfo.docXml.includes('三宫格'), 'missing second page caption');
    assert.ok(linfo.docXml.includes('浮层文字'), 'missing free text box');
  });

  await check('applies the theme accent colour to headings', () => {
    // warm theme accent is #a85530 → Word wants A85530 without the '#'.
    assert.ok(linfo.stylesXml.includes('A85530'), 'theme accent colour not applied to styles.xml');
    // The cover must also report the real event/photo totals.
    assert.ok(linfo.docXml.includes('3 个事件'), 'cover stats missing event count');
    assert.ok(linfo.docXml.includes('4 张照片'), 'cover stats missing photo count');
  });

  await check('wraps every table cell in a w:tr row', () => {
    // Regression: w:tc must be a child of w:tr, not a direct child of w:tbl.
    // Word rejects the whole package otherwise — "Word 在试图打开文件时遇到
    // 错误" with an empty document — even though the XML is well-formed and
    // every part is present.
    const docXml = linfo.docXml;
    let tblDepth = 0;
    let inRow = false;
    const stack = [];
    for (const m of docXml.matchAll(/<(\/?)w:(tbl|tr|tc)(?:\s[^>]*)?(\/?)>/g)) {
      const closing = m[1] === '/';
      const tag = m[2];
      const selfClosing = m[3] === '/';
      if (closing) {
        if (tag === 'tc' && !inRow) {
          assert.fail('w:tc found outside a w:tr — Word will reject the document');
        }
        if (tag === 'tr') {
          assert.ok(inRow, 'closing w:tr without an open row');
          inRow = false;
        }
        if (tag === 'tbl') tblDepth -= 1;
        continue;
      }
      if (selfClosing) continue;
      if (tag === 'tbl') {
        tblDepth += 1;
        assert.strictEqual(tblDepth, 1, 'nested w:tbl is not supported');
        continue;
      }
      if (tag === 'tr') {
        assert.strictEqual(tblDepth, 1, 'w:tr outside a w:tbl');
        assert.ok(!inRow, 'w:tr opened while another w:tr was still open');
        inRow = true;
        continue;
      }
      // tag === 'tc'
      assert.strictEqual(tblDepth, 1, 'w:tc outside a w:tbl');
      assert.ok(inRow, 'w:tc is not inside a w:tr — Word will reject the document');
    }
    assert.strictEqual(tblDepth, 0, 'unclosed w:tbl');
    assert.strictEqual(inRow, false, 'unclosed w:tr');
  });

  await check('gives every table row the same cell count as the grid', () => {
    // A row whose cell count differs from <w:tblGrid> makes Word complain
    // about the table; rows must be padded to the declared column count.
    const docXml = linfo.docXml;
    const tables = docXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
    assert.ok(tables.length > 0, 'no table emitted');
    for (const t of tables) {
      const gridCols = (t.match(/<w:gridCol\b/g) || []).length;
      const rows = t.match(/<w:tr>[\s\S]*?<\/w:tr>/g) || [];
      assert.ok(rows.length > 0, 'table has no rows');
      for (const r of rows) {
        const cells = (r.match(/<w:tc>/g) || []).length;
        assert.strictEqual(cells, gridCols,
          `row has ${cells} cells but the grid declares ${gridCols}`);
      }
    }
  });

  await check('writes an OPC-compliant zip container', () => {
    // Regression: this exact combination made Word refuse the export with
    // "Word 在试图打开文件时遇到错误" and an empty document. adm-zip's
    // writer produced madeBy=0x0a14 (NTFS host) with
    // external_attr=0x81a40000 (Unix mode 0100644), and reordered entries
    // so [Content_Types].xml was not first.
    const cd = readCentralDirectory(layoutOut);
    assert.strictEqual(cd[0].name, '[Content_Types].xml');
    for (const e of cd) {
      assert.strictEqual(e.madeBy >> 8, 0, `${e.name}: zip host must be FAT/MS-DOS`);
      assert.strictEqual(e.externalAttr, 0, `${e.name}: external attributes must be 0`);
    }
    // Images are stored uncompressed (they are already PNG/JPEG); asserting
    // the method keeps a future "just deflate everything" change honest.
    const buf = fs.readFileSync(layoutOut);
    const media = cd.find((e) => e.name.startsWith('word/media/'));
    if (media) {
      let off = buf.length - 22;
      for (let i = buf.length - 22; i >= 0; i -= 1) {
        if (buf.readUInt32LE(i) === 0x06054b50) { off = i; break; }
      }
      let p = buf.readUInt32LE(off + 16);
      for (let k = 0; k < cd.length; k += 1) {
        const nl = buf.readUInt16LE(p + 28);
        const el = buf.readUInt16LE(p + 30);
        const cl = buf.readUInt16LE(p + 32);
        const name = buf.toString('utf8', p + 46, p + 46 + nl);
        if (name === media.name) {
          assert.strictEqual(buf.readUInt16LE(p + 10), 0, 'media should be stored, not deflated');
        }
        p += 46 + nl + el + cl;
      }
    }
  });

  await check('output survives a zip round-trip', () => {
    const rezip = new AdmZip(layoutOut);
    const doc = rezip.getEntry('word/document.xml').getData().toString('utf8');
    assert.ok(doc.startsWith('<?xml'), 'document.xml is not well-formed at the head');
    assert.ok(doc.includes('</w:document>'), 'document.xml missing closing tag');
    // Each media entry must still be a readable PNG after compression.
    for (const r of linfo.imageRels) {
      const data = rezip.getEntry('word/' + r.target).getData();
      assert.strictEqual(data.readUInt32BE(0), 0x89504e47, 'media bytes corrupted: ' + r.target);
    }
  });

  // ---- progress + edge cases --------------------------------------------

  console.log('\n[edge] 进度回调与异常输入');

  await check('emits a monotonically increasing progress sequence', async () => {
    const seen = [];
    await albumDocx.buildAlbum({
      events: JSON.parse(JSON.stringify(events)),
      outPath: path.join(tmpRoot, 'progress.docx'),
      progressCb: (phase, pct) => seen.push([phase, pct]),
    });
    assert.ok(seen.length >= 3, 'expected several progress callbacks');
    assert.strictEqual(seen[0][0], 'preparing');
    assert.strictEqual(seen[seen.length - 1][0], 'done');
    assert.strictEqual(seen[seen.length - 1][1], 100);
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i][1] >= seen[i - 1][1], 'progress went backwards');
    }
  });

  await check('handles an event with no photos', async () => {
    const out = path.join(tmpRoot, 'empty.docx');
    const stats = await albumDocx.buildAlbum({
      events: [{ id: 'ev3', title: '空事件', occurred_at: '2024-01-01', photos: [] }],
      outPath: out,
    });
    assert.strictEqual(stats.photos, 0);
    const info = inspectDocx(out, { requireImages: false });
    assert.ok(info.docXml.includes('空事件'));
    assert.ok(info.docXml.includes('（本事件暂无照片）'), 'missing empty-photos notice');
  });

  await check('rejects a missing outPath', async () => {
    await assert.rejects(
      () => albumDocx.buildAlbum({ events: [], outPath: '' }),
      /outPath required/
    );
  });

  console.log(`\n${passed} 项通过` + (process.exitCode ? '，存在失败' : '') + '\n');
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
})();