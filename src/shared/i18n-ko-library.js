// 화면 문구 — 한국어 · 라이브러리 · 스킬 · 템플릿 (v0.30.0). 키 이름은 'library.무엇' 꼴로 시작한다 (다른 사전과 겹치지 않게).
// 같은 키를 i18n-en-library.js에도 넣는다 (test/i18n.test.js가 짝 · 겹침을 검사).
(function (root, dict) {
  if (typeof module === 'object' && module.exports) module.exports = dict;
  else {
    const s = ((root.MLA = root.MLA || {}).i18nStrings = root.MLA.i18nStrings || {});
    s.ko = Object.assign(s.ko || {}, dict);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, {
});
