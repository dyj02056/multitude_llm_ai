// 앱 전체 단축키. 포커스가 서비스 패널(웹 페이지) 안에 있어도 동작하도록
// Electron 앱은 모든 webContents의 before-input-event에서, 크롬 확장 프로그램은 앱 탭과 패널 iframe의 keydown에서 가로챈다.
//
// 크롬은 Ctrl+Shift+N(시크릿 창)과 Ctrl+1~9(탭 이동)를 페이지에 넘겨주지 않는다.
// 그래서 확장 프로그램(browser: true)에서는 그 두 가지만 Alt+Shift+N / Alt+Shift+1~9로 바꿔 쓴다.
//
// 표에 없는 키는 그대로 페이지에 넘어간다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.shortcuts)이 같이 쓴다.
//
// [쉽게 말하면] 키보드 단축키 목록과, 누른 키가 어떤 단축키인지 알아내는 함수입니다.
// 크롬 확장에서는 크롬이 이미 쓰는 단축키와 겹치지 않게 Alt+Shift 조합을 씁니다 (browser: true).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).shortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 화면 문구 (v0.30.0): 부를 때마다 사전에서 찾는다 (언어를 바꾸면 바로 반영). 사전이 없는 곳(서비스 페이지 등)에서는 키 이름 그대로
  const t = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };

  // label은 부를 때마다 labelKey로 사전에서 찾는다 (아래 defineProperty)
  const SHORTCUTS = [
    { keys: 'Ctrl+L', action: 'focus-composer', labelKey: 'main.shortcut.focusComposer' },
    { keys: 'Ctrl+Shift+N', browserKeys: 'Alt+Shift+N', action: 'newchat-all', labelKey: 'main.shortcut.newchatAll' },
    { keys: 'Ctrl+Shift+S', action: 'synth', labelKey: 'main.shortcut.synth' },
    { keys: 'Ctrl+Shift+C', action: 'copy-all', labelKey: 'main.shortcut.copyAll' },
    { keys: 'Ctrl+Shift+D', action: 'view:compare', labelKey: 'main.shortcut.compare' },
    { keys: 'Ctrl+Shift+P', browserKeys: 'Alt+Shift+P', action: 'view:changes', labelKey: 'main.shortcut.changes' },
    { keys: 'Ctrl+H', action: 'view:history', labelKey: 'main.shortcut.history' },
    { keys: 'Ctrl+Shift+R', action: 'reload-all', labelKey: 'main.shortcut.reloadAll' },
    { keys: 'Ctrl+1~9', browserKeys: 'Alt+Shift+1~6', action: 'target:N', labelKey: 'main.shortcut.target' },
    { keys: 'Alt+1~9', browserKeys: 'Alt+1~6', action: 'panel:N', labelKey: 'main.shortcut.panel' },
    { keys: 'Ctrl+/', action: 'view:help', labelKey: 'main.shortcut.help' },
    // 화면 확대 (v0.31.0, Windows 앱만 — 크롬 확장은 브라우저 확대를 쓴다). 누른 키 알아보기는 layout.js zoomKey, 처리는 main.js
    { keys: 'Ctrl++ Ctrl+- Ctrl+0', action: 'zoom', appOnly: true, labelKey: 'main.shortcut.zoom' },
    { keys: 'Esc', action: 'view:panels', labelKey: 'main.shortcut.back' },
  ];
  for (const s of SHORTCUTS) Object.defineProperty(s, 'label', { get: () => t(s.labelKey), enumerable: true });

  /** 도움말 표에 보여 줄 목록 [{ keys, label }] */
  function shortcutList({ browser = false } = {}) {
    return SHORTCUTS.filter((s) => !(browser && s.appOnly)).map(({ keys, browserKeys, label }) => ({ keys: (browser && browserKeys) || keys, label }));
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
