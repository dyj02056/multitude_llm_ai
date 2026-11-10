'use strict';

// 스크린샷용 예시 데이터와 "테스트용 채팅 페이지" (실제 AI 사이트 대신 패널 안에 그린다).
// 실제 서비스 화면은 저작권 · 개인 정보 때문에 찍지 않는다 — 패널 안은 항상 이 가짜 페이지다.

const QUESTION = 'Python과 JavaScript의 차이를 표로 정리해 줘';

const ANSWERS = {
  gemini: `두 언어 모두 배우기 쉽지만 쓰임새가 다릅니다.

| 구분 | Python | JavaScript |
|---|---|---|
| 주 용도 | 데이터 분석 · AI · 자동화 | 웹 화면 · 서버(Node.js) |
| 실행 | 인터프리터 | 브라우저 · Node.js |
| 타입 | 동적, 타입 힌트 | 동적, TypeScript로 정적 |

처음 배운다면 하고 싶은 일에 맞춰 고르세요.`,
  chatgpt: `핵심 차이를 표로 정리하면 다음과 같습니다.

| 항목 | Python | JavaScript |
|---|---|---|
| 문법 | 들여쓰기로 블록 | 중괄호 { } |
| 비동기 | asyncio | Promise · async/await |
| 패키지 | pip · PyPI | npm |

웹 프런트엔드는 JavaScript가 사실상 유일한 선택입니다.`,
  deepseek: `요약하면 Python은 "읽기 쉬운 범용 언어", JavaScript는 "웹의 언어"입니다.

| 기준 | Python | JavaScript |
|---|---|---|
| 성능 | 느린 편 (C 확장으로 보완) | V8 JIT로 빠른 편 |
| 생태계 | NumPy · PyTorch | React · Vue |`,
  perplexity: `출처를 종합하면 다음과 같습니다.

| 비교 | Python | JavaScript |
|---|---|---|
| 처음 나온 해 | 1991 | 1995 |
| 인기 분야 | AI · 과학 계산 | 웹 · 모바일(React Native) |

두 언어를 함께 쓰는 경우도 많습니다 (백엔드 Python + 프런트엔드 JS).`,
  claude: `둘 다 동적 타입 언어지만 설계 목적이 다릅니다.

| | Python | JavaScript |
|---|---|---|
| 철학 | 한 가지 분명한 방법 | 유연함 · 하위 호환 |
| 숫자 | int · float 구분 | Number 하나 (+BigInt) |`,
};

const ANALYSIS_MD = `## 공통 의견
- Python은 데이터 분석 · AI · 자동화, JavaScript는 웹 화면과 Node.js 서버에 주로 쓰인다
- 둘 다 동적 타입 언어다

## 이견
| 쟁점 | Gemini | ChatGPT | DeepSeek | Perplexity | 판단 |
|---|---|---|---|---|---|
| 성능 | 언급 없음 | 언급 없음 | JS가 V8로 빠른 편 | 언급 없음 | DeepSeek 설명이 대체로 맞음 (작업에 따라 다름) |
| 처음 배울 언어 | 목적에 맞춰 | 웹이면 JS | 언급 없음 | 함께 쓰기도 | 목적에 따라 고르는 것이 맞음 |

## 근거 부족
- Perplexity: "출처를 종합하면" — 출처를 밝히지 않음

## 최종 답변
Python은 데이터 · AI · 자동화에, JavaScript는 웹 프런트엔드와 Node.js 서버에 강합니다. 문법(들여쓰기 vs 중괄호), 패키지(pip vs npm), 비동기 방식이 다르고, 성능은 V8을 쓰는 JavaScript가 대체로 빠르지만 작업에 따라 다릅니다.`;

const SYNTH_ANSWER = `세 답변을 비교해 정리했습니다.

**오류**: 없음. **빠진 내용**: 성능 비교는 DeepSeek만 언급.

**최종 답변**: Python은 데이터 · AI, JavaScript는 웹에 강하며, 문법 · 패키지 관리 · 비동기 방식이 다릅니다.`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 아주 단순한 Markdown → HTML (표 · 굵게 · 문단만) */
function md(text) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[-\s|]+\|$/.test(r));
      out.push(`<table>${body.map((r, k) => `<tr>${cells(r).map((c) => (k ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join('')}</tr>`).join('')}</table>`);
    } else if (l.trim()) out.push(`<p>${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`);
  }
  return out.join('');
}

/** 테스트용 채팅 페이지 HTML (패널 · 사이드탭 iframe 안에 들어감). messages: [{ role: 'user'|'ai', text }] */
function chatPage(name, color, messages, { typing = false, input = '' } = {}) {
  const msgs = messages
    .map((m) => (m.role === 'user' ? `<div class="u">${esc(m.text)}</div>` : `<div class="a">${md(m.text)}</div>`))
    .join('');
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#1e1f22;color:#e3e3e3;font:13px/1.55 "Segoe UI","Malgun Gothic",sans-serif}
  .wrap{display:flex;flex-direction:column;height:100%}
  .top{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #2f3136;font-weight:600}
  .top i{width:10px;height:10px;border-radius:50%;background:${color}}
  .top small{margin-left:auto;color:#8e9297;font-weight:400}
  .msgs{flex:1;overflow:hidden;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
  .u{align-self:flex-end;max-width:80%;background:#2b2d31;padding:8px 12px;border-radius:14px}
  .a p{margin:0 0 6px} .a table{border-collapse:collapse;margin:4px 0 8px;font-size:12px} .a th,.a td{border:1px solid #3a3d42;padding:3px 7px;text-align:left}
  .dots{color:#8e9297} .in{margin:8px 12px 12px;border:1px solid #3a3d42;border-radius:18px;padding:9px 14px;color:${input ? '#e3e3e3' : '#8e9297'}}
  </style><div class="wrap"><div class="top"><i></i>${esc(name)}<small>테스트용 채팅 페이지</small></div>
  <div class="msgs">${msgs}${typing ? '<div class="dots">답변 작성 중…</div>' : ''}</div><div class="in">${esc(input || '메시지 입력')}</div></div>`;
}

module.exports = { QUESTION, ANSWERS, ANALYSIS_MD, SYNTH_ANSWER, chatPage };
