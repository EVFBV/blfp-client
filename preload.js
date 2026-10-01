const { contextBridge, ipcRenderer } = require('electron');

const blfpApi = {
  // 端口相关
  scanPorts: () => ipcRenderer.invoke('scan-ports'),
  checkPort: (port) => ipcRenderer.invoke('check-port', port),

  // 应用信息与安全外链
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkGithubUpdate: (channel) => ipcRenderer.invoke('check-github-update', channel),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /* 软件内更新：自己挑源下载 + 静默安装，全程不出现安装程序界面。
     注意主进程在下载完、拉起安装器后很快就会退出（要让安装器能覆盖 BLFP.exe），
     所以进度只能靠 onUpdateProgress 推过来，别指望 startUpdate 的返回值。 */
  startUpdate: (opts) => ipcRenderer.invoke('start-update', opts),
  /* 上次软件内更新的结果（安装器写的）。失败时要让用户看到原因，
     而不是「软件自己关了一下又开了」。读一次就清掉。 */
  readUpdateStatus: () => ipcRenderer.invoke('read-update-status'),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, payload) => cb(payload)),

  // 本机局域网 IP
  getLanIp: () => ipcRenderer.invoke('get-lan-ip'),

  // 窗口三按钮跟随主题
  setTitlebarOverlay: (theme) => ipcRenderer.invoke('set-titlebar-overlay', theme),

  // 自定义标题栏窗口控制
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // 后台黑屏自愈
  onForceRepaint: (cb) => ipcRenderer.on('force-repaint', () => cb()),

  // 应用内日志窗口 / 打开日志文件夹
  readLog: (lines) => ipcRenderer.invoke('read-log', lines),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),

  // 日志写入文件（供 PowerShell 实时查看）
  appendLog: (lines) => ipcRenderer.invoke('append-log', lines),

  // 诊断信息
  collectDiagnostics: () => ipcRenderer.invoke('collect-diagnostics'),
  isElevated: () => ipcRenderer.invoke('is-elevated'),
  relaunchElevated: () => ipcRenderer.invoke('relaunch-elevated'),

  // 退出软件
  exitApp: () => ipcRenderer.invoke('exit-app'),

  // TCP 测延迟（frp 节点 ping）
  pingNode: (cfg) => ipcRenderer.invoke('ping-node', cfg),

  // 局域网 MOTD 广播
  motdStart: (cfg) => ipcRenderer.invoke('motd-start', cfg),
  motdStop: () => ipcRenderer.invoke('motd-stop'),

  // frpc 管理
  frpcStart: (cfg) => ipcRenderer.invoke('frpc-start', cfg),
  frpcStop: () => ipcRenderer.invoke('frpc-stop'),
  onFrpcLog: (cb) => ipcRenderer.on('frpc-log', (_e, line) => cb(line)),
  onFrpcPort: (cb) => ipcRenderer.on('frpc-port', (_e, port) => cb(port)),
  onFrpcError: (cb) => ipcRenderer.on('frpc-error', (_e, err) => cb(err)),

  // EasyTier 主进程
  easytierStart: (config) => ipcRenderer.invoke('easytier-start', config),
  easytierStop: () => ipcRenderer.invoke('easytier-stop'),
  easytierStatus: () => ipcRenderer.invoke('easytier-status'),
  easytierTest: (hostVirtualIp) => ipcRenderer.invoke('easytier-test', { hostVirtualIp }),
  onEasytierLog: (cb) => ipcRenderer.on('easytier-log', (_e, line) => cb(line)),
  onEasytierStatus: (cb) => ipcRenderer.on('easytier-status', (_e, status) => cb(status)),
  onEasytierError: (cb) => ipcRenderer.on('easytier-error', (_e, error) => cb(error)),

  // 移除监听器
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),
  openLogExternal: () => ipcRenderer.invoke('open-log-external'),
  setCustomTitlebar: (opts) => ipcRenderer.invoke('set-custom-titlebar', opts),
  setCustomBackground: (opts) => ipcRenderer.invoke('set-custom-background', opts),

  /* 布局调试器的独立窗口（仅 PRE 版带调试器时可用）。
     主窗口用 tunerOpen/tunerClose 开合，
     调试器窗口用 onTunerCmd/onTunerData 收指令，
     两边用 toTuner / toMain 互发消息。 */
  tunerOpen: () => ipcRenderer.invoke('tuner-open'),
  tunerClose: () => ipcRenderer.invoke('tuner-close'),
  tunerIsOpen: () => ipcRenderer.invoke('tuner-is-open'),
  tunerToMain: (channel, payload) => ipcRenderer.invoke('tuner-to-main', channel, payload),
  onTunerCmd: (cb) => ipcRenderer.on('tuner-cmd', (_e, msg) => cb(msg)),
  onTunerWindowClosed: (cb) => ipcRenderer.on('tuner-window-closed', () => cb()),
  toTuner: (channel, payload) => ipcRenderer.send('main-to-tuner', channel, payload),
  onTunerData: (cb) => ipcRenderer.on('tuner-data', (_e, msg) => cb(msg))
};

/* 同时以 mclink 和 electronAPI 两个名字暴露（历史代码两种写法都有） */
contextBridge.exposeInMainWorld('mclink', blfpApi);
contextBridge.exposeInMainWorld('electronAPI', blfpApi);
