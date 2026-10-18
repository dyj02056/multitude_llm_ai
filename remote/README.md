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
- `services`의 키: `gemini`, `chatgpt`, `deepseek`, `perplexity`, `grok`, `qwen`, `poe`, `duckai`
- 고칠 수 있는 필드 (모두 문자열, 300자 이하)

| 필드 | 뜻 |
|---|---|
| `input`, `send`, `stop`, `response` | CSS 셀렉터 목록. **앱에 들어 있는 목록 앞에 붙습니다** (원격 것이 틀려도 예전 것으로 계속 찾음). `"replace": true`면 원격 목록만 씁니다. |
| `messages` | `{ container, role(정규식), content }` — 메시지마다 USER/ASSISTANT 같은 역할 표시가 붙는 사이트에서 답변을 고를 때 |
| `loggedOut` | `{ url(정규식), text(정규식), selectors }` — 로그아웃 상태 단서 |
| `loginButton`, `sendText`(정규식), `submitKey`(`Enter`·`Ctrl+Enter`), `newChatUrl`(https) | 그 밖의 설정 |

알 수 없는 서비스·필드, 형식이 틀린 값은 무시합니다. 앱은 셀렉터·정규식 문자열만 받으며 코드는 받지도 실행하지도 않습니다.

## 고치기 전에 확인

1. 앱을 `MLA_REMOTE_URL`로 로컬 파일을 보게 해서 먼저 시험합니다.

   ```powershell
   $env:MLA_REMOTE_URL = 'C:\projects_jsw\multitude_llm_ai\remote\selectors.json'; $env:MLA_DEBUG = '1'; npm start
   ```

2. 괜찮으면 커밋하고 main에 올립니다.
