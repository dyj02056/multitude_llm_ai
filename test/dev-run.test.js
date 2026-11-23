'use strict';
// 앱 실행 (v0.43.0) 테스트:  npm test
// [쉽게 말하면]
//   - 규칙(main/devrun.js): 출력에서 이 PC 주소 찾기(Vite · Next · CRA · Django · 0.0.0.0) · 허용 스크립트(dev · start · serve · preview)만 · 셸 없이
//   - 진짜 npm으로: 작은 개발 서버를 ▶ 실행 → 주소를 찾아 알림 → 그 주소가 실제로 응답 → ■ 중지 → 끝남 · 로그 · 프로젝트를 닫으면 함께 끔
//   - 화면(dev-run.js)을 가짜 화면으로: 스크립트 고르기 · 실행 · 상태 줄(주소 단추) · 도구가 없으면 막기 · 로그 창 · 확장에서는 숨김
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const R = require('../src/main/test-rules');
const D = require('../src/main/devrun');
const i18n = require('../src/shared/i18n');
const E = require('../src/shared/env-rules');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test('주소 찾기: Vite · Next · CRA · Django · 0.0.0.0 → localhost, 개발자 도구 포트 · 바깥 주소는 무시', () => {
  assert.equal(D.findLocalUrl('\x1b[32m  ➜  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n'), 'http://localhost:5173/');
  assert.equal(D.findLocalUrl('   ▲ Next.js 15.0.3\n   - Local:        http://localhost:3000\n'), 'http://localhost:3000/');
  assert.equal(D.findLocalUrl('Starting development server at http://127.0.0.1:8000/\nQuit the server with CTRL-BREAK.'), 'http://127.0.0.1:8000/');
  assert.equal(D.findLocalUrl('listening on http://0.0.0.0:8080.'), 'http://localhost:8080/');
  assert.equal(D.findLocalUrl('Debugger listening on ws://127.0.0.1:9229/abc\nopen http://localhost:9229/json then http://localhost:4200/'), 'http://localhost:4200/');
  assert.equal(D.findLocalUrl('see https://example.com:3000/ or http://192.168.0.2:3000'), null);
  assert.equal(D.isLocalUrl('http://localhost:5173/'), true);
  assert.equal(D.isLocalUrl('http://[::1]:3000/'), true);
  assert.equal(D.isLocalUrl('https://evil.com/?http://localhost'), false);
  assert.equal(D.isLocalUrl('file:///C:/x'), false);
});

test('스크립트 · 실행 모양: dev · start · serve · preview만, package.json 글은 본체가 읽고, 셸 없이 npm-cli.js run <이름>', () => {
  const s = D.runScripts(JSON.stringify({ scripts: { dev: 'vite', predev: 'node gen.js', build: 'vite build', start: 'node server.js', evil: 'rm -rf /' } }));
  assert.deepEqual(s.scripts, [{ name: 'dev', script: 'vite', pre: 'node gen.js' }, { name: 'start', script: 'node server.js' }]);
  assert.equal(D.runScripts('{').ok, false);
  const npmCli = path.resolve('/nodejs/node_modules/npm/bin/npm-cli.js');
  const spec = D.buildRunSpawn({ root: '/p', npmCli, execPath: '/app.exe', isElectron: true, nodeExe: '/nodejs/node.exe', env: { NODE_OPTIONS: '--x', PATH: '/bin' }, script: 'dev' });
  assert.deepEqual(spec.args, [npmCli, 'run', 'dev']);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.env.BROWSER, 'none'); // 브라우저를 저절로 열지 않게
  assert.equal(spec.options.env.NODE_OPTIONS, undefined);
  assert.equal(D.isAllowedRunSpawn(spec, { root: '/p', execPath: '/app.exe', nodeExe: '/nodejs/node.exe', script: 'dev' }), true);
  assert.equal(D.isAllowedRunSpawn({ ...spec, args: [npmCli, 'run', 'build'] }, { root: '/p', execPath: '/app.exe', nodeExe: '/nodejs/node.exe', script: 'build' }), false);
  assert.equal(D.isAllowedRunSpawn({ ...spec, options: { ...spec.options, shell: true } }, { root: '/p', execPath: '/app.exe', nodeExe: '/nodejs/node.exe', script: 'dev' }), false);
  assert.equal(D.isAllowedRunSpawn(spec, { root: '/other', execPath: '/app.exe', nodeExe: '/nodejs/node.exe', script: 'dev' }), false);
  assert.throws(() => D.buildRunSpawn({ root: '/p', npmCli, execPath: '/a', script: 'test' }));
  assert.deepEqual(E.CHECK_TOOLS.dev, ['node', 'npm']);
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

test('진짜 npm으로: 실행 → 주소 찾음 → 응답 확인 → 중지 → 끝남, 두 번 실행은 거절, 취소, 프로젝트를 닫으면 함께 끔', { timeout: 120000 }, async (t) => {
  if (!R.findNpmCli({ exists: (p) => fs.existsSync(p) })) return t.skip('npm을 찾지 못함');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-devrun-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'web');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0', scripts: { dev: 'node server.js', test: 'node -e 0' } }));
  // 빈 포트로 열고 Vite처럼 색 코드와 함께 주소를 알린다
  fs.writeFileSync(path.join(root, 'server.js'), "const http = require('http');\nconst s = http.createServer((q, r) => r.end('<h1>hello from dev</h1>'));\ns.listen(0, '127.0.0.1', () => console.log('\\x1b[32m  ➜  Local:   http://localhost:' + s.address().port + '/\\x1b[0m'));\n");
  const electron = { dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevRun } = requireWithFakeElectron('../src/main/devrun', electron);
  const handlers = {};
  const states = [];
  let answer = true;
  const asked = [];
  const opened = [];
  const devRun = setupDevRun({
    ipcMain: { handle: (n, fn) => (handlers[n] = fn) },
    getWin: () => ({ isDestroyed: () => false, webContents: { send: (ch, d) => ch === 'devrun:state' && states.push(d) } }),
    project,
    shell: { openExternal: async (u) => opened.push(u) },
    confirm: async (opts) => (asked.push(opts), answer),
  });
  await project.open(root);
  const info = await handlers['devrun:info']();
  assert.deepEqual(info.scripts.map((s) => s.name), ['dev']);
  // 취소하면 실행하지 않는다
  answer = false;
  assert.equal((await handlers['devrun:start'](null, 'dev')).cancelled, true);
  answer = true;
  assert.equal((await handlers['devrun:start'](null, 'test')).ok, false); // 허용 목록 밖
  const r = await handlers['devrun:start'](null, 'dev');
  assert.equal(r.ok, true);
  assert.match(asked.at(-1).detail, /dev: node server\.js/);
  assert.equal((await handlers['devrun:start'](null, 'dev')).ok, false); // 이미 실행 중
  // 주소가 올 때까지
  let url = null;
  for (let i = 0; i < 200 && !url; i++) {
    await tick(50);
    url = states.find((s) => s.url)?.url || null;
  }
  assert.match(url, /^http:\/\/localhost:\d+\/$/);
  const body = await (await fetch(url)).text();
  assert.match(body, /hello from dev/);
  assert.equal(await handlers['devrun:open'](null, url), true);
  assert.equal(await handlers['devrun:open'](null, 'https://example.com/'), false);
  assert.deepEqual(opened, [url]);
  const log = await handlers['devrun:log']();
  assert.match(log.text, /Local:\s+http:\/\/localhost/);
  assert.doesNotMatch(log.text, /\x1b\[/); // 색 코드는 지운다
  // 중지 → 끝남
  assert.equal(await handlers['devrun:stop'](), true);
  for (let i = 0; i < 200 && !states.at(-1).exit; i++) await tick(50);
  assert.equal(states.at(-1).running, false);
  assert.equal(states.at(-1).exit.stopped, true);
  // 다시 실행 → 프로젝트를 닫으면 함께 꺼진다
  await handlers['devrun:start'](null, 'dev');
  for (let i = 0; i < 200 && !(states.at(-1).running && states.at(-1).url); i++) await tick(50);
  project.close();
  devRun.onProjectChange();
  for (let i = 0; i < 200 && states.at(-1).running; i++) await tick(50);
  assert.equal(states.at(-1).running, false);
});

// ---------- 화면 ----------
function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: '', children: [], dataset: {}, title: '', _text: '', hidden: false, disabled: false, value: '', listeners: {}, attrs: {}, scrollTop: 0, clientHeight: 0, scrollHeight: 0 });
      const cls = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = { add: (c) => (this.className = [...cls().add(c)].join(' ')), toggle: (c, on) => { const s = cls(); if (on ?? !s.has(c)) s.add(c); else s.delete(c); this.className = [...s].join(' '); }, contains: (c) => cls().has(c) };
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...kids) { this.children.push(...kids); }
    replaceChildren(...kids) { this.children = kids; this._text = ''; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(k, v) { this.attrs[k] = v; }
    focus() {}
  }
  const byId = new Map();
  const $ = (sel) => {
    if (!byId.has(sel)) byId.set(sel, new El('div'));
    return byId.get(sel);
  };
  return { El, $, document: { createElement: (t) => new El(t), createTextNode: (s) => s } };
}

function setup({ devrun = true, block = '' } = {}) {
  i18n.setLang('ko');
  const dom = fakeDom();
  const logs = { starts: [], stops: 0, opens: [], views: [], copies: [] };
  const on = {};
  const store = new Map();
  const state = { chatView: 'panels' };
  const host = {
    setView: (v) => logs.views.push(v),
    copyText: async (s) => logs.copies.push(s),
    on: (ch, fn) => (on[ch] = fn),
    ...(devrun
      ? {
          devrun: {
            info: async () => ({ ok: true, scripts: [{ name: 'dev', script: 'vite' }, { name: 'start', script: 'node server.js' }], state: { running: false } }),
            start: async (n) => (logs.starts.push(n), { ok: true, state: { running: true, name: n, script: 'vite', url: null, lines: 0 } }),
            stop: async () => (logs.stops++, true),
            log: async () => ({ ok: true, text: 'VITE ready\n➜ Local: http://localhost:5173/', state: { running: true, name: 'dev', script: 'vite' } }),
            open: async (u) => logs.opens.push(u),
          },
        }
      : {}),
  };
  const ctx = {
    MLA: { envRules: E, i18n, projectUI: { has: () => true, project: { info: { id: 'C:\\p', name: 'p' } } }, devHub: { blockReason: () => block } },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state,
    host,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    window: {},
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/dev-run.js'), ctx);
  return { ...dom, logs, on, ctx, store, state };
}

test('화면: 스크립트를 읽어 ▶ 앱 실행 (dev) → 주소를 기다림 → 주소 단추 → ■ 중지 → 끝남, 로그 창', async () => {
  const h = setup();
  h.ctx.window.onDevRunProject('C:\\p');
  await tick();
  const $ = h.$;
  assert.equal($('#dhRun').hidden, false);
  assert.equal($('#dhRunBtn').textContent, '▶ 앱 실행 (dev)');
  assert.equal($('#dhRunScript').children.length, 2);
  // 실행
  await $('#dhRunBtn').listeners.click();
  assert.deepEqual(h.logs.starts, ['dev']);
  assert.equal(h.store.get('mla-run-script'), 'dev');
  assert.match($('#dhRunState').textContent, /dev 실행 중 — 주소를 기다리는 중/);
  assert.equal($('#dhRunBtn').textContent, '■ 중지');
  // 본체가 주소를 알림 → 주소 단추 (누르면 브라우저로)
  h.on['devrun:state']({ running: true, name: 'dev', script: 'vite', url: 'http://localhost:5173/', lines: 4 });
  const urlBtn = $('#dhRunState').children.find((c) => c.tag === 'button');
  assert.equal(urlBtn.textContent, 'http://localhost:5173');
  await urlBtn.listeners.click();
  assert.deepEqual(h.logs.opens, ['http://localhost:5173/']);
  assert.equal($('#dhRun').classList.contains('running'), true);
  // 로그 창
  $('#dhRunLog').listeners.click();
  await tick();
  assert.equal($('#runLogModal').hidden, false);
  assert.deepEqual(h.logs.views, ['dialog']);
  assert.match($('#runLogText').textContent, /VITE ready/);
  await $('#runLogCopy').listeners.click();
  assert.match(h.logs.copies[0], /Local: http/);
  $('#runLogClose').listeners.click();
  assert.equal($('#runLogModal').hidden, true);
  // 중지 → 끝남
  await $('#dhRunBtn').listeners.click();
  assert.equal(h.logs.stops, 1);
  h.on['devrun:state']({ running: false, name: 'dev', exit: { code: 1, stopped: false } });
  assert.match($('#dhRunState').textContent, /dev이\(가\) 끝났습니다 \(종료 코드 1\)/);
  assert.equal($('#dhRunBtn').textContent, '▶ 앱 실행 (dev)');
  // 다른 스크립트를 고르면 기억한다
  $('#dhRunScript').value = 'start';
  $('#dhRunScript').listeners.change();
  assert.equal($('#dhRunBtn').textContent, '▶ 앱 실행 (start)');
});

test('화면: node · npm이 없으면 실행 단추를 막고 이유, 크롬 확장(host.devrun 없음)은 칸을 숨김', async () => {
  const h = setup({ block: 'npm이(가) 이 PC에 없어 dev을(를) 실행할 수 없습니다' });
  h.ctx.window.onDevRunProject('C:\\p');
  await tick();
  assert.equal(h.$('#dhRunBtn').disabled, true);
  assert.match(h.$('#dhRunState').textContent, /실행할 수 없습니다/);
  const x = setup({ devrun: false });
  x.ctx.window.onDevRunProject('C:\\p');
  await tick();
  assert.equal(x.$('#dhRun').hidden, true);
});

test('연결: 칸 자리 · 로그 창 · 스크립트 순서 · 확장 빌드 · preload · 본체 등록 · 끌 때 · 프로젝트 닫을 때', () => {
  const html = read('src/renderer/index.html');
  assert.ok(html.indexOf('id="devHub"') < html.indexOf('id="dhRun"') && html.indexOf('id="dhRun"') < html.indexOf('id="psRules"'));
  assert.match(html, /id="runLogModal" class="modal" hidden/);
  assert.ok(html.indexOf('src="dev-hub.js"') < html.indexOf('src="dev-run.js"'));
  assert.match(read('scripts/build-extension.js'), /'dev-run\.js'/);
  const pre = read('src/preload/preload.js');
  assert.match(pre, /'devrun:state'/);
  assert.match(pre, /start: \(name\) => ipcRenderer\.invoke\('devrun:start', name\)/);
  const main = read('src/main/main.js');
  assert.match(main, /devRun = setupDevRun\(/);
  assert.match(main, /devRun\?\.stop\(\)/);
  assert.equal((read('src/main/ipc/project.js').match(/ctx\.devRun\?\.\(\)\?\.onProjectChange\(\)/g) || []).length, 2);
  assert.match(read('src/renderer/dev-hub.js'), /window\.onDevRunProject\?\.\(key\)/);
});
