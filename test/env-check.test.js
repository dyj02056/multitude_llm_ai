'use strict';
// 개발 환경 점검 (v0.41.0) 테스트:  npm test
// [쉽게 말하면]
//   - 규칙(shared/env-rules.js): 파일로 필요한 도구 고르기 · 버전 요구 읽기 · 버전 비교 · 판정 · 준비 상태 · 포트
//   - 본체(main/envcheck.js): PATH의 절대 경로만 · 프로젝트 안 실행 파일 안 씀 · Store 가짜 python 건너뜀 · .cmd는 실행 안 함 · 정해 둔 인자만
//   - 화면(dev-hub.js)을 가짜 화면으로: 프로젝트를 열면 점검 → 사이드바 색 · 칩 · 자세히 창 · 목록 고치기, 확장은 목록만
//   - 연결(사이드바 자리 · 스크립트 순서 · 확장 빌드 · preload 통로)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const E = require('../src/shared/env-rules');
const C = require('../src/main/envcheck');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const ids = (needs) => needs.map((n) => n.group || n.id);

// ---------- 규칙 ----------
test('필요한 도구 고르기: 표시 파일 → 도구 (잠금 파일 · 래퍼 · 묶음 · 선택 도구)', () => {
  const node = E.detectNeeds([{ name: '.git', kind: 'dir' }, 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'playwright.config.ts'], { 'package.json': '{"devDependencies":{"vercel":"1"}}' });
  assert.deepEqual(ids(node), ['git', 'node', 'npm', 'npx', 'pnpm', 'pwbrowsers', 'vercel']);
  assert.equal(node.find((n) => n.id === 'vercel').optional, true);
  assert.equal(node.find((n) => n.id === 'git').because, '.git');

  const py = E.detectNeeds(['pyproject.toml', 'poetry.lock'], { 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' });
  assert.deepEqual(ids(py), ['git', 'python', 'pip', 'poetry', 'ruff']);

  const jvm = E.detectNeeds(['pom.xml', 'mvnw', 'build.gradle.kts', 'gradlew']);
  assert.equal(jvm.find((n) => n.id === 'mvn').optional, true); // 래퍼가 있으면 Maven은 없어도 됨
  assert.equal(jvm.find((n) => n.id === 'gradle').optional, true);
  assert.ok(ids(jvm).includes('jdk'));

  const cpp = E.detectNeeds(['CMakeLists.txt', 'main.cpp', '.clang-format']);
  assert.deepEqual(ids(cpp), ['git', 'cmake', 'cxx', 'clangformat']);
  assert.deepEqual(E.idsOf(cpp).filter((i) => i !== 'git'), ['cmake', 'gpp', 'clang', 'msvc', 'clangformat']);
  assert.deepEqual(ids(E.detectNeeds(['Makefile', 'hello.c'])), ['git', 'make', 'cc']);

  const misc = E.detectNeeds(['App.csproj', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json', 'pubspec.yaml', 'compose.yaml', 'main.tf', { name: 'k8s', kind: 'dir' }], { 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n', 'compose.yaml': 'services:\n  db:\n    image: postgres:16\n' });
  for (const id of ['dotnet', 'cargo', 'rustc', 'go', 'ruby', 'bundler', 'php', 'composer', 'flutter', 'docker', 'psql', 'terraform', 'kubectl']) assert.ok(ids(misc).includes(id), id);
  assert.equal(misc.find((n) => n.id === 'psql').optional, true);
  assert.deepEqual(ids(E.detectNeeds([])), ['git']); // 빈 폴더도 git은 기본
});

test('버전 요구 읽기와 비교: npm 꼴 · 파이썬 꼴 · 모르는 꼴은 판단하지 않음', () => {
  const reqs = E.requirements({
    'package.json': '{"engines":{"node":">=20 <23"}}',
    'pyproject.toml': 'requires-python = ">=3.11"\n',
    'pom.xml': '<properties><maven.compiler.release>21</maven.compiler.release></properties>',
    'go.mod': 'module x\n\ngo 1.22\n',
    'Cargo.toml': 'rust-version = "1.75"\n',
    'global.json': '{"sdk":{"version":"8.0.100"}}',
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n',
  });
  assert.deepEqual(Object.fromEntries(Object.entries(reqs).map(([k, v]) => [k, v.range])), { node: '>=20 <23', python: '>=3.11', jdk: '>=21', go: '>=1.22', rustc: '>=1.75', dotnet: '>=8.0.100', cmake: '>=3.20' });
  assert.equal(E.requirements({ '.nvmrc': 'v22\n' }).node.range, '22');
  const cases = [
    ['22.11.0', '>=20 <23', true], ['23.0.0', '>=20 <23', false], ['18.20.0', '^18 || ^20', true], ['19.0.0', '^18 || ^20', false],
    ['3.12.7', '~=3.10', true], ['4.0.0', '~=3.10', false], ['3.12.7', '==3.12.*', true], ['3.10.11', '>=3.11', false],
    ['22.11.0', '22', true], ['21.0.2', '>=21', true], ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['5.0.0', '18.x', false],
  ];
  for (const [v, r, want] of cases) assert.equal(E.satisfies(v, r), want, `${v} ${r}`);
  assert.equal(E.satisfies('1.0.0', 'lts/*'), true);
  assert.equal(E.satisfies('1.0.0', 'banana'), null);
  assert.equal(E.parseVersion('gcc (Rev2, Built by MSYS2 project) 14.2.0'), '14.2.0');
  assert.equal(E.parseVersion('go version go1.22.3 windows/amd64'), '1.22.3');
  assert.equal(E.parseVersion('openjdk version "21.0.2" 2024-01-16'), '21.0.2');
  assert.equal(E.parseVersion('nothing'), null);
});

test('판정: 없음 · 선택 · PATH에 없음 · 버전 안 맞음 · 묶음은 있는 것 하나로', () => {
  const needs = [{ id: 'node', because: 'package.json' }, { id: 'vercel', because: 'vercel.json', optional: true }, { id: 'jdk', because: 'pom.xml' }, { group: 'cc', because: 'Makefile' }, { id: 'python', because: 'pyproject.toml' }, { id: 'go', because: 'go.mod' }];
  const found = { node: { state: 'ok', version: '18.0.0' }, vercel: { state: 'missing' }, jdk: { state: 'missing' }, gcc: { state: 'missing' }, clang: { state: 'ok', version: '18.1.0' }, msvc: { state: 'missing' }, python: { state: 'notOnPath', version: '3.12.1', path: 'C:\\Py\\python.exe' }, go: { state: 'ok', version: '1.22.0' } };
  const rows = E.evaluate(needs, found, { node: { range: '>=20', from: 'package.json engines' } }, new Set(['go']));
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.node.level, 'warn');
  assert.equal(by.node.state, 'version');
  assert.equal(by.vercel.level, 'off');
  assert.equal(by.jdk.level, 'error');
  assert.equal(by.cc.level, 'ok');
  assert.equal(by.cc.pick, 'clang');
  assert.equal(by.python.level, 'warn');
  assert.equal(by.go, undefined); // 무시한 도구
  assert.deepEqual(E.summarize(rows), { ok: 1, warn: 2, error: 1, off: 1, unknown: 0, total: 5 });
  // 확장(점검 결과 없음): 모두 unknown
  assert.ok(E.evaluate(needs, null).every((r) => r.level === 'unknown'));
  // AI에게 줄 한 줄: 이름 · 버전만, 경로 없음
  const line = E.envLine(rows);
  assert.match(line, /Node\.js 18\.0\.0/);
  assert.match(line, /JDK \(javac\): -/);
  assert.doesNotMatch(line, /C:\\/);
});

test('준비 상태 · 포트 · 설치 안내 · 본체에 넘기는 값 검사', () => {
  const r = E.readiness(['package.json', 'yarn.lock', '.env.example', 'requirements.txt'], { 'package.json': '{"dependencies":{"x":"1"}}' });
  assert.deepEqual(r.map((x) => [x.key, x.cmd]), [['nodeModules', 'yarn install'], ['venv', 'py -m venv .venv'], ['envFile', 'copy .env.example .env']]);
  assert.deepEqual(E.readiness(['package.json', 'node_modules', '.env', '.env.example', 'requirements.txt', '.venv'], { 'package.json': '{"dependencies":{"x":"1"}}' }), []);
  assert.deepEqual(E.readiness(['package.json'], { 'package.json': '{}' }), []); // 의존성이 없으면 설치할 것도 없다
  assert.deepEqual(E.devPorts(['package.json', 'manage.py'], { 'package.json': '{"devDependencies":{"vite":"6","next":"15"}}' }), [5173, 3000, 8000]);
  assert.equal(E.installHint('node'), 'winget install --id OpenJS.NodeJS.LTS -e');
  assert.equal(E.installHint('yarn'), 'corepack enable');
  for (const id of E.TOOL_IDS) assert.match(E.TOOLS[id].url, /^https:\/\//, id); // 설치 안내는 https 주소만
  assert.deepEqual(E.cleanCheckRequest({ tools: ['node', 'rm -rf', 'node', 42], ports: [80, 5173, 5173, 3000.5, 70000] }), { tools: ['node'], ports: [5173], docker: false, javaHome: false });
  assert.equal(E.cleanCheckRequest(null), null);
});

// ---------- 본체 ----------
const WIN_ENV = (extra = {}) => ({ PATH: ['C:\\Windows\\System32', 'relative\\bin', 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps', 'C:\\proj\\tools', 'C:\\Program Files\\nodejs', 'C:\\tools'].join(';'), USERPROFILE: 'C:\\Users\\me', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ...extra });

test('실행 파일 찾기: PATH의 절대 경로만 · 프로젝트 안은 건너뜀 · Store python 건너뜀 · py 런처 · PATH 밖 설치 자리 · .cmd', () => {
  const files = new Set(['relative\\bin\\git.exe', 'C:\\proj\\tools\\go.exe', 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', 'C:\\Windows\\System32\\py.exe', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\tools\\pnpm.cmd', 'C:\\msys64\\ucrt64\\bin\\gcc.exe']);
  const deps = { env: WIN_ENV(), platform: 'win32', root: 'C:\\proj', exists: (f) => files.has(f), listDir: () => [] };
  assert.equal(C.findTool('git', deps).state, 'missing'); // 상대 경로 PATH는 보지 않는다
  assert.equal(C.findTool('go', deps).state, 'missing'); // 프로젝트 안의 go.exe는 쓰지 않는다
  const py = C.findTool('python', deps);
  assert.equal(py.path, 'C:\\Windows\\System32\\py.exe');
  assert.equal(py.launcher, true);
  assert.deepEqual(C.findTool('node', deps), { state: 'ok', path: 'C:\\Program Files\\nodejs\\node.exe', kind: 'exe' });
  assert.equal(C.findTool('pnpm', deps).kind, 'shim');
  assert.deepEqual(C.findTool('gcc', deps), { state: 'notOnPath', path: 'C:\\msys64\\ucrt64\\bin\\gcc.exe', kind: 'exe' });
  assert.equal(C.insideRoot('C:\\PROJ\\sub', 'C:\\proj', 'win32'), true);
  assert.equal(C.insideRoot('C:\\project2', 'C:\\proj', 'win32'), false);
});

test('버전 묻기 허용 규칙: 그 도구의 이름 · 정해 둔 인자 · 셸 없음 · .cmd 아님', () => {
  const opt = { shell: false };
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\node.exe', args: ['--version'], options: opt }, 'node'), true);
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\node.exe', args: ['-e', 'evil()'], options: opt }, 'node'), false);
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\evil.exe', args: ['--version'], options: opt }, 'node'), false);
  assert.equal(C.isAllowedVersionSpawn({ command: 'node.exe', args: ['--version'], options: opt }, 'node'), false);
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\node.exe', args: ['--version'], options: { shell: true } }, 'node'), false);
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\pnpm.cmd', args: ['--version'], options: opt }, 'pnpm'), false);
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\python.exe', args: ['-m', 'pip', '--version'], options: opt }, 'pip'), true);
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\py.exe', args: ['-3', '-m', 'pip', '--version'], options: opt }, 'pip'), true);
  assert.equal(C.isAllowedVersionSpawn({ command: 'C:\\x\\vswhere.exe', args: C.VSWHERE_ARGS, options: opt }, 'msvc'), true);
  const spec = C.buildVersionSpawn('python', { path: 'C:\\x\\py.exe', kind: 'exe', launcher: true }, { env: WIN_ENV() });
  assert.deepEqual(spec.args, ['-3', '--version']);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.cwd, 'C:\\Users\\me'); // 프로젝트 폴더에서 실행하지 않는다
  assert.equal(C.buildVersionSpawn('pnpm', { path: 'C:\\x\\pnpm.cmd', kind: 'shim' }), null);
});

function fakeSpawn(outputs, calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const key = path.win32.basename(cmd).toLowerCase();
    setImmediate(() => {
      const o = outputs[key];
      if (o === undefined) return child.emit('error', new Error('ENOENT'));
      (o.err ? child.stderr : child.stdout).emit('data', Buffer.from(o.text));
      child.emit('close', o.code ?? 0);
    });
    return child;
  };
}
function fakeConnect(open) {
  return (target) => {
    const s = new EventEmitter();
    s.destroy = () => {};
    const key = typeof target === 'string' ? target : target.port;
    setImmediate(() => s.emit(open.has(key) ? 'connect' : 'error', new Error('x')));
    return s;
  };
}

test('점검 한 번: 실행해서 버전 · npm은 package.json · .cmd 옆 패키지 버전 · 포트 · Docker · JAVA_HOME · 프로젝트 안 PATH 무시', async () => {
  const files = new Set([
    'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
    'C:\\tools\\pnpm.cmd', 'C:\\tools\\java.exe', 'C:\\tools\\javac.exe', 'C:\\tools\\docker.exe', 'C:\\proj\\tools\\go.exe',
  ]);
  const texts = { 'C:\\Program Files\\nodejs\\node_modules\\npm\\package.json': '{"version":"10.9.0"}', 'C:\\tools\\node_modules\\pnpm\\package.json': '{"version":"9.12.0"}' };
  const calls = [];
  const r = await C.checkEnv(
    { tools: ['node', 'npm', 'npx', 'pnpm', 'jdk', 'docker', 'go', 'python', 'bogus'], ports: [5173, 3000] },
    {
      env: WIN_ENV({ JAVA_HOME: 'C:\\jdk' }), platform: 'win32', root: 'C:\\proj',
      exists: (f) => files.has(f), listDir: () => [], readText: (f) => {
        if (!(f in texts)) throw new Error('ENOENT');
        return texts[f];
      },
      spawnFn: fakeSpawn({ 'node.exe': { text: 'v22.11.0\n' }, 'javac.exe': { text: 'javac 21.0.2\n', err: true }, 'docker.exe': { text: 'Docker version 27.3.1, build ce12230\n' } }, calls),
      connect: fakeConnect(new Set([5173])),
    },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.tools).sort(), ['docker', 'go', 'jdk', 'node', 'npm', 'npx', 'pnpm', 'python']); // 모르는 id는 무시
  assert.equal(r.tools.node.version, '22.11.0');
  assert.equal(r.tools.npm.version, '10.9.0');
  assert.equal(r.tools.npx.state, 'ok');
  assert.deepEqual([r.tools.pnpm.state, r.tools.pnpm.version], ['ok', '9.12.0']);
  assert.equal(r.tools.jdk.version, '21.0.2'); // stderr로 나오는 버전도 읽는다
  assert.equal(r.tools.go.state, 'missing'); // 프로젝트 안 PATH
  assert.equal(r.tools.python.state, 'missing');
  assert.deepEqual(r.ports, { 5173: true, 3000: false });
  assert.equal(r.docker, 'off');
  assert.deepEqual(r.javaHome, { set: true, ok: false, path: 'C:\\jdk' });
  // 실행한 것은 정해 둔 버전 묻기뿐 (.cmd · npm-cli.js는 실행하지 않음)
  assert.deepEqual(calls.map((c) => [path.win32.basename(c[0]), ...c.slice(1)]).sort(), [['docker.exe', '--version'], ['javac.exe', '-version'], ['node.exe', '--version']]);
  assert.deepEqual((await C.checkEnv('x')).ok, false);
});

// ---------- 화면 ----------
function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: '', children: [], dataset: {}, title: '', _text: '', hidden: false, disabled: false, value: '', checked: false, type: '', listeners: {}, attrs: {} });
      const cls = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = { add: (c) => (this.className = [...cls().add(c)].join(' ')), toggle: (c, on) => { const s = cls(); if (on ?? !s.has(c)) s.add(c); else s.delete(c); this.className = [...s].join(' '); }, contains: (c) => cls().has(c) };
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...kids) { this.children.push(...kids); }
    replaceChildren(...kids) { this.children = kids; this._text = ''; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(k, v) { this.attrs[k] = v; }
    querySelectorAll() { return []; }
    focus() {}
    all() { return [this, ...this.children.flatMap((c) => (typeof c === 'string' ? [] : c.all()))]; }
  }
  const byId = new Map();
  const $ = (sel) => {
    if (!byId.has(sel)) byId.set(sel, new El('div'));
    return byId.get(sel);
  };
  return { El, $, document: { createElement: (t) => new El(t), createTextNode: (s) => s } };
}

function setup({ env = true, files = ['package.json', 'pom.xml'], texts = { 'package.json': '{"engines":{"node":">=20"},"dependencies":{"x":"1"}}', 'pom.xml': '<maven.compiler.release>21</maven.compiler.release>' }, result } = {}) {
  i18n.setLang('ko');
  const dom = fakeDom();
  const logs = { checks: [], copies: [], views: [], guides: [] };
  const store = new Map();
  const state = { chatView: 'panels' };
  const host = {
    setView: (v) => logs.views.push(v),
    copyText: async (s) => logs.copies.push(s),
    project: {
      readDir: async () => files.map((n) => ({ name: n, kind: n.includes('.') ? 'file' : 'dir' })),
      readFile: async (p) => (p in texts ? { text: texts[p] } : { missing: true }),
    },
    ...(env
      ? {
          env: {
            check: async (req) => (logs.checks.push(req), result || { ok: true, at: 1, tools: { git: { state: 'ok', version: '2.47.1' }, node: { state: 'ok', version: '22.11.0' }, npm: { state: 'ok', version: '10.9.0' }, npx: { state: 'ok', version: '10.9.0' }, jdk: { state: 'missing' }, mvn: { state: 'missing' } }, ports: {}, docker: null, javaHome: { set: false } }),
            openInstall: async (id) => logs.guides.push(id),
          },
        }
      : {}),
  };
  let open = true;
  const P = { has: () => open, project: { info: { id: 'C:\\p1', name: 'p1' } } };
  const ctx = {
    MLA: { envRules: E, i18n, projectUI: P },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state,
    host,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    window: { open: (u) => logs.guides.push(u) },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    console,
    setTimeout: (fn) => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/dev-hub.js'), ctx);
  return { ...dom, logs, ctx, store, state, close: () => (open = false), hub: () => ctx.MLA.devHub };
}

test('화면: 프로젝트를 열면 점검 → 사이드바가 빨강 + 없는 도구 칩 + 있는 도구 한 칩 + 준비 상태 줄 → 자세히 창', async () => {
  const h = setup();
  h.ctx.window.onDevProject();
  await tick(30);
  assert.equal(h.logs.checks.length, 1);
  assert.deepEqual(h.logs.checks[0].tools, ['git', 'node', 'npm', 'npx', 'jdk', 'mvn']);
  const $ = h.$;
  assert.equal($('#devHub').hidden, false);
  assert.equal($('#devHub').dataset.level, 'error');
  assert.equal($('#dhEnvPill').textContent, '✗ 없는 도구 2');
  const chips = $('#dhEnvChips').children.map((c) => c.textContent);
  assert.deepEqual(chips, ['✗ JDK (javac)', '✗ Maven', '✓ 4개 있음']);
  assert.match($('#dhEnvReady').textContent, /node_modules/);
  // 명령 복사
  const cmdBtn = $('#dhEnvReady').all().find((x) => x.tag === 'button');
  await cmdBtn.listeners.click();
  assert.deepEqual(h.logs.copies, ['npm install']);
  // 자세히 창: 패널을 치우고(dialog) 표를 그린다, 없는 도구에는 설치 명령 복사 · 안내
  $('#dhEnvMore').listeners.click();
  assert.equal($('#envModal').hidden, false);
  assert.deepEqual(h.logs.views, ['dialog']);
  const rows = $('#envRows').children;
  assert.equal(rows.length, 6);
  const jdkRow = rows.find((r) => r.textContent.includes('JDK'));
  assert.match(jdkRow.textContent, />=21 \(pom\.xml\)/);
  const btns = jdkRow.all().filter((x) => x.tag === 'button');
  await btns[0].listeners.click();
  assert.equal(h.logs.copies.at(-1), 'winget install --id Microsoft.OpenJDK.21 -e');
  await btns[1].listeners.click();
  assert.deepEqual(h.logs.guides, ['jdk']);
  assert.match($('#envSummary').textContent, /필요한 도구 6개 중 없는 것 2개/);
  // Esc로 패널 화면에 돌아가면 창을 닫는다
  h.state.chatView = 'dialog';
  h.ctx.window.onDevState();
  h.state.chatView = 'panels';
  h.ctx.window.onDevState();
  assert.equal($('#envModal').hidden, true);
});

test('화면: 모두 있으면 초록 "준비됨", 필요한 도구 고치기(빼기 · 더하기)는 프로젝트별로 기억, 닫으면 숨김', async () => {
  const ok = { ok: true, at: 1, tools: { git: { state: 'ok', version: '2.4' }, node: { state: 'ok', version: '22.1.0' }, npm: { state: 'ok', version: '10' }, npx: { state: 'ok', version: '10' } }, ports: {}, docker: null, javaHome: null };
  const h = setup({ files: ['package.json', 'node_modules'], texts: { 'package.json': '{}' }, result: ok });
  h.ctx.window.onDevProject();
  await tick(30);
  assert.equal(h.$('#devHub').dataset.level, 'ok');
  assert.equal(h.$('#dhEnvPill').textContent, '✓ 준비됨 · 필요한 도구 4개 있음');
  assert.equal(h.$('#dhEnvChips').children.length, 0);
  // 고치기: git 빼기 → 행 사라짐, go 더하기 → 다시 점검해서 없음
  h.$('#dhEnvMore').listeners.click();
  const boxes = h.$('#envEditBody').all().filter((x) => x.tag === 'input');
  const gitBox = h.$('#envEditBody').all().find((x) => x.tag === 'label' && x.textContent.includes(' git'))?.children[0];
  gitBox.checked = false;
  gitBox.listeners.change();
  assert.ok(!h.hub().env.rows.some((r) => r.key === 'git'));
  const goBox = h.$('#envEditBody').all().find((x) => x.tag === 'label' && x.textContent.trim() === 'Go')?.children[0];
  goBox.checked = true;
  await goBox.listeners.change();
  await tick(30);
  assert.ok(boxes.length > 40);
  assert.equal(h.logs.checks.at(-1).tools.includes('go'), true);
  assert.equal(h.hub().env.rows.find((r) => r.key === 'go').level, 'error'); // 점검 결과에 없던 도구 → 다시 물었지만 없음
  assert.deepEqual(JSON.parse(h.store.get('mla-env-C:\\p1')), { add: ['go'], ignore: ['git'] });
  h.close();
  h.ctx.window.onDevProject();
  assert.equal(h.$('#devHub').hidden, true);
  assert.equal(h.$('#envModal').hidden, true);
});

test('화면: 크롬 확장(host.env 없음)은 실행하지 않고 필요한 도구 목록만 + 안내', async () => {
  const h = setup({ env: false });
  h.ctx.window.onDevProject();
  await tick(30);
  assert.equal(h.$('#devHub').dataset.level, 'unknown');
  assert.equal(h.$('#dhEnvPill').textContent, '필요한 도구 6');
  assert.match(h.$('#dhEnvNote').textContent, /크롬 확장은 프로그램을 실행할 수 없어/);
  assert.ok(h.hub().env.rows.every((r) => r.level === 'unknown'));
});

test('연결: 사이드바 자리 · 창 · 스크립트 순서 · 확장 빌드 · preload 통로 · 본체 등록 · 문구 짝', () => {
  const html = read('src/renderer/index.html');
  assert.ok(html.indexOf('id="rmCard"') < html.indexOf('id="devHub"') && html.indexOf('id="devHub"') < html.indexOf('id="psRules"'));
  assert.match(html, /id="envModal" class="modal" hidden/);
  const at = (s) => html.indexOf(s);
  assert.ok(at('i18n-ko-dev.js') < at('i18n.js"') && at('env-rules.js') < at('src="dev-hub.js"') && at('src="roadmap-card.js"') < at('src="dev-hub.js"') && at('src="dev-hub.js"') < at('src="a11y.js"'));
  assert.match(read('scripts/build-extension.js'), /'dev-hub\.js'/);
  assert.ok(fs.existsSync(path.join(__dirname, '../extension/lib/renderer/dev-hub.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '../extension/lib/shared/env-rules.js')));
  assert.match(read('extension/app.html'), /lib\/shared\/i18n-en-dev\.js/);
  const pre = read('src/preload/preload.js');
  assert.match(pre, /env: \{\s*\n\s*check: \(req\) => ipcRenderer\.invoke\('env:check', req\)/);
  assert.match(read('src/main/main.js'), /setupEnvCheck\(\{ ipcMain, getRoot: .*shell \}\)/);
  assert.match(read('src/renderer/project.js'), /window\.onDevProject\?\.\(\)/);
  assert.match(read('src/renderer/renderer-compose.js'), /window\.onDevState\?\.\(\)/);
  assert.doesNotMatch(read('extension/host.js'), /\benv:\s*\{/); // 확장에는 점검 통로가 없다 (목록만)
  i18n.setLang('en');
  assert.equal(i18n.t('dev.env.pill.ok'), '✓ Ready');
  i18n.setLang('ko');
});
