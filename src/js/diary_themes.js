// src/js/diary_themes.js — the diary background styles.
//
// The diary editor (src/js/pages/diary_edit.js) lets the user pick one of
// the backgrounds for the page they are writing on. Each style is a small
// design system, not just a color:
//
//   headerBg   — the bar across the top of the page (it carries the title)
//   headerText — the title's color on that bar. The pale headers need
//                dark ink, the dark ones take white — one color for all
//                of them would leave the title invisible on half.
//   bgTop      — the surface the body is written on (the "sky")
//   bgMid      — the decorative strip at the bottom of the page (the
//                "ground"). It is a SEPARATE layer, not a band painted
//                over the body: the body grows with the text and the
//                photos, and the decoration must stay below it instead
//                of being covered by it.
//   bgFlat     — a flat version of the upper band, for the little toolbars
//                that sit on the page (a gradient would look broken there)
//   text       — the body text color on that background
//   muted      — secondary text (timestamps, hints)
//   rule       — the hairline between the header bar and the page
//   dots       — the three accent dots shown in the picker preview
//
// The backgrounds are pure CSS colors so a diary entry needs no image
// assets and renders instantly at any size. Each style is painted in
// THREE strips, the way the reference artwork is: the coloured header
// bar, the body surface and the decorative strip at the bottom.
//
// The three strips are three separate DOM layers, stacked in that order.
// The body layer takes its height from its content — the more the user
// writes, the taller it grows — while the decorative strip keeps its own
// height and stays pinned below it. Painting all three as one background
// stack instead (the way this used to work) makes the decoration a band
// INSIDE the body, so a long entry has its text and photos sitting on
// top of the decoration.
//
// The ids are persisted in `memorial_events.background`, so they must stay
// stable across versions. Adding a new style is safe: an unknown id falls
// back to DEFAULT_THEME_ID.
//
// The styles come in two families. The first six are hand-written. The
// rest are DERIVED from the colour cards in src/js/diary_palettes.js — a
// card of three colours gives one style, a card of four gives two (a
// pale one and a deep one). The rules that do the deriving are in
// paletteStyles() further down.

import { DIARY_PALETTES } from './diary_palettes.js';

export const DIARY_THEMES = [
  {
    id: 'light',
    name: 'Light',
    headerBg: '#c4af5e',
    headerText: '#3a3222',
    bgTop: '#e5d6b0',
    bgFlat: '#e5d6b0',
    // The decorative strip is a shade deeper than the body, so the two
    // layers read as two even on the palest paper.
    bgMid: '#d3bd88',
    text: '#3a3222',
    muted: '#5a5040',
    rule: '#e2d5b8',
    dots: ['#d9c76a', '#3a3222', '#ffffff'],
  },
  {
    id: 'dark',
    name: 'Dark',
    headerBg: '#697356',
    headerText: '#ffffff',
    bgTop: '#393628',
    bgFlat: '#393628',
    bgMid: '#2e2b1f',
    text: '#e8e6dc',
    muted: '#aab8cd',
    rule: '#3a3b34',
    dots: ['#7d9a7f', '#e8e6dc', '#3f4038'],
  },
  {
    id: 'shiro',
    name: 'Shiro',
    headerBg: '#e4caa4',
    headerText: '#3a3222',
    // A pale sky over a stone floor.
    bgTop: '#e7eef0',
    bgFlat: '#e7eef0',
    bgMid: '#a1a097',
    text: '#2f3540',
    muted: '#4a4436',
    rule: '#e4e8ed',
    dots: ['#e8c9a0', '#3a3222', '#ffffff'],
  },
  {
    id: 'shadow',
    name: 'Shadow',
    headerBg: '#77613b',
    headerText: '#ffffff',
    // A night sky over a dark blue stone floor.
    bgTop: '#0c1a31',
    bgFlat: '#0c1a31',
    bgMid: '#304366',
    text: '#e6ecf7',
    muted: '#aab8cd',
    rule: '#2a3552',
    dots: ['#7a6647', '#f0e6cd', '#3d4a6b'],
  },
  {
    id: 'helena',
    name: 'Helena',
    headerBg: '#b3cee8',
    headerText: '#2b3a49',
    // A pale blue sky over a band of grass.
    bgTop: '#d1ddde',
    bgFlat: '#d1ddde',
    bgMid: '#9aad90',
    text: '#2b3a49',
    muted: '#3d4433',
    rule: '#d6e3ee',
    dots: ['#a9c9e3', '#33506b', '#ffffff'],
  },
  {
    id: 'poonam',
    name: 'Poonam',
    headerBg: '#47678c',
    headerText: '#ffffff',
    // A deep night over a dark teal ground.
    bgTop: '#16243d',
    bgFlat: '#16243d',
    bgMid: '#384b54',
    text: '#e4ecf8',
    muted: '#aab8cd',
    rule: '#2c3d63',
    dots: ['#4d6fa8', '#ffffff', '#2a3552'],
  },
];

// ---- The colour cards ----------------------------------------------------
//
// The styles above were written by hand. The ones below are DERIVED from
// the colour cards in src/js/diary_palettes.js, so a new card only has to
// be measured once and the layers fall out of it.
//
// A card is a set of colours, and a sheet is painted in three strips —
// the header bar, the body and the decorative strip at the bottom. So:
//
//   · a card of THREE colours becomes ONE style — the three colours are
//     the three strips of the sheet.
//
//   · a card of FOUR colours becomes TWO styles: the four colours are
//     split into two triples, so the same card yields a pale sheet and a
//     deep one.
//
// The rules that do the splitting live in paletteStyles() below. They
// are the same rules the hand-written styles follow, so the two families
// read as one set:
//
//   · the header bar takes the sheet's ACCENT colour — the one that
//     carries the card's identity;
//   · the body takes the sheet's PAPER colour;
//   · the foot strip takes the sheet's GROUND colour, one step deeper
//     than the paper, so the two lower layers read as two;
//   · the ink on the header bar and on the body is chosen by the paper's
//     own lightness: dark ink on a pale bar, white on a deep one.
//
// The shades are worked out in RGB rather than guessed, so a card that
// happens to be very pale still gets a foot strip that is visibly
// different from its body.

// ---- Colour helpers ------------------------------------------------------

// '#rrggbb' → [r, g, b]
function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// [r, g, b] → '#rrggbb'
function rgbToHex(rgb) {
  return '#' + rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');
}

// How bright a colour is on screen (0 = black, 255 = white).
//
// The weights are the usual perceptual ones: the eye reads green much
// more strongly than blue, so a green-heavy colour counts as brighter
// than a blue-heavy one of the same numbers.
function luma(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Mix a colour towards white (amount > 0) or towards black (amount < 0).
// The amount is a share of the way there, so 0.2 keeps 80% of the
// original.
function shade(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  return rgbToHex([
    r + (target - r) * t,
    g + (target - g) * t,
    b + (target - b) * t,
  ]);
}

// How well two colours read against each other.
//
// The WCAG relative-luminance ratio: 1 is invisible, 21 is the best a
// pair can do.
function contrast(a, b) {
  const la = luma(a);
  const lb = luma(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// The ink that reads on a coloured surface.
//
// It is whichever of the two inks reads better on that surface — not a
// brightness threshold. A mid-tone surface (a terracotta bar, a sage
// one) is exactly the case a threshold gets wrong: dark ink on it can
// fall to 2:1 while white ink on the same colour sits at 4.5:1.
function inkOn(surface) {
  return contrast('#ffffff', surface) >= contrast('#2b2b2b', surface)
    ? '#ffffff'
    : '#2b2b2b';
}

// The ink the BODY is written in.
//
// The body ink is picked for READABILITY, not for belonging to the card:
// the words have to read on the paper they are written on, and a card's
// own colour is no guarantee of that. A mid-tone paper — a terracotta
// or a sage — needs near-black ink; a deep paper needs near-white.
//
// So the ink is one of two fixed values, whichever of them reads better
// on that paper. A shade of the paper would look more "of the card", but
// it also lands in the unreadable middle whenever the paper is mid-tone.
function bodyInk(paper) {
  return contrast('#f2f4f3', paper) >= contrast('#26262a', paper)
    ? '#f2f4f3'
    : '#26262a';
}

// The secondary ink — the timestamps and the hints.
//
// It is a step further from the body ink than the body ink is from the
// paper, so a hint reads as a hint and not as more writing.
function mutedInk(paper) {
  return contrast('#a8b2b0', paper) >= contrast('#5c5c62', paper)
    ? '#a8b2b0'
    : '#5c5c62';
}

// A paper the words can actually be read on.
//
// A card's deepest colour is not always a good writing surface. A
// mid-tone colour — a terracotta, a sage, a slate — is the hard case:
// dark ink on it lands around 3:1 and white ink around 2.8:1, so
// neither of them is comfortable to read.
//
// When the chosen paper is one of those, it is nudged towards whichever
// end it is CLOSER to, in small steps, until one of the two inks reads
// properly on it. Moving it the short way is the point: a terracotta
// that only just misses the mark needs a small push towards white, not
// a march all the way to black.
//
// The colour is still the card's own — it is only moved far enough to
// become a surface you can write on.
function readablePaper(paper) {
  // Enough for the darkest ink to read comfortably.
  if (contrast('#26262a', paper) >= 4.5) return paper;
  // Enough for the lightest ink to read comfortably.
  if (contrast('#f2f4f3', paper) >= 4.5) return paper;

  // Neither ink works: the paper is mid-tone. It goes towards the end
  // it is closer to — white if it is the lighter half, black if it is
  // the darker half — in small steps, until one of the inks does read.
  const towardsLight = luma(paper) >= 128;
  let c = paper;
  for (let i = 0; i < 24; i++) {
    c = shade(c, towardsLight ? 0.12 : -0.12);
    if (contrast('#26262a', c) >= 4.5 || contrast('#f2f4f3', c) >= 4.5) return c;
  }
  return c;
}

// ---- The card → sheet rules ----------------------------------------------

// The sheet a set of three colours is painted in.
//
// `paper` is the colour the body is written on, `accent` is the colour
// of the header bar, and `ground` is the colour of the strip at the
// bottom.
//
// The ground is only a SUGGESTION. The one rule that never bends is
// that the ground sits BELOW the body: it is the "ground" of the sheet,
// and a strip that is brighter than the surface it lies under reads as
// a highlight, not as the bottom of the page. So if the suggested
// ground lands on the wrong side of the paper, it is derived from the
// paper instead — one step deeper, in the direction that keeps the two
// layers apart.
function sheetOf(id, name, paper, accent, ground) {
  // The paper is made readable FIRST, and the ground follows it — so
  // the foot strip stays a step deeper than the body it sits under,
  // even when the body had to be moved to be readable.
  const p = readablePaper(paper);
  let g = ground;
  if (!g || luma(g) >= luma(p)) g = shade(p, -0.14);
  // The ground must also be visibly different from the paper, or the
  // two layers read as one.
  if (contrast(g, p) < 1.06) g = shade(p, -0.2);
  // Whether the body ink is the light one or the dark one.
  const onDark = bodyInk(p) === '#f2f4f3';
  const ink = bodyInk(p);
  return {
    id,
    name,
    headerBg: accent,
    headerText: inkOn(accent),
    bgTop: p,
    bgFlat: p,
    bgMid: g,
    text: ink,
    // Secondary text: a little further from the body ink, so a hint
    // reads as a hint.
    muted: mutedInk(p),
    // The hairline between the bar and the paper: the paper, one step
    // towards the accent, so the seam is visible without being a line.
    rule: onDark ? shade(p, 0.16) : shade(p, -0.12),
    // The three accent dots in the picker preview: the accent, the
    // paper and the ink.
    dots: [accent, p, onDark ? '#ffffff' : ink],
  };
}

// The styles one card becomes.
//
// The colours are put in order of their own brightness FIRST, so the
// rules below do not depend on the order the card happened to print its
// colours in. Two of the reference cards run dark-to-light and two of
// them run light-to-dark; a sheet built on the printed order would come
// out upside down for half of them.
//
// With the colours ordered pale → deep as c0..c3:
//
//   · a card of THREE colours gives ONE style — the palest is the paper,
//     the deepest is the bar, the one between them is the ground.
//
//   · a card of FOUR colours gives TWO styles:
//
//       the PALE sheet — paper c0, ground c1, accent c2
//       the DEEP sheet — paper c3, ground c2, accent c1
//
//     The pale sheet is written on the palest colour and the deep sheet
//     on the deepest, so the same card yields two sheets that are as
//     far apart as the card allows. They share the two middle colours —
//     which is what makes them read as the same card rather than as two
//     unrelated styles.
//
// A sheet's three layers are always ordered pale → deep as well: the
// body is the palest of the three, the foot strip is one step deeper,
// and the bar carries the accent. That is the structure the hand-written
// styles follow too, so the two families read as one set.
function paletteStyles(palette) {
  // Pale → deep.
  const cs = palette.colors.slice().sort((a, b) => luma(b.hex) - luma(a.hex));
  const n = cs.length;
  const out = [];

  if (n === 3) {
    const [c0, c1, c2] = cs;
    out.push(sheetOf(
      `${palette.id}`, palette.name,
      c0.hex, c2.hex, c1.hex
    ));
    return out;
  }

  if (n === 4) {
    const [c0, c1, c2, c3] = cs;
    // The pale sheet: the palest colour is the paper, the second is the
    // ground, the third is the accent.
    out.push(sheetOf(
      `${palette.id}`, palette.name,
      c0.hex, c2.hex, c1.hex
    ));
    // The deep sheet: the deepest colour is the paper, the third is the
    // ground, the second is the accent.
    out.push(sheetOf(
      `${palette.id}-deep`, `${palette.name}深`,
      c3.hex, c1.hex, c2.hex
    ));
    return out;
  }

  // A card of any other size has no rule of its own; it is skipped
  // rather than painted into something arbitrary.
  return out;
}

// The styles derived from every colour card.
const PALETTE_THEMES = DIARY_PALETTES.flatMap(paletteStyles);

// The full list the picker offers: the hand-written styles first, then
// the ones the cards produce.
export const ALL_DIARY_THEMES = DIARY_THEMES.concat(PALETTE_THEMES);

// The style used when a diary entry has no background set (or carries an
// id from a future version we don't know about).
export const DEFAULT_THEME_ID = 'light';

const THEME_BY_ID = Object.fromEntries(ALL_DIARY_THEMES.map((t) => [t.id, t]));

// Look up a theme by id. Returns the default theme for unknown ids so a
// stale / corrupt value in the DB never renders a blank page.
export function getDiaryTheme(id) {
  return THEME_BY_ID[id] || THEME_BY_ID[DEFAULT_THEME_ID];
}

// The background layers of a theme, as a list of CSS colors.
//
// The sheet reads as three horizontal strips, the way the reference
// artwork does: the header bar, the body surface and the decorative
// strip at the bottom. They are three separate layers, NOT bands painted
// into one background — the body layer grows with the text and the photos
// it holds, and the decoration has to stay below that instead of being
// covered by it.
export function diaryBgLayers(theme) {
  const t = theme || getDiaryTheme(DEFAULT_THEME_ID);
  return [
    // The body surface (the "sky").
    t.bgTop,
    // The decorative strip (the "ground").
    t.bgMid,
  ];
}

// The inline style object a themed container needs. The CSS custom
// properties are read by the .diary-page rules in src/css/styles.css.
export function diaryThemeVars(theme) {
  const t = theme || getDiaryTheme(DEFAULT_THEME_ID);
  const layers = diaryBgLayers(t);
  return {
    '--diary-header-bg': t.headerBg,
    // The title on the header bar. The pale headers need dark ink; the
    // dark ones take white.
    '--diary-header-text': t.headerText,
    // The body surface. Its height comes from its content, so the
    // decoration below it never has to compete with the text.
    '--diary-bg': layers[0],
    // The decorative strip at the bottom of the page.
    '--diary-bg-foot': layers[1],
    // The flat upper band, for the little toolbars that sit on the page.
    // They need a solid color — a gradient stack would look broken there.
    '--diary-bg-flat': t.bgFlat,
    '--diary-text': t.text,
    '--diary-muted': t.muted,
    '--diary-rule': t.rule,
  };
}
