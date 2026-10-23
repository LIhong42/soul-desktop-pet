// scripts/measure-text-boxes.js — measure where the bubble actually is inside
// each resources/text_boxes PNG.
//
// The shipped art is a 2048×2048 canvas with the drawn bubble occupying only
// part of it; the rest is transparent margin. Sizing the UI element to the
// canvas therefore (a) puts a big empty gap between the bubble and the pet,
// and (b) makes the bubble look small for its allotted footprint. This prints
// the opaque bounds so the CSS can be written against the real bubble.
//
// Dev tool, not shipped runtime code — main/pet_text_boxes.js carries the
// numbers this produces.
//
// Usage: node scripts/measure-text-boxes.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'resources', 'text_boxes');

// ---------------------------------------------------------------------------
// Minimal PNG decoder
// ---------------------------------------------------------------------------
// Supports exactly what these files use: 8-bit depth, colour type 6 (RGBA) or
// 2 (RGB), non-interlaced. Anything else throws rather than guessing, so a
// re-export that changes the format fails loudly instead of measuring garbage.

function decodePng(buf) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.slice(0, 8).equals(SIG)) throw new Error('not a PNG');

  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }

  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  // Each scanline is prefixed with a filter byte; undo them in place.
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;          // left
      const b = prev ? prev[x] : 0;                   // up
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0; // up-left
      const v = line[x];
      switch (filter) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = (v + a) & 0xff; break;
        case 2: cur[x] = (v + b) & 0xff; break;
        case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          cur[x] = (v + pred) & 0xff;
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
    }
  }

  // Alpha for one pixel, or 255 when the format has no alpha channel (RGB /
  // palette images are opaque everywhere).
  function alphaAt(x, y) {
    const i = y * stride + x * bpp;
    if (colorType === 6) return out[i + 3];
    if (colorType === 4) return out[i + 1];
    if (colorType === 3) return (trns && out[i] < trns.length) ? trns[out[i]] : 255;
    return 255;
  }

  // `out` is the full RGBA (or RGB / palette) scanline buffer, needed by the
  // interior measurement for its colour test.
  return { width, height, alphaAt, px: out, colorType };
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

// Smallest rectangle containing every pixel at/above `threshold`.
//
// The coarse pass samples on a grid purely to find roughly *where* the art is;
// the grid can miss sparse decoration entirely (a bat wing's tip lands between
// two samples), so every edge it reports is then re-measured at full resolution.
// That refine used to re-scan a single mid-height row for the horizontal edges
// and a single mid-width column for the vertical ones, which quietly threw the
// decoration away: on 1.png the mid row runs through the bubble's interior, so
// the wings hanging above and the cross dangling below were both dropped, and
// on 3.png the heavy outer frame sat outside the measured box entirely. The
// numbers came out plausible — a clean rectangle with a sensible aspect — so
// nothing looked wrong until the art was drawn on screen and read as cropped.
//
// Refining per-edge instead: for each of the four edges, scan only the rows (or
// columns) the coarse pass found that edge on, and take the extreme across all
// of them. Same cost, no decoration lost.
function opaqueBounds(img, threshold = 12) {
  const { width, height, alphaAt } = img;
  const step = 4;
  let minX = width, minY = height, maxX = -1, maxY = -1;

  // Every sampled row that is opaque at all, and every sampled column likewise.
  // Kept as lists so each edge can be refined over the band it was seen in.
  const rowsWithArt = [];
  const colsWithArt = [];
  const colHasArt = new Uint8Array(width);

  for (let y = 0; y < height; y += step) {
    let rowMin = width, rowMax = -1;
    for (let x = 0; x < width; x += step) {
      if (alphaAt(x, y) < threshold) continue;
      if (x < rowMin) rowMin = x;
      if (x > rowMax) rowMax = x;
    }
    if (rowMax < 0) continue;
    rowsWithArt.push(y);
    // Span this row's extent across the grid at full resolution, so the column
    // list records where art really is rather than which samples happened to hit.
    const from = Math.max(0, rowMin - step);
    const to = Math.min(width - 1, rowMax + step);
    for (let x = from; x <= to; x++) colHasArt[x] = 1;
    if (rowMin < minX) minX = rowMin;
    if (rowMax > maxX) maxX = rowMax;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  for (let x = 0; x < width; x++) if (colHasArt[x]) colsWithArt.push(x);

  // Refine each edge at full resolution across the band it was seen in.
  const refineX = () => {
    let lo = width, hi = -1;
    for (const y of rowsWithArt) {
      const scanFrom = Math.max(0, minX - step * 2), scanTo = Math.min(width - 1, maxX + step * 2);
      for (let x = scanFrom; x <= scanTo; x++) {
        if (alphaAt(x, y) < threshold) continue;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    return [lo, hi];
  };
  const refineY = () => {
    let lo = height, hi = -1;
    for (const x of colsWithArt) {
      const scanFrom = Math.max(0, minY - step * 2), scanTo = Math.min(height - 1, maxY + step * 2);
      for (let y = scanFrom; y <= scanTo; y++) {
        if (alphaAt(x, y) < threshold) continue;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    return [lo, hi];
  };

  const [rl, rr] = refineX();
  if (rl >= 0) { minX = rl; maxX = rr; }
  const [ct, cb] = refineY();
  if (ct >= 0) { minY = ct; maxY = cb; }

  return { minX, minY, maxX, maxY };
}

const pct = (v, total) => Number(((v / total) * 100).toFixed(2));

// ---------------------------------------------------------------------------
// Interior (the white area text belongs in)
// ---------------------------------------------------------------------------
//
// The opaque bounds answer "where is the drawing", but the drawing includes
// decoration: 1.png's bat wings hang above the bubble and its cross dangles
// below, 5.png has heavy end-caps, 7.png has lace trim. Centring text on the
// *whole* drawing therefore puts it off the white area — which is exactly the
// off-centre text this measurement exists to fix.
//
// What the text actually belongs in is the bubble's flat interior: a solid
// near-white rectangle. So we find it by walking outward from the drawing's
// geometric centre in each of the four directions and stopping at the first
// pixel that isn't paper.
//
// ---------------------------------------------------------------------------
// Why a walk, and not a threshold over whole rows/columns
// ---------------------------------------------------------------------------
//
// The previous approach counted, for each row, what fraction of its pixels were
// paper and kept the longest run above 80%. That fails on exactly the art that
// needs measuring most: 7.png's interior is laced with a decorative border and
// the rows crossing it never reach 80% paper, so the search latched onto a
// 1:8 sliver along a wing (aspect 0.13) and reported a 28px sideways error. The
// same happened on 4.png and 5.png, which is why three of seven images had no
// interior at all and silently fell back to centring on the drawing.
//
// Averaging over a whole row conflates two different things — "how much white is
// in this row" and "where does the white *field* end" — and on framed art they
// disagree. The walk asks the second question directly, one pixel at a time,
// and the interior being a clean rectangle makes it exactly the right tool.
//
// It measures all seven shipped images with sane results (each interior is
// 64–96% of its drawing's width and 64–90% of its height), including the three
// the row-scan could not resolve at all.
function paperBounds(png, opaque, threshold = 12) {
  const { width, px, colorType } = png;
  // RGBA is what these files use; the others are handled so a re-export that
  // drops the alpha channel still measures rather than throwing.
  const bpp = colorType === 6 ? 4 : (colorType === 2 ? 3 : 4);
  const ai = bpp === 4 ? 3 : -1;
  // The interior fill is pure white (measured: 252–255 on every shipped file),
  // while frames, lace and wings are saturated or near-black. A high threshold
  // therefore separates them with a wide margin in both directions.
  const PAPER = 245;

  // "Not part of the flat interior" — either outside the drawing entirely
  // (transparent margin) or a frame/lace/wing pixel. This is the predicate the
  // walk terminates on.
  const isFrame = (x, y) => {
    const i = (y * width + x) * bpp;
    if (ai >= 0 && px[i + ai] < threshold) return true;   // transparent margin
    return !(px[i] >= PAPER && px[i + 1] >= PAPER && px[i + 2] >= PAPER);
  };

  const cx = (opaque.minX + opaque.maxX) / 2;
  const cy = (opaque.minY + opaque.maxY) / 2;

  // Walk out along one axis and return the *number of steps* the paper run
  // extends. The first non-paper pixel ends the run — it does not merely pause
  // it. A pausing walk escapes through any gap in the trim: 7.png's rightward
  // walk slipped past a break in the lace and ran to the canvas edge, reporting
  // an interior 200px wider on the right than the left on a symmetric bubble.
  // Stopping at the first non-paper pixel is also just what "the white field
  // ends here" means, which is the only question being asked.
  const walk = (dx, dy, maxSteps) => {
    let start = null;
    for (let s = 0; s < maxSteps; s++) {
      const x = Math.round(cx + dx * s), y = Math.round(cy + dy * s);
      if (isFrame(x, y)) {
        return start === null ? 0 : s - start;   // 0 ⇒ no interior on this axis
      }
      if (start === null) start = s;
    }
    return start === null ? 0 : maxSteps - start;
  };

  const drawW = opaque.maxX - opaque.minX;
  const drawH = opaque.maxY - opaque.minY;
  const halfW = walk(-1, 0, Math.round(drawW / 2) + 1);   // leftward
  const rightW = walk(1, 0, Math.round(drawW / 2) + 1);
  const upH = walk(0, -1, Math.round(drawH / 2) + 1);
  const downH = walk(0, 1, Math.round(drawH / 2) + 1);

  // Every axis must yield interior, or this isn't a bubble we can place text in.
  if (halfW <= 0 || rightW <= 0 || upH <= 0 || downH <= 0) return null;

  const box = {
    minX: Math.round(cx - halfW),
    maxX: Math.round(cx + rightW),
    minY: Math.round(cy - upH),
    maxY: Math.round(cy + downH),
  };

  // Sanity gate, kept as a guard against art that genuinely has no usable flat
  // area (an all-illustration "bubble", say). The interior has to be a real
  // region — a decent share of the drawing on both axes, and not a stripe. The
  // walk is far less prone to produce garbage than the row-scan was, but a
  // wrong interior is worse than none, and `geometryFor` has a sane fallback.
  const iw = box.maxX - box.minX + 1;
  const ih = box.maxY - box.minY + 1;
  if (iw / (drawW + 1) < 0.35 || ih / (drawH + 1) < 0.35) return null;
  if (iw / ih < 0.5 || iw / ih > 4.0) return null;

  return box;
}

console.log('\n文本框图片实际边界（不透明像素范围，单位：占整张 2048×2048 的百分比）\n');
console.log('file   bbox% (left top right bottom)        content% (w h)   aspect   interior(center x y)');

const rows = [];
for (const name of fs.readdirSync(DIR).sort()) {
  if (!name.toLowerCase().endsWith('.png')) continue;
  const img = decodePng(fs.readFileSync(path.join(DIR, name)));
  const b = opaqueBounds(img);
  if (!b) { console.log(`${name}  (fully transparent)`); continue; }

  const w = b.maxX - b.minX + 1;
  const h = b.maxY - b.minY + 1;
  const inner = paperBounds(img, b);

  // Where the text belongs: the centre of the white interior. Expressed both
  // as the interior's own box and as an offset from the *drawing's* centre, so
  // the renderer can shift the text without re-deriving anything.
  const info = {
    id: path.basename(name, '.png'),
    left: pct(b.minX, img.width),
    top: pct(b.minY, img.height),
    right: pct(img.width - 1 - b.maxX, img.height),
    bottom: pct(img.height - 1 - b.maxY, img.height),
    w: pct(w, img.width),
    h: pct(h, img.height),
    aspect: Number((w / h).toFixed(3)),
  };

  if (inner) {
    const cx = ((inner.minX + inner.maxX) / 2) / img.width;
    const cy = ((inner.minY + inner.maxY) / 2) / img.height;
    const drawCx = (b.minX + b.maxX) / 2 / img.width;
    const drawCy = (b.minY + b.maxY) / 2 / img.height;
    info.interior = {
      left: pct(inner.minX, img.width),
      top: pct(inner.minY, img.height),
      right: pct(img.width - 1 - inner.maxX, img.height),
      bottom: pct(img.height - 1 - inner.maxY, img.height),
      w: pct(inner.maxX - inner.minX + 1, img.width),
      h: pct(inner.maxY - inner.minY + 1, img.height),
      aspect: Number(((inner.maxX - inner.minX + 1) / (inner.maxY - inner.minY + 1)).toFixed(3)),
      // Offset of the interior's centre from the drawing's centre, as a
      // fraction of the *drawing's* size. Positive dy = interior sits lower.
      dx: Number((cx - drawCx).toFixed(4)),
      dy: Number((cy - drawCy).toFixed(4)),
    };
  }

  rows.push(info);
  console.log(
    `${info.id.padEnd(6)} ` +
    `${String(info.left).padStart(6)} ${String(info.top).padStart(6)} ` +
    `${String(info.right).padStart(6)} ${String(info.bottom).padStart(6)}   ` +
    `${String(info.w).padStart(6)} ${String(info.h).padStart(6)}   ${info.aspect}` +
    (info.interior
      ? `   dx=${String(info.interior.dx).padStart(7)} dy=${String(info.interior.dy).padStart(7)}` +
        ` aspect=${info.interior.aspect}`
      : '   (no interior found)'),
  );
}

console.log('\n--- 粘贴进 main/pet_text_boxes.js 的 GEOMETRY ---');
console.log('// dx/dy = 白色内区中心相对整体中心的偏移（占整体宽高的比例）');
console.log('// 文字需要按它做垂直/水平微移，否则会偏向一边');
for (const r of rows) {
  const i = r.interior || {};
  console.log(`  '${r.id}': { left: ${r.left}, top: ${r.top}, right: ${r.right}, bottom: ${r.bottom}, aspect: ${r.aspect}, dx: ${i.dx ?? 0}, dy: ${i.dy ?? 0} },`);
}
console.log();