'use strict';
// v0.27.0 기록 찾기 단위 테스트:  npm test
// [쉽게 말하면] 기록 거르기(기간 · AI · 평가 · 보낸 곳 · 프로젝트 · 종합/분석/이어 묻기 · 태그 · 즐겨찾기) + 글 찾기,
// 태그 다듬기, 대화 줄기로 묶기, 기록장의 태그 · 별표 · 줄기 · 저장 표시, 여러 기록 내보내기, 본체 IPC · 확장 host의 검사를 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const HS = require('../src/shared/history-search');
const EX = require('../src/shared/export');
const { createHistory, cleanProject } = require('../src/shared/history-core');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 15, 15, 0, 0).getTime(); // 2026-11-15 15:00 (이 PC 시간대)

/** 예전 모양 기록 (새 칸 없음) + 새 칸이 있는 기록 */
function sample() {
  return [
    { id: 'r1', at: NOW - 60e3, question: '오늘 질문 React', targets: ['a', 'b'], files: [], answers: { a: { text: 'useEffect 설명', state: 'done' } }, synth: [], star: true, tags: ['프론트'], threadId: 't1' },
    { id: 'r2', at: NOW - 2 * DAY, question: 'SQL 느림', targets: ['b'], files: [{ name: 'plan.txt' }], answers: {}, synth: [{ mode: 'analysis', text: 'x' }], feedback: { b: -1 }, threadId: 't1' },
    { id: 'r3', at: NOW - 10 * DAY, question: '여행 일정', targets: ['c'], files: [], answers: {}, synth: [{ text: '종합 글' }], feedback: { c: 1 }, source: 'side' },
    { id: 'r4', at: NOW - 40 * DAY, question: '프로젝트 리팩터링', targets: ['a'], files: [], answers: {}, synth: [], project: { name: 'app' }, chain: [{ kind: 'handoff', text: '이어 받은 답 KEYWORD' }] },
    { id: 'old', at: NOW - 100 * DAY, question: '아주 예전', targets: ['a'], files: [], answers: { a: { text: 'old', state: 'done' } }, synth: [] }, // 예전 기록
  ];
}
const ids = (xs) => xs.map((r) => r.id);

test('filterRecords: 기간 (오늘 · 7일 · 30일 · 날짜 지정, 끝 날짜는 그날 끝까지)', () => {
  const recs = sample();
  assert.deepEqual(ids(HS.filterRecords(recs, '', { period: 'today' }, NOW)), ['r1']);
  assert.deepEqual(ids(HS.filterRecords(recs, '', { period: '7d' }, NOW)), ['r1', 'r2']);
  assert.deepEqual(ids(HS.filterRecords(recs, '', { period: '30d' }, NOW)), ['r1', 'r2', 'r3']);
  const d = (ms) => {
    const x = new Date(ms);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  assert.deepEqual(ids(HS.filterRecords(recs, '', { period: 'range', from: d(NOW - 40 * DAY), to: d(NOW - 10 * DAY) }, NOW)), ['r3', 'r4']);
  assert.deepEqual(ids(HS.filterRecords(recs, '', { period: 'range', from: 'nope', to: '' }, NOW)), ids(recs)); // 잘못된 날짜는 무시
  assert.deepEqual(ids(HS.filterRecords(recs, '', { period: 'weird' }, NOW)), ids(recs));
});

test('filterRecords: AI(하나라도) · 평가 · 보낸 곳 · 프로젝트 · 종합/분석/이어 묻기 · 태그 · 즐겨찾기, 글 찾기와 함께', () => {
  const recs = sample();
  const f = (filters, q = '') => ids(HS.filterRecords(recs, q, filters, NOW));
  assert.deepEqual(f({ services: ['b', 'zz'] }), ['r1', 'r2']);
  assert.deepEqual(f({ rating: 'good' }), ['r3']);
  assert.deepEqual(f({ rating: 'bad' }), ['r2']);
  assert.deepEqual(f({ rating: 'none' }), ['r1', 'r4', 'old']);
  assert.deepEqual(f({ source: 'side' }), ['r3']);
  assert.deepEqual(f({ source: 'app' }), ['r1', 'r2', 'r4', 'old']);
  assert.deepEqual(f({ project: true }), ['r4']);
  assert.deepEqual(f({ has: ['analysis'] }), ['r2']);
  assert.deepEqual(f({ has: ['synth'] }), ['r3']);
  assert.deepEqual(f({ has: ['chain'] }), ['r4']);
  assert.deepEqual(f({ tag: '프론트' }), ['r1']);
  assert.deepEqual(f({ star: true }), ['r1']);
  assert.deepEqual(f({}, 'keyword'), ['r4']); // 이어 묻기 글
  assert.deepEqual(f({}, 'PLAN.TXT'), ['r2']); // 첨부 이름, 대소문자 무시
  assert.deepEqual(f({}, '프론트'), ['r1']); // 태그 글도 찾는다
  assert.deepEqual(f({ services: ['a'], period: '7d' }, 'useeffect'), ['r1']);
  assert.deepEqual(f({ services: ['a'], period: '7d' }, '없는 말'), []);
  // 깨진 기록 · 깨진 칸이 있어도 멈추지 않는다
  assert.deepEqual(ids(HS.filterRecords([null, 'x', { id: 'z', at: NOW, question: null, answers: null, synth: 'x', feedback: [1] }], 'a', { rating: 'none' }, NOW)), []);
});

test('cleanFilters: 아는 칸 · 아는 값만, activeCount는 켠 것 수', () => {
  const c = HS.cleanFilters({ period: 'range', from: '2026-01-02', to: '2026-13-40', services: ['a', 'a', 'bad id!', 3], rating: 'x', source: 'side', project: 'yes', has: ['chain', 'evil'], tag: '  t  ', star: true, extra: 1 });
  assert.deepEqual(c, { period: 'range', from: '2026-01-02', to: '', services: ['a'], rating: '', source: 'side', project: false, has: ['chain'], tag: 't', star: true });
  assert.equal(HS.activeCount(c), 6);
  assert.equal(HS.activeCount(null), 0);
  assert.equal(HS.cleanFilters({ period: '7d', from: '2026-01-02' }).from, ''); // 날짜는 날짜 지정일 때만
});

test('cleanTags: 다듬기 · 30자 · 겹침(대소문자 무시) · 10개 · 쉼표 글', () => {
  assert.deepEqual(HS.cleanTags(['  a  b ', 'A  B', '', 7, 'x'.repeat(40)]), ['a b', 'x'.repeat(30)]);
  assert.deepEqual(HS.cleanTags('one, two,,one'), ['one', 'two']);
  assert.equal(HS.cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 10);
  assert.deepEqual(HS.cleanTags(null), []);
  assert.deepEqual(HS.cleanTags(['a\u0000b']), ['a b']);
});

test('groupThreads: 같은 threadId끼리, 예전 기록은 혼자, 가장 최근 순', () => {
  const g = HS.groupThreads([
    { id: 'r1', at: 5, threadId: 't1' },
    { id: 'r9', at: 9 },
    { id: 'r2', at: 3, threadId: 't1' },
    null,
  ]);
  assert.deepEqual(g.map((x) => [x.key, x.items.map((i) => i.id), x.at]), [['r:r9', ['r9'], 9], ['t:t1', ['r1', 'r2'], 5]]);
  assert.equal(g[1].threadId, 't1');
  assert.equal(g[0].threadId, null);
});

test('tagCounts: 많은 순, 대소문자 다른 같은 태그는 하나로', () => {
  assert.deepEqual(HS.tagCounts([{ tags: ['b', 'A'] }, { tags: ['a'] }, { tags: 'x' }, null]), [{ tag: 'A', n: 2 }, { tag: 'b', n: 1 }]);
});

test('기록장: 태그 · 별표 · 줄기 · 종류 · 프로젝트 — 검사하고 그 기록만 저장 표시(dirty), 예전 기록도 목록 · 통계 · 내보내기', async () => {
  const saves = [];
  const h = createHistory((records, info) => saves.push(info));
  h.load(sample());
  // 목록 요약에 새 칸
  const li = h.list('', { star: true });
  assert.equal(li.length, 1);
  assert.equal(li[0].star, true);
  assert.deepEqual(li[0].tags, ['프론트']);
  assert.equal(li[0].threadId, 't1');
  const old = h.list('아주 예전')[0];
  assert.equal(old.star, undefined);
  assert.equal(old.tags, undefined);
  assert.equal(old.kind, 'general'); // 예전 기록은 질문으로 다시 나눈다
  assert.equal(h.list('', { project: true })[0].project, 'app');
  assert.equal(h.stats().rows.length > 0, true);
  assert.ok(EX.toMarkdown(EX.docFromRecord(h.get('old'))).includes('아주 예전'));
  // 태그 · 별표
  assert.deepEqual(h.setTags('old', ['x', ' X ', 'y']), ['x', 'y']);
  assert.deepEqual(h.get('old').tags, ['x', 'y']);
  assert.deepEqual(h.setTags('old', []), []);
  assert.equal('tags' in h.get('old'), false);
  assert.equal(h.setTags('nope', ['a']), null);
  assert.equal(h.setStar('old', true), true);
  assert.equal(h.get('old').star, true);
  assert.equal(h.setStar('old', false), false);
  assert.equal('star' in h.get('old'), false);
  assert.equal(h.setStar('old', 'yes'), null);
  h.flush();
  assert.deepEqual(saves.at(-1), { dirty: ['old'], order: false }); // 바뀐 기록만 다시 쓴다
  // 줄기: 오래된 것부터
  assert.deepEqual(h.thread('t1').map((r) => r.id), ['r2', 'r1']);
  assert.deepEqual(h.thread('bad id!'), []);
  assert.deepEqual(h.tags().map((x) => x.tag), ['프론트']);
  // 새 기록: threadId · kind · project를 검사해 남긴다
  const id = h.add({ question: 'q', targets: ['a'], threadId: 't9', kind: 'code', project: { name: ' p ', path: 'C:\\secret' } });
  assert.deepEqual([h.get(id).threadId, h.get(id).kind, h.get(id).project], ['t9', 'code', { name: 'p' }]);
  const id2 = h.add({ question: 'q', targets: ['a'], threadId: 'bad id!', kind: 'evil', project: { name: '' } });
  assert.equal(['threadId', 'kind', 'project'].some((k) => k in h.get(id2)), false);
  assert.equal(cleanProject('x'), null);
});

test('기록 2000개 + 거르기 + 글 찾기가 빠르다', () => {
  const recs = Array.from({ length: 2000 }, (_, i) => ({
    id: `r${i}`,
    at: NOW - i * 3600e3,
    question: `질문 ${i} ${'내용 '.repeat(20)}`,
    targets: ['a', 'b', 'c', 'd'],
    files: [],
    answers: Object.fromEntries(['a', 'b', 'c', 'd'].map((s) => [s, { text: `${s} 답변 ${'긴 글 '.repeat(400)} ${i}`, state: 'done' }])),
    synth: [],
    feedback: i % 3 ? { a: 1 } : undefined,
    tags: i % 10 ? undefined : ['x'],
  }));
  const h = createHistory(() => {});
  h.load(recs);
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 5; k++) h.list('없는말', { services: ['a'], rating: 'good' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  assert.ok(ms < 400, `${ms}ms`);
  assert.equal(h.list('', { tag: 'x', period: '30d' }).length > 0, true);
});

test('내보내기: 여러 기록 · 대화 줄기를 문서 하나로 (Markdown 번호 · 머리글 한 단계 아래, HTML 이스케이프), 하나짜리는 그대로', () => {
  const recs = sample();
  recs[0].answers.a.text = '<script>alert(1)</script>';
  const doc = EX.docFromRecords([recs[1], recs[0]]);
  assert.equal(doc.multi, true);
  assert.equal(doc.items.length, 2);
  assert.equal(doc.title, '기록 2개 모음');
  const md = EX.toMarkdown(doc);
  assert.match(md, /^# 기록 2개 모음/);
  assert.match(md, /\n## 1\. SQL 느림\n/);
  assert.match(md, /\n## 2\. 오늘 질문 React\n/);
  assert.match(md, /\n### 질문\n/);
  assert.ok(md.indexOf('SQL 느림') < md.indexOf('오늘 질문 React'));
  const html = EX.toHtml(doc);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal((html.match(/<section class="rec">/g) || []).length, 2);
  assert.match(html, /<h3>질문<\/h3>/);
  const th = EX.docFromThread([recs[0], recs[1]]); // 오래된 것부터 다시 줄 세운다
  assert.deepEqual(th.items.map((d) => d.title), ['SQL 느림', '오늘 질문 React']);
  assert.match(th.title, /^대화 줄기 · SQL 느림 \(질문 2개\)/);
  assert.match(EX.fileName(th, 'md'), /대화 줄기/);
  // 하나짜리 내보내기는 예전과 같다
  const one = EX.toMarkdown(EX.docFromRecord(recs[1]));
  assert.match(one, /^# SQL 느림\n/);
  assert.match(one, /\n## 질문\n/);
  assert.match(EX.toHtml(EX.docFromRecord(recs[1])), /<h2>질문<\/h2>/);
  assert.equal(EX.docFromRecords('x').items.length, 0);
});

function fakeIpc() {
  const handle = new Map();
  return { on: () => {}, handle: (ch, fn) => handle.set(ch, fn), handle_: handle };
}

test('ipc/history: 거르기 · 태그 · 별표 · 줄기 요청을 검사한 뒤 기록장에 넘긴다', () => {
  const ipcMain = fakeIpc();
  const calls = [];
  const history = {
    list: (q, f) => (calls.push(['list', q, f]), []),
    setTags: (id, tags) => (calls.push(['tags', id, tags]), tags),
    setStar: (id, on) => (calls.push(['star', id, on]), on),
    thread: (tid) => (calls.push(['thread', tid]), []),
    tags: () => [],
    recommend: () => ({}),
  };
  require('../src/main/ipc/history').register({ ipcMain, history, clipboard: {}, dialog: {}, app: {}, rounds: () => ({}), roundHistoryId: () => null, win: () => null });
  const h = (ch, ...a) => ipcMain.handle_.get(ch)(null, ...a);
  h('history:list', 'q', { period: '7d', star: 'yes', evil: 1 });
  assert.deepEqual(calls.at(-1), ['list', 'q', HS.cleanFilters({ period: '7d' })]);
  assert.equal(h('history:setTags', 'bad id!', ['a']), null);
  assert.equal(h('history:setTags', 'r1', 'a,b'), null); // 배열만
  assert.equal(h('history:setTags', 'r1', ['a', 3]), null);
  assert.equal(h('history:setTags', 'r1', Array(51).fill('a')), null);
  assert.equal(h('history:setTags', 'r1', ['x'.repeat(201)]), null);
  assert.deepEqual(h('history:setTags', 'r1', ['a']), ['a']);
  assert.equal(h('history:setStar', 'r1', 1), null);
  assert.equal(h('history:setStar', 'r1', true), true);
  assert.deepEqual(h('history:thread', { x: 1 }), []);
  h('history:thread', 't1');
  assert.deepEqual(calls.filter((c) => c[0] !== 'list'), [['tags', 'r1', ['a']], ['star', 'r1', true], ['thread', 't1']]);
});

test('확장 host · preload: 같은 이름의 기록 API와 같은 검사, 사이드탭 · 앱 탭이 거르기 모듈을 먼저 읽는다', () => {
  const host = fs.readFileSync(path.join(ROOT, 'extension', 'host.js'), 'utf8');
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  for (const name of ['setTags:', 'setStar:', 'thread:', 'tags:', 'recommend:']) {
    assert.ok(host.includes(`      ${name}`), `host ${name}`);
    assert.ok(pre.includes(`    ${name}`), `preload ${name}`);
  }
  assert.match(host, /HS\.cleanFilters\(filters\)/);
  assert.match(host, /okRecordId\(id\) && typeof on === 'boolean'/);
  const side = fs.readFileSync(path.join(ROOT, 'extension', 'sidepanel.html'), 'utf8');
  assert.ok(side.indexOf('history-search.js') > 0 && side.indexOf('history-search.js') < side.indexOf('history-core.js'));
  assert.ok(side.indexOf('recommend.js') < side.indexOf('history-core.js'));
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  for (const s of ['../shared/history-search.js', '../shared/recommend.js', 'history-view.js', 'recommend-ui.js']) assert.ok(html.includes(s), s);
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-extension.js'), 'utf8');
  for (const s of ["'history-view.js'", "'recommend-ui.js'"]) assert.ok(build.includes(s), s);
});
