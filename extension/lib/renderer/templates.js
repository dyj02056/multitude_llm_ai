// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/templates.js)
'use strict';

// 질문 템플릿. {q} 자리에 입력창에 쓴 내용이 들어간다.
// hint: 템플릿을 고르면 입력창 안내 문구로 보여 준다.
// [쉽게 말하면] 처음부터 들어 있는 "질문 양식" 목록입니다 (고칠 수 없고, 라이브러리에서 복제해 고칩니다).
// 예: "요약" 템플릿을 고르고 글을 붙여 넣으면, AI에게는 "다음 내용을 핵심만 간결하게 요약해 줘. (붙여 넣은 글)"이 갑니다.
// 항목: id(고유 이름) · name(목록에 보이는 이름) · text(실제로 보낼 글, {q} 자리에 입력한 내용) · hint(입력창 안내 글)
//
// 글은 모두 사전에서 꺼낸다 (읽을 때마다 — 화면 언어를 바꾸면 따라 바뀐다):
//   name · hint → i18n-*-library.js 'library.tpl.<id>.name|hint'
//   text        → i18n-*-prompt.js  'prompt.tpl.<id>' (AI에게 보내는 글, v0.31.0)
//   'code-review' · 'file-collect'는 답변을 "파일 모아보기"로 모으기 좋은 형식(프로젝트 모드의 답변 규칙과 같은 형식)으로 받는다.
window.TEMPLATES = ['none', 'summary', 'explain', 'step', 'proscons', 'factcheck', 'to-en', 'to-ko', 'code-review', 'file-collect'].map((id) => ({ id }));

for (const tpl of window.TEMPLATES) {
  for (const f of ['name', 'hint']) Object.defineProperty(tpl, f, { enumerable: true, get: () => MLA.i18n.t(`library.tpl.${tpl.id}.${f}`) });
  Object.defineProperty(tpl, 'text', { enumerable: true, get: () => (tpl.id === 'none' ? '{q}' : MLA.i18n.t(`prompt.tpl.${tpl.id}`)) });
}

/** 템플릿을 적용한 실제 질문 글. 템플릿에 {q}가 없으면 맨 뒤에 붙인다. */
window.applyTemplate = (tpl, q) => (tpl.text.includes('{q}') ? tpl.text.split('{q}').join(q) : `${tpl.text}\n\n${q}`);
