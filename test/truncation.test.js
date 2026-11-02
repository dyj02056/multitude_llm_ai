'use strict';
// 잘린 답변 막기 (v0.16.1) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 출력 한도로 답이 끊겨 코드 블록이 닫히지 않으면, 그 파일은 "잘림"으로 보고 적용하지 않는지 (예전에는 나머지 코드가 지워졌다)
//   - "... 기존과 같음"처럼 줄인 코드나 원본 끝부분이 사라진 전체 교체는 "수상함"으로 표시하는지
//   - 평범한 수정은 수상하다고 보지 않는지
const test = require('node:test');
const assert = require('node:assert/strict');
const PX = require('../src/shared/patch');

const ORIGINAL = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\nmodule.exports = { v0 };\n';

test('잘린 답변: 닫히지 않은 코드 블록은 truncated, 적용 계산은 실패(파일을 덮어쓰지 않음)', () => {
  const md = '설명\n\n파일: src/a.js\n```js\nconst v0 = 0;\nconst v1 = 1;\n'; // 여기서 답이 끊김
  const [c] = PX.extractChanges(md);
  assert.equal(c.path, 'src/a.js');
  assert.equal(c.truncated, true);
  const plan = PX.planChange(c, ORIGINAL);
  assert.equal(plan.ok, false);
  assert.equal(plan.truncated, true);
  assert.equal(plan.error, PX.TRUNCATED_TEXT);
  assert.equal(plan.after, null);
});

test('잘린 답변: 앞 파일은 온전하고 마지막 파일만 잘렸으면, 마지막 것만 막는다', () => {
  const md = '파일: a.js\n```js\nconsole.log(1);\n```\n\n파일: b.js\n````md\n# 제목\n```js\ncode\n```\n이어지는 글'; // 백틱 4개 블록이 닫히지 않음
  const changes = PX.extractChanges(md);
  assert.equal(changes.find((c) => c.path === 'a.js').truncated, undefined);
  assert.equal(changes.find((c) => c.path === 'b.js').truncated, true);
});

test('잘린 답변: 닫히지 않은 diff 블록도 truncated', () => {
  const md = '```diff\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-const v0 = 0;\n+const v0 = 100;\n const v1 = 1;\n';
  const [c] = PX.extractChanges(md);
  assert.equal(c.truncated, true);
  assert.equal(PX.planChange(c, ORIGINAL).ok, false);
});

test('수상한 전체 교체: 코드를 줄인 표시가 있으면 suspect (적용은 되지만 기본으로 체크하지 않음)', () => {
  for (const marker of ['// ... 기존 코드 ...', '# ... (생략)', '/* rest of the file unchanged */', '<!-- 이하 동일 -->', '// ... existing code ...', '// 기존과 같음']) {
    const after = `const v0 = 100;\n${marker}\nmodule.exports = { v0 };\n`;
    const [c] = PX.extractChanges(`파일: src/a.js\n\`\`\`js\n${after}\`\`\``);
    const plan = PX.planChange(c, ORIGINAL);
    assert.equal(plan.ok, true, marker);
    assert.match(plan.suspect || '', /줄인 표시/, marker);
  }
});

test('수상한 전체 교체: 원본 끝부분이 통째로 사라지면 suspect', () => {
  const after = ORIGINAL.split('\n').slice(0, 20).join('\n').replace('const v3 = 3;', 'const v3 = 33;') + '\n';
  const [c] = PX.extractChanges(`파일: src/a.js\n\`\`\`js\n${after}\`\`\``);
  const plan = PX.planChange(c, ORIGINAL);
  assert.equal(plan.ok, true);
  assert.match(plan.suspect, /끝이 잘린 것 같습니다 \(원본 61줄 → 20줄/);
});

test('평범한 수정은 수상하지 않다: 한 줄 고치기 · 평범한 새 주석 · 일부러 크게 줄이되 끝은 남긴 것', () => {
  const plain = (after) => PX.planChange(PX.extractChanges(`파일: src/a.js\n\`\`\`js\n${after}\`\`\``)[0], ORIGINAL);
  assert.equal(plain(ORIGINAL.replace('const v5 = 5;', 'const v5 = 55;')).suspect, undefined);
  assert.equal(plain(ORIGINAL.replace('const v5 = 5;', '// 나머지 값을 더한다\nconst v5 = 5 + 1;')).suspect, undefined);
  const shortened = ORIGINAL.split('\n').slice(0, 10).join('\n') + '\nmodule.exports = { v0 };\n';
  assert.equal(plain(shortened).suspect, undefined); // 원본의 마지막 줄이 남아 있으면 의도한 정리로 본다
  assert.equal(PX.planChange(PX.extractChanges('파일: new.js\n```js\n// ... 기존 코드 ...\n```')[0], null).suspect, undefined); // 새 파일은 보지 않음
});

test('잘린 코드 (웹 채팅): 코드 상자는 닫혀 있어도 괄호가 닫히지 않으면 suspect — 새 파일 · 수정 모두', () => {
  // 웹 채팅 화면은 잘린 답도 코드 상자를 닫아서 보여 주므로, 앱이 읽은 Markdown에서는 울타리가 닫혀 있다
  const cut = PX.planChange(PX.extractChanges('파일: src/new.js\n```js\nfunction a() {\n  if (x) {\n    return 1;\n```')[0], null);
  assert.equal(cut.ok, true);
  assert.equal(cut.op, 'create');
  assert.match(cut.suspect, /괄호 2개가 닫히지 않음/);
  // 문자열 · 주석 안의 괄호는 세지 않는다
  assert.equal(PX.braceDebt('const s = "{"; // {\n/* ( */ const t = `[`;'), 0);
  // 원래부터 괄호가 안 맞던 파일(템플릿 조각 등)은 더 나빠졌을 때만
  assert.equal(PX.suspectCutCode('a.js', 'x = {', 'x = { y'), null);
  // 코드 파일이 아니면 보지 않는다
  assert.equal(PX.suspectCutCode('notes.md', null, '(괄호 열고'), null);
});
