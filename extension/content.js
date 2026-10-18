'use strict';

// 서비스 페이지 안에서 실행된다 (content script).
// Multitude LLM 탭의 패널 iframe으로 열렸을 때만 동작하고, 일반 탭으로 연 사이트에서는 아무것도 하지 않는다.
// 앱 탭(host.js)의 요청을 받아 질문을 넣고 보내고, 답변을 읽어 돌려준다.

(() => {
  const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  let embedded = false;
  try {
    // 앱 탭 바로 아래 iframe일 때만 (사이트가 자기 안에 띄운 iframe은 빼고)
    embedded = window !== window.top && window.parent === window.top && location.ancestorOrigins?.[0] === EXT_ORIGIN;
  } catch {}
  if (!embedded) return;

  const { pageFocusInput, pageClickSend, pageSnapshot, pageIsLoggedOut } = MLA.page;
  const { htmlToMarkdown } = MLA.markdown;
  const { shortcutFor } = MLA.shortcuts;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (msg) => chrome.runtime.sendMessage({ ...msg, host: location.hostname }).catch(() => {});
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const findInput = (cfg) => cfg.input.flatMap((s) => [...document.querySelectorAll(s)]).find(visible) || null;
  const isField = (el) => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  const fieldText = (el) => (isField(el) ? el.value : el.innerText || '');
  // 줄바꿈·공백 처리는 편집기마다 달라서 공백을 빼고 앞부분만 비교한다.
  const squash = (s) => s.replace(/\s+/g, '');
  const hasText = (el, text) => squash(fieldText(el)).includes(squash(text).slice(0, 40));

  post({ type: 'mla:hello', url: location.href });

  // 사이트 안에서 주소가 바뀌면(새 대화, 로그인 이동 등) 앱에 알린다.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    post({ type: 'mla:nav', url: lastUrl });
  }, 1000);

  // 패널 안에 커서가 있어도 앱 단축키가 동작하도록 가로채서 앱에 넘긴다.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      const input = { type: 'keyDown', key: e.key, code: e.code, control: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey };
      const action = shortcutFor(input, { canEscape: false, browser: true });
      if (!action) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post({ type: 'mla:key', action });
    },
    true,
  );

  /** 입력창에 글을 넣는다. textarea와 편집기(ProseMirror · Quill · Lexical)를 모두 다룬다. */
  async function insertText(el, text) {
    if (isField(el)) {
      el.focus();
      el.select(); // 이미 적혀 있던 내용은 바꿔 쓴다
      document.execCommand('insertText', false, text);
      if (!hasText(el, text)) {
        // React가 값 변화를 알아채도록 원래 setter로 넣고 input 이벤트를 보낸다.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    // 편집기는 붙여넣기 이벤트를 받아 줄바꿈까지 그대로 넣어 준다.
    el.focus();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    await sleep(150);
    if (!hasText(el, text)) document.execCommand('insertText', false, text);
  }

  function pressEnter(el, combo) {
    const ctrlKey = /Ctrl\+/i.test(combo);
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ctrlKey, bubbles: true, cancelable: true }));
    }
  }

  async function send({ cfg, text }) {
    const focus = pageFocusInput(cfg);
    const el = findInput(cfg);
    if (!el) return { ok: false, error: focus.error || '입력창을 찾지 못했습니다' };

    await insertText(el, text);
    await sleep(100);
    if (!hasText(el, text)) return { ok: false, error: '입력창에 글을 넣지 못했습니다' };

    // 보내기 버튼은 글자가 들어간 뒤에야 나타나거나 활성화되는 경우가 많아 잠깐 기다리며 찾는다.
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (pageClickSend(cfg)) return { ok: true, via: 'button' };
    }

    // 버튼을 못 찾으면 Enter 키 이벤트를 보내고, 그래도 글이 남아 있으면 form을 직접 제출한다.
    el.focus();
    pressEnter(el, cfg.submitKey);
    await sleep(500);
    const form = el.closest('form');
    if (hasText(el, text) && form) form.requestSubmit();
    return { ok: true, via: 'key' };
  }

  const HANDLERS = {
    'mla:send': send,
    'mla:snapshot': ({ cfg, markdown }) => pageSnapshot(cfg, markdown ? htmlToMarkdown : null),
    'mla:loggedOut': ({ cfg }) => pageIsLoggedOut(cfg),
    'mla:focus': ({ cfg }) => {
      const el = findInput(cfg);
      el?.focus();
      return !!el;
    },
    'mla:reload': () => {
      setTimeout(() => location.reload(), 0);
      return true;
    },
    'mla:back': () => {
      history.back();
      return true;
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = HANDLERS[msg?.type];
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(msg))
      .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true; // 응답을 비동기로 보낸다
  });
})();
