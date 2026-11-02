'use strict';
// 내보내기 (v0.14.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 답변 속 <script> · 태그가 HTML 파일에서 실행되지 않게 모두 이스케이프하는지
//   - 분석 결과가 HTML에서 이견 표로, 형식이 깨졌으면 글 그대로 들어가는지
//   - Markdown에 질문 · 분석 · 답변 · 종합이 모두 들어가는지, 파일 이름이 Windows에서 쓸 수 있는지
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/shared/export');

const ANALYSIS = [
  '## 공통 의견',
  '- Python을 추천',
  '',
  '## 이견',
  '| 쟁점 | ChatGPT | Gemini | 판단 |',
  '| --- | --- | --- | --- |',
  '| 학습 순서 | Python 먼저 | 목표에 따라 | Python 먼저가 맞음 |',
  '',
  '## 근거 부족',
  '- [Gemini] 출처 없는 통계',
  '',
  '## 최종 답변',
  'Python으로 시작하세요.',
].join('\n');

const REC = {
  id: 'r1',
  at: new Date(2026, 10, 2, 9, 30).getTime(),
  question: '첫 언어: Python vs JavaScript?\n장단점도',
  targets: ['chatgpt', 'gemini', 'claude'],
  files: [{ name: 'notes.pdf', size: 2048, type: 'application/pdf' }],
  answers: {
    chatgpt: { name: 'ChatGPT', state: 'done', text: 'plain', md: '**Python**을 추천합니다.\n\n```js\nconsole.log("<b>")\n```' },
    gemini: { name: 'Gemini', state: 'done', text: '<script>alert(1)</script> 그리고 <img src=x onerror=alert(2)>' },
    claude: { name: 'Claude', state: 'timeout', text: '' },
  },
  synth: [
    { judge: 'Claude', at: 1, text: '종합 글', md: '종합 글' },
    { judge: 'ChatGPT', at: 2, text: ANALYSIS, md: ANALYSIS, mode: 'analysis', names: ['ChatGPT', 'Gemini'] },
  ],
};

test('기록 → 문서: 답이 있는 AI만, 종합과 분석을 나눠 담는다', () => {
  const doc = E.docFromRecord(REC);
  assert.equal(doc.title, '첫 언어: Python vs JavaScript?');
  assert.deepEqual(doc.answers.map((a) => a.name), ['ChatGPT', 'Gemini']); // 시간 초과로 글이 없는 Claude는 뺀다
  assert.equal(doc.answers[0].text.startsWith('**Python**'), true); // Markdown이 있으면 그것을 쓴다
  assert.deepEqual(doc.synth.map((s) => s.judge), ['Claude']);
  assert.equal(doc.analysis.judge, 'ChatGPT');
});

test('Markdown: 질문 · 첨부 · 분석 · 답변 · 종합이 모두 들어간다', () => {
  const md = E.toMarkdown(E.docFromRecord(REC));
  for (const s of ['# 첫 언어: Python vs JavaScript?', '## 질문', '장단점도', '첨부: notes.pdf (2KB)', '## 분석 (판정 ChatGPT)', '## 이견', '## ChatGPT', '## Gemini', '## 종합 (Claude)']) {
    assert.ok(md.includes(s), s);
  }
});

test('HTML: 답변 속 태그는 실행되지 않게 이스케이프하고, 스크립트를 막는 CSP가 있다', () => {
  const html = E.toHtml(E.docFromRecord(REC));
  assert.ok(!html.includes('<script>alert(1)'), '답변의 <script>가 그대로 들어가면 안 됨');
  assert.ok(!/<img[^>]*onerror/i.test(html), '답변의 <img onerror>가 태그로 들어가면 안 됨');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;')); // 코드 블록 안도 이스케이프
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<script\b/i.test(html), 'HTML 파일에는 스크립트가 하나도 없어야 함');
  assert.ok(!/https?:\/\//.test(html.replace(/<main>[\s\S]*<\/main>/, '')), '바깥 파일(글꼴 · CSS)을 불러오지 않음');
  assert.ok(html.includes('<strong>Python</strong>')); // 굵게 · 코드 블록은 살린다
  assert.ok(html.includes('<pre><code data-lang="js">'));
});

test('HTML: 분석은 이견 표 · 공통 의견 · 근거 부족 · 최종 답변으로, 형식이 깨졌으면 글 그대로', () => {
  const html = E.toHtml(E.docFromRecord(REC));
  assert.match(html, /<th>쟁점<\/th><th>ChatGPT<\/th><th>Gemini<\/th><th>판단<\/th>/);
  assert.ok(html.includes('<td class="verdict">Python 먼저가 맞음</td>'));
  assert.ok(html.includes('<b>[Gemini]</b> 출처 없는 통계'));
  assert.ok(html.includes('<div class="answer final"><p>Python으로 시작하세요.</p></div>'));
  const broken = E.toHtml(E.docFromCompare({ question: 'q', answers: [], analysis: { judge: 'X', md: '그냥 글 <b>' } }));
  assert.ok(broken.includes('정해진 형식이 아니라서 글 그대로'));
  assert.ok(broken.includes('그냥 글 &lt;b&gt;'));
});

test('Markdown → HTML 조각: 제목 · 목록 · 표 · 문단 줄바꿈', () => {
  const h = E.mdToHtml('# 제목\n- 하나\n- 둘\n\n1. 첫째\n2. 둘째\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n첫 줄\n둘째 줄');
  assert.ok(h.includes('<h3>제목</h3>'));
  assert.ok(h.includes('<ul><li>하나</li><li>둘</li></ul>'));
  assert.ok(h.includes('<ol><li>첫째</li><li>둘째</li></ol>'));
  assert.ok(h.includes('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'));
  assert.ok(h.includes('<p>첫 줄<br>둘째 줄</p>'));
});

test('파일 이름: 날짜 + 질문 앞부분, Windows에서 못 쓰는 글자는 뺀다', () => {
  const doc = E.docFromCompare({ question: 'a/b:c*d?"e"<f>|g. ', answers: [] });
  doc.at = new Date(2026, 10, 2).getTime();
  const name = E.fileName(doc, 'html');
  assert.equal(name, '2026-11-02 a b c d e f g.html');
  assert.ok(!/[\\/:*?"<>|]/.test(name));
  assert.equal(E.fileName({ ...doc, title: '   ' }, 'md'), '2026-11-02 답변.md');
});
