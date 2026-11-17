'use strict';
// 답 다루기 (v0.32.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 분석의 합의율(AI 몇 개 중 몇 개가 같은 입장) · 출처 모으기
//   - 토론 역할(찬성 · 반대 · 반론 전담) · 라운드 사이 끼어들기 · 프리셋 저장 · 기록
//   - 답변 비교의 문단 맞추기 · 코드만 · 표 비교 (계산 + 화면 그리기)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const AN = require('../src/shared/analysis');
const CH = require('../src/shared/chain');
const CM = require('../src/shared/compare-modes');
const PL = require('../src/shared/prompt-lib');
const HC = require('../src/shared/history-core');
const EX = require('../src/shared/export');
const i18n = require('../src/shared/i18n');
const { createDebate } = require('../src/shared/debate');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const NAMES = ['Gemini', 'ChatGPT', 'DeepSeek', 'Perplexity'];

// ---------- 합의율 ----------
const ANALYSIS = [
  '## 공통 의견',
  '- 둘 다 배우기 쉽다',
  '- 둘 다 널리 쓰인다',
  '',
  '## 이견',
  '| 쟁점 | Gemini | ChatGPT | DeepSeek | Perplexity | 판단 |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 실행 속도 | Python이 더 빠르다 | Python이 더 빠르다고 본다 | JavaScript가 더 빠르다 | - | 벤치마크마다 다르다 |',
  '| 출시 연도 | 1991년 | 1991년 | 1991년 | 1991년 | 모두 같다 |',
  '| 인기 | 2위 | 3위 | - | - | 조사마다 다르다 |',
  '',
  '## 근거 부족',
  '- [DeepSeek] 속도 비교에 출처가 없다',
  '',
  '## 최종 답변',
  '용도에 따라 다르다.',
].join('\n');

test('합의율: 이견 한 줄의 "같은 입장 AI 수"를 입장 글의 겹침으로 센다 (숫자가 다르면 다른 입장)', () => {
  const res = AN.parseAnalysis(ANALYSIS, { names: NAMES });
  assert.equal(res.ok, true);
  const [speed, year, rank] = res.disagreements.map((d) => AN.agreementOf(d, NAMES));
  assert.deepEqual(speed, { agree: 2, of: 4, spoke: 3, groups: 2 }); // Gemini · ChatGPT 같음, DeepSeek 다름, Perplexity는 입장 없음
  assert.deepEqual(year, { agree: 4, of: 4, spoke: 4, groups: 1 });
  assert.deepEqual(rank, { agree: 1, of: 4, spoke: 2, groups: 2 }); // 2위 · 3위 — 숫자가 달라 다른 입장
  assert.equal(AN.agreementOf({ topic: 'x', positions: [{ name: 'A', known: true, text: '' }] }, NAMES), null); // 입장 글이 없는 줄은 알 수 없다
  assert.equal(AN.agreementOf({ topic: 'x', positions: [{ name: 'A', known: true, text: '-' }] }, NAMES), null);
  assert.equal(AN.agreementOf(null), null);
  // "언급 없음" · "not mentioned"은 입장이 아니다
  const mention = AN.agreementOf({ topic: 'x', positions: [{ name: 'A', text: '언급 없음' }, { name: 'B', text: 'Not mentioned' }, { name: 'C', text: '둘 다 맞다' }] }, NAMES);
  assert.deepEqual(mention, { agree: 1, of: 4, spoke: 1, groups: 1 });
});

test('합의율: 공통 의견은 모두 같음, 이견은 같은 입장 비율의 평균. 형식이 깨졌거나 항목이 없으면 null', () => {
  const res = AN.parseAnalysis(ANALYSIS, { names: NAMES });
  const s = AN.agreementSummary(res, NAMES);
  // (공통 2 + 2/3 + 4/4 + 1/2) / 5 = 4.1667 / 5 = 83% — 입장을 쓴 AI 가운데 같은 입장의 비율 (말이 없는 AI는 깎지 않는다)
  assert.deepEqual({ rate: s.rate, common: s.common, disputed: s.disputed }, { rate: 83, common: 2, disputed: 3 });
  assert.equal(s.rows.length, 3);
  assert.equal(AN.agreementSummary({ ok: false }, NAMES).rate, null);
  const none = AN.parseAnalysis('## 공통 의견\n- 없음\n\n## 이견\n- 없음\n\n## 최종 답변\nok', { names: NAMES });
  assert.equal(AN.agreementSummary(none, NAMES).rate, null);
  const all = AN.parseAnalysis('## 공통 의견\n- 하나\n- 둘\n\n## 이견\n- 없음\n\n## 최종 답변\nok', { names: NAMES });
  assert.equal(AN.agreementSummary(all, NAMES).rate, 100);
  // 입장 글 없이 글머리표만 있는 이견은 0으로 센다 (보수적)
  const bullets = AN.parseAnalysis('## 공통 의견\n- 하나\n\n## 이견\n- 속도: Gemini와 DeepSeek이 갈림\n\n## 최종 답변\nok', { names: NAMES });
  assert.equal(AN.agreementSummary(bullets, NAMES).rate, 50);
});

// ---------- 출처 ----------
test('출처 모으기: 마크다운 링크 · 맨 주소, 끝 문장부호 · #조각 · utm_ 떼기, 같은 주소는 하나로, 여러 AI가 쓴 것이 앞', () => {
  const found = AN.extractSources([
    { name: 'Gemini', text: '자세한 것은 [공식 문서](https://docs.example.com/guide?utm_source=x&id=2#top)와 https://blog.example.org/post. 를 보세요.' },
    { name: 'ChatGPT', text: '참고: https://docs.example.com/guide?id=2) 그리고 (https://only.example.net/a/).' },
    { name: 'Perplexity', text: 'ftp://nope.example.com/x · javascript:alert(1) · 링크 없음' },
    { name: 'Gemini', text: '또 https://www.news.example.com/2026/11/ 입니다' },
  ]);
  assert.deepEqual(found.map((s) => s.url), [
    'https://docs.example.com/guide?id=2', // 두 AI가 씀 → 맨 앞
    'https://blog.example.org/post',
    'https://only.example.net/a',
    'https://www.news.example.com/2026/11',
  ]);
  assert.deepEqual(found[0].names, ['Gemini', 'ChatGPT']);
  assert.equal(found[0].title, '공식 문서');
  assert.equal(found[0].host, 'docs.example.com');
  assert.equal(found[3].host, 'news.example.com'); // www 뗌
  assert.equal(found[0].count, 2);
  assert.deepEqual(AN.extractSources([]), []);
  assert.deepEqual(AN.extractSources([{ name: 'A', text: '링크 없음' }]), []);
  const many = Array.from({ length: 50 }, (_, i) => `https://s${i}.example.com/`).join(' ');
  assert.equal(AN.extractSources([{ name: 'A', text: many }]).length, 30);
  assert.equal(AN.extractSources([{ name: 'A', text: many }], { max: 5 }).length, 5);
});

// ---------- 토론 역할 · 끼어들기 (글) ----------
test('토론 요청 글: 역할이 없으면 예전 글 그대로, 역할 · 끼어들기가 있으면 그 줄이 더해진다 (한국어 · 영어)', () => {
  const base = { question: 'Q?', round: 1, rounds: 2, selfName: 'Gemini', others: [{ name: 'ChatGPT', text: 'a' }] };
  const plain = CH.buildDebatePrompt(base);
  assert.ok(!plain.includes('역할') && !plain.includes('사용자가'));
  for (const role of CH.ROLES) {
    const p = CH.buildDebatePrompt({ ...base, role });
    assert.ok(p.includes(`[당신의 역할: ${{ pro: '찬성', con: '반대', rebut: '반론 전담' }[role]}]`), role);
    assert.ok(p.indexOf('역할') < p.indexOf('이전 답변과 비교해')); // 요청 앞에 둔다
  }
  assert.equal(CH.buildDebatePrompt({ ...base, role: 'bogus' }), plain); // 모르는 역할은 무시
  const noted = CH.buildDebatePrompt({ ...base, note: '  비용도 따져 줘  ' });
  assert.match(noted, /\[사용자가 토론 중에 덧붙인 말\]\n비용도 따져 줘\n위 말도 반영해 주세요\./);
  assert.equal(CH.buildDebatePrompt({ ...base, note: '   ' }), plain);
  assert.match(CH.buildDebatePrompt({ ...base, note: 'x'.repeat(9000) }), /…\(이하 생략\)/); // 너무 긴 말은 자른다
  i18n.setLang('en');
  try {
    const en = CH.buildDebatePrompt({ ...base, role: 'con', note: 'weigh the cost' });
    assert.match(en, /\[Your role: Con\]/);
    assert.match(en, /\[A note the user added during the debate\]\nweigh the cost/);
    assert.ok(!/[가-힣]/.test(en));
    const judge = CH.buildDebateJudgePrompt({ question: 'Q', rounds: 2, positions: [{ name: 'A', text: 'x', role: 'pro' }, { name: 'B', text: 'y' }] });
    assert.match(judge, /\[A's \(Pro\) final position\]\nx/);
    assert.match(judge, /\[B's final position\]\ny/);
    assert.match(judge, /were given debate roles/);
  } finally {
    i18n.setLang('ko');
  }
  const judge = CH.buildDebateJudgePrompt({ question: 'Q', rounds: 2, positions: [{ name: 'A', text: 'x', role: 'rebut' }, { name: 'B', text: 'y' }] });
  assert.match(judge, /\[A\(반론 전담\)의 마지막 입장\]\nx/);
  assert.match(judge, /\[B의 마지막 입장\]\ny/);
  assert.ok(judge.includes('역할(찬성 · 반대 · 반론 전담)을 주었습니다'));
  assert.ok(!CH.buildDebateJudgePrompt({ question: 'Q', rounds: 2, positions: [{ name: 'A', text: 'x' }] }).includes('역할'));
});

test('토론 설정 검사: 역할은 참가 AI의 아는 값만, 끼어들기는 true일 때만 싣는다 (정하지 않으면 예전과 같은 모양)', () => {
  const open = ['a', 'b', 'c', 'd'];
  const plain = CH.normalizeDebate({ participants: ['a', 'b'], rounds: 2, judge: 'a' }, open, 'a');
  assert.deepEqual(plain, { ok: true, participants: ['a', 'b'], rounds: 2, judge: 'a' });
  const c = CH.normalizeDebate({ participants: ['a', 'b'], roles: { a: 'pro', b: 'weird', c: 'con', x: 'pro' }, interject: true }, open, 'a');
  assert.deepEqual(c.roles, { a: 'pro' }); // b는 모르는 역할, c는 참가자가 아님
  assert.equal(c.interject, true);
  assert.equal(CH.normalizeDebate({ participants: ['a', 'b'], interject: 'yes' }, open, 'a').interject, undefined);
  assert.deepEqual(CH.cleanDebateExtras({ roles: { a: 'rebut', 'bad id': 'pro' }, interject: true }, (id) => /^\w+$/.test(id)), { roles: { a: 'rebut' }, interject: true });
  assert.deepEqual(CH.cleanDebateExtras({}), {});
  assert.deepEqual(CH.cleanDebateExtras(null), {});
  assert.deepEqual(CH.cleanRoles(null, ['a']), {});
  // 본체 IPC 검사
  const { cleanDebateCfg } = require('../src/main/ipc/chain');
  assert.deepEqual(cleanDebateCfg({ participants: ['a', 'b'], roles: { a: 'pro', b: 'zzz' }, interject: true }), { participants: ['a', 'b'], rounds: undefined, judge: undefined, roles: { a: 'pro' }, interject: true });
  assert.deepEqual(cleanDebateCfg({ participants: ['a', 'b'] }), { participants: ['a', 'b'], rounds: undefined, judge: undefined });
});

// ---------- 토론 진행 (역할 · 끼어들기) ----------
function debateFixture() {
  const sent = [];
  const status = [];
  const chain = [];
  const synth = [];
  const names = { a: 'A', b: 'B', j: 'J' };
  const engine = createDebate({
    sendAndWait: async (id, text) => (sent.push({ id, text }), { state: 'done', text: `${id}:${sent.length}`, md: `${id}:${sent.length}` }),
    readAnswer: async (id) => ({ text: `${id}0`, md: `${id}0` }),
    nameOf: (id) => names[id] || id,
    openIds: () => ['a', 'b'],
    judgeIds: () => ['a', 'b', 'j'],
    defaultJudge: () => 'j',
    getRound: () => ({ question: 'Q', historyId: 'h1' }),
    history: { addChain: (_h, e) => chain.push(e), addSynth: (_h, e) => synth.push(e) },
    status: (p) => status.push(p),
    notify() {},
    cancel() {},
  });
  return { engine, sent, status, chain, synth };
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('토론 진행: 역할은 요청 · 기록 · 판정 글에, 끼어들기를 켜면 라운드 뒤 멈추고 한마디는 다음 라운드에만 붙는다', async () => {
  const f = debateFixture();
  const r = await f.engine.start({ participants: ['a', 'b'], rounds: 3, judge: 'j', roles: { a: 'pro', b: 'con' }, interject: true });
  assert.equal(r.ok, true);
  await until(() => f.status.some((s) => s.state === 'paused'));
  assert.deepEqual(f.status.filter((s) => s.state === 'paused').map((s) => [s.round, s.rounds]), [[1, 3]]);
  assert.equal(f.sent.length, 2); // 1라운드만 보냈다 — 사용자 말을 기다리는 중
  assert.match(f.sent[0].text, /\[당신의 역할: 찬성\]/);
  assert.match(f.sent[1].text, /\[당신의 역할: 반대\]/);
  assert.ok(!f.sent[0].text.includes('덧붙인 말'));
  assert.deepEqual(f.engine.interject('  비용도 따져 줘 '), { ok: true, note: true });
  assert.equal(f.engine.interject('두 번째').ok, false); // 이미 이어 갔다
  await until(() => f.status.filter((s) => s.state === 'paused').length === 2);
  const round2 = f.sent.slice(2, 4);
  for (const s of round2) assert.match(s.text, /\[사용자가 토론 중에 덧붙인 말\]\n비용도 따져 줘/);
  f.engine.interject(''); // 이번에는 그냥 이어 간다
  await f.engine.whenDone();
  const round3 = f.sent.slice(4, 6);
  for (const s of round3) assert.ok(!s.text.includes('덧붙인 말')); // 한마디는 한 라운드에만
  assert.equal(f.status.filter((s) => s.state === 'paused').length, 2); // 마지막 라운드 뒤에는 멈추지 않는다
  const judge = f.sent.at(-1);
  assert.equal(judge.id, 'j');
  assert.match(judge.text, /\[A\(찬성\)의 마지막 입장\]/);
  assert.match(judge.text, /\[B\(반대\)의 마지막 입장\]/);
  assert.equal(f.status.at(-1).state, 'done');
  // 기록: 역할은 답마다, 끼어든 말은 그 말을 받은 라운드에
  assert.deepEqual(f.chain.map((c) => [c.round, c.note || null]), [[1, null], [2, '비용도 따져 줘'], [3, null]]);
  assert.deepEqual(f.chain[0].answers.map((a) => a.role), ['pro', 'con']);
});

test('토론 진행: 역할도 끼어들기도 없으면 예전처럼 멈추지 않고, 멈춰 있을 때 멈추기를 누르면 판정 없이 끝난다', async () => {
  const f = debateFixture();
  await f.engine.start({ participants: ['a', 'b'], rounds: 2 });
  await f.engine.whenDone();
  assert.ok(!f.status.some((s) => s.state === 'paused'));
  assert.ok(f.chain.every((c) => !('note' in c) && c.answers.every((a) => !('role' in a))));
  assert.ok(!f.sent[0].text.includes('역할'));

  const g = debateFixture();
  await g.engine.start({ participants: ['a', 'b'], rounds: 3, interject: true });
  await until(() => g.status.some((s) => s.state === 'paused'));
  assert.equal(g.engine.stop().ok, true);
  await g.engine.whenDone();
  assert.equal(g.status.at(-1).state, 'stopped');
  assert.ok(!g.sent.some((s) => s.id === 'j'));
  assert.equal(g.engine.interject('늦은 말').ok, false);
});

// ---------- 기록 · 문서 · 프리셋 ----------
test('토론 기록: 역할 · 끼어든 말은 알맞을 때만 남고, 문서로 내보내면 이름 옆 역할과 "내가 끼워 넣은 말"이 나온다', () => {
  const e = HC.cleanChain({ kind: 'debate', round: 2, rounds: 3, at: 5, note: ' 비용도 ', answers: [{ id: 'a', name: 'A', text: 'x', role: 'pro' }, { id: 'b', name: 'B', text: 'y', role: 'hacker' }] });
  assert.deepEqual(e.answers.map((a) => a.role), ['pro', undefined]);
  assert.equal(e.note, '비용도');
  assert.ok(!('note' in HC.cleanChain({ kind: 'debate', round: 1, answers: [{ id: 'a', text: 'x' }] })));
  assert.ok(!('note' in HC.cleanChain({ kind: 'debate', round: 1, note: '   ', answers: [{ id: 'a', text: 'x' }] })));
  const items = EX.docFromCompare({ question: 'q', answers: [], chain: [e], debates: [] }).chain;
  const flat = JSON.stringify(items);
  assert.match(flat, /A \(찬성\)/);
  assert.match(flat, /내가 끼워 넣은 말/);
  assert.match(flat, /비용도/);
});

test('프리셋의 토론 틀: 역할 · 끼어들기를 저장하고, 모르는 역할 · 참가자 밖 역할은 버린다', () => {
  const p = PL.normalizePreset({ name: '찬반', debate: { participants: ['gemini', 'chatgpt'], rounds: 2, judge: 'claude', roles: { gemini: 'pro', chatgpt: 'rebut', claude: 'con', x: 'zzz' }, interject: true } });
  assert.deepEqual(p.debate, { participants: ['gemini', 'chatgpt'], rounds: 2, judge: 'claude', roles: { gemini: 'pro', chatgpt: 'rebut' }, interject: true });
  const q = PL.normalizePreset({ name: '예전', debate: { participants: ['gemini', 'chatgpt'], rounds: 2, judge: 'claude' } });
  assert.deepEqual(q.debate, { participants: ['gemini', 'chatgpt'], rounds: 2, judge: 'claude' }); // 예전 프리셋과 같은 모양
  assert.equal(PL.normalizePreset({ name: 'x', debate: { participants: ['gemini'], roles: { gemini: 'pro' }, interject: 'yes' } }).debate.interject, undefined);
});

test('토론 화면 · 본체 연결: 설정 창에 역할 · 끼어들기, 끼어들기 창, IPC · preload · 확장 이어짐', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="debateInterject"/);
  assert.match(html, /id="interjectModal" class="modal" hidden>\s*<div class="modal-box debate-box" role="dialog" aria-modal="true" aria-labelledby="interjectTitle">/);
  assert.match(html, /id="debateNote" hidden/);
  const ui = read('src/renderer/debate-ui.js');
  assert.match(ui, /role\.dataset\.id = id;/);
  assert.match(ui, /host\.debate\.interject\(text\)/);
  assert.match(ui, /patch\.state === 'paused'/);
  assert.match(read('src/preload/preload.js'), /interject: \(text\) => ipcRenderer\.invoke\('debate:interject', text\)/);
  assert.match(read('src/main/ipc/chain.js'), /ipcMain\.handle\('debate:interject'/);
  assert.match(read('src/main/ipc/chain.js'), /\.\.\.cleanDebateExtras\(c, okId\)/);
  const { readHost } = require('./helpers/ext-host');
  const host = readHost();
  assert.match(host, /interject: async \(text\) => rounds\.interjectDebate\(/);
  assert.match(host, /MLA\.chain\.cleanDebateExtras\(c, okChainId\)/);
  assert.match(read('src/shared/rounds.js'), /interjectDebate: \(text\) => debate\.interject\(text\)/);
  assert.match(read('src/renderer/library-presets.js'), /sumDebateInterject/);
});

// ---------- 답변 비교: 문단 맞추기 ----------
const A1 = '파이썬은 배우기 쉽습니다.\n\n데이터 분석과 AI에 많이 쓰입니다.\n\n실행 속도는 느린 편입니다.';
const A2 = '파이썬은 배우기가 쉬운 언어입니다.\n\n데이터 분석 · AI 분야에서 많이 씁니다.\n\n라이선스는 오픈소스입니다.\n\n실행 속도가 느린 편입니다.';
const A3 = '완전히 다른 이야기: 날씨가 맑습니다.';

test('문단 맞추기: 기준 문단마다 한 줄, 비슷한 문단은 같은 줄, 짝 없는 문단은 앞 문단 뒤에 새 줄', () => {
  const r = CM.alignParagraphs([{ id: 'a', text: A1 }, { id: 'b', text: A2 }, { id: 'c', text: A3 }], 'a');
  assert.equal(r.baseId, 'a');
  assert.deepEqual(r.ids, ['a', 'b', 'c']);
  const text = (row, id) => row.cells[id]?.text || null;
  // 기준 3줄 + B에만 있는 "라이선스" 1줄 + C에만 있는 1줄 (C의 문단은 앞 문단이 없어 맨 앞)
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows[0].only, 'c');
  const baseRows = r.rows.filter((x) => x.cells.a);
  assert.equal(baseRows.length, 3);
  assert.equal(text(baseRows[0], 'a'), '파이썬은 배우기 쉽습니다.');
  assert.equal(text(baseRows[0], 'b'), '파이썬은 배우기가 쉬운 언어입니다.');
  assert.equal(text(baseRows[1], 'b'), '데이터 분석 · AI 분야에서 많이 씁니다.');
  const lic = r.rows.find((x) => x.only === 'b');
  assert.equal(text(lic, 'b'), '라이선스는 오픈소스입니다.');
  assert.equal(lic.cells.a, null);
  assert.equal(r.rows.indexOf(lic), r.rows.indexOf(baseRows[1]) + 1); // B의 앞 문단(데이터 분석)이 있는 줄 바로 뒤
  const speed = r.rows.find((x) => x.cells.a && /속도/.test(x.cells.a.text));
  assert.equal(text(speed, 'b'), '실행 속도가 느린 편입니다.');
  assert.ok(speed.cells.b.sim >= CM.ALIGN_MIN);
  assert.equal(r.rows.filter((x) => x.only === 'c').length, 1);
  assert.equal(r.rows.find((x) => x.only === 'c').cells.c.sim, 0);
  for (const row of r.rows) assert.deepEqual(Object.keys(row.cells).sort(), ['a', 'b', 'c']); // 모든 줄에 모든 칸 (없으면 null)
});

test('문단 맞추기: 표의 줄은 "a · b"로 보이고 구분 줄은 버려, 칸에 파이프 글자가 그대로 나오지 않는다', () => {
  assert.equal(CM.tidyParagraph('| 구분 | Python | JavaScript |'), '구분 · Python · JavaScript');
  assert.equal(CM.tidyParagraph('|---|:--:|---|'), '');
  assert.equal(CM.tidyParagraph('| 이스케이프 \\| 파이프 | 2 |'), '이스케이프 | 파이프 · 2');
  assert.equal(CM.tidyParagraph('  그냥 문장입니다  '), '그냥 문장입니다');
  const r = CM.alignParagraphs([{ id: 'a', text: '소개 글입니다.\n\n| 구분 | Python |\n|---|---|\n| 용도 | 데이터 |' }, { id: 'b', text: '소개 글입니다.\n\n| 구분 | Python |\n|---|---|\n| 용도 | 데이터 분석 |' }], 'a');
  const texts = r.rows.map((row) => row.cells.a?.text);
  assert.deepEqual(texts, ['소개 글입니다.', '구분 · Python', '용도 · 데이터']); // 구분 줄은 줄이 되지 않는다
  assert.ok(r.rows.every((row) => !row.only)); // 서로 짝이 맞는다
});

test('문단 맞추기: 기준을 바꾸면 그 답변의 문단이 줄이 되고, 글 없는 답변 · 빈 입력은 안전하게', () => {
  const r = CM.alignParagraphs([{ id: 'a', text: A1 }, { id: 'b', text: A2 }], 'b');
  assert.equal(r.baseId, 'b');
  assert.equal(r.rows.length, 4);
  assert.equal(r.rows.filter((x) => x.only === 'a').length, 0); // A의 문단은 모두 B의 문단과 짝이 있다
  const fallback = CM.alignParagraphs([{ id: 'a', text: '' }, { id: 'b', text: A2 }], 'a');
  assert.equal(fallback.baseId, 'b'); // 기준에 글이 없으면 글이 있는 첫 답변
  assert.ok(fallback.rows.every((x) => x.cells.a === null));
  assert.deepEqual(CM.alignParagraphs([], 'x'), { baseId: null, ids: [], rows: [] });
  assert.deepEqual(CM.alignParagraphs([{ id: 'a', text: '  ' }], 'a').rows, []);
  assert.equal(CM.paragraphSimilarity('같은 문장입니다', '같은 문장입니다'), 1);
  assert.ok(CM.paragraphSimilarity('파이썬은 쉽다', '날씨가 맑다') < CM.ALIGN_MIN);
});

// ---------- 답변 비교: 코드만 ----------
test('코드만: 울타리 ``` ~~~ (더 긴 울타리 안의 짧은 울타리는 글), 언어 이름, 닫히지 않은 블록, 코드 밖 글은 뺀다', () => {
  const md = [
    '설명입니다.',
    '```js',
    'const a = 1;',
    '```',
    '중간 글',
    '````md',
    '```',
    '안쪽 울타리는 글',
    '```',
    '````',
    '~~~python',
    'print(1)',
    '~~~',
    '```',
    '끝까지 안 닫힘',
  ].join('\n');
  const blocks = CM.extractCode(md);
  assert.deepEqual(blocks.map((b) => b.lang), ['js', 'md', 'python', '']);
  assert.equal(blocks[0].code, 'const a = 1;');
  assert.equal(blocks[1].code, '```\n안쪽 울타리는 글\n```');
  assert.equal(blocks[3].code, '끝까지 안 닫힘');
  assert.deepEqual(CM.extractCode('코드 없음'), []);
  assert.deepEqual(CM.extractCode(''), []);
  assert.deepEqual(CM.markCodeLines('a = 1\nb = 2', 'a = 1\n  b = 2\nc = 3\n'), [
    { text: 'a = 1', changed: false },
    { text: '  b = 2', changed: false }, // 앞뒤 공백 차이는 같은 줄
    { text: 'c = 3', changed: true },
    { text: '', changed: false },
  ]);
});

// ---------- 답변 비교: 표 비교 ----------
const T1 = ['구분 | Python | JavaScript'.split(' | ').join(' | ')].length && [
  '| 구분 | Python | JavaScript |',
  '| --- | --- | --- |',
  '| 주 용도 | 데이터 분석 · AI | 웹 화면 |',
  '| 출시 | 1991 | 1995 |',
  '| 타입 | 동적 | 동적 |',
].join('\n');
const T2 = ['표 앞의 글', '| 항목 | Python | JavaScript |', '| :-- | --: | --- |', '| 주 용도 | 데이터 분석 · AI 분야 | 웹 화면 |', '| 출시 연도 | 1991 | 1996 |', '| 성능 | 느린 편 | 빠른 편 |'].join('\n');
const T3 = '표 없이 글로만 답했습니다.';

test('표 비교: 첫 칸으로 항목을 맞추고, 값이 비슷하지 않거나 숫자가 다르면 다름, 한쪽에만 있는 항목은 missing', () => {
  const r = CM.compareTables([{ id: 'a', text: T1 }, { id: 'b', text: T2 }, { id: 'c', text: T3 }]);
  assert.deepEqual(r.withTable, ['a', 'b']);
  assert.deepEqual(r.noTable, ['c']);
  const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(by), ['주 용도', '출시', '타입', '성능']); // "출시 연도"는 "출시"와 같은 항목
  assert.equal(by['주 용도'].differs, false); // 거의 같은 값
  assert.equal(by['출시'].differs, true); // 1995 vs 1996
  assert.deepEqual(by['출시'].cells.b, { header: ['Python', 'JavaScript'], values: ['1991', '1996'] });
  assert.deepEqual(by['타입'].missing, ['b']);
  assert.equal(by['타입'].cells.b, null);
  assert.deepEqual(by['성능'].missing, ['a']);
  assert.equal(by['성능'].cells.c, null); // 표가 없는 답변은 missing에 넣지 않는다
  assert.equal(by['성능'].differs, false); // 값이 하나뿐이면 비교할 것이 없다
  assert.deepEqual(CM.compareTables([{ id: 'c', text: T3 }]).rows, []);
  assert.deepEqual(CM.compareTables([]), { ids: [], withTable: [], noTable: [], rows: [] });
});

test('표 읽기: 구분 줄이 있는 표만, 코드 블록 안의 표는 건너뛰고, 행이 가장 많은 표를 쓴다', () => {
  const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '```', '| x | y |', '| --- | --- |', '| 9 | 9 |', '```', '', '| c | d |', '| --- | --- |', '| 3 | 4 |', '| 5 | 6 |', '', '| 구분줄 없음 | 표 아님 |', '| 1 | 2 |'].join('\n');
  const tables = CM.tablesOf(md);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables.map((t) => t.header), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(tables[1].rows, [['3', '4'], ['5', '6']]);
  const r = CM.compareTables([{ id: 'x', text: md }]);
  assert.deepEqual(r.rows.map((x) => x.key), ['3', '5']); // 행이 더 많은 두 번째 표
  assert.deepEqual(CM.tablesOf('| a | b |\n| --- | --- |\n| 이스케이프 \\| 파이프 | 2 |')[0].rows, [['이스케이프 | 파이프', '2']]);
});

test('보기 방식 이름: 모르는 값은 나란히', () => {
  assert.deepEqual(CM.MODES, ['columns', 'align', 'code', 'table']);
  assert.equal(CM.normalizeMode('code'), 'code');
  assert.equal(CM.normalizeMode('weird'), 'columns');
  assert.equal(CM.normalizeMode(undefined), 'columns');
});

// ---------- 화면 그리기 (가짜 DOM) ----------
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
      const self = this;
      this.classList = {
        add: (c) => (self.className = `${self.className} ${c}`.trim()),
        toggle: (c, on) => (on ? self.classList.add(c) : (self.className = self.className.split(' ').filter((x) => x !== c).join(' '))),
        contains: (c) => self.className.split(' ').includes(c),
      };
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
  }
  return { El, document: { createElement: (t) => new El(t), createTextNode: (s) => String(s) } };
}
const walk = (node, out = []) => {
  if (typeof node === 'string' || !node) return out;
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
};
const withClass = (root, cls) => walk(root).filter((n) => n.className && n.className.split(' ').includes(cls));

function renderMode(mode, answers, { base = 'a', diff = false } = {}) {
  const dom = fakeDom();
  const ctx = { MLA: { compareModes: CM }, document: dom.document, t: (k, v) => i18n.t(k, v), compareView: { mode }, window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/compare-modes.js'), ctx);
  const cols = new dom.El('div');
  const handled = ctx.window.renderCompareMode(cols, answers, base, diff);
  return { cols, handled };
}
const ANSWERS = [
  { id: 'a', name: 'Gemini', color: '#4285f4', text: A1 + '\n\n```js\nconst a = 1;\n```', md: `${A1}\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${T1}` },
  { id: 'b', name: 'ChatGPT', color: '#10a37f', text: A2, md: `${A2}\n\n\`\`\`js\nconst a = 2;\nconst b = 1;\n\`\`\`\n\n${T2}` },
  { id: 'c', name: 'Claude', color: '#d97757', text: '', md: '' },
];

test('그리기: 나란히는 건드리지 않고(false), 문단 맞추기는 줄마다 칸이 AI 수만큼, 기준 · 이 답변에만 있음 표시', () => {
  assert.equal(renderMode('columns', ANSWERS).handled, false);
  assert.equal(renderMode('weird', ANSWERS).handled, false);
  const { cols, handled } = renderMode('align', ANSWERS);
  assert.equal(handled, true);
  assert.equal(cols.style.gridTemplateColumns, '1fr');
  const grid = withClass(cols, 'cmp-grid')[0];
  assert.equal(grid.style.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))');
  const cells = withClass(cols, 'cmp-cell');
  assert.equal(cells.length % 3, 0);
  assert.ok(cells.some((c) => c.classList.contains('base')));
  assert.ok(cells.some((c) => c.classList.contains('only') && /라이선스/.test(c.textContent)));
  assert.ok(cells.some((c) => c.classList.contains('none') && c.textContent === '')); // 글이 없는 Claude 칸은 비어 있다
  assert.match(withClass(cols, 'cmp-note')[0].textContent, /Gemini 답변을 기준으로/);
  assert.equal(withClass(cols, 'cmp-head').length, 3);
  assert.match(renderMode('align', [{ id: 'a', name: 'A', text: '' }]).cols.textContent, /맞출 답변이 없습니다/);
});

test('그리기: 코드만은 AI마다 코드 블록, 차이 강조를 켜면 기준에 없는 줄에 표시, 코드가 없으면 안내', () => {
  const { cols } = renderMode('code', ANSWERS, { diff: true });
  const pres = withClass(cols, 'cmp-code');
  assert.equal(pres.length, 2);
  assert.equal(pres[0].textContent, 'const a = 1;');
  assert.equal(pres[0].dataset.lang, 'js');
  const lines = withClass(cols, 'cmp-line');
  assert.deepEqual(lines.filter((l) => l.classList.contains('new')).map((l) => l.textContent.trim()), ['const a = 2;', 'const b = 1;']);
  assert.match(withClass(cols, 'cmp-note')[0].textContent, /Gemini 코드에 없는 줄/);
  assert.match(renderMode('code', [{ id: 'a', name: 'A', text: '글만', md: '글만' }]).cols.textContent, /어느 답변에도 코드 블록이 없습니다/);
  assert.equal(withClass(renderMode('code', ANSWERS).cols, 'cmp-line').length, 0); // 차이 강조를 끄면 그대로
});

test('그리기: 표 비교는 항목 줄마다 AI별 칸, 다른 항목 · 한쪽에만 있는 항목에 표시, 표가 없으면 안내', () => {
  const { cols } = renderMode('table', ANSWERS);
  const keys = withClass(cols, 'cmp-key');
  assert.deepEqual(keys.map((k) => k.children[0] || k._text).length, 4);
  const flagged = keys.filter((k) => k.classList.contains('flag'));
  assert.equal(flagged.length, 3); // 출시(다름) · 타입 · 성능(한쪽에만)
  assert.ok(withClass(cols, 'an-agree-badge').some((b) => b.textContent === '다름'));
  assert.ok(withClass(cols, 'an-unique-badge').some((b) => /일부 답변에 없음/.test(b.textContent)));
  assert.match(withClass(cols, 'cmp-note')[0].textContent, /항목 4개 중 다르거나 한쪽에만 있는 것 3개/);
  assert.match(withClass(cols, 'cmp-note')[1].textContent, /표가 없는 답변: Claude/);
  assert.ok(withClass(cols, 'cmp-th').some((h) => /Python/.test(h.textContent)));
  assert.match(renderMode('table', [{ id: 'a', name: 'A', text: '글', md: '글' }]).cols.textContent, /표로 답한 답변이 없습니다/);
});

test('비교 화면 연결: 보기 고르기 · 저장 · 기준 고르기가 문단 맞추기 · 코드에도 쓰이고, 확장에도 들어간다', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /<select id="compareMode"[^>]*>\s*<option value="columns"[^>]*><\/option>\s*<option value="align"[^>]*><\/option>\s*<option value="code"[^>]*><\/option>\s*<option value="table"/);
  assert.ok(html.indexOf('shared/analysis.js') < html.indexOf('shared/compare-modes.js'));
  assert.ok(html.indexOf('src="chain-views.js"') < html.indexOf('src="compare-modes.js"'));
  const views = read('src/renderer/renderer-views.js');
  assert.match(views, /compareView\.mode = MLA\.compareModes\.normalizeMode\(saved\.mode\)/);
  assert.match(views, /JSON\.stringify\(\{ tab: compareView\.tab, diff: compareView\.diff, mode: compareView\.mode \}\)/);
  assert.match(views, /if \(window\.renderCompareMode\(cols, answers, compareView\.base, compareView\.diff\)\) return;/);
  assert.match(read('scripts/build-extension.js'), /'compare-modes\.js'/);
  assert.match(read('extension/app.html'), /lib\/shared\/compare-modes\.js/);
  assert.match(read('extension/app.html'), /lib\/renderer\/compare-modes\.js/);
});

test('분석 화면 연결: 합의율 · 같은 입장 수 · 출처 칸이 비교 · 기록 화면에서 같이 그려진다', () => {
  const views = read('src/renderer/renderer-views.js');
  assert.match(views, /AN\.agreementSummary\(res, names\)/);
  assert.match(views, /t\('analysis\.rate', \{ n: agree\.rate \}\)/);
  assert.match(views, /AN\.extractSources\(srcItems\)/);
  assert.match(views, /sources: compareView\.answers/);
  assert.match(read('src/renderer/history-view.js'), /analysisBlock\(analyses\[0\], \{ onJump: jump, sources \}\)/);
  assert.match(read('src/renderer/chain-views.js'), /analysisBlock\(list\[pick\.b\], \{ onJump, sources \}\)/);
  // 앱 안에서는 링크를 열지 않는다 (복사만)
  assert.ok(!/openExternal|window\.open|location\.href\s*=/.test(views.slice(views.indexOf('출처 (v0.32.0)'), views.indexOf('function answerColumn'))));
});
