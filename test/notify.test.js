'use strict';
// OS 알림 (v0.25.0) 단위 테스트:  npm test
// [쉽게 말하면] 무엇을 언제 알릴지(앱을 보고 있으면 안 알림, 종류별 끄기), 알림 글에 질문 · 답변이 들어가지 않는지,
// rounds가 라운드 끝 · 한도 · 보내기 실패 · 종합 끝을 알리는지, Windows 앱 · 확장 · 설정 저장이 연결됐는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const N = require('../src/shared/notify');
const { createRounds } = require('../src/shared/rounds');
const { createOsNotifier } = require('../src/main/notifier');

const ROOT = path.join(__dirname, '..');

test('알림 설정: 기본은 모두 켬, 아는 종류의 true/false만 받는다', () => {
  assert.deepEqual(N.normalizePrefs(undefined), { round: true, limit: true, error: true, synth: true });
  assert.deepEqual(N.normalizePrefs({ round: false, synth: 'no', extra: false }), { round: false, limit: true, error: true, synth: true });
  assert.equal(N.cleanPatch(null), null);
  assert.equal(N.cleanPatch(['round']), null);
  assert.equal(N.cleanPatch({ round: 1, other: true }), null);
  assert.deepEqual(N.cleanPatch({ limit: false, other: true }), { limit: false });
});

test('알림 글: 개수와 서비스 이름만 (질문 · 답변 글 없음)', () => {
  const r = N.message({ kind: 'round', states: ['done', 'done', 'done', 'timeout'], question: '비밀 질문' });
  assert.equal(r.body, '답변 3/4개 완료 (시간 초과 1)');
  assert.ok(!JSON.stringify(r).includes('비밀'));
  assert.equal(N.message({ kind: 'round', states: ['done', 'done'] }).body, '답변 2개 완료');
  assert.equal(N.message({ kind: 'round', states: ['done', 'no-answer', 'error'] }).body, '답변 1/3개 완료 (답변 없음 1, 보내기 실패 1)');
  assert.equal(N.message({ kind: 'round', states: [] }), null);
  assert.equal(N.message({ kind: 'limit', names: ['Gemini', 'Gemini', 'Claude'] }).body, 'Gemini, Claude: 사용 한도에 걸린 것 같습니다');
  assert.equal(N.message({ kind: 'error', names: [] }), null);
  const an = N.message({ kind: 'synth', ok: true, judge: 'Claude', mode: 'analysis' });
  assert.equal(an.view, 'compare'); // 누르면 답변 비교 화면
  assert.match(an.body, /Claude.*분석/);
  assert.equal(N.message({ kind: 'synth', ok: false, judge: 'Claude', mode: 'text' }).view, null);
  assert.equal(N.message({ kind: 'nope' }), null);
});

function harness({ focused = false, prefs = {} } = {}) {
  const shown = [];
  const timers = [];
  const n = N.createNotifier({
    show: (m) => shown.push(m),
    isFocused: () => focused,
    prefs: () => prefs,
    setTimer: (fn) => timers.push(fn),
  });
  return { n, shown, timers, setFocused: (v) => (focused = v) };
}

test('알림: 앱을 보고 있으면 띄우지 않고, 끈 종류도 띄우지 않는다', () => {
  const h = harness({ focused: true });
  h.n.notify({ kind: 'round', states: ['done'] });
  assert.equal(h.shown.length, 0);
  h.setFocused(false);
  h.n.notify({ kind: 'round', states: ['done'] });
  assert.equal(h.shown.length, 1);
  const off = harness({ prefs: { round: false } });
  off.n.notify({ kind: 'round', states: ['done'] });
  assert.equal(off.shown.length, 0);
  const throws = N.createNotifier({ show: () => assert.fail('x'), isFocused: () => true, prefs: () => ({}) });
  throws.notify({ kind: 'synth', ok: true }); // 보고 있음
});

test('알림: 한도 · 보내기 실패는 잠깐 모아 서비스 이름을 하나로', () => {
  const h = harness();
  h.n.notify({ kind: 'error', name: 'Gemini' });
  h.n.notify({ kind: 'error', name: 'Claude' });
  h.n.notify({ kind: 'limit', name: 'Grok' });
  assert.equal(h.shown.length, 0);
  assert.equal(h.timers.length, 2); // 종류마다 타이머 하나
  h.timers.forEach((fn) => fn());
  assert.deepEqual(h.shown.map((m) => m.body), ['Gemini, Claude에 보내지 못했습니다', 'Grok: 사용 한도에 걸린 것 같습니다']);
  const off = harness({ prefs: { error: false } });
  off.n.notify({ kind: 'error', name: 'Gemini' });
  assert.equal(off.timers.length, 0);
});

function fakeRounds({ send = async () => ({ ok: true, via: 'button' }), autoSynth = false, checkLimit } = {}) {
  const events = [];
  const watchers = new Map();
  const rounds = createRounds({
    services: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'j', name: 'J' }],
    hasPanel: () => true,
    sendPrompt: send,
    snapshot: async () => ({ stop: false, count: 1, text: 'answer', md: 'answer' }),
    watch: (id, _b, _c, onState) => watchers.set(id, onState),
    sendPanel: () => {},
    sendSynthStatus: () => {},
    history: { add: () => 'h', setAnswer: () => {}, addSynth: () => {} },
    prefs: () => ({ autoSynth, synthTarget: 'j' }),
    checkLimit,
    notify: (e) => events.push(e),
    log: () => {},
  });
  return { rounds, events, watchers };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('rounds: 라운드의 답변이 모두 끝나면 한 번 알리고, 보내기 실패 · 한도도 알린다', async () => {
  const f = fakeRounds({
    send: async (id) => (id === 'b' ? { ok: false, error: 'x' } : { ok: true }),
    checkLimit: async (id, { scope }) => (id === 'a' && scope === 'page' ? 'You have reached your limit' : null),
  });
  await f.rounds.sendAll('q', ['a', 'b']);
  await tick();
  assert.deepEqual(f.events.map((e) => e.kind), ['error']);
  assert.equal(f.events[0].name, 'B');
  await f.watchers.get('a')('timeout', { chars: 0 });
  await tick();
  assert.deepEqual(f.events.map((e) => e.kind), ['error', 'limit', 'round']);
  assert.deepEqual(f.events[2].states.sort(), ['error', 'timeout']);
  await f.watchers.get('a')('done', { chars: 900 }); // 시간 초과 뒤 늦게 끝나도 다시 알리지 않음
  await tick();
  assert.equal(f.events.filter((e) => e.kind === 'round').length, 1);
});

test('rounds: 종합이 끝나면 알린다 (판정 AI 이름 · 모드)', async () => {
  const f = fakeRounds();
  await f.rounds.sendAll('q', ['a', 'b']);
  await f.watchers.get('a')('done', { chars: 900 });
  await f.watchers.get('b')('done', { chars: 900 });
  await tick();
  const r = await f.rounds.runSynth('j', 'manual', 'analysis');
  assert.equal(r.ok, true);
  await f.watchers.get('j')('done', { chars: 900 });
  await tick();
  const last = f.events.at(-1);
  assert.deepEqual({ kind: last.kind, ok: last.ok, judge: last.judge, mode: last.mode }, { kind: 'synth', ok: true, judge: 'J', mode: 'analysis' });
  const g = fakeRounds();
  await g.rounds.runSynth('j');
  assert.deepEqual(g.events.at(-1), { kind: 'synth', ok: false, judge: 'J', mode: 'text' }); // 아직 질문이 없음 → 실패 알림 (보고 있으면 notifier가 거른다)
});

test('Windows 앱 알림: 창을 보고 있으면 띄우지 않고, 누르면 창을 앞으로 + 화면 열기', () => {
  const made = [];
  class FakeNote {
    static isSupported() {
      return true;
    }
    constructor(o) {
      this.o = o;
      this.h = {};
      made.push(this);
    }
    on(ev, fn) {
      this.h[ev] = fn;
    }
    show() {
      this.shown = true;
    }
  }
  const win = { focused: true, min: false, calls: [], isDestroyed: () => false, isVisible: () => true, isMinimized() { return this.min; }, isFocused() { return this.focused; }, restore() { this.calls.push('restore'); }, show() { this.calls.push('show'); }, focus() { this.calls.push('focus'); } };
  const views = [];
  const n = createOsNotifier({ Notification: FakeNote, getWin: () => win, prefs: () => ({}), onClickView: (v) => views.push(v), icon: 'i.png' });
  n.notify({ kind: 'synth', ok: true, judge: 'Claude', mode: 'analysis' });
  assert.equal(made.length, 0); // 보고 있음
  win.focused = false;
  win.min = true;
  n.notify({ kind: 'synth', ok: true, judge: 'Claude', mode: 'analysis' });
  assert.equal(made.length, 1);
  assert.equal(made[0].shown, true);
  assert.equal(made[0].o.icon, 'i.png');
  made[0].h.click();
  assert.deepEqual(win.calls, ['restore', 'show', 'focus']);
  assert.deepEqual(views, ['compare']);
});

test('연결: main · host · 설정 저장 · 화면 · 확장 manifest', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const main = read('src/main/main.js');
  assert.match(main, /notify: \(event\) => notifier\.notify\(event\)/);
  assert.match(main, /normalizePrefs\(prefs, saved\)/);
  assert.match(read('src/shared/prefs.js'), /prefs\.notify = notify\.normalizePrefs\(prefs\.notify\)/);
  const host = read('extension/host.js');
  assert.match(host, /notify: \(event\) => notifier\.notify\(event\)/);
  assert.match(host, /chrome\.notifications\.onClicked/);
  assert.match(host, /MLA\.notify\.cleanPatch\(notify\)/);
  const html = read('src/renderer/index.html');
  for (const k of N.KINDS) assert.ok(html.includes(`data-notify="${k}"`), k);
  const m = JSON.parse(read('extension/manifest.json'));
  assert.ok(m.permissions.includes('notifications'));
  const app = read('extension/app.html');
  assert.ok(app.indexOf('lib/shared/i18n.js') < app.indexOf('lib/shared/notify.js'));
  assert.ok(app.indexOf('lib/shared/notify.js') < app.indexOf('host.js'));
});

test('ipc/settings: 알림 · 미리보기 설정은 검사해서 저장', () => {
  const on = new Map();
  const ipcMain = { on: (ch, fn) => on.set(ch, fn), handle: () => {} };
  const prefs = { notify: N.normalizePrefs({}), sendPreview: false, remoteSelectors: true };
  let saved = 0;
  require('../src/main/ipc/settings').register({
    ipcMain, history: { setMax() {} }, remote: {}, guard: {}, net: {}, shell: {}, TIMEOUT_CHOICES: [20], MAX_CHOICES: [500],
    prefs: () => prefs, savePrefs: () => saved++, pushState: () => {},
  });
  const set = on.get('settings:set');
  set(null, { notify: { round: false, evil: true }, sendPreview: true });
  assert.deepEqual(prefs.notify, { round: false, limit: true, error: true, synth: true });
  assert.equal(prefs.sendPreview, true);
  set(null, { notify: 'all', sendPreview: 'yes' });
  assert.deepEqual(prefs.notify, { round: false, limit: true, error: true, synth: true });
  assert.equal(prefs.sendPreview, true);
  assert.equal(saved, 2);
});
