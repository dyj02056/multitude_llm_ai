'use strict';

// 크롬 확장 프로그램의 host.
// Electron 앱에서 preload(window.host) + 메인 프로세스(main.js)가 하던 일을 확장 프로그램 탭 안에서 한다.
// 화면(lib/renderer/renderer.js)은 Electron 앱과 똑같은 파일을 쓰고, 이 파일이 window.host를 만들어 준다.
//
// 서비스 페이지는 iframe으로 띄운다. 패널 머리줄은 화면(renderer)이 그리고, iframe은 Electron의 WebContentsView처럼
// 이 파일이 패널 본문 자리에 겹쳐 놓는다. 그래서 모델 선택 화면을 오가도 iframe이 다시 로드되지 않는다.
// 서비스 페이지와는 content.js(각 iframe 안에서 실행)와 메시지로 주고받는다.

// [쉽게 말하면]
// 크롬 확장 프로그램의 "본체"입니다. Windows 앱에서는 main.js + preload.js가 하던 일을 크롬 탭 하나 안에서 합니다.
//   - AI 사이트를 iframe(페이지 안의 작은 창)으로 띄우고 자리를 맞춤
//   - 화면이 쓰는 window.host 기능(질문 보내기, 복사, 기록, 설정 …)을 Windows 앱과 같은 이름으로 제공
//   - 각 iframe 안의 content.js와 메시지를 주고받아 입력·보내기·답변 읽기를 시킴
// 덕분에 화면 코드(renderer.js 등)는 Windows 앱과 확장에서 똑같은 파일을 씁니다.
(() => {
  // 패널(iframe) · 원격 셀렉터 · 새 버전 알림은 host-panels.js · host-remote.js에 있다 (v0.31.0, 이 파일보다 먼저 읽힌다).
  // 그 파일들이 X에 실어 둔 함수를 꺼내 쓰고, 이 파일의 것은 맨 아래에서 X에 실어 준다.
  const X = (MLA.extHost = MLA.extHost || {});
  const { UPD, allowFraming, callFrame, checkUpdate, closePanel, loadRemoteCache, navigate, openPanel, refreshRemote, resetRemote, svcOf } = X;
  const { SERVICES, MAX_SELECTED, DEFAULT_SELECTED, ATTACH_LIMITS, normalizeSelected, serviceForHost, uploadOf, fileBytesOf, limitTextOf } =
    MLA.services;
  const { watchAnswer } = MLA.watch;
  const { createRounds } = MLA.rounds;
  const { createDiag } = MLA.diag;
  const { createHistory, createAreaStore, normalizeMax, MAX_CHOICES, okRecordId } = MLA.historyCore;
  const HS = MLA.historySearch;
  const remoteCore = MLA.remoteCore;
  const { shortcutList, shortcutFor } = MLA.shortcuts;

  const HEADER_H = 28; // 패널마다 이름·상태를 그리는 머리줄 높이 (styles.css와 같게)
  const BAR_H = 34; // 프로젝트 모드: 답변에 수정안이 있으면 패널 아래에 띄우는 변경 바 높이 (styles.css와 같게)
  const TOOLBAR_H = 44; // 맨 위 공통 툴바 높이
  const COMPOSER_H = 132; // 채팅 화면 맨 아래 공통 입력창 높이 (첨부 파일 줄 포함)
  const GAP = 4;
  const SIDEBAR_W = 300; // 프로젝트 사이드바 폭 (styles.css와 같게)
  const TIMEOUT_CHOICES = [5, 10, 20, 30, 60]; // 답변 최대 대기 시간(분) 선택지
  const REMOTE_REFRESH_MS = 6 * 60 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 8000;
  const HELLO_TIMEOUT_MS = 8000; // iframe이 로드된 뒤 이 안에 content.js가 연결되지 않으면 패널에 안내를 띄운다
  const LOGIN_CHECK_MS = 1500; // 페이지가 그려질 시간을 두고 로그인 상태를 본다

  const debug = (() => {
    try {
      return localStorage.getItem('mla.debug') === '1'; // 개발용: 콘솔에 전송·답변 로그
    } catch {
      return false;
    }
  })();
  const log = (tag, ...args) => debug && console.log(`[${tag}]`, ...args);

  // ---------- 화면 언어 (v0.30.0) ----------
  // 설정(prefs.lang: 'auto' · 'ko' · 'en')은 chrome.storage에 있어 읽는 데 시간이 걸린다. 첫 글자부터 맞는 언어로 그리려고
  // 마지막 값을 localStorage('mla.lang', 앱 탭 · 사이드탭이 같이 봄)에도 적어 두고 시작할 때 바로 읽는다.
  // 'auto'면 크롬 표시 언어를 본다 (한국어면 한국어, 아니면 영어).
  const LANG_KEY = 'mla.lang';
  const uiLangOf = (pref) => MLA.i18n.detectLang(pref, chrome.i18n?.getUILanguage?.() || navigator.language);
  function applyLang(pref) {
    try {
      localStorage.setItem(LANG_KEY, pref);
    } catch {}
    return MLA.i18n.setLang(uiLangOf(pref));
  }
  const startLang = (() => {
    let cached = null;
    try {
      cached = localStorage.getItem(LANG_KEY);
    } catch {}
    return MLA.i18n.setLang(uiLangOf(MLA.i18n.normalizeLangPref(cached)));
  })();

  // ---------- 저장 (chrome.storage.local) ----------

  // 크롬 확장 저장소에서 값 읽기 (없으면 fallback)
  async function load(key, fallback) {
    try {
      const r = await chrome.storage.local.get(key);
      return r[key] ?? fallback;
    } catch {
      return fallback;
    }
  }

  function store(key, value) {
    chrome.storage.local.set({ [key]: value }).catch((err) => console.error(`[storage] ${key} 저장 실패:`, err.message));
  }

  let prefs = {
    selected: [...DEFAULT_SELECTED],
    layout: 'grid',
    synthTarget: 'chatgpt',
    autoSynth: false,
    answerTimeoutMin: 20,
    remoteSelectors: true, // 사이트 셀렉터 원격 갱신
    local: { enabled: false, baseUrl: MLA.localLLM.DEFAULT_BASE, model: '', contextTokens: MLA.localLLM.DEFAULT_CONTEXT }, // 로컬 LLM 패널 (선택 기능, v0.16.0 · 컨텍스트 한도 v0.29.0)
    autoUpdate: true, // 새 버전 알림 (v0.20.0)
    historyMax: 500, // 기록 최대 개수 (v0.24.0)
    historyArchive: false, // 넘친 기록을 달별 보관으로 (v0.35.0, 기본 끔)
    notify: { ...MLA.notify.DEFAULT_PREFS }, // OS 알림 종류별 켜기 (v0.25.0, 기본 모두 켬)
    sendPreview: false, // 보내기 전 미리보기 (v0.25.0, 기본 끔)
    retryOnce: true, // 보내기 실패면 잠깐 뒤 한 번 다시 보내기 (v0.26.0, 기본 켬)
    recommendOrder: 'completion', // 추천 줄 세우기 기준 (v0.35.0): completion · rating · speed
    autoRecommend: false, // 추천 조합 제안 (v0.27.0, 기본 끔): 질문 종류의 추천 조합이 지금 대상과 다르면 [추천 조합으로 바꾸기]만 띄운다
    lang: 'auto', // 화면 언어 (v0.30.0)
  };
  const savePrefs = () => store('prefs', prefs);

  // ---------- 로컬 LLM (v0.16.0, 선택 기능) — Windows 앱(main.js)과 같은 규칙 ----------
  // 웹 서비스 목록(SERVICES)과 따로 두고, 켜 두었을 때만 붙인다. 이 PC 주소(localhost · 127.0.0.1) 권한은 켤 때 그때 묻는다.
  const LL = MLA.localLLM;
  const LOCAL_ORIGINS = ['http://localhost/*', 'http://127.0.0.1/*'];
  const normalizeLocalPrefs = LL.normalizeLocalPrefs; // 패널 수 · 패널마다 모델까지 (v0.36.0)
  /** 패널 없이 로컬 LLM에 한 번 묻기 (v0.29.0, 판정 · 압축 — Windows 앱 main.js askLocal과 같음): 패널 대화와 따로인 임시 대화 */
  const askLocal = (text) =>
    prefs.local?.enabled ? LL.askOnce({ fetchFn: (url, opts) => fetch(url, opts), getConfig: () => prefs.local, text }) : Promise.resolve({ ok: false, error: MLA.i18n.t('ext.host.localOff') });
  const allServices = () => (prefs.local?.enabled ? [...SERVICES, ...LL.localServices(prefs.local)] : SERVICES);
  const isLocal = LL.isLocalId;
  const localChats = new Map(); // 로컬 LLM 대화 (id → 대화, 패널이 열려 있을 때만, 최대 3개 — v0.36.0)
  const hasPanelId = (id) => (isLocal(id) ? localChats.has(id) : panels.has(id));
  function openLocalPanel(id = LL.LOCAL_ID) {
    if (!isLocal(id) || localChats.has(id)) return;
    const chat = LL.createLocalChat({
      fetchFn: (url, opts) => fetch(url, opts),
      getConfig: () => ({ ...prefs.local, model: LL.modelOf(prefs.local, id) }), // 패널마다 모델이 다르다
      onUpdate: (view) => sendPanel(id, { local: view }),
    });
    localChats.set(id, chat);
    sendPanel(id, { login: 'ready', local: chat.view() });
  }
  /** 로컬 패널 하나를 닫는다 (id가 없으면 모두) */
  function closeLocalPanel(id) {
    for (const x of id ? [id] : [...localChats.keys()]) {
      localChats.get(x)?.stop();
      localChats.delete(x);
      rounds.resetPanel(x); // 대화 줄기 (v0.27.0): 닫은 패널은 지난 대화를 잇지 않는다
    }
  }

  // 기록별 저장 (v0.24.0, shared/history-core.js createAreaStore): 'history:index' + 'history:r:<id>'.
  // 예전 'history' 칸(배열 전체)은 처음 읽을 때 옮기고 지운다.
  const historyStore = createAreaStore(chrome.storage.local, { onError: (err) => console.error('[storage] 기록 저장 실패:', err.message) });
  const history = createHistory(historyStore.save);
  // 기록 의미 검색 (v0.36.0, Windows 앱 main.js와 같음): 로컬 서버(localhost)의 /v1/embeddings로 만든 뜻 벡터는 'embedIndex' 칸에 둔다
  const embed = MLA.embedIndex.createEmbedService({
    getConfig: () => prefs.local,
    getRecords: () => history.all(),
    fetchFn: (url, opts) => fetch(url, opts),
    load: async () => (await chrome.storage.local.get('embedIndex')).embedIndex || null,
    save: async (index) => (index ? chrome.storage.local.set({ embedIndex: index }) : chrome.storage.local.remove('embedIndex')),
    listByIds: (ids, filters) => history.listByIds(ids, filters),
  });
  // 최대 개수를 넘은 기록의 보관 (v0.35.0, shared/history-archive.js): 'history:a:YYYY-MM' 칸, 설정에서 켠 때만
  const historyArchive = MLA.historyArchive.createAreaArchive(chrome.storage.local, { onError: (err) => console.error('[storage] 기록 보관 실패:', err.message) });
  const setArchiveOn = (on) => history.setArchive(on ? (list) => void historyArchive.append(list) : null);
  // 사이드탭 기록 (v0.21.0): 사이드탭이 'history:side'에 쓰고, 앱 탭 기록 화면이 함께 보여 준다.
  // 같은 칸을 두 화면이 함께 쓰면 서로 덮어쓸 수 있어서 칸을 나눴다. 앱 탭은 지우기만 한다.
  const sideHistory = createHistory((records) => store('history:side', records));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['history:side']) sideHistory.load(changes['history:side'].newValue || []);
  });
  const byNewest = (a, b) => b.at - a.at;

  // 셀렉터 편집기: 고칠 수 있는 서비스(웹 서비스만), 보여 줄 모습, 고친 뒤 입력창 다시 찾기
  const webService = (id) => (typeof id === 'string' ? SERVICES.find((s) => s.id === id) : null);
  function selectorView(id) {
    const svc = webService(id);
    if (!svc) return null;
    const local = X.getLocalSelectors(id);
    return {
      id,
      name: svc.name,
      fields: remoteCore.LOCAL_FIELDS,
      local,
      inherited: Object.fromEntries(remoteCore.LOCAL_FIELDS.map((f) => [f, (svc[f] || []).filter((x) => !(local[f] || []).includes(x))])),
    };
  }
  function reprobe(id) {
    diag.reset(id); // 새 셀렉터로 다시 확인한다
    if (X.panels.has(id)) probePanel(id);
    pushState();
  }

  // ---------- 화면에 알리기 (Electron의 webContents.send 대신) ----------

  const listeners = { state: [], 'panel:status': [], 'synth:status': [], shortcut: [] };
  const emit = (channel, payload) => {
    for (const fn of listeners[channel]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  };
  const sendPanel = (id, patch) => emit('panel:status', { id, ...patch });

  // 셀렉터 자가진단 (shared/diag.js): 패널마다 입력창 · 보내기 버튼 · 답변 영역을 찾았는지 기록 — Windows 앱과 같음
  const diag = createDiag({ onChange: (id, st) => sendPanel(id, { diag: st }) });
  const PROBE_GAP_MS = 30 * 1000;
  const lastProbe = new Map();
  function probePanel(id) {
    const now = Date.now();
    if (now - (lastProbe.get(id) || 0) < PROBE_GAP_MS) return;
    lastProbe.set(id, now);
    setTimeout(async () => {
      if (!panels.has(id)) return;
      try {
        diag.fromProbe(id, await callFrame(id, { type: 'mla:probe', cfg: { input: svcOf(id).input || [] } }));
      } catch {} // 아직 연결 전이거나 페이지가 바뀌는 중
    }, 2500);
  }

  // ---------- 상태 ----------

  let mode = 'pick'; // 'pick' | 'chat'  (확장 프로그램은 크롬에 로그인된 계정을 그대로 써서 로그인 화면이 없다)
  let chatView = 'panels'; // 'panels' (웹 패널) | 'dialog' (패널 위에 띄운 창 — 패널을 화면 밖으로 치움) | 'compare' (답변 비교) | 'changes' (변경 제안) | 'editor' (프로젝트 파일 편집) | 'library' (라이브러리) | 'vars' (변수 입력) | 'compress' (스킬 AI 압축) | 'history' (기록) | 'help' (설정·단축키) — git 콘솔은 없음
  let sidebarOpen = false; // 프로젝트 사이드바가 열려 있으면 패널을 오른쪽으로 민다
  const barIds = new Map(); // 패널 id -> 아래 바 줄 수 (1~2, v0.28.0) — iframe 아래쪽을 바 높이 × 줄 수만큼 비운다
  let tabId = null;
  let windowId = null; // 사이드탭 열기 (v0.19.0) — 누른 그 순간에 열어야 해서 미리 알아 둔다
  const panels = new Map(); // id -> { iframe, frameId, origin, url, retried, helloTimer, loginTimer }

  const framesEl = document.createElement('div');
  framesEl.id = 'frames';
  document.body.append(framesEl);

  // ---------- 화면 전환 · 배치 ----------

  function showPick() {
    mode = 'pick';
    pushState(); // 열린 패널은 살려 두되 화면에서만 뺀다. 다시 열면 대화가 그대로 남아 있다.
  }

  function showChat(selected) {
    const ids = allServices().map((s) => s.id).filter((id) => selected.includes(id)).slice(0, MAX_SELECTED);
    if (!ids.length) return;
    prefs.selected = ids;
    savePrefs();
    for (const id of [...panels.keys()]) if (!ids.includes(id)) closePanel(id);
    for (const id of ids) if (!isLocal(id) && !panels.has(id)) openPanel(svcOf(id));
    for (const id of LL.LOCAL_IDS) {
      if (ids.includes(id)) openLocalPanel(id);
      else closeLocalPanel(id);
    }
    mode = 'chat';
    chatView = 'panels';
    pushState();
  }

  // Electron 앱(main.js computeRects)과 같은 배치 (shared/layout.js)
  let focusId = null; // 크게 보는 패널 (⤢). 나머지 iframe은 크기를 그대로 둔 채 화면 밖으로 옮긴다
  // 패널마다 위치·크기 계산 (Windows 앱의 main.js computeRects와 같은 규칙)
  function computeRects() {
    if (mode !== 'chat') return [];
    const side = sidebarOpen ? SIDEBAR_W : 0;
    const box = { x: side, y: TOOLBAR_H, width: window.innerWidth - side, height: window.innerHeight - TOOLBAR_H - COMPOSER_H };
    const ids = allServices().map((s) => s.id).filter(hasPanelId);
    if (focusId && !ids.includes(focusId)) focusId = null;
    const cells = MLA.layout.placeCells(prefs.layout, ids.length, box, GAP);
    const [big] = MLA.layout.placeCells('grid', 1, box, GAP);
    return ids.map((id, i) => {
      const frame = focusId === id ? big : cells[i];
      const bar = (barIds.get(id) || 0) * BAR_H;
      return {
        id,
        frame,
        hidden: !!focusId && focusId !== id,
        focused: focusId === id,
        bar: !!bar,
        content: { x: frame.x, y: frame.y + HEADER_H, width: frame.width, height: Math.max(0, frame.height - HEADER_H - bar) },
      };
    });
  }

  /**
   * 지금 상태를 화면에 알리고 iframe 위치를 맞춥니다. 패널 화면('panels')이 아니면 iframe을 화면 왼쪽 바깥(-20000)으로 치웁니다.
   * 숨기지(display:none) 않고 옮기는 이유: 숨기면 페이지 크기가 0이 되어 답변을 읽지 못하기 때문입니다.
   */
  function pushState() {
    const rects = computeRects();
    // 모델 선택·비교·기록·도움말 화면에서는 iframe을 화면 밖으로 옮겨 둔다.
    // display:none으로 숨기면 페이지 배치가 0이 되어 답변을 읽지 못한다. 크기는 그대로 두어 답변 감시가 계속된다.
    const showPanels = mode === 'chat' && chatView === 'panels';
    for (const r of rects) {
      const p = panels.get(r.id);
      if (!p) continue;
      Object.assign(p.iframe.style, {
        left: `${showPanels && !r.hidden ? r.content.x : -20000}px`,
        top: `${r.content.y}px`,
        width: `${r.content.width}px`,
        height: `${r.content.height}px`,
      });
      p.iframe.tabIndex = showPanels && !r.hidden ? 0 : -1;
    }
    if (!rects.length) for (const p of panels.values()) p.iframe.style.left = '-20000px';
    if (!showPanels && framesEl.contains(document.activeElement)) document.activeElement.blur();
    emit('state', {
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
      historyMax: prefs.historyMax,
      historyArchive: prefs.historyArchive === true,
      historyMaxChoices: MAX_CHOICES,
      remoteSelectors: prefs.remoteSelectors,
      remote: X.remoteStatus,
      diag: diag.all(SERVICES.map((s) => s.id)),
      services: allServices().map((s) => ({ id: s.id, name: s.name, color: s.color, url: s.url, kind: s.kind || 'web', accept: uploadOf(s).accept, maxFileBytes: fileBytesOf(s), ...(s.textOnlyDocs ? { textOnlyDocs: true } : {}) })),
      local: { ...prefs.local },
      autoUpdate: prefs.autoUpdate !== false,
      notify: { ...prefs.notify },
      sendPreview: prefs.sendPreview,
      retryOnce: prefs.retryOnce,
      autoRecommend: prefs.autoRecommend,
      recommendOrder: prefs.recommendOrder,
      onboarded: prefs.onboarded, // 첫 사용 안내를 봤는지 (v0.31.0)
      lang: prefs.lang, // 언어 설정 (v0.30.0) · uiLang = 지금 쓰는 언어
      uiLang: MLA.i18n.getLang(),
      update: X.updateStatus,
      storage: { encrypted: false, extension: true }, // 크롬 확장은 OS 열쇠 보관소가 없어 암호화하지 않는다 (v0.22.1)
      rects,
    });
  }

  window.addEventListener('resize', pushState);

  // ---------- 질문 보내기 · 교차검토(종합) ----------

  const sendCfg = (svc) => ({
    input: svc.input || [],
    send: svc.send || [],
    sendText: svc.sendText || null,
    submitKey: svc.submitKey || 'Enter',
    // 입력창을 못 찾았을 때 원인(로그아웃 · 이용 동의)을 알려 주는 단서 (v0.38.2)
    loggedOut: svc.loggedOut || null,
    consent: svc.consent || null,
  });
  const snapCfg = (svc) => ({ stop: svc.stop || [], response: svc.response || [], messages: svc.messages || null });

  // 패널의 지금 상태(답변 중인지, 최신 답변 글)를 content.js에게 읽어 오게 합니다.
  async function snapshot(id, { markdown = false } = {}) {
    try {
      return await callFrame(id, { type: 'mla:snapshot', cfg: snapCfg(svcOf(id)), markdown });
    } catch {
      return null; // 페이지가 바뀌는 중
    }
  }

  // 답변 평가 (v0.23): 지금 라운드(공통 입력창으로 마지막에 보낸 질문)의 기록 id. rounds가 기록을 만들 때 받아 둔다.
  let roundHistoryId = null;
  const roundHistory = { ...history, add: (rec) => (roundHistoryId = history.add(rec)) };

  // OS 알림 (v0.25.0): 이 앱 탭을 보고 있지 않을 때 답변 완료 · 사용 한도 · 보내기 실패 · 종합 끝을 크롬 알림으로 띄운다.
  // 무엇을 언제 알릴지와 글은 shared/notify.js. 알림을 누르면 이 탭과 창을 앞으로 가져온다 (분석이 끝났으면 답변 비교 화면).
  const myNotes = new Map(); // 이 탭이 띄운 알림 id -> 누르면 열 화면
  const notifier = MLA.notify.createNotifier({
    prefs: () => prefs.notify,
    isFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
    show: (msg) => {
      if (!chrome.notifications) return;
      const id = `mla-${crypto.randomUUID()}`;
      myNotes.set(id, msg.view || null);
      chrome.notifications
        .create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: msg.title, message: msg.body })
        .catch((err) => {
          myNotes.delete(id);
          log('notify', 'failed', err.message);
        });
    },
  });
  if (chrome.notifications) {
    chrome.notifications.onClicked.addListener((id) => {
      if (!myNotes.has(id)) return; // 다른 앱 탭이 띄운 알림
      const view = myNotes.get(id);
      myNotes.delete(id);
      chrome.notifications.clear(id).catch(() => {});
      if (tabId !== null) chrome.tabs.update(tabId, { active: true }).catch(() => {});
      if (windowId !== null) chrome.windows.update(windowId, { focused: true }).catch(() => {});
      if (view && mode === 'chat') {
        chatView = view;
        pushState();
      }
    });
    chrome.notifications.onClosed.addListener((id) => myNotes.delete(id));
  }

  const rounds = createRounds({
    get services() {
      return allServices();
    },
    hasPanel: hasPanelId,
    sendPrompt: async (id, text, files, { fallbackText } = {}) => {
      if (isLocal(id)) {
        if (!localChats.has(id)) return { ok: false, error: MLA.i18n.t('ext.side.paneClosed') };
        const b64 = (d) => {
          const bytes = new Uint8Array(d);
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        };
        // 글 파일은 요청 글에 끼워 보낸다 (컨텍스트 한도를 넘으면 일부만, v0.36.0)
        const emb = LL.embedTextFiles(text, files, { sp: MLA.sendPlan, decode: (f) => new TextDecoder('utf-8').decode(new Uint8Array(f.data)), contextTokens: prefs.local?.contextTokens });
        return localChats.get(id).send(text, files.map((f) => LL.imageDataUrl(f, b64)).filter(Boolean), emb);
      }
      const svc = svcOf(id);
      let upload = null;
      if (files.length) {
        // 확장 메시지는 JSON만 실을 수 있어서, 파일은 iframe에 postMessage로 그대로(구조적 복제) 넘긴다.
        // content.js는 이 번호(nonce)로 받은 파일을 찾아 첨부한다.
        const p = panels.get(id);
        if (!p?.origin) throw new Error(MLA.i18n.t('ext.side.notLinked'));
        const nonce = crypto.randomUUID();
        p.iframe.contentWindow.postMessage({ mla: 'files', nonce, files }, p.origin);
        upload = { nonce, cfg: uploadOf(svc) };
      }
      const res = await callFrame(id, { type: 'mla:send', cfg: sendCfg(svc), text, upload, fallbackText });
      // 로그아웃 · 이용 동의 때문에 못 보냈으면 패널 머리줄에도 그 상태와 "로그인 탭" 버튼을 띄운다 (v0.38.2)
      if (res?.code === 'logged-out') sendPanel(id, { login: 'needs-login' });
      else if (res?.code === 'needs-consent') sendPanel(id, { login: 'needs-consent' });
      return res || { ok: false, error: MLA.i18n.t('ext.side.paneNoReply') };
    },
    snapshot: (id, opts) => (isLocal(id) ? (localChats.has(id) ? localChats.get(id).snapshot() : null) : snapshot(id, opts)),
    watch: (id, before, isCurrent, onState) => {
      if (isLocal(id)) {
        const chat = localChats.get(id);
        if (!chat) return;
        return watchAnswer(async () => chat.snapshot(), before, () => isCurrent() && localChats.get(id) === chat, onState, { maxMs: prefs.answerTimeoutMin * 60 * 1000 });
      }
      return watchAnswer(() => snapshot(id), before, isCurrent, onState, { maxMs: prefs.answerTimeoutMin * 60 * 1000 });
    },
    sendPanel,
    sendSynthStatus: (patch) => emit('synth:status', patch),
    history: roundHistory,
    prefs: () => prefs,
    diag,
    // 로컬 LLM 판정 (v0.29.0): 패널이 없으면 임시 대화로, 있으면 패널로. 종합 입력은 컨텍스트 한도에 맞춰 줄인다
    localJudge: { id: LL.LOCAL_ID, available: () => !!prefs.local?.enabled, limit: () => prefs.local.contextTokens, ask: askLocal },
    notify: (event) => notifier.notify(event),
    checkLimit: async (id, { scope, answer } = {}) => {
      if (isLocal(id) || !panels.has(id)) return null;
      const cfg = { limitText: limitTextOf(svcOf(id)), scope: scope === 'answer' ? 'answer' : 'page', answer: typeof answer === 'string' ? answer : '' };
      return callFrame(id, { type: 'mla:limit', cfg }).catch(() => null);
    },
    log,
  });

  /** 이어 묻기 · 토론에서 화면이 넘긴 패널 id 모양 검사 (v0.26.0) */
  const okChainId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);

  /** 보내기 옵션 (v0.27.0): project는 이름만 남긴다 (Windows 앱 main.js sendOpts와 같은 검사). 나머지는 예전처럼 그대로 */
  function cleanSendOpts(opts) {
    const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? { ...opts } : {};
    const name = o.project && typeof o.project === 'object' && typeof o.project.name === 'string' ? o.project.name.trim().slice(0, 120) : '';
    if (name) o.project = { name };
    else delete o.project;
    return o;
  }

  /** 첨부 파일 한도 검사 (화면에서도 막지만 한 번 더 본다) */
  function checkFiles(files) {
    if (!Array.isArray(files) || files.length > ATTACH_LIMITS.maxFiles) return false;
    let total = 0;
    for (const f of files) {
      if (!f || typeof f.name !== 'string' || !(f.data instanceof ArrayBuffer)) return false;
      total += f.data.byteLength;
      if (f.data.byteLength > ATTACH_LIMITS.maxFileBytes || total > ATTACH_LIMITS.maxTotalBytes) return false;
    }
    return true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 문서에 포커스가 없으면 clipboard API가 거절한다. 예전 방식으로 한 번 더 시도한다.
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  // 패널 머리줄 버튼 처리: 새로고침 · 처음 주소 · 뒤로 · 새 대화 · 로그인 탭 열기
  function panelAction(id, action) {
    // 로컬 LLM 패널: 새 대화 · 처음 주소 = 대화 지우기, 중지 = 답 그만 받기
    if (localChats.size && (id === '*' || isLocal(id)) && ['newchat', 'home', 'stop'].includes(action)) {
      for (const [lid, chat] of id === '*' ? [...localChats] : [[id, localChats.get(id)]].filter(([, c]) => c)) {
        rounds.cancelWatch(lid);
        if (action === 'stop') chat.stop();
        else {
          chat.reset();
          rounds.resetPanel(lid);
          sendPanel(lid, { answer: 'clear' });
        }
      }
    }
    const ids = id === '*' ? [...panels.keys()] : [id].filter((x) => panels.has(x));
    for (const pid of ids) {
      const svc = svcOf(pid);
      const p = panels.get(pid);
      if (action === 'reload') {
        // 지금 주소로 다시 연다. 페이지 안에서 새로고침하면 서비스 워커가 다시 받아 와 막힐 수 있어 navigate를 쓴다.
        p.retried = false;
        navigate(pid, p.url || svc.url);
      } else if (action === 'home') {
        // 처음 주소는 새 대화로 열린다 (스킬·프로젝트 파일을 다시 보내게 화면에 알린다)
        rounds.cancelWatch(pid);
        rounds.resetPanel(pid);
        sendPanel(pid, { answer: 'clear' });
        navigate(pid, svc.url);
      }
      else if (action === 'back') callFrame(pid, { type: 'mla:back' }).catch(() => {});
      else if (action === 'login') {
        // 일반 탭에서 로그인 → 쿠키가 바뀌거나 이 탭으로 돌아오면 패널이 저절로 다시 열린다 (v0.38.2, host-panels.js)
        X.armLogin(pid);
        chrome.tabs.create({ url: svc.url });
      }
      else if (action === 'newchat') {
        rounds.cancelWatch(pid);
        rounds.resetPanel(pid);
        sendPanel(pid, { answer: 'clear' });
        navigate(pid, svc.newChatUrl);
      }
    }
  }

  // ---------- 단축키 ----------

  /** 단축키 동작을 실행한다. 처리했으면 true */
  // 단축키 처리 (Windows 앱의 main.js runShortcut과 같은 일)
  function runShortcut(action) {
    if (mode !== 'chat') return false;
    if (action.startsWith('view:')) {
      const view = action.slice(5);
      // 같은 화면 단축키를 다시 누르면 패널로 돌아간다.
      chatView = chatView === view ? 'panels' : view;
      pushState();
      return true;
    }
    if (action.startsWith('panel:')) {
      const ids = SERVICES.map((s) => s.id).filter((id) => panels.has(id));
      const id = ids[Number(action.slice(6)) - 1];
      if (!id) return false;
      if (chatView !== 'panels') {
        chatView = 'panels';
        pushState();
      }
      panels.get(id).iframe.focus();
      callFrame(id, { type: 'mla:focus', cfg: sendCfg(svcOf(id)) }).catch(() => {});
      return true;
    }
    // 나머지는 화면 쪽 버튼이 하는 일과 같아서 화면으로 넘긴다 (입력창 포커스, 새 대화, 종합, 복사, 대상 켜기/끄기 등).
    window.focus();
    emit('shortcut', action);
    return true;
  }

  // 이 탭(공통 입력창 등)에서 누른 키. 패널 iframe 안에서 누른 키는 content.js가 mla:key로 보내 준다.
  window.addEventListener(
    'keydown',
    (e) => {
      const input = {
        type: 'keyDown',
        key: e.key,
        code: e.code,
        control: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };
      const action = shortcutFor(input, { canEscape: mode === 'chat' && chatView !== 'panels', browser: true });
      if (action && runShortcut(action)) e.preventDefault();
    },
    true,
  );

  // ---------- window.host (renderer.js가 쓰는 API — Electron preload.js와 같은 모양) ----------

  window.host = {
    lang: startLang, // 화면이 첫 글자를 그릴 언어 (v0.30.0, Windows 앱 preload.js와 같은 이름)
    ui: {
      // 글은 getter로 둔다: 언어를 바꾸면 화면이 다시 읽어 새 언어로 그린다 (v0.30.0)
      hints: {
        get pick() { return MLA.i18n.t('ext.host.hintPick'); },
        get chat() { return MLA.i18n.t('ext.host.hintChat'); },
      },
      get pickNote() { return MLA.i18n.t('ext.host.pickNote'); },
      get loginButton() { return { label: MLA.i18n.t('ext.side.loginTab'), title: MLA.i18n.t('ext.side.loginTabTitle') }; },
      devtools: false, // 패널 페이지는 F12 개발자 도구의 프레임 선택으로 본다
    },
    openModels: (ids) => Array.isArray(ids) && showChat(ids.filter((id) => typeof id === 'string')),
    pickModels: () => mode === 'chat' && showPick(),
    logout: () => {},
    // opts: { question(기록·종합용 질문), textById({ 서비스 id: 그 서비스에 보낼 글 }), fallbackText(첨부 실패 때 대신 보낼 글) }
    sendPrompt: async (text, targets, files = [], opts = {}) => {
      if (typeof text !== 'string' || !Array.isArray(targets)) return [];
      if (!checkFiles(files)) return targets.map((id) => ({ id, ok: false, error: MLA.i18n.t('ext.host.filesOver') }));
      if (!text.trim() && !files.length) return [];
      return rounds.sendAll(text, targets, files, cleanSendOpts(opts));
    },
    // opts: { fallbackText(첨부 실패 때 대신 보낼 글) }
    sendFollowUp: async (id, text, files = [], opts = {}) => {
      if (typeof text !== 'string' || !text.trim()) return { id, ok: false, error: MLA.i18n.t('ext.host.nothingToSend') };
      if (!checkFiles(files)) return { id, ok: false, error: MLA.i18n.t('ext.host.filesOver') };
      return rounds.sendFollowUp(id, text, files, opts || {});
    },
    // AI끼리 이어 묻기 (v0.26.0, Windows 앱 main/ipc/chain.js와 같은 검사): 넘기기 · 다시 보내기 · 다른 AI로 보내기 · 토론
    handoff: async (from, to, intent) => {
      if (!okChainId(from) || !okChainId(to) || !MLA.chain.INTENTS.includes(intent)) return { ok: false, error: MLA.i18n.t('handoff.errIntent') };
      if (!hasPanelId(from) || !hasPanelId(to)) return { ok: false, error: MLA.i18n.t('handoff.errClosed') };
      return rounds.handoff(from, to, intent);
    },
    resend: async (id) => (okChainId(id) && hasPanelId(id) ? rounds.resend(id) : { ok: false, error: MLA.i18n.t('handoff.errClosed') }),
    sendElsewhere: async (from, to) =>
      okChainId(from) && okChainId(to) && hasPanelId(to) ? rounds.sendElsewhere(from, to) : { ok: false, error: MLA.i18n.t('handoff.errClosed') },
    // 작업 흐름 · 사실 확인 (v0.33.0)
    workflow: {
      start: async (cfg) => rounds.startWorkflow(MLA.workflow.cleanWorkflowCfg(cfg, okChainId)),
      stop: async () => rounds.stopWorkflow(),
      resume: async (opts) => rounds.resumeWorkflow({ skip: !!(opts && opts.skip === true) }),
    },
    factcheck: {
      start: async (cfg) => rounds.startFactcheck(MLA.factcheck.cleanFactCfg(cfg, okChainId)),
      stop: async () => rounds.stopFactcheck(),
    },
    debate: {
      start: async (cfg) => {
        const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
        return rounds.startDebate({
          participants: Array.isArray(c.participants) ? c.participants.filter(okChainId).slice(0, 6) : [],
          rounds: Number.isInteger(c.rounds) && c.rounds >= 1 && c.rounds <= MLA.chain.MAX_ROUNDS ? c.rounds : undefined,
          judge: okChainId(c.judge) ? c.judge : undefined,
          ...MLA.chain.cleanDebateExtras(c, okChainId), // 역할 · 라운드 사이 끼어들기 (v0.32.0)
        });
      },
      stop: async () => rounds.stopDebate(),
      interject: async (text) => rounds.interjectDebate(typeof text === 'string' ? text.slice(0, MLA.chain.MAX_NOTE_CHARS) : ''),
    },
    copyAnswer: async (id) => {
      const { text, copied, total } = await rounds.collectMarkdown(id);
      if (copied) await copyText(text);
      return { copied, total };
    },
    setView: (value) => {
      if (mode === 'chat' && ['panels', 'dialog', 'compare', 'changes', 'editor', 'library', 'vars', 'compress', 'history', 'help'].includes(value)) {
        chatView = value;
        pushState();
      }
    },
    getAnswers: () => rounds.answers(),
    getAnswer: (id) => (typeof id === 'string' ? rounds.answer(id) : null),
    history: {
      // filters (v0.27.0): 기간 · AI · 평가 · 보낸 곳 · 프로젝트 · 종합/분석/이어 묻기 · 태그 · 즐겨찾기 (shared/history-search.js가 다시 검사)
      list: async (query, filters, opts) => {
        const q = typeof query === 'string' ? query : '';
        const f = HS.cleanFilters(filters);
        const archived = opts && opts.archive === true ? await historyArchive.readAll() : undefined; // 보관 포함 (v0.35.0)
        return [...history.list(q, f, archived), ...sideHistory.list(q, f)].sort(byNewest);
      },
      get: async (id) => history.get(id) || sideHistory.get(id) || (okRecordId(id) ? await historyArchive.find(id) : null),
      archiveInfo: async () => historyArchive.info(),
      semantic: async (query, filters) => (typeof query === 'string' && query.length <= 500 ? embed.searchSimilar(query, HS.cleanFilters(filters)) : { ok: false, error: 'query' }),
      // 기록 옮기기로 받은 기록 더하기 (Windows 앱 history:import와 같음, 모양은 history-core cleanRecord가 다시 검사)
      import: async (list) => (Array.isArray(list) && list.length <= 5000 ? history.importRecords(list) : { added: 0, duplicate: 0, invalid: 0, overflow: 0, error: 'size' }),
      // 태그 · 즐겨찾기 (v0.27.0, Windows 앱 main/ipc/history.js와 같은 검사). 사이드탭 기록은 사이드탭이 쓰는 칸이라 바꾸지 않는다
      setTags: async (id, tags) => (okRecordId(id) && Array.isArray(tags) && tags.length <= 50 ? history.setTags(id, tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200))) : null),
      setStar: async (id, on) => (okRecordId(id) && typeof on === 'boolean' ? history.setStar(id, on) : null),
      thread: async (threadId) => (okRecordId(threadId) ? history.thread(threadId) : []),
      tags: async () => history.tags(),
      recommend: async (order) => history.recommend({ order: MLA.recommend.ORDERS.includes(order) ? order : 'completion' }), // 줄 세우는 기준 (v0.35.0)
      speed: async () => history.speed(), // 시간대별 응답 속도 (v0.35.0)
      stats: async () => history.stats(),
      // 답변 평가 (Windows 앱 history:feedback과 같음): 지금 라운드 기록의 그 AI 답변에 1 · -1 · 0(지우기) → 남긴 값 | null
      feedback: async (svcId, value) =>
        roundHistoryId && typeof svcId === 'string' && [1, -1, 0].includes(value) ? history.setFeedback(roundHistoryId, svcId, value) : null,
      remove: async (id) => {
        if (history.get(id)) return history.remove(id);
        if (sideHistory.get(id)) return sideHistory.remove(id);
        return historyArchive.remove(id); // 보관된 기록
      },
      clear: async () => {
        await embed.clear(); // 뜻 벡터 색인도 (기록에서 만든 것이라)
        await historyArchive.clear(); // 보관도 함께 (남겨 두면 지운 기록이 보관에 남기 때문)
        history.clear();
        sideHistory.clear();
      },
    },
    copyText: (text) => typeof text === 'string' && copyText(text),
    // 로컬 LLM 설정 (v0.16.0): 켤 때 이 PC 주소(localhost · 127.0.0.1) 접근 권한을 묻는다 (선택 권한 — 설치 · 업데이트 때는 묻지 않음)
    local: {
      setPrefs: async (next = {}) => {
        const cur = prefs.local;
        const baseUrl = next.baseUrl === undefined ? cur.baseUrl : LL.normalizeBaseUrl(next.baseUrl);
        if (!baseUrl) return { ok: false, error: MLA.i18n.t('ext.host.localOnly') };
        const enabled = typeof next.enabled === 'boolean' ? next.enabled : cur.enabled;
        if (enabled && !cur.enabled) {
          const granted = await chrome.permissions.request({ origins: LOCAL_ORIGINS }).catch(() => false);
          if (!granted) return { ok: false, error: MLA.i18n.t('ext.host.localDenied') };
        }
        prefs.local = LL.normalizeLocalPrefs({
          enabled,
          baseUrl,
          model: next.model === undefined ? cur.model : next.model,
          contextTokens: next.contextTokens === undefined ? cur.contextTokens : next.contextTokens, // v0.29.0
          panels: next.panels === undefined ? cur.panels : next.panels, // 로컬 패널 수 1 ~ 3 (v0.36.0)
          extraModels: Array.isArray(next.extraModels) ? next.extraModels.slice(0, 2) : cur.extraModels, // 둘째 · 셋째 패널의 모델
          embedModel: next.embedModel === undefined ? cur.embedModel : next.embedModel, // 의미 검색용 임베딩 모델 (v0.36.0)
        });
        if (!enabled) {
          prefs.selected = prefs.selected.filter((x) => !isLocal(x));
          if (isLocal(prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
          closeLocalPanel();
        }
        // 패널 수를 줄이면 넘는 로컬 패널을 닫고 고른 목록 · 종합 담당에서 뺀다
        for (const id of LL.LOCAL_IDS.slice(prefs.local.panels)) {
          if (!prefs.selected.includes(id) && !localChats.has(id)) continue;
          prefs.selected = prefs.selected.filter((x) => x !== id);
          if (prefs.synthTarget === id) prefs.synthTarget = prefs.selected[0];
          closeLocalPanel(id);
        }
        savePrefs();
        pushState();
        return { ok: true, local: { ...prefs.local } };
      },
      // 패널 없이 한 번 묻기 (v0.29.0, 스킬 압축): 글만 받는다 (20만 자까지, Windows 앱 local:ask와 같은 검사)
      ask: async (text) => (typeof text === 'string' && text.trim() && text.length <= 200000 ? askLocal(text) : { ok: false, error: MLA.i18n.t('ext.host.badText') }),
      models: async (baseUrl) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
          return { ok: true, models: await LL.listModels((u, o) => fetch(u, o), typeof baseUrl === 'string' ? baseUrl : prefs.local.baseUrl, { signal: ctrl.signal }) };
        } catch (err) {
          return {
            ok: false,
            error: err.name === 'AbortError' ? MLA.i18n.t('ext.host.noReply5s') : MLA.i18n.t('ext.host.ollamaOrigins', { error: err.message }),
          };
        } finally {
          clearTimeout(timer);
        }
      },
    },
    // 내보내기 (v0.14.0): 다운로드 권한 없이, 이 탭에서 파일 링크를 눌러 크롬의 다운로드로 저장한다
    saveFile: async ({ name, text, kind } = {}) => {
      const types = { md: 'text/markdown', html: 'text/html', mla: 'application/json', mlah: 'application/json' }; // mla: 설정 옮기기 (v0.29.0, .mla.json), mlah: 기록 옮기기 (v0.35.0, .mla-history.json)
      if (!types[kind] || typeof text !== 'string') return { ok: false, error: MLA.i18n.t('ext.host.badSave') };
      const url = URL.createObjectURL(new Blob([text], { type: `${types[kind]};charset=utf-8` }));
      const ext = kind === 'mla' ? 'mla.json' : kind === 'mlah' ? 'mla-history.json' : kind;
      const base = String(name || `${MLA.i18n.t('ext.host.answerFile')}.${ext}`).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120);
      const a = Object.assign(document.createElement('a'), { href: url, download: base.endsWith(`.${ext}`) ? base : `${base}.${ext}` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { ok: true, path: a.download };
    },
    shortcuts: async () => shortcutList({ browser: true }),
    runSynth: (judgeId, kind) =>
      rounds.runSynth(typeof judgeId === 'string' ? judgeId : null, 'manual', ['code', 'analysis'].includes(kind) ? kind : 'text'),
    setSynth: ({ target, auto }) => {
      if (typeof target === 'string' && allServices().some((s) => s.id === target)) prefs.synthTarget = target;
      if (typeof auto === 'boolean') prefs.autoSynth = auto;
      savePrefs();
      pushState();
    },
    setSettings: ({ answerTimeoutMin, remoteSelectors, autoUpdate, historyMax, historyArchive: keepArchive, notify, sendPreview, retryOnce, autoRecommend, recommendOrder, lang, onboarded } = {}) => {
      if (typeof onboarded === 'boolean') prefs.onboarded = onboarded; // 첫 사용 안내를 봤는지 (v0.31.0)
      // 화면 언어 (v0.30.0): 'auto' · 'ko' · 'en'만. 화면은 state.uiLang을 보고 다시 그리고, background · 사이드탭은 저장소 변화를 듣는다
      if (MLA.i18n.LANG_PREFS.includes(lang)) {
        prefs.lang = lang;
        applyLang(lang);
      }
      if (typeof autoRecommend === 'boolean') prefs.autoRecommend = autoRecommend; // 추천 조합 제안 (v0.27.0)
      if (MLA.recommend.ORDERS.includes(recommendOrder)) prefs.recommendOrder = recommendOrder; // 추천 줄 세우기 기준 (v0.35.0)
      if (TIMEOUT_CHOICES.includes(answerTimeoutMin)) prefs.answerTimeoutMin = answerTimeoutMin;
      // OS 알림 종류별 켜기 · 보내기 전 미리보기 (v0.25.0) — 아는 종류의 true/false만
      const notifyPatch = MLA.notify.cleanPatch(notify);
      if (notifyPatch) prefs.notify = MLA.notify.normalizePrefs({ ...prefs.notify, ...notifyPatch });
      if (typeof sendPreview === 'boolean') prefs.sendPreview = sendPreview;
      if (typeof retryOnce === 'boolean') prefs.retryOnce = retryOnce; // 실패하면 한 번 다시 보내기 (v0.26.0)
      if (typeof keepArchive === 'boolean') {
        prefs.historyArchive = keepArchive; // 넘친 기록을 달별 보관으로 (v0.35.0) — 아래 setMax보다 먼저 정한다
        setArchiveOn(keepArchive);
      }
      if (MAX_CHOICES.includes(historyMax)) {
        prefs.historyMax = historyMax;
        history.setMax(historyMax);
      }
      if (typeof autoUpdate === 'boolean') prefs.autoUpdate = autoUpdate;
      if (typeof remoteSelectors === 'boolean' && remoteSelectors !== prefs.remoteSelectors) {
        prefs.remoteSelectors = remoteSelectors;
        if (remoteSelectors) refreshRemote();
        else resetRemote();
      }
      savePrefs();
      pushState();
    },
    refreshRemote: () => refreshRemote(),
    // 셀렉터 편집기 (v0.35.0, Windows 앱 selectors:* 와 같음): 입력창 · 중지 · 답변 읽기 셀렉터만 이 확장에서 직접 고친다
    selectors: {
      get: async (id) => selectorView(id),
      set: async (id, patch) => {
        if (!webService(id) || !patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false };
        X.setLocalSelectors(id, patch);
        reprobe(id);
        return { ok: true, view: selectorView(id) };
      },
      reset: async (id) => {
        if (!webService(id)) return { ok: false };
        X.setLocalSelectors(id, {});
        reprobe(id);
        return { ok: true, view: selectorView(id) };
      },
    },
    // 진단 정보를 채운 GitHub 이슈 양식 (주소는 항상 이 저장소의 issues/new — 제목 · 본문만 받음)
    // 기록 의미 검색 색인 (v0.36.0)
    embed: { status: () => embed.status(), build: () => embed.startBuild(), stop: async () => embed.stopBuild() },
    openIssue: async (title, body) => {
      if (typeof title !== 'string' || typeof body !== 'string' || body.length > 20000) return { ok: false };
      await chrome.tabs.create({ url: UPD.issueUrl(title, body) });
      return { ok: true };
    },
    // 새 버전 알림 (v0.20.0): 확장은 받기 · 설치가 없다 (git pull 후 chrome://extensions에서 ↻)
    update: {
      check: () => checkUpdate(),
      download: async () => X.updateStatus,
      install: async () => false,
      openReleases: () => chrome.tabs.create({ url: UPD.RELEASES_URL }),
    },
    setSidebar: (open) => {
      sidebarOpen = !!open;
      pushState();
    },
    // 변경 바 · 제안 바 줄 수 (v0.28.0: 둘 다 뜨면 2줄). 예전 true/false도 받는다
    setPanelBar: (id, rows) => {
      if (typeof id !== 'string') return;
      const n = MLA.layout.barRows(rows);
      if (n && panels.has(id)) barIds.set(id, n);
      else barIds.delete(id);
      pushState();
    },
    // 프로젝트 모드: 고른 폴더 읽기·쓰기 (project-fs.js, File System Access API)
    project: window.MLA_PROJECT_FS,
    // 프롬프트 라이브러리·스킬 (shared/prompt-lib.js로 검사해서 저장)
    library: {
      load: async () => MLA.promptLib.normalizeLibrary(await load('library', {})),
      save: async (data) => {
        store('library', MLA.promptLib.normalizeLibrary(data));
        return true;
      },
    },
    setLayout: (value) => {
      if (MLA.layout.LAYOUTS.includes(value)) {
        prefs.layout = value;
        focusId = null;
        savePrefs();
        pushState();
      }
    },
    setFocus: (id) => {
      focusId = typeof id === 'string' && hasPanelId(id) && focusId !== id ? id : null;
      pushState();
    },
    panelAction,
    on: (channel, fn) => listeners[channel]?.push(fn),
    // 보고 있는 웹페이지로 질문 (v0.15.0): 오른쪽 클릭 메뉴가 storage.session에 남긴 요청을 한 번 가져가고 지운다
    takeWebAsk: async () => {
      try {
        const got = await chrome.storage.session.get('mla:ask');
        if (!got['mla:ask']) return null;
        await chrome.storage.session.remove('mla:ask');
        return got['mla:ask'];
      } catch {
        return null;
      }
    },
  };

  // ---------- 시작 ----------

  // 앱 탭을 열 때: 설정·기록·원격 셀렉터를 불러오고, 지난번에 고른 모델로 채팅 화면을 엽니다.
  async function init() {
    fixButtonTitles();
    const savedPrefs = await load('prefs', null);
    prefs = { ...prefs, ...(savedPrefs || {}) };
    prefs.onboarded = MLA.onboarding.wasOnboarded(savedPrefs); // 첫 사용 안내 (v0.31.0): 새로 설치한 사람만 한 번
    prefs.layout = MLA.layout.normalizeLayout(prefs.layout);
    // 예전 설정(없어진 서비스, 4개 넘는 선택)을 지금 서비스 목록에 맞춘다.
    prefs.local = normalizeLocalPrefs(prefs.local);
    const hadLocal = Array.isArray(prefs.selected) ? prefs.selected.filter(LL.isLocalId) : [];
    prefs.selected = normalizeSelected(prefs.selected);
    for (const id of hadLocal) if (prefs.local.enabled && LL.panelIndex(id) < prefs.local.panels && prefs.selected.length < MAX_SELECTED) prefs.selected.push(id);
    if (!allServices().some((s) => s.id === prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
    prefs.historyMax = normalizeMax(prefs.historyMax);
    prefs.notify = MLA.notify.normalizePrefs(prefs.notify);
    prefs.sendPreview = prefs.sendPreview === true;
    prefs.retryOnce = prefs.retryOnce !== false;
    prefs.autoRecommend = prefs.autoRecommend === true;
    if (!MLA.recommend.ORDERS.includes(prefs.recommendOrder)) prefs.recommendOrder = 'completion';
    prefs.lang = MLA.i18n.normalizeLangPref(prefs.lang);
    applyLang(prefs.lang); // 적어 둔 값과 달랐으면 첫 state의 uiLang을 보고 화면이 다시 그린다
    history.load(await historyStore.load());
    prefs.historyArchive = prefs.historyArchive === true;
    setArchiveOn(prefs.historyArchive);
    history.setMax(prefs.historyMax);
    sideHistory.load(await load('history:side', []));
    // 마지막으로 받은 원격 셀렉터를 먼저 적용한다 (새로 받아 오는 것은 아래에서).
    await X.loadLocalSelectors();
    await loadRemoteCache();

    const me = await chrome.tabs.getCurrent();
    tabId = me?.id ?? null;
    windowId = me?.windowId ?? null;
    if (tabId === null) {
      alert(MLA.i18n.t('ext.host.openInTab'));
      return;
    }
    await allowFraming();
    // 지난번에 고른 모델로 바로 채팅 화면을 연다. 주소 끝이 #pick이면 모델 선택 화면부터.
    if (location.hash === '#pick') showPick();
    else showChat(prefs.selected);

    if (prefs.remoteSelectors) refreshRemote();
    setInterval(refreshRemote, REMOTE_REFRESH_MS); // 꺼져 있으면 refreshRemote가 아무것도 하지 않는다
    setTimeout(() => prefs.autoUpdate !== false && checkUpdate(), UPD.FIRST_CHECK_MS);
    setInterval(() => prefs.autoUpdate !== false && checkUpdate(), UPD.CHECK_EVERY_MS);
  }

  // 크롬이 페이지에 넘겨주지 않는 키는 바꿔 썼으므로 버튼 안내도 맞춘다 (shared/shortcuts.js의 browserKeys).
  function fixButtonTitles() {
    const newChat = document.getElementById('newChatAll');
    if (newChat) {
      newChat.dataset.i18nTitle = 'ext.host.newChatAll'; // 언어를 바꿔 apply()가 다시 써도 이 안내가 남게 (v0.30.0)
      newChat.title = MLA.i18n.t('ext.host.newChatAll');
    }
    // 사이드탭 (v0.19.0): 크롬 확장에서만 있는 버튼. 누른 그 순간에 열어야 해서 기다리는 일 없이 바로 연다.
    const side = document.getElementById('sideBtn');
    if (side && chrome.sidePanel) {
      side.hidden = false;
      side.addEventListener('click', () => {
        if (windowId !== null) chrome.sidePanel.open({ windowId }).catch((err) => alert(MLA.i18n.t('ext.host.sideFailed', { error: err.message })));
      });
    }
  }

  // 먼저 읽힌 host-panels.js · host-remote.js가 "쓸 때" 찾는 것 (v0.31.0). 값이 바뀌는 것(prefs · tabId)은 읽을 때마다 지금 값을 준다.
  Object.assign(X, { FETCH_TIMEOUT_MS, HELLO_TIMEOUT_MS, LOGIN_CHECK_MS, SERVICES, barIds, diag, framesEl, lastProbe, load, log, panels, probePanel, pushState, remoteCore, rounds, runShortcut, sendPanel, serviceForHost, store });
  Object.defineProperties(X, {
    prefs: { get: () => prefs, enumerable: true },
    tabId: { get: () => tabId, enumerable: true },
  });
  // renderer.js가 host.on(...)으로 화면 갱신 함수를 등록한 뒤에 시작한다.
  window.addEventListener('DOMContentLoaded', () =>
    init().catch((err) => {
      console.error(err);
      alert(MLA.i18n.t('ext.side.startFailed', { error: err.message }));
    }),
  );
})();
