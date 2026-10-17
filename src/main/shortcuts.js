'use strict';

// 앱 전체 단축키. 포커스가 서비스 패널(웹 페이지) 안에 있어도 동작하도록
// 모든 webContents의 before-input-event에서 가로챈다.
//
// 표에 없는 키는 그대로 페이지에 넘어간다.
const SHORTCUTS = [
  { keys: 'Ctrl+L', action: 'focus-composer', label: '공통 입력창으로 이동' },
  { keys: 'Ctrl+Shift+N', action: 'newchat-all', label: '모두 새 대화' },
  { keys: 'Ctrl+Shift+S', action: 'synth', label: '종합 요청' },
  { keys: 'Ctrl+Shift+C', action: 'copy-all', label: '모든 답변 복사 (Markdown)' },
  { keys: 'Ctrl+Shift+D', action: 'view:compare', label: '답변 비교 화면 열기/닫기' },
  { keys: 'Ctrl+H', action: 'view:history', label: '기록 화면 열기/닫기' },
  { keys: 'Ctrl+Shift+R', action: 'reload-all', label: '모두 새로고침' },
  { keys: 'Ctrl+1~9', action: 'target:N', label: 'N번째 보낼 대상 켜기/끄기' },
  { keys: 'Alt+1~9', action: 'panel:N', label: 'N번째 패널로 포커스 이동' },
  { keys: 'Ctrl+/', action: 'view:help', label: '단축키 도움말' },
  { keys: 'Esc', action: 'view:panels', label: '비교·기록·도움말 화면에서 패널로 돌아가기' },
];

/**
 * 키 입력을 동작 이름으로 바꾼다. 해당 없으면 null.
 * canEscape: Esc를 가로챌지 (패널 화면에서는 페이지가 Esc를 써야 하므로 false)
 */
function shortcutFor(input, { canEscape }) {
  if (input.type !== 'keyDown') return null;
  const ctrl = input.control || input.meta;
  const key = (input.key || '').toLowerCase();

  if (key === 'escape' && canEscape && !ctrl && !input.alt && !input.shift) return 'view:panels';
  if (input.alt && !ctrl && !input.shift && /^[1-9]$/.test(key)) return `panel:${key}`;
  if (!ctrl || input.alt) return null;

  if (input.shift) {
    return { n: 'newchat-all', s: 'synth', c: 'copy-all', d: 'view:compare', r: 'reload-all' }[key] || null;
  }
  if (/^[1-9]$/.test(key)) return `target:${key}`;
  // "/"는 키보드 배치에 따라 key 값이 달라질 수 있어 물리 키(code)로도 본다.
  if (key === '/' || input.code === 'Slash') return 'view:help';
  return { l: 'focus-composer', h: 'view:history' }[key] || null;
}

module.exports = { SHORTCUTS, shortcutFor };
