'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['state', 'panel:status', 'synth:status', 'shortcut']);

contextBridge.exposeInMainWorld('host', {
  openModels: (ids) => ipcRenderer.send('models:open', ids),
  pickModels: () => ipcRenderer.send('models:pick'),
  logout: () => ipcRenderer.send('logout'),
  sendPrompt: (text, targets) => ipcRenderer.invoke('prompt:send', { text, targets }),
  copyAnswer: (id) => ipcRenderer.invoke('answer:copy', id),
  setView: (value) => ipcRenderer.send('view:set', value),
  getAnswers: () => ipcRenderer.invoke('answers:get'),
  history: {
    list: (query) => ipcRenderer.invoke('history:list', query),
    get: (id) => ipcRenderer.invoke('history:get', id),
    remove: (id) => ipcRenderer.invoke('history:delete', id),
    clear: () => ipcRenderer.invoke('history:clear'),
  },
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  shortcuts: () => ipcRenderer.invoke('shortcuts:list'),
  runSynth: (judgeId) => ipcRenderer.invoke('synth:run', judgeId),
  setSynth: (opts) => ipcRenderer.send('synth:set', opts),
  setSettings: (opts) => ipcRenderer.send('settings:set', opts),
  setLayout: (value) => ipcRenderer.send('layout:set', value),
  panelAction: (id, action) => ipcRenderer.send('panel:action', { id, action }),
  on: (channel, fn) => {
    if (CHANNELS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
