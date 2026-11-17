// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project-runs.js)
'use strict';

// 프로젝트 모드 — 큰 작업(계획 먼저 · 파일별로 받기, v0.18.0) · 이어서 받기(v0.17.1).
// v0.31.0에서 project-changes.js에서 떼어 냈다. project-changes.js 다음, project-devtest.js 앞에 읽힌다.
// 변경 바(bars · renderBar) · 수정안 계산(planChanges) · 진행 상태(runs · continuing)는 project-changes.js의 것을 P에서 꺼내 쓴다.
//
// [쉽게 말하면] 고칠 파일이 많을 때 "계획 → 파일 하나씩" 차례로 받아 모으는 일과,
// 답이 출력 한도로 끊겼을 때 같은 AI에게 나머지만 받아 이어 붙이는 일을 합니다.
(() => {
  const P = MLA.projectUI;
  const { project, allowedFor, notice, saveState } = P;
  const { writeBlocked, runs, renderBar, planChanges, bars, continuing } = P; // project-changes.js
const PC = MLA.projectContext;
const PX = MLA.patch;

  // ---------- 큰 작업: 파일별로 받기 (v0.18.0) ----------
  // 계획 답(PLAN_FILES)이 오면 바에 "파일별로 받기 시작"을 띄운다. 시작하면 "1/5: a.js만"을 보내고,
  // 그 답이 끝날 때마다(onPanelAnswerDone) 수정안을 모으고 다음 파일을 보낸다. 다 받거나 멈추면 한 묶음으로 바를 그린다.
  // 답이 시간 초과 · 답변 없음으로 끝나면 다음으로 넘어가지 않는다 — 바의 "건너뛰기"나 "멈추기"를 누른다.
  P.splitSuggested = false; // "큰 작업"을 한 번만 권한다

  /** 계획만 온 답이면 파일별로 받기를 제안한다 → 제안했으면 true */
  function offerRun(id, md) {
    const planned = PC.parsePlanFiles(md)
      .map((f) => ({ ...f, path: PX.safeRelPath(f.path) }))
      .filter((f) => f.path && !writeBlocked(f.path) && !PX.isGitInternal(f.path));
    const changes = PX.extractChanges(md);
    if (!planned.length || changes.some((c) => !c.isDelete)) return false; // 코드가 함께 왔으면 평소대로
    runs.set(id, { status: 'offer', files: planned, index: 0, changes: new Map(changes.map((c) => [c.path, c])), skip: false });
    renderBar(id);
    // 계획이 오면 바로 시작 (v0.22.0) — 사이트가 다음 질문을 받을 준비가 되도록 잠깐 둔다
    if (project.autoRun) {
      notice(t('project.split.planStart', { n: planned.length }));
      setTimeout(() => {
        const run = runs.get(id);
        if (!run || run.status !== 'offer') return; // 그사이 버렸거나 직접 시작함
        run.status = 'running';
        sendStep(id);
      }, 800);
    }
    return true;
  }

  async function sendStep(id) {
    const run = runs.get(id);
    if (!run) return;
    if (run.index >= run.files.length) return finishRun(id);
    saveState(); // 어디까지 받았는지 적어 둔다 (v0.28.0 — 앱을 다시 켜도 이어서 계속)
    const res = await host.sendFollowUp(id, PC.stepPrompt(run.files[run.index], run.index, run.files.length));
    if (!res?.ok) {
      notice(t('project.split.sendStopped', { error: res?.error || t('project.unknownError') }));
      return finishRun(id);
    }
    renderBar(id);
  }

  async function runAnswer(id, md) {
    const run = runs.get(id);
    if (run.skip) run.skip = false;
    else for (const c of PX.extractChanges(md)) run.changes.set(c.path, c); // 같은 경로는 새것 (잘렸으면 끝나고 이어서 받기)
    run.index++;
    renderBar(id);
    setTimeout(() => sendStep(id), 600); // 사이트가 다음 질문을 받을 준비가 되도록 잠깐 둔다
  }

  async function finishRun(id) {
    const run = runs.get(id);
    if (!run) return;
    runs.delete(id);
    saveState();
    const svc = state.services.find((s) => s.id === id);
    const plans = await planChanges([...run.changes.values()]);
    const got = run.files.filter((f) => run.changes.has(f.path)).length;
    bars.set(id, { ai: { id, name: svc?.name || id, color: svc?.color, plans }, applied: null, split: { got, total: run.files.length } });
    renderBar(id);
    notice(t('project.split.done', { got, total: run.files.length }));
    // 되살린 진행이면: 앱을 다시 켜기 전에 받은 파일은 이 묶음에 없다 (내용은 저장하지 않으므로)
    const missed = (run.prevGot || []).filter((p) => !run.changes.has(p));
    if (missed.length) setTimeout(() => notice(t('restore.prevGot', { files: missed.join(', ') })), 2500);
  }

  /** 제안 · 진행 중 바 */
  function renderRunBar(id) {
    const p = panels.get(id);
    const run = runs.get(id);
    if (!p || !run) return false;
    const bar = p.changeBar;
    bar.className = 'change-bar run';
    const total = run.files.length;
    const list = run.files.map((f, i) => `${i + 1}. ${f.path}${f.note ? ` — ${f.note}` : ''}`).join('\n');
    if (run.status === 'paused') {
      // 되살린 파일별로 받기 (v0.28.0): 앱을 다시 켜거나 프로젝트를 다시 열었다 — 누르면 멈춘 파일부터 이어서 보낸다
      const at = Math.min(run.index + 1, total);
      const text = span('cb-text', '');
      text.append(span('cb-count', t('restore.runBar', { at, total })), span('cb-files', ` · ${run.files[Math.min(run.index, total - 1)].path}`));
      text.title = `${list}${run.prevGot?.length ? `\n\n${t('restore.prevGot', { files: run.prevGot.join(', ') })}` : ''}`;
      const go = button(t('restore.resume'), t('restore.resumeTitle', { at, total }), () => {
        run.status = 'running';
        sendStep(id);
      });
      go.className = 'cb-apply';
      const again = button(t('restore.restart'), t('restore.restartTitle'), () => {
        run.index = 0;
        run.prevGot = [];
        run.status = 'running';
        sendStep(id);
      });
      const drop = button('✕', t('project.split.dropTitle'), () => {
        runs.delete(id);
        setChangeBar(id, false);
        saveState();
      });
      drop.className = 'cb-close';
      bar.replaceChildren(span('cb-icon', '»'), text, again, go, drop);
    } else if (run.status === 'offer') {
      const text = span('cb-text', '');
      text.append(span('cb-count', t('project.split.planCount', { n: total })), span('cb-files', ` · ${run.files.map((f) => f.path).join(', ')}`));
      text.title = t('project.split.planTitle', { list });
      const start = button(t('project.split.start'), t('project.split.startTitle', { n: total }), () => {
        run.status = 'running';
        sendStep(id);
      });
      start.className = 'cb-apply';
      const drop = button('✕', t('project.split.dropTitle'), () => {
        runs.delete(id);
        setChangeBar(id, false);
      });
      drop.className = 'cb-close';
      bar.replaceChildren(span('cb-icon', '»'), text, start, drop);
    } else {
      const cur = run.files[Math.min(run.index, total - 1)];
      const text = span('cb-text', '');
      text.append(span('cb-count', t('project.split.progress', { i: Math.min(run.index + 1, total), total })), span('cb-files', ` · ${cur.path}${run.skip ? t('project.split.skipped') : ''}`));
      text.title = `${list}\n\n${t('project.split.received', { list: [...run.changes.keys()].join(', ') || t('project.split.none') })}`;
      const skip = button(t('project.split.skip'), t('project.split.skipTitle'), () => {
        run.skip = true;
        renderBar(id);
      });
      const stop = button(t('project.split.stop'), t('project.split.stopTitle'), () => finishRun(id));
      bar.replaceChildren(span('cb-icon', '…'), text, skip, stop);
    }
    setChangeBar(id, true);
    return true;
  }

  // ---------- 이어서 받기 (v0.17.1) ----------
  // 끊긴 파일을 버리지 않고 같은 AI에게 "끊긴 곳부터 나머지만" 부탁한다 (shared/patch.js continuationOf · continuePrompt).
  // 답이 끝나면(onPanelAnswerDone) 앞부분과 겹치는지 보고 이어 붙여, 원래 답의 다른 수정안과 함께 바를 다시 그린다.

  async function continueFile(id, path, { auto = false } = {}) {
    const b = bars.get(id);
    const item = b?.ai.plans.find((x) => x.change.path === path);
    const cont = item && PX.continuationOf(item.change);
    if (!cont) return notice(t('project.cont.cannot'));
    const rounds = (b.continued?.path === path ? b.continued.rounds : 0) + 1;
    if (rounds > PX.MAX_CONTINUE) {
      const msg = t('project.cont.maxed', { path, n: PX.MAX_CONTINUE });
      return auto ? notice(msg) : alert(msg);
    }
    if (auto && continuing.has(id)) return; // 이미 이어 받는 중
    if (!allowedFor(id)) return;
    const res = await host.sendFollowUp(id, PX.continuePrompt(cont));
    if (!res?.ok) return alert(t('project.sendFailed', { error: res?.error || t('project.unknownError') }));
    continuing.set(id, { path, cont, changes: b.ai.plans.map((x) => x.change), rounds });
    saveState(); // 이어 받는 중이라는 것만 적어 둔다 (v0.28.0)
    notice(t('project.cont.asked', { ai: b.ai.name, path, i: rounds, n: PX.MAX_CONTINUE }));
  }

  async function finishContinue(id, md) {
    const st = continuing.get(id);
    continuing.delete(id);
    const svc = state.services.find((s) => s.id === id);
    const got = PX.extractChanges(md);
    const r = PX.stitchContinuation(st.cont, got.find((c) => c.path === st.path));
    // 원래 답의 수정안 목록에서 끊긴 파일을 합친 것으로 바꾸고, 이어 받은 답에 다른 파일이 더 있으면 더한다 (같은 경로는 새것)
    const byPath = new Map(st.changes.map((c) => [c.path, c]));
    if (r.change) byPath.set(st.path, r.change);
    for (const c of got) if (c.path !== st.path) byPath.set(c.path, c);
    const plans = await planChanges([...byPath.values()]);
    bars.set(id, { ai: { id, name: svc?.name || id, color: svc?.color, plans }, applied: null, continued: { path: st.path, rounds: st.rounds, error: r.error || null } });
    renderBar(id);
    notice(r.error ? t('project.cont.failed', { error: r.error }) : t('project.cont.joined', { path: st.path }) + (r.change.truncated ? t('project.cont.notYet') : ''));
  }

  Object.assign(P, { offerRun, runAnswer, finishContinue, renderRunBar, continueFile });
})();
