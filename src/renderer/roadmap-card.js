'use strict';

// 로드맵 카드 (v0.40.0) — 프로젝트 사이드바 맨 위에 붙는 "지금 할 작업" 카드. roadmap-ui.js 다음에 읽힌다. Windows 앱과 크롬 확장이 똑같이 씀.
// 로드맵 창을 열고 닫지 않아도 같은 화면에서 진행할 수 있게: 진행 링 · 작업 제목 · 상태 · 완료 조건 · 안내 한 줄 · 그때 필요한 버튼만 보인다.
// 데이터는 roadmap-ui.js(MLA.roadmapUI)가 가진 로드맵 하나를 같이 본다 — 창에서 바꾸면 카드가, 카드에서 바꾸면 창이 다시 그려진다.
// 자동으로 바뀌는 것 (계산은 shared/roadmap.js):
//   수정안을 적용하면(project-changes.js → onRoadmapApplied) [구현 요청]으로 시작한 작업이 진행 중 → 검증 중
//   미리보기의 테스트 결과(project-devtest.js → onRoadmapTrial)를 기억해, 통과면 "완료로 바꿀까요?" (설정을 켜면 바로 완료)
//   고쳐 받기를 다 쓰고도 실패하면 막힘을 권한다. 완료하면 잠금이 풀린 다음 작업을 카드에 올린다.
// 보내기 · 적용은 언제나 사람이 누른다 (자동 적용 없음). 입력창은 [구현 요청]을 눌렀을 때만 채운다.
//
// [쉽게 말하면] 로드맵 창을 매번 열지 않아도, 옆에서 "지금 할 일"과 다음에 누를 버튼을 알려 주는 작은 카드입니다.

(() => {
  const RM = MLA.roadmap;
  const CH = MLA.roadmapCharts;
  const UI = MLA.roadmapUI;
  const P = MLA.projectUI;
  const FOLD_KEY = 'mla-rm-card-fold';

  let pick = ''; // [다음 ›]으로 고른 대기 작업
  let trial = null; // 이 작업의 마지막 검사 결과 { task, verdict, pass, fail, exhausted }
  let testing = false; // 카드의 [테스트 실행] 중
  let flash = ''; // 잠깐 보여 줄 한 줄 (완료 알림 · 오류) — 다음 동작까지
  let projKey = null;
  let folded = false;
  try {
    folded = localStorage.getItem(FOLD_KEY) === '1';
  } catch {}

  const lang = () => MLA.i18n.getLang();
  const canTest = () => !!host.devtest?.run;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /** 작은 진행 링 (SVG 속성만 — CSP가 style 속성을 막는다) */
  function ring(pct) {
    const r = 15;
    const c = 2 * Math.PI * r;
    const on = Math.max(0, Math.min(1, pct / 100)) * c;
    return `<svg width="38" height="38" viewBox="0 0 38 38" role="img" aria-label="${pct}%"><circle cx="19" cy="19" r="${r}" fill="none" class="rmc-ring-bg" stroke-width="5"/><circle cx="19" cy="19" r="${r}" fill="none" class="rmc-ring-on" stroke-width="5" stroke-dasharray="${on.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 19 19)"/><text x="19" y="22.5" text-anchor="middle" class="rmc-ring-text">${pct}%</text></svg>`;
  }

  const acceptLines = (s) =>
    String(s || '')
      .split(/\n+/)
      .map((x) => x.replace(/^\s*[-*•]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 4);

  function noteFor(cs) {
    const tr = cs.trial;
    const n = tr ? tr.pass : 0;
    switch (cs.phase) {
      case 'ready':
        return t('ui.roadmap.card.note.ready');
      case 'doing':
        if (tr?.verdict === 'fail') return t(tr.exhausted ? 'ui.roadmap.card.note.doingExhausted' : 'ui.roadmap.card.note.doingFail');
        return t('ui.roadmap.card.note.doing');
      case 'verify':
        return t(canTest() ? 'ui.roadmap.card.note.verify' : 'ui.roadmap.card.note.verifyNoTest');
      case 'verifyPass':
        return n ? t('ui.roadmap.card.note.pass', { n }) : t('ui.roadmap.card.note.passNoCount');
      case 'verifyFail':
        return tr.fail ? t('ui.roadmap.card.note.fail', { n: tr.fail }) : t('ui.roadmap.card.note.failNoCount');
      case 'blocked':
        return cs.task.note ? t('ui.roadmap.card.note.blocked', { note: cs.task.note }) : t('ui.roadmap.card.note.blockedNoNote');
      default:
        return '';
    }
  }

  function actionButton(name, cs) {
    const label = name === 'done' && cs.phase === 'verifyPass' ? t('ui.roadmap.card.act.donePass') : t(`ui.roadmap.card.act.${name}`);
    const b = button(label, t(`ui.roadmap.card.act.${name}Title`), () => act(name, cs.task.id));
    b.dataset.act = name;
    // 그 단계에서 먼저 누를 것 하나만 강조
    const primary = { ready: 'implement', verifyPass: 'done', verify: canTest() ? 'test' : 'done' }[cs.phase];
    if (name === primary || (cs.phase === 'doing' && cs.trial?.exhausted && name === 'block')) b.classList.add('primary');
    if (name === 'test' && testing) b.disabled = true;
    return b;
  }

  function render() {
    const card = $('#rmCard');
    if (!card) return;
    if (!(P && P.has && P.has())) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const rm = UI.get();
    const acts = $('#rmcActs');
    // 로드맵이 없으면 한 줄만: "로드맵 없음 [로드맵 만들기]" (로드맵을 안 쓰는 사람의 파일 나무 자리를 지킨다)
    card.classList.toggle('empty', !rm);
    $('#rmcCreate').hidden = !!rm;
    $('#rmcFold').hidden = !rm;
    if (!rm) {
      $('#rmcBody').hidden = true;
      $('#rmcRing').innerHTML = '';
      $('#rmcMeta').textContent = '';
      $('#rmcTitle').textContent = t('ui.roadmap.card.empty');
      $('#rmcTitle').title = t('ui.roadmap.card.emptyNote');
      return;
    }
    $('#rmcTitle').title = '';
    card.classList.toggle('folded', folded);
    $('#rmcFold').setAttribute('aria-expanded', String(!folded));
    $('#rmcFold').textContent = folded ? '▸' : '▾';
    $('#rmcBody').hidden = folded;
    const cs = RM.cardState(rm, { pick, trial, canTest: canTest() });
    const p = RM.progress(rm);
    $('#rmcRing').innerHTML = ring(p.pct);
    const ms = cs.task ? rm.milestones.find((m) => m.id === cs.task.milestone) : null;
    $('#rmcMeta').textContent = t('ui.roadmap.card.meta', { ms: ms ? ms.title : rm.title, done: p.done, total: p.total });
    if (!cs.task) {
      $('#rmcTitle').textContent = t(cs.phase === 'allDone' ? 'ui.roadmap.card.allDone' : cs.phase === 'none' ? 'ui.roadmap.card.empty' : 'ui.roadmap.card.waiting');
      $('#rmcState').textContent = '';
      $('#rmcState').className = 'rmc-state';
      $('#rmcAccept').replaceChildren();
      $('#rmcNote').textContent = flash;
      acts.replaceChildren();
      renderEnv(null);
      return;
    }
    const tk = cs.task;
    $('#rmcTitle').textContent = `${tk.id} ${tk.title}`;
    $('#rmcState').textContent = `${CH.GLYPH[tk.status]} ${t(`ui.roadmap.status.${tk.status}`)}`;
    $('#rmcState').className = `rmc-state rm-s-${tk.status}`;
    $('#rmcAccept').replaceChildren(...acceptLines(tk.accept).map((line) => el('li', tk.status === 'done' ? 'ok' : '', line)));
    $('#rmcNote').textContent = testing ? t('ui.roadmap.card.note.testing') : flash || noteFor(cs);
    renderEnv(tk);
    acts.replaceChildren(...cs.actions.map((a) => actionButton(a, cs)));
  }

  /** 이 작업이 적은 "필요한 도구" 중 이 PC에 없거나 버전이 안 맞는 것 (v0.42.0, 실행 · 확인 칸의 점검 결과) */
  function renderEnv(tk) {
    const box = $('#rmcEnv');
    if (!box) return;
    const probs = tk && tk.status !== 'done' ? MLA.devHub?.problemsFor?.(tk.tools || []) || [] : [];
    box.hidden = !probs.length;
    if (!probs.length) return box.replaceChildren();
    const list = probs.map((p) => `${p.name} (${t(`dev.env.state.${p.state === 'missing' ? 'missing' : p.state === 'version' ? 'version' : 'notOnPath'}`)})`).join(', ');
    const open = button(t('dev.env.taskOpen'), t('dev.env.moreTitle'), () => MLA.devHub?.openModal?.());
    open.className = 'rmc-env-open';
    box.replaceChildren(el('span', '', t('dev.env.task', { list })), open);
  }

  /** 완료로 바꾸기 → 커밋 해시가 생겼으면 함께 알린다. 다음 작업이 카드에 올라온다 */
  async function markDone(id) {
    const r = await UI.setStatus(id, 'done');
    if (!r?.ok) {
      flash = r?.error || '';
      return render();
    }
    trial = null;
    pick = '';
    const tk = RM.findTask(UI.get(), id);
    flash = tk?.commit ? t('ui.roadmap.card.note.doneCommit', { id, hash: tk.commit.slice(0, 7) }) : t('ui.roadmap.card.note.done', { id });
    render();
  }

  /** 카드의 [테스트 실행]: 지금 파일 그대로 한 번 (test가 없으면 다른 언어 검사 중 첫 것) */
  async function runTest(id) {
    if (testing || !canTest()) return;
    testing = true;
    flash = '';
    render();
    let r;
    try {
      const info = await host.devtest.info().catch(() => null);
      const checks = info?.ok && Array.isArray(info.checks) ? info.checks.map((c) => c.name) : [];
      const pickName = checks.includes('test') ? 'test' : checks[0];
      // 필요한 도구가 이 PC에 없으면 실행하지 않고 바로 알린다 (v0.42.0)
      const block = pickName ? MLA.devHub?.blockReason?.([pickName]) : '';
      if (block) {
        testing = false;
        flash = block;
        return render();
      }
      r = await host.devtest.run(pickName ? [pickName] : undefined);
    } catch (err) {
      r = { ok: false, error: err.message };
    } finally {
      testing = false;
    }
    const info = RM.trialInfo(r);
    if (info.verdict === 'none') {
      flash = r?.cancelled ? '' : t('ui.roadmap.card.note.testError', { msg: r?.error || '' });
      return render();
    }
    trial = { task: id, ...info, exhausted: false };
    const rm = UI.get();
    if (info.verdict === 'pass' && rm?.settings.autoDoneOnPass && RM.findTask(rm, id)?.status === 'verify') return markDone(id);
    render();
  }

  async function act(name, id) {
    flash = '';
    if (name === 'implement') {
      trial = null;
      pick = '';
      UI.implement(id);
    } else if (name === 'skip') pick = RM.nextPick(UI.get(), id);
    else if (name === 'done') return markDone(id);
    else if (name === 'block') {
      const r = await UI.setStatus(id, 'blocked');
      if (r && !r.ok) flash = r.error;
    } else if (name === 'resume') {
      trial = null;
      const r = await UI.setStatus(id, 'doing');
      if (r && !r.ok) flash = r.error;
    } else if (name === 'notYet') trial = trial ? { ...trial, verdict: 'dismissed' } : null;
    else if (name === 'test') return runTest(id);
    render();
  }

  // ---------- 다른 곳에서 오는 신호 ----------
  // 미리보기 창의 테스트 결과 (적용 전): [구현 요청]으로 시작한 작업이 진행 · 검증 중일 때만 기억한다
  window.onRoadmapTrial = (r, { exhausted = false } = {}) => {
    const rm = UI.get();
    const tk = rm?.active ? RM.findTask(rm, rm.active) : null;
    if (!tk || !['doing', 'verify'].includes(tk.status)) return;
    const info = RM.trialInfo(r);
    if (info.verdict === 'none') return;
    trial = { task: tk.id, ...info, exhausted: info.verdict === 'fail' && exhausted };
    flash = '';
    render();
  };

  // 수정안을 적용한 뒤: 진행 중 → 검증 중. 미리보기에서 통과한 결과가 있고 "통과하면 바로 완료"가 켜져 있으면 바로 완료
  window.onRoadmapApplied = async () => {
    const rm = UI.get();
    if (!rm) return;
    const r = RM.afterApply(rm, { lang: lang() });
    if (!r.changed) return;
    UI.replace(r.roadmap);
    flash = '';
    if (trial?.task === r.id && trial.verdict === 'pass' && r.roadmap.settings.autoDoneOnPass) return markDone(r.id);
    render();
  };

  // 프로젝트를 열고 닫거나 바꾸면 그 프로젝트의 로드맵을 읽는다 (같은 프로젝트면 다시 그리기만)
  // 실행 · 확인 칸의 점검이 끝나면 카드의 "필요한 도구" 경고를 다시 그린다 (v0.42.0)
  window.onDevEnvChecked = () => render();

  window.onRoadmapProject = () => {
    const key = P && P.has && P.has() ? P.project.info.id || P.project.info.name : '';
    if (key === projKey) return render();
    projKey = key;
    pick = '';
    trial = null;
    flash = '';
    UI.load().then(render, render);
  };

  UI.onChange(() => render());
  $('#rmcCreate').addEventListener('click', () => UI.open());
  $('#rmcAll').addEventListener('click', () => UI.openAt(RM.currentTask(UI.get() || {}, { pick })?.id || ''));
  $('#rmcFold').addEventListener('click', () => {
    folded = !folded;
    try {
      localStorage.setItem(FOLD_KEY, folded ? '1' : '0');
    } catch {}
    render();
  });

  MLA.roadmapCard = { render, state: () => ({ pick, trial, testing, flash, folded }) };
})();
