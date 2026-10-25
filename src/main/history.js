'use strict';

// 질문·답변 기록을 사용자 데이터 폴더의 history.json 한 파일에 저장한다.
// 기록 다루는 부분은 크롬 확장 프로그램과 같이 쓰는 shared/history-core.js에 있다.

// [쉽게 말하면] 보낸 질문과 받은 답변을 이 PC의 파일(history.json)에 적어 두는 "일기장" 담당입니다.
// 실제 기록 정리(추가·검색·삭제)는 공통 부품(history-core.js)이 하고, 이 파일은 "파일에 저장하고 읽는 일"만 합니다.

const fs = require('fs');
const path = require('path');
const { createHistory } = require('../shared/history-core');

let file = null;
const history = createHistory((records) => {
  try {
    fs.writeFileSync(file, JSON.stringify(records));
  } catch {}
});

/** 앱을 켤 때: 저장된 기록 파일을 읽어 옵니다. 파일이 없거나 깨졌으면 빈 기록으로 시작합니다. */
function init(userDataDir) {
  file = path.join(userDataDir, 'history.json');
  try {
    history.load(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    history.load([]);
  }
}

module.exports = { init, ...history };
