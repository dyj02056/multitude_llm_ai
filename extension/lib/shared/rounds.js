// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/rounds.js)
// 질문 보내기 · 답변 감시 · 교차검토(종합) · 답변 모으기.
// 공통 입력창으로 보낸 질문 한 번을 "라운드"라고 부른다. 자동 종합은 라운드의 모든 답변이 끝났을 때 한 번만 실행한다.
// 패널을 다루는 방법만 바꿔 끼워서(adapter) Electron 앱과 크롬 확장 프로그램(전역 MLA.rounds)이 같이 쓴다.
(function (root, factory) {
  const api = factory(root.MLA && root.MLA.synth, root.MLA && root.MLA.services);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).rounds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (synth, services) {
  'use strict';

  const { buildSynthPrompt } = synth || require('./synth');
  const { uploadOf, fileKind } = services || require('./services');
  const FINISHED = new Set(['done', 'timeout', 'no-answer']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * a (adapter):
   *   services: 서비스 목록
   *   hasPanel(id): 패널이 열려 있는지
   *   sendPrompt(id, text, files): 패널에 파일을 첨부하고 글을 넣어 보낸다
   *     files: [{ name, type, size, lastModified, data: ArrayBuffer }] (이 서비스가 받는 종류만)
   *     → { ok, via, attach?: { ok, error } } | { ok: false, error }
   *   snapshot(id, { markdown }): 패널의 지금 상태 { stop, count, text, md } (못 읽으면 null)
   *   watch(id, before, isCurrent, onState): 답변 감시 (shared/watch.js의 watchAnswer)
   *   sendPanel(id, patch): 패널 상태를 화면에 알린다
   *   sendSynthStatus(patch): 종합 상태를 화면에 알린다
   *   history: { add, setAnswer, addSynth }  (add는 { question, targets, files(이름·크기·종류) })
   *   prefs(): { synthTarget, autoSynth }
   *   log(tag, ...args)
   */
  function createRounds(a) {
    const tokens = new Map(); // id -> 지금 유효한 답변 감시 번호 (새로 보내면 이전 감시는 멈춘다)
    let round = null; // { question, targets: [id], finished: Map(id -> 상태), synthDone, historyId }

    const nameOf = (id) => a.services.find((s) => s.id === id)?.name || id;
    const openIds = () => a.services.map((s) => s.id).filter((id) => a.hasPanel(id));

    /** 진행 중인 답변 감시를 멈춘다 (새 대화를 열 때 등). */
    function cancelWatch(id) {
      tokens.set(id, (tokens.get(id) || 0) + 1);
    }

    /**
     * 첨부 결과를 화면용으로 정리한다. → { state: 'ok' | 'partial' | 'failed' | 'skipped', error? } (첨부가 없으면 undefined)
     * 받지 않는 종류는 보내지 않고(skipped), 첨부에 실패하면 글만 보낸다(failed).
     */
    function attachResult(sent, skipped, res) {
      if (!sent.length && !skipped.length) return undefined;
      const names = (list) => list.map((f) => f.name).join(', ');
      if (!sent.length) return { state: 'skipped', error: `받지 않는 파일 종류: ${names(skipped)}` };
      if (!res.attach?.ok) return { state: 'failed', error: res.attach?.error || '첨부하지 못했습니다' };
      if (skipped.length) return { state: 'partial', error: `받지 않는 파일 종류: ${names(skipped)}` };
      return { state: 'ok' };
    }

    /** 패널 하나에 글(과 첨부 파일)을 보내고 답변을 지켜본다. onFinish(state): 답변이 끝났거나 실패했을 때 */
    async function sendToPanel(id, text, onFinish, files = []) {
      cancelWatch(id);
      const token = tokens.get(id);
      const svc = a.services.find((s) => s.id === id);
      const accept = uploadOf(svc).accept;
      const sendFiles = files.filter((f) => accept.includes(fileKind(f.type)));
      const skipped = files.filter((f) => !sendFiles.includes(f));
      a.sendPanel(id, { send: 'sending', attaching: sendFiles.length || undefined });
      const before = await a.snapshot(id);
      let res;
      try {
        // 글 없이 파일만 보내는데 이 서비스가 받는 파일이 하나도 없으면 보낼 것이 없다.
        res =
          !text && !sendFiles.length
            ? { ok: false, error: `보낼 내용이 없습니다 (받지 않는 파일 종류: ${skipped.map((f) => f.name).join(', ')})` }
            : await a.sendPrompt(id, text, sendFiles);
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      const attach = res.ok ? attachResult(sendFiles, skipped, res) : undefined;
      a.log('send', id, JSON.stringify(res), attach ? JSON.stringify(attach) : '');
      res = { ...res, attach };
      a.sendPanel(id, { send: res.ok ? 'sent' : 'error', error: res.ok ? undefined : res.error, attach });
      if (!res.ok) {
        onFinish?.('error');
      } else {
        a.watch(
          id,
          before,
          () => tokens.get(id) === token && a.hasPanel(id),
          (answer, info) => {
            a.log('answer', id, answer, info ? JSON.stringify(info) : '');
            a.sendPanel(id, { answer, ...info });
            if (FINISHED.has(answer)) onFinish?.(answer);
          },
        );
      }
      return { id, ...res };
    }

    /** 패널의 최신 답변: { text: 화면 글, md: Markdown } */
    async function readAnswer(id) {
      if (!a.hasPanel(id)) return { text: '', md: '' };
      const snap = await a.snapshot(id, { markdown: true });
      return { text: snap?.text || '', md: snap?.md || snap?.text || '' };
    }

    async function onRoundAnswer(r, id, state) {
      // 기록은 새 질문을 보낸 뒤에 끝난 답변이라도 그 라운드에 남긴다.
      const { text, md } = state === 'done' ? await readAnswer(id) : { text: '', md: '' };
      a.history.setAnswer(r.historyId, id, { name: nameOf(id), state, text, md });
      if (r !== round) return; // 그사이 새 질문을 보냈으면 자동 종합은 하지 않는다
      r.finished.set(id, state);
      if (r.finished.size < r.targets.length || r.synthDone || !a.prefs().autoSynth) return;
      r.synthDone = true;
      runSynth(null, 'auto');
    }

    /** 공통 입력창: 고른 패널들에 같은 질문(과 첨부 파일)을 동시에 보낸다. 종합 요청에는 첨부를 다시 보내지 않는다. */
    function sendAll(text, targets, files = []) {
      const ids = targets.filter((id) => a.hasPanel(id));
      const meta = files.map(({ name, size, type }) => ({ name, size, type }));
      const historyId = a.history.add({ question: text, targets: ids, files: meta });
      const r = (round = { question: text, targets: ids, finished: new Map(), synthDone: false, historyId });
      return Promise.all(ids.map((id) => sendToPanel(id, text, (state) => onRoundAnswer(r, id, state), files)));
    }

    /** 종합 요청. judgeId가 없으면 설정된 종합 담당 AI를 쓴다. */
    async function runSynth(judgeId, cause = 'manual') {
      const judge = judgeId || a.prefs().synthTarget;
      if (!round) return fail('먼저 공통 입력창으로 질문을 보내 주세요');
      if (!a.hasPanel(judge)) return fail('종합을 맡을 AI 패널이 열려 있지 않습니다');

      const answers = [];
      for (const svc of a.services) {
        if (svc.id === judge || !round.targets.includes(svc.id) || !a.hasPanel(svc.id)) continue;
        // 페이지가 다시 그려지는 순간이면 글이 비어 보일 수 있어 한 번 더 읽는다.
        let { md } = await readAnswer(svc.id);
        if (!md) ({ md } = await sleep(600).then(() => readAnswer(svc.id)));
        if (md) answers.push({ name: svc.name, text: md }); // 표·코드가 살아 있도록 Markdown으로 넘긴다
        else a.log('synth', 'skipped (no answer text)', svc.id);
      }
      if (!answers.length) return fail('종합할 다른 AI의 답변이 없습니다');

      const text = buildSynthPrompt({
        question: round.question,
        answers,
        judgeAnswered: round.targets.includes(judge),
      });
      const judgeName = nameOf(judge);
      a.sendSynthStatus({ state: 'sending', judge: judgeName, count: answers.length, cause });
      const historyId = round.historyId;
      const res = await sendToPanel(judge, text, async (state) => {
        if (state !== 'done') return;
        a.history.addSynth(historyId, { judge: judgeName, at: Date.now(), ...(await readAnswer(judge)) });
      });
      if (!res.ok) return fail(`${judgeName}에 보내지 못했습니다: ${res.error}`);
      a.sendSynthStatus({ state: 'sent', judge: judgeName, count: answers.length, cause });
      return { ok: true, judge: judgeName, count: answers.length };

      function fail(error) {
        a.sendSynthStatus({ state: 'error', error, cause });
        return { ok: false, error };
      }
    }

    /** 최신 답변 Markdown. id가 '*'이면 열린 패널 전부를 "## 이름" 머리말로 묶는다. → { text, copied, total } */
    async function collectMarkdown(id) {
      const ids = id === '*' ? openIds() : [id].filter((x) => a.hasPanel(x));
      const parts = [];
      for (const pid of ids) {
        const { md } = await readAnswer(pid);
        if (md) parts.push(id === '*' ? `## ${nameOf(pid)}\n\n${md}` : md);
      }
      return { text: parts.join('\n\n---\n\n'), copied: parts.length, total: ids.length };
    }

    /** 답변 비교 화면용: 열린 패널마다 최신 답변 글과 마지막 공통 질문 */
    async function answers() {
      const list = [];
      for (const svc of a.services) {
        if (!a.hasPanel(svc.id)) continue;
        list.push({ id: svc.id, name: svc.name, color: svc.color, ...(await readAnswer(svc.id)) });
      }
      return { question: round?.question || '', answers: list };
    }

    return { sendAll, runSynth, collectMarkdown, answers, cancelWatch };
  }

  return { createRounds };
});
