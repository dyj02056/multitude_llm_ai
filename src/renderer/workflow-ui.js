'use strict';

// 작업 흐름 설정 창 · 진행 표시 (v0.33.0) — Windows 앱과 크롬 확장이 똑같이 씀. debate-ui.js 다음에 읽힌다.
// 입력창 아래 종합 · 토론 옆의 [흐름] → 걸음(2~6개: 초안 → 비판 → 고쳐 쓰기 → 검증 …)마다 일의 종류와 AI를 고르고 [시작].
// 걸음 규칙 · 보낼 횟수 · 요청 글 · 진행은 shared/workflow.js. 진행은 synth:status(mode 'workflow')로 온다:
//   걸음 i/N · 기다리는 AI · (걸음마다 멈춤이면) 멈춤 · 끝 · 멈춤 · 실패. 멈춰 있을 때 [다음 걸음] · [다음 걸음 건너뛰기] · [흐름 멈추기].
// 결과는 답변 비교 › 이어 묻기 · 토론 탭과 기록 화면에 걸음마다 남는다.
// Windows 앱은 패널 웹페이지가 화면 맨 위에 얹혀 있어 창을 띄울 때 'dialog' 화면으로 바꿔 패널을 치운다 (토론 창과 같음).
//
// [쉽게 말하면] "A가 초안 → B가 비판 → A가 고쳐 쓰기 → C가 검증" 같은 순서를 정하는 창과, 어디까지 왔는지 입력창 아래에 보여 주는 부분입니다.

(() => {
  const WF = MLA.workflow;
  let open = null; // { dialog, pending, hasAnswer: Set(id) }
  let running = false;
  let steps = []; // 창에서 고치는 중인 걸음 [{ kind, who }]
  // 작업 흐름 기본값: 작업 프리셋이 정한 것 → 없으면 마지막으로 시작한 설정. { steps, stepByStep }
  let defaults = null;
  window.workflowDefaults = () => defaults;
  window.setWorkflowDefaults = (cfg) => (defaults = cfg && typeof cfg === 'object' ? { steps: (cfg.steps || []).map((s) => ({ ...s })), stepByStep: cfg.stepByStep === true } : null);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const openIds = () => (state?.rects || []).map((r) => r.id);
  const nameOf = (id) => state?.services.find((s) => s.id === id)?.name || id;
  const kindName = (k) => t(`workflow.kind.${k}`);

  function readCfg() {
    return { steps: steps.map((s) => ({ ...s })), stepByStep: $('#workflowStepByStep').checked };
  }

  /** 걸음 목록 · 보낼 횟수 · 검사 결과를 지금 값에 맞춘다 */
  function refresh() {
    const list = $('#workflowSteps');
    list.replaceChildren(
      ...steps.map((s, i) => {
        const row = el('div', 'wf-row');
        row.append(el('span', 'muted-label wf-n', t('workflow.stepLabel', { n: i + 1 })));
        const kind = el('select', 'wf-kind');
        kind.setAttribute('aria-label', t('workflow.kindLabel', { n: i + 1 }));
        kind.append(...WF.KINDS.map((k) => Object.assign(document.createElement('option'), { value: k, textContent: kindName(k), title: t(`workflow.kindHelp.${k}`) })));
        kind.value = s.kind;
        kind.addEventListener('change', () => {
          s.kind = kind.value;
          refresh();
        });
        const who = el('select', 'wf-who');
        who.setAttribute('aria-label', t('workflow.whoLabel', { n: i + 1 }));
        who.append(...openIds().map((id) => Object.assign(document.createElement('option'), { value: id, textContent: nameOf(id) })));
        who.value = openIds().includes(s.who) ? s.who : openIds()[0] || '';
        s.who = who.value;
        who.addEventListener('change', () => {
          s.who = who.value;
          refresh();
        });
        const del = button('✕', t('workflow.removeStep', { n: i + 1 }), () => {
          steps.splice(i, 1);
          refresh();
        });
        del.disabled = steps.length <= 1;
        row.append(kind, who, del);
        const help = el('span', 'muted small wf-help', t(`workflow.kindHelp.${s.kind}`));
        row.append(help);
        return row;
      }),
    );
    $('#workflowAdd').disabled = steps.length >= WF.MAX_STEPS;
    $('#workflowSub').textContent = t('workflow.sub', { n: steps.length, max: WF.MAX_STEPS });
    const res = WF.normalizeWorkflow(readCfg(), openIds());
    const count = WF.countSends(steps, (id) => !!open?.hasAnswer?.has(id));
    const detail = Object.entries(count.byWho)
      .map(([id, n]) => `${nameOf(id)} ${n}`)
      .join(' · ');
    $('#workflowCount').textContent = t('workflow.count', { total: count.total, detail });
    $('#workflowStatus').textContent = res.ok ? '' : res.error;
    $('#workflowStatus').dataset.kind = res.ok ? '' : 'warn';
    $('#workflowStart').disabled = !res.ok || !open?.question;
  }

  function fill(question) {
    const ids = openIds();
    const saved = (defaults?.steps || []).filter((s) => WF.KINDS.includes(s.kind) && ids.includes(s.who));
    steps = saved.length >= WF.MIN_STEPS ? saved.map((s) => ({ ...s })) : WF.exampleSteps(ids);
    $('#workflowStepByStep').checked = defaults?.stepByStep === true;
    $('#workflowQuestion').textContent = question ? t('debate.questionLine', { q: question.split('\n')[0].slice(0, 200) }) : t('debate.noQuestion');
    refresh();
  }

  function close() {
    if (!open) return;
    const { dialog } = open;
    open = null;
    $('#workflowModal').hidden = true;
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }

  async function openDialog() {
    if (running) return;
    if (open) close();
    const dialog = state?.chatView === 'panels';
    open = { dialog, pending: dialog, question: '', hasAnswer: new Set() };
    if (dialog) host.setView('dialog');
    const got = await host.getAnswers().catch(() => ({ question: '', answers: [] }));
    if (!open) return;
    open.question = got.question || '';
    open.hasAnswer = new Set((got.answers || []).filter((a) => a.text).map((a) => a.id)); // 초안은 이미 받은 답을 쓴다
    fill(open.question);
    $('#workflowModal').hidden = false;
    $('#workflowStart').focus();
  }

  async function start() {
    const cfg = readCfg();
    $('#workflowStart').disabled = true;
    const r = await host.workflow.start(cfg).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) {
      $('#workflowStatus').textContent = r?.error || t('workflow.errStart');
      $('#workflowStatus').dataset.kind = 'warn';
      refresh();
      return;
    }
    defaults = cfg; // 다음에 열 때 · "지금 설정을 프리셋으로"에 쓴다
    close();
  }

  /** 진행 상태 → 입력창 아래 안내 글 */
  function statusText({ state: st, step, steps: n, who, kind, next, skipped, error }) {
    if (st === 'running') return t(skipped ? 'workflow.statusSkipped' : 'workflow.statusStep', { step, steps: n, who, kind: kindName(kind) });
    if (st === 'paused') return t(skipped ? 'workflow.statusPausedSkipped' : 'workflow.statusPaused', { step, steps: n, who, nextWho: next?.who || '', nextKind: next ? kindName(next.kind) : '' });
    if (st === 'done') return t('workflow.statusDone', { steps: n, who });
    if (st === 'stopped') return t('workflow.statusStopped');
    return t('workflow.statusError', { error: error || '' });
  }

  host.on('synth:status', (patch) => {
    if (patch.mode !== 'workflow') return;
    const paused = patch.state === 'paused';
    running = patch.state === 'running' || paused;
    $('#sendHint').textContent = statusText(patch);
    $('#workflowBtn').hidden = running;
    $('#workflowStop').hidden = !running;
    $('#workflowNext').hidden = !paused;
    $('#workflowSkip').hidden = !paused;
    if (patch.state === 'done' && state?.chatView === 'compare') renderCompare();
  });

  /** 화면 상태가 올 때마다 (renderer-compose.js): 창을 띄운 화면을 떠났으면 닫는다 */
  window.onWorkflowState = () => {
    if (!open) return;
    if (open.pending) {
      if (state.chatView === 'dialog') open.pending = false;
      return;
    }
    if (open.dialog && state.chatView !== 'dialog') {
      open.dialog = false;
      close();
    }
  };

  const resume = async (skip) => {
    const r = await host.workflow.resume({ skip }).catch(() => null);
    if (!r?.ok) $('#sendHint').textContent = r?.error || t('workflow.errNotPaused');
  };

  $('#workflowBtn').addEventListener('click', openDialog);
  $('#workflowAdd').addEventListener('click', () => {
    const last = steps[steps.length - 1];
    steps.push({ kind: last?.kind === 'critique' ? 'revise' : 'critique', who: openIds()[steps.length % Math.max(openIds().length, 1)] || '' });
    refresh();
  });
  $('#workflowExample').addEventListener('click', () => {
    steps = WF.exampleSteps(openIds());
    refresh();
  });
  $('#workflowStepByStep').addEventListener('change', refresh);
  $('#workflowStart').addEventListener('click', start);
  $('#workflowCancel').addEventListener('click', close);
  $('#workflowNext').addEventListener('click', () => resume(false));
  $('#workflowSkip').addEventListener('click', () => resume(true));
  $('#workflowStop').addEventListener('click', async () => {
    const r = await host.workflow.stop().catch(() => null);
    if (!r?.ok) $('#sendHint').textContent = r?.error || t('workflow.errStop');
  });
  $('#workflowModal').addEventListener('click', (e) => e.target === $('#workflowModal') && close());
  $('#workflowModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
})();
