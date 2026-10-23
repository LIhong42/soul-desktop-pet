#!/usr/bin/env node
// scripts/smoke-settings-update-card.js — 设置页「软件更新」卡片的 DOM 检查。
//
// 做法沿用 smoke-settings-textboxes.js：用 vm 在 jsdom 上下文里跑真实的
// src/js/pages/settings.js（只桩掉 api / router / escapeHtml / toast），然后
// 断言用户实际看到的 DOM。测的是发布的那份代码，不是重写版。
//
// 覆盖各状态分支：已是最新 / 有新版本 / 无对应安装包 / 开发模式不支持 /
// 下载进度 / 后台状态推送。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const settingsSrc = fs.readFileSync(path.join(ROOT, 'src', 'js', 'pages', 'settings.js'), 'utf8');

let passed = 0;
let failed = 0;
const pending = [];
// 支持 async 回调：把检查挂到 pending 上，末尾统一 await 后统计。
// 同步回调立刻执行并统计——两条路径各走一次 fn()，不会重复调用。
function check(name, fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
    return;
  }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(
      () => { passed++; console.log(`  ok  ${name}`); },
      (err) => { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); },
    ));
    return;
  }
  passed++;
  console.log(`  ok  ${name}`);
}
function section(t) { console.log(`\n${t}`); }

const BASE = {
  supported: true,
  enabled: true,
  currentVersion: '0.1.0',
  repo: 'LIHong42/soul-desktop-pet',
  lastCheckAt: String(Date.now()),
  checking: false,
  downloading: false,
  installing: false,
  error: null,
  info: null,
};

// 起一份真实的 settings.js，桩掉它的外部依赖。
function boot(state) {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  // 卡片容器由 render() 的 innerHTML 创建；这里直接手工插入，模拟用户已经
  // 进入设置页、卡片已经渲染出来的状态，然后只调用 renderUpdateCard()。
  const withCard = indexHtml.replace(
    '</body>',
    '<div id="update-card"><div id="update-card-body"></div></div></body>',
  );
  const dom = new JSDOM(withCard, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window } = dom;
  const calls = { state, savedEnabled: null, openedUrl: null, listeners: {} };

  window.__apiStub = {
    settings: { get: () => Promise.resolve(null) },
    pet: {
      list: () => Promise.resolve([{ id: 'p1', name: 'VioletMoon' }]),
      listInstalled: () => Promise.resolve([{ id: 'p1', name: 'VioletMoon' }]),
      getCurrent: () => Promise.resolve('p1'),
      getWalkEnabled: () => Promise.resolve(true),
    },
    app: {
      getAutostart: () => Promise.resolve({ supported: false, enabled: false, active: false }),
      getUpdateState: () => Promise.resolve(calls.state),
      setUpdateEnabled: (on) => {
        calls.savedEnabled = on;
        calls.state = { ...calls.state, enabled: on };
        return Promise.resolve({ ok: true, enabled: on, state: calls.state });
      },
      checkUpdate: () => Promise.resolve({ ok: true, hasUpdate: true, info: calls.state.info, state: calls.state }),
      openExternal: (url) => { calls.openedUrl = url; return Promise.resolve({ ok: true }); },
    },
    on: (channel, cb) => {
      calls.listeners[channel] = calls.listeners[channel] || [];
      calls.listeners[channel].push(cb);
      return () => {
        calls.listeners[channel] = (calls.listeners[channel] || []).filter((f) => f !== cb);
      };
    },
  };
  window.confirm = () => true;

  const preamble = `
    const api = globalThis.__apiStub;
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = () => {};
    const register = () => {};
    const navigate = () => {};
  `;
  const patched = settingsSrc
    .replace(/^\s*import[^;]+;\s*$/gm, '')
    + '\nglobalThis.__update = { renderUpdateCard, paintUpdateCard, fmtBytes, fmtTime };';
  vm.runInContext(preamble + patched, dom.getInternalVMContext(), { filename: 'settings.js' });

  return {
    window,
    doc: window.document,
    calls,
    upd: window.__update,
    close: () => window.close(),
    html: () => {
      const el = window.document.getElementById('update-card-body');
      return el ? el.innerHTML : '';
    },
    text: () => {
      const el = window.document.getElementById('update-card-body');
      return el ? el.textContent : '';
    },
    push: (channel, payload) => {
      (calls.listeners[channel] || []).forEach((cb) => cb(payload));
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

const UPDATE_INFO = {
  version: '9.9.9',
  tag: 'v9.9.9',
  currentVersion: '0.1.0',
  hasUpdate: true,
  downloadable: true,
  notes: '修了若干问题',
  publishedAt: '',
  assetName: 'SoulDesktopPet Setup 9.9.9.exe',
  assetSize: 1,
};

(async () => {
  section('卡片骨架');
  const h = boot(BASE);
  check('模板里有 #update-card 与 #update-card-body', () => {
    assert.ok(settingsSrc.includes('id="update-card"'));
    assert.ok(settingsSrc.includes('id="update-card-body"'));
  });
  check('render() 把取到的状态交给 renderUpdateCard', () => {
    assert.ok(/await renderUpdateCard\(updateState\)/.test(settingsSrc));
  });
  check('渲染后当前版本号可见', async () => {
    await h.upd.renderUpdateCard(BASE);
    await tick();
    assert.ok(h.text().includes('0.1.0'), `实际: ${h.text().slice(0, 120)}`);
  });

  section('已是最新');
  check('显示「检查更新」按钮', () => {
    assert.ok(h.html().includes('btn-check-update'));
  });
  check('没有下载按钮', () => {
    assert.ok(!h.html().includes('btn-update-now'));
  });
  check('显示上次检查时间', () => {
    assert.ok(h.text().includes('上次检查'));
  });
  check('每日自动检查开关默认勾选', () => {
    assert.ok(/id="app-update-enabled"[^>]*checked/.test(h.html()));
  });
  check('复选框文案是「每天自动检查一次更新」', () => {
    assert.ok(h.text().includes('每天自动检查一次更新'));
  });

  section('有新版本');
  const u = boot({ ...BASE, info: UPDATE_INFO });
  await u.upd.renderUpdateCard({ ...BASE, info: UPDATE_INFO });
  await tick();
  check('显示新版本号与「发现新版本」', () => {
    assert.ok(u.text().includes('9.9.9'), u.text().slice(0, 160));
    assert.ok(u.text().includes('发现新版本'));
  });
  check('显示「下载并更新」按钮', () => {
    assert.ok(u.html().includes('btn-update-now'));
  });
  check('release notes 可展开', () => {
    assert.ok(u.html().includes('修了若干问题'));
    assert.ok(u.html().includes('<details'));
  });
  check('说明升级不会删除用户数据', () => {
    assert.ok(u.text().includes('升级不会删除'));
  });
  check('说明 SHA-256 校验', () => {
    assert.ok(u.text().includes('SHA-256'));
  });
  check('显示更新来源仓库', () => {
    assert.ok(u.text().includes('LIHong42/soul-desktop-pet'));
  });

  section('有新版本但无对应平台的安装包');
  const n = boot({ ...BASE, info: { ...UPDATE_INFO, downloadable: false, assetName: null } });
  await n.upd.renderUpdateCard({ ...BASE, info: { ...UPDATE_INFO, downloadable: false, assetName: null } });
  await tick();
  check('说明没有适用于当前系统的安装包', () => {
    assert.ok(n.text().includes('未提供适用于当前系统'), n.text().slice(0, 200));
  });
  check('给出「前往 GitHub 下载」按钮', () => {
    assert.ok(n.html().includes('btn-open-releases'));
  });
  check('不出现下载按钮', () => {
    assert.ok(!n.html().includes('btn-update-now'));
  });
  check('点击后调 openExternal 打开 Releases 页面', async () => {
    const btn = n.doc.getElementById('btn-open-releases');
    assert.ok(btn, '按钮应存在');
    btn.onclick();
    await tick();
    assert.ok(n.calls.openedUrl && n.calls.openedUrl.includes('/releases'),
      `实际打开: ${n.calls.openedUrl}`);
  });

  section('开发模式');
  const d = boot({ ...BASE, supported: false });
  await d.upd.renderUpdateCard({ ...BASE, supported: false });
  await tick();
  check('说明开发模式不支持自动更新', () => {
    assert.ok(d.text().includes('仅在打包安装版'), d.text().slice(0, 160));
  });
  check('不渲染任何更新按钮', () => {
    assert.ok(!d.html().includes('btn-check-update'));
    assert.ok(!d.html().includes('btn-update-now'));
  });

  section('下载进度');
  const p = boot({ ...BASE, info: UPDATE_INFO });
  await p.upd.renderUpdateCard({ ...BASE, info: UPDATE_INFO, downloading: true });
  await tick();
  check('推送 42% 后显示百分比', () => {
    p.push('app:update-progress', { phase: 'downloading', percent: 42, received: 4194304, total: 10485760 });
    assert.ok(p.text().includes('42%'), p.text().slice(0, 160));
    assert.ok(p.text().includes('正在下载安装包'));
  });
  check('已下载/总量格式化为 MB', () => {
    assert.ok(p.text().includes('4.0 MB'), p.text());
    assert.ok(p.text().includes('10.0 MB'));
  });
  check('下载中按钮禁用、不再提供下载按钮', () => {
    assert.ok(!p.html().includes('id="btn-update-now"'));
    assert.ok(p.html().includes('正在下载'));
  });
  check('content-length 缺失时用不确定态而不是显示具体百分比', () => {
    p.push('app:update-progress', { phase: 'downloading', percent: null, received: 1024, total: 0 });
    // 注意不能断言 !html.includes('0%')：'width:30%' 和 'width:100%' 都含有
    // '0%' 这个子串，那样断言的是字符串巧合而不是行为。要断言的是
    // 「没有把 null 渲染成一个具体百分比」——即文本里不出现 " N%" 形式的
    // 进度数字，且出现了不确定态动画标记。
    assert.ok(p.html().includes('indeterminate'), '应使用不确定态动画');
    assert.ok(!/正在下载安装包…\s*\d+%/.test(p.text()),
      `不应显示具体百分比: ${p.text().slice(0, 120)}`);
    // total 为 0 时也不该显示 "0 B / 0 B" 这种无意义的大小。
    assert.ok(!/\d+(\.\d+)?\s*B\s*\/\s*\d/.test(p.text()), p.text().slice(0, 160));
  });
  check('下载结束（状态推送 downloading=false）后进度条消失', () => {
    p.push('app:update-state', { ...BASE, info: UPDATE_INFO, downloading: false });
    assert.ok(!p.text().includes('正在下载安装包'), p.text().slice(0, 200));
  });

  section('后台每日检查的状态推送');
  check('推送「发现新版本」后出现下载按钮', () => {
    h.push('app:update-state', { ...BASE, info: UPDATE_INFO });
    assert.ok(h.text().includes('发现新版本'), h.text().slice(0, 160));
    assert.ok(h.html().includes('btn-update-now'), '应出现「下载并更新」');
    // 「重新检查」与「下载并更新」并存是有意为之：用户看到新版本后仍然
    // 可能想先确认一下是不是最新（尤其是 tag 被作者改过的情况）。
    assert.ok(h.html().includes('btn-check-update'), '应保留「重新检查」');
  });

  section('每日自动检查开关');
  check('取消勾选会落库 false', async () => {
    const t = boot({ ...BASE, enabled: false });
    await t.upd.renderUpdateCard({ ...BASE, enabled: false });
    await tick();
    const cb = t.doc.getElementById('app-update-enabled');
    assert.ok(cb, '开关应存在');
    assert.ok(!cb.checked, 'enabled=false 时应为未勾选');
  });
  check('勾选会落库 true', async () => {
    const t = boot({ ...BASE });
    await t.upd.renderUpdateCard({ ...BASE });
    await tick();
    const cb = t.doc.getElementById('app-update-enabled');
    cb.checked = true;
    cb.onchange({ target: cb });
    await tick();
    assert.strictEqual(t.calls.savedEnabled, true);
  });

  section('辅助函数');
  check('fmtBytes 换算正确', () => {
    assert.strictEqual(h.upd.fmtBytes(1024), '1.0 KB');
    assert.strictEqual(h.upd.fmtBytes(1048576), '1.0 MB');
    assert.strictEqual(h.upd.fmtBytes(512), '512 B');
  });
  check('fmtTime 对空值返回「从未」', () => {
    assert.strictEqual(h.upd.fmtTime(null), '从未');
    assert.strictEqual(h.upd.fmtTime(0), '从未');
  });
  check('fmtTime 补零到两位', () => {
    const d = new Date(2026, 0, 5, 9, 7);
    assert.strictEqual(h.upd.fmtTime(d.getTime()), '2026-01-05 09:07');
  });

  [h, u, n, d, p].forEach((x) => x.close());
  // 等所有 async 检查结算完再统计——否则通过/失败数会偏。
  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();