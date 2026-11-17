'use strict';

// 셀렉터 편집기 (v0.35.0) — Windows 앱과 크롬 확장이 똑같이 씀. renderer.js 다음에 읽힌다.
// 자가진단 창(패널 머리줄의 ⚠ 표시 · 설정 › 셀렉터 자가진단 표의 [진단])에서 [셀렉터 직접 고치기]를 누르면 열린다.
//   - 서비스 하나의 입력창 · 답변 읽기 · 중지 단추 셀렉터를 줄마다 하나씩 적는다 (위에 적은 것을 먼저 찾고, 앱 · 원격 값은 뒤에 그대로 남는다)
//   - 보내기 · 로그인 단추 · 파일 넣기 칸은 고칠 수 없다 (앱 업데이트로만) — 원격 갱신과 같은 범위
//   - 이 PC(이 확장)에만 저장하고 어디로도 보내지 않는다. 저장하면 바로 입력창을 다시 찾아 본다
//   - [GitHub 이슈 열기]: 진단 정보(서비스 · 상태 · 셀렉터 버전, 내가 고친 셀렉터)를 채운 이슈 양식을 연다 — 열기 전에 내용을 보여 주고 묻는다.
//     질문 · 답변 · 페이지 글 · 주소의 경로는 넣지 않는다 (진단 정보 복사와 같은 글).
// 본체가 같은 검사(shared/remote-core.js sanitizeLocal)를 다시 한다.
//
// [쉽게 말하면] AI 사이트가 화면을 바꿔 앱이 입력창이나 답변을 못 찾을 때, 새 위치를 직접 적어 넣거나 이슈로 알리는 창입니다.

(() => {
  const FIELDS = ['input', 'response', 'stop']; // 보여 주는 순서
  const MAX_LINES = 20;
  const MAX_LEN = 300;
  let editing = null; // { id, back } back: 닫으면 돌아갈 자가진단 창을 다시 열지

  const say = (text, kind = '') => {
    const s = $('#selStatus');
    s.textContent = text;
    s.dataset.kind = kind;
  };

  /** 한 줄 셀렉터 검사: 길이 · 중괄호 · 브라우저가 읽을 수 있는 모양인지 → 문제 글 | '' */
  function problemOf(sel) {
    if (sel.length > MAX_LEN) return t('selector.err.long', { n: MAX_LEN });
    if (/[{}]/.test(sel)) return t('selector.err.braces');
    try {
      document.createDocumentFragment().querySelector(sel);
    } catch {
      return t('selector.err.syntax');
    }
    return '';
  }

  function render(view) {
    $('#selTitle').textContent = t('selector.title', { name: view.name });
    const box = $('#selFields');
    box.replaceChildren(
      ...FIELDS.map((f) => {
        const wrap = document.createElement('div');
        wrap.className = 'sel-field';
        const label = document.createElement('label');
        label.htmlFor = `selField-${f}`;
        label.textContent = t(`selector.field.${f}`);
        const hint = document.createElement('p');
        hint.className = 'muted small';
        hint.textContent = t(`selector.fieldHint.${f}`);
        const ta = document.createElement('textarea');
        ta.id = `selField-${f}`;
        ta.rows = 3;
        ta.spellcheck = false;
        ta.dataset.field = f;
        ta.placeholder = t('selector.placeholder');
        ta.value = (view.local[f] || []).join('\n');
        const inh = document.createElement('p');
        inh.className = 'muted small sel-inherited';
        const list = view.inherited[f] || [];
        inh.textContent = list.length ? `${t('selector.inherited')} ${list.join('  ·  ')}` : t('selector.inheritedNone');
        wrap.append(label, hint, ta, inh);
        return wrap;
      }),
    );
  }

  async function open(id, { back = false } = {}) {
    const view = await host.selectors?.get(id);
    if (!view) return;
    editing = { id, back };
    render(view);
    say('');
    $('#diagModal').hidden = true;
    $('#selModal').hidden = false;
    $('#selFields textarea')?.focus();
  }

  function close() {
    if (!editing) return;
    const { back } = editing;
    editing = null;
    $('#selModal').hidden = true;
    if (back && typeof diagOpen !== 'undefined' && diagOpen) {
      renderDiagModal();
      $('#diagModal').hidden = false;
      $('#diagClose').focus();
    } else if (typeof diagOpen !== 'undefined' && diagOpen) {
      closeDiag();
    }
  }

  /** 입력칸 → { input: [..], response: [..], stop: [..] } | null (문제가 있으면 알리고 null) */
  function collect() {
    const patch = {};
    for (const ta of document.querySelectorAll('#selFields textarea')) {
      const lines = [...new Set(ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
      if (lines.length > MAX_LINES) return say(t('selector.err.many', { n: MAX_LINES }), 'error'), null;
      for (const line of lines) {
        const bad = problemOf(line);
        if (bad) return say(`${t(`selector.field.${ta.dataset.field}`)}: "${line.slice(0, 60)}" — ${bad}`, 'error'), null;
      }
      patch[ta.dataset.field] = lines;
    }
    return patch;
  }

  async function save() {
    if (!editing) return;
    const patch = collect();
    if (!patch) return;
    $('#selSave').disabled = true;
    try {
      const r = await host.selectors.set(editing.id, patch);
      if (!r?.ok) throw new Error(r?.error || '');
      render(r.view);
      say(t('selector.saved'), 'ok');
    } catch (err) {
      say(`${t('selector.saveFailed')} ${err.message}`, 'error');
    } finally {
      $('#selSave').disabled = false;
    }
  }

  async function resetAll() {
    if (!editing || !confirm(t('selector.resetConfirm'))) return;
    const r = await host.selectors.reset(editing.id).catch(() => null);
    if (!r?.ok) return say(t('selector.saveFailed'), 'error');
    render(r.view);
    say(t('selector.resetDone'), 'ok');
  }

  /** 이슈 제목 · 본문: 진단 정보 복사와 같은 글 + 내가 고친 셀렉터 + 적어 달라는 칸 */
  async function issueDraft(id) {
    const view = await host.selectors.get(id);
    const mine = FIELDS.filter((f) => view.local[f]?.length).map((f) => `- ${t(`selector.field.${f}`)}: ${view.local[f].map((x) => `\`${x}\``).join(', ')}`);
    const body = [
      diagReportText(),
      '',
      mine.length ? `${t('selector.issue.mine')}\n${mine.join('\n')}` : t('selector.issue.noMine'),
      '',
      t('selector.issue.describe'),
    ].join('\n');
    return { title: t('selector.issue.title', { name: view.name }), body };
  }

  async function openIssue() {
    if (!editing && !(typeof diagOpen !== 'undefined' && diagOpen)) return;
    const id = editing?.id || diagOpen.id;
    const d = await issueDraft(id).catch(() => null);
    if (!d) return;
    if (!confirm(t('selector.issue.confirm', { text: d.body.slice(0, 1200) }))) return;
    const r = await host.openIssue(d.title, d.body).catch(() => null);
    const msg = r?.ok ? t('selector.issue.opened') : t('selector.issue.failed');
    if (editing) say(msg, r?.ok ? 'ok' : 'error');
    else diagSay(msg, r?.ok ? 'ok' : 'error');
  }

  // 자가진단 창의 단추 · 설정 표의 [진단]
  $('#diagFixSel').addEventListener('click', () => diagOpen && open(diagOpen.id, { back: true }));
  $('#diagIssue').addEventListener('click', openIssue);
  window.openSelectorEditor = open;

  $('#selSave').addEventListener('click', save);
  $('#selReset').addEventListener('click', resetAll);
  $('#selIssue').addEventListener('click', openIssue);
  $('#selClose').addEventListener('click', close);
  $('#selModal').addEventListener('click', (e) => e.target === $('#selModal') && close());
  $('#selModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
})();
