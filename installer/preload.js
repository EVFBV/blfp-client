const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  getDefaultDir: () => ipcRenderer.invoke('get-default-dir'),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  getVerifyCode: () => ipcRenderer.invoke('get-verify-code'),
  verifyCode: (input) => ipcRenderer.invoke('verify-code', input),
  selfCheck: () => ipcRenderer.invoke('self-check'),
  install: (opts) => ipcRenderer.invoke('install', opts),
  launch: (exePath) => ipcRenderer.invoke('launch', exePath),
  quit: () => ipcRenderer.invoke('quit'),
  onProgress: (cb) => ipcRenderer.on('install-progress', (e, data) => cb(data)),
});
