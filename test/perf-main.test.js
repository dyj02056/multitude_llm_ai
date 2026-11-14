'use strict';
// 메인 프로세스 성능 손질 (v0.23) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 폴더 목록: 파일 크기를 여러 개 함께 알아봐도 결과(이름 · 종류 · 크기 · 순서)는 예전과 같은지
//   - 저장 모으기: 연달아 저장해도 파일은 한 번만 쓰고, flush는 바로(동기로) 쓰고, 옛 내용이 새 내용을 덮지 않는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createSecureStore } = require('../src/main/secure-store');
const { createSecureSaver } = require('../src/main/history');

function requireProject() {
  const electron = { dialog: {}, app: { getPath: () => os.tmpdir() } };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/main/project')];
    return require('../src/main/project');
  } finally {
    Module._load = orig;
  }
}

const tmpDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------- 폴더 목록 ----------

test('폴더 목록: 파일 500개 + 폴더가 있어도 예전(하나씩 stat)과 같은 결과 · 순서', async (t) => {
  const dir = tmpDir(t, 'mla-readdir-');
  for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x'.repeat(i));
  for (const d of ['src', 'docs', 'zz']) fs.mkdirSync(path.join(dir, d));
  // 예전 방식 그대로 만든 기대값
  const expected = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isSymbolicLink()) expected.push({ name: d.name, kind: 'link', size: 0 });
    else if (d.isDirectory()) expected.push({ name: d.name, kind: 'dir', size: 0 });
    else if (d.isFile()) expected.push({ name: d.name, kind: 'file', size: fs.statSync(path.join(dir, d.name)).size });
  }
  const project = requireProject();
  await project.open(dir);
  t.after(() => project.close());
  const got = await project.readDir('');
  assert.equal(got.length, 503);
  assert.deepEqual(got, expected);
  assert.equal(got.find((e) => e.name === 'f499.txt').size, 499);
  // 안쪽 폴더 · 바깥으로 나가는 경로 검사도 그대로
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'abc');
  assert.deepEqual(await project.readDir('src'), [{ name: 'a.js', kind: 'file', size: 3 }]);
  await assert.rejects(project.readDir('../'));
});

// ---------- 저장 모으기 ----------

// 가짜 암호화(앞뒤를 뒤집기만) + 쓰기 횟수를 세는 fs
function setup(t, { writeDelay = 0 } = {}) {
  const dir = tmpDir(t, 'mla-saver-');
  const file = path.join(dir, 'sub', 'prefs.json');
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...s].reverse().join(''), 'utf8'),
    decryptString: (b) => [...b.toString('utf8')].reverse().join(''),
  };
  const sec = createSecureStore({ safeStorage, fs });
  const counts = { async: 0, sync: 0 };
  const fsMod = {
    ...fs,
    promises: {
      ...fs.promises,
      writeFile: async (...a) => {
        counts.async++;
        if (writeDelay) await new Promise((r) => setTimeout(r, writeDelay));
        return fs.promises.writeFile(...a);
      },
    },
  };
  const origWrite = sec.writeJson;
  sec.writeJson = (...a) => {
    counts.sync++;
    return origWrite(...a);
  };
  const errors = [];
  const saver = createSecureSaver({ file: () => file, sec: () => sec, fsMod, delay: 30, onError: (e) => errors.push(e) });
  const read = () => sec.readJson(file, null);
  return { dir, file, sec, saver, counts, errors, read };
}

test('저장 모으기: 연달아 100번 저장해도 파일은 한 번만 쓰고, 마지막 내용이 암호화돼 들어간다', async (t) => {
  const { file, saver, counts, errors, read } = setup(t);
  const prefs = { n: 0 };
  for (let i = 1; i <= 100; i++) {
    prefs.n = i; // main.js처럼 같은 객체를 고쳐 가며 저장
    saver.save(prefs);
  }
  assert.equal(counts.async, 0); // 아직 기다리는 중
  assert.equal(fs.existsSync(file), false);
  await new Promise((r) => setTimeout(r, 80));
  await saver.idle();
  assert.equal(counts.async, 1);
  assert.equal(counts.sync, 0);
  assert.deepEqual(read(), { n: 100 });
  assert.ok(fs.readFileSync(file).subarray(0, 8).toString() === 'MLAENC1\n'); // 평문이 아니다
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prefs.json']); // 임시 파일이 남지 않는다
  assert.deepEqual(errors, []);
});

test('저장 모으기: flush는 기다리지 않고 바로(동기로) 쓰고, 타이머가 다시 쓰지 않는다', async (t) => {
  const { saver, counts, read } = setup(t);
  assert.equal(saver.flush(), false); // 저장할 것 없음
  saver.save({ a: 1 });
  saver.save({ a: 2 });
  assert.equal(saver.flush(), true);
  assert.deepEqual(read(), { a: 2 }); // 바로 들어가 있다
  assert.equal(counts.sync, 1);
  await new Promise((r) => setTimeout(r, 80));
  await saver.idle();
  assert.equal(counts.async, 0);
  assert.equal(saver.flush(), false);
});

test('저장 모으기: 쓰는 중에 flush하면 늦게 끝난 옛 쓰기가 새 내용을 덮지 않는다', async (t) => {
  const { file, saver, counts, read } = setup(t, { writeDelay: 50 });
  saver.save({ v: 'old' });
  const inFlight = saver.idle(); // 옛 내용 비동기 쓰기 시작 (50ms 걸림)
  await new Promise((r) => setTimeout(r, 10));
  saver.save({ v: 'new' });
  saver.flush(); // 앱 끄기: 새 내용을 동기로
  assert.deepEqual(read(), { v: 'new' });
  await inFlight;
  assert.deepEqual(read(), { v: 'new' }); // 옛 쓰기는 이름 바꾸기를 하지 않았다
  assert.equal(counts.async, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prefs.json']);
});

test('저장 모으기: 쓰기는 한 줄로 세워 마지막 저장이 마지막에 들어간다', async (t) => {
  const { saver, read } = setup(t, { writeDelay: 20 });
  saver.save({ v: 1 });
  const a = saver.idle();
  saver.save({ v: 2 });
  const b = saver.idle();
  await Promise.all([a, b]);
  assert.deepEqual(read(), { v: 2 });
  assert.deepEqual(saver.current(), { v: 2 });
});
