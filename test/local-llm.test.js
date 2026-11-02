'use strict';
// 로컬 LLM 패널 (v0.16.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 주소는 이 PC(localhost · 127.0.0.1 · [::1])만 받는지
//   - 스트리밍 답(SSE)을 바르게 이어 붙이는지, 이미지는 OpenAI 형식으로 보내는지
//   - 서버가 꺼졌거나 거절하면 보내기 실패로 알리는지
//   - 웹 패널과 같은 답변 감시(watch) · 기록(rounds)으로 끝까지 동작하는지
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/shared/local-llm');
const { createRounds } = require('../src/shared/rounds');
const { watchAnswer } = require('../src/shared/watch');

test('주소: 이 PC의 http(s)만, 경로 · 계정은 버리고 바깥 주소는 거부', () => {
  assert.equal(L.normalizeBaseUrl('http://localhost:11434'), 'http://localhost:11434');
  assert.equal(L.normalizeBaseUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234');
  assert.equal(L.normalizeBaseUrl('https://[::1]:8080'), 'https://[::1]:8080');
  assert.equal(L.normalizeBaseUrl(' http://LOCALHOST:11434 '), 'http://localhost:11434');
  for (const bad of ['http://example.com', 'http://localhost.evil.com', 'http://192.168.0.10:11434', 'file:///c:/x', 'http://user:pw@localhost:11434', 'localhost:11434', '', null]) {
    assert.equal(L.normalizeBaseUrl(bad), null, String(bad));
  }
  assert.equal(L.cleanModel('llama3.2:3b'), 'llama3.2:3b');
  assert.equal(L.cleanModel('a b; rm -rf'), '');
  assert.equal(L.localService({ baseUrl: 'http://evil.com' }).url, L.DEFAULT_BASE); // 이상한 주소는 기본값으로
  assert.deepEqual(L.localService().upload.accept, ['image']);
});

test('SSE 읽기: 줄 단위로 글 조각을 모으고, 끝나지 않은 줄은 다음으로 넘긴다', () => {
  const a = L.parseSSE('data: {"choices":[{"delta":{"content":"안"}}]}\n\ndata: {"choices":[{"delta":{"content":"녕"}}]}\ndata: {"choi');
  assert.deepEqual(a.deltas, ['안', '녕']);
  assert.equal(a.done, false);
  assert.equal(a.rest, 'data: {"choi');
  const b = L.parseSSE(`${a.rest}ces":[{"delta":{"content":"!"}}]}\ndata: [DONE]\n`);
  assert.deepEqual(b.deltas, ['!']);
  assert.equal(b.done, true);
  assert.deepEqual(L.parseSSE(': keep-alive\ndata: not json\n\n').deltas, []);
});

/** 가짜 OpenAI 호환 서버: 조각을 하나씩 흘려보내는 SSE 응답 */
function fakeFetch({ chunks = ['안녕', '하세요'], status = 200, fail = null, delay = 5, models = ['llama3.2', 'qwen2.5'] } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (fail) throw new Error(fail);
    if (url.endsWith('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: models.map((id) => ({ id })) }) };
    if (status !== 200) return { ok: false, status, json: async () => ({ error: { message: 'model not found' } }) };
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => {
            await new Promise((r) => setTimeout(r, delay));
            if (i < chunks.length) return { value: enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`), done: false };
            if (i++ === chunks.length) return { value: enc.encode('data: [DONE]\n\n'), done: false };
            return { value: undefined, done: true };
          },
        }),
      },
    };
  };
  return { fn, calls };
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('대화: 보내면 스트리밍으로 이어 붙이고, 끝나면 멈춤 표시가 사라진다 (웹 패널과 같은 snapshot 모양)', async () => {
  const { fn, calls } = fakeFetch();
  const views = [];
  const chat = L.createLocalChat({ fetchFn: fn, getConfig: () => ({ baseUrl: 'http://localhost:11434', model: 'llama3.2' }), onUpdate: (v) => views.push(v) });
  assert.deepEqual(chat.snapshot(), { stop: false, count: 0, text: '', md: '' });
  const res = await chat.send('안녕?', ['data:image/png;base64,AAAA']);
  assert.deepEqual(res, { ok: true, via: 'local' });
  assert.equal(chat.snapshot().stop, true); // 답하는 중
  await until(() => !chat.snapshot().stop);
  assert.deepEqual(chat.snapshot(), { stop: false, count: 1, text: '안녕하세요', md: '안녕하세요' });
  const req = calls[0];
  assert.equal(req.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(req.body.model, 'llama3.2');
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.messages[0].content, [{ type: 'text', text: '안녕?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  // 두 번째 질문은 앞 대화를 함께 보낸다
  await chat.send('고마워');
  await until(() => !chat.snapshot().stop);
  assert.deepEqual(calls[1].body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(calls[1].body.messages[1].content, '안녕하세요');
  assert.equal(chat.snapshot().count, 2);
  assert.equal(views[views.length - 1].messages.length, 4);
  chat.reset();
  assert.equal(chat.snapshot().count, 0);
});

test('대화: 서버가 꺼졌거나 거절하거나 모델이 없으면 보내기 실패', async () => {
  const cfg = { baseUrl: 'http://localhost:11434', model: 'llama3.2' };
  const off = L.createLocalChat({ fetchFn: fakeFetch({ fail: 'ECONNREFUSED' }).fn, getConfig: () => cfg });
  const r1 = await off.send('q');
  assert.equal(r1.ok, false);
  assert.match(r1.error, /ECONNREFUSED/);
  assert.equal(off.snapshot().count, 0); // 실패한 질문은 대화에 남기지 않는다
  const r2 = await L.createLocalChat({ fetchFn: fakeFetch({ status: 404 }).fn, getConfig: () => cfg }).send('q');
  assert.match(r2.error, /HTTP 404 — model not found/);
  const r3 = await L.createLocalChat({ fetchFn: fakeFetch().fn, getConfig: () => ({ ...cfg, model: '' }) }).send('q');
  assert.match(r3.error, /모델을 고르세요/);
  const r4 = await L.createLocalChat({ fetchFn: fakeFetch().fn, getConfig: () => ({ ...cfg, baseUrl: 'http://example.com' }) }).send('q');
  assert.match(r4.error, /주소가 올바르지 않습니다/);
});

test('모델 목록: /v1/models, 바깥 주소는 묻지도 않는다', async () => {
  const { fn, calls } = fakeFetch({ models: ['llama3.2', 'bad name!', 'qwen2.5:7b'] });
  assert.deepEqual(await L.listModels(fn, 'http://127.0.0.1:11434'), ['llama3.2', 'qwen2.5:7b']);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/models');
  await assert.rejects(L.listModels(fn, 'http://example.com'), /이 PC/);
  assert.equal(calls.length, 1);
});

test('끝까지: 공통 입력창으로 보내면 답변 감시가 끝을 알아채고 기록에 답과 숫자를 남긴다 (웹 패널과 같은 길)', async () => {
  const { fn } = fakeFetch({ chunks: ['Python', '을 추천합니다.'], delay: 30 });
  const chat = L.createLocalChat({ fetchFn: fn, getConfig: () => ({ baseUrl: 'http://localhost:11434', model: 'llama3.2' }) });
  const saved = [];
  const states = [];
  const rounds = createRounds({
    services: [L.localService()],
    hasPanel: () => true,
    sendPrompt: (_id, text, files) => chat.send(text, files),
    snapshot: async () => chat.snapshot(),
    watch: (_id, before, isCurrent, onState) => watchAnswer(async () => chat.snapshot(), before, isCurrent, onState, { maxMs: 10000 }),
    sendPanel: (_id, p) => p.answer && states.push(p.answer),
    sendSynthStatus: () => {},
    history: { add: () => 'h', setAnswer: (_h, id, a) => saved.push([id, a]), addSynth: () => {} },
    prefs: () => ({ autoSynth: false }),
    log: () => {},
  });
  const [res] = await rounds.sendAll('첫 언어 추천?', ['local']);
  assert.equal(res.ok, true);
  await until(() => saved.length > 0, 8000);
  const [id, a] = saved[0];
  assert.equal(id, 'local');
  assert.equal(a.name, '로컬 LLM');
  assert.equal(a.state, 'done');
  assert.equal(a.text, 'Python을 추천합니다.');
  assert.equal(a.metrics.sendOk, true);
  assert.ok(Number.isFinite(a.metrics.doneMs));
  assert.ok(states.includes('answering') && states.includes('done'));
});
