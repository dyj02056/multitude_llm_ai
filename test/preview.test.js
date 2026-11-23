'use strict';
// 미리보기 창 (v0.44.0) 테스트:  npm test
// [쉽게 말하면]
//   - 점검 규칙(shared/preview-health.js): 빈 화면 · 실패한 요청 고르기 · 같은 오류 묶기 · 판정(초록 · 노랑 · 빨강)
//   - 도구 줄(preview.js)을 가짜 화면으로: 판정 · 배지 · 자세히 펼치기(사이트 화면을 내림) · 뒤로 · 새로 고침
//   - 사이드바(dev-run.js): ▶ 로 띄운 서버의 주소를 찾으면 미리보기를 한 번 열고, [미리보기 열기] 단추 · 점검 한 줄
//   - 안전 장치 · 연결(따로 된 세션 · preload 없음 · 권한 거절 · 다운로드 막기 · 이 PC 주소만 · 프로젝트 닫으면 닫음)
// 실제 Electron 창으로 콘솔 오류 · 404 · 빈 화면 · 바깥 주소 막기 · 연결 거부를 확인한 결과는 릴리스 노트 v0.44.0에 적었다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../src/shared/preview-health');
const i18n = require('../src/shared/i18n');
const E = require('../src/shared/env-rules');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test('점검 규칙: 빈 화면 · 실패한 요청 · 같은 오류 묶기 · 판정 순서', () => {
  assert.equal(H.blankFrom({ text: 0, media: 0, nodes: 3 }), true);
  assert.equal(H.blankFrom({ text: 5, media: 0 }), false);
  assert.equal(H.blankFrom({ text: 0, media: 1 }), false); // 그림 · 캔버스만 있는 화면은 비지 않음
  assert.equal(H.blankFrom(null), null);
  assert.equal(H.isFailedRequest({ statusCode: 404, url: 'http://localhost/api' }), true);
  assert.equal(H.isFailedRequest({ statusCode: 500 }), true);
  assert.equal(H.isFailedRequest({ statusCode: 304 }), false);
  assert.equal(H.isFailedRequest({ statusCode: 404, url: 'http://localhost:5173/favicon.ico' }), false);
  assert.equal(H.isFailedRequest({ error: 'net::ERR_ABORTED' }), false);
  assert.equal(H.isFailedRequest({ error: 'net::ERR_CONNECTION_REFUSED' }), true);
  let list = [];
  list = H.addItem(list, { text: 'boom' });
  list = H.addItem(list, { text: 'boom' });
  list = H.addItem(list, { text: 'other' });
  assert.deepEqual(list.map((x) => [x.text, x.count]), [['other', 1], ['boom', 2]]);
  for (let i = 0; i < 50; i++) list = H.addItem(list, { text: `e${i}` });
  assert.equal(list.length, H.MAX_ITEMS);
  const base = { ...H.empty('http://localhost:5173/'), loading: false };
  assert.equal(H.verdict(null).level, 'wait');
  assert.equal(H.verdict(H.empty()).key, 'loading');
  assert.deepEqual(H.verdict(base), { level: 'ok', key: 'ok', errors: 0, failed: 0 });
  assert.equal(H.verdict({ ...base, failed: [{ count: 2 }] }).level, 'warn');
  assert.deepEqual(H.verdict({ ...base, errors: [{ count: 2 }], failed: [{ count: 1 }] }), { level: 'error', key: 'errors', errors: 2, failed: 1 });
  assert.equal(H.verdict({ ...base, blank: true }).key, 'blank');
  assert.equal(H.verdict({ ...base, loadError: 'ERR_CONNECTION_REFUSED (-102)', loading: true }).key, 'loadError'); // 못 열면 읽는 중이어도 빨강
  assert.match(H.PROBE_JS, /innerText/);
});

// ---------- 가짜 화면 ----------
function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: '', children: [], dataset: {}, title: '', _text: '', hidden: false, disabled: false, value: '', listeners: {}, attrs: {} });
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
  return { El, $ };
}

test('도구 줄: 판정 · 배지 · 자세히 펼치기(사이트 화면 내림) · 버튼', async () => {
  i18n.setLang('ko');
  const dom = fakeDom();
  const calls = { nav: [], details: [], external: 0 };
  let push = null;
  const ctx = {
    MLA: { previewHealth: H, i18n },
    window: { pv: { lang: 'ko', state: async () => ({ open: false }), nav: async (w) => calls.nav.push(w), external: async () => calls.external++, details: async (o) => calls.details.push(o), onState: (fn) => (push = fn) } },
    document: { querySelector: dom.$, createElement: (t) => new dom.El(t), addEventListener: () => {}, body: new dom.El('body'), querySelectorAll: () => [], documentElement: {} },
  };
  vm.createContext(ctx);
  dom.$('#pvDetails').hidden = true; // preview.html에서 처음에 숨겨 둔 칸
  vm.runInContext(read('src/renderer/preview.js'), ctx);
  const $ = dom.$;
  push({ open: true, home: 'http://localhost:5173/', url: 'http://localhost:5173/', loading: false, loadError: null, blank: false, errors: [], failed: [], canBack: false });
  assert.equal($('#pvVerdict').textContent, '✓ 문제 없음');
  assert.equal(ctx.document.body.dataset.level, 'ok');
  assert.equal($('#pvErrors').hidden, true);
  assert.equal($('#pvBack').disabled, true);
  push({ open: true, home: 'http://localhost:5173/', url: 'http://localhost:5173/x', loading: false, errors: [{ text: 'TypeError: x', source: 'a.js:1', count: 2 }], failed: [{ url: '/api', status: 500, count: 1 }], canBack: true, notice: '바깥 주소는 미리보기에서 열지 않습니다: https://e.com' });
  assert.equal($('#pvVerdict').textContent, '✗ 화면에 문제가 있습니다');
  assert.equal($('#pvErrors').textContent, '콘솔 오류 2');
  assert.equal($('#pvFailed').textContent, '실패한 요청 1');
  assert.match($('#pvNotice').textContent, /바깥 주소/);
  // 배지 → 자세히 펼침(사이트 화면을 내림) → 다시 누르면 접음
  $('#pvErrors').listeners.click();
  assert.equal($('#pvDetails').hidden, false);
  assert.match($('#pvDetails').textContent, /TypeError: x/);
  assert.deepEqual(calls.details, [true]);
  $('#pvFailed').listeners.click();
  assert.match($('#pvDetails').textContent, /500/);
  $('#pvFailed').listeners.click();
  assert.equal($('#pvDetails').hidden, true);
  assert.deepEqual(calls.details, [true, false]);
  for (const id of ['#pvBack', '#pvFwd', '#pvReload', '#pvHome', '#pvDevtools']) $(id).listeners.click();
  $('#pvExternal').listeners.click();
  assert.deepEqual(calls.nav, ['back', 'forward', 'reload', 'home', 'devtools']);
  assert.equal(calls.external, 1);
  push({ open: true, url: 'http://localhost:1/', loading: false, loadError: 'ERR_CONNECTION_REFUSED (-102)', errors: [], failed: [] });
  assert.match($('#pvVerdict').textContent, /페이지를 열지 못했습니다 — ERR_CONNECTION_REFUSED/);
});

test('사이드바: ▶ 로 띄운 서버의 주소를 찾으면 미리보기를 한 번 열고, [미리보기 열기] · 점검 한 줄', async () => {
  i18n.setLang('ko');
  const dom = fakeDom();
  const on = {};
  const opened = [];
  const host = {
    on: (ch, fn) => (on[ch] = fn),
    setView() {},
    devrun: { info: async () => ({ ok: true, scripts: [{ name: 'dev', script: 'vite' }], state: { running: false } }), start: async (n) => ({ ok: true, state: { running: true, name: n, url: null } }), stop: async () => true, log: async () => ({ ok: true, text: '' }), open: async () => true },
    preview: { open: async (u) => (opened.push(u), { ok: true }), state: async () => ({ open: false }), close: async () => true },
  };
  const ctx = {
    MLA: { envRules: E, i18n, previewHealth: H, projectUI: { has: () => true, project: { info: { id: 'p' } } }, devHub: { blockReason: () => '' } },
    document: { createElement: (t) => new dom.El(t), createTextNode: (s) => s },
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state: { chatView: 'panels' },
    host,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 1,
    clearInterval() {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/dev-run.js'), ctx);
  ctx.window.onDevRunProject('p');
  await tick();
  await dom.$('#dhRunBtn').listeners.click();
  on['devrun:state']({ running: true, name: 'dev', url: null });
  assert.deepEqual(opened, []);
  on['devrun:state']({ running: true, name: 'dev', url: 'http://localhost:5173/' });
  await tick();
  assert.deepEqual(opened, ['http://localhost:5173/']); // 처음 찾았을 때 한 번
  on['devrun:state']({ running: true, name: 'dev', url: 'http://localhost:5173/', lines: 9 });
  assert.equal(opened.length, 1); // 다시 열지 않는다
  // 미리보기 점검 결과 → 사이드바 한 줄 + 단추 글이 "미리보기로"
  let pvSeen = null;
  ctx.window.onPreviewState = (pv) => (pvSeen = pv);
  on['preview:state']({ open: true, loading: false, errors: [{ count: 2 }], failed: [{ count: 1 }] });
  assert.equal(dom.$('#dhPvState').hidden, false);
  assert.match(dom.$('#dhPvState').textContent, /미리보기✗ 콘솔 오류 2 · 실패한 요청 1/);
  assert.equal(pvSeen.open, true);
  const pvBtn = dom.$('#dhRunState').children.find((c) => c.className.includes('dh-pv-btn'));
  assert.equal(pvBtn.textContent, '미리보기로');
  await pvBtn.listeners.click();
  assert.equal(opened.length, 2);
  on['preview:state']({ open: false });
  assert.equal(dom.$('#dhPvState').hidden, true);
});

test('안전 장치 · 연결: 따로 된 세션 · preload 없음 · 권한 거절 · 다운로드 막기 · 이 PC 주소만 · 닫기', () => {
  const src = read('src/main/preview.js');
  assert.match(src, /new WebContentsView\(\{ webPreferences: \{ session: previewSession\(\), contextIsolation: true, nodeIntegration: false, sandbox: true \} \}\)/); // 사이트 화면에 preload 없음
  assert.match(src, /session\.fromPartition\(PARTITION\)/);
  assert.match(src, /const PARTITION = 'mla-preview'/);
  assert.match(src, /setPermissionRequestHandler\(\(_wc, _perm, cb\) => cb\(false\)\)/);
  assert.match(src, /will-download', \(e\) => e\.preventDefault\(\)/);
  assert.match(src, /ipcMain\.handle\('preview:open', \(_e, url\) => \{\r?\n\s+if \(!isLocalUrl\(url\)\)/);
  assert.match(src, /wc\.on\('will-navigate', guard\)/);
  assert.match(src, /e\.sender === pw\.win\.webContents/); // 도구 줄 요청은 그 창에서 온 것만
  const pre = read('src/preload/preview-preload.js');
  assert.match(pre, /exposeInMainWorld\('pv'/);
  assert.doesNotMatch(pre, /project|devtest|git/);
  assert.match(read('src/renderer/preview.html'), /script-src 'self'/);
  assert.match(read('src/preload/preload.js'), /'preview:state'\]\);/);
  const main = read('src/main/main.js');
  assert.match(main, /preview = setupPreview\(/);
  assert.match(main, /preview\?\.close\(\);/);
  assert.equal((read('src/main/ipc/project.js').match(/ctx\.preview\?\.\(\)\?\.close\(\)/g) || []).length, 2);
  // 빌드에 들어가는지 (src/**/*)
  assert.ok(require('../package.json').build.files.includes('src/**/*'));
  i18n.setLang('en');
  assert.equal(i18n.t('dev.pv.v.ok'), '✓ No problems');
  i18n.setLang('ko');
});
