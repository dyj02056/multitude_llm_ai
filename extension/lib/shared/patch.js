// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/patch.js)
// AI 답변(Markdown)에서 파일 수정안을 꺼내고, 현재 파일 내용에 적용한 결과를 계산한다.
//   - "파일: 경로" 다음의 코드 블록(새 파일 또는 수정한 전체 내용 — 지금 답변 규칙이 요구하는 형식)
//   - ```diff 블록(unified diff, 여러 파일 가능 — AI가 규칙과 달리 diff로 줄 때)
//   - 코드 블록 밖의 "DELETE_FILES: 경로" 줄(파일 삭제)
// AI가 준 diff는 줄 번호·줄 수가 틀리는 일이 많아서 줄 수를 다시 세고, jsdiff로 안 되면 문맥 찾아 바꾸기로 한 번 더 해 본다.
// 실제 파일 쓰기는 하지 않는다 (쓰는 쪽이 계산 결과를 보고 쓴다).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.patch)이 같이 쓴다.
//
// [쉽게 말하면]
// AI 답변 속의 "이 파일을 이렇게 고쳐라"를 찾아내고, 실제로 고치면 파일이 어떻게 바뀌는지 미리 계산하는 파일입니다.
// 변경 제안·미리보기·적용·파일 모아보기가 모두 이 계산을 씁니다.
//   - 전체 내용 방식: "파일: src/app.js" 다음 코드 상자 = 그 파일의 새 전체 내용
//   - diff 방식: 바뀐 줄만 +(추가) / -(삭제) 표시로 준 것. AI가 줄 번호를 자주 틀려서 여러 방법으로 맞춰 봅니다.
//   - DELETE_FILES: 지울 파일 목록
// 안전장치: 프로젝트 밖 경로, Windows에서 위험한 이름, .git 안쪽 경로는 받지 않습니다.
(function (root, factory) {
  const api = factory(root.Diff);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).patch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DiffLib) {
  'use strict';

  const Diff = DiffLib || require('./vendor/diff');

  /** 프로젝트 안쪽 상대 경로로 정리한다. 밖으로 나가거나 이상한 경로면 null */
  function safeRelPath(p) {
    if (typeof p !== 'string') return null;
    let s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!s || s.length > 400 || /[\0<>|"?*]/.test(s)) return null;
    if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.startsWith('~')) return null;
    const parts = s.split('/').filter((x) => x && x !== '.');
    if (!parts.length || parts.some((x) => x === '..')) return null;
    // Windows에서 위험하거나 만들 수 없는 이름: ":"(대체 데이터 스트림), 예약 장치 이름(CON·NUL·COM1 …), 끝의 점·공백
    if (parts.some((x) => x.includes(':') || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(x) || /[. ]$/.test(x))) return null;
    return parts.join('/');
  }

  /**
   * git 내부 경로인지 (.git 폴더·파일 안쪽). 이런 곳에 쓰면 훅(.git/hooks)·설정(.git/config)으로 git을 쓸 때 코드가 실행된다.
   * Windows 짧은 이름(GIT~1)도 같은 폴더를 가리키므로 막는다. 읽기(.git/info/exclude 등)는 막지 않고 쓰기·지우기에만 쓴다.
   */
  function isGitInternal(p) {
    const clean = safeRelPath(p);
    if (clean === null) return false;
    return clean.split('/').some((x) => /^\.git$/i.test(x) || /^git~\d+$/i.test(x));
  }

  // ---------- 코드 블록 찾기 ----------

  /**
   * Markdown의 울타리 코드 블록: [{ lang, body, before: 블록 바로 앞 두 줄, closed }]
   * closed: 닫는 울타리가 있었는지. 답변이 출력 한도로 중간에 끊기면 마지막 블록이 닫히지 않는다 (v0.16.1).
   */
  // 답변에서 ``` 로 감싼 코드 상자를 모두 찾습니다. 각 상자 바로 앞 두 줄도 함께 기억합니다 ("파일: 경로"를 찾으려고).
  // 바깥 울타리가 ```` (백틱 4개)면 안쪽의 ``` 에서 끊기지 않습니다 (.md 파일을 한 상자로 받기 위해).
  function fencedBlocks(md) {
    const lines = String(md || '').split(/\r?\n/);
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
      if (!open) continue;
      const fenceCh = open[1][0];
      const fenceLen = open[1].length;
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = lines[j].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === fenceCh && close[1].length >= fenceLen) break;
        body.push(lines[j]);
      }
      const before = [];
      for (let k = i - 1; k >= 0 && before.length < 2; k--) if (lines[k].trim()) before.unshift(lines[k].trim());
      blocks.push({ lang: open[2].toLowerCase(), body: body.join('\n'), before, closed: j < lines.length });
      i = j;
    }
    return blocks;
  }

  const PATH_RE = /([\w@.+-]+(?:\/[\w@.+-]+)*\.[\w]+|(?:[\w@.+-]+\/)*(?:Dockerfile|Makefile|Procfile|LICENSE|Gemfile|Rakefile))/;

  /** 코드 블록 앞의 "파일: 경로" · "**경로**" · "### 경로" · "`경로`" 에서 경로를 읽는다 */
  function labelPath(before) {
    for (let k = before.length - 1; k >= 0; k--) {
      const line = before[k];
      const m =
        line.match(/(?:파일|file|경로|path|filename)\s*[:：]\s*[`*"']*([^\s`*"']+)/i) ||
        line.match(/^#{1,6}\s+[`*]*([^\s`*]+)[`*]*\s*$/) ||
        line.match(/^[`*]{1,2}([^\s`*]+)[`*]{1,2}:?\s*$/);
      if (m) {
        const p = m[1].match(PATH_RE);
        if (p) return safeRelPath(p[1]);
      }
    }
    return null;
  }

  // ---------- 찾기/바꾸기 블록 (v0.17.0) ----------
  // 긴 파일은 전체를 다시 쓰지 않고 바꿀 곳만 받는다 (출력 한도로 답이 잘리지 않게):
  //   <<<<<<< 찾기      (지금 파일의 그 부분 그대로)
  //   =======
  //   >>>>>>> 바꾸기    (바꾼 내용)
  // 영어 표시(<<<<<<< SEARCH · >>>>>>> REPLACE)도 받는다. 한 코드 블록에 여러 번 써도 된다.
  // 한글 뒤에서는 \b(단어 경계)가 맞지 않으므로 "뒤에 영문 글자가 이어지지 않음"으로 끝을 본다
  const EDIT_START = /^\s*<{7}\s*(?:찾기|search|find)(?![a-z]).*$/i;
  const EDIT_MID = /^\s*={7}\s*$/;
  const EDIT_END = /^\s*>{7}\s*(?:바꾸기|replace)(?![a-z]).*$/i;
  const looksLikeEdits = (body) => body.split(/\r?\n/).some((l) => EDIT_START.test(l));

  /** 블록 글 → { edits: [{ search, replace }], complete: 마지막 블록까지 닫혔는지 } */
  function parseEdits(body) {
    const lines = String(body).replace(/\r\n/g, '\n').split('\n');
    const edits = [];
    let i = 0;
    let complete = true;
    while (i < lines.length) {
      if (!EDIT_START.test(lines[i])) {
        i++;
        continue;
      }
      const search = [];
      const replace = [];
      i++;
      while (i < lines.length && !EDIT_MID.test(lines[i])) search.push(lines[i++]);
      if (i >= lines.length) {
        complete = false;
        break;
      }
      i++;
      while (i < lines.length && !EDIT_END.test(lines[i])) replace.push(lines[i++]);
      if (i >= lines.length) {
        complete = false;
        break;
      }
      i++;
      edits.push({ search: search.join('\n'), replace: replace.join('\n') });
    }
    return { edits, complete };
  }

  /**
   * 찾기/바꾸기를 차례로 적용한다. 찾을 부분이 지금 파일에 딱 한 곳 있을 때만 바꾼다 (줄 끝 공백 · 앞뒤 공백 차이는 한 번 더 너그럽게 찾음).
   * → { text } | { error }
   */
  function applyEdits(text, edits) {
    let lines = text.split('\n');
    const variants = [(s) => s, (s) => s.replace(/\s+$/, ''), (s) => s.trim()];
    for (let n = 0; n < edits.length; n++) {
      const { search, replace } = edits[n];
      const want = search.split('\n');
      while (want.length && !want[want.length - 1].trim()) want.pop(); // 끝 빈 줄은 무시
      while (want.length && !want[0].trim()) want.shift();
      if (!want.length) return { error: `찾기/바꾸기 ${n + 1}번의 찾을 부분이 비어 있습니다` };
      let hits = [];
      for (const norm of variants) {
        const w = want.map(norm);
        hits = [];
        for (let i = 0; i + w.length <= lines.length; i++) {
          let ok = true;
          for (let k = 0; k < w.length && ok; k++) ok = norm(lines[i + k]) === w[k];
          if (ok) hits.push(i);
        }
        if (hits.length) break;
      }
      if (!hits.length) return { error: `찾기/바꾸기 ${n + 1}번의 찾을 부분을 지금 파일에서 찾지 못했습니다` };
      if (hits.length > 1) return { error: `찾기/바꾸기 ${n + 1}번의 찾을 부분이 파일에 ${hits.length}곳 있어 어디를 바꿀지 모릅니다 (앞뒤 줄을 더 넣어 달라고 하세요)` };
      // 바꿀 내용도 찾을 부분처럼 앞뒤 빈 줄은 뺀다 (AI가 표시 줄 옆에 붙이는 빈 줄). 비어 있으면 찾은 부분을 지운다.
      const rep = replace.split('\n');
      while (rep.length && !rep[rep.length - 1].trim()) rep.pop();
      while (rep.length && !rep[0].trim()) rep.shift();
      const at = hits[0];
      lines = [...lines.slice(0, at), ...rep, ...lines.slice(at + want.length)];
    }
    return { text: lines.join('\n') };
  }

  const looksLikeDiff = (b) => ['diff', 'patch', 'udiff'].includes(b.lang) || (/^--- /m.test(b.body) && /^\+\+\+ /m.test(b.body)) || /^@@/m.test(b.body);

  // ---------- diff 다듬기 ----------

  const stripPrefix = (name) => {
    const n = String(name || '').trim().split('\t')[0].replace(/^"|"$/g, '');
    if (n === '/dev/null') return null;
    return safeRelPath(n.replace(/^[ab]\//, ''));
  };

  /**
   * AI diff를 jsdiff가 읽을 수 있게 다듬는다: 헤더 없는 hunk에 파일 헤더를 붙이고,
   * hunk 줄 수를 실제로 다시 세고, 앞 공백이 빠진 빈 문맥 줄을 고친다.
   */
  function normalizeDiff(text, fallbackPath) {
    const src = text.split('\n');
    const out = [];
    let sawHeader = false;
    let i = 0;
    while (i < src.length) {
      const line = src[i];
      if (/^(diff --git |index |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) {
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (src[i + 1] || '').startsWith('+++ ')) {
        out.push(line, src[i + 1]);
        sawHeader = true;
        i += 2;
        continue;
      }
      // "@@ -1,3 +1,4 @@ 함수" 뿐 아니라 숫자 없는 "@@ @@", 그냥 "@@"도 hunk 시작으로 본다.
      const h = line.startsWith('@@') ? [line, ...(line.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/) || []).slice(1, 3)] : null;
      if (h) {
        const tail = line.match(/^@@[^@]*@@(.*)$/);
        h[3] = tail ? tail[1] : '';
        if (!sawHeader && fallbackPath) {
          out.push(`--- a/${fallbackPath}`, `+++ b/${fallbackPath}`);
          sawHeader = true;
        }
        const body = [];
        i++;
        while (i < src.length && !/^@@/.test(src[i]) && !(src[i].startsWith('--- ') && (src[i + 1] || '').startsWith('+++ ')) && !/^diff --git /.test(src[i])) {
          let l = src[i];
          if (l === '') l = ' ';
          if (!/^[ +\-\\]/.test(l)) l = ` ${l}`; // 앞 기호가 빠진 문맥 줄
          body.push(l);
          i++;
        }
        while (body.length && body[body.length - 1] === ' ') body.pop(); // 블록 끝의 빈 줄
        const oldN = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
        const newN = body.filter((l) => l[0] === ' ' || l[0] === '+').length;
        const oldStart = h[1] ? Number(h[1]) : 1;
        const newStart = h[2] ? Number(h[2]) : 1;
        out.push(`@@ -${oldN ? oldStart : 0},${oldN} +${newN ? newStart : 0},${newN} @@${h[3] || ''}`, ...body);
        continue;
      }
      i++;
    }
    return out.join('\n');
  }

  /** 코드 블록 밖의 "DELETE_FILES: 경로1, 경로2" 줄에서 지울 파일 경로들을 읽는다 */
  function deleteRequests(md) {
    const out = [];
    let fence = null;
    for (const line of String(md || '').split(/\r?\n/)) {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(line)) fence = null;
        continue;
      }
      if (fence) continue;
      const m = line.match(/^\s*[*_`>-]*\s*DELETE_FILES\s*[*_`]*\s*[:：]\s*(.*)$/i);
      if (!m) continue;
      for (const item of m[1].split(/[,\s]+/)) {
        const p = safeRelPath(item.replace(/^[`'"*(\[]+|[`'"*)\].,;]+$/g, ''));
        if (p && !out.includes(p)) out.push(p);
      }
    }
    return out;
  }

  /**
   * 답변에서 수정안을 꺼낸다.
   * 결과: [{ path, type: 'diff', hunks, isNew, isDelete } | { path, type: 'full', content }]  (같은 파일은 뒤의 것이 이긴다)
   */
  // 핵심 함수: 답변 전체에서 "파일별 수정안" 목록을 만듭니다. 같은 파일이 여러 번 나오면 마지막 것을 씁니다.
  function extractChanges(md) {
    const changes = [];
    for (const b of fencedBlocks(md)) {
      const label = labelPath(b.before);
      if (label && looksLikeEdits(b.body)) {
        // 찾기/바꾸기 블록 (v0.17.0). 블록이 닫히지 않았거나 마지막 찾기/바꾸기가 끝나지 않았으면 잘린 답변
        const { edits, complete } = parseEdits(b.body);
        changes.push({ path: label, type: 'edit', edits, ...(b.closed && complete ? {} : { truncated: true }) });
      } else if (looksLikeDiff(b)) {
        let parsed = [];
        try {
          parsed = Diff.parsePatch(normalizeDiff(b.body, label));
        } catch {
          continue;
        }
        for (const p of parsed) {
          const isNew = String(p.oldFileName || '').trim() === '/dev/null';
          const isDelete = String(p.newFileName || '').trim() === '/dev/null';
          const path = (isDelete ? stripPrefix(p.oldFileName) : stripPrefix(p.newFileName)) || label;
          if (!path || !p.hunks.length && !isDelete) continue;
          changes.push({ path, type: 'diff', hunks: p.hunks, isNew, isDelete, ...(b.closed ? {} : { truncated: true }) });
        }
      } else if (label) {
        // 닫히지 않은 블록 = 답변이 중간에 끊겨 파일 뒷부분이 없다. 그대로 쓰면 나머지 코드가 지워지므로 적용하지 않는다.
        changes.push({ path: label, type: 'full', content: b.body, ...(b.closed ? {} : { truncated: true }) });
      }
    }
    for (const path of deleteRequests(md)) changes.push({ path, type: 'diff', hunks: [], isNew: false, isDelete: true });
    const byPath = new Map();
    for (const c of changes) if (!isGitInternal(c.path)) byPath.set(c.path, c);
    return [...byPath.values()];
  }

  // ---------- 적용 계산 ----------

  /** 문맥 찾아 바꾸기: hunk마다 옛 줄 묶음을 찾아 새 줄 묶음으로 바꾼다 (줄 번호를 믿지 않음) */
  function applyBySearch(text, hunks) {
    let lines = text.split('\n');
    let cursor = 0;
    const variants = [(s) => s, (s) => s.replace(/\s+$/, ''), (s) => s.trim()];
    for (const h of hunks) {
      const oldB = h.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1));
      const newB = h.lines.filter((l) => l[0] === ' ' || l[0] === '+').map((l) => l.slice(1));
      if (!oldB.length) return null; // 문맥 없는 순수 추가는 위치를 알 수 없다
      let at = -1;
      for (const norm of variants) {
        const want = oldB.map(norm);
        const find = (from) => {
          for (let i = from; i + want.length <= lines.length; i++) {
            let ok = true;
            for (let k = 0; k < want.length && ok; k++) ok = norm(lines[i + k]) === want[k];
            if (ok) return i;
          }
          return -1;
        };
        at = find(cursor);
        if (at < 0) at = find(0);
        if (at >= 0) break;
      }
      if (at < 0) return null;
      lines = [...lines.slice(0, at), ...newB, ...lines.slice(at + oldB.length)];
      cursor = at + newB.length;
    }
    return lines.join('\n');
  }

  // ---------- 잘린 답변 · 생략한 코드 알아채기 (v0.16.1) ----------
  // 출력 한도로 답이 끊기거나 AI가 "... 기존과 같음"처럼 줄이면, 전체 파일 교체로 쓸 때 나머지 코드가 사라진다.
  const TRUNCATED_TEXT = '답변이 중간에 잘렸습니다 (코드 블록이 닫히지 않음) — 파일 뒷부분이 없어 적용하지 않습니다';
  // 코드를 줄였다는 표시 줄. 둘 중 하나:
  //   ① 주석 · 줄 처음에 "..."(…)이 있고 "기존 · 나머지 · 생략 · 동일 · unchanged · rest · existing · same · omitted"가 붙은 줄 ("// ... 기존 코드 ...", "# ... (생략)")
  //   ② 그 자체로 생략을 뜻하는 말만 있는 주석 줄 ("<!-- 이하 동일 -->", "/* rest of the file unchanged */", "// 기존과 같음")
  // "// 나머지 값을 더한다"처럼 평범한 주석은 걸리지 않게, ①은 말줄임표가, ②는 정해진 문구가 있어야 한다.
  const OMIT_RE = new RegExp(
    [
      String.raw`^\s*(?:\/\/|#|\/\*+|\*|<!--|--|;)?\s*(?:\.{3,}|…)\s*[([]?\s*(?:기존|나머지|생략|동일|이전과|unchanged|rest|existing|same|omitted|remaining)`,
      String.raw`^\s*(?:\/\/|#|\/\*+|\*|<!--|--|;)\s*[([]?\s*(?:기존(?:과|\s*코드|\s*내용)?(?:와)?\s*(?:같음|동일|유지)|이하\s*(?:생략|동일)|(?:코드\s*)?생략(?:됨|함)?|변경\s*없음|rest of (?:the )?(?:file|code)(?: (?:is )?unchanged)?|(?:the )?rest (?:is )?unchanged|unchanged code|same as before|code omitted)\s*[)\]]?\s*(?:\*\/|-->)?\s*$`,
    ].join('|'),
    'i',
  );

  // 괄호를 세어 볼 코드 파일 (문자열 · 주석을 대충 빼고 { ( [ 와 } ) ] 수를 비교한다)
  const BRACE_EXT = /\.(?:[cm]?[jt]sx?|json|css|scss|less|java|kt|cs|c|cc|cpp|h|hpp|go|rs|swift|php|dart|scala)$/i;
  /** 열린 괄호가 닫힌 괄호보다 얼마나 많은지 (문자열 · 주석 · 정규식처럼 보이는 곳은 대충 뺀다) */
  function braceDebt(text) {
    const code = String(text)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
    let debt = 0;
    for (const ch of code) {
      if (ch === '{' || ch === '(' || ch === '[') debt++;
      else if (ch === '}' || ch === ')' || ch === ']') debt--;
    }
    return debt;
  }

  /**
   * 출력 한도로 잘린 코드 같은지 (웹 채팅은 잘린 답도 코드 상자를 닫아서 보여 주므로 울타리만으로는 모른다):
   * 코드 파일인데 끝에서 괄호가 닫히지 않았고, 원본(있으면)은 닫혀 있었다 → 이유 글 | null
   */
  function suspectCutCode(path, before, after) {
    if (!BRACE_EXT.test(path) || typeof after !== 'string') return null;
    const a = braceDebt(after);
    const b = typeof before === 'string' ? braceDebt(before) : 0;
    return a > 0 && a > b ? `끝이 잘린 것 같습니다 (괄호 ${a - b}개가 닫히지 않음)` : null;
  }

  /**
   * 전체 파일 교체가 수상한지: 생략 표시가 있거나, 원본의 끝부분이 통째로 사라졌는지 → 이유 글 | null
   * before · after: LF 줄바꿈 글
   */
  function suspectFullReplace(before, after) {
    if (typeof before !== 'string' || typeof after !== 'string') return null;
    const aLines = after.split('\n');
    const omit = aLines.find((l) => OMIT_RE.test(l) && !before.split('\n').some((b) => b.trim() === l.trim()));
    if (omit) return `코드를 줄인 표시가 있습니다 ("${omit.trim().slice(0, 40)}")`;
    const bLines = before.split('\n');
    const bCount = bLines.filter((l) => l.trim()).length;
    const aCount = aLines.filter((l) => l.trim()).length;
    if (bCount < 30 || aCount >= bCount * 0.6) return null;
    const tail = bLines.map((l) => l.trim()).filter((l) => l.length > 2).slice(-3);
    const kept = new Set(aLines.map((l) => l.trim()));
    if (tail.length && tail.every((l) => !kept.has(l))) return `끝이 잘린 것 같습니다 (원본 ${bCount}줄 → ${aCount}줄, 원래 끝부분이 없음)`;
    return null;
  }

  /**
   * 수정안 하나를 현재 내용에 적용한 결과.
   * before: 지금 파일 내용(없으면 null)
   * 결과: { path, op: 'modify'|'create'|'delete', before, after, ok, error, add, del }
   */
  // 수정안 하나를 지금 파일 내용(before)에 적용하면 결과(after)가 어떻게 되는지 계산합니다. 실제 파일은 쓰지 않습니다.
  // op: 'create'(새 파일) / 'modify'(수정) / 'delete'(삭제), add·del: 추가·삭제되는 줄 수
  function planChange(change, before) {
    const base = { path: change.path, before, after: null, ok: false, error: null, add: 0, del: 0 };
    const crlf = typeof before === 'string' && before.includes('\r\n');
    const lf = typeof before === 'string' ? before.replace(/\r\n/g, '\n') : null;

    if (change.truncated) return { ...base, op: before === null ? 'create' : 'modify', error: TRUNCATED_TEXT, truncated: true };
    let after;
    let op;
    if (change.type === 'edit') {
      // 찾기/바꾸기: 있는 파일에만. 새 파일이면 찾을 부분이 모두 빈 블록일 때 바꿀 내용을 그대로 새 파일로
      if (before === null) {
        if (!change.edits.every((e) => !e.search.trim())) return { ...base, op: 'modify', error: '파일이 없습니다 (새 파일은 전체 내용으로 받아야 합니다)' };
        op = 'create';
        after = `${change.edits.map((e) => e.replace).join('\n')}\n`;
      } else {
        op = 'modify';
        const r = applyEdits(lf, change.edits);
        if (r.error) return { ...base, op, error: r.error };
        after = r.text;
      }
    } else if (change.type === 'full') {
      op = before === null ? 'create' : 'modify';
      after = change.content.replace(/\r\n/g, '\n');
      if (!after.endsWith('\n')) after += '\n';
    } else if (change.isDelete) {
      if (before === null) return { ...base, op: 'delete', error: '지울 파일이 없습니다' };
      op = 'delete';
      after = null;
    } else if (change.isNew || before === null) {
      if (!change.isNew && before === null) return { ...base, op: 'modify', error: '파일이 없습니다 (새 파일이면 /dev/null diff나 전체 내용으로 받아야 합니다)' };
      if (before !== null) return { ...base, op: 'create', error: '이미 있는 파일입니다' };
      op = 'create';
      after = change.hunks.flatMap((h) => h.lines.filter((l) => l[0] === '+').map((l) => l.slice(1))).join('\n') + '\n';
    } else {
      op = 'modify';
      const patch = { hunks: change.hunks };
      after = Diff.applyPatch(lf, patch);
      if (after === false) after = Diff.applyPatch(lf, patch, { compareLine: (_n, a, _op, b) => a !== undefined && String(a).trimEnd() === String(b).trimEnd() });
      if (after === false) after = applyBySearch(lf, change.hunks);
      if (after === null || after === false) return { ...base, op, error: 'diff가 현재 내용과 맞지 않습니다' };
    }
    if (after !== null && lf !== null && lf.endsWith('\n') && !after.endsWith('\n')) after += '\n';
    if (after !== null && after === lf) return { ...base, op, error: '바뀌는 내용이 없습니다' };
    const preview = previewDiff(change.path, lf, after);
    const add = preview.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const del = preview.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    // 전체 파일 교체가 수상하면 적용은 되지만 바로 쓰지 않는다 (미리보기에서 기본 체크 해제 · 바의 "확인 필요")
    // 새 파일 · 찾기/바꾸기 결과도 괄호가 닫히지 않았으면 잘린 것으로 의심한다
    const suspect =
      after === null
        ? null
        : (change.type === 'full' && op === 'modify' ? suspectFullReplace(lf, after) : null) || suspectCutCode(change.path, lf, after);
    if (after !== null && crlf) after = after.replace(/\n/g, '\r\n'); // 원래 줄바꿈(CRLF)을 지킨다
    return { ...base, op, after, ok: true, add, del, preview, ...(suspect ? { suspect } : {}) };
  }

  // ---------- 덩어리(hunk) 단위 적용 ----------
  // 미리보기 창에서 파일 하나의 바뀐 곳을 덩어리마다 골라 적용한다 (되돌리기는 파일 단위 — 적용 기록에 파일 전체 원본이 남는다).
  // 덩어리 = 바뀌지 않은 줄 사이에 붙어 있는 지운 줄·더한 줄 묶음. 줄바꿈(CRLF·마지막 줄바꿈 없음)은 글 그대로 다룬다.

  /** before → after의 덩어리 목록. [{ index, oldStart, oldLines, newStart, newLines, lines(['-…', '+…', ' …']), context }] */
  function splitHunks(before, after, context = 3) {
    const parts = Diff.diffLines(before || '', after || '');
    const lineList = (v) => v.replace(/\r?\n$/, '').split(/\r?\n/);
    const hunks = [];
    let oldLine = 1;
    let newLine = 1;
    let cur = null;
    let lastSame = [];
    for (const p of parts) {
      const lines = p.value === '' ? [] : lineList(p.value);
      if (!p.added && !p.removed) {
        if (cur) {
          cur.after = lines.slice(0, context);
          hunks.push(cur);
          cur = null;
        }
        lastSame = lines;
        oldLine += p.count;
        newLine += p.count;
        continue;
      }
      if (!cur) {
        cur = { index: hunks.length, oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, lines: [], before: lastSame.slice(-context), after: [] };
      }
      for (const l of lines) cur.lines.push((p.added ? '+' : '-') + l);
      if (p.added) {
        cur.newLines += p.count;
        newLine += p.count;
      } else {
        cur.oldLines += p.count;
        oldLine += p.count;
      }
    }
    if (cur) hunks.push(cur);
    return hunks.map((h) => ({
      index: h.index,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: [...h.before.map((l) => ` ${l}`), ...h.lines, ...h.after.map((l) => ` ${l}`)],
    }));
  }

  /**
   * 고른 덩어리만 적용한 글. selected: 적용할 덩어리 번호들 (splitHunks의 index).
   * 고르지 않은 덩어리는 before 그대로 둔다. 모두 고르면 after와 같고, 하나도 고르지 않으면 before와 같다.
   */
  function applyHunks(before, after, selected) {
    const pick = new Set(selected);
    const parts = Diff.diffLines(before || '', after || '');
    let out = '';
    let index = -1;
    let inHunk = false;
    for (const p of parts) {
      if (!p.added && !p.removed) {
        inHunk = false;
        out += p.value;
        continue;
      }
      if (!inHunk) {
        index++;
        inHunk = true;
      }
      const take = pick.has(index);
      if ((p.added && take) || (p.removed && !take)) out += p.value;
    }
    return out;
  }

  // ---------- 실행에 영향을 주는 파일 ----------
  // 저장만 해도 나중에 자동으로 실행될 수 있는 파일. 적용 창에서 표시하고 기본 체크를 해제한다.
  const EXEC_PATHS = [
    [/^\.github\//, 'GitHub 자동 작업(Actions) 설정'],
    [/^\.gitlab-ci\.ya?ml$/, 'GitLab CI 설정'],
    [/^\.circleci\//, 'CircleCI 설정'],
    [/(^|\/)(\.travis\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|bitbucket-pipelines\.yml)$/, 'CI 설정'],
    [/^\.husky\//, 'git 훅(husky)'],
    [/(^|\/)\.pre-commit-config\.ya?ml$/, 'git 훅(pre-commit)'],
    [/^\.vscode\//, 'VS Code 작업·설정 (폴더를 열 때 실행될 수 있음)'],
    [/^\.idea\//, 'JetBrains 실행 설정'],
    [/(^|\/)\.envrc$/, 'direnv (폴더에 들어가면 실행)'],
    [/(^|\/)\.gitattributes$/, 'git 필터 설정'],
    [/(^|\/)\.gitmodules$/, 'git 하위 모듈 설정 (받아 올 주소)'],
    [/(^|\/)(GNU)?[Mm]akefile$|\.mk$/, 'Makefile'],
    [/(^|\/)Dockerfile[^/]*$|(^|\/)[^/]*\.dockerfile$/i, 'Dockerfile'],
    [/(^|\/)(docker-)?compose[^/]*\.ya?ml$/, 'Docker Compose 설정'],
    [/(^|\/)Procfile$/, 'Procfile'],
    [/(^|\/)setup\.py$/, '설치 때 실행되는 setup.py'],
    [/\.(sh|bash|zsh|ps1|psm1|bat|cmd|command)$/i, '스크립트 파일'],
  ];
  // package.json에서 설치·실행 때 자동으로 돌아가는 항목
  const PKG_EXEC_KEYS = ['scripts', 'bin', 'husky', 'lint-staged', 'simple-git-hooks', 'pre-commit', 'gitHooks'];

  /**
   * 이 변경이 "실행에 영향을 주는지". 그렇다면 이유 글, 아니면 null.
   * package.json은 scripts 같은 실행 항목이 바뀔 때만 해당한다 (의존성만 바뀌면 null).
   */
  function executionRisk(path, before, after) {
    const name = path.split('/').pop();
    if (name === 'package.json') {
      let a = null;
      let b = null;
      try {
        a = before === null ? {} : JSON.parse(before);
        b = after === null ? {} : JSON.parse(after);
      } catch {
        return 'package.json (형식을 읽을 수 없어 실행 항목 변경 여부를 확인하지 못함)';
      }
      const changed = PKG_EXEC_KEYS.filter((k) => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null));
      return changed.length ? `package.json 실행 항목 변경 (${changed.join(', ')})` : null;
    }
    for (const [re, why] of EXEC_PATHS) if (re.test(path)) return why;
    return null;
  }

  /** 미리보기용 unified diff 글 */
  function previewDiff(path, before, after) {
    const a = (before ?? '').replace(/\r\n/g, '\n');
    const b = (after ?? '').replace(/\r\n/g, '\n');
    return Diff.createTwoFilesPatch(before === null ? '/dev/null' : `a/${path}`, after === null ? '/dev/null' : `b/${path}`, a, b, '', '', { context: 3 })
      .split('\n')
      .filter((l) => !/^=+$/.test(l) && !l.startsWith('Index: '))
      .join('\n');
  }

  // ---------- 이어서 받기 (v0.17.1) ----------
  // 출력 한도로 끊긴 파일을 버리지 않고, 같은 AI에게 "끊긴 곳부터 나머지만" 달라고 해서 이어 붙인다.
  //   전체 내용: 받은 글의 마지막 줄은 중간에 잘렸을 수 있어 버리고, 그 앞 줄(기준 줄)을 AI가 한 번 더 쓰게 한 뒤 겹치는지 보고 붙인다.
  //   찾기/바꾸기: 끝까지 받은 블록은 그대로 두고, 그 다음 블록부터 받는다.
  // 겹치는 곳이 맞지 않으면 붙이지 않는다 (엉뚱한 곳에 이어 붙여 코드를 망가뜨리지 않게).
  const MAX_CONTINUE = 3; // 한 파일을 이어 받는 최대 횟수
  // 끊긴 파일 뒤에 주려던 다른 파일도 끊겨서 못 받았을 수 있다 — 이 파일을 다 쓴 뒤 이어서 달라고 한다
  const AFTER_NOTE = '이 파일 다음에 주려던 다른 파일이 있었다면, 이 파일을 다 쓴 뒤 처음 답변 규칙 그대로("파일: 경로" + 코드 블록) 이어서 줘.';

  /** 이어 받을 수 있는 수정안이면 이어 받기 정보, 아니면 null (diff · 삭제는 다시 요청으로) */
  function continuationOf(change) {
    if (!change || change.isDelete) return null;
    if (change.type === 'edit') return { path: change.path, kind: 'edit', edits: change.edits.slice() };
    if (change.type !== 'full') return null;
    const lines = String(change.content).replace(/\r\n/g, '\n').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const dropped = lines.pop() ?? ''; // 중간에 잘렸을 수 있는 마지막 줄
    let anchor = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) {
        anchor = lines[i];
        break;
      }
    }
    return { path: change.path, kind: 'full', head: lines, anchor, dropped };
  }

  /** 이어 받기를 부탁하는 글 */
  function continuePrompt(cont) {
    const label = `파일: ${cont.path} (이어서)`;
    if (cont.kind === 'edit') {
      return [
        `직전 답의 "파일: ${cont.path}" 찾기/바꾸기가 출력 한도로 중간에 끊겼어. 끝까지 받은 찾기/바꾸기는 ${cont.edits.length}개야.`,
        `${cont.edits.length + 1}번째부터 남은 찾기/바꾸기만, 앞에서와 같은 형식(<<<<<<< 찾기 / ======= / >>>>>>> 바꾸기)으로 "${label}" 줄 다음 코드 블록 하나에 줘.`,
        '이미 받은 찾기/바꾸기는 다시 쓰지 말고, 다른 설명은 쓰지 마. 이번에도 다 못 쓰면 끝난 블록까지만 쓰고 멈춰 줘.',
        AFTER_NOTE,
      ].join('\n');
    }
    if (!cont.anchor) {
      return [`직전 답의 "파일: ${cont.path}" 코드가 출력 한도로 끊겼어. 그 파일의 전체 내용을 "${label}" 줄 다음 코드 블록 하나로 처음부터 다시 줘.`].join('\n');
    }
    const fence = cont.anchor.includes('```') ? '````' : '```';
    return [
      `직전 답의 "파일: ${cont.path}" 코드가 출력 한도로 중간에 끊겼어. 아래 줄까지는 받았어:`,
      fence,
      cont.anchor,
      fence,
      `이 줄을 첫 줄로 한 번 더 그대로 쓰고, 그 다음 줄부터 파일 끝까지 나머지만 "${label}" 줄 다음 코드 블록 하나로 줘.`,
      '앞부분은 다시 쓰지 말고, 다른 설명은 쓰지 마. 이번에도 다 못 쓰면 줄이 끝나는 곳에서 멈춰 줘.',
      AFTER_NOTE,
    ].join('\n');
  }

  /**
   * 이어 받은 답(next: 같은 경로의 수정안)을 앞부분에 붙인다.
   * → { change: 합친 수정안(또 잘렸으면 truncated) } | { error }
   */
  function stitchContinuation(cont, next) {
    if (!next) return { error: `이어 받은 답에서 "${cont.path}" 코드를 찾지 못했습니다` };
    if (cont.kind === 'edit') {
      if (next.type !== 'edit') return { error: '이어 받은 답이 찾기/바꾸기 형식이 아닙니다' };
      return { change: { path: cont.path, type: 'edit', edits: [...cont.edits, ...next.edits], ...(next.truncated ? { truncated: true } : {}) } };
    }
    if (next.type !== 'full') return { error: '이어 받은 답이 코드 블록 형식이 아닙니다' };
    const tail = String(next.content).replace(/\r\n/g, '\n').split('\n');
    while (tail.length && !tail[0].trim()) tail.shift();
    const same = (a, b) => String(a).trimEnd() === String(b).trimEnd();
    let merged;
    if (!cont.anchor) merged = tail; // 처음부터 다시 받음
    else if (same(tail[0], cont.anchor)) merged = [...cont.head, ...tail.slice(1)]; // 기준 줄을 한 번 더 씀 (부탁한 대로)
    else if (cont.dropped.trim() && tail[0].trimEnd().startsWith(cont.dropped.trimEnd())) merged = [...cont.head, ...tail]; // 잘린 줄을 마저 씀
    else if (cont.dropped.trim() && same(tail[0], cont.dropped)) merged = [...cont.head, ...tail];
    else {
      // 기준 줄이 둘째 줄 이후에 있으면 (앞부분을 조금 더 다시 씀) 거기서부터 붙인다
      const at = tail.findIndex((l) => same(l, cont.anchor));
      if (at < 0 || at > 20) return { error: '이어 받은 코드의 첫 줄이 끊긴 곳과 맞지 않아 붙이지 않았습니다 (다시 요청하세요)' };
      merged = [...cont.head, ...tail.slice(at + 1)];
    }
    return { change: { path: cont.path, type: 'full', content: merged.join('\n'), ...(next.truncated ? { truncated: true } : {}) } };
  }

  /** 잘렸거나 끝이 잘린 것으로 의심되어 이어 받을 만한 수정안인지 */
  const wantsContinue = ({ change, plan }) =>
    !!continuationOf(change) && (plan.truncated || /끝이 잘린 것 같습니다/.test(plan.suspect || ''));

  return {
    TRUNCATED_TEXT,
    MAX_CONTINUE,
    suspectFullReplace,
    suspectCutCode,
    braceDebt,
    parseEdits,
    applyEdits,
    continuationOf,
    continuePrompt,
    stitchContinuation,
    wantsContinue,
    safeRelPath,
    isGitInternal,
    fencedBlocks,
    normalizeDiff,
    extractChanges,
    planChange,
    previewDiff,
    applyBySearch,
    executionRisk,
    splitHunks,
    applyHunks,
  };
});
