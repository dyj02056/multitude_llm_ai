// 관련 파일 찾기 (v0.34.0): 고른 파일이 `import` / `require` / `from … import`로 부르는 프로젝트 안의 파일을 따라가, 함께 보내면 좋을 파일을 제안한다.
// JS · TS(.js .jsx .mjs .cjs .ts .tsx)와 Python(.py)만, 깊이 2까지(기본). 프로젝트 안의 파일만 (패키지 · 표준 라이브러리는 건너뜀).
// 화면(DOM)·파일 읽기를 모르는 순수 계산이다 — 파일 글은 readText(path)로 받는다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.importGraph)이 같이 쓴다.
//
// [쉽게 말하면] "src/user.js를 고치려는데 그 파일이 부르는 cache.js · api.js도 같이 보내야 AI가 제대로 답하겠지"를 자동으로 찾아 주는 부품입니다.
// 따옴표 안의 상대 경로(./cache)와 Python의 상대 · 같은 프로젝트 안 모듈 이름만 읽는 단순한 방식이라, 별칭(@/…) · 동적으로 만든 경로는 찾지 못합니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).importGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JS_EXT = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
  const JS_TRY = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json']; // 확장자 없는 import를 풀 때 차례로 시도
  const MAX_DEPTH = 2;
  const MAX_RESULTS = 30;
  const MAX_FILE_CHARS = 300000; // 이보다 큰 파일은 읽지 않는다 (줄 수 큰 생성 파일 · 번들 건너뜀)

  const extOf = (p) => (/\.[^./\\]+$/.exec(p) || [''])[0].toLowerCase();
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const kindOf = (p) => (JS_EXT.includes(extOf(p)) ? 'js' : extOf(p) === '.py' ? 'py' : '');

  /** 'a/b/../c' · './x' 같은 경로를 정리한다 (프로젝트 밖으로 나가면 null) */
  function normalize(p) {
    const out = [];
    for (const part of String(p).replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!out.length) return null;
        out.pop();
      } else out.push(part);
    }
    return out.join('/');
  }

  /** 주석 · 문자열 안의 가짜 import를 줄이려고 줄 머리 주석(// · #)과 블록 주석을 지운다 (따옴표 안은 그대로 — 경로가 거기 있다) */
  function stripComments(text, kind) {
    const s = String(text || '');
    if (kind === 'py') return s.replace(/^\s*#.*$/gm, '');
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  /**
   * 파일 글에서 부르는 곳을 읽는다 → [{ spec, rel }] (rel: 상대 경로 · 점으로 시작)
   * JS: import … from 'x' · import 'x' · export … from 'x' · require('x') · import('x') — 상대 경로('./' · '../')만
   * Python: from .a import b · from . import b · import a.b · from a.b import c — 점(상대)과 프로젝트 안 모듈 이름 모두
   */
  function parseImports(path, text) {
    const kind = kindOf(path);
    const src = stripComments(text, kind);
    const out = [];
    if (kind === 'js') {
      const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])(\.{1,2}\/[^'"`\n]*|\.{1,2})\1/g;
      for (const m of src.matchAll(re)) out.push({ spec: m[2], rel: true });
    } else if (kind === 'py') {
      for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm)) {
        const dots = m[1].length;
        const mod = m[2];
        if (dots) {
          out.push({ spec: `${'.'.repeat(dots)}${mod}`, rel: true });
          // from . import a, b → 같은 폴더의 a.py · b.py일 수 있다
          if (!mod) for (const name of m[3].replace(/[()]/g, '').split(',')) if (/^\s*\w+/.test(name)) out.push({ spec: `${'.'.repeat(dots)}${name.trim().split(/\s+/)[0]}`, rel: true });
        } else {
          out.push({ spec: mod, rel: false });
          // from pkg import mod → pkg/mod.py일 수 있다
          for (const name of m[3].replace(/[()]/g, '').split(',')) if (/^\s*\w+/.test(name)) out.push({ spec: `${mod}.${name.trim().split(/\s+/)[0]}`, rel: false });
        }
      }
      for (const m of src.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) for (const name of m[1].split(',')) out.push({ spec: name.trim(), rel: false });
    }
    return out;
  }

  /**
   * 부르는 곳(spec) → 프로젝트 안 파일 경로 | null. paths: 프로젝트 파일 경로 Set
   * JS: './x' → x · x.js … · x/index.js …, '.js'로 쓴 import가 .ts 파일이면 그쪽으로(TS의 관례)
   * Python: '.a.b' → 같은(또는 윗) 폴더의 a/b.py · a/b/__init__.py, 'a.b' → 프로젝트 맨 위 · src/ 아래의 a/b.py · a/b/__init__.py
   */
  function resolveImport(from, imp, paths) {
    const kind = kindOf(from);
    if (kind === 'js') {
      const base = normalize(`${dirOf(from)}/${imp.spec}`);
      if (base === null) return null;
      const tries = [base];
      const ext = extOf(base);
      if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        const stem = base.slice(0, -ext.length);
        tries.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
      }
      for (const t of tries) if (paths.has(t) && kindOf(t) === 'js') return t;
      if (!JS_EXT.includes(ext) && ext !== '.json') {
        for (const e of JS_TRY) if (paths.has(base + e)) return base + e;
      } else if (ext === '.json' && paths.has(base)) return base;
      for (const e of JS_TRY) if (paths.has(`${base}/index${e}`)) return `${base}/index${e}`;
      return null;
    }
    if (kind === 'py') {
      let dir;
      let mod = imp.spec;
      const roots = [];
      if (imp.rel) {
        const dots = /^\.*/.exec(mod)[0].length;
        mod = mod.slice(dots);
        let d = dirOf(from);
        for (let i = 1; i < dots; i++) d = dirOf(d);
        roots.push(d);
      } else roots.push('', 'src');
      if (!mod) return imp.rel && paths.has(normalize(`${roots[0]}/__init__.py`) || '') ? normalize(`${roots[0]}/__init__.py`) : null;
      const rel = mod.replace(/\./g, '/');
      for (const r of roots) {
        const a = normalize(`${r}/${rel}.py`);
        const b = normalize(`${r}/${rel}/__init__.py`);
        if (a && paths.has(a)) return a;
        if (b && paths.has(b)) return b;
      }
      void dir;
      return null;
    }
    return null;
  }

  /**
   * 고른 파일에서 import를 따라가 함께 보낼 만한 파일을 찾는다.
   * selected: 고른 파일 경로들, paths: 보낼 수 있는 프로젝트 파일 경로들(제외 규칙을 통과한 것), readText(path) → Promise<string | null>
   * → [{ path, from(그 파일을 부른 파일), depth(1 = 고른 파일이 직접 부름) }] — 가까운 것부터, 고른 파일 · 이미 나온 파일은 뺌, 최대 max개
   * depth 안에서 읽을 수 없는(너무 크거나 글이 아닌) 파일은 목록에는 넣되 더 따라가지 않는다.
   */
  async function relatedFiles({ selected, paths, readText, depth = MAX_DEPTH, max = MAX_RESULTS }) {
    const all = paths instanceof Set ? paths : new Set(paths || []);
    const chosen = new Set(selected || []);
    const seen = new Set(chosen);
    const found = [];
    let frontier = [...chosen].filter((p) => all.has(p) || chosen.has(p));
    const cache = new Map();
    const textOf = async (p) => {
      if (!cache.has(p)) {
        let s = null;
        try {
          s = kindOf(p) ? await readText(p) : null;
        } catch {}
        cache.set(p, typeof s === 'string' && s.length <= MAX_FILE_CHARS ? s : null);
      }
      return cache.get(p);
    };
    for (let d = 1; d <= Math.min(Math.max(depth, 1), MAX_DEPTH); d++) {
      const next = [];
      for (const from of frontier) {
        const text = await textOf(from);
        if (text === null) continue;
        for (const imp of parseImports(from, text)) {
          const target = resolveImport(from, imp, all);
          if (!target || seen.has(target)) continue;
          seen.add(target);
          found.push({ path: target, from, depth: d });
          next.push(target);
          if (found.length >= max) return found;
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return found;
  }

  return { MAX_DEPTH, MAX_RESULTS, kindOf, normalize, parseImports, resolveImport, relatedFiles };
});
