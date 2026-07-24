const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uninstaller', {
  getInstallDir: () => ipcRenderer.invoke('get-install-dir'),
  uninstall: () => ipcRenderer.invoke('uninstall'),
  openDir: () => ipcRenderer.invoke('open-dir'),
  quit: () => ipcRenderer.invoke('quit'),
});
