// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/services.js)
// 서비스 목록. Electron 앱(require)과 크롬 확장 프로그램(<script>, 전역 MLA.services)이 같이 쓴다.
//
// 로그인은 Electron 앱에서는 "Google로 계속하기"로 자동으로 하고, 확장 프로그램에서는 크롬에 이미 로그인된 계정을 그대로 쓴다.
// hosts: 이 서비스 페이지로 보는 도메인 (확장 프로그램의 iframe 허용 규칙·페이지 연결에 쓴다).
// loggedOut: 로그아웃 상태를 알아보는 단서 (url 정규식 / CSS 셀렉터 / 버튼 문구 정규식).
// loginButton: Google 버튼이 바로 보이지 않을 때 먼저 눌러야 하는 "로그인" 버튼.
// input / send: 질문 입력창과 보내기 버튼 후보 셀렉터 (앞에서부터 처음 보이는 것을 쓴다).
// sendText: 셀렉터로 못 찾을 때 버튼 글자로 찾는 정규식.
// submitKey: 보내기 버튼을 못 찾았을 때 누를 키 ('Enter' | 'Ctrl+Enter').
// stop: 답변을 쓰는 중에만 보이는 "중지" 버튼 후보. response: AI 답변 덩어리 후보 (마지막 것이 최신 답변).
// messages: 역할 표시로 답변을 고르는 사이트용 { container, role(정규식), content }.
// newChatUrl: "새 대화"로 열 주소.
// upload: 공통 입력창에 올린 파일을 넣는 방법 (없으면 DEFAULT_UPLOAD).
//   methods: 시도 순서 'paste'(입력창에 붙여넣기) · 'input'(input[type=file]에 넣기) · 'drop'(입력창에 끌어다 놓기)
//   fileInput: 파일 선택 칸 셀렉터, attached: 첨부가 생기면 나타나는 요소, busy: 업로드 중에만 보이는 요소
//   accept: 받는 파일 종류 'image' · 'document' (그 밖의 종류는 보내지 않고 "첨부 없이 보냄"으로 알린다)
// jsCookies: 페이지 스크립트가 로그인 쿠키를 직접 읽고 쓰는 사이트 (확장 프로그램 전용, extension/cookie-*.js 참고).
//   확장 탭 안 iframe에서는 크롬이 SameSite=Lax 쿠키를 document.cookie로 보여 주지 않아 로그아웃 상태로 보인다.
// tokenBridge: 로그인 토큰을 localStorage에 두는 사이트 (확장 프로그램 전용, extension/cookie-bridge.js 참고).
//   { cookie: 서버가 같은 토큰을 넣어 두는 쿠키 이름, storage: 화면이 읽는 localStorage 키 }
//   확장 탭 안 iframe의 저장소는 일반 탭과 분리될 수 있어서, 크롬의 그 쿠키 값을 iframe의 localStorage에 넣어 준다.
//
// 새로 넣은 서비스(Perplexity·Grok·Mistral·Qwen·Genspark·Duck.ai)의 셀렉터는 실제 화면에서 다시 확인해야 한다.
// 틀린 것은 remote/selectors.json으로 앱을 다시 배포하지 않고 고칠 수 있다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).services = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SERVICES = [
    {
      id: 'gemini',
      name: 'Gemini',
      color: '#4f8df5',
      url: 'https://gemini.google.com/app',
      hosts: ['gemini.google.com'],
      loggedOut: {
        selectors: ['a[href*="accounts.google.com/ServiceLogin"]', 'a[href*="accounts.google.com/v3/signin"]'],
        text: '^(로그인|sign in)$',
      },
      input: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
      send: [
        'button[aria-label="메시지 보내기"]',
        'button[aria-label*="Send message" i]',
        'button.send-button:not(.stop)',
      ],
      submitKey: 'Enter',
      stop: ['button.send-button.stop', 'button[aria-label*="Stop response" i]', 'button[aria-label*="대답 생성 중지"]'],
      response: ['model-response message-content .markdown', 'model-response message-content', 'model-response .model-response-text'],
      newChatUrl: 'https://gemini.google.com/app',
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      color: '#10a37f',
      url: 'https://chatgpt.com/',
      hosts: ['chatgpt.com'],
      loggedOut: {
        url: '^https://auth\\.openai\\.com/',
        selectors: ['[data-testid="login-button"]'],
        text: '^(로그인|log in)$',
      },
      loginButton: '[data-testid="login-button"]',
      input: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
      send: [
        'button[data-testid="send-button"]',
        '#composer-submit-button',
        'button[type="submit"][aria-label="보내기"]',
        'button[aria-label*="Send prompt" i]',
      ],
      submitKey: 'Enter',
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop streaming" i]', 'button[aria-label*="스트리밍 중지"]'],
      response: [
        '[data-markdown-text-style="assistant-message"]',
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"]',
      ],
      newChatUrl: 'https://chatgpt.com/',
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      color: '#4d6bfe',
      url: 'https://chat.deepseek.com/',
      hosts: ['chat.deepseek.com'],
      loggedOut: { url: '/sign_in' },
      input: ['textarea[name="search"]', 'textarea#chat-input', 'textarea'],
      send: ['div.ds-button--primary[role="button"]'],
      submitKey: 'Enter',
      stop: [],
      response: ['.ds-markdown'],
      // 붙여넣기보다 파일 선택 칸이 확실하다. 이미지는 글자만 뽑아 읽는다.
      upload: { methods: ['input', 'paste', 'drop'] },
      newChatUrl: 'https://chat.deepseek.com/',
    },
    {
      id: 'perplexity',
      name: 'Perplexity',
      color: '#20b8cd',
      url: 'https://www.perplexity.ai/',
      hosts: ['www.perplexity.ai', 'perplexity.ai'],
      // 로그인하지 않아도 질문할 수 있다. 로그인 버튼이 보이면 로그아웃 상태로 본다.
      loggedOut: { text: '^(로그인|sign in|log in)$' },
      // 입력창은 Lexical 편집기(#ask-input)였다가 textarea였던 적도 있어 둘 다 둔다.
      input: ['#ask-input[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'textarea[placeholder]', 'textarea'],
      send: ['button[data-testid="submit-button"]', 'button[aria-label="Submit"]', 'button[aria-label="제출"]'],
      submitKey: 'Enter',
      stop: ['button[data-testid="stop-generating-response-button"]', 'button[aria-label="Stop"]', 'button[aria-label*="중지"]'],
      response: ['div[id^="markdown-content-"]', '.prose'],
      newChatUrl: 'https://www.perplexity.ai/',
    },
    {
      id: 'grok',
      name: 'Grok',
      color: '#b8bcc6',
      url: 'https://grok.com/',
      hosts: ['grok.com'],
      // 로그인은 accounts.x.ai에서 한다 (Google · X · Apple). 로그아웃 상태에서도 질문 화면이 열리고 "Sign in" 버튼이 보인다.
      loggedOut: { url: '^https://accounts\\.x\\.ai/', text: '^(로그인|sign in|log in)$' },
      // 입력창은 ProseMirror(tiptap) 편집기였다가 textarea였던 적도 있어 둘 다 둔다.
      input: ['div.ProseMirror[contenteditable="true"]', 'textarea[aria-label*="Grok"]', 'form textarea', 'textarea'],
      send: ['button[type="submit"][aria-label="Submit"]', 'button[type="submit"][aria-label="제출"]', 'form button[type="submit"]'],
      submitKey: 'Enter',
      stop: ['button[aria-label*="Stop" i]', 'button[aria-label*="중지"]'],
      response: ['.message-bubble .response-content-markdown', '.response-content-markdown'],
      newChatUrl: 'https://grok.com/',
    },
    {
      id: 'mistral',
      name: 'Mistral',
      color: '#fa500f',
      url: 'https://chat.mistral.ai/work',
      hosts: ['chat.mistral.ai'],
      // 로그인은 auth.mistral.ai에서 한다 (Google · Microsoft · Apple · 이메일).
      loggedOut: { url: '^https://(v2\\.)?auth\\.mistral\\.ai/', text: '^(로그인|log ?in|sign ?in|se connecter)$' },
      input: ['div.ProseMirror[contenteditable="true"]', 'textarea[name="message.text"]', 'textarea[placeholder]', 'textarea'],
      send: ['button[type="submit"][aria-label*="Send" i]', 'button[aria-label*="보내기"]', 'form button[type="submit"]'],
      submitKey: 'Enter',
      stop: ['button[aria-label*="Stop" i]', 'button[aria-label*="중지"]'],
      response: ['[data-message-author-role="assistant"] .prose', '[data-message-author-role="assistant"]', '.prose'],
      newChatUrl: 'https://chat.mistral.ai/work',
    },
    {
      id: 'qwen',
      name: 'Qwen',
      color: '#615ced',
      url: 'https://chat.qwen.ai/',
      hosts: ['chat.qwen.ai'],
      loggedOut: { url: '/auth', text: '^(로그인|log in|sign in|登录)$' },
      input: ['#chat-input', 'textarea[placeholder]', 'textarea'],
      send: ['#send-message-button', 'button.send-button', 'button[aria-label*="send" i]'],
      submitKey: 'Enter',
      stop: ['button.stop-button', 'button[aria-label*="stop" i]'],
      response: ['.response-message-content .markdown-content', '#response-content-container', '.chat-response-message .markdown-content-container', '.markdown-content'],
      upload: { methods: ['input', 'paste', 'drop'] },
      newChatUrl: 'https://chat.qwen.ai/',
      jsCookies: true,
      // Qwen 화면은 localStorage.token을 Authorization 헤더로 보내 로그인을 확인한다 (서버는 같은 값을 token 쿠키에도 둔다)
      tokenBridge: { cookie: 'token', storage: 'token' },
    },
    {
      id: 'genspark',
      name: 'Genspark',
      color: '#3d7bfd',
      // 첫 화면 검색창에서 묻는다. 보내면 답변 페이지(/agents?...)로 넘어간다.
      url: 'https://www.genspark.ai/ko',
      hosts: ['www.genspark.ai', 'genspark.ai'],
      loggedOut: { text: '^(로그인|log ?in|sign ?in|sign up|가입하기)$' },
      input: ['textarea[name="query"].search-input', 'textarea.search-input', 'textarea[placeholder]', 'textarea'],
      // 보내기 버튼 모양을 확인하지 못해 이름에 enter·send가 들어간 요소만 찾고, 못 찾으면 Enter 키로 보낸다.
      send: ['.input-icon.enter-icon', 'div.enter-icon', '[class*="enter-icon"]', 'button[type="submit"]', 'button[aria-label*="send" i]'],
      submitKey: 'Enter',
      stop: ['[class*="stop-icon"]', '[class*="stop-button"]', 'button[aria-label*="Stop" i]'],
      response: ['.conversation-statement.assistant .markdown-viewer', '.conversation-statement.assistant', '.markdown-viewer', '[class*="answer" i] [class*="markdown" i]'],
      newChatUrl: 'https://www.genspark.ai/ko',
    },
    {
      id: 'duckai',
      name: 'Duck.ai',
      color: '#de5833',
      url: 'https://duck.ai/chat',
      // duckduckgo.com/?ia=chat 주소로도 열린다.
      hosts: ['duck.ai', 'duckduckgo.com'],
      // 로그인이 없다. 처음 열면 이용 동의 화면이 한 번 뜬다 (직접 누른다).
      input: ['textarea[name="user-prompt"]', 'form textarea', 'textarea[placeholder]', 'textarea'],
      send: ['button[type="submit"][aria-label*="Send" i]', 'button[type="submit"][aria-label*="보내기"]', 'form button[type="submit"]'],
      submitKey: 'Enter',
      stop: ['button[aria-label*="Stop" i]', 'button[aria-label*="중지"]'],
      response: ['[data-activeresponse]', '[class*="assistant" i] [class*="markdown" i]', '[class*="markdown" i]', '.prose'],
      // 일부 모델만 이미지를 받는다. 문서는 받지 않는다.
      upload: { accept: ['image'] },
      newChatUrl: 'https://duck.ai/chat',
    },
  ];

  // 첨부 기본값. 서비스의 upload에 없는 항목은 이 값을 쓴다.
  const DEFAULT_UPLOAD = {
    methods: ['paste', 'input', 'drop'],
    fileInput: ['input[type="file"]'],
    attached: [
      '[data-testid*="attachment" i]',
      '[data-testid*="file-preview" i]',
      '[aria-label*="remove file" i]',
      '[aria-label*="remove attachment" i]',
      '[aria-label*="파일 삭제"]',
      '[aria-label*="첨부 파일"]',
    ],
    busy: ['[role="progressbar"]'],
    accept: ['image', 'document'],
  };
  // 공통 입력창 첨부 한도
  const ATTACH_LIMITS = { maxFiles: 10, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 };

  /** 서비스의 첨부 설정 (기본값과 합친 것) */
  const uploadOf = (svc) => ({ ...DEFAULT_UPLOAD, ...(svc.upload || {}) });
  /** 파일 종류: 'image' | 'document' */
  const fileKind = (type) => (/^image\//.test(type || '') ? 'image' : 'document');

  const MAX_SELECTED = 4; // 한 번에 열 수 있는 모델 수 (2×2 격자 / 1×4 가로)
  const DEFAULT_SELECTED = ['gemini', 'chatgpt', 'deepseek', 'perplexity'];
  const RENAMED = { groq: 'grok' }; // 예전 설정에 남은 서비스 id (없어진 poe 등은 normalizeSelected가 뺀다)

  /** 저장된 선택을 지금 서비스 목록에 맞춘다: 바뀐 id 정리, 모르는 id 제거, 최대 개수 제한. 비면 기본값. */
  function normalizeSelected(list) {
    const known = new Set(SERVICES.map((s) => s.id));
    const ids = (Array.isArray(list) ? list : [])
      .map((id) => RENAMED[id] || id)
      .filter((id, i, arr) => known.has(id) && arr.indexOf(id) === i);
    const ordered = SERVICES.map((s) => s.id).filter((id) => ids.includes(id));
    return ordered.length ? ordered.slice(0, MAX_SELECTED) : [...DEFAULT_SELECTED];
  }

  /** 주소의 호스트가 어느 서비스 것인지. 없으면 null */
  function serviceForHost(host) {
    return SERVICES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null;
  }

  return {
    SERVICES,
    MAX_SELECTED,
    DEFAULT_SELECTED,
    ATTACH_LIMITS,
    normalizeSelected,
    serviceForHost,
    uploadOf,
    fileKind,
  };
});
