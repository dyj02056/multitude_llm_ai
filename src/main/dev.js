'use strict';

// 개발용 옵션. 모두 환경 변수로 켜며, 일반 실행(npm start)에서는 아무것도 바뀌지 않는다.
//
//   MLA_DEBUG=1        이동·자동 로그인·전송·답변 감지 로그를 터미널에 출력
//   MLA_START=pick|chat 로그인 확인을 건너뛰고 모델 선택 / 채팅 화면으로 바로 시작
//   MLA_PROFILE=<폴더> 다른 프로필(로그인 정보·설정) 폴더로 실행 — 실행 중인 앱과 따로 띄울 때
//   MLA_DRY_SEND=1     질문 입력과 보내기 버튼 찾기까지만 하고 실제로 보내지 않음
//
// 패널 페이지를 바깥에서 살펴보려면 Chromium 옵션을 같이 넘긴다:
//   npm start -- --remote-debugging-port=9333

const env = process.env;

const dev = {
  debug: env.MLA_DEBUG === '1',
  start: ['pick', 'chat'].includes(env.MLA_START) ? env.MLA_START : null,
  profile: env.MLA_PROFILE || null,
  drySend: env.MLA_DRY_SEND === '1',
};

/** MLA_DEBUG=1 일 때만 출력한다. tag 예: 'nav', 'autologin', 'send', 'answer' */
function log(tag, ...args) {
  if (dev.debug) console.log(`[${tag}]`, ...args);
}

module.exports = { dev, log };
