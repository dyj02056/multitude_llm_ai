// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/preview-health.js)
// 미리보기 점검 (v0.44.0) — 미리보기 창에 띄운 앱 화면의 상태를 판정한다. 본체(main/preview.js) · 미리보기 창 · 앱 사이드바가 같이 쓴다.
//   콘솔 오류 · 실패한 요청(4xx · 5xx · 연결 실패) · 빈 화면(글자 · 그림 · 입력칸이 하나도 없음) · 페이지를 못 엶.
//
// [쉽게 말하면] "띄운 화면이 제대로 나왔나?"를 몇 가지 숫자로 보고 초록 · 노랑 · 빨강을 정하는 규칙입니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).previewHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ITEMS = 30; // 기억하는 콘솔 오류 · 실패한 요청 (최근 것부터)

  /** 빈 상태 */
  const empty = (url = '') => ({ url, title: '', loading: true, loadError: null, errors: [], failed: [], blank: null, at: 0 });

  /** 빈 화면인지: 페이지 안을 한 번 들여다본 숫자(probe) → true | false | null(못 봄) */
  function blankFrom(probe) {
    if (!probe || typeof probe !== 'object') return null;
    const text = Number(probe.text) || 0;
    const media = Number(probe.media) || 0;
    return text < 1 && media < 1;
  }

  // 페이지 안에서 실행해 숫자만 돌려받는 코드 (글 · 그림/입력칸 · 요소 수). 페이지의 값을 바꾸지 않는다
  const PROBE_JS = "(() => { const b = document.body; if (!b) return { text: 0, media: 0, nodes: 0 }; return { text: (b.innerText || '').trim().length, media: b.querySelectorAll('img,canvas,svg,video,iframe,input,button,select,textarea').length, nodes: b.querySelectorAll('*').length }; })()";

  /** 콘솔 오류 · 실패한 요청을 하나 더한다 (같은 글은 횟수만 올림) */
  function addItem(list, item) {
    const key = `${item.kind || ''}|${item.text || item.url || ''}`;
    const hit = list.find((x) => `${x.kind || ''}|${x.text || x.url || ''}` === key);
    if (hit) {
      hit.count = (hit.count || 1) + 1;
      return list;
    }
    return [{ ...item, count: 1 }, ...list].slice(0, MAX_ITEMS);
  }

  /** 실패한 요청인지: 상태 코드 400 이상 · 연결 오류 (사용자가 멈춘 것 net::ERR_ABORTED · 파비콘 404는 뺀다) */
  function isFailedRequest({ statusCode, error, url } = {}) {
    if (error) return !/ERR_ABORTED/.test(String(error));
    if (/\/favicon\.ico(\?|$)/i.test(String(url || ''))) return false;
    return Number(statusCode) >= 400;
  }

  /**
   * 판정 → { level: 'wait'|'ok'|'warn'|'error', key, n }
   *   error: 페이지를 못 엶 · 빈 화면 · 콘솔 오류 / warn: 실패한 요청만 / ok: 문제 없음 / wait: 읽는 중
   */
  function verdict(h) {
    if (!h) return { level: 'wait', key: 'none' };
    if (h.loadError) return { level: 'error', key: 'loadError' };
    if (h.loading) return { level: 'wait', key: 'loading' };
    const errors = (h.errors || []).reduce((n, x) => n + (x.count || 1), 0);
    const failed = (h.failed || []).reduce((n, x) => n + (x.count || 1), 0);
    if (h.blank) return { level: 'error', key: 'blank', errors, failed };
    if (errors) return { level: 'error', key: 'errors', errors, failed };
    if (failed) return { level: 'warn', key: 'failed', errors, failed };
    return { level: 'ok', key: 'ok', errors, failed };
  }

  return { MAX_ITEMS, PROBE_JS, empty, blankFrom, addItem, isFailedRequest, verdict };
});
