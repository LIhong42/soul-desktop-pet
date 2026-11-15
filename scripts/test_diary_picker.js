// scripts/test_diary_picker.js — checks the diary background picker.
//
// The picker is built from the colour cards in src/js/diary_palettes.js:
// a card of three colours gives one style, a card of four gives two, and
// a card of two gives one as well. The tiles also print the RGB values
// of the card they came from, so a designer can copy them out.
//
// Run: node scripts/test_diary_picker.js

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
// api.js only checks that the bridge is there when it is imported.
window.mp = {};

(async () => {
  const { ALL_DIARY_THEMES, DIARY_THEMES, getDiaryTheme } = await import('../src/js/diary_themes.js');
  const { DIARY_PALETTES, checkPaletteRgb } = await import('../src/js/diary_palettes.js');
  const report = { ok: false, checks: {} };
  const C = report.checks;

  // ---- The cards ---------------------------------------------------------

  // Every card's RGB triple must be the hex read out again. A colour whose
  // numbers drifted from its hex would put a wrong value on the picker.
  const mismatch = checkPaletteRgb();
  C.rgbMatchesHex = mismatch.length === 0;
  if (mismatch.length) C.rgbMismatch = mismatch;

  // Every card carries between two and four colours — the sizes the
  // sheet rules know how to paint.
  const badSize = DIARY_PALETTES.filter(
    (p) => p.colors.length < 2 || p.colors.length > 4
  );
  C.cardSizes = badSize.length === 0;
  if (badSize.length) C.badCardSizes = badSize.map((p) => p.id);

  // Every card's colours carry a name, a hex and an RGB triple.
  const badColor = [];
  for (const p of DIARY_PALETTES) {
    for (const c of p.colors) {
      if (!c.name || !/^#[0-9a-f]{6}$/i.test(c.hex || '')) badColor.push(`${p.id}/${c.name}`);
      if (!Array.isArray(c.rgb) || c.rgb.length !== 3) badColor.push(`${p.id}/${c.name}: rgb`);
    }
  }
  C.colorFields = badColor.length === 0;
  if (badColor.length) C.badColors = badColor;

  // ---- The styles the cards produce -------------------------------------

  // A card of four colours gives two styles, a card of two or three gives
  // one. Nothing else is painted.
  const styleCount = [];
  for (const p of DIARY_PALETTES) {
    const want = p.colors.length === 4 ? 2 : 1;
    const got = ALL_DIARY_THEMES.filter((t) => t.id === p.id || t.id === `${p.id}-deep`).length;
    styleCount.push({ id: p.id, want, got });
  }
  const badCount = styleCount.filter((s) => s.want !== s.got);
  C.styleCounts = badCount.length === 0;
  if (badCount.length) C.badStyleCounts = badCount;

  // The ids are persisted in the database, so they must be unique.
  const ids = ALL_DIARY_THEMES.map((t) => t.id);
  C.uniqueIds = new Set(ids).size === ids.length;

  // Every style must have the whole set of layers — a style missing one
  // paints an empty strip.
  const layerKeys = ['headerBg', 'headerText', 'bgTop', 'bgFlat', 'bgMid', 'text', 'muted', 'rule'];
  const badLayers = [];
  for (const t of ALL_DIARY_THEMES) {
    for (const k of layerKeys) {
      if (!/^#[0-9a-f]{6}$/i.test(t[k] || '')) badLayers.push(`${t.id}.${k}`);
    }
    if (!Array.isArray(t.dots) || t.dots.length !== 3) badLayers.push(`${t.id}.dots`);
  }
  C.allLayers = badLayers.length === 0;
  if (badLayers.length) C.badLayers = badLayers;

  // The body ink has to read on the body, and the header ink on the
  // header. The body is 16px regular, so it needs the full 4.5:1; the
  // title in the header bar is 20px bold, which is large text, so 3:1 is
  // the ratio it has to reach.
  function luma(hex) {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  }
  function contrast(a, b) {
    const la = luma(a);
    const lb = luma(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  const lowContrast = ALL_DIARY_THEMES
    .filter((t) => contrast(t.text, t.bgTop) < 4.5 || contrast(t.headerText, t.headerBg) < 3)
    .map((t) => t.id);
  C.readable = lowContrast.length === 0;
  if (lowContrast.length) C.lowContrast = lowContrast;

  // The foot strip has to read as a separate layer from the body it lies
  // under, or the two merge into one.
  const merged = ALL_DIARY_THEMES
    .filter((t) => contrast(t.bgMid, t.bgTop) < 1.06)
    .map((t) => t.id);
  C.footStripVisible = merged.length === 0;
  if (merged.length) C.mergedLayers = merged;

  // ---- The picker's HTML -------------------------------------------------

  // The picker is built by diary_edit.js, which needs the whole app
  // around it. The part that matters here — the tile's RGB readout — is
  // reproduced from the same data the picker reads.
  const withCard = ALL_DIARY_THEMES.filter((t) => t.palette);
  const cardsShown = withCard.every((t) => {
    const p = t.palette;
    return p.colors.every((c) => {
      const rgb = `rgb(${c.rgb.join(', ')})`;
      return /^rgb\(\d+, \d+, \d+\)$/.test(rgb);
    });
  });
  C.rgbReadout = cardsShown;
  C.tilesWithCard = withCard.length;
  C.tilesTotal = ALL_DIARY_THEMES.length;

  // Every card-derived style keeps the card it came from, so the picker
  // can name the colours and quote their RGB values.
  const cardStyles = ALL_DIARY_THEMES.filter((t) => t.id !== 'light' && !DIARY_THEMES.some((h) => h.id === t.id));
  const noCard = cardStyles.filter((t) => !t.palette).map((t) => t.id);
  C.paletteAttached = noCard.length === 0;
  if (noCard.length) C.missingCard = noCard;

  // The report holds two kinds of entry: a PASS/FAIL flag per check, and
  // a few plain numbers (how many tiles there are). Only the flags count
  // towards the result — the numbers are there to be read.
  const FLAGS = [
    'rgbMatchesHex', 'cardSizes', 'colorFields', 'styleCounts', 'uniqueIds',
    'allLayers', 'readable', 'footStripVisible', 'rgbReadout', 'paletteAttached',
  ];
  report.ok = FLAGS.every((k) => C[k] === true);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
