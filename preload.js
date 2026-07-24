const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mclink', {
  // 端口相关
  scanPorts: () => ipcRenderer.invoke('scan-ports'),
  checkPort: (port) => ipcRenderer.invoke('check-port', port),

  // 应用信息与安全外链
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkGithubUpdate: () => ipcRenderer.invoke('check-github-update'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 本机局域网 IP
  getLanIp: () => ipcRenderer.invoke('get-lan-ip'),

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
});
