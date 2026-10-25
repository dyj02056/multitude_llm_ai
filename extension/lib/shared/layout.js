// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/layout.js)
// 패널 배치. Electron 앱(main.js computeRects)과 크롬 확장 프로그램(host.js, 전역 MLA.layout)이 같이 쓴다.
//
// 배치는 C열 × R행 격자 위의 칸(c, r에서 시작해 cs열 · rs행을 차지)으로 나타낸다.
//   grid  격자:   1~3개는 한 줄, 4개 2×2, 5개 위 3 · 아래 2, 6개 3×2
//   row   가로:   한 줄에 모두
//   main  큰 칸:  첫 패널을 왼쪽에 크게(3/5), 나머지는 오른쪽에 위아래로
//   tall  2열:    두 열로 쌓기 (2개는 위아래, 홀수면 마지막 칸이 두 열을 차지, 6개 2×3)
//
// [쉽게 말하면] 패널 여러 개를 화면에 어떻게 나눠 놓을지 계산하는 "자리 배치표"입니다.
// 화면을 바둑판(C칸 × R줄)으로 나누고, 패널마다 "몇 번째 칸부터 몇 칸을 차지하는지"를 정합니다.
// 예: 5개 격자 = 위 3개, 아래 2개 → 6칸짜리 바둑판에서 위 패널은 2칸씩, 아래 패널은 3칸씩 차지
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).layout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LAYOUTS = ['grid', 'row', 'main', 'tall'];
  const DEFAULT_LAYOUT = 'grid';
  const normalizeLayout = (v) => (LAYOUTS.includes(v) ? v : DEFAULT_LAYOUT);

  /** n개 패널의 칸 목록 → { C, R, cells: [{ c, r, cs, rs }] } */
  function layoutCells(layout, n) {
    const cell = (c, r, cs = 1, rs = 1) => ({ c, r, cs, rs });
    if (n <= 1) return { C: 1, R: 1, cells: n ? [cell(0, 0)] : [] };
    const line = () => ({ C: n, R: 1, cells: Array.from({ length: n }, (_, i) => cell(i, 0)) });
    switch (normalizeLayout(layout)) {
      case 'row':
        return line();
      case 'main':
        return {
          C: 5,
          R: n - 1,
          cells: [cell(0, 0, 3, n - 1), ...Array.from({ length: n - 1 }, (_, i) => cell(3, i, 2, 1))],
        };
      case 'tall': {
        const C = n <= 2 ? 1 : 2;
        const R = Math.ceil(n / C);
        const cells = Array.from({ length: n }, (_, i) => cell(i % C, Math.floor(i / C)));
        if (n % C) cells[n - 1].cs = C; // 홀수면 마지막 칸이 줄을 채운다
        return { C, R, cells };
      }
      default: {
        if (n <= 3) return line();
        if (n === 4) return { C: 2, R: 2, cells: [cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)] };
        if (n === 5) return { C: 6, R: 2, cells: [cell(0, 0, 2), cell(2, 0, 2), cell(4, 0, 2), cell(0, 1, 3), cell(3, 1, 3)] };
        const C = 3;
        const R = Math.ceil(n / C);
        return { C, R, cells: Array.from({ length: n }, (_, i) => cell(i % C, Math.floor(i / C))) };
      }
    }
  }

  /**
   * 화면 영역(area: { x, y, width, height })에 칸을 놓는다. → [{ x, y, width, height }] (n개, 순서대로)
   * gap: 칸 사이·가장자리 간격(px)
   */
  // 위에서 정한 칸을 실제 픽셀 위치(x, y, 폭, 높이)로 바꿉니다. gap은 패널 사이 간격입니다.
  function placeCells(layout, n, area, gap) {
    const { C, R, cells } = layoutCells(layout, n);
    const unitW = (area.width - gap * (C + 1)) / C;
    const unitH = (area.height - gap * (R + 1)) / R;
    return cells.map(({ c, r, cs, rs }) => ({
      x: Math.round(area.x + gap + c * (unitW + gap)),
      y: Math.round(area.y + gap + r * (unitH + gap)),
      width: Math.max(0, Math.floor(cs * unitW + (cs - 1) * gap)),
      height: Math.max(0, Math.floor(rs * unitH + (rs - 1) * gap)),
    }));
  }

  return { LAYOUTS, DEFAULT_LAYOUT, normalizeLayout, layoutCells, placeCells };
});
