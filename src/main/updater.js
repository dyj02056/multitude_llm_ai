'use strict';

// Windows 앱 자동 업데이트 (v0.20.0) — electron-updater로 GitHub Releases의 latest.yml을 본다.
//
// [쉽게 말하면]
//   - 앱을 켜고 30초 뒤, 그다음 6시간마다 새 버전이 있는지만 확인합니다 (설정에서 끌 수 있음).
//   - 새 버전이 있으면 알리기만 하고, 사용자가 [다운로드]를 눌러야 받습니다. 질문을 보내는 중에 앱이 꺼지지 않게
//     설치도 [다시 시작해서 설치]를 누를 때 하고, 그냥 앱을 닫으면 그때 설치됩니다.
//   - 개발 실행(npm start)에서는 확인하지 않습니다.
//   - 코드 서명이 없어 서명 검사는 하지 않습니다. 받은 파일은 GitHub Releases(HTTPS)의 latest.yml에 적힌
//     해시(sha512)와 맞을 때만 설치됩니다 (electron-updater가 검사).
const U = require('../shared/update-core');

/**
 * opts: { app, isAuto(): 자동 확인을 켰는지, onChange(status), log }
 * → { status(), check(manual), download(), install(), start(), stop() }
 */
function createUpdater({ app, isAuto, onChange, log = () => {} }) {
  const current = app.getVersion();
  let st = U.normalizeStatus({ state: app.isPackaged ? 'idle' : 'dev' }, current);
  let updater = null;
  let timers = [];

  const set = (patch) => {
    st = U.normalizeStatus({ ...st, ...patch }, current);
    onChange(st);
  };

  function load() {
    if (updater || !app.isPackaged) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = false; // 알리기만 한다
    updater.autoInstallOnAppQuit = true; // 받아 둔 것은 앱을 닫을 때 설치
    updater.allowPrerelease = false;
    updater.logger = { info: (m) => log('update', m), warn: (m) => log('update', m), error: (m) => log('update', m), debug: () => {} };
    updater.on('checking-for-update', () => set({ state: 'checking', error: '' }));
    updater.on('update-available', (info) => set({ state: 'available', version: info?.version, checkedAt: Date.now() }));
    updater.on('update-not-available', () => set({ state: 'none', checkedAt: Date.now() }));
    updater.on('download-progress', (p) => set({ state: 'downloading', percent: p?.percent }));
    updater.on('update-downloaded', (info) => set({ state: 'downloaded', version: info?.version || st.version, percent: 100 }));
    updater.on('error', (err) => set({ state: 'error', error: err?.message || String(err), checkedAt: Date.now() }));
    return updater;
  }

  async function check() {
    if (!app.isPackaged) return set({ state: 'dev' }), st;
    if (['checking', 'downloading', 'downloaded'].includes(st.state)) return st;
    try {
      await load().checkForUpdates();
    } catch (err) {
      set({ state: 'error', error: err.message, checkedAt: Date.now() });
    }
    return st;
  }

  async function download() {
    if (st.state !== 'available') return st;
    set({ state: 'downloading', percent: 0 });
    try {
      await load().downloadUpdate();
    } catch (err) {
      set({ state: 'error', error: err.message });
    }
    return st;
  }

  function install() {
    if (st.state !== 'downloaded') return false;
    setImmediate(() => updater.quitAndInstall(false, true)); // 설치 화면을 보여 주고, 끝나면 앱을 다시 켠다
    return true;
  }

  function start() {
    stop();
    if (!app.isPackaged) return;
    timers.push(setTimeout(() => isAuto() && check(), U.FIRST_CHECK_MS));
    timers.push(setInterval(() => isAuto() && check(), U.CHECK_EVERY_MS));
  }

  function stop() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  return { status: () => st, check, download, install, start, stop };
}

module.exports = { createUpdater };
