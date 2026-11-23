'use strict';

// 미리보기 창 (v0.44.0, Windows 앱 전용) — 띄운 앱(개발 서버)을 앱 안의 따로 된 창에서 보여 주고, 화면 상태를 점검한다.
//   - 창 = 위쪽 도구 줄(preview.html, 미리보기용 preload) + 그 아래 사이트 화면(WebContentsView).
//   - 사이트 화면은 따로 된 세션(mla-preview)에서 돈다 — AI 서비스 로그인 쿠키와 섞이지 않는다. Node · preload 없음, 권한 요청은 모두 거절, 다운로드 취소.
//   - 이 PC 주소(localhost · 127.0.0.1 · [::1])만 연다. 바깥 주소로 가려 하면 막고 도구 줄에 알린다 (새 창 열기도).
//   - 점검: 콘솔 오류 · 실패한 요청(4xx · 5xx · 연결 실패) · 다 읽은 뒤 1.5초에 빈 화면인지 · 페이지를 못 엶(연결 거부 등).
//     결과는 도구 줄과 앱 창(사이드바)에 'preview:state'로 알린다.
//
// [쉽게 말하면] 개발 서버 주소를 앱 안의 작은 브라우저 창으로 열어, 눈으로 보면서 오류가 있는지 숫자로도 알려 주는 담당입니다.

const path = require('path');
const { BrowserWindow, WebContentsView, session } = require('electron');
const H = require('../shared/preview-health');
const { isLocalUrl } = require('./devrun');
const { t } = require('../shared/i18n');

const BAR_H = 76; // 도구 줄 높이 (preview.html의 .pv-bar와 맞춤)
const PARTITION = 'mla-preview';

function setupPreview({ ipcMain, getWin, shell, log = () => {} }) {
  let pw = null; // { win, view, home, health }
  let ses = null;

  const sendAll = () => {
    const st = snapshot();
    const app = getWin();
    if (app && !app.isDestroyed()) app.webContents.send('preview:state', st);
    if (pw && !pw.win.isDestroyed()) pw.win.webContents.send('pv:state', st);
  };
  const snapshot = () => (pw ? { open: true, home: pw.home, ...pw.health, canBack: pw.view.webContents.navigationHistory?.canGoBack?.() || false, canForward: pw.view.webContents.navigationHistory?.canGoForward?.() || false, notice: pw.notice || '' } : { open: false });

  function previewSession() {
    if (ses) return ses;
    ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
    // 실패한 요청: 상태 코드 4xx · 5xx, 연결 오류
    ses.webRequest.onCompleted((d) => {
      if (!pw || d.webContentsId !== pw.view.webContents.id) return;
      if (H.isFailedRequest({ statusCode: d.statusCode, url: d.url })) {
        pw.health.failed = H.addItem(pw.health.failed, { url: d.url.slice(0, 300), status: d.statusCode, kind: d.resourceType || '' });
        sendAll();
      }
    });
    ses.webRequest.onErrorOccurred((d) => {
      if (!pw || d.webContentsId !== pw.view.webContents.id) return;
      if (H.isFailedRequest({ error: d.error, url: d.url })) {
        pw.health.failed = H.addItem(pw.health.failed, { url: d.url.slice(0, 300), status: d.error, kind: d.resourceType || '' });
        sendAll();
      }
    });
    return ses;
  }

  function layout() {
    if (!pw || pw.win.isDestroyed()) return;
    const [w, h] = pw.win.getContentSize();
    const top = BAR_H + (pw.extra || 0);
    pw.view.setBounds({ x: 0, y: top, width: Math.max(0, w), height: Math.max(0, h - top) });
  }

  function load(url) {
    if (!pw) return;
    pw.health = H.empty(url);
    pw.notice = '';
    sendAll();
    pw.view.webContents.loadURL(url).catch(() => {}); // 실패는 did-fail-load가 알린다
  }

  async function probe() {
    if (!pw) return;
    const me = pw;
    try {
      const r = await me.view.webContents.executeJavaScript(H.PROBE_JS, true);
      if (pw !== me) return;
      me.health.blank = H.blankFrom(r);
      me.health.probe = r;
    } catch {
      me.health.blank = null;
    }
    me.health.at = Date.now();
    sendAll();
  }

  function create(url) {
    const app = getWin();
    const win = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 480,
      minHeight: 360,
      title: t('dev.pv.windowTitle', { url }),
      backgroundColor: '#161616',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preview-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const view = new WebContentsView({ webPreferences: { session: previewSession(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.contentView.addChildView(view);
    pw = { win, view, home: url, health: H.empty(url), notice: '' };
    const wc = view.webContents;
    // 바깥 주소로는 가지 않는다 (링크 · 리다이렉트 · 새 창)
    const guard = (e, target) => {
      if (isLocalUrl(target)) return;
      e.preventDefault();
      pw.notice = t('dev.pv.blocked', { url: String(target).slice(0, 120) });
      sendAll();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isLocalUrl(target)) wc.loadURL(target).catch(() => {});
      else {
        pw.notice = t('dev.pv.blocked', { url: String(target).slice(0, 120) });
        sendAll();
      }
      return { action: 'deny' };
    });
    wc.on('console-message', (e) => {
      if (!pw || e.level !== 'error') return;
      pw.health.errors = H.addItem(pw.health.errors, { text: String(e.message || '').slice(0, 500), source: `${String(e.sourceId || '').slice(0, 200)}${e.lineNumber ? `:${e.lineNumber}` : ''}` });
      sendAll();
    });
    wc.on('did-start-navigation', (e) => {
      if (!pw || !e.isMainFrame || e.isSameDocument || !isLocalUrl(e.url)) return; // 막힐 바깥 주소로의 이동은 상태를 바꾸지 않는다
      pw.health = { ...H.empty(e.url), errors: [], failed: [] };
      sendAll();
    });
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
      if (!pw || !isMain || code === -3) return; // -3: 사용자가 멈춤
      pw.health.loading = false;
      pw.health.loadError = `${desc} (${code})`;
      pw.health.url = failedUrl;
      sendAll();
    });
    wc.on('did-finish-load', () => {
      if (!pw) return;
      pw.health.loading = false;
      pw.health.url = wc.getURL();
      pw.health.title = wc.getTitle();
      sendAll();
      setTimeout(probe, 1500); // 화면 그리기(React 등)를 잠깐 기다린 뒤 빈 화면인지 본다
    });
    wc.on('page-title-updated', (_e, title) => {
      if (!pw) return;
      pw.health.title = title;
      win.setTitle(t('dev.pv.windowTitle', { url: title || pw.home }));
      sendAll();
    });
    win.on('resize', layout);
    win.on('closed', () => {
      if (pw && pw.win === win) pw = null;
      try {
        view.webContents.close();
      } catch {}
      sendAll();
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'preview.html'));
    win.once('ready-to-show', () => {
      layout();
      win.show();
    });
    if (app && !app.isDestroyed()) win.setIcon?.(path.join(__dirname, '..', '..', 'build', 'icon.png'));
    load(url);
  }

  // 앱 화면: 미리보기 열기(이 PC 주소만). 이미 열려 있으면 그 주소로 바꾸고 앞으로
  ipcMain.handle('preview:open', (_e, url) => {
    if (!isLocalUrl(url)) return { ok: false, error: t('dev.pv.notLocal') };
    if (pw && !pw.win.isDestroyed()) {
      pw.home = String(url);
      load(String(url));
      if (pw.win.isMinimized()) pw.win.restore();
      pw.win.focus();
    } else create(String(url));
    return { ok: true };
  });
  ipcMain.handle('preview:state', () => snapshot());
  ipcMain.handle('preview:close', () => {
    if (pw && !pw.win.isDestroyed()) pw.win.close();
    return true;
  });

  // 미리보기 창의 도구 줄
  const fromBar = (e) => pw && !pw.win.isDestroyed() && e.sender === pw.win.webContents;
  ipcMain.handle('pv:state', (e) => (fromBar(e) ? snapshot() : null));
  ipcMain.handle('pv:nav', (e, what) => {
    if (!fromBar(e)) return false;
    const wc = pw.view.webContents;
    const hist = wc.navigationHistory;
    if (what === 'back' && hist?.canGoBack()) hist.goBack();
    else if (what === 'forward' && hist?.canGoForward()) hist.goForward();
    else if (what === 'reload') wc.reloadIgnoringCache();
    else if (what === 'home') load(pw.home);
    else if (what === 'devtools') wc.openDevTools({ mode: 'detach' });
    else return false;
    return true;
  });
  // 자세히 칸(콘솔 오류 · 실패한 요청 목록)을 펼치면 사이트 화면을 그만큼 내린다 (사이트 화면이 도구 줄 위를 덮으므로)
  ipcMain.handle('pv:details', (e, open) => {
    if (!fromBar(e)) return false;
    pw.extra = open ? 220 : 0;
    layout();
    return true;
  });
  ipcMain.handle('pv:external', async (e) => {
    if (!fromBar(e)) return false;
    const u = pw.view.webContents.getURL();
    if (!isLocalUrl(u)) return false;
    await shell.openExternal(u);
    return true;
  });

  return {
    close: () => pw && !pw.win.isDestroyed() && pw.win.close(),
    isOpen: () => !!pw,
    view: () => (pw ? pw.view : null), // 화면 캡처 (v0.45.0)
    reload: () => pw && pw.view.webContents.reloadIgnoringCache(),
    snapshot,
    _log: log,
  };
}

module.exports = { setupPreview, BAR_H, PARTITION };
