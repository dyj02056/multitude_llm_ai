// 앱 업데이트 (v0.20.0): 버전 비교 · 상태 글 · 알릴지 판단. Windows 앱(src/main/updater.js) · 크롬 확장(extension/host.js) · 테스트가 같이 쓴다.
//
// [쉽게 말하면]
//   - Windows 앱: GitHub Releases에 새 버전이 올라오면 알려 주고, 사용자가 누를 때만 받고 · 설치합니다 (자동 설치 없음).
//   - 크롬 확장: 압축해제 방식이라 스스로 바꿀 수 없어서, GitHub main의 package.json 버전만 보고 "새 버전 있음"을 알립니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).update = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 화면 문구 (v0.30.0): 부를 때마다 사전에서 찾는다 (언어를 바꾸면 바로 반영). 사전이 없는 곳(서비스 페이지 등)에서는 키 이름 그대로
  const t = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };

  const REPO = 'dyj02056/multitude_llm_ai';
  const RELEASES_URL = `https://github.com/${REPO}/releases`;
  // 크롬 확장이 보는 최신 버전 (이미 쓰는 raw.githubusercontent.com — 권한 · CSP를 더 받지 않는다)
  const PACKAGE_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
  const FIRST_CHECK_MS = 30 * 1000; // 앱을 켜고 이만큼 뒤 첫 확인 (시작을 느리게 하지 않게)
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
  const STATES = ['idle', 'dev', 'checking', 'none', 'available', 'downloading', 'downloaded', 'error'];

  /** "1.2.3" · "v1.2.3" → [1, 2, 3] | null (숫자 세 개만 받는다, 뒤의 -beta 등은 버림) */
  function parseVersion(v) {
    const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(String(v || '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  /** a가 b보다 새것이면 1, 같으면 0, 옛것이면 -1. 읽을 수 없으면 0 */
  function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return 0;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
  }

  const isNewer = (latest, current) => compareVersions(latest, current) > 0;

  /** 업데이트 상태 정리 (본체가 화면에 보내기 전에) */
  function normalizeStatus(s, current) {
    const o = s && typeof s === 'object' ? s : {};
    const state = STATES.includes(o.state) ? o.state : 'idle';
    const percent = Number.isFinite(o.percent) ? Math.max(0, Math.min(100, Math.round(o.percent))) : null;
    return {
      state,
      current: String(current || o.current || ''),
      version: parseVersion(o.version) ? String(o.version).replace(/^v/, '') : '',
      percent,
      error: o.error ? String(o.error).slice(0, 200) : '',
      checkedAt: Number.isFinite(o.checkedAt) ? o.checkedAt : null,
      canInstall: o.canInstall !== false, // 크롬 확장은 false (직접 git pull)
    };
  }

  /** 설정 화면 · 상태줄에 보일 글 */
  function statusText(s) {
    switch (s.state) {
      case 'dev':
        return t('main.update.dev', { v: s.current });
      case 'checking':
        return t('main.update.checking');
      case 'none':
        return t('main.update.none', { v: s.current });
      case 'available':
        return s.canInstall
          ? t('main.update.availableApp', { v: s.version })
          : t('main.update.availableExt', { v: s.version });
      case 'downloading':
        return t('main.update.downloading', { v: s.version, percent: s.percent ?? 0 });
      case 'downloaded':
        return t('main.update.downloaded', { v: s.version });
      case 'error':
        return t('main.update.error', { error: s.error || t('main.update.unknownError') });
      default:
        return t('main.update.current', { v: s.current });
    }
  }

  /** 툴바 상태줄에 띄울 짧은 표시 (없으면 '') */
  function badgeText(s) {
    if (s.state === 'available') return `update ${s.version}`;
    if (s.state === 'downloading') return `update ${s.percent ?? 0}%`;
    if (s.state === 'downloaded') return 'update ready';
    return '';
  }

  /** 크롬 확장: GitHub main의 package.json 내용 → 최신 버전 문자열 | null */
  function versionFromPackage(text) {
    try {
      const v = JSON.parse(String(text)).version;
      return parseVersion(v) ? String(v) : null;
    } catch {
      return null;
    }
  }

  return { REPO, RELEASES_URL, PACKAGE_URL, FIRST_CHECK_MS, CHECK_EVERY_MS, parseVersion, compareVersions, isNewer, normalizeStatus, statusText, badgeText, versionFromPackage };
});
