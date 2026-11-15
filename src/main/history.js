'use strict';

// 질문·답변 기록을 사용자 데이터 폴더의 history/ 폴더에 저장한다 (v0.24.0):
//   history/index.json   색인 { v: 2, ids: [최근 것부터 기록 id] }
//   history/<id>.json    기록 하나 (질문 · 답변 · 종합)
// 답변 하나가 끝나면 그 기록 파일만 다시 쓴다 (예전에는 history.json 하나에 기록 전체를 매번 다시 썼다).
// 모든 파일은 secure-store로 암호화한다. 예전 history.json은 처음 켤 때 옮기고, 옮긴 것을 확인한 뒤 지운다
// (남겨 두면 기록을 지워도 옛 파일에 내용이 남기 때문).
// 기록 다루는 부분은 크롬 확장 프로그램과 같이 쓰는 shared/history-core.js에 있다.

// [쉽게 말하면] 보낸 질문과 받은 답변을 이 PC의 파일(history.json)에 적어 두는 "일기장" 담당입니다.
// 실제 기록 정리(추가·검색·삭제)는 공통 부품(history-core.js)이 하고, 이 파일은 "파일에 저장하고 읽는 일"만 합니다.
// 설정(prefs) · 라이브러리 저장도 여기의 createSecureSaver를 같이 쓴다 (main.js).

const fs = require('fs');
const path = require('path');
const { createHistory, planWrites, okRecordId, cleanLegacy } = require('../shared/history-core');
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

/**
 * 기록별 파일 저장소 (v0.24.0).
 * [쉽게 말하면] 기록 하나를 파일 하나로 둡니다. 바뀐 기록 파일과 목록(색인)만 다시 쓰고, 지운 기록은 파일도 지웁니다.
 * dir: () => history 폴더, sec: () => secure-store, fsMod: fs (테스트용)
 */
function createRecordStore({ dir, sec = store, fsMod = fs, onError = () => {} }) {
  const indexFile = () => path.join(dir(), 'index.json');
  const recFile = (id) => path.join(dir(), `${id}.json`);
  const savers = new Map(); // 기록 id -> createSecureSaver
  let known = new Set(); // 색인에 있는(또는 쓰는 중인) 기록 id
  const indexSaver = createSecureSaver({ file: indexFile, sec, fsMod, delay: 0, onError, writeSync: (d) => sec().writeJson(indexFile(), d) });

  function saverFor(id) {
    let s = savers.get(id);
    if (!s) {
      s = createSecureSaver({ file: () => recFile(id), sec, fsMod, delay: 0, onError, writeSync: (d) => sec().writeJson(recFile(id), d) });
      savers.set(id, s);
    }
    return s;
  }

  function dropRecord(id) {
    const s = savers.get(id);
    if (s) {
      s.flush(); // 쓰는 중인 비동기 쓰기가 나중에 파일을 되살리지 않게 먼저 끝내 둔다
      savers.delete(id);
    }
    try {
      fsMod.unlinkSync(recFile(id));
    } catch {}
  }

  /** 저장된 기록을 읽는다. 색인이 없으면 null. 색인에 없는 파일(지우다 꺼진 것 등)은 지운다 */
  function read() {
    const idx = sec().readJson(indexFile(), null);
    if (!idx || !Array.isArray(idx.ids)) return null;
    const records = [];
    for (const id of idx.ids) {
      if (!okRecordId(id)) continue;
      const rec = sec().readJson(recFile(id), null);
      if (rec && typeof rec === 'object' && rec.id === id) records.push(rec);
    }
    known = new Set(records.map((r) => r.id));
    let names = [];
    try {
      names = fsMod.readdirSync(dir());
    } catch {}
    for (const name of names) {
      const m = /^([A-Za-z0-9-]{1,40}).json$/.exec(name);
      if (m && m[1] !== 'index' && !known.has(m[1])) {
        try {
          fsMod.unlinkSync(path.join(dir(), name));
        } catch {}
      }
    }
    return records;
  }

  /** 기록 전체를 지금 바로(동기로) 쓴다 — 예전 파일을 옮길 때 */
  function writeAllSync(records) {
    for (const r of records) sec().writeJson(recFile(r.id), r);
    sec().writeJson(indexFile(), { v: 2, ids: records.map((r) => r.id) });
    known = new Set(records.map((r) => r.id));
  }

  /** history-core의 save(records, info) */
  function save(records, info) {
    const plan = planWrites(records, info, known);
    for (const r of plan.write) saverFor(r.id).save(r);
    for (const id of plan.remove) dropRecord(id);
    if (plan.index) {
      indexSaver.save({ v: 2, ids: plan.index });
      known = new Set(plan.index);
    }
  }

  function flush() {
    for (const s of savers.values()) s.flush();
    indexSaver.flush();
  }

  /** 예약 · 진행 중인 쓰기가 모두 끝날 때까지 (테스트용) */
  const idle = () => Promise.all([...[...savers.values()].map((s) => s.idle()), indexSaver.idle()]);

  return { read, writeAllSync, save, flush, idle };
}

/**
 * 예전 기록(배열)을 새 저장소에 옮길 수 있게 다듬는다: 객체가 아니면 버리고, id가 파일 이름으로 안전하지 않거나
 * 겹치면 새 id를 준다.
 */

/**
 * 기록 읽기 + 예전 history.json 옮기기.
 * → 기록 배열. 옮긴 뒤 다시 읽어 개수가 같을 때만 예전 파일을 지운다 (다르면 남겨 두고 다음에 다시 시도).
 */
function loadOrMigrate(recordStore, legacyFile, { sec = store, fsMod = fs } = {}) {
  const records = recordStore.read();
  if (records) return records;
  if (!fsMod.existsSync(legacyFile)) return [];
  const legacy = cleanLegacy(sec().readJson(legacyFile, []));
  recordStore.writeAllSync(legacy);
  const check = recordStore.read();
  if (check && check.length === legacy.length) {
    try {
      fsMod.unlinkSync(legacyFile);
    } catch {}
  }
  return check || legacy;
}

let userDir = null;
const records = createRecordStore({ dir: () => path.join(userDir, 'history') });
const history = createHistory((list, info) => records.save(list, info));

/** 앱을 켤 때: 저장된 기록을 읽어 옵니다. 없거나 깨졌으면 빈 기록으로 시작합니다. max: 설정의 최대 개수 */
function init(userDataDir, { max } = {}) {
  userDir = userDataDir;
  history.load(loadOrMigrate(records, path.join(userDataDir, 'history.json')));
  if (max) history.setMax(max);
}

// flush(): 미뤄 둔 저장을 바로 한다 (앱을 끌 때 main.js가 부른다). 끝에서는 동기 쓰기라 끄기 전에 끝난다.
function flush() {
  history.flush(); // history-core가 미뤄 둔 것 → 기록별 저장소로
  records.flush(); // 저장소가 미뤄 둔 것 · 쓰는 중인 것 → 지금 동기로
}

module.exports = { init, ...history, flush, createSecureSaver, createRecordStore, loadOrMigrate, cleanLegacy };
