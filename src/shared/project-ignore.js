// 프로젝트 폴더를 훑으면서 AI에게 보내지 않을 파일을 가려낸다 (3단계 제외 규칙).
//   L1 항상 제외: 앱에 들어 있는 규칙(비밀·인증서·키, 바이너리, 큰 파일, .git, node_modules). 사용자가 켤 수 없다.
//   L2 기본 적용: .gitignore 계열(하위 폴더 것·.git/info/exclude·git 전역 제외 파일) + AI 전용 ignore + .mlaignore
//   L3 선택 적용: .dockerignore · .npmignore 등 — 다른 목적(이미지·배포 크기)의 파일이라 기본은 끔
// 파일마다 "어느 규칙 파일의 몇째 줄 때문에 빠졌는지"를 남겨 화면에 보여 준다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.projectIgnore)이 같이 쓴다. 파일 읽기는 fsx(쓰는 쪽이 넘김)로 한다.
//
// [쉽게 말하면]
// 프로젝트 폴더에서 "AI에게 보내면 안 되는 파일"을 골라내는 거름망입니다. 3단계로 거릅니다.
//   L1 항상 제외: 비밀번호 파일(.env), 키, node_modules, 그림·압축 파일 등 — 사용자가 켜도 못 보냄
//   L2 기본 제외: .gitignore 등 프로젝트가 스스로 "빼 달라"고 적어 둔 파일 — 직접 체크하면 보낼 수 있음
//   L3 선택 제외: .dockerignore 등 — 사용자가 켜야 적용
// 각 파일이 왜 빠졌는지(어느 파일 몇째 줄 때문인지)도 기억해 화면에 알려 줍니다.
(function (root, factory) {
  const api = factory(root.MLA && root.MLA.vendor && root.MLA.vendor.ignore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).projectIgnore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ignoreLib) {
  'use strict';

  const ignore = ignoreLib || require('./vendor/ignore');

  const MAX_FILE_BYTES = 1024 * 1024; // 이보다 큰 파일은 보내지 않는다 (L1)
  const MAX_ENTRIES = 20000; // 이보다 많으면 훑기를 멈춘다

  // L1: 앱 내장 "항상 제외" (.gitignore 문법)
  const L1_RULES = [
    '.git/',
    'node_modules/',
    '.env',
    '.env.*',
    '!.env.example',
    '!.env.sample',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    'id_rsa*',
    'id_ed25519*',
    'id_ecdsa*',
    '*.keystore',
    '*.jks',
    'credentials*.json',
    'service-account*.json',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.aws/',
    '.ssh/',
    'secrets/',
    '*.zip', '*.7z', '*.rar', '*.tar', '*.tar.*', '*.tgz', '*.gz',
    '*.exe', '*.dll', '*.so', '*.dylib', '*.bin', '*.class', '*.jar', '*.o', '*.a', '*.lib', '*.pyc',
    '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.bmp', '*.ico', '*.svgz', '*.psd',
    '*.mp3', '*.mp4', '*.mov', '*.avi', '*.wav', '*.webm',
    '*.pdf', '*.doc', '*.docx', '*.xls', '*.xlsx', '*.ppt', '*.pptx',
    '*.sqlite', '*.sqlite3', '*.db',
    '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
  ];

  // 순서 = 우선순위(뒤가 이긴다). .gitignore는 하위 폴더 것도 읽고, 나머지는 프로젝트 맨 위 것만 읽는다.
  const L2_FILES = ['.gitignore', '.cursorignore', '.aiexclude', '.geminiignore', '.codeiumignore', '.mlaignore'];
  const L3_FILES = ['.dockerignore', '.npmignore', '.eslintignore', '.prettierignore', '.vercelignore', '.gcloudignore', '.helmignore', '.slugignore'];
  const RANK = { global: 0, info: 1, '.gitignore': 2, '.cursorignore': 100, '.aiexclude': 101, '.geminiignore': 102, '.codeiumignore': 103, '.mlaignore': 200 };

  /**
   * .dockerignore는 패턴이 항상 프로젝트 맨 위 기준이고 "*.log"가 하위 폴더에는 걸리지 않는다.
   * .gitignore 문법으로 옮기려면 앞에 "/"를 붙여 맨 위에 고정한다 ("**\/"로 시작하면 그대로).
   */
  function dockerToGitignore(content) {
    return content.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return '';
      const neg = t.startsWith('!');
      let p = (neg ? t.slice(1) : t).replace(/^\.?\//, '');
      if (!p.startsWith('**/')) p = `/${p}`;
      return (neg ? '!' : '') + p;
    });
  }

  /** 규칙 파일 하나. lines는 화면에 보여 줄 원래 줄, patterns는 ignore에 넣은 줄(같은 줄 번호). */
  function makeSource({ source, dir = '', layer, content, docker = false, rank = 50 }) {
    const lines = content.split(/\r?\n/);
    const patterns = docker ? dockerToGitignore(content) : lines;
    const ig = ignore({ allowRelativePaths: true }).add(patterns.join('\n'));
    return { source: dir ? `${dir}${source}` : source, dir, layer, lines, patterns, ig, rank };
  }

  /** 걸린 규칙이 원래 파일의 몇째 줄인지 */
  function lineOf(src, pattern) {
    const i = src.patterns.findIndex((p) => p.trim() === pattern || p.trim().replace(/\\ $/, ' ') === pattern);
    return i >= 0 ? i + 1 : null;
  }

  const L1 = makeSource({ source: '기본 제외 규칙(앱 내장)', layer: 'L1', content: L1_RULES.join('\n') });

  // 여러 제외 규칙 파일을 모아 "이 경로는 빼야 하나?"에 답하는 판정기를 만듭니다. git과 같은 문법을 씁니다.
  function createMatcher() {
    const l2 = []; // rank 순으로 정렬해 둔다
    const l3 = []; // { ...source, enabled }

    function add(src) {
      if (src.layer === 'L3') l3.push(src);
      else {
        l2.push(src);
        l2.sort((a, b) => a.rank - b.rank);
      }
    }

    /**
     * src 하나에 path를 대 본 결과: { state: 'ignored' | 'unignored', pattern } | null
     * ignore 라이브러리는 상위 폴더가 걸리면 안의 파일도 걸린 것으로 본다. 그런데 상위 폴더가 다른 규칙(!패턴)으로
     * 다시 들어왔다면(그래서 그 안을 훑는 중이라면) 그 상속된 결과는 무시해야 git과 같다. parent가 그 상위 폴더다.
     */
    function test(src, p, parent = '') {
      if (src.dir && !p.startsWith(src.dir)) return null;
      const r = src.ig.test(src.dir ? p.slice(src.dir.length) : p);
      if (r.ignored) {
        const pattern = r.rule && r.rule.pattern;
        if (parent && (!src.dir || parent.startsWith(src.dir))) {
          const pr = src.ig.test(src.dir ? parent.slice(src.dir.length) : parent);
          if (pr.ignored && pr.rule && pr.rule.pattern === pattern) return null; // 상위 폴더에서 물려받은 결과
        }
        return { state: 'ignored', pattern };
      }
      if (r.unignored) return { state: 'unignored' };
      return null;
    }

    function reason(src, pattern) {
      return { layer: src.layer, source: src.source, line: lineOf(src, pattern), pattern };
    }

    /** 이 경로를 뺄 이유. 보내도 되면 null. isDir이면 폴더(규칙의 "dir/" 패턴에 맞게 끝에 / 를 붙여 본다) */
    const cache = new Map(); // 폴더 판정 캐시 (하위 .gitignore는 그 폴더 안에만 영향을 줘서 앞선 판정은 그대로 맞다)

    function classify(path, isDir) {
      const cut = path.lastIndexOf('/');
      // 상위 폴더가 빠졌으면 안의 것도 같은 이유로 빠진다 (git과 같음).
      if (cut > 0) {
        const parentPath = path.slice(0, cut);
        if (!cache.has(parentPath)) cache.set(parentPath, classify(parentPath, true));
        const up = cache.get(parentPath);
        if (up) return up;
      }
      return classifyOne(path, isDir);
    }

    function classifyOne(path, isDir) {
      const p = isDir ? `${path}/` : path;
      const cut = path.lastIndexOf('/');
      const parent = cut > 0 ? `${path.slice(0, cut)}/` : '';
      const l1 = test(L1, p);
      if (l1 && l1.state === 'ignored') return reason(L1, l1.pattern);
      // 같은 단계 안에서는 git처럼 마지막에 걸린 규칙이 이긴다 (!패턴으로 다시 넣기 포함).
      let hit = null;
      for (const src of l2) {
        const r = test(src, p, parent);
        if (r) hit = r.state === 'ignored' ? reason(src, r.pattern) : null;
      }
      if (hit) return hit;
      for (const src of l3) {
        if (!src.enabled) continue;
        const r = test(src, p, parent);
        if (r) hit = r.state === 'ignored' ? reason(src, r.pattern) : null;
      }
      return hit;
    }

    /** 꺼져 있는 L3 규칙 중 이 경로를 뺄 규칙 파일 이름들 (켜면 몇 개가 더 빠지는지 보여 주려고) */
    function l3Would(path, isDir) {
      const p = isDir ? `${path}/` : path;
      const cut = path.lastIndexOf('/');
      const parent = cut > 0 ? `${path.slice(0, cut)}/` : '';
      return l3.filter((src) => !src.enabled && test(src, p, parent)?.state === 'ignored').map((src) => src.source);
    }

    const l3Sources = () => l3.map((s) => s.source);
    return { add, classify, l3Would, l3Sources };
  }

  const join = (dir, name) => (dir ? `${dir}/${name}` : name);

  async function readOptional(fsx, path) {
    try {
      const r = await fsx.readFile(path, { maxBytes: MAX_FILE_BYTES });
      return typeof r?.text === 'string' ? r.text : null;
    } catch {
      return null;
    }
  }

  /**
   * 폴더 하나의 항목을 분류한다. parentReason이 있으면(빠진 폴더를 펼친 경우) 안의 것도 같은 이유로 빠진다.
   * 항목: { path, name, kind: 'file'|'dir'|'link', size, depth, excluded: 이유|null, l3: [켜면 뺄 규칙] }
   */
  function classifyEntries(matcher, dir, depth, items, parentReason = null) {
    return items.map((it) => {
      const path = join(dir, it.name);
      const isDir = it.kind === 'dir';
      let excluded = null;
      if (it.kind === 'link') excluded = { layer: 'L1', source: '바로가기 링크', pattern: '링크는 따라가지 않음' };
      else excluded = matcher.classify(path, isDir);
      if (!excluded && parentReason) excluded = parentReason;
      if (!excluded && !isDir && it.size > MAX_FILE_BYTES) {
        excluded = { layer: 'L1', source: '크기 제한', pattern: `${Math.round(MAX_FILE_BYTES / 1024)}KB 초과` };
      }
      return { path, name: it.name, kind: it.kind, size: it.size || 0, depth, excluded, l3: excluded ? [] : matcher.l3Would(path, isDir) };
    });
  }

  // 폴더 먼저, 그다음 이름 순
  const sortItems = (items) =>
    [...items].sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));

  /**
   * 프로젝트를 훑는다.
   * fsx: { readDir(path) → [{ name, kind, size }], readFile(path, { maxBytes }) → { text } | { binary } | { tooLarge } }
   * opts.l3Enabled: 켤 L3 규칙 파일 이름들, opts.globalExclude: { source, content } (git 전역 제외 파일, 있으면)
   * 결과: { entries(트리 순서), matcher, l2Found, l3Found: [{ source, enabled, count }], truncated }
   */
  // 프로젝트 폴더 전체를 훑어 파일·폴더 목록을 만들고, 항목마다 제외 여부와 이유를 붙입니다.
  // 폴더 안에 .gitignore가 있으면 그 폴더부터 그 규칙을 더해 가며 내려갑니다.
  async function scanProject(fsx, { l3Enabled = [], globalExclude = null, maxEntries = MAX_ENTRIES } = {}) {
    const matcher = createMatcher();
    const l2Found = [];
    if (globalExclude?.content) {
      matcher.add(makeSource({ source: globalExclude.source, layer: 'L2', content: globalExclude.content, rank: RANK.global }));
      l2Found.push(globalExclude.source);
    }
    const info = await readOptional(fsx, '.git/info/exclude');
    if (info) {
      matcher.add(makeSource({ source: '.git/info/exclude', layer: 'L2', content: info, rank: RANK.info }));
      l2Found.push('.git/info/exclude');
    }

    const rootItems = await fsx.readDir('');
    const rootNames = new Set(rootItems.filter((i) => i.kind === 'file').map((i) => i.name));
    for (const name of L2_FILES) {
      if (!rootNames.has(name)) continue;
      const content = await readOptional(fsx, name);
      if (content === null) continue;
      matcher.add(makeSource({ source: name, layer: 'L2', content, rank: RANK[name] }));
      l2Found.push(name);
    }
    const l3Found = [];
    for (const name of L3_FILES) {
      if (!rootNames.has(name)) continue;
      const content = await readOptional(fsx, name);
      if (content === null) continue;
      const src = makeSource({ source: name, layer: 'L3', content, docker: name === '.dockerignore' });
      src.enabled = l3Enabled.includes(name);
      matcher.add(src);
      l3Found.push({ source: name, enabled: src.enabled, count: 0 });
    }

    const entries = [];
    let truncated = false;
    // 폴더 순서대로 깊이 우선으로 훑어 트리 순서를 그대로 만든다.
    async function walk(dir, depth, items) {
      if (dir && items.some((i) => i.kind === 'file' && i.name === '.gitignore')) {
        const content = await readOptional(fsx, join(dir, '.gitignore'));
        if (content !== null) {
          matcher.add(makeSource({ source: '.gitignore', dir: `${dir}/`, layer: 'L2', content, rank: RANK['.gitignore'] + depth }));
          l2Found.push(`${dir}/.gitignore`);
        }
      }
      for (const e of classifyEntries(matcher, dir, depth, sortItems(items))) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        entries.push(e);
        if (e.kind === 'dir' && !e.excluded) {
          let children = [];
          try {
            children = await fsx.readDir(e.path);
          } catch {}
          await walk(e.path, depth + 1, children);
        }
      }
    }
    await walk('', 0, rootItems);

    for (const f of l3Found) f.count = entries.filter((e) => e.l3.includes(f.source)).length;
    return { entries, matcher, l2Found, l3Found, truncated };
  }

  /** 빠진 폴더를 펼쳐 볼 때: 안의 항목을 같은 이유로 빠진 채로 돌려준다 (사용자가 하나씩 골라 넣을 수 있게). */
  async function expandExcluded(fsx, matcher, dirEntry) {
    const items = await fsx.readDir(dirEntry.path);
    return classifyEntries(matcher, dirEntry.path, dirEntry.depth + 1, sortItems(items), dirEntry.excluded);
  }

  /** 파일이 바이너리인지 (첫 8KB에 NUL 문자가 있으면) */
  const looksBinary = (bytes) => {
    const n = Math.min(bytes.length, 8192);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  };

  /** 사람이 읽을 이유 한 줄: ".gitignore 3행 (dist/)" */
  function describe(reason) {
    if (!reason) return '';
    const where = reason.line ? `${reason.source} ${reason.line}행` : reason.source;
    return reason.pattern ? `${where} (${reason.pattern})` : where;
  }

  return {
    MAX_FILE_BYTES,
    L1_RULES,
    L2_FILES,
    L3_FILES,
    dockerToGitignore,
    createMatcher,
    makeSource,
    scanProject,
    expandExcluded,
    looksBinary,
    describe,
  };
});
