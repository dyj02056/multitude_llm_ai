'use strict';

// 서비스 페이지 안에서 실행된다 (content script).
// Multitude LLM 탭의 패널 iframe으로 열렸을 때만 동작하고, 일반 탭으로 연 사이트에서는 아무것도 하지 않는다.
// 앱 탭(host.js)의 요청을 받아 질문을 넣고 보내고, 답변을 읽어 돌려준다.

// [쉽게 말하면] 각 AI 사이트 페이지 안에 들어가 일하는 "현장 직원"입니다.
// 앱 탭(host.js)이 "이 질문 넣고 보내", "지금 답변 읽어 와"라고 메시지를 보내면 그대로 해 주고 결과를 돌려줍니다.
// 앱 탭 안의 패널로 열렸을 때만 일하고, 사용자가 일반 탭으로 연 사이트에서는 아무것도 하지 않습니다.
(() => {
  const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  let embedded = false;
  try {
    // 앱 탭 바로 아래 iframe일 때만 (사이트가 자기 안에 띄운 iframe은 빼고)
    embedded = window !== window.top && window.parent === window.top && location.ancestorOrigins?.[0] === EXT_ORIGIN;
  } catch {}
  if (!embedded) return;

  const { pageFocusInput, pageRefocusInput, pageAttachFiles, pageClickSend, pageSnapshot, pageIsLoggedOut } = MLA.page;
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

  // 앱 탭이 postMessage로 넘긴 첨부 파일. 확장 프로그램 탭(바로 위 부모)에서 온 것만 받는다.
  const received = new Map(); // nonce -> File[]
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== EXT_ORIGIN || e.data?.mla !== 'files') return;
    const { nonce, files } = e.data;
    if (typeof nonce !== 'string' || !Array.isArray(files)) return;
    received.set(
      nonce,
      files.map((f) => new File([f.data], f.name, { type: f.type || '', lastModified: f.lastModified || Date.now() })),
    );
    setTimeout(() => received.delete(nonce), 120000); // 쓰지 않은 파일은 버린다
  });

  async function takeFiles(nonce) {
    // 파일(postMessage)과 보내기 요청(확장 메시지)은 다른 길로 와서 순서가 바뀔 수 있다. 잠깐 기다린다.
    for (let i = 0; i < 30 && !received.has(nonce); i++) await sleep(100);
    const files = received.get(nonce);
    received.delete(nonce);
    return files || null;
  }

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
  // 입력창에 글자 넣기. 사이트마다 편집기 종류가 달라서, 사람이 붙여넣기 한 것처럼 흉내 냅니다.
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

  /** 질문을 보낸다. upload가 있으면 먼저 첨부하고, 첨부에 실패해도 글은 보낸다. */
  // 질문 보내기: 입력창 찾기 → (파일 첨부) → 글 넣기 → 보내기 버튼 누르기 → 없으면 Enter
  async function send({ cfg, text, upload, fallbackText }) {
    const focus = pageFocusInput(cfg);
    let el = findInput(cfg);
    if (!el) return { ok: false, error: focus.error || '입력창을 찾지 못했습니다' };

    let attach;
    if (upload) {
      const files = await takeFiles(upload.nonce);
      attach = files
        ? await pageAttachFiles({ input: cfg.input, upload: upload.cfg }, files).catch((err) => ({ ok: false, error: err.message }))
        : { ok: false, error: '첨부 파일을 받지 못했습니다' };
      pageRefocusInput(cfg); // 첨부하면서 포커스가 옮겨 갔을 수 있다
      el = findInput(cfg) || el;
      // 첨부에 실패하면 예비 글(프로젝트 파일 내용을 본문에 넣은 글)을 대신 보낸다
      if (!attach.ok && typeof fallbackText === 'string' && fallbackText) {
        text = fallbackText;
        attach = { ...attach, fallback: true };
      }
      if (!text && !attach.ok) return { ok: false, error: `첨부하지 못해 보낼 내용이 없습니다 (${attach.error})` };
    }

    if (text) {
      await insertText(el, text);
      await sleep(100);
      if (!hasText(el, text)) return { ok: false, error: '입력창에 글을 넣지 못했습니다' };
    }
    const done = (via) => ({ ok: true, via, attach });

    // 보내기 버튼은 글자가 들어간 뒤에야 나타나거나 활성화되는 경우가 많아 잠깐 기다리며 찾는다 (3초).
    // 첨부가 있으면 버튼이 보이는데 꺼져 있는 동안(업로드 중)은 최대 60초까지 더 기다린다.
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const clicked = pageClickSend(cfg);
      if (clicked === true) return done('button');
      if (i >= 11 && !(attach?.ok && clicked === null)) break;
    }

    // 버튼을 못 찾으면 Enter 키 이벤트를 보내고, 그래도 글이 남아 있으면 form을 직접 제출한다.
    el.focus();
    pressEnter(el, cfg.submitKey);
    await sleep(500);
    const form = el.closest('form');
    if (text && hasText(el, text) && form) form.requestSubmit();
    return done('key');
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
