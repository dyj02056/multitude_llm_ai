// AI에게 보내는 글 — 한국어 (v0.31.0). 키 이름은 'prompt.무엇' 꼴로 시작한다.
// 화면 문구가 아니라 종합 · 분석 · 토론 · 넘기기 · 스킬 · 웹페이지 질문 · 프로젝트 모드에서 AI에게 보내는 요청 글이다.
// 같은 키를 i18n-en-prompt.js에도 넣는다 (test/i18n.test.js가 짝 · 겹침 · {이름} 자리를 검사).
//
// 고칠 때 지킬 것:
//   - 답을 읽는 쪽(patch.js · analysis.js · project-context.js)이 찾는 표시는 두 언어 모두 그 부품이 읽을 수 있어야 한다:
//     "파일: 경로" / "File: path", "<<<<<<< 찾기" / "<<<<<<< SEARCH", ">>>>>>> 바꾸기" / ">>>>>>> REPLACE",
//     DELETE_FILES · NEED_FILES · PLAN_FILES(두 언어 같음), 분석 머리글(analysis.js SECTIONS).
//   - 한국어 글은 v0.30.0까지 코드에 있던 글 그대로다 (테스트가 글자까지 본다).
(function (root, dict) {
  if (typeof module === 'object' && module.exports) module.exports = dict;
  else {
    const s = ((root.MLA = root.MLA || {}).i18nStrings = root.MLA.i18nStrings || {});
    s.ko = Object.assign(s.ko || {}, dict);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, {
  // ---------- 공통 ----------
  'prompt.clipped': '…(이하 생략)',
  'prompt.origQuestion': '[원래 질문]',
  'prompt.noQuestion': '(질문 없음)',
  'prompt.answerOf': '[{name}의 답변]',

  // ---------- 넘기기 (chain.js) ----------
  'prompt.handoff.intro': '다른 AI({name})가 쓴 답변을 보여 드립니다.',
  'prompt.handoff.review': [
    '위 답변을 꼼꼼히 검토해 주세요.',
    '1) 틀린 내용 · 부정확한 부분 (어디가 왜 틀렸는지)',
    '2) 빠진 중요한 내용',
    '3) 근거가 약하거나 확인이 필요한 주장',
    '4) 위를 고친 더 나은 답변',
  ].join('\n'),
  'prompt.handoff.counter': [
    '위 답변에 반박해 주세요.',
    '1) 가장 약한 논리 · 반례 · 다른 관점을 근거와 함께',
    '2) 그래도 맞는 부분은 인정',
    '3) 반박을 반영한 당신의 결론',
  ].join('\n'),
  'prompt.handoff.continue': [
    '위 답변을 이어받아 더 발전시켜 주세요.',
    '빠진 단계를 채우고, 더 깊이 들어가거나 다음에 할 일을 구체적으로 써 주세요. 이미 쓴 내용은 되풀이하지 마세요.',
  ].join('\n'),

  // ---------- 토론 (chain.js) ----------
  'prompt.debate.head': '[토론 {round}/{rounds}라운드] 같은 질문에 대해 다른 AI들이 아래와 같이 답했습니다.',
  'prompt.debate.latestOf': '[{name}의 최신 답변]',
  'prompt.debate.askSelf': '{name}(당신)의 이전 답변과 비교해 다음을 해 주세요.',
  'prompt.debate.ask': '당신의 이전 답변과 비교해 다음을 해 주세요.',
  'prompt.debate.steps': [
    '1) 다른 답변에서 틀렸거나 근거가 약한 점을 구체적으로 반박',
    '2) 다른 답변이 옳은 점은 받아들여 당신의 답을 고치기',
    '3) 고친 입장을 처음 보는 사람도 이해할 수 있는 완성된 답변으로 다시 쓰기',
  ].join('\n'),
  'prompt.debate.last': ' (이번이 마지막 라운드입니다)',
  'prompt.judge.head': '여러 AI가 같은 질문을 두고 {rounds}라운드 동안 서로 반박 · 보완하며 토론했습니다. 아래는 각 AI의 마지막 입장입니다.',
  'prompt.judge.finalOf': '[{name}의 마지막 입장]',
  'prompt.judge.format': [
    '판정자로서 아래 형식 그대로 정리해 주세요. 머리글 이름과 순서를 바꾸지 마세요.',
    '',
    '## 합의한 점',
    '- 참가 AI들이 같은 결론에 이른 내용 (한 줄에 하나)',
    '',
    '## 남은 이견',
    '- [쟁점] AI별 입장과, 어느 쪽이 맞는지와 이유 (없으면 "- 없음")',
    '',
    '## 최종 답변',
    '토론을 반영한 가장 정확하고 완성도 높은 최종 답변',
  ].join('\n'),

  // ---------- 종합 (synth.js) ----------
  'prompt.synth.head': '같은 질문에 대해 다른 AI들이 아래와 같이 답했습니다.',
  'prompt.synth.ask': '위 답변들을 비교해서 다음을 정리해 주세요.',
  'prompt.synth.askSelf': '당신의 이전 답변과 위 답변들을 비교해서 다음을 정리해 주세요.',
  'prompt.synth.steps': ['1) 오류나 부정확한 부분', '2) 서로 놓친 중요한 내용', '3) 가장 정확하고 완성도 높은 최종 답변'].join('\n'),
  'prompt.synth.code.head': '같은 코드 작업 요청에 대해 다른 AI들이 아래와 같은 수정안을 냈습니다.',
  'prompt.synth.code.ask': '위 답변들을 비교해서 다음을 해 주세요.',
  'prompt.synth.code.askSelf': '당신의 이전 답변과 위 답변들을 비교해서 다음을 해 주세요.',
  'prompt.synth.code.steps': [
    '1) 각 수정안의 문제점(버그·빠진 처리)을 짧게 정리',
    '2) 가장 좋은 부분을 합친 최종 수정안을 diff가 아니라, 바꾸거나 새로 만든 파일마다 "파일: 경로" 줄 다음에 그 파일의 "전체" 내용을 코드 블록 하나로 제시 (줄임 없이 처음부터 끝까지)',
    '   150줄보다 긴 기존 파일은 전체 대신 바꿀 곳만 같은 코드 블록 안에 "<<<<<<< 찾기" / (지금 코드 그대로) / "=======" / (바꾼 코드) / ">>>>>>> 바꾸기"로 (답이 길어져 잘리지 않게)',
    '3) 지워야 하는 파일은 한 줄로: DELETE_FILES: 경로1, 경로2',
  ].join('\n'),

  // ---------- 분석 (synth.js — 머리글 이름은 analysis.js SECTIONS와 같아야 한다) ----------
  'prompt.analysis.head': '같은 질문에 대해 여러 AI가 아래와 같이 답했습니다.',
  'prompt.analysis.ask': [
    '답변들이 어디서 일치하고 어디서 갈리는지 분석해, 아래 형식 그대로 답해 주세요.',
    '머리글 네 개(## 공통 의견, ## 이견, ## 근거 부족, ## 최종 답변)의 이름과 순서를 바꾸지 말고, 형식 앞뒤에 다른 말을 쓰지 마세요. 전체를 코드 블록으로 감싸지 마세요.',
  ].join('\n'),
  'prompt.analysis.self': '당신({name})이 이전에 같은 질문에 한 답변도 "{name}" 열로 함께 비교해 주세요.',
  'prompt.analysis.common': ['## 공통 의견', '- 대부분의 AI가 같은 내용 (한 줄에 하나)'].join('\n'),
  'prompt.analysis.disagree': '## 이견',
  'prompt.analysis.colTopic': '쟁점',
  'prompt.analysis.colVerdict': '판단',
  'prompt.analysis.cellTopic': '갈리는 점 한 줄',
  'prompt.analysis.cellPosition': '그 AI의 입장 (언급 없으면 -)',
  'prompt.analysis.cellVerdict': '어느 쪽이 맞는지와 이유 한 줄',
  'prompt.analysis.noDisagree': '(이견이 없으면 표 대신 "- 없음" 한 줄)',
  'prompt.analysis.rest': [
    '## 근거 부족',
    '- [AI 이름] 근거 없이 주장했거나 사실 확인이 필요한 내용 (없으면 "- 없음")',
    '',
    '## 최종 답변',
    '위 분석을 반영한 가장 정확하고 완성도 높은 최종 답변',
  ].join('\n'),

  // ---------- 스킬 (prompt-lib.js) ----------
  'prompt.skill.compress': [
    '아래는 AI에게 줄 지침("{name}")이야. 이 지침을 {n}자 이내로 압축해 줘.',
    '- 반드시 지켜야 하는 규칙·절차·조건·금지 사항·출력 형식은 하나도 빠뜨리지 마.',
    '- 설명·배경·예시·인사말·반복은 빼고, 짧은 명령문 목록으로 써.',
    '- 지침을 따르는 AI가 읽는 글이야. 원문과 같은 언어로 써.',
    '- 결과는 코드 블록 하나에만 넣고, 다른 말은 쓰지 마.',
  ].join('\n'),
  'prompt.skill.compressOpen': '----- 지침 원문 -----',
  'prompt.skill.compressClose': '----- 끝 -----',
  'prompt.skill.question': '### 질문',
  'prompt.skill.one': ['### 지침 (스킬: {name})', '이 대화가 끝날 때까지 아래 지침을 따라 답해 줘. 지침 자체를 다시 설명하거나 요약하지는 마.'].join('\n'),
  'prompt.skill.many': [
    '### 지침 (스킬 {n}개 — 위에 있는 것이 우선)',
    '이 대화가 끝날 때까지 아래 지침을 모두 따라 답해 줘. 서로 부딪히면 먼저 나온 지침을 따라. 지침 자체를 다시 설명하거나 요약하지는 마.',
  ].join('\n'),
  'prompt.skill.change': '### 지침 변경',
  'prompt.skill.drop': '지금부터 다음 지침은 따르지 마: {names}',
  'prompt.skill.addOne': '지금부터 아래 지침도 따라 줘 (이전 지침과 부딪히면 이것을 따라).',
  'prompt.skill.addMany': '지금부터 아래 지침들도 따라 줘 (이전 지침과 부딪히면 이것을 따라).',
  'prompt.skill.gone': '이전 스킬',

  // ---------- 웹페이지로 질문 · 사이드탭 (web-ask.js · side-panel.js) ----------
  'prompt.web.page': '웹페이지',
  'prompt.web.selection': '다음은 웹페이지 {src}에서 고른 글입니다.',
  'prompt.web.firstChars': ' (길어서 앞 {n}자만)',
  'prompt.web.question': '질문: ',
  'prompt.web.source': '출처: {url}',
  'prompt.web.fetched': '가져온 때: {when}',
  'prompt.web.attached': '첨부한 page.md는 웹페이지 {src}의 본문입니다.',
  'prompt.web.inline': '다음은 내가 지금 보고 있는 웹페이지 {src}의 본문입니다. 이 내용을 바탕으로 답해 주세요.',

  // ---------- 커밋 메시지 (commit-msg.js) ----------
  'prompt.commit.ask': [
    '방금 제안해 준 수정안을 아래 파일에 적용했습니다. 이 변경을 설명하는 git 커밋 메시지를 영어 한 줄(72자 이내, 명령형, 예: "Fix null check in user loader")로만 써 주세요.',
    '다른 설명 · 따옴표 · 코드 블록 없이 메시지 한 줄만 답해 주세요.',
  ].join('\n'),

  // ---------- 프로젝트 모드 (project-context.js) ----------
  // 답변 규칙: 이 형식을 지켜야 변경 제안 · 파일 모아보기가 수정안을 찾는다. {n} = 전체 대신 찾기/바꾸기로 받는 줄 수(EDIT_LINES)
  'prompt.proj.rules': [
    '[답변 규칙]',
    '1) 먼저 원인이나 설계를 3줄 이내로 설명해 줘.',
    '2) 파일 수정은 diff로 주지 말고, 파일마다 "파일: 경로" 줄 다음에 코드 블록 하나로 줘. 한 코드 블록에는 한 파일만 넣어 줘.',
    '   - 새 파일이거나 {n}줄 이하인 파일: 그 파일의 "전체" 내용. "..."이나 "(기존과 같음)"으로 줄이지 말고 처음부터 끝까지 다 써 줘.',
    '   - {n}줄보다 긴 기존 파일: 전체를 다시 쓰지 말고 바꿀 곳만 찾기/바꾸기로 줘 (답이 길어져 잘리지 않게). 찾을 부분은 지금 파일 그대로(한 글자도 바꾸지 말고) 파일 안에서 한 곳만 맞도록 앞뒤 줄을 조금 넣고, 바꿀 곳이 여러 군데면 한 블록 안에 여러 번 써 줘.',
    '   내용에 ``` 가 들어 있는 파일(.md 등)은 바깥 울타리를 ```` (백틱 4개, 안쪽보다 길게)로 써서 블록이 중간에 끊기지 않게 해 줘:',
    '파일: 경로/짧은파일',
    '```',
    '(수정한 전체 내용)',
    '```',
    '파일: 경로/긴파일',
    '```',
    '<<<<<<< 찾기',
    '(지금 파일에서 바꿀 부분 그대로)',
    '=======',
    '(바꾼 내용)',
    '>>>>>>> 바꾸기',
    '```',
    '   코드 자체에 ======= 만 있는 줄이 있으면, 찾을 부분이 파일에서 한 곳만 맞도록 앞뒤 줄을 넉넉히 넣어 줘.',
    '3) 지워야 하는 파일이 있으면 한 줄로 적어 줘: DELETE_FILES: 경로1, 경로2',
    '4) 내용을 더 봐야 하는 파일이 있으면 답변 맨 끝에 한 줄로 적어 줘: NEED_FILES: 경로1, 경로2',
  ].join('\n'),
  'prompt.proj.fileLabel': '[파일: {path}]',
  'prompt.proj.treeCut': '… ({n}줄 생략)',
  'prompt.proj.head': '[프로젝트: {name}] (제외 규칙을 통과한 파일 {total}개 중 {n}개 내용 포함)',
  'prompt.proj.tree': '[프로젝트 구조]',
  'prompt.proj.request': '[요청]',
  'prompt.proj.noRequest': '(요청 없음 — 위 내용을 검토해 줘)',
  'prompt.proj.noRequestAttached': '(요청 없음 — 첨부한 내용을 검토해 줘)',
  'prompt.proj.noRequestPlain': '(요청 없음)',
  'prompt.proj.short': '[프로젝트: {name}] 첨부한 {file}에 프로젝트 구조와 파일 {n}개의 내용이 있습니다.',
  'prompt.proj.cut': '… (분량이 많아 여기까지만 넣었습니다)',
  'prompt.proj.followUp': '요청한 파일입니다.',
  'prompt.proj.skipped': '[보내지 않은 파일]',
  'prompt.proj.sameRules': '같은 답변 규칙으로 이어서 답해 줘.',
  'prompt.proj.refetchIntro': '아래 파일은 네가 준 diff가 현재 내용과 맞지 않아 적용하지 못했어. 지금 내용을 줄게.',
  'prompt.proj.refetchFull': '수정한 "전체" 파일 내용을 "파일: {path}" 줄 다음에 코드 블록 하나로 다시 줘.',
  'prompt.proj.planFirst': [
    '[큰 작업 — 이번 답은 계획만]',
    '이번 답에서는 코드를 쓰지 마. 고칠 파일이 많아서, 먼저 계획만 받고 파일마다 따로 물어볼게.',
    '1) 무엇을 어떻게 바꿀지 5줄 이내로 설명해 줘.',
    '2) 바꾸거나 새로 만들 파일을 고치는 순서대로, 한 줄에 하나씩 "- 경로: 그 파일에서 할 일 한 줄"로 적어 줘.',
    '3) 맨 끝에 같은 파일들을 한 줄로 적어 줘: PLAN_FILES: 경로1, 경로2, 경로3',
    '4) 지울 파일은 DELETE_FILES: 경로 로 적어 줘. 내용을 더 봐야 하는 파일은 NEED_FILES: 경로 로 적어 줘.',
    '아래 답변 규칙(코드 형식)은 내가 파일별로 물어볼 때 지켜 줘.',
  ].join('\n'),
  'prompt.proj.step': [
    '계획대로 {i}/{total}번째 파일만 줘: {path}{note}',
    '"파일: {path}" 줄 다음 코드 블록 하나로, 처음 답변 규칙대로 줘 ({n}줄 이하 · 새 파일은 전체 내용, 그보다 긴 기존 파일은 찾기/바꾸기).',
    '이번 답에는 이 파일만 쓰고 다른 파일은 쓰지 마. 설명은 2줄 이내로. 다음 파일은 내가 따로 물어볼게.',
  ].join('\n'),
  // 보내지 않은 파일의 이유 (renderer/project.js SKIP_WHY — AI에게 가는 글)
  'prompt.proj.skip.binary': '바이너리 파일',
  'prompt.proj.skip.tooLarge': '1MB 초과',
  'prompt.proj.skip.missing': '파일이 없습니다',
  'prompt.proj.skip.unreadable': '읽지 못함',
  'prompt.proj.skip.secret': '비밀 정보로 보이는 문자열이 있어 보내지 않음',
  'prompt.proj.skip.badPath': '허용되지 않는 경로',
  'prompt.proj.skip.notInProject': '프로젝트에 없는 파일',
  'prompt.proj.skip.excluded': '제외 규칙: {rule}',

  // ---------- 프로젝트 파일 올리기 (project-upload.js) ----------
  'prompt.up.part': '({path} — 파일이 커서 {total}조각으로 나눔: {i}/{total}, 이어 붙이면 한 파일)',
  'prompt.up.chunk': '({total}개 중 {i}번째)',
  'prompt.up.filesRule':
    '올린 파일 이름의 "__"는 폴더 구분이고 끝의 ".txt"는 업로드용으로 붙인 것이야. 답변의 "파일: 경로"·NEED_FILES·DELETE_FILES에는 실제 경로(목록의 오른쪽)를 써 줘.',
  'prompt.up.mapHead': '[올린 파일 {n}개 → 실제 경로]',
  'prompt.up.mapHeadPlain': '[올린 파일 → 실제 경로]',
  'prompt.up.noFiles': '(내용을 올린 파일 없음)',
  'prompt.up.treeAttached': '[프로젝트 구조] 첨부한 project-structure.md에 있습니다.',
  'prompt.up.attachedHas': '첨부한 {names}에 프로젝트 구조와 파일 {n}개의 내용이 있습니다.',
  'prompt.up.followFiles': '요청한 파일 {n}개를 올렸습니다.',
  'prompt.up.followBundle': '요청한 파일 {n}개의 내용을 첨부한 {names}에 넣었습니다.',
  'prompt.up.editedIntro': '내가 로컬에서 프로젝트 파일을 고쳤어. 이전에 보낸 내용 대신 아래 내용을 기준으로 해 줘.',
  'prompt.up.editedAck': '지금은 수정하지 말고 무엇이 바뀌었는지 3줄 이내로 확인만 해 줘. 다음 요청부터 같은 답변 규칙을 지켜 줘.',
  'prompt.up.editedBundle': '바뀐 파일 {n}개의 지금 내용을 첨부한 {names}에 넣었습니다.',
  'prompt.up.gone': '[지워진 파일]',
  'prompt.up.refetch.diffFile': '첨부한 {name} 파일({path})은 네가 준 수정안이 현재 내용과 맞지 않아 적용하지 못했어. 첨부한 것이 지금 내용이야.',
  'prompt.up.refetch.truncFile': '첨부한 {name} 파일({path})은 네 답변이 길어서 중간에 잘려 적용하지 못했어. 첨부한 것이 지금 내용이야.',
  'prompt.up.refetch.diffBundle': '첨부한 {name}의 파일({path})은 네가 준 수정안이 현재 내용과 맞지 않아 적용하지 못했어. 첨부한 것이 지금 내용이야.',
  'prompt.up.refetch.truncBundle': '첨부한 {name}의 파일({path})은 네 답변이 길어서 중간에 잘려 적용하지 못했어. 첨부한 것이 지금 내용이야.',
  'prompt.up.refetch.long':
    '이 파일은 길어서 전체를 다시 쓰지 말고, "파일: {path}" 줄 다음 코드 블록 하나에 바꿀 곳만 찾기/바꾸기(<<<<<<< 찾기 / ======= / >>>>>>> 바꾸기)로 줘. 찾을 부분은 지금 내용 그대로, 파일 안에서 한 곳만 맞게.',
  'prompt.up.inc.head': '[프로젝트: {name}] (이어지는 질문 — 바뀌었거나 처음 보내는 파일 {n}개만 올림{same})',
  'prompt.up.inc.headSame': ' · {n}개는 앞서 보낸 그대로',
  'prompt.up.inc.fileHead': '[프로젝트: {name}] (제외 규칙을 통과한 파일 {total}개의 구조 · 파일 {n}개 내용)',
  'prompt.up.inc.same': '[앞서 보낸 그대로] (내용이 바뀌지 않아 다시 올리지 않음 — 이전에 받은 내용을 그대로 써 줘)',
  'prompt.up.inc.lines': ' ({n}줄)',
  'prompt.up.inc.gone': '[지워진 파일] (앞서 보냈지만 지금은 없음)',
  'prompt.up.inc.treeFiles': '첨부한 {names}에 프로젝트 구조와 파일 {n}개의 지금 내용이 있습니다.',
  'prompt.up.inc.treeChanged': '첨부한 {names}에 프로젝트 구조와 바뀐 파일 {n}개의 지금 내용이 있습니다.',
  'prompt.up.inc.treeOnly': '첨부한 {names}에 프로젝트 구조가 있습니다.',
  'prompt.up.inc.files': '첨부한 {names}에 파일 {n}개의 지금 내용이 있습니다.',
  'prompt.up.inc.changed': '첨부한 {names}에 바뀐 파일 {n}개의 지금 내용이 있습니다.',

  // ---------- 이어서 받기 (patch.js) ----------
  'prompt.cont.label': '파일: {path} (이어서)',
  'prompt.cont.after': '이 파일 다음에 주려던 다른 파일이 있었다면, 이 파일을 다 쓴 뒤 처음 답변 규칙 그대로("파일: 경로" + 코드 블록) 이어서 줘.',
  'prompt.cont.edit': [
    '직전 답의 "파일: {path}" 찾기/바꾸기가 출력 한도로 중간에 끊겼어. 끝까지 받은 찾기/바꾸기는 {done}개야.',
    '{next}번째부터 남은 찾기/바꾸기만, 앞에서와 같은 형식(<<<<<<< 찾기 / ======= / >>>>>>> 바꾸기)으로 "{label}" 줄 다음 코드 블록 하나에 줘.',
    '이미 받은 찾기/바꾸기는 다시 쓰지 말고, 다른 설명은 쓰지 마. 이번에도 다 못 쓰면 끝난 블록까지만 쓰고 멈춰 줘.',
  ].join('\n'),
  'prompt.cont.restart': '직전 답의 "파일: {path}" 코드가 출력 한도로 끊겼어. 그 파일의 전체 내용을 "{label}" 줄 다음 코드 블록 하나로 처음부터 다시 줘.',
  'prompt.cont.fullHead': '직전 답의 "파일: {path}" 코드가 출력 한도로 중간에 끊겼어. 아래 줄까지는 받았어:',
  'prompt.cont.fullTail': [
    '이 줄을 첫 줄로 한 번 더 그대로 쓰고, 그 다음 줄부터 파일 끝까지 나머지만 "{label}" 줄 다음 코드 블록 하나로 줘.',
    '앞부분은 다시 쓰지 말고, 다른 설명은 쓰지 마. 이번에도 다 못 쓰면 줄이 끝나는 곳에서 멈춰 줘.',
  ].join('\n'),
  // ---------- 기본 템플릿 (renderer/templates.js — {q} 자리에 입력창 글) ----------
  'prompt.tpl.summary': "다음 내용을 핵심만 간결하게 요약해 줘.\n\n{q}",
  'prompt.tpl.explain': "다음을 초보자도 이해할 수 있게 쉽게 설명해 줘. 비유나 예시를 들어 줘.\n\n{q}",
  'prompt.tpl.step': "{q}\n\n단계별로 차근차근 생각해서 답해 줘.",
  'prompt.tpl.proscons': "{q}\n\n장점과 단점을 표로 비교하고 최종 추천을 해 줘.",
  'prompt.tpl.factcheck': "다음 내용이 사실인지 확인해 줘. 틀린 부분이 있으면 근거와 함께 알려 줘.\n\n{q}",
  'prompt.tpl.to-en': "다음을 자연스러운 영어로 번역해 줘.\n\n{q}",
  'prompt.tpl.to-ko': "다음을 자연스러운 한국어로 번역해 줘.\n\n{q}",
  'prompt.tpl.code-review': "다음 코드를 리뷰해 줘. 버그, 보안, 성능, 가독성 순으로 지적하고, 수정한 코드는 diff가 아니라 파일마다 \"파일: 경로\" 한 줄을 쓰고 그 아래에 수정한 전체 내용을 코드 블록 하나로 보여 줘. 150줄보다 긴 파일은 전체 대신 바꿀 곳만 같은 코드 블록 안에 \"<<<<<<< 찾기 / (지금 코드 그대로) / ======= / (바꾼 코드) / >>>>>>> 바꾸기\"로 줘. 내용에 ``` 가 들어 있는 파일(.md 등)은 바깥 울타리를 ```` (백틱 4개)로 써 줘.\n\n{q}",
  'prompt.tpl.file-collect': "아래 요청대로 코드를 수정하거나 필요한 파일을 새로 만들어 줘.\n\n답변 형식 (꼭 지켜 줘):\n1. 맨 앞에 바뀌는 파일 목록을 [새 파일] / [수정] / [삭제]로 표시해서 적어 줘.\n2. 바꾸거나 새로 만든 파일마다 \"파일: 경로\" 한 줄을 쓰고, 바로 아래에 그 파일의 전체 내용을 코드 블록 하나로 줘. diff로 주지 마.\n3. 코드는 절대 생략하지 마. \"... 기존과 동일\" 같은 줄 없이, 그대로 붙여 넣으면 되는 전체 파일이어야 해.\n4. 한 파일은 길어도 코드 블록 하나로만 줘. 여러 블록으로 나누지 말고, 설명은 코드 블록 밖에 써 줘.\n5. .md · .txt처럼 내용 안에 ``` 가 들어 있는 파일은 바깥 울타리를 ```` (백틱 4개, 안쪽보다 길게)로 감싸서 블록이 중간에 끊기지 않게 해 줘.\n6. 지울 파일은 마지막에 \"DELETE_FILES: 경로1, 경로2\" 한 줄로 적어 줘.\n7. 경로를 모르면 프로젝트에서 자연스러운 경로를 정해서 적어 줘.\n\n요청:\n{q}",
});
