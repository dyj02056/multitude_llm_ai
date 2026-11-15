// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/i18n-en.js)
// UI strings — English (v0.24.0). Keys mirror i18n-ko.js; {name} is replaced by t() vars.
(function (root, dict) {
  if (typeof module === 'object' && module.exports) module.exports = dict;
  else ((root.MLA = root.MLA || {}).i18nStrings = root.MLA.i18nStrings || {}).en = dict;
})(typeof globalThis !== 'undefined' ? globalThis : this, {
  'settings.historyMax': 'History size',
  'settings.historyMaxOption': '{n} records',
  'settings.historyMaxNote': 'When full, the oldest records are removed first. Response stats count only the records kept.',
  'settings.historyMaxShrink': 'Lowering the limit to {n} removes the {drop} oldest records. This cannot be undone. Continue?',
});
