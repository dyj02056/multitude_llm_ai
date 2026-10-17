'use strict';

const $ = (sel) => document.querySelector(sel);
const panelsEl = $('#panels');
const panels = new Map(); // id -> { el, dot, url, status }
let state = null;

const HINTS = {
  login: 'Google 계정으로 로그인해 주세요',
  pick: '로그인됨 · 모델을 선택하세요',
  chat: '패널마다 Google로 자동 로그인을 시도합니다',
};

const LOGIN_TEXT = {
  'needs-login': '로그인 필요',
  'logging-in': 'Google로 로그인 중…',
  google: 'Google 화면에서 계속해 주세요',
  captcha: '사람 확인(캡차)을 직접 풀어 주세요',
  ready: '',
};

function button(label, title, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function span(className, text = '') {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

// ---------- 모델 선택 화면 ----------

function renderPick() {
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
    label.append(box, span('swatch'), span('name', svc.name), span('url', new URL(svc.url).hostname));
    list.append(label);
  }
}

$('#openBtn').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('#modelList input:checked')].map((b) => b.value);
  if (!ids.length) return alert('모델을 하나 이상 선택해 주세요.');
  host.openModels(ids);
});

// ---------- 패널 머리줄 ----------

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
    Object.assign(p.el.style, {
      left: `${r.frame.x}px`,
      top: `${r.frame.y}px`,
      width: `${r.frame.width}px`,
      height: `${r.frame.height}px`,
    });
  }
}

function createPanel(svc) {
  const el = document.createElement('section');
  el.className = 'panel';
  el.style.setProperty('--svc', svc.color);

  const head = document.createElement('div');
  head.className = 'panel-head';
  const dot = span('dot');
  const url = span('url', svc.url);
  const status = span('status');
  const loginBtn = button('G 로그인', 'Google로 다시 로그인 시도', () => host.panelAction(svc.id, 'login'));
  loginBtn.className = 'login-btn';
  loginBtn.hidden = true;

  head.append(
    dot,
    span('name', svc.name),
    url,
    status,
    loginBtn,
    button('복사', '최신 답변 복사', async () => {
      const r = await host.copyAnswer(svc.id);
      flash(status, r.copied ? '답변을 복사했습니다' : '복사할 답변이 없습니다');
    }),
    button('＋', '새 대화', () => host.panelAction(svc.id, 'newchat')),
    button('←', '뒤로', () => host.panelAction(svc.id, 'back')),
    button('⌂', '처음 주소로', () => host.panelAction(svc.id, 'home')),
    button('↻', '새로고침', () => host.panelAction(svc.id, 'reload')),
    button('{ }', '개발자 도구', () => host.panelAction(svc.id, 'devtools')),
  );
  el.append(head);
  panelsEl.append(el);
  const p = { el, dot, url, status, loginBtn };
  panels.set(svc.id, p);
  return p;
}

const ANSWER_TEXT = {
  answering: '답변 중…',
  done: '답변 완료',
  timeout: '답변이 너무 오래 걸립니다',
  'no-answer': '답변이 시작되지 않았습니다',
  clear: '',
};

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

host.on('panel:status', ({ id, loading, url, error, login, send, answer, chars }) => {
  const p = panels.get(id);
  if (!p) return;
  if (answer) {
    p.status.textContent = answer === 'done' ? `${ANSWER_TEXT.done} · ${chars}자` : ANSWER_TEXT[answer];
    p.status.dataset.state = `answer-${answer}`;
    updateAnswerSummary();
    return;
  }
  if (loading !== undefined) p.dot.classList.toggle('loading', loading);
  if (url) p.url.textContent = url;
  if (send) {
    p.status.textContent = send === 'error' ? `${SEND_TEXT.error}: ${error}` : SEND_TEXT[send];
    p.status.dataset.state = `send-${send}`;
    if (send === 'sent') setTimeout(() => p.status.dataset.state === 'send-sent' && (p.status.textContent = ''), 3000);
    return;
  }
  if (error) {
    p.url.textContent = `오류: ${error}`;
    p.dot.classList.add('error');
  }
  if (login) {
    p.status.textContent = LOGIN_TEXT[login] ?? '';
    p.status.dataset.state = login;
    p.dot.classList.toggle('ready', login === 'ready');
    p.loginBtn.hidden = login !== 'needs-login';
  }
});

// ---------- 공통 입력창 ----------

function updateAnswerSummary() {
  const states = [...panels.values()].map((p) => p.status.dataset.state || '');
  const asked = states.filter((s) => s.startsWith('answer-') && s !== 'answer-clear').length;
  if (!asked) return;
  const done = states.filter((s) => s === 'answer-done').length;
  $('#sendHint').textContent = done === asked ? `답변 ${done}개 모두 완료` : `답변 완료 ${done}/${asked}`;
}

const targets = new Set(); // 보낼 대상 서비스 id
let knownTargets = new Set(); // 지금까지 칩을 만든 서비스 (새로 열린 패널은 기본으로 켠다)

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
}

let sending = false;

async function send() {
  const box = $('#prompt');
  const text = box.value.trim();
  if (!text || sending) return;
  const ids = [...targets];
  if (!ids.length) return alert('보낼 대상을 하나 이상 켜 주세요.');
  sending = true;
  $('#sendBtn').disabled = true;
  try {
    const results = await host.sendPrompt(text, ids);
    const failed = results.filter((r) => !r.ok);
    if (!failed.length) box.value = '';
    $('#sendHint').textContent = failed.length
      ? `${failed.map((r) => r.id).join(', ')} 보내기 실패 — 입력 내용은 남겨 두었습니다`
      : `${results.length}곳에 보냈습니다`;
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

host.on('state', (next) => {
  const modeChanged = !state || state.mode !== next.mode;
  state = next;
  document.body.dataset.mode = state.mode;
  $('#hint').textContent = HINTS[state.mode];
  for (const b of document.querySelectorAll('[data-layout]')) {
    b.classList.toggle('active', b.dataset.layout === state.layout);
  }
  if (state.mode === 'pick' && modeChanged) renderPick();
  syncPanels();
  if (state.mode === 'chat') renderTargets();
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
  if (confirm('로그아웃하면 모든 서비스의 로그인과 기록(쿠키)이 지워집니다. 계속할까요?')) host.logout();
});
