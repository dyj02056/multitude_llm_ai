// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/settings-transfer-ui.js)
'use strict';

// 설정 옮기기 화면 (v0.29.0) — Windows 앱과 크롬 확장이 똑같이 씀. library-presets.js 다음에 읽힌다.
// 설정(?) › 설정 옮기기:
//   [내보내기] 비밀번호(선택, 8자 이상 · 두 번)를 넣으면 암호화해 .mla.json으로 저장 (앱: 저장 창 file:save, 확장: 다운로드)
//   [가져오기] 파일 고르기 → (암호화된 파일이면) 비밀번호 → 바뀌는 설정 목록 · 라이브러리 개수 · 겹치는 항목(덮어쓰기 / 둘 다 남기기)
//              → [가져오기]를 눌러야 바꾼다. 설정은 기존 창구(host.setSettings · setSynth · setLayout · local.setPrefs · openModels)로
//              바꾸므로 본체가 예전과 같은 규칙으로 다시 검사한다. 라이브러리는 normalizeLibrary를 거쳐 저장한다.
// 계산(파일 모양 · 암호 · 차이 · 합치기)은 shared/settings-transfer.js.
//
// [쉽게 말하면] 설정과 템플릿 · 스킬 · 프리셋을 파일로 옮기는 버튼과 "가져오면 이렇게 바뀝니다" 확인 창입니다.

(() => {
  const ST = MLA.settingsTransfer;
  const PL = MLA.promptLib;
  const api = () => window.libApi;
  let incoming = null; // { envelope? , data? } 고른 파일

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const say = (sel, text, kind = '') => {
    $(sel).textContent = text;
    $(sel).dataset.kind = kind;
  };
  const errText = (err) => t(`transfer.err.${err?.code || 'unknown'}`, { min: ST.MIN_PASSWORD });
  const nameOf = (id) => state?.services.find((s) => s.id === id)?.name || id;

  // ---------- 내보내기 ----------

  async function exportFile() {
    const pass = $('#transferPass').value;
    if (pass !== $('#transferPass2').value) return say('#transferStatus', t('transfer.passMismatch'), 'error');
    if (pass && pass.length < ST.MIN_PASSWORD) return say('#transferStatus', t('transfer.err.password', { min: ST.MIN_PASSWORD }), 'error');
    try {
      const payload = ST.buildExport({ settings: ST.pickSettings(state), library: api().get(), app: host.git ? 'app' : 'extension', appVersion: state?.update?.current || '' });
      const plain = JSON.stringify(payload, null, 2);
      const text = pass ? await ST.encrypt(plain, pass) : plain;
      const r = await host.saveFile({ name: `multitude-llm-settings-${new Date().toISOString().slice(0, 10)}`, text, kind: 'mla' });
      if (r?.cancelled) return say('#transferStatus', '');
      if (!r?.ok) throw new Error(r?.error || '');
      $('#transferPass').value = '';
      $('#transferPass2').value = '';
      const lib = payload.library;
      say('#transferStatus', t(pass ? 'transfer.exportedEnc' : 'transfer.exported', { path: r.path || '', t: lib.templates.length, s: lib.skills.length, p: lib.presets.length }), 'ok');
    } catch (err) {
      say('#transferStatus', `${t('transfer.exportFailed')} ${err.code ? errText(err) : err.message}`, 'error');
    }
  }

  // ---------- 하나만 공유 (v0.35.0) ----------

  /**
   * 라이브러리 항목 하나를 .mla.json 공유 파일로 저장한다 (암호 없이 — 남에게 주려는 파일). 프리셋은 쓰는 스킬 · 템플릿도 함께.
   * kind: 'template' | 'skill' | 'preset', anchor: 결과 글을 잠깐 보여 줄 단추
   */
  window.shareLibraryItem = async (kind, id, anchor) => {
    const share = ST.buildShare({ kind, id, library: api().get(), app: host.git ? 'app' : 'extension', appVersion: state?.update?.current || '' });
    if (!share) return;
    const c = share.counts;
    if (!confirm(t('transfer.shareConfirm', { name: share.name, t: c.templates, s: c.skills, p: c.presets }))) return;
    try {
      const safe = share.name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || kind;
      const r = await host.saveFile({ name: `multitude-llm-share-${safe}`, text: JSON.stringify(share.payload, null, 2), kind: 'mla' });
      if (r?.cancelled) return;
      if (!r?.ok) throw new Error(r?.error || '');
      flash(anchor, t('transfer.shareSaved'));
    } catch (err) {
      alert(`${t('transfer.exportFailed')} ${err.message}`);
    }
  };

  // ---------- 가져오기 ----------

  /** 라이브러리 화면의 가져오기에서 넘어온 설정 옮기기 · 공유 파일 글을 같은 확인 창으로 연다 */
  window.openTransferText = (text, fileName) => {
    try {
      incoming = ST.parseFile(text);
    } catch (err) {
      return alert(`${t('transfer.importFailed')} ${errText(err)}`);
    }
    openModal(fileName);
  };

  async function pickFile(file) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw Object.assign(new Error('size'), { code: 'size' });
      incoming = ST.parseFile(await file.text());
    } catch (err) {
      return say('#transferStatus', `${t('transfer.importFailed')} ${errText(err)}`, 'error');
    }
    openModal(file.name);
  }

  function openModal(fileName) {
    $('#transferSub').textContent = fileName || '';
    $('#transferPassRow').hidden = !incoming.encrypted;
    $('#transferOpenPass').value = '';
    $('#transferConflict').hidden = true;
    $('#transferApply').disabled = true;
    $('#transferPlan').replaceChildren();
    say('#transferModalStatus', incoming.encrypted ? t('transfer.needPass') : '');
    $('#transferModal').hidden = false;
    if (incoming.encrypted) $('#transferOpenPass').focus();
    else showPlan();
  }

  function closeModal() {
    incoming = null;
    $('#transferModal').hidden = true;
  }

  async function unlock() {
    if (!incoming?.envelope) return;
    say('#transferModalStatus', t('transfer.unlocking'));
    try {
      incoming = { encrypted: false, data: await ST.decrypt(incoming.envelope, $('#transferOpenPass').value) };
      $('#transferPassRow').hidden = true;
      showPlan();
    } catch (err) {
      say('#transferModalStatus', errText(err), 'error');
    }
  }

  /** 설정 값 → 짧은 글 */
  function valueText(key, v) {
    if (v === undefined) return '–';
    if (typeof v === 'boolean') return t(v ? 'transfer.on' : 'transfer.off');
    if (key === 'selected') return v.map(nameOf).join(', ') || '–';
    if (key === 'synthTarget') return nameOf(v);
    if (key === 'lang') return { auto: t('settings.lang.auto'), ko: '한국어', en: 'English' }[v] || String(v);
    if (key === 'notify') return Object.entries(v).filter(([, on]) => on).map(([k]) => k).join(', ') || t('transfer.off');
    if (key === 'local') return [v.enabled === undefined ? '' : t(v.enabled ? 'transfer.on' : 'transfer.off'), v.baseUrl, v.model, v.contextTokens ? `${v.contextTokens.toLocaleString()} tok` : ''].filter(Boolean).join(' · ');
    return String(v);
  }

  function showPlan() {
    const d = incoming.data;
    const changes = ST.diffSettings(state, d.settings);
    const lib = api().get();
    const clash = ST.conflicts(lib, d.library);
    const box = $('#transferPlan');
    const head = el('p', 'muted small', t('transfer.from', { app: d.app || '?', at: d.exportedAt || '?' }));
    const setTitle = el('h3', '', t('transfer.settingsHead', { n: changes.length }));
    const list = el('ul', 'transfer-list');
    for (const c of changes) {
      const li = el('li');
      li.append(el('b', '', t(`transfer.key.${c.key}`)), el('span', 'muted-label', ` ${valueText(c.key, c.from)} → `), el('span', '', valueText(c.key, c.to)));
      if (c.key === 'historyMax' && c.to < (state.historyMax || 0)) li.append(el('span', 'pv-warn', ` ${t('transfer.historyShrink')}`));
      if (c.key === 'selected') li.append(el('span', 'muted-label', ` ${t('transfer.reopenPanels')}`));
      list.append(li);
    }
    if (!changes.length) list.append(el('li', 'muted-label', t('transfer.noSettingChange')));
    const libTitle = el('h3', '', t('transfer.libraryHead'));
    const libLine = el('p', '', t('transfer.libraryCounts', { t: d.library.templates.length, s: d.library.skills.length, p: d.library.presets.length }));
    box.replaceChildren(head, setTitle, list, libTitle, libLine);
    if (clash.total) box.append(el('p', 'pv-warn', t('transfer.conflictCount', { t: clash.templates, s: clash.skills, p: clash.presets })));
    box.append(el('p', 'muted small', t('transfer.trustNote')));
    $('#transferConflict').hidden = !clash.total;
    $('#transferApply').disabled = false;
    say('#transferModalStatus', t('transfer.ready'));
  }

  async function apply() {
    const d = incoming?.data;
    if (!d) return;
    $('#transferApply').disabled = true;
    const notes = [];
    try {
      // 1) 라이브러리: id로 합쳐 normalizeLibrary를 거쳐 저장
      const mode = document.querySelector('input[name="transferMode"]:checked')?.value === 'keepBoth' ? 'keepBoth' : 'overwrite';
      const merged = ST.mergeLibrary(api().get(), d.library, { mode, normalize: PL.normalizeLibrary, newId: PL.newId, copyName: (n) => t('transfer.copyName', { name: n }) });
      api().set(merged.lib);
      await api().save();
      api().refreshAll();
      if (merged.dropped > 0) notes.push(t('transfer.dropped', { n: merged.dropped }));
      // 2) 설정: 기존 창구로 (본체가 다시 검사). 로컬 LLM을 먼저 (고른 모델 · 종합 담당에 로컬 LLM이 있을 수 있음)
      const s = d.settings;
      if (s.local) {
        const r = await host.local.setPrefs(s.local).catch((err) => ({ ok: false, error: err.message }));
        if (!r?.ok) notes.push(t('transfer.localFailed', { error: r?.error || '' }));
      }
      const plain = Object.fromEntries(['answerTimeoutMin', 'historyMax', 'historyArchive', 'notify', 'sendPreview', 'retryOnce', 'autoRecommend', 'commitOffer', 'lang'].filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
      if (Object.keys(plain).length) host.setSettings(plain);
      if (s.layout) host.setLayout(s.layout);
      const synth = () => host.setSynth({ ...(s.synthTarget ? { target: s.synthTarget } : {}), ...(s.autoSynth !== undefined ? { auto: s.autoSynth } : {}) });
      const open = (state?.rects || []).map((r) => r.id);
      const want = (s.selected || []).filter((id) => state.services.some((x) => x.id === id));
      if (want.length && !(want.length === open.length && want.every((id) => open.includes(id)))) {
        window.afterPanelsOpen(want, synth); // 패널을 연 뒤에 종합 담당 (열린 패널만 고를 수 있어서)
        host.openModels(want);
      } else synth();
      closeModal();
      const doneText = `${t('transfer.done')}${notes.length ? ` — ${notes.join(' · ')}` : ''}`;
      say('#transferStatus', doneText, notes.length ? 'warn' : 'ok');
      if (state?.chatView === 'library') alert(doneText); // 라이브러리 화면에서 열었으면 그 자리에서 알린다
    } catch (err) {
      $('#transferApply').disabled = false;
      say('#transferModalStatus', `${t('transfer.importFailed')} ${err.message}`, 'error');
    }
  }

  $('#transferExport').addEventListener('click', exportFile);
  $('#transferImport').addEventListener('click', () => $('#transferFile').click());
  $('#transferFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    pickFile(f);
  });
  $('#transferUnlock').addEventListener('click', unlock);
  $('#transferOpenPass').addEventListener('keydown', (e) => e.key === 'Enter' && unlock());
  $('#transferApply').addEventListener('click', apply);
  $('#transferCancel').addEventListener('click', closeModal);
  $('#transferModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal();
    }
  });
  // 설정 화면을 떠나면 창을 닫는다
  host.on('state', () => {
    if (incoming && state.chatView !== 'help' && state.chatView !== 'library') closeModal();
  });
})();
