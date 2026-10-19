# 사이트 셀렉터 원격 갱신

설치된 앱과 크롬 확장 프로그램은 6시간마다(그리고 시작할 때) 이 폴더의 `selectors.json`을 GitHub에서 받아 적용합니다.

```
https://raw.githubusercontent.com/dyj02056/multitude_llm_ai/main/remote/selectors.json
```

ChatGPT·Gemini 같은 서비스 화면이 바뀌어 **입력창·보내기 버튼·답변을 못 찾게 되면**, 앱을 다시 배포하지 않고 이 파일만 고쳐 main에 올리면 됩니다. 사용자 앱은 다음 확인 때(최대 6시간, 또는 설정의 "지금 확인") 새 셀렉터를 씁니다.

## 형식

```json
{
  "version": 2,
  "updated": "2026-11-01",
  "services": {
    "chatgpt": {
      "input": ["#new-prompt-box"],
      "response": ["[data-new-answer]"]
    },
    "grok": {
      "response": [".message-bubble .new-answer-class"]
    }
  }
}
```

- `version`: 정수. 바꿀 때마다 올립니다.
- `services`의 키: `gemini`, `chatgpt`, `deepseek`, `perplexity`, `grok`, `mistral`, `qwen`, `genspark`, `duckai`, `claude`, `zai`
- 고칠 수 있는 필드 (모두 문자열, 300자 이하)

| 필드 | 뜻 |
|---|---|
| `input`, `stop`, `response` | CSS 셀렉터 목록. **앱에 들어 있는 목록 앞에 붙습니다** (원격 것이 틀려도 예전 것으로 계속 찾음). `"replace": true`면 원격 목록만 씁니다. |
| `messages` | `{ container, role(정규식), content }` — 메시지마다 USER/ASSISTANT 같은 역할 표시가 붙는 사이트에서 답변을 고를 때 |
| `loggedOut` | `{ url(정규식), text(정규식), selectors }` — 로그아웃 상태 단서 |
| `upload` | 파일 첨부 확인용 `{ attached, busy, accept }` — `attached`(첨부되면 나타나는 요소)·`busy`(업로드 중 표시)는 셀렉터 목록, `accept`는 `image`·`document`. 적은 항목만 바뀝니다. |
| `newChatUrl` | "새 대화"로 열 주소. **https이고 그 서비스의 도메인일 때만** 받습니다 (예: chatgpt는 `https://chatgpt.com/...`) |

### 원격으로 바꿀 수 없는 것 (v0.4.1부터, 보안상)

페이지에서 무언가를 **누르거나 파일을 넣는** 셀렉터는 원격 설정이 털렸을 때 엉뚱한 버튼(공유·삭제 등)을 누르게 할 수 있어서, 원격 값을 **무시하고 앱 업데이트로만** 바꿉니다.

- `send`, `sendText`, `loginButton`, `submitKey`, `upload.methods`, `upload.fileInput`
- 정규식은 300자 이하이고, 계산이 폭주할 수 있는 모양(`(a+)+` 같은 반복 안의 반복, `(a|ab)*` 같은 반복되는 선택, `\1` 역참조)은 거절합니다.
- 무시한 항목은 앱의 `?` → 설정 화면 "사이트 셀렉터 자동 갱신" 아래에 "보안상 무시한 항목"으로 보입니다.

보내기 버튼을 못 찾게 되어도 앱은 Enter 키로 보내는 예비 동작이 있어 대부분 계속 작동합니다. 버튼 셀렉터는 `src/shared/services.js`를 고쳐 새 버전으로 배포합니다.

알 수 없는 서비스·필드, 형식이 틀린 값은 무시합니다. 앱은 셀렉터·정규식 문자열만 받으며 코드는 받지도 실행하지도 않습니다.

## 고치기 전에 확인

1. 앱을 `MLA_REMOTE_URL`로 로컬 파일을 보게 해서 먼저 시험합니다.

   ```powershell
   $env:MLA_REMOTE_URL = 'C:\projects_jsw\multitude_llm_ai\remote\selectors.json'; $env:MLA_DEBUG = '1'; npm start
   ```

2. 괜찮으면 커밋하고 main에 올립니다.
