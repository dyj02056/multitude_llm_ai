'use strict';
// 찾기/바꾸기 블록 (v0.17.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 긴 파일은 전체 대신 "바꿀 곳만" 받는 형식(<<<<<<< 찾기 / ======= / >>>>>>> 바꾸기)을 읽고 적용하는지
//   - 찾을 부분이 딱 한 곳일 때만 바꾸고, 못 찾거나 여러 곳이면 적용하지 않는지
//   - 답이 잘려 마지막 찾기/바꾸기가 끝나지 않았으면 잘린 답변으로 보는지
//   - 답변 규칙 · 다시 요청 글이 긴 파일에 이 형식을 달라고 하는지
const test = require('node:test');
const assert = require('node:assert/strict');
const PX = require('../src/shared/patch');
const PC = require('../src/shared/project-context');
const PU = require('../src/shared/project-upload');

const FILE = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}', '', 'module.exports = { a, b };', ''].join('\n');
const block = (body, close = true) => `파일: src/x.js\n\`\`\`js\n${body}\n${close ? '```' : ''}`;

test('찾기/바꾸기: 여러 곳을 한 블록에서 바꾸고, 나머지는 그대로', () => {
  const md = block(['<<<<<<< 찾기', 'function a() {', '  return 1;', '=======', 'function a() {', '  return 10;', '>>>>>>> 바꾸기', '', '<<<<<<< 찾기', '  return 2;', '=======', '  return 20;', '>>>>>>> 바꾸기'].join('\n'));
  const [c] = PX.extractChanges(md);
  assert.equal(c.type, 'edit');
  assert.equal(c.edits.length, 2);
  const plan = PX.planChange(c, FILE);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.after, FILE.replace('return 1;', 'return 10;').replace('return 2;', 'return 20;'));
  assert.equal(plan.add, 2);
  assert.equal(plan.del, 2);
  assert.equal(plan.suspect, undefined); // 찾기/바꾸기는 전체 교체가 아니라 수상함 검사를 하지 않는다
});

test('찾기/바꾸기: 영어 표시(SEARCH/REPLACE), CRLF 파일, 줄 끝 공백 차이도 받는다', () => {
  const md = block(['<<<<<<< SEARCH', '  return 2;   ', '=======', '  return 22;', '>>>>>>> REPLACE'].join('\n'));
  const crlf = FILE.replace(/\n/g, '\r\n');
  const plan = PX.planChange(PX.extractChanges(md)[0], crlf);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.after, crlf.replace('return 2;', 'return 22;')); // 원래 CRLF를 지킨다
});

test('찾기/바꾸기: 찾을 부분이 없거나 여러 곳이면 적용하지 않는다 (엉뚱한 곳을 바꾸지 않게)', () => {
  const miss = PX.planChange(PX.extractChanges(block('<<<<<<< 찾기\n  return 3;\n=======\n  return 4;\n>>>>>>> 바꾸기'))[0], FILE);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /1번의 찾을 부분을 지금 파일에서 찾지 못했습니다/);
  const many = PX.planChange(PX.extractChanges(block('<<<<<<< 찾기\n}\n=======\n};\n>>>>>>> 바꾸기'))[0], FILE);
  assert.equal(many.ok, false);
  assert.match(many.error, /2곳 있어/);
  const empty = PX.planChange(PX.extractChanges(block('<<<<<<< 찾기\n\n=======\nx\n>>>>>>> 바꾸기'))[0], FILE);
  assert.match(empty.error, /비어 있습니다/);
});

test('찾기/바꾸기: 바꿀 내용이 비면 찾은 부분을 지운다', () => {
  const plan = PX.planChange(PX.extractChanges(block('<<<<<<< 찾기\nfunction b() {\n  return 2;\n}\n=======\n>>>>>>> 바꾸기'))[0], FILE);
  assert.equal(plan.ok, true, plan.error);
  assert.ok(!plan.after.includes('function b'));
  assert.ok(plan.after.includes('module.exports'));
});

test('찾기/바꾸기: 답이 잘려 마지막 블록이 끝나지 않았으면 잘린 답변 (앞부분만 적용하지 않음)', () => {
  for (const md of [
    block('<<<<<<< 찾기\n  return 1;\n=======\n  return 10;\n>>>>>>> 바꾸기\n<<<<<<< 찾기\n  return 2;\n=======\n  ret', true), // 바꾸기 표시 없음
    block('<<<<<<< 찾기\n  return 1;\n=======\n  return 10;\n>>>>>>> 바꾸기', false), // 코드 블록이 닫히지 않음
  ]) {
    const [c] = PX.extractChanges(md);
    assert.equal(c.truncated, true);
    assert.equal(PX.planChange(c, FILE).ok, false);
  }
});

test('찾기/바꾸기: 새 파일은 찾을 부분이 빈 블록일 때만 만든다', () => {
  const create = PX.planChange(PX.extractChanges(block('<<<<<<< 찾기\n=======\nconst x = 1;\n>>>>>>> 바꾸기'))[0], null);
  assert.equal(create.ok, true, create.error);
  assert.equal(create.op, 'create');
  assert.equal(create.after, 'const x = 1;\n');
  assert.match(PX.planChange(PX.extractChanges(block('<<<<<<< 찾기\na\n=======\nb\n>>>>>>> 바꾸기'))[0], null).error, /파일이 없습니다/);
});

test('찾기/바꾸기: 코드 블록 안의 평범한 ======= 줄(마크다운 제목 등)은 표시로 보지 않는다', () => {
  const md = '파일: README.md\n````md\n제목\n=======\n본문\n````';
  const [c] = PX.extractChanges(md);
  assert.equal(c.type, 'full'); // <<<<<<< 찾기가 없으면 전체 내용
});

test('답변 규칙 · 다시 요청: 긴 파일은 찾기/바꾸기, 짧은 파일은 전체 내용', () => {
  assert.match(PC.RULES, new RegExp(`${PC.EDIT_LINES}줄보다 긴 기존 파일`));
  assert.match(PC.RULES, /<<<<<<< 찾기/);
  assert.match(PC.RULES, />>>>>>> 바꾸기/);
  const long = Array.from({ length: PC.EDIT_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
  const r1 = PU.packRefetch({ path: 'src/big.js', text: long, reason: 'truncated' });
  assert.match(r1.text, /답변이 길어서 중간에 잘려/);
  assert.match(r1.text, /찾기\/바꾸기/);
  const r2 = PU.packRefetch({ path: 'src/small.js', text: 'a\nb\n' });
  assert.match(r2.text, /수정안이 현재 내용과 맞지 않아/);
  assert.match(r2.text, /"전체" 파일 내용/);
});
