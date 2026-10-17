'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['state', 'panel:status']);

contextBridge.exposeInMainWorld('host', {
  openModels: (ids) => ipcRenderer.send('models:open', ids),
  pickModels: () => ipcRenderer.send('models:pick'),
  logout: () => ipcRenderer.send('logout'),
  sendPrompt: (text, targets) => ipcRenderer.invoke('prompt:send', { text, targets }),
  copyAnswer: (id) => ipcRenderer.invoke('answer:copy', id),
  setLayout: (value) => ipcRenderer.send('layout:set', value),
  panelAction: (id, action) => ipcRenderer.send('panel:action', { id, action }),
  on: (channel, fn) => {
    if (CHANNELS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
