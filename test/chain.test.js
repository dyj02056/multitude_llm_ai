'use strict';
// v0.26.0 이어 묻기 · 토론 · 다시 보내기 · 분석 품질 단위 테스트:  npm test
// [쉽게 말하면] 넘기기 · 토론 요청 글, 토론 설정 검사, 다시 보내기 판단, 다른 AI 고르기, 기록의 chain,
// rounds(가짜 패널)로 넘기기 · 다시 보내기 · 다른 AI로 · 토론 흐름, 이견 → 관련 문단, 두 분석 비교, 내보내기, IPC 검사를 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CH = require('../src/shared/chain');
const RT = require('../src/shared/retry');
const AN = require('../src/shared/analysis');
const EX = require('../src/shared/export');
const N = require('../src/shared/notify');
const { createHistory, cleanChain } = require('../src/shared/history-core');
const { createRounds } = require('../src/shared/rounds');

const ROOT = path.join(__dirname, '..');
const tick = () => new Promise((r) => setTimeout(r, 0));
const waitFor = async (fn, n = 200) => {
  for (let i = 0; i < n && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), 'waitFor');
};

// ---------- 요청 글 · 설정 검사 ----------

test('넘기기 요청 글: 원래 질문 · 보낸 AI 이름 · 답변과 의도별 부탁', () => {
  const r = CH.buildHandoffPrompt({ intent: 'review', question: 'Q?', fromName: 'Gemini', answer: 'A!' });
  assert.match(r, /\[원래 질문\]\nQ\?/);
  assert.match(r, /\[Gemini의 답변\]\nA!/);
  assert.match(r, /검토/);
  assert.match(CH.buildHandoffPrompt({ intent: 'counter', question: '', fromName: 'X', answer: 'a' }), /반박/);
  assert.ok(!CH.buildHandoffPrompt({ intent: 'counter', question: '', fromName: 'X', answer: 'a' }).includes('[원래 질문]')); // 질문이 없으면 뺀다
  assert.match(CH.buildHandoffPrompt({ intent: 'continue', question: 'q', fromName: 'X', answer: 'a' }), /이어받아/);
  const long = CH.buildHandoffPrompt({ intent: 'review', question: 'q', fromName: 'X', answer: 'x'.repeat(20000) });
  assert.ok(long.length < 13000 && long.includes('(이하 생략)'));
});

test('토론 요청 글: 라운드 번호 · 다른 참가 AI 답변 · 마지막 라운드 표시, 판정 글은 세 머리글', () => {
  const p = CH.buildDebatePrompt({ question: 'Q', round: 2, rounds: 2, selfName: 'A', others: [{ name: 'B', text: 'b says' }] });
  assert.match(p, /\[토론 2\/2라운드\]/);
  assert.match(p, /\[B의 최신 답변\]\nb says/);
  assert.match(p, /마지막 라운드/);
  assert.ok(!CH.buildDebatePrompt({ question: 'Q', round: 1, rounds: 2, selfName: 'A', others: [] }).includes('마지막 라운드'));
  const j = CH.buildDebateJudgePrompt({ question: 'Q', positions: [{ name: 'A', text: 'a' }], rounds: 3 });
  for (const h of ['## 합의한 점', '## 남은 이견', '## 최종 답변', '[A의 마지막 입장]', '3라운드']) assert.ok(j.includes(h), h);
});

test('토론 설정 검사: 열린 패널 2~3개, 라운드 1~3(기본 2), 판정은 열린 패널 · 없으면 종합 담당 · 첫 참가', () => {
  const open = ['a', 'b', 'c', 'd'];
  assert.equal(CH.normalizeDebate({ participants: ['a'] }, open, 'a').ok, false);
  assert.equal(CH.normalizeDebate({ participants: ['a', 'b', 'c', 'd'] }, open, 'a').ok, false);
  assert.equal(CH.normalizeDebate({ participants: ['a', 'zz'] }, open, 'a').ok, false); // 닫힌 패널은 뺀다
  assert.deepEqual(CH.normalizeDebate({ participants: ['a', 'b', 'a'], rounds: 9 }, open, 'c'), { ok: true, participants: ['a', 'b'], rounds: 2, judge: 'c' });
  assert.equal(CH.normalizeDebate({ participants: ['a', 'b'], rounds: 3, judge: 'd' }, open, 'c').judge, 'd');
  assert.equal(CH.normalizeDebate({ participants: ['a', 'b'], rounds: 1, judge: 'zz' }, open, 'zz').judge, 'a');
  assert.equal(CH.normalizeDebate(null, open).ok, false);
});

// ---------- 다시 보내기 · 다른 AI ----------

test('다시 보내기 판단: 보내기 실패는 한 번만 자동, 시간 초과 · 답변 없음은 버튼만, 한도 · 패널 없음은 하지 않음', () => {
  assert.deepEqual(RT.retryDecision({ state: 'error', attempt: 0, enabled: true, error: 'x' }), { action: 'resend', delayMs: RT.RETRY_DELAY_MS });
  assert.equal(RT.retryDecision({ state: 'error', attempt: 1, enabled: true }).action, 'offer');
  assert.equal(RT.retryDecision({ state: 'error', attempt: 0, enabled: false }).action, 'offer');
  assert.equal(RT.retryDecision({ state: 'error', limit: true }).action, 'none');
  assert.equal(RT.retryDecision({ state: 'error', error: '패널이 닫혔습니다' }).action, 'none');
  assert.equal(RT.retryDecision({ state: 'timeout' }).action, 'offer');
  assert.equal(RT.retryDecision({ state: 'no-answer' }).action, 'offer');
  assert.equal(RT.retryDecision({ state: 'done' }).action, 'none');
});

test('다른 AI 고르기: 한도에 걸린 패널 · 자기 자신은 빼고, 완료 → 첫 응답 중앙값 빠른 순, 통계 없으면 뒤로', () => {
  const rows = [
    { id: 'b', doneMedianMs: 9000, firstMedianMs: 2000 },
    { id: 'c', doneMedianMs: 5000, firstMedianMs: 3000 },
    { id: 'd', doneMedianMs: 5000, firstMedianMs: 1000 },
  ];
  assert.deepEqual(RT.pickFallback({ fromId: 'a', openIds: ['a', 'b', 'c', 'd', 'e', 'f'], limitedIds: ['f'], rows }), ['d', 'c', 'b', 'e']);
  assert.deepEqual(RT.pickFallback({ fromId: 'a', openIds: ['a'] }), []);
  assert.deepEqual(RT.pickFallback({ fromId: 'a', openIds: ['x', 'y'], rows: 'bad' }), ['x', 'y']);
});

// ---------- 기록 chain ----------

test('기록 chain: 검사 · 저장 표시(dirty) · 목록 개수 · 검색', async () => {
  assert.equal(cleanChain({ kind: 'nope' }), null);
  assert.equal(cleanChain({ kind: 'handoff', intent: 'x', from: 'a', to: 'b' }), null);
  assert.equal(cleanChain({ kind: 'handoff', intent: 'review', from: 'a', to: 'a' }), null);
  assert.equal(cleanChain({ kind: 'handoff', intent: 'review', from: '__proto__', to: 'b' }), null);
  assert.equal(cleanChain({ kind: 'debate', round: 0, answers: [{ id: 'a' }] }), null);
  assert.equal(cleanChain({ kind: 'debate', round: 1, answers: [] }), null);
  const d = cleanChain({ kind: 'debate', round: 1, rounds: 2, at: 5, answers: [{ id: 'a', name: 'A', state: 'weird', text: 'x', extra: 1 }, { id: 'bad id!' }] });
  assert.deepEqual(d, { kind: 'debate', round: 1, rounds: 2, at: 5, answers: [{ id: 'a', name: 'A', state: 'done', text: 'x', md: '' }] });
  const h = cleanChain({ kind: 'handoff', intent: 'counter', from: 'a', to: 'b', text: 1, md: 'm', junk: true });
  assert.equal(h.intent, 'counter');
  assert.equal(h.text, '');
  assert.ok(!('junk' in h));
  assert.equal(cleanChain({ kind: 'fallback', intent: 'review', from: 'a', to: 'b' }).intent, undefined);

  const saves = [];
  const hist = createHistory((recs, info) => saves.push(info));
  const id = hist.add({ question: 'q', targets: ['a', 'b'] });
  hist.flush();
  assert.equal(hist.addChain('nope', { kind: 'fallback', from: 'a', to: 'b' }), false);
  assert.equal(hist.addChain(id, { kind: 'fallback', from: 'a', to: 'b', text: 'special words here' }), true);
  hist.flush();
  assert.deepEqual(saves.at(-1), { dirty: [id], order: false }); // 그 기록만 다시 쓴다
  hist.addSynth(id, { judge: 'J', mode: 'debate', text: 't' });
  const item = hist.list()[0];
  assert.equal(item.chain, 1);
  assert.equal(item.debate, 1);
  assert.equal(item.synth, 0);
  assert.equal(hist.list('special words').length, 1);
  for (let i = 0; i < 70; i++) hist.addChain(id, { kind: 'fallback', from: 'a', to: 'b' });
  assert.equal(hist.get(id).chain.length, 60);
});

// ---------- rounds (가짜 패널) ----------

/** 가짜 패널: 보내면 그 패널의 답이 "id:보낸 횟수"가 되고, auto면 곧바로 done */
function fakeRounds({ fail = () => false, limit = () => null, auto = true, retryOnce = true } = {}) {
  const sent = [];
  const answers = {};
  const watchers = new Map();
  const events = [];
  const synth = [];
  const history = createHistory(() => {});
  const rounds = createRounds({
    services: ['a', 'b', 'c', 'j'].map((id) => ({ id, name: id.toUpperCase() })),
    hasPanel: (id) => ['a', 'b', 'c', 'j'].includes(id),
    sendPrompt: async (id, text) => {
      sent.push({ id, text });
      if (fail(id, sent.filter((s) => s.id === id).length)) return { ok: false, error: 'boom' };
      answers[id] = `${id}:${sent.filter((s) => s.id === id).length}`;
      return { ok: true };
    },
    snapshot: async (id) => ({ stop: false, count: 1, text: answers[id] || '', md: answers[id] || '' }),
    watch: (id, _b, isCurrent, onState) => {
      watchers.set(id, onState);
      if (auto) setTimeout(() => isCurrent() && onState('done', { chars: 900 }), 1);
    },
    sendPanel: () => {},
    sendSynthStatus: (p) => synth.push(p),
    history,
    prefs: () => ({ synthTarget: 'j', autoSynth: false, retryOnce }),
    retryDelayMs: 0,
    checkLimit: async (id) => limit(id),
    notify: (e) => events.push(e),
    log: () => {},
  });
  return { rounds, sent, answers, watchers, events, synth, history };
}

test('rounds 다시 보내기: 보내기 실패면 한 번만 자동으로, 끄면 안 함, 한도면 안 함', async () => {
  const f = fakeRounds({ fail: (_id, n) => n === 1 });
  const [r] = await f.rounds.sendAll('q', ['a']);
  assert.equal(r.ok, true);
  assert.equal(r.retried, true);
  assert.equal(f.sent.length, 2);
  const g = fakeRounds({ fail: () => true });
  await g.rounds.sendAll('q', ['a']);
  assert.equal(g.sent.length, 2); // 두 번째도 실패하면 더 보내지 않는다
  const off = fakeRounds({ fail: () => true, retryOnce: false });
  await off.rounds.sendAll('q', ['a']);
  assert.equal(off.sent.length, 1);
  const lim = fakeRounds({ fail: () => true, limit: () => 'limit reached' });
  await lim.rounds.sendAll('q', ['a']);
  assert.equal(lim.sent.length, 1);
  assert.ok(lim.events.some((e) => e.kind === 'limit'));
});

test('rounds [다시 보내기] · 다른 AI로: 마지막에 보낸 글을 그대로, 다른 AI로 보낸 결과는 chain에', async () => {
  const f = fakeRounds({ auto: false });
  assert.equal((await f.rounds.resend('a')).ok, false); // 아직 보낸 것이 없음
  await f.rounds.sendAll('the question', ['a', 'b']);
  f.watchers.get('a')('timeout', {});
  assert.equal((await f.rounds.resend('a')).ok, true);
  assert.equal(f.sent.at(-1).id, 'a');
  assert.equal(f.sent.at(-1).text, 'the question');
  await f.watchers.get('a')('done', { chars: 900 });
  await tick();
  const rec = f.history.all()[0];
  assert.equal(rec.answers.a.state, 'done'); // 다시 보낸 답이 그 라운드 기록에
  assert.equal((await f.rounds.sendElsewhere('b', 'b')).ok, false);
  assert.equal((await f.rounds.sendElsewhere('b', 'c')).ok, true);
  assert.equal(f.sent.at(-1).id, 'c');
  assert.equal(f.sent.at(-1).text, 'the question');
  await f.watchers.get('c')('done', { chars: 900 });
  await tick();
  const c = f.history.all()[0].chain;
  assert.equal(c.length, 1);
  assert.deepEqual({ kind: c[0].kind, from: c[0].from, to: c[0].to, text: c[0].text }, { kind: 'fallback', from: 'b', to: 'c', text: 'c:1' });
});

test('rounds 넘기기: 보낸 AI의 답을 받는 AI에게, 끝나면 chain에 handoff · answers()가 chain을 돌려준다', async () => {
  const f = fakeRounds();
  await f.rounds.sendAll('Q?', ['a', 'b']);
  await waitFor(() => f.history.all()[0].answers.b);
  assert.equal((await f.rounds.handoff('a', 'b', 'bogus')).ok, false);
  assert.equal((await f.rounds.handoff('a', 'a', 'review')).ok, false);
  assert.equal((await f.rounds.handoff('c', 'b', 'review')).ok, false); // c는 답이 없음
  const r = await f.rounds.handoff('a', 'b', 'counter');
  assert.equal(r.ok, true);
  const last = f.sent.at(-1);
  assert.equal(last.id, 'b');
  assert.match(last.text, /\[A의 답변\]\na:1/);
  assert.match(last.text, /Q\?/);
  await waitFor(() => f.history.all()[0].chain?.length);
  const e = f.history.all()[0].chain[0];
  assert.deepEqual({ kind: e.kind, intent: e.intent, from: e.from, to: e.to, text: e.text }, { kind: 'handoff', intent: 'counter', from: 'a', to: 'b', text: 'b:2' });
  const ans = await f.rounds.answers();
  assert.equal(ans.chain.length, 1);
  assert.deepEqual(ans.debates, []);
});

test('rounds 토론: 라운드마다 참가 AI에게 다른 AI 최신 답, 판정 결론은 synth mode debate, 끝나면 알림', async () => {
  const f = fakeRounds();
  assert.equal((await f.rounds.startDebate({ participants: ['a', 'b'] })).ok, false); // 질문이 없음
  await f.rounds.sendAll('Q', ['a', 'b', 'c']);
  await waitFor(() => Object.keys(f.history.all()[0].answers).length === 3);
  assert.equal((await f.rounds.startDebate({ participants: ['a'] })).ok, false);
  const r = await f.rounds.startDebate({ participants: ['a', 'b', 'c'], rounds: 2, judge: 'j' });
  assert.deepEqual(r, { ok: true, participants: 3, rounds: 2 });
  assert.equal((await f.rounds.startDebate({ participants: ['a', 'b'] })).ok, false); // 이미 진행 중
  await f.rounds.debateDone();
  const rec = f.history.all()[0];
  const debates = rec.chain.filter((c) => c.kind === 'debate');
  assert.deepEqual(debates.map((d) => d.round), [1, 2]);
  assert.deepEqual(debates[1].answers.map((x) => x.text), ['a:3', 'b:3', 'c:3']);
  // 2라운드에 A가 받은 글에는 B · C의 1라운드 답
  const aRound2 = f.sent.filter((s) => s.id === 'a')[2].text;
  assert.match(aRound2, /\[토론 2\/2라운드\]/);
  assert.match(aRound2, /\[B의 최신 답변\]\nb:2/);
  assert.ok(!aRound2.includes('[A의 최신 답변]'));
  const judge = f.sent.at(-1);
  assert.equal(judge.id, 'j');
  assert.match(judge.text, /\[C의 마지막 입장\]\nc:3/);
  const syn = rec.synth.at(-1);
  assert.deepEqual({ mode: syn.mode, judge: syn.judge, text: syn.text, rounds: syn.rounds }, { mode: 'debate', judge: 'J', text: 'j:1', rounds: 2 });
  assert.ok(f.events.some((e) => e.kind === 'synth' && e.mode === 'debate' && e.ok));
  const states = f.synth.filter((p) => p.mode === 'debate').map((p) => p.state);
  assert.ok(states.includes('running') && states.includes('judging') && states.at(-1) === 'done');
  assert.equal((await f.rounds.answers()).debates.length, 1);
});

test('rounds 토론 멈추기: 기다리던 답 감시를 멈추고 판정은 하지 않는다', async () => {
  const f = fakeRounds({ auto: false });
  await f.rounds.sendAll('Q', ['a', 'b']);
  await f.watchers.get('a')('done', {});
  await f.watchers.get('b')('done', {});
  await tick();
  assert.equal((await f.rounds.stopDebate()).ok, false);
  assert.equal((await f.rounds.startDebate({ participants: ['a', 'b'], rounds: 1 })).ok, true);
  await waitFor(() => f.sent.filter((s) => s.id === 'b').length === 2);
  assert.equal(f.rounds.stopDebate().ok, true);
  await f.rounds.debateDone();
  assert.equal(f.synth.at(-1).state, 'stopped');
  assert.ok(!f.sent.some((s) => s.id === 'j'));
  assert.ok(!(f.history.all()[0].chain || []).length);
});

// ---------- 분석 품질 ----------

test('관련 문단: 쟁점 낱말과 많이 겹치는 문단 (조사는 떼고), 위치는 원문 기준', () => {
  const text = 'Python은 배우기 쉽습니다.\n\nJavaScript는 웹 브라우저에서 바로 돌아갑니다.\n\n둘 다 취업 시장이 큽니다.';
  const ps = AN.paragraphs(text);
  assert.equal(ps.length, 3);
  assert.equal(text.slice(ps[1].start, ps[1].end), ps[1].text);
  const hits = AN.relatedParagraphs('웹 브라우저 실행 여부', text);
  assert.equal(hits[0].text, 'JavaScript는 웹 브라우저에서 바로 돌아갑니다.');
  assert.deepEqual(AN.relatedParagraphs('', text), []);
  assert.deepEqual(AN.relatedParagraphs('전혀 상관없는 말', text), []);
  assert.equal(AN.paragraphs('한 줄\n두 줄\n세 줄').length, 3); // 빈 줄이 없으면 줄마다
  assert.ok(AN.tokens('파이썬을 추천합니다').has('파이썬'));
});

test('두 분석 비교: 같은 쟁점은 짝, 한쪽에만 있는 쟁점 번호', () => {
  const md = (rows) => `## 이견\n| 쟁점 | A | B | 판단 |\n| --- | --- | --- | --- |\n${rows.map((r) => `| ${r} | x | y | z |`).join('\n')}\n\n## 최종 답변\n끝`;
  const a = AN.parseAnalysis(md(['첫 언어로 무엇이 좋은가', '취업 시장 규모']), { names: ['A', 'B'] });
  const b = AN.parseAnalysis(md(['첫 언어로 무엇이 좋은가?', '학습 곡선 난이도']), { names: ['A', 'B'] });
  assert.deepEqual(AN.compareAnalyses(a, b), { onlyA: [1], onlyB: [1], same: [[0, 0]] });
  assert.deepEqual(AN.compareAnalyses({ ok: false }, b).onlyB, [0, 1]);
});

// ---------- 내보내기 · 알림 ----------

test('내보내기: 기록의 이어 묻기 · 토론 라운드 · 토론 결론이 Markdown · HTML에 순서대로 (HTML은 이스케이프)', () => {
  const rec = {
    at: 1,
    question: 'Q',
    targets: ['a'],
    answers: { a: { name: 'A', text: 'ans' } },
    synth: [{ judge: 'J', mode: 'debate', md: 'conclusion' }],
    chain: [
      { kind: 'handoff', intent: 'review', from: 'a', to: 'b', fromName: 'A', toName: 'B', md: '<script>x</script>' },
      { kind: 'debate', round: 1, rounds: 2, answers: [{ id: 'a', name: 'A', md: 'r1a' }, { id: 'b', name: 'B', md: 'r1b' }] },
      { kind: 'fallback', from: 'a', to: 'c', md: '' }, // 글이 없으면 뺀다
    ],
  };
  const doc = EX.docFromRecord(rec);
  assert.equal(doc.chain.length, 2);
  const md = EX.toMarkdown(doc);
  assert.ok(md.indexOf('### A → B · 검토') < md.indexOf('### 토론 1/2라운드'));
  assert.match(md, /#### B\n\nr1b/);
  assert.match(md, /## 토론 결론 \(J\)\n\nconclusion/);
  const html = EX.toHtml(doc);
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(EX.docFromCompare({ question: 'q', answers: [], chain: rec.chain, debates: rec.synth }).synth[0].mode === 'debate');
});

test('알림: 토론 결론도 누르면 답변 비교 화면', () => {
  const m = N.message({ kind: 'synth', ok: true, judge: 'J', mode: 'debate' });
  assert.equal(m.view, 'compare');
  assert.match(m.body, /토론/);
});

// ---------- IPC · 확장 host 연결 ----------

function fakeIpc() {
  const handle = new Map();
  return { on: () => {}, handle: (ch, fn) => handle.set(ch, fn), handle_: handle };
}

test('ipc/chain: 요청을 등록하고 id · 의도 · 열린 패널 · 토론 설정을 검사한다', async () => {
  const ipcMain = fakeIpc();
  const calls = [];
  const rounds = {
    handoff: (...a) => (calls.push(['handoff', ...a]), { ok: true }),
    resend: (id) => (calls.push(['resend', id]), { ok: true }),
    sendElsewhere: (...a) => (calls.push(['elsewhere', ...a]), { ok: true }),
    startDebate: (cfg) => (calls.push(['debate', cfg]), { ok: true }),
    stopDebate: () => ({ ok: true }),
  };
  require('../src/main/ipc/chain').register({ ipcMain, rounds: () => rounds, hasPanel: (id) => ['a', 'b'].includes(id) });
  assert.deepEqual([...ipcMain.handle_.keys()].sort(), ['chain:handoff', 'debate:interject', 'debate:start', 'debate:stop', 'factcheck:start', 'factcheck:stop', 'prompt:elsewhere', 'prompt:resend', 'workflow:resume', 'workflow:start', 'workflow:stop']);
  const h = (ch, ...a) => ipcMain.handle_.get(ch)(null, ...a);
  assert.equal(h('chain:handoff', 'a', 'b', 'evil').ok, false);
  assert.equal(h('chain:handoff', 'a', 'zz', 'review').ok, false);
  assert.equal(h('chain:handoff', { x: 1 }, 'b', 'review').ok, false);
  assert.equal(h('chain:handoff', 'a', 'b', 'review').ok, true);
  assert.equal(h('prompt:resend', 'zz').ok, false);
  assert.equal(h('prompt:elsewhere', 'a', 'zz').ok, false);
  h('debate:start', { participants: ['a', 'b', 'bad id', 7], rounds: 99, judge: 'a', extra: 'x' });
  assert.deepEqual(calls.at(-1), ['debate', { participants: ['a', 'b'], rounds: undefined, judge: 'a' }]);
  h('debate:start', 'nope');
  assert.deepEqual(calls.at(-1), ['debate', { participants: [], rounds: undefined, judge: undefined }]);
  assert.deepEqual(calls.slice(0, 1), [['handoff', 'a', 'b', 'review']]);
});

test('확장 host · preload: 이어 묻기 API가 같은 이름으로 있고, 다시 보내기 설정을 검사 · 저장한다', () => {
  const host = fs.readFileSync(path.join(ROOT, 'extension', 'host.js'), 'utf8');
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  for (const name of ['handoff:', 'resend:', 'sendElsewhere:', 'debate:']) {
    assert.ok(host.includes(`    ${name}`), `host ${name}`);
    assert.ok(pre.includes(`  ${name}`), `preload ${name}`);
  }
  assert.match(host, /typeof retryOnce === 'boolean'/);
  assert.match(host, /prefs\.retryOnce = prefs\.retryOnce !== false/);
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc', 'settings.js'), 'utf8');
  assert.match(settings, /typeof retryOnce === 'boolean'/);
  // 확장 앱 탭은 debate.js를 rounds.js보다 먼저, chain.js · retry.js는 화면 공통 모듈 줄에서 읽는다
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-extension.js'), 'utf8');
  assert.match(build, /'debate', 'rounds'/);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  for (const s of ['../shared/chain.js', '../shared/retry.js', 'chain-views.js', 'panel-offers.js', 'debate-ui.js']) assert.ok(html.includes(s), s);
});
