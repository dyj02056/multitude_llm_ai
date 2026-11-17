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

  // ---------- 로컬 모델 컨텍스트 한도 (v0.29.0) ----------
  // 토큰 수는 어림만 한다: 영문 · 숫자(ASCII)는 4글자에 1토큰, 한글 · 한자 등은 1글자에 1토큰으로 넉넉히 센다.
  // (project-context.js의 "UTF-8 바이트 ÷ 4"보다 한글을 크게 센다 — 한도를 넘기는 쪽보다 덜 보내는 쪽이 안전)
  const REPLY_SHARE = 0.25; // 한도의 이만큼은 답을 쓸 자리로 남긴다
  const MIN_ANSWER_TOKENS = 64; // 줄여도 답변마다 이만큼은 남긴다

  function estimateTokens(text) {
    const s = String(text || '');
    let ascii = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
    return Math.ceil(ascii / 4) + (s.length - ascii);
  }

  /** 보낼 글이 한도에 들어가는지 → { tokens, limit, budget, over } (limit이 없으면 over false) */
  function contextCheck(text, limit) {
    const tokens = estimateTokens(text);
    const budget = limit > 0 ? Math.floor(limit * (1 - REPLY_SHARE)) : Infinity;
    return { tokens, limit: limit || 0, budget, over: tokens > budget };
  }

  /**
   * 종합 입력 줄이기: 답변들 [{ name, text }]이 한도(limit 토큰)에 들어가도록 답변마다 같은 비율로 앞부분만 남긴다.
   * fixedText: 답변 말고 함께 보낼 글 (질문 · 지시문 — 줄이지 않음), note: 줄인 답 끝에 붙일 안내 ("(… 일부만 보냄)")
   * → { answers, trimmed: 줄인 답변 이름 목록 }
   */
  function fitAnswers(answers, { limit, fixedText = '', note = '(…)' } = {}) {
    const list = Array.isArray(answers) ? answers : [];
    if (!(limit > 0) || !list.length) return { answers: list, trimmed: [] };
    const room = Math.floor(limit * (1 - REPLY_SHARE)) - estimateTokens(fixedText) - estimateTokens(note) * list.length;
    const sizes = list.map((a) => estimateTokens(a.text));
    const total = sizes.reduce((n, x) => n + x, 0);
    if (total <= room) return { answers: list, trimmed: [] };
    const ratio = Math.max(0, room) / total;
    const trimmed = [];
    const out = list.map((a, i) => {
      const keep = Math.max(MIN_ANSWER_TOKENS, Math.floor(sizes[i] * ratio));
      if (keep >= sizes[i]) return a;
      trimmed.push(a.name);
      return { ...a, text: `${cutToTokens(a.text, keep).trimEnd()}\n\n${note}` };
    });
    return { answers: out, trimmed };
  }

  /** 글 앞부분을 토큰 어림 n개까지 */
  function cutToTokens(text, n) {
    const s = String(text || '');
    let used = 0;
    let ascii = 0;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) < 128) {
        ascii++;
        if (ascii % 4 === 1) used++;
      } else used++;
      if (used > n) return s.slice(0, i);
    }
    return s;
  }

  const str = (v) => (typeof v === 'string' ? v : undefined);
  const fileKind = (type) => (/^image\//.test(type || '') ? 'image' : 'document');

  // 글 파일 (v0.36.0): 로컬 LLM은 문서를 업로드하지 못해, 글로 읽을 수 있는 파일만 요청 글에 끼워 보낸다 (그 밖의 문서는 빼고 알림)
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|log|html?|css|js|mjs|cjs|jsx|ts|tsx|py|java|kt|go|rs|c|h|cc|cpp|hpp|cs|rb|php|swift|sql|sh|bat|ps1|tex|rst|srt|vtt)$/i;
  const TEXT_TYPE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-javascript|x-sh|sql|toml))/i;
  /** 글로 읽을 수 있는 파일인가 (종류 · 확장자로만 — 내용은 보지 않는다) */
  const isTextLike = (f) => !!f && (TEXT_TYPE.test(f.type || '') || TEXT_EXT.test(f.name || ''));
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
      const sent = kind === 'document' && svc.textOnlyDocs ? accept.includes(kind) && isTextLike(f) : accept.includes(kind);
      return { name: String(f.name || ''), size: sizeOf(f), kind, project: i >= item.own, sent };
    });
    const warnings = [];
    const chars = item.text.length;
    if (chars > LONG_TEXT) warnings.push({ code: 'long', vars: { n: chars, max: LONG_TEXT } });
    // 로컬 LLM: 컨텍스트 한도(설정)를 넘을 것 같으면 (v0.29.0 — 이번 글만 센다, 앞선 대화는 더 들어간다)
    if (svc.contextTokens > 0) {
      const c = contextCheck(item.text, svc.contextTokens);
      if (c.over) warnings.push({ code: 'localCtx', vars: { n: c.tokens, max: c.limit } });
    }
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

  return { LONG_TEXT, planSend, previewRow, preview, estimateTokens, contextCheck, fitAnswers, cutToTokens, isTextLike };
});
