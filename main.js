const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const net = require('net');
const os = require('os');
const { scanJavaPorts } = require('./src/port-scanner');
const FrpcManager = require('./src/frpc-manager');
const MotdBroadcaster = require('./src/motd-broadcast');
const EasyTierManager = require('./src/easytier-manager');

/* 后台/遮挡时不挂起渲染，避免恢复窗口后出现黑屏 */
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
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


/* ====== Windows 防火墙自动放行（虚拟网卡属"公用网络"时会拦截入站，导致访客连不上）====== */
function ensureFirewallRules() {
  if (process.platform !== 'win32') return;
  const { execFile } = require('child_process');
  const path = require('path');
  const ruleName = 'BLFP 联机助手';
  execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + ruleName], (err, stdout) => {
    if (!err && stdout && stdout.includes(ruleName)) return;   /* 已存在 */
    const targets = [
      process.execPath,
      path.join(process.resourcesPath || '', 'bin', 'easytier-core.exe'),
      path.join(process.resourcesPath || '', 'bin', 'frpc.exe'),
    ].filter((p) => { try { return require('fs').existsSync(p); } catch (e) { return false; } });
    if (!targets.length) return;
    let done = 0;
    targets.forEach((exe) => {
      execFile('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=' + ruleName, 'dir=in', 'action=allow', 'program=' + exe, 'enable=yes', 'profile=any'], () => {
        done += 1;
        if (done === targets.length) console.log('[BLFP] 防火墙规则已添加（放行 ' + targets.length + ' 个程序）');
      });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    title: 'BLFP 联机助手',
    frame: false,                 /* 无原生边框，标题栏完全由 HTML 自己画 */
    titleBarStyle: 'hidden',
    /* 不使用系统 titleBarOverlay——否则会和 HTML 自定义标题栏叠成两条 */
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
  /* 后台久了黑屏的自愈：恢复/聚焦/显示时强制重绘并通知渲染进程 */
  let lastHiddenAt = 0;
  function repaintWindow(force) {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) return;
      mainWindow.webContents.invalidate();
      mainWindow.webContents.send('force-repaint');
      /* 长时间后台（>2 分钟）后仅靠 invalidate 有时仍留黑帧，
         做一次肉眼不可见的 1px 尺寸抖动强制重建合成层 */
      const hiddenFor = lastHiddenAt ? Date.now() - lastHiddenAt : 0;
      if (force || hiddenFor > 120000) {
        const [w, h] = mainWindow.getSize();
        mainWindow.setSize(w, h + 1);
        setTimeout(() => {
          try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setSize(w, h); } catch (e) {}
        }, 60);
      }
      lastHiddenAt = 0;
    } catch (e) {}
  }
  mainWindow.once('ready-to-show', () => mainWindow.show());

  /* 后台自动降进程优先级（防止挂在后台时抢占鼠标/UI 响应） */
  const os = require('os');
  function lowerPriority() {
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
  }
  function normalPriority() {
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL); } catch (e) {}
  }
  mainWindow.on('hide', () => { lastHiddenAt = Date.now(); lowerPriority(); });
  mainWindow.on('minimize', () => { lastHiddenAt = Date.now(); lowerPriority(); });
  mainWindow.on('show', () => { normalPriority(); repaintWindow(true); setTimeout(() => repaintWindow(true), 300); });
  mainWindow.on('restore', () => { normalPriority(); repaintWindow(true); setTimeout(() => repaintWindow(true), 300); });
  mainWindow.on('focus', () => { normalPriority(); repaintWindow(); });
  mainWindow.on('blur', () => {
    // 失焦且被遮挡时也降（Electron occlusion 检测）
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) lowerPriority();
  });
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.on('unresponsive', () => {
    console.error('[BLFP] 界面无响应，尝试重绘');
    repaintWindow();
  });
  /* 长时间后台后 GPU 进程可能被回收，重新载入界面即可恢复（登录态在 localStorage，不会丢） */
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

/* 从睡眠/休眠恢复后同样可能黑屏 */
try {
  require('electron').powerMonitor.on('resume', () => {
    try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.invalidate(); mainWindow.webContents.send('force-repaint'); } } catch (e) {}
  });
} catch (e) {}

app.whenReady().then(() => {
  createWindow();
  ensureFirewallRules();
});
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

// ====== IPC: 自定义标题栏窗口控制 ======
ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); return { ok: true }; });
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return { ok: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true, maximized: mainWindow.isMaximized() };
});
ipcMain.handle('window-is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close(); return { ok: true }; });

// ====== IPC: 窗口三按钮跟随主题（任务1）======
// titleBarOverlay 颜色只能在主进程实时改，渲染进程切换主题时通过这里同步
ipcMain.handle('set-titlebar-overlay', async (_e, theme) => {
  if (!mainWindow) return { ok: false };
  const light = theme === 'light';
  try {
    if (typeof mainWindow.setTitleBarOverlay !== 'function') return { ok: false };
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
ipcMain.handle('set-custom-titlebar', async (_e, opts) => {
    // 自定义标题栏：文本 / 图片 / 混合
    if (!mainWindow) return false;
    const data = typeof opts === 'string' ? JSON.parse(opts) : (opts || {});
    mainWindow.webContents.send('titlebar-customized', {
      text: data.text || '',
      image: data.image || '',
      mode: data.mode || 'text'
    });
    return true;
  });
  ipcMain.handle('set-custom-background', async (_e, opts) => {
    if (!mainWindow) return false;
    const data = typeof opts === 'string' ? JSON.parse(opts) : (opts || {});
    mainWindow.webContents.send('background-customized', {
      image: data.image || '',
      color: data.color || '',
      blur: data.blur ?? 0
    });
    return true;
  });
  /* 渲染进程的日志写入文件（此前日志只在界面里，PS 打开的是空文件） */
  const LOG_PATH = require('path').join(process.env.APPDATA || process.env.HOME || '.', 'BLFP', 'logs', 'blfp.log');
  const MAX_LOG_BYTES = 2 * 1024 * 1024;
  function ensureLogDir() {
    const dir = require('path').dirname(LOG_PATH);
    require('fs').mkdirSync(dir, { recursive: true });
    if (!require('fs').existsSync(LOG_PATH)) {
      require('fs').writeFileSync(LOG_PATH, '=== BLFP 运行日志 ===\r\n');
    }
  }
  ipcMain.handle('append-log', async (_e, lines) => {
    try {
      ensureLogDir();
      const text = Array.isArray(lines) ? lines.join('\r\n') : String(lines == null ? '' : lines);
      if (!text) return { ok: true };
      /* 超过 2MB 时轮转，避免无限增长 */
      try {
        if (require('fs').statSync(LOG_PATH).size > MAX_LOG_BYTES) {
          require('fs').writeFileSync(LOG_PATH, '=== BLFP 运行日志（已轮转）===\r\n');
        }
      } catch (e) {}
      require('fs').appendFileSync(LOG_PATH, text + '\r\n');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('open-log-external', async () => {
    try {
      ensureLogDir();
      const path = require('path');
      const childProcess = require('child_process');

      if (process.platform !== 'win32') {
        /* 非 Windows：直接调系统终端 */
        if (process.platform === 'darwin') childProcess.spawn('open', ['-a', 'Terminal', LOG_PATH], { detached: true }).unref();
        else childProcess.spawn('x-terminal-emulator', ['-e', 'tail', '-f', LOG_PATH], { detached: true }).unref();
        return { ok: true, logPath: LOG_PATH };
      }

      /* 关键：把脚本写入 .ps1 文件再用 -File 调用。
         之前用 -Command 传内联脚本（含中文/引号/$/分号）会被参数转义破坏，
         PowerShell 一闪即退，表现为"根本打不开 PS"。 */
      const scriptPath = path.join(path.dirname(LOG_PATH), 'view-log.ps1');
      const script = [
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$host.UI.RawUI.WindowTitle = "BLFP 实时日志"',
        'Write-Host "=== BLFP 实时日志 ===" -ForegroundColor Cyan',
        'Write-Host ("日志文件: ' + LOG_PATH.replace(/\\/g, '\\\\') + '") -ForegroundColor DarkGray',
        'Write-Host "按 Ctrl+C 停止跟随，关闭窗口即可退出。" -ForegroundColor DarkGray',
        'Write-Host ""',
        'Get-Content -LiteralPath "' + LOG_PATH.replace(/\\/g, '\\\\') + '" -Tail 200 -Wait -Encoding UTF8',
      ].join('\r\n');
      require('fs').writeFileSync(scriptPath, '\ufeff' + script, 'utf8');

      const args = ['/c', 'start', '', 'powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
      const child = childProcess.spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => console.error('[BLFP] 启动 PowerShell 失败:', e.message));
      child.unref();
      return { ok: true, logPath: LOG_PATH, scriptPath };
    } catch (e) {
      console.error('[BLFP] 打开日志失败:', e && e.message);
      return { ok: false, error: (e && e.message) || '未知错误', logPath: LOG_PATH };
    }
  });

  /* 读取日志尾部（应用内日志窗口用，不依赖任何外部程序） */
  ipcMain.handle('read-log', async (_e, lines) => {
    try {
      ensureLogDir();
      const max = Math.max(20, Math.min(2000, Number(lines) || 300));
      const content = require('fs').readFileSync(LOG_PATH, 'utf8');
      const all = content.split(/\r?\n/).filter(Boolean);
      return { ok: true, text: all.slice(-max).join('\n'), logPath: LOG_PATH, size: content.length };
    } catch (e) {
      return { ok: false, error: e.message, logPath: LOG_PATH };
    }
  });

  /* 在资源管理器中定位日志文件（PowerShell 被组策略禁用时的兜底） */
  ipcMain.handle('open-log-folder', async () => {
    try {
      ensureLogDir();
      require('electron').shell.showItemInFolder(LOG_PATH);
      return { ok: true, logPath: LOG_PATH };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

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
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok ? { ok: true, latency: Date.now() - start } : { ok: false, error: error || 'UNKNOWN' });
    };
    socket.setTimeout(5000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'ETIMEDOUT'));
    socket.once('error', (err) => finish(false, (err && (err.code || err.message)) || 'ERROR'));
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


/* ====== 一键收集诊断信息（用于对比"我的机器能用、别人的不能用"）====== */
function runCapture(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    try {
      require('child_process').execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || stderr || (err && err.message) || '').trim() });
      });
    } catch (e) { resolve({ ok: false, out: e.message }); }
  });
}

ipcMain.handle('collect-diagnostics', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const lines = [];
  const add = (k, v) => lines.push(k + ': ' + v);

  add('时间', new Date().toISOString());
  add('程序版本', app.getVersion());
  try {
    const bi = require(path.join(__dirname, 'renderer', 'build-info.js'));
  } catch (e) {}
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'renderer', 'build-info.js'), 'utf8');
    add('构建标识', (raw.match(/sha:\s*"([^"]+)"/) || [])[1] || '未知');
  } catch (e) { add('构建标识', '读取失败'); }
  add('系统', os.type() + ' ' + os.release() + ' ' + os.arch());
  add('Electron', process.versions.electron + '  Node ' + process.versions.node);
  add('安装路径', __dirname);
  add('resourcesPath', process.resourcesPath || '(无)');

  /* 是否管理员 */
  const adminCheck = await runCapture('net', ['session']);
  add('管理员权限', adminCheck.ok ? '是' : '否（虚拟网卡可能无法创建！）');

  /* 运行文件 */
  const binDir = path.join(process.resourcesPath || '', 'bin');
  try {
    const files = fs.readdirSync(binDir);
    add('bin 目录', binDir);
    files.forEach((f) => {
      const st = fs.statSync(path.join(binDir, f));
      add('  ' + f, (st.size / 1048576).toFixed(1) + ' MB');
    });
    if (!files.length) add('  (空)', '缺少运行文件！');
  } catch (e) { add('bin 目录', '不存在: ' + binDir); }

  /* 网卡（含 EasyTier 虚拟网卡） */
  const ifaces = os.networkInterfaces();
  const ipv4 = [];
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      if (info && (info.family === 'IPv4' || info.family === 4)) ipv4.push(name + ' = ' + info.address);
    });
  });
  add('网卡 IPv4', ipv4.length ? '\n    ' + ipv4.join('\n    ') : '(无)');
  add('虚拟网卡', ipv4.some((s) => s.includes('10.200.')) ? '已创建' : '未创建（EasyTier 未运行或 TUN 失败）');

  /* 防火墙规则 */
  const fw = await runCapture('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=BLFP 联机助手']);
  add('防火墙规则', fw.out.includes('BLFP') ? '已存在' : '不存在（访客可能连不上）');

  /* 网络类别 */
  const prof = await runCapture('powershell', ['-NoProfile', '-Command', 'Get-NetConnectionProfile | Select-Object -Property InterfaceAlias,NetworkCategory | Format-Table -HideTableHeaders | Out-String']);
  add('网络类别', '\n    ' + (prof.out || '(读取失败)').split('\n').filter(Boolean).join('\n    '));

  /* 关键节点连通性 */
  for (const [label, host, port] of [['EasyTier 中继', '47.103.142.240', 11010]]) {
    const res = await new Promise((resolve) => {
      const net = require('net');
      const s = new net.Socket();
      const t0 = Date.now();
      let done = false;
      const fin = (r) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(r); };
      s.setTimeout(5000);
      s.once('connect', () => fin('OK ' + (Date.now() - t0) + ' ms'));
      s.once('timeout', () => fin('超时 ETIMEDOUT'));
      s.once('error', (e) => fin('失败 ' + (e.code || e.message)));
      try { s.connect(port, host); } catch (e) { fin('失败 ' + e.message); }
    });
    add(label + ' (' + host + ':' + port + ')', res);
  }
  add('服务器 (' + (process.env.BLFP_SERVER || '154.40.43.136:4000') + ')', '(由客户端测速)');

  /* 日志尾部 */
  try {
    const logPath = path.join(process.env.APPDATA || process.env.HOME || '.', 'BLFP', 'logs', 'blfp.log');
    const content = fs.readFileSync(logPath, 'utf8');
    const tail = content.split(/\r?\n/).filter(Boolean).slice(-40);
    add('最近日志', '\n    ' + tail.join('\n    '));
  } catch (e) { add('最近日志', '读取失败'); }

  return lines.join('\n');
});

/* 以管理员身份重启（仅在用户确认后调用，不再默认提权） */
ipcMain.handle('relaunch-elevated', async () => {
  try {
    const { execFile } = require('child_process');
    const exe = process.execPath.replace(/"/g, '""');
    const cmd = 'Start-Process -FilePath "' + exe + '" -Verb RunAs';
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true }, (err) => {
      if (err) console.error('[BLFP] 提权重启失败:', err.message);
    });
    setTimeout(() => app.quit(), 900);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('is-elevated', async () => {
  const r = await runCapture('net', ['session']);
  return r.ok;
});

ipcMain.handle('easytier-status', async () => easyTierMgr.getStatus());
ipcMain.handle('easytier-test', async (_e, config) => {
  const hostVirtualIp = typeof config === 'string' ? config : config?.hostVirtualIp;
  const port = config?.port || 25565;
  return easyTierMgr.testConnectivity(hostVirtualIp, port, 2500);
});

easyTierMgr.on('log', (line) => mainWindow?.webContents.send('easytier-log', line));
easyTierMgr.on('status', (status) => mainWindow?.webContents.send('easytier-status', status));
easyTierMgr.on('manager-error', (error) => mainWindow?.webContents.send('easytier-error', error));
