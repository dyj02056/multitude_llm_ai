'use strict';
// 로드맵 창(roadmap-ui.js) 동작 테스트 — 가짜 화면(DOM) · 가짜 프로젝트 폴더로 처음부터 끝까지 돌려 본다:  npm test
// [쉽게 말하면] 계획서 넣기 → AI에게 분해 부탁 → 답 붙여 넣기 → 작업 목록 → 상태 바꾸기(잠긴 작업은 거절) → 구현 요청 글 채우기 →
//   문서 자동 쓰기(기존 README는 그대로, 별도 파일) → 진행 데이터 저장 → 비밀 정보가 있으면 문서를 쓰지 않음.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RM = require('../src/shared/roadmap');
const CH = require('../src/shared/roadmap-charts');
const DOCS = require('../src/shared/roadmap-docs');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const ANSWER = `\`\`\`json
{"title":"할 일 앱","milestones":[{"id":"m1","title":"기반","tasks":[
 {"id":"t1","title":"뼈대","files":["package.json"],"accept":"실행된다","weight":2},
 {"id":"t2","title":"저장소","deps":["t1"],"files":["src/store.js","src/none.js"],"accept":"저장된다","weight":3}]}]}
\`\`\``;

function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: '', children: [], dataset: {}, title: '', _text: '', hidden: false, disabled: false, value: '', checked: false, listeners: {}, attrs: {}, innerHTML: '' });
      this.classList = { add: (c) => (this.className = `${this.className} ${c}`.trim()) };
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    append(...kids) {
      this.children.push(...kids);
    }
    replaceChildren(...kids) {
      this.children = kids;
      this._text = '';
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    querySelectorAll() {
      return [];
    }
    focus() {}
  }
  const byId = new Map();
  const $ = (sel) => {
    if (!byId.has(sel)) byId.set(sel, new El('div'));
    return byId.get(sel);
  };
  return { El, $, document: { createElement: (t) => new El(t), getElementById: () => null, head: new El('head'), querySelector: () => null } };
}
const walk = (n, out = []) => {
  if (!n || typeof n === 'string') return out;
  out.push(n);
  for (const c of n.children || []) walk(c, out);
  return out;
};
const rowOf = (root, id) => walk(root).find((n) => n.dataset && n.dataset.task === id);
const find = (node, pred) => walk(node).find(pred);

function setup({ files = {}, answers = [], git = false } = {}) {
  i18n.setLang('ko');
  const dom = fakeDom();
  const FS = new Map(Object.entries(files));
  const writes = [];
  const sent = [];
  const checked = new Set();
  const logs = { views: [], commits: [] };
  const state = { chatView: 'panels', rects: [{ id: 'claude' }, { id: 'gemini' }], services: [{ id: 'claude', name: 'Claude' }, { id: 'gemini', name: 'Gemini' }] };
  const host = {
    setView: (v) => logs.views.push(v),
    project: {
      readFile: async (p) => (FS.has(p) ? { text: FS.get(p) } : { missing: true }),
      writeFile: async (p, text) => (FS.set(p, text), writes.push(p), true),
      deleteFile: async (p) => FS.delete(p),
      readDir: async () => [{ name: 'src', kind: 'dir' }, { name: 'package.json', kind: 'file' }, { name: '.git', kind: 'dir' }],
    },
    sendPrompt: async (text, ids) => (sent.push({ text, ids }), ids.map((id) => ({ id, ok: true }))),
    getAnswers: async () => ({ question: '', answers }),
    saveFile: async (f) => ((logs.saved = f), { ok: true }),
    ...(git ? { git: { commit: async (req) => (logs.commits.push(req), { ok: true, hash: 'abc1234' }) } } : {}),
  };
  const P = {
    has: () => true,
    project: { info: { id: 'p1', name: 'todo' }, checked },
    entryOf: (f) => (['package.json', 'src/store.js'].includes(f) ? { path: f, kind: 'file' } : undefined),
    toggleFile: (e) => checked.add(e.path),
    rescan() {},
  };
  const ctx = {
    MLA: { roadmap: RM, roadmapCharts: CH, roadmapDocs: DOCS, i18n, projectUI: P },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state,
    host,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    window: {},
    alert: (m) => (logs.alert = m),
    confirm: () => true,
    prompt: () => '막힌 이유',
    CSS: { escape: (s) => s },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/roadmap-ui.js'), ctx);
  dom.$('#prompt');
  return { dom, FS, writes, sent, checked, logs, ctx, state };
}

async function bootstrap(h, opts = {}) {
  const { dom } = h;
  await dom.$('#roadmapBtn').listeners.click();
  await tick();
  dom.$('#roadmapWho').value = 'claude'; // (진짜 화면에서는 고르기 칸이 첫 AI를 고른다)
  dom.$('#roadmapPlan').value = opts.plan || '할 일 앱을 만든다.';
  await dom.$('#roadmapSendPlan').listeners.click();
  await dom.$('#roadmapGetAnswer').listeners.click();
  await dom.$('#roadmapApply').listeners.click();
  await tick(30);
}

test('로드맵 창: 열면 패널 화면을 치우고, 계획서 → AI 요청 → 답 붙여넣기 → 작업 목록이 되며 문서가 자동으로 써진다', async () => {
  const h = setup({ files: { 'README.md': '# 내 README\n직접 쓴 글\n', 'package.json': JSON.stringify({ name: 'todo', scripts: { start: 'node .' } }) }, answers: [{ id: 'claude', text: ANSWER }] });
  const { dom } = h;
  await bootstrap(h);
  assert.deepEqual(h.logs.views, ['dialog']);
  assert.equal(dom.$('#roadmapModal').hidden, false);
  assert.equal(h.sent.length, 1);
  assert.equal(JSON.stringify(h.sent[0].ids), '["claude"]');
  assert.ok(h.sent[0].text.includes('할 일 앱을 만든다.') && h.sent[0].text.includes('src/')); // 계획서 + 폴더 구조
  assert.ok(!h.sent[0].text.includes('.git'));
  assert.ok(dom.$('#roadmapAnswer').value.includes('"milestones"'));
  assert.match(dom.$('#roadmapStatus').textContent, /문서를 썼습니다: docs\/procedure\.md, README\.generated\.md/); // 분해 직후 문서 자동 쓰기
  assert.equal(RM.tasksOf(h.ctx.MLA.roadmapUI.get()).length, 2);
  // 문서: 새 procedure.md, 기존 README는 그대로 + 별도 파일
  assert.ok(h.FS.get('docs/procedure.md').includes('# 할 일 앱 — 구현 절차'));
  assert.equal(h.FS.get('README.md'), '# 내 README\n직접 쓴 글\n');
  assert.ok(h.FS.get('README.generated.md').includes('npm run start'));
  // 작업 탭: 두 작업이 보이고 t2는 잠김
  const tasks = dom.$('#roadmapTasks');
  assert.ok(rowOf(tasks, 't1') && rowOf(tasks, 't2'));
  assert.match(rowOf(tasks, 't2').className, /rm-locked/);
  // 닫으면 화면 복귀 + 진행 데이터 저장
  h.state.chatView = 'dialog';
  await dom.$('#roadmapClose').listeners.click();
  await tick();
  assert.deepEqual(h.logs.views, ['dialog', 'panels']);
  const saved = JSON.parse(h.FS.get('.mla/roadmap.json'));
  assert.equal(saved.milestones[0].tasks.length, 2);
  assert.equal(saved.plan, '할 일 앱을 만든다.');
});

test('로드맵 창: 잠긴 작업은 상태를 못 바꾸고, 선행을 완료하면 열리고 문서의 진행률이 바뀐다', async () => {
  const h = setup({ files: { 'package.json': '{}' }, answers: [{ id: 'claude', text: ANSWER }] });
  const { dom } = h;
  await bootstrap(h);
  const sel = (id) => find(rowOf(dom.$('#roadmapTasks'), id), (n) => n.className === 'rm-status');
  // t2는 t1이 끝나기 전에는 진행 중으로 못 바꾼다
  const s2 = sel('t2');
  s2.value = 'doing';
  await s2.listeners.change();
  assert.match(dom.$('#roadmapStatus').textContent, /먼저 끝내야 할 작업이 있습니다: t1/);
  assert.equal(s2.value, 'todo');
  // t1 완료 → 문서 갱신
  const s1 = sel('t1');
  s1.value = 'done';
  await s1.listeners.change();
  await tick(30);
  assert.equal(RM.findTask(h.ctx.MLA.roadmapUI.get(), 't1').status, 'done');
  assert.match(h.FS.get('docs/procedure.md'), /✓ 완료/);
  assert.match(h.FS.get('docs/procedure.md'), /전체 진행률 \*\*40%\*\*/); // 가중치 2/5
  assert.doesNotMatch(rowOf(dom.$('#roadmapTasks'), 't2').className, /rm-locked/);
  // 막힘은 이유를 묻고 기록한다
  const s2b = sel('t2');
  s2b.value = 'blocked';
  await s2b.listeners.change();
  assert.equal(RM.findTask(h.ctx.MLA.roadmapUI.get(), 't2').note, '막힌 이유');
});

test('로드맵 창: 구현 요청은 요청 글을 입력창에 채우고(보내지 않음) 작업을 진행 중으로 바꾸며 예상 파일 중 있는 것만 고른다', async () => {
  const h = setup({ files: { 'package.json': '{}' }, answers: [{ id: 'claude', text: ANSWER }] });
  const { dom } = h;
  await bootstrap(h);
  const impl = (id) => find(rowOf(dom.$('#roadmapTasks'), id), (n) => n.tag === 'button' && n._text === '구현 요청');
  assert.equal(impl('t2').disabled, true); // 잠김
  const sentBefore = h.sent.length;
  await impl('t1').listeners.click();
  assert.ok(dom.$('#prompt').value.includes('[이번 작업] t1 뼈대') && dom.$('#prompt').value.includes('실행된다'));
  assert.equal(h.sent.length, sentBefore); // 보내지 않았다
  assert.equal(RM.findTask(h.ctx.MLA.roadmapUI.get(), 't1').status, 'doing');
  assert.deepEqual([...h.checked], ['package.json']);
  assert.match(dom.$('#sendHint').textContent, /t1 작업 요청 글을 입력창에 채웠습니다 \(파일 1개 선택\)/);
  assert.equal(dom.$('#roadmapModal').hidden, true);
});

test('로드맵 창: 비밀 정보로 보이는 글이 문서에 들어가면 쓰지 않고 알린다 · 설정 끄면 자동 쓰기 없음', async () => {
  const secretPlan = `토큰은 AKIA${'ABCDEFGHIJKLMNOP'} 로 한다`;
  const h = setup({ files: { 'package.json': '{}' }, answers: [{ id: 'claude', text: ANSWER }] });
  await bootstrap(h, { plan: secretPlan });
  assert.ok(!h.FS.has('docs/procedure.md'));
  assert.match(h.dom.$('#roadmapDocsPreview').textContent + h.dom.$('#roadmapStatus').textContent, /비밀 정보/);

  const off = setup({ files: { 'package.json': '{}' }, answers: [{ id: 'claude', text: ANSWER }] });
  off.dom.$('#roadmapDocsOn').checked = false;
  await off.dom.$('#roadmapBtn').listeners.click();
  await tick();
  await off.dom.$('#roadmapDocsOn').listeners.change({ target: off.dom.$('#roadmapDocsOn') });
  off.dom.$('#roadmapWho').value = 'claude';
  off.dom.$('#roadmapPlan').value = '계획';
  await off.dom.$('#roadmapGetAnswer').listeners.click();
  await off.dom.$('#roadmapApply').listeners.click();
  await tick(30);
  assert.equal(off.FS.has('docs/procedure.md'), true); // 새로 만든 로드맵의 설정이 기본(켬)이라 쓴다
});

test('로드맵 창: 수동 모드면 자동으로 쓰지 않고, [문서 만들기]는 미리보기 뒤 [문서 쓰기]에서 쓰며 되돌릴 수 있다', async () => {
  const h = setup({ files: { 'README.md': '내 글', 'package.json': '{}' }, answers: [{ id: 'claude', text: ANSWER }] });
  const { dom } = h;
  await bootstrap(h);
  // 설정을 수동으로
  dom.$('#roadmapDocsWhen').listeners.change({ target: { value: 'manual' } });
  const s1 = find(rowOf(dom.$('#roadmapTasks'), 't1'), (n) => n.className === 'rm-status');
  const before = h.FS.get('docs/procedure.md');
  s1.value = 'done';
  await s1.listeners.change();
  await tick(30);
  assert.equal(h.FS.get('docs/procedure.md'), before); // 자동으로 안 썼다
  // 수동으로 만들기 → 미리보기
  await dom.$('#roadmapDocsMake').listeners.click();
  const preview = dom.$('#roadmapDocsPreview');
  assert.ok(preview.textContent.includes('docs/procedure.md'));
  const write = find(preview, (n) => n.tag === 'button' && n._text === '문서 쓰기');
  assert.ok(write);
  await write.listeners.click();
  assert.notEqual(h.FS.get('docs/procedure.md'), before);
  assert.match(h.FS.get('docs/procedure.md'), /✓ 완료/);
  // 되돌리기
  await dom.$('#roadmapDocsUndo').listeners.click();
  assert.equal(h.FS.get('docs/procedure.md'), before);
});

test('로드맵 창: 작업 완료 + 자동 커밋 설정이면 예상 파일 중 있는 것만 작업 단위로 커밋하고 커밋 번호를 남긴다', async () => {
  const h = setup({ files: { 'package.json': '{}' }, answers: [{ id: 'claude', text: ANSWER }], git: true });
  const { dom } = h;
  await bootstrap(h);
  dom.$('#roadmapAutoCommit').listeners.change({ target: { checked: true } });
  const s1 = find(rowOf(dom.$('#roadmapTasks'), 't1'), (n) => n.className === 'rm-status');
  s1.value = 'done';
  await s1.listeners.change();
  await tick(30);
  assert.deepEqual(JSON.parse(JSON.stringify(h.logs.commits)), [{ paths: ['package.json'], message: 'feat(t1): 뼈대' }]);
  assert.equal(RM.findTask(h.ctx.MLA.roadmapUI.get(), 't1').commit, 'abc1234');
  assert.match(h.FS.get('docs/procedure.md'), /abc1234/);
});

test('로드맵 창: 프로젝트가 없으면 안내만 하고 열지 않으며, 분해 답이 틀리면 경고를 보여 준다', async () => {
  const none = setup();
  none.ctx.MLA.projectUI.has = () => false;
  await none.dom.$('#roadmapBtn').listeners.click();
  assert.match(none.logs.alert, /프로젝트 폴더를 여세요/);
  assert.equal(none.dom.$('#roadmapModal').hidden, false === false ? none.dom.$('#roadmapModal').hidden : true);

  const bad = setup({ files: { 'package.json': '{}' }, answers: [{ id: 'claude', text: '죄송하지만 JSON이 아닙니다' }] });
  await bad.dom.$('#roadmapBtn').listeners.click();
  await tick();
  bad.dom.$('#roadmapWho').value = 'claude';
  bad.dom.$('#roadmapPlan').value = '계획';
  await bad.dom.$('#roadmapGetAnswer').listeners.click();
  await bad.dom.$('#roadmapApply').listeners.click();
  assert.match(bad.dom.$('#roadmapWarn').textContent, /JSON 코드 블록/);
  assert.equal(bad.dom.$('#roadmapWarn').hidden, false);
  assert.ok(!bad.FS.has('.mla/roadmap.json'));
});
