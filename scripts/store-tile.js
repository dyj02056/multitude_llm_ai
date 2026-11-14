'use strict';

// 크롬 웹 스토어 "작은 홍보 타일"(440×280)을 store/promo-tile-440x280.png로 만든다.
//   npx electron scripts/store-tile.js
// 앱과 같은 검정 단색 · 고정폭 글꼴 느낌으로, 아이콘(build/icon.png) + 이름 + 한 줄 소개.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'store', 'promo-tile-440x280.png');
const icon = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'build', 'icon.png')).toString('base64')}`;

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:440px;height:280px;background:#0d1117;color:#e6edf3;overflow:hidden}
  body{font-family:Consolas,'Cascadia Mono','Courier New',monospace;box-sizing:border-box;border:1px solid #30363d;padding:28px 30px}
  .row{display:flex;align-items:center;gap:16px}
  img{width:64px;height:64px}
  h1{font-size:28px;margin:0;letter-spacing:.5px}
  .dot{color:#3fb950}
  p{margin:22px 0 0;font-size:15px;line-height:1.55;color:#c9d1d9}
  .tags{margin-top:18px;font-size:12px;color:#8b949e}
  .tags span{border:1px solid #30363d;padding:2px 6px;margin-right:6px}
</style><body>
  <div class="row"><img src="${icon}"><h1><span class="dot">●</span> multitude</h1></div>
  <p>❯ Ask up to 6 AI chats at once.<br>&nbsp;&nbsp;Compare, merge and apply.</p>
  <div class="tags"><span>Gemini</span><span>ChatGPT</span><span>Claude</span><span>+8</span></div>
</body>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 440, height: 280, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  let last = null;
  win.webContents.on('paint', (_e, _d, image) => (last = image));
  win.webContents.setFrameRate(10);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 600));
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 300));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, last.resize({ width: 440, height: 280 }).toPNG());
  console.log('saved', path.relative(ROOT, OUT), last.getSize());
  app.quit();
});
