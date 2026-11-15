// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/send-plan.js)
// 보내기 계획 (v0.25.0): 패널마다 실제로 넣을 글 · 첨부 파일 · 예비 글을 보내지 않고 계산만 한다.
// rounds.sendAll이 이 계산 그대로 보내고, 화면의 "보내기 전 미리보기"도 같은 계산을 써서 보여 준 것과 보낸 것이 같다.
// Electron 앱(require)과 화면 · 크롬 확장(전역 MLA.sendPlan)이 같이 쓴다.
//
// [쉽게 말하면] "이 AI에게는 스킬 지침 + 프로젝트 맥락 + 질문, 파일은 이것들"을 미리 적어 보는 계산기입니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).sendPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 글이 이보다 길면 미리보기에 "너무 길 수 있음"을 띄운다. 사이트마다 실제 한도는 알려져 있지 않아,
  // 프로젝트 모드가 본문으로 넣는 최대 글자 수(project-context.js INLINE_LIMIT)와 같게 잡았다.
  const LONG_TEXT = 100000;
  const FILE_LIMITS = { maxFiles: 10, maxFileBytes: 25 * 1024 * 1024 }; // services.js ATTACH_LIMITS와 같게 (화면은 state.attachLimits를 넘긴다)

  const str = (v) => (typeof v === 'string' ? v : undefined);
  const fileKind = (type) => (/^image\//.test(type || '') ? 'image' : 'document');
  const sizeOf = (f) => (Number.isFinite(f.size) ? f.size : f.data && Number.isFinite(f.data.byteLength) ? f.data.byteLength : 0);

  /**
   * 패널마다 보낼 것 (sendAll과 같은 규칙):
   *   글 = prefixById[id] + (textById[id] ?? text), 예비 글 = prefixById[id] + fallbackText (프로젝트 파일 업로드가 실패하면 대신 보냄)
   *   plainIds(프로젝트 파일을 보내지 않을 서비스)는 앞의 userFileCount개(사용자가 직접 올린 파일)만, 예비 글 없음
   * → [{ id, text, files, fallbackText, plain, own(사용자 파일 수) }]
   */
  function planSend(text, ids, files = [], opts = {}) {
    const list = Array.isArray(files) ? files : [];
    const prefix = (id) => (opts.prefixById && str(opts.prefixById[id])) || '';
    const plain = new Set(Array.isArray(opts.plainIds) ? opts.plainIds : []);
    const own = Number.isInteger(opts.userFileCount) && opts.userFileCount >= 0 ? Math.min(opts.userFileCount, list.length) : list.length;
    const fallback = str(opts.fallbackText);
    return (Array.isArray(ids) ? ids : []).map((id) => {
      const body = (opts.textById && str(opts.textById[id])) ?? (str(text) || '');
      const isPlain = plain.has(id);
      return {
        id,
        text: prefix(id) + body,
        files: isPlain ? list.slice(0, own) : list,
        fallbackText: !isPlain && fallback !== undefined ? prefix(id) + fallback : undefined,
        plain: isPlain,
        own,
      };
    });
  }

  /**
   * 미리보기 칸 하나: plan 항목 + 서비스 정보 { name, accept, maxFileBytes } + 첨부 한도
   * → { id, name, text, chars, files: [{ name, size, kind, project, sent }], fallbackChars, warnings: [{ code, vars }] }
   * warnings code: 'long'(글이 김) · 'skipped'(받지 않는 종류라 빼고 보냄) · 'big'(파일이 서비스 한도보다 큼) · 'many'(파일 수 초과) · 'empty'(보낼 것이 없음)
   */
  function previewRow(item, svc = {}, limits = FILE_LIMITS) {
    const accept = Array.isArray(svc.accept) ? svc.accept : ['image', 'document'];
    const maxBytes = Number.isFinite(svc.maxFileBytes) && svc.maxFileBytes > 0 ? svc.maxFileBytes : limits.maxFileBytes;
    const files = item.files.map((f, i) => {
      const kind = fileKind(f.type);
      return { name: String(f.name || ''), size: sizeOf(f), kind, project: i >= item.own, sent: accept.includes(kind) };
    });
    const warnings = [];
    const chars = item.text.length;
    if (chars > LONG_TEXT) warnings.push({ code: 'long', vars: { n: chars, max: LONG_TEXT } });
    const skipped = files.filter((f) => !f.sent).map((f) => f.name);
    if (skipped.length) warnings.push({ code: 'skipped', vars: { names: skipped.join(', ') } });
    const big = files.filter((f) => f.sent && f.size > maxBytes).map((f) => f.name);
    if (big.length) warnings.push({ code: 'big', vars: { names: big.join(', '), max: maxBytes } });
    const sentCount = files.filter((f) => f.sent).length;
    if (sentCount > limits.maxFiles) warnings.push({ code: 'many', vars: { n: sentCount, max: limits.maxFiles } });
    if (!chars && !sentCount) warnings.push({ code: 'empty', vars: {} });
    return {
      id: item.id,
      name: svc.name || item.id,
      text: item.text,
      chars,
      files,
      fallbackChars: item.fallbackText === undefined ? 0 : item.fallbackText.length,
      warnings,
    };
  }

  /** 화면용: 보낼 것 전체의 미리보기 칸들. services: [{ id, name, accept, maxFileBytes }] */
  function preview(text, ids, files, opts, services = [], limits = FILE_LIMITS) {
    const byId = new Map((services || []).map((s) => [s.id, s]));
    return planSend(text, ids, files, opts).map((item) => previewRow(item, byId.get(item.id), limits || FILE_LIMITS));
  }

  return { LONG_TEXT, planSend, previewRow, preview };
});
