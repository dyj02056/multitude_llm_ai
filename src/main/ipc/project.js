'use strict';

// 화면 요청(IPC) — 프로젝트 모드: 폴더 고르기 · 다시 열기 · 닫기 · 파일 읽기/쓰기/지우기 · 상태 저장 (v0.24.0에서 main.js에서 옮김).
// 로컬 폴더 읽기·쓰기는 main/project.js, 처리는 화면 쪽 공통 모듈이 한다. main.js가 register(ctx)로 연결한다.
//
// [쉽게 말하면] 프로젝트 사이드바가 "폴더 열어 줘", "이 파일 읽어 줘/써 줘" 할 때 처리하는 곳입니다.
// 테스트 실행이 수정안을 잠깐 써 둔 동안에는 파일을 바꾸는 요청을 받지 않습니다.

const { t } = require('../../shared/i18n');

/** 성공하면 { ok: true, value }, 오류가 나면 { ok: false, error } — 오류가 나도 앱이 멈추지 않고 화면이 이유를 보여 줄 수 있게 */
const projectCall = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

/**
 * ctx: { ipcMain, project, guard, prefs(), savePrefs, pushState, win(), devTest(), gitConsole(), setSidebarOpen(open) }
 */
function register(ctx) {
  const { ipcMain, project, guard } = ctx;

  // 프로젝트 사이드바가 열리고 닫힐 때: 패널 자리를 사이드바 폭만큼 비우거나 되돌립니다.
  ipcMain.on('layout:sidebar', (_e, open) => {
    ctx.setSidebarOpen(!!open);
    ctx.pushState();
  });

  /** 프로젝트를 열 때: 지난번 "테스트 실행" 도중 앱이 꺼져 남은 임시 적용이 있으면 원래 파일로 되돌리고 몇 개인지 알린다 */
  async function withRecovery(p) {
    const devTest = ctx.devTest();
    if (!p || !devTest) return p;
    const recovered = await devTest.recover().catch(() => 0);
    return recovered ? { ...p, recovered } : p;
  }

  /** 마지막으로 연 프로젝트 폴더를 설정에 기억합니다 (다음에 앱을 켜면 자동으로 다시 열기 위해). */
  async function rememberProject(p) {
    ctx.prefs().projectRoot = p ? p.id : null;
    ctx.savePrefs();
    return withRecovery(p);
  }

  // 테스트 실행이 수정안을 잠깐 써 둔 동안에는 화면에서 오는 쓰기·지우기와 프로젝트 바꾸기·닫기를 받지 않는다 (끝나면 원래 파일로 되돌리므로)
  const notDuringTest = () => {
    if (ctx.devTest()?.isBusy()) throw new Error(t('main.busyTest'));
  };

  ipcMain.handle('project:pick', projectCall(async () => {
    notDuringTest();
    const picked = await project.pick(ctx.win());
    if (!picked) return null; // 폴더 고르기를 취소하면 지금 기억해 둔 프로젝트를 지우지 않는다
    ctx.gitConsole()?.stop();
    return rememberProject(picked);
  }));
  // Windows 앱은 접근 허용을 다시 받을 필요가 없어 restore·reconnect가 같다.
  const restoreProject = async () => {
    const root = ctx.prefs().projectRoot;
    if (!root) return null;
    try {
      return await withRecovery(await project.open(root));
    } catch {
      return rememberProject(null); // 폴더가 없어졌으면 잊는다
    }
  };
  ipcMain.handle('project:restore', projectCall(restoreProject));
  ipcMain.handle('project:reconnect', projectCall(restoreProject));
  ipcMain.handle('project:close', projectCall(async () => {
    notDuringTest();
    ctx.gitConsole()?.stop(); // 실행 중인 git 명령은 그 폴더와 함께 멈춘다
    project.close();
    await rememberProject(null);
    return true;
  }));
  ipcMain.handle('project:readDir', projectCall((rel) => project.readDir(String(rel))));
  // 읽기 한도(maxBytes)는 앱 쪽 최대값(project.READ_MAX_BYTES)을 넘지 못하게 자르고, 그 밖의 옵션은 버린다
  ipcMain.handle('project:readFile', projectCall((rel, opts) => project.readFile(String(rel), guard.readFileOpts(opts, project.READ_MAX_BYTES))));
  ipcMain.handle('project:writeFile', projectCall((rel, text) => (notDuringTest(), project.writeFile(String(rel), text))));
  ipcMain.handle('project:deleteFile', projectCall((rel) => (notDuringTest(), project.deleteFile(String(rel)))));
  ipcMain.handle('project:globalExclude', projectCall(() => project.globalExclude()));
  ipcMain.handle('project:loadState', projectCall(() => (project.info() ? project.loadState(project.info().id) : null)));
  ipcMain.handle('project:saveState', projectCall((data) => (project.info() ? project.saveState(project.info().id, data) : false)));
}

module.exports = { register, projectCall };
