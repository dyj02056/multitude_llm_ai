'use strict';

// 확장 프로그램 아이콘을 누르면 Multitude LLM 탭을 연다. 이미 열려 있으면 그 탭으로 옮겨 간다.
//
// iframe 허용 규칙(앱 탭 안의 서비스 iframe에서만 X-Frame-Options·CSP를 지우는 세션 규칙)도 여기서만 걸고 지운다.
// 앱 탭(host.js)이 연결선(port)을 열고 "hello"를 보내면 규칙을 걸고, 그 화면의 연결이 끊기면(다른 주소로 이동·
// 닫기·새로고침) 즉시 지운다. 그래서 앱 탭을 떠난 뒤 그 탭에 뜬 다른 사이트가 AI 사이트를 iframe에 넣을 수 없다.
//   - 탭마다 "지금 주인인 화면 번호"를 기억해, 새로고침 때 옛 화면의 끊김이 새 화면의 규칙을 지우지 않게 한다.
//   - 규칙 작업은 한 줄로 세워(queue) 순서가 꼬이지 않게 한다.
//   - 백그라운드가 다시 깨어날 때마다 주인 없는 규칙(앱 화면이 없는 탭의 규칙)을 지운다.
//
// WebSocket 쿠키 규칙: 크롬은 확장 탭 안 iframe의 일반 요청에는 로그인 쿠키(SameSite=Lax)를 붙이지만 WebSocket 연결에는
// 붙이지 않는다. 그래서 Grok처럼 답변을 WebSocket으로 주고받는 사이트가 로그인이 안 된 연결로 보고 "네트워크에서 차단"
// 오류를 낸다. 앱 탭 + 서비스 도메인 + WebSocket 요청에 한해, 크롬이 그 사이트에 가진 쿠키를 그대로 붙이는 규칙을 건다.
// 쿠키가 바뀌면 다시 맞추고, 앱 화면이 사라지면 iframe 규칙과 함께 지운다. 쿠키 값은 이 세션 규칙(메모리)에만 있다.

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
const WS_RULE_BASE = 1000000000; // WebSocket 쿠키 규칙 번호 = 이 값 + 탭마다 붙이는 순번 (iframe 규칙 번호 = 탭 번호와 겹치지 않게)
let wsSeq = 0;
const wsRules = new Map(); // tabId -> [규칙 번호]
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

/** 그 탭의 규칙(iframe 규칙 + WebSocket 쿠키 규칙)을 모두 지운다 */
async function removeRule(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.filter((r) => r.id === tabId || r.condition?.tabIds?.[0] === tabId).map((r) => r.id);
  wsRules.delete(tabId);
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}

/** 서비스 도메인마다, 크롬이 가진 쿠키를 그 탭의 WebSocket 요청에 붙이는 규칙을 새로 건다 */
async function syncWsCookies(tabId) {
  const addRules = [];
  for (const host of DOMAINS) {
    let cookies = [];
    try {
      cookies = await chrome.cookies.getAll({ url: `https://${host}/` });
    } catch {}
    if (!cookies.length) continue;
    const value = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    addRules.push({
      id: WS_RULE_BASE + (wsSeq = (wsSeq + 1) % 100000000),
      priority: 2,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set', value }] },
      condition: { tabIds: [tabId], resourceTypes: ['websocket'], requestDomains: [host] },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: wsRules.get(tabId) || [], addRules });
  wsRules.set(tabId, addRules.map((r) => r.id));
}

// 사이트가 쿠키를 바꾸면(로그인·토큰 갱신) 열려 있는 앱 탭의 WebSocket 쿠키 규칙을 다시 맞춘다.
let cookieTimer = null;
chrome.cookies.onChanged.addListener(({ cookie }) => {
  const domain = cookie.domain.replace(/^\./, '');
  if (!owners.size || !DOMAINS.some((h) => h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`))) return;
  clearTimeout(cookieTimer);
  cookieTimer = setTimeout(() => {
    for (const tabId of owners.keys()) serial(() => syncWsCookies(tabId));
  }, 300);
});

/** 앱 화면이 없는 탭의 규칙을 지운다 (백그라운드가 자는 사이 앱 탭을 떠난 경우 대비) */
async function sweepStaleRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (!rules.length) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const appTabs = new Set(contexts.filter((c) => c.documentUrl?.startsWith(APP_URL)).map((c) => c.tabId));
  const stale = rules.filter((r) => !appTabs.has(r.condition?.tabIds?.[0])).map((r) => r.id);
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
        await syncWsCookies(tabId).catch((err) => console.warn('[background] WebSocket 쿠키 규칙 실패:', err.message));
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
