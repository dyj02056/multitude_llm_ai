'use strict';
// 파일 나무 키보드 이동 · 화면 확대 · 테두리 대비 (v0.31.0 접근성) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 파일 나무에서 방향키 · Home · End · Enter · Space가 탐색기처럼 움직이는지
//   - 다시 그린 뒤에도 보던 줄(접혔으면 부모 폴더)로 포커스가 돌아가는지
//   - Ctrl + / − / 0 을 알아보고, 확대 단계와 패널 자리 계산이 맞는지
//   - 버튼 · 입력칸 테두리가 바탕과 3:1 이상 차이 나는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TN = require('../src/shared/tree-nav');
const L = require('../src/shared/layout');
const { shortcutList, shortcutFor } = require('../src/shared/shortcuts');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// src/ (펼침) → a.js, lib/ (접힘) · docs/ (펼침, 비어 있음) · README.md
const ROWS = [
  { path: 'src', depth: 0, kind: 'dir', expanded: true },
  { path: 'src/a.js', depth: 1, kind: 'file' },
  { path: 'src/lib', depth: 1, kind: 'dir', expanded: false },
  { path: 'docs', depth: 0, kind: 'dir', expanded: true },
  { path: 'README.md', depth: 0, kind: 'file' },
];

test('파일 나무: ↑ ↓ Home End는 줄을 옮기고, 끝에서는 아무것도 하지 않는다', () => {
  assert.deepEqual(TN.keyAction(ROWS, 0, 'ArrowDown'), { focus: 1 });
  assert.deepEqual(TN.keyAction(ROWS, 2, 'ArrowUp'), { focus: 1 });
  assert.equal(TN.keyAction(ROWS, 0, 'ArrowUp'), null);
  assert.equal(TN.keyAction(ROWS, 4, 'ArrowDown'), null);
  assert.deepEqual(TN.keyAction(ROWS, 3, 'Home'), { focus: 0 });
  assert.deepEqual(TN.keyAction(ROWS, 1, 'End'), { focus: 4 });
  assert.equal(TN.keyAction(ROWS, 0, 'Home'), null);
  assert.equal(TN.keyAction(ROWS, 1, 'a'), null); // 모르는 키는 그대로 둔다
  assert.equal(TN.keyAction([], 0, 'ArrowDown'), null);
});

test('파일 나무: → 는 펼치거나 첫 항목으로, ← 는 접거나 부모로', () => {
  assert.deepEqual(TN.keyAction(ROWS, 2, 'ArrowRight'), { toggle: 'src/lib' }); // 접힌 폴더 → 펼치기
  assert.deepEqual(TN.keyAction(ROWS, 0, 'ArrowRight'), { focus: 1 }); // 펼친 폴더 → 첫 항목
  assert.equal(TN.keyAction(ROWS, 3, 'ArrowRight'), null); // 펼쳤지만 빈 폴더
  assert.equal(TN.keyAction(ROWS, 1, 'ArrowRight'), null); // 파일
  assert.deepEqual(TN.keyAction(ROWS, 0, 'ArrowLeft'), { toggle: 'src' }); // 펼친 폴더 → 접기
  assert.deepEqual(TN.keyAction(ROWS, 1, 'ArrowLeft'), { focus: 0 }); // 파일 → 부모 폴더
  assert.deepEqual(TN.keyAction(ROWS, 2, 'ArrowLeft'), { focus: 0 }); // 접힌 폴더 → 부모 폴더
  assert.equal(TN.keyAction(ROWS, 4, 'ArrowLeft'), null); // 맨 위 단계의 파일
  assert.equal(TN.parentIndex(ROWS, 2), 0);
  assert.equal(TN.parentIndex(ROWS, 3), -1);
});

test('파일 나무: Enter는 폴더 펼치기/접기 · 파일 열기, Space는 체크', () => {
  assert.deepEqual(TN.keyAction(ROWS, 0, 'Enter'), { toggle: 'src' });
  assert.deepEqual(TN.keyAction(ROWS, 1, 'Enter'), { open: 'src/a.js' });
  assert.deepEqual(TN.keyAction(ROWS, 1, ' '), { check: 'src/a.js' });
  assert.deepEqual(TN.keyAction(ROWS, 0, ' '), { check: 'src' });
  assert.deepEqual(TN.keyAction(ROWS, 99, 'Enter'), { open: 'README.md' }); // 범위를 벗어난 번호는 끝 줄로
});

test('파일 나무: 다시 그린 뒤 포커스는 보던 줄, 접혀 사라졌으면 가장 가까운 부모, 없으면 첫 줄', () => {
  assert.equal(TN.focusIndex(ROWS, 'src/a.js'), 1);
  assert.equal(TN.focusIndex(ROWS, 'src/lib/deep/x.js'), 2); // src/lib가 접혀 있다
  assert.equal(TN.focusIndex(ROWS, 'gone/file.js'), 0);
  assert.equal(TN.focusIndex(ROWS, ''), 0);
  assert.equal(TN.focusIndex([], 'src'), -1);
});

test('파일 나무 화면: role="tree" · 줄은 treeitem · Tab은 한 줄에만 · 다시 그려도 포커스를 돌려준다', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="psTree" class="ps-tree" role="tree" data-i18n-aria="project\.tree\.aria"/);
  assert.ok(html.indexOf('shared/tree-nav.js') > 0 && html.indexOf('shared/tree-nav.js') < html.indexOf('src="project.js"'));
  const js = read('src/renderer/project.js');
  assert.match(js, /row\.setAttribute\('role', 'treeitem'\)/);
  assert.match(js, /row\.setAttribute\('aria-level', String\(e\.depth \+ 1\)\)/);
  assert.match(js, /row\.setAttribute\('aria-expanded', String\(project\.expanded\.has\(e\.path\)\)\)/);
  assert.match(js, /row\.tabIndex = i === focusAt \? 0 : -1;/);
  assert.match(js, /box\.tabIndex = -1;/);
  assert.match(js, /TN\.keyAction\(navRows\(entries\), index, ev\.key\)/);
  assert.match(js, /if \(hadFocus && focusAt >= 0\) rows\[focusAt\]\.focus\(\);/);
  assert.match(read('src/renderer/styles.css'), /\.ps-row:focus-visible/);
});

test('화면 확대: Ctrl + / − / 0 알아보기 (자판 · 숫자판), 다른 키는 아님', () => {
  const k = (o) => L.zoomKey({ type: 'keyDown', control: true, ...o });
  assert.equal(k({ key: '=', code: 'Equal' }), 1);
  assert.equal(k({ key: '+', code: 'Equal', shift: true }), 1);
  assert.equal(k({ key: '+', code: 'NumpadAdd' }), 1);
  assert.equal(k({ key: '-', code: 'Minus' }), -1);
  assert.equal(k({ key: '-', code: 'NumpadSubtract' }), -1);
  assert.equal(k({ key: '0', code: 'Digit0' }), 0);
  assert.equal(k({ key: '0', code: 'Numpad0' }), 0);
  assert.equal(k({ key: 'l', code: 'KeyL' }), null);
  assert.equal(k({ key: '1', code: 'Digit1' }), null); // Ctrl+1 = 보낼 대상 켜기/끄기
  assert.equal(L.zoomKey({ type: 'keyDown', key: '=', code: 'Equal' }), null); // Ctrl 없이
  assert.equal(L.zoomKey({ type: 'keyUp', control: true, key: '=' }), null);
  assert.equal(L.zoomKey({ type: 'keyDown', control: true, alt: true, key: '=' }), null);
  // 기존 단축키와 겹치지 않는다
  for (const o of [{ key: '=', code: 'Equal' }, { key: '-', code: 'Minus' }, { key: '0', code: 'Digit0' }]) {
    assert.equal(shortcutFor({ type: 'keyDown', control: true, ...o }, { canEscape: true }), null);
  }
});

test('화면 확대: 단계는 0.8~2, 끝에서 멈추고, 저장된 이상한 값은 가까운 단계 · 1로', () => {
  assert.equal(L.normalizeZoom(undefined), 1);
  assert.equal(L.normalizeZoom('abc'), 1);
  assert.equal(L.normalizeZoom(-2), 1);
  assert.equal(L.normalizeZoom(1.3), 1.25);
  assert.equal(L.normalizeZoom(9), 2);
  assert.equal(L.zoomStep(1, 1), 1.1);
  assert.equal(L.zoomStep(1, -1), 0.9);
  assert.equal(L.zoomStep(2, 1), 2);
  assert.equal(L.zoomStep(0.8, -1), 0.8);
  assert.equal(L.zoomStep(1.75, 0), 1);
});

test('화면 확대: 패널 자리는 화면 픽셀로 계산해 창 픽셀로 바꾼다 (이웃한 칸 사이가 벌어지지 않게)', () => {
  assert.deepEqual(L.scaleRect({ x: 0, y: 44, width: 400, height: 300 }, 1), { x: 0, y: 44, width: 400, height: 300 });
  assert.deepEqual(L.scaleRect({ x: 0, y: 44, width: 400, height: 300 }, 1.5), { x: 0, y: 66, width: 600, height: 450 });
  // 나란한 두 칸(사이 4px): 반올림해도 왼쪽 칸의 오른쪽 끝 + 틈 = 오른쪽 칸의 왼쪽 끝
  const a = L.scaleRect({ x: 0, y: 0, width: 333, height: 100 }, 1.1);
  const gap = L.scaleRect({ x: 333, y: 0, width: 4, height: 100 }, 1.1);
  const b = L.scaleRect({ x: 337, y: 0, width: 333, height: 100 }, 1.1);
  assert.equal(a.x + a.width, gap.x);
  assert.equal(gap.x + gap.width, b.x);
  assert.deepEqual(L.scaleRect({ x: 1, y: 1, width: 1, height: 1 }, 0), { x: 1, y: 1, width: 1, height: 1 }); // 잘못된 배율은 1로
});

test('화면 확대: 단축키 표에는 Windows 앱에서만 나오고, 본체가 키를 받아 패널 자리를 다시 잡는다', () => {
  assert.ok(shortcutList().some((s) => s.keys === 'Ctrl++ Ctrl+- Ctrl+0'));
  assert.ok(!shortcutList({ browser: true }).some((s) => /Ctrl\+\+/.test(s.keys)));
  const main = read('src/main/main.js');
  assert.match(main, /const zoomDir = zoomKey\(input\);/);
  assert.match(main, /getContentSize\(\)\.map\(\(n\) => Math\.floor\(n \/ uiZoom\(\)\)\)/);
  assert.match(main, /setBounds\(showPanels && !r\.hidden \? toWin\(r\.content\)/);
  assert.match(main, /prefs\.uiZoom = normalizeZoom\(prefs\.uiZoom\);/);
});

test('색 대비: 버튼 · 입력칸 테두리(--control-border)는 세 바탕색 모두에서 3:1 이상 (WCAG 1.4.11)', () => {
  const A = require('./helpers/a11y-scan');
  const css = read('src/renderer/styles.css').replace(/\r\n/g, '\n');
  const tok = A.cssTokens(css);
  assert.match(tok['--control-border'] || '', /^#[0-9a-f]{6}$/);
  for (const b of ['--bg', '--bg-2', '--field-hover']) assert.ok(A.contrast(tok['--control-border'], tok[b]) >= 3, `${b} ${A.contrast(tok['--control-border'], tok[b]).toFixed(2)}`);
  assert.match(css, /\nbutton \{[^}]*border: 1px solid var\(--control-border\)/);
  // 글을 쓰는 칸 · 고르기 칸 가운데 옅은 선(--border)을 테두리로 쓰는 규칙이 남아 있지 않다
  const left = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ');
    if (/border: 1px solid var\(--border\)/.test(m[2]) && /(^|[\s,>])(input|select|textarea)\b|#prompt$|#spPrompt$/.test(sel)) left.push(sel);
  }
  assert.deepEqual(left, []);
  assert.match(read('extension/sidepanel.css'), /#spPrompt \{[^}]*var\(--control-border\)/);
});
