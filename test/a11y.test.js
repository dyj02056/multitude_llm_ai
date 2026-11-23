'use strict';
// 접근성 (v0.30.0) 자동 검사:  npm test
// [쉽게 말하면] 화면 뼈대의 버튼 · 입력칸에 이름표가 붙어 있는지, 창(dialog)에 역할과 제목이 달렸는지,
// 글자색과 바탕색의 대비가 충분한지(WCAG AA 4.5:1), 키보드 포커스가 보이게 돼 있는지 확인합니다.
// 브라우저로 직접 써 보는 확인(키보드만으로 한 바퀴 · 화면 읽기 프로그램)은 docs/release-checklist.md에 있습니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('./helpers/a11y-scan');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAGES = ['src/renderer/index.html', 'extension/sidepanel.html'];
const SCRIPTS = [...fs.readdirSync(path.join(ROOT, 'src/renderer')).filter((f) => f.endsWith('.js')).map((f) => `src/renderer/${f}`), 'extension/sidepanel.js', 'extension/host.js'];

test('훑어보기 도우미: 이름 없는 컨트롤 · 기호만 있는 버튼 · 모자란 창을 잡아낸다', () => {
  const r = A.scan(`
    <button id="a"></button><button id="b">↻</button><button id="c" data-i18n-aria="k">↻</button><button id="d" data-i18n="k"></button>
    <input id="e" /><label for="f">F</label><input id="f" /><label><input id="g" type="checkbox" /> G</label><input id="h" placeholder="p" />
    <input type="file" id="i" hidden /><select id="j" title="t"></select><textarea id="k" aria-label="x"></textarea><button id="l"><span data-i18n="k"></span></button>
    <div id="m1" class="modal" hidden>
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="t1"><b id="t1"></b></div></div>
    <div id="m2" class="modal" hidden>
      <div class="modal-box"><b id="t2"></b></div></div>
    <div id="m3" class="modal" hidden>
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="nope"></div></div>
    <span id="s" aria-live="polite"></span>`);
  const by = Object.fromEntries(r.controls.map((c) => [c.id, c]));
  assert.deepEqual(r.controls.filter((c) => !c.named).map((c) => c.id), ['a', 'e', 'h']);
  assert.deepEqual(r.controls.filter((c) => c.symbolOnly).map((c) => c.id), ['b']);
  assert.ok(!('i' in by)); // 숨긴 파일 고르기 칸은 세지 않는다
  assert.deepEqual(r.dialogs, [{ id: 'm1', ok: true }, { id: 'm2', ok: false }, { id: 'm3', ok: false }]);
  assert.deepEqual(r.live, ['s']);
});

test('화면 뼈대: 모든 버튼 · 입력칸 · 고르기 칸에 이름이 있고, 기호만 있는 버튼에는 화면 읽기 이름이 있다', () => {
  const code = SCRIPTS.map(read).join('\n');
  for (const page of PAGES) {
    const r = A.scan(read(page));
    assert.ok(r.controls.length >= 10, page);
    assert.deepEqual(r.controls.filter((c) => !c.named).map((c) => `${c.line}: ${c.raw}`), [], page);
    assert.deepEqual(r.controls.filter((c) => c.symbolOnly).map((c) => `${c.line}: ${c.raw}`), [], page);
    // 글을 스크립트가 넣는다고 표시한 버튼(data-label-by-script)은 정말 그 id를 찾아 쓰는 코드가 있어야 한다
    for (const c of r.controls.filter((x) => / data-label-by-script/.test(x.raw))) {
      assert.ok(c.id && code.includes(`$('#${c.id}')`), `${page}: #${c.id}`);
    }
  }
});

test('창(dialog): role="dialog" · aria-modal · 제목으로 이름표, 그리고 포커스를 가두고 돌려주는 코드가 붙어 있다', () => {
  const html = read('src/renderer/index.html');
  const r = A.scan(html);
  assert.deepEqual(r.dialogs.map((d) => d.id).sort(), ['debateModal', 'diagModal', 'envModal', 'interjectModal', 'onboardModal', 'patchModal', 'previewModal', 'roadmapModal', 'selModal', 'transferModal', 'workflowModal']);
  for (const d of r.dialogs) assert.ok(d.ok, d.id);
  assert.equal((html.match(/class="modal"/g) || []).length, r.dialogs.length); // 훑어보기가 놓친 창이 없다
  const js = read('src/renderer/a11y.js');
  assert.match(js, /querySelectorAll\('\.modal'\)/);
  assert.match(js, /attributeFilter: \['hidden'\]/);
  assert.match(js, /e\.key !== 'Tab'/);
  assert.match(js, /prev\.focus\(/);
  // 화면 스크립트 맨 끝에 읽히고, 크롬 확장에도 들어간다
  assert.ok(html.indexOf('src="a11y.js"') > html.indexOf('src="settings-transfer-ui.js"'));
  assert.ok(html.indexOf('src="a11y.js"') > html.indexOf('src="onboarding.js"')); // 첫 사용 안내 창(v0.31.0)도 포커스 관리를 받는다
  assert.match(read('scripts/build-extension.js'), /'a11y\.js'/);
  assert.match(read('extension/app.html'), /lib\/renderer\/a11y\.js/);
});

test('a11y.js: 창이 열리면 포커스를 안으로, Tab은 창 안에서 돌고, 닫히면 원래 자리로 돌려준다', async () => {
  const vm = require('vm');
  // 아주 작은 가짜 DOM: 요소는 { hidden, focus(), contains() }만 흉내 낸다
  let active = null;
  const mk = (name, parent) => {
    const el = { name, parent, isConnected: true, offsetWidth: 10, attrs: {}, listeners: {}, focus: () => (active = el), hasAttribute: (k) => k in el.attrs, getClientRects: () => [1] };
    el.contains = (x) => {
      for (let p = x; p; p = p.parent) if (p === el) return true;
      return false;
    };
    el.addEventListener = (t, fn) => (el.listeners[t] = fn);
    return el;
  };
  const opener = mk('opener');
  const modal = mk('modal');
  const box = mk('box', modal);
  const first = mk('first', box);
  const last = mk('last', box);
  modal.hidden = true;
  modal.querySelector = () => box;
  box.querySelectorAll = () => [first, last];
  Object.defineProperty(box, 'tabIndex', { set: (v) => (box.attrs.tabindex = v) });
  let observed = null;
  const body = mk('body');
  const ctx = vm.createContext({
    document: { body, querySelectorAll: () => [modal], get activeElement() { return active; } },
    MutationObserver: class { constructor(fn) { observed = fn; } observe() {} },
    setTimeout,
  });
  vm.runInContext(read('src/renderer/a11y.js'), ctx);
  const tick = () => new Promise((r) => setTimeout(r, 5));
  active = opener;
  modal.hidden = false;
  observed();
  await tick();
  assert.equal(active, box); // 창 상자로 (제목을 읽는다)
  assert.equal(box.attrs.tabindex, -1);
  const key = (shiftKey) => {
    const e = { key: 'Tab', shiftKey, prevented: false, preventDefault: () => (e.prevented = true) };
    modal.listeners.keydown(e);
    return e.prevented;
  };
  assert.equal(key(false), false); // 상자에서 Tab → 브라우저가 첫 요소로 (가로채지 않는다)
  active = last;
  assert.equal(key(false), true);
  assert.equal(active, first); // 끝에서 Tab → 처음으로
  assert.equal(key(true), true);
  assert.equal(active, last); // 처음에서 Shift+Tab → 끝으로
  active = first;
  assert.equal(key(false), false); // 가운데에서는 그대로
  modal.hidden = true;
  observed();
  assert.equal(active, opener); // 닫히면 열기 전 자리로
  // 여는 코드가 스스로 포커스를 줬으면 건드리지 않는다
  active = opener;
  modal.hidden = false;
  observed();
  active = last;
  await tick();
  assert.equal(active, last);
});

test('상태 글은 바뀔 때 읽어 준다 (aria-live): 보내기 안내 · 준비 상태 · 창의 상태 줄 · 사이드탭 안내', () => {
  const app = A.scan(read('src/renderer/index.html')).live;
  for (const id of ['sendHint', 'statusLine', 'patchStatus', 'previewStatus', 'debateStatus', 'transferModalStatus', 'transferStatus']) assert.ok(app.includes(id), id);
  assert.ok(A.scan(read('extension/sidepanel.html')).live.includes('spHint'));
});

test('색 대비 (WCAG AA): 글자색 이름표가 세 바탕색 모두에서 4.5:1 이상', () => {
  assert.equal(A.contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(A.contrast('#777777', '#ffffff').toFixed(2), '4.48'); // 알려진 값 (AA에 살짝 못 미침)
  const tok = A.cssTokens(read('src/renderer/styles.css'));
  const bgs = ['--bg', '--bg-2', '--field-hover'];
  const texts = ['--text', '--text-2', '--muted', '--bright', '--accent', '--accent-text', '--ok', '--warn', '--err', '--ok-text', '--warn-text', '--err-text'];
  for (const k of [...bgs, ...texts]) assert.match(tok[k] || '', /^#[0-9a-f]{6}$/, k);
  for (const t of texts) for (const b of bgs) assert.ok(A.contrast(tok[t], tok[b]) >= 4.5, `${t} ${tok[t]} on ${b} ${tok[b]} = ${A.contrast(tok[t], tok[b]).toFixed(2)}`);
  // 채운 단추(.primary): 바탕 --text 위에 글자 --bg
  assert.ok(A.contrast(tok['--bg'], tok['--text']) >= 4.5);
  // 사이드탭 · 확장 전용 CSS는 같은 이름표를 쓴다 (따로 정한 글자색이 없다)
  for (const f of ['extension/sidepanel.css', 'extension/ext.css']) assert.ok(!/(^|[;{\s])color:\s*#/m.test(read(f)), f);
});

test('키보드: 포커스 테두리가 보이고, 버튼이 아닌 누르는 요소는 Tab · Enter로 닿는다', () => {
  const css = read('src/renderer/styles.css');
  assert.match(css, /button:focus-visible \{ outline: 2px solid var\(--accent\)/);
  assert.match(css, /input\[type="checkbox"\]:focus-visible, input\[type="radio"\]:focus-visible, summary:focus-visible, a:focus-visible, \[tabindex\]:focus-visible \{ outline: 2px solid var\(--accent\)/);
  assert.match(css, /#prompt:focus-visible \{ border-color: var\(--accent\)/);
  assert.match(read('extension/sidepanel.css'), /#spPrompt:focus-visible \{ border-color: var\(--accent\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  // outline을 끄는 규칙은 대신 보이는 표시(테두리색 · 안쪽 선)를 준다
  for (const m of css.matchAll(/([^\n{}]+)\{[^}]*outline: none[^}]*\}/g)) {
    const sel = m[1].trim();
    if (sel === '.modal-box:focus') continue; // 창을 열 때 잠깐 받는 포커스 (a11y.js)
    assert.ok(/border-color: var\(--accent\)/.test(m[0]) || css.includes(`${sel.replace(':focus', ':focus-visible')} {`), sel);
  }
  // 클릭만 되던 줄 · 이름 · 칸
  const r = read('src/renderer/renderer.js');
  assert.match(r, /function keyClick\(el, onClick, role\) \{\s+el\.tabIndex = 0;/);
  assert.match(read('src/renderer/library.js'), /keyClick\(row, onClick\)/);
  assert.match(read('src/renderer/library-presets.js'), /keyClick\(r, pick\)/);
  assert.match(read('src/renderer/renderer-views.js'), /keyClick\(c, jump\)/);
  assert.match(read('src/renderer/history-view.js'), /row\.tabIndex = 0;/);
  // 기호만 있는 버튼을 만드는 도우미는 설명을 aria-label로도 단다
  assert.match(r, /if \(title && label && !\/\[\\p\{L\}\\p\{N\}\]\/u\.test\(label\)\) b\.setAttribute\('aria-label', title\);/);
  assert.match(read('extension/sidepanel.js'), /b\.setAttribute\('aria-label', title\);/);
  assert.match(r, /b\.dataset\.i18nAria = key;/);
});

test('표에는 머리줄이 있다 (스크립트가 만드는 표 포함)', () => {
  const tables = [...read('src/renderer/index.html').matchAll(/<table id="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tables.sort(), ['diagParts', 'diagTable', 'helpTable', 'speedTable', 'statsTable']);
  const views = read('src/renderer/renderer-views.js');
  assert.match(views, /helpHeadRow\.append\(Object\.assign\(document\.createElement\('th'\)/); // helpTable
  assert.match(views, /for \(const t of cols\) head\.append\(Object\.assign\(document\.createElement\('th'\)/); // statsTable
  assert.match(read('src/renderer/recommend-ui.js'), /head\.append\(Object\.assign\(document\.createElement\('th'\)/); // speedTable
  const r = read('src/renderer/renderer.js');
  assert.match(r, /row\(\[t\('ui\.diag\.item'\), t\('ui\.diag\.state'\)\], 'th'\)/); // diagParts
  assert.match(r, /head\.append\(Object\.assign\(document\.createElement\('th'\), \{ textContent: label \}\)\)/); // diagTable
});

test('문서: 접근성 · 출시 전 확인 목록이 있고, README와 setup에서 이어진다', () => {
  const acc = read('docs/accessibility.md');
  for (const word of ['WCAG', '4.5', '키보드', 'aria-live', '알려진']) assert.ok(acc.includes(word), word);
  const list = read('docs/release-checklist.md');
  for (const word of ['npm test', 'check:ext', 'selectors:probe', 'Ollama', '자동 업데이트', 'v0.23', '키보드', '언어']) assert.ok(list.includes(word), word);
  assert.ok(read('README.md').includes('docs/release-checklist.md'));
  assert.ok(read('docs/setup.md').includes('release-checklist.md'));
});
