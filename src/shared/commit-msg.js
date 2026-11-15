// 적용 후 커밋 (v0.28.0) 메시지: 기본 메시지 만들기 · AI에게 한 줄 요약 부탁 · 받은 답에서 한 줄 꺼내기.
// Electron 앱(require)과 화면(전역 MLA.commitMsg)이 같이 쓴다. 커밋 자체는 Windows 앱의 main/gitcommit.js가 한다.
//
// [쉽게 말하면] 커밋 창에 미리 채워 둘 메시지("Apply Claude's changes: a.js, b.js")를 만들고,
// AI에게 "한 줄로 요약해 줘"라고 부탁한 답에서 메시지 한 줄만 골라내는 부품입니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).commitMsg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_LIST = 5; // 제목에 늘어놓는 파일 이름 수
  const MAX_SUMMARY = 200;

  const base = (p) => String(p).split('/').pop();

  /** 파일 목록 → "a.js, b.js" (많으면 "a.js, b.js, … and 3 more") */
  function fileList(paths) {
    const names = paths.map(base);
    if (names.length <= MAX_LIST) return names.join(', ');
    return `${names.slice(0, MAX_LIST).join(', ')} and ${names.length - MAX_LIST} more`;
  }

  /**
   * 기본 메시지. sources: [{ name, paths }] (수정안을 낸 AI, 섞어 적용했으면 여럿)
   * 한 AI: "Apply Claude's changes: a.js, b.js" / 여럿: "Apply changes from Claude, ChatGPT: a.js, b.js"
   * 둘째 줄부터는 파일별 출처와 전체 경로 (여럿일 때 · 경로가 폴더 안일 때)
   */
  function defaultMessage(sources) {
    const list = (sources || []).filter((s) => s && Array.isArray(s.paths) && s.paths.length);
    const paths = list.flatMap((s) => s.paths);
    if (!paths.length) return '';
    const who = list.map((s) => s.name || 'AI');
    const subject = who.length === 1 ? `Apply ${who[0]}'s changes: ${fileList(paths)}` : `Apply changes from ${who.join(', ')}: ${fileList(paths)}`;
    const needBody = who.length > 1 || paths.some((p) => p.includes('/')) || paths.length > MAX_LIST;
    if (!needBody) return subject;
    const body = list.flatMap((s) => s.paths.map((p) => (who.length > 1 ? `- ${p} (${s.name || 'AI'})` : `- ${p}`)));
    return `${subject}\n\n${body.join('\n')}`;
  }

  /** AI에게 보내는 부탁: 바꾼 파일 목록만 (내용은 보내지 않음 — 그 AI가 낸 수정안이라 이미 안다) */
  function summaryPrompt(paths) {
    return [
      '방금 제안해 준 수정안을 아래 파일에 적용했습니다. 이 변경을 설명하는 git 커밋 메시지를 영어 한 줄(72자 이내, 명령형, 예: "Fix null check in user loader")로만 써 주세요.',
      '다른 설명 · 따옴표 · 코드 블록 없이 메시지 한 줄만 답해 주세요.',
      '',
      ...paths.slice(0, 50).map((p) => `- ${p}`),
      ...(paths.length > 50 ? [`- … (${paths.length - 50} more)`] : []),
    ].join('\n');
  }

  const LABEL = /^(?:commit\s*message|커밋\s*메시지|message|메시지)\s*[:：-]\s*/i;

  /** AI 답(Markdown)에서 메시지 한 줄 꺼내기 → 문자열 | null. 코드 블록 안의 첫 줄도 받는다 */
  function parseSummary(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    for (let raw of lines) {
      let s = raw.trim();
      if (!s || /^(```|~~~)/.test(s)) continue;
      s = s.replace(/^(?:[-*+>]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '').replace(LABEL, '').trim();
      s = s.replace(/^\*\*(.*)\*\*$/, '$1').replace(/^`+|`+$/g, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
      s = s.replace(LABEL, '').trim();
      if (!s || /[:：]$/.test(s)) continue; // "커밋 메시지:" 같은 머리말만 있는 줄
      return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s;
    }
    return null;
  }

  /** 요약 한 줄을 기본 메시지의 제목 자리에 넣는다 (둘째 줄부터의 파일 목록은 그대로) */
  function withSubject(message, subject) {
    const s = String(subject || '').trim();
    if (!s) return message;
    const rest = String(message || '').split('\n').slice(1).join('\n');
    return rest.trim() ? `${s}\n${rest}` : s;
  }

  return { defaultMessage, summaryPrompt, parseSummary, withSubject, fileList };
});
