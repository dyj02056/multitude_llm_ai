// UI strings — English · ui (v0.30.0). Keys start with 'ui.' and mirror i18n-ko-ui.js.
(function (root, dict) {
  if (typeof module === 'object' && module.exports) module.exports = dict;
  else {
    const s = ((root.MLA = root.MLA || {}).i18nStrings = root.MLA.i18nStrings || {});
    s.en = Object.assign(s.en || {}, dict);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, {
});
