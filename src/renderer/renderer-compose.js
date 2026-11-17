'use strict';

// 앱 화면 — 종합 · 첨부 파일 · 웹페이지로 질문 · 보내기 · 전체 상태(state) 받기 · 툴바 (Windows 앱과 크롬 확장이 똑같이 씀).
// renderer.js · renderer-views.js 다음, project.js 앞에 읽힌다 (v0.24.0에서 나눔). 본체의 state 알림을 받는 곳이 여기라
// 화면 함수가 모두 읽힌 뒤에 그린다.
//
// [쉽게 말하면] 아래 공통 입력창으로 질문을 보내는 일과, 본체가 알려 주는 "지금 상태"로 화면 전체를 다시 그리는 일을 합니다.

// ---------- 교차검토(종합) ----------

// 종합 담당 AI 고르기 목록과 "완료 후 자동" 체크 상자를 지금 상태에 맞춥니다.
/** 판정 · 종합을 맡길 수 있는 AI: 열린 패널 + (설정에서 켰고 패널이 없으면) 패널 없이 묻는 로컬 LLM (v0.29.0) */
function judgeChoices() {
  const open = state.rects.map((r) => r.id);
  const local = state.local?.enabled && !open.includes('local') ? [{ id: 'local', name: t('local.judgeHeadless') }] : [];
  return [...open.map((id) => ({ id, name: state.services.find((s) => s.id === id)?.name || id })), ...local];
}

function renderSynth() {
  const select = $('#synthTarget');
  const open = state.rects.map((r) => r.id);
  const choices = judgeChoices();
  select.replaceChildren(...choices.map((c) => Object.assign(document.createElement('option'), { value: c.id, textContent: c.name })));
  // 저장된 종합 담당이 고를 수 없으면 첫 패널로 바꿔 저장한다.
  if (open.length && !choices.some((c) => c.id === state.synthTarget)) host.setSynth({ target: open[0] });
  else select.value = state.synthTarget;
  $('#autoSynth').checked = !!state.autoSynth;
  // 로컬 LLM을 패널 없이 판정으로 쓰면 답한 패널이 하나여도 종합할 수 있다
  $('#synthBtn').disabled = open.length < (state.synthTarget === 'local' && !open.includes('local') ? 1 : 2);
  $('#debateBtn').disabled = open.length < 2; // 토론은 패널이 2개 이상일 때 (v0.26.0)
}

$('#synthTarget').addEventListener('change', (e) => host.setSynth({ target: e.target.value }));
$('#autoSynth').addEventListener('change', (e) => host.setSynth({ auto: e.target.checked }));
$('#synthBtn').addEventListener('click', () => {
  $('#synthResult').hidden = true;
  host.runSynth($('#synthTarget').value);
});
// [결과 보기]: 기록 화면에서 그 질문을 연다 (패널 없는 로컬 LLM 종합, v0.29.0)
$('#synthResult').addEventListener('click', async () => {
  const id = $('#synthResult').dataset.historyId;
  host.setView('history');
  await new Promise((r) => setTimeout(r, 150));
  if (id) renderHistoryDetail(id);
});

// 종합 요청 진행 상황(보내는 중·보냄·실패)을 입력창 아래 안내 글로 보여 줍니다.
host.on('synth:status', ({ state: st, judge, count, error, cause, mode, trimmed, headless, historyId }) => {
  if (mode === 'debate') return; // 토론 진행은 debate-ui.js가 보여 준다 (v0.26.0)
  const prefix = cause === 'auto' ? t('ui.synth.autoPrefix') : '';
  const what = mode === 'analysis' ? t('ui.synth.whatAnalysis') : t('ui.synth.whatSynth');
  $('#sendHint').textContent =
    (st === 'error'
      ? `${prefix}${error}`
      : st === 'sending'
        ? prefix + t('ui.synth.sending', { judge, n: count, what })
        : st === 'done'
          ? t('ui.synth.done', { judge, what }) + (mode === 'analysis' ? t('ui.synth.doneAnalysisHint') : headless ? t('local.synthDoneHistory') : '')
          : prefix + t('ui.synth.sent', { judge, n: count, what })) +
    (trimmed?.length && st !== 'error' ? t('local.trimmedHint', { names: trimmed.join(', ') }) : '');
  // 패널 없는 로컬 LLM의 종합 결과 (v0.29.0): 패널에 답이 보이지 않으므로 [결과 보기]로 기록을 연다
  $('#synthResult').hidden = !(st === 'done' && headless && mode !== 'analysis' && historyId);
  $('#synthResult').dataset.historyId = historyId || '';
  // 분석 진행 표시: 보내는 중·기다리는 중이면 분석 탭에 안내, 끝나거나 실패하면 지움
  if (mode === 'analysis' && (st === 'sending' || st === 'sent')) {
    compareView.pending = judge;
    compareView.error = null;
  } else if (st === 'done' || st === 'error') {
    compareView.pending = null;
    compareView.error = st === 'error' && mode === 'analysis' ? error : null;
  }
  if (state?.chatView === 'compare') {
    if (st === 'done' && mode === 'analysis') renderCompare(); // 끝나면 결과를 바로 그린다
    else renderCompareAnalysis();
  }
});

// ---------- 질문 템플릿 ----------
// 템플릿 고르기·변수 입력·스킬은 library.js가 한다 (window.libApplyTemplate · libSkillPrefix).

// ---------- 첨부 파일 ----------
// 공통 입력창에 끌어다 놓기 · Ctrl+V · 📎 버튼으로 올린 파일을 보낼 대상 패널마다 첨부한다.
// 한도는 메인(Electron) / host.js(확장 프로그램)에서 state.attachLimits로 받는다.

let attachments = []; // [{ file, url(이미지 미리보기) }]

const fmtSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
const fileKind = (type) => (/^image\//.test(type || '') ? 'image' : 'document');
const KIND_TEXT = {
  get image() { return t('ui.kind.image'); },
  get document() { return t('ui.kind.document'); },
};

// 첨부 줄 옆의 안내 글 (예: "Duck.ai은(는) 문서 빼고 보냄")
function attachHint(text, cls = '') {
  const hint = $('#attachHint');
  hint.textContent = text;
  hint.className = `attach-hint ${cls}`;
}

/** 파일을 첨부 목록에 더한다. 한도를 넘는 파일은 빼고 이유를 보여 준다. */
/** 올린 파일을 첨부 목록에 더합니다. 개수(10개)·크기(파일당 25MB, 합계 50MB)를 넘는 파일은 빼고 이유를 알립니다. */
function addFiles(list) {
  const limits = state?.attachLimits;
  if (!limits || state.mode !== 'chat') return;
  const rejected = [];
  let total = attachments.reduce((n, a) => n + a.file.size, 0);
  for (const file of list) {
    if (attachments.length >= limits.maxFiles) rejected.push(t('ui.attach.maxFiles', { name: file.name, n: limits.maxFiles }));
    else if (file.size > limits.maxFileBytes) rejected.push(t('ui.attach.tooBig', { name: file.name, size: fmtSize(limits.maxFileBytes) }));
    else if (total + file.size > limits.maxTotalBytes) rejected.push(t('ui.attach.totalTooBig', { name: file.name, size: fmtSize(limits.maxTotalBytes) }));
    else if (!file.size && !file.type) rejected.push(t('ui.attach.folderOrEmpty', { name: file.name }));
    else {
      total += file.size;
      attachments.push({ file, url: fileKind(file.type) === 'image' ? URL.createObjectURL(file) : null });
    }
  }
  renderAttachments();
  if (rejected.length) attachHint(t('ui.attach.rejected', { list: rejected.join(' / ') }), 'error');
  $('#prompt').focus();
}

// ---------- 보고 있는 웹페이지로 질문 (v0.15.0, 크롬 확장) ----------
// 오른쪽 클릭 메뉴(background.js)가 남긴 요청을 받아 공통 입력창에 넣는다.
//   선택한 글 → 입력창에 그대로, 페이지 본문 → 비밀 정보 검사 후 page.md로 첨부. 채팅 화면이 아니면 들어갈 때까지 기다린다.
let pendingWebAsk = null;

async function checkWebAsk() {
  if (!host.takeWebAsk) return; // Windows 앱에는 이 메뉴가 없다
  const raw = pendingWebAsk || (await host.takeWebAsk());
  pendingWebAsk = null;
  const ask = raw && MLA.webAsk.normalize(raw);
  if (!ask) return;
  if (state?.mode !== 'chat') {
    pendingWebAsk = raw; // 모델을 고른 뒤 채팅 화면에서 넣는다
    return;
  }
  applyWebAsk(ask);
}

function applyWebAsk(ask) {
  const W = MLA.webAsk;
  const { scanSecrets, describeSecrets } = MLA.secretScan;
  const hits = scanSecrets(ask.text);
  if (ask.kind === 'question') {
    // 사이드탭 [app ↗]: 페이지 없이 쓰던 질문만 넘어옴 (v0.21.0)
    host.setView('panels');
    $('#prompt').value = ask.question + ($('#prompt').value ? `\n\n${$('#prompt').value}` : '');
    $('#prompt').focus();
    attachHint(t('ui.webAsk.questionIn'));
    return;
  }
  if (hits.length && !confirm(t('ui.webAsk.secrets', { what: t(ask.kind === 'page' ? 'ui.webAsk.whatPage' : 'ui.webAsk.whatSelection'), list: describeSecrets(hits) }))) {
    attachHint(t('ui.webAsk.secretsCanceled'), 'warn');
    return;
  }
  host.setView('panels');
  const prompt = $('#prompt');
  if (ask.kind === 'selection') {
    prompt.value = W.selectionPrompt(ask) + (prompt.value ? `\n\n${prompt.value}` : '');
  } else {
    const f = W.pageFile(ask);
    addFiles([new File([f.text], f.name, { type: f.type })]);
    prompt.value = W.pagePrompt(ask) + (prompt.value ? `\n\n${prompt.value}` : '');
  }
  const end = ask.kind === 'selection' ? W.selectionPrompt(ask).length : W.pagePrompt(ask).length;
  // 사이드탭에서 쓰던 질문이 함께 오면 "질문: " 뒤에 넣는다 (v0.21.0)
  if (ask.question) prompt.value = prompt.value.slice(0, end) + ask.question + prompt.value.slice(end);
  prompt.focus();
  const caret = end + (ask.question ? ask.question.length : 0);
  prompt.setSelectionRange(caret, caret); // "질문: " 바로 뒤(또는 넘어온 질문 끝)에 이어 쓰게
  prompt.scrollTop = prompt.scrollHeight; // 입력칸이 작아서, 글쓴이가 쓸 "질문: " 줄이 보이게
  attachHint(t(ask.kind === 'page' ? 'ui.webAsk.pageAttached' : 'ui.webAsk.selectionAdded') + (ask.truncated ? t('ui.webAsk.truncated') : ''));
}

window.addEventListener('focus', checkWebAsk); // 열려 있던 앱 탭을 메뉴가 앞으로 가져왔을 때
window.addEventListener('mla:web-ask', checkWebAsk);

function removeAttachment(i) {
  const [a] = attachments.splice(i, 1);
  if (a?.url) URL.revokeObjectURL(a.url);
  renderAttachments();
}

function clearAttachments() {
  for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url);
  attachments = [];
  renderAttachments();
}

// 첨부 파일 칩(이름 · 크기 · ✕ 빼기 버튼)들을 그립니다.
function renderAttachments() {
  $('#attachList').replaceChildren(
    ...attachments.map((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.title = `${a.file.name} (${fmtSize(a.file.size)})`;
      if (a.url) chip.append(Object.assign(document.createElement('img'), { src: a.url, alt: '' }));
      else chip.append(span('file-icon', '[f]'));
      chip.append(span('file-name', a.file.name), span('file-size', fmtSize(a.file.size)));
      chip.append(button('✕', t('ui.attach.remove'), () => removeAttachment(i)));
      return chip;
    }),
  );
  renderAttachHint();
}

/** 첨부가 없으면 사용법, 있으면 합계와 "이 종류는 받지 않는 대상"을 미리 알려 준다. */
function renderAttachHint() {
  const limits = state?.attachLimits;
  if (!limits) return;
  if (!attachments.length) {
    return attachHint(
      t('ui.attach.howTo', { n: limits.maxFiles, perFile: fmtSize(limits.maxFileBytes), total: fmtSize(limits.maxTotalBytes) }),
    );
  }
  const total = attachments.reduce((n, a) => n + a.file.size, 0);
  const kinds = [...new Set(attachments.map((a) => fileKind(a.file.type)))];
  const warns = [...targets]
    .map((id) => state.services.find((s) => s.id === id))
    .filter((svc) => svc && kinds.some((k) => !svc.accept.includes(k)))
    .map((svc) => t('ui.attach.notAccepted', { name: svc.name, kinds: kinds.filter((k) => !svc.accept.includes(k)).map((k) => KIND_TEXT[k]).join('·') }));
  attachHint(`${t('ui.attach.summary', { n: attachments.length, size: fmtSize(total) })}${warns.length ? ` — ${warns.join(', ')}` : ''}`, warns.length ? 'warn' : '');
}

$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});

// 붙여넣기: 글이 함께 있으면(문서에서 복사한 글 등) 글만 붙이고, 파일·스크린샷만 있을 때 첨부한다.
document.addEventListener('paste', (e) => {
  if (state?.mode !== 'chat' || state.chatView !== 'panels') return;
  const target = e.target;
  if (target !== $('#prompt') && target !== document.body) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || e.clipboardData.getData('text/plain')) return;
  e.preventDefault();
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  addFiles(
    files.map((f, i) =>
      // 스크린샷은 이름이 모두 "image.png"라 구분되게 바꾼다.
      /^image\.\w+$/.test(f.name)
        ? new File([f], `붙여넣은-이미지-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${f.name.split('.').pop()}`, { type: f.type })
        : f,
    ),
  );
});

// 끌어다 놓기: 앱 화면 어디에 놓아도 공통 입력창에 첨부한다 (패널 위에 놓으면 그 사이트가 받는다).
// 파일을 창에 떨어뜨리면 그 파일로 이동해 버리는 기본 동작도 여기서 막는다.
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
// 링크·글자를 입력칸 밖에 놓으면 창이 그 주소로 이동하는 기본 동작을 막는다 (입력칸에는 그대로 넣을 수 있다).
const editableTarget = (e) => !!e.target?.closest?.('textarea, input, [contenteditable="true"]');
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (hasFiles(e) || editableTarget(e)) return;
    e.preventDefault();
    if (type === 'dragover') e.dataTransfer.dropEffect = 'none';
  });
}
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  if (state?.mode === 'chat') document.body.classList.add('drag-files');
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('drag-files');
});
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state?.mode === 'chat' ? 'copy' : 'none';
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-files');
  addFiles([...e.dataTransfer.files]);
});

let sending = false;

/**
 * 보낼 것 만들기 (보내지는 않음, v0.25.0에서 send()에서 나눔): 첨부 파일 읽기 → 템플릿 → 프로젝트 맥락 → 스킬 지침.
 * → { payload: { text, files, opts }, skill } | null(사용자가 취소)
 * 패널마다 실제로 들어갈 글은 이 payload로 shared/send-plan.js가 계산한다 (보내기 전 미리보기 · rounds.sendAll이 같은 계산).
 */
async function buildPayload(text, ids) {
  const files = await Promise.all(
    attachments.map(async ({ file }) => ({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      data: await file.arrayBuffer(),
    })),
  );
  // 글 없이 파일만 보낼 때는 템플릿을 붙이지 않는다. 변수가 있는 템플릿은 변수 입력 화면을 거친다 (null이면 취소).
  const qText = text ? await window.libApplyTemplate(text) : '';
  if (qText === null) return null;
  let payload = { text: qText, files, opts: {} };
  // 프로젝트 모드: 프로젝트 구조와 고른 파일 내용을 붙인다 (project.js). null이면 사용자가 취소했다.
  if (window.projectPrepareSend) payload = await window.projectPrepareSend(payload, ids);
  if (!payload) return null;
  // 스킬: 이 대화에 아직 받지 않은 패널(또는 "매 질문마다"면 모두)의 글 앞에 지침을 붙인다 (library.js)
  const skill = window.libSkillPrefix?.(ids);
  if (skill?.cancel) {
    window.onProjectSendCanceled?.(); // 프로젝트가 붙인 파일은 보내지 않았다
    return null; // 지침이 너무 길어 사용자가 보내기를 멈췄다 (입력 내용은 남김)
  }
  if (skill) payload = { ...payload, opts: { ...payload.opts, prefixById: skill.prefixById } };
  return { payload, skill };
}

/**
 * 보내기 버튼(또는 Enter)을 눌렀을 때: 템플릿·스킬·프로젝트 맥락을 붙여 고른 AI들에게 동시에 보냅니다.
 * 실제 전송은 본체(host.sendPrompt)가 하고, 결과(서비스별 성공·실패)를 받아 안내합니다.
 * 보내기 전 미리보기(설정에서 켬, 또는 Shift+클릭 · Ctrl+Shift+Enter로 이번만)가 있으면 그 창에서 [보내기]를 눌러야 보냅니다 (v0.25.0).
 */
async function send({ preview = false } = {}) {
  const box = $('#prompt');
  const text = box.value.trim();
  if ((!text && !attachments.length) || sending) return;
  const ids = [...targets];
  if (!ids.length) return alert(t('ui.send.noTargets'));
  sending = true;
  $('#sendBtn').disabled = true;
  try {
    const built = await buildPayload(text, ids);
    if (!built) return;
    const { payload, skill } = built;
    if ((preview || state?.sendPreview) && !(await window.openSendPreview(payload, ids))) {
      window.onProjectSendCanceled?.();
      $('#sendHint').textContent = t('preview.canceled');
      return; // 입력 내용 · 첨부는 그대로 둔다
    }
    resetFeedback(ids); // 새 질문 = 새 기록: 지난 답변의 평가 버튼을 내린다
    const results = await host.sendPrompt(payload.text, ids, payload.files, payload.opts);
    window.onSkillSent?.(skill, results.filter((r) => r.ok).map((r) => r.id));
    const failed = results.filter((r) => !r.ok);
    window.onProjectSent?.(results.filter((r) => r.ok).map((r) => r.id)); // 프로젝트 모드: AI마다 받은 파일 내용을 기억
    const noAttach = results.filter((r) => r.ok && r.attach && r.attach.state !== 'ok');
    const name = (id) => state.services.find((s) => s.id === id)?.name || id;
    if (!failed.length) {
      box.value = '';
      clearAttachments();
    }
    $('#sendHint').textContent = failed.length
      ? t('ui.send.failed', { names: failed.map((r) => name(r.id)).join(', ') })
      : `${t('ui.send.sent', { n: results.length })}${skill ? ` · ${t('ui.send.skillCount', { n: skill.ids.length })}` : ''}${noAttach.length ? ` · ${noAttach.map((r) => `${name(r.id)}(${ATTACH_TEXT[r.attach.state]})`).join(', ')}` : ''}`;
  } catch (err) {
    $('#sendHint').textContent = t('ui.send.error', { msg: err.message });
  } finally {
    sending = false;
    $('#sendBtn').disabled = false;
    box.focus();
  }
}

// Shift+클릭: 설정과 상관없이 이번만 보내기 전 미리보기 (v0.25.0)
$('#sendBtn').addEventListener('click', (e) => send({ preview: e.shiftKey }));
$('#prompt').addEventListener('keydown', (e) => {
  // 한글 조합 중 Enter는 글자 확정용이라 보내지 않는다. Ctrl+Shift+Enter는 미리보기를 거쳐 보낸다.
  if (e.key !== 'Enter' || e.isComposing) return;
  const previewKey = e.shiftKey && (e.ctrlKey || e.metaKey);
  if (e.shiftKey && !previewKey) return; // Shift+Enter = 줄바꿈
  e.preventDefault();
  send({ preview: previewKey });
});

// ---------- 전체 상태 ----------

// 본체가 "전체 상태"를 보내올 때마다 실행되는 가장 중요한 부분입니다.
// 지금 화면(패널·비교·기록·설정 …)에 맞게 body의 data-view 값을 바꾸면, styles.css가 그에 맞는 화면만 보여 줍니다.
// 새로 들어온 화면이면 내용을 새로 그립니다 (예: 비교 화면에 처음 들어오면 답변을 다시 읽음).
/** 설정 › 언어를 바꿨을 때 (v0.30.0): 화면을 다시 읽지 않고 그 자리에서 새 언어로 다시 그린다.
 *  (다시 읽으면 패널 상태 · 프로젝트 작업 · 쓰던 글이 사라지고, 크롬 확장은 AI 사이트 iframe까지 다시 열린다.)
 *  고정 글은 apply()가, 지금 화면은 state 처리(아래)가, 라이브러리 등은 'mla:lang' 이벤트를 듣고 다시 그린다.
 *  패널 상태 글처럼 본체 알림으로 쓰는 글은 다음 알림 때 새 언어가 된다. */
function relocalize(lang) {
  shownLang = MLA.i18n.setLang(lang);
  MLA.i18n.apply(document);
  for (const [id, p] of panels) {
    p.loginBtn.textContent = UI.loginButton.label;
    p.loginBtn.title = UI.loginButton.title;
    const name = p.el.querySelector('.panel-head .name');
    if (name) name.textContent = svcLabel(state.services.find((s) => s.id === id)) || name.textContent;
  }
  document.dispatchEvent(new CustomEvent('mla:lang', { detail: lang }));
}

host.on('state', (next) => {
  const modeChanged = !state || state.mode !== next.mode;
  if (modeChanged) setTimeout(checkWebAsk, 300); // 웹페이지 질문(크롬 확장): 채팅 화면에 들어오면 기다리던 요청을 넣는다
  // 언어를 바꿨으면 (v0.30.0) 고정 글을 다시 넣고, 지금 화면을 처음 들어온 것처럼 다시 그린다
  const langChanged = !!next.uiLang && next.uiLang !== shownLang;
  const enteredCompare = next.chatView === 'compare' && (modeChanged || langChanged || state.chatView !== 'compare');
  const enteredHistory = next.chatView === 'history' && (modeChanged || langChanged || state.chatView !== 'history');
  const enteredHelp = next.chatView === 'help' && (modeChanged || langChanged || state.chatView !== 'help');
  const enteredChanges = next.chatView === 'changes' && (modeChanged || langChanged || state.chatView !== 'changes');
  state = next;
  if (langChanged) relocalize(next.uiLang);
  if (state.diag) {
    Object.assign(diagById, state.diag);
    for (const id of panels.keys()) renderDiagBadge(id);
  }
  document.body.dataset.mode = state.mode;
  document.body.dataset.view = state.mode === 'chat' ? state.chatView : '';
  $('#compareBtn').classList.toggle('active', state.chatView === 'compare');
  $('#historyBtn').classList.toggle('active', state.chatView === 'history');
  if (enteredCompare) renderCompare();
  if (enteredHistory) renderHistoryList();
  if (enteredChanges) window.renderChanges?.();
  $('#changesBtn').classList.toggle('active', state.chatView === 'changes');
  window.onProjectState?.(); // 프로젝트 사이드바 보이기/숨기기
  if (enteredHelp) renderHelp();
  else if (state.chatView === 'help') {
    renderRemoteStatus(); // 설정 화면을 보는 중에 갱신 결과가 오면 바로 반영
    renderDiagTable();
  }
  $('#helpBtn').classList.toggle('active', state.chatView === 'help');
  $('#hint').textContent = UI.hints[state.mode];
  for (const b of document.querySelectorAll('[data-layout]')) {
    b.classList.toggle('active', b.dataset.layout === state.layout);
  }
  if (state.mode === 'pick' && (modeChanged || langChanged)) renderPick();
  syncPanels();
  noteRemote();
  renderStatusLine();
  if (diagOpen) {
    // Esc 등으로 'dialog' 화면을 떠났으면 창도 닫는다
    if (diagOpen.dialog && state.chatView !== 'dialog') {
      diagOpen = null;
      $('#diagModal').hidden = true;
    } else renderDiagModal();
  }
  window.onPreviewState?.(); // 보내기 전 미리보기 창: 그 화면을 떠났으면 보내지 않고 닫는다 (send-preview.js)
  window.onDebateState?.(); // 토론 설정 창도 같은 규칙 (debate-ui.js, v0.26.0)
  window.onOnboardState?.(); // 첫 사용 안내: 처음이면 띄우고, 화면을 떠났으면 닫는다 (onboarding.js, v0.31.0)
  if (state.chatView === 'help') renderUpdate();
  // 툴바 이름 뒤의 "~/chat" 같은 경로 = 지금 보는 화면
  $('.brand').dataset.path = state.mode === 'chat' ? (state.chatView === 'panels' || state.chatView === 'dialog' ? 'chat' : state.chatView) : state.mode;
  if (state.mode === 'chat') {
    renderTargets();
    renderSynth();
  }
});

for (const b of document.querySelectorAll('[data-layout]')) {
  b.addEventListener('click', () => host.setLayout(b.dataset.layout));
}
$('#reloadAll').addEventListener('click', () => host.panelAction('*', 'reload'));
$('#newChatAll').addEventListener('click', () => host.panelAction('*', 'newchat'));
$('#copyAll').addEventListener('click', async () => {
  const r = await host.copyAnswer('*');
  $('#sendHint').textContent = r.copied ? t('ui.copyAnswers.done', { n: r.copied }) : t('ui.copyAnswers.none');
});
$('#pickBtn').addEventListener('click', () => host.pickModels());
$('#logoutBtn').addEventListener('click', () => {
  if (confirm(t('ui.logoutConfirm'))) host.logout();
});
