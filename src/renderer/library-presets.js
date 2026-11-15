'use strict';

// 작업 프리셋 · 스킬 이전 버전 (v0.29.0) — Windows 앱과 크롬 확장이 똑같이 씀. library.js 다음에 읽힌다.
// 프리셋 = 템플릿(+ 변수 값) · 켠 스킬(순서대로, 최대 3개) · 패널(열 모델) · 보낼 대상 · 배치 · 종합 담당과 자동 종합 · 토론 설정.
// 라이브러리(library.json / 확장 저장소)에 함께 저장하고, 라이브러리 내보내기 · 가져오기 · 설정 옮기기에도 들어간다.
//   - 라이브러리 › 프리셋 탭: 지금 설정을 프리셋으로 · 적용 · 이름 바꾸기 · 지금 설정으로 덮어쓰기 · 삭제
//   - 입력창 왼쪽 프리셋 고르기: 고르면 바로 적용. 패널이 다르면 확인한 뒤 모델 열기(models:open)로 패널을 바꾸고,
//     패널이 다 열린 뒤에 보낼 대상 · 종합 담당을 맞춘다 (종합 담당은 열린 패널만 고를 수 있어서).
// 스킬 이전 버전: 스킬을 저장할 때마다 바로 전 본문을 남긴다(최대 10개, prompt-lib.js withVersion).
//   편집기 아래 "이전 버전"에서 고르면 그 버전 → 지금 본문의 차이(jsdiff)를 보여 주고, [되돌리기]는 그 본문으로 새로 저장한다.
//
// [쉽게 말하면] 자주 쓰는 작업 환경(템플릿 · 스킬 · AI 조합 · 배치 · 종합)을 이름 붙여 저장해 두고 한 번에 불러오는 기능,
// 그리고 스킬을 고쳤다가 예전 글로 되돌릴 수 있게 지난 글을 남겨 두는 기능입니다.

(() => {
  const PL = MLA.promptLib;
  const api = () => window.libApi;
  const LAYOUTS = ['grid', 'row', 'main', 'tall'];
  const LAYOUT_TEXT = { grid: '격자', row: '가로', main: '큰 패널 + 나머지', tall: '세로' };
  const PANEL_WAIT_MS = 20000; // 패널을 다시 연 뒤 보낼 대상 · 종합을 맞추기까지 기다리는 최대 시간
  let waits = []; // [{ panels, until, fn }] 패널이 다 열리면(또는 시간이 지나면) 마저 할 일
  let verSel = { skill: null, index: -1 }; // 이전 버전 고른 것

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const openIds = () => (state?.rects || []).map((r) => r.id);
  const nameOf = (id) => state?.services.find((s) => s.id === id)?.name || (id === 'local' ? t('local.judgeHeadless') : id);
  const fmtDate = (at) => (at ? new Date(at).toLocaleString() : '');
  const presets = () => api().get().presets;
  const byId = (id) => presets().find((p) => p.id === id) || null;

  // ---------- 지금 설정 → 프리셋 ----------

  function fromCurrent(name) {
    const lib = api().get();
    const tid = api().templateId();
    return PL.presetFromState({
      name,
      templateId: tid === 'none' ? '' : tid,
      vars: lib.lastVars[tid] || {},
      activeSkills: lib.activeSkills,
      selected: openIds(),
      targets: [...targets],
      layout: state?.layout,
      synthTarget: state?.synthTarget,
      autoSynth: !!state?.autoSynth,
      debate: window.debateDefaults?.() || null,
    });
  }

  /** 지금 설정을 새 프리셋으로 저장하고 프리셋 탭에서 연다 (이름은 거기서 바꿈 — Electron에는 prompt 창이 없다) */
  async function saveCurrent() {
    const lib = api().get();
    if (lib.presets.length >= PL.LIMITS.presets) return alert(t('preset.full', { n: PL.LIMITS.presets }));
    if (!openIds().length) return alert(t('preset.noPanels'));
    const p = fromCurrent(t('preset.defaultName', { n: lib.presets.length + 1 }));
    lib.presets.push(p);
    await api().save();
    api().refreshAll();
    api().openLibrary('presets', p.id);
    setTimeout(() => $('#presetName')?.select(), 0);
  }

  // ---------- 요약 (목록 · 편집기) ----------

  function summaryLines(p) {
    const tplName = p.template.id ? api().templateName(p.template.id) || t('preset.gone') : t('preset.noneValue');
    const vars = Object.keys(p.template.vars).length;
    const skills = p.skills.map((id) => api().skillById(id)?.name || t('preset.gone'));
    const lines = [
      [t('preset.sumTemplate'), `${tplName}${vars ? ` · ${t('preset.sumVars', { n: vars })}` : ''}`],
      [t('preset.sumSkills'), skills.length ? skills.map((n, i) => `${i + 1}. ${n}`).join('  ') : t('preset.noneValue')],
      [t('preset.sumPanels'), p.selected.length ? p.selected.map(nameOf).join(', ') : t('preset.noneValue')],
      [t('preset.sumTargets'), p.targets.length ? p.targets.map(nameOf).join(', ') : t('preset.allOpen')],
      [t('preset.sumLayout'), LAYOUT_TEXT[p.layout] || t('preset.noneValue')],
      [t('preset.sumSynth'), `${p.synth.target ? nameOf(p.synth.target) : t('preset.noneValue')}${p.synth.auto ? ` · ${t('preset.sumAuto')}` : ''}`],
    ];
    if (p.debate) {
      lines.push([t('preset.sumDebate'), t('preset.sumDebateValue', { names: p.debate.participants.map(nameOf).join(', ') || '-', rounds: p.debate.rounds || '-', judge: p.debate.judge ? nameOf(p.debate.judge) : '-' })]);
    }
    return lines;
  }

  // ---------- 적용 ----------

  /** 프리셋 적용: 템플릿 · 스킬 · 배치 · 토론 기본값은 바로, 패널이 다르면 확인 후 다시 열고, 열린 뒤 보낼 대상 · 종합 */
  async function apply(p) {
    const plan = PL.presetPlan(p, {
      openIds: openIds(),
      available: (state?.services || []).map((s) => s.id),
      hasTemplate: api().hasTemplate,
      hasSkill: (id) => !!api().skillById(id),
      layouts: LAYOUTS,
    });
    let panels = plan.panels;
    if (panels && !confirm(t('preset.confirmPanels', { name: p.name, names: panels.map(nameOf).join(', ') }))) panels = null;
    const lib = api().get();
    const tid = plan.template || 'none';
    if (plan.template && Object.keys(p.template.vars).length) lib.lastVars[plan.template] = { ...p.template.vars }; // 변수 입력 칸에 미리 채움
    lib.activeSkills = plan.skills;
    await api().save();
    api().setTemplate(tid);
    api().refreshAll();
    window.setDebateDefaults?.(p.debate);
    if (plan.layout && plan.layout !== state.layout) host.setLayout(plan.layout);
    const notes = [];
    if (plan.missing.services.length) notes.push(t('preset.missingServices', { names: plan.missing.services.join(', ') }));
    if (plan.missing.skills.length) notes.push(t('preset.missingSkills', { n: plan.missing.skills.length }));
    if (plan.missing.template) notes.push(t('preset.missingTemplate'));
    $('#sendHint').textContent = `${t('preset.applied', { name: p.name })}${notes.length ? ` — ${notes.join(' · ')}` : ''}`;
    if (panels) {
      afterPanelsOpen(panels, () => finish(p));
      host.openModels(panels); // 모델 열기와 같은 길 (고르지 않은 패널은 닫힘)
    } else finish(p);
    if (state?.chatView === 'library') host.setView('panels');
  }

  /** 패널이 열린 뒤: 보낼 대상 · 종합 담당 · 자동 종합 */
  function finish(p) {
    const open = openIds();
    const want = p.targets.filter((id) => open.includes(id));
    if (want.length) {
      targets.clear();
      for (const id of want) targets.add(id);
      renderTargets();
    }
    const canJudge = judgeChoices().some((c) => c.id === p.synth.target);
    host.setSynth(canJudge ? { target: p.synth.target, auto: p.synth.auto } : { auto: p.synth.auto });
  }

  /** 패널 ids가 모두 열리면 fn (설정 옮기기도 씀 — 종합 담당은 열린 패널만 고를 수 있어서) */
  function afterPanelsOpen(panels, fn) {
    waits.push({ panels, until: Date.now() + PANEL_WAIT_MS, fn });
  }
  window.afterPanelsOpen = afterPanelsOpen;

  host.on('state', () => {
    if (!waits.length || state.mode !== 'chat') return;
    const open = openIds();
    const ready = waits.filter((w) => w.panels.every((id) => open.includes(id)) || Date.now() > w.until);
    waits = waits.filter((w) => !ready.includes(w));
    for (const w of ready) w.fn();
  });

  // ---------- 입력창 왼쪽 프리셋 고르기 ----------

  function refresh() {
    const sel = $('#presetSelect');
    if (!sel) return;
    const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
    sel.replaceChildren(opt('', t('preset.none')), ...presets().map((p) => opt(p.id, p.name)), opt('__save', t('preset.saveCurrent')), opt('__manage', t('preset.manage')));
    sel.value = '';
  }

  $('#presetSelect').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (v === '__save') return saveCurrent();
    if (v === '__manage') return api().openLibrary('presets', null);
    const p = byId(v);
    if (p) apply(p);
  });

  // ---------- 라이브러리 › 프리셋 탭 ----------

  let ui = { sel: null };

  function row(p, active) {
    const r = el('div', `lib-row${active ? ' active' : ''}`);
    const text = el('div', 'lib-row-text');
    text.append(el('span', 'lib-row-name', p.name), el('span', 'lib-row-sub', p.selected.map(nameOf).join(' · ') || t('preset.noneValue')));
    const use = button(t('preset.applyShort'), t('preset.apply'), (e) => {
      e.stopPropagation();
      apply(p);
    });
    use.className = 'lib-mini';
    r.append(text, use);
    r.addEventListener('click', () => {
      ui.sel = p.id;
      render(ui);
    });
    return r;
  }

  function render(libUi) {
    ui = libUi;
    const add = button(t('preset.saveCurrent'), t('preset.saveCurrentTitle'), () => saveCurrent());
    const list = [add, el('span', 'lib-group', t('preset.count', { n: presets().length, max: PL.LIMITS.presets })), ...presets().map((p) => row(p, ui.sel === p.id))];
    $('#libList').replaceChildren(...list);
    const p = byId(ui.sel);
    $('#libPresetEditor').hidden = !p;
    $('#libEmpty').hidden = !!p;
    $('#libEmpty').textContent = t('preset.empty');
    if (!p) return;
    $('#presetName').value = p.name;
    $('#presetSummary').replaceChildren(
      ...summaryLines(p).map(([k, v]) => {
        const line = el('div', 'preset-line');
        line.append(el('span', 'muted-label', k), el('span', '', v));
        return line;
      }),
    );
    $('#presetInfo').textContent = p.at ? t('preset.savedAt', { at: fmtDate(p.at) }) : '';
  }

  $('#presetApply').addEventListener('click', () => byId(ui.sel) && apply(byId(ui.sel)));
  $('#presetSave').addEventListener('click', async () => {
    const p = byId(ui.sel);
    const name = $('#presetName').value.trim();
    if (!p) return;
    if (!name) return alert(t('preset.nameEmpty'));
    p.name = name;
    await api().save();
    api().refreshAll();
    flash($('#presetInfo'), t('preset.saved'));
  });
  $('#presetUpdate').addEventListener('click', async () => {
    const p = byId(ui.sel);
    if (!p || !confirm(t('preset.confirmUpdate', { name: p.name }))) return;
    const next = fromCurrent($('#presetName').value.trim() || p.name);
    Object.assign(p, { ...next, id: p.id });
    await api().save();
    api().refreshAll();
    flash($('#presetInfo'), t('preset.saved'));
  });
  $('#presetDelete').addEventListener('click', async () => {
    const p = byId(ui.sel);
    if (!p || !confirm(t('preset.confirmDelete', { name: p.name }))) return;
    const lib = api().get();
    lib.presets = lib.presets.filter((x) => x !== p);
    ui.sel = null;
    await api().save();
    api().refreshAll();
  });

  // ---------- 스킬 이전 버전 ----------

  function renderVersions(sk) {
    const box = $('#libVersions');
    if (!sk) {
      box.hidden = true;
      return;
    }
    if (verSel.skill !== sk.id) verSel = { skill: sk.id, index: -1 };
    const list = sk.versions || [];
    box.hidden = false;
    $('#libVersionsHead').textContent = t('version.head', { n: list.length, max: PL.LIMITS.versions });
    $('#libVersionList').replaceChildren(
      ...(list.length
        ? list.map((v, i) => {
            const b = button(`${fmtDate(v.at)} · ${t('version.chars', { n: v.body.length.toLocaleString() })}`, t('version.pickTitle'), () => {
              verSel.index = i;
              renderVersions(sk);
            });
            b.className = `lib-version${verSel.index === i ? ' active' : ''}`;
            return b;
          })
        : [el('span', 'muted-label', t('version.none'))]),
    );
    const v = list[verSel.index];
    $('#libVersionRestore').disabled = !v;
    $('#libVersionInfo').textContent = v ? t('version.diffInfo', { at: fmtDate(v.at) }) : list.length ? t('version.pick') : '';
    $('#libVersionDiff').replaceChildren(
      ...(v
        ? PL.versionDiff(v.body, sk.body, Diff).map((d) => el('span', `vd vd-${d.type}`, `${d.type === 'add' ? '+ ' : d.type === 'del' ? '- ' : '  '}${d.text}\n`))
        : []),
    );
  }

  $('#libVersionRestore').addEventListener('click', async () => {
    const sk = api().skillById(verSel.skill);
    if (!sk || verSel.index < 0) return;
    if (api().editorDirty() && !confirm(t('version.confirmDirty'))) return;
    const r = PL.restoreVersion(sk, verSel.index);
    if (!r) return;
    Object.assign(sk, r);
    verSel.index = -1;
    api().clearDraft();
    await api().save();
    api().refreshAll();
    api().renderLibrary();
    flash($('#libInfo'), t('version.restored'));
  });

  window.libPresets = { render, refresh, renderVersions, apply, saveCurrent };
  refresh(); // library.js가 이미 라이브러리를 읽었으면 바로 채운다 (아니면 refreshAll이 부름)
})();
