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

test('패널 주소 확인: 질문은 서비스 페이지(https)에만, 자동 로그인은 그 서비스 로그인 화면까지만', () => {
  const S = require('../src/shared/services');
  const gpt = SERVICES.find((s) => s.id === 'chatgpt');
  const duck = SERVICES.find((s) => s.id === 'duckai');
  assert.equal(S.isServiceUrl(gpt, 'https://chatgpt.com/c/abc'), true);
  assert.equal(S.isServiceUrl(duck, 'https://duckduckgo.com/?q=x&ia=chat'), true, '서비스 hosts 안의 다른 도메인');
  for (const bad of ['http://chatgpt.com/', 'https://chatgpt.com.evil.com/', 'https://evil.com/chatgpt.com', 'https://auth.openai.com/log-in', 'about:blank', 'not a url']) {
    assert.equal(S.isServiceUrl(gpt, bad), false, bad);
  }
  assert.equal(S.isLoginUrl(gpt, 'https://auth.openai.com/log-in'), true);
  assert.equal(S.isLoginUrl(gpt, 'https://evil.com/login'), false);
  assert.equal(S.isLoginUrl(gpt, 'https://accounts.x.ai/'), false, '다른 서비스의 로그인 화면');
});

test('원격 셀렉터로 hosts·authHosts는 바뀌지 않는다', () => {
  const services = JSON.parse(JSON.stringify(SERVICES));
  const clean = R.sanitize({ version: 1, services: { chatgpt: { hosts: ['evil.com'], authHosts: ['evil.com'] } } }, services);
  R.apply(services, R.snapshotBase(services), clean.overrides);
  const gpt = services.find((s) => s.id === 'chatgpt');
  assert.deepEqual([gpt.hosts, gpt.authHosts], [['chatgpt.com'], ['auth.openai.com']]);
});

/** 크롬 확장 background.js를 가짜 chrome API 위에서 읽는다 */
function loadBackground(cookies) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const ext = path.join(__dirname, '..', 'extension');
  const ev = () => ({ addListener() {} });
  const calls = [];
  const matches = (c, url, name) => c.name === name && new URL(url).hostname.endsWith(c.domain.replace(/^\./, '')) && new URL(url).pathname.startsWith(c.path);
  const chrome = {
    action: { onClicked: ev() },
    runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, onMessage: ev(), onConnect: ev(), getContexts: async () => [] },
    tabs: { onRemoved: ev() },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
    cookies: {
      onChanged: ev(),
      getAll: async ({ url, name }) => cookies.filter((c) => matches(c, url, name)),
      set: async (d) => calls.push(['set', d.name, d.domain || 'host-only']),
      remove: async (d) => calls.push(['remove', d.name]),
    },
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout, Date });
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx));
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), ctx);
  return { applyCookieWrite: ctx.applyCookieWrite, calls };
}

test('확장: 페이지 스크립트의 쿠키 쓰기로 HttpOnly 쿠키를 덮어쓰거나 지우지 않는다', async () => {
  const page = new URL('https://chat.qwen.ai/c/1');
  const { applyCookieWrite, calls } = loadBackground([
    { name: 'session', domain: '.qwen.ai', path: '/', httpOnly: true },
    { name: 'pref', domain: 'chat.qwen.ai', path: '/', httpOnly: false },
  ]);
  await applyCookieWrite(page, 'session=evil; Domain=qwen.ai; Path=/');
  await applyCookieWrite(page, 'session=; Path=/; Max-Age=0');
  assert.deepEqual(calls, [], 'HttpOnly 쿠키는 그대로');
  await applyCookieWrite(page, 'pref=dark; Path=/');
  await applyCookieWrite(page, 'other=1; Domain=qwen.ai; Path=/');
  assert.deepEqual(calls, [['set', 'pref', 'host-only'], ['set', 'other', '.qwen.ai']]);
});
