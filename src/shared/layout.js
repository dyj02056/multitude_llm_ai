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

  /**
   * 패널 아래 바 줄 수 (v0.28.0): 변경 바와 제안 바가 함께 뜨면 2줄을 쌓는다.
   * 예전 값(true/false)도 받는다: true → 1, 그 밖의 이상한 값 → 0. 0~2만 돌려준다.
   */
  function barRows(v) {
    if (v === true) return 1;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_BAR_ROWS) : 0;
  }
  const MAX_BAR_ROWS = 2;

  // ---------- 화면 확대 (v0.31.0 접근성, Windows 앱) ----------
  // 앱 화면(툴바 · 입력창 · 목록)의 글자가 12.5px라 작다. Ctrl + / − / 0 으로 앱 화면만 키운다 (AI 사이트 패널은 그 사이트의 크기 그대로).
  // 확대하면 툴바 · 입력창이 그만큼 커지므로, 패널 자리는 "화면(CSS) 픽셀"로 계산한 뒤 창 픽셀로 바꿔야 어긋나지 않는다 (scaleRect).
  const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const DEFAULT_ZOOM = 1;

  /** 저장된 확대 값 정리: ZOOM_STEPS 중 가장 가까운 값 (숫자가 아니면 1) */
  function normalizeZoom(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_ZOOM;
    return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), DEFAULT_ZOOM);
  }

  /** 한 단계 키우기(dir > 0) · 줄이기(dir < 0) · 처음으로(dir === 0). 끝에서는 그대로 */
  function zoomStep(current, dir) {
    if (!dir) return DEFAULT_ZOOM;
    const at = ZOOM_STEPS.indexOf(normalizeZoom(current));
    return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + (dir > 0 ? 1 : -1)))];
  }

  /**
   * 키 입력이 확대 단축키인지 → 1(키우기) · -1(줄이기) · 0(처음으로) · null(아님).
   * input: Electron before-input-event 모양 { type, key, code, control, meta, alt }.
   * Ctrl + '+'는 자판에 따라 Shift가 붙거나('+') 안 붙는다('=') — 둘 다 받고, 숫자판(NumpadAdd 등)도 받는다.
   */
  function zoomKey(input) {
    if (!input || input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
    const key = input.key || '';
    const code = input.code || '';
    if (key === '+' || key === '=' || code === 'NumpadAdd') return 1;
    if (key === '-' || key === '_' || code === 'NumpadSubtract') return -1;
    if ((key === '0' && !input.shift) || code === 'Numpad0') return 0;
    return null;
  }

  /** 화면(CSS) 픽셀 사각형 → 창 픽셀 (확대 배율을 곱하고 정수로). 반올림으로 칸 사이가 벌어지지 않게 양 끝을 따로 반올림한다 */
  function scaleRect(r, zoom) {
    const z = Number(zoom) > 0 ? Number(zoom) : 1;
    const x = Math.round(r.x * z);
    const y = Math.round(r.y * z);
    return { x, y, width: Math.max(0, Math.round((r.x + r.width) * z) - x), height: Math.max(0, Math.round((r.y + r.height) * z) - y) };
  }

  return { LAYOUTS, DEFAULT_LAYOUT, normalizeLayout, layoutCells, placeCells, barRows, MAX_BAR_ROWS, ZOOM_STEPS, DEFAULT_ZOOM, normalizeZoom, zoomStep, zoomKey, scaleRect };
});
