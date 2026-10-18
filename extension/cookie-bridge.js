'use strict';

// cookie-shim.js(페이지 세계)가 알려 준 document.cookie 쓰기를 background.js로 넘겨, 그 사이트의 원래 쿠키에도 반영한다.
// 그래야 서버로 가는 요청의 쿠키와 화면 스크립트가 읽는 쿠키가 어긋나지 않는다. 확장 탭 안 iframe일 때만 동작한다.
// background.js는 보낸 프레임의 도메인(jsCookies 서비스)과 그 상위 도메인 쿠키만 받아 준다.
(() => {
  const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  if (window === window.top || window.parent !== window.top || location.ancestorOrigins?.[0] !== EXT_ORIGIN) return;
  document.addEventListener('mla-cookie-write', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 8192) return;
    chrome.runtime.sendMessage({ type: 'mla:setCookie', raw: e.detail }).catch(() => {});
  });
})();
