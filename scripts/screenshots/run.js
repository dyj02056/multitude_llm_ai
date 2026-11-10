'use strict';

// 문서용 스크린샷을 다시 찍는다 (v0.20.1):  npm run screenshots   (특정 장면만: npm run screenshots -- 02-ask-all 24-side-panel)
//
// [쉽게 말하면] 실제 화면 코드(src/renderer · extension/sidepanel)에 가짜 본체(preload-app.js · preload-side.js)와
// "테스트용 채팅 페이지"(sample.js)를 붙여 Electron 창에 띄우고, 장면마다 docs/screenshots/<이름>.png로 저장합니다.
// 실제 AI 사이트에는 접속하지 않습니다 (서비스 주소 요청은 모두 가짜 페이지로 바꿈).
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, protocol, session } = require('electron');
const S = require('./sample');
const { chatPage } = S;
const { SERVICES } = require('../../src/shared/services');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

// 앱 화면: 1400×860, 사이드탭: 420×860 (크롬 사이드 패널 폭)
const SCENES = [
  { name: '01-model-picker', page: 'app' },
  { name: '02-ask-all', page: 'app' },
  { name: '03-synthesis', page: 'app' },
  { name: '04-compare', page: 'app' },
  { name: '13-analysis', page: 'app' },
  { name: '14-diff-highlight', page: 'app' },
  { name: '05-history', page: 'app' },
  { name: '06-settings-shortcuts', page: 'app' },
  { name: '07-attachments', page: 'app' },
  { name: '12-library', page: 'app' },
  { name: '11-patch-preview', page: 'app' },
  { name: '19-local-llm', page: 'app' },
  { name: '15-screen-status', page: 'app' },
  { name: '17-stats', page: 'app' },
  { name: '20-local-llm-settings', page: 'app' },
  { name: '24-side-panel', page: 'side', width: 420 },
];

// 화면 파일을 shot:// 로 읽는다 — 장면을 꾸미려고 넣는 가짜 패널 페이지가 앱 CSP에 막히지 않게 (이 도구 안에서만)
app.disableHardwareAcceleration(); // 숨긴 창 캡처가 GPU에서 실패하는 PC가 있어 소프트웨어로 그린다
protocol.registerSchemesAsPrivileged([{ scheme: 'shot', privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } }]);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

/** 앱 패널 안의 테스트용 채팅 페이지 (장면에 따라 내용이 다름) */
function appChat(id, scene) {
  const s = SERVICES.find((x) => x.id === id) || { name: id, color: '#888' };
  if (scene === '03-synthesis' && id === 'gemini') {
    return chatPage(s.name, s.color, [{ role: 'user', text: '다른 AI들의 답변입니다. 오류 · 빠진 내용 · 최종 답변을 정리해 주세요. [ChatGPT] … [DeepSeek] … [Perplexity] …' }, { role: 'ai', text: S.SYNTH_ANSWER }]);
  }
  const typing = scene === '02-ask-all' && id === 'perplexity';
  return chatPage(s.name, s.color, [{ role: 'user', text: S.QUESTION }, ...(typing ? [] : [{ role: 'ai', text: S.ANSWERS[id] || '' }])], { typing });
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('screenshots');
  ses.protocol.handle('shot', (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/__chat') return new Response(appChat(u.searchParams.get('id'), u.searchParams.get('scene')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
  });
  // 사이드탭 iframe이 여는 서비스 주소 → 테스트용 채팅 페이지
  ses.protocol.handle('https', (req) => {
    const host = new URL(req.url).hostname;
    const name = { 'gemini.google.com': 'Gemini', 'claude.ai': 'Claude', 'chatgpt.com': 'ChatGPT' }[host] || host;
    const color = { Gemini: '#4285f4', Claude: '#d97757', ChatGPT: '#10a37f' }[name] || '#888';
    const msgs = [
      { role: 'user', text: `다음은 내가 지금 보고 있는 웹페이지 「AI 반도체 수출 30% 증가」의 본문입니다. … 질문: ${'이 기사 세 줄로 요약해줘'}` },
      { role: 'ai', text: name === 'Gemini' ? '1. 이번 분기 AI 반도체 수출이 1년 전보다 30% 늘었습니다.\n2. 고대역폭 메모리(HBM)가 증가분의 절반을 차지했습니다.\n3. 정부는 하반기에도 증가세가 이어질 것으로 봅니다.' : '' },
    ].filter((m) => m.text);
    return new Response(chatPage(name, color, msgs, { typing: name !== 'Gemini' }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });

  fs.mkdirSync(OUT, { recursive: true });
  const done = []; // 창은 끝에 한꺼번에 닫는다 (장면마다 닫으면 다음 창이 화면 파일을 못 읽는 일이 있었음)
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.js'));
  for (const scene of SCENES.filter((s) => !only.length || only.includes(s.name))) {
    const win = new BrowserWindow({
      width: scene.width || 1400,
      height: 860,
      show: false,
      useContentSize: true,
      backgroundColor: '#0d1117',
      webPreferences: {
        session: ses,
        preload: path.join(__dirname, scene.page === 'side' ? 'preload-side.js' : 'preload-app.js'),
        contextIsolation: false, // 가짜 본체를 화면 코드와 같은 window에 둔다 (이 도구 전용)
        sandbox: false,
        nodeIntegration: false,
        offscreen: true, // 화면에 띄우지 않고 그린다 — 그린 그림(paint)을 그대로 저장
      },
    });
    let last = null;
    win.webContents.on('paint', (_e, _dirty, image) => (last = image));
    win.webContents.setFrameRate(10);
    const ready = new Promise((resolve) => win.webContents.ipc.once('shot:ready', resolve));
    const url = scene.page === 'side' ? 'shot://repo/extension/sidepanel.html' : 'shot://repo/src/renderer/index.html';
    await win.loadURL(`${url}?scene=${scene.name}`).catch((err) => console.warn(scene.name, 'load:', err.message));
    await Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]);
    await new Promise((r) => setTimeout(r, 400));
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    const img = last;
    if (!img || img.isEmpty()) throw new Error(`${scene.name}: 그린 화면이 없습니다`);
    fs.writeFileSync(path.join(OUT, `${scene.name}.png`), img.toPNG());
    console.log('saved', `${scene.name}.png`, img.getSize());
    done.push(win);
  }
  for (const w of done) w.destroy();
  app.quit();
});

