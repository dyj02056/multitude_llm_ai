'use strict';
// 작업 프리셋 · 스킬 이전 버전 (v0.29.0) 단위 테스트:  npm test
// [쉽게 말하면] 프리셋 저장 모양 검사 · 지금 설정으로 만들기 · 적용 계획 · 라이브러리 내보내기/가져오기, 스킬 이전 버전 남기기 · 되돌리기 · 차이가 맞는지 봅니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/shared/prompt-lib');
const Diff = require('../src/shared/vendor/diff');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const skills = [
  { id: 's-1', name: 'A', body: 'a' },
  { id: 's-2', name: 'B', body: 'b' },
];

test('프리셋 검사: 모양 틀린 칸은 버리고, 없는 스킬 · 이상한 id는 빼고, 한도를 지킨다', () => {
  const lib = P.normalizeLibrary({
    skills,
    presets: [
      {
        id: 'p-ok',
        name: 'x'.repeat(100),
        template: { id: 'summary', vars: { 언어: 'TS', n: 3 } },
        skills: ['s-2', 's-9', 's-2', 's-1', '../x'],
        selected: ['gemini', 'chatgpt', 'Bad Id', 'gemini', 'a', 'b', 'c', 'd', 'e'],
        targets: ['chatgpt', 'zz'],
        layout: 'grid',
        synth: { target: 'chatgpt', auto: 'yes' },
        debate: { participants: ['gemini', 'chatgpt'], rounds: 9, judge: 'local' },
      },
      null,
      'str',
      { name: '' },
    ],
  });
  assert.equal(lib.presets.length, 2);
  const p = lib.presets[0];
  assert.equal(p.id, 'p-ok');
  assert.equal(p.name.length, P.LIMITS.name);
  assert.deepEqual(p.template, { id: 'summary', vars: { 언어: 'TS' } });
  assert.deepEqual(p.skills, ['s-2', 's-1']);
  assert.equal(p.selected.length, 6);
  assert.ok(!p.selected.includes('Bad Id'));
  assert.deepEqual(p.targets, ['chatgpt']);
  assert.deepEqual(p.synth, { target: 'chatgpt', auto: false });
  assert.deepEqual(p.debate, { participants: ['gemini', 'chatgpt'], rounds: 0, judge: 'local' });
  assert.match(lib.presets[1].id, /^p-/);
  assert.equal(lib.presets[1].name, '이름 없는 프리셋');
  const many = P.normalizeLibrary({ presets: Array.from({ length: 40 }, (_, i) => ({ name: `p${i}` })) });
  assert.equal(many.presets.length, P.LIMITS.presets);
});

test('지금 설정으로 프리셋 만들기: 템플릿 없음(none)은 빈 값, 켠 스킬 순서 그대로', () => {
  const p = P.presetFromState({ name: '리뷰', templateId: 'none', vars: {}, activeSkills: ['s-2', 's-1'], selected: ['gemini', 'claude'], targets: ['claude'], layout: 'row', synthTarget: 'claude', autoSynth: true, debate: { participants: ['gemini', 'claude'], rounds: 2, judge: 'claude' } }, 123);
  assert.equal(p.template.id, '');
  assert.deepEqual(p.skills, ['s-2', 's-1']);
  assert.equal(p.at, 123);
  assert.deepEqual(p.synth, { target: 'claude', auto: true });
  assert.equal(p.debate.rounds, 2);
});

test('적용 계획: 같은 패널이면 다시 열지 않고, 쓸 수 없는 서비스 · 지운 스킬 · 템플릿은 알린다', () => {
  const p = P.normalizePreset({ name: 'x', template: { id: 'u-gone' }, skills: ['s-1', 's-2'], selected: ['gemini', 'claude', 'local'], layout: 'weird' });
  const plan = P.presetPlan(p, { openIds: ['claude', 'gemini'], available: ['gemini', 'claude'], hasTemplate: () => false, hasSkill: (id) => id === 's-1', layouts: ['grid', 'row'] });
  assert.equal(plan.panels, null); // gemini · claude는 이미 열림 (local은 쓸 수 없음)
  assert.deepEqual(plan.missing, { services: ['local'], skills: ['s-2'], template: 'u-gone' });
  assert.deepEqual(plan.skills, ['s-1']);
  assert.equal(plan.template, '');
  assert.equal(plan.layout, '');
  const other = P.presetPlan(p, { openIds: ['gemini'], available: ['gemini', 'claude', 'local'] });
  assert.deepEqual(other.panels, ['gemini', 'claude', 'local']);
});

test('라이브러리 내보내기 → 가져오기: 프리셋도 함께, 템플릿 · 스킬 id를 새 id로 바꿔 잇는다', () => {
  const lib = P.normalizeLibrary({
    templates: [{ id: 'u-1', name: 'T', text: '{q}' }],
    skills,
    presets: [{ id: 'p-1', name: 'P', template: { id: 'u-1' }, skills: ['s-2'], selected: ['gemini'] }, { name: 'builtin', template: { id: 'summary' } }],
  });
  const back = P.importLibrary(P.exportLibrary(lib));
  assert.equal(back.presets.length, 2);
  const [p, q] = back.presets;
  assert.notEqual(p.id, 'p-1');
  assert.equal(p.template.id, back.templates[0].id); // 새 템플릿 id
  assert.deepEqual(p.skills, [back.skills.find((s) => s.name === 'B').id]);
  assert.equal(q.template.id, 'summary'); // 기본 템플릿은 그대로
  // 예전 파일(프리셋 없음)도 그대로 읽는다
  assert.deepEqual(P.importLibrary({ kind: 'multitude-llm-library', templates: [], skills }).presets, []);
});

test('스킬 이전 버전: 본문이 바뀔 때만 남기고, 같은 본문은 두 번 남기지 않고, 최대 10개 · 글자 합계 한도', () => {
  const s = { id: 's-1', name: 'S', body: 'v1', versions: [] };
  assert.deepEqual(P.withVersion(s, 'v1'), []); // 그대로 저장
  const v = P.withVersion(s, 'v2', 50);
  assert.deepEqual(v, [{ at: 50, body: 'v1', name: 'S' }]);
  assert.deepEqual(P.withVersion({ ...s, versions: v }, 'v3', 60), v); // 맨 앞과 같은 본문은 다시 남기지 않음
  let cur = { ...s };
  for (let i = 2; i <= 15; i++) cur = { ...cur, versions: P.withVersion(cur, `v${i}`, i), body: `v${i}` };
  assert.equal(cur.versions.length, P.LIMITS.versions);
  assert.equal(cur.versions[0].body, 'v14'); // 최신이 앞
  const big = P.normalizeVersions(Array.from({ length: 10 }, (_, i) => ({ at: i, body: 'x'.repeat(15000) })));
  assert.ok(big.reduce((n, x) => n + x.body.length, 0) <= P.LIMITS.versionChars);
  assert.equal(big.length, 4);
  // 저장된 모양이 틀린 버전은 버린다
  const lib = P.normalizeLibrary({ skills: [{ id: 's-1', name: 'S', body: 'b', versions: [{ body: '' }, null, { at: 'x', body: 'old' }] }] });
  assert.deepEqual(lib.skills[0].versions, [{ at: 0, body: 'old', name: '' }]);
});

test('되돌리기 = 그 버전 본문으로 새로 저장 (지금 본문은 이전 버전으로), 차이는 줄 단위', () => {
  const s = { id: 's-1', name: 'S', body: '규칙 1\n규칙 2 고침', versions: [{ at: 1, body: '규칙 1\n규칙 2', name: 'S' }] };
  const r = P.restoreVersion(s, 0, 9);
  assert.equal(r.body, '규칙 1\n규칙 2');
  assert.equal(r.versions[0].body, '규칙 1\n규칙 2 고침');
  assert.equal(r.versions.length, 2);
  assert.equal(P.restoreVersion(s, 5), null);
  const d = P.versionDiff('a\nb\nc', 'a\nB\nc\nd', Diff);
  assert.deepEqual(d.map((x) => `${x.type}:${x.text}`), ['same:a', 'del:b', 'add:B', 'same:c', 'add:d']);
});

test('연결: 라이브러리 화면 프리셋 탭 · 입력창 프리셋 고르기 · 이전 버전 칸, 저장할 때 이전 버전을 남김', () => {
  const html = read('src/renderer/index.html');
  for (const id of ['data-libtab="presets"', 'id="presetSelect"', 'id="libPresetEditor"', 'id="libVersions"', 'id="libVersionRestore"', 'src="library-presets.js"']) assert.ok(html.includes(id), id);
  assert.ok(html.indexOf('src="library.js"') < html.indexOf('src="library-presets.js"'));
  const lib = read('src/renderer/library.js');
  assert.match(lib, /versions: PL\.withVersion\(c\.item, text\)/);
  assert.match(lib, /window\.libApi = \{/);
  const pre = read('src/renderer/library-presets.js');
  assert.match(pre, /\[쉽게 말하면\]/);
  assert.match(pre, /host\.openModels\(panels\)/); // 패널이 다르면 모델 열기 길로
  assert.match(pre, /confirm\(t\('preset\.confirmPanels'/);
  const build = read('scripts/build-extension.js');
  assert.ok(build.includes("'library-presets.js'") && build.includes("'settings-transfer-ui.js'"));
});
