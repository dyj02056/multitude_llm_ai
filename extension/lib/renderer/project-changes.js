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
    if (typeof r.text !== 'string') throw new Error(r.binary ? '바이너리 파일' : '파일이 너무 큽니다');
    return r.text;
  }

  /** 앱 내장 제외(L1) 경로(.env, .git, node_modules 등)는 쓰지 않는다 */
  const writeBlocked = (path) => {
    const r = project.scan.matcher.classify(path, false);
    return r && r.layer === 'L1' ? `앱 내장 제외 경로라 쓰지 않습니다 (${PI.describe(r)})` : null;
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

  const OP_TEXT = { modify: '수정', create: '새 파일', delete: '삭제' };

  // ---------- 패널 변경 바 ----------
  // 프로젝트가 열려 있고 답변에 수정안이 있으면 그 패널 아래에 바를 띄운다: 바뀌는 파일 요약과 [적용] 한 번.
  // [적용]은 미리보기 창에서 기본으로 체크되는 파일(실행 영향·삭제가 아닌 것)만 바로 쓴다. 나머지는 [변경 보기]에서 골라 적용.
  // 적용하면 바가 "적용됨 · 되돌리기"로 바뀐다. 새 질문을 보내거나 새 대화를 열면 바를 내린다 (renderer.js setChangeBar).

  const SAME_TEXT = '바뀌는 내용이 없습니다'; // planChange: 이미 적용된 수정안
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
      notice(`계획: 파일 ${planned.length}개 — 바로 한 파일씩 받기 시작합니다`);
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
    const res = await host.sendFollowUp(id, PC.stepPrompt(run.files[run.index], run.index, run.files.length));
    if (!res?.ok) {
      notice(`보내지 못해 파일별로 받기를 멈춥니다: ${res?.error || '알 수 없는 오류'}`);
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
    const svc = state.services.find((s) => s.id === id);
    const plans = await planChanges([...run.changes.values()]);
    const got = run.files.filter((f) => run.changes.has(f.path)).length;
    bars.set(id, { ai: { id, name: svc?.name || id, color: svc?.color, plans }, applied: null, split: { got, total: run.files.length } });
    renderBar(id);
    notice(`파일별로 받기 끝: ${got}/${run.files.length}개 받음 — 바에서 미리 보고 적용하세요`);
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
    if (run.status === 'offer') {
      const text = span('cb-text', '');
      text.append(span('cb-count', `계획: 파일 ${total}개`), span('cb-files', ` · ${run.files.map((f) => f.path).join(', ')}`));
      text.title = `AI가 고칠 파일 목록(계획)을 보냈습니다:\n${list}\n\n"파일별로 받기 시작"을 누르면 한 파일씩 차례로 물어 모읍니다.`;
      const start = button('▶ 파일별로 받기 시작', `${total}개 파일을 한 파일씩 차례로 받습니다`, () => {
        run.status = 'running';
        sendStep(id);
      });
      start.className = 'cb-apply';
      const drop = button('✕', '계획을 버립니다 (파일별로 받지 않음)', () => {
        runs.delete(id);
        setChangeBar(id, false);
      });
      drop.className = 'cb-close';
      bar.replaceChildren(span('cb-icon', '»'), text, start, drop);
    } else {
      const cur = run.files[Math.min(run.index, total - 1)];
      const text = span('cb-text', '');
      text.append(span('cb-count', `파일별로 받는 중 ${Math.min(run.index + 1, total)}/${total}`), span('cb-files', ` · ${cur.path}${run.skip ? ' (건너뜀 — 답이 끝나면 다음으로)' : ''}`));
      text.title = `${list}\n\n받은 파일: ${[...run.changes.keys()].join(', ') || '없음'}`;
      const skip = button('건너뛰기', '이 파일은 받지 않고, 지금 답이 끝나면 다음 파일로 넘어갑니다 (답이 오지 않으면 멈추기)', () => {
        run.skip = true;
        renderBar(id);
      });
      const stop = button('멈추기', '여기까지 받은 수정안으로 바를 그립니다', () => finishRun(id));
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
    if (!cont) return notice('이 수정안은 이어 받을 수 없습니다 — 변경 제안에서 다시 요청하세요');
    const rounds = (b.continued?.path === path ? b.continued.rounds : 0) + 1;
    if (rounds > PX.MAX_CONTINUE) {
      const msg = `${path}은(는) 이미 ${PX.MAX_CONTINUE}번 이어 받았습니다. 변경 제안에서 "다시 요청"으로 받으세요 (긴 파일은 바꿀 곳만 찾기/바꾸기로).`;
      return auto ? notice(msg) : alert(msg);
    }
    if (auto && continuing.has(id)) return; // 이미 이어 받는 중
    if (!allowedFor(id)) return;
    const res = await host.sendFollowUp(id, PX.continuePrompt(cont));
    if (!res?.ok) return alert(`보내지 못했습니다: ${res?.error || '알 수 없는 오류'}`);
    continuing.set(id, { path, cont, changes: b.ai.plans.map((x) => x.change), rounds });
    notice(`${b.ai.name}에게 ${path}의 나머지를 부탁했습니다 (${rounds}/${PX.MAX_CONTINUE}) — 답이 끝나면 이어 붙입니다`);
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
    notice(r.error ? `이어 붙이지 못했습니다: ${r.error}` : `${st.path}을(를) 이어 붙였습니다${r.change.truncated ? ' — 아직 끝나지 않아 한 번 더 이어 받을 수 있습니다' : ''}`);
  }

  /** 적용하거나 되돌린 뒤: 아직 적용하지 않은 다른 패널의 바를 지금 파일 기준으로 다시 계산한다 */
  async function refreshOtherBars(skipId) {
    for (const [id, b] of [...bars]) if (id !== skipId && !b.applied) await refreshBar(id).catch(() => {});
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
      look.length ? `\n확인 후 적용 (실행 영향 · 삭제 · 잘림/생략 의심):\n${sumLine(look)}${look.filter((x) => x.plan.suspect).map((x) => `\n  ${x.plan.path}: ${x.plan.suspect}`).join('')}` : '',
      bad.length ? `\n적용 불가:\n${bad.map(({ plan }) => `${plan.path}: ${plan.error}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const notes = [];
    if (look.length) notes.push(span('cb-warn', `⚠ ${look.length}개 확인 필요`));
    const cut = bad.filter(({ plan }) => plan.truncated);
    if (cut.length) notes.push(span('cb-bad', `✂ 답변이 잘림 ${cut.length}개`)); // 출력 한도로 끊긴 파일 (v0.16.1) — 적용하지 않음
    if (bad.length > cut.length) notes.push(span('cb-bad', `${bad.length - cut.length}개 적용 불가`));
    if (b.split) notes.push(span('cb-warn', `» 파일별로 받음 ${b.split.got}/${b.split.total}`));
    if (b.continued) notes.push(span(b.continued.error ? 'cb-bad' : 'cb-warn', b.continued.error ? '이어 붙이지 못함' : `↪ 이어 받음 ${b.continued.rounds}번`));

    const collect = button('collect', `${ai.name}의 수정안을 경로와 전체 코드로 모아 복사합니다 (파일에는 쓰지 않음)`, () => window.onCollectClick(id));
    const view = live.length
      ? button('변경 보기', '파일마다 바뀌는 줄을 보고 골라서 적용합니다', () => openPreview(ai))
      : button('변경 제안에서 보기', '변경 제안 화면에서 전체 파일 다시 요청 등을 할 수 있습니다', () => host.setView('changes'));
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
      const cont = button('↪ 이어서 받기', `${contTarget.plan.path}이(가) 끊겼습니다. ${ai.name}에게 끊긴 곳부터 나머지만 달라고 해서 이어 붙입니다`, () => continueFile(id, contTarget.change.path));
      cont.className = 'cb-continue';
      btns.unshift(cont);
    }
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
      return cols.replaceChildren(span('change-empty', '프로젝트를 먼저 열어 주세요. 툴바의 "proj"로 폴더를 고르면 AI 답변의 코드 수정안을 여기서 비교하고 적용할 수 있습니다.'));
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
      if (plan.ok && plan.suspect) {
        const tag = span('op bad', '⚠ 잘림 · 생략?');
        tag.title = `${plan.suspect} — 적용 창에서 기본으로 체크하지 않습니다`;
        row.append(tag);
      }
      if (plan.ok) row.append(span('add', `+${plan.add}`), span('del', `−${plan.del}`));
      else {
        const err = span('err', plan.error);
        row.title = plan.error;
        row.append(err);
        if ((change.type === 'diff' || change.type === 'edit' || plan.truncated) && !change.isNew && !change.isDelete && !writeBlocked(change.path)) {
          row.append(button('다시 요청', '현재 내용을 주고 다시 달라고 합니다 (긴 파일은 바꿀 곳만 찾기/바꾸기로)', () => refetch(ai, change.path)));
        }
      }
      list.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'change-foot';
    const applyBtn = button('미리보기·적용', `${ai.name}의 수정안을 미리 보고 적용합니다`, () => openPreview(ai));
    applyBtn.disabled = !ok.length;
    const collectBtn = button('모아보기', `${ai.name}의 수정안을 경로와 전체 코드로 모아 복사합니다`, () => window.onCollectClick(ai.id));
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
      const truncated = ai.plans.some((x) => x.plan.path === path && x.plan.truncated);
      const res = await sendProjectFollowUp(ai.id, PU.packRefetch({ path, text, mode: project.uploadMode, reason: truncated ? 'truncated' : 'diff' }));
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
      $('#patchTest').onclick = null;
      $('#patchTest').hidden = true;
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
        more.textContent = `더 보기 (남은 ${lines.length - shown}줄)`;
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
    modal.show(`${ai.name} 수정안 적용`, `${project.info.name} — 체크한 파일(덩어리)만 씁니다. 적용 전 원본은 "적용 기록"에서 파일 단위로 되돌릴 수 있습니다.`);
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
          const tag = span('op bad', `⚠ 실행 영향: ${risk}`);
          tag.title = '저장하면 나중에 자동으로 실행될 수 있는 파일입니다. 내용을 확인한 뒤 직접 체크하세요.';
          head.append(tag);
        }
        if (plan.suspect) {
          // 답이 잘렸거나 AI가 코드를 줄였을 수 있다 — 그대로 쓰면 그 부분이 지워진다 (v0.16.1)
          const tag = span('op bad', `⚠ ${plan.suspect}`);
          tag.title = '전체 파일 교체인데 코드가 빠졌을 수 있습니다. −줄을 확인한 뒤 직접 체크하세요.';
          head.append(tag);
        }
        if (plan.op === 'delete') head.append(span('op delete', '파일을 지웁니다 — 직접 체크해야 적용'));
        const hunks = plan.op === 'modify' && typeof plan.before === 'string' && typeof plan.after === 'string' ? PX.splitHunks(plan.before, plan.after) : [];
        if (hunks.length > 1) head.append(span('op hunks', `덩어리 ${hunks.length}개`));
        head.append(span('add', `+${plan.add}`), span('del', `−${plan.del}`));
        pf.append(head);
        if (hunks.length > 1) {
          item.hunks = hunks.map((h) => {
            const row = document.createElement('div');
            row.className = 'pf-hunk';
            const hl = document.createElement('label');
            hl.className = 'pf-hunk-head';
            const hb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: box.checked });
            hl.append(hb, span('muted-label', `덩어리 ${h.index + 1} · ${h.oldStart}번째 줄 근처`));
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
    $('#patchApply').textContent = '선택한 파일 적용';
    $('#patchApply').focus(); // Enter(또는 Ctrl+Enter)로 바로 적용
    $('#patchApply').onclick = async () => {
      if (testRunning) return ($('#patchStatus').textContent = '테스트가 끝난 뒤 적용하세요');
      const chosen = chosenPlans();
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

    // 테스트 실행 (Windows 앱 전용: host.devtest)
    if (host.devtest) {
      const btn = $('#patchTest');
      btn.hidden = false;
      btn.textContent = '테스트 실행';
      btn.onclick = async () => {
        if (testRunning) {
          btn.disabled = true;
          await host.devtest.stop();
          return;
        }
        const chosen = chosenPlans();
        if (!chosen.length) return ($('#patchStatus').textContent = '테스트할 파일을 고르세요');
        testRunning = true;
        btn.textContent = '테스트 중지';
        $('#patchApply').disabled = true;
        const out = $('#patchTestOut');
        out.hidden = false;
        out.replaceChildren(span('muted-label', '테스트 실행 중… 적용 전 → 수정안을 잠깐 쓴 후 순서로 두 번 실행하고, 끝나면 원래 파일로 되돌립니다'));
        try {
          const r = await host.devtest.trial(chosen.map((p) => ({ path: p.path, after: p.op === 'delete' ? null : p.after })));
          renderTestResult(out, r);
        } catch (err) {
          renderTestResult(out, { ok: false, error: err.message });
        } finally {
          testRunning = false;
          btn.disabled = false;
          btn.textContent = '테스트 다시 실행';
          $('#patchApply').disabled = false;
        }
      };
    }
  }

  const fmtMs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초` : `${(ms / 1000).toFixed(1)}초`);

  /** 테스트 결과: 적용 전 | 적용 후를 나란히 (상태 · 통과/실패 수 · 걸린 시간 · 출력) */
  function renderTestResult(box, r) {
    if (!r?.ok) {
      box.replaceChildren(span(r?.cancelled ? 'muted-label' : 'test-err', r?.error || '테스트를 실행하지 못했습니다'));
      return;
    }
    const col = (title, t) => {
      const c = document.createElement('div');
      c.className = 'test-col';
      const head = document.createElement('div');
      head.className = 'test-col-head';
      head.append(span('', title));
      if (!t) {
        head.append(span('test-badge skip', '실행 안 함'));
        c.append(head);
        return c;
      }
      const [cls, label] = t.stopped
        ? ['skip', '중지함']
        : t.timedOut
          ? ['bad', '시간 초과']
          : t.error
            ? ['bad', '실행 오류']
            : t.ok
              ? ['good', '통과']
              : ['bad', `실패 (종료 코드 ${t.code})`];
      head.append(span(`test-badge ${cls}`, label));
      if (t.summary) head.append(span('muted-label', `통과 ${t.summary.pass} · 실패 ${t.summary.fail}`));
      if (t.ms) head.append(span('muted-label', fmtMs(t.ms)));
      c.append(head);
      if (t.error) c.append(span('test-err', t.error));
      if (t.restoreFailed?.length) c.append(span('test-err', `원래 파일로 되돌리지 못했습니다: ${t.restoreFailed.join(', ')}`));
      const pre = document.createElement('pre');
      pre.className = 'test-output';
      pre.textContent = t.output || '(출력 없음)';
      c.append(pre);
      requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight)); // 요약이 있는 끝부분부터 보이게
      return c;
    };
    const head = document.createElement('div');
    head.className = 'test-head';
    const verdict =
      r.before?.ok && r.after && !r.after.ok
        ? ['bad', '⚠ 수정안을 쓰면 테스트가 깨집니다']
        : !r.before?.ok && r.after?.ok
          ? ['good', '✓ 수정안이 실패하던 테스트를 고칩니다']
          : r.after?.ok
            ? ['good', '✓ 수정안을 써도 테스트가 통과합니다']
            : ['skip', '적용 전후 모두 통과하지 못했습니다'];
    head.append(span('muted-label', `npm test (${r.script})`), span(`test-badge ${verdict[0]}`, verdict[1]), span('muted-label', '파일은 원래대로 되돌렸습니다'));
    const cols = document.createElement('div');
    cols.className = 'test-cols';
    cols.append(col('적용 전', r.before), col('적용 후 (체크한 수정안)', r.after));
    box.replaceChildren(head, cols);
  }

  /**
   * 적용: 쓰기 직전에 파일이 바뀌었으면 다시 계산한다. 원본은 적용 기록에 남긴다. { entry(적용 기록 항목, 못 썼으면 null), text }
   * 여러 파일은 한 묶음(트랜잭션)으로 쓴다 (v0.23.0): 쓰기 · 지우기가 하나라도 실패하면 이 묶음에서 이미 쓴 파일을
   * 원래대로 되돌린다 (되돌리기와 같은 원본 — 고친 파일은 원래 내용, 지운 파일은 다시 만들고, 새로 만든 파일은 지움).
   * 그사이 파일이 바뀌어 다시 계산할 수 없는 파일은 예전처럼 그 파일만 빼고 쓴다.
   */
  async function applyPlans(ai, plans) {
    const failed = [];
    const ready = [];
    for (const plan of plans) {
      try {
        let p = plan;
        const now = await currentText(plan.path);
        if (now !== plan.before) {
          // 덩어리 일부만 고른 파일은 다시 계산하면 고른 것이 사라지므로 적용하지 않는다
          if (plan.partial) throw new Error('그사이 파일이 바뀌었습니다. 미리보기를 다시 열어 덩어리를 고르세요');
          const change = ai.plans.find((x) => x.plan === (plan.src || plan)).change;
          p = PX.planChange(change, now);
          if (!p.ok) throw new Error(`그사이 파일이 바뀌어 적용할 수 없습니다 (${p.error})`);
        }
        ready.push({ path: p.path, op: p.op === 'delete' ? 'delete' : 'write', before: p.before, after: p.after });
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
      alert(failed.length ? `${msg}\n\n적용하지 못한 파일:\n${failed.join('\n')}` : msg);
      return { entry: null, text: `${tx.failed.path} ${tx.failed.op === 'delete' ? '지우기' : '쓰기'} 실패 — 적용하지 않았습니다` };
    }
    const done = tx.done;
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

  const COLLECT_OP = { create: '새 파일', modify: '수정', full: '전체 코드', diff: '바뀐 부분(diff)', edit: '바꿀 곳(찾기/바꾸기)', same: '변경 없음', delete: '삭제' };

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
        const note = change.truncated ? '⚠ 답변이 중간에 잘려 이 파일의 뒷부분이 없습니다 — 그대로 붙여 넣지 마세요' : undefined;
        items.push({ path, op: before === undefined ? 'full' : before === null ? 'create' : same ? 'same' : 'modify', code: change.content, note });
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
      if (change.type === 'edit') {
        // 찾기/바꾸기 블록 (v0.17.0): 프로젝트가 없으면 전체 코드로 합칠 수 없어 블록 그대로 보여 준다
        const code = change.edits.map((e) => `<<<<<<< 찾기\n${e.search}\n=======\n${e.replace}\n>>>>>>> 바꾸기`).join('\n\n');
        items.push({ path, op: 'edit', code, note: change.truncated ? '⚠ 답변이 중간에 잘려 마지막 찾기/바꾸기가 없을 수 있습니다' : note });
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
    p.collectBtn.textContent = `파일 ${changes.length}개 모아보기`;
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

  Object.assign(P, { clearBars, continuing, currentText, finishContinue, offerRun, refreshBar, runAnswer, runs, showCollectBtn, writeBlocked, revert, modal });
})();
