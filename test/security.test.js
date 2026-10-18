'use strict';
// 보안 보강(v0.4.1) 단위 테스트:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../src/shared/patch');
const R = require('../src/shared/remote-core');
const { SERVICES } = require('../src/shared/services');

test('Windows에서 위험한 경로는 거절', () => {
  for (const bad of ['a.txt:stream', 'src/CON', 'nul.txt', 'src/COM1.js', 'lpt9.c', 'dir./a.js']) assert.equal(X.safeRelPath(bad), null, bad);
  for (const ok of ['src/console.js', 'con2/a.js', 'docs/null-object.md']) assert.equal(X.safeRelPath(ok), ok, ok);
});

test('실행 영향 판정: package.json은 실행 항목이 바뀔 때만', () => {
  const pkg = (o) => JSON.stringify({ name: 'a', scripts: { test: 'jest' }, dependencies: { x: '1' }, ...o });
  assert.equal(X.executionRisk('package.json', pkg({}), pkg({ dependencies: { x: '2' } })), null);
  assert.match(X.executionRisk('package.json', pkg({}), pkg({ scripts: { test: 'jest', postinstall: 'curl evil' } })), /scripts/);
  assert.match(X.executionRisk('app/package.json', pkg({}), '{ 깨진 JSON'), /확인하지 못함/);
  for (const p of ['.github/workflows/ci.yml', '.vscode/tasks.json', 'Makefile', 'Dockerfile.dev', 'tools/run.ps1', '.husky/pre-commit', '.envrc']) {
    assert.ok(X.executionRisk(p, '', 'x'), p);
  }
  for (const p of ['src/app.js', 'README.md', 'docs/makefile-guide.md']) assert.equal(X.executionRisk(p, '', 'x'), null, p);
});

test('원격 설정: 버튼 셀렉터·다른 도메인·위험한 정규식은 무시', () => {
  const r = R.sanitize(
    {
      version: 9,
      services: {
        chatgpt: { send: ['#share'], loginButton: '#x', sendText: 'go', submitKey: 'Enter', input: ['#in'], newChatUrl: 'https://evil.example/', response: ['.r'] },
        gemini: { newChatUrl: 'https://gemini.google.com/app', loggedOut: { text: '(a+)+$', url: '^https://accounts\\.google\\.com/' }, upload: { methods: ['drop'], fileInput: ['#f'], busy: ['.b'] } },
      },
    },
    SERVICES,
  );
  assert.deepEqual(r.overrides.chatgpt, { replace: false, input: ['#in'], response: ['.r'] });
  assert.equal(r.overrides.gemini.newChatUrl, 'https://gemini.google.com/app');
  assert.deepEqual(r.overrides.gemini.loggedOut, { url: '^https://accounts\\.google\\.com/' });
  assert.deepEqual(r.overrides.gemini.upload, { busy: ['.b'] });
  assert.deepEqual(r.ignored.sort(), ['chatgpt.loginButton', 'chatgpt.newChatUrl', 'chatgpt.send', 'chatgpt.sendText', 'chatgpt.submitKey', 'gemini.loggedOut.text', 'gemini.upload.fileInput', 'gemini.upload.methods'].sort());
  for (const re of ['(a+)+', '(a|ab)*', '(.*)*', '(\\w+)\\1']) assert.ok(R.riskyRegex(re), re);
  for (const re of ['^(로그인|sign in)$', 'x{2,3}', '/sign_in']) assert.equal(R.riskyRegex(re), false, re);
});

test('원격 적용 후에도 버튼 셀렉터는 앱 값 그대로', () => {
  const svcs = JSON.parse(JSON.stringify(SERVICES));
  const base = R.snapshotBase(svcs);
  const before = JSON.stringify(svcs.find((s) => s.id === 'chatgpt').send);
  R.apply(svcs, base, R.sanitize({ version: 1, services: { chatgpt: { send: ['#evil'], stop: ['.new-stop'] } } }, svcs).overrides);
  const gpt = svcs.find((s) => s.id === 'chatgpt');
  assert.equal(JSON.stringify(gpt.send), before);
  assert.equal(gpt.stop[0], '.new-stop');
});
