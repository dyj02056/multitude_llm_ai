'use strict';
// 개발자 기능 (v0.12.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 덩어리(hunk) 단위 적용: 고른 덩어리만 바뀌고 나머지는 그대로인지 (CRLF · 마지막 줄바꿈 포함)
//   - 테스트 실행 규칙: package.json의 test만, 셸 없이 process.execPath + npm-cli.js, 허용 모양 검사, 결과 요약
//   - 테스트 실행(임시 적용 → 실행 → 되돌리기): 실제 npm test를 임시 프로젝트에서 돌려 본다
//   - 셀렉터 자가진단: 보내기 · 답변 결과로 "화면이 바뀐 것 같음"을 판단하는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const PX = require('../src/shared/patch');
const R = require('../src/main/test-rules');
const { createDiag } = require('../src/shared/diag');
const { createRounds } = require('../src/shared/rounds');

// ---------- 덩어리 단위 적용 ----------

const BEFORE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const AFTER = BEFORE.replace('line 2\n', 'LINE TWO\n').replace('line 10\n', 'line 10\nadded\n').replace('line 18\n', '');

test('덩어리 나누기: 떨어진 변경 3곳 → 덩어리 3개, 앞뒤 3줄 맥락', () => {
  const hunks = PX.splitHunks(BEFORE, AFTER);
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks[0].lines.filter((l) => l[0] !== ' '), ['-line 2', '+LINE TWO']);
  assert.deepEqual(hunks[1].lines.filter((l) => l[0] !== ' '), ['+added']);
  assert.deepEqual(hunks[2].lines.filter((l) => l[0] !== ' '), ['-line 18']);
  assert.equal(hunks[0].oldStart, 2);
  assert.equal(hunks[1].lines[0], ' line 8'); // 앞 맥락 3줄
  assert.equal(hunks[2].oldStart, 18);
});

test('덩어리 적용: 고른 것만 바뀌고, 전부 = after, 하나도 없음 = before', () => {
  assert.equal(PX.applyHunks(BEFORE, AFTER, [0, 1, 2]), AFTER);
  assert.equal(PX.applyHunks(BEFORE, AFTER, []), BEFORE);
  const only2 = PX.applyHunks(BEFORE, AFTER, [1]);
  assert.ok(only2.includes('line 2\n') && !only2.includes('LINE TWO'));
  assert.ok(only2.includes('line 10\nadded\n'));
  assert.ok(only2.includes('line 18\n'));
  const no1 = PX.applyHunks(BEFORE, AFTER, [0, 2]);
  assert.ok(no1.includes('LINE TWO') && !no1.includes('added') && !no1.includes('line 18\n'));
});

test('덩어리 적용: CRLF와 마지막 줄바꿈 없음을 그대로 지킨다', () => {
  const b = 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni';
  const a = 'A\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\nI';
  assert.equal(PX.splitHunks(b, a).length, 2);
  assert.equal(PX.applyHunks(b, a, [0]), 'A\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni');
  assert.equal(PX.applyHunks(b, a, [1]), 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\nI');
});

// ---------- 테스트 실행 규칙 ----------

test('test 스크립트 읽기: 없음 · npm 기본값 · 깨진 JSON은 거절, pre/post는 함께 알림', () => {
  assert.equal(R.readTestScript(undefined).ok, false);
  assert.equal(R.readTestScript('{').ok, false);
  assert.equal(R.readTestScript('{"scripts":{}}').ok, false);
  assert.equal(R.readTestScript('{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}').ok, false);
  assert.deepEqual(R.readTestScript('\uFEFF{"scripts":{"test":"node --test","pretest":"lint","posttest":" "}}'), { ok: true, script: 'node --test', pre: 'lint' });
});

test('npm-cli.js 찾기: npm_execpath → PATH의 npm 폴더 → %APPDATA%, 상대 경로 PATH는 보지 않음', () => {
  const files = new Set([
    'C:\\nodejs\\npm.cmd',
    'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js',
    'proj\\npm.cmd',
    'proj\\node_modules\\npm\\bin\\npm-cli.js',
  ]);
  const exists = (p) => files.has(p);
  const win = (env) => R.findNpmCli({ env, platform: 'win32', exists });
  assert.equal(win({ PATH: 'proj;C:\\nodejs' }), 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
  assert.equal(win({ PATH: 'proj', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }), 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js');
  assert.equal(win({ PATH: 'proj' }), null);
  assert.equal(win({ npm_execpath: 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', PATH: '' }), 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
  assert.equal(win({ npm_execpath: 'C:\\evil\\npm.cmd', PATH: '' }), null);
  const nix = new Set(['/usr/local/bin/npm', '/usr/local/lib/node_modules/npm/bin/npm-cli.js']);
  assert.equal(R.findNpmCli({ env: { PATH: '/usr/local/bin' }, platform: 'linux', exists: (p) => nix.has(p) }), '/usr/local/lib/node_modules/npm/bin/npm-cli.js');
});

test('실행 방법: 셸 없이 process.execPath로 npm-cli.js test (Electron이면 ELECTRON_RUN_AS_NODE=1)', () => {
  const root = path.resolve('/work/app');
  const npmCli = path.resolve('/nodejs/node_modules/npm/bin/npm-cli.js');
  const spec = R.buildTestSpawn({ root, npmCli, execPath: '/app/Multitude.exe', isElectron: true, env: { PATH: 'x' } });
  assert.equal(spec.command, '/app/Multitude.exe');
  assert.deepEqual(spec.args, [npmCli, 'test']);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.cwd, root);
  assert.equal(spec.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.options.env.CI, '1');
  assert.equal(R.buildTestSpawn({ root, npmCli, execPath: 'node', isElectron: false, env: { ELECTRON_RUN_AS_NODE: '1' } }).options.env.ELECTRON_RUN_AS_NODE, undefined);
  // 허용 규칙
  assert.equal(R.isAllowedTestSpawn(spec, { root, execPath: '/app/Multitude.exe' }), true);
  const bad = (patch) => R.isAllowedTestSpawn({ ...spec, ...patch, options: { ...spec.options, ...(patch.options || {}) } }, { root, execPath: '/app/Multitude.exe' });
  assert.equal(bad({ command: 'npm.cmd' }), false);
  assert.equal(bad({ options: { shell: true } }), false);
  assert.equal(bad({ options: { cwd: path.resolve('/other') } }), false);
  assert.equal(bad({ args: [npmCli, 'run', 'build'] }), false);
  assert.equal(bad({ args: [npmCli, 'test', '--', 'x'] }), false);
  assert.equal(bad({ args: ['npm-cli.js', 'test'] }), false); // 상대 경로
  assert.equal(bad({ args: [path.resolve('/x/evil.js'), 'test'] }), false);
});

test('결과 요약: node --test · jest · vitest · mocha', () => {
  assert.deepEqual(R.summarizeTestOutput('# tests 5\n# pass 4\n# fail 1\n'), { pass: 4, fail: 1 });
  assert.deepEqual(R.summarizeTestOutput('ℹ tests 3\nℹ pass 3\nℹ fail 0'), { pass: 3, fail: 0 });
  assert.deepEqual(R.summarizeTestOutput('Tests:       1 failed, 3 passed, 4 total'), { pass: 3, fail: 1 });
  assert.deepEqual(R.summarizeTestOutput(' Tests  2 passed (2)'), { pass: 2, fail: 0 });
  assert.deepEqual(R.summarizeTestOutput('  5 passing (20ms)\n  2 failing'), { pass: 5, fail: 2 });
  assert.equal(R.summarizeTestOutput('ok'), null);
});

test('임시 적용 목록 검사: 모양이 틀리면 거절', () => {
  assert.deepEqual(R.checkTrialChanges([{ path: 'a.js', after: 'x' }, { path: 'b.js', after: null }]), [{ path: 'a.js', after: 'x' }, { path: 'b.js', after: null }]);
  assert.equal(R.checkTrialChanges([]), null);
  assert.equal(R.checkTrialChanges([{ path: 'a.js', after: 1 }]), null);
  assert.equal(R.checkTrialChanges([{ path: 'a.js', after: 'x' }, { path: 'a.js', after: 'y' }]), null);
  assert.equal(R.checkTrialChanges('a.js'), null);
});

// ---------- 테스트 실행: 실제 npm test ----------

function requireWithFakeElectron(rel, electron) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    return orig.call(this, req, ...rest);
  };
  try {
    for (const k of Object.keys(require.cache)) if (/src[\\/]main[\\/]/.test(k)) delete require.cache[k];
    return require(require.resolve(rel));
  } finally {
    Module._load = orig;
  }
}

function setupTrial(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-devtest-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'sum.js'), 'module.exports = (a, b) => a - b;\n'); // 버그
  fs.writeFileSync(
    path.join(root, 'test', 'sum.test.js'),
    "const test = require('node:test'); const assert = require('node:assert'); const sum = require('../sum');\ntest('sum', () => assert.equal(sum(2, 3), 5));\nconsole.log('token ghp_' + 'a'.repeat(36));\n",
  );
  const electron = { dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevTest } = requireWithFakeElectron('../src/main/devtest', electron);
  const handlers = {};
  const ipcMain = { handle: (name, fn) => (handlers[name] = fn) };
  const dt = setupDevTest({ ipcMain, getWin: () => null, project, userDataDir: tmp });
  return { tmp, root, project, dt, call: (name, ...a) => handlers[name]({}, ...a) };
}

test('테스트 실행: 적용 전 실패 → 수정안 쓴 후 통과, 끝나면 원래 파일로 되돌림, 토큰은 가림', { timeout: 120000 }, async (t) => {
  const npmCli = R.findNpmCli({ exists: (p) => fs.existsSync(p) });
  if (!npmCli) return t.skip('npm을 찾지 못함');
  const { root, project, call } = setupTrial(t);
  await project.open(root);
  const info = await call('devtest:info');
  assert.deepEqual(info, { ok: true, script: 'node --test', pre: null, post: null });

  const r = await call('devtest:trial', [
    { path: 'sum.js', after: 'module.exports = (a, b) => a + b;\n' },
    { path: 'extra.js', after: 'new file\n' },
  ]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.before.ok, false, JSON.stringify(r.before).slice(0, 1500));
  assert.deepEqual(r.before.summary, { pass: 0, fail: 1 });
  assert.equal(r.after.ok, true, r.after.output);
  assert.deepEqual(r.after.summary, { pass: 1, fail: 0 });
  assert.ok(!/ghp_a{36}/.test(r.after.output), '토큰이 가려져야 함');
  // 되돌림: 원래 내용 · 새 파일은 지움 · 복구 파일 없음
  assert.equal(fs.readFileSync(path.join(root, 'sum.js'), 'utf8'), 'module.exports = (a, b) => a - b;\n');
  assert.ok(!fs.existsSync(path.join(root, 'extra.js')));
  assert.ok(!fs.existsSync(path.join(path.dirname(root), 'devtest-recovery.json')));
  project.close();
});

test('테스트 실행: 앱이 도중에 꺼져 남은 임시 적용은 다음에 열 때 되돌린다', async (t) => {
  const { tmp, root, project, dt } = setupTrial(t);
  await project.open(root);
  // 임시 적용 중에 꺼진 상황을 흉내: 복구 파일 + 바뀐 파일
  fs.writeFileSync(path.join(tmp, 'devtest-recovery.json'), JSON.stringify({ root, files: [{ path: 'sum.js', existed: true, text: 'ORIGINAL\n' }, { path: 'tmp.js', existed: false }] }));
  fs.writeFileSync(path.join(root, 'sum.js'), 'CHANGED\n');
  fs.writeFileSync(path.join(root, 'tmp.js'), 'x');
  assert.equal(await dt.recover(), 2);
  assert.equal(fs.readFileSync(path.join(root, 'sum.js'), 'utf8'), 'ORIGINAL\n');
  assert.ok(!fs.existsSync(path.join(root, 'tmp.js')));
  assert.ok(!fs.existsSync(path.join(tmp, 'devtest-recovery.json')));
  assert.equal(await dt.recover(), 0);
  project.close();
});

test('테스트 실행: package.json에 test가 없으면 실행하지 않음', async (t) => {
  const { root, project, call } = setupTrial(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}');
  await project.open(root);
  const r = await call('devtest:trial', [{ path: 'sum.js', after: 'x' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /test/);
  assert.equal(fs.readFileSync(path.join(root, 'sum.js'), 'utf8'), 'module.exports = (a, b) => a - b;\n');
  project.close();
});

// ---------- 셀렉터 자가진단 ----------

test('자가진단: 입력창을 못 찾으면 화면이 바뀐 것 같음, 보내기 버튼 대신 Enter면 주의', () => {
  const changes = [];
  const d = createDiag({ onChange: (id, st) => changes.push([id, st.level]) });
  assert.equal(d.status('gpt').level, 'unknown');
  d.fromSend('gpt', { ok: true, via: 'button' });
  assert.deepEqual([d.status('gpt').input, d.status('gpt').send, d.status('gpt').level], ['ok', 'ok', 'ok']);
  d.fromSend('gpt', { ok: true, via: 'key' });
  assert.equal(d.status('gpt').send, 'warn');
  assert.equal(d.status('gpt').level, 'warn');
  d.fromSend('gpt', { ok: false, code: 'no-input', error: '입력창을 찾지 못했습니다' });
  const st = d.status('gpt');
  assert.equal(st.level, 'broken');
  assert.match(st.message, /화면이 바뀐 것 같음 \(입력창\)/);
  assert.ok(st.hint.includes('지금 확인'));
  // 다른 이유로 보내기 실패(주소가 서비스 밖 등)는 셀렉터 문제로 보지 않음
  d.fromSend('x', { ok: false, error: '패널이 서비스 주소가 아닙니다' });
  assert.equal(d.status('x').level, 'unknown');
  assert.ok(changes.length >= 3);
});

test('자가진단: 답변 영역은 연달아 2번 못 찾으면 못 찾음, 찾으면 바로 정상', () => {
  const d = createDiag();
  d.fromAnswer('g', 'no-answer');
  assert.equal(d.status('g').response, 'warn');
  d.fromAnswer('g', 'no-answer');
  assert.equal(d.status('g').response, 'fail');
  assert.equal(d.status('g').level, 'broken');
  d.fromAnswer('g', 'done');
  assert.equal(d.status('g').response, 'ok');
  d.fromAnswer('g', 'timeout'); // 시간 초과는 셀렉터 문제로 보지 않음
  assert.equal(d.status('g').response, 'ok');
});

test('자가진단: 살펴보기는 이미 보내기로 확인한 입력창을 못 찾음으로 바꾸지 않음, 초기화', () => {
  const d = createDiag();
  d.fromProbe('a', { input: false });
  assert.equal(d.status('a').input, 'fail');
  d.fromProbe('a', { input: true });
  assert.equal(d.status('a').input, 'ok');
  d.fromProbe('a', { input: false });
  assert.equal(d.status('a').input, 'ok');
  d.reset();
  assert.equal(d.status('a').level, 'unknown');
  assert.deepEqual(Object.keys(d.all(['a', 'b'])), ['a', 'b']);
});

test('자가진단: rounds가 보내기 · 답변 결과를 기록한다', async () => {
  const d = createDiag();
  let watcher;
  const rounds = createRounds({
    services: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    hasPanel: () => true,
    sendPrompt: async (id) => (id === 'a' ? { ok: true, via: 'button' } : { ok: false, code: 'no-input', error: '입력창을 찾지 못했습니다' }),
    snapshot: async () => ({ stop: false, count: 0, text: '' }),
    watch: (_id, _b, _c, onState) => (watcher = onState),
    sendPanel: () => {},
    sendSynthStatus: () => {},
    history: { add: () => 'h', setAnswer: () => {}, addSynth: () => {} },
    prefs: () => ({ autoSynth: false }),
    diag: d,
    log: () => {},
  });
  await rounds.sendAll('q', ['a', 'b']);
  watcher('no-answer');
  watcher('no-answer');
  assert.equal(d.status('a').send, 'ok');
  assert.equal(d.status('a').response, 'fail');
  assert.equal(d.status('b').input, 'fail');
});
