'use strict';

// 앱 실행 (v0.43.0, Windows 앱 전용) — 프로젝트의 개발 서버(npm run dev 등)를 띄우고, 출력에서 이 PC 주소(localhost)를 찾고, 중지한다.
//   - 실행하는 것은 package.json의 정해 둔 스크립트 이름뿐: dev · start · serve · preview (화면은 이름만 넘긴다).
//     스크립트 글은 본체가 package.json에서 읽고, 실행 전 확인 창에 그대로 보여 준다.
//   - 테스트 실행과 같은 방식: 셸 없이 npm-cli.js run <이름>, Node는 npm과 같은 설치의 node.exe (PATH의 절대 경로에서 찾음).
//   - 시간 제한은 없다 (서버는 계속 돈다). [중지] · 프로젝트를 닫거나 바꿀 때 · 앱을 끌 때 프로세스 트리를 끝낸다.
//   - 출력은 마지막 256KB만 기억하고, 화면에 줄 때 토큰 · 키처럼 보이는 글자는 가린다.
//   - 주소는 http(s)://localhost · 127.0.0.1 · [::1] · 0.0.0.0(→ localhost)만 찾는다.
//
// [쉽게 말하면] "npm run dev"를 앱이 대신 눌러 주고, 서버가 알려 준 주소를 찾아 화면에 보여 주는 담당입니다.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { dialog } = require('electron');
const R = require('./test-rules');
const { killTree } = require('./gitconsole');
const { maskOutput } = require('./git-rules');
const { PATTERNS } = require('../shared/secret-scan');
const { t } = require('../shared/i18n');

const RUN_SCRIPTS = ['dev', 'start', 'serve', 'preview'];
const MAX_LOG = 256 * 1024;
// 한 번 실행 (v0.46.0): CLI 프로그램 · 스크립트를 인자와 함께 한 번 돌려 출력을 본다. 1분 제한
const ONCE_TIMEOUT_MS = 60 * 1000;
const PY_ENTRIES = ['main.py', 'app.py', 'cli.py', '__main__.py', 'manage.py'];
const NODE_ENTRIES = ['cli.js', 'index.js', 'main.js', 'cli.mjs', 'index.mjs'];
const MAX_ARGS = 20;

/**
 * 인자 글 → 배열 (따옴표로 묶은 칸 띄우기 허용). 셸을 거치지 않으므로 ; | & > 같은 글자는 그냥 글자다.
 * → 배열 | null (너무 많거나 길거나 닫히지 않은 따옴표 · NUL)
 */
function parseArgs(text) {
  const s = String(text ?? '');
  if (s.length > 2000 || s.includes('\0')) return null;
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (quote) return null;
  if (cur || has) out.push(cur);
  if (out.length > MAX_ARGS || out.some((a) => a.length > 400)) return null;
  return out;
}

/** 프로젝트 안 상대 경로인지 (.. · 절대 경로 · 드라이브 · 숨은 .git 거절) */
const safeRel = (p) => typeof p === 'string' && !!p && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).some((x) => x === '..' || x === '.git') && p.length < 260;

/**
 * 한 번 실행할 수 있는 것: npm 스크립트(dev · start · serve · preview + 인자), package.json bin · main, 맨 위의 Python · Node 진입 파일.
 * names: 맨 위 파일 이름 · pkgText: package.json 글 → [{ id, kind: 'npm'|'node'|'py', name?, file?, label }]
 */
function onceTargets(names, pkgText) {
  const have = new Set(names || []);
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
  };
  const scripts = runScripts(pkgText);
  if (scripts.ok) for (const s of scripts.scripts) add({ id: `npm:${s.name}`, kind: 'npm', name: s.name, label: `npm run ${s.name} --` });
  let pkg = null;
  try {
    pkg = JSON.parse(String(pkgText || '').replace(/^\uFEFF/, ''));
  } catch {}
  const nodeFile = (f) => {
    const rel = String(f || '').replace(/^\.\//, '');
    if (safeRel(rel) && /\.(c|m)?js$/i.test(rel)) add({ id: `node:${rel}`, kind: 'node', file: rel, label: `node ${rel}` });
  };
  if (pkg && typeof pkg.bin === 'string') nodeFile(pkg.bin);
  else if (pkg && pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) nodeFile(v);
  if (pkg && typeof pkg.main === 'string') nodeFile(pkg.main);
  for (const f of NODE_ENTRIES) if (have.has(f)) nodeFile(f);
  for (const f of PY_ENTRIES) if (have.has(f)) add({ id: `py:${f}`, kind: 'py', file: f, label: `python ${f}` });
  return out.slice(0, 12);
}

/** 글에서 색 코드(ANSI) 지우기 */
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/** 출력에서 이 PC 주소 찾기 → 'http://localhost:5173/' 꼴 | null (0.0.0.0은 localhost로, 개발자 도구 포트 9229는 건너뜀) */
function findLocalUrl(text) {
  const re = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d{2,5}))?(?:\/[^\s'"<>`)\]]*)?/gi;
  for (const m of stripAnsi(text).matchAll(re)) {
    if (m[1] === '9229') continue;
    let u;
    try {
      u = new URL(m[0].replace(/[.,;:]+$/, ''));
    } catch {
      continue;
    }
    if (u.hostname === '0.0.0.0') u.hostname = 'localhost';
    return u.toString();
  }
  return null;
}

/** 이 PC 주소인지 (미리보기 · 브라우저로 열기에 쓰는 주소 검사) */
function isLocalUrl(s) {
  try {
    const u = new URL(String(s));
    return /^https?:$/.test(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** package.json 글 → 실행할 수 있는 스크립트 [{ name, script, pre?, post? }] (RUN_SCRIPTS 순서) */
function runScripts(pkgText) {
  const pkg = R.readPkgScripts(pkgText);
  if (!pkg.ok) return pkg;
  const list = [];
  for (const name of RUN_SCRIPTS) {
    const s = pkg.scripts[name];
    if (typeof s !== 'string' || !s.trim()) continue;
    const item = { name, script: s.trim() };
    for (const k of ['pre', 'post']) if (typeof pkg.scripts[`${k}${name}`] === 'string' && pkg.scripts[`${k}${name}`].trim()) item[k] = pkg.scripts[`${k}${name}`].trim();
    list.push(item);
  }
  return { ok: true, scripts: list };
}

/** 실행 방법: 셸 없이 npm-cli.js run <이름>. 브라우저를 저절로 열지 않게 BROWSER=none */
function buildRunSpawn({ root, npmCli, execPath, isElectron, nodeExe = null, env = process.env, script }) {
  if (!RUN_SCRIPTS.includes(script)) throw new Error(t('devtest.notAllowed', { name: String(script) }));
  const childEnv = { ...env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none', npm_config_update_notifier: 'false', npm_config_fund: 'false' };
  const viaNode = !!nodeExe;
  if (isElectron && !viaNode) childEnv.ELECTRON_RUN_AS_NODE = '1';
  else delete childEnv.ELECTRON_RUN_AS_NODE;
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'npm_lifecycle_event', 'npm_lifecycle_script']) delete childEnv[k];
  return { command: viaNode ? nodeExe : execPath, args: [npmCli, 'run', script], options: { cwd: root, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } };
}

/** 허용 규칙: 정해 둔 실행 파일 · npm-cli.js run <허용 이름> · 셸 없음 · 프로젝트 폴더 */
function isAllowedRunSpawn(spec, { root, execPath, nodeExe = null, script }) {
  if (!spec || !(spec.command === execPath || (nodeExe && spec.command === nodeExe))) return false;
  if (!RUN_SCRIPTS.includes(script)) return false;
  const a = spec.args;
  if (!Array.isArray(a) || a.length !== 3 || a[1] !== 'run' || a[2] !== script) return false;
  if (!/(^|[\\/])npm-cli\.js$/i.test(a[0]) || !path.isAbsolute(a[0])) return false;
  const o = spec.options || {};
  return o.shell === false && o.cwd === root;
}

/** 한 번 실행 모양: 셸 없이, 프로젝트 폴더에서. target · exe(찾은 실행 파일) · args → { command, args, options } */
function buildOnceSpawn({ root, target, args, npmCli, nodeExe, execPath, isElectron, python, env = process.env }) {
  const childEnv = { ...env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', npm_config_update_notifier: 'false' };
  for (const k of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'npm_lifecycle_event', 'npm_lifecycle_script']) delete childEnv[k];
  const options = { cwd: root, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  if (target.kind === 'npm') {
    if (nodeExe) delete childEnv.ELECTRON_RUN_AS_NODE;
    else if (isElectron) childEnv.ELECTRON_RUN_AS_NODE = '1';
    return { command: nodeExe || execPath, args: [npmCli, 'run', target.name, ...(args.length ? ['--', ...args] : [])], options };
  }
  if (target.kind === 'node') {
    delete childEnv.ELECTRON_RUN_AS_NODE;
    return { command: nodeExe, args: [target.file, ...args], options };
  }
  return { command: python.path, args: [...(python.launcher ? ['-3'] : []), target.file, ...args], options };
}

/** 허용 규칙: 정해 둔 실행 파일(node · python · py · 앱) · 첫 인자가 그 대상 · 셸 없음 · 프로젝트 폴더 */
function isAllowedOnceSpawn(spec, { root, target, nodeExe, execPath, python }) {
  if (!spec || spec.options?.shell !== false || spec.options?.cwd !== root) return false;
  const a = spec.args || [];
  if (target.kind === 'npm') return (spec.command === nodeExe || spec.command === execPath) && /(^|[\\/])npm-cli\.js$/i.test(a[0] || '') && a[1] === 'run' && RUN_SCRIPTS.includes(a[2]) && a[2] === target.name && (a.length === 3 || a[3] === '--');
  if (!safeRel(target.file)) return false;
  if (target.kind === 'node') return !!nodeExe && spec.command === nodeExe && a[0] === target.file;
  if (target.kind === 'py') return !!python && spec.command === python.path && a[python.launcher ? 1 : 0] === target.file && (!python.launcher || a[0] === '-3');
  return false;
}

/**
 * ipcMain: devrun:info · devrun:start(name) · devrun:stop · devrun:log · devrun:open(url)
 *          · devrun:onceInfo · devrun:once(id, argsText) · devrun:onceStop (v0.46.0)
 * 상태가 바뀌면 화면에 'devrun:state'로 알린다: { running, name, script, url, startedAt, exit: { code, at } | null, lines }
 */
function setupDevRun({ ipcMain, getWin, project, shell, spawnFn = spawn, confirm = null, exists = (p) => fs.existsSync(p), findPython = null }) {
  let once = null; // 한 번 실행 중 { child, stopped }
  let run = null; // { child, name, script, url, startedAt, log, lines, root }
  let last = null; // 끝난 실행의 상태 (종료 코드 · 마지막 로그)
  let sendTimer = null;
  const isElectron = !!process.versions.electron;
  const root = () => project.info()?.id || null;

  const snapshot = () => {
    const r = run || last;
    return r ? { running: !!run, name: r.name, script: r.script, url: r.url || null, startedAt: r.startedAt, exit: r.exit || null, lines: r.lines, root: r.root } : { running: false };
  };
  const push = () => {
    sendTimer = null;
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send('devrun:state', snapshot());
  };
  // 출력이 쏟아질 때는 0.5초에 한 번만 알린다
  const pushSoon = () => {
    if (!sendTimer) sendTimer = setTimeout(push, 500);
  };

  async function info() {
    if (!root()) return { ok: false, error: t('main.noProject') };
    const r = await project.readFile('package.json').catch(() => ({ missing: true }));
    const list = runScripts(typeof r.text === 'string' ? r.text : undefined);
    if (!list.ok) return list;
    return { ok: true, scripts: list.scripts, state: snapshot() };
  }

  function stop() {
    if (!run) return false;
    run.stopped = true;
    killTree(run.child);
    return true;
  }

  ipcMain.handle('devrun:info', () => info());

  ipcMain.handle('devrun:start', async (_e, name) => {
    if (run) return { ok: false, error: t('dev.run.already') };
    if (typeof name !== 'string' || !RUN_SCRIPTS.includes(name)) return { ok: false, error: t('devtest.notAllowed', { name: String(name) }) };
    const i = await info();
    if (!i.ok) return i;
    const item = i.scripts.find((s) => s.name === name);
    if (!item) return { ok: false, error: t('dev.run.noScript', { name }) };
    const npmCli = R.findNpmCli({ exists });
    if (!npmCli) return { ok: false, error: t('main.devtest.noNpm') };
    const nodeExe = R.findNodeFor(npmCli, { exists });
    const lines = [item.pre && `pre${name}: ${item.pre}`, `${name}: ${item.script}`, item.post && `post${name}: ${item.post}`].filter(Boolean);
    const ask = confirm || ((opts) => dialog.showMessageBox(getWin(), opts).then((r) => r.response === 0));
    const ok = await ask({
      type: 'warning',
      buttons: [t('dev.run.start'), t('main.cancel')],
      defaultId: 0,
      cancelId: 1,
      title: t('dev.run.confirmTitle'),
      message: t('dev.run.confirmMessage'),
      detail: `${lines.join('\n')}\n\n${t('dev.run.confirmNote')}\n\n${t('main.folderLine', { path: root() })}`,
    });
    if (!ok) return { ok: false, cancelled: true, error: t('main.cancelled') };
    if (run) return { ok: false, error: t('dev.run.already') };
    const spec = buildRunSpawn({ root: root(), npmCli, execPath: process.execPath, isElectron, nodeExe, script: name });
    if (!isAllowedRunSpawn(spec, { root: root(), execPath: process.execPath, nodeExe, script: name })) return { ok: false, error: t('main.devtest.notAllowedRun') };
    let child;
    try {
      child = spawnFn(spec.command, spec.args, spec.options);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const me = (run = { child, name, script: item.script, url: null, startedAt: Date.now(), log: '', lines: 0, root: root(), exit: null });
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const onData = (d) => (buf) => {
      const s = d.write(buf);
      me.log = (me.log + s).slice(-MAX_LOG);
      me.lines += (s.match(/\n/g) || []).length;
      if (!me.url) {
        const u = findLocalUrl(me.log.slice(-8192));
        if (u) {
          me.url = u;
          return push(); // 주소는 바로 알린다
        }
      }
      pushSoon();
    };
    child.stdout?.on('data', onData(decoders[0]));
    child.stderr?.on('data', onData(decoders[1]));
    const finish = (code, error) => {
      if (me.exit) return;
      me.exit = { code, at: Date.now(), stopped: !!me.stopped, ...(error ? { error } : {}) };
      if (run === me) run = null;
      last = me;
      push();
    };
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
    push();
    return { ok: true, state: snapshot() };
  });

  // ---------- 한 번 실행 (v0.46.0) ----------
  async function onceList() {
    if (!root()) return { ok: false, error: t('main.noProject') };
    const ents = await project.readDir('').catch(() => []);
    const r = await project.readFile('package.json').catch(() => ({ missing: true }));
    return { ok: true, targets: onceTargets(ents.filter((e) => e.kind === 'file').map((e) => e.name), typeof r.text === 'string' ? r.text : '') };
  }
  ipcMain.handle('devrun:onceInfo', () => onceList());
  ipcMain.handle('devrun:once', async (_e, id, argsText) => {
    if (once) return { ok: false, error: t('dev.once.busy') };
    const list = await onceList();
    if (!list.ok) return list;
    const target = list.targets.find((x) => x.id === id);
    if (!target) return { ok: false, error: t('dev.once.noTarget') };
    const args = parseArgs(argsText);
    if (!args) return { ok: false, error: t('dev.once.badArgs') };
    const npmCli = R.findNpmCli({ exists });
    // npm과 같은 설치의 node.exe → 없으면 PATH의 node (개발 환경 점검과 같은 찾기: 절대 경로 폴더만 · 프로젝트 안 제외)
    const pathNode = () => {
      const f = require('./envcheck').findTool('node', { root: root() });
      return f.state === 'ok' && f.kind === 'exe' ? f.path : null;
    };
    const nodeExe = (npmCli && R.findNodeFor(npmCli, { exists })) || (target.kind === 'node' ? pathNode() : null);
    let python = null;
    if (target.kind === 'npm' && !npmCli) return { ok: false, error: t('main.devtest.noNpm') };
    if (target.kind === 'node' && !nodeExe) return { ok: false, error: t('dev.once.noNode') };
    if (target.kind === 'py') {
      const f = (findPython || (() => require('./envcheck').findTool('python', { root: root() })))();
      if (!f || f.state !== 'ok' || f.kind !== 'exe') return { ok: false, error: t('dev.once.noPython') };
      python = { path: f.path, launcher: !!f.launcher };
    }
    const spec = buildOnceSpawn({ root: root(), target, args, npmCli, nodeExe, execPath: process.execPath, isElectron, python });
    if (!isAllowedOnceSpawn(spec, { root: root(), target, nodeExe, execPath: process.execPath, python })) return { ok: false, error: t('main.devtest.notAllowedRun') };
    const shown = [path.basename(spec.command), ...spec.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
    const ask = confirm || ((opts) => dialog.showMessageBox(getWin(), opts).then((r) => r.response === 0));
    const ok = await ask({ type: 'warning', buttons: [t('dev.once.run'), t('main.cancel')], defaultId: 0, cancelId: 1, title: t('dev.once.title'), message: t('dev.once.confirmMessage'), detail: `${shown}\n\n${t('dev.once.confirmNote', { sec: ONCE_TIMEOUT_MS / 1000 })}\n\n${t('main.folderLine', { path: root() })}` });
    if (!ok) return { ok: false, cancelled: true, error: t('main.cancelled') };
    const started = Date.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(spec.command, spec.args, spec.options);
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }
      const me = (once = { child, stopped: false });
      let out = '';
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
      const onData = (dd) => (buf) => {
        if (out.length < MAX_LOG) out += dd.write(buf);
      };
      child.stdout?.on('data', onData(decoders[0]));
      child.stderr?.on('data', onData(decoders[1]));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, ONCE_TIMEOUT_MS);
      const finish = (code, error) => {
        clearTimeout(timer);
        if (once === me) once = null;
        resolve({ ok: !error && !timedOut && !me.stopped && code === 0, code, timedOut, stopped: me.stopped, ms: Date.now() - started, command: shown, output: maskOutput(stripAnsi(out.slice(0, MAX_LOG)), PATTERNS), ...(error ? { error } : {}) });
      };
      child.on('error', (err) => finish(null, err.message));
      child.on('close', (code) => finish(code));
    });
  });
  ipcMain.handle('devrun:onceStop', () => {
    if (!once) return false;
    once.stopped = true;
    killTree(once.child);
    return true;
  });

  ipcMain.handle('devrun:stop', () => stop());
  ipcMain.handle('devrun:log', () => {
    const r = run || last;
    return { ok: true, text: r ? maskOutput(stripAnsi(r.log), PATTERNS) : '', state: snapshot() };
  });
  // 브라우저로 열기: 이 PC 주소만
  ipcMain.handle('devrun:open', async (_e, url) => {
    if (!isLocalUrl(url)) return false;
    await shell.openExternal(String(url));
    return true;
  });

  return {
    stop: () => {
      stop();
      if (once) killTree(once.child);
    },
    // 프로젝트를 닫거나 바꾸면 그 프로젝트의 서버도 끈다
    onProjectChange: () => {
      if (run && run.root !== root()) stop();
      if (!run && last && last.root !== root()) last = null;
      push();
    },
    state: snapshot,
  };
}

module.exports = { setupDevRun, findLocalUrl, isLocalUrl, runScripts, buildRunSpawn, isAllowedRunSpawn, stripAnsi, RUN_SCRIPTS, parseArgs, onceTargets, buildOnceSpawn, isAllowedOnceSpawn, safeRel, ONCE_TIMEOUT_MS };
