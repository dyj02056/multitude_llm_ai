'use strict';

// 앱 업데이트 (v0.20.0): 버전 비교 · 상태 정리 · 글 · 본체의 "알리기만" 규칙 · 빌드 설정
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const U = require('../src/shared/update-core');

test('버전 비교: 숫자 세 개, v 붙어도 됨, 읽을 수 없으면 같다고 봄', () => {
  assert.equal(U.compareVersions('0.20.1', '0.20.0'), 1);
  assert.equal(U.compareVersions('v0.19.10', '0.19.9'), 1); // 문자열이 아니라 숫자로
  assert.equal(U.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(U.compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(U.compareVersions('garbage', '1.0.0'), 0);
  assert.equal(U.isNewer('0.21.0-beta.1', '0.20.0'), true);
  assert.equal(U.isNewer('0.20.0', '0.20.0'), false);
  assert.deepEqual(U.parseVersion('1.2'), null);
});

test('상태 정리: 모르는 상태 · 이상한 값은 버림, 진행률은 0~100 정수', () => {
  const s = U.normalizeStatus({ state: 'hack', version: '<script>', percent: 140.6, error: 'x'.repeat(500) }, '0.20.0');
  assert.equal(s.state, 'idle');
  assert.equal(s.version, '');
  assert.equal(s.percent, 100);
  assert.equal(s.error.length, 200);
  assert.equal(s.current, '0.20.0');
  assert.equal(U.normalizeStatus({ state: 'available', version: 'v0.20.1' }, '0.20.0').version, '0.20.1');
});

test('상태 글 · 툴바 표시: Windows 앱은 다운로드 안내, 확장은 git pull 안내', () => {
  const win = U.normalizeStatus({ state: 'available', version: '0.20.1' }, '0.20.0');
  assert.match(U.statusText(win), /다운로드/);
  assert.equal(U.badgeText(win), 'update 0.20.1');
  const ext = U.normalizeStatus({ state: 'available', version: '0.20.1', canInstall: false }, '0.20.0');
  assert.match(U.statusText(ext), /git pull/);
  assert.equal(U.badgeText(U.normalizeStatus({ state: 'none' }, '0.20.0')), '');
  assert.match(U.statusText(U.normalizeStatus({ state: 'downloading', version: '0.20.1', percent: 42.4 }, '0.20.0')), /42%/);
  assert.match(U.statusText(U.normalizeStatus({ state: 'dev' }, '0.20.0')), /개발 실행/);
});

test('확장: package.json 글에서 버전 읽기', () => {
  assert.equal(U.versionFromPackage('{"version":"0.20.1"}'), '0.20.1');
  assert.equal(U.versionFromPackage('{"version":"x"}'), null);
  assert.equal(U.versionFromPackage('not json'), null);
});

/** 가짜 app · electron-updater로 src/main/updater.js를 돌린다 */
function fakeUpdater({ packaged = true } = {}) {
  const Module = require('module');
  const calls = [];
  const handlers = {};
  const autoUpdater = {
    on: (ev, fn) => (handlers[ev] = fn),
    checkForUpdates: async () => (calls.push('check'), handlers['update-available']?.({ version: '0.99.0' })),
    downloadUpdate: async () => (calls.push('download'), handlers['update-downloaded']?.({ version: '0.99.0' })),
    quitAndInstall: () => calls.push('install'),
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron-updater') return { autoUpdater };
    return orig.call(this, req, ...rest);
  };
  delete require.cache[require.resolve('../src/main/updater')];
  const { createUpdater } = require('../src/main/updater');
  const restore = () => (Module._load = orig); // updater.js는 electron-updater를 처음 확인할 때 읽는다 — 테스트가 끝날 때 되돌린다
  const states = [];
  const u = createUpdater({ app: { getVersion: () => '0.20.0', isPackaged: packaged }, isAuto: () => true, onChange: (s) => states.push(s.state) });
  return { u, calls, states, autoUpdater, restore };
}

test('본체: 새 버전은 알리기만 — 받기 · 설치는 누를 때만, 자동 받기 꺼짐', async (t) => {
  const { u, calls, states, autoUpdater, restore } = fakeUpdater();
  t.after(restore);
  await u.check();
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.deepEqual(calls, ['check']);
  assert.equal(u.status().state, 'available');
  assert.equal(u.install(), false); // 받기 전에는 설치하지 않는다
  await u.download();
  assert.equal(u.status().state, 'downloaded');
  assert.equal(u.install(), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['check', 'download', 'install']);
  assert.ok(states.includes('downloading'));
});

test('본체: 개발 실행(npm start)에서는 확인하지 않는다', async (t) => {
  const { u, calls, restore } = fakeUpdater({ packaged: false });
  t.after(restore);
  await u.check();
  assert.equal(u.status().state, 'dev');
  assert.deepEqual(calls, []);
});

test('빌드 설정: GitHub Releases 주소 · electron-updater는 앱에 들어가는 의존성 · 워크플로가 latest.yml을 올림', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.publish[0], { provider: 'github', owner: 'dyj02056', repo: 'multitude_llm_ai', releaseType: 'release' });
  assert.ok(pkg.dependencies['electron-updater']);
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(wf, /dist\/latest\.yml/);
  assert.match(wf, /\.exe\.blockmap/);
});
