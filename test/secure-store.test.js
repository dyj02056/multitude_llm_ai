'use strict';

// 로컬 데이터 암호화 (v0.22.1): 가짜 safeStorage(키로 XOR)로 저장 · 읽기 · 예전 평문 바꾸기 · 못 푸는 파일 · 암호화 없는 환경
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecureStore, MAGIC } = require('../src/main/secure-store');

function fakeSafe({ available = true, key = 7 } = {}) {
  const x = (buf) => Buffer.from(buf.map((b) => b ^ key));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => x(Buffer.from(s, 'utf8')),
    decryptString: (b) => {
      const out = x(b).toString('utf8');
      if (!out.startsWith('{') && !out.startsWith('[')) throw new Error('bad key'); // 다른 계정 열쇠로는 못 품
      return out;
    },
  };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mla-secure-'));

test('저장하면 암호문(MLAENC1 표시)이고, 평문 글이 파일에 없으며, 다시 읽으면 같다', () => {
  const dir = tmpDir();
  const s = createSecureStore({ safeStorage: fakeSafe(), fs });
  const file = path.join(dir, 'history.json');
  s.writeJson(file, [{ question: '비밀 질문', answers: { a: { text: '답' } } }]);
  const raw = fs.readFileSync(file);
  assert.ok(raw.subarray(0, MAGIC.length).equals(MAGIC));
  assert.ok(!raw.toString('utf8').includes('비밀 질문'));
  assert.deepEqual(s.readJson(file, []), [{ question: '비밀 질문', answers: { a: { text: '답' } } }]);
  assert.deepEqual(fs.readdirSync(dir), ['history.json']); // 임시 파일이 남지 않는다
});

test('예전 평문 파일은 그대로 읽고, 곧바로 암호화해 다시 쓴다 (평문 사본 없음)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'prefs.json');
  fs.writeFileSync(file, JSON.stringify({ layout: 'grid' }, null, 2));
  const s = createSecureStore({ safeStorage: fakeSafe(), fs });
  assert.deepEqual(s.readJson(file, null), { layout: 'grid' });
  assert.ok(s.isEncrypted(fs.readFileSync(file)));
  assert.deepEqual(s.readJson(file, null), { layout: 'grid' });
  assert.deepEqual(fs.readdirSync(dir), ['prefs.json']);
});

test('못 푸는 암호문(다른 계정 · 다른 PC)은 지우지 않고 옆으로 옮기고, 빈 값으로 시작한다', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'library.json');
  createSecureStore({ safeStorage: fakeSafe({ key: 7 }), fs }).writeJson(file, { skills: [] });
  const other = createSecureStore({ safeStorage: fakeSafe({ key: 99 }), fs, now: () => 1234 });
  assert.deepEqual(other.readJson(file, { empty: true }), { empty: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['library.json.unreadable-1234']);
});

test('깨진 평문 JSON은 옮기지 않고 기본값, 없는 파일도 기본값', () => {
  const dir = tmpDir();
  const s = createSecureStore({ safeStorage: fakeSafe(), fs });
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, '{ 깨짐');
  assert.equal(s.readJson(file, 'fb'), 'fb');
  assert.ok(fs.existsSync(file));
  assert.equal(s.readJson(path.join(dir, 'none.json'), 'fb'), 'fb');
});

test('암호화를 쓸 수 없는 환경이면 예전처럼 평문으로 저장 · 읽기', async () => {
  const dir = tmpDir();
  const s = createSecureStore({ safeStorage: fakeSafe({ available: false }), fs });
  const file = path.join(dir, 'projects', 'abc.json');
  await s.writeJsonAsync(file, { applied: [{ path: 'a.js', before: '원본' }] }); // 폴더도 만든다
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).applied[0].before, '원본');
  assert.deepEqual(await s.readJsonAsync(file, null), { applied: [{ path: 'a.js', before: '원본' }] });
  assert.equal(createSecureStore({ safeStorage: null, fs }).available(), false);
});

test('본체가 기록 · 설정 · 라이브러리 · 프로젝트 상태 · 테스트 복구 파일을 이 저장소로 쓴다', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
  assert.match(src('history.js'), /store\(\)\.writeJson\(file, records\)/);
  assert.match(src('main.js'), /secure\.store\(\)\.writeJson\(prefsFile\(\), prefs\)/);
  assert.match(src('main.js'), /secure\.store\(\)\.writeJson\(libraryFile\(\)/);
  assert.match(src('project.js'), /writeJsonAsync\(stateFile\(id\), data\)/);
  assert.match(src('devtest.js'), /store\(\)\.writeJson\(recoveryFile, data\)/);
  for (const f of ['history.js', 'main.js', 'project.js', 'devtest.js']) {
    assert.doesNotMatch(src(f), /writeFileSync\((prefsFile|libraryFile|file, JSON|recoveryFile)/, f);
  }
});
