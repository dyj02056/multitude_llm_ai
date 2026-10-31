'use strict';

// git 콘솔 (Windows 앱 전용): 열어 둔 프로젝트 폴더에서 git 명령만 실행한다.
// 화면(렌더러)은 명령 줄 글자만 넘기고, 검사(git-rules.js)·확인 창·실행은 모두 여기(메인 프로세스)에서 한다.
//
// - 셸 없이 git.exe를 직접 띄운다 (; && | 같은 글자는 그냥 인자). git.exe는 PATH의 절대 경로 폴더에서만 찾는다
//   (Windows는 실행 파일을 현재 폴더에서 먼저 찾을 수 있어, 프로젝트 안의 가짜 git.exe가 실행되지 않게 한다).
// - 한 번에 하나만, 시간 제한(네트워크 명령 2분 · 나머지 1분)과 중지 버튼. 출력은 2MB까지, 주소의 토큰·알려진 키는 가린다.
// - 되돌리기 어려운 명령은 앱 창 위에 확인 창을 띄운다.

// [쉽게 말하면]
// git 콘솔 화면에서 사용자가 친 명령을 실제로 실행하고, 결과 글자를 화면으로 흘려보내는 파일입니다.
// 안전장치: 경비원(git-rules.js) 검사 통과 → 위험하면 확인 창 → 실행 → 시간이 너무 길면 자동으로 멈춤
// "셸 없이 실행"한다는 것은, 명령 줄을 해석하는 중간 프로그램(cmd/PowerShell)을 거치지 않아
// 명령 뒤에 다른 명령을 몰래 이어 붙이는 일(예: ; del *.*)이 불가능하다는 뜻입니다.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { dialog } = require('electron');
const { checkCommand, FORCED_PREFIX, FORCED_ENV, maskOutput } = require('./git-rules');
const { PATTERNS } = require('../shared/secret-scan');

const MAX_OUTPUT = 2 * 1024 * 1024;
const NETWORK = new Set(['fetch', 'pull', 'push']);
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/** PATH의 절대 경로 폴더에서만 실행 파일을 찾는다 (현재 폴더·상대 경로 PATH는 보지 않음) */
function resolveExe(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

let gitExe;
const gitPath = () => (gitExe === undefined ? (gitExe = resolveExe(process.platform === 'win32' ? 'git.exe' : 'git')) : gitExe);

/** 실행 중인 git과 그 git이 띄운 하위 프로그램까지 한꺼번에 강제로 끕니다 (중지 버튼·시간 초과). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else child.kill('SIGKILL');
}

/**
 * ipcMain: Electron ipcMain, getWin(): 앱 창, getRoot(): 열어 둔 프로젝트 폴더(없으면 null)
 */
// git 콘솔이 쓰는 요청 통로(git:info, git:run, git:stop, git:openTerminal)를 등록합니다.
function setupGitConsole({ ipcMain, getWin, getRoot }) {
  let running = null; // { child, timer }

  const send = (channel, data) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  /** 앱이 내부에서 쓰는 짧은 git 실행 (브랜치 이름 등). → stdout | null */
  const quick = (root, args) =>
    new Promise((resolve) => {
      if (!gitPath()) return resolve(null);
      execFile(gitPath(), [...FORCED_PREFIX, ...args], { cwd: root, env: { ...process.env, ...FORCED_ENV }, timeout: 5000, windowsHide: true }, (err, out) =>
        resolve(err ? null : String(out).trim()),
      );
    });

  // 콘솔을 열 때: git 위치, 저장소인지, 브랜치, 이 저장소의 git 훅 (commit 등에서 실행되는 프로그램)
  ipcMain.handle('git:info', async () => {
    const root = getRoot();
    if (!root) return { error: '프로젝트가 열려 있지 않습니다' };
    if (!gitPath()) return { error: 'git을 찾지 못했습니다. Git for Windows를 설치하고 PATH에 넣은 뒤 앱을 다시 시작하세요' };
    const top = await quick(root, ['rev-parse', '--show-toplevel']);
    if (top === null) return { root, isRepo: false };
    const branch = await quick(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const hooksPath = await quick(root, ['config', '--get', 'core.hooksPath']);
    const gitDir = await quick(root, ['rev-parse', '--absolute-git-dir']);
    let hooks = [];
    try {
      const dir = hooksPath ? path.resolve(top, hooksPath) : path.join(gitDir || path.join(top, '.git'), 'hooks');
      hooks = fs.readdirSync(dir).filter((n) => !n.endsWith('.sample') && fs.statSync(path.join(dir, n)).isFile());
    } catch {}
    return { root, isRepo: true, top, branch, hooks, hooksPath: hooksPath || null };
  });

  // 명령 실행: 한 번에 하나만. 출력은 받는 즉시 화면으로 보내고(git:output), 끝나면 git:done으로 알립니다.
  ipcMain.handle('git:run', async (_e, line) => {
    const root = getRoot();
    if (!root) return { ok: false, error: '프로젝트가 열려 있지 않습니다' };
    if (running) return { ok: false, error: '이미 실행 중인 명령이 있습니다 (끝나거나 중지한 뒤 실행하세요)' };
    if (typeof line !== 'string' || line.length > 4000) return { ok: false, error: '명령이 너무 깁니다' };
    const exe = gitPath();
    if (!exe) return { ok: false, error: 'git을 찾지 못했습니다' };
    const cmd = checkCommand(line);
    if (!cmd.ok) return cmd;
    if (cmd.danger) {
      const win = getWin();
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['실행', '취소'],
        defaultId: 1,
        cancelId: 1,
        title: 'git 명령 확인',
        message: `${cmd.danger}. 실행할까요?`,
        detail: `${line.trim()}\n\n폴더: ${root}`,
      });
      if (response !== 0) return { ok: false, error: '취소했습니다', cancelled: true };
    }

    const started = Date.now();
    const child = spawn(exe, [...FORCED_PREFIX, ...cmd.args], {
      cwd: root,
      env: { ...process.env, ...FORCED_ENV },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let size = 0;
    let cut = false;
    const onData = (stream) => (buf) => {
      if (cut) return;
      size += buf.length;
      if (size > MAX_OUTPUT) {
        cut = true;
        send('git:output', { stream: 'info', text: '\n… 출력이 2MB를 넘어 나머지는 보이지 않습니다\n' });
        return;
      }
      send('git:output', { stream, text: maskOutput(buf.toString('utf8'), PATTERNS) });
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    const limit = NETWORK.has(cmd.args[0]) ? 120000 : 60000;
    const timer = setTimeout(() => {
      send('git:output', { stream: 'info', text: `\n시간 제한(${limit / 1000}초)을 넘어 멈췄습니다\n` });
      killTree(child);
    }, limit);
    running = { child, timer };
    return new Promise((resolve) => {
      const finish = (code, error) => {
        clearTimeout(timer);
        running = null;
        send('git:done', { code, ms: Date.now() - started, error });
        resolve({ ok: true, code, error });
      };
      child.on('error', (err) => finish(null, err.message));
      child.on('close', (code) => finish(code));
    });
  });

  // 중지 버튼
  ipcMain.handle('git:stop', () => {
    if (!running) return false;
    send('git:output', { stream: 'info', text: '\n중지했습니다\n' });
    killTree(running.child);
    return true;
  });

  // 이 폴더에서 Windows 터미널(없으면 PowerShell) 열기 — git 밖의 작업이 필요할 때 사용자가 직접 쓴다
  ipcMain.handle('git:openTerminal', () => {
    const root = getRoot();
    if (!root) return { ok: false, error: '프로젝트가 열려 있지 않습니다' };
    const wt = resolveExe('wt.exe');
    const [exe, args] = wt
      ? [wt, ['-d', root]]
      : [path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoExit']];
    try {
      const child = spawn(exe, args, { cwd: root, detached: true, stdio: 'ignore', shell: false });
      child.on('error', () => {});
      child.unref();
      return { ok: true, via: wt ? 'Windows 터미널' : 'PowerShell' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return { stop: () => running && killTree(running.child) };
}

module.exports = { setupGitConsole, resolveExe, killTree };
