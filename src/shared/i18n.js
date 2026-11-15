// 화면 문구 다국어 (v0.24.0 틀 — 한국어 · 영어).
// 문구는 i18n-ko.js · i18n-en.js에 키: 글 로 두고, 화면 코드는 t('키', { 이름: 값 })로 꺼내 쓴다.
// 글 안의 {이름}은 vars의 값으로 바뀐다. 지금 언어에 없는 키는 한국어 → 키 이름 순으로 대신 쓴다.
// Electron 앱(require)과 크롬 확장 · 화면(전역 MLA.i18n)이 같이 쓴다. 화면에서는 i18n-ko.js · i18n-en.js를 먼저 읽어야 한다.
//
// [쉽게 말하면] 화면 글자를 언어별 사전에서 찾아 주는 부품입니다.
// v0.24.0부터 새로 만드는 화면 글은 이 사전을 거치고, 예전 화면 글은 v0.30.0에서 모두 옮깁니다.
// 그때까지는 화면이 한국어와 영어로 섞이지 않게 언어를 한국어로 둡니다 (setLang을 부르지 않음).
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

  const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

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
    for (const el of scope.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of scope.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of scope.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }

  /** 두 언어의 키가 짝이 맞는지 (테스트용) → { missing: { en: [...], ko: [...] } } */
  function checkKeys() {
    const keys = (l) => new Set(Object.keys(STRINGS[l] || {}));
    const ko = keys('ko');
    const en = keys('en');
    return { missing: { en: [...ko].filter((k) => !en.has(k)), ko: [...en].filter((k) => !ko.has(k)) } };
  }

  return { LANGS, t, setLang, getLang, detectLang, apply, checkKeys, strings: STRINGS };
});
