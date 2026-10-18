'use strict';

// 페이지 스크립트가 로그인 쿠키를 직접 읽고 쓰는 사이트(services.js의 jsCookies, 지금은 Qwen)에만, 페이지와 같은 세계(MAIN)에서
// 문서가 열리기 전에 실행된다. 확장 탭 안 iframe일 때만 동작한다.
//
// 왜 필요한가: 확장 탭 안 iframe은 크롬이 "다른 사이트 안에 들어간 페이지"로 보기 때문에
//   - document.cookie로 SameSite=Lax/Strict 쿠키를 읽을 수 없고 (서버로 가는 요청에는 붙는다)
//   - document.cookie로 SameSite를 안 정한(=Lax) 쿠키를 쓰면 조용히 버려진다.
// 그래서 Qwen처럼 화면 스크립트가 로그인 쿠키를 읽어 로그인 여부를 정하는 사이트는 로그아웃 화면을 띄운다.
//
// 읽기: background.js가 그 쿠키를 "이 확장 탭에서만 보이는 칸(partitioned 쿠키)"에 복사해 둔다 (mirrorJsCookies).
// 쓰기: 여기서 document.cookie 쓰기를 같은 칸에 쓰도록 바꿔 바로 읽히게 하고, 원래 쿠키에도 반영하도록
//       cookie-bridge.js → background.js로 넘긴다. 이 칸의 쿠키는 일반 탭의 그 사이트에는 보이지도 붙지도 않는다.
(() => {
  const ancestors = location.ancestorOrigins;
  if (window === window.top || window.parent !== window.top || !ancestors?.[0]?.startsWith('chrome-extension://')) return;
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (!desc?.get || !desc.set) return;
  const PLACEMENT = /^\s*(samesite|secure|partitioned)\s*(=|$)/i;

  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set(raw) {
      const text = String(raw);
      const [pair, ...attrs] = text.split(';');
      // SameSite=None 쿠키는 iframe에서도 원래대로 읽히고 써진다
      if (this !== document || attrs.some((a) => /^\s*samesite\s*=\s*none\s*$/i.test(a))) return desc.set.call(this, raw);
      desc.set.call(this, [pair, ...attrs.filter((a) => !PLACEMENT.test(a)), ' Secure', ' SameSite=None', ' Partitioned'].join(';'));
      document.dispatchEvent(new CustomEvent('mla-cookie-write', { detail: text }));
    },
  });
})();
