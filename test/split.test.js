'use strict';
// 큰 작업: 계획 먼저, 파일별로 받기 (v0.18.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 계획 답의 PLAN_FILES 줄과 "- 경로: 할 일" 목록을 읽는지
//   - 파일 하나를 부탁하는 글이 순서 · 경로 · 할 일 · 형식을 담는지
//   - 고른 파일이 많거나 길면 큰 작업을 권하는지
const test = require('node:test');
const assert = require('node:assert/strict');
const PC = require('../src/shared/project-context');

const PLAN = [
  '로그인 흐름을 세 파일로 나눠 고칩니다.',
  '',
  '- src/auth/login.js: 토큰 만료 처리 추가',
  '- `src/auth/session.ts` — 세션 갱신 함수 분리',
  '1. src/ui/LoginForm.jsx: 오류 메시지 표시',
  '- README.md: 사용법 갱신',
  '',
  '**PLAN_FILES:** `src/auth/login.js`, src/auth/session.ts, src/ui/LoginForm.jsx, README.md, src/auth/login.js',
  'DELETE_FILES: src/old.js',
].join('\n');

test('계획 읽기: PLAN_FILES 순서대로, 할 일 글을 붙이고, 중복은 한 번만', () => {
  const files = PC.parsePlanFiles(PLAN);
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/auth/login.js', 'src/auth/session.ts', 'src/ui/LoginForm.jsx', 'README.md'],
  );
  assert.equal(files[0].note, '토큰 만료 처리 추가');
  assert.equal(files[1].note, '세션 갱신 함수 분리');
  assert.equal(files[2].note, '오류 메시지 표시');
  assert.deepEqual(PC.parsePlanFiles('그냥 답입니다. 파일: a.js'), []); // PLAN_FILES 줄이 없으면 계획이 아니다
  const many = `PLAN_FILES: ${Array.from({ length: 40 }, (_, i) => `f${i}.js`).join(', ')}`;
  assert.equal(PC.parsePlanFiles(many).length, PC.MAX_PLAN_FILES);
});

test('파일 하나 부탁: 몇 번째인지 · 경로 · 할 일 · 이 파일만', () => {
  const t = PC.stepPrompt({ path: 'src/auth/session.ts', note: '세션 갱신 함수 분리' }, 1, 4);
  assert.match(t, /^계획대로 2\/4번째 파일만 줘: src\/auth\/session.ts — 세션 갱신 함수 분리/);
  assert.match(t, /"파일: src\/auth\/session.ts" 줄 다음 코드 블록 하나로/);
  assert.match(t, /찾기\/바꾸기/);
  assert.match(t, /다른 파일은 쓰지 마/);
});

test('계획 먼저 부탁 글 · 큰 작업 권하기', () => {
  assert.match(PC.PLAN_FIRST, /코드를 쓰지 마/);
  assert.match(PC.PLAN_FIRST, /PLAN_FILES: 경로1, 경로2/);
  assert.equal(PC.suggestSplit({ files: 3, lines: 200 }), false);
  assert.equal(PC.suggestSplit({ files: 5, lines: 200 }), true);
  assert.equal(PC.suggestSplit({ files: 2, lines: 900 }), true);
});
