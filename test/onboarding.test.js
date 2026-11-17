'use strict';
// 첫 사용 안내 (v0.31.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 새로 설치한 사람에게만 한 번 뜨고, 예전부터 쓰던 사람 · 이미 본 사람에게는 뜨지 않는지
//   - 걸음마다 두 언어의 제목 · 본문이 있는지
//   - 창을 닫으면 "봤음"을 저장하고, 설정 화면에서 다시 볼 수 있는지 (화면 코드를 가짜 화면으로 돌려 본다)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OB = require('../src/shared/onboarding');
const i18n = require('../src/shared/i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('보여 줄지: 처음 설치만 false, 예전 설정(항목 없음) · 본 사람은 true', () => {
  assert.equal(OB.wasOnboarded(null), false);
  assert.equal(OB.wasOnboarded(undefined), false);
  assert.equal(OB.wasOnboarded('x'), false);
  assert.equal(OB.wasOnboarded({ layout: 'grid' }), true); // v0.30.0까지 쓰던 설정
  assert.equal(OB.wasOnboarded({ onboarded: false }), false); // 설치하고 아직 안 본 사람
  assert.equal(OB.wasOnboarded({ onboarded: true }), true);
});

test('띄울 때: 채팅의 패널 화면 · 아직 안 봄 · 이번에 띄운 적 없음', () => {
  const s = { mode: 'chat', chatView: 'panels', onboarded: false };
  assert.equal(OB.shouldShow(s, false), true);
  assert.equal(OB.shouldShow(s, true), false);
  assert.equal(OB.shouldShow({ ...s, onboarded: true }, false), false);
  assert.equal(OB.shouldShow({ ...s, onboarded: undefined }, false), false); // 값이 없으면(스크린샷 도구 · 예전 host) 띄우지 않는다
  assert.equal(OB.shouldShow({ ...s, chatView: 'compare' }, false), false);
  assert.equal(OB.shouldShow({ ...s, mode: 'pick' }, false), false);
  assert.equal(OB.shouldShow(null, false), false);
});

test('걸음: 네 개, 두 언어의 제목 · 본문이 있고, 번호는 범위 안에서만 움직인다', () => {
  assert.deepEqual(OB.STEPS.map((s) => s.id), ['ask', 'compare', 'synth', 'more']);
  for (const lang of i18n.LANGS) {
    for (const s of OB.STEPS) {
      for (const f of ['title', 'body']) assert.ok(i18n.strings[lang][`ui.onboard.${s.id}.${f}`], `${lang} ${s.id}.${f}`);
      assert.ok(s.keys.length >= 1);
    }
  }
  assert.equal(OB.stepAt(0, 1), 1);
  assert.equal(OB.stepAt(0, -1), 0);
  assert.equal(OB.stepAt(3, 1), 3);
  assert.equal(OB.stepAt(undefined, 1), 1);
});

test('설정 저장: 본체 · 확장이 onboarded를 읽고(처음 설치 규칙) state에 싣고 true/false만 받는다', () => {
  const main = read('src/main/main.js');
  assert.match(main, /prefs\.onboarded = wasOnboarded\(saved\);/);
  assert.match(main, /onboarded: prefs\.onboarded,/);
  assert.match(read('src/main/ipc/settings.js'), /if \(typeof onboarded === 'boolean'\) prefs\.onboarded = onboarded;/);
  const host = read('extension/host.js');
  assert.match(host, /prefs\.onboarded = MLA\.onboarding\.wasOnboarded\(savedPrefs\);/);
  assert.match(host, /onboarded: prefs\.onboarded,/);
  assert.match(host, /if \(typeof onboarded === 'boolean'\) prefs\.onboarded = onboarded;/);
  // 설정 옮기기 파일에는 넣지 않는다 (새 PC에서는 새로 보는 편이 맞다)
  assert.ok(!require('../src/shared/settings-transfer').KEYS?.includes('onboarded'));
});

// ---------- 화면 코드(renderer/onboarding.js)를 가짜 화면으로 ----------
function fakePage(state) {
  const els = new Map();
  const mk = (id) => {
    const e = { id, hidden: id === 'onboardModal', textContent: '', disabled: false, children: [], listeners: {}, focused: false };
    e.addEventListener = (type, fn) => (e.listeners[type] = fn);
    e.replaceChildren = (...kids) => (e.children = kids);
    e.focus = () => (e.focused = true);
    return e;
  };
  const $ = (sel) => {
    const id = sel.slice(1);
    if (!els.has(id)) els.set(id, mk(id));
    return els.get(id);
  };
  const calls = { settings: [], views: [] };
  const node = (tag) => {
    const n = { tag, className: '', textContent: '', kids: [] };
    n.append = (...k) => n.kids.push(...k);
    return n;
  };
  const docListeners = {};
  const ctx = {
    MLA: { onboarding: OB },
    state,
    $,
    t: (key, vars) => i18n.t(key, vars),
    host: {
      setSettings: (o) => {
        calls.settings.push(o);
        Object.assign(ctx.state, o); // 본체가 저장하고 state를 다시 보낸 것처럼
      },
      setView: (v) => {
        calls.views.push(v);
        ctx.state.chatView = v;
      },
    },
    document: {
      createElement: node,
      addEventListener: (type, fn) => (docListeners[type] = fn),
      querySelector: () => (ctx.otherModalOpen ? {} : null),
    },
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('src/renderer/onboarding.js'), ctx);
  return { ctx, $, calls, tick: () => ctx.window.onOnboardState(), docListeners };
}

test('화면: 처음이면 패널을 치우고 띄우고, 다음 · 이전으로 넘기고, 끝내면 "봤음"을 저장하고 패널로 돌아간다', () => {
  const p = fakePage({ mode: 'chat', chatView: 'panels', onboarded: false });
  p.tick();
  assert.equal(p.$('#onboardModal').hidden, false);
  assert.deepEqual(p.calls.views, ['dialog']); // Windows 앱: 패널 웹페이지를 치워야 창이 보인다
  assert.equal(p.$('#onboardSub').textContent, '1 / 4');
  assert.equal(p.$('#onboardPrev').disabled, true);
  assert.equal(p.$('#onboardNext').textContent, '다음');
  assert.equal(p.$('#onboardNext').focused, true);
  assert.equal(p.$('#onboardBody').children[1].textContent, '한 번에 묻기');
  p.tick(); // 'dialog' 화면으로 바뀐 state가 왔다
  p.$('#onboardNext').listeners.click();
  p.$('#onboardNext').listeners.click();
  p.$('#onboardPrev').listeners.click();
  assert.equal(p.$('#onboardSub').textContent, '2 / 4');
  p.$('#onboardNext').listeners.click();
  p.$('#onboardNext').listeners.click();
  assert.equal(p.$('#onboardSub').textContent, '4 / 4');
  assert.equal(p.$('#onboardNext').textContent, '시작하기');
  p.$('#onboardNext').listeners.click(); // 마지막 걸음의 [시작하기]
  assert.equal(p.$('#onboardModal').hidden, true);
  assert.equal(JSON.stringify(p.calls.settings), JSON.stringify([{ onboarded: true }]));
  assert.deepEqual(p.calls.views, ['dialog', 'panels']);
  p.tick();
  assert.equal(p.$('#onboardModal').hidden, true); // 다시 뜨지 않는다
});

test('화면: 건너뛰기 · Esc도 "봤음"으로, 다른 화면으로 떠나면 닫고, 다른 창이 떠 있으면 끼어들지 않는다', () => {
  const skip = fakePage({ mode: 'chat', chatView: 'panels', onboarded: false });
  skip.tick();
  skip.$('#onboardSkip').listeners.click();
  assert.equal(JSON.stringify(skip.calls.settings), JSON.stringify([{ onboarded: true }]));

  const esc = fakePage({ mode: 'chat', chatView: 'panels', onboarded: false });
  esc.tick();
  let stopped = false;
  esc.$('#onboardModal').listeners.keydown({ key: 'Escape', stopPropagation: () => (stopped = true) });
  assert.equal(stopped, true);
  assert.equal(esc.$('#onboardModal').hidden, true);
  assert.equal(JSON.stringify(esc.calls.settings), JSON.stringify([{ onboarded: true }]));

  const away = fakePage({ mode: 'chat', chatView: 'panels', onboarded: false });
  away.tick();
  away.tick(); // dialog 화면 확인
  away.ctx.state.chatView = 'compare'; // 단축키로 비교 화면에 갔다
  away.tick();
  assert.equal(away.$('#onboardModal').hidden, true);
  assert.deepEqual(away.calls.views, ['dialog']); // 패널로 되돌리지 않는다 (이미 다른 화면)

  const busy = fakePage({ mode: 'chat', chatView: 'panels', onboarded: false });
  busy.ctx.otherModalOpen = true;
  busy.tick();
  assert.equal(busy.$('#onboardModal').hidden, true);

  const old = fakePage({ mode: 'chat', chatView: 'panels', onboarded: true });
  old.tick();
  assert.equal(old.$('#onboardModal').hidden, true);
});

test('화면: 설정의 [다시 보기]는 이미 본 사람에게도 띄우고, 설정을 다시 쓰지 않는다', () => {
  const p = fakePage({ mode: 'chat', chatView: 'help', onboarded: true });
  p.$('#onboardAgain').listeners.click();
  assert.equal(p.$('#onboardModal').hidden, false);
  assert.deepEqual(p.calls.views, []); // 설정 화면에는 패널이 없어 화면을 바꾸지 않는다
  p.$('#onboardSkip').listeners.click();
  assert.equal(JSON.stringify(p.calls.settings), JSON.stringify([]));
  assert.equal(p.$('#onboardModal').hidden, true);
  // 화면 뼈대 · 조립
  const html = read('src/renderer/index.html');
  assert.match(html, /id="onboardModal" class="modal" hidden>\s*<div class="modal-box onboard-box" role="dialog" aria-modal="true" aria-labelledby="onboardTitle">/);
  assert.match(html, /<button id="onboardAgain" data-i18n="ui\.onboard\.againBtn"><\/button>/);
  assert.ok(html.indexOf('shared/onboarding.js') < html.indexOf('src="onboarding.js"'));
  assert.match(read('scripts/build-extension.js'), /'onboarding\.js'/);
  assert.match(read('src/renderer/renderer-compose.js'), /window\.onOnboardState\?\.\(\);/);
});
