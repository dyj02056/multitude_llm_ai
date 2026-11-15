// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project-changes.js)
'use strict';

// 프로젝트 모드 — 변경 제안 화면 · 패널 변경 바 · 큰 작업(파일별로 받기) · 이어서 받기 · 미리보기 · 적용 · 되돌리기 · 파일 모아보기.
// project.js 다음, project-editor.js 앞에 읽힌다. project.js의 것은 MLA.projectUI(P)에서 꺼내 쓴다 (v0.24.0에서 나눔).
//
// [쉽게 말하면] AI 답변에 들어 있는 코드 수정안을 골라 보고, 미리 보고, 내 파일에 쓰고, 되돌리는 화면입니다.
(() => {
  const P = MLA.projectUI;
  const { project, has, MAX_LOG, allowedFor, answerMd, listLines, notice, remember, rescan, saveState, sendProjectFollowUp } = P;
  const PI = MLA.projectIgnore;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
  const PC = MLA.projectContext;
  const PU = MLA.projectUpload;
  const PX = MLA.patch;

  // ---------- 변경 제안 ----------

  let plansByAi = []; // [{ id, name, color, plans: [{ change, plan, block }] }]

  // 지금 디스크에 있는 파일 내용 (없으면 null). 5MB까지 읽습니다.
  async function currentText(path) {
    const r = await host.project.readFile(path, { maxBytes: 5 * 1024 * 1024 });
    if (r.missing) return null;
    if (typeof r.text !== 'string') throw new Error(r.binary ? t('project.read.binary') : t('project.read.tooBig'));
    return r.text;
  }

  /** 앱 내장 제외(L1) 경로(.env, .git, node_modules 등)는 쓰지 않는다 */
  const writeBlocked = (path) => {
    const r = project.scan.matcher.classify(path, false);
    return r && r.layer === 'L1' ? t('project.changes.writeBlocked', { why: PI.describe(r) }) : null;
  };

  /** 답변 하나의 수정안을 찾고, 지금 파일에 적용하면 어떻게 되는지 미리 계산합니다. [{ change, plan }] */
  const planAnswer = (md) => planChanges(PX.extractChanges(md || ''));

  /** 수정안 목록을 지금 파일에 적용하면 어떻게 되는지 미리 계산합니다 (이어 받아 합친 수정안에도 씀). [{ change, plan }] */
  async function planChanges(changes) {
    const plans = [];
    for (const change of changes) {
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

  // 화면 이름 — 부를 때 사전에서 (OP_TEXT[op])
  const OP_TEXT = {
    get modify() {
      return t('project.op.modify');
    },
    get create() {
      return t('project.op.create');
    },
    get delete() {
      return t('project.op.delete');
    },
  };

  // ---------- 패널 변경 바 ----------
  // 프로젝트가 열려 있고 답변에 수정안이 있으면 그 패널 아래에 바를 띄운다: 바뀌는 파일 요약과 [적용] 한 번.
  // [적용]은 미리보기 창에서 기본으로 체크되는 파일(실행 영향·삭제가 아닌 것)만 바로 쓴다. 나머지는 [변경 보기]에서 골라 적용.
  // 적용하면 바가 "적용됨 · 되돌리기"로 바뀐다. 새 질문을 보내거나 새 대화를 열면 바를 내린다 (renderer.js setChangeBar).

  const sameText = () => t('project.patch.noChange'); // planChange: 이미 적용된 수정안
  const bars = new Map(); // 패널 id -> { ai: { id, name, color, plans }, applied: 적용 기록 항목 | null }

  /** 확인 없이 바로 써도 되는 수정안인지 (미리보기 창의 기본 체크와 같은 기준) */
  const isQuick = ({ plan }) => plan.ok && plan.op !== 'delete' && !plan.suspect && !PX.executionRisk(plan.path, plan.before, plan.after);

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

  // ---------- 큰 작업: 파일별로 받기 (v0.18.0) ----------
  // 계획 답(PLAN_FILES)이 오면 바에 "파일별로 받기 시작"을 띄운다. 시작하면 "1/5: a.js만"을 보내고,
  // 그 답이 끝날 때마다(onPanelAnswerDone) 수정안을 모으고 다음 파일을 보낸다. 다 받거나 멈추면 한 묶음으로 바를 그린다.
  // 답이 시간 초과 · 답변 없음으로 끝나면 다음으로 넘어가지 않는다 — 바의 "건너뛰기"나 "멈추기"를 누른다.
  const runs = new Map(); // 패널 id -> { status: 'offer' | 'running', files: [{ path, note }], index, changes: Map(경로 -> 수정안), skip }
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
  const continuing = new Map(); // 패널 id -> { path, cont, changes: 원래 답의 수정안들, rounds }

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

  /** 적용하거나 되돌린 뒤: 아직 적용하지 않은 다른 패널의 바를 지금 파일 기준으로 다시 계산한다 */
  async function refreshOtherBars(skip) {
    const skipped = (id) => (skip instanceof Set ? skip.has(id) : id === skip);
    for (const [id, b] of [...bars]) if (!skipped(id) && !b.applied) await refreshBar(id).catch(() => {});
  }

  const sumLine = (plans) => plans.map(({ plan }) => `${OP_TEXT[plan.op]} ${plan.path} +${plan.add} −${plan.del}`).join('\n');

  /** 바 그리기. 보여 줄 것이 없으면 내리고 false */
  function renderBar(id) {
    if (runs.has(id)) return renderRunBar(id); // 파일별로 받기 제안 · 진행 중 (v0.18.0)
    const p = panels.get(id);
    const b = bars.get(id);
    if (!p || !b) {
      setChangeBar(id, false);
      return false;
    }
    const bar = p.changeBar;
    const close = button('✕', t('project.bar.closeTitle'), () => {
      bars.delete(id);
      setChangeBar(id, false);
    });
    close.className = 'cb-close';

    if (b.applied) {
      const { files } = b.applied;
      const undo = button(t('project.undo'), t('project.undoTitleNew'), async () => {
        undo.disabled = true;
        await revert(b.applied);
        undo.disabled = false;
      });
      const text = span('cb-text', t('project.bar.applied', { n: files.length, list: files.map((f) => f.path).join(', ') }));
      text.title = files.map((f) => f.path).join('\n');
      bar.className = 'change-bar applied';
      // 적용 후 커밋 (v0.28.0, Windows 앱): 설정 "적용 후 커밋 제안"이 켜져 있으면 [커밋하기] — 누를 때만 커밋 창을 연다
      const extra = [];
      if (b.applied.committed) extra.push(span('cb-warn', t('commit.doneTag', { hash: b.applied.committed })));
      else if (P.canOfferCommit?.()) {
        const commit = button(t('commit.offerBtn'), t('commit.offerTitle'), () => P.openCommit(b.applied));
        commit.className = 'cb-continue';
        extra.push(commit);
      }
      bar.replaceChildren(span('cb-icon', '✓'), text, ...extra, undo, close);
      p.collectBtn.hidden = true;
      setChangeBar(id, true);
      return true;
    }

    const { ai } = b;
    const live = ai.plans.filter((x) => x.plan.ok);
    const quick = live.filter(isQuick);
    const look = live.filter((x) => !isQuick(x));
    const bad = ai.plans.filter((x) => !x.plan.ok && x.plan.error !== sameText());
    if (!live.length && !bad.length) {
      // 수정안이 없거나 이미 모두 적용된 내용
      bars.delete(id);
      setChangeBar(id, false);
      return false;
    }
    const add = live.reduce((n, x) => n + x.plan.add, 0);
    const del = live.reduce((n, x) => n + x.plan.del, 0);
    const text = span('cb-text', '');
    text.append(span('cb-count', live.length ? t('project.bar.changed', { n: live.length }) : t('project.bar.nothing')));
    if (live.length) text.append(span('add', ` +${add}`), span('del', ` −${del}`), span('cb-files', ` · ${live.map((x) => x.plan.path).join(', ')}`));
    text.title = [
      sumLine(live),
      look.length ? `\n${t('project.bar.lookHead')}\n${sumLine(look)}${look.filter((x) => x.plan.suspect).map((x) => `\n  ${x.plan.path}: ${x.plan.suspect}`).join('')}` : '',
      bad.length ? `\n${t('project.bar.badHead')}\n${bad.map(({ plan }) => `${plan.path}: ${plan.error}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const notes = [];
    if (look.length) notes.push(span('cb-warn', t('project.bar.lookCount', { n: look.length })));
    const cut = bad.filter(({ plan }) => plan.truncated);
    if (cut.length) notes.push(span('cb-bad', t('project.bar.cutCount', { n: cut.length }))); // 출력 한도로 끊긴 파일 (v0.16.1) — 적용하지 않음
    if (bad.length > cut.length) notes.push(span('cb-bad', t('project.bar.badCount', { n: bad.length - cut.length })));
    if (b.split) notes.push(span('cb-warn', t('project.bar.splitCount', { got: b.split.got, total: b.split.total })));
    if (b.continued) notes.push(span(b.continued.error ? 'cb-bad' : 'cb-warn', b.continued.error ? t('project.bar.contFailed') : t('project.bar.contCount', { n: b.continued.rounds })));

    const collect = button('collect', t('project.bar.collectTitle', { ai: ai.name }), () => window.onCollectClick(id));
    const view = live.length
      ? button(t('project.bar.view'), t('project.bar.viewTitle'), () => openPreview(ai))
      : button(t('project.bar.viewChanges'), t('project.bar.viewChangesTitle'), () => host.setView('changes'));
    const btns = [collect, view];
    // 이어서 받기 (v0.17.1): 잘렸거나 끝이 잘린 것 같은 파일 — 같은 AI에게 끊긴 곳부터 나머지만 받아 이어 붙인다
    const contTarget = [...ai.plans].reverse().find(PX.wantsContinue);
    // 자동으로 이어 받기 (v0.22.0): 같은 파일 · 같은 횟수에 한 번만 (바를 다시 그려도 또 보내지 않게), 이어 붙이기에 실패했으면 멈춘다
    if (contTarget && project.autoContinue && !b.continued?.error && PX.autoContinueKey) {
      const key = PX.autoContinueKey(contTarget.change.path, b.continued);
      if (b.autoKey !== key) {
        b.autoKey = key;
        setTimeout(() => bars.get(id) === b && continueFile(id, contTarget.change.path, { auto: true }), 600);
      }
    }
    if (contTarget) {
      const cont = button(t('project.bar.continue'), t('project.bar.continueTitle', { path: contTarget.plan.path, ai: ai.name }), () => continueFile(id, contTarget.change.path));
      cont.className = 'cb-continue';
      btns.unshift(cont);
    }
    if (live.length) {
      const apply = button(
        quick.length ? t('project.bar.applyN', { n: quick.length }) : t('project.bar.applyPick'),
        quick.length
          ? `${t('project.bar.quickHead')}\n${sumLine(quick)}${look.length ? `\n\n${t('project.bar.quickSkip', { n: look.length })}` : ''}\n\n${t('project.bar.quickUndo')}`
          : t('project.bar.onlyLook'),
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
    btn.textContent = t('project.bar.applying');
    try {
      await applyPlans(b.ai, b.ai.plans.filter(isQuick).map((x) => x.plan));
    } finally {
      if (bars.get(id) === b && !b.applied) renderBar(id); // 하나도 쓰지 못했으면 바를 원래대로
    }
  }

  window.renderChanges = async () => {
    const cols = $('#changesCols');
    $('#changesLog').textContent = t('project.log.button', { n: project.log.filter((l) => !l.reverted).length });
    $('#changesMix').disabled = true;
    if (!has()) {
      $('#changesInfo').textContent = '';
      cols.style.gridTemplateColumns = '1fr';
      return cols.replaceChildren(span('change-empty', t('project.changes.noProject')));
    }
    $('#changesInfo').textContent = t('project.changes.info', { name: project.info.name });
    cols.replaceChildren(span('change-empty', t('project.changes.reading')));
    plansByAi = await planAll();
    $('#changesMix').disabled = !MLA.mixSelect.canMix(plansByAi); // 섞어서 적용 (v0.28.0): 수정안이 있는 AI가 둘 이상일 때
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
    head.append(span('dot ready'), span('name', ai.name), span('muted-label', ai.plans.length ? t('project.changes.count', { n: ai.plans.length, add, del }) : t('project.changes.none')));
    const list = document.createElement('div');
    list.className = 'change-list';
    if (!ai.plans.length) list.append(span('change-empty', t('project.changes.emptyAnswer')));
    for (const { change, plan } of ai.plans) {
      const row = document.createElement('div');
      row.className = 'change-row';
      const same = !plan.ok && plan.error === sameText(); // 이미 적용한 수정안
      row.append(span(`op ${plan.ok ? plan.op : same ? 'same' : 'bad'}`, plan.ok ? OP_TEXT[plan.op] : same ? t('project.changes.applied') : t('project.changes.cannot')), span('path', plan.path));
      const risk = plan.ok && PX.executionRisk(plan.path, plan.before, plan.after);
      if (risk) {
        const tag = span('op bad', t('project.changes.risk'));
        tag.title = t('project.changes.notChecked', { why: risk });
        row.append(tag);
      }
      if (plan.ok && plan.suspect) {
        const tag = span('op bad', t('project.changes.suspect'));
        tag.title = t('project.changes.notChecked', { why: plan.suspect });
        row.append(tag);
      }
      if (plan.ok) row.append(span('add', `+${plan.add}`), span('del', `−${plan.del}`));
      else {
        const err = span('err', plan.error);
        row.title = plan.error;
        row.append(err);
        if ((change.type === 'diff' || change.type === 'edit' || plan.truncated) && !change.isNew && !change.isDelete && !writeBlocked(change.path)) {
          row.append(button(t('project.changes.refetch'), t('project.changes.refetchTitle'), () => refetch(ai, change.path)));
        }
      }
      list.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'change-foot';
    const applyBtn = button(t('project.changes.preview'), t('project.changes.previewTitle', { ai: ai.name }), () => openPreview(ai));
    applyBtn.disabled = !ok.length;
    const collectBtn = button(t('project.collect.button'), t('project.collect.buttonTitle', { ai: ai.name }), () => window.onCollectClick(ai.id));
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
      if (rule?.layer === 'L1') return alert(t('project.refetch.blocked', { path, why: PI.describe(rule) }));
      if (rule && !confirm(t('project.refetch.excluded', { path, why: PI.describe(rule), ai: ai.name }))) return;
      const text = await currentText(path);
      if (text === null) return alert(t('project.editor.noFile'));
      const hits = scanSecrets(text);
      if (hits.length && !confirm(t('project.refetch.secret', { path, list: describeSecrets(hits), ai: ai.name }))) return;
      const truncated = ai.plans.some((x) => x.plan.path === path && x.plan.truncated);
      const res = await sendProjectFollowUp(ai.id, PU.packRefetch({ path, text, mode: project.uploadMode, reason: truncated ? 'truncated' : 'diff' }));
      if (!res?.ok) return alert(t('project.sendFailed', { error: res?.error }));
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
      $('#patchTest').onclick = null;
      $('#patchTest').hidden = true;
      $('#patchChecks').hidden = true;
      $('#patchTestOut').hidden = true;
      $('#patchTestOut').replaceChildren();
      if (testRunning) host.devtest?.stop(); // 창을 닫으면 실행 중인 테스트도 멈춘다 (파일은 메인이 되돌린다)
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

  // 아주 긴 diff는 줄마다 칸을 만들면 창이 느려지므로 처음 DIFF_CHUNK줄만 그리고, 나머지는 "더 보기"로 이어 붙인다.
  const DIFF_CHUNK = 2000;
  function appendDiffLines(pre, lines, cls) {
    let shown = 0;
    let more = null;
    const next = () => {
      const end = Math.min(lines.length, shown + DIFF_CHUNK);
      const frag = document.createDocumentFragment();
      for (; shown < end; shown++) frag.append(span(cls(lines[shown]), lines[shown] || ' '));
      if (more) more.remove();
      pre.append(frag);
      if (shown < lines.length) {
        more = document.createElement('button');
        more.type = 'button';
        more.className = 'diff-more';
        more.textContent = t('project.preview.more', { n: lines.length - shown });
        more.addEventListener('click', (e) => {
          e.preventDefault(); // 체크 상자가 있는 label 안에 있어도 체크가 바뀌지 않게
          next();
        });
        pre.append(more);
      } else more = null;
    };
    next();
  }

  // 바뀐 줄 보기: 추가된 줄은 초록, 지운 줄은 빨강으로 칠합니다.
  function diffPre(text) {
    const pre = document.createElement('pre');
    const lines = text.split('\n').filter((line) => !line.startsWith('---') && !line.startsWith('+++'));
    appendDiffLines(pre, lines, (line) => (line.startsWith('+') ? 'a' : line.startsWith('-') ? 'd' : line.startsWith('@@') ? 'h' : ''));
    return pre;
  }

  /** 덩어리 하나: 머리줄(@@ …)과 바뀐 줄 */
  function hunkPre(h) {
    const pre = document.createElement('pre');
    pre.append(span('h', `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
    appendDiffLines(pre, h.lines, (line) => (line.startsWith('+') ? 'a' : line.startsWith('-') ? 'd' : ''));
    return pre;
  }

  let testRunning = false;

  /**
   * 미리보기·적용 창: 파일마다 바뀌는 줄을 보여 주고, 체크한 파일만 씁니다. 실행에 영향을 주는 파일과 삭제는 기본으로 체크하지 않습니다.
   * 수정하는 파일에 바뀐 곳(덩어리)이 둘 이상이면 덩어리마다 체크 상자가 붙어 골라 적용할 수 있습니다 (v0.12.0).
   * Windows 앱에는 "테스트 실행"이 있습니다: 적용 전 · 체크한 수정안을 잠깐 쓴 후 npm test를 돌려 결과를 나란히 보여 줍니다.
   */
  function openPreview(ai) {
    const ok = ai.plans.filter((x) => x.plan.ok);
    modal.show(t('project.preview.title', { ai: ai.name }), t('project.preview.note', { name: project.info.name }));
    const items = []; // { box, plan, hunks: [{ index, box }] | null }
    $('#patchBody').replaceChildren(
      ...ok.map(({ plan }) => {
        const pf = document.createElement('div');
        pf.className = 'pf';
        const head = document.createElement('label');
        head.className = 'pf-head';
        // 저장만 해도 나중에 실행될 수 있는 파일(실행 영향)과 삭제는 기본으로 체크하지 않는다.
        const risk = PX.executionRisk(plan.path, plan.before, plan.after);
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !risk && !plan.suspect && plan.op !== 'delete' });
        const item = { box, plan, hunks: null };
        items.push(item);
        head.append(box, span(`op ${plan.op}`, OP_TEXT[plan.op]), span('path', plan.path));
        if (risk) {
          const tag = span('op bad', t('project.preview.risk', { why: risk }));
          tag.title = t('project.preview.riskTitle');
          head.append(tag);
        }
        if (plan.suspect) {
          // 답이 잘렸거나 AI가 코드를 줄였을 수 있다 — 그대로 쓰면 그 부분이 지워진다 (v0.16.1)
          const tag = span('op bad', `⚠ ${plan.suspect}`);
          tag.title = t('project.preview.suspectTitle');
          head.append(tag);
        }
        if (plan.op === 'delete') head.append(span('op delete', t('project.preview.delete')));
        const hunks = plan.op === 'modify' && typeof plan.before === 'string' && typeof plan.after === 'string' ? PX.splitHunks(plan.before, plan.after) : [];
        if (hunks.length > 1) head.append(span('op hunks', t('project.preview.hunks', { n: hunks.length })));
        head.append(span('add', `+${plan.add}`), span('del', `−${plan.del}`));
        pf.append(head);
        if (hunks.length > 1) {
          item.hunks = hunks.map((h) => {
            const row = document.createElement('div');
            row.className = 'pf-hunk';
            const hl = document.createElement('label');
            hl.className = 'pf-hunk-head';
            const hb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: box.checked });
            hl.append(hb, span('muted-label', t('project.preview.hunkAt', { i: h.index + 1, line: h.oldStart })));
            row.append(hl, hunkPre(h));
            pf.append(row);
            // 덩어리를 하나라도 고르면 파일도 체크, 모두 빼면 파일도 해제
            hb.addEventListener('change', () => {
              box.checked = item.hunks.some((x) => x.box.checked);
              box.indeterminate = box.checked && !item.hunks.every((x) => x.box.checked);
            });
            return { index: h.index, box: hb };
          });
          // 파일 체크 상자는 덩어리 전체를 켜고 끈다
          box.addEventListener('change', () => {
            box.indeterminate = false;
            for (const x of item.hunks) x.box.checked = box.checked;
          });
        } else pf.append(diffPre(plan.preview));
        return pf;
      }),
    );

    /** 체크한 파일 → 적용할 plan 목록 (덩어리 일부만 고른 파일은 그 덩어리만 반영한 after) */
    const chosenPlans = () =>
      items
        .filter((it) => it.box.checked)
        .map((it) => {
          if (!it.hunks || it.hunks.every((x) => x.box.checked)) return it.plan;
          const picked = it.hunks.filter((x) => x.box.checked).map((x) => x.index);
          return { ...it.plan, after: PX.applyHunks(it.plan.before, it.plan.after, picked), partial: picked.length, src: it.plan };
        });

    $('#patchApply').hidden = false;
    $('#patchAll').hidden = false;
    $('#patchAll').onclick = () =>
      items.forEach((it) => {
        it.box.checked = true;
        it.box.indeterminate = false;
        it.hunks?.forEach((x) => (x.box.checked = true));
      });
    $('#patchApply').textContent = t('project.preview.applyChosen');
    $('#patchApply').focus(); // Enter(또는 Ctrl+Enter)로 바로 적용
    $('#patchApply').onclick = async () => {
      if (testRunning) return ($('#patchStatus').textContent = t('project.preview.waitTest'));
      const chosen = chosenPlans();
      if (!chosen.length) return ($('#patchStatus').textContent = t('project.preview.pickApply'));
      $('#patchApply').disabled = true;
      try {
        const { entry, text } = await applyPlans(ai, chosen);
        afterApplied(entry, text);
      } finally {
        $('#patchApply').disabled = false;
      }
    };

    // 테스트 실행 (Windows 앱 전용: host.devtest) — v0.28.0: lint · typecheck · build도 골라서
    setupTestRun(chosenPlans);
  }

  // ---------- 검사 실행 (test · lint · typecheck · build, Windows 앱) ----------

  let testChecks = null; // 지난번 고른 검사 이름 (창을 다시 열어도 유지, 처음은 test만)

  /** 창 아래 검사 체크 칸: package.json에 있는 스크립트만 보인다. 고른 이름을 돌려주는 함수를 돌려준다 */
  function renderCheckBoxes(info) {
    const box = $('#patchChecks');
    const checks = info?.ok && Array.isArray(info.checks) ? info.checks : [];
    if (!testChecks) testChecks = new Set(checks.some((c) => c.name === 'test') ? ['test'] : checks.slice(0, 1).map((c) => c.name));
    box.replaceChildren(
      ...checks.map((c) => {
        const l = document.createElement('label');
        l.className = 'check-label patch-check';
        l.title = [c.pre && `pre${c.name}: ${c.pre}`, `${c.name}: ${c.script}`, c.post && `post${c.name}: ${c.post}`].filter(Boolean).join('\n');
        const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: testChecks.has(c.name) });
        cb.dataset.check = c.name;
        cb.addEventListener('change', () => (cb.checked ? testChecks.add(c.name) : testChecks.delete(c.name)));
        l.append(cb, span('', c.name));
        return l;
      }),
    );
    box.hidden = checks.length < 2; // test 하나뿐이면 예전처럼 체크 칸 없이
    return () => checks.map((c) => c.name).filter((n) => testChecks.has(n));
  }

  /** 창의 [테스트 실행]: 체크한 수정안을 잠깐 쓰고 고른 검사를 적용 전 · 후로 돌려 나란히 보여 준다. getChosen() → 적용할 plan 목록 */
  function setupTestRun(getChosen) {
    if (!host.devtest) return;
    const btn = $('#patchTest');
    btn.hidden = false;
    btn.textContent = t('devtest.run');
    let picked = () => ['test'];
    host.devtest.info().then((info) => {
      if ($('#patchModal').hidden || btn.hidden) return;
      picked = renderCheckBoxes(info);
    }).catch(() => {});
    btn.onclick = async () => {
      if (testRunning) {
        btn.disabled = true;
        await host.devtest.stop();
        return;
      }
      const chosen = getChosen();
      if (!chosen.length) return ($('#patchStatus').textContent = t('project.test.pick'));
      const scripts = picked();
      if (!scripts.length) return ($('#patchStatus').textContent = t('devtest.pickScript'));
      testRunning = true;
      btn.textContent = t('project.test.stop');
      $('#patchApply').disabled = true;
      const out = $('#patchTestOut');
      out.hidden = false;
      out.replaceChildren(span('muted-label', t('devtest.running', { names: scripts.join(' · ') })));
      try {
        const r = await host.devtest.trial(chosen.map((p) => ({ path: p.path, after: p.op === 'delete' ? null : p.after })), scripts);
        renderTestResult(out, r);
      } catch (err) {
        renderTestResult(out, { ok: false, error: err.message });
      } finally {
        testRunning = false;
        btn.disabled = false;
        btn.textContent = t('project.test.rerun');
        $('#patchApply').disabled = false;
      }
    };
  }

  /**
   * 창에서 적용한 뒤: 커밋 제안이 켜져 있으면(Windows 앱 · git) 창을 닫지 않고 [커밋하기…]를 보여 준다 (v0.28.0).
   * 아니면 예전처럼 잠깐 뒤 닫는다. 커밋은 누를 때만 한다.
   */
  function afterApplied(entry, text) {
    $('#patchStatus').textContent = text;
    if (entry && P.canOfferCommit?.()) {
      $('#patchStatus').textContent = `${text} — ${t('commit.offerNote')}`;
      $('#patchAll').hidden = true;
      $('#patchTest').hidden = true;
      $('#patchChecks').hidden = true;
      $('#patchApply').textContent = t('commit.offerBtn');
      $('#patchApply').onclick = () => P.openCommit(entry);
      return;
    }
    setTimeout(() => {
      modal.hide();
      if (state?.chatView === 'changes') window.renderChanges();
    }, 900);
  }

  const fmtMs = (ms) => (ms >= 60000 ? t('project.test.minSec', { m: Math.floor(ms / 60000), s: Math.round((ms % 60000) / 1000) }) : t('project.test.sec', { s: (ms / 1000).toFixed(1) }));

  /**
   * 검사 결과: 스크립트마다 한 줄 머리(이름 · 판정)와 적용 전 | 적용 후를 나란히 (상태 · 통과/실패 수 · 걸린 시간 · 출력).
   * v0.28.0: r.results에 고른 스크립트(test · lint · typecheck · build)가 차례로 온다. 예전 모양(r.before · r.after)도 받는다.
   */
  function renderTestResult(box, r) {
    if (!r?.ok) {
      box.replaceChildren(span(r?.cancelled ? 'muted-label' : 'test-err', r?.error || t('project.test.failedToRun')));
      return;
    }
    const col = (title, x) => {
      const c = document.createElement('div');
      c.className = 'test-col';
      const head = document.createElement('div');
      head.className = 'test-col-head';
      head.append(span('', title));
      if (!x) {
        head.append(span('test-badge skip', t('project.test.notRun')));
        c.append(head);
        return c;
      }
      const [cls, label] = x.stopped
        ? ['skip', t('project.test.stopped')]
        : x.timedOut
          ? ['bad', t('project.test.timeout')]
          : x.error
            ? ['bad', t('project.test.runError')]
            : x.ok
              ? ['good', t('project.test.pass')]
              : ['bad', t('project.test.fail', { code: x.code })];
      head.append(span(`test-badge ${cls}`, label));
      if (x.summary) head.append(span('muted-label', t('project.test.summary', { pass: x.summary.pass, fail: x.summary.fail })));
      if (x.ms) head.append(span('muted-label', fmtMs(x.ms)));
      c.append(head);
      if (x.error) c.append(span('test-err', x.error));
      const pre = document.createElement('pre');
      pre.className = 'test-output';
      pre.textContent = x.output || t('project.test.noOutput');
      c.append(pre);
      requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight)); // 요약이 있는 끝부분부터 보이게
      return c;
    };
    const verdictOf = (x) =>
      x.before?.ok && x.after && !x.after.ok
        ? ['bad', t('devtest.verdictBreaks', { name: x.name })]
        : !x.before?.ok && x.after?.ok
          ? ['good', t('devtest.verdictFixes', { name: x.name })]
          : x.after?.ok
            ? ['good', t('devtest.verdictPasses', { name: x.name })]
            : ['skip', t('devtest.verdictNeither', { name: x.name })];
    const results = Array.isArray(r.results) && r.results.length ? r.results : [{ name: 'test', script: r.script, before: r.before, after: r.after }];
    const head = document.createElement('div');
    head.className = 'test-head';
    const bad = results.filter((x) => verdictOf(x)[0] === 'bad').length;
    head.append(
      span('muted-label', results.map((x) => x.name).join(' · ')),
      span(`test-badge ${bad ? 'bad' : results.every((x) => x.after?.ok) ? 'good' : 'skip'}`, bad ? t('devtest.sumBad', { n: bad }) : t('devtest.sumOk', { n: results.length })),
      span('muted-label', t('project.test.restored')),
    );
    const restoreFailed = r.restoreFailed || r.after?.restoreFailed;
    const blocks = results.map((x) => {
      const b = document.createElement('div');
      b.className = 'test-script';
      const h = document.createElement('div');
      h.className = 'test-script-head';
      const v = verdictOf(x);
      h.append(span('test-name', x.name === 'test' ? 'npm test' : `npm run ${x.name}`), span('muted-label', x.script ? `(${x.script})` : ''), span(`test-badge ${v[0]}`, v[1]));
      const cols = document.createElement('div');
      cols.className = 'test-cols';
      cols.append(col(t('project.test.before'), x.before), col(t('project.test.after'), x.after));
      b.append(h, cols);
      return b;
    });
    box.replaceChildren(head, ...(restoreFailed?.length ? [span('test-err', t('project.test.restoreFailed', { list: restoreFailed.join(', ') }))] : []), ...blocks);
  }

  /**
   * 적용: 쓰기 직전에 파일이 바뀌었으면 다시 계산한다. 원본은 적용 기록에 남긴다. { entry(적용 기록 항목, 못 썼으면 null), text }
   * 여러 파일은 한 묶음(트랜잭션)으로 쓴다 (v0.23.0): 쓰기 · 지우기가 하나라도 실패하면 이 묶음에서 이미 쓴 파일을
   * 원래대로 되돌린다 (되돌리기와 같은 원본 — 고친 파일은 원래 내용, 지운 파일은 다시 만들고, 새로 만든 파일은 지움).
   * 그사이 파일이 바뀌어 다시 계산할 수 없는 파일은 예전처럼 그 파일만 빼고 쓴다.
   * 섞어서 적용 (v0.28.0): ai는 { id: null, name: 'Claude + ChatGPT', mixed: true }, sources는 Map(plan → 그 수정안을 낸 AI).
   * 한 묶음으로 쓰고(실패하면 모두 되돌림), 적용 기록은 하나, "이 AI가 안다"는 기록은 파일마다 낸 AI에게만 남긴다.
   */
  async function applyPlans(ai, plans, { sources = null } = {}) {
    const ownerOf = (plan) => sources?.get(plan.src || plan) || ai;
    const failed = [];
    const ready = [];
    for (const plan of plans) {
      try {
        let p = plan;
        const now = await currentText(plan.path);
        if (now !== plan.before) {
          // 덩어리 일부만 고른 파일은 다시 계산하면 고른 것이 사라지므로 적용하지 않는다
          if (plan.partial) throw new Error(t('project.apply.changedPartial'));
          const change = ownerOf(plan).plans.find((x) => x.plan === (plan.src || plan)).change;
          p = PX.planChange(change, now);
          if (!p.ok) throw new Error(t('project.apply.changed', { error: p.error }));
        }
        ready.push({ path: p.path, op: p.op === 'delete' ? 'delete' : 'write', before: p.before, after: p.after, owner: ownerOf(plan) });
      } catch (err) {
        failed.push(`${plan.path}: ${err.message}`);
      }
    }
    const tx = await PC.applyTransaction(ready, {
      read: (path) => currentText(path),
      write: (path, text) => host.project.writeFile(path, text),
      remove: (path) => host.project.deleteFile(path),
    });
    if (!tx.ok) {
      // 묶음이 실패했다: 쓴 파일은 되돌렸으므로 적용 기록 · 바는 그대로 두고 알린다
      if (tx.restored.length || tx.restoreFailed.length) await rescan().catch(() => {});
      const msg = PC.transactionMessage(tx);
      alert(failed.length ? `${msg}\n\n${t('project.apply.failedList', { list: failed.join('\n') })}` : msg);
      return { entry: null, text: t('project.apply.notApplied', { what: t(tx.failed.op === 'delete' ? 'project.tx.deleteFailed' : 'project.tx.writeFailed', { path: tx.failed.path }) }) };
    }
    const ownerByPath = new Map(ready.map((r) => [r.path, r.owner]));
    const done = tx.done.map(({ owner, ...f }) => f); // 적용 기록에는 AI 객체를 넣지 않는다
    let entry = null;
    if (done.length) {
      // 수정안을 낸 AI는 적용한 결과를 이미 안다 (섞었으면 파일마다 낸 AI만). 다른 AI에게는 ⟳ 뒤 "바뀐 파일"로 보인다.
      const owners = [];
      for (const f of done) {
        const o = ownerByPath.get(f.path) || ai;
        let s = owners.find((x) => x.ai === o);
        if (!s) owners.push((s = { ai: o, paths: [] }));
        s.paths.push(f.path);
      }
      for (const s of owners) if (s.ai.id) remember(s.ai.id, done.filter((f) => s.paths.includes(f.path)).map((f) => ({ path: f.path, text: f.after })));
      // sources: 커밋 메시지 · 요약 부탁에 쓰는 출처 (v0.28.0) — 이름 · 패널 id · 경로만
      const srcs = owners.map((s) => ({ id: s.ai.id || null, name: s.ai.name, paths: s.paths }));
      entry = { id: `${Date.now().toString(36)}`, at: Date.now(), ai: ai.name, files: done, reverted: false, sources: srcs };
      project.log.unshift(entry);
      project.log.length = Math.min(project.log.length, MAX_LOG);
      for (const f of done) {
        if (f.after === null) project.touched.delete(f.path);
        else if (!project.touched.has(f.path)) project.touched.set(f.path, f.before === null ? 'A' : 'M');
      }
      saveState();
      // 그 AI의 패널 바는 "적용됨 · 되돌리기"로 (변경 제안 화면에서 적용했어도 패널로 돌아가면 보인다). 섞었으면 낸 AI마다
      for (const s of owners) {
        if (!s.ai.id || !panels.has(s.ai.id)) continue;
        bars.set(s.ai.id, { ai: s.ai, applied: entry });
        renderBar(s.ai.id);
      }
      await rescan();
      await refreshOtherBars(new Set(owners.map((s) => s.ai.id)));
    }
    if (failed.length) alert(t('project.apply.failedList', { list: failed.join('\n') }));
    return { entry, text: t('project.apply.done', { n: done.length }) + (failed.length ? t('project.apply.someFailed', { n: failed.length }) : '') };
  }

  // ---------- 파일 모아보기 ----------
  // 답변에서 찾은 파일 수정안을 "경로 + 전체 코드"로 모아, 직접 복사해 붙여 넣기 좋게 보여 준다. 파일은 쓰지 않는다.
  // 프로젝트를 열지 않아도 쓴다. 그때는 새 파일·수정을 구분하지 못하고, diff는 전체 코드로 바꾸지 못해 diff 그대로 보여 준다.

  // 화면 이름 — 부를 때 사전에서. 순서가 모아보기 요약 순서다.
  const COLLECT_OP = Object.fromEntries(['create', 'modify', 'full', 'diff', 'edit', 'same', 'delete'].map((op) => [op, null]));
  for (const op of Object.keys(COLLECT_OP)) Object.defineProperty(COLLECT_OP, op, { get: () => t(`project.collect.op.${op}`), enumerable: true });

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
        // 잘린 답변이면 코드는 보여 주되 뒷부분이 없다고 알린다 (그대로 붙여 넣으면 나머지가 사라짐)
        const note = change.truncated ? t('project.collect.truncatedFull') : undefined;
        items.push({ path, op: before === undefined ? 'full' : before === null ? 'create' : same ? 'same' : 'modify', code: change.content, note });
        continue;
      }
      let note = t('project.collect.openForFull');
      if (before !== undefined || change.isNew) {
        const plan = PX.planChange(change, before ?? null);
        if (plan.ok) {
          items.push({ path, op: plan.op, code: plan.after.replace(/\r\n/g, '\n') });
          continue;
        }
        note = t('project.collect.mergeFailed', { error: plan.error });
      }
      if (change.type === 'edit') {
        // 찾기/바꾸기 블록 (v0.17.0): 프로젝트가 없으면 전체 코드로 합칠 수 없어 블록 그대로 보여 준다
        const code = change.edits.map((e) => `<<<<<<< 찾기\n${e.search}\n=======\n${e.replace}\n>>>>>>> 바꾸기`).join('\n\n');
        items.push({ path, op: 'edit', code, note: change.truncated ? t('project.collect.truncatedEdit') : note });
        continue;
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
    p.collectBtn.textContent = t('project.collect.count', { n: changes.length });
    p.collectBtn.title = t('project.collect.countTitle', { list: listLines(changes, (c) => `- ${c.path}`) });
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
    btn.textContent = t('project.collect.copied');
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
      t('project.collect.title', { name, n: items.length }),
      t('project.collect.note', { counts, base: has() ? t('project.collect.base', { name: project.info.name }) : t('project.collect.noBase') }),
    );
    $('#patchBody').replaceChildren(
      ...(items.length
        ? items.map((it) => {
            const pf = document.createElement('div');
            pf.className = 'pf collect';
            const head = document.createElement('div');
            head.className = 'pf-head';
            const tag = span(`op ${it.op}`, COLLECT_OP[it.op]);
            if (it.op === 'full') tag.title = t('project.collect.fullTitle');
            head.append(tag, span('path', it.path));
            if (it.note) head.append(span('muted-label', it.note));
            const pathBtn = button(t('project.collect.copyPath'), t('project.collect.copyPathTitle'), () => copyWithFeedback(pathBtn, it.path, t('project.collect.copyPath')));
            head.append(pathBtn);
            if (it.op !== 'delete') {
              const codeBtn = button(t('project.collect.copyCode'), t('project.collect.copyCodeTitle'), () => copyWithFeedback(codeBtn, it.code, t('project.collect.copyCode')));
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
            } else pf.append(span('muted-label collect-del', t('project.collect.deleteReq')));
            return pf;
          })
        : [span('change-empty', t('project.collect.empty'))]),
    );
    $('#patchAll').hidden = true;
    $('#patchApply').hidden = !items.length;
    $('#patchApply').textContent = t('project.collect.copyAll');
    $('#patchApply').onclick = async () => {
      await host.copyText(collectMarkdown(items));
      $('#patchStatus').textContent = t('project.collect.copiedAll', { n: items.length });
    };
  };

  const fmtAt = (ms) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  $('#changesLog').addEventListener('click', () => {
    modal.show(t('project.log.title'), t('project.log.note'));
    $('#patchApply').hidden = true;
    $('#patchAll').hidden = true;
    const rows = project.log.map((entry) => {
      const row = document.createElement('div');
      row.className = `log-row${entry.reverted ? ' reverted' : ''}`;
      // '직접 편집'은 적용 기록에 저장된 표시 (project-editor.js) — 화면에는 지금 언어로
      row.append(span('', fmtAt(entry.at)), span('name', entry.ai === '직접 편집' ? t('project.log.manualEdit') : entry.ai), span('files', entry.files.map((f) => f.path).join(', ')));
      const undo = button(entry.reverted ? t('project.log.reverted') : t('project.undo'), t('project.undoTitle'), async () => {
        await revert(entry);
        $('#changesLog').click();
      });
      undo.disabled = entry.reverted || !has();
      row.append(undo);
      return row;
    });
    $('#patchBody').replaceChildren(...(rows.length ? rows : [span('change-empty', t('project.log.empty'))]));
  });

  // 적용 기록 하나를 되돌립니다: 적용 전 내용으로 다시 쓰고, 새로 만든 파일은 지웁니다. 그사이 또 바뀐 파일은 먼저 묻습니다.
  async function revert(entry) {
    const changed = [];
    for (const f of entry.files) {
      const now = await currentText(f.path).catch(() => undefined);
      if (now !== f.after) changed.push(f.path);
    }
    if (changed.length && !confirm(t('project.log.changedSince', { list: changed.join('\n') }))) return;
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
    if (failed.length) alert(t('project.log.revertFailed', { list: failed.join('\n') }));
  }

  Object.assign(P, {
    clearBars, continuing, currentText, finishContinue, offerRun, refreshBar, runAnswer, runs, showCollectBtn, writeBlocked, revert, modal,
    // v0.28.0: 섞어서 적용(project-mix.js) · 커밋(project-commit.js) · 이어 하기(project-restore.js)가 쓴다
    applyPlans, afterApplied, isQuick, bars, renderBar, setupTestRun, diffPre, OP_TEXT, plansByAi: () => plansByAi,
  });
})();
