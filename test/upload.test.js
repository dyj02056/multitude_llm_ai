'use strict';
// 프로젝트 파일 업로드(묶음 파일 / 개별 파일) 공통 모듈 단위 테스트:  npm test
// [쉽게 말하면] 프로젝트 파일을 묶음 파일 / 개별 파일로 포장할 때 이름·크기 한도·예비 글이 맞게 만들어지는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/shared/project-upload');
const C = require('../src/shared/project-context');

const BUDGET = { files: 10, bytes: 50 * 1024 * 1024, fileBytes: 25 * 1024 * 1024 };
const proj = (files) => ({ name: 'demo', paths: files.map((f) => f.path) });

test('개별 파일 이름: 경로를 __로, 받지 않을 수 있는 확장자는 .txt', () => {
  assert.equal(U.uploadName('src/a/index.js'), 'src__a__index.js');
  assert.equal(U.uploadName('Dockerfile'), 'Dockerfile.txt');
  assert.equal(U.uploadName('src/App.vue'), 'src__App.vue.txt');
  assert.equal(U.uploadName('a:b?.md'), 'a_b_.md');
  assert.deepEqual(U.uniqueNames(['a.js', 'A.js', 'b']), ['a.js', 'A (2).js', 'b']);
});

test('올린 이름 → 실제 경로 후보', () => {
  assert.deepEqual(U.restorePaths('src__a__index.js'), ['src/a/index.js']);
  assert.deepEqual(U.restorePaths('Dockerfile.txt'), ['Dockerfile', 'Dockerfile.txt']);
  assert.deepEqual(U.restorePaths('src__App.vue.txt'), ['src/App.vue', 'src/App.vue.txt']);
  assert.deepEqual(U.restorePaths('lib__index (2).js'), ['lib/index.js']);
  assert.deepEqual(U.restorePaths('src/x.js'), ['src/x.js']);
});

test('묶음 파일(기본): 경로 머리글이 있는 .md 하나, 본문은 짧게', () => {
  const files = [{ path: 'src/a.js', text: 'x' }, { path: 'lib/a.js', text: 'y' }];
  const p = U.packContext({ project: proj(files), files, request: '고쳐 줘' });
  assert.equal(p.mode, 'bundle');
  assert.deepEqual(p.attachments.map((a) => a.name), [C.CONTEXT_FILE]);
  assert.match(p.attachments[0].text, /\[프로젝트 구조\][\s\S]*\[파일: src\/a\.js\][\s\S]*\[파일: lib\/a\.js\]/);
  assert.match(p.text, /고쳐 줘/);
  assert.match(p.text, /\[답변 규칙\]/);
  assert.ok(!p.text.includes('[파일: src/a.js]'));
  assert.match(p.inlineText, /\[파일: src\/a\.js\]/); // 예비 경로용 본문
});

test('묶음 파일: 크면 나눈다', () => {
  const files = [{ path: 'a.txt', text: 'a'.repeat(U.BUNDLE_CHUNK - 1000) }, { path: 'b.txt', text: 'b'.repeat(U.BUNDLE_CHUNK - 1000) }];
  const p = U.packContext({ project: proj(files), files, request: 'q' });
  assert.deepEqual(p.attachments.map((a) => a.name), ['project-context-1.md', 'project-context-2.md']);
  assert.match(p.text, /project-context-1\.md, project-context-2\.md/);
  assert.ok(p.inlineText.length <= C.INLINE_LIMIT);
});

test('개별 파일: 파일마다 올리고 본문에 이름 → 경로 목록', () => {
  const files = [{ path: 'src/a/index.js', text: 'x' }, { path: 'lib/index.js', text: 'y' }, { path: 'Dockerfile', text: 'FROM z' }];
  const p = U.packContext({ project: proj(files), files, request: 'q', mode: 'files', budget: BUDGET });
  assert.equal(p.mode, 'files');
  assert.deepEqual(p.attachments.map((a) => a.name), ['src__a__index.js', 'lib__index.js', 'Dockerfile.txt']);
  assert.equal(p.attachments[2].text, 'FROM z');
  assert.match(p.text, /- src__a__index\.js → src\/a\/index\.js/);
  assert.match(p.text, /- Dockerfile\.txt → Dockerfile/);
  assert.match(p.text, /\[프로젝트 구조\]/);
});

test('개별 파일: 한도를 넘으면 그번만 묶음 파일', () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ path: `f${i}.js`, text: 'z' }));
  const p = U.packContext({ project: proj(files), files, request: 'q', mode: 'files', budget: { ...BUDGET, files: 3 } });
  assert.equal(p.mode, 'bundle');
  assert.ok(p.note);
  const f = U.packFollowUp({ files: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.js`, text: 'z' })), mode: 'files', budget: BUDGET });
  assert.equal(f.mode, 'bundle');
  assert.deepEqual(f.attachments.map((a) => a.name), ['requested-files.md']);
});

test('요청 파일 보내기 · 다시 보내기', () => {
  const files = [{ path: 'src/a.js', text: 'x' }];
  const skipped = [{ path: '.env', reason: '제외 규칙' }];
  const b = U.packFollowUp({ files, skipped });
  assert.deepEqual(b.attachments.map((a) => a.name), ['requested-files.md']);
  assert.match(b.text, /\.env: 제외 규칙/);
  assert.match(b.text, /\[답변 규칙\]/);
  const f = U.packFollowUp({ files, skipped, mode: 'files', budget: BUDGET });
  assert.deepEqual(f.attachments.map((a) => a.name), ['src__a.js']);
  assert.match(f.inlineText, /\[파일: src\/a\.js\]/);

  const rb = U.packRefetch({ path: 'src/a.js', text: 'cur' });
  assert.deepEqual(rb.attachments.map((a) => a.name), ['refetch-a.js.md']);
  assert.match(rb.text, /파일: src\/a\.js/);
  const rf = U.packRefetch({ path: 'src/a.js', text: 'cur', mode: 'files' });
  assert.deepEqual(rf.attachments.map((a) => [a.name, a.text]), [['src__a.js', 'cur']]);
});

test('바뀐 파일 다시 보내기: 묶음·개별 파일·지운 파일', () => {
  const files = [{ path: 'src/a.js', text: 'const a = 2;\n' }];
  const b = U.packUpdate({ files, deleted: ['old.js'], mode: 'bundle', budget: BUDGET });
  assert.equal(b.mode, 'bundle');
  assert.equal(b.attachments[0].name, 'updated-files.md');
  assert.match(b.attachments[0].text, /\[파일: src\/a\.js\]/);
  assert.match(b.text, /- old\.js/);
  assert.match(b.inlineText, /const a = 2;/);
  const f = U.packUpdate({ files, mode: 'files', budget: BUDGET });
  assert.deepEqual(f.attachments.map((a) => a.name), ['src__a.js']);
  assert.match(f.text, /src__a\.js → src\/a\.js/);
  const onlyDeleted = U.packUpdate({ files: [], deleted: ['x.js'], mode: 'files', budget: BUDGET });
  assert.deepEqual(onlyDeleted.attachments, []);
  assert.match(onlyDeleted.text, /- x\.js/);
});
