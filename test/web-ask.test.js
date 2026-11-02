'use strict';
// 보고 있는 웹페이지로 질문 (v0.15.0, 크롬 확장) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 메뉴에서 넘어온 요청을 검사하는지 (오래된 요청 · 이상한 주소 · 빈 글은 버림, 너무 길면 자름)
//   - 입력창 글 · page.md 내용이 바르게 만들어지는지
//   - 확장 권한이 contextMenus · activeTab · scripting만 늘었고, 모든 사이트 권한은 없는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const W = require('../src/shared/web-ask');
const { SERVICES } = require('../src/shared/services');

const NOW = new Date(2026, 10, 2, 14, 5).getTime();
const ask = (over = {}) => ({ kind: 'selection', title: '예시 글', url: 'https://example.com/a?b=1', text: '선택한 글입니다.', at: NOW - 1000, ...over });

test('요청 검사: 종류 · 시간 · 주소 · 빈 글', () => {
  const r = W.normalize(ask(), NOW);
  assert.deepEqual(r, { kind: 'selection', title: '예시 글', url: 'https://example.com/a?b=1', text: '선택한 글입니다.', truncated: false });
  assert.equal(W.normalize(ask({ kind: 'other' }), NOW), null);
  assert.equal(W.normalize(ask({ at: NOW - W.FRESH_MS - 1 }), NOW), null); // 오래된 요청은 버린다
  assert.equal(W.normalize(ask({ text: '   ' }), NOW), null);
  assert.equal(W.normalize(ask({ url: 'javascript:alert(1)' }), NOW).url, ''); // http(s)가 아닌 주소는 남기지 않는다
  assert.equal(W.normalize(ask({ title: '' , url: '' }), NOW).title, '웹페이지');
  assert.equal(W.normalize(null, NOW), null);
});

test('요청 검사: 너무 길면 자르고 표시', () => {
  const r = W.normalize(ask({ text: 'x'.repeat(W.MAX_SELECTION + 10) }), NOW);
  assert.equal(r.text.length, W.MAX_SELECTION);
  assert.equal(r.truncated, true);
  const p = W.normalize(ask({ kind: 'page', text: 'y'.repeat(W.MAX_PAGE + 1) }), NOW);
  assert.equal(p.text.length, W.MAX_PAGE);
});

test('선택한 글 → 입력창 글: 출처와 글, 끝에 "질문: "', () => {
  const t = W.selectionPrompt(W.normalize(ask(), NOW));
  assert.ok(t.startsWith('다음은 웹페이지 「예시 글」(https://example.com/a?b=1)에서 고른 글입니다.'));
  assert.ok(t.includes('---\n선택한 글입니다.\n---'));
  assert.ok(t.endsWith('질문: '));
});

test('페이지 본문 → page.md와 안내 글', () => {
  const r = W.normalize(ask({ kind: 'page', text: '본문 첫 줄\n둘째 줄' }), NOW);
  const f = W.pageFile(r, NOW);
  assert.equal(f.name, 'page.md');
  assert.equal(f.type, 'text/markdown');
  assert.equal(f.text, '# 예시 글\n\n출처: https://example.com/a?b=1\n가져온 때: 2026-11-02 14:05\n\n---\n\n본문 첫 줄\n둘째 줄\n');
  assert.ok(!W.pageFile({ ...r, url: '' }, NOW).text.includes('출처:'));
  assert.equal(W.pagePrompt(r), '첨부한 page.md는 웹페이지 「예시 글」(https://example.com/a?b=1)의 본문입니다.\n\n질문: ');
});

test('확장 권한: 메뉴 · 한 번 권한 · 스크립트만 늘고, 모든 사이트 권한은 없다', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  for (const p of ['contextMenus', 'activeTab', 'scripting']) assert.ok(m.permissions.includes(p), p);
  const all = [...m.permissions, ...(m.host_permissions || []), ...(m.optional_host_permissions || [])];
  assert.ok(!all.some((p) => /<all_urls>|^\*:\/\/\*|^https?:\/\/\*\//.test(p)), all.join(', '));
  const serviceHosts = new Set(SERVICES.flatMap((s) => s.hosts));
  for (const h of m.host_permissions) assert.ok(serviceHosts.has(h.replace(/^(https|wss):\/\//, '').replace(/\/\*$/, '')), h);
});
