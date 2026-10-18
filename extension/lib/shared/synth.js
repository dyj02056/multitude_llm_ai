// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/synth.js)
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
  const MAX_CODE_ANSWER_CHARS = 20000; // 코드 수정안 합치기는 diff가 잘리면 안 돼서 더 길게 둔다

  function clip(text, max = MAX_ANSWER_CHARS) {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n…(이하 생략)`;
  }

  /**
   * question: 원래 질문
   * answers: [{ name, text }] — 종합을 맡은 AI를 뺀 다른 AI들의 답변
   * judgeAnswered: 종합을 맡은 AI도 같은 질문에 이미 답했는지
   * mode: 'code'면 여러 코드 수정안을 하나로 합쳐 diff로 달라고 한다 (프로젝트 모드의 "종합으로 합치기")
   */
  function buildSynthPrompt({ question, answers, judgeAnswered, mode }) {
    const max = mode === 'code' ? MAX_CODE_ANSWER_CHARS : MAX_ANSWER_CHARS;
    const blocks = answers.map((a) => `[${a.name}의 답변]\n${clip(a.text, max)}`).join('\n\n');
    const compare = judgeAnswered ? '당신의 이전 답변과 위 답변들을 비교해서' : '위 답변들을 비교해서';
    if (mode === 'code') {
      return [
        '같은 코드 작업 요청에 대해 다른 AI들이 아래와 같은 수정안을 냈습니다.',
        '',
        '[원래 질문]',
        question,
        '',
        blocks,
        '',
        `${compare} 다음을 해 주세요.`,
        '1) 각 수정안의 문제점(버그·빠진 처리)을 짧게 정리',
        '2) 가장 좋은 부분을 합친 최종 수정안을 파일별 unified diff 코드 블록(```diff, --- a/경로 / +++ b/경로)으로 제시',
        '3) 새 파일은 "파일: 경로" 줄 다음에 전체 내용을 코드 블록으로',
      ].join('\n');
    }
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
