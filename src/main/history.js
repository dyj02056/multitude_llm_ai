'use strict';

// 질문·답변 기록을 사용자 데이터 폴더의 history.json 한 파일에 저장한다.
// 기록 다루는 부분은 크롬 확장 프로그램과 같이 쓰는 shared/history-core.js에 있다.

const fs = require('fs');
const path = require('path');
const { createHistory } = require('../shared/history-core');

let file = null;
const history = createHistory((records) => {
  try {
    fs.writeFileSync(file, JSON.stringify(records));
  } catch {}
});

function init(userDataDir) {
  file = path.join(userDataDir, 'history.json');
  try {
    history.load(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    history.load([]);
  }
}

module.exports = { init, ...history };
