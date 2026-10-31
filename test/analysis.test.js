'use strict';
// 답변 일치·이견 분석 (v0.11.0) 단위 테스트:  npm test
// [쉽게 말하면] 판정 AI가 정해진 형식으로 답했을 때 표로 그릴 수 있게 잘 읽는지,
// 형식이 깨졌을 때 "글 그대로"로 물러나는지, 이견이 하나도 없을 때를 확인합니다.
// 차이 강조(기준 답변과 다른 문장)와 분석 요청 글도 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/shared/analysis');
const { buildSynthPrompt, analysisNames } = require('../src/shared/synth');
const { createRounds } = require('../src/shared/rounds');

const NAMES = ['ChatGPT', 'Gemini', 'DeepSeek'];

const GOOD = `## 공통 의견
- 서울의 인구는 약 940만 명이다
- 수도권 집중이 크다

## 이견
| 쟁점 | ChatGPT | Gemini | DeepSeek | 판단 |
| --- | --- | --- | --- | --- |
| 인구 감소 시작 | 2010년부터 | 2016년부터 | - | 통계청 기준 2010년대 초부터 감소 |
| 면적 | 605㎢ | 605.2㎢ | 약 600㎢ | 605.2㎢가 정확 |

## 근거 부족
- [DeepSeek] 2030년 인구 800만 전망 — 출처 없음
- Gemini: 외국인 비율 10% 주장

## 최종 답변
서울의 인구는 약 940만 명이며,
2010년대 초부터 줄고 있습니다.`;

test('분석 읽기: 형식이 맞는 답 → 공통 의견 · 이견 표 · 근거 부족 · 최종 답변', () => {
  const r = A.parseAnalysis(GOOD, { names: NAMES });
  assert.equal(r.ok, true);
  assert.deepEqual(r.common, ['서울의 인구는 약 940만 명이다', '수도권 집중이 크다']);
  assert.equal(r.disagreements.length, 2);
  const [d1, d2] = r.disagreements;
  assert.equal(d1.topic, '인구 감소 시작');
  assert.deepEqual(d1.positions.map((p) => [p.name, p.text]), [['ChatGPT', '2010년부터'], ['Gemini', '2016년부터'], ['DeepSeek', '-']]);
  assert.equal(d1.verdict, '통계청 기준 2010년대 초부터 감소');
  assert.equal(d2.positions.length, 3);
  assert.ok(d2.positions.every((p) => p.known));
  assert.deepEqual(r.unsupported, [
    { name: 'DeepSeek', text: '2030년 인구 800만 전망 — 출처 없음' },
    { name: 'Gemini', text: '외국인 비율 10% 주장' },
  ]);
  assert.equal(r.final, '서울의 인구는 약 940만 명이며,\n2010년대 초부터 줄고 있습니다.');
});

test('분석 읽기: 머리글 모양이 달라도 (**굵게**, [대괄호], 번호, 콜론) 읽는다', () => {
  const md = `**공통 의견**\n- 같음\n\n[이견]\n- 없음\n\n3) 근거 부족:\n- 없음\n\n### 최종답변\n끝.`;
  const r = A.parseAnalysis(md, { names: NAMES });
  assert.equal(r.ok, true);
  assert.deepEqual(r.common, ['같음']);
  assert.deepEqual(r.disagreements, []);
  assert.deepEqual(r.unsupported, []);
  assert.equal(r.final, '끝.');
});

test('분석 읽기: 이견 0개 (표 대신 "- 없음", 또는 머리줄만 있는 표)', () => {
  const none = A.parseAnalysis('## 공통 의견\n- 모두 같음\n## 이견\n- 없음\n## 근거 부족\n- 없음\n## 최종 답변\n답', { names: NAMES });
  assert.equal(none.ok, true);
  assert.equal(none.disagreements.length, 0);
  const emptyTable = A.parseAnalysis('## 이견\n| 쟁점 | ChatGPT | 판단 |\n|---|---|---|\n| 없음 | | |\n## 최종 답변\n답', { names: NAMES });
  assert.equal(emptyTable.ok, true);
  assert.equal(emptyTable.disagreements.length, 0);
});

test('분석 읽기: 형식이 깨진 답 → ok: false, 글 그대로', () => {
  const plain = '세 답변 모두 대체로 맞습니다. 다만 ChatGPT는 연도가 틀렸습니다.';
  const r = A.parseAnalysis(plain, { names: NAMES });
  assert.equal(r.ok, false);
  assert.equal(r.raw, plain);
  assert.match(r.reason, /이견/);
  // 최종 답변 머리글이 없음
  assert.equal(A.parseAnalysis('## 공통 의견\n- a\n## 이견\n- 없음', { names: NAMES }).ok, false);
  // 최종 답변이 비어 있음
  assert.equal(A.parseAnalysis('## 이견\n- 없음\n## 최종 답변\n   \n', { names: NAMES }).ok, false);
  // 빈 답
  assert.equal(A.parseAnalysis('', { names: NAMES }).ok, false);
  // 코드 블록 안의 머리글은 머리글이 아님
  assert.equal(A.parseAnalysis('```\n## 이견\n## 최종 답변\nx\n```', { names: NAMES }).ok, false);
});

test('분석 읽기: 표가 아닌 글머리표 이견은 쟁점으로, 언급한 AI를 찾는다', () => {
  const r = A.parseAnalysis('## 이견\n- 연도: chatgpt는 2010년, Gemini는 2016년\n## 최종 답변\nx', { names: NAMES });
  assert.equal(r.ok, true);
  assert.equal(r.disagreements.length, 1);
  assert.deepEqual(r.disagreements[0].positions.map((p) => p.name), ['ChatGPT', 'Gemini']);
});

test('분석 읽기: 표 머리글의 "(당신)"·대소문자는 무시하고 AI 이름에 맞춘다', () => {
  const r = A.parseAnalysis('## 이견\n| 쟁점 | chatgpt | Gemini (당신) | 결론 |\n|:--|:--|:--|:--|\n| x | a | b | c |\n## 최종 답변\nok', { names: NAMES });
  assert.deepEqual(r.disagreements[0].positions.map((p) => p.name), ['ChatGPT', 'Gemini']);
  assert.equal(r.disagreements[0].verdict, 'c');
});

test('분석 요청 글: 네 머리글과 AI 이름 열 (판정 AI가 이미 답했으면 그 열도)', () => {
  const answers = [{ name: 'ChatGPT', text: 'a' }, { name: 'Gemini', text: 'b' }];
  const p = buildSynthPrompt({ question: 'Q', answers, judgeAnswered: true, judgeName: 'DeepSeek', mode: 'analysis' });
  for (const h of Object.values(A.SECTIONS)) assert.ok(p.includes(`## ${h}`), h);
  assert.match(p, /\| 쟁점 \| ChatGPT \| Gemini \| DeepSeek \| 판단 \|/);
  assert.match(p, /당신\(DeepSeek\)/);
  assert.deepEqual(analysisNames({ answers, judgeAnswered: false, judgeName: 'DeepSeek' }), ['ChatGPT', 'Gemini']);
  // 요청 글의 머리글을 그대로 따라 쓴 답은 읽힌다
  const echoed = p.slice(p.indexOf('## 공통 의견'));
  assert.equal(A.parseAnalysis(echoed, { names: ['ChatGPT', 'Gemini', 'DeepSeek'] }).ok, true);
  // 일반 종합 글은 그대로
  assert.match(buildSynthPrompt({ question: 'Q', answers, judgeAnswered: false }), /최종 답변/);
});

test('분석 실행: 판정 AI 답변이 끝나면 기록에 mode: analysis로 저장하고 다음 비교 화면에 넘긴다', async () => {
  const services = [
    { id: 'a', name: 'ChatGPT' },
    { id: 'b', name: 'Gemini' },
    { id: 'j', name: 'Claude' },
  ];
  const synths = [];
  const statuses = [];
  let watcher = null;
  const md = { a: '답 A', b: '답 B', j: GOOD };
  const rounds = createRounds({
    services,
    hasPanel: () => true,
    sendPrompt: async () => ({ ok: true }),
    snapshot: async (id) => ({ stop: false, count: 1, text: md[id], md: md[id] }),
    watch: (_id, _before, _cur, onState) => {
      watcher = onState;
    },
    sendPanel: () => {},
    sendSynthStatus: (p) => statuses.push(p),
    history: { add: () => 'h1', setAnswer: () => {}, addSynth: (id, s) => synths.push([id, s]) },
    prefs: () => ({ synthTarget: 'j', autoSynth: false }),
    log: () => {},
  });
  await rounds.sendAll('질문', ['a', 'b'], []);
  const res = await rounds.runSynth('j', 'manual', 'analysis');
  assert.equal(res.ok, true);
  await watcher('done');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(synths.length, 1);
  assert.equal(synths[0][1].mode, 'analysis');
  assert.deepEqual(synths[0][1].names, ['ChatGPT', 'Gemini']);
  assert.ok(statuses.some((s) => s.state === 'done' && s.mode === 'analysis'));
  const view = await rounds.answers();
  assert.equal(view.analysis.mode, 'analysis');
  assert.equal(A.parseAnalysis(view.analysis.md, { names: view.analysis.names }).ok, true);
});

test('차이 강조: 기준 답변에 없는 문장만 표시, 공백 차이는 같은 문장', () => {
  const base = '서울은 수도입니다. 인구는 940만입니다.\n- 한강이 흐릅니다';
  const other = '서울은  수도입니다. 인구는 950만입니다.\n- 한강이 흐릅니다\n- 남산이 있습니다';
  const marks = A.diffMarks(base, other);
  assert.equal(marks.map((m) => m.text).join(''), other); // 글은 그대로
  assert.deepEqual(marks.filter((m) => m.changed).map((m) => m.text.trim()), ['인구는 950만입니다.', '- 남산이 있습니다']);
  assert.ok(A.changedRatio(marks) > 0 && A.changedRatio(marks) < 1);
  assert.deepEqual(A.diffMarks(base, base).filter((m) => m.changed), []);
  assert.deepEqual(A.diffMarks('', 'x'), [{ text: 'x', changed: true }]);
  assert.deepEqual(A.diffMarks('x', ''), []);
  assert.equal(A.sentences('pi는 3.14입니다. 끝').length, 2); // 소수점에서 끊지 않음
});
