// src/js/diary_palettes.js — the colour cards the diary backgrounds are
// painted from.
//
// A PALETTE is a small set of colours lifted off a colour card. Every
// palette becomes one or two background styles (see src/js/diary_themes.js):
//
//   · a palette of THREE colours becomes ONE style — the three colours
//     are the three layers of the sheet (header bar, body, foot strip);
//   · a palette of FOUR colours becomes TWO styles — the four colours
//     are split into two triples, so the same card yields a pale sheet
//     and a deeper one.
//
// The colours are stored as hex, and the RGB triple of each one is
// derived from it. The derivation rules (which colour lands on which
// layer, which ink the header takes, how the body text is coloured) all
// live in src/js/diary_themes.js — this file only holds the DATA.
//
// The colours were measured off the reference artwork itself rather than
// copied from the labels printed on it: a couple of those labels are
// typos (#eziceb) or stale (#d2d2e4 on a pink swatch), and the pixels are
// what the artwork actually is.
//
// Each palette carries the three names the card gave its colours. They
// are the names the user would recognise, and the style's name is built
// from them.

export const DIARY_PALETTES = [
  {
    id: 'lotus',
    name: '藕粉荷塘',
    // 藕白 / 藕粉 / 藕紫 / 灰绿
    colors: [
      { name: '藕白', hex: '#faf4f1' },
      { name: '藕粉', hex: '#efd6d9' },
      { name: '藕紫', hex: '#dab6ca' },
      { name: '灰绿', hex: '#aeb4ac' },
    ],
  },
  {
    id: 'mist',
    name: '雾雾屿青岚',
    // 雾白 / 雾青 / 岛屿绿 / 深潭青
    colors: [
      { name: '雾白', hex: '#e6f0ef' },
      { name: '雾青', hex: '#b9d4d0' },
      { name: '岛屿绿', hex: '#739a95' },
      { name: '深潭青', hex: '#405c59' },
    ],
  },
  {
    id: 'reed',
    name: '蒹葭苍苍',
    // 苍青 / 芦花 / 霜白 / 暮紫
    colors: [
      { name: '苍青', hex: '#a1b4c0' },
      { name: '芦花', hex: '#bbd7db' },
      { name: '霜白', hex: '#d3e3e2' },
      { name: '暮紫', hex: '#c3cde3' },
    ],
  },
  {
    id: 'fir',
    name: '冷杉石雾',
    // 冷杉绿 / 石雾灰 / 雪白
    colors: [
      { name: '冷杉绿', hex: '#6e8378' },
      { name: '石雾灰', hex: '#c8ccc8' },
      { name: '雪白', hex: '#f6f5f1' },
    ],
  },
  {
    id: 'salt',
    name: '海盐云雾',
    // 海盐蓝 / 云雾白 / 贝壳灰
    colors: [
      { name: '海盐蓝', hex: '#afcbda' },
      { name: '云雾白', hex: '#f5f7f6' },
      { name: '贝壳灰', hex: '#c9d2d5' },
    ],
  },
  {
    id: 'afterglow',
    name: '余温',
    // 陶土橘 / 暖米 / 香茶棕 / 象牙白
    colors: [
      { name: '陶土橘', hex: '#b76a47' },
      { name: '暖米', hex: '#e8d8bf' },
      { name: '香茶棕', hex: '#a97457' },
      { name: '象牙白', hex: '#f2e8da' },
    ],
  },
  {
    id: 'haze',
    name: '朦胧',
    // 雾霭蓝 / 裸粉 / 云贝白 / 雾紫灰
    colors: [
      { name: '雾霭蓝', hex: '#afc3d6' },
      { name: '裸粉', hex: '#e8c9c9' },
      { name: '云贝白', hex: '#eee4dc' },
      { name: '雾紫灰', hex: '#b9a9b5' },
    ],
  },
  {
    id: 'closer',
    name: '靠近',
    // 焦糖棕 / 奶杏 / 奶油白 / 燕麦米
    colors: [
      { name: '焦糖棕', hex: '#a96538' },
      { name: '奶杏', hex: '#e6c4a5' },
      { name: '奶油白', hex: '#f4e6d4' },
      { name: '燕麦米', hex: '#cdb59e' },
    ],
  },
];
