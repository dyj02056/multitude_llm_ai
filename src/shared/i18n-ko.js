// 화면 문구 — 한국어 (v0.24.0). 키 이름은 '화면.무엇' 꼴. {이름}은 t()의 vars로 바뀐다.
// 새 문구를 넣을 때는 i18n-en.js에도 같은 키를 넣는다 (test/i18n.test.js가 짝을 검사).
(function (root, dict) {
  if (typeof module === 'object' && module.exports) module.exports = dict;
  else ((root.MLA = root.MLA || {}).i18nStrings = root.MLA.i18nStrings || {}).ko = dict;
})(typeof globalThis !== 'undefined' ? globalThis : this, {
  'settings.historyMax': '기록 최대 개수',
  'settings.historyMaxOption': '{n}개',
  'settings.historyMaxNote': '넘으면 가장 오래된 기록부터 지웁니다. 응답 통계도 남은 기록으로만 셉니다.',
  'settings.historyMaxShrink': '최대 개수를 {n}개로 줄이면 오래된 기록 {drop}개가 지워집니다. 되돌릴 수 없습니다. 계속할까요?',
});
