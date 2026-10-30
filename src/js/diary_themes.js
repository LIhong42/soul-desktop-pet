// src/js/diary_themes.js — the six diary background styles.
//
// The diary editor (src/js/pages/diary_edit.js) lets the user pick one of
// six backgrounds for the page they are writing on. Each style is a small
// design system, not just a color:
//
//   headerBg   — the bar across the top of the page (it carries the title)
//   headerText — the title's color on that bar. The pale headers need
//                dark ink, the dark ones take white — one color for all
//                six would leave the title invisible on half of them.
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

// The style used when a diary entry has no background set (or carries an
// id from a future version we don't know about).
export const DEFAULT_THEME_ID = 'light';

const THEME_BY_ID = Object.fromEntries(DIARY_THEMES.map((t) => [t.id, t]));

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
