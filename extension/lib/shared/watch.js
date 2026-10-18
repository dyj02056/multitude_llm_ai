// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/watch.js)
// 답변이 다 써졌는지 지켜본다.
// 완료 판단: 답변이 시작된 뒤 "중지" 버튼이 사라지고, 최신 답변 글이 일정 시간 바뀌지 않으면 완료.
// 중지 버튼을 못 찾는 서비스(DeepSeek 등)도 글이 멈춘 것만으로 완료를 판단할 수 있다.
// 페이지를 읽는 방법(getSnap)만 바꿔 끼워서 Electron 앱과 크롬 확장 프로그램(전역 MLA.watch)이 같이 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).watch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const POLL_MS = 700;
  const LATE_POLL_MS = 3000; // 시간 초과 뒤에는 천천히 계속 지켜본다
  const STABLE_POLLS = 3; // 약 2초 동안 글이 그대로면 완료
  const DEFAULT_START_MS = 90 * 1000; // 이 안에 답변이 시작되지 않으면 포기 (생각이 긴 모델도 중지 버튼은 바로 뜬다)
  const DEFAULT_MAX_MS = 20 * 60 * 1000; // 이 시간이 지나면 "시간 초과"로 알린다
  const LATE_EXTRA_MS = 60 * 60 * 1000; // 시간 초과 뒤에도 이만큼은 더 지켜보다가 끝나면 "완료"로 바꾼다

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 보낸 뒤부터 답변이 끝날 때까지 지켜본다.
   * getSnap(): 페이지의 지금 상태 { stop, count, text } (읽지 못하면 null)
   * before: 보내기 직전 상태. isCurrent(): 이 감시가 아직 유효한지 (새로 보내거나 패널이 닫히면 false).
   * onState(state, info): 'answering' | 'done' | 'timeout' | 'no-answer'
   *   시간 초과(timeout) 뒤에 답변이 끝나면 'done'이 한 번 더 온다 (info.late = true).
   * opts.maxMs: 시간 초과까지 기다릴 시간, opts.startMs: 답변 시작을 기다릴 시간
   */
  async function watchAnswer(getSnap, before, isCurrent, onState, opts = {}) {
    const maxMs = opts.maxMs || DEFAULT_MAX_MS;
    const startMs = opts.startMs || DEFAULT_START_MS;
    const startAt = Date.now();
    let started = false;
    let late = false;
    let lastText = null;
    let stable = 0;

    while (isCurrent()) {
      await sleep(late ? LATE_POLL_MS : POLL_MS);
      const snap = await getSnap();
      if (!snap || !isCurrent()) continue;

      if (!started) {
        const changed = snap.count > (before?.count ?? 0) || (snap.text && snap.text !== (before?.text ?? ''));
        if (snap.stop || changed) {
          started = true;
          onState('answering');
        } else if (Date.now() - startAt > startMs) {
          return onState('no-answer');
        }
        continue;
      }

      if (!snap.stop && snap.text && snap.text === lastText) stable++;
      else stable = 0;
      lastText = snap.text;

      // 천천히 지켜볼 때는 한 번만 같아도 충분하다 (간격이 길다).
      if (stable >= (late ? 1 : STABLE_POLLS)) return onState('done', { chars: snap.text.length, late });
      const elapsed = Date.now() - startAt;
      if (!late && elapsed > maxMs) {
        late = true;
        onState('timeout');
      } else if (late && elapsed > maxMs + LATE_EXTRA_MS) {
        return;
      }
    }
  }

  return { watchAnswer };
});
