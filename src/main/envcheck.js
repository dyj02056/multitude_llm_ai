'use strict';

// 로컬 환경 점검 (v0.41.0, Windows 앱 전용) — 화면이 고른 도구가 이 PC에 있는지, 버전이 무엇인지 알아본다.
//   - 실행 파일은 PATH의 절대 경로 폴더에서만 찾는다. 프로젝트 폴더 안의 실행 파일은 찾지도 실행하지도 않는다.
//   - 실행하는 것은 도구마다 정해 둔 버전 묻기(--version 등)뿐이다. 셸 없이, 5초 제한, 출력은 64KB까지.
//   - .cmd · .bat(npm으로 깐 도구 등)은 셸 없이 띄울 수 없으므로 실행하지 않고, 옆의 package.json에서 버전을 읽는다 (없으면 "있음"만).
//   - PATH에는 없지만 흔한 설치 자리(MSYS2 · Program Files · JAVA_HOME 등)에 있으면 "있지만 PATH에 없음"으로 알린다.
//   - 포트는 이 PC(127.0.0.1)에 연결만 해 본다 (쓰는 중인지), Docker는 엔진 파이프가 열려 있는지만 본다.
//   - 설치는 하지 않는다. 설치 안내 주소는 env-rules.js 목록의 주소만 연다.
//
// [쉽게 말하면] "이 프로젝트를 돌리려면 node · python · JDK가 있어야 하는데, 이 PC에 있나?"를 알아보는 담당입니다.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const E = require('../shared/env-rules');
const R = require('./test-rules');

const VERSION_TIMEOUT_MS = 5000;
const MAX_OUT = 64 * 1024;
const CONCURRENCY = 4;
// npm으로 전역 설치한 도구의 .cmd 옆 node_modules 안 패키지 이름 (버전을 package.json에서 읽는다)
const SHIM_PKGS = { pnpm: 'pnpm', yarn: 'yarn', vercel: 'vercel', netlify: 'netlify-cli', firebase: 'firebase-tools' };

const isWin = (platform) => platform === 'win32';
const P = (platform) => (isWin(platform) ? path.win32 : path.posix);

/** 경로가 프로젝트 폴더 안인지 (대소문자 무시 — Windows) */
function insideRoot(dir, root, platform = process.platform) {
  if (!root) return false;
  const p = P(platform);
  const norm = (x) => (isWin(platform) ? p.normalize(x).toLowerCase() : p.normalize(x)).replace(/[\\/]+$/, '');
  const d = norm(dir);
  const r = norm(root);
  return d === r || d.startsWith(r + p.sep);
}

/** PATH의 폴더 중 쓸 수 있는 것: 절대 경로이고 프로젝트 안이 아닌 것 */
function pathDirs({ env = process.env, platform = process.platform, root = null } = {}) {
  const p = P(platform);
  return String(env.PATH || env.Path || '')
    .split(isWin(platform) ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && p.isAbsolute(d) && !insideRoot(d, root, platform));
}

/** PATH에 없을 때 더 찾아볼 흔한 설치 자리 (여기서 찾으면 "PATH에 없음") */
function hintDirs(id, { env = process.env, platform = process.platform, listDir = () => [] } = {}) {
  if (!isWin(platform)) {
    const home = env.HOME || '';
    return { cargo: [`${home}/.cargo/bin`], rustc: [`${home}/.cargo/bin`], go: ['/usr/local/go/bin'] }[id] || [];
  }
  const p = path.win32;
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const lad = env.LOCALAPPDATA || '';
  const kids = (base, re) => (base ? listDir(base).filter((n) => re.test(n)).map((n) => p.join(base, n)) : []);
  const msys = ['C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin', 'C:\\msys64\\clang64\\bin', 'C:\\msys64\\usr\\bin', 'C:\\MinGW\\bin', 'C:\\mingw64\\bin'];
  const javas = [env.JAVA_HOME && p.join(env.JAVA_HOME, 'bin'), ...pf.flatMap((b) => [...kids(p.join(b, 'Java'), /^(jdk|jre)/i), ...kids(p.join(b, 'Eclipse Adoptium'), /^jdk/i), ...kids(p.join(b, 'Microsoft'), /^jdk/i)].map((d) => p.join(d, 'bin')))].filter(Boolean);
  const android = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, lad && p.join(lad, 'Android', 'Sdk')].filter(Boolean).map((d) => p.join(d, 'platform-tools'));
  const map = {
    git: pf.map((b) => p.join(b, 'Git', 'cmd')),
    node: [env.NVM_SYMLINK, ...pf.map((b) => p.join(b, 'nodejs'))].filter(Boolean),
    python: [...kids(lad && p.join(lad, 'Programs', 'Python'), /^Python3/i), ...kids('C:\\', /^Python3\d+$/i)],
    jdk: javas,
    java: javas,
    gcc: msys,
    gpp: msys,
    make: msys,
    clang: [...pf.map((b) => p.join(b, 'LLVM', 'bin')), 'C:\\msys64\\clang64\\bin'],
    clangformat: pf.map((b) => p.join(b, 'LLVM', 'bin')),
    cmake: [...pf.map((b) => p.join(b, 'CMake', 'bin')), ...msys],
    ninja: msys,
    dotnet: pf.map((b) => p.join(b, 'dotnet')),
    cargo: [env.USERPROFILE && p.join(env.USERPROFILE, '.cargo', 'bin')].filter(Boolean),
    rustc: [env.USERPROFILE && p.join(env.USERPROFILE, '.cargo', 'bin')].filter(Boolean),
    go: pf.map((b) => p.join(b, 'Go', 'bin')),
    docker: pf.map((b) => p.join(b, 'Docker', 'Docker', 'resources', 'bin')),
    adb: android,
    gh: pf.map((b) => p.join(b, 'GitHub CLI')),
    terraform: [],
  };
  return map[id] || [];
}

/**
 * 도구 하나의 실행 파일 찾기 → { state: 'ok'|'notOnPath'|'missing', path?, kind?: 'exe'|'shim', launcher? }
 * exists(p): 파일이 있는지 · listDir(dir): 폴더 안 이름들 (테스트에서 바꿔 끼움)
 */
function findTool(id, { env = process.env, platform = process.platform, root = null, exists = (f) => fs.existsSync(f), listDir = safeList } = {}) {
  const tl = E.TOOLS[id];
  if (!tl || !tl.exe) return { state: 'missing' };
  const p = P(platform);
  const exts = isWin(platform) ? ['.exe', '.cmd', '.bat'] : [''];
  const skipStore = ['python'].includes(id);
  const look = (dirs) => {
    for (const dir of dirs) {
      if (skipStore && /[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue; // Microsoft Store의 가짜 python
      if (insideRoot(dir, root, platform)) continue;
      for (const name of tl.exe) {
        for (const ext of exts) {
          const f = p.join(dir, name + ext);
          if (exists(f)) return { path: f, kind: ext === '.cmd' || ext === '.bat' ? 'shim' : 'exe' };
        }
      }
    }
    return null;
  };
  const hit = look(pathDirs({ env, platform, root }));
  if (hit) return { state: 'ok', ...hit };
  // python: Store 별칭만 있으면 py 런처
  if (id === 'python' && isWin(platform)) {
    for (const dir of pathDirs({ env, platform, root })) {
      const f = p.join(dir, 'py.exe');
      if (exists(f)) return { state: 'ok', path: f, kind: 'exe', launcher: true };
    }
  }
  const hint = look(hintDirs(id, { env, platform, listDir }).filter((d) => p.isAbsolute(d)));
  if (hint) return { state: 'notOnPath', ...hint };
  return { state: 'missing' };
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 버전 묻기 실행 방법: 정해 둔 인자 · 셸 없이 · 창 없이 · 프로젝트가 아닌 곳(홈)에서 */
function buildVersionSpawn(id, found, { env = process.env } = {}) {
  const tl = E.TOOLS[id];
  if (!tl || !found || found.kind !== 'exe' || !found.path) return null;
  let args = tl.args || ['--version'];
  if (id === 'python' && found.launcher) args = ['-3', '--version'];
  if (id === 'pip') args = found.launcher ? ['-3', ...tl.args] : [...tl.args];
  const childEnv = { ...env, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete childEnv[k];
  return { command: found.path, args: [...args], options: { cwd: env.USERPROFILE || env.HOME || process.cwd(), env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } };
}

/** 허용 규칙: 절대 경로의 실행 파일 · 이름이 그 도구의 것 · 인자가 정해 둔 것 · 셸 없음 */
function isAllowedVersionSpawn(spec, id) {
  const tl = E.TOOLS[id];
  if (!tl || !spec || typeof spec.command !== 'string') return false;
  const win = /^[A-Za-z]:[\\/]|^\\\\/.test(spec.command);
  const p = win ? path.win32 : path.posix;
  if (!p.isAbsolute(spec.command) || /\.(cmd|bat)$/i.test(spec.command)) return false;
  const base = p.basename(spec.command).toLowerCase().replace(/\.exe$/, '');
  const same = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x, i) => a[i] === x);
  const o = spec.options || {};
  if (o.shell !== false) return false;
  if (id === 'pip') return (['python', 'python3'].includes(base) && same(spec.args, tl.args)) || (base === 'py' && same(spec.args, ['-3', ...tl.args]));
  if (id === 'python' && base === 'py') return same(spec.args, ['-3', '--version']);
  if (id === 'msvc') return base === 'vswhere' && same(spec.args, VSWHERE_ARGS);
  return (tl.exe || []).map((x) => x.toLowerCase()).includes(base) && same(spec.args, tl.args);
}

const VSWHERE_ARGS = ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationVersion'];

/** 실행해서 출력 받기 (5초 제한) → { code, out } */
function runCapture(spec, { spawnFn = spawn, timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(spec.command, spec.args, spec.options);
    } catch (err) {
      return resolve({ code: null, out: '', error: err.message });
    }
    let out = '';
    const take = (b) => {
      if (out.length < MAX_OUT) out += b.toString('utf8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ code: null, out, timedOut: true });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, out, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** 포트를 누가 쓰는 중인지 (127.0.0.1에 연결이 되면 쓰는 중) */
function portBusy(port, { connect = net.connect, timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v) => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Docker 엔진이 켜져 있는지 (파이프 · 소켓에 연결이 되는지만) */
function dockerOn({ platform = process.platform, connect = net.connect, timeoutMs = 600 } = {}) {
  return new Promise((resolve) => {
    const s = connect(isWin(platform) ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock');
    const done = (v) => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * 점검 한 번. req: { tools: [id], ports: [n] } (env-rules.cleanCheckRequest로 정리한 것)
 * deps: 테스트에서 바꿔 끼우는 것 (env · platform · root · exists · listDir · readText · spawnFn · connect)
 * → { ok, tools: { id: { state, version, path, note } }, ports: { n: busy }, docker: 'on'|'off'|null, javaHome }
 */
async function checkEnv(req, deps = {}) {
  const { env = process.env, platform = process.platform, root = null, exists = (f) => fs.existsSync(f), listDir = safeList, readText = (f) => fs.readFileSync(f, 'utf8'), spawnFn = spawn, connect = net.connect } = deps;
  const clean = E.cleanCheckRequest(req);
  if (!clean) return { ok: false, error: 'bad request' };
  const p = P(platform);
  const found = { env, platform, root, exists, listDir };
  const tools = {};
  const verOf = (text) => E.parseVersion(text);
  const pkgVersion = (file) => {
    try {
      return E.parseJson(readText(file))?.version || null;
    } catch {
      return null;
    }
  };

  const jobs = clean.tools.map((id) => async () => {
    const tl = E.TOOLS[id];
    if (tl.via === 'npm' || tl.via === 'npx') {
      const cli = R.findNpmCli({ env, platform, exists });
      if (!cli || insideRoot(cli, root, platform)) return (tools[id] = { state: 'missing' });
      const bin = p.dirname(cli);
      if (tl.via === 'npx' && !exists(p.join(bin, 'npx-cli.js'))) return (tools[id] = { state: 'missing' });
      return (tools[id] = { state: 'ok', version: pkgVersion(p.join(bin, '..', 'package.json')) || '', path: p.join(bin, tl.via === 'npx' ? 'npx-cli.js' : 'npm-cli.js') });
    }
    if (tl.via === 'dir') {
      const dir = isWin(platform) ? env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'ms-playwright') : env.HOME && p.join(env.HOME, '.cache', 'ms-playwright');
      const kids = dir ? listDir(dir).filter((n) => /^(chromium|firefox|webkit)/i.test(n)) : [];
      return (tools[id] = kids.length ? { state: 'ok', version: '', path: dir, note: kids.join(', ') } : { state: 'missing' });
    }
    if (tl.via === 'vswhere') {
      if (!isWin(platform)) return (tools[id] = { state: 'missing' });
      const base = env['ProgramFiles(x86)'] || env.ProgramFiles;
      const vsw = base && p.join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
      if (!vsw || !exists(vsw)) return (tools[id] = { state: 'missing' });
      const spec = { command: vsw, args: [...VSWHERE_ARGS], options: { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } };
      if (!isAllowedVersionSpawn(spec, 'msvc')) return (tools[id] = { state: 'missing' });
      const r = await runCapture(spec, { spawnFn });
      const v = verOf(r.out);
      // C++ 빌드 도구가 있는 설치가 있어도 cl.exe는 PATH에 없다 (개발자 명령 프롬프트에서만) — "PATH에 없음"으로 알린다
      return (tools[id] = v ? { state: 'notOnPath', version: v, path: vsw, note: 'devPrompt' } : { state: 'missing' });
    }
    let f;
    if (tl.via === 'python') {
      f = findTool('python', found);
      if (f.state === 'missing') return (tools[id] = { state: 'missing' });
    } else f = findTool(id, found);
    if (f.state === 'missing') return (tools[id] = { state: 'missing' });
    if (f.kind === 'shim') {
      const pkg = SHIM_PKGS[id];
      const v = pkg ? pkgVersion(p.join(p.dirname(f.path), 'node_modules', ...pkg.split('/'), 'package.json')) : null;
      return (tools[id] = { state: f.state, version: v || '', path: f.path, note: v ? '' : 'shim' });
    }
    const spec = buildVersionSpawn(id, f, { env });
    if (!spec || !isAllowedVersionSpawn(spec, id)) return (tools[id] = { state: f.state, version: '', path: f.path });
    const r = await runCapture(spec, { spawnFn });
    // pip: "No module named pip"이면 없음
    if (id === 'pip' && (r.code !== 0 || /No module named/i.test(r.out))) return (tools[id] = { state: 'missing' });
    return (tools[id] = { state: f.state, version: verOf(r.out) || '', path: f.path, ...(r.timedOut ? { note: 'timeout' } : {}) });
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));

  const ports = {};
  for (const port of clean.ports) ports[port] = await portBusy(port, { connect });
  const docker = clean.docker && tools.docker && tools.docker.state !== 'missing' ? ((await dockerOn({ platform, connect })) ? 'on' : 'off') : null;
  let javaHome = null;
  if (clean.javaHome) {
    const jh = env.JAVA_HOME;
    javaHome = jh ? { set: true, ok: exists(p.join(jh, 'bin', isWin(platform) ? 'javac.exe' : 'javac')), path: jh } : { set: false };
  }
  return { ok: true, at: Date.now(), tools, ports, docker, javaHome };
}

/**
 * ipcMain: env:check(req) → checkEnv 결과 · env:openInstall(id) → 목록에 있는 공식 설치 안내 주소를 기본 브라우저로
 */
function setupEnvCheck({ ipcMain, getRoot, shell }) {
  let busy = null; // 같은 점검이 겹치면 앞의 것을 기다린다
  ipcMain.handle('env:check', async (_e, req) => {
    if (busy) return busy;
    busy = checkEnv(req, { root: getRoot() }).finally(() => (busy = null));
    return busy;
  });
  ipcMain.handle('env:openInstall', async (_e, id) => {
    const url = typeof id === 'string' && E.TOOLS[id] ? E.TOOLS[id].url : null;
    if (!url || !/^https:\/\//.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
}

module.exports = { setupEnvCheck, checkEnv, findTool, pathDirs, hintDirs, insideRoot, buildVersionSpawn, isAllowedVersionSpawn, portBusy, dockerOn, VSWHERE_ARGS };
