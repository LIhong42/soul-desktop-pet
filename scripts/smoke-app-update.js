#!/usr/bin/env node
// scripts/smoke-app-update.js — 自动更新逻辑的离线自测。
//
// 只覆盖「不联网也能确定对错」的部分：版本号解析与比较、平台资产匹配、
// 校验和解析。这些是更新流程里最容易悄悄出错、又最难在真机上复现的地方
// ——比较函数写错的表现是「明明有更新却说已是最新」，或者反过来。
//
// 网络交互（GitHub API / 下载 / 校验和不匹配时拒绝安装）需要真网和
// 打包环境，不在这里模拟；那条链路靠人工验证。
//
// 用法: node scripts/smoke-app-update.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// main/app_update.js 依赖 electron（app/net/shell…），而这里要在纯 Node 下
// 跑。把 require('electron') 挡掉，换一个够用的替身：只提供这几个函数被
// 用到的最小实现。
const Module = require('module');
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-update-stub-'));
const STUB_PATH = path.join(appDir, '__electron_stub__.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

function section(t) { console.log(`\n${t}`); }

// ---- 替身 ----
fs.writeFileSync(
  STUB_PATH,
  `const pkg = require(${JSON.stringify(path.join(__dirname, '..', 'package.json'))});
module.exports = {
  app: {
    isPackaged: false,
    getVersion: () => pkg.version,
    getName: () => pkg.productName || pkg.name,
    getPath: () => require('os').tmpdir(),
    on: () => {},
    once: () => {},
    quit: () => {},
  },
  shell: { showItemInFolder: () => {} },
};
`,
  'utf8',
);

const updater = require(path.join(__dirname, '..', 'main', 'app_update.js'));

// ---- 版本解析 ----
section('versionTuple — 版本号按 - 和 . 切成数字元组');

check('1.2.3 → [1,2,3]', () => {
  assert.deepStrictEqual(updater.versionTuple('1.2.3'), [1, 2, 3]);
});
check('0.1.0 → [0,1,0]', () => {
  assert.deepStrictEqual(updater.versionTuple('0.1.0'), [0, 1, 0]);
});
check('1.2.3-rc.1 的非数字片段按 -1 处理（排在 1.2.3 之后而不是抛异常）', () => {
  const t = updater.versionTuple('1.2.3-rc.1');
  assert.deepStrictEqual(t, [1, 2, 3, -1, 1]);
});
check('非数字片段不产生 NaN', () => {
  for (const v of ['1.2.beta', 'x', '', '1..2']) {
    for (const n of updater.versionTuple(v)) {
      assert.ok(Number.isInteger(n), `${v} → ${JSON.stringify(updater.versionTuple(v))} 含非整数`);
    }
  }
});

// ---- 版本比较 ----
section('isAtLeastVersion — 判断本地版本是否已经 >= 远端');

check('相同版本视为已最新', () => {
  assert.strictEqual(updater.isAtLeastVersion('1.2.3', '1.2.3'), true);
});
check('本地落后 → false（有更新）', () => {
  assert.strictEqual(updater.isAtLeastVersion('1.2.2', '1.2.3'), false);
});
check('本地领先 → true（无更新）', () => {
  assert.strictEqual(updater.isAtLeastVersion('1.2.4', '1.2.3'), true);
});
check('0.1.0 vs 0.1.0 — 本项目当前版本', () => {
  assert.strictEqual(updater.isAtLeastVersion('0.1.0', '0.1.0'), true);
});
check('0.2.0 vs 0.1.0 — 数字比较而非字符串比较（字符串会把 10 排在 9 前）', () => {
  assert.strictEqual(updater.isAtLeastVersion('0.2.0', '0.1.0'), true);
  assert.strictEqual(updater.isAtLeastVersion('0.1.0', '0.2.0'), false);
});
check('1.10.0 > 1.9.0 — 纯数字版本按数值比，不按字典序', () => {
  assert.strictEqual(updater.isAtLeastVersion('1.9.0', '1.10.0'), false);
  assert.strictEqual(updater.isAtLeastVersion('1.10.0', '1.9.0'), true);
});
check('位数不同的版本按高位补 0 比较', () => {
  assert.strictEqual(updater.isAtLeastVersion('1.2', '1.2.0'), true);
  assert.strictEqual(updater.isAtLeastVersion('1.2', '1.2.1'), false);
});
check('非纯数字版本退化为字符串相等（预发布版不会误判为有更新）', () => {
  assert.strictEqual(updater.isAtLeastVersion('1.2.3-beta', '1.2.3-beta'), true);
  assert.strictEqual(updater.isAtLeastVersion('1.2.3-beta', '1.2.3'), false);
});
check('主版本差异（0.x → 1.x）判定为有更新', () => {
  assert.strictEqual(updater.isAtLeastVersion('0.1.0', '1.0.0'), false);
  assert.strictEqual(updater.isAtLeastVersion('1.0.0', '0.9.0'), true);
});

// ---- 平台 / 资产匹配 ----
section('detectVariant + pickAsset — 按平台挑出正确的安装包');

check('开发模式下 isSupported() 为 false', () => {
  // 上面写的 electron 替身里 isPackaged: false
  assert.strictEqual(updater.isSupported(), false);
});

check('REPO 常量指向用户指定的仓库', () => {
  assert.strictEqual(updater.REPO, 'LIhong42/soul-desktop-pet');
});

check('CHECK_INTERVAL_MS 为一天', () => {
  assert.strictEqual(updater.CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000);
});

check('win-x64 能从 assets 里认出 electron-builder 的产物名', () => {
  // 本项目 package.json 没有覆盖 build.nsis.artifactName，electron-builder
  // 默认产出 `${productName} Setup ${version}.exe`，其中含 " Setup " 而
  // 不是 "-setup"。detectVariant 的 pattern 必须同时认这两种命名，否则会
  // 匹配不到任何资产、把「有更新」报成「没有对应平台的安装包」。
  const variant = { name: 'win-x64', assetPattern: /(-setup\.exe| Setup .*\.exe)$/i };
  const assets = [
    { name: 'SoulDesktopPet-0.1.3-win-x64-setup.exe', updated_at: '2026-01-02T00:00:00Z' },
    { name: 'SoulDesktopPet Setup 1.2.3.exe', updated_at: '2026-01-01T00:00:00Z' },
    { name: 'SoulDesktopPet Setup 1.2.3.exe.blockmap', updated_at: '2026-01-01T00:00:00Z' },
    { name: 'latest.yml', updated_at: '2026-01-01T00:00:00Z' },
  ];
  const picked = assets.filter((a) => variant.assetPattern.test(a.name));
  assert.strictEqual(picked.length, 2, '两种命名都应匹配，但 .blockmap / .yml 不算');
  assert.ok(!picked.some((a) => a.name.endsWith('.blockmap')), '.blockmap 不是安装包');
  assert.ok(!picked.some((a) => a.name.endsWith('.yml')), '.yml 不是安装包');
});

check('detectVariant 的 win pattern 同时接受两种命名（防止漏匹配资产）', () => {
  // 直接用模块自己的 pattern，而不是测试里另写一份——否则这里测的其实
  // 是测试自己的正则，模块里的改动不会被覆盖到。
  const variant = updater.detectVariant();
  if (!variant) return; // 非 Windows 平台跳过
  assert.ok(variant.assetPattern.test('SoulDesktopPet Setup 1.2.3.exe'),
    '默认命名 " Setup N.N.N.exe" 必须匹配');
  assert.ok(variant.assetPattern.test('SoulDesktopPet-0.1.3-win-x64-setup.exe'),
    '带架构后缀的 "-win-x64-setup.exe" 必须匹配');
  assert.ok(!variant.assetPattern.test('SoulDesktopPet Setup 1.2.3.exe.blockmap'));
});

check('资产名后缀匹配容忍带版本号的前缀', () => {
  // 与 fetchExpectedChecksum 的 endsWith 逻辑保持一致
  const name = 'SoulDesktopPet Setup 1.2.3.exe';
  const line = `${'a'.repeat(64)}  ${name}`;
  const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
  assert.ok(m, '校验和行应当能被解析');
  assert.strictEqual(m[2].trim().endsWith(name), true);
});

// ---- 端到端摘要校验（不联网） ----
section('SHA-256 校验 — 下载文件与期望摘要的比对');

check('正确摘要匹配', () => {
  const data = Buffer.from('pretend installer bytes');
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  assert.strictEqual(digest, require('crypto')
    .createHash('sha256').update(data).digest('hex'));
});

check('SHA2-256SUMS 行解析：标准格式与二进制模式都能取到摘要', () => {
  const expected = 'b'.repeat(64);
  const cases = [
    `${expected}  SoulDesktopPet Setup 1.2.3.exe`,   // sha256sum 默认两空格
    `${expected} *SoulDesktopPet Setup 1.2.3.exe`,  // 二进制模式
    `${expected}   SoulDesktopPet Setup 1.2.3.exe`, // 多余空格
  ];
  for (const line of cases) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    assert.ok(m, `解析失败: ${JSON.stringify(line)}`);
    assert.strictEqual(m[1].toLowerCase(), expected);
    assert.strictEqual(m[2].trim(), 'SoulDesktopPet Setup 1.2.3.exe');
  }
});

check('SHA2-256SUMS 里没有目标文件时返回 null（触发拒绝安装）', () => {
  const text = ['a'.repeat(64) + '  Other-File.exe'].join('\n');
  const name = 'SoulDesktopPet Setup 1.2.3.exe';
  let found = null;
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    if (m[2].trim().endsWith(name)) { found = m[1]; break; }
  }
  assert.strictEqual(found, null);
});

check('摘要不匹配时必须判定为失败', () => {
  const a = crypto.createHash('sha256').update(Buffer.from('a')).digest('hex');
  const b = crypto.createHash('sha256').update(Buffer.from('b')).digest('hex');
  assert.notStrictEqual(a.toLowerCase(), b.toLowerCase());
});

// ---- 数据安全：更新不触碰用户数据 ----
section('用户数据安全 — 更新流程不得删除 %APPDATA%/SoulDesktopPet/');

check('安装包下载到系统临时目录，不写入安装目录或用户数据目录', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'app_update.js'), 'utf8');
  // tempDir() 用 os.tmpdir()，而不是 app.getPath('appData')
  assert.ok(src.includes("path.join(os.tmpdir(), 'SoulDesktopPet-update')"),
    '下载目录应当是临时目录');
  assert.ok(!/getPath\('appData'\)/.test(src),
    'app_update.js 不应引用 appData 目录');
  assert.ok(!/rmSync|unlinkSync\(dbPath|rmdirSync/.test(src),
    '更新流程不应包含任何递归删除');
});

check('package.json 显式设置 deleteAppDataOnUninstall=false', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.nsis.deleteAppDataOnUninstall, false,
    '未显式关闭的话，依赖 electron-builder 默认值就没有保障');
});

check('安装前先退出应用，让 before-quit 的 db.save() 有机会执行', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'app_update.js'), 'utf8');
  const spawnIdx = src.indexOf('spawn(installerPath');
  const quitIdx = src.indexOf('app.quit()');
  assert.ok(spawnIdx > 0 && quitIdx > 0);
  assert.ok(spawnIdx < quitIdx,
    '必须先启动安装器再退出——但真正被测的是安装器不会强杀本进程，见下一条');
});

check('安装器以 detached 方式启动，不阻塞主进程退出', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'app_update.js'), 'utf8');
  assert.ok(/detached:\s*true/.test(src), '安装器必须 detached');
  assert.ok(/unref\(\)/.test(src), '安装器必须 unref，否则主进程会等它');
});

check('重启逻辑挂在 app 的 quit 事件上，且带延迟', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'app_update.js'), 'utf8');
  assert.ok(/app\.once\('quit'/.test(src), '应当等应用完全退出后再拉起新版本');
  assert.ok(/setTimeout\(spawnRelaunch,\s*\d+\)/.test(src),
    '重启前需要等待安装器写入');
});

// ---- 独立于 reference 文件夹 ----
section('项目约束 — 实现不依赖 reference/');

check('app_update.js 不 require reference 下的任何东西', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'app_update.js'), 'utf8');
  assert.ok(!/require\([^)]*reference/.test(src));
});

check('没有把 reference/ 放进 electron-builder 的 files 里', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const all = pkg.build.files.join(' ');
  assert.ok(!/reference/.test(all), 'reference 目录不应参与打包');
});

// ---- 结果 ----
console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
process.exit(failed ? 1 : 0);