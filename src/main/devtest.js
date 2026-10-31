'use strict';

// 미리보기 창의 "테스트 실행" (Windows 앱 전용).
//   1) 지금 파일 그대로 npm test (적용 전)
//   2) 체크한 수정안을 잠깐 써 두고 npm test (적용 후)
//   3) 원래 파일로 되돌림 — 성공·실패·중지와 상관없이 항상. 실제 적용은 사용자가 결과를 보고 "선택한 파일 적용"으로 한다.
// 앱이 2)와 3) 사이에 꺼져도 원본을 잃지 않도록, 쓰기 전에 원본을 앱 데이터 폴더(devtest-recovery.json)에 적어 두고
// 다음에 그 프로젝트를 열 때 되돌린다 (recover).
//
// [쉽게 말하면] AI가 고친 코드를 "써 보기만" 하고 테스트를 돌린 뒤, 원래대로 돌려놓는 담당입니다.
// 실행 규칙(셸 없이, npm test만, 시간 제한, 출력 가림)은 test-rules.js에 있습니다.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dialog } = require('electron');
const R = require('./test-rules');
const { killTree } = require('./gitconsole');
const { maskOutput } = require('./git-rules');
const { PATTERNS } = require('../shared/secret-scan');
const { executionRisk } = require('../shared/patch');

/**
 * ipcMain, getWin(): 앱 창, project: main/project.js (열린 폴더 안에서만 읽고 씀), userDataDir: 앱 데이터 폴더
 */
function setupDevTest({ ipcMain, getWin, project, userDataDir }) {
  const recoveryFile = path.join(userDataDir, 'devtest-recovery.json');
  let running = null; // { child, stopped }
  let busy = false;

  const isElectron = !!process.versions.electron;
  const root = () => project.info()?.id || null;

  async function scriptInfo() {
    if (!root()) return { ok: false, error: '프로젝트가 열려 있지 않습니다' };
    const r = await project.readFile('package.json').catch(() => ({ missing: true }));
    const info = R.readTestScript(typeof r.text === 'string' ? r.text : undefined);
    if (!info.ok) return info;
    const npmCli = R.findNpmCli({ exists: (p) => fs.existsSync(p) });
    if (!npmCli) return { ok: false, error: 'npm을 찾지 못했습니다. Node.js를 설치하고 PATH에 넣은 뒤 앱을 다시 시작하세요' };
    return { ...info, npmCli, nodeExe: R.findNodeFor(npmCli, { exists: (p) => fs.existsSync(p) }) };
  }

  /** npm test 한 번 → { ok, code, timedOut, stopped, ms, output, summary, error? } */
  function runOnce(npmCli, label, nodeExe = null) {
    const spec = R.buildTestSpawn({ root: root(), npmCli, execPath: process.execPath, isElectron, nodeExe });
    if (!R.isAllowedTestSpawn(spec, { root: root(), execPath: process.execPath, nodeExe })) {
      return Promise.resolve({ ok: false, error: '허용되지 않는 실행 방법입니다', output: '' });
    }
    const started = Date.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spec.command, spec.args, spec.options);
      } catch (err) {
        return resolve({ ok: false, error: err.message, output: '', ms: 0 });
      }
      const run = (running = { child, stopped: false, label });
      let out = '';
      let size = 0;
      let cut = false;
      const onData = (buf) => {
        if (cut) return;
        size += buf.length;
        if (size > R.MAX_OUTPUT) {
          cut = true;
          out += '\n… 출력이 2MB를 넘어 나머지는 보이지 않습니다\n';
          return;
        }
        out += buf.toString('utf8');
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, R.TEST_TIMEOUT_MS);
      const finish = (code, error) => {
        clearTimeout(timer);
        running = null;
        const output = maskOutput(out, PATTERNS);
        resolve({
          ok: !error && !timedOut && !run.stopped && code === 0,
          code,
          timedOut,
          stopped: run.stopped,
          ms: Date.now() - started,
          output,
          summary: R.summarizeTestOutput(output),
          error,
        });
      };
      child.on('error', (err) => finish(null, err.message));
      child.on('close', (code) => finish(code));
    });
  }

  const writeRecovery = (data) => fs.writeFileSync(recoveryFile, JSON.stringify(data));
  const clearRecovery = () => fs.rmSync(recoveryFile, { force: true });

  /** 원본으로 되돌린다. → 되돌리지 못한 파일 목록 */
  async function restore(files) {
    const failed = [];
    for (const f of files) {
      try {
        if (f.existed) await project.writeFile(f.path, f.text);
        else await project.deleteFile(f.path).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
      } catch (err) {
        failed.push(`${f.path}: ${err.message}`);
      }
    }
    return failed;
  }

  /** 지난번 테스트 중 앱이 꺼져 남은 임시 적용이 있으면 되돌린다 (그 프로젝트를 열 때). → 되돌린 파일 수 */
  async function recover() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    } catch {
      return 0;
    }
    if (!data || data.root !== root() || !Array.isArray(data.files)) return 0;
    const failed = await restore(data.files);
    if (!failed.length) clearRecovery();
    return data.files.length - failed.length;
  }

  ipcMain.handle('devtest:info', async () => {
    const info = await scriptInfo();
    return info.ok ? { ok: true, script: info.script, pre: info.pre || null, post: info.post || null } : info;
  });

  ipcMain.handle('devtest:trial', async (_e, rawChanges) => {
    if (busy) return { ok: false, error: '이미 테스트를 실행하고 있습니다' };
    const changes = R.checkTrialChanges(rawChanges);
    if (!changes) return { ok: false, error: '테스트할 수정안이 올바르지 않습니다' };
    const info = await scriptInfo();
    if (!info.ok) return info;

    const scripts = [info.pre && `pretest: ${info.pre}`, `test: ${info.script}`, info.post && `posttest: ${info.post}`].filter(Boolean);
    // 수정안이 실행 방식(package.json의 test 등 · 실행 영향 파일)을 바꾸면 "적용 후"에는 그것이 돈다 — 확인 창에 따로 보여 준다
    const withBefore = [];
    for (const c of changes) {
      const r = await project.readFile(c.path, { maxBytes: 5 * 1024 * 1024 }).catch(() => ({ missing: true }));
      withBefore.push({ ...c, before: r.missing ? null : typeof r.text === 'string' ? r.text : null });
    }
    const warn = R.trialWarnings(withBefore, executionRisk);
    const warnText = [
      ...(warn.scriptLines.length ? ['', '⚠ 수정안이 테스트 스크립트를 바꿉니다 — "적용 후" 실행에서는 바뀐 스크립트가 돕니다:', ...warn.scriptLines] : []),
      ...(warn.riskLines.length ? ['', '⚠ 실행에 영향을 주는 파일이 들어 있습니다:', ...warn.riskLines] : []),
    ].join('\n');
    const { response } = await dialog.showMessageBox(getWin(), {
      type: 'warning',
      buttons: ['테스트 실행', '취소'],
      defaultId: 0,
      cancelId: 1,
      title: '테스트 실행 확인',
      message: '이 PC에서 프로젝트의 테스트를 실행합니다',
      detail:
        `${scripts.join('\n')}\n\n` +
        `1) 지금 파일 그대로 실행 → 2) 체크한 수정안 ${changes.length}개 파일을 잠깐 써 두고 실행 → 3) 원래 파일로 되돌림\n` +
        `AI가 고친 코드(테스트 코드 포함)가 실제로 실행됩니다. 시간 제한 ${R.TEST_TIMEOUT_MS / 60000}분.${warnText ? `\n${warnText}` : ''}\n\n폴더: ${root()}`,
    });
    if (response !== 0) return { ok: false, error: '취소했습니다', cancelled: true };

    busy = true;
    const backup = [];
    try {
      const before = await runOnce(info.npmCli, 'before', info.nodeExe);
      if (before.stopped) return { ok: true, script: info.script, before, after: null };

      // 원본 읽기 (텍스트가 아니거나 너무 크면 테스트하지 않는다)
      for (const c of changes) {
        const r = await project.readFile(c.path, { maxBytes: 5 * 1024 * 1024 });
        if (r.missing) backup.push({ path: c.path, existed: false });
        else if (typeof r.text === 'string') backup.push({ path: c.path, existed: true, text: r.text });
        else return { ok: false, error: `${c.path}: ${r.binary ? '바이너리 파일' : '파일이 너무 큽니다'}라 테스트할 수 없습니다`, before };
      }
      writeRecovery({ root: root(), at: Date.now(), files: backup });
      let after;
      const restoreList = [];
      try {
        for (const c of changes) {
          restoreList.push(backup.find((b) => b.path === c.path));
          if (c.after === null) await project.deleteFile(c.path);
          else await project.writeFile(c.path, c.after);
        }
        after = await runOnce(info.npmCli, 'after', info.nodeExe);
      } catch (err) {
        after = { ok: false, error: `임시 적용 실패: ${err.message}`, output: '' };
      } finally {
        const failed = await restore(restoreList);
        if (!failed.length) clearRecovery();
        else after = { ...after, restoreFailed: failed };
      }
      return { ok: true, script: info.script, before, after };
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('devtest:stop', () => {
    if (!running) return false;
    running.stopped = true;
    killTree(running.child);
    return true;
  });

  return { recover, stop: () => running && killTree(running.child), isBusy: () => busy };
}

module.exports = { setupDevTest };
