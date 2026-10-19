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
//
// 화면 스크립트용 쿠키 복사(jsCookies 서비스, 지금은 Qwen): 확장 탭 안 iframe의 화면 스크립트는 document.cookie로
// SameSite=Lax/Strict 쿠키를 읽지 못해 로그인 쿠키가 없다고 보고 로그아웃 화면을 띄운다. 그 사이트의 (HttpOnly가 아닌)
// 쿠키를 이 확장 탭 안 iframe에서만 보이는 partitioned 쿠키로 복사해 둔다. 일반 탭의 그 사이트에는 영향이 없다.
// 화면 스크립트가 쓴 쿠키는 cookie-shim.js → cookie-bridge.js → 여기(mla:setCookie)로 와서 원래 쿠키에 반영한다.
//
// 토큰 다리(tokenBridge, 지금은 Qwen·Z.ai): Qwen 화면은 쿠키가 아니라 localStorage.token으로 로그인을 확인하는데, 확장 탭 안
// iframe의 저장소는 일반 탭과 분리될 수 있다. 서버가 같은 토큰을 넣어 두는 token 쿠키 값을 그 iframe에만 알려 주고,
// cookie-bridge.js가 iframe의 localStorage에 넣은 뒤 한 번 새로고침한다.

importScripts('lib/shared/services.js');

const APP_URL = chrome.runtime.getURL('app.html');
const DOMAINS = [...new Set(MLA.services.SERVICES.flatMap((s) => s.hosts))];
const JS_COOKIE_HOSTS = MLA.services.SERVICES.filter((s) => s.jsCookies).flatMap((s) => s.hosts);
const PARTITION = { topLevelSite: `chrome-extension://${chrome.runtime.id}` };

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
      cookies = (await chrome.cookies.getAll({ url: `https://${host}/` })).filter((c) => !c.partitionKey);
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

// ---------- 화면 스크립트용 쿠키 복사 (jsCookies) ----------

const sameCookie = (a, b) => a.name === b.name && a.domain === b.domain && a.path === b.path;

/** jsCookies 서비스의 쿠키를 확장 탭 칸(partitioned)에 맞춰 복사하고, 원래 쿠키가 사라진 복사본은 지운다 */
async function mirrorJsCookies() {
  for (const host of JS_COOKIE_HOSTS) {
    const url = `https://${host}/`;
    const [all, parted] = await Promise.all([chrome.cookies.getAll({ url }), chrome.cookies.getAll({ url, partitionKey: PARTITION })]);
    // HttpOnly는 화면 스크립트가 원래 못 읽고, SameSite=None은 iframe에서도 이미 읽힌다
    const src = all.filter((c) => !c.partitionKey && !c.httpOnly && c.sameSite !== 'no_restriction');
    const copies = parted.filter((c) => c.partitionKey?.topLevelSite === PARTITION.topLevelSite);
    for (const c of src) {
      const have = copies.find((m) => sameCookie(m, c));
      if (have && have.value === c.value && have.expirationDate === c.expirationDate) continue;
      await chrome.cookies.set({
        url: `https://${host}${c.path}`,
        name: c.name,
        value: c.value,
        path: c.path,
        ...(c.hostOnly ? {} : { domain: c.domain }),
        secure: true,
        sameSite: 'no_restriction',
        ...(c.session ? {} : { expirationDate: c.expirationDate }),
        partitionKey: PARTITION,
      });
    }
    for (const m of copies) {
      if (!src.some((c) => sameCookie(c, m))) await chrome.cookies.remove({ url: `https://${host}${m.path}`, name: m.name, partitionKey: m.partitionKey });
    }
  }
}

/** document.cookie에 쓰는 문자열("이름=값; Path=/; Max-Age=…")을 나눈다 */
function parseCookieWrite(raw) {
  const [pair, ...attrs] = raw.split(';');
  const eq = pair.indexOf('=');
  const out = { name: eq < 0 ? '' : pair.slice(0, eq).trim(), value: (eq < 0 ? pair : pair.slice(eq + 1)).trim() };
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'path' && val.startsWith('/')) out.path = val;
    else if (key === 'domain' && val) out.domain = val.toLowerCase();
    else if (key === 'max-age' && /^-?\d+$/.test(val)) out.maxAge = Number(val);
    else if (key === 'expires' && !Number.isNaN(Date.parse(val))) out.expires = Date.parse(val) / 1000;
    else if (key === 'samesite') out.sameSite = { strict: 'strict', lax: 'lax' }[val.toLowerCase()];
  }
  return out;
}

/** 화면 스크립트가 쓴 쿠키를 그 사이트의 원래 쿠키에 반영한다. 보낸 페이지 도메인과 그 상위 도메인 쿠키만 받는다. */
async function applyCookieWrite(pageUrl, raw) {
  const host = pageUrl.hostname;
  const c = parseCookieWrite(raw);
  if (!c.name && !c.value) return;
  const domain = c.domain?.replace(/^\./, '');
  if (domain && domain !== host && !(host.endsWith(`.${domain}`) && domain.includes('.'))) return;
  // Path가 없으면 브라우저처럼 페이지 주소의 폴더를 쓴다
  const path = c.path || pageUrl.pathname.replace(/\/[^/]*$/, '') || '/';
  const url = `https://${host}${path}`;
  const now = Date.now() / 1000;
  const expirationDate = c.maxAge !== undefined ? now + c.maxAge : c.expires;
  // 일반 탭의 document.cookie처럼, 이름·도메인·경로가 같은 HttpOnly 쿠키는 덮어쓰거나 지우지 않는다
  // (확장 API는 HttpOnly도 바꿀 수 있어서, 막지 않으면 페이지 스크립트가 로그인 세션 쿠키를 바꿀 수 있다).
  const existing = (await chrome.cookies.getAll({ url, name: c.name }).catch(() => [])).filter((x) => !x.partitionKey);
  if (expirationDate !== undefined && expirationDate <= now) {
    // 지우기는 주소에 맞는 쿠키 중 하나를 고르므로, 그 이름의 HttpOnly 쿠키가 하나라도 있으면 지우지 않는다
    if (existing.some((x) => x.httpOnly)) return;
    return chrome.cookies.remove({ url, name: c.name });
  }
  const wantDomain = domain ? `.${domain}` : host;
  if (existing.some((x) => x.httpOnly && x.path === path && x.domain === wantDomain)) return;
  await chrome.cookies.set({
    url,
    name: c.name,
    value: c.value,
    path,
    ...(domain ? { domain: `.${domain}` } : {}),
    secure: true, // https 페이지가 쓴 쿠키다
    sameSite: c.sameSite || 'unspecified',
    ...(expirationDate !== undefined ? { expirationDate } : {}),
  });
}

const TOKEN_BRIDGES = new Map(
  MLA.services.SERVICES.filter((s) => s.tokenBridge).map((s) => [new URL(s.url).hostname, s.tokenBridge]),
);

/** 앱 탭 안 서비스 iframe(content script)이 보낸 메시지인지 확인하고 그 페이지 주소를 돌려준다 */
function appFrameUrl(sender, hosts) {
  if (sender.id !== chrome.runtime.id || !(sender.frameId > 0) || !owners.has(sender.tab?.id)) return null;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' && hosts.includes(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

// 토큰 다리(tokenBridge): 그 사이트 자신의 iframe에만, 크롬이 가진 그 사이트의 토큰 쿠키 값을 알려 준다.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'mla:tokenBridge') return;
  const url = appFrameUrl(sender, [...TOKEN_BRIDGES.keys()]);
  if (!url) return reply(null);
  const bridge = TOKEN_BRIDGES.get(url.hostname);
  (async () => {
    for (const name of bridge.cookies) {
      const c = await chrome.cookies.get({ url: `https://${url.hostname}/`, name });
      if (c?.value) return { storage: bridge.storage, value: c.value, preferCookie: !!bridge.preferCookie };
    }
    return null;
  })().then(reply, () => reply(null));
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'mla:setCookie' || typeof msg.raw !== 'string') return;
  const pageUrl = appFrameUrl(sender, JS_COOKIE_HOSTS); // 앱 탭 안의 jsCookies 서비스 iframe에서 온 것만
  if (!pageUrl) return;
  serial(() => applyCookieWrite(pageUrl, msg.raw.slice(0, 8192)));
});

// 사이트가 쿠키를 바꾸면(로그인·토큰 갱신) 열려 있는 앱 탭의 WebSocket 쿠키 규칙과 화면 스크립트용 복사본을 다시 맞춘다.
let cookieTimer = null;
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.partitionKey) return; // 우리가 만든 복사본(또는 다른 칸) 변화
  const domain = cookie.domain.replace(/^\./, '');
  if (!owners.size || !DOMAINS.some((h) => h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`))) return;
  clearTimeout(cookieTimer);
  cookieTimer = setTimeout(() => {
    serial(mirrorJsCookies);
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
        await mirrorJsCookies().catch((err) => console.warn('[background] 쿠키 복사 실패:', err.message));
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
