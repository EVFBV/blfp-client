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

  // P2P 隧道
  tunnelHostConnect: (cfg) => ipcRenderer.invoke('tunnel-host-connect', cfg),
  tunnelGuestListen: (cfg) => ipcRenderer.invoke('tunnel-guest-listen', cfg),
  tunnelSend: (connId, data) => ipcRenderer.send('tunnel-send', { connId, data }),
  tunnelClose: (connId) => ipcRenderer.invoke('tunnel-close', { connId }),
  tunnelStopAll: () => ipcRenderer.invoke('tunnel-stop-all'),
  onTunnelData: (cb) => ipcRenderer.on('tunnel-data', (_e, d) => cb(d)),
  onTunnelNewConn: (cb) => ipcRenderer.on('tunnel-new-conn', (_e, d) => cb(d)),
  onTunnelClosed: (cb) => ipcRenderer.on('tunnel-closed', (_e, d) => cb(d)),

  // 移除监听器
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),
});
