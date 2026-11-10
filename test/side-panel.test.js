'use strict';

// 사이드탭 모드 (v0.19.0): 고른 모델 정리 · 켜고 끄기 · 비율 · 연결 이름 · 페이지 맥락 · 보낼 글 · 확장 설정(매니페스트)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SP = require('../src/shared/side-panel');
const W = require('../src/shared/web-ask');
const { SERVICES } = require('../src/shared/services');

const LOCAL = { id: 'local', kind: 'local' };

test('고른 모델: 웹 서비스만 · 겹치지 않게 · 최대 2개 · 비면 Gemini', () => {
  assert.deepEqual(SP.normalizeSelected(['claude', 'claude', 'grok', 'chatgpt'], SERVICES), ['claude', 'grok']);
  assert.deepEqual(SP.normalizeSelected(['nope', 'local'], [...SERVICES, LOCAL]), ['gemini']);
  assert.deepEqual(SP.normalizeSelected(null, SERVICES), ['gemini']);
  assert.deepEqual(SP.normalizeSelected([42, 'deepseek'], SERVICES), ['deepseek']);
});

test('켜고 끄기: 3번째는 안 켜지고, 마지막 하나는 안 꺼진다', () => {
  assert.deepEqual(SP.toggle(['gemini'], 'claude'), { ok: true, selected: ['gemini', 'claude'] });
  const full = SP.toggle(['gemini', 'claude'], 'grok');
  assert.equal(full.ok, false);
  assert.deepEqual(full.selected, ['gemini', 'claude']);
  assert.match(full.error, /최대 2개/);
  assert.deepEqual(SP.toggle(['gemini', 'claude'], 'gemini'), { ok: true, selected: ['claude'] });
  assert.equal(SP.toggle(['gemini'], 'gemini').ok, false);
});

test('위/아래 비율은 20% ~ 80%', () => {
  assert.equal(SP.clampRatio(0.5), 0.5);
  assert.equal(SP.clampRatio(0.05), 0.2);
  assert.equal(SP.clampRatio(2), 0.8);
  assert.equal(SP.clampRatio('x'), 0.5);
  assert.equal(SP.clampRatio(undefined), 0.5);
});

test('연결 이름: 만든 그대로 읽히고, 모양이 다르면 버린다', () => {
  const nonce = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(SP.parsePortName(SP.portName(nonce, 'chatgpt')), { nonce, id: 'chatgpt' });
  assert.equal(SP.parsePortName('mla-app'), null);
  assert.equal(SP.parsePortName(`mla-side:${nonce}:a b`), null);
  assert.equal(SP.parsePortName(`mla-side:short:gemini`), null);
  assert.equal(SP.parsePortName(undefined), null);
});

test('페이지 맥락: 빈 글 · 이상한 주소 · 긴 글', () => {
  assert.equal(SP.normalizeContext({ text: '   ' }), null);
  assert.equal(SP.normalizeContext(null), null);
  const c = SP.normalizeContext({ title: '  제목\n둘 ', url: 'javascript:alert(1)', text: 'a\r\nb', at: 5, tabId: 7 });
  assert.deepEqual(c, { title: '제목 둘', url: '', text: 'a\nb', truncated: false, at: 5, tabId: 7 });
  const long = SP.normalizeContext({ url: 'https://x.test/', text: 'x'.repeat(SP.MAX_PAGE + 3) });
  assert.equal(long.text.length, SP.MAX_PAGE);
  assert.equal(long.truncated, true);
  assert.equal(long.title, 'https://x.test/');
  assert.equal(long.tabId, null);
});

test('맥락 줄 상태: 없음 · 꺼 둠 · 다른 탭 · 정상', () => {
  const ctx = { url: 'https://a.test/', at: 1, tabId: 3 };
  assert.equal(SP.contextState(null), 'none');
  assert.equal(SP.contextState(ctx, { on: false }), 'off');
  assert.equal(SP.contextState(ctx, { activeTabId: 9 }), 'other');
  assert.equal(SP.contextState(ctx, { activeTabId: 3 }), 'ok');
  assert.equal(SP.contextState(ctx, { activeTabId: null }), 'ok');
});

test('보낼 글: 보통 길이 본문은 질문 글에 그대로, 같은 페이지 두 번째는 글만', () => {
  const ctx = SP.normalizeContext({ title: '글', url: 'https://a.test/p', text: '본문입니다', at: 10, tabId: 1 });
  const first = SP.buildSend({ text: ' 요약해줘 ', ctx, webAsk: W });
  assert.equal(first.mode, 'inline');
  assert.equal(first.page, null); // 첨부에 기대지 않는다 — 사이드 패널(모바일 화면)에서는 첨부가 조용히 실패할 수 있다
  assert.match(first.text, /「글」\(https:\/\/a\.test\/p\)/);
  assert.ok(first.text.includes('\n---\n본문입니다\n---\n'));
  assert.ok(first.text.endsWith('질문: 요약해줘'));
  const again = SP.buildSend({ text: '더', ctx, sentKey: SP.contextKey(ctx), webAsk: W });
  assert.deepEqual(again, { text: '더', page: null, mode: 'none' });
  assert.deepEqual(SP.buildSend({ text: '끔', ctx, on: false, webAsk: W }), { text: '끔', page: null, mode: 'none' });
  assert.deepEqual(SP.buildSend({ text: '없음', ctx: null, webAsk: W }), { text: '없음', page: null, mode: 'none' });
});

test('보낼 글: 3만 자보다 긴 본문은 page.md 첨부 + 안내', () => {
  const ctx = SP.normalizeContext({ title: '긴 글', url: 'https://a.test/long', text: 'x'.repeat(SP.INLINE_MAX + 1), at: 10 });
  const out = SP.buildSend({ text: '요약', ctx, webAsk: W });
  assert.equal(out.mode, 'file');
  assert.equal(out.page.name, 'page.md');
  assert.ok(out.text.startsWith('첨부한 page.md는 웹페이지'));
  assert.ok(out.text.endsWith('질문: 요약'));
  assert.equal(SP.buildSend({ text: '요약', ctx: { ...ctx, text: 'x'.repeat(SP.INLINE_MAX) }, webAsk: W }).mode, 'inline');
});

test('확장 설정: 사이드 패널 · 단축키 · 권한 (모든 사이트 권한은 여전히 없음)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  assert.ok(m.permissions.includes('sidePanel'));
  assert.equal(m.side_panel.default_path, 'sidepanel.html');
  assert.equal(m.commands['open-side-panel'].suggested_key.default, 'Alt+Shift+S');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'extension', 'sidepanel.html')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'extension', 'sidepanel.js')));
  assert.ok(Number(m.minimum_chrome_version) >= 116); // sidePanel.open · getContexts(SIDE_PANEL)
});

test('사이드탭 화면: 모든 서비스 주소를 iframe으로 띄울 수 있고, 쓰는 공통 모듈이 다 있다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extension', 'sidepanel.html'), 'utf8');
  const frameSrc = /frame-src ([^;"]+)/.exec(html)[1].split(/\s+/);
  for (const h of new Set(SERVICES.flatMap((s) => s.hosts))) assert.ok(frameSrc.includes(`https://${h}`), h);
  for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'extension', src)), src);
  }
});

/** background.js를 가짜 chrome API 위에서 읽고, 연결선 · 세션 규칙을 기록한다 */
function loadBackground() {
  const vm = require('vm');
  const ext = path.join(__dirname, '..', 'extension');
  const ev = (list) => ({ addListener: (fn) => list?.push(fn) });
  const onConnect = [];
  let rules = [];
  const chrome = {
    action: { onClicked: ev() },
    runtime: { id: 'extid', getURL: (p) => `chrome-extension://extid/${p}`, onMessage: ev(), onConnect: ev(onConnect), onInstalled: ev(), onStartup: ev(), getContexts: async () => [] },
    contextMenus: { onClicked: ev(), removeAll: (cb) => cb?.(), create: () => {} },
    commands: { onCommand: ev() },
    sidePanel: { open: async () => {} },
    tabs: { onRemoved: ev() },
    storage: { session: { set: async () => {} } },
    declarativeNetRequest: {
      getSessionRules: async () => rules,
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        rules = [...rules.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
      },
    },
    cookies: { onChanged: ev(), getAll: async () => [], set: async () => {}, remove: async () => {} },
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout, Date });
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx));
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), ctx);
  /** 가짜 연결선을 열어 background에 넘긴다 */
  const connect = (name, sender) => {
    const port = { name, sender, sent: [], msg: [], off: [], disconnected: false };
    port.postMessage = (m) => port.sent.push(m);
    port.disconnect = () => (port.disconnected = true);
    port.onMessage = ev(port.msg);
    port.onDisconnect = ev(port.off);
    onConnect.forEach((fn) => fn(port));
    return port;
  };
  return { connect, rules: () => rules };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('사이드탭 규칙: 사이드 패널이 열린 동안만, 탭 없는(-1) 요청 중 이 확장이 띄운 서비스 iframe에만', async () => {
  const bg = loadBackground();
  // 사이드 패널이 아닌 곳(일반 탭 · 다른 주소)에서 'mla-side'로 연결하면 끊는다
  assert.equal(bg.connect('mla-side', { url: 'chrome-extension://extid/sidepanel.html', tab: { id: 3 } }).disconnected, true);
  assert.equal(bg.connect('mla-side', { url: 'https://evil.test/' }).disconnected, true);

  const a = bg.connect('mla-side', { url: 'chrome-extension://extid/sidepanel.html' });
  const b = bg.connect('mla-side', { url: 'chrome-extension://extid/sidepanel.html' }); // 다른 창의 사이드 패널
  a.msg.forEach((fn) => fn({ type: 'hello', pageId: 'A' }));
  b.msg.forEach((fn) => fn({ type: 'hello', pageId: 'B' }));
  await settle();
  const frame = bg.rules().find((r) => r.condition.resourceTypes.includes('sub_frame'));
  assert.deepEqual([...frame.condition.tabIds], [-1]);
  assert.ok(frame.condition.initiatorDomains.includes('extid'));
  assert.ok(frame.condition.requestDomains.includes('gemini.google.com'));
  assert.deepEqual(a.sent.map((m) => m.type), ['ready']);

  a.off.forEach((fn) => fn()); // 한 창의 사이드 패널을 닫아도 다른 창 것이 남아 있으면 규칙은 둔다
  await settle();
  assert.equal(bg.rules().length, 1);
  b.off.forEach((fn) => fn());
  await settle();
  assert.equal(bg.rules().length, 0);
});

test('맥락 열쇠: 같은 페이지를 다시 읽어도 글이 같으면 같고, 글이 바뀌면 다르다 (자동 읽기가 같은 본문을 또 보내지 않게)', () => {
  const a = SP.normalizeContext({ url: 'https://a.test/', text: '본문', at: 1, tabId: 1 });
  const again = SP.normalizeContext({ url: 'https://a.test/', text: '본문', at: 999, tabId: 1 });
  const edited = SP.normalizeContext({ url: 'https://a.test/', text: '본문 + 새 댓글', at: 999, tabId: 1 });
  assert.equal(SP.contextKey(a), SP.contextKey(again));
  assert.notEqual(SP.contextKey(a), SP.contextKey(edited));
  assert.equal(SP.contextKey(null), '');
});
