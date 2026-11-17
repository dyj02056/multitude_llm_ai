'use strict';

// 답변 비교 — 보기 방식 (v0.32.0): 문단 맞추기 · 코드만 · 표 비교. Windows 앱과 크롬 확장이 똑같이 씀. chain-views.js 다음에 읽힌다.
// 계산은 shared/compare-modes.js. 여기서는 그 결과를 답변 탭의 #compareCols 안에 그린다 (renderer-views.js renderCompareAnswers가 부름).
// 기본("나란히")은 예전 그대로 칸마다 답변 전체를 보여 주고, 다른 방식은 같은 답변 글을 다르게 나눠 보여 줄 뿐 글을 바꾸지 않는다.
//
// [쉽게 말하면] 비교 화면 위쪽의 "보기" 고르기: 같은 내용끼리 같은 줄에 맞춰 보기, 코드 블록만 보기, 표로 답한 것을 칸 단위로 보기입니다.

(() => {
  const CM = MLA.compareModes;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const head = (a, extra) => {
    const h = el('div', 'cmp-head');
    h.style.setProperty('--svc', a.color || 'var(--border)');
    h.append(el('span', 'dot ready'), el('span', 'name', a.name));
    if (extra) h.append(el('span', 'muted-label', extra));
    return h;
  };
  const grid = (n, first) => {
    const g = el('div', 'cmp-grid');
    g.style.gridTemplateColumns = `${first ? 'minmax(90px, .5fr) ' : ''}repeat(${Math.max(n, 1)}, minmax(0, 1fr))`;
    return g;
  };

  // ---------- 문단 맞추기 ----------
  function alignView(answers, baseId) {
    const res = CM.alignParagraphs(answers.map((a) => ({ id: a.id, text: a.text })), baseId);
    const wrap = el('div', 'cmp-wrap');
    if (!res.rows.length) return el('p', 'muted cmp-empty', t('compare.align.empty'));
    const only = res.rows.filter((r) => r.only).length;
    wrap.append(el('p', 'muted small cmp-note', t('compare.align.note', { rows: res.rows.length, only, base: answers.find((a) => a.id === res.baseId)?.name || '' })));
    const g = grid(answers.length);
    g.append(...answers.map((a) => head(a, a.id === res.baseId ? t('ui.compare.baseBadge') : '')));
    for (const row of res.rows) {
      for (const a of answers) {
        const c = row.cells[a.id];
        const cell = el('div', 'cmp-cell');
        if (!c) {
          cell.classList.add('none');
          cell.textContent = a.text ? '—' : '';
        } else {
          cell.textContent = c.text;
          if (a.id === res.baseId) cell.classList.add('base');
          else if (row.only === a.id) {
            cell.classList.add('only');
            cell.title = t('compare.align.onlyTitle', { name: a.name });
          } else if (c.sim < 0.6) {
            cell.classList.add('loose'); // 짝은 맺었지만 겹침이 적다 — 말이 많이 다르다
            cell.title = t('compare.align.looseTitle', { n: Math.round(c.sim * 100) });
          }
        }
        g.append(cell);
      }
    }
    wrap.append(g);
    return wrap;
  }

  // ---------- 코드만 ----------
  function codeView(answers, baseId, diff) {
    const base = answers.find((a) => a.id === baseId);
    const baseCode = base ? CM.extractCode(base.md || base.text).map((b) => b.code).join('\n') : '';
    const wrap = el('div', 'cmp-wrap');
    const g = grid(answers.length);
    g.classList.add('cmp-code-grid');
    let total = 0;
    for (const a of answers) {
      const blocks = CM.extractCode(a.md || a.text || '');
      total += blocks.length;
      const col = el('div', 'cmp-codecol');
      col.append(head(a, a.text ? (blocks.length ? t('compare.code.count', { n: blocks.length }) : '') : t('ui.answerState.noAnswer')));
      if (!blocks.length) col.append(el('p', 'muted small cmp-empty', a.text ? t('compare.code.none') : ''));
      for (const b of blocks) {
        const pre = el('pre', 'cmp-code');
        if (b.lang) pre.dataset.lang = b.lang;
        if (diff && base && a.id !== baseId) {
          for (const l of CM.markCodeLines(baseCode, b.code)) {
            const line = el('span', l.changed ? 'cmp-line new' : 'cmp-line', `${l.text}\n`);
            pre.append(line);
          }
        } else pre.textContent = b.code;
        col.append(pre);
      }
      g.append(col);
    }
    if (!total) return el('p', 'muted cmp-empty', t('compare.code.noneAny'));
    if (diff && base) wrap.append(el('p', 'muted small cmp-note', t('compare.code.diffNote', { name: base.name })));
    wrap.append(g);
    return wrap;
  }

  // ---------- 표 비교 ----------
  function tableView(answers) {
    const res = CM.compareTables(answers.map((a) => ({ id: a.id, text: a.md || a.text || '' })));
    if (!res.withTable.length) return el('p', 'muted cmp-empty', t('compare.table.none'));
    const wrap = el('div', 'cmp-wrap');
    const differ = res.rows.filter((r) => r.differs || r.missing.length).length;
    wrap.append(el('p', 'muted small cmp-note', t('compare.table.note', { rows: res.rows.length, differ })));
    if (res.noTable.length) wrap.append(el('p', 'muted small cmp-note', t('compare.table.noTableFor', { names: res.noTable.map((id) => answers.find((a) => a.id === id)?.name || id).join(', ') })));
    const g = grid(answers.length, true);
    g.append(el('div', 'cmp-head', t('compare.table.item')), ...answers.map((a) => head(a)));
    for (const row of res.rows) {
      const flag = row.differs || row.missing.length;
      const key = el('div', `cmp-cell cmp-key${flag ? ' flag' : ''}`, row.key);
      if (row.differs) key.append(' ', el('span', 'an-agree-badge', t('compare.table.differs')));
      if (row.missing.length) key.append(' ', el('span', 'an-unique-badge', t('compare.table.missing')));
      g.append(key);
      for (const a of answers) {
        const c = row.cells[a.id];
        const cell = el('div', `cmp-cell${!c ? ' none' : row.differs ? ' loose' : ''}`);
        if (!c) cell.textContent = res.withTable.includes(a.id) ? '—' : '';
        else {
          c.values.forEach((v, i) => {
            const line = el('div', 'cmp-tline');
            if (c.header[i] && c.header.length > 1) line.append(el('span', 'cmp-th', `${c.header[i]}: `));
            line.append(document.createTextNode(String(v).replace(/[*`]/g, '')));
            cell.append(line);
          });
        }
        g.append(cell);
      }
    }
    wrap.append(g);
    return wrap;
  }

  /** 답변 탭의 칸 영역(cols)에 고른 보기 방식으로 그린다. base: 기준 답변 id(차이 강조의 기준과 같음) */
  window.renderCompareMode = (cols, answers, base, diff) => {
    const mode = CM.normalizeMode(compareView.mode);
    cols.classList.toggle('cmp-mode', mode !== 'columns');
    if (mode === 'columns') return false;
    cols.style.gridTemplateColumns = '1fr';
    const view = mode === 'align' ? alignView(answers, base) : mode === 'code' ? codeView(answers, base, diff) : tableView(answers);
    cols.replaceChildren(view);
    return true;
  };
})();
