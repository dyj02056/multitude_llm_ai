// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/compare-modes.js)
// 답변 비교의 보기 방식 계산 (v0.32.0): 문단 맞추기 · 코드만 보기 · 표 비교.
// 화면(DOM)을 모르는 순수 계산이라 단위 테스트로 확인한다. 그리는 일은 renderer/compare-modes.js.
// 문단 나누기 · 낱말 쪼개기는 shared/analysis.js(paragraphs · tokens · similarity)의 것을 그대로 쓴다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.compareModes)이 같이 쓴다.
//
// [쉽게 말하면] 답변 비교 화면에서 AI들의 답을 "같은 내용끼리 같은 줄에" 놓아 보여 주고, 코드 블록만 모아 보여 주고,
// 표로 답한 것은 항목(첫 칸)별로 칸 단위로 맞춰 어디가 다른지 알려 주기 위한 계산입니다.
// 뜻을 아는 것이 아니라 낱말 · 글자의 겹침으로 "비슷한 것"을 어림으로 짝지으므로, 안 맞는 짝이 생길 수 있습니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./analysis') : root.MLA.analysis);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).compareModes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AN) {
  'use strict';

  const MODES = ['columns', 'align', 'code', 'table'];
  const normalizeMode = (m) => (MODES.includes(m) ? m : 'columns');

  // ---------- 비슷한 정도 ----------
  const ALIGN_MIN = 0.3; // 문단이 이만큼 겹치면 같은 내용으로 짝짓는다
  const KEY_MIN = 0.5; // 표의 첫 칸(항목 이름)이 이만큼 겹치면 같은 항목
  const CELL_SAME = 0.5; // 표의 칸 값이 이만큼 겹치면 같은 값 (숫자가 다르면 다름)

  const bare = (s) => String(s || '').toLowerCase().replace(/[\s.,!?。·:;'"`()[\]{}<>*_#|~\-–—→/\\]+/g, '');
  const grams = (s) => {
    const t = bare(s);
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    if (t.length === 1) out.add(t);
    return out;
  };
  const dice = (x, y) => {
    if (!x.size || !y.size) return 0;
    let both = 0;
    for (const g of x) if (y.has(g)) both++;
    return (2 * both) / (x.size + y.size);
  };
  /** 두 문단의 겹침 0~1: 낱말 겹침과 글자 두 개씩 겹침 중 큰 값 (숫자 차이는 보지 않는다 — 문단은 숫자가 달라도 같은 이야기일 수 있음) */
  function paragraphSimilarity(a, b) {
    return Math.max(dice(AN.tokens(a), AN.tokens(b)), dice(grams(a), grams(b)));
  }

  // ---------- 문단 맞추기 ----------
  /**
   * 맞추기용 문단 글 다듬기: 표의 줄 `| a | b |`은 "a · b"로, 구분 줄 `|---|---|`은 버린다 (칸마다 파이프 글자가 그대로 보이지 않게).
   * 답변의 글을 바꾸는 것이 아니라 이 보기에서 보이는 모양만 바꾼다.
   */
  function tidyParagraph(text) {
    const s = String(text || '').trim();
    if (!/^\|.*\|$/.test(s)) return s;
    const cells = s.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return '';
    return cells.filter(Boolean).join(' · ');
  }

  /**
   * 기준 답변의 문단마다 한 줄, 다른 답변의 비슷한 문단을 같은 줄에 놓는다.
   * items: [{ id, text }] (칸 순서), baseId: 기준 답변(글이 있어야 함, 아니면 글이 있는 첫 답변)
   * → { baseId, ids, rows: [{ cells: { [id]: { text, sim } | null }, only: id | null }] }
   *   sim: 기준 문단과의 겹침(기준 칸은 1), only: 이 줄이 한 AI에게만 있으면 그 id (기준에 짝이 없는 문단)
   * 짝은 겹침이 큰 것부터 하나씩만 맺는다 (한 문단이 여러 줄에 들어가지 않음). 짝이 없는 문단은 그 AI의 앞 문단이 있는 줄 바로 뒤에 새 줄로 둔다.
   */
  function alignParagraphs(items, baseId) {
    const list = (items || []).map((it) => ({ id: it.id, paras: AN.paragraphs(it.text || '').map((p) => tidyParagraph(p.text)).filter(Boolean) }));
    const base = list.find((x) => x.id === baseId && x.paras.length) || list.find((x) => x.paras.length);
    const ids = list.map((x) => x.id);
    if (!base) return { baseId: null, ids, rows: [] };
    const rows = base.paras.map((text) => ({ cells: { [base.id]: { text, sim: 1 } }, only: null }));
    const baseRows = rows.slice(); // 줄을 끼워 넣어도 기준 문단의 줄을 번호로 찾을 수 있게 따로 둔다
    for (const ai of list) {
      if (ai === base) continue;
      // 겹침이 큰 짝부터 맺는다
      const pairs = [];
      base.paras.forEach((bp, i) => ai.paras.forEach((p, j) => pairs.push({ i, j, s: paragraphSimilarity(bp, p) })));
      pairs.sort((a, b) => b.s - a.s);
      const rowOf = new Map(); // ai 문단 번호 → 기준 줄 번호
      const taken = new Set();
      for (const p of pairs) {
        if (p.s < ALIGN_MIN) break;
        if (taken.has(p.i) || rowOf.has(p.j)) continue;
        taken.add(p.i);
        rowOf.set(p.j, { i: p.i, s: p.s });
      }
      let last = null; // 앞 문단을 놓은 줄
      ai.paras.forEach((text, j) => {
        const hit = rowOf.get(j);
        if (hit) {
          baseRows[hit.i].cells[ai.id] = { text, sim: hit.s };
          last = baseRows[hit.i];
          return;
        }
        const row = { cells: { [ai.id]: { text, sim: 0 } }, only: ai.id };
        let at = last ? rows.indexOf(last) + 1 : 0;
        while (rows[at] && rows[at].only && rows[at].only !== ai.id) at++; // 다른 AI가 먼저 끼워 둔 줄은 건너뛴다
        rows.splice(at, 0, row);
        last = row;
      });
    }
    for (const row of rows) for (const id of ids) if (!(id in row.cells)) row.cells[id] = null;
    return { baseId: base.id, ids, rows };
  }

  // ---------- 코드만 ----------
  /** 글 → 코드 블록들 [{ lang, code }] (울타리는 ``` 또는 ~~~ 세 개 이상, 닫는 울타리가 없으면 끝까지) */
  function extractCode(text) {
    const out = [];
    let open = null;
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
      const f = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (!open) {
        if (f) open = { ch: f[1][0], n: f[1].length, lang: f[2] || '', body: [] };
      } else if (f && f[1][0] === open.ch && f[1].length >= open.n && !line.replace(/^\s*(`{3,}|~{3,})/, '').trim()) {
        out.push({ lang: open.lang, code: open.body.join('\n') });
        open = null;
      } else open.body.push(line);
    }
    if (open) out.push({ lang: open.lang, code: open.body.join('\n') });
    return out;
  }

  /** 코드 한 덩어리를 줄로 나눠, 기준 코드에 없는 줄에 표시한다 → [{ text, changed }] (빈 줄은 changed가 아님) */
  function markCodeLines(baseCode, code) {
    const have = new Set(String(baseCode || '').split('\n').map((l) => l.trim()).filter(Boolean));
    return String(code || '')
      .split('\n')
      .map((text) => ({ text, changed: text.trim() !== '' && !have.has(text.trim()) }));
  }

  // ---------- 표 비교 ----------
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const splitRow = (l) =>
    l
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  const isSep = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

  /** 글 → 마크다운 표들 [{ header: [칸], rows: [[칸]] }] (코드 블록 안은 건너뜀. 구분 줄이 있는 표만) */
  function tablesOf(text) {
    const out = [];
    let fence = null;
    let block = [];
    const flush = () => {
      if (block.length >= 2) {
        const rows = block.map(splitRow);
        if (isSep(rows[1])) {
          const body = rows.slice(2).filter((r) => r.some(Boolean));
          if (body.length) out.push({ header: rows[0], rows: body });
        }
      }
      block = [];
    };
    for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        flush();
        continue;
      }
      if (fence) continue;
      if (isRow(line)) block.push(line);
      else flush();
    }
    flush();
    return out;
  }

  const stripMd = (s) => String(s || '').replace(/[*_`]/g, '').trim();
  const keySame = (a, b) => {
    const x = bare(a);
    const y = bare(b);
    return !!x && !!y && (x === y || Math.max(dice(grams(a), grams(b)), dice(AN.tokens(a), AN.tokens(b))) >= KEY_MIN);
  };
  const valueText = (cell) => cell.values.map(stripMd).join(' ');

  /**
   * 표로 답한 것을 항목(첫 칸)별로 맞춘다. items: [{ id, text }] (답변 글 — 표가 마크다운이어야 하므로 md가 있으면 md를 넘긴다)
   * AI마다 행이 가장 많은 표 하나를 쓴다.
   * → { ids, withTable: [id], noTable: [id], rows: [{ key, cells: { [id]: { header: [칸 이름], values: [칸] } | null }, differs, missing: [id] }] }
   *   differs: 표가 있는 AI들의 값이 서로 비슷하지 않음(숫자가 다르면 다름), missing: 표는 있는데 이 항목이 없는 AI
   */
  function compareTables(items) {
    const ids = (items || []).map((it) => it.id);
    const picked = [];
    for (const it of items || []) {
      const ts = tablesOf(it.text || '');
      if (ts.length) picked.push({ id: it.id, table: ts.reduce((best, t) => (t.rows.length > best.rows.length ? t : best)) });
    }
    const rows = [];
    for (const { id, table } of picked) {
      const used = new Set();
      for (const r of table.rows) {
        const key = stripMd(r[0]);
        let row = rows.find((x) => !used.has(x) && keySame(x.key, key));
        if (!row) {
          row = { key, cells: {}, differs: false, missing: [] };
          rows.push(row);
        }
        used.add(row);
        row.cells[id] = { header: table.header.slice(1).map(stripMd), values: r.slice(1) };
      }
    }
    const withTable = picked.map((p) => p.id);
    for (const row of rows) {
      for (const id of ids) if (!(id in row.cells)) row.cells[id] = null;
      row.missing = withTable.filter((id) => !row.cells[id]);
      const have = withTable.filter((id) => row.cells[id]).map((id) => valueText(row.cells[id]));
      row.differs = have.some((a, i) => have.slice(i + 1).some((b) => AN.positionSimilarity(a, b) < CELL_SAME));
    }
    return { ids, withTable, noTable: ids.filter((id) => !withTable.includes(id)), rows };
  }

  return { MODES, normalizeMode, paragraphSimilarity, tidyParagraph, alignParagraphs, extractCode, markCodeLines, tablesOf, compareTables, ALIGN_MIN, KEY_MIN, CELL_SAME };
});
