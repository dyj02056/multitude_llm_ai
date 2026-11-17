'use strict';

// 기록 옮기기 화면 (v0.35.0) — Windows 앱과 크롬 확장이 똑같이 씀. history-view.js 다음에 읽힌다.
// 기록 화면(hist)에서:
//   [옮기기 파일로 내보내기] 고른 기록(체크 칸)을 .mla-history.json 파일 하나로 — 비밀번호(선택, 8자 이상)를 넣으면 암호화
//   [기록 가져오기…] 파일 고르기 → (암호화됐으면 비밀번호) → "기록 N개 · 이미 있는 M개는 건너뜀"을 보고 [가져오기]를 눌러야 더한다
// 설정 옮기기(.mla.json)와는 다른 파일이다: 설정 파일에는 기록을 넣지 않는다. 사이드탭 기록은 옮기지 않는다.
// 파일 모양 · 암호 계산은 shared/history-transfer.js, 받은 기록의 모양 검사는 본체(history-core cleanRecord)가 다시 한다.
//
// [쉽게 말하면] 고른 질문 · 답변을 다른 PC나 크롬 확장으로 옮기는 버튼과 "이만큼 가져옵니다" 확인 칸입니다.

(() => {
  const HT = MLA.historyTransfer;
  let mode = null; // 'export' | 'unlock' | 'confirm'
  let incoming = null; // 고른 파일 { encrypted, envelope? , data? }
  let exportIds = [];
  let busy = false;

  const say = (text, kind = '') => {
    const s = $('#historyMoveStatus');
    s.textContent = text;
    s.dataset.kind = kind;
  };
  const errText = (err) => {
    const c = err?.code;
    return ['kind', 'size', 'records', 'big'].includes(c) ? t(`history.move.err.${c}`) : t(`transfer.err.${c || 'unknown'}`, { min: HT.MIN_PASSWORD });
  };

  function show(next, note, goLabel) {
    mode = next;
    $('#historyMove').hidden = false;
    $('#historyMoveGo').hidden = false;
    $('#historyMoveNote').textContent = note;
    $('#historyMovePassRow').hidden = next === 'confirm';
    $('#historyMovePass2').hidden = next !== 'export';
    $('#historyMovePass').placeholder = next === 'export' ? t('transfer.passPlaceholder') : t('history.move.passOpen');
    $('#historyMovePass').setAttribute('aria-label', $('#historyMovePass').placeholder);
    $('#historyMoveGo').textContent = goLabel;
    $('#historyMoveGo').disabled = false;
    $('#historyMovePass').value = '';
    $('#historyMovePass2').value = '';
    say('');
    if (next !== 'confirm') $('#historyMovePass').focus();
  }

  function close() {
    mode = null;
    incoming = null;
    exportIds = [];
    $('#historyMove').hidden = true;
    $('#historyMovePass').value = '';
    $('#historyMovePass2').value = '';
  }

  // ---------- 내보내기 ----------

  function startExport() {
    exportIds = [...historyView.picked];
    if (!exportIds.length) return;
    show('export', t('history.move.exportNote', { n: exportIds.length }), t('history.move.exportGo'));
  }

  async function doExport() {
    const pass = $('#historyMovePass').value;
    if (pass !== $('#historyMovePass2').value) return say(t('transfer.passMismatch'), 'error');
    if (pass && pass.length < HT.MIN_PASSWORD) return say(t('transfer.err.password', { min: HT.MIN_PASSWORD }), 'error');
    busy = true;
    $('#historyMoveGo').disabled = true;
    try {
      const all = (await Promise.all(exportIds.map((id) => host.history.get(id)))).filter(Boolean);
      const recs = all.filter((r) => r.source !== 'side'); // 사이드탭 기록은 옮기지 않는다
      if (!recs.length) throw Object.assign(new Error('empty'), { code: 'empty' });
      const payload = HT.buildExport({ records: recs, app: host.git ? 'app' : 'extension', appVersion: state?.update?.current || '' });
      const plain = JSON.stringify(payload);
      const text = pass ? await HT.encrypt(plain, pass) : plain;
      if (text.length > 18 * 1024 * 1024) throw Object.assign(new Error('big'), { code: 'big' });
      const r = await host.saveFile({ name: `multitude-llm-history-${new Date().toISOString().slice(0, 10)}`, text, kind: 'mlah' });
      if (r?.cancelled) return say('');
      if (!r?.ok) throw new Error(r?.error || '');
      const skipped = all.length - recs.length;
      const msg = t(pass ? 'history.move.exportedEnc' : 'history.move.exported', { n: payload.count, path: r.path || '' }) + (skipped ? ` ${t('history.move.sideSkip', { n: skipped })}` : '');
      close();
      flashMoveStatus(msg);
    } catch (err) {
      say(`${t('history.move.failed')} ${err.code === 'empty' ? t('history.move.empty') : err.code ? errText(err) : err.message}`, 'error');
    } finally {
      busy = false;
      $('#historyMoveGo').disabled = false;
    }
  }

  /** 닫은 뒤에도 결과를 알 수 있게 목록 아래 줄에 잠깐 보여 준다 */
  function flashMoveStatus(msg) {
    $('#historyMove').hidden = false;
    $('#historyMovePassRow').hidden = true;
    $('#historyMoveGo').hidden = true;
    $('#historyMoveNote').textContent = '';
    say(msg, 'ok');
    mode = 'done';
  }

  // ---------- 가져오기 ----------

  async function pickFile(file) {
    if (!file) return;
    try {
      if (file.size > HT.MAX_FILE_CHARS) throw Object.assign(new Error('size'), { code: 'size' });
      incoming = HT.parseFile(await file.text());
    } catch (err) {
      $('#historyMoveGo').hidden = false;
      show('confirm', '', t('history.move.importGo'));
      $('#historyMoveGo').disabled = true;
      return say(`${t('history.move.importFailed')} ${errText(err)}`, 'error');
    }
    $('#historyMoveGo').hidden = false;
    if (incoming.encrypted) show('unlock', t('history.move.needPass'), t('history.move.unlock'));
    else await showPlan();
  }

  async function showPlan() {
    const d = incoming.data;
    const have = new Set((await host.history.list('').catch(() => [])).map((r) => r.id));
    const dup = HT.countDuplicates(have, d.records);
    const keep = state?.historyArchive === true;
    const over = state?.historyMax && have.size + d.records.length - dup > state.historyMax;
    const note = [
      t('history.move.plan', { n: d.count, dup, app: d.app || '?', at: d.exportedAt || '?' }),
      over ? t(keep ? 'history.move.overKeep' : 'history.move.overDrop', { max: state.historyMax }) : '',
      t('history.move.trustNote'),
    ]
      .filter(Boolean)
      .join(' ');
    show('confirm', note, t('history.move.importGo'));
    $('#historyMoveGo').disabled = d.count - dup <= 0;
    if (d.count - dup <= 0) say(t('history.move.nothingNew'), 'warn');
  }

  async function unlock() {
    if (!incoming?.envelope) return;
    say(t('transfer.unlocking'));
    $('#historyMoveGo').disabled = true;
    try {
      incoming = { encrypted: false, data: await HT.decrypt(incoming.envelope, $('#historyMovePass').value) };
      await showPlan();
    } catch (err) {
      $('#historyMoveGo').disabled = false;
      say(errText(err), 'error');
    }
  }

  async function doImport() {
    const d = incoming?.data;
    if (!d) return;
    busy = true;
    $('#historyMoveGo').disabled = true;
    try {
      const r = await host.history.import(d.records);
      if (!r || r.error) throw Object.assign(new Error('records'), { code: 'records' });
      const msg = t('history.move.done', { added: r.added, dup: r.duplicate, bad: r.invalid }) + (r.overflow ? t('history.move.doneOver', { n: r.overflow }) : '');
      close();
      flashMoveStatus(msg);
      renderHistoryList();
    } catch (err) {
      $('#historyMoveGo').disabled = false;
      say(`${t('history.move.importFailed')} ${errText(err)}`, 'error');
    } finally {
      busy = false;
    }
  }

  function go() {
    if (busy) return;
    if (mode === 'export') doExport();
    else if (mode === 'unlock') unlock();
    else if (mode === 'confirm') doImport();
  }

  $('#historyPickMove').addEventListener('click', startExport);
  $('#historyImport').addEventListener('click', () => $('#historyImportFile').click());
  $('#historyImportFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    pickFile(f);
  });
  $('#historyMoveGo').addEventListener('click', go);
  $('#historyMoveCancel').addEventListener('click', () => {
    $('#historyMoveGo').hidden = false;
    close();
  });
  for (const id of ['#historyMovePass', '#historyMovePass2']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && go());
  $('#historyMove').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      $('#historyMoveGo').hidden = false;
      close();
    }
  });
})();
