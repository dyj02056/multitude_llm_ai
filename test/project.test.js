'use strict';
// 프로젝트 모드 공통 모듈 단위 테스트:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/shared/project-ignore');
const { scanSecrets } = require('../src/shared/secret-scan');
const C = require('../src/shared/project-context');
const X = require('../src/shared/patch');

/** 메모리 속 가짜 폴더 */
function memFs(files) {
  const dirsOf = (dir) => {
    const prefix = dir ? `${dir}/` : '';
    const out = new Map();
    for (const [p, text] of Object.entries(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split('/')[0];
      out.set(name, rest.includes('/') ? { name, kind: 'dir', size: 0 } : { name, kind: 'file', size: text.length });
    }
    return [...out.values()];
  };
  return {
    readDir: async (dir) => dirsOf(dir),
    readFile: async (p) => (p in files ? { text: files[p] } : Promise.reject(new Error('없음'))),
  };
}

test('3단계 제외 규칙', async () => {
  const fsx = memFs({
    '.gitignore': 'dist/\n*.log\nsrc/gen/\n',
    '.mlaignore': '!src/gen/\n',
    '.dockerignore': 'tests\n*.md\n',
    '.env': 'A=1',
    '.env.example': 'A=',
    'README.md': '# hi',
    'dist/a.js': 'x',
    'src/app.js': 'x',
    'src/gen/t.ts': 'x',
    'src/sub/.gitignore': 'local.txt\n',
    'src/sub/local.txt': 'x',
    'src/sub/keep.txt': 'x',
    'tests/a.test.js': 'x',
    'logs/a.log': 'x',
    'node_modules/x/i.js': 'x',
  });
  const reasonOf = (s, p) => s.entries.find((e) => e.path === p)?.excluded;
  const off = await P.scanProject(fsx);
  assert.equal(reasonOf(off, '.env').layer, 'L1');
  assert.equal(reasonOf(off, '.env.example'), null);
  assert.equal(reasonOf(off, 'node_modules').layer, 'L1');
  assert.deepEqual([reasonOf(off, 'dist').source, reasonOf(off, 'dist').line], ['.gitignore', 1]);
  assert.equal(reasonOf(off, 'logs/a.log').pattern, '*.log');
  assert.equal(reasonOf(off, 'src/gen/t.ts'), null, '.mlaignore의 !로 되살림');
  assert.equal(reasonOf(off, 'src/sub/local.txt').source, 'src/sub/.gitignore', '하위 폴더 .gitignore');
  assert.equal(reasonOf(off, 'src/sub/keep.txt'), null);
  assert.equal(reasonOf(off, 'tests'), null, 'L3는 기본으로 꺼짐');
  assert.equal(off.l3Found[0].source, '.dockerignore');
  assert.ok(off.l3Found[0].count >= 2);
  const on = await P.scanProject(fsx, { l3Enabled: ['.dockerignore'] });
  assert.equal(reasonOf(on, 'tests').layer, 'L3');
  assert.equal(reasonOf(on, 'README.md').layer, 'L3');
  assert.equal(reasonOf(on, 'src/app.js'), null, '.dockerignore는 맨 위 기준 (하위 *.md 아님)');
});

test('.dockerignore 문법 변환', () => {
  assert.deepEqual(P.dockerToGitignore('# c\n*.log\n**/tmp\n!keep.log\n./build'), ['', '/*.log', '**/tmp', '!/keep.log', '/build']);
});

test('비밀 정보 검사', () => {
  assert.equal(scanSecrets('const a = 1;\nconst url = "https://x";').length, 0);
  assert.equal(scanSecrets('key = "AKIAABCDEFGHIJKLMNOP"')[0].name, 'AWS 액세스 키');
  assert.equal(scanSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')[0].name, '개인 키');
  assert.equal(scanSecrets('password: "hunter2hunter2"')[0].line, 1);
  assert.equal(scanSecrets('password = process.env.PASSWORD').length, 0);
});

test('맥락 묶기 · NEED_FILES', () => {
  const r = C.buildContext({ project: { name: 'demo', paths: ['src/a.js', 'README.md'] }, files: [{ path: 'src/a.js', text: 'x\n```\n' }], request: '고쳐 줘' });
  assert.ok(r.text.includes('[프로젝트 구조]') && r.text.includes('src/\n  a.js') && r.text.includes('````js'));
  assert.equal(r.attachment, null);
  const big = C.buildContext({ project: { name: 'd', paths: ['b.txt'] }, files: [{ path: 'b.txt', text: 'x'.repeat(C.INLINE_LIMIT) }], request: 'q' });
  assert.equal(big.attachment.name, 'project-context.md');
  assert.ok(big.text.length < 2000 && big.inlineText.length <= C.INLINE_LIMIT);
  assert.deepEqual(C.parseNeedFiles('설명\n\n**NEED_FILES:** `src/a.js`, ./b/c.ts\n- d.md'), ['src/a.js', 'b/c.ts', 'd.md']);
  assert.deepEqual(C.parseNeedFiles('없음'), []);
});

test('안전한 경로', () => {
  assert.equal(X.safeRelPath('./src/a.js'), 'src/a.js');
  for (const bad of ['../x', '/etc/passwd', 'C:/x', 'a/../../b', '~/x']) assert.equal(X.safeRelPath(bad), null, bad);
});

const SRC = 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n';

test('diff 꺼내기·적용 (줄 번호가 틀려도)', () => {
  const md = [
    '설명입니다.',
    '```diff',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -10,3 +10,4 @@',
    ' function add(a, b) {',
    '-  return a + b;',
    '+  // 더하기',
    '+  return Number(a) + Number(b);',
    ' }',
    '```',
  ].join('\n');
  const [c] = X.extractChanges(md);
  assert.equal(c.path, 'src/math.js');
  const plan = X.planChange(c, SRC);
  assert.ok(plan.ok, plan.error);
  assert.ok(plan.after.includes('return Number(a) + Number(b);'));
  assert.equal(plan.add, 2);
  assert.equal(plan.del, 1);
});

test('CRLF 파일은 CRLF로 남긴다', () => {
  const [c] = X.extractChanges('```diff\n--- a/m.js\n+++ b/m.js\n@@\n-  return a + b;\n+  return a - b;\n```');
  const plan = X.planChange(c, SRC.replace(/\n/g, '\r\n'));
  assert.ok(plan.ok, plan.error);
  assert.ok(plan.after.includes('  return a - b;\r\n'));
});

test('맞지 않는 diff는 실패, 전체 파일·새 파일·삭제', () => {
  const [bad] = X.extractChanges('```diff\n--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-없는 줄\n+새 줄\n```');
  assert.equal(X.planChange(bad, SRC).ok, false);
  const full = X.extractChanges('파일: src/new.js\n```js\nconsole.log(1)\n```');
  assert.deepEqual([full[0].type, X.planChange(full[0], null).op], ['full', 'create']);
  const [created] = X.extractChanges('```diff\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n```');
  assert.equal(X.planChange(created, null).after, 'a\nb\n');
  const [del] = X.extractChanges('```diff\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n```');
  const dp = X.planChange(del, 'x\n');
  assert.deepEqual([dp.op, dp.after, dp.ok], ['delete', null, true]);
  assert.equal(X.extractChanges('```diff\n--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@\n-a\n+b\n```').length, 0, '밖으로 나가는 경로는 버린다');
});

test('훑지 않은 경로도 상위 폴더 제외를 물려받는다 (NEED_FILES 검사용)', () => {
  const m = P.createMatcher();
  m.add(P.makeSource({ source: '.gitignore', layer: 'L2', content: 'dist/\nsrc/gen/\n', rank: 2 }));
  m.add(P.makeSource({ source: '.mlaignore', layer: 'L2', content: '!src/gen/\n', rank: 200 }));
  assert.equal(m.classify('dist/a/b.js', false).source, '.gitignore');
  assert.equal(m.classify('node_modules/x/y.js', false).layer, 'L1');
  assert.equal(m.classify('src/gen/t.ts', false), null);
});
