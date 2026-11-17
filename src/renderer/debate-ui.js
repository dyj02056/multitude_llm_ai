'use strict';

// 토론 설정 창 · 진행 표시 (v0.26.0) — Windows 앱과 크롬 확장이 똑같이 씀. panel-offers.js 다음에 읽힌다.
// 입력창 아래 종합 옆의 [토론] → 참가 AI(2~3개) · 라운드(1~3, 기본 2) · 판정 AI(기본 종합 담당)를 고르고 [시작].
// 진행은 본체(shared/debate.js)가 synth:status(mode 'debate')로 알려 준다: 라운드 i/N · 기다리는 AI · 판정 중 · 끝 · 멈춤 · 실패.
// 진행 중에는 [토론 멈추기]가 보인다. 결과는 답변 비교 › 이어 묻기 · 토론 탭과 기록 화면에 남는다.
// Windows 앱은 패널 웹페이지가 화면 맨 위에 얹혀 있어 창을 띄울 때 'dialog' 화면으로 바꿔 패널을 치운다 (미리보기 창과 같음).
//
// [쉽게 말하면] "AI 몇 개를 몇 번 토론시킬지" 고르는 창과, 토론이 어디까지 왔는지 입력창 아래에 보여 주는 부분입니다.

(() => {
  const CH = MLA.chain;
  let open = null; // { dialog, pending }
  let running = false;
  // 토론 설정 기본값 (v0.29.0): 작업 프리셋이 정한 것 → 없으면 마지막으로 시작한 설정. { participants, rounds, judge }
  let defaults = null;
  window.debateDefaults = () => defaults;
  window.setDebateDefaults = (cfg) => (defaults = cfg && typeof cfg === 'object' ? { ...cfg } : null);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const openIds = () => (state?.rects || []).map((r) => r.id);
  const nameOf = (id) => state?.services.find((s) => s.id === id)?.name || id;
  const checked = () => [...document.querySelectorAll('#debateParts input[type="checkbox"]:checked')].map((b) => b.value);
  /** 참가 AI마다 고른 역할 { id: 'pro' | 'con' | 'rebut' } (역할 없음은 뺀다, v0.32.0) */
  const rolesPicked = () => {
    const out = {};
    for (const s of document.querySelectorAll('#debateParts select')) if (s.value && checked().includes(s.dataset.id)) out[s.dataset.id] = s.value;
    return out;
  };

  function limitChecks() {
    const full = checked().length >= CH.MAX_PARTICIPANTS;
    for (const b of document.querySelectorAll('#debateParts input[type="checkbox"]')) b.disabled = full && !b.checked;
    for (const s of document.querySelectorAll('#debateParts select')) s.disabled = !checked().includes(s.dataset.id); // 고르지 않은 AI는 역할도 없다
    const n = checked().length;
    $('#debateSub').textContent = t('debate.sub', { n, max: CH.MAX_PARTICIPANTS });
    $('#debateStart').disabled = n < CH.MIN_PARTICIPANTS || !open?.question;
  }

  function fill(question) {
    const ids = openIds();
    const want = (defaults?.participants || []).filter((id) => ids.includes(id));
    const pick = want.length >= CH.MIN_PARTICIPANTS ? want : ids.slice(0, CH.MAX_PARTICIPANTS);
    $('#debateParts').replaceChildren(
      ...ids.map((id) => {
        const label = el('label', 'check-label debate-part');
        label.style.setProperty('--svc', state.services.find((s) => s.id === id)?.color || 'var(--border)');
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: id, checked: pick.includes(id) });
        box.addEventListener('change', limitChecks);
        // 역할 (v0.32.0): 없음 · 찬성 · 반대 · 반론 전담
        const role = el('select', 'debate-role');
        role.dataset.id = id;
        role.setAttribute('aria-label', t('debate.roleLabel', { name: nameOf(id) }));
        role.append(...['', ...CH.ROLES].map((r) => Object.assign(document.createElement('option'), { value: r, textContent: t(`debate.role.${r || 'none'}`) })));
        role.value = CH.ROLES.includes(defaults?.roles?.[id]) ? defaults.roles[id] : '';
        label.append(box, ' ', el('span', '', nameOf(id)), ' ', role);
        return label;
      }),
    );
    const rounds = $('#debateRounds');
    rounds.replaceChildren(
      ...Array.from({ length: CH.MAX_ROUNDS }, (_, i) => Object.assign(document.createElement('option'), { value: String(i + 1), textContent: t('debate.roundsOption', { n: i + 1 }) })),
    );
    rounds.value = String(defaults?.rounds >= 1 && defaults.rounds <= CH.MAX_ROUNDS ? defaults.rounds : CH.DEFAULT_ROUNDS);
    $('#debateInterject').checked = defaults?.interject === true;
    const judge = $('#debateJudge');
    // 판정: 열린 패널 + (켜 두었으면) 패널 없는 로컬 LLM (v0.29.0, renderer-compose.js judgeChoices)
    const judges = judgeChoices();
    judge.replaceChildren(...judges.map((c) => Object.assign(document.createElement('option'), { value: c.id, textContent: c.name })));
    const has = (id) => judges.some((c) => c.id === id);
    judge.value = has(defaults?.judge) ? defaults.judge : has(state.synthTarget) ? state.synthTarget : ids[0] || '';
    $('#debateQuestion').textContent = question ? t('debate.questionLine', { q: question.split('\n')[0].slice(0, 200) }) : t('debate.noQuestion');
    $('#debateStatus').textContent = '';
    limitChecks();
  }

  function close() {
    if (!open) return;
    const { dialog } = open;
    open = null;
    $('#debateModal').hidden = true;
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }

  async function openDialog() {
    if (running) return;
    if (open) close();
    const dialog = state?.chatView === 'panels';
    open = { dialog, pending: dialog, question: '' };
    if (dialog) host.setView('dialog');
    const { question } = await host.getAnswers().catch(() => ({ question: '' }));
    if (!open) return;
    open.question = question || '';
    fill(open.question);
    $('#debateModal').hidden = false;
    $('#debateStart').focus();
  }

  async function start() {
    const roles = rolesPicked();
    const cfg = {
      participants: checked(),
      rounds: Number($('#debateRounds').value),
      judge: $('#debateJudge').value,
      ...(Object.keys(roles).length ? { roles } : {}),
      ...($('#debateInterject').checked ? { interject: true } : {}),
    };
    $('#debateStart').disabled = true;
    const r = await host.debate.start(cfg).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) {
      $('#debateStatus').textContent = r?.error || t('debate.errStart');
      $('#debateStatus').dataset.kind = 'warn';
      limitChecks();
      return;
    }
    defaults = cfg; // 다음에 열 때 · "지금 설정을 프리셋으로"에 쓴다
    close();
  }

  /** 진행 상태 → 입력창 아래 안내 글 · 멈추기 버튼 */
  function statusText({ state: st, round, rounds, waiting, judge, error }) {
    if (st === 'paused') return t('debate.statusPaused', { round, rounds });
    if (st === 'running') return waiting?.length ? t('debate.statusRound', { round, rounds, names: waiting.join(', ') }) : t('debate.statusRoundDone', { round, rounds });
    if (st === 'judging') return t('debate.statusJudging', { judge });
    if (st === 'done') return t('debate.statusDone', { judge });
    if (st === 'stopped') return t('debate.statusStopped');
    return t('debate.statusError', { error: error || '' });
  }

  // ---------- 끼어들기 (v0.32.0): 라운드 사이에 멈추면 한마디를 받는다 ----------
  let note = null; // { dialog, pending, round, rounds } — 끼어들기 창이 열려 있을 때
  let paused = null; // { round, rounds } — 토론이 한마디를 기다리는 중 (창을 닫아도 [끼어들기] 단추로 다시 연다)

  function closeNote() {
    if (!note) return;
    const { dialog } = note;
    note = null;
    $('#interjectModal').hidden = true;
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }
  function openNote() {
    if (!paused || note) return;
    const dialog = state?.chatView === 'panels';
    note = { dialog, pending: dialog };
    if (dialog) host.setView('dialog');
    $('#interjectSub').textContent = t('debate.note.sub', paused);
    $('#interjectText').value = '';
    $('#interjectStatus').textContent = '';
    $('#interjectModal').hidden = false;
    $('#interjectText').focus();
  }
  async function sendNote(text) {
    const r = await host.debate.interject(text).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) {
      $('#interjectStatus').textContent = r?.error || t('debate.errStart');
      return;
    }
    paused = null;
    $('#debateNote').hidden = true;
    closeNote();
  }

  host.on('synth:status', (patch) => {
    if (patch.mode !== 'debate') return;
    paused = patch.state === 'paused' ? { round: patch.round, rounds: patch.rounds } : null;
    running = patch.state === 'running' || patch.state === 'paused' || patch.state === 'judging';
    $('#sendHint').textContent = statusText(patch);
    $('#debateStop').hidden = !running;
    $('#debateBtn').hidden = running;
    $('#debateNote').hidden = !paused;
    if (paused) openNote(); // 멈춘 순간 바로 창을 띄운다
    else if (note) closeNote();
    if (patch.state === 'done' && state?.chatView === 'compare') renderCompare();
  });

  /** 화면 상태가 올 때마다 (renderer-compose.js): 창을 띄운 화면을 떠났으면 닫는다 */
  window.onDebateState = () => {
    if (note) {
      if (note.pending) {
        if (state.chatView === 'dialog') note.pending = false;
      } else if (note.dialog && state.chatView !== 'dialog') {
        note.dialog = false; // 이미 다른 화면 — 창만 닫는다. 토론은 [끼어들기] 단추로 이어 갈 수 있다
        closeNote();
      }
    }
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

  $('#debateBtn').addEventListener('click', openDialog);
  $('#debateNote').addEventListener('click', openNote);
  $('#interjectSend').addEventListener('click', () => sendNote($('#interjectText').value));
  $('#interjectSkip').addEventListener('click', () => sendNote(''));
  $('#interjectStop').addEventListener('click', async () => {
    const r = await host.debate.stop().catch(() => null);
    if (!r?.ok) $('#interjectStatus').textContent = r?.error || t('debate.errStop');
    else closeNote();
  });
  $('#interjectModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeNote(); // 창만 닫는다 — 토론은 그대로 멈춰 있고 [끼어들기]로 다시 열 수 있다
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendNote($('#interjectText').value);
    }
  });
  $('#debateStop').addEventListener('click', async () => {
    const r = await host.debate.stop().catch(() => null);
    if (!r?.ok) $('#sendHint').textContent = r?.error || t('debate.errStop');
  });
  $('#debateStart').addEventListener('click', start);
  $('#debateCancel').addEventListener('click', close);
  $('#debateModal').addEventListener('click', (e) => e.target === $('#debateModal') && close());
  $('#debateModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
})();
