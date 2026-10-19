// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/prompt-lib.js)
// 사용자 프롬프트 라이브러리(변수 있는 템플릿)와 스킬(앱이 대화에 넣어 주는 지침).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.promptLib)이 같이 쓴다. 저장은 host.library가 한다.
//
// 템플릿 변수
//   {q}                  입력창에 쓴 내용 (예전 템플릿과 같음)
//   {{이름}}             쓸 때 입력받는 칸
//   {{이름|기본값}}      비워 두면 기본값
//   {{이름:가,나,다}}    고르기 목록 (처음 값이 기본)
//   {{오늘}} {{프로젝트}} {{선택 파일}}   앱이 채우는 값 (날짜, 열린 프로젝트 이름, 프로젝트에서 고른 파일 목록)
//
// 스킬 파일(SKILL.md): 맨 위 --- 사이에 name · description, 그 아래가 지침 본문.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).promptLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = {
    templates: 200,
    skills: 50,
    name: 60,
    hint: 200,
    templateText: 20000,
    skillBody: 20000, // 스킬은 질문마다 본문에 붙으므로 너무 길지 않게
    activeSkills: 3, // 동시에 켤 수 있는 스킬 수
    prefixTotal: 30000, // 한 번에 붙이는 지침 글 합계
    varValue: 5000,
    skillFileBytes: 100 * 1024,
  };
  const BUILTIN_VARS = ['오늘', '프로젝트', '선택 파일'];
  const SKILL_MODES = ['first', 'every']; // 새 대화 첫 질문에만 / 매 질문마다

  const VAR_RE = /\{\{\s*([^{}|:]+?)\s*(?:\|([^{}]*)|:([^{}]*))?\s*\}\}/g;

  /** 템플릿의 변수 목록 (같은 이름은 한 번, 앱이 채우는 값 제외) → [{ name, def, choices }] */
  function parseVars(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(VAR_RE)) {
      const name = m[1].trim();
      if (!name || seen.has(name) || BUILTIN_VARS.includes(name)) continue;
      seen.add(name);
      const choices = m[3] !== undefined ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : null;
      out.push({ name, def: m[2] !== undefined ? m[2].trim() : choices?.[0] || '', choices: choices?.length ? choices : null });
    }
    return out;
  }

  /**
   * 템플릿을 채운 실제 질문 글.
   * values: { 변수 이름: 값 }, builtins: { 프로젝트, '선택 파일' } (오늘은 자동)
   * {q}가 없으면 질문을 맨 뒤에 붙인다 (질문이 비어 있으면 붙이지 않음).
   */
  function fillTemplate(text, q, values = {}, builtins = {}) {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const auto = { 오늘: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`, 프로젝트: '', '선택 파일': '', ...builtins };
    const src = String(text || '');
    const filled = src.replace(VAR_RE, (_all, rawName, def, choices) => {
      const name = rawName.trim();
      if (BUILTIN_VARS.includes(name)) return auto[name] ?? '';
      const v = typeof values[name] === 'string' ? values[name].trim() : '';
      if (v) return v;
      if (def !== undefined) return def.trim();
      if (choices !== undefined) return choices.split(',').map((s) => s.trim()).filter(Boolean)[0] || '';
      return '';
    });
    if (filled.includes('{q}')) return filled.split('{q}').join(q);
    return q ? `${filled}\n\n${q}` : filled;
  }

  const clip = (s, n) => String(s ?? '').slice(0, n);
  const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  /** SKILL.md 글 → { name, description, body } | null (본문이 없으면) */
  function parseSkillMd(md, fallbackName = '') {
    let text = String(md || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    let name = '';
    let description = '';
    const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) {
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^\s*(name|description)\s*:\s*(.*?)\s*$/i);
        if (!m) continue;
        const v = m[2].replace(/^["']|["']$/g, '');
        if (m[1].toLowerCase() === 'name') name = v;
        else description = v;
      }
      text = text.slice(fm[0].length);
    }
    const body = text.trim();
    if (!body) return null;
    if (!name) name = (body.match(/^#\s+(.+)$/m)?.[1] || fallbackName || '이름 없는 스킬').trim();
    return { name: clip(name, LIMITS.name), description: clip(description, LIMITS.hint), body: clip(body, LIMITS.skillBody) };
  }

  /** 스킬 → SKILL.md 글 */
  function toSkillMd(skill) {
    const one = (s) => String(s || '').replace(/[\r\n]+/g, ' ');
    return `---\nname: ${one(skill.name)}\ndescription: ${one(skill.description)}\n---\n\n${skill.body || ''}\n`;
  }

  // ---------- 보내는 글: 규칙 기반 정리 · 압축본 ----------

  const EXAMPLE_HEADING = /^(#{1,6})\s+.*(예시|예제|샘플|example|examples|sample)/i;

  /**
   * 뜻은 그대로 두고 꾸밈·빈 줄·주석·같은 줄 반복만 걷어 낸다. dropExamples면 "예시" 제목 아래 절도 뺀다.
   * 코드 블록 안은 건드리지 않는다 (예시 절 안의 코드 블록은 절과 함께 빠짐).
   */
  function cleanSkill(body, { dropExamples = false } = {}) {
    const src = String(body || '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
    const out = [];
    const seen = new Set();
    let fence = null;
    let skipLevel = 0; // 빼는 중인 예시 절의 제목 수준 (0이면 빼는 중 아님)
    for (const raw of src.split('\n')) {
      const line = raw.replace(/[ \t]+$/, '');
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      const heading = !fence && line.match(/^(#{1,6})\s/);
      if (heading && skipLevel && heading[1].length <= skipLevel) skipLevel = 0;
      if (!fence && dropExamples && !skipLevel && EXAMPLE_HEADING.test(line)) skipLevel = line.match(EXAMPLE_HEADING)[1].length;
      if (f) fence = fence ? (f[1][0] === fence[0] && f[1].length >= fence.length ? null : fence) : f[1];
      if (skipLevel) continue;
      if (fence || f) {
        out.push(line);
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // 구분선
      const text = line.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2'); // 굵게 표시
      const key = text.trim();
      if (key.length >= 20 && seen.has(key)) continue; // 같은 문장 반복
      if (key.length >= 20) seen.add(key);
      out.push(text);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 짧은 지문 (압축본을 만들 때의 원문인지 비교용) */
  function textHash(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** 압축본이 지금 원문으로 만든 것이 아닌지 */
  const compactStale = (skill) => !!skill.compact && skill.compactOf !== textHash(skill.body);

  /** 실제로 보내는 지침 본문 (압축본을 쓰면 압축본, 아니면 정리한 원문) */
  function sendBody(skill) {
    if (skill.useCompact !== false && skill.compact) return cleanSkill(skill.compact);
    return cleanSkill(skill.body, { dropExamples: !!skill.dropExamples });
  }

  // 압축 권장 기준 (보내는 글자 수). strong · totalAlert는 기준의 2배 · 1.875배, "매 질문마다"면 0.6배 · 0.625배
  const DEFAULT_WARN = { one: 5000, total: 8000 };

  function warnLimits(warn = DEFAULT_WARN, mode = 'first') {
    const one = mode === 'every' ? Math.round(warn.one * 0.6) : warn.one;
    const total = mode === 'every' ? Math.round(warn.total * 0.625) : warn.total;
    return { info: 2000, one, strong: one * 2, total, totalAlert: Math.round(total * 1.875) };
  }

  /** 스킬 하나의 길이 단계: 'none' | 'info' | 'warn'(압축 권장) | 'strong'(강력 권장) */
  function compressLevel(len, warn, mode) {
    const L = warnLimits(warn, mode);
    return len >= L.strong ? 'strong' : len >= L.one ? 'warn' : len >= L.info ? 'info' : 'none';
  }

  /** AI에게 보낼 압축 요청 글 */
  function compressRequest(skill, target) {
    return [
      `아래는 AI에게 줄 지침("${skill.name}")이야. 이 지침을 ${target.toLocaleString()}자 이내로 압축해 줘.`,
      '- 반드시 지켜야 하는 규칙·절차·조건·금지 사항·출력 형식은 하나도 빠뜨리지 마.',
      '- 설명·배경·예시·인사말·반복은 빼고, 짧은 명령문 목록으로 써.',
      '- 지침을 따르는 AI가 읽는 글이야. 원문과 같은 언어로 써.',
      '- 결과는 코드 블록 하나에만 넣고, 다른 말은 쓰지 마.',
      '',
      '----- 지침 원문 -----',
      cleanSkill(skill.body),
      '----- 끝 -----',
    ].join('\n');
  }

  /** 압축 요청 답변에서 압축본 꺼내기: 첫 코드 블록 안, 없으면 답변 전체 */
  function extractCompressed(md) {
    const m = String(md || '').match(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\s*\1\s*$/m);
    return (m ? m[2] : String(md || '')).trim();
  }

  // ---------- 질문 앞에 붙일 지침 ----------

  const QUESTION_TAIL = ['', '### 질문', '', ''];

  /** 질문 앞에 붙일 스킬 지침 글 (스킬 하나 또는 여러 개 — 앞에 있는 것이 우선) */
  function skillPrefix(skills) {
    const list = (Array.isArray(skills) ? skills : [skills]).filter(Boolean);
    if (list.length === 1) {
      return [
        `### 지침 (스킬: ${list[0].name})`,
        '이 대화가 끝날 때까지 아래 지침을 따라 답해 줘. 지침 자체를 다시 설명하거나 요약하지는 마.',
        '',
        sendBody(list[0]),
        ...QUESTION_TAIL,
      ].join('\n');
    }
    return [
      `### 지침 (스킬 ${list.length}개 — 위에 있는 것이 우선)`,
      '이 대화가 끝날 때까지 아래 지침을 모두 따라 답해 줘. 서로 부딪히면 먼저 나온 지침을 따라. 지침 자체를 다시 설명하거나 요약하지는 마.',
      ...list.flatMap((s, i) => ['', `#### ${i + 1}. ${s.name}`, sendBody(s)]),
      ...QUESTION_TAIL,
    ].join('\n');
  }

  /** 대화 중간에 스킬을 바꿨을 때 붙일 글: 새로 켠 스킬은 본문, 끈 스킬은 "따르지 마" */
  function skillChangeNote(added, removed) {
    const lines = ['### 지침 변경'];
    if (removed.length) lines.push(`지금부터 다음 지침은 따르지 마: ${removed.map((s) => `"${s.name}"`).join(', ')}`);
    if (added.length) {
      lines.push(`지금부터 아래 지침${added.length > 1 ? '들' : ''}도 따라 줘 (이전 지침과 부딪히면 이것을 따라).`);
      for (const s of added) lines.push('', `#### ${s.name}`, sendBody(s));
    }
    return [...lines, ...QUESTION_TAIL].join('\n');
  }

  /**
   * 패널 하나에 이번에 붙일 글. active: 켠 스킬(순서대로), sent: 이 대화에 보낸 스킬 id 목록(없으면 null),
   * nameOf(id): 끈 스킬의 이름 (지운 스킬이면 없을 수 있음)
   * → { text, ids } | null(붙일 것 없음)
   */
  function prefixFor(active, sent, mode, nameOf = () => '') {
    const gone = (id) => ({ id, name: nameOf(id) || '이전 스킬' });
    const ids = active.map((s) => s.id);
    if (!active.length) {
      if (!sent?.length || mode === 'every') return null;
      // 모두 껐다: 앞서 보낸 지침을 그만 따르라고 알린다
      return { text: skillChangeNote([], sent.map(gone)), ids: [] };
    }
    if (mode === 'every' || !sent) return { text: skillPrefix(active), ids };
    if (sent.length === ids.length && sent.every((id, i) => id === ids[i])) return null;
    const added = active.filter((s) => !sent.includes(s.id));
    const removed = sent.filter((id) => !ids.includes(id)).map(gone);
    if (!added.length && !removed.length) return { text: skillPrefix(active), ids }; // 순서만 바뀜: 다시 전부
    return { text: skillChangeNote(added, removed), ids };
  }

  /** 저장된 라이브러리를 검사·정리한다 (모양이 틀린 항목은 버리고 길이를 자른다) */
  function normalizeLibrary(data) {
    const d = data && typeof data === 'object' ? data : {};
    const templates = (Array.isArray(d.templates) ? d.templates : [])
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .slice(0, LIMITS.templates)
      .map((t) => ({
        id: typeof t.id === 'string' && /^u-[\w-]{1,40}$/.test(t.id) ? t.id : newId('u'),
        name: clip(t.name, LIMITS.name).trim() || '이름 없는 템플릿',
        hint: clip(t.hint, LIMITS.hint),
        text: clip(t.text, LIMITS.templateText),
        fav: !!t.fav,
      }));
    const skills = (Array.isArray(d.skills) ? d.skills : [])
      .filter((s) => s && typeof s.body === 'string' && s.body.trim())
      .slice(0, LIMITS.skills)
      .map((s) => ({
        id: typeof s.id === 'string' && /^s-[\w-]{1,40}$/.test(s.id) ? s.id : newId('s'),
        name: clip(s.name, LIMITS.name).trim() || '이름 없는 스킬',
        description: clip(s.description, LIMITS.hint),
        body: clip(s.body, LIMITS.skillBody),
        // AI로 만든 압축본 · 만들 때 원문의 지문 · 보낼 때 압축본을 쓸지 · 예시 절 빼기 · 압축 권장 알림 끄기
        compact: typeof s.compact === 'string' && s.compact.trim() ? clip(s.compact, LIMITS.skillBody) : '',
        compactOf: typeof s.compactOf === 'string' ? clip(s.compactOf, 16) : '',
        useCompact: s.useCompact !== false,
        dropExamples: !!s.dropExamples,
        noWarn: !!s.noWarn,
      }));
    // 템플릿마다 마지막에 넣은 변수 값 (다음에 미리 채워 둠)
    const lastVars = {};
    if (d.lastVars && typeof d.lastVars === 'object') {
      for (const [tid, vals] of Object.entries(d.lastVars).slice(0, LIMITS.templates)) {
        if (!vals || typeof vals !== 'object') continue;
        lastVars[clip(tid, 60)] = Object.fromEntries(
          Object.entries(vals).slice(0, 30).filter(([, v]) => typeof v === 'string').map(([k, v]) => [clip(k, 60), clip(v, LIMITS.varValue)]),
        );
      }
    }
    const ids = new Set(skills.map((s) => s.id));
    // 켠 스킬(순서 = 우선순위, 최대 3개). 예전 저장 값(activeSkill 하나)도 옮긴다.
    const wanted = Array.isArray(d.activeSkills) ? d.activeSkills : typeof d.activeSkill === 'string' ? [d.activeSkill] : [];
    const activeSkills = wanted.filter((id, i, arr) => typeof id === 'string' && ids.has(id) && arr.indexOf(id) === i).slice(0, LIMITS.activeSkills);
    const num = (v, def, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def);
    const w = d.compressWarn && typeof d.compressWarn === 'object' ? d.compressWarn : {};
    return {
      version: 1,
      templates,
      skills,
      lastVars,
      activeSkills,
      skillMode: SKILL_MODES.includes(d.skillMode) ? d.skillMode : 'first',
      compressWarn: { one: num(w.one, DEFAULT_WARN.one, 1000, 20000), total: num(w.total, DEFAULT_WARN.total, 2000, 30000) },
    };
  }

  /** 켠 스킬의 지침을 모두 붙였을 때 길이와 한도 초과 여부 → { len, over } */
  function prefixSize(skills) {
    const len = skills.length ? skillPrefix(skills).length : 0;
    return { len, over: len > LIMITS.prefixTotal };
  }

  /** 내보내기 파일 → 가져올 템플릿·스킬 (기존 것과 합칠 때 새 id를 준다) */
  function importLibrary(json) {
    let data;
    try {
      data = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
      throw new Error('JSON 형식이 아닙니다');
    }
    if (!data || (data.kind !== 'multitude-llm-library' && !Array.isArray(data.templates) && !Array.isArray(data.skills))) {
      throw new Error('Multitude LLM 라이브러리 파일이 아닙니다');
    }
    const lib = normalizeLibrary({ templates: data.templates, skills: data.skills });
    return {
      templates: lib.templates.map((t) => ({ ...t, id: newId('u') })),
      skills: lib.skills.map((s) => ({ ...s, id: newId('s') })),
    };
  }

  /** 내보내기 파일 내용 (변수 값·고른 스킬은 넣지 않음) */
  function exportLibrary(lib) {
    return JSON.stringify({ kind: 'multitude-llm-library', version: 1, templates: lib.templates, skills: lib.skills }, null, 2);
  }

  return {
    LIMITS, BUILTIN_VARS, SKILL_MODES, DEFAULT_WARN,
    parseVars, fillTemplate, parseSkillMd, toSkillMd,
    cleanSkill, textHash, compactStale, sendBody, warnLimits, compressLevel, compressRequest, extractCompressed,
    skillPrefix, skillChangeNote, prefixFor, prefixSize,
    normalizeLibrary, importLibrary, exportLibrary, newId,
  };
});
