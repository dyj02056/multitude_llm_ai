// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/i18n.js)
// 화면 문구 다국어 (v0.24.0 틀 — 한국어 · 영어).
// 문구는 i18n-ko.js · i18n-en.js에 키: 글 로 두고, 화면 코드는 t('키', { 이름: 값 })로 꺼내 쓴다.
// 글 안의 {이름}은 vars의 값으로 바뀐다. 지금 언어에 없는 키는 한국어 → 키 이름 순으로 대신 쓴다.
// Electron 앱(require)과 크롬 확장 · 화면(전역 MLA.i18n)이 같이 쓴다. 화면에서는 i18n-ko.js · i18n-en.js를 먼저 읽어야 한다.
//
// [쉽게 말하면] 화면 글자를 언어별 사전에서 찾아 주는 부품입니다.
// v0.30.0부터 설정 › 언어(자동 · 한국어 · English)를 따릅니다: 본체 · 화면 · 확장이 시작할 때 setLang(detectLang(설정, OS 언어))를 부릅니다.
// AI에게 보내는 글(종합 · 분석 · 토론 프롬프트)은 아직 한국어 그대로입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  // 사전: 공통(i18n-ko.js · i18n-en.js) + 영역별(i18n-<언어>-<영역>.js, v0.30.0). 화면은 <script>로 먼저 읽어 합쳐 둔다.
  const AREAS = ['ui', 'project', 'library', 'ext', 'main'];
  const load = (lang) => Object.assign({}, require(`./i18n-${lang}`), ...AREAS.map((a) => require(`./i18n-${lang}-${a}`)));
  const strings = isNode ? { ko: load('ko'), en: load('en') } : (root.MLA && root.MLA.i18nStrings) || {};
  const api = factory(strings);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).i18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (STRINGS) {
  'use strict';

  const LANGS = ['ko', 'en'];
  const FALLBACK = 'ko';
  let lang = FALLBACK;

  const LANG_PREFS = ['auto', 'ko', 'en']; // 설정 › 언어 (v0.30.0)
  const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  /** 저장된 언어 설정 정리: 'auto' · 'ko' · 'en' 중 하나 (그 밖은 'auto') */
  const normalizeLangPref = (v) => (LANG_PREFS.includes(v) ? v : 'auto');

  /** 'auto' · 브라우저 언어(navigator.language 등) → 'ko' | 'en'. 한국어가 아니면 영어 */
  function detectLang(pref, navLang = '') {
    if (LANGS.includes(pref)) return pref;
    return /^ko\b/i.test(String(navLang || '')) ? 'ko' : 'en';
  }

  function setLang(l) {
    lang = LANGS.includes(l) ? l : FALLBACK;
    return lang;
  }
  const getLang = () => lang;

  /** 키 → 지금 언어의 글. {이름}은 vars로 바꾼다 (vars에 없으면 그대로 둔다) */
  function t(key, vars) {
    const dict = STRINGS[lang];
    let s = hasOwn(dict, key) ? dict[key] : hasOwn(STRINGS[FALLBACK], key) ? STRINGS[FALLBACK][key] : key;
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, name) => (hasOwn(vars, name) ? String(vars[name]) : m));
    return s;
  }

  /**
   * 화면 요소에 문구를 넣는다: data-i18n="키" → 글, data-i18n-title · data-i18n-placeholder · data-i18n-aria → 그 속성.
   * root 아래 요소 전부 (기본: document)
   */
  function apply(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return;
    if (scope.documentElement) scope.documentElement.lang = lang; // 화면 읽기 프로그램 · 맞춤법 검사가 언어를 알게 (v0.30.0)
    for (const el of scope.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of scope.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of scope.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }

  /**
   * AI 사이트 안에서 도는 코드(shared/page.js · extension/content.js)가 준 실패 결과를 지금 언어의 글로 바꾼다 (v0.30.0).
   * 그 코드는 사전 없이 돌아서 code(예: 'no-input')만 붙여 주고, 사전을 가진 쪽(본체 · host.js · 사이드탭)이 여기서 글을 고른다.
   * res: { ok: false, error, code, detail?, detailCode? } · 성공 결과의 attach(첨부 실패 안내)도 같이 바꾼다. 모르는 code는 그대로 둔다.
   */
  function pageError(res) {
    if (!res || typeof res !== 'object') return res;
    let out = res;
    if (res.attach && res.attach.ok === false) out = { ...out, attach: pageError(res.attach) };
    const key = `page.err.${res.code}`;
    if (res.ok !== false || typeof res.code !== 'string' || !hasOwn(STRINGS[FALLBACK], key)) return out;
    const detailKey = `page.err.${res.detailCode}`;
    const detail = typeof res.detailCode === 'string' && hasOwn(STRINGS[FALLBACK], detailKey) ? t(detailKey) : String(res.detail || '');
    return { ...out, error: t(key, { error: detail }) };
  }

  /** 두 언어의 키가 짝이 맞는지 (테스트용) → { missing: { en: [...], ko: [...] } } */
  function checkKeys() {
    const keys = (l) => new Set(Object.keys(STRINGS[l] || {}));
    const ko = keys('ko');
    const en = keys('en');
    return { missing: { en: [...ko].filter((k) => !en.has(k)), ko: [...en].filter((k) => !ko.has(k)) } };
  }

  return { LANGS, LANG_PREFS, normalizeLangPref, t, setLang, getLang, detectLang, apply, pageError, checkKeys, strings: STRINGS };
});
