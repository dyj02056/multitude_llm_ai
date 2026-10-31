// 질문·답변 기록. 최근 것부터 담는다. 저장 방법(파일 / chrome.storage)은 쓰는 쪽이 save로 넘긴다.
// 기록 하나 = 공통 입력창으로 보낸 질문 한 번(라운드):
//   { id, at, question, targets: [id], files: [{ name, size, type }], answers: { [svcId]: { name, state, text, md } },
//     synth: [{ judge, at, text, md, mode?: 'analysis', names? }] }  (mode 'analysis' = 답변 일치·이견 분석, names = 비교한 AI 이름)   (첨부 파일은 이름·크기·종류만 남기고 내용은 저장하지 않는다)
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.historyCore)이 같이 쓴다.
//
// [쉽게 말하면] 질문·답변 기록장(최근 500개)을 다루는 공통 부품입니다: 새 기록 추가, 답변 채우기, 검색, 지우기.
// 실제 저장 장소는 Windows 앱(파일)과 크롬 확장(확장 저장소)이 각자 정해 save 함수로 넘겨줍니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).historyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_RECORDS = 500;
  const SAVE_DELAY_MS = 500;

  /** save(records): 바뀐 기록 전체를 저장한다. 답변이 끝날 때마다 바뀌므로 잠깐 모았다가 한 번에 부른다. */
  function createHistory(save) {
    let records = [];
    let saveTimer = null;

    function changed() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(records), SAVE_DELAY_MS);
    }

    function load(data) {
      records = Array.isArray(data) ? data : [];
    }

    function add({ question, targets, files = [] }) {
      const rec = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(),
        question,
        targets,
        files,
        answers: {},
        synth: [],
      };
      records.unshift(rec);
      if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
      changed();
      return rec.id;
    }

    const find = (id) => records.find((r) => r.id === id);

    function setAnswer(id, svcId, answer) {
      const rec = find(id);
      if (!rec) return;
      rec.answers[svcId] = answer;
      changed();
    }

    function addSynth(id, synth) {
      const rec = find(id);
      if (!rec) return;
      rec.synth.push(synth);
      changed();
    }

    /** 목록용 요약. query가 있으면 질문·답변 글에서 찾는다 (대소문자 무시). */
    function list(query = '') {
      const q = query.trim().toLowerCase();
      const hit = (r) =>
        !q ||
        r.question.toLowerCase().includes(q) ||
        (r.files || []).some((f) => f.name.toLowerCase().includes(q)) ||
        Object.values(r.answers).some((a) => (a.text || '').toLowerCase().includes(q)) ||
        r.synth.some((s) => (s.text || '').toLowerCase().includes(q));
      return records.filter(hit).map((r) => ({
        id: r.id,
        at: r.at,
        question: r.question.slice(0, 200),
        answered: Object.values(r.answers).filter((a) => a.text).length,
        targets: r.targets.length,
        synth: r.synth.filter((s) => s.mode !== 'analysis').length,
        analysis: r.synth.filter((s) => s.mode === 'analysis').length,
        files: (r.files || []).length,
      }));
    }

    function get(id) {
      return find(id) || null;
    }

    /**
     * 응답 통계 (v0.13.0): 저장된 기록의 답변마다 남긴 숫자(metrics)로 서비스별로 센다. 기록을 지우면 통계도 같이 사라진다.
     * 정확도는 재지 않는다 — 보내기 성공 · 완료 · 실패 · 시간 · 글자 수처럼 사실인 숫자만.
     * → { records: 기록 수, since: 가장 오래된 기록 시각, rows: [{ id, name, asked, sent, sendFail, done, timeout, noAnswer, limit,
     *       firstMedianMs, doneMedianMs, charsAvg }] } (질문을 많이 받은 순)
     */
    function stats() {
      const by = new Map();
      const median = (xs) => {
        if (!xs.length) return null;
        const s = [...xs].sort((x, y) => x - y);
        const m = Math.floor(s.length / 2);
        return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
      };
      for (const r of records) {
        for (const id of r.targets || []) {
          const a = r.answers?.[id];
          if (!by.has(id)) by.set(id, { id, name: a?.name || id, asked: 0, sent: 0, sendFail: 0, done: 0, timeout: 0, noAnswer: 0, limit: 0, first: [], doneMs: [], chars: [] });
          const row = by.get(id);
          if (a?.name) row.name = a.name;
          row.asked++;
          const m = a?.metrics;
          if (!a) continue; // 아직 답을 기다리는 중이거나 앱이 닫혀 결과가 없는 질문
          if (a.state === 'error' || m?.sendOk === false) row.sendFail++;
          else row.sent++;
          if (a.state === 'done') row.done++;
          else if (a.state === 'timeout') row.timeout++;
          else if (a.state === 'no-answer') row.noAnswer++;
          if (m?.limit) row.limit++;
          if (Number.isFinite(m?.firstMs)) row.first.push(m.firstMs);
          if (a.state === 'done' && Number.isFinite(m?.doneMs)) row.doneMs.push(m.doneMs);
          if (a.state === 'done' && Number.isFinite(m?.chars)) row.chars.push(m.chars);
        }
      }
      const rows = [...by.values()]
        .map(({ first, doneMs, chars, ...row }) => ({
          ...row,
          firstMedianMs: median(first),
          doneMedianMs: median(doneMs),
          charsAvg: chars.length ? Math.round(chars.reduce((n, x) => n + x, 0) / chars.length) : null,
        }))
        .sort((x, y) => y.asked - x.asked);
      return { records: records.length, since: records.length ? records[records.length - 1].at : null, rows };
    }

    function remove(id) {
      records = records.filter((r) => r.id !== id);
      changed();
    }

    function clear() {
      records = [];
      changed();
    }

    return { load, add, setAnswer, addSynth, list, get, stats, remove, clear };
  }

  return { createHistory };
});
