# multitude_llm_ai

Gemini · ChatGPT · DeepSeek · Groq 웹 채팅을 한 화면에 띄워 같은 질문을 동시에 보내고 답변을 비교하는 Electron 데스크톱 앱입니다.

API 키 없이 각 서비스의 무료 웹 채팅을 그대로 쓰며, 로그인은 Google 계정 하나로 합니다.

![네 AI에 동시에 질문하고 답변을 나란히 받는 화면](docs/screenshots/02-ask-all.png)

## 한눈에 보기

> 스크린샷의 계정 정보(이름·프로필)와 이전 대화 목록은 흐리게 처리했습니다.

### 1. 모델 고르기

Google로 로그인한 뒤 쓸 모델을 고릅니다. 고른 모델만 패널로 열리고, 각 서비스에는 "Google로 계속하기"로 자동 로그인합니다.

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

## 설치 (Windows)

[Releases](https://github.com/dyj02056/multitude_llm_ai/releases)의 `MultitudeLLM-Setup-<버전>.exe`를 실행합니다.
코드 서명이 없어서 처음 실행할 때 Windows SmartScreen 경고가 뜰 수 있습니다 ("추가 정보" → "실행").

직접 만들려면:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
```

결과물은 `dist\MultitudeLLM-Setup-<버전>.exe`입니다. 아이콘은 `node scripts/make-icon.js`로 다시 만들 수 있습니다.

## 실행 (개발)

```bash
npm install
npm start
```

1. Google 계정으로 로그인합니다.
2. 사용할 모델을 고릅니다.
3. 각 패널이 "Google로 계속하기"로 자동 로그인합니다 (Google 계정 선택·동의, 캡차는 직접).
4. 아래 공통 입력창에 질문을 쓰고 보냅니다.

## 기능

- 선택한 모델에 질문 동시 전송 (대상 켜기/끄기)
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
| `Ctrl+Shift+N` | 모두 새 대화 |
| `Ctrl+Shift+S` | 종합 요청 |
| `Ctrl+Shift+C` | 모든 답변 복사 (Markdown) |
| `Ctrl+Shift+D` / `Ctrl+H` | 답변 비교 / 기록 화면 |
| `Ctrl+1~9` / `Alt+1~9` | N번째 보낼 대상 켜기·끄기 / N번째 패널로 이동 |
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

계획과 진행 상황은 [PLAN.md](PLAN.md)를 참고하세요.
