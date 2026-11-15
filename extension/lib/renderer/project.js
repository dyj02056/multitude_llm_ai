// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project.js)
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
  // 프로젝트 화면 파일끼리 주고받는 것 (v0.24.0에서 project.js를 셋으로 나눔):
  //   project.js(이 파일, 상태 · 열기 · 트리 · 보내기 · NEED_FILES) → project-changes.js(변경 제안 · 변경 바 · 큰 작업 ·
  //   이어 받기 · 미리보기 · 적용 · 되돌리기 · 모아보기) → project-editor.js(편집기 · git 콘솔) 순서로 읽힌다.
  //   뒤 파일의 것은 P.이름 으로 부른다 (부를 때 찾으므로 읽는 순서와 상관없음).
  const P = (MLA.projectUI = {});
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
    split: false, // 큰 작업: 계획 먼저 받고 파일별로 차례로 받기 (v0.18.0)
    autoRun: false, // 계획 답이 오면 바로 파일별로 받기 시작 (v0.22.0)
    autoContinue: false, // 잘린 파일은 자동으로 이어 받기 — 한 파일 최대 PX.MAX_CONTINUE번 (v0.22.0)
    incremental: true, // 바뀐 파일만 보내기: 이어지는 질문에는 내용이 바뀐 파일만 다시 올림 (v0.23.0)
    followList: false, // 이어지는 질문에 지난 파일 목록 붙이기: 지난번에 보낸 파일 목록(줄 수)을 붙이고 바뀐 것은 다시 올림 (v0.23.0)
    l3Enabled: [],
    checked: new Set(), // 내용을 보낼 파일
    allowSecret: new Set(), // 비밀 정보 경고를 보고도 보내기로 한 파일
    secretHits: new Map(), // path -> 찾은 비밀 정보
    expanded: new Set(['']), // 펼친 폴더
    log: [], // 적용 기록 [{ id, at, ai, files: [{ path, before, after }], reverted }]
    need: new Map(), // 패널 id -> 요청한 파일 목록
    sent: new Map(), // 패널 id -> Map(경로 -> 그 AI가 마지막으로 받은 내용의 지문 { hash, lines }, 지워진 파일은 null)
    sentTree: new Map(), // 패널 id -> 그 AI가 마지막으로 받은 프로젝트 구조 목록의 지문
    sentEpoch: new Map(), // 패널 id -> 기록할 때의 패널 세대 (panelEpoch) — 새 대화 · 패널을 다시 열면 달라져 기록을 버린다
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
        split: project.split,
        autoRun: project.autoRun,
        autoContinue: project.autoContinue,
        incremental: project.incremental,
        followList: project.followList,
        sent: sentToState(),
        blocked: [...project.blocked],
        uploadOk: [...project.uploadOk],
        log: project.log.slice(0, MAX_LOG),
      })
      .catch((err) => console.warn('[project] 상태를 저장하지 못했습니다:', err.message));
  }

  // AI가 받은 내용 기록(sent)은 이번 실행 동안만 이어 쓴다: 앱을 다시 켜면 패널이 새 대화로 열리므로 버린다.
  // 같은 실행 안에서 프로젝트를 닫았다 다시 열면 그대로 이어진다 (패널 세대가 같을 때만).
  const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // 패널 세대: 새 대화를 열거나 패널을 닫으면(다시 열면 새 대화로 열린다) 오른다. 프로젝트가 닫혀 있을 때도 센다.
  const panelClears = new Map(); // 패널 id -> 세대
  const panelEpoch = (id) => String(panelClears.get(id) || 0);
  const bumpPanel = (id) => panelClears.set(id, (panelClears.get(id) || 0) + 1);
  let openPanels = null; // 지난번 state.selected (고른 패널) — 빠진 패널은 닫힌 것
  function notePanels() {
    const now = new Set(Array.isArray(state?.selected) ? state.selected : []);
    if (openPanels) {
      for (const id of openPanels) {
        if (now.has(id)) continue;
        bumpPanel(id);
        if (project.sent.has(id) || project.sentTree.has(id)) {
          forgetSent(id);
          saveState();
        }
      }
    }
    openPanels = now;
  }
  /** id 패널의 기록이 지금 패널(같은 대화)의 것인지. 아니면 버리고 false */
  function sentValid(id) {
    if (!project.sent.has(id) && !project.sentTree.has(id)) return false;
    if (project.sentEpoch.get(id) === panelEpoch(id)) return true;
    forgetSent(id);
    return false;
  }
  function forgetSent(id) {
    project.sent.delete(id);
    project.sentTree.delete(id);
    project.sentEpoch.delete(id);
  }
  function sentToState() {
    const out = {};
    for (const id of new Set([...project.sent.keys(), ...project.sentTree.keys()])) {
      const files = [...(project.sent.get(id) || [])].map(([p, e]) => (e ? [p, e.hash, e.lines] : [p, null]));
      out[id] = { epoch: project.sentEpoch.get(id) || '', tree: project.sentTree.get(id) ?? null, files };
    }
    return { run: RUN_ID, panels: out };
  }
  function sentFromState(s) {
    project.sent.clear();
    project.sentTree.clear();
    project.sentEpoch.clear();
    if (!s || s.run !== RUN_ID || !s.panels || typeof s.panels !== 'object') return;
    for (const [id, v] of Object.entries(s.panels)) {
      if (!v || !Array.isArray(v.files) || v.epoch !== panelEpoch(id)) continue;
      const m = new Map();
      for (const f of v.files) if (Array.isArray(f) && typeof f[0] === 'string') m.set(f[0], typeof f[1] === 'string' ? { hash: f[1], lines: Number(f[2]) || 0 } : null);
      project.sent.set(id, m);
      if (typeof v.tree === 'string') project.sentTree.set(id, v.tree);
      project.sentEpoch.set(id, v.epoch);
    }
  }

  async function loadState() {
    const s = (await host.project.loadState().catch(() => null)) || {};
    project.l3Enabled = Array.isArray(s.l3Enabled) ? s.l3Enabled : [];
    project.checked = new Set(Array.isArray(s.checked) ? s.checked : []);
    project.allowSecret = new Set(Array.isArray(s.allowSecret) ? s.allowSecret : []);
    project.include = s.include !== false;
    project.uploadMode = PU.normalizeMode(s.uploadMode);
    project.split = s.split === true;
    project.autoRun = s.autoRun === true;
    project.autoContinue = s.autoContinue === true;
    project.incremental = s.incremental !== false;
    project.followList = s.followList === true;
    sentFromState(s.sent);
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
    project.sentTree.clear();
    project.sentEpoch.clear();
    project.stale = [];
    project.expanded = new Set(['']);
    project.touched.clear();
    P.clearBars();
    P.closeEditor();
    if (!info) return render();
    if (info.needsPermission) {
      project.open = true;
      return render();
    }
    const known = await loadState();
    await rescan();
    // 지난번 "테스트 실행" 도중 앱이 꺼져 잠깐 써 둔 수정안이 남아 있었으면 메인이 원래대로 되돌렸다 (Windows 앱)
    if (info.recovered) notice(`지난번 테스트 중 앱이 꺼져 남아 있던 임시 수정 ${info.recovered}개 파일을 원래대로 되돌렸습니다`);
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
    const draft = P.edDirty() ? `\n\n편집기에서 저장하지 않은 ${ed.path}의 수정 내용은 사라집니다.` : '';
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
  $('#psSplit').addEventListener('change', (e) => {
    project.split = e.target.checked;
    saveState();
    render();
    notice(project.split ? '큰 작업: 다음 질문은 계획(고칠 파일 목록)만 받고, 파일별로 차례로 받습니다' : '큰 작업을 껐습니다');
  });
  $('#psAutoRun').addEventListener('change', (e) => {
    project.autoRun = e.target.checked;
    saveState();
    notice(project.autoRun ? '계획 답이 오면 바로 한 파일씩 받기 시작합니다' : '계획 답이 오면 [▶ 파일별로 받기 시작]을 눌러 시작합니다');
  });
  $('#psAutoCont').addEventListener('change', (e) => {
    project.autoContinue = e.target.checked;
    saveState();
    notice(project.autoContinue ? `잘린 파일은 자동으로 이어 받습니다 (한 파일 최대 ${PX.MAX_CONTINUE}번)` : '잘린 파일은 [↪ 이어서 받기]를 눌러 받습니다');
  });
  $('#psIncremental').addEventListener('change', (e) => {
    project.incremental = e.target.checked;
    saveState();
    render();
    notice(project.incremental ? '이어지는 질문에는 내용이 바뀐 파일만 다시 올립니다' : '질문마다 고른 파일을 모두 다시 올립니다');
  });
  $('#psFollowList').addEventListener('change', (e) => {
    project.followList = e.target.checked;
    saveState();
    notice(project.followList ? '이어지는 질문에 지난번에 보낸 파일 목록을 붙이고, 그중 바뀐 파일은 다시 올립니다' : '이어지는 질문에는 고른 파일만 봅니다');
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
    $('#projectBtn').textContent = project.info ? `proj:${project.info.name}` : 'proj';
    $('#psName').textContent = project.info?.name || '';
    $('#psConnect').hidden = !project.info?.needsPermission;
    $('#projectChip').hidden = !has();
    $('#psGit').hidden = !has() || !host.git; // git 콘솔은 Windows 앱에만 있다
    $('#projectInclude').checked = project.include;
    for (const b of document.querySelectorAll('#psUploadMode [data-umode]')) b.classList.toggle('active', b.dataset.umode === project.uploadMode);
    $('#psSplit').checked = project.split;
    $('#psAutoRun').checked = project.autoRun;
    $('#psAutoRun').disabled = !project.split; // 큰 작업을 켰을 때만 의미가 있다
    $('#psAutoCont').checked = project.autoContinue;
    $('#psIncremental').checked = project.incremental;
    $('#psFollowList').checked = project.followList;
    $('#psFollowList').disabled = !project.incremental; // 바뀐 파일만 보낼 때만 의미가 있다
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
    // 보낼 양 어림 (v0.22.0): 파일 크기로 센 대략의 토큰 수. 많으면 "큰 작업"을 먼저 권한다
    const tokens = PC.estimateTokens(chars);
    const summary = `내용 보낼 파일 ${project.checked.size}개 · 약 ${amount} (${PC.tokenText(tokens)}) / 보낼 수 있는 파일 ${sendablePaths().length}개`;
    $('#psSummary').replaceChildren(document.createTextNode(project.scan.truncated ? `${summary} (항목이 많아 일부만 읽음)` : summary));
    if (!project.split && PC.suggestSplitTokens(tokens)) {
      const w = span('split-warn', ' · [!] 큰 작업 권장');
      w.title = `고른 파일이 ${PC.tokenText(tokens)}입니다 — 한 답에 다 고쳐 쓰면 출력 한도로 끊기기 쉬워 "큰 작업"을 권합니다 (토큰 수는 파일 크기로 어림한 값)`;
      $('#psSummary').append(w);
    }
    $('#projectChipText').textContent = `~/${project.info.name} · 파일 ${project.checked.size}개 · ${MODE_TEXT[project.uploadMode]}로 업로드`;
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
    // 로컬 LLM(이 PC의 서버, v0.16.0)은 회사 서버로 올리는 것이 아니므로 묻지 않는다
    const isLocalSvc = (id) => state.services.find((s) => s.id === id)?.kind === 'local';
    const fresh = ids.filter((id) => !project.uploadOk.has(id) && !isLocalSvc(id));
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
        name.addEventListener('click', () => P.openEditor(e.path));
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
    const missing = []; // 지금은 없는 파일 (지난번에 보낸 파일 목록에서 "지워진 파일"로 알린다)
    for (const path of paths) {
      const r = await host.project.readFile(path).catch((err) => ({ error: err.message }));
      if (r.missing) missing.push(path);
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
    return { files, skipped, missing };
  }

  const toAttachment = ({ name, type, text }) => {
    const data = new TextEncoder().encode(text).buffer;
    return { name, type, lastModified: Date.now(), data };
  };
  const acceptsDocs = (id) => !!state.services.find((s) => s.id === id)?.accept.includes('document');
  const notice = (text) => flash($('#psSummary'), text);

  /** 첨부 한도 중 이미 쓴 만큼(사용자가 직접 올린 파일)을 뺀 나머지 */
  // 첨부 한도(10개, 50MB) 중 사용자가 직접 올린 파일을 빼고 프로젝트 파일에 쓸 수 있는 남은 양.
  // ids를 주면 파일 하나의 한도는 그 서비스들의 한도(maxFileBytes) 중 가장 작은 값 — 묶음 파일도 그 크기 안으로 나눈다.
  function budgetAfter(files = [], ids = []) {
    const L = state.attachLimits || { maxFiles: 10, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 };
    const used = files.reduce((n, f) => n + (f.data?.byteLength || 0), 0);
    const perService = ids
      .map((id) => state.services.find((s) => s.id === id)?.maxFileBytes)
      .filter((n) => Number.isFinite(n) && n > 0);
    const fileBytes = Math.min(L.maxFileBytes, ...perService);
    return { files: L.maxFiles - files.length, bytes: L.maxTotalBytes - used, fileBytes };
  }

  // 템플릿 변수 {{프로젝트}} · {{선택 파일}} 값 (library.js)
  // 응답 통계(설정 화면)용: 이 프로젝트의 적용 기록을 AI별로 센다 → { AI 이름: { applied, reverted } } (프로젝트가 없으면 null)
  window.projectApplyStats = () => {
    if (!has()) return null;
    const out = {};
    for (const e of project.log) {
      if (!e.ai || e.ai === '직접 편집') continue;
      const r = (out[e.ai] = out[e.ai] || { applied: 0, reverted: 0 });
      r.applied++;
      if (e.reverted) r.reverted++;
    }
    return out;
  };

  window.projectBuiltins = () => (has() ? { 프로젝트: project.info.name, '선택 파일': [...project.checked].join(', ') } : {});

  window.projectPrepareSend = async (payload, targetIds) => {
    if (!has() || !project.include) return payload;
    const withProject = targetIds.filter((id) => !project.blocked.has(id));
    const plainIds = targetIds.filter((id) => project.blocked.has(id));
    if (!withProject.length) return payload; // 모두 보내지 않기로 한 서비스 — 질문만 보낸다
    if (!confirmUpload(withProject, project.checked.size)) return null;
    for (const id of withProject) sentValid(id); // 새 대화 · 다시 연 패널의 기록은 버린다
    // 바뀐 파일만 보내기 (v0.23.0): 지난 파일 목록을 붙일 때는 지난번에 보낸 파일도 다시 읽어 바뀐 것을 찾는다 (followList)
    const chosen = [...project.checked];
    const extra = [];
    if (project.incremental && project.followList) {
      const seen = new Set(chosen);
      for (const id of withProject) {
        for (const [path, e] of project.sent.get(id) || []) {
          if (!e || seen.has(path)) continue;
          seen.add(path);
          extra.push(path);
        }
      }
    }
    const read = await readChosen([...chosen, ...extra]);
    const files = read.files.filter((f) => project.checked.has(f.path));
    const budget = budgetAfter(payload.files, withProject.filter(acceptsDocs));
    // 큰 작업(v0.18.0): 이번 답은 계획(PLAN_FILES)만 받는다. 꺼져 있는데 고른 파일이 많거나 길면 한 번 권한다.
    const lineCount = files.reduce((n, f) => n + String(f.text).split('\n').length, 0);
    if (!project.split && !P.splitSuggested && PC.suggestSplit({ files: files.length, lines: lineCount })) {
      P.splitSuggested = true;
      notice(`고른 파일이 ${files.length}개 · ${lineCount.toLocaleString()}줄입니다 — 답이 끊기면 사이드바의 "큰 작업"을 켜 보세요`);
    }
    const request = project.split ? `${payload.text || '(요청 없음)'}\n\n${PC.PLAN_FIRST}` : payload.text;
    const projInfo = { name: project.info.name, paths: sendablePaths() };
    const treeHash = PC.hashText(PC.buildTree(projInfo.paths));
    const plan = project.incremental
      ? PC.planIncremental({
          ids: withProject,
          files: read.files.map((f) => ({ ...f, checked: project.checked.has(f.path) })),
          knownById: project.sent,
          treeById: project.sentTree,
          treeHash,
          missing: read.missing.filter((p) => !project.checked.has(p)),
          followList: project.followList,
        })
      : null;
    const textById = {};
    // 보내지 않기로 한 서비스에는 원래 질문과 사용자가 직접 올린 파일만 (plainIds · userFileCount)
    for (const id of plainIds) textById[id] = payload.text;

    // 처음 보내는 질문(또는 "바뀐 파일만 보내기"를 껐을 때): 예전처럼 구조와 고른 파일을 모두 올린다
    if (!plan || plan.allFresh) {
      const pack = PU.packContext({ project: projInfo, files, request, mode: project.uploadMode, budget });
      const ups = pack.attachments.map(toAttachment);
      const room = ups.length <= budget.files && ups.reduce((n, f) => n + f.data.byteLength, 0) <= budget.bytes;
      // 직접 올린 파일 때문에 자리가 없으면 프로젝트 내용은 본문으로 보낸다
      if (!room) notice('첨부 한도가 모자라 프로젝트 내용은 본문으로 보냅니다');
      // 문서 첨부를 받지 않는 서비스(예: Duck.ai)에는 내용을 본문으로 넣는다 (넘치는 만큼 잘라서).
      for (const id of withProject) if (!room || !acceptsDocs(id)) textById[id] = pack.inlineText;
      if (pack.note) notice(pack.note);
      // 보내기에 성공한 패널만 renderer.js가 onProjectSent로 알려 준다
      pendingSent = { files, treeHash, tree: new Set(withProject), plain: new Set(), gone: {} };
      return {
        text: pack.text,
        files: room ? [...payload.files, ...ups] : [...payload.files],
        opts: {
          ...payload.opts,
          question: `${payload.text || '(첨부 파일만)'}\n\n[프로젝트 ${project.info.name} · 파일 ${files.length}개 내용 포함]`,
          project: { name: project.info.name }, // 기록에 "프로젝트 맥락 포함" 표시 · 질문 종류 (v0.27.0)
          textById,
          fallbackText: pack.inlineText,
          plainIds,
          userFileCount: payload.files.length,
        },
      };
    }

    // 이어지는 질문: 패널마다 바뀐 파일을 모아 한 번에 올리고(첨부는 모든 패널이 같다), 나머지는 "앞서 보낸 그대로" 목록으로만 알린다.
    // 올릴 것이 없는 패널은 질문 글과 목록만 보낸다 (plainIds — 사용자가 직접 올린 파일만 첨부).
    const packFor = (id) => {
      const b = plan.byId[id];
      return PU.packIncremental({
        project: projInfo,
        files: b.plain ? [] : plan.union,
        same: b.same,
        gone: b.gone,
        includeTree: !b.plain && plan.includeTree,
        showLines: project.followList,
        first: b.fresh,
        request,
        mode: project.uploadMode,
        budget,
      });
    };
    const packs = Object.fromEntries(withProject.map((id) => [id, packFor(id)]));
    const upIds = withProject.filter((id) => !plan.byId[id].plain);
    const quiet = withProject.filter((id) => plan.byId[id].plain);
    const base = packs[upIds[0] || quiet[0]];
    const ups = upIds.length ? base.attachments.map(toAttachment) : [];
    const room = ups.length <= budget.files && ups.reduce((n, f) => n + f.data.byteLength, 0) <= budget.bytes;
    if (!room) notice('첨부 한도가 모자라 프로젝트 내용은 본문으로 보냅니다');
    for (const id of upIds) textById[id] = !room || !acceptsDocs(id) ? packs[id].inlineText : packs[id].text;
    for (const id of quiet) textById[id] = packs[id].text;
    const sameCount = Math.max(0, ...withProject.map((id) => plan.byId[id].same.length));
    const what = `바뀐 파일 ${plan.union.length}개 올림${sameCount ? ` · ${sameCount}개는 앞서 보낸 그대로` : ''}`;
    notice(base.note || what);
    pendingSent = {
      files: plan.union,
      treeHash,
      tree: new Set(plan.includeTree ? upIds : []),
      plain: new Set(quiet),
      gone: Object.fromEntries(withProject.map((id) => [id, plan.byId[id].gone])),
    };
    return {
      text: base.text,
      files: room ? [...payload.files, ...ups] : [...payload.files],
      opts: {
        ...payload.opts,
        question: `${payload.text || '(첨부 파일만)'}\n\n[프로젝트 ${project.info.name} · ${what}]`,
        project: { name: project.info.name }, // v0.27.0
        textById,
        fallbackText: base.inlineText,
        plainIds: [...plainIds, ...quiet],
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

  // AI가 아는 내용(지문)과 지금 내용이 같은지. 지워진 파일은 null끼리 같다. 줄바꿈 차이는 무시 (hashText)
  const sameKnown = (entry, text) => (entry === null || text === null ? entry === text : PC.hashText(text) === entry.hash);

  /** id 패널의 AI가 files 내용을 받았다고 기록한다. files: [{ path, text(지워졌으면 null) }], tree: 구조 목록 지문(받았을 때) */
  // "이 AI는 이 파일을 이 내용으로 알고 있다"를 내용 지문으로 기억합니다. 나중에 파일이 바뀌면 그 AI에게 바뀐 내용을 보내 주려고.
  function remember(id, files, tree) {
    if (!files.length && tree === undefined) return;
    sentValid(id);
    if (!project.sent.has(id)) project.sent.set(id, new Map());
    const known = project.sent.get(id);
    for (const f of files) known.set(f.path, PC.sentEntry(f.text));
    if (tree !== undefined) project.sentTree.set(id, tree);
    project.sentEpoch.set(id, panelEpoch(id));
    saveState(); // 같은 실행 안에서 프로젝트를 다시 열어도 이어지게
  }

  // 보내기 전 미리보기에서 취소했거나 스킬 확인에서 멈췄다: 붙였던 파일을 보낸 것으로 기억하지 않는다 (v0.25.0)
  window.onProjectSendCanceled = () => {
    pendingSent = null;
  };

  window.onProjectSent = (okIds) => {
    const sent = pendingSent;
    pendingSent = null;
    if (!sent || !has()) return;
    for (const id of okIds) {
      if (project.blocked.has(id)) continue;
      const gone = (sent.gone[id] || []).map((path) => ({ path, text: null }));
      remember(id, sent.plain.has(id) ? gone : [...sent.files, ...gone], sent.tree.has(id) ? sent.treeHash : undefined);
    }
  };

  // 새 대화를 열면 그 AI는 이전 내용을 모른다.
  window.onPanelCleared = (id) => {
    P.continuing.delete(id); // 새 대화에서는 이어 받을 앞부분이 없다
    P.runs.delete(id); // 파일별로 받던 것도 멈춘다 (새 대화의 AI는 계획을 모른다)
    bumpPanel(id); // 프로젝트를 닫아 둔 동안에도 센다 — 저장된 기록을 다시 열 때 버리게
    const had = project.sent.has(id) || project.sentTree.has(id);
    forgetSent(id);
    if (had) saveState();
    project.stale = project.stale.filter((s) => s.id !== id);
    renderSync();
  };

  /** AI마다 아는 내용과 지금 파일을 비교한다 */
  // AI가 아는 내용과 지금 파일이 달라진 것을 찾아 "⇪ 바뀐 파일 N개 → AI에 보내기" 버튼을 띄웁니다.
  async function checkStale() {
    const stale = [];
    const now = new Map(); // 같은 파일을 여러 번 읽지 않는다
    const read = async (path) => {
      if (!now.has(path)) now.set(path, await P.currentText(path).catch(() => undefined));
      return now.get(path);
    };
    for (const [id, known] of [...project.sent]) {
      if (!panels.has(id) || !sentValid(id)) continue;
      const files = [];
      const deleted = [];
      for (const [path, entry] of known) {
        const cur = await read(path);
        if (cur === undefined || sameKnown(entry, cur)) continue; // 읽지 못한 파일(바이너리·너무 큼)은 건너뛴다
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
      const res = await sendProjectFollowUp(s.id, PU.packUpdate({ files, deleted: s.deleted, mode: project.uploadMode, budget: budgetAfter([], [s.id]) }));
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
    if (P.continuing.has(id) && has()) return P.finishContinue(id, md); // "이어서 받기"로 보낸 부탁의 답 (v0.17.1)
    if (P.runs.get(id)?.status === 'running' && has()) return P.runAnswer(id, md); // 파일별로 받는 중 (v0.18.0)
    if (has() && P.offerRun(id, md)) return; // 계획(PLAN_FILES)만 온 답 → 파일별로 받기 제안
    // 프로젝트가 열려 있으면 수정안을 패널 아래 변경 바로 보여 준다 (📋 모아보기도 바 안에). 바를 띄우지 않으면 머리줄 버튼.
    const barred = has() && (await P.refreshBar(id, md).catch(() => false));
    if (!barred) P.showCollectBtn(id, md).catch(() => {});
    if (!has()) return;
    // 개별 파일 방식이면 AI가 올린 이름(src__a__index.js)으로 요청할 수 있어 실제 경로로 되돌린다
    const wanted = [...new Set(PC.parseNeedFiles(md).map((p) => PU.restorePaths(p).find((c) => entryOf(c)) || p))];
    const p = panels.get(id);
    if (!p) return;
    project.need.set(id, wanted);
    p.needBtn.hidden = !wanted.length;
    p.needBtn.textContent = `[+] 요청 파일 ${wanted.length}개 보내기`;
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
    const res = await sendProjectFollowUp(id, PU.packFollowUp({ files, skipped, mode: project.uploadMode, budget: budgetAfter([], [id]) }));
    if (!res?.ok) alert(`보내지 못했습니다: ${res?.error || '알 수 없는 오류'}`);
    else remember(id, files);
  };

  // ---------- 화면 상태 ----------

  window.onProjectState = () => {
    notePanels(); // 닫은 패널은 다시 열면 새 대화이므로 그 AI가 받은 기록을 버린다
    P.modal.onViewChanged();
    render();
  };

  // 시작할 때 지난번 프로젝트를 다시 연다 (크롬 확장은 접근 허용을 다시 눌러야 할 수 있다).
  // project-changes.js · project-editor.js까지 다 읽은 뒤에 연다 (여는 중에 그 파일의 함수를 부르므로).
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const info = await host.project.restore();
      if (info) await openProject(info);
    } catch (err) {
      console.warn('[project] 지난 프로젝트를 열지 못했습니다:', err.message);
    }
  });

  Object.assign(P, { project, ed, has, MAX_LOG, allowedFor, answerMd, listLines, notice, remember, rescan, saveState, sendProjectFollowUp, renderTree, syncStale, notePanels, openProject, render });
})();
