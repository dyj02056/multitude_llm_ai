'use strict';

// 스크린샷용 가짜 본체 (Windows 앱의 preload.js + main.js 대신). 화면 코드는 진짜 src/renderer를 그대로 쓴다.
// 장면(?scene=…)마다 상태 · 패널 · 답변을 꾸미고, 버튼을 눌러 그 화면을 연 뒤 run.js에 "찍어도 됨"을 알린다.
const { ipcRenderer } = require('electron');
const { SERVICES, uploadOf, fileBytesOf } = require('../../src/shared/services');
const { placeCells } = require('../../src/shared/layout');
const { shortcutList } = require('../../src/shared/shortcuts');
const { normalizeLibrary } = require('../../src/shared/prompt-lib');
const LL = require('../../src/shared/local-llm');
const { createHistory } = require('../../src/shared/history-core');
const S = require('./sample');

const scene = new URLSearchParams(location.search).get('scene') || '02-ask-all';
// MLA_SHOT_LANG=en: 영어 화면으로 찍는다 (v0.30.0, 기본 한국어). 예시 질문 · 답변은 한국어 그대로다.
const LANG = process.env.MLA_SHOT_LANG === 'en' ? 'en' : 'ko';
require('../../src/shared/i18n').setLang(LANG); // 이 파일이 쓰는 공통 모듈(단축키 이름 등)의 글도 같은 언어로
const TOOLBAR_H = 44;
const COMPOSER_H = 132;
const HEADER_H = 28;
const LOCAL = ['19-local-llm', '20-local-llm-settings'].includes(scene);
const LOCAL_JUDGE = scene === '44-local-judge'; // v0.29.0: 로컬 LLM을 켜 두었지만 패널은 없음 → 패널 없이 판정
const localSvc = LL.localService({ baseUrl: 'http://localhost:11434' });
const all = LOCAL || LOCAL_JUDGE ? [...SERVICES, localSvc] : SERVICES;
const svc = (id) => all.find((s) => s.id === id);
const PREVIEW = scene === '26-send-preview';
// v0.28.0 프로젝트 장면: 가짜 프로젝트 폴더(sample.js PROJECT_FILES) · 두 AI가 같은 파일을 고친 답 · 가짜 테스트 실행 · 가짜 git
const PROJ = ['36-check-scripts', '37-mix-apply', '38-commit', '39-bars-stacked', '40-project-restore'].includes(scene);
const SIDEBAR_W = 300;
let sidebar = false;
const barRows = new Map();
// 보내기 전 미리보기 장면은 문서를 받지 않는 Duck.ai를 넣어 "빼고 보냄" 경고가 보이게 한다
const selected = LOCAL ? ['gemini', 'chatgpt', 'claude', LL.LOCAL_ID] : PREVIEW ? ['gemini', 'chatgpt', 'claude', 'duckai'] : ['gemini', 'chatgpt', 'deepseek', 'perplexity'];

const listeners = { state: [], 'panel:status': [], 'synth:status': [], shortcut: [] };
const emit = (ch, p) => listeners[ch].forEach((fn) => fn(p));
let mode = scene === '01-model-picker' ? 'pick' : 'chat';
let chatView = 'panels';
let layout = 'grid';
const now = Date.now();

const answers = {
  question: PROJ ? 'getUser가 실패 응답을 처리하도록 고쳐 줘' : S.QUESTION,
  answers: selected.filter((id) => S.ANSWERS[id]).map((id) => ({ id, name: svc(id).name, color: svc(id).color, text: S.ANSWERS[id], md: S.ANSWERS[id] })),
  analysis: { judge: 'Claude', at: now, text: S.ANALYSIS_MD, md: S.ANALYSIS_MD, mode: 'analysis', names: ['Gemini', 'ChatGPT', 'DeepSeek', 'Perplexity'] },
};
// v0.26.0 장면: 다시 분석(판정 AI를 바꿔 두 번) · 이어 묻기 · 토론
const NAMES4 = ['Gemini', 'ChatGPT', 'DeepSeek', 'Perplexity'];
const analysis2 = { judge: 'Gemini', at: now - 10 * 60e3, text: S.ANALYSIS_MD2, md: S.ANALYSIS_MD2, mode: 'analysis', names: NAMES4 };
if (scene === '30-analysis-compare') answers.analyses = [analysis2, answers.analysis];
if (PROJ) for (const a of answers.answers) if (S.PROJECT_ANSWERS[a.id]) Object.assign(a, { text: S.PROJECT_ANSWERS[a.id], md: S.PROJECT_ANSWERS[a.id] });
if (scene === '29-debate-result') {
  answers.chain = S.CHAIN(now);
  answers.debates = [{ judge: 'Gemini', at: now - 60e3, text: S.DEBATE_RESULT, md: S.DEBATE_RESULT, mode: 'debate', names: ['ChatGPT', 'DeepSeek', 'Perplexity'], rounds: 2 }];
}
const record = {
  id: 'r1',
  at: now - 5 * 60e3,
  question: S.QUESTION,
  targets: selected,
  files: [],
  synth: [answers.analysis],
  answers: Object.fromEntries(answers.answers.map((a, i) => [a.id, { text: a.text, md: a.md, state: 'done', chars: a.text.length, firstMs: 2100 + i * 900, doneMs: 9000 + i * 2500 }])),
};
record.chain = S.CHAIN(now); // 기록 화면 아래 이어 묻기 · 토론 (v0.26.0)
// v0.27.0: 진짜 기록장(shared/history-core.js)에 예시 기록을 넣어 거르기 · 대화 줄기 · 태그 · 추천을 그대로 계산한다
Object.assign(record, { threadId: 'tpyjs', kind: 'general', star: true, tags: ['언어 비교', '공부'], feedback: { gemini: 1 } });
for (const [i, a] of Object.values(record.answers).entries()) a.metrics = { doneMs: 9000 + i * 2500 };
const fakeHistory = createHistory(() => {});
fakeHistory.load([record, ...S.HISTORY(now, selected)]);

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
  const side = sidebar ? SIDEBAR_W : 0;
  const box = { x: side, y: TOOLBAR_H, width: innerWidth - side, height: innerHeight - TOOLBAR_H - COMPOSER_H };
  const cells = placeCells(layout, selected.length, box, 4);
  // 바 줄 수만큼 웹페이지를 줄인다 (본체 main.js와 같게, v0.28.0: 변경 바 + 제안 바 = 2줄)
  return selected.map((id, i) => {
    const bar = (barRows.get(id) || 0) * 34;
    return { id, frame: cells[i], hidden: false, focused: false, bar: !!bar, content: { x: cells[i].x, y: cells[i].y + HEADER_H, width: cells[i].width, height: cells[i].height - HEADER_H - bar } };
  });
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
    synthTarget: LOCAL_JUDGE ? 'local' : 'gemini', autoSynth: false, answerTimeoutMin: 20, timeoutChoices: [5, 10, 20, 30, 60], historyMax: 500, historyMaxChoices: [100, 500, 1000, 2000],
    remoteSelectors: true, remote: { source: 'remote', version: 12, updated: '2026-11-08', checkedAt: now - 3600e3 }, diag: ['15-screen-status', '25-diag'].includes(scene) ? DIAG : {},
    services: all.map((s) => ({ id: s.id, name: s.name, color: s.color, url: s.url, kind: s.kind || 'web', accept: uploadOf(s).accept, maxFileBytes: fileBytesOf(s) })),
    local: { enabled: LOCAL || LOCAL_JUDGE, baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b', contextTokens: 8192 },
    autoUpdate: true,
    notify: { round: true, limit: true, error: true, synth: false }, sendPreview: false, retryOnce: true, autoRecommend: scene === '35-recommend-chip', commitOffer: true, lang: LANG, uiLang: LANG,
    update: { state: 'none', current: require('../../package.json').version, version: '', percent: null, error: '', checkedAt: now - 600e3, canInstall: true },
    storage: { encrypted: true },
    rects: rs,
  });
}

window.host = {
  lang: LANG,
  // 영어로 찍을 때는 화면의 기본 글(사전)을 쓴다
  ui: LANG === 'en' ? { devtools: true } : { hints: { pick: '모델을 고르세요', chat: '' }, pickNote: '선택한 모델만 패널로 엽니다. 각 서비스에는 Google 계정으로 로그인합니다.', loginButton: { label: 'G 로그인', title: '' }, devtools: true },
  openModels: () => ((mode = 'chat'), push()),
  pickModels: () => ((mode = 'pick'), push()),
  logout() {},
  sendPrompt: async (_t, targets) => targets.map((id) => ({ id, ok: true })),
  sendFollowUp: async (id) => ({ id, ok: true }),
  copyAnswer: async () => ({ copied: 1, total: 1 }),
  handoff: async () => ({ ok: true }),
  resend: async () => ({ ok: true }),
  sendElsewhere: async () => ({ ok: true }),
  debate: { start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
  setView: (v) => ((chatView = v), push()),
  getAnswers: async () => answers,
  getAnswer: async (id) => answers.answers.find((a) => a.id === id) || null,
  history: {
    list: async (q, f) => fakeHistory.list(q || '', f),
    get: async (id) => fakeHistory.get(id),
    setTags: async (id, tags) => fakeHistory.setTags(id, tags),
    setStar: async (id, on) => fakeHistory.setStar(id, on),
    thread: async (tid) => fakeHistory.thread(tid),
    tags: async () => fakeHistory.tags(),
    recommend: async () => fakeHistory.recommend(),
    stats: async () => ({ rows: answers.answers.map((a, i) => ({ id: a.id, name: a.name, asked: 24 - i, sent: 24 - i, done: 22 - i, timeout: i % 2, noAnswer: 0, sendFail: 0, limit: i === 3 ? 1 : 0, firstMedianMs: 2100 + i * 900, doneMedianMs: 9000 + i * 2500, charsAvg: 1400 - i * 120 })) }),
    remove: async () => true,
    clear: async () => true,
    feedback: async (_id, value) => value,
  },
  copyText: async () => true,
  saveFile: async () => ({ ok: true }),
  local: { setPrefs: async () => ({ ok: true }), models: async () => ({ ok: true, models: ['qwen2.5:7b', 'llama3.1:8b'] }), ask: async () => ({ ok: true, text: '- 버그 먼저' }) },
  shortcuts: async () => shortcutList({}),
  runSynth: async () => ({ ok: true }),
  setSynth() {}, setSettings() {}, refreshRemote: async () => ({}),
  setLayout: (v) => ((layout = v), push()),
  setFocus() {},
  setSidebar: (on) => ((sidebar = PROJ && !!on), push()),
  setPanelBar: (id, rows) => (rows ? barRows.set(id, rows) : barRows.delete(id), push()),
  update: { check: async () => {}, download: async () => {}, install: async () => false, openReleases() {} },
  project: PROJ ? fakeProject() : Object.fromEntries(['pick', 'restore', 'reconnect', 'close', 'readDir', 'readFile', 'writeFile', 'deleteFile', 'globalExclude', 'loadState', 'saveState'].map((n) => [n, async () => null])),
  ...(PROJ ? { devtest: fakeDevtest(), git: fakeGit() } : {}),
  library: {
    load: async () =>
      normalizeLibrary({
        templates: [{ id: 'u-t1', name: '코드 리뷰 (보안 관점)', text: '{{언어}} 코드를 {{관점|보안}} 관점에서 리뷰해 줘.\n\n{q}', fav: true }],
        skills: [
          {
            id: 's-1',
            name: '코드 리뷰어',
            description: '버그 · 보안 · 가독성 순서로 본다',
            body: '# 코드 리뷰어\n\n- 버그를 먼저 찾는다\n- 보안 문제는 근거와 함께\n- 고칠 코드는 전체 파일로',
            // v0.29.0 이전 버전 예시
            versions: [
              { at: now - 2 * 3600e3, name: '코드 리뷰어', body: '# 코드 리뷰어\n\n- 버그를 먼저 찾는다\n- 보안 문제는 짧게\n- 고칠 코드는 바뀐 부분만' },
              { at: now - 26 * 3600e3, name: '코드 리뷰어', body: '# 코드 리뷰어\n\n- 버그를 찾는다' },
            ],
          },
          { id: 's-2', name: '한국어로 짧게', description: '', body: '- 한국어로 답한다\n- 다섯 줄 이내' },
        ],
        // v0.29.0 작업 프리셋 예시
        presets: [
          { id: 'p-review', name: '코드 리뷰 (3사 비교)', at: now - 3600e3, template: { id: 'u-t1', vars: { 언어: 'TypeScript', 관점: '보안' } }, skills: ['s-1', 's-2'], selected: ['gemini', 'chatgpt', 'claude'], targets: ['gemini', 'chatgpt', 'claude'], layout: 'row', synth: { target: 'claude', auto: true }, debate: { participants: ['gemini', 'chatgpt'], rounds: 2, judge: 'claude' } },
          { id: 'p-news', name: '뉴스 요약', at: now - 86400e3, template: { id: 'summary', vars: {} }, skills: [], selected: ['gemini', 'perplexity'], targets: [], layout: 'grid', synth: { target: 'gemini', auto: false }, debate: null },
        ],
      }),
    save: async () => true,
  },
  panelAction() {},
  on: (ch, fn) => listeners[ch]?.push(fn),
};

// ---------- v0.28.0 프로젝트 장면용 가짜 폴더 · 테스트 실행 · git ----------
function fakeProject() {
  const files = { ...S.PROJECT_FILES };
  const info = { name: 'demo-app', id: 'C:\\work\\demo-app' };
  const readDir = async (dir) => {
    const pre = dir ? `${dir}/` : '';
    const out = new Map();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(pre)) continue;
      const [name, ...rest] = p.slice(pre.length).split('/');
      out.set(name, rest.length ? { name, kind: 'dir', size: 0 } : { name, kind: 'file', size: files[p].length });
    }
    return [...out.values()];
  };
  // 이어 하기 장면: 지난 실행(다른 run)의 기록 — ChatGPT는 파일별로 받기 3/5에서 멈춤, Gemini는 받은 파일만
  const plan = ['src/user.js', 'src/cache.js', 'src/api.js', 'test/user.test.js', 'README.md'].map((path) => ({ path, note: '' }));
  const ctx = {
    v: 1,
    panels: {
      chatgpt: { run: 'old-run', epoch: '0', at: Date.now() - 3600e3, conv: null, sent: [['src/user.js', 'h1', 4], ['package.json', 'h2', 10], ['README.md', 'h3', 3]], tree: 't', plan: { files: plan, index: 2, status: 'running', got: ['src/user.js', 'src/cache.js'] }, cont: null },
      gemini: { run: 'old-run', epoch: '0', at: Date.now() - 3600e3, conv: null, sent: [['src/user.js', 'h1', 4], ['src/cache.js', 'h4', 3]], tree: 't', plan: null, cont: { path: 'src/user.js', rounds: 1 } },
    },
  };
  return {
    pick: async () => info,
    restore: async () => info,
    reconnect: async () => info,
    close: async () => true,
    readDir,
    readFile: async (p) => (p in files ? { text: files[p], size: files[p].length } : { missing: true }),
    writeFile: async (p, text) => ((files[p] = text), true),
    deleteFile: async (p) => (delete files[p], true),
    globalExclude: async () => null,
    loadState: async () => ({ checked: ['package.json', 'src/user.js'], include: true, ...(scene === '40-project-restore' ? { ctx } : {}) }),
    saveState: async () => true,
  };
}

function fakeDevtest() {
  const run = (ok, out, ms, summary) => ({ ok, code: ok ? 0 : 1, timedOut: false, stopped: false, ms, output: out, summary });
  return {
    info: async () => ({ ok: true, script: 'node --test', pre: null, post: null, checks: [{ name: 'test', script: 'node --test' }, { name: 'lint', script: 'eslint src' }, { name: 'typecheck', script: 'tsc --noEmit' }, { name: 'build', script: 'node build.js' }] }),
    trial: async (_c, scripts) => {
      await new Promise((r) => setTimeout(r, 150));
      const results = scripts.map((name) =>
        name === 'test'
          ? { name, script: 'node --test', before: run(false, '✖ 없는 사용자면 오류\nℹ tests 1\nℹ pass 0\nℹ fail 1', 2300, { pass: 0, fail: 1 }), after: run(true, '✔ 없는 사용자면 오류\nℹ tests 1\nℹ pass 1\nℹ fail 0', 2100, { pass: 1, fail: 0 }) }
          : { name, script: 'eslint src', before: run(true, '(문제 없음)', 900), after: run(false, "src/user.js\n  8:9  error  'set' is not defined  no-undef\n\n✖ 1 problem (1 error, 0 warnings)", 950) },
      );
      return { ok: true, scripts, results, script: 'node --test', before: results[0].before, after: results[0].after };
    },
    stop: async () => true,
  };
}

function fakeGit() {
  return {
    info: async () => ({ root: 'C:\\work\\demo-app', isRepo: true, branch: 'main', hooks: ['pre-commit'] }),
    run: async () => ({ ok: true }),
    stop: async () => true,
    openTerminal: async () => ({ ok: true }),
    commitInfo: async () => ({ ok: true, branch: 'main', otherStaged: ['README.md'] }),
    commit: async () => ({ ok: true, hash: '3f9c2a1', output: '[main 3f9c2a1] Fix getUser error handling\n 3 files changed, 14 insertions(+), 2 deletions(-)' }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const click = (s) => $(s)?.click();

window.addEventListener('DOMContentLoaded', async () => {
  await sleep(80);
  push();
  for (const id of selected) emit('panel:status', { id, login: 'ready', url: svc(id).url });
  if (scene === '02-ask-all') {
    // 실제처럼 공통 입력창으로 보낸 뒤 답이 끝나게 한다 (그래야 패널 머리줄에 [+1]/[-1] 평가 버튼이 뜬다)
    $('#prompt').value = S.QUESTION;
    click('#sendBtn');
    await sleep(150);
    for (const id of ['gemini', 'chatgpt', 'deepseek']) emit('panel:status', { id, answer: 'done', chars: S.ANSWERS[id].length });
    emit('panel:status', { id: 'perplexity', answer: 'answering' });
    await sleep(50);
    $('.fb-btn[data-fb="good"]:not([hidden])')?.click(); // 첫 패널에 [+1]을 누른 모습
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
  // v0.27.0 기록 찾기: 거르기를 펼쳐 7일 · ChatGPT를 고르고 두 기록을 내보내기로 고른 모습
  if (scene === '32-history-filters') {
    click('#historyBtn');
    await sleep(300);
    click('#historyFilterBtn');
    await sleep(150);
    $('#hfPeriod').value = '7d';
    $('#hfPeriod').dispatchEvent(new Event('change'));
    await sleep(150);
    [...document.querySelectorAll('#hfServices .chip')].find((c) => c.textContent === 'ChatGPT')?.click();
    await sleep(200);
    for (const box of [...document.querySelectorAll('.history-pick')].slice(0, 2)) box.click();
  }
  if (scene === '33-history-thread') {
    click('#historyBtn');
    await sleep(300);
    click('#historyGroup button[data-group="threads"]');
    await sleep(400);
  }
  if (scene === '35-recommend-chip') {
    $('#prompt').value = '이 함수가 왜 undefined를 돌려주는지 봐 줘\n\nfunction total(items) {\n  items.reduce((n, x) => n + x.price, 0);\n}';
    $('#prompt').dispatchEvent(new Event('input'));
    await sleep(500);
  }
  if (scene === '27-handoff') {
    // 넘기기 바(Gemini) · 시간 초과 [다시 보내기](DeepSeek) · 사용 한도 → 다른 AI로(Perplexity)
    for (const id of ['gemini', 'chatgpt']) emit('panel:status', { id, answer: 'done', chars: S.ANSWERS[id].length });
    emit('panel:status', { id: 'deepseek', answer: 'timeout' });
    emit('panel:status', { id: 'perplexity', diag: { ...DIAG.perplexity, limit: 'You have reached your daily limit' } });
    await sleep(100);
    document.querySelector('.panel .handoff-btn')?.click();
    await sleep(50);
    const sel = document.querySelector('.offer-intent');
    if (sel) sel.value = 'counter';
  }
  if (scene === '28-debate') {
    click('#debateBtn');
    await sleep(400);
  }
  if (['29-debate-result', '30-analysis-compare', '31-analysis-jump'].includes(scene)) {
    click('#compareBtn');
    await sleep(500);
    if (scene === '29-debate-result') click('#compareTabs button[data-ctab="chain"]');
    if (scene === '30-analysis-compare') click('#compareTabs button[data-ctab="analysis"]');
    if (scene === '29-debate-result') {
      await sleep(100);
      emit('synth:status', { mode: 'debate', state: 'done', judge: 'Gemini', rounds: 2 });
    }
    if (scene === '31-analysis-jump') {
      // 이견 표에서 DeepSeek의 성능 칸을 누른 모습 → 답변 탭에서 관련 문단 강조
      if ($('#diffToggle').classList.contains('active')) click('#diffToggle'); // 지난 장면의 차이 강조가 남아 있으면 끈다
      click('#compareTabs button[data-ctab="analysis"]');
      await sleep(200);
      [...document.querySelectorAll('.an-table td.an-jump')].find((td) => td.textContent.includes('V8'))?.click();
      await sleep(600);
    }
  }
  if (scene === '25-diag') {
    // 머리줄의 ⚠ 화면이 바뀐 것 같음 → 자가진단 창
    const badge = [...document.querySelectorAll('.panel-head .diag-badge')].find((b) => !b.hidden && b.textContent.includes('화면이'));
    badge?.click();
  }
  // ---------- v0.28.0 프로젝트 장면 ----------
  const btnIn = (root, text) => [...(root || document).querySelectorAll('button')].find((b) => b.textContent.includes(text) && !b.closest('[hidden]'));
  if (PROJ && scene !== '40-project-restore') {
    await sleep(300);
    for (const id of ['gemini', 'chatgpt']) emit('panel:status', { id, answer: 'done', chars: 900 });
    await sleep(600);
  }
  if (scene === '36-check-scripts') {
    btnIn(document.querySelector('.change-bar:not([hidden])'), '변경 보기')?.click();
    await sleep(500);
    document.querySelector('#patchChecks input[data-check="lint"]')?.click();
    click('#patchTest');
    await sleep(600);
  }
  if (scene === '37-mix-apply' || scene === '38-commit') {
    click('#changesBtn');
    await sleep(700);
    click('#changesMix');
    await sleep(300);
    // src/user.js는 Gemini 것으로 (cache.js는 Gemini, 테스트는 ChatGPT — 섞어서)
    document.querySelectorAll('.mix-table tr')[[...document.querySelectorAll('.mix-table tr')].findIndex((tr) => tr.textContent.includes('src/user.js'))]?.querySelector('input[type="radio"]')?.click();
    await sleep(200);
    if (scene === '38-commit') {
      click('#patchApply');
      await sleep(800);
      click('#patchApply'); // [커밋하기…]
      await sleep(500);
    }
  }
  if (scene === '39-bars-stacked') {
    // Gemini: 변경 바 + 보내기 실패 [다시 보내기] 제안 바가 함께 — 두 줄로 쌓인다
    emit('panel:status', { id: 'gemini', send: 'error', error: '입력창을 찾지 못했습니다' });
    await sleep(200);
    document.querySelectorAll('.panel .handoff-btn')[1]?.click(); // ChatGPT: 변경 바 + 넘기기 바
    await sleep(300);
  }
  if (scene === '40-project-restore') {
    await sleep(500);
    btnIn($('#psRestore'), '이어 쓰기')?.click();
    await sleep(500);
  }
  if (scene === '06-settings-shortcuts') click('#helpBtn');
  // 설정 화면의 표들: 그 칸이 맨 위에 오게 스크롤
  const helpAt = { '15-screen-status': '#diagTable', '17-stats': '#statsTable', '20-local-llm-settings': '#localEnabled', '34-recommend-stats': '#recommendTable' }[scene];
  if (helpAt) {
    click('#helpBtn');
    await sleep(500);
    const el = $(helpAt);
    const box = $('.help-box');
    if (scene === '34-recommend-stats') {
      await sleep(300);
      for (const d of [...document.querySelectorAll('.rec-kind')].slice(0, 2)) d.open = true;
    }
    box.scrollTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60;
  }
  if (scene === '12-library') {
    click('#libraryBtn');
    await sleep(400);
    click('[data-libtab="skills"]');
    await sleep(300);
    [...document.querySelectorAll('.lib-row')].find((r) => r.textContent.includes('코드 리뷰어'))?.click();
  }
  // ---------- v0.29.0 장면 ----------
  if (scene === '42-presets') {
    click('#libraryBtn');
    await sleep(400);
    click('[data-libtab="presets"]');
    await sleep(300);
    [...document.querySelectorAll('.lib-row')].find((r) => r.textContent.includes('코드 리뷰'))?.click();
  }
  if (scene === '43-skill-versions') {
    click('#libraryBtn');
    await sleep(400);
    click('[data-libtab="skills"]');
    await sleep(300);
    [...document.querySelectorAll('.lib-row')].find((r) => r.textContent.includes('코드 리뷰어'))?.click();
    await sleep(200);
    $('#libVersions').open = true;
    document.querySelector('.lib-version')?.click();
  }
  if (scene === '44-local-judge') {
    // 로컬 LLM 패널 없이 종합: 줄여 보낸 뒤 끝남 → [결과 보기]
    $('#prompt').value = S.QUESTION;
    click('#sendBtn');
    await sleep(150);
    for (const id of selected) emit('panel:status', { id, answer: 'done', chars: (S.ANSWERS[id] || '').length });
    await sleep(100);
    emit('synth:status', { state: 'done', judge: '로컬 LLM', count: 4, cause: 'manual', mode: 'text', trimmed: ['Gemini', 'ChatGPT'], headless: true, historyId: 'r1' });
  }
  if (scene === '45-settings-transfer') {
    click('#helpBtn');
    await sleep(400);
    const file = { kind: 'multitude-llm-settings', version: 1, exportedAt: '2026-11-15T09:12:00.000Z', app: 'extension', appVersion: '0.29.0',
      settings: { selected: ['gemini', 'claude', 'perplexity'], layout: 'row', synthTarget: 'claude', autoSynth: true, answerTimeoutMin: 20, historyMax: 1000, sendPreview: true },
      library: { templates: [{ id: 'u-t1', name: '코드 리뷰 (보안 관점)', text: '{q}' }, { id: 'u-new', name: '회의록 정리', text: '{q}' }], skills: [{ id: 's-1', name: '코드 리뷰어', body: '- 버그' }], presets: [{ id: 'p-x', name: '논문 읽기' }] } };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(file)], 'multitude-llm-settings-2026-11-15.mla.json', { type: 'application/json' }));
    $('#transferFile').files = dt.files;
    $('#transferFile').dispatchEvent(new Event('change'));
    await sleep(400);
  }
  if (scene === '26-send-preview') {
    // 보내기 버튼을 Shift+클릭 → 보내기 전 미리보기 창 (첨부 2개, Duck.ai는 문서를 빼고 보냄)
    const dt = new DataTransfer();
    dt.items.add(new File(['# 회의록\n- 결정 사항'], '회의록.md', { type: 'text/markdown' }));
    dt.items.add(new File([new Uint8Array(420000)], '분기 보고서.pdf', { type: 'application/pdf' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    $('#prompt').value = '첨부한 보고서와 회의록을 바탕으로 다음 분기 할 일을 세 가지로 정리해 줘';
    $('#sendBtn').dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    await sleep(400);
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
