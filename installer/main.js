const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

// payload.zip 内含主程序全部文件（win-unpacked 内容）
function payloadPath() {
  const candidates = [
    path.join(process.resourcesPath, 'payload', 'payload.zip'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'payload', 'payload.zip'),
    path.join(app.getAppPath(), 'payload', 'payload.zip'),
    path.join(__dirname, 'payload', 'payload.zip'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size > 0);
}

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

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 480,
    resizable: false,
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
  const send = (percent, text) => win.webContents.send('install-progress', { percent, text });
  try {
    const zipFile = payloadPath();
    if (!zipFile) throw new Error('安装包数据缺失（payload.zip 未找到）');

    send(2, '准备安装目录...');
    fs.mkdirSync(targetDir, { recursive: true });

    if (fs.existsSync(path.join(targetDir, EXE_NAME))) {
      send(5, '正在关闭已运行的客户端...');
      await Promise.all([
        taskkill(EXE_NAME),
        taskkill('easytier-core.exe'),
      ]);
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
        fs.writeFileSync(outPath, entry.getData());
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
    try {
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
    if (fs.existsSync(uninstallerPath)) {
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

ipcMain.handle('launch', (evt, exePath) => {
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) });
    child.unref();
    setTimeout(() => app.quit(), 600);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('quit', () => app.quit());
