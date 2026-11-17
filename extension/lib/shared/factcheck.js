// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/factcheck.js)
// 사실 확인 (v0.33.0): 답에서 "사실인지 확인할 수 있는 주장"을 최대 10개 뽑고, 검색형 AI 하나에 한 번에 물어
// 주장마다 확인 · 반박 · 일부 · 출처 없음 표를 만든다.
//   1) 추출: 판정 AI(또는 패널 없는 로컬 LLM)에게 답을 주고 주장을 번호 목록으로 받는다.
//   2) 확인: 검색형 AI(기본 Perplexity)에 주장 전체를 한 번에 묻고 표로 받는다 (무료 한도를 아끼려고 주장마다 따로 묻지 않는다).
// 이 파일은 요청 글 · 답 읽기 · 설정 검사 · 보낼 횟수 세기 · 진행 엔진(createFactcheck). 실제 보내기는 rounds.js(sendAndWait).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.factcheck)이 같이 쓴다.
//
// [쉽게 말하면] "이 답이 말한 사실들이 정말 맞나?"를 AI에게 검색해 확인시키고, 주장마다 맞다/아니다/일부/출처 없음을 표로 보여 주는 부품입니다.
// 검색한 결과의 믿을 만함은 그 AI에 달려 있으므로 근거 링크를 함께 받고, 화면에는 "AI가 확인한 것이지 보증이 아니다"라고 알립니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).factcheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (i18n) {
  'use strict';

  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);

  const MAX_CLAIMS = 10;
  const MAX_CLAIM_CHARS = 300;
  const MAX_ANSWER_CHARS = 12000; // 추출 요청에 넣는 답의 최대 길이
  const SEARCH_IDS = ['perplexity', 'genspark']; // 검색형 AI (기본으로 권한다)
  const VERDICTS = ['confirmed', 'refuted', 'partial', 'unsourced', 'unknown'];

  const clip = (s, max) => {
    const x = String(s || '');
    return x.length <= max ? x : `${x.slice(0, max)}\n${t('prompt.clipped')}`;
  };

  /** 추출 요청 글 */
  function buildExtractPrompt({ question, name, answer }) {
    return t('prompt.fact.extract', { max: MAX_CLAIMS, name, question: String(question || '').trim() || t('prompt.noQuestion'), answer: clip(answer, MAX_ANSWER_CHARS) });
  }

  const stripMd = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*•]\s+/, '').trim();

  /**
   * 추출 답에서 주장 목록 읽기: "1. 주장" · "1) 주장" · "- 주장" 줄만, 같은 주장은 한 번만, 최대 MAX_CLAIMS개
   * 번호가 이어지지 않는 설명 줄 · 머리글 · 코드 울타리는 버린다. → ['주장', …]
   */
  function parseClaims(md) {
    const out = [];
    let fence = false;
    for (const raw of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
      if (/^\s*(`{3,}|~{3,})/.test(raw)) {
        fence = !fence;
        continue;
      }
      if (fence) continue;
      const m = /^\s*(?:\d{1,2}\s*[.)]|[-*•])\s+(.+)$/.exec(raw);
      if (!m) continue;
      const text = stripMd(m[1]).slice(0, MAX_CLAIM_CHARS).trim();
      if (text.length < 2 || out.some((x) => x.toLowerCase() === text.toLowerCase())) continue;
      out.push(text);
      if (out.length >= MAX_CLAIMS) break;
    }
    return out;
  }

  /** 확인 요청 글: 번호 붙인 주장 목록 + 표 형식 */
  function buildCheckPrompt({ claims }) {
    return t('prompt.fact.check', { claims: (claims || []).map((c, i) => `${i + 1}. ${c}`).join('\n') });
  }

  /** 판정 칸 글 → 'confirmed' | 'refuted' | 'partial' | 'unsourced' | 'unknown' (출처 없음 · 확인 불가를 "확인"보다 먼저 본다) */
  function verdictOf(cell) {
    const s = String(cell || '').toLowerCase();
    if (/출처\s*없|근거\s*(부족|없)|확인\s*(불가|못|할\s*수\s*없)|no\s+(reliable\s+)?source|unsourced|unverif|could\s*not\s*verify|cannot\s+verify/.test(s)) return 'unsourced';
    if (/일부|부분|partly|partial|mixed|half/.test(s)) return 'partial';
    if (/반박|틀림|틀렸|거짓|사실이?\s*아|아님|오류|refut|false|incorrect|wrong|contradict|disprove/.test(s)) return 'refuted';
    if (/확인|맞음|맞다|사실|참|confirm|true|correct|support|verified|accurate/.test(s)) return 'confirmed';
    return 'unknown';
  }

  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));

  /**
   * 확인 답(표)을 읽는다 → [{ n, claim, verdict, evidence, links }] (claims 순서, 표에 없는 주장은 verdict 'unknown')
   * 번호 칸("1" · "#1" · "1.")으로 주장과 맞추고, 번호가 없거나 틀리면 표의 줄 순서로 맞춘다. 판정 칸은 verdictOf로 읽고 나머지 칸은 근거로 합친다.
   */
  function parseVerdicts(md, claims) {
    const rows = [];
    for (const line of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
      if (!/^\s*\|.*\|\s*$/.test(line)) continue;
      const c = cells(line);
      if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue; // 구분 줄
      if (c.length < 2) continue;
      rows.push(c);
    }
    // 머리줄(번호 칸이 숫자가 아님) 버리기
    const body = rows.filter((c) => /^#?\s*\d{1,2}\s*[.)]?$/.test(c[0]));
    const byOrder = body.length === 0 ? rows.filter((c, i) => i > 0) : [];
    const list = (claims || []).map((claim, i) => {
      const n = i + 1;
      const row = body.find((c) => Number(c[0].replace(/\D/g, '')) === n) || byOrder[i];
      if (!row) return { n, claim, verdict: 'unknown', evidence: '', links: [] };
      const verdictCell = row[1] || '';
      const evidence = row.slice(2).join(' · ').trim();
      return { n, claim, verdict: verdictOf(verdictCell), evidence, links: linksIn(`${verdictCell} ${evidence}`) };
    });
    return list;
  }

  const LINK_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;
  function linksIn(text) {
    const seen = new Set();
    const out = [];
    for (const m of String(text || '').matchAll(LINK_RE)) {
      const u = m[0].replace(/[.,;:!?)\]}。、]+$/, '');
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
    return out;
  }

  /** 판정별 개수 { confirmed, refuted, partial, unsourced, unknown, total } */
  function summarize(items) {
    const out = { confirmed: 0, refuted: 0, partial: 0, unsourced: 0, unknown: 0, total: 0 };
    for (const it of items || []) {
      out[VERDICTS.includes(it.verdict) ? it.verdict : 'unknown']++;
      out.total++;
    }
    return out;
  }

  /**
   * 화면이 보낸 설정 검사. cfg: { source: 'analysis' | 패널 id, extractor: id, checker: id }, open: 열린 패널 id, judgeIds: 추출을 맡을 수 있는 id(열린 패널 + 패널 없는 로컬 LLM)
   * → { ok: true, source, extractor, checker } | { ok: false, error }
   * 확인할 AI(checker)는 열린 패널이어야 한다 (웹 검색은 그 사이트가 한다). 기본: 검색형 AI(Perplexity · Genspark) 가운데 열린 것 → 아니면 첫 패널.
   */
  function normalizeFactcheck(cfg, open, defaultExtractor, judgeIds) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const openIds = Array.isArray(open) ? open : [];
    const judges = Array.isArray(judgeIds) ? judgeIds : openIds;
    if (!openIds.length) return { ok: false, error: t('fact.errNoPanel') };
    const source = c.source === 'analysis' || openIds.includes(c.source) ? c.source : defaultExtractor && openIds.includes(defaultExtractor) ? defaultExtractor : openIds[0];
    const extractor = typeof c.extractor === 'string' && judges.includes(c.extractor) ? c.extractor : judges.includes(defaultExtractor) ? defaultExtractor : judges[0];
    const checker = typeof c.checker === 'string' && openIds.includes(c.checker) ? c.checker : SEARCH_IDS.find((id) => openIds.includes(id)) || openIds[0];
    if (!extractor) return { ok: false, error: t('fact.errNoExtractor') };
    return { ok: true, source, extractor, checker };
  }

  /** 화면이 보낸 설정에서 아는 칸만 (본체 ipc/chain.js · 확장 host.js 공용). source는 'analysis' 또는 패널 id */
  function cleanFactCfg(cfg, okId = () => true) {
    const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
    const id = (v) => (typeof v === 'string' && okId(v) ? v : undefined);
    return { source: c.source === 'analysis' ? 'analysis' : id(c.source), extractor: id(c.extractor), checker: id(c.checker) };
  }

  /** 보낼 횟수: 추출 1번(extractor) + 확인 1번(checker) */
  const countSends = (cfg) => ({ total: 2, byWho: cfg.extractor === cfg.checker ? { [cfg.extractor]: 2 } : { [cfg.extractor]: 1, [cfg.checker]: 1 } });

  /**
   * 진행 엔진. d:
   *   sendAndWait(id, text) → Promise<{ state, text, md }>, readAnswer(id), nameOf(id), openIds(), judgeIds(), defaultJudge()
   *   getRound() → { question, historyId } | null, analysisFinal() → 글 | '' (이번 질문의 최신 분석의 최종 답변)
   *   history: { addSynth(historyId, entry) }, status(patch), notify(event), cancel(id), log
   *   status(patch): { state: 'extracting' | 'checking' | 'done' | 'stopped' | 'error', claims?, error? }
   */
  function createFactcheck(d) {
    let run = null;
    const fail = (error) => {
      d.status({ state: 'error', error });
      return { ok: false, error };
    };

    async function start(cfg) {
      if (run) return { ok: false, error: t('fact.errRunning') }; // 진행 중인 사실 확인의 상태 표시를 덮어쓰지 않는다
      const r = d.getRound();
      if (!r) return fail(t('fact.errNoRound'));
      const c = normalizeFactcheck(cfg, d.openIds(), d.defaultJudge(), d.judgeIds?.());
      if (!c.ok) return fail(c.error);
      let sourceName;
      let text;
      if (c.source === 'analysis') {
        text = d.analysisFinal?.() || '';
        sourceName = t('fact.sourceAnalysis');
        if (!text) return fail(t('fact.errNoAnalysis'));
      } else {
        text = (await d.readAnswer(c.source)).md;
        sourceName = d.nameOf(c.source);
        if (!text) return fail(t('fact.errNoAnswer', { name: sourceName }));
      }
      let resolveStop;
      const stopP = new Promise((res) => (resolveStop = res));
      run = { stopped: false, waiting: new Set(), stopP, resolveStop };
      run.done = loop(run, r, c, sourceName, text)
        .catch((err) => {
          d.log?.('factcheck', 'failed', err && err.message);
          fail(String((err && err.message) || err));
        })
        .finally(() => {
          run = null;
        });
      return { ok: true, sends: countSends(c).total };
    }

    const ask = (cur, id, text) => {
      cur.waiting.add(id);
      return Promise.race([d.sendAndWait(id, text), cur.stopP]).finally(() => cur.waiting.delete(id));
    };

    async function loop(cur, r, c, sourceName, text) {
      const checkerName = d.nameOf(c.checker);
      const fin = (error) => {
        d.status({ state: 'error', error });
        d.notify?.({ kind: 'synth', ok: false, judge: checkerName, mode: 'factcheck' });
      };
      d.status({ state: 'extracting', who: d.nameOf(c.extractor) });
      const ex = await ask(cur, c.extractor, buildExtractPrompt({ question: r.question, name: sourceName, answer: text }));
      if (cur.stopped) return d.status({ state: 'stopped' });
      if (ex.state !== 'done' || !ex.md) return fin(t('fact.errExtract', { name: d.nameOf(c.extractor) }));
      const claims = parseClaims(ex.md);
      if (!claims.length) return fin(t('fact.errNoClaims'));
      d.status({ state: 'checking', who: checkerName, claims: claims.length });
      const chk = await ask(cur, c.checker, buildCheckPrompt({ claims }));
      if (cur.stopped) return d.status({ state: 'stopped' });
      if (chk.state !== 'done' || !chk.md) return fin(t('fact.errCheck', { name: checkerName }));
      d.history.addSynth(r.historyId, { judge: checkerName, at: Date.now(), text: chk.text, md: chk.md, mode: 'factcheck', names: [sourceName], claims, extractor: d.nameOf(c.extractor) });
      d.status({ state: 'done', who: checkerName, claims: claims.length });
      d.notify?.({ kind: 'synth', ok: true, judge: checkerName, mode: 'factcheck' });
    }

    function stop() {
      if (!run) return { ok: false, error: t('fact.errNotRunning') };
      run.stopped = true;
      for (const id of run.waiting) d.cancel(id);
      run.resolveStop({ state: 'stopped', text: '', md: '' });
      return { ok: true };
    }

    return { start, stop, running: () => !!run, whenDone: () => (run ? run.done : Promise.resolve()) };
  }

  return { MAX_CLAIMS, SEARCH_IDS, VERDICTS, buildExtractPrompt, parseClaims, buildCheckPrompt, verdictOf, parseVerdicts, linksIn, summarize, normalizeFactcheck, cleanFactCfg, countSends, createFactcheck };
});
