'use strict';
// AI에게 보내는 글이 화면 언어를 따르는지 (v0.31.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 영어 화면이면 종합 · 분석 · 토론 · 넘기기 · 스킬 · 웹페이지 질문 · 프로젝트 모드 요청 글이 영어로 나가는지
//   - 영어 요청 글이 알려 준 형식대로 AI가 답하면, 답을 읽는 부품(분석 표 · 수정안 · 계획)이 그대로 읽는지
//   - 한국어 화면에서는 예전과 같은 글이 나가는지 (다른 테스트가 글자까지 보지만, 언어를 오간 뒤에도 그런지)
const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/shared/i18n');
const synth = require('../src/shared/synth');
const chain = require('../src/shared/chain');
const A = require('../src/shared/analysis');
const PC = require('../src/shared/project-context');
const PU = require('../src/shared/project-upload');
const PX = require('../src/shared/patch');
const PL = require('../src/shared/prompt-lib');
const WA = require('../src/shared/web-ask');
const SP = require('../src/shared/side-panel');
const CM = require('../src/shared/commit-msg');

const HANGUL = /[가-힣]/;
/** 영어로 바꿔 fn을 돌리고 꼭 한국어로 되돌린다 (다른 테스트 파일은 한국어를 기대한다) */
function inEnglish(fn) {
  i18n.setLang('en');
  try {
    return fn();
  } finally {
    i18n.setLang('ko');
  }
}

const answers = [
  { name: 'Gemini', text: 'Paris is the capital.' },
  { name: 'ChatGPT', text: 'The capital is Paris.' },
];

test('사전: prompt.* 키는 두 언어에 모두 있고, 영어 글에는 한글이 없다', () => {
  const ko = Object.keys(i18n.strings.ko).filter((k) => k.startsWith('prompt.'));
  assert.ok(ko.length > 80, `prompt 키 ${ko.length}개`);
  for (const k of ko) assert.ok(!HANGUL.test(i18n.strings.en[k]), `en ${k}: ${i18n.strings.en[k]}`);
});

test('종합 · 분석 요청: 영어 화면이면 영어, 한국어로 돌아오면 한국어', () => {
  const en = inEnglish(() => ({
    text: synth.buildSynthPrompt({ question: 'Capital of France?', answers, judgeAnswered: true }),
    code: synth.buildSynthPrompt({ question: 'Fix the bug', answers, mode: 'code' }),
    analysis: synth.buildSynthPrompt({ question: 'Capital of France?', answers, mode: 'analysis', judgeAnswered: true, judgeName: 'Claude' }),
  }));
  for (const [name, p] of Object.entries(en)) assert.ok(!HANGUL.test(p), `${name}: ${p}`);
  assert.match(en.text, /\[Original question\]\nCapital of France\?/);
  assert.match(en.text, /\[Gemini's answer\]\nParis is the capital\./);
  assert.match(en.text, /with your previous answer/);
  assert.match(en.code, /"File: path"/);
  assert.match(en.code, /<<<<<<< SEARCH/);
  assert.match(en.code, /DELETE_FILES: path1, path2/);
  assert.match(en.analysis, /\| Issue \| Gemini \| ChatGPT \| Claude \| Verdict \|/);
  for (const h of ['Common ground', 'Disagreements', 'Weak evidence', 'Final answer']) assert.ok(en.analysis.includes(`## ${h}`), h);

  const ko = synth.buildSynthPrompt({ question: '프랑스 수도?', answers });
  assert.match(ko, /^같은 질문에 대해 다른 AI들이 아래와 같이 답했습니다\./);
  assert.match(ko, /위 답변들을 비교해서 다음을 정리해 주세요\.\n1\) 오류나 부정확한 부분/);
});

test('분석 답 읽기: 영어 머리글 · 표도 읽고, 한국어 머리글도 그대로 읽는다', () => {
  const md = [
    '## Common ground',
    '- Paris is the capital of France',
    '',
    '## Disagreements',
    '| Issue | Gemini | ChatGPT | Verdict |',
    '| --- | --- | --- | --- |',
    '| Population | 2.1 million | 11 million (metro) | Both right; they count different areas |',
    '',
    '## Weak evidence',
    '- [ChatGPT] "largest city in the EU" needs a source',
    '',
    '## Final answer',
    'Paris.',
  ].join('\n');
  const r = A.parseAnalysis(md, { names: ['Gemini', 'ChatGPT'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.common, ['Paris is the capital of France']);
  assert.equal(r.disagreements.length, 1);
  assert.equal(r.disagreements[0].topic, 'Population');
  assert.deepEqual(r.disagreements[0].positions.map((p) => p.name), ['Gemini', 'ChatGPT']);
  assert.match(r.disagreements[0].verdict, /Both right/);
  assert.deepEqual(r.unsupported, [{ name: 'ChatGPT', text: '"largest city in the EU" needs a source' }]);
  assert.equal(r.final, 'Paris.');

  assert.equal(A.sectionOf('## final answer'), 'final'); // 대소문자 · 꾸밈은 너그럽게
  assert.equal(A.sectionOf('**Weak Evidence**'), 'unsupported');
  assert.equal(A.sectionOf('## 이견'), 'disagree');
  assert.equal(A.sectionOf('## 최종 답변'), 'final');
  // 이견이 없다는 영어 답
  const none = A.parseAnalysis('## Common ground\n- a\n\n## Disagreements\n- None\n\n## Weak evidence\n- None\n\n## Final answer\nok', { names: ['Gemini'] });
  assert.equal(none.ok, true);
  assert.deepEqual(none.disagreements, []);
  assert.deepEqual(none.unsupported, []);
});

test('넘기기 · 토론 요청: 영어', () => {
  const en = inEnglish(() => ({
    review: chain.buildHandoffPrompt({ intent: 'review', question: 'Q?', fromName: 'Gemini', answer: 'A.' }),
    odd: chain.buildHandoffPrompt({ intent: 'nope', question: '', fromName: 'Gemini', answer: 'A.' }),
    debate: chain.buildDebatePrompt({ question: 'Q?', round: 2, rounds: 2, selfName: 'Claude', others: [{ name: 'Gemini', text: 'A.' }] }),
    judge: chain.buildDebateJudgePrompt({ question: '', positions: [{ name: 'Gemini', text: 'A.' }], rounds: 2 }),
    long: chain.buildHandoffPrompt({ intent: 'continue', fromName: 'Gemini', answer: 'x'.repeat(20000) }),
  }));
  for (const [name, p] of Object.entries(en)) assert.ok(!HANGUL.test(p), `${name}: ${p.slice(0, 300)}`);
  assert.match(en.review, /^Here is an answer written by another AI \(Gemini\)\./);
  assert.match(en.review, /Please review the answer above carefully\./);
  assert.match(en.odd, /Please review the answer above carefully\./); // 모르는 의도는 검토로
  assert.ok(!en.odd.includes('[Original question]'));
  assert.match(en.debate, /^\[Debate round 2\/2\]/);
  assert.match(en.debate, /your \(Claude\) previous answer/);
  assert.match(en.debate, /\(this is the final round\)$/);
  assert.match(en.judge, /\(no question\)/);
  assert.match(en.judge, /## Remaining disagreements/);
  assert.match(en.long, /…\(truncated\)/);
  // 한국어는 예전 글 그대로
  assert.match(chain.buildDebatePrompt({ question: 'Q', round: 1, rounds: 2, others: [] }), /당신의 이전 답변과 비교해 다음을 해 주세요\.\n1\) 다른 답변에서/);
});

test('프로젝트 모드 요청: 영어 답변 규칙의 예시를 수정안 읽기가 그대로 읽는다', () => {
  const en = inEnglish(() => ({
    rules: PC.RULES,
    plan: PC.PLAN_FIRST,
    step: PC.stepPrompt({ path: 'src/a.js', note: 'add a check' }, 0, 3),
    ctx: PC.buildContext({ project: { name: 'demo', paths: ['src/a.js', 'b.md'] }, files: [{ path: 'src/a.js', text: 'let a = 1;\n' }], request: '' }).text,
    follow: PC.buildFollowUp([{ path: 'b.md', text: '# b\n' }], [{ path: '.env', reason: 'x' }]),
    cont: PX.continuePrompt({ path: 'src/a.js', kind: 'edit', edits: [{ search: 'a', replace: 'b' }] }),
    refetch: PU.packRefetch({ path: 'src/a.js', text: 'x\n', mode: 'bundle', reason: 'truncated' }).text,
    inc: PU.packIncremental({ project: { name: 'demo', paths: ['src/a.js'] }, files: [{ path: 'src/a.js', text: 'x\n' }], same: [{ path: 'b.md', lines: 3 }], gone: ['c.js'], showLines: true, request: 'go' }).text,
    update: PU.packUpdate({ files: [{ path: 'src/a.js', text: 'x\n' }], deleted: ['c.js'], mode: 'files' }).text,
  }));
  for (const [name, p] of Object.entries(en)) assert.ok(!HANGUL.test(p), `${name}: ${p.slice(0, 400)}`);
  assert.match(en.rules, /^\[Answer rules\]/);
  assert.match(en.rules, new RegExp(`longer than ${PC.EDIT_LINES} lines`));
  assert.match(en.plan, /PLAN_FILES: path1, path2, path3/);
  assert.match(en.step, /^Following the plan, give only file 1\/3: src\/a\.js — add a check/);
  assert.match(en.ctx, /^\[Project: demo\] \(content of 1 of the 2 files/);
  assert.match(en.ctx, /\[File: src\/a\.js\]\n```js\nlet a = 1;\n```/);
  assert.match(en.ctx, /\[Request\]\n\(no request — please review the content above\)/);
  assert.match(en.follow, /\[Files not sent\]\n- \.env: x/);
  assert.match(en.cont, /"File: src\/a\.js \(continued\)"/);
  assert.match(en.refetch, /was long and got cut off/);
  assert.match(en.inc, /\[Unchanged since last sent\][^\n]*\n- b\.md \(3 lines\)/);
  assert.match(en.inc, /\[Deleted files\] \(sent before/);
  assert.match(en.inc, /has the current content of 1 changed file\(s\)\./);
  assert.match(en.update, /\[1 uploaded file\(s\) → real path\]/);

  // AI가 영어 규칙의 예시대로 답했다고 치고 읽어 본다
  const answer = [
    'Cause: off-by-one.',
    'File: src/short.js',
    '```js',
    'export const a = 2;',
    '```',
    'File: src/long.js',
    '```js',
    '<<<<<<< SEARCH',
    'const n = 1;',
    '=======',
    'const n = 2;',
    '>>>>>>> REPLACE',
    '```',
    'File: src/long.js (continued)',
    '```js',
    '<<<<<<< SEARCH',
    'const m = 1;',
    '=======',
    'const m = 2;',
    '>>>>>>> REPLACE',
    '```',
    'DELETE_FILES: src/old.js',
    'NEED_FILES: src/util.js',
  ].join('\n');
  const changes = PX.extractChanges(answer);
  const byPath = (p) => changes.filter((c) => c.path === p);
  assert.equal(byPath('src/short.js')[0].type, 'full');
  assert.ok(byPath('src/long.js').length >= 1 && byPath('src/long.js').every((c) => c.type === 'edit'));
  assert.ok(changes.some((c) => c.path === 'src/old.js' && c.isDelete));
  assert.deepEqual(PC.parseNeedFiles(answer), ['src/util.js']);
  assert.deepEqual(
    PC.parsePlanFiles('- src/a.js: add a check\n- b.md: update docs\nPLAN_FILES: src/a.js, b.md').map((f) => [f.path, f.note]),
    [['src/a.js', 'add a check'], ['b.md', 'update docs']],
  );

  // 한국어로 돌아오면 예전 글
  assert.match(PC.RULES, /^\[답변 규칙\]/);
  assert.match(PC.fileBlock('a.js', 'x'), /^\[파일: a\.js\]/);
});

test('스킬 · 웹페이지 질문 · 사이드탭 · 커밋 메시지 요청: 영어', () => {
  const page = { kind: 'page', at: Date.now(), title: 'Docs', url: 'https://example.com/a', text: 'body' };
  const en = inEnglish(() => ({
    one: PL.skillPrefix([{ name: 'Reviewer', body: 'Be strict.' }]),
    many: PL.skillPrefix([
      { name: 'A', body: 'a' },
      { name: 'B', body: 'b' },
    ]),
    change: PL.skillChangeNote([{ name: 'A', body: 'a' }], [{ name: 'B', body: 'b' }]),
    compress: PL.compressRequest({ name: 'Reviewer', body: 'Be strict.' }, 1200),
    selection: WA.selectionPrompt(WA.normalize({ ...page, kind: 'selection' })),
    pagePrompt: WA.pagePrompt(WA.normalize(page)),
    pageFile: WA.pageFile(WA.normalize(page)).text,
    untitled: WA.normalize({ kind: 'selection', at: Date.now(), text: 'x' }).title,
    inline: SP.inlinePrompt({ title: 'Docs', url: 'https://example.com/a', text: 'body' }, 'What is this?'),
    commit: CM.summaryPrompt(['src/a.js']),
  }));
  for (const [name, p] of Object.entries(en)) assert.ok(!HANGUL.test(p), `${name}: ${p.slice(0, 300)}`);
  assert.match(en.one, /^### Instructions \(skill: Reviewer\)/);
  assert.match(en.one, /### Question\n\n$/);
  assert.match(en.many, /^### Instructions \(2 skills/);
  assert.match(en.change, /stop following these instructions: "B"/);
  assert.match(en.compress, /at most 1,200 characters/);
  assert.match(en.selection, /Question: $/);
  assert.match(en.pagePrompt, /^The attached page\.md is the body of the web page 「Docs」\(https:\/\/example\.com\/a\)\./);
  assert.match(en.pageFile, /Source: https:\/\/example\.com\/a\nFetched: /);
  assert.equal(en.untitled, 'Web page');
  assert.match(en.inline, /Question: What is this\?$/);
  assert.match(en.commit, /single English line/);
  assert.match(PL.skillPrefix([{ name: '검토자', body: '엄격하게.' }]), /^### 지침 \(스킬: 검토자\)/);
});
