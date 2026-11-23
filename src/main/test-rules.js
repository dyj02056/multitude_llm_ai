'use strict';

// 미리보기 창의 "테스트 실행" 규칙 (Windows 앱). 실제 실행은 devtest.js가 하고, 여기는 검사·계산만 한다 (단위 테스트용).
//
// [쉽게 말하면]
// AI 수정안을 적용하기 전에 프로젝트의 테스트를 돌려 보는 기능의 "규칙집"입니다.
//   - 실행하는 것은 package.json의 정해진 스크립트뿐입니다: test(npm test)와, v0.28.0부터 있으면 lint · typecheck · build
//     (npm run lint 등). 이 네 이름 말고는 받지 않고, 스크립트 글 자체는 화면에서 받지 않습니다 (package.json에 적힌 것).
//     기본은 test 하나만 체크됩니다.
//   - 셸(cmd.exe)을 거치지 않고 실행합니다. Windows에서 npm.cmd를 셸 없이 띄우면 EINVAL로 실패하므로,
//     앱 자신(process.execPath, Electron이면 ELECTRON_RUN_AS_NODE=1로 Node처럼 동작)으로 npm-cli.js를 직접 실행합니다.
//   - 출력은 2MB까지, 토큰·키처럼 보이는 글자는 가립니다 (git 콘솔과 같은 규칙).

const path = require('path');
const { t } = require('../shared/i18n');

const TEST_TIMEOUT_MS = 3 * 60 * 1000; // 스크립트 한 번의 시간 제한 (스크립트마다 따로)
// 미리보기 창에서 고를 수 있는 검사 스크립트 (v0.28.0). 이 순서로 실행한다. 이름이 이 목록에 없으면 실행하지 않는다.
const CHECK_SCRIPTS = ['test', 'lint', 'typecheck', 'build'];
// 다른 언어의 검사 (v0.34.0): 정해 둔 명령 세 개뿐. 그 프로젝트 맨 위 폴더에 표시 파일이 있을 때만 보이고, 글로 적은 명령은 받지 않는다.
//   pytest     pyproject.toml → python -m pytest -q   (Windows는 py 런처가 있으면 py -3 -m pytest -q)
//   cargo-test Cargo.toml     → cargo test
//   go-test    go.mod         → go test ./...
// npm 스크립트와 같게 셸 없이 실행 파일을 직접 띄우고(PATH의 절대 경로 폴더에서 찾음 — 프로젝트 안의 가짜 실행 파일은 쓰지 않음),
// 스크립트마다 시간 제한 · 출력 가림 · 적용 전 · 후 비교도 같다.
const RUNNER_CHECKS = ['pytest', 'cargo-test', 'go-test'];
const RUNNERS = {
  pytest: { marker: 'pyproject.toml', label: 'python -m pytest -q' },
  'cargo-test': { marker: 'Cargo.toml', label: 'cargo test' },
  'go-test': { marker: 'go.mod', label: 'go test ./...' },
};
// 다른 언어 검사를 골랐을 때, 수정안이 그 검사의 실행 방식을 바꾸는 파일이면 확인 창에서 따로 알린다
const RUNNER_SENSITIVE = /(^|\/)(conftest\.py|pyproject\.toml|setup\.py|setup\.cfg|pytest\.ini|tox\.ini|Cargo\.toml|build\.rs|go\.mod|go\.sum|\.cargo\/config(\.toml)?)$/i;
const ALL_CHECKS = [...CHECK_SCRIPTS, ...RUNNER_CHECKS]; // 미리보기 창에서 고를 수 있는 검사 전체 (이 순서로 실행)
const MAX_OUTPUT = 2 * 1024 * 1024;
const NPM_DEFAULT_TEST = /no test specified/i; // npm init이 넣는 기본 test 스크립트

/**
 * package.json 글에서 test 스크립트를 읽는다.
 * → { ok: true, script, pre?, post? } | { ok: false, error }
 * pre/post: npm test가 함께 실행하는 pretest/posttest (확인 창에 같이 보여 준다)
 */
function readTestScript(pkgText) {
  return readScript(pkgText, 'test');
}

/** package.json 글 → { ok: true, scripts } | { ok: false, error } */
function readPkgScripts(pkgText) {
  if (typeof pkgText !== 'string') return { ok: false, error: t('main.test.noPkg') };
  let pkg;
  try {
    pkg = JSON.parse(pkgText.replace(/^﻿/, ''));
  } catch {
    return { ok: false, error: t('main.test.badPkg') };
  }
  return { ok: true, scripts: pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {} };
}

/**
 * 검사 스크립트 하나 읽기 (v0.28.0: test 말고도 lint · typecheck · build). name은 CHECK_SCRIPTS 안의 이름만.
 * → { ok: true, script, pre?, post? } | { ok: false, error } — pre/post: npm이 함께 실행하는 pre<이름> · post<이름>
 */
function readScript(pkgText, name) {
  if (!CHECK_SCRIPTS.includes(name)) return { ok: false, error: t('devtest.notAllowed', { name: String(name) }) };
  const pkg = readPkgScripts(pkgText);
  if (!pkg.ok) return pkg;
  const { scripts } = pkg;
  const script = typeof scripts[name] === 'string' ? scripts[name].trim() : '';
  if (!script) return { ok: false, error: t('devtest.noScript', { name }) };
  if (name === 'test' && NPM_DEFAULT_TEST.test(script)) return { ok: false, error: t('main.test.defaultScript') };
  const out = { ok: true, script };
  const pre = scripts[`pre${name}`];
  const post = scripts[`post${name}`];
  if (typeof pre === 'string' && pre.trim()) out.pre = pre.trim();
  if (typeof post === 'string' && post.trim()) out.post = post.trim();
  return out;
}

/**
 * package.json에 있는 검사 스크립트 목록 (CHECK_SCRIPTS 순서) → { ok: true, checks: [{ name, script, pre?, post? }] } | { ok: false, error }
 * 하나도 없으면 오류. test가 npm 기본값이면 목록에서 뺀다.
 */
function availableChecks(pkgText) {
  const pkg = readPkgScripts(pkgText);
  if (!pkg.ok) return pkg;
  const checks = [];
  for (const name of CHECK_SCRIPTS) {
    const { ok, ...r } = readScript(pkgText, name);
    if (ok) checks.push({ name, ...r });
  }
  if (!checks.length) return { ok: false, error: t('devtest.noChecks') };
  return { ok: true, checks };
}

/**
 * 화면이 고른 스크립트 이름 검사: 허용 목록(CHECK_SCRIPTS) 안 · package.json에 있는 것(available)만, 겹치지 않게, 1개 이상.
 * → CHECK_SCRIPTS 순서로 정리한 이름 목록 | null
 */
function checkScriptNames(raw, available) {
  if (!Array.isArray(raw) || !raw.length || raw.length > ALL_CHECKS.length) return null;
  const have = new Set(available);
  const seen = new Set();
  for (const n of raw) {
    if (typeof n !== 'string' || !ALL_CHECKS.includes(n) || !have.has(n) || seen.has(n)) return null;
    seen.add(n);
  }
  return ALL_CHECKS.filter((n) => seen.has(n));
}

/**
 * 표시 파일(pyproject.toml · Cargo.toml · go.mod)이 있는 다른 언어 검사 → [{ name, marker, label }] (RUNNER_CHECKS 순서)
 * has(marker): 그 파일이 프로젝트 맨 위에 있는지
 */
function runnerChecks(has) {
  return RUNNER_CHECKS.filter((n) => has(RUNNERS[n].marker)).map((n) => ({ name: n, marker: RUNNERS[n].marker, label: RUNNERS[n].label }));
}

const isRunner = (name) => RUNNER_CHECKS.includes(name);

/**
 * 다른 언어 검사의 실행 파일을 PATH에서 찾는다 (절대 경로 폴더만 — 프로젝트 안의 상대 경로는 보지 않음).
 * → { command, args } | null. args는 이름마다 정해진 것 (py 런처는 앞에 -3).
 * Windows: pytest는 python.exe(Microsoft Store 별칭 폴더 WindowsApps의 것은 제외) → 없으면 py.exe, cargo는 cargo.exe(+ ~/.cargo/bin), go는 go.exe(+ Program Files\Go\bin)
 */
function findRunnerExe(name, { env = process.env, platform = process.platform, exists }) {
  if (!isRunner(name)) return null;
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const ext = win ? '.exe' : '';
  const dirs = String(env.PATH || env.Path || '')
    .split(win ? ';' : ':')
    .filter((d) => d && P.isAbsolute(d));
  const extra = [];
  if (win) {
    if (name === 'cargo-test' && env.USERPROFILE) extra.push(P.join(env.USERPROFILE, '.cargo', 'bin'));
    if (name === 'go-test') extra.push(...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((b) => P.join(b, 'Go', 'bin')));
  } else {
    if (name === 'cargo-test' && env.HOME) extra.push(P.join(env.HOME, '.cargo', 'bin'));
    if (name === 'go-test') extra.push('/usr/local/go/bin');
  }
  const find = (names, { skipStore = false } = {}) => {
    for (const dir of [...dirs, ...extra]) {
      if (skipStore && /[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue;
      for (const n of names) {
        const p = P.join(dir, n + ext);
        if (exists(p)) return p;
      }
    }
    return null;
  };
  if (name === 'pytest') {
    const py = find(win ? ['python'] : ['python3', 'python'], { skipStore: true });
    if (py) return { command: py, args: ['-m', 'pytest', '-q'] };
    const launcher = win ? find(['py']) : null;
    return launcher ? { command: launcher, args: ['-3', '-m', 'pytest', '-q'] } : null;
  }
  const exe = find([name === 'cargo-test' ? 'cargo' : 'go']);
  return exe ? { command: exe, args: name === 'cargo-test' ? ['test'] : ['test', './...'] } : null;
}

/** 다른 언어 검사 실행 방법: 셸 없이, 프로젝트 폴더에서, 색 · 대화형 끄기 */
function buildRunnerSpawn({ name, root, exe, env = process.env }) {
  if (!isRunner(name) || !exe) throw new Error(t('devtest.notAllowed', { name: String(name) }));
  const childEnv = { ...env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', CARGO_TERM_COLOR: 'never', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'npm_lifecycle_event', 'npm_lifecycle_script']) delete childEnv[k];
  return { command: exe.command, args: [...exe.args], options: { cwd: root, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } };
}

/** 허용 규칙: 정해진 실행 파일 이름 · 정해진 인자 · 셸 없음 · 프로젝트 폴더에서일 때만 (devtest.js가 spawn 직전에 다시 검사) */
function isAllowedRunnerSpawn(spec, { root, name }) {
  if (!isRunner(name) || !spec || typeof spec.command !== 'string') return false;
  const win = /^[A-Za-z]:[\\/]|^\\\\/.test(spec.command);
  const P = win ? path.win32 : path.posix;
  if (!P.isAbsolute(spec.command)) return false;
  const base = P.basename(spec.command).toLowerCase().replace(/\.exe$/, '');
  const same = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x, i) => a[i] === x);
  const ok =
    name === 'pytest'
      ? (['python', 'python3'].includes(base) && same(spec.args, ['-m', 'pytest', '-q'])) || (base === 'py' && same(spec.args, ['-3', '-m', 'pytest', '-q']))
      : name === 'cargo-test'
        ? base === 'cargo' && same(spec.args, ['test'])
        : base === 'go' && same(spec.args, ['test', './...']);
  const o = spec.options || {};
  return ok && o.shell === false && o.cwd === root;
}

/** npm에 넘길 인자: test는 npm test, 나머지는 npm run <이름> */
const scriptArgs = (name) => (name === 'test' ? ['test'] : ['run', name]);

const NPM_CLI_REL = ['node_modules', 'npm', 'bin', 'npm-cli.js'];

/**
 * npm-cli.js 위치를 찾는다. 상대 경로 PATH는 보지 않는다 (프로젝트 안의 가짜 npm을 쓰지 않게).
 * 순서: npm_execpath(npm이 띄운 경우) → PATH의 npm(.cmd)이 있는 폴더 → %APPDATA%\npm · Program Files\nodejs
 * exists(p): 파일이 있는지 (테스트에서 바꿔 끼움)
 */
function findNpmCli({ env = process.env, platform = process.platform, exists }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const ok = (p) => !!p && P.isAbsolute(p) && /npm-cli\.js$/i.test(p) && exists(p);
  if (ok(env.npm_execpath)) return env.npm_execpath;
  const pathVar = env.PATH || env.Path || '';
  const npmNames = platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const dir of String(pathVar).split(platform === 'win32' ? ';' : ':')) {
    if (!dir || !P.isAbsolute(dir)) continue;
    if (!npmNames.some((n) => exists(P.join(dir, n)))) continue;
    for (const c of [P.join(dir, ...NPM_CLI_REL), P.join(dir, '..', 'lib', ...NPM_CLI_REL)]) if (ok(P.normalize(c))) return P.normalize(c);
  }
  if (platform === 'win32') {
    for (const base of [env.APPDATA && P.join(env.APPDATA, 'npm'), env.ProgramFiles && P.join(env.ProgramFiles, 'nodejs')]) {
      if (base && ok(P.join(base, ...NPM_CLI_REL))) return P.join(base, ...NPM_CLI_REL);
    }
  }
  return null;
}

/**
 * npm-cli.js와 같은 Node 설치에 들어 있는 node(.exe). 없으면 null.
 * npm-cli.js는 보통 <Node 폴더>/node_modules/npm/bin/npm-cli.js (Windows) 또는 <prefix>/lib/node_modules/npm/bin/npm-cli.js
 */
function findNodeFor(npmCli, { platform = process.platform, exists }) {
  if (!npmCli) return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const npmDir = P.dirname(P.dirname(npmCli)); // …/node_modules/npm
  const names = platform === 'win32' ? ['node.exe'] : ['node'];
  for (const base of [P.join(npmDir, '..', '..'), P.join(npmDir, '..', '..', '..', 'bin')]) {
    for (const n of names) {
      const p = P.normalize(P.join(base, n));
      if (P.isAbsolute(p) && exists(p)) return p;
    }
  }
  return null;
}

/**
 * 실행 방법: 셸 없이 npm-cli.js test.
 *   - nodeExe(npm과 같은 Node 설치의 node.exe)가 있으면 그것으로 실행한다 — 테스트 쪽에 Electron 설정이 물려가지 않는다
 *   - 없으면 execPath(앱 자신)로 실행하고, isElectron이면 ELECTRON_RUN_AS_NODE=1을 붙여 Electron이 Node처럼 동작하게 한다.
 *     이 값은 테스트가 띄우는 프로그램에도 물려가므로(테스트 안에서 Electron을 띄우는 프로젝트는 오동작) 마지막 수단이다.
 */
function buildTestSpawn({ root, npmCli, execPath, isElectron, nodeExe = null, env = process.env, script = 'test' }) {
  if (!CHECK_SCRIPTS.includes(script)) throw new Error(t('devtest.notAllowed', { name: String(script) }));
  const childEnv = { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false' };
  const viaNode = !!nodeExe;
  if (isElectron && !viaNode) childEnv.ELECTRON_RUN_AS_NODE = '1';
  else delete childEnv.ELECTRON_RUN_AS_NODE;
  // 바깥에서 물려받으면 프로젝트의 테스트가 다르게 동작하는 값은 뺀다 (node --test 안에서 띄운 경우 등)
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'npm_lifecycle_event', 'npm_lifecycle_script']) delete childEnv[k];
  return {
    command: viaNode ? nodeExe : execPath,
    args: [npmCli, ...scriptArgs(script)],
    options: { cwd: root, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

/** 허용 규칙: 이 모양이 아니면 실행하지 않는다 (devtest.js가 spawn 직전에 다시 검사). script: 실행하려는 검사 이름 (기본 test) */
function isAllowedTestSpawn(spec, { root, execPath, nodeExe = null, script = 'test' }) {
  if (!spec || !(spec.command === execPath || (nodeExe && spec.command === nodeExe))) return false;
  if (!CHECK_SCRIPTS.includes(script)) return false;
  const want = scriptArgs(script);
  if (!Array.isArray(spec.args) || spec.args.length !== want.length + 1 || want.some((a, i) => spec.args[i + 1] !== a)) return false;
  if (!/(^|[\\/])npm-cli\.js$/i.test(spec.args[0]) || !path.isAbsolute(spec.args[0])) return false;
  const o = spec.options || {};
  if (o.shell !== false || o.cwd !== root) return false;
  return true;
}

/** 테스트 출력에서 통과·실패 수를 찾는다 (node --test · jest · vitest · mocha). 못 찾으면 null */
function summarizeTestOutput(text) {
  const s = String(text || '');
  const num = (re) => {
    const all = [...s.matchAll(re)];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  // node --test (TAP · spec 요약)
  let pass = num(/^#\s*pass\s+(\d+)/gm) ?? num(/^ℹ\s*pass\s+(\d+)/gm);
  let fail = num(/^#\s*fail\s+(\d+)/gm) ?? num(/^ℹ\s*fail\s+(\d+)/gm);
  if (pass !== null || fail !== null) return { pass: pass ?? 0, fail: fail ?? 0 };
  // jest: "Tests:       1 failed, 3 passed, 4 total" / vitest: "Tests  1 failed | 3 passed (4)"
  const line = [...s.matchAll(/^\s*Tests:?\s+(.*)$/gm)].pop()?.[1];
  if (line && /passed|failed/.test(line)) {
    pass = Number(/(\d+)\s+passed/.exec(line)?.[1] || 0);
    fail = Number(/(\d+)\s+failed/.exec(line)?.[1] || 0);
    return { pass, fail };
  }
  // mocha: "3 passing" / "1 failing"
  pass = num(/^\s*(\d+)\s+passing/gm);
  fail = num(/^\s*(\d+)\s+failing/gm);
  if (pass !== null || fail !== null) return { pass: pass ?? 0, fail: fail ?? 0 };
  // pytest (v0.34.0): "=== 1 failed, 3 passed in 0.12s ===" · "3 passed in 0.10s" · "no tests ran"
  const pyLine = [...s.matchAll(/^.*\b(?:passed|failed|error|errors)\b.*\bin\s+[\d.]+s.*$/gm)].pop()?.[0];
  if (pyLine) {
    const n = (re) => Number(re.exec(pyLine)?.[1] || 0);
    return { pass: n(/(\d+)\s+passed/), fail: n(/(\d+)\s+failed/) + n(/(\d+)\s+errors?\b/) };
  }
  // cargo test: 시험 묶음마다 "test result: ok. 5 passed; 0 failed; …" — 모두 더한다
  const cargo = [...s.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm)];
  if (cargo.length) return { pass: cargo.reduce((n, m) => n + Number(m[1]), 0), fail: cargo.reduce((n, m) => n + Number(m[2]), 0) };
  // go test: 패키지마다 "ok  \tname\t0.1s" 또는 "FAIL\tname\t0.1s" (패키지 수로 센다)
  const goOk = [...s.matchAll(/^ok\s+\S+/gm)].length;
  const goFail = [...s.matchAll(/^FAIL\s+\S+/gm)].length;
  if (goOk || goFail) return { pass: goOk, fail: goFail };
  return null;
}

/**
 * 확인 창에 보여 줄 경고: 체크한 수정안이 테스트 실행 방식을 바꾸는지.
 *   - 맨 위 package.json이 바뀌면, "적용 후" 실행에서는 바뀐 test · pretest · posttest가 돈다 → 바뀐 스크립트를 보여 준다
 *   - 그 밖의 실행 영향 파일(risk(path, before, after)가 이유를 돌려주는 파일)은 이름과 이유를 보여 준다
 * changes: [{ path, before(문자열 | null=없던 파일), after(문자열 | null=삭제) }]
 * → { scriptLines: ['test: 이전 → 이후', …], riskLines: ['경로 — 이유', …] }
 */
function trialWarnings(changes, risk = () => null, names = ['test']) {
  const scriptLines = [];
  const riskLines = [];
  for (const c of changes) {
    if (c.path === 'package.json') {
      // 고른 검사 스크립트마다 (v0.28.0): 바뀌면 "적용 후"에는 바뀐 스크립트가 돈다
      for (const script of names) {
        const before = readScript(typeof c.before === 'string' ? c.before : undefined, script);
        const after = readScript(typeof c.after === 'string' ? c.after : undefined, script);
        if (!after.ok) {
          scriptLines.push(t('devtest.cannotRunAfter', { name: script, error: after.error }));
          continue;
        }
        for (const k of ['pre', 'script', 'post']) {
          const name = { pre: `pre${script}`, script, post: `post${script}` }[k];
          const a = before.ok ? before[k] || '' : '';
          const b = after[k] || '';
          if (a !== b) scriptLines.push(`${name}: ${a || t('main.test.none')} → ${b || t('main.test.none')}`);
        }
      }
      continue;
    }
    const why = risk(c.path, c.before, c.after);
    if (why) riskLines.push(`${c.path} — ${why}`);
  }
  return { scriptLines, riskLines };
}

// 임시 적용 한도: 파일 수 · 파일 하나 · 전체 크기
const TRIAL_MAX_FILES = 200;
const TRIAL_MAX_FILE_BYTES = 5 * 1024 * 1024;
const TRIAL_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** 화면에서 받은 임시 적용 목록 검사: [{ path, after(문자열 | null=삭제) }] 최대 200개, 전체 50MB */
function checkTrialChanges(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > TRIAL_MAX_FILES) return null;
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || !c.path || c.path.length > 1000 || seen.has(c.path)) return null;
    if (!(typeof c.after === 'string' || c.after === null)) return null;
    if (typeof c.after === 'string' && c.after.length > TRIAL_MAX_FILE_BYTES) return null;
    total += typeof c.after === 'string' ? c.after.length : 0;
    if (total > TRIAL_MAX_TOTAL_BYTES) return null; // 하나하나는 작아도 합치면 너무 큰 경우
    seen.add(c.path);
    out.push({ path: c.path, after: c.after });
  }
  return out;
}

module.exports = {
  TEST_TIMEOUT_MS,
  MAX_OUTPUT,
  CHECK_SCRIPTS,
  readPkgScripts, // 앱 실행(devrun.js, v0.43.0)도 쓴다
  RUNNER_CHECKS,
  RUNNERS,
  RUNNER_SENSITIVE,
  ALL_CHECKS,
  runnerChecks,
  isRunner,
  findRunnerExe,
  buildRunnerSpawn,
  isAllowedRunnerSpawn,
  readTestScript,
  readScript,
  availableChecks,
  checkScriptNames,
  scriptArgs,
  findNpmCli,
  findNodeFor,
  buildTestSpawn,
  isAllowedTestSpawn,
  summarizeTestOutput,
  TRIAL_MAX_FILES,
  TRIAL_MAX_FILE_BYTES,
  TRIAL_MAX_TOTAL_BYTES,
  checkTrialChanges,
  trialWarnings,
};
