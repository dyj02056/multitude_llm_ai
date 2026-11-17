'use strict';

// 적용 후 커밋 (v0.28.0, Windows 앱 전용): AI 수정안을 적용한 파일만 커밋한다.
// 화면은 경로 목록과 메시지만 넘기고, 검사(commit-rules.js) · 실행은 모두 여기(메인 프로세스)에서 한다.
//   - git 콘솔과 같은 방식: 셸 없이 git.exe를 직접(PATH의 절대 경로 폴더에서 찾은 것), 인자 배열, 프로젝트 폴더가 cwd
//   - git 저장소가 아니면 거절, 프로젝트 밖 · .git 안 경로는 거절, 단계마다 시간 제한 1분, 출력은 토큰을 가려 보여 준다
//   - 하는 일은 git add -A -- <경로> 와 git commit -m <메시지> -- <경로> 뿐. push · fetch 같은 네트워크 명령은 하지 않는다
//   - v0.34.0: 적용 전에 사용자가 체크했을 때만 git switch -c mla/<날짜>-<이름> (새 브랜치, 이미 있으면 거절)
//   - 테스트 실행이 수정안을 잠깐 써 둔 동안에는 커밋하지 않는다 (임시 내용이 커밋되지 않게)
//
// [쉽게 말하면] "적용한 파일만 골라 내 PC의 git 기록에 한 번 남기기" 담당입니다. 인터넷으로 올리기(push)는 하지 않습니다.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./commit-rules');
const { FORCED_ENV, maskOutput } = require('./git-rules');
const { resolveExe, killTree } = require('./gitconsole');
const { PATTERNS } = require('../shared/secret-scan');
const { t } = require('../shared/i18n');

const STEP_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT = 512 * 1024;

/** git 한 번 실행 → { code, out, err, timedOut, error? } (셸 없음, 출력은 MAX_OUTPUT까지) */
function runGit(exe, args, cwd, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!C.isAllowedCommitStep(args)) return resolve({ code: null, out: '', err: '', error: t('commit.notAllowed') });
    let child;
    try {
      child = spawn(exe, args, { cwd, env: { ...process.env, ...FORCED_ENV }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, out: '', err: '', error: err.message });
    }
    const bufs = { out: [], err: [] };
    let size = 0;
    const take = (k) => (b) => {
      if (size > MAX_OUTPUT) return;
      size += b.length;
      bufs[k].push(b);
    };
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (code, error) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(bufs.out).toString('utf8'), err: Buffer.concat(bufs.err).toString('utf8'), timedOut, error });
    };
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

/**
 * ipcMain, getRoot(): 열어 둔 프로젝트 폴더(없으면 null), isBusy(): 테스트 실행 중인지, gitExe(): git 위치 (테스트에서 바꿔 끼움)
 */
function setupGitCommit({ ipcMain, getRoot, isBusy = () => false, gitExe = () => resolveExe(process.platform === 'win32' ? 'git.exe' : 'git') }) {
  let running = false;

  /** 저장소인지 · 프로젝트 폴더의 저장소 안 위치 · 브랜치 → { ok, exe, root, prefix, branch } | { ok: false, error, notRepo? } */
  async function repoOf() {
    const root = getRoot();
    if (!root) return { ok: false, error: t('main.noProject') };
    const exe = gitExe();
    if (!exe) return { ok: false, error: t('main.noGitInstall') };
    const top = await runGit(exe, [...C.PREFIX, 'rev-parse', '--show-prefix'], root);
    if (top.code !== 0) return { ok: false, notRepo: true, error: t('commit.notRepo') };
    const branch = await runGit(exe, [...C.PREFIX, 'rev-parse', '--abbrev-ref', 'HEAD'], root);
    return { ok: true, exe, root, prefix: top.out.trim().replace(/\\/g, '/'), branch: branch.code === 0 ? branch.out.trim() : '' };
  }

  async function stagedOthers(repo, paths) {
    const r = await runGit(repo.exe, C.stagedArgs(), repo.root);
    return r.code === 0 ? C.otherStaged(C.splitNul(r.out), repo.prefix, paths) : [];
  }

  // 커밋 창을 열 때: 저장소인지 · 브랜치 · 이번에 커밋하지 않는 다른 스테이징 파일 (경고용)
  ipcMain.handle('git:commitInfo', async (_e, rawPaths) => {
    const paths = C.checkPaths(rawPaths);
    if (!paths.ok) return paths;
    const repo = await repoOf();
    if (!repo.ok) return repo;
    return { ok: true, branch: repo.branch, otherStaged: (await stagedOthers(repo, paths.paths)).slice(0, 50) };
  });

  // 새 브랜치에 적용 (v0.34.0): 적용 직전에 새 브랜치를 만들고 그 위로 옮겨 간다. 고친 파일은 그대로 따라온다. push는 하지 않는다
  ipcMain.handle('git:branchCreate', async (_e, rawName) => {
    if (running) return { ok: false, error: t('commit.busy') };
    if (isBusy()) return { ok: false, error: t('main.busyTest') };
    running = true;
    try {
      const chk = C.checkBranchName(rawName);
      if (!chk.ok) return chk;
      const repo = await repoOf();
      if (!repo.ok) return repo;
      const exists = await runGit(repo.exe, C.branchExistsArgs(chk.name), repo.root);
      if (exists.code === 0) return { ok: false, error: t('commit.branchExists', { name: chk.name }) };
      const sw = await runGit(repo.exe, C.branchSwitchArgs(chk.name), repo.root);
      if (sw.code !== 0) {
        const why = maskOutput(`${sw.err}${sw.out}${sw.error || ''}`.trim(), PATTERNS).slice(0, 600);
        return { ok: false, error: t('commit.branchFailed', { name: chk.name }) + (why ? ` — ${why}` : '') };
      }
      return { ok: true, branch: chk.name, from: repo.branch };
    } finally {
      running = false;
    }
  });

  // 커밋: add → commit. 경로를 붙인 commit이라 다른 스테이징 파일은 들어가지 않는다
  ipcMain.handle('git:commit', async (_e, raw) => {
    if (running) return { ok: false, error: t('commit.busy') };
    if (isBusy()) return { ok: false, error: t('main.busyTest') };
    running = true;
    try {
      const req = C.checkCommitRequest(raw);
      if (!req.ok) return req;
      const repo = await repoOf();
      if (!repo.ok) return repo;
      const tracked = await runGit(repo.exe, C.trackedArgs(req.paths), repo.root);
      const paths = C.pickCommitPaths(req.paths, {
        exists: (p) => fs.existsSync(path.join(repo.root, p)),
        tracked: tracked.code === 0 ? C.splitNul(tracked.out) : [],
      });
      if (!paths.length) return { ok: false, error: t('commit.nothing') };
      const others = await stagedOthers(repo, paths);
      const log = [];
      const show = (args, r) => {
        log.push(`$ git ${args.slice(C.PREFIX.length).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
        if (r.out.trim()) log.push(r.out.trimEnd());
        if (r.err.trim()) log.push(r.err.trimEnd());
        if (r.timedOut) log.push(t('commit.timedOut', { s: STEP_TIMEOUT_MS / 1000 }));
        if (r.error) log.push(r.error);
      };
      const output = () => maskOutput(log.join('\n'), PATTERNS);
      const add = C.addArgs(paths);
      const a = await runGit(repo.exe, add, repo.root);
      show(add, a);
      if (a.code !== 0) return { ok: false, error: t('commit.addFailed'), output: output(), otherStaged: others };
      const commit = C.commitArgs(paths, req.message);
      const c = await runGit(repo.exe, commit, repo.root);
      show(commit, c);
      if (c.code !== 0) return { ok: false, error: t('commit.failed', { code: String(c.code) }), output: output(), otherStaged: others };
      const head = await runGit(repo.exe, [...C.PREFIX, 'rev-parse', '--short', 'HEAD'], repo.root);
      return { ok: true, hash: head.code === 0 ? head.out.trim() : '', branch: repo.branch, paths, output: output(), otherStaged: others };
    } finally {
      running = false;
    }
  });
}

module.exports = { setupGitCommit, runGit };
