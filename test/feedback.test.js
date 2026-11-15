'use strict';
// 답변 평가 [+1] / [-1] (v0.23) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 기록에 AI별 평가(1 · -1)를 남기고, 같은 것을 다시 누르면(0) 지우는지
//   - 이상한 AI 이름(__proto__ 등)이나 값은 받지 않는지
//   - 통계에 좋았음 · 별로였음 수와 만족도가 바르게 나오는지, 깨진 기록에서도 멈추지 않는지
//   - 바뀐 기록이 저장되는지 (잠깐 모았다가 저장 → flush로 바로)
//   - 내보내기(export.js)가 평가가 들어간 기록에서도 그대로 동작하는지
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, feedbackOf } = require('../src/shared/history-core');

function make() {
  const saves = [];
  const h = createHistory((records) => saves.push(JSON.parse(JSON.stringify(records))));
  return { h, saves };
}

test('평가: 남기기 · 바꾸기 · 지우기(0)', () => {
  const { h } = make();
  const id = h.add({ question: 'q', targets: ['gpt', 'claude'] });
  assert.equal(h.setFeedback(id, 'gpt', 1), 1);
  assert.deepEqual({ ...h.get(id).feedback }, { gpt: 1 });
  assert.equal(h.setFeedback(id, 'gpt', -1), -1);
  assert.equal(h.setFeedback(id, 'claude', 1), 1);
  assert.deepEqual({ ...h.get(id).feedback }, { gpt: -1, claude: 1 });
  assert.equal(h.setFeedback(id, 'gpt', 0), 0);
  assert.deepEqual({ ...h.get(id).feedback }, { claude: 1 });
  assert.equal(h.setFeedback(id, 'claude', 0), 0);
  assert.equal('feedback' in h.get(id), false); // 다 지우면 칸도 없앤다
  h.flush();
});

test('평가: 잘못된 AI 이름 · 값 · 기록은 받지 않는다', () => {
  const { h } = make();
  const id = h.add({ question: 'q', targets: ['gpt'] });
  for (const bad of ['__proto__', 'constructor', 'prototype', '', 'a b', 'x'.repeat(65), 1, null, undefined, {}, 'claude']) {
    assert.equal(h.setFeedback(id, bad, 1), null, String(bad));
  }
  for (const v of [2, -2, '1', true, null, undefined, NaN, 0.5]) assert.equal(h.setFeedback(id, 'gpt', v), null, String(v));
  assert.equal(h.setFeedback('no-such-id', 'gpt', 1), null);
  assert.equal('feedback' in h.get(id), false);
  assert.equal({}.gpt, undefined); // Object.prototype을 건드리지 않았다
  // 답변만 있고 targets에 없는 AI (이어 보내기)도 평가할 수 있다
  h.setAnswer(id, 'gemini', { name: 'Gemini', state: 'done', text: 'x' });
  assert.equal(h.setFeedback(id, 'gemini', -1), -1);
  h.flush();
});

test('평가: 통계에 좋았음 · 별로였음 · 만족도', () => {
  const { h } = make();
  const a = h.add({ question: '1', targets: ['gpt', 'claude'] });
  const b = h.add({ question: '2', targets: ['gpt', 'claude'] });
  const c = h.add({ question: '3', targets: ['gpt', 'claude'] });
  const d = h.add({ question: '4', targets: ['gpt'] });
  h.setFeedback(a, 'gpt', 1);
  h.setFeedback(b, 'gpt', 1);
  h.setFeedback(c, 'gpt', 1);
  h.setFeedback(d, 'gpt', -1);
  h.setFeedback(a, 'claude', -1);
  const rows = Object.fromEntries(h.stats().rows.map((r) => [r.id, r]));
  assert.deepEqual([rows.gpt.good, rows.gpt.bad, rows.gpt.satisfaction], [3, 1, 0.75]);
  assert.deepEqual([rows.claude.good, rows.claude.bad, rows.claude.satisfaction], [0, 1, 0]);
  h.setFeedback(a, 'claude', 0);
  const claude = h.stats().rows.find((r) => r.id === 'claude');
  assert.deepEqual([claude.good, claude.bad, claude.satisfaction], [0, 0, null]); // 평가가 없으면 null ("—")
  h.flush();
});

test('평가: 평가가 없거나 깨진 기록에서도 list · get · stats가 멈추지 않는다', () => {
  const { h } = make();
  const ok = { id: 'ok', at: 3, question: 'q', targets: ['gpt'], answers: {}, synth: [], feedback: { gpt: 1 } };
  const broken = [
    { id: 'n1', at: 2, question: 'q', targets: ['gpt'], answers: {}, synth: [] }, // 평가 없음 (예전 기록)
    { id: 'n2', at: 2, question: 'q', targets: ['gpt'], answers: {}, synth: [], feedback: 'good' },
    { id: 'n3', at: 2, question: 'q', targets: ['gpt'], answers: {}, synth: [], feedback: [1, -1] },
    { id: 'n4', at: 2, question: 'q', targets: ['gpt'], answers: {}, synth: [], feedback: null },
    { id: 'n5', at: 2, question: 'q', targets: ['gpt'], answers: {}, synth: [], feedback: { gpt: 5, claude: 'x', ['__proto__']: 1 } },
    { id: 'n6', at: 1, question: 'q', targets: 'gpt', answers: {}, synth: [], feedback: { gpt: -1 } }, // targets가 배열이 아님
  ];
  h.load([ok, ...broken]);
  assert.equal(h.list().length, 7);
  assert.equal(h.get('n2').feedback, 'good');
  const gpt = h.stats().rows.find((r) => r.id === 'gpt');
  assert.deepEqual([gpt.good, gpt.bad, gpt.satisfaction], [1, 0, 1]);
  assert.deepEqual({ ...feedbackOf(broken[4]) }, {});
  assert.deepEqual({ ...feedbackOf(null) }, {});
  // 깨진 평가 위에 새로 남기면 올바른 모양으로 바뀐다
  assert.equal(h.setFeedback('n3', 'gpt', -1), -1);
  assert.deepEqual(h.get('n3').feedback, { gpt: -1 });
  assert.equal(h.setFeedback('n5', 'gpt', 1), 1);
  assert.deepEqual(h.get('n5').feedback, { gpt: 1 });
  h.flush();
});

test('평가: 바뀐 기록을 저장한다 (모았다가 저장, flush로 바로)', () => {
  const { h, saves } = make();
  const id = h.add({ question: 'q', targets: ['gpt'] });
  h.flush();
  assert.equal(saves.length, 1);
  h.setFeedback(id, 'gpt', 1);
  assert.equal(saves.length, 1); // 아직 모으는 중
  h.flush();
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[1][0].feedback, { gpt: 1 });
  h.setFeedback(id, 'gpt', 99); // 잘못된 값은 저장을 예약하지 않는다
  h.flush();
  assert.equal(saves.length, 2);
  h.setFeedback(id, 'gpt', 0);
  h.flush();
  assert.equal('feedback' in saves[2][0], false);
});

test('평가: 평가가 들어간 기록도 내보내기가 동작한다', () => {
  const E = require('../src/shared/export');
  const { h } = make();
  const id = h.add({ question: '질문', targets: ['gpt'] });
  h.setAnswer(id, 'gpt', { name: 'GPT', state: 'done', text: '답', md: '답' });
  h.setFeedback(id, 'gpt', 1);
  const doc = E.docFromRecord(h.get(id));
  const md = E.toMarkdown(doc);
  const html = E.toHtml(doc);
  assert.match(md, /질문/);
  assert.match(md, /답/);
  assert.match(html, /<html|<!doctype/i);
  assert.ok(E.fileName(doc, 'md').endsWith('.md'));
  h.flush();
});

test('평가: Windows 앱(IPC)과 크롬 확장(host.js)에 같은 이름으로 이어져 있다', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('src/main/ipc/history.js'), /ipcMain\.handle\('history:feedback'/); // v0.24.0: main.js에서 옮김
  assert.match(read('src/main/main.js'), /require\('\.\/ipc\/history'\)\.register\(/);
  assert.match(read('src/main/main.js'), /history: roundHistory/);
  assert.match(read('src/preload/preload.js'), /feedback: \(svcId, value\) => ipcRenderer\.invoke\('history:feedback'/);
  const host = read('extension/host.js');
  assert.match(host, /feedback: async \(svcId, value\) =>/);
  assert.match(host, /history: roundHistory/);
  assert.match(read('src/renderer/renderer.js'), /host\.history\.feedback\?\.\(id, next\)/);
});
