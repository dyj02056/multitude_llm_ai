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

/**
 * ipcMain: devrun:info · devrun:start(name) · devrun:stop · devrun:log · devrun:open(url)
 * 상태가 바뀌면 화면에 'devrun:state'로 알린다: { running, name, script, url, startedAt, exit: { code, at } | null, lines }
 */
function setupDevRun({ ipcMain, getWin, project, shell, spawnFn = spawn, confirm = null, exists = (p) => fs.existsSync(p) }) {
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
    stop,
    // 프로젝트를 닫거나 바꾸면 그 프로젝트의 서버도 끈다
    onProjectChange: () => {
      if (run && run.root !== root()) stop();
      if (!run && last && last.root !== root()) last = null;
      push();
    },
    state: snapshot,
  };
}

module.exports = { setupDevRun, findLocalUrl, isLocalUrl, runScripts, buildRunSpawn, isAllowedRunSpawn, stripAnsi, RUN_SCRIPTS };
