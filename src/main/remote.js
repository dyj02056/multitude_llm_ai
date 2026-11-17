'use strict';

// 사이트 셀렉터 원격 갱신.
// 서비스 화면이 바뀌어 입력창·보내기 버튼·답변을 못 찾게 되면, 앱을 다시 설치하지 않고
// GitHub 저장소의 remote/selectors.json만 고쳐서 바로잡는다.
//
// 받는 것은 CSS 셀렉터·정규식 "문자열"뿐이다. 코드는 받지도 실행하지도 않는다 (검사·적용은 shared/remote-core.js).
// 마지막으로 받은 정상 데이터는 사용자 데이터 폴더(remote-selectors.json)에 저장해 두고
// 다음 실행 때 네트워크 없이도 먼저 적용한다.
// remote-core.js에 공개 키가 들어 있으면 selectors.json.sig 서명이 맞는 파일만 적용한다 (remote/README.md "서명").

// [쉽게 말하면]
// AI 사이트가 디자인을 바꾸면 앱이 입력창이나 답변 위치를 못 찾게 됩니다.
// 그때 앱을 새로 설치하지 않아도 되도록, 인터넷(GitHub)에서 "새 위치 목록"만 받아 바꿔 끼우는 파일입니다.
// 받는 것은 위치를 가리키는 글자(셀렉터)뿐이고, 프로그램 코드는 받지 않아 안전합니다.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');
const core = require('../shared/remote-core');
const { t } = require('../shared/i18n');
const { DEFAULT_URL, sanitize: sanitizeData, snapshotBase, apply: applyTo } = core;

const verifier = core.nodeVerifier(crypto);

const FETCH_TIMEOUT_MS = 8000;

let services = [];
let base = new Map(); // id -> 처음(앱에 들어 있던) 값
let cacheFile = null;
let url = DEFAULT_URL;
let status = { source: 'builtin' }; // 'builtin' | 'cache' | 'remote', version, updated, checkedAt, error
let remoteOverrides = {}; // 마지막으로 적용한 원격 값 (내 셀렉터를 바꿀 때 다시 얹는다)
let localFile = null;
let localSel = {}; // 이 PC에서 직접 고친 셀렉터 { id: { input?, stop?, response? } } (v0.35.0)

const sanitize = (data) => sanitizeData(data, services);
// 앱에 들어 있던 값 → 원격 값 → 내가 고친 값(맨 앞) 순으로 얹는다
const apply = (overrides) => {
  remoteOverrides = overrides;
  applyTo(services, base, overrides);
  core.applyLocal(services, localSel);
};

/** 앱을 켤 때: 앱에 들어 있던 원래 값을 기억해 두고, 지난번에 받아 둔 목록이 있으면 먼저 적용합니다. */
// 받아 둔 목록 읽기는 동기로 둔다: 첫 창 · 패널이 뜨기 전에 셀렉터가 적용돼 있어야 한다 (작은 파일 한 번).
function init(userDataDir, serviceList, { remoteUrl } = {}) {
  services = serviceList;
  cacheFile = path.join(userDataDir, 'remote-selectors.json');
  if (remoteUrl) url = remoteUrl;
  localFile = path.join(userDataDir, 'local-selectors.json');
  try {
    localSel = core.sanitizeLocal(JSON.parse(fs.readFileSync(localFile, 'utf8')), services).overrides;
  } catch {
    localSel = {};
  }
  base = snapshotBase(services);
  apply({}); // 내가 고친 셀렉터를 먼저 얹는다 (원격 값은 아래에서 다시)
  try {
    // 받아 둔 바이트와 서명을 다시 확인한다. 서명 없는 예전 캐시는 공개 키가 있으면 버린다 (내장 값을 씀).
    const packed = core.unpackCache(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    if (!packed) return;
    if (!core.verify(packed.bytes, packed.sig, verifier).ok) return;
    const cached = sanitize(core.parseBytes(packed.bytes));
    if (cached) {
      apply(cached.overrides);
      status = { source: 'cache', version: cached.version, updated: cached.updated };
    }
  } catch {}
}

/** 파일 하나를 바이트 그대로 내려받습니다. 8초 안에 응답이 없으면 포기합니다 (개발 중에는 PC의 파일 경로도 받음). */
async function fetchBytes(target) {
  if (!/^https?:\/\//.test(target)) return new Uint8Array(await fsp.readFile(target)); // 개발용: 로컬 파일 경로
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // 리다이렉트는 따라가지 않는다 (정해 둔 주소의 파일만 받는다. 다른 곳으로 보내면 실패로 보고 지금 값을 유지)
    const res = await net.fetch(target, { cache: 'no-store', redirect: 'error', signal: ctrl.signal });
    if (res.redirected) throw new Error(t('main.remote.redirect'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 목록 파일과 (공개 키가 있으면) 서명 파일을 받습니다: { bytes, sig }.
 * 서명은 JSON으로 읽기 전에, 받은 바이트 그대로에 대해 확인한다.
 */
async function download() {
  const bytes = await fetchBytes(url);
  const sig = core.SELECTORS_PUBLIC_KEY ? new TextDecoder().decode(await fetchBytes(`${url}.sig`)).trim() : '';
  return { bytes, sig };
}

// 받아 둔 목록 쓰기는 비동기로, 한 줄로 세워서 한다 (갱신이 겹쳐도 먼저 시작한 쓰기가 나중 것을 덮지 않게)
let cacheWrite = Promise.resolve();
function saveCache(text) {
  const file = cacheFile;
  cacheWrite = cacheWrite.then(() => fsp.writeFile(file, text)).catch(() => {});
  return cacheWrite;
}

/** 원격 셀렉터를 받아 적용한다. 실패하면 지금 쓰는 값(캐시 또는 내장)을 그대로 둔다. */
async function refresh() {
  const checkedAt = Date.now();
  try {
    const { bytes, sig } = await download();
    const check = core.verify(bytes, sig, verifier);
    if (!check.ok) {
      // 서명이 틀리면 적용하지 않고 캐시도 그대로 둔다 (지금 쓰는 값 유지)
      console.warn('[remote] 서명 확인 실패', check.detail || '');
      throw new Error(t('main.remote.sigFailed'));
    }
    const clean = sanitize(core.parseBytes(bytes));
    if (!clean) throw new Error(t('main.remote.badFormat'));
    apply(clean.overrides);
    await saveCache(JSON.stringify(core.packCache(bytes, sig)));
    status = {
      source: 'remote',
      version: clean.version,
      updated: clean.updated,
      services: Object.keys(clean.overrides),
      ignored: clean.ignored, // 보안상 원격으로 바꾸지 않는 항목(버튼 셀렉터 등)이라 무시한 것
      checkedAt,
    };
  } catch (err) {
    status = { ...status, checkedAt, error: err.name === 'AbortError' ? t('main.remote.timeout') : err.message };
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

/** 내가 고친 셀렉터 (v0.35.0) */
const getLocal = (id) => ({ ...(localSel[id] || {}) });

/**
 * 서비스 하나의 내 셀렉터를 바꾼다 (patch: { input?, stop?, response? } — 빈 목록이면 그 칸을 지움, 아무것도 안 남으면 서비스째 지움).
 * 검사를 통과한 것만 저장하고 바로 적용한다 → { ok, local } | { ok: false, error }
 */
function setLocal(id, patch) {
  const clean = core.sanitizeLocal({ [id]: patch }, services);
  const next = { ...localSel };
  if (clean.overrides[id]) next[id] = clean.overrides[id];
  else delete next[id];
  try {
    if (Object.keys(next).length) fs.writeFileSync(localFile, JSON.stringify(next, null, 2));
    else fs.rmSync(localFile, { force: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  localSel = next;
  apply(remoteOverrides);
  return { ok: true, local: getLocal(id) };
}

module.exports = { init, refresh, reset, getStatus, sanitize, getLocal, setLocal };
