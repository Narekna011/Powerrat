const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  consentDialog: (data) => ipcRenderer.invoke('consent-dialog', data)
});

