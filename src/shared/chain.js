// AI끼리 이어 묻기 (v0.26.0): 넘기기(hand-off) 요청 글 · 토론 요청 글 · 토론 설정 검사.
// 넘기기 = 한 패널의 최신 답변을 다른 패널에 보내 검토 · 반박 · 이어서 쓰기를 부탁한다.
// 토론 = 참가 AI(2~3개)가 서로의 최신 답변을 받아 반박 · 보완하기를 몇 라운드(1~3) 하고, 판정 AI가 결론을 낸다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.chain)이 같이 쓴다. 실제로 보내고 기다리는 일은 rounds.js · debate.js.
//
// [쉽게 말하면] "이 답변을 저 AI에게 보여 주고 틀린 데를 찾아 달라고 해 줘", "셋이 두 번 토론시키고 한 AI가 정리하게 해 줘"를
// 위한 요청 글을 만들고, 화면에서 고른 토론 설정이 올바른지 확인하는 부품입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).chain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (i18n) {
  'use strict';

  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);

  const INTENTS = ['review', 'counter', 'continue']; // 검토 · 반박 · 이어서
  const MAX_PARTICIPANTS = 3; // 토론 참가 AI 최대 (2~3)
  const MIN_PARTICIPANTS = 2;
  const MAX_ROUNDS = 3; // 토론 라운드 최대 (1~3)
  const DEFAULT_ROUNDS = 2;
  const MAX_SOURCE_CHARS = 12000; // 넘기는 답변 하나 (요청 글이 입력 한도를 넘지 않게)
  const MAX_DEBATE_CHARS = 6000; // 토론에서 다른 AI 답변 하나

  function clip(text, max) {
    const s = String(text || '');
    return s.length <= max ? s : `${s.slice(0, max)}\n${t('prompt.clipped')}`;
  }

  // AI에게 보내는 글은 i18n-<언어>-prompt.js에 있다 (v0.31.0 — 화면 언어를 따른다). 보낼 때마다 찾아야 언어를 바꾼 뒤에도 맞는다.
  const intentAsk = (intent) => t(`prompt.handoff.${INTENTS.includes(intent) ? intent : 'review'}`);

  /**
   * 넘기기 요청 글. intent: 'review' | 'counter' | 'continue', question: 원래 질문(없으면 빼고), fromName: 답변을 쓴 AI, answer: 그 답변(Markdown)
   */
  function buildHandoffPrompt({ intent, question, fromName, answer }) {
    const q = String(question || '').trim();
    return [
      t('prompt.handoff.intro', { name: fromName }),
      '',
      ...(q ? [t('prompt.origQuestion'), q, ''] : []),
      t('prompt.answerOf', { name: fromName }),
      clip(answer, MAX_SOURCE_CHARS),
      '',
      intentAsk(intent),
    ].join('\n');
  }

  /**
   * 토론 한 라운드의 요청 글 (참가 AI 하나에게). others: [{ name, text }] — 다른 참가 AI의 최신 답변
   * round · rounds: 몇 번째 라운드 / 모두 몇 라운드
   */
  function buildDebatePrompt({ question, round, rounds, selfName, others }) {
    const blocks = (others || []).map((o) => `${t('prompt.debate.latestOf', { name: o.name })}\n${clip(o.text, MAX_DEBATE_CHARS)}`).join('\n\n');
    const last = round >= rounds;
    return [
      t('prompt.debate.head', { round, rounds }),
      '',
      t('prompt.origQuestion'),
      String(question || '').trim() || t('prompt.noQuestion'),
      '',
      blocks,
      '',
      selfName ? t('prompt.debate.askSelf', { name: selfName }) : t('prompt.debate.ask'),
      `${t('prompt.debate.steps')}${last ? t('prompt.debate.last') : ''}`,
    ].join('\n');
  }

  /** 토론 판정 요청 글. positions: [{ name, text }] — 참가 AI의 마지막 입장 */
  function buildDebateJudgePrompt({ question, positions, rounds }) {
    const blocks = (positions || []).map((p) => `${t('prompt.judge.finalOf', { name: p.name })}\n${clip(p.text, MAX_DEBATE_CHARS)}`).join('\n\n');
    return [
      t('prompt.judge.head', { rounds }),
      '',
      t('prompt.origQuestion'),
      String(question || '').trim() || t('prompt.noQuestion'),
      '',
      blocks,
      '',
      t('prompt.judge.format'),
    ].join('\n');
  }

  /**
   * 화면이 보낸 토론 설정 검사. cfg: { participants: [id], rounds, judge }, openIds: 지금 열린 패널, defaultJudge: 종합 담당
   * → { ok: true, participants, rounds, judge } | { ok: false, error }
   */
  function normalizeDebate(cfg, openIds, defaultJudge, judgeIds) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const open = Array.isArray(openIds) ? openIds : [];
    const judges = Array.isArray(judgeIds) ? judgeIds : open; // 판정만 고를 수 있는 id (v0.29.0: 패널 없는 로컬 LLM)
    const raw = Array.isArray(c.participants) ? c.participants : [];
    const participants = [...new Set(raw.filter((id) => typeof id === 'string' && open.includes(id)))];
    if (participants.length < MIN_PARTICIPANTS) return { ok: false, error: t('debate.errFew', { n: MIN_PARTICIPANTS }) };
    if (participants.length > MAX_PARTICIPANTS) return { ok: false, error: t('debate.errMany', { n: MAX_PARTICIPANTS }) };
    const n = Number(c.rounds);
    const rounds = Number.isInteger(n) && n >= 1 && n <= MAX_ROUNDS ? n : DEFAULT_ROUNDS;
    const judge =
      typeof c.judge === 'string' && judges.includes(c.judge) ? c.judge : judges.includes(defaultJudge) ? defaultJudge : participants[0];
    return { ok: true, participants, rounds, judge };
  }

  return {
    INTENTS,
    MAX_PARTICIPANTS,
    MIN_PARTICIPANTS,
    MAX_ROUNDS,
    DEFAULT_ROUNDS,
    buildHandoffPrompt,
    buildDebatePrompt,
    buildDebateJudgePrompt,
    normalizeDebate,
  };
});
