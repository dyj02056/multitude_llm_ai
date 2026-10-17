'use strict';

// 사이트 셀렉터 원격 갱신.
// 서비스 화면이 바뀌어 입력창·보내기 버튼·답변을 못 찾게 되면, 앱을 다시 설치하지 않고
// GitHub 저장소의 remote/selectors.json만 고쳐서 바로잡는다.
//
// 받는 것은 CSS 셀렉터·정규식 "문자열"뿐이다. 코드는 받지도 실행하지도 않는다.
// 마지막으로 받은 정상 데이터는 사용자 데이터 폴더(remote-selectors.json)에 저장해 두고
// 다음 실행 때 네트워크 없이도 먼저 적용한다.

const fs = require('fs');
const path = require('path');
const { net } = require('electron');

const DEFAULT_URL = 'https://raw.githubusercontent.com/dyj02056/multitude_llm_ai/main/remote/selectors.json';
const FETCH_TIMEOUT_MS = 8000;

// 바꿀 수 있는 필드와 모양
const LIST_FIELDS = ['input', 'send', 'stop', 'response']; // 셀렉터 목록
const STRING_FIELDS = ['loginButton', 'sendText', 'submitKey', 'newChatUrl'];
const MAX_ITEMS = 20;
const MAX_LEN = 300;

let services = [];
let base = new Map(); // id -> 처음(앱에 들어 있던) 값
let cacheFile = null;
let url = DEFAULT_URL;
let status = { source: 'builtin' }; // 'builtin' | 'cache' | 'remote', version, updated, checkedAt, error

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isStr = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_LEN;

function validRegex(s) {
  if (!isStr(s)) return false;
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

function validSelector(s) {
  // 메인 프로세스에는 DOM이 없어서 모양만 본다. 잘못된 셀렉터는 페이지에서 그냥 아무것도 못 찾는다.
  return isStr(s) && !/[{}]/.test(s);
}

/** 원격 데이터 한 서비스 몫을 검사해서 쓸 수 있는 필드만 돌려준다. */
function sanitizeService(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { replace: raw.replace === true };
  for (const f of LIST_FIELDS) {
    if (Array.isArray(raw[f])) out[f] = raw[f].filter(validSelector).slice(0, MAX_ITEMS);
  }
  for (const f of STRING_FIELDS) {
    if (isStr(raw[f])) out[f] = raw[f];
  }
  if (out.sendText && !validRegex(out.sendText)) delete out.sendText;
  if (out.submitKey && !/^(Ctrl\+|Shift\+|Alt\+)*Enter$/.test(out.submitKey)) delete out.submitKey;
  if (out.newChatUrl && !/^https:\/\//.test(out.newChatUrl)) delete out.newChatUrl;
  if (raw.messages && typeof raw.messages === 'object') {
    const m = raw.messages;
    if (validSelector(m.container) && validRegex(m.role) && validSelector(m.content)) {
      out.messages = { container: m.container, role: m.role, content: m.content };
    }
  }
  if (raw.loggedOut && typeof raw.loggedOut === 'object') {
    const lo = {};
    if (validRegex(raw.loggedOut.url)) lo.url = raw.loggedOut.url;
    if (validRegex(raw.loggedOut.text)) lo.text = raw.loggedOut.text;
    if (Array.isArray(raw.loggedOut.selectors)) lo.selectors = raw.loggedOut.selectors.filter(validSelector).slice(0, MAX_ITEMS);
    if (Object.keys(lo).length) out.loggedOut = lo;
  }
  return out;
}

function sanitize(data) {
  if (!data || typeof data !== 'object' || !Number.isInteger(data.version)) return null;
  const overrides = {};
  const known = new Set(services.map((s) => s.id));
  for (const [id, raw] of Object.entries(data.services || {})) {
    if (!known.has(id)) continue;
    const s = sanitizeService(raw);
    if (s) overrides[id] = s;
  }
  return { version: data.version, updated: isStr(data.updated) ? data.updated : '', overrides };
}

/**
 * 덮어쓰기를 적용한다. 셀렉터 목록은 원격 것을 앞에 두고 앱에 들어 있던 것을 뒤에 남긴다
 * (원격 셀렉터가 틀려도 예전 셀렉터로 계속 찾을 수 있게). replace: true면 원격 목록만 쓴다.
 */
function apply(overrides) {
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
  }
}

function init(userDataDir, serviceList, { remoteUrl } = {}) {
  services = serviceList;
  cacheFile = path.join(userDataDir, 'remote-selectors.json');
  if (remoteUrl) url = remoteUrl;
  base = new Map(
    services.map((s) => [
      s.id,
      Object.fromEntries([...LIST_FIELDS, ...STRING_FIELDS, 'messages', 'loggedOut'].map((f) => [f, clone(s[f])])),
    ]),
  );
  try {
    const cached = sanitize(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    if (cached) {
      apply(cached.overrides);
      status = { source: 'cache', version: cached.version, updated: cached.updated };
    }
  } catch {}
}

async function download() {
  if (!/^https?:\/\//.test(url)) return JSON.parse(fs.readFileSync(url, 'utf8')); // 개발용: 로컬 파일 경로
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 원격 셀렉터를 받아 적용한다. 실패하면 지금 쓰는 값(캐시 또는 내장)을 그대로 둔다. */
async function refresh() {
  const checkedAt = Date.now();
  try {
    const data = await download();
    const clean = sanitize(data);
    if (!clean) throw new Error('형식이 올바르지 않습니다');
    apply(clean.overrides);
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(data));
    } catch {}
    status = {
      source: 'remote',
      version: clean.version,
      updated: clean.updated,
      services: Object.keys(clean.overrides),
      checkedAt,
    };
  } catch (err) {
    status = { ...status, checkedAt, error: err.name === 'AbortError' ? '시간 초과' : err.message };
  }
  return status;
}

/** 원격 갱신을 끄면 앱에 들어 있던 셀렉터로 되돌린다. */
function reset() {
  apply({});
  status = { source: 'builtin' };
  return status;
}

const getStatus = () => status;

module.exports = { init, refresh, reset, getStatus, sanitize };
