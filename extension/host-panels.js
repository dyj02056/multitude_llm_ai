// 크롬 확장 host — 패널(iframe): iframe 허용 규칙 · 패널 열기/닫기 · content script와 말하기(callFrame) · 이동(navigate).
// v0.31.0에서 host.js에서 떼어 냈다. app.html에서 host.js보다 먼저 읽힌다 (scripts/build-extension.js).
// host.js의 것(패널 목록 · 설정 · 로그 등)은 공유 객체 X(MLA.extHost)에서 "쓸 때" 찾는다 — 읽히는 시점에는 아직 없다.
// 이 파일이 만드는 것(allowFraming · callFrame · closePanel · navigate · openPanel · svcOf)은 X에 실어 host.js가 꺼내 쓴다.
//
// [쉽게 말하면] 앱 탭 안에 AI 사이트를 작은 창(iframe)으로 띄우고, 그 안에서 도는 content.js와 주고받는 부분입니다.
(() => {
  'use strict';
  const X = (MLA.extHost = MLA.extHost || {});
  const { SERVICES, serviceForHost } = MLA.services;

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
      const timer = setTimeout(() => reject(new Error(MLA.i18n.t('ext.side.bgNoAnswer'))), 10000);
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
      X.sendPanel(svc.id, { loading: false });
      // content.js가 연결되지 않으면 사이트가 iframe을 막았거나 로그인 화면(다른 도메인)으로 넘어간 것이다.
      clearTimeout(p.helloTimer);
      p.helloTimer = setTimeout(() => {
        if (p.frameId !== null) return;
        // 사이트의 서비스 워커가 그사이 다시 생겨 막혔을 수 있다. 한 번은 지우고 다시 열어 본다.
        if (!p.retried) {
          p.retried = true;
          X.log('retry', svc.id, 'no hello — clearing service worker and reloading');
          navigate(svc.id, p.url || svc.url);
          return;
        }
        X.sendPanel(svc.id, { login: 'needs-login' });
        X.sendPanel(svc.id, { error: MLA.i18n.t('ext.host.notLinked') });
      }, X.HELLO_TIMEOUT_MS);
    });
    X.framesEl.append(iframe);
    X.panels.set(svc.id, p);
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
    const p = X.panels.get(id);
    if (!p) return;
    p.frameId = null; // 새 페이지의 content.js가 다시 연결한다
    p.url = url;
    X.sendPanel(id, { loading: true, url });
    await clearServiceWorkers(svcOf(id));
    if (X.panels.get(id) === p) p.iframe.src = url;
  }

  function closePanel(id) {
    const p = X.panels.get(id);
    clearTimeout(p.helloTimer);
    clearTimeout(p.loginTimer);
    p.iframe.remove();
    X.panels.delete(id);
    X.barIds.delete(id);
    X.rounds.resetPanel(id);
  }

  /** 패널 페이지의 content.js에 요청을 보낸다. */
  // 패널 iframe 안의 content.js에 일을 시키고 답을 받습니다 (예: 질문 넣기, 지금 상태 읽기).
  async function callFrame(id, msg) {
    const p = X.panels.get(id);
    if (!p || p.frameId === null) throw new Error(MLA.i18n.t('ext.side.notLinked'));
    // content.js는 사전이 없어 실패 이유를 code로 준다 → 지금 언어의 글로 (v0.30.0)
    return MLA.i18n.pageError(await chrome.tabs.sendMessage(X.tabId, msg, { frameId: p.frameId }));
  }

  function scheduleLoginCheck(id) {
    const p = X.panels.get(id);
    clearTimeout(p.loginTimer);
    p.loginTimer = setTimeout(async () => {
      try {
        const out = await callFrame(id, { type: 'mla:loggedOut', cfg: { loggedOut: svcOf(id).loggedOut || {} } });
        X.sendPanel(id, { login: out ? 'needs-login' : 'ready' });
        if (!out) X.probePanel(id); // 로그인된 화면에서 입력창이 보이는지 살펴본다
      } catch {}
    }, X.LOGIN_CHECK_MS);
  }

  // 이 확장의 background.js에서 오는 알림: 오른쪽 클릭 메뉴 "Multitude LLM에 묻기" (v0.15.0) — 화면(renderer.js)이 요청을 가져간다
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'mla:ask' || sender.id !== chrome.runtime.id || sender.tab) return;
    window.dispatchEvent(new Event('mla:web-ask'));
  });

  // 서비스 페이지(content.js)에서 오는 메시지
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== 'string' || sender.tab?.id !== X.tabId) return;
    if (msg.type === 'mla:key') {
      if (typeof msg.action === 'string') X.runShortcut(msg.action);
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
    const p = svc && X.panels.get(svc.id);
    // 이 탭의 패널 iframe에서 온 것만 받는다.
    if (!p || !sender.frameId) return;
    // 화면에 보여 줄 지금 주소(사이트 안 이동 반영)는 메시지의 url을 쓰되, 보낸 프레임과 같은 origin일 때만 믿는다.
    let url = sender.url;
    try {
      if (typeof msg.url === 'string' && new URL(msg.url).origin === from.origin) url = msg.url;
    } catch {}
    if (msg.type === 'mla:hello') {
      X.log('hello', svc.id, sender.frameId, sender.url);
      p.frameId = sender.frameId;
      p.origin = from.origin; // 첨부 파일은 이 주소의 페이지에만 넘긴다
      p.url = url;
      p.retried = false;
      clearTimeout(p.helloTimer);
      X.sendPanel(svc.id, { url, loading: false });
      scheduleLoginCheck(svc.id);
    } else if (msg.type === 'mla:nav' && p.frameId === sender.frameId) {
      p.url = url;
      X.sendPanel(svc.id, { url });
      scheduleLoginCheck(svc.id);
    }
  });

  Object.assign(X, { allowFraming, callFrame, closePanel, navigate, openPanel, svcOf });
})();
