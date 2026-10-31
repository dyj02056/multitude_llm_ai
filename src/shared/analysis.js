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
  const SECTIONS = { common: '공통 의견', disagree: '이견', unsupported: '근거 부족', final: '최종 답변' };
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
    for (const [key, name] of Object.entries(SECTIONS)) if (t === name || t.replace(/ /g, '') === name.replace(/ /g, '')) return key;
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
  const norm = (s) => String(s || '').toLowerCase().replace(/\(당신\)|\(나\)|\*|_|`/g, '').replace(/\s+/g, '');

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
    if (!text.trim()) return { ok: false, raw: text, reason: '답변이 비어 있습니다' };
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
      return { ok: false, raw: text, reason: `"${!parts.disagree ? SECTIONS.disagree : SECTIONS.final}" 머리글을 찾지 못했습니다` };
    }
    const final = parts.final.join('\n').trim();
    if (!final) return { ok: false, raw: text, reason: '최종 답변이 비어 있습니다' };
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

  return { SECTIONS, sectionOf, parseAnalysis, sentences, similarity, diffMarks, changedRatio };
});
