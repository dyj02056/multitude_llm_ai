// OS 알림 (v0.25.0): 무엇을 언제 알릴지와 알림 글을 정한다.
// 알릴 일: 한 번에 보낸 질문의 답변이 모두 끝남(round) · 사용 한도에 걸림(limit) · 보내기 실패(error) · 종합 · 분석이 끝남(synth).
// 앱 창(확장은 앱 탭)을 보고 있는 동안에는 알리지 않는다. 알림 글에는 질문 · 답변 글을 넣지 않고 개수와 서비스 이름만 쓴다.
// 실제로 띄우는 일은 쓰는 쪽이 한다 (Windows 앱: Electron Notification / 크롬 확장: chrome.notifications).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.notify)이 같이 쓴다. 화면에서는 i18n.js를 먼저 읽어야 한다.
//
// [쉽게 말하면] 다른 창을 보고 있을 때 "답변 4개 완료" 같은 윈도우 · 크롬 알림을 띄울지 정하고 그 글을 만드는 부품입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).notify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (i18n) {
  'use strict';

  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);
  const KINDS = ['round', 'limit', 'error', 'synth'];
  const DEFAULT_PREFS = { round: true, limit: true, error: true, synth: true };
  // 한도 · 보내기 실패는 여러 패널에서 거의 동시에 오므로 이 시간 안에 온 것을 알림 하나로 묶는다
  const MERGE_MS = 1500;

  /** 저장된 알림 설정을 맞춘다: 아는 종류만, 값이 없거나 틀리면 켬 */
  function normalizePrefs(v) {
    const src = v && typeof v === 'object' ? v : {};
    return Object.fromEntries(KINDS.map((k) => [k, typeof src[k] === 'boolean' ? src[k] : DEFAULT_PREFS[k]]));
  }

  /** 화면이 보낸 설정 바꾸기 값 검사: 아는 종류의 true/false만 → 바꿀 것 | null */
  function cleanPatch(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    for (const k of KINDS) if (typeof v[k] === 'boolean') out[k] = v[k];
    return Object.keys(out).length ? out : null;
  }

  /** 답변 상태 목록 → 개수 { total, done, timeout, noAnswer, error } */
  function countStates(states) {
    const list = Array.isArray(states) ? states : [];
    const n = (s) => list.filter((x) => x === s).length;
    return { total: list.length, done: n('done'), timeout: n('timeout'), noAnswer: n('no-answer'), error: n('error') };
  }

  const names = (list) => [...new Set((list || []).filter((x) => typeof x === 'string' && x))].join(', ');

  /**
   * 알릴 일 → 알림 { kind, title, body, view(누르면 열 화면, 없으면 null) } | null
   * event: { kind: 'round', states } · { kind: 'limit' | 'error', names } · { kind: 'synth', ok, judge, mode }
   */
  function message(event) {
    const e = event || {};
    if (e.kind === 'round') {
      const c = countStates(e.states);
      if (!c.total) return null;
      const extra = [
        c.timeout && t('notify.timeout', { n: c.timeout }),
        c.noAnswer && t('notify.noAnswer', { n: c.noAnswer }),
        c.error && t('notify.sendFailed', { n: c.error }),
      ].filter(Boolean);
      const head = c.done === c.total ? t('notify.roundAll', { n: c.done }) : t('notify.roundSome', { done: c.done, total: c.total });
      return { kind: 'round', title: t('notify.roundTitle'), body: extra.length ? `${head} (${extra.join(', ')})` : head, view: null };
    }
    if (e.kind === 'limit' || e.kind === 'error') {
      const who = names(e.names);
      if (!who) return null;
      return { kind: e.kind, title: t(`notify.${e.kind}Title`), body: t(`notify.${e.kind}Body`, { names: who }), view: null };
    }
    if (e.kind === 'synth') {
      const what = t(e.mode === 'analysis' ? 'notify.analysis' : e.mode === 'debate' ? 'notify.debate' : 'notify.synth');
      const judge = typeof e.judge === 'string' && e.judge ? e.judge : 'AI';
      return {
        kind: 'synth',
        title: t('notify.synthTitle', { what }),
        body: t(e.ok ? 'notify.synthDone' : 'notify.synthFailed', { judge, what }),
        view: e.ok && (e.mode === 'analysis' || e.mode === 'debate') ? 'compare' : null, // 토론 결론도 답변 비교 화면에서 (v0.26.0)
      };
    }
    return null;
  }

  /** 알릴지: 그 종류를 켜 두었고 앱을 보고 있지 않을 때만 */
  const wanted = (kind, prefs, focused) => !focused && KINDS.includes(kind) && normalizePrefs(prefs)[kind];

  /**
   * 알림 보내는 곳. opts: { show({ kind, title, body, view }), isFocused(), prefs(), mergeMs, setTimer(테스트용) }
   * → { notify(event) } — 한도 · 보내기 실패는 MERGE_MS 안에 온 것을 서비스 이름을 모아 하나로 띄운다.
   */
  function createNotifier(opts) {
    const o = { mergeMs: MERGE_MS, setTimer: setTimeout, ...opts };
    const pending = new Map(); // kind -> { names: [], timer }

    function emit(event) {
      if (!wanted(event.kind, o.prefs(), safeFocused())) return;
      const msg = message(event);
      if (msg) o.show(msg);
    }
    function safeFocused() {
      try {
        return !!o.isFocused();
      } catch {
        return false;
      }
    }

    function notify(event) {
      if (!event || !KINDS.includes(event.kind)) return;
      if (event.kind !== 'limit' && event.kind !== 'error') return emit(event);
      if (!wanted(event.kind, o.prefs(), false)) return; // 꺼 두었으면 모으지도 않는다
      const p = pending.get(event.kind) || { names: [] };
      p.names.push(event.name);
      if (!p.timer) {
        p.timer = o.setTimer(() => {
          pending.delete(event.kind);
          emit({ kind: event.kind, names: p.names });
        }, o.mergeMs);
      }
      pending.set(event.kind, p);
    }

    return { notify };
  }

  return { KINDS, DEFAULT_PREFS, MERGE_MS, normalizePrefs, cleanPatch, countStates, message, createNotifier };
});
