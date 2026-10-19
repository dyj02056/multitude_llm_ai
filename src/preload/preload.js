'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['state', 'panel:status', 'synth:status', 'shortcut', 'git:output', 'git:done']);

contextBridge.exposeInMainWorld('host', {
  openModels: (ids) => ipcRenderer.send('models:open', ids),
  pickModels: () => ipcRenderer.send('models:pick'),
  logout: () => ipcRenderer.send('logout'),
  // files: [{ name, type, lastModified, data: ArrayBuffer }]
  // opts: { question(기록·종합용 질문), textById({ 서비스 id: 그 서비스에 보낼 글 }) }
  sendPrompt: (text, targets, files, opts) => ipcRenderer.invoke('prompt:send', { text, targets, files, opts }),
  sendFollowUp: (id, text, files, opts) => ipcRenderer.invoke('prompt:followup', { id, text, files, opts }),
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
  runSynth: (judgeId, kind) => ipcRenderer.invoke('synth:run', judgeId, kind),
  setSynth: (opts) => ipcRenderer.send('synth:set', opts),
  setSettings: (opts) => ipcRenderer.send('settings:set', opts),
  refreshRemote: () => ipcRenderer.invoke('remote:refresh'),
  setLayout: (value) => ipcRenderer.send('layout:set', value),
  setFocus: (id) => ipcRenderer.send('layout:focus', id),
  setSidebar: (open) => ipcRenderer.send('layout:sidebar', open),
  // 프로젝트 모드: 고른 폴더 안에서만 읽기·쓰기 (실패하면 Error를 던진다)
  project: Object.fromEntries(
    ['pick', 'restore', 'reconnect', 'close', 'readDir', 'readFile', 'writeFile', 'deleteFile', 'globalExclude', 'loadState', 'saveState'].map(
      (name) => [
        name,
        async (...args) => {
          const r = await ipcRenderer.invoke(`project:${name}`, ...args);
          if (!r.ok) throw new Error(r.error);
          return r.value;
        },
      ],
    ),
  ),
  // git 콘솔 (Windows 앱 전용): 명령 줄 글자만 넘기고, 검사·확인·실행은 메인 프로세스(gitconsole.js)가 한다
  git: {
    info: () => ipcRenderer.invoke('git:info'),
    run: (line) => ipcRenderer.invoke('git:run', line),
    stop: () => ipcRenderer.invoke('git:stop'),
    openTerminal: () => ipcRenderer.invoke('git:openTerminal'),
  },
  panelAction: (id, action) => ipcRenderer.send('panel:action', { id, action }),
  on: (channel, fn) => {
    if (CHANNELS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
