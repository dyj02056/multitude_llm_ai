'use strict';

// Windows 앱 본체 — 세션(쿠키 지갑) · 뷰(AI 패널 · 로그인 화면 · 로그인 팝업 규칙) · 셀렉터 자가진단.
// v0.31.0에서 main.js에서 떼어 냈다. main.js가 createViews(ctx)로 한 번 만들고, 돌려받은 함수를 예전 이름 그대로 쓴다.
// ctx: { CHROME_UA, FIREFOX_UA, PARTITION, panels, win(읽을 때마다 지금 값) } — main.js의 것은 "쓸 때" ctx에서 찾는다.
//
// [쉽게 말하면] AI 서비스 웹페이지를 띄우는 "작은 브라우저 창"을 만들고 없애는 부분입니다.
//   - 모든 패널이 같은 세션(지갑)을 써서 Google 로그인 한 번으로 이어집니다.
//   - 로그인 팝업은 허용한 주소만 앱 안에서 열고, 나머지 링크는 기본 브라우저로 보냅니다.
//   - 패널마다 입력창을 찾았는지 살펴보고(자가진단) 바뀌면 화면에 알립니다.
const { WebContentsView, session, shell } = require('electron');
const { SERVICES, isAuthPopupUrl, isServiceUrl } = require('../shared/services');
const autologin = require('./autologin');
const { log } = require('./dev');
const { createDiag } = require('../shared/diag');
const { pageProbe } = require('../shared/page');
const { t } = require('../shared/i18n');

function createViews(ctx) {
  // ---------- 세션 ----------

  // 세션 = 쿠키·로그인 정보가 저장되는 "지갑". 모든 패널이 같은 지갑을 써서 Google 로그인을 같이 씁니다.
  const ses = () => session.fromPartition(ctx.PARTITION);

  /**
   * 세션(지갑)의 기본 규칙을 정합니다.
   *   - 사이트가 요청하는 권한(카메라·위치 등)은 "복사"와 "전체 화면"만 허락하고 나머지는 거절합니다.
   *   - Google 로그인 페이지에는 Firefox인 척하는 정보를 보내 "안전하지 않은 브라우저" 차단을 피합니다.
   */
  function setupSession() {
    const s = ses();
    s.setUserAgent(ctx.CHROME_UA);

    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
    s.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    s.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    s.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, cb) => {
      const headers = details.requestHeaders;
      headers['User-Agent'] = ctx.FIREFOX_UA;
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
            parent: ctx.win,
            autoHideMenuBar: true,
            webPreferences: { partition: ctx.PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
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
        if (svc) sendPanel(svc.id, { notice: t('main.popupBlocked', { host: host || t('main.unknownHost') }) });
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
        partition: ctx.PARTITION,
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
    ctx.win?.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /** 패널의 상태(불러오는 중, 답변 중, 답변 완료 등)를 화면에 알립니다. 화면은 이걸 받아 머리줄 글자를 바꿉니다. */
  function sendPanel(id, patch) {
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('panel:status', { id, ...patch });
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
    ctx.win.contentView.addChildView(view);
    wc.loadURL(svc.url);
    ctx.panels.set(svc.id, { view, login });
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
      const wc = ctx.panels.get(id)?.view.webContents;
      const svc = SERVICES.find((s) => s.id === id);
      if (!wc || wc.isDestroyed() || !svc || loadFailed.has(id) || !isServiceUrl(svc, wc.getURL())) return;
      try {
        diag.fromProbe(id, await wc.executeJavaScript(`(${pageProbe.toString()})(${JSON.stringify({ input: svc.input || [] })})`, true));
      } catch {} // 페이지가 바뀌는 중
    }, 2500);
  }

  return { destroyView, diag, isGoogleLoggedIn, lastProbe, newView, openPanel, probePanel, sendPanel, ses, setupSession };
}

module.exports = { createViews };
