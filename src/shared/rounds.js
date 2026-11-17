// 질문 보내기 · 답변 감시 · 교차검토(종합) · 답변 모으기.
// 공통 입력창으로 보낸 질문 한 번을 "라운드"라고 부른다. 자동 종합은 라운드의 모든 답변이 끝났을 때 한 번만 실행한다.
// 패널을 다루는 방법만 바꿔 끼워서(adapter) Electron 앱과 크롬 확장 프로그램(전역 MLA.rounds)이 같이 쓴다.
//
// [쉽게 말하면]
// 질문을 여러 AI에게 동시에 보내고, 답변이 끝날 때까지 지켜보고, 기록에 남기고,
// 원하면 "종합"(다른 AI들의 답을 모아 한 AI에게 정리시키기)까지 하는 "진행자"입니다.
// 패널을 실제로 다루는 방법(adapter, 아래 a)은 Windows 앱과 크롬 확장이 각자 넘겨줍니다.
(function (root, factory) {
  const M = root.MLA || {};
  const api = factory(M.synth, M.services, M.sendPlan, M.chain, M.retry, M.debate, M.i18n, M.recommend);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).rounds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (synth, services, sendPlan, chainLib, retryLib, debateLib, i18n, recommendLib) {
  'use strict';

  const { buildSynthPrompt, analysisNames } = synth || require('./synth');
  const { uploadOf, fileKind } = services || require('./services');
  const { planSend, fitAnswers } = sendPlan || require('./send-plan');
  const { buildHandoffPrompt, INTENTS } = chainLib || require('./chain');
  const { retryDecision } = retryLib || require('./retry');
  const { createDebate } = debateLib || require('./debate');
  const t = (i18n || require('./i18n')).t;
  const { classifyQuestion } = recommendLib || require('./recommend');
  const FINISHED = new Set(['done', 'timeout', 'no-answer']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * a (adapter):
   *   services: 서비스 목록
   *   hasPanel(id): 패널이 열려 있는지
   *   sendPrompt(id, text, files, { fallbackText }): 패널에 파일을 첨부하고 글을 넣어 보낸다
   *     files: [{ name, type, size, lastModified, data: ArrayBuffer }] (이 서비스가 받는 종류만)
   *     fallbackText: 첨부에 실패하면 text 대신 넣을 글 (프로젝트 파일 업로드의 내부 예비 경로)
   *     → { ok, via, attach?: { ok, error, fallback? } } | { ok: false, error }
   *   snapshot(id, { markdown }): 패널의 지금 상태 { stop, count, text, md } (못 읽으면 null)
   *   watch(id, before, isCurrent, onState): 답변 감시 (shared/watch.js의 watchAnswer)
   *   sendPanel(id, patch): 패널 상태를 화면에 알린다
   *   sendSynthStatus(patch): 종합 상태를 화면에 알린다
   *   history: { add, setAnswer, addSynth, addChain?, get? }  (add는 { question, targets, files(이름·크기·종류) }, addChain은 v0.26.0 이어 묻기 · 토론)
   *   prefs(): { synthTarget, autoSynth, retryOnce }  (retryOnce: 보내기 실패면 잠깐 뒤 한 번 다시 보냄, v0.26.0)
   *   retryDelayMs: 다시 보내기 전 기다리는 시간 (없으면 shared/retry.js RETRY_DELAY_MS, 테스트용)
   *   diag: 셀렉터 자가진단 (shared/diag.js createDiag, 없어도 됨) — 보내기 · 답변 결과를 기록
   *   checkLimit(id, { scope, answer }): 사용 한도 안내를 찾는다 → 찾은 문구 | null (없어도 됨, page.js pageLimitCheck)
   *   notify(event): OS 알림 (없어도 됨, shared/notify.js createNotifier) — 라운드 답변이 모두 끝남 · 사용 한도 · 보내기 실패 · 종합 끝
   *   localJudge (v0.29.0, 없어도 됨): 로컬 LLM을 판정 · 종합에 쓸 때
   *     { id: 'local', available(): 설정에서 켰는지, limit(): 컨텍스트 한도(토큰), ask(text) → Promise<{ ok, text, error }> }
   *     패널이 열려 있지 않으면 ask(패널과 따로인 임시 대화)로 묻고, 열려 있으면 패널로 보낸다. 어느 쪽이든 종합 입력은 한도에 맞춰 줄인다.
   *   log(tag, ...args)
   */
  function createRounds(a) {
    const tokens = new Map(); // id -> 지금 유효한 답변 감시 번호 (새로 보내면 이전 감시는 멈춘다)
    let round = null; // { question, targets: [id], finished: Map(id -> 상태), synthDone, historyId, analyses }
    // 패널마다 마지막으로 보낸 것 { text, files, fallbackText, onFinish } — [다시 보내기] · 다른 AI로 보내기 (v0.26.0, 메모리에만)
    const lastSent = new Map();
    // 대화 줄기 (v0.27.0): 패널 id → 그 패널이 마지막으로 받은 라운드의 threadId. 새 대화 · 처음 주소 · 패널 닫기(resetPanel)면 지운다.
    const threadOf = new Map();

    const nameOf = (id) => a.services.find((s) => s.id === id)?.name || id;
    const openIds = () => a.services.map((s) => s.id).filter((id) => a.hasPanel(id));
    // 로컬 LLM 판정 (v0.29.0): 패널이 없어도 설정에서 켰으면 임시 대화로 묻는다
    const isLocalJudge = (id) => !!a.localJudge && id === a.localJudge.id;
    const headlessLocal = (id) => isLocalJudge(id) && !a.hasPanel(id) && a.localJudge.available();
    const canJudge = (id) => a.hasPanel(id) || headlessLocal(id);
    /** 판정 AI가 로컬 LLM이면 답변들을 컨텍스트 한도에 맞춰 줄인다 → { answers, trimmed } */
    const fitFor = (id, answers, fixedText) =>
      isLocalJudge(id) ? fitAnswers(answers, { limit: a.localJudge.limit(), fixedText, note: t('local.trimNote') }) : { answers, trimmed: [] };

    /** 진행 중인 답변 감시를 멈춘다 (새 대화를 열 때 등). */
    function cancelWatch(id) {
      tokens.set(id, (tokens.get(id) || 0) + 1);
    }

    /**
     * 패널의 대화가 새로 시작됨 (v0.27.0): 새 대화 · 처음 주소 · 로컬 LLM 대화 지우기 · 패널 닫기.
     * 이 패널은 더 이상 지난 대화 줄기를 이어 가지 않는다. id '*'이면 모든 패널.
     */
    function resetPanel(id) {
      if (id === '*') threadOf.clear();
      else threadOf.delete(id);
    }

    /**
     * 새 라운드의 대화 줄기: 지난 라운드의 줄기를 받은 뒤 새로 시작하지 않은 패널이 ids 중 하나라도 있으면 그 줄기를 잇고,
     * 아니면 새 줄기. → threadId
     */
    function pickThread(ids) {
      const prev = round?.threadId;
      if (prev && ids.some((id) => threadOf.get(id) === prev)) return prev;
      return newThreadId();
    }
    const newThreadId = () => `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    /**
     * 첨부 결과를 화면용으로 정리한다. → { state: 'ok' | 'partial' | 'failed' | 'fallback' | 'skipped', error? } (첨부가 없으면 undefined)
     * 받지 않는 종류는 보내지 않고(skipped), 첨부에 실패하면 글만 보낸다(failed).
     * 예비 글이 있으면 첨부 실패 때 그 글을 대신 보낸다(fallback).
     */
    function attachResult(sent, skipped, res) {
      if (!sent.length && !skipped.length) return undefined;
      const names = (list) => list.map((f) => f.name).join(', ');
      if (!sent.length) return { state: 'skipped', error: t('main.rounds.unsupportedTypes', { names: names(skipped) }) };
      if (!res.attach?.ok) return { state: res.attach?.fallback ? 'fallback' : 'failed', error: res.attach?.error || t('main.attachFailed') };
      if (skipped.length) return { state: 'partial', error: t('main.rounds.unsupportedTypes', { names: names(skipped) }) };
      return { state: 'ok' };
    }

    // 답변이 이보다 짧게 끝나면 한도 안내일 수 있어 그 답변 글에서 한도 문구를 찾는다 (긴 정상 답변은 보지 않는다)
    const SHORT_ANSWER = 400;

    /** 사용 한도 확인: 답변이 끝나지 않았으면 화면 끝부분에서, 짧게 끝났으면 그 답변에서 찾는다 → 문구 | null */
    async function limitOf(id, state, chars) {
      if (!a.checkLimit) return null;
      try {
        if (state === 'done') {
          if (!(chars < SHORT_ANSWER)) return null;
          const { text } = await readAnswer(id);
          return await a.checkLimit(id, { scope: 'answer', answer: text });
        }
        return await a.checkLimit(id, { scope: 'page' });
      } catch {
        return null;
      }
    }

    /**
     * 패널 하나에 글(과 첨부 파일)을 보내고 답변을 지켜본다.
     * onFinish(state, metrics): 답변이 끝났거나 실패했을 때. state는 'done' · 'timeout' · 'no-answer' · 'error'
     *   metrics: { sendOk, firstMs(보낸 뒤 답변이 시작될 때까지), doneMs(보낸 뒤 끝날 때까지), chars, limit(사용 한도 문구) } — 숫자만 (응답 통계)
     * fallbackText: 첨부에 실패하면 대신 보낼 글
     */
    async function sendToPanel(id, text, onFinish, files = [], fallbackText) {
      cancelWatch(id);
      const token = tokens.get(id);
      const svc = a.services.find((s) => s.id === id);
      const accept = uploadOf(svc).accept;
      const sendFiles = files.filter((f) => accept.includes(fileKind(f.type)));
      const skipped = files.filter((f) => !sendFiles.includes(f));
      lastSent.set(id, { text, files, fallbackText, onFinish });
      if (round?.threadId) threadOf.set(id, round.threadId); // 이 패널은 이제 지금 라운드의 대화를 안다 (넘기기 · 종합 · 토론 포함)
      a.sendPanel(id, { send: 'sending', attaching: sendFiles.length || undefined });
      let before = await a.snapshot(id);
      const trySend = async () => {
        try {
          // 글 없이 파일만 보내는데 이 서비스가 받는 파일이 하나도 없으면 보낼 것이 없다.
          return !text && !sendFiles.length
            ? { ok: false, error: t('main.rounds.nothingUnsupported', { names: skipped.map((f) => f.name).join(', ') }) }
            : await a.sendPrompt(id, text, sendFiles, { fallbackText: sendFiles.length && typeof fallbackText === 'string' ? fallbackText : undefined });
        } catch (err) {
          return { ok: false, error: err.message };
        }
      };
      let res = await trySend();
      let limitText = null;
      if (!res.ok) {
        // 보내기 실패 (v0.26.0): 사용 한도가 아니면 설정에 따라 잠깐 뒤 한 번만 다시 보낸다 (shared/retry.js)
        limitText = await limitOf(id, 'error');
        const d = retryDecision({ state: 'error', attempt: 0, enabled: a.prefs().retryOnce === true, error: res.error, limit: !!limitText });
        if (d.action === 'resend' && tokens.get(id) === token) {
          a.log('send', id, 'retry', res.error);
          a.sendPanel(id, { send: 'retrying', error: res.error });
          await sleep(a.retryDelayMs ?? d.delayMs);
          if (tokens.get(id) === token && a.hasPanel(id)) {
            before = await a.snapshot(id);
            res = { ...(await trySend()), retried: true };
            limitText = res.ok ? null : await limitOf(id, 'error');
          }
        }
      }
      const attach = res.ok ? attachResult(sendFiles, skipped, res) : undefined;
      a.log('send', id, JSON.stringify(res), attach ? JSON.stringify(attach) : '');
      res = { ...res, attach };
      a.diag?.fromSend(id, res);
      a.sendPanel(id, { send: res.ok ? 'sent' : 'error', error: res.ok ? undefined : res.error, attach });
      if (!res.ok) {
        const limit = limitText;
        if (limit) a.diag?.setLimit?.(id, limit);
        if (limit) a.notify?.({ kind: 'limit', name: nameOf(id) });
        onFinish?.('error', { sendOk: false, limit: limit || undefined });
      } else {
        const sentAt = Date.now();
        let firstMs;
        a.watch(
          id,
          before,
          () => tokens.get(id) === token && a.hasPanel(id),
          async (answer, info) => {
            a.log('answer', id, answer, info ? JSON.stringify(info) : '');
            a.sendPanel(id, { answer, ...info });
            if (answer === 'answering' && firstMs === undefined) firstMs = Date.now() - sentAt;
            if (FINISHED.has(answer)) {
              a.diag?.fromAnswer(id, answer);
              const limit = await limitOf(id, answer, info?.chars);
              // 한도 안내를 찾았으면 그 패널 머리줄에 알리고, 정상으로 끝났으면 지난 한도 표시를 지운다
              if (limit || answer === 'done') a.diag?.setLimit?.(id, limit || null);
              if (limit) a.notify?.({ kind: 'limit', name: nameOf(id) });
              onFinish?.(answer, { sendOk: true, firstMs, doneMs: answer === 'done' ? Date.now() - sentAt : undefined, chars: info?.chars, limit: limit || undefined });
            }
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

    /** 기록에 남길 숫자만 고른다 (한도 문구 글은 남기지 않고 걸렸는지만) */
    function cleanMetrics(m) {
      const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
      return { sendOk: m.sendOk !== false, firstMs: num(m.firstMs), doneMs: num(m.doneMs), chars: num(m.chars), limit: !!m.limit };
    }

    async function onRoundAnswer(r, id, state, metrics) {
      // 기록은 새 질문을 보낸 뒤에 끝난 답변이라도 그 라운드에 남긴다. 숫자(metrics)는 응답 통계에 쓴다.
      const { text, md } = state === 'done' ? await readAnswer(id) : { text: '', md: '' };
      a.history.setAnswer(r.historyId, id, { name: nameOf(id), state, text, md, ...(metrics ? { metrics: cleanMetrics(metrics) } : {}) });
      if (state === 'error') a.notify?.({ kind: 'error', name: nameOf(id) });
      if (r !== round) return; // 그사이 새 질문을 보냈으면 자동 종합 · 완료 알림은 하지 않는다
      r.finished.set(id, state);
      if (r.finished.size < r.targets.length) return;
      if (!r.notified) {
        r.notified = true;
        a.notify?.({ kind: 'round', states: [...r.finished.values()] });
      }
      if (r.synthDone || !a.prefs().autoSynth) return;
      r.synthDone = true;
      runSynth(null, 'auto');
    }

    /**
     * 공통 입력창: 고른 패널들에 같은 질문(과 첨부 파일)을 동시에 보낸다. 종합 요청에는 첨부를 다시 보내지 않는다.
     * opts.question: 기록·종합에 쓸 질문 (프로젝트 맥락을 붙여 보낼 때는 사용자가 쓴 요청만 남긴다)
     * opts.textById: 서비스별로 다른 글을 보낼 때 { id: 글 } (예: 문서 첨부를 받지 않는 서비스에는 맥락을 본문으로)
     * opts.fallbackText: 첨부에 실패한 패널에 대신 보낼 글 (프로젝트 파일 업로드의 내부 예비 경로)
     * opts.prefixById: 서비스별로 글 앞에 붙일 것 { id: 글 } (스킬 지침)
     * opts.plainIds · opts.userFileCount: 프로젝트 파일을 보내지 않을 서비스와, files 중 앞쪽의 사용자가 직접 올린 파일 수
     * opts.project: { name } 프로젝트 맥락을 붙여 보냈다 (v0.27.0 — 기록 표시 · 질문 종류)
     */
    function sendAll(text, targets, files = [], opts = {}) {
      const ids = targets.filter((id) => a.hasPanel(id));
      const meta = files.map(({ name, size, type }) => ({ name, size, type }));
      const question = typeof opts.question === 'string' && opts.question ? opts.question : text;
      const project = opts.project && typeof opts.project.name === 'string' && opts.project.name ? { name: opts.project.name.slice(0, 120) } : undefined;
      // v0.27.0: 대화 줄기 · 질문 종류 (사용자가 직접 올린 파일만 첨부 수로 센다)
      const threadId = pickThread(ids);
      const userFiles = Number.isInteger(opts.userFileCount) ? meta.slice(0, opts.userFileCount) : meta;
      const kind = classifyQuestion({ text: project ? text : question, files: userFiles, project });
      const historyId = a.history.add({ question, targets: ids, files: meta, threadId, kind, ...(project ? { project } : {}) });
      const r = (round = { question, targets: ids, finished: new Map(), synthDone: false, historyId, threadId });
      // 패널마다 넣을 글 · 파일 · 예비 글은 shared/send-plan.js가 계산한다 (화면의 보내기 전 미리보기와 같은 계산)
      //   prefixById(스킬 지침)는 글과 예비 글 앞에, plainIds는 사용자가 직접 올린 파일만 · 예비 글 없음
      return Promise.all(
        planSend(text, ids, files, opts).map((p) =>
          sendToPanel(p.id, p.text, (state, m) => onRoundAnswer(r, p.id, state, m), p.files, p.fallbackText),
        ),
      );
    }

    /**
     * 패널 하나에만 이어서 보낸다 (프로젝트 모드: 요청한 파일 보내기, 전체 파일 다시 요청).
     * 지금 라운드가 있으면 그 기록의 이 서비스 답변을 새 답변으로 바꿔 남긴다.
     */
    function sendFollowUp(id, text, files = [], opts = {}) {
      if (!a.hasPanel(id)) return Promise.resolve({ id, ok: false, error: t('handoff.errClosed') });
      const r = round;
      return sendToPanel(
        id,
        text,
        async (state) => {
          if (state === 'error') a.notify?.({ kind: 'error', name: nameOf(id) });
          // noHistory: 기록에 남기지 않는 요청 (스킬 압축 등 — 질문의 답변을 덮어쓰지 않게)
          if (!r || state !== 'done' || opts.noHistory) return;
          const { text: answer, md } = await readAnswer(id);
          a.history.setAnswer(r.historyId, id, { name: nameOf(id), state, text: answer, md });
        },
        files,
        opts.fallbackText,
      );
    }

    /**
     * 종합 요청. judgeId가 없으면 설정된 종합 담당 AI를 쓴다. mode 'code'는 코드 수정안 합치기,
     * 'analysis'는 답변 일치·이견 분석 (끝나면 round.analysis에 두고 기록에 mode: 'analysis'로 저장, 상태 'done'으로 알림).
     */
    async function runSynth(judgeId, cause = 'manual', mode = 'text') {
      const judge = judgeId || a.prefs().synthTarget;
      if (!round) return fail(t('main.rounds.askFirst'));
      if (!canJudge(judge)) return fail(t('main.rounds.noJudge'));

      let answers = [];
      for (const svc of a.services) {
        if (svc.id === judge || !round.targets.includes(svc.id) || !a.hasPanel(svc.id)) continue;
        // 페이지가 다시 그려지는 순간이면 글이 비어 보일 수 있어 한 번 더 읽는다.
        let { md } = await readAnswer(svc.id);
        if (!md) ({ md } = await sleep(600).then(() => readAnswer(svc.id)));
        if (md) answers.push({ name: svc.name, text: md }); // 표·코드가 살아 있도록 Markdown으로 넘긴다
        else a.log('synth', 'skipped (no answer text)', svc.id);
      }
      if (!answers.length) return fail(t('main.rounds.noAnswers'));

      const judgeName = nameOf(judge);
      const judgeAnswered = round.targets.includes(judge);
      const promptOf = (list) => buildSynthPrompt({ question: round.question, answers: list, judgeAnswered, mode, judgeName });
      // 로컬 LLM이 판정이면 컨텍스트 한도에 맞춰 답변마다 같은 비율로 줄인다 (줄인 답 끝에 "(… 일부만 보냄)")
      const fit = fitFor(judge, answers, promptOf(answers.map((x) => ({ ...x, text: '' }))));
      answers = fit.answers;
      const text = promptOf(answers);
      const names = mode === 'analysis' ? analysisNames({ answers, judgeAnswered, judgeName }) : undefined;
      const trimmed = fit.trimmed.length ? fit.trimmed : undefined;
      a.sendSynthStatus({ state: 'sending', judge: judgeName, count: answers.length, cause, mode, trimmed });
      const historyId = round.historyId;
      const r = round;
      if (headlessLocal(judge)) return localSynth();
      const res = await sendToPanel(judge, text, async (state) => {
        if (state !== 'done') {
          // 분석은 화면이 "분석하는 중"을 기다리므로, 답이 오지 않고 끝나도(시간 초과 · 답변 없음) 알려 준다
          const why = t(state === 'timeout' ? 'main.rounds.whyTimeout' : state === 'no-answer' ? 'main.rounds.whyNoAnswer' : 'main.rounds.whyFailed');
          if (mode === 'analysis' && state !== 'error') fail(t('main.rounds.analysisFailed', { name: judgeName, why }));
          else if (state !== 'error') a.notify?.({ kind: 'synth', ok: false, judge: judgeName, mode });
          return;
        }
        const got = await readAnswer(judge);
        const entry = { judge: judgeName, at: Date.now(), ...got, ...(mode === 'analysis' ? { mode, names } : {}) };
        a.history.addSynth(historyId, entry);
        a.notify?.({ kind: 'synth', ok: true, judge: judgeName, mode });
        if (mode === 'analysis') {
          r.analysis = entry;
          r.analyses = [...(r.analyses || []), entry]; // 다시 분석해도 지난 분석을 남겨 둘을 나란히 비교한다 (v0.26.0)
          a.sendSynthStatus({ state: 'done', judge: judgeName, count: answers.length, cause, mode });
        }
      });
      if (!res.ok) return fail(t('main.rounds.sendFailed', { name: judgeName, error: res.error }));
      a.sendSynthStatus({ state: 'sent', judge: judgeName, count: answers.length, cause, mode, trimmed });
      return { ok: true, judge: judgeName, count: answers.length };

      /** 패널 없이 로컬 LLM에 묻기 (v0.29.0): 답이 오면 기록에 남기고 'done' (headless · historyId를 함께 알려 화면이 결과를 열 수 있게) */
      async function localSynth() {
        a.sendSynthStatus({ state: 'sent', judge: judgeName, count: answers.length, cause, mode, trimmed, headless: true });
        const got = await a.localJudge.ask(text);
        if (!got?.ok) return fail(`${judgeName}: ${got?.error || t('main.rounds.whyFailed')}`);
        const entry = { judge: judgeName, at: Date.now(), text: got.text, md: got.text, ...(mode === 'analysis' ? { mode, names } : {}) };
        a.history.addSynth(historyId, entry);
        a.notify?.({ kind: 'synth', ok: true, judge: judgeName, mode });
        if (mode === 'analysis') {
          r.analysis = entry;
          r.analyses = [...(r.analyses || []), entry];
        }
        a.sendSynthStatus({ state: 'done', judge: judgeName, count: answers.length, cause, mode, trimmed, headless: true, historyId });
        return { ok: true, judge: judgeName, count: answers.length, headless: true };
      }

      function fail(error) {
        a.sendSynthStatus({ state: 'error', error, cause, mode });
        a.notify?.({ kind: 'synth', ok: false, judge: nameOf(judge), mode }); // 이름은 nameOf로 (judgeName을 정하기 전에도 불린다)
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
      const rec = round && a.history.get ? a.history.get(round.historyId) : null;
      const synths = Array.isArray(rec?.synth) ? rec.synth : [];
      return {
        question: round?.question || '',
        answers: list,
        analysis: round?.analysis || null,
        // v0.26.0: 이번 질문의 분석 전부(다시 분석 비교) · 이어 묻기 · 토론 기록 · 토론 결론
        analyses: round?.analyses || [],
        chain: Array.isArray(rec?.chain) ? rec.chain : [],
        debates: synths.filter((s) => s.mode === 'debate'),
      };
    }

    /** 패널 하나의 최신 답변 (답변이 끝날 때마다 그 패널만 읽으려고 — 열린 패널을 다 읽는 answers()보다 가볍다) */
    async function answer(id) {
      const svc = a.services.find((s) => s.id === id);
      if (!svc || !a.hasPanel(id)) return null;
      return { id, name: svc.name, color: svc.color, ...(await readAnswer(id)) };
    }

    // ---------- 이어 묻기 · 다시 보내기 · 토론 (v0.26.0) ----------

    /** 기록에 이어 묻기 한 줄 (기록이 없거나 addChain이 없으면 건너뜀) */
    function addChain(r, entry) {
      if (r && a.history.addChain) a.history.addChain(r.historyId, entry);
    }

    /** 패널 하나에 보내고 답이 끝날 때까지 기다린다 → { state, text, md } (시간 초과면 그때까지 쓴 글) */
    function sendAndWait(id, text) {
      // 토론 판정을 패널 없는 로컬 LLM에 맡겼을 때 (v0.29.0)
      if (headlessLocal(id)) return a.localJudge.ask(text).then((got) => (got?.ok ? { state: 'done', text: got.text, md: got.text } : { state: 'error', text: '', md: '', error: got?.error }));
      return new Promise((resolve) => {
        let done = false;
        sendToPanel(id, text, async (state) => {
          if (done) return; // 시간 초과 뒤 늦게 끝난 것은 무시 (토론은 이미 다음으로 갔다)
          done = true;
          const got = state === 'done' || state === 'timeout' ? await readAnswer(id) : { text: '', md: '' };
          resolve({ state, ...got });
        }).then((res) => {
          if (!res.ok && !done) {
            done = true;
            resolve({ state: 'error', text: '', md: '', error: res.error });
          }
        });
      });
    }

    /**
     * 넘기기: fromId 패널의 최신 답변을 toId 패널에 보내 검토 · 반박 · 이어서 쓰기를 부탁한다.
     * 답이 끝나면 지금 라운드 기록의 chain에 { kind: 'handoff', intent, from, to, ... } 로 남긴다. → { ok } | { ok: false, error }
     */
    async function handoff(fromId, toId, intent) {
      if (!INTENTS.includes(intent)) return { ok: false, error: t('handoff.errIntent') };
      if (fromId === toId) return { ok: false, error: t('handoff.errSame') };
      if (!a.hasPanel(fromId) || !a.hasPanel(toId)) return { ok: false, error: t('handoff.errClosed') };
      const { md } = await readAnswer(fromId);
      if (!md) return { ok: false, error: t('handoff.errNoAnswer', { name: nameOf(fromId) }) };
      const r = round;
      const text = buildHandoffPrompt({ intent, question: r?.question || '', fromName: nameOf(fromId), answer: md });
      const res = await sendToPanel(toId, text, async (state) => {
        if (state === 'error') a.notify?.({ kind: 'error', name: nameOf(toId) });
        if (state !== 'done') return;
        const got = await readAnswer(toId);
        addChain(r, { kind: 'handoff', intent, from: fromId, to: toId, fromName: nameOf(fromId), toName: nameOf(toId), at: Date.now(), state, ...got });
      });
      return res.ok ? { ok: true, from: nameOf(fromId), to: nameOf(toId) } : { ok: false, error: res.error };
    }

    /** [다시 보내기]: 그 패널에 마지막으로 보낸 글 · 파일을 그대로 다시 보낸다 (끝나면 처음 보낸 것과 같은 곳에 기록) */
    async function resend(id) {
      const last = lastSent.get(id);
      if (!last || !a.hasPanel(id)) return { ok: false, error: t('retry.errNothing') };
      const res = await sendToPanel(id, last.text, last.onFinish, last.files, last.fallbackText);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }

    /**
     * 다른 AI로 보내기 (사용 한도 제안에서 사용자가 고른 것만): fromId에 마지막으로 보낸 글 · 파일을 toId에 보낸다.
     * 답이 끝나면 기록의 chain에 { kind: 'fallback', from, to, ... }.
     */
    async function sendElsewhere(fromId, toId) {
      const last = lastSent.get(fromId);
      if (fromId === toId) return { ok: false, error: t('handoff.errSame') };
      if (!last) return { ok: false, error: t('retry.errNothing') };
      if (!a.hasPanel(toId)) return { ok: false, error: t('handoff.errClosed') };
      const r = round;
      const res = await sendToPanel(
        toId,
        last.text,
        async (state) => {
          if (state === 'error') a.notify?.({ kind: 'error', name: nameOf(toId) });
          if (state !== 'done') return;
          const got = await readAnswer(toId);
          addChain(r, { kind: 'fallback', from: fromId, to: toId, fromName: nameOf(fromId), toName: nameOf(toId), at: Date.now(), state, ...got });
        },
        last.files,
        last.fallbackText,
      );
      return res.ok ? { ok: true, to: nameOf(toId) } : { ok: false, error: res.error };
    }

    const debate = createDebate({
      sendAndWait,
      readAnswer,
      nameOf,
      openIds,
      // 판정은 열린 패널 + (켜 두었으면) 패널 없는 로컬 LLM (v0.29.0)
      judgeIds: () => [...openIds(), ...(a.localJudge && headlessLocal(a.localJudge.id) ? [a.localJudge.id] : [])],
      fitPositions: (judgeId, positions) => fitFor(judgeId, positions, '').answers,
      defaultJudge: () => a.prefs().synthTarget,
      getRound: () => round,
      history: { addChain: (hid, e) => a.history.addChain?.(hid, e), addSynth: (hid, e) => a.history.addSynth(hid, e) },
      status: (patch) => a.sendSynthStatus({ ...patch, mode: 'debate' }),
      notify: (e) => a.notify?.(e),
      cancel: cancelWatch,
      log: a.log,
    });

    return {
      sendAll,
      sendFollowUp,
      runSynth,
      collectMarkdown,
      answers,
      answer,
      cancelWatch,
      resetPanel,
      threadId: () => round?.threadId || null,
      handoff,
      resend,
      sendElsewhere,
      startDebate: (cfg) => debate.start(cfg),
      stopDebate: () => debate.stop(),
      interjectDebate: (text) => debate.interject(text), // 라운드 사이 끼어들기 (v0.32.0)
      debateDone: () => debate.whenDone(),
    };
  }

  return { createRounds };
});
