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
  const { SERVICES, MAX_SELECTED, DEFAULT_SELECTED, ATTACH_LIMITS, normalizeSelected, serviceForHost, uploadOf, fileBytesOf } =
    MLA.services;
  const { watchAnswer } = MLA.watch;
  const { createRounds } = MLA.rounds;
  const { createDiag } = MLA.diag;
  const { createHistory } = MLA.historyCore;
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
  };
  const savePrefs = () => store('prefs', prefs);

  const history = createHistory((records) => store('history', records));

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
  const barIds = new Set(); // 변경 바를 띄운 패널 — iframe 아래쪽을 바 높이만큼 비운다
  let tabId = null;
  const panels = new Map(); // id -> { iframe, frameId, origin, url, retried, helloTimer, loginTimer }

  const framesEl = document.createElement('div');
  framesEl.id = 'frames';
  document.body.append(framesEl);

  // ---------- iframe 허용 규칙 ----------
  // 서비스 사이트들은 다른 페이지 안(iframe)에 뜨지 않도록 X-Frame-Options·CSP(frame-ancestors) 헤더를 보낸다.
  // 이 탭 안의 서비스 iframe에서만 그 두 헤더를 지우는 규칙을 background.js가 건다.
  // 이 화면이 연결선을 열어 두는 동안만 규칙이 있고, 화면이 사라지면(다른 주소로 이동·닫기·새로고침) 바로 지워진다.
  const PAGE_ID = crypto.randomUUID(); // 이 화면의 번호 (새로고침하면 바뀐다)
  const PING_MS = 25000; // 백그라운드가 잠들지 않게 보내는 신호 간격
  let port = null;

  /** 백그라운드에 연결하고 규칙이 걸릴 때까지 기다린다. 연결이 끊기면(확장 업데이트 등) 다시 연결한다. */
  // AI 사이트는 보통 "다른 페이지 안에 띄우지 마"라는 표시를 보냅니다. 이 앱 탭 안에서만 그 표시를 무시하도록
  // background.js에 부탁합니다 (앱 탭을 떠나면 바로 해제).
  function allowFraming() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('백그라운드가 응답하지 않습니다')), 10000);
      port = chrome.runtime.connect({ name: 'mla-app' });
      port.onMessage.addListener((msg) => {
        if (msg?.type !== 'ready') return;
        clearTimeout(timer);
        resolve();
      });
      port.onDisconnect.addListener(() => {
        port = null;
        // 화면은 그대로인데 연결만 끊겼다(백그라운드 재시작 등). 다시 연결해 규칙을 되살린다.
        setTimeout(() => allowFraming().catch((err) => console.warn('[host] 다시 연결하지 못했습니다:', err.message)), 500);
      });
      port.postMessage({ type: 'hello', pageId: PAGE_ID });
    });
  }
  setInterval(() => {
    try {
      port?.postMessage({ type: 'ping' });
    } catch {}
  }, PING_MS);

  // ---------- 패널 (iframe) ----------

  const svcOf = (id) => SERVICES.find((s) => s.id === id);

  /** 서비스 하나의 iframe 패널을 엽니다. 처음에는 화면 밖에 두고, pushState가 제자리로 옮깁니다. */
  function openPanel(svc) {
    const iframe = document.createElement('iframe');
    iframe.className = 'svc-frame';
    iframe.dataset.id = svc.id;
    // 답변 복사 버튼·음성 입력이 iframe 안에서도 동작하도록 권한을 넘긴다 (마이크는 쓸 때 크롬이 따로 묻는다).
    // 클립보드 읽기는 넘기지 않는다 — Ctrl+V 붙여넣기는 이 권한 없이도 된다.
    iframe.allow = 'clipboard-write; microphone';
    const p = { iframe, frameId: null, origin: null, url: svc.url, retried: false, helloTimer: null, loginTimer: null };
    iframe.addEventListener('load', () => {
      sendPanel(svc.id, { loading: false });
      // content.js가 연결되지 않으면 사이트가 iframe을 막았거나 로그인 화면(다른 도메인)으로 넘어간 것이다.
      clearTimeout(p.helloTimer);
      p.helloTimer = setTimeout(() => {
        if (p.frameId !== null) return;
        // 사이트의 서비스 워커가 그사이 다시 생겨 막혔을 수 있다. 한 번은 지우고 다시 열어 본다.
        if (!p.retried) {
          p.retried = true;
          log('retry', svc.id, 'no hello — clearing service worker and reloading');
          navigate(svc.id, p.url || svc.url);
          return;
        }
        sendPanel(svc.id, { login: 'needs-login' });
        sendPanel(svc.id, { error: '페이지와 연결되지 않았습니다 — "로그인 탭"에서 로그인한 뒤 ↻를 눌러 주세요' });
      }, HELLO_TIMEOUT_MS);
    });
    framesEl.append(iframe);
    panels.set(svc.id, p);
    navigate(svc.id, svc.url);
  }

  // 사이트가 서비스 워커(PWA)를 등록해 두면 iframe 페이지를 그 서비스 워커가 대신 받아 온다.
  // 서비스 워커의 요청은 이 탭 소속이 아니라서 iframe 허용 규칙(allowFraming)이 적용되지 않고,
  // 원래의 X-Frame-Options·CSP가 남아 크롬이 iframe을 막는다 (회색 "연결 거부" 화면 — Perplexity에서 확인).
  // 그래서 패널을 열 때마다 그 서비스의 서비스 워커 등록만 지운다. 로그인(쿠키)·저장된 데이터는 지우지 않는다.
  async function clearServiceWorkers(svc) {
    try {
      await chrome.browsingData.removeServiceWorkers({ origins: svc.hosts.map((h) => `https://${h}`) });
    } catch (err) {
      console.warn(`[sw] ${svc.id} 서비스 워커를 지우지 못했습니다:`, err.message);
    }
  }

  async function navigate(id, url) {
    const p = panels.get(id);
    if (!p) return;
    p.frameId = null; // 새 페이지의 content.js가 다시 연결한다
    p.url = url;
    sendPanel(id, { loading: true, url });
    await clearServiceWorkers(svcOf(id));
    if (panels.get(id) === p) p.iframe.src = url;
  }

  function closePanel(id) {
    const p = panels.get(id);
    clearTimeout(p.helloTimer);
    clearTimeout(p.loginTimer);
    p.iframe.remove();
    panels.delete(id);
    barIds.delete(id);
  }

  /** 패널 페이지의 content.js에 요청을 보낸다. */
  // 패널 iframe 안의 content.js에 일을 시키고 답을 받습니다 (예: 질문 넣기, 지금 상태 읽기).
  async function callFrame(id, msg) {
    const p = panels.get(id);
    if (!p || p.frameId === null) throw new Error('패널 페이지와 아직 연결되지 않았습니다');
    return chrome.tabs.sendMessage(tabId, msg, { frameId: p.frameId });
  }

  function scheduleLoginCheck(id) {
    const p = panels.get(id);
    clearTimeout(p.loginTimer);
    p.loginTimer = setTimeout(async () => {
      try {
        const out = await callFrame(id, { type: 'mla:loggedOut', cfg: { loggedOut: svcOf(id).loggedOut || {} } });
        sendPanel(id, { login: out ? 'needs-login' : 'ready' });
        if (!out) probePanel(id); // 로그인된 화면에서 입력창이 보이는지 살펴본다
      } catch {}
    }, LOGIN_CHECK_MS);
  }

  // 서비스 페이지(content.js)에서 오는 메시지
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== 'string' || sender.tab?.id !== tabId) return;
    if (msg.type === 'mla:key') {
      if (typeof msg.action === 'string') runShortcut(msg.action);
      return;
    }
    // 보낸 프레임의 주소는 메시지 내용이 아니라 크롬이 알려 주는 sender.url로 본다.
    let from;
    try {
      from = new URL(sender.url);
    } catch {
      return;
    }
    const svc = from.protocol === 'https:' ? serviceForHost(from.hostname) : null;
    const p = svc && panels.get(svc.id);
    // 이 탭의 패널 iframe에서 온 것만 받는다.
    if (!p || !sender.frameId) return;
    // 화면에 보여 줄 지금 주소(사이트 안 이동 반영)는 메시지의 url을 쓰되, 보낸 프레임과 같은 origin일 때만 믿는다.
    let url = sender.url;
    try {
      if (typeof msg.url === 'string' && new URL(msg.url).origin === from.origin) url = msg.url;
    } catch {}
    if (msg.type === 'mla:hello') {
      log('hello', svc.id, sender.frameId, sender.url);
      p.frameId = sender.frameId;
      p.origin = from.origin; // 첨부 파일은 이 주소의 페이지에만 넘긴다
      p.url = url;
      p.retried = false;
      clearTimeout(p.helloTimer);
      sendPanel(svc.id, { url, loading: false });
      scheduleLoginCheck(svc.id);
    } else if (msg.type === 'mla:nav' && p.frameId === sender.frameId) {
      p.url = url;
      sendPanel(svc.id, { url });
      scheduleLoginCheck(svc.id);
    }
  });

  // ---------- 화면 전환 · 배치 ----------

  function showPick() {
    mode = 'pick';
    pushState(); // 열린 패널은 살려 두되 화면에서만 뺀다. 다시 열면 대화가 그대로 남아 있다.
  }

  function showChat(selected) {
    const ids = SERVICES.map((s) => s.id).filter((id) => selected.includes(id)).slice(0, MAX_SELECTED);
    if (!ids.length) return;
    prefs.selected = ids;
    savePrefs();
    for (const id of [...panels.keys()]) if (!ids.includes(id)) closePanel(id);
    for (const id of ids) if (!panels.has(id)) openPanel(svcOf(id));
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
    const ids = SERVICES.map((s) => s.id).filter((id) => panels.has(id));
    if (focusId && !ids.includes(focusId)) focusId = null;
    const cells = MLA.layout.placeCells(prefs.layout, ids.length, box, GAP);
    const [big] = MLA.layout.placeCells('grid', 1, box, GAP);
    return ids.map((id, i) => {
      const frame = focusId === id ? big : cells[i];
      const bar = barIds.has(id) ? BAR_H : 0;
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
      remoteSelectors: prefs.remoteSelectors,
      remote: remoteStatus,
      diag: diag.all(SERVICES.map((s) => s.id)),
      services: SERVICES.map((s) => ({ id: s.id, name: s.name, color: s.color, url: s.url, accept: uploadOf(s).accept, maxFileBytes: fileBytesOf(s) })),
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

  const rounds = createRounds({
    services: SERVICES,
    hasPanel: (id) => panels.has(id),
    sendPrompt: async (id, text, files, { fallbackText } = {}) => {
      const svc = svcOf(id);
      let upload = null;
      if (files.length) {
        // 확장 메시지는 JSON만 실을 수 있어서, 파일은 iframe에 postMessage로 그대로(구조적 복제) 넘긴다.
        // content.js는 이 번호(nonce)로 받은 파일을 찾아 첨부한다.
        const p = panels.get(id);
        if (!p?.origin) throw new Error('패널 페이지와 아직 연결되지 않았습니다');
        const nonce = crypto.randomUUID();
        p.iframe.contentWindow.postMessage({ mla: 'files', nonce, files }, p.origin);
        upload = { nonce, cfg: uploadOf(svc) };
      }
      const res = await callFrame(id, { type: 'mla:send', cfg: sendCfg(svc), text, upload, fallbackText });
      return res || { ok: false, error: '패널 페이지가 응답하지 않았습니다' };
    },
    snapshot,
    watch: (id, before, isCurrent, onState) =>
      watchAnswer(() => snapshot(id), before, isCurrent, onState, { maxMs: prefs.answerTimeoutMin * 60 * 1000 }),
    sendPanel,
    sendSynthStatus: (patch) => emit('synth:status', patch),
    history,
    prefs: () => prefs,
    diag,
    log,
  });

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
        sendPanel(pid, { answer: 'clear' });
        navigate(pid, svc.url);
      }
      else if (action === 'back') callFrame(pid, { type: 'mla:back' }).catch(() => {});
      else if (action === 'login') chrome.tabs.create({ url: svc.url }); // 일반 탭에서 로그인 → 돌아와서 ↻
      else if (action === 'newchat') {
        rounds.cancelWatch(pid);
        sendPanel(pid, { answer: 'clear' });
        navigate(pid, svc.newChatUrl);
      }
    }
  }

  // ---------- 사이트 셀렉터 원격 갱신 ----------

  const remoteBase = remoteCore.snapshotBase(SERVICES);
  let remoteStatus = { source: 'builtin' };

  // 사이트 셀렉터 원격 갱신 (Windows 앱의 remote.js와 같은 일). 받은 값은 확장 저장소에 기억합니다.
  async function refreshRemote() {
    if (!prefs.remoteSelectors) return remoteStatus;
    const checkedAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      // 리다이렉트는 따라가지 않는다 (정해 둔 주소의 파일만 받는다)
      const res = await fetch(remoteCore.DEFAULT_URL, { cache: 'no-store', redirect: 'error', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const clean = remoteCore.sanitize(data, SERVICES);
      if (!clean) throw new Error('형식이 올바르지 않습니다');
      remoteCore.apply(SERVICES, remoteBase, clean.overrides);
      store('remoteSelectors', data);
      // 새 셀렉터를 받았으면 자가진단 기록을 지우고 다시 확인한다
      if (clean.version !== remoteStatus.version) {
        diag.reset();
        lastProbe.clear();
        for (const id of panels.keys()) probePanel(id);
      }
      remoteStatus = {
        source: 'remote',
        version: clean.version,
        updated: clean.updated,
        services: Object.keys(clean.overrides),
        ignored: clean.ignored, // 보안상 원격으로 바꾸지 않는 항목(버튼 셀렉터 등)이라 무시한 것
        checkedAt,
      };
    } catch (err) {
      remoteStatus = { ...remoteStatus, checkedAt, error: err.name === 'AbortError' ? '시간 초과' : err.message };
    } finally {
      clearTimeout(timer);
    }
    log('remote', JSON.stringify(remoteStatus));
    pushState();
    return remoteStatus;
  }

  function resetRemote() {
    remoteCore.apply(SERVICES, remoteBase, {});
    remoteStatus = { source: 'builtin' };
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
    ui: {
      hints: {
        pick: '모델을 고르세요 · 각 서비스에는 이 크롬에 로그인된 계정을 그대로 씁니다',
        chat: '로그인이 필요한 패널은 "로그인 탭"에서 로그인한 뒤 ↻를 누르세요',
      },
      pickNote: '선택한 모델만 패널로 엽니다. 처음 한 번은 각 서비스에 크롬 탭에서 로그인해 두세요.',
      loginButton: { label: '로그인 탭', title: '새 탭에서 이 서비스에 로그인한 뒤, 돌아와서 ↻를 누르세요' },
      devtools: false, // 패널 페이지는 F12 개발자 도구의 프레임 선택으로 본다
    },
    openModels: (ids) => Array.isArray(ids) && showChat(ids.filter((id) => typeof id === 'string')),
    pickModels: () => mode === 'chat' && showPick(),
    logout: () => {},
    // opts: { question(기록·종합용 질문), textById({ 서비스 id: 그 서비스에 보낼 글 }), fallbackText(첨부 실패 때 대신 보낼 글) }
    sendPrompt: async (text, targets, files = [], opts = {}) => {
      if (typeof text !== 'string' || !Array.isArray(targets)) return [];
      if (!checkFiles(files)) return targets.map((id) => ({ id, ok: false, error: '첨부 파일이 한도를 넘었습니다' }));
      if (!text.trim() && !files.length) return [];
      return rounds.sendAll(text, targets, files, opts || {});
    },
    // opts: { fallbackText(첨부 실패 때 대신 보낼 글) }
    sendFollowUp: async (id, text, files = [], opts = {}) => {
      if (typeof text !== 'string' || !text.trim()) return { id, ok: false, error: '보낼 내용이 없습니다' };
      if (!checkFiles(files)) return { id, ok: false, error: '첨부 파일이 한도를 넘었습니다' };
      return rounds.sendFollowUp(id, text, files, opts || {});
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
      list: async (query) => history.list(typeof query === 'string' ? query : ''),
      get: async (id) => history.get(id),
      remove: async (id) => history.remove(id),
      clear: async () => history.clear(),
    },
    copyText: (text) => typeof text === 'string' && copyText(text),
    shortcuts: async () => shortcutList({ browser: true }),
    runSynth: (judgeId, kind) =>
      rounds.runSynth(typeof judgeId === 'string' ? judgeId : null, 'manual', ['code', 'analysis'].includes(kind) ? kind : 'text'),
    setSynth: ({ target, auto }) => {
      if (typeof target === 'string' && SERVICES.some((s) => s.id === target)) prefs.synthTarget = target;
      if (typeof auto === 'boolean') prefs.autoSynth = auto;
      savePrefs();
      pushState();
    },
    setSettings: ({ answerTimeoutMin, remoteSelectors }) => {
      if (TIMEOUT_CHOICES.includes(answerTimeoutMin)) prefs.answerTimeoutMin = answerTimeoutMin;
      if (typeof remoteSelectors === 'boolean' && remoteSelectors !== prefs.remoteSelectors) {
        prefs.remoteSelectors = remoteSelectors;
        if (remoteSelectors) refreshRemote();
        else resetRemote();
      }
      savePrefs();
      pushState();
    },
    refreshRemote: () => refreshRemote(),
    setSidebar: (open) => {
      sidebarOpen = !!open;
      pushState();
    },
    setPanelBar: (id, on) => {
      if (typeof id !== 'string') return;
      if (on && panels.has(id)) barIds.add(id);
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
      focusId = typeof id === 'string' && panels.has(id) && focusId !== id ? id : null;
      pushState();
    },
    panelAction,
    on: (channel, fn) => listeners[channel]?.push(fn),
  };

  // ---------- 시작 ----------

  // 앱 탭을 열 때: 설정·기록·원격 셀렉터를 불러오고, 지난번에 고른 모델로 채팅 화면을 엽니다.
  async function init() {
    fixButtonTitles();
    prefs = { ...prefs, ...(await load('prefs', {})) };
    prefs.layout = MLA.layout.normalizeLayout(prefs.layout);
    // 예전 설정(없어진 서비스, 4개 넘는 선택)을 지금 서비스 목록에 맞춘다.
    prefs.selected = normalizeSelected(prefs.selected);
    if (!SERVICES.some((s) => s.id === prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
    history.load(await load('history', []));
    // 마지막으로 받은 원격 셀렉터를 먼저 적용한다 (새로 받아 오는 것은 아래에서).
    const cached = prefs.remoteSelectors && remoteCore.sanitize(await load('remoteSelectors', null), SERVICES);
    if (cached) {
      remoteCore.apply(SERVICES, remoteBase, cached.overrides);
      remoteStatus = { source: 'cache', version: cached.version, updated: cached.updated };
    }

    tabId = (await chrome.tabs.getCurrent())?.id ?? null;
    if (tabId === null) {
      alert('Multitude LLM은 크롬 탭에서 열어야 합니다. 툴바의 확장 프로그램 아이콘을 눌러 주세요.');
      return;
    }
    await allowFraming();
    // 지난번에 고른 모델로 바로 채팅 화면을 연다. 주소 끝이 #pick이면 모델 선택 화면부터.
    if (location.hash === '#pick') showPick();
    else showChat(prefs.selected);

    if (prefs.remoteSelectors) refreshRemote();
    setInterval(refreshRemote, REMOTE_REFRESH_MS); // 꺼져 있으면 refreshRemote가 아무것도 하지 않는다
  }

  // 크롬이 페이지에 넘겨주지 않는 키는 바꿔 썼으므로 버튼 안내도 맞춘다 (shared/shortcuts.js의 browserKeys).
  function fixButtonTitles() {
    const newChat = document.getElementById('newChatAll');
    if (newChat) newChat.title = 'Alt+Shift+N';
  }

  // renderer.js가 host.on(...)으로 화면 갱신 함수를 등록한 뒤에 시작한다.
  window.addEventListener('DOMContentLoaded', () =>
    init().catch((err) => {
      console.error(err);
      alert(`시작하지 못했습니다: ${err.message}`);
    }),
  );
})();
