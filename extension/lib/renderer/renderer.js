// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/renderer.js)
'use strict';

// ============================================================================
// 앱 "화면"의 기본 동작을 맡는 파일입니다 (Windows 앱과 크롬 확장이 똑같이 씀).
//
// [이 파일이 하는 일 — 쉽게 말하면]
//   - 모델 고르기 화면, 패널 머리줄(이름·상태·버튼), 아래 공통 입력창, 첨부 파일
//   - 답변 비교·기록·설정 화면, 단축키, 종합 버튼
//   - 본체(host)가 보내는 알림(state = 전체 상태, panel:status = 패널 상태)을 받아 화면을 고쳐 그림
// 프로젝트 모드는 project.js, 라이브러리·스킬은 library.js가 이어서 맡습니다 (이 파일 다음에 읽힘).
//
// [용어 풀이]
//   - host: 본체에 일을 부탁하는 창구 (Windows 앱: preload.js / 크롬 확장: extension/host.js)
//   - state: 본체가 알려 주는 "지금 상태" (어느 화면인지, 고른 모델, 배치, 설정 등)
//   - $('#이름'): 화면(index.html)에서 id가 그 이름인 요소를 찾는 짧은 도우미
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const panelsEl = $('#panels');
const panels = new Map(); // id -> { el, dot, url, status }
let state = null;

// 실행 환경(Electron 앱 / 크롬 확장 프로그램)마다 다른 화면 문구. host.ui로 바꿀 수 있다.
const UI = {
  hints: {
    login: 'Google 계정으로 로그인해 주세요',
    pick: '로그인됨 · 모델을 선택하세요',
    chat: '패널마다 Google로 자동 로그인을 시도합니다',
  },
  pickNote: '선택한 모델만 패널로 열고, 각 서비스에는 Google 계정으로 로그인합니다.',
  loginButton: { label: 'G 로그인', title: 'Google로 다시 로그인 시도' },
  devtools: true, // 패널 머리줄의 개발자 도구 버튼
  ...(host.ui || {}),
};

const LOGIN_TEXT = {
  'needs-login': '로그인 필요',
  'logging-in': 'Google로 로그인 중…',
  google: 'Google 화면에서 계속해 주세요',
  captcha: '사람 확인(캡차)을 직접 풀어 주세요',
  ready: '',
};

// 버튼 하나 만들기 도우미: 글자(label), 마우스를 올리면 보이는 설명(title), 눌렀을 때 할 일(onClick)
function button(label, title, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// 짧은 글자 조각(span) 만들기 도우미
function span(className, text = '') {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

// ---------- 모델 선택 화면 ----------

const pickedIds = () => [...document.querySelectorAll('#modelList input:checked')].map((b) => b.value);

/** 모델 고르기 화면을 그립니다: 서비스마다 체크 상자, 최대 6개까지 고르기 */
function renderPick() {
  $('#pickNote').textContent = `${UI.pickNote} 한 번에 최대 ${state.maxSelected}개까지 고를 수 있습니다.`;
  const list = $('#modelList');
  list.replaceChildren();
  for (const svc of state.services) {
    const label = document.createElement('label');
    label.className = 'model';
    label.style.setProperty('--svc', svc.color);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = svc.id;
    box.checked = state.selected.includes(svc.id);
    box.addEventListener('change', updatePickLimit);
    label.append(box, span('swatch'), span('name', svc.name), span('url', new URL(svc.url).hostname));
    list.append(label);
  }
  updatePickLimit();
}

// 최대 개수만큼 고르면 나머지 칸은 고를 수 없게 막는다.
function updatePickLimit() {
  const count = pickedIds().length;
  const full = count >= state.maxSelected;
  for (const box of document.querySelectorAll('#modelList input')) {
    box.disabled = full && !box.checked;
    box.closest('.model').classList.toggle('disabled', box.disabled);
  }
  $('#pickCount').textContent = `${count} / ${state.maxSelected} 선택${count > 4 ? ' · 패널마다 메모리를 수백 MB 씁니다' : ''}`;
  $('#pickCount').classList.toggle('full', full);
}

$('#openBtn').addEventListener('click', () => {
  const ids = pickedIds();
  if (!ids.length) return alert('모델을 하나 이상 선택해 주세요.');
  if (ids.length > state.maxSelected) return alert(`모델은 최대 ${state.maxSelected}개까지 고를 수 있습니다.`);
  host.openModels(ids);
});

// ---------- 패널 머리줄 ----------

/**
 * 본체가 알려 준 패널 위치(state.rects)에 맞춰 화면의 패널 머리줄을 만들고 옮깁니다.
 * 실제 웹페이지(AI 사이트)는 본체가 따로 그 자리에 얹고, 이 화면은 머리줄과 테두리만 그립니다.
 */
function syncPanels() {
  const ids = state.rects.map((r) => r.id);
  for (const [id, p] of panels) {
    if (!ids.includes(id)) {
      p.el.remove();
      panels.delete(id);
    }
  }
  for (const r of state.rects) {
    let p = panels.get(r.id);
    if (!p) p = createPanel(state.services.find((s) => s.id === r.id));
    p.el.hidden = !!r.hidden;
    p.el.classList.toggle('focused', !!r.focused);
    p.focusBtn.textContent = r.focused ? '⤡' : '⤢';
    p.focusBtn.title = r.focused ? '원래 배치로 돌아가기' : '이 패널만 크게 보기';
    Object.assign(p.el.style, {
      left: `${r.frame.x}px`,
      top: `${r.frame.y}px`,
      width: `${r.frame.width}px`,
      height: `${r.frame.height}px`,
    });
  }
}

/**
 * 패널 하나의 머리줄을 만듭니다: 점(상태 색) · 이름 · 주소 · 상태 글자 · 버튼들
 * 아래쪽 변경 바(프로젝트 모드, 수정안이 있을 때만)는 project.js가 채운다.
 * 버튼: 📋 파일 모아보기 · 📂 요청 파일 보내기 · 로그인 · 복사 · ⤢ 크게 보기 · ＋ 새 대화 · ← 뒤로 · ⌂ 처음 주소 · ↻ 새로고침
 */
function createPanel(svc) {
  const el = document.createElement('section');
  el.className = 'panel';
  el.style.setProperty('--svc', svc.color);

  const head = document.createElement('div');
  head.className = 'panel-head';
  const dot = span('dot');
  const url = span('url', svc.url);
  const status = span('status');
  const attachBadge = span('attach-badge');
  attachBadge.hidden = true;
  // 프로젝트 모드: 답변 끝의 NEED_FILES 요청을 보면 project.js가 이 버튼을 띄운다.
  const needBtn = button('', '', () => window.onNeedFilesClick?.(svc.id));
  needBtn.className = 'need-btn';
  needBtn.hidden = true;
  // 답변에 파일 수정안("파일: 경로" 코드 블록 등)이 있으면 project.js가 이 버튼을 띄운다 (프로젝트를 열지 않아도).
  const collectBtn = button('', '', () => window.onCollectClick?.(svc.id));
  collectBtn.className = 'collect-btn';
  collectBtn.hidden = true;
  const loginBtn = button(UI.loginButton.label, UI.loginButton.title, () => host.panelAction(svc.id, 'login'));
  loginBtn.className = 'login-btn';
  loginBtn.hidden = true;
  const focusBtn = button('⤢', '이 패널만 크게 보기', () => host.setFocus(svc.id));

  head.append(
    dot,
    span('name', svc.name),
    url,
    status,
    attachBadge,
    collectBtn,
    needBtn,
    loginBtn,
    button('복사', '최신 답변 복사', async () => {
      const r = await host.copyAnswer(svc.id);
      flash(status, r.copied ? '답변을 복사했습니다' : '복사할 답변이 없습니다');
    }),
    focusBtn,
    button('＋', '새 대화', () => host.panelAction(svc.id, 'newchat')),
    button('←', '뒤로', () => host.panelAction(svc.id, 'back')),
    button('⌂', '처음 주소로', () => host.panelAction(svc.id, 'home')),
    button('↻', '새로고침', () => host.panelAction(svc.id, 'reload')),
  );
  if (UI.devtools) head.append(button('{ }', '개발자 도구', () => host.panelAction(svc.id, 'devtools')));
  // 프로젝트 모드: 답변에 수정안이 있으면 project.js가 패널 아래에 이 바를 채워 띄운다 (setChangeBar)
  const changeBar = document.createElement('div');
  changeBar.className = 'change-bar';
  changeBar.hidden = true;
  el.append(head, changeBar);
  panelsEl.append(el);
  head.addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) host.setFocus(svc.id); // 머리줄 빈 곳을 두 번 누르면 크게 보기 / 돌아오기
  });
  const p = { el, dot, url, status, loginBtn, attachBadge, needBtn, collectBtn, focusBtn, changeBar };
  panels.set(svc.id, p);
  return p;
}

/** 패널 아래 변경 바를 띄우거나 내린다. 본체가 웹페이지 높이를 바만큼 줄여 바가 페이지에 가리지 않게 한다. */
function setChangeBar(id, on) {
  const p = panels.get(id);
  if (!p || p.changeBar.hidden === !on) return;
  p.changeBar.hidden = !on;
  host.setPanelBar(id, on);
}

const FINISHED_STATES = new Set(['done', 'timeout', 'no-answer']);

const ANSWER_TEXT = {
  answering: '답변 중…',
  done: '답변 완료',
  timeout: '시간 초과 — 계속 기다리는 중…',
  'no-answer': '답변이 시작되지 않았습니다',
  clear: '',
};

// 상태 글자를 1.8초 동안만 다른 글로 바꿔 보여 주고 원래대로 돌립니다 (예: "답변을 복사했습니다").
function flash(el, text) {
  const prev = { text: el.textContent, state: el.dataset.state };
  el.textContent = text;
  el.dataset.state = 'flash';
  setTimeout(() => {
    if (el.dataset.state !== 'flash') return;
    el.textContent = prev.text;
    el.dataset.state = prev.state || '';
  }, 1800);
}

const SEND_TEXT = { sending: '보내는 중…', sent: '보냄', error: '보내기 실패' };
const ATTACH_TEXT = { failed: '첨부 없이 보냄', skipped: '첨부 없이 보냄', partial: '일부 파일은 빼고 보냄', fallback: '업로드 실패 → 본문으로 보냄' };

// 답변을 기다리는 동안 걸린 시간을 1초마다 보여 준다.
const fmtElapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};

// 답변을 기다리는 패널마다 "답변 중… 12초"처럼 기다린 시간을 1초마다 고쳐 씁니다.
function tickAnswerTimers() {
  for (const p of panels.values()) {
    const st = p.status.dataset.state;
    if (!p.answerStart || (st !== 'answer-answering' && st !== 'answer-timeout')) continue;
    const label = st === 'answer-answering' ? '답변 중…' : '시간 초과 — 계속 기다리는 중…';
    p.status.textContent = `${label} ${fmtElapsed(Date.now() - p.answerStart)}`;
  }
}
setInterval(tickAnswerTimers, 1000);

// 본체가 "이 패널 상태가 바뀌었어"라고 알려 올 때마다 실행됩니다.
// 알림 종류: 불러오는 중(loading) · 주소(url) · 오류(error) · 로그인 상태(login) · 보내기 결과(send) · 답변 상태(answer)
// 답변 완료('done')면 다른 파일들(project.js 등)에게도 알려 📋 파일 모아보기·📂 요청 파일 버튼을 띄우게 합니다.
host.on('panel:status', ({ id, loading, url, error, login, send, answer, chars, late, attach, attaching }) => {
  const p = panels.get(id);
  if (!p) return;
  window.onLibPanelStatus?.(id, { send, answer, error }); // 스킬 압축 요청의 답변을 기다리는 중이면 library.js가 본다
  if (answer === 'clear') {
    p.attachBadge.hidden = true;
    p.needBtn.hidden = true;
    p.collectBtn.hidden = true;
    setChangeBar(id, false);
    window.onPanelCleared?.(id); // 새 대화: 프로젝트 모드에서 이 AI가 아는 파일 내용을 잊는다
    window.onSkillCleared?.(id); // 새 대화: 다음 질문에 스킬 지침을 다시 붙인다
  }
  if (answer === 'done') window.onPanelAnswerDone?.(id); // 파일 모아보기 버튼, 프로젝트 모드: NEED_FILES 확인
  if (answer) {
    if (answer === 'answering') {
      p.answerStart = Date.now();
      setChangeBar(id, false); // 페이지에서 직접 물어본 경우에도 지난 답변의 변경 바는 내린다
    }
    p.status.textContent =
      answer === 'done' ? `${ANSWER_TEXT.done} · ${chars}자${late ? ' (늦게 끝남)' : ''}` : ANSWER_TEXT[answer];
    p.status.dataset.state = `answer-${answer}`;
    tickAnswerTimers();
    updateAnswerSummary();
    // 비교 화면을 보고 있으면 답변이 끝날 때마다 새로 읽는다.
    if (answer === 'done' && state?.chatView === 'compare') renderCompare();
    if (FINISHED_STATES.has(answer) && state?.chatView === 'history') setTimeout(renderHistoryList, 800);
    return;
  }
  if (loading !== undefined) p.dot.classList.toggle('loading', loading);
  if (url) {
    p.url.textContent = url;
    if (!error) p.dot.classList.remove('error'); // 다시 열려서 연결되면 오류 표시를 지운다
  }
  if (send) {
    p.status.textContent = send === 'error' ? `${SEND_TEXT.error}: ${error}` : SEND_TEXT[send];
    p.status.dataset.state = `send-${send}`;
    if (send === 'sending') {
      p.attachBadge.hidden = true;
      p.needBtn.hidden = true;
      p.collectBtn.hidden = true;
      setChangeBar(id, false);
      if (attaching) p.status.textContent = `파일 ${attaching}개 첨부 후 보내는 중…`;
    }
    // 첨부에 실패한 패널은 글만 보냈다. 머리줄에 표시를 남겨 둔다 (다음에 보내거나 새 대화를 열 때까지).
    const warn = send === 'sent' && attach && ATTACH_TEXT[attach.state];
    if (warn) {
      p.status.textContent = `보냄 · ${warn}`;
      p.status.dataset.state = 'send-attach-warn';
      p.attachBadge.hidden = false;
      p.attachBadge.textContent = `📎 ${warn}`;
      p.attachBadge.title = attach.error || warn;
    }
    if (send === 'sent') {
      const st = p.status.dataset.state;
      setTimeout(() => p.status.dataset.state === st && (p.status.textContent = ''), warn ? 8000 : 3000);
    }
    return;
  }
  if (error) {
    p.url.textContent = `오류: ${error}`;
    p.dot.classList.add('error');
  }
  if (login) {
    p.dot.classList.toggle('ready', login === 'ready');
    p.loginBtn.hidden = login !== 'needs-login';
    // 로그인 확인은 대화 중에도 반복된다. "로그인됨"이 전송·답변 상태 글을 지우지 않게 한다.
    const showingLogin = !p.status.dataset.state || p.status.dataset.state in LOGIN_TEXT;
    if (login === 'ready' && !showingLogin) return;
    p.status.textContent = LOGIN_TEXT[login] ?? '';
    p.status.dataset.state = login;
  }
});

// ---------- 공통 입력창 ----------

// 입력창 위에 "답변 3개 중 2개 완료" 같은 요약을 보여 줍니다.
function updateAnswerSummary() {
  const states = [...panels.values()].map((p) => p.status.dataset.state || '');
  const asked = states.filter((s) => s.startsWith('answer-') && s !== 'answer-clear').length;
  if (!asked) return;
  const done = states.filter((s) => s === 'answer-done').length;
  $('#sendHint').textContent = done === asked ? `답변 ${done}개 모두 완료` : `답변 완료 ${done}/${asked}`;
}

const targets = new Set(); // 보낼 대상 서비스 id
let knownTargets = new Set(); // 지금까지 칩을 만든 서비스 (새로 열린 패널은 기본으로 켠다)

// "보낼 대상" 칩(서비스 이름 단추)들을 그립니다. 누르면 그 서비스에 보낼지 말지 바뀝니다.
function renderTargets() {
  const open = state.rects.map((r) => r.id);
  for (const id of open) if (!knownTargets.has(id)) targets.add(id);
  for (const id of [...targets]) if (!open.includes(id)) targets.delete(id);
  knownTargets = new Set(open);

  const box = $('#targetChips');
  box.replaceChildren();
  for (const id of open) {
    const svc = state.services.find((s) => s.id === id);
    const chip = button(svc.name, '눌러서 켜기/끄기', () => {
      targets.has(id) ? targets.delete(id) : targets.add(id);
      renderTargets();
    });
    chip.className = 'chip';
    chip.style.setProperty('--svc', svc.color);
    chip.classList.toggle('on', targets.has(id));
    box.append(chip);
  }
  renderAttachHint();
}

// ---------- 답변 비교 ----------

/** 답변 비교 화면: 마지막 질문과 각 AI의 최신 답변을 칸마다 나란히 보여 줍니다. */
async function renderCompare() {
  const { question, answers } = await host.getAnswers();
  $('#compareQuestion').textContent = question || '(아직 공통 입력창으로 보낸 질문이 없습니다)';
  const cols = $('#compareCols');
  cols.style.gridTemplateColumns = `repeat(${Math.max(answers.length, 1)}, minmax(0, 1fr))`;
  cols.replaceChildren(...answers.map(answerColumn));
}

/** 답변 한 칸 (비교 화면·기록 화면 공용). a: { name, color, text, md?, note?, emptyText? } */
function answerColumn(a) {
  const col = document.createElement('article');
  col.className = 'compare-col';
  col.style.setProperty('--svc', a.color);
  const head = document.createElement('div');
  head.className = 'compare-col-head';
  const count = span('muted-label', a.text ? `${a.text.length.toLocaleString()}자` : a.note || '답변 없음');
  const copy = button('복사', `${a.name} 답변 복사`, async () => {
    await host.copyText(a.md || a.text); // Markdown이 있으면 서식(표·코드)을 살려 복사
    flash(count, '복사했습니다');
  });
  copy.disabled = !a.text;
  head.append(span('dot ready'), span('name', a.name), count, copy);
  const body = document.createElement('div');
  body.className = 'compare-body';
  body.textContent = a.text || a.emptyText || '이 패널에는 아직 답변이 없습니다.';
  body.classList.toggle('empty', !a.text);
  col.append(head, body);
  return col;
}

$('#compareBtn').addEventListener('click', () => host.setView(state.chatView === 'compare' ? 'panels' : 'compare'));
$('#changesBtn').addEventListener('click', () => host.setView(state.chatView === 'changes' ? 'panels' : 'changes'));
$('#changesClose').addEventListener('click', () => host.setView('panels'));
$('#historyBtn').addEventListener('click', () => host.setView(state.chatView === 'history' ? 'panels' : 'history'));
$('#compareClose').addEventListener('click', () => host.setView('panels'));
$('#compareRefresh').addEventListener('click', renderCompare);

// ---------- 질문·답변 기록 ----------

const ANSWER_STATE_TEXT = { timeout: '시간 초과', 'no-answer': '답변 없음', error: '보내기 실패' };
let historySelected = null;

const fmtTime = (ms) =>
  new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 기록 화면 왼쪽: 보낸 질문 목록 (검색어가 있으면 걸러서) */
async function renderHistoryList() {
  const query = $('#historySearch').value;
  const items = await host.history.list(query);
  const list = $('#historyList');
  if (!items.length) {
    list.replaceChildren(span('history-empty', query ? '찾는 기록이 없습니다' : '아직 기록이 없습니다'));
    $('#historyDetail').replaceChildren();
    return;
  }
  if (!items.some((it) => it.id === historySelected)) historySelected = items[0].id;
  list.replaceChildren(
    ...items.map((it) => {
      const row = document.createElement('button');
      row.className = 'history-item';
      row.classList.toggle('active', it.id === historySelected);
      const meta =
        `${fmtTime(it.at)} · 답변 ${it.answered}/${it.targets}` +
        `${it.files ? ` · 첨부 ${it.files}` : ''}${it.synth ? ` · 종합 ${it.synth}` : ''}`;
      row.append(span('history-q', it.question || NO_TEXT), span('history-meta', meta));
      row.addEventListener('click', () => {
        historySelected = it.id;
        renderHistoryList();
      });
      return row;
    }),
  );
  renderHistoryDetail();
}

const NO_TEXT = '(글 없이 첨부 파일만 보냄)';
const filesLine = (files) => files.map((f) => `${f.name} (${fmtSize(f.size)})`).join(' · ');

// 기록 하나(질문 + 각 AI 답변 + 종합)를 Markdown 글 하나로 엮습니다 (복사용).
function recordToMarkdown(rec) {
  const question = rec.question || NO_TEXT;
  const parts = [`# ${question.split('\n')[0]}`, '', `> ${fmtTime(rec.at)}`, '', '## 질문', '', question];
  if (rec.files?.length) parts.push('', `첨부: ${filesLine(rec.files)}`);
  for (const id of rec.targets) {
    const a = rec.answers[id];
    if (a?.text) parts.push('', `## ${a.name}`, '', a.md || a.text);
  }
  for (const sy of rec.synth) parts.push('', `## 종합 (${sy.judge})`, '', sy.md || sy.text);
  return parts.join('\n');
}

/** 기록 화면 오른쪽: 고른 기록의 질문과 답변 전체 */
async function renderHistoryDetail() {
  const rec = await host.history.get(historySelected);
  const box = $('#historyDetail');
  if (!rec) return box.replaceChildren();

  const head = document.createElement('div');
  head.className = 'history-detail-head';
  const time = span('muted-label', fmtTime(rec.at));
  head.append(
    time,
    button('질문 다시 쓰기', '이 질문을 입력창에 넣습니다', () => {
      $('#prompt').value = rec.question;
      host.setView('panels');
      $('#prompt').focus();
    }),
    button('Markdown 복사', '질문과 답변을 Markdown으로 복사', async () => {
      await host.copyText(recordToMarkdown(rec));
      flash(time, '복사했습니다');
    }),
    button('삭제', '이 기록을 지웁니다', async () => {
      await host.history.remove(rec.id);
      historySelected = null;
      renderHistoryList();
    }),
  );

  const question = document.createElement('div');
  question.className = 'history-question';
  question.textContent = rec.question || NO_TEXT;
  if (rec.files?.length) question.append(document.createElement('br'), span('history-files', `📎 ${filesLine(rec.files)}`));

  const cols = document.createElement('div');
  cols.className = 'compare-cols';
  const columns = rec.targets.map((id) => {
    const a = rec.answers[id];
    const svc = state.services.find((s) => s.id === id);
    return {
      name: a?.name || svc?.name || id,
      color: svc?.color || 'var(--muted)',
      text: a?.text || '',
      md: a?.md,
      note: a ? ANSWER_STATE_TEXT[a.state] : '기다리는 중',
      emptyText: a ? '저장된 답변이 없습니다.' : '답변을 기다리는 중이거나, 앱이 닫혀 저장되지 않았습니다.',
    };
  });
  for (const sy of rec.synth) columns.push({ name: `종합 · ${sy.judge}`, color: 'var(--accent)', text: sy.text, md: sy.md });
  cols.style.gridTemplateColumns = `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`;
  cols.replaceChildren(...columns.map(answerColumn));
  box.replaceChildren(head, question, cols);
}

let searchTimer = null;
$('#historySearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderHistoryList, 200);
});
$('#historyClose').addEventListener('click', () => host.setView('panels'));
$('#historyClear').addEventListener('click', async () => {
  if (!confirm('저장된 질문·답변 기록을 모두 지울까요? 되돌릴 수 없습니다.')) return;
  await host.history.clear();
  renderHistoryList();
});

// ---------- 단축키 ----------

// 본체가 "이 단축키가 눌렸어"라고 알려 오면 그에 맞는 버튼을 대신 누릅니다.
host.on('shortcut', (action) => {
  if (action === 'focus-composer') return $('#prompt').focus();
  if (action.startsWith('target:')) {
    const chip = document.querySelectorAll('#targetChips .chip')[Number(action.slice(7)) - 1];
    return chip?.click();
  }
  const click = { 'newchat-all': '#newChatAll', synth: '#synthBtn', 'copy-all': '#copyAll', 'reload-all': '#reloadAll' }[action];
  if (click) $(click).click();
});

$('#timeoutSelect').addEventListener('change', (e) => host.setSettings({ answerTimeoutMin: Number(e.target.value) }));

const REMOTE_SOURCE = { builtin: '앱에 들어 있는 셀렉터', cache: '저장해 둔 원격 셀렉터', remote: '원격 셀렉터' };

// 설정 화면의 "사이트 셀렉터 원격 갱신" 상태 글
function renderRemoteStatus() {
  const r = state.remote || {};
  const parts = [
    `지금 쓰는 것: ${REMOTE_SOURCE[r.source] || r.source}${r.version ? ` (버전 ${r.version}${r.updated ? `, ${r.updated}` : ''})` : ''}`,
  ];
  if (r.services?.length) parts.push(`바뀐 서비스: ${r.services.join(', ')}`);
  if (r.ignored?.length) parts.push(`보안상 무시한 항목: ${r.ignored.slice(0, 6).join(', ')}${r.ignored.length > 6 ? ' 외' : ''} (앱 업데이트로만 바뀜)`);
  if (r.checkedAt) parts.push(`마지막 확인 ${fmtTime(r.checkedAt)}`);
  if (r.error) parts.push(`확인 실패: ${r.error}`);
  $('#remoteStatus').textContent =
    `서비스 화면이 바뀌어 입력창·답변을 못 찾을 때, 앱을 다시 설치하지 않고 GitHub에서 고친 셀렉터를 받아 씁니다. ${parts.join(' · ')}`;
  $('#remoteToggle').checked = !!state.remoteSelectors;
  $('#remoteRefresh').disabled = !state.remoteSelectors;
}

$('#remoteToggle').addEventListener('change', (e) => host.setSettings({ remoteSelectors: e.target.checked }));
$('#remoteRefresh').addEventListener('click', async () => {
  $('#remoteRefresh').disabled = true;
  await host.refreshRemote();
  $('#remoteRefresh').disabled = false;
});

function renderSettings() {
  renderRemoteStatus();
  const select = $('#timeoutSelect');
  select.replaceChildren(
    ...state.timeoutChoices.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: `${m}분` })),
  );
  select.value = String(state.answerTimeoutMin);
}

/** 설정·단축키(?) 화면: 대기 시간 고르기, 원격 갱신 상태, 단축키 표 */
async function renderHelp() {
  renderSettings();
  const rows = await host.shortcuts();
  $('#helpTable').replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement('tr');
      const k = document.createElement('td');
      k.append(...r.keys.split(' ').map((part) => Object.assign(document.createElement('kbd'), { textContent: part })));
      const d = document.createElement('td');
      d.textContent = r.label;
      tr.append(k, d);
      return tr;
    }),
  );
}

$('#helpBtn').addEventListener('click', () => host.setView(state.chatView === 'help' ? 'panels' : 'help'));
$('#helpClose').addEventListener('click', () => host.setView('panels'));

// ---------- 교차검토(종합) ----------

// 종합 담당 AI 고르기 목록과 "완료 후 자동" 체크 상자를 지금 상태에 맞춥니다.
function renderSynth() {
  const select = $('#synthTarget');
  const open = state.rects.map((r) => r.id);
  select.replaceChildren(
    ...open.map((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = state.services.find((s) => s.id === id).name;
      return opt;
    }),
  );
  // 저장된 종합 담당이 열려 있지 않으면 첫 패널로 바꿔 저장한다.
  if (open.length && !open.includes(state.synthTarget)) host.setSynth({ target: open[0] });
  else select.value = state.synthTarget;
  $('#autoSynth').checked = !!state.autoSynth;
  $('#synthBtn').disabled = open.length < 2;
}

$('#synthTarget').addEventListener('change', (e) => host.setSynth({ target: e.target.value }));
$('#autoSynth').addEventListener('change', (e) => host.setSynth({ auto: e.target.checked }));
$('#synthBtn').addEventListener('click', () => host.runSynth($('#synthTarget').value));

// 종합 요청 진행 상황(보내는 중·보냄·실패)을 입력창 아래 안내 글로 보여 줍니다.
host.on('synth:status', ({ state: st, judge, count, error, cause }) => {
  const prefix = cause === 'auto' ? '자동 종합: ' : '';
  $('#sendHint').textContent =
    st === 'error'
      ? `${prefix}${error}`
      : st === 'sending'
        ? `${prefix}${judge}에게 답변 ${count}개 종합을 요청하는 중…`
        : `${prefix}${judge}에게 답변 ${count}개 종합을 요청했습니다`;
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
const KIND_TEXT = { image: '이미지', document: '문서' };

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
    if (attachments.length >= limits.maxFiles) rejected.push(`${file.name}: 최대 ${limits.maxFiles}개`);
    else if (file.size > limits.maxFileBytes) rejected.push(`${file.name}: 파일당 ${fmtSize(limits.maxFileBytes)} 초과`);
    else if (total + file.size > limits.maxTotalBytes) rejected.push(`${file.name}: 합계 ${fmtSize(limits.maxTotalBytes)} 초과`);
    else if (!file.size && !file.type) rejected.push(`${file.name}: 폴더나 빈 파일은 올릴 수 없습니다`);
    else {
      total += file.size;
      attachments.push({ file, url: fileKind(file.type) === 'image' ? URL.createObjectURL(file) : null });
    }
  }
  renderAttachments();
  if (rejected.length) attachHint(`올리지 못함 — ${rejected.join(' / ')}`, 'error');
  $('#prompt').focus();
}

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
      else chip.append(span('file-icon', '📄'));
      chip.append(span('file-name', a.file.name), span('file-size', fmtSize(a.file.size)));
      chip.append(button('✕', '첨부에서 빼기', () => removeAttachment(i)));
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
      `끌어다 놓기 · Ctrl+V로도 올릴 수 있습니다 (최대 ${limits.maxFiles}개, 파일당 ${fmtSize(limits.maxFileBytes)}, 합계 ${fmtSize(limits.maxTotalBytes)})`,
    );
  }
  const total = attachments.reduce((n, a) => n + a.file.size, 0);
  const kinds = [...new Set(attachments.map((a) => fileKind(a.file.type)))];
  const warns = [...targets]
    .map((id) => state.services.find((s) => s.id === id))
    .filter((svc) => svc && kinds.some((k) => !svc.accept.includes(k)))
    .map((svc) => `${svc.name}은(는) ${kinds.filter((k) => !svc.accept.includes(k)).map((k) => KIND_TEXT[k]).join('·')} 빼고 보냄`);
  attachHint(`${attachments.length}개 · ${fmtSize(total)}${warns.length ? ` — ${warns.join(', ')}` : ''}`, warns.length ? 'warn' : '');
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
 * 보내기 버튼(또는 Enter)을 눌렀을 때: 템플릿·스킬·프로젝트 맥락을 붙여 고른 AI들에게 동시에 보냅니다.
 * 실제 전송은 본체(host.sendPrompt)가 하고, 결과(서비스별 성공·실패)를 받아 안내합니다.
 */
async function send() {
  const box = $('#prompt');
  const text = box.value.trim();
  if ((!text && !attachments.length) || sending) return;
  const ids = [...targets];
  if (!ids.length) return alert('보낼 대상을 하나 이상 켜 주세요.');
  sending = true;
  $('#sendBtn').disabled = true;
  try {
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
    if (qText === null) return;
    let payload = { text: qText, files, opts: {} };
    // 프로젝트 모드: 프로젝트 구조와 고른 파일 내용을 붙인다 (project.js). null이면 사용자가 취소했다.
    if (window.projectPrepareSend) payload = await window.projectPrepareSend(payload, ids);
    if (!payload) return;
    // 스킬: 이 대화에 아직 받지 않은 패널(또는 "매 질문마다"면 모두)의 글 앞에 지침을 붙인다 (library.js)
    const skill = window.libSkillPrefix?.(ids);
    if (skill?.cancel) return; // 지침이 너무 길어 사용자가 보내기를 멈췄다 (입력 내용은 남김)
    if (skill) payload = { ...payload, opts: { ...payload.opts, prefixById: skill.prefixById } };
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
      ? `${failed.map((r) => name(r.id)).join(', ')} 보내기 실패 — 입력 내용은 남겨 두었습니다`
      : `${results.length}곳에 보냈습니다${skill ? ` · 스킬 지침 ${skill.ids.length}곳` : ''}${noAttach.length ? ` · ${noAttach.map((r) => `${name(r.id)}(${ATTACH_TEXT[r.attach.state]})`).join(', ')}` : ''}`;
  } catch (err) {
    $('#sendHint').textContent = `보내지 못했습니다: ${err.message}`;
  } finally {
    sending = false;
    $('#sendBtn').disabled = false;
    box.focus();
  }
}

$('#sendBtn').addEventListener('click', send);
$('#prompt').addEventListener('keydown', (e) => {
  // 한글 조합 중 Enter는 글자 확정용이라 보내지 않는다.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

// ---------- 전체 상태 ----------

// 본체가 "전체 상태"를 보내올 때마다 실행되는 가장 중요한 부분입니다.
// 지금 화면(패널·비교·기록·설정 …)에 맞게 body의 data-view 값을 바꾸면, styles.css가 그에 맞는 화면만 보여 줍니다.
// 새로 들어온 화면이면 내용을 새로 그립니다 (예: 비교 화면에 처음 들어오면 답변을 다시 읽음).
host.on('state', (next) => {
  const modeChanged = !state || state.mode !== next.mode;
  const enteredCompare = next.chatView === 'compare' && (modeChanged || state.chatView !== 'compare');
  const enteredHistory = next.chatView === 'history' && (modeChanged || state.chatView !== 'history');
  const enteredHelp = next.chatView === 'help' && (modeChanged || state.chatView !== 'help');
  const enteredChanges = next.chatView === 'changes' && (modeChanged || state.chatView !== 'changes');
  state = next;
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
  else if (state.chatView === 'help') renderRemoteStatus(); // 설정 화면을 보는 중에 갱신 결과가 오면 바로 반영
  $('#helpBtn').classList.toggle('active', state.chatView === 'help');
  $('#hint').textContent = UI.hints[state.mode];
  for (const b of document.querySelectorAll('[data-layout]')) {
    b.classList.toggle('active', b.dataset.layout === state.layout);
  }
  if (state.mode === 'pick' && modeChanged) renderPick();
  syncPanels();
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
  $('#sendHint').textContent = r.copied ? `답변 ${r.copied}개를 복사했습니다` : '복사할 답변이 없습니다';
});
$('#pickBtn').addEventListener('click', () => host.pickModels());
$('#logoutBtn').addEventListener('click', () => {
  if (confirm('로그아웃하면 모든 서비스의 로그인 정보(쿠키)가 지워집니다. 질문·답변 기록은 남습니다. 계속할까요?')) host.logout();
});
