// 앱 전체 단축키. 포커스가 서비스 패널(웹 페이지) 안에 있어도 동작하도록
// Electron 앱은 모든 webContents의 before-input-event에서, 크롬 확장 프로그램은 앱 탭과 패널 iframe의 keydown에서 가로챈다.
//
// 크롬은 Ctrl+Shift+N(시크릿 창)과 Ctrl+1~9(탭 이동)를 페이지에 넘겨주지 않는다.
// 그래서 확장 프로그램(browser: true)에서는 그 두 가지만 Alt+Shift+N / Alt+Shift+1~9로 바꿔 쓴다.
//
// 표에 없는 키는 그대로 페이지에 넘어간다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.shortcuts)이 같이 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).shortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHORTCUTS = [
    { keys: 'Ctrl+L', action: 'focus-composer', label: '공통 입력창으로 이동' },
    { keys: 'Ctrl+Shift+N', browserKeys: 'Alt+Shift+N', action: 'newchat-all', label: '모두 새 대화' },
    { keys: 'Ctrl+Shift+S', action: 'synth', label: '종합 요청' },
    { keys: 'Ctrl+Shift+C', action: 'copy-all', label: '모든 답변 복사 (Markdown)' },
    { keys: 'Ctrl+Shift+D', action: 'view:compare', label: '답변 비교 화면 열기/닫기' },
    { keys: 'Ctrl+Shift+P', browserKeys: 'Alt+Shift+P', action: 'view:changes', label: '변경 제안(프로젝트 수정안) 화면 열기/닫기' },
    { keys: 'Ctrl+H', action: 'view:history', label: '기록 화면 열기/닫기' },
    { keys: 'Ctrl+Shift+R', action: 'reload-all', label: '모두 새로고침' },
    { keys: 'Ctrl+1~9', browserKeys: 'Alt+Shift+1~6', action: 'target:N', label: 'N번째 보낼 대상 켜기/끄기' },
    { keys: 'Alt+1~9', browserKeys: 'Alt+1~6', action: 'panel:N', label: 'N번째 패널로 포커스 이동' },
    { keys: 'Ctrl+/', action: 'view:help', label: '단축키 도움말' },
    { keys: 'Esc', action: 'view:panels', label: '비교·변경 제안·파일 편집·git 콘솔·라이브러리·기록·도움말 화면에서 패널로 돌아가기 (변수 입력은 취소)' },
  ];

  /** 도움말 표에 보여 줄 목록 [{ keys, label }] */
  function shortcutList({ browser = false } = {}) {
    return SHORTCUTS.map(({ keys, browserKeys, label }) => ({ keys: (browser && browserKeys) || keys, label }));
  }

  /**
   * 키 입력을 동작 이름으로 바꾼다. 해당 없으면 null.
   * input: { type, key, code, control, meta, alt, shift } (Electron before-input-event 모양)
   * canEscape: Esc를 가로챌지 (패널 화면에서는 페이지가 Esc를 써야 하므로 false)
   * browser: 크롬 확장 프로그램용 키 배치
   */
  function shortcutFor(input, { canEscape, browser = false }) {
    if (input.type !== 'keyDown') return null;
    const ctrl = input.control || input.meta;
    const key = (input.key || '').toLowerCase();
    // Shift를 같이 누르면 key가 "!" 같은 글자로 바뀌므로 숫자는 물리 키(code)로 본다.
    const digit = /^Digit[1-9]$/.test(input.code || '') ? input.code.slice(5) : /^[1-9]$/.test(key) ? key : null;

    if (key === 'escape' && canEscape && !ctrl && !input.alt && !input.shift) return 'view:panels';
    if (input.alt && !ctrl && !input.shift && digit) return `panel:${digit}`;
    if (browser && input.alt && input.shift && !ctrl) {
      if (digit) return `target:${digit}`;
      return { n: 'newchat-all', p: 'view:changes' }[key] || null;
    }
    if (!ctrl || input.alt) return null;

    if (input.shift) {
      const map = { s: 'synth', c: 'copy-all', d: 'view:compare', r: 'reload-all' };
      // 크롬은 Ctrl+Shift+N(시크릿 창)을 넘겨주지 않고, Ctrl+Shift+P는 인쇄 대화상자라 확장에서는 Alt+Shift+를 쓴다.
      if (!browser) Object.assign(map, { n: 'newchat-all', p: 'view:changes' });
      return map[key] || null;
    }
    if (digit) return browser ? null : `target:${digit}`;
    // "/"는 키보드 배치에 따라 key 값이 달라질 수 있어 물리 키(code)로도 본다.
    if (key === '/' || input.code === 'Slash') return 'view:help';
    return { l: 'focus-composer', h: 'view:history' }[key] || null;
  }

  return { SHORTCUTS, shortcutList, shortcutFor };
});
