'use strict';
// 화면 언어 설정 (v0.30.0) 단위 테스트:  npm test
// [쉽게 말하면] 설정 › 언어 값(자동 · 한국어 · English)을 본체와 확장이 검사해 받는지, 시작할 때 언어를 적용하는지,
// 화면 뼈대와 코드가 쓰는 문구 키가 사전에 모두 있는지 (없으면 화면에 키 이름이 그대로 보인다) 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/shared/i18n');
const ST = require('../src/shared/settings-transfer');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const dict = (lang, areas) => Object.assign({}, ...areas.map((a) => require(`../src/shared/i18n-${lang}${a === 'core' ? '' : `-${a}`}`)));

test('언어 설정값: auto · ko · en만, 그 밖은 auto / auto는 OS 언어가 한국어일 때만 한국어', () => {
  assert.deepEqual(i18n.LANG_PREFS, ['auto', 'ko', 'en']);
  for (const v of ['auto', 'ko', 'en']) assert.equal(i18n.normalizeLangPref(v), v);
  for (const v of [undefined, null, '', 'fr', 'KO', 1, {}]) assert.equal(i18n.normalizeLangPref(v), 'auto');
  assert.equal(i18n.detectLang('auto', 'ko'), 'ko');
  assert.equal(i18n.detectLang('auto', 'ko-KR'), 'ko');
  assert.equal(i18n.detectLang('auto', 'ja'), 'en');
  assert.equal(i18n.detectLang('ko', 'en-US'), 'ko');
});

function fakeSettings(prefs) {
  const on = new Map();
  let applied = 0;
  let saved = 0;
  require('../src/main/ipc/settings').register({
    ipcMain: { on: (ch, fn) => on.set(ch, fn), handle: () => {} },
    history: { setMax: () => {} },
    remote: {}, guard: {}, net: {}, shell: {},
    TIMEOUT_CHOICES: [20], MAX_CHOICES: [500],
    prefs: () => prefs,
    savePrefs: () => saved++,
    pushState: () => {},
    applyLang: () => (applied++, i18n.setLang(i18n.detectLang(prefs.lang, 'en-US'))),
    allServices: () => [], refreshRemote: () => {}, localChat: () => null, closeLocalPanel: () => {}, focusId: () => null, setFocusId: () => {},
    updater: () => null, shortcutList: () => [], librarySaver: { current: () => undefined }, readLibrary: () => ({}),
  });
  return { on, applied: () => applied, saved: () => saved };
}

test('본체 settings:set: 아는 언어 값만 저장하고 바로 적용, 화면의 첫 물음(i18n:lang)에는 지금 언어를 준다', () => {
  const prefs = { lang: 'ko', notify: {}, local: {} };
  const s = fakeSettings(prefs);
  const set = s.on.get('settings:set');
  i18n.setLang('ko');
  for (const bad of ['fr', 'EN', 1, null, { toString: () => 'en' }, ['en']]) set(null, { lang: bad });
  assert.equal(prefs.lang, 'ko');
  assert.equal(s.applied(), 0);
  set(null, { lang: 'en' });
  assert.equal(prefs.lang, 'en');
  assert.equal(s.applied(), 1);
  assert.equal(i18n.getLang(), 'en');
  const e = {};
  s.on.get('i18n:lang')(e);
  assert.equal(e.returnValue, 'en');
  set(null, { lang: 'en' }); // 같은 값이면 다시 적용하지 않는다
  assert.equal(s.applied(), 1);
  set(null, { lang: 'auto' }); // 가짜 OS 언어가 en-US
  assert.equal(i18n.getLang(), 'en');
  set(null, { lang: 'ko' });
  assert.equal(i18n.getLang(), 'ko');
  set(null, {}); // lang이 없으면 그대로
  assert.equal(prefs.lang, 'ko');
});

test('본체 main.js: 설정을 읽자마자(창을 만들기 전에) 언어를 적용하고, state에 lang · uiLang을 싣는다', () => {
  const main = read('src/main/main.js');
  assert.match(main, /lang: 'auto'/);
  assert.match(main, /i18n\.setLang\(i18n\.detectLang\(prefs\.lang, app\.getLocale\(\)\)\)/);
  assert.match(main, /prefs\.lang = i18n\.normalizeLangPref\(prefs\.lang\);\s+applyLang\(\);/);
  assert.ok(main.indexOf('loadPrefs();', main.indexOf('app.whenReady()')) < main.indexOf('createWindow();', main.indexOf('app.whenReady()')));
  assert.match(main, /lang: prefs\.lang,[^\n]*\n\s+uiLang: i18n\.getLang\(\),/);
  // 언어를 바꿔도 화면 · 패널을 다시 읽지 않는다 (패널 상태 · 프로젝트 작업이 사라지므로)
  assert.ok(!/webContents\.reload\(\)/.test(read('src/main/ipc/settings.js')));
  const pre = read('src/preload/preload.js');
  assert.match(pre, /ipcRenderer\.sendSync\('i18n:lang'\)/);
  assert.match(pre, /lang: uiLang,/);
});

test('화면: 시작할 때 host.lang으로 setLang한 뒤 apply, state.uiLang이 바뀌면 그 자리에서 다시 그린다', () => {
  const r = read('src/renderer/renderer.js');
  assert.ok(r.indexOf("MLA.i18n.setLang(host.lang || 'ko')") > 0 && r.indexOf("MLA.i18n.setLang(host.lang || 'ko')") < r.indexOf('MLA.i18n.apply(document)'));
  const c = read('src/renderer/renderer-compose.js');
  assert.match(c, /next\.uiLang !== shownLang/);
  assert.match(c, /function relocalize\(lang\) \{\s+shownLang = MLA\.i18n\.setLang\(lang\);\s+MLA\.i18n\.apply\(document\);/);
  assert.match(c, /new CustomEvent\('mla:lang'/);
  assert.ok(!c.includes('location.reload'));
  assert.match(read('src/renderer/library.js'), /addEventListener\('mla:lang'/);
  const html = read('src/renderer/index.html');
  assert.match(html, /<select id="langSelect">\s*<option value="auto" data-i18n="settings\.lang\.auto"><\/option>\s*<option value="ko" lang="ko">한국어<\/option>\s*<option value="en" lang="en">English<\/option>/);
  assert.match(read('src/renderer/renderer-views.js'), /host\.setSettings\(\{ lang: e\.target\.value \}\)/);
  // host.ui의 글은 getter로 옮겨 받는다 (펼치면 옛 언어로 굳는다)
  assert.match(r, /Object\.defineProperties\(UI, Object\.getOwnPropertyDescriptors\(host\.ui \|\| \{\}\)\)/);
});

test('크롬 확장: host · 사이드탭 · background가 저장된 언어 설정으로 setLang하고, host.setSettings가 값을 검사한다', () => {
  const host = read('extension/host.js');
  assert.match(host, /if \(MLA\.i18n\.LANG_PREFS\.includes\(lang\)\) \{\s+prefs\.lang = lang;\s+applyLang\(lang\);/);
  assert.match(host, /prefs\.lang = MLA\.i18n\.normalizeLangPref\(prefs\.lang\);\s+applyLang\(prefs\.lang\);/);
  assert.match(host, /chrome\.i18n\?\.getUILanguage\?\.\(\) \|\| navigator\.language/);
  assert.match(host, /lang: startLang,/);
  assert.match(host, /uiLang: MLA\.i18n\.getLang\(\),/);
  assert.ok(!host.includes('location.reload')); // 앱 탭을 다시 읽으면 AI 사이트 iframe이 모두 다시 열린다
  assert.match(host, /get pickNote\(\)/);
  const side = read('extension/sidepanel.js');
  assert.ok(side.indexOf('MLA.i18n.setLang(') > 0 && side.indexOf('MLA.i18n.setLang(') < side.indexOf('MLA.i18n.apply(document)'));
  assert.match(side, /if \(area === 'local' && changes\.prefs\) \{\s*setUiLang\(changes\.prefs\.newValue\?\.lang\);/);
  assert.match(side, /setUiLang\(saved\.prefs\?\.lang\);/);
  const bg = read('extension/background.js');
  assert.match(bg, /MLA\.i18n\.setLang\(uiLangOf\(r\?\.prefs\?\.lang\)\)/);
  assert.match(bg, /await langReady;\s+chrome\.contextMenus\.removeAll/);
});

test('background.js: 저장된 언어로 오른쪽 클릭 메뉴 이름을 만들고, 설정이 바뀌면 새 언어로 다시 만든다', async () => {
  const vm = require('vm');
  const ext = path.join(ROOT, 'extension');
  const ev = (list) => ({ addListener: (fn) => list?.push(fn) });
  const installed = [];
  const changed = [];
  let titles = [];
  const chrome = {
    i18n: { getUILanguage: () => 'ko' },
    action: { onClicked: ev() },
    runtime: { id: 'x', getURL: (p) => `chrome-extension://x/${p}`, onMessage: ev(), onConnect: ev(), onInstalled: ev(installed), onStartup: ev(), getContexts: async () => [] },
    contextMenus: { onClicked: ev(), removeAll: (cb) => ((titles = []), cb?.()), create: (m) => titles.push(m.title) },
    commands: { onCommand: ev() },
    sidePanel: { open: async () => {} },
    tabs: { onRemoved: ev() },
    storage: { session: { set: async () => {} }, local: { get: async () => ({ prefs: { lang: 'en' } }) }, onChanged: ev(changed) },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
    cookies: { onChanged: ev(), getAll: async () => [], set: async () => {}, remove: async () => {} },
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout, Date });
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx));
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), ctx);
  const tick = () => new Promise((r) => setTimeout(r, 5));
  installed.forEach((fn) => fn());
  await tick();
  const en = require('../src/shared/i18n-en-ext');
  const ko = require('../src/shared/i18n-ko-ext');
  assert.deepEqual(titles, [en['ext.menu.askSelection'], en['ext.menu.askPage'], en['ext.menu.sidePage']]);
  changed.forEach((fn) => fn({ prefs: { newValue: { lang: 'auto' } } }, 'local')); // 크롬 표시 언어가 ko
  await tick();
  assert.deepEqual(titles, [ko['ext.menu.askSelection'], ko['ext.menu.askPage'], ko['ext.menu.sidePage']]);
});

test('설정 옮기기: 언어도 함께 옮기고, 모르는 값은 버린다', () => {
  assert.ok(ST.KEYS.includes('lang'));
  assert.equal(ST.pickSettings({ lang: 'en' }).lang, 'en');
  assert.deepEqual(ST.cleanSettings({ lang: 'fr' }), {});
  assert.deepEqual(ST.cleanSettings({ lang: 'auto' }), { lang: 'auto' });
  assert.deepEqual(ST.diffSettings({ lang: 'ko' }, { lang: 'en' }), [{ key: 'lang', from: 'ko', to: 'en' }]);
  assert.match(read('src/renderer/settings-transfer-ui.js'), /'commitOffer', 'lang'\]/);
});

test('pageError: AI 사이트 안 코드가 준 실패 code를 지금 언어의 글로 바꾼다 (모르는 code · 성공 결과는 그대로)', () => {
  i18n.setLang('en');
  assert.equal(i18n.pageError({ ok: false, error: '입력창을 찾지 못했습니다', code: 'no-input' }).error, 'Could not find the input box');
  assert.equal(i18n.pageError({ ok: false, error: 'x', code: 'attach-empty', detail: '사이트가 파일을 받지 않았습니다', detailCode: 'attach-rejected' }).error, 'Nothing to send because attaching failed (The site did not accept the files)');
  assert.equal(i18n.pageError({ ok: false, error: 'x', code: 'attach-empty', detail: 'boom' }).error, 'Nothing to send because attaching failed (boom)');
  const done = i18n.pageError({ ok: true, via: 'button', attach: { ok: false, error: '사이트가 파일을 받지 않았습니다', code: 'attach-rejected', fallback: true } });
  assert.deepEqual(done, { ok: true, via: 'button', attach: { ok: false, error: 'The site did not accept the files', code: 'attach-rejected', fallback: true } });
  i18n.setLang('ko');
  assert.equal(i18n.pageError({ ok: false, error: 'x', code: 'no-text' }).error, '입력창에 글을 넣지 못했습니다');
  const other = { ok: false, error: '그대로', code: 'something-else' };
  assert.equal(i18n.pageError(other), other);
  for (const v of [null, undefined, true, 'x', { ok: true }]) assert.deepEqual(i18n.pageError(v), v);
  // 페이지 안 코드가 붙이는 code마다 사전에 글이 있고, 받는 쪽이 pageError를 거친다
  const codes = new Set([...`${read('src/shared/page.js')}${read('extension/content.js')}`.matchAll(/error: [^\n]*?, code: '([\w-]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...codes].sort(), ['attach-empty', 'attach-rejected', 'logged-out', 'needs-consent', 'no-files', 'no-input', 'no-text']); // logged-out · needs-consent: v0.38.2
  for (const c of codes) for (const lang of i18n.LANGS) assert.ok(i18n.strings[lang][`page.err.${c}`], `${lang}: ${c}`);
  assert.match(require('./helpers/ext-host').readHost(), /MLA\.i18n\.pageError\(await chrome\.tabs\.sendMessage/);
  assert.match(read('extension/sidepanel.js'), /job\.resolve\(MLA\.i18n\.pageError\(m\.result\)\)/);
  assert.match(read('src/main/injector.js'), /pageError\(await run\(wc, pageFocusInput, cfg\)\)/);
  assert.match(read('src/main/attach.js'), /res = pageError\(res\);/);
  // content.js는 사전 없이 돈다 (의존 모듈을 늘리지 않는다)
  assert.ok(!/MLA\.i18n|i18n-/.test(read('extension/content.js').replace(/\/\/[^\n]*/g, '')));
});

test('업데이트 안내의 [버튼 이름]은 두 언어 모두 실제 버튼 글과 같다', () => {
  for (const lang of i18n.LANGS) {
    const s = i18n.strings[lang];
    assert.ok(s['main.update.availableApp'].includes(`[${s['ui.h.updateDownload']}]`), lang);
    assert.ok(s['main.update.downloaded'].includes(`[${s['ui.h.updateInstall']}]`), lang);
  }
});

// ---------- 없는 키 찾기 ----------
// 화면 뼈대의 data-i18n* 키와, 코드가 t('키') · tr('키') · i18n.t('키')로 쓰는 글자 그대로의 키가 사전에 있는지.
// 없는 키는 화면에 키 이름이 그대로 나온다 (t()가 키를 돌려준다).
const htmlKeys = (html) => [...html.matchAll(/\sdata-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)].map((m) => m[1]);
const codeKeys = (src) =>
  [...src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').matchAll(/(?<![\w$.])(?:t|tr|T|MLA\.i18n\.t|i18n\.t)\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)].map((m) => m[1]);
const jsIn = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);

test('없는 키 없음: index.html · sidepanel.html의 data-i18n 키가 두 언어 사전에 모두 있다', () => {
  for (const f of ['src/renderer/index.html', 'extension/sidepanel.html']) {
    const keys = htmlKeys(read(f));
    assert.ok(keys.length > 10, f);
    for (const k of keys) for (const lang of i18n.LANGS) assert.ok(typeof i18n.strings[lang][k] === 'string', `${f}: ${lang} ${k}`);
  }
});

test('없는 키 없음: 화면 · 본체 · 확장 코드가 쓰는 t(\'키\')가 두 언어 사전에 모두 있다', () => {
  const files = [
    ...jsIn('src/renderer'),
    ...jsIn('src/main'),
    ...jsIn('src/main/ipc'),
    ...jsIn('src/shared').filter((f) => !/\/i18n(-|\.js)/.test(f)),
    'extension/host.js', 'extension/sidepanel.js', 'extension/background.js', 'extension/project-fs.js',
  ];
  let total = 0;
  for (const f of files) {
    for (const k of codeKeys(read(f))) {
      total++;
      for (const lang of i18n.LANGS) assert.ok(typeof i18n.strings[lang][k] === 'string', `${f}: ${lang} ${k}`);
    }
  }
  assert.ok(total > 800, String(total));
});

test('없는 키 없음: 사이드탭 · background는 읽어 들이는 사전(일부 영역)만으로 모든 글을 찾는다', () => {
  const areasOf = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1] || 'core'))];
  // 사이드탭: sidepanel.html이 읽는 사전 · 공통 모듈 · sidepanel.js
  const html = read('extension/sidepanel.html');
  const sideAreas = areasOf(html, /lib\/shared\/i18n-ko(?:-([a-z]+))?\.js/g);
  const side = dict('ko', sideAreas);
  const sideFiles = ['extension/sidepanel.js', ...[...html.matchAll(/<script src="lib\/(shared|renderer)\/([\w-]+\.js)"/g)].filter((m) => !m[2].startsWith('i18n')).map((m) => `src/${m[1]}/${m[2]}`)];
  for (const k of htmlKeys(html)) assert.ok(k in side, `sidepanel.html: ${k}`);
  // 공통 모듈에는 다른 화면(앱 탭 · 본체)에서만 쓰는 글도 있다 — 사이드탭이 실제로 부르는 것만 보려고 sidepanel.js와 뼈대만 엄격히 본다
  for (const k of codeKeys(read('extension/sidepanel.js'))) assert.ok(k in side, `sidepanel.js: ${k}`);
  assert.ok(sideFiles.length > 5);
  // background: importScripts로 읽는 사전
  const bg = read('extension/background.js');
  const bgDict = dict('ko', areasOf(bg, /lib\/shared\/i18n-ko(?:-([a-z]+))?\.js/g));
  for (const k of codeKeys(bg)) assert.ok(k in bgDict, `background.js: ${k}`);
  for (const k of [...bg.matchAll(/key: '([\w.]+)'/g)].map((m) => m[1])) assert.ok(k in bgDict, `background.js menu: ${k}`);
});

test('스크린샷 도구: MLA_SHOT_LANG=en으로 영어 화면을 찍을 수 있다', () => {
  assert.match(read('scripts/screenshots/preload-app.js'), /process\.env\.MLA_SHOT_LANG === 'en' \? 'en' : 'ko'/);
  assert.match(read('scripts/screenshots/preload-app.js'), /lang: LANG, uiLang: LANG/);
  assert.match(read('scripts/screenshots/preload-side.js'), /prefs: \{ lang: process\.env\.MLA_SHOT_LANG === 'en' \? 'en' : 'ko'/);
});

test('확인 창의 "보내지 않은 이유"는 지금 언어로, AI에게 보내는 목록은 한국어 그대로', () => {
  const p = read('src/renderer/project.js');
  assert.match(p, /listLines\(skipped, \(f\) => `- \$\{f\.path\}: \$\{skipText\(f\)\}`\)/);
  for (const code of ['binary', 'tooLarge', 'missing', 'unreadable', 'secret', 'badPath', 'notInProject', 'excluded']) {
    for (const lang of i18n.LANGS) assert.ok(i18n.strings[lang][`project.skipWhy.${code}`], `${lang} ${code}`);
  }
  // AI에게 보내는 글을 만드는 쪽은 reason(한국어)만 쓴다
  assert.match(read('src/shared/project-upload.js'), /\$\{s\.path\}: \$\{s\.reason\}/);
});

test('영어 문서(README.en.md · docs/en)가 가리키는 영어 그림이 모두 있다', () => {
  const refs = [...read('README.en.md').matchAll(/docs\/screenshots\/en\/([\w-]+\.png)/g), ...read('docs/en/guide.md').matchAll(/\.\.\/screenshots\/en\/([\w-]+\.png)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  for (const f of refs) assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'screenshots', 'en', f)), f);
});
