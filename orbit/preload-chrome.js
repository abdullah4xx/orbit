'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbit', {
  call: (cmd, args) => ipcRenderer.invoke('orbit:call', cmd, args || {}),
  on: (evt, fn) => { ipcRenderer.on('orbit:push', (_e, name, data) => { if (name === evt) fn(data); }); },
});
