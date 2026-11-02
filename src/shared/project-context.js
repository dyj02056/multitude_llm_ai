// 프로젝트 맥락(구조 + 고른 파일 내용)을 AI에게 보낼 글로 만들고, 답변 끝의 NEED_FILES 요청을 읽는다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.projectContext)이 같이 쓴다.
//
// [쉽게 말하면]
// 프로젝트 모드에서 AI에게 보낼 "설명 자료"를 만드는 파일입니다.
//   - 프로젝트 구조(파일 이름 목록)와 고른 파일 내용을 정리해 붙이고
//   - "이런 형식으로 답해 줘"라는 답변 규칙(RULES)을 덧붙입니다.
//   - AI 답변 끝의 "NEED_FILES: a.js, b.js"(더 보고 싶은 파일)를 읽어 냅니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).projectContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INLINE_LIMIT = 100000; // 본문에 넣는 최대 글자 수 (업로드를 못 할 때 본문으로 보내는 글 — project-upload.js의 inlineText)
  const TREE_LINE_LIMIT = 3000; // 구조 목록이 이보다 길면 자른다
  const CONTEXT_FILE = 'project-context.md';

  // 이보다 긴 기존 파일은 전체 대신 찾기/바꾸기로 받는다 (v0.17.0 — 출력 한도로 답이 잘리지 않게)
  const EDIT_LINES = 150;

  // AI에게 매번 함께 보내는 답변 규칙. 이 형식을 지켜야 변경 제안·파일 모아보기가 수정안을 찾을 수 있습니다.
  const RULES = [
    '[답변 규칙]',
    '1) 먼저 원인이나 설계를 3줄 이내로 설명해 줘.',
    `2) 파일 수정은 diff로 주지 말고, 파일마다 "파일: 경로" 줄 다음에 코드 블록 하나로 줘. 한 코드 블록에는 한 파일만 넣어 줘.`,
    `   - 새 파일이거나 ${EDIT_LINES}줄 이하인 파일: 그 파일의 "전체" 내용. "..."이나 "(기존과 같음)"으로 줄이지 말고 처음부터 끝까지 다 써 줘.`,
    `   - ${EDIT_LINES}줄보다 긴 기존 파일: 전체를 다시 쓰지 말고 바꿀 곳만 찾기/바꾸기로 줘 (답이 길어져 잘리지 않게). 찾을 부분은 지금 파일 그대로(한 글자도 바꾸지 말고) 파일 안에서 한 곳만 맞도록 앞뒤 줄을 조금 넣고, 바꿀 곳이 여러 군데면 한 블록 안에 여러 번 써 줘.`,
    '   내용에 ``` 가 들어 있는 파일(.md 등)은 바깥 울타리를 ```` (백틱 4개, 안쪽보다 길게)로 써서 블록이 중간에 끊기지 않게 해 줘:',
    '파일: 경로/짧은파일',
    '```',
    '(수정한 전체 내용)',
    '```',
    '파일: 경로/긴파일',
    '```',
    '<<<<<<< 찾기',
    '(지금 파일에서 바꿀 부분 그대로)',
    '=======',
    '(바꾼 내용)',
    '>>>>>>> 바꾸기',
    '```',
    '3) 지워야 하는 파일이 있으면 한 줄로 적어 줘: DELETE_FILES: 경로1, 경로2',
    '4) 내용을 더 봐야 하는 파일이 있으면 답변 맨 끝에 한 줄로 적어 줘: NEED_FILES: 경로1, 경로2',
  ].join('\n');

  const LANG = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', json: 'json', md: 'markdown', py: 'python',
    rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c',
    hpp: 'cpp', php: 'php', swift: 'swift', sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    html: 'html', css: 'css', scss: 'scss', sql: 'sql', xml: 'xml', vue: 'vue', svelte: 'svelte', dart: 'dart',
  };
  const langOf = (path) => LANG[(path.split('.').pop() || '').toLowerCase()] || '';

  /** 코드 블록 울타리: 내용에 ```가 있으면 더 긴 울타리를 쓴다 */
  function fence(text) {
    let n = 3;
    for (const m of text.matchAll(/`{3,}/g)) n = Math.max(n, m[0].length + 1);
    return '`'.repeat(n);
  }

  function fileBlock(path, text) {
    const f = fence(text);
    return `[파일: ${path}]\n${f}${langOf(path)}\n${text.replace(/\n$/, '')}\n${f}`;
  }

  /**
   * 보낼 파일들의 구조 목록. paths: 제외 규칙을 통과한 파일 경로들(폴더 이름은 경로에서 만든다).
   * src/
   *   main/
   *     main.js
   */
  // 파일 경로 목록을 들여쓰기 된 나무 모양 목록으로 바꿉니다 (폴더 안의 파일이 한 칸 들여 써짐).
  function buildTree(paths) {
    const lines = [];
    const seen = new Set();
    for (const p of [...paths].sort()) {
      const parts = p.split('/');
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(0, i + 1).join('/');
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`${'  '.repeat(i)}${parts[i]}${i < parts.length - 1 ? '/' : ''}`);
      }
    }
    if (lines.length <= TREE_LINE_LIMIT) return lines.join('\n');
    return `${lines.slice(0, TREE_LINE_LIMIT).join('\n')}\n… (${lines.length - TREE_LINE_LIMIT}줄 생략)`;
  }

  /**
   * 첫 질문용 글.
   * project: { name, paths: 보내도 되는 파일 경로 전체 }, files: [{ path, text }] (내용을 넣을 파일), request: 사용자 질문
   * 결과: { text, attachment: { name, content } | null, inlineText } — 길면 맥락을 파일로 빼고 text는 짧게.
   *   inlineText는 문서 첨부를 받지 않는 서비스용(본문에 넣되 INLINE_LIMIT에서 자른 것).
   */
  function buildContext({ project, files, request }) {
    const head = `[프로젝트: ${project.name}] (제외 규칙을 통과한 파일 ${project.paths.length}개 중 ${files.length}개 내용 포함)`;
    const context = [
      head,
      '',
      '[프로젝트 구조]',
      buildTree(project.paths),
      '',
      ...files.map((f) => `${fileBlock(f.path, f.text)}\n`),
    ].join('\n');
    const tail = `[요청]\n${request || '(요청 없음 — 위 내용을 검토해 줘)'}\n\n${RULES}`;
    const inline = `${context}\n${tail}`;
    if (inline.length <= INLINE_LIMIT) return { text: inline, attachment: null, inlineText: inline };

    const short = `[프로젝트: ${project.name}] 첨부한 ${CONTEXT_FILE}에 프로젝트 구조와 파일 ${files.length}개의 내용이 있습니다.\n\n${tail}`;
    const room = INLINE_LIMIT - tail.length - 200;
    const cut = `${context.slice(0, Math.max(0, room))}\n… (분량이 많아 여기까지만 넣었습니다)\n\n${tail}`;
    return { text: short, attachment: { name: CONTEXT_FILE, content: context }, inlineText: cut };
  }

  /**
   * NEED_FILES 요청에 답하는 글.
   * files: [{ path, text }] 보낼 파일, skipped: [{ path, reason }] 보내지 않은 파일
   */
  function buildFollowUp(files, skipped = []) {
    const parts = ['요청한 파일입니다.', ''];
    for (const f of files) parts.push(fileBlock(f.path, f.text), '');
    if (skipped.length) {
      parts.push('[보내지 않은 파일]');
      for (const s of skipped) parts.push(`- ${s.path}: ${s.reason}`);
      parts.push('');
    }
    parts.push('같은 답변 규칙으로 이어서 답해 줘.', '', RULES);
    return parts.join('\n');
  }

  /** diff가 현재 파일과 맞지 않을 때: 현재 내용을 주고 전체 파일로 다시 달라고 한다 */
  function buildRefetch(path, text) {
    return [
      `아래 파일은 네가 준 diff가 현재 내용과 맞지 않아 적용하지 못했어. 지금 내용을 줄게.`,
      `수정한 "전체" 파일 내용을 "파일: ${path}" 줄 다음에 코드 블록 하나로 다시 줘.`,
      '',
      fileBlock(path, text),
    ].join('\n');
  }

  /**
   * 답변에서 NEED_FILES 요청을 읽는다. "NEED_FILES: a.js, src/b.ts" (쉼표·공백 구분, 백틱·따옴표 허용)
   * 바로 아래 "- 경로" 목록도 받는다. 결과: 경로 목록(중복 없음)
   */
  function parseNeedFiles(text) {
    const out = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*[*_`>-]*\s*NEED_FILES\s*[*_`]*\s*[:：]\s*(.*)$/i);
      if (!m) continue;
      const items = m[1].split(/[,\s]+/);
      for (let j = i + 1; j < lines.length && /^\s*[-*]\s+\S/.test(lines[j]); j++) items.push(lines[j].replace(/^\s*[-*]\s+/, ''));
      for (let p of items) {
        p = p.replace(/^[`'"*(\[]+|[`'"*)\].,;]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (p && /[\w-]/.test(p) && !out.includes(p)) out.push(p);
      }
    }
    return out;
  }

  // ---------- 큰 작업: 계획 먼저, 파일별로 받기 (v0.18.0) ----------
  // 고칠 파일이 많거나 길면 한 답에 다 쓰다가 출력 한도로 끊긴다. 그래서 먼저 "고칠 파일 목록과 할 일"만 받고,
  // 앱이 "1/5: a.js만"처럼 한 파일씩 차례로 물어 모은다. 답 하나의 길이가 파일 하나로 줄어 끝까지 받을 수 있다.
  const MAX_PLAN_FILES = 30;
  const SPLIT_SUGGEST = { files: 4, lines: 600 }; // 이보다 많이 고르면 "큰 작업"을 권한다

  // 질문 뒤에 붙여, 이번 답에서는 코드 없이 계획만 받는다
  const PLAN_FIRST = [
    '[큰 작업 — 이번 답은 계획만]',
    '이번 답에서는 코드를 쓰지 마. 고칠 파일이 많아서, 먼저 계획만 받고 파일마다 따로 물어볼게.',
    '1) 무엇을 어떻게 바꿀지 5줄 이내로 설명해 줘.',
    '2) 바꾸거나 새로 만들 파일을 고치는 순서대로, 한 줄에 하나씩 "- 경로: 그 파일에서 할 일 한 줄"로 적어 줘.',
    '3) 맨 끝에 같은 파일들을 한 줄로 적어 줘: PLAN_FILES: 경로1, 경로2, 경로3',
    '4) 지울 파일은 DELETE_FILES: 경로 로 적어 줘. 내용을 더 봐야 하는 파일은 NEED_FILES: 경로 로 적어 줘.',
    '아래 답변 규칙(코드 형식)은 내가 파일별로 물어볼 때 지켜 줘.',
  ].join('\n');

  /**
   * 계획 답에서 고칠 파일 목록을 읽는다: "PLAN_FILES: a.js, b.js" 줄 + 그 앞의 "- 경로: 할 일" 목록(할 일 글을 붙이려고)
   * → [{ path, note }] (순서 유지, 중복 없음, 최대 MAX_PLAN_FILES개). PLAN_FILES 줄이 없으면 [].
   */
  function parsePlanFiles(text) {
    const lines = String(text || '').split(/\r?\n/);
    const clean = (p) => p.replace(/^[`'"*(\[]+|[`'"*)\].,;:]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
    const notes = new Map();
    for (const line of lines) {
      const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+[`*]*([^\s`*:：]+)[`*]*\s*[:：—-]+\s*(.+)$/);
      if (m && /[\w-]\.[\w]+$|\//.test(clean(m[1]))) notes.set(clean(m[1]), m[2].trim().slice(0, 200));
    }
    const out = [];
    for (const line of lines) {
      const m = line.match(/^\s*[*_`>-]*\s*PLAN_FILES\s*[*_`]*\s*[:：]\s*(.*)$/i);
      if (!m) continue;
      for (const item of m[1].split(/[,\s]+/)) {
        const p = clean(item);
        if (p && /[\w-]/.test(p) && !out.some((x) => x.path === p)) out.push({ path: p, note: notes.get(p) || '' });
      }
    }
    return out.slice(0, MAX_PLAN_FILES);
  }

  /** 파일 하나를 부탁하는 글 (index는 0부터) */
  function stepPrompt({ path, note }, index, total) {
    return [
      `계획대로 ${index + 1}/${total}번째 파일만 줘: ${path}${note ? ` — ${note}` : ''}`,
      `"파일: ${path}" 줄 다음 코드 블록 하나로, 처음 답변 규칙대로 줘 (${EDIT_LINES}줄 이하 · 새 파일은 전체 내용, 그보다 긴 기존 파일은 찾기/바꾸기).`,
      '이번 답에는 이 파일만 쓰고 다른 파일은 쓰지 마. 설명은 2줄 이내로. 다음 파일은 내가 따로 물어볼게.',
    ].join('\n');
  }

  /** 고른 파일 수 · 줄 수가 크면 "큰 작업"을 권할지 */
  const suggestSplit = ({ files, lines }) => files > SPLIT_SUGGEST.files || lines > SPLIT_SUGGEST.lines;

  return {
    INLINE_LIMIT,
    CONTEXT_FILE,
    EDIT_LINES,
    RULES,
    PLAN_FIRST,
    MAX_PLAN_FILES,
    SPLIT_SUGGEST,
    buildTree,
    buildContext,
    buildFollowUp,
    buildRefetch,
    parseNeedFiles,
    parsePlanFiles,
    stepPrompt,
    suggestSplit,
    fileBlock,
  };
});
