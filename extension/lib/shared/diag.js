// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/diag.js)
// 셀렉터 자가진단: 패널마다 입력창 · 보내기 버튼 · 답변 영역을 찾았는지 기록한다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.diag)이 같이 쓴다.
//
// [쉽게 말하면]
// AI 사이트가 화면을 바꾸면 앱이 입력창이나 답변을 못 찾게 됩니다. 그걸 빨리 알아채려고
// 실제로 보내고 답을 읽을 때마다 "찾았다 / 못 찾았다"를 적어 둡니다.
//   - 입력창: 페이지가 열린 뒤 살펴보기(probe)와 보내기 결과로
//   - 보내기 버튼: 보내기 결과로 (버튼을 못 찾아 Enter 키로 보냈으면 "주의")
//   - 답변 영역: 답변을 기다린 결과로 (보냈는데 답변이 잡히지 않으면 "못 찾음")
// 하나라도 "못 찾음"이면 패널 머리줄에 ⚠ 화면이 바뀐 것 같음을 띄우고, 설정 화면에 서비스별 표를 보여 줍니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).diag = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PARTS = ['input', 'send', 'response'];
  const PART_TEXT = { input: '입력창', send: '보내기 버튼', response: '답변 영역' };
  // 'ok' 찾음 · 'warn' 대신 다른 방법으로 됨 · 'fail' 못 찾음 · 'unknown' 아직 모름
  const MARK = { ok: '✓', warn: '△', fail: '✕', unknown: '–' };
  const HINT =
    '사이트 화면이 바뀌어 앱이 이 부분을 찾지 못한 것 같습니다. ' +
    '① ⌂로 처음 화면으로 돌아가 다시 해 보고, ② 설정(?)의 "사이트 셀렉터 자동 갱신 › 지금 확인"을 누르세요. ' +
    '③ 그래도 계속되면 패널에서 직접 입력하고, 앱 업데이트를 기다려 주세요.';
  const FAIL_LIMIT = 2; // 답변 영역은 연달아 이만큼 못 찾으면 "못 찾음" (한 번은 사이트 사정일 수 있음)

  /** onChange(id, status): 서비스 하나의 상태가 바뀌었을 때 */
  function createDiag({ onChange } = {}) {
    const rows = new Map(); // id -> { input, send, response, notes: { part: 글 }, misses, at }

    const row = (id) => {
      if (!rows.has(id)) rows.set(id, { input: 'unknown', send: 'unknown', response: 'unknown', notes: {}, misses: 0, at: 0 });
      return rows.get(id);
    };

    function set(id, part, value, note) {
      const r = row(id);
      const before = JSON.stringify(status(id));
      r[part] = value;
      if (note) r.notes[part] = note;
      else delete r.notes[part];
      r.at = Date.now();
      const now = status(id);
      if (JSON.stringify(now) !== before) onChange?.(id, now);
    }

    /**
     * 페이지가 열린 뒤 살펴본 결과 (로그인된 상태에서만 부른다): { input: 찾았는지 }
     * 살펴보기만으로는 "못 찾음"(✕)으로 정하지 않고 "주의"(△)까지만 둔다 — 오류 페이지 · 점검 안내 · 팝업처럼
     * 셀렉터와 상관없이 입력창이 안 보이는 때가 많아서다. ✕는 실제로 보낼 때 입력창을 못 찾았을 때만.
     * 이미 확인한 입력창(ok · fail)은 살펴보기 한 번으로 바꾸지 않는다.
     */
    function fromProbe(id, probe) {
      if (!probe || typeof probe.input !== 'boolean') return;
      if (probe.input) set(id, 'input', 'ok');
      else if (row(id).input === 'unknown' || row(id).input === 'warn') set(id, 'input', 'warn', '페이지에서 입력창이 보이지 않았습니다 (보낼 때 다시 확인)');
    }

    /** 보내기 결과: { ok, via: 'button' | 'key' | …, code: 'no-input' | … } */
    function fromSend(id, res) {
      if (!res) return;
      if (!res.ok) {
        if (res.code === 'no-input') set(id, 'input', 'fail', res.error || '입력창을 찾지 못했습니다');
        return;
      }
      set(id, 'input', 'ok');
      if (/^button/.test(res.via || '')) set(id, 'send', 'ok');
      else if (/^key/.test(res.via || '')) set(id, 'send', 'warn', '보내기 버튼을 찾지 못해 Enter 키로 보냈습니다');
    }

    /** 답변 감시 결과: 'done' · 'no-answer' · 'timeout' */
    function fromAnswer(id, state) {
      const r = row(id);
      if (state === 'done') {
        r.misses = 0;
        set(id, 'response', 'ok');
      } else if (state === 'no-answer') {
        r.misses += 1;
        if (r.misses >= FAIL_LIMIT) set(id, 'response', 'fail', `보낸 뒤 답변을 ${r.misses}번 연달아 찾지 못했습니다`);
        else set(id, 'response', r.response === 'ok' ? 'ok' : 'warn', '보낸 뒤 답변을 찾지 못했습니다 (한 번)');
      }
    }

    /** 서비스 하나의 상태 → { input, send, response, level: 'ok' | 'warn' | 'broken' | 'unknown', message, hint, notes } */
    function status(id) {
      const r = rows.get(id) || { input: 'unknown', send: 'unknown', response: 'unknown', notes: {} };
      const states = PARTS.map((p) => r[p]);
      const failed = PARTS.filter((p) => r[p] === 'fail');
      const level = failed.length ? 'broken' : states.includes('warn') ? 'warn' : states.every((s) => s === 'unknown') ? 'unknown' : 'ok';
      const message = failed.length ? `⚠ 화면이 바뀐 것 같음 (${failed.map((p) => PART_TEXT[p]).join(' · ')})` : '';
      const notes = PARTS.filter((p) => r.notes[p]).map((p) => `${PART_TEXT[p]}: ${r.notes[p]}`);
      return { input: r.input, send: r.send, response: r.response, level, message, hint: failed.length ? HINT : '', notes };
    }

    /** 모든 서비스의 상태 { id: status } (설정 화면의 표) */
    function all(ids) {
      return Object.fromEntries((ids || [...rows.keys()]).map((id) => [id, status(id)]));
    }

    /** 셀렉터를 새로 받았을 때 등: 기록을 지우고 다시 확인한다 */
    function reset(id) {
      const ids = id ? [id] : [...rows.keys()];
      for (const x of ids) {
        rows.delete(x);
        onChange?.(x, status(x));
      }
    }

    return { fromProbe, fromSend, fromAnswer, status, all, reset };
  }

  return { PARTS, PART_TEXT, MARK, HINT, createDiag };
});
