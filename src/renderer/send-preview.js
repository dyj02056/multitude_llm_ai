'use strict';

// 보내기 전 미리보기 (v0.25.0) — Windows 앱과 크롬 확장이 똑같이 씀. renderer-compose.js 다음에 읽힌다.
// 보내기 버튼이 만든 payload(템플릿 · 프로젝트 맥락 · 스킬 지침을 붙인 것)로 패널마다 실제로 들어갈 글을
// shared/send-plan.js로 계산해 보여 준다: 최종 글, 직접 올린 첨부, 프로젝트 파일 업로드, 글자 수, 한도 경고.
// [보내기]를 누르면 보여 준 그 payload를 그대로 보낸다 (다시 만들지 않음). [취소]면 보내지 않고 입력 내용을 남긴다.
// Windows 앱은 패널 웹페이지가 화면 맨 위에 얹혀 있어 'dialog' 화면으로 바꿔 패널을 치운 뒤 띄운다 (자가진단 창과 같음).
//
// [쉽게 말하면] 보내기 직전에 "AI마다 정확히 무엇이 가는지" 한 번 보여 주고 확인을 받는 창입니다.

(() => {
  const SP = MLA.sendPlan;
  const SHOW_CHARS = 200000; // 이보다 긴 글은 앞부분만 그린다 (창이 느려지지 않게 — 보내는 글은 그대로 전부)
  let open = null; // { resolve, dialog, pending }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const num = (n) => Number(n).toLocaleString();

  function warningText(w) {
    const v = { ...w.vars };
    if (v.n !== undefined) v.n = num(v.n);
    if (w.code === 'big') v.max = fmtSize(v.max);
    else if (v.max !== undefined) v.max = num(v.max);
    return t(`preview.warn.${w.code}`, v);
  }

  function fileLine(f) {
    const li = el('li', f.sent ? '' : 'skipped');
    li.append(el('span', 'pv-tag', f.project ? t('preview.projectFile') : t('preview.userFile')), el('span', 'pv-name', f.name), el('span', 'muted-label', fmtSize(f.size)));
    if (!f.sent) li.append(el('span', 'pv-skip', t('preview.notSent')));
    return li;
  }

  function rowBlock(row) {
    const box = el('details', 'pv');
    box.open = true;
    const head = el('summary', 'pv-head');
    const svc = state?.services.find((s) => s.id === row.id);
    head.style.setProperty('--svc', svc?.color || 'var(--border)');
    head.append(el('b', '', row.name), el('span', 'muted-label', t('preview.chars', { n: num(row.chars) })));
    const files = row.files.filter((f) => f.sent).length;
    if (row.files.length) head.append(el('span', 'muted-label', t('preview.files', { n: files, all: row.files.length })));
    if (row.warnings.length) head.append(el('span', 'pv-warn-badge', t('preview.warnCount', { n: row.warnings.length })));
    box.append(head);
    for (const w of row.warnings) box.append(el('p', 'pv-warn', warningText(w)));
    if (row.fallbackChars) box.append(el('p', 'muted small pv-note', t('preview.fallback', { n: num(row.fallbackChars) })));
    if (row.files.length) {
      const ul = el('ul', 'pv-files');
      ul.append(...row.files.map(fileLine));
      box.append(ul);
    }
    const shown = row.text.length > SHOW_CHARS ? `${row.text.slice(0, SHOW_CHARS)}\n…` : row.text;
    const pre = el('pre', 'pv-text', shown || t('preview.noText'));
    if (!row.text) pre.classList.add('empty');
    box.append(pre);
    if (row.text.length > SHOW_CHARS) box.append(el('p', 'muted small pv-note', t('preview.cut', { n: num(SHOW_CHARS) })));
    return box;
  }

  function render(payload, ids) {
    const rows = SP.preview(payload.text, ids, payload.files, payload.opts, state?.services || [], state?.attachLimits);
    $('#previewBody').replaceChildren(...rows.map(rowBlock));
    const warn = rows.reduce((n, r) => n + r.warnings.length, 0);
    $('#previewSub').textContent = t('preview.sub', { n: rows.length });
    const st = $('#previewStatus');
    st.textContent = warn ? t('preview.warnTotal', { n: warn }) : t('preview.ready');
    st.dataset.kind = warn ? 'warn' : '';
    return rows;
  }

  function close(ok) {
    if (!open) return;
    const { resolve, dialog } = open;
    open = null;
    $('#previewModal').hidden = true;
    $('#previewBody').replaceChildren(); // 질문 · 프로젝트 글을 화면에 남겨 두지 않는다
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
    resolve(ok);
  }

  /** 미리보기 창을 띄우고 [보내기]면 true, [취소] · Esc · 다른 화면으로 가면 false */
  window.openSendPreview = (payload, ids) => {
    if (open) close(false);
    return new Promise((resolve) => {
      const dialog = state?.chatView === 'panels';
      open = { resolve, dialog, pending: dialog };
      if (dialog) host.setView('dialog');
      render(payload, ids);
      $('#previewModal').hidden = false;
      $('#previewSend').focus();
    });
  };

  /** 화면 상태가 올 때마다 (renderer-compose.js): 창을 띄운 화면을 떠났으면(Esc 단축키 · 툴바) 보내지 않고 닫는다 */
  window.onPreviewState = () => {
    if (!open) return;
    const want = open.dialog ? 'dialog' : null;
    if (open.pending) {
      if (state.chatView === want) open.pending = false;
      return;
    }
    if (want && state.chatView !== want) {
      open.dialog = false; // 이미 다른 화면이라 패널로 되돌리지 않는다
      close(false);
    }
  };

  $('#previewSend').addEventListener('click', () => close(true));
  $('#previewCancel').addEventListener('click', () => close(false));
  $('#previewModal').addEventListener('click', (e) => e.target === $('#previewModal') && close(false));
  $('#previewModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      close(true);
    }
  });
})();
