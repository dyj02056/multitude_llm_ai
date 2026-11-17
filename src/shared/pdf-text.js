// PDF 본문 읽기 (v0.37.0, 크롬 확장 전용): 사이드탭이 보고 있는 PDF의 글을 pdf.js(vendor/pdf.min.mjs)로 꺼낸다.
// pdf.js는 사이드 패널 화면에서 import()로 불러 이 함수에 넘긴다 (테스트는 가짜 pdf.js로도 돌린다).
// 글을 읽기만 한다 — 그림 · 표 모양은 만들지 않고, 스캔한 PDF(글자가 그림인 것)는 글이 없어서 "글이 없음"으로 알린다.
// Electron 앱 테스트(require)와 크롬 확장(전역 MLA.pdfText)이 같이 쓴다.
//
// [쉽게 말하면] PDF를 열어 쪽마다 글을 모아 "[1쪽] …" 모양의 긴 글 하나로 만드는 부품입니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).pdfText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_BYTES = 30 * 1024 * 1024; // 이보다 큰 PDF는 읽지 않는다
  const MAX_PAGES = 150;
  const MAX_CHARS = 300000; // 사이드탭 본문 상한(side-panel.js MAX_PAGE)과 같게

  const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

  /** base64 글 → Uint8Array (모양이 틀리면 code 'base64') */
  function base64ToBytes(b64) {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw fail('base64');
    const s = atob(b64);
    if (s.length > MAX_BYTES) throw fail('big', { bytes: s.length });
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /**
   * 페이지 안에서 실행 (executeScript func): 그 탭이 보고 있는 PDF를 같은 주소로 받아 base64로 → { b64 } | { error }
   * 이 함수는 문자열로 옮겨져 페이지에서 돌므로 이 파일 안의 다른 값을 쓰면 안 된다 (파일 크기 상한 30MB).
   */
  async function fetchSelfBase64() {
    try {
      if (location.protocol === 'file:') {
        // 로컬 파일은 확장의 "파일 URL 허용"을 켜야 읽힌다
      }
      const res = await fetch(location.href, { credentials: 'include' });
      if (!res.ok) return { error: `http ${res.status}` };
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 30 * 1024 * 1024) return { error: 'big' };
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { b64: btoa(s) };
    } catch (err) {
      return { error: location.protocol === 'file:' ? 'file' : String((err && err.message) || err) };
    }
  }

  /** 쪽 하나의 글 조각들 → 글 (hasEOL이면 줄바꿈, 공백 정리) */
  function joinItems(items) {
    let out = '';
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it.str !== 'string') continue;
      out += it.str;
      if (it.hasEOL) out += '\n';
      else if (it.str && !/\s$/.test(it.str)) out += ' ';
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  /**
   * PDF 글 꺼내기. pdfjs: pdf.js 모듈 ({ getDocument }), bytes: Uint8Array
   * opts: { maxPages, maxChars, cMapUrl, label(n) → 쪽 머리표 글 }
   * → { text, pages(읽은 쪽 수), totalPages, truncated, empty }
   * 실패하면 code가 있는 Error: password(암호가 걸림) · invalid(PDF가 아니거나 깨짐) · big · read
   */
  async function extractPdfText(pdfjs, bytes, { maxPages = MAX_PAGES, maxChars = MAX_CHARS, cMapUrl, label = (n) => `[p.${n}]` } = {}) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw fail('invalid');
    if (bytes.length > MAX_BYTES) throw fail('big', { bytes: bytes.length });
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, cMapUrl, cMapPacked: true, verbosity: 0 }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') throw fail('password');
      if (err && (err.name === 'InvalidPDFException' || err.name === 'FormatError' || err.name === 'MissingPDFException')) throw fail('invalid');
      throw fail('read', { detail: err && err.message });
    }
    try {
      const total = doc.numPages;
      const limit = Math.min(total, maxPages);
      const parts = [];
      let chars = 0;
      let pages = 0;
      let truncated = total > limit;
      for (let n = 1; n <= limit; n++) {
        const page = await doc.getPage(n);
        const body = joinItems((await page.getTextContent()).items);
        page.cleanup?.();
        pages = n;
        if (!body) continue;
        const piece = `${label(n)}\n${body}`;
        if (chars + piece.length > maxChars) {
          const room = maxChars - chars;
          if (room > 200) parts.push(piece.slice(0, room));
          truncated = true;
          break;
        }
        parts.push(piece);
        chars += piece.length + 2;
      }
      const text = parts.join('\n\n');
      return { text, pages, totalPages: total, truncated, empty: !text.trim() };
    } catch (err) {
      throw fail('read', { detail: err && err.message });
    } finally {
      try {
        await doc.destroy();
      } catch {}
    }
  }

  return { MAX_BYTES, MAX_PAGES, MAX_CHARS, fetchSelfBase64, base64ToBytes, joinItems, extractPdfText };
});
