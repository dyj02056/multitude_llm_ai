// 보내기 실패 · 답이 늦을 때 다시 보내기와, 사용 한도에 걸렸을 때 다른 AI 고르기 (v0.26.0).
// retryDecision: 실패한 패널을 어떻게 할지 — 보내기 실패는 잠깐 뒤 한 번 자동으로 다시 보내고(설정에서 끌 수 있음),
//   시간 초과 · 답변 없음은 사이트가 아직 답하는 중일 수 있어 자동으로 다시 보내지 않고 [다시 보내기] 버튼만 띄운다.
// pickFallback: 한도에 걸린 패널 대신 보낼 후보 — 열려 있고 한도에 걸리지 않은 패널, 응답 통계에서 빠른 순.
// Electron 앱(require)과 크롬 확장 프로그램 · 화면(전역 MLA.retry)이 같이 쓴다.
//
// [쉽게 말하면] "실패했으면 한 번만 더 보내 볼까, 사용자에게 버튼을 보여 줄까"를 정하고,
// "한도에 걸렸으면 어느 AI로 대신 보내면 좋을지" 빠른 순서로 골라 주는 계산 부품입니다. 스스로 바꿔 보내지는 않습니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).retry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RETRY_DELAY_MS = 1500; // 보내기 실패 뒤 다시 보낼 때까지 (페이지가 막 바뀌는 중이었을 수 있어 잠깐 기다린다)
  const MAX_AUTO = 1; // 자동으로 다시 보내는 횟수
  // 다시 보내도 소용없는 실패 (패널이 없음 · 보낼 것이 없음)
  const HOPELESS = [/패널이 (열려 있지 않|닫혔)/, /보낼 내용이 없/, /한도를 넘/, /panel (is not open|was closed)/i, /^Nothing to send/i, /exceeds? the (total size )?limit/i]; // 한국어 · 영어 오류 글 (v0.30.0)

  /**
   * state: 'error'(보내기 실패) · 'timeout' · 'no-answer' · 'done'
   * attempt: 이미 자동으로 다시 보낸 횟수, enabled: 설정 "실패하면 한 번 다시 보내기", error: 실패 글, limit: 사용 한도 문구를 찾았는지
   * → { action: 'resend'(자동으로 다시 보냄) | 'offer'([다시 보내기] 버튼) | 'none', delayMs? }
   */
  function retryDecision({ state, attempt = 0, enabled = true, error = '', limit = false } = {}) {
    if (state === 'timeout' || state === 'no-answer') return { action: 'offer' };
    if (state !== 'error') return { action: 'none' };
    if (limit) return { action: 'none' }; // 한도는 다시 보내도 같다 → 다른 AI로 보내기 제안
    if (HOPELESS.some((re) => re.test(String(error || '')))) return { action: 'none' };
    if (enabled && attempt < MAX_AUTO) return { action: 'resend', delayMs: RETRY_DELAY_MS };
    return { action: 'offer' };
  }

  /**
   * 한도에 걸린 패널(fromId) 대신 보낼 후보 → [id] (빠른 순, 첫 번째가 추천)
   * openIds: 열린 패널 순서, limitedIds: 한도에 걸린 패널, rows: history-core stats().rows (firstMedianMs · doneMedianMs)
   * 완료 시간 중앙값 → 첫 응답 중앙값 순으로 빠른 것, 통계가 없으면 뒤로 (같으면 열린 순서)
   */
  function pickFallback({ fromId, openIds = [], limitedIds = [], rows = [] } = {}) {
    const limited = new Set(limitedIds);
    const byId = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
    const num = (v) => (Number.isFinite(v) ? v : Infinity);
    return openIds
      .filter((id) => typeof id === 'string' && id !== fromId && !limited.has(id))
      .map((id, i) => ({ id, i, done: num(byId.get(id)?.doneMedianMs), first: num(byId.get(id)?.firstMedianMs) }))
      .sort((x, y) => x.done - y.done || x.first - y.first || x.i - y.i)
      .map((c) => c.id);
  }

  return { RETRY_DELAY_MS, MAX_AUTO, retryDecision, pickFallback };
});
