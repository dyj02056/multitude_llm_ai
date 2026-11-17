'use strict';

// 답변 비교 › 사실 확인 탭 (v0.33.0) — Windows 앱과 크롬 확장이 똑같이 씀. workflow-ui.js 다음에 읽힌다.
// 위쪽에서 확인할 글(한 AI의 답 또는 분석의 최종 답변) · 주장을 뽑을 AI · 확인할 AI(검색형 권장)를 고르고 [사실 확인 요청].
// 아래에는 가장 최근 결과를 주장마다 확인 · 반박 · 일부 · 출처 없음 표로 보여 준다. 읽기 · 요청 글 · 진행은 shared/factcheck.js.
// 시작 전에 "보낼 횟수"(추출 1번 + 확인 1번)를 보여 준다 — 무료 사용 한도를 가늠하라고.
//
// [쉽게 말하면] "이 답이 말한 사실들이 맞나?"를 AI가 검색해서 확인한 결과를 표로 보여 주는 탭입니다. AI가 확인한 것이라 보증은 아니라고 알립니다.

(() => {
  const FC = MLA.factcheck;
  let running = false;
  let pick = { source: null, extractor: null, checker: null }; // 고른 것 (화면을 다시 그려도 유지)

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
  const nameOf = (id) => state?.services.find((s) => s.id === id)?.name || id;

  /** 이번 질문의 최신 사실 확인 결과 (없으면 null) */
  const latest = () => (compareView.factchecks || []).at(-1) || null;

  function select(id, label, choices, value) {
    const wrap = el('label', 'fact-field');
    wrap.append(el('span', 'muted-label', label));
    const s = el('select');
    s.id = id;
    s.append(...choices.map((c) => option(c.id, c.name)));
    if (choices.some((c) => c.id === value)) s.value = value;
    wrap.append(s);
    return [wrap, s];
  }

  function controls() {
    const answered = (compareView.answers || []).filter((a) => a.text);
    const sources = [...(compareView.analysis ? [{ id: 'analysis', name: t('fact.sourceAnalysis') }] : []), ...answered.map((a) => ({ id: a.id, name: t('fact.sourceAnswer', { name: a.name }) }))];
    const judges = judgeChoices();
    const open = (state?.rects || []).map((r) => r.id);
    const search = FC.SEARCH_IDS.find((id) => open.includes(id));
    const bar = el('div', 'fact-bar');
    const [fSrc, sSrc] = select('factSource', t('fact.source'), sources, pick.source || sources[0]?.id);
    const [fEx, sEx] = select('factExtractor', t('fact.extractor'), judges, pick.extractor || state?.synthTarget);
    const [fCk, sCk] = select('factChecker', t('fact.checker'), open.map((id) => ({ id, name: nameOf(id) + (FC.SEARCH_IDS.includes(id) ? ` ${t('fact.searchTag')}` : '') })), pick.checker || search || open[0]);
    const run = el('button', 'primary', t('fact.run'));
    run.id = 'factRun';
    const stop = el('button', 'danger', t('fact.stop'));
    stop.hidden = !running;
    run.hidden = running;
    const count = el('span', 'muted small fact-count');
    const sync = () => {
      pick = { source: sSrc.value, extractor: sEx.value, checker: sCk.value };
      const c = FC.countSends(pick);
      const detail = Object.entries(c.byWho).map(([id, n]) => `${id === 'local' && !open.includes('local') ? t('local.judgeHeadless') : nameOf(id)} ${n}`).join(' · ');
      count.textContent = t('fact.count', { total: c.total, detail });
      run.disabled = running || !sources.length || !sEx.value || !sCk.value;
    };
    for (const s of [sSrc, sEx, sCk]) s.addEventListener('change', sync);
    sync();
    run.addEventListener('click', async () => {
      run.disabled = true;
      const r = await host.factcheck.start(pick).catch((err) => ({ ok: false, error: err.message }));
      if (!r?.ok) $('#sendHint').textContent = r?.error || t('fact.errStart');
      sync();
    });
    stop.addEventListener('click', async () => {
      const r = await host.factcheck.stop().catch(() => null);
      if (!r?.ok) $('#sendHint').textContent = r?.error || t('fact.errStop');
    });
    bar.append(fSrc, fEx, fCk, run, stop, count);
    return [bar, el('p', 'muted small fact-note', t('fact.limitNote'))];
  }

  function resultBlock(entry) {
    const items = FC.parseVerdicts(entry.md || entry.text || '', entry.claims || []);
    const sum = FC.summarize(items);
    const wrap = el('div', 'fact-result');
    wrap.append(el('p', 'fact-meta muted-label', t('fact.meta', { checker: entry.judge, extractor: entry.extractor || '?', source: (entry.names || [])[0] || '?', time: fmtTime(entry.at) })));
    const chips = el('div', 'fact-sum');
    for (const v of FC.VERDICTS) if (sum[v]) chips.append(el('span', `fact-chip ${v}`, `${t(`fact.verdict.${v}`)} ${sum[v]}`));
    wrap.append(chips);
    if (sum.unknown) wrap.append(el('p', 'muted small', t('fact.unreadable', { n: sum.unknown })));
    const table = el('table', 'fact-table an-table');
    const head = el('tr');
    for (const k of ['n', 'claim', 'verdict', 'evidence']) head.append(el('th', '', t(`fact.col.${k}`)));
    const thead = el('thead');
    thead.append(head);
    const body = el('tbody');
    for (const it of items) {
      const row = el('tr', `fact-row ${it.verdict}`);
      row.append(el('td', 'fact-n', String(it.n)), el('td', 'fact-claim', it.claim), el('td', `fact-verdict ${it.verdict}`, t(`fact.verdict.${it.verdict}`)));
      const ev = el('td', 'fact-evidence', it.evidence || '—');
      for (const u of it.links.slice(0, 3)) {
        const copy = button(t('ui.copy'), t('fact.copyLink', { url: u }), async (e) => {
          await host.copyText(u); // 앱 안에서는 링크를 열지 않고 복사만 한다
          flash(e.target, t('ui.copied'));
        });
        ev.append(' ', copy);
      }
      row.append(ev);
      body.append(row);
    }
    table.append(thead, body);
    const scroller = el('div', 'an-table-wrap');
    scroller.append(table);
    wrap.append(scroller, el('p', 'muted small fact-disclaimer', t('fact.disclaimer')));
    return wrap;
  }

  /** 사실 확인 탭을 그린다 (renderer-views.js renderCompare가 부름) */
  window.renderCompareFact = () => {
    const box = $('#factView');
    const entry = latest();
    const tab = document.querySelector('#compareTabs [data-ctab="fact"]');
    if (tab) tab.textContent = entry ? t('fact.tabCount', { n: (compareView.factchecks || []).length }) : t('fact.tab');
    const kids = [...controls()];
    kids.push(entry ? resultBlock(entry) : el('div', 'analysis-empty', t('fact.empty')));
    if (compareView.factError) kids.unshift(el('p', 'analysis-note', compareView.factError));
    if (compareView.factPending) kids.unshift(el('p', 'analysis-note pending', compareView.factPending));
    box.replaceChildren(...kids);
  };

  host.on('synth:status', (p) => {
    if (p.mode !== 'factcheck') return;
    running = p.state === 'extracting' || p.state === 'checking';
    compareView.factPending = p.state === 'extracting' ? t('fact.statusExtract', { who: p.who }) : p.state === 'checking' ? t('fact.statusCheck', { who: p.who, claims: p.claims }) : null;
    compareView.factError = p.state === 'error' ? t('fact.statusError', { error: p.error || '' }) : null;
    $('#sendHint').textContent = compareView.factPending || (p.state === 'done' ? t('fact.statusDone', { who: p.who, claims: p.claims }) : p.state === 'stopped' ? t('fact.statusStopped') : compareView.factError || '');
    if (state?.chatView === 'compare') {
      if (p.state === 'done') renderCompare(); // 끝나면 결과를 바로 그린다
      else window.renderCompareFact();
    }
  });
})();
