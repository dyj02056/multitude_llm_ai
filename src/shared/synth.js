// 교차검토(종합) 질문 만들기.
// 다른 AI들의 답변을 모아, 종합을 맡은 AI 하나에게 비교·정리를 부탁한다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.synth)이 같이 쓴다.
//
// [쉽게 말하면] "종합 요청" 글을 만드는 파일입니다.
// 원래 질문과 다른 AI들의 답변을 모아 "틀린 점·빠진 점을 찾아 최종 답을 정리해 줘"라는 요청문으로 엮습니다.
// 답변이 너무 길면 잘라서, 한 번에 보낼 수 있는 길이로 맞춥니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).synth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ANSWER_CHARS = 6000; // 답변 하나가 너무 길면 잘라서 입력 한도를 넘지 않게 한다
  const MAX_CODE_ANSWER_CHARS = 40000; // 코드 수정안 합치기는 파일 전체 내용이 잘리면 안 돼서 더 길게 둔다

  function clip(text, max = MAX_ANSWER_CHARS) {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n…(이하 생략)`;
  }

  /**
   * question: 원래 질문
   * answers: [{ name, text }] — 종합을 맡은 AI를 뺀 다른 AI들의 답변
   * judgeAnswered: 종합을 맡은 AI도 같은 질문에 이미 답했는지
   * mode: 'code'면 여러 코드 수정안을 하나로 합쳐 파일별 전체 내용으로 달라고 한다 (프로젝트 모드의 "종합으로 합치기")
   *       'analysis'면 정해진 형식(공통 의견 / 이견 표 / 근거 부족 / 최종 답변)으로 답하게 한다 (답변 비교의 "분석" 탭, shared/analysis.js가 읽음)
   * judgeName: 판정 AI 이름 (analysis에서 판정 AI 자신의 이전 답변도 이견 표의 열로 쓰게 한다)
   */
  function buildSynthPrompt({ question, answers, judgeAnswered, mode, judgeName }) {
    if (mode === 'analysis') return buildAnalysisPrompt({ question, answers, judgeAnswered, judgeName });
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
        '2) 가장 좋은 부분을 합친 최종 수정안을 diff가 아니라, 바꾸거나 새로 만든 파일마다 "파일: 경로" 줄 다음에 그 파일의 "전체" 내용을 코드 블록 하나로 제시 (줄임 없이 처음부터 끝까지)',
        '3) 지워야 하는 파일은 한 줄로: DELETE_FILES: 경로1, 경로2',
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

  /** 분석 표의 열로 쓸 AI 이름들 (판정 AI가 이미 답했으면 그 이름도 맨 뒤에) */
  function analysisNames({ answers, judgeAnswered, judgeName }) {
    const names = answers.map((a) => a.name);
    if (judgeAnswered && judgeName && !names.includes(judgeName)) names.push(judgeName);
    return names;
  }

  /**
   * 답변 일치·이견 분석 요청. 머리글 이름(공통 의견 · 이견 · 근거 부족 · 최종 답변)은 shared/analysis.js의 SECTIONS와 같아야 한다.
   */
  function buildAnalysisPrompt({ question, answers, judgeAnswered, judgeName }) {
    const blocks = answers.map((a) => `[${a.name}의 답변]\n${clip(a.text)}`).join('\n\n');
    const names = analysisNames({ answers, judgeAnswered, judgeName });
    const self = judgeAnswered && judgeName ? [`당신(${judgeName})이 이전에 같은 질문에 한 답변도 "${judgeName}" 열로 함께 비교해 주세요.`] : [];
    return [
      '같은 질문에 대해 여러 AI가 아래와 같이 답했습니다.',
      '',
      '[원래 질문]',
      question,
      '',
      blocks,
      '',
      '답변들이 어디서 일치하고 어디서 갈리는지 분석해, 아래 형식 그대로 답해 주세요.',
      '머리글 네 개(## 공통 의견, ## 이견, ## 근거 부족, ## 최종 답변)의 이름과 순서를 바꾸지 말고, 형식 앞뒤에 다른 말을 쓰지 마세요. 전체를 코드 블록으로 감싸지 마세요.',
      ...self,
      '',
      '## 공통 의견',
      '- 대부분의 AI가 같은 내용 (한 줄에 하나)',
      '',
      '## 이견',
      `| 쟁점 | ${names.join(' | ')} | 판단 |`,
      `|${' --- |'.repeat(names.length + 2)}`,
      `| 갈리는 점 한 줄 | ${names.map(() => '그 AI의 입장 (언급 없으면 -)').join(' | ')} | 어느 쪽이 맞는지와 이유 한 줄 |`,
      '(이견이 없으면 표 대신 "- 없음" 한 줄)',
      '',
      '## 근거 부족',
      '- [AI 이름] 근거 없이 주장했거나 사실 확인이 필요한 내용 (없으면 "- 없음")',
      '',
      '## 최종 답변',
      '위 분석을 반영한 가장 정확하고 완성도 높은 최종 답변',
    ].join('\n');
  }

  return { buildSynthPrompt, buildAnalysisPrompt, analysisNames };
});
