'use strict';

// OS 알림 — Windows 앱 (v0.25.0). 무엇을 언제 알릴지와 알림 글은 shared/notify.js가 정하고, 여기서는 Electron Notification으로 띄운다.
// 앱 창을 보고 있으면(포커스 · 최소화 아님) 띄우지 않는다. 알림을 누르면 앱 창을 앞으로 가져오고, 분석이 끝났으면 답변 비교 화면을 연다.
//
// [쉽게 말하면] 다른 프로그램을 쓰는 동안 답변이 다 오면 윈도우 오른쪽 아래에 "답변 4개 완료"를 띄우는 곳입니다.

const { createNotifier } = require('../shared/notify');

/**
 * opts: { Notification(Electron), getWin(), prefs() → 알림 설정, onClickView(view), icon, log }
 * → { notify(event) } (shared/rounds.js의 a.notify)
 */
function createOsNotifier({ Notification, getWin, prefs, onClickView, icon, log = () => {} }) {
  const live = new Set(); // 띄운 알림 — 잡아 두지 않으면 사라지기 전에 정리돼 누르기(click)를 못 받는다

  function windowOf() {
    const w = getWin();
    return w && !w.isDestroyed() ? w : null;
  }

  function isFocused() {
    const w = windowOf();
    return !!w && w.isVisible() && !w.isMinimized() && w.isFocused();
  }

  function focusWindow() {
    const w = windowOf();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  function show(msg) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: msg.title, body: msg.body, ...(icon ? { icon } : {}) });
    live.add(n);
    const drop = () => live.delete(n);
    n.on('click', () => {
      drop();
      focusWindow();
      if (msg.view) onClickView(msg.view);
    });
    n.on('close', drop);
    n.on('failed', (_e, err) => {
      drop();
      log('notify', 'failed', String(err));
    });
    n.show();
    log('notify', msg.kind);
  }

  return createNotifier({ show, isFocused, prefs });
}

module.exports = { createOsNotifier };
