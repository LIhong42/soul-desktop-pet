// main/photo_wall_state.js — 照片墙的「编辑状态」存读。
//
// 照片墙的编辑页（src/js/pages/photo_wall.js）里，用户可以：
//
//   * 换形状 / 网格 / 画幅
//   * 换背景
//   * 调整形状（挪位置、等比缩放）
//   * 把照片拖到别的格子（换顺序）
//   * 给某个格子改封面
//
// 这些改动以前只活在渲染进程的内存里 —— 用户进到别的页面再回来，整面墙
// 就回到了默认的样子，等于白改。
//
// 所以这里把「一份墙」存进数据库（settings 表，JSON 一条）。
//
// **一份墙由什么认出来？** 由它用的那几篇回忆（event ids）认出来 ——
// 同一组回忆 = 同一面墙。于是从导出页选同样的几篇回忆进来，编辑就都还在。
//
// 存的是**用户改过的那些**，不是整个渲染状态：
//
//   shapeId / sizeId / ratioId —— 用户选的形状、网格、画幅
//   transform                   —— 形状的调整（scale / dx / dy）
//   bgId                        —— 选中的背景
//   cells                       —— 每个格子里摆的是哪张照片、封面取景
//
// 照片本身不在这里（照片在数据库里，这里只存它的 id），临时导入的照片也
// 不在这里（它们属于这一轮，导出完就删了 —— 见 main/tmp_photos.js）。

'use strict';

const crypto = require('crypto');

// settings 表里这个前缀的键，都是某一面墙的编辑状态。
const KEY_PREFIX = 'photo_wall_state_';

// 一份墙的状态最多存多大。cells 是「格子数」条，一百多个格子也就几 KB；
// 上限只是防住一份坏掉的数据把设置表撑爆。
const MAX_STATE_BYTES = 512 * 1024;

// 一面墙的识别码：它用的那几篇回忆。
//
// 用了哈希而不是直接拼 id：id 里可能有奇怪字符，而且同一组回忆要算出同
// 一个码 —— 排序之后再哈希，所以顺序不同也是同一面墙（用户从导出页重新
// 勾选时，勾选的顺序常常不一样）。
function wallKey(eventIds) {
  const ids = Array.isArray(eventIds) ? eventIds.map(String) : [];
  const sorted = Array.from(new Set(ids)).sort();
  if (!sorted.length) return '';
  return crypto.createHash('sha1').update(sorted.join('\n')).digest('hex').slice(0, 20);
}

// 一份墙的完整状态（存下来的样子）。
//
//   version —— 存档的版本号。将来这份结构变了，老存档读不出来时按版本
//              丢掉重来，而不是读出一半。
//   eventIds —— 这面墙用的回忆（存下来是为了自证：万一哈希算法改了，
//              还能按 id 找回老存档）。
//   shapeId / sizeId / ratioId —— 形状、网格、画幅。
//   transform —— 形状的调整 { scale, dx, dy }。
//   bgId —— 背景 id（空串 = 无背景）。
//   cells —— [{ index, photoId, cover }]，cover 是 { ratio, x, y, zoom }。
//   savedAt —— 存下来的时间（本地时间字符串）。
const STATE_VERSION = 1;

function buildState(input) {
  const src = input || {};
  const cells = Array.isArray(src.cells) ? src.cells : [];
  return {
    version: STATE_VERSION,
    eventIds: Array.isArray(src.eventIds) ? src.eventIds.map(String) : [],
    shapeId: typeof src.shapeId === 'string' ? src.shapeId : '',
    sizeId: typeof src.sizeId === 'string' ? src.sizeId : '',
    ratioId: typeof src.ratioId === 'string' ? src.ratioId : '',
    transform: src.transform && typeof src.transform === 'object' ? {
      scale: Number(src.transform.scale),
      dx: Number(src.transform.dx),
      dy: Number(src.transform.dy),
    } : null,
    bgId: typeof src.bgId === 'string' ? src.bgId : '',
    cells: cells.map((c) => ({
      index: Number(c.index),
      photoId: c.photoId ? String(c.photoId) : null,
      cover: c.cover && typeof c.cover === 'object' ? {
        ratio: String(c.cover.ratio || ''),
        x: Number(c.cover.x),
        y: Number(c.cover.y),
        zoom: Number(c.cover.zoom),
      } : null,
    })),
  };
}

// 存一份墙的状态。返回存下来的那份（带 savedAt）。
//
// 存不下就当没存（返回 null）—— 存档是锦上添花，不该把页面弄挂。
function saveState(db, eventIds, input) {
  const key = wallKey(eventIds);
  if (!key) return null;
  const state = buildState(input);
  let json;
  try {
    json = JSON.stringify(state);
  } catch (e) {
    console.error('photo wall state: stringify failed', e);
    return null;
  }
  if (json.length > MAX_STATE_BYTES) {
    console.error('photo wall state: too big, not saved', json.length);
    return null;
  }
  try {
    db.setSetting(KEY_PREFIX + key, json);
  } catch (e) {
    console.error('photo wall state: save failed', e);
    return null;
  }
  return { ...state, savedAt: db.nowStr() };
}

// 读一份墙的状态。读不到 / 存的是老版本 / 存坏了 —— 都当成「没有存档」
// （返回 null），页面从默认的样子开始。
function loadState(db, eventIds) {
  const key = wallKey(eventIds);
  if (!key) return null;
  let raw;
  try {
    raw = db.getSetting(KEY_PREFIX + key);
  } catch (e) {
    console.error('photo wall state: load failed', e);
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('photo wall state: corrupt, ignored', e);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (Number(parsed.version) !== STATE_VERSION) return null;
  // transform 的三个数必须是数 —— 存坏的调整会让形状飞到画布外面去。
  const tf = parsed.transform;
  if (tf) {
    if (!Number.isFinite(tf.scale) || !Number.isFinite(tf.dx) || !Number.isFinite(tf.dy)) {
      parsed.transform = null;
    }
  }
  return parsed;
}

// 删掉一份墙的存档（「恢复默认」用）。
function clearState(db, eventIds) {
  const key = wallKey(eventIds);
  if (!key) return false;
  try {
    db.run('DELETE FROM settings WHERE key = ?', [KEY_PREFIX + key]);
  } catch (e) {
    console.error('photo wall state: clear failed', e);
    return false;
  }
  return true;
}

module.exports = {
  KEY_PREFIX,
  STATE_VERSION,
  wallKey,
  saveState,
  loadState,
  clearState,
};
