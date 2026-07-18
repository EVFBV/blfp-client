const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uninstaller', {
  uninstall: () => ipcRenderer.invoke('uninstall'),
  openDir: () => ipcRenderer.invoke('open-dir'),
  quit: () => ipcRenderer.invoke('quit'),
});
