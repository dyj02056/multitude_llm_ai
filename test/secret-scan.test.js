// 비밀 정보 탐지(src/shared/secret-scan.js) 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const { PATTERNS, scanSecrets, describeSecrets } = require('../src/shared/secret-scan');
const { maskOutput } = require('../src/main/git-rules');

const names = (text) => scanSecrets(text).map((f) => f.name);
const rnd = (n, chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => {
  let s = '';
  for (let i = 0; i < n; i++) s += chars[(i * 7 + 3) % chars.length];
  return s;
};

// ---------- 새 규칙 ----------

test('Anthropic 키는 Anthropic으로만 보고한다 (sk- 규칙과 겹쳐 두 번 나오지 않음)', () => {
  assert.deepEqual(names(`const k = "sk-ant-api03-${rnd(40)}";`), ['Anthropic API 키']);
});

test('OpenAI 프로젝트 키는 OpenAI 프로젝트 키로만 보고한다', () => {
  assert.deepEqual(names(`OPENAI=sk-proj-${rnd(40)}`).filter((n) => n !== '환경 변수 비밀 대입'), ['OpenAI 프로젝트 키']);
  assert.deepEqual(names(`key: sk-proj-${rnd(40)}`), ['OpenAI 프로젝트 키']);
  // 예전 sk- 키는 그대로
  assert.deepEqual(names(`key: sk-${rnd(40)}`), ['API 키 (sk-)']);
});

test('npm 토큰', () => {
  assert.deepEqual(names(`//registry.npmjs.org/:_authToken=npm_${rnd(36)}`), ['npm 토큰']);
});

test('Azure 저장소 연결 문자열 (AccountKey=…)', () => {
  const cs = `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${rnd(86, 'ABCDEFabcdef0123456789+/')}==;EndpointSuffix=core.windows.net`;
  assert.deepEqual(names(cs), ['Azure 저장소 연결 문자열']);
});

test('Authorization: Bearer 토큰', () => {
  assert.deepEqual(names(`curl -H "Authorization: Bearer ${rnd(32)}" https://api.example.com`), ['Bearer 토큰']);
  assert.deepEqual(names(`headers: { Authorization: 'Bearer ${rnd(24)}' }`), ['Bearer 토큰']);
  // JWT면 JWT 규칙 하나만
  const jwt = `eyJ${rnd(20)}.eyJ${rnd(20)}.${rnd(20)}`;
  assert.deepEqual(names(`Authorization: Bearer ${jwt}`), ['JWT']);
});

test('환경 변수 비밀 대입: 이름 끝이 SECRET·TOKEN·PASSWORD·PASSWD·PASS·API_KEY·ACCESS_KEY·PRIVATE_KEY', () => {
  for (const key of ['GH_TOKEN', 'SMTP_PASS', 'MY_ACCESS_KEY', 'SIGNING_PRIVATE_KEY']) {
    assert.deepEqual(names(`${key}=Zq8v1Lm3Rt7w`), ['환경 변수 비밀 대입'], key);
  }
  // secret·passwd·api_key가 들어간 이름은 예전 규칙이 먼저 잡고, 같은 값이라 한 번만 보고
  for (const key of ['APP_SECRET', 'DB_PASSWD', 'OPENAI_API_KEY']) {
    assert.deepEqual(names(`${key}=Zq8v1Lm3Rt7w`), ['비밀번호·토큰 대입'], key);
  }
  assert.deepEqual(names('export STRIPE_TOKEN="Zq8v1Lm3Rt7w"'), ['환경 변수 비밀 대입']);
  assert.deepEqual(names('"SERVICE_TOKEN": "Zq8v1Lm3Rt7w"'), ['환경 변수 비밀 대입']);
  // password가 들어간 이름은 예전 규칙이 먼저 잡고, 같은 값이라 한 번만 보고
  assert.deepEqual(names('DB_PASSWORD=Zq8v1Lm3Rt7w'), ['비밀번호·토큰 대입']);
  // 소문자 이름·이름 중간에 끼인 경우는 아님
  assert.equal(names('bypass=Zq8v1Lm3Rt7w').length, 0);
  assert.equal(names('TOKEN_URL=https://auth.example.org/token').length, 0);
});

// ---------- 오탐 줄이기 ----------

test('예시·자리표시 값은 보고하지 않는다', () => {
  const samples = [
    'API_KEY=xxxxxxxxxxxx',
    'API_KEY=************',
    'API_KEY=<your-api-key>',
    'API_KEY=${API_KEY}',
    'API_KEY=$API_KEY_FROM_CI',
    'API_KEY={{ api_key }}',
    'APP_SECRET=changeme123',
    'APP_SECRET=your_secret_here',
    'APP_SECRET=example-secret-value',
    'APP_SECRET=dummy-secret-value',
    'APP_SECRET=test-secret-value',
    'APP_SECRET=placeholder',
    'APP_SECRET=',
    'APP_SECRET=""',
    'GH_TOKEN=process.env.GH_TOKEN',
    'GH_TOKEN = os.environ["GH_TOKEN"]',
    'GH_TOKEN = os.getenv("GH_TOKEN")',
    'const API_KEY = getApiKey();',
    'password = "your-password"',
    'password: "examplepassword"',
    'secret = "dummydummy"',
    'password = process.env.PASSWORD',
    'Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxx',
    'Authorization: Bearer <access-token-goes-here>',
    'Authorization: Bearer ${token}',
  ];
  for (const s of samples) assert.deepEqual(scanSecrets(s), [], s);
});

test('기존 구체적 규칙은 그대로 (자리표시 걸러내기는 일반 규칙에만)', () => {
  assert.equal(scanSecrets('key = "AKIAABCDEFGHIJKLMNOP"')[0].name, 'AWS 액세스 키');
  assert.equal(scanSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')[0].name, '개인 키');
  assert.equal(scanSecrets('password: "hunter2hunter2"')[0].line, 1);
});

// ---------- 한 줄에 여러 종류 · 20개 제한 ----------

test('한 줄에 서로 다른 비밀 두 개면 둘 다 보고하고, 같은 종류는 한 번만', () => {
  const gh = `ghp_${rnd(36)}`;
  const r = scanSecrets(`a=${gh} b=AKIAABCDEFGHIJKLMNOP c=${gh.replace('ghp', 'gho')}`);
  assert.deepEqual(r.map((f) => f.name).sort(), ['AWS 액세스 키', 'GitHub 토큰'].sort());
  assert.ok(r.every((f) => f.line === 1));
});

test('GitHub 토큰 30개 뒤의 AWS 키도 20개 안에 들어간다', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`token${i}: ghp_${rnd(36)}`);
  lines.push('aws = AKIAABCDEFGHIJKLMNOP');
  const r = scanSecrets(lines.join('\n'));
  assert.equal(r.length, 20);
  assert.ok(r.some((f) => f.name === 'AWS 액세스 키' && f.line === 31));
  // 줄 순서
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].line <= r[i].line);
  assert.match(describeSecrets(r), /외 15개$/);
});

test('비밀이 없는 5MB 글도 1초 안쪽에 검사한다', () => {
  const para = 'The quick brown fox jumps over the lazy dog; const value = compute(a, b) + 42; // 설명 주석\n'
    + 'function handler(req, res) { return res.json({ ok: true, items: list.map((x) => x.id) }); }\n'
    + `${'0123456789abcdef'.repeat(8)}\n`;
  const text = para.repeat(Math.ceil((5 * 1024 * 1024) / para.length));
  const t = Date.now();
  assert.equal(scanSecrets(text).length, 0);
  const ms = Date.now() - t;
  assert.ok(ms < 1500, `${ms}ms`);
});

test('줄바꿈 없는 긴 한 줄(5MB)도 오래 걸리지 않는다', () => {
  const text = 'abc.def-ghi_jkl '.repeat((5 * 1024 * 1024) / 16);
  const t = Date.now();
  scanSecrets(text);
  assert.ok(Date.now() - t < 1500);
});

// ---------- 출력 가리기(maskOutput)와 함께 ----------

test('출력 가리기: 새 규칙은 값만 가리고 키 이름은 남긴다', () => {
  const az = rnd(86, 'ABCDEFabcdef0123456789+/');
  const bearer = rnd(32);
  const npm = `npm_${rnd(36)}`;
  const ant = `sk-ant-api03-${rnd(40)}`;
  const out = maskOutput([
    `+AccountName=a;AccountKey=${az}==`,
    `+Authorization: Bearer ${bearer}`,
    `+GH_TOKEN=Zq8v1Lm3Rt7wQ`,
    `+NPM=${npm}`,
    `+KEY=${ant}`,
  ].join('\n'), PATTERNS);
  for (const s of [az, bearer, 'Zq8v1Lm3Rt7wQ', npm, ant]) assert.ok(!out.includes(s), s);
  assert.ok(out.includes('AccountKey=' + az.slice(0, 4) + '…(가림)'), out);
  assert.ok(out.includes('Authorization: Bearer ' + bearer.slice(0, 4) + '…(가림)'), out);
  assert.ok(out.includes('GH_TOKEN=Zq8v…(가림)'), out);
});

test('PATTERNS의 re에는 g 플래그가 없다 (test()가 상태를 남기지 않게)', () => {
  for (const p of PATTERNS) assert.ok(!p.re.flags.includes('g'), p.name);
});
