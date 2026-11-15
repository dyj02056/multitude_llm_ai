// 질문·답변 기록. 최근 것부터 담는다. 저장 방법(파일 / chrome.storage)은 쓰는 쪽이 save로 넘긴다.
// 기록 하나 = 공통 입력창으로 보낸 질문 한 번(라운드):
//   { id, at, question, targets: [id], files: [{ name, size, type }], answers: { [svcId]: { name, state, text, md } },
//     synth: [{ judge, at, text, md, mode?: 'analysis', names? }], feedback?: { [svcId]: 1 | -1 } }  (mode 'analysis' = 답변 일치·이견 분석, names = 비교한 AI 이름)   (첨부 파일은 이름·크기·종류만 남기고 내용은 저장하지 않는다)
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.historyCore)이 같이 쓴다.
//
// [쉽게 말하면] 질문·답변 기록장(기본 최근 500개)을 다루는 공통 부품입니다: 새 기록 추가, 답변 채우기, 검색, 지우기.
// 실제 저장 장소는 Windows 앱(파일)과 크롬 확장(확장 저장소)이 각자 정해 save 함수로 넘겨줍니다.
//
// 저장 (v0.24.0): save(records, info)의 info = { dirty: [바뀐 기록 id], order: 목록(추가 · 지우기 · 순서)이 바뀌었는가 }.
// 기록 하나마다 따로 저장하는 쪽(색인 + 기록별 파일)은 planWrites로 "쓸 기록 · 지울 id · 새 색인"만 골라 쓴다.
// 예전처럼 배열 전체를 저장하는 쪽은 info를 무시하면 된다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).historyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_RECORDS = 500; // 기본 최대 개수 (설정에서 바꿈)
  const MAX_CHOICES = [100, 500, 1000, 2000];
  const SAVE_DELAY_MS = 500;

  /** 설정의 최대 개수 → 고를 수 있는 값 중 하나 (모르는 값은 기본 500) */
  const normalizeMax = (n) => (MAX_CHOICES.includes(Number(n)) ? Number(n) : MAX_RECORDS);

  /** 기록 id가 파일 이름 · 저장소 키로 써도 안전한가 (영문 · 숫자 · - 만, 40자까지) */
  const okRecordId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(id);
  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  /**
   * 기록별 저장: 지금 기록(records) · 바뀐 정보(info) · 저장소에 있는 id(known: Set) →
   * { write: [쓸 기록], remove: [지울 id], index: [새 색인 id 순서] | null (안 바뀜) }
   * info.order가 없으면 색인과 지울 것은 보지 않는다 (답변 채우기처럼 기록 하나만 바뀐 경우).
   */
  function planWrites(records, info = {}, known = new Set()) {
    const ids = records.map((r) => r.id);
    const now = new Set(ids);
    const dirty = new Set(info.dirty || []);
    const write = records.filter((r) => dirty.has(r.id) || (info.order && !known.has(r.id)));
    if (!info.order) return { write, remove: [], index: null };
    const remove = [...known].filter((id) => !now.has(id));
    return { write, remove, index: ids };
  }

  // 답변 평가 (v0.23): 패널 머리줄의 [+1] / [-1]. 1 = 좋았음, -1 = 별로였음, 0 = 지우기
  const FEEDBACK_VALUES = new Set([1, -1, 0]);
  const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const okSvcId = (id) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(id) && !BAD_KEYS.has(id);

  /** 기록의 평가를 { svcId: 1 | -1 } 로 읽는다. 없거나 깨진 값(배열 · 글자 · 1/-1 아닌 값)은 건너뛴다 */
  function feedbackOf(rec) {
    const out = Object.create(null);
    const fb = rec && rec.feedback;
    if (!fb || typeof fb !== 'object' || Array.isArray(fb)) return out;
    for (const k of Object.keys(fb)) if (okSvcId(k) && (fb[k] === 1 || fb[k] === -1)) out[k] = fb[k];
    return out;
  }

  /**
   * save(records, info): 바뀐 기록을 저장한다. 답변이 끝날 때마다 바뀌므로 잠깐 모았다가 한 번에 부른다.
   * info = { dirty: [바뀐 기록 id], order: 목록이 바뀌었는가 } (맨 위 설명 참고). max: 최대 개수 (setMax로 바꿈)
   */
  function createHistory(save, { max = MAX_RECORDS } = {}) {
    let records = [];
    let saveTimer = null;
    let limit = normalizeMax(max);
    let dirty = new Set();
    let order = false;

    function emit() {
      const info = { dirty: [...dirty], order };
      dirty = new Set();
      order = false;
      save(records, info);
    }

    /** id: 내용이 바뀐 기록 (없으면 목록 자체가 바뀜 — 추가 · 지우기 · 비우기) */
    function changed(id) {
      if (id) dirty.add(id);
      else order = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        emit();
      }, SAVE_DELAY_MS);
    }

    /** 기다리는 저장이 있으면 바로 저장한다 (앱을 끌 때 마지막 0.5초 안의 변경을 잃지 않게). 없으면 아무것도 안 함 */
    function flush() {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      emit();
    }

    function load(data) {
      records = Array.isArray(data) ? data : [];
    }

    /** 최대 개수를 바꾼다. 줄이면 오래된 기록부터 지운다 → 지운 개수 */
    function setMax(n) {
      limit = normalizeMax(n);
      const over = records.length - limit;
      if (over <= 0) return 0;
      records.length = limit;
      changed();
      return over;
    }

    function add({ question, targets, files = [], source, page }) {
      const rec = {
        id: newId(),
        at: Date.now(),
        question,
        targets,
        files,
        answers: {},
        synth: [],
        ...(source ? { source } : {}), // 'side' = 사이드탭에서 보낸 질문 (v0.21.0)
        ...(page ? { page } : {}), // 사이드탭: 함께 보낸 페이지 { title, url }
      };
      records.unshift(rec);
      if (records.length > limit) records.length = limit;
      changed(rec.id);
      changed();
      return rec.id;
    }

    const find = (id) => records.find((r) => r.id === id);

    function setAnswer(id, svcId, answer) {
      const rec = find(id);
      if (!rec) return;
      rec.answers[svcId] = answer;
      changed(id);
    }

    /**
     * 답변 평가를 남긴다: value 1(좋았음) · -1(별로였음) · 0(지우기). svcId는 그 기록에 보낸 AI(targets 또는 answers)만.
     * → 남긴 값(1 · -1 · 0) | null (기록이 없거나 값이 잘못됨)
     */
    function setFeedback(id, svcId, value) {
      if (!okSvcId(svcId) || !FEEDBACK_VALUES.has(value)) return null;
      const rec = find(id);
      if (!rec) return null;
      const known =
        (Array.isArray(rec.targets) && rec.targets.includes(svcId)) ||
        (rec.answers && typeof rec.answers === 'object' && hasOwn(rec.answers, svcId));
      if (!known) return null;
      const fb = feedbackOf(rec);
      if (value) fb[svcId] = value;
      else delete fb[svcId];
      if (Object.keys(fb).length) rec.feedback = { ...fb };
      else delete rec.feedback;
      changed(id);
      return value;
    }

    function addSynth(id, synth) {
      const rec = find(id);
      if (!rec) return;
      rec.synth.push(synth);
      changed(id);
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
        ...(r.source ? { source: r.source } : {}),
      }));
    }

    function get(id) {
      return find(id) || null;
    }

    /** 지금 기록 전체 (사이드탭 기록을 앱 탭과 맞출 때) */
    const all = () => records;

    /**
     * 응답 통계 (v0.13.0): 저장된 기록의 답변마다 남긴 숫자(metrics)로 서비스별로 센다. 기록을 지우면 통계도 같이 사라진다.
     * 정확도는 재지 않는다 — 보내기 성공 · 완료 · 실패 · 시간 · 글자 수처럼 사실인 숫자만.
     * → { records: 기록 수, since: 가장 오래된 기록 시각, rows: [{ id, name, asked, sent, sendFail, done, timeout, noAnswer, limit,
     *       firstMedianMs, doneMedianMs, charsAvg, good, bad, satisfaction }] } (질문을 많이 받은 순)
     *   good · bad: 답변 평가 [+1] · [-1] 수, satisfaction: good / (good + bad) (평가가 없으면 null)
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
        if (!r || typeof r !== 'object') continue;
        const fb = feedbackOf(r);
        for (const id of Array.isArray(r.targets) ? r.targets : []) {
          const a = r.answers?.[id];
          if (!by.has(id)) by.set(id, { id, name: a?.name || id, asked: 0, sent: 0, sendFail: 0, done: 0, timeout: 0, noAnswer: 0, limit: 0, good: 0, bad: 0, first: [], doneMs: [], chars: [] });
          const row = by.get(id);
          if (a?.name) row.name = a.name;
          row.asked++;
          if (okSvcId(id) && fb[id] === 1) row.good++;
          else if (okSvcId(id) && fb[id] === -1) row.bad++;
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
          satisfaction: row.good + row.bad ? row.good / (row.good + row.bad) : null,
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

    return { load, add, setAnswer, setFeedback, addSynth, list, get, stats, remove, clear, all, flush, setMax, max: () => limit };
  }

  /**
   * 예전 기록(배열)을 기록별 저장소에 옮길 수 있게 다듬는다: 객체가 아니면 버리고, id가 파일 이름 · 저장소 키로 안전하지 않거나
   * 겹치면 새 id를 준다 (내용은 그대로). Windows 앱 · 크롬 확장이 같이 쓴다.
   */
  function cleanLegacy(data) {
    const seen = new Set();
    const out = [];
    for (const r of Array.isArray(data) ? data : []) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      let id = r.id;
      while (!okRecordId(id) || seen.has(id)) id = newId();
      seen.add(id);
      out.push(id === r.id ? r : { ...r, id });
    }
    return out;
  }

  const AREA_INDEX = 'history:index';
  const areaKey = (id) => `history:r:${id}`;

  /**
   * 크롬 확장용 기록별 저장 (v0.24.0): 'history:index' = { v: 2, ids }, 'history:r:<id>' = 기록 하나. 바뀐 기록만 쓴다.
   * area: chrome.storage.local 모양 { get(keys) → Promise<obj>, set(obj) → Promise, remove(keys) → Promise }
   * legacyKey: 예전에 배열 전체를 두던 칸 ('history') — 처음 읽을 때 옮기고 지운다.
   * → { save(records, info): history-core의 save, load(): Promise<기록 배열> }
   */
  function createAreaStore(area, { legacyKey = 'history', onError = () => {} } = {}) {
    let known = new Set();
    function save(records, info) {
      const plan = planWrites(records, info, known);
      const set = {};
      for (const r of plan.write) set[areaKey(r.id)] = r;
      if (plan.index) {
        set[AREA_INDEX] = { v: 2, ids: plan.index };
        known = new Set(plan.index);
      }
      const jobs = [];
      if (Object.keys(set).length) jobs.push(Promise.resolve(area.set(set)).catch(onError));
      if (plan.remove.length) jobs.push(Promise.resolve(area.remove(plan.remove.map(areaKey))).catch(onError));
      return Promise.all(jobs);
    }
    async function load() {
      const got = await Promise.resolve(area.get(AREA_INDEX)).catch(() => ({}));
      const idx = got && got[AREA_INDEX];
      if (idx && Array.isArray(idx.ids)) {
        const ids = idx.ids.filter(okRecordId);
        const recs = ids.length ? await Promise.resolve(area.get(ids.map(areaKey))).catch(() => ({})) : {};
        const records = ids.map((id) => recs && recs[areaKey(id)]).filter((r) => r && typeof r === 'object' && okRecordId(r.id));
        known = new Set(records.map((r) => r.id));
        return records;
      }
      const old = await Promise.resolve(area.get(legacyKey)).catch(() => ({}));
      if (!old || !Array.isArray(old[legacyKey])) return [];
      const records = cleanLegacy(old[legacyKey]);
      const set = { [AREA_INDEX]: { v: 2, ids: records.map((r) => r.id) } };
      for (const r of records) set[areaKey(r.id)] = r;
      try {
        await area.set(set);
        await area.remove(legacyKey); // 새 칸에 다 쓴 뒤에만 예전 칸을 지운다
      } catch (err) {
        onError(err);
      }
      known = new Set(records.map((r) => r.id));
      return records;
    }
    return { save, load };
  }

  return {
    createHistory,
    createAreaStore,
    feedbackOf,
    planWrites,
    okRecordId,
    newId,
    cleanLegacy,
    normalizeMax,
    MAX_RECORDS,
    MAX_CHOICES,
  };
});
