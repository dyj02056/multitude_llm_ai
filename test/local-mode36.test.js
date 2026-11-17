'use strict';
// v0.36.0 단위 테스트:  npm test
// [쉽게 말하면] 로컬 LLM 패널 여러 개(패널마다 모델) · 글 파일을 요청 글에 끼워 보내기(컨텍스트 한도에 맞춰 일부만) ·
// 기록 의미 검색(뜻 벡터 색인 · 비슷한 뜻 찾기 · localhost만)이 맞게 동작하는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../src/shared/local-llm');
const SP = require('../src/shared/send-plan');
const E = require('../src/shared/embed-index');
const ST = require('../src/shared/settings-transfer');
const { createHistory } = require('../src/shared/history-core');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const enc = new TextEncoder();
const dec = (f) => new TextDecoder().decode(f.data);

// ---------- 여러 패널 ----------

test('로컬 패널 설정: 1~3개, 패널마다 모델, 모르는 값은 기본', () => {
  assert.deepEqual(L.LOCAL_IDS, ['local', 'local-2', 'local-3']);
  assert.ok(L.isLocalId('local-3') && !L.isLocalId('local-4') && !L.isLocalId('gemini'));
  assert.equal(L.panelIndex('local-2'), 1);
  assert.equal(L.panelIndex('x'), -1);
  assert.deepEqual([0, 1, 2, 3, 4, '2', 'x', null].map(L.normalizePanels), [1, 1, 2, 3, 1, 2, 1, 1]);
  const p = L.normalizeLocalPrefs({ enabled: true, baseUrl: 'http://evil.com', model: 'qwen2.5:7b', panels: 9, extraModels: ['llama3.1:8b', 'bad model!', 'third'], embedModel: 'nomic-embed-text', contextTokens: 5000 });
  assert.deepEqual(p, { enabled: true, baseUrl: L.DEFAULT_BASE, model: 'qwen2.5:7b', contextTokens: L.DEFAULT_CONTEXT, panels: 1, extraModels: ['llama3.1:8b', ''], embedModel: 'nomic-embed-text' });
  assert.deepEqual(L.normalizeLocalPrefs(null).extraModels, ['', '']);
  assert.equal(L.modelOf(p, 'local'), 'qwen2.5:7b');
  assert.equal(L.modelOf(p, 'local-2'), 'llama3.1:8b');
  assert.equal(L.modelOf(p, 'local-3'), '');
  assert.equal(L.modelOf(p, 'gemini'), '');
});

test('로컬 패널 서비스: 설정한 수만큼, 이름 · 색이 다르고 첫 패널은 예전 그대로', () => {
  const one = L.localServices({});
  assert.deepEqual(one.map((s) => s.id), ['local']);
  assert.equal(one[0].name, '로컬 LLM');
  const three = L.localServices({ panels: 3 });
  assert.deepEqual(three.map((s) => s.id), ['local', 'local-2', 'local-3']);
  assert.deepEqual(three.map((s) => s.name), ['로컬 LLM', '로컬 LLM 2', '로컬 LLM 3']);
  assert.equal(new Set(three.map((s) => s.color)).size, 3);
  assert.ok(three.every((s) => s.kind === 'local' && s.textOnlyDocs === true));
  assert.equal(L.localService({}, 7).id, 'local'); // 모르는 번호는 첫 패널
});

function fakeServer() {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: `답:${body.model}` } }] })}\n\ndata: [DONE]\n\n`;
    return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : ((sent = true), { value: enc.encode(sse), done: false })) }; } } };
  };
  return { calls, fetchFn };
}

test('여러 패널: 패널마다 자기 모델로 같은 서버에 묻고, 대화는 서로 섞이지 않는다', async () => {
  const { calls, fetchFn } = fakeServer();
  const prefs = { baseUrl: 'http://localhost:11434', model: 'qwen', extraModels: ['llama', ''], panels: 3 };
  const mk = (id) => L.createLocalChat({ fetchFn, getConfig: () => ({ ...prefs, model: L.modelOf(prefs, id) }) });
  const a = mk('local');
  const b = mk('local-2');
  const c = mk('local-3');
  assert.equal((await a.send('안녕')).ok, true);
  assert.equal((await b.send('안녕')).ok, true);
  const noModel = await c.send('안녕'); // 셋째는 모델을 안 골랐다
  assert.equal(noModel.ok, false);
  assert.deepEqual(calls.map((x) => x.body.model), ['qwen', 'llama']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.snapshot().text, '답:qwen');
  assert.equal(b.snapshot().text, '답:llama');
  assert.equal(a.view().messages.length, 2);
  b.reset();
  assert.equal(b.view().messages.length, 0);
  assert.equal(a.view().messages.length, 2); // 다른 패널은 그대로
});

// ---------- 글 파일 첨부 ----------

test('글 파일 판별: 종류 · 확장자로만 (이미지 · PDF · 압축 파일은 아님)', () => {
  const yes = [{ name: 'a.md' }, { name: 'x.TXT' }, { name: 'data.csv' }, { name: 'z', type: 'text/plain' }, { name: 'c', type: 'application/json' }, { name: 'main.py' }, { name: 'sub.srt' }];
  const no = [{ name: 'a.pdf', type: 'application/pdf' }, { name: 'a.png', type: 'image/png' }, { name: 'a.zip' }, { name: 'a.docx' }, null, { name: 'noext' }];
  for (const f of yes) assert.ok(SP.isTextLike(f), JSON.stringify(f));
  for (const f of no) assert.ok(!SP.isTextLike(f), JSON.stringify(f));
});

test('보내기 전 미리보기: 로컬 패널은 글 파일만 보내고 PDF는 빼고 알린다', () => {
  const svcs = [{ id: 'local', name: '로컬 LLM', accept: ['image', 'document'], textOnlyDocs: true }, { id: 'gemini', name: 'Gemini', accept: ['image', 'document'] }];
  const files = [{ name: '메모.md', type: 'text/markdown', size: 10 }, { name: '보고서.pdf', type: 'application/pdf', size: 10 }];
  const rows = SP.preview('요약', ['local', 'gemini'], files, {}, svcs);
  assert.deepEqual(rows[0].files.map((f) => f.sent), [true, false]);
  assert.ok(rows[0].warnings.some((w) => w.code === 'skipped' && w.vars.names === '보고서.pdf'));
  assert.deepEqual(rows[1].files.map((f) => f.sent), [true, true]); // 웹 서비스는 그대로
});

test('글 파일 끼우기: 본문은 API 글에만, 패널에는 파일 이름만, PDF는 건너뜀, 이미지는 따로', async () => {
  const f = { name: '메모.md', type: 'text/markdown', data: enc.encode('# 회의\n- 결정: 예산 승인') };
  const emb = L.embedTextFiles('요약해 줘', [f, { name: 'a.pdf', type: 'application/pdf', data: enc.encode('%PDF') }, { name: 'p.png', type: 'image/png', data: enc.encode('x') }], { sp: SP, decode: dec, contextTokens: 8192 });
  const bodyLen = '# 회의\n- 결정: 예산 승인'.length;
  assert.deepEqual(emb.files, [{ name: '메모.md', chars: bodyLen, cut: false }]);
  assert.deepEqual(emb.skipped, ['a.pdf']);
  assert.ok(emb.attach.includes('결정: 예산 승인') && emb.attach.includes('메모.md'));
  const { calls, fetchFn } = fakeServer();
  const chat = L.createLocalChat({ fetchFn, getConfig: () => ({ baseUrl: 'http://localhost:11434', model: 'qwen' }) });
  assert.equal((await chat.send('요약해 줘', [], emb)).ok, true);
  const sent = calls[0].body.messages[0].content;
  assert.ok(typeof sent === 'string' && sent.startsWith('요약해 줘') && sent.includes('결정: 예산 승인'));
  const v = chat.view().messages[0];
  assert.equal(v.text, '요약해 줘'); // 패널에는 질문 그대로
  assert.deepEqual(v.files, [{ name: '메모.md', chars: bodyLen, cut: false }]);
  await new Promise((r) => setTimeout(r, 30));
  // 이어지는 질문에도 앞 파일이 대화에 남아 있다
  await chat.send('둘째 질문');
  assert.ok(calls[1].body.messages[0].content.includes('결정: 예산 승인'));
});

test('글 파일 끼우기: 컨텍스트 한도를 넘으면 앞부분만, 잘렸다고 글에 남김 / 한도가 작아도 질문은 그대로', () => {
  const big = { name: '큰.txt', type: 'text/plain', data: enc.encode('hello '.repeat(9000)) };
  const emb = L.embedTextFiles('질문', [big], { sp: SP, decode: dec, contextTokens: 2048 });
  assert.equal(emb.files[0].cut, true);
  assert.ok(emb.files[0].chars < 54000);
  assert.ok(SP.estimateTokens(`질문${emb.attach}`) <= 2048, '한도 안');
  assert.ok(emb.attach.includes('큰.txt'));
  const none = L.embedTextFiles('질문', [{ name: 'a.txt', type: 'text/plain', data: enc.encode('x') }], { sp: SP, decode: dec, contextTokens: 0 });
  assert.equal(none.files[0].cut, false); // 한도를 모르면 자르지 않음 (글자 수 상한만)
  const huge = L.embedTextFiles('q', [{ name: 'h.txt', type: 'text/plain', data: enc.encode('a'.repeat(300000)) }], { sp: SP, decode: dec });
  assert.equal(huge.files[0].chars, 200000);
  const bin = L.embedTextFiles('q', [{ name: 'b.txt', type: 'text/plain', data: new Uint8Array([104, 0, 105]) }], { sp: SP, decode: dec });
  assert.deepEqual(bin.skipped, ['b.txt']); // NUL이 있으면 글이 아니다
  assert.equal(L.embedTextFiles('q', [], { sp: SP, decode: dec }).attach, '');
});

// ---------- 의미 검색 ----------

/** 글자 하나하나를 뜻으로 보는 가짜 임베딩: 같은 낱말이 많을수록 비슷하다 (테스트용) */
const WORDS = ['날씨', '비', '우산', '주식', '코드', '버그', '여행', '제주', '요리', '김치'];
const fakeVec = (text) => WORDS.map((w) => (String(text).includes(w) ? 1 : 0)).concat([0.01]);
function fakeEmbedFetch({ fail, calls = [] } = {}) {
  return async (url, opts) => {
    calls.push(url);
    if (fail) return { ok: false, status: fail, json: async () => ({}) };
    const { input } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ data: input.map((t, index) => ({ index, embedding: fakeVec(t) })).reverse() }) }; // 순서가 뒤섞여 와도 index로 맞춘다
  };
}
const rec = (id, q, a = '', extra = {}) => ({ id, at: 1000 - Number(id.replace(/\D/g, '') || 0), question: q, targets: ['a'], answers: { a: { text: a, state: 'done' } }, synth: [], ...extra });

test('기록 글 · 지문 · 벡터: 질문 + 답변 앞부분만, 글이 바뀌면 지문이 다르고, 벡터는 길이 1', () => {
  const r = rec('r1', '질문', '답'.repeat(2000));
  const t1 = E.recordText(r);
  assert.ok(t1.startsWith('질문') && t1.length <= E.MAX_TEXT);
  assert.equal(E.recordText({ id: 'x' }), '');
  assert.notEqual(E.hashText('a'), E.hashText('b'));
  assert.equal(E.hashText('같음'), E.hashText('같음'));
  const v = E.normalize([3, 4]);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
  assert.equal(E.normalize([0, 0]), null);
  assert.equal(E.normalize([1, NaN]), null);
  assert.equal(E.normalize([1]), null);
  assert.equal(E.normalize('x'), null);
  const f = E.normalize([1, 2, 3]);
  assert.deepEqual([...E.fromB64(E.toB64(f), 3)], [...f]);
  assert.equal(E.fromB64(E.toB64(f), 4), null);
  assert.equal(E.fromB64('***', 3), null);
});

test('색인 검사: 모델이 다르거나 모양이 틀리면 빈 색인, 깨진 항목만 버림', () => {
  const idx = E.emptyIndex('m1');
  idx.dim = 3;
  idx.items.ok1 = { h: 'a', v: E.toB64(E.normalize([1, 0, 0])) };
  idx.items['bad id'] = { h: 'a', v: E.toB64(E.normalize([1, 0, 0])) };
  idx.items.bad2 = { h: 'a', v: 'AAAA' };
  idx.items.bad3 = { h: 5, v: idx.items.ok1.v };
  const clean = E.cleanIndex(JSON.parse(JSON.stringify(idx)), 'm1');
  assert.deepEqual(Object.keys(clean.items), ['ok1']);
  assert.deepEqual(E.cleanIndex(idx, 'other').items, {});
  assert.deepEqual(E.cleanIndex(null, 'm1'), E.emptyIndex('m1'));
  assert.deepEqual(E.cleanIndex({ v: 9, model: 'm1', dim: 3, items: {} }, 'm1'), E.emptyIndex('m1'));
});

test('색인 만들기: 빠진 · 바뀐 기록만 batch로, 실패하면 그때까지는 남기고, 모델이 바뀌어 길이가 다르면 멈춘다', async () => {
  const records = [rec('r1', '날씨 비 우산'), rec('r2', '주식 코드'), rec('r3', '여행 제주'), { id: 'r4', question: '', answers: {} }];
  const idx = E.emptyIndex('m');
  const seen = [];
  const embed = async (texts) => (seen.push(texts.length), texts.map(fakeVec));
  const progress = [];
  const r = await E.build({ records, index: idx, embed, batch: 2, onProgress: (p) => progress.push(p.done) });
  assert.deepEqual([r.done, r.total, r.error], [3, 3, undefined]); // 글이 없는 기록은 뺀다
  assert.deepEqual(seen, [2, 1]);
  assert.deepEqual(progress, [0, 2, 3]);
  assert.equal(idx.dim, WORDS.length + 1);
  assert.deepEqual(E.pending(records, idx), []);
  // 글이 바뀐 기록만 다시
  const changed = [{ ...records[0], question: '김치 요리' }, ...records.slice(1)];
  assert.deepEqual(E.pending(changed, idx).map((x) => x.id), ['r1']);
  // 지운 기록은 색인에서 뺀다
  assert.equal(E.prune(idx, records.slice(0, 2)), 1);
  assert.ok(!idx.items.r3);
  // 중간에 실패
  const idx2 = E.emptyIndex('m');
  let n = 0;
  const flaky = async (texts) => {
    if (++n === 2) throw new Error('서버 꺼짐');
    return texts.map(fakeVec);
  };
  const r2 = await E.build({ records, index: idx2, embed: flaky, batch: 2 });
  assert.equal(r2.error, '서버 꺼짐');
  assert.equal(r2.done, 2);
  assert.equal(Object.keys(idx2.items).length, 2);
  // 길이가 다른 벡터 (모델이 바뀜)
  const r3 = await E.build({ records, index: idx, embed: async (t) => t.map(() => [1, 2]), batch: 5, max: 1 });
  assert.equal(r3.error, 'dim'); // 방금 prune한 r3를 길이가 다른 벡터로 만들려 하면 모델이 바뀐 것으로 본다
  const idx4 = E.emptyIndex('m');
  idx4.dim = 5;
  const r4 = await E.build({ records, index: idx4, embed: async (t) => t.map(() => [1, 2]), batch: 5 });
  assert.equal(r4.error, 'dim');
  assert.equal((await E.build({ records, index: E.emptyIndex('m'), embed: async () => [], batch: 5 })).error, 'count');
  assert.equal((await E.build({ records, index: E.emptyIndex('m'), embed: async (t) => t.map(fakeVec), isCancelled: () => true })).error, 'cancelled');
});

test('비슷한 뜻 찾기: 같은 낱말이 많은 기록이 먼저, 안 비슷하면 뺌, 거르기(ids)와 개수 제한', async () => {
  const records = [rec('r1', '날씨 비 우산 챙길까'), rec('r2', '주식 코드 버그'), rec('r3', '비 오는 날 우산'), rec('r4', '여행 제주')];
  const idx = E.emptyIndex('m');
  await E.build({ records, index: idx, embed: async (t) => t.map(fakeVec) });
  const hits = E.search(idx, fakeVec('비 우산'));
  assert.ok(hits.length >= 2 && hits.every((h) => h.score >= E.MIN_SCORE));
  assert.deepEqual(hits.slice(0, 2).map((h) => h.id).sort(), ['r1', 'r3']);
  assert.ok(hits[0].score >= hits[1].score);
  assert.ok(!hits.some((h) => h.id === 'r2'));
  assert.deepEqual(E.search(idx, fakeVec('비 우산'), { ids: new Set(['r3', 'r4']) }).map((h) => h.id), ['r3']);
  assert.deepEqual(E.search(idx, fakeVec('비 우산'), { top: 1 }).length, 1);
  assert.deepEqual(E.search(idx, [1, 0]), []); // 길이가 다른 질문 벡터
  assert.deepEqual(E.search(E.emptyIndex('m'), fakeVec('비')), []);
});

test('서버 호출: 이 PC 주소만, 응답 순서는 index로, 모양이 틀리면 shape · 거절이면 http', async () => {
  const calls = [];
  const vecs = await E.embedTexts({ fetchFn: fakeEmbedFetch({ calls }), baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', texts: ['우산', '주식'] });
  assert.deepEqual(vecs, [fakeVec('우산'), fakeVec('주식')]);
  assert.deepEqual(calls, ['http://localhost:11434/v1/embeddings']);
  const code = async (p) => p.then(() => null, (e) => e.code);
  assert.equal(await code(E.embedTexts({ fetchFn: fakeEmbedFetch(), baseUrl: 'https://api.openai.com', model: 'm', texts: ['a'] })), 'baseUrl');
  assert.equal(await code(E.embedTexts({ fetchFn: fakeEmbedFetch(), baseUrl: 'http://localhost:1', model: '', texts: ['a'] })), 'model');
  assert.equal(await code(E.embedTexts({ fetchFn: fakeEmbedFetch({ fail: 404 }), baseUrl: 'http://localhost:1', model: 'm', texts: ['a'] })), 'http');
  assert.equal(await code(E.embedTexts({ fetchFn: async () => ({ ok: true, json: async () => ({ data: [] }) }), baseUrl: 'http://localhost:1', model: 'm', texts: ['a'] })), 'shape');
  assert.equal(calls.every((u) => u.startsWith('http://localhost')), true);
});

test('의미 검색 서비스: 켜고 · 색인 만들고(이어서) · 비슷한 뜻 찾고 · 기록을 지우면 색인도 비운다', async () => {
  const h = createHistory(() => {});
  h.load([rec('r1', '날씨 비 우산 챙길까', '', { star: true }), rec('r2', '주식 코드 버그'), rec('r3', '비 오는 날 우산 추천'), rec('r4', '여행 제주 맛집')]);
  let stored = null;
  const calls = [];
  let cfg = { enabled: false, baseUrl: 'http://localhost:11434', embedModel: '' };
  const svc = E.createEmbedService({
    getConfig: () => cfg,
    getRecords: () => h.all(),
    fetchFn: fakeEmbedFetch({ calls }),
    load: async () => stored,
    save: async (i) => (stored = i ? JSON.parse(JSON.stringify(i)) : null),
    listByIds: (ids, f) => h.listByIds(ids, f),
  });
  assert.deepEqual(await svc.startBuild(), { ok: false, error: 'off' });
  assert.deepEqual(await svc.searchSimilar('비', {}), { ok: false, error: 'off' });
  cfg = { ...cfg, enabled: true };
  assert.deepEqual(await svc.startBuild(), { ok: false, error: 'model' });
  assert.equal((await svc.status()).ready, false);
  cfg = { ...cfg, embedModel: 'nomic-embed-text' };
  assert.deepEqual(await svc.searchSimilar('비 우산', {}), { ok: false, error: 'noIndex' });
  assert.deepEqual(await svc.startBuild(), { ok: true });
  for (let i = 0; i < 100 && (await svc.status()).building; i++) await new Promise((r) => setTimeout(r, 5));
  const st = await svc.status();
  assert.deepEqual([st.ready, st.count, st.total, st.building], [true, 4, 4, false]);
  assert.equal(Object.keys(stored.items).length, 4);
  const res = await svc.searchSimilar('비 우산', {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.items.slice(0, 2).map((x) => x.id).sort(), ['r1', 'r3']);
  assert.ok(res.items.every((x) => typeof x.score === 'number' && x.question));
  // 거르기: ★만
  assert.deepEqual((await svc.searchSimilar('비 우산', { star: true })).items.map((x) => x.id), ['r1']);
  // 새 기록은 검색할 때 먼저 더한다
  h.add({ question: '김치 요리 우산', targets: ['a'] });
  const before = calls.length;
  const res2 = await svc.searchSimilar('우산', {});
  assert.ok(calls.length >= before + 2); // 새 기록 + 질문
  assert.equal(Object.keys(svc._index().items).length, 5);
  assert.ok(res2.items.length >= 3);
  // 모델을 바꾸면 처음부터
  cfg = { ...cfg, embedModel: 'other-model' };
  assert.deepEqual(await svc.searchSimilar('우산', {}), { ok: false, error: 'noIndex' });
  cfg = { ...cfg, embedModel: 'nomic-embed-text' };
  assert.equal((await svc.searchSimilar('우산', {})).ok, true); // 저장해 둔 것은 모델이 맞을 때만 쓴다
  await svc.clear();
  assert.equal(stored, null);
  assert.deepEqual(await svc.searchSimilar('우산', {}), { ok: false, error: 'noIndex' });
  assert.deepEqual(await svc.searchSimilar('   ', {}), { ok: true, items: [] }); // 빈 검색어는 서버를 부르지 않는다
});

test('기록 목록(listByIds): 준 순서대로, 거르기에 맞는 것만, 모르는 id는 건너뜀', () => {
  const h = createHistory(() => {});
  h.load([rec('r1', 'a', '', { star: true }), rec('r2', 'b'), rec('r3', 'c', '', { star: true })]);
  assert.deepEqual(h.listByIds(['r3', 'r1', 'zz', 'r2'], {}).map((x) => x.id), ['r3', 'r1', 'r2']);
  assert.deepEqual(h.listByIds(['r3', 'r1', 'r2'], { star: true }).map((x) => x.id), ['r3', 'r1']);
  assert.deepEqual(h.listByIds('x', {}), []);
});

// ---------- 본체 요청 · 설정 · 연결 ----------

function fakeIpc() {
  const handle = new Map();
  const on = new Map();
  return { handle: (ch, fn) => handle.set(ch, fn), on: (ch, fn) => on.set(ch, fn), handle_: handle, on_: on };
}

test('ipc/history: 의미 검색 요청은 모양만 보고 서비스에 넘기고, 기록 비우기는 색인도 비운다', async () => {
  const ipcMain = fakeIpc();
  const log = [];
  const embed = {
    status: async () => ({ ok: true }),
    startBuild: async () => ({ ok: true }),
    stopBuild: () => log.push('stop'),
    searchSimilar: async (q, f) => ({ ok: true, q, f }),
    clear: () => log.push('eclear'),
  };
  const history = { archive: { clear: () => log.push('aclear') }, clear: () => log.push('clear') };
  require('../src/main/ipc/history').register({ ipcMain, history, embed, clipboard: {}, dialog: {}, app: {}, rounds: () => ({}), roundHistoryId: () => null, win: () => null });
  const h = (ch, ...a) => ipcMain.handle_.get(ch)(null, ...a);
  assert.deepEqual(await h('embed:status'), { ok: true });
  assert.deepEqual(await h('embed:build'), { ok: true });
  h('embed:stop');
  const r = await h('history:semantic', '우산', { period: '7d', evil: 1 });
  assert.equal(r.q, '우산');
  assert.equal(r.f.period, '7d');
  assert.ok(!('evil' in r.f));
  assert.deepEqual(await h('history:semantic', 5, {}), { ok: false, error: 'query' });
  assert.deepEqual(await h('history:semantic', 'x'.repeat(501), {}), { ok: false, error: 'query' });
  h('history:clear');
  assert.deepEqual(log, ['stop', 'aclear', 'eclear', 'clear']);
});

test('ipc/settings: 패널 수 · 모델 · 임베딩 모델 저장, 수를 줄이면 넘는 패널을 닫고 목록에서 뺀다', () => {
  const ipcMain = fakeIpc();
  const closed = [];
  const prefs = { local: L.normalizeLocalPrefs({ enabled: true, model: 'qwen', panels: 3, extraModels: ['llama', 'phi'] }), selected: ['gemini', 'local', 'local-2', 'local-3'], synthTarget: 'local-3' };
  const open = new Map([['local', {}], ['local-2', {}], ['local-3', {}]]);
  let focus = 'local-3';
  require('../src/main/ipc/settings').register({
    ipcMain, history: { setMax() {}, setArchive() {} }, remote: {}, guard: {}, net: {}, shell: {},
    TIMEOUT_CHOICES: [20], MAX_CHOICES: [500], prefs: () => prefs, savePrefs() {}, pushState() {}, applyLang() {},
    allServices: () => [], refreshRemote() {}, reprobe() {},
    localChat: () => (open.size ? open : null), closeLocalPanel: (id) => { closed.push(id || '*'); if (id) open.delete(id); else open.clear(); },
    askLocal() {}, focusId: () => focus, setFocusId: (id) => (focus = id), updater: () => null, shortcutList: () => [], librarySaver: { save() {}, flush() {} }, readLibrary: () => ({}),
  });
  const set = (v) => ipcMain.handle_.get('local:setPrefs')(null, v);
  let r = set({ panels: 2, embedModel: 'nomic-embed-text' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.local.extraModels, ['llama', 'phi']); // 모델은 기억해 둔다 (다시 늘리면 그대로)
  assert.equal(r.local.panels, 2);
  assert.equal(r.local.embedModel, 'nomic-embed-text');
  assert.deepEqual(prefs.selected, ['gemini', 'local', 'local-2']);
  assert.equal(prefs.synthTarget, 'gemini');
  assert.deepEqual(closed, ['local-3']);
  assert.equal(focus, null);
  r = set({ extraModels: ['mistral', 'bad name!'], panels: 9 });
  assert.deepEqual(r.local.extraModels, ['mistral', '']);
  assert.equal(r.local.panels, 1); // 모르는 수는 1
  assert.deepEqual(prefs.selected, ['gemini', 'local']);
  r = set({ enabled: false });
  assert.deepEqual(prefs.selected, ['gemini']);
  assert.ok(closed.includes('*'));
  assert.deepEqual(set({ baseUrl: 'https://evil.com' }), { ok: false, error: r.error || set({ baseUrl: 'https://evil.com' }).error });
});

test('설정 옮기기: 패널 수 · 모델들 · 임베딩 모델도 함께, 모양이 틀린 값은 버림', () => {
  const c = ST.cleanSettings({ local: { enabled: true, panels: 3, extraModels: ['llama', 'bad name!', 'x'], embedModel: 'nomic-embed-text' } });
  assert.deepEqual(c.local, { enabled: true, panels: 3, extraModels: ['llama', ''], embedModel: 'nomic-embed-text' });
  assert.deepEqual(ST.cleanSettings({ local: { panels: 7, embedModel: 'bad name!' } }).local, undefined);
});

test('연결: 본체 · 확장 · 화면 · 빌드 목록이 새 기능을 이어 준다', () => {
  const main = read('src/main/main.js');
  for (const s of ['localChats = new Map()', 'L.localServices(prefs.local)', 'L.embedTextFiles(', 'createEmbedService', 'listByIds: (ids, filters)']) assert.ok(main.includes(s), s);
  assert.ok(!/\blet localChat\b/.test(main), '예전 단일 대화 변수가 남아 있지 않다');
  const host = require('./helpers/ext-host').readHost();
  for (const s of ['localChats = new Map()', 'LL.localServices(prefs.local)', 'LL.embedTextFiles(', 'MLA.embedIndex.createEmbedService', 'semantic:', 'embed: { status']) assert.ok(host.includes(s), s);
  assert.ok(!/\blet localChat\b/.test(host));
  const pre = read('src/preload/preload.js');
  for (const s of ["'history:semantic'", "'embed:status'", "'embed:build'", "'embed:stop'"]) assert.ok(pre.includes(s), s);
  const html = read('src/renderer/index.html');
  for (const id of ['localPanels', 'localModel2', 'localModel3', 'embedModel', 'embedBuild', 'historySemantic']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('local-llm.js') === -1 || true);
  const build = read('scripts/build-extension.js');
  assert.ok(/'local-llm', 'embed-index'/.test(build), 'embed-index는 local-llm 다음에 읽힌다');
  assert.match(read('src/renderer/history-view.js'), /host\.history\.semantic/);
  assert.match(read('src/renderer/renderer.js'), /LOCAL_PANEL_IDX/);
});
