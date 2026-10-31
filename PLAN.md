# 멀티 LLM 동시 질문 앱 — 계획 초안 (v0.1)

> **v0.2 (2026-10-18) 변경:** Groq를 Grok(grok.com)으로 바꾸고 Perplexity · Qwen · Poe · Duck.ai를 더해 8개 서비스 중 최대 4개를 고르게 했다
> (처음 값: Gemini · ChatGPT · DeepSeek · Perplexity). 크롬 확장 프로그램(`extension/`)을 추가하고, 두 쪽이 같이 쓰는 코드를 `src/shared/`로 옮겼다.
> **v0.3 (2026-10-18) 변경:** Mistral(chat.mistral.ai/work)을 더해 9개 서비스가 됐고, 공통 입력창에 파일 첨부(끌어다 놓기 · Ctrl+V · 📎)를 넣었다.
> **v0.4 (2026-10-18) 변경:** 프로젝트 모드 — 로컬 폴더를 열어 3단계 제외 규칙(L1 내장 · L2 .gitignore 계열·AI ignore·.mlaignore · L3 .dockerignore 등 선택)과 비밀 정보 검사를 거친 맥락을 보내고, NEED_FILES 요청 응답, 코드 수정안 비교·적용·되돌리기를 Windows 앱과 크롬 확장에 넣었다.
> **v0.5.0 (2026-10-18) 변경:** 프로젝트 모드의 파일을 본문 대신 업로드로 보냄 — 묶음 파일(기본, 경로가 붙은 .md, 100만 자마다 나눔) / 개별 파일(이름에 경로, 한도 넘으면 그번만 묶음) 선택. 첫 질문·NEED_FILES 응답·전체 파일 다시 요청 모두. 문서를 받지 않는 서비스·업로드 실패 패널에는 본문으로 보냄(fallbackText, 내부 예비 경로).
> **v0.6.0 (2026-10-19) 변경:** 답변 규칙을 diff에서 파일별 전체 내용("파일: 경로" + 코드 블록 하나, 삭제는 DELETE_FILES)으로 바꿈 (프로젝트 모드·종합으로 합치기·코드 리뷰 템플릿). 패널마다 AI가 받은 파일 내용을 기억하고 ⟳ 때 비교해, 바뀐 파일을 그 탭들에 바로 보내는 버튼을 넣음.
> **v0.6.1 (2026-10-19) 변경:** 프로젝트 파일 인앱 편집기(chatView 'editor') — 트리에서 파일 이름 클릭 → textarea 편집, 저장은 writeFile + 적용 기록(직접 편집), 저장 뒤 rescan으로 바뀐 파일 검사, "저장하고 AI에 보내기"는 그 파일만 syncStale.
> **v0.9.3 (2026-10-26) 변경:** 파일 모아보기 — renderer.js 패널 머리줄 collectBtn(답변 done 때 project.js showCollectBtn이 extractChanges 개수로 띄움, .attn 애니메이션), project.js collectItems(프로젝트가 열려 있으면 currentText와 비교해 create/modify/same, diff는 planChange로 전체 코드)·onCollectClick(patchModal 재사용, 경로·코드·전체 복사). markdown.js 코드 블록 울타리를 내용의 ``` 보다 길게. 답변 규칙·코드 리뷰 템플릿에 블록 하나·백틱 4개 울타리, 새 기본 템플릿 file-collect.
> **v0.10.0 (2026-10-31) 변경:** 화면 디자인 개편 (styles.css만, 높이 44·132·28·33px는 그대로) — :root 토큰(바탕 3층·네온 --grad·--ease 곡선), 버튼 4단계(기본 유리·.primary 그라데이션·.ghost·.danger, :hover 떠오름·:active 눌림·:focus-visible), 비교·기록을 말풍선(질문 오른쪽·답변 카드 stagger), index.html 모델 선택에 .feature-grid 설명 카드·.pick-inner·툴바 .tb-sep, 화면 전환 view-in 애니메이션, prefers-reduced-motion에서 전부 끔.
> **v0.12.1 (2026-10-31) 변경:** 점검 보완 — rounds.runSynth 분석이 timeout/no-answer로 끝나면 state error(mode analysis) 알림, diag.fromProbe는 warn까지만 + main loadFailed면 probe 생략, test-rules.trialWarnings(바뀐 test 스크립트 · executionRisk)를 확인 창에, findNodeFor로 npm 옆 node.exe 우선(ELECTRON_RUN_AS_NODE 안 물려줌), analysis.similarity(글자 bigram Dice ≥ 0.55, 숫자 같을 때)로 비슷한 문장 강조 안 함, COMMON_AUTH_HOSTS 보강 + 나라별 accounts.google, 팝업 차단 시 panel notice, 확장 project-state:undefined 이전.
> **v0.12.0 (2026-10-31) 변경:** 개발자 기능 — main/test-rules.js(readTestScript · findNpmCli(npm_execpath → PATH 절대 경로의 npm 폴더 → %APPDATA%\npm · Program Files\nodejs) · buildTestSpawn(process.execPath + npm-cli.js test, shell:false, ELECTRON_RUN_AS_NODE=1) · isAllowedTestSpawn · summarizeTestOutput · checkTrialChanges), main/devtest.js(devtest:info/trial/stop — 확인 창 → before → 원본을 devtest-recovery.json에 → 임시 적용 → after → finally 되돌림, recover()는 프로젝트를 열 때, 실행 중 project:write/delete/pick/close 거절, 3분·2MB·maskOutput). patch.splitHunks/applyHunks(diffLines 기준 덩어리, 줄바꿈 그대로) → 미리보기 창 덩어리 체크(plan.partial, 파일이 바뀌면 거절). shared/diag.js(createDiag: fromProbe · fromSend(code 'no-input') · fromAnswer(no-answer 2번) · status · all · reset), page.pageProbe, rounds a.diag, main/host probePanel(로그인 ready, 30초 간격), 원격 새 버전이면 reset, 화면 .diag-badge · 설정 #diagTable.
> **v0.11.0 (2026-10-31) 변경:** 비교 기능 — synth.buildSynthPrompt mode 'analysis'(buildAnalysisPrompt: 머리글 공통 의견·이견(표: 쟁점 | AI 이름들 | 판단)·근거 부족·최종 답변, analysisNames), rounds.runSynth가 끝나면 history.addSynth({ mode: 'analysis', names })·round.analysis·상태 'done', answers()가 analysis를 같이 돌려줌. shared/analysis.js(parseAnalysis — 머리글 모양 관대, 이견·최종 답변 없으면 ok:false / diffMarks — 문장·줄 단위 diffArrays). 비교 화면 #compareTabs(답변·분석, data-ctab), #diffToggle·#diffBase, analysisBlock(이견 표 칸 클릭 → jumpToAnswer), 기록 화면에도 analysisBlock.
> **v0.10.1 (2026-10-31) 변경:** 안정성·보안 — 로그인 팝업은 services.isAuthPopupUrl(공용 로그인 도메인 COMMON_AUTH_HOSTS + 서비스 authHosts + hosts, 호스트 정확히 일치·https만)로 검사하고 main.js guardPopups가 팝업 안 will-navigate·will-redirect도 같은 규칙(허용 밖은 openExternal). 확장 project-fs.js는 폴더마다 고유 id(KNOWN [{id, handle}], CURRENT, isSameEntry로 찾음, 예전 root·project-state:이름 옮김)이고 loadState()/saveState(data)는 지금 id로. project-upload.js 묶음 파일을 UTF-8 바이트(BUNDLE_BYTES, budget.fileBytes = 서비스 maxFileBytes 중 최소)로 나누고 큰 파일은 조각(splitBytes). resize는 schedulePushState(30ms). attach.js clearTransfer를 finally에서, remote.js redirect: 'error', project.js recheckTarget(쓰기 직전 실제 상위 폴더·링크 거절).
> **v0.9.2 (2026-10-20) 변경:** 압축 화면을 떠나면 cmp.waiting을 지우던 것을 없앰(답변을 못 가져오던 원인) — 기다리기는 화면과 상관없이 계속, 결과는 cmp.out에 보관. "패널에서 다시 읽기"(getAnswers → extractCompressed), extractCompressed는 가장 긴 코드 블록·닫히지 않은 블록 처리.
> **v0.9.1 (2026-10-20) 변경:** 스킬 여러 개(activeSkills 최대 3, 순서=우선순위, 예전 activeSkill 옮김) — prompt-lib.prefixFor가 패널별로 처음이면 전부·같으면 없음·바뀌면 skillChangeNote. cleanSkill(규칙 기반 정리)·sendBody(압축본 우선)·compressLevel/warnLimits(권장 기준, compressWarn)·compressRequest/extractCompressed. 압축 화면(chatView 'compress')은 sendFollowUp(noHistory)으로 요청하고 onLibPanelStatus로 끝을 받아 getAnswers의 md를 읽음.
> **v0.9.0 (2026-10-19) 변경:** 프롬프트 라이브러리와 스킬 — shared/prompt-lib.js(변수 parseVars·fillTemplate, SKILL.md parseSkillMd·toSkillMd, skillPrefix, normalizeLibrary·내보내기/가져오기), host.library(Electron library.json / 확장 storage), renderer/library.js(라이브러리 화면 chatView 'library', 변수 입력 chatView 'vars', 🧩 스킬 고르기). 스킬은 opts.prefixById로 rounds.sendAll이 그 패널의 글·예비 글 앞에 붙임. 패널별 받은 스킬은 새 대화(＋·⌂)에서 잊음 — ⌂도 이제 새 대화로 알림.
> **v0.8.0 (2026-10-19) 변경:** git 콘솔(Windows 앱, chatView 'git') — 렌더러는 명령 줄만 넘기고 main/git-rules.js가 검사(허용 하위 명령·차단 옵션·config 읽기만·위험 명령 확인 이유), main/gitconsole.js가 확인 창·셸 없는 spawn(PATH 절대 경로의 git.exe, FORCED_PREFIX·FORCED_ENV, 시간 제한·중지·2MB·출력 가림)·훅 알림·터미널 열기. 확장 프로그램에는 없음.
> **v0.7.1 (2026-10-19) 변경:** MAX_SELECTED 6(처음 값 4개 그대로). 배치를 shared/layout.js(C×R 격자 위의 칸, grid·row·main·tall)로 옮겨 main.js·host.js가 같이 씀. 패널 크게 보기(focusId — 나머지는 크기를 유지한 채 화면 밖, rects.hidden).
> **v0.7.0 (2026-10-19) 변경:** Claude(claude.ai/new)·Z.ai(chat.z.ai) 추가 — 11개 서비스. Z.ai는 Open WebUI 계열이라 tokenBridge(preferCookie: 손님 토큰을 쿠키 토큰으로 바꿈). 프로젝트 모드에 서비스별 보내지 않기(project.blocked → opts.plainIds · userFileCount, rounds.sendAll이 그 서비스에는 직접 올린 파일만)와 처음 올리는 서비스 확인(project.uploadOk)을 넣음.
> **v0.6.3 (2026-10-19) 변경:** `.git` 안쪽 쓰기·지우기 차단(patch.isGitInternal — extractChanges에서 빼고 project.writeFile/deleteFile이 거절, `GIT~1` 포함), `.gitmodules`를 실행 영향 파일에 추가.
> **v0.6.2 (2026-10-19) 변경:** 보안 보강 — 메인 창 will-navigate·새 창 차단과 링크 drop 차단, 보내기·첨부·자동 로그인 전 패널 주소 확인(isServiceUrl / authHosts), 확장 쿠키 쓰기 전달에서 HttpOnly 쿠키 보호, 확장 패널 연결에 sender.url 사용.
>
> **v0.4.6 (2026-10-18) 변경:** Qwen hosts에 `auth.qwen.ai` 추가 (로그인 화면·로그인 확인 요청 도메인. 권한이 없으면 크롬이 그 요청을 제3자 요청으로 보고 SameSite=Lax 로그인 쿠키를 빼고, 앱 탭 CSP가 로그인 화면을 막음).
>
> **v0.4.5 (2026-10-18) 변경:** 실제 Qwen에는 `token` 쿠키 없이 `refresh_token` 쿠키만 있음 → 토큰 다리 쿠키 후보에 추가, 유효한 JWT는 유지.
>
> **v0.4.4 (2026-10-18) 변경:** Qwen 로그아웃 화면의 실제 원인 보완 — Qwen은 `localStorage.token`을 Authorization 헤더로 보내 로그인을 확인하는데, 확장 탭 iframe의 저장소가 일반 탭과 분리됨 → `token` 쿠키 값을 iframe localStorage에 넣는 토큰 다리(tokenBridge).
>
> **v0.4.3 (2026-10-18) 변경:** 크롬 확장에서 Qwen 로그아웃 화면 문제 보완 (iframe 화면 스크립트가 SameSite=Lax 쿠키를 읽지 못함 → 확장 탭 전용 partitioned 쿠키 복사·쓰기 전달).
>
> **v0.4.2 (2026-10-18) 변경:** Genspark 추가·Poe 제거, 크롬 확장 iframe의 WebSocket 쿠키 누락(Grok 대화 실패) 보완.
> **v0.4.1 (2026-10-18) 변경:** 확장 배포 전 보안 보강 — 앱 탭 이탈 시 iframe 허용 규칙 즉시 해제, 요청 파일·다시 요청 검사, 실행 영향 파일 기본 해제, 원격 설정 범위 축소, frame-src·iframe 권한 축소, 임시 파일·Windows 경로 정리.
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
