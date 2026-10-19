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
  const skillSent = new Map(); // 패널 id -> 이 대화에 보낸 스킬 id
  const ui = { tab: 'templates', sel: null }; // 라이브러리 화면: 보고 있는 탭과 고른 항목 id

  const builtinTpl = (id) => TEMPLATES.find((t) => t.id === id);
  const userTpl = (id) => lib.templates.find((t) => t.id === id);
  const findTpl = (id) => builtinTpl(id) || userTpl(id);
  const activeSkill = () => lib.skills.find((s) => s.id === lib.activeSkill) || null;

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

  function renderSkillSelect() {
    const sel = $('#skillSelect');
    sel.replaceChildren(
      option('', '스킬 없음'),
      ...lib.skills.map((s) => option(s.id, s.name)),
      option('__library', '📚 스킬 관리…'),
    );
    sel.value = lib.activeSkill || '';
    sel.classList.toggle('on', !!lib.activeSkill);
    const s = activeSkill();
    sel.title = s ? `${s.name}${s.description ? ` — ${s.description}` : ''}\n${MODE_TEXT[lib.skillMode]} 지침을 붙여 보냅니다` : '고른 스킬의 지침을 질문 앞에 붙여 보냅니다';
  }

  $('#skillSelect').addEventListener('change', (e) => {
    if (e.target.value === '__library') {
      e.target.value = lib.activeSkill || '';
      return openLibrary('skills', lib.activeSkill);
    }
    lib.activeSkill = e.target.value || null;
    save();
    renderSkillSelect();
    $('#prompt').focus();
  });

  /**
   * 이번에 보낼 패널마다 붙일 스킬 지침. → { prefixById, ids } | null
   * "새 대화 첫 질문에만"이면 이 대화에 같은 스킬을 이미 보낸 패널은 뺀다.
   */
  window.libSkillPrefix = (targetIds) => {
    const s = activeSkill();
    if (!s) return null;
    const ids = targetIds.filter((id) => lib.skillMode === 'every' || skillSent.get(id) !== s.id);
    if (!ids.length) return null;
    const text = PL.skillPrefix(s);
    return { prefixById: Object.fromEntries(ids.map((id) => [id, text])), ids, skillId: s.id };
  };

  /** 보내기에 성공한 패널은 이 대화에 스킬을 받았다고 기억한다 */
  window.onSkillSent = (applied, okIds) => {
    if (!applied) return;
    for (const id of okIds) if (applied.ids.includes(id)) skillSent.set(id, applied.skillId);
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
    $('#libSkillMode').value = lib.skillMode;
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
      list.push(span('lib-group', `스킬 ${lib.skills.length}개`));
      for (const s of lib.skills) {
        list.push(listRow(`${lib.activeSkill === s.id ? '● ' : ''}${s.name}`, s.description || `${s.body.length.toLocaleString()}자`, ui.sel === s.id, () => select(s.id)));
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
    $('#libUse').textContent = isTpl ? '이 템플릿 쓰기' : lib.activeSkill === c.item?.id ? '이 스킬 끄기' : '이 스킬 쓰기';
    updateEditorInfo();
  }

  function updateEditorInfo() {
    const c = current();
    if (!c) return;
    const text = $('#libText').value;
    if (c.kind === 'template') {
      const vars = PL.parseVars(text);
      $('#libInfo').textContent = `${vars.length ? `변수 ${vars.length}개: ${vars.map((v) => (v.choices ? `${v.name}(${v.choices.join('/')})` : v.def ? `${v.name}=${v.def}` : v.name)).join(', ')}` : '변수 없음'}${text.includes('{q}') ? '' : ' · {q}가 없어 입력창 내용은 맨 뒤에 붙습니다'}`;
    } else {
      $('#libInfo').textContent = `${text.length.toLocaleString()} / ${PL.LIMITS.skillBody.toLocaleString()}자 · ${MODE_TEXT[lib.skillMode]} 붙여 보냄`;
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
      if (lib.activeSkill === c.item.id) lib.activeSkill = null;
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
    lib.activeSkill = lib.activeSkill === c.item.id ? null : c.item.id;
    await save();
    refreshAll();
  });

  $('#libSkillMode').addEventListener('change', async (e) => {
    lib.skillMode = e.target.value;
    await save();
    refreshAll();
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
    renderSkillSelect();
    if (state?.chatView === 'library') renderLibrary();
  }

  host.on('state', () => {
    // 변수 입력 화면을 떠나면(Esc · 다른 화면) 보내기를 취소한다
    if (varsWait && state.chatView !== 'vars') finishVars(false);
    if (state.chatView !== 'library') draft = null;
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
