// 보내기 전에 파일 내용에서 비밀 정보(API 키·토큰·개인 키)로 보이는 문자열을 찾는다.
// 걸린 파일은 기본으로 빼 두고, 사용자가 확인해야만 보낸다. 오탐이 있을 수 있어 "그래도 보내기"를 둔다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.secretScan)이 같이 쓴다.
//
// [쉽게 말하면] 파일 안에 비밀번호·API 키·개인 키 같은 "비밀 정보"가 들어 있는지 찾아 주는 탐지기입니다.
// 찾으면 화면에 ⚠ 비밀? 표시를 하고, AI에게 보내기 전에 한 번 더 묻습니다. (가끔 비밀이 아닌데 걸릴 수 있음)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).secretScan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PATTERNS = [
    { name: '개인 키', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
    { name: 'AWS 액세스 키', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { name: 'GitHub 토큰', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
    { name: 'GitLab 토큰', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
    { name: 'Slack 토큰', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: 'Google API 키', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { name: 'Stripe 키', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
    { name: 'API 키 (sk-)', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
    { name: '서비스 계정 키', re: /"private_key"\s*:\s*"-----BEGIN/ },
    { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
    {
      name: '비밀번호·토큰 대입',
      // password = "…" / api_key: '…' / SECRET_TOKEN=… (값이 8자 이상이고 예시 같은 값이 아닐 때)
      re: /\b[\w.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[\w.-]*\s*[:=]\s*["']?(?!(?:your|example|changeme|xxx|<|\$\{|process\.env|os\.environ))[^\s"'`,;]{8,}/i,
    },
  ];

  /** 비밀로 보이는 것: [{ name, line }] (최대 20개) */
  // 글 전체를 줄마다 검사해 [{ 종류 이름, 몇째 줄 }] 목록을 돌려줍니다.
  function scanSecrets(text) {
    const found = [];
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length && found.length < 20; i++) {
      for (const p of PATTERNS) {
        if (p.re.test(lines[i])) {
          found.push({ name: p.name, line: i + 1 });
          break;
        }
      }
    }
    return found;
  }

  /** "개인 키(3행), GitHub 토큰(10행)" */
  const describeSecrets = (found) => found.slice(0, 5).map((f) => `${f.name}(${f.line}행)`).join(', ') + (found.length > 5 ? ` 외 ${found.length - 5}개` : '');

  return { PATTERNS, scanSecrets, describeSecrets };
});
