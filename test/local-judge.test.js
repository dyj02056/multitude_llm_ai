'use strict';
// 로컬 LLM 판정 · 압축 · 컨텍스트 한도 (v0.29.0) 단위 테스트:  npm test
// [쉽게 말하면] 토큰 어림 · 종합 입력 줄이기 · 미리보기 경고 · 패널 없이 한 번 묻기(가짜 서버) · 패널 없는 로컬 LLM 종합 · 토론 판정 · 본체 연결을 봅니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SP = require('../src/shared/send-plan');
const L = require('../src/shared/local-llm');
const CH = require('../src/shared/chain');
const { createHistory } = require('../src/shared/history-core');
const { createRounds } = require('../src/shared/rounds');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('토큰 어림: 영문 4글자 ≈ 1, 한글 1글자 ≈ 1 · 한도 검사는 1/4을 답 자리로 남긴다', () => {
  assert.equal(SP.estimateTokens('abcdefgh'), 2);
  assert.equal(SP.estimateTokens('가나다'), 3);
  assert.equal(SP.estimateTokens('ab가'), 2);
  assert.equal(SP.estimateTokens(''), 0);
  const c = SP.contextCheck('x'.repeat(4 * 700), 1000);
  assert.deepEqual(c, { tokens: 700, limit: 1000, budget: 750, over: false });
  assert.equal(SP.contextCheck('가'.repeat(800), 1000).over, true);
  assert.equal(SP.contextCheck('가'.repeat(800), 0).over, false); // 한도 없음
  assert.equal(SP.cutToTokens('abcdefgh가나', 3), 'abcdefgh가');
});

test('종합 입력 줄이기: 들어가면 그대로, 넘으면 답변마다 같은 비율로 앞부분만 + 안내', () => {
  const answers = [{ name: 'A', text: '가'.repeat(3000) }, { name: 'B', text: '나'.repeat(1000) }];
  const same = SP.fitAnswers(answers, { limit: 100000, note: '(…)' });
  assert.equal(same.answers, answers);
  assert.deepEqual(same.trimmed, []);
  const r = SP.fitAnswers(answers, { limit: 2048, fixedText: '질문'.repeat(10), note: '(…일부)' });
  assert.deepEqual(r.trimmed, ['A', 'B']);
  const total = r.answers.reduce((n, a) => n + SP.estimateTokens(a.text), 0) + 20;
  assert.ok(total <= 2048 * 0.75, String(total));
  assert.ok(r.answers.every((a) => a.text.endsWith('(…일부)')));
  const lenA = r.answers[0].text.length;
  const lenB = r.answers[1].text.length;
  assert.ok(Math.abs(lenA / lenB - 3) < 0.2, `${lenA}/${lenB}`); // 같은 비율
  assert.deepEqual(SP.fitAnswers(answers, {}).trimmed, []); // 한도 없음
});

test('미리보기: 로컬 LLM 칸은 한도를 넘을 것 같으면 localCtx 경고', () => {
  const row = SP.previewRow({ id: 'local', text: '가'.repeat(7000), files: [], own: 0 }, { name: '로컬 LLM', contextTokens: 8192 });
  assert.deepEqual(row.warnings.map((w) => w.code), ['localCtx']);
  assert.equal(SP.previewRow({ id: 'local', text: '짧음', files: [], own: 0 }, { contextTokens: 8192 }).warnings.length, 0);
  assert.equal(SP.previewRow({ id: 'gemini', text: '가'.repeat(7000), files: [], own: 0 }, {}).warnings.length, 0);
});

test('컨텍스트 한도 설정 값: 고를 수 있는 값만, 아니면 8k', () => {
  assert.equal(L.normalizeContext(4096), 4096);
  assert.equal(L.normalizeContext('131072'), 131072);
  assert.equal(L.normalizeContext(5000), L.DEFAULT_CONTEXT);
  assert.equal(L.normalizeContext(undefined), 8192);
});

test('패널 없이 한 번 묻기: 질문 하나만 담은 임시 대화 · 스트리밍 없이 · 오류는 글로', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '판정 결과' } }] }) };
  };
  const cfg = () => ({ baseUrl: 'http://localhost:11434', model: 'qwen' });
  assert.deepEqual(await L.askOnce({ fetchFn, getConfig: cfg, text: '종합해 줘' }), { ok: true, text: '판정 결과' });
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.deepEqual(calls[0].body, { model: 'qwen', messages: [{ role: 'user', content: '종합해 줘' }], stream: false });
  assert.equal((await L.askOnce({ fetchFn, getConfig: () => ({ baseUrl: 'http://evil.com', model: 'q' }), text: 'x' })).ok, false);
  assert.equal(calls.length, 1); // 바깥 주소에는 보내지 않음
  assert.match((await L.askOnce({ fetchFn, getConfig: () => ({ baseUrl: 'http://localhost:1', model: '' }), text: 'x' })).error, /모델/);
  const bad = await L.askOnce({ fetchFn: async () => ({ ok: false, status: 500 }), getConfig: cfg, text: 'x' });
  assert.match(bad.error, /HTTP 500/);
  const down = await L.askOnce({ fetchFn: async () => { throw new Error('ECONNREFUSED'); }, getConfig: cfg, text: 'x' });
  assert.match(down.error, /연결하지 못했습니다/);
  const empty = await L.askOnce({ fetchFn: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ' ' } }] }) }), getConfig: cfg, text: 'x' });
  assert.equal(empty.ok, false);
});

function fakeRounds({ localOpen = false, limit = 2048, ask } = {}) {
  const answers = { a: '가'.repeat(3000), b: '나'.repeat(3000) };
  const synth = [];
  const asked = [];
  const history = createHistory(() => {});
  const ids = ['a', 'b', 'local'];
  const rounds = createRounds({
    services: ids.map((id) => ({ id, name: id === 'local' ? '로컬 LLM' : id.toUpperCase() })),
    hasPanel: (id) => (id === 'local' ? localOpen : true),
    sendPrompt: async (id, text) => {
      asked.push({ id, text, via: 'panel' });
      return { ok: true };
    },
    snapshot: async (id) => ({ stop: false, count: 1, text: answers[id] || '', md: answers[id] || '' }),
    watch: (id, _b, isCurrent, onState) => setTimeout(() => isCurrent() && onState('done', { chars: 10 }), 1),
    sendPanel: () => {},
    sendSynthStatus: (p) => synth.push(p),
    history,
    prefs: () => ({ synthTarget: 'local', autoSynth: false }),
    localJudge: {
      id: 'local',
      available: () => true,
      limit: () => limit,
      ask: ask || (async (text) => (asked.push({ id: 'local', text, via: 'headless' }), { ok: true, text: '## 결론\n로컬 판정' })),
    },
    log: () => {},
  });
  return { rounds, synth, asked, history };
}

test('패널 없는 로컬 LLM 종합: 임시 대화로 묻고, 답변은 한도에 맞춰 줄이고, 기록에 남기고 headless로 알린다', async () => {
  const f = fakeRounds();
  await f.rounds.sendAll('질문', ['a', 'b']);
  await new Promise((r) => setTimeout(r, 20));
  const res = await f.rounds.runSynth('local');
  assert.equal(res.ok, true);
  assert.equal(res.headless, true);
  const local = f.asked.find((x) => x.id === 'local');
  assert.equal(local.via, 'headless');
  assert.ok(SP.estimateTokens(local.text) <= 2048 * 0.75 + 50, String(SP.estimateTokens(local.text)));
  assert.ok(local.text.includes('일부만 보냄'));
  const done = f.synth.find((s) => s.state === 'done');
  assert.equal(done.headless, true);
  assert.ok(done.historyId);
  assert.deepEqual(done.trimmed, ['A', 'B']);
  const rec = f.history.get(done.historyId);
  assert.equal(rec.synth[0].md, '## 결론\n로컬 판정');
  // 분석도 같은 길: round.analysis로 남는다
  const an = await f.rounds.runSynth('local', 'manual', 'analysis');
  assert.equal(an.ok, true);
  assert.equal((await f.rounds.answers()).analysis.judge, '로컬 LLM');
});

test('로컬 LLM 패널이 열려 있으면 패널로 보내되 입력은 똑같이 줄인다 · 실패하면 error', async () => {
  const f = fakeRounds({ localOpen: true });
  await f.rounds.sendAll('질문', ['a', 'b']);
  await new Promise((r) => setTimeout(r, 20));
  await f.rounds.runSynth('local');
  const sent = f.asked.find((x) => x.id === 'local');
  assert.equal(sent.via, 'panel');
  assert.ok(sent.text.includes('일부만 보냄'));
  const g = fakeRounds({ ask: async () => ({ ok: false, error: '꺼짐' }) });
  await g.rounds.sendAll('질문', ['a', 'b']);
  await new Promise((r) => setTimeout(r, 20));
  const bad = await g.rounds.runSynth('local');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /꺼짐/);
});

test('토론 판정: 판정만 고를 수 있는 id(패널 없는 로컬 LLM)를 받는다 · 패널 없는 로컬이 판정이면 임시 대화로', async () => {
  const open = ['a', 'b'];
  assert.equal(CH.normalizeDebate({ participants: ['a', 'b'], judge: 'local' }, open, 'a', [...open, 'local']).judge, 'local');
  assert.equal(CH.normalizeDebate({ participants: ['a', 'local'], judge: 'local' }, open, 'a', [...open, 'local']).ok, false); // 참가는 열린 패널만
  assert.equal(CH.normalizeDebate({ participants: ['a', 'b'], judge: 'local' }, open, 'a').judge, 'a');
  const f = fakeRounds();
  await f.rounds.sendAll('질문', ['a', 'b']);
  await new Promise((r) => setTimeout(r, 20));
  const r = await f.rounds.startDebate({ participants: ['a', 'b'], rounds: 1, judge: 'local' });
  assert.equal(r.ok, true);
  await f.rounds.debateDone();
  const judge = f.asked.find((x) => x.id === 'local');
  assert.equal(judge.via, 'headless');
  assert.ok(f.synth.some((s) => s.mode === 'debate' && s.state === 'done'));
});

test('연결: 본체 · 확장의 localJudge · local:ask(글자 수 검사) · preload · 설정 화면 · 압축 대상', () => {
  const main = read('src/main/main.js');
  assert.match(main, /localJudge: \{ id: L\.LOCAL_ID/);
  assert.match(main, /contextTokens: L\.normalizeContext/);
  const settings = read('src/main/ipc/settings.js');
  assert.match(settings, /ipcMain\.handle\('local:ask'/);
  assert.match(settings, /text\.length > ASK_MAX/);
  assert.match(settings, /contextTokens: next\.contextTokens === undefined/);
  assert.match(read('src/preload/preload.js'), /ask: \(text\) => ipcRenderer\.invoke\('local:ask', text\)/);
  const host = read('extension/host.js');
  assert.match(host, /localJudge: \{ id: LL\.LOCAL_ID/);
  assert.match(host, /ask: async \(text\) => \(typeof text === 'string' && text\.trim\(\) && text\.length <= 200000/);
  assert.match(host, /contextTokens: LL\.normalizeContext/);
  const html = read('src/renderer/index.html');
  assert.ok(html.includes('id="localCtx"') && html.includes('id="synthResult"'));
  assert.match(read('src/renderer/library.js'), /compressLocal\(s, target\)/);
  assert.match(read('src/renderer/renderer-compose.js'), /function judgeChoices\(\)/);
  assert.match(read('src/renderer/debate-ui.js'), /judgeChoices\(\)/);
});
