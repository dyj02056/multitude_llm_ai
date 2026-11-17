'use strict';

// v0.38.2 (크롬 웹 스토어 "Sign in & send" 반려 대응):
// 로그인 탭에서 로그인하면 패널이 저절로 다시 열림 · 이용 동의 화면 안내 · 보내기 실패 원인(로그아웃 · 동의) 알림

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SERVICES, servicesForCookieDomains } = require('../src/shared/services');
const { pageNeedsConsent } = require('../src/shared/page');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('servicesForCookieDomains: 쿠키 도메인 → 서비스 (상위 · 하위 도메인, 점 붙은 값, 최상위 도메인만은 무시)', () => {
  assert.deepEqual(servicesForCookieDomains(['.google.com']), ['gemini']);
  assert.deepEqual(servicesForCookieDomains(['chatgpt.com']), ['chatgpt']);
  assert.deepEqual(servicesForCookieDomains(['auth.qwen.ai']), ['qwen']);
  assert.deepEqual(servicesForCookieDomains(['www.perplexity.ai']), ['perplexity']);
  assert.deepEqual(servicesForCookieDomains(['CLAUDE.AI']), ['claude']);
  assert.deepEqual(servicesForCookieDomains(['com', '.ai', '', null, 3]), []);
  assert.deepEqual(servicesForCookieDomains('chatgpt.com'), []);
  assert.deepEqual(servicesForCookieDomains(['example.com']), []);
});

test('Duck.ai만 이용 동의 단서(consent)를 가지고, 문구 정규식이 올바르다', () => {
  const withConsent = SERVICES.filter((s) => s.consent).map((s) => s.id);
  assert.deepEqual(withConsent, ['duckai']);
  const re = new RegExp(SERVICES.find((s) => s.id === 'duckai').consent.text, 'i');
  for (const ok of ['I Agree', 'Agree and Continue', 'Get Started', '동의하고 계속하기', '동의합니다']) assert.ok(re.test(ok), ok);
  for (const no of ['물어보기', 'Send', '개인정보 보호정책 및 서비스 약관', 'I agree to nothing']) assert.ok(!re.test(no), no);
});

// pageNeedsConsent는 화면(DOM)을 읽는다. 필요한 만큼만 흉내 낸 가짜 화면으로 확인한다.
function fakePage({ buttons = [], inputVisible = true }) {
  const el = ({ text, shown = true, dialog = false }) => ({
    innerText: text,
    offsetWidth: shown ? 10 : 0,
    offsetHeight: shown ? 10 : 0,
    getClientRects: () => (shown ? [1] : []),
    getAttribute: () => null,
    closest: () => (dialog ? {} : null),
  });
  const btns = buttons.map(el);
  const input = el({ text: '', shown: inputVisible });
  globalThis.document = { querySelectorAll: (sel) => (sel === 'textarea' ? [input] : sel.includes('button') ? btns : []) };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
}
const DUCK = SERVICES.find((s) => s.id === 'duckai');
const duckCfg = { consent: DUCK.consent, input: ['textarea'] };

test('pageNeedsConsent: 동의 버튼이 대화 상자 안에 있거나 입력창이 안 보일 때만 → 버튼 문구', (t) => {
  t.after(() => {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  });
  fakePage({ buttons: [{ text: '물어보기' }, { text: '개인정보 보호정책 및 서비스 약관' }] }); // 지금(2026-11) Duck.ai 첫 화면 — 동의 화면 없음
  assert.equal(pageNeedsConsent(duckCfg), false);
  fakePage({ buttons: [{ text: 'I Agree', dialog: true }] });
  assert.equal(pageNeedsConsent(duckCfg), 'I Agree');
  fakePage({ buttons: [{ text: 'Get Started' }], inputVisible: false });
  assert.equal(pageNeedsConsent(duckCfg), 'Get Started');
  fakePage({ buttons: [{ text: '확인' }] }); // 대화 상자 밖 + 입력창 보임 → 평범한 버튼이다
  assert.equal(pageNeedsConsent(duckCfg), false);
  fakePage({ buttons: [{ text: 'I Agree', dialog: true, shown: false }] }); // 숨은 버튼
  assert.equal(pageNeedsConsent(duckCfg), false);
  assert.equal(pageNeedsConsent({ input: ['textarea'] }), false); // consent 단서가 없는 서비스
  assert.equal(pageNeedsConsent({ consent: { text: '(' }, input: [] }), false); // 잘못된 정규식도 안전하게
});

test('page.js의 동의 확인은 읽기만 한다 (누르지 않음 — 이용 약관 동의는 사용자가 직접)', () => {
  const src = pageNeedsConsent.toString();
  assert.doesNotMatch(src, /\.click\(|dispatchEvent|submit/);
});

test('content.js: 보내기 전 동의 화면 · 입력창이 없을 때 로그아웃을 code로 알리고, 동의 확인 요청을 받는다', () => {
  const src = read('extension/content.js');
  assert.match(src, /cfg\.consent && pageNeedsConsent\(cfg\)\) return \{ ok: false, [^}]*code: 'needs-consent' \}/);
  assert.match(src, /cfg\.loggedOut && pageIsLoggedOut\(cfg\)\) return \{ ok: false, [^}]*code: 'logged-out' \}/);
  assert.match(src, /'mla:consent': \(\{ cfg \}\) => pageNeedsConsent\(cfg\)/);
  for (const f of ['extension/host.js', 'extension/sidepanel.js']) {
    assert.match(read(f), /loggedOut: svc\.loggedOut \|\| null/, f);
    assert.match(read(f), /consent: svc\.consent \|\| null/, f);
  }
});

test('background.js: AI 사이트 쿠키가 바뀌면 도메인 이름만 화면에 알린다 (쿠키 값은 보내지 않음)', () => {
  const src = read('extension/background.js');
  assert.match(src, /chrome\.runtime\.sendMessage\(\{ type: 'mla:cookieChanged', domains \}\)/);
  assert.doesNotMatch(src, /mla:cookieChanged'[^)]*value/);
});

test('앱 탭 · 사이드탭: "로그인 탭"을 누른 패널만, 연 직후 · 너무 잦은 경우를 빼고 자동으로 다시 연다', () => {
  const panels = read('extension/host-panels.js');
  const side = read('extension/sidepanel.js');
  for (const [name, src] of [['host-panels', panels], ['sidepanel', side]]) {
    assert.match(src, /msg\?\.type !== 'mla:cookieChanged' \|\| sender\.id !== chrome\.runtime\.id \|\| sender\.tab/, name);
    assert.match(src, /servicesForCookieDomains\(msg\.domains\)/, name);
    assert.match(src, /p\.loginArmedUntil < now \|\| now - p\.loadedAt < AUTO_SETTLE_MS \|\| now - p\.autoAt < AUTO_GAP_MS/, name);
    assert.match(src, /if \(!out\) p\.loginArmedUntil = 0/, name);
  }
  assert.match(panels, /visibilitychange/);
  assert.match(read('extension/host.js'), /action === 'login'\) \{\s+[^\n]*\n\s+X\.armLogin\(pid\);/);
  assert.match(side, /p\.loginArmedUntil = Date\.now\(\) \+ LOGIN_ARM_MS;\s+chrome\.tabs\.create/);
});

test('새 안내 글: 두 언어 모두 있고, "↻를 누르세요" 안내는 자동 연결 안내로 바뀌었다', () => {
  for (const lang of i18n.LANGS) {
    const s = i18n.strings[lang];
    for (const k of ['page.err.logged-out', 'page.err.needs-consent', 'ui.login.consent', 'ext.side.consentNeeded']) assert.ok(s[k], `${lang}: ${k}`);
  }
  i18n.setLang('en');
  assert.match(i18n.t('ext.side.loginTabTitle'), /reconnects by itself/);
  assert.match(i18n.t('ext.host.hintChat'), /Duck\.ai works without sign-in/);
  assert.equal(i18n.pageError({ ok: false, error: 'x', code: 'logged-out' }).error, i18n.t('page.err.logged-out'));
  i18n.setLang('ko');
  assert.match(i18n.t('ext.side.loginTabTitle'), /저절로 다시 연결/);
});
