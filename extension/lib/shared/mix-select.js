// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/mix-select.js)
// 여러 AI의 수정안을 파일마다 골라 섞어 적용하기 (v0.28.0) — 고르기 계산만 한다. 화면은 renderer/project-mix.js.
// 한 경로에는 한 AI의 수정안만 고를 수 있다 (같은 파일을 두 AI 것으로 겹쳐 쓰지 않게). 고르기는 Map(경로 → AI id).
// Electron 앱(require)과 크롬 확장 · 화면(전역 MLA.mixSelect)이 같이 쓴다.
//
// [쉽게 말하면] "a.js는 Claude 것, b.js는 ChatGPT 것"처럼 파일마다 어느 AI의 답을 쓸지 정하는 표를 계산하는 부품입니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).mixSelect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * AI별 수정안 → 경로별 줄. 적용할 수 있는(plan.ok) 수정안만 넣는다.
   * plansByAi: [{ id, name, color, plans: [{ change, plan }] }]
   * quickOf(item): 확인 없이 써도 되는 수정안인지 (미리보기 창의 기본 체크와 같은 기준), riskOf(plan): 실행 영향 이유 | null
   * → [{ path, options: [{ aiId, name, color, op, add, del, quick, risk, suspect }] }] (경로 순)
   */
  function buildRows(plansByAi, { quickOf = () => true, riskOf = () => null } = {}) {
    const byPath = new Map();
    for (const ai of plansByAi || []) {
      for (const item of ai.plans || []) {
        const { plan } = item;
        if (!plan || !plan.ok || typeof plan.path !== 'string') continue;
        if (!byPath.has(plan.path)) byPath.set(plan.path, []);
        const list = byPath.get(plan.path);
        if (list.some((o) => o.aiId === ai.id)) continue; // 한 답에 같은 경로가 두 번이면 앞의 것
        list.push({ aiId: ai.id, name: ai.name, color: ai.color, op: plan.op, add: plan.add || 0, del: plan.del || 0, quick: !!quickOf(item), risk: riskOf(plan) || null, suspect: plan.suspect || null });
      }
    }
    return [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, options]) => ({ path, options }));
  }

  /** 섞기 단추를 보일지: 적용할 수 있는 수정안이 있는 AI가 둘 이상 */
  const canMix = (plansByAi) => (plansByAi || []).filter((ai) => (ai.plans || []).some((x) => x.plan && x.plan.ok)).length >= 2;

  /** 두 AI 이상이 고친 경로 수 */
  const sharedCount = (rows) => rows.filter((r) => r.options.length > 1).length;

  /** 처음 고르기: 한 AI만 고친 파일 중 바로 써도 되는 것(quick)만 그 AI로. 여러 AI가 고친 파일 · 실행 영향 · 삭제는 직접 고른다 */
  function defaultPicks(rows) {
    const picks = new Map();
    for (const r of rows) if (r.options.length === 1 && r.options[0].quick) picks.set(r.path, r.options[0].aiId);
    return picks;
  }

  /** 경로 하나의 고르기를 바꾼 새 Map (aiId가 null이면 그 파일은 적용하지 않음). 그 경로에 없는 AI면 그대로 */
  function setPick(picks, rows, path, aiId) {
    const next = new Map(picks);
    const row = rows.find((r) => r.path === path);
    if (!row) return next;
    if (aiId === null || aiId === undefined) next.delete(path);
    else if (row.options.some((o) => o.aiId === aiId)) next.set(path, aiId);
    return next;
  }

  /** 한 AI로 모두: 그 AI가 고친 모든 경로를 그 AI로 (다른 경로는 그대로) */
  function pickAllFrom(picks, rows, aiId) {
    let next = new Map(picks);
    for (const r of rows) if (r.options.some((o) => o.aiId === aiId)) next = setPick(next, rows, r.path, aiId);
    return next;
  }

  /**
   * 고른 것 정리 → { chosen: [{ path, aiId }], ais: [고른 AI id (처음 나온 순)], mixed: 둘 이상의 AI를 골랐는지, risky: [실행 영향 · 삭제 경로] }
   * 줄에 없는 경로나 그 경로에 없는 AI를 고른 것은 뺀다.
   */
  function summarize(rows, picks) {
    const chosen = [];
    const ais = [];
    const risky = [];
    for (const r of rows) {
      const id = picks.get(r.path);
      const opt = r.options.find((o) => o.aiId === id);
      if (!opt) continue;
      chosen.push({ path: r.path, aiId: id });
      if (!ais.includes(id)) ais.push(id);
      if (opt.risk || opt.op === 'delete') risky.push(r.path);
    }
    return { chosen, ais, mixed: ais.length > 1, risky };
  }

  /** 고른 것 → 적용할 [{ ai, item }] (item = 그 AI의 { change, plan }) */
  function chosenItems(plansByAi, rows, picks) {
    const out = [];
    for (const { path, aiId } of summarize(rows, picks).chosen) {
      const ai = plansByAi.find((a) => a.id === aiId);
      const item = ai && ai.plans.find((x) => x.plan && x.plan.ok && x.plan.path === path);
      if (item) out.push({ ai, item });
    }
    return out;
  }

  return { buildRows, canMix, sharedCount, defaultPicks, setPick, pickAllFrom, summarize, chosenItems };
});
