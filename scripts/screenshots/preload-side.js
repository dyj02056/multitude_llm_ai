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
const scene = new URLSearchParams(location.search).get('scene') || '24-side-panel';
// v0.37.0 장면: PDF · 번역 비교 · 한 줄 종합 + 사이트 프리셋
const SC = { PDF: scene === '68-side-pdf', CMP: scene === '69-side-compare', ONE: scene === '70-side-oneline' };
const NEW = SC.PDF || SC.CMP || SC.ONE;
/** 글 한 줄짜리 쪽 n개의 최소 PDF (영문) — 진짜 pdf.js가 읽는다 */
function makePdf(lines) {
  const objs = [];
  const add = (s) => objs.push(s);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${lines.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  lines.forEach((line, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`;
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}
const pdfB64 = SC.PDF ? makePdf(['Q3 2026 revenue grew 12 percent', 'Operating margin improved to 18 percent', 'Outlook: steady growth in Q4']) : '';
const TRANSLATION = {
  gemini: '회의는 정오에 시작합니다. 노트북과 충전기를 가져오세요.\n점심이 제공됩니다.',
  claude: '회의는 낮 12시에 시작됩니다. 노트북을 지참해 주세요.\n점심이 제공됩니다.',
};
const ANSWER = { gemini: '이번 분기 매출이 12% 늘었고 영업이익률은 18%로 좋아졌습니다.', claude: '3분기 매출은 12% 성장, 영업이익률 18%, 4분기도 완만한 성장이 전망됩니다.' };
// MLA_SHOT_LANG=en: 영어 화면 (v0.30.0, 기본 한국어) — 사이드탭은 저장된 앱 설정(prefs.lang)을 읽는다
const store = { sidePrefs: { selected: ['gemini', 'claude'], ratio: 0.55, ctxOn: true, oneLine: SC.ONE }, prefs: { lang: process.env.MLA_SHOT_LANG === 'en' ? 'en' : 'ko', ...(SC.ONE ? { local: { enabled: true, model: 'qwen2.5:7b' } } : {}) } };
if (SC.ONE) store.sideSites = { 'news.example.com': { selected: ['gemini', 'claude'], quick: 'summary', at: 1 } };
// v0.29.0: 이 페이지에서 전에 물어본 것 (주소 뒤 utm_* · #은 달라도 같은 페이지)
if (scene === '41-side-recall') {
  const at = Date.now();
  store['history:side'] = [
    { id: 'h2', at: at - 3600e3, question: '이 기사 핵심만 뽑아 줘', targets: ['gemini'], source: 'side', page: { title: page.title, url: page.url + '?utm_source=news' }, answers: { gemini: { state: 'done', md: '- AI 반도체 수출 30% 증가\n- HBM이 증가분의 절반' } } },
    { id: 'h1', at: at - 86400e3, question: '이 기사 세 줄로 요약해줘', targets: ['gemini', 'claude'], source: 'side', page: { title: page.title, url: page.url + '#comments' }, answers: { gemini: { state: 'done', md: '1. 수출 30% 증가 …' }, claude: { state: 'done', md: '이번 분기 수출이 크게 늘었습니다 …' } } },
  ];
}

window.chrome = {
  runtime: {
    id: 'shot',
    getURL: (p) => `shot://repo/extension/${p}`,
    onMessage: ev(), // v0.38.2부터 사이드탭이 background의 알림(쿠키 바뀜)을 듣는다
    connect: () => {
      const port = { onMessage: ev(), onDisconnect: ev(), disconnect() {} };
      port.postMessage = (m) => m?.type === 'hello' && setTimeout(() => port.onMessage.fire({ type: 'ready' }), 10);
      return port;
    },
    onConnect,
    getContexts: async () => [],
    sendMessage: async (m) => (m?.type === 'mla:local-ask' ? { ok: true, text: '두 AI 모두 이번 분기 매출이 약 12% 늘고 이익률도 좋아졌다고 봅니다.' } : undefined),
  },
  storage: {
    local: { get: async () => store, set: async (o) => Object.assign(store, o) },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: ev(),
  },
  windows: { getCurrent: async () => ({ id: 1 }), update: async () => {} },
  tabs: { query: async () => [{ id: 7, ...(SC.ONE ? { url: page.url } : {}) }], onActivated: ev(), onUpdated: ev(), create() {}, update: async () => {} },
  permissions: { contains: async () => true, request: async () => true, onRemoved: ev() },
  commands: { getAll: async () => [{ name: 'open-side-panel', shortcut: 'Alt+Shift+S' }] },
  scripting: {
    executeScript: async ({ func } = {}) => {
      const n = func && func.name;
      if (n === 'fetchSelfBase64') return [{ result: { b64: pdfB64 } }];
      if (n === 'readPageNow' && SC.PDF) return [{ result: { title: '2026년 3분기 실적 보고서', url: 'https://corp.example.com/reports/q3-2026.pdf', contentType: 'application/pdf', text: '', captions: '' } }];
      if (SC.CMP && n !== 'readPageNow') return [{ result: 'The meeting starts at noon. Please bring your laptop and a charger. Lunch is provided.' }]; // 페이지에서 선택한 글
      return [{ result: page }];
    },
  },
  browsingData: { removeServiceWorkers: async () => {} },
};

const hosts = { gemini: 'https://gemini.google.com/app', claude: 'https://claude.ai/new' };
const frameWatch = new MutationObserver(() => {
  for (const f of document.querySelectorAll('iframe.sp-frame:not([data-shot])')) {
    f.dataset.shot = '1';
    f.addEventListener('load', () => {
      const id = f.name.split(':').pop();
      const port = { name: f.name, sender: { id: 'shot', url: hosts[id] }, onMessage: ev(), onDisconnect: ev(), disconnect() {} };
      let sent = false;
      port.postMessage = ({ id: req, msg }) => {
        if (NEW && msg?.type === 'mla:send') sent = true;
        const text = SC.CMP ? TRANSLATION[id] : ANSWER[id];
        const snap = NEW && sent ? { stop: false, count: 1, text, md: text } : { stop: false, count: NEW ? 0 : 1, text: '' };
        const result = { 'mla:loggedOut': false, 'mla:snapshot': snap, 'mla:send': { ok: true, attach: { ok: true } } }[msg?.type];
        setTimeout(() => port.onMessage.fire({ id: req, result: result ?? null }), 10);
      };
      onConnect.fire(port);
      setTimeout(() => port.onMessage.fire({ event: { type: 'mla:hello', url: hosts[id] } }), 10);
    });
  }
});
// preload는 문서가 생기기 전에 돈다 — documentElement가 생기면 지켜보기 시작 (v0.29.0: 예전에는 여기서 오류)
(function observeWhenReady() {
  if (document.documentElement) frameWatch.observe(document.documentElement, { childList: true, subtree: true });
  else setTimeout(observeWhenReady, 5);
})();

window.addEventListener('DOMContentLoaded', () =>
  setTimeout(async () => {
    if (NEW) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (SC.PDF) await wait(1500); // pdf.js가 PDF를 읽을 때까지
      if (SC.CMP) document.querySelector('#spQuick [data-quick="compare"]')?.click();
      if (SC.ONE) document.querySelector('#spQuick [data-quick="summary"]')?.click();
      if (SC.PDF) document.querySelector('#spQuick [data-quick="summary"]')?.click();
      await wait(SC.PDF ? 1200 : 4200);
      return ipcRenderer.send('shot:ready');
    }
    const status = [...document.querySelectorAll('.sp-pane .status')];
    if (status[0]) (status[0].textContent = '완료 · 312자'), (status[0].dataset.state = 'answer-done');
    if (status[1]) (status[1].textContent = '답변 중…'), (status[1].dataset.state = 'answer-answering');
    const hint = document.querySelector('#spHint');
    hint.textContent = '보냄 → Gemini · Claude · 페이지 본문 1,480자 포함';
    hint.dataset.kind = 'ok';
    if (scene === '41-side-recall') {
      document.querySelector('#spRecallBtn')?.click();
      const first = document.querySelector('.sp-recall-item');
      if (first) first.open = true;
    }
    setTimeout(() => ipcRenderer.send('shot:ready'), 100);
  }, 2600),
);
