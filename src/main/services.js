'use strict';

// 서비스 목록. 로그인은 항상 "Google로 계속하기"로 한다.
// loggedOut: 로그아웃 상태를 알아보는 단서 (url 정규식 / CSS 셀렉터 / 버튼 문구 정규식).
// loginButton: Google 버튼이 바로 보이지 않을 때 먼저 눌러야 하는 "로그인" 버튼.
// input / send: 질문 입력창과 보내기 버튼 후보 셀렉터 (앞에서부터 처음 보이는 것을 쓴다).
// sendText: 셀렉터로 못 찾을 때 버튼 글자로 찾는 정규식.
// submitKey: 보내기 버튼을 못 찾았을 때 누를 키 ('Enter' | 'Ctrl+Enter').
// stop: 답변을 쓰는 중에만 보이는 "중지" 버튼 후보. response: AI 답변 덩어리 후보 (마지막 것이 최신 답변).
// messages: 역할 표시로 답변을 고르는 사이트용 { container, role(정규식), content }.
// newChatUrl: "새 대화"로 열 주소.
module.exports = [
  {
    id: 'gemini',
    name: 'Gemini',
    color: '#4f8df5',
    url: 'https://gemini.google.com/app',
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
    loggedOut: { url: '/sign_in' },
    input: ['textarea[name="search"]', 'textarea#chat-input', 'textarea'],
    send: ['div.ds-button--primary[role="button"]'],
    submitKey: 'Enter',
    stop: [],
    response: ['.ds-markdown'],
    newChatUrl: 'https://chat.deepseek.com/',
  },
  {
    id: 'groq',
    name: 'Groq',
    color: '#f55036',
    // chat.groq.com은 약관 동의가 필요한 모델(TTS 등)로 열리기도 해서 개발자 콘솔 플레이그라운드를 쓴다.
    url: 'https://console.groq.com/playground',
    loggedOut: { url: '^https://console\\.groq\\.com/(login|sign)', text: '^(sign in to groq|log ?in|sign ?in)$' },
    input: ['textarea#message_input_initial-message', 'textarea[placeholder*="user message" i]', 'textarea'],
    send: [],
    sendText: '^submit$',
    submitKey: 'Ctrl+Enter',
    stop: ['button[aria-label*="stop" i]'],
    // 플레이그라운드는 메시지마다 USER/ASSISTANT 표시가 붙는다. ASSISTANT 블록의 본문만 쓴다.
    messages: { container: 'div.relative.group', role: '^assistant', content: 'div.pl-3.overflow-x-hidden' },
    response: [],
    newChatUrl: 'https://console.groq.com/playground',
  },
];
