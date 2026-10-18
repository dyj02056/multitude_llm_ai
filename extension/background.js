'use strict';

// 확장 프로그램 아이콘을 누르면 Multitude LLM 탭을 연다. 이미 열려 있으면 그 탭으로 옮겨 간다.
// 탭을 닫으면 그 탭에 걸어 둔 iframe 허용 규칙(host.js allowFraming)을 지운다.

const APP_URL = chrome.runtime.getURL('app.html');

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

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});
