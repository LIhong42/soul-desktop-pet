// main/autostart.js — 开机自启动（Windows 注册表 Run 项）
//
// 单独成模块的原因：这个功能牵涉三个容易踩坑的点，不适合塞进 main.js。
//
//   1. process.execPath 在开发模式下指向的是 electron.exe（node_modules 里的
//      Electron 本体），不是本项目。直接拿它注册开机启动，等于把整个开发环境
//      的 electron.exe 塞进开机项——既启动的是错的程序，又会污染注册表。
//      所以必须按 app.isPackaged 区分路径来源。
//   2. 注册表读写需要 try/catch 包裹。权限被拒、组策略禁用、注册表服务异常
//      都会抛异常，而主进程正是在 whenReady 期间调用这里的，抛出去会导致
//      整个应用启动失败——为了一个次要功能拖垮主程序不划算。
//   3. 应用被卸载/移动后，Run 项里的路径会失效。setLoginItemSettings 在
//      重新设置时会覆盖旧记录，所以每次写入都用它做覆盖，而不是追加。

const { app } = require('electron');

// 用户可读的名字。出现在「任务管理器 → 启动」和注册表编辑器里。
const RUN_ENTRY_NAME = 'SoulDesktopPet';

// 该 Run 项在 db.settings 里的 key。存的是用户最后一次的意图，
// 而不是「当前系统上是否真的注册成功了」——后者随时可能被用户或
// 安全软件手动改掉，两者是不同的状态。
const SETTING_KEY = 'app_auto_start';

// 目标启动项的 EXE 路径。打包后指向安装目录里的 SoulDesktopPet.exe。
//
// 开发模式返回 null：Electron 本体不应该被注册成开机启动，见上方说明 1。
function targetPath() {
  if (!app.isPackaged) return null;
  return process.execPath;
}

// 自启动在当前平台/当前构建形态下是否可用。
function isSupported() {
  if (process.platform !== 'win32') return false;
  if (!app.isPackaged) return false;
  return !!targetPath();
}

// 读注册表，确认 Run 项当前是否指向我们期望的 exe。
//
// 注意 getLoginItemSettings() 返回的 openAtLogin 只说明「项存在」，
// 不保证它指向的是当前这个 exe（比如用户重装到了别的目录）。这里额外
// 比对 path，路径不一致就当作「未注册」处理，这样 ensureAutostart()
// 能把过期记录覆盖掉。
function isEnabled() {
  if (!isSupported()) return false;
  try {
    const state = app.getLoginItemSettings({ path: targetPath() });
    if (!state || !state.openAtLogin) return false;
    if (state.path && state.path !== targetPath()) return false;
    return true;
  } catch (e) {
    console.error('[autostart] read failed:', e);
    return false;
  }
}

// 写入（或移除）开机自启动项。
//
// 返回 { ok, supported, enabled }：
//   ok        —— 操作是否成功。不支持或抛异常时为 false，调用方据此
//                保留 db 里的用户意图，不把它覆盖成失败值。
//   supported  —— 当前环境能否做这件事（开发模式下为 false）。
//   enabled   —— 期望的最终状态，仅在 ok 为 true 时代表实际生效状态。
function setEnabled(enabled) {
  const want = !!enabled;
  if (!isSupported()) {
    return { ok: false, supported: false, enabled: false };
  }
  try {
    app.setLoginItemSettings({
      path: targetPath(),
      // 注册表 Run 项的名字。开发模式不会走到这里，但保持一致。
      name: RUN_ENTRY_NAME,
      openAtLogin: want,
    });
    return { ok: true, supported: true, enabled: want };
  } catch (e) {
    console.error('[autostart] write failed:', e);
    return { ok: false, supported: true, enabled: isEnabled() };
  }
}

// 应用启动时调用：把系统实际状态对齐到 db 里记录的用户意图。
//
// 只在「用户没表态过」（首次启动，key 为 null）时才默认打开。这样老用户
// 升级到带这个功能的版本时，不会因为默认值而被静默塞进开机项——他们
// 应该在设置页里自己勾选。新装用户则第一次启动就自动有了。
//
// 如果用户明确关过（存 '0'），这里不动任何东西，也不把开机项加回去。
function syncOnLaunch(db) {
  const stored = db.getSetting(SETTING_KEY);
  if (stored === null || stored === undefined) {
    // 首次启动：默认开启自启动（本项目的既定行为）。
    const r = setEnabled(true);
    // 无论注册是否成功，都记下用户意图是「开」——下次启动还会再试，
    // 等用户或环境的权限问题被解决后自然生效。
    db.setSetting(SETTING_KEY, '1');
    return r;
  }
  const want = stored === '1';
  // 已经和意图一致就不要写注册表，避免每次开机都做一次无谓的写入。
  if (isEnabled() !== want) return setEnabled(want);
  return { ok: true, supported: isSupported(), enabled: want };
}

module.exports = {
  SETTING_KEY,
  RUN_ENTRY_NAME,
  isSupported,
  isEnabled,
  setEnabled,
  syncOnLaunch,
};
