// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/remote-core.js)
// 사이트 셀렉터 원격 갱신에서 받은 데이터를 검사하고 서비스 목록에 적용하는 부분.
// 받는 것은 CSS 셀렉터·정규식 "문자열"뿐이다. 코드는 받지도 실행하지도 않는다.
// 받아 오기·저장은 쓰는 쪽이 한다 (Electron: 파일 / 크롬 확장 프로그램: chrome.storage).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.remoteCore)이 같이 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).remoteCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_URL = 'https://raw.githubusercontent.com/dyj02056/multitude_llm_ai/main/remote/selectors.json';

  // 원격으로 바꿀 수 있는 필드와 모양.
  // 보안상 "읽기"에 쓰는 것(입력창·답변·중지·로그인 상태·첨부 확인 표시)과 그 서비스 도메인 안의 새 대화 주소만 받는다.
  // 페이지에서 무언가를 "누르거나 파일을 넣는" 셀렉터(보내기·로그인 버튼, 파일 선택 칸 등)는 원격으로 바꾸지 않는다 —
  // 원격 설정이 털려도 엉뚱한 버튼(공유·삭제 등)을 누르게 할 수 없도록. 이런 것은 앱 업데이트로만 바꾼다.
  const LIST_FIELDS = ['input', 'stop', 'response']; // 셀렉터 목록
  const STRING_FIELDS = ['newChatUrl'];
  const LOCKED_FIELDS = ['send', 'sendText', 'loginButton', 'submitKey']; // 원격에 있어도 무시한다
  const LOCKED_UPLOAD = ['methods', 'fileInput'];
  const MAX_ITEMS = 20;
  const MAX_LEN = 300;

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isStr = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_LEN;

  /**
   * 계산이 폭주할 수 있는 정규식(ReDoS) 모양인지: 반복 안에 반복 "(a+)+", 반복되는 선택 "(a|ab)*", 역참조 "\1".
   * 정확한 판정은 어렵지만, 셀렉터 갱신에 이런 모양이 필요할 일은 없어서 보수적으로 거절한다.
   */
  function riskyRegex(s) {
    return /\([^)]*[*+}][^)]*\)\s*[*+{?]/.test(s) || /\([^)]*\|[^)]*\)\s*[*+{]/.test(s) || /\\[1-9]/.test(s);
  }

  function validRegex(s) {
    if (!isStr(s) || riskyRegex(s)) return false;
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  }

  function validSelector(s) {
    // 셀렉터를 검사할 DOM이 없을 수 있어서 모양만 본다. 잘못된 셀렉터는 페이지에서 그냥 아무것도 못 찾는다.
    return isStr(s) && !/[{}]/.test(s);
  }

  /** 새 대화 주소는 https이고 그 서비스의 도메인(hosts)이어야 한다 */
  function validServiceUrl(u, svc) {
    if (!isStr(u) || !/^https:\/\//.test(u)) return false;
    try {
      const host = new URL(u).hostname;
      return (svc.hosts || []).some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  /** 원격 데이터 한 서비스 몫을 검사해서 쓸 수 있는 필드만 돌려준다. 받지 않은 필드는 ignored에 이름을 남긴다. */
  function sanitizeService(raw, svc, ignored) {
    if (!raw || typeof raw !== 'object') return null;
    const drop = (field) => ignored.push(`${svc.id}.${field}`);
    const out = { replace: raw.replace === true };
    for (const f of LOCKED_FIELDS) if (raw[f] !== undefined) drop(f);
    for (const f of LIST_FIELDS) {
      if (Array.isArray(raw[f])) out[f] = raw[f].filter(validSelector).slice(0, MAX_ITEMS);
    }
    if (raw.newChatUrl !== undefined) {
      if (validServiceUrl(raw.newChatUrl, svc)) out.newChatUrl = raw.newChatUrl;
      else drop('newChatUrl');
    }
    if (raw.messages && typeof raw.messages === 'object') {
      const m = raw.messages;
      if (validSelector(m.container) && validRegex(m.role) && validSelector(m.content)) {
        out.messages = { container: m.container, role: m.role, content: m.content };
      } else drop('messages');
    }
    if (raw.upload && typeof raw.upload === 'object') {
      const u = raw.upload;
      const up = {};
      for (const f of LOCKED_UPLOAD) if (u[f] !== undefined) drop(`upload.${f}`);
      if (Array.isArray(u.accept)) up.accept = u.accept.filter((x) => ['image', 'document'].includes(x)).slice(0, 2);
      for (const f of ['attached', 'busy']) {
        if (Array.isArray(u[f])) up[f] = u[f].filter(validSelector).slice(0, MAX_ITEMS);
      }
      if (Object.keys(up).length) out.upload = up;
    }
    if (raw.loggedOut && typeof raw.loggedOut === 'object') {
      const lo = {};
      for (const f of ['url', 'text']) {
        if (raw.loggedOut[f] === undefined) continue;
        if (validRegex(raw.loggedOut[f])) lo[f] = raw.loggedOut[f];
        else drop(`loggedOut.${f}`);
      }
      if (Array.isArray(raw.loggedOut.selectors)) lo.selectors = raw.loggedOut.selectors.filter(validSelector).slice(0, MAX_ITEMS);
      if (Object.keys(lo).length) out.loggedOut = lo;
    }
    return out;
  }

  /** 원격 데이터 전체를 검사한다. 형식이 틀리면 null. 모르는 서비스는 버린다. */
  function sanitize(data, services) {
    if (!data || typeof data !== 'object' || !Number.isInteger(data.version)) return null;
    const overrides = {};
    const ignored = [];
    for (const [id, raw] of Object.entries(data.services || {})) {
      const svc = services.find((x) => x.id === id);
      if (!svc) continue;
      const clean = sanitizeService(raw, svc, ignored);
      if (clean) overrides[id] = clean;
    }
    return { version: data.version, updated: isStr(data.updated) ? data.updated : '', overrides, ignored };
  }

  /** 앱에 들어 있던 값 (원격 갱신을 끄거나 다시 적용할 때 되돌릴 기준). Map(id -> 필드들) */
  function snapshotBase(services) {
    return new Map(
      services.map((s) => [
        s.id,
        Object.fromEntries([...LIST_FIELDS, ...STRING_FIELDS, 'messages', 'loggedOut', 'upload'].map((f) => [f, clone(s[f])])),
      ]),
    );
  }

  /**
   * 덮어쓰기를 적용한다. 셀렉터 목록은 원격 것을 앞에 두고 앱에 들어 있던 것을 뒤에 남긴다
   * (원격 셀렉터가 틀려도 예전 셀렉터로 계속 찾을 수 있게). replace: true면 원격 목록만 쓴다.
   */
  function apply(services, base, overrides) {
    for (const svc of services) {
      const b = base.get(svc.id);
      for (const [k, v] of Object.entries(b)) svc[k] = clone(v);
      const o = overrides[svc.id];
      if (!o) continue;
      for (const f of LIST_FIELDS) {
        if (!o[f]) continue;
        svc[f] = o.replace ? [...o[f]] : [...new Set([...o[f], ...(b[f] || [])])];
      }
      for (const f of [...STRING_FIELDS, 'messages']) if (o[f]) svc[f] = clone(o[f]);
      if (o.loggedOut) svc.loggedOut = { ...(b.loggedOut || {}), ...clone(o.loggedOut) };
      // methods·fileInput은 원격으로 바뀌지 않는다 (sanitize에서 이미 뺐다)
      if (o.upload) svc.upload = { ...(b.upload || {}), ...clone(o.upload) };
    }
  }

  return { DEFAULT_URL, sanitize, snapshotBase, apply, riskyRegex };
});
