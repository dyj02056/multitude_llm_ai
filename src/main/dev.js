'use strict';

// 개발용 옵션. 모두 환경 변수로 켜며, 일반 실행(npm start)에서는 아무것도 바뀌지 않는다.
//
//   MLA_DEBUG=1        이동·자동 로그인·전송·답변 감지 로그를 터미널에 출력
//   MLA_START=pick|chat 로그인 확인을 건너뛰고 모델 선택 / 채팅 화면으로 바로 시작
//   MLA_PROFILE=<폴더> 다른 프로필(로그인 정보·설정) 폴더로 실행 — 실행 중인 앱과 따로 띄울 때
//   MLA_DRY_SEND=1     질문 입력과 보내기 버튼 찾기까지만 하고 실제로 보내지 않음
//   MLA_REMOTE_URL=<주소 또는 파일 경로>
//                      사이트 셀렉터 원격 갱신을 GitHub 대신 이 주소/로컬 파일에서 받음
//   MLA_ANSWER_TIMEOUT_MS=<ms> / MLA_ANSWER_START_MS=<ms>
//                      답변 시간 초과 / 답변 시작 대기 시간을 설정값 대신 이 값으로 (시간 초과 동작 시험용)
//
// 패널 페이지를 바깥에서 살펴보려면 Chromium 옵션을 같이 넘긴다:
//   npm start -- --remote-debugging-port=9333

const env = process.env;

const dev = {
  debug: env.MLA_DEBUG === '1',
  start: ['pick', 'chat'].includes(env.MLA_START) ? env.MLA_START : null,
  profile: env.MLA_PROFILE || null,
  drySend: env.MLA_DRY_SEND === '1',
  answerTimeoutMs: Number(env.MLA_ANSWER_TIMEOUT_MS) || 0,
  answerStartMs: Number(env.MLA_ANSWER_START_MS) || 0,
  remoteUrl: env.MLA_REMOTE_URL || null,
};

/** MLA_DEBUG=1 일 때만 출력한다. tag 예: 'nav', 'autologin', 'send', 'answer' */
function log(tag, ...args) {
  if (dev.debug) console.log(`[${tag}]`, ...args);
}

module.exports = { dev, log };
