'use strict';
// 메인 프로세스 고친 점 (v0.23) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 기록 저장 미루기: flush()가 미뤄 둔 저장을 바로 하고, 미룬 것이 없으면 아무것도 안 하는지
//   - 출력 가리기: 조각 경계에 걸린 토큰도 가려지고, 조각 경계에 걸린 한글도 깨지지 않는지
//   - 한 번에 하나만: 확인 창을 기다리는 동안 두 번째 git 명령 · 테스트 실행을 받지 않는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createHistory } = require('../src/shared/history-core');
const { createLineMasker } = require('../src/main/git-rules');
const { PATTERNS } = require('../src/shared/secret-scan');
const R = require('../src/main/test-rules');

// ---------- 기록 flush ----------

test('기록: flush는 미뤄 둔 저장을 바로 하고, 미룬 것이 없으면 아무것도 안 한다', () => {
  const saved = [];
  const h = createHistory((records) => saved.push(records.map((r) => r.question)));
  h.flush();
  assert.equal(saved.length, 0); // 미룬 저장 없음
  h.add({ question: '첫 질문', targets: ['a'] });
  h.add({ question: '둘째 질문', targets: ['a'] });
  assert.equal(saved.length, 0); // 아직 0.5초 기다리는 중
  h.flush();
  assert.deepEqual(saved, [['둘째 질문', '첫 질문']]);
  h.flush();
  assert.equal(saved.length, 1); // 두 번 저장하지 않는다
});

test('기록: flush한 뒤에는 미뤄 둔 타이머가 다시 저장하지 않는다', async () => {
  let n = 0;
  const h = createHistory(() => n++);
  h.add({ question: 'q', targets: [] });
  h.flush();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(n, 1);
});

// ---------- 줄 단위 가리기 ----------

test('출력 가리기: 두 조각에 걸친 토큰도 가린다', () => {
  const m = createLineMasker(PATTERNS);
  const token = 'ghp_' + 'a'.repeat(36);
  const line = `remote: token ${token} 끝\n`;
  const buf = Buffer.from(line, 'utf8');
  const at = buf.indexOf('aaaa'); // 토큰 한가운데에서 자른다
  const out = m.push(buf.subarray(0, at)) + m.push(buf.subarray(at)) + m.end();
  assert.ok(!out.includes(token), out);
  assert.ok(out.includes('ghp_…(가림)'), out);
  assert.ok(out.endsWith('끝\n'));
});

test('출력 가리기: 조각 경계에 걸린 한글이 깨지지 않고, 줄바꿈 없는 끝 줄은 end()에서 나온다', () => {
  const m = createLineMasker(PATTERNS);
  const buf = Buffer.from('한글 출력\n마지막', 'utf8');
  let out = '';
  for (let i = 0; i < buf.length; i++) out += m.push(buf.subarray(i, i + 1)); // 1바이트씩
  assert.equal(out, '한글 출력\n');
  assert.equal(m.end(), '마지막');
  assert.ok(!out.includes('�'));
});

test('출력 가리기: 주소의 아이디·토큰도 조각을 넘어 가린다', () => {
  const m = createLineMasker([]);
  const out = m.push(Buffer.from('From https://user:sec')) + m.push(Buffer.from('ret@github.com/x\n')) + m.end();
  assert.equal(out, 'From https://***@github.com/x\n');
});

// ---------- 한 번에 하나만 ----------

function requireWithFakeElectron(rel, electron) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    return orig.call(this, req, ...rest);
  };
  try {
    for (const k of Object.keys(require.cache)) if (/src[\\/]main[\\/]/.test(k)) delete require.cache[k];
    return require(require.resolve(rel));
  } finally {
    Module._load = orig;
  }
}

/** 확인 창을 사용자가 누를 때까지 붙잡아 두는 가짜 dialog */
function heldDialog() {
  const waiting = [];
  return {
    waiting,
    dialog: { showMessageBox: () => new Promise((resolve) => waiting.push(resolve)) },
  };
}

test('git 콘솔: 확인 창을 기다리는 동안 두 번째 명령은 받지 않고, 취소하면 다시 받는다', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-gitrace-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const held = heldDialog();
  const { setupGitConsole, resolveExe } = requireWithFakeElectron('../src/main/gitconsole', { dialog: held.dialog });
  if (!resolveExe(process.platform === 'win32' ? 'git.exe' : 'git')) return t.skip('git을 찾지 못함');
  const handlers = {};
  const gc = setupGitConsole({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getWin: () => null, getRoot: () => tmp });
  const run = (line) => handlers['git:run']({}, line);

  const first = run('git reset --hard'); // 위험 명령 → 확인 창
  await new Promise((r) => setImmediate(r));
  assert.equal(held.waiting.length, 1);
  const second = await run('git status');
  assert.equal(second.ok, false);
  assert.match(second.error, /이미 실행 중/);
  assert.equal(await handlers['git:stop'](), false); // 아직 실행 전이라 멈출 것이 없다
  gc.stop(); // 앱 종료 쪽 stop도 실행 전 상태를 견딘다

  held.waiting[0]({ response: 1 }); // 취소
  const r1 = await first;
  assert.equal(r1.cancelled, true);

  // 자리가 풀렸는지: 다시 위험 명령을 보내면 확인 창이 또 뜬다
  const third = run('git reset --hard');
  await new Promise((r) => setImmediate(r));
  assert.equal(held.waiting.length, 2);
  held.waiting[1]({ response: 1 });
  assert.equal((await third).cancelled, true);

  // 검사에서 막힌 명령도 자리를 남기지 않는다
  assert.equal((await run('calc.exe')).ok, false);
  const fourth = run('git reset --hard');
  await new Promise((r) => setImmediate(r));
  assert.equal(held.waiting.length, 3);
  held.waiting[2]({ response: 1 });
  await fourth;
});

test('테스트 실행: 확인 창을 기다리는 동안 두 번째 실행은 받지 않고, 취소하면 풀린다', async (t) => {
  if (!R.findNpmCli({ exists: (p) => fs.existsSync(p) })) return t.skip('npm을 찾지 못함');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-devrace-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }));
  const held = heldDialog();
  const electron = { dialog: held.dialog, app: { getPath: () => tmp } };
  const project = requireWithFakeElectron('../src/main/project', electron);
  const { setupDevTest } = requireWithFakeElectron('../src/main/devtest', electron);
  const handlers = {};
  const dt = setupDevTest({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, getWin: () => null, project, userDataDir: tmp });
  await project.open(root);
  const changes = [{ path: 'a.js', after: 'x\n' }];

  const first = handlers['devtest:trial']({}, changes);
  for (let i = 0; i < 50 && !held.waiting.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(held.waiting.length, 1);
  assert.equal(dt.isBusy(), true);
  const second = await handlers['devtest:trial']({}, changes);
  assert.equal(second.ok, false);
  assert.match(second.error, /이미 테스트를 실행/);

  held.waiting[0]({ response: 1 }); // 취소
  assert.equal((await first).cancelled, true);
  assert.equal(dt.isBusy(), false);

  // 잘못된 수정안처럼 일찍 끝나는 경우에도 풀린다
  assert.equal((await handlers['devtest:trial']({}, 'bad')).ok, false);
  assert.equal(dt.isBusy(), false);
  project.close();
});
