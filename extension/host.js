'use strict';

// 크롬 확장 프로그램의 host.
// Electron 앱에서 preload(window.host) + 메인 프로세스(main.js)가 하던 일을 확장 프로그램 탭 안에서 한다.
// 화면(lib/renderer/renderer.js)은 Electron 앱과 똑같은 파일을 쓰고, 이 파일이 window.host를 만들어 준다.
//
// 서비스 페이지는 iframe으로 띄운다. 패널 머리줄은 화면(renderer)이 그리고, iframe은 Electron의 WebContentsView처럼
// 이 파일이 패널 본문 자리에 겹쳐 놓는다. 그래서 모델 선택 화면을 오가도 iframe이 다시 로드되지 않는다.
// 서비스 페이지와는 content.js(각 iframe 안에서 실행)와 메시지로 주고받는다.

(() => {
  const { SERVICES, MAX_SELECTED, DEFAULT_SELECTED, ATTACH_LIMITS, normalizeSelected, serviceForHost, uploadOf } =
    MLA.services;
  const { watchAnswer } = MLA.watch;
  const { createRounds } = MLA.rounds;
  const { createHistory } = MLA.historyCore;
  const remoteCore = MLA.remoteCore;
  const { shortcutList, shortcutFor } = MLA.shortcuts;

  const HEADER_H = 28; // 패널마다 이름·상태를 그리는 머리줄 높이 (styles.css와 같게)
  const TOOLBAR_H = 44; // 맨 위 공통 툴바 높이
  const COMPOSER_H = 132; // 채팅 화면 맨 아래 공통 입력창 높이 (첨부 파일 줄 포함)
  const GAP = 4;
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

  // ---------- 상태 ----------

  let mode = 'pick'; // 'pick' | 'chat'  (확장 프로그램은 크롬에 로그인된 계정을 그대로 써서 로그인 화면이 없다)
  let chatView = 'panels'; // 'panels' | 'compare' | 'history' | 'help'
  let tabId = null;
  const panels = new Map(); // id -> { iframe, frameId, origin, url, retried, helloTimer, loginTimer }

  const framesEl = document.createElement('div');
  framesEl.id = 'frames';
  document.body.append(framesEl);

  // ---------- iframe 허용 규칙 ----------
  // 서비스 사이트들은 다른 페이지 안(iframe)에 뜨지 않도록 X-Frame-Options·CSP(frame-ancestors) 헤더를 보낸다.
  // 이 탭 안의 iframe으로 여는 서비스 주소에만 그 두 헤더를 지운다. 다른 탭에서 쓰는 사이트에는 영향이 없다.
  // 규칙 번호 = 탭 번호. 탭을 닫으면 background.js가 지운다.
  async function allowFraming() {
    const domains = [...new Set(SERVICES.flatMap((s) => s.hosts))];
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId],
      addRules: [
        {
          id: tabId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'x-frame-options', operation: 'remove' },
              { header: 'content-security-policy', operation: 'remove' },
            ],
          },
          condition: { tabIds: [tabId], resourceTypes: ['sub_frame'], requestDomains: domains },
        },
      ],
    });
  }

  // ---------- 패널 (iframe) ----------

  const svcOf = (id) => SERVICES.find((s) => s.id === id);

  function openPanel(svc) {
    const iframe = document.createElement('iframe');
    iframe.className = 'svc-frame';
    iframe.dataset.id = svc.id;
    // 답변 복사 버튼·음성 입력이 iframe 안에서도 동작하도록 권한을 넘긴다.
    iframe.allow = 'clipboard-read; clipboard-write; microphone';
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
  }

  /** 패널 페이지의 content.js에 요청을 보낸다. */
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
    const svc = serviceForHost(String(msg.host || ''));
    const p = svc && panels.get(svc.id);
    // 이 탭의 패널 iframe에서 온 것만 받는다.
    if (!p || !sender.frameId) return;
    if (msg.type === 'mla:hello') {
      log('hello', svc.id, sender.frameId, msg.url);
      p.frameId = sender.frameId;
      p.origin = new URL(msg.url).origin; // 첨부 파일은 이 주소의 페이지에만 넘긴다
      p.url = msg.url;
      p.retried = false;
      clearTimeout(p.helloTimer);
      sendPanel(svc.id, { url: msg.url, loading: false });
      scheduleLoginCheck(svc.id);
    } else if (msg.type === 'mla:nav' && p.frameId === sender.frameId) {
      p.url = msg.url;
      sendPanel(svc.id, { url: msg.url });
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

  // Electron 앱(main.js computeRects)과 같은 배치: 격자는 4개일 때 2×2, 가로는 한 줄에 모두.
  function computeRects() {
    if (mode !== 'chat') return [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ids = SERVICES.map((s) => s.id).filter((id) => panels.has(id));
    const n = ids.length;
    const cols = prefs.layout === 'row' || n <= 3 ? n : 2;
    const rows = Math.ceil(n / cols);
    const cellW = Math.floor((w - GAP * (cols + 1)) / cols);
    const panelsH = h - TOOLBAR_H - COMPOSER_H;
    const cellH = Math.floor((panelsH - GAP * (rows + 1)) / rows);
    return ids.map((id, i) => {
      const x = GAP + (i % cols) * (cellW + GAP);
      const y = TOOLBAR_H + GAP + Math.floor(i / cols) * (cellH + GAP);
      return {
        id,
        frame: { x, y, width: cellW, height: cellH },
        content: { x, y: y + HEADER_H, width: cellW, height: Math.max(0, cellH - HEADER_H) },
      };
    });
  }

  function pushState() {
    const rects = computeRects();
    // 모델 선택·비교·기록·도움말 화면에서는 iframe을 화면 밖으로 옮겨 둔다.
    // display:none으로 숨기면 페이지 배치가 0이 되어 답변을 읽지 못한다. 크기는 그대로 두어 답변 감시가 계속된다.
    const showPanels = mode === 'chat' && chatView === 'panels';
    for (const r of rects) {
      const p = panels.get(r.id);
      if (!p) continue;
      Object.assign(p.iframe.style, {
        left: `${showPanels ? r.content.x : -20000}px`,
        top: `${r.content.y}px`,
        width: `${r.content.width}px`,
        height: `${r.content.height}px`,
      });
      p.iframe.tabIndex = showPanels ? 0 : -1;
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
      services: SERVICES.map((s) => ({ id: s.id, name: s.name, color: s.color, url: s.url, accept: uploadOf(s).accept })),
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
    sendPrompt: async (id, text, files) => {
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
      const res = await callFrame(id, { type: 'mla:send', cfg: sendCfg(svc), text, upload });
      return res || { ok: false, error: '패널 페이지가 응답하지 않았습니다' };
    },
    snapshot,
    watch: (id, before, isCurrent, onState) =>
      watchAnswer(() => snapshot(id), before, isCurrent, onState, { maxMs: prefs.answerTimeoutMin * 60 * 1000 }),
    sendPanel,
    sendSynthStatus: (patch) => emit('synth:status', patch),
    history,
    prefs: () => prefs,
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

  function panelAction(id, action) {
    const ids = id === '*' ? [...panels.keys()] : [id].filter((x) => panels.has(x));
    for (const pid of ids) {
      const svc = svcOf(pid);
      const p = panels.get(pid);
      if (action === 'reload') {
        // 지금 주소로 다시 연다. 페이지 안에서 새로고침하면 서비스 워커가 다시 받아 와 막힐 수 있어 navigate를 쓴다.
        p.retried = false;
        navigate(pid, p.url || svc.url);
      } else if (action === 'home') navigate(pid, svc.url);
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

  async function refreshRemote() {
    if (!prefs.remoteSelectors) return remoteStatus;
    const checkedAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(remoteCore.DEFAULT_URL, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const clean = remoteCore.sanitize(data, SERVICES);
      if (!clean) throw new Error('형식이 올바르지 않습니다');
      remoteCore.apply(SERVICES, remoteBase, clean.overrides);
      store('remoteSelectors', data);
      remoteStatus = {
        source: 'remote',
        version: clean.version,
        updated: clean.updated,
        services: Object.keys(clean.overrides),
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
    sendPrompt: async (text, targets, files = []) => {
      if (typeof text !== 'string' || !Array.isArray(targets)) return [];
      if (!checkFiles(files)) return targets.map((id) => ({ id, ok: false, error: '첨부 파일이 한도를 넘었습니다' }));
      if (!text.trim() && !files.length) return [];
      return rounds.sendAll(text, targets, files);
    },
    copyAnswer: async (id) => {
      const { text, copied, total } = await rounds.collectMarkdown(id);
      if (copied) await copyText(text);
      return { copied, total };
    },
    setView: (value) => {
      if (mode === 'chat' && ['panels', 'compare', 'history', 'help'].includes(value)) {
        chatView = value;
        pushState();
      }
    },
    getAnswers: () => rounds.answers(),
    history: {
      list: async (query) => history.list(typeof query === 'string' ? query : ''),
      get: async (id) => history.get(id),
      remove: async (id) => history.remove(id),
      clear: async () => history.clear(),
    },
    copyText: (text) => typeof text === 'string' && copyText(text),
    shortcuts: async () => shortcutList({ browser: true }),
    runSynth: (judgeId) => rounds.runSynth(typeof judgeId === 'string' ? judgeId : null),
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
    setLayout: (value) => {
      if (value === 'grid' || value === 'row') {
        prefs.layout = value;
        savePrefs();
        pushState();
      }
    },
    panelAction,
    on: (channel, fn) => listeners[channel]?.push(fn),
  };

  // ---------- 시작 ----------

  async function init() {
    fixButtonTitles();
    prefs = { ...prefs, ...(await load('prefs', {})) };
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
