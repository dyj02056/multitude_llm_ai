// 프로젝트 파일을 AI에게 "파일 업로드"로 보낼 때, 보낼 글(본문)과 첨부 파일을 만든다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.projectUpload)이 같이 쓴다.
//
// 올리는 방식 (프로젝트 사이드바에서 고른다)
//   bundle (묶음 파일, 기본): 구조와 파일 내용을 "[파일: 경로] + 코드 블록" 형식의 .md 파일로 묶어 올린다. 크면 나눈다.
//   files  (개별 파일): 파일마다 하나씩 올린다. 이름에 경로를 넣고(src/a/index.js → src__a__index.js),
//          본문에 "올린 이름 → 실제 경로" 목록을 넣는다. 한도를 넘으면 그번만 묶음 파일로 보낸다.
// 어느 방식이든 inlineText(예전처럼 본문에 다 넣은 글)를 함께 돌려준다. 문서 첨부를 받지 않는 서비스와,
// 업로드에 실패했을 때(내부 예비 경로) 이 글을 대신 보낸다.
//
// [쉽게 말하면] 프로젝트 파일을 AI에게 "첨부 파일"로 보낼 수 있게 포장하는 파일입니다.
//   - 묶음 파일: 여러 파일 내용을 .md 파일 하나로 묶어 올림 (기본)
//   - 개별 파일: 파일마다 하나씩 올림 (이름에 경로를 넣어 src/a.js → src__a.js)
// 첨부를 못 받는 서비스에는 같은 내용을 본문 글로 넣을 수 있게 예비 글도 함께 만듭니다.
(function (root, factory) {
  const api = factory(root.MLA && root.MLA.projectContext);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).projectUpload = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (projectContext) {
  'use strict';

  const PC = projectContext || require('./project-context');
  // 화면 문구 (i18n-*-project.js) — 부를 때 찾는다 (Electron 앱 require · 화면 전역 MLA.i18n). AI에게 보내는 글은 옮기지 않는다.
  const tr = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };
  const MODES = ['bundle', 'files'];
  const DEFAULT_MODE = 'bundle';
  // 묶음 파일 하나의 최대 크기 (UTF-8 바이트). 넘으면 -1, -2 …로 나눈다.
  // 글자 수가 아니라 바이트로 센다 — 한글은 한 글자가 3바이트라 글자 수로 세면 서비스 한도를 넘을 수 있다.
  // budget.fileBytes(서비스별 파일 하나 한도)가 더 작으면 그 크기로 나눈다.
  const BUNDLE_BYTES = 1000000;
  const BUNDLE_CHUNK = BUNDLE_BYTES; // 예전 이름 (테스트·호출부 호환)
  const MIN_CHUNK_BYTES = 4096; // 이보다 작게는 나누지 않는다 (머리글이 들어갈 자리)
  const TREE_IN_BODY = 20000; // 개별 파일 방식에서 구조 목록이 이보다 길면 project-structure.md로 올린다
  // 대부분의 서비스가 받는 텍스트·코드 확장자. 그 밖(확장자 없음 포함)은 이름 끝에 .txt를 붙여 올린다.
  const SAFE_EXT = new Set([
    'txt', 'md', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'html', 'htm', 'css', 'scss',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs',
    'rb', 'php', 'swift', 'kt', 'sh', 'sql',
  ]);
  const SEP = '__';

  // UTF-8 바이트 수를 글자 코드로 바로 센다 (TextEncoder를 만들거나 바이트 배열을 만들지 않는다).
  // 서로게이트 쌍은 4바이트, 짝 없는 서로게이트는 TextEncoder처럼 U+FFFD(3바이트)로 센다.
  function bytesOf(text) {
    const s = text === undefined ? '' : String(text); // TextEncoder.encode()와 같게 (undefined → 빈 글)
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }
  const baseName = (path) => path.split('/').pop();

  /** 개별 파일로 올릴 이름: 폴더 구분 / → __, 받지 않을 수 있는 확장자는 .txt를 붙인다 */
  function uploadName(path) {
    const flat = path.replace(/[\\/]+/g, SEP).replace(/[<>:"|?*\x00-\x1f]/g, '_');
    const ext = /\.([^.]+)$/.exec(baseName(path))?.[1]?.toLowerCase();
    return ext && SAFE_EXT.has(ext) ? flat : `${flat}.txt`;
  }

  /**
   * AI가 올린 이름(src__a__Dockerfile.txt 등)으로 파일을 가리켰을 때 실제 경로 후보들로 되돌린다.
   * 업로드용으로 붙인 .txt를 뗀 것을 먼저, 그대로인 것을 다음 후보로 준다.
   */
  function restorePaths(name) {
    const p = String(name || '')
      .trim()
      .replace(/ \(\d+\)(?=\.[^.]*$|$)/, '');
    const restored = p.split(SEP).join('/');
    const stripped = restored.replace(/\.txt$/i, '');
    const ext = /\.([^.]+)$/.exec(baseName(stripped))?.[1]?.toLowerCase();
    return stripped !== restored && !(ext && SAFE_EXT.has(ext)) ? [stripped, restored] : [restored];
  }

  /**
   * 같은 이름이 있으면 "이름 (2).확장자"로 바꾼다 (대소문자 무시, 빈 번호 중 가장 작은 것).
   * 이름마다 다음에 볼 번호를 기억해 같은 이름이 많아도 처음부터 다시 세지 않는다
   * (쓴 이름은 늘기만 하므로 앞에서 찬 번호는 계속 차 있다 — 결과는 처음부터 세는 것과 같다).
   */
  function uniqueNames(names) {
    const used = new Set();
    const nextNo = new Map(); // 원래 이름 → 다음에 볼 번호
    return names.map((n) => {
      let out = n;
      if (used.has(n.toLowerCase())) {
        const m = /(\.[^.]*)?$/.exec(n);
        const stem = n.slice(0, m.index);
        const ext = m[0];
        let i = nextNo.get(n) || 2;
        for (out = `${stem} (${i})${ext}`; used.has(out.toLowerCase()); ) out = `${stem} (${++i})${ext}`;
        nextNo.set(n, i + 1);
      }
      used.add(out.toLowerCase());
      return out;
    });
  }

  const md = (name, text) => ({ name, type: 'text/markdown', text });

  /** 묶음 파일 하나의 바이트 한도: BUNDLE_BYTES와 서비스 한도(budget.fileBytes) 중 작은 것 */
  const chunkLimit = (budget) =>
    Math.max(MIN_CHUNK_BYTES, Math.min(BUNDLE_BYTES, budget && budget.fileBytes > 0 ? budget.fileBytes : BUNDLE_BYTES));

  // 조각 머리글("(n개 중 i번째)")이 들어갈 자리
  const PART_HEAD_ROOM = 64;

  /**
   * 글을 limit 바이트 이하 조각으로 나눈다. 줄 경계에서 자르고, 한 줄이 너무 길면 글자 경계에서 자른다
   * (UTF-8 글자·서로게이트 쌍을 중간에서 자르지 않는다).
   */
  function splitBytes(text, limit) {
    const out = [];
    let cur = '';
    let curBytes = 0;
    const push = () => {
      if (cur) out.push(cur);
      cur = '';
      curBytes = 0;
    };
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      const n = bytesOf(line);
      if (curBytes + n <= limit) {
        cur += line;
        curBytes += n;
        continue;
      }
      push();
      if (n <= limit) {
        cur = line;
        curBytes = n;
        continue;
      }
      // 한 줄이 한도보다 길면 글자 경계에서 자른다: 바이트를 누적하며 한 번만 훑고, 자를 때만 slice한다.
      // 서로게이트 쌍은 한 글자(4바이트)로 묶어 가운데서 자르지 않는다.
      let start = 0;
      for (let i = 0; i < line.length; ) {
        const code = line.charCodeAt(i);
        let c;
        let w = 1;
        if (code < 0x80) c = 1;
        else if (code < 0x800) c = 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length && (line.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
          c = 4;
          w = 2;
        } else c = 3;
        if (curBytes + c > limit && i > start) {
          out.push(line.slice(start, i));
          start = i;
          curBytes = 0;
        }
        curBytes += c;
        i += w;
      }
      cur = line.slice(start);
    }
    push();
    return out.length ? out : [''];
  }

  /**
   * 한 파일의 블록이 한도보다 크면 파일 내용을 나눠 블록 여러 개로 만든다 (블록마다 코드 블록이 닫히게).
   * file: { path, text } → ['[파일: …] 블록', …]
   */
  function fileBlocks(file, limit) {
    const whole = `${PC.fileBlock(file.path, file.text)}\n`;
    if (bytesOf(whole) <= limit) return [whole];
    // 머리글·울타리·조각 안내가 들어갈 자리를 빼고 내용을 나눈다
    const overhead = bytesOf(`${PC.fileBlock(file.path, '')}\n`) + 160;
    const parts = splitBytes(file.text, Math.max(1024, limit - overhead));
    return parts.map((p, i) => `(${file.path} — 파일이 커서 ${parts.length}조각으로 나눔: ${i + 1}/${parts.length}, 이어 붙이면 한 파일)\n${PC.fileBlock(file.path, p)}\n`);
  }

  /** 묶음 파일: 내용을 바이트 한도(chunkLimit)씩, 파일 경계에서 나눈다. 한 파일이 한도보다 크면 그 파일도 나눈다. */
  function bundle(baseFile, header, files, budget) {
    const limit = chunkLimit(budget) - PART_HEAD_ROOM;
    const blocks = [];
    const headBytes = bytesOf(header);
    if (header) blocks.push(...(headBytes <= limit ? [header] : splitBytes(header, limit)));
    // 머리글이 작으면 큰 파일 조각을 그만큼 작게 잘라 첫 묶음에 머리글과 함께 들어가게 한다 (머리글만 든 묶음을 만들지 않게)
    const pieceLimit = header && headBytes < limit / 2 ? limit - headBytes - 1 : limit;
    for (const f of files) blocks.push(...fileBlocks(f, pieceLimit));
    const chunks = [];
    let cur = '';
    let curBytes = 0;
    for (const b of blocks) {
      const bn = bytesOf(b);
      if (cur && curBytes + bn + 1 > limit) {
        chunks.push(cur);
        cur = '';
        curBytes = 0;
      }
      curBytes += bn + (cur ? 1 : 0);
      cur += (cur ? '\n' : '') + b;
    }
    chunks.push(cur);
    if (chunks.length === 1) return [md(baseFile, chunks[0])];
    const stem = baseFile.replace(/\.md$/, '');
    return chunks.map((c, i) => md(`${stem}-${i + 1}.md`, `(${chunks.length}개 중 ${i + 1}번째)\n\n${c}`));
  }

  /** 첨부 한도 안에 드는지: budget { files: 남은 개수, bytes: 남은 용량, fileBytes: 파일당 한도 } */
  function fits(attachments, budget) {
    if (!budget) return true;
    if (attachments.length > budget.files) return false;
    let total = 0;
    for (const a of attachments) {
      const n = bytesOf(a.text);
      if (n > budget.fileBytes) return false;
      total += n;
    }
    return total <= budget.bytes;
  }

  /** 개별 파일 첨부와 "올린 이름 → 실제 경로" 목록 */
  function eachFile(files) {
    const names = uniqueNames(files.map((f) => uploadName(f.path)));
    const attachments = files.map((f, i) => ({ name: names[i], type: 'text/plain', text: f.text }));
    const map = files.map((f, i) => `- ${names[i]} → ${f.path}`).join('\n');
    return { attachments, map };
  }

  const FILES_RULE =
    '올린 파일 이름의 "__"는 폴더 구분이고 끝의 ".txt"는 업로드용으로 붙인 것이야. 답변의 "파일: 경로"·NEED_FILES·DELETE_FILES에는 실제 경로(목록의 오른쪽)를 써 줘.';
  const skippedLines = (skipped) => (skipped.length ? ['[보내지 않은 파일]', ...skipped.map((s) => `- ${s.path}: ${s.reason}`), ''] : []);
  const cutInline = (text) =>
    text.length <= PC.INLINE_LIMIT ? text : `${text.slice(0, PC.INLINE_LIMIT - 100)}\n… (분량이 많아 여기까지만 넣었습니다)`;

  /**
   * 첫 질문. project: { name, paths }, files: [{ path, text }], request, mode, budget
   * → { mode(실제로 쓴 방식), text(본문), attachments: [{ name, type, text }], inlineText, note? }
   */
  function packContext({ project, files, request, mode = DEFAULT_MODE, budget }) {
    const legacy = PC.buildContext({ project, files, request });
    const head = `[프로젝트: ${project.name}] (제외 규칙을 통과한 파일 ${project.paths.length}개 중 ${files.length}개 내용 포함)`;
    const tree = PC.buildTree(project.paths);
    const tail = `[요청]\n${request || '(요청 없음 — 첨부한 내용을 검토해 줘)'}\n\n${PC.RULES}`;
    const inlineText = legacy.inlineText;

    if (mode === 'files') {
      const { attachments, map } = eachFile(files);
      const treeInBody = tree.length <= TREE_IN_BODY;
      if (!treeInBody) attachments.push(md('project-structure.md', `${head}\n\n[프로젝트 구조]\n${tree}\n`));
      if (fits(attachments, budget)) {
        const text = [
          head,
          '',
          files.length ? `[올린 파일 ${files.length}개 → 실제 경로]\n${map}` : '(내용을 올린 파일 없음)',
          FILES_RULE,
          '',
          treeInBody ? `[프로젝트 구조]\n${tree}` : '[프로젝트 구조] 첨부한 project-structure.md에 있습니다.',
          '',
          tail,
        ].join('\n');
        return { mode: 'files', text, attachments, inlineText };
      }
    }
    const attachments = bundle(PC.CONTEXT_FILE, `${head}\n\n[프로젝트 구조]\n${tree}\n`, files, budget);
    const names = attachments.map((a) => a.name).join(', ');
    const text = `${head}\n첨부한 ${names}에 프로젝트 구조와 파일 ${files.length}개의 내용이 있습니다.\n\n${tail}`;
    const note = mode === 'files' ? tr('project.upload.bundledNote') : undefined;
    return { mode: 'bundle', text, attachments, inlineText, note };
  }

  /** NEED_FILES 요청에 답하기. files: [{ path, text }], skipped: [{ path, reason }] */
  function packFollowUp({ files, skipped = [], mode = DEFAULT_MODE, budget }) {
    const inlineText = cutInline(PC.buildFollowUp(files, skipped));
    const tail = ['같은 답변 규칙으로 이어서 답해 줘.', '', PC.RULES];
    if (mode === 'files') {
      const { attachments, map } = eachFile(files);
      if (fits(attachments, budget)) {
        const text = [`요청한 파일 ${files.length}개를 올렸습니다.`, '', `[올린 파일 → 실제 경로]\n${map}`, FILES_RULE, '', ...skippedLines(skipped), ...tail].join('\n');
        return { mode: 'files', text, attachments, inlineText };
      }
    }
    const attachments = bundle('requested-files.md', '', files, budget);
    const names = attachments.map((a) => a.name).join(', ');
    const text = [`요청한 파일 ${files.length}개의 내용을 첨부한 ${names}에 넣었습니다.`, '', ...skippedLines(skipped), ...tail].join('\n');
    return { mode: 'bundle', text, attachments, inlineText, note: mode === 'files' ? tr('project.upload.bundledNote') : undefined };
  }

  /**
   * 사용자가 로컬에서 고친 파일을 AI에게 다시 알리기 (사이드바 ⟳ 뒤 "바뀐 파일 보내기").
   * files: [{ path, text }] 바뀐 파일의 지금 내용, deleted: [경로] 지워진 파일
   */
  function packUpdate({ files, deleted = [], mode = DEFAULT_MODE, budget }) {
    const intro = `내가 로컬에서 프로젝트 파일을 고쳤어. 이전에 보낸 내용 대신 아래 내용을 기준으로 해 줘.`;
    const gone = deleted.length ? ['[지워진 파일]', ...deleted.map((p) => `- ${p}`), ''] : [];
    const ack = '지금은 수정하지 말고 무엇이 바뀌었는지 3줄 이내로 확인만 해 줘. 다음 요청부터 같은 답변 규칙을 지켜 줘.';
    const blocks = files.map((f) => `${PC.fileBlock(f.path, f.text)}\n`);
    const inlineText = cutInline([intro, '', ...gone, ...blocks, ack].join('\n'));
    if (!files.length) return { mode, text: [intro, '', ...gone, ack].join('\n'), attachments: [], inlineText };
    if (mode === 'files') {
      const { attachments, map } = eachFile(files);
      if (fits(attachments, budget)) {
        const text = [intro, '', `[올린 파일 ${files.length}개 → 실제 경로]\n${map}`, FILES_RULE, '', ...gone, ack].join('\n');
        return { mode: 'files', text, attachments, inlineText };
      }
    }
    const attachments = bundle('updated-files.md', '', files, budget);
    const names = attachments.map((a) => a.name).join(', ');
    const text = [intro, `바뀐 파일 ${files.length}개의 지금 내용을 첨부한 ${names}에 넣었습니다.`, '', ...gone, ack].join('\n');
    return { mode: 'bundle', text, attachments, inlineText, note: mode === 'files' ? tr('project.upload.bundledNote') : undefined };
  }

  /**
   * 적용하지 못한 파일의 현재 내용을 주고 다시 받기.
   * reason: 'diff'(diff · 찾기/바꾸기가 지금 내용과 맞지 않음) | 'truncated'(답이 잘림, v0.16.1)
   * 긴 파일(EDIT_LINES줄 넘음)은 전체 대신 찾기/바꾸기로 달라고 한다 — 다시 받다가 또 잘리지 않게 (v0.17.0)
   */
  function packRefetch({ path, text: content, mode = DEFAULT_MODE, reason = 'diff' }) {
    const inlineText = cutInline(PC.buildRefetch(path, content));
    const long = String(content).split('\n').length > PC.EDIT_LINES;
    const why = reason === 'truncated' ? '네 답변이 길어서 중간에 잘려 적용하지 못했어' : '네가 준 수정안이 현재 내용과 맞지 않아 적용하지 못했어';
    const ask = (where) =>
      [
        `${where} 파일(${path})은 ${why}. 첨부한 것이 지금 내용이야.`,
        long
          ? `이 파일은 길어서 전체를 다시 쓰지 말고, "파일: ${path}" 줄 다음 코드 블록 하나에 바꿀 곳만 찾기/바꾸기(<<<<<<< 찾기 / ======= / >>>>>>> 바꾸기)로 줘. 찾을 부분은 지금 내용 그대로, 파일 안에서 한 곳만 맞게.`
          : `수정한 "전체" 파일 내용을 "파일: ${path}" 줄 다음에 코드 블록 하나로 다시 줘.`,
      ].join('\n');
    if (mode === 'files') {
      const name = uploadName(path);
      return { mode: 'files', text: `${ask(`첨부한 ${name}`)}\n${FILES_RULE}`, attachments: [{ name, type: 'text/plain', text: content }], inlineText };
    }
    const name = `refetch-${baseName(path).replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')}.md`;
    return { mode: 'bundle', text: ask(`첨부한 ${name}의`), attachments: [md(name, `${PC.fileBlock(path, content)}\n`)], inlineText };
  }

  const CHANGED_FILE = 'changed-files.md';

  /**
   * 이어지는 질문 — 바뀐 파일만 보내기 (v0.23.0). 같은 첨부를 여러 패널에 보내므로 files(올릴 파일)는 모든 패널이 같고,
   * 본문의 목록(same · gone)만 패널마다 다를 수 있다. 첨부는 files · includeTree · mode · budget으로만 정해진다.
   *   files: [{ path, text }] 바뀌었거나 처음 보내는 파일, same: [{ path, lines }] 앞서 보낸 그대로인 파일,
   *   gone: [경로] 앞서 보냈는데 지금은 없는 파일, includeTree: 구조 목록을 다시 보낼지, showLines: 목록에 줄 수를 붙일지
   * → packContext와 같은 모양 { mode, text, attachments, inlineText, note? }
   */
  function packIncremental({ project, files, same = [], gone = [], includeTree = false, showLines = false, first = false, request, mode = DEFAULT_MODE, budget }) {
    // first: 이 패널에는 처음 보냄 (다른 패널은 이어지는 질문이라 같은 첨부를 함께 쓴다)
    const head = first
      ? `[프로젝트: ${project.name}] (제외 규칙을 통과한 파일 ${project.paths.length}개 중 ${files.length}개 내용 포함)`
      : `[프로젝트: ${project.name}] (이어지는 질문 — 바뀌었거나 처음 보내는 파일 ${files.length}개만 올림${same.length ? ` · ${same.length}개는 앞서 보낸 그대로` : ''})`;
    // 첨부 안의 머리글은 패널마다 같아야 한다 (같은 첨부를 여러 패널에 보낸다)
    const fileHead = `[프로젝트: ${project.name}] (제외 규칙을 통과한 파일 ${project.paths.length}개의 구조 · 파일 ${files.length}개 내용)`;
    const tree = includeTree ? PC.buildTree(project.paths) : '';
    const sameLines = same.length
      ? ['[앞서 보낸 그대로] (내용이 바뀌지 않아 다시 올리지 않음 — 이전에 받은 내용을 그대로 써 줘)', ...same.map((f) => `- ${f.path}${showLines ? ` (${f.lines}줄)` : ''}`), '']
      : [];
    const goneLines = gone.length ? ['[지워진 파일] (앞서 보냈지만 지금은 없음)', ...gone.map((p) => `- ${p}`), ''] : [];
    const tail = `[요청]\n${request || '(요청 없음 — 첨부한 내용을 검토해 줘)'}\n\n${PC.RULES}`;
    const treeBlock = includeTree ? [`[프로젝트 구조]\n${tree}`, ''] : [];
    const inlineText = cutInline(
      [head, '', ...treeBlock, ...files.map((f) => `${PC.fileBlock(f.path, f.text)}\n`), ...sameLines, ...goneLines, tail].join('\n'),
    );
    if (!files.length && !includeTree) {
      const text = [head, '', ...sameLines, ...goneLines, tail].join('\n');
      return { mode, text, attachments: [], inlineText: text };
    }
    if (mode === 'files') {
      const { attachments, map } = eachFile(files);
      const treeInBody = tree.length <= TREE_IN_BODY;
      if (includeTree && !treeInBody) attachments.push(md('project-structure.md', `${fileHead}\n\n[프로젝트 구조]\n${tree}\n`));
      if (fits(attachments, budget)) {
        const text = [
          head,
          '',
          files.length ? `[올린 파일 ${files.length}개 → 실제 경로]\n${map}` : '(내용을 올린 파일 없음)',
          files.length ? FILES_RULE : '',
          '',
          ...(includeTree ? [treeInBody ? `[프로젝트 구조]\n${tree}` : '[프로젝트 구조] 첨부한 project-structure.md에 있습니다.', ''] : []),
          ...sameLines,
          ...goneLines,
          tail,
        ].join('\n');
        return { mode: 'files', text, attachments, inlineText };
      }
    }
    const attachments = bundle(includeTree ? PC.CONTEXT_FILE : CHANGED_FILE, includeTree ? `${fileHead}\n\n[프로젝트 구조]\n${tree}\n` : '', files, budget);
    const names = attachments.map((a) => a.name).join(', ');
    const what = [includeTree ? '프로젝트 구조' : '', files.length ? `${first ? '' : '바뀐 '}파일 ${files.length}개의 지금 내용` : ''].filter(Boolean).join('와 ');
    const text = [head, `첨부한 ${names}에 ${what}${files.length ? '이' : '가'} 있습니다.`, '', ...sameLines, ...goneLines, tail].join('\n');
    const note = mode === 'files' ? tr('project.upload.bundledNote') : undefined;
    return { mode: 'bundle', text, attachments, inlineText, note };
  }

  const normalizeMode = (m) => (MODES.includes(m) ? m : DEFAULT_MODE);

  return { MODES, DEFAULT_MODE, BUNDLE_CHUNK, BUNDLE_BYTES, bytesOf, splitBytes, uploadName, restorePaths, uniqueNames, packContext, packFollowUp, packUpdate, packRefetch, packIncremental, normalizeMode };
});
