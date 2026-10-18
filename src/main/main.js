'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');
const { SERVICES, MAX_SELECTED, DEFAULT_SELECTED, ATTACH_LIMITS, normalizeSelected, uploadOf } = require('../shared/services');
const autologin = require('./autologin');
const { sendPrompt } = require('./injector');
const { snapshot, watchAnswer } = require('./watcher');
const { dev, log } = require('./dev');
const { createRounds } = require('../shared/rounds');
const history = require('./history');
const remote = require('./remote');
const { shortcutList, shortcutFor } = require('../shared/shortcuts');
const project = require('./project');

const HEADER_H = 28; // 패널마다 이름·상태를 그리는 머리줄 높이
const TOOLBAR_H = 44; // 맨 위 공통 툴바 높이
const COMPOSER_H = 132; // 채팅 화면 맨 아래 공통 입력창 높이 (첨부 파일 줄 포함)
const GAP = 4;
const SIDEBAR_W = 300; // 프로젝트 사이드바 폭 (styles.css와 같게)

// 모든 패널이 한 세션을 같이 쓴다. 그래야 Google 로그인 한 번으로 다른 서비스의 "Google로 계속하기"가 이어진다.
const PARTITION = 'persist:shared';
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent('https://myaccount.google.com/');

// Electron 기본 UA에는 "Electron/x.y" 토큰이 들어가 일부 사이트가 막는다. 일반 Chrome UA로 바꾼다.
const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`;
// Google 로그인은 임베디드 Chromium을 "안전하지 않은 브라우저"로 막는다. 로그인 도메인에만 Firefox UA를 보낸다.
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const AUTH_URL_RE =
  /accounts\.google\.com|accounts\.x\.ai|auth\.mistral\.ai|appleid\.apple\.com|auth0|auth\.openai\.com|\/oauth|\/auth\/|\/login|\/signin|sso/i;

app.userAgentFallback = CHROME_UA;
if (dev.profile) app.setPath('userData', dev.profile);
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

let win = null;
let mode = 'login'; // 'login' | 'pick' | 'chat'
let chatView = 'panels'; // 채팅 화면 안에서: 'panels' (웹 패널) | 'compare' (답변 비교) | 'changes' (변경 제안) | 'history' (기록) | 'help' (단축키)
let sidebarOpen = false; // 프로젝트 사이드바가 열려 있으면 패널을 오른쪽으로 민다
let loginView = null;
const panels = new Map(); // id -> { view, login }  (지금 열려 있는 서비스 패널)

// ---------- 설정 저장 ----------

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
const TIMEOUT_CHOICES = [5, 10, 20, 30, 60]; // 답변 최대 대기 시간(분) 선택지
let prefs = {
  selected: [...DEFAULT_SELECTED],
  layout: 'grid',
  synthTarget: 'chatgpt',
  autoSynth: false,
  answerTimeoutMin: 20,
  remoteSelectors: true, // 사이트 셀렉터 원격 갱신
  projectRoot: null, // 마지막으로 연 프로젝트 폴더
};

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch {}
  // 예전 설정(Groq 등 없어진 서비스, 4개 넘는 선택)을 지금 서비스 목록에 맞춘다.
  prefs.selected = normalizeSelected(prefs.selected);
  if (!SERVICES.some((s) => s.id === prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
}

function savePrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch (err) {
    console.error('[prefs] 설정을 저장하지 못했습니다:', err.message);
  }
}

// ---------- 세션 ----------

const ses = () => session.fromPartition(PARTITION);

function setupSession() {
  const s = ses();
  s.setUserAgent(CHROME_UA);

  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  s.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  s.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, cb) => {
    const headers = details.requestHeaders;
    headers['User-Agent'] = FIREFOX_UA;
    for (const key of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(key)) delete headers[key];
    }
    cb({ requestHeaders: headers });
  });
}

async function isGoogleLoggedIn() {
  const cookies = await ses().cookies.get({ domain: 'google.com' });
  return cookies.some((c) => c.name === 'SID' || c.name === '__Secure-1PSID');
}

// ---------- 뷰 ----------

function newView() {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 화면에 안 보이는 패널도 답변 스트리밍이 멈추지 않도록
    },
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    log('popup', url.slice(0, 160));
    // 로그인 팝업은 같은 세션의 자식 창으로 연다. 나머지 링크는 기본 브라우저로.
    if (url === 'about:blank' || AUTH_URL_RE.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          parent: win,
          autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return view;
}

function destroyView(view) {
  if (!view) return;
  win?.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function sendPanel(id, patch) {
  if (win && !win.isDestroyed()) win.webContents.send('panel:status', { id, ...patch });
}

function openPanel(svc) {
  const view = newView();
  const wc = view.webContents;

  wc.on('did-start-loading', () => sendPanel(svc.id, { loading: true }));
  wc.on('did-stop-loading', () => sendPanel(svc.id, { loading: false, url: wc.getURL() }));
  wc.on('did-navigate', (_e, url, code) => {
    log('nav', svc.id, code, url.slice(0, 160));
    sendPanel(svc.id, { url });
  });
  wc.on('did-redirect-navigation', (d) => d.isMainFrame && log('nav', svc.id, 'redirect', d.url.slice(0, 160)));
  wc.on('did-navigate-in-page', (_e, url) => sendPanel(svc.id, { url }));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) sendPanel(svc.id, { error: `${desc} (${code})`, url });
  });

  const login = autologin.attach(wc, svc, (state) => sendPanel(svc.id, { login: state }));
  win.contentView.addChildView(view);
  wc.loadURL(svc.url);
  panels.set(svc.id, { view, login });
}

// ---------- 화면 전환 ----------

function showLogin() {
  for (const { view } of panels.values()) destroyView(view);
  panels.clear();
  mode = 'login';

  loginView = newView();
  const wc = loginView.webContents;
  // 로그인 직후 Google이 "패스키 생성됨" 같은 안내 화면에서 멈추기도 한다.
  // 그래서 페이지 이동이 아니라 로그인 쿠키가 생기는 순간을 보고 넘어간다.
  let timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (mode === 'login' && (await isGoogleLoggedIn())) showPick();
    }, 800);
  };
  const onCookie = (_e, cookie, _cause, removed) => {
    if (!removed && (cookie.name === 'SID' || cookie.name === '__Secure-1PSID')) check();
  };
  ses().cookies.on('changed', onCookie);
  wc.once('destroyed', () => {
    clearTimeout(timer);
    ses().cookies.removeListener('changed', onCookie);
  });
  wc.on('did-navigate', check);
  wc.on('did-navigate-in-page', check);
  win.contentView.addChildView(loginView);
  wc.loadURL(LOGIN_URL);
  pushState();
}

function showPick() {
  destroyView(loginView);
  loginView = null;
  mode = 'pick';
  // 열린 패널은 살려 두되 화면에서만 뺀다. 다시 열면 대화가 그대로 남아 있다.
  for (const { view } of panels.values()) win.contentView.removeChildView(view);
  pushState();
}

function showChat(selected) {
  const ids = SERVICES.map((s) => s.id).filter((id) => selected.includes(id)).slice(0, MAX_SELECTED);
  if (!ids.length) return;
  prefs.selected = ids;
  savePrefs();

  for (const [id, p] of panels) {
    if (!ids.includes(id)) {
      destroyView(p.view);
      panels.delete(id);
    }
  }
  for (const svc of SERVICES) {
    if (!ids.includes(svc.id)) continue;
    const p = panels.get(svc.id);
    if (p) win.contentView.addChildView(p.view);
    else openPanel(svc);
  }
  mode = 'chat';
  chatView = 'panels';
  pushState();
}

async function logout() {
  destroyView(loginView);
  loginView = null;
  for (const { view } of panels.values()) destroyView(view);
  panels.clear();
  const s = ses();
  await s.clearStorageData();
  await s.clearCache();
  await s.clearAuthCache();
  showLogin();
}

// ---------- 배치 ----------

function computeRects() {
  const [w, h] = win.getContentSize();
  const side = mode === 'chat' && sidebarOpen ? SIDEBAR_W : 0;
  const area = { x: side, y: TOOLBAR_H, width: w - side, height: h - TOOLBAR_H };
  if (mode === 'login') return { login: area, panels: [] };
  if (mode !== 'chat') return { panels: [] };

  const ids = SERVICES.map((s) => s.id).filter((id) => panels.has(id));
  const n = ids.length;
  const cols = prefs.layout === 'row' || n <= 3 ? n : 2;
  const rows = Math.ceil(n / cols);
  const cellW = Math.floor((area.width - GAP * (cols + 1)) / cols);
  const panelsH = area.height - COMPOSER_H;
  const cellH = Math.floor((panelsH - GAP * (rows + 1)) / rows);

  return {
    panels: ids.map((id, i) => {
      const x = area.x + GAP + (i % cols) * (cellW + GAP);
      const y = area.y + GAP + Math.floor(i / cols) * (cellH + GAP);
      return {
        id,
        frame: { x, y, width: cellW, height: cellH },
        content: { x, y: y + HEADER_H, width: cellW, height: Math.max(0, cellH - HEADER_H) },
      };
    }),
  };
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  // 최소화된 동안에는 창 크기가 0으로 잡혀 패널 배치가 깨진다. 복원될 때('restore') 다시 배치한다.
  if (win.isMinimized()) return;
  const rects = computeRects();
  if (loginView && rects.login) loginView.setBounds(rects.login);
  // 비교·기록·도움말 화면에서는 웹 패널을 화면 밖으로 옮겨 둔다.
  // setVisible(false)로 숨기면 키보드 포커스가 숨은 패널에 갇혀 단축키가 먹지 않는다.
  // 크기는 그대로라서 페이지 배치가 바뀌지 않고 답변 감시도 계속된다.
  const showPanels = mode === 'chat' && chatView === 'panels';
  for (const r of rects.panels) {
    panels.get(r.id)?.view.setBounds(showPanels ? r.content : { ...r.content, x: -20000 });
  }
  if (!showPanels && [...panels.values()].some((p) => p.view.webContents.isFocused())) win.webContents.focus();
  win.webContents.send('state', {
    mode,
    chatView,
    layout: prefs.layout,
    selected: prefs.selected,
    maxSelected: MAX_SELECTED,
    attachLimits: ATTACH_LIMITS,
    synthTarget: prefs.synthTarget,
    autoSynth: prefs.autoSynth,
    answerTimeoutMin: prefs.answerTimeoutMin,
    timeoutChoices: TIMEOUT_CHOICES,
    remoteSelectors: prefs.remoteSelectors,
    remote: remote.getStatus(),
    services: SERVICES.map((s) => ({ id: s.id, name: s.name, color: s.color, url: s.url, accept: uploadOf(s).accept })),
    rects: rects.panels,
  });
}

// ---------- 창 ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 960,
    minHeight: 600,
    title: 'Multitude LLM',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', async () => {
    if (dev.start === 'chat') showChat(prefs.selected);
    else if (dev.start === 'pick' || (await isGoogleLoggedIn())) showPick();
    else showLogin();
  });

  win.on('resize', pushState);
  win.on('restore', pushState);
  win.on('closed', () => {
    win = null;
    loginView = null;
    panels.clear();
  });
}

// ---------- IPC ----------

ipcMain.on('models:open', (_e, selected) => {
  if (Array.isArray(selected)) showChat(selected.filter((id) => typeof id === 'string'));
});
ipcMain.on('models:pick', () => mode === 'chat' && showPick());
ipcMain.on('logout', () => logout());

ipcMain.on('layout:set', (_e, value) => {
  if (value === 'grid' || value === 'row') {
    prefs.layout = value;
    savePrefs();
    pushState();
  }
});

// ---------- 질문 보내기 · 교차검토(종합) ----------

function sendSynthStatus(patch) {
  if (win && !win.isDestroyed()) win.webContents.send('synth:status', patch);
}

// 질문 보내기·답변 감시·종합은 크롬 확장 프로그램과 같이 쓰는 shared/rounds.js가 한다.
const rounds = createRounds({
  services: SERVICES,
  hasPanel: (id) => panels.has(id),
  sendPrompt: (id, text, files) =>
    sendPrompt(panels.get(id).view.webContents, SERVICES.find((s) => s.id === id), text, files),
  snapshot: (id, opts) =>
    panels.has(id) ? snapshot(panels.get(id).view.webContents, SERVICES.find((s) => s.id === id), opts) : null,
  watch: (id, before, isCurrent, onState) => {
    if (dev.drySend) return;
    const opts = {
      maxMs: dev.answerTimeoutMs || prefs.answerTimeoutMin * 60 * 1000,
      startMs: dev.answerStartMs || undefined,
    };
    const svc = SERVICES.find((s) => s.id === id);
    watchAnswer(panels.get(id).view.webContents, svc, before, isCurrent, onState, opts);
  },
  sendPanel,
  sendSynthStatus,
  history,
  prefs: () => prefs,
  log,
});

/** 화면에서 받은 첨부 파일을 검사한다. 모양이 틀리거나 한도를 넘으면 null */
function checkFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > ATTACH_LIMITS.maxFiles) return null;
  let total = 0;
  const out = [];
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !(f.data instanceof ArrayBuffer || ArrayBuffer.isView(f.data))) return null;
    const size = f.data.byteLength;
    total += size;
    if (size > ATTACH_LIMITS.maxFileBytes || total > ATTACH_LIMITS.maxTotalBytes) return null;
    out.push({ name: f.name.slice(0, 200), type: String(f.type || ''), size, lastModified: Number(f.lastModified) || Date.now(), data: f.data });
  }
  return out;
}

// 공통 입력창: 고른 패널들에 같은 질문(과 첨부 파일)을 동시에 보낸다.
ipcMain.handle('prompt:send', async (_e, { text, targets, files, opts }) => {
  if (typeof text !== 'string' || !Array.isArray(targets)) return [];
  const checked = checkFiles(files);
  if (checked && !text.trim() && !checked.length) return [];
  if (!checked) return targets.map((id) => ({ id, ok: false, error: '첨부 파일이 한도를 넘었습니다' }));
  return rounds.sendAll(text, targets, checked, sendOpts(opts));
});

ipcMain.handle('synth:run', (_e, judgeId, kind) =>
  rounds.runSynth(typeof judgeId === 'string' ? judgeId : null, 'manual', kind === 'code' ? 'code' : 'text'),
);

/** 화면이 넘긴 보내기 옵션 검사: { question, textById } */
function sendOpts(opts) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {};
  if (typeof opts.question === 'string') out.question = opts.question.slice(0, 20000);
  if (opts.textById && typeof opts.textById === 'object') {
    out.textById = {};
    for (const s of SERVICES) if (typeof opts.textById[s.id] === 'string') out.textById[s.id] = opts.textById[s.id];
  }
  return out;
}

// 패널 하나에만 이어서 보내기 (프로젝트 모드: 요청한 파일 보내기, 전체 파일 다시 요청)
ipcMain.handle('prompt:followup', async (_e, { id, text, files }) => {
  if (typeof id !== 'string' || typeof text !== 'string' || !text.trim()) return { ok: false, error: '보낼 내용이 없습니다' };
  const checked = checkFiles(files);
  if (!checked) return { id, ok: false, error: '첨부 파일이 한도를 넘었습니다' };
  return rounds.sendFollowUp(id, text, checked);
});

// ---------- 프로젝트 모드 (로컬 폴더 읽기·쓰기는 project.js, 처리는 화면 쪽 공통 모듈) ----------

ipcMain.on('layout:sidebar', (_e, open) => {
  sidebarOpen = !!open;
  pushState();
});

async function rememberProject(p) {
  prefs.projectRoot = p ? p.id : null;
  savePrefs();
  return p;
}

const projectCall = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

ipcMain.handle('project:pick', projectCall(async () => rememberProject(await project.pick(win))));
// Windows 앱은 접근 허용을 다시 받을 필요가 없어 restore·reconnect가 같다.
const restoreProject = async () => {
  if (!prefs.projectRoot) return null;
  try {
    return await project.open(prefs.projectRoot);
  } catch {
    return rememberProject(null); // 폴더가 없어졌으면 잊는다
  }
};
ipcMain.handle('project:restore', projectCall(restoreProject));
ipcMain.handle('project:reconnect', projectCall(restoreProject));
ipcMain.handle('project:close', projectCall(async () => {
  project.close();
  await rememberProject(null);
  return true;
}));
ipcMain.handle('project:readDir', projectCall((rel) => project.readDir(String(rel))));
ipcMain.handle('project:readFile', projectCall((rel, opts) => project.readFile(String(rel), opts || {})));
ipcMain.handle('project:writeFile', projectCall((rel, text) => project.writeFile(String(rel), text)));
ipcMain.handle('project:deleteFile', projectCall((rel) => project.deleteFile(String(rel))));
ipcMain.handle('project:globalExclude', projectCall(() => project.globalExclude()));
ipcMain.handle('project:loadState', projectCall(() => (project.info() ? project.loadState(project.info().id) : null)));
ipcMain.handle('project:saveState', projectCall((data) => (project.info() ? project.saveState(project.info().id, data) : false)));

ipcMain.on('settings:set', (_e, { answerTimeoutMin, remoteSelectors }) => {
  if (TIMEOUT_CHOICES.includes(answerTimeoutMin)) prefs.answerTimeoutMin = answerTimeoutMin;
  if (typeof remoteSelectors === 'boolean' && remoteSelectors !== prefs.remoteSelectors) {
    prefs.remoteSelectors = remoteSelectors;
    if (remoteSelectors) refreshRemote();
    else remote.reset();
  }
  savePrefs();
  pushState();
});

ipcMain.on('synth:set', (_e, { target, auto }) => {
  if (typeof target === 'string' && SERVICES.some((s) => s.id === target)) prefs.synthTarget = target;
  if (typeof auto === 'boolean') prefs.autoSynth = auto;
  savePrefs();
  pushState();
});

// 최신 답변을 Markdown으로 복사. id가 '*'이면 열린 패널 전부를 "## 이름" 머리말로 묶는다.
ipcMain.handle('answer:copy', async (_e, id) => {
  const { text, copied, total } = await rounds.collectMarkdown(id);
  if (copied) clipboard.writeText(text);
  return { copied, total };
});

ipcMain.on('view:set', (_e, value) => {
  if (mode === 'chat' && ['panels', 'compare', 'changes', 'history', 'help'].includes(value)) {
    chatView = value;
    pushState();
  }
});

// 질문·답변 기록
ipcMain.handle('history:list', (_e, query) => history.list(typeof query === 'string' ? query : ''));
ipcMain.handle('history:get', (_e, id) => history.get(id));
ipcMain.handle('history:delete', (_e, id) => history.remove(id));
ipcMain.handle('history:clear', () => history.clear());
ipcMain.handle('clipboard:write', (_e, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

// 답변 비교 화면용: 열린 패널마다 최신 답변 글과 마지막 공통 질문
ipcMain.handle('answers:get', () => rounds.answers());

ipcMain.on('panel:action', (_e, { id, action }) => {
  const targets = id === '*' ? [...panels.entries()] : [[id, panels.get(id)]].filter(([, p]) => p);
  for (const [pid, p] of targets) {
    const wc = p.view.webContents;
    if (action === 'reload') wc.reload();
    else if (action === 'home') wc.loadURL(SERVICES.find((s) => s.id === pid).url);
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'devtools') wc.toggleDevTools();
    else if (action === 'login') p.login.retry();
    else if (action === 'newchat') {
      rounds.cancelWatch(pid);
      sendPanel(pid, { answer: 'clear' });
      wc.loadURL(SERVICES.find((s) => s.id === pid).newChatUrl);
    }
  }
});

// ---------- 사이트 셀렉터 원격 갱신 ----------

const REMOTE_REFRESH_MS = 6 * 60 * 60 * 1000;

async function refreshRemote() {
  if (!prefs.remoteSelectors) return remote.getStatus();
  const st = await remote.refresh();
  log('remote', JSON.stringify(st));
  pushState();
  return st;
}

ipcMain.handle('remote:refresh', () => refreshRemote());

// ---------- 단축키 ----------

ipcMain.handle('shortcuts:list', () => shortcutList());

/** 단축키 동작을 실행한다. 처리했으면 true (그 키는 페이지로 넘기지 않는다). */
function runShortcut(action) {
  if (mode !== 'chat' || !win || win.isDestroyed()) return false;

  if (action.startsWith('view:')) {
    const view = action.slice(5);
    // 같은 화면 단축키를 다시 누르면 패널로 돌아간다.
    chatView = chatView === view ? 'panels' : view;
    pushState();
    return true;
  }
  if (action.startsWith('panel:')) {
    const ids = SERVICES.map((s) => s.id).filter((id) => panels.has(id));
    const p = panels.get(ids[Number(action.slice(6)) - 1]);
    if (!p) return false;
    if (chatView !== 'panels') {
      chatView = 'panels';
      pushState();
    }
    p.view.webContents.focus();
    return true;
  }
  // 나머지는 화면 쪽 버튼이 하는 일과 같아서 화면으로 넘긴다 (입력창 포커스, 새 대화, 종합, 복사, 대상 켜기/끄기 등).
  win.webContents.focus();
  win.webContents.send('shortcut', action);
  return true;
}

// 메인 창과 서비스 패널 모두에서 단축키를 받는다.
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.alt)) log('key', input.key, input.code, input.control ? 'ctrl' : 'alt');
    const action = shortcutFor(input, { canEscape: mode === 'chat' && chatView !== 'panels' });
    if (action && runShortcut(action)) event.preventDefault();
  });
});

Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    loadPrefs();
    history.init(app.getPath('userData'));
    remote.init(app.getPath('userData'), SERVICES, { remoteUrl: dev.remoteUrl });
    if (prefs.remoteSelectors) {
      refreshRemote();
      setInterval(refreshRemote, REMOTE_REFRESH_MS);
    } else {
      remote.reset(); // 끈 상태면 저장해 둔 원격 값도 쓰지 않는다
    }
    setupSession();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
