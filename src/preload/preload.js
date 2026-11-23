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
// 지금 화면 언어 (v0.30.0): 화면 스크립트가 첫 글자를 그리기 전에 알아야 해서 시작할 때 한 번만 동기로 묻는다
const uiLang = (() => {
  try {
    return ipcRenderer.sendSync('i18n:lang');
  } catch {
    return 'ko';
  }
})();

contextBridge.exposeInMainWorld('host', {
  lang: uiLang,
  openModels: (ids) => ipcRenderer.send('models:open', ids),
  pickModels: () => ipcRenderer.send('models:pick'),
  logout: () => ipcRenderer.send('logout'),
  // files: [{ name, type, lastModified, data: ArrayBuffer }]
  // opts: { question(기록·종합용 질문), textById({ 서비스 id: 그 서비스에 보낼 글 }) }
  sendPrompt: (text, targets, files, opts) => ipcRenderer.invoke('prompt:send', { text, targets, files, opts }),
  sendFollowUp: (id, text, files, opts) => ipcRenderer.invoke('prompt:followup', { id, text, files, opts }),
  // AI끼리 이어 묻기 (v0.26.0): 한 패널의 답을 다른 패널에 넘기기(review · counter · continue) · 다시 보내기 · 다른 AI로 보내기 · 토론
  handoff: (from, to, intent) => ipcRenderer.invoke('chain:handoff', from, to, intent),
  resend: (id) => ipcRenderer.invoke('prompt:resend', id),
  sendElsewhere: (from, to) => ipcRenderer.invoke('prompt:elsewhere', from, to),
  debate: {
    start: (cfg) => ipcRenderer.invoke('debate:start', cfg),
    stop: () => ipcRenderer.invoke('debate:stop'),
    interject: (text) => ipcRenderer.invoke('debate:interject', text),
  },
  workflow: {
    start: (cfg) => ipcRenderer.invoke('workflow:start', cfg),
    stop: () => ipcRenderer.invoke('workflow:stop'),
    resume: (opts) => ipcRenderer.invoke('workflow:resume', opts),
  },
  factcheck: {
    start: (cfg) => ipcRenderer.invoke('factcheck:start', cfg),
    stop: () => ipcRenderer.invoke('factcheck:stop'),
  },
  copyAnswer: (id) => ipcRenderer.invoke('answer:copy', id),
  setView: (value) => ipcRenderer.send('view:set', value),
  getAnswers: () => ipcRenderer.invoke('answers:get'),
  getAnswer: (id) => ipcRenderer.invoke('answer:get', id),
  // 셀렉터 편집기 (v0.35.0) · GitHub 이슈 양식
  selectors: {
    get: (id) => ipcRenderer.invoke('selectors:get', id),
    set: (id, patch) => ipcRenderer.invoke('selectors:set', id, patch),
    reset: (id) => ipcRenderer.invoke('selectors:reset', id),
  },
  openIssue: (title, body) => ipcRenderer.invoke('issue:open', title, body),
  // 기록 의미 검색 색인 (v0.36.0)
  embed: {
    status: () => ipcRenderer.invoke('embed:status'),
    build: () => ipcRenderer.invoke('embed:build'),
    stop: () => ipcRenderer.invoke('embed:stop'),
  },
  history: {
    list: (query, filters, opts) => ipcRenderer.invoke('history:list', query, filters, opts),
    archiveInfo: () => ipcRenderer.invoke('history:archiveInfo'),
    semantic: (query, filters) => ipcRenderer.invoke('history:semantic', query, filters),
    import: (list) => ipcRenderer.invoke('history:import', list),
    get: (id) => ipcRenderer.invoke('history:get', id),
    stats: () => ipcRenderer.invoke('history:stats'),
    // 태그 · 즐겨찾기 · 대화 줄기 · 종류별 추천 (v0.27.0)
    setTags: (id, tags) => ipcRenderer.invoke('history:setTags', id, tags),
    setStar: (id, on) => ipcRenderer.invoke('history:setStar', id, on),
    thread: (threadId) => ipcRenderer.invoke('history:thread', threadId),
    tags: () => ipcRenderer.invoke('history:tags'),
    recommend: (order) => ipcRenderer.invoke('history:recommend', order),
    speed: () => ipcRenderer.invoke('history:speed'),
    // 답변 평가: 지금 라운드 기록의 그 AI 답변에 1 · -1 · 0(지우기) → 남긴 값 | null
    feedback: (svcId, value) => ipcRenderer.invoke('history:feedback', svcId, value),
    remove: (id) => ipcRenderer.invoke('history:delete', id),
    clear: () => ipcRenderer.invoke('history:clear'),
  },
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  // 내보내기: { name, text, kind: 'md' | 'html' | 'mla'(설정 옮기기, v0.29.0) } → 저장 창 → { ok, path } | { ok: false, cancelled }
  saveFile: (file) => ipcRenderer.invoke('file:save', file),
  // 로컬 LLM (v0.16.0): 설정 { enabled, baseUrl, model } 바꾸기 · 모델 목록 (연결 확인)
  local: {
    setPrefs: (next) => ipcRenderer.invoke('local:setPrefs', next),
    models: (baseUrl) => ipcRenderer.invoke('local:models', baseUrl),
    // 패널 없이 한 번 묻기 (v0.29.0, 스킬 압축) → { ok, text } | { ok: false, error }
    ask: (text) => ipcRenderer.invoke('local:ask', text),
  },
  shortcuts: () => ipcRenderer.invoke('shortcuts:list'),
  runSynth: (judgeId, kind) => ipcRenderer.invoke('synth:run', judgeId, kind),
  setSynth: (opts) => ipcRenderer.send('synth:set', opts),
  setSettings: (opts) => ipcRenderer.send('settings:set', opts),
  refreshRemote: () => ipcRenderer.invoke('remote:refresh'),
  // 앱 업데이트 (v0.20.0): 확인 · 받기 · 다시 시작해서 설치
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    openReleases: () => ipcRenderer.send('update:openReleases'),
  },
  setLayout: (value) => ipcRenderer.send('layout:set', value),
  setFocus: (id) => ipcRenderer.send('layout:focus', id),
  setSidebar: (open) => ipcRenderer.send('layout:sidebar', open),
  setPanelBar: (id, rows) => ipcRenderer.send('layout:bar', { id, on: !!rows, rows: Number(rows) || 0 }), // 바 줄 수 0~2 (v0.28.0)
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
    // 적용 후 커밋 (v0.28.0): 경로 목록 · 메시지만 넘기고, 검사 · 실행은 메인(gitcommit.js)이 한다. push는 하지 않는다
    commitInfo: (paths) => ipcRenderer.invoke('git:commitInfo', paths),
    commit: (req) => ipcRenderer.invoke('git:commit', req),
    createBranch: (name) => ipcRenderer.invoke('git:branchCreate', name), // 새 브랜치에 적용 (v0.34.0)
  },
  // 미리보기 창의 테스트 실행 (Windows 앱 전용): 고칠 파일 목록만 넘기고, 확인·실행·되돌리기는 메인(devtest.js)이 한다
  devtest: {
    info: () => ipcRenderer.invoke('devtest:info'),
    trial: (changes, scripts) => ipcRenderer.invoke('devtest:trial', changes, scripts), // scripts: 검사 이름 (test · lint · typecheck · build, v0.28.0)
    run: (scripts) => ipcRenderer.invoke('devtest:run', scripts), // 지금 파일 그대로 한 번 (v0.40.0, 로드맵 카드)
    stop: () => ipcRenderer.invoke('devtest:stop'),
  },
  // 개발 환경 점검 (v0.41.0, Windows 앱 전용): 도구 id · 포트만 넘기고, 찾기 · 버전 묻기는 메인(envcheck.js)이 한다. 설치는 하지 않는다
  env: {
    check: (req) => ipcRenderer.invoke('env:check', req),
    openInstall: (id) => ipcRenderer.invoke('env:openInstall', id), // 목록에 있는 공식 설치 안내 주소만
  },
  panelAction: (id, action) => ipcRenderer.send('panel:action', { id, action }),
  on: (channel, fn) => {
    if (CHANNELS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
