// 공용 모듈(src/shared) 성능 확인: 큰 글 나누기, 같은 이름 많을 때, 결과가 예전 방식과 같은지
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/shared/project-upload');
const IG = require('../src/shared/project-ignore');

const enc = new TextEncoder();
const utf8 = (s) => enc.encode(s).length;
const brokenPair = (s) => /[\ud800-\udbff]$/.test(s) || /^[\udc00-\udfff]/.test(s);

// 예전 방식 그대로 (글자 하나씩 TextEncoder로 센다) — 비교용
function refSplit(text, limit) {
  const out = [];
  let cur = '';
  let curBytes = 0;
  const push = () => {
    if (cur) out.push(cur);
    cur = '';
    curBytes = 0;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const n = utf8(line);
    if (curBytes + n <= limit) {
      cur += line;
      curBytes += n;
      continue;
    }
    push();
    if (n <= limit) {
      cur = line;
      curBytes = n;
      continue;
    }
    for (const ch of line) {
      const c = utf8(ch);
      if (curBytes + c > limit) push();
      cur += ch;
      curBytes += c;
    }
  }
  push();
  return out.length ? out : [''];
}

function refUnique(names) {
  const used = new Set();
  return names.map((n) => {
    let out = n;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = n.replace(/(\.[^.]*)?$/, (ext) => ` (${i})${ext || ''}`);
    used.add(out.toLowerCase());
    return out;
  });
}

// 시드 고정 난수 (매번 같은 글로 시험)
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

test('3MB 한 줄(한글+이모지) 나누기: 한도 안, 서로게이트 쌍 안 깨짐, 이어 붙이면 원래 글, 1초 안', () => {
  const unit = '한글abc😀'; // 13바이트
  const s = unit.repeat(Math.ceil(3e6 / utf8(unit)));
  const limit = 1000000;
  const t = Date.now();
  const parts = U.splitBytes(s, limit);
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `${ms}ms`);
  assert.ok(parts.length >= 4);
  for (const p of parts) {
    assert.ok(utf8(p) <= limit);
    assert.ok(!brokenPair(p));
  }
  assert.strictEqual(parts.join(''), s);
});

test('bytesOf는 TextEncoder와 같다 (짝 없는 서로게이트 포함)', () => {
  for (const s of ['', 'a', 'é', '한', '😀', '\ud800', '\udc00', 'a\ud800b', '\udc00\ud800', '😀\ud83d', 'x'.repeat(10)]) {
    assert.strictEqual(U.bytesOf(s), utf8(s), JSON.stringify(s));
  }
  assert.strictEqual(U.bytesOf(undefined), 0);
});

test('splitBytes 결과가 예전 방식과 같다 (무작위 글)', () => {
  const r = rng(42);
  const pool = ['a', 'b', ' ', '\n', '\n', 'é', '한', '글', '😀', '👍🏽', '\ud800', '\udc00', '\r\n'];
  for (let k = 0; k < 300; k++) {
    const len = Math.floor(r() * 400);
    let s = '';
    for (let i = 0; i < len; i++) s += pool[Math.floor(r() * pool.length)];
    const limit = 1 + Math.floor(r() * 40);
    assert.deepStrictEqual(U.splitBytes(s, limit), refSplit(s, limit), `seed case ${k}, limit ${limit}`);
  }
});

test('uniqueNames: 같은 이름 2000개도 빠르고 예전과 같은 이름', () => {
  const names = [];
  for (let i = 0; i < 2000; i++) names.push(['src__a.js', 'SRC__A.js', 'Makefile.txt', '.env', 'a.b.c', 'src__a (2).js'][i % 6]);
  const t = Date.now();
  const got = U.uniqueNames(names);
  assert.ok(Date.now() - t < 200, `${Date.now() - t}ms`);
  assert.deepStrictEqual(got, refUnique(names));
  assert.deepStrictEqual(U.uniqueNames(['a.js', 'A.js', 'a.js', '.env', '.env', 'x']), ['a.js', 'A (2).js', 'a (3).js', '.env', ' (2).env', 'x']);
  assert.strictEqual(new Set(got.map((n) => n.toLowerCase())).size, got.length);
});

test('l3Would: 기억한 결과가 규칙 추가·켜고 끄기에 맞게 바뀐다', () => {
  const m = IG.createMatcher();
  const docker = IG.makeSource({ source: '.dockerignore', layer: 'L3', content: 'dist\n', docker: true });
  docker.enabled = false;
  m.add(docker);
  assert.deepStrictEqual(m.l3Would('dist', true), ['.dockerignore']);
  const r = m.l3Would('dist', true);
  r.push('x'); // 돌려받은 배열을 고쳐도
  assert.deepStrictEqual(m.l3Would('dist', true), ['.dockerignore']); // 기억한 값은 그대로
  assert.deepStrictEqual(m.l3Would('src/a.js', false), []);
  const npm = IG.makeSource({ source: '.npmignore', layer: 'L3', content: '*.js\n' });
  npm.enabled = false;
  m.add(npm);
  assert.deepStrictEqual(m.l3Would('src/a.js', false), ['.npmignore']);
  docker.enabled = true;
  assert.deepStrictEqual(m.l3Would('dist', true), []);
  npm.enabled = true;
  assert.deepStrictEqual(m.l3Would('src/a.js', false), []);
});
