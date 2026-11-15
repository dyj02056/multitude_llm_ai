'use strict';

// 프로젝트 모드 — 섞어서 적용 (v0.28.0): 여러 AI가 같은 파일을 고쳤을 때 파일마다 어느 AI의 것을 쓸지 골라 한 번에 적용한다.
// 변경 제안 화면의 [섞어서 적용] → 창에 경로마다 한 줄, AI마다 칸(고르기 단추). 한 경로에는 한 AI만 고를 수 있다.
// 적용은 project-changes.js의 applyPlans 한 묶음(하나라도 실패하면 모두 되돌림 · 적용 기록 하나 · 되돌리기)으로 한다.
// 고르기 계산은 shared/mix-select.js. project-changes.js 다음에 읽힌다.
//
// [쉽게 말하면] "a.js는 Claude 답, b.js는 ChatGPT 답"처럼 골라서 내 파일에 쓰는 창입니다.
(() => {
  const P = MLA.projectUI;
  const MX = MLA.mixSelect;
  const PX = MLA.patch;

  function openMix(plansByAi) {
    const { project, modal, OP_TEXT } = P;
    const rows = MX.buildRows(plansByAi, { quickOf: P.isQuick, riskOf: (plan) => PX.executionRisk(plan.path, plan.before, plan.after) });
    if (!rows.length) return;
    let picks = MX.defaultPicks(rows);
    const ais = plansByAi.filter((ai) => rows.some((r) => r.options.some((o) => o.aiId === ai.id)));
    modal.show(t('mix.title'), t('mix.note', { name: project.info.name, n: rows.length, shared: MX.sharedCount(rows) }));

    const table = document.createElement('table');
    table.className = 'mix-table';
    const head = document.createElement('tr');
    head.append(Object.assign(document.createElement('th'), { textContent: t('mix.colPath') }));
    for (const ai of ais) {
      const th = document.createElement('th');
      th.style.setProperty('--svc', ai.color || 'var(--border)');
      const all = button(t('mix.allFrom', { name: ai.name }), t('mix.allFromTitle', { name: ai.name }), () => {
        picks = MX.pickAllFrom(picks, rows, ai.id);
        sync();
      });
      all.className = 'mix-all';
      th.append(all);
      head.append(th);
    }
    head.append(Object.assign(document.createElement('th'), { textContent: t('mix.none') }));
    table.append(head);

    const radios = []; // { path, aiId, input }
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.options.length > 1) tr.className = 'mix-shared';
      const pathCell = document.createElement('td');
      pathCell.className = 'mix-path';
      pathCell.append(span('path', r.path));
      if (r.options.length > 1) pathCell.append(span('op hunks', t('mix.sharedTag', { n: r.options.length })));
      tr.append(pathCell);
      const name = `mix-${Math.random().toString(36).slice(2)}`;
      for (const ai of ais) {
        const td = document.createElement('td');
        const o = r.options.find((x) => x.aiId === ai.id);
        if (o) {
          const label = document.createElement('label');
          label.className = 'mix-opt';
          const input = Object.assign(document.createElement('input'), { type: 'radio', name });
          input.addEventListener('change', () => {
            picks = MX.setPick(picks, rows, r.path, ai.id);
            sync();
          });
          radios.push({ path: r.path, aiId: ai.id, input });
          label.append(input, span(`op ${o.op}`, OP_TEXT[o.op]), span('add', `+${o.add}`), span('del', `−${o.del}`));
          if (o.risk) label.append(Object.assign(span('op bad', t('mix.risk')), { title: o.risk }));
          if (o.suspect) label.append(Object.assign(span('op bad', t('mix.suspect')), { title: o.suspect }));
          td.append(label);
        } else td.append(span('muted-label', '—'));
        tr.append(td);
      }
      const td = document.createElement('td');
      const none = Object.assign(document.createElement('input'), { type: 'radio', name, title: t('mix.none') });
      none.addEventListener('change', () => {
        picks = MX.setPick(picks, rows, r.path, null);
        sync();
      });
      radios.push({ path: r.path, aiId: null, input: none });
      td.append(none);
      tr.append(td);
      table.append(tr);
    }
    const warn = span('mix-warn', '');
    $('#patchBody').replaceChildren(table, warn);

    function sync() {
      for (const x of radios) x.input.checked = (picks.get(x.path) ?? null) === x.aiId;
      const s = MX.summarize(rows, picks);
      const names = s.ais.map((id) => ais.find((a) => a.id === id)?.name || id);
      warn.textContent = s.mixed ? `⚠ ${t('mix.mixedWarn', { names: names.join(' · ') })}` : '';
      $('#patchStatus').textContent = s.chosen.length ? t('mix.status', { n: s.chosen.length, risky: s.risky.length }) : t('mix.pickSome');
      $('#patchApply').disabled = !s.chosen.length;
    }

    /** 고른 것 → 적용할 plan 목록과 출처 Map(plan → AI) */
    const chosen = () => {
      const items = MX.chosenItems(plansByAi, rows, picks);
      return { plans: items.map((x) => x.item.plan), sources: new Map(items.map((x) => [x.item.plan, x.ai])), items };
    };

    $('#patchAll').hidden = true;
    $('#patchApply').hidden = false;
    $('#patchApply').textContent = t('mix.apply');
    $('#patchApply').onclick = async () => {
      const { plans, sources, items } = chosen();
      if (!plans.length) return;
      const names = [...new Set(items.map((x) => x.ai.name))];
      const risky = MX.summarize(rows, picks).risky;
      if (risky.length && !confirm(t('mix.riskyConfirm', { files: risky.join('\n') }))) return;
      $('#patchApply').disabled = true;
      try {
        const ai = { id: names.length === 1 ? items[0].ai.id : null, name: names.join(' + '), color: null, plans: [], mixed: names.length > 1 };
        const { entry, text } = await P.applyPlans(ai, plans, { sources });
        P.afterApplied(entry, text);
      } finally {
        $('#patchApply').disabled = false;
      }
    };
    P.setupTestRun(() => chosen().plans);
    sync();
  }

  $('#changesMix').addEventListener('click', () => openMix(P.plansByAi()));

  Object.assign(P, { openMix });
})();
