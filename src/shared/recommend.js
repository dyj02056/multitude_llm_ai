// 질문 종류 나누기와 종류별 추천 조합 (v0.27.0).
// 질문을 코드 · 긴 글 · 프로젝트 · 일반으로 나누고, 기록에 남은 사실 숫자(완료율 · 완료까지 시간 중앙값 · 평가한 답의 만족도)로
// 종류마다 AI를 줄 세운다. 정확도 점수는 만들지 않는다 (재지 않은 것을 숫자로 꾸미지 않는다).
// Electron 앱(require)과 크롬 확장 · 화면(전역 MLA.recommend)이 같이 쓴다.
//
// [쉽게 말하면] "코드 질문에는 지금까지 어느 AI가 끝까지 답을 잘 줬나"를 내 기록으로 세어 보고,
// 답이 5개 넘게 쌓인 AI만 골라 "이런 질문에는 보통: A · B · C"로 보여 주는 부품입니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).recommend = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KINDS = ['code', 'long', 'project', 'general'];
  const LONG_CHARS = 1500; // 이보다 길면 긴 글
  const MANY_FILES = 3; // 첨부가 이만큼 이상이면 긴 글
  const MIN_SAMPLE = 5; // 추천에 넣으려면 그 종류에서 받은 답이 이만큼은 있어야 한다
  const TOP = 3;
  const ORDERS = ['completion', 'rating', 'speed']; // 줄 세우는 기준 (v0.35.0): 완료율 먼저(기본) · 평가 먼저 · 속도 먼저
  const STAR_VOTE = 0.5; // ★ 표시한 기록에서 따로 평가하지 않은 AI의 끝난 답은 "좋았음" 반 표 (v0.35.0)
  const BUCKETS = [
    { id: 'night', from: 0, to: 5 },
    { id: 'morning', from: 6, to: 11 },
    { id: 'afternoon', from: 12, to: 17 },
    { id: 'evening', from: 18, to: 23 },
  ]; // 시간대별 응답 속도 (이 PC의 시간대로 질문을 보낸 시각)
  const MIN_SPEED_SAMPLE = 3; // 한 칸에 이만큼은 있어야 중앙값을 보여 준다

  // 코드 같은 모양: 하나만 보여도 코드인 것(2점)과, 둘 이상 보여야 코드인 것(1점)
  const STRONG_HINTS = [
    /\b(SELECT\s+[\s\S]+?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i, // SQL 문
    /\b(function\s+\w+\s*\(|def\s+\w+\s*\(|class\s+\w+\s*[:({]|fn\s+\w+\s*\(|func\s+\w+\s*\()/, // 함수 · 클래스 정의
    /[A-Za-z_]\w*\([^)]*\)\s*[{;]/, // 호출 · 정의 뒤 { 또는 ;
    /#include\s*<|\bprintf\(|console\.log\(|System\.out\.|\bstd::/,
    /\b(TypeError|ReferenceError|SyntaxError|ValueError|KeyError|IndexError|AttributeError|NullPointerException|Traceback|segmentation fault)\b/i, // 오류 이름 · 스택
    /^\s*(at\s+\S+\s+\(.*:\d+:\d+\)|File ".*", line \d+)/m,
  ];
  const WEAK_HINTS = [
    /\b(const|let|var|import|export|return|public|private|static|void|async|await|struct|impl|package|null|undefined)\b/,
    /=>|::|->|!==|===|&&|\|\|/,
    /\b\w+\(\)/, // useState() 같은 호출
    /^\s*[}{;]\s*$/m,
    /\b[\w./-]+\.(js|ts|tsx|jsx|py|java|kt|go|rs|cpp|cc|h|cs|rb|php|swift|sql|sh|ps1)\b/,
    /^\s{2,}\S.*[;{}]\s*$/m,
    /\b(Error|Exception|stack trace|compile|regex|API)\b/,
  ];

  /** 코드 같은 정도: 강한 모양 2점 + 약한 모양 1점 (2점 이상이면 코드) */
  const codeScore = (text) =>
    STRONG_HINTS.reduce((n, re) => n + (re.test(text) ? 2 : 0), 0) + WEAK_HINTS.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

  /**
   * 질문 종류: { text, files: [{ name }], project } → 'project' | 'code' | 'long' | 'general'
   * 프로젝트 맥락을 붙였으면 프로젝트, 코드 블록(```)이 있거나 코드 점수(codeScore)가 2점 이상이면 코드,
   * 1500자보다 길거나 첨부가 3개 이상이면 긴 글, 나머지는 일반.
   */
  function classifyQuestion({ text, files, project } = {}) {
    const s = typeof text === 'string' ? text : '';
    if (project && typeof project === 'object') return 'project';
    if (/```|~~~/.test(s) || codeScore(s) >= 2) return 'code';
    const n = Array.isArray(files) ? files.length : 0;
    if (s.length > LONG_CHARS || n >= MANY_FILES) return 'long';
    return 'general';
  }

  /** 기록의 종류: 저장된 kind, 없으면(예전 기록) 질문 · 첨부 · 프로젝트로 다시 나눈다 */
  const kindOf = (rec) =>
    rec && KINDS.includes(rec.kind) ? rec.kind : classifyQuestion({ text: rec && rec.question, files: rec && rec.files, project: rec && rec.project });

  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  };

  /** 만족도 = (좋았음 + ★ 반 표) / (좋았음 + ★ 반 표 + 별로였음). 표가 하나도 없으면 null */
  function satisfactionOf({ good = 0, bad = 0, starred = 0 }) {
    const up = good + STAR_VOTE * starred;
    return up + bad ? up / (up + bad) : null;
  }

  /**
   * 종류 × AI 숫자: records → { [kind]: { records, rows: [{ id, name, answers, done, completion, doneMedianMs, good, bad, satisfaction }] } }
   * answers = 결과가 남은 답 수(보내기 실패 포함), completion = 완료 / answers, satisfaction = 좋았음(+ ★ 반 표) / 표 수 (표가 없으면 null)
   */
  function kindStats(records) {
    const out = Object.fromEntries(KINDS.map((k) => [k, { records: 0, by: new Map() }]));
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== 'object' || !Array.isArray(r.targets)) continue;
      const k = out[kindOf(r)];
      k.records++;
      const fb = r.feedback && typeof r.feedback === 'object' && !Array.isArray(r.feedback) ? r.feedback : {};
      for (const id of r.targets) {
        const a = r.answers && typeof r.answers === 'object' ? r.answers[id] : null;
        if (!a || typeof a !== 'object' || typeof id !== 'string') continue; // 결과가 없는 답(기다리는 중 · 앱이 닫힘)은 세지 않는다
        if (!k.by.has(id)) k.by.set(id, { id, name: a.name || id, answers: 0, done: 0, good: 0, bad: 0, starred: 0, ms: [] });
        const row = k.by.get(id);
        if (a.name) row.name = a.name;
        row.answers++;
        if (a.state === 'done') row.done++;
        if (a.state === 'done' && a.metrics && Number.isFinite(a.metrics.doneMs)) row.ms.push(a.metrics.doneMs);
        if (fb[id] === 1) row.good++;
        else if (fb[id] === -1) row.bad++;
        else if (r.star === true && a.state === 'done') row.starred++; // ★ 기록 · 따로 평가하지 않은 끝난 답 (반 표)
      }
    }
    const res = {};
    for (const kind of KINDS) {
      const rows = [...out[kind].by.values()].map(({ ms, ...row }) => ({
        ...row,
        completion: row.answers ? row.done / row.answers : 0,
        doneMedianMs: median(ms),
        satisfaction: satisfactionOf(row),
      }));
      res[kind] = { records: out[kind].records, rows };
    }
    return res;
  }

  /**
   * 줄 세우기: 점수를 새로 만들지 않고 사실 숫자를 기준 순서대로만 비교한다 (같으면 다음 것을 본다).
   *   order 'completion'(기본): 완료율 높은 순 → 만족도 → 완료까지 시간 중앙값 빠른 순 → 답 많은 순
   *   order 'rating': 만족도(표가 있는 것 먼저, 높은 순) → 완료율 → 시간 → 답 많은 순
   *   order 'speed': 시간 중앙값 빠른 순 → 완료율 → 만족도 → 답 많은 순
   */
  function compareRows(a, b, order = 'completion') {
    const sat = (r) => (r.satisfaction == null ? -1 : r.satisfaction);
    const time = (r) => (r.doneMedianMs == null ? Infinity : r.doneMedianMs);
    const by = {
      completion: [(r) => -r.completion, (r) => -sat(r), time, (r) => -r.answers],
      rating: [(r) => -sat(r), (r) => -r.completion, time, (r) => -r.answers],
      speed: [time, (r) => -r.completion, (r) => -sat(r), (r) => -r.answers],
    }[ORDERS.includes(order) ? order : 'completion'];
    for (const key of by) {
      const x = key(a);
      const y = key(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /**
   * 종류별 추천: records → { [kind]: { records, picks: [id] (최대 3개), rows: [줄 세운 것 (표본이 모자란 것은 뒤, enough: false)] } }
   * 답이 minSample(기본 5)개보다 적은 AI는 추천(picks)에 넣지 않는다.
   */
  function recommend(records, { minSample = MIN_SAMPLE, top = TOP, order = 'completion' } = {}) {
    const st = kindStats(records);
    const res = {};
    for (const kind of KINDS) {
      const rows = st[kind].rows.map((r) => ({ ...r, enough: r.answers >= minSample }));
      const ok = rows.filter((r) => r.enough).sort((a, b) => compareRows(a, b, order));
      const rest = rows.filter((r) => !r.enough).sort((a, b) => b.answers - a.answers);
      res[kind] = { records: st[kind].records, picks: ok.slice(0, top).map((r) => r.id), rows: [...ok, ...rest] };
    }
    return res;
  }

  /**
   * 시간대별 응답 속도 (v0.35.0): 끝난 답의 "보낸 뒤 끝날 때까지"(metrics.doneMs) 중앙값을 AI × 시간대로 센다.
   * → { buckets: ['night', 'morning', 'afternoon', 'evening'], rows: [{ id, name, total, cells: [{ n, medianMs (n이 minSample보다 적으면 null) }] }] } (끝난 답이 많은 AI부터)
   * 질문을 보낸 시각(기록의 at)을 이 PC의 시간대로 본다. 정확도가 아니라 걸린 시간만 센다.
   */
  function speedByTime(records, { minSample = MIN_SPEED_SAMPLE } = {}) {
    const by = new Map();
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== 'object' || !Array.isArray(r.targets) || !Number.isFinite(r.at)) continue;
      const hour = new Date(r.at).getHours();
      const b = BUCKETS.findIndex((x) => hour >= x.from && hour <= x.to);
      if (b < 0) continue;
      for (const id of r.targets) {
        const a = r.answers && typeof r.answers === 'object' ? r.answers[id] : null;
        if (!a || typeof a !== 'object' || typeof id !== 'string' || a.state !== 'done' || !a.metrics || !Number.isFinite(a.metrics.doneMs)) continue;
        if (!by.has(id)) by.set(id, { id, name: a.name || id, total: 0, ms: BUCKETS.map(() => []) });
        const row = by.get(id);
        if (a.name) row.name = a.name;
        row.total++;
        row.ms[b].push(a.metrics.doneMs);
      }
    }
    const rows = [...by.values()]
      .map(({ ms, ...row }) => ({ ...row, cells: ms.map((xs) => ({ n: xs.length, medianMs: xs.length >= minSample ? median(xs) : null })) }))
      .sort((x, y) => y.total - x.total);
    return { buckets: BUCKETS.map((x) => x.id), rows };
  }

  /**
   * 지금 열린 패널 중 추천 조합: picks(그 종류의 추천) 중 열린 것만. 추천이 하나도 열려 있지 않으면 빈 목록.
   * 지금 대상(targets)과 같으면 바꿀 것이 없다 → { ids, differs }
   */
  function suggestTargets(picks, openIds, targets) {
    const ids = (Array.isArray(picks) ? picks : []).filter((id) => (openIds || []).includes(id));
    const cur = new Set(Array.isArray(targets) ? targets : []);
    const differs = ids.length > 0 && (ids.length !== cur.size || ids.some((id) => !cur.has(id)));
    return { ids, differs };
  }

  return { KINDS, ORDERS, BUCKETS, STAR_VOTE, LONG_CHARS, MANY_FILES, MIN_SAMPLE, MIN_SPEED_SAMPLE, classifyQuestion, codeScore, kindOf, kindStats, satisfactionOf, compareRows, recommend, speedByTime, suggestTargets };
});
