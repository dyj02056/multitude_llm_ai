// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/workflow.js)
// 작업 흐름 (v0.33.0): "A가 초안 → B가 비판 → A가 고쳐 쓰기 → C가 검증"처럼 정한 순서대로 AI 여러 개에게 차례로 일을 시킨다.
// 걸음마다 앞 걸음의 결과를 다음 AI에게 요청 글로 넘기고(넘기기와 같은 방식), 끝나면 기록의 chain에 걸음마다 남긴다.
// 이 파일은 (1) 걸음 설정 검사 · 보낼 횟수 세기 (2) 걸음마다의 요청 글 (3) 진행 엔진(createWorkflow)을 한다.
// 실제로 보내고 기다리는 일은 rounds.js(sendAndWait)가 한다. Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.workflow)이 같이 쓴다.
//
// [쉽게 말하면] 순서를 정해 두면 앱이 AI들에게 차례로 "초안 써 줘 → 이 초안 비판해 줘 → 비판 반영해 고쳐 써 줘 → 맞는지 검증해 줘"를 시켜 주는 부품입니다.
// 걸음마다 멈춰 확인하거나(걸음마다 멈춤) 다음 걸음을 건너뛸 수도 있습니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./chain') : root.MLA && root.MLA.chain, isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).workflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chain, i18n) {
  'use strict';

  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);

  // 걸음의 종류
  //   draft    초안: 그 AI가 이미 이 질문에 답했으면 그 답을 쓰고(다시 보내지 않음), 없으면 질문을 보낸다
  //   critique 비판(검토): 지금 결과물을 검토해 틀린 점 · 빠진 점 · 더 나은 답을 달라고 한다 (넘기기 › 검토와 같은 글)
  //   counter  반박: 지금 결과물에 반박하게 한다 (넘기기 › 반박)
  //   revise   고쳐 쓰기: 결과물과 가장 최근의 지적(비판 · 반박 · 검증)을 주고 반영해 다시 쓰게 한다
  //   verify   검증: 결과물이 맞는지 정해진 형식(검증 결과 · 남은 문제 · 판정)으로 확인하게 한다
  //   continue 이어서: 결과물을 이어받아 더 발전시키게 한다 (넘기기 › 이어서)
  const KINDS = ['draft', 'critique', 'counter', 'revise', 'verify', 'continue'];
  const MAKES_PRODUCT = new Set(['draft', 'revise', 'continue']); // 결과물(다음 걸음이 받는 글)을 새로 만드는 걸음
  const MAKES_FEEDBACK = new Set(['critique', 'counter', 'verify']); // 지적을 만드는 걸음 (고쳐 쓰기가 받는다)
  const MIN_STEPS = 2;
  const MAX_STEPS = 6;
  const MAX_TEXT = 12000; // 요청 글에 넣는 앞 결과 하나의 최대 길이 (chain.js의 넘기기와 같음)

  const clip = (s, max) => {
    const x = String(s || '');
    return x.length <= max ? x : `${x.slice(0, max)}\n${t('prompt.clipped')}`;
  };

  /** 처음 보여 주는 예시 순서 (초안 → 비판 → 고쳐 쓰기 → 검증): 열린 패널을 차례로 돌려 가며 AI를 정한다 */
  function exampleSteps(openIds) {
    const ids = (openIds || []).filter((x) => typeof x === 'string');
    if (!ids.length) return [];
    const at = (i) => ids[i % ids.length];
    return [
      { kind: 'draft', who: at(0) },
      { kind: 'critique', who: at(1) },
      { kind: 'revise', who: at(0) },
      { kind: 'verify', who: at(2) },
    ];
  }

  /**
   * 화면이 보낸 작업 흐름 설정 검사. cfg: { steps: [{ kind, who }], stepByStep }, openIds: 지금 열린 패널
   * → { ok: true, steps, stepByStep } | { ok: false, error }
   * 규칙: 2~6걸음, 첫 걸음은 초안, AI는 열려 있어야 하고, 비판 · 반박 · 검증 · 이어서는 앞에 결과물이 있어야 하며, 고쳐 쓰기는 앞에 지적이 있어야 한다.
   */
  function normalizeWorkflow(cfg, openIds) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const open = Array.isArray(openIds) ? openIds : [];
    const raw = Array.isArray(c.steps) ? c.steps : [];
    const steps = raw
      .filter((s) => s && typeof s === 'object' && KINDS.includes(s.kind) && typeof s.who === 'string')
      .map((s) => ({ kind: s.kind, who: s.who }));
    if (steps.length < MIN_STEPS) return { ok: false, error: t('workflow.errFew', { n: MIN_STEPS }) };
    if (steps.length > MAX_STEPS || raw.length > MAX_STEPS) return { ok: false, error: t('workflow.errMany', { n: MAX_STEPS }) };
    if (steps[0].kind !== 'draft') return { ok: false, error: t('workflow.errFirst') };
    let product = false;
    let feedback = false;
    for (const [i, s] of steps.entries()) {
      if (!open.includes(s.who)) return { ok: false, error: t('workflow.errClosed', { n: i + 1 }) };
      if (s.kind === 'draft' && i > 0) return { ok: false, error: t('workflow.errDraftLate', { n: i + 1 }) };
      if (s.kind !== 'draft' && !product) return { ok: false, error: t('workflow.errNeedProduct', { n: i + 1 }) };
      if (s.kind === 'revise' && !feedback) return { ok: false, error: t('workflow.errNeedFeedback', { n: i + 1 }) };
      if (MAKES_PRODUCT.has(s.kind)) product = true;
      if (MAKES_FEEDBACK.has(s.kind)) feedback = true;
    }
    return { ok: true, steps, stepByStep: c.stepByStep === true };
  }

  /** 화면이 보낸 설정에서 아는 칸만 (본체 ipc/chain.js · 확장 host.js 공용). 걸음은 7개까지만 받아 "너무 많음"을 알아볼 수 있게 한다 */
  function cleanWorkflowCfg(cfg, okId = () => true) {
    const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
    const steps = (Array.isArray(c.steps) ? c.steps : [])
      .slice(0, MAX_STEPS + 1)
      .filter((s) => s && typeof s === 'object' && KINDS.includes(s.kind) && typeof s.who === 'string' && okId(s.who))
      .map((s) => ({ kind: s.kind, who: s.who }));
    return { steps, stepByStep: c.stepByStep === true };
  }

  /**
   * 보낼 횟수 세기 (시작 전에 사용 한도를 가늠하라고 보여 준다). hasAnswer(id): 그 AI가 이 질문의 답을 이미 가졌는지 (초안은 그 답을 쓰고 보내지 않음)
   * → { total, byWho: { [id]: 횟수 } }
   */
  function countSends(steps, hasAnswer = () => false) {
    const byWho = {};
    let total = 0;
    for (const [i, s] of (steps || []).entries()) {
      if (i === 0 && s.kind === 'draft' && hasAnswer(s.who)) continue;
      byWho[s.who] = (byWho[s.who] || 0) + 1;
      total++;
    }
    return { total, byWho };
  }

  /**
   * 걸음 하나의 요청 글. 앞 결과: product { name, text }(결과물), feedback { name, text }(가장 최근의 지적)
   * draft는 요청 글이 질문 그대로라 여기서 만들지 않는다 (null).
   */
  function buildStepPrompt({ kind, question, product, feedback }) {
    const q = String(question || '').trim();
    const p = product || { name: '', text: '' };
    if (kind === 'critique' || kind === 'counter' || kind === 'continue') {
      const intent = { critique: 'review', counter: 'counter', continue: 'continue' }[kind];
      return chain.buildHandoffPrompt({ intent, question: q, fromName: p.name, answer: p.text });
    }
    if (kind === 'revise') {
      const f = feedback || { name: '', text: '' };
      return t('prompt.workflow.revise', {
        productName: p.name,
        feedbackName: f.name,
        question: q || t('prompt.noQuestion'),
        product: clip(p.text, MAX_TEXT),
        feedback: clip(f.text, MAX_TEXT),
      });
    }
    if (kind === 'verify') return t('prompt.workflow.verify', { name: p.name, question: q || t('prompt.noQuestion'), answer: clip(p.text, MAX_TEXT) });
    return null;
  }

  /**
   * 진행 엔진. d:
   *   sendAndWait(id, text) → Promise<{ state, text, md }>, readAnswer(id) → Promise<{ text, md }>, nameOf(id), openIds()
   *   getRound() → { question, historyId } | null, hasAnswer(id) → Promise<boolean> (없어도 됨)
   *   history: { addChain(historyId, entry) }, status(patch), notify(event), cancel(id), log
   *   status(patch): { state: 'running' | 'paused' | 'done' | 'stopped' | 'error', step, steps, who, kind, next?, error? }
   */
  function createWorkflow(d) {
    let run = null; // { stopped, waiting: Set(id), stopP, resolveStop, done, resume: ({ skip }) => void | null }

    const fail = (error) => {
      d.status({ state: 'error', error });
      return { ok: false, error };
    };

    /** 시작 → { ok, steps } | { ok: false, error }. 진행은 status로 알리고 바로 돌아온다. */
    async function start(cfg) {
      if (run) return { ok: false, error: t('workflow.errRunning') }; // 진행 중인 흐름의 상태 표시를 덮어쓰지 않는다
      const r = d.getRound();
      if (!r) return fail(t('workflow.errNoRound'));
      const c = normalizeWorkflow(cfg, d.openIds());
      if (!c.ok) return fail(c.error);
      let resolveStop;
      const stopP = new Promise((res) => (resolveStop = res));
      run = { stopped: false, waiting: new Set(), stopP, resolveStop, resume: null };
      run.done = loop(run, r, c)
        .catch((err) => {
          d.log?.('workflow', 'failed', err && err.message);
          fail(String((err && err.message) || err));
        })
        .finally(() => {
          run = null;
        });
      return { ok: true, steps: c.steps.length };
    }

    const ask = (cur, id, text) => {
      cur.waiting.add(id);
      return Promise.race([d.sendAndWait(id, text), cur.stopP]).finally(() => cur.waiting.delete(id));
    };

    async function loop(cur, r, c) {
      const total = c.steps.length;
      let product = null; // { name, text }
      let feedback = null;
      let skipNext = false;
      let lastName = '';
      const finishError = (error) => {
        d.status({ state: 'error', error });
        d.notify?.({ kind: 'synth', ok: false, judge: lastName || 'AI', mode: 'workflow' });
      };
      for (const [i, s] of c.steps.entries()) {
        const step = i + 1;
        const name = d.nameOf(s.who);
        // 걸음마다 멈춤: 다음 걸음 앞에서 사용자가 이어 가거나 다음 걸음을 건너뛰거나 멈출 때까지 기다린다 (건너뛴 걸음 뒤에도 똑같이 멈춘다)
        const pauseAfter = async (extra) => {
          if (!(c.stepByStep && i < total - 1)) return true;
          const next = c.steps[i + 1];
          d.status({ state: 'paused', step, steps: total, who: name, kind: s.kind, ...extra, next: { kind: next.kind, who: d.nameOf(next.who) } });
          const choice = await new Promise((resolve) => {
            cur.resume = resolve;
            cur.stopP.then(() => resolve({ stop: true }));
          });
          cur.resume = null;
          if (cur.stopped) {
            d.status({ state: 'stopped', step, steps: total });
            return false;
          }
          skipNext = choice.skip === true;
          return true;
        };
        if (skipNext) {
          skipNext = false;
          d.status({ state: 'running', step, steps: total, who: name, kind: s.kind, skipped: true });
          if (!(await pauseAfter({ skipped: true }))) return;
          continue;
        }
        d.status({ state: 'running', step, steps: total, who: name, kind: s.kind });
        let got;
        let reused = false;
        if (s.kind === 'draft') {
          const have = await d.readAnswer(s.who);
          if (have.md) {
            got = { state: 'done', text: have.text || have.md, md: have.md };
            reused = true; // 이미 받은 답을 초안으로 쓴다 (다시 보내지 않음)
          }
        }
        if (!got) {
          const text = s.kind === 'draft' ? r.question : buildStepPrompt({ kind: s.kind, question: r.question, product, feedback });
          got = await ask(cur, s.who, text);
        }
        if (cur.stopped) return d.status({ state: 'stopped', step, steps: total });
        d.history.addChain(r.historyId, { kind: 'workflow', step, steps: total, stepKind: s.kind, to: s.who, toName: name, at: Date.now(), state: got.state, text: got.text || '', md: got.md || '', ...(reused ? { reused: true } : {}) });
        if (got.state !== 'done' || !got.md) return finishError(t('workflow.errStep', { n: step, name }));
        lastName = name;
        const result = { name, text: got.md };
        if (MAKES_PRODUCT.has(s.kind)) product = result;
        if (MAKES_FEEDBACK.has(s.kind)) feedback = result;
        if (!(await pauseAfter())) return;
      }
      d.status({ state: 'done', steps: total, who: lastName });
      d.notify?.({ kind: 'synth', ok: true, judge: lastName || 'AI', mode: 'workflow' });
    }

    /** 걸음마다 멈춤 중일 때 이어 가기 (skip: 다음 걸음 하나를 건너뜀) → { ok } */
    function resume(opts) {
      if (!run || !run.resume) return { ok: false, error: t('workflow.errNotPaused') };
      const go = run.resume;
      run.resume = null; // 두 번 눌러도 한 번만
      go({ skip: !!(opts && opts.skip) });
      return { ok: true };
    }

    /** 멈추기: 기다리던 답 감시를 멈추고 끝낸다 (이미 받은 걸음은 기록에 남음) → { ok } */
    function stop() {
      if (!run) return { ok: false, error: t('workflow.errNotRunning') };
      run.stopped = true;
      for (const id of run.waiting) d.cancel(id);
      run.resolveStop({ state: 'stopped', text: '', md: '' });
      return { ok: true };
    }

    return { start, stop, resume, running: () => !!run, whenDone: () => (run ? run.done : Promise.resolve()) };
  }

  return { KINDS, MIN_STEPS, MAX_STEPS, MAKES_PRODUCT, MAKES_FEEDBACK, exampleSteps, normalizeWorkflow, cleanWorkflowCfg, countSends, buildStepPrompt, createWorkflow };
});
