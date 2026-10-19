'use strict';
// 프롬프트 라이브러리·스킬 (v0.9.0) 단위 테스트:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/shared/prompt-lib');

test('변수 읽기: 이름 · 기본값 · 고르기 · 앱이 채우는 값 제외 · 중복 한 번', () => {
  const vars = P.parseVars('{{언어}}로 {{관점|보안}} 리뷰, 톤 {{톤:격식, 친근 ,간결}} {{ 언어 }} {{오늘}} {{프로젝트}} {q}');
  assert.deepEqual(vars, [
    { name: '언어', def: '', choices: null },
    { name: '관점', def: '보안', choices: null },
    { name: '톤', def: '격식', choices: ['격식', '친근', '간결'] },
  ]);
});

test('채우기: 값 · 기본값 · 고르기 첫 값 · {q} · {q}가 없으면 뒤에 붙임', () => {
  const tpl = '{{언어}} 코드를 {{관점|보안}} 위주로, 톤은 {{톤:격식,친근}}.\n\n{q}';
  assert.equal(P.fillTemplate(tpl, '코드', { 언어: 'TS' }), 'TS 코드를 보안 위주로, 톤은 격식.\n\n코드');
  assert.equal(P.fillTemplate(tpl, '코드', { 언어: 'Go', 관점: '성능', 톤: '친근' }), 'Go 코드를 성능 위주로, 톤은 친근.\n\n코드');
  assert.equal(P.fillTemplate('{{대상}}을 요약해 줘', '본문', { 대상: '기사' }), '기사을 요약해 줘\n\n본문');
  assert.equal(P.fillTemplate('{{대상}}만', '', { 대상: 'x' }), 'x만');
  assert.match(P.fillTemplate('{{오늘}} · {{프로젝트}}', '', {}, { 프로젝트: 'app' }), /^\d{4}-\d{2}-\d{2} · app$/);
  assert.equal(P.fillTemplate('{q}', '그대로', {}), '그대로');
});

test('스킬 파일: 앞머리 읽기 · 없으면 제목 · 본문 없으면 null · 다시 쓰기', () => {
  const s = P.parseSkillMd('---\nname: "코드 리뷰어"\ndescription: 보안 위주\n---\n\n너는 리뷰어다.\n');
  assert.deepEqual(s, { name: '코드 리뷰어', description: '보안 위주', body: '너는 리뷰어다.' });
  assert.equal(P.parseSkillMd('# 번역가\n자연스럽게 옮겨라').name, '번역가');
  assert.equal(P.parseSkillMd('---\nname: x\n---\n   '), null);
  assert.deepEqual(P.parseSkillMd(P.toSkillMd(s)), s);
  assert.match(P.skillPrefix(s), /### 지침 \(스킬: 코드 리뷰어\)[\s\S]*너는 리뷰어다\.[\s\S]*### 질문\n\n$/);
});

test('라이브러리 정리: 모양 틀린 항목 버림 · 길이 자름 · 없는 스킬 선택은 지움', () => {
  const lib = P.normalizeLibrary({
    templates: [{ id: 'u-1', name: 'A', text: '{q}' }, { name: 'empty', text: '  ' }, null, { id: '../x', name: 'B', text: 'x'.repeat(30000) }],
    skills: [{ id: 's-1', name: 'S', body: 'b' }, { name: 'no body' }],
    activeSkill: 's-9',
    skillMode: 'weird',
    lastVars: { 'u-1': { 언어: 'TS', n: 3 } },
  });
  assert.equal(lib.templates.length, 2);
  assert.equal(lib.templates[0].id, 'u-1');
  assert.match(lib.templates[1].id, /^u-/);
  assert.notEqual(lib.templates[1].id, '../x');
  assert.equal(lib.templates[1].text.length, P.LIMITS.templateText);
  assert.equal(lib.skills.length, 1);
  assert.deepEqual(lib.activeSkills, []);
  assert.equal(lib.skillMode, 'first');
  assert.deepEqual(lib.lastVars, { 'u-1': { 언어: 'TS' } });
});

test('내보내기 → 가져오기: 새 id, 다른 파일은 거절', () => {
  const lib = P.normalizeLibrary({ templates: [{ id: 'u-1', name: 'A', text: 'a {q}' }], skills: [{ id: 's-1', name: 'S', body: 'b' }] });
  const back = P.importLibrary(P.exportLibrary(lib));
  assert.equal(back.templates[0].text, 'a {q}');
  assert.notEqual(back.templates[0].id, 'u-1');
  assert.equal(back.skills[0].name, 'S');
  assert.throws(() => P.importLibrary('not json'), /JSON/);
  assert.throws(() => P.importLibrary('{"a":1}'), /라이브러리 파일이 아닙니다/);
});

// ---------- v0.9.1: 여러 스킬 · 정리 · 압축 ----------

const sk = (id, name, body, extra = {}) => ({ id, name, description: '', body, compact: '', compactOf: '', useCompact: true, dropExamples: false, noWarn: false, ...extra });

test('켠 스킬: 예전 activeSkill 옮기기 · 없는 id·중복 제거 · 최대 3개 · 권장 기준 범위', () => {
  const skills = ['s-1', 's-2', 's-3', 's-4'].map((id) => ({ id, name: id, body: 'b' }));
  assert.deepEqual(P.normalizeLibrary({ skills, activeSkill: 's-2' }).activeSkills, ['s-2']);
  assert.deepEqual(P.normalizeLibrary({ skills, activeSkills: ['s-4', 's-9', 's-4', 's-1', 's-2', 's-3'] }).activeSkills, ['s-4', 's-1', 's-2']);
  assert.deepEqual(P.normalizeLibrary({}).compressWarn, { one: 5000, total: 8000 });
  assert.deepEqual(P.normalizeLibrary({ compressWarn: { one: 10, total: 99999 } }).compressWarn, { one: 1000, total: 30000 });
});

test('규칙 기반 정리: 주석·구분선·굵게·빈 줄·같은 문장 반복 · 코드 블록은 그대로 · 예시 절 빼기', () => {
  const body = [
    '<!-- 메모 -->',
    '# 규칙',
    '**반드시** 한국어로 답한다.   ',
    '',
    '',
    '',
    '---',
    '모든 답변 끝에 출처를 붙인다. 이것은 중요하다.',
    '모든 답변 끝에 출처를 붙인다. 이것은 중요하다.',
    '```',
    '**코드는 그대로**',
    '```',
    '## 예시',
    '질문: 안녕 → 답: 안녕하세요',
    '## 출력 형식',
    '표로 쓴다.',
  ].join('\n');
  const clean = P.cleanSkill(body);
  assert.ok(!clean.includes('메모') && !clean.includes('---'));
  assert.ok(clean.includes('반드시 한국어로') && clean.includes('**코드는 그대로**'));
  assert.equal(clean.split('모든 답변 끝에 출처').length, 2, '같은 문장은 한 번');
  assert.ok(!/\n{3,}/.test(clean));
  assert.ok(clean.includes('## 예시'));
  const noEx = P.cleanSkill(body, { dropExamples: true });
  assert.ok(!noEx.includes('안녕하세요') && noEx.includes('## 출력 형식') && noEx.includes('표로 쓴다.'));
});

test('보내는 글: 압축본 우선 · 원문을 바꾸면 압축본이 오래됨', () => {
  const s = sk('s-1', 'A', '원문 지침입니다', { compact: '압축본', compactOf: P.textHash('원문 지침입니다') });
  assert.equal(P.sendBody(s), '압축본');
  assert.equal(P.sendBody({ ...s, useCompact: false }), '원문 지침입니다');
  assert.equal(P.compactStale(s), false);
  assert.equal(P.compactStale({ ...s, body: '고친 원문' }), true);
});

test('압축 권장 단계: 기본 5,000 / 10,000자, 매 질문마다는 0.6배', () => {
  const w = { one: 5000, total: 8000 };
  assert.equal(P.compressLevel(1500, w, 'first'), 'none');
  assert.equal(P.compressLevel(3000, w, 'first'), 'info');
  assert.equal(P.compressLevel(5000, w, 'first'), 'warn');
  assert.equal(P.compressLevel(10000, w, 'first'), 'strong');
  assert.equal(P.compressLevel(3000, w, 'every'), 'warn');
  assert.deepEqual(P.warnLimits(w, 'first'), { info: 2000, one: 5000, strong: 10000, total: 8000, totalAlert: 15000 });
  assert.deepEqual(P.warnLimits(w, 'every'), { info: 2000, one: 3000, strong: 6000, total: 5000, totalAlert: 9375 });
});

test('묶음 지침: 1개는 예전 모양, 여러 개는 번호와 우선순위 · 합계 한도', () => {
  const a = sk('s-1', '리뷰어', '리뷰 규칙');
  const b = sk('s-2', '보안', '보안 규칙');
  assert.match(P.skillPrefix([a]), /^### 지침 \(스킬: 리뷰어\)/);
  const two = P.skillPrefix([a, b]);
  assert.match(two, /스킬 2개 — 위에 있는 것이 우선/);
  assert.ok(two.indexOf('#### 1. 리뷰어') < two.indexOf('#### 2. 보안'));
  assert.match(two, /### 질문\n\n$/);
  assert.equal(P.prefixSize([a, b]).over, false);
  const big = sk('s-3', '긴 것', 'x'.repeat(20000));
  assert.equal(P.prefixSize([big, { ...big, id: 's-4' }]).over, true);
});

test('패널별 붙일 글: 처음이면 전부 · 같으면 없음 · 바뀌면 바뀐 점만 · 매 질문마다는 항상 · 모두 끄면 그만 따르라고', () => {
  const a = sk('s-1', '리뷰어', '리뷰 규칙');
  const b = sk('s-2', '보안', '보안 규칙');
  const names = { 's-1': '리뷰어', 's-2': '보안' };
  const nameOf = (id) => names[id];
  assert.deepEqual(P.prefixFor([a, b], null, 'first', nameOf).ids, ['s-1', 's-2']);
  assert.equal(P.prefixFor([a, b], ['s-1', 's-2'], 'first', nameOf), null);
  const changed = P.prefixFor([b], ['s-1'], 'first', nameOf);
  assert.match(changed.text, /따르지 마: "리뷰어"/);
  assert.match(changed.text, /#### 보안\n보안 규칙/);
  assert.deepEqual(changed.ids, ['s-2']);
  assert.match(P.prefixFor([b, a], ['s-1', 's-2'], 'first', nameOf).text, /스킬 2개/, '순서만 바뀌면 다시 전부');
  assert.ok(P.prefixFor([a], ['s-1'], 'every', nameOf));
  const off = P.prefixFor([], ['s-1'], 'first', nameOf);
  assert.match(off.text, /따르지 마: "리뷰어"/);
  assert.deepEqual(off.ids, []);
  assert.equal(P.prefixFor([], [], 'first', nameOf), null);
  assert.equal(P.prefixFor([], null, 'first', nameOf), null);
});

test('압축 요청 글과 답변에서 압축본 꺼내기', () => {
  const req = P.compressRequest(sk('s-1', '리뷰어', '**규칙** 하나'), 1200);
  assert.match(req, /1,200자 이내/);
  assert.match(req, /규칙 하나/);
  assert.equal(P.extractCompressed('설명\n```markdown\n- 규칙 1\n- 규칙 2\n```\n끝'), '- 규칙 1\n- 규칙 2');
  assert.equal(P.extractCompressed('- 코드 블록 없이 준 답'), '- 코드 블록 없이 준 답');
});

test('압축본 꺼내기: 가장 긴 코드 블록 · 들여쓴 울타리 · 닫히지 않은 블록 · 안쪽의 다른 울타리', () => {
  assert.equal(P.extractCompressed('```\n짧은 것\n```\n설명\n```markdown\n- 규칙 1\n- 규칙 2\n- 규칙 3\n```'), '- 규칙 1\n- 규칙 2\n- 규칙 3');
  assert.equal(P.extractCompressed('  ```text\n  - 들여쓴 규칙\n  ```'), '- 들여쓴 규칙');
  assert.equal(P.extractCompressed('결과:\n```\n- 끝나지 않은\n- 블록'), '- 끝나지 않은\n- 블록');
  assert.equal(P.extractCompressed('````md\n- 규칙\n```js\nx()\n```\n````'), '- 규칙\n```js\nx()\n```');
  assert.equal(P.extractCompressed('```\n\n```\n그냥 글'), '```\n\n```\n그냥 글');
});
