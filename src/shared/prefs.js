// 설정 다듬기와 보내기 옵션 검사 (v0.40.1): Windows 앱(main.js)과 크롬 확장(host.js)에 두 번 쓰여 있던 규칙을 한 곳에 모았다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.prefs)이 같이 쓴다. 확장에서는 공통 모듈을 부를 때 찾으므로 읽는 순서와 상관없다.
//
// [쉽게 말하면] 저장해 둔 설정을 지금 버전에 맞게 고치고, 화면이 넘긴 "보내기 옵션"에서 아는 것만 골라 길이를 잘라 두는 부품입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(
    isNode
      ? () => ({
          services: require('./services'),
          layout: require('./layout'),
          localLLM: require('./local-llm'),
          historyCore: require('./history-core'),
          notify: require('./notify'),
          recommend: require('./recommend'),
          onboarding: require('./onboarding'),
          i18n: require('./i18n'),
        })
      : () => root.MLA,
  );
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).prefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  /** 지금 쓸 수 있는 서비스 전체: 웹 서비스 + (켰으면) 로컬 LLM 패널들 */
  function allServicesOf(local) {
    const { services, localLLM } = deps();
    return local && local.enabled ? [...services.SERVICES, ...localLLM.localServices(local)] : services.SERVICES;
  }

  /**
   * 저장해 둔 설정(saved)을 기본값(prefs)에 덮어쓴 것을 지금 서비스 목록 · 값 범위에 맞춘다 (prefs를 고쳐서 돌려준다).
   * 예전 설정(Groq 등 없어진 서비스, 너무 많은 선택)도 여기서 고친다. 앱에만 있는 값(uiZoom 등)은 쓰는 쪽이 다듬는다.
   */
  function normalizePrefs(prefs, saved) {
    const { services, layout, localLLM: L, historyCore, notify, recommend, onboarding, i18n } = deps();
    prefs.onboarded = onboarding.wasOnboarded(saved); // 첫 사용 안내: 새로 설치한 사람만 한 번
    prefs.local = L.normalizeLocalPrefs(prefs.local);
    const hadLocal = Array.isArray(prefs.selected) ? prefs.selected.filter(L.isLocalId) : [];
    prefs.selected = services.normalizeSelected(prefs.selected);
    // 로컬 LLM은 웹 서비스 목록 밖이라 normalizeSelected가 뺀다 — 켜 둔 동안은 다시 넣는다 (패널 수 안의 것만)
    for (const id of hadLocal) {
      if (prefs.local.enabled && L.panelIndex(id) < prefs.local.panels && prefs.selected.length < services.MAX_SELECTED) prefs.selected.push(id);
    }
    prefs.layout = layout.normalizeLayout(prefs.layout);
    if (!allServicesOf(prefs.local).some((s) => s.id === prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
    prefs.historyMax = historyCore.normalizeMax(prefs.historyMax);
    prefs.historyArchive = prefs.historyArchive === true;
    prefs.notify = notify.normalizePrefs(prefs.notify);
    prefs.sendPreview = prefs.sendPreview === true;
    prefs.retryOnce = prefs.retryOnce !== false;
    prefs.autoRecommend = prefs.autoRecommend === true;
    if (!recommend.ORDERS.includes(prefs.recommendOrder)) prefs.recommendOrder = 'completion';
    prefs.lang = i18n.normalizeLangPref(prefs.lang);
    return prefs;
  }

  /**
   * 화면이 넘긴 보내기 옵션 검사: { question, textById, prefixById, fallbackText, plainIds, userFileCount, noHistory, project }
   * 아는 항목만 골라 길이를 자른다. 패널별 값은 ids(지금 쓸 수 있는 패널 — 로컬 LLM 패널 포함)에 있는 것만 남긴다.
   */
  function cleanSendOpts(opts, ids) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return {};
    const out = {};
    if (typeof opts.question === 'string') out.question = opts.question.slice(0, 20000);
    if (typeof opts.fallbackText === 'string') out.fallbackText = opts.fallbackText.slice(0, 200000);
    if (opts.textById && typeof opts.textById === 'object') {
      out.textById = {};
      for (const id of ids) if (typeof opts.textById[id] === 'string') out.textById[id] = opts.textById[id];
    }
    if (opts.prefixById && typeof opts.prefixById === 'object') {
      out.prefixById = {};
      for (const id of ids) if (typeof opts.prefixById[id] === 'string') out.prefixById[id] = opts.prefixById[id].slice(0, 25000);
    }
    if (Array.isArray(opts.plainIds)) out.plainIds = ids.filter((id) => opts.plainIds.includes(id));
    if (Number.isInteger(opts.userFileCount) && opts.userFileCount >= 0) out.userFileCount = opts.userFileCount;
    if (opts.noHistory === true) out.noHistory = true;
    // 프로젝트 맥락을 붙여 보냄: 이름만 기록에 남긴다
    const name = opts.project && typeof opts.project === 'object' && typeof opts.project.name === 'string' ? opts.project.name.trim() : '';
    if (name) out.project = { name: name.slice(0, 120) };
    return out;
  }

  return { allServicesOf, normalizePrefs, cleanSendOpts };
});
