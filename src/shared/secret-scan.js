// 보내기 전에 파일 내용에서 비밀 정보(API 키·토큰·개인 키)로 보이는 문자열을 찾는다.
// 걸린 파일은 기본으로 빼 두고, 사용자가 확인해야만 보낸다. 오탐이 있을 수 있어 "그래도 보내기"를 둔다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.secretScan)이 같이 쓴다.
// PATTERNS는 git·테스트 출력 가리기(src/main/git-rules.js maskOutput)에서도 쓴다:
//   - maskOutput은 re에 g 플래그를 붙여 "맞은 부분 전체"를 앞 4글자만 남기고 가린다.
//   - 그래서 키 이름은 남기고 값만 가리고 싶은 규칙은 뒤보기((?<=…))로 "값만" 맞게 만든다.
//   - re에는 g 플래그를 붙이지 않는다(test()가 lastIndex를 기억해 엉뚱하게 빠지는 일을 막기 위해).
//
// [쉽게 말하면] 파일 안에 비밀번호·API 키·개인 키 같은 "비밀 정보"가 들어 있는지 찾아 주는 탐지기입니다.
// 찾으면 화면에 ⚠ 비밀? 표시를 하고, AI에게 보내기 전에 한 번 더 묻습니다. (가끔 비밀이 아닌데 걸릴 수 있음)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).secretScan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 순서가 중요하다: 한 줄에서 같은 자리를 여러 규칙이 잡으면 앞의 (더 구체적인) 규칙만 보고한다.
  // checkValue: true 인 규칙은 맞은 값이 예시·자리표시 값(xxx, <...>, ${VAR}, changeme…)이면 보고하지 않는다.
  //   값은 첫 번째 괄호 묶음(있으면), 없으면 맞은 부분 전체.
  const PATTERNS = [
    { name: '개인 키', label: 'project.secret.privateKey', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
    { name: 'AWS 액세스 키', label: 'project.secret.aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { name: 'GitHub 토큰', label: 'project.secret.github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
    { name: 'GitLab 토큰', label: 'project.secret.gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
    { name: 'Slack 토큰', label: 'project.secret.slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: 'Google API 키', label: 'project.secret.google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { name: 'Stripe 키', label: 'project.secret.stripe', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
    // sk-ant- / sk-proj- 는 아래 전용 규칙이 잡는다(예전 'API 키 (sk-)'가 잡던 길이 그대로: sk- 뒤 20자 이상).
    { name: 'Anthropic API 키', label: 'project.secret.anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
    { name: 'OpenAI 프로젝트 키', label: 'project.secret.openaiProject', re: /\bsk-proj-[A-Za-z0-9_-]{15,}\b/ },
    { name: 'API 키 (sk-)', label: 'project.secret.skKey', re: /\bsk-(?!ant-|proj-)[A-Za-z0-9_-]{20,}\b/ },
    { name: 'npm 토큰', label: 'project.secret.npm', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
    // DefaultEndpointsProtocol=…;AccountName=…;AccountKey=<base64> → 키 값만 가린다
    { name: 'Azure 저장소 연결 문자열', label: 'project.secret.azure', re: /(?<=\bAccountKey=)[A-Za-z0-9+/]{40,}={0,2}/ },
    { name: '서비스 계정 키', label: 'project.secret.serviceAccount', re: /"private_key"\s*:\s*"-----BEGIN/ },
    { name: 'JWT', label: 'project.secret.jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
    // Authorization: Bearer <토큰> → 토큰 값만 가린다 (JWT면 위의 JWT 규칙이 먼저 잡는다)
    {
      name: 'Bearer 토큰', label: 'project.secret.bearer',
      re: /(?<=\bAuthorization["']?\s*[:=]\s*["']?Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/i,
      checkValue: true,
    },
    {
      name: '비밀번호·토큰 대입', label: 'project.secret.assignment',
      // password = "…" / api_key: '…' / SECRET_TOKEN=… (값이 8자 이상이고 예시 같은 값이 아닐 때)
      // git 출력 가리기에서는 이름으로 빼고 쓴다(git-rules.js). 값은 괄호 묶음 1.
      re: /\b[\w.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[\w.-]*\s*[:=]\s*["']?(?!(?:your|example|changeme|xxx|<|\$\{|process\.env|os\.environ))([^\s"'`,;]{8,})/i,
      checkValue: true,
    },
    {
      name: '환경 변수 비밀 대입', label: 'project.secret.envAssignment',
      // DB_PASSWORD=… / export API_KEY="…" / "GH_TOKEN": "…" — 이름이 대문자이고 SECRET·TOKEN·PASSWORD·PASSWD·PASS·
      // API_KEY·ACCESS_KEY·PRIVATE_KEY로 끝나는 대입. 뒤보기로 "값만" 맞으므로 출력 가리기에서도 이름은 남는다.
      re: /(?<=\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|API_KEY|ACCESS_KEY|PRIVATE_KEY)["']?\s*[:=]\s*["']?)(?![<$%{*]|[xX]{3}|process\.env|os\.environ|os\.getenv)[^\s"'`,;]{8,}/,
      checkValue: true,
    },
  ];

  const MAX_FOUND = 20;

  /** 예시·자리표시 값인가 (xxx, ****, <...>, ${VAR}, changeme, your_…, example, dummy, test, process.env… 등) */
  function isPlaceholder(value) {
    const s = String(value).replace(/^["'`]+|["'`]+$/g, '').toLowerCase();
    if (s.length < 8) return true; // 빈 값·너무 짧은 값
    if (/^(.)\1*$/.test(s)) return true; // aaaaaaaa, ********
    if (/\*{3,}|x{3,}|\.{3}|<[^>]*>|\$\{|\{\{|^\$|^%.*%$/.test(s)) return true; // ***, xxx, ..., <토큰>, ${VAR}, {{v}}, $VAR, %VAR%
    if (/process\.env|os\.environ|getenv|import\.meta\.env|\(/.test(s)) return true; // 환경 변수 읽기·함수 호출
    // 예시 낱말은 앞뒤가 영문자가 아닐 때만 (latest·contest·protest 같은 실제 값 안의 글자는 무시)
    if (/(?:^|[^a-z])your[_-]/.test(s)) return true;
    // 예시 낱말만 이어 붙인 값 (dummydummy, testtest123)
    if (/^(?:(?:example|dummy|placeholder|changeme|sample|fake|redacted|test|secret|token|password|pass)[\d_.-]*)+$/.test(s)) return true;
    if (/(?:^|[^a-z])(?:example|dummy|placeholder|changeme|change_me|change-me|yourpass|yourtoken|yourkey|sample|fake|redacted|test)(?=[^a-z]|$)/.test(s)) return true;
    return /^(?:undefined|null|none|true|false)$/.test(s);
  }

  // 한 줄에서 모든 맞은 자리를 찾기 위한 g 복사본 (PATTERNS의 re는 그대로 둔다)
  const GLOBAL = new Map();
  const globalRe = (re) => {
    let g = GLOBAL.get(re);
    if (!g) GLOBAL.set(re, (g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)));
    return g;
  };

  const overlaps = (spans, a, b) => spans.some(([s, e]) => a < e && s < b);

  /**
   * 비밀로 보이는 것: [{ name, line }] (최대 20개, 줄 순서)
   * - 한 줄에 서로 다른 종류가 있으면 모두 보고한다(같은 종류는 줄마다 한 번). 같은 자리를 여러 규칙이 잡으면 앞 규칙만.
   * - 글 전체를 검사한 뒤 20개로 자른다. 이때 종류마다 하나씩(가장 앞 줄)을 먼저 넣고, 남는 자리를 줄 순서대로 채운다.
   *   (앞쪽에 같은 종류 20개가 있어도 뒤쪽의 다른 종류가 빠지지 않게)
   */
  // 글 전체를 줄마다 검사해 [{ 종류 이름, 몇째 줄 }] 목록을 돌려줍니다.
  function scanSecrets(text) {
    const all = [];
    const seenNames = new Set();
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length < 8) continue; // 어떤 규칙도 이보다 짧은 줄에선 맞지 않는다
      let spans = null; // 이 줄에서 이미 보고한 자리
      for (const p of PATTERNS) {
        if (!p.re.test(line)) continue; // 대부분의 줄은 여기서 끝난다
        const g = globalRe(p.re);
        g.lastIndex = 0;
        let hit = false;
        let m;
        while ((m = g.exec(line))) {
          if (m[0] === '') { g.lastIndex++; continue; }
          const a = m.index, b = a + m[0].length;
          if (spans && overlaps(spans, a, b)) continue;
          if (p.checkValue && isPlaceholder(m[1] !== undefined ? m[1] : m[0])) continue;
          (spans = spans || []).push([a, b]);
          hit = true;
        }
        if (hit) {
          all.push({ name: p.name, line: i + 1 });
          seenNames.add(p.name);
        }
      }
      // 이미 20개 넘게 모았고 모든 종류가 나왔으면 더 볼 필요가 없다
      if (all.length >= MAX_FOUND && seenNames.size === PATTERNS.length) break;
    }
    if (all.length <= MAX_FOUND) return all;
    // 종류마다 첫 번째를 먼저, 그다음 줄 순서대로 채운다
    const pick = new Set();
    const firstOf = new Set();
    for (let k = 0; k < all.length && pick.size < MAX_FOUND; k++) {
      if (!firstOf.has(all[k].name)) { firstOf.add(all[k].name); pick.add(k); }
    }
    for (let k = 0; k < all.length && pick.size < MAX_FOUND; k++) pick.add(k);
    return [...pick].sort((x, y) => x - y).map((k) => all[k]);
  }

  // 화면 문구 (i18n-*-project.js). 프로젝트 사전을 읽지 않는 화면(확장 사이드 패널)에서는 키 대신 한국어 글(fallback)을 쓴다.
  const tr = (key, vars, fallback) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    const s = i18n ? i18n.t(key, vars) : key;
    if (s !== key) return s;
    return String(fallback).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
  };
  const LABEL_OF = new Map(PATTERNS.map((p) => [p.name, p.label]));
  /** 규칙 이름(name — git-rules.js 등이 비교에 쓰는 한국어 이름) → 화면에 보일 이름 */
  const labelOf = (name) => (LABEL_OF.has(name) ? tr(LABEL_OF.get(name), null, name) : name);

  /** "개인 키(3행), GitHub 토큰(10행)" */
  const describeSecrets = (found) =>
    found.slice(0, 5).map((f) => tr('project.secret.at', { name: labelOf(f.name), line: f.line }, '{name}({line}행)')).join(', ') +
    (found.length > 5 ? tr('project.secret.more', { n: found.length - 5 }, ' 외 {n}개') : '');

  return { PATTERNS, scanSecrets, describeSecrets, isPlaceholder, labelOf };
});
