const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  getDefaultDir: () => ipcRenderer.invoke('get-default-dir'),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  install: (opts) => ipcRenderer.invoke('install', opts),
  launch: (exePath) => ipcRenderer.invoke('launch', exePath),
  quit: () => ipcRenderer.invoke('quit'),
  onProgress: (cb) => ipcRenderer.on('install-progress', (e, data) => cb(data)),
});
