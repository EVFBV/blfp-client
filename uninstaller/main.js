const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 330,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: '卸载 BLFP',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('uninstall', async () => {
  try {
    const installDir = path.dirname(process.execPath);
    const desktopLink = path.join(app.getPath('desktop'), 'BLFP.lnk');
    const startLink = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'BLFP.lnk');

    for (const link of [desktopLink, startLink]) {
      try { if (fs.existsSync(link)) fs.unlinkSync(link); } catch {}
    }

    // 卸载器不能删除正在运行的自身，由独立 PowerShell 进程等待退出后清理目录。
    const escaped = installDir.replace(/'/g, "''");
    const script = `Start-Sleep -Seconds 2; Remove-Item -LiteralPath '${escaped}' -Recurse -Force -ErrorAction SilentlyContinue`;
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();

    setTimeout(() => app.quit(), 500);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-dir', () => shell.openPath(path.dirname(process.execPath)));
ipcMain.handle('quit', () => app.quit());
