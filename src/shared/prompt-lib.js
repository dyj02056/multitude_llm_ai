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

  /** 질문 앞에 붙일 스킬 지침 글 */
  function skillPrefix(skill) {
    return [
      `### 지침 (스킬: ${skill.name})`,
      '이 대화가 끝날 때까지 아래 지침을 따라 답해 줘. 지침 자체를 다시 설명하거나 요약하지는 마.',
      '',
      skill.body,
      '',
      '### 질문',
      '',
      '',
    ].join('\n');
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
    return {
      version: 1,
      templates,
      skills,
      lastVars,
      activeSkill: typeof d.activeSkill === 'string' && ids.has(d.activeSkill) ? d.activeSkill : null,
      skillMode: SKILL_MODES.includes(d.skillMode) ? d.skillMode : 'first',
    };
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

  return { LIMITS, BUILTIN_VARS, SKILL_MODES, parseVars, fillTemplate, parseSkillMd, toSkillMd, skillPrefix, normalizeLibrary, importLibrary, exportLibrary, newId };
});
