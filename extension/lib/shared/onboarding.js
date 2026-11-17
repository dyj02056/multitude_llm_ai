// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/onboarding.js)
// 첫 사용 안내 (v0.31.0): 걸음 목록과 "보여 줄지" 규칙. 화면은 renderer/onboarding.js가 그린다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.onboarding)이 같이 쓴다.
//
// [쉽게 말하면] 앱을 처음 켠 사람에게 한 번만 보여 주는 네 걸음 안내(묻기 → 비교 → 종합 → 더 해 볼 것)의 내용과,
// "이 사람에게 보여 줘야 하나"를 정하는 부품입니다.
//   - 새로 설치한 사람: 패널 화면에 처음 들어갈 때 한 번 보여 준다.
//   - 이전 버전부터 쓰던 사람(저장된 설정이 있는데 이 항목만 없음): 보여 주지 않는다 — 이미 쓰고 있다.
//   - 닫으면(끝까지 봤든 건너뛰었든) 다시 뜨지 않는다. 설정(?) 화면의 버튼으로 다시 볼 수 있다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).onboarding = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 걸음마다: 제목 · 본문 글의 사전 키(ui.onboard.<id>.title|body)와 함께 알려 줄 단축키
  const STEPS = [
    { id: 'ask', keys: ['Ctrl+L', 'Enter'] },
    { id: 'compare', keys: ['Ctrl+Shift+D'] },
    { id: 'synth', keys: ['Ctrl+Shift+S'] },
    { id: 'more', keys: ['Ctrl+H', 'Ctrl+/'] },
  ];

  /**
   * 저장된 설정 → 이미 본 것으로 칠지. saved: 저장소에서 읽은 설정 객체(처음 설치면 null · undefined)
   * 처음 설치 → false(보여 준다), 예전부터 쓰던 설정(항목 없음) → true, 적어 둔 값이 있으면 그 값
   */
  function wasOnboarded(saved) {
    if (!saved || typeof saved !== 'object') return false;
    return saved.onboarded !== false;
  }

  /** 지금 안내를 띄울 때인지: 채팅의 패널 화면이고, 설정이 "아직 안 봄"이며, 이번에 켠 뒤로 띄운 적이 없을 때 */
  function shouldShow(state, shownThisSession) {
    return !!state && state.mode === 'chat' && state.chatView === 'panels' && state.onboarded === false && !shownThisSession;
  }

  /** 걸음 옮기기: dir +1 다음 · -1 이전 → 새 번호 (0 ~ STEPS.length - 1 안에서) */
  const stepAt = (index, dir) => Math.min(STEPS.length - 1, Math.max(0, (Number.isInteger(index) ? index : 0) + dir));

  return { STEPS, wasOnboarded, shouldShow, stepAt };
});
