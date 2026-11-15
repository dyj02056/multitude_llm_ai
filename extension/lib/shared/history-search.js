// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/history-search.js)
// 기록 찾기 (v0.27.0): 검색어 + 거르기(기간 · AI · 평가 · 보낸 곳 · 프로젝트 · 종합/분석/이어 묻기 · 태그 · 즐겨찾기),
// 태그 다듬기, 대화 줄기(threadId)로 묶기. history-core(기록장)와 화면이 같이 쓴다.
// Electron 앱(require)과 크롬 확장 · 화면(전역 MLA.historySearch)이 같이 쓴다.
//
// [쉽게 말하면] 기록 화면 왼쪽 목록에서 "지난 7일 · Claude에게 보낸 · 별표 붙은 것"처럼 골라 보는 계산을 하는 부품입니다.
// 기록 2000개에서도 빠르도록 싼 조건(날짜 · 표시)부터 보고, 글 찾기는 마지막에 합니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).historySearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;
  const PERIODS = ['all', 'today', '7d', '30d', 'range'];
  const RATINGS = ['', 'good', 'bad', 'none'];
  const SOURCES = ['', 'app', 'side'];
  const HAS = ['synth', 'analysis', 'chain'];
  const MAX_TAGS = 10; // 기록 하나의 태그 최대 개수
  const MAX_TAG_LEN = 30; // 태그 하나 최대 글자 수
  const okSvc = (id) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(id);
  const okDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00`));

  /**
   * 태그 다듬기: 글자만, 앞뒤 공백 · 겹친 공백 정리, 30자까지, 대소문자 무시하고 겹친 것 빼기, 10개까지.
   * 쉼표로 이은 글 하나("a, b")도 받는다. → string[]
   */
  function cleanTags(input) {
    const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
    const out = [];
    const seen = new Set();
    for (const v of raw.slice(0, 100)) {
      if (typeof v !== 'string') continue;
      const tag = v.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN).trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  /** 기록의 태그 (없거나 깨졌으면 빈 목록) */
  const tagsOf = (rec) => (rec && Array.isArray(rec.tags) ? rec.tags.filter((x) => typeof x === 'string' && x) : []);

  /** 화면이 넘긴 거르기 값에서 아는 칸만 → 깨끗한 값 (모르는 값은 "거르지 않음") */
  function cleanFilters(f) {
    const o = f && typeof f === 'object' && !Array.isArray(f) ? f : {};
    const period = PERIODS.includes(o.period) ? o.period : 'all';
    return {
      period,
      from: period === 'range' && okDay(o.from) ? o.from : '',
      to: period === 'range' && okDay(o.to) ? o.to : '',
      services: Array.isArray(o.services) ? [...new Set(o.services.filter(okSvc))].slice(0, 20) : [],
      rating: RATINGS.includes(o.rating) ? o.rating : '',
      source: SOURCES.includes(o.source) ? o.source : '',
      project: o.project === true,
      has: Array.isArray(o.has) ? HAS.filter((h) => o.has.includes(h)) : [],
      tag: typeof o.tag === 'string' ? cleanTags([o.tag])[0] || '' : '',
      star: o.star === true,
    };
  }

  /** 거르기 중 켠 것의 개수 (화면의 "필터 N" 표시) */
  function activeCount(f) {
    const c = cleanFilters(f);
    return (
      (c.period !== 'all' ? 1 : 0) + (c.services.length ? 1 : 0) + (c.rating ? 1 : 0) + (c.source ? 1 : 0) +
      (c.project ? 1 : 0) + c.has.length + (c.tag ? 1 : 0) + (c.star ? 1 : 0)
    );
  }

  /** 기간 → { from, to } (밀리초, 그 안이면 통과). now: 지금 시각 (테스트용) */
  function periodRange(f, now = Date.now()) {
    const startOfDay = (ms) => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const today = startOfDay(now);
    if (f.period === 'today') return { from: today, to: Infinity };
    if (f.period === '7d') return { from: today - 6 * DAY, to: Infinity };
    if (f.period === '30d') return { from: today - 29 * DAY, to: Infinity };
    if (f.period === 'range') {
      const from = f.from ? Date.parse(`${f.from}T00:00:00`) : -Infinity;
      const to = f.to ? Date.parse(`${f.to}T00:00:00`) + DAY - 1 : Infinity; // 끝 날짜는 그날 끝까지
      return { from, to };
    }
    return { from: -Infinity, to: Infinity };
  }

  const feedbackValues = (rec) => {
    const fb = rec && rec.feedback;
    if (!fb || typeof fb !== 'object' || Array.isArray(fb)) return [];
    return Object.values(fb).filter((v) => v === 1 || v === -1);
  };
  const synthOf = (rec) => (Array.isArray(rec.synth) ? rec.synth.filter((s) => s && typeof s === 'object') : []);
  const chainOf = (rec) => (Array.isArray(rec.chain) ? rec.chain.filter((c) => c && typeof c === 'object') : []);

  /** 종합 · 분석 · 이어 묻기 · 토론을 가졌는가 */
  function hasKind(rec, kind) {
    if (kind === 'synth') return synthOf(rec).some((s) => s.mode !== 'analysis');
    if (kind === 'analysis') return synthOf(rec).some((s) => s.mode === 'analysis');
    if (kind === 'chain') return chainOf(rec).length > 0;
    return false;
  }

  /** 거르기 조건(글 찾기 빼고)에 맞는가. f는 cleanFilters를 거친 값, range는 periodRange 결과 */
  function matchFilters(rec, f, range) {
    const at = Number(rec.at) || 0;
    if (at < range.from || at > range.to) return false;
    if (f.star && rec.star !== true) return false;
    if (f.source === 'side' && rec.source !== 'side') return false;
    if (f.source === 'app' && rec.source === 'side') return false;
    if (f.project && !(rec.project && typeof rec.project === 'object')) return false;
    if (f.services.length) {
      const targets = Array.isArray(rec.targets) ? rec.targets : [];
      if (!f.services.some((id) => targets.includes(id))) return false;
    }
    if (f.rating) {
      const fb = feedbackValues(rec);
      if (f.rating === 'good' && !fb.includes(1)) return false;
      if (f.rating === 'bad' && !fb.includes(-1)) return false;
      if (f.rating === 'none' && fb.length) return false;
    }
    for (const h of f.has) if (!hasKind(rec, h)) return false;
    if (f.tag) {
      const key = f.tag.toLowerCase();
      if (!tagsOf(rec).some((x) => x.toLowerCase() === key)) return false;
    }
    return true;
  }

  const low = (v) => (typeof v === 'string' ? v.toLowerCase() : '');

  /** 글 찾기: 질문 · 첨부 이름 · 답변 · 종합 · 이어 묻기 · 태그 (q는 소문자) */
  function textHit(rec, q) {
    if (!q) return true;
    if (low(rec.question).includes(q)) return true;
    if ((Array.isArray(rec.files) ? rec.files : []).some((x) => x && low(x.name).includes(q))) return true;
    const answers = rec.answers && typeof rec.answers === 'object' ? Object.values(rec.answers) : [];
    if (answers.some((a) => a && low(a.text).includes(q))) return true;
    if (synthOf(rec).some((s) => low(s.text).includes(q))) return true;
    for (const c of chainOf(rec)) {
      const texts = c.kind === 'debate' ? (Array.isArray(c.answers) ? c.answers.map((x) => x && x.text) : []) : [c.text];
      if (texts.some((x) => low(x).includes(q))) return true;
    }
    return tagsOf(rec).some((x) => x.toLowerCase().includes(q));
  }

  /**
   * 기록 거르기 (순수 함수): records(최근 것부터) 중 검색어 · 거르기에 맞는 것만 같은 순서로.
   * filters는 cleanFilters를 거치지 않은 값이어도 된다. now: 지금 시각 (테스트용)
   */
  function filterRecords(records, query, filters, now = Date.now()) {
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const f = cleanFilters(filters);
    const range = periodRange(f, now);
    const out = [];
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== 'object') continue;
      if (matchFilters(r, f, range) && textHit(r, q)) out.push(r);
    }
    return out;
  }

  /** 기록들에 붙은 태그와 개수 → [{ tag, n }] (많은 순, 같으면 이름 순) */
  function tagCounts(records) {
    const by = new Map();
    for (const r of Array.isArray(records) ? records : []) {
      for (const tag of tagsOf(r)) {
        const key = tag.toLowerCase();
        const e = by.get(key) || { tag, n: 0 };
        e.n++;
        by.set(key, e);
      }
    }
    return [...by.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
  }

  /**
   * 대화 줄기로 묶기: 목록 항목(최근 것부터, { id, at, threadId? }) → [{ key, threadId, items(최근 것부터), at(가장 최근) }]
   * threadId가 없는 예전 기록은 혼자 한 줄기. 줄기 순서는 가장 최근 질문 순.
   */
  function groupThreads(items) {
    const groups = new Map();
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it !== 'object') continue;
      const key = typeof it.threadId === 'string' && it.threadId ? `t:${it.threadId}` : `r:${it.id}`;
      if (!groups.has(key)) groups.set(key, { key, threadId: key.startsWith('t:') ? it.threadId : null, items: [], at: 0 });
      const g = groups.get(key);
      g.items.push(it);
      g.at = Math.max(g.at, Number(it.at) || 0);
    }
    return [...groups.values()].sort((a, b) => b.at - a.at);
  }

  return { cleanTags, tagsOf, cleanFilters, activeCount, periodRange, matchFilters, textHit, filterRecords, tagCounts, groupThreads, hasKind, PERIODS, RATINGS, SOURCES, HAS, MAX_TAGS, MAX_TAG_LEN };
});
