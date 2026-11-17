// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/history-core.js)
// 질문·답변 기록. 최근 것부터 담는다. 저장 방법(파일 / chrome.storage)은 쓰는 쪽이 save로 넘긴다.
// 기록 하나 = 공통 입력창으로 보낸 질문 한 번(라운드):
//   { id, at, question, targets: [id], files: [{ name, size, type }], answers: { [svcId]: { name, state, text, md } },
//     synth: [{ judge, at, text, md, mode?: 'analysis' | 'debate', names? }], feedback?: { [svcId]: 1 | -1 }, chain?: [이어 묻기 · 토론 (v0.26.0, cleanChain)] }  (mode 'analysis' = 답변 일치·이견 분석, names = 비교한 AI 이름)   (첨부 파일은 이름·크기·종류만 남기고 내용은 저장하지 않는다)
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.historyCore)이 같이 쓴다.
//
// [쉽게 말하면] 질문·답변 기록장(기본 최근 500개)을 다루는 공통 부품입니다: 새 기록 추가, 답변 채우기, 검색, 지우기.
// 실제 저장 장소는 Windows 앱(파일)과 크롬 확장(확장 저장소)이 각자 정해 save 함수로 넘겨줍니다.
//
// 저장 (v0.24.0): save(records, info)의 info = { dirty: [바뀐 기록 id], order: 목록(추가 · 지우기 · 순서)이 바뀌었는가 }.
// 기록 하나마다 따로 저장하는 쪽(색인 + 기록별 파일)은 planWrites로 "쓸 기록 · 지울 id · 새 색인"만 골라 쓴다.
// 예전처럼 배열 전체를 저장하는 쪽은 info를 무시하면 된다.
//
// v0.27.0: 기록에 threadId(같은 대화 줄기) · kind(질문 종류, shared/recommend.js) · project({ name }, 프로젝트 맥락을 붙여 보냄) ·
// tags(태그, 10개 · 30자까지) · star(즐겨찾기)를 더했다. 없는 예전 기록은 "없음"으로 본다 (옮기는 작업 없음).
// 찾기 · 거르기는 shared/history-search.js, 종류별 추천은 shared/recommend.js (화면에서는 이 파일보다 먼저 읽는다).
(function (root, factory) {
  const M = root.MLA || {};
  const api = factory(M.historySearch, M.recommend);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).historyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (searchLib, recommendLib) {
  'use strict';

  const HS = searchLib || require('./history-search');
  const RC = recommendLib || require('./recommend');

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

  // 이어 묻기 · 토론 (v0.26.0): 기록의 chain = [{ kind, at, ... }] (일어난 순서)
  //   handoff  : { intent: 'review' | 'counter' | 'continue', from, to, fromName, toName, state, text, md } — 한 답변을 다른 AI에게 넘김
  //   fallback : { from, to, fromName, toName, state, text, md } — 사용 한도에 걸린 AI 대신 다른 AI에게 같은 질문
  //   debate   : { round, rounds, answers: [{ id, name, state, text, md }] } — 토론 한 라운드 (결론은 synth의 mode 'debate')
  const CHAIN_KINDS = new Set(['handoff', 'fallback', 'debate', 'workflow']);
  const WORKFLOW_KINDS = new Set(['draft', 'critique', 'counter', 'revise', 'verify', 'continue']);
  const CHAIN_INTENTS = new Set(['review', 'counter', 'continue']);
  const DEBATE_ROLES = new Set(['pro', 'con', 'rebut']);
  const MAX_CHAIN = 60; // 기록 하나의 chain 최대 개수
  const MAX_CHAIN_TEXT = 200000; // 글 하나 최대 길이
  const MAX_NAME = 80;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const ANSWER_STATES = new Set(['done', 'timeout', 'no-answer', 'error', 'stopped']);
  const stateOf = (v) => (ANSWER_STATES.has(v) ? v : 'done');

  /** 이어 묻기 · 토론 한 줄 검사 → 깨끗한 값 | null (모르는 종류 · 잘못된 id · 라운드 번호는 받지 않는다) */
  function cleanChain(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !CHAIN_KINDS.has(e.kind)) return null;
    const at = Number.isFinite(e.at) && e.at > 0 ? Math.round(e.at) : Date.now();
    if (e.kind === 'debate') {
      const round = Number(e.round);
      const rounds = Number(e.rounds);
      if (!Number.isInteger(round) || round < 1 || round > 10) return null;
      const answers = (Array.isArray(e.answers) ? e.answers : [])
        .filter((x) => x && typeof x === 'object' && okSvcId(x.id))
        .slice(0, 6)
        .map((x) => ({
          id: x.id,
          name: str(x.name, MAX_NAME) || x.id,
          state: stateOf(x.state),
          text: str(x.text, MAX_CHAIN_TEXT),
          md: str(x.md, MAX_CHAIN_TEXT),
          ...(DEBATE_ROLES.has(x.role) ? { role: x.role } : {}), // 토론 역할 (v0.32.0)
        }));
      if (!answers.length) return null;
      const note = str(e.note, 4000).trim(); // 이 라운드 앞에 사용자가 끼워 넣은 말 (v0.32.0)
      return { kind: 'debate', round, rounds: Number.isInteger(rounds) && rounds >= round ? rounds : round, at, answers, ...(note ? { note } : {}) };
    }
    // 작업 흐름 한 걸음 (v0.33.0): { step, steps, stepKind, to, toName, state, text, md, reused? } — 보낸 쪽(from)이 없다
    if (e.kind === 'workflow') {
      const step = Number(e.step);
      const steps = Number(e.steps);
      if (!okSvcId(e.to) || !Number.isInteger(step) || step < 1 || step > 10 || !WORKFLOW_KINDS.has(e.stepKind)) return null;
      return {
        kind: 'workflow',
        step,
        steps: Number.isInteger(steps) && steps >= step ? steps : step,
        stepKind: e.stepKind,
        to: e.to,
        toName: str(e.toName, MAX_NAME) || e.to,
        at,
        state: stateOf(e.state),
        text: str(e.text, MAX_CHAIN_TEXT),
        md: str(e.md, MAX_CHAIN_TEXT),
        ...(e.reused === true ? { reused: true } : {}),
      };
    }
    if (!okSvcId(e.from) || !okSvcId(e.to) || e.from === e.to) return null;
    if (e.kind === 'handoff' && !CHAIN_INTENTS.has(e.intent)) return null;
    return {
      kind: e.kind,
      ...(e.kind === 'handoff' ? { intent: e.intent } : {}),
      from: e.from,
      to: e.to,
      fromName: str(e.fromName, MAX_NAME) || e.from,
      toName: str(e.toName, MAX_NAME) || e.to,
      at,
      state: stateOf(e.state),
      text: str(e.text, MAX_CHAIN_TEXT),
      md: str(e.md, MAX_CHAIN_TEXT),
    };
  }

  /** 기록의 chain (없거나 깨졌으면 빈 목록) */
  const chainOf = (rec) => (rec && Array.isArray(rec.chain) ? rec.chain.filter((c) => c && typeof c === 'object') : []);

  /** 프로젝트 표시 (v0.27.0): { name } 만 남긴다 (이름 120자까지). 아니면 null */
  function cleanProject(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const name = str(p.name, 120).trim();
    return name ? { name } : null;
  }

  // 기록 하나 검사 (v0.35.0): 기록 옮기기 파일 · 보관 파일에서 읽은 기록을 믿지 않고 아는 칸 · 맞는 모양만 남긴다.
  const MAX_ANSWERS = 12;
  const MAX_SYNTH = 40;
  const MAX_FILES = 30;
  const SYNTH_MODES = new Set(['analysis', 'debate', 'factcheck']);
  const num = (v) => (Number.isFinite(v) && v >= 0 && v < 1e12 ? Math.round(v) : undefined);

  function cleanMetrics(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const out = {};
    if (typeof m.sendOk === 'boolean') out.sendOk = m.sendOk;
    if (typeof m.limit === 'boolean') out.limit = m.limit;
    for (const k of ['firstMs', 'doneMs', 'chars']) if (num(m[k]) !== undefined) out[k] = num(m[k]);
    return Object.keys(out).length ? out : null;
  }

  /** 기록 하나 검사 → 깨끗한 기록 | null (id가 안전하지 않으면 받지 않음) */
  function cleanRecord(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || !okRecordId(r.id)) return null;
    const targets = [...new Set((Array.isArray(r.targets) ? r.targets : []).filter(okSvcId))].slice(0, MAX_ANSWERS);
    const answers = {};
    if (r.answers && typeof r.answers === 'object' && !Array.isArray(r.answers)) {
      for (const k of Object.keys(r.answers).slice(0, 40)) {
        const a = r.answers[k];
        if (!okSvcId(k) || !a || typeof a !== 'object' || Object.keys(answers).length >= MAX_ANSWERS) continue;
        const metrics = cleanMetrics(a.metrics);
        answers[k] = { name: str(a.name, MAX_NAME) || k, state: stateOf(a.state), text: str(a.text, MAX_CHAIN_TEXT), md: str(a.md, MAX_CHAIN_TEXT), ...(metrics ? { metrics } : {}) };
      }
    }
    const files = (Array.isArray(r.files) ? r.files : [])
      .filter((x) => x && typeof x === 'object')
      .slice(0, MAX_FILES)
      .map((x) => ({ name: str(x.name, 200), size: num(x.size) || 0, type: str(x.type, 100) }));
    const synth = (Array.isArray(r.synth) ? r.synth : [])
      .filter((x) => x && typeof x === 'object')
      .slice(0, MAX_SYNTH)
      .map((x) => ({
        judge: str(x.judge, MAX_NAME),
        at: Number.isFinite(x.at) && x.at > 0 ? Math.round(x.at) : Date.now(),
        text: str(x.text, MAX_CHAIN_TEXT),
        md: str(x.md, MAX_CHAIN_TEXT),
        ...(SYNTH_MODES.has(x.mode) ? { mode: x.mode } : {}),
        ...(Array.isArray(x.names) ? { names: x.names.filter((n) => typeof n === 'string').slice(0, 12).map((n) => n.slice(0, MAX_NAME)) } : {}),
      }));
    const fb = feedbackOf(r);
    const chain = (Array.isArray(r.chain) ? r.chain : []).map(cleanChain).filter(Boolean).slice(-MAX_CHAIN);
    const tags = HS.cleanTags(r.tags);
    const proj = cleanProject(r.project);
    const page = r.page && typeof r.page === 'object' && !Array.isArray(r.page) ? { title: str(r.page.title, 300), url: str(r.page.url, 2000) } : null;
    return {
      id: r.id,
      at: Number.isFinite(r.at) && r.at > 0 ? Math.round(r.at) : Date.now(),
      question: str(r.question, MAX_CHAIN_TEXT),
      targets,
      files,
      answers,
      synth,
      ...(r.source === 'side' ? { source: 'side' } : {}),
      ...(page ? { page } : {}),
      ...(okRecordId(r.threadId) ? { threadId: r.threadId } : {}),
      ...(RC.KINDS.includes(r.kind) ? { kind: r.kind } : {}),
      ...(proj ? { project: proj } : {}),
      ...(Object.keys(fb).length ? { feedback: { ...fb } } : {}),
      ...(chain.length ? { chain } : {}),
      ...(tags.length ? { tags } : {}),
      ...(r.star === true ? { star: true } : {}),
    };
  }

  /**
   * save(records, info): 바뀐 기록을 저장한다. 답변이 끝날 때마다 바뀌므로 잠깐 모았다가 한 번에 부른다.
   * info = { dirty: [바뀐 기록 id], order: 목록이 바뀌었는가 } (맨 위 설명 참고). max: 최대 개수 (setMax로 바꿈)
   */
  function createHistory(save, { max = MAX_RECORDS, archive = null } = {}) {
    let records = [];
    let archiveFn = typeof archive === 'function' ? archive : null; // 최대 개수를 넘은 기록을 지우지 않고 받아 갈 곳 (v0.35.0)
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

    /** 보관 함수를 바꾼다 (null이면 넘친 기록을 지움). fn(기록 배열) — 넘친 기록을 달별 보관 파일로 옮김 (v0.35.0) */
    function setArchive(fn) {
      archiveFn = typeof fn === 'function' ? fn : null;
    }

    /** 넘친(맨 뒤) 기록을 떼어 낸다: 보관이 켜져 있으면 보관 함수에 넘기고, 아니면 지운다 → 뗀 개수 */
    function trim() {
      if (records.length <= limit) return 0;
      const over = records.splice(limit);
      if (archiveFn) {
        try {
          archiveFn(over);
        } catch {}
      }
      return over.length;
    }

    /** 최대 개수를 바꾼다. 줄이면 오래된 기록부터 지우거나(보관이 꺼진 경우) 보관 파일로 옮긴다 → 덜어 낸 개수 */
    function setMax(n) {
      limit = normalizeMax(n);
      const over = trim();
      if (over) changed();
      return over;
    }

    /**
     * 기록 옮기기로 받은 기록을 더한다 (v0.35.0): cleanRecord로 검사하고, 이미 있는 id는 건너뛰고, 시각 순으로 끼워 넣는다.
     * 최대 개수를 넘으면 가장 오래된 것부터 보관 파일로(보관이 꺼져 있으면 버림).
     * → { added, duplicate, invalid, overflow } (overflow: 최대 개수를 넘어 덜어 낸 수 — 가져온 것일 수도 있음)
     */
    function importRecords(list) {
      const have = new Set(records.map((r) => r.id));
      const fresh = [];
      let duplicate = 0;
      let invalid = 0;
      for (const raw of Array.isArray(list) ? list : []) {
        const r = cleanRecord(raw);
        if (!r) invalid++;
        else if (have.has(r.id)) duplicate++;
        else {
          have.add(r.id);
          fresh.push(r);
        }
      }
      if (!fresh.length) return { added: 0, duplicate, invalid, overflow: 0 };
      records = [...records, ...fresh].sort((a, b) => (b.at || 0) - (a.at || 0));
      const overflow = trim();
      for (const r of fresh) changed(r.id);
      changed();
      return { added: fresh.length, duplicate, invalid, overflow };
    }

    function add({ question, targets, files = [], source, page, threadId, kind, project }) {
      const proj = cleanProject(project);
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
        ...(okRecordId(threadId) ? { threadId } : {}), // 같은 대화 줄기 (v0.27.0, rounds.js가 정함)
        ...(RC.KINDS.includes(kind) ? { kind } : {}), // 질문 종류 (v0.27.0)
        ...(proj ? { project: proj } : {}), // 프로젝트 맥락을 붙여 보냄 (v0.27.0) — 이름만
      };
      records.unshift(rec);
      trim();
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

    /**
     * 이어 묻기 · 토론 한 줄을 기록에 더한다 (v0.26.0, cleanChain으로 검사). → true | false (기록이 없거나 값이 잘못됨)
     * 기록 하나에 MAX_CHAIN개까지 (넘으면 오래된 것부터 뺀다)
     */
    function addChain(id, entry) {
      const rec = find(id);
      const e = cleanChain(entry);
      if (!rec || !e) return false;
      const list = Array.isArray(rec.chain) ? rec.chain : [];
      rec.chain = [...list, e].slice(-MAX_CHAIN);
      changed(id);
      return true;
    }

    /**
     * 목록용 요약. query가 있으면 질문 · 답변 · 종합 · 이어 묻기 · 태그 글에서 찾는다 (대소문자 무시).
     * filters (v0.27.0): shared/history-search.js cleanFilters 모양 — 기간 · AI · 평가 · 보낸 곳 · 프로젝트 · 종합/분석/이어 묻기 · 태그 · 즐겨찾기
     */
    function list(query = '', filters, archived) {
      if (!Array.isArray(archived) || !archived.length) return HS.filterRecords(records, query, filters).map((r) => summary(r));
      // 보관 포함 (v0.35.0): 보관된 기록도 함께 찾는다 (최근 것부터, 목록 줄에 archived 표시)
      const ids = new Set(records.map((r) => r.id));
      const extra = archived.filter((r) => r && typeof r === 'object' && !ids.has(r.id));
      const old = new Set(extra.map((r) => r.id));
      const all = [...records, ...extra].sort((a, b) => (b.at || 0) - (a.at || 0));
      return HS.filterRecords(all, query, filters).map((r) => summary(r, old.has(r.id)));
    }

    /** 주어진 id 순서대로 목록 줄 (거르기에 맞는 것만) — 의미 검색 결과를 보여 줄 때 (v0.36.0) */
    function listByIds(ids, filters) {
      const want = new Set(Array.isArray(ids) ? ids : []);
      const by = new Map(records.filter((r) => r && want.has(r.id)).map((r) => [r.id, r]));
      const ordered = (Array.isArray(ids) ? ids : []).map((id) => by.get(id)).filter(Boolean);
      return HS.filterRecords(ordered, '', filters).map((r) => summary(r));
    }

    /** 기록 하나 → 목록 한 줄 (글은 앞부분만) */
    function summary(r, archivedRow = false) {
      const synth = Array.isArray(r.synth) ? r.synth : [];
      const answers = r.answers && typeof r.answers === 'object' ? Object.values(r.answers) : [];
      const tags = HS.tagsOf(r);
      return {
        id: r.id,
        at: r.at,
        question: String(r.question || '').slice(0, 200),
        answered: answers.filter((a) => a && a.text).length,
        targets: Array.isArray(r.targets) ? r.targets.length : 0,
        synth: synth.filter((s) => s.mode !== 'analysis' && s.mode !== 'debate' && s.mode !== 'factcheck').length,
        factcheck: synth.filter((s) => s.mode === 'factcheck').length,
        analysis: synth.filter((s) => s.mode === 'analysis').length,
        debate: synth.filter((s) => s.mode === 'debate').length,
        chain: chainOf(r).length,
        files: (r.files || []).length,
        ...(r.source ? { source: r.source } : {}),
        ...(typeof r.threadId === 'string' ? { threadId: r.threadId } : {}),
        kind: RC.kindOf(r),
        ...(r.project && typeof r.project.name === 'string' ? { project: r.project.name } : {}),
        ...(r.star === true ? { star: true } : {}),
        ...(tags.length ? { tags } : {}),
        ...(archivedRow ? { archived: true } : {}),
      };
    }

    function get(id) {
      return find(id) || null;
    }

    /** 태그를 바꾼다 (shared/history-search.js cleanTags로 다듬음, 빈 목록이면 지움) → 남긴 태그 | null (기록 없음) */
    function setTags(id, tags) {
      const rec = find(id);
      if (!rec) return null;
      const clean = HS.cleanTags(tags);
      if (clean.length) rec.tags = clean;
      else delete rec.tags;
      changed(id);
      return clean;
    }

    /** 즐겨찾기 켜기 · 끄기 → 남긴 값(true · false) | null (기록 없음 · 값이 true/false가 아님) */
    function setStar(id, on) {
      const rec = find(id);
      if (!rec || typeof on !== 'boolean') return null;
      if (on) rec.star = true;
      else delete rec.star;
      changed(id);
      return on;
    }

    /** 같은 대화 줄기의 기록 전부 (오래된 것부터 — 대화 순서) */
    function thread(threadId) {
      if (!okRecordId(threadId)) return [];
      return records.filter((r) => r && r.threadId === threadId).reverse().sort((a, b) => (a.at || 0) - (b.at || 0)); // 목록은 최근 것부터라 뒤집고, 같은 시각이면 그 순서
    }

    /** 붙은 태그와 개수 [{ tag, n }] (거르기 고르기용) */
    const tags = () => HS.tagCounts(records);

    /** 질문 종류별 추천 조합 (shared/recommend.js) — 남은 기록으로만 센다 */
    const recommend = (opts) => RC.recommend(records, opts);

    /** 시간대별 응답 속도 (v0.35.0, shared/recommend.js) */
    const speed = () => RC.speedByTime(records);

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

    return { load, add, importRecords, setArchive, listByIds, setAnswer, setFeedback, addSynth, addChain, list, get, setTags, setStar, thread, tags, recommend, speed, stats, remove, clear, all, flush, setMax, max: () => limit };
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
    cleanChain,
    chainOf,
    cleanProject,
    cleanRecord,
    MAX_CHAIN,
    planWrites,
    okRecordId,
    newId,
    cleanLegacy,
    normalizeMax,
    MAX_RECORDS,
    MAX_CHOICES,
  };
});
