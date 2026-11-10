'use strict';

// 스크린샷용 가짜 본체 (Windows 앱의 preload.js + main.js 대신). 화면 코드는 진짜 src/renderer를 그대로 쓴다.
// 장면(?scene=…)마다 상태 · 패널 · 답변을 꾸미고, 버튼을 눌러 그 화면을 연 뒤 run.js에 "찍어도 됨"을 알린다.
const { ipcRenderer } = require('electron');
const { SERVICES, uploadOf, fileBytesOf } = require('../../src/shared/services');
const { placeCells } = require('../../src/shared/layout');
const { shortcutList } = require('../../src/shared/shortcuts');
const { normalizeLibrary } = require('../../src/shared/prompt-lib');
const LL = require('../../src/shared/local-llm');
const S = require('./sample');

const scene = new URLSearchParams(location.search).get('scene') || '02-ask-all';
const TOOLBAR_H = 44;
const COMPOSER_H = 132;
const HEADER_H = 28;
const LOCAL = ['19-local-llm', '20-local-llm-settings'].includes(scene);
const localSvc = LL.localService({ baseUrl: 'http://localhost:11434' });
const all = LOCAL ? [...SERVICES, localSvc] : SERVICES;
const svc = (id) => all.find((s) => s.id === id);
const selected = LOCAL ? ['gemini', 'chatgpt', 'claude', LL.LOCAL_ID] : ['gemini', 'chatgpt', 'deepseek', 'perplexity'];

const listeners = { state: [], 'panel:status': [], 'synth:status': [], shortcut: [] };
const emit = (ch, p) => listeners[ch].forEach((fn) => fn(p));
let mode = scene === '01-model-picker' ? 'pick' : 'chat';
let chatView = 'panels';
let layout = 'grid';
const now = Date.now();

const answers = {
  question: S.QUESTION,
  answers: selected.filter((id) => S.ANSWERS[id]).map((id) => ({ id, name: svc(id).name, color: svc(id).color, text: S.ANSWERS[id], md: S.ANSWERS[id] })),
  analysis: { judge: 'Claude', at: now, text: S.ANALYSIS_MD, md: S.ANALYSIS_MD, mode: 'analysis', names: ['Gemini', 'ChatGPT', 'DeepSeek', 'Perplexity'] },
};
const record = {
  id: 'r1',
  at: now - 5 * 60e3,
  question: S.QUESTION,
  targets: selected,
  files: [],
  synth: [answers.analysis],
  answers: Object.fromEntries(answers.answers.map((a, i) => [a.id, { text: a.text, md: a.md, state: 'done', chars: a.text.length, firstMs: 2100 + i * 900, doneMs: 9000 + i * 2500 }])),
};
const item = (id, q, mins, n) => ({ id, at: now - mins * 60e3, question: q, answered: n, targets: 4, files: 0, synth: id === 'r1' ? 1 : 0, analysis: id === 'r1' ? 1 : 0 });

// 서비스 화면 상태 표 예시: 셋은 정상, DeepSeek은 답변 영역을 못 찾음 (실제로는 shared/diag.js가 채움)
const ok = { input: 'ok', send: 'ok', response: 'ok', level: 'ok', message: '', hint: '', notes: [], limit: null, limitHint: '' };
const DIAG = {
  gemini: ok,
  chatgpt: { ...ok, send: 'warn', level: 'warn', notes: ['보내기 버튼 대신 Enter로 보냄'] },
  deepseek: { ...ok, response: 'fail', level: 'broken', message: '답변 영역을 찾지 못했습니다', hint: '⌂로 처음 화면 → 설정 › 셀렉터 지금 확인' },
  perplexity: { ...ok, limit: { at: now - 1800e3, text: 'You have reached your daily limit' }, limitHint: '잠시 뒤 다시 하거나 다른 AI 답을 쓰세요' },
};

function rects() {
  if (mode !== 'chat') return [];
  const box = { x: 0, y: TOOLBAR_H, width: innerWidth, height: innerHeight - TOOLBAR_H - COMPOSER_H };
  const cells = placeCells(layout, selected.length, box, 4);
  return selected.map((id, i) => ({ id, frame: cells[i], hidden: false, focused: false, bar: false, content: { x: cells[i].x, y: cells[i].y + HEADER_H, width: cells[i].width, height: cells[i].height - HEADER_H } }));
}

// 패널 안 웹페이지 자리 = 테스트용 채팅 페이지 (실제 앱에서는 본체가 여기에 AI 사이트를 얹는다)
const frames = new Map();
const chatUrl = (id) => (id === LL.LOCAL_ID ? null : `shot://repo/__chat?id=${id}&scene=${scene}`);
function placeFrames(rs, show) {
  for (const r of rs) {
    const src = chatUrl(r.id);
    if (!src) continue;
    let f = frames.get(r.id);
    if (!f) {
      f = document.createElement('iframe');
      f.src = src;
      f.style.cssText = 'position:fixed;border:0;z-index:1;background:#1e1f22';
      document.body.append(f);
      frames.set(r.id, f);
    }
    Object.assign(f.style, { left: `${r.content.x}px`, top: `${r.content.y}px`, width: `${r.content.width}px`, height: `${r.content.height}px`, display: show ? 'block' : 'none' });
  }
}

function push() {
  const rs = rects();
  placeFrames(rs, mode === 'chat' && chatView === 'panels');
  emit('state', {
    mode, chatView, layout, selected, maxSelected: 6,
    attachLimits: { maxFiles: 10, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 },
    synthTarget: 'gemini', autoSynth: false, answerTimeoutMin: 20, timeoutChoices: [5, 10, 20, 30, 60],
    remoteSelectors: true, remote: { source: 'remote', version: 12, updated: '2026-11-08', checkedAt: now - 3600e3 }, diag: ['15-screen-status', '25-diag'].includes(scene) ? DIAG : {},
    services: all.map((s) => ({ id: s.id, name: s.name, color: s.color, url: s.url, kind: s.kind || 'web', accept: uploadOf(s).accept, maxFileBytes: fileBytesOf(s) })),
    local: { enabled: LOCAL, baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' },
    autoUpdate: true,
    update: { state: 'none', current: require('../../package.json').version, version: '', percent: null, error: '', checkedAt: now - 600e3, canInstall: true },
    storage: { encrypted: true },
    rects: rs,
  });
}

window.host = {
  ui: { hints: { pick: '모델을 고르세요', chat: '' }, pickNote: '선택한 모델만 패널로 엽니다. 각 서비스에는 Google 계정으로 로그인합니다.', loginButton: { label: 'G 로그인', title: '' }, devtools: true },
  openModels: () => ((mode = 'chat'), push()),
  pickModels: () => ((mode = 'pick'), push()),
  logout() {},
  sendPrompt: async (_t, targets) => targets.map((id) => ({ id, ok: true })),
  sendFollowUp: async (id) => ({ id, ok: true }),
  copyAnswer: async () => ({ copied: 1, total: 1 }),
  setView: (v) => ((chatView = v), push()),
  getAnswers: async () => answers,
  getAnswer: async (id) => answers.answers.find((a) => a.id === id) || null,
  history: {
    list: async () => [item('r1', S.QUESTION, 5, 4), item('r2', 'React와 Vue 중 무엇을 먼저 배울까?', 42, 4), item('r3', '이 SQL 쿼리 느린 이유 찾아줘', 180, 3), item('r4', '여름 제주 3박 4일 일정 짜줘', 1500, 4)],
    get: async () => record,
    stats: async () => ({ rows: answers.answers.map((a, i) => ({ id: a.id, name: a.name, asked: 24 - i, sent: 24 - i, done: 22 - i, timeout: i % 2, noAnswer: 0, sendFail: 0, limit: i === 3 ? 1 : 0, firstMedianMs: 2100 + i * 900, doneMedianMs: 9000 + i * 2500, charsAvg: 1400 - i * 120 })) }),
    remove: async () => true,
    clear: async () => true,
  },
  copyText: async () => true,
  saveFile: async () => ({ ok: true }),
  local: { setPrefs: async () => ({ ok: true }), models: async () => ({ ok: true, models: ['qwen2.5:7b', 'llama3.1:8b'] }) },
  shortcuts: async () => shortcutList({}),
  runSynth: async () => ({ ok: true }),
  setSynth() {}, setSettings() {}, refreshRemote: async () => ({}),
  setLayout: (v) => ((layout = v), push()),
  setFocus() {}, setSidebar() {}, setPanelBar() {},
  update: { check: async () => {}, download: async () => {}, install: async () => false, openReleases() {} },
  project: Object.fromEntries(['pick', 'restore', 'reconnect', 'close', 'readDir', 'readFile', 'writeFile', 'deleteFile', 'globalExclude', 'loadState', 'saveState'].map((n) => [n, async () => null])),
  library: {
    load: async () =>
      normalizeLibrary({
        templates: [{ id: 't1', name: '코드 리뷰 (보안 관점)', text: '{{언어}} 코드를 {{관점|보안}} 관점에서 리뷰해 줘.\n\n{q}', fav: true }],
        skills: [{ id: 's1', name: '코드 리뷰어', description: '버그 · 보안 · 가독성 순서로 본다', body: '# 코드 리뷰어\n\n- 버그를 먼저 찾는다\n- 보안 문제는 근거와 함께\n- 고칠 코드는 전체 파일로' }],
      }),
    save: async () => true,
  },
  panelAction() {},
  on: (ch, fn) => listeners[ch]?.push(fn),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const click = (s) => $(s)?.click();

window.addEventListener('DOMContentLoaded', async () => {
  await sleep(80);
  push();
  for (const id of selected) emit('panel:status', { id, login: 'ready', url: svc(id).url });
  if (scene === '02-ask-all') {
    for (const id of ['gemini', 'chatgpt', 'deepseek']) emit('panel:status', { id, answer: 'done', chars: S.ANSWERS[id].length });
    emit('panel:status', { id: 'perplexity', answer: 'answering' });
  }
  if (LOCAL) {
    emit('panel:status', { id: LL.LOCAL_ID, login: 'ready', local: { messages: [{ role: 'user', text: S.QUESTION }, { role: 'assistant', text: S.ANSWERS.claude.replace('둘 다', '로컬 모델 답: 둘 다') }], streaming: false, model: 'qwen2.5:7b', error: '' } });
    for (const id of ['gemini', 'chatgpt', 'claude']) emit('panel:status', { id, answer: 'done', chars: (S.ANSWERS[id] || '').length });
  }
  if (scene === '03-synthesis') emit('synth:status', { state: 'sent', judge: 'Gemini', count: 3, cause: 'manual' });
  await sleep(200);

  if (['04-compare', '13-analysis', '14-diff-highlight'].includes(scene)) {
    click('#compareBtn');
    await sleep(500);
    if (scene === '13-analysis') click('#compareTabs button[data-ctab="analysis"]');
    if (scene === '14-diff-highlight') click('#diffToggle');
  }
  if (scene === '05-history') click('#historyBtn');
  if (scene === '25-diag') {
    // 머리줄의 ⚠ 화면이 바뀐 것 같음 → 자가진단 창
    const badge = [...document.querySelectorAll('.panel-head .diag-badge')].find((b) => !b.hidden && b.textContent.includes('화면이'));
    badge?.click();
  }
  if (scene === '06-settings-shortcuts') click('#helpBtn');
  // 설정 화면의 표들: 그 칸이 맨 위에 오게 스크롤
  const helpAt = { '15-screen-status': '#diagTable', '17-stats': '#statsTable', '20-local-llm-settings': '#localEnabled' }[scene];
  if (helpAt) {
    click('#helpBtn');
    await sleep(500);
    const el = $(helpAt);
    const box = $('.help-box');
    box.scrollTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60;
  }
  if (scene === '12-library') {
    click('#libraryBtn');
    await sleep(400);
    click('[data-libtab="skills"]');
    await sleep(300);
    [...document.querySelectorAll('.lib-row')].find((r) => r.textContent.includes('코드 리뷰어'))?.click();
  }
  if (scene === '07-attachments') {
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 40 });
    const g = c.getContext('2d');
    g.fillStyle = '#58a6ff';
    g.fillRect(0, 0, 64, 40);
    g.fillStyle = '#0d1117';
    g.fillRect(8, 8, 30, 6);
    g.fillRect(8, 20, 46, 4);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'image.png', { type: 'image/png' }));
    dt.items.add(new File(['# 회의록\n- 결정 사항'], '회의록.md', { type: 'text/markdown' }));
    dt.items.add(new File([new Uint8Array(420000)], '분기 보고서.pdf', { type: 'application/pdf' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); // Ctrl+V로 붙여 넣은 것처럼
    $('#prompt').value = '첨부한 보고서와 회의록을 바탕으로 다음 분기 할 일을 정리해 줘';
  }
  if (scene === '11-patch-preview') {
    // 미리보기 창: 프로젝트 없이 모양만 꾸민다 (실제로는 변경 바 › 변경 보기)
    $('#patchTitle').textContent = '미리보기 · 적용 — Claude';
    $('#patchNote').textContent = '파일 2개 · +9 −3';
    $('#patchBody').innerHTML = `
      <div class="pf"><div class="pf-head"><input type="checkbox" checked><span class="op modify">수정</span><span class="path">src/api/user.js</span><span class="add">+6</span><span class="del">−2</span></div>
      <pre><span class="h">@@ -12,9 +12,13 @@ export async function getUser(id) {</span><span>   const res = await fetch(\`/api/users/\${id}\`);</span><span class="d">-  return res.json();</span><span class="d">-}</span><span class="a">+  if (!res.ok) {</span><span class="a">+    throw new Error(\`사용자를 불러오지 못했습니다 (\${res.status})\`);</span><span class="a">+  }</span><span class="a">+  return res.json();</span><span class="a">+}</span><span class="a">+</span><span> </span></pre></div>
      <div class="pf"><div class="pf-head"><input type="checkbox" checked><span class="op create">새 파일</span><span class="path">test/user.test.js</span><span class="add">+3</span><span class="del">−1</span></div>
      <pre><span class="h">@@ -0,0 +1,3 @@</span><span class="a">+test('없는 사용자면 오류', async () => {</span><span class="a">+  await assert.rejects(getUser(-1), /불러오지 못했습니다/);</span><span class="a">+});</span></pre></div>`;
    $('#patchStatus').textContent = '체크한 2개를 씁니다 · Enter로 적용';
    $('#patchTest').hidden = false;
    $('#patchModal').hidden = false;
  }
  await sleep(700);
  ipcRenderer.send('shot:ready');
});
