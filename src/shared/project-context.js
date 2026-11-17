// 프로젝트 맥락(구조 + 고른 파일 내용)을 AI에게 보낼 글로 만들고, 답변 끝의 NEED_FILES 요청을 읽는다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.projectContext)이 같이 쓴다.
//
// [쉽게 말하면]
// 프로젝트 모드에서 AI에게 보낼 "설명 자료"를 만드는 파일입니다.
//   - 프로젝트 구조(파일 이름 목록)와 고른 파일 내용을 정리해 붙이고
//   - "이런 형식으로 답해 줘"라는 답변 규칙(RULES)을 덧붙입니다.
//   - AI 답변 끝의 "NEED_FILES: a.js, b.js"(더 보고 싶은 파일)를 읽어 냅니다.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).projectContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // 화면 문구 (i18n-*-project.js)와 AI에게 보내는 글(i18n-*-prompt.js, v0.31.0 — 화면 언어를 따른다) — 부를 때 찾는다
  // (Electron 앱 require · 화면 전역 MLA.i18n). 그래서 RULES · PLAN_FIRST는 값이 아니라 읽을 때마다 만드는 속성(getter)이다.
  const tr = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : root && root.MLA && root.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };

  // 경로 정리(프로젝트 밖 · 위험한 이름 거르기)는 patch.js의 safeRelPath를 쓴다. 화면에서는 patch.js가 이 파일보다 늦게
  // 읽히므로 쓸 때 찾는다. 못 찾으면(patch.js 없이 쓰는 경우) 그대로 둔다 — 파일을 읽고 쓰는 쪽에서 한 번 더 거른다.
  function safePath(p) {
    let P = root && root.MLA && root.MLA.patch;
    if (!P && typeof require === 'function') {
      try {
        P = require('./patch');
      } catch {
        P = null;
      }
    }
    return P && typeof P.safeRelPath === 'function' ? P.safeRelPath(p) : p;
  }

  const INLINE_LIMIT = 100000; // 본문에 넣는 최대 글자 수 (업로드를 못 할 때 본문으로 보내는 글 — project-upload.js의 inlineText)
  const TREE_LINE_LIMIT = 3000; // 구조 목록이 이보다 길면 자른다
  const CONTEXT_FILE = 'project-context.md';

  // 이보다 긴 기존 파일은 전체 대신 찾기/바꾸기로 받는다 (v0.17.0 — 출력 한도로 답이 잘리지 않게)
  const EDIT_LINES = 150;

  // AI에게 매번 함께 보내는 답변 규칙. 이 형식을 지켜야 변경 제안·파일 모아보기가 수정안을 찾을 수 있습니다.
  const rules = () => tr('prompt.proj.rules', { n: EDIT_LINES });

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
    return `${tr('prompt.proj.fileLabel', { path })}\n${f}${langOf(path)}\n${text.replace(/\n$/, '')}\n${f}`;
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
    return `${lines.slice(0, TREE_LINE_LIMIT).join('\n')}\n${tr('prompt.proj.treeCut', { n: lines.length - TREE_LINE_LIMIT })}`;
  }

  /**
   * 첫 질문용 글.
   * project: { name, paths: 보내도 되는 파일 경로 전체 }, files: [{ path, text }] (내용을 넣을 파일), request: 사용자 질문
   * 결과: { text, attachment: { name, content } | null, inlineText } — 길면 맥락을 파일로 빼고 text는 짧게.
   *   inlineText는 문서 첨부를 받지 않는 서비스용(본문에 넣되 INLINE_LIMIT에서 자른 것).
   */
  function buildContext({ project, files, request }) {
    const head = tr('prompt.proj.head', { name: project.name, total: project.paths.length, n: files.length });
    const context = [
      head,
      '',
      tr('prompt.proj.tree'),
      buildTree(project.paths),
      '',
      ...files.map((f) => `${fileBlock(f.path, f.text)}\n`),
    ].join('\n');
    const tail = `${tr('prompt.proj.request')}\n${request || tr('prompt.proj.noRequest')}\n\n${rules()}`;
    const inline = `${context}\n${tail}`;
    if (inline.length <= INLINE_LIMIT) return { text: inline, attachment: null, inlineText: inline };

    const short = `${tr('prompt.proj.short', { name: project.name, file: CONTEXT_FILE, n: files.length })}\n\n${tail}`;
    const room = INLINE_LIMIT - tail.length - 200;
    const cut = `${context.slice(0, Math.max(0, room))}\n${tr('prompt.proj.cut')}\n\n${tail}`;
    return { text: short, attachment: { name: CONTEXT_FILE, content: context }, inlineText: cut };
  }

  /**
   * NEED_FILES 요청에 답하는 글.
   * files: [{ path, text }] 보낼 파일, skipped: [{ path, reason }] 보내지 않은 파일
   */
  function buildFollowUp(files, skipped = []) {
    const parts = [tr('prompt.proj.followUp'), ''];
    for (const f of files) parts.push(fileBlock(f.path, f.text), '');
    if (skipped.length) {
      parts.push(tr('prompt.proj.skipped'));
      for (const s of skipped) parts.push(`- ${s.path}: ${s.reason}`);
      parts.push('');
    }
    parts.push(tr('prompt.proj.sameRules'), '', rules());
    return parts.join('\n');
  }

  /** diff가 현재 파일과 맞지 않을 때: 현재 내용을 주고 전체 파일로 다시 달라고 한다 */
  function buildRefetch(path, text) {
    return [
      tr('prompt.proj.refetchIntro'),
      tr('prompt.proj.refetchFull', { path }),
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
        if (!p || !/[\w-]/.test(p)) continue;
        p = safePath(p); // 프로젝트 밖(../x) · 절대 경로 · 위험한 이름은 버린다
        if (p && !out.includes(p)) out.push(p);
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
  const planFirst = () => tr('prompt.proj.planFirst');

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
        const raw = clean(item);
        if (!raw || !/[\w-]/.test(raw)) continue;
        const p = safePath(raw); // 프로젝트 밖(../x) · 절대 경로 · 위험한 이름은 버린다
        if (p && !out.some((x) => x.path === p)) out.push({ path: p, note: notes.get(raw) || notes.get(p) || '' });
      }
    }
    return out.slice(0, MAX_PLAN_FILES);
  }

  /** 파일 하나를 부탁하는 글 (index는 0부터) */
  function stepPrompt({ path, note }, index, total) {
    return tr('prompt.proj.step', { i: index + 1, total, path, note: note ? ` — ${note}` : '', n: EDIT_LINES });
  }

  /** 고른 파일 수 · 줄 수가 크면 "큰 작업"을 권할지 */
  const suggestSplit = ({ files, lines }) => files > SPLIT_SUGGEST.files || lines > SPLIT_SUGGEST.lines;

  // ---------- 보낼 양 어림 (v0.22.0) ----------
  // 토큰은 모델마다 다르게 센다. 파일 크기(UTF-8 바이트)만 보고 어림한다: 영어 · 코드는 약 4글자(4바이트)에 1토큰,
  // 한글은 1글자(3바이트)가 약 0.7토큰이라 결국 둘 다 "바이트 ÷ 4" 근처다. 정확한 값이 아니라 크기 감을 잡는 용도.
  const SPLIT_TOKENS = 12000; // 이보다 많으면 사이드바에 "큰 작업 권장" (답이 출력 한도로 끊기기 쉬움)
  const estimateTokens = (bytes) => Math.max(0, Math.round((Number(bytes) || 0) / 4));
  /** 사이드바 요약에 붙일 글: "≈ 3.2천 토큰" · "≈ 1.4만 토큰" */
  function tokenText(tokens) {
    if (tokens < 1000) return tr('project.tokens.under1k', { n: tokens });
    if (tokens < 10000) return tr('project.tokens.under10k', { n: (tokens / 1000).toFixed(1) });
    // 큰 수의 단위는 사전이 정한다 (한국어 만 = 10000, 영어 k = 1000)
    const unit = Number(tr('project.tokens.over10kUnit')) || 10000;
    return tr('project.tokens.over10k', { n: (tokens / unit).toFixed(1) });
  }
  const suggestSplitTokens = (tokens) => tokens > SPLIT_TOKENS;

  // ---------- 증분 전송 (v0.23.0) ----------
  // AI마다 받은 파일의 내용 지문(해시)을 기억해 두고, 다음 질문에는 그 뒤로 내용이 바뀐 파일만 다시 올린다.
  // 나머지는 "앞서 보낸 그대로" 목록으로만 알려 AI가 그 파일이 아직 있다는 것을 알게 한다.

  /**
   * 내용 지문: cyrb53 (53비트 문자열 해시, 암호용 아님) + 글자 수. 줄바꿈(CRLF/LF) 차이는 같은 내용으로 본다.
   * null · undefined(지워진 파일)는 null.
   */
  function hashText(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).replace(/\r\n/g, '\n');
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}.${s.length.toString(36)}`;
  }

  /** 줄 수 (빈 파일은 0, 끝 줄바꿈은 세지 않음) */
  function lineCount(text) {
    if (text === null || text === undefined) return 0;
    const s = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '');
    return s ? s.split('\n').length : 0;
  }

  /** AI가 받은 기록 하나: { hash, lines } (지워진 파일은 null) */
  const sentEntry = (text) => (text === null || text === undefined ? null : { hash: hashText(text), lines: lineCount(text) });

  /**
   * 이번 질문에 무엇을 올릴지 고른다. 여러 패널에 같은 첨부를 보내므로 패널마다 바뀐 파일을 모아 합친다.
   *   ids: 프로젝트 파일을 보낼 패널 id
   *   files: [{ path, text, checked }] 지금 내용 — checked는 사이드바에서 고른 파일, 아니면 지난번에 보낸 파일(followList)
   *   knownById: Map(id → Map(경로 → { hash, lines } | null)) 그 AI가 마지막으로 받은 내용
   *   treeById: Map(id → 구조 목록 지문), treeHash: 지금 구조 목록 지문
   *   missing: [경로] 지난번에 보냈는데 지금은 없는 파일 (followList일 때만 알림)
   *   followList: 지난번에 보낸 파일도 후보에 넣는다 (바뀌었으면 다시 올리고, 아니면 목록에 줄 수와 함께)
   * → { allFresh, union: [{ path, text }] 올릴 파일, includeTree, byId: { id: { fresh, plain, send, same, gone } } }
   *   plain: 올릴 것이 없는 패널 (질문과 "앞서 보낸 그대로" 목록만 보냄)
   *   same: [{ path, lines }] 그 패널에 다시 보내지 않는 파일 (union에 없는 것 — 그 패널은 이미 지금 내용을 안다)
   */
  function planIncremental({ ids, files, knownById, treeById, treeHash, missing = [], followList = false }) {
    const hashOf = new Map(files.map((f) => [f.path, hashText(f.text)]));
    const getKnown = (id) => (knownById && knownById.get(id)) || null;
    const per = {};
    const need = new Set();
    let includeTree = false;
    for (const id of ids) {
      const known = getKnown(id);
      const tree = treeById ? treeById.get(id) : undefined;
      const fresh = tree === undefined;
      const cands = files.filter((f) => f.checked || (followList && known && known.get(f.path)));
      const send = cands.filter((f) => {
        const k = known && known.get(f.path);
        return !k || k.hash !== hashOf.get(f.path);
      });
      const gone = followList && known ? missing.filter((p) => known.get(p)) : [];
      const needTree = tree !== treeHash;
      const plain = !send.length && !needTree;
      if (!plain) {
        for (const f of send) need.add(f.path);
        if (needTree) includeTree = true;
      }
      per[id] = { fresh, plain, cands, gone };
    }
    const union = files.filter((f) => need.has(f.path)).map(({ path, text }) => ({ path, text }));
    const byId = {};
    for (const id of ids) {
      const { fresh, plain, cands, gone } = per[id];
      const known = getKnown(id);
      const same = cands
        .filter((f) => plain || !need.has(f.path))
        .map((f) => ({ path: f.path, lines: lineCount(f.text) || (known && known.get(f.path) && known.get(f.path).lines) || 0 }));
      byId[id] = { fresh, plain, send: plain ? [] : union.map((f) => f.path), same, gone };
    }
    return { allFresh: ids.length > 0 && ids.every((id) => byId[id].fresh), union, includeTree, byId };
  }

  // ---------- 적용 트랜잭션 (v0.23.0) ----------

  /**
   * 여러 파일을 한 번에 쓴다. 중간에 하나라도 쓰기 · 지우기에 실패하면 이미 쓴 파일을 원래대로 되돌린다
   * (고친 파일은 원래 내용으로, 지운 파일은 다시 만들고, 새로 만든 파일은 지운다).
   *   ops: [{ path, op: 'write' | 'delete', after, before? }] — before(원래 내용, 없던 파일은 null)를 모르면 read로 읽는다
   *   io: { read(path) → 내용 | null(없음), write(path, text), remove(path) }
   * → { ok, done: [{ path, before, after }], failed?: { path, op, error }, restored: [경로], restoreFailed: [{ path, error }] }
   *   실패하면 done은 빈 목록 (되돌렸으므로 쓴 것이 없다)
   */
  async function applyTransaction(ops, io) {
    const done = [];
    const msg = (e) => (e && e.message) || String(e);
    // 하나를 원래대로: 없던 파일은 지우고(이미 없으면 그대로), 있던 파일은 원래 내용으로 쓴다
    const undoOne = async (f) => {
      if (f.before === null) await io.remove(f.path).catch((e) => (/found|ENOENT|없/i.test(msg(e)) ? null : Promise.reject(e)));
      else await io.write(f.path, f.before);
    };
    for (const o of ops) {
      let before = o.before;
      try {
        if (before === undefined) before = await io.read(o.path);
        if (o.op === 'delete') await io.remove(o.path);
        else await io.write(o.path, o.after);
        done.push({ path: o.path, before, after: o.op === 'delete' ? null : o.after });
      } catch (err) {
        const failed = { path: o.path, op: o.op, error: msg(err) };
        // 실패한 파일도 반쯤 쓰였을 수 있어 원래대로 돌려 본다 (여기서 또 실패해도 알리지 않음 — 처음부터 쓰지 못한 파일)
        if (o.op !== 'delete' && before !== undefined) await undoOne({ path: o.path, before }).catch(() => {});
        const restored = [];
        const restoreFailed = [];
        for (const f of [...done].reverse()) {
          try {
            await undoOne(f);
            restored.unshift(f.path);
          } catch (e) {
            restoreFailed.unshift({ path: f.path, error: msg(e) });
          }
        }
        return { ok: false, done: [], failed, restored, restoreFailed };
      }
    }
    return { ok: true, done, restored: [], restoreFailed: [] };
  }

  /** 트랜잭션 실패 안내: "a.js 쓰기 실패 — 같이 적용한 3개 파일을 원래대로 되돌렸습니다" */
  function transactionMessage(r) {
    if (!r || r.ok || !r.failed) return '';
    const what = tr(r.failed.op === 'delete' ? 'project.tx.deleteFailed' : 'project.tx.writeFailed', { path: r.failed.path });
    const lines = [];
    if (r.restored.length) lines.push(tr('project.tx.restored', { what, n: r.restored.length }));
    else if (!r.restoreFailed.length) lines.push(tr('project.tx.nothingChanged', { what }));
    else lines.push(what);
    lines.push(tr('project.tx.reason', { error: r.failed.error }));
    if (r.restoreFailed.length) lines.push(tr('project.tx.restoreFailed', { list: r.restoreFailed.map((f) => `- ${f.path}: ${f.error}`).join('\n') }));
    return lines.join('\n');
  }

  return {
    hashText,
    lineCount,
    sentEntry,
    planIncremental,
    applyTransaction,
    transactionMessage,
    INLINE_LIMIT,
    CONTEXT_FILE,
    EDIT_LINES,
    // 지금 언어의 글 (읽을 때마다 만든다 — 언어를 바꾼 뒤에도 맞게)
    get RULES() {
      return rules();
    },
    get PLAN_FIRST() {
      return planFirst();
    },
    MAX_PLAN_FILES,
    SPLIT_SUGGEST,
    SPLIT_TOKENS,
    estimateTokens,
    tokenText,
    suggestSplitTokens,
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
