'use strict';
// 로드맵 (v0.38.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 계획서 분해 답(JSON) 읽기 · 검사, 작업 상태 · 선행 관계 · 편집, 진행률 · 번다운
//   - 진행 그림(SVG), docs/procedure.md · README.md 만들기 (표식 구역만 갱신, 기존 파일 보호, 비밀 정보 검사)
//   - 화면 연결 (창 · 버튼 · 문구 · 확장 프로그램 동기화)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const RM = require('../src/shared/roadmap');
const CH = require('../src/shared/roadmap-charts');
const DOCS = require('../src/shared/roadmap-docs');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ko = (fn) => {
  i18n.setLang('ko');
  return fn();
};

const ANSWER = `네, 나눴습니다.
\`\`\`json
{"title":"할 일 앱","milestones":[
 {"id":"m1","title":"기반","tasks":[
  {"id":"t1","title":"프로젝트 뼈대","desc":"폴더 · 빌드","deps":[],"files":["package.json","src/index.js"],"accept":"npm start가 뜬다","weight":2},
  {"id":"t2","title":"저장소","deps":["t1"],"files":["src/store.js"],"accept":"추가 · 삭제가 된다","weight":3}]},
 {"id":"m2","title":"화면","tasks":[
  {"id":"t3","title":"목록 화면","deps":["프로젝트 뼈대","t2"],"files":["src/ui.js"],"accept":"목록이 보인다","weight":3},
  {"id":"t4","title":"마무리","deps":["t3"],"accept":"","weight":1}]}]}
\`\`\``;
const NOW = '2026-11-17T09:00:00.000Z';
const fresh = () => ko(() => RM.parseDecomposition(ANSWER, { plan: '할 일 앱을 만든다', now: NOW }).roadmap);
const day = (n) => new Date(Date.parse(NOW) + n * 86400000).toISOString();

// ---------- 분해 답 읽기 ----------
test('분해 요청 글: 계획서 · 구조 · JSON 형식 안내가 들어 있고 영어도 된다', () => {
  const k = RM.buildDecomposePrompt({ plan: 'PLAN-TEXT', tree: 'src/\nREADME.md', lang: 'ko' });
  assert.ok(k.includes('PLAN-TEXT') && k.includes('src/') && k.includes('"milestones"') && k.includes('accept'));
  const en = RM.buildDecomposePrompt({ plan: 'PLAN-TEXT', lang: 'en' });
  assert.ok(en.includes('Read the project plan') && !en.includes('[현재 프로젝트 구조]'));
});

test('extractJson: 코드 블록 · 맨 JSON · 문자열 안의 중괄호 · 깨진 JSON', () => {
  assert.deepEqual(RM.extractJson('앞말\n```json\n{"a":1}\n```\n뒷말'), { a: 1 });
  assert.deepEqual(RM.extractJson('답: {"a":{"b":"}"}} 끝'), { a: { b: '}' } });
  assert.equal(RM.extractJson('JSON 없음'), null);
  assert.equal(RM.extractJson('```json\n{"a":\n```'), null);
});

test('parseDecomposition: 작업 4개, 선행은 id · 제목 어느 쪽으로 써도 id로 맞춘다', () => {
  const r = ko(() => RM.parseDecomposition(ANSWER, { plan: 'P', now: NOW }));
  assert.equal(r.ok, true);
  const rm = r.roadmap;
  assert.equal(RM.tasksOf(rm).length, 4);
  assert.deepEqual(RM.findTask(rm, 't3').deps.sort(), ['t1', 't2']);
  assert.equal(rm.title, '할 일 앱');
  assert.equal(rm.plan, 'P');
  assert.ok(r.warnings.some((w) => w.includes('t4'))); // 완료 조건 비어 있음
  assert.ok(RM.tasksOf(rm).every((t) => t.status === 'todo' && t.weight >= 1 && t.weight <= 5));
});

test('parseDecomposition: JSON 없음 · 작업 없음 · 선행이 돌고 돎은 실패', () => {
  assert.equal(ko(() => RM.parseDecomposition('그냥 글', {})).ok, false);
  assert.equal(ko(() => RM.parseDecomposition('{"milestones":[]}', {})).ok, false);
  const cyc = '{"milestones":[{"tasks":[{"id":"a","title":"A","deps":["b"]},{"id":"b","title":"B","deps":["a"]}]}]}';
  const r = ko(() => RM.parseDecomposition(cyc, {}));
  assert.equal(r.ok, false);
  assert.match(r.error, /돌고|cycle/);
});

test('normalizeRoadmap: 모르는 값은 버리고 id를 만들고 겹침 · 자기 선행 · 없는 선행을 정리한다', () => {
  const rm = RM.normalizeRoadmap({
    milestones: [{ tasks: [{ id: 't1', title: 'A', deps: ['t1', 'zzz'], weight: 99, status: 'weird', commit: 'not-hex' }, { id: 't1', title: 'B', weight: 0 }, { title: '' }, null] }, 'x'],
    settings: { docsWhen: 'never', readmeMode: 'x' },
    hack: 1,
  });
  const ts = RM.tasksOf(rm);
  assert.equal(ts.length, 2);
  assert.notEqual(ts[0].id, ts[1].id);
  assert.deepEqual(ts[0].deps, []);
  assert.equal(ts[0].weight, 5);
  assert.equal(ts[1].weight, 1);
  assert.equal(ts[0].status, 'todo');
  assert.equal(ts[0].commit, '');
  assert.equal(rm.settings.docsWhen, 'task');
  assert.equal(rm.settings.readmeMode, 'separate');
  assert.equal(rm.hack, undefined);
});

// ---------- 상태 · 진행 ----------
test('setStatus: 선행이 안 끝났으면 진행 · 검증 · 완료로 못 옮기고, 완료는 doneAt과 기록을 남긴다', () => {
  const rm = fresh();
  const bad = ko(() => RM.setStatus(rm, 't2', 'doing', { now: NOW }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /t1/);
  assert.equal(RM.setStatus(rm, 't2', 'blocked', { now: NOW }).ok, true); // 막힘은 가능
  const a = RM.setStatus(rm, 't1', 'done', { now: NOW, commit: 'abc1234' });
  assert.equal(a.ok, true);
  assert.equal(RM.findTask(a.roadmap, 't1').doneAt, NOW);
  assert.equal(RM.findTask(a.roadmap, 't1').commit, 'abc1234');
  assert.equal(a.roadmap.log.length, 1);
  assert.equal(RM.setStatus(a.roadmap, 't2', 'doing', { now: NOW }).ok, true); // 이제 열림
  const back = RM.setStatus(a.roadmap, 't1', 'todo', { now: day(1) });
  assert.equal(RM.findTask(back.roadmap, 't1').doneAt, '');
  assert.equal(RM.setStatus(rm, 'nope', 'done').ok, false);
  assert.equal(RM.setStatus(rm, 't1', 'bogus').ok, false);
  assert.equal(RM.setStatus(a.roadmap, 't1', 'done').changed, false);
});

test('progress: 가중치 기준 (완료 100% · 검증 80% · 진행 40%), 마일스톤별 · 상태별', () => {
  let rm = fresh(); // 가중치 2 · 3 · 3 · 1 = 9
  assert.equal(RM.progress(rm).pct, 0);
  rm = RM.setStatus(rm, 't1', 'done', { now: NOW }).roadmap; // 2/9
  rm = RM.setStatus(rm, 't2', 'verify', { now: NOW }).roadmap; // 2.4/9
  const p = RM.progress(rm);
  assert.equal(p.pct, Math.round(((2 + 3 * 0.8) / 9) * 100));
  assert.equal(p.done, 1);
  assert.equal(p.total, 4);
  assert.equal(p.weightTotal, 9);
  assert.equal(p.counts.verify, 1);
  assert.equal(p.milestones[0].pct, Math.round(((2 + 2.4) / 5) * 100));
  assert.equal(p.milestones[0].done, false);
  assert.equal(RM.progress({ milestones: [] }).pct, 0);
});

test('nextTask: 진행 중 → 검증 중 → 열린 대기 작업, 모두 끝나면 null', () => {
  let rm = fresh();
  assert.equal(RM.nextTask(rm).id, 't1');
  rm = RM.setStatus(rm, 't1', 'done', { now: NOW }).roadmap;
  assert.equal(RM.nextTask(rm).id, 't2');
  rm = RM.setStatus(rm, 't2', 'doing', { now: NOW }).roadmap;
  assert.equal(RM.nextTask(rm).id, 't2');
  for (const id of ['t2', 't3', 't4']) rm = RM.setStatus(rm, id, 'done', { now: NOW }).roadmap;
  assert.equal(RM.nextTask(rm), null);
  assert.equal(RM.progress(rm).pct, 100);
});

// ---------- 편집 ----------
test('편집: 추가 · 고치기 · 순환 막기 · 지우기 · 위아래 · 합치기', () => {
  let rm = fresh();
  rm = RM.addTask(rm, 'm2', { title: '새 작업', deps: ['t4'], weight: 2 });
  assert.equal(RM.tasksOf(rm).length, 5);
  const added = RM.tasksOf(rm).at(-1);
  assert.deepEqual(added.deps, ['t4']);
  assert.equal(RM.addTask(rm, 'nope', { title: 'x' }), rm);
  assert.equal(RM.addTask(rm, 'm1', { title: '  ' }), rm);

  const upd = RM.updateTask(rm, 't4', { title: '마무리!', weight: 9, accept: '끝', deps: ['t3', 'ghost'] });
  assert.equal(RM.findTask(upd, 't4').title, '마무리!');
  assert.equal(RM.findTask(upd, 't4').weight, 5);
  assert.deepEqual(RM.findTask(upd, 't4').deps, ['t3']);
  assert.equal(RM.updateTask(rm, 't1', { deps: ['t4'] }), rm); // t1 → t4 → t3 → t1 순환이라 거절

  const moved = RM.moveTask(rm, 't2', -1);
  assert.deepEqual(moved.milestones[0].tasks.map((t) => t.id), ['t2', 't1']);
  assert.equal(RM.moveTask(rm, 't1', -1).milestones[0].tasks[0].id, 't1'); // 맨 위는 그대로

  const removed = RM.removeTask(RM.setStatus(rm, 't1', 'done', { now: NOW }).roadmap, 't1');
  assert.equal(RM.findTask(removed, 't1'), null);
  assert.ok(!RM.findTask(removed, 't2').deps.includes('t1'));
  assert.ok(removed.log.every((e) => e.task !== 't1'));

  const merged = RM.mergeTasks(rm, 't3', 't4');
  const m = RM.findTask(merged, 't3');
  assert.equal(RM.findTask(merged, 't4'), null);
  assert.match(m.title, /목록 화면 \+ 마무리/);
  assert.equal(m.weight, 4);
  assert.ok(!m.deps.includes('t4') && !m.deps.includes('t3'));
  assert.equal(RM.mergeTasks(rm, 't3', 't3'), rm);
  assert.equal(RM.addMilestone(rm, '배포').milestones.length, 3);
  assert.equal(RM.addMilestone(rm, ' '), rm);
});

test('buildTaskPrompt: 이번 작업 · 완료 조건 · 끝난 작업 · 뒤에 이어질 작업, 영어도 된다', () => {
  let rm = fresh();
  rm = RM.setStatus(rm, 't1', 'done', { now: NOW }).roadmap;
  const p = RM.buildTaskPrompt(rm, 't2', { lang: 'ko' });
  assert.ok(p.includes('t2 저장소') && p.includes('추가 · 삭제가 된다') && p.includes('src/store.js'));
  assert.ok(p.includes('[이미 끝난 작업]') && p.includes('t1 프로젝트 뼈대'));
  assert.ok(p.includes('t3 목록 화면') && p.includes('미리 만들지'));
  assert.ok(RM.buildTaskPrompt(rm, 't2', { lang: 'en' }).includes('Implement one task'));
  assert.equal(RM.buildTaskPrompt(rm, 'nope'), '');
});

test('burndown: 완료한 작업만큼 남은 양이 줄고, 2건 이상이면 예상 완료일', () => {
  let rm = fresh();
  assert.equal(RM.burndown(rm, { now: day(1) }).estimate, null);
  rm = RM.setStatus(rm, 't1', 'done', { now: day(1) }).roadmap;
  assert.equal(RM.burndown(rm, { now: day(1) }).estimate, null); // 1건
  rm = RM.setStatus(rm, 't2', 'done', { now: day(2) }).roadmap;
  const b = RM.burndown(rm, { now: day(2) });
  assert.deepEqual(b.points.map((p) => p.remaining), [9, 7, 4]);
  assert.equal(b.total, 9);
  assert.ok(b.estimate > b.now);
  assert.ok(Math.abs((b.estimate - b.now) / 86400000 - 4 / 2.5) < 0.01); // 하루 2.5씩 → 남은 4는 1.6일 뒤
});

// ---------- 그림 ----------
test('SVG 그림: 링 · 막대 · 지도 · 번다운이 만들어지고, 글은 이스케이프되며, 색 말고 기호도 쓴다', () => {
  let rm = fresh();
  rm = RM.updateTask(rm, 't1', { title: '<script>alert(1)</script> & "x"' });
  rm = RM.setStatus(rm, 't1', 'done', { now: NOW }).roadmap;
  rm = RM.setStatus(rm, 't2', 'doing', { now: NOW }).roadmap;
  const all = ko(() => CH.dashboardHtml(rm, { current: 't2', now: day(1) }));
  assert.equal((all.match(/<svg/g) || []).length, 4);
  assert.equal((all.match(/<\/svg>/g) || []).length, 4);
  assert.ok(!all.includes('<script>'));
  assert.ok(all.includes('&lt;script&gt;'));
  const ring = ko(() => CH.ringSvg(rm));
  assert.ok(ring.includes(`${RM.progress(rm).pct}%`) && ring.includes('role="img"') && ring.includes('rm-s-done') && ring.includes('rm-s-doing'));
  const bars = ko(() => CH.barsSvg(rm));
  assert.ok(bars.includes('✓') && bars.includes('rm-s-done'));
  const map = ko(() => CH.mapSvg(rm, { current: 't2' }));
  assert.equal((map.match(/<g class="rm-node /g) || []).length, 4);
  assert.ok(map.includes('rm-current') && map.includes('rm-locked') && map.includes('data-task="t3"'));
  assert.ok((map.match(/class="rm-edge"/g) || []).length >= 4);
  assert.match(ko(() => CH.burndownSvg(rm, { now: day(1) })).svg, /rm-burn-line/);
  assert.ok(CH.CSS.includes('.rm-s-done') && CH.CSS_LIGHT.includes('--rm-text'));
});

test('SVG 그림: 작업이 없거나 마일스톤이 비어도 깨지지 않는다', () => {
  const empty = RM.normalizeRoadmap({ milestones: [{ title: '빈' }] });
  assert.doesNotThrow(() => ko(() => CH.dashboardHtml(empty, {})));
  assert.ok(ko(() => CH.ringSvg(empty)).includes('0%'));
});

// ---------- 문서 ----------
test('procedure.md: 표식 구역 5개, 표 · 상세 · 진행 요약(mermaid) · 이력', () => {
  let rm = fresh();
  rm = RM.setStatus(rm, 't1', 'done', { now: NOW, commit: 'abc1234', note: '뼈대 완료' }).roadmap;
  const md = DOCS.renderProcedure(rm, { lang: 'ko' });
  for (const k of DOCS.PROC_PARTS) assert.ok(md.includes(`<!-- mla:${k}:start -->`) && md.includes(`<!-- mla:${k}:end -->`), k);
  assert.ok(md.includes('# 할 일 앱 — 구현 절차'));
  assert.ok(md.includes('| 마일스톤 | 작업 | 상태 | 선행 | 완료 조건 |'));
  assert.ok(md.includes('✓ 완료') && md.includes('`abc1234`') && md.includes('뼈대 완료'));
  assert.ok(md.includes('```mermaid') && md.includes('flowchart LR') && md.includes('t1 --> t2') && md.includes(':::done'));
  assert.ok(md.includes('전체 진행률 **'));
  assert.ok(!DOCS.renderProcedure(rm, { lang: 'ko', mermaid: false }).includes('```mermaid'));
  assert.ok(DOCS.renderProcedure(rm, { lang: 'en' }).includes('Implementation procedure'));
});

test('applyMarkers: 표식 구역만 바꾸고 사용자가 쓴 글은 그대로, 없는 구역은 끝에 붙인다, $ 기호도 안전', () => {
  const doc = '# 내 문서\n\n내가 쓴 글\n\n<!-- mla:a:start -->\n옛것\n<!-- mla:a:end -->\n\n내 마지막 글\n';
  const r = DOCS.applyMarkers(doc, { a: '새것 $& $1', b: '추가' });
  assert.ok(r.text.includes('내가 쓴 글') && r.text.includes('내 마지막 글'));
  assert.ok(r.text.includes('새것 $& $1') && !r.text.includes('옛것'));
  assert.deepEqual(r.replaced, ['a']);
  assert.deepEqual(r.added, ['b']);
  assert.ok(r.text.includes('<!-- mla:b:start -->'));
  assert.equal(DOCS.applyMarkers(r.text, { a: '새것 $& $1', b: '추가' }).text, r.text); // 두 번 해도 같다
});

test('planWrite: 새로 만듦 · 표식 갱신 · 기존 README 보호(별도 파일) · 끝에 붙이기 · 교체 · 변화 없음', () => {
  let rm = fresh();
  const base = { kind: 'readme', rm, lang: 'ko', pkg: { name: 'todo', description: '할 일 앱', scripts: { start: 'x', test: 'y' }, dependencies: { express: '1' } }, top: [{ name: 'src', kind: 'dir' }, { name: 'node_modules', kind: 'dir' }, { name: 'package.json', kind: 'file' }, { name: '.git', kind: 'dir' }] };
  const created = DOCS.planWrite({ ...base, existing: null });
  assert.equal(created.action, 'create');
  assert.equal(created.path, 'README.md');
  assert.ok(created.text.includes('# 할 일 앱') && created.text.includes('npm run start') && created.text.includes('`express`') && created.text.includes('src/'));
  assert.ok(!created.text.includes('node_modules'));
  assert.ok(created.text.includes('docs/procedure.md'));

  const mine = '# 내 README\n\n직접 쓴 소개\n';
  const sep = DOCS.planWrite({ ...base, existing: mine, mode: 'separate' });
  assert.deepEqual([sep.action, sep.path], ['separate', 'README.generated.md']);
  const sep2 = DOCS.planWrite({ ...base, existing: mine, existingAlt: sep.text, mode: 'separate' });
  assert.equal(sep2.action, 'unchanged');

  const merged = DOCS.planWrite({ ...base, existing: mine, mode: 'merge' });
  assert.equal(merged.action, 'merge');
  assert.ok(merged.text.startsWith(mine) && merged.text.includes('<!-- mla:intro:start -->'));
  const repl = DOCS.planWrite({ ...base, existing: mine, mode: 'replace' });
  assert.equal(repl.action, 'replace');
  assert.ok(!repl.text.includes('직접 쓴 소개'));

  // 표식이 이미 있는 파일은 모드와 상관없이 그 자리에서 표식 구역만 갱신하고, 바깥 글을 지킨다
  const withMine = created.text.replace('## 주요 기능', '내 메모\n\n## 주요 기능');
  rm = RM.setStatus(rm, 't1', 'done', { now: NOW }).roadmap;
  const upd = DOCS.planWrite({ ...base, rm, existing: withMine, mode: 'replace' });
  assert.equal(upd.action, 'update');
  assert.equal(upd.path, 'README.md');
  assert.ok(upd.text.includes('내 메모') && upd.text.includes('✓ t1 프로젝트 뼈대'));
  assert.equal(DOCS.planWrite({ ...base, rm, existing: upd.text }).action, 'unchanged');
});

test('README: 소개 · 기능은 AI 답에서, 없으면 안내 문구. package.json 설명이 대신 쓰인다', () => {
  let rm = fresh();
  const bare = DOCS.renderReadme(rm, { lang: 'ko', pkg: null });
  assert.ok(bare.includes('소개 문장이 아직 없습니다') && bare.includes('주요 기능 목록이 아직 없습니다'));
  assert.ok(DOCS.renderReadme(rm, { lang: 'ko', pkg: { description: '설명서에서' } }).includes('설명서에서'));
  const info = RM.parseDocsInfo('```json\n{"intro":"할 일을 관리하는 앱","features":["추가","삭제","","추가"]}\n```');
  assert.deepEqual(info, { intro: '할 일을 관리하는 앱', features: ['추가', '삭제'] });
  assert.equal(RM.parseDocsInfo('없음'), null);
  rm = { ...rm, docs: info };
  const md = DOCS.renderReadme(rm, { lang: 'en' });
  assert.ok(md.includes('할 일을 관리하는 앱') && md.includes('- 추가') && md.includes('## Features') && md.includes('Progress 0% (0/4)'));
  assert.ok(RM.buildDocsPrompt(rm, { lang: 'ko' }).includes('프로젝트 뼈대'));
});

test('scanDocs: 비밀 정보로 보이는 글이 든 문서는 걸러 낸다', () => {
  const secret = `const k = "AKIA${'ABCDEFGHIJKLMNOP'}";`;
  const hits = DOCS.scanDocs([{ path: 'README.md', text: `# 제목\n${secret}\n` }, { path: 'docs/procedure.md', text: '안전한 글' }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'README.md');
  assert.deepEqual(DOCS.scanDocs([{ path: 'a', text: '안전' }]), []);
});

test('처음부터 끝까지(메모리 속 프로젝트 폴더): 분해 → 완료 처리 → 문서 쓰기 → 다시 쓰면 변화 없음, 내 글은 유지', () => {
  const files = new Map([['README.md', '# 내 README\n직접 쓴 글\n'], ['package.json', JSON.stringify({ name: 'todo', scripts: { start: 'x' } })]]);
  let rm = fresh();
  const write = (mode = 'separate') => {
    const out = [];
    for (const kind of ['procedure', 'readme']) {
      const main = kind === 'procedure' ? DOCS.PROCEDURE_PATH : DOCS.README_PATH;
      const alt = kind === 'procedure' ? DOCS.PROCEDURE_ALT : DOCS.README_ALT;
      const existing = files.has(main) ? files.get(main) : null;
      const p = DOCS.planWrite({ kind, rm, existing, existingAlt: existing != null && files.has(alt) ? files.get(alt) : null, mode, lang: 'ko', pkg: JSON.parse(files.get('package.json')), top: [] });
      if (p.action !== 'unchanged') files.set(p.path, p.text);
      out.push(p.action);
    }
    return out;
  };
  assert.deepEqual(write(), ['create', 'separate']);
  assert.ok(files.get('README.md').includes('직접 쓴 글')); // 기존 README는 그대로
  assert.ok(files.get('README.generated.md').includes('<!-- mla:status:start -->'));
  assert.ok(files.get('docs/procedure.md').includes('0%'));
  assert.deepEqual(write(), ['unchanged', 'unchanged']);
  for (const id of ['t1', 't2', 't3', 't4']) rm = RM.setStatus(rm, id, 'done', { now: NOW }).roadmap;
  assert.deepEqual(write(), ['update', 'separate']);
  assert.ok(files.get('docs/procedure.md').includes('**100%**'));
  assert.ok(files.get('README.generated.md').includes('100%'));
  assert.equal(files.get('README.md'), '# 내 README\n직접 쓴 글\n');
});

// ---------- 화면 연결 ----------
test('연결: 창 · 버튼 id가 모두 있고, 문구 키가 두 언어에 있다', () => {
  const html = read('src/renderer/index.html');
  const js = read('src/renderer/roadmap-ui.js');
  const ids = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  for (const k of ['plan', 'tasks', 'dash', 'docs']) {
    ids.add(`roadmapTab-${k}`);
    ids.add(`roadmapPane-${k}`);
  }
  for (const id of ids) {
    if (['prompt', 'sendHint'].includes(id)) continue; // 다른 화면 것
    assert.ok(html.includes(`id="${id}"`), `#${id}`);
  }
  assert.match(html, /id="roadmapModal" class="modal" hidden/);
  const keys = new Set();
  for (const f of ['src/renderer/roadmap-ui.js', 'src/renderer/index.html', 'src/shared/roadmap-charts.js', 'src/shared/roadmap-docs.js']) {
    for (const m of read(f).matchAll(/(?:\bt\(|data-i18n(?:-title|-aria|-placeholder)?=)['"](ui\.roadmap\.[A-Za-z0-9.]+)['"]/g)) keys.add(m[1]);
  }
  assert.ok(keys.size > 40);
  for (const lang of i18n.LANGS) for (const k of keys) assert.ok(i18n.strings[lang][k], `${lang}:${k}`);
  for (const s of RM.STATUSES) for (const lang of i18n.LANGS) assert.ok(i18n.strings[lang][`ui.roadmap.status.${s}`]);
  for (const a of ['create', 'update', 'separate', 'merge', 'replace', 'unchanged']) assert.ok(i18n.strings.ko[`ui.roadmap.docs.action.${a}`], a);
});

test('연결: 스크립트 순서 · 확장 프로그램 동기화 · 창 닫기 훅 · .mla 제외', () => {
  const html = read('src/renderer/index.html');
  const at = (s) => html.indexOf(`src="${s}"`);
  assert.ok(at('../shared/roadmap.js') > at('../shared/secret-scan.js') && at('../shared/roadmap-charts.js') > at('../shared/roadmap.js') && at('../shared/roadmap-docs.js') > at('../shared/roadmap-charts.js'));
  assert.ok(at('roadmap-ui.js') > at('project-editor.js') && at('roadmap-ui.js') < at('library.js'));
  assert.match(read('scripts/build-extension.js'), /'roadmap-ui\.js'/);
  const app = read('extension/app.html');
  for (const f of ['shared/roadmap.js', 'shared/roadmap-charts.js', 'shared/roadmap-docs.js', 'renderer/roadmap-ui.js']) assert.ok(app.includes(`lib/${f}`), f);
  for (const f of ['shared/roadmap.js', 'shared/roadmap-charts.js', 'shared/roadmap-docs.js', 'renderer/roadmap-ui.js']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'extension/lib', f)), f);
  assert.match(read('src/renderer/renderer-compose.js'), /window\.onRoadmapState\?\.\(\)/);
  assert.ok(read('src/shared/project-ignore.js').includes("'.mla/'")); // 진행 데이터 폴더는 AI에게 보내지 않는다
});
