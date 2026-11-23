'use strict';

// 스크린샷용 가짜 미리보기 창 (v0.44.0) — 진짜 도구 줄(src/renderer/preview.html · preview.js)에 가짜 window.pv를 붙이고,
// 실제 앱에서는 WebContentsView가 덮는 아래쪽에 예시 앱 페이지(shot://repo/__demo)를 iframe으로 띄운다.
//   81-preview: 문제 없음 · 82-preview-errors: 콘솔 오류 2 · 실패한 요청 1, 콘솔 오류 자세히를 펼침
const { ipcRenderer } = require('electron');

const scene = new URLSearchParams(location.search).get('scene') || '81-preview';
const LANG = process.env.MLA_SHOT_LANG === 'en' ? 'en' : 'ko';
const ERR = scene === '82-preview-errors';
const url = 'http://localhost:5173/';
const listeners = [];
const st = {
  open: true,
  home: url,
  url: ERR ? 'http://localhost:5173/users/42' : url,
  title: 'demo-app',
  loading: false,
  loadError: null,
  blank: false,
  canBack: ERR,
  canForward: false,
  notice: '',
  errors: ERR ? [{ text: "TypeError: Cannot read properties of undefined (reading 'name')\n    at UserCard (UserCard.jsx:12:31)", source: 'http://localhost:5173/src/UserCard.jsx:12', count: 2 }] : [],
  failed: ERR ? [{ url: 'http://localhost:5173/api/users/42', status: 500, kind: 'xhr', count: 1 }] : [],
};
window.pv = {
  lang: LANG,
  state: async () => st,
  nav: async () => true,
  external: async () => true,
  details: async (open) => {
    const f = document.getElementById('shotSite');
    if (f) f.style.top = open ? '296px' : '76px';
    return true;
  },
  onState: (fn) => listeners.push(fn),
};

window.addEventListener('DOMContentLoaded', async () => {
  const f = document.createElement('iframe');
  f.id = 'shotSite';
  f.src = `shot://repo/__demo?scene=${scene}`;
  f.style.cssText = 'position:fixed;left:0;right:0;bottom:0;top:76px;width:100%;height:calc(100% - 76px);border:0;background:#fff';
  document.body.append(f);
  await new Promise((r) => setTimeout(r, 400));
  if (ERR) document.getElementById('pvErrors')?.click();
  await new Promise((r) => setTimeout(r, 300));
  ipcRenderer.send('shot:ready');
});
