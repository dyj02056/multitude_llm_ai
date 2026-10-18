# 멀티 LLM 동시 질문 앱 — 계획 초안 (v0.1)

> **v0.2 (2026-10-18) 변경:** Groq를 Grok(grok.com)으로 바꾸고 Perplexity · Qwen · Poe · Duck.ai를 더해 8개 서비스 중 최대 4개를 고르게 했다
> (처음 값: Gemini · ChatGPT · DeepSeek · Perplexity). 크롬 확장 프로그램(`extension/`)을 추가하고, 두 쪽이 같이 쓰는 코드를 `src/shared/`로 옮겼다.
> 아래는 v0.1 계획 당시의 기록이다.

> 작성일: 2026-10-17
> 대상 서비스: **Gemini · ChatGPT · DeepSeek · Groq** (모두 웹 채팅, 무료 플랜)

---

## 1. 목표

- 한 번의 입력으로 4개 LLM 웹 채팅에 **동시에 같은 질문**을 보낸다.
- 각 서비스의 답변을 **나란히 보고**, 복사·비교·교차검토할 수 있게 한다.
- API 키 없이 **각 서비스의 무료 웹 로그인 세션**을 그대로 쓴다.

## 2. 레퍼런스 분석 요약 — DascanAI 0.2.0

실행하지 않고 설치 파일을 풀어서 정적으로만 분석했다.

| 항목 | 내용 |
|---|---|
| 형태 | Electron 앱 + NSIS 설치 파일, **코드 서명 없음** |
| 제작 | hitouchsoft (기술노트), 자동 업데이트 저장소: GitHub `alecyoun/ai-browser` |
| 구조 | 메인 창 1개 + 서비스마다 `<webview>` 1개 (`persist:aibrowser` 파티션 공유) |
| 질문 전송 | 서비스별 CSS 셀렉터(input/send/stop/response)를 정의해 두고, `executeJavaScript`로 입력창에 텍스트를 넣고 전송 버튼을 클릭 |
| 답변 감지 | stop 버튼이 사라지고 응답 DOM이 안정되면 완료로 판단 |
| 원격 설정 | 6시간마다 `technote.wiki/dascan/latest.json`을 받아 셀렉터 덮어쓰기, 공지·홍보 배너, 업데이트 안내에 사용 |
| 자동 로그인 | 아이디·비밀번호를 Windows DPAPI(`safeStorage`)로 암호화해 로컬 저장, 로그인 폼 자동 입력 |
| Google 로그인 | `accounts.google.com` 요청만 Firefox UA로 바꾸고 `AutomationControlled`를 꺼서 "안전하지 않은 브라우저" 차단을 피함 |
| 기타 | 창을 닫을 때 원격 설정의 홍보 페이지를 기본 브라우저로 엶(최대 24시간에 1번, 설정에서 끌 수 있음) |

**판단:** 원격 서버로 비밀번호나 대화를 보내는 코드는 찾지 못했다. 원격 설정은 셀렉터 문자열(300자 미만)만 받고 코드를 실행하지 않는다. 다만 서명되지 않았고 main/preload/renderer가 난독화되어 있어 전부 검증하지는 못했다. 앱 실행과 원격 설정 요청 때마다 서버에 "실행/갱신" 이벤트가 전송된다.
→ **설계 참고용으로만 쓰고, 우리 앱은 직접 만든다.** 핵심 아이디어인 "웹뷰 + 셀렉터 어댑터 + JS 주입"은 그대로 가져온다.

## 3. 대상 서비스와 무료 한도 (2026-10 기준, 일부 미확인)

| 서비스 | 웹 주소 | 무료 한도(조사 결과) | 추천도 |
|---|---|---|---|
| **DeepSeek** | chat.deepseek.com | 공식적인 일일 한도 없음. 혼잡할 때만 속도 제한. 유료 구독 자체가 없음 | ★★★ 가장 넉넉함 |
| **ChatGPT** | chatgpt.com | 2026-08 이후 텍스트 채팅 상한을 없앴다는 보도가 여러 곳 있음(공식 문서로는 미확인). 파일·음성·심층 리서치는 제한 | ★★★ |
| **Groq** | chat.groq.com | 웹 채팅은 데모 성격이고 한도 공지 없음 | ★★ |
| **Gemini** | gemini.google.com/app | 연산량 기준 한도, 5시간마다 회복하고 주간 상한 있음. 무료 컨텍스트 32k | ★★ 가장 빡빡함 |

**실제 사용 팁**
- 사용량 위주라면 **DeepSeek(Instant)·ChatGPT 기본 모델**을 주력으로 쓰고, Gemini는 Fast/Flash 모델로 고정해 한도를 아낀다.
- Gemini 남은 한도는 *설정 → Usage Limits*에서 확인한다.
- Groq은 **웹 채팅 모드만** 쓴다(결정됨). 웹 데모라 DOM이 자주 바뀔 수 있어 셀렉터를 넉넉하게 둔다.

## 4. 아키텍처

```
┌──────────────────────── Main Window (React UI) ────────────────────────┐
│ [공통 입력창] [보낼 대상 체크: ☑Gemini ☑ChatGPT ☑DeepSeek ☑Groq] [보내기] │
├──────────────┬──────────────┬──────────────┬──────────────────────────┤
│ Gemini View  │ ChatGPT View │ DeepSeek View│ Groq View                 │
│ (WebContents)│ (WebContents)│ (WebContents)│                           │
└──────────────┴──────────────┴──────────────┴──────────────────────────┘
        ▲ IPC                       ▲
   Main process ── Adapter Registry (서비스별 셀렉터/동작 JSON)
                ── Injector (executeJavaScript: 입력·전송·감시·추출)
                ── Session Manager (persist:shared 한 세션을 모든 패널이 공유)
                ── Store (질문/답변 기록, 설정)
```

- **Electron + `WebContentsView`**: `<webview>` 태그는 Electron에서 권장하지 않으므로 메인 프로세스에서 `WebContentsView`로 4개 패널을 배치한다.
- **공유 세션** `persist:shared` 하나를 모든 패널이 같이 쓴다. Google 로그인 쿠키를 함께 써야 각 서비스의 "Google로 계속하기"가 이어지기 때문이다.
- **어댑터**: 서비스마다 아래 JSON 하나만 정의하면 된다. 셀렉터가 깨지면 이 파일만 고친다.
  ```json
  {
    "id": "deepseek",
    "url": "https://chat.deepseek.com/",
    "newChatUrl": "https://chat.deepseek.com/",
    "input": ["textarea#chat-input", "textarea"],
    "send": ["div[role=button][aria-disabled=false]:last-of-type"],
    "stop": ["..."],
    "response": [".ds-markdown"],
    "inputMethod": "insertText | paste | setValue"
  }
  ```
- **입력 방식**: 입력창 포커스 → `document.execCommand('insertText')` 또는 합성 `paste` 이벤트(ProseMirror/Quill 에디터 대응) → 전송 버튼 클릭(없으면 Enter 키 이벤트).
- **완료 감지**: stop 버튼이 사라짐 + 마지막 응답 텍스트가 1.5초 동안 변하지 않음 → 완료로 판단하고 답변 텍스트·Markdown을 추출한다.
- **로그인 흐름 (Google 전용)**
  1. **로그인 화면**: 창 전체에 Google 로그인 페이지 하나만 띄운다. 로그인 쿠키(`SID`)가 생기면 다음 화면으로 넘어간다.
  2. **모델 선택 화면**: Gemini·ChatGPT·DeepSeek·Groq 체크 목록. 선택한 모델만 패널로 연다(선택은 저장됨).
  3. **채팅 화면**: 각 패널이 로그아웃 상태면 앱이 "로그인 → Google로 계속하기" 버튼을 대신 누른다. Google 계정 선택·동의 화면은 사용자가 직접 누른다. 비밀번호는 저장하지 않는다.
  4. **로그아웃**: 공유 세션의 쿠키·저장소를 모두 지우고 1번 로그인 화면으로 돌아간다.
  - Google의 임베디드 브라우저 차단에 대응해 `accounts.google.com`에 갈 때만 UA를 Firefox로 바꾼다.

## 5. 기술 스택

- Electron (최신 안정판) + TypeScript
- UI: React + Vite (electron-vite)
- 저장: `electron-store`(설정), SQLite 또는 JSON(대화 기록)
- 패키징: electron-builder (NSIS), 이후 코드 서명 검토

## 6. 폴더 구조(안)

```
multitude_llm_ai/
├─ src/
│  ├─ main/            # 창·뷰 배치, IPC, 세션, 인젝터
│  │  ├─ views.ts
│  │  └─ injector.ts
│  ├─ preload/         # contextBridge로 최소 API만 노출
│  ├─ renderer/        # React UI (입력창, 툴바, 비교 화면)
│  └─ adapters/        # gemini.json, chatgpt.json, deepseek.json, groq.json
├─ PLAN.md
└─ package.json
```

## 7. 단계별 개발 계획

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **0. 스파이크** | 로그인 화면 → 모델 선택 → 선택한 패널만 열기 → 로그아웃 흐름, Google 자동 로그인 확인 | 4개 모두 Google로 로그인 유지 |
| **1. MVP** | 공통 입력창 → 선택한 서비스에 동시 전송 | 한 번 입력으로 4곳에 질문이 들어감 (구현됨: 화면 아래 공통 입력창, 대상 칩으로 켜고 끄기) |
| **2. 응답 처리** | 완료 감지, 답변 추출, 패널별 상태 표시(대기/작성 중/완료/오류), 전체 새 대화 | 상태가 정확히 표시되고 답변 복사 가능 (구현됨: 완료 감지, 패널별·전체 답변 복사, 패널별·전체 새 대화) |
| **3. 비교 기능** | 답변 나란히 비교 화면, "교차검토"(다른 AI 답변을 묶어 한 AI에 다시 보내 종합), 템플릿 | 종합 답변을 한 번에 요청 (구현됨: 교차검토 — 종합 담당 선택, 수동·완료 후 자동 · 답변 비교 화면 · 질문 템플릿 8종) |
| **4. 편의 기능** | 기록 저장·검색, Markdown 내보내기, 단축키, 레이아웃(2x2 / 1x4 / 탭) | (구현됨: 기록 저장·검색, 표·코드 블록을 살린 Markdown 복사, 단축키, 답변 대기 시간 설정, 격자/가로 레이아웃) |
| **5. 배포** | 설치 파일, 자동 업데이트, 셀렉터 원격 갱신(내 GitHub raw JSON) | 설치 후 바로 사용 가능 (설치 파일 구현됨: electron-builder NSIS, 서명 없음 · 원격 셀렉터 갱신 구현됨 · 자동 업데이트는 남음) |

## 8. 위험 요소

- **약관**: 웹 UI 자동 입력은 서비스 약관상 회색 지대다. 개인용 범위로 쓰고, 요청 속도를 사람 수준으로 유지한다.
- **DOM 변경**: 사이트 개편 시 셀렉터가 깨진다 → 어댑터 JSON 분리, 다중 후보 셀렉터, 원격 갱신으로 대응한다.
- **봇 탐지**: ChatGPT·DeepSeek의 Cloudflare 검사, Google 임베디드 브라우저 로그인 차단 → 실제 Chrome UA 사용, 자동화 플래그 제거, 사용자가 직접 로그인한다.
- **Groq 웹 데모의 불안정성** → 다중 후보 셀렉터와 빠른 셀렉터 갱신으로 대응한다.

## 9. 결정이 필요한 사항

1. ~~Groq 연동 방식~~ → 웹 채팅 모드만 (결정)
2. 레이아웃 기본값: 2x2 그리드 vs 가로 4분할
3. 교차검토(종합) 기능을 MVP에 넣을지
4. 대화 기록을 로컬에 저장할지(개인정보)
