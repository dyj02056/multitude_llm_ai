'use strict';
// 패널 배치 (v0.7.1) 단위 테스트:  npm test
// [쉽게 말하면] 패널 배치(격자·가로·큰 칸·2열)를 1~6개로 계산했을 때 칸이 겹치지 않고 화면 안에 들어가는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/shared/layout');
const S = require('../src/shared/services');

const area = { x: 0, y: 0, width: 1206, height: 606 };
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('배치마다 1~6개 칸이 영역 안에 겹치지 않게 놓인다', () => {
  for (const layout of L.LAYOUTS) {
    for (let n = 1; n <= S.MAX_SELECTED; n++) {
      const cells = L.placeCells(layout, n, area, 6);
      assert.equal(cells.length, n, `${layout} ${n}`);
      for (const c of cells) {
        assert.ok(c.width > 0 && c.height > 0 && c.x >= 0 && c.y >= 0, `${layout} ${n}`);
        assert.ok(c.x + c.width <= area.width && c.y + c.height <= area.height, `${layout} ${n} 영역 밖`);
      }
      for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) assert.equal(overlap(cells[i], cells[k]), false, `${layout} ${n}: ${i}·${k}`);
    }
  }
});

test('모양: 격자 5개는 위 3·아래 2, 6개는 3×2, 큰 칸은 첫 패널이 가장 큼, 2열 6개는 2×3', () => {
  const rows = (cells) => new Set(cells.map((c) => c.y)).size;
  const g5 = L.placeCells('grid', 5, area, 6);
  assert.equal(g5.filter((c) => c.y === g5[0].y).length, 3);
  assert.equal(rows(L.placeCells('grid', 6, area, 6)), 2);
  assert.equal(rows(L.placeCells('grid', 4, area, 6)), 2);
  const m = L.placeCells('main', 4, area, 6);
  assert.ok(m[0].width * m[0].height > 2 * m[1].width * m[1].height);
  assert.equal(rows(L.placeCells('tall', 6, area, 6)), 3);
  assert.equal(L.placeCells('tall', 3, area, 6)[2].width > L.placeCells('tall', 3, area, 6)[0].width, true, '홀수 마지막 칸은 두 열');
  assert.equal(L.normalizeLayout('weird'), 'grid');
});

test('모델 선택: 최대 6개, 처음 값은 4개', () => {
  assert.equal(S.MAX_SELECTED, 6);
  assert.equal(S.DEFAULT_SELECTED.length, 4);
  assert.equal(S.normalizeSelected(S.SERVICES.map((s) => s.id)).length, 6);
});
