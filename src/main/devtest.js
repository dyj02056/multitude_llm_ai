'use strict';

// 미리보기 창의 "테스트 실행" (Windows 앱 전용).
//   1) 지금 파일 그대로 npm test (적용 전)
//   2) 체크한 수정안을 잠깐 써 두고 npm test (적용 후)
//   v0.28.0: package.json에 lint · typecheck · build가 있으면 화면에서 골라 함께 돌린다 (이름만 받음, 스크립트마다 시간 제한)
//   3) 원래 파일로 되돌림 — 성공·실패·중지와 상관없이 항상. 실제 적용은 사용자가 결과를 보고 "선택한 파일 적용"으로 한다.
// 앱이 2)와 3) 사이에 꺼져도 원본을 잃지 않도록, 쓰기 전에 원본을 앱 데이터 폴더(devtest-recovery.json)에 적어 두고
// 다음에 그 프로젝트를 열 때 되돌린다 (recover).
//
// [쉽게 말하면] AI가 고친 코드를 "써 보기만" 하고 테스트를 돌린 뒤, 원래대로 돌려놓는 담당입니다.
// 실행 규칙(셸 없이, npm test만, 시간 제한, 출력 가림)은 test-rules.js에 있습니다.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { dialog } = require('electron');
const R = require('./test-rules');
const { killTree } = require('./gitconsole');
const { maskOutput } = require('./git-rules');
const { PATTERNS } = require('../shared/secret-scan');
const { executionRisk } = require('../shared/patch');
const { t } = require('../shared/i18n');

/**
 * ipcMain, getWin(): 앱 창, project: main/project.js (열린 폴더 안에서만 읽고 씀), userDataDir: 앱 데이터 폴더
 */
function setupDevTest({ ipcMain, getWin, project, userDataDir }) {
  const recoveryFile = path.join(userDataDir, 'devtest-recovery.json');
  let running = null; // { child, stopped }
  let busy = false;

  const isElectron = !!process.versions.electron;
  const root = () => project.info()?.id || null;

  /**
   * package.json의 검사 스크립트(test · lint · typecheck · build 중 있는 것)와 npm 위치.
   * → { ok, checks: [{ name, script, pre?, post? }], test: test 스크립트 정보 | 오류, npmCli, nodeExe, pkgText } | { ok: false, error }
   */
  async function scriptInfo() {
    if (!root()) return { ok: false, error: '프로젝트가 열려 있지 않습니다' };
    const r = await project.readFile('package.json').catch(() => ({ missing: true }));
    const pkgText = typeof r.text === 'string' ? r.text : undefined;
    const test = R.readTestScript(pkgText);
    const avail = R.availableChecks(pkgText);
    if (!avail.ok) return test.ok ? avail : test; // package.json이 없거나 깨졌거나, 검사 스크립트가 하나도 없음
    const npmCli = R.findNpmCli({ exists: (p) => fs.existsSync(p) });
    if (!npmCli) return { ok: false, error: 'npm을 찾지 못했습니다. Node.js를 설치하고 PATH에 넣은 뒤 앱을 다시 시작하세요' };
    return { ok: true, checks: avail.checks, test, npmCli, nodeExe: R.findNodeFor(npmCli, { exists: (p) => fs.existsSync(p) }) };
  }

  /** npm test(또는 npm run <script>) 한 번 → { ok, code, timedOut, stopped, ms, output, summary, error? } */
  function runOnce(npmCli, label, nodeExe = null, script = 'test') {
    const spec = R.buildTestSpawn({ root: root(), npmCli, execPath: process.execPath, isElectron, nodeExe, script });
    if (!R.isAllowedTestSpawn(spec, { root: root(), execPath: process.execPath, nodeExe, script })) {
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
      // 스트림마다 따로 풀어 조각 경계에 걸린 한글(UTF-8 여러 바이트)이 깨지지 않게 한다
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
      const onData = (decoder) => (buf) => {
        if (cut) return;
        size += buf.length;
        if (size > R.MAX_OUTPUT) {
          cut = true;
          out += '\n… 출력이 2MB를 넘어 나머지는 보이지 않습니다\n';
          return;
        }
        out += decoder.write(buf);
      };
      child.stdout.on('data', onData(decoders[0]));
      child.stderr.on('data', onData(decoders[1]));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, R.TEST_TIMEOUT_MS);
      const finish = (code, error) => {
        clearTimeout(timer);
        running = null;
        if (!cut) for (const d of decoders) out += d.end();
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

  // 원본 파일 내용이 들어 있어 암호화해 저장한다 (v0.22.1)
  const writeRecovery = (data) => require('./secure-store').store().writeJson(recoveryFile, data);
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
    const data = require('./secure-store').store().readJson(recoveryFile, null);
    if (!data || data.root !== root() || !Array.isArray(data.files)) return 0;
    const failed = await restore(data.files);
    if (!failed.length) clearRecovery();
    return data.files.length - failed.length;
  }

  // 화면에 보여 줄 것: test 스크립트(예전 모양 그대로)와 있는 검사 스크립트 목록 (v0.28.0 — 체크 칸은 이것만 보인다)
  ipcMain.handle('devtest:info', async () => {
    const info = await scriptInfo();
    if (!info.ok) return info;
    const tst = info.test.ok ? info.test : {};
    return {
      ok: true,
      script: tst.script || null,
      pre: tst.pre || null,
      post: tst.post || null,
      checks: info.checks.map((c) => ({ name: c.name, script: c.script, pre: c.pre || null, post: c.post || null })),
    };
  });

  // rawScripts: 화면에서 고른 검사 이름 (없으면 예전처럼 test 하나). 이름만 받고, 실행할 스크립트 글은 package.json에서 읽는다
  ipcMain.handle('devtest:trial', async (_e, rawChanges, rawScripts) => {
    if (busy) return { ok: false, error: '이미 테스트를 실행하고 있습니다' };
    busy = true; // 확인 창·파일 읽기를 기다리는 동안 두 번째 실행이 끼어들지 않게 바로 잡아 둔다 (취소·오류에서도 finally가 푼다)
    try {
      const changes = R.checkTrialChanges(rawChanges);
      if (!changes) return { ok: false, error: '테스트할 수정안이 올바르지 않거나 너무 큽니다 (파일 200개 · 파일당 5MB · 전체 50MB까지)' };
      const info = await scriptInfo();
      if (!info.ok) return info;
      const wantTest = rawScripts === undefined || (Array.isArray(rawScripts) && rawScripts.includes('test'));
      if (wantTest && !info.test.ok) return info.test; // test를 고른 경우: 없으면 예전과 같은 이유로 거절
      const names = rawScripts === undefined ? ['test'] : R.checkScriptNames(rawScripts, info.checks.map((c) => c.name));
      if (!names) return { ok: false, error: t('devtest.badScripts') };
      const checks = names.map((n) => info.checks.find((c) => c.name === n));

      const scripts = checks.flatMap((c) => [c.pre && `pre${c.name}: ${c.pre}`, `${c.name}: ${c.script}`, c.post && `post${c.name}: ${c.post}`]).filter(Boolean);
      // 수정안이 실행 방식(package.json의 test 등 · 실행 영향 파일)을 바꾸면 "적용 후"에는 그것이 돈다 — 확인 창에 따로 보여 준다
      const withBefore = [];
      for (const c of changes) {
        const r = await project.readFile(c.path, { maxBytes: 5 * 1024 * 1024 }).catch(() => ({ missing: true }));
        withBefore.push({ ...c, before: r.missing ? null : typeof r.text === 'string' ? r.text : null });
      }
      const warn = R.trialWarnings(withBefore, executionRisk, names);
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
          `AI가 고친 코드(테스트 코드 포함)가 실제로 실행됩니다. 시간 제한 스크립트마다 ${R.TEST_TIMEOUT_MS / 60000}분.${warnText ? `\n${warnText}` : ''}\n\n폴더: ${root()}`,
      });
      if (response !== 0) return { ok: false, error: '취소했습니다', cancelled: true };

      // 결과: 고른 스크립트마다 { name, script, before, after } (v0.28.0). 예전 모양(script · before · after)은 test 것으로 함께 준다
      const results = checks.map((c) => ({ name: c.name, script: c.script, before: null, after: null }));
      const reply = (extra = {}) => {
        const test = results.find((x) => x.name === 'test');
        return { ok: true, scripts: names, results, script: test?.script || null, before: test?.before || null, after: test?.after || null, ...extra };
      };

      // 1) 적용 전: 스크립트마다 차례로 (중지하면 거기서 멈춘다)
      for (const r of results) {
        r.before = await runOnce(info.npmCli, 'before', info.nodeExe, r.name);
        if (r.before.stopped) return reply();
      }

      // 원본 읽기 (텍스트가 아니거나 너무 크면 테스트하지 않는다)
      const backup = [];
      for (const c of changes) {
        const r = await project.readFile(c.path, { maxBytes: 5 * 1024 * 1024 });
        if (r.missing) backup.push({ path: c.path, existed: false });
        else if (typeof r.text === 'string') backup.push({ path: c.path, existed: true, text: r.text });
        else return { ...reply(), ok: false, error: `${c.path}: ${r.binary ? '바이너리 파일' : '파일이 너무 큽니다'}라 테스트할 수 없습니다` };
      }
      // 2) 잠깐 써 두고 스크립트마다 실행 → 3) 무슨 일이 있어도 원래대로 (앱이 꺼져도 다음에 열 때 되돌리도록 먼저 적어 둔다)
      writeRecovery({ root: root(), at: Date.now(), files: backup });
      const restoreList = [];
      let restoreFailed = null;
      try {
        for (const c of changes) {
          restoreList.push(backup.find((b) => b.path === c.path));
          if (c.after === null) await project.deleteFile(c.path);
          else await project.writeFile(c.path, c.after);
        }
        for (const r of results) {
          r.after = await runOnce(info.npmCli, 'after', info.nodeExe, r.name);
          if (r.after.stopped) break;
        }
      } catch (err) {
        const failed = { ok: false, error: `임시 적용 실패: ${err.message}`, output: '' };
        for (const r of results) if (!r.after) r.after = failed;
      } finally {
        const failed = await restore(restoreList);
        if (!failed.length) clearRecovery();
        else {
          restoreFailed = failed;
          for (const r of results) if (r.after) r.after = { ...r.after, restoreFailed: failed };
        }
      }
      return reply(restoreFailed ? { restoreFailed } : {});
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
