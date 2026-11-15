'use strict';
// 기록 저장 구조 (v0.24.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - history-core가 "바뀐 기록 id"와 "목록이 바뀌었는지"를 알려 주는지, 최대 개수를 바꾸면 오래된 것부터 지우는지
//   - Windows 앱: 기록 하나 = 파일 하나, 바뀐 것만 다시 쓰고, 지운 기록은 파일도 지우는지
//   - 예전 history.json을 옮기고 확인한 뒤 지우는지, 깨진 파일 · 이상한 id · 남은 파일을 어떻게 다루는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecureStore } = require('../src/main/secure-store');
const { createHistory, planWrites, normalizeMax, okRecordId } = require('../src/shared/history-core');
const { createRecordStore, loadOrMigrate, cleanLegacy } = require('../src/main/history');

function fakeSafe() {
  const x = (buf) => Buffer.from(buf.map((b) => b ^ 7));
  return { isEncryptionAvailable: () => true, encryptString: (s) => x(Buffer.from(s, 'utf8')), decryptString: (b) => x(b).toString('utf8') };
}
const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-hist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function setup(t) {
  const root = tmpDir(t);
  const sec = createSecureStore({ safeStorage: fakeSafe(), fs });
  const dir = path.join(root, 'history');
  const rs = createRecordStore({ dir: () => dir, sec: () => sec });
  return { root, dir, sec, rs };
}
const rec = (id, q = id) => ({ id, at: 1, question: q, targets: ['a'], files: [], answers: {}, synth: [] });

test('history-core: 답변을 채우면 그 기록만 dirty, 추가 · 지우기는 order', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const h = createHistory((records, info) => calls.push(info));
  const id = h.add({ question: 'q', targets: ['a'] });
  t.mock.timers.tick(600);
  assert.deepEqual(calls.pop(), { dirty: [id], order: true });
  h.setAnswer(id, 'a', { name: 'A', state: 'done', text: 'x' });
  h.setFeedback(id, 'a', 1);
  t.mock.timers.tick(600);
  assert.deepEqual(calls.pop(), { dirty: [id], order: false });
  h.remove(id);
  h.flush();
  assert.deepEqual(calls.pop(), { dirty: [], order: true });
});

test('history-core: 최대 개수 — 고를 수 있는 값만, 줄이면 오래된 것부터 지움', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(normalizeMax(1000), 1000);
  assert.equal(normalizeMax(7), 500);
  assert.equal(normalizeMax('2000'), 2000);
  const h = createHistory(() => {}, { max: 100 });
  for (let i = 0; i < 120; i++) h.add({ question: `q${i}`, targets: [] });
  assert.equal(h.all().length, 100);
  assert.equal(h.all()[0].question, 'q119');
  h.setMax(500);
  assert.equal(h.setMax(100), 0);
  assert.equal(h.max(), 100);
  for (let i = 0; i < 300; i++) h.add({ question: `r${i}`, targets: [] });
  h.setMax(500);
  assert.equal(h.all().length, 100);
});

test('planWrites: 새 기록과 dirty만 쓰고, 목록이 바뀌면 사라진 id를 지우고 색인을 새로', () => {
  const records = [rec('c'), rec('b')];
  assert.deepEqual(planWrites(records, { dirty: ['b'], order: false }, new Set(['a', 'b', 'c'])), {
    write: [records[1]],
    remove: [],
    index: null,
  });
  const p = planWrites(records, { dirty: [], order: true }, new Set(['a', 'b']));
  assert.deepEqual(p.write.map((r) => r.id), ['c']);
  assert.deepEqual(p.remove, ['a']);
  assert.deepEqual(p.index, ['c', 'b']);
});

test('okRecordId: 파일 이름으로 안전한 id만', () => {
  assert.ok(okRecordId('m1abc-x9z1'));
  for (const bad of ['../x', 'a/b', '', 'con.json', 'x'.repeat(41), null, 3]) assert.ok(!okRecordId(bad), String(bad));
});

test('Windows 앱: 기록마다 파일 하나, 바뀐 기록만 다시 쓰고 지우면 파일도 지움', async (t) => {
  const { dir, sec, rs } = setup(t);
  const a = rec('a1');
  const b = rec('b1');
  rs.save([b, a], { dirty: [], order: true });
  await rs.idle();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a1.json', 'b1.json', 'index.json']);
  assert.deepEqual(sec.readJson(path.join(dir, 'index.json')), { v: 2, ids: ['b1', 'a1'] });
  assert.ok(!fs.readFileSync(path.join(dir, 'a1.json')).includes('"a1"')); // 암호화됨

  const before = fs.statSync(path.join(dir, 'a1.json')).mtimeMs;
  b.answers.a = { text: '새 답' };
  await new Promise((r) => setTimeout(r, 20));
  rs.save([b, a], { dirty: ['b1'], order: false });
  await rs.idle();
  assert.equal(fs.statSync(path.join(dir, 'a1.json')).mtimeMs, before); // 안 바뀐 기록은 다시 쓰지 않는다
  assert.equal(sec.readJson(path.join(dir, 'b1.json')).answers.a.text, '새 답');

  rs.save([b], { dirty: [], order: true });
  await rs.idle();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['b1.json', 'index.json']);
  assert.deepEqual(rs.read().map((r) => r.id), ['b1']);
});

test('Windows 앱: flush는 바로(동기로) 쓰고, 다시 읽으면 같은 기록 · 순서', (t) => {
  const { dir, sec, rs } = setup(t);
  rs.save([rec('x2'), rec('x1')], { dirty: [], order: true });
  rs.flush();
  const again = createRecordStore({ dir: () => dir, sec: () => sec });
  assert.deepEqual(again.read().map((r) => r.id), ['x2', 'x1']);
});

test('Windows 앱: 색인에 없는 파일(지우다 꺼짐)은 읽을 때 지우고, 깨진 기록 파일은 건너뜀', (t) => {
  const { dir, sec, rs } = setup(t);
  rs.writeAllSync([rec('k1'), rec('k2')]);
  sec.writeJson(path.join(dir, 'orphan1.json'), rec('orphan1'));
  fs.writeFileSync(path.join(dir, 'k2.json'), 'not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  assert.deepEqual(rs.read().map((r) => r.id), ['k1']);
  assert.ok(!fs.existsSync(path.join(dir, 'orphan1.json')));
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt'))); // 기록 파일 모양이 아닌 것은 건드리지 않는다
});

test('옮기기: 예전 history.json → 기록별 파일, 확인 뒤 예전 파일 지움', (t) => {
  const { root, dir, sec, rs } = setup(t);
  const legacyFile = path.join(root, 'history.json');
  sec.writeJson(legacyFile, [rec('n2', '최근'), rec('n1', '예전')]);
  const records = loadOrMigrate(rs, legacyFile, { sec: () => sec });
  assert.deepEqual(records.map((r) => r.question), ['최근', '예전']);
  assert.ok(!fs.existsSync(legacyFile));
  assert.deepEqual(sec.readJson(path.join(dir, 'index.json')).ids, ['n2', 'n1']);
  // 두 번째로 켤 때는 새 저장소에서 읽는다
  assert.deepEqual(loadOrMigrate(rs, legacyFile, { sec: () => sec }).map((r) => r.id), ['n2', 'n1']);
});

test('옮기기: 예전 기록이 없으면 빈 기록, 이상한 id · 겹치는 id · 객체 아닌 항목은 고침', (t) => {
  const { root, rs, sec } = setup(t);
  assert.deepEqual(loadOrMigrate(rs, path.join(root, 'none.json'), { sec: () => sec }), []);
  const out = cleanLegacy([rec('ok1'), rec('../evil'), rec('ok1'), null, 'x', [1]]);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'ok1');
  assert.ok(out.every((r) => okRecordId(r.id)));
  assert.equal(new Set(out.map((r) => r.id)).size, 3);
  assert.equal(out[1].question, '../evil'); // 내용은 그대로, id만 새로
});

test('확장: 기록을 history:index + history:r:<id>에 나눠 저장하고 예전 history 칸을 옮김', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'host.js'), 'utf8');
  assert.match(src, /const HIST_INDEX = 'history:index'/);
  assert.match(src, /history:r:\$\{id\}/);
  assert.match(src, /chrome\.storage\.local\.remove\('history'\)/);
  assert.match(src, /history\.load\(await loadHistory\(\)\)/);
});
