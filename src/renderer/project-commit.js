'use strict';

// 프로젝트 모드 — 적용 후 커밋 (v0.28.0, Windows 앱 전용: host.git.commit). 크롬 확장에는 git이 없어 보이지 않는다.
// 적용이 끝나면(변경 바 "적용됨" · 미리보기 창) [커밋하기]를 보여 준다 (설정 "적용 후 커밋 제안", 기본 켬). 누를 때만 창을 연다.
// 창: 메시지(적용한 파일 · 수정안을 낸 AI로 미리 채움, 고칠 수 있음) · [AI에게 메시지 요약 부탁] · 커밋할 파일 · 다른 스테이징 경고.
// 커밋은 적용한 파일만: 메인(gitcommit.js)이 git add -A -- <경로> → git commit -m <메시지> -- <경로>. push는 하지 않는다.
// project-mix.js 다음에 읽힌다.
//
// [쉽게 말하면] AI 수정안을 적용한 파일만 골라 내 PC의 git 기록에 남기는 창입니다. 인터넷으로 올리지는 않습니다.
(() => {
  const P = MLA.projectUI;
  const CM = MLA.commitMsg;
  const summaryWait = new Map(); // 패널 id -> 요약 답을 받으면 부를 함수

  /** [커밋하기]를 보여 줄지: Windows 앱(git 있음) · 설정 켬 · 프로젝트 열림 */
  const canOfferCommit = () => !!host.git?.commit && state?.commitOffer !== false && P.has();

  const pathsOf = (entry) => [...new Set(entry.files.map((f) => f.path))];
  const sourcesOf = (entry) => (Array.isArray(entry.sources) && entry.sources.length ? entry.sources : [{ id: null, name: entry.ai, paths: pathsOf(entry) }]);

  async function openCommit(entry) {
    if (!canOfferCommit() || !entry || entry.reverted) return;
    const { modal, project } = P;
    const paths = pathsOf(entry);
    modal.show(t('commit.title'), t('commit.note', { name: project.info.name, n: paths.length }));
    const msg = Object.assign(document.createElement('textarea'), { id: 'commitMsg', className: 'commit-msg', rows: 4, spellcheck: false });
    msg.value = CM.defaultMessage(sourcesOf(entry));
    msg.setAttribute('aria-label', t('commit.messageLabel'));
    const info = span('muted-label commit-info', t('commit.checking'));
    const warn = span('mix-warn commit-warn', '');
    const list = document.createElement('ul');
    list.className = 'commit-files';
    for (const f of entry.files) {
      const li = document.createElement('li');
      const op = f.after === null ? 'delete' : f.before === null ? 'create' : 'modify';
      li.append(span(`op ${op}`, P.OP_TEXT[op]), span('path', f.path));
      list.append(li);
    }
    // AI에게 한 줄 요약 부탁: 파일을 가장 많이 낸, 지금 열려 있는 AI 패널에 (경로만 보냄)
    const src = [...sourcesOf(entry)].filter((s) => s.id && panels.has(s.id) && !project.blocked.has(s.id)).sort((a, b) => b.paths.length - a.paths.length)[0];
    const ask = button(t('commit.ask'), src ? t('commit.askTitle', { name: src.name }) : t('commit.askNone'), () => askSummary(src, paths, msg, ask));
    ask.disabled = !src;
    const tools = document.createElement('div');
    tools.className = 'commit-tools';
    tools.append(span('muted-label', t('commit.messageLabel')), ask);
    $('#patchBody').replaceChildren(tools, msg, info, warn, span('muted-label', t('commit.filesLabel')), list);
    const out = $('#patchTestOut');
    out.hidden = true;
    out.replaceChildren();
    $('#patchAll').hidden = true;
    $('#patchTest').hidden = true;
    $('#patchChecks').hidden = true;
    $('#patchApply').hidden = false;
    $('#patchApply').textContent = t('commit.commit');
    $('#patchApply').disabled = true;
    $('#patchStatus').textContent = t('commit.noPush');

    // 저장소인지 · 브랜치 · 다른 스테이징 · 훅
    const [ci, gi] = await Promise.all([host.git.commitInfo(paths).catch((err) => ({ ok: false, error: err.message })), host.git.info().catch(() => null)]);
    if (!ci?.ok) {
      info.textContent = ci?.error || t('commit.notRepo');
      info.className = 'test-err commit-info';
      return;
    }
    const hooks = gi?.hooks?.length ? ` · ${t('commit.hooks', { hooks: gi.hooks.join(', ') })}` : '';
    info.textContent = `${t('commit.branch', { branch: ci.branch || '?' })}${hooks}`;
    if (ci.otherStaged?.length) warn.textContent = `⚠ ${t('commit.otherStaged', { n: ci.otherStaged.length, files: ci.otherStaged.slice(0, 8).join(', ') })}`;
    $('#patchApply').disabled = false;
    $('#patchApply').onclick = () => doCommit(entry, paths, msg);
    msg.focus();
    msg.setSelectionRange(0, 0); // 첫 줄(제목)부터 보이게
    msg.scrollTop = 0;
  }

  async function doCommit(entry, paths, msg) {
    const message = msg.value.trim();
    if (!message) return ($('#patchStatus').textContent = t('commit.noMessage'));
    $('#patchApply').disabled = true;
    $('#patchStatus').textContent = t('commit.running');
    const out = $('#patchTestOut');
    try {
      const r = await host.git.commit({ paths, message });
      out.hidden = false;
      const pre = document.createElement('pre');
      pre.className = 'test-output';
      pre.textContent = r?.output || r?.error || '';
      out.replaceChildren(span(r?.ok ? 'test-badge good' : 'test-badge bad', r?.ok ? t('commit.ok', { hash: r.hash || '' }) : r?.error || t('commit.failedPlain')), pre);
      if (!r?.ok) {
        $('#patchStatus').textContent = '';
        $('#patchApply').disabled = false;
        return;
      }
      entry.committed = r.hash || 'ok';
      P.saveState();
      for (const [id, b] of P.bars) if (b.applied === entry) P.renderBar(id);
      $('#patchStatus').textContent = t('commit.okNote');
      $('#patchApply').hidden = true;
    } catch (err) {
      out.hidden = false;
      out.replaceChildren(span('test-err', err.message));
      $('#patchApply').disabled = false;
    }
  }

  /** 요약 부탁: 그 패널에 경로 목록만 보내고, 답이 끝나면(onPanelAnswerDone) 메시지 칸의 첫 줄에 넣는다 */
  async function askSummary(src, paths, msg, btn) {
    if (!src || !P.allowedFor(src.id)) return;
    btn.disabled = true;
    const res = await host.sendFollowUp(src.id, CM.summaryPrompt(paths));
    if (!res?.ok) {
      btn.disabled = false;
      return ($('#patchStatus').textContent = res?.error || t('offer.failed'));
    }
    $('#patchStatus').textContent = t('commit.asking', { name: src.name });
    summaryWait.set(src.id, (md) => {
      btn.disabled = false;
      const line = CM.parseSummary(md);
      if (!line) return ($('#patchStatus').textContent = t('commit.askEmpty'));
      if (!msg.isConnected) return; // 창을 닫았다
      msg.value = CM.withSubject(msg.value, line);
      $('#patchStatus').textContent = t('commit.askDone', { name: src.name });
    });
  }

  /** 요약 답이 왔을 때 (project.js onPanelAnswerDone이 먼저 부른다) → 처리했으면 true */
  function onSummaryAnswer(id, md) {
    const fn = summaryWait.get(id);
    if (!fn) return false;
    summaryWait.delete(id);
    fn(md);
    if (P.bars.has(id)) P.renderBar(id); // 답하는 동안 내려간 "적용됨" 바를 다시 띄운다
    return true;
  }

  Object.assign(P, { canOfferCommit, openCommit, onSummaryAnswer, summaryWait });
})();
