'use strict';

// 미리보기 창 도구 줄(preview.html)의 창구 (v0.44.0). 사이트 화면에는 붙지 않는다 (사이트 화면은 preload 없음).
// 도구 줄은 뒤로 · 앞으로 · 새로 고침 · 처음 주소 · 브라우저로 · 개발자 도구와 점검 결과 받기만 부탁할 수 있다.
const { contextBridge, ipcRenderer } = require('electron');

const lang = (() => {
  try {
    return ipcRenderer.sendSync('i18n:lang');
  } catch {
    return 'ko';
  }
})();

contextBridge.exposeInMainWorld('pv', {
  lang,
  state: () => ipcRenderer.invoke('pv:state'),
  nav: (what) => ipcRenderer.invoke('pv:nav', what), // back · forward · reload · home · devtools
  external: () => ipcRenderer.invoke('pv:external'), // 지금 주소를 기본 브라우저로 (이 PC 주소만)
  details: (open) => ipcRenderer.invoke('pv:details', !!open), // 자세히 칸을 펼치면 사이트 화면을 그만큼 내린다
  capture: () => ipcRenderer.invoke('pv:capture'), // 지금 화면을 캡처해 앱의 캡처 목록에 (v0.45.0)
  onState: (fn) => ipcRenderer.on('pv:state', (_e, st) => fn(st)),
});
