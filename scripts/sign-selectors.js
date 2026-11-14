'use strict';

// 원격 셀렉터 서명: npm run selectors:sign
// remote/selectors.json을 고칠 때마다 실행해서 remote/selectors.json.sig(base64 한 줄)를 만들고, 두 파일을 같이 커밋한다.
// 개인 키는 MLA_SIGNING_KEY=경로, 없으면 %USERPROFILE%\.multitude-llm\selectors-signing-key.pem.
//
// 서명은 파일 바이트 그대로에 대한 것이라 한 글자 · 줄바꿈만 달라도 맞지 않는다.
// 윈도의 core.autocrlf=true(또는 input)면 작업 폴더 파일이 CRLF여도 GitHub에는 LF로 올라간다.
// 그래서 그때는 CRLF를 LF로 바꾼 바이트(= 커밋될 내용)에 서명한다. autocrlf가 꺼져 있는데 CRLF면 거절한다.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('../src/shared/remote-core');
const { defaultKeyPath } = require('./selectors-keygen');

const REPO_ROOT = path.resolve(__dirname, '..');
const JSON_FILE = path.join(REPO_ROOT, 'remote', 'selectors.json');

/** 커밋할 때 CRLF가 LF로 바뀌는 설정인지 (core.autocrlf가 true 또는 input) */
function gitConvertsCrlf(cwd = REPO_ROOT) {
  try {
    const v = execFileSync('git', ['config', '--get', 'core.autocrlf'], { cwd, encoding: 'utf8' }).trim().toLowerCase();
    return v === 'true' || v === 'input';
  } catch {
    return false;
  }
}

/** 서명할 바이트: 커밋될 내용과 같게 만든다. CRLF를 LF로 바꿀 수 없으면 오류. */
function committedBytes(bytes, convertsCrlf) {
  if (!bytes.includes(0x0d)) return bytes;
  if (!convertsCrlf) throw new Error('selectors.json에 CRLF 줄바꿈이 있습니다. LF로 저장한 뒤 다시 서명하세요.');
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/**
 * jsonPath 파일을 keyPath 개인 키로 서명해서 sigPath에 쓴다. 돌려주는 값: 서명 base64.
 * publicKey가 있으면(앱에 들어 있는 키) 이 개인 키와 짝이 맞는지도 확인한다.
 */
function signFile({
  jsonPath = JSON_FILE,
  keyPath = process.env.MLA_SIGNING_KEY || defaultKeyPath(),
  sigPath = `${jsonPath}.sig`,
  publicKey = core.SELECTORS_PUBLIC_KEY,
  convertsCrlf = gitConvertsCrlf(),
} = {}) {
  if (!fs.existsSync(keyPath)) throw new Error(`개인 키가 없습니다: ${keyPath} (npm run selectors:keygen 또는 MLA_SIGNING_KEY)`);
  const bytes = committedBytes(fs.readFileSync(jsonPath), convertsCrlf);
  core.parseBytes(bytes); // JSON이 깨졌으면 여기서 오류
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const sig = crypto.sign(null, bytes, privateKey).toString('base64');
  if (publicKey && !core.verify(bytes, sig, core.nodeVerifier(crypto), publicKey).ok) {
    throw new Error('이 개인 키는 앱에 들어 있는 공개 키(SELECTORS_PUBLIC_KEY)와 짝이 아닙니다');
  }
  fs.writeFileSync(sigPath, `${sig}\n`);
  return sig;
}

if (require.main === module) {
  try {
    signFile();
    console.log(`서명했습니다: ${path.relative(REPO_ROOT, JSON_FILE)}.sig`);
    if (!core.SELECTORS_PUBLIC_KEY) console.log('참고: 앱에 아직 공개 키가 없어 서명을 확인하지 않습니다 (npm run selectors:keygen).');
    console.log('remote/selectors.json과 remote/selectors.json.sig를 같이 커밋하세요.');
  } catch (err) {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { signFile, committedBytes };
