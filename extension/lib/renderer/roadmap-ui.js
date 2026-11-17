// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/roadmap-ui.js)
'use strict';

// 로드맵 창 (v0.38.0) — Windows 앱과 크롬 확장이 똑같이 씀. project-editor.js 다음, library.js 앞에서 읽힌다.
// 툴바 [로드맵] → 창 하나에 탭 4개: 계획(계획서 넣기 · AI에게 단계 분해 부탁 · 답 붙여넣기) · 작업(마일스톤별 작업 · 상태 · 편집 · 구현 요청) ·
// 대시보드(진행 링 · 마일스톤 막대 · 선행 관계 지도 · 번다운) · 문서(docs/procedure.md · README.md 만들기 · 설정).
// 계산은 shared/roadmap.js · roadmap-charts.js · roadmap-docs.js. 파일은 host.project(고른 프로젝트 폴더 안에서만 읽기 · 쓰기)로만 다룬다:
//   진행 데이터  <프로젝트>/.mla/roadmap.json  (AI에게는 보내지 않는 제외 규칙에 들어 있다)
//   문서         <프로젝트>/docs/procedure.md · README.md (기존 README가 있으면 기본은 README.generated.md)
// Windows 앱은 패널 웹페이지가 화면 맨 위에 얹혀 있어 창을 띄울 때 'dialog' 화면으로 바꿔 패널을 치운다 (작업 흐름 창과 같음).
// "구현 요청"은 작업 요청 글을 입력창에 채워 줄 뿐 보내지는 않는다 — 보내기 · 수정안 확인 · 적용 · 테스트는 프로젝트 모드의 기존 흐름 그대로, 사람이 확인한다.
//
// [쉽게 말하면] 계획서를 일감 목록으로 나누고, 일감마다 어디까지 했는지 그림으로 보여 주며, 진행 과정을 문서로 정리해 주는 창입니다.

(() => {
  const RM = MLA.roadmap;
  const CH = MLA.roadmapCharts;
  const DOCS = MLA.roadmapDocs;
  const P = MLA.projectUI;

  let open = null; // { dialog, pending, tab }
  let rm = null; // 지금 로드맵 (없으면 null)
  let loadedFor = ''; // 어느 프로젝트의 것을 읽었는지
  let saveTimer = null;
  let lastWrite = null; // 문서 쓰기 되돌리기용 [{ path, before }]
  let editing = ''; // 편집 중인 작업 id
  let busy = false; // AI에게 보내는 중 (두 번 눌러 두 번 보내지 않게)
  let draftSettings = null; // 로드맵을 만들기 전에 문서 탭에서 바꾼 설정 — 분해해 만든 로드맵에 넘긴다 (v0.38.1)

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const nameOf = (id) => state?.services.find((s) => s.id === id)?.name || id;
  const openIds = () => (state?.rects || []).map((r) => r.id);
  const hasProject = () => !!(P && P.has && P.has());
  const status = (msg, kind = '') => {
    const s = $('#roadmapStatus');
    s.textContent = msg || '';
    s.dataset.kind = kind;
  };
  const docsLang = () => (rm?.settings.docsLang === 'auto' ? MLA.i18n.getLang() : rm?.settings.docsLang || MLA.i18n.getLang());

  // 차트 CSS는 styles.css에 있다 — 앱의 CSP(style-src 'self')가 끼워 넣은 <style>을 막기 때문 (v0.38.1).
  // 내보내기 HTML만 CH.CSS를 파일 안에 넣는다.

  // ---------- 읽기 · 저장 ----------
  async function readText(rel) {
    try {
      const r = await host.project.readFile(rel);
      return typeof r?.text === 'string' ? r.text : null;
    } catch {
      return null;
    }
  }

  async function loadRoadmap() {
    if (!hasProject()) {
      rm = null;
      loadedFor = '';
      return;
    }
    const key = P.project.info.id || P.project.info.name;
    if (loadedFor === key && rm) return;
    loadedFor = key;
    const text = await readText(DOCS.STATE_PATH);
    rm = null;
    draftSettings = null;
    if (text) {
      try {
        const next = RM.normalizeRoadmap(JSON.parse(text));
        if (RM.tasksOf(next).length) rm = next;
      } catch {}
    }
  }

  /** 진행 데이터 저장 (바로 이어 저장하는 일이 많아 조금 모아서) */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (!rm || !hasProject()) return;
    try {
      await host.project.writeFile(DOCS.STATE_PATH, `${JSON.stringify(rm, null, 2)}\n`);
    } catch (err) {
      status(t('ui.roadmap.saveFail', { msg: err.message }), 'warn');
    }
  }

  // ---------- 창 열기 · 닫기 ----------
  function close() {
    if (!open) return;
    const { dialog } = open;
    flush();
    open = null;
    $('#roadmapModal').hidden = true;
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }

  async function openDialog() {
    if (open) return close();
    if (!hasProject()) return alert(t('ui.roadmap.needProject'));
    const dialog = state?.chatView === 'panels';
    open = { dialog, pending: dialog, tab: 'plan' };
    if (dialog) host.setView('dialog');
    await loadRoadmap();
    if (!open) return;
    open.tab = rm ? 'tasks' : 'plan';
    $('#roadmapModal').hidden = false;
    render();
    $('#roadmapClose').focus();
  }

  window.onRoadmapState = () => {
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

  // ---------- 그리기 ----------
  const TABS = ['plan', 'tasks', 'dash', 'docs'];
  function render() {
    if (!open) return;
    $('#roadmapSub').textContent = rm ? `${rm.title} · ${RM.progress(rm).pct}%` : P.project.info.name;
    for (const k of TABS) {
      const b = $(`#roadmapTab-${k}`);
      b.setAttribute('aria-selected', String(open.tab === k));
      b.tabIndex = open.tab === k ? 0 : -1;
      $(`#roadmapPane-${k}`).hidden = open.tab !== k;
    }
    ({ plan: renderPlan, tasks: renderTasks, dash: renderDash, docs: renderDocs })[open.tab]();
  }

  function setTab(k) {
    if (!open) return;
    open.tab = k;
    status('');
    render();
  }

  // ----- 계획 탭 -----
  function fillTargets() {
    const sel = $('#roadmapWho');
    const keep = sel.value;
    sel.replaceChildren(...openIds().map((id) => Object.assign(document.createElement('option'), { value: id, textContent: nameOf(id) })));
    if (openIds().includes(keep)) sel.value = keep;
  }

  function renderPlan() {
    fillTargets();
    $('#roadmapPlanHave').hidden = !rm;
    $('#roadmapPlanHave').textContent = rm ? t('ui.roadmap.plan.have', { n: RM.tasksOf(rm).length }) : '';
    const warn = $('#roadmapWarn');
    warn.hidden = !warn.textContent;
  }

  /** 프로젝트 폴더의 계획서 후보를 찾아 입력칸에 채운다 */
  async function loadPlanFile() {
    for (const rel of ['PLAN.md', 'plan.md', 'docs/plan.md', 'docs/PLAN.md', 'ROADMAP.md']) {
      const text = await readText(rel);
      if (text) {
        $('#roadmapPlan').value = text.slice(0, RM.MAX_PLAN_CHARS);
        status(t('ui.roadmap.plan.loaded', { path: rel }));
        return;
      }
    }
    status(t('ui.roadmap.plan.noFile'), 'warn');
  }

  async function topLevel() {
    try {
      return (await host.project.readDir('')) || [];
    } catch {
      return [];
    }
  }

  async function treeText() {
    const top = await topLevel();
    return top
      .filter((e) => !/^\.(git|mla)$/.test(e.name) && e.name !== 'node_modules')
      .map((e) => `${e.name}${e.kind === 'dir' ? '/' : ''}`)
      .join('\n');
  }

  async function sendDecompose() {
    const plan = $('#roadmapPlan').value.trim();
    const who = $('#roadmapWho').value;
    if (!plan) return status(t('ui.roadmap.plan.empty'), 'warn');
    if (!who) return status(t('ui.roadmap.plan.noAi'), 'warn');
    if (busy) return;
    busy = true;
    try {
      const text = RM.buildDecomposePrompt({ plan, tree: await treeText(), lang: MLA.i18n.getLang() });
      const results = await host.sendPrompt(text, [who], [], { question: t('ui.roadmap.plan.question') });
      const r = results?.[0];
      status(r?.ok ? t('ui.roadmap.plan.sent', { name: nameOf(who) }) : t('ui.roadmap.plan.sendFail', { name: nameOf(who) }), r?.ok ? '' : 'warn');
    } catch (err) {
      status(t('ui.send.error', { msg: err.message }), 'warn');
    } finally {
      busy = false;
    }
  }

  async function fetchAnswer(into) {
    const who = $('#roadmapWho').value;
    const got = await host.getAnswers().catch(() => ({ answers: [] }));
    const a = (got.answers || []).find((x) => x.id === who && x.text);
    if (!a) return status(t('ui.roadmap.plan.noAnswer', { name: nameOf(who) }), 'warn');
    $(into).value = a.text;
    status(t('ui.roadmap.plan.gotAnswer', { name: nameOf(who) }));
  }

  function applyDecomposition() {
    const text = $('#roadmapAnswer').value;
    if (!text.trim()) return status(t('ui.roadmap.plan.emptyAnswer'), 'warn');
    if (rm && RM.progress(rm).done && !confirm(t('ui.roadmap.plan.replaceConfirm'))) return;
    const r = RM.parseDecomposition(text, { plan: $('#roadmapPlan').value.trim(), lang: MLA.i18n.getLang() });
    const warn = $('#roadmapWarn');
    if (!r.ok) {
      warn.textContent = r.error;
      warn.hidden = false;
      return status(t('ui.roadmap.plan.parseFail'), 'warn');
    }
    const keepSettings = rm?.settings || draftSettings;
    const keepDocs = rm?.docs;
    rm = r.roadmap;
    if (keepSettings) rm.settings = { ...rm.settings, ...keepSettings };
    draftSettings = null;
    if (keepDocs && (keepDocs.intro || keepDocs.features.length)) rm.docs = keepDocs;
    warn.textContent = r.warnings.join('\n');
    warn.hidden = !r.warnings.length;
    persist();
    status(t('ui.roadmap.plan.ok', { n: RM.tasksOf(rm).length, m: rm.milestones.length }));
    open.tab = 'tasks';
    render();
    maybeDocs('create');
  }

  // ----- 작업 탭 -----
  const stName = (s) => t(`ui.roadmap.status.${s}`);

  function taskRow(tk) {
    const locked = tk.status === 'todo' && !RM.isUnlocked(rm, tk);
    const row = el('div', `rm-task rm-s-${tk.status}${locked ? ' rm-locked' : ''}`);
    row.dataset.task = tk.id;
    const head = el('div', 'rm-task-head');
    head.append(el('span', 'rm-glyph-lg', CH.GLYPH[tk.status]), el('b', '', `${tk.id} ${tk.title}`), el('span', 'muted-label', `×${tk.weight}`));
    if (locked) head.append(el('span', 'muted-label', t('ui.roadmap.locked', { ids: RM.blockedBy(rm, tk).join(', ') })));
    const sel = el('select', 'rm-status');
    sel.setAttribute('aria-label', t('ui.roadmap.statusLabel', { id: tk.id }));
    sel.append(...RM.STATUSES.map((s) => Object.assign(document.createElement('option'), { value: s, textContent: `${CH.GLYPH[s]} ${stName(s)}` })));
    sel.value = tk.status;
    sel.addEventListener('change', () => changeStatus(tk.id, sel.value, sel));
    const acts = el('div', 'rm-acts');
    const implement = button(t('ui.roadmap.implement'), t('ui.roadmap.implementTitle'), () => implementTask(tk.id));
    implement.disabled = locked || tk.status === 'done';
    acts.append(
      implement,
      button('▲', t('ui.roadmap.up'), () => mutate(RM.moveTask(rm, tk.id, -1))),
      button('▼', t('ui.roadmap.down'), () => mutate(RM.moveTask(rm, tk.id, 1))),
      button(t('ui.roadmap.edit'), t('ui.roadmap.editTitle'), () => {
        editing = editing === tk.id ? '' : tk.id;
        render();
      }),
      button('✕', t('ui.roadmap.remove'), () => {
        if (confirm(t('ui.roadmap.removeConfirm', { id: tk.id }))) mutate(RM.removeTask(rm, tk.id));
      }),
    );
    row.append(head, sel, acts);
    if (tk.accept) row.append(el('div', 'muted small rm-accept', `${t('ui.roadmap.accept')}: ${tk.accept}`));
    if (tk.note) row.append(el('div', 'muted small', `${t('ui.roadmap.note')}: ${tk.note}`));
    if (editing === tk.id) row.append(editForm(tk));
    return row;
  }

  function field(label, node) {
    const l = el('label', 'rm-field');
    l.append(el('span', 'muted-label', label), node);
    return l;
  }

  function editForm(tk) {
    const f = el('div', 'rm-edit');
    const title = Object.assign(el('input'), { type: 'text', value: tk.title });
    const desc = Object.assign(el('textarea'), { rows: 2, value: tk.desc });
    const accept = Object.assign(el('textarea'), { rows: 2, value: tk.accept });
    const files = Object.assign(el('input'), { type: 'text', value: tk.files.join(', ') });
    const deps = Object.assign(el('input'), { type: 'text', value: tk.deps.join(', ') });
    const weight = Object.assign(el('input'), { type: 'number', min: 1, max: 5, value: tk.weight });
    const merge = el('select');
    merge.append(Object.assign(document.createElement('option'), { value: '', textContent: t('ui.roadmap.mergeNone') }), ...RM.tasksOf(rm).filter((x) => x.id !== tk.id).map((x) => Object.assign(document.createElement('option'), { value: x.id, textContent: `${x.id} ${x.title}` })));
    const save = button(t('ui.roadmap.save'), '', () => {
      const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
      const next = RM.updateTask(rm, tk.id, { title: title.value, desc: desc.value, accept: accept.value, files: split(files.value), deps: split(deps.value), weight: weight.value });
      if (next === rm) status(t('ui.roadmap.editCycle'), 'warn');
      editing = '';
      mutate(next);
    });
    save.classList.add('primary');
    const doMerge = button(t('ui.roadmap.merge'), t('ui.roadmap.mergeTitle'), () => {
      if (!merge.value) return;
      const next = RM.mergeTasks(rm, tk.id, merge.value);
      if (next === rm) status(t('ui.roadmap.editCycle'), 'warn');
      editing = '';
      mutate(next);
    });
    f.append(field(t('ui.roadmap.f.title'), title), field(t('ui.roadmap.f.desc'), desc), field(t('ui.roadmap.f.accept'), accept), field(t('ui.roadmap.f.files'), files), field(t('ui.roadmap.f.deps'), deps), field(t('ui.roadmap.f.weight'), weight), field(t('ui.roadmap.f.merge'), merge));
    const bar = el('div', 'rm-edit-bar');
    bar.append(save, doMerge, button(t('ui.roadmap.cancel'), '', () => ((editing = ''), render())));
    f.append(bar);
    return f;
  }

  function renderTasks() {
    const box = $('#roadmapTasks');
    if (!rm) {
      box.replaceChildren(el('p', 'muted', t('ui.roadmap.noRoadmap')));
      return;
    }
    const next = RM.nextTask(rm);
    const out = [];
    const nx = el('p', 'rm-next', next ? t('ui.roadmap.next', { id: next.id, title: next.title }) : t('ui.roadmap.allDone'));
    out.push(nx);
    for (const m of rm.milestones) {
      const mp = RM.progress(rm).milestones.find((x) => x.id === m.id);
      const sec = el('section', 'rm-ms');
      const h = el('h3', '', `${m.title} · ${mp ? mp.pct : 0}%`);
      const add = button(t('ui.roadmap.addTask'), t('ui.roadmap.addTaskTitle'), () => {
        const title = prompt(t('ui.roadmap.addTaskPrompt'));
        if (title && title.trim()) mutate(RM.addTask(rm, m.id, { title }));
      });
      sec.append(h, ...m.tasks.map((tk) => taskRow({ ...tk, milestone: m.id })), add);
      out.push(sec);
    }
    out.push(
      button(t('ui.roadmap.addMilestone'), '', () => {
        const title = prompt(t('ui.roadmap.addMilestonePrompt'));
        if (title && title.trim()) mutate(RM.addMilestone(rm, title));
      }),
    );
    box.replaceChildren(...out);
  }

  /** 로드맵 바꾸기 → 저장 · 다시 그리기 */
  function mutate(next) {
    if (!next || next === rm) return render();
    rm = { ...next, updatedAt: new Date().toISOString() };
    persist();
    render();
  }

  async function changeStatus(id, to, sel) {
    const r = RM.setStatus(rm, id, to, { lang: MLA.i18n.getLang() });
    if (!r.ok) {
      status(r.error, 'warn');
      sel.value = RM.findTask(rm, id).status;
      return;
    }
    if (!r.changed) return;
    let note = '';
    if (to === 'blocked') note = prompt(t('ui.roadmap.blockedPrompt')) || '';
    const r2 = note ? RM.setStatus(r.roadmap, id, to, { note, lang: MLA.i18n.getLang() }) : r;
    const prevMs = RM.progress(rm).milestones;
    rm = r2.roadmap;
    persist();
    render();
    if (to === 'done') await afterDone(id, prevMs);
    else await maybeDocs('task');
    // 완료에서 되돌렸는데 이미 시작 · 끝낸 후속 작업이 있으면 알린다 (상태는 그대로 둔다). 문서 쓰기 알림에 덮이지 않게 마지막에
    if (r.dependents?.length) status(t('ui.roadmap.reopened', { id, ids: r.dependents.join(', ') }), 'warn');
  }

  /** 작업 요청 글을 입력창에 채운다 (보내지는 않는다). 상태는 "진행 중"으로 */
  function implementTask(id) {
    const tk = RM.findTask(rm, id);
    if (!tk || !RM.isUnlocked(rm, tk)) return;
    $('#prompt').value = RM.buildTaskPrompt(rm, id, { lang: MLA.i18n.getLang() });
    const r = RM.setStatus(rm, id, 'doing', { lang: MLA.i18n.getLang() });
    if (r.ok && r.changed) {
      rm = r.roadmap;
      persist();
    }
    // 작업의 예상 파일 중 프로젝트에 있는 것은 고른 파일에 넣어 요청에 함께 간다
    let n = 0;
    for (const f of tk.files) {
      const e = P.entryOf && P.entryOf(f);
      if (e && e.kind === 'file' && !P.project.checked.has(f)) {
        P.toggleFile(e, true);
        n++;
      }
    }
    close();
    $('#sendHint').textContent = t('ui.roadmap.filled', { id, n });
    $('#prompt').focus();
  }

  /** 완료 뒤: (선택) 작업 단위 커밋 → 문서 갱신 */
  async function afterDone(id, prevMs) {
    const tk = RM.findTask(rm, id);
    if (rm.settings.autoCommit && host.git?.commit && tk) {
      const paths = tk.files.filter((f) => P.entryOf && P.entryOf(f));
      if (paths.length) {
        const r = await host.git.commit({ paths, message: `feat(${tk.id}): ${tk.title}` }).catch((e) => ({ ok: false, error: e.message }));
        if (r?.ok) {
          const sha = /^[0-9a-f]{7,40}$/i.test(r.hash || '') ? r.hash : '';
          if (sha) {
            const s = RM.setStatus(rm, id, 'done', { commit: sha, lang: MLA.i18n.getLang() });
            if (s.ok) rm = s.roadmap;
          }
          status(t('ui.roadmap.committed', { id }));
        } else status(t('ui.roadmap.commitFail', { msg: r?.error || '' }), 'warn');
        persist();
      }
    }
    const nowMs = RM.progress(rm).milestones;
    const milestoneDone = nowMs.some((m, i) => m.done && !prevMs[i]?.done);
    maybeDocs(milestoneDone ? 'milestone' : 'task');
    render();
  }

  // ----- 대시보드 탭 -----
  function renderDash() {
    const box = $('#roadmapDash');
    if (!rm) {
      box.replaceChildren(el('p', 'muted', t('ui.roadmap.noRoadmap')));
      return;
    }
    const cur = RM.nextTask(rm)?.id || '';
    box.innerHTML = CH.dashboardHtml(rm, { current: cur });
    for (const node of box.querySelectorAll('.rm-node')) {
      const go = () => {
        editing = '';
        setTab('tasks');
        $(`#roadmapTasks [data-task="${CSS.escape(node.dataset.task)}"]`)?.scrollIntoView({ block: 'center' });
      };
      node.addEventListener('click', go);
      node.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
    }
  }

  async function exportHtml() {
    if (!rm) return;
    const html = `<!doctype html><html lang="${MLA.i18n.getLang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CH.esc(rm.title)}</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#fff;color:#1f2328}h1{font-size:20px}.rm-scroll{overflow:auto}${CH.CSS_LIGHT}</style></head><body><h1>${CH.esc(rm.title)}</h1>${CH.dashboardHtml(rm, {})}</body></html>`;
    const r = await host.saveFile({ name: `${rm.title}-roadmap`, text: html, kind: 'html' }).catch((e) => ({ ok: false, error: e.message }));
    status(r?.ok ? t('ui.roadmap.exported') : r?.cancelled ? '' : t('ui.roadmap.exportFail', { msg: r?.error || '' }), r?.ok || r?.cancelled ? '' : 'warn');
  }

  // ----- 문서 탭 -----
  function renderDocs() {
    const s = rm?.settings || draftSettings || RM.DEFAULT_SETTINGS;
    $('#roadmapDocsOn').checked = s.docs;
    $('#roadmapDocsWhen').value = s.docsWhen;
    $('#roadmapReadmeMode').value = s.readmeMode;
    $('#roadmapDocsLang').value = s.docsLang;
    $('#roadmapMermaid').checked = s.mermaid;
    $('#roadmapAutoCommit').checked = s.autoCommit;
    $('#roadmapAutoCommit').disabled = !host.git?.commit;
    for (const id of ['#roadmapDocsMake', '#roadmapIntroAsk', '#roadmapIntroGet']) $(id).disabled = !rm;
    $('#roadmapDocsUndo').disabled = !lastWrite;
    $('#roadmapDocsPreview').replaceChildren();
  }

  function setting(key, value) {
    if (!rm) {
      // 아직 로드맵이 없으면 기억해 두었다가 분해해 만든 로드맵에 넘긴다 (켜고 끈 설정이 사라지지 않게)
      draftSettings = { ...(draftSettings || RM.DEFAULT_SETTINGS), [key]: value };
      return;
    }
    rm = { ...rm, settings: { ...rm.settings, [key]: value } };
    persist();
  }

  async function buildPlans() {
    const pkgText = await readText('package.json');
    let pkg = null;
    try {
      pkg = pkgText ? JSON.parse(pkgText) : null;
    } catch {}
    const top = await topLevel();
    const common = { rm, mode: rm.settings.readmeMode, lang: docsLang(), mermaid: rm.settings.mermaid, pkg, top };
    const plans = [];
    for (const kind of ['procedure', 'readme']) {
      const main = kind === 'procedure' ? DOCS.PROCEDURE_PATH : DOCS.README_PATH;
      const alt = kind === 'procedure' ? DOCS.PROCEDURE_ALT : DOCS.README_ALT;
      const existing = await readText(main);
      const existingAlt = existing != null ? await readText(alt) : null;
      const plan = DOCS.planWrite({ ...common, kind, existing, existingAlt });
      plan.before = plan.path === main ? existing : existingAlt;
      plans.push(plan);
    }
    return plans;
  }

  /** 문서 만들기: 미리보기 → 확인 → 쓰기 (auto: 확인 없이 쓰되 비밀 정보 · 덮어쓰기 위험이 없을 때만) */
  async function makeDocs({ auto = false } = {}) {
    if (!rm || !hasProject()) return;
    const plans = (await buildPlans()).filter((p) => p.action !== 'unchanged');
    const box = $('#roadmapDocsPreview');
    if (!plans.length) {
      box.replaceChildren(el('p', 'muted', t('ui.roadmap.docs.same')));
      return status(t('ui.roadmap.docs.same'));
    }
    const secrets = DOCS.scanDocs(plans);
    if (secrets.length) {
      status(t('ui.roadmap.docs.secret', { list: secrets.map((s) => `${s.path}: ${s.labels.join(', ')}`).join(' · ') }), 'warn');
      return;
    }
    // 자동 갱신은 새로 만들거나(create) 표식 구역만 바꾸는(update) 때, 별도 파일에 쓸 때만. 덮어쓰기 · 끝에 붙이기는 직접 확인
    const safe = (p) => ['create', 'update', 'separate'].includes(p.action);
    if (auto && plans.every(safe)) return writePlans(plans);
    const rows = plans.map((p) => {
      const row = el('div', 'rm-doc-plan');
      row.append(el('b', '', p.path), el('span', 'muted-label', t(`ui.roadmap.docs.action.${p.action}`)), el('span', 'muted small', t('ui.roadmap.docs.size', { n: p.text.length })));
      const pre = el('pre', 'rm-doc-pre', p.text.split('\n').slice(0, 24).join('\n'));
      row.append(pre);
      return row;
    });
    const go = button(t('ui.roadmap.docs.write'), '', () => writePlans(plans));
    go.classList.add('primary');
    box.replaceChildren(...rows, go);
    status(t('ui.roadmap.docs.review'));
  }

  async function writePlans(plans) {
    const undo = [];
    try {
      for (const p of plans) {
        undo.push({ path: p.path, before: p.before ?? null });
        await host.project.writeFile(p.path, p.text);
      }
    } catch (err) {
      // 중간에 실패하면 원래대로: 있던 파일은 전 글로, 이번에 새로 만든 파일은 지운다
      for (const u of undo.reverse()) {
        try {
          if (u.before != null) await host.project.writeFile(u.path, u.before);
          else await host.project.deleteFile(u.path);
        } catch {}
      }
      status(t('ui.roadmap.docs.fail', { msg: err.message }), 'warn');
      return;
    }
    lastWrite = undo;
    $('#roadmapDocsUndo').disabled = false;
    $('#roadmapDocsPreview').replaceChildren();
    status(t('ui.roadmap.docs.done', { list: plans.map((p) => p.path).join(', ') }));
    P.rescan?.();
  }

  async function undoDocs() {
    if (!lastWrite) return;
    try {
      for (const u of lastWrite) {
        if (u.before != null) await host.project.writeFile(u.path, u.before);
        else await host.project.deleteFile(u.path);
      }
      lastWrite = null;
      $('#roadmapDocsUndo').disabled = true;
      status(t('ui.roadmap.docs.undone'));
      P.rescan?.();
    } catch (err) {
      status(t('ui.roadmap.docs.fail', { msg: err.message }), 'warn');
    }
  }

  /** 설정의 갱신 시점에 맞으면 문서를 자동으로 쓴다 (when: 'create' | 'task' | 'milestone'). 끝날 때까지 기다릴 수 있게 Promise를 돌려준다 */
  function maybeDocs(when) {
    if (!rm || !rm.settings.docs || rm.settings.docsWhen === 'manual') return Promise.resolve();
    // 'create'와 'milestone'은 task · milestone 설정 모두에서, 'task'는 task 설정에서만 쓴다
    if (when === 'task' && rm.settings.docsWhen !== 'task') return Promise.resolve();
    return makeDocs({ auto: true }).catch(() => {});
  }

  async function askIntro() {
    const who = $('#roadmapWho').value || openIds()[0];
    if (!who) return status(t('ui.roadmap.plan.noAi'), 'warn');
    if (busy) return;
    busy = true;
    try {
      const r = await host.sendPrompt(RM.buildDocsPrompt(rm, { lang: docsLang() }), [who], [], { question: t('ui.roadmap.docs.introQuestion') });
      status(r?.[0]?.ok ? t('ui.roadmap.plan.sent', { name: nameOf(who) }) : t('ui.roadmap.plan.sendFail', { name: nameOf(who) }), r?.[0]?.ok ? '' : 'warn');
    } catch (err) {
      status(t('ui.send.error', { msg: err.message }), 'warn');
    } finally {
      busy = false;
    }
  }

  /** 소개 문장 가져오기: 계획 탭에서 고른 AI의 답을 먼저 보고, 거기 없을 때만 다른 패널의 답을 본다 */
  async function getIntro() {
    const who = $('#roadmapWho').value;
    const got = await host.getAnswers().catch(() => ({ answers: [] }));
    const answers = (got.answers || []).slice().sort((a, b) => (b.id === who) - (a.id === who));
    for (const a of answers) {
      const info = a.text ? RM.parseDocsInfo(a.text) : null;
      if (info) {
        rm = { ...rm, docs: info };
        persist();
        status(t('ui.roadmap.docs.introOk', { name: nameOf(a.id) }));
        return;
      }
    }
    status(t('ui.roadmap.docs.introNone'), 'warn');
  }

  // ---------- 이벤트 ----------
  $('#roadmapBtn').addEventListener('click', openDialog);
  $('#roadmapClose').addEventListener('click', close);
  $('#roadmapModal').addEventListener('click', (e) => e.target === $('#roadmapModal') && close());
  $('#roadmapModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  for (const k of TABS) $(`#roadmapTab-${k}`).addEventListener('click', () => setTab(k));
  $('#roadmapTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.indexOf(open.tab) + (e.key === 'ArrowRight' ? 1 : -1);
    setTab(TABS[(i + TABS.length) % TABS.length]);
    $(`#roadmapTab-${open.tab}`).focus();
  });
  $('#roadmapPlanFile').addEventListener('click', loadPlanFile);
  $('#roadmapPickFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (/\.pdf$/i.test(f.name)) return status(t('ui.roadmap.plan.pdf'), 'warn');
    if (f.size > 2 * 1024 * 1024) return status(t('ui.roadmap.plan.tooBig'), 'warn');
    $('#roadmapPlan').value = (await f.text()).slice(0, RM.MAX_PLAN_CHARS);
    status(t('ui.roadmap.plan.loaded', { path: f.name }));
  });
  $('#roadmapSendPlan').addEventListener('click', sendDecompose);
  $('#roadmapGetAnswer').addEventListener('click', () => fetchAnswer('#roadmapAnswer'));
  $('#roadmapApply').addEventListener('click', applyDecomposition);
  $('#roadmapExport').addEventListener('click', exportHtml);
  $('#roadmapDocsMake').addEventListener('click', () => makeDocs());
  $('#roadmapDocsUndo').addEventListener('click', undoDocs);
  $('#roadmapIntroAsk').addEventListener('click', askIntro);
  $('#roadmapIntroGet').addEventListener('click', getIntro);
  $('#roadmapDocsOn').addEventListener('change', (e) => setting('docs', e.target.checked));
  $('#roadmapDocsWhen').addEventListener('change', (e) => setting('docsWhen', e.target.value));
  $('#roadmapReadmeMode').addEventListener('change', (e) => setting('readmeMode', e.target.value));
  $('#roadmapDocsLang').addEventListener('change', (e) => setting('docsLang', e.target.value));
  $('#roadmapMermaid').addEventListener('change', (e) => setting('mermaid', e.target.checked));
  $('#roadmapAutoCommit').addEventListener('change', (e) => setting('autoCommit', e.target.checked));

  Object.assign(MLA, { roadmapUI: { get: () => rm, busy: () => busy } });
})();
