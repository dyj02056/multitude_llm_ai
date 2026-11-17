// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/tree-nav.js)
// 파일 나무 키보드 이동 (v0.31.0 접근성): 방향키 · Home · End · Enter · Space를 "무엇을 할지"로 바꾼다.
// 화면(DOM)을 모르는 순수 계산이라 단위 테스트로 확인한다. 실제로 포커스를 옮기고 펼치는 일은 renderer/project.js.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.treeNav)이 같이 쓴다.
//
// [쉽게 말하면] 프로젝트 사이드바의 파일 나무에서 ↑ ↓ ← → 를 눌렀을 때 어느 줄로 갈지, 폴더를 펼칠지 접을지를 정하는 부품입니다.
// 규칙은 탐색기 · VS Code와 같습니다 (WAI-ARIA의 tree 패턴):
//   ↓ ↑        다음 · 이전 줄
//   →          접힌 폴더는 펼치고, 펼친 폴더는 첫 항목으로
//   ←          펼친 폴더는 접고, 그 밖에는 부모 폴더로
//   Home · End 맨 위 · 맨 아래
//   Enter      폴더는 펼치기/접기, 파일은 편집기로 열기
//   Space      보낼 파일 체크/해제
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).treeNav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 보이는 줄들(rows: [{ path, depth, kind, expanded }]) 가운데 index 줄의 부모 폴더 위치 (없으면 -1) */
  function parentIndex(rows, index) {
    const depth = rows[index]?.depth ?? 0;
    for (let i = index - 1; i >= 0; i--) if (rows[i].depth < depth) return i;
    return -1;
  }

  /**
   * 키 하나 → 할 일. rows: 지금 보이는 줄(위에서 아래로), index: 포커스가 있는 줄, key: KeyboardEvent.key
   * → { focus: 줄 번호 } | { toggle: 경로 }(폴더 펼치기/접기) | { open: 경로 }(파일 열기) | { check: 경로 } | null(모르는 키 · 할 일 없음)
   */
  function keyAction(rows, index, key) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    const i = Math.min(Math.max(Number.isInteger(index) ? index : 0, 0), list.length - 1);
    const row = list[i];
    const dir = row.kind === 'dir';
    const moveTo = (n) => (n === i || n < 0 || n >= list.length ? null : { focus: n });
    switch (key) {
      case 'ArrowDown':
        return moveTo(i + 1);
      case 'ArrowUp':
        return moveTo(i - 1);
      case 'Home':
        return moveTo(0);
      case 'End':
        return moveTo(list.length - 1);
      case 'ArrowRight':
        if (!dir) return null;
        if (!row.expanded) return { toggle: row.path };
        // 펼친 폴더: 안에 항목이 있으면 첫 항목으로 (빈 폴더는 다음 줄이 더 깊지 않다)
        return list[i + 1] && list[i + 1].depth > row.depth ? { focus: i + 1 } : null;
      case 'ArrowLeft':
        if (dir && row.expanded) return { toggle: row.path };
        return moveTo(parentIndex(list, i));
      case 'Enter':
        return dir ? { toggle: row.path } : { open: row.path };
      case ' ':
      case 'Spacebar':
        return { check: row.path };
      default:
        return null;
    }
  }

  /**
   * 다시 그린 뒤 포커스를 둘 줄: 기억한 경로(path)가 보이면 그 줄, 접혀서 안 보이면 가장 가까운 보이는 부모, 그것도 없으면 첫 줄.
   * rows: [{ path }] → 줄 번호 (rows가 비면 -1)
   */
  function focusIndex(rows, path) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return -1;
    let p = String(path || '');
    while (p) {
      const at = list.findIndex((r) => r.path === p);
      if (at >= 0) return at;
      const cut = p.lastIndexOf('/');
      p = cut > 0 ? p.slice(0, cut) : '';
    }
    return 0;
  }

  return { keyAction, parentIndex, focusIndex };
});
