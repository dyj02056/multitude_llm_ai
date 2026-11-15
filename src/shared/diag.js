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

  // 화면 문구 (v0.30.0): 부를 때마다 사전에서 찾는다 (언어를 바꾸면 바로 반영). 사전이 없는 곳(서비스 페이지 등)에서는 키 이름 그대로
  const t = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };

  const PARTS = ['input', 'send', 'response'];
  const partText = (p) => t(`main.diag.part.${p}`); // 입력창 · 보내기 버튼 · 답변 영역
  // 화면(renderer.js)이 D.PART_TEXT[p] · D.STATE_TEXT[s] · D.HINT로 읽는다 → 읽을 때마다 사전에서 찾는 값
  const lazyMap = (keys, prefix) => Object.defineProperties({}, Object.fromEntries(keys.map((k) => [k, { get: () => t(prefix + k), enumerable: true }])));
  const PART_TEXT = lazyMap(PARTS, 'main.diag.part.');
  // 'ok' 찾음 · 'warn' 대신 다른 방법으로 됨 · 'fail' 못 찾음 · 'unknown' 아직 모름
  const MARK = { ok: '✓', warn: '△', fail: '✕', unknown: '–' };
  const FAIL_LIMIT = 2; // 답변 영역은 연달아 이만큼 못 찾으면 "못 찾음" (한 번은 사이트 사정일 수 있음)

  /** onChange(id, status): 서비스 하나의 상태가 바뀌었을 때 */
  function createDiag({ onChange } = {}) {
    const rows = new Map(); // id -> { input, send, response, notes: { part: 글 }, misses, at }

    const row = (id) => {
      if (!rows.has(id)) rows.set(id, { input: 'unknown', send: 'unknown', response: 'unknown', notes: {}, misses: 0, at: 0, limit: null });
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
      else if (row(id).input === 'unknown' || row(id).input === 'warn') set(id, 'input', 'warn', t('main.diag.inputNotSeen'));
    }

    /** 보내기 결과: { ok, via: 'button' | 'key' | …, code: 'no-input' | … } */
    function fromSend(id, res) {
      if (!res) return;
      if (!res.ok) {
        if (res.code === 'no-input') set(id, 'input', 'fail', res.error || t('main.diag.inputNotFound'));
        return;
      }
      set(id, 'input', 'ok');
      if (/^button/.test(res.via || '')) set(id, 'send', 'ok');
      else if (/^key/.test(res.via || '')) set(id, 'send', 'warn', t('main.diag.sentWithEnter'));
    }

    /** 답변 감시 결과: 'done' · 'no-answer' · 'timeout' */
    function fromAnswer(id, state) {
      const r = row(id);
      if (state === 'done') {
        r.misses = 0;
        set(id, 'response', 'ok');
      } else if (state === 'no-answer') {
        r.misses += 1;
        if (r.misses >= FAIL_LIMIT) set(id, 'response', 'fail', t('main.diag.answerMissedN', { n: r.misses }));
        else set(id, 'response', r.response === 'ok' ? 'ok' : 'warn', t('main.diag.answerMissedOnce'));
      }
    }

    /** 사용 한도 안내를 찾았을 때 그 문구, 정상으로 끝났으면 null (셀렉터 상태와 따로 보여 준다) */
    function setLimit(id, text) {
      const r = row(id);
      const before = JSON.stringify(status(id));
      r.limit = text ? String(text).slice(0, 160) : null;
      const now = status(id);
      if (JSON.stringify(now) !== before) onChange?.(id, now);
    }

    /**
     * 서비스 하나의 상태 → { input, send, response, level: 'ok' | 'warn' | 'broken' | 'unknown', message, hint, notes,
     *   limit: 한도 문구 | null, limitHint }
     */
    function status(id) {
      const r = rows.get(id) || { input: 'unknown', send: 'unknown', response: 'unknown', notes: {}, limit: null };
      const states = PARTS.map((p) => r[p]);
      const failed = PARTS.filter((p) => r[p] === 'fail');
      const level = failed.length ? 'broken' : states.includes('warn') ? 'warn' : states.every((s) => s === 'unknown') ? 'unknown' : 'ok';
      const message = failed.length ? t('main.diag.broken', { parts: failed.map(partText).join(' · ') }) : '';
      const notes = PARTS.filter((p) => r.notes[p]).map((p) => `${partText(p)}: ${r.notes[p]}`);
      return { input: r.input, send: r.send, response: r.response, level, message, hint: failed.length ? t('main.diag.hint') : '', notes, limit: r.limit || null, limitHint: r.limit ? t('main.diag.limitHint') : '' };
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

    return { fromProbe, fromSend, fromAnswer, setLimit, status, all, reset };
  }

  const STATES = ['ok', 'warn', 'fail', 'unknown']; // 찾음 · 다른 방법으로 됨 · 못 찾음 · 확인 전
  const stateText = (s) => t(`main.diag.state.${STATES.includes(s) ? s : 'unknown'}`);
  const STATE_TEXT = lazyMap(STATES, 'main.diag.state.');

  /**
   * [진단 정보 복사]용 글 (v0.21.1): 셀렉터를 고칠 때 필요한 것만 — 질문 · 답변 글 · 주소의 경로는 넣지 않는다.
   * info: { service: { id, name }, status: status() 결과, remote: 원격 셀렉터 상태, app: 앱 버전, where: 'Windows 앱' | '크롬 확장', host: 패널 페이지 호스트, now }
   */
  function report({ service, status, remote = {}, app = '', where = '', host = '', now = Date.now() }) {
    const st = status || {};
    const r = remote || {};
    const remoteLine =
      r.source === 'remote' || r.source === 'cache'
        ? `${t('main.diag.remote', { version: r.version ?? '?' })}${r.updated ? ` (${r.updated})` : ''}${r.source === 'cache' ? ` · ${t('main.diag.cached')}` : ''}`
        : t('main.diag.builtin');
    return [
      t('main.diag.reportTitle', { time: new Date(now).toISOString() }),
      `${t('main.diag.app', { version: app || '?' })}${where ? ` · ${where}` : ''}`,
      `${t('main.diag.service', { name: service?.name || '?', id: service?.id || '?' })}${host ? ` · ${host}` : ''}`,
      `${t('main.diag.selectors', { line: remoteLine })}${r.error ? ` · ${t('main.diag.lastFailed', { error: r.error })}` : ''}`,
      ...PARTS.map((p) => `- ${partText(p)}: ${MARK[st[p]] || '–'} ${stateText(st[p])}`),
      ...(st.notes || []).map((n) => `  · ${n}`),
      st.limit ? t('main.diag.limitQuote', { text: String(st.limit).slice(0, 120) }) : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    PARTS,
    PART_TEXT,
    MARK,
    get HINT() {
      return t('main.diag.hint');
    },
    get LIMIT_HINT() {
      return t('main.diag.limitHint');
    },
    STATE_TEXT,
    createDiag,
    report,
  };
});
