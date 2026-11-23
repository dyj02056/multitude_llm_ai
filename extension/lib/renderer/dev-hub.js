// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/dev-hub.js)
'use strict';

// 실행 · 확인 (v0.41.0~) — 프로젝트 사이드바의 "실행 · 확인" 칸. roadmap-card.js 다음에 읽힌다. Windows 앱과 크롬 확장이 같이 쓴다.
//   v0.41.0 개발 환경 점검: 맨 위 폴더의 파일로 필요한 도구를 고르고(shared/env-rules.js), 이 PC에 있는지 · 버전이 맞는지 본다.
//          실제 버전 묻기는 본체(main/envcheck.js — host.env.check)만 한다. 확장에는 host.env가 없어 "필요한 도구 목록"만 보인다.
//
// [쉽게 말하면] 프로젝트를 열면 "이 프로젝트를 돌리는 데 필요한 도구가 이 PC에 다 있는지"를 사이드바에 색으로 보여 주는 칸입니다.
//   초록 = 준비됨, 노랑 = 확인 필요(버전 · PATH), 빨강 = 없는 도구. [자세히]를 누르면 표와 설치 명령이 나옵니다.

(() => {
  const E = MLA.envRules;
  const P = MLA.projectUI;
  const MAX_CHIPS = 10;
  const LEVEL_GLYPH = { ok: '✓', warn: '⚠', error: '✗', off: '–', unknown: '•' };

  const env = {
    key: null, // 지금 프로젝트
    scanning: false,
    checking: false,
    entries: [], // 맨 위 폴더 [{ name, kind }]
    texts: {}, // 버전 요구 · 표시를 읽은 파일 글
    needs: [], // detectNeeds (+ 사용자가 더한 것)
    reqs: {},
    ready: [], // 준비 상태 [{ key, level, cmd?, ... }]
    pkgs: [], // 프로젝트 안 패키지 [{ pkg, version, because }]
    ports: [],
    found: null, // 본체 점검 결과
    rows: [],
    error: '',
    at: 0,
  };
  let modal = null; // { dialog, pending }
  let flashMsg = '';

  const canCheck = () => !!host.env?.check;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const projectId = () => (P && P.has && P.has() ? P.project.info.id || P.project.info.name : '');

  // ---------- 사용자가 고친 목록 (프로젝트별, 이 PC) ----------
  const prefKey = () => `mla-env-${projectId()}`;
  function loadPref() {
    try {
      const v = JSON.parse(localStorage.getItem(prefKey()) || 'null');
      return { add: Array.isArray(v?.add) ? v.add.filter((x) => E.TOOLS[x]) : [], ignore: Array.isArray(v?.ignore) ? v.ignore.filter((x) => typeof x === 'string') : [] };
    } catch {
      return { add: [], ignore: [] };
    }
  }
  function savePref(p) {
    try {
      localStorage.setItem(prefKey(), JSON.stringify(p));
    } catch {}
  }

  // ---------- 모으기 ----------
  async function readText(path) {
    try {
      const r = await host.project.readFile(path, { maxBytes: 256 * 1024 });
      return typeof r?.text === 'string' ? r.text : null;
    } catch {
      return null;
    }
  }

  /** 맨 위 폴더 · 표시 파일 글 · 프로젝트 패키지를 읽어 필요한 도구를 고른다 (파일을 쓰지 않음) */
  async function collect() {
    env.scanning = true;
    try {
      const entries = await host.project.readDir('').catch(() => []);
      env.entries = Array.isArray(entries) ? entries.map((e) => ({ name: e.name, kind: e.kind })) : [];
      const names = new Set(env.entries.map((e) => e.name));
      const texts = {};
      // 표시 파일 + 맨 위의 .csproj 등은 이름만 보면 되므로 정해 둔 것만 읽는다
      for (const f of E.TEXT_FILES) if (names.has(f)) texts[f] = await readText(f);
      env.texts = texts;
      const pref = loadPref();
      const auto = E.detectNeeds(env.entries, texts);
      const have = new Set(auto.map((n) => n.group || n.id));
      env.needs = [...auto, ...pref.add.filter((id) => !have.has(id)).map((id) => ({ id, because: 'user' }))];
      env.ignore = new Set(pref.ignore);
      env.reqs = E.requirements(texts);
      env.ready = E.readiness(env.entries, texts);
      env.ports = E.devPorts(env.entries, texts);
      // 프로젝트 안에 깔린 패키지 (설정 파일이 있는 것만, node_modules가 있을 때만): 버전은 package.json에서 읽는다
      env.pkgs = [];
      if (names.has('package.json') && names.has('node_modules')) {
        for (const lp of E.LOCAL_PKGS) {
          const marker = env.entries.find((e) => lp.marker.test(e.name));
          if (!marker) continue;
          const pj = E.parseJson(await readText(`node_modules/${lp.pkg}/package.json`));
          env.pkgs.push({ pkg: lp.pkg, version: pj?.version || '', because: marker.name });
        }
      }
    } finally {
      env.scanning = false;
    }
  }

  /** 판정 다시 하기 (본체 결과 + 사용자 무시 목록) */
  function evaluate() {
    env.rows = E.evaluate(env.needs, canCheck() ? env.found?.tools || null : null, env.reqs, env.ignore || new Set());
    if (canCheck() && !env.found) env.rows = env.rows.map((r) => ({ ...r, level: 'unknown', state: 'unknown' })); // 아직 점검 전
    const extra = [];
    const f = env.found;
    if (f) {
      for (const [port, busy] of Object.entries(f.ports || {})) if (busy) extra.push({ key: 'port', level: 'warn', port: Number(port) });
      if (f.docker === 'off') extra.push({ key: 'dockerOff', level: 'warn' });
      if (f.javaHome && !f.javaHome.set) extra.push({ key: 'javaHomeUnset', level: 'info' });
      else if (f.javaHome && !f.javaHome.ok) extra.push({ key: 'javaHomeBad', level: 'warn', path: f.javaHome.path });
    }
    env.readyAll = [...env.ready, ...extra];
  }

  /** 점검: 다시 모으고(파일이 바뀌었을 수 있음) 본체에 묻는다. 확장은 모으기만 */
  async function check() {
    if (env.checking || !projectId()) return;
    env.checking = true;
    env.error = '';
    render();
    try {
      await collect();
      if (canCheck()) {
        const r = await host.env.check({ tools: E.idsOf(env.needs), ports: env.ports });
        if (r?.ok) {
          env.found = r;
          env.at = r.at || Date.now();
        } else env.error = r?.error || '?';
      }
    } catch (err) {
      env.error = err.message;
    } finally {
      env.checking = false;
    }
    evaluate();
    render();
    renderModal();
    window.onDevEnvChecked?.(env); // 다른 화면(로드맵 카드 · AI 요청 맥락, v0.42.0)이 결과를 쓴다
  }

  // ---------- 사이드바 ----------
  function counts() {
    return E.summarize(env.rows, (env.readyAll || []).filter((r) => r.level === 'warn'));
  }
  function overall() {
    if (env.checking || env.scanning) return 'checking';
    if (!canCheck()) return 'unknown';
    if (env.error) return 'error';
    if (!env.found) return 'checking';
    const c = counts();
    return c.error ? 'error' : c.warn ? 'warn' : 'ok';
  }

  function pillText(kind) {
    const c = counts();
    if (kind === 'checking') return t('dev.env.pill.checking');
    if (!env.rows.length) return t('dev.env.pill.none');
    if (kind === 'unknown') return t('dev.env.pill.unknown', { n: env.rows.length });
    if (kind === 'error') return env.error ? t('dev.env.error', { msg: env.error }) : t('dev.env.pill.error', { n: c.error });
    if (kind === 'warn') return t('dev.env.pill.warn', { n: c.warn });
    return t('dev.env.pill.okN', { n: env.rows.filter((r) => r.level === 'ok').length });
  }

  const rowName = (r) => (r.pick && E.TOOLS[r.pick] ? E.TOOLS[r.pick].name : r.name);
  const shortVer = (v) => String(v || '').split('.').slice(0, 2).join('.');

  function chip(r) {
    const li = el('li', `dh-chip lvl-${r.level}`);
    li.append(el('span', 'g', LEVEL_GLYPH[r.level]), document.createTextNode(` ${rowName(r)}${r.version ? ` ${shortVer(r.version)}` : ''}`));
    li.title = `${rowName(r)} — ${t(`dev.env.state.${r.level === 'off' ? 'off' : r.state === 'version' ? 'version' : r.state || r.level}`)}${r.range ? ` · ${r.range}` : ''}`;
    return li;
  }

  function render() {
    const box = $('#devHub');
    if (!box) return;
    if (!projectId()) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const kind = overall();
    box.dataset.level = kind;
    const pill = $('#dhEnvPill');
    pill.textContent = pillText(kind);
    pill.className = `dh-pill lvl-${kind === 'checking' ? 'unknown' : kind}`;
    $('#dhEnvCheck').disabled = env.checking;
    // 문제 있는 도구는 하나씩, 있는 도구는 칩 하나로 묶는다 (파일 나무 자리를 남기려고 — 이름은 마우스를 올리면)
    const shown = env.rows.filter((r) => r.level !== 'off');
    const bad = shown.filter((r) => r.level !== 'ok');
    const good = shown.filter((r) => r.level === 'ok');
    const chips = bad.slice(0, MAX_CHIPS).map(chip);
    if (bad.length > MAX_CHIPS) chips.push(el('li', 'dh-chip more', t('dev.env.more.chips', { n: bad.length - MAX_CHIPS })));
    // 모두 있으면 칩은 숨기고 상태 한 줄에 개수만 (파일 나무 자리를 지킨다)
    if (good.length && bad.length) {
      const g = el('li', 'dh-chip lvl-ok');
      g.append(el('span', 'g', '✓'), document.createTextNode(` ${t('dev.env.okChip', { n: good.length })}`));
      g.title = good.map((r) => `${rowName(r)}${r.version ? ` ${r.version}` : ''}`).join(' · ');
      chips.push(g);
    }
    $('#dhEnvChips').replaceChildren(...chips);
    // 준비 상태: 경고 하나만 사이드바에 (명령 복사 단추와 함께), 더 있으면 개수만 — 전부는 자세히 창에
    const warns = (env.readyAll || []).filter((r) => r.level === 'warn');
    const lines = warns.slice(0, 1).map((r) => readyLine(r, true));
    if (warns.length > 1) lines.push(el('div', 'dh-ready-line lvl-warn', t('dev.env.readyMore', { n: warns.length - 1 })));
    $('#dhEnvReady').replaceChildren(...lines);
    $('#dhEnvNote').textContent = flashMsg || (!canCheck() ? t('dev.env.extNote') : '');
    $('#dhEnvNote').hidden = !$('#dhEnvNote').textContent;
  }

  function readyText(r) {
    return t(`dev.ready.${r.key}`, { port: r.port, path: r.path || '', file: r.file || '' });
  }
  function readyLine(r, compact) {
    const line = el('div', `dh-ready-line lvl-${r.level === 'warn' ? 'warn' : 'unknown'}`);
    line.append(el('span', 'txt', `${r.level === 'warn' ? '⚠' : 'ℹ'} ${readyText(r)}`));
    if (r.cmd) {
      const b = button(compact ? r.cmd : `${t('dev.env.copyCmd')}: ${r.cmd}`, t('dev.env.copyCmd'), () => copy(r.cmd));
      b.className = 'dh-cmd';
      line.append(b);
    }
    return line;
  }

  async function copy(cmd) {
    try {
      await host.copyText(cmd);
      flashMsg = t('dev.env.copied', { cmd });
    } catch (err) {
      flashMsg = err.message;
    }
    render();
    if (modal) $('#envStatus').textContent = flashMsg;
    setTimeout(() => {
      flashMsg = '';
      render();
    }, 4000);
  }

  function openGuide(id) {
    if (host.env?.openInstall) return host.env.openInstall(id);
    const url = E.TOOLS[id]?.url;
    if (url) window.open(url, '_blank', 'noopener');
  }

  // ---------- 자세히 창 ----------
  function stateText(r) {
    if (r.level === 'off') return t('dev.env.state.off');
    if (r.level === 'unknown') return t('dev.env.state.unknown');
    return t(`dev.env.state.${r.state}`);
  }

  function renderModal() {
    if (!modal) return;
    $('#envSub').textContent = P.project?.info?.name || '';
    const c = counts();
    const real = env.rows.filter((r) => r.level !== 'off');
    let sum;
    if (!env.rows.length && !env.pkgs.length) sum = t('dev.env.summary.none');
    else if (!canCheck()) sum = t('dev.env.summary.unknown', { n: real.length });
    else if (env.checking || !env.found) sum = t('dev.env.pill.checking');
    else if (c.error || c.warn) {
      const toolWarn = env.rows.filter((r) => r.level === 'warn').length;
      const readyWarn = (env.readyAll || []).filter((r) => r.level === 'warn').length;
      sum = t('dev.env.summary.problems', { total: real.length, error: c.error, warn: toolWarn }) + (readyWarn ? ` ${t('dev.env.summary.ready', { n: readyWarn })}` : '');
    }
    else sum = t('dev.env.summary.ok', { n: real.length });
    if (env.error) sum = t('dev.env.error', { msg: env.error });
    $('#envSummary').textContent = sum;
    $('#envSummary').className = `env-summary lvl-${overall() === 'checking' ? 'unknown' : overall()}`;

    const rows = env.rows.map((r) => {
      const tr = el('tr', `lvl-${r.level}`);
      const st = el('td', 'st');
      st.append(el('span', 'g', LEVEL_GLYPH[r.level]), document.createTextNode(` ${stateText(r)}`));
      const name = el('td', 'nm', r.ids.length > 1 ? `${r.name}` : rowName(r));
      if (r.ids.length > 1) name.append(el('span', 'dh-sub', ` (${t('dev.env.anyOf')})`));
      if (r.optional) name.append(el('span', 'dh-sub', ` · ${t('dev.env.optional')}`));
      const ver = el('td', 'ver', r.version || (r.state === 'missing' ? '—' : ''));
      const notes = [];
      if (r.note === 'shim') notes.push(t('dev.env.note.shim'));
      if (r.note === 'devPrompt') notes.push(t('dev.env.note.devPrompt'));
      if (r.note === 'timeout') notes.push(t('dev.env.note.timeout'));
      if (r.state === 'notOnPath' && r.path) notes.push(t('dev.env.note.notOnPath', { path: r.path.replace(/[\\/][^\\/]+$/, '') }));
      else if (r.path) ver.title = r.path;
      if (notes.length) ver.append(el('div', 'dh-sub', notes.join(' · ')));
      const need = el('td', 'need', r.range ? `${r.range}${r.rangeFrom ? ` (${r.rangeFrom})` : ''}` : '');
      const why = el('td', 'why', r.because === 'user' ? '✎' : r.because || t('dev.env.why.base'));
      const td = el('td', 'fix');
      const fix = el('div', 'fx');
      td.append(fix);
      if (['error', 'warn', 'off', 'unknown'].includes(r.level) && !(r.level === 'warn' && r.state === 'notOnPath')) {
        const id = r.pick || r.ids[0];
        const cmd = E.installHint(id);
        if (cmd) {
          const b = button(t('dev.env.copy'), cmd, () => copy(cmd));
          b.className = 'dh-cmd';
          fix.append(b);
        }
        if (E.TOOLS[id]?.url) {
          const g = button(t('dev.env.guide'), t('dev.env.guideTitle'), () => openGuide(id));
          g.className = 'linkish';
          fix.append(g);
        }
      }
      tr.append(st, name, ver, need, why, td);
      return tr;
    });
    // 프로젝트 안 패키지
    for (const p of env.pkgs) {
      const lvl = p.version ? 'ok' : 'warn';
      const tr = el('tr', `lvl-${lvl}`);
      const st = el('td', 'st');
      st.append(el('span', 'g', LEVEL_GLYPH[lvl]), document.createTextNode(` ${p.version ? t('dev.env.state.ok') : t('dev.env.pkgMissing')}`));
      tr.append(st, el('td', 'nm', t('dev.env.pkg', { name: p.pkg })), el('td', 'ver', p.version || '—'), el('td', 'need', ''), el('td', 'why', p.because), el('td', 'fix'));
      rows.push(tr);
    }
    $('#envRows').replaceChildren(...rows);
    const ready = env.readyAll || [];
    $('#envReady').replaceChildren(...(ready.length ? [el('h3', 'rm-h', t('dev.env.readyTitle')), ...ready.map((r) => readyLine(r, false))] : []));
    $('#envNote').textContent = canCheck() ? `${env.at ? t('dev.env.checkedAt', { time: new Date(env.at).toLocaleTimeString() }) : ''} ${t('dev.env.installNote')}` : t('dev.env.extNote');
    $('#envRecheck').disabled = env.checking;
    $('#envTerminal').hidden = !host.git?.openTerminal;
    renderEdit();
  }

  /** 필요한 도구 고치기: 묶음별 체크 상자 (체크 = 필요) */
  function renderEdit() {
    const pref = loadPref();
    const auto = E.detectNeeds(env.entries, env.texts);
    const autoIds = new Set(auto.flatMap((n) => (n.group ? [n.group] : [n.id])));
    const ign = new Set(pref.ignore);
    const add = new Set(pref.add);
    const groups = E.CATS.map((cat) => {
      const ids = E.TOOL_IDS.filter((id) => E.TOOLS[id].cat === cat);
      const box = el('fieldset', 'env-cat');
      box.append(el('legend', '', t(`dev.cat.${cat}`)));
      for (const id of ids) {
        const lab = el('label', 'check-label');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = (autoIds.has(id) && !ign.has(id)) || add.has(id);
        cb.addEventListener('change', () => toggleNeed(id, cb.checked, autoIds.has(id)));
        lab.append(cb, document.createTextNode(` ${E.TOOLS[id].name}`));
        box.append(lab);
      }
      return box;
    });
    // 묶음(C · C++ 컴파일러)이 자동으로 들어온 경우: 묶음째 끄는 칸
    for (const g of Object.keys(E.GROUPS)) {
      if (!autoIds.has(g)) continue;
      const lab = el('label', 'check-label');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !ign.has(g);
      cb.addEventListener('change', () => toggleNeed(g, cb.checked, true));
      lab.append(cb, document.createTextNode(` ${E.GROUPS[g].map((i) => E.TOOLS[i].name).join(' / ')} (${t('dev.env.anyOf')})`));
      groups.unshift(lab);
    }
    $('#envEditBody').replaceChildren(...groups);
  }

  function toggleNeed(id, on, isAuto) {
    const pref = loadPref();
    const ign = new Set(pref.ignore);
    const add = new Set(pref.add);
    if (on) {
      ign.delete(id);
      if (!isAuto) add.add(id);
    } else {
      add.delete(id);
      if (isAuto) ign.add(id);
    }
    savePref({ add: [...add], ignore: [...ign] });
    // 새로 더한 도구는 본체에 다시 물어야 하므로 점검을 다시 한다
    if (on && !isAuto && canCheck() && !env.found?.tools?.[id]) return check();
    const have = new Set(E.detectNeeds(env.entries, env.texts).map((n) => n.group || n.id));
    env.needs = [...E.detectNeeds(env.entries, env.texts), ...[...add].filter((x) => !have.has(x)).map((x) => ({ id: x, because: 'user' }))];
    env.ignore = ign;
    evaluate();
    render();
    renderModal();
    window.onDevEnvChecked?.(env);
  }

  function openModal() {
    if (modal) return closeModal();
    if (!projectId()) return;
    const dialog = state?.chatView === 'panels';
    modal = { dialog, pending: dialog };
    if (dialog) host.setView('dialog');
    $('#envModal').hidden = false;
    renderModal();
    if (!env.found && !env.checking && canCheck()) check();
    $('#envClose').focus();
  }
  function closeModal() {
    if (!modal) return;
    const { dialog } = modal;
    modal = null;
    $('#envModal').hidden = true;
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }

  // 패널 화면으로 돌아가면(Esc 등) 창을 닫는다 — 로드맵 창과 같은 규칙
  window.onDevState = () => {
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

  // 프로젝트를 열고 닫거나 바꾸면 그 프로젝트를 점검한다 (같은 프로젝트면 다시 그리기만)
  window.onDevProject = () => {
    const key = projectId();
    if (key === env.key) return render();
    env.key = key;
    Object.assign(env, { entries: [], texts: {}, needs: [], reqs: {}, ready: [], readyAll: [], pkgs: [], ports: [], found: null, rows: [], error: '', at: 0 });
    if (!key) {
      closeModal();
      return render();
    }
    check();
  };

  $('#dhEnvCheck').addEventListener('click', () => check());
  $('#dhEnvMore').addEventListener('click', () => openModal());
  $('#envRecheck').addEventListener('click', () => check());
  $('#envClose').addEventListener('click', () => closeModal());
  $('#envTerminal').addEventListener('click', () => host.git?.openTerminal?.());
  $('#envModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal();
    }
  });

  MLA.devHub = { env, check, render, openModal, closeModal, envLine: () => E.envLine(env.rows) };
})();
