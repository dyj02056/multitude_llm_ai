'use strict';

// 로컬 데이터 암호화 (v0.22.1, Windows 앱): 기록 · 설정 · 라이브러리 · 프로젝트 상태(적용 기록의 원본 포함) ·
// 테스트 실행 복구 파일을 Electron safeStorage(Windows DPAPI — 이 Windows 계정에 묶인 열쇠)로 암호화해 저장한다.
//
// [쉽게 말하면]
//   - 파일 맨 앞에 "MLAENC1" 표시를 붙이고 나머지는 암호문입니다. 이 PC의 같은 Windows 계정에서만 풀 수 있습니다.
//   - 예전 평문 파일은 처음 읽을 때 그대로 읽고, 곧바로 암호화해 다시 씁니다 (평문 사본은 남기지 않음).
//   - 쓰기는 임시 파일에 쓴 뒤 이름을 바꿔서, 쓰는 도중 앱이 꺼져도 원래 파일이 깨지지 않게 합니다.
//   - 풀 수 없는 파일(다른 PC · 다른 Windows 계정에서 복사해 온 것 등)은 지우지 않고 "<이름>.unreadable-<시각>"으로 옮겨 둡니다.
//   - 암호화를 쓸 수 없는 환경이면(드묾) 예전처럼 평문으로 저장합니다.
// 막아 주는 것: 파일만 복사해 가는 것 · 다른 Windows 계정. 막지 못하는 것: 같은 계정에서 도는 악성 프로그램.
const path = require('path');

const MAGIC = Buffer.from('MLAENC1\n');

/** safeStorage: { isEncryptionAvailable, encryptString, decryptString }, fs: node fs */
function createSecureStore({ safeStorage, fs, now = () => Date.now() }) {
  const available = () => {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  };
  const isEncrypted = (buf) => buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);

  /** 글 → 저장할 바이트 (쓸 수 있으면 암호화) */
  function encode(text) {
    if (!available()) return Buffer.from(text, 'utf8');
    return Buffer.concat([MAGIC, safeStorage.encryptString(text)]);
  }

  /** 저장된 바이트 → 글. 암호문이면 풀고(못 풀면 오류), 아니면 평문 그대로 → { text, encrypted } */
  function decode(buf) {
    if (!isEncrypted(buf)) return { text: buf.toString('utf8'), encrypted: false };
    if (!available()) throw new Error('이 환경에서는 암호를 풀 수 없습니다');
    return { text: safeStorage.decryptString(buf.subarray(MAGIC.length)), encrypted: true };
  }

  function writeJson(file, data, { pretty = false } = {}) {
    const bytes = encode(JSON.stringify(data, null, pretty ? 2 : 0));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  }

  /** JSON 읽기. 파일이 없거나 깨졌으면 fallback. 평문이면 암호화해 다시 쓴다. 못 푸는 암호문은 옆으로 옮긴다. */
  function readJson(file, fallback = null) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return fallback;
    }
    let out;
    try {
      out = decode(buf);
    } catch {
      try {
        fs.renameSync(file, `${file}.unreadable-${now()}`);
      } catch {}
      return fallback;
    }
    let data;
    try {
      data = JSON.parse(out.text);
    } catch {
      return fallback;
    }
    if (!out.encrypted && available()) {
      try {
        writeJson(file, data); // 예전 평문 → 암호화 (v0.22.1로 올린 뒤 처음 읽을 때)
      } catch {}
    }
    return data;
  }

  // 프로젝트 상태처럼 비동기로 다루는 곳용 (같은 규칙)
  const readJsonAsync = async (file, fallback = null) => readJson(file, fallback);
  const writeJsonAsync = async (file, data, opts) => writeJson(file, data, opts);

  return { MAGIC, available, encode, decode, readJson, writeJson, readJsonAsync, writeJsonAsync, isEncrypted };
}

// Electron 안에서 쓰는 하나뿐인 저장소 (테스트는 createSecureStore에 가짜 safeStorage를 넣어 쓴다)
let shared = null;
function store() {
  if (!shared) shared = createSecureStore({ safeStorage: require('electron').safeStorage, fs: require('fs') });
  return shared;
}

module.exports = { createSecureStore, store, MAGIC };
