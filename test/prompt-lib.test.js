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
  assert.equal(lib.activeSkill, null);
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
