'use strict';

// 실행 · 확인 칸의 "앱 실행" (v0.43.0~) — dev-hub.js 다음에 읽힌다. Windows 앱 전용(host.devrun), 크롬 확장에서는 숨긴다.
//   package.json의 dev · start · serve · preview 중 하나를 골라 ▶ 실행 → 본체(devrun.js)가 확인 창을 띄우고 셸 없이 실행한다.
//   출력에서 찾은 이 PC 주소(http://localhost:5173 등)를 칸에 크게 보여 주고, [브라우저로 열기] · [로그] · ■ 중지.
//   node · npm이 이 PC에 없으면(실행 · 확인 점검 결과) 실행 단추를 막고 이유를 보여 준다.
//
// [쉽게 말하면] 터미널을 열어 "npm run dev"를 치지 않아도, 사이드바에서 ▶ 를 누르면 개발 서버가 뜨고 주소가 보이는 부분입니다.

(() => {
  const E = MLA.envRules;
  const P = MLA.projectUI;
  const PICK_KEY = 'mla-run-script';
  const run = { scripts: [], state: { running: false }, error: '', starting: false, key: null };
  let logOpen = null; // { dialog, pending, timer }

  const can = () => !!host.devrun;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const projectId = () => (P && P.has && P.has() ? P.project.info.id || P.project.info.name : '');
  const picked = () => {
    try {
      return localStorage.getItem(PICK_KEY) || '';
    } catch {
      return '';
    }
  };

  async function refresh() {
    if (!can() || !projectId()) return render();
    try {
      const r = await host.devrun.info();
      run.scripts = r?.ok ? r.scripts : [];
      run.error = r?.ok ? '' : r?.error || '';
      if (r?.state) run.state = r.state;
    } catch (err) {
      run.scripts = [];
      run.error = err.message;
    }
    render();
  }

  /** 지금 고른 스크립트: 기억한 것 → dev → 첫 번째 */
  function current() {
    const names = run.scripts.map((s) => s.name);
    const want = $('#dhRunScript').value || picked();
    return names.includes(want) ? want : names.includes('dev') ? 'dev' : names[0] || '';
  }

  function render() {
    const box = $('#dhRun');
    if (!box) return;
    box.hidden = !can() || !projectId();
    if (box.hidden) return;
    const st = run.state || { running: false };
    const sel = $('#dhRunScript');
    const name = st.running ? st.name : current();
    sel.replaceChildren(...run.scripts.map((s) => Object.assign(el('option', '', s.name), { value: s.name, title: s.script })));
    sel.value = name;
    sel.disabled = st.running || run.starting || !run.scripts.length;
    sel.hidden = run.scripts.length < 2 && !st.running;
    const btn = $('#dhRunBtn');
    const block = !st.running && name ? MLA.devHub?.blockReason?.([name]) || '' : '';
    btn.textContent = st.running ? t('dev.run.stopBtn') : t('dev.run.startBtn', { name: name || 'dev' });
    btn.title = st.running ? t('dev.run.stopTitle') : run.scripts.find((s) => s.name === name)?.script || '';
    btn.className = st.running ? 'dh-run-btn danger' : 'dh-run-btn primary';
    btn.disabled = run.starting || (!st.running && (!run.scripts.length || !!block));
    $('#dhRunLog').hidden = !st.running && !st.exit;
    // 상태 줄
    const line = $('#dhRunState');
    const kids = [];
    if (!run.scripts.length && !st.running) kids.push(el('span', 'dh-sub', run.error && !/package\.json/i.test(run.error) ? run.error : t('dev.run.none')));
    else if (block) kids.push(el('span', 'lvl-error dh-run-msg', block));
    else if (run.starting) kids.push(el('span', 'dh-run-msg', t('dev.run.starting')));
    else if (st.running && st.url) {
      kids.push(el('span', 'dh-run-dot on', '●'), el('span', 'dh-run-msg', t('dev.run.runningAt', { name: st.name })));
      const link = button(st.url.replace(/\/$/, ''), t('dev.run.openTitle'), () => host.devrun.open(st.url));
      link.className = 'dh-url';
      kids.push(link);
    } else if (st.running) kids.push(el('span', 'dh-run-dot wait', '●'), el('span', 'dh-run-msg', t('dev.run.waitUrl', { name: st.name, n: st.lines || 0 })));
    else if (st.exit) kids.push(el('span', st.exit.stopped ? 'dh-sub' : st.exit.code === 0 ? 'dh-sub' : 'lvl-error dh-run-msg', st.exit.stopped ? t('dev.run.stopped', { name: st.name }) : t('dev.run.exited', { name: st.name, code: st.exit.code ?? '?' })));
    else if (run.error) kids.push(el('span', 'lvl-error dh-run-msg', run.error));
    line.replaceChildren(...kids);
    box.classList.toggle('running', !!st.running);
    window.onDevRunChanged?.(st); // 미리보기(v0.44.0) · 로드맵 카드(v0.46.0)가 듣는다
  }

  async function toggle() {
    const st = run.state || {};
    if (st.running) {
      await host.devrun.stop();
      return;
    }
    const name = current();
    if (!name) return;
    try {
      localStorage.setItem(PICK_KEY, name);
    } catch {}
    run.starting = true;
    run.error = '';
    render();
    let r;
    try {
      r = await host.devrun.start(name);
    } catch (err) {
      r = { ok: false, error: err.message };
    } finally {
      run.starting = false;
    }
    if (r?.ok && r.state) run.state = r.state;
    else if (!r?.cancelled) run.error = r?.error || '';
    render();
  }

  // ---------- 로그 창 ----------
  async function pullLog() {
    if (!logOpen) return;
    const r = await host.devrun.log().catch(() => null);
    if (!logOpen || !r) return;
    const pre = $('#runLogText');
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = r.text || t('dev.run.logEmpty');
    if (atEnd) pre.scrollTop = pre.scrollHeight;
    const st = r.state || {};
    $('#runLogSub').textContent = st.name ? `${st.name} · ${st.script || ''}` : '';
    $('#runLogStop').hidden = !st.running;
  }
  function openLog() {
    if (logOpen) return closeLog();
    const dialog = state?.chatView === 'panels';
    logOpen = { dialog, pending: dialog, timer: setInterval(pullLog, 1000) };
    if (dialog) host.setView('dialog');
    $('#runLogModal').hidden = false;
    pullLog();
    $('#runLogClose').focus();
  }
  function closeLog() {
    if (!logOpen) return;
    const { dialog, timer } = logOpen;
    clearInterval(timer);
    logOpen = null;
    $('#runLogModal').hidden = true;
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }
  const prevState = window.onDevState;
  window.onDevState = () => {
    prevState?.();
    if (!logOpen) return;
    if (logOpen.pending) {
      if (state.chatView === 'dialog') logOpen.pending = false;
      return;
    }
    if (logOpen.dialog && state.chatView !== 'dialog') {
      logOpen.dialog = false;
      closeLog();
    }
  };

  // 본체가 알리는 상태 (시작 · 주소 찾음 · 출력 · 끝남)
  if (can()) {
    host.on('devrun:state', (st) => {
      run.state = st || { running: false };
      render();
    });
  }
  // 프로젝트가 바뀌면 그 프로젝트의 스크립트를 읽는다 · 점검이 끝나면(도구 없음 → 막기) 다시 그린다
  window.onDevRunProject = (key) => {
    if (key === run.key) return render();
    run.key = key;
    run.scripts = [];
    run.error = '';
    if (!key) closeLog();
    refresh();
  };
  const prevChecked = window.onDevEnvChecked;
  window.onDevEnvChecked = (env) => {
    prevChecked?.(env);
    render();
  };

  $('#dhRunBtn').addEventListener('click', () => toggle());
  $('#dhRunScript').addEventListener('change', () => {
    try {
      localStorage.setItem(PICK_KEY, $('#dhRunScript').value);
    } catch {}
    render();
  });
  $('#dhRunLog').addEventListener('click', () => openLog());
  $('#runLogClose').addEventListener('click', () => closeLog());
  $('#runLogStop').addEventListener('click', () => host.devrun?.stop());
  $('#runLogCopy').addEventListener('click', async () => {
    await host.copyText($('#runLogText').textContent || '');
    $('#runLogStatus').textContent = t('dev.run.logCopied');
  });
  $('#runLogModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeLog();
    }
  });

  MLA.devRun = { run, refresh, render, toggle, openLog, closeLog, state: () => run.state };
})();
