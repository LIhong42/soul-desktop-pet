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
//     and a deeper one;
//   · a palette of TWO colours becomes ONE style — the pale colour is
//     the body, the deep one is the header bar, and the foot strip is
//     derived from the body.
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
// Each palette carries the names the card gave its colours. They are the
// names the user would recognise, and the style's name is built from
// them.
//
// Every colour carries its RGB triple as well as its hex, because the RGB
// is what a designer actually wants to copy out of the picker — a hex is
// convenient for a file, an rgb() is convenient for a spec. The two are
// written side by side rather than one being computed from the other, so
// a card can be read straight off the picker without a conversion step —
// and checkPaletteRgb() below keeps the two from drifting apart.

export const DIARY_PALETTES = [
  {
    id: 'lotus',
    name: '藕粉荷塘',
    // 藕白 / 藕粉 / 藕紫 / 灰绿
    colors: [
      { name: '藕白', hex: '#faf4f1', rgb: [250, 244, 241] },
      { name: '藕粉', hex: '#efd6d9', rgb: [239, 214, 217] },
      { name: '藕紫', hex: '#dab6ca', rgb: [218, 182, 202] },
      { name: '灰绿', hex: '#aeb4ac', rgb: [174, 180, 172] },
    ],
  },
  {
    id: 'mist',
    name: '雾雾屿青岚',
    // 雾白 / 雾青 / 岛屿绿 / 深潭青
    colors: [
      { name: '雾白', hex: '#e6f0ef', rgb: [230, 240, 239] },
      { name: '雾青', hex: '#b9d4d0', rgb: [185, 212, 208] },
      { name: '岛屿绿', hex: '#739a95', rgb: [115, 154, 149] },
      { name: '深潭青', hex: '#405c59', rgb: [64, 92, 89] },
    ],
  },
  {
    id: 'reed',
    name: '蒹葭苍苍',
    // 苍青 / 芦花 / 霜白 / 暮紫
    colors: [
      { name: '苍青', hex: '#a1b4c0', rgb: [161, 180, 192] },
      { name: '芦花', hex: '#bbd7db', rgb: [187, 215, 219] },
      { name: '霜白', hex: '#d3e3e2', rgb: [211, 227, 226] },
      { name: '暮紫', hex: '#c3cde3', rgb: [195, 205, 227] },
    ],
  },
  {
    id: 'fir',
    name: '冷杉石雾',
    // 冷杉绿 / 石雾灰 / 雪白
    colors: [
      { name: '冷杉绿', hex: '#6e8378', rgb: [110, 131, 120] },
      { name: '石雾灰', hex: '#c8ccc8', rgb: [200, 204, 200] },
      { name: '雪白', hex: '#f6f5f1', rgb: [246, 245, 241] },
    ],
  },
  {
    id: 'salt',
    name: '海盐云雾',
    // 海盐蓝 / 云雾白 / 贝壳灰
    colors: [
      { name: '海盐蓝', hex: '#afcbda', rgb: [175, 203, 218] },
      { name: '云雾白', hex: '#f5f7f6', rgb: [245, 247, 246] },
      { name: '贝壳灰', hex: '#c9d2d5', rgb: [201, 210, 213] },
    ],
  },
  {
    id: 'afterglow',
    name: '余温',
    // 陶土橘 / 暖米 / 香茶棕 / 象牙白
    colors: [
      { name: '陶土橘', hex: '#b76a47', rgb: [183, 106, 71] },
      { name: '暖米', hex: '#e8d8bf', rgb: [232, 216, 191] },
      { name: '香茶棕', hex: '#a97457', rgb: [169, 116, 87] },
      { name: '象牙白', hex: '#f2e8da', rgb: [242, 232, 218] },
    ],
  },
  {
    id: 'haze',
    name: '朦胧',
    // 雾霭蓝 / 裸粉 / 云贝白 / 雾紫灰
    colors: [
      { name: '雾霭蓝', hex: '#afc3d6', rgb: [175, 195, 214] },
      { name: '裸粉', hex: '#e8c9c9', rgb: [232, 201, 201] },
      { name: '云贝白', hex: '#eee4dc', rgb: [238, 228, 220] },
      { name: '雾紫灰', hex: '#b9a9b5', rgb: [185, 169, 181] },
    ],
  },
  {
    id: 'closer',
    name: '靠近',
    // 焦糖棕 / 奶杏 / 奶油白 / 燕麦米
    colors: [
      { name: '焦糖棕', hex: '#a96538', rgb: [169, 101, 56] },
      { name: '奶杏', hex: '#e6c4a5', rgb: [230, 196, 165] },
      { name: '奶油白', hex: '#f4e6d4', rgb: [244, 230, 212] },
      { name: '燕麦米', hex: '#cdb59e', rgb: [205, 181, 158] },
    ],
  },
  {
    id: 'reading-room',
    name: '阅读室晨光',
    // 书页米 / 雾霾蓝 / 墨蓝灰 / 胡桃棕
    colors: [
      { name: '书页米', hex: '#eee6d9', rgb: [238, 230, 217] },
      { name: '雾霾蓝', hex: '#a8b7c4', rgb: [168, 183, 196] },
      { name: '墨蓝灰', hex: '#4f5f6c', rgb: [79, 95, 108] },
      { name: '胡桃棕', hex: '#7b6251', rgb: [123, 98, 81] },
    ],
  },
  {
    id: 'parchment',
    name: '羊皮纸手稿',
    // 羊皮纸白 / 鼠尾草绿 / 铅笔灰 / 暖卡其
    colors: [
      { name: '羊皮纸白', hex: '#f3ecdd', rgb: [243, 236, 221] },
      { name: '鼠尾草绿', hex: '#9aaa92', rgb: [154, 170, 146] },
      { name: '铅笔灰', hex: '#6c716d', rgb: [108, 113, 109] },
      { name: '暖卡其', hex: '#b8a184', rgb: [184, 161, 132] },
    ],
  },
  {
    id: 'ink-moon',
    name: '墨迹与月光',
    // 蓝墨紫 / 雾灰 / 旧书米 / 冷月白
    colors: [
      { name: '蓝墨紫', hex: '#706f8d', rgb: [112, 111, 141] },
      { name: '雾灰', hex: '#c8c5c0', rgb: [200, 197, 192] },
      { name: '旧书米', hex: '#e6ddcf', rgb: [230, 221, 207] },
      { name: '冷月白', hex: '#f7f4ef', rgb: [247, 244, 239] },
    ],
  },
  {
    id: 'night-mist',
    name: '夜雾青',
    // 深海蓝 / 霜月白
    colors: [
      { name: '深海蓝', hex: '#4a6075', rgb: [74, 96, 117] },
      { name: '霜月白', hex: '#e6e8e3', rgb: [230, 232, 227] },
    ],
  },
  {
    id: 'lonely-rose',
    name: '孤独特白',
    // 雨巷灰 / 枯玫瑰 / 淡雾米
    colors: [
      { name: '雨巷灰', hex: '#7f868d', rgb: [127, 134, 141] },
      { name: '枯玫瑰', hex: '#b9999a', rgb: [185, 153, 154] },
      { name: '淡雾米', hex: '#e9e3da', rgb: [233, 227, 218] },
    ],
  },
  {
    id: 'walnut-study',
    name: '胡桃书房',
    // 冷咖棕 / 雾蓝灰 / 奶油白 / 旧金棕
    colors: [
      { name: '冷咖棕', hex: '#8c7869', rgb: [140, 120, 105] },
      { name: '雾蓝灰', hex: '#b7c4cc', rgb: [183, 196, 204] },
      { name: '奶油白', hex: '#f6f2eb', rgb: [246, 242, 235] },
      { name: '旧金棕', hex: '#a68c69', rgb: [166, 140, 105] },
    ],
  },
  {
    id: 'solitude',
    name: '孤独自白',
    // 夜雾青 / 雪岩灰
    colors: [
      { name: '夜雾青', hex: '#62767c', rgb: [98, 118, 124] },
      { name: '雪岩灰', hex: '#d5d7d2', rgb: [213, 215, 210] },
    ],
  },
  {
    id: 'tentative',
    name: '试探',
    // 柔雾粉 / 薄纱灰紫 / 暖贝白 / 暮光莓灰
    colors: [
      { name: '柔雾粉', hex: '#e8ccc5', rgb: [232, 204, 197] },
      { name: '薄纱灰紫', hex: '#a995b0', rgb: [169, 149, 176] },
      { name: '暖贝白', hex: '#f3e6df', rgb: [243, 230, 223] },
      { name: '暮光莓灰', hex: '#836c7f', rgb: [131, 108, 127] },
    ],
  },
  {
    id: 'flutter',
    name: '心动',
    // 蜜桃绒 / 暖珊瑚 / 奶油杏 / 玫瑰豆沙
    colors: [
      { name: '蜜桃绒', hex: '#f4c2b5', rgb: [244, 194, 181] },
      { name: '暖珊瑚', hex: '#e67e73', rgb: [230, 126, 115] },
      { name: '奶油杏', hex: '#f3e4d3', rgb: [243, 228, 211] },
      { name: '玫瑰豆沙', hex: '#c9827c', rgb: [201, 130, 124] },
    ],
  },
  {
    id: 'unsaid',
    name: '欲言又止',
    // 烟霭紫 / 灰樱粉 / 雾灰藕 / 暮李紫
    colors: [
      { name: '烟霭紫', hex: '#a28fa5', rgb: [162, 143, 165] },
      { name: '灰樱粉', hex: '#d7b9c1', rgb: [215, 185, 193] },
      { name: '雾灰藕', hex: '#c5bdc6', rgb: [197, 189, 198] },
      { name: '暮李紫', hex: '#7e6f83', rgb: [126, 111, 131] },
    ],
  },
  {
    id: 'blueberry',
    name: '蓝莓冰酪',
    // 冰酪白 / 奶油紫 / 莓果紫 / 浅藤紫
    colors: [
      { name: '冰酪白', hex: '#f7f3ff', rgb: [247, 243, 255] },
      { name: '奶油紫', hex: '#ede4ff', rgb: [237, 228, 255] },
      { name: '莓果紫', hex: '#d8c8ff', rgb: [216, 200, 255] },
      { name: '浅藤紫', hex: '#b89aff', rgb: [184, 154, 255] },
    ],
  },
];

// The colour of a hex, as a triple.
function rgbOf(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Every colour's RGB triple must be the hex read out again.
//
// The two are written side by side in the data, which is convenient but
// also easy to get wrong: type a hex and forget to update the numbers,
// and the picker prints a colour that is not the one it shows. So the
// data is checked against itself, and the cards that disagree are named
// — a mistake here is silent otherwise, because a style still renders.
//
// A colour with no RGB triple at all is filled in from its hex, so a
// card added later without the numbers still works.
export function checkPaletteRgb(palettes = DIARY_PALETTES) {
  const bad = [];
  for (const p of palettes) {
    for (const c of p.colors) {
      const want = rgbOf(c.hex);
      if (!Array.isArray(c.rgb) || c.rgb.length !== 3) {
        c.rgb = want;
        continue;
      }
      if (c.rgb[0] !== want[0] || c.rgb[1] !== want[1] || c.rgb[2] !== want[2]) {
        bad.push(`${p.id}/${c.name}: hex ${c.hex} is rgb(${want.join(', ')}), data says rgb(${c.rgb.join(', ')})`);
      }
    }
  }
  return bad;
}
