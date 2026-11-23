'use strict';
// 화면 캡처 · AI 확인 · 적용 전/후 비교 (v0.45.0) 테스트:  npm test
// [쉽게 말하면]
//   - 본체 devtest.withTrial: 수정안을 잠깐 써 두고 일을 한 뒤 반드시 되돌림 · 그동안 잠금 · 잘못된 수정안 거절
//   - 화면(dev-capture.js)을 가짜 화면으로: 캡처 → 캡처 창 · 받을 AI는 그림을 받는 열린 패널만 · 보낼 글에 지금 작업의 완료 조건
//     · [보내기]를 눌러야 PNG 파일과 함께 보냄 · 두 장이면 비교 글 · 화면 비교 → 두 장을 골라 연다
//   - 연결(변경 보기 창의 [화면 비교] · 미리보기 도구 줄의 [화면 캡처] · preload 통로)
// 실제 Electron으로 캡처 · 비교(BEFORE → AFTER 화면, 파일 되돌림)를 확인한 결과는 릴리스 노트 v0.45.0에 적었다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const i18n = require('../src/shared/i18n');
const RM = require('../src/shared/roadmap');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

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

test('본체 withTrial: 잠깐 써 두고 일한 뒤 반드시 되돌림 (없던 파일은 지움) · 그동안 잠금 · 잘못된 수정안 · 일하다 실패해도', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-trial-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'p');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.html'), 'BEFORE');
  const electron = { dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevTest } = requireWithFakeElectron('../src/main/devtest', electron);
  const dt = setupDevTest({ ipcMain: { handle() {} }, getWin: () => null, project, userDataDir: tmp });
  await project.open(root);
  let seen = null;
  const r = await dt.withTrial([{ path: 'a.html', after: 'AFTER' }, { path: 'new.css', after: 'x{}' }], async () => {
    seen = { a: fs.readFileSync(path.join(root, 'a.html'), 'utf8'), css: fs.existsSync(path.join(root, 'new.css')), busy: dt.isBusy() };
    assert.equal((await dt.withTrial([{ path: 'a.html', after: 'Z' }], async () => 1)).ok, false); // 겹치면 거절
    return 'shot';
  });
  assert.deepEqual(seen, { a: 'AFTER', css: true, busy: true });
  assert.deepEqual(r, { ok: true, value: 'shot' });
  assert.equal(fs.readFileSync(path.join(root, 'a.html'), 'utf8'), 'BEFORE');
  assert.equal(fs.existsSync(path.join(root, 'new.css')), false);
  assert.equal(dt.isBusy(), false);
  assert.equal(fs.existsSync(path.join(tmp, 'devtest-recovery.json')), false); // 되돌렸으면 복구 파일도 지움
  // 일하다 실패해도 되돌린다
  const bad = await dt.withTrial([{ path: 'a.html', after: 'OOPS' }], async () => {
    throw new Error('capture failed');
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /capture failed/);
  assert.equal(fs.readFileSync(path.join(root, 'a.html'), 'utf8'), 'BEFORE');
  assert.equal((await dt.withTrial('nope', async () => 1)).ok, false);
  assert.equal((await dt.withTrial([{ path: '../x', after: 'a' }], async () => 1)).ok, false);
});

// ---------- 화면 ----------
function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: '', children: [], dataset: {}, title: '', _text: '', hidden: false, disabled: false, value: '', alt: '', src: '', listeners: {}, attrs: {} });
      const cls = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = { add: (c) => (this.className = [...cls().add(c)].join(' ')), toggle: (c, on) => { const s = cls(); if (on ?? !s.has(c)) s.add(c); else s.delete(c); this.className = [...s].join(' '); }, contains: (c) => cls().has(c) };
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...kids) { this.children.push(...kids); }
    prepend(...kids) { this.children.unshift(...kids); }
    replaceChildren(...kids) { this.children = kids; this._text = ''; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(k, v) { this.attrs[k] = v; }
    focus() {}
    all() { return [this, ...this.children.flatMap((c) => (typeof c === 'string' ? [] : c.all()))]; }
  }
  const byId = new Map();
  const $ = (sel) => {
    if (!byId.has(sel)) byId.set(sel, new El('div'));
    return byId.get(sel);
  };
  return { El, $ };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

function setup() {
  i18n.setLang('ko');
  const dom = fakeDom();
  dom.$('#patchModal').hidden = true;
  const logs = { sends: [], views: [], compares: [], removed: [] };
  let caps = [];
  let n = 0;
  const shot = (tag = '') => {
    const c = { id: `c${++n}`, at: 1700000000000 + n, url: 'http://localhost:5173/', title: 'demo', tag, w: 800, h: 600, bytes: 16 };
    caps.push(c);
    return c;
  };
  const host = {
    setView: (v) => logs.views.push(v),
    sendPrompt: async (text, ids, files, opts) => (logs.sends.push({ text, ids, files, opts }), ids.map((id) => ({ id, ok: true }))),
    preview: {
      capture: async () => ({ ok: true, capture: shot() }),
      captures: async () => caps.map((c) => ({ ...c })),
      captureData: async (id) => ({ ok: true, id, dataUrl: `data:image/png;base64,${PNG}` }),
      captureRemove: async (id) => (logs.removed.push(id), (caps = caps.filter((c) => c.id !== id)), true),
      captureSave: async () => ({ ok: true, path: 'C:\\x.png' }),
      compare: async (changes) => (logs.compares.push(changes), { ok: true, before: shot('before'), after: shot('after') }),
    },
  };
  const rm = RM.normalizeRoadmap({ title: 'demo', milestones: [{ id: 'm1', title: 'UI', tasks: [{ id: 't4', title: '사용자 목록', accept: '- 세 명이 보인다\n- 오류 표시 없음', status: 'doing' }] }] });
  const state = { chatView: 'panels', selected: ['gemini', 'local', 'duckai'], services: [{ id: 'gemini', name: 'Gemini', accept: ['image', 'document'] }, { id: 'local', name: '로컬 LLM', accept: [] }, { id: 'duckai', name: 'Duck.ai', accept: ['image'] }, { id: 'claude', name: 'Claude', accept: ['image'] }] };
  const store = new Map();
  const ctx = {
    MLA: { roadmap: RM, roadmapUI: { get: () => rm } },
    document: { createElement: (t) => new dom.El(t) },
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state,
    host,
    window: {},
    atob,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/dev-capture.js'), ctx);
  return { ...dom, logs, ctx, state, store, caps: () => caps };
}

test('화면: 미리보기가 열리면 [화면 캡처] → 캡처 창(그 그림 선택) · 받을 AI는 그림을 받는 열린 패널만 · 글에 완료 조건 · [보내기]로 PNG와 함께', async () => {
  const h = setup();
  const $ = h.$;
  h.ctx.window.onPreviewState({ open: true, url: 'http://localhost:5173/', captures: 0 });
  await tick();
  assert.equal($('#dhCap').hidden, false);
  assert.equal($('#dhCapShot').disabled, false);
  assert.equal($('#dhCapOpen').disabled, true);
  await $('#dhCapShot').listeners.click();
  await tick(30);
  assert.equal($('#capModal').hidden, false);
  assert.deepEqual(h.logs.views, ['dialog']);
  assert.equal($('#dhCapOpen').textContent, '캡처 1장');
  // 받을 AI: 열린 패널 중 그림을 받는 것 (로컬 LLM 빠짐, 열지 않은 Claude 빠짐)
  assert.deepEqual($('#capWho').children.map((o) => o.value), ['gemini', 'duckai']);
  const text = $('#capText').value;
  assert.match(text, /^첨부한 그림은 지금 개발 중인 앱 화면\(http:\/\/localhost:5173\/\)을 캡처한 것입니다/);
  assert.match(text, /\[지금 작업 t4 사용자 목록 — 완료 조건\]\n- 세 명이 보인다\n- 오류 표시 없음/);
  assert.equal($('#capSend').textContent, '이 그림을 보내기');
  // 보내기 전에는 아무것도 보내지 않았다
  assert.equal(h.logs.sends.length, 0);
  $('#capWho').value = 'duckai';
  await $('#capSend').listeners.click();
  assert.equal(h.logs.sends.length, 1);
  const s = h.logs.sends[0];
  assert.deepEqual([...s.ids], ['duckai']);
  assert.equal(s.files.length, 1);
  assert.equal(s.files[0].type, 'image/png');
  assert.equal(s.files[0].name, 'screen-1.png');
  assert.ok(s.files[0].data instanceof ArrayBuffer || Object.prototype.toString.call(s.files[0].data) === '[object ArrayBuffer]');
  assert.equal(Buffer.from(s.files[0].data).toString('hex').slice(0, 16), '89504e470d0a1a0a');
  assert.equal($('#capModal').hidden, true); // 보내면 닫고 패널 화면으로
  assert.equal(h.store.get('mla-cap-who'), 'duckai');
});

test('화면: 화면 비교 → 두 장(적용 전 · 후)을 골라 나란히, 비교 글 · 두 그림을 함께 보냄 · 그림을 받는 패널이 없으면 보내기를 막음 · 지우기', async () => {
  const h = setup();
  const $ = h.$;
  h.ctx.window.onPreviewState({ open: true, url: 'http://localhost:5173/', captures: 0 });
  assert.equal(h.ctx.MLA.devCapture.canCompare(), true);
  const msg = await h.ctx.MLA.devCapture.compare([{ path: 'src/App.jsx', after: 'x' }]);
  assert.equal(msg, '적용 전 · 후 화면을 캡처했습니다 — 파일은 원래대로입니다');
  assert.deepEqual(h.logs.compares, [[{ path: 'src/App.jsx', after: 'x' }]]);
  assert.equal($('#capView').classList.contains('pair'), true);
  assert.match($('#capView').textContent, /왼쪽은 지금 파일, 오른쪽은 수정안을 잠깐 써 본 화면/);
  assert.match($('#capView').textContent, /적용 전 · http/);
  assert.match($('#capView').textContent, /적용 후 · http/);
  assert.match($('#capText').value, /첫째는 수정안을 적용하기 전, 둘째는 적용한 뒤입니다/);
  assert.equal($('#capSend').textContent, '두 그림을 보내기');
  await $('#capSend').listeners.click();
  assert.deepEqual([...h.logs.sends[0].files.map((f) => f.name)], ['screen-1-before.png', 'screen-2-after.png']);
  // 그림을 받는 패널이 없으면 보내기 단추를 막는다
  h.state.selected = ['local'];
  await h.ctx.MLA.devCapture.openGallery();
  assert.equal($('#capSend').disabled, true);
  assert.equal($('#capNoWho').hidden, false);
  // 지우기
  await $('#capRemove').listeners.click();
  assert.equal(h.logs.removed.length, 1);
  // 미리보기가 닫혀 있으면 비교하지 않는다
  h.ctx.window.onPreviewState({ open: false });
  assert.equal(await h.ctx.MLA.devCapture.compare([]), '먼저 미리보기 창을 여세요 (▶ 앱 실행 → 미리보기 열기)');
});

test('연결: 변경 보기 창의 [화면 비교] · 미리보기 도구 줄의 [화면 캡처] · preload 통로 · 확장 빌드 · 사전', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="patchTest"[^\n]*\n\s*<button id="patchShot" hidden/);
  assert.match(html, /id="capModal" class="modal" hidden/);
  assert.ok(html.indexOf('id="dhPvState"') < html.indexOf('id="dhCap"'));
  assert.ok(html.indexOf('src="dev-run.js"') < html.indexOf('src="dev-capture.js"'));
  const dt = read('src/renderer/project-devtest.js');
  assert.match(dt, /setupShot\(getChosen\);/);
  assert.match(dt, /MLA\.devCapture\.compare\(chosen\.map/);
  assert.match(read('src/renderer/preview.html'), /id="pvCapture"/);
  assert.match(read('src/renderer/preview.js'), /window\.pv\.capture\(\)/);
  assert.match(read('src/preload/preview-preload.js'), /capture: \(\) => ipcRenderer\.invoke\('pv:capture'\)/);
  const pre = read('src/preload/preload.js');
  for (const ch of ['preview:capture', 'preview:captures', 'preview:captureData', 'preview:captureRemove', 'preview:captureSave', 'preview:compare']) assert.match(pre, new RegExp(`'${ch}'`));
  assert.match(read('src/main/main.js'), /setupPreview\(\{ ipcMain, getWin: \(\) => win, shell, devTest: \(\) => devTest, log \}\)/);
  assert.match(read('scripts/build-extension.js'), /'dev-capture\.js'/);
  i18n.setLang('en');
  assert.match(i18n.t('prompt.cap.ask', { url: 'u', accept: '' }), /screenshot of the app/);
  i18n.setLang('ko');
});
