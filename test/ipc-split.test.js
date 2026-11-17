'use strict';
// main.js IPC 나누기 (v0.24.0) 단위 테스트:  npm test
// [쉽게 말하면] 화면(preload.js)이 부르는 요청 이름마다 본체 어딘가(main.js · ipc/*.js · gitconsole · devtest)에
// 받는 곳이 정확히 한 번 있는지, ipc/ 파일이 가짜 ipcMain에 제 요청들을 등록하는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const read = (f) => fs.readFileSync(path.join(MAIN, f), 'utf8');
const MAIN_FILES = ['main.js', 'ipc/history.js', 'ipc/project.js', 'ipc/settings.js', 'ipc/chain.js', 'gitconsole.js', 'devtest.js', 'gitcommit.js'];

function handled() {
  const count = new Map();
  for (const f of MAIN_FILES) {
    for (const m of read(f).matchAll(/ipcMain\.(?:on|handle)\(\s*'([^']+)'/g)) count.set(m[1], (count.get(m[1]) || 0) + 1);
  }
  return count;
}

test('preload가 부르는 요청마다 본체에 받는 곳이 정확히 한 번 있다', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const used = new Set([...pre.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]));
  const count = handled();
  assert.ok(used.size >= 40);
  for (const ch of used) assert.equal(count.get(ch), 1, ch);
});

function fakeIpc() {
  const on = new Map();
  const handle = new Map();
  return {
    on: (ch, fn) => on.set(ch, fn),
    handle: (ch, fn) => handle.set(ch, fn),
    on_: on,
    handle_: handle,
  };
}

test('ipc/history: 기록 요청을 등록하고, 평가는 지금 라운드 기록에만', async () => {
  const ipcMain = fakeIpc();
  const calls = [];
  const history = {
    list: (q) => ['list', q],
    get: (id) => ['get', id],
    stats: () => 'stats',
    setFeedback: (...a) => (calls.push(a), a[2]),
    remove: () => {},
    clear: () => {},
  };
  let roundId = null;
  require('../src/main/ipc/history').register({ ipcMain, history, clipboard: {}, dialog: {}, app: {}, rounds: () => ({}), roundHistoryId: () => roundId, win: () => null });
  assert.deepEqual([...ipcMain.handle_.keys()].sort(), ['answer:copy', 'answer:get', 'answers:get', 'clipboard:write', 'embed:build', 'embed:status', 'embed:stop', 'file:save', 'history:archiveInfo', 'history:clear', 'history:delete', 'history:feedback', 'history:get', 'history:import', 'history:list', 'history:recommend', 'history:semantic', 'history:setStar', 'history:setTags', 'history:speed', 'history:stats', 'history:tags', 'history:thread']);
  assert.deepEqual(ipcMain.handle_.get('history:list')(null, 42), ['list', '']);
  assert.equal(ipcMain.handle_.get('history:feedback')(null, 'a', 1), null); // 라운드가 없으면 남기지 않음
  roundId = 'r1';
  assert.equal(ipcMain.handle_.get('history:feedback')(null, 'a', 5), null);
  assert.equal(ipcMain.handle_.get('history:feedback')(null, 'a', -1), -1);
  assert.deepEqual(calls, [['r1', 'a', -1]]);
  assert.deepEqual(await ipcMain.handle_.get('file:save')(null, { kind: 'exe', text: 'x' }), { ok: false, error: '저장할 내용이 올바르지 않습니다' });
});

test('ipc/project: 테스트 실행 중에는 쓰기를 거절하고, 오류는 { ok: false }로', async () => {
  const ipcMain = fakeIpc();
  let busy = true;
  let sidebar = null;
  const project = { writeFile: async () => 'written', info: () => null };
  require('../src/main/ipc/project').register({
    ipcMain,
    project,
    guard: {},
    prefs: () => ({}),
    savePrefs: () => {},
    pushState: () => {},
    win: () => null,
    devTest: () => ({ isBusy: () => busy }),
    gitConsole: () => null,
    setSidebarOpen: (v) => (sidebar = v),
  });
  const write = ipcMain.handle_.get('project:writeFile');
  assert.equal((await write(null, 'a.js', 'x')).ok, false);
  busy = false;
  assert.deepEqual(await write(null, 'a.js', 'x'), { ok: true, value: 'written' });
  assert.deepEqual(await ipcMain.handle_.get('project:loadState')(null), { ok: true, value: null });
  ipcMain.on_.get('layout:sidebar')(null, 1);
  assert.equal(sidebar, true);
});

test('ipc/settings: 고를 수 있는 값만 저장하고, 기록 최대 개수를 바꾸면 기록에도 알림', () => {
  const ipcMain = fakeIpc();
  const prefs = { answerTimeoutMin: 20, historyMax: 500, remoteSelectors: true, local: {} };
  const maxCalls = [];
  let saved = 0;
  require('../src/main/ipc/settings').register({
    ipcMain,
    history: { setMax: (n) => maxCalls.push(n) },
    remote: {},
    guard: {},
    net: {},
    shell: {},
    TIMEOUT_CHOICES: [5, 10, 20],
    MAX_CHOICES: [100, 500],
    prefs: () => prefs,
    savePrefs: () => saved++,
    pushState: () => {},
    allServices: () => [],
    refreshRemote: () => {},
    localChat: () => null,
    closeLocalPanel: () => {},
    focusId: () => null,
    setFocusId: () => {},
    updater: () => null,
    shortcutList: () => [],
    librarySaver: { current: () => undefined },
    readLibrary: () => ({}),
  });
  const set = ipcMain.on_.get('settings:set');
  set(null, { answerTimeoutMin: 7, historyMax: 3 });
  assert.equal(prefs.answerTimeoutMin, 20);
  assert.equal(prefs.historyMax, 500);
  set(null, { answerTimeoutMin: 10, historyMax: 100 });
  assert.equal(prefs.answerTimeoutMin, 10);
  assert.equal(prefs.historyMax, 100);
  assert.deepEqual(maxCalls, [100]);
  assert.equal(saved, 2);
  set(null, undefined); // 빈 요청에도 멈추지 않는다
});
