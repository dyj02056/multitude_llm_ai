'use strict';

// 사이드탭 모드 (v0.19.0, 크롬 확장 전용): 크롬 오른쪽 사이드 패널에 AI 웹 채팅을 최대 2개 띄우고,
// 보고 있는 웹페이지의 본문을 함께 보내 묻는다.
//
// [쉽게 말하면]
//   - 처음: background.js에 연결해 "사이드 패널 안 iframe 허용 규칙"을 걸어 달라고 한 뒤, 고른 모델의 사이트를 iframe으로 띄웁니다.
//   - 각 iframe 안의 content.js가 iframe 이름(mla-side:<이 화면 번호>:<서비스>)으로 이 화면에 연결선을 열고,
//     이 화면은 그 연결선으로 "질문 넣고 보내" · "답변 읽어 와"를 시킵니다 (앱 탭의 host.js와 같은 요청).
//   - 페이지 본문(맥락): 오른쪽 클릭 메뉴 "사이드탭에서 이 페이지로 묻기"나 Alt+Shift+S를 누르면 background.js가
//     그 탭의 글을 읽어 storage.session에 두고, 이 화면이 가져갑니다. 그 패널에 처음 보낼 때만 page.md로 첨부합니다.
//   - 모든 사이트 권한은 받지 않습니다. ↻(가져오기)는 단축키 · 메뉴로 받은 그 탭 한 번 권한이 남아 있을 때만 됩니다.
(() => {
  const { SERVICES, serviceForHost, uploadOf } = MLA.services;
  const SP = MLA.sidePanel;
  const W = MLA.webAsk;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
  const { watchAnswer } = MLA.watch;
  const remoteCore = MLA.remoteCore;
  const PL = MLA.promptLib;

  const NONCE = crypto.randomUUID(); // 이 사이드 패널 화면의 번호 — 다른 창의 사이드 패널과 연결선이 섞이지 않게
  const HELLO_TIMEOUT_MS = 8000;
  const LOGIN_CHECK_MS = 1500;
  const CALL_TIMEOUT_MS = 90000; // 첨부 업로드를 기다리는 보내기도 있어 넉넉히
  const ANSWER_MAX_MS = 20 * 60 * 1000;
  const FALLBACK_MAX = 50000; // 첨부에 실패했을 때 본문에 넣어 보내는 페이지 글의 최대 글자 수
  const APP_URL = chrome.runtime.getURL('app.html');

  const $ = (sel) => document.querySelector(sel);
  const svcOf = (id) => SERVICES.find((s) => s.id === id);
  const webServices = () => SERVICES.filter((s) => (s.kind || 'web') === 'web');

  let windowId = null;
  let prefs = { selected: [...SP.DEFAULT_SIDE], ratio: 0.5, ctxOn: true, tpl: '', skill: '' };
  let lib = PL.normalizeLibrary({}); // 앱 라이브러리 (읽기만, v0.21.0)
  // 사이드탭 기록 (v0.21.0): 'history:side'에 남기고, 앱 탭의 기록 화면이 `side` 표시와 함께 보여 준다
  const sideHistory = MLA.historyCore.createHistory((records) => chrome.storage.local.set({ 'history:side': records }).catch(() => {}));
  let ctx = null; // 가져온 페이지 { title, url, text, truncated, at, tabId }
  let ctxError = '';
  let activeTabId = null;
  let shortcut = 'Alt+Shift+S'; // 크롬이 실제로 지정한 사이드탭 단축키 (시작할 때 확인)
  // 자동 읽기 (v0.19.2): 사용자가 "자동 읽기 켜기"로 사이트 읽기 권한(선택 권한)을 허용하면, 보고 있는 탭을
  // 탭을 옮기거나 페이지가 바뀔 때마다, 그리고 보낼 때마다 다시 읽는다 (Gemini 사이드 패널처럼).
  // 허용하지 않으면 예전처럼 단축키 · 오른쪽 클릭 메뉴로 받은 그 탭 한 번 권한으로만 읽는다.
  const AUTO_ORIGINS = ['http://*/*', 'https://*/*'];
  let autoRead = false;
  const panes = new Map(); // id -> { el, iframe, dot, url, status, port, pending, seq, helloTimer, loginTimer, retried, sentKey, watch, curUrl }

  const savePrefs = () => chrome.storage.local.set({ sidePrefs: prefs }).catch(() => {});
  const hint = (text, kind = '') => {
    const el = $('#spHint');
    el.textContent = text;
    el.dataset.kind = kind;
  };
  const button = (label, title, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  const span = (cls, text = '') => Object.assign(document.createElement('span'), { className: cls, textContent: text });

  // ---------- iframe 허용 규칙 (background.js) ----------
  // 이 화면이 연결선을 열어 두는 동안만 규칙이 있다. 연결이 끊기면(백그라운드 재시작 등) 다시 연결해 되살린다.
  let bgPort = null;
  function allowFraming() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('백그라운드가 응답하지 않습니다')), 10000);
      const port = (bgPort = chrome.runtime.connect({ name: 'mla-side' }));
      port.onMessage.addListener((msg) => {
        if (msg?.type !== 'ready') return;
        clearTimeout(timer);
        resolve();
      });
      port.onDisconnect.addListener(() => {
        bgPort = null;
        setTimeout(() => allowFraming().catch(() => {}), 500);
      });
      port.postMessage({ type: 'hello', pageId: NONCE });
    });
  }
  // 백그라운드가 잠들지 않게 보내는 신호
  setInterval(() => {
    try {
      bgPort?.postMessage({ type: 'ping' });
    } catch {}
  }, 25000);

  // ---------- 패널 (iframe) ----------

  function renderModels() {
    $('#spModels').replaceChildren(
      ...prefs.selected.map((id) => {
        const el = span('sp-model', svcOf(id).name);
        el.style.setProperty('--svc', svcOf(id).color);
        return el;
      }),
    );
  }

  function renderPicker() {
    $('#spPickList').replaceChildren(
      ...webServices().map((s) => {
        const b = button('', `${s.name} ${prefs.selected.includes(s.id) ? '닫기' : '열기'}`, () => {
          const r = SP.toggle(prefs.selected, s.id);
          $('#spPickNote').textContent = r.ok ? '' : r.error;
          if (!r.ok) return;
          prefs.selected = r.selected;
          savePrefs();
          syncPanes();
          renderPicker();
        });
        b.className = `sp-pick${prefs.selected.includes(s.id) ? ' on' : ''}`;
        b.style.setProperty('--svc', s.color);
        b.append(span('swatch'), span('name', s.name));
        return b;
      }),
    );
  }

  /** 고른 모델에 맞춰 패널을 열고 닫는다. 이미 열린 패널은 다시 로드하지 않는다. */
  function syncPanes() {
    for (const id of [...panes.keys()]) if (!prefs.selected.includes(id)) closePane(id);
    for (const id of prefs.selected) if (!panes.has(id)) openPane(svcOf(id));
    layoutPanes();
    renderModels();
  }

  function openPane(svc) {
    const el = document.createElement('section');
    el.className = 'sp-pane';
    el.style.setProperty('--svc', svc.color);
    const head = document.createElement('div');
    head.className = 'panel-head';
    const dot = span('dot loading');
    const url = span('url', svc.url);
    const status = span('status');
    const loginBtn = button('로그인 탭', '새 탭에서 이 서비스에 로그인한 뒤, 돌아와서 ↻를 누르세요', () => chrome.tabs.create({ url: svc.url }));
    loginBtn.className = 'login-btn';
    loginBtn.hidden = true;
    head.append(
      dot,
      span('name', svc.name),
      url,
      status,
      loginBtn,
      button('copy', '최신 답변 복사', () => copyAnswer(svc.id)),
      button('+', '새 대화', () => {
        p.sentKey = '';
        p.skillSent = '';
        navigate(svc.id, svc.newChatUrl || svc.url);
      }),
      button('↻', '새로고침', () => {
        p.retried = false;
        navigate(svc.id, p.curUrl || svc.url);
      }),
    );
    const iframe = document.createElement('iframe');
    iframe.className = 'sp-frame';
    iframe.name = SP.portName(NONCE, svc.id); // content.js가 이 이름으로 이 화면에 연결한다
    iframe.allow = 'clipboard-write; microphone';
    el.append(head, iframe);
    const p = { el, iframe, dot, url, status, loginBtn, port: null, pending: new Map(), seq: 0, helloTimer: null, loginTimer: null, retried: false, sentKey: '', skillSent: '', watch: 0, curUrl: svc.url };
    iframe.addEventListener('load', () => {
      clearTimeout(p.helloTimer);
      p.helloTimer = setTimeout(() => {
        if (p.port) return;
        if (!p.retried) {
          p.retried = true; // 사이트의 서비스 워커가 막았을 수 있다 — 한 번은 지우고 다시 연다
          navigate(svc.id, p.curUrl || svc.url);
          return;
        }
        setDot(p, 'error');
        p.loginBtn.hidden = false;
        p.url.textContent = '연결되지 않았습니다 — "로그인 탭"에서 로그인한 뒤 ↻';
      }, HELLO_TIMEOUT_MS);
    });
    panes.set(svc.id, p);
    navigate(svc.id, svc.url);
  }

  function closePane(id) {
    const p = panes.get(id);
    clearTimeout(p.helloTimer);
    clearTimeout(p.loginTimer);
    p.watch++;
    try {
      p.port?.disconnect();
    } catch {}
    for (const { reject } of p.pending.values()) reject(new Error('패널이 닫혔습니다'));
    p.el.remove();
    panes.delete(id);
  }

  const setDot = (p, state) => {
    p.dot.className = `dot ${state}`;
  };

  // 패널을 열 때마다 그 서비스의 서비스 워커 등록만 지운다 (앱 탭의 host.js와 같은 이유 — 로그인 쿠키는 그대로)
  async function navigate(id, url) {
    const p = panes.get(id);
    if (!p) return;
    p.port = null;
    p.curUrl = url;
    setDot(p, 'loading');
    p.url.textContent = url;
    p.loginBtn.hidden = true;
    try {
      await chrome.browsingData.removeServiceWorkers({ origins: svcOf(id).hosts.map((h) => `https://${h}`) });
    } catch {}
    if (panes.get(id) === p) p.iframe.src = url;
  }

  /** 1개면 전체, 2개면 위/아래 + 가운데 끌기 선 */
  function layoutPanes() {
    const box = $('#spPanes');
    const ids = prefs.selected.filter((id) => panes.has(id));
    const kids = [];
    ids.forEach((id, i) => {
      const p = panes.get(id);
      if (i > 0) kids.push(splitter());
      p.el.style.flex = ids.length === 1 ? '1 1 0' : `${i === 0 ? prefs.ratio : 1 - prefs.ratio} 1 0`;
      kids.push(p.el);
    });
    // 이미 붙어 있는 iframe을 옮기면 페이지가 다시 로드된다. 그래서 빠진 것만 떼고, 새것만 제자리에 끼운다
    // (고른 순서는 켜고 끄기로만 바뀌어 이미 있는 패널끼리의 순서는 그대로다).
    for (const el of [...box.children]) if (!kids.includes(el)) el.remove();
    kids.forEach((k, i) => {
      if (k.parentNode === box) return;
      const next = kids.slice(i + 1).find((x) => x.parentNode === box) || null;
      box.insertBefore(k, next);
    });
  }

  let splitBar = null;
  function splitter() {
    if (splitBar) return splitBar;
    const bar = (splitBar = document.createElement('div'));
    bar.className = 'sp-split';
    bar.title = '끌어서 위/아래 크기 조절 · 두 번 누르면 반반';
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      document.body.classList.add('sp-dragging');
      const rect = $('#spPanes').getBoundingClientRect();
      const move = (ev) => {
        prefs.ratio = SP.clampRatio((ev.clientY - rect.top) / rect.height);
        layoutPanes();
      };
      const up = () => {
        document.body.classList.remove('sp-dragging');
        bar.removeEventListener('pointermove', move);
        savePrefs();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up, { once: true });
      bar.addEventListener('pointercancel', up, { once: true });
    });
    bar.addEventListener('dblclick', () => {
      prefs.ratio = 0.5;
      layoutPanes();
      savePrefs();
    });
    return bar;
  }

  // ---------- iframe 안 content.js와의 연결선 ----------

  chrome.runtime.onConnect.addListener((port) => {
    const parsed = SP.parsePortName(port.name);
    if (!parsed || parsed.nonce !== NONCE) return; // 다른 창의 사이드 패널 것 — 그쪽이 받는다
    const p = panes.get(parsed.id);
    let from = null;
    try {
      from = new URL(port.sender?.url || '');
    } catch {}
    // 이 확장의 content.js가, 탭이 아닌 곳(사이드 패널)의 그 서비스 페이지에서 연 것만 받는다
    const ok = p && port.sender?.id === chrome.runtime.id && !port.sender?.tab && from?.protocol === 'https:' && serviceForHost(from.hostname)?.id === parsed.id;
    if (!ok) return port.disconnect();
    p.port = port;
    port.onMessage.addListener((m) => {
      if (m && typeof m.id === 'number') {
        const job = p.pending.get(m.id);
        if (job) {
          p.pending.delete(m.id);
          job.resolve(m.result);
        }
        return;
      }
      const ev = m?.event;
      if (!ev || typeof ev.type !== 'string') return;
      let url = port.sender.url;
      try {
        if (typeof ev.url === 'string' && new URL(ev.url).origin === from.origin) url = ev.url;
      } catch {}
      if (ev.type === 'mla:hello' || ev.type === 'mla:nav') {
        clearTimeout(p.helloTimer);
        p.retried = false;
        p.curUrl = url;
        p.url.textContent = url;
        scheduleLoginCheck(parsed.id);
      }
    });
    port.onDisconnect.addListener(() => {
      if (p.port !== port) return;
      p.port = null;
      for (const { reject } of p.pending.values()) reject(new Error('패널 페이지가 바뀌었습니다'));
      p.pending.clear();
    });
  });

  /** 패널 페이지의 content.js에 요청을 보내고 답을 받는다 */
  function call(id, msg, timeoutMs = CALL_TIMEOUT_MS) {
    const p = panes.get(id);
    if (!p?.port) return Promise.reject(new Error('패널 페이지와 아직 연결되지 않았습니다'));
    const reqId = ++p.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        p.pending.delete(reqId);
        reject(new Error('패널 페이지가 응답하지 않습니다'));
      }, timeoutMs);
      p.pending.set(reqId, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        p.port.postMessage({ id: reqId, msg });
      } catch (err) {
        p.pending.delete(reqId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function scheduleLoginCheck(id) {
    const p = panes.get(id);
    clearTimeout(p.loginTimer);
    p.loginTimer = setTimeout(async () => {
      try {
        const out = await call(id, { type: 'mla:loggedOut', cfg: { loggedOut: svcOf(id).loggedOut || {} } }, 10000);
        setDot(p, out ? 'error' : 'ready');
        p.loginBtn.hidden = !out;
        if (out) p.status.textContent = '로그인 필요';
        else if (p.status.textContent === '로그인 필요') p.status.textContent = '';
      } catch {}
    }, LOGIN_CHECK_MS);
  }

  const sendCfg = (svc) => ({ input: svc.input || [], send: svc.send || [], sendText: svc.sendText || null, submitKey: svc.submitKey || 'Enter' });
  const snapCfg = (svc) => ({ stop: svc.stop || [], response: svc.response || [], messages: svc.messages || null });
  const snapshot = (id, markdown = false) => call(id, { type: 'mla:snapshot', cfg: snapCfg(svcOf(id)), markdown }, 15000).catch(() => null);

  async function copyAnswer(id) {
    const p = panes.get(id);
    const snap = await snapshot(id, true);
    const text = snap?.md || snap?.text || '';
    if (!text) return flash(p, '복사할 답변이 없습니다');
    try {
      await navigator.clipboard.writeText(text);
      flash(p, '답변을 복사했습니다');
    } catch {
      flash(p, '복사하지 못했습니다');
    }
  }

  function flash(p, text) {
    p.status.textContent = text;
    p.status.dataset.state = 'flash';
    setTimeout(() => p.status.dataset.state === 'flash' && ((p.status.textContent = ''), delete p.status.dataset.state), 2500);
  }

  // ---------- 페이지 맥락 ----------

  const CTX_KEY = () => `mla:side-ctx:${windowId}`;

  function renderCtx() {
    const box = $('#spCtx');
    const text = $('#spCtxText');
    const state = ctxError && !ctx ? 'error' : SP.contextState(ctx, { on: prefs.ctxOn, activeTabId });
    box.dataset.state = state;
    $('#spCtxAuto').hidden = autoRead;
    $('#spCtxToggle').textContent = prefs.ctxOn ? 'on' : 'off';
    $('#spCtxToggle').setAttribute('aria-pressed', String(prefs.ctxOn));
    if (state === 'error') {
      text.textContent = autoRead ? `${ctxError}` : `${ctxError} — Alt+Shift+S로 다시 시도`;
      text.title = text.textContent;
      return;
    }
    if (!ctx) {
      // 확장을 업데이트로 받으면 크롬이 새 단축키를 지정하지 않을 때가 있다 — 그때는 지정하는 곳을 알려 준다
      text.textContent = autoRead
        ? '없음 — 읽을 수 있는 웹페이지(http · https)가 아닙니다'
        : shortcut
          ? `없음 — [자동 읽기 켜기]를 누르거나 ${shortcut}`
          : '없음 — [자동 읽기 켜기]를 누르거나 오른쪽 클릭 › 사이드탭에서 이 페이지로 묻기';
      text.title = '보고 있는 페이지의 본문을 가져와 질문과 함께 보냅니다';
      return;
    }
    let host = ctx.url;
    try {
      host = new URL(ctx.url).hostname;
    } catch {}
    const size = `${ctx.text.length.toLocaleString()}자${ctx.truncated ? '+' : ''}`;
    text.replaceChildren(span('url', host || ctx.title), document.createTextNode(' '), span('ok', `✓ ${size}`), document.createTextNode(` ${ctx.title}`));
    if (state === 'other') text.append(document.createTextNode(' · 다른 탭을 보는 중 — ↻ 또는 Alt+Shift+S'));
    text.title = `${ctx.title}\n${ctx.url}\n${size}${state === 'other' ? '\n지금 보는 탭과 다른 페이지입니다' : ''}`;
  }

  function takeCtx(raw, quiet = false) {
    if (!raw) return;
    if (raw.error) {
      ctxError = raw.error;
      ctx = null;
    } else {
      const next = SP.normalizeContext(raw);
      if (!next) return;
      const changed = SP.contextKey(next) !== SP.contextKey(ctx);
      ctx = next;
      ctxError = '';
      if (!quiet) prefs.ctxOn = true;
      if (!quiet || changed) hint(`페이지를 가져왔습니다 (${ctx.text.length.toLocaleString()}자) — 다음 질문에 본문을 함께 보냅니다`, 'ok');
    }
    renderCtx();
  }

  /** ↻: 지금 보는 탭의 본문을 읽는다. 단축키 · 메뉴로 받은 그 탭 한 번 권한이 남아 있을 때만 된다. quiet면 실패해도 알리지 않는다 */
  async function grabCtx(quiet = false) {
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (!tab) return;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({ title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 400000) }),
      });
      if (!res?.result?.text?.trim()) throw new Error('페이지 글이 없습니다');
      takeCtx({ ...res.result, tabId: tab.id, at: Date.now() }, quiet);
    } catch {
      if (autoRead) {
        // 자동 읽기 중인데 못 읽는 탭(크롬 설정 · 웹 스토어 · 빈 탭 등): 이 탭은 맥락 없이 보낸다
        if (ctx?.tabId !== tab.id) {
          ctx = null;
          renderCtx();
        }
        return;
      }
      // 권한이 없는 탭(처음 보는 탭 · 다른 주소로 이동한 탭 · 크롬 설정 화면 등)
      if (!quiet) hint(`이 탭은 ${shortcut || '오른쪽 클릭 › 사이드탭에서 이 페이지로 묻기'}${shortcut ? '(또는 오른쪽 클릭 › 사이드탭에서 이 페이지로 묻기)' : ''}로 가져와 주세요`, 'error');
    }
  }

  // ---------- 보내기 ----------

  let sending = false;
  async function send() {
    const text = $('#spPrompt').value.trim();
    if (!text || sending) return;
    const ids = prefs.selected.filter((id) => panes.get(id)?.port);
    if (!ids.length) return hint('연결된 패널이 없습니다 — 패널이 다 뜬 뒤 보내세요', 'error');
    // 자동 읽기면 보낼 때마다 지금 탭을 다시 읽는다 (탭을 옮겼거나 페이지가 바뀌었을 수 있다).
    // 아니면 가져온 페이지가 없을 때만 한 번 조용히 읽어 본다 (그 탭에 한 번 권한이 남아 있을 때만 된다).
    if (prefs.ctxOn && (autoRead || !ctx)) await grabCtx(true);
    const useCtx = prefs.ctxOn && ctx;
    // 페이지 본문을 처음 보낼 때: 키 · 토큰처럼 보이는 것이 있으면 확인 (앱 탭의 오른쪽 클릭 메뉴와 같음)
    if (useCtx && ids.some((id) => panes.get(id).sentKey !== SP.contextKey(ctx))) {
      const found = scanSecrets(ctx.text);
      if (found.length && !confirm(`페이지 본문에 비밀 정보로 보이는 것이 있습니다: ${describeSecrets(found)}\n그대로 보낼까요?`)) return;
    }
    sending = true;
    $('#spSend').disabled = true;
    hint(`보내는 중… (${ids.length}개)`);
    const tpl = currentTemplate();
    const asked = SP.applyTemplate(text, tpl, PL);
    const hid = sideHistory.add({
      question: text,
      targets: ids,
      files: useCtx ? [{ name: 'page.md', size: ctx.text.length }] : [],
      source: 'side',
      page: useCtx ? { title: ctx.title, url: ctx.url } : undefined,
    });
    const results = await Promise.all(ids.map((id) => sendOne(id, asked, useCtx ? ctx : null, hid)));
    sending = false;
    $('#spSend').disabled = false;
    const bad = results.filter((r) => !r.ok);
    if (!bad.length) {
      $('#spPrompt').value = '';
      const how = results.map((r) => r.how).find(Boolean);
      hint(`보냄 → ${ids.map((id) => svcOf(id).name).join(' · ')}${how ? ` · ${how}` : useCtx ? '' : ' · 페이지 없이 (Alt+Shift+S로 가져오기)'}`, useCtx || how ? 'ok' : 'error');
    } else hint(bad.map((r) => `${svcOf(r.id).name}: ${r.error}`).join(' · '), 'error');
  }

  async function sendOne(id, text, pageCtx, hid) {
    const p = panes.get(id);
    const svc = svcOf(id);
    const out = SP.buildSend({ text, ctx: pageCtx, on: !!pageCtx, sentKey: p.sentKey, webAsk: W });
    // 스킬 지침: 이 패널의 이 대화에 아직 안 보냈으면 질문 앞에 붙인다 (v0.21.0)
    const sk = SP.withSkill(out.text, currentSkill(), p.skillSent, PL);
    out.text = sk.text;
    p.status.dataset.state = 'send-sending';
    p.status.textContent = { inline: '페이지 본문과 함께 보내는 중…', file: 'page.md 첨부 후 보내는 중…' }[out.mode] || '보내는 중…';
    const before = await snapshot(id);
    let upload = null;
    let fallbackText;
    if (out.page) {
      const nonce = crypto.randomUUID();
      const data = new TextEncoder().encode(out.page.text).buffer;
      // 파일은 iframe에 postMessage로 넘긴다 (content.js는 바로 위 부모 = 이 확장 화면에서 온 것만 받는다)
      p.iframe.contentWindow.postMessage({ mla: 'files', nonce, files: [{ name: out.page.name, type: out.page.type, data, lastModified: Date.now() }] }, new URL(p.curUrl).origin);
      upload = { nonce, cfg: uploadOf(svc) };
      // 첨부에 실패하면 본문을 글에 넣어 보낸다 (너무 길면 앞부분만)
      fallbackText = SP.withSkill(W.selectionPrompt({ ...pageCtx, text: pageCtx.text.slice(0, FALLBACK_MAX), truncated: pageCtx.truncated || pageCtx.text.length > FALLBACK_MAX }) + text, currentSkill(), p.skillSent, PL).text;
    }
    let res;
    try {
      res = (await call(id, { type: 'mla:send', cfg: sendCfg(svc), text: out.text, upload, fallbackText })) || { ok: false, error: '패널 페이지가 응답하지 않았습니다' };
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (!res.ok) {
      p.status.dataset.state = 'send-error';
      p.status.textContent = `보내기 실패: ${res.error}`;
      sideHistory.setAnswer(hid, id, { state: 'send-error', error: String(res.error || '') });
      return { id, ok: false, error: res.error };
    }
    p.skillSent = sk.sent;
    if (out.mode === 'inline' || (out.page && (res.attach?.ok || res.attach?.fallback))) p.sentKey = SP.contextKey(pageCtx);
    const attachWarn = out.page && !res.attach?.ok;
    p.status.dataset.state = attachWarn ? 'send-attach-warn' : 'send-sent';
    p.status.textContent = attachWarn
      ? res.attach?.fallback ? '보냄 · 첨부 대신 본문에 넣음' : '보냄 · 첨부 실패'
      : { inline: '보냄 · 페이지 본문 포함', file: '보냄 · page.md 첨부' }[out.mode] || '보냄';
    watch(id, before, hid);
    const size = pageCtx ? `${pageCtx.text.length.toLocaleString()}자` : '';
    return { id, ok: true, how: { inline: `페이지 본문 ${size} 포함`, file: `page.md(${size}) 첨부` }[out.mode] || '' };
  }

  /** 보낸 뒤 답변이 끝날 때까지 머리줄 상태를 바꾼다: 답변 중… → 완료 */
  function watch(id, before, hid) {
    const p = panes.get(id);
    const token = ++p.watch;
    const current = () => panes.get(id) === p && p.watch === token;
    watchAnswer(() => snapshot(id), before, current, async (state, info = {}) => {
      if (!current()) return;
      // 기록: 답이 끝나면 답변 글(Markdown)을 남긴다 — 앱 탭 기록 화면에서 볼 수 있다
      if (state === 'done') {
        const snap = await snapshot(id, true);
        sideHistory.setAnswer(hid, id, { text: snap?.text || '', md: snap?.md || snap?.text || '', state: 'done', chars: (snap?.text || '').length });
      } else if (state !== 'answering') sideHistory.setAnswer(hid, id, { state, text: '' });
      const text = { answering: '답변 중…', done: `완료 · ${(info.chars || 0).toLocaleString()}자`, timeout: '시간 초과 (계속 지켜봄)', 'no-answer': '답변 없음' }[state];
      p.status.dataset.state = `answer-${state}`;
      p.status.textContent = text || '';
    }, { maxMs: ANSWER_MAX_MS });
  }

  // ---------- 앱 탭 열기 ----------

  /** [app ↗]: 쓰던 질문과 페이지 본문을 앱 탭에 넘기고 그 탭을 연다 (오른쪽 클릭 메뉴와 같은 길, v0.21.0) */
  async function openApp() {
    const ask = SP.handoff({ ctx, on: prefs.ctxOn, question: $('#spPrompt').value });
    if (ask) await chrome.storage.session.set({ 'mla:ask': ask }).catch(() => {});
    const wasOpen = await focusApp();
    if (ask && wasOpen) chrome.runtime.sendMessage({ type: 'mla:ask' }).catch(() => {});
    if (ask) hint(ask.kind === 'page' ? '앱 탭에 페이지 본문과 질문을 넘겼습니다' : '앱 탭에 질문을 넘겼습니다', 'ok');
  }

  /** 앱 탭을 앞으로 가져오거나 새로 연다 → 이미 열려 있었는지 */
  async function focusApp() {
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const app = contexts.find((c) => c.tabId >= 0 && c.documentUrl?.startsWith(APP_URL));
      if (app) {
        await chrome.tabs.update(app.tabId, { active: true });
        await chrome.windows.update(app.windowId, { focused: true });
        return true;
      }
    } catch {}
    await chrome.tabs.create({ url: APP_URL });
    return false;
  }

  // ---------- 앱 라이브러리 (템플릿 · 스킬, 읽기만 — v0.21.0) ----------

  const currentTemplate = () => SP.usableTemplates(window.TEMPLATES, lib, PL).find((t) => t.id === prefs.tpl) || null;
  const currentSkill = () => (lib.skills || []).find((s) => s.id === prefs.skill) || null;

  function renderLibrary() {
    const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
    const tpls = SP.usableTemplates(window.TEMPLATES, lib, PL);
    $('#spTpl').replaceChildren(opt('', 'tpl: 없음'), ...tpls.map((t) => opt(t.id, `${t.mine ? '' : '[기본] '}${t.name}`)));
    $('#spTpl').value = currentTemplate() ? prefs.tpl : '';
    $('#spTpl').classList.toggle('on', !!currentTemplate());
    $('#spSkill').replaceChildren(opt('', 'skill: 없음'), ...(lib.skills || []).map((s) => opt(s.id, s.name)));
    $('#spSkill').value = currentSkill() ? prefs.skill : '';
    $('#spSkill').classList.toggle('on', !!currentSkill());
  }
  $('#spTpl').addEventListener('change', (e) => {
    prefs.tpl = e.target.value;
    savePrefs();
    renderLibrary();
  });
  $('#spSkill').addEventListener('change', (e) => {
    prefs.skill = e.target.value;
    for (const p of panes.values()) p.skillSent = ''; // 바꾼 스킬은 다음 질문에 다시 붙인다
    savePrefs();
    renderLibrary();
  });

  // ---------- 화면 이벤트 ----------

  $('#spSend').addEventListener('click', send);
  $('#spPrompt').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return; // 한글 입력 중 Enter는 글자 확정
    e.preventDefault();
    send();
  });
  $('#spPick').addEventListener('click', () => {
    const picker = $('#spPicker');
    picker.hidden = !picker.hidden;
    $('#spPick').setAttribute('aria-expanded', String(!picker.hidden));
    $('#spPick').classList.toggle('active', !picker.hidden);
    $('#spPickNote').textContent = '';
    if (!picker.hidden) renderPicker();
  });
  $('#spApp').addEventListener('click', openApp);
  $('#spCtxGrab').addEventListener('click', () => grabCtx());
  // 권한 요청은 누른 그 순간에 해야 해서 기다리는 일 없이 바로 묻는다
  $('#spCtxAuto').addEventListener('click', () => {
    chrome.permissions.request({ origins: AUTO_ORIGINS }).then(
      (granted) => {
        if (!granted) return hint('허용하지 않아 자동 읽기를 켜지 못했습니다 — Alt+Shift+S로 가져올 수 있습니다', 'error');
        autoRead = true;
        renderCtx();
        grabCtx();
      },
      (err) => hint(`자동 읽기를 켜지 못했습니다: ${err.message}`, 'error'),
    );
  });
  chrome.permissions.onRemoved?.addListener(async () => {
    autoRead = await chrome.permissions.contains({ origins: AUTO_ORIGINS }).catch(() => false);
    renderCtx();
  });
  // 자동 읽기: 탭을 옮기거나 지금 탭의 페이지가 다 열리면 다시 읽는다
  let autoTimer = null;
  const autoGrab = () => {
    if (!autoRead) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => grabCtx(true), 400);
  };
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab?.windowId === windowId && tab.active && info.status === 'complete') autoGrab();
  });
  $('#spCtxToggle').addEventListener('click', () => {
    prefs.ctxOn = !prefs.ctxOn;
    savePrefs();
    renderCtx();
  });
  $('#spCtxClear').addEventListener('click', () => {
    ctx = null;
    ctxError = '';
    chrome.storage.session.remove(CTX_KEY()).catch(() => {});
    renderCtx();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && windowId !== null && changes[CTX_KEY()]?.newValue) takeCtx(changes[CTX_KEY()].newValue);
    if (area === 'local' && changes.library) {
      lib = PL.normalizeLibrary(changes.library.newValue || {});
      renderLibrary();
    }
    // 앱 탭 기록 화면에서 지웠으면 따라간다
    if (area === 'local' && changes['history:side'] && changes['history:side'].newValue?.length !== sideHistory.all().length) sideHistory.load(changes['history:side'].newValue || []);
  });
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId !== windowId) return;
    activeTabId = info.tabId;
    renderCtx();
    autoGrab();
  });

  // ---------- 시작 ----------

  async function init() {
    windowId = (await chrome.windows.getCurrent()).id;
    const saved = (await chrome.storage.local.get(['sidePrefs', 'prefs', 'remoteSelectors', 'library', 'history:side']).catch(() => ({}))) || {};
    const sp = saved.sidePrefs || {};
    prefs = {
      selected: SP.normalizeSelected(sp.selected, SERVICES),
      ratio: SP.clampRatio(sp.ratio),
      ctxOn: sp.ctxOn !== false,
      tpl: typeof sp.tpl === 'string' ? sp.tpl : '',
      skill: typeof sp.skill === 'string' ? sp.skill : '',
    };
    lib = PL.normalizeLibrary(saved.library || {});
    sideHistory.load(Array.isArray(saved['history:side']) ? saved['history:side'] : []);
    renderLibrary();
    // 앱 탭과 같은 원격 셀렉터(마지막으로 받은 것)를 쓴다 — 앱 설정에서 꺼 두었으면 내장 셀렉터
    if (saved.prefs?.remoteSelectors !== false) {
      const cached = remoteCore.sanitize(saved.remoteSelectors || null, SERVICES);
      if (cached) remoteCore.apply(SERVICES, remoteCore.snapshotBase(SERVICES), cached.overrides);
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    activeTabId = tab?.id ?? null;
    autoRead = await chrome.permissions.contains({ origins: AUTO_ORIGINS }).catch(() => false);
    const cmds = await chrome.commands?.getAll?.().catch(() => null);
    if (cmds) shortcut = cmds.find((c) => c.name === 'open-side-panel')?.shortcut || '';
    const got = await chrome.storage.session.get(CTX_KEY()).catch(() => ({}));
    takeCtx(got?.[CTX_KEY()]);
    if (!ctx) renderCtx();
    if (autoRead) grabCtx(true);
    hint('Enter 보내기 · Shift+Enter 줄바꿈');
    renderModels();
    await allowFraming();
    syncPanes();
  }

  init().catch((err) => {
    console.error(err);
    hint(`시작하지 못했습니다: ${err.message}`, 'error');
  });
})();
