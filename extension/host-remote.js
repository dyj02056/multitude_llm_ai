// 크롬 확장 host — 사이트 셀렉터 원격 갱신(remote/selectors.json, 서명 검사) · 새 버전 알림.
// v0.31.0에서 host.js에서 떼어 냈다. app.html에서 host.js보다 먼저 읽힌다 (scripts/build-extension.js).
// host.js의 것(설정 · 저장 · 패널 목록 · 화면에 알리기 등)은 공유 객체 X(MLA.extHost)에서 "쓸 때" 찾는다.
// 이 파일이 만드는 것(UPD · checkUpdate · loadRemoteCache · refreshRemote · resetRemote)과 지금 상태(remoteStatus · updateStatus)는 X에 실어 host.js가 쓴다.
//
// [쉽게 말하면] AI 사이트 화면이 바뀌었을 때 고친 셀렉터를 GitHub에서 받아 오고, 새 버전이 나왔는지 확인하는 부분입니다.
(() => {
  'use strict';
  const X = (MLA.extHost = MLA.extHost || {});
  const { SERVICES } = MLA.services;
  const remoteCore = MLA.remoteCore;

  // ---------- 사이트 셀렉터 원격 갱신 ----------

  const remoteBase = remoteCore.snapshotBase(SERVICES);
  let remoteStatus = { source: 'builtin' };
  // 이 PC에서 직접 고친 셀렉터 (v0.35.0, 'localSelectors' 칸): 앱에 들어 있던 값 → 원격 값 → 내가 고친 값(맨 앞) 순으로 얹는다
  let localSel = {};
  let currentRemote = {};
  const applyAll = (overrides) => {
    currentRemote = overrides;
    remoteCore.apply(SERVICES, remoteBase, overrides);
    remoteCore.applyLocal(SERVICES, localSel);
  };
  async function loadLocalSelectors() {
    localSel = remoteCore.sanitizeLocal(await X.load('localSelectors', {}), SERVICES).overrides;
    applyAll(currentRemote);
  }
  const getLocalSelectors = (id) => ({ ...(localSel[id] || {}) });
  /** 서비스 하나의 내 셀렉터를 바꾼다 (patch가 비면 지움) → { ok, local } */
  function setLocalSelectors(id, patch) {
    const clean = remoteCore.sanitizeLocal({ [id]: patch }, SERVICES);
    const next = { ...localSel };
    if (clean.overrides[id]) next[id] = clean.overrides[id];
    else delete next[id];
    localSel = next;
    X.store('localSelectors', next);
    applyAll(currentRemote);
    return { ok: true, local: getLocalSelectors(id) };
  }
  // 서명 확인 (remote-core.js에 공개 키가 있을 때만). 이 크롬이 Ed25519를 지원하지 않으면 실패로 보고 지금 값을 유지한다.
  const remoteVerifier = remoteCore.subtleVerifier(crypto.subtle);
  const sigFailed = () => MLA.i18n.t('ext.host.sigFailed');

  // 바이트 그대로 받는다 (서명은 JSON으로 읽기 전에 확인). 리다이렉트는 따라가지 않는다 (정해 둔 주소의 파일만 받는다)
  async function fetchRemoteBytes(url, signal) {
    const res = await fetch(url, { cache: 'no-store', redirect: 'error', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // 시작할 때: 저장해 둔 바이트 · 서명을 다시 확인하고 적용한다. 서명 없는 예전 캐시는 공개 키가 있으면 버린다 (내장 값).
  async function loadRemoteCache() {
    if (!X.prefs.remoteSelectors) return;
    try {
      const packed = remoteCore.unpackCache(await X.load('remoteSelectors', null));
      if (!packed) return;
      const check = await remoteCore.verify(packed.bytes, packed.sig, remoteVerifier);
      if (!check.ok) return console.warn('[remote] 저장해 둔 셀렉터 서명 확인 실패', check.detail || '');
      const cached = remoteCore.sanitize(remoteCore.parseBytes(packed.bytes), SERVICES);
      if (!cached) return;
      applyAll(cached.overrides);
      remoteStatus = { source: 'cache', version: cached.version, updated: cached.updated };
    } catch {}
  }

  // 사이트 셀렉터 원격 갱신 (Windows 앱의 remote.js와 같은 일). 받은 값은 확장 저장소에 기억합니다.
  async function refreshRemote() {
    if (!X.prefs.remoteSelectors) return remoteStatus;
    const checkedAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), X.FETCH_TIMEOUT_MS);
    try {
      const bytes = await fetchRemoteBytes(remoteCore.DEFAULT_URL, ctrl.signal);
      const sig = remoteCore.SELECTORS_PUBLIC_KEY
        ? new TextDecoder().decode(await fetchRemoteBytes(remoteCore.SIG_URL, ctrl.signal)).trim()
        : '';
      const check = await remoteCore.verify(bytes, sig, remoteVerifier);
      if (!check.ok) {
        // 서명이 틀리면 적용하지 않고 저장해 둔 값도 그대로 둔다
        console.warn('[remote]', sigFailed(), check.detail || '');
        throw new Error(sigFailed());
      }
      const clean = remoteCore.sanitize(remoteCore.parseBytes(bytes), SERVICES);
      if (!clean) throw new Error(MLA.i18n.t('ext.host.badFormat'));
      applyAll(clean.overrides);
      X.store('remoteSelectors', remoteCore.packCache(bytes, sig));
      // 새 셀렉터를 받았으면 자가진단 기록을 지우고 다시 확인한다
      if (clean.version !== remoteStatus.version) {
        X.diag.reset();
        X.lastProbe.clear();
        for (const id of X.panels.keys()) X.probePanel(id);
      }
      remoteStatus = {
        source: 'remote',
        version: clean.version,
        updated: clean.updated,
        services: Object.keys(clean.overrides),
        ignored: clean.ignored, // 보안상 원격으로 바꾸지 않는 항목(버튼 셀렉터 등)이라 무시한 것
        checkedAt,
      };
    } catch (err) {
      remoteStatus = { ...remoteStatus, checkedAt, error: err.name === 'AbortError' ? MLA.i18n.t('ext.host.timeout') : err.message };
    } finally {
      clearTimeout(timer);
    }
    X.log('remote', JSON.stringify(remoteStatus));
    X.pushState();
    return remoteStatus;
  }

  function resetRemote() {
    applyAll({});
    remoteStatus = { source: 'builtin' };
  }

  // ---------- 새 버전 알림 (v0.20.0) ----------
  // 압축해제된 확장은 스스로 바꿀 수 없다. GitHub main의 package.json 버전만 보고 새 버전이 있으면 알린다
  // (원격 셀렉터와 같은 raw.githubusercontent.com — 권한 · CSP를 더 받지 않는다).
  const UPD = MLA.update;
  const myVersion = chrome.runtime.getManifest().version;
  let updateStatus = UPD.normalizeStatus({ state: 'idle', canInstall: false }, myVersion);
  async function checkUpdate() {
    updateStatus = UPD.normalizeStatus({ ...updateStatus, state: 'checking' }, myVersion);
    X.pushState();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), X.FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(UPD.PACKAGE_URL, { cache: 'no-store', redirect: 'error', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const latest = UPD.versionFromPackage(await res.text());
      if (!latest) throw new Error(MLA.i18n.t('ext.host.noVersion'));
      const state = UPD.isNewer(latest, myVersion) ? 'available' : 'none';
      updateStatus = UPD.normalizeStatus({ state, version: latest, checkedAt: Date.now(), canInstall: false }, myVersion);
    } catch (err) {
      updateStatus = UPD.normalizeStatus({ state: 'error', error: err.name === 'AbortError' ? MLA.i18n.t('ext.host.timeout') : err.message, checkedAt: Date.now(), canInstall: false }, myVersion);
    } finally {
      clearTimeout(timer);
    }
    X.pushState();
    return updateStatus;
  }

  Object.assign(X, { UPD, checkUpdate, loadRemoteCache, refreshRemote, resetRemote, loadLocalSelectors, getLocalSelectors, setLocalSelectors });
  // 값이 바뀌는 상태는 읽을 때마다 지금 값을 준다
  Object.defineProperties(X, {
    remoteStatus: { get: () => remoteStatus, enumerable: true },
    updateStatus: { get: () => updateStatus, enumerable: true },
  });
})();
