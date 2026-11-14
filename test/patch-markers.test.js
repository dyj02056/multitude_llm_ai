'use strict';
// AI 수정안 읽기의 표시 줄 다루기 단위 테스트:  npm test
// [쉽게 말하면]
//   - 찾을 코드 · 바꿀 코드 안에 ======= 줄(마크다운 제목 밑줄 · 구분선)이 있어도 구분선을 바르게 골라 적용하는지
//   - 어느 줄로 나눠도 한 곳만 맞지 않으면 엉뚱하게 고치지 않고 실패로 알리는지
//   - diff에서 지운 줄 "-- 주석" · 더한 줄 "++i"가 파일 헤더(--- · +++)로 잘못 읽혀 hunk가 잘리지 않는지
//   - NEED_FILES · PLAN_FILES에서 프로젝트 밖 경로(../x)를 버리는지
const test = require('node:test');
const assert = require('node:assert/strict');
const PX = require('../src/shared/patch');
const PC = require('../src/shared/project-context');

const MD_FILE = ['# 문서', '', '소개', '=======', '', '첫 문단입니다.', '', '사용법', '=======', '', '둘째 문단입니다.', ''].join('\n');
const block = (path, body) => `파일: ${path}\n\`\`\`\`md\n${body}\n\`\`\`\``;

test('찾기/바꾸기: 찾을 부분에 ======= 줄이 있어도 파일과 맞는 구분선을 골라 적용한다', () => {
  const md = block('README.md', ['<<<<<<< 찾기', '사용법', '=======', '', '둘째 문단입니다.', '=======', '사용 방법', '=======', '', '둘째 문단을 고쳤습니다.', '>>>>>>> 바꾸기'].join('\n'));
  const [c] = PX.extractChanges(md);
  assert.equal(c.type, 'edit');
  assert.equal(c.edits.length, 1);
  assert.equal(c.edits[0].candidates.length, 3);
  const plan = PX.planChange(c, MD_FILE);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.after, MD_FILE.replace('사용법\n=======\n\n둘째 문단입니다.', '사용 방법\n=======\n\n둘째 문단을 고쳤습니다.'));
});

test('찾기/바꾸기: 바꿀 내용에만 ======= 줄이 있으면 첫 구분선으로 나눈다', () => {
  const md = block('README.md', ['<<<<<<< 찾기', '첫 문단입니다.', '=======', '첫 문단입니다.', '', '새 제목', '=======', '새 문단.', '>>>>>>> 바꾸기'].join('\n'));
  const [c] = PX.extractChanges(md);
  const plan = PX.planChange(c, MD_FILE);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.after, MD_FILE.replace('첫 문단입니다.', '첫 문단입니다.\n\n새 제목\n=======\n새 문단.'));
});

test('찾기/바꾸기: ======= 줄이 하나뿐이면 예전과 똑같이 읽는다 (candidates 없음)', () => {
  const { edits, complete } = PX.parseEdits('<<<<<<< 찾기\na\n=======\nb\n>>>>>>> 바꾸기');
  assert.equal(complete, true);
  assert.deepEqual(edits, [{ search: 'a', replace: 'b' }]);
});

test('찾기/바꾸기: 어느 구분선으로 나눠도 한 곳만 맞지 않으면 적용하지 않고 실패로 알린다', () => {
  // 찾을 부분 후보 "=======" 앞의 빈 줄 · "=======\n\n…" 모두 파일에 두 곳 이상 있다
  const md = block('README.md', ['<<<<<<< 찾기', '=======', '', '=======', 'X', '>>>>>>> 바꾸기'].join('\n'));
  const amb = PX.planChange(PX.extractChanges(md)[0], MD_FILE);
  assert.equal(amb.ok, false);
  assert.match(amb.error, /======= 줄이 여러 개/);
  assert.match(amb.error, /한 곳만 맞지 않습니다/);

  const miss = PX.planChange(PX.extractChanges(block('README.md', ['<<<<<<< 찾기', '없는 줄', '=======', '또 없는 줄', '=======', 'Y', '>>>>>>> 바꾸기'].join('\n')))[0], MD_FILE);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /찾지 못했습니다/);
});

test('diff: 지운 줄 "-- 주석" · 더한 줄 "++ x"를 파일 헤더로 읽지 않고 모든 hunk를 읽는다', () => {
  const FILE = ['select 1;', '-- comment', 'select 2;', 'i = 0', 'x', 'end', ''].join('\n');
  const diff = [
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -1,3 +1,3 @@',
    ' select 1;',
    '--- comment',
    '+++ comment2',
    ' select 2;',
    '@@ -4,3 +4,3 @@',
    ' i = 0',
    '-x',
    '+++i',
    ' end',
  ].join('\n');
  const [c] = PX.extractChanges(`\`\`\`diff\n${diff}\n\`\`\``);
  assert.equal(c.path, 'q.sql');
  assert.equal(c.hunks.length, 2);
  const plan = PX.planChange(c, FILE);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.after, ['select 1;', '++ comment2', 'select 2;', 'i = 0', '++i', 'end', ''].join('\n'));
});

test('diff: hunk 줄 수가 남아 있어도 바로 뒤에 @@가 오는 --- / +++는 다음 파일 헤더로 본다', () => {
  const diff = ['--- a/a.js', '+++ b/a.js', '@@ -1,5 +1,5 @@', '-a', '+A', '--- a/b.js', '+++ b/b.js', '@@ -1 +1 @@', '-b', '+B'].join('\n');
  const changes = PX.extractChanges(`\`\`\`diff\n${diff}\n\`\`\``);
  assert.deepEqual(changes.map((c) => c.path), ['a.js', 'b.js']);
  assert.equal(PX.planChange(changes[0], 'a\n').after, 'A\n');
  assert.equal(PX.planChange(changes[1], 'b\n').after, 'B\n');
});

test('NEED_FILES · PLAN_FILES: 프로젝트 밖 경로(../x) · 절대 경로는 버린다', () => {
  assert.deepEqual(PC.parseNeedFiles('NEED_FILES: src/a.js, ../x.js, /etc/passwd, ./b.js'), ['src/a.js', 'b.js']);
  const plan = PC.parsePlanFiles('- src/a.js: 고치기\n- ../x.js: 밖\nPLAN_FILES: src/a.js, ../x.js, src/../../y.js, b.md');
  assert.deepEqual(plan.map((f) => f.path), ['src/a.js', 'b.md']);
  assert.equal(plan[0].note, '고치기');
});

test('답변 규칙: ======= 줄이 있는 코드는 앞뒤 줄을 넉넉히 넣으라고 알린다', () => {
  assert.match(PC.RULES, /======= 만 있는 줄이 있으면/);
});
