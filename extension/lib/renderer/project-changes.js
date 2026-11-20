// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project-changes.js)
'use strict';

// 프로젝트 모드 — 변경 제안 화면 · 패널 변경 바 · 미리보기 · 적용 · 되돌리기 · 적용 기록.
// project.js 다음에 읽힌다. project.js의 것은 MLA.projectUI(P)에서 꺼내 쓴다 (v0.24.0에서 나눔).
// v0.31.0에서 세 파일을 더 떼어 냈다 (이 파일 바로 다음에 차례로 읽힌다):
//   project-runs.js    큰 작업(파일별로 받기) · 이어서 받기
//   project-devtest.js 검사 실행(test · lint · typecheck · build) 버튼과 결과 그리기
//   project-collect.js 파일 모아보기
// 그 파일들의 함수는 P에 실린 것을 "부를 때" 찾는다 (아래 renderRunBar 등 — 이 파일이 먼저 읽히므로 읽는 시점에는 아직 없다).
//
// [쉽게 말하면] AI 답변에 들어 있는 코드 수정안을 골라 보고, 미리 보고, 내 파일에 쓰고, 되돌리는 화면입니다.
(() => {
  const P = MLA.projectUI;
  const { project, has, MAX_LOG, allowedFor, answerMd, remember, rescan, saveState, sendProjectFollowUp } = P;
const PI = MLA.projectIgnore;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
const PC = MLA.projectContext;
const PU = MLA.projectUpload;
const PX = MLA.patch;

  // 뒤에 읽히는 파일의 함수 (부를 때 P에서 찾는다)
  P.fixRounds = new Map(); // 패널 id → 실패 로그를 돌려 보낸 횟수 (project-devtest.js, v0.34.0)
  const renderRunBar = (...a) => P.renderRunBar(...a); // project-runs.js
  const continueFile = (...a) => P.continueFile(...a); // project-runs.js
  const setupTestRun = (...a) => P.setupTestRun(...a); // project-devtest.js

  // 패널마다의 진행 상태 — 변경 바(renderBar)가 보고, project-runs.js가 채운다
  const runs = new Map(); // 패널 id -> { status: 'offer' | 'running', files: [{ path, note }], index, changes: Map(경로 -> 수정안), skip }
  const continuing = new Map(); // 패널 id -> { path, cont, changes: 원래 답의 수정안들, rounds }

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
    P.fixRounds.clear(); // 새 질문 · 새 대화: 실패 로그를 돌려 보낸 횟수를 다시 센다 (v0.34.0)
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

    const collect = button(t('project.bar.collect'), t('project.bar.collectTitle', { ai: ai.name }), () => window.onCollectClick(id));
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
      $('#patchBranch').hidden = true; // 새 브랜치 선택은 적용 창(openPreview · 섞어서 적용)만 다시 보인다 (v0.34.0)
      $('#patchBranchOn').checked = false; // 누를 때만
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
      if (testState.running) host.devtest?.stop(); // 창을 닫으면 실행 중인 테스트도 멈춘다 (파일은 메인이 되돌린다)
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

  const testState = { running: false }; // 테스트 실행 중인지 (project-devtest.js가 바꾸고, 이 창을 닫을 때 본다)

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
    P.setupBranch(ai.name);
    $('#patchApply').onclick = async () => {
      if (testState.running) return ($('#patchStatus').textContent = t('project.preview.waitTest'));
      const chosen = chosenPlans();
      if (!chosen.length) return ($('#patchStatus').textContent = t('project.preview.pickApply'));
      $('#patchApply').disabled = true;
      try {
        const branch = await P.prepareBranch(); // 체크했다면 적용 전에 새 브랜치로 (v0.34.0)
        if (!branch.ok) return;
        const { entry, text } = await applyPlans(ai, chosen);
        afterApplied(entry, branch.branch ? `${text} — ${t('project.branch.created', { name: branch.branch, from: branch.from || '?' })}` : text);
      } finally {
        $('#patchApply').disabled = false;
      }
    };

    // 테스트 실행 (Windows 앱 전용: host.devtest) — v0.28.0: lint · typecheck · build도 골라서
    setupTestRun(chosenPlans, ai);
  }

  /**
   * 창에서 적용한 뒤: 커밋 제안이 켜져 있으면(Windows 앱 · git) 창을 닫지 않고 [커밋하기…]를 보여 준다 (v0.28.0).
   * 아니면 예전처럼 잠깐 뒤 닫는다. 커밋은 누를 때만 한다.
   */
  function afterApplied(entry, text) {
    P.fixRounds.clear(); // 적용했으면 실패 로그 되먹임은 끝 (v0.34.0)
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

  const fmtAt = (ms) => new Date(ms).toLocaleString(MLA.i18n.getLang() === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

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

  /**
   * 적용 창 아래 "새 브랜치에 적용" 칸 (Windows 앱 · git 있음 · 프로젝트 열림일 때만): 체크하면 적용 직전에 git switch -c mla/<날짜>-<이름>.
   * 이름은 mla/20261117-claude처럼 제안하고 고칠 수 있다. 체크는 창을 열 때마다 꺼져 있다 (누를 때만).
   */
  function setupBranch(label) {
    const row = $('#patchBranch');
    if (!host.git?.createBranch || !P.has()) return (row.hidden = true);
    $('#patchBranchName').value = MLA.branchName.suggestBranchName({ label });
    row.hidden = false;
  }

  /** 적용 직전: 새 브랜치를 체크했으면 만든다 → { ok: true, branch?, from? } | { ok: false } (실패하면 창에 이유를 보이고 적용하지 않는다) */
  async function prepareBranch() {
    if ($('#patchBranch').hidden || !$('#patchBranchOn').checked) return { ok: true };
    $('#patchStatus').textContent = t('project.branch.creating');
    const r = await host.git.createBranch($('#patchBranchName').value).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) {
      $('#patchStatus').textContent = r?.error || t('project.branch.failed');
      return { ok: false };
    }
    return { ok: true, branch: r.branch, from: r.from };
  }

  Object.assign(P, {
    setupBranch, prepareBranch,
    clearBars, continuing, currentText, refreshBar, runs, writeBlocked, revert, modal,
    // v0.28.0: 섞어서 적용(project-mix.js) · 커밋(project-commit.js) · 이어 하기(project-restore.js)가 쓴다
    applyPlans, afterApplied, isQuick, bars, renderBar, diffPre, OP_TEXT, plansByAi: () => plansByAi,
    // v0.31.0: 떼어 낸 파일(project-runs.js · project-devtest.js)이 쓴다
    planChanges, testState,
  });
})();
