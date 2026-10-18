// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project.js)
'use strict';

// 프로젝트 모드 화면: 로컬 폴더를 열어 파일 트리에서 고르고, 질문에 프로젝트 맥락을 붙이고,
// AI 답변의 NEED_FILES 요청에 답하고, 코드 수정안을 비교·미리보기·적용·되돌리기 한다.
//
// renderer.js 다음에 읽힌다 ($, state, panels, button, span, flash, fmtSize, attachments 등은 renderer.js의 것).
// 폴더 읽기·쓰기는 host.project (Windows 앱: src/main/project.js / 크롬 확장: extension/project-fs.js),
// 제외 규칙·맥락·diff는 공통 모듈(MLA.projectIgnore · secretScan · projectContext · patch)이 한다.

(() => {
  const PI = MLA.projectIgnore;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
  const PC = MLA.projectContext;
  const PX = MLA.patch;

  const KEY_FILES = ['package.json', 'README.md', 'README', 'readme.md', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'tsconfig.json'];
  const MAX_LOG = 20; // 적용 기록은 최근 20개까지 (되돌리기용 원본 포함)

  const project = {
    info: null, // { name, id, needsPermission? }
    scan: null, // scanProject 결과
    open: false, // 사이드바를 보이는지
    include: true, // 다음 질문에 맥락을 붙일지
    l3Enabled: [],
    checked: new Set(), // 내용을 보낼 파일
    allowSecret: new Set(), // 비밀 정보 경고를 보고도 보내기로 한 파일
    secretHits: new Map(), // path -> 찾은 비밀 정보
    expanded: new Set(['']), // 펼친 폴더
    log: [], // 적용 기록 [{ id, at, ai, files: [{ path, before, after }], reverted }]
    need: new Map(), // 패널 id -> 요청한 파일 목록
  };

  const fsx = () => host.project;
  const has = () => !!project.info && !project.info.needsPermission && !!project.scan;

  // ---------- 저장 ----------

  function saveState() {
    if (!project.info || project.info.needsPermission) return;
    host.project
      .saveState({
        l3Enabled: project.l3Enabled,
        checked: [...project.checked],
        allowSecret: [...project.allowSecret],
        include: project.include,
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
    project.log = Array.isArray(s.log) ? s.log : [];
    return !!s.checked;
  }

  // ---------- 열기 · 훑기 ----------

  async function openProject(info, { fresh = false } = {}) {
    project.info = info;
    project.scan = null;
    project.need.clear();
    project.expanded = new Set(['']);
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

  async function rescan() {
    $('#psSummary').textContent = '폴더를 읽는 중…';
    const globalExclude = await host.project.globalExclude().catch(() => null);
    project.scan = await PI.scanProject(fsx(), { l3Enabled: project.l3Enabled, globalExclude });
    // 고른 파일 중 사라진 것은 뺀다.
    const files = new Set(project.scan.entries.filter((e) => e.kind === 'file').map((e) => e.path));
    for (const p of [...project.checked]) if (!files.has(p)) project.checked.delete(p);
    render();
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
    if (!confirm('프로젝트를 닫을까요? (폴더의 파일은 그대로이고, 적용 기록은 다음에 같은 폴더를 열면 다시 보입니다)')) return;
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
  $('#projectInclude').addEventListener('change', (e) => {
    project.include = e.target.checked;
    saveState();
    render();
  });

  // ---------- 화면 ----------

  const entryOf = (path) => project.scan?.entries.find((e) => e.path === path);
  const sendablePaths = () => project.scan.entries.filter((e) => e.kind === 'file' && (!e.excluded || project.checked.has(e.path))).map((e) => e.path);

  let sidebarSent = null; // 메인/host에 알린 사이드바 상태 (바뀔 때만 알린다 — 알리면 state가 다시 와서 render가 또 불린다)

  function render() {
    const showSide = project.open && !!project.info;
    document.body.classList.toggle('project-open', showSide);
    const side = showSide && state?.mode === 'chat' && state.chatView === 'panels';
    if (side !== sidebarSent) {
      sidebarSent = side;
      host.setSidebar(side);
    }
    $('#projectBtn').classList.toggle('active', !!project.info);
    $('#projectBtn').textContent = project.info ? `📁 ${project.info.name}` : '📁 프로젝트';
    $('#psName').textContent = project.info?.name || '';
    $('#psConnect').hidden = !project.info?.needsPermission;
    $('#projectChip').hidden = !has();
    $('#projectInclude').checked = project.include;
    if (!has()) {
      $('#psTree').replaceChildren();
      $('#psRulesBody').replaceChildren();
      $('#psSummary').textContent = '';
      return;
    }
    renderRules();
    renderTree();
    const chars = [...project.checked].reduce((n, p) => n + (entryOf(p)?.size || 0), 0);
    const amount = chars < 10000 ? `${chars.toLocaleString()}자` : `${(chars / 10000).toFixed(1)}만 자`;
    const summary = `내용 보낼 파일 ${project.checked.size}개 · 약 ${amount} / 보낼 수 있는 파일 ${sendablePaths().length}개`;
    $('#psSummary').textContent = project.scan.truncated ? `${summary} (항목이 많아 일부만 읽음)` : summary;
    $('#projectChipText').textContent = `📁 ${project.info.name} · 파일 ${project.checked.size}개 포함`;
  }

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
      if (e.kind === 'file') row.append(span('sz', fmtSize(e.size)));
      if (e.kind === 'dir') name.addEventListener('click', () => toggleDir(e));
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

  const toAttachment = (name, text) => {
    const data = new TextEncoder().encode(text).buffer;
    return { name, type: 'text/markdown', lastModified: Date.now(), data };
  };

  window.projectPrepareSend = async (payload, targetIds) => {
    if (!has() || !project.include) return payload;
    const { files } = await readChosen([...project.checked]);
    const ctx = PC.buildContext({ project: { name: project.info.name, paths: sendablePaths() }, files, request: payload.text });
    const out = {
      text: ctx.text,
      files: [...payload.files],
      opts: { ...payload.opts, question: `${payload.text || '(첨부 파일만)'}\n\n[프로젝트 ${project.info.name} · 파일 ${files.length}개 내용 포함]` },
    };
    if (ctx.attachment) {
      out.files.push(toAttachment(ctx.attachment.name, ctx.attachment.content));
      // 문서 첨부를 받지 않는 서비스(예: Duck.ai)에는 맥락을 본문으로 넣는다 (넘치는 만큼 잘라서).
      const textById = {};
      for (const id of targetIds) {
        const svc = state.services.find((s) => s.id === id);
        if (svc && !svc.accept.includes('document')) textById[id] = ctx.inlineText;
      }
      out.opts.textById = textById;
    }
    return out;
  };

  // ---------- NEED_FILES ----------

  async function answerMd(id) {
    const { answers } = await host.getAnswers();
    return answers.find((a) => a.id === id)?.md || '';
  }

  window.onPanelAnswerDone = async (id) => {
    if (!has()) return;
    const md = await answerMd(id).catch(() => '');
    const wanted = PC.parseNeedFiles(md);
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

  window.onNeedFilesClick = async (id) => {
    if (!has()) return alert('프로젝트가 열려 있지 않습니다');
    const wanted = project.need.get(id) || [];
    const ok = [];
    const skipped = [];
    for (const path of wanted) {
      const why = refuseReason(path);
      if (why) skipped.push({ path, reason: why });
      else ok.push(PX.safeRelPath(path));
    }
    const read = await readChosen(ok);
    if (!read.files.length && !confirm('보낼 수 있는 파일이 없습니다. 이유만 알려 줄까요?')) return;
    const p = panels.get(id);
    p.needBtn.hidden = true;
    const res = await host.sendFollowUp(id, PC.buildFollowUp(read.files, [...skipped, ...read.skipped]));
    if (!res?.ok) alert(`보내지 못했습니다: ${res?.error || '알 수 없는 오류'}`);
  };

  // ---------- 변경 제안 ----------

  let plansByAi = []; // [{ id, name, color, plans: [{ change, plan, block }] }]

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

  async function planAll() {
    const { answers } = await host.getAnswers();
    const out = [];
    for (const a of answers) {
      const plans = [];
      for (const change of PX.extractChanges(a.md || '')) {
        const block = writeBlocked(change.path);
        let plan;
        try {
          plan = block ? { path: change.path, ok: false, error: block, op: 'modify' } : PX.planChange(change, await currentText(change.path));
        } catch (err) {
          plan = { path: change.path, ok: false, error: err.message, op: 'modify' };
        }
        plans.push({ change, plan });
      }
      out.push({ id: a.id, name: a.name, color: a.color, plans });
    }
    return out;
  }

  const OP_TEXT = { modify: '수정', create: '새 파일', delete: '삭제' };

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
    if (!ai.plans.length) list.append(span('change-empty', '이 답변에는 적용할 수정안(diff 또는 "파일: 경로" 코드 블록)이 없습니다.'));
    for (const { change, plan } of ai.plans) {
      const row = document.createElement('div');
      row.className = 'change-row';
      row.append(span(`op ${plan.ok ? plan.op : 'bad'}`, plan.ok ? OP_TEXT[plan.op] : '⚠ 적용 불가'), span('path', plan.path));
      if (plan.ok) row.append(span('add', `+${plan.add}`), span('del', `−${plan.del}`));
      else {
        const err = span('err', plan.error);
        row.title = plan.error;
        row.append(err);
        if (change.type === 'diff' && !change.isNew && !writeBlocked(change.path)) {
          row.append(button('전체 파일 다시 요청', '현재 내용을 주고 수정한 전체 파일로 다시 달라고 합니다', () => refetch(ai, change.path)));
        }
      }
      list.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'change-foot';
    const applyBtn = button('미리보기·적용', `${ai.name}의 수정안을 미리 보고 적용합니다`, () => openPreview(ai));
    applyBtn.disabled = !ok.length;
    foot.append(applyBtn);
    col.append(head, list, foot);
    return col;
  }

  async function refetch(ai, path) {
    try {
      const text = await currentText(path);
      if (text === null) return alert('파일이 없습니다');
      const res = await host.sendFollowUp(ai.id, PC.buildRefetch(path, text));
      if (!res?.ok) return alert(`보내지 못했습니다: ${res?.error}`);
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

  const modal = {
    show(title, note) {
      $('#patchTitle').textContent = title;
      $('#patchNote').textContent = note || '';
      $('#patchStatus').textContent = '';
      $('#patchModal').hidden = false;
    },
    hide() {
      $('#patchModal').hidden = true;
      $('#patchApply').onclick = null;
    },
  };
  $('#patchCancel').addEventListener('click', () => modal.hide());

  function diffPre(text) {
    const pre = document.createElement('pre');
    for (const line of text.split('\n')) {
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      pre.append(span(line.startsWith('+') ? 'a' : line.startsWith('-') ? 'd' : line.startsWith('@@') ? 'h' : '', line || ' '));
    }
    return pre;
  }

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
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
        boxes.push({ box, plan });
        head.append(box, span(`op ${plan.op}`, OP_TEXT[plan.op]), span('path', plan.path), span('add', `+${plan.add}`), span('del', `−${plan.del}`));
        pf.append(head, diffPre(plan.preview));
        return pf;
      }),
    );
    $('#patchApply').hidden = false;
    $('#patchApply').textContent = '선택한 파일 적용';
    $('#patchApply').onclick = async () => {
      const chosen = boxes.filter((b) => b.box.checked).map((b) => b.plan);
      if (!chosen.length) return ($('#patchStatus').textContent = '적용할 파일을 고르세요');
      $('#patchApply').disabled = true;
      try {
        const result = await applyPlans(ai, chosen);
        $('#patchStatus').textContent = result;
        setTimeout(() => {
          modal.hide();
          window.renderChanges();
        }, 900);
      } finally {
        $('#patchApply').disabled = false;
      }
    };
  }

  /** 적용: 쓰기 직전에 파일이 바뀌었으면 다시 계산한다. 원본은 적용 기록에 남긴다. */
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
    if (done.length) {
      project.log.unshift({ id: `${Date.now().toString(36)}`, at: Date.now(), ai: ai.name, files: done, reverted: false });
      project.log.length = Math.min(project.log.length, MAX_LOG);
      saveState();
      await rescan();
    }
    if (failed.length) alert(`적용하지 못한 파일:\n${failed.join('\n')}`);
    return `${done.length}개 파일을 적용했습니다${failed.length ? ` · ${failed.length}개 실패` : ''}`;
  }

  const fmtAt = (ms) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  $('#changesLog').addEventListener('click', () => {
    modal.show('적용 기록', '최근 20개. 되돌리면 적용하기 전 내용으로 돌아갑니다 (새로 만든 파일은 지웁니다).');
    $('#patchApply').hidden = true;
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
    saveState();
    await rescan();
    if (failed.length) alert(`되돌리지 못한 파일:\n${failed.join('\n')}`);
  }

  // ---------- 화면 상태 ----------

  window.onProjectState = () => render();

  // 시작할 때 지난번 프로젝트를 다시 연다 (크롬 확장은 접근 허용을 다시 눌러야 할 수 있다).
  (async () => {
    try {
      const info = await host.project.restore();
      if (info) await openProject(info);
    } catch (err) {
      console.warn('[project] 지난 프로젝트를 열지 못했습니다:', err.message);
    }
  })();
})();
