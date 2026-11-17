'use strict';
// 작업 흐름 · 사실 확인 (v0.33.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 걸음 설정 규칙 · 보낼 횟수 · 걸음마다의 요청 글, 진행(걸음마다 멈춤 · 건너뛰기 · 멈추기 · 실패)과 기록
//   - 주장 뽑기 · 확인 표 읽기 · 판정 · 진행, 그리고 화면 그리기 · 연결
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WF = require('../src/shared/workflow');
const FC = require('../src/shared/factcheck');
const HC = require('../src/shared/history-core');
const EX = require('../src/shared/export');
const PL = require('../src/shared/prompt-lib');
const NT = require('../src/shared/notify');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const OPEN = ['a', 'b', 'c'];
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const english = (fn) => {
  i18n.setLang('en');
  try {
    return fn();
  } finally {
    i18n.setLang('ko');
  }
};

// ---------- 작업 흐름: 설정 ----------
test('작업 흐름 설정: 2~6걸음, 첫 걸음은 초안, 열린 AI만, 앞에 결과물 · 지적이 있어야 한다', () => {
  const ok = WF.normalizeWorkflow({ steps: [{ kind: 'draft', who: 'a' }, { kind: 'critique', who: 'b' }, { kind: 'revise', who: 'a' }, { kind: 'verify', who: 'c' }], stepByStep: true }, OPEN);
  assert.deepEqual(ok, { ok: true, steps: [{ kind: 'draft', who: 'a' }, { kind: 'critique', who: 'b' }, { kind: 'revise', who: 'a' }, { kind: 'verify', who: 'c' }], stepByStep: true });
  const bad = (steps, re) => {
    const r = WF.normalizeWorkflow({ steps }, OPEN);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  };
  bad([{ kind: 'draft', who: 'a' }], /2개 이상/);
  bad([], /2개 이상/);
  bad(Array.from({ length: 7 }, (_, i) => ({ kind: i ? 'continue' : 'draft', who: 'a' })), /6개까지/);
  bad([{ kind: 'critique', who: 'a' }, { kind: 'draft', who: 'b' }], /첫 걸음은 초안/);
  bad([{ kind: 'draft', who: 'a' }, { kind: 'critique', who: 'zzz' }], /2걸음을 맡은 AI의 패널이 닫혀/);
  bad([{ kind: 'draft', who: 'a' }, { kind: 'draft', who: 'b' }], /초안은 첫 걸음에만/);
  bad([{ kind: 'draft', who: 'a' }, { kind: 'revise', who: 'b' }], /고쳐 쓰려면 앞에 비판/);
  // 모르는 걸음 종류 · 잘못된 값은 걸음으로 세지 않는다
  assert.equal(WF.normalizeWorkflow({ steps: [{ kind: 'draft', who: 'a' }, { kind: 'hack', who: 'b' }, 7, null] }, OPEN).ok, false);
  assert.equal(WF.normalizeWorkflow(null, OPEN).ok, false);
  // 고쳐 쓰기 뒤에 이어서 · 두 번 비판도 된다
  assert.equal(WF.normalizeWorkflow({ steps: [{ kind: 'draft', who: 'a' }, { kind: 'counter', who: 'b' }, { kind: 'revise', who: 'a' }, { kind: 'critique', who: 'b' }, { kind: 'revise', who: 'a' }, { kind: 'continue', who: 'c' }] }, OPEN).ok, true);
  // 영어 화면의 오류 글
  english(() => assert.match(WF.normalizeWorkflow({ steps: [{ kind: 'critique', who: 'a' }, { kind: 'draft', who: 'b' }] }, OPEN).error, /first step must be a draft/));
});

test('작업 흐름: 예시 걸음 · 보낼 횟수(초안은 이미 받은 답이 있으면 보내지 않음) · 화면 설정 정리', () => {
  assert.deepEqual(WF.exampleSteps(['a', 'b']), [{ kind: 'draft', who: 'a' }, { kind: 'critique', who: 'b' }, { kind: 'revise', who: 'a' }, { kind: 'verify', who: 'a' }]); // 패널이 둘이면 돌려 쓴다
  assert.deepEqual(WF.exampleSteps(['a']).map((s) => s.who), ['a', 'a', 'a', 'a']);
  assert.deepEqual(WF.exampleSteps([]), []);
  const steps = WF.exampleSteps(OPEN);
  assert.deepEqual(WF.countSends(steps), { total: 4, byWho: { a: 2, b: 1, c: 1 } });
  assert.deepEqual(WF.countSends(steps, (id) => id === 'a'), { total: 3, byWho: { a: 1, b: 1, c: 1 } }); // A가 이미 답했으면 초안은 보내지 않는다
  assert.deepEqual(WF.countSends([]), { total: 0, byWho: {} });
  const cleaned = WF.cleanWorkflowCfg({ steps: [{ kind: 'draft', who: 'a', x: 1 }, { kind: 'bad', who: 'b' }, { kind: 'critique', who: 'bad id!' }, { kind: 'critique', who: 'b' }], stepByStep: 'yes', extra: 1 }, (id) => /^\w+$/.test(id));
  assert.deepEqual(cleaned, { steps: [{ kind: 'draft', who: 'a' }, { kind: 'critique', who: 'b' }], stepByStep: false });
  assert.deepEqual(WF.cleanWorkflowCfg('nope'), { steps: [], stepByStep: false });
  assert.equal(WF.cleanWorkflowCfg({ steps: Array.from({ length: 20 }, () => ({ kind: 'continue', who: 'a' })) }).steps.length, WF.MAX_STEPS + 1); // 너무 많음을 알아볼 수 있게 7개까지
});

test('작업 흐름 요청 글: 비판 · 반박 · 이어서는 넘기기와 같은 글, 고쳐 쓰기 · 검증은 새 글 (한국어 · 영어)', () => {
  const product = { name: 'Gemini', text: '초안 글' };
  const feedback = { name: 'ChatGPT', text: '근거가 약함' };
  const q = '질문입니다';
  assert.match(WF.buildStepPrompt({ kind: 'critique', question: q, product }), /다른 AI\(Gemini\)가 쓴 답변을 보여 드립니다\.[\s\S]*\[원래 질문\]\n질문입니다[\s\S]*꼼꼼히 검토해 주세요/);
  assert.match(WF.buildStepPrompt({ kind: 'counter', question: q, product }), /반박해 주세요/);
  assert.match(WF.buildStepPrompt({ kind: 'continue', question: q, product }), /이어받아 더 발전시켜/);
  const revise = WF.buildStepPrompt({ kind: 'revise', question: q, product, feedback });
  assert.match(revise, /Gemini의 답변과, 그 답변에 대한 ChatGPT의 지적/);
  assert.match(revise, /\[Gemini의 답변\]\n초안 글/);
  assert.match(revise, /\[ChatGPT의 지적\]\n근거가 약함/);
  assert.match(revise, /처음부터 끝까지 완성된 글로 다시 써/);
  const verify = WF.buildStepPrompt({ kind: 'verify', question: q, product });
  assert.match(verify, /\[Gemini의 답변\]\n초안 글/);
  assert.match(verify, /## 검증 결과[\s\S]*## 남은 문제[\s\S]*## 판정/);
  assert.equal(WF.buildStepPrompt({ kind: 'draft', question: q }), null);
  assert.match(WF.buildStepPrompt({ kind: 'revise', question: '', product, feedback }), /\(질문 없음\)/);
  assert.match(WF.buildStepPrompt({ kind: 'verify', question: q, product: { name: 'A', text: 'x'.repeat(20000) } }), /…\(이하 생략\)/);
  const en = english(() => [WF.buildStepPrompt({ kind: 'revise', question: q, product, feedback }), WF.buildStepPrompt({ kind: 'verify', question: q, product }), WF.buildStepPrompt({ kind: 'critique', question: q, product })]);
  for (const p of en) assert.ok(!/[가-힣]/.test(p.replace(q, '').replace('초안 글', '').replace('근거가 약함', '')), p.slice(0, 120));
  assert.match(en[0], /Rewrite the answer as a complete text/);
  assert.match(en[1], /## Verification[\s\S]*## Remaining problems[\s\S]*## Verdict/);
});

// ---------- 작업 흐름: 진행 ----------
function wfFixture({ answers = {}, fail = () => false } = {}) {
  const sent = [];
  const status = [];
  const chain = [];
  const events = [];
  const cancelled = [];
  const names = { a: 'A', b: 'B', c: 'C' };
  let n = 0;
  const engine = WF.createWorkflow({
    sendAndWait: async (id, text) => {
      n++;
      sent.push({ id, text });
      return fail(id, n) ? { state: 'timeout', text: '', md: '' } : { state: 'done', text: `${id}:${n}`, md: `${id}:${n}` };
    },
    readAnswer: async (id) => (answers[id] ? { text: answers[id], md: answers[id] } : { text: '', md: '' }),
    nameOf: (id) => names[id] || id,
    openIds: () => OPEN,
    getRound: () => ({ question: 'Q?', historyId: 'h1' }),
    history: { addChain: (_h, e) => chain.push(e) },
    status: (p) => status.push(p),
    notify: (e) => events.push(e),
    cancel: (id) => cancelled.push(id),
  });
  return { engine, sent, status, chain, events, cancelled };
}
const FOUR = { steps: [{ kind: 'draft', who: 'a' }, { kind: 'critique', who: 'b' }, { kind: 'revise', who: 'a' }, { kind: 'verify', who: 'c' }] };

test('작업 흐름 진행: 초안 → 비판 → 고쳐 쓰기 → 검증, 앞 걸음의 결과가 다음 요청에 들어가고 걸음마다 기록', async () => {
  const f = wfFixture(); // A는 아직 답이 없다 → 질문을 보낸다
  assert.deepEqual(await f.engine.start(FOUR), { ok: true, steps: 4 });
  assert.equal((await f.engine.start(FOUR)).ok, false); // 이미 진행 중
  await f.engine.whenDone();
  assert.deepEqual(f.sent.map((s) => s.id), ['a', 'b', 'a', 'c']);
  assert.equal(f.sent[0].text, 'Q?'); // 초안: 질문 그대로
  assert.match(f.sent[1].text, /다른 AI\(A\)가 쓴 답변[\s\S]*a:1[\s\S]*꼼꼼히 검토/); // 비판: A의 초안
  assert.match(f.sent[2].text, /\[A의 답변\]\na:1[\s\S]*\[B의 지적\]\nb:2/); // 고쳐 쓰기: 초안 + 비판
  assert.match(f.sent[3].text, /\[A의 답변\]\na:3[\s\S]*## 판정/); // 검증: 고쳐 쓴 결과
  assert.deepEqual(f.chain.map((c) => [c.step, c.steps, c.stepKind, c.to, c.md]), [[1, 4, 'draft', 'a', 'a:1'], [2, 4, 'critique', 'b', 'b:2'], [3, 4, 'revise', 'a', 'a:3'], [4, 4, 'verify', 'c', 'c:4']]);
  assert.ok(f.chain.every((c) => c.kind === 'workflow' && c.state === 'done' && !c.reused));
  assert.deepEqual(f.status.map((s) => s.state), ['running', 'running', 'running', 'running', 'done']);
  assert.deepEqual(f.status.at(-1), { state: 'done', steps: 4, who: 'C' });
  assert.deepEqual(f.events, [{ kind: 'synth', ok: true, judge: 'C', mode: 'workflow' }]);
  // 한 번 끝났으니 다시 시작할 수 있다
  assert.equal((await f.engine.start({ steps: FOUR.steps.slice(0, 2) })).ok, true);
  await f.engine.whenDone();
});

test('작업 흐름 진행: 초안은 이미 받은 답을 쓰고 다시 보내지 않는다', async () => {
  const f = wfFixture({ answers: { a: '이미 있는 초안' } });
  await f.engine.start(FOUR);
  await f.engine.whenDone();
  assert.deepEqual(f.sent.map((s) => s.id), ['b', 'a', 'c']); // A에게 질문을 다시 보내지 않았다
  assert.match(f.sent[0].text, /이미 있는 초안/);
  assert.equal(f.chain[0].reused, true);
  assert.equal(f.chain[0].md, '이미 있는 초안');
});

test('작업 흐름 진행: 걸음마다 멈춤 — 이어 가기 · 다음 걸음 건너뛰기 · 두 번 눌러도 한 번', async () => {
  const f = wfFixture();
  await f.engine.start({ ...FOUR, stepByStep: true });
  await until(() => f.status.some((s) => s.state === 'paused'));
  assert.deepEqual(f.status.at(-1), { state: 'paused', step: 1, steps: 4, who: 'A', kind: 'draft', next: { kind: 'critique', who: 'B' } });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.engine.resume({ skip: false }), { ok: true });
  assert.equal(f.engine.resume({}).ok, false); // 두 번째는 받지 않는다
  await until(() => f.status.filter((s) => s.state === 'paused').length === 2);
  assert.equal(f.sent.length, 2);
  f.engine.resume({ skip: true }); // 3걸음(고쳐 쓰기)을 건너뛴다
  await until(() => f.status.filter((s) => s.state === 'paused').length === 3);
  const skipped = f.status.find((s) => s.state === 'running' && s.skipped);
  assert.deepEqual({ step: skipped.step, kind: skipped.kind }, { step: 3, kind: 'revise' });
  // 건너뛴 걸음 뒤에도 걸음마다 멈춤은 똑같이 멈춘다
  assert.deepEqual(f.status.at(-1), { state: 'paused', step: 3, steps: 4, who: 'A', kind: 'revise', skipped: true, next: { kind: 'verify', who: 'C' } });
  assert.equal(f.sent.length, 2);
  f.engine.resume({}); // 검증으로
  await f.engine.whenDone();
  assert.deepEqual(f.sent.map((s) => s.id), ['a', 'b', 'c']); // A의 고쳐 쓰기는 보내지 않았다
  assert.deepEqual(f.chain.map((c) => c.step), [1, 2, 4]);
  // 건너뛴 고쳐 쓰기 대신 검증은 초안(결과물)을 받는다
  assert.match(f.sent[2].text, /\[A의 답변\]\na:1/);
});

test('작업 흐름 진행: 멈추기 · 멈춰 있을 때 멈추기 · 실패하면 받은 걸음까지만 남기고 알림', async () => {
  const f = wfFixture();
  await f.engine.start(FOUR);
  assert.equal(f.engine.stop().ok, true);
  await f.engine.whenDone();
  assert.equal(f.status.at(-1).state, 'stopped');
  assert.equal(f.engine.stop().ok, false);
  assert.ok(f.cancelled.length >= 1);

  const g = wfFixture();
  await g.engine.start({ ...FOUR, stepByStep: true });
  await until(() => g.status.some((s) => s.state === 'paused'));
  assert.equal(g.engine.stop().ok, true);
  await g.engine.whenDone();
  assert.equal(g.status.at(-1).state, 'stopped');
  assert.equal(g.sent.length, 1);
  assert.equal(g.engine.resume({}).ok, false);

  const bad = wfFixture({ fail: (_id, n) => n === 2 }); // 2번째 보낸 것(B의 비판)이 시간 초과
  await bad.engine.start(FOUR);
  await bad.engine.whenDone();
  assert.deepEqual(bad.status.at(-1), { state: 'error', error: '2걸음(B)의 답을 받지 못해 흐름을 멈췄습니다 — 받은 걸음까지는 기록에 남았습니다' });
  assert.deepEqual(bad.chain.map((c) => [c.step, c.state]), [[1, 'done'], [2, 'timeout']]);
  assert.deepEqual(bad.events, [{ kind: 'synth', ok: false, judge: 'A', mode: 'workflow' }]);
  assert.equal(bad.sent.length, 2); // 실패한 뒤로는 보내지 않는다

  const none = new (class { })();
  const e = WF.createWorkflow({ ...{ getRound: () => null, openIds: () => OPEN, status: () => {}, history: {}, nameOf: (x) => x, sendAndWait: async () => ({}), readAnswer: async () => ({}), cancel() {} } });
  assert.match((await e.start(FOUR)).error, /먼저 공통 입력창으로 질문/);
  assert.ok(none);
  assert.match((await wfFixture().engine.start({ steps: [{ kind: 'draft', who: 'a' }] })).error, /2개 이상/);
});

// ---------- 작업 흐름: 기록 · 문서 · 프리셋 · 알림 ----------
test('작업 흐름 기록: chain에 workflow 한 걸음을 남기고, 알맞지 않은 것은 받지 않는다', () => {
  const e = HC.cleanChain({ kind: 'workflow', step: 2, steps: 4, stepKind: 'critique', to: 'b', toName: 'B', at: 7, state: 'done', text: 'x', md: 'y', reused: true, extra: 1 });
  assert.deepEqual(e, { kind: 'workflow', step: 2, steps: 4, stepKind: 'critique', to: 'b', toName: 'B', at: 7, state: 'done', text: 'x', md: 'y', reused: true });
  assert.ok(!('reused' in HC.cleanChain({ kind: 'workflow', step: 1, stepKind: 'draft', to: 'a' })));
  assert.equal(HC.cleanChain({ kind: 'workflow', step: 0, stepKind: 'draft', to: 'a' }), null);
  assert.equal(HC.cleanChain({ kind: 'workflow', step: 1, stepKind: 'hack', to: 'a' }), null);
  assert.equal(HC.cleanChain({ kind: 'workflow', step: 1, stepKind: 'draft', to: 'bad id' }), null);
  assert.equal(HC.cleanChain({ kind: 'workflow', step: 3, steps: 1, stepKind: 'draft', to: 'a' }).steps, 3); // 걸음 수가 번호보다 작으면 번호로
  // 문서
  const items = EX.docFromCompare({ question: 'q', answers: [], chain: [e], debates: [] }).chain;
  assert.match(JSON.stringify(items), /작업 흐름 2\/4 · 비판 → B/);
  // 알림
  const ok = NT.message({ kind: 'synth', ok: true, judge: 'C', mode: 'workflow' });
  assert.match(ok.title, /작업 흐름/);
  assert.equal(ok.view, 'compare');
  assert.match(NT.message({ kind: 'synth', ok: true, judge: 'C', mode: 'factcheck' }).title, /사실 확인/);
  assert.equal(NT.message({ kind: 'synth', ok: false, judge: 'C', mode: 'factcheck' }).view, null);
  // 기록 목록 요약: 사실 확인은 "종합"으로 세지 않는다
  const hist = HC.createHistory(() => {});
  const id = hist.add({ question: 'q', targets: ['a'] });
  hist.addSynth(id, { judge: 'J', mode: 'factcheck', text: 't', md: 't', claims: ['c'] });
  hist.addSynth(id, { judge: 'J', text: 't', md: 't' });
  const item = hist.list()[0];
  assert.equal(item.synth, 1);
  assert.equal(item.factcheck, 1);
});

test('프리셋의 작업 흐름: 걸음 2개 이상일 때만 저장하고, 모르는 종류 · 잘못된 id는 버린다', () => {
  const p = PL.normalizePreset({ name: '흐름', workflow: { steps: [{ kind: 'draft', who: 'gemini' }, { kind: 'bogus', who: 'claude' }, { kind: 'critique', who: 'bad id' }, { kind: 'critique', who: 'chatgpt' }], stepByStep: true } });
  assert.deepEqual(p.workflow, { steps: [{ kind: 'draft', who: 'gemini' }, { kind: 'critique', who: 'chatgpt' }], stepByStep: true });
  assert.deepEqual(PL.normalizePreset({ name: 'x', workflow: { steps: [{ kind: 'draft', who: 'gemini' }] } }).workflow, null);
  assert.equal(PL.normalizePreset({ name: 'x' }).workflow, null);
  assert.ok(!('stepByStep' in PL.normalizePreset({ name: 'x', workflow: { steps: [{ kind: 'draft', who: 'a' }, { kind: 'verify', who: 'b' }] } }).workflow));
  const fromState = PL.presetFromState({ name: 'n', workflow: { steps: [{ kind: 'draft', who: 'a' }, { kind: 'verify', who: 'b' }] } });
  assert.equal(fromState.workflow.steps.length, 2);
});

// ---------- 사실 확인 ----------
test('주장 읽기: 번호 · 글머리표 줄만, 서식 · 중복 · 코드 울타리 · 설명 글은 버리고 10개까지', () => {
  const md = ['다음 주장입니다:', '1. **파이썬**은 1991년에 나왔다', '2) 자바스크립트는 1995년에 나왔다.', '- 파이썬은 `인터프리터` 언어다', '3. 파이썬은 1991년에 나왔다', '```', '4. 코드 안의 번호', '```', '', '설명 줄입니다', '5. 가'].join('\n');
  assert.deepEqual(FC.parseClaims(md), ['파이썬은 1991년에 나왔다', '자바스크립트는 1995년에 나왔다.', '파이썬은 인터프리터 언어다']); // 5. 가는 너무 짧다
  assert.equal(FC.parseClaims(Array.from({ length: 15 }, (_, i) => `${i + 1}. 주장 번호 ${i}`).join('\n')).length, FC.MAX_CLAIMS);
  assert.deepEqual(FC.parseClaims(''), []);
  assert.deepEqual(FC.parseClaims('주장이 없습니다'), []);
  assert.equal(FC.parseClaims(`1. ${'가'.repeat(500)}`)[0].length, 300);
});

test('판정 읽기: 출처 없음 · 확인 불가를 "확인"보다 먼저, 일부 · 반박 · 영어 표현', () => {
  const v = FC.verdictOf;
  assert.equal(v('확인'), 'confirmed');
  assert.equal(v('**확인됨**'), 'confirmed');
  assert.equal(v('사실'), 'confirmed');
  assert.equal(v('Confirmed'), 'confirmed');
  assert.equal(v('반박'), 'refuted');
  assert.equal(v('사실이 아님'), 'refuted');
  assert.equal(v('Refuted'), 'refuted');
  assert.equal(v('False'), 'refuted');
  assert.equal(v('일부'), 'partial');
  assert.equal(v('Partly true'), 'partial');
  assert.equal(v('출처 없음'), 'unsourced');
  assert.equal(v('확인 불가'), 'unsourced'); // "확인"이 들어 있어도 확인이 아니다
  assert.equal(v('근거 부족'), 'unsourced');
  assert.equal(v('No source'), 'unsourced');
  assert.equal(v('Unverified'), 'unsourced');
  assert.equal(v(''), 'unknown');
  assert.equal(v('글쎄요'), 'unknown');
});

const CLAIMS = ['파이썬은 1991년에 나왔다', '자바스크립트는 1996년에 나왔다', '파이썬은 컴파일 언어다', '자바스크립트는 단일 스레드다'];
const TABLE = [
  '| 번호 | 판정 | 근거 · 출처 |',
  '|---|---|---|',
  '| 1 | 확인 | 공식 문서에 1991년 2월 공개 https://docs.python.org/3/faq/general.html. |',
  '| #2 | 반박 | 1995년 12월에 나왔다 (https://example.com/js-history) |',
  '| 3. | 일부 | 바이트코드로 컴파일한 뒤 해석 |',
  '| 4 | 출처 없음 | 믿을 만한 출처를 못 찾음 |',
].join('\n');

test('확인 표 읽기: 번호로 주장과 맞추고, 근거 · 링크를 모으고, 표에 없는 주장은 읽지 못함', () => {
  const r = FC.parseVerdicts(`표입니다.\n${TABLE}\n끝`, CLAIMS);
  assert.deepEqual(r.map((x) => [x.n, x.verdict]), [[1, 'confirmed'], [2, 'refuted'], [3, 'partial'], [4, 'unsourced']]);
  assert.equal(r[0].claim, CLAIMS[0]);
  assert.deepEqual(r[0].links, ['https://docs.python.org/3/faq/general.html']); // 끝의 마침표는 뗀다
  assert.deepEqual(r[1].links, ['https://example.com/js-history']);
  assert.match(r[0].evidence, /공식 문서에 1991년/);
  assert.deepEqual(r[2].links, []);
  // 번호 순서가 뒤섞여도 번호로 맞춘다
  const shuffled = ['| 번호 | 판정 | 근거 |', '|---|---|---|', '| 2 | 반박 | b |', '| 1 | 확인 | a |'].join('\n');
  assert.deepEqual(FC.parseVerdicts(shuffled, CLAIMS.slice(0, 2)).map((x) => x.verdict), ['confirmed', 'refuted']);
  // 표에 없는 주장
  const part = FC.parseVerdicts('| # | Verdict | Evidence |\n|---|---|---|\n| 1 | Confirmed | ok |', CLAIMS.slice(0, 2));
  assert.deepEqual(part.map((x) => x.verdict), ['confirmed', 'unknown']);
  // 번호 칸이 없는 표는 줄 순서로
  const noNums = FC.parseVerdicts('| 주장 | 판정 | 근거 |\n|---|---|---|\n| 파이썬 | 확인 | a |\n| JS | 반박 | b |', CLAIMS.slice(0, 2));
  assert.deepEqual(noNums.map((x) => x.verdict), ['confirmed', 'refuted']);
  assert.deepEqual(FC.parseVerdicts('표가 없습니다', CLAIMS).map((x) => x.verdict), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(FC.parseVerdicts(TABLE, []), []);
  assert.deepEqual(FC.summarize(r), { confirmed: 1, refuted: 1, partial: 1, unsourced: 1, unknown: 0, total: 4 });
  assert.deepEqual(FC.summarize([{ verdict: 'weird' }]), { confirmed: 0, refuted: 0, partial: 0, unsourced: 0, unknown: 1, total: 1 });
});

test('사실 확인 요청 글: 추출은 번호 목록만, 확인은 번호 붙은 주장 + 표 형식 (한국어 · 영어)', () => {
  const ex = FC.buildExtractPrompt({ question: '질문', name: 'Gemini', answer: '답 글' });
  assert.match(ex, /최대 10개 뽑아/);
  assert.match(ex, /"1\. 주장" 형식/);
  assert.match(ex, /\[Gemini의 답변\]\n답 글/);
  const ck = FC.buildCheckPrompt({ claims: CLAIMS.slice(0, 2) });
  assert.match(ck, /1\. 파이썬은 1991년에 나왔다\n2\. 자바스크립트는 1996년에 나왔다/);
  assert.match(ck, /\| 번호 \| 판정 \| 근거 · 출처 \|/);
  assert.match(ck, /"확인".*"반박".*"일부".*"출처 없음"/);
  const en = english(() => [FC.buildExtractPrompt({ question: 'Q', name: 'Gemini', answer: 'text' }), FC.buildCheckPrompt({ claims: ['A claim'] })]);
  assert.match(en[0], /Pick at most 10 claims/);
  assert.match(en[1], /\| # \| Verdict \| Evidence · source \|/);
  assert.match(en[1], /"Confirmed".*"Refuted".*"Partly".*"No source"/);
  assert.ok(!/[가-힣]/.test(en.join('')));
  // 영어 표 답도 읽는다
  assert.equal(FC.parseVerdicts('| # | Verdict | Evidence |\n|---|---|---|\n| 1 | No source | none |', ['x'])[0].verdict, 'unsourced');
});

test('사실 확인 설정: 확인 AI는 열린 패널(기본은 검색형), 추출은 판정을 맡을 수 있는 AI, source는 분석 또는 패널', () => {
  const open = ['gemini', 'perplexity', 'claude'];
  assert.deepEqual(FC.normalizeFactcheck({}, open, 'claude', [...open, 'local']), { ok: true, source: 'claude', extractor: 'claude', checker: 'perplexity' });
  assert.deepEqual(FC.normalizeFactcheck({ source: 'analysis', extractor: 'local', checker: 'gemini' }, open, 'claude', [...open, 'local']), { ok: true, source: 'analysis', extractor: 'local', checker: 'gemini' });
  assert.equal(FC.normalizeFactcheck({ checker: 'local' }, open, 'claude', [...open, 'local']).checker, 'perplexity'); // 패널이 없는 AI는 확인할 수 없다
  assert.equal(FC.normalizeFactcheck({ source: 'zzz' }, open, 'claude').source, 'claude');
  assert.equal(FC.normalizeFactcheck({}, ['gemini', 'claude'], 'claude').checker, 'gemini'); // 검색형이 없으면 첫 패널
  assert.equal(FC.normalizeFactcheck({}, [], 'x').ok, false);
  assert.deepEqual(FC.cleanFactCfg({ source: 'analysis', extractor: 'a', checker: 'bad id', x: 1 }, (id) => /^\w+$/.test(id)), { source: 'analysis', extractor: 'a', checker: undefined });
  assert.deepEqual(FC.cleanFactCfg(null), { source: undefined, extractor: undefined, checker: undefined });
  assert.deepEqual(FC.countSends({ extractor: 'a', checker: 'b' }), { total: 2, byWho: { a: 1, b: 1 } });
  assert.deepEqual(FC.countSends({ extractor: 'a', checker: 'a' }), { total: 2, byWho: { a: 2 } });
});

function factFixture({ extract = '1. 주장 하나입니다\n2. 주장 둘입니다', check = TABLE, analysis = '분석의 최종 답변', answers = { a: '답 글' }, fail = () => false } = {}) {
  const sent = [];
  const status = [];
  const synth = [];
  const events = [];
  const names = { a: 'A', b: 'B', local: '로컬' };
  const engine = FC.createFactcheck({
    sendAndWait: async (id, text) => {
      sent.push({ id, text });
      if (fail(sent.length)) return { state: 'error', text: '', md: '' };
      const md = sent.length === 1 ? extract : check;
      return { state: 'done', text: md, md };
    },
    readAnswer: async (id) => (answers[id] ? { text: answers[id], md: answers[id] } : { text: '', md: '' }),
    nameOf: (id) => names[id] || id,
    openIds: () => ['a', 'b'],
    judgeIds: () => ['a', 'b', 'local'],
    defaultJudge: () => 'a',
    getRound: () => ({ question: 'Q?', historyId: 'h1' }),
    analysisFinal: () => analysis,
    history: { addSynth: (_h, e) => synth.push(e) },
    status: (p) => status.push(p),
    notify: (e) => events.push(e),
    cancel() {},
  });
  return { engine, sent, status, synth, events };
}

test('사실 확인 진행: 추출 1번 → 확인 1번(주장 전체), 결과는 synth(mode factcheck)에 주장과 함께', async () => {
  const f = factFixture();
  assert.deepEqual(await f.engine.start({ source: 'a', extractor: 'local', checker: 'b' }), { ok: true, sends: 2 });
  assert.equal((await f.engine.start({})).ok, false); // 이미 진행 중
  await f.engine.whenDone();
  assert.deepEqual(f.sent.map((s) => s.id), ['local', 'b']);
  assert.match(f.sent[0].text, /\[A의 답변\]\n답 글/);
  assert.match(f.sent[1].text, /1\. 주장 하나입니다\n2\. 주장 둘입니다/); // 주장 전체를 한 번에
  assert.deepEqual(f.status.map((s) => s.state), ['extracting', 'checking', 'done']);
  assert.deepEqual(f.status[1], { state: 'checking', who: 'B', claims: 2 });
  const e = f.synth[0];
  assert.deepEqual({ judge: e.judge, mode: e.mode, claims: e.claims, names: e.names, extractor: e.extractor }, { judge: 'B', mode: 'factcheck', claims: ['주장 하나입니다', '주장 둘입니다'], names: ['A'], extractor: '로컬' });
  assert.equal(e.md, TABLE);
  assert.deepEqual(f.events, [{ kind: 'synth', ok: true, judge: 'B', mode: 'factcheck' }]);
});

test('사실 확인 진행: 분석의 최종 답변을 확인하고, 없거나 · 추출 실패 · 주장 없음 · 확인 실패는 알려 준다', async () => {
  const a = factFixture();
  await a.engine.start({ source: 'analysis', extractor: 'a', checker: 'b' });
  await a.engine.whenDone();
  assert.match(a.sent[0].text, /\[분석의 최종 답변의 답변\]|분석의 최종 답변/);
  assert.deepEqual(a.synth[0].names, ['분석의 최종 답변']);

  const noAnalysis = factFixture({ analysis: '' });
  assert.match((await noAnalysis.engine.start({ source: 'analysis' })).error, /분석이 없습니다/);
  const noAnswer = factFixture({ answers: {} });
  assert.match((await noAnswer.engine.start({ source: 'a' })).error, /A의 답변이 없습니다/);

  const exFail = factFixture({ fail: (n) => n === 1 });
  await exFail.engine.start({ source: 'a', extractor: 'a', checker: 'b' });
  await exFail.engine.whenDone();
  assert.match(exFail.status.at(-1).error, /A이\(가\) 주장을 뽑지 못했습니다/);
  assert.equal(exFail.sent.length, 1); // 확인은 보내지 않는다

  const noClaims = factFixture({ extract: '주장이 없네요' });
  await noClaims.engine.start({ source: 'a', extractor: 'a', checker: 'b' });
  await noClaims.engine.whenDone();
  assert.match(noClaims.status.at(-1).error, /확인할 주장을 찾지 못했습니다/);
  assert.equal(noClaims.sent.length, 1);
  assert.deepEqual(noClaims.events, [{ kind: 'synth', ok: false, judge: 'B', mode: 'factcheck' }]);

  const ckFail = factFixture({ fail: (n) => n === 2 });
  await ckFail.engine.start({ source: 'a', extractor: 'a', checker: 'b' });
  await ckFail.engine.whenDone();
  assert.match(ckFail.status.at(-1).error, /B이\(가\) 확인 결과를 주지 못했습니다/);
  assert.equal(ckFail.synth.length, 0);
});

test('사실 확인 진행: 멈추기', async () => {
  const f = factFixture();
  await f.engine.start({ source: 'a', extractor: 'a', checker: 'b' });
  assert.equal(f.engine.stop().ok, true);
  await f.engine.whenDone();
  assert.equal(f.status.at(-1).state, 'stopped');
  assert.equal(f.synth.length, 0);
  assert.equal(f.engine.stop().ok, false);
});

// ---------- 연결 · 화면 ----------
test('본체 · 확장 연결: IPC 채널 · preload · host · 조립 · 화면 뼈대', () => {
  const ipc = read('src/main/ipc/chain.js');
  for (const ch of ['workflow:start', 'workflow:stop', 'workflow:resume', 'factcheck:start', 'factcheck:stop']) assert.match(ipc, new RegExp(`ipcMain\\.handle\\('${ch}'`));
  assert.match(ipc, /startWorkflow\(cleanWorkflowCfg\(cfg, okId\)\)/);
  assert.match(ipc, /startFactcheck\(cleanFactCfg\(cfg, okId\)\)/);
  const pre = read('src/preload/preload.js');
  assert.match(pre, /workflow: \{\s+start: \(cfg\) => ipcRenderer\.invoke\('workflow:start', cfg\)/);
  assert.match(pre, /factcheck: \{\s+start: \(cfg\) => ipcRenderer\.invoke\('factcheck:start', cfg\)/);
  const host = require('./helpers/ext-host').readHost();
  assert.match(host, /rounds\.startWorkflow\(MLA\.workflow\.cleanWorkflowCfg\(cfg, okChainId\)\)/);
  assert.match(host, /rounds\.startFactcheck\(MLA\.factcheck\.cleanFactCfg\(cfg, okChainId\)\)/);
  const html = read('src/renderer/index.html');
  for (const id of ['workflowBtn', 'workflowNext', 'workflowSkip', 'workflowStop', 'workflowModal', 'workflowSteps', 'workflowStepByStep', 'workflowCount', 'factView']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-ctab="fact"/);
  assert.ok(html.indexOf('shared/chain.js') < html.indexOf('shared/workflow.js') && html.indexOf('shared/workflow.js') < html.indexOf('shared/factcheck.js'));
  assert.ok(html.indexOf('src="debate-ui.js"') < html.indexOf('src="workflow-ui.js"') && html.indexOf('src="workflow-ui.js"') < html.indexOf('src="factcheck-ui.js"'));
  const build = read('scripts/build-extension.js');
  assert.match(build, /'workflow-ui\.js'/);
  assert.match(build, /'factcheck-ui\.js'/);
  const app = read('extension/app.html');
  assert.match(app, /lib\/shared\/workflow\.js/);
  assert.match(app, /lib\/shared\/factcheck\.js/);
  assert.ok(app.indexOf('lib/shared/workflow.js') < app.indexOf('lib/shared/rounds.js')); // 확장은 rounds.js가 workflow · factcheck를 쓴다
  assert.ok(app.indexOf('lib/shared/factcheck.js') < app.indexOf('lib/shared/rounds.js'));
  assert.match(read('src/renderer/renderer-compose.js'), /mode === 'debate' \|\| mode === 'workflow' \|\| mode === 'factcheck'/);
  assert.match(read('src/renderer/renderer-compose.js'), /window\.onWorkflowState\?\.\(\)/);
  assert.match(read('src/renderer/styles.css'), /#compare:not\(\[data-ctab="fact"\]\) \.only-ctab-fact/);
  assert.match(read('src/shared/rounds.js'), /factchecks: synths\.filter\(\(s\) => s\.mode === 'factcheck'\)/);
});

// 가짜 DOM으로 화면 파일을 돌려 본다
function fakeDom() {
  class El {
    constructor(tag) {
      this.tag = tag;
      this.className = '';
      this.children = [];
      this.style = { setProperty: (k, v) => (this.style[k] = v) };
      this.dataset = {};
      this.title = '';
      this._text = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.checked = false;
      this.listeners = {};
      this.attrs = {};
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    append(...kids) {
      for (const k of kids) this.children.push(k);
    }
    replaceChildren(...kids) {
      this.children = kids;
      this._text = '';
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    focus() {}
  }
  const byId = new Map();
  const $ = (sel) => {
    const id = sel.slice(1);
    if (!byId.has(id)) byId.set(id, new El('div'));
    return byId.get(id);
  };
  return { El, $, document: { createElement: (t) => new El(t), createTextNode: (s) => String(s), querySelector: () => null } };
}
const walk = (node, out = []) => {
  if (typeof node === 'string' || !node) return out;
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
};
const cls = (root, c) => walk(root).filter((n) => (n.className || '').split(' ').includes(c));

test('화면: 사실 확인 탭은 요청 줄(보낼 횟수) · 결과 표 · 판정 색 · 링크 복사 · 어림 안내를 그린다', () => {
  const dom = fakeDom();
  const handlers = {};
  const copied = [];
  const entry = { judge: 'Perplexity', extractor: 'Gemini', names: ['Claude'], at: 1, md: TABLE, claims: CLAIMS };
  const ctx = {
    MLA: { factcheck: FC },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    state: { chatView: 'compare', rects: [{ id: 'gemini' }, { id: 'perplexity' }], services: [{ id: 'gemini', name: 'Gemini' }, { id: 'perplexity', name: 'Perplexity' }], synthTarget: 'gemini' },
    compareView: { answers: [{ id: 'gemini', name: 'Gemini', text: '답' }], analysis: null, factchecks: [entry] },
    host: { on: (ch, fn) => (handlers[ch] = fn), copyText: async (u) => copied.push(u), factcheck: { start: async () => ({ ok: true }), stop: async () => ({ ok: true }) } },
    $: dom.$,
    judgeChoices: () => [{ id: 'gemini', name: 'Gemini' }],
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    flash: () => {},
    fmtTime: () => '10:00',
    renderCompare: () => {},
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/factcheck-ui.js'), ctx);
  ctx.window.renderCompareFact();
  const view = dom.$('#factView');
  const text = view.textContent;
  assert.match(text, /보낼 횟수: 2번 \(Gemini 1 · Perplexity 1\)/);
  assert.match(text, /웹 검색은 확인하는 AI의 사이트가 합니다/);
  assert.match(text, /AI가 웹 검색으로 확인한 결과이고 보증이 아닙니다/);
  assert.match(text, /Claude를 확인 — 확인한 AI Perplexity · 주장 추출 Gemini/);
  const verdicts = cls(view, 'fact-verdict').map((n) => [n.className.split(' ')[1], n.textContent]);
  assert.deepEqual(verdicts, [['confirmed', '확인'], ['refuted', '반박'], ['partial', '일부'], ['unsourced', '출처 없음']]);
  assert.deepEqual(cls(view, 'fact-chip').map((n) => n.textContent), ['확인 1', '반박 1', '일부 1', '출처 없음 1']);
  assert.equal(cls(view, 'fact-row').filter((r) => r.className.includes('refuted')).length, 1);
  // 링크는 복사만 (열지 않는다)
  const copyBtns = walk(view).filter((n) => n.tag === 'button' && /^링크 복사/.test(n.title));
  assert.equal(copyBtns.length, 2);
  copyBtns[0].listeners.click({ target: {} });
  assert.deepEqual(copied, ['https://docs.python.org/3/faq/general.html']);
  // 탭 이름의 개수
  assert.ok(!/openExternal|window\.open/.test(read('src/renderer/factcheck-ui.js')));
  // 진행 알림
  handlers['synth:status']({ mode: 'factcheck', state: 'checking', who: 'Perplexity', claims: 4 });
  assert.match(dom.$('#sendHint').textContent, /Perplexity에게 주장 4개를 확인 요청 중/);
  handlers['synth:status']({ mode: 'debate', state: 'running' }); // 다른 모드는 무시
  assert.match(dom.$('#sendHint').textContent, /주장 4개/);
  handlers['synth:status']({ mode: 'factcheck', state: 'error', error: '실패 이유' });
  assert.match(dom.$('#sendHint').textContent, /사실 확인 실패: 실패 이유/);
});

test('화면: 작업 흐름 창은 걸음 목록 · 보낼 횟수 · 규칙 위반 안내, 시작은 검사 통과 때만, 멈춤 단추는 멈춘 동안에만', async () => {
  const dom = fakeDom();
  const handlers = {};
  const started = [];
  const resumed = [];
  const ctx = {
    MLA: { workflow: WF },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    state: { chatView: 'compare', rects: [{ id: 'gemini' }, { id: 'chatgpt' }, { id: 'claude' }], services: [{ id: 'gemini', name: 'Gemini' }, { id: 'chatgpt', name: 'ChatGPT' }, { id: 'claude', name: 'Claude' }] },
    host: {
      on: (ch, fn) => (handlers[ch] = fn),
      getAnswers: async () => ({ question: '질문 한 줄\n둘째 줄', answers: [{ id: 'gemini', text: '답' }, { id: 'chatgpt', text: '' }] }),
      setView() {},
      workflow: { start: async (cfg) => (started.push(cfg), { ok: true }), stop: async () => ({ ok: true }), resume: async (o) => (resumed.push(o), { ok: true }) },
    },
    $: dom.$,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    renderCompare() {},
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/workflow-ui.js'), ctx);
  dom.$('#workflowStepByStep').checked = false;
  await dom.$('#workflowBtn').listeners.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dom.$('#workflowModal').hidden, false);
  const rows = cls(dom.$('#workflowSteps'), 'wf-row');
  assert.equal(rows.length, 4); // 예시: 초안 → 비판 → 고쳐 쓰기 → 검증
  assert.equal(dom.$('#workflowSub').textContent, '4/6걸음');
  // 초안(Gemini)은 이미 답이 있어 보내지 않는다: 4 - 1 = 3번
  assert.match(dom.$('#workflowCount').textContent, /보낼 횟수: 3번 \(ChatGPT 1 · Gemini 1 · Claude 1\)/);
  assert.equal(dom.$('#workflowStart').disabled, false);
  assert.equal(dom.$('#workflowStatus').textContent, '');
  assert.match(dom.$('#workflowQuestion').textContent, /질문: 질문 한 줄/);
  // 첫 걸음을 비판으로 바꾸면 규칙 위반
  const firstKind = walk(rows[0]).find((n) => n.className === 'wf-kind');
  firstKind.value = 'critique';
  firstKind.listeners.change();
  assert.match(dom.$('#workflowStatus').textContent, /첫 걸음은 초안/);
  assert.equal(dom.$('#workflowStart').disabled, true);
  firstKind.value = 'draft';
  firstKind.listeners.change();
  // 시작: 설정을 넘기고 창을 닫는다
  dom.$('#workflowStepByStep').checked = true;
  await dom.$('#workflowStart').listeners.click();
  assert.equal(started.length, 1);
  assert.equal(started[0].stepByStep, true);
  assert.deepEqual(started[0].steps.map((s) => s.kind), ['draft', 'critique', 'revise', 'verify']);
  assert.equal(dom.$('#workflowModal').hidden, true);
  assert.deepEqual(ctx.window.workflowDefaults().steps.map((s) => s.kind), ['draft', 'critique', 'revise', 'verify']); // 프리셋 저장용
  // 진행 · 멈춤
  handlers['synth:status']({ mode: 'workflow', state: 'running', step: 1, steps: 4, who: 'Gemini', kind: 'draft' });
  assert.equal(dom.$('#workflowBtn').hidden, true);
  assert.equal(dom.$('#workflowStop').hidden, false);
  assert.equal(dom.$('#workflowNext').hidden, true);
  assert.match(dom.$('#sendHint').textContent, /작업 흐름 1\/4걸음 — Gemini에게 초안 요청 중/);
  handlers['synth:status']({ mode: 'workflow', state: 'paused', step: 1, steps: 4, who: 'Gemini', kind: 'draft', next: { kind: 'critique', who: 'ChatGPT' } });
  assert.equal(dom.$('#workflowNext').hidden, false);
  assert.equal(dom.$('#workflowSkip').hidden, false);
  assert.match(dom.$('#sendHint').textContent, /다음: ChatGPT의 비판/);
  await dom.$('#workflowSkip').listeners.click();
  await dom.$('#workflowNext').listeners.click();
  assert.equal(JSON.stringify(resumed), JSON.stringify([{ skip: true }, { skip: false }])); // (가짜 화면 안에서 만든 객체라 JSON으로 비교)
  handlers['synth:status']({ mode: 'workflow', state: 'done', steps: 4, who: 'Claude' });
  assert.equal(dom.$('#workflowBtn').hidden, false);
  assert.equal(dom.$('#workflowStop').hidden, true);
  assert.match(dom.$('#sendHint').textContent, /4걸음이 끝났습니다/);
  // 프리셋이 정한 기본값
  ctx.window.setWorkflowDefaults({ steps: [{ kind: 'draft', who: 'claude' }, { kind: 'counter', who: 'gemini' }], stepByStep: true });
  await dom.$('#workflowBtn').listeners.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cls(dom.$('#workflowSteps'), 'wf-row').length, 2);
  assert.equal(dom.$('#workflowStepByStep').checked, true);
});
