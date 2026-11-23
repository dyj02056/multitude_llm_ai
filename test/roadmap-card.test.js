'use strict';
// 로드맵 카드 (v0.40.0) 테스트:  npm test
// [쉽게 말하면]
//   - 카드 계산(shared/roadmap.js): 지금 할 작업 고르기, 테스트 결과 읽기, 적용하면 검증 중, 단계마다 보일 버튼
//   - 카드 화면(roadmap-card.js)을 가짜 화면 · 가짜 프로젝트 폴더로 처음부터 끝까지:
//     구현 요청 → (보내기) → 미리보기 테스트 통과 → 적용 → 검증 중 + "완료로 바꿀까요?" → 완료 → 다음 작업이 카드에
//   - "통과하면 바로 완료", 고쳐 받기를 다 쓴 실패 → 막힘 권하기, 확장(테스트 없음)에서는 [테스트 실행]이 없음
//   - 파일 연결 (사이드바 자리 · 스크립트 순서 · 확장 빌드 · 문구 짝)
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

const ROADMAP = {
  title: '할 일 앱',
  milestones: [
    {
      id: 'm1',
      title: '기반',
      tasks: [
        { id: 't1', title: '뼈대', files: ['package.json'], accept: '실행된다\n테스트 통과', weight: 2 },
        { id: 't2', title: '저장소', deps: ['t1'], files: ['src/store.js'], accept: '저장된다', weight: 3 },
        { id: 't3', title: '설정', files: [], accept: '', weight: 1 },
      ],
    },
  ],
};
const fresh = () => RM.normalizeRoadmap(JSON.parse(JSON.stringify(ROADMAP)));
const passRun = (pass = 12) => ({ ok: true, results: [{ name: 'test', before: { ok: false }, after: { ok: true, summary: { pass, fail: 0 } } }] });
const failRun = () => ({ ok: true, results: [{ name: 'test', before: { ok: true }, after: { ok: false, code: 1, summary: { pass: 3, fail: 2 } } }] });

// ---------- 계산 ----------
test('카드 계산: 지금 할 작업은 기억한 작업 → 진행 · 검증 중 → 고른 대기 작업 → 맨 위의 열린 작업', () => {
  let rm = fresh();
  assert.equal(RM.currentTask(rm).id, 't1');
  assert.equal(RM.currentTask(rm, { pick: 't3' }).id, 't3');
  assert.equal(RM.currentTask(rm, { pick: 't2' }).id, 't1'); // 잠긴 작업은 고를 수 없다
  assert.equal(RM.nextPick(rm, 't1'), 't3');
  assert.equal(RM.nextPick(rm, 't3'), 't1'); // 끝이면 처음으로
  rm = RM.setStatus(rm, 't3', 'doing').roadmap;
  assert.equal(RM.currentTask(rm, { pick: 't1' }).id, 't3'); // 진행 중인 작업이 먼저
  rm = RM.setActive(RM.setStatus(rm, 't1', 'blocked').roadmap, 't1');
  assert.equal(RM.currentTask(rm).id, 't1'); // 기억한 작업은 막혀도 카드에 남는다
  assert.equal(RM.setActive(rm, 'nope').active, '');
  // 저장 · 불러오기에도 남고, 없는 id면 지운다
  assert.equal(RM.normalizeRoadmap(JSON.parse(JSON.stringify(rm))).active, 't1');
  assert.equal(RM.normalizeRoadmap({ ...rm, active: 'zz' }).active, '');
});

test('카드 계산: 테스트 결과 읽기 — 모두 통과해야 pass, 취소 · 중지 · 실행 못 함은 판단하지 않음', () => {
  assert.deepEqual(RM.trialInfo(passRun()), { verdict: 'pass', pass: 12, fail: 0 });
  assert.deepEqual(RM.trialInfo(failRun()), { verdict: 'fail', pass: 3, fail: 2 });
  assert.equal(RM.trialInfo({ ok: false, cancelled: true }).verdict, 'none');
  assert.equal(RM.trialInfo(null).verdict, 'none');
  assert.equal(RM.trialInfo({ ok: true, results: [{ name: 'test', after: { ok: true } }, { name: 'lint', after: null }] }).verdict, 'none'); // 중간에 멈춤
  assert.equal(RM.trialInfo({ ok: true, results: [{ name: 'test', after: { stopped: true } }] }).verdict, 'none');
  assert.equal(RM.trialInfo({ ok: true, results: [{ name: 'test', after: { ok: true } }, { name: 'lint', after: { ok: false } }] }).verdict, 'fail');
  assert.equal(RM.trialInfo({ ok: true, after: { ok: true } }).verdict, 'pass'); // 예전 모양
});

test('카드 계산: 적용하면 기억한 작업만 진행 중 → 검증 중 (다른 작업 · 대기 작업은 그대로)', () => {
  let rm = fresh();
  assert.equal(RM.afterApply(rm).changed, false); // 기억한 작업 없음
  rm = RM.setActive(RM.setStatus(rm, 't1', 'doing').roadmap, 't1');
  const r = RM.afterApply(rm);
  assert.equal(r.changed, true);
  assert.equal(r.id, 't1');
  assert.equal(RM.findTask(r.roadmap, 't1').status, 'verify');
  assert.equal(RM.afterApply(r.roadmap).changed, false); // 이미 검증 중
  assert.equal(r.roadmap.log.at(-1).status, 'verify');
});

test('카드 계산: 단계마다 보일 버튼', () => {
  let rm = fresh();
  assert.equal(RM.cardState(RM.normalizeRoadmap({})).phase, 'none');
  let cs = RM.cardState(rm);
  assert.equal(cs.phase, 'ready');
  assert.deepEqual(cs.actions, ['implement', 'skip']); // 열린 작업이 둘(t1, t3)
  rm = RM.setActive(RM.setStatus(rm, 't1', 'doing').roadmap, 't1');
  assert.deepEqual(RM.cardState(rm).actions, ['done', 'block']);
  rm = RM.afterApply(rm).roadmap;
  assert.deepEqual(RM.cardState(rm, { canTest: true }).actions, ['test', 'done', 'block']);
  assert.deepEqual(RM.cardState(rm, { canTest: false }).actions, ['done', 'block']); // 확장: 테스트 없음
  const pass = { task: 't1', ...RM.trialInfo(passRun()) };
  cs = RM.cardState(rm, { trial: pass, canTest: true });
  assert.equal(cs.phase, 'verifyPass');
  assert.deepEqual(cs.actions, ['done', 'notYet']);
  assert.equal(RM.cardState(rm, { trial: { ...pass, task: 't3' } }).phase, 'verify'); // 다른 작업의 결과는 쓰지 않는다
  assert.equal(RM.cardState(rm, { trial: { ...pass, verdict: 'dismissed' } }).phase, 'verify');
  cs = RM.cardState(rm, { trial: { task: 't1', ...RM.trialInfo(failRun()) }, canTest: true });
  assert.equal(cs.phase, 'verifyFail');
  assert.deepEqual(cs.actions, ['test', 'block', 'done']);
  rm = RM.setStatus(rm, 't1', 'blocked').roadmap;
  assert.deepEqual(RM.cardState(rm).actions, ['resume']);
  // 전부 완료
  let all = fresh();
  for (const id of ['t1', 't2', 't3']) all = RM.setStatus(all, id, 'done').roadmap;
  assert.equal(RM.cardState(all).phase, 'allDone');
  assert.equal(RM.DEFAULT_SETTINGS.autoDoneOnPass, false);
  assert.equal(RM.normalizeRoadmap({ settings: { autoDoneOnPass: true } }).settings.autoDoneOnPass, true);
});

// ---------- 화면 ----------
function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: '', children: [], dataset: {}, title: '', _text: '', hidden: false, disabled: false, value: '', checked: false, listeners: {}, attrs: {}, innerHTML: '' });
      const cls = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = {
        add: (c) => (this.className = [...cls().add(c)].join(' ')),
        toggle: (c, on) => {
          const s = cls();
          if (on === undefined ? !s.has(c) : on) s.add(c);
          else s.delete(c);
          this.className = [...s].join(' ');
        },
        contains: (c) => cls().has(c),
      };
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

function setup({ roadmap = fresh(), devtest = true, runResult = passRun(), git = false, devHub = null } = {}) {
  i18n.setLang('ko');
  const dom = fakeDom();
  const FS = new Map([['package.json', '{}'], ...(roadmap ? [['.mla/roadmap.json', JSON.stringify(roadmap)]] : [])]);
  const logs = { runs: 0, commits: [], views: [] };
  const checked = new Set();
  const state = { chatView: 'panels', rects: [{ id: 'claude' }], services: [{ id: 'claude', name: 'Claude' }] };
  const host = {
    setView: (v) => logs.views.push(v),
    project: {
      readFile: async (p) => (FS.has(p) ? { text: FS.get(p) } : { missing: true }),
      writeFile: async (p, text) => (FS.set(p, text), true),
      deleteFile: async (p) => FS.delete(p),
      readDir: async () => [],
    },
    sendPrompt: async (text, ids) => ids.map((id) => ({ id, ok: true })),
    getAnswers: async () => ({ answers: [] }),
    ...(devtest ? { devtest: { info: async () => ({ ok: true, checks: [{ name: 'test' }] }), run: async () => (logs.runs++, runResult) } } : {}),
    ...(git ? { git: { commit: async (req) => (logs.commits.push(req), { ok: true, hash: 'abc1234def' }) } } : {}),
  };
  let open = true;
  const P = {
    has: () => open,
    project: { info: { id: 'p1', name: 'todo' }, checked },
    entryOf: (f) => (['package.json', 'src/store.js'].includes(f) ? { path: f, kind: 'file' } : undefined),
    toggleFile: (e) => checked.add(e.path),
    rescan() {},
  };
  const store = new Map();
  const ctx = {
    MLA: { roadmap: RM, roadmapCharts: CH, roadmapDocs: DOCS, i18n, projectUI: P, ...(devHub ? { devHub } : {}) },
    document: dom.document,
    t: (k, v) => i18n.t(k, v),
    $: dom.$,
    state,
    host,
    button: (label, title, fn) => Object.assign(new dom.El('button'), { _text: label, title, listeners: { click: fn } }),
    window: {},
    alert: () => {},
    confirm: () => true,
    prompt: () => '막힌 이유',
    CSS: { escape: (s) => s },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/roadmap-ui.js'), ctx);
  vm.runInContext(read('src/renderer/roadmap-card.js'), ctx);
  const $ = dom.$;
  const acts = () => $('#rmcActs').children.map((b) => b.dataset.act);
  const click = async (name) => {
    const b = $('#rmcActs').children.find((x) => x.dataset.act === name);
    assert.ok(b, `버튼 ${name}이 없다 (보이는 것: ${acts().join(', ')})`);
    await b.listeners.click();
    await tick();
  };
  const ui = () => ctx.MLA.roadmapUI.get();
  return { dom, $, FS, logs, ctx, acts, click, ui, close: () => (open = false), checked };
}

async function opened(h) {
  h.ctx.window.onRoadmapProject();
  await tick(30);
}

test('카드 화면: 구현 요청 → 미리보기 테스트 통과 → 적용 → 검증 중 + 완료 확인 → 완료 → 다음 작업', async () => {
  const h = setup({ git: true });
  const { $ } = h;
  await opened(h);
  assert.equal($('#rmCard').hidden, false);
  assert.equal($('#rmcTitle').textContent, 't1 뼈대');
  assert.match($('#rmcState').textContent, /대기/);
  assert.match($('#rmcMeta').textContent, /기반 · 0\/3 작업/);
  assert.match($('#rmcRing').innerHTML, /0%/);
  assert.deepEqual($('#rmcAccept').children.map((li) => li.textContent), ['실행된다', '테스트 통과']);
  assert.deepEqual(h.acts(), ['implement', 'skip']);
  assert.ok($('#rmcActs').children[0].className.includes('primary'));

  // 1) 구현 요청: 입력창 채우기 · 진행 중 · 예상 파일 선택 · 이 작업을 기억 (보내지 않음)
  await h.click('implement');
  assert.ok($('#prompt').value.includes('[이번 작업] t1 뼈대'));
  assert.equal(RM.findTask(h.ui(), 't1').status, 'doing');
  assert.equal(h.ui().active, 't1');
  assert.ok(h.checked.has('package.json'));
  assert.deepEqual(h.acts(), ['done', 'block']);
  assert.match($('#rmcNote').textContent, /적용하면 자동으로 검증 중/);
  assert.equal(h.logs.views.length, 0); // 로드맵 창을 열지 않았다 (패널 화면 그대로)

  // 2) 미리보기 창에서 테스트 통과 (적용 전) → 아직 진행 중
  h.ctx.window.onRoadmapTrial(passRun(12), { exhausted: false });
  assert.equal(RM.findTask(h.ui(), 't1').status, 'doing');

  // 3) 적용 → 자동으로 검증 중, 미리보기 결과로 "완료로 바꿀까요?"
  await h.ctx.window.onRoadmapApplied({ id: 'e1' });
  await tick();
  assert.equal(RM.findTask(h.ui(), 't1').status, 'verify');
  assert.match($('#rmcNote').textContent, /테스트 12개 통과\. 완료로 바꿀까요\?/);
  assert.deepEqual(h.acts(), ['done', 'notYet']);
  assert.equal($('#rmcActs').children[0].textContent, '완료로 바꾸기');

  // 4) 완료 → 자동 커밋(설정) · 다음 작업(t2가 열림)이 카드에
  h.ctx.MLA.roadmapUI.replace({ ...h.ui(), settings: { ...h.ui().settings, autoCommit: true } });
  await h.click('done');
  await tick(30);
  assert.equal(RM.findTask(h.ui(), 't1').status, 'done');
  assert.equal(h.logs.commits.length, 1);
  assert.equal($('#rmcTitle').textContent, 't2 저장소');
  assert.match($('#rmcNote').textContent, /✓ t1 완료 · 커밋 abc1234/);
  assert.deepEqual(h.acts(), ['implement', 'skip']);
  assert.match($('#rmcMeta').textContent, /1\/3 작업/);
  // 저장됨
  await tick(450);
  const saved = JSON.parse(h.FS.get('.mla/roadmap.json'));
  assert.equal(saved.milestones[0].tasks[0].status, 'done');
});

test('카드 화면: 미리보기 테스트 없이 적용 → [테스트 실행]이 먼저, 통과하면 완료 확인 · "통과하면 바로 완료"면 바로 완료', async () => {
  const h = setup();
  await opened(h);
  await h.click('implement');
  await h.ctx.window.onRoadmapApplied({});
  await tick();
  assert.deepEqual(h.acts(), ['test', 'done', 'block']);
  assert.ok(h.$('#rmcActs').children[0].className.includes('primary'));
  await h.click('test');
  await tick();
  assert.equal(h.logs.runs, 1);
  assert.deepEqual(h.acts(), ['done', 'notYet']);
  await h.click('notYet');
  assert.deepEqual(h.acts(), ['test', 'done', 'block']); // 검증 중으로 남는다
  // 설정을 켜면 테스트 통과 즉시 완료
  h.ctx.MLA.roadmapUI.replace({ ...h.ui(), settings: { ...h.ui().settings, autoDoneOnPass: true } });
  await h.click('test');
  await tick(30);
  assert.equal(RM.findTask(h.ui(), 't1').status, 'done');
  assert.equal(h.$('#rmcTitle').textContent, 't2 저장소');
});

test('카드 화면: "통과하면 바로 완료"면 미리보기 통과 후 적용하는 순간 완료된다', async () => {
  const rm = fresh();
  rm.settings.autoDoneOnPass = true;
  const h = setup({ roadmap: rm });
  await opened(h);
  await h.click('implement');
  h.ctx.window.onRoadmapTrial(passRun(), {});
  await h.ctx.window.onRoadmapApplied({});
  await tick(30);
  assert.equal(RM.findTask(h.ui(), 't1').status, 'done');
});

test('카드 화면: 고쳐 받기를 다 쓰고도 실패하면 막힘을 권하고, 막힘 → 다시 진행', async () => {
  const h = setup();
  await opened(h);
  await h.click('implement');
  h.ctx.window.onRoadmapTrial(failRun(), { exhausted: false });
  assert.match(h.$('#rmcNote').textContent, /실패 로그로 다시 받기/);
  h.ctx.window.onRoadmapTrial(failRun(), { exhausted: true });
  assert.match(h.$('#rmcNote').textContent, /다시 받기를 다 썼는데/);
  const block = h.$('#rmcActs').children.find((b) => b.dataset.act === 'block');
  assert.ok(block.className.includes('primary'));
  await h.click('block');
  assert.equal(RM.findTask(h.ui(), 't1').status, 'blocked');
  assert.match(h.$('#rmcNote').textContent, /막힘: 막힌 이유/);
  assert.deepEqual(h.acts(), ['resume']);
  await h.click('resume');
  assert.equal(RM.findTask(h.ui(), 't1').status, 'doing');
});

test('카드 화면: 로드맵과 상관없는 적용 · 테스트는 무시, 실패한 적용 후 결과는 verifyFail', async () => {
  const h = setup();
  await opened(h);
  // 구현 요청 없이 적용 · 테스트 → 아무것도 안 바뀜
  h.ctx.window.onRoadmapTrial(passRun(), {});
  await h.ctx.window.onRoadmapApplied({});
  assert.equal(RM.findTask(h.ui(), 't1').status, 'todo');
  assert.deepEqual(h.acts(), ['implement', 'skip']);
  // [다음 ›]은 열린 다른 작업으로
  await h.click('skip');
  assert.equal(h.$('#rmcTitle').textContent, 't3 설정');
  await h.click('implement');
  h.ctx.window.onRoadmapTrial(failRun(), {});
  await h.ctx.window.onRoadmapApplied({});
  await tick();
  assert.equal(RM.findTask(h.ui(), 't3').status, 'verify');
  assert.deepEqual(h.acts(), ['test', 'block', 'done']);
  assert.match(h.$('#rmcNote').textContent, /테스트 실패 \(2개\)/);
});

test('카드 화면: 확장(테스트 실행 없음)은 [테스트 실행] 없이 완료만, 로드맵이 없으면 만들기 안내, 프로젝트를 닫으면 숨김', async () => {
  const h = setup({ devtest: false });
  await opened(h);
  await h.click('implement');
  await h.ctx.window.onRoadmapApplied({});
  await tick();
  assert.deepEqual(h.acts(), ['done', 'block']);
  assert.match(h.$('#rmcNote').textContent, /완료 조건을 확인한 뒤/);

  const e = setup({ roadmap: null });
  await opened(e);
  assert.equal(e.$('#rmcTitle').textContent, '로드맵이 없습니다');
  assert.equal(e.$('#rmcCreate').hidden, false); // 한 줄: 제목 + [로드맵 만들기]
  assert.equal(e.$('#rmcBody').hidden, true);
  assert.equal(e.$('#rmcFold').hidden, true);
  assert.ok(e.$('#rmCard').classList.contains('empty'));

  h.close();
  h.ctx.window.onRoadmapProject();
  await tick(30);
  assert.equal(h.$('#rmCard').hidden, true);
});

test('카드 화면: 접기는 이 PC에 기억되고, 로드맵 창에서 바꾼 상태가 카드에 바로 보인다', async () => {
  const h = setup();
  await opened(h);
  await h.$('#rmcFold').listeners.click();
  assert.equal(h.$('#rmcBody').hidden, true);
  assert.equal(h.$('#rmcFold').attrs['aria-expanded'], 'false');
  assert.equal(h.ctx.localStorage.getItem('mla-rm-card-fold'), '1');
  await h.$('#rmcFold').listeners.click();
  assert.equal(h.$('#rmcBody').hidden, false);
  // 창(다른 곳)에서 상태 변경 → 카드가 다시 그려진다
  await h.ctx.MLA.roadmapUI.setStatus('t1', 'doing');
  assert.match(h.$('#rmcState').textContent, /진행 중/);
});

// ---------- 연결 ----------
test('카드 연결: 사이드바 자리 · 스크립트 순서 · 신호 · 확장 빌드 · 문구 짝 · 테스트 한 번 실행 통로', () => {
  const html = read('src/renderer/index.html');
  assert.ok(html.indexOf('id="rmCard"') > html.indexOf('id="projectSide"') && html.indexOf('id="rmCard"') < html.indexOf('id="psTree"'));
  assert.ok(html.includes('id="roadmapAutoDone"'));
  const at = (n) => html.indexOf(`<script src="${n}"></script>`);
  assert.ok(at('roadmap-card.js') > at('roadmap-ui.js') && at('roadmap-card.js') < at('library.js'));
  assert.match(read('scripts/build-extension.js'), /'roadmap-card\.js'/);
  const app = read('extension/app.html');
  assert.ok(app.includes('lib/renderer/roadmap-card.js') && app.includes('id="rmCard"'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'extension/lib/renderer/roadmap-card.js')));
  assert.match(read('src/renderer/project-changes.js'), /window\.onRoadmapApplied\?\.\(entry\)/);
  assert.match(read('src/renderer/project-devtest.js'), /window\.onRoadmapTrial\?\.\(r, \{ exhausted \}\)/);
  assert.match(read('src/renderer/project.js'), /window\.onRoadmapProject\?\.\(\)/);
  assert.match(read('src/preload/preload.js'), /run: \(scripts\) => ipcRenderer\.invoke\('devtest:run', scripts\)/);
  const main = read('src/main/devtest.js');
  assert.match(main, /ipcMain\.handle\('devtest:run'/);
  // 한 번 실행도 확인 창을 거친다 (파일은 쓰지 않음)
  const block = main.slice(main.indexOf("ipcMain.handle('devtest:run'"), main.indexOf("ipcMain.handle('devtest:stop'"));
  assert.match(block, /showMessageBox/);
  assert.doesNotMatch(block, /writeFile|deleteFile/);
  const ko = require('../src/shared/i18n-ko-ui');
  const en = require('../src/shared/i18n-en-ui');
  const keys = (o) => Object.keys(o.default || o).filter((k) => k.startsWith('ui.roadmap.card.') || k.startsWith('ui.roadmap.docs.autoDone'));
  assert.ok(keys(ko).length >= 40);
  assert.deepEqual(keys(ko).sort(), keys(en).sort());
  // 카드도 <style>을 끼워 넣지 않는다 (앱 CSP)
  assert.doesNotMatch(read('src/renderer/roadmap-card.js'), /createElement\('style'\)|style="/);
});

test('카드 (v0.42.0): 작업의 필요한 도구가 이 PC에 없으면 경고 줄 + [실행 · 확인 열기], 카드의 테스트 실행은 도구가 없으면 실행하지 않는다', async () => {
  const rm = fresh();
  rm.milestones[0].tasks[0].tools = ['java', 'node'];
  let openedN = 0;
  const devHub = {
    problemsFor: (names) => (names.includes('java') ? [{ name: 'JDK (javac)', level: 'error', state: 'missing' }] : []),
    blockReason: (checks) => (checks.includes('test') ? 'Node.js이(가) 이 PC에 없어 test을(를) 실행할 수 없습니다' : ''),
    openModal: () => openedN++,
  };
  const h = setup({ roadmap: rm, devHub });
  await opened(h);
  const box = h.$('#rmcEnv');
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /이 작업에 필요한 도구: JDK \(javac\) \(없음\)/);
  await box.children[1].listeners.click();
  assert.equal(openedN, 1);
  // 진행 중 → 적용 → 검증 중에서 [테스트 실행]을 눌러도 실행하지 않고 이유를 보여 준다
  await h.click('implement');
  await h.ctx.window.onRoadmapApplied();
  await tick();
  await h.click('test');
  assert.equal(h.logs.runs, 0);
  assert.match(h.$('#rmcNote').textContent, /실행할 수 없습니다/);
  // 점검 결과가 바뀌면 다시 그린다
  devHub.problemsFor = () => [];
  h.ctx.window.onDevEnvChecked();
  assert.equal(box.hidden, true);
});
