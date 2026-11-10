# 설치 · 빌드 · 개발

[← README](../README.md)

## 설치 (Windows)

[Releases](https://github.com/dyj02056/multitude_llm_ai/releases)의 `MultitudeLLM-Setup-<버전>.exe`를 실행합니다.
코드 서명이 없어서 처음 실행할 때 Windows SmartScreen 경고가 뜰 수 있습니다 ("추가 정보" → "실행").

> `dist` 폴더의 설치 파일은 GitHub에 올라가지 않습니다(`.gitignore`). 코드를 새로 받았다면 아래처럼 **다시 빌드해야** 새 버전이 들어간 설치 파일이 생깁니다. 파일 이름의 버전은 `package.json`의 `version`을 따릅니다.

## 설치 파일 직접 만들기 (Windows)

저장소 폴더에서 연 **PowerShell** 창에서 차례로 실행합니다.

```powershell
# 1) 최신 코드 받기
git pull origin main

# 2) 예전 빌드 결과(0.1.0 등) 지우기
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue

# 3) 의존성 맞추기
npm install

# 4) 이 창에서만 스크립트 실행을 허용하고 빌드 실행
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\build-win.ps1
```

- 결과물은 `dist\MultitudeLLM-Setup-<버전>.exe`입니다 (버전은 `package.json`의 `version`). 처음에는 Electron을 내려받느라 몇 분 걸릴 수 있습니다.
- 4번의 실행 허용은 그 PowerShell 창을 닫으면 사라집니다 (PC 설정은 바뀌지 않음).
- `powershell -ExecutionPolicy Bypass -File ...` 형태는 PATH에 `powershell`이 없는 PC에서 `'powershell' 용어가 ... 인식되지 않습니다` 오류가 납니다. 위 4번처럼 열린 창에서 직접 실행하세요. 그래도 빌드 중 같은 오류가 나면 전체 경로로 실행합니다.

  ```powershell
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ExecutionPolicy Bypass -File scripts\build-win.ps1
  ```
- 아이콘은 `node scripts/make-icon.js`로 다시 만들 수 있습니다.
- 태그(`v0.5.0` 등)를 푸시하면 GitHub Actions가 설치 파일과 확장 프로그램 zip을 만들어 Releases에 올립니다 (`.github/workflows/release.yml`).

## 실행 (개발)

```bash
npm install
npm start
```

1. Google 계정으로 로그인합니다.
2. 사용할 모델을 고릅니다 (최대 6개).
3. 각 패널이 "Google로 계속하기"로 자동 로그인합니다 (Google 계정 선택·동의, 캡차는 직접).
4. 아래 공통 입력창에 질문을 쓰고 보냅니다.

## 코드 구조

| 폴더 | 내용 |
|---|---|
| `src/shared/` | Windows 앱과 확장 프로그램이 **같이 쓰는** 코드: 서비스 목록·셀렉터(`services.js`), 패널 배치(`layout.js`), 템플릿 변수·스킬(`prompt-lib.js`), 질문 보내기·종합(`rounds.js` · `synth.js`), 답변 감시(`watch.js`), 페이지 주입 함수(`page.js` · `markdown.js`), 기록(`history-core.js`), 셀렉터 원격 갱신(`remote-core.js`), 단축키(`shortcuts.js`), 분석 · 차이 강조(`analysis.js`), 셀렉터 자가진단(`diag.js`), 내보내기(`export.js`), 로컬 LLM(`local-llm.js`), 웹페이지로 질문(`web-ask.js`), 사이드탭 계산(`side-panel.js`), 프로젝트 모드(`project-ignore.js` 제외 규칙, `secret-scan.js`, `project-context.js`, `project-upload.js` 업로드 파일 만들기, `patch.js`) |
| `src/shared/vendor/` | 포함한 외부 라이브러리: [ignore](https://github.com/kaelzhang/node-ignore) 7.0.12 (MIT), [jsdiff](https://github.com/kpdecker/jsdiff) 9.0.0 (BSD-3-Clause) — 라이선스 파일 함께 |
| `src/main/`, `src/preload/` | Windows 앱(Electron) 전용 (`project.js`: 프로젝트 폴더 읽기·쓰기, `git-rules.js`·`gitconsole.js`: git 콘솔 명령 검사·실행) |
| `src/renderer/` | 화면 (두 쪽이 같은 파일을 씀) |
| `test/` | 공통 모듈 단위 테스트 (`npm test`) |
| `extension/` | 크롬 확장 프로그램. 직접 고치는 파일은 `host.js`·`project-fs.js`·`content.js`·`cookie-shim.js`·`cookie-bridge.js`·`background.js`·`ext.css`와 사이드탭 `sidepanel.html`·`sidepanel.js`·`sidepanel.css`뿐이고, 나머지(`manifest.json`, `app.html`, `lib/`, `icons/`)는 생성 파일 |

`src/shared/`나 `src/renderer/`를 고친 뒤에는 확장 프로그램 폴더를 다시 만들어 함께 커밋합니다.

```bash
npm run build:ext   # extension/ 다시 만들기
npm run check:ext   # extension/ 이 src/와 맞는지 확인
npm test            # 단위 테스트 (공통 모듈 · 확장 background 규칙 · 매니페스트 권한)
```

## 개발 옵션

환경 변수로 켜며, 일반 실행에는 영향이 없습니다. 자세한 내용은 [src/main/dev.js](../src/main/dev.js)를 참고하세요.

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

계획과 진행 상황은 [PLAN.md](../PLAN.md)를 참고하세요.

