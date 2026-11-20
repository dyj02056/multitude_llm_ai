// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/library.js)
'use strict';

// 프롬프트 라이브러리(변수 있는 내 템플릿)와 스킬 화면.
// renderer.js · project.js 다음에 읽힌다 ($, state, host, button, span, flash는 renderer.js의 것).
// 저장은 host.library (Windows 앱: 앱 데이터 폴더 library.json / 크롬 확장: 확장 저장소), 처리는 MLA.promptLib.
//
// - 템플릿: 기본 템플릿(templates.js, 고칠 수 없음 — 복제해서 고침) + 내 템플릿. 변수가 있으면 보낼 때 "변수 입력" 화면을 띄운다.
// - 스킬: 고른 스킬의 지침을 각 패널의 새 대화 첫 질문(또는 매 질문) 앞에 붙여 보낸다.
//   패널마다 이 대화에 어떤 스킬을 보냈는지 기억하고, 새 대화(＋ · ⌂ · 모두 새 대화)를 열면 잊는다.

// [쉽게 말하면]
// 📚 라이브러리 화면입니다. 자주 쓰는 질문 양식(템플릿)과 AI에게 줄 지침(스킬)을 만들고 고르는 곳입니다.
//   - 템플릿에 {{이름}} 같은 빈칸이 있으면, 보낼 때 "변수 입력" 화면을 띄워 채우게 합니다.
//   - 스킬을 켜 두면 질문 앞에 지침을 붙여 보냅니다. 같은 대화에는 한 번만 붙이고, 새 대화를 열면 다시 붙입니다.
//   - 스킬이 너무 길면 AI에게 줄여 달라고 부탁하는 "AI로 압축" 기능도 여기 있습니다.
// 전체를 (() => { … })() 로 감싸 이름이 다른 파일과 부딪히지 않게 했습니다.
(() => {
  const PL = MLA.promptLib;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
  const TPL_KEY = 'mla.template'; // 마지막에 고른 템플릿 (이 PC에만 저장)
  const tr = MLA.i18n.t; // 화면 문구 (i18n-*-library.js)

  let lib = PL.normalizeLibrary({});
  let template = TEMPLATES[0];
  const skillSent = new Map(); // 패널 id -> 이 대화에 보낸 스킬 id 목록 (순서대로)
  const ui = { tab: 'templates', sel: null }; // 라이브러리 화면: 보고 있는 탭과 고른 항목 id

  const builtinTpl = (id) => TEMPLATES.find((t) => t.id === id);
  const userTpl = (id) => lib.templates.find((t) => t.id === id);
  const findTpl = (id) => builtinTpl(id) || userTpl(id);

  /** 라이브러리를 저장합니다 (모양을 정리한 뒤). 실패하면 알림 창을 띄웁니다. */
  async function save() {
    lib = PL.normalizeLibrary(lib);
    const ok = await host.library.save(lib).catch(() => false);
    if (!ok) alert(tr('library.saveFailed'));
  }

  // ---------- 템플릿 고르기 (입력창 왼쪽) ----------

  function option(value, text) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  }

  // 입력창 왼쪽의 템플릿 고르기 목록: 즐겨찾기 → 내 템플릿 → 기본 템플릿 순서, 맨 아래 "라이브러리 열기"
  function renderTplSelect() {
    const group = (label, items) => {
      const g = document.createElement('optgroup');
      g.label = label;
      g.append(...items);
      return g;
    };
    const mine = [...lib.templates].sort((a, b) => b.fav - a.fav).map((t) => option(t.id, `${t.fav ? '★ ' : ''}${t.name}`));
    $('#tplSelect').replaceChildren(
      option('none', TEMPLATES[0].name),
      ...(mine.length ? [group(tr('library.groupMine'), mine)] : []),
      group(tr('library.groupBuiltin'), TEMPLATES.slice(1).map((t) => option(t.id, t.name))),
      option('__library', tr('library.openLibrary')),
    );
    $('#tplSelect').value = template.id;
  }

  // 템플릿을 고르면 입력창의 안내 글(hint)을 그 템플릿에 맞게 바꾸고, 다음에도 기억합니다.
  function setTemplate(id) {
    template = findTpl(id) || TEMPLATES[0];
    $('#tplSelect').value = template.id;
    $('#tplSelect').classList.toggle('on', template.id !== 'none');
    $('#prompt').placeholder = template.hint || tr('library.promptPlaceholder');
    // 템플릿이 질문을 어떻게 감싸는지 한 줄로 보여 준다. 변수는 〈이름〉으로.
    const vars = PL.parseVars(template.text);
    $('#tplPreview').textContent =
      template.id === 'none' ? '' : `${vars.length ? tr('library.tplPreviewVars', { n: vars.length }) : ''}${template.text.replace(/\n+/g, ' ').replace('{q}', tr('library.tplPreviewInput'))}`;
    $('#tplPreview').title = template.text;
    try {
      localStorage.setItem(TPL_KEY, template.id);
    } catch {}
  }

  $('#tplSelect').addEventListener('change', (e) => {
    if (e.target.value === '__library') {
      e.target.value = template.id;
      return openLibrary('templates', template.id === 'none' ? null : template.id);
    }
    setTemplate(e.target.value);
    $('#prompt').focus();
  });

  // ---------- 변수 입력 화면 ----------

  let varsWait = null; // { resolve, tpl, q }

  /**
   * 보내기 전에 템플릿을 적용한다. 변수가 있으면 "변수 입력" 화면을 띄우고 사용자가 보내기를 누를 때까지 기다린다.
   * → 실제 질문 글 | null(취소)
   */
  window.libApplyTemplate = (q) => {
    const tpl = template;
    const vars = PL.parseVars(tpl.text);
    const builtins = window.projectBuiltins?.() || {};
    if (!vars.length) return Promise.resolve(PL.fillTemplate(tpl.text, q, {}, builtins));
    return new Promise((resolve) => {
      varsWait = { resolve, tpl, q, builtins };
      renderVars();
      host.setView('vars');
      setTimeout(() => $('#varsForm input, #varsForm select')?.focus(), 0);
    });
  };

  function varValues() {
    const out = {};
    for (const el of document.querySelectorAll('#varsForm [data-var]')) out[el.dataset.var] = el.value;
    return out;
  }

  // 변수 입력 화면: 빈칸마다 입력 칸(또는 고르기 목록)을 만들고, 마지막에 넣었던 값을 미리 채웁니다.
  function renderVars() {
    const { tpl, q } = varsWait;
    const last = lib.lastVars[tpl.id] || {};
    $('#varsTitle').textContent = tpl.name;
    const rows = PL.parseVars(tpl.text).map((v) => {
      const row = document.createElement('label');
      row.className = 'var-row';
      let field;
      if (v.choices) {
        field = document.createElement('select');
        field.append(...v.choices.map((c) => option(c, c)));
        field.value = v.choices.includes(last[v.name]) ? last[v.name] : v.def;
      } else {
        field = document.createElement('input');
        field.value = last[v.name] ?? '';
        field.placeholder = v.def ? tr('library.varDefault', { def: v.def }) : '';
        field.spellcheck = false;
      }
      field.dataset.var = v.name;
      field.addEventListener('input', updateVarsPreview);
      field.addEventListener('change', updateVarsPreview);
      row.append(span('var-name', v.name), field);
      return row;
    });
    $('#varsFields').replaceChildren(...rows);
    $('#varsQ').textContent = q ? tr('library.varsQ', { n: q.length.toLocaleString() }) : '';
    updateVarsPreview();
  }

  function updateVarsPreview() {
    if (!varsWait) return;
    const { tpl, q, builtins } = varsWait;
    $('#varsPreview').textContent = PL.fillTemplate(tpl.text, q.length > 300 ? `${q.slice(0, 300)}…` : q, varValues(), builtins);
  }

  // 변수 입력을 끝냄: send가 true면 채운 글로 보내고, false면 취소하고 원래 화면으로
  function finishVars(send) {
    if (!varsWait) return;
    const { resolve, tpl, q, builtins } = varsWait;
    varsWait = null;
    if (state?.chatView === 'vars') host.setView('panels');
    if (!send) return resolve(null);
    const values = varValues();
    lib.lastVars[tpl.id] = values;
    save();
    resolve(PL.fillTemplate(tpl.text, q, values, builtins));
  }

  $('#varsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    finishVars(true);
  });
  $('#varsCancel').addEventListener('click', () => finishVars(false));

  // ---------- 스킬 고르기 · 붙이기 ----------
  // 입력창 위 🧩 버튼을 누르면 첨부 줄 자리에 스킬 칩 줄이 펼쳐진다 (웹 패널에 가려지지 않는 공통 입력창 안).
  // 켠 순서 = 우선순위 (①②③), 최대 3개.

  const skillById = (id) => lib.skills.find((s) => s.id === id) || null;
  const activeList = () => lib.activeSkills.map(skillById).filter(Boolean);
  const CIRCLED = ['①', '②', '③'];
  let changeNoted = false; // 대화 중간에 스킬을 바꿨다는 안내를 이미 보였는지
  let totalAlerted = false; // 합계가 길다는 확인을 이번 실행에서 이미 물었는지

  /** 스킬 하나의 길이 표시: { text, level } */
  function badgeOf(s) {
    const len = PL.sendBody(s).length;
    if (s.compact && PL.compactStale(s)) return { text: tr('library.badgeStale', { n: len.toLocaleString() }), level: 'stale' };
    if (s.compact && s.useCompact) return { text: tr('library.badgeCompact', { n: len.toLocaleString(), body: s.body.length.toLocaleString() }), level: 'compact' };
    const level = s.noWarn ? 'none' : PL.compressLevel(len, lib.compressWarn, lib.skillMode);
    const label = { warn: tr('library.badgeWarn'), strong: tr('library.badgeStrong') }[level] || '';
    return { text: label + tr('library.chars', { n: len.toLocaleString() }), level };
  }

  // 🧩 스킬 칩 줄: 스킬마다 켜기/끄기 단추, 켠 순서(①②③)가 우선순위입니다.
  function renderSkillBar() {
    const active = activeList();
    const { len } = PL.prefixSize(active);
    const L = PL.warnLimits(lib.compressWarn, lib.skillMode);
    const btn = $('#skillBtn');
    btn.textContent = active.length === 0 ? tr('library.skillBtnNone') : active.length === 1 ? tr('library.skillBtnOne', { name: active[0].name }) : tr('library.skillBtnMany', { n: active.length });
    btn.classList.toggle('on', active.length > 0);
    btn.classList.toggle('warn', len >= L.total);
    btn.title = active.length
      ? `${active.map((s, i) => `${CIRCLED[i]} ${s.name}`).join('\n')}\n${tr('library.skillTotal', { len: len.toLocaleString(), max: PL.LIMITS.prefixTotal.toLocaleString() })} · ${tr(`library.mode.${lib.skillMode}`)}${len >= L.total ? `\n${tr('library.skillTotalLong')}` : ''}`
      : tr('library.skillBtnTitle');
    const chips = lib.skills.map((s) => {
      const at = lib.activeSkills.indexOf(s.id);
      const b = badgeOf(s);
      const chip = button(`${at >= 0 ? `${CIRCLED[at]} ` : ''}${s.name}`, `${s.description || s.name}\n${b.text}`, () => toggleSkill(s.id));
      chip.className = `skill-chip-btn${at >= 0 ? ' on' : ''} lv-${b.level}`;
      chip.disabled = at < 0 && lib.activeSkills.length >= PL.LIMITS.activeSkills;
      return chip;
    });
    $('#skillChips').replaceChildren(...(chips.length ? chips : [span('muted-label', tr('library.noSkills'))]));
    $('#skillTotal').textContent = `${lib.activeSkills.length}/${PL.LIMITS.activeSkills} · ${tr('library.skillTotal', { len: len.toLocaleString(), max: PL.LIMITS.prefixTotal.toLocaleString() })}`;
    $('#skillTotal').classList.toggle('warn', len >= L.total);
  }

  /** 스킬 켜기/끄기 (켜면 맨 뒤 = 가장 낮은 우선순위) */
  // 스킬 켜기/끄기 (최대 3개). 너무 긴 스킬이면 켜기 전에 한 번 확인합니다.
  async function toggleSkill(id) {
    const s = skillById(id);
    if (!s) return;
    const at = lib.activeSkills.indexOf(id);
    if (at >= 0) lib.activeSkills.splice(at, 1);
    else {
      if (lib.activeSkills.length >= PL.LIMITS.activeSkills) return alert(tr('library.activeLimit', { n: PL.LIMITS.activeSkills }));
      if (badgeOf(s).level === 'strong') {
        const ok = confirm(
          tr('library.confirmStrong', { name: s.name, n: PL.sendBody(s).length.toLocaleString() }),
        );
        if (!ok) return;
        s.noWarn = true;
      }
      lib.activeSkills.push(id);
    }
    await save();
    noteMidChange();
    refreshAll();
  }

  /** 이미 스킬을 받은 대화가 있는데 바꾸면 한 번 안내한다 */
  function noteMidChange() {
    if (changeNoted) return;
    const now = lib.activeSkills.join(',');
    if (![...skillSent.values()].some((ids) => ids.join(',') !== now)) return;
    changeNoted = true;
    $('#sendHint').textContent = tr('library.midChange');
  }

  $('#skillBtn').addEventListener('click', () => {
    const row = $('#attachRow');
    row.classList.toggle('skill-open');
    if (row.classList.contains('skill-open')) renderSkillBar();
  });
  $('#skillBarClose').addEventListener('click', () => $('#attachRow').classList.remove('skill-open'));
  $('#skillBarManage').addEventListener('click', () => {
    $('#attachRow').classList.remove('skill-open');
    openLibrary('skills', lib.activeSkills[0] || null);
  });

  /**
   * 이번에 보낼 패널마다 붙일 스킬 지침. → { prefixById, ids(붙일 패널), sentById } | { cancel: true } | null
   * "새 대화 첫 질문에만"이면 이 대화에 같은 스킬을 이미 보낸 패널은 빼고, 바뀐 패널에는 바뀐 점만 붙인다.
   */
  window.libSkillPrefix = (targetIds) => {
    const active = activeList();
    if (active.length) {
      const { len, over } = PL.prefixSize(active);
      if (over) {
        alert(tr('library.prefixOver', { len: len.toLocaleString(), max: PL.LIMITS.prefixTotal.toLocaleString() }));
        return { cancel: true };
      }
      if (!totalAlerted && len >= PL.warnLimits(lib.compressWarn, lib.skillMode).totalAlert) {
        const tips = active
          .filter((s) => !(s.compact && s.useCompact))
          .map((s) => `- ${s.name}: ${tr('library.chars', { n: PL.sendBody(s).length.toLocaleString() })}`)
          .join('\n');
        const ok = confirm(tr('library.confirmTotal', { n: len.toLocaleString(), tips: tips ? tr('library.confirmTotalTips', { tips }) : '' }));
        if (!ok) return { cancel: true };
        totalAlerted = true;
      }
    }
    const prefixById = {};
    const sentById = {};
    for (const id of targetIds) {
      const r = PL.prefixFor(active, skillSent.has(id) ? skillSent.get(id) : null, lib.skillMode, (sid) => skillById(sid)?.name);
      if (!r) continue;
      prefixById[id] = r.text;
      sentById[id] = r.ids;
    }
    const ids = Object.keys(prefixById);
    return ids.length ? { prefixById, ids, sentById } : null;
  };

  /** 보내기에 성공한 패널은 이 대화에 받은 스킬 목록을 기억한다 */
  window.onSkillSent = (applied, okIds) => {
    if (!applied?.sentById) return;
    for (const id of okIds) if (applied.sentById[id]) skillSent.set(id, applied.sentById[id]);
    changeNoted = false;
  };
  window.onSkillCleared = (id) => skillSent.delete(id);

  // ---------- 라이브러리 화면 ----------

  /** 라이브러리 화면 열기. tab: 'templates' 또는 'skills', sel: 처음에 고를 항목 */
  function openLibrary(tab, sel) {
    ui.tab = tab;
    ui.sel = sel || null;
    host.setView('library');
    renderLibrary();
  }

  $('#libraryBtn').addEventListener('click', () => (state?.chatView === 'library' ? host.setView('panels') : openLibrary(ui.tab, ui.sel)));
  $('#libClose').addEventListener('click', () => host.setView('panels'));
  for (const b of document.querySelectorAll('[data-libtab]')) {
    b.addEventListener('click', () => {
      ui.tab = b.dataset.libtab;
      ui.sel = null;
      renderLibrary();
    });
  }

  function listRow(label, sub, active, onClick, extra = []) {
    const row = document.createElement('div');
    row.className = `lib-row${active ? ' active' : ''}`;
    const text = document.createElement('div');
    text.className = 'lib-row-text';
    text.append(span('lib-row-name', label), span('lib-row-sub', sub));
    row.append(text, ...extra);
    row.addEventListener('click', onClick);
    keyClick(row, onClick); // 키보드: Tab으로 줄에 닿아 Enter (v0.30.0)
    if (active) row.setAttribute('aria-current', 'true');
    return row;
  }

  // 라이브러리 화면 왼쪽 목록(템플릿·스킬)과 오른쪽 편집기를 그립니다.
  function renderLibrary() {
    for (const b of document.querySelectorAll('[data-libtab]')) b.classList.toggle('active', b.dataset.libtab === ui.tab);
    // 프리셋 탭 (v0.29.0): 목록 · 편집은 library-presets.js가 그린다
    const presetTab = ui.tab === 'presets';
    $('#libPresetEditor').hidden = true;
    if (presetTab) {
      $('#libMode').hidden = true;
      $('#libWarn').hidden = true;
      $('#libEditor').hidden = true;
      shown = null;
      window.libPresets?.render(ui);
      return;
    }
    $('#libMode').hidden = ui.tab !== 'skills';
    $('#libWarn').hidden = ui.tab !== 'skills';
    $('#libSkillMode').value = lib.skillMode;
    $('#libWarnOne').value = lib.compressWarn.one;
    $('#libWarnTotal').value = lib.compressWarn.total;
    const list = [];
    if (ui.tab === 'templates') {
      list.push(button(tr('library.newTemplate'), tr('library.newTemplateTitle'), () => editNewTemplate()));
      list.push(span('lib-group', tr('library.groupMineCount', { n: lib.templates.length })));
      for (const t of [...lib.templates].sort((a, b) => b.fav - a.fav)) {
        const star = button(t.fav ? '★' : '☆', t.fav ? tr('library.unfav') : tr('library.fav'), (e) => {
          e.stopPropagation();
          t.fav = !t.fav;
          save().then(refreshAll);
        });
        star.className = 'lib-star';
        list.push(listRow(t.name, varsSummary(t.text), ui.sel === t.id, () => select(t.id), [star]));
      }
      list.push(span('lib-group', tr('library.groupBuiltinNote')));
      for (const t of TEMPLATES.slice(1)) list.push(listRow(tr('library.builtinRow', { name: t.name }), varsSummary(t.text), ui.sel === t.id, () => select(t.id)));
    } else {
      list.push(button(tr('library.newSkill'), tr('library.newSkillTitle'), () => editNewSkill()));
      list.push(button(tr('library.importSkill'), tr('library.importSkillTitle'), () => $('#libSkillFile').click()));
      // 켠 스킬: 순서가 우선순위 (▲▼로 바꿈)
      const active = activeList();
      list.push(span('lib-group', tr('library.groupActive', { n: active.length, max: PL.LIMITS.activeSkills, len: PL.prefixSize(active).len.toLocaleString() })));
      active.forEach((s, i) => {
        const move = (d) => (e) => {
          e.stopPropagation();
          const arr = lib.activeSkills;
          const j = i + d;
          if (j < 0 || j >= arr.length) return;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          save().then(refreshAll);
        };
        const up = button('▲', tr('library.moveUp'), move(-1));
        const down = button('▼', tr('library.moveDown'), move(1));
        const off = button(tr('library.off'), tr('library.skillOff'), (e) => {
          e.stopPropagation();
          toggleSkill(s.id);
        });
        for (const b of [up, down, off]) b.className = 'lib-mini';
        up.disabled = i === 0;
        down.disabled = i === active.length - 1;
        list.push(listRow(`${CIRCLED[i]} ${s.name}`, badgeOf(s).text, ui.sel === s.id, () => select(s.id), [up, down, off]));
      });
      list.push(span('lib-group', tr('library.groupSkills', { n: lib.skills.length })));
      for (const s of lib.skills) {
        const b = badgeOf(s);
        const row = listRow(`${lib.activeSkills.includes(s.id) ? '● ' : ''}${s.name}`, b.text, ui.sel === s.id, () => select(s.id));
        row.classList.add(`lv-${b.level}`);
        list.push(row);
      }
    }
    $('#libList').replaceChildren(...list);
    renderEditor();
  }

  const varsSummary = (text) => {
    const vars = PL.parseVars(text);
    return vars.length ? tr('library.varsList', { names: vars.map((v) => v.name).join(', ') }) : tr('library.noVars');
  };

  function select(id) {
    if (editorDirty() && !confirm(tr('library.discardEdits'))) return;
    ui.sel = id;
    renderLibrary();
  }

  // 편집기: 고른 항목을 보여 주고 고친다. draft는 아직 저장하지 않은 새 항목.
  let draft = null;
  let shown = null; // 편집기에 넣은 처음 값 (고쳤는지 비교)

  function editNewTemplate(from) {
    if (editorDirty() && !confirm(tr('library.discardEdits'))) return;
    draft = { kind: 'template', name: from ? tr('library.copyName', { name: from.name }) : '', hint: from?.hint || '', text: from?.text || '{q}' };
    ui.sel = null;
    renderLibrary();
    $('#libName').focus();
  }

  function editNewSkill(from) {
    if (editorDirty() && !confirm(tr('library.discardEdits'))) return;
    draft = { kind: 'skill', name: from?.name || '', hint: from?.description || '', text: from?.body || '' };
    ui.sel = null;
    renderLibrary();
    $('#libName').focus();
  }

  const editorDirty = () =>
    !!shown && ($('#libName').value !== shown.name || $('#libHint').value !== shown.hint || $('#libText').value !== shown.text);

  function current() {
    if (draft) return { ...draft, readonly: false, isNew: true };
    if (!ui.sel) return null;
    if (ui.tab === 'templates') {
      const b = builtinTpl(ui.sel);
      if (b) return { kind: 'template', name: b.name, hint: b.hint || '', text: b.text, readonly: true, item: b };
      const t = userTpl(ui.sel);
      return t ? { kind: 'template', name: t.name, hint: t.hint, text: t.text, item: t } : null;
    }
    const s = lib.skills.find((x) => x.id === ui.sel);
    return s ? { kind: 'skill', name: s.name, hint: s.description, text: s.body, item: s } : null;
  }

  // 고른 템플릿·스킬의 편집 칸 (기본 템플릿은 읽기만 하고 "복제해서 고치기"를 보여 줌)
  function renderEditor() {
    const c = current();
    const ed = $('#libEditor');
    ed.hidden = !c;
    $('#libEmpty').hidden = !!c;
    $('#libEmpty').textContent =
      ui.tab === 'templates'
        ? tr('library.emptyTemplates')
        : tr('library.emptySkills');
    if (!c) {
      shown = null;
      return;
    }
    const isTpl = c.kind === 'template';
    $('#libHintLabel').textContent = isTpl ? tr('library.hintLabel') : tr('library.descLabel');
    $('#libTextLabel').textContent = isTpl ? tr('library.textLabelTpl') : tr('library.textLabelSkill');
    $('#libName').value = c.name;
    $('#libHint').value = c.hint;
    $('#libText').value = c.text;
    for (const el of [$('#libName'), $('#libHint'), $('#libText')]) el.readOnly = !!c.readonly;
    shown = { name: c.name, hint: c.hint, text: c.text };
    $('#libSave').hidden = !!c.readonly;
    $('#libDelete').hidden = !!c.readonly || !!c.isNew;
    $('#libCopy').hidden = !!c.isNew;
    $('#libCopy').textContent = c.readonly ? tr('library.copyEdit') : tr('library.copy');
    $('#libExportMd').hidden = isTpl || !!c.isNew;
    $('#libShare').hidden = !!c.readonly || !!c.isNew; // 내 항목만 공유 (v0.35.0)
    $('#libUse').hidden = !!c.isNew;
    $('#libUse').textContent = isTpl ? tr('library.useTemplate') : lib.activeSkills.includes(c.item?.id) ? tr('library.skillOff') : tr('library.skillOn');
    // 스킬 전용: 보내는 글 고르기 · 예시 절 빼기 · 알림 끄기 · AI로 압축
    const sk = !isTpl && !c.isNew ? c.item : null;
    $('#libSkillOpts').hidden = !sk;
    if (sk) {
      $('#libUseCompact').value = sk.compact && sk.useCompact ? 'compact' : 'body';
      $('#libUseCompact').disabled = !sk.compact;
      $('#libDropEx').checked = sk.dropExamples;
      $('#libNoWarn').checked = sk.noWarn;
      $('#libCompactDel').hidden = !sk.compact;
      $('#libCompress').textContent = sk.compact ? tr('library.recompress') : tr('library.compress');
    }
    window.libPresets?.renderVersions(sk); // 스킬 이전 버전 (v0.29.0)
    updateEditorInfo();
  }

  function updateEditorInfo() {
    const c = current();
    if (!c) return;
    const text = $('#libText').value;
    if (c.kind === 'template') {
      const vars = PL.parseVars(text);
      $('#libInfo').dataset.level = '';
      $('#libInfo').textContent = `${vars.length ? tr('library.varsInfo', { n: vars.length, names: vars.map((v) => (v.choices ? `${v.name}(${v.choices.join('/')})` : v.def ? `${v.name}=${v.def}` : v.name)).join(', ') }) : tr('library.noVars')}${text.includes('{q}') ? '' : tr('library.noQ')}`;
    } else {
      // 보내는 글 길이 (저장한 스킬이면 압축본·정리 설정을 반영, 새 스킬이면 지금 입력한 글을 정리한 길이)
      const sk = c.isNew ? null : c.item;
      const probe = sk ? { ...sk, body: text } : { body: text, compact: '', useCompact: false, dropExamples: false };
      const len = PL.sendBody(probe).length;
      const level = sk?.noWarn ? 'none' : PL.compressLevel(len, lib.compressWarn, lib.skillMode);
      const L = PL.warnLimits(lib.compressWarn, lib.skillMode);
      const advice = { warn: tr('library.adviceWarn', { n: L.one.toLocaleString() }), strong: tr('library.adviceStrong', { n: L.strong.toLocaleString() }) }[level] || '';
      const compactNote = sk?.compact ? (PL.compactStale({ ...sk, body: text }) ? tr('library.noteStale') : tr('library.noteCompact', { n: sk.compact.length.toLocaleString() })) : '';
      $('#libInfo').textContent = `${tr('library.skillInfo', { n: text.length.toLocaleString(), max: PL.LIMITS.skillBody.toLocaleString(), len: len.toLocaleString() })}${advice}${compactNote} · ${tr(`library.mode.${lib.skillMode}`)}`;
      $('#libInfo').dataset.level = level;
    }
  }
  $('#libText').addEventListener('input', updateEditorInfo);

  $('#libSave').addEventListener('click', async () => {
    const c = current();
    if (!c || c.readonly) return;
    const name = $('#libName').value.trim();
    const hint = $('#libHint').value.trim();
    const text = $('#libText').value;
    if (!name) return alert(tr('library.needName'));
    if (!text.trim()) return alert(tr('library.needText'));
    const limit = c.kind === 'template' ? PL.LIMITS.templateText : PL.LIMITS.skillBody;
    if (text.length > limit) return alert(tr('library.textTooLong', { n: limit.toLocaleString() }));
    // 템플릿·스킬은 AI 서비스에 그대로 보내지므로 비밀 정보가 섞이지 않았는지 본다.
    const hits = scanSecrets(text);
    if (hits.length && !confirm(tr('library.secretSave', { what: describeSecrets(hits) }))) return;
    if (c.kind === 'template') {
      if (c.isNew) {
        if (lib.templates.length >= PL.LIMITS.templates) return alert(tr('library.templateLimit', { n: PL.LIMITS.templates }));
        const t = { id: PL.newId('u'), name, hint, text, fav: false };
        lib.templates.push(t);
        ui.sel = t.id;
      } else Object.assign(c.item, { name, hint, text });
    } else if (c.isNew) {
      if (lib.skills.length >= PL.LIMITS.skills) return alert(tr('library.skillLimit', { n: PL.LIMITS.skills }));
      const s = { id: PL.newId('s'), name, description: hint, body: text };
      lib.skills.push(s);
      ui.sel = s.id;
    } else Object.assign(c.item, { name, description: hint, versions: PL.withVersion(c.item, text), body: text }); // 바로 전 본문은 이전 버전으로 (v0.29.0)
    draft = null;
    shown = null;
    await save();
    refreshAll();
    flash($('#libInfo'), tr('library.saved'));
  });

  $('#libCopy').addEventListener('click', () => {
    const c = current();
    if (!c) return;
    const from = { name: $('#libName').value, hint: $('#libHint').value, text: $('#libText').value };
    shown = null; // 복제는 지금 보이는 내용으로 (저장하지 않은 수정도 함께)
    if (c.kind === 'template') editNewTemplate({ name: from.name, hint: from.hint, text: from.text });
    else editNewSkill({ name: tr('library.copyName', { name: from.name }), description: from.hint, body: from.text });
  });

  $('#libDelete').addEventListener('click', async () => {
    const c = current();
    if (!c || c.readonly || c.isNew) return;
    if (!confirm(tr('library.confirmDelete', { name: c.name }))) return;
    if (c.kind === 'template') {
      lib.templates = lib.templates.filter((t) => t !== c.item);
      delete lib.lastVars[c.item.id];
      if (template.id === c.item.id) setTemplate('none');
    } else {
      lib.skills = lib.skills.filter((s) => s !== c.item);
      lib.activeSkills = lib.activeSkills.filter((id) => id !== c.item.id);
    }
    ui.sel = null;
    shown = null;
    await save();
    refreshAll();
  });

  $('#libUse').addEventListener('click', async () => {
    const c = current();
    if (!c || c.isNew) return;
    if (editorDirty() && !confirm(tr('library.useSaved'))) return;
    shown = null;
    if (c.kind === 'template') {
      setTemplate(c.item.id);
      host.setView('panels');
      $('#prompt').focus();
      return;
    }
    await toggleSkill(c.item.id);
  });

  $('#libSkillMode').addEventListener('change', async (e) => {
    lib.skillMode = e.target.value;
    await save();
    refreshAll();
  });

  // ---------- 스킬 옵션 · 압축 권장 기준 ----------

  /** 편집기에서 보고 있는 저장된 스킬에 바로 반영한다 (저장 버튼 없이) */
  async function updateSkill(patch) {
    const c = current();
    if (!c || c.kind !== 'skill' || c.isNew) return;
    const keep = { name: $('#libName').value, hint: $('#libHint').value, text: $('#libText').value };
    const dirty = editorDirty();
    Object.assign(c.item, patch);
    await save();
    refreshAll();
    // 저장하지 않은 편집 내용은 그대로 둔다
    if (dirty && state?.chatView === 'library') {
      $('#libName').value = keep.name;
      $('#libHint').value = keep.hint;
      $('#libText').value = keep.text;
      updateEditorInfo();
    }
  }

  $('#libUseCompact').addEventListener('change', (e) => updateSkill({ useCompact: e.target.value === 'compact' }));
  $('#libDropEx').addEventListener('change', (e) => updateSkill({ dropExamples: e.target.checked }));
  $('#libNoWarn').addEventListener('change', (e) => updateSkill({ noWarn: e.target.checked }));
  $('#libCompactDel').addEventListener('click', () => {
    if (confirm(tr('library.confirmCompactDel'))) updateSkill({ compact: '', compactOf: '', useCompact: true });
  });

  for (const [id, key] of [['#libWarnOne', 'one'], ['#libWarnTotal', 'total']]) {
    $(id).addEventListener('change', async (e) => {
      lib.compressWarn = { ...lib.compressWarn, [key]: Number(e.target.value) };
      await save();
      refreshAll();
    });
  }

  // ---------- AI로 압축 ----------
  // 열린 패널 하나에 압축 요청을 보내고, 답변이 끝나면 패널 화면의 답변 글을 읽어 압축본 칸에 넣는다.
  // 파일로 내려받지 않는다. 미리보기에서 확인·수정한 뒤 "저장"하면 그 스킬 항목의 압축본으로 들어간다 (원문은 그대로).
  // 답변을 기다리는 동안 다른 화면(패널 등)으로 가도 기다리기는 계속된다. 끝나면 압축본 칸에 넣어 두고 알린다.
  // 자동으로 못 읽었거나 답변이 끝난 뒤 패널에서 고쳤으면 "패널에서 다시 읽기"로 지금 답변을 다시 가져온다.

  // skillId: 압축 중인 스킬, panelId: 요청을 보낸 패널, waiting: { id, sent } 답변을 기다리는 중, out: 압축본 칸의 글(화면을 떠나도 유지)
  const cmp = { skillId: null, panelId: null, waiting: null, out: null };
  const LOCAL_ASK = '__local'; // 맡길 AI: 패널 없는 로컬 LLM (v0.29.0)

  const cmpSkill = () => skillById(cmp.skillId);
  const nameOfSvc = (id) => state.services.find((x) => x.id === id)?.name || id;
  const setCmpStatus = (text, kind = '') => {
    $('#cmpStatus').textContent = text;
    $('#cmpStatus').dataset.kind = kind;
  };
  function cmpCount() {
    const s = cmpSkill();
    const out = $('#cmpOut').value.trim();
    const base = s ? PL.cleanSkill(s.body).length : 0;
    const pct = base ? (out.length / base) * 100 : 0;
    $('#cmpOutCount').textContent = out ? tr('library.cmpOutCount', { n: out.length.toLocaleString(), pct: pct > 0 && pct < 1 ? tr('library.pctUnder1') : `${Math.round(pct)}%` }) : '';
    $('#cmpSave').disabled = !out || !!cmp.waiting;
    $('#cmpRun').disabled = !!cmp.waiting || !$('#cmpTarget').value;
    $('#cmpRead').disabled = !!cmp.waiting || !(cmp.panelId || ($('#cmpTarget').value && $('#cmpTarget').value !== LOCAL_ASK));
  }

  $('#libCompress').addEventListener('click', () => {
    const c = current();
    if (!c || c.kind !== 'skill' || c.isNew) return;
    if (editorDirty()) return alert(tr('library.saveFirst'));
    openCompress(c.item.id);
  });

  /** "AI로 압축" 화면 열기: 맡길 AI와 목표 길이를 고르고, 원문과 압축본을 나란히 봅니다. */
  function openCompress(skillId) {
    const s = skillById(skillId);
    if (!s) return;
    // 다른 스킬의 압축 답변을 기다리는 중이면 먼저 끝내야 한다
    if (cmp.waiting && cmp.skillId !== skillId) {
      return alert(tr('library.cmpBusy', { name: skillById(cmp.skillId)?.name || tr('library.otherSkill') }));
    }
    const resume = cmp.skillId === skillId && cmp.out !== null; // 같은 스킬로 돌아왔으면 칸의 글·상태를 그대로
    cmp.skillId = skillId;
    const open = state.services.filter((x) => panels.has(x.id));
    // 로컬 LLM을 켜 두었는데 패널이 없으면 패널 없이 묻는 선택지 (v0.29.0 — 보이는 패널의 대화와 섞이지 않음)
    const localHeadless = state.local?.enabled && !panels.has('local');
    $('#cmpTarget').replaceChildren(...open.map((x) => option(x.id, x.name)), ...(localHeadless ? [option(LOCAL_ASK, t('local.judgeHeadless'))] : []));
    const pick = [cmp.panelId, state.synthTarget].find((id) => id && open.some((x) => x.id === id));
    if (pick) $('#cmpTarget').value = pick;
    const base = PL.cleanSkill(s.body);
    $('#cmpTitle').textContent = s.name;
    $('#cmpSrc').textContent = base;
    $('#cmpSrcCount').textContent = tr('library.cmpSrcCount', { n: base.length.toLocaleString() });
    if (!resume) {
      cmp.panelId = null;
      cmp.out = null;
      $('#cmpLen').value = Math.max(500, Math.min(8000, Math.round((base.length * 0.3) / 100) * 100));
      $('#cmpOut').value = s.compact || '';
      setCmpStatus(open.length || localHeadless ? tr('library.cmpReady') : tr('library.cmpNoPanel'));
    } else $('#cmpOut').value = cmp.out;
    cmpCount();
    host.setView('compress');
  }

  /** 패널이 다 열릴 때까지 기다린다 (새 대화를 연 뒤) */
  async function waitPanelReady(id, ms = 20000) {
    await new Promise((r) => setTimeout(r, 1500));
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (panels.get(id)?.dot.classList.contains('ready')) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /** 압축본 칸에 넣는다. 압축 화면을 보고 있지 않으면 입력창 아래에 알린다 */
  function putCompressed(text, status, kind) {
    cmp.out = text;
    $('#cmpOut').value = text;
    setCmpStatus(status, kind);
    cmpCount();
    if (state?.chatView !== 'compress' && kind === 'ok') {
      $('#sendHint').textContent = tr('library.cmpGotHint', { name: cmpSkill()?.name || tr('library.skill') });
    }
  }

  /** 패널의 지금 최신 답변에서 압축본을 꺼낸다 → 글 | '' */
  // 패널의 최신 답변에서 압축본(코드 상자 안의 글)을 꺼내 압축본 칸에 넣습니다.
  async function readCompressed(id) {
    const got = await host.getAnswers().catch(() => null);
    const a = got?.answers?.find((x) => x.id === id);
    return PL.extractCompressed(a?.md || a?.text || '');
  }

  $('#cmpRun').addEventListener('click', async () => {
    const s = cmpSkill();
    const id = $('#cmpTarget').value;
    if (!s || !id || cmp.waiting) return;
    const target = Math.max(200, Math.min(PL.LIMITS.skillBody, Number($('#cmpLen').value) || 2000));
    const hits = scanSecrets(s.body);
    if (hits.length && !confirm(tr('library.secretSend', { what: describeSecrets(hits), name: nameOfSvc(id) }))) return;
    if (id === LOCAL_ASK) return compressLocal(s, target);
    cmp.waiting = { id, sent: false };
    cmp.panelId = id;
    cmp.out = $('#cmpOut').value;
    cmpCount();
    try {
      if ($('#cmpNew').checked) {
        setCmpStatus(tr('library.cmpNewChat', { name: nameOfSvc(id) }));
        host.panelAction(id, 'newchat');
        await waitPanelReady(id);
      }
      if (!cmp.waiting) return; // 그사이 취소
      setCmpStatus(tr('library.cmpSending', { name: nameOfSvc(id) }));
      const res = await host.sendFollowUp(id, PL.compressRequest(s, target), [], { noHistory: true });
      if (!res?.ok) throw new Error(res?.error || tr('library.sendFailed'));
      if (cmp.waiting) cmp.waiting.sent = true;
      setCmpStatus(tr('library.cmpWaiting', { name: nameOfSvc(id) }));
    } catch (err) {
      cmp.waiting = null;
      setCmpStatus(tr('library.cmpFailed', { error: err.message }), 'error');
    }
    cmpCount();
  });

  /**
   * 패널 없이 로컬 LLM에 압축 부탁 (v0.29.0): 임시 대화로 묻고 답에서 압축본을 꺼낸다.
   * 요청 글이 로컬 모델 컨텍스트 한도를 넘을 것 같으면 먼저 묻는다 (설정 › 로컬 LLM › 컨텍스트 한도).
   */
  async function compressLocal(s, target) {
    const req = PL.compressRequest(s, target);
    const c = MLA.sendPlan.contextCheck(req, state.local?.contextTokens);
    if (c.over && !confirm(t('local.ctxConfirm', { n: c.tokens.toLocaleString(), max: c.limit.toLocaleString() }))) return;
    cmp.waiting = { id: LOCAL_ASK, sent: true };
    cmp.panelId = null;
    cmp.out = $('#cmpOut').value;
    cmpCount();
    setCmpStatus(t('local.compressing'));
    const r = await host.local.ask(req).catch((err) => ({ ok: false, error: err.message }));
    cmp.waiting = null;
    if (!r?.ok) {
      setCmpStatus(tr('library.cmpFailed', { error: r?.error || '' }), 'error');
      return cmpCount();
    }
    putCompressed(PL.extractCompressed(r.text), tr('library.cmpGot'), 'ok');
  }

  // renderer.js가 패널 상태가 바뀔 때마다 알려 준다 (압축 화면을 보고 있지 않아도)
  window.onLibPanelStatus = async (id, { answer }) => {
    const w = cmp.waiting;
    if (!w || w.id !== id || !w.sent || !['done', 'timeout', 'no-answer'].includes(answer)) return;
    cmp.waiting = null;
    if (answer !== 'done') {
      setCmpStatus(tr('library.cmpNotDone', { why: answer === 'timeout' ? tr('library.timeout') : tr('library.noAnswer') }), 'error');
      return cmpCount();
    }
    const text = await readCompressed(id);
    if (!text) {
      setCmpStatus(tr('library.cmpReadFailed'), 'error');
      return cmpCount();
    }
    putCompressed(text, tr('library.cmpGot'), 'ok');
  };

  // 자동으로 못 가져왔을 때 · 답변이 끝난 뒤 다시 가져올 때
  $('#cmpRead').addEventListener('click', async () => {
    const id = cmp.panelId || $('#cmpTarget').value;
    if (!id || cmp.waiting) return;
    const text = await readCompressed(id);
    if (!text) return setCmpStatus(tr('library.cmpNothing', { name: nameOfSvc(id) }), 'error');
    if ($('#cmpOut').value.trim() && $('#cmpOut').value.trim() !== text && !confirm(tr('library.cmpReplace'))) return;
    putCompressed(text, tr('library.cmpGotLatest', { name: nameOfSvc(id) }), 'ok');
  });

  $('#cmpOut').addEventListener('input', () => {
    cmp.out = $('#cmpOut').value;
    cmpCount();
  });
  $('#cmpTarget').addEventListener('change', cmpCount);

  $('#cmpSave').addEventListener('click', async () => {
    const s = cmpSkill();
    const text = $('#cmpOut').value.trim();
    if (!s || !text) return;
    if (text.length > PL.LIMITS.skillBody) return alert(tr('library.compactTooLong', { n: PL.LIMITS.skillBody.toLocaleString() }));
    const hits = scanSecrets(text);
    if (hits.length && !confirm(tr('library.secretCompact', { what: describeSecrets(hits) }))) return;
    Object.assign(s, { compact: text, compactOf: PL.textHash(s.body), useCompact: true });
    await save();
    const sid = s.id;
    Object.assign(cmp, { skillId: null, panelId: null, waiting: null, out: null });
    refreshAll(); // skill: 합계도 압축본 길이로
    openLibrary('skills', sid);
    flash($('#libInfo'), tr('library.compactSaved'));
  });

  // 돌아가도 기다리기는 계속된다 (다시 "AI로 압축"을 누르면 이어서 봄)
  $('#cmpClose').addEventListener('click', () => openLibrary('skills', cmp.skillId));

  // ---------- 파일 가져오기 · 내보내기 ----------

  // 글을 파일로 내려받게 합니다 (내보내기: .json, SKILL.md).
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';

  $('#libExportMd').addEventListener('click', () => {
    const c = current();
    if (c?.kind === 'skill' && c.item) download(`${safeName(c.item.name)}.SKILL.md`, PL.toSkillMd(c.item), 'text/markdown');
  });

  $('#libShare').addEventListener('click', () => {
    const c = current();
    if (c?.item && !c.readonly && !c.isNew) window.shareLibraryItem(c.kind, c.item.id, $('#libShare'));
  });

  $('#libExport').addEventListener('click', () => {
    if (!lib.templates.length && !lib.skills.length && !lib.presets.length) return alert(tr('library.nothingToExport'));
    download(`multitude-llm-library-${new Date().toISOString().slice(0, 10)}.json`, PL.exportLibrary(lib), 'application/json');
  });

  $('#libImport').addEventListener('click', () => $('#libImportFile').click());

  async function readSmallText(file) {
    if (file.size > PL.LIMITS.skillFileBytes * 20) throw new Error(tr('library.fileTooBig'));
    return file.text();
  }

  $('#libImportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await readSmallText(file);
      // 설정 옮기기 · 하나만 공유 파일(.mla.json)이면 그 확인 창으로 (겹치는 항목은 덮어쓰기 / 둘 다 남기기)
      if (/"kind"\s*:\s*"multitude-llm-settings(-encrypted)?"/.test(text.slice(0, 2000)) && window.openTransferText) return window.openTransferText(text, file.name);
      const got = PL.importLibrary(text);
      const room = { t: PL.LIMITS.templates - lib.templates.length, s: PL.LIMITS.skills - lib.skills.length };
      const t = got.templates.slice(0, Math.max(0, room.t));
      const s = got.skills.slice(0, Math.max(0, room.s));
      const pr = got.presets.slice(0, Math.max(0, PL.LIMITS.presets - lib.presets.length)); // 프리셋 (v0.29.0)
      if (!confirm(tr('library.confirmImport', { t: t.length, s: s.length, presets: pr.length ? `\n- ${MLA.i18n.t('preset.importCount', { n: pr.length })}` : '', over: t.length < got.templates.length || s.length < got.skills.length ? tr('library.importOver') : '' }))) return;
      lib.templates.push(...t);
      lib.skills.push(...s);
      lib.presets.push(...pr);
      await save();
      refreshAll();
    } catch (err) {
      alert(tr('library.importFailed', { error: err.message }));
    }
  });

  $('#libSkillFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const added = [];
    const skipped = [];
    for (const f of files) {
      if (f.size > PL.LIMITS.skillFileBytes) {
        skipped.push(`${f.name}: ${tr('library.skipBig')}`);
        continue;
      }
      const s = PL.parseSkillMd(await f.text(), f.name.replace(/(\.skill)?\.(md|txt|markdown)$/i, ''));
      if (!s) skipped.push(`${f.name}: ${tr('library.skipEmpty')}`);
      else if (lib.skills.length + added.length >= PL.LIMITS.skills) skipped.push(`${f.name}: ${tr('library.skipLimit', { n: PL.LIMITS.skills })}`);
      else added.push({ id: PL.newId('s'), ...s });
    }
    const secret = added.filter((s) => scanSecrets(s.body).length).map((s) => s.name);
    if (secret.length && !confirm(tr('library.secretImport', { names: secret.join(', ') }))) return;
    lib.skills.push(...added);
    if (added.length) {
      ui.sel = added[added.length - 1].id;
      await save();
      refreshAll();
    }
    if (skipped.length) alert(tr('library.skippedFiles', { list: skipped.join('\n') }));
  });

  // ---------- 시작 · 상태 ----------

  // 템플릿 목록·스킬 칩·라이브러리 화면을 한꺼번에 다시 그립니다.
  function refreshAll() {
    if (!findTpl(template.id)) template = TEMPLATES[0];
    renderTplSelect();
    setTemplate(template.id);
    renderSkillBar();
    window.libPresets?.refresh(); // 입력창 옆 프리셋 고르기 (v0.29.0)
    if (state?.chatView === 'library') renderLibrary();
  }

  // 프리셋 · 스킬 이전 버전 · 설정 옮기기 (v0.29.0, library-presets.js · settings-transfer-ui.js)가 쓰는 창구
  window.libApi = {
    get: () => lib,
    set: (next) => (lib = PL.normalizeLibrary(next)),
    save,
    refreshAll,
    openLibrary,
    renderLibrary,
    templateId: () => template.id,
    setTemplate,
    hasTemplate: (id) => !!findTpl(id),
    templateName: (id) => findTpl(id)?.name || '',
    skillById,
    editorDirty,
    select,
    clearDraft: () => {
      draft = null;
      shown = null;
    },
  };

  host.on('state', () => {
    // 변수 입력 화면을 떠나면(Esc · 다른 화면) 보내기를 취소한다
    if (varsWait && state.chatView !== 'vars') finishVars(false);
    if (state.chatView !== 'library') draft = null;
    $('#libraryBtn').classList.toggle('active', state.chatView === 'library');
  });
  // 언어를 바꾸면 (v0.30.0) 고르기 목록 · 스킬 줄 · 라이브러리 화면을 새 언어로 다시 그린다 (입력한 변수 값은 그대로)
  document.addEventListener('mla:lang', () => {
    renderTplSelect();
    renderSkillBar();
    window.libPresets?.refresh();
    if (state?.chatView === 'library') renderLibrary();
  });

  (async () => {
    lib = await host.library.load().catch(() => PL.normalizeLibrary({}));
    let saved = null;
    try {
      saved = localStorage.getItem(TPL_KEY);
    } catch {}
    template = findTpl(saved) || TEMPLATES[0];
    refreshAll();
  })();
})();
