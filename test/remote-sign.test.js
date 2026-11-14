'use strict';

// 원격 셀렉터 서명 (Ed25519): 확인 규칙 · node/WebCrypto 확인 · 서명 스크립트 · 키 만들기 스크립트 · 본체 적용
// 키는 모두 이 시험에서 만든 일회용 키다. 진짜 홈 폴더 · 진짜 remote-core.js는 건드리지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const core = require('../src/shared/remote-core');
const { signFile, committedBytes } = require('../scripts/sign-selectors');
const keygen = require('../scripts/selectors-keygen');

const REPO = path.resolve(__dirname, '..');

function throwaway() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  return { privateKey, pub };
}
const sign = (bytes, privateKey) => crypto.sign(null, bytes, privateKey).toString('base64');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mla-sign-'));

const BYTES = Buffer.from('{"version":3,"services":{"chatgpt":{"input":["#remote"]}}}\n');
const nodeV = core.nodeVerifier(crypto);

test('공개 키가 비어 있으면 확인하지 않음 (예전 동작)', () => {
  assert.deepEqual(core.verify(BYTES, '', nodeV, ''), { ok: true, unsigned: true });
  assert.deepEqual(core.verify(BYTES, 'garbage', nodeV, ''), { ok: true, unsigned: true });
  assert.equal(core.SIG_URL, `${core.DEFAULT_URL}.sig`);
});

test('앱에 든 공개 키로 저장소의 selectors.json과 .sig가 맞는다 (selectors.json을 고치고 다시 서명하지 않으면 여기서 실패)', () => {
  assert.equal(Buffer.from(core.SELECTORS_PUBLIC_KEY, 'base64').length, 32); // Ed25519 공개 키 32바이트
  // Windows 체크아웃은 CRLF일 수 있다 → GitHub에 올라간 LF 모습으로 바꿔 확인
  const bytes = committedBytes(fs.readFileSync(path.join(REPO, 'remote', 'selectors.json')), true);
  const sig = fs.readFileSync(path.join(REPO, 'remote', 'selectors.json.sig'), 'utf8');
  assert.deepEqual(core.verify(bytes, sig, nodeV), { ok: true });
});

test('맞는 서명 → 통과, 바뀐 바이트 · 다른 키 · 서명 없음 · 깨진 서명 → 실패', () => {
  const a = throwaway();
  const b = throwaway();
  const sig = sign(BYTES, a.privateKey);
  assert.deepEqual(core.verify(BYTES, sig, nodeV, a.pub), { ok: true });
  assert.deepEqual(core.verify(BYTES, `${sig}\n`, nodeV, a.pub), { ok: true }); // .sig 파일 끝 줄바꿈
  const tampered = Buffer.from(BYTES);
  tampered[tampered.length - 3] ^= 1;
  for (const r of [
    core.verify(tampered, sig, nodeV, a.pub),
    core.verify(BYTES, sig, nodeV, b.pub),
    core.verify(BYTES, '', nodeV, a.pub),
    core.verify(BYTES, 'AAAA', nodeV, a.pub),
    core.verify(BYTES, sig, nodeV, 'not-a-key'),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.error, '서명이 맞지 않습니다');
  }
});

test('WebCrypto(subtle) 확인도 같은 결과, 지원하지 않으면 실패', async () => {
  const a = throwaway();
  const sig = sign(BYTES, a.privateKey);
  const subV = core.subtleVerifier(crypto.webcrypto.subtle);
  assert.deepEqual(await core.verify(new Uint8Array(BYTES), sig, subV, a.pub), { ok: true });
  const bad = Buffer.from(BYTES);
  bad[0] = 0x20;
  assert.equal((await core.verify(bad, sig, subV, a.pub)).ok, false);
  const unsupported = core.subtleVerifier({
    importKey: async () => {
      throw new Error('Algorithm: Unrecognized name');
    },
  });
  const r = await core.verify(BYTES, sig, unsupported, a.pub);
  assert.equal(r.ok, false);
  assert.match(r.detail, /Unrecognized/);
});

test('캐시: 바이트 · 서명을 그대로 담고, 서명 없는 예전 캐시는 키가 있으면 버림', () => {
  const packed = core.packCache(BYTES, 'c2ln\n');
  assert.equal(packed.format, 2);
  assert.equal(packed.sig, 'c2ln');
  const back = core.unpackCache(JSON.parse(JSON.stringify(packed)), 'KEY');
  assert.deepEqual(Buffer.from(back.bytes), BYTES);
  const old = { version: 1, services: {} };
  assert.equal(core.unpackCache(old, 'KEY'), null);
  assert.deepEqual(core.parseBytes(core.unpackCache(old, '').bytes), old);
  assert.equal(core.unpackCache(null, ''), null);
  assert.deepEqual(core.parseBytes(BYTES).version, 3);
});

test('서명 스크립트: 만든 서명이 확인을 통과, 짝이 아닌 키 · CRLF는 거절', () => {
  const dir = tmpDir();
  const a = throwaway();
  const keyPath = path.join(dir, 'key.pem');
  fs.writeFileSync(keyPath, a.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const jsonPath = path.join(dir, 'selectors.json');
  fs.writeFileSync(jsonPath, BYTES);
  const sig = signFile({ jsonPath, keyPath, publicKey: a.pub, convertsCrlf: false });
  const onDisk = fs.readFileSync(`${jsonPath}.sig`, 'utf8');
  assert.equal(onDisk, `${sig}\n`);
  assert.equal(onDisk.trim().split('\n').length, 1);
  assert.deepEqual(core.verify(fs.readFileSync(jsonPath), onDisk, nodeV, a.pub), { ok: true });

  assert.throws(() => signFile({ jsonPath, keyPath, publicKey: throwaway().pub, convertsCrlf: false }), /짝이 아닙니다/);
  assert.throws(() => signFile({ jsonPath, keyPath: path.join(dir, 'none.pem'), publicKey: '' }), /개인 키가 없습니다/);

  fs.writeFileSync(jsonPath, BYTES.toString().replace(/\n/g, '\r\n'));
  assert.throws(() => signFile({ jsonPath, keyPath, publicKey: a.pub, convertsCrlf: false }), /CRLF/);
  // autocrlf면 커밋될 LF 내용에 서명한다
  const sig2 = signFile({ jsonPath, keyPath, publicKey: a.pub, convertsCrlf: true });
  assert.deepEqual(core.verify(BYTES, sig2, nodeV, a.pub), { ok: true });
  assert.deepEqual(committedBytes(Buffer.from('a\r\nb'), true), Buffer.from('a\nb'));
});

test('키 만들기: 저장소 안 · 이미 있는 키는 거절, 공개 키 줄을 정확히 바꿈 (임시 복사본)', () => {
  const dir = tmpDir();
  const coreFile = path.join(dir, 'remote-core.js');
  // 저장소의 remote-core.js에는 이미 진짜 공개 키가 들어 있다 (v0.23.1) → 키를 넣기 전 모습(빈 자리)으로 되돌린 복사본으로 시험
  const original = fs
    .readFileSync(path.join(REPO, 'src', 'shared', 'remote-core.js'), 'utf8')
    .replace(/^  const SELECTORS_PUBLIC_KEY = '[^']*';$/m, "  const SELECTORS_PUBLIC_KEY = '';");
  fs.writeFileSync(coreFile, original);

  assert.throws(() => keygen.generate({ keyPath: path.join(REPO, 'remote', 'k.pem'), coreFile }), /저장소 안/);
  assert.equal(fs.existsSync(path.join(REPO, 'remote', 'k.pem')), false);

  const keyPath = path.join(dir, 'nested', 'signing.pem');
  const { publicKey } = keygen.generate({ keyPath, coreFile });
  assert.equal(Buffer.from(publicKey, 'base64').length, 32);
  const edited = fs.readFileSync(coreFile, 'utf8');
  assert.ok(edited.includes(`  const SELECTORS_PUBLIC_KEY = '${publicKey}';`));
  assert.ok(!edited.includes(keygen.PLACEHOLDER));
  assert.equal(edited.split('\n').length, original.split('\n').length); // 한 줄만 바뀜

  // 만든 키로 서명 → 넣은 공개 키로 확인
  const sig = sign(BYTES, crypto.createPrivateKey(fs.readFileSync(keyPath)));
  assert.deepEqual(core.verify(BYTES, sig, nodeV, publicKey), { ok: true });

  // 다시 실행: 키 파일이 있으면 거절 (덮어쓰지 않음), 다른 경로여도 이미 키가 들어 있으면 거절
  const before = fs.readFileSync(keyPath, 'utf8');
  fs.writeFileSync(coreFile, original);
  assert.throws(() => keygen.generate({ keyPath, coreFile }), /이미 키가 있습니다/);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), before);
  fs.writeFileSync(coreFile, edited);
  assert.throws(() => keygen.generate({ keyPath: path.join(dir, 'other.pem'), coreFile }), /빈 공개 키 줄/);
  assert.equal(fs.existsSync(path.join(dir, 'other.pem')), false);
  assert.throws(() => keygen.embedPublicKey(coreFile, 'AAAA'), /32바이트/);

  assert.equal(keygen.isInside(path.join(REPO, 'a', 'b'), REPO), true);
  assert.equal(keygen.isInside(path.join(REPO, '..', 'elsewhere'), REPO), false);
  assert.ok(!keygen.isInside(keygen.defaultKeyPath(), REPO));
});

// ---------- 본체(remote.js): 공개 키가 들어 있는 상황을 흉내 낸다 ----------

function loadRemote(pub) {
  const fakeCore = {
    ...core,
    SELECTORS_PUBLIC_KEY: pub,
    verify: (b, s, v, k = pub) => core.verify(b, s, v, k),
    unpackCache: (c, k = pub) => core.unpackCache(c, k),
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { net: { fetch: () => Promise.reject(new Error('no net')) } };
    if (req === '../shared/remote-core') return fakeCore;
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/main/remote')];
    return require('../src/main/remote');
  } finally {
    Module._load = orig;
    delete require.cache[require.resolve('../src/main/remote')];
  }
}

const services = () => [{ id: 'chatgpt', hosts: ['chatgpt.com'], input: ['#builtin'], stop: [], response: [] }];

test('본체: 서명이 맞으면 적용 · 캐시, 틀리면 적용 안 함 · 캐시 유지 · 오류 표시, 시작 때 다시 확인', async () => {
  const a = throwaway();
  const dir = tmpDir();
  const userData = path.join(dir, 'user');
  fs.mkdirSync(userData);
  const jsonPath = path.join(dir, 'selectors.json');
  fs.writeFileSync(jsonPath, BYTES);
  fs.writeFileSync(`${jsonPath}.sig`, `${sign(BYTES, a.privateKey)}\n`);

  let remote = loadRemote(a.pub);
  let svc = services();
  remote.init(userData, svc, { remoteUrl: jsonPath });
  let st = await remote.refresh();
  assert.equal(st.source, 'remote');
  assert.equal(st.error, undefined);
  assert.deepEqual(svc[0].input, ['#remote', '#builtin']);
  const cacheFile = path.join(userData, 'remote-selectors.json');
  const goodCache = fs.readFileSync(cacheFile, 'utf8');
  assert.equal(JSON.parse(goodCache).format, 2);

  // 저장소가 털려 셀렉터만 바뀜 (서명은 예전 것)
  fs.writeFileSync(jsonPath, Buffer.from(BYTES.toString().replace('#remote', '#evil')));
  st = await remote.refresh();
  assert.equal(st.error, '서명 확인 실패');
  assert.equal(st.source, 'remote');
  assert.deepEqual(svc[0].input, ['#remote', '#builtin']);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), goodCache);

  // 다시 켤 때: 받아 둔 바이트 · 서명을 확인하고 적용
  remote = loadRemote(a.pub);
  svc = services();
  remote.init(userData, svc, { remoteUrl: jsonPath });
  assert.equal(remote.getStatus().source, 'cache');
  assert.deepEqual(svc[0].input, ['#remote', '#builtin']);

  // 다른 키의 앱이면 캐시도 받지 않는다
  remote = loadRemote(throwaway().pub);
  svc = services();
  remote.init(userData, svc, { remoteUrl: jsonPath });
  assert.equal(remote.getStatus().source, 'builtin');
  assert.deepEqual(svc[0].input, ['#builtin']);

  // 서명 없는 예전 캐시 → 버리고 내장 값
  fs.writeFileSync(cacheFile, BYTES);
  remote = loadRemote(a.pub);
  svc = services();
  remote.init(userData, svc, { remoteUrl: jsonPath });
  assert.equal(remote.getStatus().source, 'builtin');
  assert.deepEqual(svc[0].input, ['#builtin']);
});

test('본체: 공개 키가 없으면 .sig 없이 예전처럼 받고 예전 캐시도 씀', async () => {
  const dir = tmpDir();
  const jsonPath = path.join(dir, 'selectors.json'); // .sig 파일 없음
  fs.writeFileSync(jsonPath, BYTES);
  fs.writeFileSync(path.join(dir, 'remote-selectors.json'), BYTES); // 예전 모양 캐시
  const remote = loadRemote('');
  const svc = services();
  remote.init(dir, svc, { remoteUrl: jsonPath });
  assert.equal(remote.getStatus().source, 'cache');
  const st = await remote.refresh();
  assert.equal(st.source, 'remote');
  assert.equal(st.error, undefined);
});
