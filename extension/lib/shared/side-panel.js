// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/side-panel.js)
// 사이드탭 모드 (v0.19.0, 크롬 확장 전용): 크롬 오른쪽 사이드 패널에 AI 웹 채팅을 최대 2개 띄우고,
// 보고 있는 웹페이지 본문을 함께 보내 묻는다. 계산만 하는 부분을 여기 모아 사이드 패널(sidepanel.js)과 테스트가 같이 쓴다.
//
// [쉽게 말하면]
//   - 고른 모델 정리: 웹 서비스만, 겹치지 않게, 최대 2개 (하나도 없으면 Gemini)
//   - 위/아래 나누는 비율: 20% ~ 80% 사이로만
//   - 패널 iframe과 사이드 패널을 잇는 연결 이름: "mla-side:<사이드 패널 번호>:<서비스 id>"
//   - 보낼 글 만들기: 페이지 본문을 그 패널에 아직 안 보냈으면 page.md로 첨부하고 안내 한 줄을 붙인다
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).sidePanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 화면 문구 (i18n-*-ext.js). 부를 때마다 사전을 찾고, 사전이 없으면 키 이름을 그대로 쓴다 (부서지지 않게).
  const tr = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };

  const MAX_SIDE = 2; // 사이드탭에 함께 띄울 수 있는 모델 수
  const DEFAULT_SIDE = ['gemini'];
  const MAX_PAGE = 300000; // page.md에 넣는 본문의 최대 글자 수 (오른쪽 클릭 메뉴와 같음)
  const PORT_PREFIX = 'mla-side';
  const SOURCES = ['page', 'pdf', 'captions']; // 맥락의 출처 (v0.37.0)
  const RATIO_MIN = 0.2;
  const RATIO_MAX = 0.8;

  /** 고른 모델 정리 → 웹 서비스 id 배열 (최대 2개, 비면 기본값) */
  function normalizeSelected(ids, services) {
    const known = new Set((services || []).filter((s) => (s.kind || 'web') === 'web').map((s) => s.id));
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
      if (out.length === MAX_SIDE) break;
    }
    return out.length ? out : DEFAULT_SIDE.filter((id) => known.has(id)).slice(0, 1);
  }

  /**
   * 모델 하나를 켜거나 끈다 → { ok, selected, error }
   * 이미 2개면 더 켜지 않고, 마지막 하나는 끄지 않는다.
   */
  function toggle(selected, id) {
    const cur = Array.isArray(selected) ? [...selected] : [];
    if (cur.includes(id)) {
      if (cur.length === 1) return { ok: false, selected: cur, error: tr('ext.side.minOne') };
      return { ok: true, selected: cur.filter((x) => x !== id) };
    }
    if (cur.length >= MAX_SIDE) return { ok: false, selected: cur, error: tr('ext.side.maxModels', { n: MAX_SIDE }) };
    return { ok: true, selected: [...cur, id] };
  }

  /** 위 패널이 차지하는 비율 (0.2 ~ 0.8, 이상한 값이면 반반) */
  function clampRatio(r) {
    const n = Number(r);
    if (!Number.isFinite(n)) return 0.5;
    return Math.min(RATIO_MAX, Math.max(RATIO_MIN, n));
  }

  /** 패널 iframe의 이름 = content.js가 사이드 패널에 연결할 때 쓰는 연결 이름 */
  const portName = (nonce, id) => `${PORT_PREFIX}:${nonce}:${id}`;

  /** 연결 이름 → { nonce, id } | null */
  function parsePortName(name) {
    const m = /^mla-side:([0-9a-f-]{36}):([a-z0-9-]{1,40})$/.exec(String(name || ''));
    return m ? { nonce: m[1], id: m[2] } : null;
  }

  /** 페이지에서 읽은 값 검사 → { title, url, text, truncated, at, tabId } | null */
  function normalizeContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
    if (!text) return null;
    let url = '';
    try {
      const u = new URL(String(raw.url || ''));
      if (u.protocol === 'http:' || u.protocol === 'https:') url = u.href;
    } catch {}
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || url || tr('prompt.web.page');
    return {
      title,
      url,
      text: text.slice(0, MAX_PAGE),
      truncated: raw.truncated === true || text.length > MAX_PAGE,
      at: Number.isFinite(raw.at) ? raw.at : Date.now(),
      tabId: Number.isInteger(raw.tabId) ? raw.tabId : null,
      source: SOURCES.includes(raw.source) ? raw.source : 'page', // 본문 · PDF · 영상 자막 (v0.37.0)
      ...(Number.isInteger(raw.pages) && raw.pages > 0 ? { pages: raw.pages, totalPages: Number.isInteger(raw.totalPages) ? raw.totalPages : raw.pages } : {}),
    };
  }

  /** 맥락 줄 상태: 'none'(가져온 페이지 없음) · 'off'(꺼 둠) · 'other'(지금 탭과 다름) · 'ok' */
  function contextState(ctx, { on = true, activeTabId = null } = {}) {
    if (!ctx) return 'none';
    if (!on) return 'off';
    if (ctx.tabId !== null && activeTabId !== null && ctx.tabId !== activeTabId) return 'other';
    return 'ok';
  }

  /** 같은 페이지 본문을 다시 보내지 않게 기억하는 열쇠 (주소 + 가져온 때) */
  // 같은 페이지를 다시 읽어도 글이 같으면 같은 열쇠 (v0.19.2: 자동 읽기는 보낼 때마다 다시 읽는다)
  function contextKey(ctx) {
    if (!ctx) return '';
    let h = 5381;
    for (let i = 0; i < ctx.text.length; i++) h = ((h << 5) + h + ctx.text.charCodeAt(i)) | 0;
    return `${ctx.url}#${ctx.text.length}#${(h >>> 0).toString(36)}`;
  }

  // 이 길이까지는 본문을 질문 글에 그대로 넣는다 (v0.19.1). 사이드 패널은 폭이 좁아 사이트가 모바일 화면으로 바뀌고,
  // 그 화면에서는 파일 첨부가 "된 것처럼" 보이고 실제로는 안 붙는 경우가 있어 — 첨부에 기대지 않는 편이 확실하다.
  const INLINE_MAX = 30000;

  /** 본문을 질문 글에 그대로 넣은 글 (출처 · 본문 · 질문) */
  function inlinePrompt(ctx, q) {
    const src = ctx.url ? `「${ctx.title}」(${ctx.url})` : `「${ctx.title}」`;
    return [tr('prompt.web.inline', { src }), '', '---', ctx.text, '---', '', `${tr('prompt.web.question')}${q}`].join('\n');
  }

  /**
   * 한 패널에 보낼 내용 → { text, page: { name, type, text } | null, mode: 'none' | 'inline' | 'file' }
   * 맥락이 켜져 있고 그 패널에 이 페이지를 아직 안 보냈으면:
   *   - 본문이 3만 자 이하: 질문 글에 본문을 그대로 넣는다 ('inline')
   *   - 더 길면: page.md로 첨부하고 안내 한 줄을 질문 앞에 넣는다 ('file' — 오른쪽 클릭 메뉴와 같은 모양)
   */
  function buildSend({ text, ctx, on = true, sentKey = '', webAsk, inlineMax = INLINE_MAX }) {
    const q = String(text || '').trim();
    if (!ctx || !on || sentKey === contextKey(ctx) || !webAsk) return { text: q, page: null, mode: 'none' };
    if (ctx.text.length <= inlineMax) return { text: inlinePrompt(ctx, q), page: null, mode: 'inline' };
    return { text: `${webAsk.pagePrompt(ctx)}${q}`, page: webAsk.pageFile(ctx), mode: 'file' };
  }

  // ---------- 앱 라이브러리 함께 쓰기 · 앱 탭으로 넘기기 (v0.21.0) ----------

  /**
   * 사이드탭에서 고를 수 있는 템플릿: 변수({{이름}})가 없는 것만 (변수 입력 화면은 앱 탭에만 있다)
   * builtin: 앱 기본 템플릿(templates.js), lib: 앱 라이브러리(normalizeLibrary 결과)
   */
  function usableTemplates(builtin, lib, PL) {
    const ok = (t) => t && typeof t.text === 'string' && t.id !== 'none' && !PL.parseVars(t.text).length;
    return [...(lib?.templates || []).filter(ok).map((t) => ({ ...t, mine: true })), ...(builtin || []).filter(ok)];
  }

  /** 템플릿을 채운 질문 (템플릿이 없으면 그대로) */
  function applyTemplate(question, tpl, PL) {
    return tpl ? PL.fillTemplate(tpl.text, question) : question;
  }

  /**
   * 스킬 지침 붙이기: 그 패널의 이 대화에 이 스킬을 아직 안 보냈으면 질문 앞에 지침을 붙인다 → { text, sent }
   * sent: 이 패널에 보낸 스킬 id ('' = 없음). 새 대화를 열면 사이드탭이 ''로 되돌린다.
   */
  function withSkill(text, skill, sent, PL) {
    if (!skill) return { text, sent: sent || '' };
    if (sent === skill.id) return { text, sent };
    return { text: `${PL.skillPrefix([skill])}${text}`, sent: skill.id };
  }

  /**
   * [app ↗]로 앱 탭에 넘길 요청 (오른쪽 클릭 메뉴와 같은 storage.session 'mla:ask' 모양) | null
   * 페이지가 있으면 페이지 본문(page.md로 첨부) + 쓰던 질문, 없으면 질문만.
   */
  function handoff({ ctx, on = true, question = '', now = Date.now() }) {
    const q = String(question || '').trim();
    if (ctx && on) return { kind: 'page', title: ctx.title, url: ctx.url, text: ctx.text, question: q, at: now };
    return q ? { kind: 'question', text: q, question: q, at: now } : null;
  }

  // ---------- 한 번 누르기 질문 · 이 페이지에서 전에 물어본 것 (v0.29.0) ----------

  const QUICK = ['summary', 'translate', 'keypoints', 'explain'];

  /** 페이지 글의 언어 어림: 한글이 글자(공백 · 숫자 · 기호 제외)의 30% 이상이면 'ko', 아니면 'en' */
  function detectLang(text) {
    const s = String(text || '').slice(0, 5000);
    let hangul = 0;
    let letters = 0;
    for (const ch of s) {
      if (/[가-힣ㄱ-ㆎ]/.test(ch)) hangul++;
      if (/\p{L}/u.test(ch)) letters++;
    }
    return letters && hangul / letters >= 0.3 ? 'ko' : 'en';
  }

  /**
   * 한 번 누르기 질문 글: kind는 QUICK 중 하나, t(키)는 화면 문구 사전.
   * 번역은 페이지 언어를 보고 한국어 → 영어 / 그 밖 → 한국어. → 질문 글 | ''(모르는 종류)
   */
  function quickPrompt(kind, ctx, t) {
    if (!QUICK.includes(kind)) return '';
    if (kind === 'translate') return t(detectLang(ctx?.text) === 'ko' ? 'side.quick.translateToEn' : 'side.quick.translateToKo');
    return t(`side.quick.${kind}Prompt`);
  }

  // ---------- 사이트별 프리셋 (v0.37.0) ----------
  // 사이트(호스트)마다 사이드탭에서 쓸 AI 2개와 기본 단추를 기억한다. 그 사이트의 탭으로 가면 AI만 맞추고, 질문은 저절로 보내지 않는다.

  const MAX_SITES = 50;
  const SITE_QUICK = [...QUICK, 'compare', '']; // 기본 단추: 요약 · 번역 · 핵심만 · 쉽게 설명 · 번역 비교 · 없음

  /** 주소 → 사이트 열쇠: http(s)의 호스트 이름 (소문자, 앞의 www. 뺌) | '' */
  function hostKey(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  /** 저장된 값 검사 → { [호스트]: { selected: [id (웹 서비스, 최대 2)], quick, at } } (50개까지, 최근 것 우선) */
  function normalizeSitePresets(raw, services) {
    const out = [];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [host, v] of Object.entries(raw)) {
        if (!/^[a-z0-9.-]{1,253}$/.test(host) || !v || typeof v !== 'object') continue;
        const known = new Set((services || []).filter((s) => (s.kind || 'web') === 'web').map((s) => s.id));
        const selected = [...new Set((Array.isArray(v.selected) ? v.selected : []).filter((id) => typeof id === 'string' && known.has(id)))].slice(0, MAX_SIDE);
        if (!selected.length) continue;
        out.push([host, { selected, quick: SITE_QUICK.includes(v.quick) ? v.quick : '', at: Number.isFinite(v.at) ? v.at : 0 }]);
      }
    }
    return Object.fromEntries(out.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SITES));
  }

  /** 사이트 프리셋 저장 → 새 목록 (같은 호스트는 덮어씀, 50개가 넘으면 가장 오래된 것부터 뺌) */
  function setSitePreset(map, host, { selected, quick = '' } = {}, services, now = Date.now()) {
    if (!host) return normalizeSitePresets(map, services);
    return normalizeSitePresets({ ...map, [host]: { selected, quick, at: now } }, services);
  }

  /** 사이트 프리셋 지우기 → 새 목록 */
  function clearSitePreset(map, host) {
    const next = { ...(map || {}) };
    delete next[host];
    return next;
  }

  /** 이 주소의 사이트 프리셋 | null */
  function presetFor(map, url) {
    const host = hostKey(url);
    return host && map && map[host] ? { host, ...map[host] } : null;
  }

  // ---------- 번역 비교 · 한 줄 종합 (v0.37.0) ----------

  /** 글을 문장으로 (마침표 · 물음표 · 줄바꿈 뒤에서 자름) */
  function splitSentences(text) {
    return String(text || '')
      .split(/(?<=[.!?。！？])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) set.set(s.slice(i, i + 2), (set.get(s.slice(i, i + 2)) || 0) + 1);
    return set;
  };
  /** 두 문장이 비슷한 정도 0~1 (글자 두 개씩 묶은 조각의 Dice 계수 — 한글 · 영어 모두) */
  function similarity(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    const bx = bigrams(x);
    const by = bigrams(y);
    let hit = 0;
    for (const [k, n] of bx) hit += Math.min(n, by.get(k) || 0);
    return (2 * hit) / (x.length - 1 + (y.length - 1));
  }

  /**
   * 두 번역 비교: 한쪽에만 있는(다른 쪽에 비슷한 문장이 없는) 문장에 diff 표시 → { a: [{ text, diff }], b: [...] }
   * 같은 뜻이어도 번역이 아주 다르면 diff가 많이 뜬다 — "다른 문장"이지 틀린 문장이 아니다.
   */
  function diffSentences(a, b, threshold = 0.55) {
    const sa = splitSentences(a);
    const sb = splitSentences(b);
    const mark = (list, other) => list.map((text) => ({ text, diff: !other.some((o) => similarity(text, o) >= threshold) }));
    return { a: mark(sa, sb), b: mark(sb, sa) };
  }

  /** 한 줄 종합 요청 글: 두 AI의 답(앞 maxEach자씩)을 주고 한 문장 결론을 부탁한다. t(키)는 화면 문구 사전 */
  function oneLinePrompt(answers, t, maxEach = 3000) {
    const body = (Array.isArray(answers) ? answers : []).map((x) => `### ${x.name}\n${String(x.text || '').slice(0, maxEach)}`).join('\n\n');
    return `${t('side.oneLine.prompt')}\n\n${body}`;
  }

  /** 한 줄 종합 답 정리: 첫 줄만, 머리표 · 굵게 · 따옴표를 벗기고 200자까지 */
  function cleanOneLine(text) {
    const line = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return (line || '')
      .replace(/^(?:[#>*\-•]+\s*|\d+[.)]\s*)/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '')
      .trim()
      .slice(0, 200);
  }

  // 주소에서 뺄 추적용 칸 (utm_* · 광고 클릭 id 등)
  const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|igshid|_ga|_gl|ref_src|spm)$/i;

  /** 같은 페이지인지 볼 주소: http(s)만, # 뒤 · 추적용 칸을 뺀다 (나머지 쿼리는 순서대로 남김) → 주소 | '' */
  function normalizePageUrl(raw) {
    let u;
    try {
      u = new URL(String(raw || ''));
    } catch {
      return '';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.searchParams.toString() ? `?${u.searchParams}` : ''}`;
  }

  /**
   * 이 페이지에서 전에 물어본 것: 사이드탭 기록('history:side')에서 page.url이 같은 기록 → [{ id, question, at, answers }] 최신부터
   * answers: [{ id, name?, text }] (답이 있는 AI만 — 다시 열어 볼 때)
   */
  function recallFor(records, url, max = 20) {
    const key = normalizePageUrl(url);
    if (!key) return [];
    return (Array.isArray(records) ? records : [])
      .filter((r) => r && r.page && normalizePageUrl(r.page.url) === key && typeof r.question === 'string')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, max)
      .map((r) => ({
        id: r.id,
        question: r.question,
        at: r.at || 0,
        answers: Object.entries(r.answers || {})
          .filter(([, a]) => a && (a.md || a.text))
          .map(([id, a]) => ({ id, text: String(a.md || a.text) })),
      }));
  }

  return { MAX_SIDE, DEFAULT_SIDE, MAX_PAGE, INLINE_MAX, QUICK, SOURCES, MAX_SITES, SITE_QUICK, hostKey, normalizeSitePresets, setSitePreset, clearSitePreset, presetFor, splitSentences, similarity, diffSentences, oneLinePrompt, cleanOneLine, detectLang, quickPrompt, normalizePageUrl, recallFor, usableTemplates, applyTemplate, withSkill, handoff, normalizeSelected, toggle, clampRatio, portName, parsePortName, normalizeContext, contextState, contextKey, inlinePrompt, buildSend };
});
