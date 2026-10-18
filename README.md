# multitude_llm_ai

Gemini · ChatGPT · DeepSeek · Perplexity · Grok · Qwen · Poe · Duck.ai 웹 채팅 중 **최대 4개**를 한 화면에 띄워 같은 질문을 동시에 보내고 답변을 비교합니다.

- **Windows 앱** (Electron) — 로그인은 Google 계정 하나로 합니다.
- **크롬 확장 프로그램** — 크롬에 이미 로그인된 각 서비스 계정을 그대로 씁니다. [설치 방법](#크롬-확장-프로그램)

API 키 없이 각 서비스의 무료 웹 채팅을 그대로 씁니다. 처음 고른 모델은 Gemini · ChatGPT · DeepSeek · Perplexity이고, 격자(2×2)·가로(1×4) 배치를 고를 수 있습니다.

> 아래 스크린샷은 v0.1(4개 서비스) 화면입니다.

![네 AI에 동시에 질문하고 답변을 나란히 받는 화면](docs/screenshots/02-ask-all.png)

## 한눈에 보기

> 스크린샷의 계정 정보(이름·프로필)와 이전 대화 목록은 흐리게 처리했습니다.

### 1. 모델 고르기

Google로 로그인한 뒤 쓸 모델을 8개 중 최대 4개까지 고릅니다. 고른 모델만 패널로 열리고, 각 서비스에는 "Google로 계속하기"로 자동 로그인합니다.

![모델 선택 화면](docs/screenshots/01-model-picker.png)

### 2. 한 번에 질문하기

아래 공통 입력창에 쓰면 켜 둔 AI 모두에게 동시에 보냅니다. 왼쪽 아래 **템플릿**(예: 장단점 비교)을 고르면 질문을 자동으로 감싸 줍니다. 패널마다 "답변 중… → 답변 완료 · N자"가 표시됩니다.

![네 패널에 동시에 질문한 화면](docs/screenshots/02-ask-all.png)

### 3. 교차검토(종합)

**종합 요청**을 누르면 다른 AI들의 답변을 모아, 고른 AI 하나(여기서는 Gemini)에게 오류·빠진 내용·최종 답변을 정리해 달라고 보냅니다. "완료 후 자동"을 켜면 모든 답변이 끝나는 순간 알아서 요청합니다.

![Gemini가 다른 세 AI의 답변을 종합하는 화면](docs/screenshots/03-synthesis.png)

### 4. 답변 비교

**답변 비교**(Ctrl+Shift+D)는 마지막 질문과 각 AI의 최신 답변을 칸별로 나란히 보여 줍니다. 칸마다 Markdown(표·코드 블록 유지)으로 복사할 수 있습니다.

![답변 비교 화면](docs/screenshots/04-compare.png)

### 5. 기록

**기록**(Ctrl+H)에는 보낸 질문과 각 답변·종합 결과가 저장됩니다. 검색, Markdown 복사, 질문 다시 쓰기를 할 수 있습니다. 기록은 이 PC에만 저장됩니다.

![질문·답변 기록 화면](docs/screenshots/05-history.png)

### 6. 설정 · 단축키

`?`(Ctrl+/) 화면에서 답변 대기 시간, 사이트 셀렉터 자동 갱신을 설정하고 단축키를 볼 수 있습니다.

![설정과 단축키 화면](docs/screenshots/06-settings-shortcuts.png)

## 크롬 확장 프로그램

스토어에 올리지 않은 상태라 **압축해제된 확장 프로그램**으로 직접 추가합니다.

1. 이 저장소를 받습니다 (`git clone` 또는 GitHub의 **Code → Download ZIP** 후 압축 풀기).
2. 크롬 주소창에 `chrome://extensions`를 엽니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고 저장소 안의 `extension` 폴더를 고릅니다.
5. 툴바의 퍼즐 아이콘에서 **Multitude LLM**을 고정(📌)하고 누르면 앱 탭이 열립니다.

처음 쓸 때:

- 각 서비스는 **크롬에 로그인된 계정을 그대로** 씁니다. 로그인이 안 된 서비스는 패널 머리줄의 **로그인 탭**을 눌러 새 탭에서 로그인한 뒤, 패널의 ↻로 새로고침하세요.
  Google 로그인 화면은 다른 페이지 안에 뜨지 않으므로 로그인은 꼭 일반 탭에서 합니다.
- Duck.ai는 로그인이 없고, 처음 열면 이용 동의 화면을 한 번 눌러야 합니다.
- 코드를 받아 새 버전으로 바꾼 뒤에는 `chrome://extensions`에서 Multitude LLM의 **새로고침(↻)** 을 누릅니다.

확장 프로그램에서만 다른 점:

- 크롬이 페이지에 넘겨주지 않는 키 두 가지는 바꿔 씁니다: 모두 새 대화 `Alt+Shift+N`, N번째 보낼 대상 켜기/끄기 `Alt+Shift+1~4`.
- 로그아웃 버튼과 패널 개발자 도구 버튼이 없습니다 (크롬 자체 로그인 상태를 씀, 패널은 F12 개발자 도구의 프레임 선택으로 봅니다).
- 기록·설정은 크롬 프로필의 확장 프로그램 저장소에 저장됩니다 (Windows 앱과 따로).
- 앱 탭을 오래 백그라운드에 두면 크롬이 타이머를 늦춰 "답변 완료" 표시가 늦을 수 있습니다.

어떻게 동작하나요: 앱 탭 안에 각 서비스를 iframe으로 띄우고, 그 탭 안의 iframe에 한해서만 사이트의 iframe 차단 헤더(`X-Frame-Options`, CSP)를 지웁니다(`declarativeNetRequest` 세션 규칙). 같은 사이트를 일반 탭으로 열 때는 아무것도 바뀌지 않습니다. 질문 입력·답변 읽기는 각 iframe 안의 content script(`extension/content.js`)가 합니다.

## 설치 (Windows)

[Releases](https://github.com/dyj02056/multitude_llm_ai/releases)의 `MultitudeLLM-Setup-<버전>.exe`를 실행합니다.
코드 서명이 없어서 처음 실행할 때 Windows SmartScreen 경고가 뜰 수 있습니다 ("추가 정보" → "실행").

직접 만들려면:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
```

결과물은 `dist\MultitudeLLM-Setup-<버전>.exe`입니다. 아이콘은 `node scripts/make-icon.js`로 다시 만들 수 있습니다.

## 코드 구조

| 폴더 | 내용 |
|---|---|
| `src/shared/` | Windows 앱과 확장 프로그램이 **같이 쓰는** 코드: 서비스 목록·셀렉터(`services.js`), 질문 보내기·종합(`rounds.js`), 답변 감시, 페이지 주입 함수, 기록, 셀렉터 원격 갱신, 단축키 |
| `src/main/`, `src/preload/` | Windows 앱(Electron) 전용 |
| `src/renderer/` | 화면 (두 쪽이 같은 파일을 씀) |
| `extension/` | 크롬 확장 프로그램. 직접 고치는 파일은 `host.js`·`content.js`·`background.js`·`ext.css`뿐이고, 나머지(`manifest.json`, `app.html`, `lib/`, `icons/`)는 생성 파일 |

`src/shared/`나 `src/renderer/`를 고친 뒤에는 확장 프로그램 폴더를 다시 만들어 함께 커밋합니다.

```bash
npm run build:ext   # extension/ 다시 만들기
npm run check:ext   # extension/ 이 src/와 맞는지 확인
```

## 실행 (개발)

```bash
npm install
npm start
```

1. Google 계정으로 로그인합니다.
2. 사용할 모델을 고릅니다 (최대 4개).
3. 각 패널이 "Google로 계속하기"로 자동 로그인합니다 (Google 계정 선택·동의, 캡차는 직접).
4. 아래 공통 입력창에 질문을 쓰고 보냅니다.

## 기능

- 8개 서비스 중 최대 4개를 골라 질문 동시 전송 (대상 켜기/끄기), 격자(2×2)·가로(1×4) 배치
- 답변 완료 감지, 패널별·전체 답변 복사 (Markdown — 표·코드 블록·목록 서식 유지)
- 사이트 셀렉터 원격 갱신: 서비스 화면이 바뀌면 [remote/selectors.json](remote/README.md)만 고쳐 바로잡음 (6시간마다 확인, 설정에서 끄기 가능)
- 답변 대기 시간 설정(기본 20분, `?` 화면), 기다린 시간 표시, 시간 초과 뒤에도 계속 지켜보다가 늦게 끝나면 완료로 갱신
- 패널별·전체 새 대화, 로그아웃(모든 로그인 정보 삭제)
- 교차검토(종합): 다른 AI 답변을 모아 한 AI에게 비교·정리 요청, 완료 후 자동 종합
- 답변 비교 화면, 질문 템플릿(요약·번역·장단점 비교 등)
- 질문·답변 기록: 자동 저장(최근 500개), 검색, Markdown 복사, 질문 다시 쓰기 — 이 PC의 앱 데이터 폴더에만 저장

## 단축키

서비스 패널 안에 커서가 있어도 동작합니다. 앱에서 `Ctrl+/`로 전체 목록을 볼 수 있습니다.

| 키 | 동작 |
|---|---|
| `Ctrl+L` | 공통 입력창으로 이동 |
| `Ctrl+Shift+N` (확장 프로그램: `Alt+Shift+N`) | 모두 새 대화 |
| `Ctrl+Shift+S` | 종합 요청 |
| `Ctrl+Shift+C` | 모든 답변 복사 (Markdown) |
| `Ctrl+Shift+D` / `Ctrl+H` | 답변 비교 / 기록 화면 |
| `Ctrl+1~9` (확장 프로그램: `Alt+Shift+1~4`) / `Alt+1~9` | N번째 보낼 대상 켜기·끄기 / N번째 패널로 이동 |
| `Esc` | 비교·기록·도움말 화면에서 패널로 돌아가기 |

## 개발 옵션

환경 변수로 켜며, 일반 실행에는 영향이 없습니다. 자세한 내용은 [src/main/dev.js](src/main/dev.js)를 참고하세요.

| 변수 | 설명 |
|---|---|
| `MLA_DEBUG=1` | 페이지 이동·자동 로그인·전송·답변 감지 로그를 터미널에 출력 |
| `MLA_START=pick` / `chat` | 로그인 확인을 건너뛰고 모델 선택 / 채팅 화면으로 시작 |
| `MLA_PROFILE=<폴더>` | 별도 프로필 폴더로 실행 (실행 중인 앱과 따로 띄울 때) |
| `MLA_DRY_SEND=1` | 질문 입력·보내기 버튼 찾기까지만 하고 실제로 보내지 않음 |
| `MLA_REMOTE_URL=<주소 또는 파일>` | 셀렉터 원격 갱신을 GitHub 대신 이 주소·로컬 파일에서 받음 |
| `MLA_ANSWER_TIMEOUT_MS` / `MLA_ANSWER_START_MS` | 답변 시간 초과 / 시작 대기 시간을 이 값(ms)으로 (시험용) |

PowerShell 예:

```powershell
$env:MLA_DEBUG = '1'; npm start -- --remote-debugging-port=9333
```

`--remote-debugging-port`를 주면 `http://127.0.0.1:9333/json`에서 각 패널 페이지를 DevTools 프로토콜로 살펴볼 수 있습니다.

확장 프로그램은 앱 탭의 개발자 도구 콘솔에서 `localStorage.setItem('mla.debug', '1')` 후 새로고침하면 전송·답변 로그를 볼 수 있습니다.

계획과 진행 상황은 [PLAN.md](PLAN.md)를 참고하세요.
