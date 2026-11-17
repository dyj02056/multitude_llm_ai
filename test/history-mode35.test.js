'use strict';
// v0.35.0 단위 테스트:  npm test
// [쉽게 말하면] 기록 보관(달별 파일) · 기록 옮기기 파일 · 추천 줄 세우기와 ★ 반영 · 시간대별 속도 · 하나만 공유 ·
// 셀렉터 편집기(내 셀렉터 검사 · 적용 · 저장 · 이슈 주소)가 맞게 동작하는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createHistory, cleanRecord } = require('../src/shared/history-core');
const A = require('../src/shared/history-archive');
const HT = require('../src/shared/history-transfer');
const ST = require('../src/shared/settings-transfer');
const RC = require('../src/shared/recommend');
const RM = require('../src/shared/remote-core');
const UPD = require('../src/shared/update-core');
const PL = require('../src/shared/prompt-lib');
const { createSecureStore } = require('../src/main/secure-store');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rec = (id, at, extra = {}) => ({ id, at, question: `q ${id}`, targets: ['a'], files: [], answers: { a: { name: 'A', state: 'done', text: 'x', md: 'x' } }, synth: [], ...extra });

function fakeSafe() {
  const x = (buf) => Buffer.from(buf.map((b) => b ^ 7));
  return { isEncryptionAvailable: () => true, encryptString: (s) => x(Buffer.from(s, 'utf8')), decryptString: (b) => x(b).toString('utf8') };
}

// ---------- 기록 보관 ----------

test('보관: 최대 개수를 넘으면 지우지 않고 보관 함수로, 꺼 두면 예전처럼 지운다', () => {
  const got = [];
  const h = createHistory(() => {}, { max: 100 });
  h.load([]);
  h.setArchive((list) => got.push(...list.map((r) => r.id)));
  for (let i = 0; i < 103; i++) h.add({ question: `q${i}`, targets: ['a'] });
  assert.equal(h.all().length, 100);
  assert.equal(got.length, 3); // 가장 오래된 3개
  assert.ok(!h.all().some((r) => got.includes(r.id)));
  h.setArchive(null);
  h.add({ question: 'more', targets: ['a'] });
  assert.equal(got.length, 3); // 꺼 두면 보관하지 않고 버림
  assert.equal(h.all().length, 100);
});

test('보관: setMax로 줄여도 오래된 기록이 보관으로 간다 (개수 반환)', () => {
  const got = [];
  const h = createHistory(() => {}, { max: 1000 });
  h.load(Array.from({ length: 300 }, (_, i) => rec(`r${i}`, 1000 - i)));
  h.setArchive((l) => got.push(...l));
  assert.equal(h.setMax(100), 200);
  assert.equal(got.length, 200);
  assert.equal(h.all().length, 100);
  assert.equal(h.setMax(1000), 0);
});

test('보관 포함 검색: archived 표시 · 시각 순 · 겹친 id는 한 번만', () => {
  const h = createHistory(() => {});
  h.load([rec('n2', 300), rec('n1', 100)]);
  const old = [rec('o1', 200, { question: '옛날 질문' }), rec('n1', 100)];
  const list = h.list('', undefined, old);
  assert.deepEqual(list.map((x) => x.id), ['n2', 'o1', 'n1']);
  assert.deepEqual(list.map((x) => !!x.archived), [false, true, false]);
  assert.deepEqual(h.list('옛날', undefined, old).map((x) => x.id), ['o1']);
  assert.equal(h.list('', undefined).length, 2); // 보관을 넘기지 않으면 지금 기록만
});

test('달 계산: 달 이름 · 달별로 나누기 · 합치기(겹침 없음 · 최근순 · 상한)', () => {
  assert.equal(A.monthKey(new Date(2026, 10, 17, 12).getTime()), '2026-11');
  assert.ok(A.okMonth('2026-01') && !A.okMonth('2026-13') && !A.okMonth('../x'));
  const g = A.groupByMonth([rec('a', new Date(2026, 0, 5).getTime()), rec('b', new Date(2026, 1, 5).getTime()), { id: 'bad id', at: 1 }, null]);
  assert.deepEqual(Object.keys(g).sort(), ['2026-01', '2026-02']);
  const m = A.mergeMonth([rec('x', 5), rec('y', 9)], [rec('x', 5), rec('z', 7)]);
  assert.deepEqual(m.map((r) => r.id), ['y', 'z', 'x']);
  const big = A.mergeMonth([], Array.from({ length: A.MAX_PER_MONTH + 5 }, (_, i) => rec(`k${i}`, i)));
  assert.equal(big.length, A.MAX_PER_MONTH);
  assert.equal(big[0].id, `k${A.MAX_PER_MONTH + 4}`);
});

function fakeArea() {
  const data = {};
  return {
    data,
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, JSON.parse(JSON.stringify(data[k]))])),
    set: async (obj) => Object.assign(data, JSON.parse(JSON.stringify(obj))),
    remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]),
  };
}

test('크롬 확장 보관 저장소: 달별 칸에 쌓고, 찾고, 지우고, 연달아 불러도 서로 덮지 않는다', async () => {
  const area = fakeArea();
  const ar = A.createAreaArchive(area);
  const jan = new Date(2026, 0, 5).getTime();
  const feb = new Date(2026, 1, 5).getTime();
  await Promise.all([ar.append([rec('a', jan), rec('b', jan + 1)]), ar.append([rec('c', feb)]), ar.append([rec('a', jan)])]);
  assert.deepEqual(Object.keys(area.data).sort(), ['history:a:2026-01', 'history:a:2026-02', 'history:a:months']);
  assert.equal((await ar.info()).total, 3);
  assert.deepEqual((await ar.readAll()).map((r) => r.id).sort(), ['a', 'b', 'c']);
  assert.equal((await ar.find('c')).id, 'c');
  assert.equal(await ar.find('../x'), null);
  assert.equal(await ar.remove('c'), true);
  assert.ok(!('history:a:2026-02' in area.data)); // 빈 달은 칸도 지운다
  assert.deepEqual((await ar.info()).months.map((m) => m.month), ['2026-01']);
  await ar.clear();
  assert.deepEqual(Object.keys(area.data), []);
});

test('Windows 앱 보관 저장소: archive-YYYY-MM.json(암호화) 파일, history/ 폴더와 따로', async (t) => {
  const { createFileArchive } = require('../src/main/history');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-arch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sec = createSecureStore({ safeStorage: fakeSafe(), fs });
  const dir = path.join(root, 'history-archive');
  const ar = createFileArchive({ dir: () => dir, sec: () => sec });
  const jan = new Date(2026, 0, 5).getTime();
  assert.equal(ar.append([rec('a', jan, { question: '비밀 질문' }), rec('b', jan + 5), rec('c', new Date(2026, 2, 1).getTime())]), true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['archive-2026-01.json', 'archive-2026-03.json']);
  assert.ok(!fs.readFileSync(path.join(dir, 'archive-2026-01.json'), 'latin1').includes('비밀'), '암호화되어 있다');
  assert.deepEqual(ar.readAll().map((r) => r.id), ['c', 'b', 'a']);
  assert.equal(ar.find('a').question, '비밀 질문');
  assert.equal(ar.find('zz'), null);
  assert.deepEqual(ar.info().months, [{ month: '2026-03', count: 1 }, { month: '2026-01', count: 2 }]);
  ar.append([rec('a', jan)]); // 겹침 없음
  assert.equal(ar.info().total, 3);
  assert.equal(ar.remove('c'), true);
  assert.deepEqual(fs.readdirSync(dir), ['archive-2026-01.json']);
  assert.equal(ar.remove('c'), false);
  assert.equal(ar.clear(), 1);
  assert.deepEqual(ar.readAll(), []);
});

// ---------- 기록 가져오기 · 검사 ----------

test('기록 검사: 아는 칸만, 위험한 id · 키 · 긴 글은 걸러내고 자른다', () => {
  assert.equal(cleanRecord({ id: '../evil', at: 1 }), null);
  assert.equal(cleanRecord(null), null);
  const raw = rec('ok-1', 5, {
    answers: Object.assign(JSON.parse('{"__proto__":{"text":"no"}}'), { 'bad id': { text: 'no' }, a: { name: 'A', state: 'weird', text: 'z'.repeat(300000), md: 'm', metrics: { doneMs: 12.4, chars: -1, sendOk: true, evil: 1 } } }),
    feedback: { a: 1, b: 5 },
    tags: ['x', 'x', ' y '],
    star: 'yes',
    evil: { deep: 1 },
    source: 'hack',
    project: { name: 'P', path: 'C:\\secret' },
    kind: 'code',
    chain: [{ kind: 'nope' }, { kind: 'handoff', intent: 'review', from: 'a', to: 'b', text: 't' }],
    synth: [{ judge: 'J', text: 't', mode: 'factcheck', names: ['a', 5], extra: 1 }, 'bad'],
  });
  const c = cleanRecord(raw);
  assert.deepEqual(Object.keys(c.answers), ['a']);
  assert.equal(c.answers.a.state, 'done');
  assert.equal(c.answers.a.text.length, 200000);
  assert.deepEqual(c.answers.a.metrics, { sendOk: true, doneMs: 12 });
  assert.deepEqual(c.feedback, { a: 1 });
  assert.deepEqual(c.tags, ['x', 'y']);
  assert.ok(!('star' in c) && !('evil' in c) && !('source' in c));
  assert.deepEqual(c.project, { name: 'P' });
  assert.equal(c.chain.length, 1);
  assert.deepEqual(c.synth.map((s) => s.mode), ['factcheck']);
  assert.deepEqual(c.synth[0].names, ['a']);
});

test('importRecords: 새 것만 더하고(중복 · 깨진 것 세기), 시각 순으로 끼우고, 넘치면 보관으로', () => {
  const saved = [];
  const arch = [];
  const h = createHistory((list, info) => saved.push(info), { max: 100 });
  h.load(Array.from({ length: 100 }, (_, i) => rec(`r${i}`, 1000 - i)));
  h.setArchive((l) => arch.push(...l.map((r) => r.id)));
  const out = h.importRecords([rec('new1', 5000), rec('r3', 1), { id: '../x' }, rec('old1', 1), 7]);
  assert.deepEqual(out, { added: 2, duplicate: 1, invalid: 2, overflow: 2 });
  assert.equal(h.all()[0].id, 'new1'); // 가장 최근
  assert.equal(h.all().length, 100);
  assert.ok(arch.includes('old1')); // 가장 오래된 것은 곧바로 보관으로
  assert.deepEqual(h.importRecords([]), { added: 0, duplicate: 0, invalid: 0, overflow: 0 });
  assert.deepEqual(h.importRecords('x'), { added: 0, duplicate: 0, invalid: 0, overflow: 0 });
});

// ---------- 기록 옮기기 파일 ----------

test('기록 옮기기 파일: 만들기 · 읽기 · 설정 파일과 구분 · 암호화 왕복 · 잘못된 비밀번호', async () => {
  const out = HT.buildExport({ records: [rec('b', 20), rec('a', 10), { nope: 1 }], app: 'app', appVersion: '0.35.0', now: 0 });
  assert.equal(out.kind, HT.KIND);
  assert.deepEqual(out.records.map((r) => r.id), ['a', 'b']); // 오래된 것부터
  assert.equal(out.count, 2);
  const text = JSON.stringify(out);
  const back = HT.parseFile(text);
  assert.equal(back.encrypted, false);
  assert.equal(back.data.count, 2);
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(code(() => HT.parseFile('not json')), 'json');
  assert.equal(code(() => HT.parseFile(JSON.stringify({ kind: ST.KIND, version: 1 }))), 'kind'); // 설정 파일은 기록 파일이 아니다
  assert.equal(code(() => ST.parseFile(text)), 'kind'); // 반대로 기록 파일은 설정 가져오기에서 거절
  assert.equal(code(() => HT.parseFile(JSON.stringify({ kind: HT.KIND, version: 99 }))), 'version');
  assert.equal(code(() => HT.parseFile('x'.repeat(HT.MAX_FILE_CHARS + 1))), 'size');
  assert.equal(code(() => HT.parseFile(JSON.stringify({ kind: HT.KIND, version: 1, records: Array.from({ length: HT.MAX_RECORDS + 1 }, (_, i) => ({ id: `i${i}` })) }))), 'records');

  const enc = await HT.encrypt(text, 'password-123', { iterations: 200000 });
  const parsed = HT.parseFile(enc);
  assert.equal(parsed.encrypted, true);
  assert.ok(!enc.includes('q a'));
  const data = await HT.decrypt(parsed.envelope, 'password-123');
  assert.equal(data.count, 2);
  await assert.rejects(HT.decrypt(parsed.envelope, 'wrong-pass-1'), (e) => e.code === 'password');
  // 설정 파일을 암호화한 것을 기록 가져오기로 열면 종류가 틀림
  const settingsEnc = await ST.encrypt(JSON.stringify(ST.buildExport({ settings: {}, library: {} })), 'password-123', { iterations: 200000 });
  await assert.rejects(HT.decrypt(HT.parseFile(settingsEnc).envelope, 'password-123'), (e) => e.code === 'kind');
  assert.equal(HT.countDuplicates(new Set(['a']), [rec('a', 1), rec('c', 2)]), 1);
});

// ---------- 추천: ★ 반영 · 기준 · 시간대 속도 ----------

function recs() {
  const mk = (id, at, answers, extra = {}) => ({ id, at, question: 'hello', targets: Object.keys(answers), answers, ...extra });
  const ans = (state, ms) => ({ name: '', state, metrics: { doneMs: ms } });
  const list = [];
  for (let i = 0; i < 6; i++) list.push(mk(`f${i}`, new Date(2026, 5, 1, 3 + i).getTime(), { fast: ans('done', 1000), slow: ans('done', 9000) }));
  // slow는 평가를 받는다, fast는 한 번 실패 (완료율은 fast가 낮음)
  list.push(mk('f6', new Date(2026, 5, 2, 9).getTime(), { fast: ans('timeout', 0), slow: ans('done', 8000) }, { feedback: { slow: 1 } }));
  return list;
}

test('추천 기준: 완료율 먼저(기본) · 평가 먼저 · 속도 먼저', () => {
  const rows = (order) => RC.recommend(recs(), { order }).general.picks;
  assert.deepEqual(rows('completion'), ['slow', 'fast']); // slow 완료율 100%
  assert.deepEqual(rows('rating'), ['slow', 'fast']); // 평가는 slow에만
  assert.deepEqual(rows('speed'), ['fast', 'slow']); // fast가 빠름
  assert.deepEqual(RC.recommend(recs()).general.picks, rows('completion')); // 기준을 안 주면 기본
  assert.deepEqual(RC.recommend(recs(), { order: 'weird' }).general.picks, rows('completion')); // 모르는 값은 기본
  assert.deepEqual(RC.ORDERS, ['completion', 'rating', 'speed']);
});

test('★ 반영: ★ 기록에서 따로 평가하지 않은 끝난 답은 "좋았음" 반 표 (평가가 있으면 그것만)', () => {
  const mk = (id, extra, fb) => ({ id, at: 1, question: 'q', targets: ['a', 'b'], answers: { a: { state: 'done' }, b: { state: 'done' } }, ...(fb ? { feedback: fb } : {}), ...extra });
  const st = RC.kindStats([mk('1', { star: true }), mk('2', { star: true }, { a: -1 }), mk('3', {})]).general.rows;
  const a = st.find((r) => r.id === 'a');
  const b = st.find((r) => r.id === 'b');
  assert.deepEqual([a.good, a.bad, a.starred], [0, 1, 1]); // a는 한 번 별로(평가), 한 번 ★ 반 표
  assert.equal(a.satisfaction, 0.5 / (0.5 + 1));
  assert.deepEqual([b.good, b.bad, b.starred], [0, 0, 2]);
  assert.equal(b.satisfaction, 1);
  assert.equal(RC.satisfactionOf({}), null);
  const byRating = RC.recommend(Array.from({ length: 5 }, (_, i) => mk(`s${i}`, { star: true }, i === 0 ? { a: -1 } : undefined)), { order: 'rating' }).general.picks;
  assert.deepEqual(byRating, ['b', 'a']); // ★ 반 표가 쌓인 b가 먼저
});

test('시간대별 속도: 새벽 · 오전 · 오후 · 저녁 중앙값, 답이 적은 칸은 시간을 숨김', () => {
  const s = RC.speedByTime(recs());
  assert.deepEqual(s.buckets, ['night', 'morning', 'afternoon', 'evening']);
  const fast = s.rows.find((r) => r.id === 'fast');
  assert.equal(fast.total, 6); // 끝난 답만 (timeout 제외)
  // 3 · 4 · 5시 → night 3개, 6 · 7 · 8시 → morning 3개
  assert.deepEqual(fast.cells.map((c) => c.n), [3, 3, 0, 0]);
  assert.equal(fast.cells[0].medianMs, 1000);
  assert.equal(fast.cells[2].medianMs, null);
  const slow = s.rows.find((r) => r.id === 'slow');
  assert.equal(slow.cells[1].n, 4); // 6 · 7 · 8시 + 2일 9시
  assert.equal(slow.cells[1].medianMs, 9000);
  assert.deepEqual(RC.speedByTime([]).rows, []);
  assert.equal(RC.speedByTime(recs(), { minSample: 4 }).rows.find((r) => r.id === 'fast').cells[0].medianMs, null);
});

// ---------- 하나만 공유 ----------

test('하나만 공유: 템플릿 · 스킬(이전 버전 뺌) · 프리셋(쓰는 스킬 · 템플릿 함께)을 설정 파일 모양으로', () => {
  const lib = PL.normalizeLibrary({
    templates: [{ id: 'u-1', name: 'T1', text: '{q}' }, { id: 'u-2', name: 'T2', text: '{q}!' }],
    skills: [{ id: 's-1', name: 'S1', body: 'b1', versions: [{ body: '옛 비밀', at: 1 }] }, { id: 's-2', name: 'S2', body: 'b2' }],
    presets: [{ id: 'p-1', name: 'P1', template: { id: 'u-1', vars: {} }, skills: ['s-1'] }],
  });
  const one = (kind, id) => ST.buildShare({ kind, id, library: lib, app: 'app', appVersion: '0.35.0', now: 0 });
  const t = one('template', 'u-2');
  assert.deepEqual(t.counts, { templates: 1, skills: 0, presets: 0 });
  assert.equal(t.name, 'T2');
  const s = one('skill', 's-1');
  assert.deepEqual(s.counts, { templates: 0, skills: 1, presets: 0 });
  assert.ok(!JSON.stringify(s.payload).includes('옛 비밀'), '이전 버전은 넣지 않는다');
  const p = one('preset', 'p-1');
  assert.deepEqual(p.counts, { templates: 1, skills: 1, presets: 1 });
  assert.equal(p.payload.library.templates[0].id, 'u-1');
  assert.equal(p.payload.library.skills[0].id, 's-1');
  assert.deepEqual(p.payload.settings, {}); // 설정은 비움
  assert.equal(one('template', 'nope'), null);
  assert.equal(one('weird', 'u-1'), null);
  // 받는 쪽: 설정 가져오기와 같은 파일 읽기 · 합치기(겹치면 둘 다 남기기)
  const back = ST.parseFile(JSON.stringify(p.payload));
  assert.equal(back.data.library.presets.length, 1);
  const merged = ST.mergeLibrary(lib, back.data.library, { mode: 'keepBoth', normalize: PL.normalizeLibrary, newId: PL.newId });
  assert.equal(merged.lib.presets.length, 2);
  assert.equal(merged.lib.skills.length, 3);
});

// ---------- 셀렉터 편집기 ----------

const SERVICES = [{ id: 'gem', name: 'Gem', hosts: ['gem.test'], input: ['textarea'], response: ['.answer'], stop: ['.stop'], send: ['button.send'] }];

test('내 셀렉터 검사: 입력창 · 중지 · 답변 읽기만, 나머지는 버리고 알린다', () => {
  const r = RM.sanitizeLocal(
    {
      gem: { input: ['  ', 'div[contenteditable]', 'div[contenteditable]', 'bad{sel}', 'x'.repeat(301)], send: ['button.evil'], fileInput: ['input'], response: ['.a', '.b'], stop: [] },
      nope: { input: ['x'] },
      __proto__: { input: ['y'] },
    },
    SERVICES,
  );
  assert.deepEqual(r.overrides, { gem: { input: ['  ', 'div[contenteditable]'].filter((x) => x.trim().length || true).slice(0, 2), response: ['.a', '.b'] } });
  assert.deepEqual(r.ignored.sort(), ['gem.fileInput', 'gem.send']);
  assert.deepEqual(RM.sanitizeLocal(null, SERVICES).overrides, {});
  assert.deepEqual(RM.sanitizeLocal([], SERVICES).overrides, {});
  assert.deepEqual(RM.LOCAL_FIELDS, ['input', 'stop', 'response']);
});

test('내 셀렉터 적용: 맨 앞, 겹치면 한 번만, 보내기 · 파일 칸은 그대로', () => {
  const svcs = JSON.parse(JSON.stringify(SERVICES));
  const base = RM.snapshotBase(svcs);
  RM.apply(svcs, base, {});
  RM.applyLocal(svcs, { gem: { input: ['my.input', 'textarea'], response: ['.mine'] } });
  assert.deepEqual(svcs[0].input, ['my.input', 'textarea']);
  assert.deepEqual(svcs[0].response, ['.mine', '.answer']);
  assert.deepEqual(svcs[0].stop, ['.stop']);
  assert.deepEqual(svcs[0].send, ['button.send']);
  // 원격 값을 다시 얹어도 내 값이 앞에 남는다
  RM.apply(svcs, base, { gem: { input: ['remote.input'] } });
  RM.applyLocal(svcs, { gem: { input: ['my.input'] } });
  assert.deepEqual(svcs[0].input, ['my.input', 'remote.input', 'textarea']);
});

function requireWithFakeElectron(rel, electron) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    return orig.call(this, req, ...rest);
  };
  try {
    for (const k of Object.keys(require.cache)) if (/src[\\/]main[\\/]remote\.js$/.test(k)) delete require.cache[k];
    return require(require.resolve(rel));
  } finally {
    Module._load = orig;
  }
}

test('앱 본체 remote.js: 내 셀렉터를 파일에 저장하고 바로 적용, 다시 켜도 남고, 비우면 파일을 지운다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-sel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = requireWithFakeElectron('../src/main/remote.js', { net: { fetch: () => Promise.reject(new Error('no net')) } });
  const svcs = JSON.parse(JSON.stringify(SERVICES));
  remote.init(dir, svcs);
  assert.deepEqual(remote.getLocal('gem'), {});
  const r = remote.setLocal('gem', { input: ['my.input'], send: ['button.evil'], stop: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.local, { input: ['my.input'] });
  assert.deepEqual(svcs[0].input, ['my.input', 'textarea']);
  assert.deepEqual(svcs[0].send, ['button.send']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'local-selectors.json'), 'utf8'));
  assert.deepEqual(saved, { gem: { input: ['my.input'] } });
  // 다시 켜면 저장된 값이 적용된다
  const svcs2 = JSON.parse(JSON.stringify(SERVICES));
  remote.init(dir, svcs2);
  assert.deepEqual(svcs2[0].input, ['my.input', 'textarea']);
  // 아는 서비스만, 비우면 파일 삭제
  assert.deepEqual(remote.setLocal('nope', { input: ['x'] }).local, {});
  assert.equal(remote.setLocal('gem', {}).ok, true);
  assert.deepEqual(svcs2[0].input, ['textarea']);
  assert.ok(!fs.existsSync(path.join(dir, 'local-selectors.json')));
  // 원격 갱신을 끄는 reset이 내 셀렉터를 지우지 않는다
  remote.setLocal('gem', { response: ['.mine'] });
  remote.reset();
  assert.deepEqual(svcs2[0].response, ['.mine', '.answer']);
});

test('GitHub 이슈 주소: 이 저장소의 issues/new만, 길면 줄이고, 줄바꿈 · 특수문자는 인코딩', () => {
  const u = UPD.issueUrl('[셀렉터] Gem: 바뀜\n', '본문 & <b> #1 ' + 'x'.repeat(30000));
  assert.ok(u.startsWith(`https://github.com/${UPD.REPO}/issues/new?title=`));
  assert.ok(u.length <= 7100);
  assert.ok(!u.includes('<') && !u.includes('\n'));
  assert.ok(u.includes('&body='));
  assert.equal(new URL(u).hostname, 'github.com');
  const short = UPD.issueUrl('t', 'b');
  assert.equal(short, `https://github.com/${UPD.REPO}/issues/new?title=t&body=b`);
});

// ---------- 본체 요청 · 연결 ----------

function fakeIpc() {
  const handle = new Map();
  const on = new Map();
  return { handle: (ch, fn) => handle.set(ch, fn), on: (ch, fn) => on.set(ch, fn), handle_: handle, on_: on };
}

test('ipc/settings: 셀렉터 편집 요청은 웹 서비스 · 아는 칸만, 이슈는 이 저장소 주소로만 연다', async () => {
  const ipcMain = fakeIpc();
  const opened = [];
  const calls = [];
  const svcs = JSON.parse(JSON.stringify([...SERVICES, { id: 'local', name: 'Local', kind: 'local' }]));
  const local = {};
  const remote = {
    getLocal: (id) => ({ ...(local[id] || {}) }),
    setLocal: (id, patch) => {
      calls.push(['set', id, patch]);
      local[id] = patch;
      return { ok: true, local: patch };
    },
    getStatus: () => ({}),
  };
  const prefs = {};
  require('../src/main/ipc/settings').register({
    ipcMain, history: { setMax() {}, setArchive() {} }, remote, guard: {}, net: {}, shell: { openExternal: async (u) => opened.push(u) },
    TIMEOUT_CHOICES: [20], MAX_CHOICES: [500], prefs: () => prefs, savePrefs() {}, pushState() {}, applyLang() {},
    allServices: () => svcs, refreshRemote() {}, reprobe: (id) => calls.push(['reprobe', id]),
    localChat: () => null, closeLocalPanel() {}, askLocal() {}, focusId: () => null, setFocusId() {}, updater: () => null, shortcutList: () => [],
    librarySaver: { save() {}, flush() {} }, readLibrary: () => ({}),
  });
  const h = (ch, ...a) => ipcMain.handle_.get(ch)(null, ...a);
  const v = h('selectors:get', 'gem');
  assert.deepEqual(v.fields, ['input', 'stop', 'response']);
  assert.deepEqual(v.inherited.input, ['textarea']);
  assert.equal(h('selectors:get', 'local'), null); // 로컬 LLM은 셀렉터가 없다
  assert.equal(h('selectors:get', 5), null);
  assert.deepEqual(h('selectors:set', 'local', { input: ['x'] }), { ok: false });
  assert.deepEqual(h('selectors:set', 'gem', [1]), { ok: false });
  const s = h('selectors:set', 'gem', { input: ['my'] });
  assert.equal(s.ok, true);
  assert.deepEqual(calls.filter((c) => c[0] === 'reprobe'), [['reprobe', 'gem']]);
  assert.equal(h('selectors:reset', 'gem').ok, true);
  assert.deepEqual(calls.filter((c) => c[0] === 'set').pop(), ['set', 'gem', {}]);
  // 이슈 양식
  assert.deepEqual(await h('issue:open', 5, 'x'), { ok: false });
  assert.deepEqual(await h('issue:open', 't', 'x'.repeat(20001)), { ok: false });
  assert.deepEqual(await h('issue:open', 't', '본문'), { ok: true });
  assert.ok(opened[0].startsWith(`https://github.com/${UPD.REPO}/issues/new?`));
  // 기록 보관 설정: 켜면 history.setArchive
  const seen = [];
  ipcMain.on_.get('settings:set')(null, { historyArchive: true, recommendOrder: 'rating' });
  assert.equal(prefs.historyArchive, true);
  assert.equal(prefs.recommendOrder, 'rating');
  ipcMain.on_.get('settings:set')(null, { recommendOrder: 'weird', historyArchive: 'yes' });
  assert.equal(prefs.recommendOrder, 'rating');
  assert.equal(prefs.historyArchive, true);
  assert.deepEqual(seen, []);
});

test('ipc/history: 보관 포함 목록 · 보관된 기록 보기 · 지우기 · 비우기 · 가져오기 크기 제한', () => {
  const ipcMain = fakeIpc();
  const log = [];
  const archived = [rec('old', 1)];
  const history = {
    list: (q, f, extra) => ['list', q, !!extra],
    get: (id) => (id === 'live' ? rec('live', 2) : null),
    importRecords: (l) => ({ added: l.length }),
    remove: (id) => log.push(['remove', id]),
    clear: () => log.push(['clear']),
    recommend: (o) => ['rec', o],
    speed: () => 'speed',
    archive: { readAll: () => archived, find: (id) => archived.find((r) => r.id === id) || null, remove: (id) => (log.push(['aremove', id]), true), clear: () => log.push(['aclear']), info: () => ({ total: 1, months: [] }) },
  };
  require('../src/main/ipc/history').register({ ipcMain, history, clipboard: {}, dialog: {}, app: {}, rounds: () => ({}), roundHistoryId: () => null, win: () => null });
  const h = (ch, ...a) => ipcMain.handle_.get(ch)(null, ...a);
  assert.deepEqual(h('history:list', 'q', {}), ['list', 'q', false]);
  assert.deepEqual(h('history:list', 'q', {}, { archive: true }), ['list', 'q', true]);
  assert.deepEqual(h('history:list', 'q', {}, { archive: 'yes' }), ['list', 'q', false]);
  assert.equal(h('history:get', 'live').id, 'live');
  assert.equal(h('history:get', 'old').id, 'old'); // 보관에서
  assert.equal(h('history:get', '../x'), null);
  h('history:delete', 'old');
  h('history:delete', 'live');
  assert.deepEqual(log, [['aremove', 'old'], ['remove', 'live']]);
  h('history:clear');
  assert.deepEqual(log.slice(2), [['aclear'], ['clear']]); // 보관도 같이 비운다
  assert.deepEqual(h('history:recommend', 'speed'), ['rec', { order: 'speed' }]);
  assert.deepEqual(h('history:recommend', 'x'), ['rec', { order: 'completion' }]);
  assert.deepEqual(h('history:import', [1, 2]), { added: 2 });
  assert.equal(h('history:import', new Array(5001).fill(0)).error, 'size');
  assert.equal(h('history:import', 'x').error, 'size');
  assert.deepEqual(h('history:archiveInfo'), { total: 1, months: [] });
});

test('연결: 화면 · 본체 · 확장 · 빌드 목록이 새 기능을 이어 준다', () => {
  const pre = read('src/preload/preload.js');
  for (const s of ["'history:archiveInfo'", "'history:import'", "'history:speed'", "'selectors:get'", "'selectors:set'", "'selectors:reset'", "'issue:open'"]) assert.ok(pre.includes(s), s);
  const html = read('src/renderer/index.html');
  for (const f of ['history-transfer.js', 'history-transfer-ui.js', 'selector-editor.js']) assert.ok(html.includes(`${f}"`), f);
  assert.ok(html.indexOf('<script src="history-view.js"') < html.indexOf('<script src="history-transfer-ui.js"'));
  assert.ok(html.indexOf('settings-transfer.js') < html.indexOf('history-transfer.js'));
  assert.ok(html.indexOf('<script src="renderer.js"') < html.indexOf('<script src="selector-editor.js"'));
  const build = read('scripts/build-extension.js');
  assert.ok(build.includes("'history-archive'") && build.includes("'history-transfer-ui.js'") && build.includes("'selector-editor.js'"));
  const host = require('./helpers/ext-host').readHost();
  for (const s of ['createAreaArchive', 'importRecords', 'archiveInfo', 'selectors: {', 'openIssue', 'loadLocalSelectors', "'mlah'", 'historyArchive', 'recommendOrder', 'speed:']) assert.ok(host.includes(s), s);
  const main = read('src/main/ipc/history.js');
  assert.ok(main.includes("mlah: { nameKey: 'main.save.mlah', ext: 'mla-history.json'"));
  assert.ok(read('src/main/history.js').includes("'history-archive'"));
  assert.ok(read('src/main/main.js').includes('archive: prefs.historyArchive'));
  // 설정 옮기기에 기록 보관 켜기가 같이 간다
  assert.ok(ST.KEYS.includes('historyArchive'));
  assert.deepEqual(ST.cleanSettings({ historyArchive: true, historyMax: 500 }), { historyArchive: true, historyMax: 500 });
  assert.deepEqual(ST.cleanSettings({ historyArchive: 'yes' }), {});
});
