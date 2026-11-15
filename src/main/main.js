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
const path = require('path');
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, clipboard, dialog, net, Notification } = require('electron');
const { SERVICES, MAX_SELECTED, DEFAULT_SELECTED, ATTACH_LIMITS, normalizeSelected, uploadOf, fileBytesOf, isAuthPopupUrl, isServiceUrl, limitTextOf } = require('../shared/services');
const { LAYOUTS, normalizeLayout, placeCells, barRows } = require('../shared/layout');
const autologin = require('./autologin');
const { sendPrompt, cleanupTemp } = require('./injector');
const { snapshot, watchAnswer } = require('./watcher');
const { dev, log } = require('./dev');
const { createRounds } = require('../shared/rounds');
const { createDiag } = require('../shared/diag');
const L = require('../shared/local-llm');
const watchCore = require('../shared/watch');
const { pageProbe, pageLimitCheck } = require('../shared/page');
const history = require('./history');
const { normalizeMax, MAX_CHOICES } = require('../shared/history-core');
const remote = require('./remote');
const { shortcutList, shortcutFor } = require('../shared/shortcuts');
const project = require('./project');
const guard = require('./ipc-guard'); // 화면이 넘긴 값 다시 검사 (첨부 파일 · 읽기 옵션 · 로컬 LLM 주소)
const { setupGitConsole } = require('./gitconsole');
const { setupDevTest } = require('./devtest');
const { setupGitCommit } = require('./gitcommit');
const { createUpdater } = require('./updater');
const secure = require('./secure-store'); // 기록 · 설정 · 라이브러리 · 프로젝트 상태 암호화 (v0.22.1)
const notifyCore = require('../shared/notify');
const { createOsNotifier } = require('./notifier'); // OS 알림 (v0.25.0)

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
// 로그인 팝업으로 앱 안에서 열어도 되는 주소는 shared/services.js의 isAuthPopupUrl이 정한다
// (공용 로그인 도메인 + 그 서비스의 authHosts + 서비스 자기 도메인, 호스트가 정확히 같을 때만).

// 앱 전체에 적용하는 기본 설정:
//   - 사이트에는 우리가 "일반 크롬 브라우저"라고 알립니다 (위 CHROME_UA).
//   - MLA_PROFILE 개발 옵션이 있으면 설정·로그인 정보를 다른 폴더에 저장합니다 (시험용).
//   - "자동화 도구로 조종 중" 표시를 꺼서 일부 사이트가 막지 않게 합니다.
app.userAgentFallback = CHROME_UA;
if (dev.profile) app.setPath('userData', dev.profile);
// Windows 알림(v0.25.0)은 설치 프로그램이 만든 바로가기와 같은 앱 id여야 뜬다 (electron-builder appId). 개발 실행은 Electron 기본값 그대로.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('com.dyj02056.multitudellm');
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
let devTest = null; // 미리보기 창의 테스트 실행 (devtest.js)
let focusId = null; // 크게 보는 패널 (⤢). 나머지 패널은 크기를 그대로 둔 채 화면 밖으로 옮긴다
const barIds = new Map(); // 패널 id -> 아래 바 줄 수 (1~2, v0.28.0) — 웹페이지 아래쪽을 바 높이 × 줄 수만큼 비운다
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
  local: { enabled: false, baseUrl: L.DEFAULT_BASE, model: '', contextTokens: L.DEFAULT_CONTEXT }, // 로컬 LLM 패널 (선택 기능, v0.16.0 · 컨텍스트 한도 v0.29.0)
  autoUpdate: true, // 새 버전 자동 확인 (알리기만, v0.20.0)
  historyMax: 500, // 기록 최대 개수 (v0.24.0, 100 · 500 · 1000 · 2000)
  notify: { ...notifyCore.DEFAULT_PREFS }, // OS 알림 종류별 켜기 (v0.25.0, 기본 모두 켬)
  sendPreview: false, // 보내기 전 미리보기 (v0.25.0, 기본 끔)
  retryOnce: true, // 보내기 실패면 잠깐 뒤 한 번 다시 보내기 (v0.26.0, 기본 켬)
  commitOffer: true, // 적용 후 커밋 제안 (v0.28.0, 기본 켬): 적용이 끝나면 [커밋하기]를 보여 준다 (누를 때만 커밋)
  autoRecommend: false, // 추천 조합 제안 (v0.27.0, 기본 끔): 질문 종류의 추천 조합이 지금 대상과 다르면 [추천 조합으로 바꾸기]만 띄운다
};

/**
 * 저장해 둔 설정 파일을 읽어 prefs에 덮어씁니다.
 * 파일이 없거나 깨졌으면 그냥 기본값을 씁니다 (catch에서 조용히 넘어감).
 * 예전 버전 설정(없어진 서비스 등)이 남아 있어도 지금 목록에 맞게 고칩니다.
 */
function loadPrefs() {
  const saved = secure.store().readJson(prefsFile(), null);
  if (saved && typeof saved === 'object') prefs = { ...prefs, ...saved };
  // 예전 설정(Groq 등 없어진 서비스, 4개 넘는 선택)을 지금 서비스 목록에 맞춘다.
  prefs.local = normalizeLocalPrefs(prefs.local);
  const hadLocal = Array.isArray(prefs.selected) && prefs.selected.includes(L.LOCAL_ID);
  prefs.selected = normalizeSelected(prefs.selected);
  // 로컬 LLM은 웹 서비스 목록(SERVICES) 밖이라 normalizeSelected가 뺀다 — 켜 둔 동안은 다시 넣는다
  if (hadLocal && prefs.local.enabled && prefs.selected.length < MAX_SELECTED) prefs.selected.push(L.LOCAL_ID);
  prefs.layout = normalizeLayout(prefs.layout);
  if (!allServices().some((s) => s.id === prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
  prefs.historyMax = normalizeMax(prefs.historyMax);
  prefs.notify = notifyCore.normalizePrefs(prefs.notify);
  prefs.sendPreview = prefs.sendPreview === true;
  prefs.retryOnce = prefs.retryOnce !== false;
  prefs.autoRecommend = prefs.autoRecommend === true;
  prefs.commitOffer = prefs.commitOffer !== false;
}

// ---------- 로컬 LLM (v0.16.0, 선택 기능) ----------
// 웹 서비스 목록(SERVICES)과 따로 둔다: 켜 두었을 때만 모델 목록 · 패널 · 종합 대상에 "로컬 LLM"이 붙는다.
// 패널은 웹페이지가 아니라 앱이 대화를 들고 이 PC의 OpenAI 호환 서버(localhost만)에 묻는다 (shared/local-llm.js).
function normalizeLocalPrefs(v) {
  const o = v && typeof v === 'object' ? v : {};
  return { enabled: o.enabled === true, baseUrl: L.normalizeBaseUrl(o.baseUrl) || L.DEFAULT_BASE, model: L.cleanModel(o.model), contextTokens: L.normalizeContext(o.contextTokens) };
}
/** 패널 없이 로컬 LLM에 한 번 묻기 (v0.29.0, 판정 · 압축): 패널 대화와 따로인 임시 대화 — 켜 두었을 때만 */
function askLocal(text) {
  if (!prefs.local?.enabled) return Promise.resolve({ ok: false, error: '로컬 LLM이 꺼져 있습니다 (설정 › 로컬 LLM)' });
  return L.askOnce({ fetchFn: (url, opts) => net.fetch(url, opts), getConfig: () => prefs.local, text });
}
const localSvc = () => L.localService(prefs.local);
/** 지금 쓸 수 있는 서비스 전체: 웹 서비스 + (켰으면) 로컬 LLM */
const allServices = () => (prefs.local?.enabled ? [...SERVICES, localSvc()] : SERVICES);
const svcById = (id) => allServices().find((s) => s.id === id);
let localChat = null; // 로컬 LLM 대화 (패널이 열려 있을 때만)
const isLocal = (id) => id === L.LOCAL_ID;
const hasPanelId = (id) => (isLocal(id) ? !!localChat : panels.has(id));

function openLocalPanel() {
  if (localChat) return;
  localChat = L.createLocalChat({
    fetchFn: (url, opts) => net.fetch(url, opts),
    getConfig: () => prefs.local,
    onUpdate: (view) => sendPanel(L.LOCAL_ID, { local: view }),
  });
  sendPanel(L.LOCAL_ID, { login: 'ready', local: localChat.view() });
}
function closeLocalPanel() {
  localChat?.stop();
  localChat = null;
  rounds.resetPanel(L.LOCAL_ID); // 대화 줄기 (v0.27.0): 닫은 패널은 지난 대화를 잇지 않는다
}

// 설정 · 라이브러리 저장: 0.3초 모았다가 비동기로 쓴다 (v0.23). 앱을 끌 때 will-quit에서 flush()로 동기로 마저 쓴다.
const prefsSaver = history.createSecureSaver({
  file: prefsFile,
  writeSync: () => secure.store().writeJson(prefsFile(), prefs),
  onError: (err) => console.error('[prefs] 설정을 저장하지 못했습니다:', err.message),
});
const librarySaver = history.createSecureSaver({
  file: libraryFile,
  writeSync: (data) => secure.store().writeJson(libraryFile(), data),
  onError: (err) => console.error('[library] 저장하지 못했습니다:', err.message),
});

/** 지금 설정(prefs)을 저장하도록 예약합니다. 실패해도 앱은 계속 돌아가고, 터미널에 이유만 남깁니다. */
function savePrefs() {
  prefsSaver.save(prefs);
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

/** 허용 밖 주소는 앱 안에서 열지 않고 기본 브라우저로 보냅니다 (http/https만). */
function openOutside(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

/**
 * 웹 내용(패널·로그인 팝업)이 새 창을 열려고 할 때의 규칙을 붙입니다.
 *   - 로그인 팝업(허용 목록의 호스트와 정확히 같은 https 주소, 또는 곧 이동할 about:blank)만 같은 세션의 자식 창으로 엽니다.
 *   - 나머지 링크는 기본 브라우저로 엽니다.
 * 열린 팝업 안에서 다른 주소로 이동(링크·스크립트·리다이렉트)할 때도 같은 검사를 하고, 허용 밖이면 막고 기본 브라우저로 엽니다.
 * svc: 그 패널의 서비스 (없으면 공용 로그인 도메인만 허용)
 */
function guardPopups(wc, svc) {
  wc.setWindowOpenHandler(({ url }) => {
    log('popup', url.slice(0, 160));
    if (url === 'about:blank' || isAuthPopupUrl(svc, url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          parent: win,
          autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    const cwc = child.webContents;
    // e: Electron 이벤트(e.url · e.isMainFrame). 예전 방식의 두 번째 인자(url)도 받는다. 팝업 안 iframe 이동은 보지 않는다.
    const check = (e, url) => {
      url = e?.url || url;
      if (e?.isMainFrame === false || isAuthPopupUrl(svc, url)) return;
      log('popup', 'navigation blocked', String(url).slice(0, 160));
      e.preventDefault();
      openOutside(url);
      // 로그인 도중 허용 밖 주소(회사 SSO 등)로 가면 로그인이 끊기므로 패널에 알린다
      let host = '';
      try {
        host = new URL(url).host;
      } catch {}
      if (svc) sendPanel(svc.id, { notice: `로그인 창이 허용 밖 주소(${host || '알 수 없음'})로 가서 기본 브라우저로 열었습니다` });
    };
    cwc.on('will-navigate', (e, url) => check(e, url));
    cwc.on('will-redirect', (e, url) => check(e, url));
    guardPopups(cwc, svc); // 팝업이 또 여는 창에도 같은 규칙
  });
}

/**
 * AI 서비스 페이지를 띄울 "작은 브라우저 창(패널)"을 하나 만듭니다.
 * 보안 설정: 페이지가 컴퓨터 파일 등에 손대지 못하게 격리(sandbox)합니다.
 * 페이지가 새 창을 열려고 하면: 로그인 팝업만 앱 안에서 열고, 나머지 링크는 기본 브라우저로 보냅니다 (guardPopups).
 * svc: 이 패널의 서비스 (Google 로그인 화면이면 없음)
 */
function newView(svc = null) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 화면에 안 보이는 패널도 답변 스트리밍이 멈추지 않도록
    },
  });
  guardPopups(view.webContents, svc);
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
  const view = newView(svc);
  const wc = view.webContents;

  wc.on('did-start-loading', () => {
    loadFailed.delete(svc.id);
    sendPanel(svc.id, { loading: true });
  });
  wc.on('did-stop-loading', () => sendPanel(svc.id, { loading: false, url: wc.getURL() }));
  wc.on('did-navigate', (_e, url, code) => {
    log('nav', svc.id, code, url.slice(0, 160));
    sendPanel(svc.id, { url });
  });
  wc.on('did-redirect-navigation', (d) => d.isMainFrame && log('nav', svc.id, 'redirect', d.url.slice(0, 160)));
  wc.on('did-navigate-in-page', (_e, url) => sendPanel(svc.id, { url }));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    loadFailed.add(svc.id); // 오류 페이지에서는 셀렉터 자가진단을 하지 않는다 (입력창이 없는 게 당연하다)
    sendPanel(svc.id, { error: `${desc} (${code})`, url });
  });

  const login = autologin.attach(wc, svc, (state) => {
    sendPanel(svc.id, { login: state });
    if (state === 'ready') probePanel(svc.id); // 로그인된 화면에서 입력창이 보이는지 살펴본다 (셀렉터 자가진단)
  });
  win.contentView.addChildView(view);
  wc.loadURL(svc.url);
  panels.set(svc.id, { view, login });
}

// ---------- 셀렉터 자가진단 ----------
// 패널마다 입력창 · 보내기 버튼 · 답변 영역을 찾았는지 기록한다 (shared/diag.js). 바뀌면 그 패널 머리줄에 알린다.
const diag = createDiag({ onChange: (id, st) => sendPanel(id, { diag: st }) });
const PROBE_GAP_MS = 30 * 1000; // 같은 패널을 이보다 자주 살펴보지 않는다 (로그인 확인은 대화 중에도 반복된다)
const lastProbe = new Map();
const loadFailed = new Set(); // 페이지 불러오기에 실패한 패널 (네트워크 오류 · 오프라인) — 다시 불러오기 시작하면 지운다

/** 로그인된 패널 페이지에서 입력창이 보이는지 살펴본다. 페이지가 다 그려지도록 잠깐 기다린 뒤 */
function probePanel(id) {
  const now = Date.now();
  if (now - (lastProbe.get(id) || 0) < PROBE_GAP_MS) return;
  lastProbe.set(id, now);
  setTimeout(async () => {
    const wc = panels.get(id)?.view.webContents;
    const svc = SERVICES.find((s) => s.id === id);
    if (!wc || wc.isDestroyed() || !svc || loadFailed.has(id) || !isServiceUrl(svc, wc.getURL())) return;
    try {
      diag.fromProbe(id, await wc.executeJavaScript(`(${pageProbe.toString()})(${JSON.stringify({ input: svc.input || [] })})`, true));
    } catch {} // 페이지가 바뀌는 중
  }, 2500);
}

// ---------- 화면 전환 ----------

/**
 * "Google 로그인" 화면으로 바꿉니다. 열린 패널은 모두 닫고, Google 로그인 페이지를 크게 띄웁니다.
 * 로그인이 끝났는지는 페이지 주소가 아니라 "로그인 쿠키가 생겼는지"로 알아챕니다.
 */
function showLogin() {
  for (const { view } of panels.values()) destroyView(view);
  panels.clear();
  rounds.resetPanel('*');
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
  const ids = allServices().map((s) => s.id).filter((id) => selected.includes(id)).slice(0, MAX_SELECTED);
  if (!ids.length) return;
  prefs.selected = ids;
  savePrefs();

  for (const [id, p] of panels) {
    if (!ids.includes(id)) {
      destroyView(p.view);
      panels.delete(id);
      barIds.delete(id);
      rounds.resetPanel(id);
    }
  }
  for (const svc of SERVICES) {
    if (!ids.includes(svc.id)) continue;
    const p = panels.get(svc.id);
    if (p) win.contentView.addChildView(p.view);
    else openPanel(svc);
  }
  if (ids.includes(L.LOCAL_ID)) openLocalPanel();
  else closeLocalPanel();
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
  rounds.resetPanel('*');
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

  const ids = allServices().map((s) => s.id).filter(hasPanelId);
  if (focusId && !ids.includes(focusId)) focusId = null;
  const box = { ...area, height: area.height - COMPOSER_H };
  const cells = placeCells(prefs.layout, ids.length, box, GAP);
  const [big] = placeCells('grid', 1, box, GAP);

  return {
    panels: ids.map((id, i) => {
      // 크게 보기: 고른 패널은 영역 전체, 나머지는 원래 크기로 숨겨 둔다 (답변 감시는 계속)
      const frame = focusId === id ? big : cells[i];
      const hidden = !!focusId && focusId !== id;
      const bar = (barIds.get(id) || 0) * BAR_H;
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
    historyMax: prefs.historyMax,
    historyMaxChoices: MAX_CHOICES,
    timeoutChoices: TIMEOUT_CHOICES,
    remoteSelectors: prefs.remoteSelectors,
    remote: remote.getStatus(),
    diag: diag.all(SERVICES.map((s) => s.id)),
    services: allServices().map((s) => ({ id: s.id, name: s.name, color: s.color, url: s.url, kind: s.kind || 'web', accept: uploadOf(s).accept, maxFileBytes: fileBytesOf(s) })),
    local: { ...prefs.local },
    autoUpdate: prefs.autoUpdate !== false,
    notify: { ...prefs.notify },
    sendPreview: prefs.sendPreview,
    retryOnce: prefs.retryOnce,
    autoRecommend: prefs.autoRecommend,
    commitOffer: prefs.commitOffer,
    update: updater?.status() || null,
    storage: { encrypted: secure.store().available() }, // 로컬 데이터 암호화 (v0.22.1)
    rects: rects.panels,
  });
}

// 창 크기를 끄는 동안 resize 이벤트가 1초에 수십~수백 번 온다. 그때마다 패널 배치와 상태 전송을 하면 화면이 버벅이므로
// 처음 한 번은 바로 하고, 그 뒤 약 30ms 동안 온 요청은 묶어서 마지막에 한 번만 한다.
const PUSH_THROTTLE_MS = 30;
let pushTimer = null;
let pushPending = false;
function schedulePushState() {
  if (pushTimer) {
    pushPending = true;
    return;
  }
  pushState();
  pushTimer = setTimeout(function flush() {
    if (pushPending) {
      pushPending = false;
      pushState();
      pushTimer = setTimeout(flush, PUSH_THROTTLE_MS);
    } else pushTimer = null;
  }, PUSH_THROTTLE_MS);
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

  // 창을 끄는 동안 resize가 아주 많이 오므로 상태 전송을 묶는다 (schedulePushState)
  win.on('resize', schedulePushState);
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

// 프로젝트 모드의 변경 바 · 제안 바를 띄우거나 내릴 때: 그 패널의 웹페이지 높이를 바 줄 수만큼 줄이거나 되돌린다.
// 두 바가 함께 뜨면 2줄을 쌓는다 (v0.28.0 — 예전에는 제안 바가 변경 바를 덮었다). rows가 없으면 예전 on(true/false)을 1줄로 본다.
ipcMain.on('layout:bar', (_e, { id, on, rows } = {}) => {
  if (typeof id !== 'string') return;
  const n = barRows(rows === undefined ? !!on : rows);
  if (n && panels.has(id)) barIds.set(id, n);
  else barIds.delete(id);
  pushState();
});

// 패널 하나 크게 보기 / 돌아오기 (id가 null이거나 이미 크게 보는 패널이면 돌아온다)
ipcMain.on('layout:focus', (_e, id) => {
  focusId = typeof id === 'string' && hasPanelId(id) && focusId !== id ? id : null;
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
// 답변 평가 (v0.23): 지금 라운드(공통 입력창으로 마지막에 보낸 질문)의 기록 id. rounds가 기록을 만들 때 받아 둔다.
let roundHistoryId = null;
const roundHistory = { ...history, add: (rec) => (roundHistoryId = history.add(rec)) };
// OS 알림 (v0.25.0): 앱 창을 보고 있지 않을 때 답변 완료 · 사용 한도 · 보내기 실패 · 종합 끝을 알린다 (main/notifier.js)
const notifier = createOsNotifier({
  Notification,
  getWin: () => win,
  prefs: () => prefs.notify,
  icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
  onClickView: (view) => {
    if (mode !== 'chat') return;
    chatView = view;
    pushState();
  },
  log,
});
const rounds = createRounds({
  get services() {
    return allServices(); // 로컬 LLM을 켜고 끌 때마다 바뀐다
  },
  hasPanel: hasPanelId,
  sendPrompt: (id, text, files, extra) => {
    if (isLocal(id)) {
      if (!localChat) return { ok: false, error: '패널이 닫혔습니다' };
      const images = files.map((f) => L.imageDataUrl(f, (d) => Buffer.from(d).toString('base64'))).filter(Boolean);
      return localChat.send(text, images);
    }
    return panels.has(id)
      ? sendPrompt(panels.get(id).view.webContents, SERVICES.find((s) => s.id === id), text, files, extra)
      : { ok: false, error: '패널이 닫혔습니다' };
  },
  snapshot: (id, opts) => {
    if (isLocal(id)) return localChat ? localChat.snapshot() : null;
    return panels.has(id) ? snapshot(panels.get(id).view.webContents, SERVICES.find((s) => s.id === id), opts) : null;
  },
  watch: (id, before, isCurrent, onState) => {
    if (dev.drySend) return;
    const opts = {
      maxMs: dev.answerTimeoutMs || prefs.answerTimeoutMin * 60 * 1000,
      startMs: dev.answerStartMs || undefined,
    };
    if (isLocal(id)) {
      // 로컬 LLM: 웹 패널과 같은 규칙으로, 앱이 들고 있는 대화의 "사진"을 지켜본다
      if (!localChat) return;
      const chat = localChat;
      watchCore.watchAnswer(async () => chat.snapshot(), before, () => isCurrent() && localChat === chat, onState, opts);
      return;
    }
    const p = panels.get(id);
    if (!p) return; // 보내는 사이 패널을 닫았다
    watchAnswer(p.view.webContents, SERVICES.find((s) => s.id === id), before, isCurrent, onState, opts);
  },
  sendPanel,
  sendSynthStatus,
  history: roundHistory,
  prefs: () => prefs,
  diag,
  // 로컬 LLM 판정 (v0.29.0): 패널이 없으면 임시 대화로, 있으면 패널로. 종합 입력은 컨텍스트 한도에 맞춰 줄인다
  localJudge: { id: L.LOCAL_ID, available: () => !!prefs.local?.enabled, limit: () => prefs.local.contextTokens, ask: askLocal },
  // 사용 한도 안내 찾기 (shared/page.js pageLimitCheck) — 답변이 끝나지 않았거나 아주 짧을 때만 rounds가 부른다
  notify: (event) => notifier.notify(event),
  checkLimit: async (id, { scope, answer } = {}) => {
    if (isLocal(id)) return null; // 로컬 LLM에는 사용 한도가 없다
    const wc = panels.get(id)?.view.webContents;
    const svc = SERVICES.find((s) => s.id === id);
    if (!wc || wc.isDestroyed() || !svc) return null;
    const cfg = { limitText: limitTextOf(svc), scope: scope === 'answer' ? 'answer' : 'page', answer: typeof answer === 'string' ? answer : '' };
    return wc.executeJavaScript(`(${pageLimitCheck.toString()})(${JSON.stringify(cfg)})`, true).catch(() => null);
  },
  log,
});

/** 화면에서 받은 첨부 파일을 검사한다 (main/ipc-guard.js) → { ok, files } | { ok: false, error } */
const checkFiles = (files) => guard.checkFiles(files, ATTACH_LIMITS);

// 공통 입력창: 고른 패널들에 같은 질문(과 첨부 파일)을 동시에 보낸다.
ipcMain.handle('prompt:send', async (_e, { text, targets, files, opts }) => {
  if (typeof text !== 'string' || !Array.isArray(targets)) return [];
  const checked = checkFiles(files);
  if (!checked.ok) return targets.map((id) => ({ id, ok: false, error: checked.error }));
  if (!text.trim() && !checked.files.length) return [];
  return rounds.sendAll(text, targets, checked.files, sendOpts(opts));
});

ipcMain.handle('synth:run', (_e, judgeId, kind) =>
  rounds.runSynth(typeof judgeId === 'string' ? judgeId : null, 'manual', ['code', 'analysis'].includes(kind) ? kind : 'text'),
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
  // 프로젝트 맥락을 붙여 보냄 (v0.27.0): 이름만 기록에 남긴다
  if (opts.project && typeof opts.project === 'object' && typeof opts.project.name === 'string' && opts.project.name.trim()) out.project = { name: opts.project.name.trim().slice(0, 120) };
  return out;
}

// 패널 하나에만 이어서 보내기 (프로젝트 모드: 요청한 파일 보내기, 전체 파일 다시 요청)
ipcMain.handle('prompt:followup', async (_e, { id, text, files, opts }) => {
  if (typeof id !== 'string' || typeof text !== 'string' || !text.trim()) return { ok: false, error: '보낼 내용이 없습니다' };
  const checked = checkFiles(files);
  if (!checked.ok) return { id, ok: false, error: checked.error };
  return rounds.sendFollowUp(id, text, checked.files, sendOpts(opts));
});

// ---------- 프로젝트 모드 (로컬 폴더 읽기·쓰기는 project.js, 처리는 화면 쪽 공통 모듈) ----------

// 화면 요청 처리는 main/ipc/project.js (아래 "화면 요청(IPC) 연결"에서 연결)

// 채팅 안의 화면 바꾸기 (패널 / 창 띄우기 / 비교 / 변경 제안 / 편집기 …). 목록에 있는 이름만 받습니다.
ipcMain.on('view:set', (_e, value) => {
  if (mode === 'chat' && ['panels', 'dialog', 'compare', 'changes', 'editor', 'git', 'library', 'vars', 'compress', 'history', 'help'].includes(value)) {
    chatView = value;
    pushState();
  }
});

// 패널 머리줄 버튼: 새로고침 · 처음 주소 · 뒤로 · 개발자 도구 · 로그인 다시 시도 · 새 대화
// id가 '*'이면 열린 패널 전부에 같은 동작을 합니다 (모두 새 대화 등).
ipcMain.on('panel:action', (_e, { id, action }) => {
  // 로컬 LLM 패널: 새 대화 · 처음 주소 = 대화 지우기, 중지 = 답 그만 받기 (웹페이지 동작은 없음)
  if (localChat && (id === '*' || isLocal(id)) && ['newchat', 'home', 'stop'].includes(action)) {
    rounds.cancelWatch(L.LOCAL_ID);
    if (action === 'stop') localChat.stop();
    else {
      localChat.reset();
      rounds.resetPanel(L.LOCAL_ID);
      sendPanel(L.LOCAL_ID, { answer: 'clear' });
    }
  }
  const targets = id === '*' ? [...panels.entries()] : [[id, panels.get(id)]].filter(([, p]) => p);
  for (const [pid, p] of targets) {
    const wc = p.view.webContents;
    if (action === 'reload') wc.reload();
    else if (action === 'home') {
      // 처음 주소는 새 대화로 열린다: 답변 감시를 멈추고, 화면에도 새 대화라고 알린다 (스킬·프로젝트 파일을 다시 보내게)
      rounds.cancelWatch(pid);
      rounds.resetPanel(pid);
      sendPanel(pid, { answer: 'clear' });
      wc.loadURL(SERVICES.find((s) => s.id === pid).url);
    }
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'devtools') wc.toggleDevTools();
    else if (action === 'login') p.login.retry();
    else if (action === 'newchat') {
      rounds.cancelWatch(pid);
      rounds.resetPanel(pid);
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
  const prevVersion = remote.getStatus().version;
  const st = await remote.refresh();
  // 새 셀렉터를 받았으면 자가진단 기록을 지우고 다시 확인한다
  if (st.source === 'remote' && !st.error && st.version !== prevVersion) {
    diag.reset();
    lastProbe.clear();
    for (const id of panels.keys()) probePanel(id);
  }
  log('remote', JSON.stringify(st));
  pushState();
  return st;
}

// ---------- 앱 업데이트 (v0.20.0) ----------
// 확인은 자동(켜 두었을 때) 또는 설정 화면의 [지금 확인]. 받기 · 설치는 사용자가 누를 때만.
let updater = null;

// ---------- 화면 요청(IPC) 연결 (v0.24.0) ----------
// 기록 · 프로젝트 · 설정 요청은 main/ipc/ 아래 파일이 처리한다. 바뀌는 값(창 · 설정 · 패널 상태)은 함수로 넘긴다.
require('./ipc/history').register({
  ipcMain,
  history,
  clipboard,
  dialog,
  app,
  rounds: () => rounds,
  roundHistoryId: () => roundHistoryId,
  win: () => win,
});
require('./ipc/chain').register({ ipcMain, rounds: () => rounds, hasPanel: hasPanelId }); // 이어 묻기 · 토론 (v0.26.0)
require('./ipc/project').register({
  ipcMain,
  project,
  guard,
  prefs: () => prefs,
  savePrefs,
  pushState,
  win: () => win,
  devTest: () => devTest,
  gitConsole: () => gitConsole,
  setSidebarOpen: (open) => (sidebarOpen = open),
});
require('./ipc/settings').register({
  ipcMain,
  history,
  remote,
  guard,
  net,
  shell,
  TIMEOUT_CHOICES,
  MAX_CHOICES,
  prefs: () => prefs,
  savePrefs,
  pushState,
  allServices,
  refreshRemote,
  localChat: () => localChat,
  closeLocalPanel,
  askLocal,
  focusId: () => focusId,
  setFocusId: (id) => (focusId = id),
  updater: () => updater,
  shortcutList,
  librarySaver,
  readLibrary: () => secure.store().readJson(libraryFile(), {}),
});

// ---------- 단축키 ----------

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
    history.init(app.getPath('userData'), { max: prefs.historyMax });
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
    devTest = setupDevTest({ ipcMain, getWin: () => win, project, userDataDir: app.getPath('userData') });
    // 적용 후 커밋 (v0.28.0): 적용한 파일만 add · commit (push 없음), 테스트 실행 중에는 받지 않는다
    setupGitCommit({ ipcMain, getRoot: () => project.info()?.id || null, isBusy: () => !!devTest?.isBusy() });
    updater = createUpdater({ app, isAuto: () => prefs.autoUpdate !== false, onChange: () => schedulePushState(), log });
    updater.start();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    // 미뤄 둔 기록 · 설정 · 라이브러리 저장을 지금 한다 (여기서는 동기 쓰기라 끄기 전에 끝난다)
    history.flush();
    prefsSaver.flush();
    librarySaver.flush();
    cleanupTemp();
    gitConsole?.stop();
    devTest?.stop();
    updater?.stop();
  });
}
