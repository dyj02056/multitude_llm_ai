'use strict';

// 스크린샷용 가짜 크롬 확장 API (사이드탭 sidepanel.html). 서비스 iframe 주소는 run.js가 테스트용 채팅 페이지로 바꿔 준다.
// iframe 안 content.js 대신, iframe이 열리면 그 이름으로 "연결됨 · 로그인됨"을 흉내 낸다.
const { ipcRenderer } = require('electron');

const ev = () => {
  const l = [];
  return { addListener: (f) => l.push(f), fire: (...a) => l.forEach((f) => f(...a)) };
};
const onConnect = ev();
const page = {
  title: 'AI 반도체 수출 30% 증가… HBM이 절반 차지',
  url: 'https://news.example.com/2026/11/ai-chip-export',
  text: '이번 분기 AI 반도체 수출이 지난해 같은 기간보다 30% 늘었다. '.repeat(40),
};
const store = { sidePrefs: { selected: ['gemini', 'claude'], ratio: 0.55, ctxOn: true } };

window.chrome = {
  runtime: {
    id: 'shot',
    getURL: (p) => `shot://repo/extension/${p}`,
    connect: () => {
      const port = { onMessage: ev(), onDisconnect: ev(), disconnect() {} };
      port.postMessage = (m) => m?.type === 'hello' && setTimeout(() => port.onMessage.fire({ type: 'ready' }), 10);
      return port;
    },
    onConnect,
    getContexts: async () => [],
  },
  storage: {
    local: { get: async () => store, set: async (o) => Object.assign(store, o) },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: ev(),
  },
  windows: { getCurrent: async () => ({ id: 1 }), update: async () => {} },
  tabs: { query: async () => [{ id: 7 }], onActivated: ev(), onUpdated: ev(), create() {}, update: async () => {} },
  permissions: { contains: async () => true, request: async () => true, onRemoved: ev() },
  commands: { getAll: async () => [{ name: 'open-side-panel', shortcut: 'Alt+Shift+S' }] },
  scripting: { executeScript: async () => [{ result: page }] },
  browsingData: { removeServiceWorkers: async () => {} },
};

const hosts = { gemini: 'https://gemini.google.com/app', claude: 'https://claude.ai/new' };
new MutationObserver(() => {
  for (const f of document.querySelectorAll('iframe.sp-frame:not([data-shot])')) {
    f.dataset.shot = '1';
    f.addEventListener('load', () => {
      const id = f.name.split(':').pop();
      const port = { name: f.name, sender: { id: 'shot', url: hosts[id] }, onMessage: ev(), onDisconnect: ev(), disconnect() {} };
      port.postMessage = ({ id: req, msg }) => {
        const result = { 'mla:loggedOut': false, 'mla:snapshot': { stop: false, count: 1, text: '' } }[msg?.type];
        setTimeout(() => port.onMessage.fire({ id: req, result: result ?? null }), 10);
      };
      onConnect.fire(port);
      setTimeout(() => port.onMessage.fire({ event: { type: 'mla:hello', url: hosts[id] } }), 10);
    });
  }
}).observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('DOMContentLoaded', () =>
  setTimeout(() => {
    const status = [...document.querySelectorAll('.sp-pane .status')];
    if (status[0]) (status[0].textContent = '완료 · 312자'), (status[0].dataset.state = 'answer-done');
    if (status[1]) (status[1].textContent = '답변 중…'), (status[1].dataset.state = 'answer-answering');
    const hint = document.querySelector('#spHint');
    hint.textContent = '보냄 → Gemini · Claude · 페이지 본문 1,480자 포함';
    hint.dataset.kind = 'ok';
    ipcRenderer.send('shot:ready');
  }, 2600),
);
