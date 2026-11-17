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
//
// 이 파일은 v0.24.0에서 셋으로 나눴습니다: renderer.js(이 파일: 도우미 · 모델 고르기 · 패널 머리줄 · 자가진단 · 로컬 LLM ·
//   패널 상태 · 업데이트 · 보낼 대상) → renderer-views.js(비교 · 기록 · 설정 · 통계) → renderer-compose.js(종합 · 첨부 · 보내기 · state).
// ============================================================================

const $ = (sel) => document.querySelector(sel);
// 화면 문구 사전 (v0.24.0, shared/i18n.js). 새로 만드는 화면 글은 t('키')로 쓴다.
// 언어 (v0.30.0): 본체가 미리 알려 준 지금 언어(host.lang)로 첫 글자부터 그린다. 설정에서 바꾸면 state.uiLang → relocalize()
const { t } = MLA.i18n;
let shownLang = MLA.i18n.setLang(host.lang || 'ko'); // 지금 화면에 그려 둔 언어
MLA.i18n.apply(document);
const panelsEl = $('#panels');
const panels = new Map(); // id -> { el, dot, url, status }
let state = null;

// 실행 환경(Electron 앱 / 크롬 확장 프로그램)마다 다른 화면 문구. host.ui로 바꿀 수 있다.
const UI = {
  hints: {
    get login() { return t('ui.hint.login'); },
    get pick() { return t('ui.hint.pick'); },
    get chat() { return t('ui.hint.chat'); },
  },
  get pickNote() { return t('ui.pick.note'); },
  get loginButton() { return { label: t('ui.loginButton'), title: t('ui.loginButtonTitle') }; },
  devtools: true, // 패널 머리줄의 개발자 도구 버튼
};
// host.ui의 getter를 그대로 옮긴다 (펼치기(...)는 값을 한 번 읽어 굳혀서, 언어를 바꿔도 옛 글이 남는다 — v0.30.0)
Object.defineProperties(UI, Object.getOwnPropertyDescriptors(host.ui || {}));

const LOGIN_TEXT = {
  get 'needs-login'() { return t('ui.login.needed'); },
  get 'logging-in'() { return t('ui.login.loggingIn'); },
  get google() { return t('ui.login.google'); },
  get captcha() { return t('ui.login.captcha'); },
  ready: '',
};

// 버튼 하나 만들기 도우미: 글자(label), 마우스를 올리면 보이는 설명(title), 눌렀을 때 할 일(onClick)
function button(label, title, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  // 글이 기호뿐인 버튼(★ · ✕ · ↻ …)은 설명을 화면 읽기 이름으로도 단다 (v0.30.0 접근성)
  if (title && label && !/[\p{L}\p{N}]/u.test(label)) b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

// 버튼이 아닌 요소(목록의 줄 · 파일 이름 · 표의 칸)를 키보드로도 누를 수 있게 (v0.30.0 접근성):
// Tab으로 닿고(tabindex), 그 요소에서 Enter · Space를 누르면 클릭과 같은 일을 한다. role은 화면 읽기 프로그램에 알릴 역할.
function keyClick(el, onClick, role) {
  el.tabIndex = 0;
  if (role) el.setAttribute('role', role);
  el.addEventListener('keydown', (e) => {
    if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onClick(e);
  });
  return el;
}

// 서비스 이름을 화면에 보일 때 (v0.30.0): 로컬 LLM만 지금 언어의 이름으로 바꿔 보여 준다 (모델 고르기 · 패널 머리줄 · 보낼 대상).
// 서비스의 name 자체('로컬 LLM')는 그대로다 — 기록 · 통계 · AI에게 보내는 글이 그 이름으로 저장되고 서로 찾기 때문.
// 로컬 LLM 패널 번호 (v0.36.0): 첫 패널 'local', 둘째 · 셋째 'local-2' · 'local-3' — 패널마다 모델이 따로다
const LOCAL_PANEL_IDX = { local: 0, 'local-2': 1, 'local-3': 2 };
const localModelOf = (id) => {
  const i = LOCAL_PANEL_IDX[id] ?? 0;
  return (i ? state.local?.extraModels?.[i - 1] : state.local?.model) || '';
};
const svcLabel = (svc) => (svc?.kind === 'local' ? `${t('ui.local.name')}${LOCAL_PANEL_IDX[svc.id] ? ` ${LOCAL_PANEL_IDX[svc.id] + 1}` : ''}` : svc?.name || '');

// 기호만 있는 버튼 (v0.30.0): 설명(title)과 화면 읽기 이름(aria-label)을 사전 키로 달아 언어를 바꾸면 apply()가 다시 쓴다
function tbutton(label, key, onClick) {
  const b = button(label, t(key), onClick);
  b.dataset.i18nTitle = key;
  b.dataset.i18nAria = key;
  b.setAttribute('aria-label', t(key));
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
  $('#pickNote').textContent = `${UI.pickNote} ${t('ui.pick.max', { n: state.maxSelected })}`;
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
    label.append(box, span('swatch'), span('name', svcLabel(svc)), span('url', new URL(svc.url).hostname));
    list.append(label);
  }
  updatePickLimit();
  renderPickRecommend(); // 질문 종류별 추천 조합 (v0.27.0, recommend-ui.js)
}

// 최대 개수만큼 고르면 나머지 칸은 고를 수 없게 막는다.
function updatePickLimit() {
  const count = pickedIds().length;
  const full = count >= state.maxSelected;
  for (const box of document.querySelectorAll('#modelList input')) {
    box.disabled = full && !box.checked;
    box.closest('.model').classList.toggle('disabled', box.disabled);
  }
  $('#pickCount').textContent = t('ui.pick.count', { n: count, max: state.maxSelected }) + (count > 4 ? t('ui.pick.memoryWarn') : '');
  $('#pickCount').classList.toggle('full', full);
}

$('#openBtn').addEventListener('click', () => {
  const ids = pickedIds();
  if (!ids.length) return alert(t('ui.pick.none'));
  if (ids.length > state.maxSelected) return alert(t('ui.pick.tooMany', { n: state.maxSelected }));
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
    const focusKey = r.focused ? 'ui.panel.unfocus' : 'ui.panel.focus';
    p.focusBtn.title = t(focusKey);
    p.focusBtn.setAttribute('aria-label', t(focusKey));
    p.focusBtn.dataset.i18nTitle = p.focusBtn.dataset.i18nAria = focusKey;
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
 * 버튼: 파일 모아보기 · 요청 파일 보내기 · 로그인 · copy(복사) · → 넘기기 · ⤢ 크게 보기 · + 새 대화 · ← 뒤로 · ⌂ 처음 주소 · ↻ 새로고침
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
  // 셀렉터 자가진단: 입력창 · 보내기 버튼 · 답변 영역을 못 찾으면 띄운다 (누르면 설정 화면의 서비스별 상태 표)
  const diagBadge = button('', '', () => openDiag(svc.id)); // 자가진단 창 (v0.21.1)
  diagBadge.className = 'diag-badge';
  diagBadge.hidden = true;
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
  const focusBtn = tbutton('⤢', 'ui.panel.focus', () => host.setFocus(svc.id));
  // 넘기기 (v0.26.0): 이 패널의 최신 답변을 다른 패널에 보내 검토 · 반박 · 이어서 쓰기 (panel-offers.js가 패널 아래 바를 띄움)
  const handoffBtn = tbutton('→', 'handoff.btnTitle', () => window.onHandoffClick?.(svc.id));
  handoffBtn.className = 'handoff-btn';
  // 답변 평가 (v0.23): 공통 입력창 질문의 답변이 끝나면 띄운다. 같은 것을 다시 누르면 지운다.
  const goodBtn = tbutton('[+1]', 'ui.panel.good', () => setFeedback(svc.id, 1));
  const badBtn = tbutton('[-1]', 'ui.panel.bad', () => setFeedback(svc.id, -1));
  for (const b of [goodBtn, badBtn]) {
    b.classList.add('fb-btn');
    b.setAttribute('aria-pressed', 'false');
    b.hidden = true;
  }
  goodBtn.dataset.fb = 'good';
  badBtn.dataset.fb = 'bad';

  head.append(
    dot,
    span('name', svcLabel(svc)),
    url,
    status,
    goodBtn,
    badBtn,
    attachBadge,
    diagBadge,
    collectBtn,
    needBtn,
    loginBtn,
    tbutton('copy', 'ui.panel.copyLatest', async () => {
      const r = await host.copyAnswer(svc.id);
      flash(status, r.copied ? t('ui.panel.answerCopied') : t('ui.copyAnswers.none'));
    }),
    handoffBtn,
    focusBtn,
    tbutton('+', 'ui.panel.newChat', () => host.panelAction(svc.id, 'newchat')),
  );
  // 웹페이지 패널에만: 뒤로 · 처음 주소 · 새로고침 · 개발자 도구. 로컬 LLM 패널은 대신 ■ 답 그만 받기.
  const isLocalPanel = svc.kind === 'local';
  if (isLocalPanel) head.append(tbutton('■', 'ui.panel.stop', () => host.panelAction(svc.id, 'stop')));
  else {
    head.append(
      tbutton('←', 'ui.panel.back', () => host.panelAction(svc.id, 'back')),
      tbutton('⌂', 'ui.panel.home', () => host.panelAction(svc.id, 'home')),
      tbutton('↻', 'ui.panel.reload', () => host.panelAction(svc.id, 'reload')),
    );
    if (UI.devtools) head.append(tbutton('{ }', 'ui.panel.devtools', () => host.panelAction(svc.id, 'devtools')));
  }
  // 프로젝트 모드: 답변에 수정안이 있으면 project.js가 패널 아래에 이 바를 채워 띄운다 (setChangeBar)
  const changeBar = document.createElement('div');
  changeBar.className = 'change-bar';
  changeBar.hidden = true;
  el.append(head, changeBar);
  // 로컬 LLM 패널 (v0.16.0): 웹페이지가 얹히지 않으므로 이 화면이 대화(말풍선)와 모델 고르기를 직접 그린다
  let localBox = null;
  if (isLocalPanel) {
    el.classList.add('local-panel');
    dot.classList.add('ready'); // 로그인이 없는 패널 — 열리면 바로 쓸 수 있다
    localBox = document.createElement('div');
    localBox.className = 'local-chat';
    el.append(localBox);
    url.textContent = state.local?.baseUrl || svc.url;
  }
  panelsEl.append(el);
  head.addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) host.setFocus(svc.id); // 머리줄 빈 곳을 두 번 누르면 크게 보기 / 돌아오기
  });
  const p = { el, dot, url, status, loginBtn, attachBadge, diagBadge, needBtn, collectBtn, focusBtn, goodBtn, badBtn, changeBar, localBox };
  panels.set(svc.id, p);
  renderFeedback(svc.id);
  renderDiagBadge(svc.id);
  if (localBox) renderLocalChat(svc.id, localViews[svc.id] || { messages: [], streaming: false, model: localModelOf(svc.id), error: '' });
  return p;
}

// ---------- 답변 평가 (v0.23) ----------
// 공통 입력창으로 보낸 질문(라운드)마다 AI별 [+1] 좋았음 / [-1] 별로였음을 기록(record.feedback)에 남긴다.
// 버튼은 그 라운드에 보낸 패널의 답변이 끝났을 때만 보이고, 새 질문을 보내면 지워진다. 설정의 응답 통계에 만족도로 나온다.
const feedback = { targets: new Set(), done: new Set(), value: {} }; // 지금 라운드: 보낸 AI · 답이 끝난 AI · { id: 1 | -1 }

function renderFeedback(id) {
  const p = panels.get(id);
  if (!p) return;
  const show = feedback.targets.has(id) && feedback.done.has(id);
  const v = feedback.value[id] || 0;
  for (const [b, on] of [
    [p.goodBtn, v === 1],
    [p.badBtn, v === -1],
  ]) {
    b.hidden = !show;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/** 새 질문을 보냈다: 평가를 지우고 이번에 보낸 AI만 기억한다 */
function resetFeedback(ids) {
  feedback.targets = new Set(ids);
  feedback.done = new Set();
  feedback.value = {};
  for (const id of panels.keys()) renderFeedback(id);
}

async function setFeedback(id, value) {
  const next = feedback.value[id] === value ? 0 : value; // 같은 것을 다시 누르면 지운다
  const r = await host.history.feedback?.(id, next).catch(() => null);
  if (r === null || r === undefined) {
    const p = panels.get(id);
    if (p) flash(p.status, t('ui.feedback.failed'));
    return;
  }
  if (next) feedback.value[id] = next;
  else delete feedback.value[id];
  renderFeedback(id);
  if (state?.chatView === 'help') renderStatsTable();
}

// ---------- 셀렉터 자가진단 ----------
// 본체(shared/diag.js)가 패널마다 입력창 · 보내기 버튼 · 답변 영역을 찾았는지 알려 준다.
// 못 찾은 것이 있으면 머리줄에 ⚠ 화면이 바뀐 것 같음, 설정 화면에는 서비스별 표.
const diagById = {};

function renderDiagBadge(id) {
  const p = panels.get(id);
  const d = diagById[id];
  if (!p) return;
  const broken = d?.level === 'broken';
  const limit = !!d?.limit; // 사용 한도 안내를 찾음 (v0.13.0) — 셀렉터 문제보다 먼저 알린다
  p.diagBadge.hidden = !broken && !limit;
  p.diagBadge.classList.toggle('limit', limit);
  if (!broken && !limit) return;
  if (limit) {
    p.diagBadge.textContent = t('ui.diag.limitBadge');
    p.diagBadge.title = [t('ui.diag.pageText', { text: d.limit }), '', d.limitHint, '', t('ui.diag.clickMore')].join('\n');
    return;
  }
  p.diagBadge.textContent = t('ui.diag.changedBadge');
  p.diagBadge.title = [d.message, ...d.notes, '', d.hint, '', t('ui.diag.clickMoreFix')].join('\n');
}

// ---------- 셀렉터 자가진단 창 (v0.21.1) ----------
// 패널 머리줄의 ⚠ / [limit] 표시를 누르면 연다: 입력창 · 보내기 · 답변 영역을 찾았는지, 안내, 원격 셀렉터 버전과
// [셀렉터 지금 확인] [처음 화면으로] [진단 정보 복사]. Windows 앱은 패널 웹페이지가 화면 맨 위에 얹혀 있어서
// 미리보기 창처럼 'dialog' 화면으로 바꿔 패널을 치운 뒤 띄운다.
let diagOpen = null; // { id, dialog }
function openDiag(id) {
  diagOpen = { id, dialog: state?.chatView === 'panels' };
  if (diagOpen.dialog) host.setView('dialog');
  $('#diagStatus').textContent = '';
  renderDiagModal();
  $('#diagModal').hidden = false;
  $('#diagClose').focus();
}
function closeDiag() {
  if (!diagOpen) return;
  const back = diagOpen.dialog;
  diagOpen = null;
  $('#diagModal').hidden = true;
  if (back && state?.chatView === 'dialog') host.setView('panels');
}
function renderDiagModal() {
  if (!diagOpen) return;
  const D = MLA.diag;
  const svc = state.services.find((s) => s.id === diagOpen.id);
  const d = diagById[diagOpen.id] || {};
  $('#diagTitle').textContent = `${svc?.name || diagOpen.id} — ${d.limit ? t('ui.diag.limitHit') : d.level === 'broken' ? t('ui.diag.changed') : t('ui.diag.status')}`;
  $('#diagSub').textContent = panels.get(diagOpen.id)?.url.textContent || '';
  const row = (cells, tag = 'td') => {
    const tr = document.createElement('tr');
    for (const c of cells) tr.append(Object.assign(document.createElement(tag), { textContent: c }));
    return tr;
  };
  $('#diagParts').replaceChildren(
    row([t('ui.diag.item'), t('ui.diag.state')], 'th'),
    ...D.PARTS.map((p) => {
      const tr = row([D.PART_TEXT[p], `${D.MARK[d[p]] || '–'} ${D.STATE_TEXT[d[p]] || D.STATE_TEXT.unknown}`]);
      tr.lastChild.dataset.state = d[p] || 'unknown';
      return tr;
    }),
    ...(d.limit ? [row([t('ui.diag.limitText'), `"${d.limit}"`])] : []),
  );
  $('#diagMsg').textContent = [d.limit ? d.limitHint : d.hint, ...(d.notes || [])].filter(Boolean).join(' · ') || t('ui.diag.noProblem');
  const r = state.remote || {};
  $('#diagRemote').textContent =
    t('ui.diag.selectors', { src: r.version ? t('ui.diag.remoteVer', { v: r.version }) + (r.updated ? ` (${r.updated})` : '') : t('ui.diag.builtin') }) +
    `${r.checkedAt ? ` · ${t('ui.remote.checked', { time: fmtTime(r.checkedAt) })}` : ''}${r.error ? ` · ${t('ui.remote.checkFailed', { error: r.error })}` : ''}` +
    (state.remoteSelectors ? '' : t('ui.diag.autoOff'));
  $('#diagRefresh').disabled = !state.remoteSelectors;
}
function diagReportText() {
  const svc = state.services.find((s) => s.id === diagOpen.id);
  let host_ = '';
  try {
    host_ = new URL(panels.get(diagOpen.id)?.url.textContent || '').hostname; // 주소의 경로(대화 id 등)는 넣지 않는다
  } catch {}
  return MLA.diag.report({
    service: { id: diagOpen.id, name: svc?.name },
    status: diagById[diagOpen.id],
    remote: state.remote,
    app: state.update?.current || '',
    where: t(host.takeWebAsk ? 'ui.diag.where.ext' : 'ui.diag.where.app'),
    host: host_,
  });
}
const diagSay = (text, kind = '') => Object.assign($('#diagStatus'), { textContent: text }).setAttribute('data-kind', kind);
$('#diagClose').addEventListener('click', closeDiag);
$('#diagModal').addEventListener('click', (e) => e.target === $('#diagModal') && closeDiag());
$('#diagModal').addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), closeDiag()));
$('#diagSettings').addEventListener('click', () => {
  diagOpen = null;
  $('#diagModal').hidden = true;
  host.setView('help');
});
$('#diagHome').addEventListener('click', () => {
  const id = diagOpen.id;
  closeDiag();
  host.panelAction(id, 'home');
});
$('#diagCopy').addEventListener('click', async () => {
  await host.copyText(diagReportText());
  diagSay(t('ui.diag.copied'), 'ok');
});
$('#diagRefresh').addEventListener('click', async () => {
  const before = state.remote?.version;
  $('#diagRefresh').disabled = true;
  diagSay(t('ui.diag.checking'));
  const r = (await host.refreshRemote()) || {};
  $('#diagRefresh').disabled = false;
  if (r.error) diagSay(t('ui.remote.checkFailed', { error: r.error }), 'error');
  else if (r.version && r.version !== before) diagSay(t('ui.diag.gotNew', { v: r.version }), 'ok');
  else diagSay(t('ui.diag.noNew'));
  renderDiagModal();
});

// 원격 셀렉터를 새 버전으로 받으면 툴바 상태줄에 10초 동안 "selectors v13" (v0.21.1)
let remoteSeen = null;
let remoteFlashUntil = 0;
function noteRemote() {
  const v = state?.remote?.source === 'remote' ? state.remote.version : null;
  if (v && remoteSeen !== null && v !== remoteSeen) {
    remoteFlashUntil = Date.now() + 10000;
    setTimeout(renderStatusLine, 10100);
  }
  if (v || remoteSeen === null) remoteSeen = v ?? remoteSeen ?? 0;
}

// ---------- 로컬 LLM 패널 (v0.16.0) ----------
// 본체(main · host.js)가 대화가 바뀔 때마다 { messages, streaming, model, error }를 보내 준다. 말풍선으로 그린다.
// 글은 shared/export.js의 mdToHtml로 (모든 글을 이스케이프한 뒤 제목 · 목록 · 표 · 코드 블록만 태그로) 넣는다.
const localViews = {};
let localModels = []; // 연결 확인으로 받은 모델 목록 (본체 상태가 새로 와도 남긴다)

const localFrame = {}; // 패널별로 다음 화면 그리기(requestAnimationFrame) 예약 번호

// 답을 받는 중(streaming)에는 글자가 올 때마다 다시 그리지 않고 한 화면(frame)에 한 번만 그린다.
// 답이 끝나면(streaming 아님) 기다리지 않고 바로 그려서 마지막 모습은 그대로다.
function renderLocalChat(id, view) {
  localViews[id] = view;
  if (view.streaming) {
    if (localFrame[id] == null) {
      localFrame[id] = requestAnimationFrame(() => {
        localFrame[id] = null;
        drawLocalChat(id, localViews[id]);
      });
    }
    return;
  }
  if (localFrame[id] != null) {
    cancelAnimationFrame(localFrame[id]);
    localFrame[id] = null;
  }
  drawLocalChat(id, view);
}

function drawLocalChat(id, view) {
  const p = panels.get(id);
  if (!p?.localBox) return;
  const box = p.localBox;
  // 스크롤되는 칸은 box가 아니라 그 안의 .local-messages다 (styles.css: overflow: auto)
  const oldList = box.querySelector('.local-messages');
  const atBottom = !oldList || oldList.scrollHeight - oldList.scrollTop - oldList.clientHeight < 40;
  const oldTop = oldList ? oldList.scrollTop : 0;
  // 새 질문을 보냈으면 위를 읽고 있었어도 맨 아래로 간다
  const userCount = view.messages.filter((m) => m.role === 'user').length;
  const asked = userCount > (p.localUserCount ?? userCount);
  p.localUserCount = userCount;
  // 이미 그린 답은 글이 같으면 다시 변환하지 않는다 (보통 마지막 답만 바뀐다)
  const prevMd = p.localMd || [];
  const nextMd = [];
  const head = document.createElement('div');
  head.className = 'local-head';
  const models = localModels;
  const sel = document.createElement('select');
  sel.title = t('ui.local.modelTitle');
  const cur = view.model || localModelOf(id);
  const names = [...new Set([cur, ...models].filter(Boolean))];
  sel.replaceChildren(...(names.length ? names : [t('ui.local.pickModel')]).map((n) => Object.assign(document.createElement('option'), { value: names.length ? n : '', textContent: n })));
  sel.value = cur;
  sel.addEventListener('change', () => setLocalPanelModel(id, sel.value));
  const conn = button(t('ui.local.modelList'), t('ui.local.modelListTitle'), () => refreshLocalModels(conn));
  head.append(span('muted-label', t('ui.local.model')), sel, conn);
  const list = document.createElement('div');
  list.className = 'local-messages';
  if (!view.messages.length) {
    list.append(
      span('local-empty', view.error ? `⚠ ${view.error}` : t('ui.local.empty')),
    );
  }
  for (const m of view.messages) {
    const b = document.createElement('div');
    b.className = `local-msg ${m.role === 'user' ? 'user' : 'bot'}`;
    if (m.role === 'user') {
      b.textContent = m.text;
      if (m.images) b.append(span('local-img', ` ${t('ui.local.images', { n: m.images })}`));
      for (const f of m.files || []) b.append(span('local-img', ` ${t(f.cut ? 'ui.local.fileCut' : 'ui.local.file', { name: f.name })}`)); // 끼워 보낸 글 파일 (v0.36.0)
    } else {
      const src = m.text || (view.streaming ? '…' : '');
      const i = nextMd.length;
      const html = prevMd[i]?.src === src ? prevMd[i].html : MLA.exporter.mdToHtml(src); // mdToHtml은 모든 글을 이스케이프한다
      nextMd.push({ src, html });
      b.innerHTML = html;
    }
    list.append(b);
  }
  // 컨텍스트 한도 (v0.29.0): 지금까지 대화가 설정한 한도를 넘을 것 같으면 알린다 (서버가 앞부분을 잘라 먹을 수 있음)
  const ctx = MLA.sendPlan.contextCheck(view.messages.map((m) => m.text).join('\n'), state.local?.contextTokens);
  if (ctx.over) list.append(span('local-warn', t('local.ctxPanel', { n: ctx.tokens.toLocaleString(), max: ctx.limit.toLocaleString() })));
  if (view.streaming) list.append(span('local-typing', t('ui.local.typing')));
  else if (view.error && view.messages.length) list.append(span('local-error', `⚠ ${view.error}`));
  p.localMd = nextMd;
  box.replaceChildren(head, list);
  // 위를 읽는 중이면 그 자리를 지키고, 맨 아래에 있었으면 새 글을 따라 내려간다
  list.scrollTop = atBottom || asked ? list.scrollHeight : oldTop;
}

async function refreshLocalModels(el) {
  const r = await host.local.models($('#localBase')?.value || state.local?.baseUrl);
  if (!r?.ok) {
    if (el) flash(el, t('ui.local.connFail'));
    $('#localStatus') && ($('#localStatus').textContent = t('ui.local.connError', { error: r?.error || t('ui.unknownError') }));
    return null;
  }
  localModels = r.models;
  if (!state.local?.model && r.models[0]) await host.local.setPrefs({ model: r.models[0] });
  $('#localStatus') && ($('#localStatus').textContent = r.models.length ? t('ui.local.connected', { n: r.models.length }) : t('ui.local.noModels'));
  renderLocalSettings();
  for (const id of Object.keys(localViews)) renderLocalChat(id, localViews[id]);
  return r.models;
}

/** 로컬 패널 하나의 모델을 바꾼다 (첫 패널은 model, 둘째 · 셋째는 extraModels) */
function setLocalPanelModel(id, model) {
  const i = LOCAL_PANEL_IDX[id] ?? 0;
  if (!i) return host.local.setPrefs({ model });
  const extra = [...(state.local?.extraModels || ['', ''])];
  extra[i - 1] = model;
  return host.local.setPrefs({ extraModels: extra });
}

/** 설정 화면의 로컬 LLM 칸 */
function renderLocalSettings() {
  const L = state.local || {};
  if (!$('#localEnabled')) return;
  $('#localEnabled').checked = !!L.enabled;
  if (document.activeElement !== $('#localBase')) $('#localBase').value = L.baseUrl || '';
  const sel = $('#localModel');
  const names = [...new Set([L.model, ...localModels].filter(Boolean))];
  sel.replaceChildren(...(names.length ? names : ['']).map((n) => Object.assign(document.createElement('option'), { value: n, textContent: n || t('ui.local.getList') })));
  sel.value = L.model || '';
  // 패널 수 · 둘째 · 셋째 패널의 모델 (v0.36.0)
  const panels = L.panels || 1;
  $('#localPanels').value = String(panels);
  [2, 3].forEach((n) => {
    const row = $(`#localModelRow${n}`);
    row.hidden = panels < n;
    const s2 = $(`#localModel${n}`);
    const cur = L.extraModels?.[n - 2] || '';
    const list = [...new Set([cur, ...localModels, L.model].filter(Boolean))];
    s2.replaceChildren(...(list.length ? list : ['']).map((m) => Object.assign(document.createElement('option'), { value: m, textContent: m || t('ui.local.getList') })));
    s2.value = cur;
  });
  // 컨텍스트 한도 (v0.29.0): 2k ~ 128k 토큰, 기본 8k
  const ctxSel = $('#localCtx');
  if (!ctxSel.options.length) {
    ctxSel.replaceChildren(...[2048, 4096, 8192, 16384, 32768, 131072].map((n) => Object.assign(document.createElement('option'), { value: String(n), textContent: t('local.ctxOption', { k: Math.round(n / 1024) }) })));
  }
  ctxSel.value = String(L.contextTokens || 8192);
  // 의미 검색용 임베딩 모델 (v0.36.0)
  if (document.activeElement !== $('#embedModel')) $('#embedModel').value = L.embedModel || '';
  $('#embedModelList').replaceChildren(...localModels.map((m) => Object.assign(document.createElement('option'), { value: m })));
  $('#localBody').hidden = !L.enabled;
  if (L.enabled && state.chatView === 'help') window.refreshEmbedStatus?.();
}

/** 설정 화면: 서비스별 입력창 · 보내기 버튼 · 답변 영역 상태 표 (열어 둔 패널만, 로컬 LLM 패널은 셀렉터를 쓰지 않으므로 뺀다) */
function renderDiagTable() {
  const D = MLA.diag;
  const ids = state.rects.map((r) => r.id).filter((id) => state.services.find((s) => s.id === id)?.kind !== 'local');
  const table = $('#diagTable');
  const head = document.createElement('tr');
  for (const label of [t('ui.stats.service'), ...D.PARTS.map((p) => D.PART_TEXT[p]), t('ui.stats.limit'), t('ui.diag.state'), t('selector.col')]) head.append(Object.assign(document.createElement('th'), { textContent: label }));
  const LEVEL = { ok: t('ui.diag.level.ok'), warn: t('ui.diag.level.warn'), broken: t('ui.diag.changedBadge'), unknown: t('ui.diag.level.unknown') };
  const STATE = { ok: t('ui.diag.part.ok'), warn: t('ui.diag.part.warn'), fail: t('ui.diag.part.fail'), unknown: t('ui.diag.part.unknown') };
  const rows = ids.map((id) => {
    const svc = state.services.find((s) => s.id === id);
    const d = diagById[id] || { input: 'unknown', send: 'unknown', response: 'unknown', level: 'unknown', notes: [] };
    const tr = document.createElement('tr');
    tr.dataset.level = d.level;
    const name = document.createElement('td');
    name.append(span('dot ready'), ` ${svc?.name || id}`);
    name.style.setProperty('--svc', svc?.color || 'var(--muted)');
    tr.append(name);
    for (const part of D.PARTS) {
      const td = document.createElement('td');
      td.dataset.state = d[part];
      td.textContent = `${D.MARK[d[part]]} ${STATE[d[part]]}`;
      tr.append(td);
    }
    const lim = document.createElement('td');
    lim.dataset.state = d.limit ? 'warn' : 'unknown';
    lim.textContent = d.limit ? t('ui.diag.limitCell') : '–';
    if (d.limit) lim.title = t('ui.diag.pageText', { text: d.limit });
    tr.append(lim);
    const st = document.createElement('td');
    st.textContent = LEVEL[d.level];
    if (d.notes.length) st.title = d.notes.join('\n');
    tr.append(st);
    const fix = document.createElement('td'); // 진단 · 셀렉터 고치기 (v0.35.0)
    fix.append(button(t('selector.open'), t('selector.openTitle', { name: svc?.name || id }), () => openDiag(id)));
    tr.append(fix);
    return tr;
  });
  table.replaceChildren(head, ...(rows.length ? rows : [Object.assign(document.createElement('tr'), { textContent: t('ui.diag.noPanels') })]));
  const broken = ids.filter((id) => diagById[id]?.level === 'broken');
  $('#diagHint').textContent = broken.length ? MLA.diag.HINT : '';
}

/** 패널 아래 변경 바를 띄우거나 내린다. 본체가 웹페이지 높이를 바만큼 줄여 바가 페이지에 가리지 않게 한다. */
function setChangeBar(id, on) {
  const p = panels.get(id);
  if (!p) return;
  p.changeBar.hidden = !on;
  syncPanelBar(id);
}

/**
 * 패널 아래 자리(BAR_H)를 변경 바 · 제안 바(v0.26.0 panel-offers.js: 넘기기 · 다시 보내기 · 다른 AI로)가 쓰는 동안만 비워 달라고 본체에 알린다.
 * 둘 다 떠 있으면 두 줄을 쌓는다 (v0.28.0): 변경 바가 맨 아래, 제안 바가 그 위 (.panel.bars-2). 본체는 웹페이지를 2줄만큼 줄인다.
 */
function syncPanelBar(id) {
  const p = panels.get(id);
  if (!p) return;
  const offer = !!p.offerBar && !p.offerBar.hidden;
  const change = !p.changeBar.hidden;
  const rows = (offer ? 1 : 0) + (change ? 1 : 0);
  p.el.classList.toggle('has-offer', offer);
  p.el.classList.toggle('bars-2', rows === 2);
  if (p.barRows === rows) return;
  p.barRows = rows;
  host.setPanelBar(id, rows);
}

const FINISHED_STATES = new Set(['done', 'timeout', 'no-answer']);

const ANSWER_TEXT = {
  get answering() { return t('ui.answer.answering'); },
  get done() { return t('ui.answer.done'); },
  get timeout() { return t('ui.answer.timeout'); },
  get 'no-answer'() { return t('ui.answer.noStart'); },
  clear: '',
};

// 상태 글자를 1.8초 동안만 다른 글로 바꿔 보여 주고 원래대로 돌립니다 (예: t('ui.panel.answerCopied')).
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

const SEND_TEXT = {
  get sending() { return t('ui.send.sending'); },
  get sent() { return t('ui.send.sentShort'); },
  get error() { return t('ui.answerState.error'); },
  get retrying() { return t('retry.retrying'); },
};
const ATTACH_TEXT = {
  get failed() { return t('ui.attach.noAttach'); },
  get skipped() { return t('ui.attach.noAttach'); },
  get partial() { return t('ui.attach.partial'); },
  get fallback() { return t('ui.attach.fallback'); },
};

// 답변을 기다리는 동안 걸린 시간을 1초마다 보여 준다.
const fmtElapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? t('ui.time.sec', { s }) : t('ui.time.minSec', { m: Math.floor(s / 60), s: s % 60 });
};

// 답변을 기다리는 패널마다 "답변 중… 12초"처럼 기다린 시간을 1초마다 고쳐 씁니다.
function tickAnswerTimers() {
  for (const p of panels.values()) {
    const st = p.status.dataset.state;
    if (!p.answerStart || (st !== 'answer-answering' && st !== 'answer-timeout')) continue;
    const label = st === 'answer-answering' ? ANSWER_TEXT.answering : ANSWER_TEXT.timeout;
    p.status.textContent = `${label} ${fmtElapsed(Date.now() - p.answerStart)}`;
  }
}
setInterval(tickAnswerTimers, 1000);

// 본체가 "이 패널 상태가 바뀌었어"라고 알려 올 때마다 실행됩니다.
// 알림 종류: 불러오는 중(loading) · 주소(url) · 오류(error) · 로그인 상태(login) · 보내기 결과(send) · 답변 상태(answer)
// 답변 완료('done')면 다른 파일들(project.js 등)에게도 알려 📋 파일 모아보기·📂 요청 파일 버튼을 띄우게 합니다.
host.on('panel:status', ({ id, loading, url, error, login, send, answer, chars, late, attach, attaching, diag, notice, local }) => {
  if (diag) {
    // 셀렉터 자가진단 결과는 따로 온다 (다른 상태와 섞이지 않음)
    diagById[id] = diag;
    renderDiagBadge(id);
    if (state?.chatView === 'help') renderDiagTable();
    return;
  }
  if (local) renderLocalChat(id, local); // 로컬 LLM 패널의 대화 (v0.16.0)
  const p = panels.get(id);
  if (!p) return;
  if (notice) return flash(p.status, notice);
  if (local && login === undefined && send === undefined && answer === undefined) return; // 잠깐 보여 주는 안내 (예: 로그인 창이 허용 밖 주소로 감)
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
    // 답변 평가 버튼: 이번 라운드에 보낸 패널의 답이 끝나면 띄우고, 다시 답하는 중이거나 새 대화면 내린다
    if (answer === 'clear') feedback.targets.delete(id);
    if (answer === 'done') feedback.done.add(id);
    else feedback.done.delete(id);
    renderFeedback(id);
    if (answer === 'answering') {
      p.answerStart = Date.now();
      setChangeBar(id, false); // 페이지에서 직접 물어본 경우에도 지난 답변의 변경 바는 내린다
    }
    p.status.textContent =
      answer === 'done' ? `${ANSWER_TEXT.done} · ${t('preview.chars', { n: chars })}${late ? t('ui.answer.late') : ''}` : ANSWER_TEXT[answer];
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
    window.onPanelUrl?.(id, url); // 프로젝트 모드: 지난번 대화를 다시 열면 그 작업을 되살린다 (v0.28.0)
    if (!error) p.dot.classList.remove('error'); // 다시 열려서 연결되면 오류 표시를 지운다
  }
  if (send) {
    p.status.textContent = send === 'error' ? `${SEND_TEXT.error}: ${error}` : SEND_TEXT[send];
    p.status.dataset.state = `send-${send}`;
    if (send === 'sending') {
      feedback.done.delete(id);
      renderFeedback(id);
      p.attachBadge.hidden = true;
      p.needBtn.hidden = true;
      p.collectBtn.hidden = true;
      setChangeBar(id, false);
      if (attaching) p.status.textContent = t('ui.send.attaching', { n: attaching });
    }
    // 첨부에 실패한 패널은 글만 보냈다. 머리줄에 표시를 남겨 둔다 (다음에 보내거나 새 대화를 열 때까지).
    const warn = send === 'sent' && attach && ATTACH_TEXT[attach.state];
    if (warn) {
      p.status.textContent = `${SEND_TEXT.sent} · ${warn}`;
      p.status.dataset.state = 'send-attach-warn';
      p.attachBadge.hidden = false;
      p.attachBadge.textContent = `[+] ${warn}`;
      p.attachBadge.title = attach.error || warn;
    }
    if (send === 'sent') {
      const st = p.status.dataset.state;
      setTimeout(() => p.status.dataset.state === st && (p.status.textContent = ''), warn ? 8000 : 3000);
    }
    return;
  }
  if (error) {
    p.url.textContent = t('ui.panel.error', { error });
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
  renderStatusLine();
});

// 툴바의 상태줄: "2/3 ready" — 열린 패널 중 쓸 수 있는(로그인된) 패널 수 (v0.19.0)
function renderStatusLine() {
  const el = $('#statusLine');
  if (!el) return;
  const all = [...panels.values()];
  const ready = all.filter((p) => p.dot.classList.contains('ready')).length;
  const bad = all.some((p) => p.dot.classList.contains('error'));
  el.textContent = all.length ? `${ready}/${all.length} ready` : '';
  el.dataset.state = bad ? 'error' : all.length && ready === all.length ? 'ok' : 'wait';
  if (Date.now() < remoteFlashUntil && state?.remote?.version) {
    const rb = span('remote-badge', `selectors v${state.remote.version}`);
    rb.title = t('ui.remote.gotBadge');
    el.append(rb);
  }
  // 새 버전이 있으면 "update 0.20.1" (누르면 설정 화면의 업데이트 칸)
  const badge = state?.update && MLA.update ? MLA.update.badgeText(state.update) : '';
  if (badge) {
    const b = span('update-badge', badge);
    b.title = MLA.update.statusText(state.update);
    b.addEventListener('click', () => host.setView('help'));
    el.append(b);
  }
}

// ---------- 앱 업데이트 (v0.20.0) ----------
// 설정 화면의 업데이트 칸: 지금 버전 · 상태 글 · [지금 확인] [다운로드] [다시 시작해서 설치], 자동 확인 켜기/끄기.
// 크롬 확장은 받기 · 설치가 없고(압축해제 방식) 새 버전이 있다는 것만 알린다.
function renderUpdate() {
  const u = state?.update;
  const box = $('#updateStatus');
  if (!box) return;
  if (!u || !MLA.update) {
    box.textContent = t('ui.update.unsupported');
    return;
  }
  box.textContent = MLA.update.statusText(u) + (u.checkedAt ? ` · ${t('ui.remote.checked', { time: fmtTime(u.checkedAt) })}` : '');
  box.dataset.state = u.state;
  $('#updateAuto').checked = state.autoUpdate !== false;
  $('#updateCheck').disabled = ['checking', 'downloading', 'dev'].includes(u.state);
  $('#updateDownload').hidden = !(u.canInstall && u.state === 'available');
  $('#updateInstall').hidden = u.state !== 'downloaded';
  $('#updateOpen').hidden = !(u.state === 'available' || u.state === 'error');
}
$('#updateAuto').addEventListener('change', (e) => host.setSettings({ autoUpdate: e.target.checked }));
$('#updateCheck').addEventListener('click', () => host.update?.check());
$('#updateDownload').addEventListener('click', () => host.update?.download());
$('#updateInstall').addEventListener('click', () => {
  if (confirm(t('ui.update.installConfirm'))) host.update?.install();
});
$('#updateOpen').addEventListener('click', () => host.update?.openReleases());

// ---------- 공통 입력창 ----------

// 입력창 위에 "답변 3개 중 2개 완료" 같은 요약을 보여 줍니다.
function updateAnswerSummary() {
  const states = [...panels.values()].map((p) => p.status.dataset.state || '');
  const asked = states.filter((s) => s.startsWith('answer-') && s !== 'answer-clear').length;
  if (!asked) return;
  const done = states.filter((s) => s === 'answer-done').length;
  $('#sendHint').textContent = done === asked ? t('ui.answer.allDone', { n: done }) : t('ui.answer.progress', { n: done, total: asked });
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
    const chip = button(svcLabel(svc), t('ui.target.toggle'), () => {
      targets.has(id) ? targets.delete(id) : targets.add(id);
      renderTargets();
    });
    chip.className = 'chip';
    chip.style.setProperty('--svc', svc.color);
    chip.classList.toggle('on', targets.has(id));
    box.append(chip);
  }
  renderAttachHint();
  window.renderRecommendChip?.(); // 추천 조합 제안 (v0.27.0, recommend-ui.js — 설정에서 켰을 때만)
}
