'use strict';

// 프롬프트 라이브러리(변수 있는 내 템플릿)와 스킬 화면.
// renderer.js · project.js 다음에 읽힌다 ($, state, host, button, span, flash는 renderer.js의 것).
// 저장은 host.library (Windows 앱: 앱 데이터 폴더 library.json / 크롬 확장: 확장 저장소), 처리는 MLA.promptLib.
//
// - 템플릿: 기본 템플릿(templates.js, 고칠 수 없음 — 복제해서 고침) + 내 템플릿. 변수가 있으면 보낼 때 "변수 입력" 화면을 띄운다.
// - 스킬: 고른 스킬의 지침을 각 패널의 새 대화 첫 질문(또는 매 질문) 앞에 붙여 보낸다.
//   패널마다 이 대화에 어떤 스킬을 보냈는지 기억하고, 새 대화(＋ · ⌂ · 모두 새 대화)를 열면 잊는다.

(() => {
  const PL = MLA.promptLib;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
  const TPL_KEY = 'mla.template'; // 마지막에 고른 템플릿 (이 PC에만 저장)
  const MODE_TEXT = { first: '새 대화 첫 질문에만', every: '매 질문마다' };

  let lib = PL.normalizeLibrary({});
  let template = TEMPLATES[0];
  const skillSent = new Map(); // 패널 id -> 이 대화에 보낸 스킬 id 목록 (순서대로)
  const ui = { tab: 'templates', sel: null }; // 라이브러리 화면: 보고 있는 탭과 고른 항목 id

  const builtinTpl = (id) => TEMPLATES.find((t) => t.id === id);
  const userTpl = (id) => lib.templates.find((t) => t.id === id);
  const findTpl = (id) => builtinTpl(id) || userTpl(id);

  async function save() {
    lib = PL.normalizeLibrary(lib);
    const ok = await host.library.save(lib).catch(() => false);
    if (!ok) alert('라이브러리를 저장하지 못했습니다');
  }

  // ---------- 템플릿 고르기 (입력창 왼쪽) ----------

  function option(value, text) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  }

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
      ...(mine.length ? [group('내 템플릿', mine)] : []),
      group('기본 템플릿', TEMPLATES.slice(1).map((t) => option(t.id, t.name))),
      option('__library', '📚 라이브러리 열기…'),
    );
    $('#tplSelect').value = template.id;
  }

  function setTemplate(id) {
    template = findTpl(id) || TEMPLATES[0];
    $('#tplSelect').value = template.id;
    $('#tplSelect').classList.toggle('on', template.id !== 'none');
    $('#prompt').placeholder = template.hint || '모든 AI에게 한 번에 물어보기';
    // 템플릿이 질문을 어떻게 감싸는지 한 줄로 보여 준다. 변수는 〈이름〉으로.
    const vars = PL.parseVars(template.text);
    $('#tplPreview').textContent =
      template.id === 'none' ? '' : `${vars.length ? `변수 ${vars.length}개 · ` : ''}${template.text.replace(/\n+/g, ' ').replace('{q}', '〈입력〉')}`;
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
        field.placeholder = v.def ? `비우면: ${v.def}` : '';
        field.spellcheck = false;
      }
      field.dataset.var = v.name;
      field.addEventListener('input', updateVarsPreview);
      field.addEventListener('change', updateVarsPreview);
      row.append(span('var-name', v.name), field);
      return row;
    });
    $('#varsFields').replaceChildren(...rows);
    $('#varsQ').textContent = q ? `입력창 내용 ${q.length.toLocaleString()}자는 {q} 자리에 들어갑니다` : '';
    updateVarsPreview();
  }

  function updateVarsPreview() {
    if (!varsWait) return;
    const { tpl, q, builtins } = varsWait;
    $('#varsPreview').textContent = PL.fillTemplate(tpl.text, q.length > 300 ? `${q.slice(0, 300)}…` : q, varValues(), builtins);
  }

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
    if (s.compact && PL.compactStale(s)) return { text: `⚠ 압축본이 원문보다 오래됨 · ${len.toLocaleString()}자`, level: 'stale' };
    if (s.compact && s.useCompact) return { text: `✓ 압축본 ${len.toLocaleString()}자 (원문 ${s.body.length.toLocaleString()}자)`, level: 'compact' };
    const level = s.noWarn ? 'none' : PL.compressLevel(len, lib.compressWarn, lib.skillMode);
    const label = { warn: '🟡 압축 권장 · ', strong: '🟠 압축 강력 권장 · ' }[level] || '';
    return { text: `${label}${len.toLocaleString()}자`, level };
  }

  function renderSkillBar() {
    const active = activeList();
    const { len } = PL.prefixSize(active);
    const L = PL.warnLimits(lib.compressWarn, lib.skillMode);
    const btn = $('#skillBtn');
    btn.textContent = active.length === 0 ? '🧩 스킬 없음' : active.length === 1 ? `🧩 ${active[0].name}` : `🧩 스킬 ${active.length}개`;
    btn.classList.toggle('on', active.length > 0);
    btn.classList.toggle('warn', len >= L.total);
    btn.title = active.length
      ? `${active.map((s, i) => `${CIRCLED[i]} ${s.name}`).join('\n')}\n합계 ${len.toLocaleString()} / ${PL.LIMITS.prefixTotal.toLocaleString()}자 · ${MODE_TEXT[lib.skillMode]}${len >= L.total ? '\n합계가 길어요 — 압축본을 쓰면 줄일 수 있습니다' : ''}`
      : '고른 스킬(최대 3개)의 지침을 질문 앞에 붙여 보냅니다';
    const chips = lib.skills.map((s) => {
      const at = lib.activeSkills.indexOf(s.id);
      const b = badgeOf(s);
      const chip = button(`${at >= 0 ? `${CIRCLED[at]} ` : ''}${s.name}`, `${s.description || s.name}\n${b.text}`, () => toggleSkill(s.id));
      chip.className = `skill-chip-btn${at >= 0 ? ' on' : ''} lv-${b.level}`;
      chip.disabled = at < 0 && lib.activeSkills.length >= PL.LIMITS.activeSkills;
      return chip;
    });
    $('#skillChips').replaceChildren(...(chips.length ? chips : [span('muted-label', '스킬이 없습니다 — 📚 관리에서 만들거나 SKILL.md를 가져오세요')]));
    $('#skillTotal').textContent = `${lib.activeSkills.length}/${PL.LIMITS.activeSkills} · 합계 ${len.toLocaleString()} / ${PL.LIMITS.prefixTotal.toLocaleString()}자`;
    $('#skillTotal').classList.toggle('warn', len >= L.total);
  }

  /** 스킬 켜기/끄기 (켜면 맨 뒤 = 가장 낮은 우선순위) */
  async function toggleSkill(id) {
    const s = skillById(id);
    if (!s) return;
    const at = lib.activeSkills.indexOf(id);
    if (at >= 0) lib.activeSkills.splice(at, 1);
    else {
      if (lib.activeSkills.length >= PL.LIMITS.activeSkills) return alert(`스킬은 ${PL.LIMITS.activeSkills}개까지 함께 켤 수 있습니다. 먼저 다른 스킬을 끄세요.`);
      if (badgeOf(s).level === 'strong') {
        const ok = confirm(
          `${s.name}의 보내는 글이 ${PL.sendBody(s).length.toLocaleString()}자입니다. 압축을 강력 권장합니다 (라이브러리 → AI로 압축).\n\n확인: 그대로 켜기 (이 스킬은 다시 알리지 않음)\n취소: 켜지 않기`,
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
    $('#sendHint').textContent = '스킬을 바꿨습니다 — 다음 질문에 바뀐 점만 알립니다. 새 대화를 열면 가장 깔끔하게 적용됩니다';
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
        alert(`켠 스킬의 지침이 너무 깁니다 (${len.toLocaleString()} / ${PL.LIMITS.prefixTotal.toLocaleString()}자).\n스킬을 끄거나 라이브러리에서 압축본을 만들어 쓰세요.`);
        return { cancel: true };
      }
      if (!totalAlerted && len >= PL.warnLimits(lib.compressWarn, lib.skillMode).totalAlert) {
        const tips = active
          .filter((s) => !(s.compact && s.useCompact))
          .map((s) => `- ${s.name}: ${PL.sendBody(s).length.toLocaleString()}자`)
          .join('\n');
        const ok = confirm(`켠 스킬의 지침 합계가 ${len.toLocaleString()}자입니다. 질문마다 이만큼 함께 보내므로 압축을 권장합니다.\n${tips ? `\n압축본이 없는 스킬:\n${tips}\n` : ''}\n확인: 그대로 보내기 (이번 실행 동안 다시 묻지 않음)\n취소: 보내지 않기`);
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
    return row;
  }

  function renderLibrary() {
    for (const b of document.querySelectorAll('[data-libtab]')) b.classList.toggle('active', b.dataset.libtab === ui.tab);
    $('#libMode').hidden = ui.tab !== 'skills';
    $('#libWarn').hidden = ui.tab !== 'skills';
    $('#libSkillMode').value = lib.skillMode;
    $('#libWarnOne').value = lib.compressWarn.one;
    $('#libWarnTotal').value = lib.compressWarn.total;
    const list = [];
    if (ui.tab === 'templates') {
      list.push(button('＋ 새 템플릿', '빈 템플릿을 만듭니다', () => editNewTemplate()));
      list.push(span('lib-group', `내 템플릿 ${lib.templates.length}개`));
      for (const t of [...lib.templates].sort((a, b) => b.fav - a.fav)) {
        const star = button(t.fav ? '★' : '☆', t.fav ? '즐겨찾기 해제' : '즐겨찾기 (템플릿 목록 맨 위에)', (e) => {
          e.stopPropagation();
          t.fav = !t.fav;
          save().then(refreshAll);
        });
        star.className = 'lib-star';
        list.push(listRow(t.name, varsSummary(t.text), ui.sel === t.id, () => select(t.id), [star]));
      }
      list.push(span('lib-group', '기본 템플릿 (복제해서 고칠 수 있음)'));
      for (const t of TEMPLATES.slice(1)) list.push(listRow(`🔒 ${t.name}`, varsSummary(t.text), ui.sel === t.id, () => select(t.id)));
    } else {
      list.push(button('＋ 새 스킬', '빈 스킬을 만듭니다', () => editNewSkill()));
      list.push(button('SKILL.md 가져오기', '.md 파일에서 스킬을 가져옵니다 (맨 위 --- 사이에 name · description)', () => $('#libSkillFile').click()));
      // 켠 스킬: 순서가 우선순위 (▲▼로 바꿈)
      const active = activeList();
      list.push(span('lib-group', `켠 스킬 ${active.length}/${PL.LIMITS.activeSkills} — 위에 있는 것이 우선 · 합계 ${PL.prefixSize(active).len.toLocaleString()}자`));
      active.forEach((s, i) => {
        const move = (d) => (e) => {
          e.stopPropagation();
          const arr = lib.activeSkills;
          const j = i + d;
          if (j < 0 || j >= arr.length) return;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          save().then(refreshAll);
        };
        const up = button('▲', '우선순위 올리기', move(-1));
        const down = button('▼', '우선순위 내리기', move(1));
        const off = button('끄기', '이 스킬 끄기', (e) => {
          e.stopPropagation();
          toggleSkill(s.id);
        });
        for (const b of [up, down, off]) b.className = 'lib-mini';
        up.disabled = i === 0;
        down.disabled = i === active.length - 1;
        list.push(listRow(`${CIRCLED[i]} ${s.name}`, badgeOf(s).text, ui.sel === s.id, () => select(s.id), [up, down, off]));
      });
      list.push(span('lib-group', `스킬 ${lib.skills.length}개`));
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
    return vars.length ? `변수: ${vars.map((v) => v.name).join(', ')}` : '변수 없음';
  };

  function select(id) {
    if (editorDirty() && !confirm('저장하지 않은 수정 내용을 버릴까요?')) return;
    ui.sel = id;
    renderLibrary();
  }

  // 편집기: 고른 항목을 보여 주고 고친다. draft는 아직 저장하지 않은 새 항목.
  let draft = null;
  let shown = null; // 편집기에 넣은 처음 값 (고쳤는지 비교)

  function editNewTemplate(from) {
    if (editorDirty() && !confirm('저장하지 않은 수정 내용을 버릴까요?')) return;
    draft = { kind: 'template', name: from ? `${from.name} (복사)` : '', hint: from?.hint || '', text: from?.text || '{q}' };
    ui.sel = null;
    renderLibrary();
    $('#libName').focus();
  }

  function editNewSkill(from) {
    if (editorDirty() && !confirm('저장하지 않은 수정 내용을 버릴까요?')) return;
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

  function renderEditor() {
    const c = current();
    const ed = $('#libEditor');
    ed.hidden = !c;
    $('#libEmpty').hidden = !!c;
    $('#libEmpty').textContent =
      ui.tab === 'templates'
        ? '왼쪽에서 템플릿을 고르거나 ＋ 새 템플릿을 누르세요.'
        : '왼쪽에서 스킬을 고르거나 ＋ 새 스킬 / SKILL.md 가져오기를 누르세요.';
    if (!c) {
      shown = null;
      return;
    }
    const isTpl = c.kind === 'template';
    $('#libHintLabel').textContent = isTpl ? '안내 문구 (입력창에 보임)' : '설명';
    $('#libTextLabel').textContent = isTpl ? '내용 — {q}: 입력창 내용 · {{이름}} · {{이름|기본값}} · {{이름:가,나,다}} · {{오늘}} {{프로젝트}} {{선택 파일}}' : '지침 본문 (질문 앞에 붙여 보냄)';
    $('#libName').value = c.name;
    $('#libHint').value = c.hint;
    $('#libText').value = c.text;
    for (const el of [$('#libName'), $('#libHint'), $('#libText')]) el.readOnly = !!c.readonly;
    shown = { name: c.name, hint: c.hint, text: c.text };
    $('#libSave').hidden = !!c.readonly;
    $('#libDelete').hidden = !!c.readonly || !!c.isNew;
    $('#libCopy').hidden = !!c.isNew;
    $('#libCopy').textContent = c.readonly ? '복제해서 고치기' : '복제';
    $('#libExportMd').hidden = isTpl || !!c.isNew;
    $('#libUse').hidden = !!c.isNew;
    $('#libUse').textContent = isTpl ? '이 템플릿 쓰기' : lib.activeSkills.includes(c.item?.id) ? '이 스킬 끄기' : '이 스킬 켜기';
    // 스킬 전용: 보내는 글 고르기 · 예시 절 빼기 · 알림 끄기 · AI로 압축
    const sk = !isTpl && !c.isNew ? c.item : null;
    $('#libSkillOpts').hidden = !sk;
    if (sk) {
      $('#libUseCompact').value = sk.compact && sk.useCompact ? 'compact' : 'body';
      $('#libUseCompact').disabled = !sk.compact;
      $('#libDropEx').checked = sk.dropExamples;
      $('#libNoWarn').checked = sk.noWarn;
      $('#libCompactDel').hidden = !sk.compact;
      $('#libCompress').textContent = sk.compact ? 'AI로 다시 압축' : 'AI로 압축';
    }
    updateEditorInfo();
  }

  function updateEditorInfo() {
    const c = current();
    if (!c) return;
    const text = $('#libText').value;
    if (c.kind === 'template') {
      const vars = PL.parseVars(text);
      $('#libInfo').dataset.level = '';
      $('#libInfo').textContent = `${vars.length ? `변수 ${vars.length}개: ${vars.map((v) => (v.choices ? `${v.name}(${v.choices.join('/')})` : v.def ? `${v.name}=${v.def}` : v.name)).join(', ')}` : '변수 없음'}${text.includes('{q}') ? '' : ' · {q}가 없어 입력창 내용은 맨 뒤에 붙습니다'}`;
    } else {
      // 보내는 글 길이 (저장한 스킬이면 압축본·정리 설정을 반영, 새 스킬이면 지금 입력한 글을 정리한 길이)
      const sk = c.isNew ? null : c.item;
      const probe = sk ? { ...sk, body: text } : { body: text, compact: '', useCompact: false, dropExamples: false };
      const len = PL.sendBody(probe).length;
      const level = sk?.noWarn ? 'none' : PL.compressLevel(len, lib.compressWarn, lib.skillMode);
      const L = PL.warnLimits(lib.compressWarn, lib.skillMode);
      const advice = { warn: ` — ${L.one.toLocaleString()}자 이상은 압축을 권장합니다`, strong: ` — ${L.strong.toLocaleString()}자 이상: 압축을 강력 권장합니다` }[level] || '';
      const compactNote = sk?.compact ? (PL.compactStale({ ...sk, body: text }) ? ' · ⚠ 압축본이 원문보다 오래됨' : ` · 압축본 ${sk.compact.length.toLocaleString()}자`) : '';
      $('#libInfo').textContent = `원문 ${text.length.toLocaleString()} / ${PL.LIMITS.skillBody.toLocaleString()}자 · 보내는 글 ${len.toLocaleString()}자${advice}${compactNote} · ${MODE_TEXT[lib.skillMode]}`;
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
    if (!name) return alert('이름을 입력하세요');
    if (!text.trim()) return alert('내용을 입력하세요');
    const limit = c.kind === 'template' ? PL.LIMITS.templateText : PL.LIMITS.skillBody;
    if (text.length > limit) return alert(`내용이 너무 깁니다 (${limit.toLocaleString()}자까지)`);
    // 템플릿·스킬은 AI 서비스에 그대로 보내지므로 비밀 정보가 섞이지 않았는지 본다.
    const hits = scanSecrets(text);
    if (hits.length && !confirm(`비밀 정보로 보이는 문자열이 있습니다: ${describeSecrets(hits)}\n이 내용은 질문과 함께 AI 서비스로 보내집니다. 그래도 저장할까요?`)) return;
    if (c.kind === 'template') {
      if (c.isNew) {
        if (lib.templates.length >= PL.LIMITS.templates) return alert(`템플릿은 ${PL.LIMITS.templates}개까지 저장할 수 있습니다`);
        const t = { id: PL.newId('u'), name, hint, text, fav: false };
        lib.templates.push(t);
        ui.sel = t.id;
      } else Object.assign(c.item, { name, hint, text });
    } else if (c.isNew) {
      if (lib.skills.length >= PL.LIMITS.skills) return alert(`스킬은 ${PL.LIMITS.skills}개까지 저장할 수 있습니다`);
      const s = { id: PL.newId('s'), name, description: hint, body: text };
      lib.skills.push(s);
      ui.sel = s.id;
    } else Object.assign(c.item, { name, description: hint, body: text });
    draft = null;
    shown = null;
    await save();
    refreshAll();
    flash($('#libInfo'), '저장했습니다');
  });

  $('#libCopy').addEventListener('click', () => {
    const c = current();
    if (!c) return;
    const from = { name: $('#libName').value, hint: $('#libHint').value, text: $('#libText').value };
    shown = null; // 복제는 지금 보이는 내용으로 (저장하지 않은 수정도 함께)
    if (c.kind === 'template') editNewTemplate({ name: from.name, hint: from.hint, text: from.text });
    else editNewSkill({ name: `${from.name} (복사)`, description: from.hint, body: from.text });
  });

  $('#libDelete').addEventListener('click', async () => {
    const c = current();
    if (!c || c.readonly || c.isNew) return;
    if (!confirm(`${c.name}을(를) 지울까요?`)) return;
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
    if (editorDirty() && !confirm('저장하지 않은 수정 내용이 있습니다. 저장한 내용으로 쓸까요?')) return;
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
    if (confirm('압축본을 지울까요? (원문은 그대로입니다)')) updateSkill({ compact: '', compactOf: '', useCompact: true });
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

  const cmp = { skillId: null, waiting: null }; // waiting: { id, sent } 답변을 기다리는 패널

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
    $('#cmpOutCount').textContent = out ? `${out.length.toLocaleString()}자 · 원문의 ${pct > 0 && pct < 1 ? '1% 미만' : `${Math.round(pct)}%`}` : '';
    $('#cmpSave').disabled = !out || !!cmp.waiting;
  }

  $('#libCompress').addEventListener('click', () => {
    const c = current();
    if (!c || c.kind !== 'skill' || c.isNew) return;
    if (editorDirty()) return alert('먼저 원문 수정 내용을 저장하세요 (저장한 원문으로 압축합니다)');
    openCompress(c.item.id);
  });

  function openCompress(skillId) {
    const s = skillById(skillId);
    if (!s) return;
    cmp.skillId = skillId;
    cmp.waiting = null;
    const open = state.services.filter((x) => panels.has(x.id));
    $('#cmpTarget').replaceChildren(...open.map((x) => option(x.id, x.name)));
    if (open.some((x) => x.id === state.synthTarget)) $('#cmpTarget').value = state.synthTarget;
    const base = PL.cleanSkill(s.body);
    $('#cmpTitle').textContent = s.name;
    $('#cmpSrc').textContent = base;
    $('#cmpSrcCount').textContent = `${base.length.toLocaleString()}자 (정리 후)`;
    $('#cmpLen').value = Math.max(500, Math.min(8000, Math.round((base.length * 0.3) / 100) * 100));
    $('#cmpOut').value = s.compact || '';
    $('#cmpRun').disabled = !open.length;
    setCmpStatus(open.length ? '압축을 맡길 AI와 목표 길이를 고르고 "압축 요청"을 누르세요' : '열린 패널이 없습니다 — 압축본을 직접 붙여 넣을 수도 있습니다');
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

  $('#cmpRun').addEventListener('click', async () => {
    const s = cmpSkill();
    const id = $('#cmpTarget').value;
    if (!s || !id || cmp.waiting) return;
    const target = Math.max(200, Math.min(PL.LIMITS.skillBody, Number($('#cmpLen').value) || 2000));
    const hits = scanSecrets(s.body);
    if (hits.length && !confirm(`지침에 비밀 정보로 보이는 문자열이 있습니다: ${describeSecrets(hits)}\n그래도 ${nameOfSvc(id)}에 보낼까요?`)) return;
    cmp.waiting = { id, sent: false };
    $('#cmpRun').disabled = true;
    cmpCount();
    try {
      if ($('#cmpNew').checked) {
        setCmpStatus(`${nameOfSvc(id)}에서 새 대화를 여는 중…`);
        host.panelAction(id, 'newchat');
        await waitPanelReady(id);
      }
      if (!cmp.waiting) return; // 그사이 취소
      setCmpStatus(`${nameOfSvc(id)}에 압축을 요청하는 중…`);
      const res = await host.sendFollowUp(id, PL.compressRequest(s, target), [], { noHistory: true });
      if (!res?.ok) throw new Error(res?.error || '보내지 못했습니다');
      if (cmp.waiting) cmp.waiting.sent = true;
      setCmpStatus(`${nameOfSvc(id)}의 답변을 기다리는 중… (끝나면 아래에 자동으로 넣습니다)`);
    } catch (err) {
      cmp.waiting = null;
      $('#cmpRun').disabled = false;
      setCmpStatus(`압축을 요청하지 못했습니다: ${err.message}`, 'error');
      cmpCount();
    }
  });

  // renderer.js가 패널 상태가 바뀔 때마다 알려 준다
  window.onLibPanelStatus = async (id, { answer }) => {
    const w = cmp.waiting;
    if (!w || w.id !== id || !w.sent || !['done', 'timeout', 'no-answer'].includes(answer)) return;
    cmp.waiting = null;
    $('#cmpRun').disabled = false;
    if (answer !== 'done') {
      setCmpStatus(`압축 결과를 읽지 못했습니다 (${answer === 'timeout' ? '시간 초과' : '답변이 시작되지 않음'}) — 패널에서 직접 복사해 아래에 붙여 넣을 수 있습니다`, 'error');
      return cmpCount();
    }
    const got = await host.getAnswers().catch(() => null);
    const a = got?.answers?.find((x) => x.id === id);
    const text = PL.extractCompressed(a?.md || a?.text || '');
    if (!text) {
      setCmpStatus('답변이 비어 있습니다 — 패널에서 직접 복사해 붙여 넣을 수 있습니다', 'error');
      return cmpCount();
    }
    $('#cmpOut').value = text;
    setCmpStatus('압축본을 읽어 왔습니다 — 빠진 규칙이 없는지 확인하고 저장하세요', 'ok');
    cmpCount();
  };

  $('#cmpOut').addEventListener('input', cmpCount);

  $('#cmpSave').addEventListener('click', async () => {
    const s = cmpSkill();
    const text = $('#cmpOut').value.trim();
    if (!s || !text) return;
    if (text.length > PL.LIMITS.skillBody) return alert(`압축본이 너무 깁니다 (${PL.LIMITS.skillBody.toLocaleString()}자까지)`);
    const hits = scanSecrets(text);
    if (hits.length && !confirm(`압축본에 비밀 정보로 보이는 문자열이 있습니다: ${describeSecrets(hits)}\n그래도 저장할까요?`)) return;
    Object.assign(s, { compact: text, compactOf: PL.textHash(s.body), useCompact: true });
    await save();
    const sid = s.id;
    cmp.skillId = null;
    refreshAll(); // 🧩 합계도 압축본 길이로
    openLibrary('skills', sid);
    flash($('#libInfo'), '압축본을 저장했습니다 (보낼 때 압축본을 씁니다)');
  });

  $('#cmpClose').addEventListener('click', () => {
    if (cmp.waiting && !confirm('압축 답변을 기다리는 중입니다. 그만두고 돌아갈까요?')) return;
    cmp.waiting = null;
    openLibrary('skills', cmp.skillId);
  });

  // ---------- 파일 가져오기 · 내보내기 ----------

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

  $('#libExport').addEventListener('click', () => {
    if (!lib.templates.length && !lib.skills.length) return alert('내보낼 내 템플릿·스킬이 없습니다');
    download(`multitude-llm-library-${new Date().toISOString().slice(0, 10)}.json`, PL.exportLibrary(lib), 'application/json');
  });

  $('#libImport').addEventListener('click', () => $('#libImportFile').click());

  async function readSmallText(file) {
    if (file.size > PL.LIMITS.skillFileBytes * 20) throw new Error('파일이 너무 큽니다');
    return file.text();
  }

  $('#libImportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const got = PL.importLibrary(await readSmallText(file));
      const room = { t: PL.LIMITS.templates - lib.templates.length, s: PL.LIMITS.skills - lib.skills.length };
      const t = got.templates.slice(0, Math.max(0, room.t));
      const s = got.skills.slice(0, Math.max(0, room.s));
      if (!confirm(`가져올까요?\n- 템플릿 ${t.length}개\n- 스킬 ${s.length}개${t.length < got.templates.length || s.length < got.skills.length ? '\n(저장 한도를 넘는 것은 뺍니다)' : ''}\n\n가져온 지침은 질문과 함께 AI 서비스로 보내지므로, 믿을 수 있는 파일인지 확인하세요.`)) return;
      lib.templates.push(...t);
      lib.skills.push(...s);
      await save();
      refreshAll();
    } catch (err) {
      alert(`가져오지 못했습니다: ${err.message}`);
    }
  });

  $('#libSkillFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const added = [];
    const skipped = [];
    for (const f of files) {
      if (f.size > PL.LIMITS.skillFileBytes) {
        skipped.push(`${f.name}: 100KB 초과`);
        continue;
      }
      const s = PL.parseSkillMd(await f.text(), f.name.replace(/(\.skill)?\.(md|txt|markdown)$/i, ''));
      if (!s) skipped.push(`${f.name}: 지침 본문이 없음`);
      else if (lib.skills.length + added.length >= PL.LIMITS.skills) skipped.push(`${f.name}: 스킬 ${PL.LIMITS.skills}개 한도`);
      else added.push({ id: PL.newId('s'), ...s });
    }
    const secret = added.filter((s) => scanSecrets(s.body).length).map((s) => s.name);
    if (secret.length && !confirm(`비밀 정보로 보이는 문자열이 있는 스킬: ${secret.join(', ')}\n그래도 가져올까요?`)) return;
    lib.skills.push(...added);
    if (added.length) {
      ui.sel = added[added.length - 1].id;
      await save();
      refreshAll();
    }
    if (skipped.length) alert(`가져오지 못한 파일:\n${skipped.join('\n')}`);
  });

  // ---------- 시작 · 상태 ----------

  function refreshAll() {
    if (!findTpl(template.id)) template = TEMPLATES[0];
    renderTplSelect();
    setTemplate(template.id);
    renderSkillBar();
    if (state?.chatView === 'library') renderLibrary();
  }

  host.on('state', () => {
    // 변수 입력 화면을 떠나면(Esc · 다른 화면) 보내기를 취소한다
    if (varsWait && state.chatView !== 'vars') finishVars(false);
    if (state.chatView !== 'library') draft = null;
    // 압축 화면을 떠나면(Esc 등) 기다리기를 그만둔다
    if (state.chatView !== 'compress') cmp.waiting = null;
    $('#libraryBtn').classList.toggle('active', state.chatView === 'library');
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
