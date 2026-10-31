'use strict';

// [쉽게 말하면]
// 앱 화면(index.html)과 본체(main.js) 사이의 "창구"입니다.
// 화면은 보안상 컴퓨터 파일 등에 직접 손댈 수 없어서, 여기 정해 둔 기능(window.host.○○)만 부탁할 수 있습니다.
// 예: host.sendPrompt(…) → 본체에 "질문 보내 줘" 요청 → 본체가 처리하고 결과를 돌려줌
// 크롬 확장 프로그램에서는 extension/host.js가 같은 이름의 기능을 제공합니다. 그래서 화면 코드는 두 곳에서 똑같이 동작합니다.

const { contextBridge, ipcRenderer } = require('electron');

// 본체가 화면으로 보내는 알림 중, 화면이 들을 수 있는 종류만 허락합니다.
const CHANNELS = new Set(['state', 'panel:status', 'synth:status', 'shortcut', 'git:output', 'git:done']);

// 화면에서 window.host 로 쓸 수 있는 기능 목록. send는 "부탁만", invoke는 "부탁하고 결과 받기"입니다.
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
  getAnswer: (id) => ipcRenderer.invoke('answer:get', id),
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
  setPanelBar: (id, on) => ipcRenderer.send('layout:bar', { id, on: !!on }),
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
  library: {
    load: () => ipcRenderer.invoke('library:load'),
    save: (data) => ipcRenderer.invoke('library:save', data),
  },
  // git 콘솔 (Windows 앱 전용): 명령 줄 글자만 넘기고, 검사·확인·실행은 메인 프로세스(gitconsole.js)가 한다
  git: {
    info: () => ipcRenderer.invoke('git:info'),
    run: (line) => ipcRenderer.invoke('git:run', line),
    stop: () => ipcRenderer.invoke('git:stop'),
    openTerminal: () => ipcRenderer.invoke('git:openTerminal'),
  },
  // 미리보기 창의 테스트 실행 (Windows 앱 전용): 고칠 파일 목록만 넘기고, 확인·실행·되돌리기는 메인(devtest.js)이 한다
  devtest: {
    info: () => ipcRenderer.invoke('devtest:info'),
    trial: (changes) => ipcRenderer.invoke('devtest:trial', changes),
    stop: () => ipcRenderer.invoke('devtest:stop'),
  },
  panelAction: (id, action) => ipcRenderer.send('panel:action', { id, action }),
  on: (channel, fn) => {
    if (CHANNELS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
