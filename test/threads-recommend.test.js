'use strict';
// v0.27.0 대화 줄기 · 질문 종류 · 종류별 추천 단위 테스트:  npm test
// [쉽게 말하면] rounds(가짜 패널)가 같은 대화를 이어 가는 질문에 같은 threadId를 주고, 새 대화 · 패널 닫기면 새 줄기를 시작하는지,
// 질문 종류 나누기, 종류 × AI 숫자와 추천(표본 5개 이상만), 추천 조합 제안 계산, 기록에 kind · project가 남는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const RC = require('../src/shared/recommend');
const { createHistory } = require('../src/shared/history-core');
const { createRounds } = require('../src/shared/rounds');

/** 가짜 패널 rounds: 보내면 곧바로 done */
function fake(open = ['a', 'b', 'c']) {
  const history = createHistory(() => {});
  const panels = new Set(open);
  const rounds = createRounds({
    services: ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() })),
    hasPanel: (id) => panels.has(id),
    sendPrompt: async () => ({ ok: true }),
    snapshot: async () => ({ stop: false, count: 1, text: 'ans', md: 'ans' }),
    watch: (id, _b, isCurrent, onState) => setTimeout(() => isCurrent() && onState('done', { chars: 900 }), 1),
    sendPanel: () => {},
    sendSynthStatus: () => {},
    history,
    prefs: () => ({ synthTarget: 'c', autoSynth: false, retryOnce: false }),
    log: () => {},
  });
  const last = () => history.all()[0];
  return { rounds, history, panels, last };
}

test('대화 줄기: 같은 패널에 이어 보내면 같은 threadId, 새 대화(resetPanel)면 새 줄기', async () => {
  const f = fake();
  await f.rounds.sendAll('첫 질문', ['a', 'b']);
  const t1 = f.last().threadId;
  assert.match(t1, /^[A-Za-z0-9-]+$/);
  assert.equal(f.rounds.threadId(), t1);
  await f.rounds.sendAll('이어서', ['a', 'b']);
  assert.equal(f.last().threadId, t1);
  // 한 패널만 새 대화여도 다른 패널이 이어 가면 같은 줄기
  f.rounds.resetPanel('a');
  await f.rounds.sendAll('하나는 새 대화', ['a', 'b']);
  assert.equal(f.last().threadId, t1);
  // 보내는 패널 모두가 새 대화면 새 줄기
  f.rounds.resetPanel('a');
  f.rounds.resetPanel('b');
  await f.rounds.sendAll('새 주제', ['a', 'b']);
  const t2 = f.last().threadId;
  assert.notEqual(t2, t1);
  // 지난 줄기를 받은 적 없는 패널에만 보내면 새 줄기
  await f.rounds.sendAll('c에만', ['c']);
  assert.notEqual(f.last().threadId, t2);
  const t3 = f.last().threadId;
  // '*' = 모든 패널 (로그아웃 · 로그인 화면)
  f.rounds.resetPanel('*');
  await f.rounds.sendAll('다시', ['c']);
  assert.notEqual(f.last().threadId, t3);
  assert.deepEqual(f.history.thread(t1).map((r) => r.question), ['첫 질문', '이어서', '하나는 새 대화']);
});

test('대화 줄기: 닫힌 패널은 빼고 보고, 넘기기를 받은 패널도 그 줄기를 안다', async () => {
  const f = fake();
  await f.rounds.sendAll('q1', ['a']);
  const t1 = f.last().threadId;
  // a를 닫고(resetPanel) 다시 열어 b와 함께 보내면 새 줄기
  f.panels.delete('a');
  f.rounds.resetPanel('a');
  f.panels.add('a');
  await f.rounds.sendAll('q2', ['a', 'b']);
  const t2 = f.last().threadId;
  assert.notEqual(t2, t1);
  // a의 답을 c에 넘기면(c는 이 줄기를 받음) → c에만 보내도 같은 줄기
  await new Promise((r) => setTimeout(r, 10));
  const res = await f.rounds.handoff('a', 'c', 'review');
  assert.equal(res.ok, true);
  await f.rounds.sendAll('q3', ['c']);
  assert.equal(f.last().threadId, t2);
});

test('질문 종류: 프로젝트 → 코드(블록 · 코드 같은 모양 둘 이상) → 긴 글(1500자 · 첨부 3개) → 일반', () => {
  assert.equal(RC.classifyQuestion({ text: '이거 고쳐줘', project: { name: 'x' } }), 'project');
  assert.equal(RC.classifyQuestion({ text: '```js\nfoo()\n```' }), 'code');
  assert.equal(RC.classifyQuestion({ text: 'const x = () => { return 1; };' }), 'code');
  assert.equal(RC.classifyQuestion({ text: 'TypeError at app.js 에서 납니다' }), 'code');
  assert.equal(RC.classifyQuestion({ text: 'React와 Vue 중 무엇을 먼저 배울까?' }), 'general');
  assert.equal(RC.classifyQuestion({ text: '함수란 무엇인가요?' }), 'general'); // 낱말 하나로는 코드가 아니다
  assert.equal(RC.classifyQuestion({ text: '가'.repeat(1501) }), 'long');
  assert.equal(RC.classifyQuestion({ text: '요약해줘', files: [{}, {}, {}] }), 'long');
  assert.equal(RC.classifyQuestion({}), 'general');
  assert.equal(RC.kindOf({ question: '```x```' }), 'code'); // 예전 기록은 질문으로
  assert.equal(RC.kindOf({ kind: 'long', question: '```x```' }), 'long'); // 저장된 종류가 먼저
  assert.equal(RC.kindOf({ kind: 'evil', question: 'hi' }), 'general');
});

/** 종류 kind, AI별 [상태, 완료 ms, 평가] 목록으로 기록 n개 */
function recs(kind, perSvc) {
  const out = [];
  const n = Math.max(...Object.values(perSvc).map((x) => x.length));
  for (let i = 0; i < n; i++) {
    const targets = Object.keys(perSvc).filter((id) => perSvc[id][i]);
    const answers = {};
    const feedback = {};
    for (const id of targets) {
      const [state, ms, fb] = perSvc[id][i];
      answers[id] = { name: id.toUpperCase(), state, metrics: { doneMs: ms } };
      if (fb) feedback[id] = fb;
    }
    out.push({ id: `${kind}${i}`, at: i, kind, question: 'q', targets, answers, feedback });
  }
  return out;
}

test('종류별 숫자와 추천: 완료율 → 만족도 → 시간, 답 5개 미만은 추천하지 않음, 정확도 점수 없음', () => {
  const done = (ms, fb) => ['done', ms, fb];
  const records = [
    ...recs('code', {
      a: [done(9000), done(9000), done(9000), done(9000), done(9000)], // 완료 100%, 9초
      b: [done(3000), done(3000), done(3000), done(3000), ['timeout']], // 80%
      c: [done(1000, 1), done(1000, 1), done(1000), done(1000), done(1000)], // 100%, 만족 100%, 1초
      d: [done(500), done(500)], // 표본 부족
    }),
    { id: 'x', at: 1, question: 'q', targets: ['a'], answers: {} }, // 결과 없는 답은 세지 않음
    null,
  ];
  const st = RC.kindStats(records);
  const a = st.code.rows.find((r) => r.id === 'a');
  assert.deepEqual([a.answers, a.done, a.completion, a.doneMedianMs, a.satisfaction], [5, 5, 1, 9000, null]);
  assert.equal(st.general.records, 1);
  assert.equal(Object.keys(a).some((k) => /accura|score/i.test(k)), false);
  const rec = RC.recommend(records);
  assert.deepEqual(rec.code.picks, ['c', 'a', 'b']); // c: 100% + 평가, a: 100%, b: 80%
  assert.equal(rec.code.rows.at(-1).id, 'd');
  assert.equal(rec.code.rows.at(-1).enough, false);
  assert.deepEqual(rec.general.picks, []);
  assert.deepEqual(RC.recommend(records, { minSample: 1, top: 1 }).code.picks, ['c']);
  assert.deepEqual(RC.recommend('bad').long, { records: 0, picks: [], rows: [] });
});

test('추천 조합 제안: 열린 패널 중 추천만, 지금 대상과 같거나 추천이 없으면 바꾸지 않음', () => {
  assert.deepEqual(RC.suggestTargets(['c', 'a', 'b'], ['a', 'b', 'd'], ['a', 'b', 'd']), { ids: ['a', 'b'], differs: true });
  assert.deepEqual(RC.suggestTargets(['c', 'a', 'b'], ['a', 'b', 'd'], ['b', 'a']), { ids: ['a', 'b'], differs: false });
  assert.deepEqual(RC.suggestTargets(['x'], ['a'], ['a']), { ids: [], differs: false });
  assert.deepEqual(RC.suggestTargets(null, null, null), { ids: [], differs: false });
});

test('rounds: 기록에 질문 종류 · 프로젝트(이름만)를 남기고, 프로젝트 첨부는 첨부 수로 세지 않는다', async () => {
  const f = fake();
  await f.rounds.sendAll('```js\nx()\n```', ['a']);
  assert.equal(f.last().kind, 'code');
  await f.rounds.sendAll('리팩터링 해줘 + 맥락', ['a'], [], { question: '리팩터링 해줘\n\n[프로젝트 app]', project: { name: 'app', secret: 1 } });
  assert.deepEqual([f.last().kind, f.last().project], ['project', { name: 'app' }]);
  const file = (name) => ({ name, type: 'text/plain', size: 1, data: new ArrayBuffer(1) });
  await f.rounds.sendAll('요약', ['a'], [file('1.txt'), file('p1.md'), file('p2.md')], { userFileCount: 1 });
  assert.equal(f.last().kind, 'general');
  await f.rounds.sendAll('요약', ['a'], [file('1.txt'), file('2.txt'), file('3.txt')]);
  assert.equal(f.last().kind, 'long');
});

test('본체 · 확장 host: 새 대화 · 처음 주소 · 로컬 대화 지우기 · 패널 닫기에서 대화 줄기를 끊고, 프로젝트는 이름만 넘긴다', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'extension', 'host.js'), 'utf8');
  // newchat · home · 로컬 LLM · 닫기(main: showChat · showLogin · logout · closeLocalPanel, host: closePanel · closeLocalPanel)
  assert.ok((main.match(/rounds\.resetPanel\(/g) || []).length >= 7);
  assert.ok((host.match(/rounds\.resetPanel\(/g) || []).length >= 5);
  assert.match(main, /out\.project = \{ name: opts\.project\.name\.trim\(\)\.slice\(0, 120\) \}/);
  assert.match(host, /rounds\.sendAll\(text, targets, files, cleanSendOpts\(opts\)\)/);
  assert.match(host, /typeof autoRecommend === 'boolean'/);
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc', 'settings.js'), 'utf8');
  assert.match(settings, /typeof autoRecommend === 'boolean'/);
  const project = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'project.js'), 'utf8');
  assert.equal((project.match(/project: \{ name: project\.info\.name \}/g) || []).length, 2);
});
