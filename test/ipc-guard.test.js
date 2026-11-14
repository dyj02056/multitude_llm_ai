'use strict';
// 앱 쪽(main) 입력 다시 검사 · 한 번에 바꿔 쓰기 테스트:  npm test
// [쉽게 말하면] 화면이 넘긴 첨부 파일 · 읽기 옵션 · 로컬 LLM 주소를 앱 쪽에서 다시 거르는지,
// 프로젝트 파일 쓰기가 임시 파일 → 이름 바꾸기로 이루어져 실패해도 원래 파일이 남는지,
// 테스트 실행 임시 적용의 전체 크기 한도가 지켜지는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const G = require('../src/main/ipc-guard');
const R = require('../src/main/test-rules');

const LIMITS = { maxFiles: 3, maxFileBytes: 10, maxTotalBytes: 15 };

// ---------- 첨부 파일 ----------

test('첨부 파일: 없으면 빈 목록, ArrayBuffer · Uint8Array는 받는다', () => {
  assert.deepEqual(G.checkFiles(undefined, LIMITS), { ok: true, files: [] });
  const r = G.checkFiles([{ name: 'a.txt', type: 'text/plain', data: new ArrayBuffer(4) }, { name: 'b.bin', data: new Uint8Array(3) }], LIMITS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => [f.name, f.size, f.type]), [['a.txt', 4, 'text/plain'], ['b.bin', 3, '']]);
});

test('첨부 파일: 모양이 틀리면 한국어 이유와 함께 거절한다', () => {
  const bad = [
    'a.txt',
    [null],
    [[1, 2]],
    [{ name: 5, data: new ArrayBuffer(1) }],
    [{ name: '', data: new ArrayBuffer(1) }],
    [{ name: 'a', data: 'abc' }],
    [{ name: 'a', data: { byteLength: 1 } }], // byteLength만 흉내 낸 객체
    [{ name: 'a', data: [1, 2, 3] }],
    [{ name: 'a', data: new DataView(new ArrayBuffer(1)) }],
    [{ name: 'a' }],
  ];
  for (const files of bad) {
    const r = G.checkFiles(files, LIMITS);
    assert.equal(r.ok, false, JSON.stringify(files));
    assert.match(r.error, /첨부 파일/);
  }
});

test('첨부 파일: 개수 · 하나 · 전체 크기 한도', () => {
  const f = (n) => ({ name: 'x', data: new ArrayBuffer(n) });
  assert.match(G.checkFiles([f(1), f(1), f(1), f(1)], LIMITS).error, /3개까지/);
  assert.match(G.checkFiles([f(11)], LIMITS).error, /한도/);
  assert.match(G.checkFiles([f(10), f(6)], LIMITS).error, /전체 크기/);
  assert.equal(G.checkFiles([f(10), f(5)], LIMITS).ok, true);
});

// ---------- 읽기 옵션 ----------

test('readFile 옵션: maxBytes는 양의 유한수만, 앱 쪽 최대값까지 자르고 다른 옵션은 버린다', () => {
  const cap = 5 * 1024 * 1024;
  assert.deepEqual(G.readFileOpts(undefined, cap), {});
  assert.deepEqual(G.readFileOpts(null, cap), {});
  assert.deepEqual(G.readFileOpts({ maxBytes: 1000 }, cap), { maxBytes: 1000 });
  assert.deepEqual(G.readFileOpts({ maxBytes: 1e12 }, cap), { maxBytes: cap });
  assert.deepEqual(G.readFileOpts({ maxBytes: Infinity }, cap), {});
  assert.deepEqual(G.readFileOpts({ maxBytes: NaN }, cap), {});
  assert.deepEqual(G.readFileOpts({ maxBytes: -1 }, cap), {});
  assert.deepEqual(G.readFileOpts({ maxBytes: 0 }, cap), {});
  assert.deepEqual(G.readFileOpts({ maxBytes: '999999999' }, cap), {});
  assert.deepEqual(G.readFileOpts({ maxBytes: 0.5 }, cap), { maxBytes: 1 });
  assert.deepEqual(G.readFileOpts({ maxBytes: 10, encoding: 'latin1', flag: 'w' }, cap), { maxBytes: 10 });
});

// ---------- 로컬 LLM 주소 ----------

test('로컬 LLM 주소: 이 PC의 http(s)만 받는다', () => {
  assert.equal(G.localBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(G.localBaseUrl('https://127.0.0.1:8080'), 'https://127.0.0.1:8080');
  assert.equal(G.localBaseUrl('http://[::1]:1234'), 'http://[::1]:1234');
  for (const bad of ['http://example.com', 'http://192.168.0.2:11434', 'file:///etc/passwd', 'ftp://localhost', 'http://user:pw@localhost', 'http://localhost.evil.com', '', null, 5, {}]) {
    assert.equal(G.localBaseUrl(bad), null, String(bad));
  }
});

// ---------- 한 번에 바꿔 쓰기 ----------

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

async function openTmpProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-atomic-'));
  const project = requireProject();
  await project.open(dir);
  t.after(() => {
    project.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, project };
}

const tmpLeft = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.mla-tmp-'));

test('파일 쓰기: 새 파일 · 덮어쓰기 모두 내용이 맞고 임시 파일이 남지 않는다', async (t) => {
  const { dir, project } = await openTmpProject(t);
  await project.writeFile('src/a.js', '첫 줄\r\nsecond\n');
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), '첫 줄\r\nsecond\n'); // 줄바꿈은 받은 그대로
  await project.writeFile('src/a.js', 'v2');
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), 'v2');
  assert.deepEqual(tmpLeft(path.join(dir, 'src')), []);
  assert.deepEqual(tmpLeft(dir), []);
});

test('파일 쓰기: 이름 바꾸기가 실패하면 원래 파일은 그대로, 임시 파일은 지운다', async (t) => {
  const { dir, project } = await openTmpProject(t);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'original');
  const fsp = fs.promises;
  const origRename = fsp.rename;
  fsp.rename = async () => {
    const err = new Error('디스크 오류 흉내');
    err.code = 'EIO';
    throw err;
  };
  t.after(() => {
    fsp.rename = origRename;
  });
  await assert.rejects(project.writeFile('keep.txt', 'broken'), /디스크 오류 흉내/);
  fsp.rename = origRename;
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'original');
  assert.deepEqual(tmpLeft(dir), []);
});

test('파일 쓰기: 기존 안전장치(.git · 밖으로 나가는 경로 · 내용 없음)는 그대로', async (t) => {
  const { dir, project } = await openTmpProject(t);
  await assert.rejects(project.writeFile('.git/config', 'x'), /git 내부/);
  await assert.rejects(project.writeFile('../out.txt', 'x'), /허용되지 않는 경로/);
  await assert.rejects(project.writeFile('a.txt', 5), /쓸 내용이 없습니다/);
  assert.deepEqual(tmpLeft(dir), []);
});

test('readFile: 앱 쪽 최대값은 5MB', () => {
  assert.equal(requireProject().READ_MAX_BYTES, 5 * 1024 * 1024);
});

// ---------- 테스트 실행 임시 적용 전체 크기 ----------

test('임시 적용: 파일 하나는 한도 안이어도 합쳐서 50MB를 넘으면 거절한다', () => {
  assert.equal(R.TRIAL_MAX_TOTAL_BYTES, 50 * 1024 * 1024);
  const big = 'x'.repeat(R.TRIAL_MAX_FILE_BYTES); // 5MB
  const ten = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.js`, after: big }));
  assert.equal(R.checkTrialChanges(ten).length, 10); // 딱 50MB는 통과
  assert.equal(R.checkTrialChanges([...ten, { path: 'g.js', after: 'y' }]), null);
  assert.equal(R.checkTrialChanges([...ten, { path: 'gone.js', after: null }]).length, 11); // 지우기는 크기에 넣지 않는다
});
