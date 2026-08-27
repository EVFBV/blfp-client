const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const net = require('net');
const os = require('os');
const { scanJavaPorts } = require('./src/port-scanner');
const FrpcManager = require('./src/frpc-manager');
const MotdBroadcaster = require('./src/motd-broadcast');
const EasyTierManager = require('./src/easytier-manager');

app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const GITHUB_RELEASE_API = 'https://api.github.com/repos/EVFBV/BLFP-client/releases/latest';
let mainWindow;
let frpcMgr = new FrpcManager();
let motdBroadcaster = new MotdBroadcaster();
let easyTierMgr = new EasyTierManager(app);

// 获取本机局域网 IPv4 地址（供复制连接IP用）
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name]) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    title: 'BLFP 联机助手',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#050505', symbolColor: '#ffffff', height: 36 },
    show: false,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details.reason);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('Renderer failed to load:', {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level === 3) {
      console.error('Renderer console error:', { message, line, sourceId });
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
let quitting = false;

// 退出前先释放代理端口并停止 EasyTier 子进程
async function stopServices() {
  frpcMgr.stop();
  motdBroadcaster.stop();
  await easyTierMgr.stop();
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopServices().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());

// ====== IPC: 应用信息与安全外链 ======
ipcMain.handle('get-app-info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
}));
ipcMain.handle('open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false, error: '仅允许打开 HTTPS 链接' };
  await shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('check-github-update', async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(GITHUB_RELEASE_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `BLFP-Client/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 404) throw new Error('仓库尚未发布 Release');
    if (response.status === 403 || response.status === 429) throw new Error('GitHub API 请求受限，请稍后再试');
    if (!response.ok) throw new Error(`GitHub 更新检查失败 (${response.status})`);
    const release = await response.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const candidates = assets.filter((asset) => {
      const name = String(asset.name || '');
      return /\.exe$/i.test(name) && !/(blockmap|\.ya?ml$|sha256|\.sig$)/i.test(name)
        && /^https:\/\//i.test(asset.browser_download_url || '');
    });
    candidates.sort((a, b) => {
      const score = (asset) => /blfp/i.test(asset.name) * 4 + /setup/i.test(asset.name) * 2 + /installer/i.test(asset.name);
      return score(b) - score(a);
    });
    return {
      latestVersion: String(release.tag_name || '').replace(/^v/i, ''),
      releaseName: release.name || release.tag_name || '',
      releaseNotes: release.body || '',
      releaseUrl: /^https:\/\//i.test(release.html_url || '') ? release.html_url : null,
      publishedAt: release.published_at || null,
      downloadUrl: candidates[0]?.browser_download_url || null,
      assetName: candidates[0]?.name || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接 GitHub 超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
});

// ====== IPC: 本机局域网 IP ======
ipcMain.handle('get-lan-ip', async () => getLanIp());

// ====== IPC: 窗口三按钮跟随主题（任务1）======
// titleBarOverlay 颜色只能在主进程实时改，渲染进程切换主题时通过这里同步
ipcMain.handle('set-titlebar-overlay', async (_e, theme) => {
  if (!mainWindow) return { ok: false };
  const light = theme === 'light';
  try {
    mainWindow.setTitleBarOverlay({
      color: light ? '#f3f4f6' : '#000000',
      symbolColor: light ? '#17181c' : '#ffffff',
      height: 36,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ====== IPC: 退出软件（功能5）======
ipcMain.handle('exit-app', async () => {
  await stopServices();
  quitting = true;
  app.quit();
  return { ok: true };
});

// ====== IPC: TCP 测延迟（frp 节点 ping，功能9）======
ipcMain.handle('ping-node', async (_e, { host, port }) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok ? { ok: true, latency: Date.now() - start } : { ok: false });
    };
    socket.setTimeout(3000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port || 7000, host); } catch { finish(false); }
  });
});

// ====== IPC: 局域网 MOTD 广播（功能5）======
// 向局域网组播 BLFP+房间号+房主ID，让 MC「多人游戏」自动发现
ipcMain.handle('motd-start', async (_e, { port, roomCode, hostName }) => {
  try {
    const motd = `BLFP §a房间 ${roomCode} §7| 房主 ${hostName}`;
    motdBroadcaster.start(motd, port);
    return { ok: true, motd };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('motd-stop', async () => {
  motdBroadcaster.stop();
  return { ok: true };
});

// ====== IPC: 端口扫描 ======
ipcMain.handle('scan-ports', async () => {
  return scanJavaPorts();
});

// 检测 25565 是否被占用
ipcMain.handle('check-port', async (_e, port) => {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));   // 端口被占用
    s.once('listening', () => { s.close(); resolve(false); });
    s.listen(port);
  });
});

// ====== IPC: frpc 管理 ======
ipcMain.handle('frpc-start', async (_e, cfg) => {
  try {
    const result = await frpcMgr.start(cfg);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('frpc-stop', async () => {
  frpcMgr.stop();
  return { ok: true };
});

ipcMain.on('frpc-log', (_e, line) => {
  mainWindow?.webContents.send('frpc-log', line);
});

frpcMgr.on('log', (line) => mainWindow?.webContents.send('frpc-log', line));
frpcMgr.on('port', (payload) => mainWindow?.webContents.send('frpc-port', payload));
frpcMgr.on('error', (err) => mainWindow?.webContents.send('frpc-error', err));

// ====== IPC: EasyTier 主进程与房主 TCP 代理 ======
ipcMain.handle('easytier-start', async (_e, config) => {
  try {
    const status = await easyTierMgr.start(config);
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: error.message, status: easyTierMgr.getStatus() };
  }
});

ipcMain.handle('easytier-stop', async () => {
  try {
    return { ok: true, status: await easyTierMgr.stop() };
  } catch (error) {
    return { ok: false, error: error.message, status: easyTierMgr.getStatus() };
  }
});

ipcMain.handle('easytier-status', async () => easyTierMgr.getStatus());
ipcMain.handle('easytier-test', async (_e, config) => {
  const hostVirtualIp = typeof config === 'string' ? config : config?.hostVirtualIp;
  return easyTierMgr.testConnectivity(hostVirtualIp, 25565, 1000);
});

easyTierMgr.on('log', (line) => mainWindow?.webContents.send('easytier-log', line));
easyTierMgr.on('status', (status) => mainWindow?.webContents.send('easytier-status', status));
easyTierMgr.on('manager-error', (error) => mainWindow?.webContents.send('easytier-error', error));
