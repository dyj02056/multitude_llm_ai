// 크롬 확장 고친 점 확인: WebSocket 규칙 번호 · 확장 화면 CSP(로컬 LLM) · 사이드탭 보내기 잠김
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ext = path.join(__dirname, '..', 'extension');

/** background.js를 가짜 chrome API 위에서 읽는다 (세션 규칙 · 쿠키를 바꿔 넣을 수 있게) */
function loadBackground({ rules: start = [], cookies = [], appTabs = [] } = {}) {
  const ev = (list) => ({ addListener: (fn) => list?.push(fn) });
  const onConnect = [];
  const onRemoved = [];
  let rules = [...start];
  const chrome = {
    action: { onClicked: ev() },
    runtime: { id: 'extid', getURL: (p) => `chrome-extension://extid/${p}`, onMessage: ev(), onConnect: ev(onConnect), onInstalled: ev(), onStartup: ev(), getContexts: async () => appTabs.map((tabId) => ({ tabId, documentUrl: 'chrome-extension://extid/app.html' })) },
    contextMenus: { onClicked: ev(), removeAll: (cb) => cb?.(), create: () => {} },
    commands: { onCommand: ev() },
    sidePanel: { open: async () => {} },
    tabs: { onRemoved: ev(onRemoved) },
    storage: { session: { set: async () => {} } },
    declarativeNetRequest: {
      getSessionRules: async () => rules,
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        const left = rules.filter((r) => !removeRuleIds.includes(r.id));
        for (const r of addRules) if (left.some((x) => x.id === r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
        rules = [...left, ...addRules];
      },
    },
    cookies: { onChanged: ev(), getAll: async ({ partitionKey }) => (partitionKey ? [] : cookies), set: async () => {}, remove: async () => {} },
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout, Date });
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx));
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), ctx);
  const connect = (name, sender) => {
    const port = { name, sender, sent: [], msg: [], off: [], disconnected: false };
    port.postMessage = (m) => port.sent.push(m);
    port.disconnect = () => (port.disconnected = true);
    port.onMessage = ev(port.msg);
    port.onDisconnect = ev(port.off);
    onConnect.forEach((fn) => fn(port));
    return port;
  };
  return { ctx, connect, rules: () => rules, closeTab: (id) => onRemoved.forEach((fn) => fn(id)) };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const WS = 1000000000;

test('WebSocket 규칙 번호: 쓰고 있는 번호를 피해 가장 작은 빈 번호부터 고른다', () => {
  const { ctx } = loadBackground();
  assert.deepEqual([...ctx.freeWsRuleIds([], 3)], [WS, WS + 1, WS + 2]);
  assert.deepEqual([...ctx.freeWsRuleIds([WS, WS + 2, 5], 2)], [WS + 1, WS + 3]);
  assert.deepEqual([...ctx.freeWsRuleIds([WS], 0)], []);
});

test('WebSocket 규칙: 백그라운드가 다시 깨어나 남아 있던 세션 규칙과 번호가 겹치지 않고, 그 탭의 옛 규칙은 지운다', async () => {
  // 잠들기 전에 걸어 둔 규칙: 탭 7의 WebSocket 규칙(WS) · 탭 8의 WebSocket 규칙(WS+1)
  const old = (id, tabId) => ({ id, priority: 2, action: { type: 'modifyHeaders' }, condition: { tabIds: [tabId], resourceTypes: ['websocket'], requestDomains: ['chatgpt.com'] } });
  const bg = loadBackground({ rules: [old(WS, 7), old(WS + 1, 8)], cookies: [{ name: 'sid', value: 'x' }], appTabs: [7, 8] }); // 두 앱 탭이 열린 채로 깨어남
  const port = bg.connect('mla-app', { url: 'chrome-extension://extid/app.html', tab: { id: 7 } });
  port.msg.forEach((fn) => fn({ type: 'hello', pageId: 'P' }));
  await settle();
  assert.deepEqual(port.sent.map((m) => m.type), ['ready']);
  const ws = bg.rules().filter((r) => r.id >= WS);
  assert.equal(new Set(ws.map((r) => r.id)).size, ws.length); // 번호가 겹치지 않는다
  assert.ok(ws.some((r) => r.id === WS + 1 && r.condition.tabIds[0] === 8)); // 다른 탭 규칙은 그대로
  const mine = ws.filter((r) => r.condition.tabIds[0] === 7);
  assert.ok(mine.length > 1); // 서비스 도메인마다 하나씩 새로 걸렸다
  assert.ok(mine.every((r) => r.condition.requestHeaders === undefined && r.action.requestHeaders[0].value === 'sid=x'));

  // 탭을 닫으면 그 탭의 규칙(iframe + WebSocket)이 모두 지워진다
  bg.closeTab(7);
  await settle();
  assert.equal(bg.rules().filter((r) => r.condition.tabIds[0] === 7 || r.id === 7).length, 0);
  assert.equal(bg.rules().length, 1);
});

test('확장 화면 CSP: 로컬 LLM 서버(localhost · 127.0.0.1, 포트 아무거나)로 연결을 허용한다', () => {
  const html = fs.readFileSync(path.join(ext, 'app.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const connect = /connect-src ([^;]+)/.exec(csp)[1].split(/\s+/);
  for (const src of ['http://localhost:*', 'http://127.0.0.1:*', 'https://raw.githubusercontent.com']) assert.ok(connect.includes(src), src);
  // local-llm.js의 기본 주소가 CSP에 맞는지
  const LL = require('../src/shared/local-llm.js');
  const base = new URL(LL.DEFAULT_BASE);
  assert.ok(connect.includes(`${base.protocol}//${base.hostname}:*`));
});

test('사이드탭 보내기: 중간에 오류가 나도 finally에서 보내기 버튼을 다시 켠다', () => {
  const src = fs.readFileSync(path.join(ext, 'sidepanel.js'), 'utf8');
  const body = src.slice(src.indexOf('async function send()'), src.indexOf('async function sendOne('));
  assert.match(body, /try \{[\s\S]*sideHistory\.add[\s\S]*\} catch \(err\) \{[\s\S]*'error'[\s\S]*\} finally \{\s*sending = false;\s*\$\('#spSend'\)\.disabled = false;/);
});
