// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project-restore.js)
'use strict';

// 프로젝트 모드 — 작업 이어 하기 (v0.28.0): 패널마다 "AI가 이미 받은 파일" 기록 · 파일별로 받기 진행 · 이어 받기 상태를
// 프로젝트 상태에 함께 저장하고, 프로젝트를 다시 열 때(앱을 다시 켠 뒤 포함) 되살린다. 규칙 · 한도는 shared/project-session.js.
//   - 같은 실행에서 다시 열면: 그동안 새 대화를 열거나 패널을 닫지 않은 패널은 바로 되살린다
//   - 앱을 다시 켠 뒤: 패널이 새 대화로 열리므로 "기다림"으로 둔다 — 패널이 지난번 대화 주소를 다시 열면 저절로,
//     사이드바의 [이어 쓰기]를 누르면 지금 대화로 되살린다. ＋ 새 대화 · 패널 닫기면 버린다
//   - 되살린 파일별로 받기는 멈춘 상태(바에 [▶ 이어서 계속] · [처음부터])로, 변경 바는 그 패널의 지금 답변으로 다시 계산한다
// 파일 내용은 저장하지 않는다 (지문 · 경로만). project-commit.js 다음에 읽힌다.
//
// [쉽게 말하면] 앱을 껐다 켜도 "Claude에게는 이 파일들을 이미 보냈고, 파일별로 받기는 3/5까지 했다"를 기억해 이어 하게 해 주는 부분입니다.
(() => {
  const P = MLA.projectUI;
  const PS = MLA.projectSession;
  const PC = MLA.projectContext;
  const pending = new Map(); // 패널 id -> 앱을 다시 켜기 전의 기록 (이어 쓰기를 기다림)
  let restoredNow = []; // 이번에 되살린 [{ id, rec }] — 바 다시 그리기 · 안내용

  const nameOf = (id) => state?.services?.find((s) => s.id === id)?.name || id;

  /** 그 패널이 지금 연 대화 주소의 지문 (로컬 LLM · 처음 주소 · 대화 id가 없는 주소는 null) */
  function convHash(id) {
    const svc = state?.services?.find((s) => s.id === id);
    if (!svc || svc.kind === 'local') return null;
    const k = PS.convKey(panels.get(id)?.url.textContent || '', [svc.url]);
    return k ? PC.hashText(k) : null;
  }

  /** 저장할 것 (project.js saveState가 부른다) */
  function sessionState() {
    const { project } = P;
    const out = {};
    const ids = new Set([...project.sent.keys(), ...project.sentTree.keys(), ...P.runs.keys(), ...P.continuing.keys()]);
    for (const [id, b] of P.bars) if (b.continued) ids.add(id);
    for (const id of ids) {
      const epoch = P.panelEpoch(id);
      const fresh = project.sentEpoch.get(id) === epoch; // 지금 대화의 기록만
      const run = P.runs.get(id);
      const cont = P.continuing.get(id);
      const b = P.bars.get(id);
      out[id] = {
        run: P.RUN_ID,
        epoch,
        at: Date.now(),
        conv: convHash(id),
        sent: fresh ? project.sent.get(id) : null,
        tree: fresh ? project.sentTree.get(id) ?? null : null,
        plan: run ? { files: run.files, index: run.index, status: run.status, got: [...new Set([...run.changes.keys(), ...(run.prevGot || [])])] } : null,
        cont: cont ? { path: cont.path, rounds: cont.rounds, waiting: true } : b?.continued ? { path: b.continued.path, rounds: b.continued.rounds } : null,
      };
    }
    for (const [id, rec] of pending) if (!out[id]) out[id] = rec;
    return PS.packSession(out);
  }

  /** 저장된 것 되살리기 (project.js loadState가 부른다 — 파일 목록을 읽기 전이라 바는 afterRestore에서) */
  function restoreSession(saved) {
    pending.clear();
    restoredNow = [];
    const plan = PS.restorePlan(saved, { runId: P.RUN_ID, epochOf: P.panelEpoch, convOf: convHash });
    for (const [id, rec] of plan.active) adopt(id, rec);
    for (const [id, rec] of plan.pending) pending.set(id, rec);
  }

  /** 기록 하나를 지금 패널(지금 대화)의 것으로 */
  function adopt(id, rec) {
    const { project } = P;
    if (rec.sentMap.size) project.sent.set(id, new Map(rec.sentMap));
    if (rec.tree) project.sentTree.set(id, rec.tree);
    if (rec.sentMap.size || rec.tree) project.sentEpoch.set(id, P.panelEpoch(id));
    if (rec.plan && rec.plan.index < rec.plan.files.length) {
      P.runs.set(id, { status: 'paused', files: rec.plan.files, index: rec.plan.index, changes: new Map(), skip: false, prevGot: rec.plan.got });
    }
    restoredNow.push({ id, rec });
  }

  /** 파일 목록을 읽은 뒤 (project.js openProject): 되살린 패널의 바를 다시 그리고 무엇을 되살렸는지 알린다 */
  async function afterRestore() {
    const done = restoredNow;
    restoredNow = [];
    for (const { id, rec } of done) {
      if (!panels.has(id)) continue;
      if (P.runs.has(id)) {
        P.renderBar(id);
        continue;
      }
      await P.refreshBar(id).catch(() => false);
      const b = P.bars.get(id);
      if (b && rec.cont && !b.applied) {
        b.continued = { path: rec.cont.path, rounds: rec.cont.rounds, error: null }; // 이어 받은 횟수를 이어서 센다
        P.renderBar(id);
      }
    }
    if (done.length) {
      P.notice(t('restore.notice', { list: done.map(({ id, rec }) => `${nameOf(id)}(${summary(rec)})`).join(', ') }));
      const waiting = done.filter(({ rec }) => rec.cont?.waiting).map(({ rec }) => rec.cont.path);
      if (waiting.length) setTimeout(() => P.notice(t('restore.contWaiting', { files: waiting.join(', ') })), 3000);
    }
    renderPending();
  }

  /** 안내용 한 줄: 받은 파일 4개 · 파일별로 받기 3/5 · 이어 받기 a.js */
  function summary(rec) {
    const d = PS.describe(rec);
    return [
      d.sent ? t('restore.sent', { n: d.sent }) : '',
      d.plan && !d.plan.done ? t('restore.plan', { at: d.plan.at, total: d.plan.total }) : '',
      d.cont ? t('restore.cont', { path: d.cont }) : '',
    ]
      .filter(Boolean)
      .join(' · ') || t('restore.tree');
  }

  /** 사이드바의 "지난 실행의 작업" 칸: 패널마다 [이어 쓰기] · [버리기] */
  function renderPending() {
    const box = $('#psRestore');
    if (!box) return;
    if (!pending.size || !P.has()) {
      box.hidden = true;
      return box.replaceChildren();
    }
    const rows = [...pending].map(([id, rec]) => {
      const row = document.createElement('div');
      row.className = 'ps-restore-row';
      row.append(span('name', nameOf(id)), span('muted-label', summary(rec)));
      const use = button(t('restore.adopt'), t('restore.adoptTitle', { name: nameOf(id) }), async () => {
        pending.delete(id);
        adopt(id, rec);
        P.saveState();
        await afterRestore();
      });
      use.disabled = !panels.has(id);
      if (!panels.has(id)) use.title = t('restore.openPanel', { name: nameOf(id) });
      const drop = button(t('restore.drop'), t('restore.dropTitle'), () => dropPending(id));
      row.append(use, drop);
      return row;
    });
    box.replaceChildren(span('ps-restore-title', t('restore.pendingTitle')), span('muted-label ps-restore-hint', t('restore.pendingHint')), ...rows);
    box.hidden = false;
  }

  /** 새 대화 · 패널 닫기: 그 패널의 기다리던 기록은 버린다 */
  function dropPending(id) {
    if (!pending.delete(id)) return;
    P.saveState();
    renderPending();
  }

  /** 패널 주소가 바뀔 때 (renderer.js): 지난번 대화 주소를 다시 열었으면 저절로 되살린다 */
  window.onPanelUrl = (id) => {
    const rec = pending.get(id);
    if (!rec || !rec.conv || !P.has() || convHash(id) !== rec.conv) return;
    pending.delete(id);
    adopt(id, rec);
    P.saveState();
    afterRestore().then(() => P.notice(t('restore.matched', { name: nameOf(id) })));
  };

  const clearPending = () => {
    pending.clear();
    renderPending();
  };

  Object.assign(P, { sessionState, restoreSession, afterRestore, dropPending, clearPending, renderPending, pendingSession: pending });
})();
