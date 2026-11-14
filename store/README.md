# 스토어 등록 자료 (Chrome Web Store · Edge Add-ons)

[← README](../README.md)

크롬 웹 스토어 개발자 대시보드에 그대로 붙여 넣을 글과 그림입니다. 대시보드 칸 이름은 영어 화면 기준입니다.

| 파일 | 쓰는 곳 |
|---|---|
| `MultitudeLLM-Extension-<버전>.zip` (GitHub Releases) | **Package** › 업로드 (zip 맨 위에 `manifest.json`이 있어야 함 — 릴리스 zip이 이미 그렇게 되어 있음) |
| `screenshots/*.png` (1280×800) | **Store listing** › Screenshots (1~5장) |
| `promo-tile-440x280.png` | **Store listing** › Small promo tile |
| `../extension/icons/icon-128.png` | **Store listing** › Store icon (128×128) |
| `../PRIVACY.md`의 GitHub 주소 | **Privacy** › Privacy policy URL |

그림 다시 만들기:

```bash
npm run screenshots -- --store 02-ask-all 13-analysis 04-compare 11-patch-preview 19-local-llm
```
```bash
npx electron scripts/store-tile.js
```

---

## 1. Store listing

**Name:** Multitude LLM (manifest의 `_locales`에서 영어 · 한국어로 나옴)

**Summary (132자 이내, manifest 설명과 같음)**
- EN: Open up to 6 of 11 AI web chats (Gemini, ChatGPT, Claude...) in one tab, ask them all at once and compare the answers.
- KO: Gemini · ChatGPT · Claude 등 11개 AI 웹 채팅을 한 탭에 최대 6개 띄워 같은 질문을 동시에 보내고 답변을 비교합니다.

**Category:** 생산성 › **도구 (Tools)** ("생산성"은 묶음 제목이라 직접 고를 수 없음) · **Language:** English (Korean 추가)

> 설명에 서비스 이름을 길게 늘어놓으면 **키워드 스팸**으로 반려됩니다 (실제 반려: "Yellow Argon", 서비스 11개 이름 나열). 이름은 manifest 요약의 세 개 정도만 쓰고, 전체 목록은 GitHub 페이지로 안내합니다.

**Description — English**

```
Ask several AI chats the same question at once — then compare, merge and apply.

Multitude LLM opens up to 6 AI chat websites side by side in one tab and sends your question to all of them at once. Type once, every panel answers. It uses each service's own website with the account you are already signed in to, so no API keys are needed. The full list of supported services is on the project page.

WHAT YOU CAN DO
• Ask all at once — one input box, file attachments, prompt templates with variables, reusable skills
• Compare — answers in columns, highlight what differs, a disagreement table with a final answer
• Merge — ask one AI to review the others and write the final answer
• Code work — open a local folder, send files, compare each AI's code changes, preview, apply and undo; only changed files are sent on follow-ups
• Side panel — two AIs next to the page you are reading; the page text goes with your question
• Right-click any page — ask about the selected text or the whole page
• Local LLM — add an AI model running on your own PC (any OpenAI-compatible local server) as a panel
• History, Markdown / HTML export, response stats and answer ratings

PRIVACY
No Multitude LLM server, no analytics, no tracking. Your questions go only to the AI services you open. History stays in your browser.

NOTES
• The interface is currently in Korean; an English guide is available on GitHub.
• Each AI service's own usage limits and terms apply.
• Open source: https://github.com/dyj02056/multitude_llm_ai
```

**Description — 한국어**

```
여러 AI 채팅에 같은 질문을 한 번에 — 비교하고, 종합하고, 적용까지.

Multitude LLM은 한 탭에 AI 채팅 사이트를 최대 6개 나란히 띄우고, 같은 질문을 한 번에 보냅니다. 한 번 입력하면 모든 패널이 답합니다. 각 서비스 사이트를 이미 로그인된 계정 그대로 쓰므로 API 키가 필요 없습니다. 지원하는 서비스 목록은 프로젝트 페이지에 있습니다.

할 수 있는 것
• 동시 질문 — 입력창 하나, 파일 첨부, 변수 템플릿, 스킬
• 비교 — 칸별 답변, 다른 부분 강조, 이견 표와 최종 답변
• 종합 — 한 AI에게 다른 답들을 검토해 최종 답을 쓰게 함
• 코드 작업 — 로컬 폴더를 열어 파일을 보내고, AI별 수정안 비교 · 미리보기 · 적용 · 되돌리기, 후속 질문은 바뀐 파일만
• 사이드탭 — 보고 있는 페이지 옆에 AI 2개, 페이지 본문을 함께 보냄
• 오른쪽 클릭 — 선택한 글이나 페이지 본문으로 질문
• 로컬 LLM — 이 PC에서 돌리는 AI 모델(OpenAI 호환 로컬 서버)을 패널로
• 기록, Markdown · HTML 내보내기, 응답 통계와 답변 평가

개인정보
자체 서버 · 분석 · 추적이 없습니다. 질문은 사용자가 연 AI 서비스로만 가고, 기록은 브라우저에만 남습니다.

참고
• 각 AI 서비스의 사용 한도와 약관을 따릅니다.
• 오픈 소스: https://github.com/dyj02056/multitude_llm_ai
```

---

## 2. Privacy practices

**Single purpose**

```
Send one question to several AI chat websites that the user opens side by side in one tab (or in the side panel), and compare, merge and apply their answers.
```

**Permission justification** (칸마다 붙여 넣기)

| 권한 | Justification |
|---|---|
| `storage` | Saves the user's settings, question/answer history, prompt templates and project state locally. |
| `unlimitedStorage` | History (up to 500 questions with full answers) and project undo data can exceed the default 10 MB quota. |
| `declarativeNetRequest` | The supported AI chat sites send X-Frame-Options / CSP frame-ancestors headers. Session rules remove only those headers, only for frames of those sites inside this extension's own app tab or side panel, so the user can see them side by side. Normal tabs are not affected, and the rules are removed when the app tab or side panel closes. Also used to attach the site's own cookies to its WebSocket requests from that frame. |
| `cookies` | Chrome does not send a site's cookies on WebSocket connections from a frame inside an extension page, so services like Grok cannot start a chat. The extension reads the cookies of the supported AI sites only, and attaches them only to those sites' own WebSocket requests from the app tab. For Qwen and Z.ai it copies the sign-in token into that site's own frame inside the app tab. Cookies never leave the browser. |
| `browsingData` | Some AI sites register a service worker that serves the page without going through the frame rules. The extension removes only the service worker registration of that AI site when its panel opens. Cookies and site data are kept. |
| `clipboardWrite` | Copy buttons for answers, analysis and code. |
| `contextMenus` | Right-click menu "Ask Multitude LLM — selected text / this page". |
| `activeTab` | Reads the text of the tab the user right-clicked or pressed the shortcut on, once, at that moment. |
| `scripting` | Runs a one-time script in that active tab to extract the page text. |
| `sidePanel` | The side panel mode (two AI chats next to the current page). |
| Host permissions (11 AI sites + `wss://`) | Content scripts type the user's question into the site's input box, press send and read the answer inside the extension's app tab. `wss://` is needed for the WebSocket cookie rules above. |
| Optional host permissions (`http(s)://*/*`, `localhost`) | Requested only when the user turns on side-panel auto-read (read the page the user is viewing) or the local LLM panel (connect to an AI server on the user's own PC). Not requested at install. |

**Remote code:** `No, I am not using remote code.`
> The extension downloads `remote/selectors.json` from its GitHub repository. It is a signed (Ed25519) JSON data file of CSS selectors and text patterns; no code is downloaded or executed.

**Data usage (체크할 항목)**
- 체크: **Personal communications** (질문을 AI 채팅으로 보내고 질문 · 답변을 기록에 저장), **Website content** (사용자가 고른 페이지 글을 AI 패널로 보냄)
- 체크하지 않음: 개인 식별 · 건강 · 금융 · 인증 정보(쿠키 · 토큰은 브라우저 밖으로 나가지 않음) · 위치 · 웹 기록 · 사용자 활동
- 아래 세 가지 확인란은 모두 체크:
  - I do not sell or transfer user data to third parties, outside of the approved use cases
  - I do not use or transfer user data for purposes that are unrelated to my item's single purpose
  - I do not use or transfer user data to determine creditworthiness or for lending purposes
- **Privacy policy URL:** `https://github.com/dyj02056/multitude_llm_ai/blob/main/PRIVACY.md`

---

## 3. 심사 담당자에게 (Test instructions, Distribution 탭 또는 제출 메모)

```
No account on our side is needed. To test:
1. Click the toolbar icon to open the app tab.
2. Pick 2–3 services (e.g. Duck.ai needs no sign-in; Gemini/ChatGPT use the Google account signed in to Chrome).
3. Type a question in the bottom input box and press Enter. Each panel answers; "cmp" compares them.
4. Side panel: press Alt+Shift+S on any web page.
The header-removal and cookie rules apply only to frames of the 11 listed AI sites inside the extension's own app tab / side panel and are removed when it closes. Source: https://github.com/dyj02056/multitude_llm_ai
```

---

## 4. 심사에서 걸릴 수 있는 점 (미리 알아 둘 것)

- **다른 사이트의 iframe 차단 헤더 제거 · 쿠키 · 토큰 복사**는 심사에서 자세히 보는 동작입니다. 위 권한 설명처럼 "이 확장의 탭 안, 이 11개 사이트에만, 닫으면 지움"을 분명히 적었습니다. 그래도 반려되면 반려 메일의 정책 이름을 보고 해당 기능(예: Qwen · Z.ai 토큰 브리지)을 스토어판에서 빼는 것을 검토합니다.
- **넓은 선택 권한**(`http(s)://*/*`)과 많은 호스트 권한 때문에 심사가 며칠 더 걸릴 수 있습니다.
- 각 AI 서비스의 **이용 약관**(자동 입력 · 화면 읽기)은 스토어 심사와 별개로 사용자 · 개발자가 지켜야 할 부분입니다.
- 화면이 한국어라 영어 사용자 평점이 낮을 수 있습니다 — 설명에 적어 두었습니다.

## 5. 업데이트 올리기

1. 버전을 올려 태그를 푸시하면 릴리스 워크플로가 `MultitudeLLM-Extension-<버전>.zip`을 만듭니다.
2. 대시보드 › 항목 › **Package** › **Upload new package** → zip 올리기 → **Submit for review**.
3. 권한이 늘어난 업데이트는 사용자에게 다시 허용을 묻고 심사도 길어집니다.

## 6. Microsoft Edge Add-ons (무료)

같은 zip을 https://partner.microsoft.com/dashboard/microsoftedge 에 올리면 됩니다. 설명 · 그림 · 개인정보 주소도 위 내용을 그대로 씁니다.
