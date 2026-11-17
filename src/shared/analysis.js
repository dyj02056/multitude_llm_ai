// 답변 일치·이견 분석 결과 읽기와 답변 차이 강조.
// Electron 앱 화면(<script>, 전역 MLA.analysis)과 크롬 확장 프로그램이 같이 쓰고, 테스트는 require로 읽는다.
//
// [쉽게 말하면]
// 판정을 맡은 AI가 정해진 형식(공통 의견 / 이견 표 / 근거 부족 / 최종 답변)으로 답하면,
// 그 글을 읽어 화면이 표로 그릴 수 있는 모양으로 바꿉니다. 형식이 깨졌으면 ok: false를 돌려주고, 화면은 글을 그대로 보여 줍니다.
// diffMarks는 기준 답변과 다른 문장만 표시하려고 답변을 문장 조각으로 나눕니다 (jsdiff의 diffArrays).
(function (root, factory) {
  const api = factory(root.Diff);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).analysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DiffLib) {
  'use strict';

  const Diff = DiffLib || require('./vendor/diff');

  // 판정 AI에게 요구하는 머리글 (synth.js의 분석 요청 글과 같아야 한다)
  // 화면 문구 (v0.30.0): 부를 때마다 사전에서 찾는다 (언어를 바꾸면 바로 반영). 사전이 없는 곳(서비스 페이지 등)에서는 키 이름 그대로
  const tr = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };
  // 머리글 이름은 AI 답을 읽는 데 쓴다. 요청 글이 화면 언어를 따르므로(v0.31.0) 두 언어 이름을 모두 받는다
  // — 요청을 보낸 뒤 언어를 바꿔도, 예전 기록의 분석도 읽을 수 있게. 이름은 i18n-<언어>-prompt.js의 prompt.analysis.*와 같아야 한다.
  const SECTIONS = { common: '공통 의견', disagree: '이견', unsupported: '근거 부족', final: '최종 답변' };
  const SECTIONS_EN = { common: 'Common ground', disagree: 'Disagreements', unsupported: 'Weak evidence', final: 'Final answer' };
  const SECTION_NAMES = Object.keys(SECTIONS).map((key) => [key, [SECTIONS[key], SECTIONS_EN[key]].map((n) => n.toLowerCase().replace(/ /g, ''))]);
  const NONE_RE = /^(없음|없습니다|해당\s*없음|none|n\/a|-)\.?$/i;
  const VERDICT_RE = /^(판단|결론|평가|판정|verdict)$/i;

  /** 머리글 줄이면 섹션 이름(common · disagree · unsupported · final), 아니면 null. "## 이견", "**이견**", "[이견]", "2) 이견:" 모두 받는다 */
  function sectionOf(line) {
    const t = line
      .trim()
      .replace(/^#{1,6}\s*/, '')
      .replace(/^\d+\s*[.)]\s*/, '')
      .replace(/^[*_[\]【】\s]+|[*_[\]【】:：\s]+$/g, '')
      .replace(/\s+/g, ' ');
    const bare = t.toLowerCase().replace(/ /g, '');
    for (const [key, names] of SECTION_NAMES) if (names.includes(bare)) return key;
    return null;
  }

  /** 글머리표 목록 → 항목 글 목록 (이어지는 줄은 앞 항목에 붙임, "없음"은 뺌) */
  function bullets(lines) {
    const out = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^(?:[-*•·]|\d+[.)])\s+(.*)$/.exec(line);
      if (m) out.push(m[1].trim());
      else if (out.length) out[out.length - 1] += ` ${line}`;
      else out.push(line);
    }
    return out.filter((t) => t && !NONE_RE.test(t));
  }

  const cellsOf = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  const norm = (s) => String(s || '').toLowerCase().replace(/\(당신\)|\(나\)|\(you\)|\(me\)|\*|_|`/g, '').replace(/\s+/g, '');

  /** 표 머리글 이름을 알고 있는 AI 이름으로 맞춘다 (대소문자·띄어쓰기·"(당신)" 무시, 앞부분 일치 허용) */
  function matchName(label, names) {
    const n = norm(label);
    if (!n) return null;
    return names.find((x) => norm(x) === n) || names.find((x) => n.startsWith(norm(x)) || norm(x).startsWith(n)) || null;
  }

  const mentions = (text, names) => names.filter((n) => norm(text).includes(norm(n)));

  /** 이견 섹션: 표가 있으면 표로, 없으면 글머리표 하나하나를 쟁점으로 */
  function parseDisagreements(lines, names) {
    const tableLines = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l));
    if (tableLines.length >= 2) {
      const rows = tableLines.map(cellsOf).filter((c) => !isSepRow(c));
      const [head, ...body] = rows;
      const verdictAt = head.findIndex((h, i) => i > 0 && VERDICT_RE.test(h.replace(/[*_]/g, '').trim()));
      const topicAt = 0; // 첫 열이 쟁점 (머리글 이름은 쟁점·항목·주제 등 무엇이든)
      const cols = head.map((h, i) => (i === topicAt || i === verdictAt ? null : { label: h, name: matchName(h, names) || h }));
      return body
        .filter((r) => r.some(Boolean) && !NONE_RE.test(r[topicAt] || ''))
        .map((r) => ({
          topic: r[topicAt] || '',
          positions: cols.map((c, i) => c && { name: c.name, known: names.includes(c.name), text: r[i] || '' }).filter((p) => p && p.text),
          verdict: verdictAt > 0 ? r[verdictAt] || '' : '',
        }));
    }
    return bullets(lines).map((t) => {
      const known = mentions(t, names);
      return { topic: t, positions: known.map((name) => ({ name, known: true, text: '' })), verdict: '' };
    });
  }

  /** 근거 부족: "[AI 이름] 내용" · "AI 이름: 내용" → { name(모르면 null), text } */
  function parseUnsupported(lines, names) {
    return bullets(lines).map((t) => {
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(t) || /^\*\*([^*]+)\*\*\s*[:：-]?\s*(.*)$/.exec(t) || /^([^:：]{1,30})[:：]\s*(.*)$/.exec(t);
      const name = m && matchName(m[1], names);
      return name ? { name, text: m[2].trim() } : { name: mentions(t, names)[0] || null, text: t };
    });
  }

  /**
   * 판정 AI의 분석 답변을 읽는다.
   * md: 답변 글(Markdown), names: 비교한 AI 이름들 (이견 표의 열 · 근거 부족의 이름과 맞춘다)
   * → { ok: true, common: [글], disagreements: [{ topic, positions: [{ name, known, text }], verdict }],
   *     unsupported: [{ name, text }], final: 글 }
   *   | { ok: false, raw: md, reason }   (형식이 깨졌으면 화면은 글 그대로 보여 준다)
   */
  function parseAnalysis(md, { names = [] } = {}) {
    const text = String(md || '').replace(/\r\n/g, '\n');
    if (!text.trim()) return { ok: false, raw: text, reason: tr('main.analysis.empty') };
    const parts = {};
    let cur = null;
    let inFence = false;
    for (const line of text.split('\n')) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      const key = inFence ? null : sectionOf(line);
      if (key && !(key in parts)) {
        cur = key;
        parts[key] = [];
        continue;
      }
      if (cur) parts[cur].push(line);
    }
    if (!parts.disagree || !parts.final) {
      return { ok: false, raw: text, reason: tr('main.analysis.noHeading', { heading: !parts.disagree ? SECTIONS.disagree : SECTIONS.final }) };
    }
    const final = parts.final.join('\n').trim();
    if (!final) return { ok: false, raw: text, reason: tr('main.analysis.emptyFinal') };
    return {
      ok: true,
      common: bullets(parts.common || []),
      disagreements: parseDisagreements(parts.disagree, names),
      unsupported: parseUnsupported(parts.unsupported || [], names),
      final,
    };
  }

  /** 문장 조각: 마침표·물음표·느낌표(。 포함) 뒤, 또는 줄바꿈마다 끊는다 (목록·표처럼 마침표 없는 줄도 한 줄씩) */
  function sentences(text) {
    // 끊는 곳: "문장부호 + 공백" 뒤, 또는 줄바꿈(연속이면 마지막) 뒤. 3.14처럼 공백이 없는 점에서는 끊지 않는다.
    return text ? text.split(/(?<=[.!?。][ \t]+)(?=\S)|(?<=\n)(?=[^\n])/).filter(Boolean) : [];
  }
  const key = (s) => s.replace(/\s+/g, ' ').trim();

  // ---------- 비슷한 문장 ----------
  // AI들은 같은 내용을 조금씩 다르게 씁니다 ("Python을 추천합니다" · "Python을 권합니다"). 글자가 정확히 같아야 같다고 보면
  // 거의 모든 문장이 "다름"이 되므로, 글자 두 개씩 묶음(bigram)이 많이 겹치면 "비슷한 문장"으로 보고 강조하지 않는다.
  // 단, 숫자가 다르면(940만 · 950만) 내용이 다른 것이므로 비슷하게 보지 않는다.
  const SIMILAR_MIN = 0.55; // 겹침 정도(Dice 계수) 기준
  const bare = (s) => s.toLowerCase().replace(/[\s.,!?。·:;'"`()[\]{}<>*_#|~\-–—→]+/g, '');
  const numbersOf = (s) => (s.match(/\d+(?:[.,]\d+)*/g) || []).join(' ');
  function bigrams(s) {
    const t = bare(s);
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    if (t.length === 1) out.add(t);
    return out;
  }
  /** 두 문장의 겹침 정도 0~1 (숫자가 다르면 0) */
  function similarity(a, b) {
    if (numbersOf(a) !== numbersOf(b)) return 0;
    const x = bigrams(a);
    const y = bigrams(b);
    if (!x.size || !y.size) return 0;
    let both = 0;
    for (const g of x) if (y.has(g)) both++;
    return (2 * both) / (x.size + y.size);
  }

  /**
   * 기준 답변(base)과 비교해 text를 조각으로 나눈다 → [{ text, changed }]
   * changed: 기준 답변에 없는 새 내용의 문장. 공백·줄바꿈 차이는 같은 것으로 보고,
   * 표현만 조금 다른 문장(기준 답변의 어느 문장과 겹침 SIMILAR_MIN 이상, 숫자 같음)도 새 내용으로 보지 않는다. (jsdiff diffArrays)
   */
  function diffMarks(base, text) {
    const a = String(base || '');
    const b = String(text || '');
    if (!b) return [];
    if (!a) return [{ text: b, changed: true }];
    const out = [];
    const baseSentences = sentences(a).filter((s) => /\S/.test(s));
    const isSimilar = (piece) => baseSentences.some((s) => similarity(s, piece) >= SIMILAR_MIN);
    const parts = Diff.diffArrays(sentences(a), sentences(b), { comparator: (x, y) => key(x) === key(y) });
    for (const part of parts) {
      if (part.removed) continue;
      for (const piece of part.value) {
        const changed = !!part.added && /\S/.test(piece) && !isSimilar(piece);
        const last = out[out.length - 1];
        if (last && last.changed === changed) last.text += piece;
        else out.push({ text: piece, changed });
      }
    }
    return out;
  }

  /** 다른 문장 비율 (0~1): 머리줄에 "기준과 다름 32%"처럼 보여 준다 */
  function changedRatio(marks) {
    const total = marks.reduce((n, m) => n + m.text.length, 0);
    return total ? marks.filter((m) => m.changed).reduce((n, m) => n + m.text.length, 0) / total : 0;
  }

  // ---------- 이견 → 관련 문단 (v0.26.0) ----------
  // 이견 표에서 AI 이름을 누르면 그 AI 답변 중 쟁점과 가장 관련 있는 문단을 강조한다.
  // 점수는 단순하게: 쟁점 글과 문단이 같이 쓴 낱말 수 (한국어 조사는 떼고 비교, 두 글자 이상 낱말만).
  const PARTICLE_RE = /(으로|에서|에게|까지|부터|보다|처럼|이나|이며|이고|은|는|이|가|을|를|의|에|로|와|과|도|만)$/;
  const STOP = new Set(['그리고', '하지만', '그러나', '또는', '있다', '없다', '있습니다', '없습니다', '합니다', 'the', 'and', 'for', 'with', 'that', 'this', 'are', 'is']);

  /** 글 → 비교용 낱말 집합 (소문자, 조사 뗌, 두 글자 이상, 흔한 말 뺌) */
  function tokens(text) {
    const out = new Set();
    for (const raw of String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
      const w = /[가-힣]$/.test(raw) && raw.length > 2 ? raw.replace(PARTICLE_RE, '') : raw;
      if (w.length >= 2 && !STOP.has(w)) out.add(w);
    }
    return out;
  }

  /** s[start, end)를 splitter로 나눈 조각들 → [{ start, end, text }] */
  function pieces(s, start, end, splitter) {
    const out = [];
    const part = s.slice(start, end);
    let at = 0;
    for (const m of part.matchAll(splitter)) {
      if (m.index > at) out.push({ start: start + at, end: start + m.index, text: part.slice(at, m.index) });
      at = m.index + m[0].length;
    }
    if (at < part.length) out.push({ start: start + at, end, text: part.slice(at) });
    return out;
  }
  const ROW_RE = /^\s*(\||[-*•]\s|\d+[.)]\s)/; // 표 줄 · 목록 줄

  /**
   * 답변을 문단으로 나눈다 → [{ start, end, text }] (빈 줄마다, 빈 줄이 없으면 줄마다). start · end는 글 안의 위치.
   * 표 · 목록 덩어리는 줄마다 나눈다 (표 전체가 아니라 그 쟁점의 줄만 강조하려고)
   */
  function paragraphs(text) {
    const s = String(text || '');
    const blocks = pieces(s, 0, s.length, /\n[ \t]*\n/.test(s) ? /\n[ \t]*\n+/g : /\n+/g);
    const out = [];
    for (const b of blocks) {
      const lines = b.text.split('\n');
      if (lines.length > 1 && lines.every((l) => !l.trim() || ROW_RE.test(l))) out.push(...pieces(s, b.start, b.end, /\n+/g));
      else out.push(b);
    }
    return out.filter((p) => /\S/.test(p.text));
  }

  /**
   * 쟁점(query)과 관련 있는 문단 → [{ start, end, text, score }] (점수 높은 순, 최대 max개, 겹치는 낱말이 min개 이상만)
   * score = 겹친 낱말 수 (짧은 문단이 유리하지 않게 문단 낱말 수로 나누지 않는다)
   */
  function relatedParagraphs(query, text, { max = 2, min = 1 } = {}) {
    const q = tokens(query);
    if (!q.size) return [];
    return paragraphs(text)
      .map((p, i) => {
        let score = 0;
        for (const w of tokens(p.text)) if (q.has(w)) score++;
        return { ...p, score, i };
      })
      .filter((p) => p.score >= min)
      .sort((x, y) => y.score - x.score || x.i - y.i)
      .slice(0, max)
      .map(({ i, ...p }) => p);
  }

  // ---------- 다시 분석 비교 (v0.26.0) ----------
  const SAME_TOPIC = 0.5; // 쟁점 글이 이만큼 비슷하면(글자 bigram Dice 또는 낱말 겹침) 같은 쟁점으로 본다
  function topicSimilarity(a, b) {
    const x = tokens(a);
    const y = tokens(b);
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    const words = x.size && y.size ? (2 * both) / (x.size + y.size) : 0;
    const chars = similarity(String(a).replace(/\d+/g, ''), String(b).replace(/\d+/g, ''));
    return Math.max(words, chars);
  }

  /**
   * 두 분석 결과(parseAnalysis의 ok 결과)의 이견 쟁점 비교 → { onlyA: [index], onlyB: [index], same: [[ia, ib]] }
   * 한쪽에만 있는 쟁점을 화면이 강조한다.
   */
  function compareAnalyses(a, b) {
    const A = a && a.ok ? a.disagreements : [];
    const B = b && b.ok ? b.disagreements : [];
    const usedB = new Set();
    const same = [];
    A.forEach((d, ia) => {
      let best = -1;
      let bestScore = SAME_TOPIC;
      B.forEach((e, ib) => {
        if (usedB.has(ib)) return;
        const s = topicSimilarity(d.topic, e.topic);
        if (s >= bestScore) {
          best = ib;
          bestScore = s;
        }
      });
      if (best >= 0) {
        usedB.add(best);
        same.push([ia, best]);
      }
    });
    const inA = new Set(same.map(([ia]) => ia));
    return { onlyA: A.map((_, i) => i).filter((i) => !inA.has(i)), onlyB: B.map((_, i) => i).filter((i) => !usedB.has(i)), same };
  }

  return { SECTIONS, sectionOf, parseAnalysis, sentences, similarity, diffMarks, changedRatio, tokens, paragraphs, relatedParagraphs, compareAnalyses };
});
