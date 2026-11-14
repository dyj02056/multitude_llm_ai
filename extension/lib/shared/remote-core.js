// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/remote-core.js)
// 사이트 셀렉터 원격 갱신에서 받은 데이터를 검사하고 서비스 목록에 적용하는 부분.
// 받는 것은 CSS 셀렉터·정규식 "문자열"뿐이다. 코드는 받지도 실행하지도 않는다.
// 받아 오기·저장은 쓰는 쪽이 한다 (Electron: 파일 / 크롬 확장 프로그램: chrome.storage).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.remoteCore)이 같이 쓴다.
//
// [쉽게 말하면] 인터넷에서 받은 "새 셀렉터 목록"이 안전한지 검사하고 적용하는 파일입니다.
// 믿을 수 없는 값(너무 긴 글자, 컴퓨터를 멈추게 할 수 있는 정규식, 서비스 밖 주소 등)은 버립니다.
// 보안상 중요한 항목(보내기 버튼·로그인 화면 주소 등)은 인터넷 값으로 바꾸지 않습니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).remoteCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_URL = 'https://raw.githubusercontent.com/dyj02056/multitude_llm_ai/main/remote/selectors.json';

  // 셀렉터 파일 서명 (Ed25519). selectors.json 옆의 selectors.json.sig에 저장소 주인 키로 만든 서명이 있다.
  // 공개 키(32바이트를 base64로)가 비어 있으면 서명 확인을 하지 않는다 (예전 동작).
  // 키가 들어 있으면 받은 파일 바이트 그대로에 맞는 서명이 있을 때만 적용한다 —
  // GitHub 계정·저장소가 털려도 개인 키 없이는 셀렉터를 바꿀 수 없게.
  // 이 줄은 scripts/selectors-keygen.js가 그대로 찾아 바꾼다 (모양을 바꾸지 말 것).
  const SELECTORS_PUBLIC_KEY = '';
  const SIG_URL = DEFAULT_URL + '.sig';
  const SIG_ERROR = '서명이 맞지 않습니다';

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
    // 사용 한도 안내 문구 (서비스 화면 문구가 바뀌면 원격으로 고친다). 위험한 정규식은 받지 않는다.
    if (raw.limitText !== undefined) {
      if (validRegex(raw.limitText)) out.limitText = raw.limitText;
      else drop('limitText');
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
        Object.fromEntries([...LIST_FIELDS, ...STRING_FIELDS, 'messages', 'loggedOut', 'upload', 'limitText'].map((f) => [f, clone(s[f])])),
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
      for (const f of [...STRING_FIELDS, 'messages', 'limitText']) if (o[f]) svc[f] = clone(o[f]);
      if (o.loggedOut) svc.loggedOut = { ...(b.loggedOut || {}), ...clone(o.loggedOut) };
      // methods·fileInput은 원격으로 바뀌지 않는다 (sanitize에서 이미 뺐다)
      if (o.upload) svc.upload = { ...(b.upload || {}), ...clone(o.upload) };
    }
  }

  // ---------- 서명 확인 ----------
  // 어느 환경에서나 쓰도록 암호 기능은 쓰는 쪽이 넘긴다 (Electron: node:crypto / 확장: crypto.subtle).

  function b64ToBytes(b64) {
    const bin = atob(String(b64).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  const toBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

  function verdict(good) {
    return good === true ? { ok: true } : { ok: false, error: SIG_ERROR };
  }

  /**
   * 받은 파일 바이트(bytes)와 서명(sigB64)을 확인한다. verifier(bytes, sig, publicKeyB64)는 true/false(또는 그 Promise)를 돌려준다.
   * - 공개 키가 비어 있으면 확인하지 않는다: { ok: true, unsigned: true }
   * - 서명이 없거나 틀리거나 확인 중 오류가 나면: { ok: false, error: '서명이 맞지 않습니다', detail }
   * verifier가 동기면 결과도 동기로, Promise면 Promise로 돌려준다 (Electron 시작 때 캐시는 동기로 확인).
   * publicKey는 시험용으로만 넘긴다. 앱은 SELECTORS_PUBLIC_KEY를 쓴다.
   */
  function verify(bytes, sigB64, verifier, publicKey = SELECTORS_PUBLIC_KEY) {
    if (!publicKey) return { ok: true, unsigned: true };
    const fail = (err) => ({ ok: false, error: SIG_ERROR, detail: err ? String(err.message || err) : '' });
    try {
      if (typeof sigB64 !== 'string' || !sigB64.trim()) return fail('서명 없음');
      const sig = b64ToBytes(sigB64);
      if (sig.length !== 64) return fail('서명 길이가 맞지 않음');
      const r = verifier(toBytes(bytes), sig, publicKey);
      if (r && typeof r.then === 'function') return r.then(verdict, fail);
      return verdict(r);
    } catch (err) {
      return fail(err);
    }
  }

  /** node:crypto로 확인하는 verifier (Electron 본체). 공개 키 32바이트를 JWK(OKP/Ed25519)로 읽는다. */
  function nodeVerifier(nodeCrypto) {
    return (bytes, sig, publicKeyB64) => {
      const x = String(publicKeyB64).trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const key = nodeCrypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
      return nodeCrypto.verify(null, bytes, key, sig);
    };
  }

  /** WebCrypto(crypto.subtle)로 확인하는 verifier (크롬 확장). Ed25519를 지원하지 않는 크롬이면 오류 → 실패로 본다. */
  function subtleVerifier(subtle) {
    return async (bytes, sig, publicKeyB64) => {
      const key = await subtle.importKey('raw', b64ToBytes(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
      return subtle.verify({ name: 'Ed25519' }, key, sig, bytes);
    };
  }

  /** 받은 바이트를 JSON으로 읽는다 (서명 확인은 이 전에 바이트 그대로 한다). */
  function parseBytes(bytes) {
    return JSON.parse(new TextDecoder('utf-8').decode(toBytes(bytes)));
  }

  /**
   * 저장해 둘 캐시 모양: { format: 2, data: 파일 바이트 base64, sig: 서명 base64 }.
   * 다음 실행 때 같은 확인을 다시 하려고 바이트와 서명을 그대로 둔다.
   */
  function packCache(bytes, sigB64) {
    return { format: 2, data: bytesToB64(toBytes(bytes)), sig: typeof sigB64 === 'string' ? sigB64.trim() : '' };
  }

  /**
   * 저장해 둔 캐시를 꺼낸다: { bytes, sig } 또는 null.
   * 예전 버전이 쓴 캐시(셀렉터 JSON 그대로, 서명 없음)는 공개 키가 있으면 버리고(null → 내장 값), 없으면 예전처럼 쓴다.
   */
  function unpackCache(cached, publicKey = SELECTORS_PUBLIC_KEY) {
    if (!cached || typeof cached !== 'object') return null;
    if (cached.format === 2 && typeof cached.data === 'string') {
      try {
        return { bytes: b64ToBytes(cached.data), sig: typeof cached.sig === 'string' ? cached.sig : '' };
      } catch {
        return null;
      }
    }
    if (publicKey) return null;
    return { bytes: new TextEncoder().encode(JSON.stringify(cached)), sig: '' };
  }

  return {
    DEFAULT_URL,
    SIG_URL,
    SELECTORS_PUBLIC_KEY,
    sanitize,
    snapshotBase,
    apply,
    riskyRegex,
    verify,
    nodeVerifier,
    subtleVerifier,
    parseBytes,
    packCache,
    unpackCache,
    b64ToBytes,
    bytesToB64,
  };
});
