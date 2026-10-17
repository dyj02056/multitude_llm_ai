'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');
const SERVICES = require('./services');
const autologin = require('./autologin');
const { sendPrompt } = require('./injector');
const { snapshot, watchAnswer } = require('./watcher');
const { dev, log } = require('./dev');
const { buildSynthPrompt } = require('./synth');
const history = require('./history');
const { SHORTCUTS, shortcutFor } = require('./shortcuts');

const HEADER_H = 28; // 패널마다 이름·상태를 그리는 머리줄 높이
const TOOLBAR_H = 44; // 맨 위 공통 툴바 높이
const COMPOSER_H = 104; // 채팅 화면 맨 아래 공통 입력창 높이
const GAP = 4;

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
  /accounts\.google\.com|appleid\.apple\.com|auth0|auth\.openai\.com|\/oauth|\/auth\/|\/login|\/signin|sso/i;

app.userAgentFallback = CHROME_UA;
if (dev.profile) app.setPath('userData', dev.profile);
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

let win = null;
let mode = 'login'; // 'login' | 'pick' | 'chat'
let chatView = 'panels'; // 채팅 화면 안에서: 'panels' (웹 패널) | 'compare' (답변 비교) | 'history' (기록) | 'help' (단축키)
let loginView = null;
const panels = new Map(); // id -> { view, login }  (지금 열려 있는 서비스 패널)

// ---------- 설정 저장 ----------

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
const TIMEOUT_CHOICES = [5, 10, 20, 30, 60]; // 답변 최대 대기 시간(분) 선택지
let prefs = {
  selected: SERVICES.map((s) => s.id),
  layout: 'grid',
  synthTarget: 'chatgpt',
  autoSynth: false,
  answerTimeoutMin: 20,
};

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch {}
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
  const ids = SERVICES.map((s) => s.id).filter((id) => selected.includes(id));
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
  const area = { x: 0, y: TOOLBAR_H, width: w, height: h - TOOLBAR_H };
  if (mode === 'login') return { login: area, panels: [] };
  if (mode !== 'chat') return { panels: [] };

  const ids = SERVICES.map((s) => s.id).filter((id) => panels.has(id));
  const n = ids.length;
  const cols = prefs.layout === 'row' || n <= 3 ? n : 2;
  const rows = Math.ceil(n / cols);
  const cellW = Math.floor((w - GAP * (cols + 1)) / cols);
  const panelsH = area.height - COMPOSER_H;
  const cellH = Math.floor((panelsH - GAP * (rows + 1)) / rows);

  return {
    panels: ids.map((id, i) => {
      const x = GAP + (i % cols) * (cellW + GAP);
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
    synthTarget: prefs.synthTarget,
    autoSynth: prefs.autoSynth,
    answerTimeoutMin: prefs.answerTimeoutMin,
    timeoutChoices: TIMEOUT_CHOICES,
    services: SERVICES.map(({ id, name, color, url }) => ({ id, name, color, url })),
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

// 공통 입력창으로 보낸 질문 한 번을 "라운드"라고 부른다.
// 자동 종합은 라운드의 모든 답변이 끝났을 때 한 번만 실행한다.
let round = null; // { question, targets: [id], finished: Map(id -> 상태), synthDone, historyId }

const FINISHED = new Set(['done', 'timeout', 'no-answer']);

/** 패널 하나에 글을 보내고 답변을 지켜본다. onFinish(state): 답변이 끝났거나 실패했을 때 */
async function sendToPanel(id, text, onFinish) {
  const svc = SERVICES.find((s) => s.id === id);
  const p = panels.get(id);
  const wc = p.view.webContents;
  const token = (p.watchToken = (p.watchToken || 0) + 1); // 새로 보내면 이전 감시는 멈춘다
  sendPanel(id, { send: 'sending' });
  const before = await snapshot(wc, svc);
  let res;
  try {
    res = await sendPrompt(wc, svc, text);
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  log('send', id, JSON.stringify(res));
  sendPanel(id, { send: res.ok ? 'sent' : 'error', error: res.ok ? undefined : res.error });
  if (!res.ok) {
    onFinish?.('error');
  } else if (!dev.drySend) {
    const opts = {
      maxMs: dev.answerTimeoutMs || prefs.answerTimeoutMin * 60 * 1000,
      startMs: dev.answerStartMs || undefined,
    };
    watchAnswer(
      wc,
      svc,
      before,
      () => p.watchToken === token,
      (answer, info) => {
        log('answer', id, answer, info ? JSON.stringify(info) : '');
        sendPanel(id, { answer, ...info });
        if (FINISHED.has(answer)) onFinish?.(answer);
      },
      opts,
    );
  }
  return { id, ...res };
}

function sendSynthStatus(patch) {
  if (win && !win.isDestroyed()) win.webContents.send('synth:status', patch);
}

/** 패널의 최신 답변: { text: 화면 글, md: Markdown } */
async function readAnswer(id) {
  const svc = SERVICES.find((s) => s.id === id);
  if (!panels.has(id)) return { text: '', md: '' };
  const snap = await snapshot(panels.get(id).view.webContents, svc, { markdown: true });
  return { text: snap?.text || '', md: snap?.md || snap?.text || '' };
}

const serviceName = (id) => SERVICES.find((s) => s.id === id)?.name || id;

async function onRoundAnswer(r, id, state) {
  // 기록은 새 질문을 보낸 뒤에 끝난 답변이라도 그 라운드에 남긴다.
  const { text, md } = state === 'done' ? await readAnswer(id) : { text: '', md: '' };
  history.setAnswer(r.historyId, id, { name: serviceName(id), state, text, md });
  if (r !== round) return; // 그사이 새 질문을 보냈으면 자동 종합은 하지 않는다
  r.finished.set(id, state);
  if (r.finished.size < r.targets.length || r.synthDone || !prefs.autoSynth) return;
  r.synthDone = true;
  runSynth(null, 'auto');
}

/** 종합 요청. judgeId가 없으면 설정된 종합 담당 AI를 쓴다. */
async function runSynth(judgeId, cause = 'manual') {
  const judge = judgeId || prefs.synthTarget;
  if (!round) return fail('먼저 공통 입력창으로 질문을 보내 주세요');
  if (!panels.has(judge)) return fail('종합을 맡을 AI 패널이 열려 있지 않습니다');

  const answers = [];
  for (const svc of SERVICES) {
    if (svc.id === judge || !round.targets.includes(svc.id) || !panels.has(svc.id)) continue;
    // 페이지가 다시 그려지는 순간이면 글이 비어 보일 수 있어 한 번 더 읽는다.
    let { md } = await readAnswer(svc.id);
    if (!md) ({ md } = await new Promise((r) => setTimeout(r, 600)).then(() => readAnswer(svc.id)));
    if (md) answers.push({ name: svc.name, text: md }); // 표·코드가 살아 있도록 Markdown으로 넘긴다
    else log('synth', 'skipped (no answer text)', svc.id);
  }
  if (!answers.length) return fail('종합할 다른 AI의 답변이 없습니다');

  const text = buildSynthPrompt({
    question: round.question,
    answers,
    judgeAnswered: round.targets.includes(judge),
  });
  const judgeName = SERVICES.find((s) => s.id === judge).name;
  sendSynthStatus({ state: 'sending', judge: judgeName, count: answers.length, cause });
  const historyId = round.historyId;
  const res = await sendToPanel(judge, text, async (state) => {
    if (state !== 'done') return;
    history.addSynth(historyId, { judge: judgeName, at: Date.now(), ...(await readAnswer(judge)) });
  });
  if (!res.ok) return fail(`${judgeName}에 보내지 못했습니다: ${res.error}`);
  sendSynthStatus({ state: 'sent', judge: judgeName, count: answers.length, cause });
  return { ok: true, judge: judgeName, count: answers.length };

  function fail(error) {
    sendSynthStatus({ state: 'error', error, cause });
    return { ok: false, error };
  }
}

// 공통 입력창: 고른 패널들에 같은 질문을 동시에 보낸다.
ipcMain.handle('prompt:send', async (_e, { text, targets }) => {
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(targets)) return [];
  const ids = targets.filter((id) => panels.has(id));
  const historyId = history.add({ question: text, targets: ids });
  const r = (round = { question: text, targets: ids, finished: new Map(), synthDone: false, historyId });
  return Promise.all(ids.map((id) => sendToPanel(id, text, (state) => onRoundAnswer(r, id, state))));
});

ipcMain.handle('synth:run', (_e, judgeId) => runSynth(typeof judgeId === 'string' ? judgeId : null));

ipcMain.on('settings:set', (_e, { answerTimeoutMin }) => {
  if (TIMEOUT_CHOICES.includes(answerTimeoutMin)) prefs.answerTimeoutMin = answerTimeoutMin;
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
  const ids = id === '*' ? SERVICES.map((s) => s.id).filter((x) => panels.has(x)) : [id].filter((x) => panels.has(x));
  const parts = [];
  for (const pid of ids) {
    const svc = SERVICES.find((s) => s.id === pid);
    const { md } = await readAnswer(pid);
    if (md) parts.push(id === '*' ? `## ${svc.name}\n\n${md}` : md);
  }
  if (parts.length) clipboard.writeText(parts.join('\n\n---\n\n'));
  return { copied: parts.length, total: ids.length };
});

ipcMain.on('view:set', (_e, value) => {
  if (mode === 'chat' && ['panels', 'compare', 'history', 'help'].includes(value)) {
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
ipcMain.handle('answers:get', async () => {
  const answers = [];
  for (const svc of SERVICES) {
    if (!panels.has(svc.id)) continue;
    answers.push({ id: svc.id, name: svc.name, color: svc.color, ...(await readAnswer(svc.id)) });
  }
  return { question: round?.question || '', answers };
});

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
      p.watchToken = (p.watchToken || 0) + 1;
      sendPanel(pid, { answer: 'clear' });
      wc.loadURL(SERVICES.find((s) => s.id === pid).newChatUrl);
    }
  }
});

// ---------- 단축키 ----------

ipcMain.handle('shortcuts:list', () => SHORTCUTS.map(({ keys, label }) => ({ keys, label })));

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
    setupSession();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
