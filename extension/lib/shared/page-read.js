// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/page-read.js)
// 보고 있는 탭에서 글 읽기 (v0.37.0, 크롬 확장 전용): 본문 · PDF · 영상 자막을 구분하는 부분.
// readPageNow는 chrome.scripting.executeScript의 func로 그 페이지 안에서 실행된다 (바깥 변수를 쓰지 않는 한 함수).
// pickContext는 읽은 결과가 PDF인지 · 자막이 있는지 · 그냥 본문인지 정한다 (페이지 밖에서 계산).
// Electron 앱 테스트(require)와 크롬 확장(전역 MLA.pageRead)이 같이 쓴다.
//
// [쉽게 말하면] "이 탭은 보통 글인지, PDF인지, 자막이 있는 영상인지"를 가려서 맞는 글을 가져오게 하는 부품입니다.
//   - 자막은 페이지에 이미 떠 있는 것만 읽습니다: 열려 있는 스크립트(YouTube "스크립트 표시") · 켜져 있는 HTML5 자막 트랙.
//     자막을 따로 내려받거나 영상 사이트의 주소를 불러 가지 않고, 자막 설정(켜기 · 끄기)도 바꾸지 않습니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).pageRead = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_CAPTION_CHARS = 40; // 자막으로 칠 최소 글자 수 (짧은 한 줄은 본문을 대신하지 않는다)

  /**
   * 페이지 안에서 실행 (executeScript func): { title, url, contentType, text(본문), captions(이미 떠 있는 자막, 없으면 '') }
   * 이 함수는 문자열로 옮겨져 페이지에서 돌므로 이 파일 안의 다른 값을 쓰면 안 된다.
   */
  function readPageNow() {
    const MAX = 400000;
    const out = { title: document.title, url: location.href, contentType: document.contentType || '', text: '', captions: '' };
    try {
      out.text = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, MAX);
    } catch {}
    try {
      const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      const lines = [];
      // 열려 있는 스크립트 패널 (YouTube "스크립트 표시")
      for (const seg of document.querySelectorAll('ytd-transcript-segment-renderer')) {
        const ts = seg.querySelector('.segment-timestamp');
        const tx = seg.querySelector('.segment-text');
        const text = tx && tx.textContent ? tx.textContent.replace(/\s+/g, ' ').trim() : '';
        const time = ts && ts.textContent ? ts.textContent.trim() : '';
        if (text) lines.push(time ? `${time} ${text}` : text);
      }
      // 이미 켜져 있어 읽을 수 있는 HTML5 자막 트랙 (모드를 바꾸지 않는다 — 꺼진 트랙은 읽지 않음)
      if (!lines.length) {
        for (const v of document.querySelectorAll('video')) {
          for (const tr of Array.from(v.textTracks || [])) {
            if ((tr.kind !== 'subtitles' && tr.kind !== 'captions') || tr.mode === 'disabled' || !tr.cues || !tr.cues.length) continue;
            for (const c of Array.from(tr.cues)) {
              const text = String(c.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
              if (text) lines.push(`${mmss(c.startTime)} ${text}`);
            }
            if (lines.length) break;
          }
          if (lines.length) break;
        }
      }
      out.captions = lines.join('\n').slice(0, MAX);
    } catch {}
    return out;
  }

  /** 주소가 .pdf 로 끝나는가 (쿼리 · # 앞까지) */
  function looksPdf(url) {
    try {
      return /\.pdf$/i.test(new URL(String(url)).pathname);
    } catch {
      return false;
    }
  }

  /**
   * 읽은 결과 → 어떤 글로 쓸지:
   *   { source: 'pdf', pdf: true, title, url }            — PDF (글은 사이드 패널이 pdf.js로 읽는다)
   *   { source: 'captions', title, url, text }            — 이미 떠 있는 자막이 MIN_CAPTION_CHARS 이상
   *   { source: 'page', title, url, text }                — 그냥 본문
   * 읽은 것이 없으면 null
   */
  function pickContext(res) {
    if (!res || typeof res !== 'object') return null;
    const base = { title: String(res.title || ''), url: String(res.url || '') };
    if (/pdf/i.test(String(res.contentType || '')) || looksPdf(res.url)) return { source: 'pdf', pdf: true, ...base };
    const captions = String(res.captions || '').trim();
    if (captions.length >= MIN_CAPTION_CHARS) return { source: 'captions', ...base, text: captions };
    const text = String(res.text || '');
    return text.trim() ? { source: 'page', ...base, text } : null;
  }

  return { MIN_CAPTION_CHARS, readPageNow, looksPdf, pickContext };
});
