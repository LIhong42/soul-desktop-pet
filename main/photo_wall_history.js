// main/photo_wall_history.js — 照片墙的导出历史。
//
// 用户导出一面墙以后，可能还想：
//
//   * 换个文件名再导一次（改个名字、加个日期）；
//   * 把上次那版（改了封面、挪了照片位置的那版）再导出来。
//
// 所以每次成功导出都在这里记一条：什么时候导的、导到哪里了、几张照片、
// 画布多大，以及**当时那面墙的样子**（一份状态快照，见
// main/photo_wall_state.js）。
//
// 快照让「按上次的样子再导一次」成为可能：渲染进程把快照里的设置读回
// 页面，用户看着上次的墙，确认后直接导出。
//
// 记录存在数据库的 settings 表里（一条 JSON），照片墙的导出次数不多，
// 一条足够。真要多了，再拆成表也行。

'use strict';

// 最多留多少条历史。旧的丢掉 —— 历史是用来「最近导过什么」的，不是档案。
const MAX_ENTRIES = 30;

// settings 表里存历史的键。
const HISTORY_KEY = 'photo_wall_export_history';

function parse(db) {
  let raw;
  try {
    raw = db.getSetting(HISTORY_KEY);
  } catch (e) {
    console.error('photo wall history: read failed', e);
    return [];
  }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('photo wall history: corrupt, ignored', e);
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

function write(db, list) {
  try {
    db.setSetting(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch (e) {
    console.error('photo wall history: write failed', e);
  }
}

// 记一次导出。最新的一条在最前面。
//
// `snapshot` 是当时那面墙的样子（形状 / 网格 / 画幅 / 调整 / 背景 / 格子
// 的摆法），渲染进程拿它来「按上次的样子再来一版」。
function addEntry(db, entry) {
  const e = entry || {};
  const list = parse(db);
  list.unshift({
    id: e.id || String(Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    exportedAt: e.exportedAt || db.nowStr(),
    path: e.path || '',
    width: Number(e.width) || 0,
    height: Number(e.height) || 0,
    photoCount: Number(e.photoCount) || 0,
    shapeId: e.shapeId || '',
    sizeId: e.sizeId || '',
    ratioId: e.ratioId || '',
    snapshot: e.snapshot || null,
  });
  write(db, list);
  return list[0];
}

// 读历史（最新的一条在最前面）。
function listEntries(db) {
  return parse(db);
}

// 删掉一条历史（用户在页面上把它从列表里删掉）。
function removeEntry(db, id) {
  const list = parse(db);
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return list;
  write(db, next);
  return next;
}

// 清空历史。
function clearEntries(db) {
  write(db, []);
  return [];
}

module.exports = {
  HISTORY_KEY,
  MAX_ENTRIES,
  addEntry,
  listEntries,
  removeEntry,
  clearEntries,
};
