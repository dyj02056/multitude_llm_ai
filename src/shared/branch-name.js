// 새 브랜치 이름 규칙 (v0.34.0): "새 브랜치에 적용" 창의 이름 제안과, 메인(commit-rules.js)이 다시 하는 검사가 같은 규칙을 쓰도록 공유 모듈로 둔다.
// 이름은 항상 "mla/"로 시작하는 짧은 글자만(영문 · 숫자 · . _ -) — 다른 브랜치로 옮겨 가거나 옵션처럼 보이는 이름을 만들지 못하게.
// Electron 앱(require)과 화면(전역 MLA.branchName)이 같이 쓴다.
//
// [쉽게 말하면] "mla/20261117-claude" 같은 새 브랜치 이름을 제안하고, 이름이 안전한 모양인지 확인하는 부품입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).branchName = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (i18n) {
  'use strict';

  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);
  const BRANCH_RE = /^mla\/[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

  /** 이름 검사 → { ok: true, name } | { ok: false, error } (.. · 끝의 . · .lock · -- 도 거절) */
  function checkBranchName(raw) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!BRANCH_RE.test(name) || name.includes('..') || /\.$|\.lock$/.test(name) || name.includes('--')) return { ok: false, error: t('commit.badBranch') };
    return { ok: true, name };
  }

  /** 이름 제안: mla/20261117-claude (label은 영문 · 숫자만 남기고 소문자로, 없으면 "change") */
  function suggestBranchName({ date = new Date(), label = '' } = {}) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const slug = String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/g, '');
    return `mla/${ymd}-${slug || 'change'}`;
  }

  return { checkBranchName, suggestBranchName };
});
