'use strict';

// 확장 프로그램 아이콘을 누르면 Multitude LLM 탭을 연다. 이미 열려 있으면 그 탭으로 옮겨 간다.
//
// iframe 허용 규칙(앱 탭 안의 서비스 iframe에서만 X-Frame-Options·CSP를 지우는 세션 규칙)도 여기서만 걸고 지운다.
// 앱 탭(host.js)이 연결선(port)을 열고 "hello"를 보내면 규칙을 걸고, 그 화면의 연결이 끊기면(다른 주소로 이동·
// 닫기·새로고침) 즉시 지운다. 그래서 앱 탭을 떠난 뒤 그 탭에 뜬 다른 사이트가 AI 사이트를 iframe에 넣을 수 없다.
//   - 탭마다 "지금 주인인 화면 번호"를 기억해, 새로고침 때 옛 화면의 끊김이 새 화면의 규칙을 지우지 않게 한다.
//   - 규칙 작업은 한 줄로 세워(queue) 순서가 꼬이지 않게 한다.
//   - 백그라운드가 다시 깨어날 때마다 주인 없는 규칙(앱 화면이 없는 탭의 규칙)을 지운다.

importScripts('lib/shared/services.js');

const APP_URL = chrome.runtime.getURL('app.html');
const DOMAINS = [...new Set(MLA.services.SERVICES.flatMap((s) => s.hosts))];

chrome.action.onClicked.addListener(async () => {
  try {
    const [ctx] = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    if (ctx && ctx.tabId >= 0 && ctx.documentUrl?.startsWith(APP_URL)) {
      await chrome.tabs.update(ctx.tabId, { active: true });
      await chrome.windows.update(ctx.windowId, { focused: true });
      return;
    }
  } catch (err) {
    console.warn('[background] 열린 탭을 찾지 못했습니다:', err.message);
  }
  chrome.tabs.create({ url: APP_URL });
});

// ---------- iframe 허용 규칙 ----------

const owners = new Map(); // tabId -> 지금 주인인 앱 화면 번호
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn).catch((err) => console.warn('[background] 규칙 작업 실패:', err.message)));

/** 규칙 번호 = 탭 번호. 그 탭의 서비스 iframe 요청에서만 두 헤더를 지운다. */
const addRule = (tabId) =>
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { tabIds: [tabId], resourceTypes: ['sub_frame'], requestDomains: DOMAINS },
      },
    ],
  });

const removeRule = (tabId) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });

/** 앱 화면이 없는 탭의 규칙을 지운다 (백그라운드가 자는 사이 앱 탭을 떠난 경우 대비) */
async function sweepStaleRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (!rules.length) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const appTabs = new Set(contexts.filter((c) => c.documentUrl?.startsWith(APP_URL)).map((c) => c.tabId));
  const stale = rules.map((r) => r.id).filter((id) => !appTabs.has(id));
  if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
}
globalThis.sweepStaleRules = sweepStaleRules; // 테스트용

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mla-app') return;
  const tabId = port.sender?.tab?.id;
  const fromApp = port.sender?.url?.startsWith(APP_URL);
  if (typeof tabId !== 'number' || tabId < 0 || !fromApp) return port.disconnect();
  let pageId = null;

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'hello' && typeof msg.pageId === 'string') {
      pageId = msg.pageId;
      owners.set(tabId, pageId);
      serial(async () => {
        await addRule(tabId);
        try {
          port.postMessage({ type: 'ready' });
        } catch {} // 그사이 화면이 사라졌으면 끊김 처리에서 지운다
      });
    }
    // msg.type === 'ping': 백그라운드가 잠들지 않게 하는 신호. 할 일은 없다.
  });

  port.onDisconnect.addListener(() => {
    if (pageId === null || owners.get(tabId) !== pageId) return; // 새 화면이 이미 주인이면 그대로 둔다
    owners.delete(tabId);
    serial(() => removeRule(tabId));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  owners.delete(tabId);
  serial(() => removeRule(tabId));
});

// 백그라운드가 (다시) 시작될 때마다 점검한다.
serial(sweepStaleRules);
