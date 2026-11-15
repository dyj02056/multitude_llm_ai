// 토론 진행 (v0.26.0): 참가 AI(2~3개)가 서로의 최신 답변을 받아 반박 · 보완하기를 라운드 수만큼 하고, 판정 AI가 결론을 낸다.
// 라운드마다 참가 AI 모두에게 동시에 보내고, 모두 끝나면(또는 실패하면) 다음 라운드로. 결과는 기록의 chain(kind 'debate')에
// 라운드마다 남기고, 판정 결론은 synth(mode 'debate')로 남긴다. 멈추기를 누르면 기다리던 답변 감시를 멈추고 끝낸다.
// rounds.js가 패널 다루는 방법(d)을 넘겨 만든다 — Electron 앱과 크롬 확장 프로그램(전역 MLA.debate)이 같이 쓴다.
//
// [쉽게 말하면] "AI 셋이 두 번 서로 반박하게 한 뒤, 한 AI가 합의한 점 · 남은 이견 · 최종 답을 정리"하는 순서를 지키는 진행자입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./chain') : root.MLA && root.MLA.chain, isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).debate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chain, i18n) {
  'use strict';

  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);
  const { buildDebatePrompt, buildDebateJudgePrompt, normalizeDebate } = chain;

  /**
   * d:
   *   sendAndWait(id, text) → Promise<{ state, text, md }>  (패널 하나에 보내고 답이 끝날 때까지)
   *   readAnswer(id) → Promise<{ text, md }>, nameOf(id), openIds() → [id], defaultJudge() → id
   *   getRound() → { question, historyId } | null  (지금 라운드 — 공통 입력창으로 마지막에 보낸 질문)
   *   history: { addChain(historyId, entry), addSynth(historyId, entry) }
   *   status(patch): 진행 상태를 화면에 { state: 'running' | 'judging' | 'done' | 'stopped' | 'error', round, rounds, waiting, judge, error }
   *   notify(event), cancel(id): 패널의 답변 감시 멈추기, log
   */
  function createDebate(d) {
    let run = null; // { stopped, waiting: Set(id), stopP, resolveStop, done: Promise }

    const fail = (error) => {
      d.status({ state: 'error', error });
      return { ok: false, error };
    };

    /** 토론 시작 → { ok } | { ok: false, error }. 진행은 status로 알리고, 끝나기를 기다리지 않고 바로 돌아온다. */
    async function start(cfg) {
      if (run) return fail(t('debate.errRunning'));
      const r = d.getRound();
      if (!r) return fail(t('debate.errNoRound'));
      const c = normalizeDebate(cfg, d.openIds(), d.defaultJudge());
      if (!c.ok) return fail(c.error);
      // 처음 입장: 참가 AI마다 지금 질문의 최신 답변
      const pos = new Map();
      for (const id of c.participants) {
        const { md } = await d.readAnswer(id);
        if (!md) return fail(t('debate.errNoAnswer', { name: d.nameOf(id) }));
        pos.set(id, md);
      }
      let resolveStop;
      const stopP = new Promise((res) => (resolveStop = res));
      run = { stopped: false, waiting: new Set(), stopP, resolveStop };
      run.done = loop(run, r, c, pos)
        .catch((err) => {
          d.log?.('debate', 'failed', err && err.message);
          fail(String((err && err.message) || err));
        })
        .finally(() => {
          run = null;
        });
      return { ok: true, participants: c.participants.length, rounds: c.rounds };
    }

    /** 멈추기를 누를 때까지 기다리는 답변 하나 */
    function ask(cur, id, text) {
      cur.waiting.add(id);
      return Promise.race([d.sendAndWait(id, text), cur.stopP]).finally(() => cur.waiting.delete(id));
    }

    async function loop(cur, r, c, pos) {
      const names = c.participants.map((id) => d.nameOf(id));
      for (let i = 1; i <= c.rounds; i++) {
        d.status({ state: 'running', round: i, rounds: c.rounds, waiting: names });
        const results = await Promise.all(
          c.participants.map((id) => {
            const others = c.participants.filter((x) => x !== id).map((x) => ({ name: d.nameOf(x), text: pos.get(x) }));
            const text = buildDebatePrompt({ question: r.question, round: i, rounds: c.rounds, selfName: d.nameOf(id), others });
            return ask(cur, id, text).then((res) => {
              if (!cur.stopped) d.status({ state: 'running', round: i, rounds: c.rounds, waiting: [...cur.waiting].map(d.nameOf) });
              return res;
            });
          }),
        );
        if (cur.stopped) return stopped();
        const answers = c.participants.map((id, k) => ({ id, name: d.nameOf(id), state: results[k].state, text: results[k].text || '', md: results[k].md || '' }));
        for (const a of answers) if (a.state === 'done' && a.md) pos.set(a.id, a.md); // 실패한 AI는 지난 입장 그대로
        d.history.addChain(r.historyId, { kind: 'debate', round: i, rounds: c.rounds, at: Date.now(), answers });
        if (!answers.some((a) => a.state === 'done' && a.md)) return finishError(t('debate.errRoundFailed', { round: i }));
      }
      const judgeName = d.nameOf(c.judge);
      d.status({ state: 'judging', judge: judgeName, rounds: c.rounds });
      const positions = c.participants.map((id) => ({ name: d.nameOf(id), text: pos.get(id) }));
      const res = await ask(cur, c.judge, buildDebateJudgePrompt({ question: r.question, positions, rounds: c.rounds }));
      if (cur.stopped) return stopped();
      if (res.state !== 'done' || !res.md) return finishError(t('debate.errJudge', { judge: judgeName }), judgeName);
      d.history.addSynth(r.historyId, { judge: judgeName, at: Date.now(), text: res.text, md: res.md, mode: 'debate', names, rounds: c.rounds });
      d.status({ state: 'done', judge: judgeName, rounds: c.rounds });
      d.notify?.({ kind: 'synth', ok: true, judge: judgeName, mode: 'debate' });

      function stopped() {
        d.status({ state: 'stopped' });
      }
      function finishError(error, judge) {
        d.status({ state: 'error', error });
        d.notify?.({ kind: 'synth', ok: false, judge: judge || 'AI', mode: 'debate' });
      }
    }

    /** 멈추기: 기다리던 패널의 답변 감시를 멈추고 토론을 끝낸다 → { ok } */
    function stop() {
      if (!run) return { ok: false, error: t('debate.errNotRunning') };
      run.stopped = true;
      for (const id of run.waiting) d.cancel(id);
      run.resolveStop({ state: 'stopped', text: '', md: '' });
      return { ok: true };
    }

    return { start, stop, running: () => !!run, whenDone: () => (run ? run.done : Promise.resolve()) };
  }

  return { createDebate };
});
