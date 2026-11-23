# Privacy Policy — Multitude LLM

**English** · [한국어](#개인정보-처리방침--multitude-llm)

Last updated: 2026-11-23 · Applies to the Multitude LLM Chrome extension and Windows app.

## Summary

Multitude LLM has **no server of its own** and **collects nothing**. It does not use analytics, tracking, advertising or crash reporting. Everything you type is sent **only to the AI services you choose to open**, the same way it would be if you typed it into those websites yourself.

## What the extension handles and where it goes

| Data | Where it goes | Stored where |
|---|---|---|
| Questions you type, files you attach, and project files you choose to send | Only to the AI chat websites you opened in panels (e.g. gemini.google.com, chatgpt.com, claude.ai), through those websites' own pages | Question text, answers and attached **file names** are kept in your local history (last 500 by default; 100–2000 in settings), together with your own tags and stars, a question-kind label, a conversation-thread id and the project name when project context was sent. File contents are not stored in history |
| Text of a web page you are reading (only when you use right-click › "Ask Multitude LLM", the side-panel shortcut, or turn on side-panel auto-read) | Only to the AI chat panels in that side panel / app tab | Temporarily in Chrome session storage until the app tab picks it up, then deleted |
| Settings, library (templates/skills), project state (including originals kept for undo) | Nowhere | Your browser's extension storage (Chrome) or the app data folder (Windows, encrypted with Windows DPAPI) |
| Cookies of the supported AI sites | Never leave your browser. The extension attaches them to those sites' own WebSocket connections inside the app tab, and for Qwen / Z.ai copies the sign-in token into that site's own frame inside the app tab, so you stay signed in there | In memory / Chrome's session rules only |
| Optional local LLM requests | Only to `localhost` / `127.0.0.1` on your own PC | Answers in local history |
| Settings export file (`.mla.json`, only when you press Export in Settings › 설정 옮기기) | Saved where you choose (Windows save dialog / Chrome download). Never sent anywhere | Contains selected settings and your library (templates, skills with previous versions, presets). It does **not** contain history, project data or cookies. Optional password encryption (PBKDF2-SHA256 250k + AES-GCM) |
| Desktop notifications (answers finished, usage limit, send failure, synthesis finished) | Shown by Windows / Chrome on your own screen only. They contain counts and AI service names, never your question or the answers | Not stored |
| Developer tools on your PC (Windows app, project mode — names and versions such as "Node.js 22.11.0", found by running each tool's version command on your PC) | Nowhere by default. If "Tell the AI about this PC" is on (on by default, can be turned off), one line with tool **names and versions only** — no folder paths or user names — is added to project questions you send to the AI panels | Kept in memory while the project is open; the on/off choice in local storage |
| Screen captures of your own app (Windows app, preview window) | Only to the AI panel you pick, and only when you press **Send** in the capture window after seeing the picture, the AI and the text | Kept in memory for this session only (last 12). Written to a file only when you press **Save PNG** |
| Your app in the preview window (Windows app) | Opens only addresses on your own PC (`localhost`, `127.0.0.1`). Runs in a separate browser session that does not share cookies with the AI sites | Not stored |

In project mode the Windows app can run your project's own code on your PC when you ask it to (tests, ▶ Run app, Run once, before/after screen compare) — always after a confirm dialog. Its output stays on your PC; nothing is sent unless you send it to an AI yourself.

The extension also downloads two public files from this project's GitHub repository: `remote/selectors.json` (page selectors used to find input boxes and answers, signed and verified with Ed25519; it contains no code) and `package.json` (to tell you when a new version exists). These requests send no personal data.

## What we do not do

- We do not sell, share or transfer your data to anyone.
- We do not use your data for advertising, creditworthiness, or any purpose unrelated to the extension's single purpose (sending your question to several AI chats and comparing the answers).
- No human at Multitude LLM can read your data, because it never reaches us.

## Third-party services

When you use an AI service through a panel, that service receives what you send and handles it under **its own privacy policy and terms**, exactly as if you used its website directly.

## Your control

- Delete history in the app (`hist` › delete / clear). Removing the extension deletes all of its stored data.
- Optional permissions (side-panel auto-read, local LLM) can be revoked at any time in `chrome://extensions` › Details › Site access.

## Contact

Questions: open an issue at https://github.com/dyj02056/multitude_llm_ai/issues

---

# 개인정보 처리방침 — Multitude LLM

[English](#privacy-policy--multitude-llm) · **한국어**

최종 수정: 2026-11-23 · Multitude LLM 크롬 확장 프로그램과 Windows 앱에 적용됩니다.

## 요약

Multitude LLM은 **자체 서버가 없고 아무것도 수집하지 않습니다**. 분석 · 추적 · 광고 · 오류 보고 도구를 쓰지 않습니다. 입력한 내용은 **사용자가 직접 연 AI 서비스로만** 보내지며, 그 사이트에 직접 입력했을 때와 같습니다.

## 다루는 정보와 가는 곳

| 정보 | 가는 곳 | 저장 위치 |
|---|---|---|
| 입력한 질문 · 첨부 파일 · 보내기로 고른 프로젝트 파일 | 패널로 연 AI 채팅 사이트(gemini.google.com, chatgpt.com, claude.ai 등)에만, 그 사이트 화면을 통해 | 질문 · 답변 · 첨부 **파일 이름**은 이 PC의 기록(기본 최근 500개, 설정에서 100~2000개)에. 내가 붙인 태그 · 즐겨찾기, 질문 종류, 대화 줄기 id, 프로젝트 맥락을 보냈으면 프로젝트 이름도 같은 기록에. 파일 내용은 기록에 남기지 않음 |
| 보고 있는 웹페이지 글 (오른쪽 클릭 메뉴 · 사이드탭 단축키 · 사이드탭 자동 읽기를 쓸 때만) | 그 사이드탭 / 앱 탭의 AI 패널에만 | 앱 탭이 가져갈 때까지 크롬 세션 저장소에 잠깐, 가져가면 지움 |
| 설정 · 라이브러리(템플릿 · 스킬) · 프로젝트 상태(되돌리기용 원본 포함) | 어디로도 보내지 않음 | 브라우저의 확장 저장소(크롬) 또는 앱 데이터 폴더(Windows, DPAPI 암호화) |
| 지원하는 AI 사이트의 쿠키 | 브라우저 밖으로 나가지 않음. 앱 탭 안 그 사이트의 WebSocket 연결에 붙이고, Qwen · Z.ai는 로그인 토큰을 앱 탭 안 그 사이트 프레임에만 넣어 로그인을 유지 | 메모리 · 크롬 세션 규칙에만 |
| 선택 기능 로컬 LLM 요청 | 이 PC의 `localhost` · `127.0.0.1`에만 | 답변은 로컬 기록에 |
| 설정 옮기기 파일(`.mla.json`, 설정 › 설정 옮기기에서 내보내기를 누를 때만) | 사용자가 고른 곳에 저장(Windows 저장 창 / 크롬 다운로드). 어디로도 보내지 않음 | 설정 일부와 라이브러리(템플릿 · 스킬과 이전 버전 · 프리셋). 기록 · 프로젝트 · 쿠키는 **넣지 않음**. 비밀번호 암호화 선택(PBKDF2-SHA256 25만 번 + AES-GCM) |
| 화면 알림 (답변 완료 · 사용 한도 · 보내기 실패 · 종합 끝) | 이 PC 화면에 Windows · 크롬이 띄우기만 함. 개수와 AI 서비스 이름만 넣고 질문 · 답변은 넣지 않음 | 저장하지 않음 |
| 이 PC의 개발 도구 (Windows 앱 프로젝트 모드 — "Node.js 22.11.0" 같은 이름과 버전, 이 PC에서 각 도구의 버전 명령을 실행해 알아냄) | 기본으로는 어디로도 보내지 않음. "AI에게 이 PC 환경 알려 주기"(기본 켬, 끌 수 있음)가 켜져 있으면 AI 패널로 보내는 프로젝트 질문에 도구 **이름과 버전만** 담은 한 줄을 붙임 — 폴더 경로 · 사용자 이름은 넣지 않음 | 프로젝트를 연 동안 메모리에만, 켜고 끈 설정은 로컬 저장소에 |
| 내 앱 화면 캡처 (Windows 앱 미리보기 창) | 캡처 창에서 그림 · 받을 AI · 보낼 글을 확인하고 **[보내기]를 누를 때만** 사용자가 고른 AI 패널로 | 이 실행 동안 메모리에만(최근 12장). **PNG로 저장**을 누를 때만 파일로 씀 |
| 미리보기 창에 띄운 내 앱 (Windows 앱) | 이 PC 주소(`localhost` · `127.0.0.1`)만 엶. AI 사이트와 쿠키를 나누지 않는 따로 된 브라우저 세션에서 돎 | 저장하지 않음 |

Windows 앱의 프로젝트 모드는 사용자가 요청할 때(테스트 실행 · ▶ 앱 실행 · 1회 실행 · 적용 전/후 화면 비교) 이 PC에서 프로젝트의 코드를 실행합니다 — 언제나 확인 창을 거칩니다. 실행 결과는 이 PC에만 남고, 사용자가 직접 AI에게 보내지 않는 한 어디로도 가지 않습니다.

이 밖에 이 프로젝트의 GitHub 저장소에서 공개 파일 두 개를 받습니다: `remote/selectors.json`(입력창 · 답변을 찾는 셀렉터, Ed25519 서명 검사, 코드 아님)과 `package.json`(새 버전 알림). 이 요청에는 개인 정보가 들어가지 않습니다.

## 하지 않는 것

- 정보를 팔거나 다른 곳에 넘기지 않습니다.
- 광고 · 신용 평가 등 확장의 단일 목적(여러 AI 채팅에 질문을 보내고 답을 비교)과 관계없는 일에 쓰지 않습니다.
- 정보가 우리에게 오지 않으므로 개발자가 볼 수 없습니다.

## 다른 서비스

패널로 쓰는 AI 서비스는 보낸 내용을 **그 서비스의 개인정보 처리방침 · 약관**에 따라 처리합니다. 그 사이트를 직접 쓸 때와 같습니다.

## 사용자가 할 수 있는 것

- 앱의 기록 화면에서 기록을 지울 수 있고, 확장을 지우면 저장된 정보도 모두 지워집니다.
- 선택 권한(사이드탭 자동 읽기, 로컬 LLM)은 `chrome://extensions` › 세부정보 › 사이트 액세스에서 언제든 끌 수 있습니다.

## 문의

https://github.com/dyj02056/multitude_llm_ai/issues
