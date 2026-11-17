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
  const { t } = MLA.i18n; // 새 문구 (v0.29.0)
  // 화면 언어 (v0.30.0): 앱 탭 설정 › 언어를 따른다. 앱 탭(host.js)이 localStorage 'mla.lang'에 적어 둔 값으로 바로 그리고,
  // 저장소의 설정(prefs.lang)을 읽거나 바뀌면 setUiLang이 다시 그린다. 'auto'면 크롬 표시 언어 (한국어 아니면 영어).
  const uiLangOf = (pref) => MLA.i18n.detectLang(MLA.i18n.normalizeLangPref(pref), chrome.i18n?.getUILanguage?.() || navigator.language);
  MLA.i18n.setLang(
    uiLangOf(
      (() => {
        try {
          return localStorage.getItem('mla.lang');
        } catch {
          return null;
        }
      })(),
    ),
  );
  MLA.i18n.apply(document);

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
  let prefs = { selected: [...SP.DEFAULT_SIDE], ratio: 0.5, ctxOn: true, tpl: '', skill: '', oneLine: false };
  let lib = PL.normalizeLibrary({}); // 앱 라이브러리 (읽기만, v0.21.0)
  // 사이드탭 기록 (v0.21.0): 'history:side'에 남기고, 앱 탭의 기록 화면이 `side` 표시와 함께 보여 준다
  const sideHistory = MLA.historyCore.createHistory((records) => chrome.storage.local.set({ 'history:side': records }).catch(() => {}));
  let sitePresets = {}; // 사이트별 프리셋 (v0.37.0) { 호스트: { selected, quick, at } }
  let siteHost = ''; // 지금 보는 탭의 사이트
  let appliedHost = ''; // 프리셋을 이미 적용한 사이트 (같은 사이트에 머무는 동안 다시 덮어쓰지 않는다)
  let localOn = false; // 앱 설정에서 로컬 LLM을 켜 두었는가 (한 줄 종합을 맡길 수 있음)
  let run = null; // 지금 보낸 질문 { ids, done: Set, hid, compare } — 두 답이 모두 끝났는지 본다
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
    // 글이 기호뿐인 버튼(+ · ↻ · ✕ …)은 설명을 화면 읽기 이름으로도 단다 (v0.30.0 접근성)
    if (title && label && !/[\p{L}\p{N}]/u.test(label)) b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  };
  const span = (cls, text = '') => Object.assign(document.createElement('span'), { className: cls, textContent: text });

  // ---------- iframe 허용 규칙 (background.js) ----------
  // 이 화면이 연결선을 열어 두는 동안만 규칙이 있다. 연결이 끊기면(백그라운드 재시작 등) 다시 연결해 되살린다.
  let bgPort = null;
  function allowFraming() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('ext.side.bgNoAnswer'))), 10000);
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
        const b = button('', t(prefs.selected.includes(s.id) ? 'ext.side.pickClose' : 'ext.side.pickOpen', { name: s.name }), () => {
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
    const loginBtn = button(t('ext.side.loginTab'), t('ext.side.loginTabTitle'), () => chrome.tabs.create({ url: svc.url }));
    loginBtn.className = 'login-btn';
    loginBtn.hidden = true;
    head.append(
      dot,
      span('name', svc.name),
      url,
      status,
      loginBtn,
      button('copy', t('ext.side.copyTitle'), () => copyAnswer(svc.id)),
      button('+', t('ext.side.newChat'), () => {
        p.sentKey = '';
        p.skillSent = '';
        navigate(svc.id, svc.newChatUrl || svc.url);
      }),
      button('↻', t('ext.side.reload'), () => {
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
        p.url.textContent = t('ext.side.notConnected');
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
    for (const { reject } of p.pending.values()) reject(new Error(t('ext.side.paneClosed')));
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
    bar.title = t('ext.side.splitTitle');
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
          job.resolve(MLA.i18n.pageError(m.result)); // content.js의 실패 code → 지금 언어의 글 (v0.30.0)
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
      for (const { reject } of p.pending.values()) reject(new Error(t('ext.side.pageChanged')));
      p.pending.clear();
    });
  });

  /** 패널 페이지의 content.js에 요청을 보내고 답을 받는다 */
  function call(id, msg, timeoutMs = CALL_TIMEOUT_MS) {
    const p = panes.get(id);
    if (!p?.port) return Promise.reject(new Error(t('ext.side.notLinked')));
    const reqId = ++p.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        p.pending.delete(reqId);
        reject(new Error(t('ext.side.paneNoAnswer')));
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
        if (out) p.status.textContent = t('ext.side.loginNeeded');
        else if (p.status.textContent === t('ext.side.loginNeeded')) p.status.textContent = '';
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
    if (!text) return flash(p, t('ext.side.nothingToCopy'));
    try {
      await navigator.clipboard.writeText(text);
      flash(p, t('ext.side.copied'));
    } catch {
      flash(p, t('ext.side.copyFailed'));
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
    renderRecall();
    const box = $('#spCtx');
    const text = $('#spCtxText');
    const state = ctxError && !ctx ? 'error' : SP.contextState(ctx, { on: prefs.ctxOn, activeTabId });
    box.dataset.state = state;
    $('#spCtxAuto').hidden = autoRead;
    $('#spCtxToggle').textContent = prefs.ctxOn ? 'on' : 'off';
    $('#spCtxToggle').setAttribute('aria-pressed', String(prefs.ctxOn));
    if (state === 'error') {
      text.textContent = autoRead ? `${ctxError}` : t('ext.side.ctxRetry', { error: ctxError });
      text.title = text.textContent;
      return;
    }
    if (!ctx) {
      // 확장을 업데이트로 받으면 크롬이 새 단축키를 지정하지 않을 때가 있다 — 그때는 지정하는 곳을 알려 준다
      text.textContent = autoRead
        ? t('ext.side.ctxNoneAuto')
        : shortcut
          ? t('ext.side.ctxNoneShortcut', { shortcut })
          : t('ext.side.ctxNoneMenu');
      text.title = t('ext.side.ctxTitle');
      return;
    }
    let host = ctx.url;
    try {
      host = new URL(ctx.url).hostname;
    } catch {}
    const srcText = ctx.source === 'pdf' ? ` · ${t(ctx.totalPages && ctx.totalPages !== ctx.pages ? 'side.src.pdfPart' : 'side.src.pdf', { n: ctx.pages || 0, total: ctx.totalPages || 0 })}` : ctx.source === 'captions' ? ` · ${t('side.src.captions')}` : '';
    const size = `${t('ext.side.chars', { n: ctx.text.length.toLocaleString() })}${ctx.truncated ? '+' : ''}${srcText}`;
    text.replaceChildren(span('url', host || ctx.title), document.createTextNode(' '), span('ok', `✓ ${size}`), document.createTextNode(` ${ctx.title}`));
    if (state === 'other') text.append(document.createTextNode(t('ext.side.ctxOther')));
    text.title = `${ctx.title}\n${ctx.url}\n${size}${state === 'other' ? `\n${t('ext.side.ctxOtherTitle')}` : ''}`;
  }

  /** PDF 본문 읽기 (v0.37.0): 그 탭의 페이지 안에서 같은 주소의 PDF를 받아(base64) pdf.js로 글을 꺼낸다 */
  let pdfjs = null;
  async function readPdf(tabId) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: MLA.pdfText.fetchSelfBase64 });
    const r = res?.result;
    if (!r || r.error) throw Object.assign(new Error(r?.error || 'read'), { code: /^http|big|file/.test(r?.error || '') ? r.error.split(' ')[0] : 'read', detail: r?.error });
    const bytes = MLA.pdfText.base64ToBytes(r.b64);
    if (!pdfjs) {
      pdfjs = await import(chrome.runtime.getURL('lib/shared/vendor/pdf.min.mjs'));
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/shared/vendor/pdf.worker.min.mjs');
    }
    return MLA.pdfText.extractPdfText(pdfjs, bytes, { cMapUrl: chrome.runtime.getURL('lib/shared/vendor/cmaps/'), label: (n) => t('side.pdf.page', { n }) });
  }
  async function takePdf(raw, quiet) {
    hint(t('side.pdf.reading'));
    try {
      const out = await readPdf(raw.tabId);
      if (out.empty) throw Object.assign(new Error('empty'), { code: 'empty' });
      takeCtx({ title: raw.title ? `${raw.title} (PDF)` : 'PDF', url: raw.url, text: out.text, truncated: out.truncated, source: 'pdf', pages: out.pages, totalPages: out.totalPages, tabId: raw.tabId, at: Date.now() }, quiet);
    } catch (err) {
      ctx = null;
      ctxError = t(`side.pdf.err.${err.code || 'read'}`, { detail: err.detail || err.message });
      renderCtx();
      if (!quiet) hint(ctxError, 'error');
    }
  }

  function takeCtx(raw, quiet = false) {
    if (!raw) return;
    if (raw.pdf) return void takePdf(raw, quiet);
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
      if (!quiet || changed) hint(t('ext.side.ctxGot', { n: ctx.text.length.toLocaleString() }), 'ok');
    }
    renderCtx();
  }

  /** ↻: 지금 보는 탭의 본문을 읽는다. 단축키 · 메뉴로 받은 그 탭 한 번 권한이 남아 있을 때만 된다. quiet면 실패해도 알리지 않는다 */
  async function grabCtx(quiet = false) {
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (!tab) return;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: MLA.pageRead.readPageNow });
      const pick = MLA.pageRead.pickContext(res?.result);
      if (!pick) throw new Error(t('ext.side.noPageText'));
      takeCtx({ ...pick, tabId: tab.id, at: Date.now() }, quiet);
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
      if (!quiet) hint(shortcut ? t('ext.side.grabShortcut', { shortcut }) : t('ext.side.grabMenu'), 'error');
    }
  }

  // ---------- 보내기 ----------

  let sending = false;
  async function send(opts = {}) {
    const text = (typeof opts.text === 'string' ? opts.text : $('#spPrompt').value).trim();
    if (!text || sending) return;
    const noCtx = opts.noCtx === true; // 번역 비교: 선택한 글만 보내고 페이지는 붙이지 않는다
    const ids = prefs.selected.filter((id) => panes.get(id)?.port);
    if (!ids.length) return hint(t('ext.side.noPanes'), 'error');
    // 자동 읽기면 보낼 때마다 지금 탭을 다시 읽는다 (탭을 옮겼거나 페이지가 바뀌었을 수 있다).
    // 아니면 가져온 페이지가 없을 때만 한 번 조용히 읽어 본다 (그 탭에 한 번 권한이 남아 있을 때만 된다).
    if (!noCtx && prefs.ctxOn && (autoRead || !ctx)) await grabCtx(true);
    const useCtx = !noCtx && prefs.ctxOn && ctx;
    // 페이지 본문을 처음 보낼 때: 키 · 토큰처럼 보이는 것이 있으면 확인 (앱 탭의 오른쪽 클릭 메뉴와 같음)
    if (useCtx && ids.some((id) => panes.get(id).sentKey !== SP.contextKey(ctx))) {
      const found = scanSecrets(ctx.text);
      if (found.length && !confirm(t('ext.side.secretConfirm', { what: describeSecrets(found) }))) return;
    }
    sending = true;
    $('#spSend').disabled = true;
    // 중간에 오류가 나도 보내기 버튼이 잠긴 채로 남지 않게 한다
    try {
      hint(t('ext.side.sendingN', { n: ids.length }));
      const tpl = currentTemplate();
      const asked = SP.applyTemplate(text, tpl, PL);
      const hid = sideHistory.add({
        question: text,
        targets: ids,
        files: useCtx ? [{ name: 'page.md', size: ctx.text.length }] : [],
        source: 'side',
        page: useCtx ? { title: ctx.title, url: ctx.url } : undefined,
      });
      closeCompare();
      run = { ids, done: new Set(), hid, compare: opts.compare === true, text };
      const results = await Promise.all(ids.map((id) => sendOne(id, asked, useCtx ? ctx : null, hid)));
      renderRecall();
      const bad = results.filter((r) => !r.ok);
      if (!bad.length) {
        if (typeof opts.text !== 'string') $('#spPrompt').value = '';
        const how = results.map((r) => r.how).find(Boolean);
        hint(`${t('ext.side.sentTo', { names: ids.map((id) => svcOf(id).name).join(' · ') })}${how ? ` · ${how}` : useCtx ? '' : t('ext.side.sentNoPage')}`, useCtx || how ? 'ok' : 'error');
      } else hint(bad.map((r) => `${svcOf(r.id).name}: ${r.error}`).join(' · '), 'error');
    } catch (err) {
      hint(err?.message || String(err), 'error');
    } finally {
      sending = false;
      $('#spSend').disabled = false;
    }
  }

  async function sendOne(id, text, pageCtx, hid) {
    const p = panes.get(id);
    const svc = svcOf(id);
    const out = SP.buildSend({ text, ctx: pageCtx, on: !!pageCtx, sentKey: p.sentKey, webAsk: W });
    // 스킬 지침: 이 패널의 이 대화에 아직 안 보냈으면 질문 앞에 붙인다 (v0.21.0)
    const sk = SP.withSkill(out.text, currentSkill(), p.skillSent, PL);
    out.text = sk.text;
    p.status.dataset.state = 'send-sending';
    p.status.textContent = { inline: t('ext.side.sendingInline'), file: t('ext.side.sendingFile') }[out.mode] || t('ext.side.sending');
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
      res = (await call(id, { type: 'mla:send', cfg: sendCfg(svc), text: out.text, upload, fallbackText })) || { ok: false, error: t('ext.side.paneNoReply') };
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (!res.ok) {
      p.status.dataset.state = 'send-error';
      p.status.textContent = t('ext.side.sendFailed', { error: res.error });
      sideHistory.setAnswer(hid, id, { state: 'send-error', error: String(res.error || '') });
      return { id, ok: false, error: res.error };
    }
    p.skillSent = sk.sent;
    if (out.mode === 'inline' || (out.page && (res.attach?.ok || res.attach?.fallback))) p.sentKey = SP.contextKey(pageCtx);
    const attachWarn = out.page && !res.attach?.ok;
    p.status.dataset.state = attachWarn ? 'send-attach-warn' : 'send-sent';
    p.status.textContent = attachWarn
      ? res.attach?.fallback ? t('ext.side.sentFallback') : t('ext.side.sentAttachFailed')
      : { inline: t('ext.side.sentInline'), file: t('ext.side.sentFile') }[out.mode] || t('ext.side.sent');
    watch(id, before, hid);
    const size = pageCtx ? t('ext.side.chars', { n: pageCtx.text.length.toLocaleString() }) : '';
    return { id, ok: true, how: { inline: t('ext.side.howInline', { size }), file: t('ext.side.howFile', { size }) }[out.mode] || '' };
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
        if (run && run.hid === hid) {
          run.done.add(id);
          if (run.done.size === run.ids.length) onRunDone(run);
        }
      } else if (state !== 'answering') sideHistory.setAnswer(hid, id, { state, text: '' });
      const text = { answering: t('ext.side.answering'), done: t('ext.side.done', { n: (info.chars || 0).toLocaleString() }), timeout: t('ext.side.timeout'), 'no-answer': t('ext.side.noAnswer') }[state];
      p.status.dataset.state = `answer-${state}`;
      p.status.textContent = text || '';
    }, { maxMs: ANSWER_MAX_MS });
  }

  // ---------- 한 번 누르기 질문 · 이 페이지에서 전에 물어본 것 (v0.29.0) ----------

  /** 요약 · 번역 · 핵심만 · 쉽게 설명: 가져온 페이지와 함께 바로 보낸다 (페이지가 없으면 먼저 읽어 본다) */
  async function quick(kind) {
    if (sending) return;
    if (kind === 'compare') return quickCompare();
    if (!ctx) await grabCtx(true);
    if (!ctx) return hint(t('side.quick.noPage'), 'error');
    prefs.ctxOn = true;
    savePrefs();
    renderCtx();
    $('#spPrompt').value = SP.quickPrompt(kind, ctx, t);
    send();
  }
  for (const b of document.querySelectorAll('#spQuick [data-quick]')) b.addEventListener('click', () => quick(b.dataset.quick));

  // ---------- 번역 비교 · 한 줄 종합 (v0.37.0) ----------

  /** 지금 보는 탭에서 선택한 글 (그 탭에 읽기 권한이 있을 때만, 없으면 '') */
  async function grabSelection() {
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (!tab) return '';
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => String((window.getSelection && window.getSelection()) || '').slice(0, 20000) });
      return String(res?.result || '').trim();
    } catch {
      return '';
    }
  }

  /** 번역 비교: 선택한 글을 두 AI에게 번역시키고, 끝나면 나란히 비교한다. 선택한 글이 없으면 페이지 번역으로 보낸다 */
  async function quickCompare() {
    const ids = prefs.selected.filter((id) => panes.get(id)?.port);
    if (ids.length < 2) return hint(t('side.cmp.needTwo'), 'error');
    const sel = await grabSelection();
    if (!sel) {
      hint(t('side.cmp.noSelection'), 'error');
      return;
    }
    const ask = SP.quickPrompt('translate', { text: sel }, t);
    send({ text: `${ask}\n\n${sel}`, noCtx: true, compare: true });
  }

  function closeCompare() {
    $('#spCompare').hidden = true;
  }
  $('#spCompareClose').addEventListener('click', closeCompare);

  async function lastAnswer(id) {
    const s = await snapshot(id, true);
    return String(s?.md || s?.text || '');
  }

  async function renderCompare(r) {
    const [a, b] = await Promise.all(r.ids.map(lastAnswer));
    if (!a || !b) return;
    const d = SP.diffSentences(a, b);
    const draw = (box, id, list) => {
      box.replaceChildren(span('sp-cmp-name', svcOf(id).name));
      for (const s of list) {
        const line = document.createElement('div');
        if (s.diff) line.append(Object.assign(document.createElement('mark'), { textContent: s.text }));
        else line.textContent = s.text;
        box.append(line);
      }
    };
    draw($('#spCmpA'), r.ids[0], d.a);
    draw($('#spCmpB'), r.ids[1], d.b);
    const diffs = d.a.filter((x) => x.diff).length + d.b.filter((x) => x.diff).length;
    $('#spCompareNote').textContent = t('side.cmp.note', { n: diffs });
    $('#spCompare').hidden = false;
  }

  function showOne(label, text) {
    $('#spOneLabel').textContent = label;
    $('#spOneText').textContent = text;
    $('#spOne').hidden = !text && !label;
  }
  $('#spOneClose').addEventListener('click', () => ($('#spOne').hidden = true));
  $('#spOneToggle').addEventListener('click', () => {
    prefs.oneLine = !prefs.oneLine;
    $('#spOneToggle').setAttribute('aria-pressed', String(prefs.oneLine));
    if (!prefs.oneLine) $('#spOne').hidden = true;
    savePrefs();
  });

  /** 한쪽 AI에게 이어서 묻고 끝난 답을 받는다 (한 줄 종합을 로컬 LLM에 못 맡길 때) */
  async function askPane(id, text) {
    const p = panes.get(id);
    const before = await snapshot(id);
    const res = await call(id, { type: 'mla:send', cfg: sendCfg(svcOf(id)), text, upload: null });
    if (!res?.ok) throw new Error(res?.error || 'send');
    return new Promise((resolve) =>
      watchAnswer(() => snapshot(id), before, () => panes.get(id) === p, async (state) => {
        if (state === 'done') resolve(await lastAnswer(id));
        else if (state !== 'answering') resolve('');
      }, { maxMs: 5 * 60 * 1000 }),
    );
  }

  async function oneLineSynth(r) {
    showOne(t('side.oneLine.label'), t('side.oneLine.working'));
    try {
      const answers = [];
      for (const id of r.ids) answers.push({ name: svcOf(id).name, text: await lastAnswer(id) });
      if (answers.some((x) => !x.text)) return showOne('', '');
      const prompt = SP.oneLinePrompt(answers, t);
      let line = '';
      let via = '';
      if (localOn) {
        const out = await chrome.runtime.sendMessage({ type: 'mla:local-ask', text: prompt }).catch(() => null);
        if (out?.ok) {
          line = SP.cleanOneLine(out.text);
          via = t('side.oneLine.viaLocal');
        }
      }
      if (!line) {
        const id = r.ids[0];
        line = SP.cleanOneLine(await askPane(id, prompt));
        via = svcOf(id).name;
      }
      if (run !== r) return; // 그사이 새 질문을 보냈다
      if (!line) return showOne('', '');
      showOne(t('side.oneLine.labelVia', { via }), line);
    } catch (err) {
      showOne(t('side.oneLine.label'), t('side.oneLine.failed', { error: err.message }));
    }
  }

  /** 보낸 질문의 답이 모두 끝났다: 번역 비교면 나란히 보이고, 아니면 (켜 두었을 때) 한 줄 종합 */
  function onRunDone(r) {
    if (r.ids.length !== 2) return;
    if (r.compare) renderCompare(r);
    else if (prefs.oneLine) oneLineSynth(r);
  }

  // ---------- 사이트별 프리셋 (v0.37.0) ----------

  const quickLabel = (k) => (k ? t(`side.quick.${k}`) : t('side.site.quickNone'));
  function markDefaultQuick(kind) {
    for (const b of document.querySelectorAll('#spQuick [data-quick]')) b.classList.toggle('sp-default', !!kind && b.dataset.quick === kind);
  }
  function renderSite() {
    const box = $('#spSite');
    box.hidden = !siteHost;
    if (!siteHost) return markDefaultQuick('');
    const pre = sitePresets[siteHost];
    $('#spSiteHost').textContent = siteHost;
    $('#spSiteHost').title = siteHost;
    $('#spSiteState').textContent = pre ? t('side.site.saved', { names: pre.selected.map((id) => svcOf(id)?.name || id).join(' · '), quick: quickLabel(pre.quick) }) : t('side.site.none');
    $('#spSiteQuick').value = pre ? pre.quick : $('#spSiteQuick').value;
    $('#spSiteClear').hidden = !pre;
    markDefaultQuick(pre?.quick || '');
  }
  /** 보는 탭의 사이트가 바뀌었으면 그 사이트의 프리셋을 적용한다 (AI 고르기만 — 질문은 보내지 않는다) */
  function applySite(url) {
    siteHost = SP.hostKey(url);
    const pre = SP.presetFor(sitePresets, url);
    if (pre && appliedHost !== siteHost) {
      appliedHost = siteHost;
      const next = SP.normalizeSelected(pre.selected, SERVICES);
      if (next.join() !== prefs.selected.join()) {
        prefs.selected = next;
        savePrefs();
        syncPanes();
        renderPicker();
      }
      hint(t('side.site.applied', { host: siteHost }), 'ok');
    } else if (!pre) appliedHost = '';
    renderSite();
  }
  $('#spSiteSave').addEventListener('click', () => {
    if (!siteHost) return;
    sitePresets = SP.setSitePreset(sitePresets, siteHost, { selected: prefs.selected, quick: $('#spSiteQuick').value }, SERVICES);
    appliedHost = siteHost;
    chrome.storage.local.set({ sideSites: sitePresets }).catch(() => {});
    renderSite();
    hint(t('side.site.savedHint', { host: siteHost }), 'ok');
  });
  $('#spSiteClear').addEventListener('click', () => {
    sitePresets = SP.clearSitePreset(sitePresets, siteHost);
    appliedHost = '';
    chrome.storage.local.set({ sideSites: sitePresets }).catch(() => {});
    renderSite();
  });

  /** 지금 페이지(가져온 페이지, 없으면 보고 있는 탭 주소)에서 전에 물어본 것 */
  let recallOpen = false;
  let tabUrl = '';
  function renderRecall() {
    const items = SP.recallFor(sideHistory.all(), ctx?.url || tabUrl);
    $('#spRecall').hidden = !items.length;
    if (!items.length) return;
    $('#spRecallBtn').textContent = `${recallOpen ? '▾' : '▸'} ${t('side.recall.count', { n: items.length })}`;
    $('#spRecallBtn').setAttribute('aria-expanded', String(recallOpen));
    $('#spRecallList').hidden = !recallOpen;
    if (!recallOpen) return;
    $('#spRecallList').replaceChildren(
      ...items.map((it) => {
        const row = document.createElement('details');
        row.className = 'sp-recall-item';
        const sum = document.createElement('summary');
        sum.append(span('muted-label', new Date(it.at).toLocaleString(MLA.i18n.getLang() === 'en' ? 'en-US' : 'ko-KR')), document.createTextNode(` ${it.question.split('\n')[0].slice(0, 120)}`));
        const again = button(t('side.recall.ask'), t('side.recall.askTitle'), () => {
          $('#spPrompt').value = it.question;
          $('#spPrompt').focus();
        });
        row.append(sum, again);
        for (const a of it.answers) {
          const ans = document.createElement('div');
          ans.className = 'sp-recall-answer';
          ans.append(span('url', svcOf(a.id)?.name || a.id), document.createTextNode(` ${a.text.slice(0, 600)}${a.text.length > 600 ? '…' : ''}`));
          row.append(ans);
        }
        if (!it.answers.length) row.append(span('muted-label', t('side.recall.noAnswer')));
        return row;
      }),
    );
  }
  $('#spRecallBtn').addEventListener('click', () => {
    recallOpen = !recallOpen;
    renderRecall();
  });
  async function refreshTabUrl() {
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    tabUrl = tab?.url || '';
    applySite(tabUrl);
    renderRecall();
  }

  // ---------- 앱 탭 열기 ----------

  /** [app ↗]: 쓰던 질문과 페이지 본문을 앱 탭에 넘기고 그 탭을 연다 (오른쪽 클릭 메뉴와 같은 길, v0.21.0) */
  async function openApp() {
    const ask = SP.handoff({ ctx, on: prefs.ctxOn, question: $('#spPrompt').value });
    if (ask) await chrome.storage.session.set({ 'mla:ask': ask }).catch(() => {});
    const wasOpen = await focusApp();
    if (ask && wasOpen) chrome.runtime.sendMessage({ type: 'mla:ask' }).catch(() => {});
    if (ask) hint(ask.kind === 'page' ? t('ext.side.toAppPage') : t('ext.side.toApp'), 'ok');
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
    $('#spTpl').replaceChildren(opt('', t('ext.side.tplNone')), ...tpls.map((tpl) => opt(tpl.id, tpl.mine ? tpl.name : t('ext.side.builtinTpl', { name: tpl.name }))));
    $('#spTpl').value = currentTemplate() ? prefs.tpl : '';
    $('#spTpl').classList.toggle('on', !!currentTemplate());
    $('#spSkill').replaceChildren(opt('', t('ext.side.skillNone')), ...(lib.skills || []).map((s) => opt(s.id, s.name)));
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
    const dflt = sitePresets[siteHost]?.quick;
    if (!$('#spPrompt').value.trim() && dflt) return quick(dflt); // 사이트 프리셋의 기본 단추 (v0.37.0)
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
        if (!granted) return hint(t('ext.side.autoDenied'), 'error');
        autoRead = true;
        renderCtx();
        grabCtx();
      },
      (err) => hint(t('ext.side.autoFailed', { error: err.message }), 'error'),
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
    if (tab?.windowId === windowId && tab.active && info.status === 'complete') {
      autoGrab();
      refreshTabUrl();
    }
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
    if (area === 'local' && changes.prefs) {
      setUiLang(changes.prefs.newValue?.lang);
      localOn = !!(changes.prefs.newValue?.local?.enabled && changes.prefs.newValue.local.model);
    }
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
    refreshTabUrl();
    renderCtx();
    autoGrab();
  });

  /** 언어 설정이 지금 화면과 다르면 새 언어로 다시 그린다 (v0.30.0). 패널 상태 글은 다음에 바뀔 때 새 언어가 된다 */
  function setUiLang(pref) {
    const next = uiLangOf(pref);
    if (next === MLA.i18n.getLang()) return;
    MLA.i18n.setLang(next);
    MLA.i18n.apply(document);
    hint(t('ext.side.hint'));
    renderModels();
    renderPicker();
    renderCtx();
    renderRecall();
    renderLibrary();
  }

  // ---------- 시작 ----------

  async function init() {
    windowId = (await chrome.windows.getCurrent()).id;
    const saved = (await chrome.storage.local.get(['sidePrefs', 'prefs', 'remoteSelectors', 'library', 'history:side', 'sideSites']).catch(() => ({}))) || {};
    localOn = !!(saved.prefs?.local?.enabled && saved.prefs.local.model);
    sitePresets = SP.normalizeSitePresets(saved.sideSites, SERVICES);
    setUiLang(saved.prefs?.lang);
    const sp = saved.sidePrefs || {};
    prefs = {
      selected: SP.normalizeSelected(sp.selected, SERVICES),
      ratio: SP.clampRatio(sp.ratio),
      ctxOn: sp.ctxOn !== false,
      tpl: typeof sp.tpl === 'string' ? sp.tpl : '',
      skill: typeof sp.skill === 'string' ? sp.skill : '',
      oneLine: sp.oneLine === true,
    };
    $('#spOneToggle').setAttribute('aria-pressed', String(prefs.oneLine));
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
    tabUrl = tab?.url || '';
    applySite(tabUrl);
    autoRead = await chrome.permissions.contains({ origins: AUTO_ORIGINS }).catch(() => false);
    const cmds = await chrome.commands?.getAll?.().catch(() => null);
    if (cmds) shortcut = cmds.find((c) => c.name === 'open-side-panel')?.shortcut || '';
    const got = await chrome.storage.session.get(CTX_KEY()).catch(() => ({}));
    takeCtx(got?.[CTX_KEY()]);
    if (!ctx) renderCtx();
    if (autoRead) grabCtx(true);
    hint(t('ext.side.hint'));
    renderModels();
    await allowFraming();
    syncPanes();
  }

  init().catch((err) => {
    console.error(err);
    hint(t('ext.side.startFailed', { error: err.message }), 'error');
  });
})();
