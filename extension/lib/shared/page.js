// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/page.js)
// 서비스 페이지 안에서 실행되는 함수들.
// Electron 앱은 toString()으로 페이지에 주입하고(executeJavaScript), 크롬 확장 프로그램은 content script에서 바로 부른다.
// 그래서 함수마다 바깥 변수를 쓰면 안 된다 (필요한 것은 함수 안에 둔다).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.page)이 같이 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).page = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 입력창을 찾아 포커스를 주고 적혀 있던 내용을 지운다. cfg: { input } */
  function pageFocusInput(cfg) {
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    // 같은 셀렉터에 숨은 요소가 먼저 걸리는 사이트가 있어 보이는 것을 고른다.
    const input = cfg.input.flatMap((s) => [...document.querySelectorAll(s)]).find(visible);
    if (!input) return { ok: false, error: '입력창을 찾지 못했습니다' };
    input.focus();
    // 이미 적혀 있던 내용은 지우고 새로 쓴다.
    document.execCommand('selectAll');
    document.execCommand('delete');
    return { ok: document.activeElement === input || input.contains(document.activeElement) };
  }

  /** 보내기 버튼을 찾아 누른다. 찾았으면 true. cfg: { send, sendText, dry } */
  function pageClickSend(cfg) {
    const usable = (el) =>
      !!el &&
      !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true' &&
      // Tailwind의 "disabled:opacity-50" 같은 클래스는 상태가 아니라서 걸러내지 않는다.
      !/(^|\s)([\w-]*--)?disabled(\s|$)/.test(String(el.className));
    let btn = cfg.send.flatMap((s) => [...document.querySelectorAll(s)]).find(usable);
    if (!btn && cfg.sendText) {
      const re = new RegExp(cfg.sendText, 'i');
      btn = [...document.querySelectorAll('button,[role="button"]')].find(
        (el) => usable(el) && re.test(String(el.innerText || el.getAttribute('aria-label') || '').trim()),
      );
    }
    if (!btn) return false;
    if (!cfg.dry) btn.click();
    return true;
  }

  /**
   * 지금 상태: { stop: 중지 버튼이 보이는지, count: 답변 덩어리 수, text: 최신 답변 글, md: Markdown }
   * cfg: { stop, response, messages }. toMarkdown이 있으면 최신 답변을 Markdown으로도 바꿔 md에 담는다.
   */
  function pageSnapshot(cfg, toMarkdown) {
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const stop = cfg.stop.some((s) => [...document.querySelectorAll(s)].some(visible));
    let list = [];
    // 메시지 블록에 역할 이름(USER/ASSISTANT)이 붙는 사이트는 역할로 고른다.
    if (cfg.messages) {
      const re = new RegExp(cfg.messages.role, 'i');
      list = [...document.querySelectorAll(cfg.messages.container)]
        .filter((el) => visible(el) && re.test(el.innerText.trim()))
        .map((el) => el.querySelector(cfg.messages.content) || el);
    }
    for (const s of list.length ? [] : cfg.response) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) {
        // 넓게 잡는 셀렉터([class*="markdown"] 등)는 답변 안쪽 요소까지 걸린다. 가장 바깥 것만 남긴다.
        list = els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
        break;
      }
    }
    const last = list[list.length - 1];
    const text = last ? textWithoutButtons(last) : '';
    const md = toMarkdown && last ? toMarkdown(last) : undefined;
    return { stop, count: list.length, text, md };

    // 답변 안의 버튼 글자("예", "복사" 등)는 빼고 읽는다.
    // innerText는 화면에 붙어 있어야 줄바꿈이 살아서, 복제본을 화면 밖에 잠깐 붙였다가 뗀다.
    function textWithoutButtons(el) {
      if (!el.querySelector('button,[role="button"]')) return el.innerText.trim();
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button,[role="button"]').forEach((b) => b.remove());
      Object.assign(clone.style, { position: 'fixed', left: '-100000px', top: '0', width: `${el.clientWidth}px` });
      document.body.appendChild(clone);
      const text = clone.innerText.trim();
      clone.remove();
      return text;
    }
  }

  /** 로그아웃 상태인지. cfg: 서비스 설정 (loggedOut 사용) */
  function pageIsLoggedOut(cfg) {
    const visible = (el) =>
      !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
      getComputedStyle(el).visibility !== 'hidden';
    const label = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    const lo = cfg.loggedOut || {};
    if (lo.url && new RegExp(lo.url).test(location.href)) return true;
    if ((lo.selectors || []).some((s) => visible(document.querySelector(s)))) return true;
    if (lo.text) {
      const re = new RegExp(lo.text, 'i');
      if ([...document.querySelectorAll('button,a,[role="button"]')].some((el) => visible(el) && re.test(label(el)))) return true;
    }
    return false;
  }

  return { pageFocusInput, pageClickSend, pageSnapshot, pageIsLoggedOut };
});
