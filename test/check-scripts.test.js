'use strict';
// 검사 스크립트 여러 개 (v0.28.0) 단위 테스트:  npm test
// [쉽게 말하면] 미리보기 창의 테스트 실행이 test 말고도 lint · typecheck · build를 고를 수 있게 됐습니다.
//   - 허용 목록(이 네 이름)만, package.json에 있는 것만, 셸 없이 npm-cli.js test / run <이름>
//   - 실제 npm으로 임시 프로젝트에서 test + lint를 적용 전 · 후로 돌리고 원래 파일로 되돌리는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const R = require('../src/main/test-rules');

const PKG = JSON.stringify({ scripts: { test: 'node --test', lint: 'node lint.js', prelint: 'node -e 1', build: 'tsc', typecheck: '' } });

test('검사 스크립트 읽기: 있는 것만 허용 목록 순서로, pre/post 함께, 빈 글 · 모르는 이름은 뺌', () => {
  assert.deepEqual(R.CHECK_SCRIPTS, ['test', 'lint', 'typecheck', 'build']);
  const a = R.availableChecks(PKG);
  assert.equal(a.ok, true);
  assert.deepEqual(a.checks.map((c) => c.name), ['test', 'lint', 'build']);
  assert.equal(a.checks[1].pre, 'node -e 1');
  assert.equal(R.readScript(PKG, 'typecheck').ok, false);
  assert.equal(R.readScript(PKG, 'postinstall').ok, false);
  assert.equal(R.readScript('{"scripts":{"deploy":"x"}}', 'deploy').ok, false);
  assert.equal(R.availableChecks('{"scripts":{"start":"node ."}}').ok, false);
  assert.equal(R.availableChecks('{').ok, false);
  // test가 npm 기본값이면 빼고 lint만
  assert.deepEqual(R.availableChecks('{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1","lint":"x"}}').checks.map((c) => c.name), ['lint']);
});

test('고른 이름 검사: 허용 목록 · package.json에 있는 것만, 겹침 · 빈 목록 · 이상한 값은 거절, 순서는 정해진 대로', () => {
  const have = ['test', 'lint', 'build'];
  assert.deepEqual(R.checkScriptNames(['build', 'test'], have), ['test', 'build']);
  assert.equal(R.checkScriptNames([], have), null);
  assert.equal(R.checkScriptNames(['typecheck'], have), null);
  assert.equal(R.checkScriptNames(['test', 'test'], have), null);
  assert.equal(R.checkScriptNames(['rm -rf /'], have), null);
  assert.equal(R.checkScriptNames([1], have), null);
  assert.equal(R.checkScriptNames('test', have), null);
});

test('실행 모양: test는 npm-cli.js test, 나머지는 npm-cli.js run <이름>, 셸 없음 · 허용 검사는 스크립트마다', () => {
  const root = path.resolve('/work/app');
  const npmCli = path.resolve('/nodejs/node_modules/npm/bin/npm-cli.js');
  const opts = { root, npmCli, execPath: '/app/M.exe', isElectron: true, env: {} };
  const lint = R.buildTestSpawn({ ...opts, script: 'lint' });
  assert.deepEqual(lint.args, [npmCli, 'run', 'lint']);
  assert.equal(lint.options.shell, false);
  assert.deepEqual(R.buildTestSpawn(opts).args, [npmCli, 'test']);
  assert.throws(() => R.buildTestSpawn({ ...opts, script: 'deploy' }));
  const allow = (spec, script) => R.isAllowedTestSpawn(spec, { root, execPath: '/app/M.exe', script });
  assert.equal(allow(lint, 'lint'), true);
  assert.equal(allow(lint, 'test'), false); // 다른 스크립트로 바꿔치기
  assert.equal(allow(lint, 'deploy'), false);
  assert.equal(allow({ ...lint, args: [npmCli, 'run', 'lint', '--', 'x'] }, 'lint'), false);
  assert.equal(allow({ ...lint, args: [npmCli, 'run', 'deploy'] }, 'lint'), false);
  assert.equal(allow({ ...lint, options: { ...lint.options, shell: true } }, 'lint'), false);
});

test('확인 창 경고: 수정안이 고른 검사 스크립트를 바꾸면 이전 → 이후', () => {
  const before = '{"scripts":{"test":"node --test","lint":"eslint ."}}';
  const after = '{"scripts":{"test":"node --test","lint":"node evil.js"}}';
  const w = R.trialWarnings([{ path: 'package.json', before, after }], () => null, ['test', 'lint']);
  assert.deepEqual(w.scriptLines, ['lint: eslint . → node evil.js']);
  assert.deepEqual(R.trialWarnings([{ path: 'package.json', before, after }]).scriptLines, []); // test만 고르면 lint 변경은 상관없음
});

// ---------- 실제 npm으로 test + lint ----------

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

test('테스트 실행: test + lint를 적용 전 · 후로 나란히, 끝나면 원래 파일로', { timeout: 180000 }, async (t) => {
  if (!R.findNpmCli({ exists: (p) => fs.existsSync(p) })) return t.skip('npm을 찾지 못함');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-checks-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test', lint: 'node lint.js' } }));
  fs.writeFileSync(path.join(root, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  // lint: sum.js에 "TODO"가 있으면 실패
  fs.writeFileSync(path.join(root, 'lint.js'), "if (require('fs').readFileSync('sum.js', 'utf8').includes('TODO')) { console.error('TODO found'); process.exit(1); }\nconsole.log('lint ok');\n");
  fs.writeFileSync(path.join(root, 'test', 'sum.test.js'), "const test = require('node:test'); const assert = require('node:assert'); const sum = require('../sum');\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  const electron = { dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevTest } = requireWithFakeElectron('../src/main/devtest', electron);
  const handlers = {};
  setupDevTest({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getWin: () => null, project, userDataDir: tmp });
  await project.open(root);
  const info = await handlers['devtest:info']({});
  assert.deepEqual(info.checks.map((c) => c.name), ['test', 'lint']);
  assert.equal((await handlers['devtest:trial']({}, [{ path: 'sum.js', after: 'x' }], ['deploy'])).ok, false);
  const r = await handlers['devtest:trial']({}, [{ path: 'sum.js', after: 'module.exports = (a, b) => a + b; // TODO\n' }], ['lint', 'test']);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.scripts, ['test', 'lint']);
  const [tst, lint] = r.results;
  assert.equal(tst.before.ok, false);
  assert.equal(tst.after.ok, true, tst.after.output);
  assert.equal(lint.before.ok, true, lint.before.output);
  assert.equal(lint.after.ok, false);
  assert.match(lint.after.output, /TODO found/);
  assert.equal(r.after, tst.after); // 예전 모양 (test 것)
  assert.equal(fs.readFileSync(path.join(root, 'sum.js'), 'utf8'), 'module.exports = (a, b) => a - b;\n');
  project.close();
});

test('지금 파일 그대로 한 번 실행 (v0.40.0, 로드맵 카드): 확인 창 → 실행, 파일은 쓰지 않고 결과는 after 칸', { timeout: 180000 }, async (t) => {
  if (!R.findNpmCli({ exists: (p) => fs.existsSync(p) })) return t.skip('npm을 찾지 못함');
  const RM = require('../src/shared/roadmap');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-run-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(root, 'test', 'sum.test.js'), "const test = require('node:test'); const assert = require('node:assert'); const sum = require('../sum');\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  let answer = 0;
  const asked = [];
  const electron = { dialog: { showMessageBox: async (_w, o) => (asked.push(o.detail), { response: answer }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevTest } = requireWithFakeElectron('../src/main/devtest', electron);
  const handlers = {};
  setupDevTest({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getWin: () => null, project, userDataDir: tmp });
  await project.open(root);
  // 실패하는 지금 파일 → fail, 파일은 그대로
  const r1 = await handlers['devtest:run']({}, ['test']);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.now, true);
  assert.equal(r1.results[0].before, null);
  assert.equal(r1.results[0].after.ok, false);
  assert.equal(RM.trialInfo(r1).verdict, 'fail');
  assert.match(asked[0], /한 번 실행합니다|Runs once/);
  assert.equal(fs.readFileSync(path.join(root, 'sum.js'), 'utf8'), 'module.exports = (a, b) => a - b;\n');
  // 고친 뒤(적용한 상태) → pass
  fs.writeFileSync(path.join(root, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  const r2 = await handlers['devtest:run']({}, undefined);
  assert.equal(RM.trialInfo(r2).verdict, 'pass', r2.results?.[0]?.after?.output);
  // 없는 검사 이름 · 취소
  assert.equal((await handlers['devtest:run']({}, ['deploy'])).ok, false);
  answer = 1;
  const r3 = await handlers['devtest:run']({}, ['test']);
  assert.equal(r3.cancelled, true);
  assert.equal(RM.trialInfo(r3).verdict, 'none');
  project.close();
});
