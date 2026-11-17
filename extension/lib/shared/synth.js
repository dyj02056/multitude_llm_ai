// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/synth.js)
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

  // AI에게 보내는 글 (i18n-<언어>-prompt.js, v0.31.0 — 화면 언어를 따른다). 부를 때 찾는다.
  const t = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };

  const MAX_ANSWER_CHARS = 6000; // 답변 하나가 너무 길면 잘라서 입력 한도를 넘지 않게 한다
  const MAX_CODE_ANSWER_CHARS = 40000; // 코드 수정안 합치기는 파일 전체 내용이 잘리면 안 돼서 더 길게 둔다

  function clip(text, max = MAX_ANSWER_CHARS) {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n${t('prompt.clipped')}`;
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
    const blocks = answers.map((a) => `${t('prompt.answerOf', { name: a.name })}\n${clip(a.text, max)}`).join('\n\n');
    const key = mode === 'code' ? 'prompt.synth.code' : 'prompt.synth';
    return [
      t(`${key}.head`),
      '',
      t('prompt.origQuestion'),
      question,
      '',
      blocks,
      '',
      t(judgeAnswered ? `${key}.askSelf` : `${key}.ask`),
      t(`${key}.steps`),
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
    const blocks = answers.map((a) => `${t('prompt.answerOf', { name: a.name })}\n${clip(a.text)}`).join('\n\n');
    const names = analysisNames({ answers, judgeAnswered, judgeName });
    const self = judgeAnswered && judgeName ? [t('prompt.analysis.self', { name: judgeName })] : [];
    return [
      t('prompt.analysis.head'),
      '',
      t('prompt.origQuestion'),
      question,
      '',
      blocks,
      '',
      t('prompt.analysis.ask'),
      ...self,
      '',
      t('prompt.analysis.common'),
      '',
      t('prompt.analysis.disagree'),
      `| ${t('prompt.analysis.colTopic')} | ${names.join(' | ')} | ${t('prompt.analysis.colVerdict')} |`,
      `|${' --- |'.repeat(names.length + 2)}`,
      `| ${t('prompt.analysis.cellTopic')} | ${names.map(() => t('prompt.analysis.cellPosition')).join(' | ')} | ${t('prompt.analysis.cellVerdict')} |`,
      t('prompt.analysis.noDisagree'),
      '',
      t('prompt.analysis.rest'),
    ].join('\n');
  }

  return { buildSynthPrompt, buildAnalysisPrompt, analysisNames };
});
