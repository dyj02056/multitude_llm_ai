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
    return s.length <= max ? s : `${s.slice(0, max)}\n…(이하 생략)`;
  }

  const INTENT_ASK = {
    review: [
      '위 답변을 꼼꼼히 검토해 주세요.',
      '1) 틀린 내용 · 부정확한 부분 (어디가 왜 틀렸는지)',
      '2) 빠진 중요한 내용',
      '3) 근거가 약하거나 확인이 필요한 주장',
      '4) 위를 고친 더 나은 답변',
    ],
    counter: [
      '위 답변에 반박해 주세요.',
      '1) 가장 약한 논리 · 반례 · 다른 관점을 근거와 함께',
      '2) 그래도 맞는 부분은 인정',
      '3) 반박을 반영한 당신의 결론',
    ],
    continue: [
      '위 답변을 이어받아 더 발전시켜 주세요.',
      '빠진 단계를 채우고, 더 깊이 들어가거나 다음에 할 일을 구체적으로 써 주세요. 이미 쓴 내용은 되풀이하지 마세요.',
    ],
  };

  /**
   * 넘기기 요청 글. intent: 'review' | 'counter' | 'continue', question: 원래 질문(없으면 빼고), fromName: 답변을 쓴 AI, answer: 그 답변(Markdown)
   */
  function buildHandoffPrompt({ intent, question, fromName, answer }) {
    const ask = INTENT_ASK[intent] || INTENT_ASK.review;
    const q = String(question || '').trim();
    return [
      `다른 AI(${fromName})가 쓴 답변을 보여 드립니다.`,
      '',
      ...(q ? ['[원래 질문]', q, ''] : []),
      `[${fromName}의 답변]`,
      clip(answer, MAX_SOURCE_CHARS),
      '',
      ...ask,
    ].join('\n');
  }

  /**
   * 토론 한 라운드의 요청 글 (참가 AI 하나에게). others: [{ name, text }] — 다른 참가 AI의 최신 답변
   * round · rounds: 몇 번째 라운드 / 모두 몇 라운드
   */
  function buildDebatePrompt({ question, round, rounds, selfName, others }) {
    const blocks = (others || []).map((o) => `[${o.name}의 최신 답변]\n${clip(o.text, MAX_DEBATE_CHARS)}`).join('\n\n');
    const last = round >= rounds;
    return [
      `[토론 ${round}/${rounds}라운드] 같은 질문에 대해 다른 AI들이 아래와 같이 답했습니다.`,
      '',
      '[원래 질문]',
      String(question || '').trim() || '(질문 없음)',
      '',
      blocks,
      '',
      `${selfName ? `${selfName}(당신)의 ` : '당신의 '}이전 답변과 비교해 다음을 해 주세요.`,
      '1) 다른 답변에서 틀렸거나 근거가 약한 점을 구체적으로 반박',
      '2) 다른 답변이 옳은 점은 받아들여 당신의 답을 고치기',
      `3) 고친 입장을 처음 보는 사람도 이해할 수 있는 완성된 답변으로 다시 쓰기${last ? ' (이번이 마지막 라운드입니다)' : ''}`,
    ].join('\n');
  }

  /** 토론 판정 요청 글. positions: [{ name, text }] — 참가 AI의 마지막 입장 */
  function buildDebateJudgePrompt({ question, positions, rounds }) {
    const blocks = (positions || []).map((p) => `[${p.name}의 마지막 입장]\n${clip(p.text, MAX_DEBATE_CHARS)}`).join('\n\n');
    return [
      `여러 AI가 같은 질문을 두고 ${rounds}라운드 동안 서로 반박 · 보완하며 토론했습니다. 아래는 각 AI의 마지막 입장입니다.`,
      '',
      '[원래 질문]',
      String(question || '').trim() || '(질문 없음)',
      '',
      blocks,
      '',
      '판정자로서 아래 형식 그대로 정리해 주세요. 머리글 이름과 순서를 바꾸지 마세요.',
      '',
      '## 합의한 점',
      '- 참가 AI들이 같은 결론에 이른 내용 (한 줄에 하나)',
      '',
      '## 남은 이견',
      '- [쟁점] AI별 입장과, 어느 쪽이 맞는지와 이유 (없으면 "- 없음")',
      '',
      '## 최종 답변',
      '토론을 반영한 가장 정확하고 완성도 높은 최종 답변',
    ].join('\n');
  }

  /**
   * 화면이 보낸 토론 설정 검사. cfg: { participants: [id], rounds, judge }, openIds: 지금 열린 패널, defaultJudge: 종합 담당
   * → { ok: true, participants, rounds, judge } | { ok: false, error }
   */
  function normalizeDebate(cfg, openIds, defaultJudge) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const open = Array.isArray(openIds) ? openIds : [];
    const raw = Array.isArray(c.participants) ? c.participants : [];
    const participants = [...new Set(raw.filter((id) => typeof id === 'string' && open.includes(id)))];
    if (participants.length < MIN_PARTICIPANTS) return { ok: false, error: t('debate.errFew', { n: MIN_PARTICIPANTS }) };
    if (participants.length > MAX_PARTICIPANTS) return { ok: false, error: t('debate.errMany', { n: MAX_PARTICIPANTS }) };
    const n = Number(c.rounds);
    const rounds = Number.isInteger(n) && n >= 1 && n <= MAX_ROUNDS ? n : DEFAULT_ROUNDS;
    const judge =
      typeof c.judge === 'string' && open.includes(c.judge) ? c.judge : open.includes(defaultJudge) ? defaultJudge : participants[0];
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
