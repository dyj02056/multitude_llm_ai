'use strict';

// 원격 셀렉터 서명 키 만들기 (한 번만): npm run selectors:keygen
// - Ed25519 키 한 쌍을 만든다.
// - 개인 키(PKCS8 PEM)는 저장소 밖에 둔다. 기본: %USERPROFILE%\.multitude-llm\selectors-signing-key.pem
//   (다른 곳에 두려면 MLA_SIGNING_KEY=경로 또는 --out 경로). 이미 있으면 덮어쓰지 않고, 저장소 안이면 거절한다.
// - 공개 키(32바이트 base64)는 src/shared/remote-core.js의 SELECTORS_PUBLIC_KEY 빈 줄에 넣는다.
//
// [쉽게 말하면] 셀렉터 파일에 "주인이 만든 파일"이라는 도장을 찍을 도장(개인 키)과 확인용 본(공개 키)을 만듭니다.
// 도장은 이 PC에만 두고, 확인용 본만 앱에 넣습니다.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_FILE = path.join(REPO_ROOT, 'src', 'shared', 'remote-core.js');
const PLACEHOLDER = "  const SELECTORS_PUBLIC_KEY = '';";

const defaultKeyPath = () => path.join(os.homedir(), '.multitude-llm', 'selectors-signing-key.pem');

/** child가 dir 안(또는 dir 자체)인지. 윈도는 대소문자를 가리지 않는다. */
function isInside(child, dir) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(dir), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 개인 키 PEM에서 공개 키 32바이트를 base64로 */
function publicKeyB64(keyObject) {
  const pub = keyObject.type === 'private' ? crypto.createPublicKey(keyObject) : keyObject;
  const { x } = pub.export({ format: 'jwk' });
  return Buffer.from(x, 'base64url').toString('base64');
}

/** remote-core.js의 빈 공개 키 줄을 정확히 찾아 바꾼다. 줄이 없으면(이미 키가 있음 등) 오류. */
function embedPublicKey(file, keyB64) {
  if (Buffer.from(keyB64, 'base64').length !== 32) throw new Error('공개 키는 32바이트여야 합니다');
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => l.replace(/\r$/, '') === PLACEHOLDER);
  if (idx < 0) throw new Error(`${file}에 빈 공개 키 줄(${PLACEHOLDER.trim()})이 없습니다. 이미 키가 들어 있으면 그대로 두세요.`);
  const cr = lines[idx].endsWith('\r') ? '\r' : '';
  lines[idx] = `  const SELECTORS_PUBLIC_KEY = '${keyB64}';${cr}`;
  fs.writeFileSync(file, lines.join('\n'));
}

/** 공개 키 줄을 바꿀 수 있는지 미리 본다 (키 파일을 만든 뒤에 실패하지 않게) */
function canEmbed(file) {
  return fs.readFileSync(file, 'utf8').split('\n').some((l) => l.replace(/\r$/, '') === PLACEHOLDER);
}

/**
 * 키를 만들어 keyPath에 쓰고 공개 키를 coreFile에 넣는다. 돌려주는 값: { keyPath, publicKey }.
 * repoRoot 안의 경로이거나 이미 파일이 있으면 아무것도 쓰지 않고 오류.
 */
function generate({ keyPath = process.env.MLA_SIGNING_KEY || defaultKeyPath(), repoRoot = REPO_ROOT, coreFile = CORE_FILE } = {}) {
  keyPath = path.resolve(keyPath);
  if (isInside(keyPath, repoRoot)) throw new Error(`개인 키를 저장소 안(${keyPath})에 둘 수 없습니다. 저장소 밖 경로를 쓰세요.`);
  if (fs.existsSync(keyPath)) throw new Error(`이미 키가 있습니다: ${keyPath} (덮어쓰지 않습니다)`);
  if (!canEmbed(coreFile)) throw new Error(`${coreFile}에 빈 공개 키 줄이 없습니다. 이미 키가 들어 있으면 새로 만들 필요가 없습니다.`);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, pem, { flag: 'wx', mode: 0o600 }); // wx: 있으면 실패 (덮어쓰지 않음)
  const publicKey = publicKeyB64(privateKey);
  embedPublicKey(coreFile, publicKey);
  return { keyPath, publicKey };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  try {
    const out = argValue('--out');
    const { keyPath, publicKey } = generate(out ? { keyPath: out } : {});
    console.log(`개인 키를 만들었습니다: ${keyPath}`);
    console.log(`공개 키 (base64): ${publicKey}`);
    console.log(`공개 키를 ${path.relative(REPO_ROOT, CORE_FILE)}의 SELECTORS_PUBLIC_KEY에 넣었습니다.`);
    console.log('');
    console.log('다음 순서:');
    console.log('  1. 개인 키 파일을 안전한 곳(비밀번호 관리자, 암호화한 USB 등)에 백업하세요. 잃어버리면 셀렉터를 더 못 바꿉니다.');
    console.log('     저장소에 올리거나 다른 사람에게 보내지 마세요.');
    console.log('  2. npm run selectors:sign  → remote/selectors.json.sig 만들기');
    console.log('  3. remote/selectors.json.sig를 커밋해 main에 먼저 푸시하세요.');
    console.log('  4. 그다음에 공개 키가 들어간 remote-core.js로 앱 · 확장 새 버전을 배포하세요.');
    console.log('     (.sig 없이 배포하면 새 버전은 원격 셀렉터를 받지 못하고 내장 값을 씁니다)');
  } catch (err) {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { generate, embedPublicKey, isInside, publicKeyB64, defaultKeyPath, PLACEHOLDER };
