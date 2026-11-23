'use strict';
// 로드맵 "실행해서 보기" · 한 번 실행 (v0.46.0) 테스트:  npm test
// [쉽게 말하면]
//   - 카드 계산: 앱을 띄울 수 있으면 검증 단계에 [▶ 실행해서 보기] · 미리보기가 열리면 [✓ 화면 확인함], 설정을 켜면 확인 전에는 완료 없음
//   - 카드 화면: 실행해서 보기 → (앱 실행) → 미리보기 → 화면 확인함 → 완료, 오류가 보이면 한 번 더 묻기
//   - 한 번 실행 규칙: 인자 읽기(셸 글자도 그냥 글자) · 대상 고르기(.. 경로 거절) · 실행 모양 · 허용 검사
//   - 진짜로: node cli.js · npm run start -- 인자 · python main.py(있으면)를 인자와 함께 한 번 실행해 출력 · 종료 코드
//   - 화면(dev-once.js): 서버 스크립트가 없으면 [▶ 한 번 실행…]이 주인공, 창에서 실행 → 출력 · 종료 코드
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const RM = require('../src/shared/roadmap');
const CH = require('../src/shared/roadmap-charts');
const DOCS = require('../src/shared/roadmap-docs');
const PH = require('../src/shared/preview-health');
const D = require('../src/main/devrun');
const R = require('../src/main/test-rules');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const arr = (a) => [...a];

const ROADMAP = () => RM.normalizeRoadmap({ title: 'demo', milestones: [{ id: 'm1', title: 'UI', tasks: [{ id: 't1', title: '목록 화면', accept: '세 명이 보인다', files: ['src/App.jsx'] }, { id: 't2', title: '다음', deps: ['t1'] }] }] });

test('카드 계산: 앱을 띄울 수 있으면 [▶ 실행해서 보기], 미리보기가 열리면 [✓ 화면 확인함], 설정 runCheck면 확인 전에는 완료 없음', () => {
  let rm = RM.setStatus(ROADMAP(), 't1', 'verify').roadmap;
  assert.deepEqual(RM.cardState(rm).actions, ['done', 'block']); // 앱 실행이 없으면 예전 그대로
  assert.deepEqual(RM.cardState(rm, { canRun: true }).actions, ['done', 'run', 'block']);
  assert.deepEqual(RM.cardState(rm, { canRun: true, pvOpen: true }).actions, ['done', 'seen', 'run', 'block']);
  assert.deepEqual(RM.cardState(rm, { canRun: true, pvOpen: true, seen: true }).actions, ['done', 'block']);
  assert.equal(RM.DEFAULT_SETTINGS.runCheck, false);
  rm = RM.normalizeRoadmap({ ...rm, settings: { ...rm.settings, runCheck: true } });
  assert.equal(rm.settings.runCheck, true);
  let cs = RM.cardState(rm, { canRun: true });
  assert.equal(cs.phase, 'verifyRun');
  assert.deepEqual(cs.actions, ['run', 'block']);
  assert.deepEqual(RM.cardState(rm, { canRun: true, pvOpen: true }).actions, ['seen', 'run', 'block']);
  assert.deepEqual(RM.cardState(rm, { canRun: true, pvOpen: true, seen: true }).actions, ['done', 'block']);
  assert.deepEqual(RM.cardState(rm, { canRun: false }).actions, ['done', 'block']); // 띄울 수 없는 프로젝트는 막지 않는다
  const pass = { task: 't1', verdict: 'pass', pass: 3, fail: 0 };
  assert.deepEqual(RM.cardState(rm, { canRun: true, trial: pass, pvOpen: true }).actions, ['seen', 'run']);
  cs = RM.cardState(rm, { canRun: true, trial: pass, seen: true });
  assert.equal(cs.phase, 'verifyPass');
  assert.deepEqual(cs.actions, ['done', 'notYet']);
  assert.deepEqual(RM.cardState(RM.setStatus(rm, 't1', 'doing').roadmap, { canRun: true }).actions, ['done', 'block']); // 진행 중에는 없음
});

// ---------- 카드 화면 ----------
function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: '', children: [], dataset: {}, title: '', _text: '', hidden: false, disabled: false, value: '', listeners: {}, attrs: {}, innerHTML: '' });
      const cls = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = { add: (c) => (this.className = [...cls().add(c)].join(' ')), toggle: (c, on) => { const s = cls(); if (on ?? !s.has(c)) s.add(c); else s.delete(c); this.className = [...s].join(' '); }, contains: (c) => cls().has(c) };
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...kids) { this.children.push(...kids); }
    replaceChildren(...kids) { this.children = kids; this._text = ''; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(k, v) { this.attrs[k] = v; }
    querySelectorAll() { return []; }
    focus() {}
  }
  const byId = new Map();
  const $ = (sel) => {
    if (!byId.has(sel)) byId.set(sel, new El('div'));
    return byId.get(sel);
  };
  return { El, $, document: { createElement: (t) => new El(t), createTextNode: (s) => s, getElementById: () => null, head: new El('head'), querySelector: () => null } };
}

function cardSetup({ runCheck = false } = {}) {
  i18n.setLang('ko');
  const dom = fakeDom();
  const rm = ROADMAP();
  rm.settings.runCheck = runCheck;
  const FS = new Map([['package.json', '{}'], ['.mla/roadmap.json', JSON.stringify(rm)]]);
  const logs = { toggles: 0, previews: [], confirms: [] };
  let answer = true;
  const run = { scripts: [{ name: 'dev', script: 'vite' }] };
  let rs = { running: false };
  let pv = { open: false };
  const devRun = { run, state: () => rs, preview: () => pv, toggle: async () => (logs.toggles++, (rs = { running: true, name: 'dev', url: null })), openPreview: async (u) => logs.previews.push(u) };
  const host = {
    setView() {},
    devrun: {},
    project: { readFile: async (p) => (FS.has(p) ? { text: FS.get(p) } : { missing: true }), writeFile: async (p, t) => (FS.set(p, t), true), deleteFile: async () => true, readDir: async () => [] },
    sendPrompt: async (t, ids) => ids.map((id) => ({ id, ok: true })),
    getAnswers: async () => ({ answers: [] }),
  };
  const P = { has: () => true, project: { info: { id: 'p1', name: 'demo' }, checked: new Set() }, entryOf: () => undefined, toggleFile() {}, rescan() {} };
  const ctx = {
    MLA: { roadmap: RM, roadmapCharts: CH, roadmapDocs: DOCS, i18n, projectUI: P, devRun, previewHealth: PH },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state: { chatView: 'panels', rects: [], services: [] },
    host,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    window: {},
    alert: () => {},
    confirm: (m) => (logs.confirms.push(m), answer),
    prompt: () => '',
    CSS: { escape: (s) => s },
    localStorage: { getItem: () => null, setItem() {} },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/roadmap-ui.js'), ctx);
  vm.runInContext(read('src/renderer/roadmap-card.js'), ctx);
  const acts = () => dom.$('#rmcActs').children.map((b) => b.dataset.act);
  const click = async (name) => {
    const b = dom.$('#rmcActs').children.find((x) => x.dataset.act === name);
    assert.ok(b, `버튼 ${name}이 없다 (보이는 것: ${acts().join(', ')})`);
    await b.listeners.click();
    await tick();
  };
  return { ...dom, logs, ctx, acts, click, setRun: (s) => (rs = s), setPv: (s) => (pv = s), answer: (v) => (answer = v), ui: () => ctx.MLA.roadmapUI.get() };
}

test('카드 화면 (runCheck 켬): 적용 → [▶ 실행해서 보기] → 앱 실행 → 미리보기 → [✓ 화면 확인함] → 완료', async () => {
  const h = cardSetup({ runCheck: true });
  h.ctx.window.onRoadmapProject();
  await tick(30);
  await h.click('implement');
  await h.ctx.window.onRoadmapApplied();
  await tick();
  assert.deepEqual(h.acts(), ['run', 'block']);
  assert.match(h.$('#rmcNote').textContent, /완료 전에 \[▶ 실행해서 보기\]/);
  const runBtn = h.$('#rmcActs').children.find((b) => b.dataset.act === 'run');
  assert.equal(runBtn.textContent, '▶ 실행해서 보기');
  assert.ok(runBtn.className.includes('primary'));
  await h.click('run');
  assert.equal(h.logs.toggles, 1); // 서버가 없으니 ▶ 앱 실행
  // 주소를 찾고 미리보기가 열림 → 화면 확인함이 먼저
  h.setRun({ running: true, name: 'dev', url: 'http://localhost:5173/' });
  h.setPv({ open: true, loading: false, errors: [{ count: 1 }], failed: [] });
  h.ctx.window.onPreviewState();
  assert.deepEqual(h.acts(), ['seen', 'run', 'block']);
  assert.equal(h.$('#rmcActs').children[1].textContent, '▶ 미리보기로 보기');
  // 오류가 보이면 한 번 더 묻는다 — 아니오면 그대로
  h.answer(false);
  await h.click('seen');
  assert.equal(h.logs.confirms.length, 1);
  assert.deepEqual(h.acts(), ['seen', 'run', 'block']);
  h.setPv({ open: true, loading: false, errors: [], failed: [] });
  await h.click('seen');
  assert.equal(h.logs.confirms.length, 1); // 오류가 없으면 묻지 않는다
  assert.deepEqual(h.acts(), ['done', 'block']);
  assert.match(h.$('#rmcNote').textContent, /화면을 확인했습니다/);
  // 실행 중이면 [▶ 실행해서 보기]는 미리보기를 연다 (다른 작업에서)
  await h.click('done');
  assert.equal(h.ui().milestones[0].tasks[0].status, 'done');
});

test('카드 화면 (runCheck 끔): 검증 중에 [▶ 실행해서 보기]가 보조로 있고, 서버가 떠 있으면 미리보기를 연다', async () => {
  const h = cardSetup();
  h.ctx.window.onRoadmapProject();
  await tick(30);
  await h.click('implement');
  await h.ctx.window.onRoadmapApplied();
  await tick();
  assert.deepEqual(h.acts(), ['done', 'run', 'block']);
  h.setRun({ running: true, name: 'dev', url: 'http://localhost:5173/' });
  await h.click('run');
  assert.deepEqual(h.logs.previews, ['http://localhost:5173/']);
  assert.equal(h.logs.toggles, 0);
});

// ---------- 한 번 실행 ----------
test('한 번 실행 규칙: 인자 읽기 · 대상 고르기 · 실행 모양 · 허용 검사', () => {
  assert.deepEqual(D.parseArgs('greet --name "Kim Ha" ; rm -rf / \'x y\' ""'), ['greet', '--name', 'Kim Ha', ';', 'rm', '-rf', '/', 'x y', '']);
  assert.deepEqual(D.parseArgs(''), []);
  assert.equal(D.parseArgs('"open'), null);
  assert.equal(D.parseArgs(Array(25).fill('a').join(' ')), null);
  assert.equal(D.parseArgs('a\0b'), null);
  const tg = D.onceTargets(['main.py', 'cli.js', 'package.json', 'notes.txt'], JSON.stringify({ bin: { tool: './bin/tool.js' }, main: '../evil.js', scripts: { start: 'node .', build: 'x' } }));
  assert.deepEqual(tg.map((x) => x.id), ['npm:start', 'node:bin/tool.js', 'node:cli.js', 'py:main.py']);
  assert.equal(D.safeRel('a/../b'), false);
  assert.equal(D.safeRel('C:\\x.js'), false);
  assert.equal(D.safeRel('.git/hooks/x.js'), false);
  const root = path.resolve('/p');
  const npmCli = path.resolve('/n/node_modules/npm/bin/npm-cli.js');
  const node = path.resolve('/n/node.exe');
  const py = { path: path.resolve('/py/python.exe'), launcher: false };
  const sp = (target, args) => D.buildOnceSpawn({ root, target, args, npmCli, nodeExe: node, execPath: '/app', isElectron: true, python: py, env: { PATH: '' } });
  const n1 = sp(tg[0], ['--port', '1']);
  assert.deepEqual(n1.args, [npmCli, 'run', 'start', '--', '--port', '1']);
  assert.equal(D.isAllowedOnceSpawn(n1, { root, target: tg[0], nodeExe: node, execPath: '/app', python: py }), true);
  const n2 = sp(tg[2], ['a;b']);
  assert.deepEqual(n2.args, ['cli.js', 'a;b']);
  assert.equal(n2.options.shell, false);
  assert.equal(D.isAllowedOnceSpawn(n2, { root, target: tg[2], nodeExe: node, execPath: '/app', python: py }), true);
  assert.equal(D.isAllowedOnceSpawn({ ...n2, args: ['-e', 'evil()'] }, { root, target: tg[2], nodeExe: node, execPath: '/app', python: py }), false);
  const p1 = sp(tg[3], []);
  assert.deepEqual(p1.args, ['main.py']);
  assert.equal(D.isAllowedOnceSpawn(p1, { root, target: tg[3], nodeExe: node, execPath: '/app', python: py }), true);
  assert.equal(D.isAllowedOnceSpawn(p1, { root: path.resolve('/q'), target: tg[3], nodeExe: node, execPath: '/app', python: py }), false);
  assert.equal(D.isAllowedOnceSpawn(sp({ kind: 'node', file: '../x.js' }, []), { root, target: { kind: 'node', file: '../x.js' }, nodeExe: node, execPath: '/app', python: py }), false);
});

function requireWithFakeElectron(rel, electron) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    return orig.call(this, req, ...rest);
  };
  try {
    for (const k of Object.keys(require.cache)) if (/src[\\/]main[\\/]/.test(k)) delete require.cache[k];
    return require(require.resolve(rel));
  } finally {
    Module._load = orig;
  }
}

test('진짜로: node cli.js · npm run start -- 인자 · python main.py를 인자와 함께 한 번 (출력 · 종료 코드 · 셸 글자는 그냥 글자)', { timeout: 120000 }, async (t) => {
  if (!R.findNpmCli({ exists: (p) => fs.existsSync(p) })) return t.skip('npm을 찾지 못함');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-once-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'cli');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cli', version: '1.0.0', scripts: { start: 'node cli.js' } }));
  fs.writeFileSync(path.join(root, 'cli.js'), "console.log('args=' + JSON.stringify(process.argv.slice(2)));\nprocess.exit(process.argv.includes('fail') ? 3 : 0);\n");
  fs.writeFileSync(path.join(root, 'main.py'), "import sys\nprint('py args=' + '|'.join(sys.argv[1:]))\n");
  const electron = { dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevRun } = requireWithFakeElectron('../src/main/devrun', electron);
  const handlers = {};
  const asked = [];
  setupDevRun({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getWin: () => null, project, shell: {}, confirm: async (o) => (asked.push(o), true) });
  await project.open(root);
  const info = await handlers['devrun:onceInfo']();
  assert.deepEqual(info.targets.map((x) => x.id), ['npm:start', 'node:cli.js', 'py:main.py']);
  const r1 = await handlers['devrun:once'](null, 'node:cli.js', 'greet --name "Kim Ha" ; echo hacked');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.match(r1.output, /args=\["greet","--name","Kim Ha",";","echo","hacked"\]/);
  assert.match(asked.at(-1).detail, /cli\.js greet --name "Kim Ha" ; echo hacked/);
  const r2 = await handlers['devrun:once'](null, 'node:cli.js', 'fail');
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 3);
  const r3 = await handlers['devrun:once'](null, 'npm:start', '--x 1');
  assert.equal(r3.ok, true);
  assert.match(r3.output, /args=\["--x","1"\]/);
  assert.equal((await handlers['devrun:once'](null, 'node:../evil.js', '')).ok, false);
  assert.equal((await handlers['devrun:once'](null, 'node:cli.js', '"open')).ok, false);
  const pyFound = require('../src/main/envcheck').findTool('python', { root });
  if (pyFound.state === 'ok' && pyFound.kind === 'exe') {
    const r4 = await handlers['devrun:once'](null, 'py:main.py', 'a "b c"');
    assert.equal(r4.ok, true, r4.output || r4.error);
    assert.match(r4.output, /py args=a\|b c/);
  }
});

test('화면 (dev-once.js): 서버 스크립트가 없으면 [▶ 한 번 실행…]이 주인공, 창에서 인자와 함께 실행 → 출력 · 종료 코드, 기억', async () => {
  i18n.setLang('ko');
  const dom = fakeDom();
  const calls = [];
  const store = new Map();
  const host = {
    setView() {},
    copyText: async () => {},
    devrun: {
      onceInfo: async () => ({ ok: true, targets: [{ id: 'py:main.py', kind: 'py', file: 'main.py', label: 'python main.py' }] }),
      once: async (id, args) => (calls.push([id, args]), { ok: false, code: 2, ms: 1200, output: 'usage: main.py greet', command: 'python main.py --help' }),
      onceStop: async () => true,
    },
  };
  const ctx = {
    MLA: { i18n, projectUI: { has: () => true, project: { info: { id: 'p' } } }, devRun: { run: { scripts: [] } } },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state: { chatView: 'panels' },
    host,
    window: {},
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/dev-once.js'), ctx);
  ctx.window.onDevRunChanged({ running: false });
  await tick();
  const b = dom.$('#dhOnce');
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, '▶ 한 번 실행… (인자와 함께)');
  assert.ok(b.className.includes('primary'));
  await b.listeners.click();
  await tick();
  assert.equal(dom.$('#onceModal').hidden, false);
  dom.$('#onceArgs').value = '--help';
  await dom.$('#onceRun').listeners.click();
  assert.deepEqual(arr(calls[0]), ['py:main.py', '--help']);
  assert.equal(dom.$('#onceOut').textContent, 'usage: main.py greet');
  assert.match(dom.$('#onceStatus').textContent, /종료 코드 2 · 1\.2초/);
  assert.ok(dom.$('#onceStatus').className.includes('lvl-error'));
  assert.deepEqual(JSON.parse(store.get('mla-once-p')), { id: 'py:main.py', args: '--help' });
  // 서버 스크립트가 있으면 작은 단추
  ctx.MLA.devRun.run.scripts = [{ name: 'dev' }];
  ctx.window.onDevRunChanged({ running: false });
  assert.equal(b.textContent, '1회 실행…');
});

test('연결: 카드 설정 칸 · 신호 · 한 번 실행 창 · preload · 확장 빌드', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="roadmapRunCheck"/);
  assert.match(html, /id="onceModal" class="modal" hidden/);
  assert.ok(html.indexOf('src="dev-capture.js"') < html.indexOf('src="dev-once.js"'));
  const card = read('src/renderer/roadmap-card.js');
  assert.match(card, /window\.onDevRunChanged = \(\) => render\(\);/);
  assert.match(card, /window\.onPreviewState = \(\) => render\(\);/);
  assert.match(read('src/renderer/roadmap-ui.js'), /setting\('runCheck', e\.target\.checked\)/);
  const pre = read('src/preload/preload.js');
  for (const ch of ['devrun:onceInfo', 'devrun:once', 'devrun:onceStop']) assert.match(pre, new RegExp(`'${ch}'`));
  assert.match(read('scripts/build-extension.js'), /'dev-once\.js'/);
});
