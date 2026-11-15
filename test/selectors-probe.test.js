'use strict';
// 셀렉터 점검 도구 (npm run selectors:probe, v0.25.0) 단위 테스트:  npm test
// [쉽게 말하면] 인자 읽기, 페이지 결과 정리(입력창 못 찾음 · 로그아웃 · 열지 못함), 요약 글, selectors.json 고칠 틀,
// --fake 가짜 페이지가 셀렉터 모양대로 만들어지는지, 도구가 읽기만 하는지(입력 · 클릭 함수를 쓰지 않음) 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../scripts/selectors-probe-lib');
const { SERVICES } = require('../src/shared/services');
const { pageSelectorReport } = require('../src/shared/page');

const ROOT = path.join(__dirname, '..');
const IDS = SERVICES.map((s) => s.id);
const svc = (id) => SERVICES.find((s) => s.id === id);

test('parseArgs: 서비스 고르기 · 옵션, 없으면 전부', () => {
  const a = L.parseArgs(['scripts/selectors-probe.js', 'gemini', 'claude', 'gemini', 'nope', '--fake', '--out', 'r.json', '--wait', '3', '--show'], IDS);
  assert.deepEqual(a.ids, ['gemini', 'claude']);
  assert.deepEqual(a.unknown, ['nope']);
  assert.equal(a.fake, true);
  assert.equal(a.out, 'r.json');
  assert.equal(a.waitMs, 3000);
  assert.equal(a.show, true);
  assert.deepEqual(L.parseArgs([], IDS).ids, IDS);
  assert.equal(L.parseArgs(['--wait', '-5'], IDS).waitMs, 15000);
  assert.equal(L.parseArgs(['--wait', '999'], IDS).waitMs, 120000);
});

test('probeConfig: 서비스의 입력창 · 보내기 · 중지 · 답변 · 로그아웃 단서', () => {
  const cfg = L.probeConfig(svc('chatgpt'));
  assert.deepEqual(Object.keys(cfg.parts), ['input', 'send', 'stop', 'response']);
  assert.equal(cfg.parts.input[0], '#prompt-textarea');
  assert.match(cfg.loggedOut.url, /auth\\\.openai/);
  assert.deepEqual(L.probeConfig(svc('duckai')).loggedOut, {});
});

const raw = (over = {}) => ({
  host: 'x',
  path: '/',
  parts: {
    input: [{ sel: 'a', count: 1, visible: 1 }],
    send: [{ sel: 'b', count: 0, visible: 0 }],
    stop: [],
    response: [{ sel: 'r', count: 0, visible: 0 }],
    ...over.parts,
  },
  loggedOut: { url: false, selectors: [], text: null, ...over.loggedOut },
});

test('summarize: 입력창이 기준 — 보내기 · 중지 · 답변은 질문 전이라 못 찾아도 실패 아님', () => {
  const ok = L.summarize(svc('gemini'), raw());
  assert.equal(ok.status, 'ok');
  assert.equal(ok.parts.input.found, 'a');
  assert.equal(ok.parts.send.state, 'unknown');
  assert.equal(ok.parts.stop.state, 'none');
  const fail = L.summarize(svc('gemini'), raw({ parts: { input: [{ sel: 'a', count: 2, visible: 0 }] } }));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.parts.input.hidden, 'a');
  const out = L.summarize(svc('gemini'), raw({ loggedOut: { text: 'Sign in' } }));
  assert.equal(out.status, 'logged-out');
  assert.match(out.notes[0], /Sign in/);
  assert.equal(L.summarize(svc('gemini'), null, 'ERR_NAME_NOT_RESOLVED').status, 'error');
  const bad = L.summarize(svc('gemini'), raw({ parts: { send: [{ sel: '[[', count: 0, visible: 0, bad: true }] } }));
  assert.ok(bad.notes.some((n) => /문법/.test(n)));
});

test('보고서 · 요약 · selectors.json 고칠 틀 (원격으로 고칠 수 있는 입력창만, 파일은 쓰지 않음)', () => {
  const results = [
    L.summarize(svc('gemini'), raw()),
    L.summarize(svc('deepseek'), raw({ parts: { input: [{ sel: 'textarea', count: 0, visible: 0 }] } })),
    L.summarize(svc('claude'), null, 'timeout'),
  ];
  const report = L.buildReport(results, { at: '2026-11-15T00:00:00Z', selectorsVersion: 4, fake: true });
  assert.deepEqual(report.counts, { ok: 1, fail: 1, 'logged-out': 0, error: 1 });
  const text = L.formatSummary(report);
  assert.match(text, /가짜 페이지/);
  assert.match(text, /deepseek\s+입력창 못 찾음/);
  assert.match(text, /claude\s+열지 못함 — timeout/);
  const sk = L.patchSkeleton(report, { version: 4, today: '2026-11-15' });
  assert.deepEqual(Object.keys(sk.patch.services), ['deepseek']);
  assert.equal(sk.patch.version, 5);
  assert.equal(sk.patch.updated, '2026-11-15');
  assert.deepEqual(Object.keys(sk.patch.services.deepseek), ['input']);
  assert.ok(sk.notes.some((n) => /services\.js/.test(n))); // 보내기 버튼은 앱 업데이트로
  assert.equal(L.patchSkeleton(L.buildReport([results[0]])), null);
  // 보고서에는 질문 · 답변 같은 페이지 글이 없다 (셀렉터 · 개수 · 로그인 버튼 문구만)
  assert.ok(!JSON.stringify(report).includes('innerText'));
});

test('--fake 가짜 페이지: 셀렉터 모양대로 요소를 만든다', () => {
  assert.deepEqual(L.splitCompound('rich-textarea .ql-editor[contenteditable="true"]'), ['rich-textarea', '.ql-editor[contenteditable="true"]']);
  assert.deepEqual(L.splitCompound('[data-testid="chat input"] > textarea'), ['[data-testid="chat input"]', 'textarea']);
  assert.deepEqual(L.parseCompound('button.send-button:not(.stop)'), { tag: 'button', attrs: { class: 'send-button' } });
  assert.deepEqual(L.parseCompound('textarea[name="query"].search-input'), { tag: 'textarea', attrs: { name: 'query', class: 'search-input' } });
  assert.deepEqual(L.parseCompound('button[aria-label*="Send message" i]'), { tag: 'button', attrs: { 'aria-label': 'Send message' } });
  assert.deepEqual(L.parseCompound('#chat-input'), { tag: 'div', attrs: { id: 'chat-input' } });
  const html = L.elementFromSelector('div.ProseMirror[contenteditable="true"]', '<x>');
  assert.match(html, /^<div contenteditable="true" class="ProseMirror"/);
  assert.ok(html.includes('&lt;x&gt;'));
  const page = L.fakePage(svc('gemini'));
  assert.match(page, /<rich-textarea/);
  assert.match(page, /테스트용 가짜 페이지/);
  assert.ok(!L.fakePage(svc('gemini'), 'broken').includes('ql-editor'));
  assert.match(L.fakePage(svc('gemini'), 'logged-out'), /Sign in/);
  assert.equal(L.fakeKind('deepseek'), 'broken');
  assert.equal(L.fakeKind('gemini'), 'ok');
});

test('도구는 읽기만 한다: 입력 · 클릭 · 보내기 함수를 쓰지 않고, 페이지 함수는 누르거나 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'selectors-probe.js'), 'utf8');
  for (const bad of ['pageFocusInput', 'pageClickSend', 'pageAttachFiles', 'sendInputEvent', 'insertText', 'sendPrompt']) assert.ok(!src.includes(bad), bad);
  assert.match(src, /pageSelectorReport/);
  const fn = pageSelectorReport.toString();
  for (const bad of ['.click(', '.focus(', 'execCommand', 'dispatchEvent', '.value =']) assert.ok(!fn.includes(bad), bad);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['selectors:probe'], 'electron scripts/selectors-probe.js');
  assert.match(fs.readFileSync(path.join(ROOT, 'remote', 'README.md'), 'utf8'), /selectors:probe/);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs', 'setup.md'), 'utf8'), /selectors:probe/);
});
