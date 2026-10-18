// 교차검토(종합) 질문 만들기.
// 다른 AI들의 답변을 모아, 종합을 맡은 AI 하나에게 비교·정리를 부탁한다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.synth)이 같이 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).synth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ANSWER_CHARS = 6000; // 답변 하나가 너무 길면 잘라서 입력 한도를 넘지 않게 한다

  function clip(text) {
    if (text.length <= MAX_ANSWER_CHARS) return text;
    return `${text.slice(0, MAX_ANSWER_CHARS)}\n…(이하 생략)`;
  }

  /**
   * question: 원래 질문
   * answers: [{ name, text }] — 종합을 맡은 AI를 뺀 다른 AI들의 답변
   * judgeAnswered: 종합을 맡은 AI도 같은 질문에 이미 답했는지
   */
  function buildSynthPrompt({ question, answers, judgeAnswered }) {
    const blocks = answers.map((a) => `[${a.name}의 답변]\n${clip(a.text)}`).join('\n\n');
    const compare = judgeAnswered ? '당신의 이전 답변과 위 답변들을 비교해서' : '위 답변들을 비교해서';
    return [
      '같은 질문에 대해 다른 AI들이 아래와 같이 답했습니다.',
      '',
      '[원래 질문]',
      question,
      '',
      blocks,
      '',
      `${compare} 다음을 정리해 주세요.`,
      '1) 오류나 부정확한 부분',
      '2) 서로 놓친 중요한 내용',
      '3) 가장 정확하고 완성도 높은 최종 답변',
    ].join('\n');
  }

  return { buildSynthPrompt };
});
