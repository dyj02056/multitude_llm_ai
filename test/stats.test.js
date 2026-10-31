'use strict';
// 응답 통계 · 사용 한도 감지 (v0.13.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 기록의 숫자(metrics)로 AI별 통계를 바르게 세는지 (중앙값 · 실패 · 시간 초과 · 한도)
//   - 질문을 보낼 때 첫 응답 · 완료 시간 · 글자 수를 기록에 남기는지, 글 자체(한도 문구)는 남기지 않는지
//   - 한도 문구는 답변이 끝나지 않았거나 아주 짧을 때만 찾는지 (한도에 관한 정상 답변을 한도로 보지 않게)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistory } = require('../src/shared/history-core');
const { createRounds } = require('../src/shared/rounds');
const { createDiag } = require('../src/shared/diag');
const S = require('../src/shared/services');
const { pageLimitCheck } = require('../src/shared/page');
const R = require('../src/shared/remote-core');

test('통계: 서비스별 질문 · 완료 · 실패 · 한도 수와 시간 중앙값, 평균 글자 수', () => {
  const h = createHistory(() => {});
  const add = (answers) => {
    const id = h.add({ question: 'q', targets: Object.keys(answers) });
    for (const [svc, a] of Object.entries(answers)) if (a) h.setAnswer(id, svc, { name: svc.toUpperCase(), text: 'x', ...a });
  };
  add({ a: { state: 'done', metrics: { sendOk: true, firstMs: 1000, doneMs: 5000, chars: 100, limit: false } }, b: { state: 'error', metrics: { sendOk: false, limit: true } } });
  add({ a: { state: 'done', metrics: { sendOk: true, firstMs: 3000, doneMs: 9000, chars: 300, limit: false } }, b: { state: 'timeout', metrics: { sendOk: true, firstMs: 2000 } } });
  add({ a: { state: 'no-answer', metrics: { sendOk: true, limit: true } }, b: null }); // b는 결과 없음 (앱이 닫힘)
  add({ a: { state: 'done' } }); // v0.13.0 이전 기록: metrics 없음
  const st = h.stats();
  assert.equal(st.records, 4);
  const a = st.rows.find((r) => r.id === 'a');
  assert.deepEqual(
    { asked: a.asked, sent: a.sent, done: a.done, noAnswer: a.noAnswer, limit: a.limit, first: a.firstMedianMs, done2: a.doneMedianMs, chars: a.charsAvg },
    { asked: 4, sent: 4, done: 3, noAnswer: 1, limit: 1, first: 2000, done2: 7000, chars: 200 },
  );
  const b = st.rows.find((r) => r.id === 'b');
  assert.deepEqual({ asked: b.asked, sendFail: b.sendFail, timeout: b.timeout, limit: b.limit, done: b.doneMedianMs }, { asked: 3, sendFail: 1, timeout: 1, limit: 1, done: null });
  assert.equal(st.rows[0].id, 'a'); // 질문을 많이 받은 순
  h.clear();
  assert.deepEqual(h.stats().rows, []); // 기록을 지우면 통계도 없다
});

function makeRounds({ checkLimit, history, diag, onWatch }) {
  return createRounds({
    services: [{ id: 'a', name: 'A' }],
    hasPanel: () => true,
    sendPrompt: async () => ({ ok: true, via: 'button' }),
    snapshot: async () => ({ stop: false, count: 0, text: '짧은 답', md: '짧은 답' }),
    watch: (_id, _b, _c, onState) => onWatch(onState),
    sendPanel: () => {},
    sendSynthStatus: () => {},
    history,
    prefs: () => ({ autoSynth: false }),
    diag,
    checkLimit,
    log: () => {},
  });
}

test('보내기: 첫 응답 · 완료 시간 · 글자 수를 기록에 숫자로 남기고, 짧은 답에서 한도 문구를 찾으면 한도로 표시', async () => {
  const saved = [];
  const history = { add: () => 'h', setAnswer: (_h, id, a) => saved.push(a), addSynth: () => {} };
  const diag = createDiag();
  const calls = [];
  let onState;
  const rounds = makeRounds({
    history,
    diag,
    checkLimit: async (id, cfg) => (calls.push(cfg.scope), cfg.scope === 'answer' ? "You've reached your usage limit" : null),
    onWatch: (fn) => (onState = fn),
  });
  await rounds.sendAll('q', ['a']);
  await new Promise((r) => setTimeout(r, 30));
  await onState('answering');
  await new Promise((r) => setTimeout(r, 20));
  await onState('done', { chars: 31 });
  await new Promise((r) => setTimeout(r, 20));
  const m = saved[saved.length - 1].metrics;
  assert.equal(m.sendOk, true);
  assert.ok(m.firstMs >= 20 && m.doneMs >= m.firstMs, JSON.stringify(m));
  assert.equal(m.chars, 31);
  assert.equal(m.limit, true);
  assert.equal(typeof m.limit, 'boolean'); // 한도 문구 글은 기록에 남기지 않는다
  assert.deepEqual(calls, ['answer']);
  assert.match(diag.status('a').limit, /usage limit/);
});

test('보내기: 긴 정상 답변은 한도 문구를 찾지 않고(한도에 관한 질문이어도), 정상으로 끝나면 지난 한도 표시를 지운다', async () => {
  const diag = createDiag();
  diag.setLimit('a', 'rate limit');
  const calls = [];
  let onState;
  const rounds = makeRounds({
    history: { add: () => 'h', setAnswer: () => {}, addSynth: () => {} },
    diag,
    checkLimit: async (_id, cfg) => (calls.push(cfg.scope), 'rate limit'),
    onWatch: (fn) => (onState = fn),
  });
  await rounds.sendAll('API rate limit 처리 방법?', ['a']);
  await onState('answering');
  await onState('done', { chars: 2500 });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, []);
  assert.equal(diag.status('a').limit, null);
});

test('보내기: 답변 없이 끝나면 화면 끝부분에서 한도 문구를 찾는다', async () => {
  const diag = createDiag();
  const calls = [];
  let onState;
  const saved = [];
  const rounds = makeRounds({
    history: { add: () => 'h', setAnswer: (_h, _id, a) => saved.push(a), addSynth: () => {} },
    diag,
    checkLimit: async (_id, cfg) => (calls.push(cfg.scope), '사용량 한도에 도달했습니다'),
    onWatch: (fn) => (onState = fn),
  });
  await rounds.sendAll('q', ['a']);
  await onState('no-answer');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['page']);
  assert.equal(saved[saved.length - 1].metrics.limit, true);
  assert.equal(diag.status('a').level === 'broken', false); // 한도는 셀렉터 문제와 따로
});

test('한도 문구: 기본 정규식이 흔한 안내를 찾고, 평범한 문장은 찾지 않는다', () => {
  const find = (answer, svc) => pageLimitCheck({ limitText: S.limitTextOf(svc), scope: 'answer', answer });
  for (const t of [
    "You've reached your usage limit. Please try again later.",
    'You are out of free messages until 5 PM',
    'Too many requests in 1 hour. Try again later.',
    '오늘 사용 가능한 한도에 도달했습니다.',
    '무료 메시지를 모두 사용했습니다',
    '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  ]) {
    assert.ok(find(t), t);
  }
  for (const t of ['Python을 추천합니다.', '반복문의 범위를 제한하려면 range를 쓰세요.', '']) assert.equal(find(t), null, t);
  assert.ok(find('Custom quota hit', { limitText: 'quota hit' })); // 서비스별 문구 더하기
  assert.equal(pageLimitCheck({ limitText: '(', scope: 'answer', answer: 'x' }), null); // 틀린 정규식은 무시
});

test('원격 셀렉터: limitText는 안전한 정규식만 받고, 끄면 앱에 들어 있던 값으로 돌아간다', () => {
  const svcs = [{ id: 'chatgpt', hosts: ['chatgpt.com'], input: [], stop: [], response: [] }];
  const base = R.snapshotBase(svcs);
  const ok = R.sanitize({ version: 2, services: { chatgpt: { limitText: 'you have hit the cap' } } }, svcs);
  assert.equal(ok.overrides.chatgpt.limitText, 'you have hit the cap');
  R.apply(svcs, base, ok.overrides);
  assert.equal(svcs[0].limitText, 'you have hit the cap');
  R.apply(svcs, base, {});
  assert.equal(svcs[0].limitText, undefined);
  const bad = R.sanitize({ version: 2, services: { chatgpt: { limitText: '(a+)+$' } } }, svcs);
  assert.equal(bad.overrides.chatgpt.limitText, undefined);
  assert.ok(bad.ignored.includes('chatgpt.limitText'));
});
