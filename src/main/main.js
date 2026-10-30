'use strict';

// ============================================================================
// Windows 앱의 "본체(메인 프로세스)" 파일입니다.
//
// [이 파일이 하는 일 — 쉽게 말하면]
// 앱을 켜면 가장 먼저 실행되는 곳으로, 건물의 "관리실" 같은 역할을 합니다.
//   - 앱 창(window)을 만들고, 그 안에 AI 서비스 화면(ChatGPT·Gemini 등)을 "패널"로 붙입니다.
//   - 화면(index.html, renderer)이 "이거 해 줘"라고 요청하면(IPC라고 부릅니다) 받아서 처리합니다.
//     예: 질문 보내기, 배치 바꾸기, 프로젝트 파일 읽기·쓰기, 기록 저장, 복사 등
//   - 설정(prefs.json)을 저장하고 불러옵니다.
//
// [용어 풀이]
//   - 메인 프로세스: 앱의 뒤편에서 돌아가는 프로그램. 파일·창·네트워크처럼 강한 권한을 가집니다.
//   - 화면(렌더러): 사용자가 보는 버튼·입력창. 보안 때문에 권한이 약하고, 필요한 일은 메인에 부탁합니다.
//   - IPC: 화면과 메인이 서로 메시지를 주고받는 통로 (ipcMain.on / ipcMain.handle).
//   - 패널(WebContentsView): AI 서비스 웹페이지 하나를 보여 주는 "작은 브라우저 창".
//     앱 화면 "위에" 따로 얹히는 창이라, 앱 화면의 어떤 요소도 패널 위로 올라갈 수 없습니다.
//     그래서 다른 화면(비교·변경 제안·창 띄우기 등)을 보일 때는 패널을 화면 밖으로 치웁니다(pushState).
// ============================================================================

// ---------- 필요한 도구(모듈) 불러오기 ----------
// require는 다른 파일이나 라이브러리의 기능을 가져오는 명령입니다.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');
const { SERVICES, MAX_SELECTED, DEFAULT_SELECTED, ATTACH_LIMITS, normalizeSelected, uploadOf } = require('../shared/services');
const { LAYOUTS, normalizeLayout, placeCells } = require('../shared/layout');
const { normalizeLibrary } = require('../shared/prompt-lib');
const autologin = require('./autologin');
const { sendPrompt, cleanupTemp } = require('./injector');
const { snapshot, watchAnswer } = require('./watcher');
const { dev, log } = require('./dev');
const { createRounds } = require('../shared/rounds');
const history = require('./history');
const remote = require('./remote');
const { shortcutList, shortcutFor } = require('../shared/shortcuts');
const project = require('./project');
const { setupGitConsole } = require('./gitconsole');

// ---------- 화면 크기 관련 숫자 (단위: 픽셀) ----------
// 패널을 어디에 얼마나 크게 놓을지 계산할 때 씁니다. styles.css의 크기와 맞아야 화면이 어긋나지 않습니다.
const HEADER_H = 28; // 패널마다 이름·상태를 그리는 머리줄 높이
const BAR_H = 34; // 프로젝트 모드: 답변에 수정안이 있으면 패널 아래에 띄우는 변경 바 높이 (styles.css와 같게)
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

// 앱 전체에 적용하는 기본 설정:
//   - 사이트에는 우리가 "일반 크롬 브라우저"라고 알립니다 (위 CHROME_UA).
//   - MLA_PROFILE 개발 옵션이 있으면 설정·로그인 정보를 다른 폴더에 저장합니다 (시험용).
//   - "자동화 도구로 조종 중" 표시를 꺼서 일부 사이트가 막지 않게 합니다.
app.userAgentFallback = CHROME_UA;
if (dev.profile) app.setPath('userData', dev.profile);
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ---------- 앱이 지금 어떤 상태인지 기억하는 변수들 ----------
// let은 "나중에 값이 바뀔 수 있는 상자", const는 "한 번 정하면 안 바뀌는 상자"입니다.
// win: 앱 창 하나. 아직 안 만들었으면 null(비어 있음).
// mode: 지금 보이는 큰 화면 — 로그인 / 모델 고르기 / 채팅
let win = null;
let mode = 'login'; // 'login' | 'pick' | 'chat'
let chatView = 'panels'; // 채팅 화면 안에서: 'panels' (웹 패널) | 'dialog' (패널 위에 띄운 창 — 패널을 화면 밖으로 치움) | 'compare' (답변 비교) | 'changes' (변경 제안) | 'editor' (프로젝트 파일 편집) | 'git' (git 콘솔) | 'library' (라이브러리) | 'vars' (변수 입력) | 'compress' (스킬 AI 압축) | 'history' (기록) | 'help' (설정·단축키)
let sidebarOpen = false; // 프로젝트 사이드바가 열려 있으면 패널을 오른쪽으로 민다
let gitConsole = null; // git 콘솔 (gitconsole.js)
let focusId = null; // 크게 보는 패널 (⤢). 나머지 패널은 크기를 그대로 둔 채 화면 밖으로 옮긴다
const barIds = new Set(); // 변경 바를 띄운 패널 — 웹페이지 아래쪽을 바 높이만큼 비운다
let loginView = null;
const panels = new Map(); // id -> { view, login }  (지금 열려 있는 서비스 패널)

// ---------- 설정 저장 ----------

// 사용자가 고른 값(선택한 AI, 배치, 종합 담당 등)을 이 PC의 앱 데이터 폴더에 JSON 파일로 저장합니다.
// 앱을 껐다 켜도 같은 설정으로 시작하기 위해서입니다.
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
const libraryFile = () => path.join(app.getPath('userData'), 'library.json'); // 프롬프트 라이브러리·스킬
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

/**
 * 저장해 둔 설정 파일을 읽어 prefs에 덮어씁니다.
 * 파일이 없거나 깨졌으면 그냥 기본값을 씁니다 (catch에서 조용히 넘어감).
 * 예전 버전 설정(없어진 서비스 등)이 남아 있어도 지금 목록에 맞게 고칩니다.
 */
function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch {}
  // 예전 설정(Groq 등 없어진 서비스, 4개 넘는 선택)을 지금 서비스 목록에 맞춘다.
  prefs.selected = normalizeSelected(prefs.selected);
  prefs.layout = normalizeLayout(prefs.layout);
  if (!SERVICES.some((s) => s.id === prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
}

/** 지금 설정(prefs)을 파일에 씁니다. 실패해도 앱은 계속 돌아가고, 터미널에 이유만 남깁니다. */
function savePrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch (err) {
    console.error('[prefs] 설정을 저장하지 못했습니다:', err.message);
  }
}

// ---------- 세션 ----------

// 세션 = 쿠키·로그인 정보가 저장되는 "지갑". 모든 패널이 같은 지갑을 써서 Google 로그인을 같이 씁니다.
const ses = () => session.fromPartition(PARTITION);

/**
 * 세션(지갑)의 기본 규칙을 정합니다.
 *   - 사이트가 요청하는 권한(카메라·위치 등)은 "복사"와 "전체 화면"만 허락하고 나머지는 거절합니다.
 *   - Google 로그인 페이지에는 Firefox인 척하는 정보를 보내 "안전하지 않은 브라우저" 차단을 피합니다.
 */
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

/** Google에 로그인돼 있는지: 로그인하면 생기는 쿠키(SID 등)가 있는지 봅니다. async = 결과를 기다려야 하는 함수 */
async function isGoogleLoggedIn() {
  const cookies = await ses().cookies.get({ domain: 'google.com' });
  return cookies.some((c) => c.name === 'SID' || c.name === '__Secure-1PSID');
}

// ---------- 뷰 ----------

/**
 * AI 서비스 페이지를 띄울 "작은 브라우저 창(패널)"을 하나 만듭니다.
 * 보안 설정: 페이지가 컴퓨터 파일 등에 손대지 못하게 격리(sandbox)합니다.
 * 페이지가 새 창을 열려고 하면: 로그인 팝업만 앱 안에서 열고, 나머지 링크는 기본 브라우저로 보냅니다.
 */
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

/** 패널 하나를 창에서 떼어 내고 완전히 닫습니다 (메모리 정리). */
function destroyView(view) {
  if (!view) return;
  win?.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

/** 패널의 상태(불러오는 중, 답변 중, 답변 완료 등)를 화면에 알립니다. 화면은 이걸 받아 머리줄 글자를 바꿉니다. */
function sendPanel(id, patch) {
  if (win && !win.isDestroyed()) win.webContents.send('panel:status', { id, ...patch });
}

/**
 * 서비스 하나(svc)의 패널을 새로 열고, 페이지가 움직일 때마다(불러오기 시작·끝, 주소 이동, 실패) 화면에 알립니다.
 * 자동 로그인 도우미(autologin)도 여기서 붙입니다.
 */
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

/**
 * "Google 로그인" 화면으로 바꿉니다. 열린 패널은 모두 닫고, Google 로그인 페이지를 크게 띄웁니다.
 * 로그인이 끝났는지는 페이지 주소가 아니라 "로그인 쿠키가 생겼는지"로 알아챕니다.
 */
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

/** "모델 고르기" 화면으로 바꿉니다. 열린 패널은 닫지 않고 화면에서만 빼 둡니다 (대화 유지). */
function showPick() {
  destroyView(loginView);
  loginView = null;
  mode = 'pick';
  // 열린 패널은 살려 두되 화면에서만 뺀다. 다시 열면 대화가 그대로 남아 있다.
  for (const { view } of panels.values()) win.contentView.removeChildView(view);
  pushState();
}

/**
 * "채팅" 화면으로 바꿉니다. selected = 사용자가 고른 서비스 id 목록 (최대 6개).
 * 고르지 않은 패널은 닫고, 새로 고른 패널은 열고, 이미 있던 패널은 그대로 다시 붙입니다.
 */
function showChat(selected) {
  const ids = SERVICES.map((s) => s.id).filter((id) => selected.includes(id)).slice(0, MAX_SELECTED);
  if (!ids.length) return;
  prefs.selected = ids;
  savePrefs();

  for (const [id, p] of panels) {
    if (!ids.includes(id)) {
      destroyView(p.view);
      panels.delete(id);
      barIds.delete(id);
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

/** 로그아웃: 모든 패널을 닫고 쿠키·캐시(로그인 정보)를 지운 뒤 로그인 화면으로 돌아갑니다. 질문·답변 기록은 남습니다. */
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

/**
 * 지금 창 크기와 고른 배치(격자·가로·큰 칸·2열)에 맞춰 패널마다 위치·크기(사각형)를 계산합니다.
 * 결과의 frame은 머리줄을 포함한 칸 전체, content는 머리줄 아래 실제 웹페이지가 들어갈 자리입니다.
 */
function computeRects() {
  const [w, h] = win.getContentSize();
  const side = mode === 'chat' && sidebarOpen ? SIDEBAR_W : 0;
  const area = { x: side, y: TOOLBAR_H, width: w - side, height: h - TOOLBAR_H };
  if (mode === 'login') return { login: area, panels: [] };
  if (mode !== 'chat') return { panels: [] };

  const ids = SERVICES.map((s) => s.id).filter((id) => panels.has(id));
  if (focusId && !ids.includes(focusId)) focusId = null;
  const box = { ...area, height: area.height - COMPOSER_H };
  const cells = placeCells(prefs.layout, ids.length, box, GAP);
  const [big] = placeCells('grid', 1, box, GAP);

  return {
    panels: ids.map((id, i) => {
      // 크게 보기: 고른 패널은 영역 전체, 나머지는 원래 크기로 숨겨 둔다 (답변 감시는 계속)
      const frame = focusId === id ? big : cells[i];
      const hidden = !!focusId && focusId !== id;
      const bar = barIds.has(id) ? BAR_H : 0;
      return {
        id,
        frame,
        hidden,
        focused: focusId === id,
        bar: !!bar,
        content: { x: frame.x, y: frame.y + HEADER_H, width: frame.width, height: Math.max(0, frame.height - HEADER_H - bar) },
      };
    }),
  };
}

/**
 * "지금 상태"를 화면에 보내고 패널 위치를 맞추는 핵심 함수입니다. 무언가 바뀔 때마다 부릅니다.
 * 패널 화면('panels')이 아니면 패널을 x = -20000(화면 왼쪽 바깥)으로 치웁니다.
 *   → 패널은 앱 화면 위에 얹힌 창이라, 치우지 않으면 비교·변경 제안·창('dialog') 같은 앱 화면을 가려 버립니다.
 */
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
    panels.get(r.id)?.view.setBounds(showPanels && !r.hidden ? r.content : { ...r.content, x: -20000 });
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

/**
 * 앱 창을 만들고 index.html(앱 화면)을 띄웁니다.
 * 처음 화면은: 개발 옵션이 있으면 그 화면, Google에 로그인돼 있으면 모델 고르기, 아니면 로그인 화면.
 * 창 크기가 바뀌거나 최소화에서 돌아오면 패널 배치를 다시 계산합니다.
 */
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

  // 메인 창은 앱 화면(index.html)만 띄운다. preload의 host(프로젝트 폴더 읽기·쓰기 등)가 다른 페이지에 붙지 않도록
  // 화면 쪽에서 시작한 이동(링크 끌어다 놓기 등)과 새 창 열기를 모두 막는다. 앱이 직접 여는 loadFile은 영향이 없다.
  win.webContents.on('will-navigate', (e, url) => {
    log('nav', 'main window navigation blocked', String(url).slice(0, 160));
    e.preventDefault();
  });
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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

// ---------- 화면이 보내는 요청 받기 (IPC) ----------
// ipcMain.on('이름', ...)      : 화면이 "이것 좀 해" 하고 보내면 처리만 합니다 (답을 돌려주지 않음).
// ipcMain.handle('이름', ...)  : 처리한 뒤 결과를 화면에 돌려줍니다.
// 화면에서 온 값은 믿지 않고 모양(문자열인지, 목록인지 등)을 먼저 확인합니다. 보안을 위해서입니다.
ipcMain.on('models:open', (_e, selected) => {
  if (Array.isArray(selected)) showChat(selected.filter((id) => typeof id === 'string'));
});
ipcMain.on('models:pick', () => mode === 'chat' && showPick());
ipcMain.on('logout', () => logout());

ipcMain.on('layout:set', (_e, value) => {
  if (LAYOUTS.includes(value)) {
    prefs.layout = value;
    focusId = null;
    savePrefs();
    pushState();
  }
});

// 프로젝트 모드의 변경 바를 띄우거나 내릴 때: 그 패널의 웹페이지 높이를 바만큼 줄이거나 되돌린다
ipcMain.on('layout:bar', (_e, { id, on } = {}) => {
  if (typeof id !== 'string') return;
  if (on && panels.has(id)) barIds.add(id);
  else barIds.delete(id);
  pushState();
});

// 패널 하나 크게 보기 / 돌아오기 (id가 null이거나 이미 크게 보는 패널이면 돌아온다)
ipcMain.on('layout:focus', (_e, id) => {
  focusId = typeof id === 'string' && panels.has(id) && focusId !== id ? id : null;
  pushState();
});

// ---------- 질문 보내기 · 교차검토(종합) ----------

/** 종합(다른 AI 답변을 모아 한 AI에게 정리 요청) 진행 상태를 화면에 알립니다. */
function sendSynthStatus(patch) {
  if (win && !win.isDestroyed()) win.webContents.send('synth:status', patch);
}

// 질문 보내기·답변 감시·종합은 크롬 확장 프로그램과 같이 쓰는 shared/rounds.js가 한다.
// rounds = 질문 보내기·답변 기다리기·종합을 맡는 공통 부품입니다 (src/shared/rounds.js).
// 크롬 확장 프로그램과 같은 코드를 쓰기 때문에, "패널을 다루는 방법"만 Windows 앱 식으로 넘겨줍니다.
const rounds = createRounds({
  services: SERVICES,
  hasPanel: (id) => panels.has(id),
  sendPrompt: (id, text, files, extra) =>
    panels.has(id)
      ? sendPrompt(panels.get(id).view.webContents, SERVICES.find((s) => s.id === id), text, files, extra)
      : { ok: false, error: '패널이 닫혔습니다' },
  snapshot: (id, opts) =>
    panels.has(id) ? snapshot(panels.get(id).view.webContents, SERVICES.find((s) => s.id === id), opts) : null,
  watch: (id, before, isCurrent, onState) => {
    if (dev.drySend) return;
    const opts = {
      maxMs: dev.answerTimeoutMs || prefs.answerTimeoutMin * 60 * 1000,
      startMs: dev.answerStartMs || undefined,
    };
    const p = panels.get(id);
    if (!p) return; // 보내는 사이 패널을 닫았다
    watchAnswer(p.view.webContents, SERVICES.find((s) => s.id === id), before, isCurrent, onState, opts);
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

/** 화면이 넘긴 보내기 옵션 검사: { question, textById, prefixById, fallbackText, plainIds, userFileCount } */
// 화면이 같이 보낸 "보내기 옵션"에서 아는 항목만 골라 길이를 잘라 둡니다 (엉뚱하거나 너무 큰 값을 막음).
function sendOpts(opts) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {};
  if (typeof opts.question === 'string') out.question = opts.question.slice(0, 20000);
  if (typeof opts.fallbackText === 'string') out.fallbackText = opts.fallbackText.slice(0, 200000);
  if (opts.textById && typeof opts.textById === 'object') {
    out.textById = {};
    for (const s of SERVICES) if (typeof opts.textById[s.id] === 'string') out.textById[s.id] = opts.textById[s.id];
  }
  if (opts.prefixById && typeof opts.prefixById === 'object') {
    out.prefixById = {};
    for (const s of SERVICES) if (typeof opts.prefixById[s.id] === 'string') out.prefixById[s.id] = opts.prefixById[s.id].slice(0, 25000);
  }
  if (Array.isArray(opts.plainIds)) out.plainIds = SERVICES.map((s) => s.id).filter((id) => opts.plainIds.includes(id));
  if (Number.isInteger(opts.userFileCount) && opts.userFileCount >= 0) out.userFileCount = opts.userFileCount;
  if (opts.noHistory === true) out.noHistory = true;
  return out;
}

// 패널 하나에만 이어서 보내기 (프로젝트 모드: 요청한 파일 보내기, 전체 파일 다시 요청)
ipcMain.handle('prompt:followup', async (_e, { id, text, files, opts }) => {
  if (typeof id !== 'string' || typeof text !== 'string' || !text.trim()) return { ok: false, error: '보낼 내용이 없습니다' };
  const checked = checkFiles(files);
  if (!checked) return { id, ok: false, error: '첨부 파일이 한도를 넘었습니다' };
  return rounds.sendFollowUp(id, text, checked, sendOpts(opts));
});

// ---------- 프로젝트 모드 (로컬 폴더 읽기·쓰기는 project.js, 처리는 화면 쪽 공통 모듈) ----------

// 프로젝트 사이드바가 열리고 닫힐 때: 패널 자리를 사이드바 폭만큼 비우거나 되돌립니다.
ipcMain.on('layout:sidebar', (_e, open) => {
  sidebarOpen = !!open;
  pushState();
});

/** 마지막으로 연 프로젝트 폴더를 설정에 기억합니다 (다음에 앱을 켜면 자동으로 다시 열기 위해). */
async function rememberProject(p) {
  prefs.projectRoot = p ? p.id : null;
  savePrefs();
  return p;
}

// 프로젝트 관련 요청을 감싸는 도우미: 성공하면 { ok: true, value }, 오류가 나면 { ok: false, error }로 돌려줍니다.
// 이렇게 하면 오류가 나도 앱이 멈추지 않고, 화면이 이유를 보여 줄 수 있습니다.
const projectCall = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

ipcMain.handle('project:pick', projectCall(async () => {
  const picked = await project.pick(win);
  if (picked) gitConsole?.stop();
  return rememberProject(picked);
}));
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
  gitConsole?.stop(); // 실행 중인 git 명령은 그 폴더와 함께 멈춘다
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

// 설정 화면(?)에서 바꾼 값 저장: 답변 최대 대기 시간, 사이트 셀렉터 자동 갱신 켜기/끄기
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

// 종합 담당 AI와 "완료 후 자동 종합" 켜기/끄기 저장
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

// 채팅 안의 화면 바꾸기 (패널 / 창 띄우기 / 비교 / 변경 제안 / 편집기 …). 목록에 있는 이름만 받습니다.
ipcMain.on('view:set', (_e, value) => {
  if (mode === 'chat' && ['panels', 'dialog', 'compare', 'changes', 'editor', 'git', 'library', 'vars', 'compress', 'history', 'help'].includes(value)) {
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
// 패널 하나의 최신 답변 (답변이 끝난 패널만 읽을 때: 파일 모아보기 버튼, NEED_FILES 확인)
ipcMain.handle('answer:get', (_e, id) => (typeof id === 'string' ? rounds.answer(id) : null));

// 패널 머리줄 버튼: 새로고침 · 처음 주소 · 뒤로 · 개발자 도구 · 로그인 다시 시도 · 새 대화
// id가 '*'이면 열린 패널 전부에 같은 동작을 합니다 (모두 새 대화 등).
ipcMain.on('panel:action', (_e, { id, action }) => {
  const targets = id === '*' ? [...panels.entries()] : [[id, panels.get(id)]].filter(([, p]) => p);
  for (const [pid, p] of targets) {
    const wc = p.view.webContents;
    if (action === 'reload') wc.reload();
    else if (action === 'home') {
      // 처음 주소는 새 대화로 열린다: 답변 감시를 멈추고, 화면에도 새 대화라고 알린다 (스킬·프로젝트 파일을 다시 보내게)
      rounds.cancelWatch(pid);
      sendPanel(pid, { answer: 'clear' });
      wc.loadURL(SERVICES.find((s) => s.id === pid).url);
    }
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

// 서비스 사이트의 화면 구조가 바뀌면 입력창·답변을 못 찾게 됩니다.
// 그래서 6시간마다 GitHub의 remote/selectors.json(찾는 위치 목록)을 받아 고친 값으로 바꿔 씁니다.
const REMOTE_REFRESH_MS = 6 * 60 * 60 * 1000;

/** 원격 셀렉터를 한 번 받아 옵니다. 설정에서 꺼 두었으면 아무것도 하지 않습니다. */
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

// 프롬프트 라이브러리·스킬: 모양을 검사하고 길이를 잘라서 이 PC에만 저장한다 (shared/prompt-lib.js)
ipcMain.handle('library:load', () => {
  try {
    return normalizeLibrary(JSON.parse(fs.readFileSync(libraryFile(), 'utf8')));
  } catch {
    return normalizeLibrary({});
  }
});
ipcMain.handle('library:save', (_e, data) => {
  try {
    fs.writeFileSync(libraryFile(), JSON.stringify(normalizeLibrary(data), null, 2));
    return true;
  } catch (err) {
    console.error('[library] 저장하지 못했습니다:', err.message);
    return false;
  }
});

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
// 앱 창이든 AI 패널이든, 키보드를 누를 때마다 단축키인지 먼저 확인합니다.
// 단축키면 처리하고, 그 키가 페이지로 넘어가지 않게 막습니다 (preventDefault).
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.alt)) log('key', input.key, input.code, input.control ? 'ctrl' : 'alt');
    const action = shortcutFor(input, { canEscape: mode === 'chat' && chatView !== 'panels' });
    if (action && runShortcut(action)) event.preventDefault();
  });
});

// 창 위쪽의 기본 메뉴(파일·편집…)는 쓰지 않으므로 없앱니다.
Menu.setApplicationMenu(null);

// ---------- 앱 시작 ----------
// 앱은 한 번에 하나만 켜지게 합니다. 이미 켜져 있으면 새로 켠 것은 끄고, 기존 창을 앞으로 가져옵니다.
// 준비가 끝나면(whenReady): 임시 파일 정리 → 설정 읽기 → 기록·원격 셀렉터 준비 → 세션 설정 → 창 만들기 → git 콘솔 준비
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    cleanupTemp(); // 지난번에 남은 첨부 임시 파일
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
    gitConsole = setupGitConsole({ ipcMain, getWin: () => win, getRoot: () => project.info()?.id || null });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    cleanupTemp();
    gitConsole?.stop();
  });
}
