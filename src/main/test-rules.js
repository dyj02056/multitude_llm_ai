'use strict';

// 미리보기 창의 "테스트 실행" 규칙 (Windows 앱). 실제 실행은 devtest.js가 하고, 여기는 검사·계산만 한다 (단위 테스트용).
//
// [쉽게 말하면]
// AI 수정안을 적용하기 전에 프로젝트의 테스트를 돌려 보는 기능의 "규칙집"입니다.
//   - 실행하는 것은 package.json의 "test" 스크립트 하나뿐입니다 (npm test). 다른 명령은 받지 않습니다.
//   - 셸(cmd.exe)을 거치지 않고 실행합니다. Windows에서 npm.cmd를 셸 없이 띄우면 EINVAL로 실패하므로,
//     앱 자신(process.execPath, Electron이면 ELECTRON_RUN_AS_NODE=1로 Node처럼 동작)으로 npm-cli.js를 직접 실행합니다.
//   - 출력은 2MB까지, 토큰·키처럼 보이는 글자는 가립니다 (git 콘솔과 같은 규칙).

const path = require('path');

const TEST_TIMEOUT_MS = 3 * 60 * 1000; // 테스트 한 번의 시간 제한
const MAX_OUTPUT = 2 * 1024 * 1024;
const NPM_DEFAULT_TEST = /no test specified/i; // npm init이 넣는 기본 test 스크립트

/**
 * package.json 글에서 test 스크립트를 읽는다.
 * → { ok: true, script, pre?, post? } | { ok: false, error }
 * pre/post: npm test가 함께 실행하는 pretest/posttest (확인 창에 같이 보여 준다)
 */
function readTestScript(pkgText) {
  if (typeof pkgText !== 'string') return { ok: false, error: 'package.json이 없습니다 (npm 프로젝트만 테스트할 수 있습니다)' };
  let pkg;
  try {
    pkg = JSON.parse(pkgText.replace(/^﻿/, ''));
  } catch {
    return { ok: false, error: 'package.json을 읽지 못했습니다 (JSON 형식 오류)' };
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const script = typeof scripts.test === 'string' ? scripts.test.trim() : '';
  if (!script) return { ok: false, error: 'package.json에 "test" 스크립트가 없습니다' };
  if (NPM_DEFAULT_TEST.test(script)) return { ok: false, error: '"test" 스크립트가 npm 기본값(no test specified)입니다' };
  const out = { ok: true, script };
  if (typeof scripts.pretest === 'string' && scripts.pretest.trim()) out.pre = scripts.pretest.trim();
  if (typeof scripts.posttest === 'string' && scripts.posttest.trim()) out.post = scripts.posttest.trim();
  return out;
}

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
 * 실행 방법: 셸 없이 execPath(앱 자신)로 npm-cli.js test.
 * isElectron이면 ELECTRON_RUN_AS_NODE=1을 붙여 Electron이 Node처럼 동작하게 한다.
 */
function buildTestSpawn({ root, npmCli, execPath, isElectron, env = process.env }) {
  const childEnv = { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false' };
  if (isElectron) childEnv.ELECTRON_RUN_AS_NODE = '1';
  else delete childEnv.ELECTRON_RUN_AS_NODE;
  // 바깥에서 물려받으면 프로젝트의 테스트가 다르게 동작하는 값은 뺀다 (node --test 안에서 띄운 경우 등)
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'npm_lifecycle_event', 'npm_lifecycle_script']) delete childEnv[k];
  return {
    command: execPath,
    args: [npmCli, 'test'],
    options: { cwd: root, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

/** 허용 규칙: 이 모양이 아니면 실행하지 않는다 (devtest.js가 spawn 직전에 다시 검사) */
function isAllowedTestSpawn(spec, { root, execPath }) {
  if (!spec || spec.command !== execPath) return false;
  if (!Array.isArray(spec.args) || spec.args.length !== 2 || spec.args[1] !== 'test') return false;
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
  return null;
}

/** 화면에서 받은 임시 적용 목록 검사: [{ path, after(문자열 | null=삭제) }] 최대 200개 */
function checkTrialChanges(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 200) return null;
  const out = [];
  const seen = new Set();
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || !c.path || c.path.length > 1000 || seen.has(c.path)) return null;
    if (!(typeof c.after === 'string' || c.after === null)) return null;
    if (typeof c.after === 'string' && c.after.length > 5 * 1024 * 1024) return null;
    seen.add(c.path);
    out.push({ path: c.path, after: c.after });
  }
  return out;
}

module.exports = {
  TEST_TIMEOUT_MS,
  MAX_OUTPUT,
  readTestScript,
  findNpmCli,
  buildTestSpawn,
  isAllowedTestSpawn,
  summarizeTestOutput,
  checkTrialChanges,
};
