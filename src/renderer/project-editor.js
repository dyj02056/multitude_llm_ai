'use strict';

// 프로젝트 모드 — 파일 편집기 · git 콘솔(Windows 앱 전용).
// project.js · project-changes.js 다음에 읽힌다. 앞 파일의 것은 MLA.projectUI(P)에서 꺼내 쓴다 (v0.24.0에서 나눔).
//
// [쉽게 말하면] 사이드바에서 파일을 눌러 직접 고치는 편집 화면과, 그 폴더에서 git 명령을 치는 콘솔입니다.
(() => {
  const P = MLA.projectUI;
  const { project, ed, has, MAX_LOG, renderTree, rescan, saveState, syncStale } = P;
  const { currentText, writeBlocked, revert } = P;

  // ---------- 파일 편집 ----------
  // 사이드바 트리에서 파일 이름을 누르면 연다. 저장하면 로컬 파일에 쓰고 적용 기록("직접 편집")에 남긴 뒤 다시 읽는다.
  // 그러면 이 파일을 받은 적 있는 AI는 "바뀐 파일"로 잡혀, "저장하고 AI에 보내기"나 사이드바 버튼으로 바로 보낼 수 있다.

  const lfOf = (text) => (text ?? '').replace(/\r\n/g, '\n');
  const edDirty = () => !!ed.path && $('#edText').value !== lfOf(ed.base);

  function guessIndent(text) {
    if (/^\t/m.test(text)) return '\t';
    return /^ {4}\S/m.test(text) && !/^ {2}\S/m.test(text) ? '    ' : '  ';
  }

  function edStatus(text) {
    const dirty = edDirty();
    $('#edStatus').dataset.dirty = dirty ? '1' : '';
    $('#edStatus').textContent = text || (ed.path ? `${dirty ? t('project.editor.unsaved') : t('project.editor.saved')} · ${ed.crlf ? 'CRLF' : 'LF'}` : '');
  }

  // 편집기 닫기 (내용 비우고 패널 화면으로)
  function closeEditor() {
    Object.assign(ed, { path: null, base: null });
    $('#edText').value = '';
    $('#edPath').textContent = '';
    edStatus();
    if (state?.chatView === 'editor') host.setView('panels');
  }

  /** 파일을 편집기에서 엽니다. 다른 파일에 저장 안 한 수정이 있으면 먼저 묻습니다. */
  async function openEditor(path) {
    if (!has()) return;
    if (path !== ed.path && edDirty() && !confirm(t('project.editor.discardOpen', { path: ed.path, next: path }))) return;
    if (path === ed.path && ed.base !== null) return host.setView('editor');
    let text;
    try {
      text = await currentText(path);
    } catch (err) {
      return alert(t('project.editor.openFailed', { error: err.message }));
    }
    if (text === null) return alert(t('project.editor.noFile'));
    Object.assign(ed, { path, base: text, crlf: text.includes('\r\n'), indent: guessIndent(text) });
    $('#edText').value = lfOf(text);
    $('#edPath').textContent = path;
    $('#edPath').title = path;
    edStatus();
    host.setView('editor');
    renderTree();
    setTimeout(() => $('#edText').focus(), 0);
  }

  /** 저장. 결과: 저장했거나 바뀐 내용이 없으면 true, 취소·실패면 false */
  async function saveEditor() {
    if (!has() || !ed.path) return false;
    const path = ed.path;
    const block = writeBlocked(path);
    if (block) {
      alert(block);
      return false;
    }
    let now;
    try {
      now = await currentText(path);
    } catch (err) {
      alert(t('project.editor.saveFailed', { error: err.message }));
      return false;
    }
    const value = $('#edText').value;
    if (now !== ed.base) {
      const why = now === null ? t('project.editor.goneMeanwhile') : t('project.editor.changedMeanwhile');
      if (!confirm(t('project.editor.overwrite', { path, why }))) return false;
    } else if (value === lfOf(now)) {
      edStatus(t('project.editor.noChange'));
      setTimeout(() => edStatus(), 1500);
      return true;
    }
    const after = ed.crlf ? value.replace(/\n/g, '\r\n') : value; // 원래 줄바꿈(CRLF)을 지킨다
    try {
      await host.project.writeFile(path, after);
    } catch (err) {
      alert(t('project.editor.saveFailed', { error: err.message }));
      return false;
    }
    ed.base = after;
    project.log.unshift({ id: `${Date.now().toString(36)}`, at: Date.now(), ai: '직접 편집', files: [{ path, before: now, after }], reverted: false });
    project.log.length = Math.min(project.log.length, MAX_LOG);
    saveState();
    edStatus(t('project.editor.savedNow'));
    setTimeout(() => edStatus(), 1500);
    await rescan(); // 바뀐 파일 검사(checkStale)도 여기서 한다
    return true;
  }

  $('#edSave').addEventListener('click', () => saveEditor());
  $('#edSaveSend').addEventListener('click', async () => {
    if (!(await saveEditor())) return;
    const path = ed.path;
    const knows = project.stale.some((s) => s.files.some((f) => f.path === path) || s.deleted.includes(path));
    if (!knows) {
      const known = [...project.sent.values()].some((m) => m.has(path));
      return alert(
        known
          ? t('project.editor.syncKnown', { path })
          : t('project.editor.syncNobody', { path }),
      );
    }
    await syncStale(path);
  });
  $('#edReload').addEventListener('click', async () => {
    if (!ed.path) return;
    if (edDirty() && !confirm(t('project.editor.discardReload'))) return;
    const path = ed.path;
    ed.base = null;
    ed.path = null;
    $('#edText').value = '';
    await openEditor(path);
  });
  $('#edClose').addEventListener('click', () => host.setView('panels'));
  $('#edText').addEventListener('input', () => edStatus());
  $('#edText').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveEditor();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      document.execCommand('insertText', false, ed.indent); // 되돌리기(Ctrl+Z)가 되도록 execCommand로 넣는다
    }
  });

  // ---------- git 콘솔 (Windows 앱 전용, host.git) ----------
  // 명령 줄 글자만 메인 프로세스에 넘긴다. 무엇을 받을지 검사·확인 창·실행은 메인(src/main/gitconsole.js)이 한다.
  // AI 답변의 명령을 가져오지 않는다 — 사용자가 직접 입력한 것만 실행한다.

  if (host.git) {
    const out = $('#gitOut');
    const input = $('#gitInput');
    const past = []; // 이전 명령 (↑↓)
    let pastAt = 0;
    let busy = false;

    const print = (text, cls) => {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = text;
      out.append(s);
      // 너무 길어지면 앞부분을 버린다
      while (out.childNodes.length > 4000) out.firstChild.remove();
      out.scrollTop = out.scrollHeight;
    };
    const setBusy = (on) => {
      busy = on;
      $('#gitRun').disabled = on;
      $('#gitStop').disabled = !on;
    };

    async function showInfo() {
      const info = await host.git.info().catch((err) => ({ error: err.message }));
      const note = $('#gitNote');
      note.hidden = true;
      if (info.error) {
        $('#gitWhere').textContent = '';
        note.textContent = info.error;
        note.hidden = false;
        return;
      }
      $('#gitWhere').textContent = info.isRepo ? `${info.top} · ${info.branch || t('project.git.noBranch')}` : t('project.git.notRepo', { root: info.root });
      if (info.hooks?.length) {
        note.textContent =
          t('project.git.hooks', {
            n: info.hooks.length,
            where: info.hooksPath ? ` (core.hooksPath: ${info.hooksPath})` : '',
            list: `${info.hooks.slice(0, 8).join(', ')}${info.hooks.length > 8 ? ' …' : ''}`,
          }) +
          '\n' +
          t('project.git.hooksWarn');
        note.hidden = false;
      }
    }

    async function runGit(line) {
      line = line.trim();
      if (!line || busy) return;
      if (!/^git(\s|$)/.test(line)) line = `git ${line}`; // "status"만 써도 git status로
      if (past[past.length - 1] !== line) past.push(line);
      pastAt = past.length;
      print(`\n> ${line.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')}\n`, 'cmd'); // 주소에 넣은 토큰은 화면에 보이지 않게
      setBusy(true);
      try {
        const r = await host.git.run(line);
        if (!r.ok) print(`${r.error}\n`, r.cancelled ? 'info' : 'err');
        else if (r.error) print(`${t('project.git.runFailed', { error: r.error })}\n`, 'err');
        else print(`${t('project.git.exitCode', { code: r.code })}\n`, r.code === 0 ? 'info' : 'err');
      } catch (err) {
        print(`${err.message}\n`, 'err');
      } finally {
        setBusy(false);
        input.focus();
        // 커밋·브랜치 바꾸기 뒤에는 파일이 바뀌었을 수 있다
        if (/^git\s+(checkout|switch|reset|restore|merge|pull|stash|revert|cherry-pick|rm|mv)\b/.test(line)) rescan().catch(() => {});
        showInfo();
      }
    }

    host.on('git:output', ({ stream, text }) => print(text, stream === 'err' ? 'err' : stream === 'info' ? 'info' : ''));

    $('#psGit').addEventListener('click', () => {
      host.setView('git');
      showInfo();
      setTimeout(() => input.focus(), 0);
    });
    $('#gitClose').addEventListener('click', () => host.setView('panels'));
    $('#gitClear').addEventListener('click', () => out.replaceChildren());
    $('#gitStop').addEventListener('click', () => host.git.stop());
    $('#gitTerm').addEventListener('click', async () => {
      const r = await host.git.openTerminal();
      print(r.ok ? `\n${t('project.git.termOpened', { via: r.via })}\n` : `\n${t('project.git.termFailed', { error: r.error })}\n`, r.ok ? 'info' : 'err');
    });
    for (const b of document.querySelectorAll('[data-git]')) b.addEventListener('click', () => runGit(b.dataset.git));
    $('#gitForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const line = input.value;
      input.value = '';
      runGit(line);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && pastAt > 0) input.value = past[--pastAt];
      else if (e.key === 'ArrowDown') input.value = pastAt < past.length - 1 ? past[++pastAt] : ((pastAt = past.length), '');
      else return;
      e.preventDefault();
    });
  }
  Object.assign(P, { closeEditor, edDirty, openEditor });
})();
