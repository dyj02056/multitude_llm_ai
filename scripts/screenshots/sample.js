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

// v0.26.0 장면: 다른 판정 AI의 분석 (다시 분석 비교) · 이어 묻기 · 토론
const ANALYSIS_MD2 = `## 공통 의견
- Python은 데이터 · AI, JavaScript는 웹에 주로 쓰인다

## 이견
| 쟁점 | Gemini | ChatGPT | DeepSeek | Perplexity | 판단 |
|---|---|---|---|---|---|
| 처음 배울 언어 | 목적에 맞춰 | 웹이면 JS | 언급 없음 | 함께 쓰기도 | 목적에 따라 고르는 것이 맞음 |
| 타입 시스템 | TypeScript로 정적 | 언급 없음 | 언급 없음 | 언급 없음 | Gemini 설명이 정확함 |

## 근거 부족
- 없음

## 최종 답변
목적에 맞춰 고르세요. 웹이면 JavaScript(필요하면 TypeScript), 데이터 · AI면 Python입니다.`;

const DEBATE_RESULT = `## 합의한 점
- 웹 프런트엔드는 JavaScript, 데이터 · AI는 Python이 표준이다
- 처음 배울 언어는 만들고 싶은 것에 맞춰 고른다

## 남은 이견
- [성능] DeepSeek은 "JS가 빠르다", ChatGPT는 "작업에 따라 다르다" — 작업에 따라 다르다는 쪽이 정확함

## 최종 답변
Python은 데이터 · AI · 자동화, JavaScript는 웹(브라우저 · Node.js)에 강합니다. 성능은 작업에 따라 다르므로 언어보다 라이브러리 선택이 더 중요합니다.`;

/** 이어 묻기 · 토론 기록 예시 (chain) */
const CHAIN = (now) => [
  { kind: 'handoff', intent: 'review', from: 'chatgpt', to: 'deepseek', fromName: 'ChatGPT', toName: 'DeepSeek', at: now - 9 * 60e3, state: 'done', text: 'ChatGPT 답변 검토:\n1) 틀린 점: 없음\n2) 빠진 점: 성능 · 타입 시스템 비교가 없습니다.\n3) 고친 답: 표에 "성능"과 "타입" 줄을 더하면 좋습니다.', md: '' },
  {
    kind: 'debate', round: 1, rounds: 2, at: now - 6 * 60e3,
    answers: [
      { id: 'chatgpt', name: 'ChatGPT', state: 'done', text: '[1라운드] DeepSeek의 "JS가 빠르다"는 작업에 따라 다릅니다. 수치 계산은 NumPy를 쓰는 Python이 더 빠를 때가 많습니다.' },
      { id: 'deepseek', name: 'DeepSeek', state: 'done', text: '[1라운드] 순수 언어 실행 속도는 V8이 빠르지만, 라이브러리를 쓰면 달라진다는 지적은 맞습니다.' },
      { id: 'perplexity', name: 'Perplexity', state: 'done', text: '[1라운드] 두 답 모두 일리가 있습니다. 처음 배울 언어는 성능보다 목적이 중요합니다.' },
    ],
  },
  {
    kind: 'debate', round: 2, rounds: 2, at: now - 3 * 60e3,
    answers: [
      { id: 'chatgpt', name: 'ChatGPT', state: 'done', text: '[2라운드] 결론: 성능은 작업에 따라 다르다는 데 동의가 모였습니다.' },
      { id: 'deepseek', name: 'DeepSeek', state: 'done', text: '[2라운드] 동의합니다. 표의 "성능" 줄을 "작업에 따라 다름"으로 고칩니다.' },
      { id: 'perplexity', name: 'Perplexity', state: 'timeout', text: '[2라운드] (시간 초과 — 지난 입장 그대로)' },
    ],
  },
];

// v0.27.0: 기록 화면 · 추천용 예시 기록 (진짜 기록장에 넣는다). 종류마다 AI별 답이 5개 넘게 쌓이도록 지난 기록을 만든다.
const HISTORY_QUESTIONS = {
  code: ['이 함수 리팩터링해 줘\n\nfunction add(a, b) { return a + b; }', 'TypeError: Cannot read properties of undefined (reading map) 원인?', 'SELECT * FROM orders WHERE id = 1 이 느린 이유', 'Python asyncio.gather 예외 처리 예시 (async def main())', 'React useEffect 무한 루프 고치기 const [x, setX] = useState()', 'git rebase 충돌 해결 순서 — app.js 파일'],
  general: ['React와 Vue 중 무엇을 먼저 배울까?', '여름 제주 3박 4일 일정 짜줘', '좋은 회의록 쓰는 법', '전세와 월세 차이', '운동 루틴 추천', '책 추천 — 데이터 과학 입문'],
};
function HISTORY(now, ids) {
  const out = [];
  let n = 0;
  const speed = { gemini: 8000, chatgpt: 11000, deepseek: 15000, perplexity: 7000, claude: 9500, duckai: 6000 };
  for (const [kind, qs] of Object.entries(HISTORY_QUESTIONS)) {
    for (let round = 0; round < 2; round++) {
      qs.forEach((q, i) => {
        n++;
        const at = now - (n * 7 + 40) * 3600e3; // 지난 며칠 ~ 몇 주
        const answers = {};
        const feedback = {};
        ids.forEach((id, j) => {
          const fail = (kind === 'code' && id === 'perplexity' && (i + round) % 3 === 0) || (id === 'deepseek' && (i + round) % 4 === 1);
          answers[id] = { state: fail ? 'timeout' : 'done', text: fail ? '' : `${id} 답변 ${n}`, md: '', metrics: { doneMs: speed[id] + j * 300 + i * 400 } };
          if (!fail && (i + j) % 4 === 0) feedback[id] = kind === 'code' && id === 'chatgpt' ? 1 : (i + j) % 8 === 0 ? 1 : -1;
        });
        out.push({
          id: `h${n}`,
          at,
          question: q,
          targets: ids,
          files: [],
          answers,
          synth: i === 1 ? [{ judge: 'Gemini', at, text: '종합', md: '종합' }] : [],
          ...(Object.keys(feedback).length ? { feedback } : {}),
          ...(i < 2 ? { threadId: `t${kind}${round}` } : {}),
          ...(i === 0 && round === 0 ? { tags: ['업무'] } : {}),
          ...(kind === 'code' && i === 0 && round === 1 ? { project: { name: 'shop-api' } } : {}),
        });
      });
    }
  }
  // 지금 기록과 같은 대화 줄기로 이어진 질문 (대화 줄기 장면)
  out.unshift({ id: 'r0', at: now - 8 * 60e3, question: '처음 프로그래밍을 배우려는데 Python과 JavaScript 중 무엇이 좋을까?', targets: ids, files: [], threadId: 'tpyjs', kind: 'general', synth: [], answers: Object.fromEntries(ids.map((id) => [id, { state: 'done', text: `하고 싶은 일에 따라 다르지만, 처음이라면 문법이 단순한 Python을 많이 권합니다.`, md: '' }])) });
  return out.sort((a, b) => b.at - a.at);
}

// v0.28.0 프로젝트 장면: 작은 예시 프로젝트와, 두 AI가 같은 파일(src/user.js)을 서로 다르게 고친 답
const PROJECT_FILES = {
  'package.json': JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { dev: 'vite', test: 'node --test', lint: 'eslint src', typecheck: 'tsc --noEmit', build: 'node build.js' } }, null, 2) + '\n',
  'README.md': '# demo-app\n\n사용자 정보를 불러오는 예시 프로젝트\n',
  'src/user.js': "export async function getUser(id) {\n  const res = await fetch(`/api/users/${id}`);\n  return res.json();\n}\n",
  'src/cache.js': 'const store = new Map();\nexport const get = (k) => store.get(k);\nexport const set = (k, v) => store.set(k, v);\n',
  'test/user.test.js': "import test from 'node:test';\n",
};
const fence = '```';
const PROJECT_ANSWERS = {
  gemini: [
    '`getUser`가 실패 응답을 그대로 돌려줍니다. 상태 코드를 확인하고 캐시를 붙였습니다.',
    '',
    '파일: src/user.js',
    `${fence}js`,
    "import { get, set } from './cache.js';",
    '',
    'export async function getUser(id) {',
    '  if (get(id)) return get(id);',
    '  const res = await fetch(`/api/users/${id}`);',
    '  if (!res.ok) throw new Error(`사용자를 불러오지 못했습니다 (${res.status})`);',
    '  const user = await res.json();',
    '  set(id, user);',
    '  return user;',
    '}',
    fence,
    '',
    '파일: src/cache.js',
    `${fence}js`,
    'const store = new Map();',
    'export const get = (k) => store.get(k);',
    'export const set = (k, v) => store.set(k, v);',
    'export const clear = () => store.clear();',
    fence,
  ].join('\n'),
  chatgpt: [
    '실패 응답을 오류로 바꾸고 테스트를 더했습니다.',
    '',
    '파일: src/user.js',
    `${fence}js`,
    'export async function getUser(id) {',
    '  const res = await fetch(`/api/users/${id}`);',
    '  if (!res.ok) {',
    '    throw new Error(`사용자를 불러오지 못했습니다 (${res.status})`);',
    '  }',
    '  return res.json();',
    '}',
    fence,
    '',
    '파일: test/user.test.js',
    `${fence}js`,
    "import test from 'node:test';",
    "import assert from 'node:assert';",
    "import { getUser } from '../src/user.js';",
    '',
    "test('없는 사용자면 오류', async () => {",
    '  await assert.rejects(getUser(-1), /불러오지 못했습니다/);',
    '});',
    fence,
  ].join('\n'),
};

/** 로드맵 장면 (v0.38.1): 진행 중인 로드맵 — 긴 한글 제목 · 같은 마일스톤 안 선행 · 막힘 · 잠김이 다 보이게 */
function roadmapSample(lang = 'ko') {
  const en = lang === 'en';
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const T = (ko, e) => (en ? e : ko);
  const task = (id, title, o = {}) => ({ id, title, desc: '', deps: [], files: [], accept: T('확인할 수 있는 조건', 'A checkable condition'), weight: 2, status: 'todo', ...o });
  return {
    version: 1,
    title: T('할 일 관리 웹앱', 'Todo web app'),
    plan: T('할 일을 추가 · 완료 · 마감일 알림까지 하는 웹앱을 만든다.', 'Build a web app to add and finish todos, with due-date reminders.'),
    createdAt: day(16),
    updatedAt: day(0),
    milestones: [
      { id: 'm1', title: T('기초 환경 구성과 데이터 모델 설계', 'Project setup and data model design'), tasks: [
        task('t1', T('프로젝트 초기 설정 및 빌드 도구 구성', 'Initial project setup and build tooling'), { status: 'done', doneAt: day(14), files: ['package.json'], commit: 'a1b2c3d' }),
        task('t2', T('데이터베이스 스키마와 마이그레이션 작성', 'Database schema and migrations'), { deps: ['t1'], weight: 3, status: 'done', doneAt: day(10), files: ['src/db.js'] }),
        task('t3', T('사용자 인증 API 구현', 'User authentication API'), { deps: ['t2'], weight: 3, status: 'verify', files: ['src/auth.js'] }),
      ] },
      { id: 'm2', title: T('화면 구현', 'Screens'), tasks: [
        task('t4', T('할 일 목록 화면', 'Todo list screen'), { deps: ['t2'], status: 'doing', files: ['src/ui/list.js'] }),
        task('t5', T('할 일 추가 · 수정 폼', 'Add and edit form'), { deps: ['t4'] }),
        task('t6', T('마감일 알림 기능', 'Due-date reminders'), { deps: ['t3'], weight: 4, status: 'blocked', note: T('알림 권한 정책 확인 필요', 'Need to check the notification permission policy') }),
      ] },
      { id: 'm3', title: T('배포와 마무리', 'Release'), tasks: [
        task('t7', T('통합 테스트와 배포 스크립트', 'Integration tests and deploy script'), { deps: ['t5', 't6'], weight: 3 }),
      ] },
    ],
    settings: { docs: true, docsWhen: 'task', readmeMode: 'separate', docsLang: 'auto', mermaid: true, autoCommit: false },
    docs: { intro: '', features: [] },
    log: [{ at: day(14), task: 't1', status: 'done', note: '' }, { at: day(10), task: 't2', status: 'done', note: '' }],
  };
}

/** 로드맵 카드 장면 (v0.40.0): 인증까지 끝났고, 다음 작업이 가짜 프로젝트의 getUser 고치기 (패널 답의 수정안 · 가짜 테스트와 맞물림) */
function roadmapCardSample(lang = 'ko') {
  const rm = roadmapSample(lang);
  const T = (ko, e) => (lang === 'en' ? e : ko);
  const [, m2] = rm.milestones;
  rm.milestones[0].tasks[2] = { ...rm.milestones[0].tasks[2], status: 'done', doneAt: new Date(Date.now() - 2 * 86400000).toISOString() };
  m2.tasks[0] = {
    ...m2.tasks[0],
    title: T('getUser 실패 응답 처리', 'Handle getUser failures'),
    status: 'todo',
    files: ['src/user.js', 'test/user.test.js'],
    accept: T('없는 사용자면 오류를 던진다\n캐시는 성공한 응답만 저장한다\nnpm test 통과', 'Throws for an unknown user\nCaches only successful responses\nnpm test passes'),
  };
  return rm;
}

// 미리보기 창 장면의 예시 앱 페이지 (v0.44.0): 사용자 목록 앱. 오류 장면은 한 카드가 비고 빨간 안내가 뜬다
function demoApp(scene) {
  const err = scene === '82-preview-errors';
  const users = [['김하늘', 'haneul@example.com', '관리자'], ['이도윤', 'doyun@example.com', '편집자'], ['박서연', 'seoyeon@example.com', '보기 전용']];
  const cards = users.map(([n, e, r], i) => (err && i === 1 ? '<div class="card broken"><b>불러오지 못함</b><span>500 Internal Server Error</span></div>' : `<div class="card"><div class="av">${n[0]}</div><div><b>${n}</b><span>${e}</span></div><em>${r}</em></div>`)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font:14px system-ui,'Malgun Gothic',sans-serif;background:#f5f6f8;color:#1d2330}
    header{display:flex;align-items:center;gap:12px;padding:14px 28px;background:#1d4ed8;color:#fff}
    header b{font-size:18px} header span{opacity:.8}
    main{padding:24px 28px;display:flex;flex-direction:column;gap:12px;max-width:720px}
    h2{margin:4px 0 6px;font-size:16px}
    .card{display:flex;align-items:center;gap:14px;padding:12px 16px;background:#fff;border:1px solid #e3e6ec;border-radius:10px}
    .card .av{width:36px;height:36px;border-radius:50%;background:#dbe5ff;color:#1d4ed8;display:grid;place-items:center;font-weight:700}
    .card div b{display:block} .card div span{color:#6b7280;font-size:12.5px} .card em{margin-left:auto;font-style:normal;font-size:12px;color:#374151;background:#eef1f6;padding:2px 8px;border-radius:999px}
    .card.broken{border-color:#f3b4b4;background:#fff5f5;color:#b42318;flex-direction:column;align-items:flex-start;gap:2px}
    .bar{display:flex;gap:8px} .bar input{flex:1;padding:8px 10px;border:1px solid #cfd5df;border-radius:8px} .bar button{padding:8px 14px;border:0;border-radius:8px;background:#1d4ed8;color:#fff}
  </style></head><body><header><b>demo-app</b><span>사용자 관리</span></header><main><h2>사용자 ${users.length}명</h2><div class="bar"><input placeholder="이름 · 이메일로 찾기"><button>추가</button></div>${cards}</main></body></html>`;
}

module.exports = { demoApp, QUESTION, ANSWERS, ANALYSIS_MD, ANALYSIS_MD2, DEBATE_RESULT, CHAIN, SYNTH_ANSWER, HISTORY, chatPage, PROJECT_FILES, PROJECT_ANSWERS, roadmapSample, roadmapCardSample };
