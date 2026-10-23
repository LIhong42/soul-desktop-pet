// main/app_update.js — 自动更新（更新源为 GitHub Releases）
//
// 设计沿用 reference/yt-dlp/yt_dlp/update.py 的自更新机制，但适配
// Electron + electron-builder 的打包形态。核心对应关系：
//
//   yt-dlp                          本项目
//   ------------------------------  ------------------------------------
//   __version__ (version.py)        app.getVersion()（读 package.json）
//   version_tuple() + _version_     versionTuple() + isAtLeastVersion()
//     compare()
//   api.github.com/…/releases/      同左，取 tag_name
//   _get_variant_and_executable_    detectVariant()（平台/架构 → 资产名）
//     path() / _FILE_SUFFIXES
//   SHA2-256SUMS 校验               SHA2-256SUMS 校验（同源 HTTPS）
//   _download_asset() 的 <!DOCTYPE  同样的 HTML 错误页嗅探
//     html> 嗅探
//   .new/.old 重命名替换             启动 NSIS 安装包（Windows 无法热替换
//                                   正在运行的 exe）
//   is_non_updateable()             isSupported()（开发模式不可更新）
//   「未校验不自动重启」             「未通过校验一律拒绝安装」（更严格，
//                                   见 verifyDownloaded）
//
// 三条硬性约束，都是有意为之：
//
//   1. 未通过 SHA-256 校验的构建绝不安装。yt-dlp 在缺校验和时只是「不自动
//      重启」但仍写入文件；这里直接不写盘——下载一个来源不明的可执行文件
//      到磁盘的代价比多一次手动安装高得多。
//   2. 安装前必须先退出本进程。Windows 不允许替换正在运行的 exe，而
//      NSIS 会 taskkill /f 强杀应用（见 electron-builder 的
//      allowOnlyOneInstallerInstance.nsh），那会绕过我们的 before-quit，
//      有丢失未落盘数据的风险。所以顺序是：落盘 → 发退出事件 → 等进程真的
//      结束 → 再启动安装器。
//   3. 用户数据（%APPDATA%/SoulDesktopPet/）与安装目录完全分离，升级不碰它。
//      配套保障在 package.json 的 build.nsis.deleteAppDataOnUninstall=false。

const { app, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---- 常量 ----

// GitHub 仓库。改这里即可把更新源指向别的仓库。
const REPO = 'LIhong42/soul-desktop-pet';
const GITHUB_API_BASE = 'https://api.github.com/repos';
const GITHUB_DL_BASE = 'https://github.com';
const USER_AGENT = `${app.getName()}-updater/${app.getVersion()}`;

// db.settings 里的 key。存的是「用户最后一次的意图」，而不是「上次检查
// 成功没成功」——两者是不同的状态，见 syncOnLaunch 的同类注释。
const SETTING_ENABLED = 'app_update_enabled';
const SETTING_LAST_CHECK = 'app_update_last_check';
const SETTING_LAST_INFO = 'app_update_last_info';

// 每天检查一次。存的是时间戳（毫秒），不是日期字符串，避免时区问题。
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 启动后延迟多久做第一次自动检查。给窗口时间完成加载，也避免用户
// 一开机就连网。这个延迟对「每天一次」的语义没有影响——syncOnLaunch
// 会按 lastCheck 的实际值决定要不要真的查。
const FIRST_CHECK_DELAY_MS = 60 * 1000;

// 下载超时。GitHub 的 release 资产下载偶尔会挂住，给个上限比无限等好。
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const API_TIMEOUT_MS = 30 * 1000;

// 每个状态码的错误文案。返回 null 表示「这个状态码还能重试」。
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// ---- 版本比较 ----
//
// 对应 yt-dlp 的 utils/_utils.py:2912 `version_tuple` 与
// update.py:396 `_version_compare`。

// 只匹配点分隔的数字（对应 yt-dlp 的 _VERSION_RE = `(\d+\.)*\d+`）。
// 带 -rc.1 / +build 之类后缀的字符串会匹配失败，从而走下面的字符串比较
// 分支——和 yt-dlp 的行为一致。
const NUMERIC_VERSION_RE = /^(\d+\.)*\d+$/;

// '1.2.3' → [1, 2, 3]。按 - 和 . 切分（yt-dlp 用 `[-.]`）。
// 非数字片段按 -1 处理，这样 '1.2.-rc' 会排在 '1.2.0' 之后而不是抛异常。
function versionTuple(v) {
  return String(v)
    .split(/[-.]/)
    .map((e) => {
      const n = parseInt(e, 10);
      return Number.isNaN(n) ? -1 : n;
    });
}

// 本地版本是否已经 >= 传入版本。对应 yt-dlp 的 `_version_compare`：
// 两边都是纯数字版本时按元组比，否则退化为字符串相等。
function isAtLeastVersion(current, requested) {
  if (NUMERIC_VERSION_RE.test(`${current}.${requested}`)) {
    const a = versionTuple(current);
    const b = versionTuple(requested);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      // 缺失的位补 0，而不是 -1。补 -1 会让 '1.2' 被判定为早于 '1.2.0'
      // （后者多出一个 0 段），从而漏掉一次本该有的更新。versionTuple 里
      // 的 -1 只用于「这段根本不是数字」的预发布版本，两种情况含义不同。
      const x = a[i] === undefined ? 0 : a[i];
      const y = b[i] === undefined ? 0 : b[i];
      if (x !== y) return x > y;
    }
    return true;
  }
  return String(current) === String(requested);
}

// ---- 平台/资产名 ----
//
// 对应 yt-dlp 的 _get_variant_and_executable_path + _FILE_SUFFIXES +
// _get_binary_name。yt-dlp 要区分 onedir/onefile、musl/glibc、macOS 版本，
// Electron 应用只有一种形态（一个安装包），所以只需要平台 + 架构。

// 本项目 package.json 的 build.win.target 只产出 x64 的 NSIS 安装包，
// 因此其他架构上不存在可安装的产物——返回 null 让调用方明确拒绝，
// 而不是下载一个注定装不上的东西。
//
// assetPattern 要同时接受两种命名，因为产物名取决于有没有覆盖
// build.nsis.artifactName：
//   · 未覆盖（本项目现状）→ `SoulDesktopPet Setup 0.1.3.exe`
//   · 覆盖成带架构的模板    → `SoulDesktopPet-0.1.3-win-x64-setup.exe`
// 只认其中一种会让「有更新」被报成「没有对应平台的安装包」，用户看到的是
// 一个自相矛盾的提示。两种都认，代价只是多匹配一个文件，而 .blockmap /
// .yml 之类的附属文件两条规则都不会命中。
const WIN_SETUP_RE = /(-setup\.exe| Setup .+\.exe)$/i;

function detectVariant() {
  const platform = process.platform;
  if (platform === 'win32') {
    if (process.arch !== 'x64') return null; // 没有 arm64/x86 安装包
    return { name: 'win-x64', assetPattern: WIN_SETUP_RE };
  }
  if (platform === 'darwin') {
    if (process.arch === 'arm64') return { name: 'mac-arm64', assetPattern: /-(mac|osx)-arm64\.dmg$/i };
    return { name: 'mac-x64', assetPattern: /-(mac|osx)(-intel|-x64)?\.dmg$/i };
  }
  if (platform === 'linux') {
    if (process.arch === 'arm64') return { name: 'linux-arm64', assetPattern: /-arm64\.AppImage$/i };
    return { name: 'linux-x64', assetPattern: /-x86_64\.AppImage$/i };
  }
  return null;
}

// 自动更新在当前环境下是否可用。对应 yt-dlp 的 is_non_updateable()：
// 开发模式下 process.execPath 指向的是 node_modules 里的 electron.exe，
// 拿它当更新目标毫无意义，所以直接拒绝并说明原因。
function isSupported() {
  if (!app.isPackaged) return false;
  if (process.platform !== 'win32') return false;
  return !!detectVariant();
}

// ---- HTTP ----

// 走 https.request 而不是 fetch/net.request：需要流式下载（64MB+ 的安装包
// 不能整个读进内存），也要精确控制超时。
function httpsRequest(url, { headers = {}, timeout = API_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, ...headers } }, (res) => {
      resolve(res);
    });
    req.setTimeout(timeout, () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

// GitHub 错误页会以 200 返回 HTML body（见 yt-dlp update.py:311-317 的
// 注释与实现）。不嗅探的话会把整张错误页当成 JSON 解析，报出一个和真实
// 原因毫无关系的 SyntaxError。
function sniffHtml(buf) {
  return buf.length >= 9 && buf.slice(0, 9).toString('latin1').toUpperCase() === '<!DOCTYPE';
}

// 查询 GitHub Releases API，返回最新 release 的元信息。对应 yt-dlp 的
// _call_api + _get_version_info。
async function fetchLatestRelease() {
  const url = `${GITHUB_API_BASE}/${REPO}/releases/latest`;
  const res = await httpsRequest(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.statusCode !== 200) {
    const err = new Error(`GitHub API 返回 ${res.statusCode}`);
    err.statusCode = res.statusCode;
    // 404 通常意味着仓库还没有发布任何 Release——这不算故障，值得单独
    // 区分开，否则用户看到的是一句无意义的「检查失败」。
    err.notFound = res.statusCode === 404;
    throw err;
  }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (sniffHtml(buf)) throw new Error('GitHub 返回了网页而不是 release 数据');
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error('GitHub 返回的数据无法解析');
  }
  return {
    tag: json.tag_name,
    name: json.name,
    body: json.body || '',
    publishedAt: json.published_at || '',
    assets: Array.isArray(json.assets) ? json.assets : [],
  };
}

// 从 release 的 assets 里挑出当前平台该下载的那个。对应 yt-dlp 的
// _get_binary_name()（不过 yt-dlp 是按 variant 精确拼名字，我们是按
// 命名约定匹配——因为 electron-builder 的产物名带架构后缀）。
function pickAsset(assets, variant) {
  const matched = assets.filter((a) => variant.assetPattern.test(a.name || ''));
  if (matched.length === 0) return null;
  // 多个匹配时取最新上传的那个。electron-builder 偶尔会同时上传
  // .blockmap 之类的附属文件，但 blockmap 不匹配上面的正则，所以这里
  // 实际只会命中一个安装包。
  matched.sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''));
  return matched[matched.length - 1];
}

// 下载 release 资产。tag 为 'latest' 时走 releases/latest/download/<name>，
// 否则走 releases/download/<tag>/<name>——与 yt-dlp 的 _download_asset
// 用的是同一组 URL。
function downloadAsset(name, tag, destPath, onProgress) {
  const url = tag === 'latest'
    ? `${GITHUB_DL_BASE}/${REPO}/releases/latest/download/${encodeURIComponent(name)}`
    : `${GITHUB_DL_BASE}/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  return streamToFile(url, destPath, onProgress);
}

// 下载到文件，边写边算 sha256、边回报进度。
//
// 校验和是边下边算的，不是下完再读一遍文件算——64MB 的安装包没必要为了
// 校验再读一次磁盘。
//
// 重定向自己处理：GitHub 的 assets 链接会 302 到一个带签名参数的对象存储
// 地址。手动跟随而不是交给调用方，是为了让 redirect 也能落在同一个
// sha256 计算里——如果重定向后重新下载一次，摘要就只覆盖了第二段。
function streamToFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hop = 0;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(destPath); } catch (_) { /* 文件可能还没建 */ }
      reject(e);
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      // 跟随重定向。限制 5 跳，防止异常的 Location 头造成死循环。
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hop >= 5) {
          fail(new Error('重定向次数过多'));
          return;
        }
        hop++;
        const next = new URL(res.headers.location, url).toString();
        streamToFile(next, destPath, onProgress).then(done, fail);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`下载失败：HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        fail(err);
        return;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(destPath);
      let received = 0;
      let lastEmit = 0;

      res.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        // 限流进度事件：64MB 的包会产生上千个 data 事件，不节流的话
        // IPC 会被进度消息刷爆。
        const now = Date.now();
        if (onProgress && now - lastEmit > 200) {
          lastEmit = now;
          onProgress({
            received,
            total,
            percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
          });
        }
      });
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (onProgress) onProgress({ received, total, percent: 100 });
        done({ bytes: received, sha256: hash.digest('hex') });
      });
      res.pipe(out);
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('下载超时')));
    req.on('error', fail);
  });
}

// 下载 SHA2-256SUMS 并找出目标文件对应的摘要。对应 yt-dlp update.py:455-471
// ——同样是解析 sha256sum 的标准输出格式（`<hex>  <name>`），按文件名后缀匹配。
//
// 返回 null 表示「这个 release 没有校验和」。调用方必须把 null 当作拒绝安装
// 的理由之一，而不是跳过校验继续装。
async function fetchExpectedChecksum(assetName, tag) {
  const url = tag === 'latest'
    ? `${GITHUB_DL_BASE}/${REPO}/releases/latest/download/SHA2-256SUMS`
    : `${GITHUB_DL_BASE}/${REPO}/releases/download/${encodeURIComponent(tag)}/SHA2-256SUMS`;
  const res = await httpsRequest(url, { timeout: API_TIMEOUT_MS });
  // 404 不是错误：release 可能压根没上传校验和文件。
  if (res.statusCode === 404) return null;
  if (res.statusCode !== 200) {
    const err = new Error(`无法获取校验和：HTTP ${res.statusCode}`);
    err.statusCode = res.statusCode;
    throw err;
  }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    // 按文件名后缀匹配，和 yt-dlp 的 `ln.endswith(binary_name)` 一致。
    // electron-builder 的产物名带版本号，用后缀比全等更稳。
    if (m[2].trim().endsWith(assetName)) return m[1].toLowerCase();
  }
  return null;
}

// ---- 临时文件 ----

// 下载落到磁盘哪里。放在系统临时目录而不是安装目录：安装目录可能是
// Program Files（需要管理员权限），而这里只是暂存，之后由安装器接管。
function tempDir() {
  const dir = path.join(os.tmpdir(), 'SoulDesktopPet-update');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- 状态 ----

// 模块级单例。渲染进程通过 IPC 读它的状态，main.js 启动它做每日检查。
let state = {
  checking: false,   // 是否正在检查
  downloading: false, // 是否正在下载
  installing: false,  // 安装器是否已经启动
  info: null,         // 最近一次查到的更新信息
  error: null,        // 最近一次错误（检查或下载）
};

function publicState(db) {
  return {
    ...state,
    currentVersion: app.getVersion(),
    supported: isSupported(),
    // 用户意图默认开。首次启动没表态过时，按「开」处理——和 autostart
    // 的 syncOnLaunch 是同一个约定。
    enabled: db ? db.getSetting(SETTING_ENABLED) !== '0' : true,
    lastCheckAt: db ? db.getSetting(SETTING_LAST_CHECK) : null,
    repo: REPO,
  };
}

// 渲染进程监听更新状态变化。
let statusListener = null;
function onStatus(cb) { statusListener = cb; }
function emit() {
  if (statusListener) {
    try { statusListener(); } catch (e) { console.error('[app_update] status listener failed:', e); }
  }
}

// ---- 核心流程 ----

// 查一下有没有新版本。对应 yt-dlp 的 query_update()。
//
// 返回 { ok, hasUpdate, info, reason }：
//   hasUpdate —— true 表示本地版本落后于远端
//   reason    —— ok 为 false 时的中文原因，直接给 UI 用
async function checkForUpdate(db) {
  if (state.checking) {
    return { ok: false, hasUpdate: false, reason: '正在检查更新，请稍候' };
  }
  if (!isSupported()) {
    return { ok: false, hasUpdate: false, reason: '当前环境不支持自动更新（开发模式下请从 GitHub Releases 手动下载）' };
  }
  state.checking = true;
  state.error = null;
  emit();

  try {
    const release = await fetchLatestRelease();
    const variant = detectVariant();
    const asset = pickAsset(release.assets, variant);

    if (!release.tag) {
      state.error = 'release 信息缺少版本号';
      return { ok: false, hasUpdate: false, reason: 'release 信息缺少版本号' };
    }

    const currentVersion = app.getVersion();
    // tag 形如 "v1.2.3"，去掉前缀再比较；没前缀就用原值。
    const latestVersion = String(release.tag).replace(/^v/i, '');
    const upToDate = isAtLeastVersion(currentVersion, latestVersion);

    state.info = {
      version: latestVersion,
      tag: release.tag,
      name: release.name || '',
      notes: release.body || '',
      publishedAt: release.publishedAt,
      assetName: asset ? asset.name : null,
      assetUrl: asset ? asset.browser_download_url : null,
      assetSize: asset ? asset.size : null,
      currentVersion,
      // 「有更新」和「有可下载的资产」是两件事。发布者可能只发了 release
      // 说明而没上传对应平台的包——这时告诉用户「有新版本」然后下载失败
      // 比直接说清楚更糟。
      downloadable: !!asset,
      hasUpdate: !upToDate,
    };

    if (db) {
      db.setSetting(SETTING_LAST_CHECK, String(Date.now()));
      db.setSetting(SETTING_LAST_INFO, JSON.stringify(state.info));
    }
    return { ok: true, hasUpdate: !upToDate, info: state.info, reason: null };
  } catch (err) {
    // 记录检查时间，哪怕这次检查失败了。不记录的话，失败的联网请求会在
    // 每次启动时重试一遍。
    if (db) db.setSetting(SETTING_LAST_CHECK, String(Date.now()));
    const reason = describeCheckError(err);
    state.error = reason;
    console.error('[app_update] check failed:', err);
    return { ok: false, hasUpdate: false, reason };
  } finally {
    state.checking = false;
    emit();
  }
}

// 把底层错误翻译成用户能看懂的话。区分「没网」「GitHub 限流」「仓库还没
// 发过 Release」很重要——用户该采取的动作完全不同。
function describeCheckError(err) {
  if (err && err.notFound) {
    return 'GitHub 仓库还没有发布任何 Release，暂时无法检查更新';
  }
  const code = err && (err.code || err.statusCode);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '网络连接失败，请检查网络后重试';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return '网络连接被中断，请稍后重试';
  if (code === 'ETIMEDOUT' || /超时/.test((err && err.message) || '')) return '请求超时，请稍后重试';
  if (code === 403 || code === 429) return 'GitHub 请求过于频繁，请稍后再试';
  if (code === 401) return 'GitHub 拒绝了本次请求';
  return '检查更新失败：' + ((err && err.message) || '未知错误');
}

// 下载并校验安装包。对应 yt-dlp 的 update()。
//
// 只落盘、不启动安装——启动那一步交给 installAndRelaunch()，因为它需要
// 先把渲染进程的状态展示完。
async function downloadUpdate(db, onProgress) {
  if (state.downloading) {
    return { ok: false, reason: '更新正在下载中' };
  }
  if (!state.info || !state.info.hasUpdate) {
    return { ok: false, reason: '当前已是最新版本' };
  }
  if (!state.info.assetName) {
    return { ok: false, reason: '该版本没有提供适用于当前系统的安装包' };
  }

  state.downloading = true;
  state.error = null;
  emit();

  const dest = path.join(tempDir(), state.info.assetName);
  try {
    // 先取校验和。顺序和 yt-dlp 一致：校验和拿不到就到此为止，绝不下载。
    const expected = await fetchExpectedChecksum(state.info.assetName, state.info.tag);
    if (!expected) {
      const reason = '该版本没有提供校验和文件，为安全起见不安装。请从 GitHub Releases 手动下载。';
      state.error = reason;
      return { ok: false, reason };
    }

    if (onProgress) onProgress({ phase: 'downloading', percent: 0, received: 0, total: 0 });
    const result = await downloadAsset(state.info.assetName, state.info.tag, dest, (p) => {
      if (onProgress) onProgress({ phase: 'downloading', ...p });
    });

    // 校验在落盘时已经算完了，这里只比字符串。失败就删文件——不能让一个
    // 校验不过的 exe 留在磁盘上等着被误点。
    if (result.sha256.toLowerCase() !== expected) {
      try { fs.unlinkSync(dest); } catch (_) { /* 忽略 */ }
      const reason = '安装包校验失败，文件可能已损坏。已放弃本次更新，请稍后重试。';
      state.error = reason;
      return { ok: false, reason };
    }

    // downloading 的复位与 emit 交给下面的 finally 统一做——成功和失败
    // 两条路径都需要，少写一处就可能让「下载中」这个状态卡住，界面上的
    // 按钮再也点不动。
    return {
      ok: true,
      path: dest,
      version: state.info.version,
      bytes: result.bytes,
      reason: null,
    };
  } catch (err) {
    state.error = describeCheckError(err);
    console.error('[app_update] download failed:', err);
    return { ok: false, reason: state.error };
  } finally {
    state.downloading = false;
    emit();
  }
}

// 启动安装器，然后退出本应用。
//
// 顺序不能反，这是整个更新流程里最容易出错的地方：
//
//   1. NSIS 安装包会去找 SoulDesktopPet.exe 进程，找到就弹窗让用户关闭、
//      找不到就直接装。如果本进程还活着，它会 taskkill /f 强杀——那会
//      跳过 main.js 的 before-quit，来不及执行 db.save()。
//   2. 所以这里必须先让主进程走完正常的退出流程（quit() → before-quit →
//      db.save()），等它真的结束，再启动安装器。
//   3. 安装器装完并不会自动重启应用，所以最后由安装器负责拉起新版本。
//
// 用户数据不在安装目录里（%APPDATA%/SoulDesktopPet/），加上
// deleteAppDataOnUninstall=false，升级过程不会碰联系人、提醒和照片。
function installAndRelaunch(installerPath) {
  if (state.installing) return { ok: false, reason: '安装程序已经启动过了' };
  if (!app.isPackaged) {
    return { ok: false, reason: '开发模式下无法启动安装程序' };
  }
  if (!fs.existsSync(installerPath)) {
    return { ok: false, reason: '安装包不存在，请重新下载' };
  }

  // 告诉渲染进程「要重启了」，让它把状态落到界面上再退出——否则用户看到
  // 的是应用突然消失，不知道发生了什么。
  emit();

  const exe = process.execPath;
  // detached + unref：安装器不能是本进程的子进程，否则它会等我们退出、
  // 我们又等它结束，互相等待。
  let child;
  try {
    child = spawn(installerPath, ['/S', `--updated`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
  } catch (e) {
    return { ok: false, reason: '无法启动安装程序：' + e.message };
  }

  state.installing = true;
  emit();

  // 等主进程彻底退出（db.save() 跑完、文件句柄释放）之后再拉起新版本。
  // app.quit() 之后的 'quit' 事件意味着 Electron 已经收尾完毕，此时
  // 启动新实例不会再撞上文件占用。
  const spawnRelaunch = () => {
    try {
      spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } catch (e) {
      console.error('[app_update] relaunch failed:', e);
    }
  };

  app.once('quit', () => {
    // 给安装器一点时间真正开始写文件再拉起新实例，否则新版本可能在
    // 旧文件还没替换完时就去加载了。
    setTimeout(spawnRelaunch, 3000);
  });

  // 走正常退出流程（触发 before-quit → db.save()）。
  app.quit();
  return { ok: true, reason: null };
}

// 在系统文件管理器里打开安装包所在目录。对应 preload 里已有的
// tools.revealInFolder，用户想自己点安装时用。
function revealInstaller(installerPath) {
  try {
    if (!fs.existsSync(installerPath)) return false;
    shell.showItemInFolder(installerPath);
    return true;
  } catch (e) {
    console.error('[app_update] reveal failed:', e);
    return false;
  }
}

// ---- 每日自动检查 ----

let dailyTimer = null;
let firstCheckTimer = null;

// 启动时调用（main.js whenReady 里）。
//
// 语义和 autostart.syncOnLaunch 一致，但默认反过来：autostart 首次启动
// 默认「开」，这里默认也「开」——更新检查只在后台静默查一次，不弹窗、
// 不打扰桌宠，所以默认开启的代价很低，收益是不用提醒用户去开。
//
// lastCheck 决定要不要真的查：距上次检查不足 24 小时就跳过。检查失败
// 也会写 lastCheck（见 checkForUpdate），所以断网时不会每次启动都重试。
function startDailyCheck(db, runCheck) {
  stopDailyCheck();
  scheduleCheck(db, runCheck, FIRST_CHECK_DELAY_MS);

  dailyTimer = setInterval(() => {
    scheduleCheck(db, runCheck, 0);
  }, CHECK_INTERVAL_MS);
  if (dailyTimer.unref) dailyTimer.unref();
}

function scheduleCheck(db, runCheck, delayMs) {
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = null;
  }
  firstCheckTimer = setTimeout(() => {
    firstCheckTimer = null;
    try {
      // 用户关掉了自动检查就直接跳过，不联网。
      if (db.getSetting(SETTING_ENABLED) === '0') return;
      const last = parseInt(db.getSetting(SETTING_LAST_CHECK) || '0', 10) || 0;
      if (last && Date.now() - last < CHECK_INTERVAL_MS) return;
      runCheck();
    } catch (e) {
      console.error('[app_update] daily check failed:', e);
    }
  }, delayMs);
  if (firstCheckTimer.unref) firstCheckTimer.unref();
}

function stopDailyCheck() {
  if (dailyTimer) {
    clearInterval(dailyTimer);
    dailyTimer = null;
  }
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = null;
  }
}

// 用户在设置里切换「自动检查更新」时的回调。由 main.js 注册，收到
// enabled=true 时重启每日调度器（timer 的生命周期只在这里管一处）。
let enableToggledHook = null;
function onEnableToggled(fn) { enableToggledHook = fn; }

// 用户在设置里切换「自动检查更新」。打开时立刻补一次检查，不用等下一个
// 24 小时周期。
function setEnabled(db, enabled) {
  db.setSetting(SETTING_ENABLED, enabled ? '1' : '0');
  if (!enabled) {
    stopDailyCheck();
    return { ok: true, enabled: false };
  }
  if (enableToggledHook) enableToggledHook(true);
  return { ok: true, enabled: true };
}

module.exports = {
  REPO,
  SETTING_ENABLED,
  SETTING_LAST_CHECK,
  SETTING_LAST_INFO,
  CHECK_INTERVAL_MS,
  detectVariant,
  isSupported,
  isAtLeastVersion,
  versionTuple,
  publicState,
  onStatus,
  emit,
  checkForUpdate,
  downloadUpdate,
  installAndRelaunch,
  revealInstaller,
  startDailyCheck,
  stopDailyCheck,
  setEnabled,
  onEnableToggled,
};