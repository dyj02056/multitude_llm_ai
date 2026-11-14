'use strict';

// 질문·답변 기록을 사용자 데이터 폴더의 history.json 한 파일에 저장한다.
// 기록 다루는 부분은 크롬 확장 프로그램과 같이 쓰는 shared/history-core.js에 있다.

// [쉽게 말하면] 보낸 질문과 받은 답변을 이 PC의 파일(history.json)에 적어 두는 "일기장" 담당입니다.
// 실제 기록 정리(추가·검색·삭제)는 공통 부품(history-core.js)이 하고, 이 파일은 "파일에 저장하고 읽는 일"만 합니다.
// 설정(prefs) · 라이브러리 저장도 여기의 createSecureSaver를 같이 쓴다 (main.js).

const fs = require('fs');
const path = require('path');
const { createHistory } = require('../shared/history-core');
const { store } = require('./secure-store'); // 암호화해 저장 (v0.22.1)

/**
 * 암호화 저장을 잠깐 모았다가(기본 0.3초) 비동기로 쓴다 (v0.23 성능).
 * [쉽게 말하면] 설정을 연달아 바꿔도 파일은 마지막 한 번만 쓰고, 쓰는 동안 화면이 멈추지 않게 합니다.
 *   - 쓰기는 한 줄로 세운다: 앞의 쓰기가 끝나야 다음 쓰기를 시작한다.
 *   - 오래된 내용이 새 내용을 덮지 않는다: 임시 파일까지는 비동기로 쓰고, 마지막 이름 바꾸기는 동기로 하되
 *     그사이 더 새 내용(앱 끄기 flush 포함)이 이미 들어갔으면 이름을 바꾸지 않고 임시 파일을 지운다.
 *   - flush(): 기다리는 저장이 있으면 지금 동기로 쓴다 (앱을 끌 때).
 * file: () => 경로, sec: () => secure-store, writeSync(data): flush 때 쓰는 동기 암호화 쓰기,
 * delay: 모으는 시간(ms), onError: 실패를 알릴 곳
 */
function createSecureSaver({ file, sec = store, writeSync, fsMod = fs, delay = 300, onError = () => {} }) {
  const syncWrite = writeSync || ((data) => sec().writeJson(file(), data));
  let latest; // 마지막으로 받은 내용
  let gen = 0; // 받은 내용 번호 (save마다 1씩)
  let committed = 0; // 파일에 들어간 내용 번호
  let timer = null;
  let chain = Promise.resolve();
  let seq = 0;

  async function writeAsync(target, bytes, myGen) {
    await fsMod.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-a${++seq}`;
    try {
      await fsMod.promises.writeFile(tmp, bytes);
      if (myGen <= committed) {
        await fsMod.promises.unlink(tmp).catch(() => {}); // 그사이 더 새 내용(flush 등)이 들어갔다
        return;
      }
      fsMod.renameSync(tmp, target); // 확인과 이름 바꾸기 사이에 다른 쓰기가 끼지 않게 동기로
      committed = myGen;
    } catch (err) {
      await fsMod.promises.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  function fire() {
    timer = null;
    const myGen = gen;
    let target, bytes;
    try {
      // 지금 모습으로 바로 만든다 (prefs · 기록은 같은 객체를 계속 고치므로 나중에 읽으면 내용이 달라진다)
      target = file();
      bytes = sec().encode(JSON.stringify(latest));
    } catch (err) {
      onError(err);
      return chain;
    }
    chain = chain.then(() => (myGen > committed ? writeAsync(target, bytes, myGen) : null)).catch(onError);
    return chain;
  }

  /** 저장을 예약한다 (delay 안에 또 부르면 마지막 것만 쓴다) */
  function save(data) {
    latest = data;
    gen++;
    clearTimeout(timer);
    timer = setTimeout(fire, delay);
  }

  /** 기다리는(또는 쓰는 중인) 저장이 있으면 지금 동기로 쓴다 */
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (gen <= committed) return false;
    try {
      syncWrite(latest);
      committed = gen;
    } catch (err) {
      onError(err);
    }
    return true;
  }

  /** 예약 · 진행 중인 쓰기가 모두 끝날 때까지 기다린다 (테스트용) */
  const idle = () => (timer ? fire() : chain);

  /** 아직 파일에 안 들어갔을 수도 있는 마지막 내용 (없으면 undefined) */
  const current = () => latest;

  return { save, flush, idle, current };
}

let file = null;
// 기록은 history-core가 이미 0.5초 모아서 부르므로 여기서는 더 기다리지 않고 비동기로만 쓴다
const saver = createSecureSaver({ file: () => file, writeSync: (records) => store().writeJson(file, records), delay: 0 });
const history = createHistory((records) => saver.save(records));

/** 앱을 켤 때: 저장된 기록 파일을 읽어 옵니다. 파일이 없거나 깨졌으면 빈 기록으로 시작합니다. */
function init(userDataDir) {
  file = path.join(userDataDir, 'history.json');
  const data = store().readJson(file, []);
  history.load(Array.isArray(data) ? data : []);
}

// flush(): 미뤄 둔 저장을 바로 한다 (앱을 끌 때 main.js가 부른다). 끝에서는 동기 쓰기라 끄기 전에 끝난다.
function flush() {
  history.flush(); // history-core가 미뤄 둔 것 → saver로
  saver.flush(); // saver가 미뤄 둔 것 · 쓰는 중인 것 → 지금 동기로
}

module.exports = { init, ...history, flush, createSecureSaver };
