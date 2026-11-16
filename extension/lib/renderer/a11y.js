// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/a11y.js)
'use strict';

// 접근성 — 창(dialog) 포커스 관리 (v0.30.0). 미리보기 · 적용, 화면 상태, 보내기 전 미리보기, 토론, 설정 가져오기 창에 똑같이 적용한다.
//   - 창이 열리면: 그때 포커스가 있던 곳을 기억하고, 창 안에 포커스가 없으면 창 상자로 옮긴다 (화면 읽기 프로그램이 제목을 읽는다)
//   - 창이 열린 동안: Tab · Shift+Tab이 창 밖으로 나가지 않고 창 안에서 돈다
//   - 창이 닫히면: 기억해 둔 곳으로 포커스를 돌려준다 (그 요소가 아직 화면에 있을 때)
// 닫기(Esc)는 각 창과 본체 단축키(Esc = 패널 화면으로)가 이미 한다. 창은 index.html의 <div class="modal" hidden>이고,
// 열고 닫는 코드는 hidden 속성만 바꾸므로 그 변화를 지켜본다 (창마다 코드를 고치지 않는다). 모든 화면 스크립트 다음에 읽힌다.
//
// [쉽게 말하면] 키보드만 쓰는 사람이 창을 열었을 때, Tab 키가 창 뒤의 화면으로 새지 않게 하고
// 창을 닫으면 원래 누르던 버튼으로 돌아오게 해 주는 부분입니다.
(() => {
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const boxOf = (modal) => modal.querySelector('[role="dialog"]') || modal;
  const focusables = (modal) => [...boxOf(modal).querySelectorAll(FOCUSABLE)].filter(visible);
  const before = new WeakMap(); // 창 → 열리기 전에 포커스가 있던 요소

  function onShown(modal) {
    const prev = document.activeElement;
    before.set(modal, prev && prev !== document.body && !modal.contains(prev) ? prev : null);
    // 여는 코드가 스스로 포커스를 줄 수도 있으니 (예: 비밀번호 칸) 그 뒤에 본다
    setTimeout(() => {
      if (modal.hidden || modal.contains(document.activeElement)) return;
      const box = boxOf(modal);
      if (!box.hasAttribute('tabindex')) box.tabIndex = -1;
      box.focus({ preventScroll: true });
    }, 0);
  }

  function onHidden(modal) {
    const prev = before.get(modal);
    before.delete(modal);
    const cur = document.activeElement;
    // 닫으면서 다른 곳으로 이미 포커스를 옮겼으면 (예: 입력창) 건드리지 않는다
    if (prev && prev.isConnected && visible(prev) && (!cur || cur === document.body || modal.contains(cur))) prev.focus({ preventScroll: true });
  }

  function trap(modal, e) {
    if (e.key !== 'Tab' || modal.hidden) return;
    const list = focusables(modal);
    if (!list.length) return e.preventDefault();
    const first = list[0];
    const last = list[list.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || !list.includes(cur))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (cur === last || !boxOf(modal).contains(cur))) {
      e.preventDefault();
      first.focus();
    }
  }

  for (const modal of document.querySelectorAll('.modal')) {
    new MutationObserver(() => (modal.hidden ? onHidden(modal) : onShown(modal))).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    modal.addEventListener('keydown', (e) => trap(modal, e));
  }
})();
