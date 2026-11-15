'use strict';
// 섞어서 적용 · 적용 후 커밋 (v0.28.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 섞어서 적용: 경로마다 한 AI만, 처음 고르기, "모두 이 AI로", 섞이면 경고, 고른 것 → 적용할 수정안
//   - 커밋 메시지: 기본 메시지 · 요약 부탁 · 답에서 한 줄 꺼내기
//   - 커밋 규칙: 경로 · 메시지 검사, git 인자 모양 (경로 붙인 commit, 글자 그대로 경로, push 없음)
//   - 실제 git으로 임시 저장소에서: 적용한 파일만 커밋, 이미 스테이징한 다른 파일은 그대로 스테이징된 채 남음
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const MX = require('../src/shared/mix-select');
const CM = require('../src/shared/commit-msg');
const C = require('../src/main/commit-rules');

const plan = (p, extra = {}) => ({ change: { path: p }, plan: { ok: true, path: p, op: 'modify', add: 2, del: 1, before: 'a', after: 'b', ...extra } });
const AIS = [
  { id: 'claude', name: 'Claude', plans: [plan('a.js'), plan('b.js'), plan('.github/workflows/ci.yml')] },
  { id: 'chatgpt', name: 'ChatGPT', plans: [plan('a.js', { add: 5 }), plan('c.js'), { change: { path: 'x.js' }, plan: { ok: false, path: 'x.js', error: 'no' } }] },
  { id: 'gemini', name: 'Gemini', plans: [] },
];
const quickOf = (item) => !item.plan.path.startsWith('.github');
const riskOf = (p) => (p.path.startsWith('.github') ? 'CI 설정' : null);

test('섞기 표: 경로마다 한 줄, 적용 가능한 수정안만, 여러 AI가 고친 경로 수', () => {
  const rows = MX.buildRows(AIS, { quickOf, riskOf });
  assert.deepEqual(rows.map((r) => r.path), ['.github/workflows/ci.yml', 'a.js', 'b.js', 'c.js']);
  assert.deepEqual(rows.find((r) => r.path === 'a.js').options.map((o) => [o.aiId, o.add]), [['claude', 2], ['chatgpt', 5]]);
  assert.equal(rows[0].options[0].risk, 'CI 설정');
  assert.equal(MX.sharedCount(rows), 1);
  assert.equal(MX.canMix(AIS), true);
  assert.equal(MX.canMix([AIS[0], AIS[2]]), false);
});

test('섞기 고르기: 처음엔 한 AI만 고친 안전한 파일만, 한 경로에 한 AI, 모두 이 AI로, 섞이면 경고', () => {
  const rows = MX.buildRows(AIS, { quickOf, riskOf });
  let picks = MX.defaultPicks(rows);
  assert.deepEqual([...picks], [['b.js', 'claude'], ['c.js', 'chatgpt']]); // a.js(둘이 고침) · CI 설정(실행 영향)은 직접
  picks = MX.setPick(picks, rows, 'a.js', 'chatgpt');
  picks = MX.setPick(picks, rows, 'a.js', 'claude'); // 같은 경로는 마지막 고른 AI 하나
  assert.equal(picks.get('a.js'), 'claude');
  assert.equal(MX.setPick(picks, rows, 'c.js', 'claude').get('c.js'), 'chatgpt'); // 그 AI가 고치지 않은 파일은 못 고름
  let s = MX.summarize(rows, picks);
  assert.equal(s.mixed, true);
  assert.deepEqual(s.ais, ['claude', 'chatgpt']);
  picks = MX.setPick(picks, rows, 'c.js', null);
  s = MX.summarize(rows, picks);
  assert.equal(s.mixed, false);
  picks = MX.pickAllFrom(new Map(), rows, 'claude');
  s = MX.summarize(rows, picks);
  assert.deepEqual(s.chosen.map((c) => c.path), ['.github/workflows/ci.yml', 'a.js', 'b.js']);
  assert.deepEqual(s.risky, ['.github/workflows/ci.yml']);
  picks = MX.pickAllFrom(picks, rows, 'chatgpt');
  const items = MX.chosenItems(AIS, rows, picks);
  assert.deepEqual(items.map((x) => [x.item.plan.path, x.ai.id]), [['.github/workflows/ci.yml', 'claude'], ['a.js', 'chatgpt'], ['b.js', 'claude'], ['c.js', 'chatgpt']]);
  assert.equal(items[1].item, AIS[1].plans[0]); // 그 AI의 수정안 그대로 (적용 때 다시 계산에 씀)
});

test('커밋 메시지: 한 AI · 여러 AI · 폴더 안 경로 · 많은 파일', () => {
  assert.equal(CM.defaultMessage([{ name: 'Claude', paths: ['a.js', 'b.js'] }]), "Apply Claude's changes: a.js, b.js");
  const mixed = CM.defaultMessage([{ name: 'Claude', paths: ['src/a.js'] }, { name: 'ChatGPT', paths: ['b.js'] }]);
  assert.equal(mixed.split('\n')[0], 'Apply changes from Claude, ChatGPT: a.js, b.js');
  assert.match(mixed, /- src\/a\.js \(Claude\)\n- b\.js \(ChatGPT\)/);
  const many = CM.defaultMessage([{ name: 'Gemini', paths: ['1', '2', '3', '4', '5', '6', '7'].map((n) => `${n}.js`) }]);
  assert.match(many.split('\n')[0], /5\.js and 2 more$/);
  assert.equal(CM.defaultMessage([]), '');
});

test('커밋 메시지 요약: 부탁 글에는 경로만, 답에서 한 줄 꺼내기 · 제목 자리에 넣기', () => {
  const p = CM.summaryPrompt(['a.js', 'src/b.js']);
  assert.match(p, /- a\.js\n- src\/b\.js/);
  assert.equal(CM.parseSummary('Fix null check in user loader'), 'Fix null check in user loader');
  assert.equal(CM.parseSummary('커밋 메시지:\n\n```\nAdd retry to fetch\n```'), 'Add retry to fetch');
  assert.equal(CM.parseSummary('**Commit message:** `Refactor parser`'), 'Refactor parser');
  assert.equal(CM.parseSummary('"Update docs"'), 'Update docs');
  assert.equal(CM.parseSummary('- Fix typo'), 'Fix typo');
  assert.equal(CM.parseSummary(''), null);
  assert.equal(CM.parseSummary('x'.repeat(500)).length, 200);
  assert.equal(CM.withSubject("Apply Claude's changes: a.js\n\n- src/a.js", 'Fix it'), 'Fix it\n\n- src/a.js');
  assert.equal(CM.withSubject('old', 'new'), 'new');
});

test('커밋 규칙: 경로 · 메시지 검사', () => {
  assert.deepEqual(C.checkCommitRequest({ paths: ['a.js', './a.js', 'src\\b.js'], message: ' msg\r\nbody ' }), { ok: true, paths: ['a.js', 'src/b.js'], message: 'msg\nbody' });
  for (const bad of [
    { paths: ['a.js'], message: '' },
    { paths: [], message: 'm' },
    { paths: ['../x.js'], message: 'm' },
    { paths: ['C:/x.js'], message: 'm' },
    { paths: ['.git/hooks/pre-commit'], message: 'm' },
    { paths: ['sub/.GIT/config'], message: 'm' },
    { paths: ['a.js'], message: 'a\0b' },
    { paths: ['a.js'], message: 'x'.repeat(5000) },
    { paths: Array.from({ length: 201 }, (_, i) => `${i}.js`), message: 'm' },
    { paths: 'a.js', message: 'm' },
    null,
  ]) assert.equal(C.checkCommitRequest(bad).ok, false, JSON.stringify(bad)?.slice(0, 80));
});

test('커밋 규칙: git 인자 — 글자 그대로 경로, 경로 붙인 commit, 편집기 · 페이저 끔, push · 셸 없음', () => {
  const add = C.addArgs(['a*.js']);
  assert.ok(add.includes('--literal-pathspecs'));
  assert.deepEqual(add.slice(-4), ['add', '-A', '--', 'a*.js']);
  const commit = C.commitArgs(['a.js'], '-m --amend');
  assert.deepEqual(commit.slice(-5), ['commit', '-m', '-m --amend', '--', 'a.js']); // 메시지는 -m 바로 뒤 인자 하나
  assert.ok(commit.includes('core.editor=:'));
  for (const a of [add, commit, C.stagedArgs(), C.trackedArgs(['a.js'])]) {
    assert.equal(C.isAllowedCommitStep(a), true);
    assert.ok(!a.includes('push') && !a.includes('fetch'));
  }
  assert.equal(C.isAllowedCommitStep([...C.PREFIX, 'push']), false);
  assert.equal(C.isAllowedCommitStep(['add', '--', 'a.js']), false); // 앞 옵션 없이
  assert.deepEqual(C.otherStaged(['app/a.js', 'app/z.js', 'README.md'], 'app/', ['a.js']), ['app/z.js', 'README.md']);
  assert.deepEqual(C.pickCommitPaths(['a.js', 'gone.js', 'old.js'], { exists: (p) => p === 'a.js', tracked: ['old.js'] }), ['a.js', 'old.js']);
  assert.deepEqual(C.splitNul('a.js\0src\\b.js\0'), ['a.js', 'src/b.js']);
});

// ---------- 실제 git ----------

function requireWithFakeElectron(rel) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { dialog: {}, app: { getPath: () => os.tmpdir() } };
    return orig.call(this, req, ...rest);
  };
  try {
    for (const k of Object.keys(require.cache)) if (/src[\\/]main[\\/]/.test(k)) delete require.cache[k];
    return require(require.resolve(rel));
  } finally {
    Module._load = orig;
  }
}

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('커밋: 적용한 파일만 커밋, 이미 스테이징한 다른 파일은 남김, 저장소가 아니면 거절', { timeout: 60000 }, async (t) => {
  if (!gitAvailable()) return t.skip('git이 없음');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-commit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  const root = path.join(repo, 'app'); // 프로젝트 폴더가 저장소 안의 하위 폴더인 경우
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  for (const f of ['a.js', 'old.js', 'other.js']) fs.writeFileSync(path.join(root, f), `${f}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // 적용: a.js 수정 · new[1].js 새 파일 · old.js 삭제 / 사용자가 따로 스테이징해 둔 other.js
  fs.writeFileSync(path.join(root, 'a.js'), 'changed\n');
  fs.writeFileSync(path.join(root, 'new[1].js'), 'new\n');
  fs.rmSync(path.join(root, 'old.js'));
  fs.writeFileSync(path.join(root, 'other.js'), 'user staged\n');
  git('add', 'app/other.js');

  const { setupGitCommit } = requireWithFakeElectron('../src/main/gitcommit');
  const handlers = {};
  let projRoot = root;
  setupGitCommit({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getRoot: () => projRoot, gitExe: () => 'git' });
  const paths = ['a.js', 'new[1].js', 'old.js', 'missing.js'];
  const info = await handlers['git:commitInfo']({}, paths);
  assert.equal(info.ok, true, info.error);
  assert.deepEqual(info.otherStaged, ['app/other.js']);
  assert.equal((await handlers['git:commit']({}, { paths: ['../x'], message: 'm' })).ok, false);
  const r = await handlers['git:commit']({}, { paths, message: "Apply Claude's changes: a.js" });
  assert.equal(r.ok, true, `${r.error}\n${r.output}`);
  assert.deepEqual(r.paths, ['a.js', 'new[1].js', 'old.js']); // 없고 추적하지도 않는 파일은 뺌
  assert.ok(r.hash);
  const files = git('show', '--name-status', '--format=%s', 'HEAD').trim().split('\n');
  assert.equal(files[0], "Apply Claude's changes: a.js");
  assert.deepEqual(files.slice(1).filter(Boolean).sort(), ['A\tapp/new[1].js', 'D\tapp/old.js', 'M\tapp/a.js']);
  assert.equal(git('diff', '--cached', '--name-only').trim(), 'app/other.js'); // 사용자 스테이징은 그대로
  // 저장소가 아닌 폴더 (임시 폴더 위쪽이 저장소인 PC도 있어 그 위로는 찾지 않게 한다)
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;
  t.after(() => (ceiling === undefined ? delete process.env.GIT_CEILING_DIRECTORIES : (process.env.GIT_CEILING_DIRECTORIES = ceiling)));
  projRoot = path.join(tmp, 'plain');
  fs.mkdirSync(projRoot);
  const nr = await handlers['git:commit']({}, { paths: ['a.js'], message: 'm' });
  assert.equal(nr.ok, false);
  assert.equal(nr.notRepo, true);
  // 테스트 실행 중에는 받지 않는다
  const h2 = {};
  setupGitCommit({ ipcMain: { handle: (n, fn) => (h2[n] = fn) }, getRoot: () => root, isBusy: () => true, gitExe: () => 'git' });
  assert.equal((await h2['git:commit']({}, { paths: ['a.js'], message: 'm' })).ok, false);
});

test('연결: main이 gitcommit을 등록, preload에 commitInfo · commit, 설정 commitOffer(기본 켬)', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('src/main/main.js'), /setupGitCommit\(\{ ipcMain, getRoot: .*isBusy: \(\) => !!devTest\?\.isBusy\(\) \}\)/);
  assert.match(read('src/main/main.js'), /prefs\.commitOffer = prefs\.commitOffer !== false/);
  assert.match(read('src/main/ipc/settings.js'), /typeof commitOffer === 'boolean'/);
  const pre = read('src/preload/preload.js');
  assert.match(pre, /commitInfo: \(paths\) => ipcRenderer\.invoke\('git:commitInfo', paths\)/);
  assert.match(pre, /commit: \(req\) => ipcRenderer\.invoke\('git:commit', req\)/);
  assert.doesNotMatch(read('src/main/gitcommit.js'), /'push'|shell: true/);
  // 확장에는 git이 없다 → 커밋 제안이 보이지 않는다
  assert.doesNotMatch(read('extension/host.js'), /commitInfo/);
  assert.match(read('src/renderer/project-commit.js'), /const canOfferCommit = \(\) => !!host\.git\?\.commit/);
});
