'use strict';

// 질문 템플릿. {q} 자리에 입력창에 쓴 내용이 들어간다.
// hint: 템플릿을 고르면 입력창 안내 문구로 보여 준다.
window.TEMPLATES = [
  { id: 'none', name: '템플릿 없음', text: '{q}', hint: '모든 AI에게 한 번에 물어보기' },
  {
    id: 'summary',
    name: '요약',
    text: '다음 내용을 핵심만 간결하게 요약해 줘.\n\n{q}',
    hint: '요약할 내용을 붙여 넣으세요',
  },
  {
    id: 'explain',
    name: '쉽게 설명',
    text: '다음을 초보자도 이해할 수 있게 쉽게 설명해 줘. 비유나 예시를 들어 줘.\n\n{q}',
    hint: '설명이 필요한 개념이나 내용을 쓰세요',
  },
  {
    id: 'step',
    name: '단계별 사고',
    text: '{q}\n\n단계별로 차근차근 생각해서 답해 줘.',
    hint: '단계별로 풀어야 할 질문을 쓰세요',
  },
  {
    id: 'proscons',
    name: '장단점 비교',
    text: '{q}\n\n장점과 단점을 표로 비교하고 최종 추천을 해 줘.',
    hint: '비교할 대상을 쓰세요 (예: React vs Vue)',
  },
  {
    id: 'factcheck',
    name: '팩트 체크',
    text: '다음 내용이 사실인지 확인해 줘. 틀린 부분이 있으면 근거와 함께 알려 줘.\n\n{q}',
    hint: '확인할 주장이나 글을 붙여 넣으세요',
  },
  {
    id: 'to-en',
    name: '영어로 번역',
    text: '다음을 자연스러운 영어로 번역해 줘.\n\n{q}',
    hint: '영어로 옮길 글을 붙여 넣으세요',
  },
  {
    id: 'to-ko',
    name: '한국어로 번역',
    text: '다음을 자연스러운 한국어로 번역해 줘.\n\n{q}',
    hint: '한국어로 옮길 글을 붙여 넣으세요',
  },
  {
    id: 'code-review',
    name: '코드 리뷰',
    text: '다음 코드를 리뷰해 줘. 버그, 보안, 성능, 가독성 순으로 지적하고, 수정한 코드는 diff가 아니라 파일마다 수정한 전체 내용을 코드 블록 하나로 보여 줘.\n\n{q}',
    hint: '리뷰할 코드를 붙여 넣으세요',
  },
];

/** 템플릿을 적용한 실제 질문 글. 템플릿에 {q}가 없으면 맨 뒤에 붙인다. */
window.applyTemplate = (tpl, q) => (tpl.text.includes('{q}') ? tpl.text.split('{q}').join(q) : `${tpl.text}\n\n${q}`);
