'use strict';

// 사이트 셀렉터 원격 갱신.
// 서비스 화면이 바뀌어 입력창·보내기 버튼·답변을 못 찾게 되면, 앱을 다시 설치하지 않고
// GitHub 저장소의 remote/selectors.json만 고쳐서 바로잡는다.
//
// 받는 것은 CSS 셀렉터·정규식 "문자열"뿐이다. 코드는 받지도 실행하지도 않는다 (검사·적용은 shared/remote-core.js).
// 마지막으로 받은 정상 데이터는 사용자 데이터 폴더(remote-selectors.json)에 저장해 두고
// 다음 실행 때 네트워크 없이도 먼저 적용한다.

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const { DEFAULT_URL, sanitize: sanitizeData, snapshotBase, apply: applyTo } = require('../shared/remote-core');

const FETCH_TIMEOUT_MS = 8000;

let services = [];
let base = new Map(); // id -> 처음(앱에 들어 있던) 값
let cacheFile = null;
let url = DEFAULT_URL;
let status = { source: 'builtin' }; // 'builtin' | 'cache' | 'remote', version, updated, checkedAt, error

const sanitize = (data) => sanitizeData(data, services);
const apply = (overrides) => applyTo(services, base, overrides);

function init(userDataDir, serviceList, { remoteUrl } = {}) {
  services = serviceList;
  cacheFile = path.join(userDataDir, 'remote-selectors.json');
  if (remoteUrl) url = remoteUrl;
  base = snapshotBase(services);
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
      ignored: clean.ignored, // 보안상 원격으로 바꾸지 않는 항목(버튼 셀렉터 등)이라 무시한 것
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
