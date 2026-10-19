'use strict';

// 확장 탭 안 서비스 iframe에서만 동작한다 (services.js의 jsCookies·tokenBridge 사이트).
//
// 1) 쿠키 쓰기 전달 (jsCookies): cookie-shim.js(페이지 세계)가 알려 준 document.cookie 쓰기를 background.js로 넘겨,
//    그 사이트의 원래 쿠키에도 반영한다. 그래야 서버로 가는 요청의 쿠키와 화면 스크립트가 읽는 쿠키가 어긋나지 않는다.
//    background.js는 보낸 프레임의 도메인과 그 상위 도메인 쿠키만 받아 준다.
// 2) 토큰 다리 (tokenBridge): 화면이 localStorage의 토큰으로 로그인을 확인하는 사이트(Qwen)는, 확장 탭 안 iframe의
//    저장소가 일반 탭과 분리되면 토큰이 없어 로그아웃 화면을 띄운다. 크롬이 가진 그 사이트의 토큰 쿠키 값을 받아
//    이 iframe의 localStorage에 넣고, 화면이 이미 토큰 없이 떴으므로 한 번 새로고침한다.
//    iframe에 아직 쓸 수 있는 토큰이 있으면(화면이 스스로 갱신한 토큰) 건드리지 않는다.
//    preferCookie 사이트(Z.ai)는 화면이 손님 토큰을 스스로 만들어 두므로, 쿠키 값과 다르면 바꾼다.
(() => {
  const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  if (window === window.top || window.parent !== window.top || location.ancestorOrigins?.[0] !== EXT_ORIGIN) return;

  document.addEventListener('mla-cookie-write', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 8192) return;
    chrome.runtime.sendMessage({ type: 'mla:setCookie', raw: e.detail }).catch(() => {});
  });

  const RELOAD_MARK = 'mla-token-bridge';

  /** JWT면 만료 시각(exp)이 지났는지 본다. JWT가 아니면 알 수 없으므로 쓸 수 있다고 본다. */
  const expired = (jwt) => {
    try {
      const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return typeof payload.exp === 'number' && payload.exp * 1000 < Date.now() + 30000;
    } catch {
      return false;
    }
  };

  chrome.runtime
    .sendMessage({ type: 'mla:tokenBridge' })
    .then((token) => {
      if (!token?.value || typeof token.storage !== 'string') return;
      const have = localStorage.getItem(token.storage);
      if (have === token.value || (have && !expired(have) && !token.preferCookie)) return;
      localStorage.setItem(token.storage, token.value);
      // 같은 토큰으로는 한 번만, 그리고 30초 안에 다시는 새로고침하지 않는다 (무한 새로고침 방지)
      const last = JSON.parse(sessionStorage.getItem(RELOAD_MARK) || 'null');
      if (last && (last.value === token.value || Date.now() - last.at < 30000)) return;
      sessionStorage.setItem(RELOAD_MARK, JSON.stringify({ value: token.value, at: Date.now() }));
      location.reload();
    })
    .catch((err) => console.warn('[Multitude LLM] 로그인 토큰을 넣지 못했습니다:', err?.message || err));
})();
