/* 全局异常兜底：避免任何未捕获异常弹出 "A JavaScript error occurred in the main process" 对话框 */
process.on('uncaughtException', (err) => {
  console.error('[安装器] 未捕获异常（已拦截）:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[安装器] 未处理的 Promise 拒绝（已拦截）:', reason && reason.message ? reason.message : reason);
});

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

// payload.zip 内含主程序全部文件（win-unpacked 内容）
let lastPayloadDiagnostic = '';
function payloadPath() {
  const path = require('path');
  const fsx = require('fs');
  const candidates = [
    path.join(process.resourcesPath || '', 'payload', 'payload.zip'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'payload', 'payload.zip'),
    path.join(app.getAppPath(), 'payload', 'payload.zip'),
    path.join(__dirname, 'payload', 'payload.zip'),
    path.join(__dirname, '..', 'payload', 'payload.zip'),
    path.join(process.resourcesPath || '', 'app', 'payload', 'payload.zip'),
  ];
  const hit = candidates.find((c) => { try { return fsx.existsSync(c) && fsx.statSync(c).size > 0; } catch (e) { return false; } });
  if (hit) { lastPayloadDiagnostic = '命中候选路径: ' + hit; return hit; }

  /* 兜底：在 resources 与程序目录下递归查找 payload.zip（2 层深度内） */
  const roots = [process.resourcesPath, app.getAppPath(), __dirname].filter(Boolean);
  for (const root of roots) {
    try {
      const found = findFileDeep(root, 'payload.zip', 3);
      if (found) { lastPayloadDiagnostic = '递归搜索命中: ' + found; return found; }
    } catch (e) {}
  }

  /* 全部失败：记录实际目录结构，便于定位 */
  const describe = (p) => {
    try { return p + ' → ' + (fsx.existsSync(p) ? fsx.readdirSync(p).slice(0, 30).join(', ') : '(不存在)'); }
    catch (e) { return p + ' → (读取失败)'; }
  };
  lastPayloadDiagnostic = [
    '未找到 payload.zip。候选路径检查结果：',
    ...candidates.map((c) => '  ' + c + (fsx.existsSync(c) ? ' [存在但为空]' : ' [不存在]')),
    '目录结构：',
    '  ' + describe(process.resourcesPath || ''),
    '  ' + describe(path.join(process.resourcesPath || '', 'payload')),
    '  ' + describe(__dirname),
    '  ' + describe(app.getAppPath()),
  ].join('\n');
  return undefined;
}

function findFileDeep(root, fileName, depth) {
  const path = require('path');
  const fsx = require('fs');
  if (depth < 0) return null;
  let entries = [];
  try { entries = fsx.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      try { if (fsx.statSync(full).size > 0) return full; } catch (e) {}
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'locales') continue;
    const found = findFileDeep(path.join(root, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return null;
}

/* 用户守则验证码：每次运行安装程序随机生成（6 位数字），仅主进程持有，
   渲染进程只能取到用于显示的值，校验在主进程完成，无法通过改页面绕过 */
const verificationCode = String(crypto.randomInt(100000, 1000000));

const APP_NAME = 'BLFP';
const EXE_NAME = 'BLFP.exe';

function defaultInstallDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Programs', APP_NAME);
}

function entryOutputPath(targetDir, entryName) {
  const segments = entryName.split(/[\\/]+/);
  if (path.isAbsolute(entryName) || path.win32.isAbsolute(entryName) || path.posix.isAbsolute(entryName) || segments.includes('..')) {
    throw new Error(`安装包包含不安全路径：${entryName}`);
  }

  const root = path.resolve(targetDir);
  const output = path.resolve(root, entryName);
  if (output !== root && !output.startsWith(root + path.sep)) {
    throw new Error(`安装包路径超出安装目录：${entryName}`);
  }
  return output;
}

function taskkill(imageName) {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/F', '/IM', imageName], { windowsHide: true, stdio: 'ignore' });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

/* 客户端以管理员权限运行，普通权限的安装器杀不掉它 —— 提权并弹出 cmd 窗口执行 taskkill */
function taskkillElevated() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    const cmd = 'taskkill /F /IM ' + EXE_NAME + ' & taskkill /F /IM easytier-core.exe & taskkill /F /IM frpc.exe';
    try {
      /* -Wait 不能省：没有它 powershell 一发出请求就退出，child.on('close')
         在 UAC 弹窗还没点「是」时就触发，安装器会在客户端仍被占用时继续解压，必然 EBUSY */
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        "Start-Process cmd.exe -ArgumentList '/c " + cmd + " & timeout /t 1 >nul' -Verb RunAs -Wait",
      ], { windowsHide: false, stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    } catch (e) { resolve(); }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Windows 上被占用的文件抛 EBUSY / EPERM / EACCES；进程刚退出时句柄释放还有延迟 */
function isBusyError(err) {
  const code = err && err.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

/* 能否独占打开目标文件（文件不存在也算已解锁） */
function isUnlocked(filePath) {
  try { const fd = fs.openSync(filePath, 'r+'); fs.closeSync(fd); return true; }
  catch (e) { return !isBusyError(e); }
}

function taskkillAll() {
  return Promise.all([taskkill(EXE_NAME), taskkill('easytier-core.exe'), taskkill('frpc.exe')]);
}

/* 等待主程序文件解锁；期间周期性重发 taskkill —— 提权窗口可能还在等用户点「是」 */
async function waitForUnlock(exePath, timeoutMs = 120000, onTick) {
  const start = Date.now();
  let lastKill = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isUnlocked(exePath)) return true;
    if (Date.now() - lastKill > 8000) { lastKill = Date.now(); await taskkillAll(); }
    if (onTick) onTick(Math.round((Date.now() - start) / 1000));
    await sleep(500);
  }
  return false;
}

/* 解压写入带重试：文件被占用时等待后重写，必要时再杀一次客户端。
   旧实现是一次性 writeFileSync —— 只要此刻 BLFP.exe 还被占用就整次安装失败，
   用户必须手动重试第二次才能装上（EBUSY: resource busy or locked）。 */
async function writeFileWithRetry(outPath, data, onRetry) {
  const deadline = Date.now() + 60000;
  let attempt = 0;
  let lastErr;
  for (;;) {
    try { fs.writeFileSync(outPath, data); return; }
    catch (e) {
      lastErr = e;
      if (!isBusyError(e)) throw e;
      attempt++;
      if (Date.now() >= deadline) break;
      if (attempt % 4 === 0) await taskkillAll();
      if (onRetry) onRetry(attempt);
      await sleep(Math.min(300 * attempt, 2000));
    }
  }
  throw new Error(
    '文件被占用，无法写入：' + outPath + '\n' +
    '请手动退出 BLFP 客户端（含托盘图标）后重试安装。\n（' + (lastErr && lastErr.code) + '）'
  );
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 700,
    minHeight: 560,
    resizable: true,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'BLFP 安装程序',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
ipcMain.handle('get-default-dir', () => defaultInstallDir());

/* 供界面显示（"用户守则末尾验证码"） */
ipcMain.handle('get-verify-code', () => verificationCode);

/* 校验用户输入的验证码 */
ipcMain.handle('verify-code', (evt, input) => {
  const value = String(input == null ? '' : input).trim();
  return { ok: value === verificationCode };
});

/* 安装前自检：让"加载中"页面显示真实检查结果 */
ipcMain.handle('self-check', async () => {
  const zipFile = payloadPath();
  let sizeMB = 0;
  try { if (zipFile) sizeMB = Math.round(fs.statSync(zipFile).size / 1048576); } catch (e) {}
  const targetDir = defaultInstallDir();
  let writable = false;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const probe = path.join(targetDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch (e) { writable = false; }
  return {
    payloadOk: !!zipFile && sizeMB >= 50,
    diagnostic: lastPayloadDiagnostic,
    payloadSizeMB: sizeMB,
    targetDir,
    writable,
    defaultDir: targetDir,
  };
});

ipcMain.handle('choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择安装目录',
  });
  if (r.canceled || !r.filePaths.length) return null;
  return path.join(r.filePaths[0], APP_NAME);
});

ipcMain.handle('install', async (evt, opts) => {
  const targetDir = typeof opts === 'string' ? opts : opts.dir;
  const desktopShortcut = typeof opts === 'string' ? true : opts.desktopShortcut !== false;
  const startMenuShortcut = typeof opts === 'string' ? true : opts.startMenuShortcut !== false;
  const send = (percent, text) => win.webContents.send('install-progress', { percent, text });
  try {
    const zipFile = payloadPath();
    if (!zipFile) throw new Error('安装包数据缺失（payload.zip 未找到）\n' + lastPayloadDiagnostic);

    send(2, '准备安装目录...');
    fs.mkdirSync(targetDir, { recursive: true });

    /* 目录可写性检查（免管理员安装：目录必须在用户可写范围内） */
    try {
      const probe = path.join(targetDir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } catch (e) {
      throw new Error('安装目录不可写：' + targetDir + '\n请改用默认目录（%LOCALAPPDATA%\\Programs\\BLFP），或选择你有权限的目录。');
    }

    const exeTarget = path.join(targetDir, EXE_NAME);
    if (fs.existsSync(exeTarget) && !isUnlocked(exeTarget)) {
      /* 先按普通权限关闭（普通权限运行的客户端可以直接杀掉） */
      send(5, '正在关闭已运行的客户端…');
      await taskkillAll();

      /* 普通权限的 taskkill 杀不掉管理员权限运行的客户端；先给它几秒自然退出，
         免得为了一个马上就会退出的进程白弹一次 UAC */
      let unlocked = await waitForUnlock(exeTarget, 5000);

      if (!unlocked) {
        /* 客户端以管理员权限运行 → 提权并弹出 cmd 窗口执行 taskkill */
        send(6, '客户端以管理员权限运行，需要提权关闭，请在弹窗点「是」…');
        await taskkillElevated();
        unlocked = await waitForUnlock(exeTarget, 120000, (sec) => {
          send(6, `正在等待客户端退出（已等待 ${sec} 秒）…`);
        });
        if (unlocked) send(7, '已关闭客户端，继续安装…');
        /* 仍未解锁也不再直接判失败：交给下面解压时的逐文件重试兜底 */
        else send(7, '客户端似乎仍在运行，继续尝试覆盖安装…');
      }
    }

    // 关闭 Electron 的 asar 拦截：主程序内含 resources/app.asar，
    // 若不关闭，写入该文件时 Electron 会把它当 asar 归档拒绝写入，导致解压失败
    process.noAsar = true;

    send(8, '正在读取安装包...');
    const zip = new AdmZip(zipFile);
    const entries = zip.getEntries();
    const outputPaths = entries.map((entry) => entryOutputPath(targetDir, entry.entryName));
    const total = entries.length || 1;

    // 逐条解压，反馈进度
    let done = 0;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const outPath = outputPaths[index];
      if (entry.isDirectory) {
        fs.mkdirSync(outPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await writeFileWithRetry(outPath, entry.getData(), (attempt) => {
          const pct = 10 + Math.floor(((done + 1) / total) * 80);
          send(pct, `正在解压文件 ${done + 1}/${total}（${path.basename(outPath)} 被占用，第 ${attempt} 次重试）...`);
        });
      }
      done++;
      const percent = 10 + Math.floor((done / total) * 80);
      if (done % 5 === 0 || done === total) {
        send(percent, `正在解压文件 ${done}/${total}...`);
      }
    }

    send(92, '正在创建快捷方式...');
    const exePath = path.join(targetDir, EXE_NAME);
    if (!fs.existsSync(exePath)) throw new Error('解压后未找到主程序 ' + EXE_NAME);

    // 桌面快捷方式
    if (desktopShortcut) {
      try {
        const desktop = app.getPath('desktop');
        shell.writeShortcutLink(path.join(desktop, APP_NAME + '.lnk'), 'create', {
          target: exePath,
          cwd: targetDir,
          description: 'BLFP 我的世界联机客户端',
        });
      } catch (e) { /* 桌面快捷方式失败不阻断安装 */ }
    }

    // 开始菜单快捷方式
    if (startMenuShortcut) try {
      const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      fs.mkdirSync(startMenu, { recursive: true });
      shell.writeShortcutLink(path.join(startMenu, APP_NAME + '.lnk'), 'create', {
        target: exePath,
        cwd: targetDir,
        description: 'BLFP 我的世界联机客户端',
      });
    } catch (e) { /* 开始菜单快捷方式失败不阻断安装 */ }

    // 写入卸载信息（简单记录安装目录）
    try {
      const metadata = { installDir: targetDir, installedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(targetDir, 'install-info.json'), JSON.stringify(metadata, null, 2), 'utf8');
    } catch (e) {}

    const uninstallerPath = path.join(targetDir, '卸载 BLFP.exe');
    if (startMenuShortcut && fs.existsSync(uninstallerPath)) {
      try {
        const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        shell.writeShortcutLink(path.join(startMenu, '卸载 BLFP.lnk'), 'create', {
          target: uninstallerPath,
          cwd: targetDir,
          description: '卸载 BLFP',
        });
      } catch (e) {}
    }

    send(100, '安装完成');
    return { ok: true, exePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch', async (evt, exePath) => {
  const fsx = require('fs');
  const childProcess = require('child_process');
  try {
    if (!exePath || !fsx.existsSync(exePath)) return { ok: false, error: '未找到主程序：' + exePath };

    /* 立刻启动，不等、不校验（UAC 已关闭时提权是静默的）：
       BLFP.exe 带 requireAdministrator 清单，普通权限的安装器不能直接 spawn 它（EACCES），
       所以走 ShellExecute 语义。Start-Process -Verb RunAs 在 UAC 关闭时立刻生效，
       UAC 开启时也会正常弹窗，两种情况都能起来。 */
    try {
      childProcess.spawn('powershell.exe', [
        '-NoProfile',
        '-WindowStyle', 'Hidden',
        '-Command',
        'Start-Process -FilePath "' + exePath.replace(/"/g, '""') + '" -Verb RunAs',
      ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) {
      console.error('[Installer] Start-Process 启动失败:', e.message);
      /* 仅在提权启动"同步失败"时才走兜底，避免安装器退出后兜底来不及执行 */
      try {
        const { shell } = require('electron');
        await shell.openPath(exePath);
      } catch (e2) { console.error('[Installer] 兜底启动也失败:', e2.message); }
    }

    /* 不等客户端起来，安装器立即退出 */
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '未知错误' };
  }
});

ipcMain.handle('quit', () => app.quit());
