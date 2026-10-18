// AI 답변(Markdown)에서 파일 수정안을 꺼내고, 현재 파일 내용에 적용한 결과를 계산한다.
//   - ```diff 블록(unified diff, 여러 파일 가능)
//   - "파일: 경로" 다음의 코드 블록(새 파일 또는 전체 내용)
// AI가 준 diff는 줄 번호·줄 수가 틀리는 일이 많아서 줄 수를 다시 세고, jsdiff로 안 되면 문맥 찾아 바꾸기로 한 번 더 해 본다.
// 실제 파일 쓰기는 하지 않는다 (쓰는 쪽이 계산 결과를 보고 쓴다).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.patch)이 같이 쓴다.
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

  // ---------- 코드 블록 찾기 ----------

  /** Markdown의 울타리 코드 블록: [{ lang, body, before: 블록 바로 앞 두 줄 }] */
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
      blocks.push({ lang: open[2].toLowerCase(), body: body.join('\n'), before });
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

  /**
   * 답변에서 수정안을 꺼낸다.
   * 결과: [{ path, type: 'diff', hunks, isNew, isDelete } | { path, type: 'full', content }]  (같은 파일은 뒤의 것이 이긴다)
   */
  function extractChanges(md) {
    const changes = [];
    for (const b of fencedBlocks(md)) {
      const label = labelPath(b.before);
      if (looksLikeDiff(b)) {
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
          changes.push({ path, type: 'diff', hunks: p.hunks, isNew, isDelete });
        }
      } else if (label) {
        changes.push({ path: label, type: 'full', content: b.body });
      }
    }
    const byPath = new Map();
    for (const c of changes) byPath.set(c.path, c);
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

  /**
   * 수정안 하나를 현재 내용에 적용한 결과.
   * before: 지금 파일 내용(없으면 null)
   * 결과: { path, op: 'modify'|'create'|'delete', before, after, ok, error, add, del }
   */
  function planChange(change, before) {
    const base = { path: change.path, before, after: null, ok: false, error: null, add: 0, del: 0 };
    const crlf = typeof before === 'string' && before.includes('\r\n');
    const lf = typeof before === 'string' ? before.replace(/\r\n/g, '\n') : null;

    let after;
    let op;
    if (change.type === 'full') {
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
    if (after !== null && crlf) after = after.replace(/\n/g, '\r\n'); // 원래 줄바꿈(CRLF)을 지킨다
    return { ...base, op, after, ok: true, add, del, preview };
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

  return { safeRelPath, fencedBlocks, normalizeDiff, extractChanges, planChange, previewDiff, applyBySearch, executionRisk };
});
