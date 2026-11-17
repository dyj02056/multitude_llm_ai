# 설치 · 빌드 · 개발

[← README](../README.md)

## 설치 (Windows)

[Releases](https://github.com/dyj02056/multitude_llm_ai/releases)의 `MultitudeLLM-Setup-<버전>.exe`를 실행합니다.
코드 서명이 없어서 처음 실행할 때 Windows SmartScreen 경고가 뜰 수 있습니다 ("추가 정보" → "실행").

> `dist` 폴더의 설치 파일은 GitHub에 올라가지 않습니다(`.gitignore`). 코드를 새로 받았다면 아래처럼 **다시 빌드해야** 새 버전이 들어간 설치 파일이 생깁니다. 파일 이름의 버전은 `package.json`의 `version`을 따릅니다.

### 자동 업데이트 (v0.20.0)

- 앱을 켜고 30초 뒤, 그다음 6시간마다 GitHub Releases의 `latest.yml`을 보고 새 버전이 있는지 확인합니다. 설정(`?`) › **업데이트** › **새 버전 자동 확인**으로 끄고 켭니다.
- 새 버전이 있으면 툴바 상태줄에 `update x.y.z`가 뜹니다. 설정에서 **다운로드** → **다시 시작해서 설치**를 누르거나, 받아 둔 뒤 앱을 닫으면 설치됩니다. 저절로 받거나 설치하지는 않습니다.
- 코드 서명이 없어 서명 검사는 하지 않고, 받은 설치 파일이 `latest.yml`의 sha512와 맞을 때만 설치합니다 (electron-updater).
- 개발 실행(`npm start`)에서는 확인하지 않습니다. 업데이트 확인 주소는 `package.json`의 `build.publish`(GitHub 저장소)이고, 릴리스 워크플로가 `latest.yml` · `.blockmap`을 함께 올립니다.
- 크롬 확장은 스스로 바뀔 수 없어 GitHub main의 버전만 보고 알립니다. 저장소를 `git pull`한 뒤 `chrome://extensions`에서 ↻.

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
| `src/main/`, `src/preload/` | Windows 앱(Electron) 전용 (`views.js`: 세션 · AI 패널 뷰 · 로그인 팝업 규칙 · 셀렉터 자가진단(v0.31.0에서 `main.js`에서 나눔), `project.js`: 프로젝트 폴더 읽기·쓰기, `git-rules.js`·`gitconsole.js`: git 콘솔 명령 검사·실행, `history.js`: 기록 저장(색인 + 기록별 파일), `ipc/`: 화면 요청 처리 — 기록 · 프로젝트 · 설정) |
| `src/renderer/` | 화면 (두 쪽이 같은 파일을 씀). 읽는 순서: `templates.js` → `renderer.js`(도우미 · 패널) → `renderer-views.js`(비교 · 기록 · 설정) → `chain-views.js` → `compare-modes.js`(비교 보기 방식: 문단 맞추기 · 코드만 · 표, 계산은 `shared/compare-modes.js`) → `history-transfer-ui.js`(기록 옮기기, 계산은 `shared/history-transfer.js` · 보관은 `shared/history-archive.js`) → `renderer-compose.js`(보내기 · 상태) → `send-preview.js` · `panel-offers.js` · `debate-ui.js`(토론) → `workflow-ui.js`(작업 흐름) → `factcheck-ui.js`(사실 확인 탭) → `project.js` → `project-related.js`(관련 파일 찾기, 계산은 `shared/import-graph.js`) → `project-changes.js`(변경 제안 · 미리보기 · 적용 · 되돌리기) → `project-runs.js`(큰 작업 · 이어서 받기) → `project-devtest.js`(검사 실행) → `project-collect.js`(파일 모아보기) → `project-mix.js` → `project-commit.js` → `project-restore.js` → `project-editor.js` → `library.js` → `library-presets.js` → `settings-transfer-ui.js` → `selector-editor.js`(셀렉터 편집기, 계산은 `shared/remote-core.js`의 `sanitizeLocal` · `applyLocal`) → `onboarding.js`(첫 사용 안내) → `a11y.js`. 위 `project-*.js`는 `MLA.projectUI`(P)로 서로의 함수를 주고받습니다 |
| `src/shared/i18n*.js` | 화면 문구 다국어 (v0.24.0 틀, v0.30.0부터 설정 › 언어를 따름): `t('키', { 이름: 값 })`, 사전 `i18n-ko.js` · `i18n-en.js`(공통) + `i18n-<언어>-<영역>.js`(ui · project · library · ext · main — 키는 영역 이름으로 시작). 키 짝 · 없는 키는 테스트가 검사. 새 화면 글은 여기에 넣는다 (AI에게 보내는 글은 아직 코드에 한국어로) |
| `test/` | 공통 모듈 단위 테스트 (`npm test`) |
| `extension/` | 크롬 확장 프로그램. 직접 고치는 파일은 `host.js`(+ 먼저 읽히는 `host-panels.js` iframe · `host-remote.js` 원격 셀렉터 · 업데이트, v0.31.0에서 나눔 — 서로 `MLA.extHost`로 주고받음)·`project-fs.js`·`content.js`·`cookie-shim.js`·`cookie-bridge.js`·`background.js`·`ext.css`와 사이드탭 `sidepanel.html`·`sidepanel.js`·`sidepanel.css`뿐이고, 나머지(`manifest.json`, `app.html`, `lib/`, `icons/`)는 생성 파일 |

`src/shared/`나 `src/renderer/`를 고친 뒤에는 확장 프로그램 폴더를 다시 만들어 함께 커밋합니다. `npm install` 때 커밋 전 훅(`scripts/hooks/pre-commit`)이 연결되어, 잊으면 커밋을 멈춥니다.

```bash
npm run build:ext   # extension/ 다시 만들기
npm run check:ext   # extension/ 이 src/와 맞는지 확인
npm test            # 단위 테스트 (공통 모듈 · 확장 background 규칙 · 매니페스트 권한)
```

## 스크린샷 다시 찍기 (v0.20.1)

```bash
npm run screenshots                         # 모든 장면 → docs/screenshots/*.png
npm run screenshots -- 02-ask-all 24-side-panel   # 일부만
```

- [scripts/screenshots/](../scripts/screenshots)가 실제 화면 코드(`src/renderer` · `extension/sidepanel.html`)에 가짜 본체와 예시 데이터를 붙여 Electron 창(화면 밖 렌더링)에 띄우고 장면마다 저장합니다. 장면 목록은 `run.js`의 `SCENES`, 예시 질문 · 답은 `sample.js`.
- 패널 안은 실제 AI 사이트가 아니라 **테스트용 채팅 페이지**입니다. 실제 사이트에는 접속하지 않습니다 (서비스 주소 요청은 이 도구 안에서 가짜 페이지로 바뀜).
- 디자인을 바꾼 뒤 다시 찍으면 문서 그림이 한 번에 맞춰집니다. 프로젝트 장면(09 · 10 · 16 · 21~23 · 36~40 · 47)은 가짜 프로젝트 폴더(`demo-app`)로 찍습니다 (v0.31.0). 크롬 확장 탭(08)만 이 도구로 찍을 수 없습니다.
- `MLA_SHOT_OUT=<폴더>`를 주면 문서 그림을 바꾸지 않고 그 폴더에 찍습니다. 화면 스크립트 오류는 `console error:`로 출력됩니다.
- `MLA_SHOT_LANG=en`을 주면 **영어 화면**으로 찍습니다 (v0.30.0, 예시 질문 · 답은 한국어 그대로). 영어 문서가 쓰는 그림은 `docs/screenshots/en/`에 있습니다 — `MLA_SHOT_LANG=en MLA_SHOT_OUT=docs/screenshots/en npm run screenshots -- 01-model-picker 02-ask-all …`.

## 출시 전 확인 (v0.30.0)

태그를 올리기 전에 사람이 직접 해 보는 확인(실제 로그인 팝업 · 실제 크롬 · 실제 Ollama · 셀렉터 점검 · OS 알림 · 자동 업데이트 · 예전 데이터 · 언어 바꾸기 · 키보드만으로 한 바퀴)은 **[출시 전 확인 목록](release-checklist.md)** 에 순서대로 있습니다. 접근성 기준과 알려진 모자란 점은 [접근성](accessibility.md).

## 셀렉터 점검 (v0.25.0)

AI 사이트 화면이 바뀌어 앱이 입력창 · 보내기 버튼 · 답변을 못 찾는지 한 번에 확인합니다. 서비스마다 숨은 창으로 처음 화면을 열고, 앱이 쓰는 셀렉터(앱 내장 + 저장소의 `remote/selectors.json`)가 지금 화면에서 찾아지는지 봅니다. **읽기만 합니다** — 입력 · 클릭 · 보내기를 하지 않습니다.

```powershell
# 로그인된 앱 프로필로 (앱을 먼저 끄세요 — 같은 프로필을 두 프로그램이 동시에 쓰면 안 됩니다)
$env:MLA_PROFILE = "$env:APPDATA\Multitude LLM"; npm run selectors:probe
# 일부 서비스만, 보고서 경로 지정, 창 보이기
npm run selectors:probe -- gemini claude --out probe.json --show
# 실제 사이트 대신 가짜 페이지로 도구만 시험 (인터넷 접속 없음)
npm run selectors:probe -- --fake
```

- 결과: 터미널 요약(서비스마다 `input ✓ send – stop – response –`, 정상 · 입력창 못 찾음 · 로그아웃 · 열지 못함)과 JSON 보고서(`--out`, 없으면 임시 폴더의 `mla-selectors-probe.json`). 보고서에는 셀렉터 · 찾은 개수 · 로그인 버튼 문구만 있고 대화 글은 없습니다.
- **입력창**을 못 찾으면 실패입니다. 보내기 버튼은 글을 쓰기 전에는 숨는 사이트가 많고, 중지 버튼 · 답변은 질문을 보내야 생기므로 못 찾아도 `–`(확인 못 함)로만 표시합니다.
- 입력창을 못 찾은 서비스가 있으면 `remote/selectors.json`에 넣을 틀을 출력합니다(파일은 바꾸지 않음). 고치는 순서는 [remote/README.md](../remote/README.md#셀렉터-점검-도구-v0250).
- `MLA_PROFILE`이 없으면 빈 프로필이라 대부분 로그아웃 상태로 보입니다. `--builtin`은 원격 셀렉터 없이, `--remote <파일>`은 그 파일을 더해 점검합니다. `--wait <초>`(기본 15)는 입력창이 나타나길 기다리는 최대 시간입니다.
- 종료 코드: 모두 정상 · 로그아웃이면 0, 입력창 못 찾음 · 열지 못함이 있으면 1.

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

