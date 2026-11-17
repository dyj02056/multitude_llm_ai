'use strict';
// 프로젝트 모드 (v0.34.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 다른 언어 검사(pytest · cargo test · go test) 규칙: 실행 파일 찾기 · 허용 모양 · 결과 요약, 그리고 실제로 임시 프로젝트에서 돌려 본다
//   - 실패 로그를 AI에게 돌려 보내는 글 · 횟수 · 화면 (자동 적용 없음)
//   - 관련 파일 찾기(import 따라가기: JS · TS · Python), 새 브랜치 이름 규칙 · git 인자
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const R = require('../src/main/test-rules');
const C = require('../src/main/commit-rules');
const BN = require('../src/shared/branch-name');
const IG = require('../src/shared/import-graph');
const PC = require('../src/shared/project-context');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ---------- 다른 언어 검사: 규칙 ----------
const WIN_FILES = new Set(['C:\\Python312\\python.exe', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', 'C:\\Windows\\py.exe', 'C:\\Program Files\\Go\\bin\\go.exe', 'C:\\Users\\u\\.cargo\\bin\\cargo.exe']);
const WIN_ENV = { PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python312;.\\rel;C:\\Windows', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\u' };
const winExists = (set) => (p) => set.has(p);

test('다른 언어 검사: 표시 파일(pyproject.toml · Cargo.toml · go.mod)이 있을 때만 이름이 보인다', () => {
  assert.deepEqual(R.RUNNER_CHECKS, ['pytest', 'cargo-test', 'go-test']);
  assert.deepEqual(R.runnerChecks((m) => m === 'pyproject.toml').map((c) => [c.name, c.label]), [['pytest', 'python -m pytest -q']]);
  assert.deepEqual(R.runnerChecks((m) => m === 'Cargo.toml' || m === 'go.mod').map((c) => c.name), ['cargo-test', 'go-test']);
  assert.deepEqual(R.runnerChecks(() => false), []);
  assert.equal(R.isRunner('pytest'), true);
  assert.equal(R.isRunner('test'), false);
  // 고를 수 있는 이름: 있는 것만, 겹치지 않게, 정해 둔 순서(npm 스크립트 → pytest → cargo → go)
  const have = ['test', 'lint', 'pytest', 'go-test'];
  assert.deepEqual(R.checkScriptNames(['go-test', 'pytest', 'test'], have), ['test', 'pytest', 'go-test']);
  assert.equal(R.checkScriptNames(['cargo-test'], have), null); // 이 프로젝트에 없는 검사
  assert.equal(R.checkScriptNames(['pytest', 'pytest'], have), null);
  assert.equal(R.checkScriptNames(['rm -rf /'], have), null); // 글로 적은 명령은 받지 않는다
  assert.equal(R.checkScriptNames([], have), null);
  assert.deepEqual(R.ALL_CHECKS, ['test', 'lint', 'typecheck', 'build', 'pytest', 'cargo-test', 'go-test']);
});

test('실행 파일 찾기: PATH의 절대 경로 폴더만, Microsoft Store 별칭(WindowsApps)의 python은 건너뛰고, 없으면 py 런처', () => {
  const find = (name, files = WIN_FILES, env = WIN_ENV) => R.findRunnerExe(name, { env, platform: 'win32', exists: winExists(files) });
  assert.deepEqual(find('pytest'), { command: 'C:\\Python312\\python.exe', args: ['-m', 'pytest', '-q'] });
  assert.deepEqual(find('go-test'), { command: 'C:\\Program Files\\Go\\bin\\go.exe', args: ['test', './...'] }); // PATH에 없어도 Program Files\Go\bin
  assert.deepEqual(find('cargo-test'), { command: 'C:\\Users\\u\\.cargo\\bin\\cargo.exe', args: ['test'] }); // ~/.cargo/bin
  // Python은 Store 별칭뿐이면 py 런처로
  const onlyStore = new Set(['C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', 'C:\\Windows\\py.exe']);
  assert.deepEqual(find('pytest', onlyStore), { command: 'C:\\Windows\\py.exe', args: ['-3', '-m', 'pytest', '-q'] });
  assert.equal(find('pytest', new Set(['C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'])), null);
  // 상대 경로 PATH 폴더(프로젝트 안의 가짜 실행 파일)는 보지 않는다
  assert.equal(find('pytest', new Set(['.\\rel\\python.exe']), { PATH: '.\\rel' }), null);
  assert.equal(find('go-test', new Set(), WIN_ENV), null);
  assert.equal(find('test'), null); // npm 스크립트 이름은 여기서 찾지 않는다
  // 리눅스 · 맥
  const posix = new Set(['/usr/bin/python3', '/home/u/.cargo/bin/cargo', '/usr/local/go/bin/go']);
  const pfind = (name) => R.findRunnerExe(name, { env: { PATH: '/usr/bin:relative/bin', HOME: '/home/u' }, platform: 'linux', exists: (p) => posix.has(p) });
  assert.deepEqual(pfind('pytest'), { command: '/usr/bin/python3', args: ['-m', 'pytest', '-q'] });
  assert.deepEqual(pfind('cargo-test'), { command: '/home/u/.cargo/bin/cargo', args: ['test'] });
  assert.deepEqual(pfind('go-test'), { command: '/usr/local/go/bin/go', args: ['test', './...'] });
});

test('다른 언어 검사 실행 방법: 셸 없이 정해진 인자만, 프로젝트 폴더에서, 허용 모양이 아니면 거절', () => {
  const root = path.resolve('/proj');
  const py = { command: path.resolve('/usr/bin/python3'), args: ['-m', 'pytest', '-q'] };
  const spec = R.buildRunnerSpawn({ name: 'pytest', root, exe: py, env: { PATH: 'x', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.cwd, root);
  assert.equal(spec.options.env.CI, '1');
  assert.equal(spec.options.env.NO_COLOR, '1');
  assert.equal(spec.options.env.PYTHONUTF8, '1');
  assert.ok(!('NODE_OPTIONS' in spec.options.env) && !('ELECTRON_RUN_AS_NODE' in spec.options.env));
  assert.equal(R.isAllowedRunnerSpawn(spec, { root, name: 'pytest' }), true);
  const go = R.buildRunnerSpawn({ name: 'go-test', root, exe: { command: path.resolve('/usr/local/go/bin/go'), args: ['test', './...'] } });
  assert.equal(R.isAllowedRunnerSpawn(go, { root, name: 'go-test' }), true);
  const cargo = R.buildRunnerSpawn({ name: 'cargo-test', root, exe: { command: path.resolve('/home/u/.cargo/bin/cargo'), args: ['test'] } });
  assert.equal(R.isAllowedRunnerSpawn(cargo, { root, name: 'cargo-test' }), true);
  assert.equal(R.isAllowedRunnerSpawn(cargo, { root, name: 'go-test' }), false); // 이름과 다른 실행 파일
  // 거절: 다른 인자 · 셸 · 다른 폴더 · 상대 경로 · 모르는 검사 이름
  const bad = (mod, name = 'pytest', base = spec) => R.isAllowedRunnerSpawn({ ...base, ...mod, options: { ...base.options, ...(mod.options || {}) } }, { root, name });
  assert.equal(bad({ args: ['-m', 'pytest', '-q', '--rootdir=/etc'] }), false);
  assert.equal(bad({ args: ['-c', 'import os'] }), false);
  assert.equal(bad({ options: { shell: true } }), false);
  assert.equal(bad({ options: { cwd: path.resolve('/other') } }), false);
  assert.equal(bad({ command: 'python3' }), false);
  assert.equal(bad({ command: path.resolve('/usr/bin/bash') }), false);
  assert.equal(R.isAllowedRunnerSpawn(spec, { root, name: 'lint' }), false);
  assert.equal(R.isAllowedRunnerSpawn(null, { root, name: 'pytest' }), false);
  assert.throws(() => R.buildRunnerSpawn({ name: 'rm', root, exe: py }));
  assert.throws(() => R.buildRunnerSpawn({ name: 'pytest', root, exe: null }));
  // py 런처는 -3이 앞에 붙은 모양만
  const launcher = R.buildRunnerSpawn({ name: 'pytest', root: 'C:\\proj', exe: { command: 'C:\\Windows\\py.exe', args: ['-3', '-m', 'pytest', '-q'] } });
  assert.equal(R.isAllowedRunnerSpawn(launcher, { root: 'C:\\proj', name: 'pytest' }), true);
  assert.equal(R.isAllowedRunnerSpawn({ ...launcher, args: ['-m', 'pytest', '-q'] }, { root: 'C:\\proj', name: 'pytest' }), false);
});

test('결과 요약: pytest · cargo test · go test', () => {
  assert.deepEqual(R.summarizeTestOutput('collected 4 items\n\n=== 1 failed, 3 passed in 0.12s ==='), { pass: 3, fail: 1 });
  assert.deepEqual(R.summarizeTestOutput('....\n4 passed in 0.10s'), { pass: 4, fail: 0 });
  assert.deepEqual(R.summarizeTestOutput('=== 2 passed, 1 error in 1.5s ==='), { pass: 2, fail: 1 });
  assert.deepEqual(R.summarizeTestOutput('running 2 tests\ntest result: ok. 5 passed; 0 failed; 0 ignored\ntest result: FAILED. 1 passed; 2 failed; 0 ignored'), { pass: 6, fail: 2 });
  assert.deepEqual(R.summarizeTestOutput('ok  \texample.com/a\t0.1s\nFAIL\texample.com/b\t0.2s\nok  \texample.com/c\t0.1s\nFAIL'), { pass: 2, fail: 1 });
  assert.equal(R.summarizeTestOutput('아무 말도 아님'), null);
  // 기존 요약은 그대로
  assert.deepEqual(R.summarizeTestOutput('# pass 4\n# fail 1'), { pass: 4, fail: 1 });
  assert.match('src/conftest.py', R.RUNNER_SENSITIVE);
  assert.match('pyproject.toml', R.RUNNER_SENSITIVE);
  assert.match('Cargo.toml', R.RUNNER_SENSITIVE);
  assert.match('crates/x/build.rs', R.RUNNER_SENSITIVE);
  assert.match('go.mod', R.RUNNER_SENSITIVE);
  assert.doesNotMatch('src/main.rs', R.RUNNER_SENSITIVE);
});

// ---------- 다른 언어 검사: 실제로 임시 프로젝트에서 ----------
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

test('다른 언어 검사 실행: Cargo.toml만 있는 폴더에서 적용 전 실패 → 적용 후 통과, 되돌림 (가짜 cargo = node 복사본)', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-runner-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const fakeCargo = path.join(bin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  fs.copyFileSync(process.execPath, fakeCargo); // "cargo test"는 "node test"가 된다 → 프로젝트 맨 위의 test 파일이 돈다
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "p"\n');
  fs.writeFileSync(path.join(root, 'data.txt'), 'bad');
  fs.writeFileSync(
    path.join(root, 'test'),
    "const fs = require('fs'); const ok = fs.readFileSync('data.txt', 'utf8') === 'good';\n" +
      "console.log(ok ? 'test result: ok. 1 passed; 0 failed; 0 ignored' : 'test result: FAILED. 0 passed; 1 failed; 0 ignored');\n" +
      "console.log('token ghp_' + 'a'.repeat(36));\nprocess.exit(ok ? 0 : 1);\n",
  );
  const electron = { dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevTest } = requireWithFakeElectron('../src/main/devtest', electron);
  const handlers = {};
  setupDevTest({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getWin: () => null, project, userDataDir: tmp, findRunner: (name) => (name === 'cargo-test' ? { command: fakeCargo, args: ['test'] } : null) });
  const call = (n, ...a) => handlers[n]({}, ...a);
  await project.open(root);
  const info = await call('devtest:info');
  assert.equal(info.ok, true);
  assert.deepEqual(info.checks, [{ name: 'cargo-test', script: 'cargo test', pre: null, post: null, runner: true }]); // package.json이 없어도 다른 언어 검사만으로 열린다
  assert.equal(info.script, null);
  assert.deepEqual(await call('devtest:trial', [{ path: 'data.txt', after: 'good' }], ['pytest']), { ok: false, error: i18n.t('devtest.badScripts') }); // 이 프로젝트에 없는 검사
  const r = await call('devtest:trial', [{ path: 'data.txt', after: 'good' }], ['cargo-test']);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.results.length, 1);
  const x = r.results[0];
  assert.deepEqual({ name: x.name, runner: x.runner, script: x.script }, { name: 'cargo-test', runner: true, script: 'cargo test' });
  assert.equal(x.before.ok, false);
  assert.deepEqual(x.before.summary, { pass: 0, fail: 1 });
  assert.equal(x.after.ok, true, x.after.output);
  assert.deepEqual(x.after.summary, { pass: 1, fail: 0 });
  assert.ok(!/ghp_a{36}/.test(x.after.output), '토큰이 가려져야 함');
  assert.equal(fs.readFileSync(path.join(root, 'data.txt'), 'utf8'), 'bad'); // 되돌림
  project.close();
});

test('다른 언어 검사 실행: 표시 파일은 있는데 실행 파일이 없으면 안내하고, 표시 파일이 없으면 보이지 않는다', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-runner2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'go.mod'), 'module x\n');
  const electron = { dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevTest } = requireWithFakeElectron('../src/main/devtest', electron);
  const handlers = {};
  setupDevTest({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getWin: () => null, project, userDataDir: tmp, findRunner: () => null });
  await project.open(root);
  const info = await handlers['devtest:info']({});
  assert.equal(info.ok, false);
  assert.match(info.error, /go\.mod → go test \.\/\.\.\./);
  project.close();
  fs.rmSync(path.join(root, 'go.mod'));
  await project.open(root);
  const none = await handlers['devtest:info']({});
  assert.equal(none.ok, false);
  assert.ok(!/go\.mod/.test(none.error)); // 표시 파일이 없으면 다른 언어 검사는 나오지 않는다
  project.close();
});

// ---------- 실패 로그 → AI에게 돌려 보내기 ----------
test('실패 로그 글: 실패한 검사의 출력 끝부분, 적용 전 결과, 바꾼 파일, 답변 규칙, 긴 출력은 자름 (한국어 · 영어)', () => {
  const text = PC.buildFixFeedback({
    files: ['src/a.js', 'src/b.js'],
    failures: [
      { name: 'test', command: 'npm test', code: 1, output: 'AssertionError: 5 !== 6\n    at sum.test.js:3', beforeOk: true },
      { name: 'lint', command: 'npm run lint', code: 2, output: 'x'.repeat(20000), beforeOk: false },
    ],
  });
  assert.match(text, /^방금 준 수정안을 내 프로젝트에 임시로 적용해 검사를 돌렸더니 실패했어/);
  assert.match(text, /\[바꾼 파일\] src\/a\.js, src\/b\.js/);
  assert.match(text, /### test — npm test \(종료 코드 1, 적용 전에는 통과했어\)\n```\nAssertionError: 5 !== 6/);
  assert.match(text, /### lint — npm run lint \(종료 코드 2, 적용 전에도 실패했어\)/);
  assert.match(text, /\(출력이 길어 끝의 \d+자만 보냄\)/);
  assert.match(text, /원인을 3줄 이내로 설명하고/);
  assert.match(text, /\[답변 규칙\]/); // 형식을 다시 알려 준다
  assert.ok(text.length < 14000 + 4000, '출력 합 한도'); // 모든 출력의 합은 14,000자까지
  // 코드 울타리가 들어 있는 출력은 더 긴 울타리로 감싼다
  assert.match(PC.buildFixFeedback({ files: ['a'], failures: [{ name: 'test', command: 'npm test', code: 1, output: 'a\n```\nb' }] }), /````\na\n```\nb\n````/);
  assert.match(PC.buildFixFeedback({ files: ['a'], failures: [{ name: 'test', command: 'npm test', code: null, output: '' }] }), /종료 코드 \?[\s\S]*\(출력 없음\)/);
  i18n.setLang('en');
  try {
    const en = PC.buildFixFeedback({ files: ['a.py'], failures: [{ name: 'pytest', command: 'python -m pytest -q', code: 1, output: 'FAILED', beforeOk: true }] });
    assert.match(en, /^I applied the change you just proposed to my project temporarily/);
    assert.match(en, /### pytest — python -m pytest -q \(exit code 1, it passed before the change\)/);
    assert.match(en, /\[Answer rules\]/);
    assert.ok(!/[가-힣]/.test(en));
  } finally {
    i18n.setLang('ko');
  }
});

test('실패 로그 횟수: 기본 2번, 0~3만, 이상한 값은 기본으로', () => {
  assert.equal(PC.DEFAULT_FIX_ROUNDS, 2);
  assert.equal(PC.MAX_FIX_ROUNDS, 3);
  assert.deepEqual([null, undefined, '', 'x', 9, -1, 1.5].map(PC.normalizeFixRounds), [2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(['0', '1', '2', '3', 0, 3].map(PC.normalizeFixRounds), [0, 1, 2, 3, 0, 3]);
});

// ---------- 실패 로그: 화면 (가짜 DOM) ----------
function fakeDom() {
  class El {
    constructor(tag) {
      this.tag = tag;
      this.className = '';
      this.children = [];
      this.dataset = {};
      this._text = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.listeners = {};
      this.attrs = {};
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    append(...kids) {
      for (const k of kids) if (typeof k !== 'string') k.parent = this;
      this.children.push(...kids);
    }
    replaceChildren(...kids) {
      for (const k of kids) if (typeof k !== 'string') k.parent = this;
      this.children = kids;
      this._text = '';
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, '');
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (typeof c === 'string') continue;
          if ((c.className || '').split(' ').includes(cls)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    }
  }
  const byId = new Map();
  const $ = (sel) => {
    const id = sel.slice(1);
    if (!byId.has(id)) byId.set(id, new El('div'));
    return byId.get(id);
  };
  return { El, $, document: { createElement: (t) => new El(t), createTextNode: (s) => String(s) } };
}
const walk = (node, out = []) => {
  if (typeof node === 'string' || !node) return out;
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
};

function devtestPage({ trialResult, allowed = true, sendResult = { ok: true } } = {}) {
  const dom = fakeDom();
  const sent = [];
  const store = new Map();
  const P = {
    testState: { running: false },
    fixRounds: new Map(),
    allowedFor: () => allowed,
    modal: { hide: () => (P.hidden = true) },
  };
  const ctx = {
    MLA: { projectUI: P, projectContext: PC },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    span: (cls, text) => Object.assign(new dom.El('span'), { className: cls, _text: text }),
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    host: {
      devtest: { info: async () => ({ ok: true, checks: [{ name: 'test', script: 'node --test' }] }), trial: async () => trialResult, stop: async () => true },
      sendFollowUp: async (id, text) => (sent.push({ id, text }), sendResult),
    },
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/project-devtest.js'), ctx);
  return { P, dom, sent, store, ctx };
}
const FAILED = {
  ok: true,
  scripts: ['test'],
  results: [{ name: 'test', script: 'node --test', before: { ok: true, code: 0, output: 'ok' }, after: { ok: false, code: 1, output: 'AssertionError: boom', summary: { pass: 0, fail: 1 } } }],
};

async function runTrial(page, ai) {
  page.dom.$('#patchModal').hidden = false;
  page.P.setupTestRun(() => [{ path: 'src/a.js', op: 'modify', after: 'x' }], ai);
  await new Promise((r) => setTimeout(r, 5));
  await page.dom.$('#patchTest').onclick();
}
const fixBar = (page) => page.dom.$('#patchTestOut').querySelectorAll('.fix-bar')[0];

test('화면: 적용 후 검사가 실패하면 [실패 로그를 AI에게 돌려 다시 받기]가 나오고, 누르면 로그를 보내고 창을 닫는다 (자동 적용 없음)', async () => {
  const page = devtestPage({ trialResult: FAILED });
  await runTrial(page, { id: 'claude', name: 'Claude' });
  const bar = fixBar(page);
  assert.ok(bar, '돌려 보내기 줄');
  assert.match(bar.textContent, /적용 후 실패: test/);
  const go = walk(bar).find((n) => n.tag === 'button');
  assert.match(go._text, /실패 로그를 Claude에게 돌려 다시 받기 \(1\/2\)/);
  assert.equal(go.disabled, false);
  assert.match(bar.textContent, /자동 적용 없음/);
  await go.listeners.click();
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0].id, 'claude');
  assert.match(page.sent[0].text, /\[바꾼 파일\] src\/a\.js/);
  assert.match(page.sent[0].text, /### test — npm test \(종료 코드 1, 적용 전에는 통과했어\)\n```\nAssertionError: boom/);
  assert.equal(page.P.hidden, true); // 미리보기 창을 닫아 답을 기다린다
  assert.equal(page.P.fixRounds.get('claude'), 1);
  assert.match(page.dom.$('#sendHint').textContent, /Claude에게 실패 로그를 돌려 보냈습니다 \(1\/2\)[\s\S]*자동으로 적용하지 않습니다/);
});

test('화면: 횟수를 다 쓰면 단추가 꺼지고, 최대 횟수는 0~3으로 고르며 기억하고, 끄면 단추가 꺼진다', async () => {
  const page = devtestPage({ trialResult: FAILED });
  page.P.fixRounds.set('claude', 2); // 기본 2번을 이미 씀
  await runTrial(page, { id: 'claude', name: 'Claude' });
  let bar = fixBar(page);
  let go = walk(bar).find((n) => n.tag === 'button');
  assert.equal(go.disabled, true);
  assert.match(bar.textContent, /돌려 보낼 수 있는 횟수\(2번\)를 다 썼습니다/);
  // 최대 횟수를 3으로 → 단추가 다시 켜지고 이 PC에 기억
  const sel = walk(bar).find((n) => n.tag === 'select' || n.listeners?.change);
  assert.ok(sel, '횟수 고르기');
  sel.value = '3';
  sel.listeners.change();
  assert.equal(page.store.get('mla-fix-max'), '3');
  bar = fixBar(page);
  go = walk(bar).find((n) => n.tag === 'button');
  assert.equal(go.disabled, false);
  assert.match(go._text, /\(3\/3\)/);
  // 끔(0)
  const sel0 = walk(bar).find((n) => n.listeners?.change);
  sel0.value = '0';
  sel0.listeners.change();
  go = walk(fixBar(page)).find((n) => n.tag === 'button');
  assert.equal(go.disabled, true);
});

test('화면: 통과했거나 · 섞어서 적용(AI 없음) · 실행 오류 · 시간 초과 · 프로젝트를 보낼 수 없는 AI이면 돌려 보내지 않는다', async () => {
  const pass = devtestPage({ trialResult: { ok: true, results: [{ name: 'test', before: { ok: false }, after: { ok: true, code: 0, output: '' } }] } });
  await runTrial(pass, { id: 'claude', name: 'Claude' });
  assert.equal(fixBar(pass), undefined);
  const mixed = devtestPage({ trialResult: FAILED });
  await runTrial(mixed, { id: null, name: 'A + B', mixed: true });
  assert.equal(fixBar(mixed), undefined);
  const none = devtestPage({ trialResult: FAILED });
  await runTrial(none, undefined);
  assert.equal(fixBar(none), undefined);
  for (const after of [{ ok: false, error: '실행하지 못함', output: '' }, { ok: false, timedOut: true, output: '' }, { ok: false, stopped: true, output: '' }]) {
    const p = devtestPage({ trialResult: { ok: true, results: [{ name: 'test', before: { ok: true }, after }] } });
    await runTrial(p, { id: 'claude', name: 'Claude' });
    assert.equal(fixBar(p), undefined, JSON.stringify(after));
  }
  // 프로젝트를 보내지 않기로 한 AI
  const blocked = devtestPage({ trialResult: FAILED, allowed: false });
  await runTrial(blocked, { id: 'claude', name: 'Claude' });
  await walk(fixBar(blocked)).find((n) => n.tag === 'button').listeners.click();
  assert.equal(blocked.sent.length, 0);
  assert.match(blocked.dom.$('#patchStatus').textContent, /Claude에는 프로젝트 내용을 보내지 않도록/);
  // 보내기 실패
  const failSend = devtestPage({ trialResult: FAILED, sendResult: { ok: false, error: '패널이 닫혔습니다' } });
  await runTrial(failSend, { id: 'claude', name: 'Claude' });
  await walk(fixBar(failSend)).find((n) => n.tag === 'button').listeners.click();
  assert.equal(failSend.P.fixRounds.get('claude'), undefined); // 보내지 못했으면 횟수를 쓰지 않는다
  assert.match(failSend.dom.$('#patchStatus').textContent, /패널이 닫혔습니다/);
});

test('실패 로그 연결: 새 질문 · 적용하면 횟수를 다시 세고, 미리보기가 그 AI를 넘긴다', () => {
  const ch = read('src/renderer/project-changes.js');
  assert.match(ch, /P\.fixRounds = new Map\(\)/);
  assert.match(ch, /bars\.clear\(\);\s+P\.fixRounds\.clear\(\);/);
  assert.match(ch, /function afterApplied\(entry, text\) \{\s+P\.fixRounds\.clear\(\);/);
  assert.match(ch, /setupTestRun\(chosenPlans, ai\);/);
  assert.match(read('src/renderer/project-mix.js'), /P\.setupTestRun\(\(\) => chosen\(\)\.plans\);/); // 섞어서 적용은 AI가 없다
});

// ---------- 관련 파일 찾기 ----------
test('import 읽기: JS · TS는 상대 경로만, Python은 상대 · 프로젝트 안 모듈, 주석은 건너뜀', () => {
  const js = `
    import a from './a';
    import { b } from "../lib/b.js";
    import './side-effect';
    export * from './re-export';
    const c = require('./c');
    const d = await import('./d');
    import pkg from 'react';
    import node from 'node:fs';
    // import fake from './commented';
    /* import fake2 from './block'; */
  `;
  assert.deepEqual(IG.parseImports('src/x.js', js).map((i) => i.spec), ['./a', '../lib/b.js', './side-effect', './re-export', './c', './d']);
  assert.deepEqual(IG.parseImports('src/x.ts', "import type { T } from './types';").map((i) => i.spec), ['./types']);
  const py = ['from .utils import helper', 'from . import config, models', 'from ..core.base import Base', 'from app.services import mailer', 'import app.db', 'import os, sys', '# from .commented import z', 'from pkg import (a,', '    b)'].join('\n');
  const specs = IG.parseImports('app/web/views.py', py).map((i) => i.spec);
  for (const s of ['.utils', '.config', '.models', '..core.base', 'app.services', 'app.services.mailer', 'app.db', 'os', 'sys']) assert.ok(specs.includes(s), s);
  assert.ok(!specs.some((s) => /commented/.test(s)));
  assert.deepEqual(IG.parseImports('README.md', "import a from './a'"), []);
});

test('import 풀기: 확장자 없는 경로 · index · .js로 쓴 TS import, Python 상대 · 맨 위 · src 아래 모듈', () => {
  const paths = new Set(['src/user.js', 'src/cache.js', 'src/lib/index.js', 'src/types.ts', 'src/ui/Button.tsx', 'data/x.json', 'app/db.py', 'app/services/__init__.py', 'app/services/mailer.py', 'app/web/views.py', 'app/web/utils.py', 'app/web/config.py', 'app/core/base.py', 'src/pkg/mod.py']);
  const js = (from, spec) => IG.resolveImport(from, { spec, rel: true }, paths);
  assert.equal(js('src/user.js', './cache'), 'src/cache.js');
  assert.equal(js('src/user.js', './cache.js'), 'src/cache.js');
  assert.equal(js('src/user.js', './lib'), 'src/lib/index.js');
  assert.equal(js('src/user.js', './types.js'), 'src/types.ts'); // TS는 .js로 쓴다
  assert.equal(js('src/user.js', './ui/Button'), 'src/ui/Button.tsx');
  assert.equal(js('src/user.js', '../data/x.json'), 'data/x.json');
  assert.equal(js('src/user.js', './missing'), null);
  assert.equal(js('src/user.js', '../../outside'), null); // 프로젝트 밖
  const py = (from, spec, rel) => IG.resolveImport(from, { spec, rel }, paths);
  assert.equal(py('app/web/views.py', '.utils', true), 'app/web/utils.py');
  assert.equal(py('app/web/views.py', '.config', true), 'app/web/config.py');
  assert.equal(py('app/web/views.py', '..core.base', true), 'app/core/base.py');
  assert.equal(py('app/web/views.py', 'app.services', false), 'app/services/__init__.py');
  assert.equal(py('app/web/views.py', 'app.services.mailer', false), 'app/services/mailer.py');
  assert.equal(py('app/web/views.py', 'app.db', false), 'app/db.py');
  assert.equal(py('app/web/views.py', 'pkg.mod', false), 'src/pkg/mod.py'); // src 레이아웃
  assert.equal(py('app/web/views.py', 'os', false), null); // 표준 라이브러리
  assert.equal(IG.resolveImport('a.md', { spec: './b', rel: true }, paths), null);
});

test('관련 파일 찾기: 깊이 2까지 · 가까운 것부터, 고른 파일 · 중복 없음, 못 읽는 파일은 더 따라가지 않음, 최대 개수', async () => {
  const files = {
    'src/user.js': "import { get } from './cache';\nimport { api } from './api';\nconst u = require('./util/format');",
    'src/cache.js': "import { store } from './store';",
    'src/api.js': "import { get } from './cache';\nimport cfg from '../config';",
    'src/store.js': "import deep from './deep';", // 깊이 3 — 따라가지 않는다
    'src/deep.js': 'export default 1;',
    'src/util/format.js': 'export const f = 1;',
    'config.js': 'export default {};',
    'big.js': "import x from './src/deep';",
  };
  const paths = new Set(Object.keys(files));
  const read = async (p) => files[p] ?? null;
  const r = await IG.relatedFiles({ selected: ['src/user.js'], paths, readText: read });
  assert.deepEqual(r.map((x) => [x.path, x.from, x.depth]), [
    ['src/cache.js', 'src/user.js', 1],
    ['src/api.js', 'src/user.js', 1],
    ['src/util/format.js', 'src/user.js', 1],
    ['src/store.js', 'src/cache.js', 2],
    ['config.js', 'src/api.js', 2],
  ]);
  assert.ok(!r.some((x) => x.path === 'src/deep.js')); // 깊이 3
  assert.ok(!r.some((x) => x.path === 'src/user.js')); // 고른 파일
  assert.deepEqual((await IG.relatedFiles({ selected: ['src/user.js'], paths, readText: read, depth: 1 })).map((x) => x.depth), [1, 1, 1]);
  assert.equal((await IG.relatedFiles({ selected: ['src/user.js'], paths, readText: read, max: 2 })).length, 2);
  // 이미 고른 파일은 목록에서 빠진다
  assert.ok(!(await IG.relatedFiles({ selected: ['src/user.js', 'src/cache.js'], paths, readText: read })).some((x) => x.path === 'src/cache.js'));
  // 못 읽거나 너무 큰 파일은 더 따라가지 않는다 · 읽다 오류가 나도 멈추지 않는다
  const huge = { ...files, 'src/cache.js': `${'x'.repeat(300001)}\nimport { store } from './store';` };
  const h = await IG.relatedFiles({ selected: ['src/user.js'], paths, readText: async (p) => huge[p] ?? null });
  assert.ok(!h.some((x) => x.path === 'src/store.js'));
  const err = await IG.relatedFiles({ selected: ['src/user.js'], paths, readText: async (p) => { if (p === 'src/cache.js') throw new Error('읽기 오류'); return files[p] ?? null; } });
  assert.ok(err.some((x) => x.path === 'src/api.js'));
  // 프로젝트에 없는(제외된) 파일은 제안하지 않는다
  const some = await IG.relatedFiles({ selected: ['src/user.js'], paths: new Set(['src/user.js', 'src/cache.js']), readText: read });
  assert.deepEqual(some.map((x) => x.path), ['src/cache.js']);
  assert.deepEqual(await IG.relatedFiles({ selected: [], paths, readText: read }), []);
  assert.deepEqual(await IG.relatedFiles({ selected: ['README.md'], paths: new Set(['README.md']), readText: async () => "import a from './a'" }), []); // JS · Python이 아닌 파일은 읽지 않는다
  // 순환 import도 한 번씩만
  const cyc = { 'a.js': "import './b'", 'b.js': "import './a'" };
  assert.deepEqual((await IG.relatedFiles({ selected: ['a.js'], paths: new Set(Object.keys(cyc)), readText: async (p) => cyc[p] })).map((x) => x.path), ['b.js']);
  assert.equal(IG.normalize('a/b/../c/./d'), 'a/c/d');
  assert.equal(IG.normalize('../x'), null);
});

test('관련 파일 화면: 단추 · 목록 · 추가(파일 하나씩 고르기와 같은 확인), 비어 있으면 안내', async () => {
  const dom = fakeDom();
  const files = { 'src/user.js': "import './cache'; import './api';", 'src/cache.js': '', 'src/api.js': '' };
  const checked = new Set(['src/user.js']);
  const toggled = [];
  const P = {
    has: () => true,
    project: { checked, scan: { entries: Object.keys(files).map((p) => ({ path: p, size: 2048 })) } },
    sendablePaths: () => Object.keys(files),
    entryOf: (p) => ({ path: p }),
    toggleFile: async (e) => (toggled.push(e.path), e.path !== 'src/api.js' && checked.add(e.path)), // api.js는 비밀 정보 확인에서 취소했다고 치자
    notice: (m) => (P.noticed = m),
  };
  const ctx = {
    MLA: { projectUI: P, importGraph: IG },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    host: { project: { readFile: async (p) => ({ text: files[p] }) } },
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/project-related.js'), ctx);
  await dom.$('#psRelated').listeners.click();
  const box = dom.$('#psRelatedBox');
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /고른 파일이 부르는 파일 2개/);
  const rows = box.querySelectorAll('.related-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /src\/cache\.js1단계 · 2KB/);
  assert.match(rows[0].title, /src\/user\.js에서 부름/);
  // 체크 상자(가짜)를 모두 켠 채 [선택한 파일 추가]
  const boxes = rows.map((r) => r.children[0]);
  boxes.forEach((b) => (b.checked = true));
  box.querySelectorAll = (sel) => (sel.includes('checkbox') ? boxes.filter((b) => b.checked) : []);
  const add = walk(box).find((n) => n.tag === 'button' && /선택한 파일 추가/.test(n._text));
  await add.listeners.click();
  assert.deepEqual(toggled, ['src/cache.js', 'src/api.js']);
  assert.equal(P.noticed, '관련 파일 1개를 더했습니다'); // api.js는 확인에서 취소해 빠짐
  assert.equal(box.hidden, true);
  // 고른 파일이 없으면 안내만
  checked.clear();
  await dom.$('#psRelated').listeners.click();
  assert.match(P.noticed, /보낼 파일을 하나 이상 고르세요/);
});

// ---------- 새 브랜치에 적용 ----------
test('브랜치 이름: mla/로 시작하는 짧은 글자만, 옵션처럼 보이거나 위험한 이름은 거절, 제안은 날짜 + 영문 이름', () => {
  for (const ok of ['mla/20261117-claude', 'mla/a', 'mla/fix_1.2-x', 'mla/' + 'a'.repeat(60)]) assert.equal(BN.checkBranchName(ok).ok, true, ok);
  assert.equal(BN.checkBranchName('  mla/x  ').name, 'mla/x'); // 앞뒤 공백은 뗀다
  for (const bad of ['main', '-D', 'mla/', 'mla/-x', 'mla/a b', 'mla/a..b', 'mla/a.', 'mla/a.lock', 'mla/a--b', 'mla/한글', 'mla/a;rm', 'mla/' + 'a'.repeat(61), 'x/mla/a', '', null, 7, '--detach', 'mla/a@{u}']) {
    const r = BN.checkBranchName(bad);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /mla\//);
  }
  assert.equal(BN.suggestBranchName({ date: new Date(2026, 10, 17), label: 'Claude' }), 'mla/20261117-claude');
  assert.equal(BN.suggestBranchName({ date: new Date(2026, 0, 5), label: 'Claude + ChatGPT' }), 'mla/20260105-claude-chatgpt');
  assert.equal(BN.suggestBranchName({ date: new Date(2026, 10, 17), label: '한글만' }), 'mla/20261117-change');
  assert.equal(BN.suggestBranchName({ date: new Date(2026, 10, 17) }), 'mla/20261117-change');
  assert.equal(BN.checkBranchName(BN.suggestBranchName({ label: 'x'.repeat(100) })).ok, true); // 길어도 규칙 안
  assert.equal(BN.checkBranchName(BN.suggestBranchName({ date: new Date('nope'), label: 'a' })).ok, true);
  assert.equal(C.checkBranchName, BN.checkBranchName);
});

test('git 인자: 새 브랜치는 switch -c <mla/…> 한 가지만 허용 (다른 switch · 옵션은 거절)', () => {
  assert.deepEqual(C.branchSwitchArgs('mla/x').slice(C.PREFIX.length), ['switch', '-c', 'mla/x']);
  assert.deepEqual(C.branchExistsArgs('mla/x').slice(C.PREFIX.length), ['rev-parse', '--verify', '--quiet', 'refs/heads/mla/x']);
  assert.equal(C.isAllowedCommitStep(C.branchSwitchArgs('mla/20261117-claude')), true);
  assert.equal(C.isAllowedCommitStep(C.branchExistsArgs('mla/x')), true);
  assert.equal(C.isAllowedCommitStep([...C.PREFIX, 'switch', 'main']), false);
  assert.equal(C.isAllowedCommitStep([...C.PREFIX, 'switch', '-c', 'main']), false); // mla/ 밖의 이름
  assert.equal(C.isAllowedCommitStep([...C.PREFIX, 'switch', '-c', 'mla/x', '--force']), false);
  assert.equal(C.isAllowedCommitStep([...C.PREFIX, 'switch', '--discard-changes', 'mla/x']), false);
  assert.equal(C.isAllowedCommitStep([...C.PREFIX, 'checkout', '-b', 'mla/x']), false);
  assert.equal(C.isAllowedCommitStep([...C.PREFIX, 'push']), false); // push는 여전히 없다
  assert.equal(C.isAllowedCommitStep(C.addArgs(['a.js'])), true);
});

test('새 브랜치 만들기: 실제 git 저장소에서 (메인 처리) — 만들고 옮겨 가며 고친 파일은 따라오고, 있는 이름 · 나쁜 이름 · 저장소가 아닌 폴더는 거절', { timeout: 60000 }, async (t) => {
  const { spawnSync } = require('child_process');
  const gitOk = spawnSync('git', ['--version']);
  if (gitOk.status !== 0) return t.skip('git을 찾지 못함');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-branch-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: tmp, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'edited but uncommitted\n');
  const { setupGitCommit } = requireWithFakeElectron('../src/main/gitcommit', { dialog: {}, app: { getPath: () => tmp } });
  const handlers = {};
  let root = tmp;
  setupGitCommit({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getRoot: () => root, gitExe: () => 'git' });
  const call = (name, ...a) => handlers[name]({}, ...a);
  assert.ok(handlers['git:branchCreate']);
  // 나쁜 이름은 git을 부르기 전에 거절
  assert.match((await call('git:branchCreate', '--detach')).error, /mla\//);
  assert.match((await call('git:branchCreate', 'main')).error, /mla\//);
  assert.match((await call('git:branchCreate', 7)).error, /mla\//);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main');
  // 만들기
  const ok = await call('git:branchCreate', 'mla/20261117-test');
  assert.deepEqual(ok, { ok: true, branch: 'mla/20261117-test', from: 'main' });
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'mla/20261117-test');
  assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), 'edited but uncommitted\n'); // 고친 파일은 따라온다
  // 이미 있는 이름
  git('switch', '-q', 'main');
  const dup = await call('git:branchCreate', 'mla/20261117-test');
  assert.equal(dup.ok, false);
  assert.match(dup.error, /이미 있습니다/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main');
  // 저장소가 아닌 폴더
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  root = plain;
  // (이 PC의 임시 폴더 위쪽에 우연히 git 저장소가 있어도 거기까지 올라가 찾지 않게 한다)
  const ceil = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  let nr;
  try {
    nr = await call('git:branchCreate', 'mla/x');
  } finally {
    if (ceil === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceil;
  }
  assert.equal(nr.ok, false);
  assert.equal(nr.notRepo, true);
  root = null;
  assert.equal((await call('git:branchCreate', 'mla/x')).ok, false); // 프로젝트가 없음
});

test('새 브랜치 화면: 적용 창에 체크 · 이름, 체크했을 때만 적용 직전에 만들고 실패하면 적용하지 않는다', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /<span id="patchBranch" class="patch-branch" hidden>[\s\S]*<input type="checkbox" id="patchBranchOn" \/>[\s\S]*<input id="patchBranchName" type="text"/);
  assert.ok(html.indexOf('shared/branch-name.js') > 0);
  const ch = read('src/renderer/project-changes.js');
  assert.match(ch, /\$\('#patchBranchOn'\)\.checked = false; \/\/ 누를 때만/); // 창을 열 때마다 꺼 둔다
  assert.match(ch, /const branch = await P\.prepareBranch\(\);[\s\S]*if \(!branch\.ok\) return;[\s\S]*applyPlans\(ai, chosen\)/);
  assert.match(ch, /if \(\$\('#patchBranch'\)\.hidden \|\| !\$\('#patchBranchOn'\)\.checked\) return \{ ok: true \};/);
  assert.match(ch, /if \(!host\.git\?\.createBranch \|\| !P\.has\(\)\) return \(row\.hidden = true\);/); // 크롬 확장(git 없음)에서는 보이지 않는다
  const mix = read('src/renderer/project-mix.js');
  assert.match(mix, /const branch = await P\.prepareBranch\(\);[\s\S]*if \(!branch\.ok\) return;[\s\S]*P\.applyPlans\(ai, plans, \{ sources \}\)/);
  assert.match(read('src/preload/preload.js'), /createBranch: \(name\) => ipcRenderer\.invoke\('git:branchCreate', name\)/);
  assert.match(read('src/main/gitcommit.js'), /ipcMain\.handle\('git:branchCreate'/);
  assert.ok(!/\bpush\b/.test(read('src/main/gitcommit.js').replace(/\/\/.*$/gm, '').replace(/'[^']*push[^']*'/g, ''))); // 코드에 push 명령이 없다
});

test('연결: 관련 파일 · 브랜치 이름 모듈이 화면과 확장에 들어가고, 사이드바에 단추가 있다', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /<button id="psRelated" data-i18n="project\.related\.btn"/);
  assert.match(html, /id="psRelatedBox" class="ps-related" hidden/);
  assert.ok(html.indexOf('shared/import-graph.js') < html.indexOf('src="project.js"'));
  assert.ok(html.indexOf('src="project.js"') < html.indexOf('src="project-related.js"') && html.indexOf('src="project-related.js"') < html.indexOf('src="project-changes.js"'));
  const app = read('extension/app.html');
  for (const f of ['lib/shared/import-graph.js', 'lib/shared/branch-name.js', 'lib/renderer/project-related.js']) assert.ok(app.includes(f), f);
  assert.match(read('scripts/build-extension.js'), /'project-related\.js'/);
  assert.match(read('src/renderer/project.js'), /Object\.assign\(P, \{ entryOf, toggleFile, sendablePaths,/);
});
