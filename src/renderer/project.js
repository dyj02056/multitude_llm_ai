'use strict';

// 프로젝트 모드 화면: 로컬 폴더를 열어 파일 트리에서 고르고, 질문에 프로젝트 맥락을 붙이고,
// AI 답변의 NEED_FILES 요청에 답하고, 코드 수정안을 비교·미리보기·적용·되돌리기 한다.
//
// renderer.js 다음에 읽힌다 ($, state, panels, button, span, flash, fmtSize, attachments 등은 renderer.js의 것).
// 폴더 읽기·쓰기는 host.project (Windows 앱: src/main/project.js / 크롬 확장: extension/project-fs.js),
// 제외 규칙·맥락·업로드 파일·diff는 공통 모듈(MLA.projectIgnore · secretScan · projectContext · projectUpload · patch)이 한다.
//
// 프로젝트 파일은 AI에게 파일 업로드로 보낸다 (묶음 파일 / 개별 파일, 사이드바에서 고름 — shared/project-upload.js).
// 문서 첨부를 받지 않는 서비스와 업로드에 실패한 패널에는 같은 내용을 본문에 넣어 보낸다 (내부 예비 경로).

// [쉽게 말하면]
// 📁 프로젝트 기능의 화면 쪽 전부를 맡는 파일입니다. 큰 흐름은 이렇습니다.
//   1. 폴더 열기 → 왼쪽 사이드바에 파일 나무(트리) 표시, 보내면 안 되는 파일은 L1·L2·L3 표시
//   2. 보내기 → 고른 파일과 프로젝트 구조를 AI에게 첨부 파일로 함께 보냄 (답변 규칙도 붙임)
//   3. AI가 "NEED_FILES"로 파일을 더 달라고 하면 📂 버튼으로 보내 줌
//   4. AI 답변의 수정안 → 패널 아래 변경 바에서 바로 적용 · 되돌리기, 또는 변경 제안 화면에서 비교 · 미리보기 · 적용
//   5. 📋 파일 모아보기 → 경로와 전체 코드를 모아 복사 (파일에는 쓰지 않음)
//   6. 편집기 → 파일을 직접 고쳐 저장
// 전체를 (() => { … })() 로 감싼 이유: 이 안의 이름들이 다른 파일의 이름과 부딪히지 않게 "울타리"를 친 것입니다.
// 다른 파일과 주고받을 것만 window.이름 으로 바깥에 내놓습니다.
(() => {
  const PI = MLA.projectIgnore;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
  const PC = MLA.projectContext;
  const PU = MLA.projectUpload;
  const MODE_TEXT = { bundle: '묶음 파일', files: '개별 파일' };
  const PX = MLA.patch;

  const KEY_FILES = ['package.json', 'README.md', 'README', 'readme.md', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'tsconfig.json'];
  const MAX_LOG = 20; // 적용 기록은 최근 20개까지 (되돌리기용 원본 포함)

  const project = {
    info: null, // { name, id, needsPermission? }
    scan: null, // scanProject 결과
    open: false, // 사이드바를 보이는지
    include: true, // 다음 질문에 맥락을 붙일지
    uploadMode: PU.DEFAULT_MODE, // 올리는 방식: 'bundle'(묶음 파일) | 'files'(개별 파일)
    l3Enabled: [],
    checked: new Set(), // 내용을 보낼 파일
    allowSecret: new Set(), // 비밀 정보 경고를 보고도 보내기로 한 파일
    secretHits: new Map(), // path -> 찾은 비밀 정보
    expanded: new Set(['']), // 펼친 폴더
    log: [], // 적용 기록 [{ id, at, ai, files: [{ path, before, after }], reverted }]
    need: new Map(), // 패널 id -> 요청한 파일 목록
    sent: new Map(), // 패널 id -> Map(경로 -> 그 AI가 마지막으로 받은 내용, 지워진 파일은 null)
    stale: [], // ⟳ 뒤 AI가 아는 내용과 달라진 파일 [{ id, name, files: [{ path, text }], deleted: [경로] }]
    blocked: new Set(), // 이 프로젝트의 파일을 보내지 않을 서비스 id (질문 글만 보냄)
    uploadOk: new Set(), // 이 프로젝트의 파일을 올려도 된다고 확인한 서비스 id
    touched: new Map(), // 이번에 AI 수정안으로 바꾼 파일 경로 -> 'A'(새 파일) | 'M'(수정) — 트리에 표시
  };

  // 편집기에서 연 파일: path, base(열 때·저장할 때 디스크 내용 그대로), crlf(원래 줄바꿈), indent(Tab 키로 넣을 들여쓰기)
  const ed = { path: null, base: null, crlf: false, indent: '  ' };

  // fsx: 폴더 읽기·쓰기 창구 / has(): 프로젝트가 열려 있고 파일 목록까지 읽은 상태인지
  const fsx = () => host.project;
  const has = () => !!project.info && !project.info.needsPermission && !!project.scan;

  // ---------- 저장 ----------

  /** 이 프로젝트의 상태(고른 파일, 켠 규칙, 적용 기록 등)를 저장합니다. 다음에 같은 폴더를 열면 그대로 이어집니다. */
  function saveState() {
    if (!project.info || project.info.needsPermission) return;
    host.project
      .saveState({
        l3Enabled: project.l3Enabled,
        checked: [...project.checked],
        allowSecret: [...project.allowSecret],
        include: project.include,
        uploadMode: project.uploadMode,
        blocked: [...project.blocked],
        uploadOk: [...project.uploadOk],
        log: project.log.slice(0, MAX_LOG),
      })
      .catch((err) => console.warn('[project] 상태를 저장하지 못했습니다:', err.message));
  }

  async function loadState() {
    const s = (await host.project.loadState().catch(() => null)) || {};
    project.l3Enabled = Array.isArray(s.l3Enabled) ? s.l3Enabled : [];
    project.checked = new Set(Array.isArray(s.checked) ? s.checked : []);
    project.allowSecret = new Set(Array.isArray(s.allowSecret) ? s.allowSecret : []);
    project.include = s.include !== false;
    project.uploadMode = PU.normalizeMode(s.uploadMode);
    project.blocked = new Set(Array.isArray(s.blocked) ? s.blocked : []);
    project.uploadOk = new Set(Array.isArray(s.uploadOk) ? s.uploadOk : []);
    project.log = Array.isArray(s.log) ? s.log : [];
    return !!s.checked;
  }

  // ---------- 열기 · 훑기 ----------

  /** 프로젝트를 엽니다 (info가 null이면 닫음). 지난 상태를 불러오고 폴더를 훑은 뒤, 처음이면 핵심 파일을 미리 골라 둡니다. */
  async function openProject(info, { fresh = false } = {}) {
    project.info = info;
    project.scan = null;
    project.need.clear();
    project.sent.clear();
    project.stale = [];
    project.expanded = new Set(['']);
    project.touched.clear();
    clearBars();
    closeEditor();
    if (!info) return render();
    if (info.needsPermission) {
      project.open = true;
      return render();
    }
    const known = await loadState();
    await rescan();
    // 처음 연 프로젝트면 package.json · README 같은 핵심 파일을 골라 둔다.
    if (fresh || !known) {
      for (const e of project.scan.entries) if (e.depth === 0 && e.kind === 'file' && !e.excluded && KEY_FILES.includes(e.name)) project.checked.add(e.path);
    }
    project.open = true;
    saveState();
    render();
  }

  /** 폴더를 다시 훑어 파일 목록을 새로 만듭니다 (사이드바 ⟳ 버튼, 파일을 쓴 뒤 등). 사라진 파일은 고른 목록에서 뺍니다. */
  async function rescan() {
    $('#psSummary').textContent = '폴더를 읽는 중…';
    const globalExclude = await host.project.globalExclude().catch(() => null);
    project.scan = await PI.scanProject(fsx(), { l3Enabled: project.l3Enabled, globalExclude });
    // 고른 파일 중 사라진 것은 뺀다.
    const files = new Set(project.scan.entries.filter((e) => e.kind === 'file').map((e) => e.path));
    for (const p of [...project.checked]) if (!files.has(p)) project.checked.delete(p);
    render();
    await checkStale();
  }

  async function pickProject() {
    try {
      const info = await host.project.pick();
      if (info) await openProject(info, { fresh: true });
    } catch (err) {
      alert(`폴더를 열지 못했습니다: ${err.message}`);
    }
  }

  async function closeProject() {
    const draft = edDirty() ? `\n\n편집기에서 저장하지 않은 ${ed.path}의 수정 내용은 사라집니다.` : '';
    if (!confirm(`프로젝트를 닫을까요? (폴더의 파일은 그대로이고, 적용 기록은 다음에 같은 폴더를 열면 다시 보입니다)${draft}`)) return;
    await host.project.close().catch(() => {});
    project.open = false;
    await openProject(null);
  }

  $('#projectBtn').addEventListener('click', () => {
    if (!project.info) return pickProject();
    project.open = !project.open;
    if (project.open && state.chatView !== 'panels') host.setView('panels');
    render();
  });
  $('#psHide').addEventListener('click', () => {
    project.open = false;
    render();
  });
  $('#psClose').addEventListener('click', closeProject);
  $('#psRescan').addEventListener('click', () => has() && rescan());
  $('#psReconnect').addEventListener('click', async () => {
    try {
      const info = await host.project.reconnect();
      if (info) await openProject(info);
    } catch (err) {
      alert(err.message);
    }
  });
  $('#psUploadMode').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-umode]')?.dataset.umode;
    if (!mode || mode === project.uploadMode) return;
    project.uploadMode = PU.normalizeMode(mode);
    saveState();
    render();
  });
  $('#projectInclude').addEventListener('change', (e) => {
    project.include = e.target.checked;
    saveState();
    render();
  });

  // ---------- 화면 ----------

  const entryOf = (path) => project.scan?.entries.find((e) => e.path === path);
  const sendablePaths = () => project.scan.entries.filter((e) => e.kind === 'file' && (!e.excluded || project.checked.has(e.path))).map((e) => e.path);

  let sidebarSent = null; // 메인/host에 알린 사이드바 상태 (바뀔 때만 알린다 — 알리면 state가 다시 와서 render가 또 불린다)

  /** 사이드바 전체를 지금 상태에 맞게 다시 그립니다: 프로젝트 이름, 버튼, 요약, 규칙, 서비스, 파일 나무 */
  function render() {
    const showSide = project.open && !!project.info;
    document.body.classList.toggle('project-open', showSide);
    // 'dialog'(패널 화면 위에 띄운 창)에서도 뒤 배치가 흔들리지 않게 사이드바를 그대로 둔다
    const side = showSide && state?.mode === 'chat' && (state.chatView === 'panels' || state.chatView === 'dialog');
    if (side !== sidebarSent) {
      sidebarSent = side;
      host.setSidebar(side);
    }
    $('#projectBtn').classList.toggle('active', !!project.info);
    $('#projectBtn').textContent = project.info ? `📁 ${project.info.name}` : '📁 프로젝트';
    $('#psName').textContent = project.info?.name || '';
    $('#psConnect').hidden = !project.info?.needsPermission;
    $('#projectChip').hidden = !has();
    $('#psGit').hidden = !has() || !host.git; // git 콘솔은 Windows 앱에만 있다
    $('#projectInclude').checked = project.include;
    for (const b of document.querySelectorAll('#psUploadMode [data-umode]')) b.classList.toggle('active', b.dataset.umode === project.uploadMode);
    if (!has()) {
      $('#psTree').replaceChildren();
      $('#psRulesBody').replaceChildren();
      $('#psSummary').textContent = '';
      return;
    }
    renderRules();
    renderServices();
    renderTree();
    const chars = [...project.checked].reduce((n, p) => n + (entryOf(p)?.size || 0), 0);
    const amount = chars < 10000 ? `${chars.toLocaleString()}자` : `${(chars / 10000).toFixed(1)}만 자`;
    const summary = `내용 보낼 파일 ${project.checked.size}개 · 약 ${amount} / 보낼 수 있는 파일 ${sendablePaths().length}개`;
    $('#psSummary').textContent = project.scan.truncated ? `${summary} (항목이 많아 일부만 읽음)` : summary;
    $('#projectChipText').textContent = `📁 ${project.info.name} · 파일 ${project.checked.size}개 · ${MODE_TEXT[project.uploadMode]}로 업로드`;
  }

  /** 서비스마다 이 프로젝트의 파일을 보낼지 (끄면 그 서비스에는 질문 글만 보낸다) */
  // "프로젝트 파일을 보낼 서비스" 체크 상자들. 끈 서비스에는 질문 글만 보냅니다.
  function renderServices() {
    const rows = state.services.map((s) => {
      const row = span('rule-row', '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !project.blocked.has(s.id);
      box.addEventListener('change', () => {
        if (box.checked) project.blocked.delete(s.id);
        else project.blocked.add(s.id);
        saveState();
        render();
      });
      const label = document.createElement('label');
      label.append(box, ` ${s.name}`);
      row.append(label, span('muted-label', box.checked ? '구조·파일 업로드' : '질문 글만'));
      return row;
    });
    $('#psServicesBody').replaceChildren(...rows);
    $('#psServices').querySelector('summary').textContent = project.blocked.size
      ? `프로젝트 파일을 보낼 서비스 (${project.blocked.size}곳 제외)`
      : '프로젝트 파일을 보낼 서비스';
  }

  const nameOf = (id) => state.services.find((s) => s.id === id)?.name || id;

  /**
   * 프로젝트 파일을 처음 올리는 서비스가 있으면 어디로 가는지 확인한다. 취소하면 false.
   * 한 번 확인한 서비스는 이 프로젝트에서 다시 묻지 않는다 (사이드바 "보낼 서비스"에서 끌 수 있음).
   */
  // 프로젝트 파일을 어떤 서비스에 처음 올릴 때 한 번 확인합니다 (각 회사 서버에 저장되고 학습에 쓰일 수 있으므로).
  function confirmUpload(ids, fileCount) {
    const fresh = ids.filter((id) => !project.uploadOk.has(id));
    if (!fresh.length) return true;
    const ok = confirm(
      [
        `프로젝트 ${project.info.name}의 구조와 파일 ${fileCount}개 내용을 다음 서비스에 처음 올립니다:`,
        ...fresh.map((id) => `- ${nameOf(id)}`),
        '',
        '올린 내용은 각 회사 서버에 저장되고, 서비스 설정에 따라 학습에 쓰일 수 있습니다.',
        '보내지 않을 서비스는 사이드바의 "프로젝트 파일을 보낼 서비스"에서 끌 수 있습니다.',
        '',
        '확인: 올리기 (이 프로젝트에서 다시 묻지 않음)',
        '취소: 보내지 않기',
      ].join('\n'),
    );
    if (!ok) return false;
    for (const id of fresh) project.uploadOk.add(id);
    saveState();
    return true;
  }

  /** 이 서비스에 프로젝트 파일을 보내도 되는지. 안 되면 알리고 false */
  function allowedFor(id) {
    if (!project.blocked.has(id)) return true;
    alert(`${nameOf(id)}은(는) 이 프로젝트의 파일을 보내지 않도록 설정되어 있습니다. (사이드바 "프로젝트 파일을 보낼 서비스")`);
    return false;
  }

  // 선택 제외 규칙(L3: .dockerignore 등) 켜기/끄기 목록
  function renderRules() {
    const s = project.scan;
    const rows = [];
    const l2 = s.l2Found.length ? s.l2Found.join(', ') : '없음';
    rows.push(span('rule-row', `항상 제외: 앱 내장 규칙(비밀·키·바이너리·1MB 초과·.git·node_modules)`));
    rows.push(span('rule-row', `기본 적용: ${l2}`));
    if (!s.l3Found.length) rows.push(span('rule-row', '선택 적용: (해당 파일 없음)'));
    for (const f of s.l3Found) {
      const row = document.createElement('label');
      row.className = 'rule-row';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.enabled });
      box.addEventListener('change', async () => {
        project.l3Enabled = box.checked ? [...new Set([...project.l3Enabled, f.source])] : project.l3Enabled.filter((x) => x !== f.source);
        saveState();
        await rescan();
      });
      row.append(box, span('', f.source), span('muted-label', f.enabled ? '적용 중' : `켜면 ${f.count}개 더 제외`));
      rows.push(row);
    }
    $('#psRulesBody').replaceChildren(...rows);
  }

  /** 펼친 폴더 안의 항목만 보여 준다 */
  function visibleEntries() {
    const out = [];
    const hidden = []; // 접힌 폴더 경로들
    for (const e of project.scan.entries) {
      if (hidden.some((h) => e.path.startsWith(`${h}/`))) continue;
      out.push(e);
      if (e.kind === 'dir' && !project.expanded.has(e.path)) hidden.push(e.path);
    }
    return out;
  }

  const filesUnder = (dir) => project.scan.entries.filter((e) => e.kind === 'file' && !e.excluded && e.path.startsWith(`${dir}/`));

  /** 파일 나무를 그립니다: 접기/펼치기 ▸▾, 보낼 파일 체크, 제외 표시(L1·L2·L3), ⚠ 비밀?, 크기. 파일 이름을 누르면 편집기가 열립니다. */
  function renderTree() {
    const rows = visibleEntries().map((e) => {
      const row = document.createElement('div');
      row.className = `ps-row ${e.kind === 'dir' ? 'dir' : 'file'}${e.excluded ? ' excl' : ''}`;
      row.style.paddingLeft = `${e.depth * 14}px`;
      const twisty = span('twisty', e.kind === 'dir' ? (project.expanded.has(e.path) ? '▾' : '▸') : '');
      if (e.kind === 'dir') twisty.addEventListener('click', () => toggleDir(e));
      const box = document.createElement('input');
      box.type = 'checkbox';
      if (e.kind === 'dir') {
        const under = filesUnder(e.path);
        box.checked = under.length > 0 && under.every((f) => project.checked.has(f.path));
        box.indeterminate = !box.checked && under.some((f) => project.checked.has(f.path));
        box.disabled = !!e.excluded || !under.length;
        box.addEventListener('change', () => {
          for (const f of under) box.checked ? project.checked.add(f.path) : project.checked.delete(f.path);
          saveState();
          render();
        });
      } else {
        box.checked = project.checked.has(e.path);
        box.disabled = e.excluded?.layer === 'L1' || e.kind === 'link';
        box.addEventListener('change', () => toggleFile(e, box.checked));
      }
      const name = span('nm', e.kind === 'dir' ? `${e.name}/` : e.name);
      name.title = e.path;
      row.append(twisty, box, name);
      if (e.excluded) {
        const tag = span(`tag ${e.excluded.layer}`, e.excluded.layer);
        tag.title = `제외됨: ${PI.describe(e.excluded)}${e.excluded.layer === 'L1' ? ' — 앱 내장 규칙이라 보낼 수 없습니다' : ' — 체크하면 이 파일만 보냅니다'}`;
        row.append(tag);
      }
      const hits = project.secretHits.get(e.path);
      if (hits?.length) {
        const tag = span('tag secret', '⚠ 비밀?');
        tag.title = `비밀 정보로 보이는 문자열: ${describeSecrets(hits)}`;
        row.append(tag);
      }
      const touched = project.touched.get(e.path);
      if (touched) {
        const tag = span(`tag touched ${touched}`, touched);
        tag.title = touched === 'A' ? 'AI 수정안으로 새로 만든 파일' : 'AI 수정안으로 바꾼 파일';
        row.append(tag);
      }
      if (e.kind === 'file') row.append(span('sz', fmtSize(e.size)));
      if (e.kind === 'dir') name.addEventListener('click', () => toggleDir(e));
      else if (e.kind === 'file' && e.excluded?.layer !== 'L1') {
        name.title = `${e.path}\n누르면 편집기에서 엽니다`;
        name.addEventListener('click', () => openEditor(e.path));
      }
      if (e.path === ed.path) row.classList.add('editing');
      return row;
    });
    $('#psTree').replaceChildren(...rows);
  }

  async function toggleDir(e) {
    if (project.expanded.has(e.path)) project.expanded.delete(e.path);
    else {
      project.expanded.add(e.path);
      // 제외된 폴더(L2·L3)는 처음 펼칠 때 안을 읽는다 (안의 파일을 하나씩 골라 넣을 수 있게).
      if (e.excluded && e.excluded.layer !== 'L1' && !project.scan.entries.some((x) => x.path.startsWith(`${e.path}/`))) {
        try {
          const children = await PI.expandExcluded(fsx(), project.scan.matcher, e);
          const at = project.scan.entries.indexOf(e);
          project.scan.entries.splice(at + 1, 0, ...children);
        } catch (err) {
          alert(`폴더를 읽지 못했습니다: ${err.message}`);
        }
      }
    }
    renderTree();
  }

  // 파일 체크/해제. 체크할 때 비밀 정보가 보이면 한 번 더 묻습니다.
  async function toggleFile(e, on) {
    if (!on) {
      project.checked.delete(e.path);
      saveState();
      return render();
    }
    // 고를 때 비밀 정보를 먼저 본다.
    const r = await host.project.readFile(e.path).catch((err) => ({ error: err.message }));
    if (r.binary || r.tooLarge || r.missing || r.error) {
      alert(`이 파일은 보낼 수 없습니다: ${r.binary ? '바이너리 파일' : r.tooLarge ? '1MB 초과' : r.missing ? '파일이 없습니다' : r.error}`);
      return render();
    }
    const hits = scanSecrets(r.text);
    project.secretHits.set(e.path, hits);
    if (hits.length && !project.allowSecret.has(e.path)) {
      if (!confirm(`${e.path}에 비밀 정보로 보이는 문자열이 있습니다:\n${describeSecrets(hits)}\n\n그래도 AI에게 보낼 파일로 고를까요?`)) return render();
      project.allowSecret.add(e.path);
    }
    project.checked.add(e.path);
    saveState();
    render();
  }

  // ---------- 보내기 (renderer.js send()가 부른다) ----------

  /** 고른 파일들을 읽는다. 비밀 정보가 새로 보이면 확인을 받는다. → { files, skipped } | null(취소) */
  // 고른 파일들의 내용을 읽어 옵니다. 너무 크거나 바이너리·비밀 정보 파일은 빼고 이유를 남깁니다.
  async function readChosen(paths) {
    const files = [];
    const skipped = [];
    const risky = [];
    for (const path of paths) {
      const r = await host.project.readFile(path).catch((err) => ({ error: err.message }));
      if (typeof r.text !== 'string') {
        skipped.push({ path, reason: r.binary ? '바이너리 파일' : r.tooLarge ? '1MB 초과' : r.missing ? '파일이 없습니다' : r.error || '읽지 못함' });
        continue;
      }
      const hits = scanSecrets(r.text);
      project.secretHits.set(path, hits);
      if (hits.length && !project.allowSecret.has(path)) risky.push({ path, hits });
      files.push({ path, text: r.text });
    }
    if (risky.length) {
      const list = risky.map((x) => `- ${x.path}: ${describeSecrets(x.hits)}`).join('\n');
      if (!confirm(`비밀 정보로 보이는 문자열이 있는 파일이 있습니다:\n${list}\n\n확인: 그래도 함께 보내기\n취소: 이 파일들은 빼고 보내기`)) {
        for (const x of risky) {
          const i = files.findIndex((f) => f.path === x.path);
          if (i >= 0) files.splice(i, 1);
          skipped.push({ path: x.path, reason: '비밀 정보로 보이는 문자열이 있어 보내지 않음' });
        }
      } else for (const x of risky) project.allowSecret.add(x.path);
    }
    return { files, skipped };
  }

  const toAttachment = ({ name, type, text }) => {
    const data = new TextEncoder().encode(text).buffer;
    return { name, type, lastModified: Date.now(), data };
  };
  const acceptsDocs = (id) => !!state.services.find((s) => s.id === id)?.accept.includes('document');
  const notice = (text) => flash($('#psSummary'), text);

  /** 첨부 한도 중 이미 쓴 만큼(사용자가 직접 올린 파일)을 뺀 나머지 */
  // 첨부 한도(10개, 50MB) 중 사용자가 직접 올린 파일을 빼고 프로젝트 파일에 쓸 수 있는 남은 양
  function budgetAfter(files = []) {
    const L = state.attachLimits || { maxFiles: 10, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 };
    const used = files.reduce((n, f) => n + (f.data?.byteLength || 0), 0);
    return { files: L.maxFiles - files.length, bytes: L.maxTotalBytes - used, fileBytes: L.maxFileBytes };
  }

  // 템플릿 변수 {{프로젝트}} · {{선택 파일}} 값 (library.js)
  window.projectBuiltins = () => (has() ? { 프로젝트: project.info.name, '선택 파일': [...project.checked].join(', ') } : {});

  window.projectPrepareSend = async (payload, targetIds) => {
    if (!has() || !project.include) return payload;
    const withProject = targetIds.filter((id) => !project.blocked.has(id));
    const plainIds = targetIds.filter((id) => project.blocked.has(id));
    if (!withProject.length) return payload; // 모두 보내지 않기로 한 서비스 — 질문만 보낸다
    if (!confirmUpload(withProject, project.checked.size)) return null;
    const { files } = await readChosen([...project.checked]);
    const budget = budgetAfter(payload.files);
    const pack = PU.packContext({ project: { name: project.info.name, paths: sendablePaths() }, files, request: payload.text, mode: project.uploadMode, budget });
    const ups = pack.attachments.map(toAttachment);
    const room = ups.length <= budget.files && ups.reduce((n, f) => n + f.data.byteLength, 0) <= budget.bytes;
    // 직접 올린 파일 때문에 자리가 없으면 프로젝트 내용은 본문으로 보낸다
    if (!room) notice('첨부 한도가 모자라 프로젝트 내용은 본문으로 보냅니다');
    const textById = {};
    // 문서 첨부를 받지 않는 서비스(예: Duck.ai)에는 내용을 본문으로 넣는다 (넘치는 만큼 잘라서).
    for (const id of withProject) if (!room || !acceptsDocs(id)) textById[id] = pack.inlineText;
    // 보내지 않기로 한 서비스에는 원래 질문과 사용자가 직접 올린 파일만 (plainIds · userFileCount)
    for (const id of plainIds) textById[id] = payload.text;
    if (pack.note) notice(pack.note);
    pendingSent = files; // 보내기에 성공한 패널만 renderer.js가 onProjectSent로 알려 준다
    return {
      text: pack.text,
      files: room ? [...payload.files, ...ups] : [...payload.files],
      opts: {
        ...payload.opts,
        question: `${payload.text || '(첨부 파일만)'}\n\n[프로젝트 ${project.info.name} · 파일 ${files.length}개 내용 포함]`,
        textById,
        fallbackText: pack.inlineText,
        plainIds,
        userFileCount: payload.files.length,
      },
    };
  };

  /** 패널 하나에 프로젝트 파일을 이어서 보낸다 (요청 파일 보내기 · 다시 보내기). pack: PU.pack* 결과 */
  // 패널 하나에만 이어서 보내기 (요청 파일, 바뀐 파일, 전체 파일 다시 요청에 씀)
  async function sendProjectFollowUp(id, pack) {
    if (project.blocked.has(id)) return { ok: false, error: '이 프로젝트의 파일을 보내지 않도록 설정된 서비스' };
    if (pack.note) notice(pack.note);
    if (!acceptsDocs(id)) return host.sendFollowUp(id, pack.inlineText);
    return host.sendFollowUp(id, pack.text, pack.attachments.map(toAttachment), { fallbackText: pack.inlineText });
  }

  // ---------- AI가 아는 내용 · 바뀐 파일 다시 보내기 ----------
  // 패널마다 그 AI에게 마지막으로 보낸 파일 내용을 기억해 두고, ⟳(다시 읽기) 때 로컬 파일과 비교한다.
  // 달라진 파일이 있으면 사이드바에 "바뀐 파일 보내기"를 띄워 그 탭들에 지금 내용을 바로 보낸다.

  let pendingSent = null; // projectPrepareSend가 붙인 파일 (보내기 결과를 기다리는 중)

  const sameText = (a, b) => (a === null || b === null ? a === b : a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n'));

  /** id 패널의 AI가 files 내용을 받았다고 기록한다. files: [{ path, text(지워졌으면 null) }] */
  // "이 AI는 이 파일을 이 내용으로 알고 있다"를 기억합니다. 나중에 파일이 바뀌면 그 AI에게 바뀐 내용을 보내 주려고.
  function remember(id, files) {
    if (!files.length) return;
    if (!project.sent.has(id)) project.sent.set(id, new Map());
    const known = project.sent.get(id);
    for (const f of files) known.set(f.path, f.text);
  }

  window.onProjectSent = (okIds) => {
    const files = pendingSent;
    pendingSent = null;
    if (!files || !has()) return;
    for (const id of okIds) if (!project.blocked.has(id)) remember(id, files);
  };

  // 새 대화를 열면 그 AI는 이전 내용을 모른다.
  window.onPanelCleared = (id) => {
    project.sent.delete(id);
    project.stale = project.stale.filter((s) => s.id !== id);
    renderSync();
  };

  /** AI마다 아는 내용과 지금 파일을 비교한다 */
  // AI가 아는 내용과 지금 파일이 달라진 것을 찾아 "⇪ 바뀐 파일 N개 → AI에 보내기" 버튼을 띄웁니다.
  async function checkStale() {
    const stale = [];
    const now = new Map(); // 같은 파일을 여러 번 읽지 않는다
    const read = async (path) => {
      if (!now.has(path)) now.set(path, await currentText(path).catch(() => undefined));
      return now.get(path);
    };
    for (const [id, known] of project.sent) {
      if (!panels.has(id)) continue;
      const files = [];
      const deleted = [];
      for (const [path, text] of known) {
        const cur = await read(path);
        if (cur === undefined || sameText(cur, text)) continue; // 읽지 못한 파일(바이너리·너무 큼)은 건너뛴다
        if (cur === null) deleted.push(path);
        else files.push({ path, text: cur });
      }
      if (files.length || deleted.length) stale.push({ id, name: state.services.find((s) => s.id === id)?.name || id, files, deleted });
    }
    project.stale = stale;
    renderSync();
  }

  function renderSync() {
    const btn = $('#psSync');
    const paths = new Set(project.stale.flatMap((s) => [...s.files.map((f) => f.path), ...s.deleted]));
    btn.hidden = !has() || !paths.size;
    btn.textContent = `⇪ 바뀐 파일 ${paths.size}개 → AI ${project.stale.length}곳에 보내기`;
    btn.title = project.stale.map((s) => `${s.name}: ${[...s.files.map((f) => f.path), ...s.deleted.map((p) => `${p} (지움)`)].join(', ')}`).join('\n');
  }

  $('#psSync').addEventListener('click', () => syncStale());

  /** 바뀐 파일을 AI 탭들에 보낸다. onlyPath를 주면 그 파일만. 결과: 보낸 AI 수 */
  // 바뀐 파일을 그 파일을 아는 AI 탭들에 보냅니다 (onlyPath가 있으면 그 파일만).
  async function syncStale(onlyPath) {
    if (!has()) return 0;
    const stale = project.stale
      .map((s) => (onlyPath ? { ...s, files: s.files.filter((f) => f.path === onlyPath), deleted: s.deleted.filter((p) => p === onlyPath) } : s))
      .filter((s) => s.files.length || s.deleted.length);
    if (!stale.length) return 0;
    const summary = ['로컬에서 바뀐 파일의 지금 내용을 각 AI 탭에 보냅니다.', ''];
    for (const s of stale) {
      summary.push(`[${s.name}]`, listLines([...s.files.map((f) => f.path), ...s.deleted.map((p) => `${p} (지움)`)], (p) => `- ${p}`), '');
    }
    summary.push('보낼까요? (AI에게는 바뀐 점만 확인하고 아직 수정하지 말라고 부탁합니다)');
    if (!confirm(summary.join('\n'))) return 0;
    // 바뀐 내용에 비밀 정보가 새로 생겼을 수 있다.
    const risky = new Map();
    for (const s of stale) {
      for (const f of s.files) {
        if (risky.has(f.path) || project.allowSecret.has(f.path)) continue;
        const hits = scanSecrets(f.text);
        project.secretHits.set(f.path, hits);
        if (hits.length) risky.set(f.path, hits);
      }
    }
    let withRisky = true;
    if (risky.size) {
      const list = listLines([...risky], ([p, hits]) => `- ${p}: ${describeSecrets(hits)}`);
      withRisky = confirm(`비밀 정보로 보이는 문자열이 있는 파일입니다:\n${list}\n\n이 파일들도 함께 보낼까요? (취소하면 빼고 보냅니다)`);
      if (withRisky) for (const p of risky.keys()) project.allowSecret.add(p);
    }
    const failed = [];
    let sent = 0;
    for (const s of stale) {
      const files = s.files.filter((f) => withRisky || !risky.has(f.path));
      if (!files.length && !s.deleted.length) continue;
      const res = await sendProjectFollowUp(s.id, PU.packUpdate({ files, deleted: s.deleted, mode: project.uploadMode, budget: budgetAfter() }));
      if (res?.ok) {
        remember(s.id, [...files, ...s.deleted.map((path) => ({ path, text: null }))]);
        sent++;
      } else failed.push(`${s.name}: ${res?.error || '알 수 없는 오류'}`);
    }
    await checkStale();
    if (failed.length) alert(`보내지 못했습니다:\n${failed.join('\n')}`);
    else notice('바뀐 파일을 보냈습니다');
    return sent;
  }

  // ---------- NEED_FILES ----------

  /** 패널 하나의 최신 답변 Markdown (그 패널만 읽는다 — 열린 패널을 다 읽으면 답변이 끝날 때마다 느려진다) */
  async function answerMd(id) {
    return (await host.getAnswer(id))?.md || '';
  }

  window.onPanelAnswerDone = async (id) => {
    const md = await answerMd(id).catch(() => '');
    // 프로젝트가 열려 있으면 수정안을 패널 아래 변경 바로 보여 준다 (📋 모아보기도 바 안에). 바를 띄우지 않으면 머리줄 버튼.
    const barred = has() && (await refreshBar(id, md).catch(() => false));
    if (!barred) showCollectBtn(id, md).catch(() => {});
    if (!has()) return;
    // 개별 파일 방식이면 AI가 올린 이름(src__a__index.js)으로 요청할 수 있어 실제 경로로 되돌린다
    const wanted = [...new Set(PC.parseNeedFiles(md).map((p) => PU.restorePaths(p).find((c) => entryOf(c)) || p))];
    const p = panels.get(id);
    if (!p) return;
    project.need.set(id, wanted);
    p.needBtn.hidden = !wanted.length;
    p.needBtn.textContent = `📂 요청 파일 ${wanted.length}개 보내기`;
    p.needBtn.title = `AI가 내용을 보고 싶다고 한 파일:\n${wanted.join('\n')}`;
  };

  /** 요청 경로가 보내도 되는 파일인지. 안 되면 이유 */
  function refuseReason(path) {
    const clean = PX.safeRelPath(path);
    if (!clean) return '허용되지 않는 경로';
    const e = entryOf(clean);
    if (e?.excluded) return `제외 규칙: ${PI.describe(e.excluded)}`;
    // 훑지 않은(제외된 폴더 안) 경로도 규칙으로 다시 본다.
    const r = project.scan.matcher.classify(clean, false);
    if (r) return `제외 규칙: ${PI.describe(r)}`;
    if (!e) return '프로젝트에 없는 파일';
    return null;
  }

  const listLines = (items, fmt) => items.slice(0, 15).map(fmt).join('\n') + (items.length > 15 ? `\n… 외 ${items.length - 15}개` : '');

  /**
   * AI가 요청한 파일 보내기. 보내기 전에 "보낼 파일 / 보내지 않을 파일과 이유" 목록을 확인 창으로 보여 준다.
   * 비밀 정보로 보이는 파일은 기본으로 빼고, 한 번 더 물어서 사용자가 원할 때만 넣는다.
   * (확인 창은 브라우저 기본 창이라 Windows 앱에서도 서비스 패널 위에 뜬다)
   */
  window.onNeedFilesClick = async (id) => {
    if (!has()) return alert('프로젝트가 열려 있지 않습니다');
    if (!allowedFor(id)) return;
    const name = state.services.find((s) => s.id === id)?.name || id;
    const wanted = project.need.get(id) || [];
    const skipped = [];
    const files = [];
    const risky = [];
    for (const path of wanted) {
      const why = refuseReason(path);
      if (why) {
        skipped.push({ path, reason: why });
        continue;
      }
      const clean = PX.safeRelPath(path);
      const r = await host.project.readFile(clean).catch((err) => ({ error: err.message }));
      if (typeof r.text !== 'string') {
        skipped.push({ path: clean, reason: r.binary ? '바이너리 파일' : r.tooLarge ? '1MB 초과' : r.missing ? '파일이 없습니다' : r.error || '읽지 못함' });
        continue;
      }
      const hits = scanSecrets(r.text);
      project.secretHits.set(clean, hits);
      if (hits.length) risky.push({ path: clean, text: r.text, hits });
      else files.push({ path: clean, text: r.text });
    }
    const summary = [
      `${name}이(가) 요청한 파일을 보냅니다.`,
      '',
      `[보낼 파일 ${files.length}개]`,
      files.length ? listLines(files, (f) => `- ${f.path}`) : '(없음)',
    ];
    if (risky.length) summary.push('', `[비밀 정보가 보여 빼는 파일 ${risky.length}개]`, listLines(risky, (f) => `- ${f.path}: ${describeSecrets(f.hits)}`));
    if (skipped.length) summary.push('', `[보내지 않는 파일 ${skipped.length}개]`, listLines(skipped, (f) => `- ${f.path}: ${f.reason}`));
    summary.push('', '보낼까요? (보내지 않는 파일은 이유만 함께 알려 줍니다)');
    if (!confirm(summary.join('\n'))) return;
    if (risky.length) {
      const list = listLines(risky, (f) => `- ${f.path}: ${describeSecrets(f.hits)}`);
      if (confirm(`비밀 정보로 보이는 문자열이 있는 파일입니다:\n${list}\n\n이 파일들도 함께 보낼까요? (취소하면 빼고 보냅니다)`)) {
        for (const f of risky) {
          files.push({ path: f.path, text: f.text });
          project.allowSecret.add(f.path);
        }
      } else for (const f of risky) skipped.push({ path: f.path, reason: '비밀 정보로 보이는 문자열이 있어 보내지 않음' });
    }
    const p = panels.get(id);
    p.needBtn.hidden = true;
    const res = await sendProjectFollowUp(id, PU.packFollowUp({ files, skipped, mode: project.uploadMode, budget: budgetAfter() }));
    if (!res?.ok) alert(`보내지 못했습니다: ${res?.error || '알 수 없는 오류'}`);
    else remember(id, files);
  };

  // ---------- 변경 제안 ----------

  let plansByAi = []; // [{ id, name, color, plans: [{ change, plan, block }] }]

  // 지금 디스크에 있는 파일 내용 (없으면 null). 5MB까지 읽습니다.
  async function currentText(path) {
    const r = await host.project.readFile(path, { maxBytes: 5 * 1024 * 1024 });
    if (r.missing) return null;
    if (typeof r.text !== 'string') throw new Error(r.binary ? '바이너리 파일' : '파일이 너무 큽니다');
    return r.text;
  }

  /** 앱 내장 제외(L1) 경로(.env, .git, node_modules 등)는 쓰지 않는다 */
  const writeBlocked = (path) => {
    const r = project.scan.matcher.classify(path, false);
    return r && r.layer === 'L1' ? `앱 내장 제외 경로라 쓰지 않습니다 (${PI.describe(r)})` : null;
  };

  /** 답변 하나의 수정안을 찾고, 지금 파일에 적용하면 어떻게 되는지 미리 계산합니다. [{ change, plan }] */
  async function planAnswer(md) {
    const plans = [];
    for (const change of PX.extractChanges(md || '')) {
      const block = writeBlocked(change.path);
      let plan;
      try {
        plan = block ? { path: change.path, ok: false, error: block, op: 'modify' } : PX.planChange(change, await currentText(change.path));
      } catch (err) {
        plan = { path: change.path, ok: false, error: err.message, op: 'modify' };
      }
      plans.push({ change, plan });
    }
    return plans;
  }

  // 열린 모든 AI의 답변에서 수정안을 찾고, 지금 파일에 적용하면 어떻게 되는지 미리 계산합니다.
  async function planAll() {
    const { answers } = await host.getAnswers();
    const out = [];
    for (const a of answers) out.push({ id: a.id, name: a.name, color: a.color, plans: await planAnswer(a.md) });
    return out;
  }

  const OP_TEXT = { modify: '수정', create: '새 파일', delete: '삭제' };

  // ---------- 패널 변경 바 ----------
  // 프로젝트가 열려 있고 답변에 수정안이 있으면 그 패널 아래에 바를 띄운다: 바뀌는 파일 요약과 [적용] 한 번.
  // [적용]은 미리보기 창에서 기본으로 체크되는 파일(실행 영향·삭제가 아닌 것)만 바로 쓴다. 나머지는 [변경 보기]에서 골라 적용.
  // 적용하면 바가 "적용됨 · 되돌리기"로 바뀐다. 새 질문을 보내거나 새 대화를 열면 바를 내린다 (renderer.js setChangeBar).

  const SAME_TEXT = '바뀌는 내용이 없습니다'; // planChange: 이미 적용된 수정안
  const bars = new Map(); // 패널 id -> { ai: { id, name, color, plans }, applied: 적용 기록 항목 | null }

  /** 확인 없이 바로 써도 되는 수정안인지 (미리보기 창의 기본 체크와 같은 기준) */
  const isQuick = ({ plan }) => plan.ok && plan.op !== 'delete' && !PX.executionRisk(plan.path, plan.before, plan.after);

  function clearBars() {
    for (const id of bars.keys()) setChangeBar(id, false);
    bars.clear();
  }

  /** 패널 하나의 답변을 다시 읽어 바를 새로 그린다. 바를 띄웠으면 true */
  async function refreshBar(id, md) {
    const svc = state.services.find((s) => s.id === id);
    if (!has() || !svc) return false;
    const plans = await planAnswer(md ?? (await answerMd(id)));
    bars.set(id, { ai: { id, name: svc.name, color: svc.color, plans }, applied: null });
    return renderBar(id);
  }

  /** 적용하거나 되돌린 뒤: 아직 적용하지 않은 다른 패널의 바를 지금 파일 기준으로 다시 계산한다 */
  async function refreshOtherBars(skipId) {
    for (const [id, b] of [...bars]) if (id !== skipId && !b.applied) await refreshBar(id).catch(() => {});
  }

  const sumLine = (plans) => plans.map(({ plan }) => `${OP_TEXT[plan.op]} ${plan.path} +${plan.add} −${plan.del}`).join('\n');

  /** 바 그리기. 보여 줄 것이 없으면 내리고 false */
  function renderBar(id) {
    const p = panels.get(id);
    const b = bars.get(id);
    if (!p || !b) {
      setChangeBar(id, false);
      return false;
    }
    const bar = p.changeBar;
    const close = button('✕', '변경 바 닫기 (수정안은 변경 제안 화면에서 다시 볼 수 있습니다)', () => {
      bars.delete(id);
      setChangeBar(id, false);
    });
    close.className = 'cb-close';

    if (b.applied) {
      const { files } = b.applied;
      const undo = button('되돌리기', '적용하기 전 내용으로 되돌립니다 (새로 만든 파일은 지웁니다)', async () => {
        undo.disabled = true;
        await revert(b.applied);
        undo.disabled = false;
      });
      const text = span('cb-text', `${files.length}개 파일 적용됨 · ${files.map((f) => f.path).join(', ')}`);
      text.title = files.map((f) => f.path).join('\n');
      bar.className = 'change-bar applied';
      bar.replaceChildren(span('cb-icon', '✓'), text, undo, close);
      p.collectBtn.hidden = true;
      setChangeBar(id, true);
      return true;
    }

    const { ai } = b;
    const live = ai.plans.filter((x) => x.plan.ok);
    const quick = live.filter(isQuick);
    const look = live.filter((x) => !isQuick(x));
    const bad = ai.plans.filter((x) => !x.plan.ok && x.plan.error !== SAME_TEXT);
    if (!live.length && !bad.length) {
      // 수정안이 없거나 이미 모두 적용된 내용
      bars.delete(id);
      setChangeBar(id, false);
      return false;
    }
    const add = live.reduce((n, x) => n + x.plan.add, 0);
    const del = live.reduce((n, x) => n + x.plan.del, 0);
    const text = span('cb-text', '');
    text.append(span('cb-count', live.length ? `파일 ${live.length}개 변경` : '적용할 수 있는 수정안 없음'));
    if (live.length) text.append(span('add', ` +${add}`), span('del', ` −${del}`), span('cb-files', ` · ${live.map((x) => x.plan.path).join(', ')}`));
    text.title = [
      sumLine(live),
      look.length ? `\n확인 후 적용 (실행 영향·삭제):\n${sumLine(look)}` : '',
      bad.length ? `\n적용 불가:\n${bad.map(({ plan }) => `${plan.path}: ${plan.error}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const notes = [];
    if (look.length) notes.push(span('cb-warn', `⚠ ${look.length}개 확인 필요`));
    if (bad.length) notes.push(span('cb-bad', `${bad.length}개 적용 불가`));

    const collect = button('📋', `${ai.name}의 수정안을 경로와 전체 코드로 모아 복사합니다 (파일에는 쓰지 않음)`, () => window.onCollectClick(id));
    const view = live.length
      ? button('변경 보기', '파일마다 바뀌는 줄을 보고 골라서 적용합니다', () => openPreview(ai))
      : button('변경 제안에서 보기', '변경 제안 화면에서 전체 파일 다시 요청 등을 할 수 있습니다', () => host.setView('changes'));
    const btns = [collect, view];
    if (live.length) {
      const apply = button(
        quick.length ? `적용 (${quick.length})` : '골라서 적용',
        quick.length
          ? `바로 씁니다:\n${sumLine(quick)}${look.length ? `\n\n확인이 필요한 ${look.length}개는 빼고 씁니다 — "변경 보기"에서 골라 적용` : ''}\n\n적용 전 원본은 되돌릴 수 있습니다`
          : '실행 영향 파일·삭제만 있어 미리 보고 직접 골라야 합니다',
        () => (quick.length ? applyFromBar(id, apply) : openPreview(ai)),
      );
      apply.className = 'cb-apply';
      btns.push(apply);
    }
    bar.className = 'change-bar';
    bar.replaceChildren(span('cb-icon', '✎'), text, ...notes, ...btns, close);
    p.collectBtn.hidden = true;
    setChangeBar(id, true);
    return true;
  }

  async function applyFromBar(id, btn) {
    const b = bars.get(id);
    if (!b) return;
    btn.disabled = true;
    btn.textContent = '적용 중…';
    try {
      await applyPlans(b.ai, b.ai.plans.filter(isQuick).map((x) => x.plan));
    } finally {
      if (bars.get(id) === b && !b.applied) renderBar(id); // 하나도 쓰지 못했으면 바를 원래대로
    }
  }

  window.renderChanges = async () => {
    const cols = $('#changesCols');
    $('#changesLog').textContent = `적용 기록 (${project.log.filter((l) => !l.reverted).length})`;
    if (!has()) {
      $('#changesInfo').textContent = '';
      cols.style.gridTemplateColumns = '1fr';
      return cols.replaceChildren(span('change-empty', '📁 프로젝트를 먼저 열어 주세요. 툴바의 "📁 프로젝트"로 폴더를 고르면 AI 답변의 코드 수정안을 여기서 비교하고 적용할 수 있습니다.'));
    }
    $('#changesInfo').textContent = `${project.info.name} — AI 답변에서 찾은 코드 수정안`;
    cols.replaceChildren(span('change-empty', '답변을 읽는 중…'));
    plansByAi = await planAll();
    cols.style.gridTemplateColumns = `repeat(${Math.max(plansByAi.length, 1)}, minmax(0, 1fr))`;
    cols.replaceChildren(...plansByAi.map(changeColumn));
  };

  // 변경 제안 화면의 AI 한 칸: 파일 목록(수정·새 파일·삭제, +/− 줄 수)과 미리보기·적용 / 📋 모아보기 버튼
  function changeColumn(ai) {
    const col = document.createElement('article');
    col.className = 'compare-col';
    col.style.setProperty('--svc', ai.color);
    const ok = ai.plans.filter((x) => x.plan.ok);
    const add = ok.reduce((n, x) => n + x.plan.add, 0);
    const del = ok.reduce((n, x) => n + x.plan.del, 0);
    const head = document.createElement('div');
    head.className = 'compare-col-head';
    head.append(span('dot ready'), span('name', ai.name), span('muted-label', ai.plans.length ? `파일 ${ai.plans.length}개 · +${add} −${del}` : '수정안 없음'));
    const list = document.createElement('div');
    list.className = 'change-list';
    if (!ai.plans.length) list.append(span('change-empty', '이 답변에는 적용할 수정안("파일: 경로" 전체 내용 코드 블록, diff, DELETE_FILES)이 없습니다.'));
    for (const { change, plan } of ai.plans) {
      const row = document.createElement('div');
      row.className = 'change-row';
      const same = !plan.ok && plan.error === SAME_TEXT; // 이미 적용한 수정안
      row.append(span(`op ${plan.ok ? plan.op : same ? 'same' : 'bad'}`, plan.ok ? OP_TEXT[plan.op] : same ? '✓ 적용됨' : '⚠ 적용 불가'), span('path', plan.path));
      const risk = plan.ok && PX.executionRisk(plan.path, plan.before, plan.after);
      if (risk) {
        const tag = span('op bad', '⚠ 실행 영향');
        tag.title = `${risk} — 적용 창에서 기본으로 체크하지 않습니다`;
        row.append(tag);
      }
      if (plan.ok) row.append(span('add', `+${plan.add}`), span('del', `−${plan.del}`));
      else {
        const err = span('err', plan.error);
        row.title = plan.error;
        row.append(err);
        if (change.type === 'diff' && !change.isNew && !change.isDelete && !writeBlocked(change.path)) {
          row.append(button('전체 파일 다시 요청', '현재 내용을 주고 수정한 전체 파일로 다시 달라고 합니다', () => refetch(ai, change.path)));
        }
      }
      list.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'change-foot';
    const applyBtn = button('미리보기·적용', `${ai.name}의 수정안을 미리 보고 적용합니다`, () => openPreview(ai));
    applyBtn.disabled = !ok.length;
    const collectBtn = button('📋 모아보기', `${ai.name}의 수정안을 경로와 전체 코드로 모아 복사합니다`, () => window.onCollectClick(ai.id));
    collectBtn.disabled = !ai.plans.length;
    foot.append(applyBtn, collectBtn);
    col.append(head, list, foot);
    return col;
  }

  /**
   * diff가 맞지 않을 때 현재 내용을 주고 전체 파일로 다시 받는다. 다른 전송과 같은 검사를 거친다:
   * 앱 내장 제외(L1)는 보내지 않고, 다른 제외 규칙(L2·L3)이나 비밀 정보로 보이는 문자열이 있으면 확인을 받는다.
   */
  async function refetch(ai, path) {
    if (!allowedFor(ai.id)) return;
    try {
      const rule = project.scan.matcher.classify(path, false);
      if (rule?.layer === 'L1') return alert(`${path}은(는) 앱 내장 제외 규칙에 걸린 파일이라 보낼 수 없습니다.\n(${PI.describe(rule)})`);
      if (rule && !confirm(`${path}은(는) 제외 규칙에 걸린 파일입니다.\n(${PI.describe(rule)})\n\n현재 내용을 ${ai.name}에게 보내 전체 파일로 다시 받을까요?`)) return;
      const text = await currentText(path);
      if (text === null) return alert('파일이 없습니다');
      const hits = scanSecrets(text);
      if (hits.length && !confirm(`${path}에 비밀 정보로 보이는 문자열이 있습니다:\n${describeSecrets(hits)}\n\n그래도 현재 내용을 ${ai.name}에게 보낼까요?`)) return;
      const res = await sendProjectFollowUp(ai.id, PU.packRefetch({ path, text, mode: project.uploadMode }));
      if (!res?.ok) return alert(`보내지 못했습니다: ${res?.error}`);
      remember(ai.id, [{ path, text }]);
      host.setView('panels');
    } catch (err) {
      alert(err.message);
    }
  }

  $('#changesRefresh').addEventListener('click', () => window.renderChanges());
  $('#changesMerge').addEventListener('click', async () => {
    const r = await host.runSynth($('#synthTarget').value || state.synthTarget, 'code');
    if (r && r.ok === false) return alert(r.error);
    host.setView('panels');
  });

  // ---------- 미리보기 · 적용 · 되돌리기 ----------

  // 미리보기·적용 / 적용 기록 / 파일 모아보기가 함께 쓰는 창.
  // Windows 앱의 AI 패널은 앱 화면 위에 따로 얹힌 창이라, 패널을 둔 채 이 창을 띄우면 패널 아래에 깔려 보이지 않는다.
  // 그래서 패널 화면에서 열 때는 'dialog' 화면으로 바꿔 패널을 화면 밖으로 치우고, 닫으면 패널 화면으로 돌아간다.
  // 창이 열린 채 다른 화면으로 가면(Esc · 단축키 · 툴바) 안 보이는 창이 툴바를 막지 않도록 저절로 닫는다 (onViewChanged).
  const modal = {
    view: null, // 창을 연 화면 (null이면 닫힘)
    pending: false, // 'dialog'로 바꿔 달라고 했지만 아직 그 화면 상태를 받지 못함
    show(title, note) {
      $('#patchTitle').textContent = title;
      $('#patchNote').textContent = note || '';
      $('#patchStatus').textContent = '';
      $('#patchModal').hidden = false;
      if (state?.chatView === 'panels') {
        modal.view = 'dialog';
        modal.pending = true;
        host.setView('dialog');
      } else {
        modal.view = state?.chatView || null;
        modal.pending = false;
      }
    },
    hide() {
      $('#patchModal').hidden = true;
      $('#patchApply').onclick = null;
      $('#patchAll').onclick = null;
      const back = modal.view === 'dialog';
      modal.view = null;
      modal.pending = false;
      if (back && state?.chatView === 'dialog') host.setView('panels');
    },
    /** 화면 상태가 올 때마다: 창을 연 화면을 떠났으면 닫는다 */
    onViewChanged() {
      if (!modal.view) return;
      if (modal.pending) {
        if (state.chatView === modal.view) modal.pending = false; // 'dialog' 화면이 됨
        return;
      }
      if (state.chatView !== modal.view) {
        modal.view = null; // 이미 다른 화면이라 패널로 되돌리지 않는다
        modal.hide();
      }
    },
  };
  $('#patchCancel').addEventListener('click', () => modal.hide());
  // Ctrl+Enter: 창의 주 버튼(선택한 파일 적용 · 전체 복사)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || $('#patchModal').hidden) return;
    const apply = $('#patchApply');
    if (apply.hidden || apply.disabled) return;
    e.preventDefault();
    apply.click();
  });

  // 바뀐 줄 보기: 추가된 줄은 초록, 지운 줄은 빨강으로 칠합니다.
  function diffPre(text) {
    const pre = document.createElement('pre');
    for (const line of text.split('\n')) {
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      pre.append(span(line.startsWith('+') ? 'a' : line.startsWith('-') ? 'd' : line.startsWith('@@') ? 'h' : '', line || ' '));
    }
    return pre;
  }

  /** 미리보기·적용 창: 파일마다 바뀌는 줄을 보여 주고, 체크한 파일만 씁니다. 실행에 영향을 주는 파일과 삭제는 기본으로 체크하지 않습니다. */
  function openPreview(ai) {
    const ok = ai.plans.filter((x) => x.plan.ok);
    modal.show(`${ai.name} 수정안 적용`, `${project.info.name} — 체크한 파일만 씁니다. 적용 전 원본은 "적용 기록"에서 되돌릴 수 있습니다.`);
    const boxes = [];
    $('#patchBody').replaceChildren(
      ...ok.map(({ plan }) => {
        const pf = document.createElement('div');
        pf.className = 'pf';
        const head = document.createElement('label');
        head.className = 'pf-head';
        // 저장만 해도 나중에 실행될 수 있는 파일(실행 영향)과 삭제는 기본으로 체크하지 않는다.
        const risk = PX.executionRisk(plan.path, plan.before, plan.after);
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !risk && plan.op !== 'delete' });
        boxes.push({ box, plan });
        head.append(box, span(`op ${plan.op}`, OP_TEXT[plan.op]), span('path', plan.path));
        if (risk) {
          const tag = span('op bad', `⚠ 실행 영향: ${risk}`);
          tag.title = '저장하면 나중에 자동으로 실행될 수 있는 파일입니다. 내용을 확인한 뒤 직접 체크하세요.';
          head.append(tag);
        }
        if (plan.op === 'delete') head.append(span('op delete', '파일을 지웁니다 — 직접 체크해야 적용'));
        head.append(span('add', `+${plan.add}`), span('del', `−${plan.del}`));
        pf.append(head, diffPre(plan.preview));
        return pf;
      }),
    );
    $('#patchApply').hidden = false;
    $('#patchAll').hidden = false;
    $('#patchAll').onclick = () => boxes.forEach((b) => (b.box.checked = true));
    $('#patchApply').textContent = '선택한 파일 적용';
    $('#patchApply').focus(); // Enter(또는 Ctrl+Enter)로 바로 적용
    $('#patchApply').onclick = async () => {
      const chosen = boxes.filter((b) => b.box.checked).map((b) => b.plan);
      if (!chosen.length) return ($('#patchStatus').textContent = '적용할 파일을 고르세요');
      $('#patchApply').disabled = true;
      try {
        const { text } = await applyPlans(ai, chosen);
        $('#patchStatus').textContent = text;
        setTimeout(() => {
          modal.hide();
          if (state?.chatView === 'changes') window.renderChanges();
        }, 900);
      } finally {
        $('#patchApply').disabled = false;
      }
    };
  }

  /** 적용: 쓰기 직전에 파일이 바뀌었으면 다시 계산한다. 원본은 적용 기록에 남긴다. { entry(적용 기록 항목, 못 썼으면 null), text } */
  async function applyPlans(ai, plans) {
    const done = [];
    const failed = [];
    for (const plan of plans) {
      try {
        let p = plan;
        const now = await currentText(plan.path);
        if (now !== plan.before) {
          const change = ai.plans.find((x) => x.plan === plan).change;
          p = PX.planChange(change, now);
          if (!p.ok) throw new Error(`그사이 파일이 바뀌어 적용할 수 없습니다 (${p.error})`);
        }
        if (p.op === 'delete') await host.project.deleteFile(p.path);
        else await host.project.writeFile(p.path, p.after);
        done.push({ path: p.path, before: p.before, after: p.after });
      } catch (err) {
        failed.push(`${plan.path}: ${err.message}`);
      }
    }
    let entry = null;
    if (done.length) {
      // 수정안을 낸 AI는 적용한 결과를 이미 안다. 다른 AI에게는 ⟳ 뒤 "바뀐 파일"로 보인다.
      remember(ai.id, done.map((f) => ({ path: f.path, text: f.after })));
      entry = { id: `${Date.now().toString(36)}`, at: Date.now(), ai: ai.name, files: done, reverted: false };
      project.log.unshift(entry);
      project.log.length = Math.min(project.log.length, MAX_LOG);
      for (const f of done) {
        if (f.after === null) project.touched.delete(f.path);
        else if (!project.touched.has(f.path)) project.touched.set(f.path, f.before === null ? 'A' : 'M');
      }
      saveState();
      // 그 AI의 패널 바는 "적용됨 · 되돌리기"로 (변경 제안 화면에서 적용했어도 패널로 돌아가면 보인다)
      if (panels.has(ai.id)) {
        bars.set(ai.id, { ai, applied: entry });
        renderBar(ai.id);
      }
      await rescan();
      await refreshOtherBars(ai.id);
    }
    if (failed.length) alert(`적용하지 못한 파일:\n${failed.join('\n')}`);
    return { entry, text: `${done.length}개 파일을 적용했습니다${failed.length ? ` · ${failed.length}개 실패` : ''}` };
  }

  // ---------- 파일 모아보기 ----------
  // 답변에서 찾은 파일 수정안을 "경로 + 전체 코드"로 모아, 직접 복사해 붙여 넣기 좋게 보여 준다. 파일은 쓰지 않는다.
  // 프로젝트를 열지 않아도 쓴다. 그때는 새 파일·수정을 구분하지 못하고, diff는 전체 코드로 바꾸지 못해 diff 그대로 보여 준다.

  const COLLECT_OP = { create: '새 파일', modify: '수정', full: '전체 코드', diff: '바뀐 부분(diff)', same: '변경 없음', delete: '삭제' };

  const hunkText = (change) => change.hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n')).join('\n');

  /** 답변 → [{ path, op, code, note }]. 프로젝트가 열려 있으면 지금 파일과 비교해 새 파일·수정을 나누고 diff는 전체 코드로 바꾼다 */
  async function collectItems(md) {
    const items = [];
    for (const change of PX.extractChanges(md)) {
      const { path } = change;
      if (change.isDelete) {
        items.push({ path, op: 'delete', code: '' });
        continue;
      }
      let before; // undefined: 모름 (프로젝트가 없거나 읽지 못함)
      if (has()) before = await currentText(path).catch(() => undefined);
      if (change.type === 'full') {
        const same = typeof before === 'string' && before.replace(/\r\n/g, '\n').trimEnd() === change.content.replace(/\r\n/g, '\n').trimEnd();
        items.push({ path, op: before === undefined ? 'full' : before === null ? 'create' : same ? 'same' : 'modify', code: change.content });
        continue;
      }
      let note = '프로젝트를 열면 지금 파일과 합친 전체 코드로 보여 줍니다';
      if (before !== undefined || change.isNew) {
        const plan = PX.planChange(change, before ?? null);
        if (plan.ok) {
          items.push({ path, op: plan.op, code: plan.after.replace(/\r\n/g, '\n') });
          continue;
        }
        note = `전체 코드로 바꾸지 못했습니다: ${plan.error}`;
      }
      items.push({ path, op: 'diff', code: hunkText(change), note });
    }
    return items;
  }

  /** 답변이 끝나면 수정안 개수를 세어 패널 머리줄 버튼을 띄운다 (눈에 띄게 잠깐 움직임) */
  async function showCollectBtn(id, md) {
    const p = panels.get(id);
    if (!p) return;
    const changes = PX.extractChanges(md);
    p.collectBtn.hidden = !changes.length;
    p.collectBtn.classList.remove('attn');
    if (!changes.length) return;
    p.collectBtn.textContent = `📋 파일 ${changes.length}개 모아보기`;
    p.collectBtn.title = `답변에서 찾은 파일 — 경로와 전체 코드를 모아 복사할 수 있습니다:\n${listLines(changes, (c) => `- ${c.path}`)}`;
    void p.collectBtn.offsetWidth; // 애니메이션을 처음부터 다시 돌린다
    p.collectBtn.classList.add('attn');
  }

  const fenceFor = (code) => '`'.repeat(Math.max(3, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  const langOf = (path) => (/\.([\w]+)$/.exec(path)?.[1] || '').toLowerCase();

  /** 전체 복사용 Markdown: 파일 목록 + 파일마다 "파일: 경로" 와 코드 블록, 지울 파일은 DELETE_FILES */
  function collectMarkdown(items) {
    const out = items.map((it) => `- [${COLLECT_OP[it.op]}] ${it.path}`);
    for (const it of items.filter((x) => x.op !== 'delete')) {
      const fence = fenceFor(it.code);
      out.push('', `파일: ${it.path} (${COLLECT_OP[it.op]})`, `${fence}${it.op === 'diff' ? 'diff' : langOf(it.path)}`, it.code.replace(/\n$/, ''), fence);
    }
    const del = items.filter((x) => x.op === 'delete').map((x) => x.path);
    if (del.length) out.push('', `DELETE_FILES: ${del.join(', ')}`);
    return out.join('\n');
  }

  async function copyWithFeedback(btn, text, label) {
    await host.copyText(text);
    btn.textContent = '✓ 복사됨';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('copied');
    }, 1200);
  }

  window.onCollectClick = async (id) => {
    const p = panels.get(id);
    p?.collectBtn.classList.remove('attn');
    const name = state.services.find((s) => s.id === id)?.name || id;
    const items = await collectItems(await answerMd(id).catch(() => ''));
    const counts = Object.entries(COLLECT_OP)
      .map(([op, label]) => [label, items.filter((x) => x.op === op).length])
      .filter(([, n]) => n)
      .map(([label, n]) => `${label} ${n}`)
      .join(' · ');
    modal.show(
      `${name} — 파일 ${items.length}개 모아보기`,
      `${counts}${has() ? ` · ${project.info.name} 기준` : ' · 프로젝트를 열면 새 파일·수정을 구분합니다'} — 파일에는 쓰지 않습니다`,
    );
    $('#patchBody').replaceChildren(
      ...(items.length
        ? items.map((it) => {
            const pf = document.createElement('div');
            pf.className = 'pf collect';
            const head = document.createElement('div');
            head.className = 'pf-head';
            const tag = span(`op ${it.op}`, COLLECT_OP[it.op]);
            if (it.op === 'full') tag.title = '프로젝트를 열면 새 파일인지 수정인지 알려 줍니다';
            head.append(tag, span('path', it.path));
            if (it.note) head.append(span('muted-label', it.note));
            const pathBtn = button('경로 복사', '파일 경로를 복사합니다', () => copyWithFeedback(pathBtn, it.path, '경로 복사'));
            head.append(pathBtn);
            if (it.op !== 'delete') {
              const codeBtn = button('코드 복사', '이 파일의 전체 코드를 복사합니다', () => copyWithFeedback(codeBtn, it.code, '코드 복사'));
              codeBtn.className = 'primary';
              head.append(codeBtn);
            }
            pf.append(head);
            if (it.op === 'diff') pf.append(diffPre(it.code));
            else if (it.op !== 'delete') {
              const pre = document.createElement('pre');
              pre.className = 'code';
              pre.textContent = it.code;
              pf.append(pre);
            } else pf.append(span('muted-label collect-del', '이 파일을 지우라는 요청입니다'));
            return pf;
          })
        : [span('change-empty', '이 답변에서 파일 수정안을 찾지 못했습니다.')]),
    );
    $('#patchAll').hidden = true;
    $('#patchApply').hidden = !items.length;
    $('#patchApply').textContent = '전체 복사';
    $('#patchApply').onclick = async () => {
      await host.copyText(collectMarkdown(items));
      $('#patchStatus').textContent = `파일 ${items.length}개를 경로와 함께 복사했습니다`;
    };
  };

  const fmtAt = (ms) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  $('#changesLog').addEventListener('click', () => {
    modal.show('적용 기록', '최근 20개. 되돌리면 적용하기 전 내용으로 돌아갑니다 (새로 만든 파일은 지웁니다).');
    $('#patchApply').hidden = true;
    $('#patchAll').hidden = true;
    const rows = project.log.map((entry) => {
      const row = document.createElement('div');
      row.className = `log-row${entry.reverted ? ' reverted' : ''}`;
      row.append(span('', fmtAt(entry.at)), span('name', entry.ai), span('files', entry.files.map((f) => f.path).join(', ')));
      const undo = button(entry.reverted ? '되돌림' : '되돌리기', '적용하기 전 내용으로 되돌립니다', async () => {
        await revert(entry);
        $('#changesLog').click();
      });
      undo.disabled = entry.reverted || !has();
      row.append(undo);
      return row;
    });
    $('#patchBody').replaceChildren(...(rows.length ? rows : [span('change-empty', '아직 적용한 수정안이 없습니다')]));
  });

  // 적용 기록 하나를 되돌립니다: 적용 전 내용으로 다시 쓰고, 새로 만든 파일은 지웁니다. 그사이 또 바뀐 파일은 먼저 묻습니다.
  async function revert(entry) {
    const changed = [];
    for (const f of entry.files) {
      const now = await currentText(f.path).catch(() => undefined);
      if (now !== f.after) changed.push(f.path);
    }
    if (changed.length && !confirm(`적용한 뒤에 다시 바뀐 파일이 있습니다:\n${changed.join('\n')}\n\n그래도 적용 전 내용으로 되돌릴까요? (그 뒤의 변경은 사라집니다)`)) return;
    const failed = [];
    for (const f of entry.files) {
      try {
        if (f.before === null) await host.project.deleteFile(f.path).catch((err) => (/found|ENOENT/i.test(err.message) ? null : Promise.reject(err)));
        else await host.project.writeFile(f.path, f.before);
      } catch (err) {
        failed.push(`${f.path}: ${err.message}`);
      }
    }
    entry.reverted = !failed.length;
    if (entry.reverted) for (const f of entry.files) project.touched.delete(f.path);
    saveState();
    await rescan();
    // 이 적용으로 "적용됨"이던 바는 다시 적용할 수 있는 상태로, 다른 바도 지금 파일 기준으로 다시 계산
    if (entry.reverted) for (const b of bars.values()) if (b.applied === entry) b.applied = null;
    await refreshOtherBars(null);
    if (failed.length) alert(`되돌리지 못한 파일:\n${failed.join('\n')}`);
  }

  // ---------- 파일 편집 ----------
  // 사이드바 트리에서 파일 이름을 누르면 연다. 저장하면 로컬 파일에 쓰고 적용 기록("직접 편집")에 남긴 뒤 다시 읽는다.
  // 그러면 이 파일을 받은 적 있는 AI는 "바뀐 파일"로 잡혀, "저장하고 AI에 보내기"나 사이드바 버튼으로 바로 보낼 수 있다.

  const lfOf = (text) => (text ?? '').replace(/\r\n/g, '\n');
  const edDirty = () => !!ed.path && $('#edText').value !== lfOf(ed.base);

  function guessIndent(text) {
    if (/^\t/m.test(text)) return '\t';
    return /^ {4}\S/m.test(text) && !/^ {2}\S/m.test(text) ? '    ' : '  ';
  }

  function edStatus(text) {
    const dirty = edDirty();
    $('#edStatus').dataset.dirty = dirty ? '1' : '';
    $('#edStatus').textContent = text || (ed.path ? `${dirty ? '● 저장 안 됨' : '저장됨'} · ${ed.crlf ? 'CRLF' : 'LF'}` : '');
  }

  // 편집기 닫기 (내용 비우고 패널 화면으로)
  function closeEditor() {
    Object.assign(ed, { path: null, base: null });
    $('#edText').value = '';
    $('#edPath').textContent = '';
    edStatus();
    if (state?.chatView === 'editor') host.setView('panels');
  }

  /** 파일을 편집기에서 엽니다. 다른 파일에 저장 안 한 수정이 있으면 먼저 묻습니다. */
  async function openEditor(path) {
    if (!has()) return;
    if (path !== ed.path && edDirty() && !confirm(`${ed.path}에 저장하지 않은 수정 내용이 있습니다. 버리고 ${path}을(를) 열까요?`)) return;
    if (path === ed.path && ed.base !== null) return host.setView('editor');
    let text;
    try {
      text = await currentText(path);
    } catch (err) {
      return alert(`편집기에서 열 수 없습니다: ${err.message}`);
    }
    if (text === null) return alert('파일이 없습니다');
    Object.assign(ed, { path, base: text, crlf: text.includes('\r\n'), indent: guessIndent(text) });
    $('#edText').value = lfOf(text);
    $('#edPath').textContent = path;
    $('#edPath').title = path;
    edStatus();
    host.setView('editor');
    renderTree();
    setTimeout(() => $('#edText').focus(), 0);
  }

  /** 저장. 결과: 저장했거나 바뀐 내용이 없으면 true, 취소·실패면 false */
  async function saveEditor() {
    if (!has() || !ed.path) return false;
    const path = ed.path;
    const block = writeBlocked(path);
    if (block) {
      alert(block);
      return false;
    }
    let now;
    try {
      now = await currentText(path);
    } catch (err) {
      alert(`저장하지 못했습니다: ${err.message}`);
      return false;
    }
    const value = $('#edText').value;
    if (now !== ed.base) {
      const why = now === null ? '그사이 파일이 지워졌습니다' : '편집기에서 연 뒤 다른 곳에서 파일이 바뀌었습니다';
      if (!confirm(`${path}: ${why}.\n\n편집기 내용으로 덮어쓸까요? (취소하면 저장하지 않습니다. "다시 읽기"로 지금 내용을 볼 수 있습니다)`)) return false;
    } else if (value === lfOf(now)) {
      edStatus('바뀐 내용이 없습니다');
      setTimeout(() => edStatus(), 1500);
      return true;
    }
    const after = ed.crlf ? value.replace(/\n/g, '\r\n') : value; // 원래 줄바꿈(CRLF)을 지킨다
    try {
      await host.project.writeFile(path, after);
    } catch (err) {
      alert(`저장하지 못했습니다: ${err.message}`);
      return false;
    }
    ed.base = after;
    project.log.unshift({ id: `${Date.now().toString(36)}`, at: Date.now(), ai: '직접 편집', files: [{ path, before: now, after }], reverted: false });
    project.log.length = Math.min(project.log.length, MAX_LOG);
    saveState();
    edStatus('저장했습니다');
    setTimeout(() => edStatus(), 1500);
    await rescan(); // 바뀐 파일 검사(checkStale)도 여기서 한다
    return true;
  }

  $('#edSave').addEventListener('click', () => saveEditor());
  $('#edSaveSend').addEventListener('click', async () => {
    if (!(await saveEditor())) return;
    const path = ed.path;
    const knows = project.stale.some((s) => s.files.some((f) => f.path === path) || s.deleted.includes(path));
    if (!knows) {
      const known = [...project.sent.values()].some((m) => m.has(path));
      return alert(
        known
          ? `${path}: AI들이 이미 지금 내용을 알고 있어 보낼 것이 없습니다.`
          : `${path}을(를) 받은 적 있는 AI가 없습니다.\n사이드바에서 이 파일을 체크해 두면 다음 질문에 함께 보냅니다.`,
      );
    }
    await syncStale(path);
  });
  $('#edReload').addEventListener('click', async () => {
    if (!ed.path) return;
    if (edDirty() && !confirm('저장하지 않은 수정 내용을 버리고 디스크에서 다시 읽을까요?')) return;
    const path = ed.path;
    ed.base = null;
    ed.path = null;
    $('#edText').value = '';
    await openEditor(path);
  });
  $('#edClose').addEventListener('click', () => host.setView('panels'));
  $('#edText').addEventListener('input', () => edStatus());
  $('#edText').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveEditor();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      document.execCommand('insertText', false, ed.indent); // 되돌리기(Ctrl+Z)가 되도록 execCommand로 넣는다
    }
  });

  // ---------- 화면 상태 ----------

  window.onProjectState = () => {
    modal.onViewChanged();
    render();
  };

  // 시작할 때 지난번 프로젝트를 다시 연다 (크롬 확장은 접근 허용을 다시 눌러야 할 수 있다).
  (async () => {
    try {
      const info = await host.project.restore();
      if (info) await openProject(info);
    } catch (err) {
      console.warn('[project] 지난 프로젝트를 열지 못했습니다:', err.message);
    }
  })();

  // ---------- git 콘솔 (Windows 앱 전용, host.git) ----------
  // 명령 줄 글자만 메인 프로세스에 넘긴다. 무엇을 받을지 검사·확인 창·실행은 메인(src/main/gitconsole.js)이 한다.
  // AI 답변의 명령을 가져오지 않는다 — 사용자가 직접 입력한 것만 실행한다.

  if (host.git) {
    const out = $('#gitOut');
    const input = $('#gitInput');
    const past = []; // 이전 명령 (↑↓)
    let pastAt = 0;
    let busy = false;

    const print = (text, cls) => {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = text;
      out.append(s);
      // 너무 길어지면 앞부분을 버린다
      while (out.childNodes.length > 4000) out.firstChild.remove();
      out.scrollTop = out.scrollHeight;
    };
    const setBusy = (on) => {
      busy = on;
      $('#gitRun').disabled = on;
      $('#gitStop').disabled = !on;
    };

    async function showInfo() {
      const info = await host.git.info().catch((err) => ({ error: err.message }));
      const note = $('#gitNote');
      note.hidden = true;
      if (info.error) {
        $('#gitWhere').textContent = '';
        note.textContent = info.error;
        note.hidden = false;
        return;
      }
      $('#gitWhere').textContent = info.isRepo ? `${info.top} · ${info.branch || '(브랜치 없음)'}` : `${info.root} · git 저장소가 아닙니다 (git init으로 만들 수 있음)`;
      if (info.hooks?.length) {
        note.textContent =
          `이 저장소에는 git 훅 ${info.hooks.length}개가 있습니다${info.hooksPath ? ` (core.hooksPath: ${info.hooksPath})` : ''}: ${info.hooks.slice(0, 8).join(', ')}${info.hooks.length > 8 ? ' …' : ''}\n` +
          'commit · push · checkout 같은 명령을 실행하면 이 훅 프로그램도 함께 실행됩니다. 직접 넣지 않은 훅이면 내용을 먼저 확인하세요.';
        note.hidden = false;
      }
    }

    async function runGit(line) {
      line = line.trim();
      if (!line || busy) return;
      if (!/^git(\s|$)/.test(line)) line = `git ${line}`; // "status"만 써도 git status로
      if (past[past.length - 1] !== line) past.push(line);
      pastAt = past.length;
      print(`\n> ${line.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')}\n`, 'cmd'); // 주소에 넣은 토큰은 화면에 보이지 않게
      setBusy(true);
      try {
        const r = await host.git.run(line);
        if (!r.ok) print(`${r.error}\n`, r.cancelled ? 'info' : 'err');
        else if (r.error) print(`실행하지 못했습니다: ${r.error}\n`, 'err');
        else print(`(끝 · 코드 ${r.code})\n`, r.code === 0 ? 'info' : 'err');
      } catch (err) {
        print(`${err.message}\n`, 'err');
      } finally {
        setBusy(false);
        input.focus();
        // 커밋·브랜치 바꾸기 뒤에는 파일이 바뀌었을 수 있다
        if (/^git\s+(checkout|switch|reset|restore|merge|pull|stash|revert|cherry-pick|rm|mv)\b/.test(line)) rescan().catch(() => {});
        showInfo();
      }
    }

    host.on('git:output', ({ stream, text }) => print(text, stream === 'err' ? 'err' : stream === 'info' ? 'info' : ''));

    $('#psGit').addEventListener('click', () => {
      host.setView('git');
      showInfo();
      setTimeout(() => input.focus(), 0);
    });
    $('#gitClose').addEventListener('click', () => host.setView('panels'));
    $('#gitClear').addEventListener('click', () => out.replaceChildren());
    $('#gitStop').addEventListener('click', () => host.git.stop());
    $('#gitTerm').addEventListener('click', async () => {
      const r = await host.git.openTerminal();
      print(r.ok ? `\n${r.via}를 열었습니다\n` : `\n터미널을 열지 못했습니다: ${r.error}\n`, r.ok ? 'info' : 'err');
    });
    for (const b of document.querySelectorAll('[data-git]')) b.addEventListener('click', () => runGit(b.dataset.git));
    $('#gitForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const line = input.value;
      input.value = '';
      runGit(line);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && pastAt > 0) input.value = past[--pastAt];
      else if (e.key === 'ArrowDown') input.value = pastAt < past.length - 1 ? past[++pastAt] : ((pastAt = past.length), '');
      else return;
      e.preventDefault();
    });
  }
})();