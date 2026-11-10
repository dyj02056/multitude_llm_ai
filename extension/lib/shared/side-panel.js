// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/side-panel.js)
// 사이드탭 모드 (v0.19.0, 크롬 확장 전용): 크롬 오른쪽 사이드 패널에 AI 웹 채팅을 최대 2개 띄우고,
// 보고 있는 웹페이지 본문을 함께 보내 묻는다. 계산만 하는 부분을 여기 모아 사이드 패널(sidepanel.js)과 테스트가 같이 쓴다.
//
// [쉽게 말하면]
//   - 고른 모델 정리: 웹 서비스만, 겹치지 않게, 최대 2개 (하나도 없으면 Gemini)
//   - 위/아래 나누는 비율: 20% ~ 80% 사이로만
//   - 패널 iframe과 사이드 패널을 잇는 연결 이름: "mla-side:<사이드 패널 번호>:<서비스 id>"
//   - 보낼 글 만들기: 페이지 본문을 그 패널에 아직 안 보냈으면 page.md로 첨부하고 안내 한 줄을 붙인다
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).sidePanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SIDE = 2; // 사이드탭에 함께 띄울 수 있는 모델 수
  const DEFAULT_SIDE = ['gemini'];
  const MAX_PAGE = 300000; // page.md에 넣는 본문의 최대 글자 수 (오른쪽 클릭 메뉴와 같음)
  const PORT_PREFIX = 'mla-side';
  const RATIO_MIN = 0.2;
  const RATIO_MAX = 0.8;

  /** 고른 모델 정리 → 웹 서비스 id 배열 (최대 2개, 비면 기본값) */
  function normalizeSelected(ids, services) {
    const known = new Set((services || []).filter((s) => (s.kind || 'web') === 'web').map((s) => s.id));
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
      if (out.length === MAX_SIDE) break;
    }
    return out.length ? out : DEFAULT_SIDE.filter((id) => known.has(id)).slice(0, 1);
  }

  /**
   * 모델 하나를 켜거나 끈다 → { ok, selected, error }
   * 이미 2개면 더 켜지 않고, 마지막 하나는 끄지 않는다.
   */
  function toggle(selected, id) {
    const cur = Array.isArray(selected) ? [...selected] : [];
    if (cur.includes(id)) {
      if (cur.length === 1) return { ok: false, selected: cur, error: '최소 1개는 열어 두어야 합니다' };
      return { ok: true, selected: cur.filter((x) => x !== id) };
    }
    if (cur.length >= MAX_SIDE) return { ok: false, selected: cur, error: `사이드탭에는 최대 ${MAX_SIDE}개까지 띄울 수 있습니다` };
    return { ok: true, selected: [...cur, id] };
  }

  /** 위 패널이 차지하는 비율 (0.2 ~ 0.8, 이상한 값이면 반반) */
  function clampRatio(r) {
    const n = Number(r);
    if (!Number.isFinite(n)) return 0.5;
    return Math.min(RATIO_MAX, Math.max(RATIO_MIN, n));
  }

  /** 패널 iframe의 이름 = content.js가 사이드 패널에 연결할 때 쓰는 연결 이름 */
  const portName = (nonce, id) => `${PORT_PREFIX}:${nonce}:${id}`;

  /** 연결 이름 → { nonce, id } | null */
  function parsePortName(name) {
    const m = /^mla-side:([0-9a-f-]{36}):([a-z0-9-]{1,40})$/.exec(String(name || ''));
    return m ? { nonce: m[1], id: m[2] } : null;
  }

  /** 페이지에서 읽은 값 검사 → { title, url, text, truncated, at, tabId } | null */
  function normalizeContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
    if (!text) return null;
    let url = '';
    try {
      const u = new URL(String(raw.url || ''));
      if (u.protocol === 'http:' || u.protocol === 'https:') url = u.href;
    } catch {}
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || url || '웹페이지';
    return {
      title,
      url,
      text: text.slice(0, MAX_PAGE),
      truncated: text.length > MAX_PAGE,
      at: Number.isFinite(raw.at) ? raw.at : Date.now(),
      tabId: Number.isInteger(raw.tabId) ? raw.tabId : null,
    };
  }

  /** 맥락 줄 상태: 'none'(가져온 페이지 없음) · 'off'(꺼 둠) · 'other'(지금 탭과 다름) · 'ok' */
  function contextState(ctx, { on = true, activeTabId = null } = {}) {
    if (!ctx) return 'none';
    if (!on) return 'off';
    if (ctx.tabId !== null && activeTabId !== null && ctx.tabId !== activeTabId) return 'other';
    return 'ok';
  }

  /** 같은 페이지 본문을 다시 보내지 않게 기억하는 열쇠 (주소 + 가져온 때) */
  // 같은 페이지를 다시 읽어도 글이 같으면 같은 열쇠 (v0.19.2: 자동 읽기는 보낼 때마다 다시 읽는다)
  function contextKey(ctx) {
    if (!ctx) return '';
    let h = 5381;
    for (let i = 0; i < ctx.text.length; i++) h = ((h << 5) + h + ctx.text.charCodeAt(i)) | 0;
    return `${ctx.url}#${ctx.text.length}#${(h >>> 0).toString(36)}`;
  }

  // 이 길이까지는 본문을 질문 글에 그대로 넣는다 (v0.19.1). 사이드 패널은 폭이 좁아 사이트가 모바일 화면으로 바뀌고,
  // 그 화면에서는 파일 첨부가 "된 것처럼" 보이고 실제로는 안 붙는 경우가 있어 — 첨부에 기대지 않는 편이 확실하다.
  const INLINE_MAX = 30000;

  /** 본문을 질문 글에 그대로 넣은 글 (출처 · 본문 · 질문) */
  function inlinePrompt(ctx, q) {
    const src = ctx.url ? `「${ctx.title}」(${ctx.url})` : `「${ctx.title}」`;
    return [`다음은 내가 지금 보고 있는 웹페이지 ${src}의 본문입니다. 이 내용을 바탕으로 답해 주세요.`, '', '---', ctx.text, '---', '', `질문: ${q}`].join('\n');
  }

  /**
   * 한 패널에 보낼 내용 → { text, page: { name, type, text } | null, mode: 'none' | 'inline' | 'file' }
   * 맥락이 켜져 있고 그 패널에 이 페이지를 아직 안 보냈으면:
   *   - 본문이 3만 자 이하: 질문 글에 본문을 그대로 넣는다 ('inline')
   *   - 더 길면: page.md로 첨부하고 안내 한 줄을 질문 앞에 넣는다 ('file' — 오른쪽 클릭 메뉴와 같은 모양)
   */
  function buildSend({ text, ctx, on = true, sentKey = '', webAsk, inlineMax = INLINE_MAX }) {
    const q = String(text || '').trim();
    if (!ctx || !on || sentKey === contextKey(ctx) || !webAsk) return { text: q, page: null, mode: 'none' };
    if (ctx.text.length <= inlineMax) return { text: inlinePrompt(ctx, q), page: null, mode: 'inline' };
    return { text: `${webAsk.pagePrompt(ctx)}${q}`, page: webAsk.pageFile(ctx), mode: 'file' };
  }

  return { MAX_SIDE, DEFAULT_SIDE, MAX_PAGE, INLINE_MAX, normalizeSelected, toggle, clampRatio, portName, parsePortName, normalizeContext, contextState, contextKey, inlinePrompt, buildSend };
});
