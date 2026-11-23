// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/dev-once.js)
'use strict';

// 한 번 실행 (v0.46.0) — dev-capture.js 다음에 읽힌다. Windows 앱 전용(host.devrun.once).
//   서버가 아닌 프로그램(CLI · Python 스크립트 · package.json의 bin/main)을 인자와 함께 한 번 돌려 출력과 종료 코드를 본다.
//   대상: npm 스크립트(dev · start · serve · preview + 인자) · package.json bin · main · 맨 위의 main.py · app.py · cli.py · __main__.py · manage.py
//         · cli.js · index.js · main.js. 인자는 셸을 거치지 않으므로 ; | > 같은 글자는 그냥 글자다. 본체가 확인 창 · 1분 제한.
//
// [쉽게 말하면] 화면이 없는 프로그램도 "python main.py greet --name 김"처럼 한 번 실행해 결과를 눈으로 볼 수 있게 하는 부분입니다.

(() => {
  const P = MLA.projectUI;
  const once = { targets: [], key: null, running: false, last: null };
  let modal = null;

  const can = () => !!host.devrun?.once;
  const projectId = () => (P && P.has && P.has() ? P.project.info.id || P.project.info.name : '');
  const memKey = () => `mla-once-${projectId()}`;
  const mem = () => {
    try {
      return JSON.parse(localStorage.getItem(memKey()) || 'null') || {};
    } catch {
      return {};
    }
  };

  async function refresh() {
    if (!can() || !projectId()) {
      once.targets = [];
      return render();
    }
    const r = await host.devrun.onceInfo().catch(() => null);
    once.targets = r?.ok ? r.targets : [];
    render();
  }

  function render() {
    const b = $('#dhOnce');
    if (!b) return;
    const show = can() && !!projectId() && once.targets.length > 0;
    b.hidden = !show;
    if (!show) return;
    // 띄울 개발 서버 스크립트가 없는 프로젝트(CLI · Python)에서는 이 단추가 주인공이다
    const noServer = !(MLA.devRun?.run?.scripts?.length);
    b.textContent = noServer ? t('dev.once.btnMain') : t('dev.once.btn');
    b.className = noServer ? 'dh-run-btn primary dh-once' : 'dh-mini dh-once';
  }

  function renderModal() {
    if (!modal) return;
    const sel = $('#onceTarget');
    const keep = sel.value || mem().id;
    sel.replaceChildren(...once.targets.map((x) => Object.assign(document.createElement('option'), { value: x.id, textContent: x.label })));
    sel.value = once.targets.some((x) => x.id === keep) ? keep : once.targets[0]?.id || '';
    sel.disabled = once.running;
    $('#onceArgs').disabled = once.running;
    const run = $('#onceRun');
    run.textContent = once.running ? t('dev.once.stop') : t('dev.once.runBtn');
    run.className = once.running ? 'danger' : 'primary';
    const r = once.last;
    $('#onceOut').textContent = once.running ? t('dev.once.running') : r ? r.output || t('dev.run.logEmpty') : '';
    const st = $('#onceStatus');
    st.className = `muted-label${r && !once.running ? (r.ok ? ' lvl-ok' : ' lvl-error') : ''}`;
    st.textContent = once.running || !r ? '' : r.error && r.code == null && !r.timedOut ? r.error : r.timedOut ? t('dev.once.timedOut') : r.stopped ? t('dev.once.stopped') : t('dev.once.done', { code: r.code ?? '?', sec: ((r.ms || 0) / 1000).toFixed(1), cmd: r.command || '' });
  }

  async function runIt() {
    if (once.running) return host.devrun.onceStop();
    const id = $('#onceTarget').value;
    const args = $('#onceArgs').value;
    if (!id) return;
    try {
      localStorage.setItem(memKey(), JSON.stringify({ id, args }));
    } catch {}
    once.running = true;
    renderModal();
    let r;
    try {
      r = await host.devrun.once(id, args);
    } catch (err) {
      r = { ok: false, error: err.message };
    } finally {
      once.running = false;
    }
    if (r?.cancelled) return renderModal();
    once.last = r;
    renderModal();
  }

  async function openModal() {
    if (modal) return closeModal();
    await refresh();
    if (!once.targets.length) return;
    const dialog = state?.chatView === 'panels';
    modal = { dialog, pending: dialog };
    if (dialog) host.setView('dialog');
    $('#onceModal').hidden = false;
    const m = mem();
    $('#onceArgs').value = typeof m.args === 'string' ? m.args : '';
    renderModal();
    $('#onceArgs').focus();
  }
  function closeModal() {
    if (!modal) return;
    const { dialog } = modal;
    modal = null;
    $('#onceModal').hidden = true;
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }

  const prevState = window.onDevState;
  window.onDevState = () => {
    prevState?.();
    if (!modal) return;
    if (modal.pending) {
      if (state.chatView === 'dialog') modal.pending = false;
      return;
    }
    if (modal.dialog && state.chatView !== 'dialog') {
      modal.dialog = false;
      closeModal();
    }
  };
  // 프로젝트가 바뀌거나 앱 실행 칸을 다시 그리면 (dev-run.js가 알림)
  const prevRun = window.onDevRunChanged;
  window.onDevRunChanged = (st) => {
    prevRun?.(st);
    const key = projectId();
    if (key !== once.key) {
      once.key = key;
      once.last = null;
      if (!key) closeModal();
      refresh();
    } else render();
  };

  $('#dhOnce').addEventListener('click', () => openModal());
  $('#onceRun').addEventListener('click', () => runIt());
  $('#onceArgs').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runIt();
    }
  });
  $('#onceCopy').addEventListener('click', () => host.copyText($('#onceOut').textContent || ''));
  $('#onceClose').addEventListener('click', () => closeModal());
  $('#onceModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal();
    }
  });

  MLA.devOnce = { once, refresh, render, openModal, closeModal, runIt };
})();
